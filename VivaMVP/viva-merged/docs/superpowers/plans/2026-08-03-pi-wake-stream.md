# Pi Wake Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** INMP441의 `비바야` 호출어가 iPhone의 기존 ONNX 엔진에서 감지되면 Pi 사진 촬영과 튜터링 세션을 시작한다.

**Architecture:** `viva-wake.service`가 Pi 마이크를 유휴 시점에 단독 소유하고 16kHz PCM을 port 8788 WebSocket으로 보낸다. iPhone은 기존 `OpenWakeWordEngine`에 그 PCM을 넣고, 감지 시 stream을 `pause`해 마이크를 놓은 뒤 기존 `beginCapture`를 호출한다. 대화 종료 시 stream을 다시 `resume`한다.

**Tech Stack:** Python 3.13 stdlib `asyncio`/`subprocess`, 설치된 `websockets`, React Native WebSocket, TypeScript, Jest.

## Global Constraints

- iPhone 앱은 전면 실행·화면 켜짐, Pi와 같은 Wi-Fi에 연결돼 있다.
- 새 npm/Python 패키지와 Pi ONNX 런타임을 추가하지 않는다.
- PCM은 16kHz, mono, S16_LE, 100ms(3200-byte) 단위다.
- wake 스트림과 `/record/start`는 동시에 `micboost`를 열지 않는다.
- Pi 연결/stream 실패 시 기존 폰 호출어와 홈 촬영 버튼은 계속 동작한다.

---

### Task 1: Pi wake relay와 서비스

**Files:**
- Create: `pi-server/wake.py`
- Create: `pi-server/viva-wake.service`
- Create: `pi-server/test_wake.py`

**Interfaces:**
- Consumes: ALSA `micboost`, `arecord`, WebSocket text commands `{ "type": "subscribe" | "pause" | "resume" }`.
- Produces: port `8788`; `{ "type": "pcm", "data": "<base64 PCM>" }`, `{ "type": "paused" }`, `{ "type": "resumed" }`.

- [x] **Step 1: Write failing ownership test**

```python
# pi-server/test_wake.py
import unittest
from unittest.mock import AsyncMock, Mock
from wake import WakeRelay

class WakeRelayTest(unittest.IsolatedAsyncioTestCase):
    async def test_pause_stops_arecord_before_ack(self):
        relay = WakeRelay()
        relay.process = Mock()
        relay.process.poll.return_value = None
        relay.process.wait = Mock()
        ws = AsyncMock()

        await relay.pause(ws)

        relay.process.terminate.assert_called_once()
        relay.process.wait.assert_called_once()
        ws.send.assert_awaited_once_with('{"type":"paused"}')

if __name__ == '__main__':
    unittest.main()
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd pi-server && python3 -m unittest test_wake.py -v`

Expected: FAIL with `ModuleNotFoundError: No module named 'wake'`.

- [x] **Step 3: Implement minimal relay**

```python
# wake.py: protocol constants and ownership transition
CHUNK_BYTES = 3200
ARECORD = ['arecord', '-D', 'micboost', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw', '-q', '-']

class WakeRelay:
    async def pause(self, ws):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            self.process.wait()
        self.process = None
        await ws.send('{"type":"paused"}')
```

Extend `WakeRelay` so `subscribe` starts one `arecord` process, reads exactly `CHUNK_BYTES`, base64-encodes each chunk, and sends `{"type":"pcm","data":...}` only to subscribed clients. `resume` starts capture only after all old capture tasks finish. Disconnecting last client pauses capture. Unknown JSON and binary inbound frames are ignored.

```ini
# viva-wake.service
[Unit]
Description=Viva wake PCM relay (WS :8788)
After=network.target

[Service]
ExecStart=/usr/bin/python3 /home/viva/pi-server/wake.py
Restart=always
User=viva

[Install]
WantedBy=multi-user.target
```

- [x] **Step 4: Run test to verify it passes**

Run: `cd pi-server && python3 -m unittest test_wake.py -v`

Expected: PASS.

- [x] **Step 5: Deploy and protocol smoke test**

Run:

```bash
scp pi-server/wake.py pi-server/viva-wake.service viva@172.20.5.37:~/pi-server/
ssh viva@172.20.5.37 'sudo cp ~/pi-server/viva-wake.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now viva-wake'
node -e 'const WebSocket=require("ws"); const w=new WebSocket("ws://172.20.5.37:8788"); w.on("open",()=>w.send(JSON.stringify({type:"subscribe"}))); w.on("message",m=>{console.log(String(m).slice(0,24)); w.send(JSON.stringify({type:"pause"}));});'
```

Expected: at least one `pcm` message, then exactly one `paused` reply; `systemctl is-active viva-wake` prints `active`.

- [x] **Step 6: Commit**

```bash
git add pi-server/wake.py pi-server/viva-wake.service pi-server/test_wake.py
git commit -m "feat: stream Pi microphone for wake word detection"
```

### Task 2: iPhone Pi PCM source

**Files:**
- Create: `src/services/piWakeStream.service.ts`
- Create: `src/services/__tests__/piWakeStream.service.test.ts`
- Modify: `src/services/piBridge.service.ts:11-17`

**Interfaces:**
- Consumes: `ws://<PI_HOST>:8788` and wake protocol from Task 1.
- Produces: `createPiWakeStream(): PiWakeStream`, whose `start(onPcm)`, `pause()`, `resume()`, and `stop()` return `Promise<void>`.

- [x] **Step 1: Write failing WebSocket lifecycle test**

```ts
it('forwards pcm and resolves pause only after paused acknowledgement', async () => {
  const stream = createPiWakeStream();
  const onPcm = jest.fn();
  const started = stream.start(onPcm);
  socket.open();
  socket.message(JSON.stringify({ type: 'pcm', data: 'pcm-base64' }));
  await started;
  expect(onPcm).toHaveBeenCalledWith('pcm-base64');

  const paused = stream.pause();
  expect(socket.sent).toContain(JSON.stringify({ type: 'pause' }));
  socket.message(JSON.stringify({ type: 'paused' }));
  await expect(paused).resolves.toBeUndefined();
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand src/services/__tests__/piWakeStream.service.test.ts`

Expected: FAIL with module/function missing.

- [x] **Step 3: Implement minimal source**

```ts
export interface PiWakeStream {
  start(onPcm: (base64: string) => void): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

export function createPiWakeStream(): PiWakeStream {
  // one WebSocket; resolve pause/resume only from matching Pi acknowledgement
}
```

Build URL from exported `getPiBaseUrl()` host, changing port `5000` to `8788`. `start` sends `subscribe` after socket open. `stop` closes socket and rejects any unsettled acknowledgement promise. Only JSON `pcm` messages call `onPcm`; malformed messages are ignored. Connection failure rejects `start` within 5 seconds.

- [x] **Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand src/services/__tests__/piWakeStream.service.test.ts`

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/services/piWakeStream.service.ts src/services/__tests__/piWakeStream.service.test.ts src/services/piBridge.service.ts
git commit -m "feat: receive Pi PCM wake stream in app"
```

### Task 3: Wake engine source selection and capture transition

**Files:**
- Modify: `src/hooks/useWakeWord.ts:34-166`
- Modify: `src/hooks/__tests__/useWakeWord.test.ts`
- Modify: `App.tsx:122-273`
- Test: `src/hooks/__tests__/useWakeWord.test.ts`

**Interfaces:**
- Consumes: `PiWakeStream` from Task 2 and existing `OpenWakeWordEngine.feedBase64(base64)`.
- Produces: `useWakeWord(onDetected, { piStream })`; on Pi stream success it never starts `LiveAudioStream`; on failure it keeps existing phone-mic listener behavior.

- [x] **Step 1: Write failing Pi-source hook test**

```ts
it('feeds Pi PCM without starting the phone microphone', async () => {
  const piStream = { start: jest.fn(async (cb) => cb('pi-pcm')), stop: jest.fn() };
  const ref = renderWakeWord(jest.fn(), { piStream });
  await act(async () => { await ref.current.startListening(); });
  expect(latestEngine().feedBase64).toHaveBeenCalledWith('pi-pcm');
  expect(mockStream.start).not.toHaveBeenCalled();
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand src/hooks/__tests__/useWakeWord.test.ts`

Expected: FAIL because `useWakeWord` accepts one argument and does not use `piStream`.

- [x] **Step 3: Implement one optional source path**

```ts
export interface WakeWordOptions { piStream?: PiWakeStream }
export function useWakeWord(onDetected: () => void, options: WakeWordOptions = {}) {
  // engine.load/start remains shared; options.piStream.start(engine.feedBase64) wins.
  // if it rejects, start existing LiveAudioStream path.
}
```

In `App.tsx`, construct one `PiWakeStream` and pass it to `useWakeWord`. Change `beginCapture` to await `piStream.pause()` before Pi `capturePhotoNow()`, then call the existing `stopListening`; this is the ownership hand-off. If pause fails, set `piReadyRef.current = false` and use the existing `openPhoneCamera()` fallback. When `appState.status === 'idle'`, resume the Pi stream before starting detection; non-idle state stops it.

- [x] **Step 4: Run focused tests**

Run:

```bash
npm test -- --runInBand src/hooks/__tests__/useWakeWord.test.ts src/screens/__tests__/HomeScreen.test.tsx
npm run lint
```

Expected: PASS; no TypeScript or ESLint errors.

- [x] **Step 5: Commit**

```bash
git add App.tsx src/hooks/useWakeWord.ts src/hooks/__tests__/useWakeWord.test.ts
git commit -m "feat: trigger Pi capture from device microphone wake word"
```

### Task 4: Hardware end-to-end verification

**Files:**
- Modify: `docs/process.md` (append only; next decision/verification entry)
- Modify: `docs/SESSION_HANDOFF.md` (overwrite current hardware status)

**Interfaces:**
- Consumes: Tasks 1-3 deployed to Pi and latest iPhone development build.
- Produces: measured acceptance result and threshold notes.

- [ ] **Step 1: Verify no false trigger baseline**

Run: leave app idle with wake stream connected; speak ten non-`비바야` utterances.

Expected: zero Pi captures and `viva-wake` remains active.

- [ ] **Step 2: Verify wake capture loop**

Run: say `비바야` ten times from normal study distance, waiting for home idle each time.

Expected: each accepted detection pauses wake stream, takes Pi photo, reaches conversation, and restarts wake listening after exit.

- [ ] **Step 3: Verify first tutoring response audio**

Run: after each accepted wake capture, say `안녕하세요`, wait 3 seconds, then listen for VIVA response.

Expected: INMP441 recording reaches Gemini STT and TTS plays only through MAX98357; iPhone speaker stays silent.

- [ ] **Step 4: Record result and commit**

```bash
git add docs/process.md docs/SESSION_HANDOFF.md
git commit -m "docs: record Pi wake stream device verification"
```

## Self-review

- Spec coverage: Tasks 1-3 implement foreground Wi-Fi wake detection, mic ownership hand-off, existing Pi capture, existing Gemini path, and Pi speaker routing. Task 4 covers all four acceptance checks.
- Dependency limit: only installed Python `websockets` and standard library; no package addition.
- Failure paths: stream failure uses existing phone camera/button; capture never starts until `paused` acknowledgement; disconnect releases Pi capture.
- Naming consistency: port `8788`, `PiWakeStream`, and `pause`/`resume` protocol are used consistently.

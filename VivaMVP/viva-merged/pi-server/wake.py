#!/usr/bin/env python3
"""VIVA wake PCM 릴레이 - Pi 마이크(INMP441)를 유휴 시점에 단독 소유하고
16kHz mono PCM 을 WS(:8788)로 폰에 흘려보낸다.

호출어(`비바야`) 판정은 폰의 기존 ONNX 엔진이 한다 - Pi Zero 에 ONNX 런타임을
올리지 않는다(설계 2026-08-03). 이 프로세스는 arecord 를 읽어 100ms(3200B)
단위로 중계할 뿐이다.

프로토콜:
- 수신(텍스트 JSON): {"type": "subscribe" | "pause" | "resume"}. 비JSON/바이너리/미지 타입은 무시.
- 송신: PCM 은 3200B raw 바이너리 프레임 그대로 (base64/JSON 래핑 없음 - Pi Zero
  단일 코어에서 인코딩 CPU 와 +33% 페이로드를 아낀다).
  제어 ack 은 텍스트 JSON: {"type": "paused"}, {"type": "resumed"}

핵심 계약: pause 는 arecord 를 terminate+wait 로 **완전히 죽인 뒤에야**
paused 를 응답한다 - 폰은 paused 를 받은 뒤 viva-server /record/start 를
호출하므로, 이 순서가 두 arecord 의 micboost 경쟁을 막는다. 마지막 클라이언트
연결이 끊겨도 캡처를 멈춰 마이크를 놓는다.

실행: systemd viva-wake.service. websockets 는 eyes.py 처럼 serve 안에서
지연 임포트한다 - 개발 Mac 에는 websockets 가 없어 test_wake.py 가 임포트만으로
깨지지 않게.
"""
import asyncio
import json
import subprocess

PORT = 8788
CHUNK_BYTES = 3200  # 100ms @ 16kHz mono S16_LE - app.py RECORD_CHUNK_BYTES 와 동일
ARECORD = ['arecord', '-D', 'micboost', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw', '-q', '-']
# 폰이 close frame 없이 사라지면(JS 리로드/Wi-Fi 드롭) ws.send 가 TCP 버퍼가
# 찰 때까지 무한 대기해 펌프가 멎는다(2026-08-06 arecord 11초 overrun 사고).
# 상한을 걸고 그 클라이언트를 버린다.
SEND_TIMEOUT_S = 1.0
WAIT_TIMEOUT_S = 3.0  # arecord 가 SIGTERM 을 무시할 때 kill 로 넘어가는 상한
# arecord 가 도중에 죽으면(EOF, 2026-08-06 overrun 사고 같은 것) 구독자가
# 남아있는 한 다시 잡는다 - 안 그러면 mic_ok 가 sticky 만료 후 계속 false 로
# 뜨고, 새 subscribe(앱 재연결) 전엔 자연 복구가 안 된다.
RESPAWN_BACKOFF_S = 1.0
RESPAWN_MAX_BACKOFF_S = 5.0  # 지수 백오프 상한 - /record/stop join(최대 5초)과 맞춘다
# ponytail: 연속 급사 8회(백오프 합 ~32초)면 하드웨어가 진짜 죽은 것으로 보고
# 포기한다 - 세션 종료 직후 viva-server 와의 마이크 경합(최대 ~5초)은 이 안에서
# 자연 흡수된다. 업그레이드 경로: 포기를 /health 에 노출해 "재시작 필요" 표시.
MAX_QUICK_DEATHS = 8


class WakeRelay:
    def __init__(self):
        self.process = None   # arecord subprocess (마이크 소유의 증거)
        self.task = None      # PCM 중계 태스크
        self.clients = set()  # subscribe 한 WS 들

    async def _stop_capture(self):
        """중계 태스크를 먼저 끝내고 arecord 를 terminate+wait 로 죽인다.
        이 함수가 리턴하면 마이크는 확실히 놓인 상태다.
        순서 중요(2026-08-13): arecord 를 먼저 죽이면 terminate 와 task.cancel
        사이 await 틈에 펌프가 EOF 재기동으로 새 arecord 를 스폰해 유출된다 -
        스포너(펌프)부터 죽여야 그 창이 없다.
        wait 는 executor 로 - 동기 wait() 가 이벤트 루프를 통째로 세우면
        새 WS 핸드셰이크가 전부 timeout 된다(2026-08-06 사고)."""
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
            self.task = None
        if self.process and self.process.poll() is None:
            loop = asyncio.get_running_loop()
            self.process.terminate()
            try:
                await asyncio.wait_for(
                    loop.run_in_executor(None, self.process.wait), WAIT_TIMEOUT_S)
            except asyncio.TimeoutError:
                self.process.kill()
                try:
                    await asyncio.wait_for(
                        loop.run_in_executor(None, self.process.wait), WAIT_TIMEOUT_S)
                except asyncio.TimeoutError:
                    pass  # ponytail: D-state 프로세스는 못 죽인다 - 루프 생존이 우선

    def _start_capture(self):
        # 살아있음 판정은 poll() 로 한다 - 죽은 process 핸들은 남겨둔다
        # (test_wake 가 pause 뒤 terminate/wait 호출을 검증할 수 있게).
        if self.process is not None and self.process.poll() is None:
            return  # arecord 살아있음
        if self.task and not self.task.done():
            # arecord 는 죽었지만 펌프가 백오프 중 - 재기동은 그 펌프 몫이다.
            # 여기서 또 만들면 펌프+arecord 가 복제돼 micboost(배타) 쟁탈로
            # "Device or resource busy" 폭풍 후 포기, 마이크 무음(실기기 2026-08-13).
            return
        self.process = subprocess.Popen(ARECORD, stdout=subprocess.PIPE)
        self.task = asyncio.get_running_loop().create_task(self._pump())
        print("[viva-wake] capture started")

    async def _pump(self):
        """arecord stdout 을 100ms 단위로 읽어 구독자 전원에게 중계한다.
        블로킹 read 는 executor 스레드로 - 이벤트 루프를 막지 않는다.

        arecord 가 죽어도(EOF) 구독자가 남아있으면 다시 잡는다(RESPAWN_BACKOFF_S
        대기 후) - pause/disconnect 로 인한 정상 종료는 _stop_capture 가 이
        태스크를 cancel 해서 먼저 끝내므로 여기 도달하지 않는다."""
        loop = asyncio.get_running_loop()
        deaths = 0
        while self.clients:
            stdout = self.process.stdout
            while True:
                chunk = await loop.run_in_executor(None, stdout.read, CHUNK_BYTES)
                if not chunk:  # arecord 종료(EOF)
                    break
                deaths = 0
                for ws in list(self.clients):
                    try:
                        # bytes payload = 바이너리 WS 프레임. 타임아웃 = 죽은 클라이언트
                        await asyncio.wait_for(ws.send(chunk), SEND_TIMEOUT_S)
                    except Exception:
                        self.clients.discard(ws)  # 끊긴 소켓 정리는 keepalive ping 몫
            if not self.clients:
                break
            deaths += 1
            if deaths > MAX_QUICK_DEATHS:
                print("[viva-wake] capture keeps dying - giving up")
                break
            backoff = min(RESPAWN_BACKOFF_S * (2 ** (deaths - 1)), RESPAWN_MAX_BACKOFF_S)
            print(f"[viva-wake] capture died (EOF) - respawning ({deaths}, backoff {backoff}s)")
            await asyncio.sleep(backoff)
            self.process = subprocess.Popen(ARECORD, stdout=subprocess.PIPE)
        self.task = None

    async def subscribe(self, ws):
        self.clients.add(ws)
        self._start_capture()

    async def pause(self, ws):
        await self._stop_capture()  # 완전 종료가 먼저, 응답은 그 다음 (계약)
        await ws.send('{"type":"paused"}')

    async def resume(self, ws):
        await self._stop_capture()  # 남은 캡처가 있으면 정리한 뒤 새로 시작
        self._start_capture()
        await ws.send('{"type":"resumed"}')

    async def disconnect(self, ws):
        self.clients.discard(ws)
        if not self.clients:  # 마지막 클라이언트가 나가면 마이크를 놓는다
            await self._stop_capture()


async def _handler(relay, ws):
    try:
        await _relay_loop(relay, ws)
    except Exception as e:
        # 폰이 Wi-Fi 끊김 등으로 close frame 없이 사라지는 건 정상 경로다 -
        # 연결마다 traceback 을 journal 에 쌓지 않는다.
        print(f"[viva-wake] client dropped: {type(e).__name__}")
    finally:
        await relay.disconnect(ws)


async def _relay_loop(relay, ws):
    async for msg in ws:
        try:
            data = json.loads(msg)
        except (ValueError, TypeError):
            continue  # 비JSON/바이너리 프레임 무시
        kind = data.get("type") if isinstance(data, dict) else None
        if kind == "subscribe":
            await relay.subscribe(ws)
        elif kind == "pause":
            await relay.pause(ws)
        elif kind == "resume":
            await relay.resume(ws)
        # 미지 타입 무시


async def _serve():
    import websockets
    relay = WakeRelay()
    async with websockets.serve(lambda ws: _handler(relay, ws), "0.0.0.0", PORT):
        print(f"[viva-wake] ws listening on :{PORT}")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(_serve())

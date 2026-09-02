# pi-server/test_wake.py
import asyncio
import subprocess
import unittest
from unittest.mock import AsyncMock, Mock, patch
from wake import ARECORD, WakeRelay

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

    async def test_pump_relays_raw_binary_chunk(self):
        relay = WakeRelay()
        chunk = b'\x01\x02' * 1600  # 3200B
        relay.process = Mock()
        relay.process.stdout.read = Mock(side_effect=[chunk, b''])
        ws = AsyncMock()
        relay.clients.add(ws)

        with patch('wake.MAX_QUICK_DEATHS', 0):
            await relay._pump()

        ws.send.assert_awaited_once_with(chunk)  # bytes 그대로 = 바이너리 프레임

    async def test_pump_discards_stuck_client(self):
        # 폰이 close frame 없이 사라지면 ws.send 가 무한 대기한다 -
        # SEND_TIMEOUT_S 안에 못 보내면 그 클라이언트를 버리고 펌프는 계속 돈다.
        relay = WakeRelay()
        chunk = b'\x00' * 3200
        relay.process = Mock()
        relay.process.stdout.read = Mock(side_effect=[chunk, b''])
        stuck = AsyncMock()
        stuck.send = Mock(return_value=asyncio.sleep(10))
        relay.clients.add(stuck)

        with patch('wake.SEND_TIMEOUT_S', 0.05):
            await asyncio.wait_for(relay._pump(), 2)  # 펌프 자체가 안 멎는 게 핵심

        self.assertNotIn(stuck, relay.clients)

    async def test_pump_respawns_arecord_when_clients_still_subscribed(self):
        # 실기기 버그: arecord 가 도중에 죽어도(EOF) 구독자가 남아있으면
        # 다시 잡아야 한다 - 안 그러면 mic_ok 가 sticky 만료 후 계속 false 로
        # 뜨고, 새 subscribe(앱 재연결/새로고침) 전엔 자연 복구가 안 된다.
        relay = WakeRelay()
        chunk = b'\x00' * 3200
        dead_process = Mock()
        dead_process.stdout.read = Mock(side_effect=[chunk, b''])
        respawned_process = Mock()
        respawned_process.stdout.read = Mock(side_effect=[b''])  # 재기동도 바로 죽음 -> 포기
        relay.process = dead_process
        ws = AsyncMock()
        relay.clients.add(ws)

        with patch('wake.subprocess.Popen', side_effect=[respawned_process]) as mock_popen, \
                patch('wake.RESPAWN_BACKOFF_S', 0), \
                patch('wake.MAX_QUICK_DEATHS', 1):
            await asyncio.wait_for(relay._pump(), 2)

        mock_popen.assert_called_once_with(ARECORD, stdout=subprocess.PIPE)
        ws.send.assert_awaited_once_with(chunk)

    async def test_subscribe_during_backoff_does_not_spawn_second_pump(self):
        # 실기기 2026-08-13: arecord 급사 백오프 중 폰이 재구독하면
        # _start_capture 가 poll()만 보고 새 펌프+arecord 를 하나 더 만들었다.
        # 구 펌프도 깨어나 arecord 를 또 스폰 - micboost(배타) 쟁탈로
        # "Device or resource busy" 폭풍 후 MAX_QUICK_DEATHS 포기, 마이크 무음.
        # 저널 증거: 같은 초에 "respawning (1, backoff 1.0s)" 3회(단일 펌프면 불가능).
        relay = WakeRelay()
        dead = Mock()
        dead.stdout.read = Mock(return_value=b'')  # 즉시 EOF -> 백오프 진입
        dead.poll.return_value = 1
        relay.process = dead
        ws = AsyncMock()
        relay.clients.add(ws)

        with patch('wake.subprocess.Popen') as mock_popen, \
                patch('wake.RESPAWN_BACKOFF_S', 5):
            relay.task = asyncio.get_running_loop().create_task(relay._pump())
            await asyncio.sleep(0.1)  # 펌프가 EOF 읽고 백오프 sleep 에 들어갈 시간
            pump_task = relay.task
            await relay.subscribe(ws)  # 백오프 중 재구독
            self.assertIs(relay.task, pump_task)  # 펌프 교체/복제 금지
            mock_popen.assert_not_called()  # arecord 이중 스폰 금지
            pump_task.cancel()
            try:
                await pump_task
            except asyncio.CancelledError:
                pass

    async def test_stop_capture_kills_arecord_ignoring_sigterm(self):
        # SIGTERM 무시하는 arecord: wait 타임아웃 뒤 kill 로 넘어가야 한다.
        relay = WakeRelay()
        relay.process = Mock()
        relay.process.poll.return_value = None
        import time
        state = {'calls': 0}
        def hang_first_wait():
            state['calls'] += 1
            if state['calls'] == 1:
                time.sleep(0.5)  # WAIT_TIMEOUT_S(0.05) 초과 = SIGTERM 무시 흉내
        relay.process.wait = Mock(side_effect=hang_first_wait)

        with patch('wake.WAIT_TIMEOUT_S', 0.05):
            await asyncio.wait_for(relay._stop_capture(), 2)

        relay.process.kill.assert_called_once()

    async def test_pump_backoff_grows_exponentially_and_caps(self):
        # 세션 종료 직후 viva-server 가 아직 마이크를 쥐고 있으면 arecord 가
        # 연속 즉사한다 - 고정 1초 백오프 5회는 /record/stop join(최대 5초)을
        # 못 버티고 영구 포기했다. 백오프를 지수로 늘리고 한도를 올린다.
        relay = WakeRelay()
        relay.process = Mock()
        relay.process.stdout.read = Mock(return_value=b'')  # 항상 즉사
        ws = AsyncMock()
        relay.clients.add(ws)
        sleeps = []

        async def fake_sleep(s):
            sleeps.append(s)

        respawn = Mock()
        respawn.stdout.read = Mock(return_value=b'')
        with patch('wake.subprocess.Popen', return_value=respawn), \
             patch('wake.asyncio.sleep', side_effect=fake_sleep):
            await relay._pump()

        # MAX_QUICK_DEATHS=8 회 재시도, 백오프 1,2,4,5,5,5,5,5 (5초 캡)
        self.assertEqual(sleeps, [1.0, 2.0, 4.0, 5.0, 5.0, 5.0, 5.0, 5.0])

if __name__ == '__main__':
    unittest.main()

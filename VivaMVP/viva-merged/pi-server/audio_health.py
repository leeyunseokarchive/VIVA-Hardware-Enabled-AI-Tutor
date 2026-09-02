"""
마이크·스피커가 살아있는지 /proc/asound 읽기만으로 판정한다.

능동 프로브(짧게 녹음해 RMS 확인)는 쓸 수 없다. asound.conf 의 micboost 는
plughw:0 직결(softvol)이라 캡처가 배타적이고, 유휴 상태에서 그 장치는
wake.py 의 arecord 가 쥐고 있다. 열어보려 하면 -EBUSY 로 실패해 멀쩡한
마이크를 고장으로 오판하거나, 마이크를 뺏어 호출어 감지를 죽인다.

그래서 "누군가 그 서브스트림을 열고 있는가"를 본다. `mic_ok` 가 실제로
증명하는 건 "wake 릴레이가 지금 마이크를 쥐고 있다"이지 "마이크가
살아있다"가 아니다 - 이 둘은 wake.py 가 마이크를 유휴 시점에 **영구히**
쥐고 있을 때만 같다.

wake.py 를 읽어보면 그렇지 않다: `_start_capture()` 는 `subscribe()` 안
에서만 불리고, 마지막 WS 클라이언트가 나가면 `disconnect()` 가, 일시정지
때는 `pause()` 가 캡처를 놓는다. 즉 캡처 서브스트림은 **폰이 wake 릴레이를
구독 중일 때만** 열려 있다 - 세션 중(App.tsx 가 wake 스트림을 pause 해
두는 동안)과, 재구독 직후 `resume()` 이 아직 안 돈 찰나에는 마이크가
멀쩡해도 서브스트림은 닫혀 있다.

# ponytail: sticky 10초(MIC_STICKY_S)가 이 공백 대부분을 흡수하지만
# 천장이 있다 - Pi 부팅 직후엔 last_capture_open 이 0.0 이라 sticky 가
# 적용 안 되고, 연결 직후 첫 프로브가 resume() 보다 먼저 뜨면 5초 폴링
# 한 틱 동안 mic_ok=false 오탐이 뜬다(연결→idle 홈 복귀마다 재발). 업그레이드
# 경로: (a) 부팅 시 last_capture_open 을 now 로 시드하거나, (b) wake.py 가
# arecord 를 클라이언트 생명주기가 아니라 서비스 생명주기 동안 쥐게 한다.

app.py 와 분리한 이유: app.py 는 picamera2/libcamera 를 모듈 최상단에서
import 해서 Pi 밖에서는 import 자체가 실패한다 - 여기 있어야 개발 머신에서
테스트가 돈다.
"""
import glob
import os

# 호출어 감지 후 폰은 wake.py 에 pause(= arecord 종료) 를 보낸 뒤에야
# /record/start 를 친다. 그 사이엔 아무도 마이크를 쥐지 않는 공백이 있어,
# 5초 폴링이 그 틈에 떨어지면 정상 마이크가 고장으로 뜬다. 마지막으로
# 열린 걸 본 시각으로부터 이 시간 안이면 정상으로 본다.
MIC_STICKY_S = 10.0


def substream_open(card_dir, kind):
    """kind: 'c'(캡처) | 'p'(재생). 서브스트림이 하나라도 열려 있으면 True.

    ALSA 는 아무도 안 열었을 때 hw_params 에 'closed' 를 쓰고, 열려 있으면
    format/rate 등 파라미터 덤프를 쓴다. 읽기 실패는 '닫힘'으로 삼킨다."""
    pattern = os.path.join(card_dir, "pcm*" + kind, "sub*", "hw_params")
    for path in glob.glob(pattern):
        try:
            with open(path) as f:
                if f.read().strip() != "closed":
                    return True
        except OSError:
            continue
    return False


def audio_health(card_dir, recording, now, last_capture_open):
    """(mic_ok, speaker_ok, next_last_capture_open) 을 돌려준다.

    호출부가 next_last_capture_open 을 보관했다가 다음 호출에 도로 넣어준다 -
    이 모듈은 상태를 안 들고 있어서 테스트가 시간에 의존하지 않는다."""
    if not os.path.isdir(card_dir):
        return False, False, last_capture_open

    capture = substream_open(card_dir, "c")
    if capture:
        last_capture_open = now

    mic_ok = capture or recording or (now - last_capture_open) < MIC_STICKY_S
    return mic_ok, substream_open(card_dir, "p"), last_capture_open

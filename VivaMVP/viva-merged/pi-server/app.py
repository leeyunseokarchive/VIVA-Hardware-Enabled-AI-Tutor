"""
VivaHW Pi Zero server.

역할: 카메라, 마이크 캡처와 TTS 오디오 재생만 담당한다. 실제 Gemini 호출과
판단은 전부 VivaApp(React Native, 폰) 쪽에서 하고 이 서버는 순수 하드웨어
브릿지 역할만 한다.

이전 초안(Pi_서버_구현_가이드.md) 대비 고친 점:
- TTS가 mp3로 오는데 aplay는 mp3를 못 튼다. mpg123으로 재생하도록 바꿈
- USB 오디오 카드 번호를 하드코딩하지 않고 환경변수(VIVA_AUDIO_CARD)로 뺌
- 녹음이 켜진 채로 방치되는 상황을 막기 위해 최대 녹음 시간 워치독 추가
- 헬스체크(/health)와 사진 단독 촬영(/capture/photo/now) 엔드포인트 추가.
  기존엔 사진이 record/stop에만 묶여 있어 음성 없이 사진만 필요한 경우를
  처리하지 못했다

2026-07-22 카메라 포커스/크롭 전략 설계(§3, §5) 반영:
- Tier 2용 /capture/region(정규화 bbox 를 ScalerCrop 으로 재촬영). 한때 호출부가
  없어 삭제했다가 2026-07-28 저녁 복원 - 보관본 크롭(/photo/crop)조차 인식
  실패하면 재촬영이 필요한데, 로봇 시나리오에서 폰 카메라를 켜는 건 틀린
  UX 라(폰은 거치돼 있음) 해당 문제 bbox 에 AF 윈도우를 걸고 Pi 가 다시
  찍는 게 맞다. 앱 FSM 의 Tier 2 폴백이 이걸 호출한다.

2026-07-28 D-14 로 방침 변경 - 크롭은 Pi 가 한다:
- 초안(§6)은 "Pi 는 촬영·전송만, 크롭은 전부 VivaApp" 이었으나 폐기했다.
  앱에는 2048 축소본만 내려가므로 앱에서 잘라봐야 픽셀이 없다 - 12MP
  보관 원본을 가진 Pi 가 잘라야 크롭의 의미가 있다.
- 역할 분담: bbox 산출은 Gemini(box_2d, 0~1000 정규화), 좌표계 변환과
  실제 crop/resize 는 Pi(imaging.py), 앱은 전달만 한다.

2026-07-23 수동 포커스 고정으로 변경 (이후 원인이 카메라 모듈 하드웨어
불량으로 확인되어 모듈을 교환함):
- 당시 실기기 테스트에서 AfMode.Auto가 배경(문제지 뒤 복도)에 초점을
  맞추는 것처럼 보여 수동 초점 고정으로 바꿨었다. 그런데 이후 이 개체가
  Camera frontend timeout을 내는 불량 모듈로 확인돼 교환했고, 오토포커스
  자체가 원래 문제가 아니었을 가능성이 높다.

2026-07-24 새 카메라 모듈 교체 후 오토포커스 복원:
- 새 모듈에서는 수동 고정 초점(25cm)으로는 책상 위 문제지 각도/거리가
  조금만 달라져도 초점이 안 맞아 흐릿하게 찍히는 문제가 실측 확인됐다.
  AF 모터가 정상 동작하는 모듈이므로 매 촬영마다 autofocus_cycle()로
  실제 피사체에 초점을 맞추는 방식(Auto)으로 되돌린다 - 원 설계 문서 §3
  picamera2 예시와 동일.
- VIVA_FOCUS_MODE 환경변수로 auto(기본)/manual을 선택할 수 있게 남겨둔다.
  나중에 특정 개체가 다시 AF 이상 증상을 보이면 재빌드 없이
  VIVA_FOCUS_MODE=manual로 폴백 가능하다.
"""
import array
import os
import struct
import subprocess
import threading
import time

from flask import Flask, request, send_file, jsonify
from picamera2 import Picamera2
from libcamera import Transform, controls
from PIL import Image

from imaging import crop_box2d, parse_box2d, resize_to_width, save_transfer_copy
from audio_health import audio_health
from cam_health import cam_health

app = Flask(__name__)

# I2S 오디오(INMP441 마이크 + MAX98357 앰프) 구성. 두 PCM 은 /etc/asound.conf 정의:
# micboost = softvol +28dB (INMP441 원신호가 낮아 부스트 필수),
# dmixout = dmix 믹서 (viva-silence 무음 스트림과 공유해 앰프 시작/끝 팝 제거).
# USB 동글 등 다른 구성으로 바꾸면 환경변수로 교체한다.
RECORD_DEVICE = os.environ.get("VIVA_RECORD_DEVICE", "micboost")
PLAY_DEVICE = os.environ.get("VIVA_PLAY_DEVICE", "dmixout")

# 오디오 구성이 바뀌면(USB 동글 등) 카드 번호가 달라진다 - /health 의
# mic_ok/speaker_ok 판정이 볼 /proc/asound/card{N} 을 바꿀 수 있게 뺀다.
SOUND_CARD = os.environ.get("VIVA_SOUND_CARD", "0")

# audio_health 가 상태를 안 들고 있어서 여기가 보관한다. 캡처가 열려 있는 걸
# 마지막으로 관측한 시각(epoch). 0 = 한 번도 못 봄.
_mic_last_open = 0.0

# cam_health 도 상태를 안 들고 있어서 여기가 보관한다. (값, 관측 시각) 또는 None.
_cam_cached = None

RECORDING_PATH = "/tmp/recording.wav"
PHOTO_PATH = "/tmp/photo.jpg"
TTS_INPUT_PATH = "/tmp/tts_input.audio"

# 크롭 파이프라인(2026-07-28 스펙): 촬영 원본(12MP, q95)은 FULL_PHOTO_PATH에
# 보관하고, 앱으로 내려가는 PHOTO_PATH는 2048폭 축소본이다. 고해상도가
# 필요하면 재촬영 대신 /photo/crop 이 보관본에서 잘라낸다.
FULL_PHOTO_PATH = "/tmp/photo_full.jpg"
CROP_PATH = "/tmp/photo_crop.jpg"
TRANSFER_WIDTH = 2048

# 보관 원본 JPEG 품질. 이 원본의 유일한 소비자는 /photo/crop (문제 하나 bbox 를
# 잘라 2048 폭으로 내려준다) 이라 q95 까지 쓸 이유가 없었다 - Pi Zero 에서
# 12MP q95 인코딩은 눈에 띄게 느리고 파일도 크다. 크롭 화질이 부족해 보이면
# 이 값을 올린다 (재빌드 없이 VIVA_ARCHIVE_QUALITY).
ARCHIVE_QUALITY = int(os.environ.get("VIVA_ARCHIVE_QUALITY", "88"))

# auto: 매 촬영마다 autofocus_cycle()로 실제 초점을 맞춘다 (기본, AF 모터
# 정상 동작 전제). manual: 특정 개체가 AF 이상을 보일 때만 폴백으로 쓰는
# 고정 초점 모드 - VIVA_FOCUS_DISTANCE_CM(cm)으로 거리 조절.
FOCUS_MODE = os.environ.get("VIVA_FOCUS_MODE", "auto").strip().lower()
FOCUS_DISTANCE_CM = float(os.environ.get("VIVA_FOCUS_DISTANCE_CM", "25"))
LENS_POSITION = 1.0 / (FOCUS_DISTANCE_CM / 100.0)

# 녹음이 이 시간(초)을 넘기면 강제 종료한다. 네트워크가 끊겨 stop 요청이
# 안 오는 경우 계속 켜져 있는 상태를 막기 위한 안전장치다.
MAX_RECORDING_SECONDS = 30

# 서버 측 발화 종료(침묵) 감지 - 로봇 마이크 모드에서 앱은 스트리밍 PCM 이
# 없어 침묵을 못 본다. 앱 useVoiceInput 과 같은 의미론: 말이 한 번이라도
# 감지된 뒤 SILENCE_MS 동안 조용하면 자동 종료, 무발화면 MAX_RECORDING_SECONDS
# 까지 대기. 임계값은 폰(0.015)과 달리 INMP441+MicBoost 실측으로 조정한다 -
# /record/status 의 rms 필드를 보면서 잡음 바닥과 발화 사이 값으로.
#
# 1500 -> 3000 (뜸 들이는 학생을 끊었다) -> 2000 (2026-08-07). 3000 은 무신호
# 대기가 지루하다는 피드백에서 왔는데, 실제 해법의 대부분은 이 숫자가 아니라
# 듣는 중/다 들었다를 알리는 로봇 눈 신호다(eyes.py 의 listening 상태).
# 여기 값은 그 신호를 붙인 뒤 남은 체감만 깎는 몫이다. 되돌리려면 env 로.
SILENCE_MS = int(os.environ.get("VIVA_SILENCE_MS", "2000"))
# 0.015 -> 0.022 (2026-08-12): 잡음 바닥 블립(0.004~0.015 스침)이 had_speech 를
# 세워 무음 WAV 가 STT 로 갔다. -> 0.013 + 연속 SPEECH_MIN_CHUNKS (2026-08-13):
# 0.022 는 반대로 원거리 조용한 발화를 잡음으로 분류했다 - 실기기에서 "괜찮아
# 꺼줘" 가 had_speech=False (저널 17:24~17:25, 3/6 회). 잡음 블립과 조용한 발화는
# 크기 대역이 겹쳐(0.01~0.02) 크기만으론 못 가른다 - 가르는 건 지속시간이다.
# 블립은 1청크(100ms), 발화는 수백 ms 지속. 그래서 임계값은 잡음 바닥 위
# 최소로 내리고, 연속 3청크(300ms) 지속을 요구한다(WakeFireGate 와 같은 패턴).
# 0.013 -> 0.009 (2026-08-13 2차): 원거리 발화 RMS 가 0.008~0.019 로 출렁여
# (음절 사이 에너지 골) 0.013 은 3연속을 못 채웠다 - 실기기 peak_rms 0.018/0.0198
# 인데 had_speech=False. 지속 잡음 바닥은 ~0.005 (wake 스트림 amp mean 실측)
# 이라 0.009 는 그 위 여유가 있다.
# 방이 바뀌면 env 로 - record done 저널의 peak_rms 실측으로 조정.
SILENCE_RMS_THRESHOLD = float(os.environ.get("VIVA_SILENCE_THRESHOLD", "0.009"))
# 발화 시작 인정에 필요한 연속 임계값 초과 청크 수 (1청크 = 100ms).
SPEECH_MIN_CHUNKS = int(os.environ.get("VIVA_SPEECH_MIN_CHUNKS", "3"))
# had_speech 이후 침묵 타이머(last_voice) 리셋에 필요한 연속 임계값 초과
# 청크 수 - 단발 잡음 블립(1청크) 이 침묵 타이머를 계속 늘려 녹음이 안
# 끝나던 문제 방어 (SPEECH_MIN_CHUNKS 의 온셋 스트릭과 같은 패턴).
SILENCE_RESET_MIN_CHUNKS = int(os.environ.get("VIVA_SILENCE_RESET_MIN_CHUNKS", "2"))
RECORD_SAMPLE_RATE = 16000
RECORD_CHUNK_BYTES = 3200  # 100ms @ 16kHz mono S16 - 침묵 판정 해상도

# 로봇이 학생 반대편에서 책상을 보는 구도라 프레임이 180도 뒤집혀 들어온다 -
# 수식/손글씨가 거꾸로면 인식률이 떨어지므로 ISP에서 뒤집어 바로잡는다
# (하드웨어 처리라 CPU 비용 0, 보관 원본/전송본/크롭 좌표계가 전부 일관).
# 배치가 바뀌어 정방향이 되면 VIVA_CAMERA_ROTATE=0.
CAMERA_ROTATE = int(os.environ.get("VIVA_CAMERA_ROTATE", "180"))

def _open_picam2():
    cam = Picamera2()
    cam.configure(cam.create_still_configuration(
        transform=Transform(hflip=1, vflip=1) if CAMERA_ROTATE == 180 else Transform(),
    ))
    cam.options["quality"] = 95
    return cam


picam2 = _open_picam2()
# 센서 전체 해상도 - ScalerCrop 계산(정규화 bbox -> 픽셀 좌표)에 쓴다.
SENSOR_W, SENSOR_H = picam2.camera_properties["PixelArraySize"]
# 읽었으면 바로 놓아준다. libcamera acquire 는 프로세스 배타라, 여기서 계속
# 쥐고 있으면 viva-provision 의 QR 스캔 카메라가 영영 안 열린다(부팅 직후
# WiFi 미연결 = 촬영 요청도 올 수 없는 상태가 정확히 그 시나리오다).
# 촬영 때 _camera_touch 가 다시 열고, 유휴 정지가 다시 닫는다.
picam2.close()
picam2 = None

# 카메라는 촬영 전후에만 켠다. 상시 스트리밍(12MP)이 SDRAM 대역폭을 디스플레이
# 스캔아웃과 나눠 써서 HDMI 화면 전체가 계속 깜빡였다(실기기 2026-08-03 -
# viva-server 를 끄면 깜빡임이 사라지는 것으로 확정). 유휴 시 자동 정지.
CAMERA_IDLE_STOP_SECONDS = float(os.environ.get("VIVA_CAMERA_IDLE_STOP", "5"))
_camera_idle_timer = None

# AF 탐색 범위. 책상 위 문제지는 렌즈에서 대략 20~40cm(가이드 문서 기준
# 25cm)라 기본을 Macro(근거리 우선)로 둔다 - Normal(전체 범위)은 AF가
# 원거리(뒷배경 벽/복도)까지 훑다가 배경에 초점을 맞추는 경우가 있었다.
# 로봇 배치가 바뀌어 먼 피사체를 봐야 하면 VIVA_AF_RANGE=normal 로 폴백.
AF_RANGE = os.environ.get("VIVA_AF_RANGE", "macro").strip().lower()

# AF 선행(prewarm) 유효 시간(초). /capture/prewarm 이 초점을 맞춰두면 그 뒤
# 이 시간 안에 들어온 전체 촬영은 AF 사이클(실측 5.7초)을 건너뛴다.
# 앱은 "이제 곧 찍겠다" 를 아는 시점(호출어 감지, 재촬영 안내 발화 시작)에
# 미리 때린다 - 그 발화/정리 시간 뒤로 AF 가 숨는다.
#
# 창을 너무 길게 잡으면 그 사이 종이가 움직여도 옛 초점으로 찍는다. 8초는
# "발화 한 문장 + 왕복" 정도만 덮는 값. 0 으로 두면 선행 AF 를 아예 끈다
# (매 촬영 AF = 예전 동작).
AF_FRESH_SECONDS = float(os.environ.get("VIVA_AF_FRESH_SECONDS", "8"))

# 마지막으로 AF 가 수렴한 시각(monotonic). 0 이면 "신선한 초점 없음".
_focus_ready_at = 0.0

# 촬영 직렬화. Flask 기본이 스레드당 요청이라, 앱이 타임아웃 후 재시도하면
# 이전 요청의 autofocus_cycle()이 아직 도는 중에 새 촬영이 겹칠 수 있다 -
# 그러면 AF 도중 렌즈가 움직이는 채로 찍혀 흐린 사진이 나온다.
# ponytail: 전역 lock 하나면 충분 - 카메라가 물리적으로 1대라 동시성이 애초에 없다.
_capture_lock = threading.Lock()

# 12MP 보관본 인코딩은 응답 경로에서 뺐다(실측 ~9.5초 중 대부분) - 전송본만
# 쓰고 응답한 뒤 백그라운드 스레드가 보관본을 쓴다. 유일한 소비자인
# /photo/crop 은 Gemini 분석 뒤(수 초 후)에나 오므로 그때까지만 끝나면 된다.
# _archive_ready: 새 촬영 시 clear, 보관본 기록 완료 시 set - crop 이 기다린다.
# _archive_lock: 백그라운드 기록과 crop 읽기가 FULL_PHOTO_PATH 를 두고 겹치지 않게.
_archive_thread = None
_archive_ready = threading.Event()
_archive_ready.set()  # 재시작 직전 보관본이 남아 있으면 그대로 crop 가능 (예전 동작)
_archive_lock = threading.Lock()


def _write_archive(img) -> None:
    t0 = time.time()
    with _archive_lock:
        img.save(FULL_PHOTO_PATH, "JPEG", quality=ARCHIVE_QUALITY)
    _archive_ready.set()
    print(f"[viva-server] archive encode={time.time() - t0:.2f}s (background)")


def _apply_focus_controls() -> None:
    """AF 컨트롤은 파이프라인 시작 후마다 다시 건다 - stop/start 를 오가는
    유휴 정지 구조에서 컨트롤 잔존을 가정하지 않는다."""
    if FOCUS_MODE == "manual":
        # 폴백 경로: AF 모터가 의심스러운 개체를 만났을 때만 재빌드 없이 이
        # 환경변수로 전환해서 쓴다.
        picam2.set_controls({"AfMode": controls.AfModeEnum.Manual, "LensPosition": LENS_POSITION})
    else:
        picam2.set_controls({
            "AfMode": controls.AfModeEnum.Auto,
            "AfRange": (controls.AfRangeEnum.Macro if AF_RANGE == "macro"
                        else controls.AfRangeEnum.Normal),
            "AfSpeed": controls.AfSpeedEnum.Fast,
        })


def _camera_touch() -> None:
    """촬영 직전 호출 (반드시 _capture_lock 안에서). 닫혀 있으면 열고,
    유휴 정지 타이머를 다시 감는다. 프로비저닝 스캐너가 카메라를 쥔 채면
    Picamera2() 가 던진다 - 호출자 경로로 에러가 나가고 앱이 재시도한다."""
    global picam2, _camera_idle_timer
    if picam2 is None:
        t0 = time.time()
        picam2 = _open_picam2()
        picam2.start()
        _apply_focus_controls()
        print(f"[viva-server] camera opened in {time.time() - t0:.2f}s")
    elif not picam2.started:
        t0 = time.time()
        picam2.start()
        _apply_focus_controls()
        print(f"[viva-server] camera started in {time.time() - t0:.2f}s")
    if _camera_idle_timer:
        _camera_idle_timer.cancel()
    _camera_idle_timer = threading.Timer(CAMERA_IDLE_STOP_SECONDS, _camera_idle_stop)
    _camera_idle_timer.daemon = True
    _camera_idle_timer.start()


def _camera_idle_stop() -> None:
    global picam2, _camera_idle_timer, _focus_ready_at
    # 촬영이 아직 도는 중이면(타이머보다 긴 촬영) 다음 기회로 미룬다.
    if not _capture_lock.acquire(blocking=False):
        _camera_idle_timer = threading.Timer(CAMERA_IDLE_STOP_SECONDS, _camera_idle_stop)
        _camera_idle_timer.daemon = True
        _camera_idle_timer.start()
        return
    try:
        if picam2 is not None:
            # stop 이 아니라 close - acquire 를 놓아야 viva-provision 이
            # QR 스캔 카메라를 열 수 있다. 재열기 비용은 다음 촬영이 낸다.
            picam2.close()
            picam2 = None
            _focus_ready_at = 0.0  # 정지하면 선행 AF 신선도도 무효
            print("[viva-server] camera closed (idle)")
    finally:
        _capture_lock.release()


def _autofocus_or_log() -> bool:
    """AF 한 사이클. 실패(수렴 못 함)하면 1회 재시도하고, 그래도 실패하면
    로그만 남기고 촬영은 진행한다 - 이전 코드는 반환값을 버려서 AF가
    실패한 채(렌즈가 엉뚱한 위치) 찍혀도 알 길이 없었다.

    수렴했으면 _focus_ready_at 을 갱신한다 - 곧바로 이어지는 촬영이 AF 를
    한 번 더 돌지 않게 하는 근거다. 실패했으면 갱신하지 않는다(엉뚱한 렌즈
    위치를 '신선한 초점' 으로 재사용하면 안 된다)."""
    global _focus_ready_at
    converged = picam2.autofocus_cycle()
    if not converged:
        print("[viva-server] autofocus failed to converge, retrying once...")
        converged = picam2.autofocus_cycle()
        if not converged:
            print("[viva-server] autofocus failed twice - capturing anyway (photo may be blurry)")
    _focus_ready_at = time.monotonic() if converged else 0.0
    return converged


def _focus_is_fresh() -> bool:
    """선행 AF 가 아직 유효한가. AF_FRESH_SECONDS=0 이면 항상 False(기능 off)."""
    return AF_FRESH_SECONDS > 0 and (time.monotonic() - _focus_ready_at) < AF_FRESH_SECONDS


def _write_outputs(path: str) -> None:
    """촬영 결과를 보관 원본 + 전송용 축소본으로 저장한다.

    예전에는 capture_file() 로 12MP JPEG 를 쓴 뒤 그 파일을 **다시 열어
    디코드해서** 축소본을 만들었다. 방금 메모리에 있던 이미지를 JPEG 로
    왕복시킬 이유가 없다 - 그 디코드가 resize 구간(실측 5.3초)의 큰 몫이었다.
    capture_request() 로 버퍼를 한 번만 받아 둘 다 여기서 만든다.

    2026-08-04: 12MP 보관본 인코딩(응답 지연의 대부분)은 백그라운드로 뺐다.
    전송본만 쓰면 바로 반환하고, 보관본은 _write_archive 스레드가 마저 쓴다."""
    global _archive_thread
    # 이전 보관본 인코딩이 아직 돌고 있으면 먼저 끝낸다 - 진행 중인 기록을
    # 새 프레임이 덮지 않게. (배열 복사 ~36MB 대신 join - RAM 절약)
    if _archive_thread and _archive_thread.is_alive():
        _archive_thread.join()
    request = picam2.capture_request()
    try:
        img = request.make_image("main")  # 버퍼에서 복사되므로 release 후에도 유효
    finally:
        request.release()
    _archive_ready.clear()
    save_transfer_copy(img, path, TRANSFER_WIDTH)
    _archive_thread = threading.Thread(target=_write_archive, args=(img,), daemon=True)
    _archive_thread.start()


def _capture_full(path: str) -> None:
    """전체 프레임 촬영 (Tier 1). auto 모드면 촬영 직전 실제 피사체로
    초점을 맞춘 뒤 찍는다. 원본은 FULL_PHOTO_PATH 에 보관하고(크롭용),
    path 에는 전송용 축소본을 쓴다."""
    with _capture_lock:
        t0 = time.time()
        _camera_touch()
        # 선행 AF(/capture/prewarm)가 방금 초점을 맞춰뒀으면 건너뛴다.
        prewarmed = _focus_is_fresh()
        if FOCUS_MODE != "manual" and not prewarmed:
            _autofocus_or_log()
        t_af = time.time()
        _write_outputs(path)
        # 촬영 지연 실측 (SESSION_HANDOFF 미검증 항목). PYTHONUNBUFFERED=1 이라
        # journalctl -fu viva-server 로 바로 보인다. af=0.0 + prewarmed=True 면
        # 선행 AF 가 실제로 먹은 것.
        print(f"[viva-server] capture af={t_af - t0:.2f}s "
              f"encode={time.time() - t_af:.2f}s prewarmed={prewarmed}")


def _capture_region(x: float, y: float, w: float, h: float, path: str) -> None:
    """정규화 bbox(x,y,w,h, 0~1) 영역만 ScalerCrop으로 다시 촬영한다
    (Tier 2 폴백: 보관본 크롭까지 인식 실패했을 때). auto 모드면 그 영역에
    AF 윈도우를 걸어 그 문제에 다시 초점을 맞춘다."""
    global _focus_ready_at
    crop = (int(x * SENSOR_W), int(y * SENSOR_H), int(w * SENSOR_W), int(h * SENSOR_H))
    with _capture_lock:
        t0 = time.time()
        _camera_touch()
        # 여기서는 선행 AF 를 절대 재사용하지 않는다 - 이 경로의 존재 이유가
        # "그 문제 bbox 에 AF 윈도우를 걸고 다시 맞추는 것" 이다.
        if FOCUS_MODE != "manual":
            picam2.set_controls({"ScalerCrop": crop, "AfWindows": [crop]})
            _autofocus_or_log()
        else:
            picam2.set_controls({"ScalerCrop": crop})
        t_af = time.time()
        _write_outputs(path)
        # 다음 촬영(전체 재촬영 등)이 이전 크롭에 갇히지 않도록 원복해둔다.
        picam2.set_controls({"ScalerCrop": (0, 0, SENSOR_W, SENSOR_H)})
        # 초점이 이 부분 영역에 맞춰져 있으므로 전체 프레임 촬영이 이걸
        # "신선한 초점" 으로 재사용하면 안 된다.
        _focus_ready_at = 0.0
        print(f"[viva-server] region-capture af={t_af - t0:.2f}s "
              f"encode={time.time() - t_af:.2f}s")


# 녹음 상태. 녹음 스레드가 arecord stdout(raw PCM)을 읽으며 RMS 침묵 판정과
# WAV 기록을 함께 한다 - 헤더를 직접 쓰므로 예전의 "SIGTERM 으로 끊긴 arecord
# 가 4GB급 스트리밍 헤더를 남기는" 문제가 구조적으로 없다.
_rec_thread = None
_rec_stop = threading.Event()
_rec_state = {"recording": False, "had_speech": False, "rms": 0.0, "silent_ms": 0}


def _wav_header(data_size: int) -> bytes:
    # 표준 44바이트 헤더, S16_LE mono 16kHz.
    return (b"RIFF" + struct.pack("<I", 36 + data_size) + b"WAVE"
            + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, RECORD_SAMPLE_RATE,
                                    RECORD_SAMPLE_RATE * 2, 2, 16)
            + b"data" + struct.pack("<I", data_size))


def _chunk_rms(chunk: bytes) -> float:
    # 0~1 정규화 RMS. audioop 은 Python 3.13 에서 제거돼 array 로 직접 계산.
    samples = array.array("h", chunk[: len(chunk) - (len(chunk) % 2)])
    if not samples:
        return 0.0
    acc = 0
    for s in samples:
        acc += s * s
    return (acc / len(samples)) ** 0.5 / 32768.0


# 발화 앞뒤 침묵 트리밍 (2026-08-14): 실측에서 WAV 6.4초 중 절반 이상이
# 침묵(인사 끝~학생 말 시작 대기 + 꼬리 SILENCE_MS 2초)이라 업로드와 Gemini
# 오디오 토큰을 그만큼 낭비했고 classify 지연(9.4초)에 그대로 얹혔다.
# 발화 시작 전은 pre-roll 만, 마지막 발화 뒤는 tail 만 남기고 잘라 보낸다.
TRIM_PREROLL_MS = int(os.environ.get("VIVA_TRIM_PREROLL_MS", "300"))
TRIM_TAIL_MS = int(os.environ.get("VIVA_TRIM_TAIL_MS", "500"))


def _trim_recording(path, speech_start_bytes, last_voice_bytes, data_size):
    """녹음 WAV 에서 발화 앞 침묵(pre-roll 제외)과 꼬리 침묵(tail 제외)을
    잘라 같은 경로에 다시 쓴다. 잘라낸 바이트 수를 반환. 오프셋은 전부
    100ms 청크 경계라 샘플(2바이트) 정렬이 보장된다."""
    bytes_per_ms = RECORD_SAMPLE_RATE * 2 // 1000
    start = max(0, speech_start_bytes - TRIM_PREROLL_MS * bytes_per_ms)
    end = min(data_size, last_voice_bytes + TRIM_TAIL_MS * bytes_per_ms)
    if end <= start or (start <= 0 and end >= data_size):
        return 0
    with open(path, "rb") as f:
        f.seek(44 + start)
        data = f.read(end - start)
    with open(path, "wb") as f:
        f.write(_wav_header(len(data)))
        f.write(data)
    return data_size - len(data)


def _record_loop(proc):
    """arecord stdout 을 읽어 WAV 로 쓰면서 침묵을 감지한다. 종료 조건은
    앱 useVoiceInput 과 동일: ① stop 요청 ② 발화 시작 후 SILENCE_MS 침묵
    ③ MAX_RECORDING_SECONDS 상한(무발화 포함).

    silent_ms 는 앱이 폴링으로 읽어 "말이 멈춘 것 같다"(눈 신호 전환)를
    판정하는 값이다 - 종료 판정(SILENCE_MS)보다 훨씬 짧은 문턱을 쓴다.
    max_pause 는 발화 중간에 관찰된 최장 침묵 - 학생이 그 뒤 말을 이었으니
    SILENCE_MS 가 그보다 작았다면 끊었을 값이다. 임계값을 감이 아니라
    분포로 정하려고 남긴다."""
    started = time.monotonic()
    last_voice = started
    max_pause = 0.0
    data_size = 0
    peak_rms = 0.0
    speech_streak = 0
    # 트리밍용 오프셋 - 발화로 인정된 스트릭의 시작 바이트, 마지막 발화 바이트.
    streak_start_bytes = 0
    speech_start_bytes = None
    last_voice_bytes = 0
    trimmed_bytes = 0
    try:
        with open(RECORDING_PATH, "wb") as f:
            f.write(_wav_header(0))
            while True:
                chunk = proc.stdout.read(RECORD_CHUNK_BYTES)
                if not chunk:
                    break
                f.write(chunk)
                data_size += len(chunk)
                now = time.monotonic()
                rms = _chunk_rms(chunk)
                _rec_state["rms"] = round(rms, 4)
                peak_rms = max(peak_rms, rms)
                if rms >= SILENCE_RMS_THRESHOLD:
                    if speech_streak == 0:
                        streak_start_bytes = data_size - len(chunk)
                    speech_streak += 1
                    if _rec_state["had_speech"]:
                        # 연속 SILENCE_RESET_MIN_CHUNKS 청크 지속 확인 후에만
                        # 침묵 타이머를 리셋 - 단발 잡음 블립(1청크) 하나로
                        # last_voice 가 계속 밀려 녹음이 안 끝나는 것 방어.
                        if speech_streak >= SILENCE_RESET_MIN_CHUNKS:
                            # had_speech 를 세우기 **전에** 잰다 - 첫 발화까지의
                            # 간격은 녹음 시작부터의 대기 시간이라 '중간 침묵' 이
                            # 아니다.
                            max_pause = max(max_pause, now - last_voice)
                            last_voice = now
                            last_voice_bytes = data_size
                    elif speech_streak >= SPEECH_MIN_CHUNKS:
                        # 연속 지속 확인 후에만 발화 시작 인정 - 단발 잡음
                        # 블립(1청크) 방어.
                        _rec_state["had_speech"] = True
                        last_voice = now
                        last_voice_bytes = data_size
                        speech_start_bytes = streak_start_bytes
                else:
                    speech_streak = 0
                _rec_state["silent_ms"] = (
                    int((now - last_voice) * 1000) if _rec_state["had_speech"] else 0
                )
                if _rec_stop.is_set():
                    break
                if _rec_state["had_speech"] and (now - last_voice) * 1000 >= SILENCE_MS:
                    break
                if now - started >= MAX_RECORDING_SECONDS:
                    break
            f.seek(0)
            f.write(_wav_header(data_size))
        # 트리밍은 recording=False 로 내리기 전(finally 이전)에 끝낸다 - 앱은
        # 폴링으로 recording=False 를 본 즉시 /record/audio 를 당긴다.
        if _rec_state["had_speech"] and speech_start_bytes is not None:
            trimmed_bytes = _trim_recording(
                RECORDING_PATH, speech_start_bytes, last_voice_bytes, data_size)
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait()
        _rec_state["recording"] = False
        _rec_state["rms"] = 0.0
        _rec_state["silent_ms"] = 0
        print(f"[viva-server] record done dur={time.monotonic() - started:.1f}s "
              f"had_speech={_rec_state['had_speech']} "
              f"max_pause={int(max_pause * 1000)}ms bytes={data_size} "
              f"trimmed={trimmed_bytes} peak_rms={peak_rms:.4f}")


def _stop_recording_and_join():
    global _rec_thread
    if _rec_thread and _rec_thread.is_alive():
        _rec_stop.set()
        _rec_thread.join(timeout=5)
    _rec_thread = None


@app.route("/health", methods=["GET"])
def health():
    global _mic_last_open, _cam_cached
    # ponytail: bare global, 락 없음 - 스레드형 WSGI 배포에서 동시 /health 요청
    # 2개가 read-modify-write 를 경합할 수 있다. 최악이어도 sticky 창이 최대
    # 5초 stale 해지는 정도지 오판정으로 이어지진 않는다(둘 다 audio_health 가
    # 계산한 유효한 timestamp 중 하나를 쓴다). 필요해지면 threading.Lock 하나로
    # 감싼다.
    mic_ok, speaker_ok, _mic_last_open = audio_health(
        "/proc/asound/card" + SOUND_CARD,
        _rec_state["recording"],
        time.time(),
        _mic_last_open,
    )
    # 카메라는 열지 않고 감지 여부만 (cam_health.py 헤더 참조). None 은 JSON
    # null 로 나가고 앱 optionalBool 이 undefined 로 떨궈 배지가 안 뜬다.
    cam_ok, _cam_cached = cam_health(time.monotonic(), _cam_cached)
    return jsonify({
        "status": "ok",
        "recording": _rec_state["recording"],
        "record_device": RECORD_DEVICE,
        "play_device": PLAY_DEVICE,
        "mic_ok": mic_ok,
        "speaker_ok": speaker_ok,
        "cam_ok": cam_ok,
    })


@app.route("/record/start", methods=["POST"])
def record_start():
    global _rec_thread

    # 이미 녹음 중이면 이전 걸 정리하고 새로 시작해서 상태가 꼬이지 않게 한다.
    _stop_recording_and_join()

    proc = subprocess.Popen(
        ["arecord", "-D", RECORD_DEVICE, "-f", "S16_LE",
         "-r", str(RECORD_SAMPLE_RATE), "-c", "1", "-t", "raw", "-q", "-"],
        stdout=subprocess.PIPE,
    )
    _rec_stop.clear()
    _rec_state.update(recording=True, had_speech=False, rms=0.0, silent_ms=0)
    _rec_thread = threading.Thread(target=_record_loop, args=(proc,), daemon=True)
    _rec_thread.start()

    return jsonify({"status": "recording"})


@app.route("/record/stop", methods=["POST"])
def record_stop():
    """녹음만 멈춘다. (예전엔 여기서 전체 사진까지 찍었으나 - Pi Zero 에서
    ~11초 - 로봇 음성 루프의 발화 폐기 경로가 이 엔드포인트를 쓰게 되면서
    분리했다. 사진은 /capture/photo/now 가 전담.)"""
    _stop_recording_and_join()
    return jsonify({"status": "stopped", "had_speech": _rec_state["had_speech"]})


@app.route("/record/status", methods=["GET"])
def record_status():
    """로봇 마이크 모드의 앱 폴링용. recording 이 False 로 떨어지면(침묵
    자동 종료 or 상한) 앱이 had_speech 를 보고 /capture/audio 를 가져간다.
    rms 는 임계값(VIVA_SILENCE_THRESHOLD) 캘리브레이션용 실측치."""
    return jsonify(_rec_state)


@app.route("/capture/photo/now", methods=["POST"])
def capture_photo_now():
    """녹음과 무관하게 사진만 즉시 찍는다 (Tier 1, 고정 초점)."""
    _capture_full(PHOTO_PATH)
    return jsonify({"status": "captured"})


@app.route("/capture/prewarm", methods=["POST"])
def capture_prewarm():
    """AF 를 미리 돌려둔다. 앱이 "곧 찍는다" 를 아는 시점(호출어 감지,
    재촬영 안내 발화 시작)에 fire-and-forget 으로 때리면, 그 발화/정리
    시간 뒤로 AF 사이클(실측 5.7초)이 숨는다. AF_FRESH_SECONDS 안에 들어온
    다음 전체 촬영이 AF 를 건너뛴다.

    lock 이 잡혀 있으면(이미 촬영 중) 그냥 넘어간다 - 선행 AF 가 진짜 촬영을
    기다리게 만들면 빨라지려다 느려진다."""
    if FOCUS_MODE == "manual" or AF_FRESH_SECONDS <= 0:
        return jsonify({"status": "skipped", "reason": "prewarm disabled"})
    if not _capture_lock.acquire(blocking=False):
        return jsonify({"status": "skipped", "reason": "capture in progress"})
    try:
        t0 = time.time()
        _camera_touch()
        converged = _autofocus_or_log()
        print(f"[viva-server] prewarm af={time.time() - t0:.2f}s converged={converged}")
    finally:
        _capture_lock.release()
    return jsonify({"status": "ready" if converged else "failed"})


@app.route("/capture/region", methods=["POST"])
def capture_region():
    """Tier 2 폴백: 앱이 판별한 정규화 bbox 영역만 ScalerCrop으로
    재촬영한다. body: {"x":0~1,"y":0~1,"w":0~1,"h":0~1}"""
    body = request.get_json(silent=True) or {}
    try:
        x, y, w, h = float(body["x"]), float(body["y"]), float(body["w"]), float(body["h"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "body must have numeric x, y, w, h (0~1)"}), 400

    if not (0 <= x < 1 and 0 <= y < 1 and 0 < w <= 1 and 0 < h <= 1):
        return jsonify({"error": "x,y,w,h must be within 0~1"}), 400

    _capture_region(x, y, w, h, PHOTO_PATH)
    return jsonify({"status": "captured", "region": {"x": x, "y": y, "w": w, "h": h}})


@app.route("/capture/audio", methods=["GET"])
def get_audio():
    if not os.path.exists(RECORDING_PATH):
        return jsonify({"error": "no recording yet"}), 404
    return send_file(RECORDING_PATH, mimetype="audio/wav")


@app.route("/capture/photo", methods=["GET"])
def get_photo():
    if not os.path.exists(PHOTO_PATH):
        return jsonify({"error": "no photo yet"}), 404
    return send_file(PHOTO_PATH, mimetype="image/jpeg")


@app.route("/photo/crop", methods=["GET"])
def photo_crop():
    """보관 원본(FULL_PHOTO_PATH)에서 Gemini box_2d 좌표(0~1000 정규화,
    ymin/xmin/ymax/xmax 쿼리 파라미터)로 잘라 돌려준다. 재촬영 없음 -
    초점은 이미 맞아 있고 AF 사이클(1~2초)을 다시 돌 이유가 없다."""
    box, err = parse_box2d(request.args)
    if err:
        return jsonify({"error": err}), 400
    # 보관본 인코딩이 백그라운드로 갔으므로 기록 완료까지 기다린다.
    # 60초는 넉넉한 값 - 정상이면 수 초 안에 set 된다.
    if not _archive_ready.wait(timeout=60):
        return jsonify({"error": "archive photo not ready"}), 503
    if not os.path.exists(FULL_PHOTO_PATH):
        return jsonify({"error": "no photo yet"}), 404
    # 크롭 읽기 도중 백그라운드 기록이 보관본을 덮어쓰지 않게 보관본 lock 을 쓴다.
    with _archive_lock:
        with Image.open(FULL_PHOTO_PATH) as img:
            cropped = resize_to_width(crop_box2d(img, box), TRANSFER_WIDTH)
            cropped.save(CROP_PATH, "JPEG", quality=95)
    return send_file(CROP_PATH, mimetype="image/jpeg")


# 재생 중인 프로세스. /play 는 재생 완료까지 블로킹하고(앱 speakAndWait 계약),
# /play/stop 이 다른 스레드에서 이걸 죽여 barge-in(발화 중단)을 만든다.
# _play_stopped: 종료가 /play/stop 에 의한 것임을 표시 - 종료 코드로는 구분
# 불가(aplay 는 SIGTERM 에 -15 가 아니라 1 로 죽는다, 실측).
_play_proc = None
_play_stopped = False
_play_lock = threading.Lock()
# 마지막으로 받은 /play 의 req_id. 앱은 재생 1건당 고유 id 를 보낸다 - 같은
# id 가 다시 오면 응답 유실로 인한 네트워크 계층 재전송(iOS POST 재시도)이다.
# 재생하지 않고 duplicate 로 응답한다 ("문구 2번 재생" 2026-08-13 조사).
_last_play_req_id = None


def _dedup_play_req(req_id, route):
    """iOS 네트워크 스택이 응답 유실 시 POST 를 재전송한다 - 같은 req_id 의
    재생 요청 2번째는 무시 ("문구가 2번씩 나온다" 실기기 2026-08-13).
    True = 중복(재생하지 말 것)."""
    global _last_play_req_id
    with _play_lock:
        if req_id and req_id == _last_play_req_id:
            print(f"[viva-server] duplicate {route} req_id={req_id} - skipping replay")
            return True
        _last_play_req_id = req_id
    if req_id:
        print(f"[viva-server] {route} req_id={req_id}")
    return False


def _run_playback(is_mp3):
    """TTS_INPUT_PATH 를 재생하고 끝날 때까지 블로킹 (/play·/play/start 공용).
    (payload, http_status) 를 돌려준다 - 라우트가 jsonify 한다."""
    global _play_proc, _play_stopped
    if is_mp3:
        # mp3는 aplay가 못 튼다. mpg123 필요 (apt install mpg123)
        cmd = ["mpg123", "-q", "-a", PLAY_DEVICE, TTS_INPUT_PATH]
    else:
        cmd = ["aplay", "-q", "-D", PLAY_DEVICE, TTS_INPUT_PATH]

    with _play_lock:
        proc = subprocess.Popen(cmd)
        _play_proc = proc
        _play_stopped = False
    rc = proc.wait()
    with _play_lock:
        stopped = _play_stopped
        if _play_proc is proc:
            _play_proc = None

    if stopped:
        return {"status": "stopped"}, 200
    if rc != 0:
        return {"error": f"playback failed: exit {rc}"}, 500
    return {"status": "played"}, 200


def _save_upload(audio_file):
    """업로드 파일을 TTS_INPUT_PATH 에 저장하고 mp3 여부를 돌려준다."""
    global _uploaded_is_mp3
    filename = (audio_file.filename or "").lower()
    is_mp3 = filename.endswith(".mp3") or audio_file.mimetype == "audio/mpeg"
    audio_file.save(TTS_INPUT_PATH)
    _uploaded_is_mp3 = is_mp3
    return is_mp3


# /play/upload 가 저장한 파일의 포맷 - /play/start 가 쓴다. 앱은 업로드→시작을
# 순차 호출하는 단일 클라이언트라 락 없이 둔다.
# ponytail: 동시 업로드 클라이언트가 생기면 세션 토큰으로 바꾼다.
_uploaded_is_mp3 = True


@app.route("/play", methods=["POST"])
def play_audio():
    """VivaApp이 만든 TTS 오디오(mp3 또는 wav)를 받아 스피커로 재생한다.
    재생이 끝나야 응답한다 - /play/stop 으로 끊기면 status=stopped.
    구 앱 빌드용 단일 요청 경로 - 신 앱은 /play/upload + /play/start 를 쓴다."""
    audio_file = request.files.get("audio")
    if audio_file is None:
        return jsonify({"error": "missing 'audio' file field"}), 400
    if _dedup_play_req(request.form.get("req_id"), "/play"):
        return jsonify({"status": "duplicate"})
    is_mp3 = _save_upload(audio_file)
    payload, status = _run_playback(is_mp3)
    return jsonify(payload), status


@app.route("/play/upload", methods=["POST"])
def play_upload():
    """TTS 오디오 업로드만 받고 즉시 응답한다 - 재생은 /play/start 가 한다.
    앱은 이 응답을 "업로드 완료, 곧 소리 남" 신호로 써서 자막 시계를 시작한다.
    단일 /play 는 재생 종료까지 응답이 없어 앱이 XHR upload 이벤트로 업로드
    완료를 추정해야 했는데, RN 은 upload 'load' 를 안 쏘고 progress 도 실기기
    에서 신뢰가 안 됐다 - 자막이 재생 끝나고야 시작 (2026-08-20).
    같은 업로드의 재전송은 그냥 덮어쓴다(멱등) - req_id 검사는 /play/start 만."""
    audio_file = request.files.get("audio")
    if audio_file is None:
        return jsonify({"error": "missing 'audio' file field"}), 400
    _save_upload(audio_file)
    return jsonify({"status": "uploaded"})


@app.route("/play/start", methods=["POST"])
def play_start():
    """직전 /play/upload 파일을 재생한다. 재생 완료까지 블로킹 - /play 와
    같은 speakAndWait 계약. req_id 중복 방지도 동일."""
    if _dedup_play_req(request.form.get("req_id"), "/play/start"):
        return jsonify({"status": "duplicate"})
    payload, status = _run_playback(_uploaded_is_mp3)
    return jsonify(payload), status


@app.route("/play/stop", methods=["POST"])
def play_stop():
    """진행 중인 재생을 즉시 끊는다 (앱 stopSpeaking 대응)."""
    global _play_stopped
    with _play_lock:
        proc = _play_proc
        if proc is None or proc.poll() is not None:
            return jsonify({"status": "idle"})
        _play_stopped = True
        proc.terminate()
    return jsonify({"status": "stopped"})


if __name__ == "__main__":
    # threaded 필수(2026-08-13): 기본 단일 스레드에선 /play(mpg123 완료까지
    # 수 초)나 /capture/photo 처리 중 /health 가 줄 서다 5초 타임아웃 - 앱
    # ConnectionMonitor 가 connected/disconnected 를 플래핑했다. 전역 상태
    # 경합은 이미 _record_loop 스레드와 공존하던 수준(/health 주석 참조).
    app.run(host="0.0.0.0", port=5000, threaded=True)

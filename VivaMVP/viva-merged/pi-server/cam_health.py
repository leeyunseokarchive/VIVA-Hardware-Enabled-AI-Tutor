"""카메라가 붙어 있는지, 카메라를 **열지 않고** 판정한다.

능동 프로브(Picamera2() 로 열어 프레임 확인)는 쓸 수 없다. libcamera
acquire 는 프로세스 배타라, 프로비저닝(provision.py)이 QR 스캔으로 카메라를
쥔 동안 열면 서로를 죽인다 - app.py 가 카메라를 상시 쥐어 QR 스캔이 영영
안 열리던 08-12 배타 점유 버그의 재발 방지가 하드 제약이다. 그래서
Picamera2.global_camera_info() 로 열거만 한다 - acquire 없이 감지 여부만
보므로 다른 프로세스가 카메라를 쥐고 있어도 안전하다.

`cam_ok` 가 실제로 증명하는 건 "libcamera 가 카메라를 감지했다"이지
"촬영이 된다"가 아니다 - 케이블 빠짐/미장착은 잡지만, 감지는 되는데 촬영이
죽는 개체(frontend timeout 류)는 못 잡는다.
# ponytail: 존재 검사만 - 촬영 경로 고장은 app.py 촬영 실패 로그가 담당.
# 업그레이드 경로: app.py 가 마지막 촬영 성공/실패를 여기로 넘겨 합산.

audio_health.py 와 같은 이유로 app.py 에서 분리: 이 모듈은 상태(캐시)를 안
들고 있어 개발 머신에서 테스트가 돌고, eyes.py 도 같은 판정을 공유한다.
"""

# 열거(global_camera_info)는 CameraManager 기동이 껴서 공짜가 아니다 -
# Pi Zero 싱글코어에서 앱의 5초 /health 폴링마다 돌 이유가 없다. 카메라
# 착탈은 사실상 정비 이벤트라 캐시가 stale 해도 이 시간만큼만 늦게 보인다.
CAM_CACHE_S = 30.0


def _camera_info():
    from picamera2 import Picamera2  # Pi 전용 - 지연 import (개발 머신 보호)
    return Picamera2.global_camera_info()


def cam_health(now, cached, info_fn=_camera_info):
    """(cam_ok, next_cached) 를 돌려준다. cam_ok: True/False/None(판정 불가).

    호출부가 next_cached((값, 관측 시각) 튜플 또는 None)를 보관했다가 다음
    호출에 도로 넣어준다 - audio_health 처럼 이 모듈은 상태를 안 들고 있어
    테스트가 시간에 의존하지 않는다.

    프로브 예외는 None 이다, False 가 아니다 - import 실패/libcamera 오류를
    "카메라 고장"으로 오탐하면 앱 FaultBadge 와 fault 표정이 헛뜬다(스펙
    에러 처리 절). None 은 캐시하지 않는다 - 다음 호출이 재시도한다.
    """
    if cached is not None and now - cached[1] < CAM_CACHE_S:
        return cached[0], cached
    try:
        ok = len(info_fn()) > 0
    except Exception:
        return None, None
    return ok, (ok, now)

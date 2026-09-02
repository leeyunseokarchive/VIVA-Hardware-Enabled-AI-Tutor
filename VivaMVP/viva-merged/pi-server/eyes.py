#!/usr/bin/env python3
"""VIVA 눈 렌더러 - Pi 가 직접 480x480 원형 HDMI 디스플레이에 눈을 그린다.

원 설계(eyeSync.service.ts 헤더)는 별도 디스플레이 보드가 WS 서버(:8787)를
여는 구조였지만, 디스플레이가 Pi HDMI 직결로 확정되면서(D-31) 그 역할을 Pi 가
맡는다. 폰이 WS 클라이언트로 접속해 {"eyeState": "..."} JSON 을 밀어넣고,
이 프로세스는 수신 전용이다 - 응답을 보내지 않고, 비JSON/미지 상태는 무시한다.
폰은 3초 간격으로 무한 재접속하므로 이 프로세스는 언제 재시작해도 된다.

비주얼(2026-08-05 개편, docs/superpowers/specs/2026-08-05-robot-eye-visual-
upgrade-design.md, 2026-08-11 원형 조정): 제품 목업의 흰 링 눈이다 - 두꺼운 흰
원형 링 + 검정 속 + 흰 하이라이트 2개. 처음엔 라운드 사각형(알약형)이었는데
원형으로 확정했다(843aacd 이후 재조정). 예전엔 앱 EyeAnimation.tsx 의 초록
캡슐을 그대로 옮겼었다.
- idle/conversation: 사케이드(시선 이동) + 변형 블링크(단일/더블/느린) + 브리딩
- listening: 사케이드를 끄고 정면 고정 + 버스트 끄덕임(2회 뒤 2~3초 쉼)
- processing: 좌우 비대칭 + '?' 펄스. 예전엔 눈꺼풀을 내려깔았는데 "생각 중"
  보다 "졸림/못마땅"으로 읽혔다(실기기 2026-08-07)
- calling: 같은 연출에 '?' 대신 '!' (앱이 아직 안 보내는 상태지만 프로토콜에 있음)
- disconnected(무클라이언트 유예 초과): 폰+슬래시 아이콘 + "VIVA for Device
  앱과 연결이 필요합니다" 문구. 동봉 Pretendard 폰트 없으면 아이콘만
- fault(로컬 건강 이상): X-X 눈 - 마이크/스피커/카메라 하나라도 고장이면
  Pi 가 스스로 띄운다 (2026-08-13 WS2). 문구 없음 - 원인은 폰 FaultBadge 몫
- 상태 전환은 120ms 아웃 / 180ms 인 크로스페이드

눈은 매 프레임 그리지 않는다. 시작할 때 4배 해상도로 한 번 그려 축소하고
(pygame 의 draw 계열엔 안티에일리어싱이 없다) 블링크 단계·상태 변형을 전부
구워둔 뒤, 루프에서는 blit 만 한다 - 링+원을 매 프레임 그리는 것보다 싸고,
예전 캡슐 2개 draw.rect 보다도 싸다. 12MP 촬영 인코딩과 코어를 다투므로
(싱글코어 ARMv6, 2026-08-04 실측 7.6초 -> 14.5초) 이 비용이 중요하다.

출력은 SDL 디스플레이가 아니라 /dev/fb0 직접 기록(RGB565)이다 - SDL kmsdrm
경로는 이 패널에서 화면이 계속 깜빡였다(더블버퍼 강제·vsync·tty 점유 전부
무효, 실기기 2026-08-03). 콘솔(fbcon)은 안 깜빡였으므로 같은 fbdev 경로로
프레임을 통째로 써넣는다. pygame 은 그리기(도형/폰트/블렌딩)에만 쓴다
(SDL_VIDEODRIVER=dummy).

실행: systemd viva-eyes.service. 의존성: sudo apt install python3-pygame python3-websockets
개발: python3 eyes.py --window  (맥에서 창으로. 1~6 키로 상태 전환)
검증: python3 eyes.py --selftest
"""
import asyncio
import fcntl
import json
import math
import os
import random
import sys
import threading
import time

# --window 는 실제 창을 띄워야 하므로 dummy 드라이버를 걸지 않는다. pygame
# import 전에 정해져야 해서 argv 를 여기서 본다.
WINDOW = "--window" in sys.argv
if not WINDOW:
    os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
import pygame  # noqa: E402

# fbdev vsync 대기 ioctl (_IOW('F', 0x20, __u32)). 스캔아웃 도중에 프레임을
# 써넣으면 위/아래가 다른 프레임으로 섞여(테어링) 화면이 깜빡여 보인다 -
# vblank 직후에 쓰기 시작해 겹침을 최소화한다. 드라이버가 미지원이면(OSError)
# clock.tick 폴백.
FBIO_WAITFORVSYNC = 0x40044620

PORT = 8787
SIZE = 480
# 기본 30: 이 보드는 싱글코어 Pi Zero W(ARMv6, 실측 2026-08-04)라 69fps 는
# 코어의 ~45% 를 눈에만 쓴다 - 그 대가로 12MP 인코딩이 7.6초에서 14.5초로
# 늘어졌다. 30이면 블링크/브리딩이 충분히 부드럽고 촬영 경합이 준다.
# 패널 주사율(69Hz)까지 올려보려면 VIVA_EYES_FPS=69.
FPS = int(os.environ.get("VIVA_EYES_FPS", "30"))

FG = (255, 255, 255)
# 앱은 크림색 배경이지만 로봇 얼굴은 검정이 맞다는 실기기 피드백(2026-08-03) -
# 원형 패널 베젤과 이어져 화면 경계가 사라진다.
BG = (0, 0, 0)

# --- 눈 기하 상수 ------------------------------------------------------------
# 눈 모양을 손보려면 여기만 고친다 - 아래 코드는 값에 의존하지 않는다.
# 좌표는 480 패널 픽셀 그대로다(예전처럼 폰 390 논리폭에서 환산하지 않는다).
# 원형 채택(2026-08-11) - 이전 152x175 알약형(843aacd)에서 EYE_W=EYE_H 로
# 되돌려 완전한 원으로 만들었다. 하이라이트 2개는 안쪽 검정 원에서 최소 8px
# 이상 띄워 링에 닿지 않게 배치한다(check_invariants 가 대각 거리로 검사).
#
# 귀여움 보정(2026-08-11b) - "크기만 키우면 비율이 깨져 오히려 안 귀엽다":
# 눈만 키우지 않고 세 값을 같이 조정했다(네오테니 - 크고 가까운 눈 + 넓은
# 검은자 = 순함/귀여움으로 읽힌다).
# - EYE 152→164 (+8%): 크기 확대
# - RING 21→19: 얇아진 만큼 안쪽 검정(눈동자) 면적이 커져 또렷한 눈이 된다
# - GAP 60→54: 두 눈이 살짝 가까워져 표정이 더 다정하게 읽힌다
# - GLINT 반지름 소폭 확대(20→22 / 6→7): 반짝임이 커져 생기 있어 보인다
EYE_W, EYE_H, EYE_R, RING = 164, 164, 110, 19
GLINT1_R, GLINT1_X, GLINT1_Y = 22, -15, -22
GLINT2_R, GLINT2_X, GLINT2_Y = 7, 30, 26
GAP = 54
BLINK_MS = 4500   # 평균 블링크 간격. 실제는 ±1500ms 랜덤 = 3~6초
GAZE = 12         # 사케이드 가로 최대 오프셋(px). 세로는 GAZE * 2/3
BREATH = 3        # 브리딩 진폭(px)
# listening 끄덕임. 3px/1.2초 -> 7px/0.8초 -> 지금(2026-08-07 실기기 2회 피드백).
# 사람은 듣는 내내 끄덕이지 않는다 - 두어 번 까딱하고 몇 초 쉬고 또 두어 번이다.
# 연속 끄덕임은 살아있음이 아니라 진동하는 기계로 보였다. 그래서 버스트 구조다.
# 한 번의 끄덕임은 0 에서 아래로 갔다 0 으로 돌아온다(고개가 까딱하는 방향).
# 쉬는 동안의 위치와 시작/끝이 이어져야 버스트 경계에서 안 튄다.
NOD_AMP = 12          # 한 번 끄덕일 때 내려가는 깊이(px)
NOD_PERIOD = 0.55     # 끄덕임 한 번에 걸리는 시간(초)
NOD_BURST = 2         # 한 버스트당 끄덕임 횟수
NOD_GAP = (2.0, 3.0)  # 버스트 사이 쉬는 시간(초). 매번 새로 뽑아 규칙성을 없앤다
# 눈동자(흰 링 안쪽 검은 면)를 안쪽으로 미는 양(px). 가까운 사람을 볼 때 실제
# 눈이 하는 수렴(vergence)이라 "너를 보고 있다"로 읽힌다. 없으면 눈이 정면을
# 봐도 초점 없는 "동태눈"이 된다 - 그래서 listening 만이 아니라 모든 상태에
# 적용한다. 링 두께 RING=21 이 17/25 로 갈린다.
PUPIL_CONVERGE = 4

# 튜닝 노브: 특수 화면(끊김·프로비저닝·고장) 진입 페이드. effective_state 가
# 바뀌어 이 화면들에 들어온 순간부터 이만큼(초) 동안 알파를 0→1 로 올린다 -
# 급전환 대신 차분하게 뜨도록(2026-08-13 모션 보정). 크로스페이드 두 벌을
# 겹쳐 그리는 대신(싱글코어 Pi Zero 부담) 들어오는 화면 한 장의 알파만 올린다.
FADE_IN_S = 0.2

SAFE_R = SIZE / 2  # 원형 패널 반지름 - 이 밖으로 나간 픽셀은 잘린다

# --- 연결 끊김 화면 상수 -----------------------------------------------------
# 자는 눈(2026-08-10) 대신 폰 외곽선+슬래시 아이콘 + 안내 문구 (사용자 확정
# 2026-08-11: "끊겼다"를 표정 은유가 아니라 할 일 안내로 보여준다).
DC_ICON_W, DC_ICON_H, DC_ICON_R, DC_RING = 96, 150, 22, 10
DC_SLASH_PAD, DC_SLASH_W, DC_SLASH_HALO = 12, 8, 20
DC_ICON_CY = 190          # 아이콘 중심 y (원형 패널 위쪽 절반)
DC_TEXT = ("VIVA 앱과", "연결이 끊어졌어요")
DC_TEXT_SIZE, DC_TEXT_Y, DC_TEXT_LINE_H = 30, 330, 42
# 한글이 되는 폰트만 쓴다. SysFont 이름 폴백은 기본 폰트로 조용히 떨어져
# 한글이 tofu(□)로 나온다 - match_font 로 실제 파일이 있는 것만 채택하고,
# 하나도 없으면 문구 없이 아이콘만 그린다.
# 동봉 폰트(fonts/Pretendard-Regular.otf, OFL)가 1순위 - 코드 배포만으로
# 문구가 나오게. apt fonts-nanum 은 재설치 때마다 빠져서 문구가 사라졌었다
# (2026-08-12). 시스템 폰트는 동봉 파일이 지워졌을 때의 폴백.
DC_BUNDLED_FONT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               "fonts", "Pretendard-Regular.otf")
# 부호(?/!) 펄스용 볼드 - SysFont dejavusans 폴백 대신 동봉 폰트 우선.
MARK_BUNDLED_FONT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "fonts", "Pretendard-Bold.otf")
DC_FONT_NAMES = ("nanumgothic", "nanumbarungothic", "nanumsquareround",
                 "notosanscjkkr", "notosanskr", "applesdgothicneo", "malgungothic")


def _load_kr_font(size: int):
    if os.path.exists(DC_BUNDLED_FONT):
        return pygame.font.Font(DC_BUNDLED_FONT, size)
    for name in DC_FONT_NAMES:
        path = pygame.font.match_font(name)
        if path:
            return pygame.font.Font(path, size)
    # 조용히 아이콘만 그리면 "문구가 안 보인다"의 원인을 기기 앞에서 알 수
    # 없다 - journalctl 에서 바로 보이게 소리 낸다.
    print("[viva-eyes] 한글 폰트 없음 - 안내 문구 생략 (fonts/ 디렉토리 확인)")
    return None


def bake_disconnect_icon() -> pygame.Surface:
    """폰 외곽선 + 대각 슬래시 (Material mobile_cancel 계열). 눈과 같은
    4배 수퍼샘플 베이크 - 루프에서는 blit 만 한다."""
    pad = DC_SLASH_PAD
    w, h = (DC_ICON_W + 2 * pad) * SS, (DC_ICON_H + 2 * pad) * SS
    surf = pygame.Surface((w, h))
    surf.fill(BG)
    pygame.draw.rect(surf, FG, (pad * SS, pad * SS, DC_ICON_W * SS, DC_ICON_H * SS),
                     width=DC_RING * SS, border_radius=DC_ICON_R * SS)
    # 하단 홈 바 - 빈 사각형이 아니라 폰으로 읽히게 하는 최소 디테일.
    bar_w = int(DC_ICON_W * 0.34) * SS
    pygame.draw.rect(surf, FG, ((w - bar_w) // 2, (pad + DC_ICON_H - 24) * SS,
                                bar_w, 5 * SS), border_radius=2 * SS)
    # 슬래시: 배경색 헤일로를 먼저 그어 폰 라인을 "잘라내고" 그 위에 전경 선 -
    # 겹치는 자리가 분리돼 국제 관례(사선 = 없음/불가)로 읽힌다.
    pygame.draw.line(surf, BG, (0, 0), (w, h), DC_SLASH_HALO * SS)
    pygame.draw.line(surf, FG, (0, 0), (w, h), DC_SLASH_W * SS)
    return pygame.transform.smoothscale(surf, (w // SS, h // SS))


# --- 프로비저닝 화면 상수 (2026-08-11 wifi-provisioning 스펙 §1·§3) --------
# P1(provision_new): 저장된 WiFi 없음 - 즉시 QR 안내.
# P2(provision_fail): 저장된 WiFi 연결 실패 - 안내 + 재연결 터치 버튼.
# provision.py 가 로컬 WS 클라이언트로 이 상태를 밀어넣는다.
PV_NEW_TEXT = ("VIVA 앱에 표시된", "QR 코드를 보여주세요", "카메라는 헤드 하단에 있어요")
PV_FAIL_TEXT = ("WiFi 연결에 실패했어요", "VIVA 앱에 표시된", "QR 코드를 보여주세요")
PV_TEXT_SIZE, PV_TEXT_LINE_H = 24, 34
PV_ICON_CY = 150          # QR 스캔 아이콘 중심 y
PV_ICON_SIZE = 110        # 아이콘 한 변
PV_NEW_TEXT_Y = 300       # P1 문구 시작 y (2줄, 큰 아이콘)
PV_FAIL_TEXT_Y = 260      # P2 문구 시작 y (3줄 + 버튼이 아래 필요)
# 재연결 버튼은 2026-08-13 리허설 피드백으로 제거 - NM 자동연결 + 5초 폴링이
# 어차피 계속 재시도하므로 버튼은 거짓 어포던스였다. 상태 문구만 남긴다.
PV_STATUS_TEXT = "재연결 시도 중…"
PV_STATUS_SIZE, PV_STATUS_Y = 16, 400          # 문구 아래 여백 중앙 - chord 안에 든다

# --- 곤란(fault) 화면 상수 (2026-08-13 device-todo WS2) ----------------------
# 마이크/스피커/카메라 중 하나라도 확실히 고장이면 X-X 눈. 어느 기능이
# 죽었는지는 폰 FaultBadge 가 담당한다 - 로봇은 문구 없이 표정만.
FAULT_MARGIN = 28       # 눈 상자 가장자리에서 X 획 끝(캡 중심)까지 여백(px)


def bake_scan_icon() -> pygame.Surface:
    """QR 스캔 아이콘 - 네 모서리 브래킷 + 중앙 QR 축약(파인더 3개).
    disconnect 아이콘과 같은 4배 수퍼샘플 베이크."""
    s = PV_ICON_SIZE * SS
    surf = pygame.Surface((s, s))
    surf.fill(BG)
    b, t = int(s * 0.24), 6 * SS  # 브래킷 길이·두께
    for x0, y0, dx, dy in ((0, 0, 1, 1), (s, 0, -1, 1), (0, s, 1, -1), (s, s, -1, -1)):
        pygame.draw.line(surf, FG, (x0, y0 + dy * (t // 2)), (x0 + dx * b, y0 + dy * (t // 2)), t)
        pygame.draw.line(surf, FG, (x0 + dx * (t // 2), y0), (x0 + dx * (t // 2), y0 + dy * b), t)
    # 중앙 QR 축약: 파인더 3개 + 점 하나
    q = int(s * 0.42)
    qx, qy = (s - q) // 2, (s - q) // 2
    f = int(q * 0.38)
    for fx, fy in ((qx, qy), (qx + q - f, qy), (qx, qy + q - f)):
        pygame.draw.rect(surf, FG, (fx, fy, f, f), width=3 * SS)
        pygame.draw.rect(surf, FG, (fx + f // 3, fy + f // 3, f // 3, f // 3))
    pygame.draw.rect(surf, FG, (qx + q - f // 2, qy + q - f // 2, f // 3, f // 3))
    return pygame.transform.smoothscale(surf, (s // SS, s // SS))


def bake_fault_eye() -> pygame.Surface:
    """X 눈 한 쪽 - 만화 관례(기절/고장)의 X. 직사각형 막대 2개를 직교로
    겹친 형태(각진 끝, 2026-08-13 실기기 피드백: 원형 캡 버전이 안 귀엽다).
    획 두께는 링과 동일(RING)·흰색. 눈과 같은 4배 수퍼샘플 베이크 -
    루프에서는 blit 만 한다.
    # ponytail: 정적 X - 비대칭/스프링 연출은 복잡도 대비 이득이 없어 뺐다.
    # 살아있는 느낌은 disconnect 아이콘과 같은 알파 호흡 펄스가 담당한다."""
    w, h = EYE_W * SS, EYE_H * SS
    surf = pygame.Surface((w, h))
    surf.fill(BG)
    m, t = FAULT_MARGIN * SS, RING * SS
    # 대각선(모서리 여백 m 기준) 길이의 막대를 ±45° 로 돌려 겹친다.
    bar_len = int((w - 2 * m) * math.sqrt(2))
    bar = pygame.Surface((bar_len, t), pygame.SRCALPHA)
    bar.fill(FG)
    for angle in (45, -45):
        rotated = pygame.transform.rotate(bar, angle)
        surf.blit(rotated, rotated.get_rect(center=(w // 2, h // 2)))
    return pygame.transform.smoothscale(surf, (EYE_W, EYE_H))


VALID_STATES = {"idle", "calling", "processing", "conversation", "listening"}
# provision.py(로컬 WS 클라이언트)만 보내는 상태 - 폰 앱은 모른다.
PROVISION_STATES = {"provision_new", "provision_fail"}
# 우상단에 부호를 띄우는 상태. 눈 연출(좌우 비대칭 + 진입 스프링)은 같고
# 글자만 다르다 - '!' 는 불렸다, '?' 는 생각 중.
MARKS = {"calling": "!", "processing": "?"}
KEY_STATES = {  # --window 모드 전용
    pygame.K_1: "idle",
    pygame.K_2: "calling",
    pygame.K_3: "processing",
    pygame.K_4: "conversation",
    pygame.K_5: "listening",
    pygame.K_6: "disconnected",
    pygame.K_7: "provision_new",
    pygame.K_8: "provision_fail",
    pygame.K_9: "fault",
}

# WS 스레드가 쓰고 렌더 루프가 읽는다 - 단일 str 대입이라 락 불필요(GIL).
_state = {"eye": "idle"}
# 접속 중인 폰. 마지막 하나가 나가면 표정을 idle 로 되돌린다 (_handler 참고).
# WS 스레드의 단일 asyncio 루프 안에서만 건드리므로 락 불필요.
_clients = set()

# 앱 WS 가 하나도 안 붙은 채 이 시간이 지나면 스스로 '연결 끊김' 화면을
# 띄운다 (2026-08-10 역할 분리 스펙). 유예를 두는 이유: 폰 화면 잠깐 꺼짐/
# 앱 전환으로 WS 가 수 초 끊길 때마다 화면이 요동치면 안 된다.
# "마지막 클라이언트가 나가면 idle 리셋"(2026-08-07)의 확장이다 - 앱이 죽어
# 못 보내는 상황은 보드가 스스로 판단할 수밖에 없다.
# 30→12 (2026-08-11 끊김 전파 개편): 앱이 /health 실패로 disconnected 판정을
# 내리면 눈 WS 를 의도적으로 닫는다(connectionMonitor). 그 뒤 이 유예만큼만
# 기다리면 되므로 30초는 과했다 - 폰의 3초 재접속 주기는 12초로도 넉넉히
# 커버한다. keepalive(ping 10s)와 합쳐 최악 폰 증발 시 ~30초 안에 뜬다.
DISCONNECT_GRACE_S = 12.0
# None = 클라이언트 있음. 값 = 비어있기 시작한 monotonic 시각.
# 부팅 직후부터 카운트를 시작한다 - 폰이 한 번도 안 붙었어도 30초 뒤 '끊김'
# 이 맞다 (연결된 적 없음 == 연결 안 됨).
_clients_empty_since = {"t": time.monotonic()}

# 로컬 하드웨어 건강. _health_thread(Pi 전용)가 쓰고 렌더 루프가 읽는다 -
# 단일 bool 대입이라 락 불필요(GIL). 하나라도 **확실히 False** 일 때만 bad -
# None(판정 불가)은 정상 취급이다(오탐 배지/표정 방지, 스펙 에러 처리 절).
_health = {"bad": False}
HEALTH_POLL_S = 5.0  # 앱의 /health 폴링과 같은 호흡


def _health_thread():
    """마이크/스피커/카메라 로컬 판정 - 앱 왕복 없이 스스로 fault 전환하기
    위한 폴링. audio_health/cam_health 는 상태를 안 들고 있어 여기가 보관한다.
    recording 은 False 고정 - app.py 의 녹음 중엔 arecord 가 캡처 서브스트림을
    쥐고 있어 substream_open 이 어차피 True 다."""
    from audio_health import audio_health
    from cam_health import cam_health
    card_dir = "/proc/asound/card" + os.environ.get("VIVA_SOUND_CARD", "0")
    # 부팅 직후 오탐 방지: last_capture_open 을 지금으로 시드한다 - 폰이 아직
    # wake 를 구독하기 전이라 캡처가 닫혀 있는 건 고장이 아니다
    # (audio_health.py 헤더의 ponytail 천장, 업그레이드 경로 (a)).
    last_open = time.time()
    cam_cached = None
    # 연속 2틱 이상 나쁠 때만 fault 로 인정한다. 부팅 직후(무음 유지 서비스
    # 기동 전 재생 substream 닫힘)와 폰 연결 직후(wake resume 전 캡처 닫힘 -
    # audio_health 헤더의 ponytail 천장)는 한 틱짜리 오탐이라 X-X 눈이
    # 깜빡였다가 idle 로 돌아가는 게 보였다 (실기기 2026-08-13). 복구는
    # 즉시(streak 리셋), 실제 고장 표시는 한 틱(5초) 늦어질 뿐이다.
    bad_streak = 0
    while True:
        mic, spk, last_open = audio_health(card_dir, False, time.time(), last_open)
        cam, cam_cached = cam_health(time.monotonic(), cam_cached)
        bad = (mic is False) or (spk is False) or (cam is False)
        bad_streak = bad_streak + 1 if bad else 0
        _health["bad"] = bad_streak >= 2
        time.sleep(HEALTH_POLL_S)


def effective_state(now: float) -> str:
    """렌더 루프가 실제로 그릴 상태. 우선순위: provision > disconnected >
    fault > 폰이 보낸 상태. provision 은 안내가 우선이라(fault 가 가리면
    QR 을 못 찍는다) fault 로 덮지 않는다. fault 는 홈(idle) 화면일 때만 -
    세션 중(conversation/listening 등)엔 wake 스트림이 일시정지되고 마이크
    캡처는 /record 도중만 열려서 audio_health 의 10초 sticky 창이 답변
    중간에 만료돼 오탐하기 때문에(FaultBadge 도 홈 전용 의미론), idle 이
    아니면 mic 판정을 무시한다."""
    empty_t = _clients_empty_since["t"]
    if empty_t is not None and now - empty_t >= DISCONNECT_GRACE_S:
        return "disconnected"
    state = _state["eye"]
    if _health["bad"] and empty_t is None and state == "idle":
        return "fault"
    return state


def check_invariants():
    """잘못된 상수로 구워놓고 화면이 깨진 채 도는 것보다 시작 시 죽는 게 낫다."""
    assert RING * 2 < min(EYE_W, EYE_H), "링이 눈보다 두껍다"
    half = (GAP + EYE_W * 1.12) / 2 + EYE_W * 1.12 / 2  # calling 이 가장 넓다
    assert math.hypot(half, EYE_H * 1.12 / 2) <= SAFE_R, "눈이 패널 밖으로 나간다"
    # 눈동자를 밀어도 하이라이트는 제자리다(광원 고정) - 너무 밀면 링에 걸린다.
    # inner_r 은 bake_base 의 안쪽 원 반지름과 동일한 식이어야 한다 - x축만
    # 보는 상자 검사는 원형 눈에서 대각 방향 하이라이트를 놓친다.
    iw, ih = EYE_W - 2 * RING, EYE_H - 2 * RING
    inner_r = min(max(0, EYE_R - RING), min(iw, ih) // 2)
    for gx, gy, gr in ((GLINT1_X, GLINT1_Y, GLINT1_R), (GLINT2_X, GLINT2_Y, GLINT2_R)):
        assert math.hypot(gx, gy) + gr + PUPIL_CONVERGE <= inner_r, \
            "하이라이트가 링에 닿거나 걸친다"
    # X 눈: 획 끝 캡(반지름 RING/2)이 눈 상자 안에 들고, X 가 눈보다 작아야 한다.
    assert RING // 2 <= FAULT_MARGIN < min(EYE_W, EYE_H) // 2, "X 눈 여백이 어긋난다"


# --- WS 수신 (별도 스레드의 asyncio 루프) -----------------------------------

async def _handler(ws):
    _clients.add(ws)
    _clients_empty_since["t"] = None
    try:
        async for msg in ws:
            try:
                data = json.loads(msg)
            except (ValueError, TypeError):
                continue
            eye = data.get("eyeState")
            if eye in (VALID_STATES | PROVISION_STATES) and eye != _state["eye"]:
                print(f"[viva-eyes] state: {_state['eye']} -> {eye}")
                _state["eye"] = eye
    finally:
        # 마지막 폰이 나가면 idle 로 되돌린다 (2026-08-07 실기기 피드백:
        # "한참 안 부르면 디스플레이가 processing 표정으로 굳어 있다").
        # 폰 화면이 꺼지거나 앱이 백그라운드로 가면 WS 가 끊기는데, 예전엔
        # 끊김 처리가 아예 없어서 _state 가 마지막 수신값에 영구 고정됐다 -
        # 마이크가 열린 채(=보드 기준 'processing') 끊기면 아무도 안 보고
        # 있는데 로봇만 계속 학생 말을 기다리는 얼굴로 남는다.
        # 앱이 백그라운드 진입 시 idle 을 보내는 방법도 있지만 그때는 소켓이
        # 이미 죽었을 수 있어 신뢰할 수 없다 - 보드가 스스로 판단한다.
        _clients.discard(ws)
        if not _clients:
            _clients_empty_since["t"] = time.monotonic()
            if _state["eye"] != "idle":
                print(f"[viva-eyes] no clients: {_state['eye']} -> idle")
                _state["eye"] = "idle"


async def _serve():
    import websockets
    # ping 10s/timeout 10s (기본 20/20): 폰이 인사 없이 증발하면(와이파이 뚝,
    # 앱 강제종료) TCP half-open 으로 _handler 가 영원히 기다린다 - keepalive
    # 실패가 소켓을 닫아줘야 무클라이언트 판정이 시작된다. 기본값은 감지까지
    # 최대 40초라 유예(12s)와 합치면 체감이 너무 늦었다.
    async with websockets.serve(_handler, "0.0.0.0", PORT,
                                ping_interval=10, ping_timeout=10):
        print(f"[viva-eyes] ws listening on :{PORT}")
        await asyncio.Future()


def _ws_thread():
    try:
        asyncio.run(_serve())
    except ImportError:
        # 개발 머신에 websockets 가 없을 수 있다. 창 모드는 키보드로 상태를
        # 바꾸므로 WS 없이도 쓸 수 있다 - 눈은 계속 돈다.
        print("[viva-eyes] websockets 미설치 - WS 수신 비활성")


# --- 애니메이션 헬퍼 ---------------------------------------------------------

def ease(t: float) -> float:
    """cubic in-out - 앱의 Easing.inOut(Easing.ease) 근사."""
    t = max(0.0, min(1.0, t))
    return 4 * t * t * t if t < 0.5 else 1 - ((-2 * t + 2) ** 3) / 2


def tri(phase: float) -> float:
    """0~1 왕복 삼각파. phase 는 주기 단위(1.0 = 한 왕복)."""
    p = phase % 1.0
    return p * 2 if p < 0.5 else 2 - p * 2


# --- 스프라이트 베이크 -------------------------------------------------------

SS = 4  # 수퍼샘플 배율. pygame.draw 엔 AA 가 없어서 크게 그린 뒤 축소한다
BLINK_N = 12
# 감았을 때 남는 높이 비율. 링 눈은 캡슐과 달리 세로로 눌러도 흰-검-흰 줄이
# 남아서, 0.06(9px)이면 "덜 감긴" 걸로 읽혔다(2026-08-05 시안 피드백).
# 0 으로 두면 눈이 완전히 사라져 전원이 꺼진 것처럼 보인다 - 얇은 선은 남긴다.
BLINK_MIN = 0.02
# 1.0(완전히 뜬 눈) -> BLINK_MIN(감은 눈) 을 균등 분할한 높이 비율
BLINK_LEVELS = [1.0 - i * (1.0 - BLINK_MIN) / (BLINK_N - 1) for i in range(BLINK_N)]

# 상태별 눈 크기 배율. 블링크가 도는 것은 BLINKING 에 든 것뿐이다.
VARIANTS = {
    "normal": (1.00, 1.00),   # idle
    "wide": (1.05, 1.05),     # conversation - 살짝 크게 뜨고 주시
    "call_l": (1.12, 1.12),   # calling 왼눈
    "call_r": (0.90, 0.90),   # calling 오른눈
}
BLINKING = ("normal", "wide")


def _blink_index(scale_y: float) -> int:
    i = int(round((1.0 - scale_y) / (1.0 - BLINK_MIN) * (BLINK_N - 1)))
    return max(0, min(BLINK_N - 1, i))


def bake_base(pupil_dx: float = 0.0) -> pygame.Surface:
    """눈 한 쪽을 SS 배로 그린 뒤 원본 크기로 축소한 AA 서피스.

    알파를 쓰지 않는다 - 눈 속과 라운드 사각형 바깥 모서리가 둘 다 배경색
    (검정)이라 불투명 서피스로 충분하고, 불투명 blit 이 더 싸다.

    pupil_dx 는 눈동자(안쪽 검은 면)를 가로로 미는 양이다. 링 두께가 좌우로
    갈리면서 시선 방향이 생긴다 - listening 의 수렴(vergence)에 쓴다.
    하이라이트는 같이 옮기지 않는다: 광원은 눈이 움직여도 그 자리에 있다.
    """
    w, h = EYE_W * SS, EYE_H * SS
    # EYE_R 이 절반을 넘으면 알약 모양이 된다 - CSS border-radius 도 pygame 도
    # 자동으로 클램프하지만, 안쪽 사각형과 계산을 맞추려면 여기서 명시한다.
    outer_r = min(EYE_R, min(EYE_W, EYE_H) // 2) * SS
    iw, ih = w - 2 * RING * SS, h - 2 * RING * SS
    inner_r = min(max(0, (EYE_R - RING) * SS), min(iw, ih) // 2)
    surf = pygame.Surface((w, h))
    surf.fill(BG)
    pygame.draw.rect(surf, FG, (0, 0, w, h), border_radius=outer_r)
    pygame.draw.rect(surf, BG, ((RING + pupil_dx) * SS, RING * SS, iw, ih),
                     border_radius=inner_r)
    cx, cy = w / 2, h / 2
    pygame.draw.circle(surf, FG, (cx + GLINT1_X * SS, cy + GLINT1_Y * SS), GLINT1_R * SS)
    pygame.draw.circle(surf, FG, (cx + GLINT2_X * SS, cy + GLINT2_Y * SS), GLINT2_R * SS)
    return pygame.transform.smoothscale(surf, (EYE_W, EYE_H))


class EyeSprites:
    """시작 시 (상태 변형 x 블링크 단계) 를 전부 구워두는 캐시.

    변형도 블링크도 베이스를 세로/가로로 줄인 것뿐이라 smoothscale 한 방이면
    된다 - 기하를 다시 그리지 않는다. 축소는 시작 시 수십 회로 끝나고 루프엔
    없다.
    """

    def __init__(self):
        # 좌/우 두 벌이다 - 눈동자가 서로 안쪽을 향하므로 링 두께가 갈리고,
        # 그건 스케일로 못 만들어서 베이스부터 다시 그려야 한다.
        self.frames = {}
        for side in (-1, 1):
            base = bake_base(-side * PUPIL_CONVERGE)
            self.frames[side] = {
                name: [
                    pygame.transform.smoothscale(base, (
                        max(1, int(round(EYE_W * sx))),
                        max(1, int(round(EYE_H * sy * lv)))))
                    for lv in (BLINK_LEVELS if name in BLINKING else BLINK_LEVELS[:1])
                ]
                for name, (sx, sy) in VARIANTS.items()
            }

    def get(self, variant: str, scale_y: float = 1.0, side: int = -1) -> pygame.Surface:
        frames = self.frames[side][variant]
        return frames[_blink_index(scale_y)] if len(frames) > 1 else frames[0]


# --- 눈 동작 -----------------------------------------------------------------

_SINGLE = ((0.0, 1.0), (0.15, BLINK_MIN), (0.30, 1.0))
_DOUBLE = _SINGLE + ((0.39, 1.0), (0.54, BLINK_MIN), (0.69, 1.0))
_LONG = ((0.0, 1.0), (0.18, BLINK_MIN), (0.30, BLINK_MIN), (0.52, 1.0))


def _sample(keyframes, t: float):
    """키프레임 사이를 ease 보간. 마지막 키프레임을 지나면 None(끝)."""
    if t >= keyframes[-1][0]:
        return None
    for (t0, v0), (t1, v1) in zip(keyframes, keyframes[1:]):
        if t < t1:
            if t1 <= t0:
                return v1
            return v0 + (v1 - v0) * ease((t - t0) / (t1 - t0))
    return None


class Blinker:
    """BLINK_MS±1500ms 마다 단일(70%)/더블(20%)/느린 긴 것(10%) 중 하나."""

    def __init__(self):
        self.next_at = None
        self.keyframes = None
        self.started = 0.0

    def _schedule(self, now: float) -> None:
        self.next_at = now + BLINK_MS / 1000.0 + random.uniform(-1.5, 1.5)

    def scale_y(self, now: float) -> float:
        if self.next_at is None:
            self._schedule(now)
        if self.keyframes is None:
            if now < self.next_at:
                return 1.0
            r = random.random()
            self.keyframes = _SINGLE if r < 0.7 else (_DOUBLE if r < 0.9 else _LONG)
            self.started = now
        value = _sample(self.keyframes, now - self.started)
        if value is None:
            self.keyframes = None
            self._schedule(now)
            return 1.0
        return value


class Gaze:
    """사케이드 - 가끔 목표 지점을 새로 뽑고 MOVE 초 동안 ease 로 옮긴다.

    링 안에서 동공만 따로 굴리려면 눈을 다층으로 매 프레임 합성해야 한다.
    대신 눈 전체를 몇 px 평행이동한다 - 두 눈이 같은 오프셋이라 시선이
    수렴해 보이고, 비용은 blit 좌표 두 개다.
    """

    MOVE = 0.18

    def __init__(self):
        self.cur = (0.0, 0.0)
        self.frm = (0.0, 0.0)
        self.to = (0.0, 0.0)
        self.started = 0.0
        self.next_at = None

    def offset(self, now: float, rx: float, ry: float, interval):
        if self.next_at is None:
            self.next_at = now + random.uniform(*interval)
        if now >= self.next_at:
            self.frm = self.cur
            self.to = (random.uniform(-rx, rx), random.uniform(-ry, ry))
            self.started = now
            self.next_at = now + self.MOVE + random.uniform(*interval)
        t = (now - self.started) / self.MOVE
        if t >= 1.0:
            self.cur = self.to
        else:
            e = ease(t)
            self.cur = (self.frm[0] + (self.to[0] - self.frm[0]) * e,
                        self.frm[1] + (self.to[1] - self.frm[1]) * e)
        return self.cur


class Nodder:
    """듣는 사람의 끄덕임은 연속이 아니라 버스트다 - 두어 번 까딱하고 몇 초
    쉬고 또 두어 번. 계속 끄덕이면 사람이 아니라 진동하는 기계로 보인다.

    반환값은 0(쉬는 중) 또는 0~NOD_AMP(내려간 깊이)다. 한 번의 끄덕임이 0 에서
    시작해 0 으로 끝나므로 버스트 경계에서 위치가 튀지 않는다.
    """

    def __init__(self):
        self.started = 0.0
        self.gap = NOD_GAP[0]

    def reset(self, now: float) -> None:
        """listening 진입 시 호출 - 기다리지 않고 바로 한 버스트를 시작한다."""
        self.started = now
        self.gap = random.uniform(*NOD_GAP)

    def offset(self, now: float) -> float:
        t = now - self.started
        burst = NOD_BURST * NOD_PERIOD
        if t < burst:
            return NOD_AMP * ease(tri(t / NOD_PERIOD))
        if t >= burst + self.gap:
            self.reset(now)  # 쉬는 시간은 매번 새로 뽑는다
        return 0.0


# --- 상태별 렌더 -------------------------------------------------------------

class Renderer:
    def __init__(self):
        self.sprites = EyeSprites()
        self.blinker = Blinker()
        self.gaze = Gaze()
        self.nodder = Nodder()
        self.mark = None    # 지금 띄우고 있는 부호('!'/'?'), 없으면 None
        self.mark_at = 0.0  # 그 부호에 진입한 시각 (스프링 연출 기준점)
        self.nodding = False  # listening 진입 엣지 감지
        self._last_state = None    # 진입 페이드 기준 - effective_state 변경 감지용
        self.state_since = 0.0     # 마지막 상태 변경 monotonic 시각
        self._fonts = {}  # size -> Font. SysFont 는 매 프레임 만들기엔 비싸다
        # 연결 끊김 화면 - 아이콘·문구 모두 시작 시 한 번만 굽는다.
        self.dc_icon = bake_disconnect_icon()
        # 곤란(X-X) 눈 - 역시 시작 시 한 번만 굽는다.
        self.fault_eye = bake_fault_eye()
        kr_font = _load_kr_font(DC_TEXT_SIZE)
        self.dc_lines = [kr_font.render(t, True, FG) for t in DC_TEXT] if kr_font else []
        # 프로비저닝 화면 - 역시 시작 시 한 번만 굽는다.
        self.pv_icon = bake_scan_icon()
        pv_font = _load_kr_font(PV_TEXT_SIZE)
        self.pv_new_lines = [pv_font.render(t, True, FG) for t in PV_NEW_TEXT] if pv_font else []
        self.pv_fail_lines = [pv_font.render(t, True, FG) for t in PV_FAIL_TEXT] if pv_font else []
        st_font = _load_kr_font(PV_STATUS_SIZE)
        self.pv_status = st_font.render(PV_STATUS_TEXT, True, FG) if st_font else None

    def draw(self, surface, state: str, now: float):
        # 진입 페이드 기준시각 - effective_state 가 바뀐 프레임에 갱신한다.
        # 여기 한 곳에서만 하므로 모든 특수 화면 분기가 같은 시계를 쓴다.
        if state != self._last_state:
            self._last_state = state
            self.state_since = now
        enter = ease(min(1.0, (now - self.state_since) / FADE_IN_S))

        surface.fill(BG)
        cx, cy = SIZE / 2, SIZE / 2

        if state in ("provision_new", "provision_fail"):
            self.mark = None
            self.nodding = False
            # 스캔 아이콘은 disconnect 아이콘과 같은 호흡 펄스 x 진입 페이드
            self.pv_icon.set_alpha(int(255 * (0.72 + 0.28 * ease(tri(now / 4.0))) * enter))
            surface.blit(self.pv_icon, self.pv_icon.get_rect(center=(cx, PV_ICON_CY)))
            lines = self.pv_new_lines if state == "provision_new" else self.pv_fail_lines
            text_y = PV_NEW_TEXT_Y if state == "provision_new" else PV_FAIL_TEXT_Y
            for i, line in enumerate(lines):
                line.set_alpha(int(255 * enter))
                surface.blit(line, line.get_rect(center=(cx, text_y + i * PV_TEXT_LINE_H)))
            if state == "provision_fail" and self.pv_status:
                # 상태 문구만 - 자동 재시도(5초 폴링 + NM 자동연결)가 도는 중임을
                # 스캔 아이콘과 같은 호흡 펄스로 알린다 (버튼 제거, 2026-08-13).
                self.pv_status.set_alpha(int(255 * (0.45 + 0.20 * ease(tri(now / 4.0))) * enter))
                surface.blit(self.pv_status, self.pv_status.get_rect(center=(cx, PV_STATUS_Y)))
            return

        # 연결 끊김: 폰+슬래시 아이콘 + "앱과 연결이 필요합니다" (2026-08-11,
        # 자는 눈 대체 - 표정 은유 대신 할 일 안내). 아이콘만 느린 알파 펄스로
        # 숨쉬어 꺼진 화면이 아니라 기다리는 중으로 읽힌다. 문구는 가독성
        # 우선이라 고정. 앱이 재접속해 상태를 보내면 크로스페이드로 자연 복귀.
        if state == "disconnected":
            self.mark = None
            self.nodding = False
            self.dc_icon.set_alpha(int(255 * (0.72 + 0.28 * ease(tri(now / 4.0))) * enter))
            surface.blit(self.dc_icon, self.dc_icon.get_rect(center=(cx, DC_ICON_CY)))
            for i, line in enumerate(self.dc_lines):
                line.set_alpha(int(255 * enter))
                surface.blit(line, line.get_rect(center=(cx, DC_TEXT_Y + i * DC_TEXT_LINE_H)))
            return

        # 곤란(X-X): 마이크/스피커/카메라 로컬 고장 (effective_state 가 판정).
        # 문구 없이 눈만 X - 어느 기능인지는 폰 FaultBadge 몫이다. disconnect
        # 아이콘과 같은 호흡 펄스로 "꺼짐"이 아니라 "살아있는데 아픈"으로 읽힌다.
        if state == "fault":
            self.mark = None
            self.nodding = False
            self.fault_eye.set_alpha(int(255 * (0.72 + 0.28 * ease(tri(now / 4.0))) * enter))
            for side in (-1, 1):
                surface.blit(self.fault_eye, self.fault_eye.get_rect(
                    center=(cx + side * (GAP + EYE_W) / 2, cy)))
            return

        # listening 진입 엣지에서만 끄덕임을 리셋한다 - 매 프레임 리셋하면
        # 버스트가 영원히 첫 프레임에 머문다. calling/processing 경유로
        # 되돌아와도 다시 걸리도록 여기(모든 상태가 지나가는 지점)에 둔다.
        if state == "listening":
            if not self.nodding:
                self.nodding = True
                self.nodder.reset(now)
        else:
            self.nodding = False

        # 부호를 띄우는 두 상태. 눈은 좌우 비대칭 + 진입 스프링으로 같고
        # 글자만 다르다. processing 은 예전엔 눈꺼풀을 내려깔았는데 "생각 중"
        # 보다 "졸림/못마땅"으로 읽혔다(실기기 2026-08-07) - '?' 는 안 헷갈린다.
        mark = MARKS.get(state)
        if mark:
            if self.mark != mark:
                self.mark = mark
                self.mark_at = now
            self._draw_mark(surface, cx, cy, now - self.mark_at, mark)
            return
        self.mark = None

        listening = state == "listening"
        conversing = state == "conversation" or listening
        variant = "wide" if conversing else "normal"
        blink = self.blinker.scale_y(now)
        # 대화 중엔 시선 폭 절반 / 빈도 2배 - 사람을 주시하는 느낌
        k = 0.5 if conversing else 1.0
        interval = (0.75, 2.0) if conversing else (1.5, 4.0)
        dx, dy = self.gaze.offset(now, GAZE * k, GAZE * 2 / 3 * k, interval)
        breathe = BREATH * ease(tri(now / 3.6))  # 1.8s 내려갔다 1.8s 복귀
        if listening:
            # 듣는 중: 시선을 정면에 고정하고(사케이드 off) 버스트로
            # 끄덕인다. 주된 메시지는 "너를 보고 있다" 쪽이다.
            dx = 0.0
            dy = 0.0
            breathe += self.nodder.offset(now)

        eye_w = EYE_W * VARIANTS[variant][0]
        for side in (-1, 1):
            sprite = self.sprites.get(variant, blink, side)
            center = (cx + side * (GAP + eye_w) / 2 + dx, cy + dy + breathe)
            surface.blit(sprite, sprite.get_rect(center=center))

    def _draw_mark(self, surface, cx, cy, t: float, mark: str):
        """좌우 비대칭 눈 + 우상단 부호. t 는 이 상태에 들어온 뒤의 경과 시간."""
        # 앱의 spring(friction 4) 근사: 감쇠 진동으로 1.0 에 수렴
        wobble = math.exp(-t * 6.0) * math.cos(t * 14.0)
        lw, lh = EYE_W * 1.12, EYE_H * 1.12
        rw, rh = EYE_W * 0.90, EYE_H * 0.90
        left = self.sprites.get("call_l", side=-1)
        right = self.sprites.get("call_r", side=1)
        if abs(wobble) > 0.005:
            # 진동이 살아있는 ~0.8초만 실시간 축소. 그 뒤엔 구워둔 걸 그대로
            # 쓴다 - 상시 smoothscale 은 이 코어에서 감당하기 아깝다.
            sl, sr = 1.0 - 0.1 * wobble, 1.0 + 0.1 * wobble
            left = pygame.transform.smoothscale(
                left, (max(1, int(lw * sl)), max(1, int(lh * sl))))
            right = pygame.transform.smoothscale(
                right, (max(1, int(rw * sr)), max(1, int(rh * sr))))
        surface.blit(left, left.get_rect(center=(cx - (GAP + lw) / 2, cy)))
        surface.blit(right, right.get_rect(center=(cx + (GAP + rw) / 2, cy)))

        # 부호 펄스 (0.8s 왕복, scale 1→1.08) - 오른눈 우상단. 눈 크기에 비례해
        # 잡는다 - 고정값으로 두면 눈을 키웠을 때 원형 패널 밖으로 밀려난다
        # (selftest 의 패널 원 이탈 검사가 잡는다).
        size = int(EYE_H * 0.48 * (1.0 + 0.08 * ease(tri(t / 1.6))))
        font = self._fonts.get(size)
        if font is None:
            try:
                if os.path.exists(MARK_BUNDLED_FONT):
                    font = pygame.font.Font(MARK_BUNDLED_FONT, size)
                else:
                    font = pygame.font.SysFont("dejavusans", size, bold=True)
            except Exception:  # 폰트가 없어도 눈은 계속 그린다
                font = False
            self._fonts[size] = font
        if font:
            glyph = font.render(mark, True, FG)
            surface.blit(glyph, glyph.get_rect(
                center=(cx + GAP / 2 + rw * 0.75, cy - lh / 2 - EYE_H * 0.14)))


# --- 셀프테스트 --------------------------------------------------------------

def selftest():
    pygame.init()
    check_invariants()

    sprites = EyeSprites()
    for side in (-1, 1):
        for name in VARIANTS:
            expect = BLINK_N if name in BLINKING else 1
            assert len(sprites.frames[side][name]) == expect, f"{name}[{side}] 프레임 수"
    assert sprites.get("normal", 1.0).get_height() > sprites.get("normal", BLINK_MIN).get_height(), \
        "블링크 단계가 단조 감소하지 않는다"

    blinker, gaze = Blinker(), Gaze()
    closed_seen = False
    for i in range(60 * FPS):  # 60초치 가상 시간
        now = i / FPS
        s = blinker.scale_y(now)
        assert BLINK_MIN <= s <= 1.0, f"블링크 범위 이탈: {s}"
        closed_seen = closed_seen or s < 0.5
        dx, dy = gaze.offset(now, GAZE, GAZE * 2 / 3, (1.5, 4.0))
        assert abs(dx) <= GAZE + 1e-9 and abs(dy) <= GAZE * 2 / 3 + 1e-9, \
            f"사케이드 범위 이탈: {dx},{dy}"
    assert closed_seen, "60초 동안 블링크가 한 번도 안 일어났다"
    assert blinker.scale_y(60 * 60.0) == 1.0, "블링크 후 1.0 복귀 실패"

    renderer = Renderer()
    surface = pygame.Surface((SIZE, SIZE))

    # 진입 페이드(FADE_IN_S=0.2) 때문에 상태 변경 직후 프레임은 거의 안
    # 보인다 - 아래 "비어 있지 않다" 검사들은 전부 페이드가 끝난 시점을 봐야
    # 하므로, 프라이밍 draw(같은 now=0.0 에서 상태 진입) 뒤 충분히 지난
    # now=1.0 에서 다시 그린다.
    FADE_SETTLED = 1.0

    # 연결 끊김 화면: 아이콘은 항상 있고, 문구는 한글 폰트가 있는 머신에서만
    # (개발 맥은 applesdgothicneo, Pi 는 fonts-nanum). 프레임이 비면 안 된다.
    renderer.draw(surface, "disconnected", 0.0)
    renderer.draw(surface, "disconnected", FADE_SETTLED)
    surface.set_colorkey(BG)
    assert surface.get_bounding_rect().width > 0, "disconnected 화면이 비어 있다"
    surface.set_colorkey(None)
    if not renderer.dc_lines:
        print("[viva-eyes] selftest: 한글 폰트 없음 - disconnected 문구 생략 확인")

    for pv in ("provision_new", "provision_fail"):
        renderer.draw(surface, pv, 0.0)
        renderer.draw(surface, pv, FADE_SETTLED)
        surface.set_colorkey(BG)
        assert surface.get_bounding_rect().width > 0, f"{pv} 화면이 비어 있다"
        surface.set_colorkey(None)

    # 곤란(X-X) 화면: 비어 있지 않고, 일반 눈과 다르게 그려져야 한다 -
    # fault 분기가 빠지면 일반 눈 경로로 떨어져 idle 과 같은 프레임이 나온다.
    renderer.draw(surface, "fault", 0.0)
    renderer.draw(surface, "fault", FADE_SETTLED)
    surface.set_colorkey(BG)
    assert surface.get_bounding_rect().width > 0, "fault 화면이 비어 있다"
    surface.set_colorkey(None)
    fault_raw = pygame.image.tostring(surface, "RGB")
    renderer.draw(surface, "idle", 0.0)
    assert pygame.image.tostring(surface, "RGB") != fault_raw, "fault 가 일반 눈과 같다"

    # 특수 화면 진입 페이드(2026-08-13 모션 보정): 상태 전환 순간(enter=0)과
    # 페이드 완료 후(enter=1)는 *같은* now 에서도 달라야 한다 - now 를 고정해
    # 숨쉬기 펄스(tri(now/4.0)) 성분을 상쇄하고 enter 배수만 분리해서 본다.
    just_entered_renderer = Renderer()
    just_entered_renderer.draw(surface, "fault", 5.0)  # 진입 첫 프레임: enter == 0
    just_entered = pygame.image.tostring(surface, "RGB")
    settled_renderer = Renderer()
    settled_renderer.draw(surface, "fault", 0.0)  # 프라이밍: state_since=0.0
    settled_renderer.draw(surface, "fault", 5.0)  # 같은 now, 충분히 지남: enter == 1
    faded_in = pygame.image.tostring(surface, "RGB")
    assert just_entered != faded_in, "특수 화면 진입 페이드가 안 먹는다(enter 배수 미적용)"

    # 여러 시각을 본다 - now=0 한 프레임만 보면 세로 운동의 최대 하향 변위를
    # 놓친다. NOD_PERIOD/2 는 끄덕임 바닥(정확히 NOD_AMP), 1.8 은 브리딩
    # 꼭대기다. NOD_AMP 를 올리다 패널을 넘기면 여기서 걸린다.
    for state, now in ((s, t) for s in VALID_STATES | {"disconnected", "fault"} | PROVISION_STATES
                       for t in (0.0, NOD_PERIOD / 2, 1.8, 2.7)):
        renderer.draw(surface, state, now)
        surface.set_colorkey(BG)
        # 행마다 그려진 구간의 좌우 끝만 본다. 전체 bounding rect 의 네 꼭짓점을
        # 쓰면 왼눈의 x 와 '!' 의 y 처럼 실제로는 비어 있는 좌표를 잡는다.
        for y in range(SIZE):
            row = surface.subsurface((0, y, SIZE, 1)).get_bounding_rect()
            if not row.width:
                continue
            for x in (row.left, row.right - 1):
                d = math.hypot(x - SIZE / 2, y - SIZE / 2)
                assert d <= SAFE_R, f"{state}: 그린 내용이 패널 원 밖(({x},{y}), {d:.0f}px)"

    # WS 끊김 복귀. websockets 없이 비동기 이터레이터만 흉내내면 된다 -
    # _handler 가 쓰는 건 `async for` 와 집합 원소로서의 ws 뿐이다.
    class _FakeWS:
        def __init__(self, msgs):
            self._msgs = msgs

        def __aiter__(self):
            async def gen():
                for m in self._msgs:
                    yield m
            return gen()

    async def _ws_case():
        _clients.clear()
        _state["eye"] = "idle"
        await _handler(_FakeWS(['{"eyeState": "processing"}']))
        assert _state["eye"] == "idle", "마지막 폰이 나갔는데 표정이 안 돌아왔다"
        assert _clients_empty_since["t"] is not None, "마지막 클라이언트가 나갔는데 empty 시각 미기록"
        # 폰이 하나 더 붙어 있으면 유지된다 (끊긴 쪽만 나간 것).
        other = object()
        _clients.add(other)
        await _handler(_FakeWS(['{"eyeState": "conversation"}']))
        assert _state["eye"] == "conversation", "다른 폰이 남았는데 idle 로 되돌렸다"
        await _handler(_FakeWS(['{"eyeState": "provision_fail"}']))
        assert _state["eye"] == "provision_fail", "provision 상태를 못 받았다"
        _clients.discard(other)
        _state["eye"] = "idle"

    asyncio.run(_ws_case())

    # 무클라이언트 유예 판정
    _clients_empty_since["t"] = None
    assert effective_state(100.0) == _state["eye"], "클라이언트가 있는데 disconnected"
    _clients_empty_since["t"] = 50.0
    assert effective_state(50.0 + DISCONNECT_GRACE_S - 1) == _state["eye"], "유예 중인데 disconnected"
    assert effective_state(50.0 + DISCONNECT_GRACE_S + 1) == "disconnected", "유예 초과인데 미전환"
    # fault 판정 우선순위: provision > disconnected > fault > 일반 상태.
    # fault 는 idle(홈) 화면일 때만 - 세션 중엔 wake 일시정지로 mic 판정이
    # 무효라 오탐이었다.
    _clients_empty_since["t"] = None
    _state["eye"] = "idle"
    _health["bad"] = True
    assert effective_state(100.0) == "fault", "건강 이상인데 fault 미전환"
    _state["eye"] = "conversation"
    assert effective_state(100.0) == "conversation", "세션 중인데 fault 로 오탐했다"
    _state["eye"] = "provision_new"
    assert effective_state(100.0) == "provision_new", "provision 이 fault 에 졌다"
    _state["eye"] = "idle"
    _clients_empty_since["t"] = 50.0
    assert effective_state(50.0 + DISCONNECT_GRACE_S + 1) == "disconnected", "disconnected 가 fault 에 졌다"
    assert effective_state(50.0 + 1) == "idle", "무클라이언트 유예 중인데 fault 가 떴다"
    _health["bad"] = False
    _clients_empty_since["t"] = None
    assert effective_state(100.0) == "idle", "건강 정상인데 fault 잔류"
    _clients_empty_since["t"] = time.monotonic()

    print("[viva-eyes] selftest OK")


# --- 메인 루프 ---------------------------------------------------------------

def main():
    threading.Thread(target=_ws_thread, daemon=True).start()
    if not WINDOW:
        # 창 모드(개발 맥)는 /proc/asound 가 없어 mic 이 영구 False 다 -
        # 표정 확인은 키보드(9)로 한다. Pi 에서만 실판정을 돌린다.
        threading.Thread(target=_health_thread, daemon=True).start()

    pygame.init()
    check_invariants()
    clock = pygame.time.Clock()
    renderer = Renderer()

    if WINDOW:
        screen = pygame.display.set_mode((SIZE, SIZE))
        pygame.display.set_caption("VIVA eyes (1:idle 2:calling 3:processing 4:conversation 5:listening 6:disconnected 7:prov_new 8:prov_fail 9:fault)")
        fb, fbsurf = None, pygame.Surface((SIZE, SIZE))
        print("[viva-eyes] window mode - 1~9 키로 상태 전환")
    else:
        # /dev/fb0 직접 기록. 16bpp(RGB565) 전제 - vc4drmfb 기본값이고 실기기
        # 확인값. pygame 16bpp 서피스의 기본 마스크가 RGB565 라 blit 한 번이면
        # 픽셀 변환까지 C 속도로 끝난다.
        fbsurf = pygame.Surface((SIZE, SIZE), 0, 16)
        fb = open("/dev/fb0", "r+b", buffering=0)
        print(f"[viva-eyes] fbdev output, masks={fbsurf.get_masks()[:3]}")

    # 크로스페이드용: 이전 상태 프레임을 별도 서피스에 그려 알파로 덮는다.
    prev_surface = pygame.Surface((SIZE, SIZE))
    cur_surface = pygame.Surface((SIZE, SIZE))
    frame = pygame.Surface((SIZE, SIZE))
    shown_state = _state["eye"]
    fade_started = None
    vsync_ok = True
    FADE_OUT, FADE_IN = 0.12, 0.18
    fps_frames, fps_since = 0, time.monotonic()  # 300프레임마다 실측 fps 로그

    while True:
        now = time.monotonic()
        fps_frames += 1
        if fps_frames >= 300:
            print(f"[viva-eyes] fps: {fps_frames / (now - fps_since):.1f}")
            fps_frames, fps_since = 0, now

        if WINDOW:
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    return
                if event.type == pygame.KEYDOWN and event.key in KEY_STATES:
                    _state["eye"] = KEY_STATES[event.key]

        # 창 모드는 WS 클라이언트가 원래 없으니 무클라이언트 판정을 끈다 -
        # 키보드(1~6)로만 상태를 바꾼다.
        target = _state["eye"] if WINDOW else effective_state(now)
        if target != shown_state and fade_started is None:
            renderer.draw(prev_surface, shown_state, now)  # 마지막 프레임 고정
            shown_state = target
            fade_started = now

        if fade_started is None:
            # 평상시(대부분의 프레임): 16bpp fbsurf 에 바로 그린다 - 32bpp
            # 중간 서피스 2회 블릿(+RGB565 변환)이 프레임마다 들면 vblank 를
            # 놓친다. set_alpha 가 필요한 크로스페이드(~300ms)만 아래 경로.
            renderer.draw(fbsurf, shown_state, now)
        else:
            t = now - fade_started
            if t >= FADE_OUT + FADE_IN:
                fade_started = None
                renderer.draw(fbsurf, shown_state, now)
            else:
                # 아웃(120ms): 이전 화면이 배경색으로 사라지고, 인(180ms): 새
                # 화면이 떠오른다 - 앱과 같은 순차 페이드.
                renderer.draw(cur_surface, shown_state, now)
                frame.fill(BG)
                if t < FADE_OUT:
                    prev_surface.set_alpha(int(255 * (1 - t / FADE_OUT)))
                    frame.blit(prev_surface, (0, 0))
                else:
                    cur_surface.set_alpha(int(255 * (t - FADE_OUT) / FADE_IN))
                    frame.blit(cur_surface, (0, 0))
                    cur_surface.set_alpha(255)
                fbsurf.blit(frame, (0, 0))

        if fb is None:
            screen.blit(fbsurf, (0, 0))
            pygame.display.flip()
        else:
            raw = fbsurf.get_buffer().raw
            if vsync_ok:
                try:
                    # 실측(2026-08-03): 이 드라이버의 WAITFORVSYNC 는 성공만 하고
                    # 대기하지 않는 no-op(155fps > 패널 69Hz). 페이스는 아래 tick
                    # 담당, ioctl 은 지원 드라이버로 옮겼을 때를 위해 남긴다.
                    fcntl.ioctl(fb, FBIO_WAITFORVSYNC, 0)
                except OSError:
                    vsync_ok = False
                    print("[viva-eyes] FBIO_WAITFORVSYNC unsupported - falling back to fixed tick")
            fb.seek(0)
            fb.write(raw)
        clock.tick(FPS)


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()

# 연결 끊김·부품 고장 UX 개편 설계 (2026-08-11)

승인: 사용자 (본 세션 대화). 점 색 ORANGE 재사용 확정, 고장 문구 진단 톤 확정,
로봇 끊김 화면은 자는 눈 삭제 + 아이콘·문구 확정, 프로비저닝(QR+카메라)은 보류.

## 1. 앱 - FaultBadge (DeviceVitals 대체)

- 위치: 홈 우상단을 한 줄 행으로 재구성 - `[고장 배지][연결 칩][힌트 토글]`.
  행 컨테이너(absolute, right:100)가 배지+칩을 담고, 칩은 absolute 를 벗는다
  (사용처가 HomeScreen 하나뿐). SolveModeToggle 은 그대로 둔다.
- 형태: 연결 칩과 같은 36px 외곽선 필 + ORANGE 점 8px. 이상이 없거나 미연결
  이면 컴포넌트 자체가 null (기존 DeviceVitals 규칙 유지).
- 애니메이션: 칩과 같은 메커니즘 - 이상 발생 시 점 왼쪽으로 라벨이 스르륵
  펼쳐지고 4초 뒤 접힘, 탭하면 재펼침. 여러 이상이면 점 왼쪽 첫 줄 아래로
  오른쪽 정렬 목록이 주르륵 (필 높이가 같이 자란다).
- 문구: 진단 톤 - 마이크 이상 / 스피커 이상 / 카메라 이상 / 화면 이상.
- mic grace(연결 직후 12초 micOk:false 강등)는 HomeScreen 에 그대로 남는다.

## 2. 앱 - ConnectionGuideCard 리디자인

- 대상: 홈 미연결 안내 + DisconnectOverlay 공용 카드 (한 곳 고치면 둘 다).
- 3단계 유지(전원/와이파이/재연결). 숫자 원 대신 GREEN 틴트 타일 + CSS 드로잉
  아이콘(전원 심볼/와이파이 아크/재시작 화살표). 새 의존성 없음.
- 등장 애니메이션: 행별 스태거 페이드+슬라이드 인 (native driver).

## 3. 끊김 판정 전파 (버그 수정)

증상: 앱은 "연결 안 됨"인데 로봇은 계속 평소 눈.

원인: 판정 채널 분리. 앱 판정은 /health HTTP, 로봇의 자는 얼굴은 눈 WS(:8787)
무클라이언트 30초. 앱이 disconnected 여도 눈 WS 재접속 루프(3초)는 계속 돌아
로봇엔 항상 클라이언트가 있다. 폰이 갑자기 사라진 경우도 기본 keepalive(~40s)
+유예 30s = 최대 70초.

수정:
- connectionMonitor 상태 엣지에서 눈 WS 를 제어한다 - disconnected 로 바뀌면
  eyeSyncService.stop(), connected 로 바뀌면 resendLast()(마지막 상태 재송신,
  자동 재연결). 판정자는 connectionMonitor 하나로 통일.
- eyes.py: ping_interval/ping_timeout 10s(half-open 조기 감지),
  DISCONNECT_GRACE_S 30→12 (폰 화면 잠깐 꺼짐 3초 재접속 주기는 여전히 커버).

## 4. 로봇 - 연결 끊김 화면 (eyes.py)

- 자는 눈(반감은 눈+z) 삭제. 대신: 폰 외곽선+대각 슬래시 아이콘(mobile_cancel
  계열, 수퍼샘플 베이크, 흰색) 중앙 상단 + 느린 알파 펄스, 아래 두 줄 문구
  "VIVA for Device 앱과 / 연결이 필요합니다".
- 한글 폰트: match_font 로 nanumgothic → notosanscjk → applesdgothicneo 순
  탐색, 없으면 아이콘만 (SysFont 폴백은 한글 tofu 라 금지).
- 배포: Pi 에 `sudo apt install fonts-nanum` 1회 (README 기록).
- selftest 의 원형 패널 이탈 검사에 새 화면이 그대로 걸린다.

## 5. 보류

와이파이 프로비저닝은 QR(앱 생성)+로봇 카메라 스캔 안을 후보로 기록만 하고
이번 범위에서 제외.

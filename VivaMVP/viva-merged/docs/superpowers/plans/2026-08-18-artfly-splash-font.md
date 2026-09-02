# ARTFLY 부팅/종료 화면 + 폰트 통일 (Pretendard)

## 배경

- 로봇(Pi Zero W, 480×480 원형 HDMI, /dev/fb0 RGB565)에 부팅 화면(ARTFLY 워드마크 + Bezel Arc 로딩)과 종료 화면(Quiet Mark: 워드마크만 62% 밝기)을 넣는다. 시안: https://claude.ai/code/artifact/990dde6d-f9bd-4306-92ec-0fc844cbe7ac (Bezel Arc + Quiet Mark 조합 채택)
- 폰트 통일: 현재 앱은 theme.ts `FONT='Pretendard'` 선언만 있고 폰트 파일/로딩이 없어 시스템 폰트로 조용히 폴백(죽은 설정). 로봇은 한글=NanumGothic 동봉, 영문 마크('?','!')=DejaVu Sans(시스템). 전부 Pretendard(OFL)로 통일한다.

## Global Constraints

- **성능**: Pi 는 싱글코어 ARMv6 1GHz. 부팅/종료 화면 런타임은 python/pygame 을 띄우지 않는다 — 설치 시 1회 bake 한 raw RGB565 프레임을 sh + `cat`(또는 dd) 으로 /dev/fb0 에 쓰는 방식만 허용. 부팅 화면 프로세스는 viva-eyes 가 뜨는 순간 반드시 죽어야 한다(fb 경합 금지).
- **비주얼 (시안 고정값)**: 배경 #000000, 워드마크 "ARTFLY" 흰색(#FFFFFF) Pretendard Bold, letter-spacing 약 0.075em, 크기는 480px 패널에서 폭의 약 55~60% (시안: 260px 패널에 33px → 480px 환산 ≈ 61px). Bezel Arc: 반지름 = 패널 반지름의 ~85% (시안: r110/130), 두께 ~6px(시안 3px@260 환산), 트랙 흰색 14% 알파, 채움 #369B75(theme.ts GREEN), 12시 방향 시작 시계방향, 라운드 캡. 종료 화면: 워드마크만 62% 밝기(#9E9E9E 근사), 아크 없음.
- **프레임**: 부팅 아크는 12프레임, 전체 스윕 ~2.6초 주기 순환(프레임당 ~0.216s, sh sleep 0.2 허용). 마지막 프레임에서 다시 0으로 루프.
- **폰트**: Pretendard OFL — 재배포 허용. 라이선스 파일 동봉. 로봇 fonts/ 에는 Regular + Bold. 앱 assets/fonts/ 도 Regular/Bold 2종만 배포한다(당초 4종/Android fontDefinitions 계획에서 축소) — expo-font 12 는 android 쪽에서 `fontDefinitions`(weight 별 파일) 를 지원하지만, RN Android 의 ReactFontManager 는 `fontFamily:'Pretendard'` 를 결국 RN 명명 규칙 파일(`fonts/Pretendard.otf`, `fonts/Pretendard_bold.otf`)로만 해석해 여러 weight 파일을 못 쓴다(per-style 별도 fontFamily 지정 없이는). 그래서 앱도 로봇과 동일하게 Regular/Bold 2종만 두고 RN 명명 규칙 파일명(`Pretendard.otf`/`Pretendard_bold.otf`)으로 통일했다 — fontWeight 500 은 Regular 로, 600 이상은 Bold 로 스냅되는 트레이드오프를 받아들인다. NanumGothic 은 제거(Pretendard 가 한글 커버).
- **eyes.py 계약 유지**: VALID_STATES/프로토콜/렌더 구조 변경 금지. 폰트 로드 경로만 바꾼다. `--selftest` 통과 필수.
- **CNG 함정**: app.config.js 변경 후 네이티브 빌드 시 `rm -rf ios android` 필요 (docs/process.md §1). 이 플랜에서 네이티브 빌드는 하지 않는다 — 폰 앱 재빌드·설치는 사람 몫으로 남긴다.
- 커밋 메시지 한국어, 기존 스타일(feat:/fix:/perf: 접두).

## Task 1: pi-server 스플래시 (bake 스크립트 + systemd 유닛 2개)

**파일:**
- `viva-merged/pi-server/splash.py` (신규): `--bake` 로 부팅 12프레임 + 종료 1프레임을 raw RGB565 로 생성 (`splash/boot-00.raw`..`boot-11.raw`, `splash/off.raw`, 480×480×2 bytes each). PIL 사용(마크 렌더 포함 — Pretendard-Bold, `fonts/Pretendard-Bold.otf`). 아크는 4배 수퍼샘플로 그려 축소(안티에일리어싱). `--selftest`: bake 결과 파일 수/크기/첫·끝 프레임 픽셀 차이 검증. RGB565 변환은 numpy.
- `viva-merged/pi-server/viva-splash.service` (신규): 부팅 스플래시. `DefaultDependencies=no`, `After=local-fs.target`, `Before=viva-eyes.service`, `Conflicts=viva-eyes.service` (eyes 가 뜨면 systemd 가 splash 를 내림). ExecStart 는 `/bin/sh -c` 루프: 프레임 순환 cat > /dev/fb0, sleep 0.2. 콘솔 커서 숨김은 viva-eyes.service ExecStartPre 와 동일 라인 선행.
- `viva-merged/pi-server/viva-splash-off.service` (신규): 종료 화면. `DefaultDependencies=no`, `Before=shutdown.target reboot.target halt.target`, `WantedBy=shutdown.target`, Type=oneshot, RemainAfterExit=yes: `cat splash/off.raw > /dev/fb0`.
- `viva-merged/pi-server/test_splash.py` (신규): bake 순수 로직 테스트 (프레임 수, 바이트 크기, 아크 진행에 따라 초록 픽셀 증가, 종료 프레임에 회색 워드마크 존재). Mac 에서 pytest 로 돈다 (PIL/numpy 만, fb 접근 없음).
- `viva-merged/pi-server/README.md`: "부팅/종료 화면" 절 추가 (설치 명령: bake → cp units → enable. `/boot/firmware/config.txt` 에 `disable_splash=1`, cmdline.txt 에 `quiet logo.nologo vt.global_cursor_default=0` 추가 절차 포함 — cmdline 은 한 줄 유지 주의).

**전제**: Task 2 가 fonts/Pretendard-Bold.otf 를 넣는다. Task 1 은 폰트 경로만 참조 (테스트는 폰트 없으면 PIL 기본 폰트 폴백 + 워드마크 검증 스킵 가능하게).

**검증**: `python3 splash.py --selftest` + `pytest test_splash.py` 통과.

## Task 2: 폰트 통일 (Pretendard 동봉 + eyes.py + 앱 expo-font)

**파일:**
- 다운로드 (https://raw.githubusercontent.com/orioncactus/pretendard/main/packages/pretendard/dist/public/static/Pretendard-{Regular,Medium,SemiBold,Bold}.otf):
  - `viva-merged/pi-server/fonts/Pretendard-Regular.otf`, `Pretendard-Bold.otf` (+ `LICENSE-Pretendard.txt` = repo 의 LICENSE, OFL)
  - `viva-merged/assets/fonts/Pretendard-{Regular,Medium,SemiBold,Bold}.otf`
  - `viva-merged/pi-server/fonts/NanumGothic-Regular.ttf`, `OFL.txt` 삭제
- `viva-merged/pi-server/eyes.py`:
  - `DC_BUNDLED_FONT` → `fonts/Pretendard-Regular.otf`
  - 758행 부근 '?'/'!' 마크: `pygame.font.SysFont("dejavusans", size, bold=True)` → 동봉 `fonts/Pretendard-Bold.otf` 를 `pygame.font.Font` 로 로드 (없으면 기존 SysFont 폴백 유지)
  - `--selftest` 통과 확인
- `viva-merged/app.config.js`: plugins 에 `['expo-font', { fonts: [4종 경로], android: { fonts: [{ fontFamily: 'Pretendard', fontDefinitions: [{path, weight}×4] }] } }]` 추가. iOS 는 fonts 배열만으로 family+weight 매칭 됨.
- `npx expo install expo-font` (package.json 반영)
- `viva-merged/pi-server/README.md`: fonts-nanum → Pretendard 표기 갱신 (기존 "fonts/ 동봉" 문구 유지)

**주의**: eyes.py 의 `_load_kr_font` 시스템 폰트 폴백 체인(nanum…)은 폴백이므로 그대로 둔다. RN 스타일 코드는 변경 없음 — `fontFamily: 'Pretendard'` + fontWeight 가 이제 실제로 매칭된다.

**검증**: `python3 eyes.py --selftest` 통과, `npx tsc --noEmit` 클린, jest 회귀 없음 (`npx jest --silent` 전체 또는 관련 스위트).

## Task 3: Pi 배포 (컨트롤러가 직접, 서브에이전트 아님)

1. scp: `splash.py`, `eyes.py`, `fonts/` (Pretendard 2종), 유닛 2개(`viva-splash.service`, `viva-splash-off.service`) → `viva@172.20.2.16:~/pi-server/`
2. Pi 에서 bake: `python3 splash.py --bake` (PIL/numpy 는 picamera2 의존으로 이미 있음 — 없으면 apt python3-pil python3-numpy)
3. `sudo cp *.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable viva-splash viva-splash-off`
4. `/boot/firmware/config.txt` 백업 후 `disable_splash=1` 추가, `cmdline.txt` 백업 후 `quiet logo.nologo vt.global_cursor_default=0` 덧붙임 (한 줄 유지)
5. `sudo systemctl restart viva-eyes` (새 폰트 확인: journalctl 에 "한글 폰트 없음" 부재) → `sudo reboot` 로 부팅 화면 육안 확인 → 재부팅 직전 종료 화면 육안 확인
6. docs/process.md 갱신 + main 병합

## 남는 것 (사람 몫)

- 폰 앱 실기기 반영: `rm -rf ios android` 후 재빌드·설치 (CNG, expo-font 는 네이티브 변경)
- 부팅/종료 화면 육안 확인 (5번에서 컨트롤러가 ssh 로는 확인 불가 — 화면은 사람이 봐야 함)
- getty 레이스 실기기 확인: `viva-splash.service` 의 `Conflicts=getty@tty1.service` +
  `After=getty@tty1.service` 가 fbcon 로그인 프롬프트를 실제로 밀어내는지, 그로 인한
  첫 프레임 지연이 체감되는지 실기기 부팅에서 눈으로 확인 필요(문서 근거로만 추론, 미검증)

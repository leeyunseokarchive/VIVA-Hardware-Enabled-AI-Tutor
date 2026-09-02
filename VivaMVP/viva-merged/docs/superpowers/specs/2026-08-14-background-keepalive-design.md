# iOS 백그라운드 생존 (무음 오디오 세션) 설계

날짜: 2026-08-14
상태: 승인됨 (접근안 A — 무음 오디오 루프, 세션 한정)

## 문제

VIVA for Device 앱 사용 중 아이폰 화면을 끄거나 다른 앱으로 전환하면 로봇과의
연동이 끊긴다. 앱에는 "비바와 연결이 끊겼어" 오버레이(`DisconnectOverlay.tsx`),
로봇 눈에는 "VIVA 앱과 연결이 끊어졌어요"(`eyes.py`)가 뜬다.

원인: `Info.plist` 에 `UIBackgroundModes` 가 없어 앱이 백그라운드 진입 즉시
iOS 에 의해 suspend 된다. health 폴링(5초)·눈 WS(8787)·호출어 PCM WS(8788)가
전부 동결 → 로봇 쪽 12초 유예 타이머가 만료돼 끊김 판정.

사용자 시나리오: 문제 푸는 중간에 화면을 꺼두거나, 다른 앱에서 강의 영상을
보거나 검색한다. 그 동안에도 "비바야" 호출에 로봇이 반응해야 한다 (완전 생존).

## 결정

**무음 오디오 루프 — 연결 상태 한정.** `UIBackgroundModes: ["audio"]` 선언 +
로봇 연결 중에만 무음 WAV 를 volume 0, `mixWithOthers` 로 루프 재생. iOS 가
앱을 살려둬서 3개 통신 채널이 백그라운드에서도 동작한다. Pi 쪽 변경 없음.

배포는 App Store 예정 — 심사 리젝 시 심사 노트에 "로봇 튜터와 실시간 음성
세션 유지"로 소명, 최종 리젝 시 플랜B(폰 마이크 백그라운드 녹음, audio 모드의
공식 허용 용도)로 전환한다.

### 기각한 대안

- **B. 폰 마이크 백그라운드 녹음**: 심사 정당성 최상이나 주황 마이크 표시등
  상시 점등 + 배터리 비용 + "폰 마이크 폴백 금지" 제품 정책과 충돌. 플랜B 로만.
- **C. 호출어 감지를 Pi 로 이전**: suspended 앱을 로컬 네트워크로 못 깨움.
  APNs 백그라운드 푸시는 전달 보장이 없어 "완전 생존" 미달. 공사도 큼.
- **빠른 복귀만 / keep-awake**: 앱 전환 시나리오(강의 시청) 미해결.

## 구성 요소

1. **`src/device/services/backgroundKeepAlive.service.ts` (신규)**
   - `start()`: `Audio.setAudioModeAsync({ staysActiveInBackground: true,
     playsInSilentModeIOS: true, interruptionModeIOS: MixWithOthers })` 후
     번들 무음 WAV(`assets/silence.wav`)를 `isLooping, volume: 0` 재생.
   - `stop()`: sound unload. 멱등.
   - `ensurePlaying()`: 인터럽트로 멈춘 재생 복구 (foreground 복귀 보험).
   - start/stop 이 await 중 겹칠 수 있어 내부 직렬화 큐로 인터리브 차단.

2. **`connectionMonitor.service.ts` (수정)** — 라이프사이클 소유자.
   - `connected` 전환 시 `start()`, 유예 타이머 취소.
   - `disconnected` 전환 시 **3분 유예 타이머** 시작, 만료 시 `stop()`.
     즉시 내리지 않는 이유: 백그라운드 중 순간 끊김에 keepalive 를 내리면
     앱이 suspend 돼 로봇이 돌아와도 감지 불가 — 자기 파괴. 3분은 배터리
     방어 하한 (튜닝 노브 `KEEPALIVE_STOP_GRACE_MS`).
   - `stop()`(APP 모드 전환) 시 즉시 keepalive stop + 타이머 취소.
   - AppState 리스너: foreground `active` 복귀 시 즉시 재프로브 +
     `ensurePlaying()` (전화 인터럽트·메모리 압박 후 자가 회복).

3. **`app.config.js` (수정)** — device variant 에만
   `UIBackgroundModes: ["audio"]`. (정정 2026-08-14: 커밋 3a51196 이
   네이티브 트리를 CNG 로 전환해 ios/ 는 gitignore 대상 — app.config.js 가
   유일한 소스이고 빌드 시 `npx expo prebuild` 가 반영한다.)

## 동작 결과

- 화면 꺼짐·앱 전환 중에도 연결 유지, "비바야" 정상 동작.
- 로봇 눈 끊김 화면 안 뜸 (WS 유지 → `eyes.py` 12초 유예 안 걸림).
- `mixWithOthers` 라 사용자가 보는 강의 영상 소리 안 죽음.

## 알려진 한계

- 전화 수신 등 하드 인터럽트가 오디오 세션을 뺏으면 그 시점부터 suspend
  가능. 인터럽트 종료 + foreground 복귀 시 `ensurePlaying()` 으로 회복하나
  백그라운드 상태에서의 100% 생존은 보장 불가.
- App Store 심사 리젝 가능성 — 위 결정 절의 소명/플랜B 경로.

## 증보: Android 대응 (2026-08-14, 사용자 지시 — iOS/Android 모두 지원)

사용자가 어느 플랫폼 폰을 쓸지 모르므로 Android 도 같은 수준으로 생존해야
한다. 무음 루프는 크로스플랫폼이지만 Android 에선 OEM(삼성 등)의 공격적
백그라운드 킬과 Doze 네트워크 제한 때문에 불충분 — **포그라운드 서비스
(FGS)** 를 병행한다 (승인된 접근: FGS 추가).

- **라이브러리**: `react-native-background-actions@4.1.0` (2026-04 릴리스,
  유지보수 중, RN 0.74 호환, 오토링킹). 대안 기각: notifee(2026-04
  아카이브됨), expo-background-task(15분 간격 WorkManager — 상시 연결 유지
  불가). New Architecture 미지원이나 Expo 51 은 기본 off — 향후 New Arch
  전환 시 재평가 (천장).
- **FGS 타입**: `connectedDevice` — "네트워크 연결을 통한 외부 기기와의
  상호작용"에 정확히 해당 (로컬 WS 2개 + HTTP 폴링). Android 15 에서
  6시간/일 제한이 걸리는 `dataSync`, 용도 사칭인 `mediaPlayback` 기각.
  매니페스트 요건: `FOREGROUND_SERVICE_CONNECTED_DEVICE` +
  `CHANGE_NETWORK_STATE` (전제조건 권한, 런타임 다이얼로그 없음).
- **매니페스트 주입**: 커스텀 config plugin
  (`plugins/withBackgroundActions.js`, `withAndroidManifest`) — CNG 전환
  (3a51196) 후 app.config.js 가 유일한 소스. device variant 에만 적용.
- **동작**: 로봇 연결 중 FGS 알림("비바와 연결 유지 중") 상시 표시 +
  기존 무음 루프 병행 (오디오 파이프라인이 CPU 딥슬립을 완화). FGS 는
  Doze 네트워크 제한 면제 + OEM 킬 저항 담당.
- **알려진 한계 (Android)**: 라이브러리가 PARTIAL_WAKE_LOCK 을 잡지 않음 —
  장시간 유휴 시 JS 타이머 지연 가능. 실기기 실측에서 폴링 멈춤이
  확인되면 소형 네이티브 wake-lock 모듈 추가 (업그레이드 경로).
  `BackgroundService.stop()` 이 태스크를 즉시 못 죽이는 버그(#201) —
  태스크 루프가 로컬 플래그도 확인해 자체 종료하는 것으로 완화.
  Android 13+ 은 POST_NOTIFICATIONS 미허용 시 알림이 안 보일 수 있으나
  FGS 자체는 동작 — 런타임 권한 요청은 후속.
  무음 루프의 `Audio.setAudioModeAsync` 가 `interruptionModeAndroid` 를
  명시하지 않아 expo-av 기본값(DuckOthers) 이 적용된다 — 다른 앱이 재생
  중이어도 우리 무음 루프가 계속 살아 있는 한 그 앱 오디오를 상시
  덕킹(볼륨 낮춤)할 수 있다는 뜻. 반대로 `shouldDuckAndroid: false` 는
  다른 앱이 오디오 포커스를 가져가면 우리 쪽 무음 루프가 일시정지될 수
  있다는 뜻 — 다만 FGS 가 생존을 담당하므로 무음 루프가 잠깐 끊겨도
  치명적이지 않다. 업그레이드 경로: 실기기에서 덕킹이 실측 확인되면
  무음 루프를 iOS 전용으로 게이트하고(Android 는 FGS 단독으로 생존),
  `interruptionModeAndroid` 를 명시적으로 `DoNotMix` 등으로 바꾸는 대안도
  검토.
- **실기기 체크리스트 (Android)**: ⑤ 삼성 기기에서 화면 끄고 5분 후
  "비바야" 호출 ⑥ 다른 앱 전환 30분 후 연결 유지 확인 ⑦ 다른 앱 재생
  중 화면을 끈 채로 방치 시 그 앱 오디오가 계속 덕킹(작아짐)되는지.
- (정정 2026-08-14, 최종 리뷰) "`tts.service.ts` 는 phone variant 전용"
  이라는 초기 전제는 **틀렸다** — device variant 도 `speak()` 를 쓰고, 그
  안의 `setAudioModeAsync({ staysActiveInBackground: false })` 가 매 발화마다
  keepalive 모드를 덮어써 백그라운드 생존을 무력화했다. 해당 키를 두 호출
  모두에서 삭제(merge 규칙이 현재값 유지)하고 회귀 테스트로 고정했다.

## 테스트

- 유닛: 서비스 start/stop 멱등성·직렬화, connectionMonitor 전이별 호출,
  3분 유예 타이머(fake timers), 유예 중 재연결 시 취소.
- 실기기 체크리스트: ⓪ 대화 한 턴(TTS 발화) 후 화면 끄고 30초 뒤 호출 —
  TTS 없이 화면만 끄고 호출하면 tts.service 의 오디오 모드 회귀(발화마다
  keepalive 를 끄는 버그류)가 이 순서에서만 재현되므로 거짓 초록불이 나올
  수 있다 ① 화면 끄고 30초 후 "비바야" 호출 ② 유튜브 재생 중
  호출 + 강의 소리 유지 ③ 전화 수신→종료 후 복귀 ④ 30분 방치 배터리 측정.

# 멀티 디바이스 페어링 설계 (2026-08-20)

한 네트워크에 로봇 N대 + 폰 N대가 공존할 때의 식별·페어링·인증 설계.
브레인스토밍 확정: 시나리오는 (b) 교실 N쌍 + (c) 양산 QA 동시 테스트,
토폴로지는 **1로봇:1폰 배타 쌍 × N** (다중 폰 동시 접속 미지원).

## 1. 현재 문제 (2026-08-20 기준 코드)

- 앱은 빌드 시점 고정된 `viva.local:5000`(HTTP) / `:8787`(눈 WS) /
  `:8788`(호출어 PCM WS)로 접속 (`piBridge.service.ts:16`). 페어링·인증·
  디바이스 ID 전무.
- 골든 이미지 복제라 모든 로봇 hostname `viva`. `viva-firstboot.sh`는
  SSH 호스트키만 재생성. avahi 충돌 해소가 두 번째 로봇을 `viva-2.local`로
  개명 - 어느 로봇이 `viva.local`을 차지하는지 부팅 순서 따라 비결정적.
  모든 앱이 한 로봇에 몰리고 나머지는 영원히 disconnected.
- `wake.py`는 접속한 모든 WS에 PCM 브로드캐스트 - 폰 두 대가 동시에
  호출어 감지, 촬영·녹음 경합. 눈 상태는 마지막에 쓴 폰이 이김.
- 무인증 Flask라 같은 망 아무 기기나 카메라 촬영·마이크 청취 가능.

## 2. 설계 개요

기각한 대안: (A0) 로봇 화면 QR을 폰이 스캔 - 화면·절차 추가.
(B) mDNS 브라우즈 + 앱 픽커 - react-native-zeroconf 새 네이티브 의존성,
20대 목록에서 내 로봇 못 고름. (C) hostname 유니크화만 - 교실 크로스토크·
도청 미해결.

채택: **WiFi 프로비저닝 QR에 토큰 합승 + 토큰 열쇠 서브넷 스윕**.
사용자 추가 절차 0, 새 화면 0, 새 의존성 0.

### 페어링 플로우

1. 앱 WiFi 프로비저닝 화면이 QR에 페어링 토큰을 합승:
   `WIFI:T:WPA;S:<ssid>;P:<psk>;V:<token>;;`
   토큰 형식: 16바이트 랜덤의 hex 32자. `crypto.getRandomValues`로 생성
   (`Math.random` 금지 - 보안 토큰). 현 RN/Hermes 버전에서 미지원이면
   `expo-crypto` 추가 - 구현 시 확인.
   - 앱이 QR 생성 주체라 포맷 확장 자유. `provision.py`의
     `parse_wifi_qr`는 이미 key:value 딕셔너리 파싱 - `V` 필드 읽기만 추가.
   - 표준 필드(T/S/P)는 그대로라 구버전 로봇도 WiFi 등록은 됨 (토큰만 무시).
2. 로봇: 스캔 시 nmcli 등록 + 토큰을 `/var/lib/viva/pairing.json`에 영속화.
   로봇 쪽 페어링 절차 끝.
3. 앱: **토큰 열쇠 서브넷 스윕**으로 로봇 주소 자동 발견.
   - NetInfo(`@react-native-community/netinfo` 11.3.1, 기설치)로 폰 IP·
     서브넷 획득, /24의 254개 주소에 `GET /pair/whoami` 병렬 fetch
     (타임아웃 300ms, 동시 50개, 체감 2~4초).
   - 로봇의 WiFi 접속·서버 기동에 시간이 걸리므로 스윕은 10초 간격
     재시도, 총 2분까지. 그 뒤 수동 입력 폴백 노출.
   - 토큰 일치하는 로봇만 `200 { hostname: "viva-3f7a" }` 응답.
     토큰이 폰마다 유니크라 교실 20쌍 동시 페어링에도 각 폰은 자기
     로봇만 발견 - 충돌 원천 불가.
   - 앱은 `{ host: "viva-3f7a.local", token }`을 AsyncStorage에 영속화.
     이후 접속은 저장된 hostname 직행 (mDNS *resolve*는 OS 공짜,
     의존성이 필요한 건 *browse*뿐이라 안 씀).
   - ponytail: /24 고정 스윕. 대형 서브넷은 수동 입력 폴백.
4. 스윕 실패 시에만(비정형 서브넷, AP isolation 등) 4글자 수동 입력 필드
   노출 - 로봇 화면·밑면 라벨의 `3f7a` 입력 → `viva-3f7a.local` 조합.
   AP isolation 망에선 제품 자체가 불가(폰→로봇 전 트래픽 차단)라
   새 실패 모드는 아님.

### 사용자가 한 일: QR 보여주기. 그게 전부.

## 3. 로봇 정체성 - firstboot 유니크화 (VivaHW)

`VivaHW/scripts/viva-firstboot.sh`에 추가:

- Pi serial(`/proc/cpuinfo`) 끝 4자리 hex로 `hostnamectl set-hostname
  viva-3f7a` + `/etc/hosts` 갱신. avahi가 자동으로 `viva-3f7a.local` 광고.
- 골든 이미지 v2 재씰링 필요. 이름은 로봇 밑면 라벨로도 인쇄 (QA 식별 +
  수동 입력 폴백용).
- 기존 provision 성공 화면(eyes.py)에 이름 텍스트 한 줄 표시.

## 4. 페어링 상태 머신 (pi-server)

상태 파일: `/var/lib/viva/pairing.json` (`{ "token": "..." }`).

- **미페어링** (파일 없음): 전 엔드포인트 무인증 오픈 - 현재 동작 그대로.
  QA(c)는 페어링 생략하고 hostname만으로 씀. 하위 호환 공짜.
- **페어링됨** (파일 있음): HTTP 전 엔드포인트 `X-Viva-Token` 헤더 검사,
  WS(8787/8788)는 접속 시 쿼리 파라미터(`?token=`) 검사. 불일치 403/close.
- 예외: `GET /health`는 무인증 유지 (QA 편의, 유출 정보 없음).
  `GET /pair/whoami`는 토큰 일치 시에만 hostname 응답 (스윕 발견용,
  불일치 403 - 미페어링 상태에선 404).
- **재페어링** (WiFi 살아있는 로봇을 새 폰에): provision.py는 WiFi 끊겼을
  때만 스캔 모드라 QR 경로 없음. 대신 미페어링 로봇은 오픈이므로 -
  ① 구 폰에서 인증된 `DELETE /pair` (앱 설정) 또는 SSH로 파일 삭제 →
  ② 새 폰이 hostname 수동 입력 + `POST /pair`(body에 새 토큰)로 토큰 심기.

## 5. 앱 변경 (viva-merged/src)

- `EXPO_PUBLIC_PI_HOST` / `EXPO_PUBLIC_EYE_SYNC_WS_URL` 빌드 고정 →
  AsyncStorage `{host, token}` 런타임 저장으로 교체. env 값은 dev
  오버라이드로 강등 (저장값 없을 때만 사용).
- `piBridge.service.ts` / `eyeSync.service.ts` / `piWakeStream.service.ts`가
  저장된 host에서 URL 파생, 요청마다 토큰 첨부 (HTTP 헤더 / WS 쿼리).
- WiFi 프로비저닝 화면: QR에 `V:` 토큰 포함 + 표시 후 백그라운드 스윕 +
  실패 시 4글자 입력 폴백 UI.
- 403 수신 시 "재페어링 필요" 안내 (로봇 재플래싱 등 토큰 불일치 케이스).

## 6. 위협 모델 한계 (명시)

LAN 평문 HTTP라 같은 망 스니핑으로 토큰 탈취 가능 - WPA2 가정/교실망
전제. 원래 목표(무인증 → 아무나 카메라·마이크 접근 차단)는 달성.
ponytail: 평문 토큰, 공용망 배포 시 HTTPS 승격.

## 7. 안 하는 것 (YAGNI)

- mDNS 브라우즈/픽커, 다중 폰 세션 관리, 토큰 로테이션 주기,
  클라우드 페어링 레지스트리, BLE 디스커버리.

## 8. 테스트

- `parse_wifi_qr` V 필드 파싱 (기존 test 파일에 케이스 추가).
- 페어링 상태 머신: 미페어링 오픈 / 페어링 후 토큰 검사 / whoami 응답
  (pi-server 단위 테스트).
- 앱: 스윕 로직(모킹된 fetch로 발견·타임아웃·실패 폴백), 저장값 우선순위
  (AsyncStorage > env > 기본값).
- firstboot: serial → hostname 변환 셸 로직 (기존 골든 이미지 체크리스트에
  hostname 확인 항목 추가).

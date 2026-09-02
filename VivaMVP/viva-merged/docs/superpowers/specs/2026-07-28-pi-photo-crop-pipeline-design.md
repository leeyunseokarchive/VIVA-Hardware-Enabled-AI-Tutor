# Pi 사진 인식률 개선 — 보관본 크롭 파이프라인 설계

날짜: 2026-07-28

## 문제

Pi(picamera2, IMX708 12MP) 사진에서 문제지 글자가 뭉개져 인식률이 낮다.
증상 확인 결과 초점은 정상(전체 프레임은 선명), 원인은 해상도 예산이다.

- Gemini 3는 이미지를 `media_resolution` 토큰 예산(기본 high = 1120토큰,
  약 768×768 타일 4~5장)까지 다운샘플한다. 픽셀을 더 보내도 소용없다.
- 지금은 책상 전체 프레임이 그 예산을 다 쓴다. 문제지 배치가 매번 달라
  문제 하나에 돌아가는 유효 픽셀이 극히 적다.
- 전송 파이프라인이 JPEG를 두 번 인코딩한다(Pi q90 → 앱 manipulateAsync
  2048px q0.8). 획 주변 링잉이 겹친다.

색(누런 캐스트)도 보고됐으나 잉크·종이가 같이 밀리므로 대비를 해치지
않아 인식률에는 무관 — 이번 범위에서 제외.

## 제약 (튜터링 프로세스)

사진에 문제가 1개면 즉시 풀이 분석, 2개 이상이면 "몇 번 풀고 있어?"를
묻고 대답에 따라 해당 문제를 튜터링한다. 이 질문-대답 구간(TTS + 학생
발화 + STT, 3~5초)은 공짜 지연 예산이다. 반대로 문제 1개 경로에는 추가
지연을 넣을 수 없다.

## 핵심 원칙

**재촬영하지 않는다.** 초점이 이미 맞으므로 AF 사이클을 다시 돌 이유가
없다. Pi가 촬영한 12MP 원본을 디스크에 보관하고, 고해상도가 필요하면
보관본에서 PIL crop(~50ms)으로 잘라낸다. 문제 검출은 별도 검출기(OpenCV)
없이 1차 Gemini 분석이 겸한다 — Gemini는 `[ymin,xmin,ymax,xmax]` 0~1000
정규화 bbox를 구조화 출력으로 네이티브 지원한다.

## 흐름

```
Pi 촬영 1회: 12MP 원본 보관 + 2048폭 q85 축소본 생성 (리사이즈는 Pi가 수행)
        │
   앱: 축소본 수신 (앱 쪽 재리사이즈 삭제 — JPEG 인코딩 1회로 줄어듦)
        │
   1차 Gemini 분석 (기존 analyzeImage, RESPONSE_SCHEMA 확장)
   추가 응답 필드: problems: [{ label, box_2d }]
        │
   ┌────┴──────────────────┐
 문제 1개                문제 2개 이상
   │                       │
 confidence OK?          TTS "몇 번 풀고 있어?" 재생·대답 대기
   │        │              │   (이 구간에 크롭 준비가 숨는다)
  yes      no              │
   │        │            대답한 문제의 bbox로 GET /photo/crop
 그대로   해당 bbox로     → 고해상 크롭을 튜터링 시작 호출에 사용
 튜터링   /photo/crop
 (추가    → 크롭 재분석
 지연 0)  (실패 경로 한정)
```

지연 요약: 1개+성공 = 0 (bbox 필드는 응답 토큰 ~20개), 2개 이상 = 체감 0
(크롭 50ms가 질문-대답 구간에 숨고 튜터링 호출은 어차피 필요), 1개+실패 =
크롭 재분석 1회 ~3초 (현행 "다시 찍어달라" 요청보다 빠르고 화질 동일 보장).

## 컴포넌트 변경

### pi-server/app.py

1. `_capture_full()`이 원본을 `/tmp/photo_full.jpg`(q95)로 보관하고,
   전송용 `/tmp/photo.jpg`는 폭 2048 리사이즈본(q85)으로 저장한다.
   PIL(Pillow) 사용 — picamera2 의존으로 이미 설치돼 있다.
2. 새 엔드포인트 `GET /photo/crop?ymin=&xmin=&ymax=&xmax=` (0~1000 정규화,
   Gemini box_2d 좌표계 그대로). 동작:
   - `/tmp/photo_full.jpg`에서 bbox를 픽셀로 환산해 crop
   - 각 변에 bbox 크기의 5% 여백을 더하고 프레임 경계로 클램프
     (모델 박스 오차 흡수)
   - 크롭 결과 폭이 2048 초과면 2048로 리사이즈, 이하면 원본 픽셀 유지
   - JPEG q95로 응답
   - 보관본 없으면 404, 좌표 비정상(min≥max, 0~1000 밖)이면 400
3. `/capture/region`(ScalerCrop 재촬영)은 남겨두되 이 흐름에서는 쓰지
   않는다. 실측 후 불필요 확정되면 별도 정리.

### 앱 (src/)

1. `piBridge.service.ts`: `fetchPiPhotoBase64()`의 manipulateAsync 리사이즈
   삭제(Pi가 이미 2048폭으로 줌). 새 함수
   `fetchPiPhotoCropBase64(box2d: [number, number, number, number])` 추가 —
   `/photo/crop` 호출, base64 반환, 리사이즈 없음.
2. `gemini.service.ts`: `RESPONSE_SCHEMA`에 추가
   ```
   problems: ARRAY of OBJECT {
     label: STRING   // 학생에게 읽어줄 문제 식별자, 예: "3번"
     box_2d: ARRAY of INTEGER  // [ymin,xmin,ymax,xmax], 0~1000
   }
   ```
   프롬프트에 bbox 규약 한 줄 추가(0~1000 정규화, 문제 지문+보기+학생
   풀이 영역 포함). `GeminiTutoringResponse` 타입에 동일 필드 추가.
3. `useTutoringFSM.ts` 분기:
   - `problems.length <= 1` && confidence OK → 현행 그대로 (변경 없음)
   - `problems.length >= 2` → 질문 발화("몇 번 풀고 있어?"), 학생 대답을
     label과 매칭 → `fetchPiPhotoCropBase64(bbox)` → 그 크롭으로 튜터링
     시작 분석 호출. 대답이 label과 매칭 안 되면 풀프레임으로 폴백해
     현행 흐름 지속(추가 되묻기 없음).
   - `error_type === 'OCR_FAILED' | 'LOW_IMAGE_QUALITY'` && `problems`에
     bbox 있음 → 재촬영 요청(onCameraNeeded) 전에 크롭 재분석 1회 시도.
     크롭 재분석도 실패하면 현행 onCameraNeeded 경로로.
   - 이 분기는 Pi 경로에서만 동작. 폰 카메라 경로(CameraScreen)는 크롭
     소스가 없으므로 현행 유지 — `problems` 필드는 무시된다.

## 실패 처리

- Gemini가 `problems`를 안 주거나 빈 배열 → 문제 1개로 간주, 현행 흐름.
  스키마 추가 필드는 폰 경로 포함 어디서도 필수값이 아니다.
- `/photo/crop` 404/400/네트워크 오류 → 풀프레임으로 폴백, 현행 흐름.
  크롭은 전 구간에서 "실패하면 오늘과 동일 동작"인 순수 개선 레이어다.
- Pi 보관본은 다음 촬영 시 덮어쓴다. 크롭 요청과 새 촬영이 겹치는 경합은
  기존 `_capture_lock`으로 직렬화한다.

## 테스트

- **pi-server**: 하드웨어 없이 도는 크롭 함수 단위 체크 1개 — 합성 이미지
  (회색 배경 + 좌표 알려진 흰 사각형)에 bbox를 주고 여백·클램프·경계
  케이스(bbox가 프레임 모서리에 걸침, min≥max 거부)를 assert.
- **앱**: `useTutoringFSM` 분기 테스트 — problems 0/1/2개, label 매칭
  실패, 크롭 fetch 실패 폴백. 기존 FSM 테스트 패턴을 따른다.
- **실측 (수동)**: 같은 책상 배치에서 현행 대비 크롭본 인식 성공률과
  1개/2개 경로 체감 지연 확인. `docs/process.md`에 결과 기록.

## 범위 외

- SDK 교체(`@google/generative-ai` → `@google/genai`) 및
  `media_resolution: ULTRA_HIGH` — 크롭 효과 실측 후 부족할 때만.
- AWB/색 보정 — 인식률 무관.
- OpenCV 문서 검출 — Gemini bbox로 대체되어 불채택.
- `/capture/region` 제거 여부 — 실측 후 판단.
- 폰 카메라 경로 변경 없음.

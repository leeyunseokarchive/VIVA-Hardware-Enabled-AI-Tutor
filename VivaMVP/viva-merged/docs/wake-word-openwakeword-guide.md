# "비바야" 온디바이스 호출어 만들기 (openWakeWord, 완전 무료·오프라인)

이 문서는 목소리 녹음 없이 Google Colab로 "비바야" 호출어 모델을 만들고, 서버 없이
React Native 앱(viva-merged) 안에서 직접 돌리는 전체 과정을 정리한 것이다.

전체 흐름:
1. Colab에서 "비바야" 모델 학습 → `.onnx` 파일 확보 (무료, 30~60분)
2. 앱에 실행 환경 구축 (onnxruntime + 마이크 PCM 스트림, 네이티브 리빌드)
3. 모델을 앱에 넣고 `useWakeWord`에 연결
4. 임계값(민감도) 튜닝

> 중요: 지금 앱은 이 작업 전에도 기존 STT 방식으로 "비바야"가 (덜 안정적이지만) 동작한다.
> openWakeWord는 그 위에 얹는 개선이고, 모델/실행부가 준비되기 전까지는 STT로 자동 폴백한다.

---

## Part A. Colab에서 "비바야" 모델 학습하기

### A-1. 준비
- Google 계정 (Colab 무료 티어면 충분, GPU 런타임 사용)
- 인터넷 브라우저만 있으면 됨. 로컬 설치 없음.

### A-2. 학습 노트북 열기
1. openWakeWord GitHub로 이동: https://github.com/dscripka/openWakeWord
2. 저장소의 `notebooks/` 폴더에 있는 **automatic model training** 노트북(`automatic_model_training.ipynb`)을
   "Open in Colab" 버튼으로 연다. (README의 Training 섹션에 Colab 링크가 있다.)
3. Colab 상단 메뉴 `런타임 > 런타임 유형 변경`에서 **하드웨어 가속기 = GPU** 로 설정.

### A-3. 핵심 설정값
노트북에서 학습 대상 단어를 지정하는 셀을 찾아 아래처럼 바꾼다.

- **target word(타겟 단어)**: `bibaya`
  - 한글 "비바야"로도 되지만, 합성 음성(TTS)이 영어 발음으로 샘플을 만들기 때문에
    영어 발음 표기 `bibaya`가 인식률이 더 안정적이다. 필요하면 `biba ya`, `bibaya` 등
    표기를 바꿔가며 두어 번 실험.
  - 3음절 이상 + 받침 있는 발음이 오인식이 적다. "비바야"는 이 조건에 맞아 유리하다.
- **출력 포맷**: 반드시 **ONNX** 를 포함시킨다.
  - 블로그 등 Home Assistant용 가이드는 `.tflite`를 받지만, 우리는 앱에서 onnxruntime로
    돌리므로 `.onnx`가 필요하다. 노트북에 `.tflite`/`.onnx` 출력 옵션이 있으면 onnx를 켠다.

### A-4. 실행 & 다운로드
1. 셀을 위에서부터 순서대로 실행(▶). 합성 데이터 생성 + 학습이 자동 진행된다. GPU로 대략 30~60분.
2. 끝나면 결과물이 생성된다:
   - `bibaya.onnx` ← **우리가 쓸 커스텀 모델** (핵심)
3. openWakeWord는 실행 시 아래 **공용 특징 추출 모델 2개**도 함께 필요하다. 저장소에서 받아둔다
   (노트북 실행 중 자동으로 받아지기도 함. 없으면 openWakeWord 저장소 `models/`에서 다운로드):
   - `melspectrogram.onnx`
   - `embedding_model.onnx`
4. 이렇게 총 3개 파일을 확보한다: `melspectrogram.onnx`, `embedding_model.onnx`, `bibaya.onnx`

> 팁: 각 `.onnx`의 실제 입력/출력 텐서 이름과 shape는 https://netron.app 에 파일을 끌어다 놓으면
> 확인할 수 있다. Part C 코드에서 이 이름/shape가 맞아야 하므로, 한 번 확인해두면 디버깅이 쉽다.

---

## Part B. 앱 실행 환경 구축

### B-1. 필요한 패키지
viva-merged 폴더에서 설치한다.

```bash
cd viva-merged
npm install onnxruntime-react-native react-native-live-audio-stream
```

- `onnxruntime-react-native`: 폰에서 ONNX 모델을 오프라인으로 실행하는 런타임.
- `react-native-live-audio-stream`: 마이크에서 16kHz PCM 오디오 프레임을 실시간으로 받아온다.

### B-2. .onnx 를 에셋으로 인식시키기 (metro.config.js)
Metro가 `.onnx` 파일을 번들에 포함하도록 프로젝트 루트에 `metro.config.js`를 만든다.
(이미 있으면 `assetExts`에 `onnx`만 추가)

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('onnx');
module.exports = config;
```

### B-3. 모델 파일 넣기
`viva-merged/src/assets/wakeword/` 폴더를 만들고 Part A에서 받은 3개 파일을 넣는다.

```
src/assets/wakeword/melspectrogram.onnx
src/assets/wakeword/embedding_model.onnx
src/assets/wakeword/bibaya.onnx
```

### B-4. 네이티브 리빌드 (필수)
onnxruntime과 오디오 스트림은 네이티브 모듈이라 JS 새로고침으론 안 되고 반드시 다시 빌드한다.

```bash
npx expo run:android
```

---

## Part C. 코드 연동

openWakeWord 실행 파이프라인은 오디오 → 멜스펙트로그램 → 임베딩 → 호출어 점수 순서로 흐른다.
아래 순서로 붙인다. (실제 구현 코드는 모델의 입출력 이름/shape에 맞춰 함께 작성 예정 —
Part A에서 netron으로 확인한 값이 필요하다.)

파이프라인 개요:
1. `react-native-live-audio-stream`로 16kHz mono PCM16 프레임을 계속 받는다(80ms=1280샘플 단위).
2. 롤링 오디오 버퍼 → `melspectrogram.onnx` → 멜 프레임.
3. 멜 프레임 76개 창 → `embedding_model.onnx` → 96차원 임베딩.
4. 임베딩 16개 창 → `bibaya.onnx` → 0~1 확률 점수.
5. 점수가 임계값(예: 0.5) 이상이면 "비바야" 감지 → `onDetected()` 호출.

이 로직을 `src/lib/openWakeWord.ts` 러ntime 모듈로 만들고, 기존 `useWakeWord`가
Porcupine 대신 이 모듈을 1순위로 쓰고 실패 시 STT로 폴백하도록 바꾼다(구조는 앞서 만든
Porcupine 폴백과 동일).

> 이 단계는 모델 파일이 있어야 정확히 짤 수 있다(텐서 이름/shape/임계값이 모델마다 다름).
> Part A에서 `bibaya.onnx`가 나오면, 그 파일 기준으로 실행 모듈과 useWakeWord 연결을
> 정확히 작성해 커밋한다.

---

## Part D. 튜닝

- **오인식이 많다(TV·잡담에 반응)**: 임계값(threshold)을 0.5 → 0.6~0.7로 올린다.
- **잘 못 알아듣는다**: 임계값을 0.4~0.45로 내리거나, Part A에서 타겟 표기(`bibaya` vs `biba ya`)를
  바꿔 재학습.
- **배터리/발열**: 항상 켜두는 마이크라 소모가 있다. 홈 화면(idle)에서만 켜고 다른 화면에선 끄는
  현재 구조를 유지하면 최소화된다.

---

## 요약 체크리스트
- [ ] Colab에서 `bibaya.onnx` 학습 완료 (+ melspectrogram.onnx, embedding_model.onnx 확보)
- [ ] `npm install onnxruntime-react-native react-native-live-audio-stream`
- [ ] `metro.config.js`에 `onnx` assetExt 추가
- [ ] `src/assets/wakeword/`에 3개 모델 파일 배치
- [ ] `npx expo run:android` 네이티브 리빌드
- [ ] (모델 확보 후) 실행 모듈 + useWakeWord 연결 작성
- [ ] 임계값 튜닝

가장 먼저 Part A(Colab 학습)부터 진행하고, `bibaya.onnx`가 나오면 Part C 코드를 함께 완성한다.

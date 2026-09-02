# "비바야" 호출어 모델 재학습 파이프라인 (2026-08-14)

Colab 없이 로컬에서 도는 재학습 레시피. 기존 영어 TTS 합성("bibaya") 모델이
실발화 recall 0.14 로 실측돼(10회 중 1~2회 반응) 만들었다. 결과 모델은
`src/assets/wakeword/bibaya.onnx` (구모델은 `bibaya_tts_en.onnx` 로 백업).

## 구성

- `synth.py` — Google TTS ko-KR 41화자로 양성("비바야" 운율/속도/피치 변형)·
  음성(유사발음 하드 네거티브 + 과외 도메인 문장) 클립 합성. 16kHz WAV.
  `TTS_KEY` 환경변수 필요(.env 의 `EXPO_PUBLIC_GOOGLE_TTS_API_KEY`).
  429 쿼터는 백오프로 자동 재시도, 기존 파일은 스킵(이어받기 가능).
- `train.py` — 원거리 증강(감쇠 0.04~0.35·SNR 4~22dB·합성 잔향·저역통과·
  랜덤 정렬) → repo 의 mel/embedding onnx 로 특징 추출(런타임과 동일하게
  int16 스케일 float32) → 기존 bibaya.onnx 와 동일 구조 헤드 학습 →
  홀드아웃 화자 6명에서 신/구 비교 → 동일 텐서명으로 ONNX export.

라벨링이 핵심: 발화 종료 직후 끝나는 윈도우만 양성, 단어 앞부분만 들리는
윈도우는 음성 — 런타임의 "새로 끝나는 윈도우만 채점" + WakeFireGate 와 정합.

## 실행

```bash
python3 -m venv venv && ./venv/bin/pip install onnx onnxruntime numpy soundfile scipy torch
export TTS_KEY=<GOOGLE_TTS_API_KEY>
./venv/bin/python synth.py    # data/ 에 ~1600 클립, 수 분
./venv/bin/python train.py    # CPU ~15분, bibaya_ko.onnx 출력
cp bibaya_ko.onnx ../../src/assets/wakeword/bibaya.onnx
```

## 2026-08-14 결과 (홀드아웃 화자)

| 임계값 | 신모델 recall / 오탐 | 구모델 recall |
|---|---|---|
| 0.08 | 0.984 / 5.6% | 0.137 |
| 0.30 | 0.947 / 3.3% | 0.067 |

오탐 %는 유사발음 공격 셋 기준 윈도우 단위 — 실환경은 2연속 홉 게이트·쿨다운이
추가로 거른다. 교체 후 실기기 오탐이 늘면 `OWW_THRESHOLD` 0.08→0.2 부터
(recall 0.963 유지), 그다음 `OWW_STRONG_SCORE` 0.3→0.5.

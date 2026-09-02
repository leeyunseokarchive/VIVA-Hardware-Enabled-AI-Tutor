# Pi 호출어 스트림 설계

## 범위

- iPhone 앱은 전면 실행·화면 켜짐, Pi와 같은 Wi-Fi에 연결된 MVP.
- INMP441에서 `비바야`를 말하면 Pi가 문제 사진을 촬영하고 iPhone이 대화 세션을 연다.
- Gemini STT·튜터 FSM은 iPhone, TTS 출력은 MAX98357 Pi 스피커가 담당한다.
- 백그라운드 iOS 수신, 오프라인 Gemini, Pi 내부 ONNX 추론은 범위 밖이다.

## 선택

Pi가 16kHz mono PCM을 WebSocket으로 iPhone에 보낸다. iPhone은 기존
`OpenWakeWordEngine`과 `hey_viva.onnx`로 판정한다. Pi Zero에는 ONNX 런타임을
추가하지 않는다.

## 흐름

1. 앱 홈이 Pi `:8788`에 연결하고 `subscribe`를 보낸다.
2. `viva-wake.service`는 `micboost`를 `arecord`로 읽어 PCM binary frame을 연결된 앱에 보낸다.
3. 앱의 기존 wake-word 엔진이 `비바야`를 한 번 감지한다.
4. 앱은 `pause`를 보내고 Pi의 `paused` 응답을 기다린다. 이 시점에 wake 서비스가 `arecord`를 종료해 마이크를 놓는다.
5. 앱은 기존 Pi 사진 촬영·세션 시작 경로를 호출한다. 대화 화면은 Pi 마이크 녹음과 Pi 스피커 TTS를 사용한다.
6. 세션 종료·홈 복귀 시 앱은 `resume`을 보내 다시 대기 스트림을 시작한다.

## 실패 처리

- 연결·스트림 오류: 호출어 대기는 off, 기존 앱 촬영 버튼은 계속 사용 가능.
- `pause` 확인 실패: 사진·녹음을 시작하지 않는다. 두 `arecord`가 같은 I2S 캡처를 경쟁하지 않게 한다.
- 연결이 끊기면 Pi는 구독자를 제거하고 캡처 프로세스를 멈춘다.
- 호출어 감지 뒤 1.5초 재감지 억제는 기존 엔진 정책을 유지한다.

## 검증

1. `비바야` 10회 호출에서 사진 촬영·대화 화면 진입 확인.
2. 호출어 아닌 발화 10회에서 사진 촬영 0회 확인.
3. 호출 직후 학생 발화가 Pi 녹음·Gemini 전사로 이어지는지 확인.
4. 대화 종료 뒤 호출어 대기가 재개되는지 확인.

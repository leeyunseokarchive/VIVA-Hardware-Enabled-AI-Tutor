# VivaApp - VivaHW 통신 스펙

날짜: 2026-07-21

## 구조

Pi가 HTTP 서버, VivaApp이 클라이언트. 턴 기반 요청-응답 방식이며 half-duplex라 지속 스트리밍은 불필요.

## 대화 한 턴 흐름

1. 학생 발화 시작 → Pi가 녹음, 필요하면 사진도 촬영
2. 녹음 종료 → VivaApp이 Pi에 요청해 오디오+사진 수신
3. VivaApp이 Gemini API 호출
4. 응답을 TTS로 변환
5. VivaApp이 TTS 오디오를 Pi로 전송
6. Pi가 스피커로 재생 (재생 중 마이크 mute, 에코 처리 불필요)

## Pi 엔드포인트 (안)

- 녹음 시작/종료
- 촬영된 사진 + 녹음 파일 가져오기
- TTS 오디오 받아서 재생

Flask/FastAPI 등 가벼운 서버로 충분.

## 폰이 Pi를 찾는 방법

- Pi에 avahi-daemon 설치 후 `viva.local` 같은 고정 호스트명 사용
- 또는 공유기에서 Pi에 고정 IP 할당

## 다음 단계

- 엔드포인트 3개 실제 스펙(요청/응답 형식) 확정
- Pi 서버 프레임워크 선정 및 프로토타입

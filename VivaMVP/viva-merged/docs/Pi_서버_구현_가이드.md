# Pi 서버 구현 가이드

날짜: 2026-07-21

> **업데이트(2026-07-22):** 이 문서의 코드는 최초 초안이고, 실제 프로젝트에
> 반영된 최종 코드는 `/pi-server` (Pi 쪽 Flask 서버)와
> `src/services/piBridge.service.ts`, `src/hooks/usePiVoiceInput.ts`
> (VivaApp 쪽)에 있다. 아래와 달라진 점: TTS가 mp3로 오므로 aplay 대신
> mpg123으로 재생하도록 수정, USB 오디오 카드 번호를 환경변수로 분리,
> 녹음 방치 방지용 워치독 추가, 사진 단독 촬영 엔드포인트 추가, iOS/Android
> 로컬 네트워크 권한을 app.json에 반영.

## 준비물

Pi Zero WH에 Raspberry Pi OS Lite를 설치하고 SSH로 접속한 상태를 전제로 한다.

```bash
sudo apt update
sudo apt install -y python3-pip python3-picamera2 alsa-utils
pip3 install flask --break-system-packages
```

USB 오디오 동글을 꽂은 뒤 `arecord -l`, `aplay -l`로 장치 인식 여부를 먼저 확인한다.

## 서버 코드 (app.py)

```python
from flask import Flask, request, send_file
from picamera2 import Picamera2
import subprocess
import os

app = Flask(__name__)
picam2 = Picamera2()
picam2.configure(picam2.create_still_configuration())
picam2.start()

RECORDING_PATH = "/tmp/recording.wav"
PHOTO_PATH = "/tmp/photo.jpg"

recording_process = None

@app.route("/record/start", methods=["POST"])
def record_start():
    global recording_process
    # USB 오디오 동글 카드 번호는 arecord -l로 확인 후 hw:1,0 등으로 교체
    recording_process = subprocess.Popen([
        "arecord", "-D", "hw:1,0", "-f", "S16_LE", "-r", "16000", RECORDING_PATH
    ])
    return {"status": "recording"}

@app.route("/record/stop", methods=["POST"])
def record_stop():
    global recording_process
    if recording_process:
        recording_process.terminate()
        recording_process.wait()
    picam2.capture_file(PHOTO_PATH)
    return {"status": "stopped"}

@app.route("/capture/audio", methods=["GET"])
def get_audio():
    return send_file(RECORDING_PATH, mimetype="audio/wav")

@app.route("/capture/photo", methods=["GET"])
def get_photo():
    return send_file(PHOTO_PATH, mimetype="image/jpeg")

@app.route("/play", methods=["POST"])
def play_audio():
    audio_file = request.files["audio"]
    save_path = "/tmp/tts_output.wav"
    audio_file.save(save_path)
    subprocess.run(["aplay", "-D", "hw:1,0", save_path])
    return {"status": "played"}

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
```

부팅 시 자동 실행하려면 systemd 서비스로 등록한다.

```bash
sudo tee /etc/systemd/system/viva-server.service << EOF
[Unit]
Description=Viva HW Server
After=network.target

[Service]
ExecStart=/usr/bin/python3 /home/pi/app.py
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable viva-server
sudo systemctl start viva-server
```

## 호스트명 설정 (viva.local)

```bash
sudo apt install -y avahi-daemon
sudo hostnamectl set-hostname viva
```

설정 후 폰에서 `http://viva.local:5000`으로 접속 가능한지 확인한다.

## VivaApp(React Native) 쪽 호출 코드

```javascript
const PI_URL = "http://viva.local:5000";

async function startRecording() {
  await fetch(`${PI_URL}/record/start`, { method: "POST" });
}

async function stopRecordingAndFetch() {
  await fetch(`${PI_URL}/record/stop`, { method: "POST" });
  const audioRes = await fetch(`${PI_URL}/capture/audio`);
  const photoRes = await fetch(`${PI_URL}/capture/photo`);
  const audioBlob = await audioRes.blob();
  const photoBlob = await photoRes.blob();
  return { audioBlob, photoBlob };
}

async function playOnPi(ttsAudioBlob) {
  const formData = new FormData();
  formData.append("audio", ttsAudioBlob, "tts.wav");
  await fetch(`${PI_URL}/play`, { method: "POST", body: formData });
}
```

## 테스트 순서

1. Pi에서 `python3 app.py` 실행 후 같은 WiFi에 붙은 노트북에서 `curl -X POST http://viva.local:5000/record/start`로 녹음이 시작되는지 확인
2. `curl -X POST http://viva.local:5000/record/stop` 후 `/capture/audio`, `/capture/photo`를 curl로 받아 파일이 정상인지 확인
3. 임의 wav 파일을 `/play`에 POST해서 스피커로 재생되는지 확인
4. 위 세 개가 되면 VivaApp에서 같은 흐름을 실제로 호출

## 참고

- USB 오디오 카드 번호(`hw:1,0`)는 장치마다 다를 수 있어 `arecord -l`로 반드시 확인 후 코드에 반영
- 사진 해상도, 오디오 샘플레이트는 Gemini API 요구 사항에 맞춰 추후 조정

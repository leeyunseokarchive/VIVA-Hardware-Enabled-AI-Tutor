# VivaHW Pi 서버 설치

## 설치

```bash
sudo apt update
sudo apt install -y python3-pip python3-picamera2 alsa-utils avahi-daemon mpg123
pip3 install flask --break-system-packages

sudo hostnamectl set-hostname viva
```

## 오디오 (I2S: INMP441 마이크 + MAX98357 앰프, 2026-08-03 실기기 확정)

배선(물리 핀 번호): 마이크 VDD→1(3.3V, **5V 꽂으면 즉사**)·GND→9·L/R→6(GND)·SD→38,
앰프 Vin→2(5V)·GND→14·DIN→40. 공유 클럭 BCLK(12)·LRCLK(35)는 두 모듈에 Y 분기.

`/boot/firmware/config.txt` 에 추가 후 재부팅:

```
dtparam=audio=off
dtoverlay=googlevoicehat-soundcard
```

```bash
sudo cp asound.conf /etc/asound.conf          # micboost(녹음)·dmixout(재생) 정의
sudo cp viva-silence.service /etc/systemd/system/   # 앰프 팝 방지 무음 스트림
sudo systemctl daemon-reload && sudo systemctl enable --now viva-silence
arecord -D micboost -f S16_LE -r 16000 -d 1 /dev/null   # MicBoost 컨트롤 생성
amixer -c 0 sset MicBoost 90% && sudo alsactl store      # 게인 설정 + 재부팅 영속화
aplay -D dmixout -t raw -f S16_LE -r 48000 -c 2 -d 1 /dev/zero  # Speaker 컨트롤 생성
sudo systemctl stop viva-silence                          # 아래 "볼륨 변경" 참조
amixer -c 0 sset Speaker 85% && sudo alsactl store       # 재생 볼륨 + 영속화
sudo systemctl start viva-silence
```

재생 볼륨 `Speaker`(softvol)는 4Ω 3W 스피커 기준 85%(약 -7dB)가 시작점 -
풀스케일이 MAX98357A 5V/4Ω 최대출력(3.2W, 10%THD)을 때려 소리가 깨진다.
깨지면 내리고 작으면 90%까지 올린다. 하드웨어로 더 줄이려면 앰프 GAIN 핀을
9dB(기본)→6dB 로 내리는 방법도 있다.

**볼륨 변경 시 viva-silence 를 먼저 내려야 한다** - softvol 엘리먼트는
그 PCM 을 열고 있는 프로세스가 있는 동안 잠긴다(무음 스트림이 상시 열어
둠). 잠긴 채 쓰면 `amixer sset` 은 "Invalid command!", `cset` 은
"Operation not permitted" 가 난다(실측 2026-08-20). stop → sset →
alsactl store → start 순서. MicBoost 는 녹음 중이 아니면 그냥 써진다.

`arecord -l` 에 `voicehat` 카드가 떠야 정상. 다른 오디오 구성(USB 동글 등)으로
바꾸면 `viva-server.service` 환경변수 `VIVA_RECORD_DEVICE`/`VIVA_PLAY_DEVICE` 로 교체.

로봇 마이크 모드(D-33)의 발화 종료는 **서버가 감지**한다 - `/record/start` 후
서버 스레드가 RMS 를 보다가 발화 시작 후 `VIVA_SILENCE_MS`(기본 2000) 침묵이면
자동 종료, 앱은 `/record/status` 를 폴링한다. 임계값 `VIVA_SILENCE_THRESHOLD`
(기본 0.009)는 status 응답의 `rms` 실측치(잡음 바닥 ~0.003)를 보고 조정한다.
재생 중단은 `POST /play/stop` (barge-in).

## 눈 렌더러 (eyes.py, D-34)

폰이 WS(`ws://viva.local:8787`)로 `{"eyeState":"idle|calling|processing|conversation"}`
를 밀어넣으면 480×480 원형 HDMI 패널에 눈 애니메이션을 그린다. 앱 쪽 스위치는
`.env` 의 `EXPO_PUBLIC_EYE_SYNC_WS_URL=ws://viva.local:8787` (미설정 = 기능 off).

```bash
sudo apt install -y python3-pygame python3-websockets
# fonts/ 필수: 한글 안내 문구 폰트 동봉(Pretendard, OFL) - 빠지면 아이콘만 뜬다
cp -r eyes.py fonts /home/viva/pi-server/
sudo cp viva-eyes.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now viva-eyes
sudo systemctl restart viva-eyes   # 이미 떠 있으면 enable --now 는 no-op - 새 폰트/코드 반영에 restart 필요
```

기존 로봇 업그레이드 시 옛 폰트 잔재 제거: `rm /home/viva/pi-server/fonts/NanumGothic-Regular.ttf /home/viva/pi-server/fonts/OFL.txt` (Pretendard 로 대체됨).

출력은 SDL 이 아니라 `/dev/fb0` 직접 기록(RGB565) + `FBIO_WAITFORVSYNC` 동기 -
SDL kmsdrm 은 이 패널에서 깜빡였다. **카메라 상시 스트리밍도 화면을 깜빡이게
한다**(SDRAM 대역폭 경합) - 그래서 app.py 가 카메라를 촬영 때만 켜고 유휴
`VIVA_CAMERA_IDLE_STOP`(기본 5초) 후 끈다. 촬영 중 잠깐의 깜빡임은 정상.

## 부팅/종료 화면 (splash.py, D-4x)

전원을 켠 직후(리눅스 부팅 로고~viva-eyes 기동 전)와 종료 중(viva-eyes 가
내려간 뒤)에 검은 화면 대신 "ARTFLY" 워드마크 + 로딩 닷(말줄임표식 점등)을
보여준다.
Pi 는 싱글코어 ARMv6 1GHz 라 이 구간엔 python/pygame 을 아예 안 띄운다 -
설치 시 `splash.py --bake` 로 raw RGB565 프레임을 1회 구워두고, 런타임은
`sh` + `cat` 으로 그 파일을 그대로 `/dev/fb0` 에 흘려보낼 뿐이다.

```bash
sudo apt install -y python3-pil python3-numpy   # --bake 가 Pillow+numpy 로 프레임을 렌더 - picamera2 가 이미 끌고 왔으면 no-op
cp splash.py /home/viva/pi-server/
mkdir -p /home/viva/pi-server/fonts && cp fonts/Pretendard-Bold.otf /home/viva/pi-server/fonts/  # fonts/ 는 이미 있으면 파일만 추가됨
python3 /home/viva/pi-server/splash.py --bake   # splash/ 밑에 boot-00~11.raw + off.raw 생성 (cd 없이 - splash.py 는 __file__ 기준 경로를 씀)
sudo cp viva-splash.service viva-splash-off.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable viva-splash viva-splash-off   # 둘 다 부팅 시 자동 시작(오프 유닛은 종료 훅용)
```

`viva-splash.service` 는 `viva-eyes.service` 앞에 오도록 `Before=` 로만
걸려 있고, splash 를 실제로 내리는 것은 `viva-eyes.service` 의
`ExecStartPre=+/bin/systemctl stop viva-splash.service` 다 (fb0 경합 금지).
예전에는 `Conflicts=viva-eyes.service` 를 썼는데, 부팅 트랜잭션에서 두 유닛의
start 잡이 충돌하면서 eyes 시작 잡이 소거돼 눈이 영영 안 뜨는 사고가 났다
(2026-08-18). **`Conflicts` 를 되살리지 말 것** - 근거는 `viva-splash.service`
파일 상단 주석에 남아 있다. `--bake` 를 안 돌려 `splash/boot-00.raw` 가 없으면
`ConditionPathExists` 에 걸려 조용히 스킵된다(에러 루프 방지).
`viva-splash-off.service` 는 정지 순서가 시작 순서의 역순이라는 systemd
규칙을 이용한다 - eyes 보다 먼저 시작하도록 걸어(`Before=viva-eyes.service`)
종료 때는 eyes 보다 나중에 멈추게 하고, 그 ExecStop 에서 `off.raw` 를
fb0 에 쓴다(자세한 순서 근거는 유닛 파일 주석 참고).

리눅스 부팅 로고(레인보우 스퀘어/무지개 화면)를 없애려면
`/boot/firmware/config.txt` 에 추가:

```
disable_splash=1
```

`/boot/firmware/cmdline.txt` 는 **한 줄을 유지한 채** 끝에 옵션만
추가한다(줄바꿈 넣으면 부팅 안 됨):

```
... quiet logo.nologo vt.global_cursor_default=0
```

## WiFi 프로비저닝 (provision.py)

WiFi 미연결이면 눈 화면에 QR 안내를 띄우고 카메라로 VIVA 앱의 WiFi QR
(표준 WIFI: 포맷)을 읽어 nmcli 로 등록한다. 저장 네트워크가 없으면 즉시,
있는데 실패하면 부팅 30초/운영 180초 유예 후 안내가 뜬다. 실패 화면에
누를 것은 없다 - NM 자동연결 + 5초 폴링이 알아서 계속 재시도하고 "재연결
시도 중…" 문구만 뜬다 (터치 버튼은 2026-08-13 리허설 피드백으로 제거 -
무반응 + 자동 재시도가 이미 도는 거짓 어포던스).

```bash
sudo apt install -y python3-pyzbar
cp provision.py /home/viva/pi-server/
sudo cp viva-provision.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now viva-provision
```

전제: NetworkManager(bookworm 기본). `nmcli --version` 이 없으면 bullseye -
provision.py 의 nmcli 헬퍼 4개를 wpa_cli 로 바꿔야 한다. 스캔 중 카메라
가동으로 화면이 깜빡이는 것은 정상(SDRAM 경합 - 위 눈 렌더러 절 참고).

안내 문구는 eyes.py 가 그린다 - 폰트는 `fonts/Pretendard-Regular.otf` 로
repo 에 동봉(2026-08-12, 예전엔 apt fonts-nanum 이라 재설치 때마다 문구가
사라졌다). **eyes.py 옆에 `fonts/` 디렉토리가 같이 배포돼야 한다** - 빠지면
아이콘만 뜨고 `journalctl -u viva-eyes` 에 "한글 폰트 없음" 이 찍힌다.

카메라는 viva-server 와 공유한다: libcamera acquire 가 프로세스 배타라
app.py 는 촬영 때만 카메라를 열고 유휴 5초 후 **close(release)** 한다.
provision.py 도 화면이 정상으로 돌아오면 close 한다. 둘이 동시에 열면
늦은 쪽이 "Device or resource busy" - provision.py 는 1초 후 재시도하고,
app.py 는 해당 요청만 실패한다(앱이 재시도).

`viva-provision.service` 는 다른 서비스들과 맞춰 `User=viva` 로 돈다(원래
nmcli 제어에는 root 가 기본이지만 여기선 관례를 맞춤). 그 결과 `nmcli` 로
연결을 추가/수정하는 동작은 NetworkManager 의 polkit 정책상 기본적으로
root 나 활성 로컬 세션에만 허용된다 - 아래 규칙을 넣지 않으면 `nmcli device wifi connect`가
**조용히** 실패한다 (QR 은 읽었는데 영영 연결이 안 되는 증상):

```bash
sudo tee /etc/polkit-1/rules.d/50-viva-nm.rules > /dev/null <<'EOF'
polkit.addRule(function(action, subject) {
    if (subject.user == "viva" &&
        action.id.indexOf("org.freedesktop.NetworkManager.") == 0) {
        return polkit.Result.YES;
    }
});
EOF
sudo systemctl restart polkit
```

## WiFi 절전 끄기 (필수)

brcmfmac(BCM43430)의 WiFi 절전 모드는 트래픽이 잠깐 끊긴 직후 수신을
수 초~수십 초 스톨시킨다 - 앱의 `/health` 5초 폴링이 타임아웃돼
ConnectionMonitor 가 세션 중 connected/disconnected 를 플래핑하고, 그때마다
눈 WS·웨이크 리스너가 내려갔다 올라온다 (2026-08-14 실측: 저널상 요청이
38초간 서버에 미도달, 도착분은 전부 즉답 200 - 서버가 아니라 전송 계층).

프로파일 단위(`nmcli connection modify <이름> 802-11-wireless.powersave 2`)로
꺼도 되지만, provision.py 가 **새로** 등록하는 연결은 다시 기본(절전 on)이
된다 - 전역 conf 로 꺼야 재프로비저닝에도 유지된다:

```bash
sudo tee /etc/NetworkManager/conf.d/wifi-powersave.conf > /dev/null <<'EOF'
[connection]
wifi.powersave = 2
EOF
sudo systemctl reload NetworkManager
sudo nmcli connection up <활성 프로파일명>   # 즉시 적용 - reapply 는 이 속성 미지원
```

적용 확인: `sudo dmesg | grep power_mgmt` 마지막 줄이 `power save disabled`.

## 실행

```bash
# 경로/계정은 viva-server.service 의 User=viva, ExecStart=/home/viva/pi-server/app.py 와 맞춰야 한다
mkdir -p /home/viva/pi-server
cp app.py imaging.py audio_health.py /home/viva/pi-server/
sudo cp viva-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable viva-server
sudo systemctl start viva-server
```

`wake.py`(`viva-wake.service`)는 이 목록에 없다 - 별도로 배포해야 한다. 안 하면
`/health` 의 `mic_ok` 가 영구히 false 로 뜬다(아무도 마이크를 안 쥐므로).

```bash
cp wake.py /home/viva/pi-server/
sudo cp viva-wake.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now viva-wake
```

## 하드웨어 상태 (/health)

`/health` 는 연결 확인용 필드 외에 마이크·스피커 생존 여부를 같이 준다.

```json
{"status":"ok","recording":false,"record_device":"micboost",
 "play_device":"dmixout","mic_ok":true,"speaker_ok":true}
```

`/proc/asound/card0` 의 서브스트림이 열려 있는지만 본다 - 장치를 열지 않는다.
`micboost` 는 `plughw:0` 직결이라 캡처가 배타적이어서, 유휴 상태의 마이크는
`viva-wake` 가 쥐고 있다. 확인하려고 열어보면 그 서비스와 싸운다.

- `mic_ok` false → 가장 흔한 원인은 **지금 폰이 wake 릴레이를 구독하고 있지 않다**는
  것이다(캡처는 폰이 구독 중일 때만 열린다 - wake.py 참고). 서비스는 멀쩡히
  돌고 있으니 `systemctl status viva-wake` 로 죽었는지부터 확인하지 말고, 먼저
  폰이 디바이스 모드로 붙어 idle 화면인지 확인한다. 그래도 false 면 `viva-wake`
  가 죽었거나 `arecord` 가 바로 사망(마이크 모듈·배선 불량)
- `speaker_ok` false → `viva-silence` 가 죽어 앰프 경로가 끊김
- 둘 다 false → 사운드카드 자체가 안 잡힘 (`dtoverlay` 확인)

카드 번호가 0 이 아니면 `viva-server.service` 에 `VIVA_SOUND_CARD` 를 준다.
이 판정은 "소리가 실제로 들어온다"까지는 증명하지 않는다 - 게인이 리셋됐거나
마이크가 살아있되 무음인 경우는 못 잡는다.

## 테스트

```bash
curl http://viva.local:5000/health
curl -X POST http://viva.local:5000/record/start
sleep 3
curl -X POST http://viva.local:5000/record/stop
curl http://viva.local:5000/capture/audio -o test.wav
curl http://viva.local:5000/capture/photo -o test.jpg
```

## VivaApp 쪽

`src/device/services/piBridge.service.ts`가 이 서버를 호출한다. `.env`의
`EXPO_PUBLIC_PI_HOST`, `EXPO_PUBLIC_PI_PORT`로 주소를 맞춘다.

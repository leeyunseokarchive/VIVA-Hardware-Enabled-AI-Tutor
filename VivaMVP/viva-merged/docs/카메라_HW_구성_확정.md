# 카메라 모듈 및 HW 구성 확정

날짜: 2026-07-20 (최초) → **2026-07-21 최종 확정으로 갱신**

> **업데이트 (2026-07-21):** 아래 "최초 검토"에서 채택했던 ESP32-S3-Touch-LCD-3.5B 올인원 보드안은 **폐기**됐다. 최종 구성은 **Raspberry Pi Zero WH + 개별 부품**(카메라/디스플레이/마이크/스피커 각각 별도 모듈)으로 바뀌었다. 최신 확정 내용은 아래 "최종 확정 구성"을 따른다. 최초 검토 과정은 하단에 기록만 남긴다.

## 최종 확정 구성 (2026-07-21)

헤드 보드는 카메라/오디오 캡처만 담당하고, Gemini API 등 주 연산은 페어링된 폰 앱(VivaApp)이 처리한다.

### BOM

| 부품 | 모델 | 비고 |
|---|---|---|
| 컴퓨트 | Raspberry Pi Zero WH | Zero 2W 품절 대체. 카메라 JPEG는 GPU 하드웨어 인코딩이라 CPU 무관, 오디오도 half-duplex라 싱글코어로 충분 |
| 카메라 | Pi Camera Module 3 **Wide** | 12MP IMX708, AF, 102°×67°. 헤드 높이 25cm에서 펼친 B5 모의고사 커버 목적 |
| 디스플레이 | VIEWE 2.1" A013A HDMI 키트 | 원형 480×480 IPS, 정전식 터치(CST826), HDMI 드라이버 보드(Lontium LT6911C) 포함 |
| 마이크 | INMP441 (I2S MEMS) | — |
| 스피커 앰프 | MAX98357A (I2S DAC+앰프) | INMP441과 I2S 버스 공유 |
| 스피커 | FDS28 (8Ω 1W) | — |
| 전원 | micro-USB 5V ×2 (Pi + 드라이버 보드) | 배터리 없음, 유선 고정 |

### 연결 구성도

```mermaid
graph LR
    subgraph Power["전원 (유선 5V ×2)"]
        PWR1["micro-USB 5V\n(Pi 전원)"]
        PWR2["5V\n(드라이버 보드 전원)"]
    end

    Pi["Raspberry Pi Zero WH"]
    Cam["Pi Camera Module 3 Wide\n(12MP, AF, 102°×67°)"]
    Drv["HDMI 드라이버 보드\nLontium LT6911C\n(HDMI→MIPI DSI 브리지)"]
    Disp["VIEWE 2.1\" A013A\n원형 480×480 터치 디스플레이"]
    Mic["INMP441\n(I2S 마이크)"]
    Amp["MAX98357A\n(I2S DAC+앰프)"]
    Spk["FDS28 스피커\n(8Ω 1W)"]

    Cam -- "CSI 직결\n(15pin→22pin 어댑터)" --> Pi
    Pi -- "mini-HDMI\n(라이트앵글 필수)" --> Drv
    Drv -- "30핀 MIPI DSI 2lane" --> Disp
    Drv -- "USB-C → micro-USB OTG\n(라이트앵글, 터치 데이터)" --> Pi
    PWR1 --> Pi
    PWR2 --> Drv

    Pi -- "GPIO18 (SCK)\nGPIO19 (WS)\nGPIO20 (SD)" --> Mic
    Pi -- "GPIO18 (BCLK)\nGPIO19 (LRC)\nGPIO21 (DIN)" --> Amp
    Amp -- "스피커 출력 2핀" --> Spk

    style Pi fill:#369B75,color:#fff
    style Drv fill:#E8845C,color:#fff
```

### GPIO / 핀 배정

I2S 버스는 마이크(INMP441)와 앰프(MAX98357A)가 클럭 라인을 공유한다. 디스플레이·카메라·터치는 GPIO를 전혀 쓰지 않는다(CSI/HDMI/USB 전용 포트).

| 신호 | Pi GPIO | 연결 대상 |
|---|---|---|
| SCK / BCLK (공유 클럭) | GPIO18 | INMP441 SCK, MAX98357A BCLK |
| WS / LRC (공유 워드셀렉트) | GPIO19 | INMP441 WS, MAX98357A LRC |
| SD (마이크 입력) | GPIO20 | INMP441 SD |
| DIN (앰프 출력) | GPIO21 | MAX98357A DIN |
| VDD | 3.3V | INMP441 |
| VIN | 5V | MAX98357A |
| CSI 전용 포트 | — | Camera Module 3 (15pin→22pin 어댑터 케이블) |
| mini-HDMI 포트 | — | 드라이버 보드 J6 (풀사이즈 HDMI, 라이트앵글 필수) |
| micro-USB OTG(데이터) | — | 드라이버 보드 J9 USB-C (터치, 라이트앵글 필수) |
| micro-USB(전원) | — | Pi 5V 입력 (라이트앵글 권장, 굽힘 반경 절약) |

마이크+스피커 동시 사용은 배선 문제가 아니라 `config.txt`에 듀얼 I2S 오버레이 설정이 필요하다(소프트웨어 설정).

### 물리 배치 주의사항

- Pi Zero는 **포트 엣지(HDMI/USB)가 후방(조인트 쪽)**을 향하도록 장착 — 전방 장착 시 HDMI 플러그가 마이크 모듈과 충돌
- mini-HDMI, micro-USB OTG, micro-USB 전원 **3종 모두 라이트앵글(또는 FPV용 FFC 리본) 케이블 필수** — 스트레이트 플러그는 구형 쉘(⌀103.6mm) 내부 공간을 벗어남
- 전원 케이블 2가닥은 조인트 디스크 중앙 ⌀24 홀로 배출
- 에코 처리는 half-duplex(TTS 재생 중 마이크 mute)로 시작, barge-in 필요해지면 풀듀플렉스+AEC로 업그레이드 예정

### 남은 리스크

- 디스플레이 A013A 자체 기계 도면 미확보 — 렌즈 ⌀71.27은 형제 모델(A009A) 기준 가정, 실물 도착 시 렌즈 외경 재측정 필요
- 판매자 문서팩에 2.76인치(A045A, OD ⌀85) 패널 스펙이 섞여 있음 — 주문 시 "2.1inch A013A (OD ~71.3mm)" 명시 확인 필수, 아니면 페이스 재설계 필요
- 손글씨 인식 벤치마크(87.5% PASS)는 폰 카메라 기준 — Pi Camera Module 3 Wide는 센서가 작고 손떨림 보정 없어 재검증 필요

상세 구매 목록·링크는 `docs/superpowers/specs/2026-07-20-vivahw-electronics-config-design.md` (VivaHW 리포) 참고.

---

## 최초 검토 (2026-07-20, 폐기됨 — 기록용)

로봇 헤드 디자인 참고 이미지(Waveshare ESP32-S3-Touch-LCD-2.8C 스타일 원형 얼굴)를 기준으로 컴퓨트 보드와 카메라 모듈 구성을 검토했다. 처음 지목한 2.8C 보드는 화면과 카메라를 동시에 못 쓰는 구조라는 게 확인되어, 대안 보드와 카메라 배치 방식을 이 문서에서 검토했다. **최종적으로는 이 라인의 올인원 보드안 자체가 아래 "최종 확정 구성"으로 대체됐다.**

### 요구 사항

- 카메라: 최소 5백만 화소, 오토포커스. 이미지 속 로봇처럼 화면 아래 정면에 렌즈가 노출되는 배치가 목표
- 마이크·스피커: 화면과 같은 보드에 내장돼 있어 별도 배선 최소화
- 국내 조달: 카메라 모듈 자체는 국내 배송으로 빠르게 확보, 본체 보드는 해외 직구 허용
- 폼팩터: 원형 디스플레이 유지, 카메라는 후면 커넥터에서 케이블로 빼내 정면 배치

### 검토한 대안

1. **ESP32-S3-Touch-LCD-2.8C**: RGB 병렬 인터페이스로 화면을 구동해 GPIO를 16개 이상 소모, 카메라 커넥터 자체가 없음. 마이크·스피커도 부저뿐이라 요구 사항 미충족으로 제외.
2. **makerfabs ESP32-WROVER 3.5인치 사각 LCD + OV2640 완제품** (vctec.co.kr): 국내 즉시 배송 가능하지만 카메라가 2MP로 최소 요구 화소 미달, 원형 디자인도 아니라 제외.
3. **ESP32-S3-Touch-LCD-3.5B (당시 채택, 이후 폐기)**: QSPI 방식으로 화면을 구동해 GPIO 소모가 적고, 남는 핀으로 OV5640/OV2640용 24핀 카메라 커넥터를 확보. ES8311 오디오 코덱 내장으로 마이크·스피커 헤더까지 한 보드에 포함. 단, 카메라 커넥터와 마이크 위치가 보드 후면이라 정면 노출을 위해 케이블 연장이 필요했음.

### 당시 확정 스펙 (폐기됨)

- **보드**: Waveshare ESP32-S3-Touch-LCD-3.5 "With Camera-Case" 패키지 — ESP32-S3R8, 3.5인치 IPS 320×480 터치 디스플레이(ST7796 드라이버, FT6336 터치칩), ES8311 오디오 코덱(내장 마이크+6Ω 1W 스피커), QMI8658 6축 IMU, PCF85063 RTC, AXP2101 전원관리, 케이스와 OV5640 카메라까지 조립된 완제품
- **카메라**: OV5640 5MP, 24핀 0.5mm 피치 FPC 커넥터, 오토포커스 지원, QVGA(320×240)~2592×1944(5MP) 해상도 가변
- **마이크/스피커**: 보드 내장 SMD 마이크(후면) + 6Ω 1W 스피커

이 보드안은 실사용 배선 검증 단계에서 Pi Zero WH + 개별 부품 구성으로 전환됐다 — 사유는 "최종 확정 구성" 상단 참고.

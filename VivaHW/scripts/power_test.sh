#!/bin/bash
# VivaHW 전원 테스트 — 선풍기 배터리 + XL3608 부스트 → Pi Zero W
# Pi에 복사해서 실행: bash power_test.sh [지속시간(초), 기본 120]
#
# 판정 기준: get_throttled 비트
#   bit 0 (0x1)     : 지금 언더볼트 (4.63V 미만 순간 감지)
#   bit 16 (0x10000): 부팅 이후 언더볼트 발생 이력
#   bit 1/17        : ARM 주파수 제한 (지금/이력)
#   bit 2/18        : 스로틀링 (지금/이력)
# → 테스트 내내 0x0 이면 PASS. 0x50005 같은 값이 뜨면 전원 부족.

DURATION=${1:-120}
LOG=power_test_$(date +%Y%m%d_%H%M%S).log

echo "=== VivaHW 전원 테스트 (${DURATION}초) ===" | tee "$LOG"
echo "시작 전 상태 리셋 확인용 — 부팅 후 누적 플래그:" | tee -a "$LOG"
vcgencmd get_throttled | tee -a "$LOG"
echo "(0x0 이 아니면 이미 부팅 중 언더볼트가 있었다는 뜻 — 재부팅 후 다시 실행 권장)" | tee -a "$LOG"
echo | tee -a "$LOG"

# ── 백그라운드 모니터: 1초마다 전압 플래그·코어전압·CPU온도 기록 ──
(
  while true; do
    T=$(vcgencmd get_throttled | cut -d= -f2)
    V=$(vcgencmd measure_volts core | cut -d= -f2)
    TEMP=$(vcgencmd measure_temp | cut -d= -f2)
    FLAG=""
    [ "$T" != "0x0" ] && FLAG="  <-- 이상!"
    echo "$(date +%H:%M:%S)  throttled=$T  core=$V  temp=$TEMP$FLAG"
  done
) >> "$LOG" &
MON=$!

# ── 부하 단계 ──
echo "[1/4] 유휴 20초 (베이스라인)" | tee -a "$LOG"
sleep 20

echo "[2/4] CPU 풀부하 (전류 스파이크 유발)" | tee -a "$LOG"
timeout $((DURATION / 3)) sh -c 'yes > /dev/null' &
CPU_LOAD=$!

echo "[3/4] WiFi 부하 (다운로드 반복 — 무선이 전류 튀는 주범)" | tee -a "$LOG"
timeout $((DURATION / 3)) sh -c \
  'while true; do curl -s -o /dev/null http://speedtest.tele2.net/1MB.zip || break; done' &
NET_LOAD=$!

# 카메라가 연결돼 있으면 촬영 부하도 추가 (없으면 그냥 건너뜀)
if command -v libcamera-still >/dev/null 2>&1; then
  echo "[3.5] 카메라 촬영 부하" | tee -a "$LOG"
  timeout $((DURATION / 3)) sh -c \
    'while true; do libcamera-still -n -o /tmp/t.jpg 2>/dev/null || break; done' &
fi

wait $CPU_LOAD $NET_LOAD 2>/dev/null

echo "[4/4] 부하 종료, 10초 안정화" | tee -a "$LOG"
sleep 10
kill $MON 2>/dev/null

# ── 판정 ──
echo | tee -a "$LOG"
FINAL=$(vcgencmd get_throttled | cut -d= -f2)
echo "=== 최종 누적 플래그: $FINAL ===" | tee -a "$LOG"
if [ "$FINAL" = "0x0" ]; then
  echo "PASS — 테스트 내내 언더볼트/스로틀링 없음. XL3608 전원 OK." | tee -a "$LOG"
else
  echo "FAIL — 언더볼트 발생. 아래 확인:" | tee -a "$LOG"
  echo "  1) XL3608 트리머를 5.1V로 살짝 올려보기 (5.25V 넘기지 말 것)" | tee -a "$LOG"
  echo "  2) 배선 길이/굵기 — 가는 선은 전압강하 큼, AWG24 이상 권장" | tee -a "$LOG"
  echo "  3) 배터리 잔량 부족 시 부스트 입력전압 저하 → 충전 후 재시도" | tee -a "$LOG"
fi
echo "로그: $LOG"

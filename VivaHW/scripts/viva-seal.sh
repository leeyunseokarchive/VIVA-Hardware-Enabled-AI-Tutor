#!/bin/sh
# viva-seal: 골든 이미지 덤프 직전 마스터 정리.
# 실행하면 WiFi 프로파일이 지워지고 곧바로 꺼진다. SSH 세션이 끊기는 게 정상.
set -eu
[ "$(id -u)" = 0 ] || { echo "root 로 실행할 것 (sudo)" >&2; exit 1; }

# 1. 청소
find /home/viva/pi-server -name '*.bak*' -delete
rm -rf /home/viva/pi-server/__pycache__
apt-get clean
journalctl --vacuum-time=1s || true
rm -f /home/viva/.bash_history /root/.bash_history

# 2. 첫 부팅 유니크화 예약 (viva-firstboot.service 의 ConditionPathExists)
touch /etc/viva-firstboot-pending

# 3. machine-id 초기화 - 빈 파일이면 systemd 가 다음 부팅 때 새로 생성한다
truncate -s 0 /etc/machine-id

# 4. WiFi 프로파일 전부 삭제 + 종료. 이 상태가 이미지의 기준 상태다
#    (부팅하면 provision.py 가 QR 안내를 띄운다)
nmcli -t -f UUID,TYPE connection show \
  | awk -F: '$2=="802-11-wireless"{print $1}' \
  | xargs -r -n1 nmcli connection delete
poweroff

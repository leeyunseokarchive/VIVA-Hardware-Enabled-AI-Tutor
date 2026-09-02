#!/bin/sh
# viva-firstboot: 복제 이미지 첫 부팅 1회 유니크화. viva-seal.sh 가 예약한다.
# machine-id 는 systemd 가 스스로 재생성하므로 여기서는 SSH 호스트키만 처리.
set -eu
rm -f /etc/ssh/ssh_host_*
ssh-keygen -A
rm -f /etc/viva-firstboot-pending

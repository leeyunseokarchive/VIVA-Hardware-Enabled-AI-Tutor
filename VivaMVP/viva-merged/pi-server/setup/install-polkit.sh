#!/bin/bash
# VIVA 프로비저닝용 NetworkManager polkit 허용 설치 스크립트.
#
# 배경: viva-provision.service 는 User=viva 로 돌고 nmcli 로 연결을
# 추가/수정/활성화한다. NetworkManager 의 polkit 정책은 기본적으로 root
# 또는 활성 로컬 세션에만 이를 허용하므로, 규칙 없이는 systemd 경로에서
# `nmcli device wifi connect` 가 조용히 실패한다 (pi-server/README.md 참고.
# 08-12 실기기에서 미설치 확인 - SSH 세션은 통과하나 서비스 경로는 막힘).
#
# 사용법 (Pi 에서):  sudo bash install-polkit.sh
# 점검만:            bash install-polkit.sh --dry-run   (아무것도 쓰지 않는다)
#
# 두 형식을 모두 설치한다:
#  - rules.d JS 규칙: polkitd >= 0.106 (Raspberry Pi OS bookworm)
#  - localauthority .pkla: polkitd 0.105 (구형 bullseye 계열)
# 서로의 형식은 상대 버전에서 무해하게 무시되므로 버전 감지보다 단순하다.
# 재실행 시 내용이 같으면 건너뛴다(멱등).
set -euo pipefail

SERVICE_USER="viva"
RULES_FILE="/etc/polkit-1/rules.d/50-viva-nm.rules"
PKLA_FILE="/etc/polkit-1/localauthority/50-local.d/50-viva-nm.pkla"

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then DRY_RUN=1; fi

say() { echo "[install-polkit] $*"; }

if [ "$DRY_RUN" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
  say "FAIL: root 필요 - sudo 로 실행하거나 --dry-run 을 쓰세요"
  exit 1
fi

# README(98-108) 의 규칙 그대로 - provision.py 가 쓰는 nmcli 동작
# (connection modify/up, device wifi connect, device wifi rescan, device
# connect) 이 요구하는 액션은 settings.modify.system / network-control /
# wifi.scan 이지만, 단일 목적 기기라 프리픽스 전체 허용이 단순하고 안전하다.
RULES_CONTENT='polkit.addRule(function(action, subject) {
    if (subject.user == "viva" &&
        action.id.indexOf("org.freedesktop.NetworkManager.") == 0) {
        return polkit.Result.YES;
    }
});'

PKLA_CONTENT='[viva NetworkManager control]
Identity=unix-user:viva
Action=org.freedesktop.NetworkManager.*
ResultAny=yes
ResultInactive=yes
ResultActive=yes'

install_file() { # $1=경로 $2=내용
  if [ -f "$1" ] && [ "$(cat "$1")" = "$2" ]; then
    say "이미 설치됨 (내용 동일): $1"
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    say "DRY-RUN: $1 에 규칙을 쓸 예정"
    return 0
  fi
  mkdir -p "$(dirname "$1")"
  printf '%s\n' "$2" > "$1"
  chmod 644 "$1"
  say "설치함: $1"
}

install_file "$RULES_FILE" "$RULES_CONTENT"
install_file "$PKLA_FILE" "$PKLA_CONTENT"

if [ "$DRY_RUN" -eq 1 ]; then
  say "DRY-RUN 종료 - 파일/서비스를 건드리지 않았음"
  exit 0
fi

# polkitd 는 rules.d 를 자동 리로드하지만 확실히 하기 위해 재시작.
# 유닛 이름이 배포판마다 다르다(polkit vs polkitd). 둘 다 없으면 자동
# 리로드에 맡기고 경고만 남긴다.
systemctl restart polkit 2>/dev/null || systemctl restart polkitd 2>/dev/null \
  || say "경고: polkit 유닛 재시작 실패 - 자동 리로드에 의존"

# 서비스 재시작 - 규칙 반영 겸, 08-12 의 새 try_connect(c6a0613) 반영.
if systemctl restart viva-provision 2>/dev/null; then
  say "viva-provision 재시작 완료"
else
  say "경고: viva-provision 재시작 실패 (서비스 미설치?)"
fi

# 검증: 서비스 유저로 nmcli 권한을 직접 조회한다. sudo -u 로 뜬 프로세스는
# 활성 로컬 세션이 아니라서 systemd 서비스 경로와 같은 polkit 판정을 받는다
# - SSH 세션(활성 세션 취급)에서 그냥 nmcli 를 돌리면 통과해 버려서
# 08-12 처럼 미설치를 못 잡는다.
FAIL=0
for perm in org.freedesktop.NetworkManager.settings.modify.system \
            org.freedesktop.NetworkManager.network-control \
            org.freedesktop.NetworkManager.wifi.scan; do
  val="$(sudo -u "$SERVICE_USER" nmcli -t -f PERMISSION,VALUE general permissions 2>/dev/null \
         | grep -F "${perm}:" | cut -d: -f2 || true)"
  if [ "$val" = "yes" ]; then
    say "PASS: $perm = yes"
  else
    say "FAIL: $perm = ${val:-조회불가}"
    FAIL=1
  fi
done

if [ "$FAIL" -eq 0 ]; then
  say "전체 PASS - systemd 경로에서 nmcli 연결 등록/재시도 가능"
else
  say "전체 FAIL - 규칙 파일과 polkitd 버전(pkaction --version)을 확인하세요"
fi
exit "$FAIL"

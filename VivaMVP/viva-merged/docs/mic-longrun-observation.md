# 마이크 자동복구 장기 관찰 가이드 — 1시간 연속 세션

> 수치·로그 문자열 출처: `pi-server/wake.py`(MAX_QUICK_DEATHS=8, 백오프 1→2→4→5초 캡,
> respawn/포기 print 문), `pi-server/audio_health.py`(MIC_STICKY_S=10초), `app.py`(/health, :5000).
> **소스를 바꾸면 이 문서도 같이 갱신할 것.**

- 수행일: ____ / 수행자: ____ / 로봇 IP: ____ / wake.py 커밋: ____

## 0. 배경 — 무엇을 왜 보나

- 증상 이력: 유휴 화면에 "마이크 이상" 배지가 주기적으로 떴다가 앱 새로고침으로
  사라짐. 원인은 arecord 급사(EOF) 시 자동복구 부재였고 08-12 에 수리
  (process.md §4 8주차 항목 19, `c008bc7`): 구독자가 남아있으면 재기동, 이후
  항목 22(`28bc445` 등)에서 **지수 백오프 1→2→4→5초(캡) + 연속 급사
  MAX_QUICK_DEATHS=8회(합 ~32초) 초과 시 포기**로 상향 — 세션 종료 직후
  viva-server 와의 마이크 경합(최대 ~5초)을 자연 흡수하기 위함.
- 이 관찰 = 회의 TODO ② + §2 8주차 표 2번(납땜 후 검증: **1시간 연속 세션
  무신호 0회**)의 실행 절차. 폰/로봇 전사 A/B 는 별도 항목이라 여기 없음.
- 포기(giving up) 도달 시 `/health` 노출은 없다(ponytail 유예) — 배지가 상시로
  굳는 것이 유일한 사용자 가시 신호다. 그래서 journalctl 병행이 필수.

## 1. 준비

- [ ] Pi 에 최신 `wake.py` 배포 확인: `journalctl -u viva-wake -b --no-pager | head`
      에 `[viva-wake] ws listening on :8788`
- [ ] SSH 창 1 — 실시간 로그:
  ```
  journalctl -u viva-wake -f --no-pager | grep --line-buffered -E "capture started|respawning|giving up|arecord"
  ```
- [ ] SSH 창 2 (선택) — health 폴링: `watch -n 5 'curl -s http://<로봇IP>:5000/health'`
      (`mic_ok` 필드 관찰. 앱 배지와 같은 소스)
- [ ] 앱(VIVA for Device)을 로봇에 연결한 홈 화면으로 대기 — **wake 구독이 있어야
      arecord 가 돈다**(구독 0이면 마이크를 놓는 설계라 관찰이 성립하지 않음)
- [ ] 관찰 시작 시각 기록: ____

## 2. 절차 (60분)

1. 0~60분 동안 홈 화면 연결 상태를 유지한다.
2. **10분 간격으로 "비바야" 호출 → 한 턴 대화(사진/개념 아무거나) → 홈 복귀** —
   총 6회. 홈 복귀 직후가 `/record`(viva-server)와 wake 의 마이크 경합 구간이라
   재발이 가장 잘 나는 시점이다(항목 22 의 원인 지점).
3. 각 호출·배지 이벤트마다 §5 템플릿에 한 행씩 기록한다.
4. 60분 후 §4 의 사후 집계 명령을 돌려 마무리한다.

## 3. "마이크 이상" 배지 재발 관찰법 — 오탐과 실이상 구분

- **알려진 오탐 창 (수리 대상 아님**, audio_health.py 주석 명시): ① Pi 부팅 직후
  첫 폴(sticky 미적용) ② 홈 복귀 직후 resume 전에 5초 폴 한 틱이 끼는 경우.
  → **배지가 ~10초(MIC_STICKY_S) 안에 스스로 사라지면 "오탐"으로 기록.**
- **실이상**: 배지가 10초 이상 지속되거나, 앱을 새로고침해야만 사라짐
  (= 항목 19 의 원래 증상 재발). 이때 SSH 창 1 의 로그 유무가 판정 근거:
  respawning 이 찍히며 스스로 복구되면 "자동복구 동작", giving up 이면 "포기 도달".

## 4. arecord respawn / MAX_QUICK_DEATHS 도달 확인 (journalctl)

wake.py 가 찍는 로그 라인 (print 문 그대로):

- `[viva-wake] capture started` — 캡처 (재)기동
- `[viva-wake] capture died (EOF) - respawning (N, backoff Xs)` — N번째 연속 급사,
  X초 후 재기동 (X 는 1→2→4→5→5… 캡)
- `[viva-wake] capture keeps dying - giving up` — **연속 급사가 MAX_QUICK_DEATHS(8)
  를 초과해 포기.** 이후 mic_ok 는 영구 false → 배지 상시
- `arecord: ...` — arecord 자체의 사인(stderr 가 journal 로 들어옴).
  08-12 실증 예: `arecord: pcm_read:2272: read error: Interrupted system call`

사후 집계 (관찰 60분 기준):

```
journalctl -u viva-wake --since "-1h" --no-pager | grep -c "respawning"
journalctl -u viva-wake --since "-1h" --no-pager | grep "giving up"
journalctl -u viva-wake --since "-1h" --no-pager | grep -E "respawning|giving up|capture started"
```

판정:

- respawning 이 몇 번 나오다 `capture started` 로 이어지고 배지가 안 굳음
  = **자동복구 정상 동작** (respawning 횟수는 기록해 둔다 — 빈도 자체가
  하드웨어 상태 지표)
- `giving up` 등장 = **MAX_QUICK_DEATHS 도달.** 복구는 앱 재연결(재구독) 또는
  `sudo systemctl restart viva-wake`. 이 경우 배선(I2S Y 분기) 재의심 —
  `journalctl -u viva-wake --since "-1h" --no-pager > wake-giveup-$(date +%m%d-%H%M).log`
  로 전체 로그를 보존해 process.md §4 에 첨부

## 5. 기록 템플릿

| 시각 | 이벤트 (호출/홈 복귀/배지) | 배지 지속(초) | respawning 누계 | giving up | 당시 상황 (세션 중·유휴·복귀 직후) | 판정 (정상/오탐/실이상) |
|---|---|---|---|---|---|---|
| ____ | | | | | | |
| ____ | | | | | | |
| ____ | | | | | | |
| ____ | | | | | | |
| ____ | | | | | | |
| ____ | | | | | | |

**종합 (60분):**

- 배지 실이상 횟수: ____ / 오탐 횟수: ____
- respawning 총: ____ / giving up: [ ] 없음 [ ] 있음(시각 ____)
- 세션 6회 중 무신호(전사 빈 문자열/녹음 실패) 발생: ____ 회

**완료 기준:** 실이상 0회 + giving up 0회 + 무신호 0회 → §2 표 2번의 "1시간
연속 세션 무신호 0회" 충족. 결과를 process.md §4 히스토리에 기록(문서 갱신 규칙).
재발 시: respawning 로그·발생 시점(복귀 직후인지)을 §4 `막힌 것` 에 남기고,
wake.py 주석의 업그레이드 경로(포기를 /health 에 노출)를 다음 후보로 올린다.

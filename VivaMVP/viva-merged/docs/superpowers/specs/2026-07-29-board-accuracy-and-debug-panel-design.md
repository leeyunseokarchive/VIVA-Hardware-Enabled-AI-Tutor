# 판서 정확도(그라운딩+사후검증) & 세션 디버그 패널 설계

날짜: 2026-07-29 · 브랜치: fix/board-accuracy-pi-retake

## 배경

1. 판서(풀이) 이미지가 원본 문제의 기호/수치를 바꾸거나, 중요하지 않은 부분에
   강조를 넣는다. 원인: 이미지 모델이 사진만 보고 그리며(텍스트 근거 없음),
   생성 후 검증이 전혀 없다.
2. 개발 단계 디버깅 수단 부재. boardPrompt 는 저장 경로 버그로 항상 빈
   문자열로 저장되고, 크롭 폴백 단계(Tier1/Tier2/재촬영)·photoSource·이미지
   생성 실프롬프트·생성 소요시간은 콘솔 로그로만 남는다. `viva_session_events`
   테이블은 매 턴 저장되지만 읽는 UI가 없다.

## 1. 판서 그라운딩 + 사후검증 (승인: "그라운딩 + 사후검증 1회")

- **problem_facts**: `RESPONSE_SCHEMA`/`GeminiTutoringResponse` 에
  `problem_facts` (string) 추가. 분석 턴에서 문제 원문 전사(도형 종류,
  변/각 라벨, 주어진 수치, 표 구조, 사용 기호 그대로)를 받아
  `TutoringSession.problemFacts` 로 보관.
- **그라운딩**: `generateBoardImage` 가 problemFacts 를 받아 "PROBLEM GROUND
  TRUTH" 블록으로 주입. annotationRules 에 표기 충실성(원본 기호만 사용) +
  강조 절제(힌트가 지목한 요소 외 강조 금지) 규칙 추가.
- **사후검증**: 생성 직후 텍스트 모델 1회 호출 — 생성 이미지 + problemFacts
  대조, `{pass, issues[]}` JSON 판정. 불합격 → issues 를 수정 지시로 붙여 1회
  재생성. 재생성도 불합격 → 그대로 표시하고 판정만 기록 (튜터링 흐름 우선).
- 오케스트레이터 `generateVerifiedBoardImage` 가 위 루프 + 디버그 기록
  (실프롬프트 전문, genMs, 검증 판정, 재생성 여부)을 반환.

## 2. 디버그 데이터 저장

- **버그 수정 1**: `updateBoardData` 가 boardPrompt 를 받아 저장 경로에 전달
  (현재 `response?.board_prompt || ''` 가 항상 '' 로 평가되는 경로 유일).
- **버그 수정 2**: 대화 메시지 타임스탬프를 발화 시점에 기록 (현재 저장
  시점 `Date.now()` 로 일괄 덮어써 순서 신뢰 불가).
- `viva_sessions.debug` jsonb 컬럼 (마이그레이션 0005):
  `{ photoSource, problemFacts, captureAttempts[], boards[] }`
  - captureAttempt: `{ stage: initial|tier1_crop|tier2_recapture|problem_choice_crop|pi_retake|phone_retake, timestamp, box2d?, imageUrl? }`
    — 각 단계 이미지는 attempt-images 버킷 `{deviceId}/{sessionId}/debug-…jpg` 에 업로드.
  - board: `{ boardPrompt, fullPrompt, genMs, verify?, regenerated, timestamp }`
- 수집기: 모듈 레벨 `sessionDebug.service.ts` (sessionId 키, fire-and-forget
  업로드, backgroundSaveSession 이 저장 시점에 스냅샷 포함).
- 턴별 상태: 기존 `viva_session_events` 를 `loadSessionEvents(sessionId)` 로
  조회 (신규 저장 없음).

## 3. 디버그 UI (SessionDetailScreen, `__DEV__` 전용)

하단 접이식 "디버그" 섹션 (다크 dev-tool 카드, 모노스페이스 데이터):

- 촬영 파이프라인: 시도별 썸네일 + 단계 뱃지 + box_2d, 마지막 시도 "최종" 표시
- problemFacts / photoSource 블록
- 판서별: boardPrompt, 실프롬프트 전문(펼치기), genMs, 검증 판정(합/불 + issues), 재생성 여부
- 턴 타임라인: viva_session_events — 시간, fsm_state, confidence, wrongStreak 등
- 메시지 옆 상태 뱃지: 메시지 timestamp 와 ±5초 이벤트 매칭, 탭 시 인라인 상세

## 비범위

- 검증 다회 루프(2~3회) — 승인된 1회만
- viva_session_events 신규 필드 추가 — 기존 스키마 그대로 읽기만
- 프로덕션 노출 토글 — `__DEV__` 게이트만

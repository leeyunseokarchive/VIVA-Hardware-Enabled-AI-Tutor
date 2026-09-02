# 개념 대화 세션 기록 (Concept Session History)

작성: 2026-08-14

## 문제
세션 기록 페이지(HistoryScreen)에는 지금 **문제 풀이**(ConversationScreen /
useTutoringFSM) 대화만 저장·표시된다. **개념 대화**(IntentScreen /
useIntentLoop)는 `historyRef` 에만 쌓였다가 언마운트 시 소멸 — 기록이 안 남는다.

## 목표
개념 대화도 세션 레코드로 저장하고, 문제 풀이 세션과 **한 목록에 시간순으로
섞어 쌓되(Stack)** 필터로 가른다. 개념→문제풀이 전환은 상세 화면에서
**양방향 링크**로 잇는다.

## 결정 (사용자 확정 2026-08-14)
1. **개념 세션 경계**: IntentScreen 진입 1회 = 레코드 1개 (그 안의 개념 질문
   여러 개를 한 레코드로 묶음). 개념 턴이 0개면 저장 안 함.
2. **연결 다중도**: 개념 1 : 문제풀이 N. 자식(solve)이 부모(concept) id 를
   저장하고, 개념 상세에서 역조회한다 (개념 세션은 풀이가 생기기 전에 이미
   끝나므로 부모가 자식 목록을 들고 있을 수 없다).
3. **필터 위치**: 대화기록 탭 **안**에서 토글 (전체/개념/문제풀이). 오답노트
   탭은 그대로.
4. **양방향 링크**: 개념 상세 → 이어지는 문제풀이 버튼(들), 문제풀이 상세 →
   부모 개념 대화 백링크.
5. **목록 행 구분**: 좌측 라벨/배지 (개념 / 문제풀이).

## 데이터 모델
기존 `SessionHistoryEntry` 재사용 + 판별 필드 2개 (별도 타입/테이블 안 만듦):
- `kind: 'concept' | 'solve'` — 기존/문제풀이 = `'solve'` 기본값
- `parentConceptSessionId?: string` — 문제풀이 세션에만, 자기를 낳은 개념 id

Supabase 마이그레이션 `0007`: `viva_sessions` 에 `kind text not null default
'solve'`, `parent_concept_session_id text` 추가.

개념 레코드 필드값:
- `sessionId`: `concept-<ts>` (begin() 에서 1회 생성)
- `kind: 'concept'`, `finalState: 'HINT_STAGE'`(자리값 — 판별은 kind 로),
  `hintCount: 0`
- `messages`: historyRef (role/message, timestamp 는 저장 시각)
- `boardImages`: 개념 asset URL(`matched.imageUrl`)은 이미 public URL →
  업로드 없이 `SavedBoardImage.filePath` 로 바로. 생성 base64 는 solve 처럼
  `saveBoardImage` 업로드
- `preview`: 첫 개념 질문 slice(50) (Gemini 제목은 추후 — ponytail)
- `usage`: `EMPTY_USAGE_SUMMARY` (개념 토큰 집계는 추후 — ponytail)

## 연결 배선 (자식이 부모 가리킴)
```
useIntentLoop.begin(): conceptSessionId = concept-<ts>
  → runConceptTurn 매 턴: saveConceptSession (per-turn, no-shrink 가드가 보호)
  → runSolve → onAnalyzed(analysis, image, transcript, conceptSessionId?)
       (개념 턴 있었을 때만 conceptSessionId 넘김, 아니면 undefined)
App.handleAnalyzed(..., parentConceptSessionId)
  → toConversationPayload: payload.parentConceptSessionId
ConversationScreen: startSession 에 parentConceptSessionId 전달
useTutoringFSM.backgroundSaveSession: entry.kind='solve',
  entry.parentConceptSessionId = ref
```

## UI
### 목록 (HistoryScreen, 대화기록 탭)
- 상단 3단 필터 토글 (전체/개념/문제풀이), 디자인 톤은 SolveModeToggle /
  기존 탭 pill 계열. FlatList 를 `kind` 로 거름
- 각 행 좌측 배지 pill: 개념(그린 계열 `rgba(54,155,117,...)`) / 문제풀이(잉크
  계열). 기존 topicBadge 스타일 재사용
- `isWrongAnswerNote` 에 `entry.kind !== 'concept'` 가드 (개념은 채점 없음)

### 상세 (SessionDetailScreen)
- 개념 상세: 하단 섹션 "이어지는 문제 풀이" — `loadAllSessions()` 에서
  `parentConceptSessionId === 이 id` 인 solve 들 버튼(N개). `onSelectSession`
  으로 이동
- 문제풀이 상세: `parentConceptSessionId` 있으면 상단 백링크 버튼 "○○ 개념
  대화에서 시작됨"
- 상세→상세 이동: App 이 SessionDetailScreen 에 `onSelectSession=
  viewSessionDetail` 전달 (device/phone 양쪽)

## 디자인·애니메이션 통일
- 색/폰트: `theme.ts` 토큰만 (GREEN, INK, INK_MUTED, SURFACE_*, FONT)
- 모션: `MOTION.fast`(배지/버튼 등장), `MOTION.base`(전환). 필터 전환 시
  리스트 페이드는 기존 자막 크로스페이드 문법과 동일 (opacity Animated.timing)
- 배지/버튼 라운드·보더는 기존 topicBadge / sessionCard 값 재사용

## 파일 소유권 (병렬 작업 충돌 방지)
- 파운데이션(공유): SessionHistory.ts, AppState.ts, sessionHistory.service.ts,
  마이그레이션 0007, App.device.tsx, App.phone.tsx
- Agent A: useIntentLoop.ts (개념 저장 + onAnalyzed 4번째 인자)
- Agent B: useTutoringFSM.ts + ConversationScreen.tsx (solve 링크 저장)
- Agent C: HistoryScreen.tsx (필터 토글 + 배지 + 오답노트 가드)
- Agent D: SessionDetailScreen.tsx (양방향 링크)

## 범위 밖 (YAGNI)
- 개념 세션 토큰/비용 집계, Gemini 개념 제목, 정적 asset 이미지의 별도 처리,
  개념 오답노트, 개념↔풀이 N:N.

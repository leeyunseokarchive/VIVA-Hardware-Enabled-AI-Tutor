-- viva_sessions에 topic(중학교 3학년 수학 단원 분류) 컬럼 추가.
--
-- 배경: 세션의 단원을 더 이상 클라이언트 측 키워드 정규식 추측(guessTopic,
-- HistoryScreen.tsx)으로 계산하지 않고, Gemini가 매 턴 구조화 출력으로 직접
-- 분류한 값(RESPONSE_SCHEMA의 topic 필드)을 저장한다. 기존 행은 NULL로 남고,
-- 클라이언트는 topic이 NULL이면 guessTopic()으로 폴백한다.
--
-- 실행 방법: Supabase 대시보드 > SQL Editor에 아래 전체를 붙여넣고 실행한다.

alter table public.viva_sessions
  add column if not exists topic text;

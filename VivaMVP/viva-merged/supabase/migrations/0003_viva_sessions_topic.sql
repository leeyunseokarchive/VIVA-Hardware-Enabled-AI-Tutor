-- viva_sessions에 topic(단원) 컬럼 추가.
--
-- 배경: 오답노트(HistoryScreen/SessionDetailScreen)의 "단원" 배지가 지금까지는
-- 대화 텍스트를 정규식으로 스캔하는 클라이언트 사이드 휴리스틱(guessTopic())
-- 이었다. 이제 Gemini가 매 세션 문제의 실제 교육과정 단원명(예: "삼각비",
-- "원주각")을 구조화 응답의 topic 필드로 직접 판단해서 내려주므로, 이 값을
-- 세션과 함께 저장해 화면에서 그대로 쓴다.
--
-- 실행 방법: Supabase 대시보드 > SQL Editor에 아래 전체를 붙여넣고 실행한다.
-- (anon/publishable key로는 스키마 변경이 불가능해 에이전트가 직접 실행할 수
-- 없으므로 사용자가 직접 실행해야 한다.)

alter table public.viva_sessions
  add column if not exists topic text;

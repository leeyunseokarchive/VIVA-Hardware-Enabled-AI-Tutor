-- viva_sessions에 mistake_reason(틀린 이유) 컬럼 추가.
--
-- 배경: 학생이 틀린 스텝을 냈을 때, Gemini가 소크라테스식 질문 대신 구체적으로
-- 무엇이 왜 틀렸는지(부호 실수/계산 실수/개념 실수 등)를 구조화 응답의
-- mistake_reason 필드로 직접 판단해서 내려주도록 프롬프트를 바꿨다. 이 값을
-- 세션과 함께 저장해 오답노트 화면에서 "틀린 이유"로 그대로 보여준다.
--
-- 실행 방법: Supabase 대시보드 > SQL Editor에 아래 전체를 붙여넣고 실행한다.
-- (anon/publishable key로는 스키마 변경이 불가능해 에이전트가 직접 실행할 수
-- 없으므로 사용자가 직접 실행해야 한다.)

alter table public.viva_sessions
  add column if not exists mistake_reason text;

-- 개념 대화(useIntentLoop) 세션 기록 저장을 위한 컬럼 2개 추가.
--
-- 배경: viva_sessions 는 지금까지 문제 풀이(useTutoringFSM) 세션만 저장했다.
-- 개념 대화도 같은 테이블에 저장하되 kind 로 구분하고, 개념→문제풀이 전환은
-- 자식(solve)이 부모(concept) id 를 가리키는 parent_concept_session_id 로 잇는다.
-- 스펙: docs/superpowers/specs/2026-08-14-concept-session-history-design.md
--
-- 실행 방법: Supabase 대시보드 > SQL Editor에 아래 전체를 붙여넣고 실행한다.
-- (미적용 인스턴스에서도 앱은 죽지 않는다 - sessionHistory.service 가 컬럼
-- 부재 에러를 감지해 두 컬럼을 빼고 재저장한다.)

alter table public.viva_sessions
  add column if not exists kind text not null default 'solve',
  add column if not exists parent_concept_session_id text;

-- 개념 상세의 "이어지는 문제 풀이" 역조회 (parent 로 solve 행 찾기) 인덱스.
create index if not exists viva_sessions_parent_concept_idx
  on public.viva_sessions (parent_concept_session_id);

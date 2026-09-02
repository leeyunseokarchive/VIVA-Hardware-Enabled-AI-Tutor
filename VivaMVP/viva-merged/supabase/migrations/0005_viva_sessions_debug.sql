-- 개발용 세션 디버그 기록 (스펙 docs/superpowers/specs/2026-07-29-board-accuracy-and-debug-panel-design.md).
-- { photoSource, problemFacts, captureAttempts[], boards[] } 스냅샷 -
-- sessionDebug.service.ts 가 쓰고 SessionDetailScreen 의 __DEV__ 섹션이 읽는다.
--
-- 실행 방법: Supabase 대시보드 > SQL Editor 에서 실행 (anon key 로는 스키마
-- 변경 불가 - 0001 과 동일).

alter table public.viva_sessions
  add column if not exists debug jsonb;

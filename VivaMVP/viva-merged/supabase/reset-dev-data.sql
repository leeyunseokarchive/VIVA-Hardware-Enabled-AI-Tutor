-- 개발 데이터 초기화 (구조는 유지, 데이터만 삭제).
-- 테이블·버킷·정책은 그대로 남고 행과 Storage 파일만 지운다.
--
-- 실행 방법: Supabase 대시보드 > SQL Editor 에 붙여넣고 실행.
-- (anon key 로는 storage.objects 삭제 정책이 없어 앱에서는 못 지운다 -
--  SQL Editor 는 postgres 권한이라 가능.)
--
-- 주의: viva-merged 앱 데이터만 지운다. Repo 2(charing_viva)의
-- sessions / attempts / hint_logs 테이블은 건드리지 않는다.

-- 1) 세션 기록 + 턴 이벤트
truncate table public.viva_sessions;
truncate table public.viva_session_events;

-- 2) Storage 파일 (버킷 자체는 유지)
delete from storage.objects where bucket_id in ('board-images', 'attempt-images');

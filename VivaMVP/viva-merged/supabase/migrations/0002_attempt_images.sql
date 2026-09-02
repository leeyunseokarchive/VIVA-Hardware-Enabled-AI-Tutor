-- 학생이 촬영한 문제 사진(attempt image) 저장을 위한 마이그레이션.
--
-- 배경: 지금까지 문제 사진은 base64로 메모리에만 존재하고 Gemini 분석에만
-- 쓰였다. 이 마이그레이션은 charing_viva의 attempt-images 버킷 패턴을
-- viva-merged 세션 모델에 맞게 포팅한다: 세션당 문제 사진 1장을
-- attempt-images 버킷에 올리고, 공개 URL을 viva_sessions 행에 저장한다.
-- 오답노트/히스토리 카드가 이 URL을 썸네일로 사용한다.
--
-- 실행 방법: Supabase 대시보드 > SQL Editor에 아래 전체를 붙여넣고 실행한다.

-- 1) viva_sessions에 문제 사진 URL 컬럼 추가
alter table public.viva_sessions
  add column if not exists problem_image_url text;

-- 2) attempt-images Storage 버킷 (없으면 생성, public read 허용)
insert into storage.buckets (id, name, public)
values ('attempt-images', 'attempt-images', true)
on conflict (id) do update set public = true;

drop policy if exists "attempt_images_public_read" on storage.objects;
create policy "attempt_images_public_read" on storage.objects
  for select using (bucket_id = 'attempt-images');

drop policy if exists "attempt_images_anon_write" on storage.objects;
create policy "attempt_images_anon_write" on storage.objects
  for insert with check (bucket_id = 'attempt-images');

drop policy if exists "attempt_images_anon_update" on storage.objects;
create policy "attempt_images_anon_update" on storage.objects
  for update using (bucket_id = 'attempt-images');

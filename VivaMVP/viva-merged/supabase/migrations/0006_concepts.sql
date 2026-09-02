-- 개념 이미지·메타데이터를 앱 번들에서 Supabase로 이전하는 마이그레이션.
--
-- 배경: 개념 도해 PNG 20장(8.1MB)이 번들 require 맵(registry.ts)에 있고
-- 메타데이터(conceptList.ts)가 코드에 있어 개념 추가마다 앱 릴리즈가 필요했다.
-- 이 마이그레이션 후에는 tools/concept-images/generate.ts 가 이미지를
-- concept-images 버킷에, 메타를 concepts 테이블에 upsert 한다.
-- 스펙: docs/superpowers/specs/2026-08-13-concept-images-supabase-design.md
--
-- 실행 방법: Supabase 대시보드 > SQL Editor에 아래 전체를 붙여넣고 실행한다.

-- 1) concepts 테이블 (앱은 익명 read만, 쓰기는 service role 도구 스크립트 전용)
create table if not exists public.concepts (
  id text primary key,
  name text not null,
  aliases text[] not null default '{}',
  sketch text not null,
  image_path text
);

alter table public.concepts enable row level security;

drop policy if exists "concepts_public_read" on public.concepts;
create policy "concepts_public_read" on public.concepts
  for select using (true);

-- 2) concept-images Storage 버킷 (없으면 생성, public read 허용)
insert into storage.buckets (id, name, public)
values ('concept-images', 'concept-images', true)
on conflict (id) do update set public = true;

drop policy if exists "concept_images_public_read" on storage.objects;
create policy "concept_images_public_read" on storage.objects
  for select using (bucket_id = 'concept-images');

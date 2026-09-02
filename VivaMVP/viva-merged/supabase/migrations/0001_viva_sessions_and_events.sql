-- viva-merged FSM 세션 데이터 저장을 위한 마이그레이션.
--
-- 배경: 기존 Supabase 프로젝트에는 Repo 2(charing_viva)가 만든 `sessions` /
-- `attempts` / `hint_logs` 테이블이 이미 존재하지만, 그 스키마는 "사진 촬영 →
-- attempt 생성 → hint_level(1~3) 단계적 음성 힌트" 플로우 전용이다.
--
-- viva-merged 앱은 데이터 모델이 다르다 (FSM: HINT_STAGE/SOLVE_STAGE, 대화
-- 메시지 배열, 보드 이미지 배열, hintCount/wrongStreak/boardRegenerationCount,
-- API 사용량 요약). 기존 테이블 컬럼과 겹치지 않으므로, 이름 충돌을 피하기
-- 위해 새 테이블 `viva_sessions` / `viva_session_events`를 만든다.
--
-- 실행 방법: Supabase 대시보드 > SQL Editor에 아래 전체를 붙여넣고 실행한다.
-- (anon/publishable key로는 스키마 변경이 불가능해 에이전트가 직접 실행할 수
-- 없으므로 사용자가 직접 실행해야 한다.)

-- 1) 세션 히스토리 (HistoryScreen / SessionDetailScreen이 읽는 테이블)
create table if not exists public.viva_sessions (
  session_id text primary key,
  device_id text not null,
  started_at bigint not null,
  ended_at bigint not null,
  final_state text not null,
  hint_count integer not null default 0,
  messages jsonb not null default '[]'::jsonb,
  board_images jsonb not null default '[]'::jsonb,
  preview text,
  usage jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists viva_sessions_device_id_started_at_idx
  on public.viva_sessions (device_id, started_at desc);

-- 2) SessionEvent 로그 (sessionLog.service.ts의 logSessionEvent가 기록하는 테이블)
create table if not exists public.viva_session_events (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  app_state text not null,
  fsm_state text,
  hint_count integer,
  wrong_streak integer,
  board_regeneration_count integer,
  confidence numeric,
  error_type text,
  misconception_type text,
  meta jsonb,
  created_at timestamptz not null default now()
);

create index if not exists viva_session_events_session_id_idx
  on public.viva_session_events (session_id, created_at desc);

-- 3) RLS: MVP는 로그인 없이 device_id로만 구분하므로, anon key로 자유롭게
--    읽고 쓸 수 있도록 permissive 정책을 둔다 (Repo 2의 attempts/hint_logs와
--    동일한 신뢰 모델).
alter table public.viva_sessions enable row level security;
alter table public.viva_session_events enable row level security;

drop policy if exists "viva_sessions_anon_all" on public.viva_sessions;
create policy "viva_sessions_anon_all" on public.viva_sessions
  for all using (true) with check (true);

drop policy if exists "viva_session_events_anon_all" on public.viva_session_events;
create policy "viva_session_events_anon_all" on public.viva_session_events
  for all using (true) with check (true);

-- 4) 보드 이미지 저장용 Storage 버킷 (없으면 생성, public read 허용)
insert into storage.buckets (id, name, public)
values ('board-images', 'board-images', true)
on conflict (id) do update set public = true;

drop policy if exists "board_images_public_read" on storage.objects;
create policy "board_images_public_read" on storage.objects
  for select using (bucket_id = 'board-images');

drop policy if exists "board_images_anon_write" on storage.objects;
create policy "board_images_anon_write" on storage.objects
  for insert with check (bucket_id = 'board-images');

drop policy if exists "board_images_anon_update" on storage.objects;
create policy "board_images_anon_update" on storage.objects
  for update using (bucket_id = 'board-images');

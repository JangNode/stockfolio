create table if not exists public.strategies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  rule_type text not null,
  rule_params jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists strategies_user_id_idx on public.strategies (user_id);

alter table public.strategies enable row level security;

create policy "strategies_select_own"
  on public.strategies
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "strategies_insert_own"
  on public.strategies
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "strategies_delete_own"
  on public.strategies
  for delete
  to authenticated
  using (auth.uid() = user_id);

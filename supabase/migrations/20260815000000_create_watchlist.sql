create table if not exists public.watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  stock_code text not null,
  stock_name text not null,
  created_at timestamptz not null default now(),
  unique (user_id, stock_code)
);

create index if not exists watchlist_user_id_idx on public.watchlist (user_id);

alter table public.watchlist enable row level security;

create policy "watchlist_select_own"
  on public.watchlist
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "watchlist_insert_own"
  on public.watchlist
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "watchlist_delete_own"
  on public.watchlist
  for delete
  to authenticated
  using (auth.uid() = user_id);

create table if not exists public.screening_results (
  id uuid primary key default gen_random_uuid(),
  strategy_id uuid not null references public.strategies (id) on delete cascade,
  stock_code text not null,
  stock_name text not null,
  signal_price numeric not null,
  entry_price numeric not null,
  stop_loss_price numeric not null,
  take_profit_price numeric not null,
  current_price numeric not null,
  return_pct numeric not null,
  status text not null default 'active' check (status in ('active', 'stopped', 'profited')),
  matched_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists screening_results_strategy_id_idx on public.screening_results (strategy_id);
create index if not exists screening_results_status_idx on public.screening_results (status);

-- 같은 전략이 같은 종목을 동시에 두 번 추적하지 않도록, active 상태는 (strategy_id, stock_code)
-- 쌍당 하나만 허용한다. 배치 스크립트도 애플리케이션 레벨에서 미리 걸러내지만 이 인덱스가 최종 방어선이다.
create unique index if not exists screening_results_active_unique_idx
  on public.screening_results (strategy_id, stock_code)
  where status = 'active';

alter table public.screening_results enable row level security;

-- 쓰기는 배치 스크립트(service_role, RLS 우회)만 하고, 로그인 사용자는 자신의 전략에 딸린
-- 결과만 조회할 수 있다.
create policy "screening_results_select_own"
  on public.screening_results
  for select
  to authenticated
  using (
    exists (
      select 1 from public.strategies
      where strategies.id = screening_results.strategy_id
        and strategies.user_id = auth.uid()
    )
  );

-- 배치 실행 기록(스캔이 언제 끝났는지). "마지막 스캔 시각"을 정확히 보여주려면 매칭 건수가
-- 0이어도(장 휴무 등) 실행 자체는 기록돼야 하므로 screening_results와 별도로 둔다.
create table if not exists public.screening_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  scanned_count integer not null default 0,
  matched_count integer not null default 0,
  error_count integer not null default 0
);

alter table public.screening_runs enable row level security;

-- 특정 사용자 소유 데이터가 아니라 배치 자체의 메타데이터라 로그인 사용자 전체에게 읽기를 연다.
create policy "screening_runs_select_authenticated"
  on public.screening_runs
  for select
  to authenticated
  using (true);

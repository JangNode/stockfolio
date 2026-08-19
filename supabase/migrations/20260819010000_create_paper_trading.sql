-- "AI 모의투자": Claude가 스스로 세운 전략(공격형/안정형)으로 가상 자본을 굴리는
-- 기능. 개별 사용자 소유가 아니라 앱 전역에서 공유하는 데모 데이터라 screening_runs와
-- 같은 패턴(로그인 사용자 전체에 읽기 공개, 쓰기는 service_role만)을 그대로 따른다.

-- 전략 버전 이력. 재생성될 때마다 새 행을 추가하고 이전 행은 retired 처리해서,
-- 스타일별로 항상 정확히 하나의 활성 전략만 남긴다("전략 히스토리" 화면이 이 표를
-- version 순으로 그대로 나열한다).
create table if not exists public.paper_strategies (
  id uuid primary key default gen_random_uuid(),
  style text not null check (style in ('aggressive', 'conservative')),
  version integer not null,
  label text not null,
  entry_conditions jsonb not null,
  exit_conditions jsonb not null,
  stock_selection_criteria jsonb not null,
  rationale text not null,
  model text not null,
  raw_response jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  retired_at timestamptz
);

create unique index if not exists paper_strategies_active_unique_idx
  on public.paper_strategies (style)
  where is_active;

create unique index if not exists paper_strategies_style_version_idx
  on public.paper_strategies (style, version);

alter table public.paper_strategies enable row level security;

create policy "paper_strategies_select_authenticated"
  on public.paper_strategies
  for select
  to authenticated
  using (true);

-- 공격형/안정형 가상 계좌. 정확히 두 행만 존재한다(아래 insert로 시드).
create table if not exists public.paper_portfolios (
  id uuid primary key default gen_random_uuid(),
  style text not null unique check (style in ('aggressive', 'conservative')),
  initial_capital numeric not null default 1000000,
  cash numeric not null default 1000000,
  created_at timestamptz not null default now()
);

alter table public.paper_portfolios enable row level security;

create policy "paper_portfolios_select_authenticated"
  on public.paper_portfolios
  for select
  to authenticated
  using (true);

insert into public.paper_portfolios (style)
values ('aggressive'), ('conservative')
on conflict (style) do nothing;

-- 현재 보유 종목. 종목당 한 행만 유지하고(추가 매수는 수량/평단가 갱신), 전량
-- 매도되면 행을 삭제한다 — "현재 보유 종목" 화면이 이 표를 그대로 조회하면 된다.
create table if not exists public.paper_positions (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.paper_portfolios (id) on delete cascade,
  stock_code text not null,
  stock_name text not null,
  quantity integer not null check (quantity > 0),
  avg_price numeric not null,
  screening_result_id uuid references public.screening_results (id),
  opened_strategy_id uuid not null references public.paper_strategies (id),
  opened_at timestamptz not null default now(),
  unique (portfolio_id, stock_code)
);

create index if not exists paper_positions_portfolio_id_idx on public.paper_positions (portfolio_id);

alter table public.paper_positions enable row level security;

create policy "paper_positions_select_authenticated"
  on public.paper_positions
  for select
  to authenticated
  using (true);

-- 전체 매매 원장(매수/매도 append-only). "매매 내역" 화면이 traded_at 역순으로 그대로 보여준다.
create table if not exists public.paper_trades (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.paper_portfolios (id) on delete cascade,
  strategy_id uuid not null references public.paper_strategies (id),
  stock_code text not null,
  stock_name text not null,
  side text not null check (side in ('buy', 'sell')),
  quantity integer not null,
  price numeric not null,
  amount numeric not null,
  realized_pnl numeric,
  rationale text not null,
  screening_result_id uuid references public.screening_results (id),
  traded_at timestamptz not null default now()
);

create index if not exists paper_trades_portfolio_id_idx on public.paper_trades (portfolio_id);
create index if not exists paper_trades_traded_at_idx on public.paper_trades (traded_at desc);

alter table public.paper_trades enable row level security;

create policy "paper_trades_select_authenticated"
  on public.paper_trades
  for select
  to authenticated
  using (true);

-- 일별 평가금액 스냅샷. 보유 종목 시세가 매매 없이도 매일 바뀌므로, "일간 수익률"을
-- 정확히 구하려면 거래 유무와 무관하게 매일 한 행씩 남겨야 한다(screening_runs와
-- 같은 이유로 별도 표로 분리).
create table if not exists public.paper_daily_snapshots (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.paper_portfolios (id) on delete cascade,
  snapshot_date date not null,
  cash numeric not null,
  holdings_value numeric not null,
  equity numeric not null,
  daily_return_pct numeric not null,
  cumulative_return_pct numeric not null,
  created_at timestamptz not null default now(),
  unique (portfolio_id, snapshot_date)
);

create index if not exists paper_daily_snapshots_portfolio_id_idx
  on public.paper_daily_snapshots (portfolio_id, snapshot_date);

alter table public.paper_daily_snapshots enable row level security;

create policy "paper_daily_snapshots_select_authenticated"
  on public.paper_daily_snapshots
  for select
  to authenticated
  using (true);

-- 배치 실행 기록(screening_runs와 동일한 목적).
create table if not exists public.paper_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  buy_count integer not null default 0,
  sell_count integer not null default 0,
  error_count integer not null default 0
);

alter table public.paper_runs enable row level security;

create policy "paper_runs_select_authenticated"
  on public.paper_runs
  for select
  to authenticated
  using (true);

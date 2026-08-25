-- "실험실" 탭의 커스텀 조건 백테스트(전체 종목 풀 대상) 요청/결과를 저장하는 표.
-- 매칭 종목 전체 목록과 거래 내역처럼 무거운 데이터는 Supabase Storage에 별도
-- 업로드하고(다음 단계 작업), 여기엔 상태와 요약 통계만 남겨 DB 용량을 가볍게 유지한다.
-- 개인 실험 데이터라 strategies 표와 같은 패턴(사용자 소유 + is_approved() RLS)을 쓴다.
create table if not exists public.custom_backtest_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  market text not null check (market in ('KR', 'US')),
  rule_params jsonb not null,
  period_months integer not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  total_return_pct numeric,
  win_rate numeric,
  mdd_pct numeric,
  matched_stock_count integer,
  trade_count integer,
  result_storage_path text,
  error_message text,
  adopted_at timestamptz,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists custom_backtest_runs_user_id_idx
  on public.custom_backtest_runs (user_id, created_at desc);

alter table public.custom_backtest_runs enable row level security;

create policy "custom_backtest_runs_select_own"
  on public.custom_backtest_runs
  for select
  to authenticated
  using ((select auth.uid()) = user_id and public.is_approved());

create policy "custom_backtest_runs_insert_own"
  on public.custom_backtest_runs
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id and public.is_approved());

-- paper_strategies/paper_portfolios의 style은 지금 'aggressive'/'conservative'만
-- 허용한다. 실험실에서 채택한 커스텀 전략을 위한 3번째 슬롯('custom')을 나중에
-- 추가할 수 있도록 제약만 미리 넓혀 둔다(실제 'custom' 행 시딩과 배치 스크립트 반영은
-- 채택 플로우 작업에서 함께 처리한다 — 지금 미리 행을 만들면 paper-trade.ts의 "정확히
-- 스타일x시장 개수만큼 있어야 한다" 가드가 오늘 배치부터 깨진다).
alter table public.paper_strategies drop constraint if exists paper_strategies_style_check;
alter table public.paper_strategies add constraint paper_strategies_style_check
  check (style in ('aggressive', 'conservative', 'custom'));

alter table public.paper_portfolios drop constraint if exists paper_portfolios_style_check;
alter table public.paper_portfolios add constraint paper_portfolios_style_check
  check (style in ('aggressive', 'conservative', 'custom'));

-- "전략 관리" 탭의 "장기 백테스트(2016~오늘)" 섹션이 읽는 캐시 테이블. 실계좌
-- 스크리닝 추적 기반의 "전략 성과 비교"(표본이 적음)와 달리, 생존편향 보정된
-- KR 전용 다년치 Storage 시세(lib/stockDailyPricesStorage.ts)로 2016년부터
-- 오늘까지 전종목을 매주 한 번 재계산한 결과를 담는다
-- (scripts/compute-strategy-backtest-summary.ts, 매주 월요일 실행).
--
-- 매번 새 행을 insert하는 이력 테이블이다(덮어쓰기 아님) — rule_type+market
-- 조합별로 계산 시점(computed_at)이 다른 여러 행이 쌓이고, API는 그중 가장 최신
-- 행만 골라 내려준다. market은 US도 허용해두지만(나중을 위한 여지), 이번 배치는
-- KR만 계산한다 — US는 생존편향 보정된 다년치 시세 Storage가 없다.
--
-- 다른 공유·전역 시장 데이터 테이블과 동일하게 select 정책을 추가하지 않는다
-- (service_role만 읽고 쓰며, 클라이언트는 항상 Next.js API 라우트를 거친다 —
-- supabase/migrations/20260925000000_create_krx_trading_calendar.sql과 동일 패턴).
create table public.strategy_backtest_summary (
  id uuid primary key default gen_random_uuid(),
  rule_type text not null,
  market text not null check (market in ('KR', 'US')),
  period_start_date date not null,
  period_end_date date not null,
  computed_at timestamptz not null default now(),
  universe_stock_count integer not null,
  win_rate numeric,
  avg_return_pct numeric,
  median_return_pct numeric,
  mdd_pct numeric,
  cagr_pct numeric,
  total_trades integer not null,
  closed_trades integer not null,
  forced_liquidation_count integer not null,
  forced_liquidation_ratio numeric,
  top5_exclude_return_pct numeric
);

create index strategy_backtest_summary_rule_type_market_computed_at_idx
  on public.strategy_backtest_summary (rule_type, market, computed_at desc);

alter table public.strategy_backtest_summary enable row level security;

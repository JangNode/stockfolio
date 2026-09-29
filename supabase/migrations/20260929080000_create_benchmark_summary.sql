-- "장기 백테스트" 카드의 벤치마크 비교(코스피/코스닥/유니버스 동일가중 월간
-- 리밸런싱)를 저장한다. strategy_backtest_summary와 별도 테이블로 분리한 이유:
-- 승률/거래수/손익비 등 그 테이블 컬럼 대부분이 벤치마크에는 의미가 없어(항상
-- null) 스키마가 지저분해지고, API/UI에서 "전략인지 벤치마크인지"를 매번
-- 분기해야 하기 때문(2026-09-29 조사 결론).
--
-- 공유 시장 데이터 테이블이라 RLS 활성화 + select 정책은 두지 않는다(service_role만
-- 읽고 쓰고, 클라이언트는 API 라우트를 거친다) — strategy_backtest_summary와 동일한
-- 패턴.
--
-- 매번 새 행을 insert하는 이력 테이블이다(덮어쓰기 아님) — benchmark_type 조합별로
-- 계산 시점(computed_at)이 다른 여러 행이 쌓이고, API는 그중 가장 최신 행만 골라
-- 내려준다(scripts/compute-strategy-backtest-summary.ts, 매주 월요일 실행).
create table public.benchmark_summary (
  id uuid primary key default gen_random_uuid(),
  benchmark_type text not null, -- 'kospi' | 'kosdaq' | 'universe_monthly_rebalance'
  period_start_date date not null,
  period_end_date date not null,
  computed_at timestamptz not null default now(),
  cagr_pct numeric not null,
  mdd_pct numeric not null,
  calmar_ratio numeric not null,
  cost_included boolean not null default false
);

create index benchmark_summary_benchmark_type_computed_at_idx
  on public.benchmark_summary (benchmark_type, computed_at desc);

alter table public.benchmark_summary enable row level security;

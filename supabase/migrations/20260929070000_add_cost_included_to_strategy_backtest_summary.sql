-- 거래비용(수수료/증권거래세/슬리피지) 반영 전/후 이력을 구분하기 위한 컬럼.
-- 기존 행은 비용 미반영이라 기본값 false로 남고, 이번 수정 이후 새로 계산되는
-- 행부터 true로 저장한다(scripts/compute-strategy-backtest-summary.ts).
alter table public.strategy_backtest_summary
  add column cost_included boolean not null default false;

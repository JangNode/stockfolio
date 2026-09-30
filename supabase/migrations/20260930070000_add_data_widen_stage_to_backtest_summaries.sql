-- 전종목 확장 재백필(2015~2026) 도중 계산된 중간 상태 수치가 화면에 노출되지 않게,
-- 각 행이 어떤 원자료 확장 단계에서 계산됐는지 구분하는 컬럼을 추가한다(2026-09-30
-- 승인). 값: 'narrow'(재백필 전 기존 행), 'partial_2023_2026'(2026-09-30 01:38 UTC
-- 시험 배치 행), 'full'(재백필 완료 후 행). nullable — 새 배치가 항상 값을 채운다.
alter table public.strategy_backtest_summary add column data_widen_stage text;
alter table public.benchmark_summary add column data_widen_stage text;

-- 기존 행의 이 컬럼만 채운다(다른 컬럼은 건드리지 않는다).
update public.strategy_backtest_summary
  set data_widen_stage = case
    when computed_at >= '2026-09-30 01:00:00+00' and computed_at < '2026-09-30 02:00:00+00'
      then 'partial_2023_2026'
    else 'narrow'
  end
  where data_widen_stage is null;

update public.benchmark_summary
  set data_widen_stage = case
    when computed_at >= '2026-09-30 01:00:00+00' and computed_at < '2026-09-30 02:00:00+00'
      then 'partial_2023_2026'
    else 'narrow'
  end
  where data_widen_stage is null;

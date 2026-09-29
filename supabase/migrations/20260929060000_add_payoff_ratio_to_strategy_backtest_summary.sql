-- "장기 백테스트" 카드에 손익비(평균승/평균패)를 표시하기 위해 컬럼을 추가한다.
-- MDD가 높은데 CAGR이 플러스인 조합이 트렌드추종 특성(손익비 여유)인지 소수
-- 트레이드 의존인지 화면에서 바로 구분할 수 있게 한다(2026-09-29 진단 결과 기반).
-- 이미 적용된 20260927000000_create_strategy_backtest_summary.sql은 수정하지
-- 않고(RULES.md 5번) 이 새 마이그레이션으로 컬럼만 추가한다.
--
-- nullable인 이유: 승리 또는 패배 트레이드가 0건인 극단적인 경우(이론상 가능,
-- 표본이 아주 작은 rule_type에서 발생할 수 있음) 평균을 낼 수 없어 null로 둔다.
alter table public.strategy_backtest_summary
  add column avg_win_pct numeric,
  add column avg_loss_pct numeric,
  add column payoff_ratio numeric;

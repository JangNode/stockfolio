-- 20260821000000_add_market_to_screening_runs.sql 롤백. 스크리닝 배치의 당일 중복
-- 실행 방지 가드(PR #38)를 코드와 함께 되돌리면서, 그 가드가 의존하던 market 컬럼도
-- 제거한다.
alter table public.screening_runs
  drop column if exists market;

-- screen-all-stocks.ts(국내)와 screen-us-stocks.ts(미국) 배치에 "오늘 이미 실행했는지"
-- 중복 실행 방지 가드(paper-trade.ts의 alreadyRanToday와 동일한 패턴)를 추가하기 위해
-- market 컬럼을 둔다. 지금까지 screening_runs는 국내/미국 실행 기록이 market 구분 없이
-- 섞여 쌓여 있었는데(paper_runs와 달리 이 분리를 놓치고 있었음), 과거 기록을 정확히
-- 국내/미국으로 되돌려 채우는 것보다 앞으로의 시장별 판단이 새 값 기준으로 정확히
-- 동작하는 게 중요하므로 기존 행은 기본값 'KR'로 채운다(paper_runs 마이그레이션과 동일한
-- 원칙, 20260820030000_add_market_to_paper_runs.sql 참고).
alter table public.screening_runs
  add column if not exists market text not null default 'KR' check (market in ('KR', 'US'));

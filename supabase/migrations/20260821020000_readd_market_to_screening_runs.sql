-- 20260821010000_revert_market_on_screening_runs.sql로 지웠던 market 컬럼을 다시 추가한다.
-- 스크리닝 배치의 당일 중복 실행 방지 가드(paper-trade.ts의 alreadyRanToday와 동일한
-- 패턴)를 다시 붙이면서 필요해졌다 — 이번엔 스케줄(schedule) 트리거에만 적용하고
-- workflow_dispatch(수동 실행)는 항상 통과시키도록 스크립트 쪽 조건을 바꿨다
-- (실제로 지연 도착한 schedule 트리거가 당일 수동 실행분과 중복으로 전종목을 재스캔한
-- 사례가 있었다 — 20260821000000_add_market_to_screening_runs.sql 커밋 메시지 참고).
alter table public.screening_runs
  add column if not exists market text not null default 'KR' check (market in ('KR', 'US'));

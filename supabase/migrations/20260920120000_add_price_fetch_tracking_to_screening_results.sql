-- 거래정지/상장폐지된 종목의 시세 조회가 계속 실패해도 status='active'로 영구히
-- 남아 "유령 보유"가 되는 문제 방어(2026-09-20 확인). 연속 실패 횟수/마지막 성공
-- 조회 시각을 기록해, N일 연속 실패 시 별도 상태로 전환할 수 있게 한다.
alter table public.screening_results
  add column if not exists price_fetch_failure_count integer not null default 0,
  add column if not exists last_price_fetch_success_at timestamptz not null default now();

alter table public.screening_results
  drop constraint if exists screening_results_status_check;

alter table public.screening_results
  add constraint screening_results_status_check
  check (status in ('active', 'stopped', 'profited', 'price_unavailable'));

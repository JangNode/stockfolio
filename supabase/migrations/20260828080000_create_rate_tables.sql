-- 미국 기준금리(FOMC)/한국 기준금리(금통위) 데이터. 두 소스(FRED/ECOS) 모두 일별
-- 시계열로 내려주지만 회의 사이엔 값이 그대로 반복되므로, 저장은 "값이 바뀐 날"만
-- 걸러서 넣는다(계단식 변경점만 저장 — 데이터량도 최소화되고 그래프도 그리기 쉽다).
-- dh_daily_prices_recent/dart_* 등 다른 공유 시장 데이터 테이블과 동일하게, RLS는
-- 켜두되 select 정책을 두지 않는다 — 프런트는 직접 조회하지 않고 반드시 API 라우트
-- (service_role)를 거친다.
create table if not exists public.us_fed_funds_rate (
  effective_date date primary key,
  target_upper_pct numeric not null,
  target_lower_pct numeric not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.kr_base_rate (
  effective_date date primary key,
  rate_pct numeric not null,
  updated_at timestamptz not null default now()
);

alter table public.us_fed_funds_rate enable row level security;
alter table public.kr_base_rate enable row level security;

-- FOMC/금통위 발표 감지 재시도(T+0,5,15,30,60,120분)의 각 시도 결과를 남긴다 — "몇 번
-- 만에 감지됐는지" 나중에 확인할 수 있게. fetched_values는 US(상단/하단 2개)/KR(단일
-- 1개)를 함께 표현하려고 배열로 둔다.
create table if not exists public.rate_check_log (
  id uuid primary key default gen_random_uuid(),
  market text not null check (market in ('US', 'KR')),
  offset_min integer not null,
  changed boolean not null,
  fetched_effective_date date,
  fetched_values numeric[],
  checked_at timestamptz not null default now()
);

create index if not exists rate_check_log_market_checked_at_idx
  on public.rate_check_log (market, checked_at desc);

alter table public.rate_check_log enable row level security;

-- 연구용: stock_annual_fundamentals에 없는 (종목, 회계연도)를 같은 방식(fnlttSinglAcntAll, 연결 CFS 우선·별도 OFS 폴백)으로
-- 채워 보는 새 표. 기존 stock_annual_fundamentals는 건드리지 않는다. 컬럼은 기존 표와 같고 status/fetched_at이 추가됐다.
-- status: ok(값 저장) / no_data_013(CFS·OFS 모두 조회된 데이터 없음 — 다시 요청하지 않게 1행 남김) /
--         no_report(응답은 있으나 사업보고서 기간 말이 12월이 아님) / error(재시도 후에도 실패 — 다음 실행에서 다시 시도).
-- 값이 없는 행은 fs_div/rcept_no/rcept_date/net_income_parent/equity_parent가 null이다.
-- 공유·전역 시장 데이터라 RLS만 켜고 정책은 두지 않는다(service_role 전용).
create table public.stock_annual_fundamentals_fill (
  stock_code text not null,
  corp_code text not null,
  fiscal_year integer not null,
  fs_div text check (fs_div in ('CFS', 'OFS')),
  rcept_no text,
  rcept_date date,
  net_income_parent numeric,
  equity_parent numeric,
  status text not null check (status in ('ok', 'no_data_013', 'no_report', 'error')),
  fetched_at timestamptz not null default now(),
  primary key (stock_code, fiscal_year)
);

create index stock_annual_fundamentals_fill_rcept_date_idx
  on public.stock_annual_fundamentals_fill (stock_code, rcept_date);

alter table public.stock_annual_fundamentals_fill enable row level security;

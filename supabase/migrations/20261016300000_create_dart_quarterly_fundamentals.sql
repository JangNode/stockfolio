-- DART fnlttSinglAcntAll(분기·반기·3분기 보고서)에서 뽑은 분기 실적 백필 결과. 기존 표는 건드리지 않는 새 표다.
-- quarter: 1=1분기(11013), 2=반기(11012), 3=3분기(11014). 4분기는 연간 − 3분기 누적으로 파생하므로 저장하지 않는다.
-- ni_parent_q/cum/prev_q/prev_cum = 지배기업 귀속 순이익의 thstrm_amount(3개월)/thstrm_add_amount(누적)/
-- frmtrm_q_amount(전년 같은 분기 3개월)/frmtrm_add_amount(전년 누적). revenue·op_income은 3개월치와 전년 같은 분기.
-- equity_parent = 분기 말 지배기업 소유주지분. 계정은 account_id(ifrs_/ifrs-full_/dart_ 접두사 허용)로만 매칭하고
-- 못 찾으면 null, 사유는 account_ids_used에 기록한다.
-- rcept_date가 point-in-time 판정 기준이다. off_cycle = 접수월이 1분기 5월/반기 8월/3분기 11월이 아님(12월 결산 아닌 종목 탐지용).
-- status: ok / no_data_013(CFS·OFS 모두 013) / error(DART 오류 코드, account_ids_used에 코드 기록).
-- 공유·전역 시장 데이터라 RLS만 켜고 정책은 두지 않는다(service_role 전용).
create table public.dart_quarterly_fundamentals (
  corp_code text not null,
  stock_code text not null,
  fiscal_year integer not null,
  quarter smallint not null check (quarter in (1, 2, 3)),
  fs_div text check (fs_div in ('CFS', 'OFS')),
  rcept_no text,
  rcept_date date,
  ni_parent_q numeric,
  ni_parent_cum numeric,
  ni_parent_prev_q numeric,
  ni_parent_prev_cum numeric,
  revenue_q numeric,
  revenue_prev_q numeric,
  op_income_q numeric,
  op_income_prev_q numeric,
  equity_parent numeric,
  status text not null check (status in ('ok', 'no_data_013', 'error')),
  off_cycle boolean not null default false,
  fetched_at timestamptz not null default now(),
  account_ids_used text,
  primary key (corp_code, fiscal_year, quarter)
);

create index dart_quarterly_fundamentals_stock_idx on public.dart_quarterly_fundamentals (stock_code, fiscal_year, quarter);

alter table public.dart_quarterly_fundamentals enable row level security;

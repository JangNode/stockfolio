-- DART XBRL(fnlttXbrl.xml)에서 뽑은 FY2010~FY2014 지배주주 당기순이익·자본·기본EPS 백필 결과.
-- 기존 stock_annual_fundamentals(FY2015 이후, fnlttSinglAcntAll 기반)와 따로 두는 새 표다
-- (기존 표는 건드리지 않는다). 값이 없는 보고서도 status/miss_reason과 함께 1행 저장해
-- 누락 현황을 DB에서 분석할 수 있게 한다.
-- rcept_dt(접수일)가 point-in-time 판정 기준이다. FY2010 값은 FY2011 보고서의 전기 컨텍스트에서
-- 뽑아 source='prior_col'로 저장하고 rcept_dt는 FY2011 보고서 접수일이다.
-- *_basis: cons(연결) / nodim(차원 없음) / sep(별도) / null(추출 못함).
-- 공유·전역 시장 데이터라 RLS만 켜고 정책은 두지 않는다(service_role 전용).
create table public.dart_xbrl_fundamentals (
  corp_code text not null,
  stock_code text not null,
  fiscal_year integer not null,
  source text not null check (source in ('own', 'prior_col')),
  rcept_no text,
  rcept_dt date,
  ni_parent numeric,
  ni_tag text,
  ni_basis text check (ni_basis in ('cons', 'nodim', 'sep')),
  equity_parent numeric,
  equity_tag text,
  equity_basis text check (equity_basis in ('cons', 'nodim', 'sep')),
  eps_basic numeric,
  eps_basis text check (eps_basis in ('cons', 'nodim', 'sep')),
  status text not null check (status in ('ok', 'partial', 'xbrl_014', 'no_report', 'amended_only')),
  miss_reason text,
  fetched_at timestamptz not null default now(),
  primary key (corp_code, fiscal_year, source)
);

create index dart_xbrl_fundamentals_stock_idx on public.dart_xbrl_fundamentals (stock_code, fiscal_year);

alter table public.dart_xbrl_fundamentals enable row level security;

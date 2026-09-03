-- RIM/DCF 적정주가 계산용 선행 데이터(현금흐름표, 부채구조). DART fnlttSinglAcntAll
-- (단일회사 전체 재무제표)을 종목×연도별로 호출해 채운다 —
-- scripts/backfill-dart-cashflow-debt.ts, lib/dartValuationConfig.ts 참고.
-- rcept_date(접수일자)가 point-in-time 판정 기준이다(이 두 표의 fiscal_year 자체는
-- 정렬/필터 용도로만 쓰지 않는다 — stock_annual_fundamentals와 동일한 이유,
-- 20260827050000_create_dh_strategy_backfill_tables.sql 주석 참고).
--
-- fs_div(연결 CFS/별도 OFS)는 "연결 우선, 없으면 별도 폴백"이 실제로 어느 쪽으로
-- 채워졌는지 검증 가능하게 하려고 남겨둔다.
create table public.dart_cashflow_statements (
  stock_code text not null,
  corp_code text not null,
  fiscal_year integer not null,
  fs_div text not null check (fs_div in ('CFS', 'OFS')),
  rcept_no text not null,
  rcept_date date not null,
  operating_cf numeric,
  investing_cf numeric,
  capex numeric,
  financing_cf numeric,
  created_at timestamptz not null default now(),
  primary key (stock_code, fiscal_year)
);

create index dart_cashflow_statements_rcept_date_idx
  on public.dart_cashflow_statements (stock_code, rcept_date);

-- 서버(배치 스크립트)만 다루는 공유 시장 데이터라 dart_corp_codes/stock_annual_fundamentals와
-- 동일하게 RLS는 켜두되 select 정책은 추가하지 않는다 — service_role만 접근 가능.
alter table public.dart_cashflow_statements enable row level security;

create table public.dart_debt_structure (
  stock_code text not null,
  corp_code text not null,
  fiscal_year integer not null,
  fs_div text not null check (fs_div in ('CFS', 'OFS')),
  rcept_no text not null,
  rcept_date date not null,
  short_term_debt numeric,
  long_term_debt numeric,
  bonds_payable numeric,
  interest_expense numeric,
  created_at timestamptz not null default now(),
  primary key (stock_code, fiscal_year)
);

create index dart_debt_structure_rcept_date_idx
  on public.dart_debt_structure (stock_code, rcept_date);

alter table public.dart_debt_structure enable row level security;

-- stock_data_backfill_runs(구 dh_backfill_runs, 20260828010000에서 rename)의
-- data_source check 제약에 'dart_cashflow_debt'를 추가한다. RENAME TABLE은 제약 이름
-- 자체를 바꾸지 않으므로(여전히 dh_backfill_runs_data_source_check일 가능성이 높음),
-- 이름을 추측해 하드코딩하지 않고 pg_constraint/pg_class로 동적으로 찾아 drop한다.
do $$
declare
  existing_constraint_name text;
begin
  select con.conname
    into existing_constraint_name
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
   where nsp.nspname = 'public'
     and rel.relname = 'stock_data_backfill_runs'
     and con.contype = 'c'
     and pg_get_constraintdef(con.oid) ilike '%data_source%';

  if existing_constraint_name is not null then
    execute format(
      'alter table public.stock_data_backfill_runs drop constraint %I',
      existing_constraint_name
    );
  end if;

  alter table public.stock_data_backfill_runs
    add constraint stock_data_backfill_runs_data_source_check
    check (data_source in ('krx_price', 'dart_fundamentals', 'dividends', 'dart_cashflow_debt'));
end $$;

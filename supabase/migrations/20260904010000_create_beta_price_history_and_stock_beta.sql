-- 관심종목 적정주가 기능 1단계(RIM/잔여이익모델)에 필요한 베타 계산용 원자료.
-- beta_price_history: CAPM 요구수익률 계산에 쓰는 코스피/코스닥 지수 일별 종가
-- (scripts/backfill-index-daily-prices.ts가 KRX Open API idx/kospi_dd_trd,
-- idx/kosdaq_dd_trd로 채운다). stock_beta: 종목별로 분기 1회
-- (scripts/calc-stock-beta.ts) 미리 계산해두는 베타 — API 라우트가 요청마다
-- 750거래일치 회귀를 돌리지 않고 이 표만 조회한다.
create table public.beta_price_history (
  market text not null check (market in ('KOSPI', 'KOSDAQ')),
  trade_date date not null,
  close_price numeric not null,
  primary key (market, trade_date)
);

-- 서버(배치 스크립트)만 다루는 공유 시장 데이터라 다른 원자료 표들과 동일하게
-- RLS는 켜두되 select 정책은 추가하지 않는다 — service_role만 접근 가능. 클라이언트는
-- 항상 Next.js API 라우트를 거쳐서 읽는다.
alter table public.beta_price_history enable row level security;

create table public.stock_beta (
  stock_code text primary key,
  market text not null check (market in ('KOSPI', 'KOSDAQ')),
  -- 상장 3년 미만 등으로 회귀에 필요한 데이터가 부족하면 null(산출 불가).
  beta numeric,
  data_points integer not null,
  window_start_date date not null,
  window_end_date date not null,
  computed_at timestamptz not null default now()
);

alter table public.stock_beta enable row level security;

-- stock_data_backfill_runs의 data_source check 제약에 이번 기능이 쓰는 값들을
-- 추가한다. RENAME TABLE(20260828010000)이 제약 이름 자체를 바꾸지 않아 이름을
-- 추측하지 않고 pg_constraint/pg_class로 동적으로 찾아 drop한다
-- (20260903000000_create_dart_cashflow_debt_tables.sql과 동일한 패턴).
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
    check (data_source in (
      'krx_price',
      'dart_fundamentals',
      'dividends',
      'dart_cashflow_debt',
      'krx_index_price',
      'dart_industry_classification',
      'kis_industry_per'
    ));
end $$;

-- DH전략(대형 배당·가치주 스크리닝) 백테스트를 위한 과거 PER/PBR 재구성용 표.
-- KRX 일별매매정보(전종목 종가/시가총액/상장주식수) + DART 단일회사 전체 재무제표
-- (지배기업 소유주지분 당기순이익/자본총계) + 배당 이력을 조합해 임의의 과거 날짜
-- 기준 PER/PBR을 계산할 수 있게 원자료만 저장한다. PER/PBR 값 자체는 저장하지 않고
-- 조회 시점에 계산한다 — 매일 같은 값이 반복 저장되는 낭비를 피하고, 계산 로직을
-- 나중에 고칠 때 재적재할 필요가 없게 하기 위해서다.

-- KRX 일별시세(전종목, KOSPI+KOSDAQ 공통). 시가총액 1조원 필터는 저장 시점이 아니라
-- 조회 시점에 그날의 실제 market_cap_eok으로 매번 다시 판정한다 — 그래야 "그때는
-- 컸는데 지금 작아진 회사"/반대 경우가 생존편향 없이 정확히 처리된다.
create table public.dh_daily_market_data (
  stock_code text not null,
  trade_date date not null,
  close_price numeric not null,
  market_cap_eok numeric not null,
  listed_shares bigint not null,
  primary key (stock_code, trade_date)
);

create index dh_daily_market_data_date_idx on public.dh_daily_market_data (trade_date);

alter table public.dh_daily_market_data enable row level security;

-- DART fnlttSinglAcntAll에서 뽑은 연도별 확정 재무(지배기업 소유주지분 기준).
-- rcept_date(접수일자)가 point-in-time 판정의 핵심이다 — fiscal_year로 정렬/필터하면
-- 안 된다(FY2022 보고서가 2023-03-07에야 공개된 것처럼 회계연도와 실제 공개일 사이에
-- 몇 달 갭이 있어서, fiscal_year 기준으로 고르면 미래 데이터가 샌다). 반드시
-- lib/dhFundamentals.ts의 getFundamentalsAsOf를 통해서만 조회해야 한다.
create table public.dh_annual_fundamentals (
  stock_code text not null,
  corp_code text not null,
  fiscal_year integer not null,
  rcept_no text not null,
  rcept_date date not null,
  net_income_parent numeric,
  equity_parent numeric,
  primary key (stock_code, fiscal_year)
);

create index dh_annual_fundamentals_rcept_date_idx on public.dh_annual_fundamentals (stock_code, rcept_date);

alter table public.dh_annual_fundamentals enable row level security;

-- 배당 이력. lib/kis.ts의 DividendRecord(getDividendRecords)와 동일한 구조 —
-- pay_date가 point-in-time 판정 기준(record_date 아님, 이미 지급된 것만 "확정"으로
-- 취급하는 게 기존 가치평가지표 카드와 동일한 규칙).
create table public.dh_dividend_history (
  stock_code text not null,
  record_date date not null,
  cash_dividend_per_share numeric not null,
  pay_date date,
  primary key (stock_code, record_date)
);

alter table public.dh_dividend_history enable row level security;

-- 백필/상시갱신 진행상황 추적. 날짜 단위 체크포인트라 중간에 끊겨도(네트워크 오류 등)
-- last_completed_date부터 다음 실행이 이어받는다 — 하루 호출 한도 안에 다 끝나긴
-- 하지만(KRX 10,000회/일 중 약 7,400회 사용 예상, DART 40,000회/일 중 여유 많음),
-- 한도 문제와 무관하게 이 재개 능력 자체는 안전장치로 둔다.
create table public.dh_backfill_runs (
  id uuid primary key default gen_random_uuid(),
  data_source text not null check (data_source in ('krx_price', 'dart_fundamentals', 'dividends')),
  last_completed_date date,
  started_at timestamptz not null,
  finished_at timestamptz,
  rows_fetched integer,
  error_count integer not null default 0
);

alter table public.dh_backfill_runs enable row level security;

-- 전부 서버(배치 스크립트)만 다루는 참조 데이터라 dart_corp_codes/kis_tokens와 동일하게
-- RLS는 켜두되 정책은 추가하지 않는다 — anon/authenticated는 완전히 차단되고
-- service_role만 RLS를 우회해 접근할 수 있다.

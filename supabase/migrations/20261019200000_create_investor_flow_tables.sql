-- 투자자별 수급 연구용 새 표 2개(기존 표는 건드리지 않는다). 출처: KIS 시장별 투자자매매동향(일별) FHPTJ04040000, 종목별 투자자매매동향(일별) FHPTJ04160001.
-- *_amt 컬럼은 KIS의 *_ntby_tr_pbmn(순매수 거래대금) 값 그대로이며 단위는 수집 스크립트 검증으로 확인한다(백만원 추정). 수량은 주.
-- 공유·전역 시장 데이터라 RLS만 켜고 정책은 두지 않는다(service_role 전용).
create table public.investor_flow_market (
  market text not null check (market in ('KOSPI', 'KOSDAQ')),
  trade_date date not null,
  index_close numeric,
  frgn_ntby_qty numeric,
  orgn_ntby_qty numeric,
  prsn_ntby_qty numeric,
  frgn_ntby_amt numeric,
  orgn_ntby_amt numeric,
  prsn_ntby_amt numeric,
  scrt_ntby_amt numeric,
  ivtr_ntby_amt numeric,
  pe_fund_ntby_amt numeric,
  bank_ntby_amt numeric,
  insu_ntby_amt numeric,
  mrbn_ntby_amt numeric,
  fund_ntby_amt numeric,
  etc_orgt_ntby_amt numeric,
  etc_ntby_amt numeric,
  etc_corp_ntby_amt numeric,
  fetched_at timestamptz not null default now(),
  primary key (market, trade_date)
);

create table public.investor_flow_stock_pilot (
  stock_code text not null,
  trade_date date not null,
  close_price numeric,
  volume numeric,
  trading_value numeric,
  frgn_ntby_qty numeric,
  orgn_ntby_qty numeric,
  prsn_ntby_qty numeric,
  frgn_ntby_amt numeric,
  orgn_ntby_amt numeric,
  prsn_ntby_amt numeric,
  fetched_at timestamptz not null default now(),
  primary key (stock_code, trade_date)
);

alter table public.investor_flow_market enable row level security;
alter table public.investor_flow_stock_pilot enable row level security;

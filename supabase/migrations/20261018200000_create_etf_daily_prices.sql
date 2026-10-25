-- KIS 기간별 시세로 받은 ETF 일봉(연구용 새 표, 기존 표는 건드리지 않는다).
-- adj_close = FID_ORG_ADJ_PRC=0(수정주가 반영), raw_close = FID_ORG_ADJ_PRC=1(원주가). open/high/low/volume/trading_value는 수정주가 조회 응답 기준.
-- 한쪽 조회에만 있는 날짜는 반대쪽 종가가 null이다. 공유·전역 시장 데이터라 RLS만 켜고 정책은 두지 않는다(service_role 전용).
create table public.etf_daily_prices (
  code text not null,
  trade_date date not null,
  adj_close numeric,
  raw_close numeric,
  open numeric,
  high numeric,
  low numeric,
  volume numeric,
  trading_value numeric,
  fetched_at timestamptz not null default now(),
  primary key (code, trade_date)
);

alter table public.etf_daily_prices enable row level security;

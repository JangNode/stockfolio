-- DH전략 일별시세 hot/cold 분리(용량 예산 재산정, 2026-08-28 검토 결과):
-- Parquet는 파일 전체를 다시 써야 해서 매일 갱신하기엔 부담이 크다. 최근
-- DH_HOT_WINDOW_YEARS(lib/dhStrategyConfig.ts, 2년)치만 이 표(Postgres, 하루 INSERT만
-- 하면 됨)에 두고, 그보다 오래된 건 기존 Parquet(dh-daily-prices 버킷)에 그대로
-- 둔다. 연 1회 아카이빙 배치(scripts/archive-dh-daily-prices.ts)가 이 표에서 hot
-- 구간을 벗어난 행을 골라 해당 연도 Parquet 파일에 합쳐 넣고 여기서 지운다.
--
-- 용량 산정(2026-08-28 실측 기준: DB 46MB/500MB, screening_results/paper_trades
-- 연간 증가 ~35MB, 이 표는 하루 약 430행×120바이트 추정으로 2년 정상 상태 기준
-- ~36MB) — 500MB 한도 대비 넉넉히 여유 있음(1~2년 후에도 총 ~117MB/500MB 예상).
create table public.dh_daily_prices_recent (
  stock_code text not null,
  trade_date date not null,
  close_price numeric not null,
  market_cap_eok numeric not null,
  listed_shares bigint not null,
  primary key (stock_code, trade_date)
);

create index dh_daily_prices_recent_date_idx on public.dh_daily_prices_recent (trade_date);

alter table public.dh_daily_prices_recent enable row level security;

-- 급등주 찾기(reversal_breakout) 15년 백테스트(2026-09-06 요청)를 위해 시가/거래량을
-- 추가한다. reversal_breakout의 매집봉 판정(거래량 배수 + 양봉)에 필요하지만, 원래
-- DH전략/방법A 등은 종가·시총·상장주식수만 써서 지금까지는 없었다(lib/stockDailyPricesStorage.ts
-- 참고). 연도별 Parquet(stock-daily-prices 버킷)은 스키마가 아니라 파일 자체를 다시
-- 써야 하므로, 이 컬럼 추가 직후 scripts/backfill-stock-daily-prices.ts를 2011년부터
-- 다시 돌려 Parquet까지 포함해 전체를 재구성한다.
--
-- 기존 행이 이미 있어(2026-09-06 기준 약 28만 행) not null 제약을 걸려면 값이
-- 필요하다 — 재백필 직후 scripts/seed-stock-daily-prices-recent.ts로 이 표 전체를
-- Parquet 재백필 결과로 다시 upsert하므로, default 0은 그 사이 짧은 기간만 쓰이는
-- 임시값이다.
alter table public.stock_daily_prices_recent
  add column open_price numeric not null default 0,
  add column volume bigint not null default 0;

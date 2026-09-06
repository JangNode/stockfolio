-- 급등주 찾기(reversal_breakout) 손절/익절 백테스트(2026-09-06 요청)를 위해
-- 고가/저가를 추가한다. 종가만으로 손절/익절을 판정하면 "장중에 손절선을 찍고
-- 당일 종가는 회복한" 경우를 놓쳐 실제보다 낙관적인 결과가 나온다 — 손절은 그날
-- 저가, 익절은 그날 고가 기준으로 판정해야 한다. 연도별 Parquet(stock-daily-prices
-- 버킷)은 스키마가 아니라 파일 자체를 다시 써야 하므로, 이 컬럼 추가 직후
-- scripts/backfill-stock-daily-prices.ts를 2011년부터 다시 돌려 Parquet까지 포함해
-- 전체를 재구성한다.
--
-- 기존 행이 이미 있어(2026-09-06 기준 약 28만 행) not null 제약을 걸려면 값이
-- 필요하다 — 재백필 직후 scripts/seed-stock-daily-prices-recent.ts로 이 표 전체를
-- Parquet 재백필 결과로 다시 upsert하므로, default 0은 그 사이 짧은 기간만 쓰이는
-- 임시값이다(20260906000000_add_open_volume_to_stock_daily_prices_recent.sql과 동일한
-- 패턴).
alter table public.stock_daily_prices_recent
  add column high_price numeric not null default 0,
  add column low_price numeric not null default 0;

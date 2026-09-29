-- KRX 응답의 거래대금(ACC_TRDVAL)을 저장한다 — 지금까지는 close×volume으로
-- 근사했는데, 원자료에 이미 있는 정확한 값을 그냥 같이 받아두기로 한다
-- (2026-09-29 전종목 재백필 계획). nullable — 기존 행은 채워지지 않는다.
alter table public.stock_daily_prices_recent
  add column trading_value numeric;

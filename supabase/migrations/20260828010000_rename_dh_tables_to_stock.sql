-- 종목 시세/재무/배당 원자료는 DH전략 전용이 아니라 다른 전략도 같이 쓸 공유
-- 데이터라(2026-08-28 사용자 요청), dh_ 접두사를 stock_으로 바꿔 이름만 봐도
-- 특정 전략 소유가 아니라는 게 드러나게 한다. 데이터는 그대로 유지된다(RENAME은
-- 내용을 안 건드림). DH전략 고유의 스크리닝 기준값(lib/dhStrategyConfig.ts의
-- PER/PBR 상한, 배당 연속연수 등)은 그대로 dh_ 네이밍을 유지한다 — 그건 진짜
-- DH전략만의 판단 기준이라서다.
alter table public.dh_daily_prices_recent rename to stock_daily_prices_recent;
alter table public.dh_annual_fundamentals rename to stock_annual_fundamentals;
alter table public.dh_dividend_history rename to stock_dividend_history;
alter table public.dh_backfill_runs rename to stock_data_backfill_runs;

alter index public.dh_annual_fundamentals_rcept_date_idx rename to stock_annual_fundamentals_rcept_date_idx;
alter index public.dh_daily_prices_recent_date_idx rename to stock_daily_prices_recent_date_idx;

-- Storage 버킷은 id를 직접 rename하지 않는다(storage.objects.bucket_id 참조 관계를
-- 안전하게 건드리기 애매해서) — 대신 새 버킷을 만들고, 코드/스크립트가 이미 올라간
-- Parquet 파일을 새 버킷으로 복사한다(scripts/migrate-stock-prices-bucket.ts, 1회성).
insert into storage.buckets (id, name, public)
values ('stock-daily-prices', 'stock-daily-prices', false)
on conflict (id) do nothing;

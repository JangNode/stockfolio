-- 전역 국내/미국 시장 전환 기능 지원. 워치리스트/시세캐시에도 스크리닝과 같은
-- market/exchange 컬럼을 추가한다. 기존 행은 전부 국내 종목이므로 기본값 'KR'로
-- 채워지고 별도 백필이 필요 없다.
alter table public.watchlist
  add column if not exists market text not null default 'KR' check (market in ('KR', 'US')),
  add column if not exists exchange text;

-- 같은 티커라도 시장이 다르면 다른 종목이므로 유니크 제약에 market을 포함시킨다.
-- 기존 (user_id, stock_code) 제약은 이제 market이 전부 'KR'인 상태에서만 유효했던
-- 것이라 그대로 두면 같은 티커의 국내/미국 버전을 동시에 담을 수 없다.
alter table public.watchlist drop constraint if exists watchlist_user_id_stock_code_key;
create unique index if not exists watchlist_user_id_market_stock_code_idx
  on public.watchlist (user_id, market, stock_code);

alter table public.stock_prices
  add column if not exists market text not null default 'KR' check (market in ('KR', 'US')),
  add column if not exists exchange text;

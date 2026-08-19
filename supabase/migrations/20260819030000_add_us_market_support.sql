-- 미국주식 스크리닝 추가를 위한 시장 구분 컬럼. 기존 행은 전부 국내주식이므로
-- 기본값 'KR'로 채워지고 별도 백필이 필요 없다.
alter table public.strategies
  add column if not exists market text not null default 'KR' check (market in ('KR', 'US'));

alter table public.screening_results
  add column if not exists market text not null default 'KR' check (market in ('KR', 'US'));

-- 미국주식 시세 재조회(추적 갱신)에는 거래소 코드(NAS/NYS/AMS)가 필수 파라미터라
-- stock_code(티커)만으로는 KIS API를 다시 호출할 수 없다. market='US' 행에만 값이
-- 채워지고, 국내(market='KR') 행은 계속 null이다.
alter table public.screening_results
  add column if not exists exchange text;

create index if not exists strategies_market_idx on public.strategies (market);
create index if not exists screening_results_market_idx on public.screening_results (market);

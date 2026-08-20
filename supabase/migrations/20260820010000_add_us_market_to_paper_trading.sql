-- AI 모의투자에도 국내/미국 시장 구분을 추가한다. 전략 조건(paper_strategies)은
-- 퍼센트/개수 기반이라 시장에 무관하므로 그대로 두고, 포트폴리오/포지션/거래
-- 내역에만 market을 추가해 국내 2개 + 미국 2개(공격형/보수형 x 국내/미국),
-- 총 4개 포트폴리오 구조로 확장한다.

alter table public.paper_portfolios
  add column if not exists market text not null default 'KR' check (market in ('KR', 'US'));

alter table public.paper_portfolios drop constraint if exists paper_portfolios_style_key;
create unique index if not exists paper_portfolios_style_market_idx
  on public.paper_portfolios (style, market);

-- 미국 포트폴리오는 초기 자본 1,000달러로 시작한다.
insert into public.paper_portfolios (style, market, initial_capital, cash)
values
  ('aggressive', 'US', 1000, 1000),
  ('conservative', 'US', 1000, 1000)
on conflict (style, market) do nothing;

alter table public.paper_positions
  add column if not exists market text not null default 'KR' check (market in ('KR', 'US')),
  add column if not exists exchange text;

alter table public.paper_trades
  add column if not exists market text not null default 'KR' check (market in ('KR', 'US')),
  add column if not exists exchange text;

create table if not exists public.stock_prices (
  id uuid primary key default gen_random_uuid(),
  stock_code text not null,
  price numeric not null,
  change numeric not null,
  change_rate numeric not null,
  volume bigint not null,
  fetched_at timestamptz not null default now()
);

create index if not exists stock_prices_stock_code_fetched_at_idx
  on public.stock_prices (stock_code, fetched_at desc);

-- RLS를 켜두되 어떤 정책도 추가하지 않는다: anon/authenticated 역할은 완전히 차단되고,
-- service_role(서버 전용 관리자 키)만 RLS를 우회해 접근할 수 있다.
alter table public.stock_prices enable row level security;

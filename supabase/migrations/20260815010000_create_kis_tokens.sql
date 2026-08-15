create table if not exists public.kis_tokens (
  id text primary key,
  access_token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

-- RLS를 켜두되 어떤 정책도 추가하지 않는다: anon/authenticated 역할은 완전히 차단되고,
-- service_role(서버 전용 관리자 키)만 RLS를 우회해 접근할 수 있다.
alter table public.kis_tokens enable row level security;

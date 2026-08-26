-- DART(전자공시) Open API 연동에 쓰는 표 3개. 셋 다 사용자 소유 데이터가 아니라
-- 서버(배치 스크립트/API 라우트)만 다루는 참조 데이터/캐시/로그라서, kis_tokens와
-- 동일하게 RLS는 켜두되 정책은 추가하지 않는다 — anon/authenticated 역할은 완전히
-- 차단되고 service_role(서버 전용 관리자 키)만 RLS를 우회해 접근할 수 있다.

-- 종목코드(stock_code) ↔ DART corp_code 매핑. DART가 제공하는 전체 법인 목록이라
-- 비상장 법인도 섞여 있으므로 stock_code는 nullable이다 — 상장사만 매칭에 쓴다.
create table if not exists public.dart_corp_codes (
  corp_code text primary key,
  corp_name text not null,
  stock_code text,
  modify_date text not null,
  updated_at timestamptz not null default now()
);

create index if not exists dart_corp_codes_stock_code_idx
  on public.dart_corp_codes (stock_code)
  where stock_code is not null;

alter table public.dart_corp_codes enable row level security;

-- 종목별 최근 3개년 재무제표 캐시(1일 TTL은 fetched_at을 애플리케이션에서 비교해 판단).
-- DART 단일회사 주요계정 API는 한 번 호출하면 당기·전기·전전기를 함께 주므로, stock_code당
-- 최신 조회 결과 한 건만 유지하면 된다(이력을 쌓을 필요 없음 — 그래서 upsert 대상 PK로
-- stock_code를 그대로 쓴다).
create table if not exists public.dart_financial_statements (
  stock_code text primary key,
  corp_code text not null,
  bsns_year text not null,
  reprt_code text not null,
  data jsonb not null,
  fetched_at timestamptz not null default now()
);

alter table public.dart_financial_statements enable row level security;

-- DART 호출 횟수를 나중에 확인할 수 있도록 남기는 로그. 일일 한도가 넉넉해 배치성 정리는
-- 당장 두지 않는다.
create table if not exists public.dart_api_call_log (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null check (endpoint in ('corpCode', 'fnlttSinglAcnt')),
  corp_code text,
  status text not null check (status in ('success', 'error')),
  dart_status_code text,
  called_at timestamptz not null default now()
);

create index if not exists dart_api_call_log_called_at_idx on public.dart_api_call_log (called_at desc);

alter table public.dart_api_call_log enable row level security;

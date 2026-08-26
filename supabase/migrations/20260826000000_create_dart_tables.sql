-- DART(전자공시) Open API 연동에 쓰는 표들. 전부 사용자 소유 데이터가 아니라
-- 서버(배치 스크립트/API 라우트)만 다루는 참조 데이터/캐시/로그라서, kis_tokens와
-- 동일하게 RLS는 켜두되 정책은 추가하지 않는다 — anon/authenticated 역할은 완전히
-- 차단되고 service_role(서버 전용 관리자 키)만 RLS를 우회해 접근할 수 있다.
--
-- 이 파일은 아직 실제 DB에 적용된 적이 없어(마이그레이션 미실행), 새 마이그레이션을
-- 덧붙이는 대신 이 파일 자체를 고쳤다 — 호출량 최소화 설계(사전 필터링/다중회사
-- 조회/영구 캐싱)를 반영해 스키마가 처음 계획과 꽤 달라졌다.

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

-- 종목×사업연도별 주요 재무 지표 캐시. (stock_code, year) 단위 행으로 쪼갠 이유는
-- "이미 확정된 과거 연도는 영구 캐시, 최신 1~2개년만 주기적으로 재확인"이라는 정책을
-- 연도별로 다르게 적용해야 하기 때문이다 — 종목당 한 행에 3개년을 뭉쳐 두면 이걸
-- 표현할 수 없다. is_final=true인 행은 배치가 다시는 건드리지 않는다(정정보고서로
-- 드물게 바뀔 수 있다는 걸 감수하고, 그런 경우는 재호출 대상에서 제외하기로 함).
create table if not exists public.dart_financial_statement_years (
  stock_code text not null,
  year integer not null,
  corp_code text not null,
  revenue numeric,
  operating_income numeric,
  net_income numeric,
  total_assets numeric,
  total_liabilities numeric,
  total_equity numeric,
  is_final boolean not null default false,
  fetched_at timestamptz not null default now(),
  primary key (stock_code, year)
);

alter table public.dart_financial_statement_years enable row level security;

-- 종목×사업연도별 배당 이력 캐시. 재무제표와 같은 (stock_code, year) + is_final 정책을
-- 그대로 쓴다. 배당에 관한 사항(alotMatter) API는 응답 항목의 구분(se)/주식종류
-- (stock_knd) 필드 표기를 이 환경(DART_API_KEY 없음)에서 실응답으로 확인하지 못했으므로,
-- 구조화된 주요 항목 몇 개를 뽑아 컬럼에 담되 원본 응답 전체도 raw에 같이 보관한다 —
-- 나중에 실제 응답을 보고 컬럼 매핑이 틀린 게 발견되면 재호출 없이 raw만 다시 파싱하면
-- 된다. 이번 범위는 테이블/수집 배치까지만이고, 이 데이터를 쓰는 화면이나 전략은
-- 다음 작업으로 미룬다.
create table if not exists public.dart_dividends (
  stock_code text not null,
  year integer not null,
  corp_code text not null,
  cash_dividend_per_share_common numeric,
  cash_dividend_per_share_preferred numeric,
  dividend_yield_pct numeric,
  payout_ratio_pct numeric,
  total_cash_dividend numeric,
  raw jsonb,
  is_final boolean not null default false,
  fetched_at timestamptz not null default now(),
  primary key (stock_code, year)
);

alter table public.dart_dividends enable row level security;

-- DART 호출 횟수를 나중에 확인할 수 있도록 남기는 로그. 일일 한도가 넉넉해 배치성 정리는
-- 당장 두지 않는다. chunk_size는 다중회사 조회(fnlttMultiAcnt)에서 실제로 성공한 묶음
-- 크기를 남겨서, 첫 배치 실행 후 이 로그로 DART의 실제 상한을 확인할 수 있게 한다.
create table if not exists public.dart_api_call_log (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null check (endpoint in ('corpCode', 'fnlttMultiAcnt', 'alotMatter')),
  corp_code text,
  chunk_size integer,
  status text not null check (status in ('success', 'error')),
  dart_status_code text,
  called_at timestamptz not null default now()
);

create index if not exists dart_api_call_log_called_at_idx on public.dart_api_call_log (called_at desc);

alter table public.dart_api_call_log enable row level security;

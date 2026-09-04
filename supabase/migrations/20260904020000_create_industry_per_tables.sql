-- 관심종목 적정주가 기능 1단계(방법A: 업종 평균 PER)에 필요한 표.
-- stock_industry_classification: DART company.json(기업개황)의 induty_code
-- 앞 2자리(KSIC 대분류, lib/industryPerConfig.ts의
-- INDUSTRY_GROUP_KSIC_PREFIX_LENGTH)로 묶은 종목별 업종 그룹
-- (scripts/backfill-stock-industry-classification.ts가 채운다).
-- industry_average_per: 업종 그룹별 PER 중앙값을 매일 1회
-- (scripts/calc-industry-average-per.ts) 미리 계산해두는 표 — API 라우트는 이 표만
-- 조회하고 추가 KIS 호출을 하지 않는다.
create table public.stock_industry_classification (
  stock_code text primary key,
  corp_code text not null,
  induty_code text,
  induty_group text,
  updated_at timestamptz not null default now()
);

create index stock_industry_classification_group_idx on public.stock_industry_classification (induty_group);

-- 서버(배치 스크립트)만 다루는 공유 시장 데이터라 다른 원자료 표들과 동일하게
-- RLS는 켜두되 select 정책은 추가하지 않는다 — service_role만 접근 가능. 클라이언트는
-- 항상 Next.js API 라우트를 거쳐서 읽는다.
alter table public.stock_industry_classification enable row level security;

create table public.industry_average_per (
  induty_group text primary key,
  -- 표본 종목 수(peer_count)가 INDUSTRY_PEER_MIN_GROUP_SIZE 미만이면 산출 불가로
  -- 보고 null로 저장한다 — lib/peerPerValuation.ts 참고.
  median_per numeric,
  peer_count integer not null,
  computed_at timestamptz not null default now()
);

alter table public.industry_average_per enable row level security;

-- 시장 국면(레짐) 카드용 일별 국면 표. 하루 한 행(KOSPI 종가·이동평균·시장 폭·낙폭·변동성과 판정 결과).
-- scripts/market-regime.ts(일일 배치)와 scripts/backfill-market-regime.ts(2010-07~ 이력 백필)가 채우고,
-- 화면은 app/api/market-regime/route.ts를 거쳐서만 읽는다.
--
-- 다른 공유·전역 시장 데이터 테이블과 동일하게 RLS는 켜되 select 정책은 추가하지 않는다
-- (service_role만 읽고 쓰며, 클라이언트는 항상 Next.js API 라우트의 requireApproved를 거친다).
--
-- 단위: b50·b200·drawdown·vol20·vol_pctile은 % 값(b50 67.68 = 67.68%), nh는 정수(신고가 수 − 신저가 수).
-- raw_regime은 3거래일 확인 규칙을 적용하기 전의 그날 신호다(일일 배치가 직전 국면과 최근 신호 두 개만으로
-- 오늘 국면을 이어서 계산하려고 둔다). member_count는 그날 가격 행이 있던 구성 종목 수(200 미만이면 저장하지 않는 배치 규칙의 근거).
-- source: 'backfill' = 월말 시장 구분(PIT) 기준으로 이력 백필, 'daily' = 일일 배치(현재 코스피 구성 기준).
create table public.market_regime_daily (
  trade_date date primary key,
  regime text not null check (regime in ('crisis', 'bear', 'neutral', 'bull', 'undefined')),
  raw_regime text not null check (raw_regime in ('crisis', 'bear', 'neutral', 'bull', 'undefined')),
  kospi_close numeric not null,
  ma50 numeric,
  ma200 numeric,
  b50 numeric,
  b200 numeric,
  nh integer,
  drawdown numeric,
  vol20 numeric,
  vol_pctile numeric,
  member_count integer not null,
  source text not null check (source in ('backfill', 'daily')),
  created_at timestamptz not null default now()
);

alter table public.market_regime_daily enable row level security;

-- 수집/계산 시도 이력은 기존 schedule_scrape_status를 재사용한다(새 상태 표를 또 만들지 않음).
alter table public.schedule_scrape_status drop constraint if exists schedule_scrape_status_source_check;
alter table public.schedule_scrape_status
  add constraint schedule_scrape_status_source_check
  check (source in ('FOMC', 'MPC', 'KRX_CALENDAR', 'MARKET_REGIME'));

insert into public.schedule_scrape_status (source) values ('MARKET_REGIME') on conflict do nothing;

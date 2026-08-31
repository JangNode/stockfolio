-- 테마(KRX 섹터)별 일간 등락률(구성종목 단순평균). scripts/screen-all-stocks.ts가
-- 국내 스크리닝 배치 중 이미 조회한 종목별 전일대비등락율(추가 KIS 호출 없음)을
-- 재사용해 테마별로 집계한 뒤 하루 1행씩 upsert한다. 월별/년도별 등락률은 API 라우트가
-- 이 일별 데이터를 복리로 누적해 계산한다(별도 저장하지 않음).
create table public.theme_daily_returns (
  trade_date date not null,
  theme_code text not null,
  change_rate_pct numeric not null,
  constituent_count integer not null,
  up_count integer not null,
  down_count integer not null,
  constituents jsonb not null,
  created_at timestamptz not null default now(),
  primary key (trade_date, theme_code)
);

create index theme_daily_returns_theme_code_idx
  on public.theme_daily_returns (theme_code, trade_date desc);

-- 공유 시장 데이터 테이블(사용자별로 나뉘지 않음) — 다른 시장 데이터 테이블과 동일하게
-- RLS는 켜두되 select 정책을 두지 않는다. service_role(배치/API 라우트)만 읽고 쓰며,
-- 클라이언트는 항상 Next.js API 라우트를 거친다.
alter table public.theme_daily_returns enable row level security;

comment on column public.theme_daily_returns.constituents is
  '해당 일자 테마 구성종목별 상세([{code, name, changeRate}, ...]). DB 용량 절약을 위해
   3년 지난 행은 scripts/screen-all-stocks.ts 배치가 이 컬럼만 빈 배열로 비운다 — 집계값
   (change_rate_pct/constituent_count/up_count/down_count)은 계속 유지된다.';

-- KODEX 200 + 업종 모멘텀 위성 전략(연구 v3.2, 사전등록 d70b1fd) 운영 표.
-- scripts/kodex-sector-signal.ts가 매월 첫 거래일 오전에 전월 마지막 거래일(신호일) 기준 신호를 계산해
-- kodex_sector_signals에 한 행을 쓰고, 직전 신호의 체결일(신호 다음 거래일) 종가로 시드별
-- 모의 계좌를 리밸런싱해 kodex_sector_track에 쓴다. 과거 백필 없이 첫 운영 신호부터 쌓는다.
--
-- 행 수: 신호 월 1행 + 추적 월 5행(시드 5개) — 연 72행 수준이라 보관 기간 정책을 두지
-- 않는다(RULES.md 3번 검토: 10년에도 720행, 행당 1KB 안팎).
--
-- strategy_backtest_summary 등 다른 공유 전략 결과 표와 같이 select 정책을 추가하지 않는다
-- (service_role만 읽고 쓰며, 화면은 app/api/strategies/kodex-sector 라우트를 거친다).
create table public.kodex_sector_signals (
  signal_date date primary key,
  trade_date date not null,
  momentum_from date not null,
  momentum_to date not null,
  k200p_count integer not null,
  -- [{sector, name, valid_count, momentum}] 유효 업종 전체, 모멘텀 내림차순
  sector_ranks jsonb not null,
  top_sectors text[] not null,
  -- [{code, name, sector, weight(위성 안), account_weight(계좌 전체)}] 1% 정리 후
  holdings jsonb not null,
  -- 1% 정리 전(v3.1) 위성, 같은 형식
  pre_trim_holdings jsonb not null,
  -- 정리 후 남는 종목이 없어 위성 = 069500
  fallback_to_etf boolean not null,
  -- 신호일 원 종가 {code: close}(069500 포함) — 화면 시드 계산기 기준 가격
  signal_prices jsonb not null,
  computed_at timestamptz not null default now()
);

create table public.kodex_sector_track (
  seed_won bigint not null,
  -- 리밸런싱(체결)일 = 신호 다음 거래일
  trade_date date not null,
  signal_date date not null references public.kodex_sector_signals (signal_date),
  value_before numeric not null,
  value_after numeric not null,
  cash numeric not null,
  etf_shares integer not null,
  -- [{code, shares, close}] 체결 후 보유(체결일 원 종가)
  holdings jsonb not null,
  cap_hit boolean not null,
  zero_satellite boolean not null,
  -- 다음 신호일 종가 평가(이 행을 쓰는 실행 시점)
  mark_date date not null,
  mark_value numeric not null,
  computed_at timestamptz not null default now(),
  primary key (seed_won, trade_date)
);

alter table public.kodex_sector_signals enable row level security;
alter table public.kodex_sector_track enable row level security;

-- 마지막 성공/시도 시각은 기존 수집 상태 표를 재사용한다(KRX 거래일 캘린더와 같은 방식).
alter table public.schedule_scrape_status drop constraint if exists schedule_scrape_status_source_check;
alter table public.schedule_scrape_status
  add constraint schedule_scrape_status_source_check
  check (source in ('FOMC', 'MPC', 'KRX_CALENDAR', 'KODEX_SECTOR'));

insert into public.schedule_scrape_status (source) values ('KODEX_SECTOR') on conflict do nothing;

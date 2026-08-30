-- FOMC/금통위 회의 일정을 이제 lib/rateScheduleConfig.ts에 손으로 채워넣는 대신
-- 연준/한은 공식 페이지에서 매주 자동 수집한다(lib/fomcScheduleScraper.ts,
-- lib/mpcScheduleScraper.ts, scripts/sync-rate-schedules.ts). 파싱 실패 시 기존
-- 저장된 일정을 덮어쓰지 않고 그대로 유지해야 하므로, 수집 성공/실패 이력은
-- 일정 테이블과 분리된 schedule_scrape_status에 남긴다(마지막 성공 시각을 보고
-- 오래 갱신 안 됐는지 확인할 수 있게).

create table public.fomc_meeting_schedule (
  meeting_date date primary key,
  year integer not null,
  source_label text,
  updated_at timestamptz not null default now()
);

create table public.mpc_meeting_schedule (
  meeting_date date primary key,
  year integer not null,
  source_label text,
  updated_at timestamptz not null default now()
);

create table public.schedule_scrape_status (
  source text primary key check (source in ('FOMC', 'MPC')),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  last_meeting_count integer
);

insert into public.schedule_scrape_status (source) values ('FOMC'), ('MPC');

-- us_fed_funds_rate 등 다른 시장 데이터 테이블과 동일하게 select 정책을 추가하지
-- 않는다 — service_role(서버 API 라우트/배치)만 읽고 쓰며, 클라이언트는 항상
-- Next.js API 라우트를 거친다.
alter table public.fomc_meeting_schedule enable row level security;
alter table public.mpc_meeting_schedule enable row level security;
alter table public.schedule_scrape_status enable row level security;

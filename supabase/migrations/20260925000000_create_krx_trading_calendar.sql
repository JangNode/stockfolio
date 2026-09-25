-- 한국거래소(KRX) 거래일 캘린더. 2026-09-24/25(추석 연휴) 실제 휴장일에도 국내
-- 스크리닝/AI 모의투자 배치가 "오늘이 거래일인지" 판단 로직이 전혀 없어 정상
-- 거래일처럼 실행돼버린 사고(진짜 시세 변화가 있는 것처럼 손절/신규매칭 발생)를
-- 막기 위해 도입한다. KIS 국내휴장일조회(chk-holiday, tr_id CTCA0903R)를
-- lib/krxTradingCalendar.ts가 연 1회 수집해 여기에 통째로 교체 저장하고,
-- scripts/screen-all-stocks.ts / scripts/paper-trade.ts(KR)가 배치 맨 앞에서
-- 이 테이블을 조회해 휴장일이면 건너뛴다.
--
-- 다른 공유·전역 시장 데이터 테이블과 동일하게 select 정책을 추가하지 않는다
-- (service_role만 읽고 쓰며, 클라이언트는 항상 Next.js API 라우트를 거친다).
create table public.krx_trading_calendar (
  trade_date date primary key,
  is_open boolean not null,
  source_label text,
  updated_at timestamptz not null default now()
);

alter table public.krx_trading_calendar enable row level security;

-- 기존 FOMC/금통위 일정 수집 시도 이력 테이블을 그대로 재사용한다(새 상태 테이블을
-- 또 만들지 않음). source CHECK 제약을 넓히고, 캘린더 소스 행을 하나 추가한다.
alter table public.schedule_scrape_status drop constraint if exists schedule_scrape_status_source_check;
alter table public.schedule_scrape_status
  add constraint schedule_scrape_status_source_check
  check (source in ('FOMC', 'MPC', 'KRX_CALENDAR'));

insert into public.schedule_scrape_status (source) values ('KRX_CALENDAR') on conflict do nothing;

-- DART 자기주식 취득 관련 주요사항보고서(자기주식취득결정, 자기주식취득신탁계약체결결정) 이벤트. 연구용 새 표(기존 표는 건드리지 않는다).
-- rcept_dt가 point-in-time 판정 기준이다. 상세(planned_amount 등)는 2015-01 이후 이벤트만 API(tsstkAqDecsn / tsstkAqTrctrCnsDecsn)로 채우고
-- 못 채운 이벤트는 detail_source='none'이다. planned_amount/planned_shares는 direct에서 보통주+기타주 합.
-- is_amendment = report_nm 접두어에 '정정' 포함, is_extension = '[연장결정]'. stock_code는 dart_corp_codes 매핑(없으면 null).
-- 공유·전역 시장 데이터라 RLS만 켜고 정책은 두지 않는다(service_role 전용).
create table public.dart_buyback_events (
  rcept_no text primary key,
  rcept_dt date not null,
  corp_code text not null,
  stock_code text,
  corp_name text,
  report_nm text not null,
  event_type text not null check (event_type in ('direct', 'trust')),
  is_amendment boolean not null default false,
  is_extension boolean not null default false,
  planned_amount numeric,
  planned_shares numeric,
  aq_purpose text,
  aq_method text,
  aq_decision_date date,
  aq_period_start date,
  aq_period_end date,
  detail_source text not null default 'none' check (detail_source in ('api', 'none')),
  fetched_at timestamptz not null default now()
);

create index dart_buyback_events_corp_idx on public.dart_buyback_events (corp_code, rcept_dt);
create index dart_buyback_events_stock_idx on public.dart_buyback_events (stock_code, rcept_dt);

alter table public.dart_buyback_events enable row level security;

-- 분할·병합(액면분할/병합) 조정계수 이력. KRX 시세는 원가(미조정) 기준이라 원본 Parquet는
-- 그대로 두고(방식 B), 자체 탐지한 이벤트를 이 표에 저장해 장기 백테스트 배치가 조회 시점에
-- 조정한다. status='applied'(신뢰도 높음)만 배치가 적용하고 'low_confidence'는 목록으로만
-- 남긴다(사유: shares_unchanged / market_cap_discontinuity / volume_disagrees).
-- 공유 배치 데이터라 RLS만 켜고 정책은 두지 않는다(service_role만 읽고 씀).
create table public.stock_price_adjustment_events (
  stock_code text not null,
  event_date date not null,
  price_ratio numeric not null,
  shares_ratio numeric not null,
  volume_ratio numeric not null,
  adjustment_factor numeric not null,
  status text not null check (status in ('applied', 'low_confidence')),
  low_confidence_reason text,
  detected_at timestamptz not null default now(),
  primary key (stock_code, event_date)
);

alter table public.stock_price_adjustment_events enable row level security;

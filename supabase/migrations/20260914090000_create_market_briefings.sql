-- Cowork가 매일 아침 만드는 시장 브리핑(글로벌 지수·수급·매크로 이슈 등을 정리한
-- JSON)을 웹훅으로 받아 저장한다. "시장 지표" 탭의 "증시근황" 섹션에 그대로
-- 표시하는 순수 열람용 데이터이며, 매매 로직/전략 재생성/스크리닝 어디에도
-- 연결하지 않는다. 날짜별로 하나만 유지하면 되므로(같은 날 재전송 시 덮어쓰기)
-- date_kst에 unique 제약을 둔다.
create table public.market_briefings (
  id uuid primary key default gen_random_uuid(),
  date_kst date not null unique,
  raw_json jsonb not null,
  created_at timestamptz not null default now()
);

-- 다른 공유 시장 데이터 테이블(central_bank_news 등)과 동일하게 select 정책을
-- 추가하지 않는다 — service_role(웹훅 라우트/관리자 API)만 읽고 쓰며, 클라이언트는
-- 항상 Next.js API 라우트를 거친다.
alter table public.market_briefings enable row level security;

-- 웹훅 엔드포인트는 인증 헤더(토큰) 하나로만 보호되므로, 탈취·오남용에 대비한
-- 간단한 레이트리밋용 보조 테이블. 하루 호출 횟수만 세면 되므로 호출 시각 외에는
-- 아무 내용도 저장하지 않는다.
create table public.cowork_webhook_calls (
  id bigserial primary key,
  called_at timestamptz not null default now()
);

-- select/insert 정책 없음 — service_role(웹훅 라우트)만 사용.
alter table public.cowork_webhook_calls enable row level security;

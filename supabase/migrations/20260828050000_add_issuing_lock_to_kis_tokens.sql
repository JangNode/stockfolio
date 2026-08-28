-- KIS는 앱키당 유효 토큰이 하나뿐이라, 서로 다른 서버리스 인스턴스가 동시에
-- 재발급을 시도하면 나중에 발급된 토큰이 먼저 발급된(그리고 이미 어떤 요청이
-- 손에 쥔) 토큰을 즉시 무효화한다("기간이 만료된 token입니다" EGW00123로
-- 나타남 — 정작 우리 kis_tokens.expires_at 상 만료 전인데도). 재발급을
-- 원자적으로 한 인스턴스만 하도록 짧은 잠금(issuing_until)을 둔다.
alter table public.kis_tokens add column if not exists issuing_until timestamptz;

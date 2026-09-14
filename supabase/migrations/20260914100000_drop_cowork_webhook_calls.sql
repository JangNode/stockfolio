-- Cowork를 실행하는 샌드박스가 네트워크 정책상 임의 도메인으로 나갈 수 없어서
-- 웹훅 방식(app/api/cowork-briefing/route.ts)이 영구히 불가능하다는 게 확인됐다.
-- 대신 Google Drive 폴더 폴링 배치(scripts/sync-market-briefing-drive.ts)로
-- 전환한다. cowork_webhook_calls는 웹훅 엔드포인트 전용 레이트리밋 보조
-- 테이블이었고, 웹훅 라우트를 제거하면서 더 이상 필요 없어졌으므로 제거한다.
-- market_briefings 테이블은 Drive 폴링에서도 그대로 재사용하므로 유지한다.
drop table if exists public.cowork_webhook_calls;

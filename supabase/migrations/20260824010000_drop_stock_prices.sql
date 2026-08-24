-- stock_prices 테이블과 이를 채우던 배치(app/api/batch/update-prices/route.ts, Vercel Cron)를
-- 완전히 제거한다. DB 용량 조사(2026-08-24)에서 이 테이블을 읽는 코드가 전체
-- 코드베이스에 전혀 없음을 확인했다 — 현재가 화면(app/api/stock/[code]/route.ts)은
-- KIS API를 매번 직접 호출하고, 이 테이블은 매일 관심종목 시세를 계속 써넣기만
-- 하는 write-only 상태였다. 시세 히스토리 캐시 기능을 다시 만들 계획이 없어
-- 테이블 자체를 삭제한다(인덱스는 테이블과 함께 자동으로 제거됨).
drop table if exists public.stock_prices;

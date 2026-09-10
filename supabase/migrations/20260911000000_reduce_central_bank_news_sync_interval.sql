-- 중앙은행 뉴스 수집 폴링 간격을 20분 → 하루 1회로 줄인다.
--
-- 배경(2026-09-11): 20분 간격(*/20 * * * *, 20260830130000_create_central_bank_news.sql
-- 에서 등록)이 GitHub Actions 무료 실행 시간의 최대 소비처였다(월 약 2,806분,
-- 계정 결제 문제로 2026-09-09~10 정기 배치가 대량 실패한 사건의 배경 중 하나).
-- 이 뉴스는 화면 표시 전용이라 실시간성이 필요 없다:
--   - lib/newsStorage.ts의 getRecentCentralBankNews는 app/api/market-indicators/news
--     에서만 쓰인다 — 매매 판단(lib/backtest.ts, scripts/screen-*, scripts/paper-trade.ts)
--     어디에도 연동돼 있지 않다.
--   - FOMC/금통위 발표 직후의 빠른 감지는 Rate Announcement Check가 백오프
--     (0/5/15/30/60/120분)로 별도 전담한다 — 이 폴링은 그 역할과 무관하다.
--   - 연준 뉴스는 미 동부시간 업무시간대(KST로는 밤~새벽)에 나와 한국 사용자는
--     보통 아침에 몰아서 확인한다.
--
-- 매일 한국시간(KST) 오전 7시 = UTC 전날 22:00(미국 정규장 마감 이후라 전날
-- 밤~새벽 뉴스가 전부 반영된 시점). scripts/sync-central-bank-news.ts는 매
-- 실행마다 RSS 피드의 <item> 전체를 파싱하고(건수 제한 없음, lib/centralBankNewsSources.ts
-- 참고) link unique 제약으로 중복만 걸러내므로, 폴링 주기를 바꿔도 코드 변경이
-- 필요 없다 — 하루치를 몰아서 가져와도 그대로 안전하게 반영된다.
--
-- cron.schedule은 기존 잡 이름('trigger-central-bank-news-sync')으로 다시
-- 호출하면 스케줄만 갱신된다(같은 이름의 잡을 새로 만들지 않음) — 트리거 함수
-- 자체(public.trigger_central_bank_news_dispatch)는 그대로 재사용한다.
select cron.schedule(
  'trigger-central-bank-news-sync',
  '0 22 * * *',
  $$select public.trigger_central_bank_news_dispatch();$$
);

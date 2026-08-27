-- 백필 실측 결과 dh_daily_market_data(전종목 일별시세)가 예상보다 훨씬 커서(15년치
-- 완료 시 약 800만 행 추정) 무료 플랜 DB 용량(500MB)을 이미 넘겼다(1단계 백필이
-- 639만 행 시점에 "No space left on device"로 중단됨). 일별시세는 대부분 조회 시
-- 특정 (종목, 날짜) 한 건만 필요한 콜드 데이터라 DB보다 Storage(무료 1GB, 별도
-- 쿼터)에 Parquet로 압축 저장하는 게 맞다 — DB는 다른 표들과 500MB를 나눠 써야 하는
-- 자원이라 여기서 자유롭게 만든다.
--
-- 그래서 dh_daily_market_data 테이블은 버리고, scripts/backfill-dh-krx-prices.ts가
-- 연도별 Parquet 파일(dh-daily-prices/{year}.parquet)을 이 버킷에 쓰도록 바꾼다.
-- lib/dhFundamentals.ts의 point-in-time 조회 로직도 이 파일을 읽는 방식으로 바뀐다
-- (해당 커밋 참고). dh_annual_fundamentals/dh_dividend_history는 연/배당이벤트
-- 단위라 행 수가 적어(수천~수만 건) DB에 그대로 둬도 문제없다.
drop table if exists public.dh_daily_market_data;

insert into storage.buckets (id, name, public)
values ('dh-daily-prices', 'dh-daily-prices', false)
on conflict (id) do nothing;

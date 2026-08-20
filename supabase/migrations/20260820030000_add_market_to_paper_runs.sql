-- AI 모의투자 배치를 시장별로 분리 실행하게 되면서(국내는 국내 스크리닝 직후 KST 14:30,
-- 미국은 미국 스크리닝 직후 KST 04:00/05:00) 하루에 paper_runs 행이 최대 2개(시장별 1개)
-- 생길 수 있다. "오늘 이미 실행했는지" 중복 실행 방지 체크가 시장별로 따로 판단하도록
-- market 컬럼을 추가한다. 기존 행은 분리 이전에 국내/미국을 한 번에 처리하던 실행
-- 기록이라 기본값 'KR'로 채워둔다(과거 기록의 정확한 의미 구분보다, 앞으로의 시장별
-- 판단이 새 값 기준으로 정확히 동작하는 게 중요하다).
alter table public.paper_runs
  add column if not exists market text not null default 'KR' check (market in ('KR', 'US'));

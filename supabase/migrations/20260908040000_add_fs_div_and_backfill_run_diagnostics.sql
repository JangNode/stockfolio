-- 2026-09-08 DART 재무제표 백필 사건(6,564건 중 11건만 채워졌는데도 "성공"으로
-- 기록됨) 후속 조치.
--
-- 1) stock_annual_fundamentals에 fs_div(연결 CFS/별도 OFS) 컬럼을 추가한다.
--    scripts/backfill-stock-annual-fundamentals.ts가 이제 CFS 우선 조회 후 없으면
--    OFS로 폴백하는데(dart_cashflow_statements/dart_debt_structure의 fs_div와 동일한
--    이유 — 20260903000000 마이그레이션 참고), 연결과 별도가 섞이면 PER/ROE 비교가
--    왜곡될 수 있어 최소한 어느 쪽인지는 구분 가능해야 한다. default 'CFS'로 두면
--    기존에 이미 들어있던 114개 종목 데이터(전부 CFS로만 조회했던 시절 데이터)도
--    별도 UPDATE 없이 그대로 CFS로 소급 표시된다.
alter table public.stock_annual_fundamentals
  add column fs_div text not null default 'CFS' check (fs_div in ('CFS', 'OFS'));

-- 2) stock_data_backfill_runs에 배치 이상 종료 감지용 컬럼을 추가한다. 이번 사건의
--    진짜 문제는 코드 버그가 아니라 "6,564건 중 6,553건이 데이터없음(013)"인 비정상
--    결과가 error_count=0으로 기록되며 조용히 "성공"으로 끝났다는 점이다 — 013 자체는
--    정상 응답이라 에러로 잡히지 않기 때문. status로 성공/이상을 구분하고, 원인 추적에
--    필요한 정보(013 비율, 총 처리 건수, 콜당 평균 응답 시간)를 남긴다. 평균 응답
--    시간은 이번 사건 재현 진단에서 실제로 유용했다(정상 0.1~0.2초/콜 vs 사건 당시
--    추정 이상 지연) — 다음에 같은 일이 생기면 DART 쪽 지연인지 코드 문제인지 바로
--    구분할 수 있는 단서가 된다.
alter table public.stock_data_backfill_runs
  add column status text not null default 'success' check (status in ('success', 'anomaly')),
  add column total_targets integer,
  add column no_data_ratio numeric,
  add column avg_response_time_ms numeric;

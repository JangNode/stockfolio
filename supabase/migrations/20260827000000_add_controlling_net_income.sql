-- 지배기업 소유주지분 당기순이익(EPS/ROE 계산 분자). 증권사 PER/ROE는 보통 이
-- 값을 쓰는데, 지금까지 쓰던 fnlttMultiAcnt("다중회사 주요계정")엔 이 세부 항목이
-- 없어(전체 당기순이익만 제공) 별도로 fnlttSinglAcntAll(전체 재무제표, 단일회사
-- 전용)을 호출해 채운다 — lib/dart.ts fetchControllingNetIncome 참고.
alter table public.dart_financial_statement_years
  add column if not exists controlling_net_income numeric;

-- 상장주식수 확보용 fnlttSinglAcntAll 호출을 위한 dart_api_call_log 엔드포인트 값 추가.
alter table public.dart_api_call_log drop constraint if exists dart_api_call_log_endpoint_check;
alter table public.dart_api_call_log add constraint dart_api_call_log_endpoint_check
  check (endpoint in ('corpCode', 'fnlttMultiAcnt', 'alotMatter', 'stockTotqySttus', 'fnlttSinglAcntAll'));

-- 지난주 배치가 이미 채워둔 대형주 행들은 새 컬럼(controlling_net_income)이 null인
-- 채로 is_final=true라, syncFinancialStatements의 스킵 로직에 걸려 영영 채워지지
-- 않는다. 이번 한 번만 is_final을 풀어서 다음 배치 실행 때 지배주주순이익 +
-- 유통주식수 기준 EPS/ROE가 재계산되도록 한다.
update public.dart_financial_statement_years set is_final = false where controlling_net_income is null;

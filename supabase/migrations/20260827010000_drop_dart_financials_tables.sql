-- 재무제표/배당 이력을 DART 재조합 대신 KIS 자체 API(손익계산서/대차대조표/수익성비율/
-- 성장성비율/예탁원배당일정)로 직접 조회하도록 바꿨다(app/api/stock/[code]/financials,
-- app/api/stock/[code]/valuation, lib/kis.ts 참고) — 한국투자증권 앱 표시값과 실측
-- 비교해 KIS 값이 더 정확함을 확인했다. 이제 캐싱 테이블/배치 없이 요청 시점에 KIS를
-- 직접 호출하므로 두 표와 그 값을 채우던 주간 배치가 필요 없어졌다.
--
-- dart_corp_codes(종목코드 ↔ corp_code 매핑)는 남긴다 — 향후 종목별 공시 원문(사업
-- 보고서 등) 목록 조회 기능을 붙일 때 필요하다.
drop table if exists public.dart_financial_statement_years;
drop table if exists public.dart_dividends;

-- dart_api_call_log는 이제 corp_code 매핑 동기화 호출만 기록한다.
alter table public.dart_api_call_log drop constraint if exists dart_api_call_log_endpoint_check;
alter table public.dart_api_call_log add constraint dart_api_call_log_endpoint_check
  check (endpoint in ('corpCode'));

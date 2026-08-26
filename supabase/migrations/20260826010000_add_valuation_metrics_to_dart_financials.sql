-- 종목 상세 화면의 "가치평가지표"/"실적 정보" 섹션을 위한 파생 지표 컬럼. 기존
-- is_final 플래그를 그대로 재사용하므로("과거 확정 연도는 영구 캐시, 최신 연도만
-- 갱신") 별도 캐시 정책 없이 자동으로 같은 규칙이 적용된다.
--
-- PER/PBR/배당수익률(오늘 기준)은 여기 포함하지 않는다 — 이 값들은 "오늘 주가" 기준
-- 스냅샷이라 날짜가 지나면 곧바로 stale해지므로, 여기 캐싱된 EPS/BPS/배당금에 매
-- 요청 시점의 KIS 현재가를 곱/나눠 그때그때 계산한다(app/api/stock/[code]/valuation).
alter table public.dart_financial_statement_years
  add column if not exists revenue_growth_pct numeric,
  add column if not exists operating_income_growth_pct numeric,
  add column if not exists net_income_growth_pct numeric,
  add column if not exists operating_margin_pct numeric,
  add column if not exists net_margin_pct numeric,
  add column if not exists roe_pct numeric,
  add column if not exists eps numeric,
  add column if not exists bps numeric,
  add column if not exists shares_outstanding bigint;

-- 상장주식수 확보 폴백(DART "주식의 총수 현황")을 위한 dart_api_call_log 엔드포인트 값 추가.
alter table public.dart_api_call_log drop constraint if exists dart_api_call_log_endpoint_check;
alter table public.dart_api_call_log add constraint dart_api_call_log_endpoint_check
  check (endpoint in ('corpCode', 'fnlttMultiAcnt', 'alotMatter', 'stockTotqySttus'));

-- 지난주 배치가 이미 채워둔 대형주 300개 행은 새 컬럼(eps/bps/roe_pct 등)이 전부
-- null인 채로 is_final=true라, syncFinancialStatements의 스킵 로직("이미 확정된
-- 연도는 다시 안 부름")에 걸려 영영 채워지지 않는다. 이번 한 번만 is_final을
-- 풀어서 다음 배치 실행 때 파생 지표가 채워지도록 한다 — DART 재무제표 자체는 이미
-- 정확히 캐싱돼 있으므로(값이 바뀌는 게 아니라 파생 컬럼만 새로 계산) 다중회사
-- 조회 몇 번(대형주 300개 ÷ 100묶음 = 약 3회)만 추가로 든다.
update public.dart_financial_statement_years set is_final = false where eps is null;

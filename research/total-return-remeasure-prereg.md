# 배당 포함 총수익 재측정 — 평가 체계 수정 (시도 아님) 사전등록

B&H(069500 KIS 수정주가)는 분배금 포함 총수익, 주식 백테스트와 KOSPI는 가격수익이라 비교가 불일치. 주식 쪽에 현금배당을 넣어 총수익으로 재측정하고, 069500 원주가(분배금 제외)로 가격수익 B&H도 함께 표시.

과거 시도의 판정은 바꾸지 않고 재측정 값만 따로 보고한다. 1회 실행(1단계 → 게이트 → 통과 시 2단계), 재실행 없음. 외부 요청 0, DB 쓰기 0.

## 실행 전 확인한 사실 (코드 인용)

- 표 정의: supabase/migrations/20260827050000_create_dh_strategy_backfill_tables.sql:47-53 — `dh_dividend_history(stock_code, record_date, cash_dividend_per_share, pay_date, PK(stock_code, record_date))`, 20260828010000_rename_dh_tables_to_stock.sql:9에서 stock_dividend_history로 이름 변경.
- 출처: scripts/backfill-stock-dividends.ts:66 → lib/kis.ts:1561-1599 `getDividendRecords` (KIS 예탁원정보 배당일정 `/uapi/domestic-stock/v1/ksdinfo/dividend`, 실행 시점 기준 20년 전 1월 1일부터(DIVIDEND_YEARS_BACK = 20, :25), `per_sto_divi_amt`를 주당 현금배당으로 저장).
- 수집 대상 선정: scripts/backfill-stock-dividends.ts:40-47 + lib/stockDailyPricesStorage.ts:340-364 `discoverCandidateStockCodes` — 2011년~실행 연도의 가격 Parquet과 최근 hot 표에서 **어느 하루라도 시총 ≥ 1조(STOCK_DATA_CANDIDATE_MARKET_CAP_EOK = 10,000억, lib/stockDataConfig.ts:12)** 였던 종목. 미래 정보("한 번이라도 1조") 기준이며, 연구 유니버스(시총 5천억)보다 높다. 2010년 가격은 후보 판정에 쓰지 않는다.
- DART 교차 확인: 배당 표 dart_dividends는 20260827010000_drop_dart_financials_tables.sql:10에서 삭제됐고, 다른 표에 배당 컬럼이 없어 교차 확인은 불가로 보고한다.
- 069500: etf_daily_prices에 adj_close(수정주가)와 raw_close(원주가)가 있다(20261018200000_create_etf_daily_prices.sql:1-3).

## 1단계: 배당 데이터 점검 (먼저 보고)

1. stock_dividend_history 전체(stock_code, record_date 정렬 페이지 조회): 행 수, 종목 수, record_date 범위, 금액 0 이하 행 수, 연도별 행 수. stock_data_backfill_runs의 data_source = 'dividends' 행(실행 시각, 행 수, 실패 수).
2. 연도 y(2010~2026)별 구성원 = 그 해 분기 신호일(3·6·9·12월 마지막 거래일, 2010-03부터) 유니버스의 합집합.
   - POOL(= PEW100 구성원): ELIG(d) 시총 상위 100(제외 규칙 없음).
   - PIT 유니버스: ELIG(d) 전체(시총 5천억 + 20일 평균 거래대금 5억, 제외 규칙 없음).
   - 각 구성원에 대해: (a) 그 해 record_date가 있는 현금배당(금액 > 0) 기록 있음 비율, (b) 수집 대상 규칙(가격 Parquet 2011~2026에서 어느 하루라도 시총 ≥ 1조)에 드는 비율, (c) 배당 표에 행이 하나라도 있는 비율.
3. 069500: adj_close·raw_close 각각에 B&H 정제 규칙(e0219298)을 따로 적용한 뒤 연도별 수익률과 차이(수정 − 원주가 = 분배금 효과). 2026은 기간 끝(가격 Parquet 마지막 거래일)까지.
4. **게이트**: 모든 연도 2010~2026에서 POOL과 PIT 유니버스 구성원의 (a) 비율이 각각 70% 이상이고, 모든 신호일의 POOL·PIT 유니버스 구성원이 (b) 수집 대상 규칙에 모두 들면(빠진 종목 0개) 2단계를 계산한다. 아니면 1단계 숫자와 빠진 종목 수만 보고하고 멈춘다.

## 2단계: 총수익 재측정 (게이트 통과 시에만)

1. **배당락일**: k = record_date 이하 마지막 CAL 거래일, 배당락일 = CAL[k − 1](T+2 결제 기준 "기준일 1거래일 전"; 기준일이 휴장일이면 그 직전 거래일을 기준으로 한 칸 앞). 그 종목에 그날 가격 행이 없으면 그 배당은 반영하지 않고 건수를 보고한다.
2. **재투자**: 배당락일 종가에 재투자 — 그날 일수익률을 (P_t + D_adj) ÷ P_{t−1} − 1로 바꾼 총수익 종가 계열을 만든다. D_adj = 주당 배당금 × (그날 수정 종가 ÷ 원 종가)(이후 액면분할 등 수정 비율 반영). 세금 미반영(세전). 주식배당·무상증자는 기존 수정주가 처리 그대로.
3. **신호·선정은 가격 기준 그대로**(사전등록 정의 불변), 엔진의 평가·체결 가격만 총수익 계열로 바꾼다. 같은 실행 안에서 가격 기준 값도 다시 계산해 기존 보고와 같은지 표시한다.
4. **대상**(정의는 각 사전등록 그대로): POOL, PEW100, PEW(v1.2 U(d) 동일가중, 4c1557a), KOSPI(가격만), B&H 총수익(069500 adj_close), B&H 가격(069500 raw_close), 위성 v1.2a·v1.2b(4c1557a), CR1(1b6bf3f·e148f21: POOL 틸트 ×1.5/×1.0/×0.5, C1 3등분), 위성 v1.2a·v1.2b의 P80 조합(가격 = 위성 가격 + B&H 가격, 총수익 = 위성 총수익 + B&H 총수익; 기존 보고 정의인 위성 가격 + B&H 수정도 참고로 표시).
5. **구간**: 학습 2010-04-01~2016-12-31, 확인 2017-01-01~2021-12-31, 2022-01-01~끝, 전 기간. 모든 계열은 가격 Parquet 마지막 거래일에서 자른다.
6. **보고**: 대상별 가격수익 vs 총수익 CAGR·MDD·샤프와 차이(배당 기여 %p = 총수익 CAGR − 가격 CAGR), 연도별 배당 기여(총수익 연수익률 − 가격 연수익률), 반영한 배당 건수·반영 못 한 건수, 읽은 행·[parquet-cache] 줄, 쓴 행 0, 소요 시간. 판정·추천 문장 없음.

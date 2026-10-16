# stock_annual_fundamentals 보강 병합: 드라이런 결과 + 코드 조사 (읽기 전용, 데이터 쓰기 없음)

작성 기준일 2026-10-16. 스크립트 `scripts/merge-fundamentals-into-stock-annual.ts`(기본 `--dry-run`, 실제 삽입은 `--apply`일 때만 — 이번에는 사용하지 않음)의 드라이런 1회 결과와 코드 조사다. 숫자와 사실만 적고 판정·추천은 쓰지 않는다.

## 1. 드라이런 결과 (GitHub Actions run 38869876050, 커밋 399b41d의 임시 워크플로 — PR에서는 되돌림)
- 외부 요청(DART/KIS 등) 0건, 쓴 행 0, 소요 10초. Parquet을 읽지 않으므로 `[parquet-cache]` 줄은 없다.
- Supabase 읽은 행 합계 14,104: stock_annual_fundamentals 6,066 / stock_annual_fundamentals_fill 1,159 / dart_xbrl_fundamentals 5,425 / stock_daily_prices_recent(최근일) 1 + (최근일 시총) 577 / strategies(peg_lynch) 5 / screening_results(peg_lynch) 613 + active 245 / screening_runs 10 / 스키마 확인 3.

### 컬럼 매핑 (대상 `stock_annual_fundamentals`)
실제 컬럼: stock_code, corp_code, fiscal_year, rcept_no, rcept_date, net_income_parent, equity_parent, fs_div. 제약(마이그레이션 `20260827050000`, `20260828010000`, `20260908040000`): PK (stock_code, fiscal_year); NOT NULL = stock_code, corp_code, fiscal_year, rcept_no, rcept_date, fs_div(default 'CFS', check CFS/OFS); net_income_parent·equity_parent는 numeric nullable, 단위 원; 인덱스 (stock_code, rcept_date).

| 대상 컬럼 | fill 표(status='ok') | dart_xbrl_fundamentals |
|---|---|---|
| stock_code | stock_code | stock_code |
| corp_code | corp_code | corp_code |
| fiscal_year | fiscal_year | fiscal_year (FY2010 = source 'prior_col' 행 그대로 2010) |
| fs_div | fs_div | ni_basis: cons→CFS, sep→OFS (nodim은 매핑 불가로 제외) |
| rcept_no | rcept_no | rcept_no (prior_col 행은 FY2011 보고서 접수번호) |
| rcept_date | rcept_date | rcept_dt (prior_col 행은 FY2011 접수일 그대로) |
| net_income_parent | net_income_parent | ni_parent (null이면 제외) |
| equity_parent | equity_parent | equity_parent |

### 삽입 예정 행 (소스 × 회계연도)
| 소스 | 2010 | 2011 | 2012 | 2013 | 2014 | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 합계 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fill | 0 | 0 | 0 | 0 | 0 | 110 | 75 | 79 | 54 | 114 | 156 | 50 | 60 | 46 | 75 | 92 | 911 |
| xbrl | 576 | 583 | 596 | 615 | 641 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3,011 |
| 합계 | 576 | 583 | 596 | 615 | 641 | 110 | 75 | 79 | 54 | 114 | 156 | 50 | 60 | 46 | 75 | 92 | 3,922 |

- 충돌로 건너뛸 행(이미 같은 (종목, FY)가 있음): fill 0건, xbrl 0건. 소스 간 중복 0건.
- 대상에서 제외된 소스 행: xbrl ni_parent null — no_report 2,040 / xbrl_014 254 / partial 120; fill status no_data_013 248.
- 매핑 이상(삽입 예정 3,922행 기준): net_income_parent null 0; equity_parent null 8; equity_parent 음수 13; 단위 이상치(|값|≥1e15 원 또는 0<|값|<1e3 원) net_income_parent 2 / equity_parent 2; rcept_no 앞 8자리 ≠ rcept_date 6; rcept_date < 회계연도 12-31 11.

### 병합 후 예상
행 수 6,066 → 9,988(+3,922), 종목 수 691 → 1,062(+371).

| FY | 현재 | 병합 후 |
|---|---|---|
| 2010 | 0 | 576 |
| 2011 | 0 | 583 |
| 2012 | 0 | 596 |
| 2013 | 0 | 615 |
| 2014 | 0 | 641 |
| 2015 | 444 | 554 |
| 2016 | 456 | 531 |
| 2017 | 487 | 566 |
| 2018 | 505 | 559 |
| 2019 | 520 | 634 |
| 2020 | 546 | 702 |
| 2021 | 562 | 612 |
| 2022 | 577 | 637 |
| 2023 | 642 | 688 |
| 2024 | 659 | 734 |
| 2025 | 668 | 760 |

되돌리기: 실행 시 저장되는 `merge-fundamentals-applied-<시각>.json`의 키 목록 (stock_code, fiscal_year, source)에 해당하는 행만 삭제한다(삽입은 `ignoreDuplicates`라 기존 행은 건드리지 않는다).

## 2. 코드 조사: 운영에서 stock_annual_fundamentals를 읽는 곳
| 위치 | 내용 |
|---|---|
| `lib/stockFundamentals.ts:44-57` (select는 :47-50) | `loadFundamentalsSeries` — 유일한 읽기 통로. 컬럼 fiscal_year, rcept_no, rcept_date, net_income_parent, equity_parent, fs_div, rcept_date 오름차순 |
| `lib/stockFundamentals.ts:83-87` / `:113-133` / `:146-177` / `:186-201` | `getFundamentalsAsOf` / `computeValuationAsOf` / `computeEpsCagrAsOf` / `loadFundamentalsSeriesWithListedShares` (모두 위 함수를 호출: :84, :151, :192) |
| `app/api/stock/[code]/valuation/route.ts:4, :54` | 가치평가 카드 PEG의 EPS 성장률(`computeEpsCagrAsOf`) |
| `app/api/stock/[code]/fundamentals-backtest/route.ts:4, :34` | 커스텀 백테스트(재무 조건·PEG)용 `loadFundamentalsSeriesWithListedShares` |
| `scripts/screen-all-stocks.ts:49-50, :932-933` | 스크리닝 peg_lynch(`scanFundamentalStrategies`, :888~) |
| `scripts/compute-strategy-backtest-summary.ts:34, :291-296` | 장기 백테스트 배치(peg_lynch를 계산하는 실행에서만 종목당 로드) |
| `scripts/backfill-stock-annual-fundamentals.ts:159, :300` | 쓰기 경로(기존 키 조회 + upsert) |

그 외 `lib/stockDailyPricesStorage.ts:25`, `lib/pointInTimeFundamentals.ts:35`, `lib/dartValuationConfig.ts:29`는 주석 언급뿐이다.

## 3. 화면의 peg_lynch 백테스트 수치
- 저장 표: `strategy_backtest_summary`(+ 벤치마크 `benchmark_summary`), 계산 시마다 새 행 insert(`scripts/compute-strategy-backtest-summary.ts:404, :495`). 화면 API `app/api/strategies/backtest-summary/route.ts`가 stage별 최신 행을 읽는다.
- stage(`lib/strategyBacktestSummaryConfig.ts`): 화면 기본 `pit_adjusted_cap5000`(2016~, :79) / 기준 기간 `pit_adjusted_cap5000_from2010`(2010~, :87) / peg 카드 보조줄 `pit_adjusted_cap5000_from_signal`(2021-03-01~, :124). 화면 미노출 기본값 `pit_adjusted`(:51).
- 만드는 workflow: `.github/workflows/compute-strategy-backtest-summary.yml`(매주 월요일 KST 05:00 `schedule` + `workflow_dispatch`). 한 번 실행하면 `batch:strategy-backtest-summary`를 네 번(pit_adjusted / pit_adjusted_cap5000 / pit_adjusted_cap5000_from2010 / pit_adjusted_cap5000_from_signal) 돌려 네 stage를 모두 새로 저장한다. 입력은 `data_widen_stage`(비움 = pit_adjusted), `cost_free_dry_run`("false")뿐이고, 특정 stage만 고르는 입력은 없다.
- 직전 main 실행(2026-10-12 16:36Z, run 38278542976): peg_lynch CAGR 10.2%(pit_adjusted) / 9.3%(cap5000) / 5.9%(from2010) / 18.7%(from_signal), 거래 851/707/707/707건, 소요 약 6분 10초.

### 병합 후 재계산 (실행하지 않음)
- 필요한 실행: `compute-strategy-backtest-summary.yml`을 `workflow_dispatch` 1회(입력 기본값). 이 workflow는 KRX 지수·시세 갱신 스텝(`KRX_API_KEY`, 외부 요청)을 포함하므로 외부 요청 0건 조건과는 별개다. 저장 없이 계산만 하려면 `DRY_RUN=true`가 필요한데 workflow 입력에는 없다(스크립트 환경변수 :72 `DRY_RUN`).
- Parquet 읽기: `PRICE_FETCH_START_YEAR = max(2010, WINDOW_START_YEAR − 2)`(:127) → 2016 stage 두 개는 2014~2026(13개 파일 180.72 MB), from2010·from_signal은 2010~2026(17개 파일 230.05 MB). 연도 파일 크기는 직전 연구 실행 로그의 `[parquet-cache]` 값(MB): 2010 12.21, 2011 12.46, 2012 12.41, 2013 12.25, 2014 12.23, 2015 11.44, 2016 11.84, 2017 12.10, 2018 12.59, 2019 13.04, 2020 13.66, 2021 14.07, 2022 14.45, 2023 16.85, 2024 17.23, 2025 17.59, 2026 13.63.
- 디스크 캐시(`lib/parquetDiskCache.ts`, workflow의 Restore/Save Parquet cache 스텝): 캐시 적중이면 Storage 다운로드 0, 미적중이면 한 job 안에서 파일당 한 번씩 최대 230.05 MB(캐시가 없던 2026-10-12 실행은 invocation마다 다시 읽어 최대 약 821.5 MB = 180.72×2 + 230.05×2).
- 캐시 범위: 지금까지 `parquet-v1-Linux-*` 캐시는 연구 브랜치 `claude/ma-v3-portfolio-cap-run`의 실행(예: run 38695340606, head_branch가 그 브랜치)이 만든 것이다. GitHub Actions 캐시는 현재 브랜치와 기본 브랜치(main)의 캐시만 복원할 수 있으므로, main에서 도는 이 workflow는 그 캐시를 복원하지 못한다. main 자체 캐시 목록은 이 환경의 프록시가 Actions 캐시 API를 막아(HTTP 403) 확인하지 못했고, 2026-10-12 main 실행 로그에는 캐시 스텝이 없었다.
- Postgres 읽기: 배치 4회 모두 peg_lynch를 포함해 종목당 `loadFundamentalsSeriesWithListedShares`를 호출 → 호출당 읽는 stock_annual_fundamentals 행은 대상 종목들의 행 합계(현재 표 6,066행, 병합 후 9,988행) 이내이고, 4회 합산 최대 약 24,264행 → 약 39,952행(+ stock_dividend_history 행).

## 4. 신호 판정 동작: "상태 undefined → true"
- 백테스트: `lib/backtest.ts:82` golden = 직전 상태 `false` → 현재 `true`(undefined→true는 전환 아님). `:362` `detectStateTransitions(...).filter(date >= windowStartDate)`, `:367-375` 진입 = golden && 열린 포지션 없음 && entryAllowed, `:390-404` 기간 끝 미청산은 마지막 봉 강제청산.
- 스크리닝도 같은 함수: `lib/backtest.ts:116-123` `isEntrySignalAt`(:122 `isGoldenTransition(states[index-1], states[index])`), `:435-443` `matchesEntrySignalToday`, 호출 `scripts/screen-all-stocks.ts:967`. 스크리닝은 직전 봉과 오늘 봉 2개만 만든다(`:939-950`)이므로 "전일 false → 오늘 true"인 날에만 신규 등록된다. 종료는 `lib/backtest.ts:126-128`(`states[index] === false`, undefined는 청산 아님)과 `:446-454`(`matchesSignalExitToday`), 호출 :958.
- 후보 풀: `scripts/screen-all-stocks.ts:848-855` — 2011년부터 시가총액이 한 번이라도 `STOCK_DATA_CANDIDATE_MARKET_CAP_EOK`(1조, `lib/stockDataConfig.ts`) 이상이었던 종목 중 마스터 필터 통과분.

## 5. 오늘 기준 입력 완비도와 최근 스크리닝 (읽기만으로 추정한 숫자)
기준일 2026-10-15(hot 표 최근 거래일, 그날 577종목 행). 풀은 그날 시가총액 기준 근사이며 실제 풀(위 후보 풀)과 다르다. 상태 true 종목 수는 과거 시점 상장주식수(Parquet)가 필요해 계산하지 않았다.

| 풀 | 종목 수 | 구분 | 재무 행 없음 | EPS 연도쌍 없음 | 연결/별도 불일치 | 입력 갖춤 |
|---|---|---|---|---|---|---|
| 시총 ≥ 10,000억 | 304 | 현재 | 11 | 56 | 11 | 226 |
| 시총 ≥ 10,000억 | 304 | 병합 후 | 11 | 56 | 11 | 226 |
| 시총 ≥ 5,000억 | 461 | 현재 | 41 | 83 | 14 | 323 |
| 시총 ≥ 5,000억 | 461 | 병합 후 | 16 | 87 | 14 | 344 |

(공시된 재무 없음·최신 순이익 null·연도쌍 순이익 null 항목은 모든 행에서 0.)

최근 peg_lynch 스크리닝(전략 행 5개): 최근 30일 매칭 행 613건(서로 다른 종목 74개; stopped 443 / active 160 / profited 10), 매칭 발생 일수 14일(일평균 43.79건, 최대 120건), 현재 active 245건(49종목). `screening_runs` 최근 10건의 전 전략 합산 매칭: 2026-10-16 05:30 0, 10-15 19:00 0, 10-15 05:30 0, 10-12 19:00 0, 10-12 05:30 120, 10-09 19:00 0, 10-08 19:00 0, 10-08 05:30 88, 10-07 19:00 9, 10-07 05:30 48.

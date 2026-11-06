// 신호 스캔 5회차(5-A 외국계 창구 일별 매매, 5-B 대차잔고) 수집·스캔 기준값. 사용자 승인 2026-11-06(11-14 이후 첫 승인일에 실행).
// 사전등록: docs/research/signal-scan-5-prereg.md(수집 전 확정 커밋), 수집 계획: docs/research/signal-scan-5-collection-plan.md
// 호출 금지 시간대·rate limit 재시도·연속 오류는 lib/shortCreditCollectConfig.ts(SC_COLLECT_*)와 lib/investorFlowConfig.ts를 그대로 쓴다.

/** 수집 구간(신호일 기준 학습 구간만 먼저). 5-A는 4-A 체결강도와 같은 구간, 5-B는 4-B 초안 구간(2015-01 이전 값은 쓰지 않음). */
export const S5_FM_FROM = "2011-01-03";
export const S5_FM_TO = "2016-12-31";
export const S5_LOAN_FROM = "2015-01-01";
export const S5_LOAN_TO = "2019-12-31";
/** 스캔 구간(학습만). 첫 표본일은 SCAN_START 이후 첫 월말·주말. 이 날짜를 넘는 행은 읽은 직후 버린다. */
export const S5_FM_SCAN_START = "2011-04-01";
export const S5_FM_SCAN_END = "2016-12-31";
export const S5_LOAN_SCAN_START = "2015-04-01";
export const S5_LOAN_SCAN_END = "2019-12-31";

/** 외국계 창구 TR: 종목(FID_INPUT_ISCD)과 회원사 코드(FID_INPUT_ISCD_2) 하나의 일별 계열. 99999 = 외국계 합계로 알려진 코드(의미는 스캔 전 점검, 사전등록 7절). */
export const S5_FM_PATH = "/uapi/domestic-stock/v1/quotations/inquire-member-daily";
export const S5_FM_TR = "FHPST04540000";
export const S5_FM_MEMBER = "99999";
/** 호출당 응답 행 수(상한): 2026-11-05 점검에서 21~23행까지만 확인되어 **미확인(null)**. 파일럿(SCAN5_MODE=pilot) 결과로 정해 커밋한 뒤에만 본 수집(fm)이 실행된다. 연 범위·6년 범위가 상한 없이 다 나오면 6년 범위 응답 행 수 이상의 값을 둔다. */
export const S5_FM_PAGE_ROWS: number | null = null;
/** 대차 TR(HHPST074500C0, 종목 단위 MRKT_DIV_CLS_CODE=3): 호출당 100행 확정, 구간의 최근 쪽 행부터 준다(2026-11-05 3차 호출). */
export const S5_LOAN_PATH = "/uapi/domestic-stock/v1/quotations/daily-loan-trans";
export const S5_LOAN_TR = "HHPST074500C0";
export const S5_LOAN_MKT_DIV = "3";
export const S5_LOAN_PAGE_ROWS = 100;
/** 요청 누적 상한 = 파일럿 확정 중심값(종목별 ceil(구간 거래일 ÷ 호출당 행 수)의 합)의 이 배수. 회차 최대 시간과 체크포인트는 4-A와 같다. */
export const S5_REQUEST_CAP_FACTOR = 1.3;
export const S5_RUN_MAX_MS = 4.75 * 3600e3;
export const S5_CHECKPOINT_STOCKS = 20;
export const S5_CHECKPOINT_MS = 20 * 60e3;
/** Storage 총량 상한(바이트, 전 버킷 합계)과 이번 쓰기 예산(바이트, 계획서 4.1절: 5-A 약 12~16 MiB, 5-B 약 8~10 MiB, 각각 여유 포함). */
export const S5_STORAGE_CAP_BYTES = 800 * 1048576;
export const S5_FM_WRITE_BUDGET_BYTES = 20 * 1048576;
export const S5_LOAN_WRITE_BUDGET_BYTES = 14 * 1048576;
/** 저장 경로(버킷은 INVESTOR_FLOW_STOCK_STORE_BUCKET). */
export const S5_FM_PREFIX = "research/foreign_member_daily";
export const S5_FM_CLEAN_PREFIX = "research/foreign_member_daily_clean";
export const S5_LOAN_PREFIX = "research/loan_balance";
export const S5_LOAN_CLEAN_PREFIX = "research/loan_balance_clean";
export const S5_PROGRESS_FILE = "_progress.json";
/** 수급 수집 진행 파일(대상 420종목 집합 대조용, 약 24 KB). */
export const S5_FLOW_STOCK_PROGRESS_PATH = "research/investor_flow_stock/_progress.json";
/** Actions 캐시·아티팩트 디렉터리와 캐시 키(정리본 입력, 수집 모드별). */
export const S5_CACHE_DIR_FM = ".scan5-fm-inputs";
export const S5_CACHE_DIR_LOAN = ".scan5-loan-inputs";
export const S5_CACHE_KEY_FM = "research-scan5-fm-inputs-v1";
export const S5_CACHE_KEY_LOAN = "research-scan5-loan-inputs-v1";
/** 외국인 투자자 순매수 대금 부분집합(FMD 신호용; Actions 캐시 research-flow-subset-20261028 또는 아티팩트, 열 stock_code·trade_date·frgn_ntby_amt). */
export const S5_FLOW_SUBSET_DIR = ".research-flow";
export const S5_FLOW_SUBSET_FILE = "flow_frgn.parquet";
export const S5_FLOW_SUBSET_SHA256 = "e4eae79b4d09940a28d4ad5e33be506095715ea4031d8c60b5df9560ee19706d";

// ---- 스캔 단계 기준값(사전등록 3~4·7절) ----
/** 외국계 창구 일별 값 합 환산 창(거래일)과 최소 유효 일수: FM5 5일(4개 이상), FM20 20일(14개 이상), FI5(외국인 투자자) 5일(4개 이상). */
export const S5_FM_WINDOWS = [5, 20] as const;
export const S5_FM_MIN_VALID = { 5: 4, 20: 14 } as const;
/** 외국인 투자자 대금 단위 환산 후보 κ와 중앙값 비율 허용 범위(사전등록 3.1절). */
export const S5_FI_KAPPAS = [1, 1e3, 1e6] as const;
export const S5_FI_RATIO_MIN = 0.1;
export const S5_FI_RATIO_MAX = 10;
/** 99999 의미 대조: 학습 구간 마지막 월말 시총 상위 N종목의 일별 x와 fi의 피어슨 상관 중앙값이 이 값 미만이면 스캔하지 않는다. */
export const S5_ID_TOP_N = 20;
export const S5_ID_MIN_CORR = 0.3;
/** 선행 조건(사전등록 7절): 순매수 항등 불일치 상한, 응답 종가와 가격 Parquet 원주가 종가의 비 허용 폭과 최소 비율. */
export const S5_NTBY_IDENTITY_MAX_RATIO = 0.001;
export const S5_CLOSE_TOL = 0.01;
export const S5_CLOSE_MIN_SHARE = 0.95;
/** 값 전부 0인 종목 상한(요청 대상 대비)과 가격은 있는데 데이터가 없는 날 상한(학습 구간 종목-일 대비). */
export const S5_MAX_ALL_ZERO_STOCK_RATIO = 0.1;
export const S5_MAX_MISSING_DAY_RATIO = 0.05;
/** 대차 값 이어 쓰기 최대 거래일, 변화율 창(거래일), 사용일 지연(거래일). 4-B 초안 그대로. */
export const S5_LOAN_LAG_DAYS = 2;
export const S5_LOAN_CARRY_DAYS = 5;
export const S5_LOAN_CHG_DAYS = 20;
/** 겹치는 구간 참고 열: 비중복 t는 오프셋별 일반 t의 중앙값, 최소 표본 수(표본 간격은 lib/signalScanConfig.ts SCAN_SPACING_*). */
export const S5_NONOVERLAP_MIN_SAMPLES = 10;
/** 스캔 행 수 기록(사전등록 5절): 이전 누적, 5-A 행, 5-B 행. */
export const S5_PRIOR_SCAN_ROWS = 345;
export const S5_ROWS_A = 24;
export const S5_ROWS_B = 16;
export const S5_EOK_TO_WON = 1e8;
/** MID = PIT 적격 중 시총 101~150위(slice 끝, POOL은 SCAN_POOL_SIZE=100). */
export const S5_MID_TO = 150;
/** 신용잔고 정리본(후보가 나온 경우 중복 점검용): 11-14 이후 첫 승인일에 한 번 읽어 Actions 캐시·아티팩트로 저장(연도 파일 바이트 그대로, 약 20.6 MiB). */
export const S5_CREDIT_CLEAN_PREFIX = "research/credit_balance_clean";
export const S5_CREDIT_YEAR_FROM = 2011;
export const S5_CREDIT_YEAR_TO = 2019;
export const S5_CACHE_DIR_CREDIT = ".scan5-credit-inputs";
export const S5_CACHE_KEY_CREDIT = "research-scan5-credit-inputs-v1";

// VKOSPI(코스피 200 변동성지수) 신호 스캔(가벼운 버전) 수집·스캔 기준값. 사용자 지정 2026-11-05. 사전등록: docs/research/vkospi-scan-prereg.md (수집 전 커밋)
// 호출 금지 시간대·rate limit 재시도 대기는 lib/shortCreditCollectConfig.ts(SC_COLLECT_*)를 그대로 쓴다. 비용 상수는 lib/transactionCostConfig.ts·lib/coreSatelliteConfig.ts를 가져다 쓴다.

/** KRX Open API 파생상품지수 시세정보(이용신청 승인 확인: docs/research/data-feasibility-2.md 9절). */
export const VK_ENDPOINT = "idx/drvprod_dd_trd";
export const VK_BASE_URL = "https://data-dbg.krx.co.kr/svc/apis";
/** 응답에서 남기는 한 행의 지수명(앞뒤 공백만 제거하고 정확히 같아야 한다. 여러 행이거나 없으면 그 날짜는 결측). */
export const VK_IDX_NAME = "코스피 200 변동성지수";
/** 수집 기간(거래일별 호출). 스캔은 학습 구간 값만 계산하고 그 뒤 행은 읽은 직후 버린다. */
export const VK_FROM = "2011-01-03";
export const VK_TO = "2026-11-04";
/** 호출 간격(ms)과 요청 상한(재시도 포함)과 회차 최대 시간. 간격·상한은 KRX ETF 일별 수집(lib/etfKrxDailyConfig.ts)과 같은 값. */
export const VK_GAP_MS = 300;
export const VK_REQUEST_CAP = 4_500;
export const VK_RUN_MAX_MS = 4.75 * 3600e3;
/** 진행 로그·체크포인트 주기(요청 수). */
export const VK_LOG_EVERY_REQ = 250;
/** 연속 오류가 이만큼이면 멈추고 이어받기 파일을 남긴다. */
export const VK_CONSEC_ERROR_STOP = 5;
/** 저장 경로(버킷은 INVESTOR_FLOW_STOCK_STORE_BUCKET)와 Actions 캐시·아티팩트. */
export const VK_PREFIX = "research/vkospi";
export const VK_CACHE_DIR = ".vkospi-inputs";
export const VK_CACHE_KEY = "research-vkospi-inputs-20261105";
export const VK_RESUME_CACHE_PREFIX = "research-vkospi-resume-";
export const VK_PROGRESS_FILE = "_progress.json";
/** Storage 쓰기 예산(바이트, 사용자 승인 "수백 KiB"). 넘으면 경고. */
export const VK_WRITE_BUDGET_BYTES = 512 * 1024;

// ---- 스캔 단계(scripts/research-vkospi-scan.ts) ----
export const VK_PREREG_DOC = "docs/research/vkospi-scan-prereg.md";
/** 학습·확인·보류 구간(신호일 기준). 이 스캔은 학습 구간만 계산한다. */
export const VK_LEARN_END = "2016-12-31";
export const VK_CONFIRM_FROM = "2017-01-01";
export const VK_CONFIRM_TO = "2021-12-31";
export const VK_HOLDOUT_FROM = "2022-01-01";
/** 신호 정의: 5일 변화율의 일수, 252일 대비 백분위의 창(거래일, 당일 포함), 급등일 기준(전일 대비 증가율). */
export const VK_CHG_DAYS = 5;
export const VK_PCT_WINDOW = 252;
export const VK_SPIKE_RET = 0.15;
/** 예측 기간(거래일): 진입 = 신호일 다음 거래일 종가, 청산 = 진입 + H. */
export const VK_HORIZONS = [5, 21, 63] as const;
/** 확장 백분위(수준·5일 변화율)에 필요한 앞선 유효 표본 수 = 252일 창과 같은 첫 표본일을 쓰기 위해 창 길이 − 1. */
export const VK_MIN_PRIOR = VK_PCT_WINDOW - 1;
/** 상태 경계(상위 ≥ HI, 하위 ≤ LO). 4-A 시장 단위 스캔과 같다. */
export const VK_HI = 2 / 3;
export const VK_LO = 1 / 3;
/** Newey-West 시차 = 예측 기간 H(진입~청산이 H일이라 이웃 표본의 수익 구간이 H−1일 겹치므로 H−1 이상). */
export const vkNwLag = (h: number): number => h;
/** 후보 기준 |t|는 lib/signalScanConfig.ts SCAN_CANDIDATE_ABS_T(3.0). 비용: 069500 편도 = FEE_PCT_PER_SIDE + SLIPPAGE_PCT_PER_SIDE(증권거래세 없음), DS6 편도 = CS_MOVE_COST(lib/coreSatelliteConfig.ts). */
/** 선행 조건: 학습 구간 KOSPI 거래일 중 VKOSPI 값이 없는 날 비율 상한. */
export const VK_MAX_MISSING_RATIO = 0.02;
/** 선행 조건: DS6 재현(시도 272 기록 구간 A 2011-01-04~2016-12-29, CAGR % / MDD %). */
export const VK_DS6_REPRO = { cagr: "4.10", mdd: "24.51" } as const;
/** 급등일 독립 사건 수(앞 사건 뒤 H일 안의 급등일은 같은 사건)가 이보다 적으면 보고서에 "표본 부족" 표시(행 수·판정은 그대로). */
export const VK_SPIKE_MIN_EVENTS_NOTE = 10;

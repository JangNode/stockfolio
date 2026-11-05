// 신호 스캔 4회차 4-A(체결강도·프로그램매매 시장 단위) 수집·스캔 기준값. 사용자 승인 2026-11-05. 사전등록: docs/research/signal-scan-3-prereg.md(확정 커밋 b7edd74), 수집 계획: docs/research/signal-scan-3-collection-plan.md
// 호출 금지 시간대·rate limit 재시도·연속 오류·체크포인트 주기는 lib/shortCreditCollectConfig.ts(SC_COLLECT_*)와 lib/investorFlowConfig.ts를 그대로 쓴다.

/** 체결강도(종목 단위) 수집 기간: 학습 구간만(2011-01-03 ~ 2016-12-31). 확인·보류 구간은 후보가 나온 뒤 별도 승인. */
export const S4_FLOW_FROM = "2011-01-03";
export const S4_FLOW_TO = "2016-12-31";
/** 프로그램매매 시장 단위 수집 기간(전 구간, 호출 약 32~34회). 스캔은 학습 구간 값만 계산한다. */
export const S4_MKT_FROM = "2011-01-03";
export const S4_MKT_TO = "2026-10-26";
export const S4_MKT_CODES = ["K", "Q"] as const;
/** 이 이상 앞 날짜가 남아 있지 않다고 보는 간격(일): 연초 휴장 때문에 조회 시작일보다 늦게 시작하는 첫 거래일을 허용. */
export const S4_MKT_EDGE_DAYS = 10;
/** 종목 단위 TR 호출당 최대 행 수(2026-11-05 관측: 100행). */
export const S4_FLOW_PAGE_ROWS = 100;
/** 한 회차 요청 상한(예상 약 5,300 + 시장 34의 1.3배), 회차 최대 시간. */
export const S4_REQUEST_CAP = 7_000;
export const S4_RUN_MAX_MS = 4.75 * 3600e3;
/** 체크포인트 주기: 종목 20개마다 또는 20분마다. */
export const S4_CHECKPOINT_STOCKS = 20;
export const S4_CHECKPOINT_MS = 20 * 60e3;
/** Storage 총량 상한(바이트, 전 버킷 합계)과 이번 1단계 쓰기 예산(바이트, 사용자 승인 16~22 MiB 이내). */
export const S4_STORAGE_CAP_BYTES = 800 * 1048576;
export const S4_WRITE_BUDGET_BYTES = 22 * 1048576;
/** 저장 경로(버킷은 INVESTOR_FLOW_STOCK_STORE_BUCKET). */
export const S4_FLOW_PREFIX = "research/exec_strength";
export const S4_FLOW_CLEAN_PREFIX = "research/exec_strength_clean";
export const S4_MKT_PREFIX = "research/program_trade_market";
export const S4_MKT_CLEAN_PREFIX = "research/program_trade_market_clean";
export const S4_PROGRESS_FILE = "_progress.json";
/** 수급 수집 진행 파일(대상 420종목 집합 대조용, 약 24 KB). */
export const S4_FLOW_STOCK_PROGRESS_PATH = "research/investor_flow_stock/_progress.json";
/** Actions 캐시·아티팩트 디렉터리와 캐시 키(정리본 입력). */
export const S4_CACHE_DIR = ".scan4a-inputs";
export const S4_CACHE_KEY = "research-scan4a-inputs-20261105";
/** TR. */
export const S4_FLOW_PATH = "/uapi/domestic-stock/v1/quotations/inquire-daily-trade-volume";
export const S4_FLOW_TR = "FHKST03010800";
export const S4_MKT_PATH = "/uapi/domestic-stock/v1/quotations/comp-program-trade-daily";
export const S4_MKT_TR = "FHPPG04600001";
/** 프로그램매매 저장 열: 코스피 K·코스닥 Q별 전체·차익·비차익 합계(위탁+자기) 매수·매도 대금. */
export const S4_MKT_VALUE_COLS = ["whol_smtn_shnu_tr_pbmn", "whol_smtn_seln_tr_pbmn", "arbt_smtn_shnu_tr_pbmn", "arbt_smtn_seln_tr_pbmn", "nabt_smtn_shnu_tr_pbmn", "nabt_smtn_seln_tr_pbmn"] as const;

// ---- 스캔 4-A 스캔 단계(scripts/research-signal-scan-4a.ts) 기준값. 사전등록 docs/research/signal-scan-3-prereg.md (확정 b7edd74) ----
export const S4_PREREG_COMMIT = "b7edd74";
/** 스캔 구간(학습만). 이 날짜를 넘는 가격·체결량·프로그램매매 행은 읽은 직후 버린다. 첫 표본일은 SCAN_START 이후 첫 월말·주말. */
export const S4_SCAN_START = "2011-04-01";
export const S4_SCAN_END = "2016-12-31";
/** MID = PIT 적격 중 시총 101~150위(슬라이스 끝, POOL은 SCAN_POOL_SIZE=100). */
export const S4_MID_TO = 150;
/** 체결강도 평균 창(거래일). 최소 유효 일수는 ceil(2w/3) (SCAN_FLOW_MIN_PRICE_DAY_RATIO). */
export const S4_T_WINDOWS = [5, 20] as const;
/** 프로그램매매 창(거래일)과 시장 단위 통계: 확장 백분위에 필요한 앞선 유효 표본 수, 상위·하위 경계, 예측 기간(거래일). */
export const S4_PG_WINDOW = 5;
export const S4_PG_MIN_PRIOR = 36;
export const S4_PG_HI = 2 / 3;
export const S4_PG_LO = 1 / 3;
export const S4_MKT_HORIZONS = [5, 21] as const;

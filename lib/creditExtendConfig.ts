// 신용잔고 2017~ 수집 이어받기(scripts/collect-credit-extend.ts, research/credit-incremental-prereg.md 2단계) 기준값. 모두 사용자 사전등록(2026-10-20).
// 호출 금지 시간·rate limit 재시도·회차 시간 상한·Storage 상한·진행 저장 주기·신용잔고 화면 코드·페이지 행 수는 lib/shortCreditCollectConfig.ts(SC_COLLECT_*)와 lib/investorFlowConfig.ts를 그대로 쓴다.

/** 수집 기간: 앞 1개월(2016-12)은 이어 쓰기용 겹침이라 기존 2016.parquet과 대조만 한다. */
export const CX_FROM = "2016-12-01";
export const CX_TO = "2026-10-16";
/** 이 단계의 신규 외부 요청 누적 상한(이전 수집 59,535건은 포함하지 않음). */
export const CX_REQUEST_TOTAL_CAP = 100_000;
/** 새로 만드는 연도 파일 범위와, 겹침 대조에 읽기만 하는 연도·마지막 날. */
export const CX_NEW_FIRST_YEAR = 2017;
export const CX_LAST_YEAR = 2026;
export const CX_OVERLAP_YEAR = 2016;
export const CX_OVERLAP_END = "2016-12-31";
/** 이 단계의 진행 파일(research/credit_balance/ 안, 기존 _progress.json은 건드리지 않음). */
export const CX_PROGRESS_FILE = "_progress_ext.json";

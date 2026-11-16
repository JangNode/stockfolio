// 앞으로 쌓이는 데이터(백필 불가) 수집 기준값. 근거·승인: docs/research/forward-data-plan.md(사용자 승인 2026-11-17).
// 연구 브랜치 전용. 수집만 하고 분석·신호 확인은 하지 않는다. 저장은 Supabase Storage research/forward/ 아래 한 사본만(아티팩트 업로드 금지: 저장소가 공개).
export const FWD_PREFIX = "research/forward";
/** 소진율 일별: 실행별 새 행 파일 `<실행일>_<실행번호>.parquet` + `_progress.json`(종목별 이어받기) + `manifest.json`(종목별 마지막 거래일·SHA-256) + `targets.json`(수집 대상 372종목). */
export const FWD_FRGN_PREFIX = `${FWD_PREFIX}/frgn_ehrt`;
/** 분봉: `<종목>/<YYYY-MM>.parquet`(종목·월 단위 한 사본) + `_progress.json` + `manifest.json` + `targets.json`. */
export const FWD_MIN_PREFIX = `${FWD_PREFIX}/minute`;
export const FWD_PROGRESS_FILE = "_progress.json";
export const FWD_MANIFEST_FILE = "manifest.json";
export const FWD_TARGETS_FILE = "targets.json";
export const FWD_DAYS_FILE = "days.json";

// ---- KIS TR (경로는 lib/kis.ts·data-feasibility-2와 같다) ----
export const FWD_Q_BASE = "/uapi/domestic-stock/v1/quotations";
/** 주식현재가 일자별: 종목당 한 호출이 최근 30거래일(날짜 지정 없음). 소진율 hts_frgn_ehrt, 외국인 순매수 수량 frgn_ntby_qty. */
export const FWD_DAILY_PATH = `${FWD_Q_BASE}/inquire-daily-price`;
export const FWD_DAILY_TR = "FHKST01010400";
export const FWD_DAILY_ROWS = 30;
/** 주식현재가 시세: 당일 값만(외국인 보유수량 frgn_hldn_qty, 상장주식수 lstn_stcn, 소진율 hts_frgn_ehrt). 보유율 환산 대조용(검증 호출만). */
export const FWD_PRICE_PATH = `${FWD_Q_BASE}/inquire-price`;
export const FWD_PRICE_TR = "FHKST01010100";
/** 일별 분봉: 날짜 + 종료 시각을 주면 그날 1분봉을 종료 시각부터 거꾸로 한 호출 120행. */
export const FWD_MIN_PATH = `${FWD_Q_BASE}/inquire-time-dailychartprice`;
export const FWD_MIN_TR = "FHKST03010230";
export const FWD_MIN_PAGE_ROWS = 120;
export const FWD_MIN_END_HHMMSS = "153000";
export const FWD_MIN_START_HHMM = 900;

// ---- 소진율 수집 일정 (승인: 4주마다 수동, 마감 35일, 25일·32일째 알림) ----
export const FWD_FRGN_INTERVAL_DAYS = 28;
export const FWD_FRGN_DEADLINE_DAYS = 35;
/** 이 일수를 넘기면 사이 날짜가 영구 공백(마지막 행을 잠정으로 보는 최악, docs/research/forward-data-plan.md 1.6). */
export const FWD_FRGN_HARD_MAX_DAYS = 38;
export const FWD_FRGN_REMIND_DAYS = [25, 32] as const;

// ---- 분봉 백필 범위 (시총 상위 30종목으로 시작, 합집합 확대는 보류) ----
export const FWD_MIN_TOP_N = 30;
export const FWD_MIN_FROM = "2025-11-17";

// ---- 호출 시간대·한도 ----
/** 호출 금지 시간대(UTC 분): 14:00~15:40 KST = 05:00~06:40 UTC(한국 스크리닝 14:30 포함), 03:50~06:20 KST = 18:50~21:20 UTC(미국 스크리닝 04:00/05:00 KST 여유). */
export const FWD_BLOCK_WINDOWS_UTC_MIN: readonly (readonly [number, number])[] = [[5 * 60, 6 * 60 + 40], [18 * 60 + 50, 21 * 60 + 20]];
export const FWD_RUN_MAX_MS = 4.75 * 3600e3;
export const FWD_CHECKPOINT_MS = 20 * 60e3;
/** 분봉은 체크포인트마다 30종목 월 파일을 다시 올리므로 간격을 길게 한다. */
export const FWD_MIN_CHECKPOINT_MS = 60 * 60e3;
export const FWD_RL_WAITS_MS = [5_000, 15_000, 60_000] as const;
export const FWD_RL_WINDOW_MS = 10 * 60e3;
export const FWD_RL_WINDOW_MAX = 5;
export const FWD_CONSEC_ERROR_STOP = 20;
export const FWD_ERROR_RETRY_MS = 2_000;
export const FWD_LOG_EVERY_REQ = 200;
/** 호출 간 최소 간격(ms): 지연(중앙값 약 0.5초)을 더해 초당 1.3건 안팎 — 가정 검증 실측(순차 1.11초/호출, rate limit 0회) 뒤 정함. 앱키 공용 한도(초당 15)에 크게 못 미친다. */
export const FWD_MIN_GAP_MS = 250;

// ---- Storage 가드 ----
export const FWD_STORAGE_CAP_BYTES = 800 * 1048576;
export const FWD_FRGN_WRITE_BUDGET_BYTES = 5 * 1048576;
export const FWD_MIN_WRITE_BUDGET_BYTES = 50 * 1048576;
/** 한 실행의 누적 업로드가 쓰기 예산 × 이 배수를 넘으면 멈춘다(체크포인트 재업로드 포함). */
export const FWD_WRITE_GUARD_FACTOR = 3;
/** 총량이 상한에서 이 만큼 안쪽에 있으면 시작하지 않는다. */
export const FWD_STORAGE_HEADROOM_BYTES = 20 * 1048576;

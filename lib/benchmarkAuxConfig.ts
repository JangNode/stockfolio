// 연구 LC 0단계: 069500 원주가 보조 파일 기준값. 사용자 지정 2026-10-27. 사전등록: docs/research/combined-protection-prereg.md
/** 보조 파일의 마지막 날짜 = 고정 스냅샷 데이터 종료일. */
export const BENCH_AUX_END = "2026-10-26";
/** 보조 파일 경로(Actions 캐시로 보존; 저장소에 커밋하지 않는다). */
export const BENCH_AUX_FILE = ".research-aux/benchmark-069500-raw-close-20261026.json";
/** Actions 캐시 키(한 번 만들면 바꾸지 않는다). */
export const BENCH_AUX_CACHE_KEY = "research-aux-069500-20261026";
/** KRX 요청 상한(빠진 거래일 수가 이보다 많으면 중단)과 요청 간격(ms). */
export const BENCH_AUX_KRX_CAP = 12;
export const BENCH_AUX_KRX_GAP_MS = 300;
/** 두 표(etf_krx_daily·etf_daily_prices)가 같은 종가를 갖는지 확인하는 최근 겹침 일수. */
export const BENCH_AUX_OVERLAP_DAYS = 60;
/** KRX 호출 금지 시간대(KST, 자정 기준 분): 14:00 이상 15:40 미만. */
export const BENCH_AUX_BLOCK_FROM_KST_MIN = 14 * 60;
export const BENCH_AUX_BLOCK_TO_KST_MIN = 15 * 60 + 40;

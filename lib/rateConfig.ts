/** 미국 기준금리(FOMC)/한국 기준금리(금통위) 수집에 쓰는 소스 상수. 값 자체를 바꿔
 * 재수집하고 싶을 때 여기만 고치면 된다. */

// FRED(fred.stlouisfed.org) v1 series/observations. v2(릴리스 단위 벌크)는 이 정도
// 소수 시리즈만 필요한 경우엔 과해서 v1을 쓴다.
export const FRED_US_UPPER_SERIES_ID = "DFEDTARU"; // 연방기금 목표금리 상단
export const FRED_US_LOWER_SERIES_ID = "DFEDTARL"; // 연방기금 목표금리 하단
// 2008-12-16부터 연준이 "목표 범위"(상단/하단) 체계를 쓰기 시작했다 — 그 이전은 단일
// 목표금리(DFEDTAR, 이 앱에서는 다루지 않음) 체계였다.
export const FRED_US_SERIES_START_DATE = "2008-12-16";

// 한국은행 ECOS(ecos.bok.or.kr) StatisticSearch. 722Y001="한국은행 기준금리 및
// 여수신금리" 통계표, 0101000=그 안의 "한국은행 기준금리" 통계항목(실제 응답의
// ITEM_NAME1으로 확인). 처음에 902Y006(실제로는 "주요국 정책금리" 국제 비교표라
// 한국 전용 상세 이력이 없음)으로 잘못 짚었던 걸 실데이터 검증 중 바로잡았다.
export const ECOS_KR_BASE_RATE_STAT_CODE = "722Y001";
export const ECOS_KR_BASE_RATE_ITEM_CODE = "0101000";
export const ECOS_KR_BASE_RATE_START_DATE = "19990101"; // ECOS 날짜 형식(YYYYMMDD)

// FOMC/금통위 발표 감지 재시도 오프셋(분). scripts/check-rate-announcement.ts가
// 이 간격만큼 sleep하며 최대 이 횟수만큼 확인한다.
export const RATE_CHECK_BACKOFF_OFFSETS_MIN = [0, 5, 15, 30, 60, 120] as const;

// FOMC 성명 발표 시각(미 동부시간 고정). supabase/migrations의 발표 감지 pg_cron
// 잡(EDT/EST 두 스케줄을 매 회의마다 등록)이 이미 이 시각을 UTC로 환산해 쓰고
// 있다 — "다가오는 일정" 화면에서 같은 값을 재사용해 ET/KST를 함께 보여준다.
export const FOMC_ANNOUNCEMENT_ET_HOUR = 14;
export const FOMC_ANNOUNCEMENT_ET_MINUTE = 0;

// 금통위 결과 발표 시각(한국시간 고정). 같은 pg_cron 잡의 UTC 00:00 = KST 09:00
// 환산에서 확인된 값이다. 국내 일정이라 KST 라벨은 안 붙이지만, 화면에 시각을
// 같이 보여줄 때 이 상수를 쓴다.
export const MPC_ANNOUNCEMENT_KST_HOUR = 9;
export const MPC_ANNOUNCEMENT_KST_MINUTE = 0;

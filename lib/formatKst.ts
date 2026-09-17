/**
 * 화면에 날짜/시각을 표시할 때 항상 한국시간(KST) 기준으로 보이게 하는 공용
 * 포맷터. 날짜만 다루는 함수들(toKstDateString 등)은 이 파일이 생기기 전부터
 * 이미 여러 컴포넌트에서 timeZone: "Asia/Seoul"을 명시해왔지만, 시:분까지
 * 보여주는 포맷 함수 일부는 timeZone을 빠뜨려 뷰어의 브라우저 로컬 시간대에
 * 기대고 있었다(2026-09-17 발견) — 이 파일로 모아서 항상 KST가 고정되게 한다.
 * 여기 있는 모든 함수는 timeZone을 options로 덮어쓸 수 없게 마지막에 고정한다.
 */

const KST_TIME_ZONE = "Asia/Seoul";

/** 오늘(KST) 날짜(YYYY-MM-DD). */
export function todayKstDateString(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: KST_TIME_ZONE });
}

/** ISO 타임스탬프를 KST 기준 날짜(YYYY-MM-DD)로 변환한다 — 날짜별로 묶거나
 * date input의 value/min/max로 쓸 때처럼 비교 가능한 키가 필요할 때 쓴다. */
export function toKstDateString(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: KST_TIME_ZONE });
}

/** ISO 타임스탬프를 KST 기준으로 날짜만 표시용 포맷팅한다(연/월/일, 요일 등은
 * options로 조정 — timeZone만 항상 KST로 고정된다). */
export function formatKstDate(iso: string, options: Intl.DateTimeFormatOptions = {}): string {
  return new Date(iso).toLocaleDateString("ko-KR", { ...options, timeZone: KST_TIME_ZONE });
}

/** ISO 타임스탬프를 KST 기준으로 시:분(24시간제) 표시용 포맷팅한다. */
export function formatKstTime(iso: string, options: Intl.DateTimeFormatOptions = {}): string {
  return new Date(iso).toLocaleTimeString("ko-KR", { hour12: false, ...options, timeZone: KST_TIME_ZONE });
}

/** ISO 타임스탬프를 KST 기준 날짜+시각으로 함께 표시용 포맷팅한다. */
export function formatKstDateTime(iso: string, options: Intl.DateTimeFormatOptions = {}): string {
  return new Date(iso).toLocaleString("ko-KR", { ...options, timeZone: KST_TIME_ZONE });
}

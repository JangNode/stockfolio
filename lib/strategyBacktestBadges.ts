/**
 * "장기 백테스트" 카드 배지 판정(사전 고정 규칙만 — 기준값은 strategyBacktestSummaryConfig.ts).
 * 화면 컴포넌트와 분리해 단위 테스트할 수 있게 순수 함수로 둔다.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_YEAR = 365.25;

/** 비용 반영 CAGR을 벤치마크 CAGR과 비교한다. 비교할 값이 없으면 null(배지 없음). */
export function benchmarkVerdict(
  strategyCagrPct: number | null,
  benchmarkCagrPct: number | null
): "ahead" | "behind" | null {
  if (strategyCagrPct === null || benchmarkCagrPct === null) return null;
  return strategyCagrPct >= benchmarkCagrPct ? "ahead" : "behind";
}

/** 백테스트 기간 연수(YYYY-MM-DD 두 날짜 사이). */
export function periodYears(periodStartDate: string, periodEndDate: string): number {
  return (Date.parse(periodEndDate) - Date.parse(periodStartDate)) / MS_PER_DAY / DAYS_PER_YEAR;
}

/** 총 거래 수가 (연간 최소 거래 수 × 기간 연수)보다 적으면 "표본 적음". */
export function isLowSampleSize(
  totalTrades: number,
  periodStartDate: string,
  periodEndDate: string,
  minTradesPerYear: number
): boolean {
  return totalTrades < minTradesPerYear * periodYears(periodStartDate, periodEndDate);
}

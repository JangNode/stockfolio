/**
 * screening_results 행 목록에서 승률/평균·중앙값 수익률 등 요약 통계를 계산하는 순수
 * 함수. reversal_breakout(v1) vs reversal_breakout_v2 비교 대시보드(components/Screening.tsx)가
 * 쓴다 — status/return_pct는 lib/backtest.ts의 TrackingStatus와 scripts/screen-all-stocks.ts의
 * evaluateTrackingStatus가 만드는 값과 동일하다.
 */
export interface ScreeningResultStatRow {
  status: "active" | "stopped" | "profited";
  returnPct: number | null;
  matchedAt: string;
}

export interface ScreeningResultStats {
  total: number;
  activeCount: number;
  closedCount: number;
  /** closed(=status가 active가 아닌 것) 표본 기준 승률(0~1). closedCount===0이면 null. */
  winRate: number | null;
  avgReturnPct: number | null;
  medianReturnPct: number | null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** closed(=status가 active가 아닌 것)만 승률/평균/중앙값 계산 대상으로 삼는다 — active는
 * 아직 결과가 확정되지 않은 진행 중인 신호라 수익률이 통계적으로 의미가 없다. */
export function computeScreeningResultStats(rows: ScreeningResultStatRow[]): ScreeningResultStats {
  const total = rows.length;
  const activeCount = rows.filter((r) => r.status === "active").length;
  const closedRows = rows.filter((r) => r.status !== "active");
  const closedCount = closedRows.length;

  if (closedCount === 0) {
    return { total, activeCount, closedCount, winRate: null, avgReturnPct: null, medianReturnPct: null };
  }

  const closedReturns = closedRows
    .map((r) => r.returnPct)
    .filter((v): v is number => v !== null);

  const wins = closedRows.filter((r) => r.status === "profited").length;
  const winRate = wins / closedCount;
  const avgReturnPct =
    closedReturns.length > 0 ? closedReturns.reduce((a, b) => a + b, 0) / closedReturns.length : null;
  const medianReturnPct = closedReturns.length > 0 ? median(closedReturns) : null;

  return { total, activeCount, closedCount, winRate, avgReturnPct, medianReturnPct };
}

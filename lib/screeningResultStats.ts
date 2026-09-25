/**
 * screening_results 행 목록에서 승률/평균·중앙값 수익률 등 요약 통계를 계산하는 순수
 * 함수. "전략 관리" 탭(components/StrategyManager.tsx)의 급등주 v1 vs v2 비교 카드와
 * 전략 성과 비교 섹션이 쓴다 — status/return_pct는 lib/backtest.ts의 TrackingStatus와
 * scripts/screen-all-stocks.ts의 evaluateTrackingStatus가 만드는 값과 동일하다.
 */
export interface ScreeningResultStatRow {
  status: "active" | "stopped" | "profited" | "price_unavailable";
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

/** closed(=손절/익절로 결과가 확정된 것)만 승률/평균/중앙값 계산 대상으로 삼는다 —
 * active는 아직 결과가 확정되지 않은 진행 중인 신호라 수익률이 통계적으로 의미가
 * 없고, price_unavailable(시세 조회 연속 실패)은 "종료"가 아니라 "확인 불가"라
 * 손절/익절과 섞으면 승률·평균수익률이 멈춘 가격 때문에 왜곡된다(2026-09-20 확인
 * — active를 기준으로 "그 외 전부"를 closed로 묶던 이전 판정 방식의 허점). */
export function computeScreeningResultStats(rows: ScreeningResultStatRow[]): ScreeningResultStats {
  const total = rows.length;
  const activeCount = rows.filter((r) => r.status === "active").length;
  const closedRows = rows.filter((r) => r.status === "stopped" || r.status === "profited");
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

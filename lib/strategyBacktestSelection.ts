import {
  STRATEGY_BACKTEST_BENCHMARK_CARDS,
  STRATEGY_BACKTEST_DATA_WIDEN_STAGE_FALLBACK,
} from "@/lib/strategyBacktestSummaryConfig";

/**
 * app/api/strategies/backtest-summary가 쓰는 "화면에 보여줄 행" 선택 로직. 라우트와 검증 스크립트가
 * 같은 함수를 쓰게 순수 함수로 분리했다. 입력은 computed_at 내림차순 정렬된 행이어야 한다.
 */

interface StageRow {
  data_widen_stage: string | null;
}

// 지정 stage 행인지. 'narrow'를 가리킬 땐 stage가 비어 있는 기존 행도 포함한다.
function isStage(rowStage: string | null, stage: string): boolean {
  return rowStage === stage || (stage === STRATEGY_BACKTEST_DATA_WIDEN_STAGE_FALLBACK && !rowStage);
}

/** 지정 stage의 행만 남기고 rule_type+market 조합별 최신 행 하나씩 고른다(없는 조합은 빠진다). */
export function selectLatestSummaries<T extends StageRow & { rule_type: string; market: string }>(
  rows: T[],
  stage: string
): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    if (!isStage(row.data_widen_stage, stage)) continue;
    const key = `${row.rule_type}:${row.market}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  return Array.from(latest.values());
}

/** 지정 stage의 벤치마크 카드 대상 종류별 최신 행 하나씩. */
export function selectLatestBenchmarks<T extends StageRow & { benchmark_type: string }>(
  rows: T[],
  stage: string
): T[] {
  const shown = new Set<string>(STRATEGY_BACKTEST_BENCHMARK_CARDS.map((card) => card.type));
  const latest = new Map<string, T>();
  for (const row of rows) {
    if (!isStage(row.data_widen_stage, stage) || !shown.has(row.benchmark_type)) continue;
    if (!latest.has(row.benchmark_type)) latest.set(row.benchmark_type, row);
  }
  return Array.from(latest.values());
}

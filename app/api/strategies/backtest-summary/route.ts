import { NextResponse } from "next/server";
import { requireApproved } from "@/lib/requireApproved";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  STRATEGY_BACKTEST_DATA_WIDEN_STAGE_DEFAULT,
  STRATEGY_BACKTEST_DATA_WIDEN_STAGE_FALLBACK,
} from "@/lib/strategyBacktestSummaryConfig";

interface StrategyBacktestSummaryRow {
  id: string;
  rule_type: string;
  market: "KR" | "US";
  period_start_date: string;
  period_end_date: string;
  computed_at: string;
  universe_stock_count: number;
  win_rate: number | null;
  avg_return_pct: number | null;
  median_return_pct: number | null;
  mdd_pct: number | null;
  cagr_pct: number | null;
  total_trades: number;
  closed_trades: number;
  forced_liquidation_count: number;
  forced_liquidation_ratio: number | null;
  top5_exclude_return_pct: number | null;
  avg_win_pct: number | null;
  avg_loss_pct: number | null;
  payoff_ratio: number | null;
  cost_included: boolean;
  data_widen_stage: string | null;
}

/**
 * "전략 관리" 탭의 "장기 백테스트(2016~오늘)" 섹션이 읽는 캐시 조회 라우트.
 * scripts/compute-strategy-backtest-summary.ts가 매주 쌓아둔 이력(rule_type+market
 * 조합별로 여러 computed_at 행)에서, 각 조합의 가장 최신 행만 골라 내려준다 —
 * 행이 최대 5개뿐이라 SQL 윈도우 함수 없이 앱 코드에서 그룹핑한다(과잉설계 방지).
 */
export async function GET(request: Request) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  const { data, error } = await supabaseAdmin
    .from("strategy_backtest_summary")
    .select("*")
    .order("computed_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }

  // 재백필 도중 계산된 중간 상태 행(partial_*)은 숨긴다 — 'full' 행이 있으면 그중 최신,
  // 없으면 재백필 전 'narrow' 행(data_widen_stage가 비어 있는 기존 행 포함) 중 최신을 쓴다.
  const rows = (data ?? []) as StrategyBacktestSummaryRow[];
  const latestFull = new Map<string, StrategyBacktestSummaryRow>();
  const latestNarrow = new Map<string, StrategyBacktestSummaryRow>();
  for (const row of rows) {
    const key = `${row.rule_type}:${row.market}`;
    if (row.data_widen_stage === STRATEGY_BACKTEST_DATA_WIDEN_STAGE_DEFAULT) {
      if (!latestFull.has(key)) latestFull.set(key, row);
    } else if (!row.data_widen_stage || row.data_widen_stage === STRATEGY_BACKTEST_DATA_WIDEN_STAGE_FALLBACK) {
      if (!latestNarrow.has(key)) latestNarrow.set(key, row);
    }
  }
  const latestByKey = new Map(latestNarrow);
  for (const [key, row] of latestFull) latestByKey.set(key, row);

  return NextResponse.json({ summaries: Array.from(latestByKey.values()) });
}

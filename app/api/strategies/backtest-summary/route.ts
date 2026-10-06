import { NextResponse } from "next/server";
import { requireApproved } from "@/lib/requireApproved";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { STRATEGY_BACKTEST_DISPLAY_STAGE } from "@/lib/strategyBacktestSummaryConfig";
import { selectLatestBenchmarks, selectLatestSummaries } from "@/lib/strategyBacktestSelection";

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

interface BenchmarkSummaryRow {
  benchmark_type: string;
  period_start_date: string;
  period_end_date: string;
  computed_at: string;
  cagr_pct: number | null;
  mdd_pct: number | null;
  cost_included: boolean;
  data_widen_stage: string | null;
}

/**
 * "전략 관리" 탭의 "장기 백테스트(2016~오늘)" 섹션이 읽는 캐시 조회 라우트.
 * scripts/compute-strategy-backtest-summary.ts가 매주 쌓아둔 이력(rule_type+market
 * 조합별로 여러 computed_at 행)에서, 각 조합의 가장 최신 행만 골라 내려준다 —
 * 행이 최대 5개뿐이라 SQL 윈도우 함수 없이 앱 코드에서 그룹핑한다(과잉설계 방지).
 * 벤치마크(benchmark_summary)도 같은 stage에서 종류별 최신 행을 함께 내려준다.
 */
export async function GET(request: Request) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  const [summaryResult, benchmarkResult] = await Promise.all([
    supabaseAdmin.from("strategy_backtest_summary").select("*").order("computed_at", { ascending: false }),
    supabaseAdmin
      .from("benchmark_summary")
      .select("benchmark_type, period_start_date, period_end_date, computed_at, cagr_pct, mdd_pct, cost_included, data_widen_stage")
      .order("computed_at", { ascending: false }),
  ]);

  if (summaryResult.error) {
    return NextResponse.json({ error: summaryResult.error.message }, { status: 502 });
  }
  if (benchmarkResult.error) {
    return NextResponse.json({ error: benchmarkResult.error.message }, { status: 502 });
  }

  // 화면 기본 stage(STRATEGY_BACKTEST_DISPLAY_STAGE) 행만 노출하고 그 안에서 조합별 최신 행을 쓴다.
  // 그 stage에 행이 없는 전략은 응답에서 빠지고, 화면이 "재정비 중"으로 표시한다(다른 stage로
  // 대체하지 않는다). 다른 stage 행은 이력으로 DB에 그대로 남는다.
  return NextResponse.json({
    summaries: selectLatestSummaries((summaryResult.data ?? []) as StrategyBacktestSummaryRow[], STRATEGY_BACKTEST_DISPLAY_STAGE),
    benchmarks: selectLatestBenchmarks((benchmarkResult.data ?? []) as BenchmarkSummaryRow[], STRATEGY_BACKTEST_DISPLAY_STAGE),
  });
}

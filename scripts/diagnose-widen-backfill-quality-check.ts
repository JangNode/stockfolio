// 임시 읽기 전용 검증(전략 정리 PR): 화면 API가 읽는 행과 DB 값, 종료 전략 행 보존 여부를 출력한다.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { STRATEGY_BACKTEST_DISPLAY_STAGE, STRATEGY_BACKTEST_ENDED_STRATEGIES } from "@/lib/strategyBacktestSummaryConfig";
import { selectLatestSummaries } from "@/lib/strategyBacktestSelection";

async function main() {
  const { data, error } = await supabaseAdmin
    .from("strategy_backtest_summary")
    .select("*")
    .order("computed_at", { ascending: false });
  if (error) throw new Error(error.message);
  const rows = data as Array<Record<string, unknown> & { rule_type: string; market: string; data_widen_stage: string | null }>;
  const shown = selectLatestSummaries(rows, STRATEGY_BACKTEST_DISPLAY_STAGE);
  console.log("== 화면 API가 내려주는 행 (stage=" + STRATEGY_BACKTEST_DISPLAY_STAGE + ") ==");
  for (const r of shown) {
    console.log(
      JSON.stringify({
        rule_type: r.rule_type, market: r.market, period: `${r.period_start_date}~${r.period_end_date}`, computed_at: r.computed_at,
        win_rate: r.win_rate, avg: r.avg_return_pct, median: r.median_return_pct, payoff: r.payoff_ratio,
        mdd: r.mdd_pct, cagr: r.cagr_pct, trades: r.total_trades, closed: r.closed_trades,
      })
    );
  }
  const ended = STRATEGY_BACKTEST_ENDED_STRATEGIES.map((e) => e.ruleType);
  console.log("종료 전략 표시 대상:", ended.join(", "), "→ 행 있음:", ended.map((t) => shown.some((r) => r.rule_type === t && r.market === "KR")));

  const { data: strat } = await supabaseAdmin.from("strategies").select("rule_type");
  const counts: Record<string, number> = {};
  for (const s of strat ?? []) counts[s.rule_type] = (counts[s.rule_type] ?? 0) + 1;
  console.log("strategies 행(보존 확인):", JSON.stringify(counts));
  const { data: ports } = await supabaseAdmin.from("paper_portfolios").select("style, market");
  const pc: Record<string, number> = {};
  for (const p of ports ?? []) pc[`${p.style}:${p.market}`] = (pc[`${p.style}:${p.market}`] ?? 0) + 1;
  console.log("paper_portfolios 행(보존 확인):", JSON.stringify(pc));
}
main().catch((e) => { console.error(e); process.exit(1); });

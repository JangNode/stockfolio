/** [임시 조사 — 병합 금지, 읽기 전용] 장기 백테스트 요약/벤치마크 최신 행 비교. */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { selectLatestBenchmarks, selectLatestSummaries } from "@/lib/strategyBacktestSelection";
import { STRATEGY_BACKTEST_DISPLAY_STAGE, STRATEGY_BACKTEST_EXTENDED_STAGE } from "@/lib/strategyBacktestSummaryConfig";

interface S { rule_type: string; market: string; period_start_date: string; period_end_date: string; computed_at: string; cagr_pct: number | null; mdd_pct: number | null; total_trades: number; win_rate: number | null; payoff_ratio: number | null; data_widen_stage: string | null; universe_stock_count: number }
interface B { benchmark_type: string; period_start_date: string; computed_at: string; cagr_pct: number | null; mdd_pct: number | null; data_widen_stage: string | null }

async function main(): Promise<void> {
  const { data: s } = await supabaseAdmin.from("strategy_backtest_summary").select("*").order("computed_at", { ascending: false });
  const { data: b } = await supabaseAdmin.from("benchmark_summary").select("*").order("computed_at", { ascending: false });
  const sums = (s ?? []) as S[];
  const bens = (b ?? []) as B[];
  const f = (v: number | null, d = 1): string => (v === null ? "-" : v.toFixed(d));
  for (const stage of [STRATEGY_BACKTEST_DISPLAY_STAGE, STRATEGY_BACKTEST_EXTENDED_STAGE]) {
    console.log(`=== stage ${stage} ===`);
    const rows = sums.filter((r) => r.data_widen_stage === stage);
    for (const rt of ["ma_cross", "peg_lynch", "reversal_breakout_v2", "minervini_trend_template", "reversal_breakout"]) {
      const list = rows.filter((r) => r.rule_type === rt).slice(0, 2);
      for (const [i, r] of list.entries()) {
        console.log(`  ${rt} ${i === 0 ? "최신" : "직전"} ${r.computed_at.slice(0, 16)} ${r.period_start_date}~${r.period_end_date} | CAGR ${f(r.cagr_pct)} MDD ${f(r.mdd_pct)} 거래 ${r.total_trades} 승률 ${f(r.win_rate === null ? null : r.win_rate * 100)} 손익비 ${f(r.payoff_ratio, 2)} 유니버스 ${r.universe_stock_count}`);
      }
    }
    const brows = bens.filter((r) => r.data_widen_stage === stage);
    for (const t of ["universe_monthly_rebalance", "kospi", "kosdaq"]) {
      const list = brows.filter((r) => r.benchmark_type === t).slice(0, 2);
      for (const [i, r] of list.entries()) console.log(`  [벤치] ${t} ${i === 0 ? "최신" : "직전"} ${r.computed_at.slice(0, 16)} ${r.period_start_date} | CAGR ${f(r.cagr_pct)} MDD ${f(r.mdd_pct)}`);
      if (list.length === 0) console.log(`  [벤치] ${t}: 행 없음`);
    }
  }
  const api = {
    summaries: selectLatestSummaries(sums, STRATEGY_BACKTEST_DISPLAY_STAGE).map((r) => `${r.rule_type}:${r.cagr_pct?.toFixed(1)}`),
    benchmarks: selectLatestBenchmarks(bens, STRATEGY_BACKTEST_DISPLAY_STAGE).map((r) => `${r.benchmark_type}:${r.cagr_pct?.toFixed(1)}`),
    extendedSummaries: selectLatestSummaries(sums, STRATEGY_BACKTEST_EXTENDED_STAGE).map((r) => `${r.rule_type}:${r.cagr_pct?.toFixed(1)}`),
    extendedBenchmarks: selectLatestBenchmarks(bens, STRATEGY_BACKTEST_EXTENDED_STAGE).map((r) => `${r.benchmark_type}:${r.cagr_pct?.toFixed(1)}`),
  };
  console.log(`API 응답 시뮬레이션: ${JSON.stringify(api)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

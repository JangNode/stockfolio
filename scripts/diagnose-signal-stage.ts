/** [임시 조사 — 병합 금지, 읽기 전용] #456 병합 후 수동 실행 결과 확인. */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

interface S { rule_type: string; period_start_date: string; period_end_date: string; computed_at: string; cagr_pct: number | null; mdd_pct: number | null; total_trades: number; win_rate: number | null; payoff_ratio: number | null; data_widen_stage: string | null; universe_stock_count: number }
interface B { benchmark_type: string; period_start_date: string; computed_at: string; cagr_pct: number | null; mdd_pct: number | null; data_widen_stage: string | null }
const f = (v: number | null, d = 1): string => (v === null ? "-" : v.toFixed(d));

async function main(): Promise<void> {
  const { data: s } = await supabaseAdmin.from("strategy_backtest_summary").select("*").order("computed_at", { ascending: false });
  const { data: b } = await supabaseAdmin.from("benchmark_summary").select("*").order("computed_at", { ascending: false });
  const sums = (s ?? []) as S[];
  const bens = (b ?? []) as B[];
  for (const stage of ["pit_adjusted_cap5000_from2010", "pit_adjusted_cap5000_from_signal", "pit_adjusted_cap5000"]) {
    console.log(`=== stage ${stage} ===`);
    const rows = sums.filter((r) => r.data_widen_stage === stage);
    for (const rt of [...new Set(rows.map((r) => r.rule_type))]) {
      for (const [i, r] of rows.filter((x) => x.rule_type === rt).slice(0, 2).entries())
        console.log(`  ${rt} ${i === 0 ? "최신" : "직전"} ${r.computed_at.slice(0, 16)} ${r.period_start_date}~${r.period_end_date} | CAGR ${f(r.cagr_pct, 2)} MDD ${f(r.mdd_pct, 2)} 거래 ${r.total_trades} 승률 ${f(r.win_rate === null ? null : r.win_rate * 100)} 손익비 ${f(r.payoff_ratio, 2)} 유니버스 ${r.universe_stock_count}`);
    }
    const brows = bens.filter((r) => r.data_widen_stage === stage);
    for (const t of ["universe_monthly_rebalance", "kospi", "kosdaq"]) {
      for (const [i, r] of brows.filter((x) => x.benchmark_type === t).slice(0, 2).entries())
        console.log(`  [벤치] ${t} ${i === 0 ? "최신" : "직전"} ${r.computed_at.slice(0, 16)} ${r.period_start_date} | CAGR ${f(r.cagr_pct, 2)} MDD ${f(r.mdd_pct, 2)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

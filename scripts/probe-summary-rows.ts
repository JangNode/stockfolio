/** [임시 측정 — 병합 금지, 읽기 전용] 배치 후 strategy_backtest_summary / benchmark_summary 단계별 최신·직전 행 대조 + 카드 API 선택 로직 시뮬레이션. */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { selectLatestBenchmarks, selectLatestSummaries } from "@/lib/strategyBacktestSelection";
import { STRATEGY_BACKTEST_DISPLAY_STAGE, STRATEGY_BACKTEST_EXTENDED_STAGE, STRATEGY_BACKTEST_SIGNAL_START_STAGE } from "@/lib/strategyBacktestSummaryConfig";

interface S { rule_type: string; period_start_date: string; period_end_date: string; computed_at: string; cagr_pct: number | null; mdd_pct: number | null; total_trades: number; win_rate: number | null; payoff_ratio: number | null; data_widen_stage: string | null }
interface B { benchmark_type: string; period_start_date: string; computed_at: string; cagr_pct: number | null; mdd_pct: number | null; data_widen_stage: string | null }
const f = (v: number | null, d = 2): string => (v === null ? "-" : v.toFixed(d));

async function main(): Promise<void> {
  const { data: s } = await supabaseAdmin.from("strategy_backtest_summary").select("*").order("computed_at", { ascending: false });
  const { data: b } = await supabaseAdmin.from("benchmark_summary").select("*").order("computed_at", { ascending: false });
  const sums = (s ?? []) as S[];
  const bens = (b ?? []) as B[];
  const stages = [...new Set([...sums, ...bens].map((r) => r.data_widen_stage ?? "(null)"))].sort();
  for (const stage of stages) {
    console.log(`=== stage ${stage} ===`);
    const rows = sums.filter((r) => (r.data_widen_stage ?? "(null)") === stage);
    for (const rt of [...new Set(rows.map((r) => r.rule_type))].sort()) {
      for (const [i, r] of rows.filter((x) => x.rule_type === rt).slice(0, 2).entries())
        console.log(`  ${rt} ${i === 0 ? "최신" : "직전"} ${r.computed_at.slice(0, 16)} ${r.period_start_date}~${r.period_end_date} | CAGR ${f(r.cagr_pct)} MDD ${f(r.mdd_pct)} 거래 ${r.total_trades} 승률 ${f(r.win_rate === null ? null : r.win_rate * 100, 1)} 손익비 ${f(r.payoff_ratio)}`);
    }
    const brows = bens.filter((r) => (r.data_widen_stage ?? "(null)") === stage);
    for (const t of [...new Set(brows.map((r) => r.benchmark_type))].sort()) {
      for (const [i, r] of brows.filter((x) => x.benchmark_type === t).slice(0, 2).entries())
        console.log(`  [벤치] ${t} ${i === 0 ? "최신" : "직전"} ${r.computed_at.slice(0, 16)} ${r.period_start_date} | CAGR ${f(r.cagr_pct)} MDD ${f(r.mdd_pct)}`);
    }
  }
  // 카드 API(app/api/strategies/backtest-summary/route.ts)가 쓰는 선택 함수로 응답 수치 시뮬레이션(프로덕션 URL 호출은 인증 필요 여부 확인 불가 시 대체)
  const pick = (stage: string): string => JSON.stringify({
    summaries: selectLatestSummaries(sums, stage).map((r) => `${r.rule_type}:${f(r.cagr_pct, 1)}/${f(r.mdd_pct, 1)}/${r.total_trades}`),
    benchmarks: selectLatestBenchmarks(bens, stage).map((r) => `${r.benchmark_type}:${f(r.cagr_pct, 2)}/${f(r.mdd_pct, 1)}`),
  });
  console.log(`API 선택 로직 시뮬레이션 — 표시 stage(${STRATEGY_BACKTEST_DISPLAY_STAGE}): ${pick(STRATEGY_BACKTEST_DISPLAY_STAGE)}`);
  console.log(`API 선택 로직 시뮬레이션 — 확장 stage(${STRATEGY_BACKTEST_EXTENDED_STAGE}): ${pick(STRATEGY_BACKTEST_EXTENDED_STAGE)}`);
  console.log(`API 선택 로직 시뮬레이션 — 신호 기간 stage(${STRATEGY_BACKTEST_SIGNAL_START_STAGE}): ${pick(STRATEGY_BACKTEST_SIGNAL_START_STAGE)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

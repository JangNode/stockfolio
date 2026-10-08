/** [임시 조사 — 병합 금지, 읽기 전용] peg_lynch 카드 변동 원인 조사. */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAllRows } from "@/lib/supabasePagination";

async function main(): Promise<void> {
  const { data: s } = await supabaseAdmin.from("strategy_backtest_summary").select("*").eq("rule_type", "peg_lynch").order("computed_at", { ascending: false });
  console.log("=== peg_lynch 요약 행 이력(최신순) ===");
  for (const r of (s ?? []) as Record<string, unknown>[]) {
    console.log(`${String(r.computed_at).slice(0, 16)} stage=${r.data_widen_stage} ${r.period_start_date}~${r.period_end_date} 비용=${r.cost_included} | CAGR ${Number(r.cagr_pct).toFixed(1)} MDD ${Number(r.mdd_pct).toFixed(1)} 거래 ${r.total_trades} 유니버스 ${r.universe_stock_count}`);
  }
  const { data: one } = await supabaseAdmin.from("stock_annual_fundamentals").select("*").limit(1);
  console.log(`stock_annual_fundamentals 컬럼: ${Object.keys((one ?? [])[0] ?? {}).join(",")}`);
  const rows = await fetchAllRows<Record<string, unknown>>((from, to) => supabaseAdmin.from("stock_annual_fundamentals").select("*").order("stock_code").order("fiscal_year").range(from, to));
  const byYear = new Map<number, { n: number; niNull: number; eqNull: number }>();
  for (const r of rows) {
    const y = Number(r.fiscal_year);
    const e = byYear.get(y) ?? { n: 0, niNull: 0, eqNull: 0 };
    e.n++;
    if (r.net_income_parent === null) e.niNull++;
    if (r.equity_parent === null) e.eqNull++;
    byYear.set(y, e);
  }
  console.log(`=== 재무 행 총 ${rows.length}, 사업연도별 (순이익 NULL / 자본 NULL) ===`);
  for (const [y, e] of [...byYear].sort((a, b) => a[0] - b[0])) console.log(`FY${y}: ${e.n}행, 순이익 NULL ${e.niNull} (${((e.niNull / e.n) * 100).toFixed(0)}%), 자본 NULL ${e.eqNull}`);
  const tsCols = Object.keys((one ?? [])[0] ?? {}).filter((k) => /created|updated|fetched|at$/.test(k));
  for (const c of tsCols) {
    const vals = rows.map((r) => String(r[c] ?? "")).filter(Boolean).sort();
    console.log(`  ${c}: 최소 ${vals[0]} 최대 ${vals[vals.length - 1]}`);
    const day = new Map<string, number>();
    for (const v of vals) day.set(v.slice(0, 10), (day.get(v.slice(0, 10)) ?? 0) + 1);
    console.log(`  ${c} 일자별(최근 10): ${[...day].sort().slice(-10).map(([d, n]) => `${d}:${n}`).join(" ")}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

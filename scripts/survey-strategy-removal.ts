/** 디스포저블 조사(읽기 전용, DB 쓰기 없음): 전략 정리 영향 범위. 끝나면 정리한다. */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function pageAll<T>(table: string, columns: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from(table).select(columns).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}
const inc = (m: Map<string, number>, k: string, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const dump = (title: string, m: Map<string, number>) => {
  console.log(`\n[${title}]`);
  for (const [k, v] of [...m.entries()].sort()) console.log(`  ${k}: ${v}`);
};

async function main(): Promise<void> {
  const strategies = await pageAll<{ id: string; user_id: string; rule_type: string; market: string }>("strategies", "id,user_id,rule_type,market");
  const ruleOf = new Map(strategies.map((s) => [s.id, s.rule_type]));
  const m1 = new Map<string, number>();
  const users = new Map<string, Set<string>>();
  for (const s of strategies) { inc(m1, `${s.rule_type}/${s.market}`); const k = `${s.rule_type}/${s.market}`; (users.get(k) ?? users.set(k, new Set()).get(k)!).add(s.user_id); }
  console.log(`전체 사용자 전략 행 ${strategies.length}개`);
  dump("strategies 행 수(rule_type/market)", m1);
  console.log("  (사용자 수) " + [...users.entries()].map(([k, v]) => `${k}=${v.size}`).join(", "));

  const sr = await pageAll<{ id: string; strategy_id: string; status: string; market: string; matched_at: string }>("screening_results", "id,strategy_id,status,market,matched_at");
  const m2 = new Map<string, number>();
  const m2b = new Map<string, number>();
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  for (const r of sr) {
    const rt = ruleOf.get(r.strategy_id) ?? "(전략 행 없음)";
    inc(m2, `${rt}/${r.market}/${r.status}`);
    if (r.matched_at >= cutoff) inc(m2b, `${rt}/${r.market}`);
  }
  console.log(`\nscreening_results 전체 ${sr.length}행`);
  dump("screening_results (rule_type/market/status)", m2);
  dump("screening_results 최근 30일 신규 신호(rule_type/market)", m2b);
  const srRule = new Map(sr.map((r) => [r.id, ruleOf.get(r.strategy_id) ?? "(없음)"]));

  const ps = await pageAll<{ style: string; version: number; is_active: boolean }>("paper_strategies", "style,version,is_active");
  const m3 = new Map<string, number>();
  for (const p of ps) inc(m3, `${p.style}${p.is_active ? "(활성)" : "(과거)"}`);
  dump("paper_strategies(스타일)", m3);

  const pf = await pageAll<{ id: string; style: string; market: string }>("paper_portfolios", "id,style,market");
  const pfOf = new Map(pf.map((p) => [p.id, `${p.style}/${p.market}`]));
  console.log(`\npaper_portfolios: ${pf.map((p) => `${p.style}/${p.market}`).sort().join(", ")}`);

  const pos = await pageAll<{ portfolio_id: string; screening_result_id: string | null }>("paper_positions", "portfolio_id,screening_result_id");
  const m4 = new Map<string, number>(), m4b = new Map<string, number>();
  for (const p of pos) { inc(m4, pfOf.get(p.portfolio_id) ?? "?"); inc(m4b, `${pfOf.get(p.portfolio_id)} ← 출처 ${p.screening_result_id ? srRule.get(p.screening_result_id) ?? "(없음)" : "(출처 없음)"}`); }
  dump("paper_positions(열린 포지션, 스타일/시장)", m4);
  dump("paper_positions 출처 rule_type", m4b);

  const tr = await pageAll<{ portfolio_id: string; side: string; screening_result_id: string | null }>("paper_trades", "portfolio_id,side,screening_result_id");
  const m5 = new Map<string, number>(), m5b = new Map<string, number>();
  for (const t of tr) { inc(m5, `${pfOf.get(t.portfolio_id)}/${t.side}`); inc(m5b, `${pfOf.get(t.portfolio_id)} ← 출처 ${t.screening_result_id ? srRule.get(t.screening_result_id) ?? "(없음)" : "(출처 없음)"}`); }
  dump("paper_trades(스타일/시장/방향)", m5);
  dump("paper_trades 출처 rule_type", m5b);

  const sn = await pageAll<{ portfolio_id: string }>("paper_daily_snapshots", "portfolio_id");
  const m6 = new Map<string, number>();
  for (const s of sn) inc(m6, pfOf.get(s.portfolio_id) ?? "?");
  dump("paper_daily_snapshots(스타일/시장)", m6);

  const cb = await pageAll<{ status: string; adopted_at: string | null }>("custom_backtest_runs", "status,adopted_at");
  const m7 = new Map<string, number>();
  for (const c of cb) inc(m7, `${c.status}${c.adopted_at ? "/채택" : ""}`);
  dump("custom_backtest_runs(실험실)", m7);

  const sb = await pageAll<{ rule_type: string; data_widen_stage: string | null; computed_at: string; period_end_date: string; cagr_pct: number | null; total_trades: number }>("strategy_backtest_summary", "rule_type,data_widen_stage,computed_at,period_end_date,cagr_pct,total_trades");
  const m8 = new Map<string, number>();
  for (const r of sb) inc(m8, `${r.rule_type}/${r.data_widen_stage}`);
  dump("strategy_backtest_summary(rule_type/stage 행 수)", m8);
  const latest = new Map<string, (typeof sb)[number]>();
  for (const r of sb.filter((x) => x.data_widen_stage === "pit_adjusted_cap5000").sort((a, b) => b.computed_at.localeCompare(a.computed_at))) if (!latest.has(r.rule_type)) latest.set(r.rule_type, r);
  console.log("\n[pit_adjusted_cap5000 최신 행]");
  for (const [k, r] of latest) console.log(`  ${k}: 기준일 ${r.period_end_date}, 계산 ${r.computed_at.slice(0, 10)}, CAGR ${r.cagr_pct?.toFixed(2)}, 거래 ${r.total_trades}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

// 임시 읽기 전용 점검(전략 정리 후 첫 KR 스크리닝). 쓰기 없음.
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function all(table: string, cols: string, filter?: (q: any) => any): Promise<R[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: R[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabaseAdmin.from(table).select(cols);
    if (filter) q = filter(q);
    const { data, error } = await q.range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as unknown as R[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}
const tally = (rows: R[], key: (r: R) => string) => { const m: Record<string, number> = {}; for (const r of rows) { const k = key(r); m[k] = (m[k] ?? 0) + 1; } return JSON.stringify(m); };
const RUN_START = "2026-10-07T05:30:00Z";

async function main() {
  const strategies = await all("strategies", "id, rule_type, market");
  const typeById = new Map(strategies.map((s) => [s.id as string, `${s.rule_type}`]));
  const { data: one } = await supabaseAdmin.from("screening_results").select("*").limit(1);
  console.log("screening_results 컬럼:", Object.keys((one ?? [])[0] ?? {}).join(","));

  const kr = await all("screening_results", "*", (q) => q.eq("market", "KR").in("status", ["active", "price_anomaly"]));
  console.log("KR active+price_anomaly 총", kr.length, "(추적 쿼리에 limit/페이지네이션 없음 → 1000건 상한 의심)");
  console.log("전략별 건수:", tally(kr, (r) => typeById.get(r.strategy_id) ?? "?"));
  const fresh = (r: R) => r.last_price_fetch_success_at && r.last_price_fetch_success_at >= RUN_START;
  console.log("오늘 실행에서 가격 갱신됨(last_price_fetch_success_at≥05:30Z):", tally(kr, (r) => `${typeById.get(r.strategy_id) ?? "?"}|${fresh(r) ? "갱신" : "미갱신"}`));
  const stale = kr.filter((r) => !fresh(r));
  const oldest = stale.map((r) => r.last_price_fetch_success_at ?? "null").sort()[0];
  console.log("미갱신 행 최소 last_price_fetch_success_at:", oldest, "| 미갱신 행의 matched_at 범위:", stale.map((r) => r.matched_at).sort()[0], "~", stale.map((r) => r.matched_at).sort().slice(-1)[0]);
  console.log("price_anomaly 행:", kr.filter((r) => r.status === "price_anomaly").length, "| 실패 누적>0:", kr.filter((r) => (r.price_fetch_failure_count ?? 0) > 0).length);

  const closedCols = Object.keys((one ?? [])[0] ?? {}).filter((k) => /closed|ended|exit|updated/.test(k));
  console.log("종료 시각 후보 컬럼:", closedCols.join(","));
  const today = await all("screening_results", "*", (q) => q.eq("market", "KR").in("status", ["stopped", "profited"]).gte(closedCols.includes("closed_at") ? "closed_at" : (closedCols[0] ?? "matched_at"), RUN_START));
  console.log("오늘 종료(stopped/profited) 처리:", tally(today, (r) => `${typeById.get(r.strategy_id) ?? "?"}|${r.status}`));

  console.log("== 모의투자 ==");
  const ports = await all("paper_portfolios", "id, style, market");
  const styleByPort = new Map(ports.map((p) => [p.id as string, `${p.style}:${p.market}`]));
  const sr = await all("screening_results", "id, strategy_id, status, stock_code, last_price_fetch_success_at, current_price, stop_loss_price, take_profit_price, entry_price");
  const srById = new Map(sr.map((r) => [r.id as string, r]));
  const pos = await all("paper_positions", "*");
  console.log("paper_positions(스타일|출처|출처 신호 상태|오늘 가격갱신):", tally(pos, (r) => { const s = r.screening_result_id ? srById.get(r.screening_result_id) : null; return `${styleByPort.get(r.portfolio_id)}|${s ? typeById.get(s.strategy_id) : "신호없음"}|${s ? s.status : "-"}|${s && fresh(s) ? "갱신" : "미갱신"}`; }));
  const allTrades = await all("paper_trades", "*");
  const keys = Object.keys(allTrades[0] ?? {});
  console.log("paper_trades 컬럼:", keys.join(","));
  const dateKey = keys.find((k) => /traded_at|executed_at|created_at|trade_date|date/.test(k)) ?? keys[0];
  const trades = allTrades.filter((t) => String(t[dateKey]) >= "2026-10-07").sort((x, y) => String(x[dateKey]).localeCompare(String(y[dateKey])));
  console.log("오늘 거래 건수:", trades.length, "(기준 컬럼", dateKey + ")");
  for (const t of trades) { const s = t.screening_result_id ? srById.get(t.screening_result_id) : null; console.log(" ", JSON.stringify({ 계좌: styleByPort.get(t.portfolio_id), 방향: t.side ?? t.action ?? t.trade_type, 종목: t.stock_name, 출처: s ? typeById.get(s.strategy_id) : "-", 신호상태: s?.status, 시각: t[dateKey] })); }
  const { data: act } = await supabaseAdmin.from("paper_strategies").select("style, version, is_active, created_at, entry_conditions").eq("is_active", true);
  for (const a of act ?? []) console.log("활성 전략", a.style, "v" + a.version, a.created_at, "source_rule_types =", JSON.stringify((a.entry_conditions as R)?.source_rule_types));
  const { data: sruns } = await supabaseAdmin.from("screening_runs").select("*").eq("market", "KR").order("finished_at", { ascending: false }).limit(3);
  console.log("최근 KR screening_runs:", JSON.stringify((sruns ?? []).map((r) => ({ 시작: r.started_at, 종료: r.finished_at, 스캔: r.scanned_count, 매칭: r.matched_count, 오류: r.error_count }))));
  const { data: pruns } = await supabaseAdmin.from("paper_runs").select("*").eq("market", "KR").order("finished_at", { ascending: false }).limit(2);
  console.log("최근 KR paper_runs:", JSON.stringify(pruns));
}
main().catch((e) => { console.error(e); process.exit(1); });

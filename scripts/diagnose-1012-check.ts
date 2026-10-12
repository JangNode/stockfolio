/** [임시 조사 — 병합 금지, 읽기 전용] 10/12 14:10 전략 재생성 / 14:30 스크리닝 점검. */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAllRows } from "@/lib/supabasePagination";

type SR = { id: string; strategy_id: string; stock_code: string; market: string; status: string; matched_at: string; signal_details: unknown; last_price_fetch_success_at: string | null };
const isV2 = (d: unknown): boolean => typeof d === "object" && d !== null && (d as { rule_version?: unknown }).rule_version === "v2";

async function main(): Promise<void> {
  const { data: ps } = await supabaseAdmin.from("paper_strategies").select("style, version, is_active, created_at, retired_at, entry_conditions, exit_conditions, rationale").in("style", ["conservative", "aggressive"]).order("version", { ascending: false }).limit(6);
  for (const r of ps ?? []) console.log(`PS ${r.style} v${r.version} 활성=${r.is_active} 생성 ${String(r.created_at).slice(0, 16)} 종료 ${r.retired_at ? String(r.retired_at).slice(0, 16) : "-"} entry=${JSON.stringify(r.entry_conditions)} exit=${JSON.stringify(r.exit_conditions)} 낡은값(-3.0%/7.7%) 포함=${/-3\.0%|7\.7%/.test(String(r.rationale))}`);

  const { data: strategies } = await supabaseAdmin.from("strategies").select("id, rule_type, name");
  const rt = new Map((strategies ?? []).map((s) => [s.id as string, s.rule_type as string]));
  const rows = await fetchAllRows<SR>((from, to) =>
    supabaseAdmin.from("screening_results").select("id, strategy_id, stock_code, market, status, matched_at, signal_details, last_price_fetch_success_at").order("id").range(from, to));
  const ma = rows.filter((r) => rt.get(r.strategy_id) === "ma_cross");
  const since = "2026-10-12T05:00:00Z";
  const maNew = ma.filter((r) => r.matched_at >= since);
  console.log(`MA 전체 ${ma.length} | v2 표식 ${ma.filter((r) => isV2(r.signal_details)).length} | 구 규칙 ${ma.filter((r) => !isV2(r.signal_details)).length}`);
  console.log(`MA 오늘(14:30 이후) 신규 ${maNew.length}건: ${JSON.stringify(maNew.map((r) => [r.stock_code, r.market, isV2(r.signal_details), r.status]))}`);
  const maV2 = ma.filter((r) => isV2(r.signal_details));
  console.log(`MA v2 행 전체(최근): ${JSON.stringify(maV2.map((r) => [r.stock_code, r.market, r.matched_at.slice(0, 16), r.status]))}`);
  const st = (a: SR[]): string => ["active", "stopped", "profited", "price_unavailable", "price_anomaly"].map((s) => `${s}=${a.filter((r) => r.status === s).length}`).join(" ");
  console.log(`MA 상태별: ${st(ma)} | KR만: ${st(ma.filter((r) => r.market === "KR"))}`);
  const legacyKrActive = ma.filter((r) => r.market === "KR" && r.status === "active" && !isV2(r.signal_details));
  console.log(`MA 구 규칙 KR 활성 ${legacyKrActive.length} (직전 조회 기준 109) | 구 규칙 활성 US ${ma.filter((r) => r.market === "US" && r.status === "active" && !isV2(r.signal_details)).length}`);
  const legacyAfter = ma.filter((r) => !isV2(r.signal_details) && r.matched_at >= "2026-10-08T06:00:00Z");
  console.log(`MA 구 규칙 행 중 #452 병합(10/8 06:03Z) 이후 생성 ${legacyAfter.length}: ${JSON.stringify(legacyAfter.map((r) => [r.stock_code, r.market, r.matched_at.slice(0, 16)]))}`);

  const active = rows.filter((r) => r.status === "active");
  const krActive = active.filter((r) => r.market === "KR");
  const keys = new Map<string, number>();
  for (const r of active) keys.set(`${r.strategy_id}:${r.stock_code}`, (keys.get(`${r.strategy_id}:${r.stock_code}`) ?? 0) + 1);
  const dup = [...keys.values()].filter((n) => n > 1).length;
  console.log(`활성 전체 ${active.length} (KR ${krActive.length}) | 중복 (전략,종목) 키 ${dup}`);
  const fetched = krActive.filter((r) => r.last_price_fetch_success_at && r.last_price_fetch_success_at >= since).length;
  console.log(`KR 활성 중 오늘 14:30 이후 가격 조회 성공 기록 ${fetched}/${krActive.length}; 미갱신 ${krActive.length - fetched}`);
  const stale = krActive.filter((r) => !(r.last_price_fetch_success_at && r.last_price_fetch_success_at >= since));
  const staleBy = new Map<string, number>();
  for (const r of stale) { const k = `${rt.get(r.strategy_id)}:${r.matched_at >= since ? "오늘신규" : "이전"}`; staleBy.set(k, (staleBy.get(k) ?? 0) + 1); }
  console.log(`  미갱신 내역: ${JSON.stringify(Object.fromEntries(staleBy))}`);
  const closedToday = rows.filter((r) => r.market === "KR" && ["stopped", "profited"].includes(r.status) && r.last_price_fetch_success_at && r.last_price_fetch_success_at >= since).length;
  console.log(`KR 오늘 14:30 이후 종결(stopped/profited, 조회기록 기준) ${closedToday}`);

  const { data: portfolios } = await supabaseAdmin.from("paper_portfolios").select("id, style, market");
  const styleOf = new Map((portfolios ?? []).map((p) => [p.id as string, `${p.style}:${p.market ?? "KR"}`]));
  const pos = await fetchAllRows<{ id: string; portfolio_id: string; stock_code: string; screening_result_id: string | null; opened_at: string }>((from, to) =>
    supabaseAdmin.from("paper_positions").select("id, portfolio_id, stock_code, screening_result_id, opened_at").order("id").range(from, to));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const maPos = pos.filter((p) => p.screening_result_id && rt.get(byId.get(p.screening_result_id)?.strategy_id ?? "") === "ma_cross");
  console.log(`열린 모의 포지션 ${pos.length} | ma_cross 출처 ${maPos.length}: ${JSON.stringify(maPos.map((p) => [styleOf.get(p.portfolio_id), p.stock_code, byId.get(p.screening_result_id as string)?.market, byId.get(p.screening_result_id as string)?.status, isV2(byId.get(p.screening_result_id as string)?.signal_details), p.opened_at.slice(0, 10)]))}`);

  const trades = await fetchAllRows<{ portfolio_id: string; strategy_id: string; stock_code: string; stock_name: string; side: string; price: number; realized_pnl: number | null; rationale: string; screening_result_id: string | null; traded_at: string }>((from, to) =>
    supabaseAdmin.from("paper_trades").select("portfolio_id, strategy_id, stock_code, stock_name, side, price, realized_pnl, rationale, screening_result_id, traded_at").gte("traded_at", "2026-10-08T00:00:00Z").order("traded_at").range(from, to));
  for (const t of trades.filter((x) => x.traded_at >= "2026-10-12T05:00:00Z")) {
    const sr = t.screening_result_id ? byId.get(t.screening_result_id) : undefined;
    console.log(`TRADE ${t.traded_at.slice(11, 16)} ${styleOf.get(t.portfolio_id)} ${t.side} ${t.stock_name}(${t.stock_code}) 규칙=${sr ? rt.get(sr.strategy_id) : "-"} v2=${sr ? isV2(sr.signal_details) : "-"} pnl=${t.realized_pnl} | ${t.rationale.slice(0, 80)}`);
  }
  const maTradesNew = trades.filter((t) => t.side === "buy" && t.traded_at >= "2026-10-12T05:00:00Z" && t.screening_result_id && rt.get(byId.get(t.screening_result_id)?.strategy_id ?? "") === "ma_cross");
  console.log(`오늘 매수 중 ma_cross 출처 ${maTradesNew.length}`);
  const d = new Map<string, number>();
  for (const t of trades) { const k = `${t.traded_at.slice(0, 10)}:${t.side}`; d.set(k, (d.get(k) ?? 0) + 1); }
  console.log(`10/8~ 일자별 모의 체결: ${JSON.stringify(Object.fromEntries(d))}`);

  const { data: pr } = await supabaseAdmin.from("paper_runs").select("*").order("started_at", { ascending: false }).limit(5);
  console.log(`paper_runs 최근: ${JSON.stringify(pr)}`);
  const { data: sr2 } = await supabaseAdmin.from("screening_runs").select("*").order("finished_at", { ascending: false }).limit(5);
  console.log(`screening_runs 최근: ${JSON.stringify(sr2)}`);
  const { data: snaps } = await supabaseAdmin.from("paper_daily_snapshots").select("portfolio_id, snapshot_date, equity, daily_return_pct").gte("snapshot_date", "2026-10-07").order("snapshot_date");
  console.log(`스냅샷 10/7~: ${JSON.stringify((snaps ?? []).map((s) => [styleOf.get(s.portfolio_id as string), s.snapshot_date, Math.round(Number(s.equity)), Number(s.daily_return_pct).toFixed(2)]))}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

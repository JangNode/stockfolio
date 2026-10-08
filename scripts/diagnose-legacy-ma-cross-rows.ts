/** [임시 조사 — 병합 금지, 읽기 전용] 구 규칙(5/20) ma_cross 활성 스크리닝 행 현황. */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAllRows } from "@/lib/supabasePagination";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";

async function main(): Promise<void> {
  const { data: strategies, error: sErr } = await supabaseAdmin.from("strategies").select("id, rule_type").eq("rule_type", "ma_cross");
  if (sErr) throw new Error(sErr.message);
  const ids = (strategies ?? []).map((s) => s.id as string);
  const rows = await fetchAllRows<{ id: string; strategy_id: string; stock_code: string; market: string; status: string; signal_details: unknown; matched_at: string; return_pct: number }>((from, to) =>
    supabaseAdmin.from("screening_results").select("id, strategy_id, stock_code, market, status, signal_details, matched_at, return_pct").in("strategy_id", ids).order("id").range(from, to)
  );
  const isV2 = (d: unknown): boolean => typeof d === "object" && d !== null && (d as { rule_version?: unknown }).rule_version === "v2";
  const active = rows.filter((r) => r.status === "active");
  const legacyActive = active.filter((r) => !isV2(r.signal_details));
  const v2Active = active.filter((r) => isV2(r.signal_details));
  const byMarket = (a: typeof rows): string => ["KR", "US"].map((m) => `${m}=${a.filter((r) => r.market === m).length}`).join(" ");
  console.log(`ma_cross 전체 행 ${rows.length} | 활성 ${active.length} (${byMarket(active)}) | 구 규칙 활성 ${legacyActive.length} (${byMarket(legacyActive)}) | v2 활성 ${v2Active.length}`);
  console.log(`전체 상태별: ${["active", "stopped", "profited", "price_unavailable", "price_anomaly"].map((s) => `${s}=${rows.filter((r) => r.status === s).length}`).join(" ")}`);

  const positions = await fetchAllRows<{ id: string; portfolio_id: string; stock_code: string; screening_result_id: string | null; market: string }>((from, to) =>
    supabaseAdmin.from("paper_positions").select("id, portfolio_id, stock_code, screening_result_id, market").order("id").range(from, to)
  );
  const { data: portfolios } = await supabaseAdmin.from("paper_portfolios").select("id, style, market");
  const styleOf = new Map((portfolios ?? []).map((p) => [p.id as string, `${p.style}:${p.market}`]));
  const legacyIds = new Set(legacyActive.map((r) => r.id));
  const linked = positions.filter((p) => p.screening_result_id && legacyIds.has(p.screening_result_id));
  const allMaIds = new Set(rows.map((r) => r.id));
  const linkedAnyMa = positions.filter((p) => p.screening_result_id && allMaIds.has(p.screening_result_id));
  const byAcc = new Map<string, number>();
  for (const p of linked) byAcc.set(styleOf.get(p.portfolio_id) ?? p.portfolio_id, (byAcc.get(styleOf.get(p.portfolio_id) ?? p.portfolio_id) ?? 0) + 1);
  console.log(`열린 모의 포지션 총 ${positions.length} | ma_cross 출처 ${linkedAnyMa.length} | 그중 구 규칙 활성 행에 연결 ${linked.length} ${JSON.stringify(Object.fromEntries(byAcc))}`);
  console.log(`  연결 행 상태: ${JSON.stringify(Object.fromEntries(["active", "stopped", "profited", "price_unavailable", "price_anomaly"].map((s) => [s, linkedAnyMa.filter((p) => rows.find((r) => r.id === p.screening_result_id)?.status === s).length])))}`);

  // KR 구 규칙 활성 행 중 시총 5천억 이상(= v2 신호가 막히는 종목)
  const year = new Date().getUTCFullYear();
  const series = await loadAllStockSeriesFromParquet(year, year);
  const capOf = (code: string): number | null => { const r = series.get(code); return r && r.length ? r[r.length - 1].marketCapEok : null; };
  const krLegacy = legacyActive.filter((r) => r.market === "KR");
  const big = krLegacy.filter((r) => (capOf(r.stock_code) ?? 0) >= 5000);
  console.log(`KR 구 규칙 활성 ${krLegacy.length}건 중 시총 5천억 이상 ${big.length}건(v2 신호가 막히는 종목 수), 그중 모의 포지션 연결 ${big.filter((r) => linked.some((p) => p.screening_result_id === r.id)).length}건`);
  const ageDays = legacyActive.map((r) => (Date.now() - Date.parse(r.matched_at)) / 86400000).sort((a, b) => a - b);
  const q = (p: number): string => ageDays[Math.floor(ageDays.length * p)]?.toFixed(0) ?? "-";
  console.log(`구 규칙 활성 행 경과일 분포: 최소 ${q(0)} / 25% ${q(0.25)} / 중앙 ${q(0.5)} / 75% ${q(0.75)} / 최대 ${ageDays[ageDays.length - 1]?.toFixed(0)}`);
  const lastLegacy = rows.filter((r) => !isV2(r.signal_details)).map((r) => r.matched_at).sort().pop();
  console.log(`가장 최근 구 규칙 신호 matched_at ${lastLegacy}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

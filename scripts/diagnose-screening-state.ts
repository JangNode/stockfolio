/** [임시 조사 — 병합 금지, 읽기 전용] 오늘 스크리닝 후 활성 신호/신규 저장 현황. */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAllRows } from "@/lib/supabasePagination";

async function main(): Promise<void> {
  const rows = await fetchAllRows<{ id: string; strategy_id: string; stock_code: string; market: string; status: string; matched_at: string; signal_details: unknown }>((from, to) =>
    supabaseAdmin.from("screening_results").select("id, strategy_id, stock_code, market, status, matched_at, signal_details").eq("status", "active").order("id").range(from, to)
  );
  const { data: strategies } = await supabaseAdmin.from("strategies").select("id, rule_type");
  const rt = new Map((strategies ?? []).map((s) => [s.id as string, s.rule_type as string]));
  const kr = rows.filter((r) => r.market === "KR");
  const keys = new Set(rows.map((r) => `${r.strategy_id}:${r.stock_code}`));
  console.log(`활성 전체 ${rows.length} (KR ${kr.length}, US ${rows.length - kr.length}) | (전략,종목) 유일 키 ${keys.size} → 중복 ${rows.length - keys.size}`);
  const byRule = new Map<string, number>();
  for (const r of kr) byRule.set(rt.get(r.strategy_id) ?? "?", (byRule.get(rt.get(r.strategy_id) ?? "?") ?? 0) + 1);
  console.log(`KR 활성 규칙별: ${JSON.stringify(Object.fromEntries(byRule))}`);
  const since = "2026-10-08T05:00:00Z";
  const fresh = rows.filter((r) => r.matched_at >= since && r.market === "KR");
  const freshBy = new Map<string, number>();
  for (const r of fresh) freshBy.set(rt.get(r.strategy_id) ?? "?", (freshBy.get(rt.get(r.strategy_id) ?? "?") ?? 0) + 1);
  console.log(`오늘 KR 신규 저장(활성) ${fresh.length}: ${JSON.stringify(Object.fromEntries(freshBy))}`);
  const freshMa = fresh.filter((r) => rt.get(r.strategy_id) === "ma_cross");
  console.log(`  오늘 신규 ma_cross ${freshMa.length}건 중 v2 표식 ${freshMa.filter((r) => (r.signal_details as { rule_version?: string } | null)?.rule_version === "v2").length}건(병합 전 코드라 0 예상)`);
  const maActive = rows.filter((r) => rt.get(r.strategy_id) === "ma_cross");
  console.log(`ma_cross 활성 ${maActive.length} (KR ${maActive.filter((r) => r.market === "KR").length}, US ${maActive.filter((r) => r.market === "US").length}) — 이전 조회 262(KR 109, US 153)`);
  const { data: runs } = await supabaseAdmin.from("screening_runs").select("finished_at, scanned_count, matched_count").order("finished_at", { ascending: false }).limit(2);
  console.log(`screening_runs 최근: ${JSON.stringify(runs)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

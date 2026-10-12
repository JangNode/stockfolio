/** [임시 조사 — 병합 금지, 읽기 전용] paper_strategies 버전 현황. */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main(): Promise<void> {
  const { data, error } = await supabaseAdmin.from("paper_strategies").select("style, version, label, is_active, created_at, retired_at, entry_conditions, exit_conditions, rationale").order("created_at", { ascending: false }).limit(8);
  if (error) throw new Error(error.message);
  for (const r of data ?? []) {
    console.log(`${r.style} v${r.version} 활성=${r.is_active} 생성 ${String(r.created_at).slice(0, 16)} ${r.retired_at ? "retired " + String(r.retired_at).slice(0, 16) : ""} | 소스 ${JSON.stringify((r.entry_conditions as { source_rule_types?: string[] }).source_rule_types)} | 손절/익절/보유 ${JSON.stringify(r.exit_conditions)} | rationale 길이 ${String(r.rationale).length}`);
  }
  const { data: runs } = await supabaseAdmin.from("paper_runs").select("started_at, market, buy_count, sell_count, error_count").order("started_at", { ascending: false }).limit(4);
  console.log(`paper_runs 최근: ${JSON.stringify(runs)}`);
  const { data: sr } = await supabaseAdmin.from("screening_runs").select("finished_at, scanned_count, matched_count").order("finished_at", { ascending: false }).limit(3);
  console.log(`screening_runs 최근: ${JSON.stringify(sr)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

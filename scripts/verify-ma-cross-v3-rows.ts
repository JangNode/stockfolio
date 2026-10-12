/** [임시 검증 — 병합 금지, 읽기 전용] 기존 행/모의 포지션이 v3 변경의 영향을 받지 않는지 확인용 집계. */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAllRows } from "@/lib/supabasePagination";
import { isMaCrossV2Signal, isMaCrossV3Signal } from "@/lib/maCrossConfig";
import { usesSignalExit } from "@/lib/screeningSignalRules";

async function main(): Promise<void> {
  const { data: strategies } = await supabaseAdmin.from("strategies").select("id, rule_type, market");
  const meta = new Map((strategies ?? []).map((s) => [s.id as string, s]));
  const rows = await fetchAllRows<{ id: string; strategy_id: string; market: string; status: string; signal_details: unknown }>((from, to) =>
    supabaseAdmin.from("screening_results").select("id, strategy_id, market, status, signal_details").order("id").range(from, to));
  const bucket = new Map<string, number>();
  let exitMarked = 0;
  for (const r of rows) {
    const rt = String(meta.get(r.strategy_id)?.rule_type);
    if (usesSignalExit(r.signal_details)) exitMarked++;
    if (rt !== "ma_cross") continue;
    const marker = isMaCrossV3Signal(r.signal_details) ? "v3" : isMaCrossV2Signal(r.signal_details) ? "v2" : "구규칙(5/20, 표식 없음)";
    const k = `${r.market} | ${marker} | ${r.status}`;
    bucket.set(k, (bucket.get(k) ?? 0) + 1);
  }
  console.log("ma_cross screening_results (시장 | 표식 | status): 행 수");
  for (const [k, n] of [...bucket].sort()) console.log(`  ${k}: ${n}`);
  console.log(`전체 screening_results ${rows.length}행 중 신호 이탈 표식(exit_rule=signal) 보유: ${exitMarked}행 (0이면 기존 행은 전부 기존 방식(손절 7%/익절 20%)으로 계속 추적됨)`);
  const byRule = new Map<string, number>();
  for (const r of rows.filter((x) => x.status === "active" && x.market === "KR")) byRule.set(String(meta.get(r.strategy_id)?.rule_type), (byRule.get(String(meta.get(r.strategy_id)?.rule_type)) ?? 0) + 1);
  console.log(`KR active 행 rule_type별: ${JSON.stringify(Object.fromEntries(byRule))}`);

  const pos = await fetchAllRows<{ id: string; screening_result_id: string | null }>((from, to) =>
    supabaseAdmin.from("paper_positions").select("id, screening_result_id").order("id").range(from, to));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const maPos = pos.filter((p) => p.screening_result_id && String(meta.get(byId.get(p.screening_result_id)?.strategy_id ?? "")?.rule_type) === "ma_cross");
  const dist = new Map<string, number>();
  for (const p of maPos) {
    const r = byId.get(p.screening_result_id as string)!;
    const k = `${r.market} | ${isMaCrossV3Signal(r.signal_details) ? "v3" : isMaCrossV2Signal(r.signal_details) ? "v2" : "구규칙"} | ${r.status} | 신호이탈표식=${usesSignalExit(r.signal_details)}`;
    dist.set(k, (dist.get(k) ?? 0) + 1);
  }
  console.log(`열린 모의 포지션 ${pos.length}건 중 ma_cross 출처 ${maPos.length}건: ${JSON.stringify(Object.fromEntries(dist))}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

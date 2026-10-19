/** [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] DB 전체·investor_flow_stock_pilot 크기 보고(research_storage_report RPC). */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const mb = (b: number): string => (b / 1048576).toFixed(2);

async function main(): Promise<void> {
  const { data, error } = await supabaseAdmin.rpc("research_storage_report");
  if (error) throw new Error(`research_storage_report 실패: ${error.message}`);
  const r = data as { db_bytes: number; pilot_rows: number; pilot_data_bytes: number; pilot_index_bytes: number; pilot_total_bytes: number; top_tables: { table: string; total_bytes: number; index_bytes: number }[] };
  console.log(`DB 전체 ${r.db_bytes} B (${mb(r.db_bytes)} MB)`);
  console.log(`investor_flow_stock_pilot: 행 ${r.pilot_rows}, 데이터 ${r.pilot_data_bytes} B, 인덱스 ${r.pilot_index_bytes} B, 합계 ${r.pilot_total_bytes} B (${mb(r.pilot_total_bytes)} MB)`);
  console.log(`행당 바이트: 데이터 ${(r.pilot_data_bytes / r.pilot_rows).toFixed(1)}, 인덱스 ${(r.pilot_index_bytes / r.pilot_rows).toFixed(1)}, 합계 ${(r.pilot_total_bytes / r.pilot_rows).toFixed(1)}`);
  console.log("public 상위 표 (합계 MB / 인덱스 MB)");
  for (const t of r.top_tables) console.log(`  ${t.table}: ${mb(t.total_bytes)} / ${mb(t.index_bytes)}`);
}
main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e); process.exit(1); });

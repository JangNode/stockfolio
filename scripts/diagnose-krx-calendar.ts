/** [임시 조사 — 병합 금지, 읽기 전용] KRX 거래일 캘린더 DB 상태(10/9 한글날 휴장 여부). */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main(): Promise<void> {
  const { data, error } = await supabaseAdmin.from("krx_trading_calendar").select("*").gte("trade_date", "2026-09-28").lte("trade_date", "2026-10-20").order("trade_date");
  if (error) throw new Error(error.message);
  console.log(`캘린더 행 ${data?.length}: ${JSON.stringify((data ?? []).map((r) => `${r.trade_date}:${r.is_open ? "open" : "closed"}`))}`);
  console.log(`컬럼: ${Object.keys((data ?? [])[0] ?? {}).join(",")}`);
  const { data: all } = await supabaseAdmin.from("krx_trading_calendar").select("trade_date, is_open").order("trade_date");
  const a = all ?? [];
  console.log(`전체 ${a.length}행, 범위 ${a[0]?.trade_date} ~ ${a[a.length - 1]?.trade_date}, 휴장(closed) ${a.filter((r) => !r.is_open).length}일`);
  const closed2026 = a.filter((r) => !r.is_open && String(r.trade_date).startsWith("2026")).map((r) => r.trade_date);
  console.log(`2026 휴장일(평일 포함): ${JSON.stringify(closed2026)}`);
  const { data: st } = await supabaseAdmin.from("schedule_scrape_status").select("*").eq("source", "KRX_CALENDAR");
  console.log(`동기화 상태: ${JSON.stringify(st)}`);
  const { data: runs } = await supabaseAdmin.from("screening_runs").select("finished_at, scanned_count, matched_count").order("finished_at", { ascending: false }).limit(4);
  console.log(`screening_runs 최근: ${JSON.stringify(runs)}`);
  const { data: pr } = await supabaseAdmin.from("paper_runs").select("*").order("finished_at", { ascending: false }).limit(3);
  console.log(`paper_runs 최근: ${JSON.stringify(pr)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

/** [임시 조사 — 병합 금지, 읽기 전용] KR 손절·익절 종결 건수 일별 분포 + 지수 등락률. */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAllRows } from "@/lib/supabasePagination";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";

type SR = { id: string; strategy_id: string; stock_code: string; status: string; matched_at: string; last_price_fetch_success_at: string | null };
const kstDate = (iso: string): string => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);

async function main(): Promise<void> {
  for (const m of ["KOSPI", "KOSDAQ"] as const) {
    const s = await getIndexPriceSeries(m, "2026-09-01", "2026-10-31");
    const tail = s.slice(-24);
    console.log(`${m} 최근: ${JSON.stringify(tail.map((p, i) => [p.date, p.close, i ? +(((p.close / tail[i - 1].close) - 1) * 100).toFixed(2) : null]))}`);
  }
  const { data: strategies } = await supabaseAdmin.from("strategies").select("id, rule_type");
  const rt = new Map((strategies ?? []).map((s) => [s.id as string, s.rule_type as string]));
  const rows = await fetchAllRows<SR>((from, to) =>
    supabaseAdmin.from("screening_results").select("id, strategy_id, stock_code, status, matched_at, last_price_fetch_success_at").eq("market", "KR").in("status", ["stopped", "profited"]).gte("last_price_fetch_success_at", "2026-08-25T00:00:00Z").order("id").range(from, to));
  const byDay = new Map<string, SR[]>();
  for (const r of rows) { const d = kstDate(r.last_price_fetch_success_at as string); (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(r); }
  const days = [...byDay.keys()].sort();
  for (const d of days.slice(-30)) {
    const a = byDay.get(d)!;
    const st = a.filter((r) => r.status === "stopped");
    const pf = a.filter((r) => r.status === "profited");
    const codes = new Set(st.map((r) => r.stock_code));
    const by: Record<string, number> = {};
    for (const r of st) by[rt.get(r.strategy_id) ?? "?"] = (by[rt.get(r.strategy_id) ?? "?"] ?? 0) + 1;
    console.log(`DAY ${d} 손절 ${st.length} (고유종목 ${codes.size}) 익절 ${pf.length} | 전략별 ${JSON.stringify(by)}`);
  }
  // 10/12 상세
  const t = (byDay.get("2026-10-12") ?? []).filter((r) => r.status === "stopped");
  const perCode = new Map<string, SR[]>();
  for (const r of t) (perCode.get(r.stock_code) ?? perCode.set(r.stock_code, []).get(r.stock_code)!).push(r);
  const multi = [...perCode.values()].filter((v) => v.length > 1);
  console.log(`10/12 손절 ${t.length}건 고유종목 ${perCode.size} | 2건 이상 등록 종목 ${multi.length}개(${multi.reduce((s, v) => s + v.length, 0)}건) | 최다 ${Math.max(...[...perCode.values()].map((v) => v.length))}건`);
  const dist = new Map<number, number>();
  for (const v of perCode.values()) dist.set(v.length, (dist.get(v.length) ?? 0) + 1);
  console.log(`종목당 등록 건수 분포 {건수:종목수} ${JSON.stringify(Object.fromEntries(dist))}`);
  const ruleCodes: Record<string, Set<string>> = {};
  for (const r of t) (ruleCodes[rt.get(r.strategy_id) ?? "?"] ??= new Set()).add(r.stock_code);
  console.log(`전략별 고유종목 ${JSON.stringify(Object.fromEntries(Object.entries(ruleCodes).map(([k, v]) => [k, v.size])))}`);
  const age = t.map((r) => (Date.parse(r.last_price_fetch_success_at as string) - Date.parse(r.matched_at)) / 86400e3).sort((a, b) => a - b);
  console.log(`10/12 손절 건의 신호 경과일 중앙 ${age[Math.floor(age.length / 2)]?.toFixed(0)} 최소 ${age[0]?.toFixed(0)} 최대 ${age[age.length - 1]?.toFixed(0)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

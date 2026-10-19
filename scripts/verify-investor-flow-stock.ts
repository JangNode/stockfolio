/** [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 종목별 투자자 수급 Parquet 최종 보고: 파일별 크기·행 수, 종목별 첫·마지막 날짜 분포, 전부 0인 종목, 시험 표 대조, DB 크기. */
import { parquetReadObjects } from "hyparquet";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET, INVESTOR_FLOW_STOCK_STORE_PREFIX, INVESTOR_FLOW_STOCK_FIRST_YEAR, INVESTOR_FLOW_TO } from "@/lib/investorFlowConfig";

const BASELINE_DB_BYTES = 234_212_499; // 2026-10-19 research_storage_report() 실측(DB 전체)
interface Row { stock_code: string; trade_date: string; frgn_ntby_amt: number | null; orgn_ntby_amt: number | null; prsn_ntby_amt: number | null; frgn_ntby_qty: number | null }
const bucket = (): ReturnType<typeof supabaseAdmin.storage.from> => supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET);
const mb = (b: number): string => (b / 1048576).toFixed(2);

async function main(): Promise<void> {
  const { data: files, error } = await bucket().list(INVESTOR_FLOW_STOCK_STORE_PREFIX, { limit: 1000 });
  if (error) throw new Error(`목록 실패: ${error.message}`);
  const sizeOf = new Map((files ?? []).map((f) => [f.name, Number((f.metadata as { size?: number } | null)?.size ?? 0)]));
  const all: Row[] = [];
  console.log("| 파일 | 크기 B | 행 수 |\n|---|---|---|");
  let totBytes = 0;
  for (let y = INVESTOR_FLOW_STOCK_FIRST_YEAR; y <= Number(INVESTOR_FLOW_TO.slice(0, 4)); y++) {
    const { data, error: e } = await bucket().download(`${INVESTOR_FLOW_STOCK_STORE_PREFIX}/${y}.parquet`);
    if (e) { console.log(`| ${y}.parquet | (없음) | 0 |`); continue; }
    const rows = (await parquetReadObjects({ file: await data.arrayBuffer() })) as Row[];
    const sz = sizeOf.get(`${y}.parquet`) ?? 0; totBytes += sz;
    console.log(`| ${y}.parquet | ${sz} | ${rows.length} |`);
    for (const r of rows) all.push(r);
  }
  console.log(`| 합계 | ${totBytes} (${mb(totBytes)} MiB) | ${all.length} |`);
  const prog = JSON.parse(new TextDecoder().decode(await (await bucket().download(`${INVESTOR_FLOW_STOCK_STORE_PREFIX}/_progress.json`)).data!.arrayBuffer())) as { requestsTotal: number; stocks: Record<string, { done: boolean; rows: number }>; runs: { startedAt: string; requests: number; completed: number; newRows: number; errors: number; stop: string }[] };
  console.log(`\n진행 파일: 종목 ${Object.keys(prog.stocks).length}개 중 완료 ${Object.values(prog.stocks).filter((s) => s.done).length}, 누적 요청 ${prog.requestsTotal}, 행 0인 완료 종목 ${Object.values(prog.stocks).filter((s) => s.done && s.rows === 0).length}`);
  console.log("| 회차 | 시작(UTC) | 요청 | 완료 종목 | 새 행 | 오류 | 중단 사유 |\n|---|---|---|---|---|---|---|");
  prog.runs.forEach((r, i) => console.log(`| ${i + 1} | ${r.startedAt} | ${r.requests} | ${r.completed} | ${r.newRows} | ${r.errors} | ${r.stop} |`));

  // 종목별 첫·마지막 날짜, 전부 0 여부
  const per = new Map<string, { first: string; last: string; n: number; nonZero: boolean }>();
  for (const r of all) {
    const p = per.get(r.stock_code) ?? { first: r.trade_date, last: r.trade_date, n: 0, nonZero: false };
    if (r.trade_date < p.first) p.first = r.trade_date;
    if (r.trade_date > p.last) p.last = r.trade_date;
    p.n++;
    if ((r.frgn_ntby_amt ?? 0) !== 0 || (r.orgn_ntby_amt ?? 0) !== 0 || (r.prsn_ntby_amt ?? 0) !== 0 || (r.frgn_ntby_qty ?? 0) !== 0) p.nonZero = true;
    per.set(r.stock_code, p);
  }
  console.log(`\n데이터가 있는 종목 ${per.size}개, 값이 전부 0(금액 3종·외국인 수량)인 종목 ${[...per.values()].filter((p) => !p.nonZero).length}개`);
  const hist = (f: (p: { first: string; last: string }) => string): string => { const m = new Map<string, number>(); for (const p of per.values()) m.set(f(p), (m.get(f(p)) ?? 0) + 1); return [...m.entries()].sort().map(([k, v]) => `${k}:${v}`).join(" "); };
  console.log("첫 날짜 연도별 종목 수: " + hist((p) => p.first.slice(0, 4)));
  console.log(`첫 날짜가 2010-01-04인 종목 ${[...per.values()].filter((p) => p.first === "2010-01-04").length}개, 2010-01-05~2010-01-31 ${[...per.values()].filter((p) => p.first > "2010-01-04" && p.first <= "2010-01-31").length}개`);
  console.log("마지막 날짜 연도별 종목 수: " + hist((p) => p.last.slice(0, 4)));
  console.log(`마지막 날짜가 ${INVESTOR_FLOW_TO}인 종목 ${[...per.values()].filter((p) => p.last === INVESTOR_FLOW_TO).length}개`);

  // 시험 표 대조
  const key = (c: string, d: string): string => `${c}|${d}`;
  const stored = new Map(all.map((r) => [key(r.stock_code, r.trade_date), r]));
  let total = 0, match = 0, missing = 0, mismatch = 0;
  const codes = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error: e } = await supabaseAdmin.from("investor_flow_stock_pilot").select("stock_code, trade_date, frgn_ntby_amt, orgn_ntby_amt, prsn_ntby_amt, frgn_ntby_qty").order("stock_code").order("trade_date").range(from, from + 999);
    if (e) throw new Error(`시험 표 읽기 실패: ${e.message}`);
    for (const r of data ?? []) {
      total++; codes.add(r.stock_code as string);
      const s = stored.get(key(r.stock_code as string, r.trade_date as string));
      const n = (v: unknown): number | null => (v === null ? null : Number(v));
      if (!s) missing++;
      else if (s.frgn_ntby_amt === n(r.frgn_ntby_amt) && s.orgn_ntby_amt === n(r.orgn_ntby_amt) && s.prsn_ntby_amt === n(r.prsn_ntby_amt) && s.frgn_ntby_qty === n(r.frgn_ntby_qty)) match++;
      else mismatch++;
    }
    if (!data || data.length < 1000) break;
  }
  console.log(`\n시험 표 대조: 종목 ${codes.size}개(${[...codes].sort().join(",")}), 시험 표 ${total}행 중 일치 ${match}, 불일치 ${mismatch}, Parquet에 없음 ${missing}`);

  // DB 크기
  const { data: rep, error: e2 } = await supabaseAdmin.rpc("research_storage_report");
  if (e2) throw new Error(`research_storage_report 실패: ${e2.message}`);
  const db = (rep as { db_bytes: number }).db_bytes;
  console.log(`DB 전체 ${db} B (${mb(db)} MiB), 기준 ${BASELINE_DB_BYTES} B 대비 ${db - BASELINE_DB_BYTES >= 0 ? "+" : ""}${db - BASELINE_DB_BYTES} B`);
}
main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e); process.exit(1); });

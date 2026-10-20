/**
 * [임시 연구 — 병합 금지, 외부 요청 0건, DB 쓰기 0] 공매도(research/short_sale)·신용잔고(research/credit_balance) 원본을 주가 Parquet의 종목별 거래일(종가>0)과 대조해
 * 상장 전·폐지 후·거래정지 행을 뺀 정리본(research/short_sale_clean, research/credit_balance_clean)을 따로 저장한다(원본은 그대로).
 * 공매도는 trade_date, 신용잔고는 deal_date로 대조한다. 주가 Parquet은 2010-01-04부터라 그 이전(2009-10~12) 행은 대조할 수 없어 정리본에 남기고 따로 센다
 * (단 첫 주가일이 2010-01-04보다 늦은 종목의 그 이전 행은 상장 전으로 제외).
 */
import { parquetWriteBuffer } from "hyparquet-writer";
import { parquetReadObjects } from "hyparquet";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET } from "@/lib/investorFlowConfig";
import {
  SC_COLLECT_FROM, SC_COLLECT_TO, SC_SHORT_PREFIX, SC_CREDIT_PREFIX, SC_SHORT_CLEAN_PREFIX, SC_CREDIT_CLEAN_PREFIX, SC_PROGRESS_FILE, SC_FIRST_YEAR, SC_LAST_YEAR, SC_PRICE_DATA_START,
} from "@/lib/shortCreditCollectConfig";

const T0 = Date.now();
type Row = Record<string, string | number | null>;
type Kind = "short" | "credit";
interface Spec { label: string; src: string; dst: string; dateCol: string; valueCols: string[]; cols: { name: string; type: "STRING" | "DOUBLE" }[] }
const SPECS: Record<Kind, Spec> = {
  short: { label: "공매도", src: SC_SHORT_PREFIX, dst: SC_SHORT_CLEAN_PREFIX, dateCol: "trade_date", valueCols: ["ssts_cntg_qty", "ssts_tr_pbmn"], cols: [{ name: "stock_code", type: "STRING" }, { name: "trade_date", type: "STRING" }, { name: "ssts_cntg_qty", type: "DOUBLE" }, { name: "ssts_tr_pbmn", type: "DOUBLE" }, { name: "stnd_vol_smtn", type: "DOUBLE" }, { name: "stnd_tr_pbmn_smtn", type: "DOUBLE" }] },
  credit: { label: "신용잔고", src: SC_CREDIT_PREFIX, dst: SC_CREDIT_CLEAN_PREFIX, dateCol: "deal_date", valueCols: ["whol_loan_rmnd_stcn", "whol_loan_rmnd_amt", "whol_stln_rmnd_stcn"], cols: [{ name: "stock_code", type: "STRING" }, { name: "deal_date", type: "STRING" }, { name: "stlm_date", type: "STRING" }, { name: "whol_loan_rmnd_stcn", type: "DOUBLE" }, { name: "whol_loan_rmnd_amt", type: "DOUBLE" }, { name: "whol_loan_rmnd_rate", type: "DOUBLE" }, { name: "whol_stln_rmnd_stcn", type: "DOUBLE" }] },
};
const bucket = (): ReturnType<typeof supabaseAdmin.storage.from> => supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET);
const mb = (b: number): string => (b / 1048576).toFixed(2);
const pct = (a: number, b: number): string => (b > 0 ? ((a / b) * 100).toFixed(2) : "-");
function encode(s: Spec, rows: Row[]): ArrayBuffer {
  const list = [...rows].sort((a, b) => ((a.stock_code as string) < (b.stock_code as string) ? -1 : (a.stock_code as string) > (b.stock_code as string) ? 1 : (a[s.dateCol] as string) < (b[s.dateCol] as string) ? -1 : 1));
  return parquetWriteBuffer({ columnData: s.cols.map((c) => c.type === "STRING" ? { name: c.name, data: list.map((r) => r[c.name] as string), type: "STRING" as const } : { name: c.name, data: list.map((r) => r[c.name] as number | null), type: "DOUBLE" as const, nullable: true }) });
}
async function walk(b: string, prefix: string, acc: { files: number; bytes: number }): Promise<void> {
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabaseAdmin.storage.from(b).list(prefix, { limit: 1000, offset });
    if (error) throw new Error(`${b}/${prefix} 목록 실패: ${error.message}`);
    for (const e of data ?? []) {
      if (e.id === null) await walk(b, prefix ? `${prefix}/${e.name}` : e.name, acc);
      else { acc.files++; acc.bytes += Number((e.metadata as { size?: number } | null)?.size ?? 0); }
    }
    if (!data || data.length < 1000) break;
  }
}

async function main(): Promise<void> {
  console.log(`정리 시작: ${new Date().toISOString()} (외부 요청 0, DB 쓰기 0)`);
  const series = await loadAllStockSeriesFromParquet(2010, SC_LAST_YEAR + 10);
  const priceDays = new Map<string, string[]>();
  for (const [code, rows] of series) {
    const days = rows.filter((r) => r.closePrice > 0).map((r) => r.tradeDate).sort();
    if (days.length) priceDays.set(code, days);
  }
  series.clear();
  let dbBaseline: number | null = null;

  for (const kind of ["short", "credit"] as Kind[]) {
    const s = SPECS[kind];
    console.log(`\n################ ${s.label} ################`);
    const orig: Row[] = [];
    for (let y = SC_FIRST_YEAR; y <= SC_LAST_YEAR; y++) {
      const { data, error } = await bucket().download(`${s.src}/${y}.parquet`);
      if (error) { console.log(`원본 ${y}.parquet 없음`); continue; }
      for (const r of (await parquetReadObjects({ file: await data.arrayBuffer() })) as Row[]) orig.push(r);
    }
    const progRes = await bucket().download(`${s.src}/${SC_PROGRESS_FILE}`);
    const prog = JSON.parse(new TextDecoder().decode(await progRes.data!.arrayBuffer())) as { requestsTotal: number; stocks: Record<string, { done: boolean; skipped: boolean; rows: number }>; dbBaselineBytes: number | null; stlmOrderViolations: number };
    if (kind === "short") dbBaseline = prog.dbBaselineBytes;
    const poolAll = Object.keys(prog.stocks).sort();
    const pool = poolAll.filter((c) => !prog.stocks[c].skipped);
    console.log(`원본 ${orig.length}행, 종목 ${new Set(orig.map((r) => r.stock_code)).size}개 | 진행 파일: 대상 ${poolAll.length}종목(요청 대상 ${pool.length}, 기간 겹침 없음 ${poolAll.length - pool.length}), 완료 ${Object.values(prog.stocks).filter((x) => x.done).length}, 누적 요청 ${prog.requestsTotal}${kind === "credit" ? `, 결제일 비단조 쌍 ${prog.stlmOrderViolations}` : ""}`);

    const byCode = new Map<string, Row[]>();
    for (const r of orig) { const a = byCode.get(r.stock_code as string); if (a) a.push(r); else byCode.set(r.stock_code as string, [r]); }
    const clean: Row[] = [];
    const excl = { pre: 0, post: 0, halt: 0, noPrice: 0, unverifiable: 0 };
    const missing = new Map<string, number>();
    const noRowStocks: string[] = [];
    const allZero: string[] = [];
    for (const code of pool) {
      const days = priceDays.get(code);
      const rows = byCode.get(code) ?? [];
      if (!days) { excl.noPrice += rows.length; continue; }
      const set = new Set(days), first = days[0], last = days[days.length - 1];
      const kept: Row[] = [];
      for (const r of rows) {
        const d = r[s.dateCol] as string;
        if (set.has(d)) kept.push(r);
        else if (d < SC_PRICE_DATA_START && first === SC_PRICE_DATA_START) { kept.push(r); excl.unverifiable++; }
        else if (d < first) excl.pre++;
        else if (d > last) excl.post++;
        else excl.halt++;
      }
      if (!rows.length) noRowStocks.push(code);
      if (kept.length && kept.every((r) => s.valueCols.every((c) => ((r[c] as number | null) ?? 0) === 0))) allZero.push(code);
      const have = new Set(kept.map((r) => r[s.dateCol] as string));
      missing.set(code, days.filter((d) => d >= SC_COLLECT_FROM && d <= SC_COLLECT_TO && !have.has(d)).length);
      for (const r of kept) clean.push(r);
    }
    const byYear = new Map<number, Row[]>();
    for (const r of clean) { const y = Number((r[s.dateCol] as string).slice(0, 4)); const a = byYear.get(y); if (a) a.push(r); else byYear.set(y, [r]); }
    for (const [y, rows] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
      const { error } = await bucket().upload(`${s.dst}/${y}.parquet`, encode(s, rows), { contentType: "application/octet-stream", upsert: true });
      if (error) throw new Error(`정리본 업로드 실패 ${y}: ${error.message}`);
    }

    console.log(`| 구분 | 행 수 |\n|---|---|\n| 원본 | ${orig.length} |\n| 제외: 상장 전(첫 주가일 이전) | ${excl.pre} |\n| 제외: 폐지 후(마지막 주가일 이후) | ${excl.post} |\n| 제외: 거래정지 등(첫~마지막 주가일 사이 주가 없는 날) | ${excl.halt} |\n| 제외: 주가 자료 없는 종목 | ${excl.noPrice} |\n| 정리본에 남김: 2010-01-04 이전(주가 대조 불가, 2009-10~12) | ${excl.unverifiable} |\n| 남은 행(정리본) | ${clean.length} |`);
    const mv = [...missing.values()];
    const bk = (n: number): string => (n === 0 ? "0건" : n <= 5 ? "1~5건" : n <= 20 ? "6~20건" : n <= 100 ? "21~100건" : "101건 이상");
    const dist = new Map<string, number>(); for (const n of mv) dist.set(bk(n), (dist.get(bk(n)) ?? 0) + 1);
    const top = [...missing.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`\n주가는 있는데 ${s.label} 행이 없는 날(기간 ${SC_COLLECT_FROM}~${SC_COLLECT_TO} 중 주가 거래일 기준): 합계 ${mv.reduce((a, b) => a + b, 0)}일, 종목 ${mv.length}개`);
    console.log("| 종목당 건수 | 종목 수 |\n|---|---|");
    for (const k of ["0건", "1~5건", "6~20건", "21~100건", "101건 이상"]) console.log(`| ${k} | ${dist.get(k) ?? 0} |`);
    console.log(`최대: ${top.map(([c, n]) => `${c} ${n}건`).join(", ")}`);
    console.log(`원본 행이 하나도 없는 종목(요청 대상 중) ${noRowStocks.length}개${noRowStocks.length && noRowStocks.length <= 40 ? ": " + noRowStocks.join(",") : ""}`);
    console.log(`값이 전부 0인 종목(${s.valueCols.join("·")} 모두 0 또는 null, 정리본 행이 있는 종목 중) ${allZero.length}개${allZero.length && allZero.length <= 40 ? ": " + allZero.join(",") : ""}`);

    if (kind === "short") {
      console.log("\n연도별 공매도 0인 날 비율 (정리본 행 기준)\n| 연도 | 행 수 | 체결수량 0 행 | 비율 % | 수량 0이고 거래대금도 0 | 비율 % | 값이 null인 행 |\n|---|---|---|---|---|---|---|");
      for (const [y, rows] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
        const q0 = rows.filter((r) => ((r.ssts_cntg_qty as number | null) ?? 0) === 0).length;
        const b0 = rows.filter((r) => ((r.ssts_cntg_qty as number | null) ?? 0) === 0 && ((r.ssts_tr_pbmn as number | null) ?? 0) === 0).length;
        const nl = rows.filter((r) => r.ssts_cntg_qty === null || r.ssts_tr_pbmn === null).length;
        console.log(`| ${y} | ${rows.length} | ${q0} | ${pct(q0, rows.length)} | ${b0} | ${pct(b0, rows.length)} | ${nl} |`);
      }
    }

    const { data: files, error } = await bucket().list(s.dst, { limit: 1000 });
    if (error) throw new Error(`정리본 목록 실패: ${error.message}`);
    const sizeOf = new Map((files ?? []).map((f) => [f.name, Number((f.metadata as { size?: number } | null)?.size ?? 0)]));
    console.log(`\n정리본 파일 (${s.dst})\n| 파일 | 크기 B | 행 수 |\n|---|---|---|`);
    let tb = 0;
    for (const [y, rows] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) { const sz = sizeOf.get(`${y}.parquet`) ?? 0; tb += sz; console.log(`| ${y}.parquet | ${sz} | ${rows.length} |`); }
    console.log(`| 합계 | ${tb} (${mb(tb)} MiB) | ${clean.length} |`);
  }

  const { data: bks } = await supabaseAdmin.storage.listBuckets();
  let files2 = 0, bytes2 = 0;
  console.log("\nStorage 총량\n| 버킷 | 파일 수 | 크기 B | MiB |\n|---|---|---|---|");
  for (const b of bks ?? []) { const acc = { files: 0, bytes: 0 }; await walk(b.name, "", acc); files2 += acc.files; bytes2 += acc.bytes; console.log(`| ${b.name} | ${acc.files} | ${acc.bytes} | ${mb(acc.bytes)} |`); }
  console.log(`| 합계 | ${files2} | ${bytes2} | ${mb(bytes2)} |`);
  const { data: rep, error: e2 } = await supabaseAdmin.rpc("research_storage_report");
  if (e2) throw new Error(`research_storage_report 실패: ${e2.message}`);
  const db = (rep as { db_bytes: number }).db_bytes;
  console.log(`DB 전체 ${db} B (${mb(db)} MiB), 수집 첫 회차 시작 기준 ${dbBaseline} B 대비 ${dbBaseline === null ? "-" : `${db - dbBaseline >= 0 ? "+" : ""}${db - dbBaseline} B`} | 소요 ${((Date.now() - T0) / 1000).toFixed(1)}s`);
}
main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e); process.exit(1); });

/**
 * [임시 연구 — 병합 금지, 외부 요청 0건, DB 쓰기 0] 종목별 투자자 수급 원본(research/investor_flow_stock)을 주가 Parquet의 종목별 거래일(종가>0인 날)과 대조해
 * 주가 없는 날(상장 전·폐지 후·거래정지일)의 행을 뺀 정리본을 research/investor_flow_stock_clean/YYYY.parquet로 따로 저장한다(원본은 그대로).
 * 주가는 있는데 수급 행이 없는 날은 종목별로 개수만 집계한다.
 */
import { parquetWriteBuffer } from "hyparquet-writer";
import { parquetReadObjects } from "hyparquet";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET, INVESTOR_FLOW_STOCK_STORE_PREFIX, INVESTOR_FLOW_STOCK_CLEAN_PREFIX, INVESTOR_FLOW_STOCK_FIRST_YEAR, INVESTOR_FLOW_STOCK_FROM, INVESTOR_FLOW_TO } from "@/lib/investorFlowConfig";

const T0 = Date.now();
const BASELINE_DB_BYTES = 234_212_499; // 2026-10-19 research_storage_report() 실측
const MS_DAY = 86_400_000;
interface Row { stock_code: string; trade_date: string; frgn_ntby_amt: number | null; orgn_ntby_amt: number | null; prsn_ntby_amt: number | null; frgn_ntby_qty: number | null }
const bucket = (): ReturnType<typeof supabaseAdmin.storage.from> => supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET);
const mb = (b: number): string => (b / 1048576).toFixed(2);
const nz = (r: Row): boolean => (r.frgn_ntby_amt ?? 0) !== 0 || (r.orgn_ntby_amt ?? 0) !== 0 || (r.prsn_ntby_amt ?? 0) !== 0 || (r.frgn_ntby_qty ?? 0) !== 0;
const dayDiff = (a: string, b: string): number => Math.round((Date.parse(a) - Date.parse(b)) / MS_DAY);
const LAST_YEAR = Number(INVESTOR_FLOW_TO.slice(0, 4));

function encode(rows: Row[]): ArrayBuffer {
  const list = [...rows].sort((a, b) => (a.stock_code < b.stock_code ? -1 : a.stock_code > b.stock_code ? 1 : a.trade_date < b.trade_date ? -1 : 1));
  return parquetWriteBuffer({
    columnData: [
      { name: "stock_code", data: list.map((r) => r.stock_code), type: "STRING" },
      { name: "trade_date", data: list.map((r) => r.trade_date), type: "STRING" },
      { name: "frgn_ntby_amt", data: list.map((r) => r.frgn_ntby_amt), type: "DOUBLE", nullable: true },
      { name: "orgn_ntby_amt", data: list.map((r) => r.orgn_ntby_amt), type: "DOUBLE", nullable: true },
      { name: "prsn_ntby_amt", data: list.map((r) => r.prsn_ntby_amt), type: "DOUBLE", nullable: true },
      { name: "frgn_ntby_qty", data: list.map((r) => r.frgn_ntby_qty), type: "DOUBLE", nullable: true },
    ],
  });
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
  // ---- 원본 ----
  const orig: Row[] = [];
  for (let y = INVESTOR_FLOW_STOCK_FIRST_YEAR; y <= LAST_YEAR; y++) {
    const { data, error } = await bucket().download(`${INVESTOR_FLOW_STOCK_STORE_PREFIX}/${y}.parquet`);
    if (error) { console.log(`원본 ${y}.parquet 없음`); continue; }
    for (const r of (await parquetReadObjects({ file: await data.arrayBuffer() })) as Row[]) orig.push(r);
  }
  const progRes = await bucket().download(`${INVESTOR_FLOW_STOCK_STORE_PREFIX}/_progress.json`);
  const prog = JSON.parse(new TextDecoder().decode(await progRes.data!.arrayBuffer())) as { requestsTotal: number; stocks: Record<string, { done: boolean }> };
  console.log(`원본 ${orig.length}행, 종목 ${new Set(orig.map((r) => r.stock_code)).size}개, 진행 파일 완료 종목 ${Object.values(prog.stocks).filter((s) => s.done).length}, 누적 요청 ${prog.requestsTotal}`);

  // ---- 주가 거래일 (종가>0) ----
  const series = await loadAllStockSeriesFromParquet(2010, LAST_YEAR);
  const priceDays = new Map<string, string[]>();
  for (const [code, rows] of series) {
    const days = rows.filter((r) => r.tradeDate >= INVESTOR_FLOW_STOCK_FROM && r.closePrice > 0).map((r) => r.tradeDate).sort();
    if (days.length) priceDays.set(code, days);
  }
  series.clear();

  // ---- 대조 ----
  const byCode = new Map<string, Row[]>();
  for (const r of orig) { const a = byCode.get(r.stock_code); if (a) a.push(r); else byCode.set(r.stock_code, [r]); }
  const clean: Row[] = [];
  const excl = { pre: 0, post: 0, halt: 0, noPrice: 0 };
  const exclBy = new Map<string, { pre: number; post: number; halt: number }>();
  const missing = new Map<string, number>();
  const nzFirst = new Map<string, string | null>();
  const flowHasNoPriceStock: string[] = [];
  for (const [code, rows] of byCode) {
    const days = priceDays.get(code);
    if (!days) { excl.noPrice += rows.length; flowHasNoPriceStock.push(code); continue; }
    const set = new Set(days), first = days[0], last = days[days.length - 1];
    const e = { pre: 0, post: 0, halt: 0 };
    const kept: Row[] = [];
    for (const r of rows) {
      if (set.has(r.trade_date)) kept.push(r);
      else if (r.trade_date < first) e.pre++;
      else if (r.trade_date > last) e.post++;
      else e.halt++;
    }
    excl.pre += e.pre; excl.post += e.post; excl.halt += e.halt; exclBy.set(code, e);
    const have = new Set(kept.map((r) => r.trade_date));
    missing.set(code, days.filter((d) => !have.has(d)).length);
    kept.sort((a, b) => (a.trade_date < b.trade_date ? -1 : 1));
    nzFirst.set(code, kept.find(nz)?.trade_date ?? null);
    for (const r of kept) clean.push(r);
  }

  // ---- 정리본 저장 ----
  const byYear = new Map<number, Row[]>();
  for (const r of clean) { const y = Number(r.trade_date.slice(0, 4)); const a = byYear.get(y); if (a) a.push(r); else byYear.set(y, [r]); }
  for (const [y, rows] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    const { error } = await bucket().upload(`${INVESTOR_FLOW_STOCK_CLEAN_PREFIX}/${y}.parquet`, encode(rows), { contentType: "application/octet-stream", upsert: true });
    if (error) throw new Error(`정리본 업로드 실패 ${y}: ${error.message}`);
  }

  // ---- 보고 ----
  console.log(`\n정리 대상 종목 ${byCode.size}개 (주가 자료 없는 종목 ${flowHasNoPriceStock.length}개: ${flowHasNoPriceStock.join(",") || "없음"})`);
  console.log(`| 구분 | 행 수 |\n|---|---|\n| 원본 | ${orig.length} |\n| 제외: 상장 전(첫 주가일 이전) | ${excl.pre} |\n| 제외: 폐지 후(마지막 주가일 이후) | ${excl.post} |\n| 제외: 거래정지 등(첫~마지막 주가일 사이 주가 없는 날) | ${excl.halt} |\n| 제외: 주가 자료 없는 종목 | ${excl.noPrice} |\n| 남은 행(정리본) | ${clean.length} |`);
  const pre = [...exclBy.values()].filter((e) => e.pre > 0).length, post = [...exclBy.values()].filter((e) => e.post > 0).length, halt = [...exclBy.values()].filter((e) => e.halt > 0).length;
  console.log(`제외 행이 있는 종목 수: 상장 전 ${pre}, 폐지 후 ${post}, 거래정지 ${halt}`);
  const haltTop = [...exclBy.entries()].sort((a, b) => b[1].halt - a[1].halt).slice(0, 5).map(([c, e]) => `${c}:${e.halt}`).join(" ");
  console.log(`거래정지 행 상위 5종목: ${haltTop}`);

  const mv = [...missing.values()];
  const bucketOf = (n: number): string => (n === 0 ? "0건" : n <= 5 ? "1~5건" : n <= 20 ? "6~20건" : n <= 100 ? "21~100건" : "101건 이상");
  const dist = new Map<string, number>(); for (const n of mv) dist.set(bucketOf(n), (dist.get(bucketOf(n)) ?? 0) + 1);
  const topMissing = [...missing.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n주가는 있는데 수급 행이 없는 날: 합계 ${mv.reduce((a, b) => a + b, 0)}일, 종목 ${mv.length}개`);
  console.log("| 종목당 건수 | 종목 수 |\n|---|---|");
  for (const k of ["0건", "1~5건", "6~20건", "21~100건", "101건 이상"]) console.log(`| ${k} | ${dist.get(k) ?? 0} |`);
  console.log(`최대: ${topMissing.slice(0, 5).map(([c, n]) => `${c} ${n}건`).join(", ")}`);

  const diffs: { code: string; d: number | null }[] = [];
  for (const [code] of byCode) { const days = priceDays.get(code); if (!days) continue; const f = nzFirst.get(code) ?? null; diffs.push({ code, d: f ? dayDiff(f, days[0]) : null }); }
  const cnt = (f: (d: number) => boolean): number => diffs.filter((x) => x.d !== null && f(x.d)).length;
  console.log("\n정리본 기준 종목별 '0이 아닌 첫 날짜' − 주가 첫 거래일(달력일)\n| 구간 | 종목 수 |\n|---|---|");
  console.log(`| 같은 날(0일) | ${cnt((d) => d === 0)} |\n| 1~5일 | ${cnt((d) => d >= 1 && d <= 5)} |\n| 6일 이상 | ${cnt((d) => d >= 6)} |\n|   (6~30일) | ${cnt((d) => d >= 6 && d <= 30)} |\n|   (31~365일) | ${cnt((d) => d >= 31 && d <= 365)} |\n|   (366일 이상) | ${cnt((d) => d > 365)} |\n| 0이 아닌 값 없음 | ${diffs.filter((x) => x.d === null).length} |\n| 음수(0이 아닌 값이 주가 첫날보다 이름) | ${cnt((d) => d < 0)} |`);
  const big = diffs.filter((x) => x.d !== null && x.d >= 6).sort((a, b) => (b.d as number) - (a.d as number)).slice(0, 5).map((x) => `${x.code} ${x.d}일`).join(", ");
  console.log(`6일 이상 중 상위 5: ${big || "없음"}`);

  // ---- 정리본 파일, Storage, DB ----
  const { data: files, error } = await bucket().list(INVESTOR_FLOW_STOCK_CLEAN_PREFIX, { limit: 1000 });
  if (error) throw new Error(`정리본 목록 실패: ${error.message}`);
  const sizeOf = new Map((files ?? []).map((f) => [f.name, Number((f.metadata as { size?: number } | null)?.size ?? 0)]));
  console.log("\n정리본 파일\n| 파일 | 크기 B | 행 수 |\n|---|---|---|");
  let tb = 0;
  for (const [y, rows] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) { const sz = sizeOf.get(`${y}.parquet`) ?? 0; tb += sz; console.log(`| ${y}.parquet | ${sz} | ${rows.length} |`); }
  console.log(`| 합계 | ${tb} (${mb(tb)} MiB) | ${clean.length} |`);
  const { data: bks } = await supabaseAdmin.storage.listBuckets();
  let files2 = 0, bytes2 = 0;
  console.log("\nStorage 총량\n| 버킷 | 파일 수 | 크기 B | MiB |\n|---|---|---|---|");
  for (const b of bks ?? []) { const acc = { files: 0, bytes: 0 }; await walk(b.name, "", acc); files2 += acc.files; bytes2 += acc.bytes; console.log(`| ${b.name} | ${acc.files} | ${acc.bytes} | ${mb(acc.bytes)} |`); }
  console.log(`| 합계 | ${files2} | ${bytes2} | ${mb(bytes2)} |`);
  const { data: rep, error: e2 } = await supabaseAdmin.rpc("research_storage_report");
  if (e2) throw new Error(`research_storage_report 실패: ${e2.message}`);
  const db = (rep as { db_bytes: number }).db_bytes;
  console.log(`DB 전체 ${db} B (${mb(db)} MiB), 기준 ${BASELINE_DB_BYTES} B 대비 ${db - BASELINE_DB_BYTES >= 0 ? "+" : ""}${db - BASELINE_DB_BYTES} B | 소요 ${((Date.now() - T0) / 1000).toFixed(1)}s`);
}
main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e); process.exit(1); });

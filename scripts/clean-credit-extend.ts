/**
 * [임시 연구 — 병합 금지, 외부 요청 0건, DB 쓰기 0] 신용잔고 2017~2026 원본(research/credit_balance/{2017..2026}.parquet)을 주가 Parquet의 종목별 거래일(종가>0)과
 * deal_date로 대조해 상장 전·폐지 후·거래정지 행을 뺀 정리본을 research/credit_balance_clean/{2017..2026}.parquet로 추가한다(원본·기존 정리본 2009~2016은 건드리지 않음).
 * 규칙은 scripts/clean-short-credit.ts와 같다. 사전 등록: research/credit-incremental-prereg.md 2단계 12항.
 */
import { parquetWriteBuffer } from "hyparquet-writer";
import { parquetReadObjects } from "hyparquet";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET } from "@/lib/investorFlowConfig";
import { SC_CREDIT_PREFIX, SC_CREDIT_CLEAN_PREFIX } from "@/lib/shortCreditCollectConfig";
import { CX_NEW_FIRST_YEAR, CX_LAST_YEAR, CX_TO, CX_PROGRESS_FILE } from "@/lib/creditExtendConfig";

const T0 = Date.now();
type Row = Record<string, string | number | null>;
const COLS: { name: string; type: "STRING" | "DOUBLE" }[] = [
  { name: "stock_code", type: "STRING" }, { name: "deal_date", type: "STRING" }, { name: "stlm_date", type: "STRING" }, { name: "whol_loan_rmnd_stcn", type: "DOUBLE" },
  { name: "whol_loan_rmnd_amt", type: "DOUBLE" }, { name: "whol_loan_rmnd_rate", type: "DOUBLE" }, { name: "whol_stln_rmnd_stcn", type: "DOUBLE" },
];
const VALUE_COLS = ["whol_loan_rmnd_stcn", "whol_loan_rmnd_amt", "whol_stln_rmnd_stcn"];
const MISSING_FROM = `${CX_NEW_FIRST_YEAR}-01-01`;
const bucket = (): ReturnType<typeof supabaseAdmin.storage.from> => supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET);
const mb = (b: number): string => (b / 1048576).toFixed(2);
function encode(rows: Row[]): ArrayBuffer {
  const list = [...rows].sort((a, b) => ((a.stock_code as string) < (b.stock_code as string) ? -1 : (a.stock_code as string) > (b.stock_code as string) ? 1 : (a.deal_date as string) < (b.deal_date as string) ? -1 : 1));
  return parquetWriteBuffer({ columnData: COLS.map((c) => c.type === "STRING" ? { name: c.name, data: list.map((r) => r[c.name] as string), type: "STRING" as const } : { name: c.name, data: list.map((r) => r[c.name] as number | null), type: "DOUBLE" as const, nullable: true }) });
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
  console.log(`신용잔고 2017~2026 정리 시작: ${new Date().toISOString()} (외부 요청 0, DB 쓰기 0)`);
  const series = await loadAllStockSeriesFromParquet(2010, CX_LAST_YEAR);
  const priceDays = new Map<string, string[]>();
  for (const [code, rows] of series) { const days = rows.filter((r) => r.closePrice > 0).map((r) => r.tradeDate).sort(); if (days.length) priceDays.set(code, days); }
  series.clear();

  const orig: Row[] = [];
  let origBytes = 0;
  for (let y = CX_NEW_FIRST_YEAR; y <= CX_LAST_YEAR; y++) {
    const { data, error } = await bucket().download(`${SC_CREDIT_PREFIX}/${y}.parquet`);
    if (error) { console.log(`원본 ${y}.parquet 없음`); continue; }
    const buf = await data.arrayBuffer(); origBytes += buf.byteLength;
    for (const r of (await parquetReadObjects({ file: buf })) as Row[]) orig.push(r);
  }
  const progRes = await bucket().download(`${SC_CREDIT_PREFIX}/${CX_PROGRESS_FILE}`);
  const prog = JSON.parse(new TextDecoder().decode(await progRes.data!.arrayBuffer())) as { requestsTotal: number; stocks: Record<string, { done: boolean; skipped: boolean }>; dbBaselineBytes: number | null; overlap: { match: number; mismatch: number; notInExisting: number }; stlmOrderViolations: number; runs: { requests: number; rows: number; errors: number; rlEvents: number; rlRetries: number; rlWaitSec: number; stop: string; startedAt: string }[] };
  const poolAll = Object.keys(prog.stocks).sort();
  const pool = poolAll.filter((c) => !prog.stocks[c].skipped);
  console.log(`원본(2017~2026) ${orig.length}행, 종목 ${new Set(orig.map((r) => r.stock_code)).size}개, 다운로드 ${origBytes} B | 진행 파일: 대상 ${poolAll.length}종목(요청 대상 ${pool.length}, 기간 겹침 없음 ${poolAll.length - pool.length}), 완료 ${Object.values(prog.stocks).filter((x) => x.done).length}, 누적 요청 ${prog.requestsTotal}, 결제일 비단조 ${prog.stlmOrderViolations}, 2016-12 대조 일치 ${prog.overlap.match}·불일치 ${prog.overlap.mismatch}·기존에 없음 ${prog.overlap.notInExisting}`);
  console.log("회차별(진행 파일 기록)\n| 회차 | 시작 | 요청 | 저장 행 | 오류 | rate limit 응답 | 재시도 | 대기 초 | 중단 사유 |\n|---|---|---|---|---|---|---|---|---|");
  prog.runs.forEach((r, i) => console.log(`| ${i + 1} | ${r.startedAt} | ${r.requests} | ${r.rows} | ${r.errors} | ${r.rlEvents} | ${r.rlRetries} | ${r.rlWaitSec} | ${r.stop} |`));

  const byCode = new Map<string, Row[]>();
  for (const r of orig) { const a = byCode.get(r.stock_code as string); if (a) a.push(r); else byCode.set(r.stock_code as string, [r]); }
  const clean: Row[] = [];
  const excl = { pre: 0, post: 0, halt: 0, noPrice: 0, notInPool: 0 };
  const missing = new Map<string, number>();
  const noRow: string[] = [], allZero: string[] = [];
  const poolSet = new Set(pool);
  for (const [code, rows] of byCode) if (!poolSet.has(code)) excl.notInPool += rows.length;
  for (const code of pool) {
    const days = priceDays.get(code);
    const rows = byCode.get(code) ?? [];
    if (!days) { excl.noPrice += rows.length; continue; }
    const set = new Set(days), first = days[0], last = days[days.length - 1];
    const kept: Row[] = [];
    for (const r of rows) { const d = r.deal_date as string; if (set.has(d)) kept.push(r); else if (d < first) excl.pre++; else if (d > last) excl.post++; else excl.halt++; }
    if (!rows.length) noRow.push(code);
    if (kept.length && kept.every((r) => VALUE_COLS.every((c) => ((r[c] as number | null) ?? 0) === 0))) allZero.push(code);
    const have = new Set(kept.map((r) => r.deal_date as string));
    missing.set(code, days.filter((d) => d >= MISSING_FROM && d <= CX_TO && !have.has(d)).length);
    for (const r of kept) clean.push(r);
  }
  const byYear = new Map<number, Row[]>();
  for (const r of clean) { const y = Number((r.deal_date as string).slice(0, 4)); const a = byYear.get(y); if (a) a.push(r); else byYear.set(y, [r]); }
  for (const [y, rows] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    if (y < CX_NEW_FIRST_YEAR) throw new Error(`정리본 연도 ${y}는 2017 이전 — 기존 파일을 건드리지 않기 위해 중단`);
    const { error } = await bucket().upload(`${SC_CREDIT_CLEAN_PREFIX}/${y}.parquet`, encode(rows), { contentType: "application/octet-stream", upsert: true });
    if (error) throw new Error(`정리본 업로드 실패 ${y}: ${error.message}`);
  }

  console.log(`\n| 구분 | 행 수 |\n|---|---|\n| 원본(2017~2026) | ${orig.length} |\n| 제외: 상장 전(첫 주가일 이전) | ${excl.pre} |\n| 제외: 폐지 후(마지막 주가일 이후) | ${excl.post} |\n| 제외: 거래정지 등(첫~마지막 주가일 사이 주가 없는 날) | ${excl.halt} |\n| 제외: 주가 자료 없는 종목 | ${excl.noPrice} |\n| 제외: 진행 파일 대상 밖 종목 | ${excl.notInPool} |\n| 남은 행(정리본) | ${clean.length} |`);
  const mv = [...missing.values()];
  const bk = (n: number): string => (n === 0 ? "0건" : n <= 5 ? "1~5건" : n <= 20 ? "6~20건" : n <= 100 ? "21~100건" : "101건 이상");
  const dist = new Map<string, number>(); for (const n of mv) dist.set(bk(n), (dist.get(bk(n)) ?? 0) + 1);
  const tot = mv.reduce((a, b) => a + b, 0);
  let priceDayTotal = 0; for (const code of pool) priceDayTotal += (priceDays.get(code) ?? []).filter((d) => d >= MISSING_FROM && d <= CX_TO).length;
  console.log(`\n주가는 있는데 신용잔고 행이 없는 날(${MISSING_FROM}~${CX_TO} 주가 거래일 기준): 합계 ${tot}일 / 주가 종목-일 ${priceDayTotal} (${((tot / Math.max(priceDayTotal, 1)) * 100).toFixed(2)}%), 종목 ${mv.length}개`);
  console.log("| 종목당 건수 | 종목 수 |\n|---|---|");
  for (const k of ["0건", "1~5건", "6~20건", "21~100건", "101건 이상"]) console.log(`| ${k} | ${dist.get(k) ?? 0} |`);
  console.log(`최대: ${[...missing.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, n]) => `${c} ${n}건`).join(", ")}`);
  // 빈 날이 어느 날짜에 몰리는지(상위 10개 날짜)
  const byDate = new Map<string, number>();
  for (const code of pool) { const days = priceDays.get(code); if (!days) continue; const have = new Set((byCode.get(code) ?? []).map((r) => r.deal_date as string)); for (const d of days) if (d >= MISSING_FROM && d <= CX_TO && !have.has(d)) byDate.set(d, (byDate.get(d) ?? 0) + 1); }
  console.log(`빈 날이 많은 날짜 상위 10: ${[...byDate.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([d, n]) => `${d} ${n}종목`).join(", ")}`);
  console.log(`원본 행이 하나도 없는 종목(요청 대상 중) ${noRow.length}개${noRow.length && noRow.length <= 40 ? ": " + noRow.join(",") : ""}`);
  console.log(`값이 전부 0인 종목(${VALUE_COLS.join("·")} 모두 0 또는 null, 정리본 행이 있는 종목 중) ${allZero.length}개${allZero.length && allZero.length <= 40 ? ": " + allZero.join(",") : ""}`);

  const { data: files, error } = await bucket().list(SC_CREDIT_CLEAN_PREFIX, { limit: 1000 });
  if (error) throw new Error(`정리본 목록 실패: ${error.message}`);
  const sizeOf = new Map((files ?? []).map((f) => [f.name, Number((f.metadata as { size?: number } | null)?.size ?? 0)]));
  console.log(`\n정리본 파일 (${SC_CREDIT_CLEAN_PREFIX}, 이번에 추가한 2017~2026)\n| 파일 | 크기 B | 행 수 |\n|---|---|---|`);
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
  const db = (rep as { db_bytes: number }).db_bytes, base = prog.dbBaselineBytes;
  console.log(`DB 전체 ${db} B (${mb(db)} MiB), 2단계 첫 회차 시작 기준 ${base} B 대비 ${base === null ? "-" : `${db - base >= 0 ? "+" : ""}${db - base} B`} | 소요 ${((Date.now() - T0) / 1000).toFixed(1)}s`);
}
main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e); process.exit(1); });

/**
 * [연구용 — 병합 금지] 신호 스캔 5회차 수집: 5-A 외국계 창구 일별 매매(inquire-member-daily, 회원사 코드 99999, 종목별) 학습 구간 2011-01-03~2016-12-31,
 * 5-B 대차잔고(daily-loan-trans, 종목 단위) 학습 구간 2015-01-01~2019-12-31. 대상: 420종목(수급 수집과 같은 월말 PIT 시총 상위 150 이력, 상장폐지 포함) 중 구간에 가격이 있는 종목.
 * 사전등록 docs/research/signal-scan-5-prereg.md, 수집 계획 docs/research/signal-scan-5-collection-plan.md. 공시(DART) 사용 없음, 연구 DB 쓰기 0(Storage Parquet만).
 * SCAN5_MODE=pilot: 호출 약 10회를 메모리로만 받아 호출당 행 수·방향·키·점검 값을 출력(Storage 쓰기 0, 읽기는 수급 진행 파일 약 24 KB). fm|loan: 이어받기 수집 → 완료되면 정리본·점검·Storage 업로드·Actions 캐시용 디렉터리.
 * 14:00~15:40 KST 호출 금지, 단일 워커 순차 호출, rate limit 5/15/60초 재시도, 요청 누적 상한 = 중심값 × 1.3. 키 값 출력 금지, 응답 본문은 요약만.
 * 응답은 (종목, 기간 범위)에서 최근 쪽 행부터 준다는 가정(대차는 확정, 외국계는 파일럿에서 확인)으로 가장 이른 날 − 1일로 끝을 옮겨 가며 받는다.
 */
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { parquetWriteBuffer } from "hyparquet-writer";
import { parquetReadObjects } from "hyparquet";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { kisGetForResearch, getKisCallStats } from "@/lib/kis";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET, INVESTOR_FLOW_TOP_N, INVESTOR_FLOW_ENDED_GRACE_DAYS, INVESTOR_FLOW_CONSEC_ERROR_STOP, INVESTOR_FLOW_ERROR_RETRY_MS } from "@/lib/investorFlowConfig";
import { SC_COLLECT_BLOCK_UTC_FROM_MIN, SC_COLLECT_BLOCK_UTC_TO_MIN, SC_COLLECT_RL_WAITS_MS, SC_COLLECT_RL_WINDOW_MS, SC_COLLECT_RL_WINDOW_MAX, SC_COLLECT_LOG_EVERY_REQ } from "@/lib/shortCreditCollectConfig";
import {
  S5_FM_FROM, S5_FM_TO, S5_LOAN_FROM, S5_LOAN_TO, S5_FM_PATH, S5_FM_TR, S5_FM_MEMBER, S5_FM_PAGE_ROWS, S5_LOAN_PATH, S5_LOAN_TR, S5_LOAN_MKT_DIV, S5_LOAN_PAGE_ROWS,
  S5_REQUEST_CAP_FACTOR, S5_RUN_MAX_MS, S5_CHECKPOINT_STOCKS, S5_CHECKPOINT_MS, S5_STORAGE_CAP_BYTES, S5_FM_WRITE_BUDGET_BYTES, S5_LOAN_WRITE_BUDGET_BYTES, S5_FMC_FROM, S5_FMC_TO, S5_FMC_PREFIX, S5_FMC_CLEAN_PREFIX, S5_CACHE_DIR_FMC, S5_FMC_WRITE_BUDGET_BYTES, S5_FMH_FROM, S5_FMH_TO, S5_FMH_PREFIX, S5_FMH_CLEAN_PREFIX, S5_CACHE_DIR_FMH, S5_FMH_WRITE_BUDGET_BYTES,
  S5_FM_PREFIX, S5_FM_CLEAN_PREFIX, S5_LOAN_PREFIX, S5_LOAN_CLEAN_PREFIX, S5_PROGRESS_FILE, S5_FLOW_STOCK_PROGRESS_PATH, S5_CACHE_DIR_FM, S5_CACHE_DIR_LOAN,
  S5_NTBY_IDENTITY_MAX_RATIO, S5_CLOSE_TOL, S5_CLOSE_MIN_SHARE, S5_MAX_ALL_ZERO_STOCK_RATIO, S5_MAX_MISSING_DAY_RATIO,
} from "@/lib/scan5Config";

const T0 = Date.now();
const MS_DAY = 86_400_000;
const MODE = (process.env.SCAN5_MODE ?? "").trim().toLowerCase();
if (!["pilot", "fm", "loan", "fmc", "fmh"].includes(MODE)) throw new Error("SCAN5_MODE=pilot|fm|loan|fmc|fmh 필요");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const kst = (d = new Date()): string => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(11, 19);
const iso = (d: string): string => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const ymd = (d: string): string => d.replace(/-/g, "");
const addDay = (d: string, n: number): string => new Date(Date.parse(d) + n * MS_DAY).toISOString().slice(0, 10);
const num = (v: unknown): number | null => { const s = String(v ?? "").trim(); if (s === "") return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const mib = (b: number): string => (b / 1048576).toFixed(2);
type Rec = Record<string, unknown>;
type Row = Record<string, string | number | null>;
const io = { readBytes: 0, writeBytes: 0, reads: 0, writes: 0 };

// ---------------- 데이터셋 정의 ----------------
interface ColDef { name: string; type: "STRING" | "DOUBLE" }
interface Spec {
  id: "fm" | "loan"; label: string; from: string; to: string; path: string; tr: string; pageRows: number | null;
  paramsOf: (code: string, lo: string, hi: string) => Record<string, string>;
  pick: (body: Rec) => Rec[]; dateField: string;
  rowOf: (code: string, d: string, r: Rec) => Row; cols: ColDef[]; valueCols: string[];
  prefix: string; cleanPrefix: string; cacheDir: string; writeBudget: number;
}
const strCols: ColDef[] = [{ name: "stock_code", type: "STRING" }, { name: "trade_date", type: "STRING" }];
const dbl = (names: string[]): ColDef[] => names.map((n) => ({ name: n, type: "DOUBLE" as const }));
const FM: Spec = {
  id: "fm", label: "외국계 창구", from: S5_FM_FROM, to: S5_FM_TO, path: S5_FM_PATH, tr: S5_FM_TR, pageRows: S5_FM_PAGE_ROWS,
  paramsOf: (code, lo, hi) => ({ FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code, FID_INPUT_ISCD_2: S5_FM_MEMBER, FID_INPUT_DATE_1: ymd(lo), FID_INPUT_DATE_2: ymd(hi), FID_SCTN_CLS_CODE: "" }),
  pick: (b) => ((b.output ?? b.output1 ?? b.output2) as Rec[] | undefined) ?? [], dateField: "stck_bsop_date",
  rowOf: (code, d, r) => ({ stock_code: code, trade_date: d, shnu_qty: num(r.total_shnu_qty), seln_qty: num(r.total_seln_qty), ntby_qty: num(r.ntby_qty), close: num(r.stck_prpr) }),
  cols: [...strCols, ...dbl(["shnu_qty", "seln_qty", "ntby_qty", "close"])], valueCols: ["shnu_qty", "seln_qty", "ntby_qty", "close"],
  prefix: S5_FM_PREFIX, cleanPrefix: S5_FM_CLEAN_PREFIX, cacheDir: S5_CACHE_DIR_FM, writeBudget: S5_FM_WRITE_BUDGET_BYTES,
};
const LOAN: Spec = {
  id: "loan", label: "대차잔고", from: S5_LOAN_FROM, to: S5_LOAN_TO, path: S5_LOAN_PATH, tr: S5_LOAN_TR, pageRows: S5_LOAN_PAGE_ROWS,
  paramsOf: (code, lo, hi) => ({ MRKT_DIV_CLS_CODE: S5_LOAN_MKT_DIV, MKSC_SHRN_ISCD: code, START_DATE: ymd(lo), END_DATE: ymd(hi), CTS: "" }),
  pick: (b) => ((b.output1 ?? b.output ?? b.output2) as Rec[] | undefined) ?? [], dateField: "bsop_date",
  rowOf: (code, d, r) => ({ stock_code: code, trade_date: d, new_stcn: num(r.new_stcn), rdmp_stcn: num(r.rdmp_stcn), prdy_rmnd_vrss: num(r.prdy_rmnd_vrss), rmnd_stcn: num(r.rmnd_stcn), rmnd_amt: num(r.rmnd_amt) }),
  cols: [...strCols, ...dbl(["new_stcn", "rdmp_stcn", "prdy_rmnd_vrss", "rmnd_stcn", "rmnd_amt"])], valueCols: ["new_stcn", "rdmp_stcn", "prdy_rmnd_vrss", "rmnd_stcn", "rmnd_amt"],
  prefix: S5_LOAN_PREFIX, cleanPrefix: S5_LOAN_CLEAN_PREFIX, cacheDir: S5_CACHE_DIR_LOAN, writeBudget: S5_LOAN_WRITE_BUDGET_BYTES,
};

// ---------------- Storage ----------------
const bucket = (): ReturnType<typeof supabaseAdmin.storage.from> => supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET);
async function download(p: string): Promise<ArrayBuffer | null> {
  const { data, error } = await bucket().download(p);
  if (error) { if (/not found|404|Object not found/i.test(error.message)) return null; throw new Error(`Storage 다운로드 실패 ${p}: ${error.message}`); }
  const buf = await data.arrayBuffer();
  io.readBytes += buf.byteLength; io.reads++;
  return buf;
}
async function upload(p: string, body: ArrayBuffer | Uint8Array): Promise<void> {
  let lastMsg = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const { error } = await bucket().upload(p, body, { contentType: "application/octet-stream", upsert: true });
    if (!error) { io.writeBytes += body.byteLength; io.writes++; return; }
    lastMsg = error.message;
    console.log(`  [Storage 업로드 재시도 ${attempt + 1}/4] ${p}: ${lastMsg || "<none>"}`);
    await sleep(3_000 * 2 ** attempt);
  }
  throw new Error(`Storage 업로드 실패 ${p}: ${lastMsg}`);
}
async function walk(b: string, prefix: string, acc: { bytes: number }): Promise<void> {
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabaseAdmin.storage.from(b).list(prefix, { limit: 1000, offset });
    if (error) throw new Error(`${b}/${prefix} 목록 실패: ${error.message}`);
    for (const e of data ?? []) { if (e.id === null) await walk(b, prefix ? `${prefix}/${e.name}` : e.name, acc); else acc.bytes += Number((e.metadata as { size?: number } | null)?.size ?? 0); }
    if (!data || data.length < 1000) break;
  }
}
async function storageTotal(): Promise<number> {
  const { data, error } = await supabaseAdmin.storage.listBuckets();
  if (error) throw new Error(`버킷 목록 실패: ${error.message}`);
  const acc = { bytes: 0 };
  for (const b of data ?? []) await walk(b.name, "", acc);
  return acc.bytes;
}
function encode(cols: ColDef[], rows: Row[]): ArrayBuffer {
  const list = [...rows].sort((a, b) => ((a.stock_code as string) < (b.stock_code as string) ? -1 : (a.stock_code as string) > (b.stock_code as string) ? 1 : (a.trade_date as string) < (b.trade_date as string) ? -1 : 1));
  return parquetWriteBuffer({ columnData: cols.map((c) => c.type === "STRING" ? { name: c.name, data: list.map((r) => r[c.name] as string), type: "STRING" as const } : { name: c.name, data: list.map((r) => r[c.name] as number | null), type: "DOUBLE" as const, nullable: true }) });
}
const byYear = (rows: Row[]): Map<number, Row[]> => { const m = new Map<number, Row[]>(); for (const r of rows) { const y = Number(String(r.trade_date).slice(0, 4)); const a = m.get(y); if (a) a.push(r); else m.set(y, [r]); } return m; };

// ---------------- 진행 상태 ----------------
interface StockState { cursor: string | null; done: boolean; rows: number; requests: number }
interface RunLog { startedAt: string; requests: number; completed: number; newRows: number; errors: number; rlEvents: number; stop: string }
interface Progress { requestsTotal: number; stocks: Record<string, StockState>; runs: RunLog[]; errorsTotal: number }
const progress: Progress = { requestsTotal: 0, stocks: {}, runs: [], errorsTotal: 0 };
const rowsMap = new Map<string, Row>(); // key stock|date
const dirtyYears = new Set<number>();
const run = { req: 0, newRows: 0, errors: 0, consec: 0, rlEvents: 0, rlTimes: [] as number[], rlRetries: 0, rlWaitMs: 0, completed: 0, failedCalls: [] as string[], dirAnomaly: 0 };
let stopReason: string | null = null;
let requestCap = Number.POSITIVE_INFINITY;
let lastLog = 0, lastCheckpoint = Date.now(), doneSinceCheckpoint = 0;
const persist = MODE === "fm" || MODE === "loan" || MODE === "fmc" || MODE === "fmh";
// 확인 점검(fmc)·보류(fmh): 외국계 창구 같은 TR·같은 정리 규칙, 구간·저장 경로만 다르다(학습 구간 저장본은 덮어쓰지 않는다).
const FMC: Spec = { ...FM, from: S5_FMC_FROM, to: S5_FMC_TO, prefix: S5_FMC_PREFIX, cleanPrefix: S5_FMC_CLEAN_PREFIX, cacheDir: S5_CACHE_DIR_FMC, writeBudget: S5_FMC_WRITE_BUDGET_BYTES };
const FMH: Spec = { ...FM, from: S5_FMH_FROM, to: S5_FMH_TO, prefix: S5_FMH_PREFIX, cleanPrefix: S5_FMH_CLEAN_PREFIX, cacheDir: S5_CACHE_DIR_FMH, writeBudget: S5_FMH_WRITE_BUDGET_BYTES };
const spec: Spec = MODE === "loan" ? LOAN : MODE === "fmc" ? FMC : MODE === "fmh" ? FMH : FM;

async function loadStored(): Promise<void> {
  const p = await download(`${spec.prefix}/${S5_PROGRESS_FILE}`);
  if (p) Object.assign(progress, JSON.parse(new TextDecoder().decode(p)) as Progress);
  for (let y = Number(spec.from.slice(0, 4)); y <= Number(spec.to.slice(0, 4)); y++) {
    const b = await download(`${spec.prefix}/${y}.parquet`);
    if (b) for (const r of (await parquetReadObjects({ file: b })) as Row[]) rowsMap.set(`${r.stock_code}|${r.trade_date}`, r);
  }
  console.log(`저장된 진행: 종목 ${Object.keys(progress.stocks).length}개(완료 ${Object.values(progress.stocks).filter((s) => s.done).length}), 누적 요청 ${progress.requestsTotal}, 저장 행 ${rowsMap.size}, 읽은 ${mib(io.readBytes)} MiB`);
}
async function checkpoint(why: string): Promise<void> {
  if (!persist) return;
  const by = byYear([...rowsMap.values()]);
  for (const y of [...dirtyYears].sort()) await upload(`${spec.prefix}/${y}.parquet`, encode(spec.cols, by.get(y) ?? []));
  dirtyYears.clear();
  await upload(`${spec.prefix}/${S5_PROGRESS_FILE}`, new TextEncoder().encode(JSON.stringify(progress)));
  lastCheckpoint = Date.now(); doneSinceCheckpoint = 0;
  console.log(`  [저장] ${why}: 누적 요청 ${progress.requestsTotal}, 저장 행 ${rowsMap.size}, 이번 회차 쓴 ${mib(io.writeBytes)} MiB, KST ${kst()}`);
  if (io.writeBytes > spec.writeBudget * 3) stopReason = "쓰기 누적 예산 초과";
}

// ---------------- KIS ----------------
async function waitIfBlocked(): Promise<void> {
  for (;;) {
    const n = new Date(), m = n.getUTCHours() * 60 + n.getUTCMinutes();
    if (m >= SC_COLLECT_BLOCK_UTC_FROM_MIN && m < SC_COLLECT_BLOCK_UTC_TO_MIN) {
      if (Date.now() - T0 >= S5_RUN_MAX_MS) return;
      console.log(`  [대기] KST ${kst()} — 14:00~15:40 호출 금지 시간대, 30초 후 재확인`); await sleep(30_000);
    } else return;
  }
}
function stopCheck(): boolean {
  if (stopReason) return true;
  if (Date.now() - T0 >= S5_RUN_MAX_MS) stopReason = "회차 시간 상한";
  else if (progress.requestsTotal >= requestCap) stopReason = "요청 누적 상한";
  return stopReason !== null;
}
const isRateLimitMsg = (msg: string): boolean => /EGW00201|rate\s*limit|too\s*many|초당|429/i.test(msg);
async function callKis(label: string, s: Spec, params: Record<string, string>): Promise<Rec[] | null> {
  for (let rl = 0; ; rl++) {
    await waitIfBlocked();
    if (stopCheck()) return null;
    const r0 = getKisCallStats().total;
    try {
      const body = await kisGetForResearch(s.path, s.tr, params, 0);
      run.consec = 0;
      const d = getKisCallStats().total - r0; run.req += d; progress.requestsTotal += d;
      return s.pick(body as Rec);
    } catch (e) {
      const d = getKisCallStats().total - r0; run.req += d; progress.requestsTotal += d;
      const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
      if (!/time\s*limit/i.test(msg) && isRateLimitMsg(msg)) {
        const now = Date.now(); run.rlEvents++; run.rlTimes.push(now);
        while (run.rlTimes.length && now - run.rlTimes[0] > SC_COLLECT_RL_WINDOW_MS) run.rlTimes.shift();
        console.log(`  [rate limit KST ${kst()}] ${label}: ${msg} (이번 요청 ${rl + 1}번째 실패, 최근 10분 ${run.rlTimes.length}회)`);
        if (run.rlTimes.length >= SC_COLLECT_RL_WINDOW_MAX) { stopReason = `rate limit 10분 안에 ${run.rlTimes.length}회`; return null; }
        if (rl >= SC_COLLECT_RL_WAITS_MS.length) { stopReason = `rate limit ${SC_COLLECT_RL_WAITS_MS.length}회 연속 재시도 실패`; return null; }
        const w = SC_COLLECT_RL_WAITS_MS[rl]; run.rlRetries++; run.rlWaitMs += w;
        await sleep(w);
        continue;
      }
      run.errors++; run.consec++; progress.errorsTotal++; run.failedCalls.push(`${label}: ${msg.slice(0, 80)}`);
      console.log(`  [오류 KST ${kst()}] ${label}: ${msg} (연속 ${run.consec})`);
      if (/time\s*limit/i.test(msg)) stopReason = "TIME LIMIT 응답";
      else if (run.consec >= INVESTOR_FLOW_CONSEC_ERROR_STOP) stopReason = `연속 오류 ${INVESTOR_FLOW_CONSEC_ERROR_STOP}건`;
      if (!stopReason) await sleep(INVESTOR_FLOW_ERROR_RETRY_MS);
      return null;
    }
  }
}

/** 종목 하나: [lo, hi]에서 가장 이른 날 − 1일로 끝을 옮겨 가며 받는다(응답은 최근 쪽 행부터). 끝 조건: 가장 이른 날 ≤ lo, 빈 응답, 응답 행 수 < 호출당 행 수. */
async function collectStock(code: string, lo: string, hi: string, priceDays: Map<string, unknown>, sink: Map<string, Row>, dirty: Set<number>): Promise<boolean> {
  const st = progress.stocks[code] ?? { cursor: null, done: false, rows: 0, requests: 0 };
  progress.stocks[code] = st;
  if (st.done) return true;
  let anchor = st.cursor ? addDay(st.cursor, -1) : hi;
  let first = !st.cursor;
  for (;;) {
    if (anchor < lo) { st.done = true; return true; }
    const out = await callKis(`${spec.label} ${code} ${lo}~${anchor}`, spec, spec.paramsOf(code, lo, anchor));
    if (out === null) { if (stopReason) return false; continue; }
    st.requests++;
    const mapped = out.filter((r) => r[spec.dateField]).map((r) => ({ d: iso(String(r[spec.dateField])), r }));
    if (first && mapped.length) {
      // 방향 가정 점검: 첫 응답의 최신 날짜가 조회 끝(가격 구간 끝) 가까이에 있어야 한다(거래정지 등 예외는 건수만 센다).
      const newest = mapped.reduce((a, b) => (b.d > a ? b.d : a), mapped[0].d);
      const lastPrice = [...priceDays.keys()].filter((d) => d <= hi).sort().pop() ?? hi;
      if (Date.parse(lastPrice) - Date.parse(newest) > 30 * MS_DAY) { run.dirAnomaly++; console.log(`  [방향 점검] ${code}: 첫 응답 최신 ${newest}, 가격 마지막 ${lastPrice} (이상 ${run.dirAnomaly}건)`); if (run.dirAnomaly >= 10) { stopReason = "응답 방향(최근 쪽 행부터) 가정 위반 10건"; return false; } }
    }
    first = false;
    for (const m of mapped) {
      if (m.d < lo || m.d > anchor) continue;
      const key = `${code}|${m.d}`;
      if (!sink.has(key)) { run.newRows++; st.rows++; }
      sink.set(key, spec.rowOf(code, m.d, m.r));
      dirty.add(Number(m.d.slice(0, 4)));
    }
    const oldest = mapped.length ? mapped.reduce((a, b) => (b.d < a ? b.d : a), mapped[0].d) : null;
    if (oldest) st.cursor = st.cursor && st.cursor < oldest ? st.cursor : oldest;
    if (!oldest || (spec.pageRows !== null && out.length < spec.pageRows) || oldest <= lo) { st.done = true; return true; }
    const next = addDay(oldest, -1);
    if (next >= anchor) { st.done = true; return true; }
    anchor = next;
    if (run.req - lastLog >= SC_COLLECT_LOG_EVERY_REQ) { lastLog = run.req; console.log(`  진행: 요청 ${run.req}(누적 ${progress.requestsTotal}), 종목 ${code} 최오래 ${oldest}, 이번 회차 완료 ${run.completed}종목, KST ${kst()}, 경과 ${((Date.now() - T0) / 60e3).toFixed(0)}분`); }
  }
}

async function main(): Promise<void> {
  console.log(`신호 스캔 5회차 수집(${MODE}) 시작: ${new Date().toISOString()} (KST ${kst()}) | 구간 ${spec.from}~${spec.to}${MODE === "pilot" ? "(파일럿은 호출 약 10회)" : ""} | 회차 상한 ${(S5_RUN_MAX_MS / 3600e3).toFixed(2)}시간`);
  const storageStart = persist ? await storageTotal() : 0;
  if (persist) {
    if (spec.pageRows === null) throw new Error(`${spec.label} 호출당 행 수 상수(lib/scan5Config.ts)가 null이다 — 파일럿 결과로 정해 커밋한 뒤 수집한다`);
    console.log(`Storage 총량(시작): ${mib(storageStart)} MiB / 상한 ${mib(S5_STORAGE_CAP_BYTES)} MiB`); await loadStored();
  }

  // ---- 대상 420종목 (collect-scan4a.ts와 같은 규칙) ----
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear());
  const calSet = new Set<string>(); let lastDate = "";
  for (const rows of series.values()) for (const r of rows) { if (r.tradeDate >= "2010-01-01") calSet.add(r.tradeDate); if (r.tradeDate > lastDate) lastDate = r.tradeDate; }
  const cal = [...calSet].sort();
  const monthEnd = new Set<string>();
  for (let k = 0; k + 1 < cal.length; k++) if (cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7)) monthEnd.add(cal[k]);
  const mcapAt = new Map<string, { code: string; mc: number }[]>();
  const lastRow = new Map<string, string>(), firstRow = new Map<string, string>();
  for (const [code, rows] of series) {
    for (const r of rows) {
      if (r.tradeDate < "2010-01-01") continue;
      if (monthEnd.has(r.tradeDate)) { const a = mcapAt.get(r.tradeDate) ?? []; a.push({ code, mc: r.marketCapEok }); mcapAt.set(r.tradeDate, a); }
      lastRow.set(code, r.tradeDate); if (!firstRow.has(code)) firstRow.set(code, r.tradeDate);
    }
  }
  const everTop = new Set<string>();
  for (const [, arr] of mcapAt) { arr.sort((a, b) => b.mc - a.mc || (a.code < b.code ? -1 : 1)); for (const x of arr.slice(0, INVESTOR_FLOW_TOP_N)) everTop.add(x.code); }
  const pool = [...everTop].sort();
  /** code -> date -> { 원 거래량, 원주가 종가 } (종가 > 0인 날만) */
  const priceDays = new Map<string, Map<string, { vol: number; close: number }>>();
  for (const code of pool) { const m = new Map<string, { vol: number; close: number }>(); for (const r of series.get(code) ?? []) if (r.closePrice > 0 && r.tradeDate >= "2010-01-01") m.set(r.tradeDate, { vol: r.volume, close: r.closePrice }); priceDays.set(code, m); }
  series.clear();
  const endedBefore = new Date(Date.parse(lastDate) - INVESTOR_FLOW_ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  const isDelisted = (c: string): boolean => (lastRow.get(c) ?? "9999") < endedBefore;
  const winOf = (c: string, s: Spec = spec): { lo: string; hi: string } | null => {
    const first = firstRow.get(c) as string, last = lastRow.get(c) as string;
    const lo = first > s.from ? first : s.from, hi = last < s.to ? last : s.to;
    return lo > hi ? null : { lo, hi };
  };
  const active = pool.filter((c) => winOf(c) !== null);
  console.log(`대상 ${pool.length}종목(상장폐지 ${pool.filter(isDelisted).length}개), 수집 기간과 주가 구간이 겹치는 종목 ${active.length}개, 가격 스냅샷 마지막 날 ${lastDate}`);
  const fp = await download(S5_FLOW_STOCK_PROGRESS_PATH);
  if (fp) {
    const set = new Set(Object.keys((JSON.parse(new TextDecoder().decode(fp)) as { stocks: Record<string, unknown> }).stocks));
    const onlyHere = pool.filter((c) => !set.has(c)), onlyThere = [...set].filter((c) => !pool.includes(c));
    console.log(`대상 집합 대조(수급 수집 진행 파일 ${set.size}종목): 이번에만 ${onlyHere.length}개${onlyHere.length ? `(${onlyHere.slice(0, 10).join(",")})` : ""}, 수급 쪽에만 ${onlyThere.length}개${onlyThere.length ? `(${onlyThere.slice(0, 10).join(",")})` : ""} → ${onlyHere.length === 0 && onlyThere.length === 0 ? "같음" : "다름(수급 쪽은 552종목 파일이면 정상: 사전등록 7절 대조 결과로 보고)"}`);
  } else console.log("수급 수집 진행 파일 없음 — 대조 생략");

  // ================= 파일럿 =================
  if (MODE === "pilot") {
    const tradingDays = (c: string, lo: string, hi: string): string[] => [...(priceDays.get(c)?.keys() ?? [])].filter((d) => d >= lo && d <= hi).sort();
    const probe = async (label: string, s: Spec, code: string, lo: string, hi: string, showKeys = false): Promise<Rec[] | null> => {
      progress.stocks[`${s.id}|${code}|${lo}|${hi}`] = { cursor: null, done: false, rows: 0, requests: 0 };
      const out = await callKis(`파일럿 ${label}`, s, s.paramsOf(code, lo, hi));
      if (out === null) { console.log(`  [파일럿 ${label}] 호출 실패/중단: ${stopReason ?? "오류"}`); return null; }
      const ds = out.filter((r) => r[s.dateField]).map((r) => iso(String(r[s.dateField]))).sort();
      const exp = tradingDays(code, lo, hi);
      const newest = ds[ds.length - 1] ?? "-", oldest = ds[0] ?? "-";
      console.log(`  [파일럿 ${label}] 요청 ${code} ${lo}~${hi}: 응답 ${out.length}행, 날짜 ${oldest}~${newest} | 가격 거래일 ${exp.length}일(${exp[0] ?? "-"}~${exp[exp.length - 1] ?? "-"}) | 최근 쪽 끝 일치 ${exp.length ? (newest === exp[exp.length - 1] ? "예" : "아니오") : "-"}, 이른 쪽 끝 일치 ${exp.length ? (oldest === exp[0] ? "예" : "아니오") : "-"}, 가격 거래일 중 응답에 없는 날 ${exp.filter((d) => !ds.includes(d)).length}${showKeys && out[0] ? ` | 키 ${Object.keys(out[0]).join(",")}` : ""}`);
      if (s.id === "fm" && out.length) {
        const pd = priceDays.get(code) as Map<string, { vol: number; close: number }>;
        let idBad = 0, closeOk = 0, closeN = 0; const sh: number[] = [];
        for (const r of out) {
          const d = iso(String(r[s.dateField])), b = num(r.total_shnu_qty), q = num(r.total_seln_qty), n = num(r.ntby_qty), c = num(r.stck_prpr);
          if (b !== null && q !== null && n !== null && b - q !== n) idBad++;
          const p = pd.get(d); if (p && c !== null) { closeN++; if (Math.abs(c / p.close - 1) <= S5_CLOSE_TOL) closeOk++; }
          if (p && p.vol > 0 && b !== null && q !== null) sh.push((b + q) / p.vol);
        }
        sh.sort((a, b) => a - b);
        console.log(`    순매수 항등(매수−매도=순매수) 불일치 ${idBad}행 | 응답 종가가 가격 Parquet 원주가 종가의 ±${S5_CLOSE_TOL * 100}% 안 ${closeOk}/${closeN} | (매수+매도)÷거래량 중앙값 ${(sh[Math.floor(sh.length / 2)] ?? NaN).toFixed(3)}, 5분위 ${(sh[Math.floor(sh.length * 0.05)] ?? NaN).toFixed(3)}, 95분위 ${(sh[Math.min(Math.floor(sh.length * 0.95), sh.length - 1)] ?? NaN).toFixed(3)}`);
      }
      return out;
    };
    const SAM = "005930";
    const delPickFm = pool.find((c) => isDelisted(c) && winOf(c, FM) !== null && (priceDays.get(c)?.size ?? 0) > 200) as string | undefined;
    const delPickLoan = pool.find((c) => isDelisted(c) && winOf(c, LOAN) !== null && tradingDays(c, S5_LOAN_FROM, S5_LOAN_TO).length > 100) as string | undefined;
    console.log("\n--- 외국계 창구(5-A) ---");
    const a = await probe("FM-A 2011년 범위", FM, SAM, "2011-01-03", "2011-12-30", true);
    const b = await probe("FM-B 2013년 범위", FM, SAM, "2013-01-02", "2013-12-30");
    await probe("FM-C 2011-01 범위(21행 재현)", FM, SAM, "2011-01-03", "2011-01-31");
    const d = await probe("FM-D 6년 범위(상한 확인)", FM, SAM, "2011-01-03", "2016-12-29");
    if (delPickFm) { const w = winOf(delPickFm, FM) as { lo: string; hi: string }; await probe(`FM-E 상장폐지 종목 ${delPickFm}`, FM, delPickFm, w.lo, w.hi < addDay(w.lo, 364) ? w.hi : addDay(w.lo, 364)); }
    const rowsSeen = [a, b, d].filter((x): x is Rec[] => x !== null).map((x) => x.length);
    const dDays = tradingDays(SAM, "2011-01-03", "2016-12-29").length;
    console.log(`  → 호출당 행 수 판단: A·B·D 응답 행 ${rowsSeen.join("/")}, 6년 범위 가격 거래일 ${dDays}일. D 응답이 거래일 수와 같으면 6년 범위까지 상한 없음(S5_FM_PAGE_ROWS는 ${dDays} 이상의 값, 예 ${Math.ceil(dDays / 100) * 100}), 아니면 D 응답 행 수 ${d?.length ?? "-"}가 상한(S5_FM_PAGE_ROWS = 그 값).`);
    console.log("\n--- 대차잔고(5-B) ---");
    const f = await probe("LN-F 2014-01~07 확인", LOAN, SAM, "2014-01-01", "2014-07-31", true);
    if (f !== null && f.length > 0) await probe("LN-G 2014-01~04 확인", LOAN, SAM, "2014-01-01", "2014-04-30");
    await probe("LN-H 2015년 범위(100행·최근 쪽 재확인)", LOAN, SAM, "2015-01-02", "2015-12-30");
    if (delPickLoan) { const ds = tradingDays(delPickLoan, S5_LOAN_FROM, S5_LOAN_TO); await probe(`LN-I 상장폐지 종목 ${delPickLoan}`, LOAN, delPickLoan, ds[0], ds[ds.length - 1]); }
    // 호출 수 중심값 미리 보기(호출당 행 수가 정해졌을 때의 계산 예)
    const centerFor = (s: Spec, pr: number): number => active.filter((c) => winOf(c, s) !== null).reduce((acc, c) => { const w = winOf(c, s) as { lo: string; hi: string }; return acc + Math.ceil(cal.filter((x) => x >= w.lo && x <= w.hi).length / pr); }, 0);
    console.log(`\n호출 수 중심값 미리 보기: 대차(100행) ${centerFor(LOAN, S5_LOAN_PAGE_ROWS)}회(상한 ${Math.ceil(centerFor(LOAN, S5_LOAN_PAGE_ROWS) * S5_REQUEST_CAP_FACTOR)}), 외국계 호출당 30행 ${centerFor(FM, 30)} / 100행 ${centerFor(FM, 100)} / 연 범위 이상(260행) ${centerFor(FM, 260)}회 (대상 종목 수는 구간마다 다름: 외국계 ${active.filter((c) => winOf(c, FM) !== null).length}, 대차 ${active.filter((c) => winOf(c, LOAN) !== null).length})`);
    console.log(`\n파일럿 종료: 요청 ${run.req}, 오류 ${run.errors}, rate limit ${run.rlEvents} | Storage 읽기 ${mib(io.readBytes)} MiB(${io.reads}건, 수급 진행 파일), 쓰기 0 | 소요 ${((Date.now() - T0) / 60e3).toFixed(1)}분 | DB 쓰기 0 | DART 호출 0`);
    return;
  }

  // ================= 본 수집 (fm | loan) =================
  const pr = spec.pageRows as number;
  const centerCalls = active.reduce((acc, c) => { const w = winOf(c) as { lo: string; hi: string }; return acc + Math.ceil(cal.filter((x) => x >= w.lo && x <= w.hi).length / pr); }, 0);
  requestCap = Math.ceil(centerCalls * S5_REQUEST_CAP_FACTOR);
  console.log(`수집 대상 ${active.length}종목, 호출당 행 수 ${pr}, 호출 수 중심값 ${centerCalls}, 요청 누적 상한 ${requestCap}(= 중심값 × ${S5_REQUEST_CAP_FACTOR})`);
  const startDone = active.filter((c) => progress.stocks[c]?.done).length;
  console.log(`회차 시작 시 완료 ${startDone}/${active.length}`);
  for (const code of active) {
    if (progress.stocks[code]?.done) continue;
    if (stopCheck()) break;
    const w = winOf(code) as { lo: string; hi: string };
    const finished = await collectStock(code, w.lo, w.hi, priceDays.get(code) as Map<string, unknown>, rowsMap, dirtyYears);
    if (finished) { run.completed++; doneSinceCheckpoint++; } else break;
    if (doneSinceCheckpoint >= S5_CHECKPOINT_STOCKS || Date.now() - lastCheckpoint >= S5_CHECKPOINT_MS) await checkpoint("주기 저장");
  }
  const doneNow = active.filter((c) => progress.stocks[c]?.done).length;
  const complete = doneNow === active.length;
  progress.runs.push({ startedAt: new Date(T0).toISOString(), requests: run.req, completed: run.completed, newRows: run.newRows, errors: run.errors, rlEvents: run.rlEvents, stop: stopReason ?? (complete ? "전 종목 완료" : "알 수 없음") });
  await checkpoint("회차 종료");
  console.log(`\n=== 회차 결과 ===\n이번 회차 요청 ${run.req}(rate limit 응답 ${run.rlEvents}회, 재시도 ${run.rlRetries}회 대기 ${(run.rlWaitMs / 1000).toFixed(0)}초), 새로 저장한 행 ${run.newRows}, 오류 응답 ${run.errors}, 완료 종목 ${doneNow}/${active.length}, 중단 사유 ${stopReason ?? (complete ? "없음(전 종목 완료)" : "알 수 없음")}, 방향 점검 이상 ${run.dirAnomaly}건, 소요 ${((Date.now() - T0) / 60e3).toFixed(1)}분`);
  if (run.failedCalls.length) console.log(`호출 실패 목록(앞 20개): ${run.failedCalls.slice(0, 20).join(" | ")}`);
  if (!complete) { console.log(`미완 — 같은 워크플로를 다시 실행하면 진행 파일로 이어받는다 | Storage 읽기 ${mib(io.readBytes)} MiB, 쓰기 ${mib(io.writeBytes)} MiB`); return; }

  // =================== 정리본 + 점검 ===================
  console.log(`\n=== 정리본 생성 (가격 Parquet의 종목별 거래일[종가>0]과 대조) ===`);
  const clean: Row[] = [];
  let raw = 0, dropNoPrice = 0, dropOutRange = 0, dropNull = 0;
  const requiredCols = spec.id === "fm" ? ["shnu_qty", "seln_qty"] : ["rmnd_stcn"];
  for (const r of rowsMap.values()) {
    raw++;
    const code = r.stock_code as string, d = r.trade_date as string, pd = priceDays.get(code);
    if (d < spec.from || d > spec.to) { dropOutRange++; continue; }
    if (!pd || !pd.has(d)) { dropNoPrice++; continue; }
    if (requiredCols.some((c) => r[c] === null)) { dropNull++; continue; }
    clean.push(r);
  }
  console.log(`${spec.label} 원본 ${raw}행 → 정리본 ${clean.length}행 (기간 밖 ${dropOutRange}, 가격 없는 날 ${dropNoPrice}, 값 없음 ${dropNull})`);
  const byStock = new Map<string, Row[]>();
  for (const r of clean) { const a = byStock.get(r.stock_code as string); if (a) a.push(r); else byStock.set(r.stock_code as string, [r]); }
  const allZero = active.filter((c) => !(byStock.get(c) ?? []).some((r) => spec.valueCols.some((k) => k !== "close" && ((r[k] as number) ?? 0) !== 0)));
  const noRows = active.filter((c) => !(byStock.get(c)?.length)).length;
  const yearStat = new Map<number, { price: number; have: number; zero: number; bad: number; idBad: number; closeOk: number; closeN: number }>();
  let priceDaysTotal = 0, haveTotal = 0, idBadTotal = 0, closeOkTotal = 0, closeNTotal = 0;
  const share: number[] = [];
  for (const c of active) {
    const w = winOf(c) as { lo: string; hi: string };
    const pd = priceDays.get(c) as Map<string, { vol: number; close: number }>;
    const have = new Map((byStock.get(c) ?? []).map((r) => [r.trade_date as string, r]));
    for (const [d, p] of pd) {
      if (d < w.lo || d > w.hi) continue;
      const y = Number(d.slice(0, 4)); const ys = yearStat.get(y) ?? { price: 0, have: 0, zero: 0, bad: 0, idBad: 0, closeOk: 0, closeN: 0 }; yearStat.set(y, ys);
      ys.price++; priceDaysTotal++;
      const r = have.get(d);
      if (!r) continue;
      ys.have++; haveTotal++;
      if (spec.id === "fm") {
        const b = r.shnu_qty as number, s = r.seln_qty as number, n = r.ntby_qty as number | null, cl = r.close as number | null;
        if (b === 0 && s === 0) ys.zero++;
        if (b < 0 || s < 0) ys.bad++;
        if (n !== null && b - s !== n) { ys.idBad++; idBadTotal++; }
        if (cl !== null) { ys.closeN++; closeNTotal++; if (Math.abs(cl / p.close - 1) <= S5_CLOSE_TOL) { ys.closeOk++; closeOkTotal++; } }
        if (p.vol > 0) share.push((b + s) / p.vol);
      } else {
        const rm = r.rmnd_stcn as number;
        if (rm === 0 && ((r.new_stcn as number) ?? 0) === 0 && ((r.rdmp_stcn as number) ?? 0) === 0) ys.zero++;
        if (rm < 0) ys.bad++;
      }
    }
  }
  console.log(`\n=== 점검 ===\n요청 대상 ${active.length}종목 중 정리본 행이 하나도 없는 종목 ${noRows}, 값이 전부 0인 종목 ${allZero.length}(${((allZero.length / active.length) * 100).toFixed(2)}%, 상한 ${S5_MAX_ALL_ZERO_STOCK_RATIO * 100}%, 그중 상장폐지 ${allZero.filter(isDelisted).length}), 상장폐지 종목 포함 ${active.filter(isDelisted).length}개 요청·${[...byStock.keys()].filter(isDelisted).length}개 정리본 행 있음`);
  console.log(`가격이 있는 종목-일 ${priceDaysTotal} 중 데이터 없음 ${priceDaysTotal - haveTotal}(${(((priceDaysTotal - haveTotal) / priceDaysTotal) * 100).toFixed(2)}%, 상한 ${S5_MAX_MISSING_DAY_RATIO * 100}%)`);
  console.log(`| 연도 | 가격 있는 종목-일 | 데이터 있음 | 없음 % | 값 전부 0 | 음수 |${spec.id === "fm" ? " 순매수 항등 불일치 | 종가 ±1% 안 |" : ""}\n|---|---|---|---|---|---|${spec.id === "fm" ? "---|---|" : ""}`);
  for (const [y, s] of [...yearStat].sort((a, b) => a[0] - b[0])) console.log(`| ${y} | ${s.price} | ${s.have} | ${(((s.price - s.have) / s.price) * 100).toFixed(2)} | ${s.zero} | ${s.bad} |${spec.id === "fm" ? ` ${s.idBad} | ${s.closeOk}/${s.closeN} |` : ""}`);
  if (spec.id === "fm") {
    share.sort((a, b) => a - b);
    const q = (p: number): string => (share[Math.min(Math.floor(share.length * p), share.length - 1)] ?? NaN).toFixed(3);
    console.log(`순매수 항등(매수−매도=순매수) 불일치 ${idBadTotal}행(${((idBadTotal / Math.max(haveTotal, 1)) * 100).toFixed(3)}%, 상한 ${S5_NTBY_IDENTITY_MAX_RATIO * 100}%) | 응답 종가 ±${S5_CLOSE_TOL * 100}% 안 ${closeOkTotal}/${closeNTotal}(${((closeOkTotal / Math.max(closeNTotal, 1)) * 100).toFixed(2)}%, 하한 ${S5_CLOSE_MIN_SHARE * 100}%)`);
    console.log(`(매수+매도) ÷ 가격 Parquet 거래량(정보용): 표본 ${share.length}, 5분위 ${q(0.05)}, 중앙값 ${q(0.5)}, 95분위 ${q(0.95)}, 최대 ${(share[share.length - 1] ?? NaN).toFixed(3)}`);
  }

  // 정리본 저장: Storage + Actions 캐시용 디렉터리
  const outDir = spec.cacheDir;
  const cleanSub = spec.cleanPrefix.split("/").pop() as string;
  await fsp.mkdir(path.join(outDir, cleanSub), { recursive: true });
  const manifest: { dataset: string; files: { path: string; rows: number; bytes: number; sha256: string }[]; stocks: string[]; delisted: string[]; createdAt: string } = { dataset: spec.id, files: [], stocks: active, delisted: active.filter(isDelisted), createdAt: new Date().toISOString() };
  let cleanBytes = 0;
  for (const [y, rs] of [...byYear(clean)].sort((a, b) => a[0] - b[0])) {
    const body = encode(spec.cols, rs), p = `${cleanSub}/${y}.parquet`;
    await fsp.writeFile(path.join(outDir, p), Buffer.from(body));
    manifest.files.push({ path: p, rows: rs.length, bytes: body.byteLength, sha256: createHash("sha256").update(Buffer.from(body)).digest("hex") }); cleanBytes += body.byteLength;
    await upload(`${spec.cleanPrefix}/${y}.parquet`, body);
  }
  await fsp.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1));
  const storageEnd = await storageTotal();
  console.log(`\n정리본 ${manifest.files.length}개 파일 ${mib(cleanBytes)} MiB, 행당 ${(cleanBytes / Math.max(clean.length, 1)).toFixed(1)} B`);
  console.log(`Storage 총량: 시작 ${mib(storageStart)} → 끝 ${mib(storageEnd)} MiB (+${mib(storageEnd - storageStart)} MiB, 쓰기 예산 ${mib(spec.writeBudget)} MiB) | 이번 회차 Storage 읽기 ${mib(io.readBytes)} MiB(${io.reads}건), 업로드 ${mib(io.writeBytes)} MiB(${io.writes}건)`);
  if (storageEnd > S5_STORAGE_CAP_BYTES) console.log("경고: Storage 총량 상한 초과");
  if (storageEnd - storageStart > spec.writeBudget) console.log("경고: 이번 쓰기 예산 초과");
  console.log(`DB 쓰기 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60e3).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

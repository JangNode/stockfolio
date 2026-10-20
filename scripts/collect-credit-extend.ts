/**
 * [연구용] 신용잔고(FHPST04760000) 2016-12-01~2026-10-16 이어받기 수집 → Storage research/credit_balance/{2017..2026}.parquet (공매도 수집 없음, DB 쓰기 없음).
 * 사전 등록: research/credit-incremental-prereg.md 2단계. 기존 2009~2016.parquet·_progress.json은 읽기만 하며(2016-12 겹침 행은 기존 2016.parquet과 대조만), 진행 파일은 _progress_ext.json.
 * 대상: 2010-01 이후 한 번이라도 PIT 적격(직전 행 시총 5천억 + 20일 평균 거래대금 5억)이었던 종목(상장폐지 포함).
 * 중단: 연속 오류 20건, TIME LIMIT, rate limit(5→15→60초 재시도 3회 연속 실패 또는 10분 5회), 요청 누적 상한 100,000, 회차 4.75시간, Storage 800MB 초과 예상. 14:00~15:40 KST 호출 금지. 키 값 출력 금지.
 */
import { parquetWriteBuffer } from "hyparquet-writer";
import { parquetReadObjects } from "hyparquet";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { kisGetForResearch, getKisCallStats } from "@/lib/kis";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { applyAdjustmentsInPlace } from "@/lib/priceAdjustment";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { SCAN_CAP_EOK } from "@/lib/signalScanConfig";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET, INVESTOR_FLOW_CONSEC_ERROR_STOP, INVESTOR_FLOW_CHECKPOINT_STOCKS, INVESTOR_FLOW_CHECKPOINT_MS, INVESTOR_FLOW_ERROR_RETRY_MS } from "@/lib/investorFlowConfig";
import {
  SC_COLLECT_CREDIT_PAGE_ROWS, SC_COLLECT_CREDIT_SCR_DIV, SC_COLLECT_RUN_MAX_MS, SC_COLLECT_STORAGE_CAP_BYTES, SC_COLLECT_ASSUMED_BYTES_PER_ROW, SC_CREDIT_PREFIX,
  SC_COLLECT_LOG_EVERY_REQ, SC_COLLECT_BLOCK_UTC_FROM_MIN, SC_COLLECT_BLOCK_UTC_TO_MIN, SC_COLLECT_RL_WAITS_MS, SC_COLLECT_RL_WINDOW_MS, SC_COLLECT_RL_WINDOW_MAX,
} from "@/lib/shortCreditCollectConfig";
import { CX_FROM, CX_TO, CX_REQUEST_TOTAL_CAP, CX_NEW_FIRST_YEAR, CX_LAST_YEAR, CX_OVERLAP_YEAR, CX_OVERLAP_END, CX_PROGRESS_FILE } from "@/lib/creditExtendConfig";

const T0 = Date.now();
const MS_DAY = 86_400_000;
const CREDIT_PATH = "/uapi/domestic-stock/v1/quotations/daily-credit-balance";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const kst = (d = new Date()): string => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(11, 19);
const iso = (d: string): string => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const ymd = (d: string): string => d.replace(/-/g, "");
const addDay = (d: string, n: number): string => new Date(Date.parse(d) + n * MS_DAY).toISOString().slice(0, 10);
const num = (v: unknown): number | null => { const s = String(v ?? "").trim(); if (s === "") return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const mb = (b: number): string => (b / 1048576).toFixed(2);
type Rec = Record<string, unknown>;
type Row = Record<string, string | number | null>;

const COLS: { name: string; type: "STRING" | "DOUBLE" }[] = [
  { name: "stock_code", type: "STRING" }, { name: "deal_date", type: "STRING" }, { name: "stlm_date", type: "STRING" }, { name: "whol_loan_rmnd_stcn", type: "DOUBLE" },
  { name: "whol_loan_rmnd_amt", type: "DOUBLE" }, { name: "whol_loan_rmnd_rate", type: "DOUBLE" }, { name: "whol_stln_rmnd_stcn", type: "DOUBLE" },
];
const VALUE_COLS = ["whol_loan_rmnd_stcn", "whol_loan_rmnd_amt", "whol_loan_rmnd_rate", "whol_stln_rmnd_stcn"];
interface StockState { cursor: string | null; done: boolean; skipped: boolean; rows: number; requests: number }
interface Overlap { match: number; mismatch: number; notInExisting: number }
interface RunLog { startedAt: string; requests: number; rows: number; stocksDone: number; errors: number; rlEvents: number; rlRetries: number; rlWaitSec: number; stop: string }
interface Progress { requestsTotal: number; stocks: Record<string, StockState>; runs: RunLog[]; dbBaselineBytes: number | null; bytesPerRow: number | null; stlmOrderViolations: number; overlap: Overlap }

const rowsBy = new Map<number, Map<string, Row>>();
const dirty = new Set<number>();
let progress: Progress = { requestsTotal: 0, stocks: {}, runs: [], dbBaselineBytes: null, bytesPerRow: null, stlmOrderViolations: 0, overlap: { match: 0, mismatch: 0, notInExisting: 0 } };
const existing2016 = new Map<string, number[]>();
const run = { rows: 0, req: 0, errors: 0, consec: 0, stocksDone: 0, outOfRange: 0, rlEvents: 0, rlRetries: 0, rlWaitMs: 0, rlEpisodes: 0, rlTimes: [] as number[], overlap: { match: 0, mismatch: 0, notInExisting: 0 } };
let stopReason: string | null = null;
let loaded = false, lastLog = 0, lastCheckpoint = Date.now(), doneSinceCheckpoint = 0, storageProjectedLast = 0, totalExpectedRows = 0;

const bucket = (): ReturnType<typeof supabaseAdmin.storage.from> => supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET);
const yearPath = (y: number): string => `${SC_CREDIT_PREFIX}/${y}.parquet`;
const PROG_PATH = `${SC_CREDIT_PREFIX}/${CX_PROGRESS_FILE}`;
async function download(path: string): Promise<ArrayBuffer | null> {
  const { data, error } = await bucket().download(path);
  if (error) { if (/not found|404/i.test(error.message)) return null; throw new Error(`Storage 다운로드 실패 ${path}: ${error.message}`); }
  return data.arrayBuffer();
}
async function upload(path: string, body: ArrayBuffer | Uint8Array): Promise<void> {
  let lastMsg = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const { error } = await bucket().upload(path, body, { contentType: "application/octet-stream", upsert: true });
    if (!error) return;
    lastMsg = error.message;
    console.log(`  [Storage 업로드 재시도 ${attempt + 1}/4] ${path}: ${lastMsg || "<none>"}`);
    await sleep(3_000 * 2 ** attempt);
  }
  throw new Error(`Storage 업로드 실패 ${path}: ${lastMsg}`);
}
function encodeYear(rows: Map<string, Row>): ArrayBuffer {
  const list = [...rows.values()].sort((a, b) => ((a.stock_code as string) < (b.stock_code as string) ? -1 : (a.stock_code as string) > (b.stock_code as string) ? 1 : (a.deal_date as string) < (b.deal_date as string) ? -1 : 1));
  return parquetWriteBuffer({ columnData: COLS.map((c) => c.type === "STRING" ? { name: c.name, data: list.map((r) => r[c.name] as string), type: "STRING" as const } : { name: c.name, data: list.map((r) => r[c.name] as number | null), type: "DOUBLE" as const, nullable: true }) });
}
async function loadStored(): Promise<void> {
  const p = await download(PROG_PATH);
  if (p) progress = { ...progress, ...(JSON.parse(new TextDecoder().decode(p)) as Progress) };
  let n = 0;
  for (let y = CX_NEW_FIRST_YEAR; y <= CX_LAST_YEAR; y++) {
    const buf = await download(yearPath(y));
    if (!buf) continue;
    const m = new Map<string, Row>();
    for (const r of (await parquetReadObjects({ file: buf })) as Row[]) m.set(`${r.stock_code}|${r.deal_date}`, r);
    rowsBy.set(y, m); n += m.size;
  }
  const st = Object.values(progress.stocks);
  console.log(`저장된 진행[신용잔고 2017~]: 종목 ${st.length}개(완료 ${st.filter((s) => s.done).length}), 누적 요청 ${progress.requestsTotal}, 저장 행 ${n}, 지난 회차 ${progress.runs.length}회, 2016-12 대조 누계 일치 ${progress.overlap.match}·불일치 ${progress.overlap.mismatch}·기존에 없음 ${progress.overlap.notInExisting}`);
  // 겹침 대조용: 기존 2016.parquet(읽기만, 2016-12 행만 보관)
  const old = await download(yearPath(CX_OVERLAP_YEAR));
  if (!old) throw new Error("기존 2016.parquet이 없어 2016-12 대조를 할 수 없습니다.");
  let nOld = 0;
  for (const r of (await parquetReadObjects({ file: old })) as Row[]) { if ((r.deal_date as string) >= CX_FROM) { existing2016.set(`${r.stock_code}|${r.deal_date}`, VALUE_COLS.map((c) => (r[c] === null ? NaN : Number(r[c])))); nOld++; } }
  console.log(`기존 2016.parquet의 2016-12 행(대조용, 읽기만): ${nOld}행`);
}
function handleRow(r: Row): void {
  const d = r.deal_date as string;
  if (d <= CX_OVERLAP_END) {
    // 2016-12 겹침: 기존 값과 대조만 한다(저장·덮어쓰기 없음).
    const old = existing2016.get(`${r.stock_code}|${d}`);
    if (!old) { run.overlap.notInExisting++; return; }
    const cur = VALUE_COLS.map((c) => (r[c] === null ? NaN : Number(r[c])));
    const same = cur.every((v, i) => (Number.isNaN(v) && Number.isNaN(old[i])) || v === old[i]);
    if (same) run.overlap.match++; else run.overlap.mismatch++;
    return;
  }
  const y = Number(d.slice(0, 4));
  let m = rowsBy.get(y);
  if (!m) { m = new Map(); rowsBy.set(y, m); }
  const key = `${r.stock_code}|${d}`;
  const isNew = !m.has(key);
  m.set(key, r); dirty.add(y);
  if (isNew) run.rows++;
}
async function walk(b: string, prefix: string, acc: { bytes: number }): Promise<void> {
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabaseAdmin.storage.from(b).list(prefix, { limit: 1000, offset });
    if (error) throw new Error(`${b}/${prefix} 목록 실패: ${error.message}`);
    for (const e of data ?? []) {
      if (e.id === null) await walk(b, prefix ? `${prefix}/${e.name}` : e.name, acc);
      else acc.bytes += Number((e.metadata as { size?: number } | null)?.size ?? 0);
    }
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
async function dbBytes(): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc("research_storage_report");
  if (error) throw new Error(`research_storage_report 실패: ${error.message}`);
  return (data as { db_bytes: number }).db_bytes;
}
const totalRows = (): number => [...rowsBy.values()].reduce((s, m) => s + m.size, 0);
const cumReq = (): number => progress.requestsTotal;
async function storageCheck(why: string): Promise<boolean> {
  const now = await storageTotal();
  const bpr = progress.bytesPerRow ?? SC_COLLECT_ASSUMED_BYTES_PER_ROW;
  const remaining = Math.max(totalExpectedRows - totalRows(), 0);
  const projected = now + (remaining + totalExpectedRows) * bpr;
  storageProjectedLast = projected;
  console.log(`  [Storage 점검:${why}] 현재 ${mb(now)} MiB, 행당 ${bpr.toFixed(1)} B(${progress.bytesPerRow ? "실측" : "가정"}), 남은 행 ${remaining}, 정리본 포함 예상 최종 ${mb(projected)} MiB / 상한 ${mb(SC_COLLECT_STORAGE_CAP_BYTES)} MiB`);
  if (projected > SC_COLLECT_STORAGE_CAP_BYTES) { stopReason = "Storage 800MB 초과 예상"; return true; }
  return false;
}
async function checkpoint(why: string): Promise<void> {
  let upBytes = 0, upRows = 0;
  for (const y of [...dirty].sort()) { const body = encodeYear(rowsBy.get(y)!); upBytes += body.byteLength; upRows += rowsBy.get(y)!.size; await upload(yearPath(y), body); }
  dirty.clear();
  if (upRows > 0) progress.bytesPerRow = upBytes / upRows;
  progress.overlap = { match: progress.overlap.match + run.overlap.match, mismatch: progress.overlap.mismatch + run.overlap.mismatch, notInExisting: progress.overlap.notInExisting + run.overlap.notInExisting };
  run.overlap = { match: 0, mismatch: 0, notInExisting: 0 };
  await upload(PROG_PATH, new TextEncoder().encode(JSON.stringify(progress)));
  lastCheckpoint = Date.now(); doneSinceCheckpoint = 0;
  console.log(`  [저장] ${why}: 연도 파일 갱신, 진행 파일 저장, 누적 요청 ${cumReq()}, 저장 행 ${totalRows()}, 2016-12 대조 누계 일치 ${progress.overlap.match}·불일치 ${progress.overlap.mismatch}·기존에 없음 ${progress.overlap.notInExisting}, KST ${kst()}`);
  if (await storageCheck(why)) console.log("  Storage 예상 초과 — 중단");
}

async function waitIfBlocked(): Promise<void> {
  for (;;) {
    const n = new Date(), m = n.getUTCHours() * 60 + n.getUTCMinutes();
    if (m >= SC_COLLECT_BLOCK_UTC_FROM_MIN && m < SC_COLLECT_BLOCK_UTC_TO_MIN) {
      if (Date.now() - T0 >= SC_COLLECT_RUN_MAX_MS) return;
      console.log(`  [대기] KST ${kst()} — 14:00~15:40 호출 금지 시간대, 30초 후 재확인`); await sleep(30_000);
    } else return;
  }
}
function stopCheck(): boolean {
  if (stopReason) return true;
  if (Date.now() - T0 >= SC_COLLECT_RUN_MAX_MS) stopReason = "회차 시간 상한";
  else if (cumReq() >= CX_REQUEST_TOTAL_CAP) stopReason = "요청 누적 상한";
  return stopReason !== null;
}
const isRateLimitMsg = (msg: string): boolean => /EGW00201|rate\s*limit|too\s*many|초당|429/i.test(msg);
async function callKis(code: string, anchor: string): Promise<Rec[] | null> {
  for (let rl = 0; ; rl++) {
    await waitIfBlocked();
    if (stopCheck()) return null;
    const r0 = getKisCallStats().total;
    try {
      const body = await kisGetForResearch(CREDIT_PATH, "FHPST04760000", { FID_COND_MRKT_DIV_CODE: "J", FID_COND_SCR_DIV_CODE: SC_COLLECT_CREDIT_SCR_DIV, FID_INPUT_ISCD: code, FID_INPUT_DATE_1: ymd(anchor) }, 0);
      run.consec = 0;
      const d = getKisCallStats().total - r0;
      run.req += d; progress.requestsTotal += d;
      return (body.output as Rec[] | undefined) ?? [];
    } catch (e) {
      const d = getKisCallStats().total - r0;
      run.req += d; progress.requestsTotal += d;
      const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
      if (!/time\s*limit/i.test(msg) && isRateLimitMsg(msg)) {
        const now = Date.now();
        run.rlEvents++;
        if (rl === 0) run.rlEpisodes++;
        run.rlTimes.push(now);
        while (run.rlTimes.length && now - run.rlTimes[0] > SC_COLLECT_RL_WINDOW_MS) run.rlTimes.shift();
        console.log(`  [rate limit KST ${kst()}] ${code} ${anchor}: ${msg} (이번 요청 ${rl + 1}번째 실패, 최근 10분 ${run.rlTimes.length}회)`);
        if (run.rlTimes.length >= SC_COLLECT_RL_WINDOW_MAX) { stopReason = `rate limit 10분 안에 ${run.rlTimes.length}회`; return null; }
        if (rl >= SC_COLLECT_RL_WAITS_MS.length) { stopReason = `rate limit ${SC_COLLECT_RL_WAITS_MS.length}회 연속 재시도 실패`; return null; }
        const w = SC_COLLECT_RL_WAITS_MS[rl];
        run.rlRetries++; run.rlWaitMs += w;
        console.log(`  [rate limit 대기] ${w / 1000}초 쉬고 재시도 ${rl + 1}/${SC_COLLECT_RL_WAITS_MS.length}`);
        await sleep(w);
        continue;
      }
      run.errors++; run.consec++;
      console.log(`  [오류 KST ${kst()}] ${code} ${anchor}: ${msg} (연속 ${run.consec})`);
      if (/time\s*limit/i.test(msg)) stopReason = "TIME LIMIT 응답";
      else if (run.consec >= INVESTOR_FLOW_CONSEC_ERROR_STOP) stopReason = `연속 오류 ${INVESTOR_FLOW_CONSEC_ERROR_STOP}건`;
      if (!stopReason) await sleep(INVESTOR_FLOW_ERROR_RETRY_MS);
      return null;
    }
  }
}

interface Win { lo: string; hi: string; days: number }
async function collectStock(code: string, w: Win): Promise<boolean> {
  const st = progress.stocks[code] ?? { cursor: null, done: false, skipped: false, rows: 0, requests: 0 };
  progress.stocks[code] = st;
  let anchor = st.cursor ? addDay(st.cursor, -1) : (addDay(w.hi, 5) > CX_TO ? CX_TO : addDay(w.hi, 5));
  for (;;) {
    if (anchor < CX_FROM) { st.done = true; return true; }
    const out = await callKis(code, anchor);
    if (out === null) { if (stopReason) return false; continue; }
    st.requests++;
    const mapped = out.filter((r) => r.deal_date && r.stlm_date).map((r) => ({ deal: iso(String(r.deal_date)), stlm: iso(String(r.stlm_date)), r }));
    for (let i = 1; i < mapped.length; i++) if (!(mapped[i].stlm < mapped[i - 1].stlm)) progress.stlmOrderViolations++;
    for (const m of mapped) {
      if (m.deal < CX_FROM || m.deal > CX_TO) { run.outOfRange++; continue; }
      const before = run.rows;
      handleRow({ stock_code: code, deal_date: m.deal, stlm_date: m.stlm, whol_loan_rmnd_stcn: num(m.r.whol_loan_rmnd_stcn), whol_loan_rmnd_amt: num(m.r.whol_loan_rmnd_amt), whol_loan_rmnd_rate: num(m.r.whol_loan_rmnd_rate), whol_stln_rmnd_stcn: num(m.r.whol_stln_rmnd_stcn) });
      if (run.rows > before) st.rows++;
    }
    const oldestStlm = mapped.length ? mapped.reduce((a, b) => (b.stlm < a ? b.stlm : a), mapped[0].stlm) : null;
    const oldestDeal = mapped.length ? mapped.reduce((a, b) => (b.deal < a ? b.deal : a), mapped[0].deal) : null;
    if (oldestStlm) st.cursor = st.cursor && st.cursor < oldestStlm ? st.cursor : oldestStlm;
    if (!oldestStlm || out.length < SC_COLLECT_CREDIT_PAGE_ROWS || (oldestDeal !== null && oldestDeal <= w.lo)) { st.done = true; return true; }
    const next = addDay(oldestStlm, -1);
    if (next >= anchor) { st.done = true; return true; }
    anchor = next;
    if (run.req - lastLog >= SC_COLLECT_LOG_EVERY_REQ) { lastLog = run.req; console.log(`  진행: 요청 ${run.req}(누적 ${cumReq()}), 종목 ${code} 최오래 결제일 ${oldestStlm}, 이번 회차 완료 ${run.stocksDone}종목, KST ${kst()}, 경과 ${((Date.now() - T0) / 60e3).toFixed(0)}분`); }
  }
}

async function main(): Promise<void> {
  console.log(`신용잔고 2017~ 수집 회차 시작: ${new Date().toISOString()} (KST ${kst()}) | 요청 누적 상한 ${CX_REQUEST_TOTAL_CAP} | 회차 상한 ${(SC_COLLECT_RUN_MAX_MS / 3600e3).toFixed(2)}시간 | 기간 ${CX_FROM}~${CX_TO}`);
  await loadStored();
  loaded = true;
  if (progress.dbBaselineBytes === null) { progress.dbBaselineBytes = await dbBytes(); console.log(`DB 크기 기준(2단계 첫 회차 시작 시): ${progress.dbBaselineBytes} B`); }

  const adjustments = await loadAppliedAdjustments();
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear());
  const wins = new Map<string, Win>();
  const pool: string[] = [];
  let noOverlap = 0;
  for (const [code, rows] of series) {
    series.delete(code);
    if (!rows.length) continue;
    const adj = rows.map((r) => ({ ...r }));
    const al = adjustments.get(code);
    if (al) applyAdjustmentsInPlace(adj, al);
    const tv = computeTrailingAvgTradingValue(adj, PIT_LIQUIDITY_LOOKBACK_DAYS);
    let ever = false;
    for (let i = 1; i < rows.length; i++) if (rows[i].tradeDate >= "2010-01-01" && rows[i - 1].marketCapEok >= SCAN_CAP_EOK && tv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON) { ever = true; break; }
    if (!ever) continue;
    pool.push(code);
    const first = rows[0].tradeDate, last = rows[rows.length - 1].tradeDate;
    const lo = first > CX_FROM ? first : CX_FROM;
    const hi = last < CX_TO ? last : CX_TO;
    const days = rows.filter((r) => r.tradeDate >= lo && r.tradeDate <= hi).length;
    if (lo > hi || days === 0) { noOverlap++; wins.set(code, { lo, hi, days: 0 }); } else wins.set(code, { lo, hi, days });
  }
  pool.sort();
  const active = pool.filter((c) => wins.get(c)!.days > 0);
  for (const c of pool) if (wins.get(c)!.days === 0 && !progress.stocks[c]) progress.stocks[c] = { cursor: null, done: true, skipped: true, rows: 0, requests: 0 };
  const daysSum = active.reduce((a, c) => a + wins.get(c)!.days, 0);
  totalExpectedRows = daysSum;
  const estReq = active.reduce((a, c) => a + Math.ceil(wins.get(c)!.days / SC_COLLECT_CREDIT_PAGE_ROWS) + 1, 0);
  console.log(`대상 ${pool.length}종목(기간과 주가 구간이 겹치지 않아 요청 없음 ${noOverlap}종목, 요청 대상 ${active.length}종목), 기간 내 주가 행 합계 ${daysSum}`);
  console.log(`예상 요청(주가 거래일 기준 상한): ${estReq} / 상한 ${CX_REQUEST_TOTAL_CAP}`);
  if (await storageCheck("회차 시작")) stopReason = "Storage 800MB 초과 예상";

  const doneN = (): number => pool.filter((c) => progress.stocks[c]?.done).length;
  console.log(`회차 시작 시 완료: ${doneN()}/${pool.length}; 수집 순서 = 종목코드 오름차순`);
  for (const code of pool) {
    if (progress.stocks[code]?.done) continue;
    const w = wins.get(code)!;
    if (w.days === 0) continue;
    if (stopCheck()) break;
    const finished = await collectStock(code, w);
    if (!finished) break;
    run.stocksDone++; doneSinceCheckpoint++;
    if (doneSinceCheckpoint >= INVESTOR_FLOW_CHECKPOINT_STOCKS || Date.now() - lastCheckpoint >= INVESTOR_FLOW_CHECKPOINT_MS) { await checkpoint("주기 저장"); if (stopReason) break; }
  }

  const done = doneN();
  const partial = pool.filter((c) => progress.stocks[c] && !progress.stocks[c].done).length;
  const stop = stopReason ?? (done === pool.length ? "전 종목 완료" : "알 수 없음");
  progress.runs.push({ startedAt: new Date(T0).toISOString(), requests: run.req, rows: run.rows, stocksDone: run.stocksDone, errors: run.errors, rlEvents: run.rlEvents, rlRetries: run.rlRetries, rlWaitSec: run.rlWaitMs / 1000, stop });
  await checkpoint("회차 종료");
  const stor = await storageTotal(), db = await dbBytes();
  const base = progress.dbBaselineBytes ?? 0;
  console.log(`\n=== 회차 결과 ===\n| 항목 | 값 |\n|---|---|\n| 이번 회차 요청 | ${run.req} |\n| 이번 회차 새로 저장한 행 | ${run.rows} |\n| 누적 완료 종목 | ${done}/${pool.length} (${((done / pool.length) * 100).toFixed(1)}%) |\n| 진행 중(중간까지) 종목 | ${partial} |\n| 기간 겹침 없음(요청 없음) 종목 | ${noOverlap} |\n| 누적 요청 | ${progress.requestsTotal}/${CX_REQUEST_TOTAL_CAP} |\n| 저장 행 누계 | ${totalRows()} |\n| 이번 회차 오류 응답(rate limit 제외) | ${run.errors} |\n| 이번 회차 rate limit 응답 | ${run.rlEvents}회(발생한 요청 ${run.rlEpisodes}건) |\n| 이번 회차 rate limit 재시도 | ${run.rlRetries}회, 대기 시간 합계 ${(run.rlWaitMs / 1000).toFixed(0)}초 |\n| 이번 회차 기간 밖 행(저장 안 함) | ${run.outOfRange} |\n| 결제일 비단조 쌍(누계) | ${progress.stlmOrderViolations} |\n| 2016-12 대조 누계(일치/불일치/기존에 없음) | ${progress.overlap.match}/${progress.overlap.mismatch}/${progress.overlap.notInExisting} |\n| 중단 사유 | ${stop} |\n| Storage 총량 | ${stor} B (${mb(stor)} MiB), 정리본 포함 예상 최종 ${mb(storageProjectedLast)} MiB / ${mb(SC_COLLECT_STORAGE_CAP_BYTES)} MiB |\n| DB 전체 | ${db} B (${mb(db)} MiB), 2단계 첫 회차 시작 기준 ${base} B 대비 ${db - base >= 0 ? "+" : ""}${db - base} B |\n| 쓴 DB 행 | 0 |\n| 소요 | ${((Date.now() - T0) / 60e3).toFixed(1)}분 |`);
  const rem = pool.filter((c) => !progress.stocks[c]?.done);
  if (rem.length > 0 && rem.length <= 60) console.log(`남은 종목: ${rem.join(",")}`);
}

main().catch(async (e) => {
  console.error("실패:", e instanceof Error ? e.message : e, `요청=${getKisCallStats().total}`);
  try { if (loaded) await checkpoint("오류 종료 직전"); } catch (e2) { console.error("종료 직전 저장도 실패:", e2 instanceof Error ? e2.message : e2); }
  process.exit(1);
});

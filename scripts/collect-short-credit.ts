/**
 * [연구용] 공매도(FHPST04830000)·신용잔고(FHPST04760000) 종목별 일별추이를 Supabase Storage 연도별 Parquet로 저장한다.
 * 대상: 2010-01 이후 한 번이라도 PIT 유니버스(직전 행 시총 5천억 + 20일 평균 거래대금 5억)에 든 종목(상장폐지 포함).
 * 기간: 2009-10-01~2016-12-31만(요청·저장 모두). 공매도 전 종목을 먼저 끝낸 뒤 신용잔고, 종목코드 오름차순. DB 표 생성·쓰기 없음.
 * 이어받기: Storage 진행 파일(_progress.json)과 연도 Parquet로 받은 종목·날짜를 건너뛴다. 14:00~14:30 KST 호출 금지.
 * 중단: 연속 오류 20건, rate limit, TIME LIMIT, 요청 누적 상한, 회차 시간 상한, Storage 800MB 초과 예상. 백테스트·스캔 없음. 키 값 출력 금지.
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
import {
  INVESTOR_FLOW_STOCK_STORE_BUCKET, INVESTOR_FLOW_BLOCK_UTC_FROM_MIN, INVESTOR_FLOW_BLOCK_UTC_TO_MIN, INVESTOR_FLOW_CONSEC_ERROR_STOP,
  INVESTOR_FLOW_CHECKPOINT_STOCKS, INVESTOR_FLOW_CHECKPOINT_MS, INVESTOR_FLOW_ERROR_RETRY_MS,
} from "@/lib/investorFlowConfig";
import {
  SC_COLLECT_FROM, SC_COLLECT_TO, SC_COLLECT_SHORT_PAGE_ROWS, SC_COLLECT_CREDIT_PAGE_ROWS, SC_COLLECT_CREDIT_SCR_DIV, SC_COLLECT_REQUEST_TOTAL_CAP,
  SC_COLLECT_RUN_MAX_MS, SC_COLLECT_STORAGE_CAP_BYTES, SC_COLLECT_ASSUMED_BYTES_PER_ROW, SC_SHORT_PREFIX, SC_CREDIT_PREFIX, SC_PROGRESS_FILE,
  SC_FIRST_YEAR, SC_LAST_YEAR, SC_PRICE_DATA_START, SC_COLLECT_LOG_EVERY_REQ,
} from "@/lib/shortCreditCollectConfig";

const T0 = Date.now();
const MS_DAY = 86_400_000;
const SHORT_PATH = "/uapi/domestic-stock/v1/quotations/daily-short-sale";
const CREDIT_PATH = "/uapi/domestic-stock/v1/quotations/daily-credit-balance";
const BASELINE_FALLBACK = 0;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const kst = (d = new Date()): string => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(11, 19);
const iso = (d: string): string => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const ymd = (d: string): string => d.replace(/-/g, "");
const addDay = (d: string, n: number): string => new Date(Date.parse(d) + n * MS_DAY).toISOString().slice(0, 10);
const num = (v: unknown): number | null => { const s = String(v ?? "").trim(); if (s === "") return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const mb = (b: number): string => (b / 1048576).toFixed(2);
type Rec = Record<string, unknown>;
type Kind = "short" | "credit";
type Row = Record<string, string | number | null>;

interface KindSpec { prefix: string; dateCol: string; pageRows: number; cols: { name: string; type: "STRING" | "DOUBLE" }[] }
const SPEC: Record<Kind, KindSpec> = {
  short: {
    prefix: SC_SHORT_PREFIX, dateCol: "trade_date", pageRows: SC_COLLECT_SHORT_PAGE_ROWS,
    cols: [{ name: "stock_code", type: "STRING" }, { name: "trade_date", type: "STRING" }, { name: "ssts_cntg_qty", type: "DOUBLE" }, { name: "ssts_tr_pbmn", type: "DOUBLE" }, { name: "stnd_vol_smtn", type: "DOUBLE" }, { name: "stnd_tr_pbmn_smtn", type: "DOUBLE" }],
  },
  credit: {
    prefix: SC_CREDIT_PREFIX, dateCol: "deal_date", pageRows: SC_COLLECT_CREDIT_PAGE_ROWS,
    cols: [{ name: "stock_code", type: "STRING" }, { name: "deal_date", type: "STRING" }, { name: "stlm_date", type: "STRING" }, { name: "whol_loan_rmnd_stcn", type: "DOUBLE" }, { name: "whol_loan_rmnd_amt", type: "DOUBLE" }, { name: "whol_loan_rmnd_rate", type: "DOUBLE" }, { name: "whol_stln_rmnd_stcn", type: "DOUBLE" }],
  },
};
interface StockState { cursor: string | null; done: boolean; skipped: boolean; rows: number; requests: number }
interface RunLog { startedAt: string; shortReq: number; creditReq: number; shortRows: number; creditRows: number; stocksDone: number; errors: number; stop: string }
interface Progress { requestsTotal: number; stocks: Record<string, StockState>; runs: RunLog[]; dbBaselineBytes: number | null; bytesPerRow: number | null; stlmOrderViolations: number }

const rowsBy: Record<Kind, Map<number, Map<string, Row>>> = { short: new Map(), credit: new Map() };
const dirty: Record<Kind, Set<number>> = { short: new Set(), credit: new Set() };
const progress: Record<Kind, Progress> = {
  short: { requestsTotal: 0, stocks: {}, runs: [], dbBaselineBytes: null, bytesPerRow: null, stlmOrderViolations: 0 },
  credit: { requestsTotal: 0, stocks: {}, runs: [], dbBaselineBytes: null, bytesPerRow: null, stlmOrderViolations: 0 },
};
const run = { rows: { short: 0, credit: 0 } as Record<Kind, number>, req: { short: 0, credit: 0 } as Record<Kind, number>, errors: 0, consec: 0, stocksDone: 0, outOfRange: 0 };
let stopReason: string | null = null;
let loaded = false;
let lastLog = 0;
let lastCheckpoint = Date.now(), doneSinceCheckpoint = 0;
let storageProjectedLast = 0;
let totalExpectedRows = 0;

// ---------------- Storage ----------------
const bucket = (): ReturnType<typeof supabaseAdmin.storage.from> => supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET);
const yearPath = (k: Kind, y: number): string => `${SPEC[k].prefix}/${y}.parquet`;
const progPath = (k: Kind): string => `${SPEC[k].prefix}/${SC_PROGRESS_FILE}`;
async function download(path: string): Promise<ArrayBuffer | null> {
  const { data, error } = await bucket().download(path);
  if (error) { if (/not found|404/i.test(error.message)) return null; throw new Error(`Storage 다운로드 실패 ${path}: ${error.message}`); }
  return data.arrayBuffer();
}
async function upload(path: string, body: ArrayBuffer | Uint8Array): Promise<void> {
  const { error } = await bucket().upload(path, body, { contentType: "application/octet-stream", upsert: true });
  if (error) throw new Error(`Storage 업로드 실패 ${path}: ${error.message}`);
}
function encodeYear(k: Kind, rows: Map<string, Row>): ArrayBuffer {
  const dc = SPEC[k].dateCol;
  const list = [...rows.values()].sort((a, b) => ((a.stock_code as string) < (b.stock_code as string) ? -1 : (a.stock_code as string) > (b.stock_code as string) ? 1 : (a[dc] as string) < (b[dc] as string) ? -1 : 1));
  return parquetWriteBuffer({
    columnData: SPEC[k].cols.map((c) => c.type === "STRING"
      ? { name: c.name, data: list.map((r) => r[c.name] as string), type: "STRING" as const }
      : { name: c.name, data: list.map((r) => r[c.name] as number | null), type: "DOUBLE" as const, nullable: true }),
  });
}
async function loadStored(): Promise<void> {
  for (const k of ["short", "credit"] as Kind[]) {
    const p = await download(progPath(k));
    if (p) progress[k] = { ...progress[k], ...(JSON.parse(new TextDecoder().decode(p)) as Progress) };
    let n = 0;
    for (let y = SC_FIRST_YEAR; y <= SC_LAST_YEAR; y++) {
      const buf = await download(yearPath(k, y));
      if (!buf) continue;
      const m = new Map<string, Row>();
      for (const r of (await parquetReadObjects({ file: buf })) as Row[]) m.set(`${r.stock_code}|${r[SPEC[k].dateCol]}`, r);
      rowsBy[k].set(y, m); n += m.size;
    }
    const st = Object.values(progress[k].stocks);
    console.log(`저장된 진행[${k === "short" ? "공매도" : "신용잔고"}]: 종목 ${st.length}개(완료 ${st.filter((s) => s.done).length}), 누적 요청 ${progress[k].requestsTotal}, 저장 행 ${n}, 지난 회차 ${progress[k].runs.length}회`);
  }
}
function addRow(k: Kind, r: Row): boolean {
  const dv = r[SPEC[k].dateCol] as string;
  const y = Number(dv.slice(0, 4));
  let m = rowsBy[k].get(y);
  if (!m) { m = new Map(); rowsBy[k].set(y, m); }
  const key = `${r.stock_code}|${dv}`;
  const isNew = !m.has(key);
  m.set(key, r); dirty[k].add(y);
  return isNew;
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
const totalRows = (): number => (["short", "credit"] as Kind[]).reduce((a, k) => a + [...rowsBy[k].values()].reduce((s, m) => s + m.size, 0), 0);
/** 저장 용량 점검: 지금 총량 + (남은 수집 행 + 정리본 사본 행) × 행당 바이트가 상한을 넘으면 true. */
async function storageCheck(why: string): Promise<boolean> {
  const now = await storageTotal();
  const bpr = progress.short.bytesPerRow ?? SC_COLLECT_ASSUMED_BYTES_PER_ROW;
  const have = totalRows();
  const remaining = Math.max(totalExpectedRows - have, 0);
  const projected = now + (remaining + totalExpectedRows) * bpr;
  storageProjectedLast = projected;
  console.log(`  [Storage 점검:${why}] 현재 ${mb(now)} MiB, 행당 ${bpr.toFixed(1)} B(${progress.short.bytesPerRow ? "실측" : "가정"}), 남은 행 ${remaining}, 정리본 포함 예상 최종 ${mb(projected)} MiB / 상한 ${mb(SC_COLLECT_STORAGE_CAP_BYTES)} MiB`);
  if (projected > SC_COLLECT_STORAGE_CAP_BYTES) { stopReason = "Storage 800MB 초과 예상"; return true; }
  return false;
}
async function checkpoint(why: string): Promise<void> {
  let upBytes = 0, upRows = 0;
  for (const k of ["short", "credit"] as Kind[]) {
    for (const y of [...dirty[k]].sort()) { const body = encodeYear(k, rowsBy[k].get(y)!); upBytes += body.byteLength; upRows += rowsBy[k].get(y)!.size; await upload(yearPath(k, y), body); }
    dirty[k].clear();
    await upload(progPath(k), new TextEncoder().encode(JSON.stringify(progress[k])));
  }
  if (upRows > 0) { const b = upBytes / upRows; progress.short.bytesPerRow = b; progress.credit.bytesPerRow = b; }
  lastCheckpoint = Date.now(); doneSinceCheckpoint = 0;
  console.log(`  [저장] ${why}: 연도 파일 갱신, 진행 파일 저장, 누적 요청 ${cumReq()}, 저장 행 ${totalRows()}, KST ${kst()}`);
  if (await storageCheck(why)) console.log("  Storage 예상 초과 — 중단");
}
const cumReq = (): number => progress.short.requestsTotal + progress.credit.requestsTotal;

// ---------------- KIS ----------------
async function waitIfBlocked(): Promise<void> {
  for (;;) {
    const n = new Date(), m = n.getUTCHours() * 60 + n.getUTCMinutes();
    if (m >= INVESTOR_FLOW_BLOCK_UTC_FROM_MIN && m < INVESTOR_FLOW_BLOCK_UTC_TO_MIN) {
      if (Date.now() - T0 >= SC_COLLECT_RUN_MAX_MS) return;
      console.log(`  [대기] KST ${kst()} — 14:00~14:30 호출 금지 시간대, 30초 후 재확인`); await sleep(30_000);
    } else return;
  }
}
function stopCheck(): boolean {
  if (stopReason) return true;
  if (Date.now() - T0 >= SC_COLLECT_RUN_MAX_MS) stopReason = "회차 시간 상한";
  else if (cumReq() >= SC_COLLECT_REQUEST_TOTAL_CAP) stopReason = "요청 누적 상한";
  return stopReason !== null;
}
async function callKis(k: Kind, code: string, params: Record<string, string>): Promise<Rec[] | null> {
  await waitIfBlocked();
  if (stopCheck()) return null;
  const r0 = getKisCallStats().total;
  try {
    const body = k === "short"
      ? await kisGetForResearch(SHORT_PATH, "FHPST04830000", { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code, ...params })
      : await kisGetForResearch(CREDIT_PATH, "FHPST04760000", { FID_COND_MRKT_DIV_CODE: "J", FID_COND_SCR_DIV_CODE: SC_COLLECT_CREDIT_SCR_DIV, FID_INPUT_ISCD: code, ...params });
    run.consec = 0;
    const d = getKisCallStats().total - r0;
    run.req[k] += d; progress[k].requestsTotal += d;
    if (getKisCallStats().retried > 0) stopReason = "rate limit 응답(재시도 발생)";
    return ((k === "short" ? body.output2 : body.output) as Rec[] | undefined) ?? [];
  } catch (e) {
    const d = getKisCallStats().total - r0;
    run.req[k] += d; progress[k].requestsTotal += d;
    const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
    run.errors++; run.consec++;
    console.log(`  [오류 KST ${kst()}] ${k} ${code} ${JSON.stringify(params)}: ${msg} (연속 ${run.consec})`);
    if (/time\s*limit/i.test(msg)) stopReason = "TIME LIMIT 응답";
    else if (/EGW00201|rate\s*limit|too\s*many|초당|429/i.test(msg)) stopReason = "rate limit 응답";
    else if (run.consec >= INVESTOR_FLOW_CONSEC_ERROR_STOP) stopReason = `연속 오류 ${INVESTOR_FLOW_CONSEC_ERROR_STOP}건`;
    if (!stopReason) await sleep(INVESTOR_FLOW_ERROR_RETRY_MS);
    return null;
  }
}

interface Win { lo: string; hi: string; days: number }
/** 한 종목을 최신 방향 앵커에서 과거로 끝까지(또는 중단까지) 받는다. 끝까지 받으면 true. */
async function collectStock(k: Kind, code: string, w: Win): Promise<boolean> {
  const st = progress[k].stocks[code] ?? { cursor: null, done: false, skipped: false, rows: 0, requests: 0 };
  progress[k].stocks[code] = st;
  // 공매도: cursor = 지금까지 받은 가장 이른 거래일, 다음 조회 종료일 = cursor − 1일. 신용잔고: cursor = 가장 이른 결제일, 다음 기준 결제일 = cursor − 1일.
  let anchor = st.cursor ? addDay(st.cursor, -1) : k === "short" ? w.hi : (addDay(w.hi, 5) > SC_COLLECT_TO ? SC_COLLECT_TO : addDay(w.hi, 5));
  for (;;) {
    if (anchor < SC_COLLECT_FROM || (k === "short" && anchor < w.lo)) { st.done = true; return true; }
    const out = await callKis(k, code, k === "short" ? { FID_INPUT_DATE_1: ymd(w.lo), FID_INPUT_DATE_2: ymd(anchor) } : { FID_INPUT_DATE_1: ymd(anchor) });
    if (out === null) { if (stopReason) return false; continue; }
    st.requests++;
    let oldestKey: string | null = null, oldestDeal: string | null = null;
    if (k === "short") {
      const mapped = out.filter((r) => r.stck_bsop_date).map((r) => ({ d: iso(String(r.stck_bsop_date)), r }));
      for (const m of mapped) {
        if (m.d < w.lo || m.d > anchor) { run.outOfRange++; continue; }
        if (addRow("short", { stock_code: code, trade_date: m.d, ssts_cntg_qty: num(m.r.ssts_cntg_qty), ssts_tr_pbmn: num(m.r.ssts_tr_pbmn), stnd_vol_smtn: num(m.r.stnd_vol_smtn), stnd_tr_pbmn_smtn: num(m.r.stnd_tr_pbmn_smtn) })) { run.rows.short++; st.rows++; }
      }
      oldestKey = mapped.length ? mapped.reduce((a, b) => (b.d < a ? b.d : a), mapped[0].d) : null;
      oldestDeal = oldestKey;
    } else {
      const mapped = out.filter((r) => r.deal_date && r.stlm_date).map((r) => ({ deal: iso(String(r.deal_date)), stlm: iso(String(r.stlm_date)), r }));
      for (let i = 1; i < mapped.length; i++) if (!(mapped[i].stlm < mapped[i - 1].stlm)) progress.credit.stlmOrderViolations++;
      for (const m of mapped) {
        if (m.deal < SC_COLLECT_FROM || m.deal > SC_COLLECT_TO) { run.outOfRange++; continue; }
        if (addRow("credit", { stock_code: code, deal_date: m.deal, stlm_date: m.stlm, whol_loan_rmnd_stcn: num(m.r.whol_loan_rmnd_stcn), whol_loan_rmnd_amt: num(m.r.whol_loan_rmnd_amt), whol_loan_rmnd_rate: num(m.r.whol_loan_rmnd_rate), whol_stln_rmnd_stcn: num(m.r.whol_stln_rmnd_stcn) })) { run.rows.credit++; st.rows++; }
      }
      oldestKey = mapped.length ? mapped.reduce((a, b) => (b.stlm < a ? b.stlm : a), mapped[0].stlm) : null;
      oldestDeal = mapped.length ? mapped.reduce((a, b) => (b.deal < a ? b.deal : a), mapped[0].deal) : null;
    }
    if (oldestKey) st.cursor = st.cursor && st.cursor < oldestKey ? st.cursor : oldestKey;
    if (!oldestKey || out.length < SPEC[k].pageRows || (oldestDeal !== null && oldestDeal <= w.lo)) { st.done = true; return true; }
    const next = addDay(oldestKey, -1);
    if (next >= anchor) { st.done = true; return true; }
    anchor = next;
    const rq = run.req.short + run.req.credit;
    if (rq - lastLog >= SC_COLLECT_LOG_EVERY_REQ) { lastLog = rq; console.log(`  진행[${k}]: 요청 ${rq}(누적 ${cumReq()}), 종목 ${code} 최오래 ${oldestKey}, 이번 회차 완료 ${run.stocksDone}종목, KST ${kst()}, 경과 ${((Date.now() - T0) / 60e3).toFixed(0)}분`); }
  }
}

async function main(): Promise<void> {
  console.log(`공매도·신용잔고 수집 회차 시작: ${new Date().toISOString()} (KST ${kst()}) | 요청 누적 상한 ${SC_COLLECT_REQUEST_TOTAL_CAP} | 회차 상한 ${(SC_COLLECT_RUN_MAX_MS / 3600e3).toFixed(2)}시간 | 기간 ${SC_COLLECT_FROM}~${SC_COLLECT_TO}`);
  await loadStored();
  loaded = true;
  if (progress.short.dbBaselineBytes === null) { progress.short.dbBaselineBytes = await dbBytes(); console.log(`DB 크기 기준(첫 회차 시작 시): ${progress.short.dbBaselineBytes} B`); }

  // ---- 대상: 2010-01 이후 한 번이라도 PIT 적격(직전 행 시총 5천억 + 20일 평균 거래대금 5억)이었던 종목 ----
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
    const lo = first > SC_PRICE_DATA_START ? (first > SC_COLLECT_FROM ? first : SC_COLLECT_FROM) : SC_COLLECT_FROM;
    const hi = last < SC_COLLECT_TO ? last : SC_COLLECT_TO;
    const days = rows.filter((r) => r.tradeDate >= lo && r.tradeDate <= hi).length;
    if (lo > hi || days === 0) { noOverlap++; wins.set(code, { lo, hi, days: 0 }); } else wins.set(code, { lo, hi, days });
  }
  pool.sort();
  const active = pool.filter((c) => wins.get(c)!.days > 0);
  for (const k of ["short", "credit"] as Kind[]) for (const c of pool) if (wins.get(c)!.days === 0 && !progress[k].stocks[c]) progress[k].stocks[c] = { cursor: null, done: true, skipped: true, rows: 0, requests: 0 };
  const daysSum = active.reduce((a, c) => a + wins.get(c)!.days, 0);
  totalExpectedRows = daysSum * 2;
  const estShort = active.reduce((a, c) => a + Math.ceil(wins.get(c)!.days / SC_COLLECT_SHORT_PAGE_ROWS), 0);
  const estCredit = active.reduce((a, c) => a + Math.ceil(wins.get(c)!.days / SC_COLLECT_CREDIT_PAGE_ROWS) + 1, 0);
  console.log(`대상 ${pool.length}종목(기간 ${SC_COLLECT_FROM}~${SC_COLLECT_TO}과 주가 구간이 겹치지 않아 요청 없음 ${noOverlap}종목, 요청 대상 ${active.length}종목), 기간 내 주가 행 합계 ${daysSum}`);
  console.log(`예상 요청(주가 거래일 기준 상한): 공매도 ${estShort}, 신용잔고 ${estCredit}, 합계 ${estShort + estCredit} / 상한 ${SC_COLLECT_REQUEST_TOTAL_CAP}`);
  if (await storageCheck("회차 시작")) { stopReason = "Storage 800MB 초과 예상"; }

  const mark = (k: Kind): number => pool.filter((c) => progress[k].stocks[c]?.done).length;
  const startDone = { short: mark("short"), credit: mark("credit") };
  console.log(`회차 시작 시 완료: 공매도 ${startDone.short}/${pool.length}, 신용잔고 ${startDone.credit}/${pool.length}; 수집 순서 = 공매도 전 종목 → 신용잔고, 종목코드 오름차순`);

  outer: for (const k of ["short", "credit"] as Kind[]) {
    if (stopReason) break;
    for (const code of pool) {
      if (progress[k].stocks[code]?.done) continue;
      const w = wins.get(code)!;
      if (w.days === 0) continue;
      if (stopCheck()) break outer;
      const finished = await collectStock(k, code, w);
      if (!finished) break outer;
      run.stocksDone++; doneSinceCheckpoint++;
      if (doneSinceCheckpoint >= INVESTOR_FLOW_CHECKPOINT_STOCKS || Date.now() - lastCheckpoint >= INVESTOR_FLOW_CHECKPOINT_MS) { await checkpoint("주기 저장"); if (stopReason) break outer; }
    }
  }

  const doneS = mark("short"), doneC = mark("credit");
  const partial = (k: Kind): number => pool.filter((c) => progress[k].stocks[c] && !progress[k].stocks[c].done).length;
  const stop = stopReason ?? (doneS === pool.length && doneC === pool.length ? "전 종목 완료" : "알 수 없음");
  const log: RunLog = { startedAt: new Date(T0).toISOString(), shortReq: run.req.short, creditReq: run.req.credit, shortRows: run.rows.short, creditRows: run.rows.credit, stocksDone: run.stocksDone, errors: run.errors, stop };
  progress.short.runs.push(log); progress.credit.runs.push(log);
  await checkpoint("회차 종료");
  const stor = await storageTotal(), db = await dbBytes();
  const rowsOf = (k: Kind): number => [...rowsBy[k].values()].reduce((a, m) => a + m.size, 0);
  const base = progress.short.dbBaselineBytes ?? BASELINE_FALLBACK;
  const allReq = cumReq();
  console.log(`\n=== 회차 결과 ===\n| 항목 | 공매도 | 신용잔고 |\n|---|---|---|\n| 이번 회차 요청 | ${run.req.short} | ${run.req.credit} |\n| 이번 회차 새로 저장한 행 | ${run.rows.short} | ${run.rows.credit} |\n| 누적 완료 종목 | ${doneS}/${pool.length} (${((doneS / pool.length) * 100).toFixed(1)}%) | ${doneC}/${pool.length} (${((doneC / pool.length) * 100).toFixed(1)}%) |\n| 진행 중(중간까지) 종목 | ${partial("short")} | ${partial("credit")} |\n| 기간 겹침 없음(요청 없음) 종목 | ${noOverlap} | ${noOverlap} |\n| 누적 요청 | ${progress.short.requestsTotal} | ${progress.credit.requestsTotal} |\n| 저장 행 누계 | ${rowsOf("short")} | ${rowsOf("credit")} |`);
  console.log(`| 항목 | 값 |\n|---|---|\n| 이번 회차 완료 종목(공매도+신용 합산 횟수) | ${run.stocksDone} |\n| 이번 회차 오류 응답 | ${run.errors} |\n| 이번 회차 기간 밖 행(저장 안 함) | ${run.outOfRange} |\n| 신용잔고 결제일 비단조 쌍(누계) | ${progress.credit.stlmOrderViolations} |\n| 중단 사유 | ${stop} |\n| 누적 요청 합계 | ${allReq}/${SC_COLLECT_REQUEST_TOTAL_CAP} |\n| Storage 총량 | ${stor} B (${mb(stor)} MiB), 정리본 포함 예상 최종 ${mb(storageProjectedLast)} MiB / ${mb(SC_COLLECT_STORAGE_CAP_BYTES)} MiB |\n| DB 전체 | ${db} B (${mb(db)} MiB), 첫 회차 시작 기준 ${base} B 대비 ${db - base >= 0 ? "+" : ""}${db - base} B |\n| 쓴 DB 행 | 0 |\n| 소요 | ${((Date.now() - T0) / 60e3).toFixed(1)}분 |`);
  const remaining = pool.filter((c) => !progress.short.stocks[c]?.done).length;
  if (remaining > 0 && remaining <= 60) console.log(`공매도 남은 종목: ${pool.filter((c) => !progress.short.stocks[c]?.done).join(",")}`);
}

main().catch(async (e) => {
  console.error("실패:", e instanceof Error ? e.message : e, `요청=${getKisCallStats().total}`);
  try { if (loaded) await checkpoint("오류 종료 직전"); } catch (e2) { console.error("종료 직전 저장도 실패:", e2 instanceof Error ? e2.message : e2); }
  process.exit(1);
});

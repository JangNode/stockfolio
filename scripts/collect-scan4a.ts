/**
 * [연구용 — 병합 금지] 신호 스캔 4회차 4-A 수집: (1) 프로그램매매 시장 단위(코스피 K·코스닥 Q, comp-program-trade-daily) 2011-01-03~2026-10-26,
 * (2) 체결강도 = 종목별 일별 매수체결량·매도체결량(inquire-daily-trade-volume) 학습 구간 2011-01-03~2016-12-31, 대상 420종목(수급 수집과 같은 월말 PIT 시총 상위 150 이력, 상장폐지 포함).
 * 사전등록 docs/research/signal-scan-3-prereg.md(확정 b7edd74), 수집 계획 docs/research/signal-scan-3-collection-plan.md. 공시(DART) 사용 없음, 연구 DB 쓰기 0(Storage Parquet만).
 * SCAN4A_MODE=pilot: 시장 단위 전체 + 종목 2개를 메모리로만 받아 점검(Storage 쓰기·읽기 0). collect: 이어받기 수집 → 끝까지 완료되면 정리본 생성·Storage 업로드·Actions 캐시용 디렉터리 출력.
 * 14:00~15:40 KST 호출 금지, 단일 워커 순차 호출, rate limit 5/15/60초 재시도. 키 값 출력 금지, 응답 본문은 요약만.
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
  S4_FLOW_FROM, S4_FLOW_TO, S4_MKT_FROM, S4_MKT_TO, S4_MKT_CODES, S4_MKT_EDGE_DAYS, S4_FLOW_PAGE_ROWS, S4_REQUEST_CAP, S4_RUN_MAX_MS, S4_CHECKPOINT_STOCKS, S4_CHECKPOINT_MS,
  S4_STORAGE_CAP_BYTES, S4_WRITE_BUDGET_BYTES, S4_FLOW_PREFIX, S4_FLOW_CLEAN_PREFIX, S4_MKT_PREFIX, S4_MKT_CLEAN_PREFIX, S4_PROGRESS_FILE, S4_FLOW_STOCK_PROGRESS_PATH, S4_CACHE_DIR,
  S4_FLOW_PATH, S4_FLOW_TR, S4_MKT_PATH, S4_MKT_TR, S4_MKT_VALUE_COLS,
} from "@/lib/scan4aConfig";

const T0 = Date.now();
const MS_DAY = 86_400_000;
const MODE = (process.env.SCAN4A_MODE ?? "").trim().toLowerCase();
if (!["pilot", "collect"].includes(MODE)) throw new Error("SCAN4A_MODE=pilot|collect 필요");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const kst = (d = new Date()): string => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(11, 19);
const iso = (d: string): string => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const ymd = (d: string): string => d.replace(/-/g, "");
const addDay = (d: string, n: number): string => new Date(Date.parse(d) + n * MS_DAY).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;
const num = (v: unknown): number | null => { const s = String(v ?? "").trim(); if (s === "") return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
const mib = (b: number): string => (b / 1048576).toFixed(2);
type Rec = Record<string, unknown>;
type Row = Record<string, string | number | null>;
const io = { readBytes: 0, writeBytes: 0, reads: 0, writes: 0 };

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

// ---------------- Parquet 열 정의 ----------------
interface ColDef { name: string; type: "STRING" | "DOUBLE" }
const FLOW_COLS: ColDef[] = [{ name: "stock_code", type: "STRING" }, { name: "trade_date", type: "STRING" }, { name: "total_shnu_qty", type: "DOUBLE" }, { name: "total_seln_qty", type: "DOUBLE" }];
const MKT_COLS: ColDef[] = [{ name: "market", type: "STRING" }, { name: "trade_date", type: "STRING" }, ...S4_MKT_VALUE_COLS.map((n) => ({ name: n, type: "DOUBLE" as const }))];
function encode(cols: ColDef[], keyCols: [string, string], rows: Row[]): ArrayBuffer {
  const list = [...rows].sort((a, b) => ((a[keyCols[0]] as string) < (b[keyCols[0]] as string) ? -1 : (a[keyCols[0]] as string) > (b[keyCols[0]] as string) ? 1 : (a[keyCols[1]] as string) < (b[keyCols[1]] as string) ? -1 : 1));
  return parquetWriteBuffer({ columnData: cols.map((c) => c.type === "STRING" ? { name: c.name, data: list.map((r) => r[c.name] as string), type: "STRING" as const } : { name: c.name, data: list.map((r) => r[c.name] as number | null), type: "DOUBLE" as const, nullable: true }) });
}
const byYear = (rows: Row[]): Map<number, Row[]> => { const m = new Map<number, Row[]>(); for (const r of rows) { const y = Number(String(r.trade_date).slice(0, 4)); const a = m.get(y); if (a) a.push(r); else m.set(y, [r]); } return m; };

// ---------------- 진행 상태 ----------------
interface StockState { cursor: string | null; done: boolean; rows: number; requests: number }
interface RunLog { startedAt: string; requests: number; completed: number; newRows: number; errors: number; rlEvents: number; stop: string }
interface Progress { requestsTotal: number; stocks: Record<string, StockState>; mkt: Record<string, { cursor: string | null; done: boolean; rows: number; requests: number }>; runs: RunLog[]; errorsTotal: number }
const progress: Progress = { requestsTotal: 0, stocks: {}, mkt: {}, runs: [], errorsTotal: 0 };
const flowRows = new Map<string, Row>(); // key stock|date
const mktRows = new Map<string, Row>(); // key market|date
const dirtyFlowYears = new Set<number>(), dirtyMktYears = new Set<number>();
const run = { req: 0, newRows: 0, errors: 0, consec: 0, rlEvents: 0, rlTimes: [] as number[], rlRetries: 0, rlWaitMs: 0, completed: 0, failedCalls: [] as string[] };
let stopReason: string | null = null;
let lastLog = 0, lastCheckpoint = Date.now(), doneSinceCheckpoint = 0;
const persist = MODE === "collect";

async function loadStored(): Promise<void> {
  const p = await download(`${S4_FLOW_PREFIX}/${S4_PROGRESS_FILE}`);
  if (p) Object.assign(progress, JSON.parse(new TextDecoder().decode(p)) as Progress);
  for (let y = Number(S4_FLOW_FROM.slice(0, 4)); y <= Number(S4_FLOW_TO.slice(0, 4)); y++) {
    const b = await download(`${S4_FLOW_PREFIX}/${y}.parquet`);
    if (b) for (const r of (await parquetReadObjects({ file: b })) as Row[]) flowRows.set(`${r.stock_code}|${r.trade_date}`, r);
  }
  for (let y = Number(S4_MKT_FROM.slice(0, 4)); y <= Number(S4_MKT_TO.slice(0, 4)); y++) {
    const b = await download(`${S4_MKT_PREFIX}/${y}.parquet`);
    if (b) for (const r of (await parquetReadObjects({ file: b })) as Row[]) mktRows.set(`${r.market}|${r.trade_date}`, r);
  }
  console.log(`저장된 진행: 종목 ${Object.keys(progress.stocks).length}개(완료 ${Object.values(progress.stocks).filter((s) => s.done).length}), 시장 ${Object.keys(progress.mkt).length}개, 누적 요청 ${progress.requestsTotal}, 저장 행 체결강도 ${flowRows.size}·시장 ${mktRows.size}, 지난 회차 ${progress.runs.length}회`);
}
async function checkpoint(why: string): Promise<void> {
  if (!persist) return;
  const flowByY = byYear([...flowRows.values()]), mktByY = byYear([...mktRows.values()]);
  for (const y of [...dirtyFlowYears].sort()) await upload(`${S4_FLOW_PREFIX}/${y}.parquet`, encode(FLOW_COLS, ["stock_code", "trade_date"], flowByY.get(y) ?? []));
  for (const y of [...dirtyMktYears].sort()) await upload(`${S4_MKT_PREFIX}/${y}.parquet`, encode(MKT_COLS, ["market", "trade_date"], mktByY.get(y) ?? []));
  dirtyFlowYears.clear(); dirtyMktYears.clear();
  await upload(`${S4_FLOW_PREFIX}/${S4_PROGRESS_FILE}`, new TextEncoder().encode(JSON.stringify(progress)));
  lastCheckpoint = Date.now(); doneSinceCheckpoint = 0;
  console.log(`  [저장] ${why}: 누적 요청 ${progress.requestsTotal}, 저장 행 체결강도 ${flowRows.size}·시장 ${mktRows.size}, 이번 회차 쓴 ${mib(io.writeBytes)} MiB, KST ${kst()}`);
  if (io.writeBytes > S4_WRITE_BUDGET_BYTES * 3) { stopReason = "쓰기 누적 예산 초과"; }
}

// ---------------- KIS ----------------
async function waitIfBlocked(): Promise<void> {
  for (;;) {
    const n = new Date(), m = n.getUTCHours() * 60 + n.getUTCMinutes();
    if (m >= SC_COLLECT_BLOCK_UTC_FROM_MIN && m < SC_COLLECT_BLOCK_UTC_TO_MIN) {
      if (Date.now() - T0 >= S4_RUN_MAX_MS) return;
      console.log(`  [대기] KST ${kst()} — 14:00~15:40 호출 금지 시간대, 30초 후 재확인`); await sleep(30_000);
    } else return;
  }
}
function stopCheck(): boolean {
  if (stopReason) return true;
  if (Date.now() - T0 >= S4_RUN_MAX_MS) stopReason = "회차 시간 상한";
  else if (progress.requestsTotal >= S4_REQUEST_CAP) stopReason = "요청 누적 상한";
  return stopReason !== null;
}
const isRateLimitMsg = (msg: string): boolean => /EGW00201|rate\s*limit|too\s*many|초당|429/i.test(msg);
async function callKis(label: string, p: string, tr: string, params: Record<string, string>): Promise<Rec[] | null> {
  for (let rl = 0; ; rl++) {
    await waitIfBlocked();
    if (stopCheck()) return null;
    const r0 = getKisCallStats().total;
    try {
      const body = await kisGetForResearch(p, tr, params, 0);
      run.consec = 0;
      const d = getKisCallStats().total - r0; run.req += d; progress.requestsTotal += d;
      const arr = (body.output2 ?? body.output) as Rec[] | undefined;
      return arr ?? [];
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

// ---------------- 수집 ----------------
/** 프로그램매매 시장 단위: 시장별로 달력 연도 구간(조회 시작·종료)을 최신 방향으로 받는다. 한 구간에서 가장 이른 날이 시작일 + 10일 이내이면 끝. */
async function collectMarket(code: string, sink: Map<string, Row>, dirty: Set<number>): Promise<boolean> {
  const st = progress.mkt[code] ?? { cursor: null, done: false, rows: 0, requests: 0 };
  progress.mkt[code] = st;
  if (st.done) return true;
  let anchor = st.cursor ? addDay(st.cursor, -1) : S4_MKT_TO;
  for (;;) {
    if (anchor < S4_MKT_FROM) { st.done = true; return true; }
    const yearStart = `${anchor.slice(0, 4)}-01-01`;
    const lo = yearStart < S4_MKT_FROM ? S4_MKT_FROM : yearStart;
    const out = await callKis(`시장 ${code} ${lo}~${anchor}`, S4_MKT_PATH, S4_MKT_TR, { FID_COND_MRKT_DIV_CODE: "J", FID_MRKT_CLS_CODE: code, FID_INPUT_DATE_1: ymd(lo), FID_INPUT_DATE_2: ymd(anchor) });
    if (out === null) { if (stopReason) return false; continue; }
    st.requests++;
    const mapped = out.filter((r) => r.stck_bsop_date).map((r) => ({ d: iso(String(r.stck_bsop_date)), r }));
    for (const m of mapped) {
      if (m.d < lo || m.d > anchor) continue;
      const row: Row = { market: code, trade_date: m.d };
      for (const c of S4_MKT_VALUE_COLS) row[c] = num(m.r[c]);
      const key = `${code}|${m.d}`;
      if (!sink.has(key)) { run.newRows++; st.rows++; }
      sink.set(key, row); dirty.add(Number(m.d.slice(0, 4)));
    }
    const oldest = mapped.length ? mapped.reduce((a, b) => (b.d < a ? b.d : a), mapped[0].d) : null;
    if (oldest) st.cursor = st.cursor && st.cursor < oldest ? st.cursor : oldest;
    if (!oldest || dayDiff(lo, oldest) <= S4_MKT_EDGE_DAYS) {
      // 이 연도 구간 끝 → 다음 구간은 전년도 12-31부터
      st.cursor = lo; anchor = addDay(lo, -1);
    } else anchor = addDay(oldest, -1);
  }
}
async function collectStock(code: string, lo: string, hi: string, sink: Map<string, Row>, dirty: Set<number>): Promise<boolean> {
  const st = progress.stocks[code] ?? { cursor: null, done: false, rows: 0, requests: 0 };
  progress.stocks[code] = st;
  if (st.done) return true;
  let anchor = st.cursor ? addDay(st.cursor, -1) : hi;
  for (;;) {
    if (anchor < lo) { st.done = true; return true; }
    const out = await callKis(`체결강도 ${code} ${lo}~${anchor}`, S4_FLOW_PATH, S4_FLOW_TR, { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code, FID_PERIOD_DIV_CODE: "D", FID_INPUT_DATE_1: ymd(lo), FID_INPUT_DATE_2: ymd(anchor) });
    if (out === null) { if (stopReason) return false; continue; }
    st.requests++;
    const mapped = out.filter((r) => r.stck_bsop_date).map((r) => ({ d: iso(String(r.stck_bsop_date)), r }));
    for (const m of mapped) {
      if (m.d < lo || m.d > anchor) continue;
      const key = `${code}|${m.d}`;
      if (!sink.has(key)) { run.newRows++; st.rows++; }
      sink.set(key, { stock_code: code, trade_date: m.d, total_shnu_qty: num(m.r.total_shnu_qty), total_seln_qty: num(m.r.total_seln_qty) });
      dirty.add(Number(m.d.slice(0, 4)));
    }
    const oldest = mapped.length ? mapped.reduce((a, b) => (b.d < a ? b.d : a), mapped[0].d) : null;
    if (oldest) st.cursor = st.cursor && st.cursor < oldest ? st.cursor : oldest;
    if (!oldest || out.length < S4_FLOW_PAGE_ROWS || oldest <= lo) { st.done = true; return true; }
    const next = addDay(oldest, -1);
    if (next >= anchor) { st.done = true; return true; }
    anchor = next;
    if (run.req - lastLog >= SC_COLLECT_LOG_EVERY_REQ) { lastLog = run.req; console.log(`  진행: 요청 ${run.req}(누적 ${progress.requestsTotal}), 종목 ${code} 최오래 ${oldest}, 이번 회차 완료 ${run.completed}종목, KST ${kst()}, 경과 ${((Date.now() - T0) / 60e3).toFixed(0)}분`); }
  }
}

async function main(): Promise<void> {
  console.log(`신호 스캔 4-A 수집(${MODE}) 시작: ${new Date().toISOString()} (KST ${kst()}) | 요청 상한 ${S4_REQUEST_CAP} | 회차 상한 ${(S4_RUN_MAX_MS / 3600e3).toFixed(2)}시간 | 체결강도 ${S4_FLOW_FROM}~${S4_FLOW_TO}, 시장 ${S4_MKT_FROM}~${S4_MKT_TO}`);
  const storageStart = persist ? await storageTotal() : 0;
  if (persist) { console.log(`Storage 총량(시작): ${mib(storageStart)} MiB / 상한 ${mib(S4_STORAGE_CAP_BYTES)} MiB`); await loadStored(); }

  // ---- 대상 420종목 (collect-investor-flow-stock.ts와 같은 규칙) ----
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear()); // 조정 없는 원본 행(거래량 대조용)
  const calSet = new Set<string>(); let lastDate = "";
  for (const rows of series.values()) for (const r of rows) { if (r.tradeDate >= "2010-01-01") calSet.add(r.tradeDate); if (r.tradeDate > lastDate) lastDate = r.tradeDate; }
  const cal = [...calSet].sort();
  const monthEnd = new Set<string>();
  for (let k = 0; k + 1 < cal.length; k++) if (cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7)) monthEnd.add(cal[k]);
  const mcapAt = new Map<string, { code: string; mc: number }[]>();
  const lastRow = new Map<string, string>(), firstRow = new Map<string, string>();
  const priceDays = new Map<string, Map<string, number>>(); // code -> date -> raw volume (close>0 인 날만)
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
  for (const code of pool) { const m = new Map<string, number>(); for (const r of series.get(code) ?? []) if (r.closePrice > 0 && r.tradeDate >= "2010-01-01") m.set(r.tradeDate, r.volume); priceDays.set(code, m); }
  series.clear();
  const endedBefore = new Date(Date.parse(lastDate) - INVESTOR_FLOW_ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  const isDelisted = (c: string): boolean => (lastRow.get(c) ?? "9999") < endedBefore;
  const winOf = (c: string): { lo: string; hi: string } | null => {
    const first = firstRow.get(c) as string, last = lastRow.get(c) as string;
    const lo = first > S4_FLOW_FROM ? first : S4_FLOW_FROM, hi = last < S4_FLOW_TO ? last : S4_FLOW_TO;
    return lo > hi ? null : { lo, hi };
  };
  const active = pool.filter((c) => winOf(c) !== null);
  console.log(`대상 ${pool.length}종목(상장폐지 ${pool.filter(isDelisted).length}개), 수집 기간과 주가 구간이 겹치는 종목 ${active.length}개, 가격 스냅샷 마지막 날 ${lastDate}`);
  // 수급 수집 진행 파일과 종목 집합 대조(약 24 KB 읽기)
  const fp = await download(S4_FLOW_STOCK_PROGRESS_PATH);
  if (fp) {
    const set = new Set(Object.keys((JSON.parse(new TextDecoder().decode(fp)) as { stocks: Record<string, unknown> }).stocks));
    const onlyHere = pool.filter((c) => !set.has(c)), onlyThere = [...set].filter((c) => !pool.includes(c));
    console.log(`대상 집합 대조(수급 수집 진행 파일 ${set.size}종목): 이번에만 ${onlyHere.length}개${onlyHere.length ? `(${onlyHere.slice(0, 10).join(",")})` : ""}, 수급 쪽에만 ${onlyThere.length}개${onlyThere.length ? `(${onlyThere.slice(0, 10).join(",")})` : ""} → ${onlyHere.length === 0 && onlyThere.length === 0 ? "일치" : "불일치"}`);
  } else console.log("수급 수집 진행 파일 없음 — 대조 생략");

  // ---- 시장 단위 ----
  if (MODE === "pilot") {
    const sink = new Map<string, Row>(), dirty = new Set<number>();
    for (const code of S4_MKT_CODES) { progress.mkt[code] = { cursor: null, done: false, rows: 0, requests: 0 }; await collectMarket(code, sink, dirty); }
    const perMkt = (c: string): Row[] => [...sink.values()].filter((r) => r.market === c);
    for (const c of S4_MKT_CODES) { const rs = perMkt(c).sort((a, b) => ((a.trade_date as string) < (b.trade_date as string) ? -1 : 1)); const calDays = cal.filter((d) => d >= S4_MKT_FROM && d <= S4_MKT_TO).length; console.log(`  [파일럿 시장 ${c}] 행 ${rs.length}(가격 달력 거래일 ${calDays}), ${rs[0]?.trade_date}~${rs[rs.length - 1]?.trade_date}, 필드 존재: ${S4_MKT_VALUE_COLS.map((n) => `${n}=${rs.filter((r) => r[n] !== null).length}`).join(" ")}`); }
    // 종목 2개: 005930, 폐지 1개
    const picks = ["005930", pool.find((c) => isDelisted(c) && winOf(c) !== null && (priceDays.get(c)?.size ?? 0) > 200) as string].filter(Boolean);
    for (const code of picks) {
      const w = winOf(code) as { lo: string; hi: string };
      progress.stocks[code] = { cursor: null, done: false, rows: 0, requests: 0 };
      const s2 = new Map<string, Row>(), d2 = new Set<number>();
      await collectStock(code, w.lo, w.hi, s2, d2);
      const rows = [...s2.values()], pd = priceDays.get(code) as Map<string, number>;
      const inWin = [...pd.keys()].filter((d) => d >= w.lo && d <= w.hi);
      const have = new Set(rows.map((r) => r.trade_date as string));
      const missing = inWin.filter((d) => !have.has(d)).length, extra = rows.filter((r) => !pd.has(r.trade_date as string)).length;
      const zero = rows.filter((r) => (r.total_shnu_qty ?? 0) === 0 && (r.total_seln_qty ?? 0) === 0).length;
      const ratios = rows.map((r) => ({ d: r.trade_date as string, q: ((r.total_shnu_qty as number) + (r.total_seln_qty as number)) / (pd.get(r.trade_date as string) || NaN) })).filter((x) => Number.isFinite(x.q)).map((x) => x.q).sort((a, b) => a - b);
      console.log(`  [파일럿 종목 ${code}${isDelisted(code) ? "(상장폐지)" : ""}] 기간 ${w.lo}~${w.hi}, 요청 ${progress.stocks[code].requests}, 행 ${rows.length}, 가격 거래일 ${inWin.length} 중 체결량 없음 ${missing}, 가격 없는 날 행 ${extra}, 값 둘 다 0 ${zero}, (매수+매도)/거래량 중앙값 ${(ratios[Math.floor(ratios.length / 2)] ?? NaN).toFixed(3)}, 5분위 ${(ratios[Math.floor(ratios.length * 0.05)] ?? NaN).toFixed(3)}, 95분위 ${(ratios[Math.floor(ratios.length * 0.95)] ?? NaN).toFixed(3)}, 1 초과 ${ratios.filter((q) => q > 1).length}`);
    }
    console.log(`\n파일럿 종료: 요청 ${run.req}, 오류 ${run.errors}, rate limit ${run.rlEvents} | Storage 읽기 ${mib(io.readBytes)} MiB(${io.reads}건, 수급 진행 파일 포함), 쓰기 0 | 소요 ${((Date.now() - T0) / 60e3).toFixed(1)}분`);
    return;
  }

  console.log(`수집 순서: 프로그램매매 시장 단위(K, Q) → 체결강도 종목코드 오름차순. 예상 요청: 시장 약 34 + 체결강도 약 ${active.reduce((a, c) => { const w = winOf(c) as { lo: string; hi: string }; const d = cal.filter((x) => x >= w.lo && x <= w.hi).length; return a + Math.ceil(d / S4_FLOW_PAGE_ROWS); }, 0)}`);
  for (const code of S4_MKT_CODES) { if (stopCheck()) break; await collectMarket(code, mktRows, dirtyMktYears); await checkpoint(`시장 ${code}`); }
  const startDone = active.filter((c) => progress.stocks[c]?.done).length;
  console.log(`체결강도 회차 시작 시 완료 ${startDone}/${active.length}`);
  for (const code of active) {
    if (progress.stocks[code]?.done) continue;
    if (stopCheck()) break;
    const w = winOf(code) as { lo: string; hi: string };
    const finished = await collectStock(code, w.lo, w.hi, flowRows, dirtyFlowYears);
    if (finished) { run.completed++; doneSinceCheckpoint++; }
    else break;
    if (doneSinceCheckpoint >= S4_CHECKPOINT_STOCKS || Date.now() - lastCheckpoint >= S4_CHECKPOINT_MS) await checkpoint("주기 저장");
  }
  const doneNow = active.filter((c) => progress.stocks[c]?.done).length;
  const allMkt = S4_MKT_CODES.every((c) => progress.mkt[c]?.done);
  const complete = doneNow === active.length && allMkt;
  progress.runs.push({ startedAt: new Date(T0).toISOString(), requests: run.req, completed: run.completed, newRows: run.newRows, errors: run.errors, rlEvents: run.rlEvents, stop: stopReason ?? (complete ? "전 종목 완료" : "알 수 없음") });
  await checkpoint("회차 종료");
  console.log(`\n=== 회차 결과 ===\n이번 회차 요청 ${run.req}(rate limit 응답 ${run.rlEvents}회, 재시도 ${run.rlRetries}회 대기 ${(run.rlWaitMs / 1000).toFixed(0)}초), 새로 저장한 행 ${run.newRows}, 오류 응답 ${run.errors}, 완료 종목 ${doneNow}/${active.length}, 시장 ${allMkt ? "완료" : "미완"}, 중단 사유 ${stopReason ?? (complete ? "없음(전부 완료)" : "알 수 없음")}`);
  if (run.failedCalls.length) console.log(`호출 실패 목록(앞 20개): ${run.failedCalls.slice(0, 20).join(" | ")}`);
  if (!complete) { console.log(`미완 — 같은 워크플로를 다시 실행하면 진행 파일로 이어받는다 | Storage 읽기 ${mib(io.readBytes)} MiB, 쓰기 ${mib(io.writeBytes)} MiB`); return; }

  // =================== 정리본 + 점검 ===================
  console.log(`\n=== 정리본 생성 (가격 Parquet의 종목별 거래일[종가>0]과 대조) ===`);
  const cleanFlow: Row[] = [];
  let rawFlow = 0, dropNoPrice = 0, dropOutRange = 0, dropNull = 0;
  for (const r of flowRows.values()) {
    rawFlow++;
    const code = r.stock_code as string, d = r.trade_date as string, pd = priceDays.get(code);
    if (d < S4_FLOW_FROM || d > S4_FLOW_TO) { dropOutRange++; continue; }
    if (!pd || !pd.has(d)) { dropNoPrice++; continue; }
    if (r.total_shnu_qty === null || r.total_seln_qty === null) { dropNull++; continue; }
    cleanFlow.push(r);
  }
  const cleanMkt = [...mktRows.values()].filter((r) => (r.trade_date as string) >= S4_MKT_FROM && (r.trade_date as string) <= S4_MKT_TO);
  console.log(`체결강도 원본 ${rawFlow}행 → 정리본 ${cleanFlow.length}행 (기간 밖 ${dropOutRange}, 가격 없는 날 ${dropNoPrice}, 값 없음 ${dropNull}) | 시장 단위 원본 ${mktRows.size}행 → ${cleanMkt.length}행`);
  // 점검
  const byStock = new Map<string, Row[]>();
  for (const r of cleanFlow) { const a = byStock.get(r.stock_code as string); if (a) a.push(r); else byStock.set(r.stock_code as string, [r]); }
  let allZero = 0, allZeroDelisted = 0;
  for (const c of active) { const rs = byStock.get(c) ?? []; const z = !rs.some((r) => (r.total_shnu_qty as number) !== 0 || (r.total_seln_qty as number) !== 0); if (z) { allZero++; if (isDelisted(c)) allZeroDelisted++; } }
  const noRows = active.filter((c) => !(byStock.get(c)?.length)).length;
  const yearStat = new Map<number, { price: number; have: number; zero: number; over: number; neg: number }>();
  const ratios: number[] = [];
  let priceDaysTotal = 0, haveTotal = 0;
  for (const c of active) {
    const w = winOf(c) as { lo: string; hi: string };
    const pd = priceDays.get(c) as Map<string, number>;
    const have = new Map((byStock.get(c) ?? []).map((r) => [r.trade_date as string, r]));
    for (const [d, vol] of pd) {
      if (d < w.lo || d > w.hi) continue;
      const y = Number(d.slice(0, 4)); const ys = yearStat.get(y) ?? { price: 0, have: 0, zero: 0, over: 0, neg: 0 }; yearStat.set(y, ys);
      ys.price++; priceDaysTotal++;
      const r = have.get(d);
      if (!r) continue;
      ys.have++; haveTotal++;
      const b = r.total_shnu_qty as number, s = r.total_seln_qty as number;
      if (b === 0 && s === 0) ys.zero++;
      if (b < 0 || s < 0) ys.neg++;
      if (vol > 0) { const q = (b + s) / vol; ratios.push(q); if (q > 1) ys.over++; }
    }
  }
  ratios.sort((a, b) => a - b);
  console.log(`\n=== 점검 ===\n요청 대상 ${active.length}종목 중 정리본 행이 하나도 없는 종목 ${noRows}, 값이 전부 0인 종목 ${allZero}(${((allZero / active.length) * 100).toFixed(2)}%, 그중 상장폐지 ${allZeroDelisted}), 상장폐지 종목 포함 ${active.filter(isDelisted).length}개 요청·${active.filter((c) => isDelisted(c) && (byStock.get(c)?.length ?? 0) > 0).length}개 행 있음`);
  console.log(`가격이 있는 종목-일 ${priceDaysTotal} 중 체결량 없음 ${priceDaysTotal - haveTotal}(${(((priceDaysTotal - haveTotal) / priceDaysTotal) * 100).toFixed(2)}%)`);
  console.log(`| 연도 | 가격 있는 종목-일 | 체결량 있음 | 없음 % | 값 둘 다 0 | 음수 | (매수+매도)>거래량 |\n|---|---|---|---|---|---|---|`);
  for (const [y, s] of [...yearStat].sort((a, b) => a[0] - b[0])) console.log(`| ${y} | ${s.price} | ${s.have} | ${(((s.price - s.have) / s.price) * 100).toFixed(2)} | ${s.zero} | ${s.neg} | ${s.over} |`);
  const q = (p: number): string => (ratios[Math.min(Math.floor(ratios.length * p), ratios.length - 1)] ?? NaN).toFixed(3);
  console.log(`체결량 합계 검증: (매수체결량+매도체결량) ÷ 가격 Parquet 거래량 — 표본 ${ratios.length}, 5분위 ${q(0.05)}, 중앙값 ${q(0.5)}, 95분위 ${q(0.95)}, 최대 ${(ratios[ratios.length - 1] ?? NaN).toFixed(3)}, 1 초과 ${ratios.filter((x) => x > 1).length}건(${((ratios.filter((x) => x > 1).length / Math.max(ratios.length, 1)) * 100).toFixed(3)}%)`);
  const mk = new Map<string, Row[]>();
  for (const r of cleanMkt) { const a = mk.get(r.market as string); if (a) a.push(r); else mk.set(r.market as string, [r]); }
  const calRange = cal.filter((d) => d >= S4_MKT_FROM && d <= S4_MKT_TO);
  for (const [m, rs] of mk) { const have = new Set(rs.map((r) => r.trade_date as string)); const miss = calRange.filter((d) => !have.has(d)); const zeroWhol = rs.filter((r) => ((r.whol_smtn_shnu_tr_pbmn as number) ?? 0) === 0 && ((r.whol_smtn_seln_tr_pbmn as number) ?? 0) === 0).length; console.log(`프로그램매매 시장 ${m}: 행 ${rs.length}, 가격 달력 거래일 ${calRange.length} 중 없는 날 ${miss.length}${miss.length ? `(${miss.slice(0, 5).join(",")}…)` : ""}, 전체 매수·매도 모두 0인 날 ${zeroWhol}, 값 없음(NULL) 포함 행 ${rs.filter((r) => S4_MKT_VALUE_COLS.some((c) => r[c] === null)).length}`); }

  // 정리본 저장: Storage + Actions 캐시용 디렉터리
  const outDir = S4_CACHE_DIR;
  await fsp.mkdir(path.join(outDir, "exec_strength_clean"), { recursive: true });
  await fsp.mkdir(path.join(outDir, "program_trade_market_clean"), { recursive: true });
  const manifest: { files: { path: string; rows: number; bytes: number; sha256: string }[]; stocks: string[]; delisted: string[]; createdAt: string } = { files: [], stocks: active, delisted: active.filter(isDelisted), createdAt: new Date().toISOString() };
  let cleanBytes = 0;
  for (const [y, rs] of [...byYear(cleanFlow)].sort((a, b) => a[0] - b[0])) {
    const body = encode(FLOW_COLS, ["stock_code", "trade_date"], rs), p = `exec_strength_clean/${y}.parquet`;
    await fsp.writeFile(path.join(outDir, p), Buffer.from(body));
    manifest.files.push({ path: p, rows: rs.length, bytes: body.byteLength, sha256: createHash("sha256").update(Buffer.from(body)).digest("hex") }); cleanBytes += body.byteLength;
    await upload(`${S4_FLOW_CLEAN_PREFIX}/${y}.parquet`, body);
  }
  for (const [y, rs] of [...byYear(cleanMkt)].sort((a, b) => a[0] - b[0])) {
    const body = encode(MKT_COLS, ["market", "trade_date"], rs), p = `program_trade_market_clean/${y}.parquet`;
    await fsp.writeFile(path.join(outDir, p), Buffer.from(body));
    manifest.files.push({ path: p, rows: rs.length, bytes: body.byteLength, sha256: createHash("sha256").update(Buffer.from(body)).digest("hex") }); cleanBytes += body.byteLength;
    await upload(`${S4_MKT_CLEAN_PREFIX}/${y}.parquet`, body);
  }
  await fsp.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1));
  const storageEnd = await storageTotal();
  console.log(`\n정리본 ${manifest.files.length}개 파일 ${mib(cleanBytes)} MiB(체결강도 ${mib(manifest.files.filter((f) => f.path.startsWith("exec")).reduce((a, f) => a + f.bytes, 0))} + 시장 ${mib(manifest.files.filter((f) => f.path.startsWith("prog")).reduce((a, f) => a + f.bytes, 0))}), 행당 ${(cleanBytes / Math.max(cleanFlow.length + cleanMkt.length, 1)).toFixed(1)} B | 캐시 디렉터리 ${outDir}`);
  const rawList = (await bucket().list(S4_FLOW_PREFIX, { limit: 100 })).data ?? [];
  const rawBytes = rawList.filter((e) => /^\d{4}\.parquet$/.test(e.name)).reduce((a, e) => a + Number((e.metadata as { size?: number } | null)?.size ?? 0), 0);
  console.log(`Storage 총량: 시작 ${mib(storageStart)} → 끝 ${mib(storageEnd)} MiB (+${mib(storageEnd - storageStart)} MiB, 쓰기 예산 ${mib(S4_WRITE_BUDGET_BYTES)} MiB), 체결강도 원본 파일 합계 ${mib(rawBytes)} MiB | 이번 회차 Storage 읽기 ${mib(io.readBytes)} MiB(${io.reads}건), 업로드 ${mib(io.writeBytes)} MiB(${io.writes}건, 덮어쓰기 포함)`);
  if (storageEnd > S4_STORAGE_CAP_BYTES) console.log("경고: Storage 총량 상한 초과");
  console.log(`DB 쓰기 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60e3).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

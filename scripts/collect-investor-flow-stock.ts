/**
 * [연구용] 투자자별 수급 2단계 B: 2010~ 월말 PIT 시총 상위 150에 한 번이라도 든 종목의 종목별 투자자 순매수(FHPTJ04160001)를
 * Supabase Storage 연도별 Parquet(research/investor_flow_stock/YYYY.parquet)에 저장한다. DB 표 쓰기 없음(시험 표 읽기만).
 * 이어받기: Storage의 진행 파일(_progress.json)과 연도 Parquet로 이미 받은 종목·날짜를 건너뛴다. 14:00~14:30 KST 호출 금지.
 * 중단 조건: 연속 오류 응답 20건, rate limit·TIME LIMIT 응답, 요청 누적 상한, 회차 시간 상한. 백테스트 없음. 키 값 출력 금지.
 */
import { parquetWriteBuffer } from "hyparquet-writer";
import { parquetReadObjects } from "hyparquet";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { kisGetForResearch, getKisCallStats } from "@/lib/kis";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import {
  INVESTOR_FLOW_TO, INVESTOR_FLOW_STOCK_PAGE_ROWS, INVESTOR_FLOW_STOCK_FROM, INVESTOR_FLOW_TOP_N, INVESTOR_FLOW_ENDED_GRACE_DAYS,
  INVESTOR_FLOW_BLOCK_UTC_FROM_MIN, INVESTOR_FLOW_BLOCK_UTC_TO_MIN, INVESTOR_FLOW_STOCK_REQUEST_TOTAL_CAP, INVESTOR_FLOW_CONSEC_ERROR_STOP,
  INVESTOR_FLOW_STOCK_RUN_MAX_MS, INVESTOR_FLOW_STOCK_STORE_BUCKET, INVESTOR_FLOW_STOCK_STORE_PREFIX, INVESTOR_FLOW_STOCK_FIRST_YEAR,
  INVESTOR_FLOW_CHECKPOINT_STOCKS, INVESTOR_FLOW_CHECKPOINT_MS, INVESTOR_FLOW_ERROR_RETRY_MS,
} from "@/lib/investorFlowConfig";

const T0 = Date.now();
const MS_DAY = 86_400_000;
const STK = "/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily";
const PROGRESS_PATH = `${INVESTOR_FLOW_STOCK_STORE_PREFIX}/_progress.json`;
const LAST_YEAR = Number(INVESTOR_FLOW_TO.slice(0, 4));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const kst = (d = new Date()): string => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(11, 19);
const iso = (d: string): string => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const ymd = (d: string): string => d.replace(/-/g, "");
const prevDay = (d: string): string => new Date(Date.parse(d) - MS_DAY).toISOString().slice(0, 10);
const num = (v: unknown): number | null => { const s = String(v ?? "").trim(); if (s === "") return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
type Rec = Record<string, unknown>;

interface Row { stock_code: string; trade_date: string; frgn_ntby_amt: number | null; orgn_ntby_amt: number | null; prsn_ntby_amt: number | null; frgn_ntby_qty: number | null }
interface StockState { oldest: string | null; done: boolean; rows: number }
interface RunLog { startedAt: string; requests: number; completed: number; newRows: number; errors: number; stop: string }
interface Progress { seeded: boolean; requestsTotal: number; stocks: Record<string, StockState>; runs: RunLog[] }

const byYear = new Map<number, Map<string, Row>>();
const dirtyYears = new Set<number>();
let progress: Progress = { seeded: false, requestsTotal: 0, stocks: {}, runs: [] };
let runNewRows = 0, runErrors = 0, runCompleted = 0, consecErrors = 0;
let stopReason: string | null = null;
let loaded = false;
const completedCodes: string[] = [];
let lastLogReq = 0;
/** 이번 회차의 KIS 요청 수(재시도 포함 HTTP 시도 전부). */
const runRequests = (): number => getKisCallStats().total;
let dbPilotRead = 0;

// ---------------- Storage ----------------
const bucket = (): ReturnType<typeof supabaseAdmin.storage.from> => supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET);
const yearPath = (y: number): string => `${INVESTOR_FLOW_STOCK_STORE_PREFIX}/${y}.parquet`;
async function download(path: string): Promise<ArrayBuffer | null> {
  const { data, error } = await bucket().download(path);
  if (error) { if (/not found|404/i.test(error.message)) return null; throw new Error(`Storage 다운로드 실패 ${path}: ${error.message}`); }
  return data.arrayBuffer();
}
async function upload(path: string, body: ArrayBuffer | Uint8Array): Promise<void> {
  const { error } = await bucket().upload(path, body, { contentType: "application/octet-stream", upsert: true });
  if (error) throw new Error(`Storage 업로드 실패 ${path}: ${error.message}`);
}
function encodeYear(rows: Map<string, Row>): ArrayBuffer {
  const list = [...rows.values()].sort((a, b) => (a.stock_code < b.stock_code ? -1 : a.stock_code > b.stock_code ? 1 : a.trade_date < b.trade_date ? -1 : 1));
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
async function loadStored(): Promise<void> {
  const p = await download(PROGRESS_PATH);
  if (p) progress = JSON.parse(new TextDecoder().decode(p)) as Progress;
  let n = 0;
  for (let y = INVESTOR_FLOW_STOCK_FIRST_YEAR; y <= LAST_YEAR; y++) {
    const buf = await download(yearPath(y));
    if (!buf) continue;
    const m = new Map<string, Row>();
    for (const r of (await parquetReadObjects({ file: buf })) as Row[]) m.set(`${r.stock_code}|${r.trade_date}`, r);
    byYear.set(y, m); n += m.size;
  }
  console.log(`저장된 진행: 종목 ${Object.keys(progress.stocks).length}개(완료 ${Object.values(progress.stocks).filter((s) => s.done).length}), 누적 요청 ${progress.requestsTotal}, 저장 행 ${n}, 지난 회차 ${progress.runs.length}회`);
}
function addRow(r: Row): boolean {
  const y = Number(r.trade_date.slice(0, 4));
  let m = byYear.get(y);
  if (!m) { m = new Map(); byYear.set(y, m); }
  const k = `${r.stock_code}|${r.trade_date}`;
  const isNew = !m.has(k);
  m.set(k, r); dirtyYears.add(y);
  return isNew;
}
let lastCheckpoint = Date.now(), completedSinceCheckpoint = 0;
async function checkpoint(why: string): Promise<void> {
  progress.requestsTotal = reqBase + runRequests();
  for (const y of [...dirtyYears].sort()) await upload(yearPath(y), encodeYear(byYear.get(y)!));
  const n = dirtyYears.size; dirtyYears.clear();
  await upload(PROGRESS_PATH, new TextEncoder().encode(JSON.stringify(progress)));
  lastCheckpoint = Date.now(); completedSinceCheckpoint = 0;
  console.log(`  [저장] ${why}: 연도 파일 ${n}개 갱신, 진행 파일 저장, 누적 요청 ${progress.requestsTotal}, KST ${kst()}`);
}
let reqBase = 0;

// ---------------- KIS ----------------
async function waitIfBlocked(): Promise<void> {
  for (;;) {
    const n = new Date(), m = n.getUTCHours() * 60 + n.getUTCMinutes();
    if (m >= INVESTOR_FLOW_BLOCK_UTC_FROM_MIN && m < INVESTOR_FLOW_BLOCK_UTC_TO_MIN) {
      if (Date.now() - T0 >= INVESTOR_FLOW_STOCK_RUN_MAX_MS) return;
      console.log(`  [대기] KST ${kst()} — 14:00~14:30 호출 금지 시간대, 30초 후 재확인`); await sleep(30_000);
    } else return;
  }
}
function stopCheck(): boolean {
  if (stopReason) return true;
  if (Date.now() - T0 >= INVESTOR_FLOW_STOCK_RUN_MAX_MS) stopReason = "회차 시간 상한";
  else if (reqBase + runRequests() >= INVESTOR_FLOW_STOCK_REQUEST_TOTAL_CAP) stopReason = "요청 누적 상한";
  return stopReason !== null;
}
async function callPage(code: string, anchor: string): Promise<Rec[] | null> {
  await waitIfBlocked();
  if (stopCheck()) return null;
  try {
    const body = await kisGetForResearch(STK, "FHPTJ04160001", { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code, FID_INPUT_DATE_1: anchor, FID_ORG_ADJ_PRC: "", FID_ETC_CLS_CODE: "" });
    consecErrors = 0;
    if (getKisCallStats().retried > 0) stopReason = "rate limit 응답(재시도 발생)";
    return (body.output2 as Rec[] | undefined) ?? [];
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
    runErrors++; consecErrors++;
    console.log(`  [오류 KST ${kst()}] ${code} ${anchor}: ${msg} (연속 ${consecErrors})`);
    if (/time\s*limit/i.test(msg)) stopReason = "TIME LIMIT 응답";
    else if (/EGW00201|rate\s*limit|too\s*many|초당|429/i.test(msg)) stopReason = "rate limit 응답";
    else if (consecErrors >= INVESTOR_FLOW_CONSEC_ERROR_STOP) stopReason = `연속 오류 ${INVESTOR_FLOW_CONSEC_ERROR_STOP}건`;
    if (!stopReason) await sleep(INVESTOR_FLOW_ERROR_RETRY_MS);
    return null;
  }
}

/** 한 종목을 최신 방향 앵커에서 과거로 끝까지(또는 중단까지) 받는다. 끝까지 받으면 true. */
async function collectStock(code: string, startAnchor: string): Promise<boolean> {
  const st = progress.stocks[code] ?? { oldest: null, done: false, rows: 0 };
  progress.stocks[code] = st;
  let anchor = st.oldest ? ymd(prevDay(st.oldest)) : ymd(startAnchor);
  for (;;) {
    const out = await callPage(code, anchor);
    if (out === null) { if (stopReason) return false; continue; }
    const mapped = out.filter((r) => r.stck_bsop_date).map((r): Row => ({
      stock_code: code, trade_date: iso(String(r.stck_bsop_date)),
      frgn_ntby_amt: num(r.frgn_ntby_tr_pbmn), orgn_ntby_amt: num(r.orgn_ntby_tr_pbmn), prsn_ntby_amt: num(r.prsn_ntby_tr_pbmn), frgn_ntby_qty: num(r.frgn_ntby_qty),
    }));
    for (const m of mapped) if (m.trade_date >= INVESTOR_FLOW_STOCK_FROM) { if (addRow(m)) { runNewRows++; st.rows++; } }
    const oldest = mapped.length ? mapped[mapped.length - 1].trade_date : null;
    if (oldest) st.oldest = st.oldest && st.oldest < oldest ? st.oldest : oldest;
    if (!oldest || oldest <= INVESTOR_FLOW_STOCK_FROM || out.length < INVESTOR_FLOW_STOCK_PAGE_ROWS) { st.done = true; return true; }
    const next = ymd(prevDay(oldest));
    if (next === anchor) { st.done = true; return true; }
    anchor = next;
    if (runRequests() - lastLogReq >= 200) { lastLogReq = runRequests(); console.log(`  진행: 요청 ${runRequests()}(누적 ${reqBase + runRequests()}), 종목 ${code} 최오래 ${oldest}, 완료 종목 ${Object.values(progress.stocks).filter((s) => s.done).length}, KST ${kst()}, 경과 ${((Date.now() - T0) / 60e3).toFixed(0)}분`); }
  }
}

async function seedFromPilot(): Promise<void> {
  const codes = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from("investor_flow_stock_pilot").select("stock_code, trade_date, frgn_ntby_amt, orgn_ntby_amt, prsn_ntby_amt, frgn_ntby_qty").order("stock_code").order("trade_date").range(from, from + 999);
    if (error) throw new Error(`시험 표 읽기 실패: ${error.message}`);
    for (const r of data ?? []) {
      const code = r.stock_code as string; codes.add(code);
      addRow({ stock_code: code, trade_date: r.trade_date as string, frgn_ntby_amt: r.frgn_ntby_amt === null ? null : Number(r.frgn_ntby_amt), orgn_ntby_amt: r.orgn_ntby_amt === null ? null : Number(r.orgn_ntby_amt), prsn_ntby_amt: r.prsn_ntby_amt === null ? null : Number(r.prsn_ntby_amt), frgn_ntby_qty: r.frgn_ntby_qty === null ? null : Number(r.frgn_ntby_qty) });
    }
    dbPilotRead += data?.length ?? 0;
    if (!data || data.length < 1000) break;
  }
  for (const code of codes) {
    const ds = [...byYear.values()].flatMap((m) => [...m.values()]).filter((r) => r.stock_code === code).map((r) => r.trade_date).sort();
    progress.stocks[code] = { oldest: ds[0] ?? null, done: true, rows: ds.length };
  }
  progress.seeded = true;
  console.log(`시험 표 ${dbPilotRead}행 → Parquet로 옮김(종목 ${codes.size}개: ${[...codes].sort().join(",")}), 재요청 없음`);
}

async function main(): Promise<void> {
  console.log(`종목별 투자자 수급 수집 회차 시작: ${new Date().toISOString()} (KST ${kst()}) | 누적 요청 상한 ${INVESTOR_FLOW_STOCK_REQUEST_TOTAL_CAP} | 회차 상한 ${(INVESTOR_FLOW_STOCK_RUN_MAX_MS / 3600e3).toFixed(2)}시간`);
  await loadStored();
  reqBase = progress.requestsTotal;
  loaded = true;
  if (!progress.seeded) { await seedFromPilot(); await checkpoint("시험 표 6종목 이전"); }

  // ---- 대상 420종목: 월말 PIT 시총 상위 150에 한 번이라도 든 종목 (Parquet, 1단계와 같은 규칙) ----
  const adjustments = await loadAppliedAdjustments();
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear(), adjustments);
  const calSet = new Set<string>(); let lastDate = "";
  for (const rows of series.values()) for (const r of rows) { if (r.tradeDate >= "2010-01-01") calSet.add(r.tradeDate); if (r.tradeDate > lastDate) lastDate = r.tradeDate; }
  const cal = [...calSet].sort();
  const monthEnd = new Set<string>();
  for (let k = 0; k + 1 < cal.length; k++) if (cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7)) monthEnd.add(cal[k]);
  const mcapAt = new Map<string, { code: string; mc: number }[]>();
  const lastRow = new Map<string, string>();
  for (const [code, rows] of series) {
    for (const r of rows) { if (r.tradeDate < "2010-01-01") continue; if (monthEnd.has(r.tradeDate)) { const a = mcapAt.get(r.tradeDate) ?? []; a.push({ code, mc: r.marketCapEok }); mcapAt.set(r.tradeDate, a); } lastRow.set(code, r.tradeDate); }
  }
  const everTop = new Set<string>();
  for (const [, arr] of mcapAt) { arr.sort((a, b) => b.mc - a.mc || (a.code < b.code ? -1 : 1)); for (const x of arr.slice(0, INVESTOR_FLOW_TOP_N)) everTop.add(x.code); }
  series.clear();
  const endedBefore = new Date(Date.parse(lastDate) - INVESTOR_FLOW_ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  const pool = [...everTop].sort();
  const isDelisted = (c: string): boolean => (lastRow.get(c) ?? "9999") < endedBefore;
  console.log(`대상 ${pool.length}종목(상장폐지 ${pool.filter(isDelisted).length}개), Parquet 마지막 날 ${lastDate}`);

  const startedDone = pool.filter((c) => progress.stocks[c]?.done).length;
  const remaining = pool.filter((c) => !progress.stocks[c]?.done);
  console.log(`회차 시작 시 완료 ${startedDone}/${pool.length}; 수집 순서 = 종목코드 오름차순; 남은 ${remaining.length}종목: ${remaining.join(",")} (중간까지 받은 종목: ${remaining.filter((c) => progress.stocks[c]).join(",") || "없음"})`);
  for (const code of pool) {
    if (progress.stocks[code]?.done) continue;
    if (stopCheck()) break;
    const finished = await collectStock(code, isDelisted(code) ? lastRow.get(code)! : INVESTOR_FLOW_TO);
    if (finished) { runCompleted++; completedSinceCheckpoint++; completedCodes.push(code); }
    if (!finished) break;
    if (completedSinceCheckpoint >= INVESTOR_FLOW_CHECKPOINT_STOCKS || Date.now() - lastCheckpoint >= INVESTOR_FLOW_CHECKPOINT_MS) await checkpoint("주기 저장");
  }

  const doneNow = pool.filter((c) => progress.stocks[c]?.done).length;
  const partial = pool.filter((c) => progress.stocks[c] && !progress.stocks[c].done).length;
  console.log(`이번 회차 완료 종목 ${completedCodes.length}개: ${completedCodes.join(",")}`);
  const stop = stopReason ?? (doneNow === pool.length ? "전 종목 완료" : "알 수 없음");
  progress.runs.push({ startedAt: new Date(T0).toISOString(), requests: runRequests(), completed: runCompleted, newRows: runNewRows, errors: runErrors, stop });
  await checkpoint("회차 종료");
  const totalRows = [...byYear.values()].reduce((a, m) => a + m.size, 0);
  console.log(`\n=== 회차 결과 ===\n| 항목 | 값 |\n|---|---|\n| 이번 회차 완료 종목 | ${runCompleted} |\n| 이번 회차 요청 | ${runRequests()} (rate limit 재시도 ${getKisCallStats().retried}) |\n| 이번 회차 새로 저장한 행 | ${runNewRows} |\n| 이번 회차 오류 응답 | ${runErrors} |\n| 중단 사유 | ${stop} |\n| 누적 완료 종목 | ${doneNow}/${pool.length} (${((doneNow / pool.length) * 100).toFixed(1)}%), 진행 중 ${partial} |\n| 누적 요청 | ${progress.requestsTotal}/${INVESTOR_FLOW_STOCK_REQUEST_TOTAL_CAP} |\n| 저장 행 누계 | ${totalRows} |\n| 시험 표 읽은 행 | ${dbPilotRead} (쓴 행 0) |\n| 소요 | ${((Date.now() - T0) / 60e3).toFixed(1)}분 |`);
}

main().catch(async (e) => {
  console.error("실패:", e instanceof Error ? e.message : e, `요청=${runRequests()}`);
  try { if (loaded) await checkpoint("오류 종료 직전"); } catch (e2) { console.error("종료 직전 저장도 실패:", e2 instanceof Error ? e2.message : e2); }
  process.exit(1);
});

/**
 * [연구용] DART fnlttXbrl.xml로 FY2011~FY2015 1분기·반기·3분기 실적을 백필해 dart_quarterly_fundamentals(source='xbrl')에 저장한다.
 * 사전 등록·추출 규칙: research/quarterly-tilt-holdout-prereg.md (커밋 5df8ab2). 1회차 맨 앞에서 FY2016 검증(저장 안 함)을 하고,
 * 불일치 비율이 5%를 넘으면 백필을 시작하지 않는다. 키: DART_API_KEY_3 → DART_API_KEY_2(운영 키 사용 안 함).
 * 대상 종목은 fnlttSinglAcntAll 분기 백필과 같은 규칙. DB는 REST만. 키 값은 출력하지 않는다.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import type { Filing } from "@/lib/dartXbrlExtract";
import {
  QUARTERLY_BACKFILL_UNIVERSE_MIN_CAP_EOK, QUARTERLY_BACKFILL_PIT_FROM, QUARTERLY_BACKFILL_CONCURRENCY, QUARTERLY_BACKFILL_MIN_REQUEST_GAP_MS,
  QUARTERLY_BACKFILL_MAX_RETRIES, QUARTERLY_BACKFILL_RETRY_BASE_MS, QUARTERLY_BACKFILL_UPSERT_BATCH, QUARTERLY_BACKFILL_DB_IN_CHUNK,
  QUARTERLY_BACKFILL_SOFT_DEADLINE_MINUTES_V3, QUARTERLY_REPORTS, QUARTERLY_XBRL_RUN2_REQUEST_CAP, QUARTERLY_BACKFILL_PROGRESS_EVERY_REQUESTS,
  QUARTERLY_KEY_PRIMARY_ENV, QUARTERLY_KEY_SECONDARY_ENV, QUARTERLY_KEY_CHECK,
  QUARTERLY_XBRL_FY_FROM, QUARTERLY_XBRL_FY_TO, QUARTERLY_XBRL_VERIFY_FY, QUARTERLY_XBRL_LIST_FROM, QUARTERLY_XBRL_LIST_TO, QUARTERLY_XBRL_LIST_PAGE_COUNT,
  QUARTERLY_XBRL_VERIFY_SEED, QUARTERLY_XBRL_VERIFY_SAMPLE, QUARTERLY_XBRL_VERIFY_MAX_MISMATCH, QUARTERLY_XBRL_VERIFY_TOLERANCE_WON, QUARTERLY_XBRL_VERIFY_MAX_CASES,
  QUARTERLY_XBRL_HOLDOUT_PREREG_COMMIT,
} from "@/lib/dartQuarterlyBackfillConfig";
import { DartKeyPool } from "./dartKeyPool";
import { extractQuarter, parseQuarterInst, pickQuarterReport, type QExtract } from "./dartQuarterlyXbrl";

const DART_BASE_URL = "https://opendart.fss.or.kr/api";
const TABLE = "dart_quarterly_fundamentals";
const MS_DAY = 86_400_000;
const T0 = Date.now();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pct = (a: number, b: number): string => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const isZip = (b: Buffer): boolean => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b;
const toIso = (d: string): string => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

const dbRead: Record<string, number> = {};
const dbWritten = { rows: 0 };
async function selectAll<T>(label: string, build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(`${label}: ${error.message}`);
    out.push(...(data ?? []));
    dbRead[label] = (dbRead[label] ?? 0) + (data?.length ?? 0);
    if ((data?.length ?? 0) < 1000) break;
  }
  return out;
}

// ---- DART 호출(동시 4 + 최소 간격 + 429/5xx/800/네트워크 오류 최대 2회 재시도, 키 풀 예약 방식 상한) ----
let pool: DartKeyPool;
let nextSlot = 0;
async function slot(): Promise<void> {
  const now = Date.now();
  const s = Math.max(now, nextSlot);
  nextSlot = s + QUARTERLY_BACKFILL_MIN_REQUEST_GAP_MS;
  if (s > now) await sleep(s - now);
}
/** null = 일시 오류·상한·한도(저장하지 않음). 키 값은 build 안에서만 URL에 들어간다. */
async function dartRaw(build: (key: string) => string): Promise<Buffer | null> {
  for (let attempt = 0; attempt <= QUARTERLY_BACKFILL_MAX_RETRIES; ) {
    const k = pool.reserve();
    if (!k) return null;
    await slot();
    try {
      const res = await fetch(build(k.value));
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!isZip(buf)) {
        const text = buf.toString("utf-8");
        const st = /"status"\s*:\s*"(\d+)"/.exec(text)?.[1] ?? /<status>(\d+)</.exec(text)?.[1];
        if (st === "020") { if (pool.on020(k.name)) continue; return null; }
        if (st === "800") throw new Error("status 800");
      }
      return buf;
    } catch {
      if (attempt < QUARTERLY_BACKFILL_MAX_RETRIES) await sleep(QUARTERLY_BACKFILL_RETRY_BASE_MS * 2 ** attempt);
      attempt++;
    }
  }
  return null;
}
async function dartList(corp: string): Promise<Filing[] | null> {
  const rows: Filing[] = [];
  for (let page = 1, pages = 1; page <= pages; page++) {
    const b = await dartRaw((k) => `${DART_BASE_URL}/list.json?crtfc_key=${k}&corp_code=${corp}&bgn_de=${QUARTERLY_XBRL_LIST_FROM}&end_de=${QUARTERLY_XBRL_LIST_TO}&pblntf_ty=A&page_no=${page}&page_count=${QUARTERLY_XBRL_LIST_PAGE_COUNT}`);
    if (!b) return null;
    let j: { status?: string; list?: Filing[]; total_page?: number } | null = null;
    try { j = JSON.parse(b.toString("utf-8")); } catch { return null; }
    if (j?.status === "013") return rows;
    if (j?.status !== "000") return null;
    rows.push(...(j.list ?? []));
    pages = j.total_page ?? 1;
  }
  return rows;
}
type Fetched = { kind: "x"; ex: QExtract } | { kind: "014" } | { kind: "err"; detail: string } | { kind: "transient" };
async function fetchQuarter(f: Filing, fy: number, quarter: number): Promise<Fetched> {
  const rep = QUARTERLY_REPORTS.find((r) => r.quarter === quarter)!;
  const b = await dartRaw((k) => `${DART_BASE_URL}/fnlttXbrl.xml?crtfc_key=${k}&rcept_no=${f.rcept_no}&reprt_code=${rep.reprtCode}`);
  if (!b) return { kind: "transient" };
  if (!isZip(b)) {
    const text = b.toString("utf-8");
    const st = /<status>(\d+)</.exec(text)?.[1] ?? /"status"\s*:\s*"(\d+)"/.exec(text)?.[1];
    return st === "014" ? { kind: "014" } : { kind: "err", detail: `dart_status=${st ?? "?"}` };
  }
  const p = parseQuarterInst(b);
  if ("error" in p) return { kind: "err", detail: "zip_error" };
  const ex = extractQuarter(p.facts, fy, quarter);
  return ex ? { kind: "x", ex } : { kind: "err", detail: "no_target_facts" };
}

type Meta = { code: string; corp: string; name: string; fyFrom: number; fyTo: number; delisted: boolean };
interface QRow {
  corp_code: string; stock_code: string; fiscal_year: number; quarter: number; fs_div: string | null; rcept_no: string | null; rcept_date: string | null;
  ni_parent_q: number | null; ni_parent_cum: number | null; ni_parent_prev_q: number | null; ni_parent_prev_cum: number | null;
  revenue_q: number | null; revenue_prev_q: number | null; op_income_q: number | null; op_income_prev_q: number | null; equity_parent: number | null;
  status: "ok" | "no_report" | "xbrl_014" | "error"; off_cycle: boolean; fetched_at: string; account_ids_used: string | null; ni_tag: "parent" | "profitloss" | null; source: "xbrl";
}
const EMPTY = { fs_div: null, ni_parent_q: null, ni_parent_cum: null, ni_parent_prev_q: null, ni_parent_prev_cum: null, revenue_q: null, revenue_prev_q: null, op_income_q: null, op_income_prev_q: null, equity_parent: null, ni_tag: null, off_cycle: false } as const;
function rowFor(t: Meta, fy: number, quarter: number, filing: Filing | null, fetched: Fetched | null, now: string): QRow | null {
  const base = { corp_code: t.corp, stock_code: t.code, fiscal_year: fy, quarter, fetched_at: now, source: "xbrl" as const };
  if (!filing) return { ...base, ...EMPTY, rcept_no: null, rcept_date: null, status: "no_report", account_ids_used: "xbrl;no_report" };
  const common = { rcept_no: filing.rcept_no, rcept_date: toIso(filing.rcept_dt) };
  const exp = QUARTERLY_REPORTS.find((r) => r.quarter === quarter)!.expectedRceptMonth;
  const offCycle = Number(common.rcept_date.slice(5, 7)) !== exp;
  if (!fetched || fetched.kind === "transient") return null;
  if (fetched.kind === "014") return { ...base, ...EMPTY, ...common, status: "xbrl_014", off_cycle: offCycle, account_ids_used: "xbrl;xbrl_014" };
  if (fetched.kind === "err") return { ...base, ...EMPTY, ...common, status: "error", off_cycle: offCycle, account_ids_used: `xbrl;${fetched.detail}` };
  const { used, basis, ...vals } = fetched.ex;
  void basis;
  return { ...base, ...vals, ...common, status: "ok", off_cycle: offCycle, account_ids_used: used };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function main(): Promise<void> {
  const keyPrimary = process.env[QUARTERLY_KEY_PRIMARY_ENV], keySecondary = process.env[QUARTERLY_KEY_SECONDARY_ENV];
  if (!keyPrimary || !keySecondary) throw new Error(`환경변수 ${QUARTERLY_KEY_PRIMARY_ENV}, ${QUARTERLY_KEY_SECONDARY_ENV}가 필요합니다.`);
  pool = new DartKeyPool([{ name: QUARTERLY_KEY_PRIMARY_ENV, value: keyPrimary }, { name: QUARTERLY_KEY_SECONDARY_ENV, value: keySecondary }], QUARTERLY_XBRL_RUN2_REQUEST_CAP);
  console.log(`분기 XBRL 백필(FY${QUARTERLY_XBRL_FY_FROM}~${QUARTERLY_XBRL_FY_TO}) 시작: ${new Date().toISOString()} | 사전등록 ${QUARTERLY_XBRL_HOLDOUT_PREREG_COMMIT} | 키: 1순위 ${QUARTERLY_KEY_PRIMARY_ENV}, 2순위 ${QUARTERLY_KEY_SECONDARY_ENV}, 운영 키 DART_API_KEY 사용 안 함 | 전체 상한 ${QUARTERLY_XBRL_RUN2_REQUEST_CAP}`);
  const chk = await dartRaw((k) => `${DART_BASE_URL}/list.json?crtfc_key=${k}&corp_code=${QUARTERLY_KEY_CHECK.corpCode}&bgn_de=${QUARTERLY_KEY_CHECK.bgn}&end_de=${QUARTERLY_KEY_CHECK.end}&page_no=1&page_count=1`);
  let chkStatus = "응답 없음";
  try { chkStatus = chk ? (JSON.parse(chk.toString("utf-8")) as { status?: string }).status ?? "?" : "응답 없음"; } catch { chkStatus = "파싱 실패"; }
  const primaryOnly = pool.used.get(QUARTERLY_KEY_PRIMARY_ENV) === 1 && pool.got020.get(QUARTERLY_KEY_PRIMARY_ENV) === 0;
  console.log(`1순위 키(${QUARTERLY_KEY_PRIMARY_ENV}) list.json 확인: status ${chkStatus} (1순위 키로 보냄: ${primaryOnly ? "예" : "아니오"})`);
  if (!primaryOnly || chkStatus !== "000") { console.log("1순위 키 확인이 status 000이 아니라 진행하지 않습니다."); return; }

  // ---- 대상 선정(분기 singl 백필과 같은 규칙) ----
  const series: Map<string, StockDailyPriceRow[]> = await loadAllStockSeriesFromParquet(2010, 2026);
  const dates = new Set<string>();
  let globalLast = "";
  for (const rows of series.values()) {
    for (const r of rows) if (r.tradeDate >= QUARTERLY_BACKFILL_PIT_FROM) dates.add(r.tradeDate);
    const l = rows[rows.length - 1]?.tradeDate ?? "";
    if (l > globalLast) globalLast = l;
  }
  const cal = [...dates].sort();
  const monthEnds = new Set<string>();
  for (let k = 0; k + 1 < cal.length; k++) if (cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7)) monthEnds.add(cal[k]);
  const aliveCut = new Date(Date.parse(globalLast) - 14 * MS_DAY).toISOString().slice(0, 10);
  const entered = new Set<string>();
  for (const [code, rows] of series) {
    const tv = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].tradeDate < QUARTERLY_BACKFILL_PIT_FROM || !monthEnds.has(rows[i].tradeDate)) continue;
      if (rows[i - 1].marketCapEok >= QUARTERLY_BACKFILL_UNIVERSE_MIN_CAP_EOK && tv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON) { entered.add(code); break; }
    }
  }
  const entryCodes = [...entered].sort();
  const corpMap = new Map<string, { corp_code: string; corp_name: string }>();
  for (let i = 0; i < entryCodes.length; i += QUARTERLY_BACKFILL_DB_IN_CHUNK) {
    const chunk = entryCodes.slice(i, i + QUARTERLY_BACKFILL_DB_IN_CHUNK);
    const rows = await selectAll<{ corp_code: string; corp_name: string; stock_code: string | null }>("dart_corp_codes", (f, t) => supabaseAdmin.from("dart_corp_codes").select("corp_code, corp_name, stock_code").in("stock_code", chunk).range(f, t));
    for (const r of rows) if (r.stock_code && !corpMap.has(r.stock_code)) corpMap.set(r.stock_code, { corp_code: r.corp_code, corp_name: r.corp_name });
  }
  const targets: Meta[] = entryCodes.filter((c) => corpMap.has(c)).map((c) => {
    const rows = series.get(c)!;
    const delisted = rows[rows.length - 1].tradeDate < aliveCut;
    return {
      code: c, corp: corpMap.get(c)!.corp_code, name: corpMap.get(c)!.corp_name, delisted,
      fyFrom: Math.max(QUARTERLY_XBRL_FY_FROM, Number(rows[0].tradeDate.slice(0, 4))),
      fyTo: delisted ? Math.min(QUARTERLY_XBRL_VERIFY_FY, Number(rows[rows.length - 1].tradeDate.slice(0, 4))) : QUARTERLY_XBRL_VERIFY_FY,
    };
  });
  console.log(`PIT 진입 종목 ${entryCodes.length}개, corp_code 있음(대상) ${targets.length}개 (상장폐지 ${targets.filter((t) => t.delisted).length}개)`);

  // ---- 저장 현황 ----
  interface Stored { corp_code: string; fiscal_year: number; quarter: number; status: string; source: string | null }
  const storedRows = await selectAll<Stored>(TABLE + "(저장 현황)", (f, t) => supabaseAdmin.from(TABLE).select("corp_code, fiscal_year, quarter, status, source").order("corp_code").order("fiscal_year").order("quarter").range(f, t));
  const stored = new Map(storedRows.map((r) => [`${r.corp_code}|${r.fiscal_year}|${r.quarter}`, r]));
  const xbrlStored = storedRows.filter((r) => r.source === "xbrl").length;
  console.log(`저장된 행 ${storedRows.length}건 (source='xbrl' ${xbrlStored}건)`);

  // list.json 캐시(종목당 1번)
  const listCache = new Map<string, Promise<Filing[] | null>>();
  const getFilings = (corp: string): Promise<Filing[] | null> => {
    let p = listCache.get(corp);
    if (!p) { p = dartList(corp); listCache.set(corp, p); }
    return p;
  };

  // ---- 1회차 맨 앞 검증(FY2016, 저장 안 함) ----
  const validation = { done: false };
  if (xbrlStored === 0) {
    validation.done = true;
    interface Singl { corp_code: string; stock_code: string; quarter: number; fs_div: string | null; ni_tag: string | null; ni_parent_q: number | null; ni_parent_prev_q: number | null; op_income_q: number | null; op_income_prev_q: number | null }
    const singl = await selectAll<Singl>(TABLE + "(검증 FY2016 singl)", (f, t) => supabaseAdmin.from(TABLE).select("corp_code, stock_code, quarter, fs_div, ni_tag, ni_parent_q, ni_parent_prev_q, op_income_q, op_income_prev_q").eq("fiscal_year", QUARTERLY_XBRL_VERIFY_FY).eq("status", "ok").order("corp_code").order("quarter").range(f, t));
    const byCorp = new Map<string, Singl[]>();
    for (const r of singl) (byCorp.get(r.corp_code) ?? byCorp.set(r.corp_code, []).get(r.corp_code)!).push(r);
    const cand = targets.filter((t) => t.fyTo >= QUARTERLY_XBRL_VERIFY_FY && byCorp.has(t.corp)).sort((a, b) => (a.corp < b.corp ? -1 : 1));
    const rnd = mulberry32(QUARTERLY_XBRL_VERIFY_SEED);
    for (let i = cand.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cand[i], cand[j]] = [cand[j], cand[i]]; }
    const sample = cand.slice(0, QUARTERLY_XBRL_VERIFY_SAMPLE);
    console.log(`\n=== 검증: FY${QUARTERLY_XBRL_VERIFY_FY} 무작위 ${sample.length}종목 (후보 ${cand.length}, 시드 ${QUARTERLY_XBRL_VERIFY_SEED}) ===`);
    const items = ["op_income_q", "op_income_prev_q", "ni_parent_q", "ni_parent_prev_q"] as const;
    const cmp = Object.fromEntries(items.map((k) => [k, { compared: 0, mismatch: 0, singlNull: 0 }])) as Record<(typeof items)[number], { compared: number; mismatch: number; singlNull: number }>;
    const cases: string[] = [];
    let quartersTried = 0, quartersNoXbrl = 0;
    const work = sample.flatMap((t) => (byCorp.get(t.corp) ?? []).map((s) => ({ t, s })));
    let wi = 0;
    await Promise.all(Array.from({ length: QUARTERLY_BACKFILL_CONCURRENCY }, async () => {
      for (;;) {
        const i = wi++;
        if (i >= work.length) return;
        const { t, s } = work[i];
        quartersTried++;
        const filings = await getFilings(t.corp);
        const f = filings ? pickQuarterReport(filings, QUARTERLY_XBRL_VERIFY_FY, s.quarter) : null;
        const fe = f ? await fetchQuarter(f, QUARTERLY_XBRL_VERIFY_FY, s.quarter) : null;
        if (!fe || fe.kind !== "x") { quartersNoXbrl++; for (const k of items) if (s[k] !== null) { cmp[k].compared++; cmp[k].mismatch++; if (cases.length < QUARTERLY_XBRL_VERIFY_MAX_CASES) cases.push(`| ${t.code} | ${s.quarter} | ${k} | ${s[k]} | (XBRL 없음: ${!f ? "보고서 못 찾음" : fe ? fe.kind : "목록 실패"}) | - |`); } else cmp[k].singlNull++; continue; }
        for (const k of items) {
          const a = s[k], b = fe.ex[k];
          if (a === null) { cmp[k].singlNull++; continue; }
          cmp[k].compared++;
          if (b === null || Math.abs(Number(a) - b) > QUARTERLY_XBRL_VERIFY_TOLERANCE_WON) {
            cmp[k].mismatch++;
            if (cases.length < QUARTERLY_XBRL_VERIFY_MAX_CASES) cases.push(`| ${t.code} | ${s.quarter} | ${k} | ${a} | ${b ?? "null"} | ${fe.ex.basis}/${fe.ex.ni_tag ?? "-"} (singl ${s.fs_div}/${s.ni_tag ?? "-"}) |`);
          }
        }
      }
    }));
    const tot = items.reduce((a, k) => ({ c: a.c + cmp[k].compared, m: a.m + cmp[k].mismatch }), { c: 0, m: 0 });
    console.log(`검증 분기 ${quartersTried}건 (XBRL 못 받음 ${quartersNoXbrl}건), 비교 허용오차 ${QUARTERLY_XBRL_VERIFY_TOLERANCE_WON}원`);
    console.log("| 항목 | 비교 대상 셀 | 일치 | 불일치 | 일치 비율 | singl이 null이라 제외 |\n|---|---|---|---|---|---|");
    for (const k of items) console.log(`| ${k} | ${cmp[k].compared} | ${cmp[k].compared - cmp[k].mismatch} | ${cmp[k].mismatch} | ${pct(cmp[k].compared - cmp[k].mismatch, cmp[k].compared)} | ${cmp[k].singlNull} |`);
    console.log(`| 합계 | ${tot.c} | ${tot.c - tot.m} | ${tot.m} | ${pct(tot.c - tot.m, tot.c)} | - |`);
    if (cases.length) { console.log(`불일치 사례(최대 ${QUARTERLY_XBRL_VERIFY_MAX_CASES}개):\n| 종목 | 분기 | 항목 | singl 값 | XBRL 값 | 사용 컨텍스트(XBRL 기준/ni_tag, singl) |\n|---|---|---|---|---|---|`); for (const c of cases) console.log(c); }
    const rate = tot.c ? tot.m / tot.c : 1;
    console.log(`불일치 비율 ${(rate * 100).toFixed(2)}% (기준 ${QUARTERLY_XBRL_VERIFY_MAX_MISMATCH * 100}%) → ${rate > QUARTERLY_XBRL_VERIFY_MAX_MISMATCH ? "기준 초과: 백필을 시작하지 않고 멈춥니다." : "기준 이내: 백필을 진행합니다."}`);
    console.log(`검증에 쓴 DART 요청 ${pool.total} (키별: ${[...pool.used].map(([n, v]) => `${n} ${v}`).join(", ")})`);
    if (rate > QUARTERLY_XBRL_VERIFY_MAX_MISMATCH || pool.stopReason) {
      console.log(`Supabase 쓴 행: 0 | DART 요청 수: ${pool.total} | KIS 요청: 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분${pool.stopReason ? ` | 중단 사유: ${pool.stopReason}` : ""}`);
      return;
    }
  } else console.log("source='xbrl' 행이 이미 있어 검증은 건너뜁니다(1회차만).");

  // ---- 백필 큐: FY2015 → FY2011, 종목 코드순 ----
  interface Work { t: Meta; fy: number; qs: number[] }
  const queue: Work[] = [];
  let totalKeys = 0;
  for (let fy = QUARTERLY_XBRL_FY_TO; fy >= QUARTERLY_XBRL_FY_FROM; fy--) {
    for (const t of targets) {
      if (fy < t.fyFrom || fy > t.fyTo) continue;
      const qs = QUARTERLY_REPORTS.map((r) => r.quarter);
      totalKeys += qs.length;
      const pend = qs.filter((q) => { const s = stored.get(`${t.corp}|${fy}|${q}`)?.status; return s !== "ok" && s !== "no_report" && s !== "xbrl_014"; });
      if (pend.length) queue.push({ t, fy, qs: pend });
    }
  }
  const pendingKeys = queue.reduce((a, w) => a + w.qs.length, 0);
  console.log(`전체 키 ${totalKeys}건, 이번에 시도할 키 ${pendingKeys}건 (${queue.length}개 종목-연도), 요청 수 상한 ${QUARTERLY_XBRL_RUN2_REQUEST_CAP}`);

  const buffer: QRow[] = [];
  async function flush(force: boolean): Promise<void> {
    while (buffer.length >= QUARTERLY_BACKFILL_UPSERT_BATCH || (force && buffer.length > 0)) {
      const batch = buffer.splice(0, QUARTERLY_BACKFILL_UPSERT_BATCH);
      const { error } = await supabaseAdmin.from(TABLE).upsert(batch, { onConflict: "corp_code,fiscal_year,quarter" });
      if (error) throw new Error(`${TABLE} upsert 실패: ${error.message}`);
      dbWritten.rows += batch.length;
    }
  }
  const deadline = T0 + QUARTERLY_BACKFILL_SOFT_DEADLINE_MINUTES_V3 * 60_000;
  let stopReason: string | null = null;
  let cursor = 0, doneKeys = 0, transientKeys = 0, nextLog = Math.ceil((pool.total + 1) / QUARTERLY_BACKFILL_PROGRESS_EVERY_REQUESTS) * QUARTERLY_BACKFILL_PROGRESS_EVERY_REQUESTS;
  async function processWork(w: Work): Promise<void> {
    const filings = await getFilings(w.t.corp);
    if (!filings) { transientKeys += w.qs.length; return; }
    for (const q of w.qs) {
      const f = pickQuarterReport(filings, w.fy, q);
      const fe = f ? await fetchQuarter(f, w.fy, q) : null;
      const row = rowFor(w.t, w.fy, q, f, fe, new Date().toISOString());
      if (!row) { transientKeys++; continue; }
      buffer.push(row);
      doneKeys++;
    }
    await flush(false);
  }
  async function worker(): Promise<void> {
    while (!stopReason) {
      if (pool.stopReason) { stopReason = pool.stopReason; break; }
      if (Date.now() > deadline) { stopReason = `소프트 데드라인 ${QUARTERLY_BACKFILL_SOFT_DEADLINE_MINUTES_V3}분 도달`; break; }
      const i = cursor++;
      if (i >= queue.length) break;
      await processWork(queue[i]);
      if (pool.total >= nextLog) {
        nextLog += QUARTERLY_BACKFILL_PROGRESS_EVERY_REQUESTS;
        console.log(`진행 종목-연도 ${cursor}/${queue.length} | 저장 키 ${doneKeys}/${pendingKeys} | DART 요청 ${pool.total} (${[...pool.used].map(([n, v]) => `${n} ${v}`).join(", ")}) | 저장 대기 ${buffer.length}행, 저장 ${dbWritten.rows}행 | 경과 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
      }
    }
  }
  await Promise.all(Array.from({ length: QUARTERLY_BACKFILL_CONCURRENCY }, () => worker()));
  if (!stopReason && pool.stopReason) stopReason = pool.stopReason;
  await flush(true);
  console.log(`\n수집 종료: ${stopReason ?? "이번 실행 대상 키 전부 처리"} | 저장한 키 ${doneKeys}/${pendingKeys} | 일시 오류로 저장 안 한 키 ${transientKeys}`);

  await report(targets, totalKeys, { doneKeys, pendingKeys, stopReason, transientKeys, validated: validation.done });
}

async function report(targets: Meta[], totalKeys: number, run: { doneKeys: number; pendingKeys: number; stopReason: string | null; transientKeys: number; validated: boolean }): Promise<void> {
  const rows = (await selectAll<QRow>(TABLE + "(결과 집계)", (f, t) => supabaseAdmin.from(TABLE).select("*").eq("source", "xbrl").order("corp_code").order("fiscal_year").order("quarter").range(f, t)));
  const delistedCorp = new Set(targets.filter((t) => t.delisted).map((t) => t.corp));
  const minutes = (Date.now() - T0) / 60000;
  const savedFinal = rows.filter((r) => r.status !== "error").length;
  const reqPerKey = run.doneKeys > 0 ? pool.total / run.doneKeys : 2;
  const remainKeys = totalKeys - savedFinal;
  console.log("\n=== 2. 키·요청·중단 ===");
  console.log("| 키 이름 | 요청 수 | status 020 수신 |\n|---|---|---|");
  for (const [n, v] of pool.used) console.log(`| ${n} | ${v} | ${pool.got020.get(n) ?? 0} |`);
  console.log(`| 합계 | ${pool.total} (상한 ${QUARTERLY_XBRL_RUN2_REQUEST_CAP}) | - |`);
  console.log(`키 전환: ${pool.switchedAt ? `발생 ${pool.switchedAt} (전체 요청 ${pool.switchedAtRequest}번째 부근)` : "발생 안 함"} | 중단 사유: ${run.stopReason ?? "이번 실행 대상 키 전부 처리"} | 소요 ${minutes.toFixed(1)}분 (분당 저장 키 ${(run.doneKeys / minutes).toFixed(1)}, 분당 요청 ${(pool.total / minutes).toFixed(1)})`);

  console.log("\n=== 3. 진행 ===");
  console.log("| 항목 | 값 |\n|---|---|");
  console.log(`| 이번 실행 저장한 키 / 시도 대상 키 | ${run.doneKeys} / ${run.pendingKeys} |`);
  console.log(`| 일시 오류로 저장 안 한 키 | ${run.transientKeys} |`);
  console.log(`| 요청 수 / 저장 키 (list.json 포함) | ${reqPerKey.toFixed(3)} |`);
  console.log(`| 누적 진행률(저장된 키, error 제외) | ${savedFinal} / ${totalKeys} (${pct(savedFinal, totalKeys)}) |`);
  console.log(`| 남은 키(error 포함) | ${remainKeys} |`);
  console.log(`| 남은 키(error 제외, 미저장) | ${totalKeys - rows.length} |`);
  console.log(`| error 행 | ${rows.filter((r) => r.status === "error").length} |`);
  console.log(`| 남은 요청 추정 | ${Math.round(remainKeys * reqPerKey)} (이번 실행 평균 기준) |`);

  const fys: number[] = [];
  for (let fy = QUARTERLY_XBRL_FY_TO; fy >= QUARTERLY_XBRL_FY_FROM; fy--) fys.push(fy);
  console.log("\n=== 4. FY × 분기 status (source='xbrl' 저장분) ===");
  console.log("| FY | 분기 | 저장 행 | ok | no_report | xbrl_014 | error |\n|---|---|---|---|---|---|---|");
  for (const fy of fys) for (const q of QUARTERLY_REPORTS) {
    const rs = rows.filter((r) => r.fiscal_year === fy && r.quarter === q.quarter);
    console.log(`| ${fy} | ${q.quarter} | ${rs.length} | ${rs.filter((r) => r.status === "ok").length} | ${rs.filter((r) => r.status === "no_report").length} | ${rs.filter((r) => r.status === "xbrl_014").length} | ${rs.filter((r) => r.status === "error").length} |`);
  }
  console.log("\nok 행 null 비율과 fs_div 분포, off_cycle:");
  console.log("| FY | ok 행 | op_income_q null | op_income_prev_q null | ni_parent_q null | CFS | OFS | fs_div null | off_cycle |\n|---|---|---|---|---|---|---|---|---|");
  for (const fy of fys) {
    const ok = rows.filter((r) => r.fiscal_year === fy && r.status === "ok");
    if (!ok.length) continue;
    const nn = (k: keyof QRow): string => { const n = ok.filter((r) => r[k] === null).length; return `${n} (${pct(n, ok.length)})`; };
    console.log(`| ${fy} | ${ok.length} | ${nn("op_income_q")} | ${nn("op_income_prev_q")} | ${nn("ni_parent_q")} | ${ok.filter((r) => r.fs_div === "CFS").length} | ${ok.filter((r) => r.fs_div === "OFS").length} | ${ok.filter((r) => r.fs_div === null).length} | ${ok.filter((r) => r.off_cycle).length} |`);
  }
  console.log(`off_cycle 전체 ${rows.filter((r) => r.off_cycle).length}건 (ok 행 ${rows.filter((r) => r.status === "ok").length}건 중)`);

  console.log("\n=== 5. 상장폐지 / 생존 종목 ok 비율(연도별, 저장된 행 기준) ===");
  console.log("| FY | 상장폐지 저장 행 | ok | ok 비율 | 생존 저장 행 | ok | ok 비율 |\n|---|---|---|---|---|---|---|");
  for (const fy of fys) {
    const d = rows.filter((r) => r.fiscal_year === fy && delistedCorp.has(r.corp_code));
    const a = rows.filter((r) => r.fiscal_year === fy && !delistedCorp.has(r.corp_code));
    if (!d.length && !a.length) continue;
    const dok = d.filter((r) => r.status === "ok").length, aok = a.filter((r) => r.status === "ok").length;
    console.log(`| ${fy} | ${d.length} | ${dok} | ${pct(dok, d.length)} | ${a.length} | ${aok} | ${pct(aok, a.length)} |`);
  }

  console.log("\n=== 6. 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: ${dbWritten.rows} | DART 요청 수: ${pool.total} | KIS 요청: 0 | 소요 ${minutes.toFixed(1)}분${run.validated ? " (이번 실행에 FY2016 검증 포함)" : ""}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

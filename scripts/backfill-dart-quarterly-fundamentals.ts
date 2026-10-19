/**
 * DART fnlttSinglAcntAll(1분기 11013 / 반기 11012 / 3분기 11014)로 FY2016~FY2026 분기 실적을 백필해
 * dart_quarterly_fundamentals(새 표)에 저장한다. 대상: 월말 PIT 유니버스(시총 5천억 이상 + 20일 평균 거래대금
 * 5억 이상)에 2010-01부터 한 번이라도 진입한 종목(상장폐지 포함) 중 dart_corp_codes에 corp_code가 있는 종목.
 * 회계연도 최신부터(FY2026→FY2016), 이미 저장된 키는 건너뛰고 이어받는다. 한 번 실행하고 끝난다.
 * DB 접근은 REST(supabaseAdmin)만. DART status 020이면 즉시 멈춘다. KIS 요청 없음.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import {
  QUARTERLY_BACKFILL_UNIVERSE_MIN_CAP_EOK, QUARTERLY_BACKFILL_PIT_FROM, QUARTERLY_BACKFILL_CONCURRENCY, QUARTERLY_BACKFILL_MIN_REQUEST_GAP_MS,
  QUARTERLY_BACKFILL_MAX_RETRIES, QUARTERLY_BACKFILL_RETRY_BASE_MS, QUARTERLY_BACKFILL_UPSERT_BATCH, QUARTERLY_BACKFILL_DB_IN_CHUNK,
  QUARTERLY_BACKFILL_SOFT_DEADLINE_MINUTES_V3, QUARTERLY_BACKFILL_FY_FROM, QUARTERLY_BACKFILL_FY_TO, QUARTERLY_REPORTS,
  QUARTERLY_BACKFILL_FILING_LAG_DAYS, QUARTERLY_BACKFILL_RUN_REQUEST_CAP_V2, QUARTERLY_BACKFILL_PROGRESS_EVERY_REQUESTS,
  QUARTERLY_ACCOUNT_PREFIX_RE, QUARTERLY_KEY_PRIMARY_ENV, QUARTERLY_KEY_SECONDARY_ENV, QUARTERLY_KEY_CHECK, QUARTERLY_ROW_VERSION_PREFIX,
} from "@/lib/dartQuarterlyBackfillConfig";
import { DartKeyPool } from "./dartKeyPool";

const DART_BASE_URL = "https://opendart.fss.or.kr/api";
const TABLE = "dart_quarterly_fundamentals";
const PARQUET_FROM_YEAR = 2010;
const PARQUET_TO_YEAR = 2026;
const MS_DAY = 86_400_000;
const T0 = Date.now();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pct = (a: number, b: number): string => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

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
interface AcntRow { rcept_no?: string; sj_div?: string; account_id?: string; account_detail?: string; thstrm_amount?: string; thstrm_add_amount?: string; frmtrm_q_amount?: string; frmtrm_add_amount?: string }
interface DartJson { status?: string; message?: string; list?: AcntRow[] }
/** null = 일시 오류·상한·한도로 결과를 얻지 못함(저장하지 않아 다음 실행에서 다시 시도). 키 값은 build 안에서만 URL에 들어간다. */
async function dartJson(build: (key: string) => string): Promise<DartJson | null> {
  for (let attempt = 0; attempt <= QUARTERLY_BACKFILL_MAX_RETRIES; ) {
    const k = pool.reserve();
    if (!k) return null;
    await slot();
    try {
      const res = await fetch(build(k.value));
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const j = JSON.parse(text) as DartJson;
      if (j.status === "020") { if (pool.on020(k.name)) continue; return null; }
      if (j.status === "800") throw new Error("status 800");
      return j;
    } catch {
      if (attempt < QUARTERLY_BACKFILL_MAX_RETRIES) await sleep(QUARTERLY_BACKFILL_RETRY_BASE_MS * 2 ** attempt);
      attempt++;
    }
  }
  return null;
}

// ---- 계정 추출: account_id 기준(접두사 ifrs_/ifrs-full_/dart_ 허용), 계정명 텍스트 매칭 없음 ----
const normId = (id: string | undefined): string => (id ?? "").replace(QUARTERLY_ACCOUNT_PREFIX_RE, "");
const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const t = s.replace(/,/g, "").trim();
  if (t === "" || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
function pickAcnt(rows: AcntRow[], name: string, sjs: string[]): AcntRow | null {
  for (const sj of sjs) {
    const hits = rows.filter((r) => r.sj_div === sj && normId(r.account_id) === name);
    if (hits.length) return hits.find((r) => !r.account_detail || r.account_detail === "-") ?? hits[0];
  }
  return null;
}
interface QRow {
  corp_code: string; stock_code: string; fiscal_year: number; quarter: number; fs_div: string | null; rcept_no: string | null; rcept_date: string | null;
  ni_parent_q: number | null; ni_parent_cum: number | null; ni_parent_prev_q: number | null; ni_parent_prev_cum: number | null;
  revenue_q: number | null; revenue_prev_q: number | null; op_income_q: number | null; op_income_prev_q: number | null; equity_parent: number | null;
  status: "ok" | "no_data_013" | "error"; off_cycle: boolean; fetched_at: string; account_ids_used: string | null; ni_tag: "parent" | "profitloss" | null;
}
function buildOk(base: { corp_code: string; stock_code: string; fiscal_year: number; quarter: number }, fs: string, rows: AcntRow[], expectedMonth: number, now: string): QRow {
  const rcept = rows.find((r) => r.rcept_no)?.rcept_no ?? null;
  const rceptDate = rcept ? `${rcept.slice(0, 4)}-${rcept.slice(4, 6)}-${rcept.slice(6, 8)}` : null;
  let ni = pickAcnt(rows, "ProfitLossAttributableToOwnersOfParent", ["IS", "CIS"]);
  let niTag: "parent" | "profitloss" | null = ni ? "parent" : null;
  if (!ni) { ni = pickAcnt(rows, "ProfitLoss", ["IS", "CIS"]); niTag = ni ? "profitloss" : null; }
  const rev = pickAcnt(rows, "Revenue", ["IS", "CIS"]);
  const op = pickAcnt(rows, "OperatingIncomeLoss", ["IS", "CIS"]);
  const eq = pickAcnt(rows, "EquityAttributableToOwnersOfParent", ["BS"]) ?? pickAcnt(rows, "Equity", ["BS"]);
  const used = (k: string, r: AcntRow | null): string => `${k}:${r ? `${r.account_id}(${r.sj_div})` : "no_match"}`;
  return {
    ...base, fs_div: fs, rcept_no: rcept, rcept_date: rceptDate,
    ni_parent_q: num(ni?.thstrm_amount), ni_parent_cum: num(ni?.thstrm_add_amount), ni_parent_prev_q: num(ni?.frmtrm_q_amount), ni_parent_prev_cum: num(ni?.frmtrm_add_amount),
    revenue_q: num(rev?.thstrm_amount), revenue_prev_q: num(rev?.frmtrm_q_amount), op_income_q: num(op?.thstrm_amount), op_income_prev_q: num(op?.frmtrm_q_amount),
    equity_parent: num(eq?.thstrm_amount),
    status: "ok", off_cycle: rceptDate !== null && Number(rceptDate.slice(5, 7)) !== expectedMonth, fetched_at: now, ni_tag: niTag,
    account_ids_used: QUARTERLY_ROW_VERSION_PREFIX + [used("ni", ni), used("rev", rev), used("op", op), used("eq", eq)].join(";"),
  };
}

type Meta = { code: string; corp: string; name: string; fyFrom: number; fyTo: number; delisted: boolean };
interface Item { t: Meta; fy: number; q: (typeof QUARTERLY_REPORTS)[number]; phase: 1 | 2 }
type Outcome = { kind: "ok" | "no_data_013" | "error"; row: QRow } | { kind: "transient" };

async function main(): Promise<void> {
  const keyPrimary = process.env[QUARTERLY_KEY_PRIMARY_ENV], keySecondary = process.env[QUARTERLY_KEY_SECONDARY_ENV];
  if (!keyPrimary || !keySecondary) throw new Error(`환경변수 ${QUARTERLY_KEY_PRIMARY_ENV}, ${QUARTERLY_KEY_SECONDARY_ENV}가 필요합니다.`);
  pool = new DartKeyPool([{ name: QUARTERLY_KEY_PRIMARY_ENV, value: keyPrimary }, { name: QUARTERLY_KEY_SECONDARY_ENV, value: keySecondary }], QUARTERLY_BACKFILL_RUN_REQUEST_CAP_V2);
  console.log(`DART 분기 실적 백필 3회차 시작: ${new Date().toISOString()} (키: 1순위 ${QUARTERLY_KEY_PRIMARY_ENV}, 2순위 ${QUARTERLY_KEY_SECONDARY_ENV}, 운영 키 DART_API_KEY 사용 안 함, 전체 상한 ${QUARTERLY_BACKFILL_RUN_REQUEST_CAP_V2})`);

  // ---- 시작 시 1순위 키 확인(list.json 1건) ----
  const chk = await dartJson((k) => `${DART_BASE_URL}/list.json?crtfc_key=${k}&corp_code=${QUARTERLY_KEY_CHECK.corpCode}&bgn_de=${QUARTERLY_KEY_CHECK.bgn}&end_de=${QUARTERLY_KEY_CHECK.end}&page_no=1&page_count=1`);
  const chkOn = pool.used.get(QUARTERLY_KEY_PRIMARY_ENV) === 1 && pool.got020.get(QUARTERLY_KEY_PRIMARY_ENV) === 0;
  console.log(`1순위 키(${QUARTERLY_KEY_PRIMARY_ENV}) list.json 확인: status ${chk?.status ?? "응답 없음"} (1순위 키로 보낸 요청 ${chkOn ? "맞음" : "아님"})`);
  if (!chkOn || chk?.status !== "000") { console.log("1순위 키 확인이 status 000이 아니라 진행하지 않습니다."); return; }

  const series: Map<string, StockDailyPriceRow[]> = await loadAllStockSeriesFromParquet(PARQUET_FROM_YEAR, PARQUET_TO_YEAR);
  console.log(`종목 ${series.size}개 로드(${PARQUET_FROM_YEAR}~${PARQUET_TO_YEAR})`);

  // ---- 대상 선정: 월말 PIT 유니버스에 한 번이라도 진입한 종목(dart_xbrl_fundamentals 백필과 같은 규칙) ----
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
    const rows = await selectAll<{ corp_code: string; corp_name: string; stock_code: string | null }>("dart_corp_codes", (f, t) => supabaseAdmin.from("dart_corp_codes").select("corp_code, corp_name, stock_code").in("stock_code", chunk).order("corp_code").range(f, t));
    for (const r of rows) if (r.stock_code && !corpMap.has(r.stock_code)) corpMap.set(r.stock_code, { corp_code: r.corp_code, corp_name: r.corp_name });
  }
  const targets: Meta[] = entryCodes.filter((c) => corpMap.has(c)).map((c) => {
    const rows = series.get(c)!;
    const delisted = rows[rows.length - 1].tradeDate < aliveCut;
    return {
      code: c, corp: corpMap.get(c)!.corp_code, name: corpMap.get(c)!.corp_name, delisted,
      fyFrom: Math.max(QUARTERLY_BACKFILL_FY_FROM, Number(rows[0].tradeDate.slice(0, 4))),
      fyTo: delisted ? Math.min(QUARTERLY_BACKFILL_FY_TO, Number(rows[rows.length - 1].tradeDate.slice(0, 4))) : QUARTERLY_BACKFILL_FY_TO,
    };
  });
  const corpToMeta = new Map(targets.map((t) => [t.corp, t]));
  console.log(`PIT 진입 종목 ${entryCodes.length}개, corp_code 있음(대상) ${targets.length}개 (상장폐지 ${targets.filter((t) => t.delisted).length}개), 데이터 끝 ${globalLast}`);

  // ---- 전체 키 목록: FY 최신→과거, 분기 3→1, 종목 코드순. 상장 기간 밖 연도·아직 공시 전인 분기는 제외 ----
  const items: Item[] = [];
  const todayMs = Date.now();
  let skippedNotYetFiled = 0;
  for (let fy = QUARTERLY_BACKFILL_FY_TO; fy >= QUARTERLY_BACKFILL_FY_FROM; fy--) {
    for (const q of [...QUARTERLY_REPORTS].reverse()) {
      const notYet = Date.parse(`${fy}-${q.qEndMmdd}`) + QUARTERLY_BACKFILL_FILING_LAG_DAYS * MS_DAY > todayMs;
      for (const t of targets) {
        if (fy < t.fyFrom || fy > t.fyTo) continue;
        if (notYet) { skippedNotYetFiled++; continue; }
        items.push({ t, fy, q, phase: 2 });
      }
    }
  }
  console.log(`전체 키(종목×연도×분기) ${items.length}건 (공시 전이라 제외한 키 ${skippedNotYetFiled}건)`);

  // ---- 저장된 키 상태 ----
  interface Stored { status: string; niNull: boolean; v2: boolean }
  const stored = new Map<string, Stored>();
  for (const r of await selectAll<{ corp_code: string; fiscal_year: number; quarter: number; status: string; ni_parent_q: number | null; account_ids_used: string | null }>(TABLE + "(스킵 확인)", (f, t) => supabaseAdmin.from(TABLE).select("corp_code, fiscal_year, quarter, status, ni_parent_q, account_ids_used").order("corp_code").order("fiscal_year").order("quarter").range(f, t)))
    stored.set(`${r.corp_code}|${r.fiscal_year}|${r.quarter}`, { status: r.status, niNull: r.ni_parent_q === null, v2: (r.account_ids_used ?? "").startsWith(QUARTERLY_ROW_VERSION_PREFIX) });
  const keyOf = (it: Item): string => `${it.t.corp}|${it.fy}|${it.q.quarter}`;
  // 1단계: status='ok'인데 ni_parent_q가 null인 기존 행(이 행들만 덮어쓰기 허용; 폴백 규칙 이후 저장분(v2)은 제외)
  const phase1: Item[] = [];
  for (const [k, v] of stored) {
    if (v.status !== "ok" || !v.niNull || v.v2) continue;
    const [corp, fy, q] = k.split("|");
    const t = corpToMeta.get(corp);
    const rep = QUARTERLY_REPORTS.find((x) => x.quarter === Number(q));
    if (t && rep) phase1.push({ t, fy: Number(fy), q: rep, phase: 1 });
  }
  phase1.sort((a, b) => b.fy - a.fy || b.q.quarter - a.q.quarter || (a.t.corp < b.t.corp ? -1 : 1));
  const phase2 = items.filter((it) => { const s = stored.get(keyOf(it))?.status; return s !== "ok" && s !== "no_data_013"; });
  const queue = [...phase1, ...phase2];
  console.log(`저장된 키 ${stored.size}건 | 1단계(ok & ni_parent_q null 재요청) ${phase1.length}건 | 2단계(미저장·error) ${phase2.length}건 | 요청 수 상한 ${QUARTERLY_BACKFILL_RUN_REQUEST_CAP_V2}`);

  // ---- 수집 ----
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
  let cursor = 0, doneKeys = 0, transientSkips = 0, nextLog = QUARTERLY_BACKFILL_PROGRESS_EVERY_REQUESTS;
  const p1 = { done: 0, parent: 0, profitloss: 0, stillNull: 0, noAcnt: 0, emptyAmt: 0, notOk: 0, transient: 0 };

  async function fetchItem(it: Item): Promise<Outcome> {
    const base = { corp_code: it.t.corp, stock_code: it.t.code, fiscal_year: it.fy, quarter: it.q.quarter };
    for (const fs of ["CFS", "OFS"]) {
      const j = await dartJson((k) => `${DART_BASE_URL}/fnlttSinglAcntAll.json?crtfc_key=${k}&corp_code=${it.t.corp}&bsns_year=${it.fy}&reprt_code=${it.q.reprtCode}&fs_div=${fs}`);
      if (!j) return { kind: "transient" };
      const now = new Date().toISOString();
      if (j.status === "013") {
        if (fs === "CFS") continue;
        return { kind: "no_data_013", row: { ...base, fs_div: "OFS", rcept_no: null, rcept_date: null, ni_parent_q: null, ni_parent_cum: null, ni_parent_prev_q: null, ni_parent_prev_cum: null, revenue_q: null, revenue_prev_q: null, op_income_q: null, op_income_prev_q: null, equity_parent: null, status: "no_data_013", off_cycle: false, fetched_at: now, account_ids_used: QUARTERLY_ROW_VERSION_PREFIX + "no_data_013", ni_tag: null } };
      }
      if (j.status === "000" && (j.list?.length ?? 0) > 0) return { kind: "ok", row: buildOk(base, fs, j.list!, it.q.expectedRceptMonth, now) };
      return { kind: "error", row: { ...base, fs_div: fs, rcept_no: null, rcept_date: null, ni_parent_q: null, ni_parent_cum: null, ni_parent_prev_q: null, ni_parent_prev_cum: null, revenue_q: null, revenue_prev_q: null, op_income_q: null, op_income_prev_q: null, equity_parent: null, status: "error", off_cycle: false, fetched_at: now, account_ids_used: `${QUARTERLY_ROW_VERSION_PREFIX}dart_status=${j.status ?? "?"}${j.status === "000" ? "(빈 목록)" : ""}`, ni_tag: null } };
    }
    return { kind: "transient" };
  }
  async function processItem(it: Item): Promise<void> {
    if (it.phase === 2) {
      const o = await fetchItem(it);
      if (o.kind === "transient") transientSkips++;
      else buffer.push(o.row);
      await flush(false);
      return;
    }
    // 1단계: 결과가 ok일 때만 덮어쓴다(013·오류·일시 오류면 기존 행을 건드리지 않는다).
    const o = await fetchItem(it);
    p1.done++;
    if (o.kind === "transient") { p1.transient++; return; }
    if (o.kind !== "ok") { p1.notOk++; return; }
    buffer.push(o.row);
    if (o.row.ni_parent_q !== null) { if (o.row.ni_tag === "parent") p1.parent++; else p1.profitloss++; }
    else { p1.stillNull++; if (o.row.ni_tag === null) p1.noAcnt++; else p1.emptyAmt++; }
    await flush(false);
  }
  async function worker(): Promise<void> {
    while (!stopReason) {
      if (pool.stopReason) { stopReason = pool.stopReason; break; }
      if (Date.now() > deadline) { stopReason = `소프트 데드라인 ${QUARTERLY_BACKFILL_SOFT_DEADLINE_MINUTES_V3}분 도달`; break; }
      const i = cursor++;
      if (i >= queue.length) break;
      await processItem(queue[i]);
      doneKeys++;
      if (pool.total >= nextLog) {
        nextLog += QUARTERLY_BACKFILL_PROGRESS_EVERY_REQUESTS;
        console.log(`진행 키 ${doneKeys}/${queue.length} | DART 요청 ${pool.total} (${[...pool.used].map(([n, v]) => `${n} ${v}`).join(", ")}) | 저장 대기 ${buffer.length}행, 저장 ${dbWritten.rows}행 | 경과 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
      }
    }
  }
  await Promise.all(Array.from({ length: QUARTERLY_BACKFILL_CONCURRENCY }, () => worker()));
  if (!stopReason && pool.stopReason) stopReason = pool.stopReason;
  await flush(true);
  console.log(`\n수집 종료: ${stopReason ?? "이번 실행 대상 키 전부 처리"} | 처리 키 ${doneKeys}/${queue.length} | 일시 오류로 저장 안 한 키 ${transientSkips + p1.transient}`);

  await report(items, targets, { phase1N: phase1.length, p1, queueN: queue.length, doneKeys, stopReason, transientSkips, skippedNotYetFiled });
}

// ---- 보고 ----
async function report(items: Item[], targets: Meta[], run: { phase1N: number; p1: { done: number; parent: number; profitloss: number; stillNull: number; noAcnt: number; emptyAmt: number; notOk: number; transient: number }; queueN: number; doneKeys: number; stopReason: string | null; transientSkips: number; skippedNotYetFiled: number }): Promise<void> {
  const rows = await selectAll<QRow>(TABLE + "(결과 집계)", (f, t) => supabaseAdmin.from(TABLE).select("*").order("corp_code").order("fiscal_year").order("quarter").range(f, t));
  const delistedCorp = new Set(targets.filter((t) => t.delisted).map((t) => t.corp));
  const rowBy = new Map(rows.map((r) => [`${r.corp_code}|${r.fiscal_year}|${r.quarter}`, r]));
  const doneCount = items.filter((it) => { const r = rowBy.get(`${it.t.corp}|${it.fy}|${it.q.quarter}`); return r && r.status !== "error"; }).length;
  const remainKeys = items.length - doneCount;
  const reqPerKey = run.doneKeys > 0 ? pool.total / run.doneKeys : 2;

  console.log("\n=== 1. 키·요청·중단 ===");
  console.log("| 키 이름 | 요청 수 | status 020 수신 |\n|---|---|---|");
  for (const [n, v] of pool.used) console.log(`| ${n} | ${v} | ${pool.got020.get(n) ?? 0} |`);
  console.log(`| 합계 | ${pool.total} (상한 ${QUARTERLY_BACKFILL_RUN_REQUEST_CAP_V2}) | - |`);
  console.log(`1순위→2순위 전환: ${pool.switchedAt ? `발생 ${pool.switchedAt} (전체 요청 ${pool.switchedAtRequest}번째 부근)` : "발생 안 함"}`);
  console.log(`중단 사유: ${run.stopReason ?? "이번 실행 대상 키 전부 처리"}`);
  const minutes = (Date.now() - T0) / 60000;
  console.log(`소요 ${minutes.toFixed(1)}분 | 분당 처리 키 ${(run.doneKeys / minutes).toFixed(1)} | 분당 DART 요청 ${(pool.total / minutes).toFixed(1)}`);

  console.log("\n=== 2. 재요청 행(ok & ni_parent_q null) 결과 ===");
  console.log("| 항목 | 값 |\n|---|---|");
  console.log(`| 재요청 대상 행 | ${run.phase1N} |`);
  console.log(`| 재요청 완료(응답 처리) | ${run.p1.done} |`);
  console.log(`| ni_tag=parent로 채워짐(ni_parent_q 기준 별도 아래 표) | ${run.p1.parent} |`);
  console.log(`| ni_tag=profitloss로 채워짐 | ${run.p1.profitloss} |`);
  console.log(`| ni_tag 있으나 금액이 비어 여전히 null | ${run.p1.emptyAmt} |`);
  console.log(`| ni 계정(지배·ProfitLoss) 모두 없어 null | ${run.p1.noAcnt} |`);
  console.log(`| 응답이 ok 아님(013·오류): 기존 행 유지 | ${run.p1.notOk} |`);
  console.log(`| 일시 오류·상한으로 미처리(기존 행 유지) | ${run.p1.transient} |`);
  const reDone = rows.filter((r) => r.status === "ok" && (r.account_ids_used ?? "").startsWith(QUARTERLY_ROW_VERSION_PREFIX));
  console.log(`(참고) v2 규칙으로 저장된 ok 행 누계 ${reDone.length}, 그중 ni_parent_q 여전히 null ${reDone.filter((r) => r.ni_parent_q === null).length}`);

  console.log("\n=== 3. 진행 ===");
  console.log("| 항목 | 값 |\n|---|---|");
  console.log(`| 이번 실행 처리 키 / 대기열 | ${run.doneKeys} / ${run.queueN} |`);
  console.log(`| 요청 수 / 처리 키 | ${reqPerKey.toFixed(3)} |`);
  console.log(`| 누적 진행률(저장된 키, error 제외) | ${doneCount} / ${items.length} (${pct(doneCount, items.length)}) |`);
  console.log(`| 남은 키 | ${remainKeys} |`);
  console.log(`| 남은 요청 추정 | ${Math.round(remainKeys * reqPerKey)} (이번 실행 평균 기준) ~ ${remainKeys * 2} (OFS 폴백 상한) |`);
  console.log(`| 공시 전이라 제외한 키 | ${run.skippedNotYetFiled} |`);

  const fys: number[] = [];
  for (let fy = QUARTERLY_BACKFILL_FY_TO; fy >= QUARTERLY_BACKFILL_FY_FROM; fy--) fys.push(fy);
  console.log("\n=== 4. 회계연도 × 분기별 status ===");
  console.log("| FY | 분기 | 전체 키 | ok | no_data_013 | error | 미저장 |\n|---|---|---|---|---|---|---|");
  for (const fy of fys) {
    for (const q of QUARTERLY_REPORTS) {
      const its = items.filter((it) => it.fy === fy && it.q.quarter === q.quarter);
      if (!its.length) continue;
      const rs = its.map((it) => rowBy.get(`${it.t.corp}|${fy}|${q.quarter}`));
      console.log(`| ${fy} | ${q.quarter} | ${its.length} | ${rs.filter((r) => r?.status === "ok").length} | ${rs.filter((r) => r?.status === "no_data_013").length} | ${rs.filter((r) => r?.status === "error").length} | ${rs.filter((r) => !r).length} |`);
    }
  }
  for (const fy of [2016, 2017]) {
    const firstOk = QUARTERLY_REPORTS.find((q) => rows.some((r) => r.fiscal_year === fy && r.quarter === q.quarter && r.status === "ok"));
    const stored = rows.filter((r) => r.fiscal_year === fy).length;
    console.log(`FY${fy}: 저장 행 ${stored}건, ok가 처음 나오는 분기 = ${firstOk ? `${firstOk.quarter}분기` : stored === 0 ? "아직 진행 안 함" : "ok 없음"}`);
  }

  console.log("\n=== 5. ok 행 null 비율(연도별, ni_tag별) ===");
  console.log("(ni_tag: parent / profitloss / 없음 = ni 계정 없음 또는 1회차 저장분(폴백 도입 전))");
  console.log("| FY | ni_tag | ok 행 | ni_parent_q null | revenue_q null | op_income_q null | ni_parent_prev_q null | off_cycle |\n|---|---|---|---|---|---|---|---|");
  for (const fy of fys) {
    const okFy = rows.filter((r) => r.fiscal_year === fy && r.status === "ok");
    if (!okFy.length) continue;
    for (const tag of ["parent", "profitloss", null, "전체"] as const) {
      const ok = tag === "전체" ? okFy : okFy.filter((r) => r.ni_tag === tag);
      if (!ok.length) continue;
      const nn = (k: keyof QRow): string => { const n = ok.filter((r) => r[k] === null).length; return `${n} (${pct(n, ok.length)})`; };
      console.log(`| ${fy} | ${tag ?? "없음"} | ${ok.length} | ${nn("ni_parent_q")} | ${nn("revenue_q")} | ${nn("op_income_q")} | ${nn("ni_parent_prev_q")} | ${ok.filter((r) => r.off_cycle).length} |`);
    }
  }
  console.log(`off_cycle 전체 ${rows.filter((r) => r.off_cycle).length}건 (ok 행 ${rows.filter((r) => r.status === "ok").length}건 중)`);

  console.log("\n상장폐지 / 생존 종목 ok 비율(연도별, 저장된 행 기준)");
  console.log("| FY | 상장폐지 저장 행 | ok | ok 비율 | 생존 저장 행 | ok | ok 비율 |\n|---|---|---|---|---|---|---|");
  for (const fy of fys) {
    const d = rows.filter((r) => r.fiscal_year === fy && delistedCorp.has(r.corp_code));
    const a = rows.filter((r) => r.fiscal_year === fy && !delistedCorp.has(r.corp_code));
    if (!d.length && !a.length) continue;
    const dok = d.filter((r) => r.status === "ok").length, aok = a.filter((r) => r.status === "ok").length;
    console.log(`| ${fy} | ${d.length} | ${dok} | ${pct(dok, d.length)} | ${a.length} | ${aok} | ${pct(aok, a.length)} |`);
  }

  console.log("\n=== 5. 전략 설계용 집계 ===");
  console.log("| FY | (a) ni_parent_q·prev_q 둘 다 있는 ok 행 | (a) 종목 수 | (b) op_income_q·prev_q 둘 다 있는 ok 행 | (b) 종목 수 |\n|---|---|---|---|---|");
  for (const fy of fys) {
    const okFy = rows.filter((r) => r.fiscal_year === fy && r.status === "ok");
    if (!okFy.length) continue;
    const a = okFy.filter((r) => r.ni_parent_q !== null && r.ni_parent_prev_q !== null);
    const b = okFy.filter((r) => r.op_income_q !== null && r.op_income_prev_q !== null);
    console.log(`| ${fy} | ${a.length} | ${new Set(a.map((r) => r.corp_code)).size} | ${b.length} | ${new Set(b.map((r) => r.corp_code)).size} |`);
  }
  const qtile = (v: number[], p: number): number => { const s = [...v].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
  console.log("\n분기별 접수일 = 분기말 + 며칠 (ok 행, rcept_date 있는 행; 전 연도 합산)");
  console.log("| 분기 | 행 수 | 최소 | 중앙값 | 90분위 | 최대 |\n|---|---|---|---|---|---|");
  for (const q of QUARTERLY_REPORTS) {
    const lags = rows.filter((r) => r.status === "ok" && r.quarter === q.quarter && r.rcept_date).map((r) => (Date.parse(r.rcept_date!) - Date.parse(`${r.fiscal_year}-${q.qEndMmdd}`)) / MS_DAY);
    console.log(`| ${q.quarter} | ${lags.length} | ${Math.min(...lags)} | ${qtile(lags, 0.5)} | ${qtile(lags, 0.9)} | ${Math.max(...lags)} |`);
  }

  console.log("\n=== 6. 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: ${dbWritten.rows} | DART 요청 수: ${pool.total} | KIS 요청: 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

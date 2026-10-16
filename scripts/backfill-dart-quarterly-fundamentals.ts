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
  QUARTERLY_BACKFILL_SOFT_DEADLINE_MINUTES, QUARTERLY_BACKFILL_FY_FROM, QUARTERLY_BACKFILL_FY_TO, QUARTERLY_REPORTS,
  QUARTERLY_BACKFILL_FILING_LAG_DAYS, QUARTERLY_BACKFILL_RUN_REQUEST_CAP, QUARTERLY_BACKFILL_PROGRESS_EVERY_REQUESTS,
  QUARTERLY_BACKFILL_VERIFY_SEED, QUARTERLY_BACKFILL_VERIFY_SAMPLE, QUARTERLY_ACCOUNT_PREFIX_RE,
} from "@/lib/dartQuarterlyBackfillConfig";

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

// ---- DART 호출(동시 4 + 최소 간격 + 429/5xx/800/네트워크 오류 최대 2회 재시도, 실행당 요청 상한) ----
let dartRequests = 0, limitHit = false, capHit = false;
let nextSlot = 0;
async function slot(): Promise<void> {
  const now = Date.now();
  const s = Math.max(now, nextSlot);
  nextSlot = s + QUARTERLY_BACKFILL_MIN_REQUEST_GAP_MS;
  if (s > now) await sleep(s - now);
}
interface AcntRow { rcept_no?: string; sj_div?: string; account_id?: string; account_detail?: string; thstrm_amount?: string; thstrm_add_amount?: string; frmtrm_q_amount?: string; frmtrm_add_amount?: string }
interface DartJson { status?: string; message?: string; list?: AcntRow[] }
/** null = 일시 오류·상한·한도로 결과를 얻지 못함(저장하지 않아 다음 실행에서 다시 시도). */
async function dartJson(url: string): Promise<DartJson | null> {
  for (let attempt = 0; attempt <= QUARTERLY_BACKFILL_MAX_RETRIES; attempt++) {
    if (limitHit) return null;
    if (dartRequests >= QUARTERLY_BACKFILL_RUN_REQUEST_CAP) { capHit = true; return null; }
    await slot();
    dartRequests++;
    try {
      const res = await fetch(url);
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const j = JSON.parse(text) as DartJson;
      if (j.status === "020") { limitHit = true; return null; }
      if (j.status === "800") throw new Error("status 800");
      return j;
    } catch {
      if (attempt < QUARTERLY_BACKFILL_MAX_RETRIES) await sleep(QUARTERLY_BACKFILL_RETRY_BASE_MS * 2 ** attempt);
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
  status: "ok" | "no_data_013" | "error"; off_cycle: boolean; fetched_at: string; account_ids_used: string | null;
}
function buildOk(base: { corp_code: string; stock_code: string; fiscal_year: number; quarter: number }, fs: string, rows: AcntRow[], expectedMonth: number, now: string): QRow {
  const rcept = rows.find((r) => r.rcept_no)?.rcept_no ?? null;
  const rceptDate = rcept ? `${rcept.slice(0, 4)}-${rcept.slice(4, 6)}-${rcept.slice(6, 8)}` : null;
  const ni = pickAcnt(rows, "ProfitLossAttributableToOwnersOfParent", ["IS", "CIS"]);
  const rev = pickAcnt(rows, "Revenue", ["IS", "CIS"]);
  const op = pickAcnt(rows, "OperatingIncomeLoss", ["IS", "CIS"]);
  const eq = pickAcnt(rows, "EquityAttributableToOwnersOfParent", ["BS"]);
  const used = (k: string, r: AcntRow | null): string => `${k}:${r ? `${r.account_id}(${r.sj_div})` : "no_match"}`;
  return {
    ...base, fs_div: fs, rcept_no: rcept, rcept_date: rceptDate,
    ni_parent_q: num(ni?.thstrm_amount), ni_parent_cum: num(ni?.thstrm_add_amount), ni_parent_prev_q: num(ni?.frmtrm_q_amount), ni_parent_prev_cum: num(ni?.frmtrm_add_amount),
    revenue_q: num(rev?.thstrm_amount), revenue_prev_q: num(rev?.frmtrm_q_amount), op_income_q: num(op?.thstrm_amount), op_income_prev_q: num(op?.frmtrm_q_amount),
    equity_parent: num(eq?.thstrm_amount),
    status: "ok", off_cycle: rceptDate !== null && Number(rceptDate.slice(5, 7)) !== expectedMonth, fetched_at: now,
    account_ids_used: [used("ni", ni), used("rev", rev), used("op", op), used("eq", eq)].join(";"),
  };
}

type Meta = { code: string; corp: string; name: string; fyFrom: number; fyTo: number; delisted: boolean };
interface Item { t: Meta; fy: number; q: (typeof QUARTERLY_REPORTS)[number] }

async function main(): Promise<void> {
  const dartKey = process.env.DART_API_KEY;
  if (!dartKey) throw new Error("DART_API_KEY 환경변수가 필요합니다.");
  console.log(`DART 분기 실적 백필 시작: ${new Date().toISOString()}`);
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
    const rows = await selectAll<{ corp_code: string; corp_name: string; stock_code: string | null }>("dart_corp_codes", (f, t) => supabaseAdmin.from("dart_corp_codes").select("corp_code, corp_name, stock_code").in("stock_code", chunk).range(f, t));
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
  console.log(`PIT 진입 종목 ${entryCodes.length}개, corp_code 있음(대상) ${targets.length}개 (상장폐지 ${targets.filter((t) => t.delisted).length}개), 데이터 끝 ${globalLast}`);

  // ---- 전체 키 목록: FY 최신→과거, 분기 3→1, 종목 코드순. 상장 기간 밖 연도·아직 공시 전인 분기는 제외 ----
  const items: Item[] = [];
  const todayMs = Date.now();
  let skippedNotYetFiled = 0;
  for (let fy = QUARTERLY_BACKFILL_FY_TO; fy >= QUARTERLY_BACKFILL_FY_FROM; fy--) {
    for (const q of [...QUARTERLY_REPORTS].reverse()) {
      const qEndMs = Date.parse(`${fy}-${q.qEndMmdd}`);
      const notYet = qEndMs + QUARTERLY_BACKFILL_FILING_LAG_DAYS * MS_DAY > todayMs;
      for (const t of targets) {
        if (fy < t.fyFrom || fy > t.fyTo) continue;
        if (notYet) { skippedNotYetFiled++; continue; }
        items.push({ t, fy, q });
      }
    }
  }
  console.log(`전체 키(종목×연도×분기) ${items.length}건 (공시 전이라 제외한 키 ${skippedNotYetFiled}건: 분기말+${QUARTERLY_BACKFILL_FILING_LAG_DAYS}일이 오늘 이후)`);

  // ---- 이미 저장된 키(ok / no_data_013은 건너뜀, error는 재시도) ----
  const stored = new Map<string, string>();
  for (const r of await selectAll<{ corp_code: string; fiscal_year: number; quarter: number; status: string }>(TABLE + "(스킵 확인)", (f, t) => supabaseAdmin.from(TABLE).select("corp_code, fiscal_year, quarter, status").order("corp_code").order("fiscal_year").order("quarter").range(f, t))) stored.set(`${r.corp_code}|${r.fiscal_year}|${r.quarter}`, r.status);
  const keyOf = (it: Item): string => `${it.t.corp}|${it.fy}|${it.q.quarter}`;
  const pending = items.filter((it) => { const s = stored.get(keyOf(it)); return s !== "ok" && s !== "no_data_013"; });
  console.log(`이미 저장된 키 ${stored.size}건, 이번에 시도할 키 ${pending.length}건 (요청 수 상한 ${pending.length}×2 = ${pending.length * 2}, 실행당 상한 ${QUARTERLY_BACKFILL_RUN_REQUEST_CAP})`);

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
  const deadline = T0 + QUARTERLY_BACKFILL_SOFT_DEADLINE_MINUTES * 60_000;
  let stopReason: string | null = null;
  let cursor = 0, doneKeys = 0, transientSkips = 0, nextLog = QUARTERLY_BACKFILL_PROGRESS_EVERY_REQUESTS;

  async function processItem(it: Item): Promise<void> {
    const base = { corp_code: it.t.corp, stock_code: it.t.code, fiscal_year: it.fy, quarter: it.q.quarter };
    for (const fs of ["CFS", "OFS"]) {
      const j = await dartJson(`${DART_BASE_URL}/fnlttSinglAcntAll.json?crtfc_key=${dartKey}&corp_code=${it.t.corp}&bsns_year=${it.fy}&reprt_code=${it.q.reprtCode}&fs_div=${fs}`);
      if (!j) { transientSkips++; return; }
      const now = new Date().toISOString();
      if (j.status === "013") {
        if (fs === "CFS") continue;
        buffer.push({ ...base, fs_div: "OFS", rcept_no: null, rcept_date: null, ni_parent_q: null, ni_parent_cum: null, ni_parent_prev_q: null, ni_parent_prev_cum: null, revenue_q: null, revenue_prev_q: null, op_income_q: null, op_income_prev_q: null, equity_parent: null, status: "no_data_013", off_cycle: false, fetched_at: now, account_ids_used: null });
      } else if (j.status === "000" && (j.list?.length ?? 0) > 0) {
        buffer.push(buildOk(base, fs, j.list!, it.q.expectedRceptMonth, now));
      } else {
        buffer.push({ ...base, fs_div: fs, rcept_no: null, rcept_date: null, ni_parent_q: null, ni_parent_cum: null, ni_parent_prev_q: null, ni_parent_prev_cum: null, revenue_q: null, revenue_prev_q: null, op_income_q: null, op_income_prev_q: null, equity_parent: null, status: "error", off_cycle: false, fetched_at: now, account_ids_used: `dart_status=${j.status ?? "?"}${j.status === "000" ? "(빈 목록)" : ""}` });
      }
      await flush(false);
      return;
    }
  }
  async function worker(): Promise<void> {
    while (!stopReason) {
      if (limitHit) { stopReason = "DART status 020(요청 한도 초과) 수신"; break; }
      if (capHit) { stopReason = `실행당 요청 상한 ${QUARTERLY_BACKFILL_RUN_REQUEST_CAP}건 도달`; break; }
      if (Date.now() > deadline) { stopReason = `소프트 데드라인 ${QUARTERLY_BACKFILL_SOFT_DEADLINE_MINUTES}분 도달`; break; }
      const i = cursor++;
      if (i >= pending.length) break;
      await processItem(pending[i]);
      doneKeys++;
      if (dartRequests >= nextLog) {
        nextLog += QUARTERLY_BACKFILL_PROGRESS_EVERY_REQUESTS;
        console.log(`진행 키 ${doneKeys}/${pending.length} | DART 요청 ${dartRequests} | 저장 대기 ${buffer.length}행, 저장 ${dbWritten.rows}행 | 경과 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
      }
    }
  }
  await Promise.all(Array.from({ length: QUARTERLY_BACKFILL_CONCURRENCY }, () => worker()));
  if (!stopReason && limitHit) stopReason = "DART status 020(요청 한도 초과) 수신";
  if (!stopReason && capHit) stopReason = `실행당 요청 상한 ${QUARTERLY_BACKFILL_RUN_REQUEST_CAP}건 도달`;
  await flush(true);
  console.log(`\n수집 종료: ${stopReason ?? "이번 실행 대상 키 전부 처리"} | 처리 키 ${doneKeys}/${pending.length} | 일시 오류로 저장 안 한 키 ${transientSkips}`);

  await report(items, targets, { pendingN: pending.length, doneKeys, stopReason, transientSkips, skippedNotYetFiled });
}

// ---- 보고 ----
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function sample<T>(arr: T[], n: number, rnd: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}
async function report(items: Item[], targets: Meta[], run: { pendingN: number; doneKeys: number; stopReason: string | null; transientSkips: number; skippedNotYetFiled: number }): Promise<void> {
  const rows = await selectAll<QRow>(TABLE + "(결과 집계)", (f, t) => supabaseAdmin.from(TABLE).select("*").order("corp_code").order("fiscal_year").order("quarter").range(f, t));
  const delistedCorp = new Set(targets.filter((t) => t.delisted).map((t) => t.corp));
  const rowBy = new Map(rows.map((r) => [`${r.corp_code}|${r.fiscal_year}|${r.quarter}`, r]));
  const doneCount = items.filter((it) => { const r = rowBy.get(`${it.t.corp}|${it.fy}|${it.q.quarter}`); return r && r.status !== "error"; }).length;
  const remainKeys = items.length - doneCount;
  const perKey = run.doneKeys > 0 ? dartRequests / run.doneKeys : 2;

  console.log("\n=== 1. 진행 ===");
  console.log("| 항목 | 값 |");
  console.log("|---|---|");
  console.log(`| 이번 실행 DART 요청 수 | ${dartRequests} (상한 ${QUARTERLY_BACKFILL_RUN_REQUEST_CAP}) |`);
  console.log(`| 이번 실행 처리 키 / 시도 대상 키 | ${run.doneKeys} / ${run.pendingN} |`);
  console.log(`| 요청 수 / 처리 키 | ${perKey.toFixed(3)} |`);
  console.log(`| 누적 진행률(저장된 키, error 제외) | ${doneCount} / ${items.length} (${pct(doneCount, items.length)}) |`);
  console.log(`| 남은 키 | ${remainKeys} |`);
  console.log(`| 남은 요청 추정 | ${Math.round(remainKeys * perKey)} (이번 실행 평균 ${perKey.toFixed(3)}/키 기준) ~ ${remainKeys * 2} (전부 OFS 폴백 상한) |`);
  console.log(`| 공시 전이라 제외한 키 | ${run.skippedNotYetFiled} |`);
  console.log(`| 일시 오류로 저장 안 한 키 | ${run.transientSkips} |`);
  console.log(`| 중단 사유 | ${run.stopReason ?? "이번 실행 대상 키 전부 처리"} |`);

  const fys: number[] = [];
  for (let fy = QUARTERLY_BACKFILL_FY_TO; fy >= QUARTERLY_BACKFILL_FY_FROM; fy--) fys.push(fy);
  console.log("\n=== 2. 회계연도 × 분기별 status ===");
  console.log("| FY | 분기 | 전체 키 | ok | no_data_013 | error | 미저장 |");
  console.log("|---|---|---|---|---|---|---|");
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

  console.log("\n=== 3. ok 행 null 비율(연도별)과 off_cycle ===");
  console.log("| FY | ok 행 | ni_parent_q null | revenue_q null | op_income_q null | ni_parent_prev_q null | off_cycle 건수 |");
  console.log("|---|---|---|---|---|---|---|");
  for (const fy of fys) {
    const ok = rows.filter((r) => r.fiscal_year === fy && r.status === "ok");
    if (!ok.length) continue;
    const nn = (k: keyof QRow): string => { const n = ok.filter((r) => r[k] === null).length; return `${n} (${pct(n, ok.length)})`; };
    console.log(`| ${fy} | ${ok.length} | ${nn("ni_parent_q")} | ${nn("revenue_q")} | ${nn("op_income_q")} | ${nn("ni_parent_prev_q")} | ${ok.filter((r) => r.off_cycle).length} |`);
  }
  console.log(`off_cycle 전체 ${rows.filter((r) => r.off_cycle).length}건 (ok 행 ${rows.filter((r) => r.status === "ok").length}건 중)`);

  console.log("\n=== 4. 상장폐지 / 생존 종목 ok 비율(연도별, 저장된 행 기준) ===");
  console.log("| FY | 상장폐지 저장 행 | 상장폐지 ok | 상장폐지 ok 비율 | 생존 저장 행 | 생존 ok | 생존 ok 비율 |");
  console.log("|---|---|---|---|---|---|---|");
  for (const fy of fys) {
    const d = rows.filter((r) => r.fiscal_year === fy && delistedCorp.has(r.corp_code));
    const a = rows.filter((r) => r.fiscal_year === fy && !delistedCorp.has(r.corp_code));
    if (!d.length && !a.length) continue;
    const dok = d.filter((r) => r.status === "ok").length, aok = a.filter((r) => r.status === "ok").length;
    console.log(`| ${fy} | ${d.length} | ${dok} | ${pct(dok, d.length)} | ${a.length} | ${aok} | ${pct(aok, a.length)} |`);
  }

  console.log(`\n=== 5. 검증(시드 ${QUARTERLY_BACKFILL_VERIFY_SEED}, 표본 ${QUARTERLY_BACKFILL_VERIFY_SAMPLE}) ===`);
  const rnd = mulberry32(QUARTERLY_BACKFILL_VERIFY_SEED);
  const okRows = rows.filter((r) => r.status === "ok");
  const q1Ok = okRows.filter((r) => r.quarter === 1);
  const q1Check = (r: QRow): boolean | null => (r.ni_parent_q === null || r.ni_parent_cum === null ? null : r.ni_parent_q === r.ni_parent_cum);
  const q2Pairs = okRows.filter((r) => r.quarter === 2).map((q2) => ({ q2, q1: rowBy.get(`${q2.corp_code}|${q2.fiscal_year}|1`) })).filter((p) => p.q1?.status === "ok");
  const q2Check = (p: { q2: QRow; q1?: QRow }): boolean | null => (p.q2.ni_parent_cum === null || p.q2.ni_parent_q === null || p.q1!.ni_parent_cum === null ? null : p.q2.ni_parent_cum === p.q1!.ni_parent_cum + p.q2.ni_parent_q);
  const tally = (arr: (boolean | null)[]): string => `성립 ${arr.filter((x) => x === true).length} / 불성립 ${arr.filter((x) => x === false).length} / 계산 불가(null) ${arr.filter((x) => x === null).length}`;
  const s1 = sample(q1Ok, QUARTERLY_BACKFILL_VERIFY_SAMPLE, rnd);
  const s2 = sample(q2Pairs, QUARTERLY_BACKFILL_VERIFY_SAMPLE, rnd);
  console.log("| 검증 | 대상 | 결과 |");
  console.log("|---|---|---|");
  console.log(`| 1분기 ni_parent_q = ni_parent_cum (표본) | ok 1분기 ${q1Ok.length}건 중 ${s1.length}건 | ${tally(s1.map(q1Check))} |`);
  console.log(`| 1분기 ni_parent_q = ni_parent_cum (전수) | ${q1Ok.length}건 | ${tally(q1Ok.map(q1Check))} |`);
  console.log(`| 반기 cum = 1분기 cum + 반기 q (표본) | 1분기·반기 모두 ok인 쌍 ${q2Pairs.length}건 중 ${s2.length}건 | ${tally(s2.map(q2Check))} |`);
  console.log(`| 반기 cum = 1분기 cum + 반기 q (전수) | ${q2Pairs.length}건 | ${tally(q2Pairs.map(q2Check))} |`);

  console.log("\n=== 6. 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: ${dbWritten.rows} | DART 요청 수: ${dartRequests} | KIS 요청: 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

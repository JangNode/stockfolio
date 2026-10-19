/**
 * DART XBRL(fnlttXbrl.xml)로 FY2010(prior_col)~FY2014 지배주주 NI·자본·기본EPS를 백필해
 * dart_xbrl_fundamentals(새 표)에 저장한다. 대상: 월말 PIT 유니버스(시총 5천억 이상 + 20일 평균 거래대금
 * 5억 이상, lib/strategyBacktestSummaryConfig.ts)에 2010-01부터 캐시 마지막 날까지 한 번이라도 진입한
 * 종목(상장폐지 포함) 중 dart_corp_codes에 corp_code가 있는 종목. 시총은 수집 대상 선정에만 쓴다.
 * DB 접근은 REST(supabaseAdmin)만. 기존 표는 읽기만 한다(stock_annual_fundamentals: 이음새 점검용).
 * 추출 규칙은 lib/dartXbrlExtract.ts(커밋 f65e29a와 동일). 한 번 실행하고 끝난다.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import {
  XBRL_BACKFILL_FISCAL_YEARS, XBRL_BACKFILL_PRIOR_COL_FISCAL_YEAR, XBRL_BACKFILL_FISCAL_MONTH, XBRL_BACKFILL_LIST_FROM, XBRL_BACKFILL_LIST_TO,
  DART_LIST_PAGE_COUNT, XBRL_BACKFILL_UNIVERSE_MIN_CAP_EOK, XBRL_BACKFILL_PIT_FROM, XBRL_BACKFILL_MAX_REQUESTS, XBRL_BACKFILL_CONCURRENCY,
  XBRL_BACKFILL_MIN_REQUEST_GAP_MS, XBRL_BACKFILL_MAX_RETRIES, XBRL_BACKFILL_RETRY_BASE_MS, XBRL_BACKFILL_ASSUMED_DAILY_LIMIT,
  XBRL_BACKFILL_SOFT_DEADLINE_MINUTES, XBRL_BACKFILL_PROGRESS_EVERY, XBRL_BACKFILL_UPSERT_BATCH, XBRL_BACKFILL_DB_IN_CHUNK, FIN_NAME_RE,
} from "@/lib/dartXbrlBackfillConfig";
import { parseInst, pickReport, periodOf, lastDayOfMonth, buildRow, type Filing, type XFetch, type XbrlRow, type ReportPick } from "@/lib/dartXbrlExtract";

const DART_BASE_URL = "https://opendart.fss.or.kr/api";
const TABLE = "dart_xbrl_fundamentals";
const PARQUET_FROM_YEAR = 2010;
const PARQUET_TO_YEAR = 2026;
const T0 = Date.now();
const isZip = (b: Buffer): boolean => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pc = (a: number, b: number): string => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

// ---- DART 호출(동시 4 + 최소 간격 + 429/5xx 최대 2회 재시도) ----
let dartRequests = 0, limitHit = false;
let nextSlot = 0;
async function slot(): Promise<void> {
  const now = Date.now();
  const s = Math.max(now, nextSlot);
  nextSlot = s + XBRL_BACKFILL_MIN_REQUEST_GAP_MS;
  if (s > now) await sleep(s - now);
}
interface Resp { status: number; buf: Buffer }
async function dartGet(url: string): Promise<Resp | null> {
  for (let attempt = 0; attempt <= XBRL_BACKFILL_MAX_RETRIES; attempt++) {
    if (limitHit) return null;
    await slot();
    dartRequests++;
    try {
      const res = await fetch(url);
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!isZip(buf)) {
        const st = /"status"\s*:\s*"(\d+)"/.exec(buf.toString("utf-8"))?.[1] ?? /<status>(\d+)</.exec(buf.toString("utf-8"))?.[1];
        if (st === "020") { limitHit = true; return null; }
        if (st === "800") throw new Error("status 800");
      }
      return { status: res.status, buf };
    } catch {
      if (attempt < XBRL_BACKFILL_MAX_RETRIES) await sleep(XBRL_BACKFILL_RETRY_BASE_MS * 2 ** attempt);
    }
  }
  return null;
}
async function dartList(key: string, corp: string): Promise<Filing[] | null> {
  const rows: Filing[] = [];
  for (let page = 1, pages = 1; page <= pages; page++) {
    const r = await dartGet(`${DART_BASE_URL}/list.json?crtfc_key=${key}&corp_code=${corp}&bgn_de=${XBRL_BACKFILL_LIST_FROM}&end_de=${XBRL_BACKFILL_LIST_TO}&pblntf_ty=A&page_no=${page}&page_count=${DART_LIST_PAGE_COUNT}`);
    if (!r) return null;
    let j: { status?: string; list?: Filing[]; total_page?: number } | null = null;
    try { j = JSON.parse(r.buf.toString("utf-8")); } catch { return null; }
    if (j?.status === "013") return rows;
    if (j?.status !== "000") return null;
    rows.push(...(j.list ?? []));
    pages = j.total_page ?? 1;
  }
  return rows;
}
async function fetchXbrl(key: string, rcept: string): Promise<XFetch | null> {
  const r = await dartGet(`${DART_BASE_URL}/fnlttXbrl.xml?crtfc_key=${key}&rcept_no=${rcept}&reprt_code=11011`);
  if (!r) return null;
  if (!isZip(r.buf)) return /<status>014</.test(r.buf.toString("utf-8")) ? { kind: "014" } : null;
  const p = parseInst(r.buf);
  return "error" in p ? null : { kind: "inst", facts: p.facts };
}

// ---- Supabase REST 읽기(행 수 집계) ----
const dbRead = { dart_corp_codes: 0, stock_annual_fundamentals: 0, [TABLE + "(스킵 확인)"]: 0, [TABLE + "(결과 집계)"]: 0 } as Record<string, number>;
const dbWritten = { rows: 0 };
async function selectAll<T>(label: string, build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(`${label}: ${error.message}`);
    out.push(...(data ?? []));
    dbRead[label] += data?.length ?? 0;
    if ((data?.length ?? 0) < 1000) break;
  }
  return out;
}

type Meta = { code: string; corp: string; name: string; fin: boolean; entryYear: number };
const bucketOf = (y: number): string => (y <= 2016 ? "2010~2016" : y <= 2020 ? "2017~2020" : "2021 이후");
const BUCKETS = ["2010~2016", "2017~2020", "2021 이후"];

async function main(): Promise<void> {
  const dartKey = process.env.DART_API_KEY;
  if (!dartKey) throw new Error("DART_API_KEY 환경변수가 필요합니다.");
  console.log(`DART XBRL 백필 시작: ${new Date().toISOString()}`);
  const series: Map<string, StockDailyPriceRow[]> = await loadAllStockSeriesFromParquet(PARQUET_FROM_YEAR, PARQUET_TO_YEAR);
  console.log(`종목 ${series.size}개 로드(${PARQUET_FROM_YEAR}~${PARQUET_TO_YEAR})`);

  // ---- 대상 선정: 월말 PIT 유니버스 최초 진입 연도 ----
  const dates = new Set<string>();
  for (const rows of series.values()) for (const r of rows) if (r.tradeDate >= XBRL_BACKFILL_PIT_FROM) dates.add(r.tradeDate);
  const cal = [...dates].sort();
  const monthEnds = new Set<string>();
  for (let k = 0; k + 1 < cal.length; k++) if (cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7)) monthEnds.add(cal[k]);
  const lastMonthEnd = [...monthEnds].sort().pop();
  console.log(`캐시 거래일 ${cal[0]} ~ ${cal[cal.length - 1]}, 월말 ${monthEnds.size}개(마지막 월말 ${lastMonthEnd}; 진행 중인 마지막 달은 월말이 아니므로 제외)`);
  const entry = new Map<string, number>();
  for (const [code, rows] of series) {
    const tv = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].tradeDate < XBRL_BACKFILL_PIT_FROM || !monthEnds.has(rows[i].tradeDate)) continue;
      if (rows[i - 1].marketCapEok >= XBRL_BACKFILL_UNIVERSE_MIN_CAP_EOK && tv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON) { entry.set(code, Number(rows[i].tradeDate.slice(0, 4))); break; }
    }
  }
  const entryCodes = [...entry.keys()].sort();
  const corpMap = new Map<string, { corp_code: string; corp_name: string }>();
  for (let i = 0; i < entryCodes.length; i += XBRL_BACKFILL_DB_IN_CHUNK) {
    const chunk = entryCodes.slice(i, i + XBRL_BACKFILL_DB_IN_CHUNK);
    const rows = await selectAll<{ corp_code: string; corp_name: string; stock_code: string | null }>("dart_corp_codes", (f, t) => supabaseAdmin.from("dart_corp_codes").select("corp_code, corp_name, stock_code").in("stock_code", chunk).order("corp_code").range(f, t));
    for (const r of rows) if (r.stock_code && !corpMap.has(r.stock_code)) corpMap.set(r.stock_code, { corp_code: r.corp_code, corp_name: r.corp_name });
  }
  const targets: Meta[] = entryCodes.filter((c) => corpMap.has(c)).map((c) => ({ code: c, corp: corpMap.get(c)!.corp_code, name: corpMap.get(c)!.corp_name, fin: FIN_NAME_RE.test(corpMap.get(c)!.corp_name), entryYear: entry.get(c)! }));
  console.log("\n=== 대상 종목 수 (최초 진입 연도 구간별) ===");
  console.log("| 구간 | PIT 진입 종목 | corp_code 있음(대상) | corp_code 없음 |");
  console.log("|---|---|---|---|");
  for (const b of BUCKETS) {
    const all = entryCodes.filter((c) => bucketOf(entry.get(c)!) === b);
    const withCorp = targets.filter((t) => bucketOf(t.entryYear) === b);
    console.log(`| ${b} | ${all.length} | ${withCorp.length} | ${all.length - withCorp.length} |`);
  }
  console.log(`| 합계 | ${entryCodes.length} | ${targets.length} | ${entryCodes.length - targets.length} |`);

  // ---- 기존 재무 표(FY2015 이후) 보유 현황: 읽기만 ----
  const existing = new Map<string, Map<number, { fs_div: string; ni: number | null }>>();
  for (let i = 0; i < targets.length; i += XBRL_BACKFILL_DB_IN_CHUNK / 2) {
    const chunk = targets.slice(i, i + XBRL_BACKFILL_DB_IN_CHUNK / 2).map((t) => t.code);
    const rows = await selectAll<{ stock_code: string; fiscal_year: number; fs_div: string; net_income_parent: number | null }>("stock_annual_fundamentals", (f, t) => supabaseAdmin.from("stock_annual_fundamentals").select("stock_code, fiscal_year, fs_div, net_income_parent").in("stock_code", chunk).gte("fiscal_year", 2015).order("stock_code").order("fiscal_year").range(f, t));
    for (const r of rows) {
      const m = existing.get(r.stock_code) ?? new Map();
      m.set(r.fiscal_year, { fs_div: r.fs_div, ni: r.net_income_parent === null ? null : Number(r.net_income_parent) });
      existing.set(r.stock_code, m);
    }
  }
  const haveExisting = targets.filter((t) => existing.has(t.code)).length;
  console.log(`\n기존 재무 표(stock_annual_fundamentals, FY2015 이후)에 행이 있는 대상 종목 ${haveExisting}개 / 없는 종목 ${targets.length - haveExisting}개 (이번에는 채우지 않음)`);

  // ---- 요청 수 사전 계산 ----
  const planned = targets.length * 4 + targets.length;
  console.log(`\n요청 수 사전 계산(상한): XBRL ${targets.length}×4 = ${targets.length * 4} + list.json ${targets.length} = ${planned}건 (한도 ${XBRL_BACKFILL_MAX_REQUESTS})`);
  if (planned > XBRL_BACKFILL_MAX_REQUESTS) { console.log(`합계가 ${XBRL_BACKFILL_MAX_REQUESTS}건을 넘어 실행하지 않습니다.`); return; }

  const keysOf = (t: Meta): string[] => [...XBRL_BACKFILL_FISCAL_YEARS.map((y) => `${t.corp}|${y}|own`), `${t.corp}|${XBRL_BACKFILL_PRIOR_COL_FISCAL_YEAR}|prior_col`];
  // ---- 이미 저장된 키 ----
  const stored = new Set<string>();
  for (let i = 0; i < targets.length; i += XBRL_BACKFILL_DB_IN_CHUNK / 2) {
    const chunk = targets.slice(i, i + XBRL_BACKFILL_DB_IN_CHUNK / 2).map((t) => t.corp);
    const rows = await selectAll<{ corp_code: string; fiscal_year: number; source: string }>(TABLE + "(스킵 확인)", (f, t) => supabaseAdmin.from(TABLE).select("corp_code, fiscal_year, source").in("corp_code", chunk).order("corp_code").order("fiscal_year").order("source").range(f, t));
    for (const r of rows) stored.add(`${r.corp_code}|${r.fiscal_year}|${r.source}`);
  }
  console.log(`이미 저장된 (corp_code, fiscal_year, source) ${stored.size}건`);
  {
    const complete = targets.filter((t) => keysOf(t).every((k) => stored.has(k))).length;
    const remain = targets.length - complete;
    console.log(`이어받기 전 상태: 5개 키 모두 저장된 종목 ${complete}개 / 남은 종목 ${remain}개 → 남은 요청 수 상한 ≈ ${remain}×5 = ${remain * 5}건 (list ${remain} + XBRL 최대 ${remain * 4}; 소프트 데드라인 ${XBRL_BACKFILL_SOFT_DEADLINE_MINUTES}분)`);
  }

  // ---- 수집 ----
  const buffer: XbrlRow[] = [];
  const stats = { nonDec: 0, nonDecCodes: [] as string[], processed: 0, skippedAll: 0, listFail: 0, xbrlFail: 0, noFilingsAtAll: 0 };
  async function flush(force: boolean): Promise<void> {
    while (buffer.length >= XBRL_BACKFILL_UPSERT_BATCH || (force && buffer.length > 0)) {
      const batch = buffer.splice(0, XBRL_BACKFILL_UPSERT_BATCH);
      const { error } = await supabaseAdmin.from(TABLE).upsert(batch, { onConflict: "corp_code,fiscal_year,source", ignoreDuplicates: true });
      if (error) throw new Error(`${TABLE} upsert 실패: ${error.message}`);
      dbWritten.rows += batch.length;
    }
  }
  const deadline = T0 + XBRL_BACKFILL_SOFT_DEADLINE_MINUTES * 60_000;
  let stopReason: string | null = null;
  let cursor = 0, done = 0;

  async function processStock(t: Meta): Promise<void> {
    const need = new Set(keysOf(t).filter((k) => !stored.has(k)));
    if (need.size === 0) { stats.skippedAll++; return; }
    const filings = await dartList(dartKey!, t.corp);
    if (!filings) { stats.listFail++; return; }
    const reports = filings.filter((f) => /사업보고서/.test(f.report_nm));
    if (reports.length > 0 && !reports.some((f) => periodOf(f.report_nm)?.m === XBRL_BACKFILL_FISCAL_MONTH)) { stats.nonDec++; stats.nonDecCodes.push(t.code); return; }
    if (reports.length === 0) stats.noFilingsAtAll++;
    const now = new Date().toISOString();
    const picks = new Map<number, ReportPick>();
    const xs = new Map<number, XFetch | null>();
    for (const fy of XBRL_BACKFILL_FISCAL_YEARS) picks.set(fy, pickReport(filings, fy, XBRL_BACKFILL_FISCAL_MONTH));
    const fyNeeded = (fy: number): boolean => need.has(`${t.corp}|${fy}|own`) || (fy === 2011 && need.has(`${t.corp}|${XBRL_BACKFILL_PRIOR_COL_FISCAL_YEAR}|prior_col`));
    for (const fy of XBRL_BACKFILL_FISCAL_YEARS) {
      const p = picks.get(fy)!;
      if (!fyNeeded(fy) || !p.filing) continue;
      const x = await fetchXbrl(dartKey!, p.filing.rcept_no);
      if (!x) stats.xbrlFail++;
      xs.set(fy, x);
    }
    const base = { corp_code: t.corp, stock_code: t.code };
    for (const fy of XBRL_BACKFILL_FISCAL_YEARS) {
      if (!need.has(`${t.corp}|${fy}|own`)) continue;
      const p = picks.get(fy)!;
      if (p.filing && !xs.get(fy)) continue; // XBRL 조회 실패(일시적) — 저장하지 않아 재실행 때 다시 시도
      buffer.push(buildRow({ ...base, fiscal_year: fy, source: "own" }, p, xs.get(fy) ?? null, lastDayOfMonth(fy, XBRL_BACKFILL_FISCAL_MONTH), now));
    }
    if (need.has(`${t.corp}|${XBRL_BACKFILL_PRIOR_COL_FISCAL_YEAR}|prior_col`)) {
      const p = picks.get(2011)!;
      if (!(p.filing && !xs.get(2011))) {
        buffer.push(buildRow({ ...base, fiscal_year: XBRL_BACKFILL_PRIOR_COL_FISCAL_YEAR, source: "prior_col" }, p, xs.get(2011) ?? null, lastDayOfMonth(XBRL_BACKFILL_PRIOR_COL_FISCAL_YEAR, XBRL_BACKFILL_FISCAL_MONTH), now));
      }
    }
    stats.processed++;
    await flush(false);
  }
  async function worker(): Promise<void> {
    while (!stopReason) {
      if (limitHit) { stopReason = "DART status 020(요청 한도 초과) 수신"; break; }
      if (Date.now() > deadline) { stopReason = `소프트 데드라인 ${XBRL_BACKFILL_SOFT_DEADLINE_MINUTES}분 도달`; break; }
      const i = cursor++;
      if (i >= targets.length) break;
      await processStock(targets[i]);
      done++;
      if (done % XBRL_BACKFILL_PROGRESS_EVERY === 0) console.log(`진행 ${done}/${targets.length} 종목 | DART 요청 ${dartRequests} | 저장 대기 ${buffer.length}행, 저장 ${dbWritten.rows}행 | 경과 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    }
  }
  await Promise.all(Array.from({ length: XBRL_BACKFILL_CONCURRENCY }, () => worker()));
  await flush(true);
  const elapsedMin = (Date.now() - T0) / 60000;
  console.log(`\n수집 종료: ${stopReason ?? "전체 대상 처리 완료"} | 진행률 ${done}/${targets.length} 종목`);

  await report(targets, existing, stats, { done, stopReason, elapsedMin });
}

interface Stats { nonDec: number; nonDecCodes: string[]; processed: number; skippedAll: number; listFail: number; xbrlFail: number; noFilingsAtAll: number }
async function report(targets: Meta[], existing: Map<string, Map<number, { fs_div: string; ni: number | null }>>, stats: Stats, run: { done: number; stopReason: string | null; elapsedMin: number }): Promise<void> {
  const rows: XbrlRow[] = [];
  for (let i = 0; i < targets.length; i += XBRL_BACKFILL_DB_IN_CHUNK / 2) {
    const chunk = targets.slice(i, i + XBRL_BACKFILL_DB_IN_CHUNK / 2).map((t) => t.corp);
    rows.push(...(await selectAll<XbrlRow>(TABLE + "(결과 집계)", (f, t) => supabaseAdmin.from(TABLE).select("*").in("corp_code", chunk).order("corp_code").order("fiscal_year").order("source").range(f, t))));
  }
  const meta = new Map(targets.map((t) => [t.corp, t]));
  const byCorpEarly = new Map<string, XbrlRow[]>();
  for (const r of rows) byCorpEarly.set(r.corp_code, [...(byCorpEarly.get(r.corp_code) ?? []), r]);
  const key = (r: XbrlRow): string => (r.source === "prior_col" ? `FY${r.fiscal_year}(prior_col)` : `FY${r.fiscal_year}`);
  const groups = ["FY2011", "FY2012", "FY2013", "FY2014", "FY2010(prior_col)"];
  const hasX = (r: XbrlRow): boolean => r.status === "ok" || r.status === "partial" || (r.status === "amended_only" && !/xbrl:014/.test(r.miss_reason ?? ""));
  const all3 = (r: XbrlRow): boolean => r.ni_parent !== null && r.equity_parent !== null && r.eps_basic !== null;

  console.log("\n=== 1. 대상·제외·처리 종목 수 ===");
  console.log(`대상(corp_code 있음) ${targets.length} | 제외(12월 결산 사업보고서 없음, 3월 결산 등) ${stats.nonDec} | 처리(행 생성) ${stats.processed} | 이미 저장돼 건너뜀 ${stats.skippedAll} | list 조회 실패(미저장) ${stats.listFail} | 일부 XBRL 조회 실패(해당 행 미저장) ${stats.xbrlFail}건 | 범위 내 사업보고서 0건(→ no_report 행) ${stats.noFilingsAtAll}`);
  const completeN = targets.filter((t) => (byCorpEarly.get(t.corp)?.length ?? 0) === 5).length;
  console.log(`전체 ${targets.length}종목 중 처리 완료(5개 키 저장) ${completeN} | 제외(12월 결산 아님, 미저장) ${stats.nonDec} | 미완료 ${targets.length - completeN - stats.nonDec}`);
  console.log(`이번 실행 진행: ${run.done}/${targets.length} 종목 시도, 중단 사유: ${run.stopReason ?? "없음(전체 완료)"}`);
  if (stats.nonDecCodes.length) console.log(`제외 종목 코드: ${stats.nonDecCodes.join(",")}`);
  console.log("제외 종목의 최초 진입 연도 구간: " + BUCKETS.map((b) => `${b}=${stats.nonDecCodes.filter((c) => bucketOf(targets.find((t) => t.code === c)!.entryYear) === b).length}`).join(" | "));

  console.log("\n=== 2. status별 행 수 ===");
  const statuses = ["ok", "partial", "xbrl_014", "amended_only", "no_report"];
  console.log(`| 구분 | ${statuses.join(" | ")} | 합계 |`);
  console.log(`|---|${statuses.map(() => "---").join("|")}|---|`);
  for (const g of groups) { const rs = rows.filter((r) => key(r) === g); console.log(`| ${g} | ${statuses.map((s) => rs.filter((r) => r.status === s).length).join(" | ")} | ${rs.length} |`); }
  console.log(`source별: own ${rows.filter((r) => r.source === "own").length} | prior_col ${rows.filter((r) => r.source === "prior_col").length} | 전체 ${rows.length}`);

  console.log("\n=== 3. 3항목(NI·자본·EPS) 모두 있는 행 (분모: 저장된 전체 행 / XBRL 있는 행) ===");
  console.log("| 구분 | 그룹 | 전체 행 | XBRL 있음 | 3개 모두 | 비율(전체) | 비율(XBRL 있음) |");
  console.log("|---|---|---|---|---|---|---|");
  for (const g of groups) {
    for (const [lab, fin] of [["비금융", false], ["금융(이름 기준)", true]] as [string, boolean][]) {
      const rs = rows.filter((r) => key(r) === g && meta.get(r.corp_code)!.fin === fin);
      const x = rs.filter(hasX), a = rs.filter(all3);
      console.log(`| ${g} | ${lab} | ${rs.length} | ${x.length} | ${a.length} | ${pc(a.length, rs.length)} | ${pc(a.length, x.length)} |`);
    }
  }
  console.log("\n최초 진입 연도 구간별(금융·비금융 합산):");
  console.log("| 구분 | 구간 | 전체 행 | XBRL 있음 | 3개 모두 | 비율(전체) | 비율(XBRL 있음) |");
  console.log("|---|---|---|---|---|---|---|");
  for (const g of groups) for (const b of BUCKETS) {
    const rs = rows.filter((r) => key(r) === g && bucketOf(meta.get(r.corp_code)!.entryYear) === b);
    const x = rs.filter(hasX), a = rs.filter(all3);
    console.log(`| ${g} | ${b} | ${rs.length} | ${x.length} | ${a.length} | ${pc(a.length, rs.length)} | ${pc(a.length, x.length)} |`);
  }

  console.log("\n=== 4. 기준(basis)별 건수 (XBRL 있는 행) ===");
  const xr = rows.filter(hasX);
  const cnt = (f: (r: XbrlRow) => string | null, v: string | null): number => xr.filter((r) => f(r) === v).length;
  console.log("| 항목 | 연결(cons) | 차원 없음(nodim) | 별도(sep) | 추출 못함(null) |");
  console.log("|---|---|---|---|---|");
  for (const [lab, f] of [["NI", (r: XbrlRow) => r.ni_basis], ["자본", (r: XbrlRow) => r.equity_basis], ["EPS", (r: XbrlRow) => r.eps_basis]] as [string, (r: XbrlRow) => string | null][]) {
    console.log(`| ${lab} | ${cnt(f, "cons")} | ${cnt(f, "nodim")} | ${cnt(f, "sep")} | ${cnt(f, null)} |`);
  }
  const byCorp = new Map<string, XbrlRow[]>();
  for (const r of rows) byCorp.set(r.corp_code, [...(byCorp.get(r.corp_code) ?? []), r]);
  const fiveEps = [...byCorp.values()].filter((rs) => rs.length === 5 && rs.every((r) => r.eps_basic !== null));
  const consistent = fiveEps.filter((rs) => new Set(rs.map((r) => r.eps_basis)).size === 1);
  console.log(`FY2010~2014 5개 연도 EPS가 모두 있는 종목 ${fiveEps.length}개 중 EPS 기준이 5개 연도 모두 같은 종목 ${consistent.length}개 (연결 ${consistent.filter((rs) => rs[0].eps_basis === "cons").length} / 차원 없음 ${consistent.filter((rs) => rs[0].eps_basis === "nodim").length} / 별도 ${consistent.filter((rs) => rs[0].eps_basis === "sep").length}), 기준이 섞인 종목 ${fiveEps.length - consistent.length}개`);

  console.log("\n=== 5. miss_reason 상위 10 (저장된 문자열 기준) ===");
  const mr = new Map<string, number>();
  for (const r of rows) if (r.miss_reason) mr.set(r.miss_reason, (mr.get(r.miss_reason) ?? 0) + 1);
  console.log("| # | miss_reason | 건수 |\n|---|---|---|");
  [...mr.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10).forEach(([k, v], i) => console.log(`| ${i + 1} | ${k} | ${v} |`));

  const f15 = (rs: XbrlRow[]): { fs_div: string; ni: number | null } | undefined => existing.get(rs[0].stock_code)?.get(2015);
  const seam = (title: string, note: string, has: (r: XbrlRow) => boolean, basisOf: (r: XbrlRow) => string | null): void => {
    console.log(`\n=== ${title} ===`);
    console.log(note);
    console.log("| 구간 | XBRL 5개 연도(FY2010~2014) 모두 있음 | 그중 기준 일관 | FY2015 NI 있음 (일관) | FY2015 NI 있음 (기준 섞임) | FY2015 NI 있음 & 일관 & fs_div 호환 | fs_div 매핑 불가(차원 없음 기준) |");
    console.log("|---|---|---|---|---|---|---|");
    const five = [...byCorp.values()].filter((rs) => rs.length === 5 && rs.every(has));
    for (const b of [...BUCKETS, "전체"]) {
      const cs = five.filter((rs) => b === "전체" || bucketOf(meta.get(rs[0].corp_code)!.entryYear) === b);
      const cons = cs.filter((rs) => new Set(rs.map(basisOf)).size === 1);
      const mix = cs.filter((rs) => new Set(rs.map(basisOf)).size > 1);
      const hasNi = (rs: XbrlRow[]): boolean => f15(rs)?.ni != null;
      const compat = cons.filter((rs) => hasNi(rs) && ((basisOf(rs[0]) === "cons" && f15(rs)!.fs_div === "CFS") || (basisOf(rs[0]) === "sep" && f15(rs)!.fs_div === "OFS")));
      const unmappable = cons.filter((rs) => hasNi(rs) && basisOf(rs[0]) === "nodim");
      console.log(`| ${b} | ${cs.length} | ${cons.length} | ${cons.filter(hasNi).length} | ${mix.filter(hasNi).length} | ${compat.length} | ${unmappable.length} |`);
    }
  };
  seam("6. 기존 재무 표와의 이음새 (EPS 기준, FY2010~FY2015)", "주의: 기존 표 stock_annual_fundamentals에는 EPS 컬럼이 없다. 'FY2015 가능'은 FY2015 행의 net_income_parent가 있는 경우로 센다.", (r) => r.eps_basic !== null, (r) => r.eps_basis);

  console.log("\n=== 7. 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행(upsert 전송, 중복 무시 모드): ${dbWritten.rows}`);
  console.log(`DART 외부 요청(재시도 포함): ${dartRequests}건 | 소요 ${run.elapsedMin.toFixed(1)}분 | 일일 한도: 응답에서 값 확인 불가(status 020 메시지만 존재), ${XBRL_BACKFILL_ASSUMED_DAILY_LIMIT}건/일은 가정`);
  console.log(`status 020 수신: ${limitHit ? "예" : "아니오"}`);

  seam("B-1. 이음새 (순이익 기준, FY2010~FY2015)", "NI = dart_xbrl_fundamentals.ni_parent 5개 연도 모두 있음 + FY2015 stock_annual_fundamentals.net_income_parent 있음. 일관 = ni_basis가 5개 연도 동일.", (r) => r.ni_parent !== null, (r) => r.ni_basis);
  console.log("\n=== B-2. 대상 종목의 stock_annual_fundamentals FY2015~FY2020 행 누락 ===");
  const YRS = [2015, 2016, 2017, 2018, 2019, 2020];
  console.log(`| 구간 | 대상 | ${YRS.map((y) => `FY${y} 없음`).join(" | ")} | 한 연도라도 없음 | 6개 연도 모두 있음 |`);
  console.log(`|---|---|${YRS.map(() => "---").join("|")}|---|---|`);
  for (const b of [...BUCKETS, "전체"]) {
    const ts = targets.filter((t) => b === "전체" || bucketOf(t.entryYear) === b);
    const miss = (t: Meta, y: number): boolean => !existing.get(t.code)?.has(y);
    console.log(`| ${b} | ${ts.length} | ${YRS.map((y) => ts.filter((t) => miss(t, y)).length).join(" | ")} | ${ts.filter((t) => YRS.some((y) => miss(t, y))).length} | ${ts.filter((t) => YRS.every((y) => !miss(t, y))).length} |`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

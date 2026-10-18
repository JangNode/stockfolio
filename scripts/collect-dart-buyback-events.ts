/**
 * [연구용] DART 자기주식 취득 관련 주요사항보고서 이벤트를 시장 단위 list.json(분기 창)으로 모으고, 2015년 이후는 상세 API로 채워
 * dart_buyback_events(새 표)에 저장한다. 키: DART_API_KEY_3 → DART_API_KEY_2(운영 키 사용 안 함, 키 값 출력 금지). DB는 REST만. 1회 실행.
 * 상세 API는 해당 유형(direct/trust) 이벤트가 있는 회사에만 1회씩 요청한다(요청 상한 4,000건 안에 맞추기 위해).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import {
  QUARTERLY_BACKFILL_UNIVERSE_MIN_CAP_EOK, QUARTERLY_BACKFILL_PIT_FROM, QUARTERLY_BACKFILL_CONCURRENCY, QUARTERLY_BACKFILL_MIN_REQUEST_GAP_MS,
  QUARTERLY_BACKFILL_MAX_RETRIES, QUARTERLY_BACKFILL_RETRY_BASE_MS, QUARTERLY_KEY_PRIMARY_ENV, QUARTERLY_KEY_SECONDARY_ENV,
} from "@/lib/dartQuarterlyBackfillConfig";
import {
  BUYBACK_FROM, BUYBACK_TO, BUYBACK_DETAIL_FROM, BUYBACK_DETAIL_TO, BUYBACK_LIST_PAGE_COUNT, BUYBACK_RUN_REQUEST_CAP, BUYBACK_SOFT_DEADLINE_MINUTES,
  BUYBACK_PROGRESS_EVERY_REQUESTS, BUYBACK_DIRECT_MARK, BUYBACK_TRUST_MARK, BUYBACK_DISPOSAL_MARK, BUYBACK_TERMINATE_MARK, BUYBACK_POOL_SIZE,
  BUYBACK_DUP_WINDOW_DAYS, BUYBACK_UPSERT_BATCH,
} from "@/lib/dartBuybackConfig";
import { DartKeyPool } from "./dartKeyPool";

const BASE = "https://opendart.fss.or.kr/api";
const TABLE = "dart_buyback_events";
const MS_DAY = 86_400_000;
const T0 = Date.now();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pct = (a: number, b: number): string => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const isoOfYmd = (d: string): string => { const t = d.replace(/\D/g, ""); return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`; };
const dbRead: Record<string, number> = {};
const dbWritten = { rows: 0 };

let pool: DartKeyPool;
let nextSlot = 0;
async function slot(): Promise<void> { const now = Date.now(); const s = Math.max(now, nextSlot); nextSlot = s + QUARTERLY_BACKFILL_MIN_REQUEST_GAP_MS; if (s > now) await sleep(s - now); }
/** null = 일시 오류·상한·한도로 결과를 얻지 못함. 키 값은 build 안에서만 URL에 들어간다. */
async function dartJson(build: (k: string) => string): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt <= QUARTERLY_BACKFILL_MAX_RETRIES; ) {
    const k = pool.reserve();
    if (!k) return null;
    await slot();
    try {
      const res = await fetch(build(k.value));
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const j = JSON.parse(text) as Record<string, unknown>;
      if (j.status === "020") { if (pool.on020(k.name)) continue; return null; }
      if (j.status === "800") throw new Error("800");
      return j;
    } catch { if (attempt < QUARTERLY_BACKFILL_MAX_RETRIES) await sleep(QUARTERLY_BACKFILL_RETRY_BASE_MS * 2 ** attempt); attempt++; }
  }
  return null;
}

interface Ev {
  rcept_no: string; rcept_dt: string; corp_code: string; stock_code: string | null; corp_name: string | null; report_nm: string; event_type: "direct" | "trust";
  is_amendment: boolean; is_extension: boolean; planned_amount: number | null; planned_shares: number | null; aq_purpose: string | null; aq_method: string | null;
  aq_decision_date: string | null; aq_period_start: string | null; aq_period_end: string | null; detail_source: "api" | "none"; fetched_at: string;
}
const numOf = (s: unknown): number | null => { if (typeof s !== "string") return null; const t = s.replace(/,/g, "").trim(); if (!t || t === "-") return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
const sumNums = (a: number | null, b: number | null): number | null => (a === null && b === null ? null : (a ?? 0) + (b ?? 0));
const dateOf = (s: unknown): string | null => { if (typeof s !== "string") return null; const m = /(\d{4})\D+(\d{1,2})\D+(\d{1,2})/.exec(s); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null; };
const strOf = (s: unknown): string | null => (typeof s === "string" && s.trim() && s.trim() !== "-" ? s.trim() : null);

function quarterWindows(): { bgn: string; end: string }[] {
  const out: { bgn: string; end: string }[] = [];
  const last = BUYBACK_TO;
  for (let y = Number(BUYBACK_FROM.slice(0, 4)); y <= Number(last.slice(0, 4)); y++) {
    for (const [mb, me, de] of [[1, 3, 31], [4, 6, 30], [7, 9, 30], [10, 12, 31]] as const) {
      const bgn = `${y}-${String(mb).padStart(2, "0")}-01`;
      let end = `${y}-${String(me).padStart(2, "0")}-${de}`;
      if (bgn > last) continue;
      if (end > last) end = last;
      out.push({ bgn: bgn.replace(/-/g, ""), end: end.replace(/-/g, "") });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const k3 = process.env[QUARTERLY_KEY_PRIMARY_ENV], k2 = process.env[QUARTERLY_KEY_SECONDARY_ENV];
  if (!k3 || !k2) throw new Error(`환경변수 ${QUARTERLY_KEY_PRIMARY_ENV}, ${QUARTERLY_KEY_SECONDARY_ENV}가 필요합니다.`);
  pool = new DartKeyPool([{ name: QUARTERLY_KEY_PRIMARY_ENV, value: k3 }, { name: QUARTERLY_KEY_SECONDARY_ENV, value: k2 }], BUYBACK_RUN_REQUEST_CAP);
  console.log(`자사주 취득 이벤트 수집 시작: ${new Date().toISOString()} | 키 1순위 ${QUARTERLY_KEY_PRIMARY_ENV}, 2순위 ${QUARTERLY_KEY_SECONDARY_ENV}, 운영 키 미사용 | 요청 상한 ${BUYBACK_RUN_REQUEST_CAP}, 소프트 데드라인 ${BUYBACK_SOFT_DEADLINE_MINUTES}분`);
  const deadline = T0 + BUYBACK_SOFT_DEADLINE_MINUTES * 60_000;

  // ---- corp_code → stock_code ----
  const corpToStock = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from("dart_corp_codes").select("corp_code, stock_code").not("stock_code", "is", null).order("corp_code").range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) if (r.stock_code) corpToStock.set(r.corp_code, r.stock_code);
    dbRead.dart_corp_codes = (dbRead.dart_corp_codes ?? 0) + (data?.length ?? 0);
    if ((data?.length ?? 0) < 1000) break;
  }

  // ---- 1. list.json 분기 창 ----
  const wins = quarterWindows();
  const events = new Map<string, Ev>();
  const excluded = new Map<string, { disposal: number; terminate: number }>();
  const totalByYear = new Map<string, number>();
  let earliestWin: string | null = null, totalB = 0, winDone = 0, winFailed = 0;
  let wi = 0;
  const flushBuf: Ev[] = [];
  async function flush(force: boolean): Promise<void> {
    while (flushBuf.length >= BUYBACK_UPSERT_BATCH || (force && flushBuf.length)) {
      const batch = flushBuf.splice(0, BUYBACK_UPSERT_BATCH);
      const { error } = await supabaseAdmin.from(TABLE).upsert(batch, { onConflict: "rcept_no" });
      if (error) throw new Error(`${TABLE} upsert 실패: ${error.message}`);
      dbWritten.rows += batch.length;
    }
  }
  let stopReason: string | null = null;
  let nextLog = BUYBACK_PROGRESS_EVERY_REQUESTS;
  async function doWindow(w: { bgn: string; end: string }): Promise<void> {
    for (let page = 1, pages = 1; page <= pages; page++) {
      const j = await dartJson((k) => `${BASE}/list.json?crtfc_key=${k}&bgn_de=${w.bgn}&end_de=${w.end}&pblntf_ty=B&page_no=${page}&page_count=${BUYBACK_LIST_PAGE_COUNT}`);
      if (!j) { winFailed++; return; }
      if (j.status === "013") { winDone++; return; }
      if (j.status !== "000") { winFailed++; return; }
      const rows = (j.list as Record<string, string>[] | undefined) ?? [];
      pages = Number(j.total_page ?? 1);
      totalB += rows.length;
      if (rows.length && (earliestWin === null || w.bgn < earliestWin)) earliestWin = w.bgn;
      for (const r of rows) {
        const nm = (r.report_nm ?? "").replace(/\s+/g, "");
        const yr = isoOfYmd(r.rcept_dt ?? w.bgn).slice(0, 4);
        totalByYear.set(yr, (totalByYear.get(yr) ?? 0) + 1);
        const ex = excluded.get(yr) ?? excluded.set(yr, { disposal: 0, terminate: 0 }).get(yr)!;
        if (nm.includes(BUYBACK_DISPOSAL_MARK)) { ex.disposal++; continue; }
        if (nm.includes(BUYBACK_TERMINATE_MARK)) { ex.terminate++; continue; }
        const isTrust = nm.includes(BUYBACK_TRUST_MARK);
        const isDirect = !isTrust && nm.includes(BUYBACK_DIRECT_MARK);
        if (!isTrust && !isDirect) continue;
        const ev: Ev = {
          rcept_no: r.rcept_no, rcept_dt: isoOfYmd(r.rcept_dt), corp_code: r.corp_code, stock_code: corpToStock.get(r.corp_code) ?? null, corp_name: r.corp_name ?? null,
          report_nm: r.report_nm, event_type: isTrust ? "trust" : "direct", is_amendment: /정정/.test(r.report_nm), is_extension: /연장결정/.test(r.report_nm),
          planned_amount: null, planned_shares: null, aq_purpose: null, aq_method: null, aq_decision_date: null, aq_period_start: null, aq_period_end: null, detail_source: "none", fetched_at: new Date().toISOString(),
        };
        if (!events.has(ev.rcept_no)) { events.set(ev.rcept_no, ev); flushBuf.push(ev); }
      }
      await flush(false);
    }
    winDone++;
  }
  async function winWorker(): Promise<void> {
    while (!stopReason) {
      if (pool.stopReason) { stopReason = pool.stopReason; break; }
      if (Date.now() > deadline) { stopReason = `소프트 데드라인 ${BUYBACK_SOFT_DEADLINE_MINUTES}분 도달`; break; }
      const i = wi++;
      if (i >= wins.length) break;
      await doWindow(wins[i]);
      if (pool.total >= nextLog) { nextLog += BUYBACK_PROGRESS_EVERY_REQUESTS; console.log(`창 ${winDone}/${wins.length} | 요청 ${pool.total} | 이벤트 ${events.size} | 경과 ${((Date.now() - T0) / 60000).toFixed(1)}분`); }
    }
  }
  await Promise.all(Array.from({ length: QUARTERLY_BACKFILL_CONCURRENCY }, () => winWorker()));
  await flush(true);
  const stage1Requests = pool.total;
  console.log(`1단계 종료: 창 ${winDone}/${wins.length} (실패 ${winFailed}), 요청 ${stage1Requests}, 전체 B 보고서 ${totalB}, 이벤트 ${events.size}${stopReason ? `, 중단: ${stopReason}` : ""}`);

  // ---- 2. 상세(2015년 이후, 유형별 회사 1회) ----
  const detailKeysSeen = new Map<string, Set<string>>();
  const unmatched = { direct: 0, trust: 0 };
  const matched = { direct: 0, trust: 0 };
  const updated: Ev[] = [];
  if (!stopReason) {
    const corpsOf = (t: "direct" | "trust"): string[] => [...new Set([...events.values()].filter((e) => e.event_type === t && e.rcept_dt.replace(/-/g, "") >= BUYBACK_DETAIL_FROM).map((e) => e.corp_code))].sort();
    const jobs: { t: "direct" | "trust"; corp: string }[] = [...corpsOf("direct").map((corp) => ({ t: "direct" as const, corp })), ...corpsOf("trust").map((corp) => ({ t: "trust" as const, corp }))];
    console.log(`2단계: 상세 요청 대상 회사 direct ${corpsOf("direct").length}개, trust ${corpsOf("trust").length}개 (합 ${jobs.length}건)`);
    let ji = 0;
    const evByCorp = new Map<string, Ev[]>();
    for (const e of events.values()) (evByCorp.get(`${e.event_type}|${e.corp_code}`) ?? evByCorp.set(`${e.event_type}|${e.corp_code}`, []).get(`${e.event_type}|${e.corp_code}`)!).push(e);
    const doJob = async (job: { t: "direct" | "trust"; corp: string }): Promise<void> => {
      const path = job.t === "direct" ? "tsstkAqDecsn.json" : "tsstkAqTrctrCnsDecsn.json";
      const j = await dartJson((k) => `${BASE}/${path}?crtfc_key=${k}&corp_code=${job.corp}&bgn_de=${BUYBACK_DETAIL_FROM}&end_de=${BUYBACK_DETAIL_TO}`);
      const mine = (evByCorp.get(`${job.t}|${job.corp}`) ?? []).filter((e) => e.rcept_dt.replace(/-/g, "") >= BUYBACK_DETAIL_FROM);
      const rows = ((j?.list as Record<string, string>[] | undefined) ?? []);
      const byNo = new Map(rows.map((r) => [r.rcept_no, r]));
      for (const r of rows) { const s = detailKeysSeen.get(job.t) ?? detailKeysSeen.set(job.t, new Set()).get(job.t)!; for (const k of Object.keys(r)) s.add(k); }
      for (const e of mine) {
        const r = byNo.get(e.rcept_no);
        if (!r) { unmatched[job.t]++; continue; }
        matched[job.t]++;
        if (job.t === "direct") {
          e.planned_amount = sumNums(numOf(r.aqpln_prc_ostk), numOf(r.aqpln_prc_estk));
          e.planned_shares = sumNums(numOf(r.aqpln_stk_ostk), numOf(r.aqpln_stk_estk));
          e.aq_purpose = strOf(r.aq_pp); e.aq_method = strOf(r.aq_mth);
          e.aq_decision_date = dateOf(r.aq_dd); e.aq_period_start = dateOf(r.aqexpd_bgd); e.aq_period_end = dateOf(r.aqexpd_edd);
        } else {
          e.planned_amount = numOf(r.ctr_prc);
          e.aq_purpose = strOf(r.ctr_pp);
          e.aq_decision_date = dateOf(r.bddd ?? r.aq_dd); e.aq_period_start = dateOf(r.ctr_pd_bgd); e.aq_period_end = dateOf(r.ctr_pd_edd);
        }
        e.detail_source = "api"; e.fetched_at = new Date().toISOString();
        updated.push(e);
      }
    };
    await Promise.all(Array.from({ length: QUARTERLY_BACKFILL_CONCURRENCY }, async () => {
      while (!stopReason) {
        if (pool.stopReason) { stopReason = pool.stopReason; break; }
        if (Date.now() > deadline) { stopReason = `소프트 데드라인 ${BUYBACK_SOFT_DEADLINE_MINUTES}분 도달`; break; }
        const i = ji++;
        if (i >= jobs.length) break;
        await doJob(jobs[i]);
        if (pool.total >= nextLog) { nextLog += BUYBACK_PROGRESS_EVERY_REQUESTS; console.log(`상세 ${Math.min(ji, jobs.length)}/${jobs.length} | 요청 ${pool.total} | 경과 ${((Date.now() - T0) / 60000).toFixed(1)}분`); }
      }
    }));
    flushBuf.push(...updated);
    await flush(true);
  }
  console.log(`수집 종료: ${stopReason ?? "전부 처리"} | 요청 ${pool.total}`);

  // ---- PIT 유니버스(1,094) / 풀 판정용 가격 자료 ----
  const series: Map<string, StockDailyPriceRow[]> = await loadAllStockSeriesFromParquet(2010, 2026);
  const dates = new Set<string>();
  for (const rows of series.values()) for (const r of rows) if (r.tradeDate >= QUARTERLY_BACKFILL_PIT_FROM) dates.add(r.tradeDate);
  const cal = [...dates].sort();
  const monthEnds = new Set<string>();
  for (let k = 0; k + 1 < cal.length; k++) if (cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7)) monthEnds.add(cal[k]);
  interface Sk { code: string; idx: Map<string, number>; mcap: Float64Array; avgTv: Float64Array }
  const sks = new Map<string, Sk>();
  const entered = new Set<string>();
  for (const [code, rows] of series) {
    const tv = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
    sks.set(code, { code, idx: new Map(rows.map((r, i) => [r.tradeDate, i])), mcap: Float64Array.from(rows.map((r) => r.marketCapEok)), avgTv: tv });
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].tradeDate < QUARTERLY_BACKFILL_PIT_FROM || !monthEnds.has(rows[i].tradeDate)) continue;
      if (rows[i - 1].marketCapEok >= QUARTERLY_BACKFILL_UNIVERSE_MIN_CAP_EOK && tv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON) { entered.add(code); break; }
    }
    series.delete(code);
  }
  const corpOfStock = new Map<string, string>();
  for (const [c, s] of corpToStock) if (!corpOfStock.has(s)) corpOfStock.set(s, c);
  const targetCorps = new Set([...entered].map((c) => corpOfStock.get(c)).filter((x): x is string => !!x));
  const poolCache = new Map<string, Set<string>>();
  const poolAt = (d: string): Set<string> => {
    let hit = poolCache.get(d);
    if (hit) return hit;
    const el: { code: string; m: number }[] = [];
    for (const sk of sks.values()) { const i = sk.idx.get(d); if (i === undefined || i < 1 || !(sk.mcap[i - 1] >= QUARTERLY_BACKFILL_UNIVERSE_MIN_CAP_EOK) || !(sk.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON)) continue; el.push({ code: sk.code, m: sk.mcap[i] }); }
    el.sort((a, b) => b.m - a.m || (a.code < b.code ? -1 : 1));
    hit = new Set(el.slice(0, BUYBACK_POOL_SIZE).map((x) => x.code));
    poolCache.set(d, hit);
    return hit;
  };
  const lastTradeOnOrBefore = (d: string): string | null => { let lo = 0, hi = cal.length - 1, f = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (cal[m] <= d) { f = m; lo = m + 1; } else hi = m - 1; } return f >= 0 ? cal[f] : null; };

  // ---- 보고 ----
  const evs = [...events.values()].sort((a, b) => (a.rcept_dt === b.rcept_dt ? (a.rcept_no < b.rcept_no ? -1 : 1) : a.rcept_dt < b.rcept_dt ? -1 : 1));
  const years = [...new Set([...totalByYear.keys()])].sort();
  const flag = (e: Ev): "원본" | "정정" | "연장" => (e.is_extension ? "연장" : e.is_amendment ? "정정" : "원본");
  console.log("\n=== 1. list.json·요청 ===");
  console.log("| 항목 | 값 |\n|---|---|");
  console.log(`| 분기 창 수 / 처리 / 실패 | ${wins.length} / ${winDone} / ${winFailed} |`);
  console.log(`| 1단계(list.json) 요청 수 | ${stage1Requests} |`);
  console.log(`| 전체 요청 수(키별) | ${pool.total} (${[...pool.used].map(([n, v]) => `${n} ${v}`).join(", ")}) / 상한 ${BUYBACK_RUN_REQUEST_CAP} |`);
  console.log(`| status 020 수신 / 키 전환 | ${[...pool.got020].map(([n, v]) => `${n} ${v}`).join(", ")} / ${pool.switchedAt ? `발생 ${pool.switchedAt}` : "발생 안 함"} |`);
  console.log(`| 가장 이른 결과가 나온 창 | ${earliestWin ? `${isoOfYmd(earliestWin)} 시작 창` : "없음"} (첫 창 ${wins[0].bgn}~${wins[0].end}) |`);
  console.log(`| 전체 B 보고서 수(받은 행) | ${totalB} |`);
  console.log(`| 보관 이벤트(direct+trust) | ${events.size} |`);
  console.log(`| 중단 사유 | ${stopReason ?? "전부 처리"} |`);

  console.log("\n=== 2. 연도별 이벤트 수 ===");
  console.log("| 연도 | B 전체 | direct 원본 | direct 정정 | direct 연장 | trust 원본 | trust 정정 | trust 연장 | 처분(제외) | 해지(제외) |\n|---|---|---|---|---|---|---|---|---|---|");
  for (const y of years) {
    const ys = evs.filter((e) => e.rcept_dt.startsWith(y));
    const c = (t: string, f: string): number => ys.filter((e) => e.event_type === t && flag(e) === f).length;
    console.log(`| ${y} | ${totalByYear.get(y) ?? 0} | ${c("direct", "원본")} | ${c("direct", "정정")} | ${c("direct", "연장")} | ${c("trust", "원본")} | ${c("trust", "정정")} | ${c("trust", "연장")} | ${excluded.get(y)?.disposal ?? 0} | ${excluded.get(y)?.terminate ?? 0} |`);
  }

  console.log("\n=== 3. 연도별 PIT 유니버스(1,094종목)·POOL(그날 시총 상위 100) 해당 이벤트 수 ===");
  console.log(`(PIT 유니버스 corp_code ${targetCorps.size}개 기준. 풀 판정일 = rcept_dt 이전 마지막 거래일)`);
  console.log("| 연도 | 이벤트 전체 | PIT 유니버스 해당 | POOL 해당 | 원본만: 전체 | 원본만: PIT | 원본만: POOL |\n|---|---|---|---|---|---|---|");
  const inPool = (e: Ev): boolean => { if (!e.stock_code) return false; const d = lastTradeOnOrBefore(e.rcept_dt); return d ? poolAt(d).has(e.stock_code) : false; };
  const poolFlags = new Map<string, boolean>();
  for (const e of evs) if (targetCorps.has(e.corp_code)) poolFlags.set(e.rcept_no, inPool(e));
  for (const y of years) {
    const ys = evs.filter((e) => e.rcept_dt.startsWith(y));
    const pit = ys.filter((e) => targetCorps.has(e.corp_code));
    const po = pit.filter((e) => poolFlags.get(e.rcept_no));
    const ori = ys.filter((e) => flag(e) === "원본"), oriPit = ori.filter((e) => targetCorps.has(e.corp_code));
    console.log(`| ${y} | ${ys.length} | ${pit.length} | ${po.length} | ${ori.length} | ${oriPit.length} | ${oriPit.filter((e) => poolFlags.get(e.rcept_no)).length} |`);
  }

  console.log("\n=== 4. 상세 매칭 (2015년 이후 원본 이벤트) ===");
  console.log(`상세 API 매칭: direct ${matched.direct} / 미매칭 ${unmatched.direct}, trust ${matched.trust} / 미매칭 ${unmatched.trust} (정정·연장 포함 2015년 이후 전체 기준)`);
  console.log("| 연도 | 유형 | 원본 이벤트 | 상세 있음 | 비율 | 목적에 '소각' 포함 | 상세 있음 중 비율 |\n|---|---|---|---|---|---|---|");
  for (const y of years.filter((x) => x >= "2015")) for (const t of ["direct", "trust"]) {
    const ys = evs.filter((e) => e.rcept_dt.startsWith(y) && e.event_type === t && flag(e) === "원본");
    if (!ys.length) continue;
    const det = ys.filter((e) => e.detail_source === "api");
    const sog = det.filter((e) => (e.aq_purpose ?? "").includes("소각"));
    console.log(`| ${y} | ${t} | ${ys.length} | ${det.length} | ${pct(det.length, ys.length)} | ${sog.length} | ${pct(sog.length, det.length)} |`);
  }
  for (const t of ["direct", "trust"]) console.log(`상세 응답에서 본 필드명(${t}): ${[...(detailKeysSeen.get(t) ?? [])].join(", ") || "(응답 행 없음)"}`);
  const amt = evs.filter((e) => e.detail_source === "api" && e.planned_amount !== null);
  console.log(`상세 있음 이벤트 중 planned_amount 값이 있는 수: ${amt.length} / ${evs.filter((e) => e.detail_source === "api").length}`);

  console.log("\n=== 5. 같은 회사 30일 안 중복 공시 ===");
  const dupCount = (list: Ev[]): { n: number; withPrev: number; corps: number } => {
    const by = new Map<string, Ev[]>();
    for (const e of list) (by.get(e.corp_code) ?? by.set(e.corp_code, []).get(e.corp_code)!).push(e);
    let withPrev = 0, corps = 0;
    for (const l of by.values()) {
      l.sort((a, b) => (a.rcept_dt < b.rcept_dt ? -1 : a.rcept_dt > b.rcept_dt ? 1 : 0));
      let any = false;
      for (let i = 1; i < l.length; i++) if ((Date.parse(l[i].rcept_dt) - Date.parse(l[i - 1].rcept_dt)) / MS_DAY <= BUYBACK_DUP_WINDOW_DAYS) { withPrev++; any = true; }
      if (any) corps++;
    }
    return { n: list.length, withPrev, corps };
  };
  console.log("| 대상 | 이벤트 수 | 직전 공시(같은 회사)가 30일 이내인 이벤트 수 | 해당 회사 수 |\n|---|---|---|---|");
  for (const [lab, list] of [["전체(direct+trust, 정정·연장 포함)", evs], ["원본만 (direct+trust)", evs.filter((e) => flag(e) === "원본")], ["direct 원본만", evs.filter((e) => flag(e) === "원본" && e.event_type === "direct")], ["trust 원본만", evs.filter((e) => flag(e) === "원본" && e.event_type === "trust")], ["PIT 유니버스 해당 direct 원본만", evs.filter((e) => flag(e) === "원본" && e.event_type === "direct" && targetCorps.has(e.corp_code))]] as [string, Ev[]][]) {
    const d = dupCount(list);
    console.log(`| ${lab} | ${d.n} | ${d.withPrev} | ${d.corps} |`);
  }

  const { count } = await supabaseAdmin.from(TABLE).select("rcept_no", { count: "exact", head: true });
  console.log("\n=== 6. 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 표 행 수 확인(count 조회) ${count ?? "-"}`);
  console.log(`Supabase 쓴 행: ${dbWritten.rows} (1단계 신규 + 2단계 갱신 upsert 합) | DART 요청 수: ${pool.total} | KIS 요청: 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

/**
 * [임시 점검 — 시도 아님, 판정 없음, 병합 금지, 읽기 전용, 외부 요청 0건] 재무 조회 정렬 수정 검증 + 수집 대상 편향 점검 + 정렬 수정 후 M3 계열 1회 재계산.
 * M3 정의·비용·리밸런싱은 research/smallcap-lowvol-prereg.md(3a41f17d)와 같다. 숫자와 표만 출력한다.
 */
import { createHash } from "node:crypto";
import { pickFundamentalsAsOf, type FundamentalsSeries, type StockFundamentalsAsOf } from "@/lib/pointInTimeFundamentals";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { applyAdjustmentsInPlace } from "@/lib/priceAdjustment";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS } from "@/lib/strategyBacktestSummaryConfig";
import { computeCumulativeAndMdd, computeCagrPct } from "@/lib/strategyBacktestSummary";
import { computeIndexDailyReturnsPct } from "@/lib/benchmarkSummary";
import { getSecuritiesTaxRate } from "@/lib/transactionCost";
import { FEE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";
import { ETF_SPIKE_MIN_ABS_RET, ETF_SPIKE_MAX_NET_ABS, ETF_SPIKE_KOSPI_EXEMPT_RATIO, ETF_TRADING_DAYS_PER_YEAR, ETF_FEE_RATE, ETF_SLIPPAGE_RATE } from "@/lib/etfAllocationConfig";
import { DIAG_COMBO_WEIGHTS } from "@/lib/smallcapM3DiagnoseConfig";
import { SEASON_STOCK_CODE } from "@/lib/seasonalityConfig";
import { PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { SCAN_CAP_EOK, SCAN_SMALL_MIN_MCAP_EOK, SCAN_SMALL_MIN_AVG_TV_WON, SCAN_SMALL_MIN_PRICE_WON, SCAN_SMALL_SLIPPAGE, SCAN_QUARTER_FRESH_DAYS, SCAN_DB_CHUNK } from "@/lib/signalScanConfig";
import { FLOW_TILT_ENDED_GRACE_DAYS } from "@/lib/foreignFlowTiltConfig";
import {
  LV_VOL_DAYS, LV_R1_VOL_DAYS, LV_MIN_PRICE_DAY_RATIO, LV_M2_COUNT, LV_M3_MIN_COUNT, LV_QUARTER_MONTHS, LV_FIRST_SIGNAL_MONTH, LV_LEARN, LV_CONFIRM, LV_HOLDOUT_FROM,
  LV_G1_CAGR_MARGIN_PP, LV_G3_MDD_MARGIN_PP, LV_G4_MAX_DELAY_DROP_PP, LV_R_CAGR_MARGIN_PP, LV_R3_DRAWS, LV_R3_SEED, LV_R3_TOP_FRACTION, LV_QUARTERS_PER_YEAR,
} from "@/lib/smallcapLowvolConfig";

const T0 = Date.now();
const MS_DAY = 86_400_000;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const ox = (b: boolean): string => (b ? "O" : "X");
const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;
const dbRead: Record<string, number> = {};
async function selectAll<T>(label: string, build: (f: number, t: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
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
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

interface S {
  fund: FundamentalsSeries;
  code: string; idx: Map<string, number>; close: Float64Array; closeA: Float64Array; mcapRow: Float64Array; avgTvRow: Float64Array; rawRow: Float64Array; last: string;
  qrecs: { rcept: string; order: number; op: number | null; prev: number | null }[];
}
interface Target { w: Map<string, number>; tv: number[]; fallback: boolean; n: number; lag: number[]; sel: S[] }
interface Out { dates: string[]; ret: number[]; costFrac: number[]; turn: { d: string; v: number }[]; nPos: number[]; liq: string[] }
interface Win { from: string; to: string }
const mean = (v: number[]): number => (v.length ? v.reduce((a, x) => a + x, 0) / v.length : NaN);
const groupOf = (i: number, n: number, parts: number): number => Math.floor((i * parts) / n);

async function main(): Promise<void> {
  console.log(`조회 정렬 수정 검증·편향 점검·재계산 시작(읽기 전용, 시도 아님): ${new Date().toISOString()}`);
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear());
  const today = new Date().toISOString().slice(0, 10);
  const kospi = await getIndexPriceSeries("KOSPI", "2009-01-01", today);
  const kosdaq = await getIndexPriceSeries("KOSDAQ", "2009-01-01", today);
  dbRead["beta_price_history(KOSPI)"] = kospi.length; dbRead["beta_price_history(KOSDAQ)"] = kosdaq.length;

  interface Row0 { code: string; dates: string[]; close: Float64Array; raw: Float64Array; mcap: Float64Array; avgTv: Float64Array }
  const rows0: Row0[] = [];
  const calSet = new Set<string>();
  for (const [code, rows] of series) {
    series.delete(code);
    if (!rows.length) continue;
    const adj = rows.map((r) => ({ ...r }));
    const al = adjustments.get(code);
    if (al) applyAdjustmentsInPlace(adj, al);
    for (const r of rows) if (r.tradeDate >= "2010-01-01") calSet.add(r.tradeDate);
    rows0.push({ code, dates: rows.map((r) => r.tradeDate), close: Float64Array.from(adj.map((r) => r.closePrice)), raw: Float64Array.from(rows.map((r) => r.closePrice)), mcap: Float64Array.from(rows.map((r) => r.marketCapEok)), avgTv: computeTrailingAvgTradingValue(adj, PIT_LIQUIDITY_LOOKBACK_DAYS) });
  }
  const firstElig = new Map<string, string>();
  for (const r of rows0) for (let i = 1; i < r.dates.length; i++) if (r.dates[i] >= "2010-01-01" && r.mcap[i - 1] >= SCAN_CAP_EOK && r.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON) { firstElig.set(r.code, r.dates[i]); break; }
  const CAL = [...calSet].sort();
  const nCal = CAL.length, lastIdx = nCal - 1, dataEnd = CAL[lastIdx];
  const calIdx = new Map(CAL.map((d, i) => [d, i]));
  const monthEnds: string[] = [];
  for (let k = 0; k + 1 < nCal; k++) if (CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) monthEnds.push(CAL[k]);
  const endedBefore = new Date(Date.parse(dataEnd) - FLOW_TILT_ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  const firstSignal = monthEnds.find((d) => d.slice(0, 7) === LV_FIRST_SIGNAL_MONTH)!;
  const quarterSignals = monthEnds.filter((d) => d >= firstSignal && (LV_QUARTER_MONTHS as readonly number[]).includes(Number(d.slice(5, 7))));
  const monthlySignals = monthEnds.filter((d) => d >= firstSignal);
  const firstExec = CAL[calIdx.get(firstSignal)! + 1];
  console.log(`종목 ${rows0.length}개, 거래일(2010~) ${nCal}일 ${CAL[0]}~${dataEnd}, 분기 신호 ${quarterSignals.length}개(첫 신호 ${firstSignal}, 첫 체결 ${firstExec}), 월간 신호 ${monthlySignals.length}개`);

  // ---- SMALL 이력이 있는 종목(월말 기준) ----
  const isSmall = (r: { mcap: Float64Array; avgTv: Float64Array; raw: Float64Array }, i: number): boolean => i >= 1 && r.mcap[i - 1] >= SCAN_SMALL_MIN_MCAP_EOK && r.mcap[i - 1] < SCAN_CAP_EOK && r.avgTv[i] >= SCAN_SMALL_MIN_AVG_TV_WON && r.raw[i] >= SCAN_SMALL_MIN_PRICE_WON;
  const meSet = new Set(monthlySignals);
  const cand = rows0.filter((r) => { for (let i = 1; i < r.dates.length; i++) if (meSet.has(r.dates[i]) && isSmall(r, i)) return true; return false; });
  console.log(`월말 SMALL 구성원이 된 적 있는 종목 ${cand.length}개`);

  // ---- 재무 조회: 정렬 수정 검증(같은 조회 2회, 정렬 없는 옛 방식 2회) + 정렬 수정본으로 로드 ----
  type Rec = Record<string, unknown>;
  type Res = PromiseLike<{ data: Rec[] | null; error: { message: string } | null }>;
  const codes = cand.map((r) => r.code);
  const chunks: string[][] = [];
  for (let i = 0; i < codes.length; i += SCAN_DB_CHUNK) chunks.push(codes.slice(i, i + SCAN_DB_CHUNK));
  async function readChunks(label: string, mk: (chunk: string[], f: number, t: number) => Res): Promise<{ rows: Rec[]; over: number }> {
    const rows: Rec[] = [];
    let over = 0;
    for (const chunk of chunks) {
      let n = 0;
      for (let from = 0; ; from += 1000) {
        const { data, error } = await mk(chunk, from, from + 999);
        if (error) throw new Error(`${label}: ${error.message}`);
        rows.push(...(data ?? [])); n += data?.length ?? 0;
        if ((data?.length ?? 0) < 1000) break;
      }
      if (n > 1000) over++;
    }
    return { rows, over };
  }
  const hashOf = (rows: Rec[]): string => createHash("sha256").update(rows.map((r) => JSON.stringify(r)).sort().join("\n")).digest("hex").slice(0, 12);
  const q = (t: string): ReturnType<typeof supabaseAdmin.from> => supabaseAdmin.from(t);
  const specs: { name: string; fixed: (c: string[], f: number, t: number) => Res; old: (c: string[], f: number, t: number) => Res }[] = [
    { name: "dart_quarterly_fundamentals(ok)",
      fixed: (c, f, t) => q("dart_quarterly_fundamentals").select("corp_code, stock_code, fiscal_year, quarter, rcept_date, op_income_q, op_income_prev_q, off_cycle").eq("status", "ok").in("stock_code", c).order("corp_code").order("fiscal_year").order("quarter").range(f, t) as unknown as Res,
      old: (c, f, t) => q("dart_quarterly_fundamentals").select("corp_code, stock_code, fiscal_year, quarter, rcept_date, op_income_q, op_income_prev_q, off_cycle").eq("status", "ok").in("stock_code", c).range(f, t) as unknown as Res },
    { name: "stock_annual_fundamentals",
      fixed: (c, f, t) => q("stock_annual_fundamentals").select("stock_code, fiscal_year, rcept_no, rcept_date, net_income_parent, equity_parent, fs_div").in("stock_code", c).order("stock_code").order("fiscal_year").range(f, t) as unknown as Res,
      old: (c, f, t) => q("stock_annual_fundamentals").select("stock_code, fiscal_year, rcept_no, rcept_date, net_income_parent, equity_parent, fs_div").in("stock_code", c).range(f, t) as unknown as Res },
    { name: "stock_annual_fundamentals_fill(ok)",
      fixed: (c, f, t) => q("stock_annual_fundamentals_fill").select("stock_code, fiscal_year, rcept_no, rcept_date, net_income_parent, equity_parent, fs_div").eq("status", "ok").in("stock_code", c).order("stock_code").order("fiscal_year").range(f, t) as unknown as Res,
      old: (c, f, t) => q("stock_annual_fundamentals_fill").select("stock_code, fiscal_year, rcept_no, rcept_date, net_income_parent, equity_parent, fs_div").eq("status", "ok").in("stock_code", c).range(f, t) as unknown as Res },
    { name: "dart_xbrl_fundamentals",
      fixed: (c, f, t) => q("dart_xbrl_fundamentals").select("corp_code, stock_code, fiscal_year, source, rcept_no, rcept_dt, ni_parent, equity_parent, ni_basis").in("stock_code", c).order("corp_code").order("fiscal_year").order("source").range(f, t) as unknown as Res,
      old: (c, f, t) => q("dart_xbrl_fundamentals").select("corp_code, stock_code, fiscal_year, source, rcept_no, rcept_dt, ni_parent, equity_parent, ni_basis").in("stock_code", c).range(f, t) as unknown as Res },
    { name: "stock_dividend_history",
      fixed: (c, f, t) => q("stock_dividend_history").select("stock_code, record_date, cash_dividend_per_share, pay_date").in("stock_code", c).not("pay_date", "is", null).order("stock_code").order("record_date").range(f, t) as unknown as Res,
      old: (c, f, t) => q("stock_dividend_history").select("stock_code, record_date, cash_dividend_per_share, pay_date").in("stock_code", c).not("pay_date", "is", null).order("pay_date", { ascending: true }).range(f, t) as unknown as Res },
  ];
  console.log(`\n=== 1. 조회 정렬 검증 (대상 종목 ${codes.length}개, ${chunks.length}개 묶음) ===\n| 표 | 정렬 수정본 1회째 행·해시 | 2회째 행·해시 | 같음 | 정렬 없는 옛 방식 1회째 행·해시 | 2회째 행·해시 | 같음 | 옛 방식 = 수정본 | 1,000행 초과 묶음 |\n|---|---|---|---|---|---|---|---|---|`);
  const loaded = new Map<string, Rec[]>();
  for (const sp of specs) {
    const f1 = await readChunks(sp.name, sp.fixed), f2 = await readChunks(sp.name, sp.fixed), o1 = await readChunks(sp.name, sp.old), o2 = await readChunks(sp.name, sp.old);
    const h = [hashOf(f1.rows), hashOf(f2.rows), hashOf(o1.rows), hashOf(o2.rows)];
    loaded.set(sp.name, f1.rows);
    dbRead[sp.name] = f1.rows.length;
    dbRead[`${sp.name}(검증 추가 읽기)`] = f2.rows.length + o1.rows.length + o2.rows.length;
    console.log(`| ${sp.name} | ${f1.rows.length} ${h[0]} | ${f2.rows.length} ${h[1]} | ${ox(h[0] === h[1])} | ${o1.rows.length} ${h[2]} | ${o2.rows.length} ${h[3]} | ${ox(h[2] === h[3])} | ${ox(h[0] === h[2])} | ${f1.over}/${chunks.length} |`);
  }
  const qBy = new Map<string, S["qrecs"]>();
  const QEND: Record<number, string> = { 1: "03-31", 2: "06-30", 3: "09-30" };
  for (const r of loaded.get("dart_quarterly_fundamentals(ok)")! as { stock_code: string; fiscal_year: number; quarter: number; rcept_date: string | null; op_income_q: number | null; op_income_prev_q: number | null; off_cycle: boolean }[]) {
    if (r.off_cycle || !r.rcept_date || r.quarter < 1 || r.quarter > 3 || r.rcept_date < `${r.fiscal_year}-${QEND[r.quarter]}`) continue;
    const a = qBy.get(r.stock_code) ?? [];
    a.push({ rcept: r.rcept_date, order: r.fiscal_year * 10 + r.quarter, op: r.op_income_q === null ? null : Number(r.op_income_q), prev: r.op_income_prev_q === null ? null : Number(r.op_income_prev_q) });
    qBy.set(r.stock_code, a);
  }
  // 연간 3표 합집합(stock > fill > xbrl)
  interface FRow { fy: number; rceptNo: string; rcept: string; ni: number | null; eq: number | null; fsDiv: "CFS" | "OFS" }
  const annBy = new Map<string, Map<number, FRow>>();
  const prio = new Map<string, number>();
  const put = (code: string, r: FRow, p: number): void => {
    const m = annBy.get(code) ?? new Map<number, FRow>(); annBy.set(code, m);
    const k = `${code}|${r.fy}`;
    if ((prio.get(k) ?? -1) < p) { m.set(r.fy, r); prio.set(k, p); }
  };
  const n0 = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  for (const r of loaded.get("stock_annual_fundamentals")! as { stock_code: string; fiscal_year: number; rcept_no: string; rcept_date: string; net_income_parent: number | null; equity_parent: number | null; fs_div: string }[]) put(r.stock_code, { fy: r.fiscal_year, rceptNo: r.rcept_no, rcept: r.rcept_date, ni: n0(r.net_income_parent), eq: n0(r.equity_parent), fsDiv: r.fs_div as "CFS" | "OFS" }, 3);
  for (const r of loaded.get("stock_annual_fundamentals_fill(ok)")! as { stock_code: string; fiscal_year: number; rcept_no: string | null; rcept_date: string | null; net_income_parent: number | null; equity_parent: number | null; fs_div: string | null }[]) { if (r.rcept_date && r.rcept_no) put(r.stock_code, { fy: r.fiscal_year, rceptNo: r.rcept_no, rcept: r.rcept_date, ni: n0(r.net_income_parent), eq: n0(r.equity_parent), fsDiv: (r.fs_div ?? "CFS") as "CFS" | "OFS" }, 2); }
  for (const r of loaded.get("dart_xbrl_fundamentals")! as { stock_code: string; fiscal_year: number; rcept_no: string | null; rcept_dt: string | null; ni_parent: number | null; equity_parent: number | null; ni_basis: string | null }[]) { if (r.rcept_dt && r.rcept_no) put(r.stock_code, { fy: r.fiscal_year, rceptNo: r.rcept_no, rcept: r.rcept_dt, ni: n0(r.ni_parent), eq: n0(r.equity_parent), fsDiv: r.ni_basis === "sep" ? "OFS" : "CFS" }, 1); }
  const fundOf = (code: string): FundamentalsSeries => {
    const rows = [...(annBy.get(code)?.values() ?? [])].sort((a, b) => (a.rcept === b.rcept ? a.fy - b.fy : a.rcept < b.rcept ? -1 : 1));
    const annual: StockFundamentalsAsOf[] = rows.map((x) => ({ fiscalYear: x.fy, rceptNo: x.rceptNo, rceptDate: x.rcept, netIncomeParent: x.ni, equityParent: x.eq, fsDiv: x.fsDiv }));
    return { annual, dividends: [] };
  };
  const stocks: S[] = cand.map((r) => {
    const idx = new Map(r.dates.map((d, i) => [d, i]));
    const closeA = new Float64Array(nCal).fill(NaN);
    for (let c = 0; c < nCal; c++) { const i = idx.get(CAL[c]); if (i !== undefined && r.close[i] > 0) closeA[c] = r.close[i]; }
    const q = (qBy.get(r.code) ?? []).sort((a, b) => (a.rcept === b.rcept ? a.order - b.order : a.rcept < b.rcept ? -1 : 1));
    return { fund: fundOf(r.code), code: r.code, idx, close: r.close, closeA, mcapRow: r.mcap, avgTvRow: r.avgTv, rawRow: r.raw, last: r.dates[r.dates.length - 1], qrecs: q };
  });
  stocks.sort((a, b) => (a.code < b.code ? -1 : 1));
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  rows0.length = 0;

  // ---- 유니버스·신호 ----
  const smallCache = new Map<string, S[]>();
  const smallAt = (d: string): S[] => {
    let v = smallCache.get(d);
    if (!v) {
      v = [];
      for (const s of stocks) { const i = s.idx.get(d); if (i !== undefined && isSmall({ mcap: s.mcapRow, avgTv: s.avgTvRow, raw: s.rawRow }, i)) v.push(s); }
      smallCache.set(d, v);
    }
    return v;
  };
  function volAt(s: S, c: number, N: number): number {
    if (c - N + 1 < 0) return NaN;
    const cl = s.closeA;
    let days = 0, n = 0, sum = 0, sum2 = 0;
    for (let j = c - N + 1; j <= c; j++) {
      if (cl[j] > 0) { days++; if (j > c - N + 1 && cl[j - 1] > 0) { const r = cl[j] / cl[j - 1] - 1; n++; sum += r; sum2 += r * r; } }
    }
    if (days < Math.ceil(N * LV_MIN_PRICE_DAY_RATIO) || n < 2) return NaN;
    const m = sum / n;
    return Math.sqrt(Math.max((sum2 - n * m * m) / (n - 1), 0));
  }
  function sopInfo(s: S, d: string): { v: number; lag: number } | null {
    let rec: S["qrecs"][number] | null = null;
    for (const r of s.qrecs) { if (r.rcept <= d) rec = r; else break; }
    if (rec && dayDiff(rec.rcept, d) <= SCAN_QUARTER_FRESH_DAYS && rec.op !== null && rec.prev !== null && rec.prev !== 0) return { v: (rec.op - rec.prev) / Math.abs(rec.prev), lag: dayDiff(rec.rcept, d) };
    return null;
  }
  const sopAt = (s: S, d: string): number => sopInfo(s, d)?.v ?? NaN;
  const planCache = new Map<string, { members: S[]; items: { s: S; vol: number }[] }>();
  function planAt(d: string, N: number): { members: S[]; items: { s: S; vol: number }[] } {
    const key = `${d}|${N}`;
    let p = planCache.get(key);
    if (!p) {
      const c = calIdx.get(d)!, members = smallAt(d);
      const items = members.map((s) => ({ s, vol: volAt(s, c, N) })).filter((x) => Number.isFinite(x.vol)).sort((a, b) => a.vol - b.vol || (a.s.code < b.s.code ? -1 : 1));
      p = { members, items };
      planCache.set(key, p);
    }
    return p;
  }
  const mkTarget = (sel: S[], d: string, fallback: boolean): Target => {
    const w = new Map<string, number>(), tv: number[] = [], lag: number[] = [];
    for (const s of sel) { w.set(s.code, 1 / sel.length); tv.push(s.avgTvRow[s.idx.get(d)!]); const si = sopInfo(s, d); if (si) lag.push(si.lag); }
    return { w, tv, fallback, n: sel.length, lag, sel };
  };
  type DKind = "SEW_SOP" | "VOLH" | "VOLH_SOPA" | "SOPT" | "M3" | "SEW";
  function targetFor(kind: DKind, d: string, N: number): Target {
    const { members, items } = planAt(d, N);
    if (kind === "SEW") return mkTarget(members, d, false);
    const n = items.length;
    const withSopAll = members.map((s) => ({ s, sop: sopAt(s, d) })).filter((x) => Number.isFinite(x.sop));
    if (kind === "SEW_SOP") return mkTarget(withSopAll.map((x) => x.s), d, false);
    if (kind === "SOPT") {
      const sorted = [...withSopAll].sort((a, b) => b.sop - a.sop || (a.s.code < b.s.code ? -1 : 1)), m = sorted.length;
      return mkTarget(sorted.filter((_, j) => groupOf(j, m, 2) === 0).map((x) => x.s), d, false);
    }
    const half = items.filter((_, i) => groupOf(i, n, 2) === 0).map((x) => x.s);
    if (kind === "VOLH") return mkTarget(half, d, false);
    const halfSop = half.map((s) => ({ s, sop: sopAt(s, d) })).filter((x) => Number.isFinite(x.sop));
    if (kind === "VOLH_SOPA") return mkTarget(halfSop.map((x) => x.s), d, false);
    // M3
    const m1 = items.filter((_, i) => groupOf(i, n, 3) === 0).map((x) => x.s);
    const sorted = [...halfSop].sort((a, b) => b.sop - a.sop || (a.s.code < b.s.code ? -1 : 1)), m = sorted.length;
    const top = sorted.filter((_, j) => groupOf(j, m, 2) === 0).map((x) => x.s);
    return top.length < LV_M3_MIN_COUNT ? mkTarget(m1, d, true) : mkTarget(top, d, false);
  }
  const targetsOf = (kind: DKind, sigs: string[], N: number): Target[] => sigs.map((d) => targetFor(kind, d, N));

  // ---- 엔진 ----
  const buyRate = (1 + SCAN_SMALL_SLIPPAGE) * (1 + FEE_PCT_PER_SIDE) - 1;
  const sellRate = (d: string): number => 1 - (1 - SCAN_SMALL_SLIPPAGE) * (1 - FEE_PCT_PER_SIDE - getSecuritiesTaxRate(d, "KR"));
  function run(targets: Target[], sigs: string[], delay: boolean, endD: string): Out {
    const execAt = new Map<string, Target>();
    sigs.forEach((d, k) => { const j = calIdx.get(d)! + 1 + (delay ? 1 : 0); if (j < nCal && k < targets.length) execAt.set(CAL[j], targets[k]); });
    let cash = 1, prevV = 1;
    const pos = new Map<string, { val: number; last: number }>();
    const out: Out = { dates: [], ret: [], costFrac: [], turn: [], nPos: [], liq: [] };
    for (let c = calIdx.get(firstExec)!; c < nCal; c++) {
      const d = CAL[c];
      if (d > endD) break;
      const sr = sellRate(d);
      let costF = 0;
      for (const [code, p] of pos) {
        const sk = byCode.get(code)!;
        const i = sk.idx.get(d);
        if (i !== undefined) { p.val = (p.val * sk.close[i]) / p.last; p.last = sk.close[i]; }
        else if (sk.last < d && sk.last < endedBefore) { costF += (p.val * sr) / prevV; cash += p.val * (1 - sr); pos.delete(code); out.liq.push(d); }
      }
      const now = execAt.get(d);
      if (now) {
        let V = cash;
        for (const p of pos.values()) V += p.val;
        const tg = new Map<string, number>();
        for (const [code, w] of now.w) if (byCode.get(code)!.idx.has(d) && w > 0) tg.set(code, w);
        let buyN = 0, sellN = 0;
        for (const [code, p] of pos) if (!tg.has(code)) sellN += p.val;
        for (const [code, w] of tg) { const diff = w * V - (pos.get(code)?.val ?? 0); if (diff > 0) buyN += diff; else sellN += -diff; }
        const C = buyN * buyRate + sellN * sr, scale = V > 0 ? (V - C) / V : 1;
        pos.clear();
        let inv = 0;
        for (const [code, w] of tg) { const sk = byCode.get(code)!; const val = w * V * scale; pos.set(code, { val, last: sk.close[sk.idx.get(d)!] }); inv += val; }
        cash = V - C - inv;
        costF += V > 0 ? C / V : 0;
        if (buyN + sellN > 0) out.turn.push({ d, v: V > 0 ? (buyN + sellN) / 2 / V : 0 });
      }
      let V = cash;
      for (const p of pos.values()) V += p.val;
      out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.costFrac.push(costF); out.nPos.push(pos.size);
      prevV = V;
    }
    return out;
  }

  // ---- 지표 ----
  function st(o: { dates: string[]; ret: number[]; costFrac?: number[]; turn?: { d: string; v: number }[]; nPos?: number[]; liq?: string[] }, win: Win, retOverride?: number[]) {
    const to = win.to > dataEnd ? dataEnd : win.to;
    const idx: number[] = [];
    for (let i = 0; i < o.dates.length; i++) if (o.dates[i] >= win.from && o.dates[i] <= win.to && o.dates[i] > firstExec) idx.push(i);
    const r = idx.map((i) => (retOverride ? retOverride[i] : o.ret[i]));
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
    const cagr = computeCagrPct(totalReturnPct, win.from, to);
    const m = r.reduce((a, x) => a + x, 0) / Math.max(r.length, 1);
    const sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(r.length - 1, 1));
    const yrs = Math.max(dayDiff(win.from, to) / 365.25, 1e-9);
    return {
      cagr, mdd: mddPct, sharpe: sd > 0 ? (m * ETF_TRADING_DAYS_PER_YEAR) / (sd * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR)) : NaN, vol: sd * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR),
      turnover: o.turn ? (o.turn.filter((x) => x.d >= win.from && x.d <= win.to && x.d > firstExec).reduce((a, x) => a + x.v, 0) / (yrs * LV_QUARTERS_PER_YEAR)) * 100 : NaN,
      cost: o.costFrac ? idx.reduce((a, i) => a + o.costFrac![i], 0) * 100 : NaN,
      avgN: o.nPos ? idx.reduce((a, i) => a + o.nPos![i], 0) / Math.max(idx.length, 1) : NaN,
      liq: o.liq ? o.liq.filter((d) => d >= win.from && d <= win.to && d > firstExec).length : NaN,
    };
  }
  type Stat = ReturnType<typeof st>;
  const yearRet = (o: { dates: string[]; ret: number[] }, y: number, win: Win): number => computeCumulativeAndMdd(o.ret.filter((_, i) => o.dates[i].startsWith(`${y}-`) && o.dates[i] >= win.from && o.dates[i] <= win.to && o.dates[i] > firstExec)).totalReturnPct;
  const medianTv = (sigs: string[], targets: Target[], win: Win, delay = false): number => {
    const v: number[] = [];
    sigs.forEach((d, k) => { const j = calIdx.get(d)! + 1 + (delay ? 1 : 0); if (j >= nCal || k >= targets.length) return; const e = CAL[j]; if (e >= win.from && e <= win.to && e > firstExec) v.push(...targets[k].tv); });
    v.sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] / 1e8 : NaN;
  };
  const fbCount = (sigs: string[], targets: Target[], win: Win): string => {
    let fb = 0, tot = 0;
    sigs.forEach((d, k) => { const j = calIdx.get(d)! + 1; if (j >= nCal || k >= targets.length) return; const e = CAL[j]; if (e >= win.from && e <= win.to && e > firstExec) { tot++; if (targets[k].fallback) fb++; } });
    return `${fb}/${tot}`;
  };

  // ---- B&H, KOSDAQ, KOSPI ----
  const rawEtf: { date: string; px: number }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from("etf_daily_prices").select("trade_date, adj_close").eq("code", SEASON_STOCK_CODE).order("trade_date").range(from, from + 999);
    if (error) throw new Error(`etf_daily_prices: ${error.message}`);
    for (const r of data ?? []) rawEtf.push({ date: r.trade_date as string, px: Number(r.adj_close) });
    dbRead["etf_daily_prices(069500)"] = (dbRead["etf_daily_prices(069500)"] ?? 0) + (data?.length ?? 0);
    if (!data || data.length < 1000) break;
  }
  const kRetByDate = new Map<string, number>();
  for (let i = 1; i < kospi.length; i++) kRetByDate.set(kospi[i].tradeDate, kospi[i].closePrice / kospi[i - 1].closePrice - 1);
  const etf = rawEtf.map((x) => ({ ...x }));
  {
    const r = rawEtf.map((x, i) => (i === 0 ? NaN : x.px / rawEtf[i - 1].px - 1));
    let nCh = 0;
    for (let t = 1; t + 1 < rawEtf.length; t++) {
      if (!(Math.abs(r[t]) > ETF_SPIKE_MIN_ABS_RET) || !(Math.sign(r[t + 1]) === -Math.sign(r[t])) || !(Math.abs((1 + r[t]) * (1 + r[t + 1]) - 1) < ETF_SPIKE_MAX_NET_ABS)) continue;
      const kr = kRetByDate.get(rawEtf[t].date);
      if (kr !== undefined && Math.sign(kr) === Math.sign(r[t]) && Math.abs(kr) >= ETF_SPIKE_KOSPI_EXEMPT_RATIO * Math.abs(r[t])) continue;
      etf[t].px = Math.sqrt(rawEtf[t - 1].px * rawEtf[t + 1].px); nCh++;
    }
    console.log(`069500 정제로 바꾼 날 ${nCh}개`);
  }
  const bh = { dates: etf.slice(1).map((x) => x.date), ret: etf.slice(1).map((x, i) => (x.px / etf[i].px - 1) * 100) };
  const idxSeries = (pts: typeof kospi): { dates: string[]; ret: number[] } => { const p = pts.filter((x) => x.tradeDate >= "2009-12-01"); return { dates: p.slice(1).map((x) => x.tradeDate), ret: computeIndexDailyReturnsPct(p as never) }; };
  const kos = idxSeries(kospi), kdq = idxSeries(kosdaq);
  console.log(`KOSDAQ 지수 ${kosdaq.length}행 ${kosdaq[0]?.tradeDate}~${kosdaq[kosdaq.length - 1]?.tradeDate}`);

  const LEARN: Win = { ...LV_LEARN }, CONFIRM: Win = { ...LV_CONFIRM }, HOLD: Win = { from: LV_HOLDOUT_FROM, to: "9999-12-31" }, FULL: Win = { from: LV_LEARN.from, to: "9999-12-31" };
  const gatesOf = (x: Stat, sew: Stat, b: Stat, drop: number): boolean[] => [x.cagr >= sew.cagr + LV_G1_CAGR_MARGIN_PP, x.cagr > b.cagr, x.mdd <= b.mdd + LV_G3_MDD_MARGIN_PP, drop <= LV_G4_MAX_DELAY_DROP_PP];
  const HEAD = "| 구성 | CAGR % | MDD % | 샤프 | 연변동성 % | 분기 평균 회전율 % | 누적 비용 % | 평균 보유 종목 수 | 보유 종목 20일 평균 거래대금 중앙값(억원) | 폐지 청산 건수 | 지연 CAGR % | 하락 %p | G1 | G2 | G3 | G4 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const row = (lab: string, s: Stat, tv: number, extra: string): string => `| ${lab} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${f2(s.vol)} | ${f2(s.turnover)} | ${f2(s.cost)} | ${f2(s.avgN)} | ${f2(tv)} | ${Number.isFinite(s.liq) ? s.liq : "-"} | ${extra}`;
  const refRow = (lab: string, s: Stat): string => `| ${lab} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${f2(s.vol)} | - | - | - | - | - | | | | | | |`;
  const yrsOf = (win: Win): number[] => { const a: number[] = []; for (let y = Number(win.from.slice(0, 4)); y <= Math.min(Number(win.to.slice(0, 4)), Number(dataEnd.slice(0, 4))); y++) a.push(y); return a; };

  // ---- 2. 수집 대상 편향 점검 ----
  const WINS: [string, Win][] = [["학습 2010-04-01~2016-12-31", LEARN], ["확인 2017-01-01~2021-12-31", CONFIRM], ["2022~ (참고)", HOLD], ["전 기간 2010-04-01~데이터 끝", FULL]];
  const GROUPS = ["미래 진입", "과거 진입", "미진입"] as const;
  const groupOfStock = (s: S, d: string): (typeof GROUPS)[number] => { const fe = firstElig.get(s.code); return !fe ? "미진입" : fe <= d ? "과거 진입" : "미래 진입"; };
  console.log(`\n=== 2b/2c. 분기 말 SMALL 구성원의 PIT 유니버스(시총 5천억 + 거래대금 5억) 진입 시점별 분해 ===\n정의: 신호일 d 기준 — 미래 진입 = d 이후 처음 진입, 과거 진입 = d 이전(포함)에 이미 진입한 적 있음, 미진입 = 데이터 끝까지 진입 없음. 진입 판정은 2010-01-04 이후 거래일 기준(그 이전 이력은 관측하지 못함).`);
  const GT: Record<string, Target[]> = {}, GO: Record<string, Out> = {};
  for (const g of GROUPS) { GT[g] = quarterSignals.map((d) => mkTarget(smallAt(d).filter((s) => groupOfStock(s, d) === g), d, false)); GO[g] = run(GT[g], quarterSignals, false, "9999-12-31"); }
  const KINDS: DKind[] = ["SEW_SOP", "VOLH", "VOLH_SOPA", "M3", "SEW"];
  const T: Record<string, Target[]> = {}, O: Record<string, Out> = {};
  for (const k of KINDS) { T[k] = targetsOf(k, quarterSignals, LV_VOL_DAYS); O[k] = run(T[k], quarterSignals, false, "9999-12-31"); }
  const qFresh = (s: S, d: string): boolean => { let rec: S["qrecs"][number] | null = null; for (const r of s.qrecs) { if (r.rcept <= d) rec = r; else break; } return !!rec && dayDiff(rec.rcept, d) <= SCAN_QUARTER_FRESH_DAYS; };
  for (const [wl, win] of WINS) {
    const dates = quarterSignals.filter((d) => { const j = calIdx.get(d)! + 1; if (j >= nCal) return false; const e = CAL[j]; return e >= win.from && e <= win.to && e > firstExec; });
    console.log(`\n[${wl}] (신호일 ${dates.length}개)\n| 그룹 | 평균 종목 수 | 분기 레코드 보유율 % | SOP 계산 가능 % | 연간 재무 보유율 % | PER 역수 계산 가능 % | 다음 분기 동일가중 CAGR % | MDD % | 평균 보유 종목 |\n|---|---|---|---|---|---|---|---|---|`);
    const rowsOut: [string, S[][], Out][] = [...GROUPS.map((g) => [g, dates.map((d) => smallAt(d).filter((s) => groupOfStock(s, d) === g)), GO[g]] as [string, S[][], Out]), ["전체 SMALL", dates.map((d) => smallAt(d)), O.SEW]];
    for (const [lab, lists, out] of rowsOut) {
      const cnt = lists.map((l) => l.length);
      const share = (f: (s: S, d: string) => boolean): number => { const v: number[] = []; lists.forEach((l, i) => { if (l.length) v.push((l.filter((s) => f(s, dates[i])).length / l.length) * 100); }); return mean(v); };
      const s = st(out, win);
      console.log(`| ${lab} | ${f2(mean(cnt))} | ${f2(share((x, d) => qFresh(x, d)))} | ${f2(share((x, d) => sopInfo(x, d) !== null))} | ${f2(share((x, d) => pickFundamentalsAsOf(x.fund, d) !== null))} | ${f2(share((x, d) => { const f = pickFundamentalsAsOf(x.fund, d); return !!f && f.netIncomeParent !== null && f.netIncomeParent > 0; }))} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.avgN)} |`);
    }
  }

  // ---- 3. 정렬 수정 후 재계산 ----
  type Pair = [number, number];
  const P3A: Record<string, Record<string, Pair>> = { M3: { L: [18.91, 23.28], C: [17.94, 45.27], H: [3.30, 30.46] }, SEW: { L: [2.04, 30.27], C: [3.01, 59.66], H: [-8.61, 46.20] } };
  const P6F: Record<string, Record<string, Pair>> = {
    SEW_SOP: { L: [12.74, 27.26], C: [20.27, 50.44], H: [4.25, 38.02], F: [12.38, 50.44] },
    VOLH: { L: [8.64, 24.31], C: [6.85, 53.85], H: [-2.82, 30.18], F: [4.66, 54.20] },
    VOLH_SOPA: { L: [15.75, 20.74], C: [15.61, 49.26], H: [0.37, 30.28], F: [11.03, 49.26] },
    M3: { L: [17.96, 21.18], C: [17.33, 45.22], H: [1.15, 31.13], F: [12.64, 45.22] },
    SEW: { L: [2.04, 30.27], C: [3.01, 59.66], H: [-8.61, 46.20], F: [-0.88, 64.69] },
  };
  const WK = ["L", "C", "H", "F"] as const;
  console.log("\n=== 3. 정렬 수정 후 재계산 (참고용, 판정 없음) ===\n| 전략 | 창 | CAGR % | MDD % | 6f61122f CAGR | 차이 | 6f61122f MDD | 차이 | 3a41f17d CAGR | 차이 | 3a41f17d MDD | 차이 |\n|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const k of KINDS) WINS.forEach(([wl, win], wi) => {
    const s = st(O[k], win), a = P6F[k]?.[WK[wi]], b = P3A[k]?.[WK[wi]];
    console.log(`| ${k} | ${wl} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${a ? f2(a[0]) : "-"} | ${a ? f2(s.cagr - a[0]) : "-"} | ${a ? f2(a[1]) : "-"} | ${a ? f2(s.mdd - a[1]) : "-"} | ${b ? f2(b[0]) : "-"} | ${b ? f2(s.cagr - b[0]) : "-"} | ${b ? f2(b[1]) : "-"} | ${b ? f2(s.mdd - b[1]) : "-"} |`);
  });
  console.log(`M3 → M1 대체 횟수(전체 ${quarterSignals.length}개 중, 첫 신호 포함): ${T.M3.filter((t) => t.fallback).length} (이전 6f61122f 실행: 체결일 기준 6/66)`);

  console.log("\n=== 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

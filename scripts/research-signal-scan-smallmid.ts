/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 중소형주 신호 스캔 2회차(학습 구간만, 전략 백테스트 없음): 신호 11개, 유니버스 MID·SMALL.
 * 사전 등록: research/signal-scan-smallmid-prereg.md (커밋 fcc2f16f), 측정 방법은 research/signal-scan-prereg.md(19d3eeaf)와 같다. 숫자와 표만 출력한다.
 * 2016-12-31을 넘는 가격·재무·공시 행은 읽은 직후 버린다.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { applyAdjustmentsInPlace } from "@/lib/priceAdjustment";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice, getSecuritiesTaxRate } from "@/lib/transactionCost";
import { FEE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";
import { pickFundamentalsAsOf, pickDividendsPaidAsOf, type FundamentalsSeries, type StockFundamentalsAsOf, type StockDividendPayment } from "@/lib/pointInTimeFundamentals";
import {
  SCAN_START, SCAN_END, SCAN_HORIZONS, SCAN_SPACING_MONTHLY_DAYS, SCAN_SPACING_WEEKLY_DAYS, SCAN_CAP_EOK, SCAN_POOL_SIZE, SCAN_MIN_CROSS_SECTION, SCAN_MIN_EVENT_NAMES,
  SCAN_CANDIDATE_ABS_T, SCAN_MOM_LONG_DAYS, SCAN_MOM_SKIP_DAYS, SCAN_H52_DAYS, SCAN_H52_MIN_ROWS, SCAN_VOL_DAYS,
  SCAN_VOL_MIN_RETURNS, SCAN_TVG_DAYS, SCAN_QUARTER_FRESH_DAYS, SCAN_DIVIDEND_WINDOW_DAYS, SCAN_BUYBACK_WINDOW_DAYS, SCAN_DB_CHUNK,
  SCAN_SMALL_MIN_MCAP_EOK, SCAN_SMALL_MIN_AVG_TV_WON, SCAN_SMALL_MIN_PRICE_WON, SCAN_SMALL_SLIPPAGE, SCAN_ENDED_GRACE_DAYS,
} from "@/lib/signalScanConfig";

const T0 = Date.now();
const MS_DAY = 86_400_000;
const EOK = 1e8;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "-");
const addDays = (d: string, n: number): string => new Date(Date.parse(d) + n * MS_DAY).toISOString().slice(0, 10);
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

const SIGNALS = ["MOM", "REV", "H52", "VOL", "TVG", "EP", "BP", "ROE", "SOP", "DY", "BB"] as const;
const NS = SIGNALS.length;
const SIG_LABEL: Record<(typeof SIGNALS)[number], string> = {
  MOM: "12-1개월 모멘텀", REV: "1개월 반전", H52: "52주 고가 대비", VOL: "60일 변동성(낮을수록)", TVG: "20일 거래대금 증가율",
  EP: "PER 역수", BP: "PBR 역수", ROE: "ROE", SOP: "분기 영업이익 증가율", DY: "배당수익률", BB: "자사주 공시 60일(0/1)",
};
const BB_IDX = SIGNALS.indexOf("BB");

interface S {
  code: string; idx: Map<string, number>; mcapRow: Float64Array; avgTvRow: Float64Array; rawRow: Float64Array; lastDate: string;
  closeA: Float64Array; mcapA: Float64Array; avgTvA: Float64Array;
  fund: FundamentalsSeries; qrecs: { rcept: string; order: number; op: number | null; prev: number | null }[]; bb: string[];
}
interface DD { list: S[]; vals: Float64Array }
type Kind = "M" | "W";
type U = "MID" | "SMALL";

const rank = (v: number[]): number[] => {
  const o = v.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
  const r = new Array<number>(v.length);
  for (let a = 0; a < o.length;) { let b = a; while (b + 1 < o.length && o[b + 1].x === o[a].x) b++; for (let c = a; c <= b; c++) r[o[c].i] = (a + b) / 2 + 1; a = b + 1; }
  return r;
};
const pearson = (a: number[], b: number[]): number => {
  const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
};
const spearman = (a: number[], b: number[]): number => pearson(rank(a), rank(b));
const mean = (a: number[]): number => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1);
const sdev = (a: number[]): number => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(a.length - 1, 1)); };
function nwT(x: number[], L: number): number {
  const n = x.length;
  if (n < 3) return NaN;
  const m = mean(x);
  const g = (j: number): number => { let s = 0; for (let t = j; t < n; t++) s += (x[t] - m) * (x[t - j] - m); return s / n; };
  let v = g(0);
  for (let j = 1; j <= L && j < n; j++) v += 2 * (1 - j / (L + 1)) * g(j);
  return v > 0 ? m / Math.sqrt(v / n) : NaN;
}
const groupOf = (i: number, n: number): number => Math.floor((i * 3) / n);

async function main(): Promise<void> {
  console.log(`중소형주 신호 스캔 시작(읽기 전용, 학습 구간만): ${new Date().toISOString()} (사전등록 fcc2f16f 이후) — 스캔 2회차(신호 수 ${NS}개)`);
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear());

  // ---- 가격: 2016-12-31 이후 행 버리고 수정주가 사본 ----
  interface Row0 { code: string; dates: string[]; close: Float64Array; raw: Float64Array; mcap: Float64Array; avgTv: Float64Array }
  const rows0: Row0[] = [];
  const calSet = new Set<string>();
  let droppedRows = 0;
  for (const [code, rows] of series) {
    const kept = rows.filter((r) => r.tradeDate <= SCAN_END);
    droppedRows += rows.length - kept.length;
    series.delete(code);
    if (!kept.length) continue;
    const adj = kept.map((r) => ({ ...r }));
    const al = adjustments.get(code);
    if (al) applyAdjustmentsInPlace(adj, al);
    for (const r of kept) if (r.tradeDate >= "2010-01-01") calSet.add(r.tradeDate);
    rows0.push({ code, dates: kept.map((r) => r.tradeDate), close: Float64Array.from(adj.map((r) => r.closePrice)), raw: Float64Array.from(kept.map((r) => r.closePrice)), mcap: Float64Array.from(kept.map((r) => r.marketCapEok)), avgTv: computeTrailingAvgTradingValue(adj, PIT_LIQUIDITY_LOOKBACK_DAYS) });
  }
  const CAL = [...calSet].sort();
  const nCal = CAL.length, lastIdx = nCal - 1;
  const calIdx = new Map(CAL.map((d, i) => [d, i]));
  console.log(`종목 ${rows0.length}개, 거래일 ${nCal}일 ${CAL[0]}~${CAL[lastIdx]}, 학습 구간 밖이라 버린 가격 행 ${droppedRows}`);

  // ---- 후보 종목(한 번이라도 PIT 적격) ----
  const candidates = rows0.filter((r) => {
    for (let i = 1; i < r.dates.length; i++) {
      if (r.dates[i] < "2010-01-01") continue;
      if (r.mcap[i - 1] >= SCAN_CAP_EOK && r.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON) return true;
      if (r.mcap[i - 1] >= SCAN_SMALL_MIN_MCAP_EOK && r.mcap[i - 1] < SCAN_CAP_EOK && r.avgTv[i] >= SCAN_SMALL_MIN_AVG_TV_WON && r.raw[i] >= SCAN_SMALL_MIN_PRICE_WON) return true;
    }
    return false;
  });
  const candCodes = candidates.map((r) => r.code);
  console.log(`MID 또는 SMALL 이력이 있는 종목 ${candCodes.length}개`);

  // ---- 재무·배당·분기·공시 (접수일 2016-12-31 이하만) ----
  interface FRow { fy: number; rceptNo: string; rcept: string; ni: number | null; eq: number | null; fsDiv: "CFS" | "OFS" }
  const stockRows = new Map<string, Map<number, FRow>>();
  const putRow = (code: string, r: FRow, prio: number, prios: Map<string, number>): void => {
    const m = stockRows.get(code) ?? new Map<number, FRow>();
    stockRows.set(code, m);
    const key = `${code}|${r.fy}`;
    if ((prios.get(key) ?? -1) < prio) { m.set(r.fy, r); prios.set(key, prio); }
  };
  const prios = new Map<string, number>();
  const divBy = new Map<string, StockDividendPayment[]>();
  const qBy = new Map<string, S["qrecs"]>();
  const QEND: Record<number, string> = { 1: "03-31", 2: "06-30", 3: "09-30" };
  for (let i = 0; i < candCodes.length; i += SCAN_DB_CHUNK) {
    const chunk = candCodes.slice(i, i + SCAN_DB_CHUNK);
    const x = await selectAll<{ stock_code: string; fiscal_year: number; rcept_no: string; rcept_date: string; net_income_parent: number | null; equity_parent: number | null; fs_div: string }>("stock_annual_fundamentals", (f, t) => supabaseAdmin.from("stock_annual_fundamentals").select("stock_code, fiscal_year, rcept_no, rcept_date, net_income_parent, equity_parent, fs_div").in("stock_code", chunk).lte("rcept_date", SCAN_END).order("stock_code").order("fiscal_year").range(f, t));
    for (const r of x) putRow(r.stock_code, { fy: r.fiscal_year, rceptNo: r.rcept_no, rcept: r.rcept_date, ni: r.net_income_parent === null ? null : Number(r.net_income_parent), eq: r.equity_parent === null ? null : Number(r.equity_parent), fsDiv: r.fs_div as "CFS" | "OFS" }, 3, prios);
    const b = await selectAll<{ stock_code: string; fiscal_year: number; rcept_no: string | null; rcept_date: string | null; net_income_parent: number | null; equity_parent: number | null; fs_div: string | null }>("stock_annual_fundamentals_fill(ok)", (f, t) => supabaseAdmin.from("stock_annual_fundamentals_fill").select("stock_code, fiscal_year, rcept_no, rcept_date, net_income_parent, equity_parent, fs_div").eq("status", "ok").in("stock_code", chunk).lte("rcept_date", SCAN_END).order("stock_code").order("fiscal_year").range(f, t));
    for (const r of b) { if (!r.rcept_date || !r.rcept_no) continue; putRow(r.stock_code, { fy: r.fiscal_year, rceptNo: r.rcept_no, rcept: r.rcept_date, ni: r.net_income_parent === null ? null : Number(r.net_income_parent), eq: r.equity_parent === null ? null : Number(r.equity_parent), fsDiv: (r.fs_div ?? "CFS") as "CFS" | "OFS" }, 2, prios); }
    const c = await selectAll<{ stock_code: string; fiscal_year: number; rcept_no: string | null; rcept_dt: string | null; ni_parent: number | null; equity_parent: number | null; ni_basis: string | null }>("dart_xbrl_fundamentals", (f, t) => supabaseAdmin.from("dart_xbrl_fundamentals").select("stock_code, fiscal_year, rcept_no, rcept_dt, ni_parent, equity_parent, ni_basis").in("stock_code", chunk).lte("rcept_dt", SCAN_END).order("corp_code").order("fiscal_year").order("source").range(f, t));
    for (const r of c) { if (!r.rcept_dt || !r.rcept_no) continue; putRow(r.stock_code, { fy: r.fiscal_year, rceptNo: r.rcept_no, rcept: r.rcept_dt, ni: r.ni_parent === null ? null : Number(r.ni_parent), eq: r.equity_parent === null ? null : Number(r.equity_parent), fsDiv: r.ni_basis === "sep" ? "OFS" : "CFS" }, 1, prios); }
    const dv = await selectAll<{ stock_code: string; record_date: string; cash_dividend_per_share: number; pay_date: string }>("stock_dividend_history", (f, t) => supabaseAdmin.from("stock_dividend_history").select("stock_code, record_date, cash_dividend_per_share, pay_date").in("stock_code", chunk).not("pay_date", "is", null).lte("pay_date", SCAN_END).order("stock_code").order("record_date").range(f, t));
    for (const r of dv) { const a = divBy.get(r.stock_code) ?? []; a.push({ recordDate: r.record_date, cashDividendPerShare: Number(r.cash_dividend_per_share), payDate: r.pay_date }); divBy.set(r.stock_code, a); }
    const q = await selectAll<{ stock_code: string; fiscal_year: number; quarter: number; rcept_date: string | null; op_income_q: number | null; op_income_prev_q: number | null; off_cycle: boolean }>("dart_quarterly_fundamentals(ok)", (f, t) => supabaseAdmin.from("dart_quarterly_fundamentals").select("stock_code, fiscal_year, quarter, rcept_date, op_income_q, op_income_prev_q, off_cycle").eq("status", "ok").in("stock_code", chunk).lte("rcept_date", SCAN_END).order("corp_code").order("fiscal_year").order("quarter").range(f, t));
    for (const r of q) {
      if (r.off_cycle || !r.rcept_date || r.quarter < 1 || r.quarter > 3 || r.rcept_date < `${r.fiscal_year}-${QEND[r.quarter]}`) continue;
      const a = qBy.get(r.stock_code) ?? [];
      a.push({ rcept: r.rcept_date, order: r.fiscal_year * 10 + r.quarter, op: r.op_income_q === null ? null : Number(r.op_income_q), prev: r.op_income_prev_q === null ? null : Number(r.op_income_prev_q) });
      qBy.set(r.stock_code, a);
    }
  }
  const bbRows = await selectAll<{ stock_code: string | null; rcept_dt: string }>("dart_buyback_events(원본)", (f, t) => supabaseAdmin.from("dart_buyback_events").select("stock_code, rcept_dt").eq("is_amendment", false).eq("is_extension", false).not("stock_code", "is", null).lte("rcept_dt", SCAN_END).order("rcept_no").range(f, t));
  const bbBy = new Map<string, string[]>();
  for (const r of bbRows) { const a = bbBy.get(r.stock_code as string) ?? []; a.push(r.rcept_dt); bbBy.set(r.stock_code as string, a); }

  // ---- 종목 구조 ----
  const stocks: S[] = candidates.map((r) => {
    const idx = new Map(r.dates.map((d, i) => [d, i]));
    const closeA = new Float64Array(nCal).fill(NaN), mcapA = new Float64Array(nCal).fill(NaN), avgTvA = new Float64Array(nCal).fill(NaN);
    for (let c = 0; c < nCal; c++) {
      const i = idx.get(CAL[c]);
      if (i === undefined) continue;
      if (r.close[i] > 0) closeA[c] = r.close[i];
      mcapA[c] = r.mcap[i];
      if (Number.isFinite(r.avgTv[i])) avgTvA[c] = r.avgTv[i];
    }
    const merged = [...(stockRows.get(r.code)?.values() ?? [])].sort((a, b) => (a.rcept === b.rcept ? a.fy - b.fy : a.rcept < b.rcept ? -1 : 1));
    const annual: StockFundamentalsAsOf[] = merged.map((x) => ({ fiscalYear: x.fy, rceptNo: x.rceptNo, rceptDate: x.rcept, netIncomeParent: x.ni, equityParent: x.eq, fsDiv: x.fsDiv }));
    const q = (qBy.get(r.code) ?? []).sort((a, b) => (a.rcept === b.rcept ? a.order - b.order : a.rcept < b.rcept ? -1 : 1));
    return { code: r.code, idx, mcapRow: r.mcap, avgTvRow: r.avgTv, rawRow: r.raw, lastDate: r.dates[r.dates.length - 1], closeA, mcapA, avgTvA, fund: { annual, dividends: divBy.get(r.code) ?? [] }, qrecs: q, bb: (bbBy.get(r.code) ?? []).sort() };
  });
  stocks.sort((a, b) => (a.code < b.code ? -1 : 1));
  rows0.length = 0;

  // ---- 유니버스 ----
  const eligibleAt = (d: string): { s: S; mcap: number }[] => {
    const out: { s: S; mcap: number }[] = [];
    for (const s of stocks) {
      const i = s.idx.get(d);
      if (i === undefined || i < 1 || !(s.mcapRow[i - 1] >= SCAN_CAP_EOK) || !(s.avgTvRow[i] >= PIT_MIN_AVG_TRADING_VALUE_WON)) continue;
      out.push({ s, mcap: s.mcapRow[i] });
    }
    return out;
  };
  const eligCache = new Map<string, { s: S; mcap: number }[]>();
  const elig = (d: string): { s: S; mcap: number }[] => { let e = eligCache.get(d); if (!e) { e = eligibleAt(d); eligCache.set(d, e); } return e; };
  const smallAt = (d: string): S[] => {
    const out: S[] = [];
    for (const s of stocks) {
      const i = s.idx.get(d);
      if (i === undefined || i < 1) continue;
      const pm = s.mcapRow[i - 1];
      if (!(pm >= SCAN_SMALL_MIN_MCAP_EOK) || !(pm < SCAN_CAP_EOK) || !(s.avgTvRow[i] >= SCAN_SMALL_MIN_AVG_TV_WON) || !(s.rawRow[i] >= SCAN_SMALL_MIN_PRICE_WON)) continue;
      out.push(s);
    }
    return out;
  };
  const smallCache = new Map<string, S[]>();
  const universeAt = (u: U, d: string): S[] => {
    if (u === "SMALL") { let v = smallCache.get(d); if (!v) { v = smallAt(d); smallCache.set(d, v); } return v; }
    return [...elig(d)].sort((a, b) => b.mcap - a.mcap || (a.s.code < b.s.code ? -1 : 1)).slice(SCAN_POOL_SIZE).map((x) => x.s);
  };

  // ---- 신호 계산 ----
  function signalsAt(s: S, c: number, d: string, out: Float64Array, off: number): void {
    out.fill(NaN, off, off + NS);
    const mc = s.mcapA[c];
    const cl = s.closeA;
    if (c >= SCAN_MOM_LONG_DAYS) { const a = cl[c - SCAN_MOM_SKIP_DAYS], b = cl[c - SCAN_MOM_LONG_DAYS]; if (a > 0 && b > 0) out[off + 0] = a / b - 1; }
    if (c >= SCAN_MOM_SKIP_DAYS) { const a = cl[c], b = cl[c - SCAN_MOM_SKIP_DAYS]; if (a > 0 && b > 0) out[off + 1] = -(a / b - 1); }
    if (c >= SCAN_H52_DAYS - 1 && cl[c] > 0) {
      let mx = 0, n = 0;
      for (let j = c - SCAN_H52_DAYS + 1; j <= c; j++) if (cl[j] > 0) { n++; if (cl[j] > mx) mx = cl[j]; }
      if (n >= SCAN_H52_MIN_ROWS && mx > 0) out[off + 2] = cl[c] / mx;
    }
    if (c >= SCAN_VOL_DAYS) {
      let n = 0, sum = 0, sum2 = 0;
      for (let j = c - SCAN_VOL_DAYS + 1; j <= c; j++) if (cl[j] > 0 && cl[j - 1] > 0) { const r = cl[j] / cl[j - 1] - 1; n++; sum += r; sum2 += r * r; }
      if (n >= SCAN_VOL_MIN_RETURNS) { const m = sum / n; out[off + 3] = -Math.sqrt(Math.max((sum2 - n * m * m) / (n - 1), 0)); }
    }
    if (c >= SCAN_TVG_DAYS) { const a = s.avgTvA[c], b = s.avgTvA[c - SCAN_TVG_DAYS]; if (a > 0 && b > 0) out[off + 4] = a / b - 1; }
    const M = mc * EOK;
    const fund = pickFundamentalsAsOf(s.fund, d);
    if (fund && M > 0) {
      const ni = fund.netIncomeParent, eq = fund.equityParent;
      if (ni !== null && ni > 0) out[off + 5] = ni / M;
      if (eq !== null && eq > 0) out[off + 6] = eq / M;
      if (ni !== null && ni > 0 && eq !== null && eq > 0) out[off + 7] = ni / eq;
    }
    let rec: S["qrecs"][number] | null = null;
    for (const r of s.qrecs) { if (r.rcept <= d) rec = r; else break; }
    if (rec && dayDiff(rec.rcept, d) <= SCAN_QUARTER_FRESH_DAYS && rec.op !== null && rec.prev !== null && rec.prev !== 0) out[off + 8] = (rec.op - rec.prev) / Math.abs(rec.prev);
    const i = s.idx.get(d);
    if (i !== undefined && s.rawRow[i] > 0) {
      const sum = pickDividendsPaidAsOf(s.fund, d, addDays(d, -(SCAN_DIVIDEND_WINDOW_DAYS - 1))).reduce((a, x) => a + x.cashDividendPerShare, 0);
      if (sum > 0) out[off + 9] = sum / s.rawRow[i];
    }
    const lo = addDays(d, -(SCAN_BUYBACK_WINDOW_DAYS - 1));
    let hit = 0;
    for (const r of s.bb) { if (r > d) break; if (r >= lo) { hit = 1; break; } }
    out[off + 10] = hit;
  }
  const ddCache = new Map<string, DD>();
  function dataAt(u: U, d: string): DD {
    const key = `${u}|${d}`;
    let dd = ddCache.get(key);
    if (dd) return dd;
    const list = universeAt(u, d), c = calIdx.get(d)!;
    const vals = new Float64Array(list.length * NS);
    list.forEach((s, k) => signalsAt(s, c, d, vals, k * NS));
    dd = { list, vals };
    ddCache.set(key, dd);
    return dd;
  }
  const buyRateU = (u: U): number => (u === "SMALL" ? (1 + SCAN_SMALL_SLIPPAGE) * (1 + FEE_PCT_PER_SIDE) - 1 : computeEffectiveBuyPrice(1) - 1);
  const sellRateU = (u: U, d: string): number => (u === "SMALL" ? 1 - (1 - SCAN_SMALL_SLIPPAGE) * (1 - FEE_PCT_PER_SIDE - getSecuritiesTaxRate(d, "KR")) : 1 - computeEffectiveSellPrice(1, d, "KR"));
  function fwd(s: S, c: number, H: number): number {
    const e = s.closeA[c + 1];
    if (!(e > 0)) return NaN;
    for (let j = c + 1 + H; j > c + 1; j--) { if (s.closeA[j] > 0) return s.closeA[j] / e - 1; }
    return 0;
  }
  /** 신호 sIdx의 (상위, 하위) 집합. items = 신호값이 있는 종목 {code, v}. BB는 1 vs 0. */
  function legs(items: { code: string; v: number }[], sIdx: number): { top: Set<string>; bot: Set<string> } {
    if (sIdx === BB_IDX) return { top: new Set(items.filter((x) => x.v > 0).map((x) => x.code)), bot: new Set(items.filter((x) => x.v === 0).map((x) => x.code)) };
    const sorted = [...items].sort((a, b) => b.v - a.v || (a.code < b.code ? -1 : 1));
    const top = new Set<string>(), bot = new Set<string>();
    sorted.forEach((x, i) => { const g = groupOf(i, sorted.length); if (g === 0) top.add(x.code); else if (g === 2) bot.add(x.code); });
    return { top, bot };
  }

  // ---- 표본일 ----
  const weekKey = (d: string): number => Math.floor((Date.parse(d) / MS_DAY + 3) / 7);
  const monthSamples: string[] = [], weekSamples: string[] = [];
  for (let k = 0; k + 1 < nCal; k++) {
    if (CAL[k] < SCAN_START) continue;
    if (CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) monthSamples.push(CAL[k]);
    if (weekKey(CAL[k]) !== weekKey(CAL[k + 1])) weekSamples.push(CAL[k]);
  }
  console.log(`월간 표본일 ${monthSamples.length}개(${monthSamples[0]}~${monthSamples[monthSamples.length - 1]}), 주간 표본일 ${weekSamples.length}개`);

  interface Res { kind: Kind; H: number; u: U; s: number; n: number; avgN: number; rho: number[]; spread: number[]; cost: number[] }
  const results: Res[] = [];
  const combos: { kind: Kind; H: number }[] = [...SCAN_HORIZONS.map((H) => ({ kind: "M" as Kind, H })), { kind: "W", H: SCAN_HORIZONS[0] }];
  for (const u of ["MID", "SMALL"] as U[]) for (const { kind, H } of combos) {
    const samples = (kind === "M" ? monthSamples : weekSamples).filter((d) => calIdx.get(d)! + 1 + H <= lastIdx);
    const acc = Array.from({ length: NS }, () => ({ rho: [] as number[], spread: [] as number[], cost: [] as number[], ns: [] as number[] }));
    for (const d of samples) {
      const c = calIdx.get(d)!;
      const dd = dataAt(u, d), d2 = CAL[c + H], dd2 = dataAt(u, d2);
      const rets = dd.list.map((s) => fwd(s, c, H));
      const exec = CAL[c + H + 1];
      const unit = buyRateU(u) + sellRateU(u, exec);
      for (let si = 0; si < NS; si++) {
        const items: { code: string; v: number; r: number }[] = [];
        dd.list.forEach((s, k) => { const v = dd.vals[k * NS + si], r = rets[k]; if (Number.isFinite(v) && Number.isFinite(r)) items.push({ code: s.code, v, r }); });
        if (items.length < SCAN_MIN_CROSS_SECTION) continue;
        acc[si].ns.push(items.length);
        const rho = spearman(items.map((x) => x.v), items.map((x) => x.r));
        if (Number.isFinite(rho)) acc[si].rho.push(rho);
        const lg = legs(items, si);
        const topR = items.filter((x) => lg.top.has(x.code)).map((x) => x.r), botR = items.filter((x) => lg.bot.has(x.code)).map((x) => x.r);
        const okSpread = si === BB_IDX ? topR.length >= SCAN_MIN_EVENT_NAMES && botR.length > 0 : topR.length > 0 && botR.length > 0;
        if (!okSpread) continue;
        acc[si].spread.push(mean(topR) - mean(botR));
        // 교체 비용: d′에서 같은 방식으로 다시 구성
        const items2: { code: string; v: number }[] = [];
        dd2.list.forEach((s, k) => { const v = dd2.vals[k * NS + si]; if (Number.isFinite(v)) items2.push({ code: s.code, v }); });
        if (items2.length < SCAN_MIN_CROSS_SECTION) continue;
        const lg2 = legs(items2, si);
        const uTop = [...lg.top].filter((x) => !lg2.top.has(x)).length / Math.max(lg.top.size, 1);
        const uBot = [...lg.bot].filter((x) => !lg2.bot.has(x)).length / Math.max(lg.bot.size, 1);
        acc[si].cost.push((uTop + uBot) * unit);
      }
    }
    for (let si = 0; si < NS; si++) results.push({ kind, H, u, s: si, n: acc[si].rho.length, avgN: mean(acc[si].ns), rho: acc[si].rho, spread: acc[si].spread, cost: acc[si].cost });
    console.log(`  완료: ${u} ${kind === "M" ? "월간" : "주간"} ${H}일 — 표본일 ${samples.length}개 (${((Date.now() - T0) / 60e3).toFixed(1)}분)`);
  }

  // ---- (b) 표 ----
  console.log("\n=== (b) 신호 × 기간 × 유니버스 (2010-04-01~2016-12-31) ===");
  console.log("순위상관 = 표본일별 횡단면 스피어만의 평균, t = Newey-West, 상위−하위·비용·순차이는 %(예측 기간 수익률 기준). 순차이 = 방향(순위상관 평균의 부호) × (상위−하위) − 비용.");
  let nCand = 0, nRows = 0;
  for (const u of ["MID", "SMALL"] as U[]) {
    console.log(`\n[유니버스 ${u === "MID" ? "MID(PIT 적격 중 시총 상위 100 제외)" : "SMALL(시총 1천억~5천억·거래대금 2억·종가 1,000원 이상, 슬리피지 0.2%)"}]`);
    console.log("| 신호 | 기간 | 표본일 수(상관) | 평균 종목 수 | 순위상관 평균 | 표준편차 | t(NW) | 양수 비율 % | 상위−하위 % | 교체 비용 % | 방향 반영 순차이 % | 후보 |\n|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (let si = 0; si < NS; si++) for (const { kind, H } of combos) {
      const r = results.find((x) => x.u === u && x.s === si && x.kind === kind && x.H === H)!;
      const m = mean(r.rho), L = Math.max(1, Math.round(H / (kind === "M" ? SCAN_SPACING_MONTHLY_DAYS : SCAN_SPACING_WEEKLY_DAYS)));
      const t = r.rho.length >= 3 ? nwT(r.rho, L) : NaN;
      const dir = m >= 0 ? 1 : -1;
      const sp = mean(r.spread) * 100, cs = mean(r.cost) * 100;
      const net = r.spread.length && r.cost.length ? dir * sp - cs : NaN;
      const cand = Number.isFinite(t) && Math.abs(t) >= SCAN_CANDIDATE_ABS_T && Number.isFinite(net) && net > 0;
      nRows++; if (cand) nCand++;
      console.log(`| ${SIG_LABEL[SIGNALS[si]]} | ${kind === "M" ? "월간" : "주간"} ${H}일 | ${r.rho.length} | ${f2(r.avgN)} | ${f3(m)} | ${f3(sdev(r.rho))} | ${f2(t)} | ${f2((r.rho.filter((x) => x > 0).length / Math.max(r.rho.length, 1)) * 100)} | ${r.spread.length ? f2(sp) : "-"} | ${r.cost.length ? f2(cs) : "-"} | ${f2(net)} | ${cand ? "후보" : ""} |`);
    }
  }
  console.log(`\n후보 표시 ${nCand}행 / 전체 ${nRows}행 (스캔 2회차, 신호 수 ${NS}개)`);

  // ---- (d) 표본 수·결측 ----
  console.log("\n=== (d) 표본 수·결측 ===");
  for (const u of ["MID", "SMALL"] as U[]) {
    const dds = monthSamples.map((d) => dataAt(u, d));
    const tot = dds.reduce((a, x) => a + x.list.length, 0);
    const distinct = new Set<string>();
    for (const dd of dds) for (const s of dd.list) distinct.add(s.code);
    const endedBefore = addDays(CAL[lastIdx], -SCAN_ENDED_GRACE_DAYS);
    const byCodeMap = new Map(stocks.map((s) => [s.code, s]));
    const delisted = [...distinct].filter((c) => byCodeMap.get(c)!.lastDate < endedBefore).length;
    console.log(`\n[${u}] 월간 표본일 ${monthSamples.length}개, 표본일당 평균 구성원 ${(tot / monthSamples.length).toFixed(1)}종목, 구간 내 서로 다른 종목 ${distinct.size}개, 그중 폐지 종목(마지막 행 < ${endedBefore}) ${delisted}개, 월말 구성원-신호 쌍 ${tot}개`);
    console.log("| 신호 | 결측 비율 % |\n|---|---|");
    for (let si = 0; si < NS; si++) { let miss = 0; for (const dd of dds) for (let k = 0; k < dd.list.length; k++) if (!Number.isFinite(dd.vals[k * NS + si])) miss++; console.log(`| ${SIG_LABEL[SIGNALS[si]]} | ${f2((miss / tot) * 100)} |`); }
  }
  console.log("\n조합별 표본일 수(예측 기간 청산일이 2016-12-31 이내인 표본일):");
  for (const { kind, H } of combos) console.log(`  ${kind === "M" ? "월간" : "주간"} ${H}일: ${(kind === "M" ? monthSamples : weekSamples).filter((d) => calIdx.get(d)! + 1 + H <= lastIdx).length}개`);
  console.log(`\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60e3).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

/**
 * [임시 진단 — 시도 아님, 통과 판정 없음, 병합 금지, 읽기 전용, 외부 요청 0건] M3 진단(D1 데이터 가용성 분해, D2 R1~R3 참고, D3 조합, D4 연도별).
 * 사전 등록: research/smallcap-m3-diagnose-prereg.md (커밋 6f61122f). M3 정의는 research/smallcap-lowvol-prereg.md(3a41f17d)와 같다. 숫자와 표만 출력한다.
 */
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
  code: string; idx: Map<string, number>; close: Float64Array; closeA: Float64Array; mcapRow: Float64Array; avgTvRow: Float64Array; rawRow: Float64Array; last: string;
  qrecs: { rcept: string; order: number; op: number | null; prev: number | null }[];
}
interface Target { w: Map<string, number>; tv: number[]; fallback: boolean; n: number; lag: number[]; sel: S[] }
interface Out { dates: string[]; ret: number[]; costFrac: number[]; turn: { d: string; v: number }[]; nPos: number[]; liq: string[] }
interface Win { from: string; to: string }
const groupOf = (i: number, n: number, parts: number): number => Math.floor((i * parts) / n);

async function main(): Promise<void> {
  console.log(`M3 진단 시작(읽기 전용, 시도 아님): ${new Date().toISOString()} (사전등록 6f61122f 이후)`);
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

  // ---- 분기 재무 ----
  const qBy = new Map<string, S["qrecs"]>();
  const QEND: Record<number, string> = { 1: "03-31", 2: "06-30", 3: "09-30" };
  const codes = cand.map((r) => r.code);
  for (let i = 0; i < codes.length; i += SCAN_DB_CHUNK) {
    const chunk = codes.slice(i, i + SCAN_DB_CHUNK);
    const q = await selectAll<{ stock_code: string; fiscal_year: number; quarter: number; rcept_date: string | null; op_income_q: number | null; op_income_prev_q: number | null; off_cycle: boolean }>("dart_quarterly_fundamentals(ok)", (f, t) => supabaseAdmin.from("dart_quarterly_fundamentals").select("stock_code, fiscal_year, quarter, rcept_date, op_income_q, op_income_prev_q, off_cycle").eq("status", "ok").in("stock_code", chunk).range(f, t));
    for (const r of q) {
      if (r.off_cycle || !r.rcept_date || r.quarter < 1 || r.quarter > 3 || r.rcept_date < `${r.fiscal_year}-${QEND[r.quarter]}`) continue;
      const a = qBy.get(r.stock_code) ?? [];
      a.push({ rcept: r.rcept_date, order: r.fiscal_year * 10 + r.quarter, op: r.op_income_q === null ? null : Number(r.op_income_q), prev: r.op_income_prev_q === null ? null : Number(r.op_income_prev_q) });
      qBy.set(r.stock_code, a);
    }
  }
  const stocks: S[] = cand.map((r) => {
    const idx = new Map(r.dates.map((d, i) => [d, i]));
    const closeA = new Float64Array(nCal).fill(NaN);
    for (let c = 0; c < nCal; c++) { const i = idx.get(CAL[c]); if (i !== undefined && r.close[i] > 0) closeA[c] = r.close[i]; }
    const q = (qBy.get(r.code) ?? []).sort((a, b) => (a.rcept === b.rcept ? a.order - b.order : a.rcept < b.rcept ? -1 : 1));
    return { code: r.code, idx, close: r.close, closeA, mcapRow: r.mcap, avgTvRow: r.avgTv, rawRow: r.raw, last: r.dates[r.dates.length - 1], qrecs: q };
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

  // ---- D1: 데이터 가용성 분해 ----
  const WINS: [string, Win][] = [["학습 2010-04-01~2016-12-31", LEARN], ["확인 2017-01-01~2021-12-31", CONFIRM], ["2022~ (참고, 홀드아웃 열람 후)", HOLD], ["전 기간 2010-04-01~데이터 끝", FULL]];
  const KINDS: DKind[] = ["SEW_SOP", "VOLH", "VOLH_SOPA", "SOPT", "M3", "SEW"];
  const KDESC: Record<DKind, string> = { SEW_SOP: "SEW_SOP (SMALL 중 SOP 있는 종목 전부)", VOLH: "VOLH (VOL 하위 1/2 전부)", VOLH_SOPA: "VOLH_SOPA (VOLH 중 SOP 있는 종목 전부)", SOPT: "SOPT (SOP 상위 1/2 전부, VOL 무관)", M3: "M3", SEW: "SEW (SMALL 전체)" };
  const T: Record<string, Target[]> = {}, O: Record<string, Out> = {};
  for (const k of KINDS) { T[k] = targetsOf(k, quarterSignals, LV_VOL_DAYS); O[k] = run(T[k], quarterSignals, false, "9999-12-31"); }
  const zeroCount = (k: DKind, win: Win): string => {
    let z = 0, tot = 0;
    quarterSignals.forEach((d, i) => { const j = calIdx.get(d)! + 1; if (j >= nCal) return; const e = CAL[j]; if (e >= win.from && e <= win.to && e > firstExec) { tot++; if (T[k][i].n === 0) z++; } });
    return `${z}/${tot}`;
  };
  const S1 = new Map<string, Stat>();
  console.log("\n=== D1 데이터 가용성 분해 (분기 리밸, 같은 비용, 동일가중) ===");
  for (const [wl, win] of WINS) {
    console.log(`\n[${wl}]\n| 전략 | CAGR % | MDD % | 샤프 | 평균 보유 종목 | 선정 0개 신호일 수 / 신호일 수 |\n|---|---|---|---|---|---|`);
    for (const k of KINDS) { const s = st(O[k], win); S1.set(`${wl}|${k}`, s); console.log(`| ${KDESC[k]} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${f2(s.avgN)} | ${zeroCount(k, win)} |`); }
    const m = S1.get(`${wl}|M3`)!;
    for (const [lab, ref] of [["M3 − VOLH_SOPA", "VOLH_SOPA"], ["M3 − SEW_SOP", "SEW_SOP"]] as const) {
      const r = S1.get(`${wl}|${ref}`)!;
      console.log(`| ${lab} | ${f2(m.cagr - r.cagr)} | ${f2(m.mdd - r.mdd)} | ${f2(m.sharpe - r.sharpe)} | ${f2(m.avgN - r.avgN)} | |`);
    }
  }
  const rep = (k: DKind, win: Win): string => f2(S1.get(`${win === LEARN ? WINS[0][0] : win === CONFIRM ? WINS[1][0] : WINS[2][0]}|${k}`)!.cagr);
  console.log(`\n재현 확인(3a41f17d 보고: M3 18.91/17.94/3.30, SEW 2.04/3.01/-8.61): 이번 M3 ${rep("M3", LEARN)}/${rep("M3", CONFIRM)}/${rep("M3", HOLD)}, SEW ${rep("SEW", LEARN)}/${rep("SEW", CONFIRM)}/${rep("SEW", HOLD)}`);

  // ---- D2: R1~R3 (참고용) ----
  const fullM = st(O.M3, FULL), fullW = st(O.SEW, FULL), thr = fullW.cagr + LV_R_CAGR_MARGIN_PP;
  console.log(`\n=== D2 R1~R3 (참고용; 전 기간 ${FULL.from}~${dataEnd}; M3 CAGR ${f2(fullM.cagr)}, SEW CAGR ${f2(fullW.cagr)}, 기준 ${f2(thr)}) ===`);
  const r1: { label: string; cagr: number; ok: boolean }[] = [];
  for (const n of LV_R1_VOL_DAYS) { const s = st(run(targetsOf("M3", quarterSignals, n), quarterSignals, false, "9999-12-31"), FULL); r1.push({ label: `VOL 창 ${n}일`, cagr: s.cagr, ok: s.cagr >= thr }); }
  { const s = st(run(targetsOf("M3", monthlySignals, LV_VOL_DAYS), monthlySignals, false, "9999-12-31"), FULL); r1.push({ label: "매월 리밸런싱", cagr: s.cagr, ok: s.cagr >= thr }); }
  console.log("R1 (참고용)\n| 조합 | 전 기간 CAGR % | O/X |\n|---|---|---|");
  for (const x of r1) console.log(`| ${x.label} | ${f2(x.cagr)} | ${ox(x.ok)} |`);
  const qk = (d: string): string => `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
  const qm = new Map<string, { s: number[]; w: number[]; idx: number[] }>();
  O.M3.dates.forEach((d, i) => { if (d < FULL.from || d <= firstExec) return; const k = qk(d); const e = qm.get(k) ?? { s: [], w: [], idx: [] }; e.s.push(O.M3.ret[i]); e.w.push(O.SEW.ret[i]); e.idx.push(i); qm.set(k, e); });
  let best = { q: "", ex: -Infinity };
  for (const [k, e] of qm) { const ex = computeCumulativeAndMdd(e.s).totalReturnPct - computeCumulativeAndMdd(e.w).totalReturnPct; if (ex > best.ex) best = { q: k, ex }; }
  const repl = [...O.M3.ret];
  for (const i of qm.get(best.q)!.idx) repl[i] = O.SEW.ret[i];
  const r2s = st(O.M3, FULL, repl);
  console.log(`R2 (참고용): SEW 대비 분기 초과 수익 최대 ${best.q} (${f2(best.ex)}%p)를 SEW 수익으로 바꾼 전 기간 CAGR ${f2(r2s.cagr)} vs 기준 ${f2(thr)} → ${ox(r2s.cagr >= thr)}`);
  const randomRuns = (label: string, poolOf: (k: number) => S[]): void => {
    const rng = mulberry32(LV_R3_SEED);
    let ge = 0, smaller = 0, empty = 0;
    quarterSignals.forEach((_, k) => { const p = poolOf(k).length; if (p < T.M3[k].n) smaller++; if (p === 0) empty++; });
    const draws: number[] = [];
    for (let n = 0; n < LV_R3_DRAWS; n++) {
      const tg: Target[] = quarterSignals.map((_, k) => {
        const a = [...poolOf(k)], cnt = Math.min(T.M3[k].n, a.length);
        for (let i = 0; i < cnt; i++) { const j = i + Math.floor(rng() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; }
        const w = new Map<string, number>();
        for (let i = 0; i < cnt; i++) w.set(a[i].code, 1 / cnt);
        return { w, tv: [], fallback: false, n: cnt, lag: [], sel: [] };
      });
      const c = st(run(tg, quarterSignals, false, "9999-12-31"), FULL).cagr;
      draws.push(c);
      if (c >= fullM.cagr) ge++;
    }
    draws.sort((a, b) => a - b);
    const p = ge / LV_R3_DRAWS;
    console.log(`R3${label} (참고용): 모집단이 M3 보유 수보다 작은 신호일 ${smaller}/${quarterSignals.length}(그중 0개 ${empty}); 무작위 ${LV_R3_DRAWS}회 전 기간 CAGR 중앙값 ${f2(draws[Math.floor(draws.length / 2)])}, 95분위 ${f2(draws[Math.floor(draws.length * 0.95)])}, 최대 ${f2(draws[draws.length - 1])}; M3 ${f2(fullM.cagr)} 이상인 횟수 ${ge} (${f2(p * 100)}%) → ${ox(p <= LV_R3_TOP_FRACTION)} (기준 상위 ${LV_R3_TOP_FRACTION * 100}% 이내)`);
  };
  const smallMembers = quarterSignals.map((d) => smallAt(d));
  randomRuns("(a) SMALL 전체", (k) => smallMembers[k]);
  randomRuns("(b) VOLH_SOPA 안", (k) => T.VOLH_SOPA[k].sel);

  // ---- D3: 069500 조합 ----
  console.log("\n=== D3 조합 (분기 리밸, 슬리브 비용 반영) ===");
  const bhMap = new Map(bh.dates.map((d, i) => [d, bh.ret[i]]));
  const etfRate = ETF_FEE_RATE + ETF_SLIPPAGE_RATE;
  const rebalDays = new Set<string>();
  for (const d of quarterSignals) { const j = calIdx.get(d)! + 1; if (j < nCal && CAL[j] > firstExec) rebalDays.add(CAL[j]); }
  function combo(wm: number, strat: Out): { dates: string[]; ret: number[] } {
    let a = 1 - wm, b = wm, prevV = 1;
    const dates: string[] = [], ret: number[] = [];
    strat.dates.forEach((d, i) => {
      if (i === 0) { dates.push(d); ret.push(0); return; }
      a *= 1 + (bhMap.get(d) ?? 0) / 100; b *= 1 + strat.ret[i] / 100;
      if (rebalDays.has(d)) {
        const V = a + b, D = Math.abs(b - wm * V);
        const cost = D * (etfRate + (b > wm * V ? sellRate(d) : buyRate));
        const V2 = V - cost;
        a = (1 - wm) * V2; b = wm * V2;
      }
      const V = a + b;
      dates.push(d); ret.push((V / prevV - 1) * 100);
      prevV = V;
    });
    return { dates, ret };
  }
  const combos: [string, { dates: string[]; ret: number[] }][] = [
    [`069500 ${(1 - DIAG_COMBO_WEIGHTS.half) * 100}% + M3 ${DIAG_COMBO_WEIGHTS.half * 100}%`, combo(DIAG_COMBO_WEIGHTS.half, O.M3)],
    [`069500 ${(1 - DIAG_COMBO_WEIGHTS.third) * 100}% + M3 ${DIAG_COMBO_WEIGHTS.third * 100}%`, combo(DIAG_COMBO_WEIGHTS.third, O.M3)],
    [`069500 ${(1 - DIAG_COMBO_WEIGHTS.half) * 100}% + SEW ${DIAG_COMBO_WEIGHTS.half * 100}%`, combo(DIAG_COMBO_WEIGHTS.half, O.SEW)],
  ];
  for (const [wl, win] of WINS) {
    const b = st(bh, win);
    console.log(`\n[${wl}]\n| 구성 | CAGR % | MDD % | 샤프 | CAGR − B&H (%p) | MDD − B&H (%p) | 샤프 − B&H |\n|---|---|---|---|---|---|---|`);
    console.log(`| B&H(069500) | ${f2(b.cagr)} | ${f2(b.mdd)} | ${f2(b.sharpe)} | | | |`);
    for (const [lab, c] of combos) { const s = st(c, win); console.log(`| ${lab} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${f2(s.cagr - b.cagr)} | ${f2(s.mdd - b.mdd)} | ${f2(s.sharpe - b.sharpe)} |`); }
  }

  // ---- D4: 연도별 ----
  console.log("\n=== D4 연도별 (M3) ===\n| 연도(체결일 기준) | 분기 신호 수 | SOP 대체(M1 선정) 분기 수 | 시차 표본 수 | SOP 공시 시차 중앙값(일) | 폐지 청산 건수 |\n|---|---|---|---|---|---|");
  const med = (v: number[]): number => { const s = [...v].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  let totSig = 0, totFb = 0, totLiq = 0; const allLag: number[] = [];
  for (let y = 2010; y <= Number(dataEnd.slice(0, 4)); y++) {
    let sig = 0, fb = 0; const lag: number[] = [];
    quarterSignals.forEach((d, i) => { const j = calIdx.get(d)! + 1; if (j >= nCal) return; const e = CAL[j]; if (!e.startsWith(`${y}-`) || e <= firstExec) return; sig++; if (T.M3[i].fallback) fb++; lag.push(...T.M3[i].lag); });
    const liq = O.M3.liq.filter((d) => d.startsWith(`${y}-`) && d > firstExec).length;
    totSig += sig; totFb += fb; totLiq += liq; allLag.push(...lag);
    console.log(`| ${y} | ${sig} | ${fb} | ${lag.length} | ${f2(med(lag))} | ${liq} |`);
  }
  console.log(`| 합계 | ${totSig} | ${totFb} | ${allLag.length} | ${f2(med(allLag))} | ${totLiq} |`);

  console.log("\n=== 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

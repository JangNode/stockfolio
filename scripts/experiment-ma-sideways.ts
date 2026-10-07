/**
 * 디스포저블 실험(DB 쓰기 없음, 프로덕션 규칙 불변): ma50_200 기준에 횡보장 완화 변형 H1~H4를 하나씩만 얹어 평가한다.
 * 정의·합격 기준은 사전 고정이며 결과를 보고 바꾸지 않는다. 진입 조건은 모두 "골든크로스가 난 그날" 기준으로 판정한다
 * (기존 ADX 실험과 같은 방식).
 * 환경변수: EXP_START(기본 2010-11-01), EXP_VARIANTS(쉼표 목록, 기본 전체), EXP_END(기본 2026-10-04)
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { runBacktest, type DailyPrice, type StrategyRule, type MaCrossParams } from "@/lib/backtest";
import { computeSMA } from "@/lib/sma";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { computeMonthlyRebalanceDates, simulateUniverseMonthlyRebalance, computeIndexDailyReturnsPct } from "@/lib/benchmarkSummary";
import { accumulateStockDailyReturns, computeEqualWeightDailyReturns, computeCagrPct, computeCumulativeAndMdd, type DailyStockReturns, type StockContribution } from "@/lib/strategyBacktestSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice, computeCostAdjustedReturnPct } from "@/lib/transactionCost";
import { FALLBACK_MA_CROSS_PARAMS, PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";

// ===== 사전 고정 정의 =====
const START = process.env.EXP_START || "2010-11-01";
const END = process.env.EXP_END || "2026-10-04";
const CAP_EOK = 5000;
const ADX_PERIOD = 14;
const ADX_MIN = 20; // H4
const H1_GAP = 1.02; // H1: MA50 > MA200 × 1.02
const H2_LOOKBACK = 20; // H2: MA200이 20거래일 전보다 상승
const H3_CONFIRM_DAYS = 2; // H3: 데드크로스 2거래일 연속 확인 후 청산
const MA: [number, number] = [50, 200];
const BASE_TRADES_2016 = 3043; // 이전 실험 기준 ma50_200(2016~) 거래 수
const FULL_PERIODS = [
  { id: "full", from: START, to: END, label: `전체 ${START.slice(0, 7)}~` },
  { id: "p1", from: START, to: "2015-12-31", label: `${START.slice(0, 7)}~2015` },
  { id: "p2", from: "2016-01-01", to: "2018-12-31", label: "2016~2018" },
  { id: "p3", from: "2019-01-01", to: "2020-12-31", label: "2019~2020" },
  { id: "p4", from: "2021-01-01", to: "2022-12-31", label: "2021~2022" },
  { id: "p5", from: "2023-01-01", to: END, label: "2023~" },
];
const SUBS = FULL_PERIODS.slice(1);

interface Variant { id: string; label: string; h1: boolean; h2: boolean; h3: boolean; h4: boolean; }
const VARIANTS: Variant[] = [
  { id: "base", label: "기준 ma50_200", h1: false, h2: false, h3: false, h4: false },
  { id: "H1", label: "H1 MA50>MA200×1.02", h1: true, h2: false, h3: false, h4: false },
  { id: "H2", label: "H2 MA200 20일 전보다 상승", h1: false, h2: true, h3: false, h4: false },
  { id: "H3", label: "H3 데드크로스 2일 연속 확인", h1: false, h2: false, h3: true, h4: false },
  { id: "H4", label: "H4 ADX(14)≥20", h1: false, h2: false, h3: false, h4: true },
];

interface StockCtx { code: string; rows: StockDailyPriceRow[]; prices: DailyPrice[]; avgTv: Float64Array; adx: Float64Array; sma50: (number | undefined)[]; sma200: (number | undefined)[]; }
interface Trade { eb: number; xb: number; }
const f1 = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : "-");

function toDailyPrice(r: StockDailyPriceRow): DailyPrice {
  return { date: r.tradeDate, open: r.openPrice, high: r.highPrice, low: r.lowPrice, close: r.closePrice, volume: r.volume, marketCapEok: r.marketCapEok, listedShares: r.listedShares };
}

/** Wilder ADX. 고가·저가가 없으면(<=0) 종가로 대체. */
function computeAdx(rows: StockDailyPriceRow[]): Float64Array {
  const n = rows.length, p = ADX_PERIOD;
  const adx = new Float64Array(n).fill(NaN);
  const hi = (i: number) => (rows[i].highPrice > 0 ? rows[i].highPrice : rows[i].closePrice);
  const lo = (i: number) => (rows[i].lowPrice > 0 ? rows[i].lowPrice : rows[i].closePrice);
  if (n < 2 * p + 1) return adx;
  const tr = new Float64Array(n), pdm = new Float64Array(n), mdm = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const up = hi(i) - hi(i - 1), down = lo(i - 1) - lo(i);
    pdm[i] = up > down && up > 0 ? up : 0;
    mdm[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(hi(i) - lo(i), Math.abs(hi(i) - rows[i - 1].closePrice), Math.abs(lo(i) - rows[i - 1].closePrice));
  }
  let sTr = 0, sP = 0, sM = 0;
  for (let i = 1; i <= p; i++) { sTr += tr[i]; sP += pdm[i]; sM += mdm[i]; }
  const dx = new Float64Array(n).fill(NaN);
  const calcDx = (i: number) => {
    const pdi = sTr > 0 ? (100 * sP) / sTr : 0, mdi = sTr > 0 ? (100 * sM) / sTr : 0;
    dx[i] = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
  };
  calcDx(p);
  for (let i = p + 1; i < n; i++) { sTr = sTr - sTr / p + tr[i]; sP = sP - sP / p + pdm[i]; sM = sM - sM / p + mdm[i]; calcDx(i); }
  let a = 0;
  for (let i = p; i < 2 * p; i++) a += dx[i];
  a /= p;
  adx[2 * p - 1] = a;
  for (let i = 2 * p; i < n; i++) { a = (a * (p - 1) + dx[i]) / p; adx[i] = a; }
  return adx;
}

function simulate(ctx: StockCtx, states: (boolean | undefined)[], v: Variant): Trade[] {
  const n = ctx.rows.length;
  const trades: Trade[] = [];
  let open = -1, deadCount = 0;
  for (let i = 1; i < n; i++) {
    const prev = states[i - 1], cur = states[i];
    if (prev === undefined || cur === undefined) continue;
    if (open < 0) {
      if (!prev && cur && ctx.rows[i].tradeDate >= START && ctx.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && ctx.rows[i].marketCapEok >= CAP_EOK) {
        const s50 = ctx.sma50[i], s200 = ctx.sma200[i], s200prev = ctx.sma200[i - H2_LOOKBACK];
        if (v.h1 && !(s50 !== undefined && s200 !== undefined && s50 > s200 * H1_GAP)) continue;
        if (v.h2 && !(s200 !== undefined && s200prev !== undefined && s200 > s200prev)) continue;
        if (v.h4 && !(ctx.adx[i] >= ADX_MIN)) continue;
        open = i; deadCount = 0;
      }
    } else {
      let exit: boolean;
      if (v.h3) { deadCount = !cur ? deadCount + 1 : 0; exit = deadCount >= H3_CONFIRM_DAYS; } else exit = !cur;
      if (exit) { trades.push({ eb: open, xb: i }); open = -1; }
    }
  }
  if (open >= 0) trades.push({ eb: open, xb: n - 1 });
  return trades;
}

interface Series { dates: string[]; onPct: number[]; offPct: number[]; }
const slice = (dates: string[], pct: number[], from: string, to: string): { cagr: number; mdd: number } => {
  const sl: number[] = [];
  for (let i = 0; i < dates.length; i++) if (dates[i] >= from && dates[i] <= to) sl.push(pct[i]);
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(sl);
  return { cagr: computeCagrPct(totalReturnPct, from, to), mdd: mddPct };
};

interface Result {
  id: string; label: string;
  on: Record<string, { cagr: number; mdd: number }>; off: Record<string, number>;
  trades: Record<string, number>; hold: Record<string, number>; win: Record<string, number>; payoff: Record<string, number>;
  top5Share: number; top5Names: string; top5ExCagr: number; yearly: string;
  p1Dep: { exTop5: number; exLowConf: number; lowConfTrades: number };
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const { data: maRow } = await supabaseAdmin.from("strategies").select("rule_params").eq("rule_type", "ma_cross").eq("market", "KR").limit(1).maybeSingle();
  const maCurrent = ((maRow?.rule_params as unknown as MaCrossParams | null) ?? FALLBACK_MA_CROSS_PARAMS);
  console.log(`[설정] 기간 ${START}~${END}, 시총≥${CAP_EOK}억 PIT + 직전 ${PIT_LIQUIDITY_LOOKBACK_DAYS}거래일 평균 거래대금≥${PIT_MIN_AVG_TRADING_VALUE_WON / 1e8}억, 비용 반영(미반영 병기), 종가 체결, 종목당 단일 포지션, 현재 ma_cross ${maCurrent.short_period}/${maCurrent.long_period}`);

  const [kospi, kosdaq] = await Promise.all([getIndexPriceSeries("KOSPI", "2009-01-01", END), getIndexPriceSeries("KOSDAQ", "2009-01-01", END)]);
  console.log(`[지수 데이터] KOSPI ${kospi[0]?.tradeDate}~${kospi[kospi.length - 1]?.tradeDate} (${kospi.length}행), KOSDAQ ${kosdaq[0]?.tradeDate}~${kosdaq[kosdaq.length - 1]?.tradeDate} (${kosdaq.length}행)`);
  const calendar = kospi.map((p) => p.tradeDate).filter((d) => d >= START && d <= END).sort();
  const calIndex = new Map(calendar.map((d, i) => [d, i]));
  const rebalanceDates = computeMonthlyRebalanceDates(calendar);

  const adjustments = await loadAppliedAdjustments();
  const seriesByCode = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear(), adjustments);
  console.log(`전 종목 ${seriesByCode.size}개 로드(조정 적용 ${adjustments.size}종목), ${((Date.now() - t0) / 1000).toFixed(0)}초`);

  // 2010~2014 low_confidence 이벤트가 있는 종목(점검용)
  const { data: lcRows } = await supabaseAdmin.from("stock_price_adjustment_events").select("stock_code").eq("status", "low_confidence").gte("event_date", "2010-01-01").lt("event_date", "2016-01-01").range(0, 4999);
  const lowConfCodes = new Set((lcRows ?? []).map((r) => r.stock_code as string));
  console.log(`2010~2015 low_confidence 이벤트 종목 ${lowConfCodes.size}개`);

  const pricesByStock = new Map<string, { date: string; close: number }[]>();
  const liq = new Map<string, Map<string, number>>();
  const ctxs: StockCtx[] = [];
  for (const [code, rows0] of seriesByCode) {
    const rows = rows0.filter((r) => r.tradeDate <= END);
    if (rows.length === 0) continue;
    const avgTv = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
    const idx = new Map(rows.map((r, i) => [r.tradeDate, i]));
    const m = new Map<string, number>();
    for (const d of rebalanceDates) { const i = idx.get(d); if (i !== undefined && Number.isFinite(avgTv[i]) && rows[i].marketCapEok >= CAP_EOK) m.set(d, avgTv[i]); }
    liq.set(code, m);
    pricesByStock.set(code, rows.map((r) => ({ date: r.tradeDate, close: r.closePrice })));
    let ever = false;
    for (let i = 0; i < rows.length && !ever; i++) ever = rows[i].tradeDate >= START && avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && rows[i].marketCapEok >= CAP_EOK;
    if (!ever) continue;
    const closes = rows.map((r) => r.closePrice);
    ctxs.push({ code, rows, prices: rows.map(toDailyPrice), avgTv, adx: computeAdx(rows), sma50: computeSMA(closes, MA[0]), sma200: computeSMA(closes, MA[1]) });
  }
  console.log(`시뮬레이션 대상 ${ctxs.length}종목`);

  // ===== 벤치마크 =====
  const bench = simulateUniverseMonthlyRebalance(pricesByStock, calendar, START, (c, d) => (liq.get(c)?.get(d) ?? NaN) >= PIT_MIN_AVG_TRADING_VALUE_WON, true);
  const kospiPct = computeIndexDailyReturnsPct(kospi.filter((p) => p.tradeDate >= START && p.tradeDate <= END));
  const kospiDates = kospi.filter((p) => p.tradeDate >= START && p.tradeDate <= END).map((p) => p.tradeDate);
  const kosdaqPct = computeIndexDailyReturnsPct(kosdaq.filter((p) => p.tradeDate >= START && p.tradeDate <= END));
  const kosdaqDates = kosdaq.filter((p) => p.tradeDate >= START && p.tradeDate <= END).map((p) => p.tradeDate);
  const bU: Record<string, { cagr: number; mdd: number }> = {}, bK: Record<string, number> = {}, bQ: Record<string, number> = {};
  for (const p of FULL_PERIODS) {
    bU[p.id] = slice(calendar, bench, p.from, p.to);
    bK[p.id] = slice(kospiDates, kospiPct, p.from, p.to).cagr;
    bQ[p.id] = slice(kosdaqDates, kosdaqPct, p.from, p.to).cagr;
  }
  console.log(`\n[벤치마크 CAGR %] ${FULL_PERIODS.map((p) => `${p.label}: 유니버스 ${f1(bU[p.id].cagr)}(MDD ${f1(bU[p.id].mdd)}) / KOSPI ${f1(bK[p.id])} / KOSDAQ ${f1(bQ[p.id])}`).join(" | ")}`);

  // ===== 변형 시뮬레이션(ma50_200) =====
  const wanted = (process.env.EXP_VARIANTS || "").split(",").filter(Boolean);
  const variants = VARIANTS.filter((v) => wanted.length === 0 || wanted.includes(v.id));
  // computeMaCrossStates(lib/backtest.ts)와 같은 정의: 단기 SMA > 장기 SMA(둘 다 계산 가능할 때만).
  const statesOf = (ctx: StockCtx): (boolean | undefined)[] => ctx.sma50.map((s, i) => { const l = ctx.sma200[i]; return s === undefined || l === undefined ? undefined : s > l; });

  interface TradeRec { code: string; ed: string; xd: string; hold: number; ret: number; }
  const evalFromTrades = (id: string, label: string, tradesByStock: Map<string, Trade[]>): Result => {
    const sumOn = new Float64Array(calendar.length), cntOn = new Int32Array(calendar.length), sumOff = new Float64Array(calendar.length), cntOff = new Int32Array(calendar.length);
    const recs: TradeRec[] = [];
    const contrib = new Map<string, number>();
    for (const ctx of ctxs) {
      const trades = tradesByStock.get(ctx.code) ?? [];
      for (const t of trades) {
        const px = ctx.prices;
        recs.push({ code: ctx.code, ed: px[t.eb].date, xd: px[t.xb].date, hold: t.xb - t.eb, ret: computeCostAdjustedReturnPct(px[t.eb].close, px[t.xb].close, px[t.xb].date, "KR") });
        const entryPrice = px[t.eb].close;
        for (let k = t.eb + 1; k <= t.xb; k++) {
          const ci = calIndex.get(px[k].date);
          if (ci === undefined) continue;
          const raw = px[k].close / px[k - 1].close;
          let on = raw;
          if (k === t.eb + 1) on /= computeEffectiveBuyPrice(entryPrice) / entryPrice;
          if (k === t.xb) on *= computeEffectiveSellPrice(px[k].close, px[k].date, "KR") / px[k].close;
          sumOn[ci] += on - 1; cntOn[ci]++; sumOff[ci] += raw - 1; cntOff[ci]++;
        }
      }
    }
    const mk = (sum: Float64Array, cnt: Int32Array) => { const d: string[] = [], p: number[] = []; for (let i = 0; i < calendar.length; i++) if (cnt[i] > 0) { d.push(calendar[i]); p.push((sum[i] / cnt[i]) * 100); } return { d, p }; };
    const on = mk(sumOn, cntOn), off = mk(sumOff, cntOff);
    const res: Result = { id, label, on: {}, off: {}, trades: {}, hold: {}, win: {}, payoff: {}, top5Share: NaN, top5Names: "", top5ExCagr: NaN, yearly: "", p1Dep: { exTop5: NaN, exLowConf: NaN, lowConfTrades: 0 } };
    for (const p of FULL_PERIODS) {
      res.on[p.id] = slice(on.d, on.p, p.from, p.to);
      res.off[p.id] = slice(off.d, off.p, p.from, p.to).cagr;
      const rs = recs.filter((r) => r.ed >= p.from && r.ed <= p.to);
      res.trades[p.id] = rs.length;
      res.hold[p.id] = rs.length ? rs.reduce((s, r) => s + r.hold, 0) / rs.length : 0;
      const wins = rs.filter((r) => r.ret > 0), losses = rs.filter((r) => r.ret < 0);
      res.win[p.id] = rs.length ? wins.length / rs.length : 0;
      const aw = wins.length ? wins.reduce((s, r) => s + r.ret, 0) / wins.length : 0;
      const al = losses.length ? Math.abs(losses.reduce((s, r) => s + r.ret, 0) / losses.length) : 0;
      res.payoff[p.id] = al > 0 ? aw / al : NaN;
    }
    const yearly = new Map<number, number>();
    for (const r of recs) yearly.set(Number(r.ed.slice(0, 4)), (yearly.get(Number(r.ed.slice(0, 4))) ?? 0) + 1);
    res.yearly = Array.from(yearly.entries()).sort((a, b) => a[0] - b[0]).map(([y, c]) => `${y}:${c}`).join(" ");
    // 상위 5종목 기여(전체 기간, 비용 반영) — 날짜별 동일가중 평균 기여의 합
    for (const ctx of ctxs) {
      let c = 0;
      for (const t of tradesByStock.get(ctx.code) ?? []) {
        const px = ctx.prices; const entryPrice = px[t.eb].close;
        for (let k = t.eb + 1; k <= t.xb; k++) {
          const ci = calIndex.get(px[k].date);
          if (ci === undefined || cntOn[ci] === 0) continue;
          let mult = px[k].close / px[k - 1].close;
          if (k === t.eb + 1) mult /= computeEffectiveBuyPrice(entryPrice) / entryPrice;
          if (k === t.xb) mult *= computeEffectiveSellPrice(px[k].close, px[k].date, "KR") / px[k].close;
          c += ((mult - 1) * 100) / cntOn[ci];
        }
      }
      contrib.set(ctx.code, c);
    }
    const sorted = Array.from(contrib.entries()).sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((s, [, c]) => s + c, 0);
    const top = sorted.slice(0, 5);
    res.top5Share = total > 0 ? top.reduce((s, [, c]) => s + c, 0) / total : NaN;
    res.top5Names = top.map(([code, c]) => `${code}(${f1(c)})`).join(", ");
    const rerun = (exclude: Set<string>, from: string, to: string): number => {
      const s = new Float64Array(calendar.length), c = new Int32Array(calendar.length);
      for (const ctx of ctxs) {
        if (exclude.has(ctx.code)) continue;
        for (const t of tradesByStock.get(ctx.code) ?? []) {
          const px = ctx.prices; const entryPrice = px[t.eb].close;
          for (let k = t.eb + 1; k <= t.xb; k++) {
            const ci = calIndex.get(px[k].date); if (ci === undefined) continue;
            let mult = px[k].close / px[k - 1].close;
            if (k === t.eb + 1) mult /= computeEffectiveBuyPrice(entryPrice) / entryPrice;
            if (k === t.xb) mult *= computeEffectiveSellPrice(px[k].close, px[k].date, "KR") / px[k].close;
            s[ci] += mult - 1; c[ci]++;
          }
        }
      }
      const d: string[] = [], p: number[] = [];
      for (let i = 0; i < calendar.length; i++) if (c[i] > 0) { d.push(calendar[i]); p.push((s[i] / c[i]) * 100); }
      return slice(d, p, from, to).cagr;
    };
    res.top5ExCagr = rerun(new Set(top.map(([c]) => c)), START, END);
    // 첫 구간(2010-11~2015) 의존도: 그 구간 상위 5종목 제외, low_confidence 이벤트 종목 제외
    const p1 = FULL_PERIODS[1];
    const p1c = new Map<string, number>();
    for (const r of recs.filter((x) => x.ed >= p1.from && x.ed <= p1.to)) p1c.set(r.code, (p1c.get(r.code) ?? 0) + r.ret);
    const p1top = new Set(Array.from(p1c.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c]) => c));
    res.p1Dep = {
      exTop5: rerun(p1top, p1.from, p1.to),
      exLowConf: rerun(lowConfCodes, p1.from, p1.to),
      lowConfTrades: recs.filter((r) => r.ed >= p1.from && r.ed <= p1.to && lowConfCodes.has(r.code)).length,
    };
    return res;
  };

  const results: Result[] = [];
  for (const v of variants) {
    const tbs = new Map<string, Trade[]>();
    for (const ctx of ctxs) tbs.set(ctx.code, simulate(ctx, statesOf(ctx), v));
    results.push(evalFromTrades(v.id, v.label, tbs));
    console.log(`  ${v.id} 완료 ${((Date.now() - t0) / 1000).toFixed(0)}초`);
  }

  // ===== 비교용: 현재 ma_cross(5/20), 급등주 v2(현재 규칙) — 배치와 같은 runBacktest 경로 =====
  const compare: { id: string; label: string; rule: StrategyRule }[] = [
    { id: "ma5_20", label: `현재 ma_cross ${maCurrent.short_period}/${maCurrent.long_period}`, rule: { rule_type: "ma_cross", rule_params: maCurrent } },
    { id: "v2", label: "급등주 v2(현재 규칙)", rule: { rule_type: "reversal_breakout_v2", rule_params: {} } },
  ];
  const wantCompare = (process.env.EXP_COMPARE ?? "1") === "1";
  if (wantCompare) for (const c of compare) {
    const tbs = new Map<string, Trade[]>();
    for (const ctx of ctxs) {
      const idxByDate = new Map(ctx.rows.map((r, i) => [r.tradeDate, i]));
      const entryAllowed = (date: string): boolean => { const i = idxByDate.get(date); return i !== undefined && ctx.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && ctx.rows[i].marketCapEok >= CAP_EOK; };
      const r = runBacktest(ctx.prices, c.rule, START, undefined, undefined, { market: "KR", entryAllowed, includeTransactionCosts: true });
      if (r.insufficientData || r.trades.length === 0) continue;
      const idx = new Map(ctx.prices.map((p, i) => [p.date, i]));
      tbs.set(ctx.code, r.trades.map((t) => ({ eb: idx.get(t.buyDate)!, xb: idx.get(t.sellDate)! })));
    }
    results.push(evalFromTrades(c.id, c.label, tbs));
    console.log(`  ${c.id} 완료 ${((Date.now() - t0) / 1000).toFixed(0)}초`);
  }

  // ===== 출력 =====
  const baseR = results.find((r) => r.id === "base");
  console.log("\n===== 결과 =====");
  for (const r of results) {
    console.log(`\n## ${r.id} ${r.label}`);
    for (const p of FULL_PERIODS) console.log(`  ${p.label.padEnd(14)} 비용반영 CAGR ${f1(r.on[p.id].cagr)} / 미반영 ${f1(r.off[p.id])} / MDD ${f1(r.on[p.id].mdd)} / ${r.trades[p.id]}건 / 보유 ${r.hold[p.id].toFixed(0)}일 / 승률 ${(r.win[p.id] * 100).toFixed(1)}% / 손익비 ${f1(r.payoff[p.id])}${bU[p.id] ? ` | 벤치 유니버스 ${f1(bU[p.id].cagr)} KOSPI ${f1(bK[p.id])} KOSDAQ ${f1(bQ[p.id])}` : ""}`);
    console.log(`  상위5 기여 ${f1(r.top5Share * 100)}% [${r.top5Names}] 상위5 제외 전체 CAGR ${f1(r.top5ExCagr)}`);
    console.log(`  초기구간 의존도: 구간 상위5 제외 CAGR ${f1(r.p1Dep.exTop5)} / low_confidence 종목 제외 CAGR ${f1(r.p1Dep.exLowConf)} (해당 종목 거래 ${r.p1Dep.lowConfTrades}건) | 연도별 거래 ${r.yearly}`);
  }
  // 판정(사전 고정): 기준 ma50_200 대비
  if (baseR) {
    console.log("\n===== 판정(합격: 전체 CAGR≥기준, MDD≤기준, 하위 5구간 중 4개 이상 벤치마크(유니버스) 이상, 거래≥기준의 40%) =====");
    let pass = 0;
    for (const r of results.filter((x) => ["H1", "H2", "H3", "H4"].includes(x.id))) {
      const bad: string[] = [];
      if (!(r.on.full.cagr >= baseR.on.full.cagr)) bad.push(`CAGR ${f1(r.on.full.cagr)}<${f1(baseR.on.full.cagr)}`);
      if (!(r.on.full.mdd <= baseR.on.full.mdd)) bad.push(`MDD ${f1(r.on.full.mdd)}>${f1(baseR.on.full.mdd)}`);
      const subPass = SUBS.filter((s) => r.on[s.id].cagr >= bU[s.id].cagr).length;
      if (subPass < 4) bad.push(`하위 ${subPass}/5`);
      if (!(r.trades.full >= baseR.trades.full * 0.4)) bad.push(`거래 ${r.trades.full}<${(baseR.trades.full * 0.4).toFixed(0)}`);
      if (bad.length === 0) pass++;
      console.log(`  ${r.id}: ${bad.length === 0 ? "합격" : `불합격(${bad.join(", ")})`} | 하위 통과 ${subPass}/5`);
    }
    console.log(`  기준 하위 통과: ${SUBS.filter((s) => baseR.on[s.id].cagr >= bU[s.id].cagr).length}/5 | 합격 변형 ${pass}/4`);
  }
  console.log(`\n[참고] 2016~ 거래 수 기준 이전 실험 ma50_200: ${BASE_TRADES_2016}건`);
  console.log(`실행 시간 ${((Date.now() - t0) / 1000).toFixed(0)}초, 최대 메모리 ${(process.resourceUsage().maxRSS / 1024).toFixed(0)}MB`);
}

main().catch((e) => { console.error(e); process.exit(1); });

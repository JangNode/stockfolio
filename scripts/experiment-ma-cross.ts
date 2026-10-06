/**
 * 디스포저블 실험(DB 쓰기 없음, 프로덕션 규칙 불변): ma_cross 개선 변형을 시총 5천억 PIT 유니버스에서 평가한다.
 * 사전 고정 정의·합격 기준은 아래 상수에 있고 결과를 보고 바꾸지 않는다. 변형 선택(조합)은 학습 구간 수치만 쓴다.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { computeRuleStates, type DailyPrice, type StrategyRule, type MaCrossParams } from "@/lib/backtest";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { computeMonthlyRebalanceDates, simulateUniverseMonthlyRebalance } from "@/lib/benchmarkSummary";
import { computeCagrPct, computeCumulativeAndMdd } from "@/lib/strategyBacktestSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice, computeCostAdjustedReturnPct } from "@/lib/transactionCost";
import { FALLBACK_MA_CROSS_PARAMS, PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON, STRATEGY_BACKTEST_WINDOW_START_YEAR } from "@/lib/strategyBacktestSummaryConfig";

// ===== 사전 고정 정의 =====
const START = `${STRATEGY_BACKTEST_WINDOW_START_YEAR}-01-01`;
const END = "2026-10-04"; // 배치(DB) 기준일과 맞춘다
const CAP_EOK = 5000;
const PERIODS = {
  train: { from: START, to: "2022-12-31", label: "학습 2016~2022" },
  valid: { from: "2023-01-01", to: END, label: "검증 2023~" },
  full: { from: START, to: END, label: "전 기간" },
};
const SUBS = [
  { from: START, to: "2018-12-31", label: "2016~2018" },
  { from: "2019-01-01", to: "2020-12-31", label: "2019~2020" },
  { from: "2021-01-01", to: "2022-12-31", label: "2021~2022" },
  { from: "2023-01-01", to: END, label: "2023~" },
];
const ADX_PERIOD = 14;
const ATR_PERIOD = 14;
const ATR_MULT = 3; // 최고 종가 대비 ATR×3 트레일링 스탑(종가 기준 판정, 기존 데드크로스 청산에 추가)
const FIXED_STOP = 0.07; // 진입 종가 대비 -7% 고정 손절(종가 기준 판정, 기존 데드크로스 청산에 추가)
// 합격 기준
const CURRENT = { trades: 31948, mddPct: 58.28 };
const MAX_TRADES = CURRENT.trades / 2;
const MIN_SUBS_PASS = 3;

type Cat = "ADX" | "MA" | "EXIT";
interface Variant { id: string; label: string; cat: Cat[]; adx: number; ma: [number, number] | null; exit: "dead" | "atr" | "stop7"; }

const SINGLES: Variant[] = [
  { id: "adx20", label: "ADX≥20", cat: ["ADX"], adx: 20, ma: null, exit: "dead" },
  { id: "adx25", label: "ADX≥25", cat: ["ADX"], adx: 25, ma: null, exit: "dead" },
  { id: "ma20_60", label: "이평 20/60", cat: ["MA"], adx: 0, ma: [20, 60], exit: "dead" },
  { id: "ma50_200", label: "이평 50/200", cat: ["MA"], adx: 0, ma: [50, 200], exit: "dead" },
  { id: "atr3", label: "ATR3 트레일링", cat: ["EXIT"], adx: 0, ma: null, exit: "atr" },
  { id: "stop7", label: "고정손절-7%", cat: ["EXIT"], adx: 0, ma: null, exit: "stop7" },
];
const BASE: Variant = { id: "base", label: "현재", cat: [], adx: 0, ma: null, exit: "dead" };

interface StockCtx { code: string; rows: StockDailyPriceRow[]; prices: DailyPrice[]; avgTv: Float64Array; adx: Float64Array; atr: Float64Array; }
interface Trade { eb: number; xb: number; }

function toDailyPrice(r: StockDailyPriceRow): DailyPrice {
  return { date: r.tradeDate, open: r.openPrice, high: r.highPrice, low: r.lowPrice, close: r.closePrice, volume: r.volume, marketCapEok: r.marketCapEok, listedShares: r.listedShares };
}

/** Wilder ATR/ADX. 고가·저가가 없으면(<=0) 종가로 대체. */
function computeAdxAtr(rows: StockDailyPriceRow[]): { adx: Float64Array; atr: Float64Array } {
  const n = rows.length;
  const adx = new Float64Array(n).fill(NaN);
  const atr = new Float64Array(n).fill(NaN);
  const hi = (i: number) => (rows[i].highPrice > 0 ? rows[i].highPrice : rows[i].closePrice);
  const lo = (i: number) => (rows[i].lowPrice > 0 ? rows[i].lowPrice : rows[i].closePrice);
  const p = ADX_PERIOD;
  if (n < 2 * p + 1) return { adx, atr };
  const tr = new Float64Array(n), pdm = new Float64Array(n), mdm = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const up = hi(i) - hi(i - 1);
    const down = lo(i - 1) - lo(i);
    pdm[i] = up > down && up > 0 ? up : 0;
    mdm[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(hi(i) - lo(i), Math.abs(hi(i) - rows[i - 1].closePrice), Math.abs(lo(i) - rows[i - 1].closePrice));
  }
  let sTr = 0, sP = 0, sM = 0;
  for (let i = 1; i <= p; i++) { sTr += tr[i]; sP += pdm[i]; sM += mdm[i]; }
  atr[p] = sTr / p;
  const dx = new Float64Array(n).fill(NaN);
  const calcDx = (i: number) => {
    const pdi = sTr > 0 ? (100 * sP) / sTr : 0;
    const mdi = sTr > 0 ? (100 * sM) / sTr : 0;
    dx[i] = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
  };
  calcDx(p);
  for (let i = p + 1; i < n; i++) {
    sTr = sTr - sTr / p + tr[i];
    sP = sP - sP / p + pdm[i];
    sM = sM - sM / p + mdm[i];
    atr[i] = sTr / p;
    calcDx(i);
  }
  let a = 0;
  for (let i = p; i < 2 * p; i++) a += dx[i];
  a /= p;
  adx[2 * p - 1] = a;
  for (let i = 2 * p; i < n; i++) {
    a = (a * (p - 1) + dx[i]) / p;
    adx[i] = a;
  }
  return { adx, atr };
}

async function loadActiveMaParams(): Promise<MaCrossParams> {
  const { data } = await supabaseAdmin.from("strategies").select("rule_params").eq("rule_type", "ma_cross").eq("market", "KR").limit(1).maybeSingle();
  return ((data?.rule_params as unknown as MaCrossParams | null) ?? FALLBACK_MA_CROSS_PARAMS);
}

function simulate(ctx: StockCtx, states: (boolean | undefined)[], v: Variant): Trade[] {
  const n = ctx.rows.length;
  const trades: Trade[] = [];
  let open = -1;
  let maxClose = 0;
  const closes = ctx.prices;
  for (let i = 1; i < n; i++) {
    const prev = states[i - 1];
    const cur = states[i];
    if (prev === undefined || cur === undefined) continue;
    if (open < 0) {
      if (!prev && cur && ctx.rows[i].tradeDate >= START && ctx.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && ctx.rows[i].marketCapEok >= CAP_EOK && (v.adx === 0 || ctx.adx[i] >= v.adx)) {
        open = i;
        maxClose = closes[i].close;
      }
    } else {
      maxClose = Math.max(maxClose, closes[i].close);
      let exit = !cur;
      if (!exit && v.exit === "atr" && Number.isFinite(ctx.atr[i]) && closes[i].close <= maxClose - ATR_MULT * ctx.atr[i]) exit = true;
      if (!exit && v.exit === "stop7" && closes[i].close <= closes[open].close * (1 - FIXED_STOP)) exit = true;
      if (exit) { trades.push({ eb: open, xb: i }); open = -1; }
    }
  }
  if (open >= 0) trades.push({ eb: open, xb: n - 1 });
  return trades;
}

function accumulate(ctx: StockCtx, trades: Trade[], calIndex: Map<string, number>, sum: Float64Array, cnt: Int32Array, withCosts: boolean): void {
  const px = ctx.prices;
  for (const t of trades) {
    const entryPrice = px[t.eb].close;
    for (let k = t.eb + 1; k <= t.xb; k++) {
      const ci = calIndex.get(px[k].date);
      if (ci === undefined) continue;
      let mult = px[k].close / px[k - 1].close;
      if (withCosts) {
        if (k === t.eb + 1) mult /= computeEffectiveBuyPrice(entryPrice) / entryPrice;
        if (k === t.xb) mult *= computeEffectiveSellPrice(px[k].close, px[k].date, "KR") / px[k].close;
      }
      sum[ci] += mult - 1;
      cnt[ci]++;
    }
  }
}

interface Acc {
  v: Variant;
  sumOn: Float64Array; cntOn: Int32Array; sumOff: Float64Array; cntOff: Int32Array;
  tradesByStock: Map<string, Trade[]>;
  rets: { date: string; ret: number; hold: number }[]; // 진입일 기준(비용 반영 거래 수익률)
  yearly: Map<number, number>;
}

const sliceMetrics = (dates: string[], pct: number[], from: string, to: string): { cagr: number; mdd: number } => {
  const sl: number[] = [];
  for (let i = 0; i < dates.length; i++) if (dates[i] >= from && dates[i] <= to) sl.push(pct[i]);
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(sl);
  return { cagr: computeCagrPct(totalReturnPct, from, to), mdd: mddPct };
};
const seriesOf = (acc: Acc, cal: string[], on: boolean): { dates: string[]; pct: number[] } => {
  const sum = on ? acc.sumOn : acc.sumOff;
  const cnt = on ? acc.cntOn : acc.cntOff;
  const dates: string[] = [], pct: number[] = [];
  for (let i = 0; i < cal.length; i++) if (cnt[i] > 0) { dates.push(cal[i]); pct.push((sum[i] / cnt[i]) * 100); }
  return { dates, pct };
};
const f1 = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : "-");

async function main(): Promise<void> {
  const t0 = Date.now();
  const maActive = await loadActiveMaParams();
  console.log(`[현재 ma_cross 규칙] 단기 SMA ${maActive.short_period}일 > 장기 SMA ${maActive.long_period}일이 되는 날(골든크로스) 종가 진입, 단기<장기가 되는 날(데드크로스) 종가 청산, 종목당 단일 포지션, 손절·익절·포지션 수 한도 없음(백테스트). 진입은 그날 시총≥${CAP_EOK}억 + 직전 ${PIT_LIQUIDITY_LOOKBACK_DAYS}거래일 평균 거래대금≥${PIT_MIN_AVG_TRADING_VALUE_WON / 1e8}억일 때만, 청산은 유니버스와 무관. 날짜별 보유 종목 동일가중 평균 수익률로 CAGR/MDD 계산. (라이브 스크리닝 추적은 별도로 기본 손절 7%/익절 20% 적용)`);
  const baseMa: [number, number] = [maActive.short_period, maActive.long_period];
  console.log(`[사전 고정] ADX/ATR 기간 ${ADX_PERIOD}/${ATR_PERIOD}, 트레일링 ATR×${ATR_MULT}(최고 종가 대비, 종가 판정, 데드크로스 청산에 추가), 고정 손절 -${FIXED_STOP * 100}%(진입 종가 대비, 종가 판정, 추가), ADX는 진입 시점에만. 합격: 학습·검증 비용반영 CAGR≥벤치마크 & 전 기간 거래≤${MAX_TRADES} & 전 기간 MDD≤${CURRENT.mddPct} & 하위 4구간 중 ${MIN_SUBS_PASS}개 이상 벤치마크 이상`);

  const kospi = await getIndexPriceSeries("KOSPI", "2014-01-01", END);
  const calendar = kospi.map((p) => p.tradeDate).filter((d) => d >= START && d <= END).sort();
  const calIndex = new Map(calendar.map((d, i) => [d, i]));
  const rebalanceDates = computeMonthlyRebalanceDates(calendar);
  const adjustments = await loadAppliedAdjustments();
  const seriesByCode = await loadAllStockSeriesFromParquet(2011, new Date().getUTCFullYear(), adjustments);
  console.log(`전 종목 ${seriesByCode.size}개 로드, ${((Date.now() - t0) / 1000).toFixed(0)}초`);

  const pricesByStock = new Map<string, { date: string; close: number }[]>();
  const liq = new Map<string, Map<string, number>>();
  const ctxs: StockCtx[] = [];
  for (const [code, rows0] of seriesByCode) {
    const rows = rows0.filter((r) => r.tradeDate <= END);
    if (rows.length === 0) continue;
    const avgTv = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
    const idx = new Map(rows.map((r, i) => [r.tradeDate, i]));
    const m = new Map<string, number>();
    for (const d of rebalanceDates) {
      const i = idx.get(d);
      if (i !== undefined && Number.isFinite(avgTv[i]) && rows[i].marketCapEok >= CAP_EOK) m.set(d, avgTv[i]);
    }
    liq.set(code, m);
    pricesByStock.set(code, rows.map((r) => ({ date: r.tradeDate, close: r.closePrice })));
    let ever = false;
    for (let i = 0; i < rows.length && !ever; i++) ever = rows[i].tradeDate >= START && avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && rows[i].marketCapEok >= CAP_EOK;
    if (!ever) continue;
    const { adx, atr } = computeAdxAtr(rows);
    ctxs.push({ code, rows, prices: rows.map(toDailyPrice), avgTv, adx, atr });
  }
  console.log(`시뮬레이션 대상 ${ctxs.length}종목`);

  const bench = simulateUniverseMonthlyRebalance(pricesByStock, calendar, START, (c, d) => (liq.get(c)?.get(d) ?? NaN) >= PIT_MIN_AVG_TRADING_VALUE_WON, true);
  const benchOf = (p: { from: string; to: string }) => sliceMetrics(calendar, bench, p.from, p.to);
  const bTrain = benchOf(PERIODS.train), bValid = benchOf(PERIODS.valid), bFull = benchOf(PERIODS.full);
  const bSubs = SUBS.map(benchOf);
  console.log(`[벤치마크 5천억 월간 리밸런싱, 비용반영] 학습 ${f1(bTrain.cagr)}/MDD ${f1(bTrain.mdd)} | 검증 ${f1(bValid.cagr)}/MDD ${f1(bValid.mdd)} | 전 기간 ${f1(bFull.cagr)}/MDD ${f1(bFull.mdd)} | 하위 ${SUBS.map((s, i) => `${s.label} ${f1(bSubs[i].cagr)}`).join(", ")}`);

  const statesCache = new Map<string, Map<string, (boolean | undefined)[]>>();
  const getStates = (ctx: StockCtx, ma: [number, number]): (boolean | undefined)[] => {
    let per = statesCache.get(ctx.code);
    if (!per) { per = new Map(); statesCache.set(ctx.code, per); }
    const key = `${ma[0]}/${ma[1]}`;
    let s = per.get(key);
    if (!s) {
      const rule: StrategyRule = { rule_type: "ma_cross", rule_params: { short_period: ma[0], long_period: ma[1] } };
      s = computeRuleStates(ctx.prices, rule);
      per.set(key, s);
    }
    return s;
  };

  const run = (variants: Variant[]): Map<string, Acc> => {
    const accs = new Map<string, Acc>();
    for (const v of variants) accs.set(v.id, { v, sumOn: new Float64Array(calendar.length), cntOn: new Int32Array(calendar.length), sumOff: new Float64Array(calendar.length), cntOff: new Int32Array(calendar.length), tradesByStock: new Map(), rets: [], yearly: new Map() });
    for (const ctx of ctxs) {
      for (const v of variants) {
        const acc = accs.get(v.id)!;
        const trades = simulate(ctx, getStates(ctx, v.ma ?? baseMa), v);
        acc.tradesByStock.set(ctx.code, trades);
        for (const t of trades) {
          const ed = ctx.rows[t.eb].tradeDate;
          const xd = ctx.rows[t.xb].tradeDate;
          acc.rets.push({ date: ed, ret: computeCostAdjustedReturnPct(ctx.prices[t.eb].close, ctx.prices[t.xb].close, xd, "KR"), hold: t.xb - t.eb });
          const y = Number(ed.slice(0, 4));
          acc.yearly.set(y, (acc.yearly.get(y) ?? 0) + 1);
        }
        accumulate(ctx, trades, calIndex, acc.sumOn, acc.cntOn, true);
        accumulate(ctx, trades, calIndex, acc.sumOff, acc.cntOff, false);
      }
    }
    return accs;
  };

  const inP = (d: string, p: { from: string; to: string }): boolean => d >= p.from && d <= p.to;
  interface Row { id: string; label: string; on: Record<string, { cagr: number; mdd: number }>; off: Record<string, number>; trades: Record<string, number>; hold: Record<string, number>; win: Record<string, number>; payoff: Record<string, number>; subsOn: number[]; subsOff: number[]; top5: { share: number; names: string; exCagr: number }; yearly: string; }
  const evaluate = (acc: Acc): Row => {
    const on = seriesOf(acc, calendar, true), off = seriesOf(acc, calendar, false);
    const row: Row = { id: acc.v.id, label: acc.v.label, on: {}, off: {}, trades: {}, hold: {}, win: {}, payoff: {}, subsOn: [], subsOff: [], top5: { share: NaN, names: "", exCagr: NaN }, yearly: "" };
    for (const [k, p] of Object.entries(PERIODS)) {
      row.on[k] = sliceMetrics(on.dates, on.pct, p.from, p.to);
      row.off[k] = sliceMetrics(off.dates, off.pct, p.from, p.to).cagr;
      const rs = acc.rets.filter((r) => inP(r.date, p));
      row.trades[k] = rs.length;
      row.hold[k] = rs.length ? rs.reduce((s, r) => s + r.hold, 0) / rs.length : 0;
      const wins = rs.filter((r) => r.ret > 0), losses = rs.filter((r) => r.ret < 0);
      row.win[k] = rs.length ? wins.length / rs.length : 0;
      const aw = wins.length ? wins.reduce((s, r) => s + r.ret, 0) / wins.length : 0;
      const al = losses.length ? Math.abs(losses.reduce((s, r) => s + r.ret, 0) / losses.length) : 0;
      row.payoff[k] = al > 0 ? aw / al : NaN;
    }
    for (const sp of SUBS) {
      row.subsOn.push(sliceMetrics(on.dates, on.pct, sp.from, sp.to).cagr);
      row.subsOff.push(sliceMetrics(off.dates, off.pct, sp.from, sp.to).cagr);
    }
    // 상위 5종목 기여(전 기간, 비용반영): 날짜별 동일가중 평균수익 기여의 합.
    const contrib = new Map<string, number>();
    for (const ctx of ctxs) {
      const trades = acc.tradesByStock.get(ctx.code) ?? [];
      let c = 0;
      for (const t of trades) {
        const entryPrice = ctx.prices[t.eb].close;
        for (let k = t.eb + 1; k <= t.xb; k++) {
          const ci = calIndex.get(ctx.prices[k].date);
          if (ci === undefined || acc.cntOn[ci] === 0) continue;
          let mult = ctx.prices[k].close / ctx.prices[k - 1].close;
          if (k === t.eb + 1) mult /= computeEffectiveBuyPrice(entryPrice) / entryPrice;
          if (k === t.xb) mult *= computeEffectiveSellPrice(ctx.prices[k].close, ctx.prices[k].date, "KR") / ctx.prices[k].close;
          c += ((mult - 1) * 100) / acc.cntOn[ci];
        }
      }
      contrib.set(ctx.code, c);
    }
    const sorted = Array.from(contrib.entries()).sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((s, [, c]) => s + c, 0);
    const top = sorted.slice(0, 5);
    row.top5.share = total > 0 ? top.reduce((s, [, c]) => s + c, 0) / total : NaN;
    row.top5.names = top.map(([code, c]) => `${code}(${f1(c)})`).join(", ");
    // 상위 5 제외 CAGR: 해당 종목의 기여를 날짜별 평균에서 뺀 근사 대신, 종목 제외 후 재집계.
    const excl = new Set(top.map(([c]) => c));
    const sum = new Float64Array(calendar.length), cnt = new Int32Array(calendar.length);
    for (const ctx of ctxs) if (!excl.has(ctx.code)) accumulate(ctx, acc.tradesByStock.get(ctx.code) ?? [], calIndex, sum, cnt, true);
    const dts: string[] = [], pc: number[] = [];
    for (let i = 0; i < calendar.length; i++) if (cnt[i] > 0) { dts.push(calendar[i]); pc.push((sum[i] / cnt[i]) * 100); }
    row.top5.exCagr = sliceMetrics(dts, pc, START, END).cagr;
    row.yearly = Array.from(acc.yearly.entries()).sort((a, b) => a[0] - b[0]).map(([y, c]) => `${y}:${c}`).join(" ");
    return row;
  };
  const verdict = (r: Row): { pass: boolean; why: string } => {
    const bad: string[] = [];
    if (!(r.on.train.cagr >= bTrain.cagr)) bad.push("학습<벤치");
    if (!(r.on.valid.cagr >= bValid.cagr)) bad.push("검증<벤치");
    if (!(r.trades.full <= MAX_TRADES)) bad.push(`거래>${MAX_TRADES}`);
    if (!(r.on.full.mdd <= CURRENT.mddPct)) bad.push("MDD악화");
    const subPass = r.subsOn.filter((c, i) => c >= bSubs[i].cagr).length;
    if (subPass < MIN_SUBS_PASS) bad.push(`하위${subPass}/4`);
    return { pass: bad.length === 0, why: bad.join(",") };
  };
  const print = (r: Row): void => {
    const v = verdict(r);
    console.log(`\n## ${r.id} ${r.label}`);
    for (const k of ["train", "valid", "full"]) console.log(`  ${k.padEnd(5)} 비용반영 CAGR ${f1(r.on[k].cagr)} / 미반영 ${f1(r.off[k])} / MDD ${f1(r.on[k].mdd)} / ${r.trades[k]}건 / 평균보유 ${r.hold[k].toFixed(0)}일 / 승률 ${(r.win[k] * 100).toFixed(1)}% / 손익비 ${f1(r.payoff[k])}`);
    console.log(`  하위구간 비용반영/미반영 CAGR: ${SUBS.map((s, i) => `${s.label} ${f1(r.subsOn[i])}/${f1(r.subsOff[i])}(벤치 ${f1(bSubs[i].cagr)})`).join(" | ")}`);
    console.log(`  상위5 기여 ${f1(r.top5.share * 100)}% [${r.top5.names}] 상위5 제외 전기간 CAGR ${f1(r.top5.exCagr)} | 연도별 거래 ${r.yearly}`);
    console.log(`  판정: ${v.pass ? "합격" : `불합격(${v.why})`}`);
  };

  // 1단계: 현재 + 단일 변형 6개
  const accs1 = run([BASE, ...SINGLES]);
  console.log(`\n1단계 시뮬레이션 완료 ${((Date.now() - t0) / 1000).toFixed(0)}초`);
  const rows1 = new Map<string, Row>();
  for (const v of [BASE, ...SINGLES]) { const r = evaluate(accs1.get(v.id)!); rows1.set(v.id, r); }
  const bR = rows1.get("base")!;
  console.log(`\n[하니스 검증] 현재 전 기간: CAGR ${bR.on.full.cagr.toFixed(3)} / MDD ${bR.on.full.mdd.toFixed(3)} / ${bR.trades.full}건 / 승률 ${(bR.win.full * 100).toFixed(2)}% / 손익비 ${f1(bR.payoff.full)} (배치 DB: CAGR -2.993 / MDD 58.2775 / 31,948건 / 승률 30.12% / 손익비 2.364)`);
  print(bR);

  // 조합 선택(학습 비용반영 CAGR만 사용): 단일 변형을 학습 CAGR 순위로 매기고, 서로 다른 범주끼리 짝지은 쌍 중 순위합이 가장 낮은 2개.
  const ranked = SINGLES.map((v) => ({ v, c: rows1.get(v.id)!.on.train.cagr })).sort((a, b) => b.c - a.c);
  console.log(`\n[조합 선택 입력: 학습 비용반영 CAGR 순위] ${ranked.map((x, i) => `${i + 1}.${x.v.id}(${f1(x.c)})`).join(" ")}`);
  const pairs: { a: Variant; b: Variant; score: number; mean: number }[] = [];
  for (let i = 0; i < ranked.length; i++) for (let j = i + 1; j < ranked.length; j++) {
    if (ranked[i].v.cat[0] === ranked[j].v.cat[0]) continue;
    pairs.push({ a: ranked[i].v, b: ranked[j].v, score: i + j, mean: (ranked[i].c + ranked[j].c) / 2 });
  }
  pairs.sort((x, y) => x.score - y.score || y.mean - x.mean);
  const combos: Variant[] = pairs.slice(0, 2).map((p) => ({
    id: `${p.a.id}+${p.b.id}`, label: `${p.a.label} + ${p.b.label}`, cat: [...p.a.cat, ...p.b.cat],
    adx: Math.max(p.a.adx, p.b.adx), ma: p.a.ma ?? p.b.ma, exit: p.a.exit !== "dead" ? p.a.exit : p.b.exit,
  }));
  console.log(`[선택된 조합] ${combos.map((c) => c.id).join(", ")}`);
  const accs2 = run(combos);
  for (const v of combos) rows1.set(v.id, evaluate(accs2.get(v.id)!));

  console.log("\n===== 결과(시총 5천억 PIT, 비용 반영 기준 판정) =====");
  for (const v of [...SINGLES, ...combos]) print(rows1.get(v.id)!);
  const passers = [...SINGLES, ...combos].filter((v) => verdict(rows1.get(v.id)!).pass).map((v) => v.id);
  console.log(`\n합격 후보: ${passers.join(", ") || "없음"}`);
  console.log(`실행 시간 ${((Date.now() - t0) / 1000).toFixed(0)}초, 최대 메모리 ${(process.resourceUsage().maxRSS / 1024).toFixed(0)}MB`);
}

main().catch((e) => { console.error(e); process.exit(1); });

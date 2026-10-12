/**
 * [임시 연구 — 병합 금지, 읽기 전용] ma_cross v3 추가 강화 후보 S1~S4 실행기.
 * 사전 등록: research/ma-v3-enhance-prereg.md (커밋 4fca8ad). 정의·임계값은 사전 등록 그대로.
 */
import { computeSMA } from "@/lib/sma";
import { computeCostAdjustedReturnPct } from "@/lib/transactionCost";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { computeCumulativeAndMdd } from "@/lib/strategyBacktestSummary";
import {
  buildCtx, genTrades, newAcc, addTrades, sliceMetrics, calmar, loadSeries,
  PERIOD_START, LEARN_END, CONFIRM_START, TODAY, type Acc, type Ctx, type Trade, type SliceMetrics,
} from "./research-ma-lab";

// 사전 등록 상수
const NEAR_HIGH_MIN_GAP = -0.1829;
const NEAR_HIGH_BARS = 252;
const ATR_PERIOD = 14;
const ATR_MULT = 3;
const SLOPE_LOOKBACK = 20;
const VOL_AVG_BARS = 20;
const VOL_MULT = 1.5;
const KOSPI_MA = 200;
const KOSPI_START = "2008-01-01";
const TRADES_MIN = 1168;
const PAYOFF_MIN = 3.43;
const SEG_MIN_EOK = 500;
const SEG_MAX_EOK = 5000;
const PRIOR_ATTEMPTS = 39;

const NAMES = ["V3(기준선)", "S1_ATR3손절", "S2_slope200>0", "S3_거래량>=1.5x", "S4_KOSPI>200MA"] as const;

// ---- KOSPI 200일선 (신호일 as-of) ----
let kDates: string[] = [];
let kAbove: (boolean | undefined)[] = [];
function kospiAboveAsOf(date: string): boolean | undefined {
  let lo = 0, hi = kDates.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (kDates[mid] <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans < 0 ? undefined : kAbove[ans];
}

// ---- ATR (Wilder, 고저가 0 이하이면 종가 대체) ----
function computeATR(ctx: Ctx, period: number): Float64Array {
  const { prices } = ctx;
  const n = prices.length;
  const atr = new Float64Array(n).fill(NaN);
  if (n <= period) return atr;
  const tr = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const c = prices[i].close, pc = prices[i - 1].close;
    const h = prices[i].high > 0 ? prices[i].high : c;
    const l = prices[i].low > 0 ? prices[i].low : c;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let s = 0;
  for (let i = 1; i <= period; i++) s += tr[i];
  atr[period] = s / period;
  for (let i = period + 1; i < n; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  return atr;
}

function nearHighOk(ctx: Ctx, e: number): boolean {
  let hi = -Infinity;
  for (let j = Math.max(0, e - (NEAR_HIGH_BARS - 1)); j <= e; j++) if (ctx.prices[j].high > hi) hi = ctx.prices[j].high;
  return ctx.prices[e].close / hi - 1 > NEAR_HIGH_MIN_GAP;
}

function candidateFilter(k: number, ctx: Ctx, e: number): boolean {
  if (k === 2) { // S2
    const l = ctx.sLong[e], l0 = ctx.sLong[e - SLOPE_LOOKBACK];
    return l !== undefined && l0 !== undefined && l / l0 - 1 > 0;
  }
  if (k === 3) { // S3
    if (e < VOL_AVG_BARS) return false;
    let s = 0;
    for (let j = e - VOL_AVG_BARS; j < e; j++) s += ctx.prices[j].volume;
    const avg = s / VOL_AVG_BARS;
    return avg > 0 && ctx.prices[e].volume >= avg * VOL_MULT;
  }
  if (k === 4) return kospiAboveAsOf(ctx.prices[e].date) === true; // S4
  return true;
}

function genTradesV3(ctx: Ctx, k: number, atr: Float64Array): Trade[] {
  const { prices, n, goldens, deads } = ctx;
  const out: Trade[] = [];
  let nextAllowedIdx = 0;
  for (const g of goldens) {
    if (g <= nextAllowedIdx) continue;
    const nextDead = deads.find((d) => d > g) ?? Infinity;
    const e = g;
    if (e >= n || e >= nextDead) continue;
    if (!ctx.entryOk(e)) continue;
    if (!nearHighOk(ctx, e)) continue; // v3 기준선 필터
    if (!candidateFilter(k, ctx, e)) continue;
    let stopLevel = -Infinity;
    if (k === 1) {
      if (!Number.isFinite(atr[e])) continue;
      stopLevel = prices[e].close - ATR_MULT * atr[e];
    }
    let exitIdx = -1;
    for (let i = e + 1; i < n; i++) {
      if (i >= nextDead) { exitIdx = i; break; }
      if (k === 1 && prices[i].close <= stopLevel) { exitIdx = i; break; }
    }
    const forced = exitIdx === -1;
    const sIdx = forced ? n - 1 : exitIdx;
    out.push({
      code: ctx.code, gIdx: g, eIdx: e, sIdx,
      buyDate: prices[e].date, buyPrice: prices[e].close,
      sellDate: prices[sIdx].date, sellPrice: prices[sIdx].close,
      returnPct: computeCostAdjustedReturnPct(prices[e].close, prices[sIdx].close, prices[sIdx].date, "KR"),
      ...(forced ? { isForcedLiquidation: true } : {}),
    });
    nextAllowedIdx = sIdx;
  }
  return out;
}

interface Ext extends SliceMetrics { ev: number; hold: number; conc: number }
function ext(acc: Acc, start: string, end: string): Ext {
  const m = sliceMetrics(acc, start, end);
  const t = acc.trades.filter((x) => x.buyDate >= start && x.buyDate <= end);
  const hold = t.length ? t.reduce((s, x) => s + (Date.parse(x.sellDate) - Date.parse(x.buyDate)) / 86400000, 0) / t.length : 0;
  let sum = 0, cnt = 0;
  for (const [d, es] of acc.dailyReturns) if (d >= start && d <= end) { sum += es.length; cnt++; }
  return { ...m, ev: m.trades ? (m.winRate / 100) * (m.payoff + 1) - 1 : 0, hold, conc: cnt ? sum / cnt : 0 };
}
const fm = (m: Ext): string =>
  m.trades === 0 ? "거래 0건" : `CAGR ${m.cagr.toFixed(2)}% | MDD ${m.mdd.toFixed(2)}% | 승률 ${m.winRate.toFixed(1)}% | 손익비 ${m.payoff.toFixed(2)} | 기대값 ${(m.ev * 100).toFixed(2)}% | 거래 ${m.trades} | 평균보유 ${m.hold.toFixed(0)}일 | 평균동시보유 ${m.conc.toFixed(1)}`;

function yearly(acc: Acc, fromYear: number, toYear: number): string {
  const out: string[] = [];
  for (let y = fromYear; y <= toYear; y++) {
    const dates = [...acc.dailyReturns.keys()].filter((d) => d >= `${y}-01-01` && d <= `${y}-12-31`).sort();
    const daily = dates.map((d) => { const e = acc.dailyReturns.get(d)!; return (e.reduce((s, x) => s + x.returnPct, 0) / e.length) * 100; });
    out.push(`${y}: ${computeCumulativeAndMdd(daily).totalReturnPct.toFixed(1)}%`);
  }
  return out.join(", ");
}

async function main(): Promise<void> {
  console.log(`ma_cross v3 추가 강화 S1~S4 시작(in-sample): ${new Date().toISOString()}`);
  const kospi = await getIndexPriceSeries("KOSPI", KOSPI_START, TODAY);
  const kSma = computeSMA(kospi.map((p) => p.closePrice), KOSPI_MA);
  kDates = kospi.map((p) => p.tradeDate);
  kAbove = kospi.map((p, i) => (kSma[i] === undefined ? undefined : p.closePrice > (kSma[i] as number)));
  const firstAbove = kDates[kAbove.findIndex((v) => v !== undefined)];
  console.log(`KOSPI ${kospi.length}행 ${kDates[0]}~${kDates[kDates.length - 1]}, 200일선 계산 가능 시작 ${firstAbove}`);

  const series = await loadSeries();
  const main = NAMES.map(() => newAcc());
  const seg = NAMES.map(() => newAcc());
  for (const [code, rows] of series) {
    const ctx = buildCtx(code, rows);
    if (ctx.goldens.length === 0) { series.delete(code); continue; }
    const segCtx: Ctx = { ...ctx, entryOk: (i) => ctx.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && rows[i].marketCapEok >= SEG_MIN_EOK && rows[i].marketCapEok < SEG_MAX_EOK };
    series.delete(code);
    const atr = computeATR(ctx, ATR_PERIOD);
    for (let k = 0; k < NAMES.length; k++) {
      addTrades(main[k], ctx, genTradesV3(ctx, k, atr));
      addTrades(seg[k], segCtx, genTradesV3(segCtx, k, atr));
    }
  }

  const B = { L: ext(main[0], PERIOD_START, LEARN_END), C: ext(main[0], CONFIRM_START, TODAY), F: ext(main[0], PERIOD_START, TODAY), SL: ext(seg[0], PERIOD_START, LEARN_END) };
  console.log(`\n=== 기준선 V3 (하네스 재현) ===`);
  console.log(`사용자 지정: 학습 0.36%/26.01%, 확인 13.75%/41.13%, 전체 6.36%/53.31%/승률 32.2%/손익비 4.03/기대값 62.02%/2,335건`);
  console.log(`학습: ${fm(B.L)}\n확인: ${fm(B.C)}\n전체: ${fm(B.F)}\n5천억 미만 복제 학습: ${fm(B.SL)}`);
  console.log(`기준선 연도별: ${yearly(main[0], 2010, Number(TODAY.slice(0, 4)))}`);
  console.log(`기준선 5천억 미만 복제 전체(참고 아님, 거래 수 확인용): 학습 거래 ${B.SL.trades}`);

  const adopted: { name: string; evL: number }[] = [];
  const lastYear = Number(TODAY.slice(0, 4));
  for (let k = 1; k < NAMES.length; k++) {
    const name = NAMES[k];
    const L = ext(main[k], PERIOD_START, LEARN_END);
    const SL = ext(seg[k], PERIOD_START, LEARN_END);
    const c1 = L.cagr > B.L.cagr && L.mdd <= B.L.mdd;
    const c6 = SL.cagr >= B.SL.cagr && SL.mdd <= B.SL.mdd;
    console.log(`\n[${name}]\n  학습: ${fm(L)}\n  5천억 미만 복제 학습: ${fm(SL)}`);
    console.log(`  학습 관문: 조건1 ${c1 ? "충족" : "미충족"}(CAGR ${L.cagr.toFixed(2)} vs ${B.L.cagr.toFixed(2)}, MDD ${L.mdd.toFixed(2)} vs ${B.L.mdd.toFixed(2)}) / 조건6 ${c6 ? "충족" : "미충족"}(CAGR ${SL.cagr.toFixed(2)} vs ${B.SL.cagr.toFixed(2)}, MDD ${SL.mdd.toFixed(2)} vs ${B.SL.mdd.toFixed(2)}) → ${c1 && c6 ? "통과" : "탈락(확인·전체 미평가)"}`);
    if (!(c1 && c6)) { console.log(`  연도별(학습 연도만): ${yearly(main[k], 2010, 2018)}`); continue; }
    const C = ext(main[k], CONFIRM_START, TODAY);
    const F = ext(main[k], PERIOD_START, TODAY);
    const c2 = C.cagr >= B.C.cagr && C.mdd <= B.C.mdd;
    const c3 = F.trades >= TRADES_MIN;
    const c4 = F.payoff >= PAYOFF_MIN;
    const c5 = F.ev >= B.F.ev;
    console.log(`  확인(1회): ${fm(C)}\n  전체: ${fm(F)}`);
    console.log(`  판정: 조건2 ${c2 ? "충족" : "미충족"}(확인 CAGR ${C.cagr.toFixed(2)} vs ${B.C.cagr.toFixed(2)}, MDD ${C.mdd.toFixed(2)} vs ${B.C.mdd.toFixed(2)}) / 조건3 ${c3 ? "충족" : "미충족"}(${F.trades} ≥ ${TRADES_MIN}) / 조건4 ${c4 ? "충족" : "미충족"}(${F.payoff.toFixed(2)} ≥ ${PAYOFF_MIN}) / 조건5 ${c5 ? "충족" : "미충족"}(${(F.ev * 100).toFixed(2)}% vs ${(B.F.ev * 100).toFixed(2)}%) → ${c2 && c3 && c4 && c5 ? "채택 가능" : "탈락"}`);
    console.log(`  보고 전용: 전체 MDD ${F.mdd.toFixed(2)}% (기준선 ${B.F.mdd.toFixed(2)}%) / 평균 동시 보유 ${F.conc.toFixed(1)} (기준선 ${B.F.conc.toFixed(1)}) / 연도별 ${yearly(main[k], 2010, lastYear)}`);
    if (c2 && c3 && c4 && c5) adopted.push({ name, evL: L.ev });
  }
  adopted.sort((a, b) => b.evL - a.evL);
  console.log(`\n채택 후보: ${adopted.length ? adopted.map((a) => `${a.name}(학습 기대값 ${(a.evL * 100).toFixed(2)}%)`).join(", ") : "없음 → v3 유지"}`);
  console.log(`누적 시도 횟수: ${PRIOR_ATTEMPTS + 4}회 (기존 ${PRIOR_ATTEMPTS} + 이번 4)`);
  void calmar;
  console.log("완료");
}
main().catch((e) => { console.error(e); process.exit(1); });

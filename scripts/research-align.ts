/**
 * [임시 연구 — 병합 금지, 읽기 전용] 스크리닝-백테스트 정렬 연구: (A) 청산 규칙, (B) 시총 하한 비교.
 * 사전 등록: research/screen-align-prereg.md (0a4235df3f4eeca2886f7eda62ce44bdbd3d0da4). 판정 기준은 그 문서와 같다.
 */
import { computeStates, runBacktest, type DailyPrice, type StrategyRule } from "@/lib/backtest";
import { computeCostAdjustedReturnPct } from "@/lib/transactionCost";
import { computeTrailingAvgTradingValue, pickListedSharesOnOrBefore } from "@/lib/pitUniverse";
import { DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS } from "@/lib/stockDailyPricesStorage";
import { loadFundamentalsSeriesWithListedShares, type FundamentalsSeries } from "@/lib/stockFundamentals";
import type { ListedSharesByFiscalYear } from "@/lib/pegRatio";
import { MA_CROSS_V2_PARAMS } from "@/lib/maCrossConfig";
import { PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { accumulateStockDailyReturns } from "@/lib/strategyBacktestSummary";
import {
  loadSeries, toPrices, newAcc, sliceMetrics, calmar, PERIOD_START, LEARN_END, CONFIRM_START, TODAY,
  type Acc, type Trade, type SliceMetrics,
} from "./research-ma-lab";

type Strat = "ma_cross" | "reversal_breakout_v2" | "peg_lynch";
const STRATS: Strat[] = ["ma_cross", "reversal_breakout_v2", "peg_lynch"];
const RULES: Record<Strat, StrategyRule> = {
  ma_cross: { rule_type: "ma_cross", rule_params: MA_CROSS_V2_PARAMS },
  reversal_breakout_v2: { rule_type: "reversal_breakout_v2", rule_params: {} },
  peg_lynch: { rule_type: "peg_lynch", rule_params: {} },
};

// ---- 사전 등록 상수 ----
const BASE_FLOOR_EOK = 5000;
const FLOORS_EOK = [500, 1000, 3000];
const STOP_PCT = 0.07; // 스크리닝 현재 손절
const TP_PCT = 0.2; // 스크리닝 현재 익절
const MIN_TRADES_RATIO = 0.5; // 판정 기준 3
const POOL_CAP_EOK = 10_000; // peg 스크리닝 후보 풀(과거 시총 1조 이력)
const POOL_FROM = "2011-01-01";
const PEG_EXPL: [string, string, string][] = [["2021-03~2023-12", "2021-03-01", "2023-12-31"], ["2024~", "2024-01-01", TODAY]];

interface Variant { name: string; floor: number; stop?: number; tp?: number; signalExit: boolean; reentry: boolean }
const V = (name: string, floor: number, o: Partial<Variant> = {}): Variant => ({ name, floor, signalExit: true, reentry: false, ...o });
const A_VARIANTS: Variant[] = [
  V("A0", BASE_FLOOR_EOK),
  V("A1", BASE_FLOOR_EOK, { stop: STOP_PCT, tp: TP_PCT, signalExit: false }),
  V("A2", BASE_FLOOR_EOK, { stop: STOP_PCT }),
  V("A1R", BASE_FLOOR_EOK, { stop: STOP_PCT, tp: TP_PCT, signalExit: false, reentry: true }),
  V("A2R", BASE_FLOOR_EOK, { stop: STOP_PCT, reentry: true }),
];
const B_VARIANTS: Variant[] = FLOORS_EOK.map((f) => V(`F${f}`, f));
const ALL_VARIANTS = [...A_VARIANTS, ...B_VARIANTS];

function genTrades(code: string, prices: DailyPrice[], states: (boolean | undefined)[], entryOkAt: (i: number, floor: number) => boolean, v: Variant, isEvent: boolean): Trade[] {
  const n = prices.length;
  const golden = new Uint8Array(n);
  const dead = new Uint8Array(n);
  for (let i = 1; i < n; i++) {
    if (prices[i].date < PERIOD_START) continue;
    const p = states[i - 1], c = states[i];
    if (p === undefined || c === undefined) continue;
    if (!p && c) golden[i] = 1; else if (p && !c) dead[i] = 1;
  }
  const out: Trade[] = [];
  let last = -1;
  for (;;) {
    let e = -1;
    for (let j = last + 1; j < n; j++) {
      if (!entryOkAt(j, v.floor)) continue;
      if (golden[j]) { e = j; break; }
      if (v.reentry && !isEvent && last >= 0 && states[j] === true && prices[j].date >= PERIOD_START) { e = j; break; }
    }
    if (e === -1) break;
    const entry = prices[e].close;
    let s = -1;
    for (let i = e + 1; i < n; i++) {
      if (v.signalExit && dead[i]) { s = i; break; }
      if (v.stop !== undefined && prices[i].close <= entry * (1 - v.stop)) { s = i; break; }
      if (v.tp !== undefined && prices[i].close >= entry * (1 + v.tp)) { s = i; break; }
    }
    const forced = s === -1;
    const sIdx = forced ? n - 1 : s;
    out.push({
      code, gIdx: e, eIdx: e, sIdx,
      buyDate: prices[e].date, buyPrice: entry, sellDate: prices[sIdx].date, sellPrice: prices[sIdx].close,
      returnPct: computeCostAdjustedReturnPct(entry, prices[sIdx].close, prices[sIdx].date, "KR"),
      ...(forced ? { isForcedLiquidation: true } : {}),
    });
    last = sIdx;
    if (forced) break;
  }
  return out;
}

interface Ext extends SliceMetrics { ev: number; hold: number; conc: number }
function ext(acc: Acc, start: string, end: string): Ext {
  const m = sliceMetrics(acc, start, end);
  const w = m.winRate / 100;
  const t = acc.trades.filter((x) => x.buyDate >= start && x.buyDate <= end);
  const hold = t.length ? t.reduce((s, x) => s + (Date.parse(x.sellDate) - Date.parse(x.buyDate)) / 86400000, 0) / t.length : 0;
  let sum = 0, cnt = 0;
  for (const [d, es] of acc.dailyReturns) if (d >= start && d <= end) { sum += es.length; cnt++; }
  return { ...m, ev: m.trades ? w * (m.payoff + 1) - 1 : 0, hold, conc: cnt ? sum / cnt : 0 };
}
const f = (m: Ext): string =>
  m.trades === 0 ? "거래 0건" : `CAGR ${m.cagr.toFixed(2)}% | MDD ${m.mdd.toFixed(2)}% | 승률 ${m.winRate.toFixed(1)}% | 손익비 ${m.payoff.toFixed(2)} | 기대값 ${(m.ev * 100).toFixed(2)}% | 거래 ${m.trades} | 평균보유 ${m.hold.toFixed(0)}일 | 평균동시보유 ${m.conc.toFixed(1)}`;

async function main(): Promise<void> {
  console.log(`정렬 연구 시작(in-sample, 사전 등록 0a4235d): ${new Date().toISOString()}`);
  const series = await loadSeries();
  const accs = new Map<string, Acc>();
  for (const s of STRATS) for (const v of ALL_VARIANTS) { if (s === "ma_cross" && v.reentry) continue; accs.set(`${s}|${v.name}`, newAcc()); }
  let mismatch = 0, validated = 0, reentryViol = 0;
  const pegPool = new Map<string, boolean>();

  let nextIndex = 0;
  const codes = [...series.keys()];
  async function worker(): Promise<void> {
    for (;;) {
      const idx = nextIndex++;
      if (idx >= codes.length) return;
      const code = codes[idx];
      const rows = series.get(code)!;
      series.delete(code);
      const prices = toPrices(rows);
      const avgTv = computeTrailingAvgTradingValue(rows, 20);
      const entryOkAt = (i: number, floor: number): boolean => avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && rows[i].marketCapEok >= floor;
      let everOk = false;
      for (let i = 0; i < prices.length; i++) if (prices[i].date >= PERIOD_START && entryOkAt(i, FLOORS_EOK[0])) { everOk = true; break; }
      if (!everOk) continue;
      let poolOk = false;
      for (const r of rows) if (r.tradeDate >= POOL_FROM && r.marketCapEok >= POOL_CAP_EOK) { poolOk = true; break; }
      pegPool.set(code, poolOk);
      let fundamentals: FundamentalsSeries | undefined;
      let listed: ListedSharesByFiscalYear | undefined;
      try {
        const loaded = await loadFundamentalsSeriesWithListedShares(code, (_c, date) => pickListedSharesOnOrBefore(rows, date, DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS));
        fundamentals = loaded.series; listed = loaded.listedSharesByFiscalYear;
      } catch { /* peg만 영향 */ }
      for (const s of STRATS) {
        if (s === "peg_lynch" && !fundamentals) continue;
        const states = computeStates(prices, RULES[s], s === "peg_lynch" ? fundamentals : undefined, s === "peg_lynch" ? listed : undefined);
        if (states.every((x) => x === undefined)) continue;
        for (const v of ALL_VARIANTS) {
          if (s === "ma_cross" && v.reentry) continue;
          const trades = genTrades(code, prices, states, entryOkAt, v, s === "ma_cross");
          if (trades.length === 0) continue;
          for (const t of trades) t.feat = { cap: rows[t.eIdx].marketCapEok, pool: poolOk ? 1 : 0 };
          const acc = accs.get(`${s}|${v.name}`)!;
          acc.trades.push(...trades);
          accumulateStockDailyReturns(acc.dailyReturns, acc.contributions, code, prices, trades, PERIOD_START, "KR", true);
          if (v.name === "A0") {
            // 검증: lib runBacktest(배치와 같은 경로)와 거래가 같은지, 재진입(청산 봉 이전부터 상태가 참이던 진입)이 없는지
            const lib = runBacktest(prices, RULES[s], PERIOD_START, s === "peg_lynch" ? fundamentals : undefined, s === "peg_lynch" ? listed : undefined, {
              market: "KR",
              entryAllowed: (d) => { const i = prices.findIndex((p) => p.date === d); return i >= 0 && entryOkAt(i, BASE_FLOOR_EOK); },
            });
            validated++;
            const a = trades.map((t) => `${t.buyDate}>${t.sellDate}`).join(",");
            const b = lib.trades.map((t) => `${t.buyDate}>${t.sellDate}`).join(",");
            if (a !== b) mismatch++;
            for (let k = 1; k < trades.length; k++) if (states[trades[k].eIdx - 1] !== false || trades[k].eIdx <= trades[k - 1].sIdx) reentryViol++;
          }
        }
      }
    }
  }
  await Promise.all(Array.from({ length: 10 }, worker));
  console.log(`\n[검증] A0 거래를 lib/backtest.ts runBacktest(배치 경로)와 종목 단위로 비교: ${validated}건 비교, 불일치 ${mismatch}건. A0에서 "청산 이전/이후 상태가 이미 참인 채 재진입" 위반 ${reentryViol}건.`);

  const M = new Map<string, { L: Ext; C: Ext; F: Ext }>();
  for (const [k, a] of accs) M.set(k, { L: ext(a, PERIOD_START, LEARN_END), C: ext(a, CONFIRM_START, TODAY), F: ext(a, PERIOD_START, TODAY) });
  const g = (s: Strat, v: string) => M.get(`${s}|${v}`)!;
  const pf = (b: boolean): string => (b ? "충족" : "미충족");
  const summary: string[] = [];

  for (const s of STRATS) {
    console.log(`\n\n################ ${s} ################`);
    const base = g(s, "A0");
    console.log(`\n=== (A) 청산 규칙 — baseline A0 (시총 5천억) ===`);
    console.log(`A0 학습: ${f(base.L)}\nA0 확인: ${f(base.C)}\nA0 전체: ${f(base.F)}`);
    const passersA: { name: string; calmarL: number }[] = [];
    for (const name of ["A1", "A2"]) {
      const c = g(s, name);
      const gate = base.L.trades > 0 && c.L.cagr > base.L.cagr && c.L.mdd <= base.L.mdd;
      console.log(`\n${name} 학습: ${f(c.L)}  → 학습 조건(1) ${gate ? "통과" : "미통과" + (base.L.trades === 0 ? " (baseline 학습 거래 0건: 비교 불가)" : "")}`);
      if (!gate) { console.log(`${name}: 확인 구간 미평가 → baseline 유지`); continue; }
      const c2 = c.C.cagr >= base.C.cagr && c.C.mdd <= base.C.mdd;
      const c3 = c.F.trades >= MIN_TRADES_RATIO * base.F.trades;
      const c4 = c.F.ev >= base.F.ev;
      console.log(`${name} 확인: ${f(c.C)}\n${name} 전체: ${f(c.F)}`);
      console.log(`${name} 판정: (1)충족 (2)${pf(c2)} (3)거래수 ${c.F.trades}/${base.F.trades} ${pf(c3)} (4)기대값 ${(c.F.ev * 100).toFixed(2)}% vs ${(base.F.ev * 100).toFixed(2)}% ${pf(c4)} → ${c2 && c3 && c4 ? "채택 가능" : "탈락"}`);
      if (c2 && c3 && c4) passersA.push({ name, calmarL: calmar(c.L) });
    }
    passersA.sort((a, b) => b.calmarL - a.calmarL || (a.name === "A2" ? -1 : 1));
    const chosenA = passersA[0]?.name ?? "A0(baseline 유지)";
    console.log(`\n(A) 결론 ${s}: ${chosenA}`);
    summary.push(`${s} (A): ${chosenA}`);
    if (s !== "ma_cross") {
      for (const [n, r] of [["A1", "A1R"], ["A2", "A2R"]] as const) {
        const a = g(s, n), b = g(s, r);
        console.log(`[참고: 재진입 허용 vs 불허, 학습 구간만] ${n}: 불허 ${f(a.L)} / 허용 ${f(b.L)}`);
      }
    } else console.log("[참고: 재진입] ma_cross는 이벤트형이라 재진입 허용/불허 차이 없음(해당 없음).");

    console.log(`\n=== (B) 시총 하한 — 청산 A0 고정, 거래대금 5억 유지 ===`);
    console.log(`F5000(=A0) 학습: ${f(base.L)}`);
    const passersB: { name: string; calmarL: number }[] = [];
    for (const fl of FLOORS_EOK) {
      const name = `F${fl}`;
      const c = g(s, name);
      const gate = base.L.trades > 0 && c.L.cagr > base.L.cagr && c.L.mdd <= base.L.mdd && c.L.trades > base.L.trades;
      console.log(`\n${name} 학습: ${f(c.L)}  → 학습 조건 ${gate ? "통과" : "미통과" + (base.L.trades === 0 ? " (baseline 학습 거래 0건: 비교 불가)" : "")}`);
      if (!gate) { console.log(`${name}: 확인 구간 미평가 → 5천억 유지`); continue; }
      const ok2 = c.C.cagr > base.C.cagr && c.C.mdd <= base.C.mdd && c.C.trades > base.C.trades;
      console.log(`${name} 확인: ${f(c.C)}\n${name} 전체: ${f(c.F)}\n${name} 판정: 확인 조건 ${pf(ok2)} → ${ok2 ? "채택 가능" : "탈락"}`);
      if (ok2) passersB.push({ name, calmarL: calmar(c.L) });
    }
    passersB.sort((a, b) => b.calmarL - a.calmarL);
    const chosenB = passersB[0]?.name ?? "5000억 유지";
    console.log(`\n(B) 결론 ${s}: ${chosenB}`);
    summary.push(`${s} (B): ${chosenB}`);
    const counts = [500, 1000, 3000, 5000].map((fl) => { const m = g(s, fl === 5000 ? "A0" : `F${fl}`); return `${fl}억: 전체 ${m.F.trades}건(학습 ${m.L.trades}, 확인 ${m.C.trades})`; });
    console.log(`[신호(진입) 수] ${counts.join(" / ")}`);

    // 시총 구간별 (500억 하한 실행 기준)
    const accF = accs.get(`${s}|F500`)!;
    const buckets: [string, number, number][] = [["500~1,000억", 500, 1000], ["1,000~3,000억", 1000, 3000], ["3,000~5,000억", 3000, 5000], ["5천억 이상", 5000, Infinity]];
    const anyPass = passersB.length > 0 || false;
    console.log(`[시총 구간별 거래당 평균 수익률·승률 — 500억 하한 실행의 거래, 진입일 as-of 시총] (확인·전체는 B 학습 조건 통과 수준이 있을 때만 표시)`);
    for (const [label, lo, hi] of buckets) {
      const row = (a: string, b: string): string => {
        const t = accF.trades.filter((x) => x.buyDate >= a && x.buyDate <= b && x.feat!.cap >= lo && x.feat!.cap < hi);
        if (!t.length) return "0건";
        return `${t.length}건 평균 ${((t.reduce((q, x) => q + x.returnPct, 0) / t.length) * 100).toFixed(2)}% 승률 ${((t.filter((x) => x.returnPct > 0).length / t.length) * 100).toFixed(1)}%`;
      };
      const learnedPass = FLOORS_EOK.some((fl) => { const c = g(s, `F${fl}`); return base.L.trades > 0 && c.L.cagr > base.L.cagr && c.L.mdd <= base.L.mdd && c.L.trades > base.L.trades; });
      console.log(`  ${label}: 학습 ${row(PERIOD_START, LEARN_END)}${learnedPass || anyPass ? ` | 확인 ${row(CONFIRM_START, TODAY)}` : " | 확인 미평가"}`);
    }

    if (s === "peg_lynch") {
      const a0 = accs.get("peg_lynch|A0")!.trades;
      const inPool = a0.filter((x) => x.feat!.pool === 1), out = a0.filter((x) => x.feat!.pool === 0);
      const st = (t: Trade[]): string => t.length ? `${t.length}건 승률 ${((t.filter((x) => x.returnPct > 0).length / t.length) * 100).toFixed(1)}% 평균 ${((t.reduce((q, x) => q + x.returnPct, 0) / t.length) * 100).toFixed(2)}%` : "0건";
      console.log(`[peg 후보 풀 영향] A0 거래 ${a0.length}건 중 2011~현재 시총 1조 이상 이력 종목 ${inPool.length}건(${((inPool.length / Math.max(a0.length, 1)) * 100).toFixed(1)}%): ${st(inPool)} / 풀 밖 ${st(out)}`);
      console.log(`\n--- 탐색적(사전 등록 7항: 판정에 쓰지 않음) peg_lynch 구간 분할 ---`);
      for (const v of ["A0", "A1", "A1R", "A2", "A2R", "F500", "F1000", "F3000"]) for (const [label, a, b] of PEG_EXPL) console.log(`  ${v} ${label}: ${f(ext(accs.get(`peg_lynch|${v}`)!, a, b))}`);
    }
  }
  console.log("\n\n=== 결론 요약 ===");
  for (const l of summary) console.log(l);
  console.log("완료");
}
main().catch((e) => { console.error(e); process.exit(1); });

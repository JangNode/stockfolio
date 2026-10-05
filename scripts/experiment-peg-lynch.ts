/**
 * 디스포저블 검증(읽기 전용, DB 쓰기 없음): 현재 peg_lynch 로직만 시총 5천억 PIT 유니버스에서 학습/검증 구간으로 평가하고,
 * 표본·재무 커버리지·상위 종목 의존도를 점검한다. 새 변형은 만들지 않는다. 판정 규칙은 코드에 사전 고정돼 있다.
 */
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow, DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { runBacktest, type DailyPrice, type StrategyRule, type BacktestTrade } from "@/lib/backtest";
import { computeTrailingAvgTradingValue, pickListedSharesOnOrBefore } from "@/lib/pitUniverse";
import { loadFundamentalsSeriesWithListedShares, pickFundamentalsAsOf, type FundamentalsSeries } from "@/lib/stockFundamentals";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { computeMonthlyRebalanceDates, simulateUniverseMonthlyRebalance } from "@/lib/benchmarkSummary";
import { computeCagrPct, computeCumulativeAndMdd } from "@/lib/strategyBacktestSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON, STRATEGY_BACKTEST_WINDOW_START_YEAR } from "@/lib/strategyBacktestSummaryConfig";

// ===== 사전 고정 =====
const START = `${STRATEGY_BACKTEST_WINDOW_START_YEAR}-01-01`;
const TRAIN = { from: START, to: "2022-12-31" };
const TODAY = new Date().toISOString().slice(0, 10);
const VALID = { from: "2023-01-01", to: TODAY };
const CAP_MAIN_EOK = 5000;
const CAP_ROBUST_EOK = 10000;
const MIN_TRADES_PER_YEAR = 20;
const MAX_TOP5_SHARE = 0.5;
const MIN_ANNUAL_ROWS_FOR_EPS_HISTORY = 5; // 커버리지 보조 지표(공시 5건 이상 = EPS 5년 이력 가능성의 근사)
const PEG_RULE: StrategyRule = { rule_type: "peg_lynch", rule_params: {} };

interface StockCtx {
  code: string;
  rows: StockDailyPriceRow[];
  prices: DailyPrice[];
  avgTv: Float64Array;
  idx: Map<string, number>;
  fund?: FundamentalsSeries;
  shares?: Awaited<ReturnType<typeof loadFundamentalsSeriesWithListedShares>>["listedSharesByFiscalYear"];
}

function toDailyPrice(r: StockDailyPriceRow): DailyPrice {
  return { date: r.tradeDate, open: r.openPrice, high: r.highPrice, low: r.lowPrice, close: r.closePrice, volume: r.volume, marketCapEok: r.marketCapEok, listedShares: r.listedShares };
}

function sliceMetrics(dates: string[], pct: number[], from: string, to: string): { cagr: number; mdd: number } {
  const sl: number[] = [];
  for (let i = 0; i < dates.length; i++) if (dates[i] >= from && dates[i] <= to) sl.push(pct[i]);
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(sl);
  return { cagr: computeCagrPct(totalReturnPct, from, to), mdd: mddPct };
}

interface DayRet {
  ci: number;
  code: string;
  r: number;
}

function dayReturns(ctx: StockCtx, trades: BacktestTrade[], calIndex: Map<string, number>, withCosts: boolean): DayRet[] {
  const out: DayRet[] = [];
  const px = ctx.prices;
  for (const t of trades) {
    const eb = ctx.idx.get(t.buyDate);
    const xb = ctx.idx.get(t.sellDate);
    if (eb === undefined || xb === undefined) continue;
    for (let k = eb + 1; k <= xb; k++) {
      const ci = calIndex.get(px[k].date);
      if (ci === undefined) continue;
      let mult = px[k].close / px[k - 1].close;
      if (withCosts) {
        if (k === eb + 1) mult /= computeEffectiveBuyPrice(px[eb].close) / px[eb].close;
        if (k === xb) mult *= computeEffectiveSellPrice(px[k].close, px[k].date, "KR") / px[k].close;
      }
      out.push({ ci, code: ctx.code, r: mult - 1 });
    }
  }
  return out;
}

function seriesOf(entries: DayRet[], calendar: string[], exclude?: Set<string>): { dates: string[]; pct: number[]; count: Int32Array } {
  const sum = new Float64Array(calendar.length);
  const cnt = new Int32Array(calendar.length);
  for (const e of entries) {
    if (exclude?.has(e.code)) continue;
    sum[e.ci] += e.r;
    cnt[e.ci]++;
  }
  const dates: string[] = [];
  const pct: number[] = [];
  for (let i = 0; i < calendar.length; i++) {
    if (cnt[i] > 0) {
      dates.push(calendar[i]);
      pct.push((sum[i] / cnt[i]) * 100);
    }
  }
  return { dates, pct, count: cnt };
}

async function main(): Promise<void> {
  const startedMs = Date.now();
  console.log(
    `[사전 고정] peg_lynch 현재 로직만, 시총 ${CAP_MAIN_EOK}억 PIT(그날 저장 시총) + 직전 20거래일 평균 거래대금 5억, 상장폐지 포함, 테마 예외 제외, 종가 체결. 학습 ${TRAIN.from}~${TRAIN.to} / 검증 ${VALID.from}~.\n` +
      `  판정: 학습·검증 모두 비용반영 CAGR ≥ 같은 구간 벤치마크(비용반영) AND 모든 연도 거래 ${MIN_TRADES_PER_YEAR}건 이상 AND 전 기간(비용반영) 상위 5종목 기여 < 총수익의 ${MAX_TOP5_SHARE * 100}% → "유지 후보", 하나라도 어기면 "표본 부족/우연 가능성".`
  );
  const kospi = await getIndexPriceSeries("KOSPI", "2014-01-01", TODAY);
  const calendar = kospi.map((p) => p.tradeDate).filter((d) => d >= START).sort();
  const calIndex = new Map(calendar.map((d, i) => [d, i]));
  const rebalanceDates = computeMonthlyRebalanceDates(calendar);
  const adjustments = await loadAppliedAdjustments();
  const seriesByCode = await loadAllStockSeriesFromParquet(2011, new Date().getUTCFullYear(), adjustments);

  const pricesByStock = new Map<string, { date: string; close: number }[]>();
  const liqCap = new Map<number, Map<string, Map<string, number>>>([[CAP_MAIN_EOK, new Map()]]);
  const ctxs: StockCtx[] = [];
  for (const [code, rows] of seriesByCode) {
    if (rows.length === 0) continue;
    const avgTv = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
    const idx = new Map(rows.map((r, i) => [r.tradeDate, i]));
    const m = new Map<string, number>();
    for (const d of rebalanceDates) {
      const i = idx.get(d);
      if (i !== undefined && Number.isFinite(avgTv[i]) && rows[i].marketCapEok >= CAP_MAIN_EOK) m.set(d, avgTv[i]);
    }
    liqCap.get(CAP_MAIN_EOK)!.set(code, m);
    pricesByStock.set(code, rows.map((r) => ({ date: r.tradeDate, close: r.closePrice })));
    let ever = false;
    for (let i = 0; i < rows.length && !ever; i++) ever = rows[i].tradeDate >= START && avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON;
    if (ever) ctxs.push({ code, rows, prices: rows.map(toDailyPrice), avgTv, idx });
  }
  console.log(`유동성 기준 한 번이라도 충족한 종목 ${ctxs.length}개(시총 무관) — 재무 로드 시작 ${((Date.now() - startedMs) / 1000).toFixed(0)}초`);

  // 재무 로드(동시 10).
  let next = 0;
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      for (;;) {
        const i = next++;
        if (i >= ctxs.length) return;
        const ctx = ctxs[i];
        try {
          const loaded = await loadFundamentalsSeriesWithListedShares(ctx.code, (_c, date) => pickListedSharesOnOrBefore(ctx.rows, date, DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS));
          ctx.fund = loaded.series;
          ctx.shares = loaded.listedSharesByFiscalYear;
        } catch (e) {
          console.error(`  ${ctx.code} 재무 로드 실패: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    })
  );
  console.log(`재무 로드 완료 ${((Date.now() - startedMs) / 1000).toFixed(0)}초`);

  // 벤치마크(시총 5천억, 구간별·비용별).
  const liq = liqCap.get(CAP_MAIN_EOK)!;
  const eligible = (code: string, date: string): boolean => (liq.get(code)?.get(date) ?? NaN) >= PIT_MIN_AVG_TRADING_VALUE_WON;
  const bench = (costs: boolean) => {
    const pct = simulateUniverseMonthlyRebalance(pricesByStock, calendar, START, eligible, costs);
    return { train: sliceMetrics(calendar, pct, TRAIN.from, TRAIN.to), valid: sliceMetrics(calendar, pct, VALID.from, VALID.to) };
  };
  const benchOn = bench(true);
  const benchOff = bench(false);

  // 거래: 유동성만(G0) / 5천억(G1) / 1조(G2).
  const gateFor = (ctx: StockCtx, cap: number) => (date: string): boolean => {
    const i = ctx.idx.get(date);
    return i !== undefined && ctx.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && ctx.rows[i].marketCapEok >= cap;
  };
  interface TradeRec {
    code: string;
    t: BacktestTrade;
    ctx: StockCtx;
  }
  const tradesG0: TradeRec[] = [];
  const tradesG1: TradeRec[] = [];
  const tradesG2: TradeRec[] = [];
  const entriesOn: DayRet[] = [];
  const entriesOff: DayRet[] = [];
  for (const ctx of ctxs) {
    if (!ctx.fund || !ctx.shares) continue;
    for (const [cap, sink] of [[0, tradesG0], [CAP_MAIN_EOK, tradesG1], [CAP_ROBUST_EOK, tradesG2]] as const) {
      const result = runBacktest(ctx.prices, PEG_RULE, START, ctx.fund, ctx.shares, { market: "KR", entryAllowed: gateFor(ctx, cap) });
      if (result.insufficientData || result.trades.length === 0) continue;
      for (const t of result.trades) sink.push({ code: ctx.code, t, ctx });
      if (cap === CAP_MAIN_EOK) {
        entriesOn.push(...dayReturns(ctx, result.trades, calIndex, true));
        entriesOff.push(...dayReturns(ctx, result.trades, calIndex, false));
      }
    }
  }
  console.log(`거래 시뮬레이션 완료 ${((Date.now() - startedMs) / 1000).toFixed(0)}초`);

  const fmt = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : "-");
  const on = seriesOf(entriesOn, calendar);
  const off = seriesOf(entriesOff, calendar);

  // 1) 구간별 표.
  const periodStats = (p: { from: string; to: string }): string => {
    const m1 = sliceMetrics(on.dates, on.pct, p.from, p.to);
    const m2 = sliceMetrics(off.dates, off.pct, p.from, p.to);
    const ts = tradesG1.filter((x) => x.t.buyDate >= p.from && x.t.buyDate <= p.to);
    const wins = ts.filter((x) => x.t.returnPct > 0);
    const losses = ts.filter((x) => x.t.returnPct <= 0);
    const avgWin = wins.length ? wins.reduce((s, x) => s + x.t.returnPct, 0) / wins.length : NaN;
    const avgLoss = losses.length ? losses.reduce((s, x) => s + x.t.returnPct, 0) / losses.length : NaN;
    const holds = ts.map((x) => {
      const eb = x.ctx.idx.get(x.t.buyDate)!;
      const xb = x.ctx.idx.get(x.t.sellDate)!;
      return xb - eb;
    });
    const avgHold = holds.length ? holds.reduce((s, v) => s + v, 0) / holds.length : NaN;
    return `비용반영 CAGR ${fmt(m1.cagr)} / 미반영 ${fmt(m2.cagr)} / MDD ${fmt(m1.mdd)} / ${ts.length}건 / 평균보유 ${fmt(avgHold)}거래일 / 승률 ${ts.length ? fmt((wins.length / ts.length) * 100) : "-"}% / 손익비 ${Number.isFinite(avgWin / Math.abs(avgLoss)) ? (avgWin / Math.abs(avgLoss)).toFixed(2) : "-"}`;
  };
  console.log(`\n[1] peg_lynch ${TRAIN.from}~${TRAIN.to}: ${periodStats(TRAIN)}`);
  console.log(`[1] peg_lynch ${VALID.from}~: ${periodStats(VALID)}`);
  console.log(`[1] 벤치마크 5천억 월간: 학습 비용반영 ${fmt(benchOn.train.cagr)}/MDD ${fmt(benchOn.train.mdd)}/미반영 ${fmt(benchOff.train.cagr)} | 검증 비용반영 ${fmt(benchOn.valid.cagr)}/MDD ${fmt(benchOn.valid.mdd)}/미반영 ${fmt(benchOff.valid.cagr)}`);

  // 2-a) 연도별 거래건수 + 동시 보유 종목 수.
  console.log("\n[2-a] 연도별: 진입 거래건수 | 보유일 기준 동시 보유 종목 수(평균/최대) | 보유 0종목인 거래일 비율");
  const years = Array.from(new Set(calendar.map((d) => d.slice(0, 4)))).sort();
  const yearTrades = new Map<string, number>();
  for (const y of years) yearTrades.set(y, tradesG1.filter((x) => x.t.buyDate.slice(0, 4) === y).length);
  for (const y of years) {
    let sum = 0, days = 0, max = 0, zero = 0, total = 0;
    for (let i = 0; i < calendar.length; i++) {
      if (calendar[i].slice(0, 4) !== y) continue;
      total++;
      const c = on.count[i];
      if (c === 0) zero++;
      else {
        sum += c;
        days++;
        if (c > max) max = c;
      }
    }
    console.log(`  ${y}: ${yearTrades.get(y)}건 | 평균 ${days ? (sum / days).toFixed(1) : "-"} / 최대 ${max} | 무보유일 ${total ? ((zero / total) * 100).toFixed(0) : "-"}%`);
  }
  const holdSorted = Array.from(on.count).filter((c) => c > 0).sort((a, b) => a - b);
  console.log(`  전 기간 동시 보유(보유일만): 중앙 ${holdSorted[Math.floor(holdSorted.length * 0.5)]} / p90 ${holdSorted[Math.floor(holdSorted.length * 0.9)]} / 최대 ${holdSorted[holdSorted.length - 1]}`);

  // 2-b) 재무 커버리지(월간 리밸런싱 시점의 PIT 유니버스 기준).
  console.log("\n[2-b] 연도별 재무 커버리지(PIT 유니버스=시총5천억+유동성5억, 월말 시점 평균): 공시 재무 있음 / 공시 5건 이상 — 전체 | 5천억~1조 | 1조 이상 (분모=유니버스 종목-월 수)");
  const cover = new Map<string, { n: number; has: number; h5: number; nMid: number; hasMid: number; h5Mid: number; nBig: number; hasBig: number; h5Big: number }>();
  for (const ctx of ctxs) {
    for (const d of rebalanceDates) {
      const i = ctx.idx.get(d);
      if (i === undefined || !(ctx.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON) || ctx.rows[i].marketCapEok < CAP_MAIN_EOK) continue;
      const y = d.slice(0, 4);
      const c = cover.get(y) ?? { n: 0, has: 0, h5: 0, nMid: 0, hasMid: 0, h5Mid: 0, nBig: 0, hasBig: 0, h5Big: 0 };
      const f = ctx.fund ? pickFundamentalsAsOf(ctx.fund, d) : null;
      const has = f !== null && f.netIncomeParent !== null ? 1 : 0;
      const h5 = ctx.fund && ctx.fund.annual.filter((r) => r.rceptDate <= d).length >= MIN_ANNUAL_ROWS_FOR_EPS_HISTORY ? 1 : 0;
      c.n++; c.has += has; c.h5 += h5;
      if (ctx.rows[i].marketCapEok >= CAP_ROBUST_EOK) { c.nBig++; c.hasBig += has; c.h5Big += h5; } else { c.nMid++; c.hasMid += has; c.h5Mid += h5; }
      cover.set(y, c);
    }
  }
  const pc = (a: number, b: number): string => (b > 0 ? `${((a / b) * 100).toFixed(0)}%` : "-");
  for (const y of years) {
    const c = cover.get(y);
    if (!c) continue;
    console.log(`  ${y}: 전체 ${pc(c.has, c.n)}/${pc(c.h5, c.n)} (${c.n}) | 5천억~1조 ${pc(c.hasMid, c.nMid)}/${pc(c.h5Mid, c.nMid)} (${c.nMid}) | 1조↑ ${pc(c.hasBig, c.nBig)}/${pc(c.h5Big, c.nBig)} (${c.nBig})`);
  }
  const ever5000 = ctxs.filter((c) => c.rows.some((r, i) => r.tradeDate >= START && c.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && r.marketCapEok >= CAP_MAIN_EOK));
  const noFund = ever5000.filter((c) => !c.fund || c.fund.annual.length === 0);
  const evenBig = ever5000.filter((c) => c.rows.some((r, i) => r.tradeDate >= START && c.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && r.marketCapEok >= CAP_ROBUST_EOK));
  const noFundBig = evenBig.filter((c) => !c.fund || c.fund.annual.length === 0);
  console.log(`  유니버스(5천억 한 번이라도) ${ever5000.length}종목 중 재무 전혀 없음 ${noFund.length}종목 | 1조 한 번이라도 ${evenBig.length}종목 중 재무 없음 ${noFundBig.length}종목`);

  // 2-c) 거래건수 감소 원인.
  const key = (x: { code: string; t: BacktestTrade }): string => `${x.code}:${x.t.buyDate}`;
  const setG1 = new Set(tradesG1.map(key));
  const setG2 = new Set(tradesG2.map(key));
  console.log(`\n[2-c] 거래건수: 유동성만 ${tradesG0.length}건 → 시총5천억 ${tradesG1.length}건 → 시총1조 ${tradesG2.length}건 (재무 있는 ${ctxs.filter((c) => c.fund && c.fund.annual.length > 0).length}/${ctxs.length}종목만 시뮬레이션 대상)`);
  console.log(`  유동성만 거래 중 5천억 유니버스에 없는 건 ${tradesG0.filter((x) => !setG1.has(key(x))).length}건(시총 게이트로 제외), 5천억 거래 중 1조에 없는 건 ${tradesG1.filter((x) => !setG2.has(key(x))).length}건(시총 게이트로 제외) — 재무 유무는 시총과 무관하므로 감소분은 전부 유니버스 변경 때문(재무 누락은 별도로 [2-b]의 비커버 종목)`);

  // 2-d) 상위 5종목 기여.
  const contrib = (entries: DayRet[], from: string, to: string): Map<string, number> => {
    const cnt = new Int32Array(calendar.length);
    const sel = entries.filter((e) => calendar[e.ci] >= from && calendar[e.ci] <= to);
    for (const e of sel) cnt[e.ci]++;
    const m = new Map<string, number>();
    for (const e of sel) m.set(e.code, (m.get(e.code) ?? 0) + e.r / cnt[e.ci]);
    return m;
  };
  const report = (label: string, from: string, to: string): { share: number; total: number } => {
    const m = contrib(entriesOn, from, to);
    const sorted = Array.from(m).sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((s, [, v]) => s + v, 0);
    const top5 = sorted.slice(0, 5);
    const top5Sum = top5.reduce((s, [, v]) => s + v, 0);
    const share = total > 0 ? top5Sum / total : NaN;
    const excl = seriesOf(entriesOn, calendar, new Set(top5.map(([c]) => c)));
    const exM = sliceMetrics(excl.dates, excl.pct, from, to);
    const baseM = sliceMetrics(on.dates, on.pct, from, to);
    console.log(
      `  ${label}: 총기여 ${(total * 100).toFixed(1)}%p(일평균수익 합), 상위5 ${top5.map(([c, v]) => `${c}(${(v * 100).toFixed(1)})`).join(", ")} → 비중 ${Number.isFinite(share) ? (share * 100).toFixed(0) + "%" : "총수익≤0(해당 없음)"}, ` +
        `상위5 제외 시 비용반영 CAGR ${fmt(baseM.cagr)} → ${fmt(exM.cagr)}`
    );
    return { share, total };
  };
  console.log("\n[2-d] 상위 5종목 기여(비용반영, 일별 동일가중 평균수익 기여의 합)");
  const full = report("전 기간", START, TODAY);
  report("학습", TRAIN.from, TRAIN.to);
  report("검증", VALID.from, VALID.to);

  // 3) 판정.
  const onTrain = sliceMetrics(on.dates, on.pct, TRAIN.from, TRAIN.to).cagr;
  const onValid = sliceMetrics(on.dates, on.pct, VALID.from, VALID.to).cagr;
  const reasons: string[] = [];
  if (!(onTrain >= benchOn.train.cagr)) reasons.push(`학습 비용반영 CAGR ${fmt(onTrain)} < 벤치마크 ${fmt(benchOn.train.cagr)}`);
  if (!(onValid >= benchOn.valid.cagr)) reasons.push(`검증 비용반영 CAGR ${fmt(onValid)} < 벤치마크 ${fmt(benchOn.valid.cagr)}`);
  const lowYears = years.filter((y) => (yearTrades.get(y) ?? 0) < MIN_TRADES_PER_YEAR);
  if (lowYears.length > 0) reasons.push(`연도별 거래 ${MIN_TRADES_PER_YEAR}건 미만: ${lowYears.map((y) => `${y}(${yearTrades.get(y)})`).join(", ")}`);
  if (!(full.share < MAX_TOP5_SHARE)) reasons.push(`상위5 기여 ${Number.isFinite(full.share) ? (full.share * 100).toFixed(0) + "%" : "총수익≤0"} (기준 <${MAX_TOP5_SHARE * 100}%)`);
  console.log(`\n[3] 판정: ${reasons.length === 0 ? "유지 후보" : `표본 부족/우연 가능성 — ${reasons.join(" | ")}`}`);
  console.log(`\n실행 시간 ${((Date.now() - startedMs) / 1000).toFixed(0)}초, 최대 메모리(RSS) ${(process.resourceUsage().maxRSS / 1024).toFixed(0)}MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

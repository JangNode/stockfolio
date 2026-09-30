/**
 * 디스포저블 진단: 분할·병합 보정 검증(벤치마크 원가 vs 보정 비교, 이벤트 5건 OHLCV 전후,
 * reversal_breakout/v2 상위 트레이드 ↔ 이벤트 겹침, 잔여 ±30% 분류). DB에는 쓰지 않는다.
 */
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { runBacktest, type DailyPrice, type BacktestTrade } from "@/lib/backtest";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { computeMonthlyRebalanceDates, simulateUniverseMonthlyRebalance } from "@/lib/benchmarkSummary";
import { computeCagrPct, computeCumulativeAndMdd } from "@/lib/strategyBacktestSummary";
import {
  PIT_LIQUIDITY_LOOKBACK_DAYS,
  PIT_MIN_AVG_TRADING_VALUE_WON,
  STRATEGY_BACKTEST_WINDOW_START_YEAR,
} from "@/lib/strategyBacktestSummaryConfig";
import { PRICE_ADJUSTMENT_SCAN_FROM_DATE, PRICE_JUMP_RATIO_LOWER, PRICE_JUMP_RATIO_UPPER, SHARES_CHANGE_MIN_RATIO } from "@/lib/priceAdjustmentConfig";

const TODAY = new Date().toISOString().slice(0, 10);
const START = `${STRATEGY_BACKTEST_WINDOW_START_YEAR}-01-01`;
const THRESHOLDS = [
  { label: "5억", won: PIT_MIN_AVG_TRADING_VALUE_WON },
  { label: "1억", won: 100_000_000 },
  { label: "10억", won: 1_000_000_000 },
];
const PRICE_LIMIT_CHANGE_DATE = "2015-06-15";
const LIMIT_TOLERANCE_RATIO = 0.305;

interface EventRow {
  stock_code: string;
  event_date: string;
  price_ratio: number;
  shares_ratio: number;
  adjustment_factor: number;
  status: string;
  low_confidence_reason: string | null;
}

async function loadAllEvents(): Promise<EventRow[]> {
  const out: EventRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("stock_price_adjustment_events")
      .select("stock_code,event_date,price_ratio,shares_ratio,adjustment_factor,status,low_confidence_reason")
      .order("stock_code")
      .order("event_date")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data as EventRow[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

function toDailyPrice(row: StockDailyPriceRow): DailyPrice {
  return {
    date: row.tradeDate, open: row.openPrice, high: row.highPrice, low: row.lowPrice, close: row.closePrice,
    volume: row.volume, marketCapEok: row.marketCapEok, listedShares: row.listedShares,
  };
}

function benchmarkStats(
  series: Map<string, StockDailyPriceRow[]>,
  calendar: string[],
  rebalanceDates: string[]
): string[] {
  const pricesByStock = new Map<string, { date: string; close: number }[]>();
  const liquidity = new Map<string, Map<string, number>>();
  for (const [code, rows] of series) {
    const avg = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
    const idx = new Map(rows.map((r, i) => [r.tradeDate, i]));
    const m = new Map<string, number>();
    for (const d of rebalanceDates) {
      const i = idx.get(d);
      if (i !== undefined && Number.isFinite(avg[i])) m.set(d, avg[i]);
    }
    liquidity.set(code, m);
    pricesByStock.set(code, rows.map((r) => ({ date: r.tradeDate, close: r.closePrice })));
  }
  return THRESHOLDS.map((t) => {
    const daily = simulateUniverseMonthlyRebalance(pricesByStock, calendar, START, (c, d) => (liquidity.get(c)?.get(d) ?? NaN) >= t.won);
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(daily);
    return `${t.label}: CAGR ${computeCagrPct(totalReturnPct, START, TODAY).toFixed(1)} / MDD ${mddPct.toFixed(1)}`;
  });
}

interface TradeWithCode extends BacktestTrade { stockCode: string }

function runRule(series: Map<string, StockDailyPriceRow[]>, ruleType: "reversal_breakout" | "reversal_breakout_v2"): TradeWithCode[] {
  const all: TradeWithCode[] = [];
  for (const [code, rows] of series) {
    const avg = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
    const idx = new Map(rows.map((r, i) => [r.tradeDate, i]));
    if (!rows.some((r, i) => r.tradeDate >= START && avg[i] >= PIT_MIN_AVG_TRADING_VALUE_WON)) continue;
    const entryAllowed = (d: string): boolean => {
      const i = idx.get(d);
      return i !== undefined && avg[i] >= PIT_MIN_AVG_TRADING_VALUE_WON;
    };
    const result = runBacktest(rows.map(toDailyPrice), { rule_type: ruleType, rule_params: {} }, START, undefined, undefined, { market: "KR", entryAllowed });
    if (result.insufficientData) continue;
    for (const t of result.trades) all.push({ ...t, stockCode: code });
  }
  return all;
}

async function main(): Promise<void> {
  const year = new Date().getUTCFullYear();
  const events = await loadAllEvents();
  const applied = events.filter((e) => e.status === "applied");
  console.log(`이벤트 ${events.length}건 (applied ${applied.length})`);

  const [kospi] = await Promise.all([getIndexPriceSeries("KOSPI", START, TODAY)]);
  const calendar = kospi.map((p) => p.tradeDate).sort();
  const rebalanceDates = computeMonthlyRebalanceDates(calendar.filter((d) => d >= START));

  const adjustments = await loadAppliedAdjustments();
  console.log(`조정 대상 종목 ${adjustments.size}`);
  let raw = await loadAllStockSeriesFromParquet(2011, year);
  // 1) 벤치마크 원가 vs 보정
  console.log("\n[1] 벤치마크(유니버스 월간 리밸런싱) 원가 기준:", benchmarkStats(raw, calendar, rebalanceDates).join(" | "));

  // 2-a) 이벤트 5건 OHLCV 전후 — 원가 스냅샷을 먼저 뜬다.
  const splits = applied.filter((e) => e.shares_ratio > 1);
  const merges = applied.filter((e) => e.shares_ratio < 1);
  const pick = [
    ...["005930:2018-05-04", "035720:2021-04-15"].map((k) => splits.find((e) => `${e.stock_code}:${e.event_date}` === k)),
    splits.filter((e) => e.event_date >= "2019-01-01" && e.shares_ratio >= 2 && e.shares_ratio < 20)[3],
    merges.filter((e) => e.event_date >= "2016-01-01" && e.shares_ratio >= 0.05)[2],
    merges.filter((e) => e.event_date >= "2016-01-01" && e.shares_ratio >= 0.05)[9],
  ].filter((e): e is EventRow => !!e);
  const snap = (rows: StockDailyPriceRow[] | undefined, date: string): string[] => {
    const i = rows?.findIndex((r) => r.tradeDate === date) ?? -1;
    if (!rows || i < 2) return ["행 없음"];
    return [i - 2, i - 1, i, i + 1].map((k) => {
      const r = rows[k];
      return `${r.tradeDate} O${+r.openPrice.toFixed(2)} H${+r.highPrice.toFixed(2)} L${+r.lowPrice.toFixed(2)} C${+r.closePrice.toFixed(2)} V${Math.round(r.volume)} 주식수${Math.round(r.listedShares)}`;
    });
  };
  const before = pick.map((e) => snap(raw.get(e.stock_code), e.event_date));

  // 2-b) 원가 기준 트레이드
  const rawTrades = {
    reversal_breakout: runRule(raw, "reversal_breakout"),
    reversal_breakout_v2: runRule(raw, "reversal_breakout_v2"),
  };
  const universeCalendar = calendar;
  void universeCalendar;

  // 보정 적용(제자리)
  const { applyAdjustmentsInPlace } = await import("@/lib/priceAdjustment");
  for (const [code, adj] of adjustments) {
    const rows = raw.get(code);
    if (rows) applyAdjustmentsInPlace(rows, adj);
  }
  const adjusted = raw;
  raw = new Map();

  console.log("[1] 벤치마크 보정 기준:", benchmarkStats(adjusted, calendar, rebalanceDates).join(" | "));

  console.log("\n[2-a] 이벤트 5건 보정 전(원가)/후 OHLCV·주식수");
  pick.forEach((e, n) => {
    console.log(`  ${e.stock_code} ${e.event_date} 주식수비 ${Number(e.shares_ratio).toFixed(3)} 계수 ${Number(e.adjustment_factor).toFixed(4)} (${Number(e.shares_ratio) > 1 ? "분할" : "병합"})`);
    const after = snap(adjusted.get(e.stock_code), e.event_date);
    before[n].forEach((line, k) => console.log(`    전 ${line}\n    후 ${after[k]}`));
  });

  // 2-b) 트레이드 ↔ 이벤트 겹침
  const eventsByCode = new Map<string, EventRow[]>();
  for (const e of events) {
    const l = eventsByCode.get(e.stock_code) ?? [];
    l.push(e);
    eventsByCode.set(e.stock_code, l);
  }
  const overlap = (t: TradeWithCode): string => {
    const hit = (eventsByCode.get(t.stockCode) ?? []).filter((e) => e.event_date > t.buyDate && e.event_date <= t.sellDate);
    return hit.length === 0 ? "없음" : hit.map((e) => `${e.event_date} ${e.status}${e.low_confidence_reason ? `(${e.low_confidence_reason})` : ""} 주식수비${Number(e.shares_ratio).toFixed(2)}`).join("; ");
  };
  for (const rule of ["reversal_breakout", "reversal_breakout_v2"] as const) {
    const before10 = [...rawTrades[rule]].sort((a, b) => b.returnPct - a.returnPct).slice(0, 10);
    const adjTrades = runRule(adjusted, rule);
    const adjByKey = new Map(adjTrades.map((t) => [`${t.stockCode}:${t.buyDate}`, t]));
    console.log(`\n[2-b] ${rule} 보정 전(a) 상위 10 트레이드 (전체 ${rawTrades[rule].length}건 → 보정 후 ${adjTrades.length}건)`);
    for (const t of before10) {
      const a = adjByKey.get(`${t.stockCode}:${t.buyDate}`);
      console.log(`  ${t.stockCode} ${t.buyDate}→${t.sellDate} 수익률 ${(t.returnPct * 100).toFixed(0)}% | 보유중 이벤트: ${overlap(t)} | 보정 후 동일 진입: ${a ? `${(a.returnPct * 100).toFixed(1)}%` : "없음"}`);
    }
    const worst10 = [...adjTrades].sort((a, b) => a.returnPct - b.returnPct).slice(0, 10);
    console.log(`  [보정 후 최악 10 트레이드]`);
    for (const t of worst10) {
      console.log(`  ${t.stockCode} ${t.buyDate}→${t.sellDate} 수익률 ${(t.returnPct * 100).toFixed(0)}% | 보유중 이벤트: ${overlap(t)}`);
    }
    const bigLoss = adjTrades.filter((t) => t.returnPct <= -0.5);
    console.log(`  보정 후 -50% 이하 트레이드 ${bigLoss.length}건 / 원가 ${rawTrades[rule].filter((t) => t.returnPct <= -0.5).length}건`);
  }

  // 3) 잔여 ±30% 분류
  const tradingDays = new Set(calendar);
  const sortedCal = calendar;
  const calIndex = new Map(sortedCal.map((d, i) => [d, i]));
  const lastDate = sortedCal[sortedCal.length - 1];
  void tradingDays;
  let total = 0, limitBand = 0, resume = 0, listing = 0, delisting = 0, candidateShares = 0, candidateNone = 0;
  const yearCounts = new Map<string, number>();
  for (const rows of adjusted.values()) {
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1], cur = rows[i];
      if (cur.tradeDate < PRICE_ADJUSTMENT_SCAN_FROM_DATE || !(prev.closePrice > 0) || !(cur.closePrice > 0)) continue;
      const ratio = cur.closePrice / prev.closePrice;
      if (ratio > PRICE_JUMP_RATIO_LOWER && ratio < PRICE_JUMP_RATIO_UPPER) continue;
      total++;
      const absRet = Math.abs(ratio - 1);
      if (cur.tradeDate >= PRICE_LIMIT_CHANGE_DATE && absRet <= LIMIT_TOLERANCE_RATIO) { limitBand++; continue; }
      const pi = calIndex.get(prev.tradeDate), ci = calIndex.get(cur.tradeDate);
      const gapDays = pi !== undefined && ci !== undefined ? ci - pi - 1 : 0;
      if (gapDays > 0) { resume++; continue; }
      if (i <= 2) { listing++; continue; }
      const isTail = rows.length - 1 - i <= 10 && rows[rows.length - 1].tradeDate < sortedCal[sortedCal.length - 30 > 0 ? sortedCal.length - 30 : 0];
      if (isTail) { delisting++; continue; }
      let sr = 1;
      for (let k = i; k < Math.min(rows.length, i + 3); k++) {
        const r = prev.listedShares > 0 ? rows[k].listedShares / prev.listedShares : 1;
        if (Math.abs(Math.log(r)) > Math.abs(Math.log(sr))) sr = r;
      }
      if (sr >= SHARES_CHANGE_MIN_RATIO || sr <= 1 / SHARES_CHANGE_MIN_RATIO) candidateShares++;
      else candidateNone++;
      const y = cur.tradeDate.slice(0, 4);
      yearCounts.set(y, (yearCounts.get(y) ?? 0) + 1);
    }
  }
  void lastDate;
  console.log(`\n[3] 잔여 ±30% ${total}건: 제한폭 이내(|등락|≤30.5%, ${PRICE_LIMIT_CHANGE_DATE} 이후) ${limitBand} / 거래재개(직전 행과 사이에 거래일 공백) ${resume} / 신규상장 직후(상장 2번째 이내 행) ${listing} / 정리매매(시계열 말미) ${delisting} / 미탐지 후보: 주식수 변화 동반 ${candidateShares}, 주식수 변화 없음 ${candidateNone}`);
  console.log(`  미탐지 후보 연도별: ${Array.from(yearCounts).sort().map(([y, n]) => `${y}:${n}`).join(" ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * 사용자 요청: 급등주 찾기(reversal_breakout) 손절/익절 라인 백테스트. 순수 분석 —
 * screening_results/paper_trades 등 매매 실행 테이블에는 아무것도 쓰지 않는다.
 * 진입 조건은 손대지 않고(직전 분석의 baseline: 역배열비율 0.7, 매집봉배수 3,
 * 전환확인기간 5일 — 현재 라이브 설정 그대로) 청산 로직만 변수로 둔다. 결과 확인
 * 후 이 스크립트는 삭제한다.
 *
 * 매수가: 실제 라이브 체결 방식을 코드로 확인한 결과(scripts/screen-all-stocks.ts:539,
 * signalPrice = evalPrices[last].close), 스크리닝은 매일 KST 14:30(장 마감 1시간
 * 전)에 돌고 매수는 신호 발생 "당일" current_price로 바로 체결된다 — 다음 거래일이
 * 아니다. 저장된 데이터는 일봉 단위라 14:30 시점가를 정확히 재현할 수 없어, 가장
 * 가까운 근사치인 "신호일 당일 종가"를 매수가로 쓴다.
 *
 * 청산 시뮬레이션: 신호일 다음 거래일부터 최대 20거래일(기존 분석 horizon과 통일)
 * 동안, 그날 저가가 손절선 이하면 손절가로, 그날 고가가 익절선 이상이면 익절가로
 * 청산했다고 가정한다. 같은 날 손절·익절 조건이 동시에 충족되면(장중 어느 게 먼저
 * 터졌는지 알 수 없음) 보수적으로 손절을 우선한다. 20거래일 안에 둘 다 안 터지면
 * 그날 종가로 강제 청산(시간 만료).
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/analyze-reversal-breakout-exit-backtest.ts
 */

import { downloadYearPrices } from "@/lib/stockDailyPricesStorage";
import { getAllStocks, type StockEntry } from "@/lib/stockMaster";
import { computeSMA } from "@/lib/sma";
import { computeInverseAlignmentRatio, computePrevAverageVolume, computeBreakoutFreshness } from "@/lib/reversalBreakout";
import { REVERSAL_BREAKOUT_MA_PERIODS, ACCUMULATION_LOOKBACK_DAYS } from "@/lib/reversalBreakoutConfig";

const START_YEAR = 2011;
const END_YEAR = new Date().getUTCFullYear();
const MAX_HOLDING_DAYS = 20; // 직전 분석 horizon과 통일.

// 잡주 필터 — scripts/screen-all-stocks.ts와 동일 기준값.
const EXCLUDED_NAME_SUBSTRINGS = ["스팩"];
const EXCLUDED_PRODUCT_TYPES = new Set(["RT", "EF", "EN"]);
const MIN_LISTED_MONTHS = 6;
const MIN_MARKET_CAP_EOK = 500;
const MIN_PRICE_WON = 1000;

// baseline 진입조건(현재 라이브 설정 그대로, 고정) — 직전 조건 스윕 분석의 baseline과 동일.
const RATIO_THRESHOLD = 0.7;
const MULTIPLIER = 3;
const BREAKOUT_LOOKBACK = 5;

const STOP_LOSS_VARIANTS = [0.05, 0.07, 0.1, 0.12]; // 0.07 = 현재 라이브 설정
const TAKE_PROFIT_VARIANTS = [0.1, 0.15, 0.2, 0.25, 0.3]; // 0.20 = 현재 라이브 설정

const PERIODS: { label: string; start: string; end: string }[] = [
  { label: "2011-2017", start: "2011-01-01", end: "2017-12-31" },
  { label: "2018-2022", start: "2018-01-01", end: "2022-12-31" },
  { label: "2023-2026", start: "2023-01-01", end: "2099-12-31" },
];

interface RawStockRow {
  tradeDate: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  marketCapEok: number;
}

interface StockSeries {
  code: string;
  dates: string[];
  opens: number[];
  closes: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
  marketCaps: number[];
}

async function loadAllSeries(): Promise<Map<string, StockSeries>> {
  const byStock = new Map<string, RawStockRow[]>();
  for (let year = START_YEAR; year <= END_YEAR; year++) {
    console.log(`  ${year}년 Parquet 로드 중...`);
    const rows = await downloadYearPrices(year);
    for (const r of rows) {
      let arr = byStock.get(r.stockCode);
      if (!arr) {
        arr = [];
        byStock.set(r.stockCode, arr);
      }
      arr.push({
        tradeDate: r.tradeDate,
        open: r.openPrice,
        close: r.closePrice,
        high: r.highPrice,
        low: r.lowPrice,
        volume: r.volume,
        marketCapEok: r.marketCapEok,
      });
    }
  }

  const result = new Map<string, StockSeries>();
  for (const [code, rows] of byStock) {
    rows.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
    result.set(code, {
      code,
      dates: rows.map((r) => r.tradeDate),
      opens: rows.map((r) => r.open),
      closes: rows.map((r) => r.close),
      highs: rows.map((r) => r.high),
      lows: rows.map((r) => r.low),
      volumes: rows.map((r) => r.volume),
      marketCaps: rows.map((r) => r.marketCapEok),
    });
  }
  return result;
}

function monthsSince(listedDate: string | null, asOf: Date): number | null {
  if (!listedDate) return null;
  const year = Number(listedDate.slice(0, 4));
  const month = Number(listedDate.slice(4, 6));
  const day = Number(listedDate.slice(6, 8));
  if (year < 1950 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const listed = new Date(year, month - 1, day);
  if (Number.isNaN(listed.getTime())) return null;
  return (asOf.getFullYear() - listed.getFullYear()) * 12 + (asOf.getMonth() - listed.getMonth()) - (asOf.getDate() < listed.getDate() ? 1 : 0);
}

interface DayPrecomputed {
  alignmentRatio: number;
  alignmentValidDays: number;
  breakoutDaysSinceStart: number | null;
  isBullish: boolean;
  volumeMultiple: number | null;
}

function precomputeStock(series: StockSeries): DayPrecomputed[] {
  const prices = series.dates.map((date, i) => ({ date, open: series.opens[i], close: series.closes[i], volume: series.volumes[i] }));
  const smaByPeriod = REVERSAL_BREAKOUT_MA_PERIODS.map((period) => computeSMA(series.closes, period));
  const breakoutSma = smaByPeriod[0];
  const prevAvgVolume = computePrevAverageVolume(series.volumes);

  return prices.map((p, i) => {
    const alignment = computeInverseAlignmentRatio(smaByPeriod, i);
    const breakout = computeBreakoutFreshness(prices, breakoutSma, i);
    const avg = prevAvgVolume[i];
    const volumeMultiple = avg !== undefined && avg > 0 ? p.volume / avg : null;
    return {
      alignmentRatio: alignment.ratio,
      alignmentValidDays: alignment.validDays,
      breakoutDaysSinceStart: breakout?.daysSinceStart ?? null,
      isBullish: p.close > p.open,
      volumeMultiple,
    };
  });
}

function hasAccumulationBar(pre: DayPrecomputed[], index: number, multiplier: number): boolean {
  const start = Math.max(0, index - ACCUMULATION_LOOKBACK_DAYS + 1);
  for (let i = index; i >= start; i--) {
    if (pre[i].isBullish && pre[i].volumeMultiple !== null && pre[i].volumeMultiple! >= multiplier) return true;
  }
  return false;
}

function evaluateState(pre: DayPrecomputed[], index: number): boolean | undefined {
  const day = pre[index];
  if (day.alignmentValidDays === 0) return undefined;
  if (day.breakoutDaysSinceStart === null || day.breakoutDaysSinceStart >= BREAKOUT_LOOKBACK) return false;
  if (!hasAccumulationBar(pre, index, MULTIPLIER)) return false;
  return day.alignmentRatio >= RATIO_THRESHOLD;
}

interface Signal {
  code: string;
  date: string;
  index: number;
}

function detectSignals(pre: DayPrecomputed[], code: string, dates: string[]): Signal[] {
  const signals: Signal[] = [];
  let prevState: boolean | undefined = undefined;
  for (let i = 0; i < pre.length; i++) {
    const state = evaluateState(pre, i);
    if (prevState === false && state === true) {
      signals.push({ code, date: dates[i], index: i });
    }
    prevState = state;
  }
  return signals;
}

type ExitReason = "stop" | "profit" | "expiry";

interface ExitOutcome {
  exitReason: ExitReason;
  returnPct: number;
  holdingDays: number;
}

/** 신호일(entryIndex) 종가로 매수했다고 가정하고, 다음 거래일부터 최대
 * MAX_HOLDING_DAYS 동안 손절/익절/시간만료 중 먼저 발생하는 것으로 청산한다.
 * hasProfitTarget=false면 익절 없이 손절/시간만료만 본다("손절만" 케이스). */
function simulateExit(series: StockSeries, entryIndex: number, stopPct: number, takeProfitPct: number | null): ExitOutcome | null {
  const entryPrice = series.closes[entryIndex];
  const stopPrice = entryPrice * (1 - stopPct);
  const takeProfitPrice = takeProfitPct !== null ? entryPrice * (1 + takeProfitPct) : null;

  const lastIndex = Math.min(entryIndex + MAX_HOLDING_DAYS, series.closes.length - 1);
  if (lastIndex < entryIndex + 1) return null; // 다음 거래일 데이터조차 없음.
  const reachedFullWindow = entryIndex + MAX_HOLDING_DAYS <= series.closes.length - 1;

  for (let i = entryIndex + 1; i <= lastIndex; i++) {
    const hitStop = series.lows[i] <= stopPrice;
    const hitProfit = takeProfitPrice !== null && series.highs[i] >= takeProfitPrice;
    if (hitStop) {
      // 손절/익절 동시 충족 시 보수적으로 손절 우선.
      return { exitReason: "stop", returnPct: (stopPrice - entryPrice) / entryPrice, holdingDays: i - entryIndex };
    }
    if (hitProfit) {
      return { exitReason: "profit", returnPct: (takeProfitPrice! - entryPrice) / entryPrice, holdingDays: i - entryIndex };
    }
    if (i === lastIndex && reachedFullWindow) {
      const exitPrice = series.closes[i];
      return { exitReason: "expiry", returnPct: (exitPrice - entryPrice) / entryPrice, holdingDays: i - entryIndex };
    }
  }
  // lastIndex < entryIndex + MAX_HOLDING_DAYS (데이터가 20일치를 다 못 채움) → 표본 제외.
  return null;
}

interface Stat {
  n: number;
  meanPct: number | null;
  medianPct: number | null;
  stdevPct: number | null;
  winRate: number | null;
}

function summarize(returns: number[]): Stat {
  if (returns.length === 0) return { n: 0, meanPct: null, medianPct: null, stdevPct: null, winRate: null };
  const sorted = [...returns].sort((a, b) => a - b);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const median = sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const wins = returns.filter((r) => r > 0).length;
  return {
    n: returns.length,
    meanPct: mean * 100,
    medianPct: median * 100,
    stdevPct: Math.sqrt(variance) * 100,
    winRate: wins / returns.length,
  };
}

function periodLabel(date: string): string | null {
  for (const p of PERIODS) {
    if (date >= p.start && date <= p.end) return p.label;
  }
  return null;
}

interface ExitConfig {
  label: string;
  stopPct: number;
  takeProfitPct: number | null;
}

async function main(): Promise<void> {
  console.log("########## 0. 종목 마스터 로드(잡주 필터용) ##########");
  const allStocks = await getAllStocks();
  const masterByCode = new Map<string, StockEntry>(allStocks.map((s) => [s.code, s]));
  console.log(`  종목마스터 ${allStocks.length}건 로드`);

  console.log("\n########## 1. 시세 원자료 로드(2011~" + END_YEAR + ") ##########");
  const allSeries = await loadAllSeries();
  console.log(`  종목 수: ${allSeries.size}개`);

  console.log("\n########## 2. 잡주 필터 적용 후 대상 종목 선정 ##########");
  const eligibleCodes: string[] = [];
  let excludedSpac = 0;
  let excludedReitEtfEtn = 0;
  let excludedNoMaster = 0;
  for (const code of allSeries.keys()) {
    const master = masterByCode.get(code);
    if (!master) {
      excludedNoMaster++;
      eligibleCodes.push(code);
      continue;
    }
    if (EXCLUDED_NAME_SUBSTRINGS.some((s) => master.name.includes(s))) {
      excludedSpac++;
      continue;
    }
    if (EXCLUDED_PRODUCT_TYPES.has(master.productType)) {
      excludedReitEtfEtn++;
      continue;
    }
    eligibleCodes.push(code);
  }
  console.log(`  전체 ${allSeries.size}개 중 대상 ${eligibleCodes.length}개 (스팩 제외 ${excludedSpac}, 리츠/ETF/ETN 제외 ${excludedReitEtfEtn}, 마스터 없음(통과) ${excludedNoMaster})`);

  console.log("\n########## 3. baseline 신호 탐지(진입조건 고정: 역배열비율 0.7 / 매집봉 3배 / 전환확인 5일) ##########");
  const allSignals: Signal[] = [];
  let processed = 0;
  for (const code of eligibleCodes) {
    const series = allSeries.get(code)!;
    if (series.dates.length < 60) {
      processed++;
      continue;
    }
    const pre = precomputeStock(series);
    const master = masterByCode.get(code);
    const signals = detectSignals(pre, code, series.dates);
    for (const sig of signals) {
      const marketCapEok = series.marketCaps[sig.index];
      const closePrice = series.closes[sig.index];
      if (marketCapEok < MIN_MARKET_CAP_EOK || closePrice < MIN_PRICE_WON) continue;
      if (master) {
        const months = monthsSince(master.listedDate, new Date(sig.date + "T00:00:00Z"));
        if (months !== null && months < MIN_LISTED_MONTHS) continue;
      }
      allSignals.push(sig);
    }
    processed++;
    if (processed % 200 === 0 || processed === eligibleCodes.length) {
      console.log(`  진행: ${processed}/${eligibleCodes.length}개 종목 처리 완료`);
    }
  }
  console.log(`  baseline 신호 총 ${allSignals.length}건`);

  console.log("\n########## 4. 청산 시뮬레이션 ##########");
  const configs: ExitConfig[] = [];
  for (const stopPct of STOP_LOSS_VARIANTS) {
    for (const takeProfitPct of TAKE_PROFIT_VARIANTS) {
      const isBaseline = stopPct === 0.07 && takeProfitPct === 0.2;
      configs.push({
        label: `손절${(stopPct * 100).toFixed(0)}%/익절${(takeProfitPct * 100).toFixed(0)}%${isBaseline ? "(현재 라이브)" : ""}`,
        stopPct,
        takeProfitPct,
      });
    }
  }
  configs.push({ label: "손절7%만(익절 없음, 20일 시간만료)", stopPct: 0.07, takeProfitPct: null });

  const returnsOverall = new Map<string, number[]>();
  const returnsByPeriod = new Map<string, Map<string, number[]>>();
  const exitReasonCounts = new Map<string, Record<ExitReason, number>>();
  for (const c of configs) {
    returnsOverall.set(c.label, []);
    returnsByPeriod.set(c.label, new Map(PERIODS.map((p) => [p.label, []])));
    exitReasonCounts.set(c.label, { stop: 0, profit: 0, expiry: 0 });
  }

  for (const c of configs) {
    for (const sig of allSignals) {
      const series = allSeries.get(sig.code)!;
      const outcome = simulateExit(series, sig.index, c.stopPct, c.takeProfitPct);
      if (!outcome) continue;
      returnsOverall.get(c.label)!.push(outcome.returnPct);
      const period = periodLabel(sig.date);
      if (period) returnsByPeriod.get(c.label)!.get(period)!.push(outcome.returnPct);
      exitReasonCounts.get(c.label)![outcome.exitReason]++;
    }
  }

  console.log("\n########## 5. 결과 집계 ##########");
  function fmtStat(s: Stat): string {
    if (s.n === 0) return "n=0";
    return `n=${s.n} mean=${s.meanPct!.toFixed(3)}% median=${s.medianPct!.toFixed(3)}% stdev=${s.stdevPct!.toFixed(3)}% winRate=${(s.winRate! * 100).toFixed(2)}%`;
  }

  console.log("\nRESULT_TABLE_START");
  for (const c of configs) {
    const reasons = exitReasonCounts.get(c.label)!;
    const totalExits = reasons.stop + reasons.profit + reasons.expiry;
    console.log(
      `\n--- ${c.label} --- 청산사유: 손절 ${totalExits > 0 ? ((reasons.stop / totalExits) * 100).toFixed(1) : "0"}% / 익절 ${totalExits > 0 ? ((reasons.profit / totalExits) * 100).toFixed(1) : "0"}% / 시간만료 ${totalExits > 0 ? ((reasons.expiry / totalExits) * 100).toFixed(1) : "0"}%`
    );
    console.log(`  overall  ${fmtStat(summarize(returnsOverall.get(c.label)!))}`);
    for (const p of PERIODS) {
      console.log(`  ${p.label}  ${fmtStat(summarize(returnsByPeriod.get(c.label)!.get(p.label)!))}`);
    }
  }
  console.log("RESULT_TABLE_END");

  console.log("\n=== 분석 종료 ===");
}

main().catch((error) => {
  console.error("분석 스크립트 실행 중 오류:", error);
  process.exit(1);
});

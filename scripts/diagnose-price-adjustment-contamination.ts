/**
 * [디스포저블 진단, 조사 끝나면 정리 PR로 제거] 저장된 국내 시세가 수정주가(권리조정)
 * 없이 원가(raw)로 저장돼 있는 문제의 오염 규모를 측정한다(2026-09-29 조사).
 * DB에는 아무것도 쓰지 않는다(순수 조회+계산+콘솔 출력).
 *
 * 1) 유니버스 C(discoverCandidateStockCodes, 673개)와 A'(저장된 전종목, 1,888개)에서
 *    종가 기준 일간수익률이 -40% 이하/+60% 이상인 종목-일을 전부 뽑아 "권리이벤트
 *    추정"(가격비가 정수비에 가깝고 상장주식수/거래량이 반대 방향으로 비슷한 비율로
 *    변함) vs "실제급등락 추정"으로 분류한다.
 * 2) 권리이벤트로 판정된 날짜를 이용해 종목별 "역산 수정주가" 시계열을 만든다(그
 *    이벤트 당일의 실측 비율을 그대로 조정계수로 써서, 이벤트 이전 구간 전체에
 *    누적 곱한다 — 표준 backward-adjustment). 분할류(가격 급락)만 보정/병합류(가격
 *    급등)만 보정/둘 다 보정 3가지 변형을 만든다.
 * 3) 원가 vs 각 보정본으로 벤치마크(유니버스 월간 리밸런싱)와 ma_cross/minervini
 *    백테스트의 CAGR/MDD가 어떻게 바뀌는지 비교한다.
 * 4) ma_cross 신호가 권리이벤트 당일(±3거래일)에 오작동한 구체 사례를 찾아 출력한다.
 *
 * 실행: tsx --conditions=react-server scripts/diagnose-price-adjustment-contamination.ts
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  discoverCandidateStockCodes,
  getDailyPriceSeries,
  downloadYearPrices,
  type StockDailyPriceRow,
} from "@/lib/stockDailyPricesStorage";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";
import { STRATEGY_BACKTEST_WINDOW_START_YEAR, FALLBACK_MA_CROSS_PARAMS, FALLBACK_MINERVINI_PARAMS } from "@/lib/strategyBacktestSummaryConfig";
import { runBacktest, aggregateTrades, type DailyPrice, type BacktestTrade, type StrategyRule } from "@/lib/backtest";
import { computeSMA } from "@/lib/sma";
import {
  accumulateStockDailyReturns,
  computeEqualWeightDailyReturns,
  computeCumulativeAndMdd,
  computeCagrPct,
  type DailyStockReturns,
  type StockContribution,
} from "@/lib/strategyBacktestSummary";
import { simulateUniverseMonthlyRebalance, computeCalmarRatio } from "@/lib/benchmarkSummary";

const HOT_TABLE = "stock_daily_prices_recent";
const HOT_TABLE_PAGE_SIZE = 1000;
const CURRENT_YEAR = new Date().getUTCFullYear();
const TODAY = new Date().toISOString().slice(0, 10);
const PERIOD_START_DATE = `${STRATEGY_BACKTEST_WINDOW_START_YEAR}-01-01`;
const PRICE_FETCH_START_DATE = "2014-01-01";
const BATCH_CONCURRENCY = 10;

// 극단 수익률 기준(과제 지정값).
const DROP_THRESHOLD = -0.4; // -40% 이하
const SURGE_THRESHOLD = 0.6; // +60% 이상

// 권리이벤트로 볼 "정수비" 후보(액면분할/병합/무상증자/감자에서 실제로 흔한 배수들).
const NICE_RATIOS = [1.5, 2, 2.5, 3, 4, 5, 6, 7, 7.5, 8, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 150, 200, 250, 500, 1000];
const RATIO_TOLERANCE = 0.05; // ±5%
const VOLUME_FALLBACK_TOLERANCE = 0.5; // listedShares 없을 때 거래량 교차검증 허용 오차(±50%, 보조 신호라 느슨하게)

interface EventRow {
  stockCode: string;
  index: number; // prices 배열상의 인덱스(이벤트가 관측된 날)
  date: string;
  prevClose: number;
  close: number;
  retPct: number; // 원가 기준 일간수익률(비율)
  priceRatio: number; // max/min
  nearestNiceRatio: number | null;
  priceRatioErrPct: number | null;
  sharesRatio: number | null; // listedShares 변화 비율(반대방향 정합 시 nearestNiceRatio와 비교)
  sharesRatioErrPct: number | null;
  volumeRatio: number | null;
  classification: "corporate_action" | "real_move";
  confidence: "listed_shares" | "volume_fallback" | "none";
  direction: "split_like" | "merger_like"; // 가격 급락(분할류) / 가격 급등(병합류)
}

function nearestNiceRatio(ratio: number): { nice: number; errPct: number } {
  let best = NICE_RATIOS[0];
  let bestErr = Math.abs(ratio - best) / best;
  for (const n of NICE_RATIOS) {
    const err = Math.abs(ratio - n) / n;
    if (err < bestErr) {
      best = n;
      bestErr = err;
    }
  }
  return { nice: best, errPct: bestErr };
}

/** 종목 하나의 가격 시계열에서 극단 수익률 이벤트를 찾아 분류한다. */
function detectEvents(stockCode: string, prices: DailyPrice[]): EventRow[] {
  const events: EventRow[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prevClose = prices[i - 1].close;
    const close = prices[i].close;
    if (prevClose <= 0 || close <= 0) continue;
    const retPct = (close - prevClose) / prevClose;
    if (retPct > DROP_THRESHOLD && retPct < SURGE_THRESHOLD) continue;

    const direction: "split_like" | "merger_like" = retPct < 0 ? "split_like" : "merger_like";
    const priceRatio = direction === "split_like" ? prevClose / close : close / prevClose;
    const { nice, errPct } = nearestNiceRatio(priceRatio);
    const priceRatioOk = errPct <= RATIO_TOLERANCE;

    const prevShares = prices[i - 1].listedShares;
    const curShares = prices[i].listedShares;
    let sharesRatio: number | null = null;
    let sharesRatioErrPct: number | null = null;
    let sharesDirectionOk = false;
    if (prevShares !== undefined && curShares !== undefined && prevShares > 0 && curShares > 0) {
      // 분할류라면 상장주식수가 늘어야(curShares > prevShares) 정합, 병합류라면 줄어야 정합.
      sharesDirectionOk = direction === "split_like" ? curShares > prevShares : curShares < prevShares;
      sharesRatio = sharesDirectionOk
        ? direction === "split_like"
          ? curShares / prevShares
          : prevShares / curShares
        : direction === "split_like"
          ? prevShares / curShares
          : curShares / prevShares;
      sharesRatioErrPct = Math.abs(sharesRatio - nice) / nice;
    }

    const prevVolume = prices[i - 1].volume;
    const curVolume = prices[i].volume;
    let volumeRatio: number | null = null;
    let volumeDirectionOk = false;
    if (prevVolume > 0 && curVolume > 0) {
      // 분할류(가격↓)면 거래량은 반대로 급증(curVolume > prevVolume) 하는 경향,
      // 병합류(가격↑)면 거래량 급감하는 경향(주가/유동성 반비례 근사) — 배수까지
      // 딱 맞을 필요는 없어 느슨한 허용오차만 쓴다(보조 신호).
      volumeDirectionOk = direction === "split_like" ? curVolume > prevVolume : curVolume < prevVolume;
      volumeRatio = direction === "split_like" ? curVolume / prevVolume : prevVolume / curVolume;
    }
    const volumeRatioOk =
      volumeDirectionOk && volumeRatio !== null ? Math.abs(volumeRatio - nice) / nice <= VOLUME_FALLBACK_TOLERANCE : false;

    let classification: "corporate_action" | "real_move" = "real_move";
    let confidence: "listed_shares" | "volume_fallback" | "none" = "none";
    if (priceRatioOk && sharesDirectionOk && sharesRatioErrPct !== null && sharesRatioErrPct <= RATIO_TOLERANCE) {
      classification = "corporate_action";
      confidence = "listed_shares";
    } else if (priceRatioOk && volumeRatioOk) {
      classification = "corporate_action";
      confidence = "volume_fallback";
    }

    events.push({
      stockCode,
      index: i,
      date: prices[i].date,
      prevClose,
      close,
      retPct,
      priceRatio,
      nearestNiceRatio: nice,
      priceRatioErrPct: errPct,
      sharesRatio,
      sharesRatioErrPct,
      volumeRatio,
      classification,
      confidence,
      direction,
    });
  }
  return events;
}

/** 원가 종가/시가/고가/저가 배열에, eventIndices(오름차순 무관하게 전달 가능)에서
 * 관측된 실측 비율을 조정계수로 써서 backward-adjustment를 적용한다. 이벤트 인덱스
 * i(그 날)를 기준으로 [0, i-1] 구간 전체에 factor = rawClose[i]/rawClose[i-1]을
 * 곱한다 — 여러 이벤트를 오름차순으로 처리하면 구간별로 누적 곱해져 표준적인
 * 역산 수정주가가 된다. 팩터 계산은 항상 원본(raw) 종가로 하므로 처리 순서와
 * 무관하게 각 이벤트의 팩터 자체는 정확하다.
 */
function buildAdjustedPrices(prices: DailyPrice[], eventIndices: number[]): DailyPrice[] {
  const adjOpen = prices.map((p) => p.open);
  const adjHigh = prices.map((p) => p.high);
  const adjLow = prices.map((p) => p.low);
  const adjClose = prices.map((p) => p.close);

  const sorted = [...eventIndices].sort((a, b) => a - b);
  for (const i of sorted) {
    const rawPrev = prices[i - 1].close;
    const rawCur = prices[i].close;
    if (rawPrev <= 0) continue;
    const factor = rawCur / rawPrev;
    for (let j = 0; j < i; j++) {
      adjOpen[j] *= factor;
      adjHigh[j] *= factor;
      adjLow[j] *= factor;
      adjClose[j] *= factor;
    }
  }

  return prices.map((p, idx) => ({ ...p, open: adjOpen[idx], high: adjHigh[idx], low: adjLow[idx], close: adjClose[idx] }));
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  async function runOne(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
}

async function fetchAllStoredCodes(): Promise<Set<string>> {
  const codes = new Set<string>();
  for (let year = 2011; year <= CURRENT_YEAR; year++) {
    const coldRows: StockDailyPriceRow[] = await downloadYearPrices(year);
    for (const r of coldRows) codes.add(r.stockCode);
  }
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin.from(HOT_TABLE).select("stock_code").range(from, from + HOT_TABLE_PAGE_SIZE - 1);
    if (error) throw new Error(`hot 구간 전체 종목 조회 실패: ${error.message}`);
    for (const row of data ?? []) codes.add((row as { stock_code: string }).stock_code);
    if (!data || data.length < HOT_TABLE_PAGE_SIZE) break;
    from += HOT_TABLE_PAGE_SIZE;
  }
  return codes;
}

function toDailyPrice(row: StockDailyPriceRow): DailyPrice {
  return {
    date: row.tradeDate,
    open: row.openPrice,
    high: row.highPrice,
    low: row.lowPrice,
    close: row.closePrice,
    volume: row.volume,
    marketCapEok: row.marketCapEok,
    listedShares: row.listedShares,
  };
}

function reportBenchmark(label: string, dailyReturnsPct: number[]): { cagrPct: number; mddPct: number } {
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(dailyReturnsPct);
  const cagrPct = computeCagrPct(totalReturnPct, PERIOD_START_DATE, TODAY);
  const calmarRatio = computeCalmarRatio(cagrPct, mddPct);
  console.log(`  [${label}] CAGR ${cagrPct.toFixed(2)}%, MDD ${mddPct.toFixed(2)}%, 칼마 ${calmarRatio.toFixed(2)}`);
  return { cagrPct, mddPct };
}

async function runStrategyBacktest(
  codes: string[],
  pricesByStock: Map<string, DailyPrice[]>,
  rule: StrategyRule
): Promise<{ totalTrades: number; winRate: number; cagrPct: number; mddPct: number }> {
  const trades: BacktestTrade[] = [];
  const dailyReturns: DailyStockReturns = new Map();
  const contributions = new Map<string, StockContribution>();

  for (const code of codes) {
    const prices = pricesByStock.get(code);
    if (!prices || prices.length === 0) continue;
    const result = runBacktest(prices, rule, PERIOD_START_DATE, undefined, undefined, { market: "KR" });
    if (result.insufficientData || result.trades.length === 0) continue;
    trades.push(...result.trades);
    accumulateStockDailyReturns(dailyReturns, contributions, code, prices, result.trades, PERIOD_START_DATE, "KR");
  }

  if (trades.length === 0) return { totalTrades: 0, winRate: 0, cagrPct: 0, mddPct: 0 };

  const aggregate = aggregateTrades(trades);
  const dailySeries = computeEqualWeightDailyReturns(dailyReturns);
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(dailySeries);
  const cagrPct = computeCagrPct(totalReturnPct, PERIOD_START_DATE, TODAY);

  return { totalTrades: trades.length, winRate: aggregate.winRate, cagrPct, mddPct };
}

async function main(): Promise<void> {
  console.log(`수정주가 오염 조사 시작: ${new Date().toISOString()}`);

  // ── 유니버스 구성(C, A') — diagnose-universe-expansion-*.ts와 동일 관례 ──
  const aPrimeCodes = await fetchAllStoredCodes();
  const discoveryYears = Array.from(
    { length: CURRENT_YEAR - STRATEGY_BACKTEST_WINDOW_START_YEAR + 1 },
    (_, i) => STRATEGY_BACKTEST_WINDOW_START_YEAR + i
  );
  const cCodes = new Set(await discoverCandidateStockCodes(discoveryYears, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK));
  console.log(`유니버스: C(현행) ${cCodes.size}개, A'(근사 전종목) ${aPrimeCodes.size}개`);

  console.log(`\n가격 시계열 조회 중 (${PRICE_FETCH_START_DATE} ~ ${TODAY}, A' 전체)...`);
  const pricesByStock = new Map<string, DailyPrice[]>();
  const aPrimeList = Array.from(aPrimeCodes);
  let completed = 0;
  await runWithConcurrency(aPrimeList, BATCH_CONCURRENCY, async (code) => {
    try {
      const rows = await getDailyPriceSeries(code, PRICE_FETCH_START_DATE, TODAY);
      if (rows.length > 0) pricesByStock.set(code, rows.map(toDailyPrice));
    } catch (error) {
      console.error(`  ${code} 조회 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      completed++;
      if (completed === 1 || completed % 200 === 0 || completed === aPrimeList.length) {
        console.log(`  [${completed}/${aPrimeList.length}] 조회 중...`);
      }
    }
  });
  console.log(`가격 조회 완료: ${pricesByStock.size}개 종목`);

  // ── listedShares 커버리지 실측(기존 backtest.ts 주석 "DH 레이어에서만 채워짐"이
  //    이 경로에서도 맞는지 확인) ──
  let rowsWithShares = 0;
  let rowsTotal = 0;
  for (const prices of pricesByStock.values()) {
    rowsTotal += prices.length;
    rowsWithShares += prices.filter((p) => p.listedShares !== undefined && p.listedShares > 0).length;
  }
  console.log(
    `\n=== listedShares 커버리지(getDailyPriceSeries 경로) ===\n` +
      `  전체 ${rowsTotal}행 중 listedShares 값 있음: ${rowsWithShares}행 (${((rowsWithShares / rowsTotal) * 100).toFixed(1)}%)`
  );

  // ── 1) 이벤트 탐지 + 분류(A' 전체 대상, C는 부분집합으로 필터링) ──
  console.log("\n=== 1) 극단 수익률(-40%↓ / +60%↑) 종목-일 탐지 및 분류 ===");
  const eventsByStock = new Map<string, EventRow[]>();
  let totalEvents = 0;
  for (const [code, prices] of pricesByStock) {
    const events = detectEvents(code, prices);
    if (events.length > 0) {
      eventsByStock.set(code, events);
      totalEvents += events.length;
    }
  }
  console.log(`A' 전체 이벤트: ${totalEvents}건 (${eventsByStock.size}개 종목)`);

  function summarize(label: string, codes: Set<string>): EventRow[] {
    const filtered: EventRow[] = [];
    for (const [code, events] of eventsByStock) {
      if (codes.has(code)) filtered.push(...events);
    }
    const corp = filtered.filter((e) => e.classification === "corporate_action");
    const real = filtered.filter((e) => e.classification === "real_move");
    const corpListedShares = corp.filter((e) => e.confidence === "listed_shares");
    const corpVolumeFallback = corp.filter((e) => e.confidence === "volume_fallback");
    const corpSplit = corp.filter((e) => e.direction === "split_like");
    const corpMerger = corp.filter((e) => e.direction === "merger_like");
    console.log(
      `\n[${label}] 이벤트 총 ${filtered.length}건\n` +
        `  권리이벤트 추정: ${corp.length}건 (listedShares 근거 ${corpListedShares.length}건 / 거래량만 근거 ${corpVolumeFallback.length}건)\n` +
        `    분할류(가격급락) ${corpSplit.length}건, 병합류(가격급등) ${corpMerger.length}건\n` +
        `  실제급등락 추정: ${real.length}건 (급락 ${real.filter((e) => e.direction === "split_like").length}건, 급등 ${real.filter((e) => e.direction === "merger_like").length}건)`
    );
    return filtered;
  }

  summarize("C(현행, 673개 근사)", cCodes);
  const aEvents = summarize("A'(근사 전종목)", aPrimeCodes);

  // 실제급등락 추정 중 정수비에 근접했지만(오탐 위험 확인용) listedShares/거래량이
  // 안 맞아 걸러진 표본을 몇 개 보여준다(오탐 위험 정성 확인).
  const nearMissReal = aEvents
    .filter((e) => e.classification === "real_move" && e.priceRatioErrPct !== null && e.priceRatioErrPct <= RATIO_TOLERANCE)
    .slice(0, 8);
  console.log(
    `\n실제급등락으로 분류됐지만 가격비만 정수비에 근접한 표본(오탐 위험 확인, ${nearMissReal.length}건 표시):`
  );
  for (const e of nearMissReal) {
    console.log(
      `  ${e.stockCode} ${e.date}: ${(e.retPct * 100).toFixed(1)}%, 가격비 ${e.priceRatio.toFixed(2)}(≈${e.nearestNiceRatio}, 오차 ${(
        (e.priceRatioErrPct ?? 0) * 100
      ).toFixed(1)}%), sharesRatio=${e.sharesRatio?.toFixed(2) ?? "N/A"}, volumeRatio=${e.volumeRatio?.toFixed(2) ?? "N/A"}`
    );
  }

  // ── 2) 종목별 보정 시계열 생성(분할만/병합만/둘다) ──
  console.log("\n=== 2) 역산 수정주가 생성 및 벤치마크/전략 CAGR·MDD 재계산 ===");
  const splitOnlyByStock = new Map<string, DailyPrice[]>();
  const mergerOnlyByStock = new Map<string, DailyPrice[]>();
  const bothByStock = new Map<string, DailyPrice[]>();

  for (const [code, prices] of pricesByStock) {
    const events = (eventsByStock.get(code) ?? []).filter((e) => e.classification === "corporate_action");
    if (events.length === 0) {
      splitOnlyByStock.set(code, prices);
      mergerOnlyByStock.set(code, prices);
      bothByStock.set(code, prices);
      continue;
    }
    const splitIdx = events.filter((e) => e.direction === "split_like").map((e) => e.index);
    const mergerIdx = events.filter((e) => e.direction === "merger_like").map((e) => e.index);
    const allIdx = events.map((e) => e.index);
    splitOnlyByStock.set(code, splitIdx.length > 0 ? buildAdjustedPrices(prices, splitIdx) : prices);
    mergerOnlyByStock.set(code, mergerIdx.length > 0 ? buildAdjustedPrices(prices, mergerIdx) : prices);
    bothByStock.set(code, buildAdjustedPrices(prices, allIdx));
  }

  const kospiSeries = await getIndexPriceSeries("KOSPI", PERIOD_START_DATE, TODAY);
  const tradeDateCalendar = kospiSeries.map((p) => p.tradeDate);

  function subMap(map: Map<string, DailyPrice[]>, codes: Set<string>): Map<string, DailyPrice[]> {
    const out = new Map<string, DailyPrice[]>();
    for (const code of codes) {
      const p = map.get(code);
      if (p) out.set(code, p);
    }
    return out;
  }

  console.log("\n--- 벤치마크(유니버스 동일가중 월간 리밸런싱, 비용 반영) ---");
  for (const [label, codes] of [["C", cCodes] as const, ["A'", aPrimeCodes] as const]) {
    console.log(` [${label}]`);
    reportBenchmark("원가(raw)", simulateUniverseMonthlyRebalance(subMap(pricesByStock, codes), tradeDateCalendar, PERIOD_START_DATE));
    reportBenchmark(
      "분할만 보정",
      simulateUniverseMonthlyRebalance(subMap(splitOnlyByStock, codes), tradeDateCalendar, PERIOD_START_DATE)
    );
    reportBenchmark(
      "병합만 보정",
      simulateUniverseMonthlyRebalance(subMap(mergerOnlyByStock, codes), tradeDateCalendar, PERIOD_START_DATE)
    );
    reportBenchmark("분할+병합 모두 보정", simulateUniverseMonthlyRebalance(subMap(bothByStock, codes), tradeDateCalendar, PERIOD_START_DATE));
  }

  console.log("\n--- ma_cross 전략(대표 파라미터 20/60, 비용 반영) ---");
  const maCrossRule: StrategyRule = { rule_type: "ma_cross", rule_params: FALLBACK_MA_CROSS_PARAMS };
  for (const [label, codes] of [["C", cCodes] as const, ["A'", aPrimeCodes] as const]) {
    const codesArr = Array.from(codes);
    const raw = await runStrategyBacktest(codesArr, pricesByStock, maCrossRule);
    const splitOnly = await runStrategyBacktest(codesArr, splitOnlyByStock, maCrossRule);
    const mergerOnly = await runStrategyBacktest(codesArr, mergerOnlyByStock, maCrossRule);
    const both = await runStrategyBacktest(codesArr, bothByStock, maCrossRule);
    console.log(
      ` [${label}] 원가 CAGR ${raw.cagrPct.toFixed(2)}%/MDD ${raw.mddPct.toFixed(2)}% (거래 ${raw.totalTrades}건, 승률 ${(raw.winRate * 100).toFixed(1)}%)\n` +
        `   → 분할만 보정 CAGR ${splitOnly.cagrPct.toFixed(2)}%/MDD ${splitOnly.mddPct.toFixed(2)}% (거래 ${splitOnly.totalTrades}건)\n` +
        `   → 병합만 보정 CAGR ${mergerOnly.cagrPct.toFixed(2)}%/MDD ${mergerOnly.mddPct.toFixed(2)}% (거래 ${mergerOnly.totalTrades}건)\n` +
        `   → 둘 다 보정 CAGR ${both.cagrPct.toFixed(2)}%/MDD ${both.mddPct.toFixed(2)}% (거래 ${both.totalTrades}건, 승률 ${(both.winRate * 100).toFixed(1)}%)`
    );
  }

  console.log("\n--- minervini_trend_template 전략(대표 파라미터 50/150/200, 비용 반영, 원가 vs 둘다보정만) ---");
  const minerviniRule: StrategyRule = { rule_type: "minervini_trend_template", rule_params: FALLBACK_MINERVINI_PARAMS };
  for (const [label, codes] of [["C", cCodes] as const, ["A'", aPrimeCodes] as const]) {
    const codesArr = Array.from(codes);
    const raw = await runStrategyBacktest(codesArr, pricesByStock, minerviniRule);
    const both = await runStrategyBacktest(codesArr, bothByStock, minerviniRule);
    console.log(
      ` [${label}] 원가 CAGR ${raw.cagrPct.toFixed(2)}%/MDD ${raw.mddPct.toFixed(2)}% (거래 ${raw.totalTrades}건) → ` +
        `둘다보정 CAGR ${both.cagrPct.toFixed(2)}%/MDD ${both.mddPct.toFixed(2)}% (거래 ${both.totalTrades}건)`
    );
  }

  // ── 3) 실제 트레이드 오작동 사례 찾기(ma_cross, C 유니버스) ──
  console.log("\n=== 3) ma_cross 신호 오작동 실제 사례(권리이벤트일 ±3거래일 내 교차 발생) ===");
  const { short_period, long_period } = FALLBACK_MA_CROSS_PARAMS;
  let examplesShown = 0;
  const EXAMPLE_LIMIT = 5;
  for (const code of cCodes) {
    if (examplesShown >= EXAMPLE_LIMIT) break;
    const prices = pricesByStock.get(code);
    const events = (eventsByStock.get(code) ?? []).filter((e) => e.classification === "corporate_action");
    if (!prices || events.length === 0) continue;

    const closes = prices.map((p) => p.close);
    const shortSMA = computeSMA(closes, short_period);
    const longSMA = computeSMA(closes, long_period);
    const states = prices.map((_, i) => {
      const s = shortSMA[i];
      const l = longSMA[i];
      if (s === undefined || l === undefined) return undefined;
      return s > l;
    });

    for (const event of events) {
      for (let d = Math.max(1, event.index - 3); d <= Math.min(prices.length - 1, event.index + 3); d++) {
        const prev = states[d - 1];
        const cur = states[d];
        if (prev === undefined || cur === undefined || prev === cur) continue;
        if (examplesShown >= EXAMPLE_LIMIT) break;
        const type = !prev && cur ? "골든크로스(매수)" : "데드크로스(매도)";
        console.log(
          `  [${code}] ${prices[d].date} ${type} — 권리이벤트일 ${event.date}(${event.direction === "split_like" ? "분할류" : "병합류"}, ` +
            `가격 ${(event.retPct * 100).toFixed(1)}%, ≈${event.nearestNiceRatio}:1) 대비 ${d - event.index}거래일차.\n` +
            `    SMA${short_period}=${shortSMA[d]?.toFixed(0)}, SMA${long_period}=${longSMA[d]?.toFixed(0)}, 종가(원가)=${prices[d].close.toFixed(0)}` +
            `(전일 ${prices[d - 1].close.toFixed(0)})`
        );
        examplesShown++;
      }
    }
  }
  if (examplesShown === 0) console.log("  C 유니버스에서 ±3거래일 내 교차 사례를 찾지 못했습니다(A'로 범위를 넓혀야 할 수 있음).");

  console.log("\n완료");
}

main().catch((error) => {
  console.error("수정주가 오염 조사 중 오류:", error);
  process.exit(1);
});

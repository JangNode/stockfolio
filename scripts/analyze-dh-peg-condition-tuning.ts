/**
 * (임시) DH전략(대형 배당·가치주)/PEG전략(피터린치)의 과거 신호를 재현해 조건
 * 튜닝으로 사후수익률을 높일 여지가 있는지 분석하는 디스포저블 스크립트. 코드
 * 조건 값(lib/dhStrategyConfig.ts, lib/pegConfig.ts)은 전혀 바꾸지 않는다 — 여러
 * 후보 조건을 스윕해 baseline과 비교하는 읽기 전용 분석만 한다.
 *
 * 방법론(급등주 찾기(reversal_breakout) 분석 때와 동일한 방식):
 * 1. lib/backtest.ts의 computeDhValueDividendStates/computePegLynchStates는 export되지
 *    않아 직접 import할 수 없으므로, 그 판정 로직을 이 스크립트 안에 그대로
 *    재구현한다(단, point-in-time 헬퍼(pickFundamentalsAsOf/pickDividendsPaidAsOf/
 *    computeValuationFromSeries)와 evaluateConsecutiveDividendYears/
 *    computeConsecutiveDividendYearsCount(lib/backtest.ts, export됨),
 *    selectEpsCagrFiscalYears/computeEpsCagrFromResolvedShares/computePeg
 *    (lib/pegRatio.ts, export됨)는 전부 프로덕션 함수를 그대로 재사용한다).
 * 2. detectStateTransitions와 동일하게 false→true 첫 전환일(golden)만 신호로
 *    카운트한다 — 연속 유지일을 전부 세면 표본이 겹쳐 통계가 왜곡된다.
 * 3. 종목별 원자료(가격 시리즈, 재무/배당 시리즈)는 종목당 딱 한 번만 로드하고,
 *    그 시점에 필요한 모든 파생값(PER/PBR/배당 연속연수 카운트/EPS CAGR 3년·5년)을
 *    날짜별로 한 번에 계산해 메모리에 캐싱한다. 조건 조합(콤보)별 스윕은 이 캐시에서
 *    필터링만 하고 DB/Storage 재조회를 하지 않는다.
 *
 * 후보종목 풀은 프로덕션 scanFundamentalStrategies와 동일하게
 * discoverCandidateStockCodes(2011~올해, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK)로 뽑는다
 * (DH전략/PEG전략 둘 다 이 풀을 공유한다 — screen-all-stocks.ts의
 * FUNDAMENTAL_RULE_TYPES 처리와 동일).
 *
 * 읽기 전용, DB/Storage 조회만 하고 아무것도 쓰지 않는다. 확인 후 분석 결과 보고 뒤
 * 이 스크립트와 워크플로는 정리 PR로 삭제한다.
 *
 * tsx --conditions=react-server scripts/analyze-dh-peg-condition-tuning.ts
 */
import { discoverCandidateStockCodes, getDailyPriceSeries, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { loadFundamentalsSeriesWithListedShares, type FundamentalsSeries } from "@/lib/stockFundamentals";
import { pickFundamentalsAsOf, pickDividendsPaidAsOf, computeValuationFromSeries } from "@/lib/pointInTimeFundamentals";
import { computeConsecutiveDividendYearsCount } from "@/lib/backtest";
import { selectEpsCagrFiscalYears, computeEpsCagrFromResolvedShares, computePeg, type ListedSharesByFiscalYear } from "@/lib/pegRatio";
import { DH_MIN_MARKET_CAP_EOK, DH_MAX_PER, DH_MAX_PBR, DH_MIN_CONSECUTIVE_DIVIDEND_YEARS } from "@/lib/dhStrategyConfig";
import { PEG_MAX_RATIO, PEG_GROWTH_LOOKBACK_YEARS } from "@/lib/pegConfig";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";

// ===== 분석 범위 =====
const ANALYSIS_START_DATE = "2011-01-01"; // scripts/screen-all-stocks.ts의 FUNDAMENTAL_CANDIDATE_START_YEAR와 동일
const HORIZONS_TRADING_DAYS = [20, 60, 120];
const CONCURRENCY = 8;
const PROGRESS_LOG_INTERVAL = 50;

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

type PeriodKey = "2011-2017" | "2018-2022" | "2023-2026" | "ALL";
const SUB_PERIODS: PeriodKey[] = ["2011-2017", "2018-2022", "2023-2026"];

function periodOf(date: string): PeriodKey {
  const year = Number(date.slice(0, 4));
  if (year <= 2017) return "2011-2017";
  if (year <= 2022) return "2018-2022";
  return "2023-2026";
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

// ===== 종목당 한 번만 계산해 캐싱하는 날짜별 파생값 =====
interface DayFeature {
  marketCapEok: number;
  hasFundamentals: boolean;
  per: number | null;
  pbr: number | null;
  netIncomeParent: number | null;
  dividendYearsCount: number; // computeConsecutiveDividendYearsCount 그대로(하한 없이 실제 연속 연수)
  epsCagr3PairExists: boolean;
  epsCagr3: number | null;
  epsCagr5PairExists: boolean;
  epsCagr5: number | null;
}

function buildDayFeatures(
  prices: StockDailyPriceRow[],
  fundamentals: FundamentalsSeries,
  listedSharesByFiscalYear: ListedSharesByFiscalYear
): DayFeature[] {
  return prices.map((p) => {
    const fund = pickFundamentalsAsOf(fundamentals, p.tradeDate);
    const hasFundamentals = fund !== null;
    const { per, pbr } = computeValuationFromSeries(p.closePrice, p.listedShares, fund);
    const dividends = pickDividendsPaidAsOf(fundamentals, p.tradeDate);
    const dividendYearsCount = computeConsecutiveDividendYearsCount(dividends, p.tradeDate);

    const pair3 = selectEpsCagrFiscalYears(fundamentals, p.tradeDate, 3);
    const pair5 = selectEpsCagrFiscalYears(fundamentals, p.tradeDate, 5);
    const epsCagr3 = pair3 ? computeEpsCagrFromResolvedShares(pair3, listedSharesByFiscalYear, 3) : null;
    const epsCagr5 = pair5 ? computeEpsCagrFromResolvedShares(pair5, listedSharesByFiscalYear, 5) : null;

    return {
      marketCapEok: p.marketCapEok,
      hasFundamentals,
      per,
      pbr,
      netIncomeParent: fund?.netIncomeParent ?? null,
      dividendYearsCount,
      epsCagr3PairExists: pair3 !== null,
      epsCagr3,
      epsCagr5PairExists: pair5 !== null,
      epsCagr5,
    };
  });
}

// ===== DH전략 조건 콤보 =====
interface DhParams {
  perMax: number;
  pbrMax: number;
  minDividendYears: number;
  minMarketCapEok: number;
}
const DH_BASELINE: DhParams = {
  perMax: DH_MAX_PER,
  pbrMax: DH_MAX_PBR,
  minDividendYears: DH_MIN_CONSECUTIVE_DIVIDEND_YEARS,
  minMarketCapEok: DH_MIN_MARKET_CAP_EOK,
};

function dhLabel(p: DhParams): string {
  return `PER${p.perMax}_PBR${p.pbrMax}_DIV${p.minDividendYears}Y_CAP${p.minMarketCapEok}`;
}

interface Combo<P> {
  label: string;
  params: P;
}

function buildDhCombos(): Combo<DhParams>[] {
  const combos: Combo<DhParams>[] = [];
  const add = (overrides: Partial<DhParams>, note?: string) => {
    const params = { ...DH_BASELINE, ...overrides };
    combos.push({ label: dhLabel(params) + (note ? `(${note})` : ""), params });
  };
  add({}, "baseline");
  for (const v of [10, 20]) add({ perMax: v });
  for (const v of [1.0, 2.0]) add({ pbrMax: v });
  add({ minDividendYears: 3 });
  for (const v of [5000, 20000]) add({ minMarketCapEok: v });
  return combos;
}

/** computeDhValueDividendStates(lib/backtest.ts)와 동일한 순서·조건의 판정을 재구현한다.
 * marketCapEok/listedShares는 이 스크립트의 가격 원자료(DH 가격 레이어)엔 항상 있으므로
 * undefined 분기는 프로덕션과 달리 생략한다(그 분기가 필요한 건 KIS 일봉처럼 이 필드가
 * 없는 시리즈를 넘길 때뿐이다). */
function dhState(f: DayFeature, params: DhParams): boolean | undefined {
  if (f.marketCapEok < params.minMarketCapEok) return false;
  if (!f.hasFundamentals) return undefined;
  if (f.per === null || f.per > params.perMax) return false;
  if (f.pbr === null || f.pbr > params.pbrMax) return false;
  return f.dividendYearsCount >= params.minDividendYears;
}

// ===== PEG전략 조건 콤보 =====
interface PegParams {
  pegMax: number;
  cagrYears: 3 | 5;
}
const PEG_BASELINE: PegParams = { pegMax: PEG_MAX_RATIO, cagrYears: PEG_GROWTH_LOOKBACK_YEARS as 3 | 5 };

function pegLabel(p: PegParams): string {
  return `PEG${p.pegMax}_CAGR${p.cagrYears}Y`;
}

function buildPegCombos(): Combo<PegParams>[] {
  const combos: Combo<PegParams>[] = [];
  const add = (overrides: Partial<PegParams>, note?: string) => {
    const params = { ...PEG_BASELINE, ...overrides };
    combos.push({ label: pegLabel(params) + (note ? `(${note})` : ""), params });
  };
  add({}, "baseline");
  for (const v of [0.5, 1.5]) add({ pegMax: v });
  add({ cagrYears: 3 });
  return combos;
}

/** computePegLynchStates(lib/backtest.ts)와 동일한 순서·조건의 판정을 재구현한다. */
function pegState(f: DayFeature, params: PegParams): boolean | undefined {
  if (!f.hasFundamentals) return undefined;
  if (f.netIncomeParent === null) return undefined;
  if (f.netIncomeParent <= 0) return false;

  const pairExists = params.cagrYears === 5 ? f.epsCagr5PairExists : f.epsCagr3PairExists;
  if (!pairExists) return undefined;
  const growthPct = params.cagrYears === 5 ? f.epsCagr5 : f.epsCagr3;

  const peg = computePeg(f.per, growthPct);
  if (peg === null) return false;
  return peg <= params.pegMax;
}

// ===== detectStateTransitions(lib/backtest.ts) 재구현: false→true 첫 전환일만 =====
function detectGoldenSignalIndices(states: (boolean | undefined)[]): number[] {
  const indices: number[] = [];
  for (let i = 1; i < states.length; i++) {
    const prev = states[i - 1];
    const cur = states[i];
    if (prev === undefined || cur === undefined) continue;
    if (!prev && cur) indices.push(i);
  }
  return indices;
}

// ===== 통계 집계 =====
interface StatBucket {
  totalSignals: number;
  insufficient: number;
  values: number[]; // 사후수익률(%), horizon 데이터가 충분한 신호만
}

function getBucket(map: Map<string, StatBucket>, comboLabel: string, period: PeriodKey, horizon: number): StatBucket {
  const key = `${comboLabel}|${period}|${horizon}`;
  let bucket = map.get(key);
  if (!bucket) {
    bucket = { totalSignals: 0, insufficient: 0, values: [] };
    map.set(key, bucket);
  }
  return bucket;
}

function recordSignal(
  map: Map<string, StatBucket>,
  comboLabel: string,
  idx: number,
  prices: StockDailyPriceRow[]
): void {
  const date = prices[idx].tradeDate;
  const period = periodOf(date);
  for (const h of HORIZONS_TRADING_DAYS) {
    for (const p of [period, "ALL"] as PeriodKey[]) {
      const bucket = getBucket(map, comboLabel, p, h);
      bucket.totalSignals++;
      if (idx + h < prices.length) {
        const ret = ((prices[idx + h].closePrice - prices[idx].closePrice) / prices[idx].closePrice) * 100;
        bucket.values.push(ret);
      } else {
        bucket.insufficient++;
      }
    }
  }
}

function formatNum(n: number): string {
  return n.toFixed(2);
}

function printStatsTable(
  strategyName: string,
  combos: Combo<unknown>[],
  statsMap: Map<string, StatBucket>
): void {
  console.log(`\n########## ${strategyName} 조건별 사후수익률 (RESULT 라인 파싱용) ##########`);
  const periods: PeriodKey[] = [...SUB_PERIODS, "ALL"];
  for (const combo of combos) {
    for (const period of periods) {
      for (const h of HORIZONS_TRADING_DAYS) {
        const bucket = getBucket(statsMap, combo.label, period, h);
        if (bucket.totalSignals === 0) {
          console.log(`RESULT strategy=${strategyName} combo=${combo.label} period=${period} horizon=${h}d signals=0`);
          continue;
        }
        const usable = bucket.values;
        const meanRet = usable.length > 0 ? formatNum(mean(usable)) : "NA";
        const medianRet = usable.length > 0 ? formatNum(median(usable)) : "NA";
        console.log(
          `RESULT strategy=${strategyName} combo=${combo.label} period=${period} horizon=${h}d ` +
            `signals=${bucket.totalSignals} usable=${usable.length} insufficient=${bucket.insufficient} ` +
            `mean=${meanRet}% median=${medianRet}%`
        );
      }
    }
  }
}

interface LoadedStock {
  code: string;
  prices: StockDailyPriceRow[];
  features: DayFeature[];
}

async function loadStock(code: string, endDate: string): Promise<LoadedStock | null> {
  const [prices, fundamentalsData] = await Promise.all([
    getDailyPriceSeries(code, ANALYSIS_START_DATE, endDate),
    loadFundamentalsSeriesWithListedShares(code),
  ]);
  if (prices.length === 0) return null;
  if (fundamentalsData.series.annual.length === 0) return null; // 공시된 재무가 아예 없음 — DH/PEG 신호가 나올 수 없음

  const features = buildDayFeatures(prices, fundamentalsData.series, fundamentalsData.listedSharesByFiscalYear);
  return { code, prices, features };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const endDate = todayIsoDate();
  console.log(`분석 시작: ${new Date(startedAt).toISOString()} (구간 ${ANALYSIS_START_DATE} ~ ${endDate})`);

  const currentYear = new Date().getUTCFullYear();
  const years = Array.from({ length: currentYear - 2011 + 1 }, (_, i) => 2011 + i);
  const candidateCodes = await discoverCandidateStockCodes(years, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK);
  console.log(`후보종목 수: ${candidateCodes.length}`);

  const dhCombos = buildDhCombos();
  const pegCombos = buildPegCombos();
  console.log(`DH전략 콤보 ${dhCombos.length}개: ${dhCombos.map((c) => c.label).join(", ")}`);
  console.log(`PEG전략 콤보 ${pegCombos.length}개: ${pegCombos.map((c) => c.label).join(", ")}`);

  const dhStats = new Map<string, StatBucket>();
  const pegStats = new Map<string, StatBucket>();

  let loaded = 0;
  let skippedNoData = 0;
  let errors = 0;
  let completed = 0;

  await runWithConcurrency(candidateCodes, CONCURRENCY, async (code) => {
    try {
      const stock = await loadStock(code, endDate);
      if (!stock) {
        skippedNoData++;
        return;
      }
      loaded++;

      for (const combo of dhCombos) {
        const states = stock.features.map((f) => dhState(f, combo.params));
        const signalIndices = detectGoldenSignalIndices(states);
        for (const idx of signalIndices) recordSignal(dhStats, combo.label, idx, stock.prices);
      }

      for (const combo of pegCombos) {
        const states = stock.features.map((f) => pegState(f, combo.params));
        const signalIndices = detectGoldenSignalIndices(states);
        for (const idx of signalIndices) recordSignal(pegStats, combo.label, idx, stock.prices);
      }
    } catch (error) {
      errors++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${code} 처리 중 오류, 건너뜁니다: ${message}`);
    } finally {
      completed++;
      if (completed === 1 || completed % PROGRESS_LOG_INTERVAL === 0 || completed === candidateCodes.length) {
        console.log(
          `  [${completed}/${candidateCodes.length}] 진행 중... (로드 성공 ${loaded}, 재무 없음 ${skippedNoData}, 오류 ${errors})`
        );
      }
    }
  });

  console.log(
    `\n데이터 로드 완료: 후보 ${candidateCodes.length}개 중 로드 성공 ${loaded}개, 재무 없음(신호 불가) ${skippedNoData}개, 오류 ${errors}개`
  );

  printStatsTable("DH", dhCombos, dhStats);
  printStatsTable("PEG", pegCombos, pegStats);

  const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`\n분석 종료: ${elapsedMin}분 소요`);
}

main().catch((error) => {
  console.error("분석 중 오류가 발생했습니다:", error);
  process.exit(1);
});

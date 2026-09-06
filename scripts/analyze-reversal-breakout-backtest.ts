/**
 * 사용자 요청: 급등주 찾기(reversal_breakout) 스크리닝 신호를 2011~2026년 실제
 * 저장된 시세로 point-in-time 백테스트하고, 조건 튜닝으로 사후 수익률을 높일 여지가
 * 있는지 분석한다. 순수 분석 — screening_results/paper_trades 등 매매 실행
 * 테이블에는 아무것도 쓰지 않는다. 결과 확인 후 이 스크립트는 삭제한다.
 *
 * 데이터: stock-daily-prices Storage(연도별 Parquet, 2011~2026)를 통째로 읽어 종목별
 * 시계열로 재구성한다. 2026-09-06 재백필로 시가(open)/거래량(volume)이 추가돼 있어야
 * reversal_breakout의 매집봉 판정(거래량 배수 + 양봉)을 계산할 수 있다(그 전까지는
 * 종가/시총/상장주식수만 있었다).
 *
 * 판정 로직은 lib/reversalBreakout.ts의 계산 함수(computeInverseAlignmentRatio/
 * computePrevAverageVolume/computeBreakoutFreshness)를 그대로 재사용해 baseline(현재
 * 운영 중인 기준값)을 정확히 재현한다. 조건 스윕(역배열비율/매집봉배수/전환확인기간)은
 * 이 원시 계산값에 다른 임계값을 적용하는 방식으로 구현한다 — 판정 알고리즘 자체를
 * 새로 만들지 않는다.
 *
 * "신호"는 상태가 false/undefined → true로 바뀌는 첫날만 센다(lib/backtest.ts의
 * detectStateTransitions와 동일한 정의) — 상태가 여러 날 연속으로 유지되는 매일을
 * 전부 별개 신호로 세면 사후수익률 표본이 서로 크게 겹쳐(autocorrelation) 통계가
 * 왜곡된다.
 *
 * 잡주 필터(scripts/screen-all-stocks.ts와 동일 기준)는 point-in-time으로 적용
 * 가능한 항목만 적용한다: 스팩/리츠·ETF·ETN(정적 분류, 오늘 기준 마스터로 근사),
 * 신규상장 6개월 미만(상장일 자체는 고정값이라 신호 발생일 기준으로 정확히 계산),
 * 시총 500억/가격 1000원 미만(그 날짜의 실제 저장값 기준). 관리종목·거래정지·정리매매
 * 여부는 과거 이력이 없고 "오늘 기준"만 확인 가능해 미래 데이터 누수가 되므로 이
 * 백테스트에서는 적용하지 않는다(한계로 보고서에 명시).
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/analyze-reversal-breakout-backtest.ts
 */

import { downloadYearPrices } from "@/lib/stockDailyPricesStorage";
import { getAllStocks, type StockEntry } from "@/lib/stockMaster";
import { computeSMA } from "@/lib/sma";
import { computeInverseAlignmentRatio, computePrevAverageVolume, computeBreakoutFreshness } from "@/lib/reversalBreakout";
import { REVERSAL_BREAKOUT_MA_PERIODS, ACCUMULATION_LOOKBACK_DAYS } from "@/lib/reversalBreakoutConfig";

const START_YEAR = 2011;
const END_YEAR = new Date().getUTCFullYear();
const FORWARD_HORIZONS = [5, 10, 20] as const;

// 잡주 필터 — scripts/screen-all-stocks.ts와 동일 기준값.
const EXCLUDED_NAME_SUBSTRINGS = ["스팩"];
const EXCLUDED_PRODUCT_TYPES = new Set(["RT", "EF", "EN"]);
const MIN_LISTED_MONTHS = 6;
const MIN_MARKET_CAP_EOK = 500;
const MIN_PRICE_WON = 1000;

// 조건 스윕 — baseline은 각 배열의 첫 값(현재 운영 중인 기준값, lib/reversalBreakoutConfig.ts).
const RATIO_VARIANTS = [0.7, 0.8, 0.9];
const MULTIPLIER_VARIANTS = [3, 4, 5];
const BREAKOUT_LOOKBACK_VARIANTS = [5, 3, 7];

const PERIODS: { label: string; start: string; end: string }[] = [
  { label: "2011-2017", start: "2011-01-01", end: "2017-12-31" },
  { label: "2018-2022", start: "2018-01-01", end: "2022-12-31" },
  { label: "2023-2026", start: "2023-01-01", end: "2099-12-31" },
];

interface RawStockRow {
  tradeDate: string;
  open: number;
  close: number;
  volume: number;
  marketCapEok: number;
}

interface StockSeries {
  code: string;
  dates: string[];
  opens: number[];
  closes: number[];
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
      arr.push({ tradeDate: r.tradeDate, open: r.openPrice, close: r.closePrice, volume: r.volume, marketCapEok: r.marketCapEok });
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
  volumeMultiple: number | null; // 그날 거래량 ÷ 그날 직전 20일 평균(당일 제외). 계산 불가면 null.
}

/** 종목 하나의 원시 계산값(역배열비율/전환신호 경과일/그날 자체의 거래량배수+양봉여부)을
 * 하루 단위로 미리 계산해둔다 — lib/reversalBreakout.ts의 계산 함수를 그대로 재사용하되,
 * 매집봉 배수 임계값 스윕을 위해 "그날 자체의 배수"만 별도로 뽑아둔다(임계값 비교는
 * evaluateState에서 한다). */
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

/** index일 기준 최근 ACCUMULATION_LOOKBACK_DAYS일 내에 거래량배수>=multiplier이면서
 * 양봉인 날이 하나라도 있는지(findAccumulationBar의 불리언 버전, 스윕용). */
function hasAccumulationBar(pre: DayPrecomputed[], index: number, multiplier: number): boolean {
  const start = Math.max(0, index - ACCUMULATION_LOOKBACK_DAYS + 1);
  for (let i = index; i >= start; i--) {
    if (pre[i].isBullish && pre[i].volumeMultiple !== null && pre[i].volumeMultiple! >= multiplier) return true;
  }
  return false;
}

function evaluateState(pre: DayPrecomputed[], index: number, ratioThreshold: number, multiplier: number, breakoutLookback: number): boolean | undefined {
  const day = pre[index];
  if (day.alignmentValidDays === 0) return undefined;
  if (day.breakoutDaysSinceStart === null || day.breakoutDaysSinceStart >= breakoutLookback) return false;
  if (!hasAccumulationBar(pre, index, multiplier)) return false;
  return day.alignmentRatio >= ratioThreshold;
}

interface Signal {
  code: string;
  date: string;
  index: number;
}

function detectSignals(pre: DayPrecomputed[], ratioThreshold: number, multiplier: number, breakoutLookback: number, code: string, dates: string[]): Signal[] {
  const signals: Signal[] = [];
  let prevState: boolean | undefined = undefined;
  for (let i = 0; i < pre.length; i++) {
    const state = evaluateState(pre, i, ratioThreshold, multiplier, breakoutLookback);
    if (prevState === false && state === true) {
      signals.push({ code, date: dates[i], index: i });
    }
    prevState = state;
  }
  return signals;
}

interface ReturnStat {
  n: number;
  meanPct: number | null;
  medianPct: number | null;
  winRate: number | null;
}

function summarize(returns: number[]): ReturnStat {
  if (returns.length === 0) return { n: 0, meanPct: null, medianPct: null, winRate: null };
  const sorted = [...returns].sort((a, b) => a - b);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const median = sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const wins = returns.filter((r) => r > 0).length;
  return { n: returns.length, meanPct: mean * 100, medianPct: median * 100, winRate: wins / returns.length };
}

function periodLabel(date: string): string | null {
  for (const p of PERIODS) {
    if (date >= p.start && date <= p.end) return p.label;
  }
  return null;
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
      eligibleCodes.push(code); // 마스터에 없으면(상장폐지 등) 걸러내지 않고 통과
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

  console.log("\n########## 3. 종목별 신호 탐지 + 사후수익률 계산 ##########");
  const configs: { ratioThreshold: number; multiplier: number; breakoutLookback: number; label: string }[] = [
    { ratioThreshold: RATIO_VARIANTS[0], multiplier: MULTIPLIER_VARIANTS[0], breakoutLookback: BREAKOUT_LOOKBACK_VARIANTS[0], label: "baseline(0.7/3배/5일)" },
    ...RATIO_VARIANTS.slice(1).map((r) => ({ ratioThreshold: r, multiplier: MULTIPLIER_VARIANTS[0], breakoutLookback: BREAKOUT_LOOKBACK_VARIANTS[0], label: `역배열비율=${r}` })),
    ...MULTIPLIER_VARIANTS.slice(1).map((m) => ({ ratioThreshold: RATIO_VARIANTS[0], multiplier: m, breakoutLookback: BREAKOUT_LOOKBACK_VARIANTS[0], label: `매집봉배수=${m}` })),
    ...BREAKOUT_LOOKBACK_VARIANTS.slice(1).map((b) => ({ ratioThreshold: RATIO_VARIANTS[0], multiplier: MULTIPLIER_VARIANTS[0], breakoutLookback: b, label: `전환확인기간=${b}일` })),
  ];

  // returns[configLabel][horizon] = 전체 수익률 배열, returnsByPeriod[configLabel][period][horizon] = 구간별.
  const returnsOverall = new Map<string, Map<number, number[]>>();
  const returnsByPeriod = new Map<string, Map<string, Map<number, number[]>>>();
  const signalCounts = new Map<string, number>();
  for (const c of configs) {
    returnsOverall.set(c.label, new Map(FORWARD_HORIZONS.map((h) => [h, []])));
    returnsByPeriod.set(c.label, new Map(PERIODS.map((p) => [p.label, new Map(FORWARD_HORIZONS.map((h) => [h, []]))])));
    signalCounts.set(c.label, 0);
  }

  let processed = 0;
  for (const code of eligibleCodes) {
    const series = allSeries.get(code)!;
    if (series.dates.length < 60) {
      processed++;
      continue;
    }
    const pre = precomputeStock(series);
    const master = masterByCode.get(code);

    for (const c of configs) {
      const signals = detectSignals(pre, c.ratioThreshold, c.multiplier, c.breakoutLookback, code, series.dates);
      for (const sig of signals) {
        // 잡주 필터: 신호 발생일 기준 시총/가격/신규상장.
        const marketCapEok = series.marketCaps[sig.index];
        const closePrice = series.closes[sig.index];
        if (marketCapEok < MIN_MARKET_CAP_EOK || closePrice < MIN_PRICE_WON) continue;
        if (master) {
          const months = monthsSince(master.listedDate, new Date(sig.date + "T00:00:00Z"));
          if (months !== null && months < MIN_LISTED_MONTHS) continue;
        }

        signalCounts.set(c.label, (signalCounts.get(c.label) ?? 0) + 1);
        const period = periodLabel(sig.date);

        for (const h of FORWARD_HORIZONS) {
          const futureIndex = sig.index + h;
          if (futureIndex >= series.closes.length) continue;
          const ret = (series.closes[futureIndex] - series.closes[sig.index]) / series.closes[sig.index];
          returnsOverall.get(c.label)!.get(h)!.push(ret);
          if (period) returnsByPeriod.get(c.label)!.get(period)!.get(h)!.push(ret);
        }
      }
    }

    processed++;
    if (processed % 100 === 0 || processed === eligibleCodes.length) {
      console.log(`  진행: ${processed}/${eligibleCodes.length}개 종목 처리 완료`);
    }
  }

  console.log("\n########## 4. 결과 집계 ##########");
  console.log(`universeSize=${eligibleCodes.length} totalStocksLoaded=${allSeries.size}`);

  function fmtStat(s: ReturnStat): string {
    if (s.n === 0) return "n=0";
    return `n=${s.n} mean=${s.meanPct!.toFixed(3)}% median=${s.medianPct!.toFixed(3)}% winRate=${(s.winRate! * 100).toFixed(2)}%`;
  }

  console.log("\nRESULT_TABLE_START");
  for (const c of configs) {
    console.log(`\n--- ${c.label} (ratio=${c.ratioThreshold} multiplier=${c.multiplier} breakoutLookback=${c.breakoutLookback}) totalSignals=${signalCounts.get(c.label) ?? 0} ---`);
    for (const h of FORWARD_HORIZONS) {
      console.log(`  overall  h=${h}d  ${fmtStat(summarize(returnsOverall.get(c.label)!.get(h)!))}`);
    }
    for (const p of PERIODS) {
      for (const h of FORWARD_HORIZONS) {
        console.log(`  ${p.label}  h=${h}d  ${fmtStat(summarize(returnsByPeriod.get(c.label)!.get(p.label)!.get(h)!))}`);
      }
    }
  }
  console.log("RESULT_TABLE_END");

  console.log("\n=== 분석 종료 ===");
}

main().catch((error) => {
  console.error("분석 스크립트 실행 중 오류:", error);
  process.exit(1);
});

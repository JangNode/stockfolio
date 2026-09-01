/**
 * (임시) dh_value_dividend(대형 배당·가치주)/peg_lynch(피터린치 PEG) 두 전략이 등록
 * 이후 스크리닝 매칭 0건인 원인을 실데이터로 조사한다. scripts/screen-all-stocks.ts의
 * discoverFundamentalCandidates/scanFundamentalStrategies와 lib/backtest.ts의
 * computeDhValueDividendStates/computePegLynchStates(둘 다 export 안 돼 있어 직접
 * import는 불가 — 아래 판정 순서는 그 두 함수를 그대로 옮겨 "오늘 하루"만 평가하는
 * 버전이다) 로직을 참고해, 오늘(가장 최근 시점) 기준 후보 종목이 각 단계를 얼마나
 * 통과하는지 단계별로 센다. DB에는 아무것도 쓰지 않는 읽기 전용 진단 — 확인 끝나면
 * 정리 PR에서 스크립트/워크플로와 함께 삭제한다.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-dh-peg-strategy-matching.ts
 */

import { getAllStocks, type StockEntry } from "@/lib/stockMaster";
import { discoverCandidateStockCodes, getDailyPrice } from "@/lib/stockDailyPricesStorage";
import {
  loadFundamentalsSeriesWithListedShares,
  pickFundamentalsAsOf,
  pickDividendsPaidAsOf,
  computeValuationFromSeries,
  type FundamentalsSeries,
} from "@/lib/stockFundamentals";
import { evaluateConsecutiveDividendYears } from "@/lib/backtest";
import {
  selectEpsCagrFiscalYears,
  computeEpsCagrFromResolvedShares,
  computePeg,
  type ListedSharesByFiscalYear,
} from "@/lib/pegRatio";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";
import { DH_MIN_MARKET_CAP_EOK, DH_MAX_PER, DH_MAX_PBR, DH_MIN_CONSECUTIVE_DIVIDEND_YEARS } from "@/lib/dhStrategyConfig";
import { PEG_MAX_RATIO } from "@/lib/pegConfig";

// scripts/screen-all-stocks.ts의 FUNDAMENTAL_CANDIDATE_START_YEAR와 동일해야 후보종목이
// 빠짐없이 뽑힌다.
const FUNDAMENTAL_CANDIDATE_START_YEAR = 2011;
const BATCH_CONCURRENCY = 10;

function todayKstDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
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
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runOne()));
}

// scripts/screen-all-stocks.ts의 filterByMaster/monthsSinceListing을 그대로 옮김(export
// 안 돼 있어 직접 재사용 불가) — scanFundamentalStrategies가 실제로 적용하는 마스터
// 필터와 동일한 결과를 내야 "실제 스캔 대상 풀"을 정확히 재현할 수 있다.
const EXCLUDED_NAME_SUBSTRINGS = ["스팩"];
const EXCLUDED_PRODUCT_TYPES = new Set(["RT", "EF", "EN"]);
const MIN_LISTED_MONTHS = 6;

function monthsSinceListing(listedDate: string | null, now: Date): number | null {
  if (!listedDate) return null;
  const year = Number(listedDate.slice(0, 4));
  const month = Number(listedDate.slice(4, 6));
  const day = Number(listedDate.slice(6, 8));
  if (year < 1950 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const listed = new Date(year, month - 1, day);
  if (Number.isNaN(listed.getTime())) return null;
  return (now.getFullYear() - listed.getFullYear()) * 12 + (now.getMonth() - listed.getMonth()) - (now.getDate() < listed.getDate() ? 1 : 0);
}

interface MasterFilterCounts {
  spac: number;
  reitEtfEtn: number;
  newlyListed: number;
  delistingRisk: number;
}

function filterByMaster(stocks: StockEntry[]): { survivors: StockEntry[]; counts: MasterFilterCounts } {
  const now = new Date();
  const counts: MasterFilterCounts = { spac: 0, reitEtfEtn: 0, newlyListed: 0, delistingRisk: 0 };
  const survivors: StockEntry[] = [];
  for (const stock of stocks) {
    if (EXCLUDED_NAME_SUBSTRINGS.some((s) => stock.name.includes(s))) {
      counts.spac++;
      continue;
    }
    if (EXCLUDED_PRODUCT_TYPES.has(stock.productType)) {
      counts.reitEtfEtn++;
      continue;
    }
    if (stock.isTradingHalted || stock.isLiquidationTrading || stock.isAdministrativeIssue) {
      counts.delistingRisk++;
      continue;
    }
    const months = monthsSinceListing(stock.listedDate, now);
    if (months !== null && months < MIN_LISTED_MONTHS) {
      counts.newlyListed++;
      continue;
    }
    survivors.push(stock);
  }
  return { survivors, counts };
}

interface CandidateData {
  code: string;
  name: string;
  closePrice: number;
  marketCapEok: number;
  listedShares: number;
  fundamentals: FundamentalsSeries;
  listedSharesByFiscalYear: ListedSharesByFiscalYear;
}

async function collectCandidateData(candidates: StockEntry[], today: string): Promise<{ data: CandidateData[]; noPriceToday: number }> {
  const data: CandidateData[] = [];
  let noPriceToday = 0;
  let completed = 0;

  await runWithConcurrency(candidates, BATCH_CONCURRENCY, async (stock) => {
    try {
      const [priceRow, fundamentalsData] = await Promise.all([
        getDailyPrice(stock.code, today),
        loadFundamentalsSeriesWithListedShares(stock.code),
      ]);
      if (!priceRow) {
        noPriceToday++;
        return;
      }
      data.push({
        code: stock.code,
        name: stock.name,
        closePrice: priceRow.closePrice,
        marketCapEok: priceRow.marketCapEok,
        listedShares: priceRow.listedShares,
        fundamentals: fundamentalsData.series,
        listedSharesByFiscalYear: fundamentalsData.listedSharesByFiscalYear,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`    ${stock.code}(${stock.name}) 데이터 조회 중 오류, 건너뜁니다: ${message}`);
    } finally {
      completed++;
      if (completed === 1 || completed % 100 === 0 || completed === candidates.length) {
        console.log(`  [${completed}/${candidates.length}] 후보 데이터 수집 중...`);
      }
    }
  });

  return { data, noPriceToday };
}

function investigateDh(data: CandidateData[], today: string): void {
  console.log("\n--- DH전략(dh_value_dividend) 단계별 통과 종목 수 ---");
  console.log(`전체 후보 종목 수(오늘자 시세 존재): ${data.length}개`);

  const capOk = data.filter((d) => d.marketCapEok >= DH_MIN_MARKET_CAP_EOK);
  console.log(`→ 시총 ${(DH_MIN_MARKET_CAP_EOK / 10000).toFixed(1)}조원 이상: ${capOk.length}개`);

  let noFundamentalsAsOf = 0;
  const withFund = capOk
    .map((d) => {
      const fund = pickFundamentalsAsOf(d.fundamentals, today);
      if (!fund) noFundamentalsAsOf++;
      return { d, fund };
    })
    .filter((x) => x.fund !== null) as { d: CandidateData; fund: NonNullable<ReturnType<typeof pickFundamentalsAsOf>> }[];
  console.log(
    `  (참고) 시총 통과 종목 중 오늘 시점 공시된 재무가 아예 없음(pickFundamentalsAsOf=null): ${noFundamentalsAsOf}개`
  );

  // 참고: computeDhValueDividendStates 자체에는 흑자(당기순이익>0) 조건이 명시적으로
  // 없다 — EPS<=0(적자)이면 computeValuationFromSeries가 per=null을 반환하고, 그 결과
  // per<=DH_MAX_PER 조건에서 자동으로 탈락한다(암묵적 게이트). 아래는 "명시적 흑자"
  // 개수를 별도로 세어 그 사실을 확인하는 참고용 수치다(실제 판정 순서와 무관).
  const explicitlyProfitable = withFund.filter((x) => x.fund.netIncomeParent !== null && x.fund.netIncomeParent > 0);
  console.log(
    `  (참고, 실제 판정에는 별도 단계로 없음) 순이익>0(명시적 흑자): ${explicitlyProfitable.length}개 / 재무 존재 ${withFund.length}개`
  );

  const valuations = withFund.map((x) => ({
    ...x,
    valuation: computeValuationFromSeries(x.d.closePrice, x.d.listedShares, x.fund),
  }));

  const perOk = valuations.filter((x) => x.valuation.per !== null && x.valuation.per > 0 && x.valuation.per <= DH_MAX_PER);
  console.log(`→ PER ${DH_MAX_PER} 이하(적자 제외 암묵 포함): ${perOk.length}개`);

  const pbrOk = perOk.filter((x) => x.valuation.pbr !== null && x.valuation.pbr > 0 && x.valuation.pbr <= DH_MAX_PBR);
  console.log(`→ (그중) PBR ${DH_MAX_PBR} 이하: ${pbrOk.length}개`);

  const dividendOk = pbrOk.filter((x) => {
    const dividends = pickDividendsPaidAsOf(x.d.fundamentals, today);
    return evaluateConsecutiveDividendYears(dividends, today, DH_MIN_CONSECUTIVE_DIVIDEND_YEARS).consecutiveOk;
  });
  console.log(`→ (그중) 5년 연속배당: ${dividendOk.length}개`);

  // 단계 사이 급감 지점 원본 데이터 샘플
  if (perOk.length === 0 && capOk.length > 0) {
    console.log("  [샘플] 시총 통과했지만 PER 조건에서 탈락(또는 재무/PER 계산 불가)한 종목:");
    for (const x of withFund.slice(0, 3)) {
      const val = computeValuationFromSeries(x.d.closePrice, x.d.listedShares, x.fund);
      console.log(
        `    ${x.d.name}(${x.d.code}) fiscalYear=${x.fund.fiscalYear} rceptDate=${x.fund.rceptDate} ` +
          `netIncomeParent=${x.fund.netIncomeParent} equityParent=${x.fund.equityParent} listedShares=${x.d.listedShares} ` +
          `closePrice=${x.d.closePrice} => eps=${val.eps} per=${val.per} bps=${val.bps} pbr=${val.pbr}`
      );
    }
  }
  if (dividendOk.length === 0 && pbrOk.length > 0) {
    console.log("  [샘플] PER/PBR 통과했지만 배당 조건에서 탈락한 종목:");
    for (const x of pbrOk.slice(0, 3)) {
      const dividends = pickDividendsPaidAsOf(x.d.fundamentals, today);
      const { paidYears } = evaluateConsecutiveDividendYears(dividends, today, DH_MIN_CONSECUTIVE_DIVIDEND_YEARS);
      console.log(
        `    ${x.d.name}(${x.d.code}) 지급 배당 이력(최근 ${dividends.length}건): ` +
          `${dividends.slice(0, 8).map((dv) => `${dv.payDate}(${dv.cashDividendPerShare}원)`).join(", ")} ` +
          `=> 요건 충족 연도: [${paidYears.join(", ")}] (필요: 최근 ${DH_MIN_CONSECUTIVE_DIVIDEND_YEARS}년 전부)`
      );
    }
  }

  // 시나리오: 기준값 완화
  console.log("  --- 기준값 완화 시나리오 ---");
  const perOk20 = valuations.filter((x) => x.valuation.per !== null && x.valuation.per > 0 && x.valuation.per <= 20);
  console.log(`  PER 15→20(단독, PBR은 기존 1.5 유지): PER<=20 통과 ${perOk20.length}개, 그중 PBR<=1.5까지 ${perOk20.filter((x) => x.valuation.pbr !== null && x.valuation.pbr > 0 && x.valuation.pbr <= DH_MAX_PBR).length}개`);

  const pbrOk20FromPer15 = perOk.filter((x) => x.valuation.pbr !== null && x.valuation.pbr > 0 && x.valuation.pbr <= 2.0);
  console.log(`  PBR 1.5→2.0(단독, PER은 기존 15 유지): PER<=15 유지 상태에서 PBR<=2.0까지 ${pbrOk20FromPer15.length}개`);

  const bothRelaxed = perOk20.filter((x) => x.valuation.pbr !== null && x.valuation.pbr > 0 && x.valuation.pbr <= 2.0);
  console.log(`  PER 20 & PBR 2.0 둘 다 완화: ${bothRelaxed.length}개`);
  console.log(
    `  (참고) 위 완화 시나리오는 배당 조건 적용 전 단계 수치다 — 배당까지 통과하는 실제 최종 매칭 수는 이보다 작거나 같다.`
  );
}

function investigatePeg(data: CandidateData[], today: string): void {
  console.log("\n--- 피터린치 PEG전략(peg_lynch) 단계별 통과 종목 수 ---");
  console.log(`전체 후보 종목 수(오늘자 시세 존재): ${data.length}개`);

  let noFundamentalsAsOf = 0;
  let netIncomeNull = 0;
  const withFund = data
    .map((d) => {
      const fund = pickFundamentalsAsOf(d.fundamentals, today);
      if (!fund) noFundamentalsAsOf++;
      return { d, fund };
    })
    .filter((x) => x.fund !== null) as { d: CandidateData; fund: NonNullable<ReturnType<typeof pickFundamentalsAsOf>> }[];
  console.log(`  (참고) 오늘 시점 공시된 재무가 아예 없음(pickFundamentalsAsOf=null): ${noFundamentalsAsOf}개`);

  const profitable = withFund.filter((x) => {
    if (x.fund.netIncomeParent === null) {
      netIncomeNull++;
      return false;
    }
    return x.fund.netIncomeParent > 0;
  });
  console.log(`→ 흑자(순이익>0): ${profitable.length}개 (재무는 있으나 netIncomeParent가 null인 경우 ${netIncomeNull}개 별도)`);

  let noEpsCagrPair = 0;
  let growthNullOrPerNull = 0;
  const pegComputable = profitable
    .map((x) => {
      const valuation = computeValuationFromSeries(x.d.closePrice, x.d.listedShares, x.fund);
      const pair = selectEpsCagrFiscalYears(x.d.fundamentals, today);
      if (!pair) {
        noEpsCagrPair++;
        return { ...x, valuation, pair, growthPct: null, peg: null };
      }
      const growthPct = computeEpsCagrFromResolvedShares(pair, x.d.listedSharesByFiscalYear);
      const peg = computePeg(valuation.per, growthPct);
      if (peg === null) growthNullOrPerNull++;
      return { ...x, valuation, pair, growthPct, peg };
    });
  const pegOkComputable = pegComputable.filter((x) => x.peg !== null);
  console.log(
    `→ PEG 계산 가능(EPS 5년 CAGR 존재 + PER 계산 가능): ${pegOkComputable.length}개 ` +
      `(5년 전 연도 데이터 없어 연도쌍 자체를 못 고름: ${noEpsCagrPair}개, 연도쌍은 있으나 성장률/PER 계산 불가: ${growthNullOrPerNull}개)`
  );

  const pegOk = pegOkComputable.filter((x) => (x.peg as number) <= PEG_MAX_RATIO);
  console.log(`→ (그중) PEG ${PEG_MAX_RATIO} 이하: ${pegOk.length}개`);

  if (profitable.length === 0 && withFund.length > 0) {
    console.log("  [샘플] 재무는 있으나 흑자 조건에서 탈락한 종목:");
    for (const x of withFund.slice(0, 3)) {
      console.log(
        `    ${x.d.name}(${x.d.code}) fiscalYear=${x.fund.fiscalYear} rceptDate=${x.fund.rceptDate} netIncomeParent=${x.fund.netIncomeParent}`
      );
    }
  }
  if (pegOkComputable.length === 0 && profitable.length > 0) {
    console.log("  [샘플] 흑자이지만 PEG 계산 불가한 종목(EPS CAGR/PER 원인 확인):");
    for (const x of profitable.slice(0, 3)) {
      const pair = selectEpsCagrFiscalYears(x.d.fundamentals, today);
      const valuation = computeValuationFromSeries(x.d.closePrice, x.d.listedShares, x.fund);
      console.log(
        `    ${x.d.name}(${x.d.code}) per=${valuation.per} ` +
          `selectEpsCagrFiscalYears=${pair ? `start(FY${pair.start.fiscalYear},rcept=${pair.start.rceptDate},netIncome=${pair.start.netIncomeParent})/end(FY${pair.end.fiscalYear},rcept=${pair.end.rceptDate},netIncome=${pair.end.netIncomeParent})` : "null(5년 전 연도 데이터 없음)"} ` +
          `listedSharesByFiscalYear=[${Array.from(x.d.listedSharesByFiscalYear.entries()).map(([y, s]) => `${y}:${s}`).join(", ")}]`
      );
    }
  }

  console.log("  --- 기준값 완화 시나리오 ---");
  const pegOk15 = pegOkComputable.filter((x) => (x.peg as number) <= 1.5);
  console.log(`  PEG 1.0→1.5: ${pegOk15.length}개`);
}

function reportPointInTimeFreshness(data: CandidateData[], today: string, label: string): void {
  console.log(`\n--- point-in-time 확인(${label}): pickFundamentalsAsOf(fundamentals, ${today})가 반환하는 연도 분포 ---`);
  const fiscalYearCounts = new Map<number, number>();
  let nullCount = 0;
  const samples: string[] = [];
  for (const d of data) {
    const fund = pickFundamentalsAsOf(d.fundamentals, today);
    if (!fund) {
      nullCount++;
      continue;
    }
    fiscalYearCounts.set(fund.fiscalYear, (fiscalYearCounts.get(fund.fiscalYear) ?? 0) + 1);
    if (samples.length < 5) {
      samples.push(`${d.name}(${d.code}): FY${fund.fiscalYear} rceptDate=${fund.rceptDate}`);
    }
  }
  console.log(`  최신 재무 없음(null): ${nullCount}개`);
  console.log(
    `  회계연도 분포: ${Array.from(fiscalYearCounts.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([y, c]) => `FY${y}=${c}개`)
      .join(", ")}`
  );
  console.log(`  샘플: ${samples.join(" | ")}`);
}

async function main(): Promise<void> {
  const today = todayKstDate();
  console.log(`=== 조사 2: DH전략/PEG전략 매칭 0건 원인 (오늘 KST: ${today}) ===`);

  const currentYear = new Date().getUTCFullYear();
  const years = Array.from(
    { length: currentYear - FUNDAMENTAL_CANDIDATE_START_YEAR + 1 },
    (_, i) => FUNDAMENTAL_CANDIDATE_START_YEAR + i
  );
  const candidateCodes = await discoverCandidateStockCodes(years, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK);
  console.log(`discoverCandidateStockCodes(${years[0]}~${years[years.length - 1]}년, 시총 ${STOCK_DATA_CANDIDATE_MARKET_CAP_EOK}억 이상) 원시 결과: ${candidateCodes.length}개`);

  const allStocks = await getAllStocks();
  const { survivors: masterSurvivors, counts } = filterByMaster(allStocks);
  console.log(
    `마스터 필터: 전체 ${allStocks.length}개 → 생존 ${masterSurvivors.length}개 ` +
      `(스팩 ${counts.spac}, 리츠/ETF/ETN ${counts.reitEtfEtn}, 상장폐지위험 ${counts.delistingRisk}, 신규상장 ${counts.newlyListed} 제외)`
  );

  const survivorByCode = new Map(masterSurvivors.map((s) => [s.code, s]));
  const candidates = candidateCodes.map((code) => survivorByCode.get(code)).filter((s): s is StockEntry => s !== undefined);
  console.log(`펀더멘털 전략 실제 스캔 대상(후보 ∩ 마스터 생존): ${candidates.length}개`);

  console.log(`\n종목별 오늘자 시세 + 재무/배당 이력 수집 중...`);
  const { data, noPriceToday } = await collectCandidateData(candidates, today);
  console.log(`데이터 수집 완료: ${data.length}개 확보, 오늘자 시세 없음(비영업일/데이터 지연 등) ${noPriceToday}개`);

  investigateDh(data, today);
  investigatePeg(data, today);
  reportPointInTimeFreshness(data, today, "전체 데이터 확보 종목");

  console.log("\n=== 조사 2 종료 ===");
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});

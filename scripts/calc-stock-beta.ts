/**
 * 적정주가 RIM(잔여이익모델) 1단계 — 후보종목(시가총액 1조원 이상 이력 있는 종목,
 * ~300개)의 베타를 분기 1회 미리 계산해 stock_beta에 저장한다
 * (lib/stockBetaStorage.ts). API 라우트는 요청마다 회귀를 다시 돌리지 않고 이 표만
 * 조회한다.
 *
 * 상장 BETA_LOOKBACK_YEARS년 미만인 종목은 회귀 자체를 생략하고 산출 불가(beta:
 * null)로 저장한다. 종목마스터에서 시장(KOSPI/KOSDAQ)을 못 찾은 종목(상장폐지 등)은
 * 건너뛴다.
 *
 * server-only로 막힌 lib/supabaseAdmin.ts를 순수 Node 스크립트에서도 재사용하려면
 * "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/calc-stock-beta.ts
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { discoverCandidateStockCodes, getDailyPriceSeries } from "@/lib/stockDailyPricesStorage";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";
import { getAllStocks, type KrxMarket, type StockEntry } from "@/lib/stockMaster";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { computeBetaFromPrices } from "@/lib/beta";
import { BETA_LOOKBACK_YEARS, BETA_MIN_DATA_POINTS } from "@/lib/betaConfig";
import { upsertStockBetas, type StockBetaRow } from "@/lib/stockBetaStorage";

// 1단계(scripts/backfill-stock-daily-prices.ts)의 BACKFILL_START_YEAR와 동일해야
// 후보종목이 빠짐없이 뽑힌다(scripts/backfill-dart-cashflow-debt.ts와 동일).
const PRICE_BACKFILL_START_YEAR = 2011;

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function yyyymmddToIso(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

async function discoverCandidates(): Promise<string[]> {
  const currentYear = new Date().getUTCFullYear();
  const years = Array.from(
    { length: currentYear - PRICE_BACKFILL_START_YEAR + 1 },
    (_, i) => PRICE_BACKFILL_START_YEAR + i
  );
  return discoverCandidateStockCodes(years, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK);
}

async function main(): Promise<void> {
  const endDate = new Date();
  endDate.setUTCDate(endDate.getUTCDate() - 1); // 오늘 시세는 정산 전일 수 있어 어제까지
  const windowEndDate = toDateKey(endDate);

  const windowStart = new Date(endDate);
  windowStart.setUTCFullYear(windowStart.getUTCFullYear() - BETA_LOOKBACK_YEARS);
  const windowStartDate = toDateKey(windowStart);

  console.log("후보종목 발굴 중...");
  const candidates = await discoverCandidates();
  console.log(`후보종목 ${candidates.length}개`);

  console.log("종목마스터 로딩 중...");
  const allStocks = await getAllStocks();
  const entryByCode = new Map<string, StockEntry>(allStocks.map((entry) => [entry.code, entry]));

  console.log("코스피/코스닥 지수 시세 로딩 중...");
  const [kospiSeries, kosdaqSeries] = await Promise.all([
    getIndexPriceSeries("KOSPI", windowStartDate, windowEndDate),
    getIndexPriceSeries("KOSDAQ", windowStartDate, windowEndDate),
  ]);
  const indexSeriesByMarket: Record<KrxMarket, typeof kospiSeries> = { KOSPI: kospiSeries, KOSDAQ: kosdaqSeries };
  console.log(`코스피 ${kospiSeries.length}행, 코스닥 ${kosdaqSeries.length}행`);

  const rows: StockBetaRow[] = [];
  let skippedNoMarket = 0;
  let skippedTooYoung = 0;
  let computed = 0;
  let insufficientData = 0;

  for (const stockCode of candidates) {
    const entry = entryByCode.get(stockCode);
    if (!entry) {
      skippedNoMarket++;
      console.warn(`  ${stockCode}: 종목마스터에서 찾을 수 없어 건너뜀(상장폐지 등)`);
      continue;
    }

    const market = entry.market;
    const listedDateIso = entry.listedDate ? yyyymmddToIso(entry.listedDate) : null;
    if (!listedDateIso || listedDateIso > windowStartDate) {
      skippedTooYoung++;
      rows.push({
        stockCode,
        market,
        beta: null,
        dataPoints: 0,
        windowStartDate,
        windowEndDate,
      });
      continue;
    }

    const stockSeries = await getDailyPriceSeries(stockCode, windowStartDate, windowEndDate);
    const result = computeBetaFromPrices(
      stockSeries.map((r) => ({ tradeDate: r.tradeDate, closePrice: r.closePrice })),
      indexSeriesByMarket[market],
      BETA_MIN_DATA_POINTS
    );

    if (result) {
      computed++;
      rows.push({
        stockCode,
        market,
        beta: result.beta,
        dataPoints: result.dataPoints,
        windowStartDate,
        windowEndDate,
      });
    } else {
      insufficientData++;
      rows.push({
        stockCode,
        market,
        beta: null,
        dataPoints: 0,
        windowStartDate,
        windowEndDate,
      });
    }
  }

  await upsertStockBetas(rows);

  console.log(
    `베타 계산 완료: 산출 ${computed}건, 데이터부족 ${insufficientData}건, 상장3년미만 ${skippedTooYoung}건, 마스터매칭실패(건너뜀) ${skippedNoMarket}건`
  );
}

main().catch((error) => {
  console.error("베타 계산 중 오류:", error);
  process.exit(1);
});

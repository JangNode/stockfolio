/**
 * (1회성 검증) PR1 리팩터(lib/stockFundamentals.ts의 loadFundamentalsSeries/
 * pickFundamentalsAsOf/pickDividendsPaidAsOf/computeValuationFromSeries,
 * lib/stockDailyPricesStorage.ts의 getDailyPriceSeries)가 기존 동작과 일치하는지
 * 005930(삼성전자) 실데이터로 확인한다. 검증 후 삭제 예정.
 */
import {
  getFundamentalsAsOf,
  getDividendsPaidAsOf,
  computeValuationAsOf,
  loadFundamentalsSeries,
  pickFundamentalsAsOf,
  pickDividendsPaidAsOf,
} from "@/lib/stockFundamentals";
import { getDailyPrice, getDailyPriceSeries } from "@/lib/stockDailyPricesStorage";

const CODE = "005930";
const CHECK_DATES = ["2023-03-15", "2020-01-02", "2011-06-01"];

async function main(): Promise<void> {
  console.log(`=== ${CODE} loadFundamentalsSeries 로드 ===`);
  const series = await loadFundamentalsSeries(CODE);
  console.log(`재무 ${series.annual.length}건, 배당 ${series.dividends.length}건`);
  console.log(`재무 첫/마지막: ${series.annual[0]?.rceptDate} ~ ${series.annual[series.annual.length - 1]?.rceptDate}`);

  for (const date of CHECK_DATES) {
    console.log(`\n--- ${date} ---`);
    const directFund = await getFundamentalsAsOf(CODE, date);
    const seriesFund = pickFundamentalsAsOf(series, date);
    const fundMatch = JSON.stringify(directFund) === JSON.stringify(seriesFund);
    console.log(`재무 일치: ${fundMatch}`, directFund);
    if (!fundMatch) console.error("  !!! 불일치 !!!", { directFund, seriesFund });

    const directDiv = await getDividendsPaidAsOf(CODE, date);
    const seriesDiv = pickDividendsPaidAsOf(series, date);
    const divMatch = JSON.stringify(directDiv) === JSON.stringify(seriesDiv);
    console.log(`배당(${directDiv.length}건) 일치: ${divMatch}`);
    if (!divMatch) console.error("  !!! 불일치 !!!", { directDiv, seriesDiv });

    const valuation = await computeValuationAsOf(CODE, date);
    console.log(`밸류에이션:`, valuation);
  }

  console.log(`\n=== getDailyPriceSeries 검증(2022-01-01 ~ 2024-01-05, cold+hot 경계 포함) ===`);
  const rangeStart = "2022-01-01";
  const rangeEnd = "2024-01-05";
  const seriesRows = await getDailyPriceSeries(CODE, rangeStart, rangeEnd);
  console.log(`행 수: ${seriesRows.length}, 첫 행: ${JSON.stringify(seriesRows[0])}, 마지막 행: ${JSON.stringify(seriesRows[seriesRows.length - 1])}`);

  const spotDates = ["2022-01-03", "2023-06-15", "2024-01-02"];
  for (const date of spotDates) {
    const direct = await getDailyPrice(CODE, date);
    const fromSeries = seriesRows.find((r) => r.tradeDate === date) ?? null;
    const match = JSON.stringify(direct) === JSON.stringify(fromSeries);
    console.log(`${date} getDailyPrice vs series 일치: ${match}`, direct);
    if (!match) console.error("  !!! 불일치 !!!", { direct, fromSeries });
  }

  // 정렬/중복 확인
  let sorted = true;
  for (let i = 1; i < seriesRows.length; i++) {
    if (seriesRows[i].tradeDate <= seriesRows[i - 1].tradeDate) sorted = false;
  }
  console.log(`오름차순 정렬 및 중복 없음: ${sorted}`);

  console.log("\n검증 완료.");
}

main().catch((error) => {
  console.error("검증 중 오류:", error);
  process.exit(1);
});

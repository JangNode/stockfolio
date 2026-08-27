/**
 * (임시) 005930 배당수익률 불일치 진단용 읽기 전용 스크립트.
 * getDividendRecords 원본 전체(연도 제한 없이 최근 2년)와 payDate 기준 최근 1년
 * 필터링 결과, 현재가를 그대로 찍어서 한투 앱(0.60%, 3번 지급)과 어디서 갈리는지 확인한다.
 *
 *   tsx --conditions=react-server scripts/verify-valuation-005930.ts
 */

import { getDividendRecords, getStockPrice } from "@/lib/kis";

function yyyymmddDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

async function main(): Promise<void> {
  const [records, price] = await Promise.all([
    getDividendRecords("005930", 2),
    getStockPrice("005930"),
  ]);

  console.log("현재가:", price.currentPrice);
  console.log("\n=== 배당 원본 전체(최근 2년) ===");
  console.log(JSON.stringify(records, null, 2));

  const today = yyyymmddDaysAgo(0);
  const oneYearAgo = yyyymmddDaysAgo(365);
  console.log(`\n오늘: ${today}, 1년 전: ${oneYearAgo}`);

  const paidLastYear = records.filter(
    (r) => r.payDate !== null && r.payDate <= today && r.payDate >= oneYearAgo
  );
  console.log("\n=== payDate 기준 최근 1년 지급완료 필터 결과 ===");
  console.log(JSON.stringify(paidLastYear, null, 2));

  const total = paidLastYear.reduce((sum, r) => sum + r.cashDividendPerShare, 0);
  console.log(`\n합계: ${total}원, 건수: ${paidLastYear.length}건`);
  console.log(`배당수익률: ${((total / price.currentPrice) * 100).toFixed(4)}%`);
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});

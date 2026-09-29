/**
 * [디스포저블 검증 스크립트] lib/betaPriceHistoryStorage.ts의
 * getIndexPriceSeries가 Supabase/PostgREST 기본 1000행 캡을 range()
 * 페이지네이션으로 잘 우회하는지 실데이터로 확인한다. beta_price_history에는
 * 코스피/코스닥이 2016-01-04~2026-09-03까지(약 2617행/시장) 채워져 있다 —
 * 2016-01-01~오늘로 조회했을 때 행 수가 1000행보다 훨씬 많이 나오고, 마지막
 * 행의 trade_date가 잘리지 않고 최신 날짜까지 나오는지 확인한다. DB 쓰기 없음
 * (순수 조회).
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/verify-index-price-series-pagination.ts
 */

import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";

async function verifyMarket(market: "KOSPI" | "KOSDAQ", startDate: string, endDate: string): Promise<void> {
  const series = await getIndexPriceSeries(market, startDate, endDate);
  const first = series[0];
  const last = series[series.length - 1];
  console.log(`=== ${market} (${startDate} ~ ${endDate}) ===`);
  console.log(`  행 수: ${series.length}`);
  console.log(`  첫 행 trade_date: ${first?.tradeDate ?? "(없음)"}`);
  console.log(`  마지막 행 trade_date: ${last?.tradeDate ?? "(없음)"}`);
  if (series.length <= 1000) {
    console.warn(`  경고: 행 수가 1000 이하 — 페이지네이션이 실제로 필요한 구간인지 재확인 필요`);
  }
}

async function main(): Promise<void> {
  const startDate = "2016-01-01";
  const endDate = new Date().toISOString().slice(0, 10);
  await verifyMarket("KOSPI", startDate, endDate);
  await verifyMarket("KOSDAQ", startDate, endDate);
}

main().catch((error) => {
  console.error("검증 중 오류:", error);
  process.exit(1);
});

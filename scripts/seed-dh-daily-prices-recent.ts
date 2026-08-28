/**
 * (1회성) DH전략 hot/cold 분리 도입 시 dh_daily_prices_recent(Postgres)를 기존
 * Parquet 백필 데이터로 채운다. 이미 Parquet에 있는 최근 DH_HOT_WINDOW_YEARS년치를
 * 그대로 복사해 넣는 것뿐이라 새 API 호출은 없다. 이후로는
 * scripts/update-dh-daily-prices-recent.ts(매일)가 이 표를 이어서 채운다.
 *
 * server-only로 막힌 lib/supabaseAdmin.ts를 순수 Node 스크립트에서도 재사용하려면
 * "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/seed-dh-daily-prices-recent.ts
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { downloadYearPrices, hotWindowStartDate, upsertRecentPrices } from "@/lib/dhDailyPricesStorage";

async function main(): Promise<void> {
  const cutoff = hotWindowStartDate();
  const cutoffYear = Number(cutoff.slice(0, 4));
  const currentYear = new Date().getUTCFullYear();

  console.log(`hot 구간 시작일: ${cutoff} — ${cutoffYear}년부터 ${currentYear}년까지 Parquet에서 복사합니다.`);

  let total = 0;
  for (let year = cutoffYear; year <= currentYear; year++) {
    const rows = await downloadYearPrices(year);
    const inWindow = rows.filter((r) => r.tradeDate >= cutoff);
    console.log(`${year}년: Parquet ${rows.length}행 중 hot 구간 ${inWindow.length}행`);
    if (inWindow.length > 0) {
      await upsertRecentPrices(inWindow);
      total += inWindow.length;
    }
  }

  console.log(`시딩 완료: 총 ${total}행을 dh_daily_prices_recent에 저장했습니다.`);
}

main().catch((error) => {
  console.error("시딩 중 오류:", error);
  process.exit(1);
});

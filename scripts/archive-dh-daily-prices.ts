/**
 * DH전략 일별시세 hot/cold 아카이빙 배치 — 연 1회 실행. dh_daily_prices_recent
 * (Postgres)에서 hot 구간(DH_HOT_WINDOW_YEARS년)을 벗어난 행을 연도별로 골라 그
 * 연도의 기존 Parquet 파일과 합쳐 다시 업로드하고, 업로드가 전부 성공한 뒤에만
 * Postgres에서 그 행들을 지운다 — 업로드 실패 시 Postgres에 그대로 남아 다음 실행이
 * 다시 시도한다(두 곳 다에서 사라지는 사고 방지). 기존 Parquet 파일과 합칠 때 같은
 * (종목, 날짜)가 이미 있으면 새 값으로 덮어써서(Map 기반 병합) 중복 없이 처리한다 —
 * 원래 15년 백필이 최근 구간도 이미 채워뒀을 수 있어서다.
 *
 * server-only로 막힌 lib/supabaseAdmin.ts를 순수 Node 스크립트에서도 재사용하려면
 * "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/archive-dh-daily-prices.ts
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import {
  deleteRecentPricesBefore,
  downloadYearPrices,
  getRecentPricesBefore,
  hotWindowStartDate,
  uploadYearPrices,
  type DhDailyPriceRow,
} from "@/lib/dhDailyPricesStorage";

function toLookupKey(stockCode: string, tradeDate: string): string {
  return `${stockCode}:${tradeDate}`;
}

async function main(): Promise<void> {
  const cutoff = hotWindowStartDate();
  console.log(`hot 구간 기준일: ${cutoff} — 이보다 오래된 행을 아카이빙합니다.`);

  const staleRows = await getRecentPricesBefore(cutoff);
  console.log(`아카이빙 대상: ${staleRows.length}행`);

  if (staleRows.length === 0) {
    console.log("아카이빙할 데이터가 없습니다.");
    return;
  }

  const byYear = new Map<number, DhDailyPriceRow[]>();
  for (const row of staleRows) {
    const year = Number(row.tradeDate.slice(0, 4));
    const list = byYear.get(year) ?? [];
    list.push(row);
    byYear.set(year, list);
  }

  const years = Array.from(byYear.keys()).sort((a, b) => a - b);
  console.log(`대상 연도: ${years.join(", ")}`);

  for (const year of years) {
    const existing = await downloadYearPrices(year);
    const merged = new Map<string, DhDailyPriceRow>();
    for (const row of existing) merged.set(toLookupKey(row.stockCode, row.tradeDate), row);
    for (const row of byYear.get(year) ?? []) merged.set(toLookupKey(row.stockCode, row.tradeDate), row);

    await uploadYearPrices(year, Array.from(merged.values()));
    console.log(`${year}년: 기존 ${existing.length}행 + 신규 ${byYear.get(year)?.length ?? 0}행 → 합계 ${merged.size}행 업로드 완료`);
  }

  // 모든 연도 업로드가 성공한 뒤에만 Postgres에서 지운다.
  await deleteRecentPricesBefore(cutoff);
  console.log(`아카이빙 완료: ${staleRows.length}행을 Parquet로 옮기고 dh_daily_prices_recent에서 삭제했습니다.`);
}

main().catch((error) => {
  console.error("아카이빙 중 오류:", error);
  process.exit(1);
});

/**
 * 디스포저블 진단: 전종목 확장 재백필(#413)의 드라이런 안전성 확인.
 * "before" 모드로 2023년 재백필 전 스냅샷을 뜬 뒤, 팀장이 2023년만
 * force_refetch_all_years로 재백필하고, "after" 모드로 다시 돌려 비교한다.
 *
 * 확인 항목:
 * 1. 대형주 표본의 2023년 행 수·특정 날짜 종가/거래량이 재백필 전후로
 *    동일한지(덮어쓰기로 인한 값 변경 없음 확인, 리뷰 findings #2 대응).
 * 2. stock-daily-prices 버킷 전체 크기와 2023.parquet 파일 크기(Storage
 *    사용량 추정용).
 *
 * 실행: MODE=before|after npm run diagnose:widen-backfill-safety-check
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { downloadYearPrices } from "@/lib/stockDailyPricesStorage";

const YEAR = 2023;
const SAMPLE_CODES = ["005930", "000660", "035420", "005380", "051910", "048260", "298040", "036930", "064760"];
const SAMPLE_DATES = [`${YEAR}-01-02`, `${YEAR}-06-15`, `${YEAR}-12-28`];
const BUCKET = "stock-daily-prices";

async function main(): Promise<void> {
  const mode = process.env.MODE;
  if (mode !== "before" && mode !== "after") throw new Error("MODE=before 또는 MODE=after로 실행하세요.");

  console.log(`=== ${mode.toUpperCase()} 스냅샷 (${YEAR}년) ===`);

  const rows = await downloadYearPrices(YEAR);
  console.log(`${YEAR}년 전체 행 수: ${rows.length}`);

  const byKey = new Map(rows.map((r) => [`${r.stockCode}:${r.tradeDate}`, r]));

  for (const code of SAMPLE_CODES) {
    const codeRows = rows.filter((r) => r.stockCode === code);
    console.log(`\n[${code}] ${YEAR}년 행 수: ${codeRows.length}`);
    for (const date of SAMPLE_DATES) {
      const row = byKey.get(`${code}:${date}`);
      if (!row) {
        console.log(`  ${date}: 없음`);
        continue;
      }
      console.log(
        `  ${date}: 종가=${row.closePrice}, 거래량=${row.volume}, 시총(억)=${row.marketCapEok}, ` +
          `상장주식수=${row.listedShares}, 거래대금=${row.tradingValue}`
      );
    }
  }

  const { data: files, error } = await supabaseAdmin.storage.from(BUCKET).list("", { limit: 1000 });
  if (error) throw new Error(`버킷 목록 조회 실패: ${error.message}`);
  const totalBytes = (files ?? []).reduce((sum, f) => sum + (f.metadata?.size ?? 0), 0);
  const yearFile = (files ?? []).find((f) => f.name === `${YEAR}.parquet`);
  console.log(`\n버킷 전체 파일 수: ${files?.length ?? 0}, 전체 크기: ${(totalBytes / 1024 / 1024).toFixed(2)}MB`);
  console.log(`${YEAR}.parquet 크기: ${yearFile ? ((yearFile.metadata?.size ?? 0) / 1024).toFixed(1) + "KB" : "없음"}`);
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});

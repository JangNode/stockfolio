/**
 * [디스포저블 진단 스크립트] 생존편향 백필 3단계 실행 전 — stock-daily-prices
 * Storage 버킷의 현재 실사용량을 확인한다(무료 쿼터 1GB 대비 여유 확인,
 * supabase/migrations의 20260827060000_dh_daily_prices_to_storage.sql 참고).
 * 재백필로 상장폐지 종목이 추가되면 얼마나 늘어날지 가늠하는 데도 쓴다.
 *
 * DB/Storage 쓰기 없음(순수 조회).
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-stock-daily-prices-storage-usage.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const BUCKET = "stock-daily-prices";

async function main(): Promise<void> {
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).list("", {
    limit: 1000,
    sortBy: { column: "name", order: "asc" },
  });
  if (error) throw new Error(`버킷 목록 조회 실패: ${error.message}`);

  const files = data ?? [];
  let totalBytes = 0;

  console.log(`${BUCKET} 버킷 파일 ${files.length}개:`);
  for (const file of files) {
    const size = file.metadata?.size ?? 0;
    totalBytes += size;
    console.log(`  ${file.name}: ${(size / 1024 / 1024).toFixed(2)} MB`);
  }

  const totalMb = totalBytes / 1024 / 1024;
  const quotaMb = 1024; // 무료 플랜 1GB
  console.log(`\n총 사용량: ${totalMb.toFixed(2)} MB / ${quotaMb} MB (${((totalMb / quotaMb) * 100).toFixed(1)}%)`);
  console.log(`남은 여유: ${(quotaMb - totalMb).toFixed(2)} MB`);
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});

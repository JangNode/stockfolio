/**
 * [디스포저블 진단 스크립트] 전종목 확장 재백필 2015~2026 확장 전 — 전체 Storage
 * 사용량(모든 버킷)을 실측한다. 무료 쿼터 1GB 대비 여유를 확인하고, 확장 후 예상
 * 사용률을 계산하는 데 쓴다. DB/Storage 쓰기 없음(순수 조회).
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-storage-usage-before-widen-2015-2026.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main(): Promise<void> {
  const { data: buckets, error: bucketsError } = await supabaseAdmin.storage.listBuckets();
  if (bucketsError) throw new Error(`버킷 목록 조회 실패: ${bucketsError.message}`);

  let grandTotalBytes = 0;

  for (const bucket of buckets ?? []) {
    const { data, error } = await supabaseAdmin.storage.from(bucket.id).list("", {
      limit: 1000,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) {
      console.log(`[${bucket.id}] 목록 조회 실패: ${error.message}`);
      continue;
    }

    const files = data ?? [];
    let bucketBytes = 0;
    console.log(`\n[${bucket.id}] 파일 ${files.length}개:`);
    for (const file of files) {
      const size = file.metadata?.size ?? 0;
      bucketBytes += size;
      console.log(`  ${file.name}: ${(size / 1024 / 1024).toFixed(2)} MB`);
    }
    console.log(`  [${bucket.id}] 소계: ${(bucketBytes / 1024 / 1024).toFixed(2)} MB`);
    grandTotalBytes += bucketBytes;
  }

  const totalMb = grandTotalBytes / 1024 / 1024;
  const quotaMb = 1024;
  console.log(`\n=== 전체 Storage 사용량 ===`);
  console.log(`총 사용량: ${totalMb.toFixed(2)} MB / ${quotaMb} MB (${((totalMb / quotaMb) * 100).toFixed(1)}%)`);
  console.log(`남은 여유: ${(quotaMb - totalMb).toFixed(2)} MB`);
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});

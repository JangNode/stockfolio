/**
 * (1회성) dh_ → stock_ 네이밍 정리(2026-08-28)의 마지막 단계 — 기존 버킷
 * dh-daily-prices를 완전히 지운다. scripts/migrate-stock-prices-bucket.ts가 이미
 * 모든 연도별 Parquet 파일을 stock-daily-prices 버킷으로 복사했고(16개 성공, 0개
 * 실패 확인됨), 새 버킷에서 정상 동작이 확인된 뒤에만 실행해야 한다. Storage 버킷은
 * 비어 있어야 삭제할 수 있어 emptyBucket으로 먼저 안의 파일을 지운 다음 deleteBucket을
 * 부른다.
 *
 * server-only로 막힌 lib/supabaseAdmin.ts를 순수 Node 스크립트에서도 재사용하려면
 * "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/delete-old-dh-daily-prices-bucket.ts
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const OLD_BUCKET = "dh-daily-prices";

async function main(): Promise<void> {
  const { error: emptyError } = await supabaseAdmin.storage.emptyBucket(OLD_BUCKET);
  if (emptyError) throw new Error(`${OLD_BUCKET} 비우기 실패: ${emptyError.message}`);
  console.log(`${OLD_BUCKET} 버킷 안의 파일을 모두 지웠습니다.`);

  const { error: deleteError } = await supabaseAdmin.storage.deleteBucket(OLD_BUCKET);
  if (deleteError) throw new Error(`${OLD_BUCKET} 버킷 삭제 실패: ${deleteError.message}`);
  console.log(`${OLD_BUCKET} 버킷을 삭제했습니다.`);
}

main().catch((error) => {
  console.error("버킷 삭제 중 오류:", error);
  process.exit(1);
});

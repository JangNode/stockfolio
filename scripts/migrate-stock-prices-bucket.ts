/**
 * (1회성) dh_ → stock_ 네이밍 정리(2026-08-28)의 일부 — 기존 버킷 dh-daily-prices에
 * 있는 연도별 Parquet 파일을 새 버킷 stock-daily-prices로 복사한다. Storage 버킷은
 * id를 직접 rename할 수 없어서(storage.objects.bucket_id 참조 관계, migrations의
 * 20260828010000_rename_dh_tables_to_stock.sql 코멘트 참고) 새 버킷을 만들고 파일을
 * 옮기는 방식을 쓴다. 원본은 지우지 않는다 — 새 버킷에서 정상 동작을 확인한 뒤
 * 수동으로 지운다.
 *
 * server-only로 막힌 lib/supabaseAdmin.ts를 순수 Node 스크립트에서도 재사용하려면
 * "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/migrate-stock-prices-bucket.ts
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const OLD_BUCKET = "dh-daily-prices";
const NEW_BUCKET = "stock-daily-prices";

async function main(): Promise<void> {
  const { data: files, error: listError } = await supabaseAdmin.storage.from(OLD_BUCKET).list("");
  if (listError) throw new Error(`${OLD_BUCKET} 목록 조회 실패: ${listError.message}`);
  if (!files || files.length === 0) {
    console.log(`${OLD_BUCKET}에 파일이 없습니다. 옮길 게 없습니다.`);
    return;
  }

  console.log(`${OLD_BUCKET} → ${NEW_BUCKET}로 ${files.length}개 파일을 복사합니다.`);

  let copied = 0;
  let failed = 0;

  for (const file of files) {
    try {
      const { data: blob, error: downloadError } = await supabaseAdmin.storage.from(OLD_BUCKET).download(file.name);
      if (downloadError) throw new Error(downloadError.message);

      const { error: uploadError } = await supabaseAdmin.storage.from(NEW_BUCKET).upload(file.name, blob, {
        contentType: "application/octet-stream",
        upsert: true,
      });
      if (uploadError) throw new Error(uploadError.message);

      copied++;
      console.log(`  ${file.name}: 복사 완료`);
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${file.name} 복사 실패: ${message}`);
    }
  }

  console.log(`복사 완료: ${copied}개 성공, ${failed}개 실패${failed > 0 ? " (다음 실행에서 upsert로 재시도됨)" : ""}`);
  console.log(`${NEW_BUCKET}에서 정상 동작을 확인한 뒤, ${OLD_BUCKET} 버킷은 Supabase 대시보드에서 수동으로 지워주세요.`);
}

main().catch((error) => {
  console.error("버킷 복사 중 오류:", error);
  process.exit(1);
});

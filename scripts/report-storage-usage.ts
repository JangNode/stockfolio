/** [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] Supabase Storage 버킷별 파일 수·총 크기 보고. */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const mb = (b: number): string => (b / 1048576).toFixed(2);
const PAGE = 1000;

async function walk(bucket: string, prefix: string, acc: { files: number; bytes: number }): Promise<void> {
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabaseAdmin.storage.from(bucket).list(prefix, { limit: PAGE, offset });
    if (error) throw new Error(`${bucket}/${prefix} 목록 실패: ${error.message}`);
    for (const e of data ?? []) {
      if (e.id === null) await walk(bucket, prefix ? `${prefix}/${e.name}` : e.name, acc);
      else { acc.files++; acc.bytes += Number((e.metadata as { size?: number } | null)?.size ?? 0); }
    }
    if (!data || data.length < PAGE) break;
  }
}

async function main(): Promise<void> {
  const { data: buckets, error } = await supabaseAdmin.storage.listBuckets();
  if (error) throw new Error(`버킷 목록 실패: ${error.message}`);
  let files = 0, bytes = 0;
  console.log("| 버킷 | 공개 | 파일 수 | 총 크기 B | 총 크기 MiB |\n|---|---|---|---|---|");
  for (const b of buckets ?? []) {
    const acc = { files: 0, bytes: 0 };
    await walk(b.name, "", acc);
    files += acc.files; bytes += acc.bytes;
    console.log(`| ${b.name} | ${b.public ? "예" : "아니오"} | ${acc.files} | ${acc.bytes} | ${mb(acc.bytes)} |`);
  }
  console.log(`| 합계 | | ${files} | ${bytes} | ${mb(bytes)} |`);
}
main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e); process.exit(1); });

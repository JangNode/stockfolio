/**
 * scripts/sync-central-bank-news.ts가 실행된 이후 DB에 실제로 잘 반영됐는지
 * 확인하는 1회성 검증 스크립트. 확인 후 삭제한다.
 */
import { getRecentCentralBankNews } from "@/lib/newsStorage";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

async function main() {
  const recent = await getRecentCentralBankNews(10);
  console.log(`최근 뉴스 ${recent.length}건:`);
  for (const item of recent) {
    console.log(`  [${item.source}] ${item.publishedAt} ${item.title} -> ${item.link}`);
  }

  const { count, error } = await supabaseAdmin
    .from("central_bank_news")
    .select("*", { count: "exact", head: true });
  if (error) throw new Error(error.message);
  console.log(`전체 행 수: ${count}`);

  const { data: bySource, error: bySourceError } = await supabaseAdmin
    .from("central_bank_news")
    .select("source, feed_key")
    .limit(1000);
  if (bySourceError) throw new Error(bySourceError.message);
  const counts: Record<string, number> = {};
  for (const row of bySource ?? []) {
    const key = `${row.source}/${row.feed_key}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  console.log(`feed_key별 건수: ${JSON.stringify(counts)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

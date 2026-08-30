/**
 * FOMC/한국은행 관련 뉴스를 연준·한국은행 공식 RSS에서 수집해 DB에 반영하는
 * 배치. 수집 + 저장까지만 하고 해석(매파/비둘기파 등)은 하지 않는다. link
 * unique 제약으로 중복을 걸러내고, 실행할 때마다 30일 지난 항목을 함께 정리한다.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/sync-central-bank-news.ts
 */
import { NEWS_FEED_SOURCES, fetchNewsFeed } from "@/lib/centralBankNewsSources";
import { upsertCentralBankNews, deleteOldCentralBankNews, type CentralBankNewsRow } from "@/lib/newsStorage";

async function main(): Promise<void> {
  let hadFailure = false;
  const allRows: CentralBankNewsRow[] = [];

  for (const feed of NEWS_FEED_SOURCES) {
    try {
      const items = await fetchNewsFeed(feed.url);
      console.log(`[${feed.feedKey}] ${items.length}건 수집`);
      for (const item of items) {
        allRows.push({
          source: feed.source,
          feedKey: feed.feedKey,
          title: item.title,
          link: item.link,
          publishedAt: item.publishedAt,
        });
      }
    } catch (e) {
      hadFailure = true;
      console.error(`[${feed.feedKey}] 수집 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await upsertCentralBankNews(allRows);
  console.log(`총 ${allRows.length}건 upsert 시도 완료(중복 링크는 무시됨)`);

  await deleteOldCentralBankNews();
  console.log("30일 지난 뉴스 정리 완료");

  if (hadFailure) {
    console.error("하나 이상의 피드 수집에 실패했습니다 — 위 로그를 확인하세요.");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("중앙은행 뉴스 수집 배치 중 예상치 못한 오류가 발생했습니다:", error);
  process.exit(1);
});

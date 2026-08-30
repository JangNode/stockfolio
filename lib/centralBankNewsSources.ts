import "server-only";

export interface NewsFeedSource {
  source: "FED" | "BOK";
  feedKey: string;
  url: string;
}

/** 2026-08-30 GitHub Actions 진단으로 확인한 실제 RSS 피드. 연준은
 * federalreserve.gov/feeds/feeds.htm에 공개된 통화정책 보도자료/연설·증언
 * 피드, 한국은행은 bok.or.kr의 RSS 안내 팝업(static/view/popup/rss_popup.html)에
 * 나열된 보도자료(통화정책)/총재 연설 피드다. */
export const NEWS_FEED_SOURCES: NewsFeedSource[] = [
  { source: "FED", feedKey: "fed_monetary", url: "https://www.federalreserve.gov/feeds/press_monetary.xml" },
  {
    source: "FED",
    feedKey: "fed_speeches",
    url: "https://www.federalreserve.gov/feeds/speeches_and_testimony.xml",
  },
  {
    source: "BOK",
    feedKey: "bok_monetary",
    url: "https://www.bok.or.kr/portal/bbs/P0000559/news.rss?menuNo=200690",
  },
  {
    source: "BOK",
    feedKey: "bok_governor",
    url: "https://www.bok.or.kr/portal/bbs/P0002575/news.rss?menuNo=200041",
  },
];

export interface NewsFeedItem {
  title: string;
  link: string;
  publishedAt: string; // ISO
}

function extractTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`));
  return m?.[1]?.trim() ?? "";
}

/** 표준 RSS 2.0 <item> 목록을 파싱한다. title/link/pubDate가 CDATA로 감싸져
 * 있을 수도 없을 수도 있어(연준 vs 한국은행 피드가 서로 다름) 둘 다 처리한다. */
export async function fetchNewsFeed(url: string): Promise<NewsFeedItem[]> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; stockfolio-news-sync/1.0)" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`뉴스 피드 요청 실패 (${url}, ${res.status})`);
  }
  const xml = await res.text();

  const items: NewsFeedItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    if (!title || !link || !pubDate) continue;
    const publishedAt = new Date(pubDate);
    if (Number.isNaN(publishedAt.getTime())) continue;
    items.push({ title, link, publishedAt: publishedAt.toISOString() });
  }
  return items;
}

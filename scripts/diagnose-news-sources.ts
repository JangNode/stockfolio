/**
 * FOMC/한국은행 뉴스 수집 기능을 만들기 전, 실제 소스 구조를 확인하기 위한
 * 1회성 진단 스크립트(4차). BOK RSS 응답에 pubDate(또는 대체 가능한 날짜) 필드가
 * 있는지, 총재 연설 RSS도 같은 구조인지 확인한다.
 */

function collapse(html: string): string {
  return html.replace(/\s+/g, " ").trim();
}

async function fetchText(url: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; stockfolio-news-diagnose/1.0)" },
  });
  return { status: res.status, text: await res.text() };
}

async function inspectFeed(label: string, url: string) {
  console.log(`\n===== ${label} =====`);
  const res = await fetchText(url);
  console.log(`status: ${res.status}, raw length: ${res.text.length}`);
  const text = collapse(res.text);
  const hasPubDate = text.includes("<pubDate>");
  console.log(`pubDate 포함 여부: ${hasPubDate}`);
  // 첫 item 전체를 뽑아본다.
  const itemMatch = text.match(/<item>([\s\S]*?)<\/item>/);
  if (itemMatch) {
    console.log(`첫 item 전체: ${itemMatch[0].slice(0, 1500)}`);
  }
  const itemCount = [...text.matchAll(/<item>/g)].length;
  console.log(`item 개수: ${itemCount}`);
}

async function main() {
  await inspectFeed(
    "BOK 보도자료(통화정책) RSS",
    "https://www.bok.or.kr/portal/bbs/P0000559/news.rss?menuNo=200690"
  );
  await inspectFeed(
    "BOK 총재 연설 및 강연 RSS",
    "https://www.bok.or.kr/portal/bbs/P0002575/news.rss?menuNo=200041"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

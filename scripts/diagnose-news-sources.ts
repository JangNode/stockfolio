/**
 * FOMC/한국은행 뉴스 수집 기능을 만들기 전, 실제 소스 구조를 확인하기 위한
 * 1회성 진단 스크립트. 이 샌드박스는 federalreserve.gov/bok.or.kr을 직접 못 붙어
 * GitHub Actions(비프록시 환경)에서 실행해 확인한다. 확인 후 삭제한다.
 *
 * 확인할 것:
 * 1) federalreserve.gov/feeds/feeds.htm에서 실제 제공하는 RSS 피드 URL 전체 목록
 *    (보도자료/연설/증언 카테고리)
 * 2) BOK 보도자료 목록 페이지에 RSS 링크(<link rel="alternate"
 *    type="application/rss+xml">나 rss.do류 URL)가 실제로 있는지
 * 3) (참고) 이미 확인한 press_monetary.xml 외에 몇 개 피드가 최근 항목을
 *    실제로 담고 있는지 간단히 확인
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

async function main() {
  console.log("\n===== federalreserve.gov/feeds/feeds.htm =====");
  const feedsPage = await fetchText("https://www.federalreserve.gov/feeds/feeds.htm");
  console.log(`status: ${feedsPage.status}`);
  const feedsText = collapse(feedsPage.text);
  console.log(`collapsed length: ${feedsText.length}`);

  // href="...xml" 링크와 그 직전의 링크 텍스트를 함께 뽑는다.
  const linkPattern = /<a[^>]*href="([^"]+\.xml)"[^>]*>([^<]*)<\/a>/g;
  const feeds: { href: string; label: string }[] = [];
  for (const m of feedsText.matchAll(linkPattern)) {
    feeds.push({ href: m[1], label: m[2].trim() });
  }
  console.log(`XML 피드 링크 ${feeds.length}개:`);
  for (const f of feeds) console.log(`  ${f.label} -> ${f.href}`);

  console.log("\n===== BOK 통화정책 보도자료 목록 =====");
  const bokMonetary = await fetchText("https://www.bok.or.kr/portal/bbs/P0000559/list.do?menuNo=200690");
  console.log(`status: ${bokMonetary.status}`);
  const bokMonetaryText = collapse(bokMonetary.text);
  console.log(`collapsed length: ${bokMonetaryText.length}`);
  const rssLinkPattern = /<link[^>]*type="application\/rss\+xml"[^>]*>|href="[^"]*rss[^"]*"|href="[^"]*\.xml"/gi;
  const rssMatches = [...bokMonetaryText.matchAll(rssLinkPattern)].map((m) => m[0]);
  console.log(`RSS 관련 매치: ${JSON.stringify(rssMatches.slice(0, 20))}`);
  // 게시물 목록 구조도 같이 본다(파싱 대체용).
  const listIdx = bokMonetaryText.indexOf("게시물");
  console.log(`"게시물" 주변: ${bokMonetaryText.slice(Math.max(0, listIdx - 100), listIdx + 1500)}`);
  const tbodyMatch = bokMonetaryText.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (tbodyMatch) {
    console.log(`tbody 앞부분: ${tbodyMatch[1].slice(0, 2500)}`);
  } else {
    console.log("tbody를 못 찾음 - 다른 구조일 수 있음");
  }

  console.log("\n===== BOK 전체 보도자료 목록(newsData) =====");
  const bokAll = await fetchText("https://www.bok.or.kr/portal/singl/newsData/list.do?menuNo=201263");
  console.log(`status: ${bokAll.status}`);
  const bokAllText = collapse(bokAll.text);
  console.log(`collapsed length: ${bokAllText.length}`);
  const rssMatches2 = [...bokAllText.matchAll(rssLinkPattern)].map((m) => m[0]);
  console.log(`RSS 관련 매치: ${JSON.stringify(rssMatches2.slice(0, 20))}`);
  const tbodyMatch2 = bokAllText.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (tbodyMatch2) {
    console.log(`tbody 앞부분: ${tbodyMatch2[1].slice(0, 2500)}`);
  } else {
    console.log("tbody를 못 찾음 - 다른 구조일 수 있음");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

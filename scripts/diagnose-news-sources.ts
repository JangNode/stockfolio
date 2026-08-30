/**
 * FOMC/한국은행 뉴스 수집 기능을 만들기 전, 실제 소스 구조를 확인하기 위한
 * 1회성 진단 스크립트(2차). 1차 시도에서 Fed feeds.htm의 .xml 링크 정규식이
 * 안 맞았고, BOK는 "RSS 안내" 팝업 링크만 나와 실제 피드 URL 패턴을 더 파야 한다.
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

function printSnippetsAround(text: string, pattern: RegExp, windowChars: number, maxSnippets: number) {
  const matches = [...text.matchAll(pattern)];
  console.log(`매치 ${matches.length}개`);
  const seen = new Set<number>();
  let printed = 0;
  for (const m of matches) {
    if (printed >= maxSnippets) break;
    const idx = m.index ?? 0;
    const bucket = Math.floor(idx / windowChars);
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    const start = Math.max(0, idx - 80);
    const end = Math.min(text.length, idx + windowChars);
    console.log(`[${idx}] ${text.slice(start, end)}`);
    printed++;
  }
}

async function main() {
  console.log("\n===== federalreserve.gov/feeds/feeds.htm (RAW, 비압축) =====");
  const feedsPage = await fetchText("https://www.federalreserve.gov/feeds/feeds.htm");
  console.log(`status: ${feedsPage.status}, raw length: ${feedsPage.text.length}`);
  const rawFeedMatches = [...feedsPage.text.matchAll(/href="([^"]*feeds[^"]*)"/gi)];
  console.log(`href*=feeds 매치 ${rawFeedMatches.length}개:`);
  const seenHrefs = new Set<string>();
  for (const m of rawFeedMatches) {
    if (seenHrefs.has(m[1])) continue;
    seenHrefs.add(m[1]);
    console.log(`  ${m[1]}`);
  }

  console.log("\n===== BOK RSS 안내 팝업 =====");
  const popup = await fetchText("https://www.bok.or.kr/static/view/popup/rss_popup.html");
  console.log(`status: ${popup.status}, raw length: ${popup.text.length}`);
  console.log(collapse(popup.text).slice(0, 3000));

  console.log("\n===== BOK 통화정책 보도자료 목록 - RSS 링크 주변 원문(비압축) =====");
  const bokMonetary = await fetchText("https://www.bok.or.kr/portal/bbs/P0000559/list.do?menuNo=200690");
  const idx = bokMonetary.text.indexOf("rss_popup");
  console.log(`rss_popup 위치: ${idx}`);
  if (idx >= 0) {
    console.log(bokMonetary.text.slice(Math.max(0, idx - 1000), idx + 500));
  }

  console.log("\n===== BOK 통화정책 보도자료 목록 - 게시물 리스트 구조(비압축, ul/li 기반 가능성) =====");
  const bokText = collapse(bokMonetary.text);
  printSnippetsAround(bokText, /<ul class="board-list"|<div class="board-list"|class="bl-title"|<li class="bl-/gi, 500, 8);
  // 날짜/제목 패턴으로도 탐색
  printSnippetsAround(bokText, /\d{4}\.\d{2}\.\d{2}/g, 400, 10);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

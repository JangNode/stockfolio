/**
 * FOMC/한국은행 뉴스 수집 기능을 만들기 전, 실제 소스 구조를 확인하기 위한
 * 1회성 진단 스크립트(3차). BOK RSS 안내 팝업 전체(3000자에서 잘렸던 나머지)를
 * 확인해 총재 연설 관련 피드가 있는지 보고, 실제로 몇몇 피드를 fetch해 아이템
 * 구조(제목/링크/날짜 필드명)도 확인한다.
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
  console.log("\n===== BOK RSS 안내 팝업 전체 =====");
  const popup = await fetchText("https://www.bok.or.kr/static/view/popup/rss_popup.html");
  const popupText = collapse(popup.text);
  console.log(`raw length: ${popup.text.length}, collapsed length: ${popupText.length}`);
  console.log(popupText.slice(2500));

  console.log("\n===== BOK 보도자료(통화정책) RSS 실제 응답 =====");
  const bokRss = await fetchText("https://www.bok.or.kr/portal/bbs/P0000559/news.rss?menuNo=200690");
  console.log(`status: ${bokRss.status}, raw length: ${bokRss.text.length}`);
  console.log(collapse(bokRss.text).slice(0, 3000));

  console.log("\n===== Fed press_monetary.xml 아이템 필드 재확인(참고) =====");
  const fedRss = await fetchText("https://www.federalreserve.gov/feeds/speeches_and_testimony.xml");
  console.log(`status: ${fedRss.status}, raw length: ${fedRss.text.length}`);
  console.log(collapse(fedRss.text).slice(0, 2000));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

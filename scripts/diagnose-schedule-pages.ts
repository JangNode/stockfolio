/**
 * FOMC/금통위 일정 자동 수집기를 만들기 전, 실제 페이지 HTML 구조를 확인하기 위한
 * 1회성 진단 스크립트. 3차: (1) FOMC 2027 섹션이 실제로 같은 구조로 존재하는지,
 * (2) BOK 페이지에 아직 발표 안 된 미래 연도(pYear)를 넣으면 어떻게 응답하는지
 * (빈 테이블/다른 연도로 리다이렉트 등) 확인한다.
 */

function collapse(html: string): string {
  return html.replace(/\s+/g, " ").trim();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; stockfolio-schedule-diagnose/1.0)" },
  });
  console.log(`status: ${res.status}`);
  return collapse(await res.text());
}

async function main() {
  console.log("\n===== FOMC calendar page: 2027 섹션 확인 =====");
  const fomcText = await fetchText("https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm");
  const idx2027 = fomcText.indexOf("2027 FOMC Meetings");
  console.log(`"2027 FOMC Meetings" 위치: ${idx2027}`);
  if (idx2027 >= 0) {
    console.log(fomcText.slice(Math.max(0, idx2027 - 100), idx2027 + 2500));
  } else {
    console.log("2027 섹션 텍스트를 찾지 못함 - 앵커 링크만 있고 실제 패널은 아직 없을 수 있음");
    const idxAnchor = fomcText.indexOf('id="45694"');
    console.log(`id="45694" 위치: ${idxAnchor}`);
    if (idxAnchor >= 0) console.log(fomcText.slice(Math.max(0, idxAnchor - 100), idxAnchor + 2500));
  }

  for (const year of [2025, 2027]) {
    console.log(`\n===== BOK 금통위 목록 pYear=${year} =====`);
    const url = `https://www.bok.or.kr/portal/singl/crncyPolicyDrcMtg/listYear.do?mtgSe=A&menuNo=200755&pYear=${year}`;
    const text = await fetchText(url);
    console.log(`collapsed length: ${text.length}`);
    const h3Match = text.match(/<h3>(\d{4}년)<\/h3>/);
    console.log(`페이지 상단 연도 표시(h3): ${h3Match ? h3Match[1] : "없음"}`);
    const captionIdx = text.indexOf("통화정책방향 회의</caption>");
    console.log(`caption 위치: ${captionIdx}`);
    if (captionIdx >= 0) {
      const tbodyMatch = text.slice(captionIdx).match(/<tbody>([\s\S]*?)<\/tbody>/);
      if (tbodyMatch) {
        const rows = [...tbodyMatch[1].matchAll(/<th scope="row">\s*([^<]+?)\s*<\/th>/g)].map((m) => m[1]);
        console.log(`행 개수: ${rows.length}, 내용: ${JSON.stringify(rows)}`);
      } else {
        console.log("tbody를 찾지 못함");
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

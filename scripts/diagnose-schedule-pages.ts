/**
 * FOMC/금통위 일정 자동 수집기를 만들기 전, 실제 페이지 HTML 구조를 확인하기 위한
 * 1회성 진단 스크립트. 2차: FOMC/RSS 구조는 1차에서 확인했으니, BOK 페이지의
 * 실제 회의 목록 테이블(사이트 내비게이션 밖 본문 영역)만 집중적으로 살핀다 —
 * 1차 시도에서는 "결정회의|통화정책방향|금융안정" 키워드가 상단 내비게이션 메뉴에도
 * 많이 걸려 있어 실제 테이블(본문, 대략 6만자 이후)까지 도달하지 못했다.
 */

function collapse(html: string): string {
  return html.replace(/\s+/g, " ").trim();
}

function printSnippetsAround(
  label: string,
  text: string,
  pattern: RegExp,
  windowChars: number,
  maxSnippets: number,
  minIndex = 0
) {
  const matches = [...text.matchAll(pattern)].filter((m) => (m.index ?? 0) >= minIndex);
  console.log(`--- ${label}: ${matches.length}개 매치(minIndex=${minIndex} 이후) ---`);
  const seen = new Set<number>();
  let printed = 0;
  for (const m of matches) {
    if (printed >= maxSnippets) break;
    const idx = m.index ?? 0;
    const bucket = Math.floor(idx / windowChars);
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    const start = Math.max(0, idx - 60);
    const end = Math.min(text.length, idx + windowChars);
    console.log(`[${idx}] ${text.slice(start, end)}`);
    printed++;
  }
}

async function fetchAndAnalyze(label: string, url: string) {
  console.log(`\n===== ${label} =====`);
  console.log(`URL: ${url}`);
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; stockfolio-schedule-diagnose/1.0)" },
  });
  console.log(`status: ${res.status}`);
  const raw = await res.text();
  const text = collapse(raw);
  console.log(`collapsed length: ${text.length}`);

  // 내비게이션 메뉴를 지나 본문에 도달했을 법한 지점부터 다양한 날짜/회차 패턴을 찾는다.
  const minIndex = 55000;
  printSnippetsAround("YYYY.MM.DD 형식 날짜", text, /\d{4}\.\s?\d{1,2}\.\s?\d{1,2}/g, 300, 15, minIndex);
  printSnippetsAround("YYYY년 M월 D일 형식 날짜", text, /\d{4}년\s?\d{1,2}월\s?\d{1,2}일/g, 300, 15, minIndex);
  printSnippetsAround("제N차 (회차)", text, /제\s?\d+\s?차/g, 300, 20, minIndex);
  printSnippetsAround("테이블/리스트 구조(table|tbody|tr|board)", text, /<(table|tbody|tr|thead)[ >]/g, 250, 15, minIndex);
  printSnippetsAround("연도 셀렉트박스(select|option)", text, /<select[^>]*>|pYear/g, 300, 10, 0);

  // 혹시나 해서 본문 영역 자체를 몇 조각으로 나눠 원문 그대로도 남긴다(구조 파악용).
  console.log(`--- RAW 슬라이스(6만~7.5만) ---`);
  console.log(text.slice(60000, 75000));
}

async function main() {
  await fetchAndAnalyze(
    "BOK 통화정책방향 결정회의 목록 (2026, mtgSe=A)",
    "https://www.bok.or.kr/portal/singl/crncyPolicyDrcMtg/listYear.do?menuNo=200755&mtgSe=A&pYear=2026"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

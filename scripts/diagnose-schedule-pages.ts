/**
 * FOMC/금통위 일정 자동 수집기를 만들기 전, 실제 페이지 HTML 구조를 확인하기 위한
 * 1회성 진단 스크립트. 이 샌드박스는 federalreserve.gov/bok.or.kr을 직접 못 붙어
 * GitHub Actions(비프록시 환경)에서 실행해 원본 HTML을 로그로 남긴다. 파서 작성 후
 * 곧바로 삭제한다.
 *
 * 원본 HTML을 그대로 console.log하면 GitHub Actions 로그가 줄 단위로 쪼개져 수만
 * 줄이 생겨 tail_lines로 못 읽는 문제가 있었다 — 공백을 한 줄로 뭉치고, 연도/월
 * 패턴 주변만 잘라서 로그 줄 수를 억제한다.
 */

function collapse(html: string): string {
  return html.replace(/\s+/g, " ").trim();
}

function printSnippetsAround(label: string, text: string, pattern: RegExp, windowChars: number, maxSnippets: number) {
  const matches = [...text.matchAll(pattern)];
  console.log(`--- ${label}: ${matches.length}개 매치 ---`);
  const seen = new Set<number>();
  let printed = 0;
  for (const m of matches) {
    if (printed >= maxSnippets) break;
    const idx = m.index ?? 0;
    // 너무 가까운 매치는 스니펫이 겹치므로 건너뛴다.
    const bucket = Math.floor(idx / windowChars);
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    const start = Math.max(0, idx - 60);
    const end = Math.min(text.length, idx + windowChars);
    console.log(`[${idx}] ${text.slice(start, end)}`);
    printed++;
  }
}

async function fetchAndAnalyze(label: string, url: string, opts: { yearPattern?: boolean; keyword?: string } = {}) {
  console.log(`\n===== ${label} =====`);
  console.log(`URL: ${url}`);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; stockfolio-schedule-diagnose/1.0)",
      },
    });
    console.log(`status: ${res.status}`);
    const raw = await res.text();
    console.log(`raw length: ${raw.length}`);
    const text = collapse(raw);
    console.log(`collapsed length: ${text.length}`);
    console.log(`HEAD 800자: ${text.slice(0, 800)}`);

    if (opts.yearPattern) {
      printSnippetsAround("연도(2025~2028) 주변", text, /20(2[5-8])/g, 500, 12);
    }
    if (opts.keyword) {
      printSnippetsAround(`키워드 "${opts.keyword}" 주변`, text, new RegExp(opts.keyword, "g"), 400, 15);
    }
  } catch (e) {
    console.log(`FETCH ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  await fetchAndAnalyze("FOMC calendar page", "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", {
    yearPattern: true,
  });

  await fetchAndAnalyze("Fed press_monetary RSS feed", "https://www.federalreserve.gov/feeds/press_monetary.xml", {
    keyword: "item",
  });

  await fetchAndAnalyze(
    "BOK 통화정책방향 결정회의 목록 (2026, mtgSe=A)",
    "https://www.bok.or.kr/portal/singl/crncyPolicyDrcMtg/listYear.do?menuNo=200755&mtgSe=A&pYear=2026",
    { keyword: "결정회의|통화정책방향|금융안정" }
  );

  await fetchAndAnalyze(
    "BOK 통화정책방향 결정회의 목록 (파라미터 없이 기본)",
    "https://www.bok.or.kr/portal/singl/crncyPolicyDrcMtg/listYear.do?menuNo=200755",
    { keyword: "결정회의|통화정책방향|금융안정" }
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

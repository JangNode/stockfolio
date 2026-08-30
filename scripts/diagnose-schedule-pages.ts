/**
 * FOMC/금통위 일정 자동 수집기를 만들기 전, 실제 페이지 HTML 구조를 확인하기 위한
 * 1회성 진단 스크립트. 이 샌드박스는 federalreserve.gov/bok.or.kr을 직접 못 붙어
 * GitHub Actions(비프록시 환경)에서 실행해 원본 HTML을 로그로 남긴다. 파서 작성 후
 * 곧바로 삭제한다.
 */

async function fetchAndLog(label: string, url: string) {
  console.log(`\n===== ${label} =====`);
  console.log(`URL: ${url}`);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; stockfolio-schedule-diagnose/1.0)",
      },
    });
    console.log(`status: ${res.status}`);
    const text = await res.text();
    console.log(`length: ${text.length}`);
    console.log(text);
  } catch (e) {
    console.log(`FETCH ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main() {
  await fetchAndLog("FOMC calendar page", "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm");

  await fetchAndLog(
    "Fed press_monetary RSS feed",
    "https://www.federalreserve.gov/feeds/press_monetary.xml"
  );

  await fetchAndLog(
    "BOK 통화정책방향 결정회의 목록 (2026, mtgSe=A)",
    "https://www.bok.or.kr/portal/singl/crncyPolicyDrcMtg/listYear.do?menuNo=200755&mtgSe=A&pYear=2026"
  );

  await fetchAndLog(
    "BOK 통화정책방향 결정회의 목록 (파라미터 없이 기본)",
    "https://www.bok.or.kr/portal/singl/crncyPolicyDrcMtg/listYear.do?menuNo=200755"
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

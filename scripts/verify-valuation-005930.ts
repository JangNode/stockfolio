/**
 * (임시) DH전략 백필 배치 설계용 — KRX/DART API 일일 호출 한도 확인.
 * 1) 실제 호출 응답 헤더에 rate-limit 관련 필드가 있는지 확인
 * 2) 각 서비스의 안내/가이드 페이지에서 "일일" "한도" "제한" 관련 텍스트를 검색
 * 확인 후 삭제 예정.
 *
 *   tsx --conditions=react-server scripts/verify-valuation-005930.ts
 */

async function dumpHeaders(label: string, url: string, headers: Record<string, string>): Promise<void> {
  console.log(`\n--- ${label} ---`);
  try {
    const res = await fetch(url, { headers });
    console.log(`HTTP 상태: ${res.status}`);
    console.log("응답 헤더 전체:");
    for (const [key, value] of res.headers.entries()) {
      console.log(`  ${key}: ${value}`);
    }
  } catch (error) {
    console.log("요청 실패:", error instanceof Error ? error.message : String(error));
  }
}

function extractLimitMentions(html: string): string[] {
  const results: string[] = [];
  const keywords = ["한도", "제한", "트래픽", "limit", "Limit", "일일", "day"];
  // 태그 제거 후 텍스트만 남겨서 키워드 주변 문맥을 잘라낸다.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

  for (const kw of keywords) {
    let idx = text.indexOf(kw);
    let count = 0;
    while (idx !== -1 && count < 5) {
      const snippet = text.slice(Math.max(0, idx - 60), idx + 120);
      results.push(`[${kw}] ...${snippet}...`);
      idx = text.indexOf(kw, idx + kw.length);
      count++;
    }
  }
  return results;
}

async function dumpPageMentions(label: string, url: string): Promise<void> {
  console.log(`\n--- ${label} 페이지 텍스트에서 한도 관련 문구 검색 ---`);
  try {
    const res = await fetch(url);
    console.log(`HTTP 상태: ${res.status}`);
    if (!res.ok) return;
    const html = await res.text();
    const mentions = extractLimitMentions(html);
    if (mentions.length === 0) {
      console.log("(한도/제한 관련 키워드를 찾지 못함)");
    } else {
      for (const m of mentions) console.log(m);
    }
  } catch (error) {
    console.log("요청 실패:", error instanceof Error ? error.message : String(error));
  }
}

async function main(): Promise<void> {
  const dartKey = process.env.DART_API_KEY;
  const krxKey = process.env.KRX_API_KEY;
  if (!dartKey) throw new Error("DART_API_KEY 환경 변수가 없습니다.");
  if (!krxKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");

  console.log("=== 1) 실제 호출 응답 헤더 확인 ===");
  await dumpHeaders(
    "KRX stk_bydd_trd",
    "https://data-dbg.krx.co.kr/svc/apis/sto/stk_bydd_trd?basDd=20260825",
    { AUTH_KEY: krxKey }
  );
  await dumpHeaders(
    "DART fnlttSinglAcntAll",
    `https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?crtfc_key=${dartKey}&corp_code=00126380&bsns_year=2022&reprt_code=11011&fs_div=CFS`,
    {}
  );

  console.log("\n\n=== 2) 안내 페이지에서 한도 문구 검색 ===");
  await dumpPageMentions("DART 개발가이드/공지", "https://opendart.fss.or.kr/guide/main.do?apiGrpCd=DS001");
  await dumpPageMentions("DART FAQ", "https://opendart.fss.or.kr/notice/noticeList.do");
  await dumpPageMentions("KRX Open API 소개", "https://openapi.krx.co.kr/");
  await dumpPageMentions("KRX 정보데이터시스템 공지", "https://data.krx.co.kr/svc/notice/nia.cmd");
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});

/**
 * (임시) DH전략 백테스트용 과거 PER/PBR 재구성 가능성 확인 — KRX 일별매매정보 API 진단.
 * 후보 URL 두 개(공식 문서 "샘플 URL" 필드 그대로 / "sample" 세그먼트를 뺀 운영용 추정)를
 * 둘 다 실제 호출해서 어느 쪽이 동작하는지, 과거 날짜 조회가 되는지, 응답 구조가 종목
 * 전체 한 번에 오는지 확인한다. 확인 후 삭제 예정.
 *
 *   tsx --conditions=react-server scripts/verify-valuation-005930.ts
 */

const CANDIDATE_URLS = [
  "https://data-dbg.krx.co.kr/svc/sample/apis/sto/stk_bydd_trd",
  "https://data-dbg.krx.co.kr/svc/apis/sto/stk_bydd_trd",
];

async function tryUrl(baseUrl: string, basDd: string, apiKey: string): Promise<void> {
  const url = `${baseUrl}?basDd=${basDd}`;
  console.log(`\n--- 시도: ${url} ---`);
  try {
    const res = await fetch(url, { headers: { AUTH_KEY: apiKey } });
    const text = await res.text();
    console.log(`HTTP 상태: ${res.status}`);
    console.log(`Content-Type: ${res.headers.get("content-type")}`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.log("JSON 파싱 실패, 원문 앞부분:", text.slice(0, 500));
      return;
    }

    const obj = parsed as { OutBlock_1?: unknown[]; [key: string]: unknown };
    if (Array.isArray(obj.OutBlock_1)) {
      console.log(`OutBlock_1 건수: ${obj.OutBlock_1.length}`);
      console.log("첫 행:", JSON.stringify(obj.OutBlock_1[0]));
      const samsung = obj.OutBlock_1.find(
        (row) => (row as { ISU_CD?: string; ISU_SRT_CD?: string }).ISU_SRT_CD === "005930"
      );
      console.log("005930 행:", samsung ? JSON.stringify(samsung) : "(못 찾음)");
    } else {
      console.log("전체 응답(OutBlock_1 없음):", JSON.stringify(parsed).slice(0, 1000));
    }
  } catch (error) {
    console.log("요청 실패:", error instanceof Error ? error.message : String(error));
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");

  console.log("=== 1) 최근 영업일(2026-08-25)로 두 후보 URL 다 시도 ===");
  for (const base of CANDIDATE_URLS) {
    await tryUrl(base, "20260825", apiKey);
  }

  console.log("\n\n=== 2) 과거 날짜(2023-03-15)로 재시도 ===");
  for (const base of CANDIDATE_URLS) {
    await tryUrl(base, "20230315", apiKey);
  }
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});

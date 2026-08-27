/**
 * (임시) KIS 현재가 조회 API(inquire-price) 원본 응답에 PER/PBR/EPS/BPS 필드가
 * 직접 포함되는지 확인하는 읽기 전용 스크립트 — 005930(삼성전자) 기준.
 *
 * 한투(한국투자증권)는 KIS API를 직접 운영하는 증권사라, 앱에 표시되는 PER/PBR이
 * DART 재무제표를 재조합한 값이 아니라 KIS가 자체 계산해 내려주는 값을 그대로 쓰고
 * 있을 가능성이 있다. lib/kis.ts의 getStockPrice는 지금 stck_prpr/prdy_vrss 등
 * 일부 필드만 파싱하고 있어, per/pbr/eps/bps 필드가 실제로 오는지 원본 JSON을
 * 그대로 출력해 확인한다. DB/코드는 건드리지 않는다 — 확인 후 삭제 예정.
 *
 *   tsx --conditions=react-server scripts/verify-valuation-005930.ts
 */

const KIS_BASE_URL = process.env.KIS_BASE_URL ?? "https://openapi.koreainvestment.com:9443";
const TR_ID_INQUIRE_PRICE = "FHKST01010100";

async function getAccessToken(appKey: string, appSecret: string): Promise<string> {
  const res = await fetch(new URL("/oauth2/tokenP", KIS_BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: appKey, appsecret: appSecret }),
  });
  if (!res.ok) throw new Error(`토큰 발급 실패: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function main(): Promise<void> {
  const appKey = process.env.KIS_APP_KEY;
  const appSecret = process.env.KIS_APP_SECRET;
  if (!appKey || !appSecret) throw new Error("KIS_APP_KEY / KIS_APP_SECRET 없음");

  const accessToken = await getAccessToken(appKey, appSecret);

  const url = new URL("/uapi/domestic-stock/v1/quotations/inquire-price", KIS_BASE_URL);
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", "005930");

  const res = await fetch(url, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: TR_ID_INQUIRE_PRICE,
      custtype: "P",
    },
  });

  if (!res.ok) throw new Error(`조회 실패: ${res.status} ${await res.text()}`);
  const data = await res.json();

  console.log("=== KIS inquire-price 원본 응답 (005930) ===");
  console.log(JSON.stringify(data, null, 2));

  const output = data.output ?? {};
  console.log("\n=== PER/PBR/EPS/BPS 관련 필드 후보 ===");
  for (const [key, value] of Object.entries(output)) {
    if (/per|pbr|eps|bps/i.test(key)) {
      console.log(`${key}: ${value}`);
    }
  }
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});

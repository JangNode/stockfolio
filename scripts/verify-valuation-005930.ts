/**
 * (임시) 배당 이력이 빈 배열로 오는 버그 진단용 읽기 전용 스크립트 2차 — 005930
 * 기준. 1차 진단에서 getDividendRecords("005930", 5)가 오류 없이 빈 배열을
 * 반환하는 것까지 확인했지만, 그게 KIS가 진짜로 0건을 준 건지 파싱 문제인지
 * 구분이 안 돼 이번엔 raw KIS 응답(rt_cd/msg1/output)을 그대로 같이 찍는다.
 * DB/코드는 건드리지 않는다 — 확인 후 삭제 예정.
 *
 *   tsx --conditions=react-server scripts/verify-valuation-005930.ts
 */

const KIS_BASE_URL = process.env.KIS_BASE_URL ?? "https://openapi.koreainvestment.com:9443";

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

  const now = new Date();
  const toDate = `${now.getFullYear()}1231`;
  const fromDate = `${now.getFullYear() - 5}0101`;
  console.log(`fromDate=${fromDate}, toDate=${toDate} (now=${now.toISOString()})`);

  const url = new URL("/uapi/domestic-stock/v1/ksdinfo/dividend", KIS_BASE_URL);
  url.searchParams.set("CTS", "");
  url.searchParams.set("GB1", "0");
  url.searchParams.set("F_DT", fromDate);
  url.searchParams.set("T_DT", toDate);
  url.searchParams.set("SHT_CD", "005930");
  url.searchParams.set("HIGH_GB", "");

  console.log(`요청 URL: ${url.toString()}`);

  const res = await fetch(url, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: "HHKDB669102C0",
      custtype: "P",
    },
  });

  console.log(`HTTP 상태: ${res.status}`);
  const body = await res.json();
  console.log("=== raw 응답 ===");
  console.log(JSON.stringify(body, null, 2));
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});

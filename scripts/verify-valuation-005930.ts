/**
 * (임시) 투자자매매동향 API 응답 형태 확인용 읽기 전용 스크립트 — 005930(삼성전자)
 * 기준. "투자자 동향" 카드(외국인/기관/개인 최근 1개월 일별 순매수) 구현 전에
 * inquire-investor(주식현재가 투자자, 날짜 파라미터 없음, 한 번에 몇 건 오는지)와
 * investor-trade-by-stock-daily(종목별 투자자매매동향 일별, 날짜 커서 필요)를 둘 다
 * 실제로 호출해 어느 쪽이 더 적합한지 비교한다. 아울러 이미 호출 중인 inquire-price
 * 원본 응답에서 lstn_stcn(상장주식수)/w52_hgpr(52주 최고가)/w52_lwpr(52주 최저가)
 * 필드도 다시 확인한다(시가총액/상장주식수/최근 1년 최고·최저가 카드용). DB/코드는
 * 건드리지 않는다 — 확인 후 삭제 예정.
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

async function callKis(
  path: string,
  trId: string,
  params: Record<string, string>,
  appKey: string,
  appSecret: string,
  accessToken: string
): Promise<unknown> {
  const url = new URL(path, KIS_BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: trId,
      custtype: "P",
    },
  });

  if (!res.ok) throw new Error(`${trId} 조회 실패: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main(): Promise<void> {
  const appKey = process.env.KIS_APP_KEY;
  const appSecret = process.env.KIS_APP_SECRET;
  if (!appKey || !appSecret) throw new Error("KIS_APP_KEY / KIS_APP_SECRET 없음");

  const accessToken = await getAccessToken(appKey, appSecret);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  console.log("=== inquire-investor (FHKST01010900, 날짜 파라미터 없음) ===");
  const investor = (await callKis(
    "/uapi/domestic-stock/v1/quotations/inquire-investor",
    "FHKST01010900",
    { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: "005930" },
    appKey,
    appSecret,
    accessToken
  )) as { output?: unknown[]; rt_cd: string; msg1: string };
  console.log(`행 개수: ${investor.output?.length ?? 0}`);
  console.log(JSON.stringify(investor, null, 2));
  await wait(300);

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  console.log(`\n=== investor-trade-by-stock-daily (FHPTJ04160001, FID_INPUT_DATE_1=${today}) ===`);
  const daily = (await callKis(
    "/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily",
    "FHPTJ04160001",
    {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: "005930",
      FID_INPUT_DATE_1: today,
      FID_ORG_ADJ_PRC: "",
      FID_ETC_CLS_CODE: "",
    },
    appKey,
    appSecret,
    accessToken
  )) as { output1?: unknown; output2?: unknown[]; rt_cd: string; msg1: string };
  console.log(`output2 행 개수: ${daily.output2?.length ?? 0}`);
  console.log(JSON.stringify(daily, null, 2));
  await wait(300);

  console.log("\n=== inquire-price (lstn_stcn/w52_hgpr/w52_lwpr 재확인) ===");
  const price = (await callKis(
    "/uapi/domestic-stock/v1/quotations/inquire-price",
    "FHKST01010100",
    { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: "005930" },
    appKey,
    appSecret,
    accessToken
  )) as { output: Record<string, unknown> };
  const { lstn_stcn, w52_hgpr, w52_lwpr, hts_avls } = price.output;
  console.log(JSON.stringify({ lstn_stcn, w52_hgpr, w52_lwpr, hts_avls }, null, 2));
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});

/**
 * (임시) KIS 재무제표/비율/배당일정 API 응답 형태 확인용 읽기 전용 스크립트 —
 * 005930(삼성전자) 기준. DART 재무제표/배당 연동을 KIS 자체 API로 전면 교체하기 전에,
 * 손익계산서/대차대조표/수익성비율/성장성비율/예탁원배당일정 응답의 실제 JSON 구조
 * (output이 배열인지, 필드명이 참고한 파이썬 샘플과 일치하는지)를 확인한다.
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

  console.log("=== 손익계산서 (FHKST66430200) ===");
  console.log(
    JSON.stringify(
      await callKis(
        "/uapi/domestic-stock/v1/finance/income-statement",
        "FHKST66430200",
        { FID_DIV_CLS_CODE: "0", fid_cond_mrkt_div_code: "J", fid_input_iscd: "005930" },
        appKey,
        appSecret,
        accessToken
      ),
      null,
      2
    )
  );
  await wait(300);

  console.log("\n=== 대차대조표 (FHKST66430100) ===");
  console.log(
    JSON.stringify(
      await callKis(
        "/uapi/domestic-stock/v1/finance/balance-sheet",
        "FHKST66430100",
        { FID_DIV_CLS_CODE: "0", fid_cond_mrkt_div_code: "J", fid_input_iscd: "005930" },
        appKey,
        appSecret,
        accessToken
      ),
      null,
      2
    )
  );
  await wait(300);

  console.log("\n=== 수익성비율 (FHKST66430400) ===");
  console.log(
    JSON.stringify(
      await callKis(
        "/uapi/domestic-stock/v1/finance/profit-ratio",
        "FHKST66430400",
        { fid_input_iscd: "005930", FID_DIV_CLS_CODE: "0", fid_cond_mrkt_div_code: "J" },
        appKey,
        appSecret,
        accessToken
      ),
      null,
      2
    )
  );
  await wait(300);

  console.log("\n=== 성장성비율 (FHKST66430800) ===");
  console.log(
    JSON.stringify(
      await callKis(
        "/uapi/domestic-stock/v1/finance/growth-ratio",
        "FHKST66430800",
        { fid_input_iscd: "005930", fid_div_cls_code: "0", fid_cond_mrkt_div_code: "J" },
        appKey,
        appSecret,
        accessToken
      ),
      null,
      2
    )
  );
  await wait(300);

  console.log("\n=== 예탁원정보(배당일정) (HHKDB669102C0) ===");
  console.log(
    JSON.stringify(
      await callKis(
        "/uapi/domestic-stock/v1/ksdinfo/dividend",
        "HHKDB669102C0",
        { CTS: "", GB1: "0", F_DT: "20210101", T_DT: "20261231", SHT_CD: "005930", HIGH_GB: "" },
        appKey,
        appSecret,
        accessToken
      ),
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});

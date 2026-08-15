import "server-only";

const KIS_BASE_URL =
  process.env.KIS_BASE_URL ?? "https://openapi.koreainvestment.com:9443";

const TR_ID_INQUIRE_PRICE = "FHKST01010100";

interface AccessToken {
  token: string;
  expiresAt: number;
}

// 프로세스 메모리에 캐시. KIS는 앱키당 토큰 발급 요청 빈도를 제한하고
// 토큰은 발급 후 24시간 동안 유효하므로 만료 전까지 재사용한다.
let cachedToken: AccessToken | null = null;

function getCredentials() {
  const appKey = process.env.KIS_APP_KEY;
  const appSecret = process.env.KIS_APP_SECRET;

  if (!appKey || !appSecret) {
    throw new Error(
      "KIS_APP_KEY / KIS_APP_SECRET 환경 변수가 설정되지 않았습니다."
    );
  }

  return { appKey, appSecret };
}

async function issueAccessToken(): Promise<AccessToken> {
  const { appKey, appSecret } = getCredentials();

  const res = await fetch(`${KIS_BASE_URL}/oauth2/tokenP`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: appKey,
      appsecret: appSecret,
    }),
  });

  if (!res.ok) {
    throw new Error(`KIS 토큰 발급 실패 (${res.status}): ${await res.text()}`);
  }

  const data: { access_token: string; expires_in: number } = await res.json();

  return {
    token: data.access_token,
    // 만료 1분 전에 미리 갱신되도록 여유를 둔다.
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  cachedToken = await issueAccessToken();
  return cachedToken.token;
}

export interface StockPrice {
  stockCode: string;
  currentPrice: number;
  change: number;
  changeRate: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
}

interface InquirePriceResponse {
  rt_cd: string;
  msg1: string;
  output: {
    stck_prpr: string;
    prdy_vrss: string;
    prdy_ctrt: string;
    stck_oprc: string;
    stck_hgpr: string;
    stck_lwpr: string;
    acml_vol: string;
  };
}

/** 국내 주식 현재가 시세를 조회한다. stockCode는 6자리 종목코드 (예: "005930"). */
export async function getStockPrice(stockCode: string): Promise<StockPrice> {
  const { appKey, appSecret } = getCredentials();
  const accessToken = await getAccessToken();

  const url = new URL(
    "/uapi/domestic-stock/v1/quotations/inquire-price",
    KIS_BASE_URL
  );
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", stockCode);

  const res = await fetch(url, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${accessToken}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: TR_ID_INQUIRE_PRICE,
      custtype: "P",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`시세 조회 실패 (${res.status}): ${await res.text()}`);
  }

  const data: InquirePriceResponse = await res.json();

  if (data.rt_cd !== "0") {
    throw new Error(`시세 조회 실패: ${data.msg1}`);
  }

  const { output } = data;

  return {
    stockCode,
    currentPrice: Number(output.stck_prpr),
    change: Number(output.prdy_vrss),
    changeRate: Number(output.prdy_ctrt),
    openPrice: Number(output.stck_oprc),
    highPrice: Number(output.stck_hgpr),
    lowPrice: Number(output.stck_lwpr),
    volume: Number(output.acml_vol),
  };
}

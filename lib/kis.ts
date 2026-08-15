import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const KIS_BASE_URL =
  process.env.KIS_BASE_URL ?? "https://openapi.koreainvestment.com:9443";

const TR_ID_INQUIRE_PRICE = "FHKST01010100";
const TR_ID_INQUIRE_DAILY_CHART_PRICE = "FHKST03010100";

// 여러 서버리스 인스턴스가 공유하는 kis_tokens 테이블의 고정 행 ID.
const TOKEN_ROW_ID = "kis";
// 만료 임박 시 여유를 두고 미리 갱신한다.
const EXPIRY_BUFFER_MS = 60 * 1000;
// 동시에 여러 인스턴스가 토큰을 재발급하려다 KIS의 1분당 1회 제한에 걸렸을 때,
// 먼저 성공한 인스턴스가 DB에 쓴 토큰을 재조회하기 전에 기다리는 시간.
const RETRY_DELAY_MS = 1500;

interface TokenRow {
  access_token: string;
  expires_at: string;
}

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

function isValid(row: TokenRow | null): row is TokenRow {
  if (!row) return false;
  return new Date(row.expires_at).getTime() - EXPIRY_BUFFER_MS > Date.now();
}

async function readTokenFromDb(): Promise<TokenRow | null> {
  const { data, error } = await supabaseAdmin
    .from("kis_tokens")
    .select("access_token, expires_at")
    .eq("id", TOKEN_ROW_ID)
    .maybeSingle();

  if (error) {
    throw new Error(`토큰 조회 실패: ${error.message}`);
  }

  return data;
}

async function writeTokenToDb(token: string, expiresAt: Date): Promise<void> {
  const { error } = await supabaseAdmin.from("kis_tokens").upsert({
    id: TOKEN_ROW_ID,
    access_token: token,
    expires_at: expiresAt.toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (error) {
    throw new Error(`토큰 저장 실패: ${error.message}`);
  }
}

async function issueAccessToken(): Promise<{ token: string; expiresAt: Date }> {
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
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
  };
}

async function getAccessToken(): Promise<string> {
  const existing = await readTokenFromDb();
  if (isValid(existing)) {
    return existing.access_token;
  }

  try {
    const { token, expiresAt } = await issueAccessToken();
    await writeTokenToDb(token, expiresAt);
    return token;
  } catch (issueError) {
    // 다른 서버리스 인스턴스가 동시에 먼저 토큰을 발급했을 수 있다.
    // (KIS는 앱키당 토큰 발급을 1분당 1회로 제한하므로, 뒤늦게 시도한
    // 이 인스턴스는 여기서 거부당했을 가능성이 크다.) 잠시 기다렸다가
    // DB에 저장된 최신 토큰을 다시 확인해본다.
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    const retried = await readTokenFromDb();
    if (isValid(retried)) {
      return retried.access_token;
    }
    throw issueError;
  }
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

export type ChartPeriod = "D" | "W" | "M";

export interface DailyPrice {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface InquireDailyChartPriceResponse {
  rt_cd: string;
  msg1: string;
  output2: {
    stck_bsop_date: string;
    stck_oprc: string;
    stck_hgpr: string;
    stck_lwpr: string;
    stck_clpr: string;
    acml_vol: string;
  }[];
}

const PERIOD_LOOKBACK_YEARS: Record<ChartPeriod, number> = {
  D: 1,
  W: 3,
  M: 10,
};

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * 국내 주식 기간별(일/주/월봉) 시세를 조회한다. KIS가 응답을 최대 100건으로
 * 제한하므로 조회 시작일은 봉 종류에 따라 넉넉히 과거로 잡는다.
 */
export async function getDailyPrices(
  stockCode: string,
  period: ChartPeriod
): Promise<DailyPrice[]> {
  const { appKey, appSecret } = getCredentials();
  const accessToken = await getAccessToken();

  const today = new Date();
  const start = new Date(today);
  start.setFullYear(start.getFullYear() - PERIOD_LOOKBACK_YEARS[period]);

  const url = new URL(
    "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
    KIS_BASE_URL
  );
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", stockCode);
  url.searchParams.set("FID_INPUT_DATE_1", formatDate(start));
  url.searchParams.set("FID_INPUT_DATE_2", formatDate(today));
  url.searchParams.set("FID_PERIOD_DIV_CODE", period);
  url.searchParams.set("FID_ORG_ADJ_PRC", "0");

  const res = await fetch(url, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${accessToken}`,
      appkey: appKey,
      appsecret: appSecret,
      tr_id: TR_ID_INQUIRE_DAILY_CHART_PRICE,
      custtype: "P",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`차트 데이터 조회 실패 (${res.status}): ${await res.text()}`);
  }

  const data: InquireDailyChartPriceResponse = await res.json();

  if (data.rt_cd !== "0") {
    throw new Error(`차트 데이터 조회 실패: ${data.msg1}`);
  }

  // KIS는 최신 순으로 내려주므로 차트에 쓰기 좋게 과거→최신 순으로 뒤집는다.
  return data.output2
    .filter((row) => row.stck_bsop_date)
    .map((row) => ({
      date: `${row.stck_bsop_date.slice(0, 4)}-${row.stck_bsop_date.slice(4, 6)}-${row.stck_bsop_date.slice(6, 8)}`,
      open: Number(row.stck_oprc),
      high: Number(row.stck_hgpr),
      low: Number(row.stck_lwpr),
      close: Number(row.stck_clpr),
      volume: Number(row.acml_vol),
    }))
    .reverse();
}

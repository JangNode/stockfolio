import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const KIS_BASE_URL =
  process.env.KIS_BASE_URL ?? "https://openapi.koreainvestment.com:9443";

const TR_ID_INQUIRE_PRICE = "FHKST01010100";
const TR_ID_INQUIRE_DAILY_CHART_PRICE = "FHKST03010100";
const TR_ID_INQUIRE_TIME_CHART_PRICE = "FHKST03010200";
const TR_ID_INQUIRE_INDEX_PRICE = "FHPUP02100000";
const TR_ID_INQUIRE_OVERSEAS_INDEX = "FHKST03030100";
const TR_ID_OVERSEAS_PRICE = "HHDFS00000300";
const TR_ID_OVERSEAS_PRICE_DETAIL = "HHDFS76200200";
const TR_ID_OVERSEAS_DAILY_PRICE = "HHDFS76240000";

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

// KIS는 tr_id별이 아니라 앱키 전체를 통틀어 초당 호출 횟수를 제한한다. 그래서
// 현재가 조회, 일/주/월봉, 분봉이 동시에 호출되면 서로의 몫을 갉아먹고 EGW00201
// ("초당 거래건수를 초과하였습니다")로 거부당할 수 있다.
//
// 실전투자 계좌의 실제 한도는 앱키당 초당 20건이다(KIS 공식 문서에 정확한
// 수치가 명시돼 있진 않지만, 다수의 서드파티 구현체가 공통적으로 이 값을
// 전제로 한다). 여기서는 안전마진을 두고 초당 15건을 총 한도로 쓴다.
//
// 이 모듈은 배치(screen-all-stocks.ts)와 사람이 웹에서 쓰는 API 라우트가
// 공유한다. 배치가 15건을 다 써버리면 그 시간 동안 실제 사용자 요청이
// 밀린다. 그래서 초당 15건을 "공용 버킷" 하나와 "배치 전용 버킷"(더 낮은
// 한도) 두 개로 나눈다 — 배치 호출은 두 버킷에서 모두 토큰을 받아야 하므로
// 사실상 배치 전용 버킷 한도를 넘지 못하고, 그 차이만큼(15-12=3건/초)은
// 배치가 아무리 밀려 있어도 손댈 수 없는 사용자 전용 여유분으로 남는다.
// 대기 중인 요청이 여러 건이면 사용자 우선순위를 항상 먼저 내보낸다 — 배치가
// 계속 밀리면 이론상 사용자 요청에 밀려 오래 기다릴 수 있지만(기아 방지 로직
// 없음), 배치는 사람이 안 보는 야간/장중 자동 실행이라 이 트레이드오프를
// 받아들인다.
const KIS_TOTAL_CALLS_PER_SECOND = 15;
const KIS_BATCH_CALLS_PER_SECOND = 12;
const RATE_LIMIT_TICK_MS = 20;

const RATE_LIMIT_MSG_CODE = "EGW00201";
const RATE_LIMIT_MAX_RETRIES = 4;
// 지수 백오프: 1500ms, 3000ms, 6000ms, 12000ms. 처리량이 커진 만큼(기존 초당
// 0.9건 → 15건) 순간적으로 한도를 넘겨 EGW00201을 받을 가능성도 커지므로,
// 재시도할수록 더 크게 물러난다.
const RATE_LIMIT_BACKOFF_MS = 1500;

/** 초당 N개로 리필되는 토큰버킷. 시작 시 가득 찬 상태라 콜드 스타트 시 최대
 * capacity개까지는 즉시 나간다(표준적인 토큰버킷 동작). */
class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private tokens: number;
  private lastRefill: number;

  constructor(ratePerSecond: number) {
    this.capacity = ratePerSecond;
    this.refillPerMs = ratePerSecond / 1000;
    this.tokens = ratePerSecond;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    if (elapsedMs <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedMs * this.refillPerMs);
    this.lastRefill = now;
  }

  /** 토큰이 있는지 확인만 하고 소비하지 않는다. take()와 짝을 지어 쓴다 —
   * 두 버킷 모두에서 토큰이 있는지 먼저 확인한 뒤에만 둘 다 소비해야
   * (배치 호출처럼) 한쪽만 소비하고 실패하는 상황을 피할 수 있다. */
  hasToken(): boolean {
    this.refill();
    return this.tokens >= 1;
  }

  take(): void {
    this.tokens -= 1;
  }
}

type KisCallPriority = "user" | "batch";

const sharedBucket = new TokenBucket(KIS_TOTAL_CALLS_PER_SECOND);
const batchBucket = new TokenBucket(KIS_BATCH_CALLS_PER_SECOND);

interface Waiter {
  resolve: () => void;
}

const userWaiters: Waiter[] = [];
const batchWaiters: Waiter[] = [];
let drainTimer: ReturnType<typeof setInterval> | null = null;

/** 대기 중인 요청 중 지금 당장 내보낼 수 있는 만큼 내보낸다. 사용자 요청을
 * 항상 먼저 검사하므로, 공용 버킷에 토큰이 있으면 배치보다 먼저 가져간다. */
function dispatchWaiters(): void {
  for (;;) {
    if (userWaiters.length > 0 && sharedBucket.hasToken()) {
      sharedBucket.take();
      userWaiters.shift()!.resolve();
      continue;
    }
    if (batchWaiters.length > 0 && sharedBucket.hasToken() && batchBucket.hasToken()) {
      sharedBucket.take();
      batchBucket.take();
      batchWaiters.shift()!.resolve();
      continue;
    }
    return;
  }
}

function ensureDraining(): void {
  if (drainTimer) return;
  drainTimer = setInterval(() => {
    dispatchWaiters();
    if (userWaiters.length === 0 && batchWaiters.length === 0) {
      clearInterval(drainTimer!);
      drainTimer = null;
    }
  }, RATE_LIMIT_TICK_MS);
}

/** 우선순위 큐에 줄을 서고 토큰을 받을 차례가 되면 resolve된다. */
function acquireSlot(priority: KisCallPriority): Promise<void> {
  return new Promise((resolve) => {
    (priority === "user" ? userWaiters : batchWaiters).push({ resolve });
    dispatchWaiters();
    if (userWaiters.length > 0 || batchWaiters.length > 0) {
      ensureDraining();
    }
  });
}

const kisCallStats = { total: 0, retried: 0 };

/** 이번 프로세스에서 이 모듈을 거쳐 나간 KIS 호출 통계(총 시도 횟수, 그중
 * EGW00201로 재시도한 횟수). 배치/검증 스크립트의 로그 출력용. */
export function getKisCallStats(): { total: number; retried: number } {
  return { ...kisCallStats };
}

interface KisResponse {
  rt_cd: string;
  msg1: string;
  msg_cd?: string;
  [key: string]: unknown;
}

/**
 * 이 모듈의 모든 KIS 데이터 API 호출이 거치는 공통 통로. 우선순위 큐에서 토큰을
 * 받아야 실제 호출이 나가고, 초당 호출 제한(EGW00201)에 걸리면 지수 백오프 후
 * 자동으로 재시도한다. priority가 "batch"면 배치 전용 버킷의 한도도 같이 적용된다.
 */
async function kisFetch(
  url: URL,
  trId: string,
  accessToken: string,
  appKey: string,
  appSecret: string,
  priority: KisCallPriority = "user"
): Promise<KisResponse> {
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    await acquireSlot(priority);
    kisCallStats.total++;

    const res = await fetch(url, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${accessToken}`,
        appkey: appKey,
        appsecret: appSecret,
        tr_id: trId,
        custtype: "P",
      },
      cache: "no-store",
    });

    const bodyText = await res.text();
    let body: KisResponse | null = null;
    try {
      body = JSON.parse(bodyText);
    } catch {
      // KIS가 JSON이 아닌 응답(예: 게이트웨이 오류 페이지)을 준 경우도 있다.
    }

    if (body?.msg_cd === RATE_LIMIT_MSG_CODE && attempt < RATE_LIMIT_MAX_RETRIES) {
      kisCallStats.retried++;
      await new Promise((resolve) =>
        setTimeout(resolve, RATE_LIMIT_BACKOFF_MS * 2 ** attempt)
      );
      continue;
    }

    if (!res.ok) {
      throw new Error(`KIS 요청 실패 (${res.status}): ${bodyText}`);
    }
    if (!body || body.rt_cd !== "0") {
      throw new Error(`KIS 요청 실패: ${body?.msg1 ?? bodyText}`);
    }

    return body;
  }

  throw new Error(
    "KIS 초당 호출 제한(EGW00201)에 반복해서 걸렸습니다. 잠시 후 다시 시도해주세요."
  );
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
  // 시가총액(억원). 스크리닝 배치의 잡주 필터링(저시가총액 제외)에 쓴다.
  marketCapEok: number;
}

interface InquirePriceResponse extends KisResponse {
  output: {
    stck_prpr: string;
    prdy_vrss: string;
    prdy_ctrt: string;
    stck_oprc: string;
    stck_hgpr: string;
    stck_lwpr: string;
    acml_vol: string;
    hts_avls: string;
  };
}

/**
 * 국내 주식 현재가 시세를 조회한다. stockCode는 6자리 종목코드 (예: "005930").
 * priority는 웹에서 사람이 기다리는 요청이면 "user"(기본값), 배치처럼 사람이
 * 안 보는 자동 실행이면 "batch"로 넘긴다 — 배치는 더 낮은 초당 한도로 묶여
 * 사용자 요청을 밀어내지 않는다.
 */
export async function getStockPrice(
  stockCode: string,
  priority: "user" | "batch" = "user"
): Promise<StockPrice> {
  const { appKey, appSecret } = getCredentials();
  const accessToken = await getAccessToken();

  const url = new URL(
    "/uapi/domestic-stock/v1/quotations/inquire-price",
    KIS_BASE_URL
  );
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", stockCode);

  const data = (await kisFetch(
    url,
    TR_ID_INQUIRE_PRICE,
    accessToken,
    appKey,
    appSecret,
    priority
  )) as InquirePriceResponse;

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
    marketCapEok: Number(output.hts_avls),
  };
}

export type ChartPeriod = "D" | "W" | "M" | "Y";

export interface DailyPrice {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface InquireDailyChartPriceResponse extends KisResponse {
  output2: {
    stck_bsop_date: string;
    stck_oprc: string;
    stck_hgpr: string;
    stck_lwpr: string;
    stck_clpr: string;
    acml_vol: string;
  }[];
}

// FID_INPUT_DATE_1(조회 시작일) 경계. 페이지네이션이 실제로 멈추는 지점은
// TARGET_CHART_ROWS/MAX_CHART_PAGES이므로, 이 값은 그보다 훨씬 과거로 넉넉히 잡아둔다.
const CHART_START_DATE = "19900101";
// MA448까지 계산할 수 있도록 충분한 개수를 목표로 페이지네이션한다.
const TARGET_CHART_ROWS = 500;
const MAX_CHART_PAGES = 8;
const CHART_CACHE_TTL_MS = 5 * 60 * 1000;

const chartCache = new Map<string, { prices: DailyPrice[]; fetchedAt: number }>();

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function addDaysToYyyymmdd(yyyymmdd: string, days: number): string {
  const d = new Date(
    Number(yyyymmdd.slice(0, 4)),
    Number(yyyymmdd.slice(4, 6)) - 1,
    Number(yyyymmdd.slice(6, 8))
  );
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

/**
 * 국내 주식 기간별(일/주/월/년봉) 시세를 조회한다. KIS는 호출 한 번에 최대
 * 100건만 주므로, 이전 배치의 가장 오래된 날짜 바로 전날을 다음 조회 종료일로
 * 삼아 여러 번 호출해 targetRows만큼(기본값은 MA448까지 계산 가능한 최대 500건) 모은다.
 * 스크리닝처럼 조건 판정만 필요할 땐 targetRows를 100 정도로 낮춰 호출 1회로 끝낼 수 있다.
 * priority는 getStockPrice와 같은 의미다(기본값 "user").
 */
export async function getDailyPrices(
  stockCode: string,
  period: ChartPeriod,
  targetRows: number = TARGET_CHART_ROWS,
  priority: "user" | "batch" = "user"
): Promise<DailyPrice[]> {
  const cacheKey = `${stockCode}:${period}:${targetRows}`;
  const cached = chartCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CHART_CACHE_TTL_MS) {
    return cached.prices;
  }

  const { appKey, appSecret } = getCredentials();
  const accessToken = await getAccessToken();

  // output2는 매 페이지마다 최신→과거 순이며, 페이지를 뒤로 갈수록 더 과거
  // 구간이므로 이어붙인 전체 배열도 여전히 최신→과거 순서를 유지한다.
  const collected: InquireDailyChartPriceResponse["output2"] = [];
  let endDate = formatDate(new Date());

  for (let page = 0; page < MAX_CHART_PAGES; page++) {
    const url = new URL(
      "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
      KIS_BASE_URL
    );
    url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
    url.searchParams.set("FID_INPUT_ISCD", stockCode);
    url.searchParams.set("FID_INPUT_DATE_1", CHART_START_DATE);
    url.searchParams.set("FID_INPUT_DATE_2", endDate);
    url.searchParams.set("FID_PERIOD_DIV_CODE", period);
    url.searchParams.set("FID_ORG_ADJ_PRC", "0");

    const data = (await kisFetch(
      url,
      TR_ID_INQUIRE_DAILY_CHART_PRICE,
      accessToken,
      appKey,
      appSecret,
      priority
    )) as InquireDailyChartPriceResponse;

    const rows = data.output2.filter((row) => row.stck_bsop_date);
    if (rows.length === 0) break;

    collected.push(...rows);

    if (rows.length < 100) break; // 100건 미만이면 그보다 과거 데이터가 없는 것
    if (collected.length >= targetRows) break;

    endDate = addDaysToYyyymmdd(rows[rows.length - 1].stck_bsop_date, -1);
  }

  // KIS는 최신 순으로 내려주므로 차트에 쓰기 좋게 과거→최신 순으로 뒤집는다.
  const prices = collected
    .map((row) => ({
      date: `${row.stck_bsop_date.slice(0, 4)}-${row.stck_bsop_date.slice(4, 6)}-${row.stck_bsop_date.slice(6, 8)}`,
      open: Number(row.stck_oprc),
      high: Number(row.stck_hgpr),
      low: Number(row.stck_lwpr),
      close: Number(row.stck_clpr),
      volume: Number(row.acml_vol),
    }))
    .reverse();

  chartCache.set(cacheKey, { prices, fetchedAt: Date.now() });

  return prices;
}

export interface IntradayBar {
  time: number; // unix seconds. 한국 벽시계 시각을 그대로 UTC 초로 표현한다.
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface InquireTimeChartPriceResponse extends KisResponse {
  output2: {
    stck_bsop_date: string;
    stck_cntg_hour: string;
    stck_oprc: string;
    stck_hgpr: string;
    stck_lwpr: string;
    stck_prpr: string;
    cntg_vol: string;
  }[];
}

const MARKET_OPEN_HHMMSS = "090000";
// 페이지당 30분씩, 장 시작(09:00)부터 시간외 단일가(~18:00)까지 총 9시간을
// 전부 모으려면 최소 18페이지가 필요하다. 여유를 두고 20으로 잡는다 — 그보다
// 일찍 끝나는 건 문제없다(장 시작이나 그날의 첫 데이터에서 자연히 멈춘다).
const MAX_MINUTE_PAGES = 20;

function getCurrentKstHHMMSS(): string {
  const kstParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const get = (type: string) =>
    kstParts.find((p) => p.type === type)?.value ?? "00";

  return `${get("hour")}${get("minute")}${get("second")}`;
}

async function fetchMinuteBarPage(
  stockCode: string,
  hour1: string,
  accessToken: string,
  appKey: string,
  appSecret: string
): Promise<InquireTimeChartPriceResponse["output2"]> {
  const url = new URL(
    "/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice",
    KIS_BASE_URL
  );
  url.searchParams.set("FID_ETC_CLS_CODE", "");
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", stockCode);
  url.searchParams.set("FID_INPUT_HOUR_1", hour1);
  url.searchParams.set("FID_PW_DATA_INCU_YN", "Y");
  url.searchParams.set("FID_FAKE_TICK_INCU_YN", "");

  const data = (await kisFetch(
    url,
    TR_ID_INQUIRE_TIME_CHART_PRICE,
    accessToken,
    appKey,
    appSecret
  )) as InquireTimeChartPriceResponse;

  return data.output2;
}

function kstToUtcSeconds(dateStr: string, hhmmss: string): number {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(4, 6)) - 1;
  const day = Number(dateStr.slice(6, 8));
  const hour = Number(hhmmss.slice(0, 2));
  const minute = Number(hhmmss.slice(2, 4));
  const second = Number(hhmmss.slice(4, 6));

  // 한국 시장은 KST 벽시계 기준으로 움직인다. 뷰어의 브라우저 타임존과 무관하게
  // 차트 축에 그 벽시계 시각이 그대로 보이도록, KST 숫자를 UTC인 것처럼 다룬다.
  return Math.floor(Date.UTC(year, month, day, hour, minute, second) / 1000);
}

// 페이지당 최대 30분(30건)만 내려주는 KIS 분봉 API를 최대 15번 호출해 장중
// 데이터를 모아야 하므로 호출 수가 많다. 같은 종목을 짧은 시간 안에 반복
// 요청하는 것을 막기 위해 결과를 몇 분간 캐시해 전체 호출 횟수를 줄인다.
const intradayCache = new Map<
  string,
  { bars: IntradayBar[]; fetchedAt: number }
>();
const INTRADAY_CACHE_TTL_MS = 3 * 60 * 1000;

/** 당일 1분봉을 모아 intervalMinutes 단위로 집계한다 (예: 10분봉). */
export async function getIntradayBars(
  stockCode: string,
  intervalMinutes: number
): Promise<IntradayBar[]> {
  const cached = intradayCache.get(stockCode);
  if (cached && Date.now() - cached.fetchedAt < INTRADAY_CACHE_TTL_MS) {
    return aggregateMinuteBars(cached.bars, intervalMinutes);
  }

  const { appKey, appSecret } = getCredentials();
  const accessToken = await getAccessToken();

  const rows = new Map<string, InquireTimeChartPriceResponse["output2"][number]>();
  let cursor = getCurrentKstHHMMSS();

  for (let page = 0; page < MAX_MINUTE_PAGES; page++) {
    const batch = await fetchMinuteBarPage(
      stockCode,
      cursor,
      accessToken,
      appKey,
      appSecret
    );
    if (batch.length === 0) break;

    for (const row of batch) {
      rows.set(`${row.stck_bsop_date}${row.stck_cntg_hour}`, row);
    }

    const earliest = batch[batch.length - 1];
    if (earliest.stck_cntg_hour <= MARKET_OPEN_HHMMSS) break;
    if (batch.length < 30) break; // 30건 미만이면 그날의 첫 데이터까지 다 받은 것

    cursor = earliest.stck_cntg_hour;
  }

  // 장 시작 근처의 마지막 페이지는 그날 데이터가 30건이 안 될 때 KIS가 전날
  // 데이터로 채워 넣는 경우가 있다. 가장 최근(=최대) 영업일 데이터만 남긴다.
  const allRows = Array.from(rows.values());
  const latestTradingDate = allRows.reduce(
    (max, row) => (row.stck_bsop_date > max ? row.stck_bsop_date : max),
    ""
  );

  const oneMinBars: IntradayBar[] = allRows
    .filter((row) => row.stck_bsop_date === latestTradingDate)
    .map((row) => ({
      time: kstToUtcSeconds(row.stck_bsop_date, row.stck_cntg_hour),
      open: Number(row.stck_oprc),
      high: Number(row.stck_hgpr),
      low: Number(row.stck_lwpr),
      close: Number(row.stck_prpr),
      volume: Number(row.cntg_vol),
    }))
    .sort((a, b) => a.time - b.time);

  intradayCache.set(stockCode, { bars: oneMinBars, fetchedAt: Date.now() });

  return aggregateMinuteBars(oneMinBars, intervalMinutes);
}

function aggregateMinuteBars(
  oneMinBars: IntradayBar[],
  intervalMinutes: number
): IntradayBar[] {
  const buckets = new Map<number, IntradayBar>();
  const intervalSeconds = intervalMinutes * 60;

  for (const bar of oneMinBars) {
    const bucketTime = Math.floor(bar.time / intervalSeconds) * intervalSeconds;
    const existing = buckets.get(bucketTime);

    if (!existing) {
      buckets.set(bucketTime, { ...bar, time: bucketTime });
    } else {
      existing.high = Math.max(existing.high, bar.high);
      existing.low = Math.min(existing.low, bar.low);
      existing.close = bar.close; // oneMinBars는 시간 오름차순이므로 마지막 값이 종가
      existing.volume += bar.volume;
    }
  }

  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

export interface IndexQuote {
  category: "국내" | "해외";
  name: string;
  price: number;
  change: number;
  changeRate: number;
}

interface InquireIndexPriceResponse extends KisResponse {
  output: {
    bstp_nmix_prpr: string;
    bstp_nmix_prdy_vrss: string;
    bstp_nmix_prdy_ctrt: string;
  };
}

/** 코스피(0001)/코스닥(1001) 등 국내 업종지수 현재가를 조회한다. */
async function getDomesticIndex(code: string, name: string): Promise<IndexQuote> {
  const { appKey, appSecret } = getCredentials();
  const accessToken = await getAccessToken();

  const url = new URL(
    "/uapi/domestic-stock/v1/quotations/inquire-index-price",
    KIS_BASE_URL
  );
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "U");
  url.searchParams.set("FID_INPUT_ISCD", code);

  const data = (await kisFetch(
    url,
    TR_ID_INQUIRE_INDEX_PRICE,
    accessToken,
    appKey,
    appSecret
  )) as InquireIndexPriceResponse;
  const { output } = data;

  return {
    category: "국내",
    name,
    price: Number(output.bstp_nmix_prpr),
    change: Number(output.bstp_nmix_prdy_vrss),
    changeRate: Number(output.bstp_nmix_prdy_ctrt),
  };
}

interface InquireOverseasIndexResponse extends KisResponse {
  output1: {
    ovrs_nmix_prpr: string;
    ovrs_nmix_prdy_vrss: string;
    prdy_ctrt: string;
  };
}

/**
 * 해외지수(나스닥 종합 "COMP", S&P500 "SPX" 등, market="N") 또는 환율
 * (원/달러 "FX@KRW", market="X") 현재가를 조회한다. 전용 "현재가" 엔드포인트가
 * 따로 없어 일별 차트 조회의 output1(요약)을 사용한다.
 */
async function getOverseasIndex(
  marketDiv: "N" | "X",
  code: string,
  name: string
): Promise<IndexQuote> {
  const { appKey, appSecret } = getCredentials();
  const accessToken = await getAccessToken();

  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 7);

  const url = new URL(
    "/uapi/overseas-price/v1/quotations/inquire-daily-chartprice",
    KIS_BASE_URL
  );
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", marketDiv);
  url.searchParams.set("FID_INPUT_ISCD", code);
  url.searchParams.set("FID_INPUT_DATE_1", formatDate(start));
  url.searchParams.set("FID_INPUT_DATE_2", formatDate(today));
  url.searchParams.set("FID_PERIOD_DIV_CODE", "D");

  const data = (await kisFetch(
    url,
    TR_ID_INQUIRE_OVERSEAS_INDEX,
    accessToken,
    appKey,
    appSecret
  )) as InquireOverseasIndexResponse;
  const { output1 } = data;

  return {
    category: "해외",
    name,
    price: Number(output1.ovrs_nmix_prpr),
    change: Number(output1.ovrs_nmix_prdy_vrss),
    changeRate: Number(output1.prdy_ctrt),
  };
}

export interface MarketSummary {
  domestic: IndexQuote[];
  overseas: IndexQuote[];
}

const MARKET_SUMMARY_CACHE_TTL_MS = 60 * 1000;
let marketSummaryCache: { data: MarketSummary; fetchedAt: number } | null = null;

/** 국내(코스피/코스닥) + 해외(나스닥/S&P500/다우존스 등) 주요 지수를 모아 조회한다 (60초 캐시). */
export async function getMarketSummary(): Promise<MarketSummary> {
  if (
    marketSummaryCache &&
    Date.now() - marketSummaryCache.fetchedAt < MARKET_SUMMARY_CACHE_TTL_MS
  ) {
    return marketSummaryCache.data;
  }

  const [kospi, kosdaq, usdKrw, nasdaqComposite, nasdaq100, sp500, dowJones, philSemi, vix] =
    await Promise.all([
      getDomesticIndex("0001", "코스피"),
      getDomesticIndex("1001", "코스닥"),
      getOverseasIndex("X", "FX@KRW", "원/달러 환율"),
      getOverseasIndex("N", "COMP", "나스닥 종합"),
      getOverseasIndex("N", "NDX", "나스닥 100"),
      getOverseasIndex("N", "SPX", "S&P500"),
      getOverseasIndex("N", ".DJI", "다우존스"),
      getOverseasIndex("N", "SOX", "필라델피아 반도체"),
      getOverseasIndex("N", "VIX", "VIX"),
    ]);

  const data: MarketSummary = {
    domestic: [kospi, kosdaq],
    overseas: [usdKrw, nasdaqComposite, nasdaq100, sp500, dowJones, philSemi, vix],
  };
  marketSummaryCache = { data, fetchedAt: Date.now() };

  return data;
}

// ===== 미국주식(나스닥/뉴욕/아멕스) 스크리닝용 =====
// KIS 해외주식 소매 거래는 나스닥/뉴욕/아멕스 3개 거래소만 지원한다(장외/핑크시트 종목은
// 대상이 아니다). 필드명은 KIS 공식 예제(github.com/koreainvestment/open-trading-api의
// examples_llm/overseas_stock/{price,price_detail,dailyprice}/chk_*.py에 있는
// COLUMN_MAPPING)를 기준으로 했다 — 이 저장소에는 실제 KIS 계정으로 라이브 호출해 응답을
// 검증할 방법이 없었으므로, 운영 투입 전 실제 종목 1~2개로 스팟체크가 필요하다.
export type OverseasExchangeCode = "NAS" | "NYS" | "AMS";

export interface OverseasStockPrice {
  currentPrice: number;
  prevClose: number;
  change: number;
  changeRate: number;
  volume: number;
}

interface OverseasPriceResponse extends KisResponse {
  output: {
    last: string;
    base: string;
    diff: string;
    rate: string;
    tvol: string;
  };
}

/**
 * 해외주식 현재체결가를 조회한다(시가총액 등 기업개요는 없음 — 그건
 * getOverseasPriceDetail 몫). 이미 추적 중인 종목의 현재가 갱신처럼 가벼운 호출에 쓴다.
 */
export async function getOverseasStockPrice(
  excd: OverseasExchangeCode,
  symb: string,
  priority: "user" | "batch" = "user"
): Promise<OverseasStockPrice> {
  const { appKey, appSecret } = getCredentials();
  const accessToken = await getAccessToken();

  const url = new URL("/uapi/overseas-price/v1/quotations/price", KIS_BASE_URL);
  url.searchParams.set("AUTH", "");
  url.searchParams.set("EXCD", excd);
  url.searchParams.set("SYMB", symb);

  const data = (await kisFetch(
    url,
    TR_ID_OVERSEAS_PRICE,
    accessToken,
    appKey,
    appSecret,
    priority
  )) as OverseasPriceResponse;
  const { output } = data;

  return {
    currentPrice: Number(output.last),
    prevClose: Number(output.base),
    change: Number(output.diff),
    changeRate: Number(output.rate),
    volume: Number(output.tvol),
  };
}

export interface OverseasPriceDetail {
  currentPrice: number;
  // 시가총액. 통화(currency)는 원화가 아니라 종목이 거래되는 시장의 통화(미국은 USD) 그대로다.
  marketCap: number;
  currency: string;
  high52w: number;
  low52w: number;
}

interface OverseasPriceDetailResponse extends KisResponse {
  output: {
    last: string;
    tomv: string;
    curr: string;
    h52p: string;
    l52p: string;
  };
}

/**
 * 해외주식 현재가상세를 조회한다. 시가총액(tomv)이 이 엔드포인트에만 있어, 잡주
 * 필터링(시가총액 하한) 단계에서만 쓴다 — 추적 갱신처럼 자주 도는 곳엔 더 가벼운
 * getOverseasStockPrice를 쓴다.
 */
export async function getOverseasPriceDetail(
  excd: OverseasExchangeCode,
  symb: string,
  priority: "user" | "batch" = "user"
): Promise<OverseasPriceDetail> {
  const { appKey, appSecret } = getCredentials();
  const accessToken = await getAccessToken();

  const url = new URL("/uapi/overseas-price/v1/quotations/price-detail", KIS_BASE_URL);
  url.searchParams.set("AUTH", "");
  url.searchParams.set("EXCD", excd);
  url.searchParams.set("SYMB", symb);

  const data = (await kisFetch(
    url,
    TR_ID_OVERSEAS_PRICE_DETAIL,
    accessToken,
    appKey,
    appSecret,
    priority
  )) as OverseasPriceDetailResponse;
  const { output } = data;

  return {
    currentPrice: Number(output.last),
    marketCap: Number(output.tomv),
    currency: output.curr,
    high52w: Number(output.h52p),
    low52w: Number(output.l52p),
  };
}

interface OverseasDailyPriceResponse extends KisResponse {
  output2: {
    xymd: string;
    clos: string;
    open: string;
    high: string;
    low: string;
    tvol: string;
  }[];
}

const OVERSEAS_CHART_TARGET_ROWS_DEFAULT = 300;
const OVERSEAS_MAX_CHART_PAGES = 8;
const OVERSEAS_CHART_CACHE_TTL_MS = 5 * 60 * 1000;

// 해외 기간별시세는 GUBN(0:일 1:주 2:월)으로 봉 종류를 고른다. KIS 문서상 "년봉"에
// 대응하는 GUBN 값이 없어(국내 FID_PERIOD_DIV_CODE="Y"의 해외 대응이 없음), 지원 범위를
// 일/주/월로만 한정한다 — 화면(예: StockChart)에서도 미국 종목엔 년봉/분봉 옵션을 감춘다.
export type OverseasChartPeriod = "D" | "W" | "M";
const OVERSEAS_GUBN: Record<OverseasChartPeriod, string> = { D: "0", W: "1", M: "2" };

const overseasChartCache = new Map<string, { prices: DailyPrice[]; fetchedAt: number }>();

/**
 * 해외주식 기간별(일/주/월봉) 시세를 조회한다. 응답 형태(DailyPrice)는 국내 getDailyPrices와
 * 동일해서 lib/backtest.ts의 전략 판정·lib/screeningScore.ts의 점수 계산을 시장 구분
 * 없이 그대로 재사용할 수 있다. 페이지당 실제로 몇 건을 주는지 문서로 확인하지 못해,
 * 국내처럼 "100건 미만이면 마지막 페이지"로 가정하지 않고 응답이 완전히 비었을 때만
 * 멈춘다(더 안전한 쪽으로) — 대신 MAX_CHART_PAGES로 상한을 둔다. 국내와 동일하게 5분
 * 캐시를 둔다(스크리닝 배치처럼 실시간성이 필요 없는 호출도 있고, 이 함수엔 원래
 * 캐시가 없어서 워치리스트/차트처럼 사람이 자주 호출하는 경로에 그대로 쓰면 호출량이
 * 불필요하게 늘어난다).
 */
export async function getOverseasDailyPrices(
  excd: OverseasExchangeCode,
  symb: string,
  period: OverseasChartPeriod = "D",
  targetRows: number = OVERSEAS_CHART_TARGET_ROWS_DEFAULT,
  priority: "user" | "batch" = "user"
): Promise<DailyPrice[]> {
  const cacheKey = `${excd}:${symb}:${period}:${targetRows}`;
  const cached = overseasChartCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < OVERSEAS_CHART_CACHE_TTL_MS) {
    return cached.prices;
  }

  const { appKey, appSecret } = getCredentials();
  const accessToken = await getAccessToken();

  const collected: OverseasDailyPriceResponse["output2"] = [];
  let bymd = ""; // 공란 = 오늘 날짜 기준

  for (let page = 0; page < OVERSEAS_MAX_CHART_PAGES; page++) {
    const url = new URL("/uapi/overseas-price/v1/quotations/dailyprice", KIS_BASE_URL);
    url.searchParams.set("AUTH", "");
    url.searchParams.set("EXCD", excd);
    url.searchParams.set("SYMB", symb);
    url.searchParams.set("GUBN", OVERSEAS_GUBN[period]);
    url.searchParams.set("BYMD", bymd);
    url.searchParams.set("MODP", "0"); // 0: 수정주가 미반영(국내 getDailyPrices와 동일 정책)

    const data = (await kisFetch(
      url,
      TR_ID_OVERSEAS_DAILY_PRICE,
      accessToken,
      appKey,
      appSecret,
      priority
    )) as OverseasDailyPriceResponse;

    const rows = (data.output2 ?? []).filter((row) => row.xymd);
    if (rows.length === 0) break;

    collected.push(...rows);
    if (collected.length >= targetRows) break;

    bymd = addDaysToYyyymmdd(rows[rows.length - 1].xymd, -1);
  }

  // KIS는 최신 순으로 내려주므로 과거→최신 순으로 뒤집는다(국내 getDailyPrices와 동일 규약).
  const prices = collected
    .map((row) => ({
      date: `${row.xymd.slice(0, 4)}-${row.xymd.slice(4, 6)}-${row.xymd.slice(6, 8)}`,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.clos),
      volume: Number(row.tvol),
    }))
    .reverse();

  overseasChartCache.set(cacheKey, { prices, fetchedAt: Date.now() });

  return prices;
}

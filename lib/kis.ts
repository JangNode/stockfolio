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
const TR_ID_FINANCE_INCOME_STATEMENT = "FHKST66430200";
const TR_ID_FINANCE_BALANCE_SHEET = "FHKST66430100";
const TR_ID_FINANCE_PROFIT_RATIO = "FHKST66430400";
const TR_ID_FINANCE_GROWTH_RATIO = "FHKST66430800";
const TR_ID_KSDINFO_DIVIDEND = "HHKDB669102C0";
const TR_ID_INQUIRE_INVESTOR = "FHKST01010900";

// 여러 서버리스 인스턴스가 공유하는 kis_tokens 테이블의 고정 행 ID.
const TOKEN_ROW_ID = "kis";
// 만료 임박 시 여유를 두고 미리 갱신한다.
const EXPIRY_BUFFER_MS = 60 * 1000;
// 동시에 여러 인스턴스가 토큰을 재발급하려다 KIS의 1분당 1회 제한에 걸렸을 때,
// 먼저 성공한 인스턴스가 DB에 쓴 토큰을 재조회하기 전에 기다리는 시간.
const RETRY_DELAY_MS = 1500;

// 발급 잠금(issuing_until)의 최대 유지 시간 — 실제 발급 API는 보통 1초 안에
// 끝나지만, 잠금을 쥔 인스턴스가 응답 전에 죽는 등의 사고로 영영 안 풀리는 걸
// 막기 위한 상한이다(이 시간이 지나면 다음 시도가 잠금을 다시 선점할 수 있다).
const TOKEN_ISSUE_LOCK_TTL_MS = 15 * 1000;
// 잠금을 못 얻은 인스턴스가 발급이 끝나길 기다리며 DB를 다시 확인하는 간격/횟수.
const TOKEN_LOCK_POLL_DELAY_MS = 1000;
const TOKEN_LOCK_POLL_MAX_RETRIES = 8;

interface TokenRow {
  access_token: string;
  expires_at: string;
  issuing_until: string | null;
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

/** (임시 진단용) 국내 지수(코스피 0001/코스닥 1001 등) 일별시세 원시 응답을 그대로
 * 반환한다. 개별종목 일봉 조회(inquire-daily-itemchartprice)와 같은 엔드포인트를
 * FID_COND_MRKT_DIV_CODE="U"(getDomesticIndex의 현재가 조회와 동일한 관례)로
 * 호출했을 때 실제로 과거 시계열을 주는지, 필드명이 무엇인지 확인되지 않아
 * 타입을 만들지 않고 raw로 반환한다 — scripts/diagnose-index-daily-prices.ts 전용.
 * 필드 매핑이 확인되면 이 함수는 지우고 getDailyPrices에 marketDiv 옵션을 추가하는
 * 정식 구현으로 교체한다(SKILLS.md 외부 연동 원칙 — 추측으로 먼저 구현하지 않음). */
export async function diagnoseDomesticIndexDailyPricesRaw(
  indexCode: string,
  endDateYyyymmdd: string
): Promise<unknown> {
  const { appKey, appSecret } = getCredentials();
  const accessToken = await getAccessToken();

  const url = new URL(
    "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
    KIS_BASE_URL
  );
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "U");
  url.searchParams.set("FID_INPUT_ISCD", indexCode);
  url.searchParams.set("FID_INPUT_DATE_1", CHART_START_DATE);
  url.searchParams.set("FID_INPUT_DATE_2", endDateYyyymmdd);
  url.searchParams.set("FID_PERIOD_DIV_CODE", "D");
  url.searchParams.set("FID_ORG_ADJ_PRC", "0");

  return kisFetch(url, TR_ID_INQUIRE_DAILY_CHART_PRICE, accessToken, appKey, appSecret, "user");
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
    .select("access_token, expires_at, issuing_until")
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
    issuing_until: null, // 발급이 끝났으니 잠금도 같이 해제한다.
  });

  if (error) {
    throw new Error(`토큰 저장 실패: ${error.message}`);
  }
}

/**
 * 토큰 재발급 권한을 원자적으로 선점한다. KIS는 앱키당 유효 토큰이 하나뿐이라,
 * 서로 다른 인스턴스가 동시에 재발급하면 나중에 발급된 토큰이 먼저 발급된
 * (그리고 이미 어떤 요청이 손에 쥔) 토큰을 즉시 무효화한다 — 이게 우리
 * expires_at 상으로는 아직 안 지났는데 KIS가 "기간이 만료된 token입니다"
 * (EGW00123)로 거부하는 원인이다. issuing_until을 조건부 UPDATE(RETURNING)로
 * 원자적으로 세팅해, 그 순간 딱 한 인스턴스만 실제 발급을 하게 만든다.
 */
async function tryClaimIssueLock(): Promise<boolean> {
  // 행이 아직 없으면(최초 실행) 먼저 만료된 더미 행을 만들어둔다 — 이미 있으면
  // ignoreDuplicates로 아무 것도 건드리지 않는다(진짜 토큰을 덮어쓰면 안 됨).
  await supabaseAdmin
    .from("kis_tokens")
    .upsert(
      { id: TOKEN_ROW_ID, access_token: "", expires_at: new Date(0).toISOString() },
      { onConflict: "id", ignoreDuplicates: true }
    );

  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("kis_tokens")
    .update({ issuing_until: new Date(Date.now() + TOKEN_ISSUE_LOCK_TTL_MS).toISOString() })
    .eq("id", TOKEN_ROW_ID)
    .or(`issuing_until.is.null,issuing_until.lt.${now}`)
    .select("id")
    .maybeSingle();

  if (error) {
    throw new Error(`토큰 발급 잠금 획득 실패: ${error.message}`);
  }

  return data !== null;
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

  const claimed = await tryClaimIssueLock();
  if (!claimed) {
    // 다른 인스턴스가 지금 막 재발급 중이다 — 내가 같이 발급하면 방금 그
    // 인스턴스가 받은 토큰을 무효화시켜버리므로(위 tryClaimIssueLock 코멘트
    // 참고), 직접 발급하지 않고 끝나길 기다렸다가 DB에서 결과만 가져온다.
    for (let attempt = 0; attempt < TOKEN_LOCK_POLL_MAX_RETRIES; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, TOKEN_LOCK_POLL_DELAY_MS));
      const retried = await readTokenFromDb();
      if (isValid(retried)) {
        return retried.access_token;
      }
    }
    throw new Error("KIS 토큰 발급을 기다리는 동안 시간이 초과됐습니다.");
  }

  try {
    const { token, expiresAt } = await issueAccessToken();
    await writeTokenToDb(token, expiresAt);
    return token;
  } catch (issueError) {
    // 잠금은 획득했지만 발급 자체가 실패한 경우(KIS의 1분당 1회 제한 등).
    // 잠시 기다렸다가 혹시 그 사이 다른 경로로 갱신된 토큰이 있는지 다시 확인한다.
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    const retried = await readTokenFromDb();
    if (isValid(retried)) {
      return retried.access_token;
    }
    throw issueError;
  } finally {
    // 발급 성공 시엔 writeTokenToDb가 이미 잠금을 풀지만, 실패 경로에서도
    // TTL(TOKEN_ISSUE_LOCK_TTL_MS)까지 기다리지 않고 바로 다음 시도가 잠금을
    // 다시 선점할 수 있도록 명시적으로 풀어준다.
    await supabaseAdmin.from("kis_tokens").update({ issuing_until: null }).eq("id", TOKEN_ROW_ID);
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
  // PER/PBR/EPS/BPS는 KIS가 이 API에서 이미 계산해 내려주는 값이다. 한국투자증권 앱이
  // 실제로 표시하는 값과 실측 비교해(005930 기준) EPS/PER/PBR/BPS 전부 거의 정확히
  // 일치함을 확인했다 — DART 재무제표를 재조합해 직접 계산하는 대신 이 값을 그대로
  // 쓴다(가치평가지표 섹션, app/api/stock/[code]/valuation). 필드가 비어있거나
  // 파싱 안 되면 null.
  per: number | null;
  pbr: number | null;
  eps: number | null;
  bps: number | null;
  // 상장주식수/52주(최근 1년) 최고가·최저가 — 가치평가지표 카드 확장에 쓴다.
  // 이 API 응답에 이미 포함돼 있어 별도 호출이 필요 없다(005930 실측 확인).
  sharesOutstanding: number | null;
  week52High: number | null;
  week52Low: number | null;
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
    per?: string;
    pbr?: string;
    eps?: string;
    bps?: string;
    lstn_stcn?: string;
    w52_hgpr?: string;
    w52_lwpr?: string;
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

  const parsePositive = (raw: string | undefined): number | null => {
    if (raw === undefined || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

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
    per: parsePositive(output.per),
    pbr: parsePositive(output.pbr),
    eps: parsePositive(output.eps),
    bps: parsePositive(output.bps),
    sharesOutstanding: parsePositive(output.lstn_stcn),
    week52High: parsePositive(output.w52_hgpr),
    week52Low: parsePositive(output.w52_lwpr),
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
// 시간외 단일가 마감 근처. 이 시각 이후로는 KIS가 직전 종가를 그대로 채운
// 의미 없는 데이터를 내려준다 — 조회 시작 커서를 여기서 더 늦추지 않는다
// (아래 MAX_MINUTE_PAGES 산정 근거이기도 하다: 밤에 조회해도 여기서 캡을
// 씌우지 않으면 09:00~18:00 실거래 구간에 쓸 페이지가 부족해져, 그날 늦은
// 시각에 조회할수록 장 초반 데이터가 누락되는 버그가 있었다).
const MARKET_DAY_END_HHMMSS = "180000";
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
  // 시간외 단일가 마감(18:00) 이후 조회하면, 그 이후 시각은 KIS가 직전 종가를
  // 그대로 채운 의미 없는 데이터라 시작 커서를 18:00으로 캡을 씌운다 — 안 그러면
  // 그 무의미한 구간에도 페이지를 소모해 정작 09:00~18:00 실거래 구간을 다
  // 못 모으고 페이지 한도(MAX_MINUTE_PAGES)에 먼저 도달해버린다.
  let cursor = getCurrentKstHHMMSS();
  if (cursor > MARKET_DAY_END_HHMMSS) cursor = MARKET_DAY_END_HHMMSS;

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

    // 일봉 API(inquire-daily-itemchartprice)는 "최신→과거" 순서가 문서로 확인됐지만,
    // 분봉 API(inquire-time-itemchartprice)는 라이브 계정으로 검증할 방법이 없어 같은
    // 가정을 재사용할 수 없다. batch[batch.length - 1]을 가장 과거로 가정했더니(구 로직)
    // 실제 응답이 과거→최신 순일 경우 커서가 전진하지 못하고 최근 30분만 반복 조회되는
    // 버그가 있었다("관심종목 10분봉에서 13시 이전 데이터가 안 보임"). 정렬 방향과
    // 무관하게 안전하도록 배치 안에서 가장 이른 시각을 직접 계산한다.
    const earliestHour = batch.reduce(
      (min, row) => (row.stck_cntg_hour < min ? row.stck_cntg_hour : min),
      batch[0].stck_cntg_hour
    );
    if (earliestHour <= MARKET_OPEN_HHMMSS) break;
    if (batch.length < 30) break; // 30건 미만이면 그날의 첫 데이터까지 다 받은 것

    cursor = earliestHour;
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

// ── 국내주식 재무제표/비율/배당일정 ──────────────────────────────────────────
//
// 종목 상세화면의 재무제표/실적 정보/가치평가지표 섹션은 원래 DART(전자공시) 데이터를
// 재조합해 계산했는데, 한국투자증권 앱이 표시하는 값과 계속 오차가 났다(005930 실측
// 비교로 EPS/BPS/ROE 전부 확인). 조사 결과 KIS 자체 API(손익계산서/대차대조표/
// 수익성비율/성장성비율/예탁원배당일정)가 이미 같은 데이터를 종목별로 제공하고,
// 한투가 실제로 이 값을 그대로 쓰는 것으로 확인돼(005930 실측: 수익성비율의
// self_cptl_ntin_inrt=10.85가 한투 ROE 표시값과 정확히 일치) DART 재조합 대신 이
// API들을 직접 쓴다. DART는 corp_code 매핑(향후 공시 원문 조회용)만 남긴다.
//
// 금액 필드는 전부 억원 단위로 온다(005930 실측: 202512 total_cptl=4363203 →
// 436.32조원, 실제 삼성전자 2025 자본총계와 일치) — 종목 상세화면(원 단위로 억원
// 환산해 표시하는 StockFinancials 컴포넌트)과 호환되도록 1억을 곱해 원 단위로 변환한다.
//
// 응답 output은 배열이며 가장 최근 분기 기준 TTM성 데이터 1건 다음 연도별(YYYY12)
// 스냅샷이 과거까지 이어진다(005930 실측: 2004~2026). 재무제표/실적 정보 섹션은
// 확정된 연간 실적만 보여줘야 하므로 stac_yymm이 "12"로 끝나는(연말 결산) 행만
// 취급한다.
function eokWonToWon(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n * 100_000_000 : null;
}

function parsePctField(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** stac_yymm(YYYYMM)이 연말 결산(YYYY12)이면 연도를 반환하고, 아닌 행(가장 최근
 * 분기 TTM성 데이터 등)은 걸러내기 위해 null을 반환한다. */
function annualYearFromStacYymm(stacYymm: string): number | null {
  if (!stacYymm.endsWith("12")) return null;
  const year = Number(stacYymm.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

export interface IncomeStatementYear {
  year: number;
  revenue: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
}

interface FinanceIncomeStatementResponse extends KisResponse {
  output: { stac_yymm: string; sale_account: string; bsop_prti: string; thtr_ntin: string }[];
}

/** 국내주식 손익계산서 — 연도별 매출액/영업이익/당기순이익. DART는 KR 종목만 다루므로
 * 호출부에서 market으로 걸러줘야 한다(이 함수 자체는 그 필터링을 하지 않는다). */
export async function getIncomeStatementYears(
  stockCode: string,
  priority: "user" | "batch" = "user"
): Promise<IncomeStatementYear[]> {
  const { appKey, appSecret } = getCredentials();
  const accessToken = await getAccessToken();

  const url = new URL("/uapi/domestic-stock/v1/finance/income-statement", KIS_BASE_URL);
  url.searchParams.set("FID_DIV_CLS_CODE", "0");
  url.searchParams.set("fid_cond_mrkt_div_code", "J");
  url.searchParams.set("fid_input_iscd", stockCode);

  const data = (await kisFetch(
    url,
    TR_ID_FINANCE_INCOME_STATEMENT,
    accessToken,
    appKey,
    appSecret,
    priority
  )) as FinanceIncomeStatementResponse;

  return (data.output ?? [])
    .map((row) => {
      const year = annualYearFromStacYymm(row.stac_yymm);
      if (year === null) return null;
      return {
        year,
        revenue: eokWonToWon(row.sale_account),
        operatingIncome: eokWonToWon(row.bsop_prti),
        netIncome: eokWonToWon(row.thtr_ntin),
      };
    })
    .filter((row): row is IncomeStatementYear => row !== null)
    .sort((a, b) => b.year - a.year);
}

export interface BalanceSheetYear {
  year: number;
  totalAssets: number | null;
  totalLiabilities: number | null;
  totalEquity: number | null;
}

interface FinanceBalanceSheetResponse extends KisResponse {
  output: { stac_yymm: string; total_aset: string; total_lblt: string; total_cptl: string }[];
}

/** 국내주식 대차대조표 — 연도별 자산총계/부채총계/자본총계. */
export async function getBalanceSheetYears(
  stockCode: string,
  priority: "user" | "batch" = "user"
): Promise<BalanceSheetYear[]> {
  const { appKey, appSecret } = getCredentials();
  const accessToken = await getAccessToken();

  const url = new URL("/uapi/domestic-stock/v1/finance/balance-sheet", KIS_BASE_URL);
  url.searchParams.set("FID_DIV_CLS_CODE", "0");
  url.searchParams.set("fid_cond_mrkt_div_code", "J");
  url.searchParams.set("fid_input_iscd", stockCode);

  const data = (await kisFetch(
    url,
    TR_ID_FINANCE_BALANCE_SHEET,
    accessToken,
    appKey,
    appSecret,
    priority
  )) as FinanceBalanceSheetResponse;

  return (data.output ?? [])
    .map((row) => {
      const year = annualYearFromStacYymm(row.stac_yymm);
      if (year === null) return null;
      return {
        year,
        totalAssets: eokWonToWon(row.total_aset),
        totalLiabilities: eokWonToWon(row.total_lblt),
        totalEquity: eokWonToWon(row.total_cptl),
      };
    })
    .filter((row): row is BalanceSheetYear => row !== null)
    .sort((a, b) => b.year - a.year);
}

export interface ProfitRatioYear {
  year: number;
  roePct: number | null;
  netMarginPct: number | null;
}

interface FinanceProfitRatioResponse extends KisResponse {
  output: { stac_yymm: string; self_cptl_ntin_inrt: string; sale_ntin_rate: string }[];
}

/** 국내주식 수익성비율 — 연도별 ROE(자기자본순이익율)/순이익률(매출액순이익율). */
export async function getProfitRatioYears(
  stockCode: string,
  priority: "user" | "batch" = "user"
): Promise<ProfitRatioYear[]> {
  const { appKey, appSecret } = getCredentials();
  const accessToken = await getAccessToken();

  const url = new URL("/uapi/domestic-stock/v1/finance/profit-ratio", KIS_BASE_URL);
  url.searchParams.set("fid_input_iscd", stockCode);
  url.searchParams.set("FID_DIV_CLS_CODE", "0");
  url.searchParams.set("fid_cond_mrkt_div_code", "J");

  const data = (await kisFetch(
    url,
    TR_ID_FINANCE_PROFIT_RATIO,
    accessToken,
    appKey,
    appSecret,
    priority
  )) as FinanceProfitRatioResponse;

  return (data.output ?? [])
    .map((row) => {
      const year = annualYearFromStacYymm(row.stac_yymm);
      if (year === null) return null;
      return {
        year,
        roePct: parsePctField(row.self_cptl_ntin_inrt),
        netMarginPct: parsePctField(row.sale_ntin_rate),
      };
    })
    .filter((row): row is ProfitRatioYear => row !== null)
    .sort((a, b) => b.year - a.year);
}

export interface GrowthRatioYear {
  year: number;
  revenueGrowthPct: number | null;
  operatingIncomeGrowthPct: number | null;
}

interface FinanceGrowthRatioResponse extends KisResponse {
  output: { stac_yymm: string; grs: string; bsop_prfi_inrt: string }[];
}

/** 국내주식 성장성비율 — 연도별 매출액증가율/영업이익증가율. 당기순이익 증감률은 이
 * API에 없어 호출부(손익계산서 결과)에서 직접 계산해야 한다. */
export async function getGrowthRatioYears(
  stockCode: string,
  priority: "user" | "batch" = "user"
): Promise<GrowthRatioYear[]> {
  const { appKey, appSecret } = getCredentials();
  const accessToken = await getAccessToken();

  const url = new URL("/uapi/domestic-stock/v1/finance/growth-ratio", KIS_BASE_URL);
  url.searchParams.set("fid_input_iscd", stockCode);
  url.searchParams.set("fid_div_cls_code", "0");
  url.searchParams.set("fid_cond_mrkt_div_code", "J");

  const data = (await kisFetch(
    url,
    TR_ID_FINANCE_GROWTH_RATIO,
    accessToken,
    appKey,
    appSecret,
    priority
  )) as FinanceGrowthRatioResponse;

  return (data.output ?? [])
    .map((row) => {
      const year = annualYearFromStacYymm(row.stac_yymm);
      if (year === null) return null;
      return {
        year,
        revenueGrowthPct: parsePctField(row.grs),
        operatingIncomeGrowthPct: parsePctField(row.bsop_prfi_inrt),
      };
    })
    .filter((row): row is GrowthRatioYear => row !== null)
    .sort((a, b) => b.year - a.year);
}

export interface DividendRecord {
  // YYYYMMDD 문자열 그대로 둔다 — 호출부가 연도별 합산(5개년 배당 이력 표)에 이 값을
  // 그대로 비교해 쓴다.
  recordDate: string;
  cashDividendPerShare: number;
  // 실제 배당금 지급일(YYYYMMDD, 없으면 null). 한투 앱 자체 정의("배당수익률 = 최근
  // 1년 주당배당금 합계 / 전일 종가", "1년간 배당 = 지급일 기준으로 최근 1년동안
  // 지급된 배당지급 횟수")를 그대로 따르려면 기준일(record_date)이 아니라 이
  // 지급일 기준으로, 그리고 "이미 지급된"(지급일이 오늘 이전인) 건만 세야 한다 —
  // 005930 실측으로 아직 지급 전인(divi_pay_dt가 미래) 예정 배당 건이 함께 잡혀
  // 한투보다 배당수익률/배당 횟수가 더 크게 나오는 걸 확인해 이렇게 고쳤다.
  payDate: string | null;
}

type KsdinfoDividendRow = { record_date: string; per_sto_divi_amt: string; divi_pay_dt?: string };

/** "YYYY/MM/DD" → "YYYYMMDD". 비어있거나 형식이 다르면 null. */
function parseKsdPayDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replaceAll("/", "");
  return /^\d{8}$/.test(digits) ? digits : null;
}

interface KsdinfoDividendResponse extends KisResponse {
  // 실측 확인: 이 엔드포인트는 배열 필드명을 "output"으로 줄 때도 있고 "output1"로
  // 줄 때도 있다(005930, 같은 토큰·같은 쿼리 파라미터, 몇 분 간격으로 둘 다 실제
  // 관측함 — 우리 쪽 재시도/캐싱 문제가 아니라 KIS 응답 자체의 필드명이 바뀐다).
  // 앞서 "가끔 빈 배열로 온다"고 판단해 재시도를 넣었던 건 사실 이 필드명 불일치를
  // "output"만 읽고 있었기 때문이었다 — 재시도가 아니라 두 필드명을 다 읽는 게
  // 정확한 수정이라 여기서 그렇게 고친다.
  output?: KsdinfoDividendRow[];
  output1?: KsdinfoDividendRow[];
}

/** 예탁원정보(배당일정)에서 최근 yearsBack개년의 배당 이벤트(보통주 1주당 현금배당금)를
 * 원본 그대로 받아온다. 삼성전자처럼 분기배당을 하는 종목은 한 해에 결산/분기 배당이
 * 여러 건 나뉘어 오므로(005930 실측: 분기 3건 + 결산 1건), 연도별 합산이나 최근 1년
 * 이벤트 수 계산은 호출부가 이 원본 리스트를 가지고 직접 한다 — 그래야 API를 두 번
 * 부르지 않고 한 번 받은 데이터로 5개년 배당 이력 표와 "1년간 배당 횟수" 통계를 함께
 * 계산할 수 있다. sht_cd로 종목을 좁혀 호출하므로(KRX는 보통주/우선주가 서로 다른
 * 종목코드) 별도 보통주/우선주 구분 파라미터는 없다. */
export async function getDividendRecords(
  stockCode: string,
  yearsBack: number,
  priority: "user" | "batch" = "user"
): Promise<DividendRecord[]> {
  const { appKey, appSecret } = getCredentials();
  const accessToken = await getAccessToken();

  const now = new Date();
  const toDate = `${now.getFullYear()}1231`;
  const fromDate = `${now.getFullYear() - yearsBack}0101`;

  const url = new URL("/uapi/domestic-stock/v1/ksdinfo/dividend", KIS_BASE_URL);
  url.searchParams.set("CTS", "");
  url.searchParams.set("GB1", "0");
  url.searchParams.set("F_DT", fromDate);
  url.searchParams.set("T_DT", toDate);
  url.searchParams.set("SHT_CD", stockCode);
  url.searchParams.set("HIGH_GB", "");

  const data = (await kisFetch(
    url,
    TR_ID_KSDINFO_DIVIDEND,
    accessToken,
    appKey,
    appSecret,
    priority
  )) as KsdinfoDividendResponse;

  const rows = data.output ?? data.output1 ?? [];
  const records: DividendRecord[] = [];
  for (const row of rows) {
    const amount = Number(row.per_sto_divi_amt);
    if (!row.record_date || !Number.isFinite(amount)) continue;
    records.push({ recordDate: row.record_date, cashDividendPerShare: amount, payDate: parseKsdPayDate(row.divi_pay_dt) });
  }

  return records.sort((a, b) => b.recordDate.localeCompare(a.recordDate));
}

export interface InvestorTrendDay {
  date: string; // YYYY-MM-DD
  foreignNetBuy: number;
  institutionNetBuy: number;
  individualNetBuy: number;
}

interface InquireInvestorResponse extends KisResponse {
  output?: { stck_bsop_date: string; frgn_ntby_qty: string; orgn_ntby_qty: string; prsn_ntby_qty: string }[];
}

// 투자자 동향 카드는 종목 상세화면을 열 때마다 조회되므로, 배치 없이도 같은 종목을
// 짧은 시간 안에 여러 번 보면 KIS를 매번 다시 부르지 않도록 getDailyPrices의
// chartCache와 동일한 패턴(인메모리 + TTL)을 쓴다. 오늘 데이터는 장중에 계속
// 바뀌므로 TTL을 넘기면 자연히 다시 받아온다 — 서버리스 콜드스타트마다 캐시가
// 비워질 수 있다는 한계도 기존 chartCache와 동일하게 감수한다.
const INVESTOR_TREND_CACHE_TTL_MS = 5 * 60 * 1000;
const INVESTOR_TREND_MAX_DAYS = 20;
const investorTrendCache = new Map<string, { days: InvestorTrendDay[]; fetchedAt: number }>();

/** 국내주식 현재가 투자자(inquire-investor) — 날짜 파라미터 없이 한 번의 호출로 최근
 * 약 30영업일(005930 실측: 20260715~20260825, 30건) 외국인/기관/개인 순매수 수량을
 * 배열로 받는다. "종목별 투자자매매동향(일별)"(investor-trade-by-stock-daily)도
 * 검토했지만 날짜 커서+페이지네이션이 필요하고 장 시간 외 호출 시 "TIME LIMIT
 * 00:00~15:40"(OPSQ2001) 오류로 실패해(005930 실측) 상시 온디맨드 조회에 부적합해
 * 채택하지 않았다. KIS 문서상 당일 데이터는 장 종료 후 제공되므로, 장중에는 오늘
 * 날짜 행이 아직 없을 수 있다(정상 — 있는 데이터까지만 반환). */
export async function getInvestorTrend(
  stockCode: string,
  priority: "user" | "batch" = "user"
): Promise<InvestorTrendDay[]> {
  const cached = investorTrendCache.get(stockCode);
  if (cached && Date.now() - cached.fetchedAt < INVESTOR_TREND_CACHE_TTL_MS) {
    return cached.days;
  }

  const { appKey, appSecret } = getCredentials();
  const accessToken = await getAccessToken();

  const url = new URL("/uapi/domestic-stock/v1/quotations/inquire-investor", KIS_BASE_URL);
  url.searchParams.set("FID_COND_MRKT_DIV_CODE", "J");
  url.searchParams.set("FID_INPUT_ISCD", stockCode);

  const data = (await kisFetch(
    url,
    TR_ID_INQUIRE_INVESTOR,
    accessToken,
    appKey,
    appSecret,
    priority
  )) as InquireInvestorResponse;

  // KIS는 최신 순으로 내려주므로 과거→최신 순으로 뒤집는다(국내 getDailyPrices와 동일 규약).
  // 이 API가 실제로 몇 건을 주는지는 그때그때 다를 수 있어(005930 실측으로 확인한
  // ksdinfo/dividend의 사례처럼 이 계정의 KIS 응답이 문서와 다르게 오는 경우가
  // 있었다), "최근 1개월(약 영업일 기준 20일)"이라는 원래 요구사항을 지키기 위해
  // 항상 최근 INVESTOR_TREND_MAX_DAYS일만 잘라서 쓴다 — 그래프가 과도하게 빽빽해지는
  // 것도 함께 막는다.
  const days = (data.output ?? [])
    .map((row) => ({
      date: `${row.stck_bsop_date.slice(0, 4)}-${row.stck_bsop_date.slice(4, 6)}-${row.stck_bsop_date.slice(6, 8)}`,
      foreignNetBuy: Number(row.frgn_ntby_qty),
      institutionNetBuy: Number(row.orgn_ntby_qty),
      individualNetBuy: Number(row.prsn_ntby_qty),
    }))
    .reverse()
    .slice(-INVESTOR_TREND_MAX_DAYS);

  investorTrendCache.set(stockCode, { days, fetchedAt: Date.now() });

  return days;
}

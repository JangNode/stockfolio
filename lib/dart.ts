import "server-only";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getStockPrice } from "@/lib/kis";

const DART_BASE_URL = "https://opendart.fss.or.kr/api";

// 사업보고서(연간). 반기/분기(11012/11013/11014)는 지금은 다루지 않는다 — 사업보고서
// 하나만 조회해도 당기·전기·전전기(최근 3개년) 데이터가 함께 오기 때문에, 최근 3개년
// 연간 추이를 보여주는 목적에는 호출 1번으로 충분하다.
const REPRT_CODE_ANNUAL = "11011";
// 최신 사업보고서가 아직 안 나온 경우(신규상장 등)를 대비해 연도를 낮춰가며 재시도할
// 최대 횟수. 사업보고서는 보통 다음 해 3월에 제출되므로 "현재 연도 - 1"부터 시작한다.
const MAX_YEAR_LOOKBACK = 5;
const DART_STATUS_OK = "000";
const DART_STATUS_NO_DATA = "013";

// 다중회사 조회(fnlttMultiAcnt) 한 번에 묶을 수 있는 corp_code 최대 개수. DART 공식
// 가이드를 이 환경(egress 제한)에서 직접 확인하지 못해 여러 출처로 교차 확인한 값(100)을
// 우선 넣어뒀다 — 실제로 이 값이 틀리면 아래 fetchMultiCompanyChunk의 자동 축소
// 재시도(100→50→25→...)가 알아서 맞는 크기를 찾아내고 dart_api_call_log.chunk_size에
// 남기므로, 첫 배치 실행 로그를 보고 이 상수를 실제 상한으로 고정하면 된다.
const MAX_MULTI_CHUNK_SIZE = 100;

// 배당 이력 조회(alotMatter)는 다중회사 조회를 지원하지 않고 연도당 1회씩 불러야 해서,
// 5개년이면 종목당 5번 호출한다. 이 값이 커질수록 초기 백필 호출량이 선형으로 늘어난다.
const DIVIDEND_YEARS_TO_TRACK = 5;

// DART 쪽 초당/분당 호출 제한을 정확히 모르는 채로(일일 한도 4만 건만 공개돼 있음)
// 배당 이력은 종목×연도 조합으로 최대 1,500회 가까이 연속 호출하므로, 안전하게 호출
// 사이에 짧은 간격을 둔다.
const DART_CALL_INTERVAL_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 유통주식수(stockTotqySttus)/지배주주순이익(fnlttSinglAcntAll)은 다중회사 조회를
// 지원하지 않아 종목당 개별 호출이 필요하다 — 순차 처리하면 대형주 300개 기준으로
// 배치가 30분 타임아웃을 넘겨버린 전례가 있어(2026-08-26), scripts/*.ts의 KIS
// 동시성 호출과 같은 패턴으로 병렬 처리한다.
const SHARES_AND_INCOME_CONCURRENCY = 10;

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;

  async function runOne(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
}

function getDartApiKey(): string {
  const key = process.env.DART_API_KEY;
  if (!key) throw new Error("DART_API_KEY 환경 변수가 설정되지 않았습니다.");
  return key;
}

function currentKstYear(): number {
  return Number(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }).slice(0, 4));
}

/** 해당 사업연도가 이미 지나 사업보고서가 확정됐을 것으로 보고 다시는 호출하지 않을
 * 기준. 아주 드물게 정정보고서로 바뀔 수 있지만, 그 경우는 감수하고 재호출 대상에서
 * 제외한다(사용자 확인 완료). */
function isFiscalYearFinal(year: number): boolean {
  return year <= currentKstYear() - 2;
}

async function logDartCall(
  endpoint: "corpCode" | "fnlttMultiAcnt" | "alotMatter" | "stockTotqySttus" | "fnlttSinglAcntAll",
  status: "success" | "error",
  options: { corpCode?: string; chunkSize?: number; dartStatusCode?: string } = {}
): Promise<void> {
  try {
    await supabaseAdmin.from("dart_api_call_log").insert({
      endpoint,
      corp_code: options.corpCode ?? null,
      chunk_size: options.chunkSize ?? null,
      status,
      dart_status_code: options.dartStatusCode ?? null,
    });
  } catch {
    // 로그 적재 실패로 실제 기능(매핑 동기화/재무제표 조회)까지 실패시키지 않는다.
  }
}

export interface DartCorpCodeEntry {
  corpCode: string;
  corpName: string;
  stockCode: string | null;
  modifyDate: string;
}

interface CorpCodeListItem {
  corp_code: string;
  corp_name: string;
  stock_code?: string | null;
  modify_date: string;
}

/** corpCode.xml(zip) 전체를 내려받아 파싱한다. DB 저장은 호출부(동기화 배치)의 몫이다 —
 * 이 함수는 순수 다운로드+파싱만 한다. 인증키가 잘못됐거나 DART 쪽 오류면 zip이 아니라
 * 에러 상태를 담은 작은 XML이 내려오므로, unzip이 실패하면 그걸로 에러 메시지를 읽는다. */
export async function fetchCorpCodeMap(): Promise<DartCorpCodeEntry[]> {
  const url = `${DART_BASE_URL}/corpCode.xml?crtfc_key=${encodeURIComponent(getDartApiKey())}`;
  const res = await fetch(url);
  if (!res.ok) {
    await logDartCall("corpCode", "error");
    throw new Error(`DART corpCode.xml 다운로드 실패: HTTP ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  // parseTagValue: false — 기본값(true)이면 corp_code/stock_code처럼 숫자로만 보이는
  // 태그값을 숫자로 바꿔버려서 앞자리 0이 통째로 사라진다("005930" → 5930). 종목코드가
  // 전부 0으로 시작할 수 있는 6자리 문자열이라 반드시 꺼야 한다.
  const parser = new XMLParser({ isArray: (name) => name === "list", parseTagValue: false });

  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    // zip이 아니면 DART가 에러를 XML로 바로 내려준 경우다({status, message}).
    const errorXml = parser.parse(buffer.toString("utf-8"));
    const message = errorXml?.result?.message ?? "알 수 없는 오류";
    const statusCode = errorXml?.result?.status;
    await logDartCall("corpCode", "error", { dartStatusCode: statusCode });
    throw new Error(`DART corpCode.xml 응답 오류: ${message}`);
  }

  const xmlEntry = zip.getEntries().find((e) => e.entryName.toUpperCase() === "CORPCODE.XML");
  if (!xmlEntry) {
    await logDartCall("corpCode", "error");
    throw new Error("CORPCODE.xml 항목을 zip에서 찾을 수 없습니다.");
  }

  const parsed = parser.parse(xmlEntry.getData().toString("utf-8"));
  const list: CorpCodeListItem[] = parsed?.result?.list ?? [];

  await logDartCall("corpCode", "success");

  return list.map((item) => ({
    corpCode: String(item.corp_code).trim(),
    corpName: String(item.corp_name).trim(),
    stockCode: item.stock_code && String(item.stock_code).trim() !== "" ? String(item.stock_code).trim() : null,
    modifyDate: String(item.modify_date).trim(),
  }));
}

export interface StockCorpPair {
  stockCode: string;
  corpCode: string;
  // 이미 알고 있으면(예: 대형주 배치가 시가총액 필터링 단계에서 이미 KIS로 조회해둔
  // 값) 넘겨서 resolveSharesOutstanding이 KIS를 다시 호출하지 않게 한다. undefined면
  // 모르는 상태(자체적으로 조회), null이면 "KIS엔 없었다"는 뜻으로 곧장 DART 폴백으로 간다.
  sharesOutstanding?: number | null;
}

export interface FinancialStatementYear {
  year: number;
  revenue: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  totalAssets: number | null;
  totalLiabilities: number | null;
  totalEquity: number | null;
  // 실적 정보(증감률/이익률)·가치평가지표(EPS/BPS/ROE) 섹션을 위한 파생 지표.
  // 최근 3개년 안에서만 계산 가능한 값(YoY 증감률)은 비교 대상 연도가 배열 밖에 있는
  // 최초 연도(가장 오래된 연도)에서는 null이다.
  revenueGrowthPct: number | null;
  operatingIncomeGrowthPct: number | null;
  netIncomeGrowthPct: number | null;
  operatingMarginPct: number | null;
  netMarginPct: number | null;
  roePct: number | null;
  eps: number | null;
  bps: number | null;
  sharesOutstanding: number | null;
  // 지배기업 소유주지분 당기순이익(있으면) — EPS/ROE 계산의 분자로 이 값을 우선 쓴다.
  // fnlttMultiAcnt("다중회사 주요계정")엔 이 세부 항목이 없어(연결 전체 당기순이익만
  // 제공) 별도로 fnlttSinglAcntAll(전체 재무제표, 단일회사 전용)을 호출해 얻는다 — 못
  // 구하면 null이고, 이 경우 EPS/ROE는 netIncome(전체)로 폴백한다.
  controllingNetIncome: number | null;
}

// 재무제표 원천 6개 계정만 가리킨다 — FinancialStatementYear의 파생 지표(증감률/이익률/
// EPS 등)는 이 계정들로부터 별도 계산되는 값이라 여기 포함하지 않는다.
type MetricKey = "revenue" | "operatingIncome" | "netIncome" | "totalAssets" | "totalLiabilities" | "totalEquity";

// fnlttMultiAcnt("다중회사 주요계정")는 fnlttSinglAcnt와 동일하게 전 종목 공통으로
// 정규화된 소수의 표준 계정만 돌려주는 API라(전체 XBRL 상세가 아님) account_nm이
// 대체로 고정돼 있지만, 실제 응답에서 확인된 적은 없는 값들이라(DART_API_KEY가 이
// 샌드박스엔 없어 라이브 호출로 검증 불가) 알려진 표기 변형 몇 가지를 함께 매칭해둔다.
// 실제 배포 후 응답을 보고 더 필요하면 추가한다.
const ACCOUNT_NAME_ALIASES: Record<MetricKey, string[]> = {
  revenue: ["매출액", "수익(매출액)"],
  operatingIncome: ["영업이익", "영업이익(손실)"],
  netIncome: ["당기순이익", "당기순이익(손실)"],
  totalAssets: ["자산총계"],
  totalLiabilities: ["부채총계"],
  totalEquity: ["자본총계"],
};

const BALANCE_SHEET_METRICS: MetricKey[] = ["totalAssets", "totalLiabilities", "totalEquity"];
const INCOME_STATEMENT_SJ_DIV = ["IS", "CIS"];
const BALANCE_SHEET_SJ_DIV = ["BS"];

interface FnlttMultiAcntItem {
  corp_code: string;
  fs_div: "CFS" | "OFS";
  sj_div: string;
  account_nm: string;
  thstrm_amount: string;
  frmtrm_amount: string;
  bfefrmtrm_amount: string;
}

function parseAmount(raw: string | undefined): number | null {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const negative = raw.trim().startsWith("(") && raw.trim().endsWith(")");
  const cleaned = raw.replace(/[(),%]/g, "").trim();
  const value = Number(cleaned);
  if (Number.isNaN(value)) return null;
  return negative ? -value : value;
}

function findMetricItem(items: FnlttMultiAcntItem[], metric: MetricKey): FnlttMultiAcntItem | null {
  const sjDivs = BALANCE_SHEET_METRICS.includes(metric) ? BALANCE_SHEET_SJ_DIV : INCOME_STATEMENT_SJ_DIV;
  const aliases = ACCOUNT_NAME_ALIASES[metric];
  const candidates = items.filter((item) => sjDivs.includes(item.sj_div) && aliases.includes(item.account_nm));

  // 연결재무제표(CFS)를 우선하고, 없으면 개별(OFS)로 폴백한다.
  return candidates.find((item) => item.fs_div === "CFS") ?? candidates.find((item) => item.fs_div === "OFS") ?? null;
}

type BaseFinancialYear = Pick<
  FinancialStatementYear,
  "year" | "revenue" | "operatingIncome" | "netIncome" | "totalAssets" | "totalLiabilities" | "totalEquity"
>;

/** 한 회사의 사업보고서 응답 항목들에서 최근 3개년(당기/전기/전전기) 주요 지표를 뽑는다. */
function extractFinancialYears(items: FnlttMultiAcntItem[], bsnsYear: number): BaseFinancialYear[] {
  const metrics = Object.keys(ACCOUNT_NAME_ALIASES) as MetricKey[];
  const byYear: Record<number, Partial<BaseFinancialYear>> = {
    [bsnsYear]: {},
    [bsnsYear - 1]: {},
    [bsnsYear - 2]: {},
  };

  for (const metric of metrics) {
    const item = findMetricItem(items, metric);
    if (!item) continue;
    byYear[bsnsYear][metric] = parseAmount(item.thstrm_amount);
    byYear[bsnsYear - 1][metric] = parseAmount(item.frmtrm_amount);
    byYear[bsnsYear - 2][metric] = parseAmount(item.bfefrmtrm_amount);
  }

  return [bsnsYear - 2, bsnsYear - 1, bsnsYear].map((year) => ({
    year,
    revenue: byYear[year].revenue ?? null,
    operatingIncome: byYear[year].operatingIncome ?? null,
    netIncome: byYear[year].netIncome ?? null,
    totalAssets: byYear[year].totalAssets ?? null,
    totalLiabilities: byYear[year].totalLiabilities ?? null,
    totalEquity: byYear[year].totalEquity ?? null,
  }));
}

/** 매출·영업이익·순이익 증감률(전년대비), 영업이익률/순이익률, ROE, EPS/BPS를 계산해
 * 붙인다. years는 연도 오름차순(오래된 것부터)이어야 증감률 계산이 맞다 —
 * extractFinancialYears의 반환 순서를 그대로 따른다.
 *
 * controllingNetIncomeByYear: EPS/ROE 분자로 쓸 지배주주순이익(있는 연도만). 증권사
 * PER/ROE는 보통 이 값을 쓰므로 있으면 우선 쓰고, 없는 연도(과거 연도는 재조회하지
 * 않으므로 보통 비어 있음)는 전체 당기순이익(netIncome)으로 폴백한다. 실적 정보
 * 섹션의 증감률/이익률(revenueGrowthPct 등)은 공시상 표준 지표인 전체 당기순이익
 * 기준을 그대로 유지한다 — 지배주주순이익 대체는 EPS/ROE에만 적용한다. */
function computeDerivedMetrics(
  years: BaseFinancialYear[],
  sharesOutstanding: number | null,
  controllingNetIncomeByYear: Partial<Record<number, number>> = {}
): FinancialStatementYear[] {
  const growthPct = (curr: number | null, prev: number | null): number | null => {
    if (curr === null || prev === null || prev === 0) return null;
    return ((curr - prev) / Math.abs(prev)) * 100;
  };
  const ratioPct = (numerator: number | null, denominator: number | null): number | null => {
    if (numerator === null || denominator === null || denominator === 0) return null;
    return (numerator / denominator) * 100;
  };
  const perShare = (amount: number | null): number | null => {
    if (amount === null || sharesOutstanding === null || sharesOutstanding <= 0) return null;
    return amount / sharesOutstanding;
  };

  return years.map((y, i) => {
    const prev = i > 0 ? years[i - 1] : null;
    const controllingNetIncome = controllingNetIncomeByYear[y.year] ?? null;
    const epsBasisNetIncome = controllingNetIncome ?? y.netIncome;
    return {
      ...y,
      revenueGrowthPct: growthPct(y.revenue, prev?.revenue ?? null),
      operatingIncomeGrowthPct: growthPct(y.operatingIncome, prev?.operatingIncome ?? null),
      netIncomeGrowthPct: growthPct(y.netIncome, prev?.netIncome ?? null),
      operatingMarginPct: ratioPct(y.operatingIncome, y.revenue),
      netMarginPct: ratioPct(y.netIncome, y.revenue),
      roePct: ratioPct(epsBasisNetIncome, y.totalEquity),
      eps: perShare(epsBasisNetIncome),
      bps: perShare(y.totalEquity),
      sharesOutstanding,
      controllingNetIncome,
    };
  });
}

interface ChunkResult {
  items: FnlttMultiAcntItem[];
  // 이번 호출 트리에서 실제로 DART가 성공 응답을 준 묶음 크기들(재귀 축소 중 여러 개일
  // 수 있음). 배치 스크립트가 여기서 최댓값을 뽑아 "실제 상한이 몇 개였는지" 보고한다.
  successfulChunkSizes: number[];
}

/** corpCodes 묶음 하나로 다중회사 주요계정을 호출한다. DART가 에러를 주면(크기 제한
 * 초과로 추정) 묶음을 절반으로 나눠 재귀적으로 재시도한다 — 그 과정에서 특정 회사
 * 하나만 계속 실패하는 경우(잘못된 corp_code 등)도 자연스럽게 그 회사만 골라내
 * 건너뛰게 된다. 크기 1까지 줄여도 실패하면 그 회사만 포기하고(경고 로그) 계속
 * 진행한다 — 배치 전체를 죽이지 않는다. */
async function fetchMultiCompanyChunk(corpCodes: string[], bsnsYear: string): Promise<ChunkResult> {
  if (corpCodes.length === 0) return { items: [], successfulChunkSizes: [] };

  const url =
    `${DART_BASE_URL}/fnlttMultiAcnt.json?crtfc_key=${encodeURIComponent(getDartApiKey())}` +
    `&corp_code=${corpCodes.map(encodeURIComponent).join(",")}&bsns_year=${bsnsYear}&reprt_code=${REPRT_CODE_ANNUAL}`;

  let body: { status: string; message?: string; list?: FnlttMultiAcntItem[] };
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (error) {
    return shrinkAndRetry(corpCodes, bsnsYear, error instanceof Error ? error.message : String(error));
  }

  if (body.status === DART_STATUS_NO_DATA) {
    await logDartCall("fnlttMultiAcnt", "success", { dartStatusCode: body.status, chunkSize: corpCodes.length });
    return { items: [], successfulChunkSizes: [corpCodes.length] };
  }

  if (body.status !== DART_STATUS_OK) {
    if (corpCodes.length === 1) {
      await logDartCall("fnlttMultiAcnt", "error", {
        corpCode: corpCodes[0],
        dartStatusCode: body.status,
        chunkSize: 1,
      });
      console.warn(`  DART 다중회사 조회 실패(corp_code=${corpCodes[0]}, status=${body.status}) — 이 회사는 건너뜁니다.`);
      return { items: [], successfulChunkSizes: [] };
    }
    return shrinkAndRetry(corpCodes, bsnsYear, `status ${body.status}: ${body.message ?? ""}`);
  }

  await logDartCall("fnlttMultiAcnt", "success", { dartStatusCode: body.status, chunkSize: corpCodes.length });
  return { items: body.list ?? [], successfulChunkSizes: [corpCodes.length] };
}

async function shrinkAndRetry(corpCodes: string[], bsnsYear: string, reason: string): Promise<ChunkResult> {
  console.warn(
    `  DART 다중회사 조회 실패(사유: ${reason}, 묶음 크기 ${corpCodes.length}) — 절반으로 나눠 재시도합니다.`
  );
  const mid = Math.ceil(corpCodes.length / 2);
  const first = corpCodes.slice(0, mid);
  const second = corpCodes.slice(mid);

  await sleep(DART_CALL_INTERVAL_MS);
  const firstResult = await fetchMultiCompanyChunk(first, bsnsYear);
  await sleep(DART_CALL_INTERVAL_MS);
  const secondResult = await fetchMultiCompanyChunk(second, bsnsYear);

  return {
    items: [...firstResult.items, ...secondResult.items],
    successfulChunkSizes: [...firstResult.successfulChunkSizes, ...secondResult.successfulChunkSizes],
  };
}

/** corpCodes를 MAX_MULTI_CHUNK_SIZE 단위로 나눠 다중회사 주요계정을 호출하고,
 * corp_code별로 묶어 돌려준다. */
async function fetchMultiCompanyFinancials(
  corpCodes: string[],
  bsnsYear: string
): Promise<{ byCorp: Map<string, FnlttMultiAcntItem[]>; maxChunkSize: number }> {
  const byCorp = new Map<string, FnlttMultiAcntItem[]>();
  let maxChunkSize = 0;

  for (let i = 0; i < corpCodes.length; i += MAX_MULTI_CHUNK_SIZE) {
    const chunk = corpCodes.slice(i, i + MAX_MULTI_CHUNK_SIZE);
    const result = await fetchMultiCompanyChunk(chunk, bsnsYear);
    for (const size of result.successfulChunkSizes) maxChunkSize = Math.max(maxChunkSize, size);
    for (const item of result.items) {
      const list = byCorp.get(item.corp_code);
      if (list) list.push(item);
      else byCorp.set(item.corp_code, [item]);
    }
    if (i + MAX_MULTI_CHUNK_SIZE < corpCodes.length) await sleep(DART_CALL_INTERVAL_MS);
  }

  return { byCorp, maxChunkSize };
}

// ===== 상장주식수 (EPS/BPS/PER/PBR 계산용) =====
// 증권사 PER/EPS는 보통 자사주 제외 "유통주식수" 기준을 쓴다. KIS 현재가 응답의
// lstn_stcn은 "상장주식수"(자사주 포함 발행총수로 추정 — 자사주 제외 여부가 KIS
// 공식 스펙에 없어 확정 불가)라 정확도가 떨어질 수 있어, 1순위를 DART "주식의 총수
// 현황"(stockTotqySttus)의 유통주식수 항목으로 바꾼다. 못 구하면 2순위로 KIS
// lstn_stcn(이미 대형주 배치가 시가총액 필터링 때 호출하므로 추가 호출 없음)에
// 폴백한다. DART가 항상 1순위가 되므로(기존엔 KIS가 1순위라 DART를 거의 안 불렀음)
// 대형주 배치당 DART 호출이 종목 수만큼(현재 약 300건/주) 늘어난다 — 다중회사 조회를
// 지원하지 않는 API라 종목당 1콜씩 개별 호출해야 한다.

interface StockTotqySttusItem {
  se: string;
  now_to_isu_stock_totqy?: string;
}

/** DART 주식의 총수 현황에서 유통주식수(자사주 제외)를 가져온다. 못 찾으면 발행주식
 * 총수(자사주 포함)로 폴백한다. alotMatter와 마찬가지로 단일회사·단일연도만 조회
 * 가능하고 다중회사 조회는 지원하지 않는다. 이 환경에선 실응답으로 필드명(se/
 * now_to_isu_stock_totqy)과 "유통주식수" 행의 se 표기를 확인하지 못해 느슨하게
 * 매칭한다 — 배포 후 실응답으로 재확인 필요. */
async function fetchSharesOutstandingFromDart(corpCode: string, bsnsYear: number): Promise<number | null> {
  const url =
    `${DART_BASE_URL}/stockTotqySttus.json?crtfc_key=${encodeURIComponent(getDartApiKey())}` +
    `&corp_code=${encodeURIComponent(corpCode)}&bsns_year=${bsnsYear}&reprt_code=${REPRT_CODE_ANNUAL}`;

  let body: { status: string; message?: string; list?: StockTotqySttusItem[] };
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (error) {
    await logDartCall("stockTotqySttus", "error", { corpCode });
    console.warn(
      `  DART 주식총수 조회 실패(corp_code=${corpCode}, bsns_year=${bsnsYear}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }

  if (body.status !== DART_STATUS_OK) {
    await logDartCall("stockTotqySttus", body.status === DART_STATUS_NO_DATA ? "success" : "error", {
      corpCode,
      dartStatusCode: body.status,
    });
    return null;
  }

  await logDartCall("stockTotqySttus", "success", { corpCode, dartStatusCode: body.status });

  const items = body.list ?? [];
  const floatingRow = items.find((i) => i.se.includes("유통주식수") && i.se.includes("보통주"));
  const totalIssuedRow = items.find((i) => i.se.includes("보통주"));
  const row = floatingRow ?? totalIssuedRow;
  return row ? parseAmount(row.now_to_isu_stock_totqy) : null;
}

export interface SharesOutstandingStats {
  // DART "주식의 총수 현황"에서 유통주식수(1순위)를 확보한 건수.
  dart: number;
  // DART가 실패했을 때 KIS lstn_stcn(2순위, 발행총수 추정치)으로 대체한 건수.
  kis: number;
  unavailable: number;
}

/** 종목 하나의 상장주식수를 확보한다: DART 유통주식수를 우선 시도하고, 실패하면
 * (미리 알고 있으면 그 값을 그대로 쓰는) KIS 상장주식수로 폴백한다. stats는 배치가
 * "DART 몇 건 / KIS 폴백 몇 건 / 확보 실패 몇 건"을 집계해 보고할 수 있도록 호출부가
 * 넘기는 누적 카운터다. */
async function resolveSharesOutstanding(
  stock: StockCorpPair,
  bsnsYear: number,
  stats: SharesOutstandingStats
): Promise<number | null> {
  const dartShares = await fetchSharesOutstandingFromDart(stock.corpCode, bsnsYear);
  if (dartShares !== null) {
    stats.dart++;
    return dartShares;
  }

  let kisShares = stock.sharesOutstanding;
  if (kisShares === undefined) {
    try {
      const price = await getStockPrice(stock.stockCode, "batch");
      kisShares = price.sharesOutstanding;
    } catch {
      kisShares = null;
    }
  }

  if (kisShares !== null && kisShares !== undefined) {
    stats.kis++;
    return kisShares;
  }

  stats.unavailable++;
  return null;
}

// ===== 지배주주순이익 (EPS/ROE 계산용) =====
// fnlttMultiAcnt("다중회사 주요계정")는 표준 소수 계정만 제공해 지배기업소유주지분/
// 비지배지분 분리 항목이 없다(2026-08-26 실응답으로 확인). 이 분리 항목은 DART
// "단일회사 전체 재무제표"(fnlttSinglAcntAll)에만 있고, 이 API는 다중회사 조회를
// 지원하지 않을 뿐 아니라 fs_div(CFS|OFS)를 쿼리 파라미터로 반드시 명시해야 한다
// (fnlttMultiAcnt처럼 응답에 CFS/OFS가 함께 안 온다) — 연결(CFS) 먼저 시도하고 없으면
// (013) 개별(OFS)로 재시도한다.

interface FnlttSinglAcntAllItem {
  sj_div: string;
  account_nm: string;
  thstrm_amount: string;
}

async function fetchFnlttSinglAcntAll(
  corpCode: string,
  bsnsYear: number,
  fsDiv: "CFS" | "OFS"
): Promise<FnlttSinglAcntAllItem[] | null> {
  const url =
    `${DART_BASE_URL}/fnlttSinglAcntAll.json?crtfc_key=${encodeURIComponent(getDartApiKey())}` +
    `&corp_code=${encodeURIComponent(corpCode)}&bsns_year=${bsnsYear}&reprt_code=${REPRT_CODE_ANNUAL}&fs_div=${fsDiv}`;

  let body: { status: string; message?: string; list?: FnlttSinglAcntAllItem[] };
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (error) {
    await logDartCall("fnlttSinglAcntAll", "error", { corpCode });
    console.warn(
      `  DART 전체 재무제표(지배주주순이익용) 조회 실패(corp_code=${corpCode}, bsns_year=${bsnsYear}, fs_div=${fsDiv}): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }

  if (body.status === DART_STATUS_NO_DATA) {
    await logDartCall("fnlttSinglAcntAll", "success", { corpCode, dartStatusCode: body.status });
    return null;
  }
  if (body.status !== DART_STATUS_OK) {
    await logDartCall("fnlttSinglAcntAll", "error", { corpCode, dartStatusCode: body.status });
    return null;
  }

  await logDartCall("fnlttSinglAcntAll", "success", { corpCode, dartStatusCode: body.status });
  return body.list ?? [];
}

/** 지배기업 소유주지분 당기순이익을 가져온다: 연결(CFS)로 먼저 시도하고, 데이터가
 * 없으면(013) 개별(OFS)로 재시도한다. 계정명 표기를 이 환경(DART_API_KEY 없음)에서
 * 실응답으로 확인하지 못해, "지배기업"을 포함하고 "비지배"는 포함하지 않는 당기순이익
 * 관련 계정명을 느슨하게 매칭한다 — 배포 후 실응답으로 재확인 필요. 못 찾으면 null이고
 * 이 경우 EPS/ROE는 전체 당기순이익(netIncome)으로 폴백한다(computeDerivedMetrics). */
async function fetchControllingNetIncome(corpCode: string, bsnsYear: number): Promise<number | null> {
  const cfsItems = await fetchFnlttSinglAcntAll(corpCode, bsnsYear, "CFS");
  const items = cfsItems && cfsItems.length > 0 ? cfsItems : await fetchFnlttSinglAcntAll(corpCode, bsnsYear, "OFS");
  if (!items) return null;

  const match = items.find(
    (i) =>
      (i.sj_div === "IS" || i.sj_div === "CIS") &&
      i.account_nm.includes("지배기업") &&
      i.account_nm.includes("당기순이익") &&
      !i.account_nm.includes("비지배")
  );
  return match ? parseAmount(match.thstrm_amount) : null;
}

/** stocks 목록에 대해 다중회사 주요계정을 조회해 최근 3개년 재무제표를 갱신한다. 이미
 * 확정(is_final)된 최신 연도가 캐시에 있는 종목은 완전히 건너뛴다. 사업보고서가 아직
 * 안 나온 종목(신규상장 등)은 연도를 낮춰가며 재시도하되, 이미 응답을 받은 종목은
 * 다음 시도 대상에서 빠진다. */
export async function syncFinancialStatements(
  stocks: StockCorpPair[]
): Promise<{ updatedYears: number; maxSuccessfulChunkSize: number; sharesOutstandingStats: SharesOutstandingStats }> {
  const sharesOutstandingStats: SharesOutstandingStats = { kis: 0, dart: 0, unavailable: 0 };
  if (stocks.length === 0) return { updatedYears: 0, maxSuccessfulChunkSize: 0, sharesOutstandingStats };

  const targetYear = currentKstYear() - 1;

  const { data: existingRows } = await supabaseAdmin
    .from("dart_financial_statement_years")
    .select("stock_code, is_final")
    .in(
      "stock_code",
      stocks.map((s) => s.stockCode)
    )
    .eq("year", targetYear);

  const finalStockCodes = new Set((existingRows ?? []).filter((r) => r.is_final).map((r) => r.stock_code));
  let remaining = stocks.filter((s) => !finalStockCodes.has(s.stockCode));

  let updatedYears = 0;
  let maxSuccessfulChunkSize = 0;

  for (let attempt = 0; attempt < MAX_YEAR_LOOKBACK && remaining.length > 0; attempt++) {
    const bsnsYear = targetYear - attempt;
    const { byCorp, maxChunkSize } = await fetchMultiCompanyFinancials(
      remaining.map((s) => s.corpCode),
      String(bsnsYear)
    );
    maxSuccessfulChunkSize = Math.max(maxSuccessfulChunkSize, maxChunkSize);

    const rowsToUpsert: Record<string, unknown>[] = [];
    const stillMissing: StockCorpPair[] = [];
    const toProcess: StockCorpPair[] = [];

    for (const stock of remaining) {
      const items = byCorp.get(stock.corpCode);
      if (!items || items.length === 0) {
        stillMissing.push(stock);
      } else {
        toProcess.push(stock);
      }
    }

    await runWithConcurrency(toProcess, SHARES_AND_INCOME_CONCURRENCY, async (stock) => {
      const items = byCorp.get(stock.corpCode);
      if (!items) return;

      const shares = await resolveSharesOutstanding(stock, bsnsYear, sharesOutstandingStats);
      const controllingNetIncome = await fetchControllingNetIncome(stock.corpCode, bsnsYear);
      const years = computeDerivedMetrics(extractFinancialYears(items, bsnsYear), shares, {
        [bsnsYear]: controllingNetIncome ?? undefined,
      });

      for (const y of years) {
        rowsToUpsert.push({
          stock_code: stock.stockCode,
          year: y.year,
          corp_code: stock.corpCode,
          revenue: y.revenue,
          operating_income: y.operatingIncome,
          net_income: y.netIncome,
          total_assets: y.totalAssets,
          total_liabilities: y.totalLiabilities,
          total_equity: y.totalEquity,
          revenue_growth_pct: y.revenueGrowthPct,
          operating_income_growth_pct: y.operatingIncomeGrowthPct,
          net_income_growth_pct: y.netIncomeGrowthPct,
          operating_margin_pct: y.operatingMarginPct,
          net_margin_pct: y.netMarginPct,
          roe_pct: y.roePct,
          eps: y.eps,
          bps: y.bps,
          shares_outstanding: y.sharesOutstanding,
          controlling_net_income: y.controllingNetIncome,
          is_final: isFiscalYearFinal(y.year),
          fetched_at: new Date().toISOString(),
        });
      }
    });

    if (rowsToUpsert.length > 0) {
      await supabaseAdmin
        .from("dart_financial_statement_years")
        .upsert(rowsToUpsert, { onConflict: "stock_code,year" });
      updatedYears += rowsToUpsert.length;
    }

    remaining = stillMissing;
  }

  return { updatedYears, maxSuccessfulChunkSize, sharesOutstandingStats };
}

/** 종목코드 하나에 대해 최근 3개년 재무제표를 가져온다(종목 상세 화면 온디맨드 경로).
 * syncFinancialStatements를 그대로 재사용하므로, 이미 확정된 연도는 다시 호출하지
 * 않는다. DART corp_code 매핑이 없거나(비상장 등) 재무 데이터가 끝내 없으면 null. */
export async function getFinancialStatements(stockCode: string): Promise<FinancialStatementYear[] | null> {
  const { data: corp } = await supabaseAdmin
    .from("dart_corp_codes")
    .select("corp_code")
    .eq("stock_code", stockCode)
    .maybeSingle();

  if (!corp) return null;

  await syncFinancialStatements([{ stockCode, corpCode: corp.corp_code }]);

  const { data: rows } = await supabaseAdmin
    .from("dart_financial_statement_years")
    .select(
      "year, revenue, operating_income, net_income, total_assets, total_liabilities, total_equity, revenue_growth_pct, operating_income_growth_pct, net_income_growth_pct, operating_margin_pct, net_margin_pct, roe_pct, eps, bps, shares_outstanding, controlling_net_income"
    )
    .eq("stock_code", stockCode)
    .order("year", { ascending: true });

  if (!rows || rows.length === 0) return null;

  return rows.map((r) => ({
    year: r.year,
    revenue: r.revenue,
    operatingIncome: r.operating_income,
    netIncome: r.net_income,
    totalAssets: r.total_assets,
    totalLiabilities: r.total_liabilities,
    totalEquity: r.total_equity,
    revenueGrowthPct: r.revenue_growth_pct,
    operatingIncomeGrowthPct: r.operating_income_growth_pct,
    netIncomeGrowthPct: r.net_income_growth_pct,
    operatingMarginPct: r.operating_margin_pct,
    netMarginPct: r.net_margin_pct,
    roePct: r.roe_pct,
    eps: r.eps,
    bps: r.bps,
    sharesOutstanding: r.shares_outstanding,
    controllingNetIncome: r.controlling_net_income,
  }));
}

// ===== 배당 이력 (dart_dividends) =====
// 이번 범위는 테이블/수집 배치까지만이다 — 이 데이터를 쓰는 화면이나 DH전략 자체는
// 다음 작업으로 미룬다(2026-08-26 사용자 확인).

interface AlotMatterItem {
  se: string;
  stock_knd?: string;
  thstrm: string;
}

interface ParsedDividend {
  cashDividendPerShareCommon: number | null;
  cashDividendPerSharePreferred: number | null;
  dividendYieldPct: number | null;
  payoutRatioPct: number | null;
  totalCashDividend: number | null;
}

// alotMatter 응답의 구분(se)/주식종류(stock_knd) 표기를 실응답으로 확인하지 못해
// (DART_API_KEY 없음) 알려진 표기를 기준으로 느슨하게(포함 여부로) 매칭한다. raw 컬럼에
// 원본 응답을 그대로 함께 저장해두므로, 실제 배포 후 매칭이 틀린 게 확인되면 재호출
// 없이 raw만 다시 파싱해 고치면 된다.
function parseDividendItems(items: AlotMatterItem[]): ParsedDividend {
  const find = (sePredicate: (se: string) => boolean, stockKndPredicate?: (k: string) => boolean): number | null => {
    const item = items.find(
      (i) => sePredicate(i.se) && (!stockKndPredicate || (i.stock_knd !== undefined && stockKndPredicate(i.stock_knd)))
    );
    return item ? parseAmount(item.thstrm) : null;
  };

  const isPerShareCash = (se: string) => se.includes("주당") && se.includes("현금배당");

  return {
    cashDividendPerShareCommon: find(isPerShareCash, (k) => k.includes("보통주")),
    cashDividendPerSharePreferred: find(isPerShareCash, (k) => k.includes("우선주")),
    dividendYieldPct: find((se) => se.includes("현금배당수익률"), (k) => k.includes("보통주")),
    payoutRatioPct: find((se) => se.includes("현금배당성향")),
    totalCashDividend: find((se) => se.includes("현금배당금총액")),
  };
}

async function fetchDividendYear(corpCode: string, bsnsYear: number): Promise<AlotMatterItem[] | null> {
  const url =
    `${DART_BASE_URL}/alotMatter.json?crtfc_key=${encodeURIComponent(getDartApiKey())}` +
    `&corp_code=${encodeURIComponent(corpCode)}&bsns_year=${bsnsYear}&reprt_code=${REPRT_CODE_ANNUAL}`;

  let body: { status: string; message?: string; list?: AlotMatterItem[] };
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (error) {
    await logDartCall("alotMatter", "error", { corpCode });
    console.warn(
      `  DART 배당 조회 실패(corp_code=${corpCode}, bsns_year=${bsnsYear}): ${
        error instanceof Error ? error.message : String(error)
      } — 건너뜁니다.`
    );
    return null;
  }

  if (body.status === DART_STATUS_NO_DATA) {
    await logDartCall("alotMatter", "success", { corpCode, dartStatusCode: body.status });
    return null;
  }
  if (body.status !== DART_STATUS_OK) {
    await logDartCall("alotMatter", "error", { corpCode, dartStatusCode: body.status });
    console.warn(`  DART 배당 조회 실패(corp_code=${corpCode}, bsns_year=${bsnsYear}, status=${body.status}) — 건너뜁니다.`);
    return null;
  }

  await logDartCall("alotMatter", "success", { corpCode, dartStatusCode: body.status });
  return body.list ?? [];
}

/** stocks 목록에 대해 최근 DIVIDEND_YEARS_TO_TRACK개년 배당 이력을 갱신한다. 재무제표와
 * 동일한 is_final 정책 — 확정된 연도는 다시 부르지 않는다. 다중회사 조회를 지원하지
 * 않는 API라 (종목 × 연도) 조합마다 개별 호출한다. */
export async function syncDividends(stocks: StockCorpPair[]): Promise<number> {
  if (stocks.length === 0) return 0;

  const targetYears = Array.from({ length: DIVIDEND_YEARS_TO_TRACK }, (_, i) => currentKstYear() - 1 - i);

  const { data: existingRows } = await supabaseAdmin
    .from("dart_dividends")
    .select("stock_code, year, is_final")
    .in(
      "stock_code",
      stocks.map((s) => s.stockCode)
    )
    .in("year", targetYears);

  const finalSet = new Set((existingRows ?? []).filter((r) => r.is_final).map((r) => `${r.stock_code}:${r.year}`));

  let updated = 0;

  for (const stock of stocks) {
    for (const year of targetYears) {
      if (finalSet.has(`${stock.stockCode}:${year}`)) continue;

      const items = await fetchDividendYear(stock.corpCode, year);
      await sleep(DART_CALL_INTERVAL_MS);
      if (!items) continue;

      const parsed = parseDividendItems(items);
      await supabaseAdmin.from("dart_dividends").upsert({
        stock_code: stock.stockCode,
        year,
        corp_code: stock.corpCode,
        cash_dividend_per_share_common: parsed.cashDividendPerShareCommon,
        cash_dividend_per_share_preferred: parsed.cashDividendPerSharePreferred,
        dividend_yield_pct: parsed.dividendYieldPct,
        payout_ratio_pct: parsed.payoutRatioPct,
        total_cash_dividend: parsed.totalCashDividend,
        raw: items,
        is_final: isFiscalYearFinal(year),
        fetched_at: new Date().toISOString(),
      });
      updated++;
    }
  }

  return updated;
}

export interface DividendYearRow {
  year: number;
  cashDividendPerShareCommon: number | null;
  dividendYieldPct: number | null;
  payoutRatioPct: number | null;
}

/** 캐싱된 배당 이력을 최근 연도부터 읽어온다. 새로 DART를 호출하지 않는다 — 가치평가
 * 지표 화면(대형주 전용 배치가 미리 채워둔 데이터)에서 그대로 표시하는 용도. */
export async function getDividendHistory(stockCode: string): Promise<DividendYearRow[]> {
  const { data: rows } = await supabaseAdmin
    .from("dart_dividends")
    .select("year, cash_dividend_per_share_common, dividend_yield_pct, payout_ratio_pct")
    .eq("stock_code", stockCode)
    .order("year", { ascending: false })
    .limit(DIVIDEND_YEARS_TO_TRACK);

  return (rows ?? []).map((r) => ({
    year: r.year,
    cashDividendPerShareCommon: r.cash_dividend_per_share_common,
    dividendYieldPct: r.dividend_yield_pct,
    payoutRatioPct: r.payout_ratio_pct,
  }));
}

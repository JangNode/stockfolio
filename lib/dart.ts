import "server-only";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

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

function getDartApiKey(): string {
  const key = process.env.DART_API_KEY;
  if (!key) throw new Error("DART_API_KEY 환경 변수가 설정되지 않았습니다.");
  return key;
}

function currentKstYear(): number {
  return Number(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }).slice(0, 4));
}

async function logDartCall(
  endpoint: "corpCode" | "fnlttSinglAcnt",
  status: "success" | "error",
  options: { corpCode?: string; dartStatusCode?: string } = {}
): Promise<void> {
  try {
    await supabaseAdmin.from("dart_api_call_log").insert({
      endpoint,
      corp_code: options.corpCode ?? null,
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

export interface FinancialStatementYear {
  year: number;
  revenue: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  totalAssets: number | null;
  totalLiabilities: number | null;
  totalEquity: number | null;
}

type MetricKey = Exclude<keyof FinancialStatementYear, "year">;

// fnlttSinglAcnt("단일회사 주요계정")는 전 종목 공통으로 정규화된 소수의 표준 계정만
// 돌려주는 API라(전체 XBRL 상세가 아님) account_nm이 대체로 고정돼 있지만, 실제 응답에서
// 확인된 적은 없는 값들이라(DART_API_KEY가 이 샌드박스엔 없어 라이브 호출로 검증 불가)
// 알려진 표기 변형 몇 가지를 함께 매칭해둔다. 실제 배포 후 응답을 보고 더 필요하면 추가한다.
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

interface FnlttSinglAcntItem {
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
  const cleaned = raw.replace(/[(),]/g, "").trim();
  const value = Number(cleaned);
  if (Number.isNaN(value)) return null;
  return negative ? -value : value;
}

function findMetricItem(items: FnlttSinglAcntItem[], metric: MetricKey): FnlttSinglAcntItem | null {
  const sjDivs = BALANCE_SHEET_METRICS.includes(metric) ? BALANCE_SHEET_SJ_DIV : INCOME_STATEMENT_SJ_DIV;
  const aliases = ACCOUNT_NAME_ALIASES[metric];
  const candidates = items.filter((item) => sjDivs.includes(item.sj_div) && aliases.includes(item.account_nm));

  // 연결재무제표(CFS)를 우선하고, 없으면 개별(OFS)로 폴백한다.
  return candidates.find((item) => item.fs_div === "CFS") ?? candidates.find((item) => item.fs_div === "OFS") ?? null;
}

/** DART에 사업보고서(연간)를 조회해 최근 3개년(당기/전기/전전기) 주요 재무 지표를 뽑는다.
 * 최신 연도에 사업보고서가 아직 없으면(신규상장 등) 연도를 낮춰가며 재시도한다. 끝까지
 * 못 찾으면 null. */
async function fetchAnnualFinancials(corpCode: string): Promise<FinancialStatementYear[] | null> {
  const startYear = currentKstYear() - 1;

  for (let attempt = 0; attempt < MAX_YEAR_LOOKBACK; attempt++) {
    const bsnsYear = startYear - attempt;
    const url =
      `${DART_BASE_URL}/fnlttSinglAcnt.json?crtfc_key=${encodeURIComponent(getDartApiKey())}` +
      `&corp_code=${encodeURIComponent(corpCode)}&bsns_year=${bsnsYear}&reprt_code=${REPRT_CODE_ANNUAL}`;

    const res = await fetch(url);
    if (!res.ok) {
      await logDartCall("fnlttSinglAcnt", "error", { corpCode });
      throw new Error(`DART fnlttSinglAcnt 호출 실패: HTTP ${res.status}`);
    }

    const body = await res.json();
    const status: string = body.status;

    if (status === DART_STATUS_NO_DATA) {
      await logDartCall("fnlttSinglAcnt", "success", { corpCode, dartStatusCode: status });
      continue; // 이 연도엔 아직 보고서가 없다 — 더 이전 연도로 재시도.
    }
    if (status !== DART_STATUS_OK) {
      await logDartCall("fnlttSinglAcnt", "error", { corpCode, dartStatusCode: status });
      throw new Error(`DART fnlttSinglAcnt 응답 오류(${status}): ${body.message ?? "알 수 없는 오류"}`);
    }

    await logDartCall("fnlttSinglAcnt", "success", { corpCode, dartStatusCode: status });

    const items: FnlttSinglAcntItem[] = body.list ?? [];
    const metrics = Object.keys(ACCOUNT_NAME_ALIASES) as MetricKey[];

    const byYear: Record<number, Partial<FinancialStatementYear>> = {
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

  return null;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 종목코드로 최근 3개년 재무제표를 가져온다. dart_financial_statements에 24시간 이내
 * 캐시가 있으면 그걸 그대로 쓰고, 없거나 오래됐으면 DART를 호출해 갱신한다. 이 종목이
 * DART corp_code 매핑에 없거나(비상장 등) 재무 데이터가 끝내 없으면 null을 반환한다
 * (에러를 던지지 않는다 — 호출부는 "데이터 없음"으로 자연스럽게 처리하면 된다). */
export async function getFinancialStatements(stockCode: string): Promise<FinancialStatementYear[] | null> {
  const { data: cached } = await supabaseAdmin
    .from("dart_financial_statements")
    .select("data, fetched_at")
    .eq("stock_code", stockCode)
    .maybeSingle();

  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < CACHE_TTL_MS) {
    return cached.data as FinancialStatementYear[];
  }

  const { data: corp } = await supabaseAdmin
    .from("dart_corp_codes")
    .select("corp_code")
    .eq("stock_code", stockCode)
    .maybeSingle();

  if (!corp) return null;

  const financials = await fetchAnnualFinancials(corp.corp_code);
  if (!financials) return null;

  const bsnsYear = String(financials[financials.length - 1].year);

  await supabaseAdmin.from("dart_financial_statements").upsert({
    stock_code: stockCode,
    corp_code: corp.corp_code,
    bsns_year: bsnsYear,
    reprt_code: REPRT_CODE_ANNUAL,
    data: financials,
    fetched_at: new Date().toISOString(),
  });

  return financials;
}

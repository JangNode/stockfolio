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
  endpoint: "corpCode" | "fnlttMultiAcnt" | "alotMatter",
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

/** 한 회사의 사업보고서 응답 항목들에서 최근 3개년(당기/전기/전전기) 주요 지표를 뽑는다. */
function extractFinancialYears(items: FnlttMultiAcntItem[], bsnsYear: number): FinancialStatementYear[] {
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

/** stocks 목록에 대해 다중회사 주요계정을 조회해 최근 3개년 재무제표를 갱신한다. 이미
 * 확정(is_final)된 최신 연도가 캐시에 있는 종목은 완전히 건너뛴다. 사업보고서가 아직
 * 안 나온 종목(신규상장 등)은 연도를 낮춰가며 재시도하되, 이미 응답을 받은 종목은
 * 다음 시도 대상에서 빠진다. */
export async function syncFinancialStatements(
  stocks: StockCorpPair[]
): Promise<{ updatedYears: number; maxSuccessfulChunkSize: number }> {
  if (stocks.length === 0) return { updatedYears: 0, maxSuccessfulChunkSize: 0 };

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

    for (const stock of remaining) {
      const items = byCorp.get(stock.corpCode);
      if (!items || items.length === 0) {
        stillMissing.push(stock);
        continue;
      }
      for (const y of extractFinancialYears(items, bsnsYear)) {
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
          is_final: isFiscalYearFinal(y.year),
          fetched_at: new Date().toISOString(),
        });
      }
    }

    if (rowsToUpsert.length > 0) {
      await supabaseAdmin
        .from("dart_financial_statement_years")
        .upsert(rowsToUpsert, { onConflict: "stock_code,year" });
      updatedYears += rowsToUpsert.length;
    }

    remaining = stillMissing;
  }

  return { updatedYears, maxSuccessfulChunkSize };
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
    .select("year, revenue, operating_income, net_income, total_assets, total_liabilities, total_equity")
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

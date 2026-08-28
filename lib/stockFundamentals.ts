import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getDailyPrice } from "@/lib/stockDailyPricesStorage";

/**
 * 백테스트/스크리닝이 과거 특정 날짜의 재무·배당 데이터를 "그 시점에 이미 알려져
 * 있던 것만" 가져오게 강제하는 유일한 통로. 어디서든 stock_annual_fundamentals/
 * stock_dividend_history를 직접 쿼리하지 말고 반드시 이 파일의 함수를 거쳐야 한다 —
 * 미래 데이터 누수는 백테스트 결과가 조용히 좋게만 나와서 나중에 알아차리기
 * 어렵기 때문에, 위반 시 값을 걸러내는 정도가 아니라 예외를 던져 즉시 드러나게 한다.
 *
 * point-in-time 규칙(rcept_date/pay_date <= 조회일) 자체는 아래 pickFundamentalsAsOf/
 * pickDividendsPaidAsOf 두 순수 함수에만 구현돼 있다. getFundamentalsAsOf/
 * getDividendsPaidAsOf(단건 조회)와 loadFundamentalsSeries(전체 이력 로드, 백테스트가
 * 날짜별로 반복 조회할 때 DB 왕복 없이 메모리에서 판정하는 용도)가 전부 이 두 함수를
 * 거치게 해, 규칙이 두 곳에서 따로 구현되며 벌어질 수 있는 불일치를 막는다.
 */

export interface StockFundamentalsAsOf {
  fiscalYear: number;
  rceptNo: string;
  rceptDate: string; // YYYY-MM-DD
  netIncomeParent: number | null;
  equityParent: number | null;
}

export interface StockDividendPayment {
  recordDate: string;
  cashDividendPerShare: number;
  payDate: string;
}

/** 한 종목의 공시된 연간 재무 전체 이력(rcept_date 오름차순)과 지급 완료 배당 전체
 * 이력(pay_date 오름차순)을 한 번에 로드한다. 백테스트가 여러 날짜에 대해 반복
 * 판정할 때 이 함수로 한 번만 불러온 뒤, 아래 pickFundamentalsAsOf/
 * pickDividendsPaidAsOf(순수 함수, DB 호출 없음)로 날짜별 point-in-time 판정을
 * 메모리 위에서 반복한다. */
export async function loadFundamentalsSeries(stockCode: string): Promise<FundamentalsSeries> {
  const [annualResult, dividendResult] = await Promise.all([
    supabaseAdmin
      .from("stock_annual_fundamentals")
      .select("fiscal_year, rcept_no, rcept_date, net_income_parent, equity_parent")
      .eq("stock_code", stockCode)
      .order("rcept_date", { ascending: true }),
    supabaseAdmin
      .from("stock_dividend_history")
      .select("record_date, cash_dividend_per_share, pay_date")
      .eq("stock_code", stockCode)
      .not("pay_date", "is", null)
      .order("pay_date", { ascending: true }),
  ]);

  if (annualResult.error) throw new Error(`${stockCode} 재무 이력 조회 실패: ${annualResult.error.message}`);
  if (dividendResult.error) throw new Error(`${stockCode} 배당 이력 조회 실패: ${dividendResult.error.message}`);

  return {
    annual: (annualResult.data ?? []).map((row) => ({
      fiscalYear: row.fiscal_year,
      rceptNo: row.rcept_no,
      rceptDate: row.rcept_date,
      netIncomeParent: row.net_income_parent === null ? null : Number(row.net_income_parent),
      equityParent: row.equity_parent === null ? null : Number(row.equity_parent),
    })),
    dividends: (dividendResult.data ?? []).map((row) => ({
      recordDate: row.record_date,
      cashDividendPerShare: Number(row.cash_dividend_per_share),
      payDate: row.pay_date as string,
    })),
  };
}

export interface FundamentalsSeries {
  annual: StockFundamentalsAsOf[]; // rcept_date 오름차순
  dividends: StockDividendPayment[]; // pay_date 오름차순
}

/** series.annual(rcept_date 오름차순)에서 asOfDate 시점에 이미 공개돼 있던 가장 최신
 * 재무를 순수 함수로 고른다(DB 호출 없음) — fiscal_year로 고르면 안 되는 이유는
 * stock_annual_fundamentals 테이블 코멘트 참고(회계연도와 실제 공개일 사이에 몇 달
 * 갭이 있어 fiscal_year 기준으로 고르면 미래 데이터가 샌다). */
export function pickFundamentalsAsOf(series: FundamentalsSeries, asOfDate: string): StockFundamentalsAsOf | null {
  let picked: StockFundamentalsAsOf | null = null;
  for (const row of series.annual) {
    if (row.rceptDate > asOfDate) break; // rcept_date 오름차순이므로 이후는 전부 미래 공시
    picked = row;
  }

  // 방어적 assertion — 위 루프 자체가 지켜주지만, 로직을 실수로 바꿔도(예: 정렬 기준을
  // fiscal_year로 잘못 고치는 등) 조용히 넘어가지 않고 즉시 터지게 한다.
  if (picked && picked.rceptDate > asOfDate) {
    throw new Error(`point-in-time 위반: ${picked.rceptDate} 접수 재무를 ${asOfDate} 시점 조회에서 반환하려 했습니다.`);
  }

  return picked;
}

/** series.dividends(pay_date 오름차순)에서 asOfDate 시점까지 이미 "지급 완료"된 배당만
 * 순수 함수로 고른다(DB 호출 없음). windowStartDate를 주면 그 이후 지급분만 좁혀서
 * "최근 N년 배당 이력" 판정에 바로 쓸 수 있다. 반환 순서는 pay_date 내림차순(기존
 * getDividendsPaidAsOf와 동일). */
export function pickDividendsPaidAsOf(
  series: FundamentalsSeries,
  asOfDate: string,
  windowStartDate?: string
): StockDividendPayment[] {
  const result: StockDividendPayment[] = [];
  for (const row of series.dividends) {
    if (row.payDate > asOfDate) break; // pay_date 오름차순이므로 이후는 전부 미지급/미래
    if (windowStartDate && row.payDate < windowStartDate) continue;
    result.push(row);
  }

  for (const row of result) {
    if (row.payDate > asOfDate) {
      throw new Error(`point-in-time 위반: ${row.payDate} 지급 배당을 ${asOfDate} 시점 조회에서 반환하려 했습니다.`);
    }
  }

  return result.reverse();
}

/** date(YYYY-MM-DD) 시점에 이미 공개돼 있던 가장 최신 확정 재무를 반환한다(단건 조회
 * 편의 함수 — loadFundamentalsSeries + pickFundamentalsAsOf를 감싼다). 여러 날짜를
 * 반복 조회할 계획이면(백테스트 등) loadFundamentalsSeries를 직접 한 번만 불러
 * pickFundamentalsAsOf를 재사용하는 편이 DB 왕복을 줄인다. */
export async function getFundamentalsAsOf(stockCode: string, date: string): Promise<StockFundamentalsAsOf | null> {
  const series = await loadFundamentalsSeries(stockCode);
  return pickFundamentalsAsOf(series, date);
}

/** date 시점까지 이미 "지급 완료"된 배당만 반환한다(단건 조회 편의 함수 —
 * loadFundamentalsSeries + pickDividendsPaidAsOf를 감싼다). */
export async function getDividendsPaidAsOf(
  stockCode: string,
  date: string,
  windowStartDate?: string
): Promise<StockDividendPayment[]> {
  const series = await loadFundamentalsSeries(stockCode);
  return pickDividendsPaidAsOf(series, date, windowStartDate);
}

export interface ValuationFromSeries {
  eps: number | null;
  bps: number | null;
  per: number | null;
  pbr: number | null;
}

/** 종가/상장주식수와 그 시점에 알 수 있었던 재무(pickFundamentalsAsOf로 미리 고른 것)를
 * 조합해 PER/PBR을 계산하는 순수 함수(DB 호출 없음). EPS/BPS가 0 이하(적자/자본잠식)면
 * PER/PBR도 null로 둔다 — 음수 배수는 의미가 없어 계산 단계에서부터 걸러낸다. */
export function computeValuationFromSeries(
  closePrice: number,
  listedShares: number,
  fundamentals: StockFundamentalsAsOf | null
): ValuationFromSeries {
  if (!fundamentals) return { eps: null, bps: null, per: null, pbr: null };

  const eps =
    fundamentals.netIncomeParent !== null && listedShares > 0
      ? fundamentals.netIncomeParent / listedShares
      : null;
  const bps =
    fundamentals.equityParent !== null && listedShares > 0 ? fundamentals.equityParent / listedShares : null;

  return {
    eps,
    bps,
    per: eps !== null && eps > 0 ? closePrice / eps : null,
    pbr: bps !== null && bps > 0 ? closePrice / bps : null,
  };
}

export interface StockValuationAsOf {
  closePrice: number;
  marketCapEok: number;
  listedShares: number;
  eps: number | null;
  bps: number | null;
  per: number | null;
  pbr: number | null;
  fundamentalsRceptDate: string;
}

/** date 시점 종가/시가총액과 그 시점에 알 수 있었던 재무를 조합해 PER/PBR을 계산한다.
 * 그날 시세가 없거나(비영업일 등) 그 시점까지 공개된 재무가 아예 없으면(신규상장 직후
 * 등) null. */
export async function computeValuationAsOf(stockCode: string, date: string): Promise<StockValuationAsOf | null> {
  const [priceRow, fundamentals] = await Promise.all([
    getDailyPrice(stockCode, date),
    getFundamentalsAsOf(stockCode, date),
  ]);

  if (!priceRow || !fundamentals) return null;

  const { eps, bps, per, pbr } = computeValuationFromSeries(priceRow.closePrice, priceRow.listedShares, fundamentals);

  return {
    closePrice: priceRow.closePrice,
    marketCapEok: priceRow.marketCapEok,
    listedShares: priceRow.listedShares,
    eps,
    bps,
    per,
    pbr,
    fundamentalsRceptDate: fundamentals.rceptDate,
  };
}

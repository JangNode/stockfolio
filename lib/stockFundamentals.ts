import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getDailyPrice, getDailyPriceOnOrBefore } from "@/lib/stockDailyPricesStorage";
import {
  pickFundamentalsAsOf,
  pickDividendsPaidAsOf,
  computeValuationFromSeries,
  type FundamentalsSeries,
  type StockFundamentalsAsOf,
  type StockDividendPayment,
} from "@/lib/pointInTimeFundamentals";
import { selectEpsCagrFiscalYears, computeEpsCagr, type ListedSharesByFiscalYear } from "@/lib/pegRatio";
import { PEG_GROWTH_LOOKBACK_YEARS } from "@/lib/pegConfig";

export type {
  FundamentalsSeries,
  StockFundamentalsAsOf,
  StockDividendPayment,
  ValuationFromSeries,
} from "@/lib/pointInTimeFundamentals";
export { pickFundamentalsAsOf, pickDividendsPaidAsOf, computeValuationFromSeries } from "@/lib/pointInTimeFundamentals";

/**
 * 백테스트/스크리닝이 과거 특정 날짜의 재무·배당 데이터를 "그 시점에 이미 알려져
 * 있던 것만" 가져오게 강제하는 유일한 통로. 어디서든 stock_annual_fundamentals/
 * stock_dividend_history를 직접 쿼리하지 말고 반드시 이 파일의 함수를 거쳐야 한다 —
 * 미래 데이터 누수는 백테스트 결과가 조용히 좋게만 나와서 나중에 알아차리기
 * 어렵기 때문에, 위반 시 값을 걸러내는 정도가 아니라 예외를 던져 즉시 드러나게 한다.
 *
 * point-in-time 규칙(rcept_date/pay_date <= 조회일) 자체는 lib/pointInTimeFundamentals.ts의
 * pickFundamentalsAsOf/pickDividendsPaidAsOf 두 순수 함수에만 구현돼 있다(그 파일이 server-only가
 * 아닌 이유는 그 파일 코멘트 참고 — lib/backtest.ts가 클라이언트 컴포넌트에서도 쓰이기
 * 때문). 아래 getFundamentalsAsOf/getDividendsPaidAsOf(단건 조회)와 loadFundamentalsSeries
 * (전체 이력 로드, 백테스트가 날짜별로 반복 조회할 때 DB 왕복 없이 메모리에서 판정하는
 * 용도)가 전부 이 두 함수를 거치게 해, 규칙이 두 곳에서 따로 구현되며 벌어질 수 있는
 * 불일치를 막는다.
 */

/** 한 종목의 공시된 연간 재무 전체 이력(rcept_date 오름차순)과 지급 완료 배당 전체
 * 이력(pay_date 오름차순)을 한 번에 로드한다. 백테스트가 여러 날짜에 대해 반복
 * 판정할 때 이 함수로 한 번만 불러온 뒤, lib/pointInTimeFundamentals.ts의
 * pickFundamentalsAsOf/pickDividendsPaidAsOf(순수 함수, DB 호출 없음)로 날짜별
 * point-in-time 판정을 메모리 위에서 반복한다. */
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

export interface EpsCagrAsOf {
  growthPct: number | null; // 계산 불가(적자/역성장/데이터 부족)면 null
  startFiscalYear: number;
  endFiscalYear: number;
}

/** date 시점 기준 최근 years년 EPS CAGR(%)을 계산한다(PEG 지표의 분모). EPS는 각
 * 회계연도 지배주주순이익 ÷ 그 회계연도 공시 시점(rcept_date) 상장주식수로 구한다 —
 * 공시일이 비영업일이면 그 이전 가장 가까운 거래일 상장주식수를 쓴다
 * (getDailyPriceOnOrBefore). 시작/끝 연도 중 하나라도 공시가 없거나(백필 공백,
 * 상장 초기 등) 계산 자체가 불가하면(적자, 역성장 등) null. */
export async function computeEpsCagrAsOf(
  stockCode: string,
  date: string,
  years: number = PEG_GROWTH_LOOKBACK_YEARS
): Promise<EpsCagrAsOf | null> {
  const series = await loadFundamentalsSeries(stockCode);
  const pair = selectEpsCagrFiscalYears(series, date, years);
  if (!pair) return null;

  const [startPrice, endPrice] = await Promise.all([
    getDailyPriceOnOrBefore(stockCode, pair.start.rceptDate),
    getDailyPriceOnOrBefore(stockCode, pair.end.rceptDate),
  ]);

  const growthPct = computeEpsCagr(
    { netIncomeParent: pair.start.netIncomeParent, listedShares: startPrice?.listedShares ?? null },
    { netIncomeParent: pair.end.netIncomeParent, listedShares: endPrice?.listedShares ?? null },
    years
  );

  return { growthPct, startFiscalYear: pair.start.fiscalYear, endFiscalYear: pair.end.fiscalYear };
}

/** annual 이력의 각 회계연도 공시 시점(rcept_date) 상장주식수를 전부 미리 조회해
 * 함께 반환한다(공시일이 비영업일이면 그 이전 가장 가까운 거래일 값). 백테스트/
 * 스크리닝처럼 여러 날짜에 대해 반복 판정할 때, 이 함수로 종목당 한 번만 불러온 뒤
 * lib/pegRatio.ts의 computeEpsCagrPure(순수 함수, DB 호출 없음)로 날짜별 EPS CAGR을
 * 반복 계산한다 — computeEpsCagrAsOf(단건 조회)처럼 필요한 두 연도만 조회하는 것보다
 * 호출이 더 들지만(연도 수만큼), 같은 종목을 여러 날짜에 반복 조회할 때는 이쪽이
 * DB 왕복을 줄인다. */
export async function loadFundamentalsSeriesWithListedShares(
  stockCode: string
): Promise<{ series: FundamentalsSeries; listedSharesByFiscalYear: ListedSharesByFiscalYear }> {
  const series = await loadFundamentalsSeries(stockCode);
  const entries = await Promise.all(
    series.annual.map(async (row) => {
      const priceRow = await getDailyPriceOnOrBefore(stockCode, row.rceptDate);
      return [row.fiscalYear, priceRow?.listedShares ?? null] as const;
    })
  );
  return { series, listedSharesByFiscalYear: new Map(entries) };
}

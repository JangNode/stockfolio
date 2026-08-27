import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getDailyPrice } from "@/lib/dhDailyPricesStorage";

/**
 * DH전략(대형 배당·가치주) 백테스트/스크리닝이 과거 특정 날짜의 재무·배당 데이터를
 * "그 시점에 이미 알려져 있던 것만" 가져오게 강제하는 유일한 통로. 백테스트/스크리닝
 * 어디서든 dh_annual_fundamentals/dh_dividend_history를 직접 쿼리하지 말고 반드시
 * 이 파일의 함수를 거쳐야 한다 — 미래 데이터 누수는 백테스트 결과가 조용히 좋게만
 * 나와서 나중에 알아차리기 어렵기 때문에, 위반 시 값을 걸러내는 정도가 아니라
 * 예외를 던져 즉시 드러나게 한다.
 */

export interface DhFundamentalsAsOf {
  fiscalYear: number;
  rceptNo: string;
  rceptDate: string; // YYYY-MM-DD
  netIncomeParent: number | null;
  equityParent: number | null;
}

/** date(YYYY-MM-DD) 시점에 이미 공개돼 있던 가장 최신 확정 재무를 반환한다.
 * rcept_date(접수일자)가 date보다 미래인 행은 절대 고르지 않는다 — fiscal_year로
 * 정렬/필터하면 안 되는 이유는 dh_annual_fundamentals 테이블 코멘트 참고(FY2022
 * 보고서가 2023-03-07에야 공개된 것처럼, 회계연도와 실제 공개일 사이에 몇 달 갭이
 * 있어서 fiscal_year 기준으로 고르면 미래 데이터가 샌다). */
export async function getFundamentalsAsOf(stockCode: string, date: string): Promise<DhFundamentalsAsOf | null> {
  const { data, error } = await supabaseAdmin
    .from("dh_annual_fundamentals")
    .select("fiscal_year, rcept_no, rcept_date, net_income_parent, equity_parent")
    .eq("stock_code", stockCode)
    .lte("rcept_date", date)
    .order("rcept_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`${stockCode} 재무 데이터 조회 실패: ${error.message}`);
  if (!data) return null;

  // 방어적 assertion — .lte() 자체가 지켜주지만, 쿼리 로직을 실수로 바꿔도(예: 정렬
  // 기준을 fiscal_year로 잘못 고치는 등) 조용히 넘어가지 않고 즉시 터지게 한다.
  if (data.rcept_date > date) {
    throw new Error(
      `point-in-time 위반: ${stockCode}의 ${data.rcept_date} 접수 재무를 ${date} 시점 조회에서 반환하려 했습니다.`
    );
  }

  return {
    fiscalYear: data.fiscal_year,
    rceptNo: data.rcept_no,
    rceptDate: data.rcept_date,
    netIncomeParent: data.net_income_parent === null ? null : Number(data.net_income_parent),
    equityParent: data.equity_parent === null ? null : Number(data.equity_parent),
  };
}

export interface DhDividendPayment {
  recordDate: string;
  cashDividendPerShare: number;
  payDate: string;
}

/** date 시점까지 이미 "지급 완료"된 배당만 반환한다(pay_date <= date). 아직 지급
 * 전인 예정 배당은 제외한다 — 기존 가치평가지표 카드(app/api/stock/[code]/valuation)와
 * 동일한 규칙. windowStartDate를 주면 그 이후 지급분만 좁혀서 "최근 N년 배당 이력"
 * 판정에 바로 쓸 수 있다. */
export async function getDividendsPaidAsOf(
  stockCode: string,
  date: string,
  windowStartDate?: string
): Promise<DhDividendPayment[]> {
  let query = supabaseAdmin
    .from("dh_dividend_history")
    .select("record_date, cash_dividend_per_share, pay_date")
    .eq("stock_code", stockCode)
    .not("pay_date", "is", null)
    .lte("pay_date", date);

  if (windowStartDate) {
    query = query.gte("pay_date", windowStartDate);
  }

  const { data, error } = await query.order("pay_date", { ascending: false });
  if (error) throw new Error(`${stockCode} 배당 이력 조회 실패: ${error.message}`);

  for (const row of data ?? []) {
    if (row.pay_date !== null && row.pay_date > date) {
      throw new Error(
        `point-in-time 위반: ${stockCode}의 ${row.pay_date} 지급 배당을 ${date} 시점 조회에서 반환하려 했습니다.`
      );
    }
  }

  return (data ?? []).map((row) => ({
    recordDate: row.record_date,
    cashDividendPerShare: Number(row.cash_dividend_per_share),
    payDate: row.pay_date as string,
  }));
}

export interface DhValuationAsOf {
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
 * 등) null. EPS/BPS가 0 이하(적자/자본잠식)면 PER/PBR도 null로 둔다 — 음수 배수는
 * 의미가 없어 계산 단계에서부터 걸러낸다. */
export async function computeValuationAsOf(stockCode: string, date: string): Promise<DhValuationAsOf | null> {
  const [priceRow, fundamentals] = await Promise.all([
    getDailyPrice(stockCode, date),
    getFundamentalsAsOf(stockCode, date),
  ]);

  if (!priceRow || !fundamentals) return null;

  const closePrice = priceRow.closePrice;
  const listedShares = priceRow.listedShares;
  const eps =
    fundamentals.netIncomeParent !== null && listedShares > 0
      ? fundamentals.netIncomeParent / listedShares
      : null;
  const bps =
    fundamentals.equityParent !== null && listedShares > 0 ? fundamentals.equityParent / listedShares : null;

  return {
    closePrice,
    marketCapEok: priceRow.marketCapEok,
    listedShares,
    eps,
    bps,
    per: eps !== null && eps > 0 ? closePrice / eps : null,
    pbr: bps !== null && bps > 0 ? closePrice / bps : null,
    fundamentalsRceptDate: fundamentals.rceptDate,
  };
}

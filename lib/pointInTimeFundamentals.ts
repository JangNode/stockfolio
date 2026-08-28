/**
 * point-in-time 재무/배당 판정의 순수 계산부(DB 호출 없음, "server-only" 아님).
 * lib/stockFundamentals.ts(server-only, Supabase 조회 담당)와 분리한 이유는
 * lib/backtest.ts가 클라이언트 컴포넌트(components/Backtest.tsx)에서도 그대로
 * import되기 때문이다 — server-only 패키지를 문 표시로 쓰는 모듈을 클라이언트
 * 번들에 섞으면 빌드가 깨진다. 이 파일은 순수 함수만 담아 양쪽에서 안전하게
 * 재사용한다.
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

export interface FundamentalsSeries {
  annual: StockFundamentalsAsOf[]; // rcept_date 오름차순
  dividends: StockDividendPayment[]; // pay_date 오름차순
}

/** series.annual(rcept_date 오름차순)에서 asOfDate 시점에 이미 공개돼 있던 가장 최신
 * 재무를 순수 함수로 고른다 — fiscal_year로 고르면 안 되는 이유는
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

/** series.annual(rcept_date 오름차순)에서 asOfDate 시점에 이미 공개돼 있던 재무를
 * 전부(연도 오름차순) 고른다 — pickFundamentalsAsOf는 그중 최신 1건만 반환하는 반면,
 * EPS 성장률(CAGR)처럼 여러 연도가 동시에 필요한 계산에 쓴다. */
export function pickFundamentalsVisibleAsOf(series: FundamentalsSeries, asOfDate: string): StockFundamentalsAsOf[] {
  const result = series.annual.filter((row) => row.rceptDate <= asOfDate);

  if (result.some((row) => row.rceptDate > asOfDate)) {
    throw new Error(`point-in-time 위반: ${asOfDate} 시점 조회에서 미래 공시 재무가 섞여 있습니다.`);
  }

  return result;
}

/** series.dividends(pay_date 오름차순)에서 asOfDate 시점까지 이미 "지급 완료"된 배당만
 * 순수 함수로 고른다. windowStartDate를 주면 그 이후 지급분만 좁혀서 "최근 N년 배당
 * 이력" 판정에 바로 쓸 수 있다. 반환 순서는 pay_date 내림차순. */
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

export interface ValuationFromSeries {
  eps: number | null;
  bps: number | null;
  per: number | null;
  pbr: number | null;
}

/** 종가/상장주식수와 그 시점에 알 수 있었던 재무(pickFundamentalsAsOf로 미리 고른 것)를
 * 조합해 PER/PBR을 계산한다. EPS/BPS가 0 이하(적자/자본잠식)면 PER/PBR도 null로 둔다 —
 * 음수 배수는 의미가 없어 계산 단계에서부터 걸러낸다. */
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

/**
 * 종목 베타(시장 대비 변동성) 순수 계산부(DB 접근 없음) — 적정주가 RIM(잔여이익모델)의
 * CAPM 요구수익률(lib/capm.ts)에 쓴다. 종목/지수 각각의 일별수익률(전일대비%)을
 * 독립적으로 계산한 뒤, 날짜가 겹치는 구간만 정렬 매칭해 OLS 기울기(베타 = 지수
 * 수익률에 대한 종목 수익률의 회귀계수)를 구한다.
 */

export interface PricePoint {
  tradeDate: string; // YYYY-MM-DD
  closePrice: number;
}

export interface BetaRegressionResult {
  beta: number;
  dataPoints: number;
}

/** 오름차순 정렬된 가격 시계열에서 날짜별 전일대비 수익률(비율, %아님)을 계산한다. */
function toDailyReturns(prices: PricePoint[]): Map<string, number> {
  const sorted = [...prices].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const returns = new Map<string, number>();
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].closePrice;
    const curr = sorted[i].closePrice;
    if (prev > 0) returns.set(sorted[i].tradeDate, curr / prev - 1);
  }
  return returns;
}

/** stockPrices/indexPrices 각각의 일별수익률을 날짜 교집합으로 매칭해 OLS 기울기
 * (베타)를 구한다. 교집합 표본 수가 minDataPoints 미만이면 산출 불가로 보고 null을
 * 반환한다. */
export function computeBetaFromPrices(
  stockPrices: PricePoint[],
  indexPrices: PricePoint[],
  minDataPoints: number
): BetaRegressionResult | null {
  const stockReturns = toDailyReturns(stockPrices);
  const indexReturns = toDailyReturns(indexPrices);

  const stockValues: number[] = [];
  const indexValues: number[] = [];
  for (const [date, stockReturn] of stockReturns) {
    const indexReturn = indexReturns.get(date);
    if (indexReturn === undefined) continue;
    stockValues.push(stockReturn);
    indexValues.push(indexReturn);
  }

  const dataPoints = stockValues.length;
  if (dataPoints < minDataPoints) return null;

  const indexMean = indexValues.reduce((sum, v) => sum + v, 0) / dataPoints;
  const stockMean = stockValues.reduce((sum, v) => sum + v, 0) / dataPoints;

  let covariance = 0;
  let indexVariance = 0;
  for (let i = 0; i < dataPoints; i++) {
    const indexDiff = indexValues[i] - indexMean;
    covariance += (stockValues[i] - stockMean) * indexDiff;
    indexVariance += indexDiff * indexDiff;
  }

  if (indexVariance === 0) return null; // 지수가 전 구간 동일값이면 회귀 불가

  return { beta: covariance / indexVariance, dataPoints };
}

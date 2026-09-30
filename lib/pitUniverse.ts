import type { StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";

/**
 * 시점별(point-in-time) 유니버스 계산용 순수 함수. 장기 백테스트 배치와 벤치마크가 같은
 * 유동성 기준을 공유한다(lib/strategyBacktestSummaryConfig.ts의 PIT_* 상수 참고).
 */

/** 그날 거래대금(원). 2015~2022 기존 행은 trading_value가 0으로 남아 있어(재백필이 기존 행을
 * 보존함) 그 경우 종가×거래량으로 대체한다. */
export function tradingValueWon(row: Pick<StockDailyPriceRow, "tradingValue" | "closePrice" | "volume">): number {
  return row.tradingValue > 0 ? row.tradingValue : row.closePrice * row.volume;
}

/** rows(tradeDate 오름차순)의 각 행에 대해 "직전 lookback개 행(당일 제외)"의 평균 거래대금을
 * 돌려준다. 직전 행이 lookback개 미만이면 NaN(신규 상장 직후 — 비교 시 항상 false). 거래정지로
 * 저장 안 된 날은 행이 없으므로 "직전 20거래일"은 그 종목의 직전 20개 행이다. */
export function computeTrailingAvgTradingValue(rows: StockDailyPriceRow[], lookback: number): Float64Array {
  const out = new Float64Array(rows.length).fill(NaN);
  let windowSum = 0;
  for (let i = 0; i < rows.length; i++) {
    if (i >= lookback) out[i] = windowSum / lookback;
    windowSum += tradingValueWon(rows[i]);
    if (i >= lookback) windowSum -= tradingValueWon(rows[i - lookback]);
  }
  return out;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** date 이전(포함) 가장 가까운 행의 상장주식수. maxLookbackDays일보다 오래 전 행이면 null
 * (lib/stockDailyPricesStorage.ts의 getDailyPriceOnOrBefore와 같은 규칙, hot 표 미사용). */
export function pickListedSharesOnOrBefore(
  rows: StockDailyPriceRow[],
  date: string,
  maxLookbackDays: number
): number | null {
  let lo = 0;
  let hi = rows.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].tradeDate <= date) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return null;
  const gapDays = (Date.parse(date + "T00:00:00Z") - Date.parse(rows[found].tradeDate + "T00:00:00Z")) / MS_PER_DAY;
  return gapDays <= maxLookbackDays ? rows[found].listedShares : null;
}

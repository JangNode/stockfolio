import type { StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import {
  MARKET_CAP_CONTINUITY_LOWER,
  MARKET_CAP_CONTINUITY_UPPER,
  PRICE_JUMP_RATIO_LOWER,
  PRICE_JUMP_RATIO_UPPER,
  SHARES_CHANGE_MIN_RATIO,
  SHARES_LOOKAHEAD_ROWS,
  VOLUME_AGREE_MIN_RATIO,
} from "@/lib/priceAdjustmentConfig";

/** 분할·병합 조정 순수 함수(탐지 + 배치용 시세 조정). DB 접근 없음. */

export type AdjustmentStatus = "applied" | "low_confidence";

export interface DetectedAdjustmentEvent {
  stockCode: string;
  /** 새 기준 첫 거래일(이 날짜 이전 가격에 adjustmentFactor를 곱하면 연속이 된다). */
  eventDate: string;
  priceRatio: number;
  sharesRatio: number;
  volumeRatio: number;
  /** = 1 / sharesRatio. 분할(2:1)이면 0.5 — 이벤트 이전 가격에 곱한다. */
  adjustmentFactor: number;
  status: AdjustmentStatus;
  lowConfidenceReason: string | null;
}

/** rows(tradeDate 오름차순, 한 종목)에서 분할·병합 후보를 찾아 신뢰도를 판정한다. */
export function detectAdjustmentEvents(rows: StockDailyPriceRow[], scanFromDate: string): DetectedAdjustmentEvent[] {
  const events: DetectedAdjustmentEvent[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (cur.tradeDate < scanFromDate) continue;
    if (!(prev.closePrice > 0) || !(cur.closePrice > 0)) continue;

    const priceRatio = cur.closePrice / prev.closePrice;
    if (priceRatio > PRICE_JUMP_RATIO_LOWER && priceRatio < PRICE_JUMP_RATIO_UPPER) continue;

    let sharesRatio = 1;
    if (prev.listedShares > 0) {
      const end = Math.min(rows.length - 1, i + SHARES_LOOKAHEAD_ROWS - 1);
      for (let k = i; k <= end; k++) {
        const ratio = rows[k].listedShares / prev.listedShares;
        if (Math.abs(Math.log(ratio)) > Math.abs(Math.log(sharesRatio))) sharesRatio = ratio;
      }
    }
    const volumeRatio = prev.volume > 0 ? cur.volume / prev.volume : NaN;

    const sharesChanged = sharesRatio >= SHARES_CHANGE_MIN_RATIO || sharesRatio <= 1 / SHARES_CHANGE_MIN_RATIO;
    const marketCapRatio = priceRatio * sharesRatio;
    const marketCapContinuous =
      marketCapRatio >= MARKET_CAP_CONTINUITY_LOWER && marketCapRatio <= MARKET_CAP_CONTINUITY_UPPER;
    const volumeAgrees =
      sharesRatio > 1 ? volumeRatio >= VOLUME_AGREE_MIN_RATIO : volumeRatio <= 1 / VOLUME_AGREE_MIN_RATIO;

    let lowConfidenceReason: string | null = null;
    if (!sharesChanged) lowConfidenceReason = "shares_unchanged";
    else if (!marketCapContinuous) lowConfidenceReason = "market_cap_discontinuity";
    else if (!volumeAgrees) lowConfidenceReason = "volume_disagrees";

    events.push({
      stockCode: cur.stockCode,
      eventDate: cur.tradeDate,
      priceRatio,
      sharesRatio,
      volumeRatio: Number.isFinite(volumeRatio) ? volumeRatio : 0,
      adjustmentFactor: 1 / sharesRatio,
      status: lowConfidenceReason === null ? "applied" : "low_confidence",
      lowConfidenceReason,
    });
  }
  return events;
}

export interface AppliedAdjustment {
  eventDate: string;
  factor: number;
}

/** rows(tradeDate 오름차순)를 최신 기준으로 제자리 조정한다: 이벤트 이전 행의 가격(시가/고가/
 * 저가/종가)에 누적 계수를 곱하고, 거래량과 상장주식수에는 그 역수를 곱한다(시가총액·거래대금은
 * 그대로). adjustments는 eventDate 오름차순. */
export function applyAdjustmentsInPlace(rows: StockDailyPriceRow[], adjustments: AppliedAdjustment[]): void {
  if (adjustments.length === 0) return;
  const cumulativeFrom: number[] = new Array(adjustments.length + 1).fill(1);
  for (let k = adjustments.length - 1; k >= 0; k--) cumulativeFrom[k] = cumulativeFrom[k + 1] * adjustments[k].factor;

  let k = 0;
  for (const row of rows) {
    while (k < adjustments.length && adjustments[k].eventDate <= row.tradeDate) k++;
    const factor = cumulativeFrom[k];
    if (factor === 1) continue;
    row.openPrice *= factor;
    row.highPrice *= factor;
    row.lowPrice *= factor;
    row.closePrice *= factor;
    row.volume /= factor;
    row.listedShares /= factor;
  }
}

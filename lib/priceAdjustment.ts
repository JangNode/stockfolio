import type { StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import {
  MARKET_CAP_CONTINUITY_LOWER,
  MARKET_CAP_CONTINUITY_UPPER,
  PRICE_JUMP_RATIO_LOWER,
  PRICE_JUMP_RATIO_UPPER,
  SHARES_CHANGE_MIN_RATIO,
  SHARES_LOOKAHEAD_ROWS,
  HALT_MIN_MISSING_TRADING_DAYS,
  ADJUSTMENT_SNAP_RATIOS,
  ADJUSTMENT_SNAP_TOLERANCE,
  HOLD_FOLLOW_TRADING_ROWS,
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
  /** 보류(post_ratio_out_of_range)된 이벤트만 채우는 점검용 지표. */
  holdMetrics?: HoldMetrics;
}

export interface HoldMetrics {
  /** (직전 종가 × 계수) / 이벤트일 종가. */
  postRatio: number;
  /** 직전 행과 이벤트일 사이에 빠진 거래일 수(거래정지 일수). */
  haltTradingDays: number | null;
  /** 보정 후 이벤트일 등락률(%) = 이벤트일 종가 / (직전 종가 × 계수) − 1. */
  resumeChangePct: number;
  /** 이벤트일 종가 대비 N번째 후속 거래일 종가 등락률(%) — 후속 행이 부족하면 null. */
  followChangePct: number | null;
}

/** 전 종목 시세의 거래일 합집합 캘린더(날짜 → 순번). 거래정지 직후 판정에 쓴다. */
export function buildTradingDayIndex(seriesByCode: Map<string, StockDailyPriceRow[]>): Map<string, number> {
  const dates = new Set<string>();
  for (const rows of seriesByCode.values()) for (const row of rows) dates.add(row.tradeDate);
  return new Map(Array.from(dates).sort().map((d, i) => [d, i]));
}

/** 주식수비가 대표 비율(또는 역수) 중 하나에 허용 오차 이내면 그 값으로, 아니면 그대로 돌려준다. */
export function snapSharesRatio(ratio: number): number {
  for (const target of ADJUSTMENT_SNAP_RATIOS) {
    if (Math.abs(ratio / target - 1) <= ADJUSTMENT_SNAP_TOLERANCE) return target;
    if (Math.abs(ratio * target - 1) <= ADJUSTMENT_SNAP_TOLERANCE) return 1 / target;
  }
  return ratio;
}

/** rows(tradeDate 오름차순, 한 종목)에서 분할·병합 후보를 찾아 신뢰도를 판정한다.
 * tradingDayIndex(buildTradingDayIndex)를 주면 거래정지 직후 이벤트의 거래량 검증을 생략한다. */
export function detectAdjustmentEvents(
  rows: StockDailyPriceRow[],
  scanFromDate: string,
  tradingDayIndex?: Map<string, number>
): DetectedAdjustmentEvent[] {
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

    const prevIdx = tradingDayIndex?.get(prev.tradeDate);
    const curIdx = tradingDayIndex?.get(cur.tradeDate);
    // 거래정지 직후: 사이에 빠진 거래일이 있거나(Parquet/hot 표는 거래정지일 행을 저장하지 않는다), 직전 행의
    // 거래량이 0(KRX 원본은 거래정지 종목을 거래량 0으로 내려준다 — 일일 증분 스캔이 쓴다)이면 해당.
    const afterHalt =
      (prevIdx !== undefined && curIdx !== undefined && curIdx - prevIdx - 1 >= HALT_MIN_MISSING_TRADING_DAYS) ||
      prev.volume === 0;

    let lowConfidenceReason: string | null = null;
    if (!sharesChanged) lowConfidenceReason = "shares_unchanged";
    else if (!marketCapContinuous) lowConfidenceReason = "market_cap_discontinuity";
    else if (!volumeAgrees && !afterHalt) lowConfidenceReason = "volume_disagrees";

    events.push({
      stockCode: cur.stockCode,
      eventDate: cur.tradeDate,
      priceRatio,
      sharesRatio,
      volumeRatio: Number.isFinite(volumeRatio) ? volumeRatio : 0,
      adjustmentFactor: 1 / snapSharesRatio(sharesRatio),
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

/** 이벤트의 보정 후 전후 종가 비율 = (직전 종가 × 계수) / 이벤트일 종가. 직전/당일 행이 없으면 null. */
export function computePostRatio(rows: StockDailyPriceRow[], eventDate: string, factor: number): number | null {
  const i = rows.findIndex((r) => r.tradeDate === eventDate);
  if (i < 1 || !(rows[i].closePrice > 0)) return null;
  return (rows[i - 1].closePrice * factor) / rows[i].closePrice;
}

/** 보류 이벤트 점검용 지표(거래정지 일수, 재개일 등락률, 후속 거래일 등락). */
export function computeHoldMetrics(
  rows: StockDailyPriceRow[],
  eventDate: string,
  factor: number,
  tradingDayIndex: Map<string, number>
): HoldMetrics | null {
  const i = rows.findIndex((r) => r.tradeDate === eventDate);
  const postRatio = computePostRatio(rows, eventDate, factor);
  if (i < 1 || postRatio === null) return null;
  const prevIdx = tradingDayIndex.get(rows[i - 1].tradeDate);
  const curIdx = tradingDayIndex.get(eventDate);
  const follow = rows[i + HOLD_FOLLOW_TRADING_ROWS];
  return {
    postRatio,
    haltTradingDays: prevIdx !== undefined && curIdx !== undefined ? curIdx - prevIdx - 1 : null,
    resumeChangePct: (1 / postRatio - 1) * 100,
    followChangePct: follow && rows[i].closePrice > 0 ? (follow.closePrice / rows[i].closePrice - 1) * 100 : null,
  };
}

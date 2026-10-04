import type { AppliedAdjustment } from "@/lib/priceAdjustment";
import {
  DAILY_PRICE_LIMIT_RATIO,
  DAILY_PRICE_LIMIT_RATIO_BEFORE_CHANGE,
  PRICE_LIMIT_CHANGE_DATE,
} from "@/lib/priceAdjustmentConfig";

/**
 * 액면분할·병합 방어 공통 모듈(순수 함수, DB 접근 없음). 저장된 진입가·평단가·수량은 원본(원가) 그대로 두고,
 * 조회/계산 시점에 조정계수를 곱해 보정한다(멱등). 조정계수는 stock_price_adjustment_events의
 * status='applied' 이벤트(lib/priceAdjustment.ts와 같은 정의: 이벤트일 이전 가격 × 계수 = 이벤트 이후와 연속).
 */

/** fromDate(포함 안 함)~toDate(포함) 사이에 걸린 이벤트의 조정계수 누적곱. 이벤트가 없으면 1. */
export function getCumulativeFactor(
  stockCode: string,
  fromDate: string,
  toDate: string,
  adjustmentsByCode: Map<string, AppliedAdjustment[]>
): number {
  let factor = 1;
  for (const a of adjustmentsByCode.get(stockCode) ?? []) {
    if (a.eventDate > fromDate && a.eventDate <= toDate) factor *= a.factor;
  }
  return factor;
}

/** 조정 가격 = 원가 × 계수(진입가·평단가·손절가·익절가에 쓴다). */
export function adjustPrice(rawPrice: number, factor: number): number {
  return rawPrice * factor;
}

/** 조정 수량 = 수량 ÷ 계수(분할이면 늘고 병합이면 준다). */
export function adjustQuantity(rawQuantity: number, factor: number): number {
  return rawQuantity / factor;
}

/** 안내 문구용 설명: 계수 10 → "10:1 병합", 계수 0.2 → "5:1 분할". */
export function describeFactor(factor: number): string {
  if (factor === 1) return "조정 없음";
  const ratio = factor > 1 ? factor : 1 / factor;
  const text = Math.abs(ratio - Math.round(ratio)) < 0.01 ? String(Math.round(ratio)) : ratio.toFixed(2);
  return `${text}:1 ${factor > 1 ? "병합" : "분할"}`;
}

/** 두 날짜(YYYY-MM-DD) 사이의 평일 수(from 제외, to 포함, 최소 1). 휴장일은 몰라 실제보다 많게 잡힐 수 있다 —
 * 이상 판정 허용폭을 넓히는 쪽(안전한 쪽)이다. */
export function weekdaysBetween(fromDate: string, toDate: string): number {
  const end = new Date(toDate + "T00:00:00Z").getTime();
  let count = 0;
  for (let t = new Date(fromDate + "T00:00:00Z").getTime() + 86_400_000; t <= end; t += 86_400_000) {
    const day = new Date(t).getUTCDay();
    if (day !== 0 && day !== 6) count++;
  }
  return Math.max(1, count);
}

/**
 * 직전 확인 가격(이벤트 반영 후 기준으로 환산된 값) 대비 현재가의 변동이 N거래일 가격제한폭을 넘는지.
 * 확정된 이벤트가 이미 반영된 가격으로 비교하므로, 이벤트가 등록되면 자동으로 정상 판정(해제)된다.
 */
export function isPriceAnomaly(previousAdjustedPrice: number, currentPrice: number, tradeDate: string, tradingDays: number): boolean {
  if (!(previousAdjustedPrice > 0) || !(currentPrice > 0)) return false;
  const limit = tradeDate >= PRICE_LIMIT_CHANGE_DATE ? DAILY_PRICE_LIMIT_RATIO : DAILY_PRICE_LIMIT_RATIO_BEFORE_CHANGE;
  const days = Math.max(1, tradingDays);
  const ratio = currentPrice / previousAdjustedPrice;
  return ratio > Math.pow(1 + limit, days) || ratio < Math.pow(1 - limit, days);
}

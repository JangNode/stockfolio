// 연구 AM 절대 모멘텀 청산 판정(순수 함수). 정의: docs/research/le2-absolute-momentum-prereg.md 3절.
import type { AmLeg } from "@/lib/le2AbsMomentumConfig";

/** 종목 자신의 행 번호 i 기준 수익률 = close[i−skip] ÷ close[i−lookback] − 1. 행이 부족하거나 종가가 0 이하이면 NaN. */
export function legReturn(close: ArrayLike<number>, i: number, leg: AmLeg): number {
  if (i < leg.lookback) return NaN;
  const a = close[i - leg.skip], b = close[i - leg.lookback];
  return a > 0 && b > 0 ? a / b - 1 : NaN;
}

/** 수익률이 0 이하(엄격히 양이 아님)인 구간이 minNeg개 이상이면 true. 하나라도 계산 불가(NaN)이면 null(이 규칙으로는 판단하지 않음). */
export function absMomentumTriggered(rets: number[], minNeg: number): boolean | null {
  if (!rets.length || !rets.every(Number.isFinite)) return null;
  return rets.filter((r) => r <= 0).length >= minNeg;
}

/**
 * 관심종목 적정주가 기능 공용 타입/판정 로직(DB·외부 호출 없음, 순수 함수) —
 * RIM(잔여이익모델, lib/rimValuation.ts)과 방법A(업종 평균 PER,
 * lib/peerPerValuation.ts)가 같은 형태의 결과를 반환하도록 공유한다.
 */
import { FAIR_VALUE_VERDICT_BAND_PCT } from "@/lib/stockFairValueConfig";

export type FairValueVerdict = "UNDERVALUED" | "FAIR" | "OVERVALUED" | "UNKNOWN";

export interface FairValueResult {
  method: "RIM" | "PEER_PER";
  fairPrice: number | null;
  gapPercent: number | null; // (fairPrice - currentPrice) / currentPrice * 100
  verdict: FairValueVerdict;
  reason: string;
}

/** gapPercent(적정주가가 현재가 대비 얼마나 높은지, %)로 저평가/적정/고평가를
 * 판정한다. gapPercent가 없으면(산출 불가) UNKNOWN. */
export function classifyVerdict(gapPercent: number | null): FairValueVerdict {
  if (gapPercent === null) return "UNKNOWN";
  if (gapPercent > FAIR_VALUE_VERDICT_BAND_PCT) return "UNDERVALUED";
  if (gapPercent < -FAIR_VALUE_VERDICT_BAND_PCT) return "OVERVALUED";
  return "FAIR";
}

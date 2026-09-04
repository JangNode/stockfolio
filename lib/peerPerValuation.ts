/**
 * 방법A(업종 평균 PER) 적정주가 순수 계산부(DB·외부 호출 없음). 적정주가 = 업종
 * PER 중앙값 × 종목 EPS.
 */
import { INDUSTRY_PEER_MIN_GROUP_SIZE } from "@/lib/industryPerConfig";
import { classifyVerdict, type FairValueResult } from "@/lib/stockFairValue";

export interface PeerPerValuationInput {
  currentPrice: number;
  eps: number | null;
  indutyGroup: string | null;
  groupMedianPer: number | null;
  peerCount: number;
}

export function computePeerPerFairValue(input: PeerPerValuationInput): FairValueResult {
  const { currentPrice, eps, indutyGroup, groupMedianPer, peerCount } = input;

  if (indutyGroup === null) {
    return { method: "PEER_PER", fairPrice: null, gapPercent: null, verdict: "UNKNOWN", reason: "업종 분류 정보 없음" };
  }
  if (groupMedianPer === null || peerCount < INDUSTRY_PEER_MIN_GROUP_SIZE) {
    return { method: "PEER_PER", fairPrice: null, gapPercent: null, verdict: "UNKNOWN", reason: "업종 내 비교 가능한 종목 부족" };
  }
  if (eps === null || eps <= 0) {
    return { method: "PEER_PER", fairPrice: null, gapPercent: null, verdict: "UNKNOWN", reason: "최근 EPS 적자 또는 데이터 없음" };
  }

  const fairPrice = groupMedianPer * eps;
  const gapPercent = currentPrice > 0 ? ((fairPrice - currentPrice) / currentPrice) * 100 : null;

  return { method: "PEER_PER", fairPrice, gapPercent, verdict: classifyVerdict(gapPercent), reason: "" };
}

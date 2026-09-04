/**
 * 방법A(업종 평균 PER) 적정주가 순수 계산부(DB·외부 호출 없음). 적정주가 = 업종
 * PER 중앙값 × 종목 EPS.
 *
 * 업종 중앙값은 leave-one-out(자기 자신 제외) 방식으로 계산한다. 2026-09-04
 * 실측(삼성전자): 시총 비중이 압도적인 대형주는 자기 PER이 그룹 전체(자기 포함)
 * 중앙값과 정확히 일치해버려 "업종과 비교"가 사실상 "자기 자신과 비교"가 되는
 * 문제가 확인됐다 — 그래서 대상 종목을 표본에서 반드시 제외하고 계산한다.
 */
import { INDUSTRY_PEER_MIN_GROUP_SIZE } from "@/lib/industryPerConfig";
import { classifyVerdict, type FairValueResult } from "@/lib/stockFairValue";

export interface PeerPerValuationInput {
  currentPrice: number;
  eps: number | null;
  stockCode: string;
  indutyGroup: string | null;
  /** 같은 업종그룹의 PER 표본(대상 종목 자신도 포함된 상태로 전달— 제외는 이 함수가 한다). */
  groupSamples: { stockCode: string; per: number | null }[];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function computePeerPerFairValue(input: PeerPerValuationInput): FairValueResult {
  const { currentPrice, eps, stockCode, indutyGroup, groupSamples } = input;

  if (indutyGroup === null) {
    return { method: "PEER_PER", fairPrice: null, gapPercent: null, verdict: "UNKNOWN", reason: "업종 분류 정보 없음" };
  }

  // leave-one-out: 자기 자신과, 적자 등으로 PER이 없는 종목은 표본에서 제외한다.
  const peerPers = groupSamples
    .filter((s) => s.stockCode !== stockCode)
    .map((s) => s.per)
    .filter((per): per is number => per !== null && per > 0);

  if (peerPers.length < INDUSTRY_PEER_MIN_GROUP_SIZE) {
    return { method: "PEER_PER", fairPrice: null, gapPercent: null, verdict: "UNKNOWN", reason: "업종 내 비교 가능한 종목 부족" };
  }
  if (eps === null || eps <= 0) {
    return { method: "PEER_PER", fairPrice: null, gapPercent: null, verdict: "UNKNOWN", reason: "최근 EPS 적자 또는 데이터 없음" };
  }

  const fairPrice = median(peerPers) * eps;
  const gapPercent = currentPrice > 0 ? ((fairPrice - currentPrice) / currentPrice) * 100 : null;

  return { method: "PEER_PER", fairPrice, gapPercent, verdict: classifyVerdict(gapPercent), reason: "" };
}

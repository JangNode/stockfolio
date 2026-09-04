/**
 * RIM(잔여이익모델) 적정주가 순수 계산부(DB·외부 호출 없음). ROE가 RIM_PROJECTION_YEARS년에
 * 걸쳐 최근 ROE에서 CAPM 요구수익률로 선형 수렴(fade)한다고 가정하고, 그 기간의
 * 잔여이익(ROE - 요구수익률) 현재가치를 현재 BPS에 더해 적정주가를 구한다. 5년 뒤
 * ROE가 요구수익률과 같아진다고 가정하므로 그 이후 잔여가치(영구성장률 등)는 별도로
 * 계산하지 않는다.
 */
import { RIM_PROJECTION_YEARS } from "@/lib/rimConfig";
import { computeRequiredReturnPct } from "@/lib/capm";
import { classifyVerdict, type FairValueResult } from "@/lib/stockFairValue";

export interface RimValuationInput {
  currentPrice: number;
  currentBps: number | null;
  latestRoePct: number | null;
  beta: number | null;
  riskFreeRatePct: number | null;
  payoutRatio: number; // 0~1, 배당 이력 없으면 호출부가 0으로 넘김
}

/** ROE_1 = latestRoePct, ROE_years = requiredReturnPct가 되도록 선형 보간한다.
 * years가 1이면(예측기간을 1년으로 줄인 특수 케이스) 첫해 값만 반환한다. */
export function computeRoeFadePath(
  latestRoePct: number,
  requiredReturnPct: number,
  years: number = RIM_PROJECTION_YEARS
): number[] {
  if (years <= 1) return [latestRoePct];
  return Array.from({ length: years }, (_, i) => latestRoePct + ((requiredReturnPct - latestRoePct) * i) / (years - 1));
}

/** BPS_0 = currentBps, BPS_t = BPS_(t-1) * (1 + ROE_t/100 * (1 - payoutRatio)). t=1..years의
 * BPS_t를 순서대로 반환한다(BPS_0/currentBps는 포함하지 않음). */
export function computeBpsRollForward(currentBps: number, roeFadePath: number[], payoutRatio: number): number[] {
  const bpsPath: number[] = [];
  let prevBps = currentBps;
  for (const roeT of roeFadePath) {
    const nextBps = prevBps * (1 + (roeT / 100) * (1 - payoutRatio));
    bpsPath.push(nextBps);
    prevBps = nextBps;
  }
  return bpsPath;
}

/** 적정주가 = currentBps + Σ_{t=1}^{years} [(ROE_t/100 - requiredReturnPct/100) * BPS_(t-1)] /
 * (1+requiredReturnPct/100)^t. BPS_(t-1)은 t=1일 때 currentBps, 그 이후는 bpsPath의
 * roll-forward 경로를 그대로 쓴다. */
export function computeResidualIncomeFairPrice(
  currentBps: number,
  roeFadePath: number[],
  bpsPath: number[],
  requiredReturnPct: number
): number {
  const requiredReturnRatio = requiredReturnPct / 100;
  let presentValueSum = 0;

  for (let i = 0; i < roeFadePath.length; i++) {
    const t = i + 1;
    const prevBps = i === 0 ? currentBps : bpsPath[i - 1];
    const residualIncome = (roeFadePath[i] / 100 - requiredReturnRatio) * prevBps;
    presentValueSum += residualIncome / Math.pow(1 + requiredReturnRatio, t);
  }

  return currentBps + presentValueSum;
}

/** RIM 적정주가를 계산한다. 산출 불가 조건(베타·ROE·BPS·무위험이자율 중 하나라도
 * 없거나, ROE·BPS가 적자/0 이하)이면 fairPrice: null, verdict: "UNKNOWN", reason에
 * 구체적 사유를 남긴다. */
export function computeRimFairValue(input: RimValuationInput): FairValueResult {
  const { currentPrice, currentBps, latestRoePct, beta, riskFreeRatePct, payoutRatio } = input;

  if (beta === null) {
    return { method: "RIM", fairPrice: null, gapPercent: null, verdict: "UNKNOWN", reason: "베타 산출 불가(상장 3년 미만 등)" };
  }
  if (riskFreeRatePct === null) {
    return { method: "RIM", fairPrice: null, gapPercent: null, verdict: "UNKNOWN", reason: "무위험이자율(국고채 10년물) 조회 실패" };
  }
  if (latestRoePct === null || latestRoePct <= 0) {
    return { method: "RIM", fairPrice: null, gapPercent: null, verdict: "UNKNOWN", reason: "최근 ROE 적자 또는 데이터 없음" };
  }
  if (currentBps === null || currentBps <= 0) {
    return { method: "RIM", fairPrice: null, gapPercent: null, verdict: "UNKNOWN", reason: "BPS 데이터 없음" };
  }

  const requiredReturnPct = computeRequiredReturnPct(riskFreeRatePct, beta);
  const roeFadePath = computeRoeFadePath(latestRoePct, requiredReturnPct);
  const bpsPath = computeBpsRollForward(currentBps, roeFadePath, payoutRatio);
  const fairPrice = computeResidualIncomeFairPrice(currentBps, roeFadePath, bpsPath, requiredReturnPct);

  const gapPercent = currentPrice > 0 ? ((fairPrice - currentPrice) / currentPrice) * 100 : null;

  return {
    method: "RIM",
    fairPrice,
    gapPercent,
    verdict: classifyVerdict(gapPercent),
    reason: "",
  };
}

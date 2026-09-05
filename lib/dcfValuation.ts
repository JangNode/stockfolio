/**
 * DCF(현금흐름할인법) 적정주가 순수 계산부(DB·외부 호출 없음). 과거 5개년 FCF(영업현금흐름
 * - capex)의 CAGR로 향후 5개년(RIM과 동일한 예측기간)을 추정하고, WACC으로 할인한 현재가치
 * 합계(기업가치)에서 총 이자부채를 차감해 주식가치를 구한다. 베타·무위험이자율·CAPM
 * 요구수익률(자기자본비용)은 RIM이 이미 계산한 값을 그대로 재사용한다(중복 계산 금지).
 */
import { RIM_PROJECTION_YEARS } from "@/lib/rimConfig";
import {
  DCF_FCF_GROWTH_RATE_CAP_PCT,
  DCF_TERMINAL_GROWTH_RATE_PCT,
  DCF_CORPORATE_TAX_RATE_PCT,
  DCF_WACC_TERMINAL_GROWTH_MIN_SPREAD_PCT,
} from "@/lib/dcfConfig";
import { classifyVerdict, type FairValueResult } from "@/lib/stockFairValue";
import type { CashflowStatementRow, DebtStructureRow } from "@/lib/dartCashflowDebtStorage";

const WON_PER_EOK = 100_000_000;

export interface DcfValuationInput {
  currentPrice: number;
  sharesOutstanding: number | null;
  marketCapEok: number | null; // KIS 시총(억원 단위) — 자기자본 시장가치
  cashflowRows: CashflowStatementRow[]; // fiscal_year 오름차순
  debtRows: DebtStructureRow[]; // fiscal_year 오름차순, 마지막 원소 = 최근 연도
  beta: number | null; // RIM 재사용
  riskFreeRatePct: number | null; // RIM 재사용(ECOS 국고채10년)
  requiredReturnPct: number | null; // RIM이 이미 계산한 CAPM 요구수익률(자기자본비용) — 그대로 재사용, 재계산 금지
}

/** 각 연도 FCF = operatingCf - capex. operatingCf/capex 중 하나라도 null인 연도는
 * 제외한다. fiscal_year 오름차순을 유지한다. */
export function computeFcfSeries(
  cashflowRows: CashflowStatementRow[]
): { fiscalYear: number; fcf: number }[] {
  return cashflowRows
    .filter((row) => row.operatingCf !== null && row.capex !== null)
    .map((row) => ({ fiscalYear: row.fiscalYear, fcf: (row.operatingCf as number) - (row.capex as number) }));
}

/** 첫 해와 마지막 해 FCF로 CAGR(%)을 계산한다. 첫 해 또는 마지막 해가 0 이하면 계산
 * 불가(null) — 억지로 성장시키지 않는다. 결과는 DCF_FCF_GROWTH_RATE_CAP_PCT로 캡을
 * 씌운다. */
export function computeFcfGrowthRatePct(fcfSeries: number[]): number | null {
  const first = fcfSeries[0];
  const last = fcfSeries[fcfSeries.length - 1];
  if (first === undefined || last === undefined) return null;
  if (first <= 0 || last <= 0) return null;

  const n = fcfSeries.length;
  const cagrPct = (Math.pow(last / first, 1 / (n - 1)) - 1) * 100;
  return Math.max(-DCF_FCF_GROWTH_RATE_CAP_PCT, Math.min(DCF_FCF_GROWTH_RATE_CAP_PCT, cagrPct));
}

/** FCF_t = lastActualFcf * (1 + growthRatePct/100)^t, t=1..years. 길이 years인
 * 배열을 t=1..years 순서로 반환한다. */
export function projectFcf(
  lastActualFcf: number,
  growthRatePct: number,
  years: number = RIM_PROJECTION_YEARS
): number[] {
  return Array.from({ length: years }, (_, i) => lastActualFcf * Math.pow(1 + growthRatePct / 100, i + 1));
}

/** shortTermDebt/longTermDebt/bondsPayable 세 값이 전부 null이면 부채 구조 데이터
 * 자체를 확인할 수 없는 경우로 보고 null을 반환한다. 셋 중 하나라도 non-null이면
 * null인 나머지는 0으로 간주해 합산한다 — 2026-09-04 커버리지 개선 작업(계정과목
 * 후보 확장) 이후 잔여 null은 대부분 "매칭 실패"가 아니라 "실제로 해당 부채가
 * 없음"으로 판단하기로 사용자와 합의됐다(lib/dartValuationConfig.ts 참고). */
export function computeTotalInterestBearingDebtWon(debtRow: DebtStructureRow): number | null {
  const { shortTermDebt, longTermDebt, bondsPayable } = debtRow;
  if (shortTermDebt === null && longTermDebt === null && bondsPayable === null) return null;
  return (shortTermDebt ?? 0) + (longTermDebt ?? 0) + (bondsPayable ?? 0);
}

/** 타인자본비용(%). 무차입 기업(totalDebtWon === 0)이면 0을 반환한다(산출 불가
 * 아님). 차입이 있는데 이자비용 데이터가 없으면 null(호출부가 "산출 불가" 처리 —
 * 임의 대체값을 쓰지 않는다). */
export function computeCostOfDebtPct(interestExpense: number | null, totalDebtWon: number): number | null {
  if (totalDebtWon === 0) return 0;
  if (interestExpense === null) return null;
  return (interestExpense / totalDebtWon) * 100;
}

/** WACC(%) = 자기자본비중 * 자기자본비용 + 타인자본비중 * 세후 타인자본비용. 총액이
 * 0이면(자기자본·부채 모두 0) 자기자본비중을 1로 가드한다. */
export function computeWaccPct(
  costOfEquityPct: number,
  costOfDebtPct: number,
  marketCapWon: number,
  totalDebtWon: number
): number {
  const afterTaxCostOfDebtPct = costOfDebtPct * (1 - DCF_CORPORATE_TAX_RATE_PCT / 100);
  const total = marketCapWon + totalDebtWon;
  const equityWeight = total === 0 ? 1 : marketCapWon / total;
  const debtWeight = total === 0 ? 0 : totalDebtWon / total;
  return equityWeight * costOfEquityPct + debtWeight * afterTaxCostOfDebtPct;
}

/** 추정 FCF(t=1..n)의 현재가치 합 + 잔여가치(terminal value)의 현재가치. 호출 전에
 * wacc가 terminalGrowth보다 DCF_WACC_TERMINAL_GROWTH_MIN_SPREAD_PCT 이상 커야
 * 한다(발산 방지) — 이 함수 자체는 그 검증을 하지 않으므로 호출부에서 반드시
 * 확인해야 한다. */
export function computeEnterpriseValueWon(
  projectedFcf: number[],
  waccPct: number,
  terminalGrowthPct: number
): number {
  const waccRatio = waccPct / 100;
  const terminalGrowthRatio = terminalGrowthPct / 100;
  const n = projectedFcf.length;

  let presentValueSum = 0;
  for (let i = 0; i < n; i++) {
    const t = i + 1;
    presentValueSum += projectedFcf[i] / Math.pow(1 + waccRatio, t);
  }

  const terminalValue = (projectedFcf[n - 1] * (1 + terminalGrowthRatio)) / (waccRatio - terminalGrowthRatio);
  presentValueSum += terminalValue / Math.pow(1 + waccRatio, n);

  return presentValueSum;
}

/** DCF 적정주가를 계산한다. 산출 불가 조건이면 fairPrice: null, verdict: "UNKNOWN",
 * assumptions: undefined, reason에 구체적 사유를 남긴다. */
export function computeDcfFairValue(input: DcfValuationInput): FairValueResult {
  const {
    currentPrice,
    sharesOutstanding,
    marketCapEok,
    cashflowRows,
    debtRows,
    beta,
    riskFreeRatePct,
    requiredReturnPct,
  } = input;

  const unknown = (reason: string): FairValueResult => ({
    method: "DCF",
    fairPrice: null,
    gapPercent: null,
    verdict: "UNKNOWN",
    reason,
  });

  if (beta === null) {
    return unknown("베타 산출 불가(상장 3년 미만 등)");
  }
  if (riskFreeRatePct === null || requiredReturnPct === null) {
    return unknown("무위험이자율(국고채 10년물) 조회 실패");
  }

  const fcfSeries = computeFcfSeries(cashflowRows);
  if (cashflowRows.length < RIM_PROJECTION_YEARS || fcfSeries.length < RIM_PROJECTION_YEARS) {
    return unknown("과거 현금흐름 데이터 5개년 미만");
  }

  const fcfValues = fcfSeries.map((row) => row.fcf);
  const growthRatePct = computeFcfGrowthRatePct(fcfValues);
  if (growthRatePct === null) {
    return unknown("최근 FCF 적자로 성장률 추정 불가");
  }

  if (sharesOutstanding === null || sharesOutstanding <= 0) {
    return unknown("발행주식수 데이터 없음");
  }
  if (marketCapEok === null) {
    return unknown("시가총액 데이터 없음");
  }

  const latestDebtRow = debtRows[debtRows.length - 1] ?? {
    fiscalYear: 0,
    shortTermDebt: null,
    longTermDebt: null,
    bondsPayable: null,
    interestExpense: null,
  };
  const totalDebtWon = computeTotalInterestBearingDebtWon(latestDebtRow);
  if (totalDebtWon === null) {
    return unknown("부채 구조 데이터 확인 불가");
  }

  const costOfDebtPct = computeCostOfDebtPct(latestDebtRow.interestExpense, totalDebtWon);
  if (costOfDebtPct === null) {
    return unknown("이자비용 데이터 없음(타인자본비용 산출 불가)");
  }

  const waccPct = computeWaccPct(requiredReturnPct, costOfDebtPct, marketCapEok * WON_PER_EOK, totalDebtWon);

  if (waccPct / 100 - DCF_TERMINAL_GROWTH_RATE_PCT / 100 < DCF_WACC_TERMINAL_GROWTH_MIN_SPREAD_PCT / 100) {
    return unknown("요구수익률(WACC)이 영구성장률과 너무 가까워 계산 불가(발산 위험)");
  }

  const lastActualFcf = fcfValues[fcfValues.length - 1];
  const projectedFcf = projectFcf(lastActualFcf, growthRatePct);
  const enterpriseValueWon = computeEnterpriseValueWon(projectedFcf, waccPct, DCF_TERMINAL_GROWTH_RATE_PCT);

  // 순이자부채 대신 총 이자부채를 차감한다 — 현금성자산 데이터가 이 프로젝트에 없어
  // 생략한다(사용자가 명시적으로 허용한 폴백).
  const equityValueWon = enterpriseValueWon - totalDebtWon;
  const fairPrice = equityValueWon / sharesOutstanding;
  const gapPercent = currentPrice > 0 ? ((fairPrice - currentPrice) / currentPrice) * 100 : null;

  return {
    method: "DCF",
    fairPrice,
    gapPercent,
    verdict: classifyVerdict(gapPercent),
    reason: "현금성자산 데이터 미확보로 총 이자부채를 순부채로 사용",
    assumptions: {
      wacc: waccPct,
      terminalGrowth: DCF_TERMINAL_GROWTH_RATE_PCT,
      fcfGrowthRate: growthRatePct,
    },
  };
}

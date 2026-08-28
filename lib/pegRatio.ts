/**
 * PEG(피터 린치) 지표의 순수 계산부(DB 호출 없음). PEG = PER ÷ 이익성장률(%). 이익
 * 성장률은 최근 PEG_GROWTH_LOOKBACK_YEARS년 EPS CAGR을 쓴다(lib/pegConfig.ts).
 *
 * EPS는 그 회계연도 지배주주순이익 ÷ "그 시점" 상장주식수로 계산한다 — 두 회계연도
 * 모두 지금 상장주식수를 쓰면(간단하지만) 그 사이 액면분할/자사주 매입 등으로 실제
 * 성장과 다른 값이 나올 수 있어, 각 연도 공시 시점(rcept_date)의 상장주식수를 따로
 * 조회해서 써야 한다(호출부 책임 — lib/stockFundamentals.ts의
 * computeEpsCagrAsOf 참고).
 *
 * 이 파일이 server-only가 아닌 이유는 lib/pointInTimeFundamentals.ts와 동일 —
 * lib/backtest.ts(클라이언트 컴포넌트에서도 쓰임)가 피터린치 PEG전략/커스텀 백테스트
 * PEG 조건 판정에 이 파일의 순수 함수를 재사용할 수 있어야 하기 때문이다.
 */
import { pickFundamentalsVisibleAsOf, type FundamentalsSeries, type StockFundamentalsAsOf } from "@/lib/pointInTimeFundamentals";
import { PEG_GROWTH_LOOKBACK_YEARS } from "@/lib/pegConfig";

export interface EpsCagrFiscalYearPair {
  start: StockFundamentalsAsOf;
  end: StockFundamentalsAsOf;
}

/** asOfDate 시점에 공개돼 있던 재무 중, 가장 최근 회계연도(end)와 정확히 years년 전
 * 회계연도(start)를 고른다. 둘 중 하나라도 공시가 없으면(백필 공백, 상장 초기 등)
 * null — 억지로 가까운 연도로 대체하지 않는다. */
export function selectEpsCagrFiscalYears(
  series: FundamentalsSeries,
  asOfDate: string,
  years: number = PEG_GROWTH_LOOKBACK_YEARS
): EpsCagrFiscalYearPair | null {
  const visible = pickFundamentalsVisibleAsOf(series, asOfDate);
  if (visible.length === 0) return null;

  const end = visible[visible.length - 1]; // rcept_date 오름차순이므로 마지막이 최신 공시
  const start = visible.find((f) => f.fiscalYear === end.fiscalYear - years);
  if (!start) return null;

  return { start, end };
}

/** 두 회계연도의 지배주주순이익/그 시점 상장주식수로 EPS CAGR(%)을 계산한다. 아래
 * 경우는 전부 계산 불가로 취급해 null을 반환한다(억지로 음수/허수 성장률을 만들지
 * 않는다):
 * - 순이익 데이터가 없음(비지배주주 항목 미공시 등)
 * - 상장주식수를 모름(그 시점 시세 없음)
 * - 시작/끝 연도 중 하나라도 EPS가 0 이하(적자)
 * - 계산된 성장률이 0 이하(역성장)
 */
export function computeEpsCagr(
  start: { netIncomeParent: number | null; listedShares: number | null },
  end: { netIncomeParent: number | null; listedShares: number | null },
  years: number = PEG_GROWTH_LOOKBACK_YEARS
): number | null {
  if (start.netIncomeParent === null || end.netIncomeParent === null) return null;
  if (start.listedShares === null || start.listedShares <= 0) return null;
  if (end.listedShares === null || end.listedShares <= 0) return null;

  const epsStart = start.netIncomeParent / start.listedShares;
  const epsEnd = end.netIncomeParent / end.listedShares;
  if (epsStart <= 0 || epsEnd <= 0) return null; // 적자가 낀 구간은 CAGR 자체가 정의 불가

  const growthPct = (Math.pow(epsEnd / epsStart, 1 / years) - 1) * 100;
  return growthPct > 0 ? growthPct : null; // 역성장(0 이하)이면 계산 불가로 통일
}

/** PEG = PER ÷ 이익성장률(%). PER/성장률 중 하나라도 null이거나 0 이하면(적자, 역성장,
 * PER 계산 불가 등) null — "-"로 표시해야 하는 상황을 여기서 한 번에 가드한다. */
export function computePeg(per: number | null, growthPct: number | null): number | null {
  if (per === null || per <= 0) return null;
  if (growthPct === null || growthPct <= 0) return null;
  return per / growthPct;
}

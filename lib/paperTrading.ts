import type { PaperStrategyConditions, SourceRuleType } from "@/lib/paperStrategy";
import { PAPER_STYLE_LABEL, type PaperStyle } from "@/lib/paperStyles";
import type { Market } from "@/lib/market";

// 매매 판단에는 조건 3종만 있으면 되고 label/rationale/generated_at은 필요 없다 —
// DB에 저장된 활성 전략 행(ActiveStrategyRow)에는 그 필드들이 없으므로 여기서 따로 뺀다.
export type TradeConditions = Pick<
  PaperStrategyConditions,
  "entry_conditions" | "exit_conditions" | "stock_selection_criteria"
>;

// screening_results에서 매수 후보로 쓰는 최소 정보. 배치 스크립트가 screening_results와
// 그 strategy_id가 가리키는 strategies.rule_type을 조인해서 채운다.
export interface ScreeningCandidateRow {
  screeningResultId: string;
  stockCode: string;
  stockName: string;
  // 원 스크리닝 전략(peg_lynch/reversal_breakout 포함)이 만들어내는 rule_type 전체와
  // 일치해야 한다 — lib/paperStrategy.ts의 SourceRuleType(SOURCE_RULE_TYPES)이 유일한
  // 출처다. 예전엔 ma_cross/minervini_trend_template/custom_composite 3종으로만 좁게
  // 선언돼 있었는데, surge_stock(reversal_breakout)/실험조합형(peg_lynch,
  // reversal_breakout)이 이미 실제로 이 필드에 나머지 2종을 채워 넣고 있어 타입만
  // 부정확했다(2026-09-24 수정).
  ruleType: SourceRuleType;
  returnPct: number;
  currentPrice: number;
  market: Market;
  exchange: string | null;
}

export interface HeldPositionRow {
  id: string;
  stockCode: string;
  stockName: string;
  quantity: number;
  avgPrice: number;
  openedAt: string; // ISO
  screeningResultId: string | null;
  market: Market;
}

/** 판단 근거 문구에 쓰는 통화 표기. 국내는 "1,000,000원", 미국은 "$1,000.00" 형태다. */
function formatMoney(value: number, market: Market): string {
  return market === "KR"
    ? `${Math.round(value).toLocaleString("ko-KR")}원`
    : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// 포지션이 매달린 screening_results 원본 행의 현재 상태. 이 값으로 청산가/청산
// 사유를 판단하므로 별도 시세 조회 없이 배치가 이미 갱신해둔 값을 그대로 쓴다.
// price_unavailable은 거래정지/상장폐지 등으로 시세 조회가 연속 실패해 붙는 상태
// (scripts/screen-all-stocks.ts updateActiveTracking 참고) — currentPrice는 마지막
// 확인된 값에서 멈춰 있다.
export interface UnderlyingScreeningStatus {
  status: "active" | "stopped" | "profited" | "price_unavailable";
  currentPrice: number;
  priceFetchFailureCount: number;
}

export interface BuyDecision {
  candidate: ScreeningCandidateRow;
  quantity: number;
  amount: number;
  rationale: string;
}

const STYLE_LABEL = PAPER_STYLE_LABEL;

/**
 * 전략의 진입조건/종목선정기준을 스크리닝 후보 목록에 기계적으로 대입해 매수 결정을
 * 만든다. 이미 보유 중인 종목은 다시 사지 않고(v1: 물타기/추가매수 없음), 후보를
 * 순위대로 훑으며 남은 슬롯과 현금이 허락하는 만큼만 산다. position_size_pct는
 * "그 시점의 보유 현금" 기준이라, 한 실행 안에서 여러 건을 살수록 다음 건의 투입액은
 * 남은 현금 기준으로 자연히 줄어든다.
 */
export function selectBuyCandidates(
  style: PaperStyle,
  conditions: TradeConditions,
  candidates: ScreeningCandidateRow[],
  heldStockCodes: ReadonlySet<string>,
  currentPositionCount: number,
  startingCash: number
): BuyDecision[] {
  const { entry_conditions: entry, stock_selection_criteria: selection } = conditions;

  const eligible = candidates.filter(
    (c) =>
      entry.source_rule_types.includes(c.ruleType) &&
      c.returnPct >= entry.min_signal_return_pct &&
      c.returnPct <= entry.max_signal_return_pct &&
      !heldStockCodes.has(c.stockCode) &&
      c.currentPrice > 0
  );

  eligible.sort((a, b) =>
    selection.prefer_higher_return_pct ? b.returnPct - a.returnPct : a.returnPct - b.returnPct
  );

  const ranked = eligible.slice(0, selection.max_candidates_to_consider);

  const decisions: BuyDecision[] = [];
  const pickedStockCodes = new Set<string>();
  let cash = startingCash;
  let slotsAvailable = entry.max_positions - currentPositionCount;

  for (const candidate of ranked) {
    if (slotsAvailable <= 0) break;
    // 같은 종목이 서로 다른 rule_type/screening_result로 후보 목록에 중복으로 남아있을
    // 수 있다(loadCandidates의 dedup은 종목+rule_type 단위라 rule_type이 다르면 걸러지지
    // 않음). paper_positions는 (portfolio_id, stock_code) 유니크라 같은 실행에서 같은
    // 종목을 두 번 매수 결정하면 두 번째 포지션 저장이 실패해 거래 기록만 남고 현금은
    // 차감되지 않는데, 평가금액 계산은 이 결정 목록을 그대로 신뢰하므로 실제로 없는
    // 포지션이 평가금액에 얹힌다(2026-09-01 급등주 계좌에서 실제 재현).
    if (pickedStockCodes.has(candidate.stockCode)) continue;

    const budget = cash * (entry.position_size_pct / 100);
    const quantity = Math.floor(budget / candidate.currentPrice);
    if (quantity < 1) continue;

    const amount = quantity * candidate.currentPrice;
    cash -= amount;
    slotsAvailable--;
    pickedStockCodes.add(candidate.stockCode);

    const rankOrder = selection.prefer_higher_return_pct ? "상위" : "하위(눌림목)";
    decisions.push({
      candidate,
      quantity,
      amount,
      rationale:
        `[${STYLE_LABEL[style]}] ${candidate.ruleType} 신호 종목 중 신호 대비 수익률 ` +
        `${candidate.returnPct.toFixed(2)}%(조건 ${entry.min_signal_return_pct}~` +
        `${entry.max_signal_return_pct}%, ${rankOrder} 우선)로 매수 후보 선정. ` +
        `보유 현금 ${formatMoney(cash + amount, candidate.market)}의 ` +
        `${entry.position_size_pct}%인 ${formatMoney(amount, candidate.market)} 투입 ` +
        `(${quantity}주 @ ${formatMoney(candidate.currentPrice, candidate.market)}).`,
    });
  }

  return decisions;
}

/**
 * "실험조합형" 스타일 전용 매수 게이팅("고정비중 게이팅", A안). 안정형/공격형처럼
 * 후보 전체를 하나의 풀로 모아 단일 기준으로 매수하는 게 아니라, rule_type별
 * 목표비중(targetWeights, 예: lib/experimentalBlendConfig.ts의
 * EXPERIMENTAL_BLEND_TARGET_WEIGHTS)을 정해두고 그 rule_type의 현재 보유비중
 * (heldValueByRuleType/totalEquity)이 목표 미달일 때만 그 rule_type의 후보를
 * 매수 대상으로 남긴다. 목표비중이 정의되지 않은 rule_type의 후보는 통과시키지
 * 않는다.
 *
 * 미달인 rule_type이 하나뿐이면 그 rule_type의 후보를 전부 통과시킨다(슬롯 1개짜리
 * 경우라 비례 배분이 의미 없음). 미달인 rule_type이 둘 이상이면 이분법으로 전부
 * 통과시키지 않고, 이번 매수 판단에 쓸 수 있는 남은 슬롯(slotsAvailable)을 미달
 * rule_type들의 목표비중에 비례해 정수 슬롯으로 나눈다(최대잔여법/Hamilton
 * apportionment — 몫의 정수부를 먼저 배분하고, 남는 슬롯은 소수부가 큰 rule_type부터
 * 하나씩 얹어 합이 정확히 slotsAvailable이 되게 한다). 각 rule_type은 배분받은
 * 슬롯 수만큼만, 랭킹 기준(preferHigherReturnPct)으로 상위 후보만 통과시킨다 —
 * 한 rule_type의 후보 수가 배분 슬롯보다 적어도 남는 슬롯을 다른 rule_type에
 * 재배분하지 않는다. 초과분을 파는 강제 리밸런싱은 하지 않는다 — 매수 시점
 * 게이팅에만 쓴다.
 */
export function filterCandidatesByTargetWeight(
  candidates: ScreeningCandidateRow[],
  heldValueByRuleType: ReadonlyMap<string, number>,
  totalEquity: number,
  targetWeights: Readonly<Partial<Record<SourceRuleType, number>>>,
  slotsAvailable: number,
  preferHigherReturnPct: boolean
): ScreeningCandidateRow[] {
  if (totalEquity <= 0 || slotsAvailable <= 0) return candidates;

  const underweightRuleTypes = (Object.entries(targetWeights) as [SourceRuleType, number][]).filter(
    ([ruleType, targetWeight]) => (heldValueByRuleType.get(ruleType) ?? 0) / totalEquity < targetWeight
  );

  if (underweightRuleTypes.length === 0) return [];

  if (underweightRuleTypes.length === 1) {
    const [onlyUnderweightRuleType] = underweightRuleTypes[0];
    return candidates.filter((c) => c.ruleType === onlyUnderweightRuleType);
  }

  // 미달 rule_type이 둘 이상: 목표비중을 미달 rule_type들 사이에서만 재정규화해
  // slotsAvailable을 정수 슬롯으로 나눈다(최대잔여법). 예: 슬롯 5개, minervini(0.54)·
  // peg_lynch(0.36)만 미달이면 0.54:0.36 → 60:40으로 재정규화해 3개/2개로 배분.
  const totalUnderweightTargetWeight = underweightRuleTypes.reduce((sum, [, weight]) => sum + weight, 0);

  const apportionedShares = underweightRuleTypes.map(([ruleType, targetWeight]) => {
    const exactShare = (slotsAvailable * targetWeight) / totalUnderweightTargetWeight;
    const flooredShare = Math.floor(exactShare);
    return { ruleType, flooredShare, fractionalRemainder: exactShare - flooredShare };
  });

  let unassignedSlots = slotsAvailable - apportionedShares.reduce((sum, s) => sum + s.flooredShare, 0);

  const sharesByRemainderDesc = [...apportionedShares].sort(
    (a, b) => b.fractionalRemainder - a.fractionalRemainder
  );
  for (const share of sharesByRemainderDesc) {
    if (unassignedSlots <= 0) break;
    share.flooredShare += 1;
    unassignedSlots--;
  }

  const slotsByRuleType = new Map(apportionedShares.map((s) => [s.ruleType, s.flooredShare]));

  const allowedScreeningResultIds = new Set<string>();
  for (const [ruleType] of underweightRuleTypes) {
    const slotsForRuleType = slotsByRuleType.get(ruleType) ?? 0;
    if (slotsForRuleType <= 0) continue;

    const rankedCandidatesForRuleType = candidates
      .filter((c) => c.ruleType === ruleType)
      .sort((a, b) => (preferHigherReturnPct ? b.returnPct - a.returnPct : a.returnPct - b.returnPct));

    for (const c of rankedCandidatesForRuleType.slice(0, slotsForRuleType)) {
      allowedScreeningResultIds.add(c.screeningResultId);
    }
  }

  return candidates.filter((c) => allowedScreeningResultIds.has(c.screeningResultId));
}

export interface SellDecision {
  price: number;
  rationale: string;
}

/**
 * 보유 포지션 하나의 청산 여부를 판단한다. 원본 스크리닝 신호가 이미 손절/익절로
 * 종료됐으면(원 전략의 판단) 그 가격 그대로 모의투자 포지션도 함께 청산해 추가 시세
 * 조회 없이 원 배치가 갱신한 값만 재사용한다. 그렇지 않으면 이 전략 자체의
 * 청산조건(익절/손절/최대 보유기간)을 그 값으로 평가한다. underlying이 없으면(원본
 * 행을 못 찾음) 가격을 알 수 없어 판단을 보류한다.
 */
export function evaluateExit(
  style: PaperStyle,
  conditions: TradeConditions,
  position: HeldPositionRow,
  underlying: UnderlyingScreeningStatus | null,
  now: Date
): SellDecision | null {
  if (!underlying) return null;

  const { exit_conditions: exit } = conditions;
  const label = STYLE_LABEL[style];

  // 시세 조회가 계속 실패해 가격이 멈춰 있는 상태다 — 이 멈춘 가격으로 손절/익절/
  // 최대 보유기간 청산을 실행하면 실제로는 확인 안 되는 성과를 "정상 매도"처럼
  // 기록하게 된다(2026-09-20 확인). 가격이 다시 확인될 때까지 모든 강제청산을
  // 보류한다 — 화면에는 이 상태를 별도로 노출한다.
  if (underlying.status === "price_unavailable") {
    return null;
  }

  if (underlying.status !== "active") {
    const resultLabel = underlying.status === "stopped" ? "손절" : "익절";
    return {
      price: underlying.currentPrice,
      rationale: `[${label}] 원 스크리닝 신호가 ${resultLabel}로 종료되어 포지션도 함께 청산.`,
    };
  }

  const pct = ((underlying.currentPrice - position.avgPrice) / position.avgPrice) * 100;

  if (pct >= exit.take_profit_pct) {
    return {
      price: underlying.currentPrice,
      rationale:
        `[${label}] 청산조건(익절 ${exit.take_profit_pct}%) 도달: ` +
        `매입가 ${formatMoney(position.avgPrice, position.market)} 대비 +${pct.toFixed(2)}%.`,
    };
  }

  if (pct <= -exit.stop_loss_pct) {
    return {
      price: underlying.currentPrice,
      rationale:
        `[${label}] 청산조건(손절 ${exit.stop_loss_pct}%) 도달: ` +
        `매입가 ${formatMoney(position.avgPrice, position.market)} 대비 ${pct.toFixed(2)}%.`,
    };
  }

  const holdingDays = (now.getTime() - new Date(position.openedAt).getTime()) / 86_400_000;
  if (holdingDays >= exit.max_holding_days) {
    return {
      price: underlying.currentPrice,
      rationale: `[${label}] 최대 보유기간(${exit.max_holding_days}일)을 초과해 청산(경과 ${holdingDays.toFixed(1)}일).`,
    };
  }

  return null;
}

export interface EquitySnapshot {
  cash: number;
  holdingsValue: number;
  equity: number;
}

export function computeEquity(cash: number, holdingsValue: number): EquitySnapshot {
  return { cash, holdingsValue, equity: cash + holdingsValue };
}

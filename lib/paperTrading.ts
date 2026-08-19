import type { PaperStrategyConditions, PaperStyle } from "@/lib/paperStrategy";

// screening_results에서 매수 후보로 쓰는 최소 정보. 배치 스크립트가 screening_results와
// 그 strategy_id가 가리키는 strategies.rule_type을 조인해서 채운다.
export interface ScreeningCandidateRow {
  screeningResultId: string;
  stockCode: string;
  stockName: string;
  ruleType: "ma_cross" | "minervini_trend_template";
  returnPct: number;
  currentPrice: number;
}

export interface HeldPositionRow {
  id: string;
  stockCode: string;
  stockName: string;
  quantity: number;
  avgPrice: number;
  openedAt: string; // ISO
  screeningResultId: string | null;
}

// 포지션이 매달린 screening_results 원본 행의 현재 상태. 이 값으로 청산가/청산
// 사유를 판단하므로 별도 시세 조회 없이 배치가 이미 갱신해둔 값을 그대로 쓴다.
export interface UnderlyingScreeningStatus {
  status: "active" | "stopped" | "profited";
  currentPrice: number;
}

export interface BuyDecision {
  candidate: ScreeningCandidateRow;
  quantity: number;
  amount: number;
  rationale: string;
}

const STYLE_LABEL: Record<PaperStyle, string> = {
  aggressive: "공격형",
  conservative: "안정형",
};

/**
 * 전략의 진입조건/종목선정기준을 스크리닝 후보 목록에 기계적으로 대입해 매수 결정을
 * 만든다. 이미 보유 중인 종목은 다시 사지 않고(v1: 물타기/추가매수 없음), 후보를
 * 순위대로 훑으며 남은 슬롯과 현금이 허락하는 만큼만 산다. position_size_pct는
 * "그 시점의 보유 현금" 기준이라, 한 실행 안에서 여러 건을 살수록 다음 건의 투입액은
 * 남은 현금 기준으로 자연히 줄어든다.
 */
export function selectBuyCandidates(
  style: PaperStyle,
  conditions: PaperStrategyConditions,
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
  let cash = startingCash;
  let slotsAvailable = entry.max_positions - currentPositionCount;

  for (const candidate of ranked) {
    if (slotsAvailable <= 0) break;

    const budget = cash * (entry.position_size_pct / 100);
    const quantity = Math.floor(budget / candidate.currentPrice);
    if (quantity < 1) continue;

    const amount = quantity * candidate.currentPrice;
    cash -= amount;
    slotsAvailable--;

    const rankOrder = selection.prefer_higher_return_pct ? "상위" : "하위(눌림목)";
    decisions.push({
      candidate,
      quantity,
      amount,
      rationale:
        `[${STYLE_LABEL[style]}] ${candidate.ruleType} 신호 종목 중 신호 대비 수익률 ` +
        `${candidate.returnPct.toFixed(2)}%(조건 ${entry.min_signal_return_pct}~` +
        `${entry.max_signal_return_pct}%, ${rankOrder} 우선)로 매수 후보 선정. ` +
        `보유 현금 ${Math.round(cash + amount).toLocaleString("ko-KR")}원의 ` +
        `${entry.position_size_pct}%인 ${Math.round(amount).toLocaleString("ko-KR")}원 투입 ` +
        `(${quantity}주 @ ${candidate.currentPrice.toLocaleString("ko-KR")}원).`,
    });
  }

  return decisions;
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
  conditions: PaperStrategyConditions,
  position: HeldPositionRow,
  underlying: UnderlyingScreeningStatus | null,
  now: Date
): SellDecision | null {
  if (!underlying) return null;

  const { exit_conditions: exit } = conditions;
  const label = STYLE_LABEL[style];

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
        `매입가 ${position.avgPrice.toLocaleString("ko-KR")}원 대비 +${pct.toFixed(2)}%.`,
    };
  }

  if (pct <= -exit.stop_loss_pct) {
    return {
      price: underlying.currentPrice,
      rationale:
        `[${label}] 청산조건(손절 ${exit.stop_loss_pct}%) 도달: ` +
        `매입가 ${position.avgPrice.toLocaleString("ko-KR")}원 대비 ${pct.toFixed(2)}%.`,
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

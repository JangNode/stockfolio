/**
 * 전략 버전 계보. 같은 전략의 개정판(v1 → v2 → v3 …)을 한 줄(계보)로 묶고, 계보의 마지막 항목을 "최신 버전"으로 본다.
 * AI 모의투자 스타일이 신호 출처로 계보 안의 아무 버전 키(예: DB에 저장된 "reversal_breakout")를 가리켜도
 * 최신 버전(현재 "reversal_breakout_v2")의 신호만 쓴다. 새 버전을 낼 때는 이 배열에서 해당 계보 맨 끝에
 * 새 rule_type 키를 추가하면 모의투자가 자동으로 그 버전을 따라간다(스타일 설정·DB 행 변경 없음).
 *
 * 계보에 없는 rule_type(종료되어 후속 버전이 없는 전략: minervini_trend_template, custom_composite 등)은
 * 신호 출처로 쓰이지 않는다.
 */
export const STRATEGY_VERSION_FAMILIES: readonly (readonly string[])[] = [
  ["ma_cross"],
  ["peg_lynch"],
  // 급등주 찾기(역배열 반등): v1(reversal_breakout, 2026-10 종료) → v2. 새 버전은 맨 끝에 추가.
  ["reversal_breakout", "reversal_breakout_v2"],
];

/** 같은 계보의 최신 버전 rule_type. 계보에 없는 키면 null. */
export function latestRuleType(ruleType: string): string | null {
  const family = STRATEGY_VERSION_FAMILIES.find((versions) => versions.includes(ruleType));
  return family ? family[family.length - 1] : null;
}

/**
 * 후보 신호(candidateRuleType)가 스타일의 신호 출처 목록(sourceRuleTypes)에 해당하는지.
 * 후보가 자기 계보의 최신 버전이어야 하고, 출처 목록 중 하나가 같은 계보를 가리켜야 한다.
 */
export function matchesSourceRuleTypes(sourceRuleTypes: readonly string[], candidateRuleType: string): boolean {
  const latest = latestRuleType(candidateRuleType);
  if (latest === null || latest !== candidateRuleType) return false;
  return sourceRuleTypes.some((source) => latestRuleType(source) === latest);
}

/** 현재 운영 중인 전략인지(자기 계보의 최신 버전인지). DB에 남아 있는 종료 전략 행(minervini, v1 등)을 배치에서 거르는 데 쓴다. */
export function isOperatingRuleType(ruleType: string): boolean {
  return latestRuleType(ruleType) === ruleType;
}

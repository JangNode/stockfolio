/** "급등주 찾기"(역배열 반등, rule_type: reversal_breakout) 전략 고유의 기준값. 숫자만
 * 바꿔서 나중에 튜닝할 수 있게 한 곳에 모아둔다. 값 자체는 팀장-사용자 대화로 확정된
 * 값이라(통상적인 5/20/60일 조합이 아니다) 다른 전략처럼 시장 통계에서 유도한 것은
 * 아니다.
 *
 * 전략 개념: 역배열(하락 추세) 상태에서 바닥을 다지다 대량 거래를 동반한 반등이
 * 시작되는 시점을 "역배열 이력 → 매집봉 → 전환 신호" 3단계로 포착한다. */

// 역배열 판정에 쓰는 이동평균 기간(단기→장기 순으로 5개). 정배열/역배열 판정은 이
// 순서대로 오름차순(단기<장기)인지를 본다.
export const REVERSAL_BREAKOUT_MA_PERIODS = [20, 60, 112, 244, 448] as const;

// 역배열 이력: 최근 이 일수 중 위 5개 이평선이 오름차순 정렬돼 있던 날의 비율이
// REVERSAL_MIN_INVERSE_RATIO 이상이어야 "역배열 이력"으로 인정한다.
export const REVERSAL_HISTORY_LOOKBACK_DAYS = 60;
export const REVERSAL_MIN_INVERSE_RATIO = 0.7;

// 매집봉 발생: 최근 이 일수 내에 거래량이 그 시점 "직전"(당일 제외) 평균 대비
// ACCUMULATION_VOLUME_MULTIPLIER배 이상이면서 종가>시가(양봉)인 날이 있어야 한다.
export const ACCUMULATION_LOOKBACK_DAYS = 20;
export const ACCUMULATION_VOLUME_MULTIPLIER = 3;

// 전환 신호: 현재가가 MA20 위로 돌파한 시점이 최근 이 일수 이내여야 한다.
export const BREAKOUT_LOOKBACK_DAYS = 5;

// 전환 신호 판정에 쓰는 이동평균 기간. REVERSAL_BREAKOUT_MA_PERIODS[0](=20)과 반드시
// 같아야 한다 — 전환 신호가 "역배열의 가장 단기 이평선을 돌파했는지"를 보기 때문이다.
// 값을 바꾸려면 REVERSAL_BREAKOUT_MA_PERIODS[0]도 함께 바꿔야 한다.
export const BREAKOUT_MA_PERIOD: number = REVERSAL_BREAKOUT_MA_PERIODS[0];

// 종목당 필요한 최소 일봉 건수: (REVERSAL_HISTORY_LOOKBACK_DAYS - 1) + (최장 이평선
// 기간(448) - 1) + 1 = 59 + 447 + 1 = 507. 여유를 둬 520을 최소 상수로 쓴다.
export const REVERSAL_BREAKOUT_MIN_HISTORY_ROWS = 520;

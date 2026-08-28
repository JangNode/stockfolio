/** PEG(피터 린치) 지표 관련 기준값. 숫자만 바꿔서 나중에 튜닝할 수 있게 한 곳에
 * 모아둔다. 가치평가지표 카드/커스텀 백테스트 PEG 조건/피터린치 PEG전략이 공용으로
 * 쓴다. */

// EPS 연평균 성장률(CAGR) 계산에 쓸 기준 연수. "최근 5년 EPS 성장률"의 5.
export const PEG_GROWTH_LOOKBACK_YEARS = 5;

// 피터린치 PEG전략의 매수 기준(PEG 이 값 이하).
export const PEG_MAX_RATIO = 1.0;

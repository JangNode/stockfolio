/** DH전략(대형 배당·가치주) 고유의 스크리닝 기준값. 숫자만 바꿔서 나중에 튜닝할 수
 * 있게 한 곳에 모아둔다. 여러 전략이 같이 쓰는 원자료(시세/재무/배당) 관련 기준값은
 * DH전략 전용이 아니므로 lib/stockDataConfig.ts로 옮겼다(2026-08-28) — DH전략의
 * 대형주 기준은 그 파일의 STOCK_DATA_CANDIDATE_MARKET_CAP_EOK를 그대로 쓰면 된다. */

export const DH_MAX_PER = 15;
export const DH_MAX_PBR = 1.5;
export const DH_MIN_CONSECUTIVE_DIVIDEND_YEARS = 5;

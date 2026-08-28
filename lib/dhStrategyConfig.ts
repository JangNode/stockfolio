/** DH전략(대형 배당·가치주) 고유의 스크리닝 기준값. 숫자만 바꿔서 나중에 튜닝할 수
 * 있게 한 곳에 모아둔다. 여러 전략이 같이 쓰는 원자료(시세/재무/배당) 관련 기준값은
 * DH전략 전용이 아니므로 lib/stockDataConfig.ts로 옮겼다(2026-08-28).
 *
 * DH_MIN_MARKET_CAP_EOK는 STOCK_DATA_CANDIDATE_MARKET_CAP_EOK(백필 후보 발굴 기준)와
 * 지금은 같은 값이지만 의미가 다르다 — 저건 "재무/배당을 백필해둘 만큼 관심 있는
 * 종목"을 고르는 데이터 인프라 쪽 기준이고, 이건 DH전략이 실제 매매 판단에 쓰는
 * "대형주" 기준이다. 분리해둬야 DH전략만 기준을 조정할 때 재백필 없이 이 값만
 * 바꾸면 된다(단, STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK보다 낮게 내리면 데이터
 * 자체가 없다 — lib/stockDataConfig.ts 참고). */
export const DH_MIN_MARKET_CAP_EOK = 10_000; // 1조원

export const DH_MAX_PER = 15;
export const DH_MAX_PBR = 1.5;
export const DH_MIN_CONSECUTIVE_DIVIDEND_YEARS = 5;

/** DH전략(대형 배당·가치주) 기준값. 숫자만 바꿔서 나중에 튜닝할 수 있게 한 곳에 모아둔다. */

// DH전략 자체의 대형주 기준(시가총액, 억원). 실제 스크리닝/백테스트 판정에 쓴다.
export const DH_MIN_MARKET_CAP_EOK = 10_000; // 1조원

// 백필 저장 시점에 적용하는 하한(억원) — DH_MIN_MARKET_CAP_EOK보다 낮게 잡아 여유를
// 둔다. 이 하한 밑인 종목·날짜는 애초에 Parquet 파일에 저장하지 않는다(용량 절감).
// DH_MIN_MARKET_CAP_EOK을 나중에 이 값보다 낮게 내리고 싶으면 재백필이 필요하다.
export const DH_BACKFILL_MARKET_CAP_FLOOR_EOK = 5_000; // 5천억원

export const DH_MAX_PER = 15;
export const DH_MAX_PBR = 1.5;
export const DH_MIN_CONSECUTIVE_DIVIDEND_YEARS = 5;

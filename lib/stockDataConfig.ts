/**
 * 종목 시세/재무/배당 원자료(raw data) 관련 기준값. DH전략 전용이 아니라 여러
 * 전략이 같이 쓸 공유 데이터라서 dh_ 접두사 없이 별도 파일로 둔다(2026-08-28).
 * DH전략 고유의 스크리닝 기준값(PER/PBR 상한, 배당 연속연수 등)은
 * lib/dhStrategyConfig.ts에 그대로 둔다.
 */

// 후보종목 발굴 기준(시가총액, 억원) — 이 문턱을 한 번이라도 넘은 적 있는 종목만
// 재무/배당 백필 대상으로 삼는다. DH전략의 대형주 기준과 지금은 같은 값이지만,
// 다른 전략이 다른 기준을 쓰고 싶으면 이 값과 별개로 자기 기준을 두면 된다.
export const STOCK_DATA_CANDIDATE_MARKET_CAP_EOK = 10_000; // 1조원

// 백필 저장 시점에 적용하는 하한(억원) — STOCK_DATA_CANDIDATE_MARKET_CAP_EOK보다
// 낮게 잡아 여유를 둔다. 이 하한 밑인 종목·날짜는 애초에 Parquet 파일에 저장하지
// 않는다(용량 절감). 후보 기준을 나중에 이 값보다 낮게 내리고 싶으면 재백필이 필요하다.
export const STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK = 5_000; // 5천억원

// hot/cold 분리(용량 예산 재산정, 2026-08-28) — 최근 이 기간(년)치 일별시세는
// Postgres(stock_daily_prices_recent, 하루 INSERT만 하면 됨)에 두고, 그보다 오래된
// 건 Parquet(stock-daily-prices 버킷)에 둔다. 연 1회 아카이빙 배치가 경계를 넘은
// 데이터를 옮긴다. 늘려도 예산에 여유가 커서(2년 기준 연간 ~18MB) 문제없다.
export const STOCK_DATA_HOT_WINDOW_YEARS = 2;

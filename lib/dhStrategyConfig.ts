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

// hot/cold 분리(용량 예산 재산정, 2026-08-28) — 최근 이 기간(년)치 일별시세는
// Postgres(dh_daily_prices_recent, 하루 INSERT만 하면 됨)에 두고, 그보다 오래된 건
// Parquet(dh-daily-prices 버킷)에 둔다. 연 1회 아카이빙 배치가 경계를 넘은 데이터를
// 옮긴다. 늘려도 예산에 여유가 커서(2년 기준 연간 ~18MB) 문제없다.
export const DH_HOT_WINDOW_YEARS = 2;

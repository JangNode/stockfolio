/** DH전략(대형 배당·가치주) 고유의 스크리닝 기준값. 숫자만 바꿔서 나중에 튜닝할 수
 * 있게 한 곳에 모아둔다. 여러 전략이 같이 쓰는 원자료(시세/재무/배당) 관련 기준값은
 * DH전략 전용이 아니므로 lib/stockDataConfig.ts로 옮겼다(2026-08-28).
 *
 * DH_MIN_MARKET_CAP_EOK는 STOCK_DATA_CANDIDATE_MARKET_CAP_EOK(백필 후보 발굴 기준,
 * 1조원 그대로 유지)와 의미가 다르다 — 저건 "재무/배당을 백필해둘 만큼 관심 있는
 * 종목"을 고르는 데이터 인프라 쪽 기준이고, 이건 DH전략이 실제 매매 판단에 쓰는
 * "대형주" 기준이다. 분리해둬야 DH전략만 기준을 조정할 때 재백필 없이 이 값만
 * 바꾸면 된다(단, STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK보다 낮게 내리면 데이터
 * 자체가 없다 — lib/stockDataConfig.ts 참고).
 *
 * 2026-09-09 1조원→2조원 상향(조건 튜닝 백테스트 분석 결과): 2018-2022/2023-2026
 * 두 구간, 20/60/120거래일 전 horizon에서 시총 2조 조건이 baseline(1조)보다 평균·
 * 중앙값이 일관되게 높았다 — 특히 중앙값이 두 구간 다 플러스인 유일한 조건이었다
 * (+1.27%/+4.05%, baseline은 2018-2022 중앙값 -4.98%로 하락장 전형적 신호가 손실).
 * 신호 수는 절반 정도로 줄지만(195/452건) 통계적으로 충분한 수준으로 판단했다. PER/
 * PBR/배당연수는 구간별로 엇갈리거나 개선 폭이 작아 이번엔 건드리지 않았다. */
export const DH_MIN_MARKET_CAP_EOK = 20_000; // 2조원(2026-09-09 이전: 10_000, 1조원)

export const DH_MAX_PER = 15;
export const DH_MAX_PBR = 1.5;
export const DH_MIN_CONSECUTIVE_DIVIDEND_YEARS = 5;

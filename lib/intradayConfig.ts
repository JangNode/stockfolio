// 분봉 장중 가설 설계(docs/research/intraday-design.md) 기준값. 사용자 지정 2026-11-23. 값은 결과(수익·신호)를 보기 전에 정했다.
// 봉 라벨 = 봉 시작 분(0900 = 09:00:00~09:00:59 + 시가 단일가 체결, 연속 매매 마지막 분 = 1519, 1530 = 종가 단일가 체결 한 건). 행은 체결이 있었던 분에만 있다.
export const ID_OPEN_LABEL_MIN = 9 * 60;
/** 연속 매매 분 수(09:00~15:20). */
export const ID_CONT_MINUTES = 380;
/** 종가 단일가 행 라벨. */
export const ID_AUCTION_HHMM = 1530;
/** 허용 봉 단위(분). 이 둘만 쓴다. */
export const ID_UNITS = [10, 60] as const;
/** 1회 주문 규모 가정(원). */
export const ID_ORDER_WON = 100_000_000;
export const ID_FEE_PER_SIDE = 0.00015;
/** 편도 슬리피지 = 충격(주문 ÷ 해당 단위 평균 봉 거래대금 구간별) + 반호가(0.5 × 호가 단위 ÷ 가격). [상한 비율, 충격] 오름차순, 마지막은 초과. */
export const ID_IMPACT_BINS: [number, number][] = [[0.01, 0.0002], [0.05, 0.0004], [0.20, 0.0008]];
export const ID_IMPACT_OVER = 0.0015;
/** 주문 ÷ 평균 봉 거래대금이 이 값을 넘으면 그 종목·단위는 제외. */
export const ID_PARTICIPATION_MAX = 1.0;
/** 매도세: 분봉 기간(2025-11~2026-11)의 기존 규칙(2025 0.15%, 2026 0.20%) 중 2026 값을 왕복 비용 표에 쓴다. */
export const ID_SELL_TAX = 0.002;
/** 검정력 표: 순거래당 기대값 후보(%), 단측 95% 신뢰하한 z. */
export const ID_MU_PCT = [0.05, 0.10] as const;
export const ID_Z_ONE_SIDED_95 = 1.645;
export const ID_GAP_TH = -0.02;
export const ID_SEED = 20261123;
export const ID_TICK = (p: number): number => (p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000);

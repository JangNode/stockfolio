// DCF(현금흐름할인법) 적정주가 계산 기준값.

// FCF 5개년 CAGR이 비정상적으로 크게/작게 나올 때 씌우는 상하한. 근거 없는 극단적
// 추정을 막는다(예: 기저효과로 CAGR이 수백%가 나오는 경우).
export const DCF_FCF_GROWTH_RATE_CAP_PCT = 50;

// 영구성장률. 장기 물가상승률 수준의 보수적 값(한국은행 물가안정목표 2% 기준).
// WACC보다 충분히 낮아야 하며(발산 방지), 실무적으로 조정 가능하게 상수로 둔다.
export const DCF_TERMINAL_GROWTH_RATE_PCT = 2.0;

// 법인세율. 한국 법인세 최고세율 구간(과세표준 3천억 초과) 24% + 지방소득세
// 10%(법인세의 10%) 근사 실효세율. 정확한 개별 기업 실효세율 대신 쓰는 단일
// 근사값 — 조정 가능하게 상수로 둔다.
export const DCF_CORPORATE_TAX_RATE_PCT = 24.2;

// WACC와 영구성장률 간 최소 격차(발산 방지 안전마진, %p).
export const DCF_WACC_TERMINAL_GROWTH_MIN_SPREAD_PCT = 1.0;

// 위성 전략 v1(scripts/research-satellite-v1.ts, research/satellite-v1-prereg.md) 기준값. 모두 사용자 사전등록(2026-10-21).

/** 보유 종목 수, 보유 유지 순위(점수 순위가 이 안이면 유지). */
export const SAT_HOLD_COUNT = 20;
export const SAT_KEEP_RANK = 40;
/** C1 상위 몇 분의 1을 뺄지(3 = 상위 1/3). */
export const SAT_C1_EXCLUDE_PARTS = 3;
/** 매수 지연: 외국인 순매수 합산 창(거래일), 상위 비율(10 = 상위 1/10), 지연 거래일. */
export const SAT_FLOW_DAYS = 5;
export const SAT_FLOW_TOP_PARTS = 10;
export const SAT_BUY_DELAY_DAYS = 5;
/** 조합: 위성 비중(P100, P90, P80, P70, P60, P50, P0 순), 되돌림 허용 폭, 069500 편도 비용(수수료 0.015% + 0.05%). */
export const SAT_MIX_WEIGHTS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 1.0] as const;
export const SAT_MIX_BAND = 0.05;
export const SAT_ETF_COST_PER_SIDE = 0.00015 + 0.0005;
/** 비중 선택: 학습 CAGR ≥ B&H − 0.5%p, MDD ≤ B&H. 해당 없으면 기본 표시 비중(P80 = 위성 0.2). */
export const SAT_MIX_CAGR_TOL_PP = 0.5;
export const SAT_MIX_DEFAULT_W = 0.2;
/** 참고 기준(위성 단독): CAGR ≥ PEW + 2.0%p, MDD ≤ B&H + 10%p, 지연 하락 ≤ 1.0%p. */
export const SAT_REF_PEW_MARGIN_PP = 2.0;
export const SAT_REF_MDD_MARGIN_PP = 10.0;
export const SAT_REF_MAX_DELAY_DROP_PP = 1.0;
/** 스팩 식별 이름 키워드(dart_corp_codes.corp_name). */
export const SAT_SPAC_NAME_KEYWORDS = ["스팩", "기업인수목적"] as const;

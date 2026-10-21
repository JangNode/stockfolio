// 신용잔고 전략 CR1~CR3(scripts/research-credit-tilt.ts, research/credit-tilt-prereg.md) 기준값. 모두 사용자 사전등록(2026-10-21).
// 기간·분기 리밸 월·R3 회수/상위 비율·분기당 횟수는 lib/smallcapLowvolConfig.ts(LV_*), 유니버스는 lib/signalScanConfig.ts(SCAN_*),
// 신용잔고 시차·이어쓰기는 lib/shortCreditScanConfig.ts(SCS_*)를 그대로 쓴다.

/** CR1 배수: C1 3등분 하위(신용 적음) × 1.5, 중간 × 1.0, 상위 × 0.5. */
export const CT_MULT_LOW = 1.5;
export const CT_MULT_MID = 1.0;
export const CT_MULT_HIGH = 0.5;
/** 기본 3등분, R1의 4등분(상위 1/4 기준). */
export const CT_GROUPS = 3;
export const CT_R1_GROUPS = 4;
/** 관문: CR1·CR2(POOL 대비) G1 여유 1.0%p, G3 POOL MDD + 5.0%p. CR3(MEW 대비) G1 여유 2.0%p, G3 B&H MDD + 10.0%p. G4 지연 하락 ≤ 1.0%p. */
export const CT_POOL_G1_MARGIN_PP = 1.0;
export const CT_POOL_G3_MDD_MARGIN_PP = 5.0;
export const CT_MID_G1_MARGIN_PP = 2.0;
export const CT_MID_G3_MDD_MARGIN_PP = 10.0;
export const CT_G4_MAX_DELAY_DROP_PP = 1.0;
/** R3 무작위 배정 시드. */
export const CT_R3_SEED = 20261021;
/** 신용잔고 정리본 연도 범위(2009~2016 기존 + 2017~2026 추가분). */
export const CT_CREDIT_FIRST_YEAR = 2009;
export const CT_CREDIT_LAST_YEAR = 2026;

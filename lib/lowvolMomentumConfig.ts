// 연구 B(저변동 + 모멘텀 방어 포트폴리오, 시도 206~207) 기준값. 사용자 지정 2026-10-26. 사전등록: docs/research/b-lowvol-quality-prereg.md
/** 저변동 점수: 직전 N거래일 일수익률 표준편차(낮을수록 좋음). 기본 60, 이웃값 40·90. */
export const B_VOL_WINDOW = 60;
export const B_VOL_WINDOW_NEIGHBORS = [40, 90] as const;
/** 모멘텀 점수: 252거래일 전부터 21거래일 전까지의 수익률(12-1개월). 0 이하이면 신규 편입 후보에서 제외. */
export const B_MOM_LOOKBACK = 252;
export const B_MOM_SKIP = 21;
/** B1 = 206(10종목 균등 10%, 순위 30위 밖이면 매도), B2 = 207(5종목 균등 20%, 20위 밖이면 매도). 순위 유지 한도 이웃값(B1): 20·40. */
export const B_CANDS = {
  B1: { slots: 10, frac: 0.1, keepRank: 30, trial: 206 },
  B2: { slots: 5, frac: 0.2, keepRank: 20, trial: 207 },
} as const;
export const B_KEEP_RANK_NEIGHBORS_B1 = [20, 40] as const;
/** 방어형 판정 A_B: 전체 구간 CAGR ≥ 069500 CAGR 이고 MDD ≤ 069500 MDD − 이 값(%p). */
export const B_AB_MDD_MARGIN_PP = 10;
/** 슬리피지(대형 0.1%). 유니버스 K200P: 코스피 시총 상위 200, 20일 평균 거래대금 하한(원). */
export const B_SLIPPAGE = 0.001;
export const B_UNIVERSE_TOP = 200;
export const B_MIN_AVG_TV_WON = 500_000_000;

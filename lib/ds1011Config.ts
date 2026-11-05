// 연구 DS10(시도 276)·DS11(시도 277) 기준값. 사용자 지정 2026-11-05. 사전등록: docs/research/ds10-ds11-prereg.md
// 기본은 DS6(연구 DS5·DS6/시도 272 정의 그대로)이고 아래 바뀐 부분만 다르다. 평가 구간·윈도우·기준선 시작일은 연구 DS8·DS9(lib/ds89Config.ts)와 같다.
// 값은 시험 전에 고정했고 결과를 본 뒤 바꾸지 않는다. 한쪽 결과를 본 뒤 다른 쪽 정의를 바꾸지 않는다.
export const DS1011_PRIOR_TESTS = 275;
export const DS10_TRIAL = 276;
export const DS11_TRIAL = 277;

/** DS10 국면 신호: 069500 원주가 종가가 SMA 위면 상승, 아래(같으면 포함)면 하락. 신호일 t 종가까지의 정보만 쓰고 전환은 새 상태가 CONFIRM 거래일 연속일 때 확정, 체결은 다음 거래일 종가. */
export const DS10_SMA = 200;
export const DS10_CONFIRM_DAYS = 5;
/** 워밍업: 평가 시작 후 첫 SMA 길이만큼의 거래일은 DS6와 같은 코어 40 : 위성 60(상태 판정·확인 일수 계산도 그 뒤부터). */
export const DS10_WARM_CORE = 0.4;
/** 상태별 코어 비중(나머지는 LV1). */
export const DS10_UP_CORE = 0.6;
export const DS10_DOWN_CORE = 0.2;
/** 게이트 D 이웃(하나씩만 바꿈): 이동평균 길이, 상승 코어 비중(하락 20% 고정), 하락 코어 비중(상승 60% 고정). 워밍업 길이는 각 이웃의 이동평균 길이를 따른다. */
export const DS10_NB_SMA = [150, 250] as const;
export const DS10_NB_UP_CORE = [0.5, 0.7] as const;
export const DS10_NB_DOWN_CORE = [0.1, 0.3] as const;

/** DS11 코어 선택: 판단일 K200P 시총 상위 CAND종목 중 최근 WIN거래일 수익률(조정 종가, 판단일 종가까지) 상위 2종목을 시총가중으로 보유. 신호 종가 d, 체결 종가 d+1, 비중은 체결일 시총 비율. */
export const DS11_CAND = 10;
export const DS11_WIN = 126;
export const DS11_CORE_N = 2;
/** 게이트 D 이웃: 후보 상위 5·15, 수익률 창 63·252일, 코어 비중 ±10%p(30%·50%). */
export const DS11_NB_CAND = [5, 15] as const;
export const DS11_NB_WIN = [63, 252] as const;

/** 보고용 기록(연구 DS6 기록과 DS8·DS9 결과, CAGR % / MDD %). 롤링 3년 창은 069500보다 CAGR 높은 창·MDD 작은 창 비율(%). */
export const DS1011_REC = {
  DS6: { 전체: [11.7, 39.15], 구간1: [4.11, 24.51], 구간2: [9.17, 30.78], 구간3: [22.54, 33.66], roll: [92.81, 32.03] },
  DS8: { 전체: [11.28, 40.38], 구간1: [3.82, 26.13], 구간2: [7.63, 32.5], 구간3: [23.33, 31.2], roll: [84.31, 28.76], 결과: "탈락 C" },
  DS9: { 전체: [8.95, 41.19], 구간1: [1.06, 26.8], 구간2: [5.9, 36.84], 구간3: [20.98, 35.18], roll: [58.17, 58.17], 결과: "탈락 A·C·E" },
} as const;

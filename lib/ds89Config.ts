// 연구 DS8(시도 274)·DS9(시도 275) 기준값. 사용자 지정 2026-11-04. 사전등록: docs/research/ds8-ds9-prereg.md
// 기본은 DS6(연구 DS5·DS6/시도 272 정의 그대로: 코어 40% 상위 종목 시총 비율·교체 5거래일 연속 밖, 위성 60% LV1 단독, 일별 목표 비중 리밸 이동 비용 0.25%)이고 아래 바뀐 부분만 다르다.
// 값은 시험 전에 고정했고 결과를 본 뒤 바꾸지 않는다. 한쪽 결과를 본 뒤 다른 쪽 정의를 바꾸지 않는다.
export const DS89_PRIOR_TESTS = 273;
export const DS8_TRIAL = 274;
export const DS9_TRIAL = 275;
/** 초기 배분 종가 날짜(LV1 250거래일 워밍업 뒤 첫 거래일). 수익 집계는 다음 거래일(2011-01-04)부터 고정 스냅샷 끝(2026-10-26)까지 이어서 계산한다. */
export const DS89_RUN_START = "2011-01-03";
/**
 * 평가 구간 3개(이름, 시작, 끝). 069500 기준선의 시작일도 같은 2011-01-04이다(DS7에서 구간 1 시작 2011-01-01이 2011-01-03 수익을 기준선에만 넣은 문제 방지).
 * 끝 2016-12-29는 마지막 거래일(2016-12-30은 연말 휴장일).
 */
export const DS89_WINDOWS: readonly (readonly [string, string, string])[] = [
  ["구간 1 2011-01-04~2016-12-29", "2011-01-04", "2016-12-29"],
  ["구간 2 2017-04~2021-12", "2017-04-04", "2021-12-31"],
  ["구간 3 2022-01~2026-10-26", "2022-01-01", "9999-12-31"],
];
/** DS6 기록(연구 DS6 후속 진단·DS7 보고): 연속 전체, 구간 1(2011-01-04~2016-12-29), 롤링 3년 창 중 069500보다 CAGR 높은 창·MDD 작은 창 비율(%). */
export const DS89_DS6_REF = { 전체: [11.7, 39.15], 구간1: [4.1, 24.51], rollCagrShare: 92.81, rollMddShare: 32.03 } as const;
/** DS8: LV1 일별 목표 배율 m(그날 종가 판단, 슬롯당 목표 비중 = 1/슬롯 수 × m)을 최근 이 거래일 수의 단순평균으로 바꾼다. D 이웃은 창 2일·5일. */
export const DS8_SMOOTH_WIN = 3;
export const DS8_NB_WINDOWS = [2, 5] as const;
/** DS9: 코어 종목 수·코어 안 종목당 상한(초과분은 나머지에 시총 비례 재배분). D 이웃: 종목 수 3·5(상한 40%), 상한 30%·50%(종목 수 4), 코어 비중 30%·50%(CS_CORE_W_NEIGHBOR). */
export const DS9_CORE_N = 4;
export const DS9_CORE_CAP = 0.4;
export const DS9_NB_N = [3, 5] as const;
export const DS9_NB_CAP = [0.3, 0.5] as const;
/** 코어 비중은 DS6과 같은 40%(코어 종목 수만 다름). 위성은 LV1 단독. */
export const DS89_CORE_W = 0.4;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수). */
export const DS89_F_DENOMINATOR = 2;
/** 삼성전자 종목코드. */
export const DS89_SAMSUNG = "005930";

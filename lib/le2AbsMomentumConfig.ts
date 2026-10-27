// 연구 AM(LE2 + 종목별 절대 모멘텀 청산, 시도 226~228) 기준값. 사용자 지정 2026-10-27. 사전등록: docs/research/le2-absolute-momentum-prereg.md
// 기저 전략은 연구 LE의 LE2(lib/momentumEnsembleConfig.ts LE_CANDS.LE2), 유니버스·비용·슬리피지·평가 시작·재진입 금지는 LE와 같다. 값은 결과를 본 뒤 조정하지 않는다.
export const AM_PRIOR_TESTS = 225;
/** 수익률 = close[i−skip] ÷ close[i−lookback] − 1 (종목 자신의 수정 종가 행 기준). 앙상블 점수의 세 구간과 같은 정의다. */
export interface AmLeg { lookback: number; skip: number }
/** 이웃값(게이트 D) 한 개: 라벨과 그 변형이 쓰는 구간 목록(후보와 같은 minNeg). */
export interface AmVariant { label: string; legs: readonly AmLeg[] }
/**
 * legs: 보유 종목의 자기 모멘텀을 재는 구간들, minNeg: 이 중 수익률이 0 이하인 구간이 minNeg개 이상이면 다음 거래일 종가에 매도.
 * 한 구간이라도 계산할 수 없으면(행 부족) 이 규칙으로는 판단하지 않는다(LE2의 기존 규칙만 적용).
 */
export const AM_CANDS = {
  AM1: {
    trial: 226,
    legs: [{ lookback: 252, skip: 21 }] as readonly AmLeg[],
    minNeg: 1,
    neighbors: [
      { label: "룩백 189일(9개월−1개월)", legs: [{ lookback: 189, skip: 21 }] },
      { label: "룩백 315일(15개월−1개월)", legs: [{ lookback: 315, skip: 21 }] },
    ] as readonly AmVariant[],
  },
  AM2: {
    trial: 227,
    legs: [{ lookback: 63, skip: 5 }, { lookback: 126, skip: 5 }, { lookback: 252, skip: 21 }] as readonly AmLeg[],
    minNeg: 2,
    // 개월 → 거래일은 21일/개월. 앞의 두 구간은 skip 5, 마지막(긴) 구간은 skip 21(기본 세트와 같은 자리 규칙).
    neighbors: [
      { label: "룩백 세트 (2·5·9개월)", legs: [{ lookback: 42, skip: 5 }, { lookback: 105, skip: 5 }, { lookback: 189, skip: 21 }] },
      { label: "룩백 세트 (4·7·15개월)", legs: [{ lookback: 84, skip: 5 }, { lookback: 147, skip: 5 }, { lookback: 315, skip: 21 }] },
    ] as readonly AmVariant[],
  },
  AM3: {
    trial: 228,
    legs: [{ lookback: 126, skip: 5 }] as readonly AmLeg[],
    minNeg: 1,
    neighbors: [
      { label: "룩백 90일(skip 5)", legs: [{ lookback: 90, skip: 5 }] },
      { label: "룩백 180일(skip 5)", legs: [{ lookback: 180, skip: 5 }] },
    ] as readonly AmVariant[],
  },
} as const;
/** 비교 열로 같이 보이는 LV1(연구 LV, LE2 + 변동성 목표 20%)의 목표. 같은 스냅샷으로 다시 계산해 표에 넣는다(시도 수에 넣지 않음). */
export const AM_LV1_TARGET = 0.2;
export const AM_LV1_REF = { cagr: 6.95, mdd: 46.46 } as const;
/** LE 시험에서 얻은 LE2 전체 CAGR / MDD(같은 스냅샷). 이번 실행에서 다시 계산해 일치를 확인한다. */
export const AM_LE2_REF = { cagr: 10.87, mdd: 55.36 } as const;
/** 게이트 H: 기준선 = LE2. 조건1 = CAGR ≥ 기준선 + 1%p, 조건2 = MDD ≤ 기준선 − 3%p 이고 CAGR ≥ 기준선 − 1%p, MDD 5%p 이상 개선 여부는 표시만. */
export const AM_H_CAGR_GAIN_PP = 1;
export const AM_H_MDD_GAIN_PP = 3;
export const AM_H_MDD_GAIN_STRONG_PP = 5;
export const AM_H_CAGR_FLOOR_PP = 1;
/** 절대 모멘텀 청산 사유 라벨(청산 사유별 건수 집계용). */
export const AM_EXIT_REASON = "절대 모멘텀";

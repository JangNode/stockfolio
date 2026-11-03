// 연구 진단 코어-위성 하루 지연 민감도 분해(시험 아님, 시도 번호 소진 없음) 기준값. 사용자 지정 2026-11-03. 문서: docs/research/core-satellite-delay-diagnostic.md
// 후보는 연구 CS의 CS1·CS2를 그대로 쓰고 새로 정의하지 않는다. 아래 값은 재현 확인용 기록이다(소수 둘째 자리까지 같아야 하고, 다르면 중단한다).
/** 연구 CS 시험 기록: 지연 없음 / 구성요소 전부 하루 지연(게이트 C 버전) 평가 구간 전체 CAGR / MDD. 지연 MDD는 기록된 "악화 −1.87%p(CS1)·−1.95%p(CS2)"에서 환산했다. */
export const CSD_REF = {
  CS1: { base: { cagr: 14.94, mdd: 27.81 }, delay1: { cagr: 12.63, mdd: 25.95 } },
  CS2: { base: { cagr: 16.26, mdd: 31.01 }, delay1: { cagr: 14.3, mdd: 29.06 } },
} as const;
/** 지연 단위: 기준 체결은 신호 다음 거래일 종가(lag 1). 하루 지연 = 체결을 한 거래일 더 미룸(lag 2, 연구 게이트 C와 같음), 2일 지연 = lag 3. */
export const CSD_LAGS = [1, 2, 3] as const;
/** 변화율(원래 CAGR 대비)은 기준 CAGR 절댓값이 이 값(%)보다 작으면 계산하지 않는다(0 근처 비율 폭주 방지). */
export const CSD_MIN_BASE_CAGR_FOR_RATIO = 0.5;

// 연구 CS(코어-위성 CS1 = 시도 263, CS2 = 264, CS3 = 265) 기준값. 사용자 지정 2026-11-02. 사전등록: docs/research/core-satellite-prereg.md
// 코어는 종목 이름이 아닌 규칙(월말 K200P 구성 안에서 당일 시총 상위 N종목), 위성은 연구 IVA의 R3(PE4+W3+LV1 변동성 역수 비중)다. 값은 시험 전에 고정했고 결과를 본 뒤 바꾸지 않는다.
export const CS_PRIOR_TESTS = 262;
/** 코어 교체 확인 일수: 보유 종목이 시총 상위 N위 밖으로 나간 뒤 이 거래일 수만큼 연속으로 밖에 있을 때만 교체한다(사용자 지정, 잦은 교체 방지). 밖에 나간 첫날을 1일로 센다. */
export const CS_SWAP_CONFIRM_DAYS = 5;
/** 코어 순위 목록 깊이(연구 L·LV와 같은 megaAt 목록을 재사용). 상위 N종목만 쓰며 보유 종목이 이 깊이 밖이어도 "상위 N위 밖"으로 센다. */
export const CS_RANK_DEPTH = 60;
/** 코어와 위성 사이 매일 목표 비율로 되돌리는 이동 금액에 한 번 적용하는 비율(사용자 지정). 정보용 민감도는 0.50%. */
export const CS_MOVE_COST = 0.0025;
export const CS_MOVE_COST_SENS = 0.005;
/** 게이트 D: 코어 비중 ±이만큼(사용자 지정 ±10%p). */
export const CS_CORE_W_NEIGHBOR = 0.1;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 사전등록의 후보 수). */
export const CS_F_DENOMINATOR = 3;
/** 위성 구성요소(R3 = 연구 IVA 시도 262와 같은 구성). 변동성 창은 연구 IVA의 IVA_VOL_WINDOW(250)를 그대로 쓴다. */
export const CS_SAT_COMPS = ["PE4", "W3", "LV1"] as const;
/** 후보: coreW = 코어 비중(나머지는 위성), coreN = 코어 종목 수, nNeighbors = 게이트 D의 코어 종목 수 변형. */
export const CS_CANDS = {
  CS1: { trial: 263, coreW: 0.3, coreN: 2, nNeighbors: [1, 3] },
  CS2: { trial: 264, coreW: 0.4, coreN: 2, nNeighbors: [1, 3] },
  CS3: { trial: 265, coreW: 0.3, coreN: 3, nNeighbors: [1, 2] },
} as const;
/** 재현 기준(연구 IVA 보고 표, 평가 구간 전체 CAGR / MDD). 소수 둘째 자리까지 같아야 한다. 다르면 중단한다. */
export const CS_R3_REF = { cagr: 10.61, mdd: 27.03 } as const;
export const CS_R1_REF = { cagr: 12.6, mdd: 28.34 } as const;
/** 코어 정확성 점검 허용 오차: 이벤트 없는 구간에서 시뮬레이터 일수익률과 독립 계산(시총 비율 매수 후 보유)의 차이(%p). 성과 비교가 아니라 회계 점검이다. */
export const CS_ACCOUNTING_TOL_PP = 1e-9;

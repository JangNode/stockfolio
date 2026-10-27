// 연구 C(투자 대가 모델의 숫자 규칙 종합 점수, 시도 208~210) 기준값. 사용자 지정 2026-10-26. 사전등록: docs/research/guru-composite-prereg.md
// SMALL 유니버스 기준(시총 1천억~5천억·거래대금 2억·주가 1,000원)·재무 신선도 200일·70% 커버리지·평가 구간·슬리피지 0.2%는 연구 R의 상수(R_*, lib/kodexSectorSatConfig.ts)를 그대로 쓴다.
export const G_PRIOR_TESTS = 207;
/**
 * 최종 정의(2026-10-26 사용자 지정, 수익률 계산 전): 두 등급을 사전 선언한다. 본 시험(main) = 재무 커버리지 70% 유지·결과를 후보 판정에 사용.
 * 탐색 시험(explore) = 커버리지 60%·통과해도 "후보"가 아니라 "추가 독립 검증 대상"으로만 기록하고 운영 적용·모의 편입 금지. 50% 등급은 만들지 않는다.
 * 블록: V(가치) · Q(품질·안전, 4항목: ROE·영업이익률·낮은 부채비율·최근 4분기 흑자 수) · Qp(Q', 3항목: 흑자 수 제외) · Gr(성장). 가중치는 균등(튜닝 금지).
 * 커버리지 = 후보가 쓰는 모든 블록의 원자료가 한 종목에서 동시에 계산되는 SMALL 시총 비율(판단일 연평균). 순이익 > 0 같은 점수 조건은 반영하지 않는다(연구 R의 3종 커버리지와 같은 읽기).
 */
export const G_CANDS = {
  "C2'": { trial: 208, tier: "main", minCoveragePct: 70, blocks: ["V", "Qp"] },
  C1: { trial: 209, tier: "explore", minCoveragePct: 60, blocks: ["V", "Q", "Gr"] },
  C2: { trial: 210, tier: "explore", minCoveragePct: 60, blocks: ["V", "Q"] },
  C3: { trial: 211, tier: "explore", minCoveragePct: 60, blocks: ["Q", "Gr"] },
} as const;
/** 정보용 비교 행("후보 전체 균등 보유")의 보유 한도(종목당 1/값). 후보 집합 전체를 코드 오름차순으로 채운다. */
export const G_ALL_SLOTS = 400;
/** 보유 종목 수(균등 비중 = 1/보유 수), 매도 순위 한도, 재진입 금지 거래일. 이웃값은 하나씩만 바꾼다(게이트 D). */
export const G_SLOTS = 10;
export const G_SLOTS_NEIGHBORS = [7, 15] as const;
export const G_KEEP_RANK = 30;
export const G_KEEP_RANK_NEIGHBORS = [20, 40] as const;
export const G_REENTRY_BAN_DAYS = 20;
/** Q의 "최근 4분기 중 흑자 분기 수"에 쓰는 분기 수(수정 후 사전등록 2026-10-26: 8 → 4, 자료 가용성). 4개가 모두 계산돼야 값이 있다. */
export const G_QUARTERS = 4;
/** Gr(직전 사업연도 대비 전전 사업연도 성장률)는 판단일 이전에 접수된 가장 최근 사업보고서를 쓴다. 연 1회 갱신 특성상 신선도를 사업보고서 접수일(정정이면 최초 접수일)부터 400일로 둔다(분기 보고서 기반 V·Q는 연구 R의 200일 R_STALE_DAYS). */
export const G_STALE_DAYS_ANNUAL = 400;

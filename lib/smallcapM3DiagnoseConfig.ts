// M3 진단(scripts/research-smallcap-m3-diagnose.ts, research/smallcap-m3-diagnose-prereg.md) 기준값. 사용자 사전등록(2026-10-19). M3 정의 상수는 lib/smallcapLowvolConfig.ts.

/** D3 조합: 전략(M3/SEW) 슬리브 비중. half = 069500 50% + 전략 50%, third = 069500 70% + 전략 30%. */
export const DIAG_COMBO_WEIGHTS = { half: 0.5, third: 0.3 } as const;

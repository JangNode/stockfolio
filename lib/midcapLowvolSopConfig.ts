// 중형주 저변동성·영업이익 전략 연구(scripts/research-midcap-lowvol-sop.ts, research/midcap-lowvol-sop-prereg.md) 기준값. 모두 사용자 사전등록(2026-10-19).
// 관문·R1~R3 기준·기간·VOL 창은 lib/smallcapLowvolConfig.ts(LV_*), MID 유니버스 기준·후보 표시 |t|는 lib/signalScanConfig.ts(SCAN_*)를 그대로 쓴다.

/** 0단계 게이트: MID 행 SOP 월21·월63은 |t| ≥ SCAN_CANDIDATE_ABS_T 이고 순차이 > 0일 때 N2·N3를 포함한다. VOL 월63은 보고만 한다. */
export const MV_GATE0_SOP_HORIZONS = [21, 63] as const;
export const MV_GATE0_VOL_HORIZON = 63;
/** N1·N2 선정 비율(1/3), N3의 VOL 하위·SOP 상위 비율(1/2). */
export const MV_N1_PARTS = 3;
export const MV_N2_PARTS = 3;
export const MV_N3_PARTS = 2;
/** N3 교집합이 이 수 미만이면 그 분기는 N1 선정으로 대체. */
export const MV_N3_MIN_COUNT = 30;

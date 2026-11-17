// K200P 가격 오류 17건 보정 대상·대조일. 사전등록: docs/research/k200p-correction-prereg.md (7974b48, 보정값 수집 전 고정).
export interface CorrTarget { code: string; date: string }
export const K200P_CORR_TARGETS: CorrTarget[] = [
  { code: "069260", date: "2010-09-03" }, { code: "004170", date: "2011-02-01" }, { code: "010780", date: "2011-07-07" }, { code: "002240", date: "2014-12-29" },
  { code: "226320", date: "2016-04-26" }, { code: "027410", date: "2016-11-23" }, { code: "267270", date: "2017-11-14" }, { code: "267260", date: "2017-11-17" },
  { code: "267270", date: "2018-11-19" }, { code: "010620", date: "2018-12-04" }, { code: "112610", date: "2021-02-08" }, { code: "285130", date: "2021-10-21" },
  { code: "181710", date: "2021-12-29" }, { code: "375500", date: "2022-04-08" }, { code: "214320", date: "2023-11-29" }, { code: "086280", date: "2024-07-12" },
  { code: "000500", date: "2026-06-30" },
];
/** 대조용 정상일 5건(KRX 응답이 비면 다음 평일로 최대 3일 미룸). */
export const K200P_CORR_CONTROLS: CorrTarget[] = [{ code: "005930", date: "2013-03-15" }, { code: "000660", date: "2017-08-22" }, { code: "004170", date: "2019-05-14" }, { code: "086280", date: "2022-09-06" }, { code: "002240", date: "2024-02-27" }];
export const K200P_CORR_CONTROL_MAX_DIFF_PP = 0.1;
export const K200P_CORR_CONTROL_MAX_SHIFT_DAYS = 3;
/** KRX 호출 상한(사용자 지정 40회, 계획 22회). */
export const K200P_CORR_MAX_CALLS = 40;
export const K200P_CORR_SLEEP_MS = 800;
export const KRX_API_BASE = "https://data-dbg.krx.co.kr/svc/apis";

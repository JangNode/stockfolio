// 연구 묶음 5(RM1·LR1·PF1·TS1·MV1·BS1) 기준값. 사용자 지정 2026-11-17. 사전등록: docs/research/batch5-prereg.md (정의 커밋 f5c2668, 첫 시험 전).
// 값은 첫 시험 전에 고정했고 결과를 보고 바꾸지 않는다(사전 점검에서 발견한 구현 논리 결함만 사유를 기록하고 고친다).
export const B5_PRIOR_TESTS = 293;
/** 게이트 F 참고선: 1 − 0.05 ÷ (이번 묶음의 최대 시험 수 12). 판정 기준 자체(백분위 ≥ 95)는 바뀌지 않는다. */
export const B5_F_DENOMINATOR = 12;
/** 승률·손익 보고용 코어 비중(DS6 코어 = 40%). */
export const B5_CORE_W = 0.4;
/** 시장 필터: 069500 지수 수준이 이 길이의 단순이동평균 미만이면 비중 배수 B5_FILTER_LOW, 아니면 1. 이웃 150일·250일. */
export const B5_MA_DAYS = 200;
export const B5_MA_NB = [150, 250] as const;
export const B5_FILTER_LOW = 0.5;

// ---- RM1 ----
export interface RmP { n: number; start: number; skip: number; minValid: number; keepMult: number }
export const B5_RM_P0: RmP = { n: 20, start: 252, skip: 21, minValid: 200, keepMult: 2 };
export const B5_RM_NB: [string, Partial<RmP>][] = [["종목 수 15", { n: 15 }], ["종목 수 25", { n: 25 }], ["건너뛰는 구간 10일", { skip: 10 }], ["건너뛰는 구간 42일", { skip: 42 }]];
// ---- LR1 ----
export interface LrP { n: number; longStart: number; longEnd: number; recent: number; minValid: number; keepMult: number }
export const B5_LR_P0: LrP = { n: 20, longStart: 504, longEnd: 126, recent: 126, minValid: 450, keepMult: 2 };
export const B5_LR_NB: [string, Partial<LrP>][] = [["종목 수 15", { n: 15 }], ["종목 수 25", { n: 25 }], ["장기 창 시작 378일", { longStart: 378, minValid: 338 }], ["장기 창 시작 630일", { longStart: 630, minValid: 563 }], ["최근 창 63일", { recent: 63 }], ["최근 창 189일", { recent: 189 }]];
// ---- PF1 ----
export interface PfP { n: number; zWin: number; minTv: number; minValid: number; keepMult: number }
export const B5_PF_P0: PfP = { n: 10, zWin: 252, minTv: 5e8, minValid: 230, keepMult: 2 };
export const B5_PF_NB: [string, Partial<PfP>][] = [["종목 수 8", { n: 8 }], ["종목 수 12", { n: 12 }], ["z 창 189일", { zWin: 189, minValid: 173 }], ["z 창 315일", { zWin: 315, minValid: 288 }], ["거래대금 3억", { minTv: 3e8 }], ["거래대금 10억", { minTv: 1e9 }]];
export const B5_PF_SLIP = 0.002;
export const B5_PF_TV_DAYS = 60;
// ---- TS1 (슬롯 시뮬레이터) ----
export interface TsP { win: number; minValid: number; stop: number; slots: number }
export const B5_TS_P0: TsP = { win: 252, minValid: 230, stop: 0.25, slots: 20 };
export const B5_TS_NB: [string, Partial<TsP>][] = [["신고가 창 189일", { win: 189, minValid: 173 }], ["신고가 창 315일", { win: 315, minValid: 288 }], ["손절 폭 20%", { stop: 0.2 }], ["손절 폭 30%", { stop: 0.3 }], ["슬롯 15", { slots: 15 }], ["슬롯 25", { slots: 25 }]];
export const B5_TS_CAP = 0.05;
// ---- MV1 ----
export interface MvP { win: number; minValid: number; cap: number; lambda: number; top: number }
export const B5_MV_P0: MvP = { win: 252, minValid: 230, cap: 0.05, lambda: 0.5, top: 100 };
export const B5_MV_NB: [string, Partial<MvP>][] = [["공분산 창 189일", { win: 189, minValid: 173 }], ["공분산 창 315일", { win: 315, minValid: 288 }], ["종목 상한 4%", { cap: 0.04 }], ["종목 상한 6%", { cap: 0.06 }], ["축소 계수 0.3", { lambda: 0.3 }], ["축소 계수 0.7", { lambda: 0.7 }]];
export const B5_MV_KKT_TOL = 1e-9;
export const B5_MV_MAX_ITER = 20000;
export const B5_MV_CHECK_SAMPLES = 24;
// ---- BS1 ----
export interface BsP { n: number; volWin: number; turnWin: number; minTv: number; keepMult: number; topWin: number; minRows: number; minPrice: number; tvMedianDays: number; zeroVolWin: number; zeroVolMax: number; recentZeroWin: number }
export const B5_BS_P0: BsP = { n: 30, volWin: 126, turnWin: 126, minTv: 3e8, keepMult: 3, topWin: 21, minRows: 126, minPrice: 1000, tvMedianDays: 60, zeroVolWin: 126, zeroVolMax: 5, recentZeroWin: 20 };
export const B5_BS_NB: [string, Partial<BsP>][] = [["종목 수 20", { n: 20 }], ["종목 수 40", { n: 40 }], ["변동성·회전율 창 63일", { volWin: 63, turnWin: 63 }], ["변동성·회전율 창 252일", { volWin: 252, turnWin: 252 }], ["거래대금 2억", { minTv: 2e8 }], ["거래대금 5억", { minTv: 5e8 }]];
export const B5_BS_SLIP_K200 = 0.001;
export const B5_BS_SLIP_OTHER = 0.002;
export const B5_ORDER_WON = 1e8;
export const B5_FWD_STRESS_NOTE = "1억 원 가정";

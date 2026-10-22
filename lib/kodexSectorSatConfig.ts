// KODEX 200 + 업종 모멘텀 위성 v3(scripts/research-kodex-sector-satellite-v3.ts, research/kodex-sector-satellite-v3-prereg.md) 기준값. 모두 사용자 사전등록(2026-10-22).
// 업종 모멘텀 정의·K200P는 lib/sectorMomTiltConfig.ts, 되돌림 폭·069500 비용은 lib/satelliteV1Config.ts(SAT_MIX_BAND, SAT_ETF_COST_PER_SIDE)를 쓴다.

/** 위성: 업종 모멘텀 상위 업종 수. */
export const KSS_TOP_K = 3;
/** 조합 위성 비중(90:10, 80:20, 70:30, 50:50, 0:100)과 기본(80:20). */
export const KSS_MIX_WEIGHTS = [0.1, 0.2, 0.3, 0.5, 1.0] as const;
export const KSS_DEFAULT_W = 0.2;
/** 참고 기준(80:20 vs B&H 가격): G1 CAGR ≥ +0.3%p, G2 MDD ≤ +3.0%p, G4 지연 하락 ≤ 0.5%p (G3 샤프 ≥ B&H). */
export const KSS_G1_MARGIN_PP = 0.3;
export const KSS_G2_MDD_MARGIN_PP = 3.0;
export const KSS_G4_MAX_DELAY_DROP_PP = 0.5;
/** R1 주변 값, R3 무작위 비교. */
export const KSS_R1_LOOKBACKS = [3, 12] as const;
export const KSS_R1_TOP_KS = [2, 4] as const;
export const KSS_R3_DRAWS = 1000;
export const KSS_R3_SEED = 20261022;

// ---- v3.1 (research/kodex-sector-satellite-v3_1-prereg.md, 사용자 지정 2026-10-22) ----
/** 업종별 위성 종목 수(시총 상위)와 R1 주변 값. */
export const KSS31_PER_SECTOR = 3;
export const KSS31_R1_LOOKBACKS = [3, 9, 12] as const;
export const KSS31_R1_PER_SECTOR = [2, 5] as const;
/** 실투자 점검: 최소 운용 금액 집계 시작 월, 계좌 크기(원), 최근 신호일 수. */
export const KSS31_PRACTICAL_FROM = "2024-01";
export const KSS31_ACCOUNTS_WON = [10_000_000, 30_000_000, 100_000_000] as const;
export const KSS31_RECENT_SIGNALS = 12;

// ---- v3.2 (research/kodex-sector-satellite-v3_2-prereg.md, 사용자 지정 2026-10-22) ----
/** A 정리 기준: 80:20 기준 계좌 전체 비중이 이 값 미만인 위성 종목 제외. R1 주변 값. */
export const KSS32_TRIM_MIN_WEIGHT = 0.01;
export const KSS32_R1_TRIMS = [0.005, 0.02] as const;
/** B 실제 시드(원), 위성 실제 비중 상한, 069500 슬리피지(편도). 주식 비용은 lib/transactionCost.ts. */
export const KSS32_SEEDS_WON = [1_000_000, 3_000_000, 5_000_000, 7_000_000, 10_000_000] as const;
export const KSS32_SAT_CAP = 0.3;
export const KSS32_ETF_SLIPPAGE = 0.0005;

// ---- 연구 B·C (docs/research/bc-weight-defense-prereg.md, a28dfbd) ----
/** B: 새로 실행하는 비중 변형(069500:위성 = 60:40)과 그 정수 주 모의의 위성 평가 상한(= 위성 목표 + 10%p). */
export const BC_B_WEIGHT = 0.4;
export const BC_B_SAT_CAP = 0.5;
/** B의 R 통과 기준(이번 사전등록에서 새로 정함): R3 CAGR 백분위 하한. R1·R2는 B&H 가격 전 기간 CAGR 초과. */
export const BC_R3_MIN_PCTILE = 95;
/** C: 069500 월말 원 종가 이동평균 개월 수(기본, R1 이웃값), C2의 "위" 노출. */
export const BC_C_MA_MONTHS = 10;
export const BC_C_R1_MA_MONTHS = [8, 12] as const;
export const BC_C2_EXPOSURE = 0.7;
/** C 판정: G1 CAGR ≥ 5%, G2 일별 MDD ≤ 15%, G3 최악 12개월 ≥ −15%. */
export const BC_C_G1_MIN_CAGR = 5;
export const BC_C_G2_MAX_MDD = 15;
export const BC_C_G3_MIN_WORST12 = -15;

// ---- 연구 D (docs/research/d-frequency-prereg.md, 5194e70) ----
/** 069500 원 종가 이동평균 거래일 수(기본, R1 이웃값). */
export const D_SMA_DAYS = 20;
export const D_R1_SMA_DAYS = [10, 40] as const;
/** D3 계좌 손절 비율(고점 대비, 기본, R1 이웃값). */
export const D_STOP = 0.1;
export const D_R1_STOPS = [0.07, 0.15] as const;
/** R3 백분위 하한. */
export const D_R3_MIN_PCTILE = 95;
/** 추가 보고 구간: 2026-09-30 종가 → 2026-10-15 종가. */
export const D_RECENT_FROM = "2026-09-30";
export const D_RECENT_TO = "2026-10-15";

// ---- 연구 E (docs/research/e-new-goal-prereg.md, 9def1f0) ----
/** 보유 종목 수(기본, R1 이웃값), 1종목 상한. */
export const E_K = 10;
export const E_R1_KS = [8, 12] as const;
export const E_MAX_WEIGHT = 0.2;
/** 모멘텀 L·스킵(거래일), 52주 창 W(거래일), 창 안 행 비율 하한, E3 모멘텀 상위 비율, 60일 변동성. */
export const E_MOM_L = 252;
export const E_R1_MOM_LS = [189, 126] as const;
export const E_MOM_SKIP = 21;
export const E_HIGH_W = 252;
export const E_R1_HIGH_WS = [126, 189] as const;
export const E_MIN_ROW_RATIO = 2 / 3;
export const E3_TOP_PCT = 0.3;
export const E3_R1_TOP_PCTS = [0.2, 0.4] as const;
export const E_VOL_DAYS = 60;
export const E_VOL_MIN_DAYS = 40;
/** 외국인 20일 순매수 창, 창 안 수급 행 하한. */
export const E5_FLOW_DAYS = 20;
export const E5_FLOW_MIN_DAYS = 14;
/** 분기 영업이익 레코드 신선도(일) — 기존 스캔·smallcap과 같은 값(lib/signalScanConfig.ts SCAN_QUARTER_FRESH_DAYS). */
export const E3_QUARTER_FRESH_DAYS = 150;
/** 데이터 게이트: E5 상위 30종목 중 수급 자료 비율 연평균 하한, E3 모멘텀 상위 30% 중 SOP 계산 가능 비율 연평균 하한. */
export const E5_GATE_TOPN = 30;
export const E5_GATE_MIN_COVER = 0.9;
export const E3_GATE_MIN_COVER = 0.5;
/** 판정 기준(%): A 전 기간, B 구간(069500 원주가 대비 초과 %p, 구간 수), C 지연, D 이웃값, E R2, F R3 백분위. */
export const E_A_MIN_CAGR = 15;
export const E_A_MAX_MDD = 30;
export const E_B_EXCESS_PP = 3;
export const E_B_MIN_PERIODS = 2;
export const E_C_MIN_CAGR = 13;
export const E_C_MAX_MDD = 32;
export const E_D_MIN_CAGR = 12;
export const E_D_MAX_MDD = 35;
export const E_E_MIN_CAGR = 13;
export const E_F_MIN_PCTILE = 95;
export const E_PRIOR_TESTS = 153;

// ---- 연구 F (docs/research/f-daily-trend-prereg.md, b4378c4) ----
/** 골든크로스 이동평균(기본, R1 이웃값), 상위 업종 수, 동시 보유, 신규 진입 비중, 재진입 쿨다운(거래일). */
export const F_SHORT = 50;
export const F_LONG = 200;
export const F_R1_MAS = [[40, 150], [60, 250]] as const;
export const F_TOP_SECTORS = 3;
export const F_R1_TOPS = [2, 4] as const;
export const F_MAX_POS = 5;
export const F_R1_POS = [3, 7] as const;
export const F_ENTRY_FRAC = 0.2;
export const F_COOLDOWN = 20;
/** 손절·트레일링(진입가 대비 / 최고 종가 대비 하락 비율)과 R1 이웃값(G4 트레일링 이웃값은 기본 −30% ±5%p). */
export const F_STOP = 0.1;
export const F_R1_STOPS = [0.07, 0.13] as const;
export const F_TRAIL_G2 = 0.25;
export const F_R1_TRAIL_G2 = [0.2, 0.3] as const;
export const F_TRAIL_G4 = 0.3;
export const F_R1_TRAIL_G4 = [0.25, 0.35] as const;
/** 판정: A 초과 CAGR %p, B 충족 구간 수, C 지연 시 CAGR 하락·MDD 악화 한도 %p, E 대체 거래 수, F 백분위. */
export const F_A_EXCESS_PP = 2;
export const F_B_MIN_PERIODS = 2;
export const F_C_MAX_CAGR_DROP = 1;
export const F_C_MAX_MDD_WORSEN = 2;
export const F_E_TOP_TRADES = 3;
export const F_F_MIN_PCTILE = 95;
/** 이번 라운드 후보 수·직전 누적 시험, 보고용: 상위 거래 수, 장기 보유 거래일. */
export const F_TESTS = 4;
export const F_PRIOR_TESTS = 157;
export const F_TOP_TRADES_N = 10;
export const F_LONG_HOLD_DAYS = 250;

// ---- 연구 H (docs/research/h-divergence-impulse-prereg.md, da471da) ----
/** MACD(12,26,9)·주봉 임펄스용 EMA 기간, 일봉 목표 채널 EMA. 일봉 인덱스 60 미만·주봉 인덱스 35 미만은 지표를 쓰지 않는다(초기값 영향). */
export const H_MACD_FAST = 12;
export const H_MACD_SLOW = 26;
export const H_MACD_SIGNAL = 9;
export const H_WEEKLY_EMA = 13;
export const H_TARGET_EMA = 26;
export const H_DAILY_WARMUP_ROWS = 60;
export const H_WEEKLY_VALID_FROM = 35;
/** 다이버전스: A·C 런 간격(거래일, 기본·R1 이웃값), 목표 채널(EMA26 위 비율), 시간 청산(거래일). */
export const H_GAP = 60;
export const H_R1_GAPS = [40, 80] as const;
export const H_TARGET_CH = 0.06;
export const H_R1_TARGETS = [0.05, 0.07] as const;
export const H_TIME_DAYS = 60;
export const H_R1_TIMES = [40, 80] as const;
/** 표본 게이트(전 기간 진입 건수 하한), 이번 라운드 후보 수·직전 누적 시험. */
export const H_MIN_ENTRIES = 100;
export const H_TESTS = 4;
export const H_PRIOR_TESTS = 161;
/** F 연구 G4 로그(run 39728013417) — 같은 엔진 재현 확인용. [CAGR %, MDD %] */
export const H_REPRO_G4: Record<string, [number, number]> = { 학습: [4.96, 21.35], 확인: [9.17, 40.51], 보류: [10.58, 26.64], "전 기간": [7.87, 40.51] };

// ---- 연구 W (docs/research/w-walkforward-prereg.md, acd11e3) ----
/** 선정 연도: 평가 첫 해, 1년 지연 변형용 직전 선정 연도(2014). */
export const W_FIRST_EVAL_YEAR = 2015;
export const W_LAG_FIRST_SELECT_YEAR = 2014;
/** 점수: 과거 구간 진입 건수 하한, Calmar의 MDD(%) 하한(0 나눗셈 방지). */
export const W_MIN_ENTRIES_SCORE = 30;
export const W_CALMAR_MDD_FLOOR_PCT = 0.01;
/** W1 격자(648점): 이동평균 (단기, 장기), 상위 업종 수, 동시 보유, 손절, 트레일링, 임펄스 필터. 순서형 좌표. */
export const W1_MA_PAIRS = [[40, 150], [50, 200], [60, 250]] as const;
export const W1_TOPS = [2, 3, 4] as const;
export const W1_POS = [3, 5, 7] as const;
export const W1_STOPS = [0.07, 0.1, 0.13] as const;
export const W1_TRAILS = [0.2, 0.25, 0.3, 0.35] as const;
export const W1_IMPULSE = [false, true] as const;
/** W2 격자(144점): 모멘텀 (기간, 건너뛰기) 개월, 업종 수, 업종당 종목 수, 가중(시총/동일), 현금 필터. */
export const W2_MOMS = [[3, 0], [6, 1], [9, 1], [12, 1]] as const;
export const W2_SECTORS = [2, 3, 4] as const;
export const W2_PER = [2, 3, 4] as const;
export const W2_WEIGHTS = ["mcap", "equal"] as const;
export const W2_CASH_FILTER = [false, true] as const;
/** 판정: 이어 붙인 결과 기준. B 구간 분할일(앞 구간 끝), G(W1) 진입 하한, R3 횟수·참고 백분위, E 대체 개수. */
export const W_A_EXCESS_PP = 2;
export const W_B_SPLIT_END = "2019-12-31";
export const W_B_LATE_FROM = "2020-01-01";
export const W_C_MAX_CAGR_DROP = 1;
export const W_C_MAX_MDD_WORSEN = 2;
export const W_E_TOP = 3;
export const W_F_DRAWS = 200;
export const W_F_MIN_PCTILE = 95;
export const W1_MIN_ENTRIES = 100;
export const W_TESTS = 2;
export const W_PRIOR_TESTS = 165;

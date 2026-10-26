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

// ---- 연구 I (docs/research/i-rsi-volume-prereg.md, cc8881f) ----
/** RSI(Wilder) 기간·진입 임계(전일 ≤, 당일 >)·청산 임계(≥) 및 R1 이웃값. 이동평균·동시 보유·손절·진입 비율·쿨다운은 F_* 를 쓴다. */
export const I_RSI_PERIOD = 14;
export const I_R1_RSI_PERIODS = [9, 21] as const;
export const I_ENTRY_T = 40;
export const I_R1_ENTRY_TS = [35, 45] as const;
export const I_EXIT_T = 70;
export const I_R1_EXIT_TS = [65, 75, 80] as const;
/** 거래량 확인: 직전 N개 행 평균 대비 배수(신호일 거래량 ≥ 평균 × 배수), R1 이웃값. */
export const I_VOL_LOOKBACK = 20;
export const I_VOL_MULT = 1.5;
export const I_R1_VOL_MULTS = [1.2, 2.0] as const;
/** 골든크로스 후 경과 상한(거래일)·R1 이웃값, 보유 기간 상한(거래일). */
export const I_MAX_ELAPSED = 120;
export const I_R1_ELAPSED = [60, 180] as const;
export const I_TIME_DAYS = 120;
/** I5(골든크로스 당일 진입)의 RSI 상한. */
export const I5_RSI_GATE = 60;
/** RSI 과매수 청산 후 수익률을 보는 거래일 수, 상위 거래 비중 개수, 표본 게이트(전 기간 진입 건수). */
export const I_POST_EXIT_DAYS = 20;
export const I_TOP_TRADES_SHARE_N = 10;
export const I_MIN_ENTRIES = 100;
/** 이번 라운드 후보 수·직전 누적 시험. */
export const I_TESTS = 5;
export const I_PRIOR_TESTS = 167;

// ---- 연구 J (docs/research/j-turtle-prereg.md, defc459) ----
/** 시스템1(J1·J3) 진입 채널 L / 청산 채널 M, 시스템2(J2·J4), R1 이웃값 (L, M). */
export const J_SYS1 = { L: 20, M: 10 } as const;
export const J_SYS2 = { L: 55, M: 20 } as const;
export const J_R1_LM1 = [[15, 7], [30, 15]] as const;
export const J_R1_LM2 = [[40, 15], [70, 25]] as const;
/** ATR(종가 기준 |종가−전일종가| 평균) 기간, 손절 배수와 R1 이웃값. */
export const J_ATR_N = 20;
export const J_ATR_MULT = 2;
export const J_R1_ATR_MULTS = [1.5, 2.5] as const;
/** 실적 필터: 직전 분기 영업이익 전년 동기 대비 증가율 하한과 R1 이웃값, 공시 후 사용 한도(일, 기존 분기 실적 연구와 같음). */
export const J_EARN_THR = 0.25;
export const J_R1_EARN_THRS = [0.15, 0.35] as const;
export const J_EARN_STALE_DAYS = 150;
/** 연평균 커버리지(%)가 이 값 미만인 해는 실적 필터 후보 "실행 불가". */
export const J_COVERAGE_MIN_PCT = 70;
/** 표본 게이트(전 기간 진입 건수), 상위 거래 비중 개수. */
export const J_MIN_ENTRIES = 100;
export const J_TOP_TRADES_SHARE_N = 10;
/** 이번 라운드 후보 수·직전 누적 시험. */
export const J_TESTS = 4;
export const J_PRIOR_TESTS = 172;

// ---- 연구 K (docs/research/k-turtle-sizing-prereg.md, eca1c82) ----
/** 리스크 사이징: 진입 비중 w = 리스크율 ÷ (ATR 배수 × ATR20 / 진입가), 상한은 F_ENTRY_FRAC. 리스크율과 R1 이웃값. */
export const K_RISK_K1 = 0.01;
export const K_RISK_K2 = 0.005;
export const K_R1_RISK_K1 = [0.007, 0.015] as const;
export const K_R1_RISK_K2 = [0.0035, 0.007] as const;
/** K3(사이징 없음): 동시 보유 슬롯과 종목당 고정 비중. */
export const K3_SLOTS = 10;
export const K3_FRAC = 0.1;
/** 이번 라운드 후보 수·직전 누적 시험. */
export const K_TESTS = 4;
export const K_PRIOR_TESTS = 176;
/** J 연구 로그의 J2(run 39802050442) — 같은 엔진 재현 확인용. [CAGR %, MDD %] */
export const K_REPRO_J2: Record<string, [number, number]> = { 학습: [3.76, 43.12], 확인: [37.02, 44.08], 보류: [9.2, 58.02], "전 기간": [14.7, 65.89] };

// ---- 연구 M (docs/research/m-breadth-prereg.md, 9c5e24a) ----
/** 시장 폭 필터: B50 진입 임계(≥)와 R1 이웃값, M2 시장 청산 임계(< 이면 전량 청산)와 R1 이웃값. */
export const M_B50_ENTRY = 40;
export const M_R1_B50_ENTRY = [30, 50] as const;
export const M_B50_EXIT = 20;
export const M_R1_B50_EXIT = [15, 25] as const;
/** M3: NH(55일 신고가 수 − 신저가 수) > 임계. M4: B200 ≥ 임계, B200이 정의되는 첫 날(그날 K200P 중 200일선 정의 종목이 95% 이상). */
export const M_NH_THR = 0;
export const M_R1_NH = [-5, 5] as const;
export const M_B200_THR = 50;
export const M_R1_B200 = [40, 60] as const;
export const M_B200_FIRST = "2010-11-15";
/** R1 동시 보유 이웃값(K3의 기본은 K3_SLOTS = 10, 종목당 K3_FRAC), 시장 청산 후 K3 기준 수익률을 보는 거래일 수. */
export const M_R1_POS = [7, 13] as const;
export const M_POST_EXIT_DAYS = 20;
/** 이번 라운드 후보 수·직전 누적 시험. */
export const M_TESTS = 4;
export const M_PRIOR_TESTS = 180;
/** K 연구 로그의 K3(run 39803792355) — 같은 엔진 재현 확인용. [CAGR %, MDD %] */
export const M_REPRO_K3: Record<string, [number, number]> = { 학습: [4.62, 31.93], 확인: [29.48, 31.54], 보류: [5.8, 44.08], "전 기간": [12.06, 49.56] };

// ---- 연구 N (docs/research/n-book-canon-prereg.md, 6ce21dd) ----
/** 수집 결과 저장 위치(버킷은 INVESTOR_FLOW_STOCK_STORE_BUCKET). */
export const N_STORE_PREFIX = "research/n_book";
/** 추가 저장 총량 상한(MiB), 전 버킷 합계 상한(바이트는 SC_COLLECT_STORAGE_CAP_BYTES 재사용: 800 MiB). */
export const N_ADD_STORAGE_MIB = 150;
/** DART 키당 하루(KST 일자) 호출 상한, 회차 소프트 데드라인(시간), 요청 사이 간격(ms), 체크포인트 주기. */
export const N_DART_DAILY_PER_KEY = 18_000;
export const N_RUN_SOFT_HOURS = 4.6;
export const N_DART_GAP_MS = 150;
export const N_CHECKPOINT_CALLS = 300;
export const N_CHECKPOINT_MS = 10 * 60e3;
/** 소속 구간 앞 여유(달력일): 처음 K200P였던 날보다 이만큼 이전 접수분부터 본문을 받는다. */
export const N_SPAN_LEAD_DAYS = 200;
/** 소속 종료일이 데이터 끝에서 이 일수 이내면 아직 소속 중으로 본다. */
export const N_SPAN_OPEN_DAYS = 30;
/** 구조화 API 시작일, 목록 시작일(2010-01-01). */
export const N_STRUCT_FROM = "20150101";
export const N_LIST_FROM = "20100101";
/** 파싱 실패율 한도(초과 시 해당 항목 후보 실행 불가). */
export const N_PARSE_FAIL_MAX = 0.1;
/** KIS 보완: 하루 호출 상한, 재시도 대기(초), 구간 병합 간격·앞쪽 여유(거래일), 호출 금지 UTC 분 범위(14:00~15:40 KST). */
export const N_KIS_DAILY_CAP = 3_000;
export const N_KIS_RETRY_WAITS_SEC = [5, 15, 60] as const;
export const N_KIS_MERGE_GAP = 20;
export const N_KIS_LEAD_DAYS = 20;
export const N_KIS_BLOCK_UTC_FROM_MIN = 5 * 60;
export const N_KIS_BLOCK_UTC_TO_MIN = 6 * 60 + 40;
/** N 단계 1(d) KIS 수급 보완: 시험 평가 구간(2015-01-05~)의 P1이 쓰는 20일 합을 만들 수 있게 이 날짜 이후의 K200P 소속 종목-일만 본다. */
export const N_KIS_FROM = "2014-12-01";
/** N DART 수집: 요청 한 건의 응답 대기 상한(밀리초). 걸리면 실패로 보고 재시도한다. */
export const N_DART_FETCH_TIMEOUT_MS = 30_000;

// ===== N 단계 2: 후보 P1~P10 (docs/research/n-book-canon-prereg.md) =====
export const N_TESTS = 10;
export const N_PRIOR_TESTS = 184;
/** 평가 구간: 2015-01-02 종가에 현금 100%로 시작, 수익률은 2015-01-05부터 센다. 구간 구분은 [이름, 시작, 끝]. */
export const N_EVAL_START = "2015-01-02";
export const N_EVAL_FROM = "2015-01-05";
export const N_SUBPERIODS: readonly (readonly [string, string, string])[] = [["2015~2016", "2015-01-05", "2016-12-31"], ["2017~2021", "2017-01-01", "2021-12-31"], ["2022~", "2022-01-01", "9999-12-31"]];
/** M 연구 로그(run 8bd1ba2)의 M3: 구간별 [CAGR %, MDD %]. 재현 확인용(시험 횟수에 넣지 않음). */
export const N_REPRO_M3: Record<string, readonly [number, number]> = { "학습": [2.82, 34.39], "확인": [24.13, 31.24], "보류": [10.42, 34.82], "전 기간": [11.24, 35.41] };
export const N_MIN_ENTRIES = 100;
/** 게이트 H(P1~P7): M3 기준선 대비 [CAGR +1%p 이상 ∧ MDD 악화 1%p 이하] 또는 [MDD 3%p 이상 낮음 ∧ CAGR 하락 1%p 이하]. */
export const N_H_CAGR_GAIN_PP = 1;
export const N_H_MDD_WORSEN_PP = 1;
export const N_H_MDD_GAIN_PP = 3;
export const N_H_CAGR_LOSS_PP = 1;
/** P1 수급: 최근 W거래일(판단일 포함)에 수급 행이 W×비율 이상(올림)이고 (외국인+기관 순매수금액) 합 > 0. */
export const N_FLOW_WIN = 20;
export const N_FLOW_MIN_RATIO = 0.7;
export const N_R1_FLOW_WINS = [10, 40] as const;
/** P2 희석 회피: 최근 N거래일(접수일 순번 e가 c−N ≤ e < c)에 유상증자·CB·BW 결정 공시가 있으면 진입 금지. */
export const N_DIL_DAYS = 120;
export const N_R1_DIL_DAYS = [60, 180] as const;
/** P3 실적: 직전 분기 영업이익 전년 동기 대비 증가율 ≥ 임계(전년 동기 영업이익 > 0), 접수일 < 판단일, 접수일이 판단일보다 STALE일 넘게 이전이면 자료 없음. */
export const N_EARN_THR = 0.25;
export const N_R1_EARN_THR = [0.15, 0.35] as const;
export const N_EARN_STALE_DAYS = 150;
/** P4 거래량: 신호일 거래량 ≥ 직전 N개 행 평균 × 배수. */
export const N_VOL_AVG_ROWS = 20;
export const N_VOL_MULT = 1.5;
export const N_R1_VOL_MULT = [1.2, 2.0] as const;
/** P5 내부자: 최근 N거래일에 접수된 비정정 소유보고의 보통주 장내매수−장내매도 수량 합 > 0. */
export const N_INS_DAYS = 60;
export const N_R1_INS_DAYS = [30, 90] as const;
export const N_INS_BUY_REASON = "장내매수";
export const N_INS_SELL_REASON = "장내매도";
export const N_INS_KIND = "보통주";
/** P6 공급계약: 최근 N거래일에 접수된 비정정 단일판매·공급계약 중 매출액 대비 % ≥ 임계인 것이 있음. */
export const N_SUP_DAYS = 20;
export const N_R1_SUP_DAYS = [10, 40] as const;
export const N_SUP_RATIO_PCT = 10;
export const N_R1_SUP_RATIO_PCT = [5, 20] as const;
/** P7 CAN SLIM의 L: K200P 종목 중 6개월 수익률 순위 비율(더 높은 종목 수 ÷ 정의된 종목 수) < 임계. */
export const N_L_MONTHS = 6;
export const N_L_TOP = 0.2;
export const N_R1_L_TOP = [0.1, 0.3] as const;
/** P8 미너비니 추세 템플릿. 52주 = 종목 최근 252행 종가. */
export const N_SMA_FAST = 50;
export const N_SMA_MID = 150;
export const N_SMA_SLOW = 200;
export const N_SMA_SLOPE_ROWS = 20;
export const N_ROWS_52W = 252;
export const N_LOW52_MULT = 1.3;
export const N_HIGH52_RATIO = 0.75;
export const N_R1_HIGH52_RATIO = [0.7, 0.8] as const;
/** P9 코너스 RSI2. */
export const N_RSI_PERIOD = 2;
export const N_RSI_IN = 10;
export const N_R1_RSI_IN = [5, 15] as const;
export const N_RSI_OUT = 70;
export const N_R1_RSI_OUT = [60, 80] as const;
export const N_RSI_HOLD_DAYS = 5;
export const N_RSI_STOP_MULT = 0.92;
export const N_RSI_SMA = 200;
/** P10 와인스타인 Stage 2. */
export const N_S2_SMA = 150;
export const N_R1_S2_SMA = [100, 200] as const;
export const N_S2_SLOPE_ROWS = 20;
/** N DART 본문 수집: 동시에 보내는 요청 수(호출 간격과 키별 하루 상한은 그대로). */
export const N_DART_DOC_CONCURRENCY = 4;

// ===== Q: 유니버스 확장(KOSPI+KOSDAQ)과 독립 재현 Q1~Q3 (docs/research/q-universe-prereg.md) =====
export const Q_TESTS = 3;
export const Q_PRIOR_TESTS = 194;
/** Q1·Q3 유니버스: 시총(억 원) 하한. 가격 Parquet의 marketCapEok 단위. */
export const Q_MCAP_MIN_EOK = 5000;
/** Q2 유니버스: 전 시장 시총 순위(1부터) 범위. */
export const Q_RANK_FROM = 201;
export const Q_RANK_TO = 500;
/** 슬리피지(매수·매도 각). Q1·Q3은 기존 0.1%, Q2는 0.2%. */
export const Q_SLIPPAGE_Q1 = 0.001;
export const Q_SLIPPAGE_Q2 = 0.002;
/** 업종 보유율(시총 비율) 연도 평균이 이 값(%) 미만인 해가 있으면 그 유니버스의 후보는 실행 불가(J_COVERAGE_MIN_PCT와 같은 기준). */
export const Q_COVERAGE_MIN_PCT = 70;
/** D 이웃값: 상위 업종 수. */
export const Q_R1_TOPK = [2, 4] as const;
/** 체결 가능성 보고: 진입 금액 ÷ 20일 평균 거래대금 경고 비율, 기준 시드(원). */
export const Q_ORDER_RATIO_FLAGS = [0.01, 0.05] as const;
export const Q_ORDER_SEED_WON = 10_000_000;

// ===== Q2 재시험: 업종 보완 수집(docs/research/q2-sector-fill-prereg.md) =====
export const Q2F_STORE_PATH = "research/q2_sector_fill/induty.parquet";
export const Q2F_PROGRESS_PATH = "research/q2_sector_fill/_progress.json";
/** DART company.json 호출 총 상한(재시도 포함), 호출 간격, 재시도 횟수·대기(ms). */
export const Q2F_CALL_CAP = 3000;
export const Q2F_GAP_MS = 150;
export const Q2F_RETRY_WAITS_MS = [1000, 2000] as const;
export const Q2F_FETCH_TIMEOUT_MS = 30_000;
/** 보완 파일 크기 상한(MiB). */
export const Q2F_MAX_MIB = 5;
export const Q2F_TESTS = 2;
export const Q2F_PRIOR_TESTS = 197;
/** 비교용 참조값(연구 Q 결과): Q3 전 기간 [CAGR %, MDD %]. K200P M3는 N_REPRO_M3["전 기간"]. */
export const Q2F_REF_Q3: readonly [number, number] = [10.86, 36.68];

// ===== R: 전체 상장사 재무 재수집 + 소형주·품질·가치 조합 R0~R4 (docs/research/r-allcap-fundamentals-prereg.md) =====
export const R_STORE_PREFIX = "research/r_allcap";
/** 사업연도 범위와 보고서 코드(1분기·반기·3분기·사업). */
export const R_YEAR_FROM = 2014;
export const R_YEAR_TO = 2025;
export const R_REPRT_CODES = ["11013", "11012", "11014", "11011"] as const;
/** 수집할 주요 계정 이름(공백 제거 후 일치). */
export const R_ACCOUNTS = ["매출액", "영업이익", "당기순이익", "자산총계", "부채총계", "자본총계"] as const;
/** DART 호출 한도: 키당 하루, 총합(재시도·파일럿 포함), 호출 간격, 동시 요청 수, 응답 대기 상한, 재시도 대기(ms). */
export const R_DAILY_PER_KEY = 18_000;
export const R_TOTAL_CALL_CAP = 100_000;
export const R_GAP_MS = 150;
export const R_CONCURRENCY = 4;
export const R_FETCH_TIMEOUT_MS = 120_000;
export const R_RETRY_WAITS_MS = [1000, 2000] as const;
export const R_SOFT_HOURS = 4.6;
export const R_CHECKPOINT_CALLS = 400;
export const R_CHECKPOINT_MS = 600_000;
export const R_MULTI_BATCH = 100;
/** 추가 저장 상한(MiB)과 Storage 전 버킷 합계 상한은 SC_COLLECT_STORAGE_CAP_BYTES. */
export const R_ADD_STORAGE_MIB = 50;
/**
 * 재수집(순이익 계정명 수정, 환경변수 R_REFETCH_FIN=1) 전용: 수정 식별자(진행 파일에 기록해 이어서 재개), 체크포인트 간격(fin.parquet만 올림),
 * 이 스크립트가 읽고 쓰는 Storage 전송량 상한(MiB; 사용자 지정 총 200MiB 중 재수집 몫, 검증 재실행 몫은 별도로 남겨 둔다).
 */
export const R_FIX_ID = "ni-name-v1";
export const R_FIX_CHECKPOINT_CALLS = 700;
export const R_FIX_CHECKPOINT_MS = 3_600_000;
export const R_FIX_TRANSFER_CAP_MIB = 120;
// 재수집 계획 계산용 가정(보고 전용, 호출에는 쓰이지 않음). 출처: 2026-10-25~26 실측 — 다중회사 API 약 1,356건/4.2시간(동시 4) ≈ 11초/건, 단일/company.json류 1,355건/약 4분 ≈ 0.18초/건
export const R_PLAN_SEC_PER_MULTI = 11;
export const R_PLAN_SEC_PER_SINGLE = 0.18;
/** 파일럿: 회사 수, 사업연도, 가격 행 기준일, 일치 기준(비율). */
export const R_PILOT_N = 20;
export const R_PILOT_YEAR = 2023;
export const R_PILOT_DATE = "2023-12-28";
export const R_PILOT_MATCH_MIN = 0.995;
/** corp_code 매핑 없는 종목 비율 상한. */
export const R_UNMAPPED_MAX = 0.1;
/** 재무 지표 사용 기간 상한(접수일 이후 일수), 수익성·성장 임계. */
export const R_STALE_DAYS = 200;
export const R_ROE_MIN = 0.08;
export const R_R1_ROE = [0.06, 0.1] as const;
export const R_GROWTH_MIN = 0.25;
export const R_R1_GROWTH = [0.15, 0.35] as const;
/** 소형주 유니버스(억 원, 억 원, 원) 와 대형 유니버스. */
export const R_SMALL_MCAP_MIN_EOK = 1000;
export const R_SMALL_MCAP_MAX_EOK = 5000;
export const R_SMALL_TV_MIN_WON = 200_000_000;
export const R_SMALL_PRICE_MIN_WON = 1000;
export const R_SMALL_SLIPPAGE = 0.002;
export const R_LARGE_SLIPPAGE = 0.001;
export const R_COVERAGE_MIN_PCT = 70;
export const R_TESTS = 5;
export const R_PRIOR_TESTS = 199;
/** H 게이트: 필터 정보 가치. */
export const R_H_CAGR_GAIN_PP = 2;
export const R_H_MDD_WORSEN_PP = 1;
export const R_H_MDD_GAIN_PP = 5;
export const R_H_CAGR_LOSS_PP = 1;
export const R_ORDER_RATIO_FLAG = 0.01;

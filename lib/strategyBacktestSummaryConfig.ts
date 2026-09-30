import type { MaCrossParams, MinerviniParams, StrategyRuleType } from "@/lib/backtest";

/**
 * "장기 백테스트(2016~오늘)" 캐시 배치(scripts/compute-strategy-backtest-summary.ts)와
 * 그 결과를 보여주는 UI(components/StrategyManager.tsx)가 공유하는 기준값. 매직넘버
 * 없이 이 파일 하나만 보면 값을 감사할 수 있게 한다(RULES.md 2번).
 */

// 장기 백테스트 대상 rule_type. custom_composite는 사용자마다 조건이 다른 실험
// 전략이라 "대표 전략" 개념이 성립하지 않아 제외한다(2026-09-27 계획 승인). 배치
// 스크립트와 UI가 같은 목록을 써야 "아직 계산 전" 카드를 빠짐없이 보여줄 수 있어
// 여기 하나로 모은다.
export const STRATEGY_BACKTEST_TARGET_RULE_TYPES = [
  "ma_cross",
  "minervini_trend_template",
  "reversal_breakout",
  "reversal_breakout_v2",
  "peg_lynch",
] as const satisfies readonly StrategyRuleType[];

// 2026-09-24 진단 스크립트(diagnose-strategy-daily-returns.ts 계열)가 쓴 것과 동일한
// 시작 연도 — peg_lynch 펀더멘털 백필 후보 기준(discoverCandidateStockCodes)과 맞춰
// 그 이후 계속 비교 가능하게 유지한다.
export const STRATEGY_BACKTEST_WINDOW_START_YEAR = 2016;

// 종목별 "자체 복리수익률" 상위 이 개수를 제외한 뒤 재계산해, 소수 종목 의존도를
// 확인한다(diagnose-strategy-return-concentration.ts가 쓴 8개보다 적게 잡은 이유:
// 여긴 상시 노출되는 화면용 단일 지표라 "상위 몇 개만 빼도 흔들리는지"를 더 엄격하게
// 보기 위해 5로 좁혔다 — 2026-09-27 사용자 승인).
export const STRATEGY_BACKTEST_TOP_EXCLUDE_COUNT = 5;

// top5_exclude_return_pct(연환산, cagr_pct와 동일 스케일)가 cagr_pct와 부호가
// 다르거나, |top5_exclude - cagr| >= |cagr| * 이 비율이면 "소수 종목 의존" 경고를
// 표시한다. 0.5 = 상위 5개를 뺐을 때 연환산 수익률이 절반 이상 바뀌면 경고.
export const STRATEGY_BACKTEST_CONCENTRATION_WARNING_RATIO = 0.5;

// forced_liquidation_ratio(강제청산 건수/전체 거래 건수)가 이 값 이상이면 "강제청산
// 비중 높음" 안내를 표시한다. 강제청산 거래는 실제 매도 판단이 아니라 백테스트
// 기간 종료 시점에 임의로 닫힌 것이라, 이게 많이 섞인 승률/수익률은 정상 매도만
// 있는 다른 전략과 직접 비교하면 오해할 수 있다(peg_lynch가 max_holding_days가
// 없어 특히 잘 걸리는 사례 — 2026-09-27 사용자 요청).
export const STRATEGY_BACKTEST_HIGH_FORCED_LIQUIDATION_RATIO_THRESHOLD = 0.2;

// ma_cross/minervini_trend_template은 strategies 테이블(market='KR')에 활성 행이
// 없을 때 쓰는 임시 기본값. diagnose-strategy-daily-returns.ts/
// diagnose-strategy-return-concentration.ts가 2026-09-24 사용자 확인을 받아 쓴 값과
// 동일하게 유지한다 — 두 전략은 peg_lynch/reversal_breakout과 달리 rule_params가
// 사용자 개인화 값이라 서버 설정 상수(lib/pegConfig.ts류)가 없다.
export const FALLBACK_MA_CROSS_PARAMS: MaCrossParams = { short_period: 20, long_period: 60 };
export const FALLBACK_MINERVINI_PARAMS: MinerviniParams = { ma_short: 50, ma_mid: 150, ma_long: 200 };

// strategy_backtest_summary/benchmark_summary 행이 어떤 원자료 확장 단계에서 계산됐는지
// 구분하는 data_widen_stage 값. 'narrow'(전종목 재백필 전 기존 행), 'partial_2023_2026'
// (재백필 도중 계산된 중간 상태 행), 'full'(2015~2026 재백필 완료 후 행). 배치는 기본적으로
// 'full'로 저장하고(환경변수 DATA_WIDEN_STAGE로 재정의 가능 — 재백필 도중 시험 실행용),
// 화면 API는 'full' 행을 우선 보여주고 없으면 'narrow' 행을 보여준다(중간 상태는 숨김).
//
// 2026-09-30 결정 변경: 원자료를 넓힌 직후 수치는 분할·병합 보정 전 원가 기준이고 유니버스도
// 아직 사후 선정(1조원 이상 이력) 기반이라 화면에 내보내지 않는다. 배치는 기본적으로
// 'wide_unadjusted'로 저장하고(화면에서 숨김), 조정계수 적용 후 'full'로 올린다.
//
// 2026-09-30 추가 결정: 유니버스를 사후 1조 선정에서 시점별 전 종목(point-in-time)으로
// 교체했다. 이 유니버스 결과는 분할·병합 보정 전이라 'pit_unadjusted'로 저장(화면 숨김).
export const STRATEGY_BACKTEST_DATA_WIDEN_STAGE_DEFAULT = "pit_unadjusted";
export const STRATEGY_BACKTEST_DATA_WIDEN_STAGE_PUBLISHED = "full";
export const STRATEGY_BACKTEST_DATA_WIDEN_STAGE_FALLBACK = "narrow";

// 시점별(point-in-time) 유니버스의 유동성 필터(2026-09-30 팀장 결정): 진입 판단일 직전
// PIT_LIQUIDITY_LOOKBACK_DAYS 거래일 평균 거래대금(원)이 기준 이상인 종목만 그날 진입
// 후보로 삼는다. 5억원이 기본, 1억/10억은 벤치마크 민감도로만 계산한다.
export const PIT_LIQUIDITY_LOOKBACK_DAYS = 20;
export const PIT_MIN_AVG_TRADING_VALUE_WON = 500_000_000;
export const PIT_LIQUIDITY_SENSITIVITY_WON = [
  { label: "liq_1e8", minAvgTradingValueWon: 100_000_000 },
  { label: "liq_1e9", minAvgTradingValueWon: 1_000_000_000 },
] as const;

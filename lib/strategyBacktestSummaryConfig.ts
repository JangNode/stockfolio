import type { StrategyRuleType } from "@/lib/backtest";

/**
 * "장기 백테스트(2016~오늘)" 캐시 배치(scripts/compute-strategy-backtest-summary.ts)와
 * 그 결과를 보여주는 UI(components/StrategyManager.tsx)가 공유하는 기준값. 매직넘버
 * 없이 이 파일 하나만 보면 값을 감사할 수 있게 한다(RULES.md 2번).
 */

// 장기 백테스트 대상 rule_type(운영 전략 3개). 배치 스크립트와 UI가 같은 목록을 써야
// "아직 계산 전" 카드를 빠짐없이 보여줄 수 있어 여기 하나로 모은다.
export const STRATEGY_BACKTEST_TARGET_RULE_TYPES = [
  "ma_cross",
  "reversal_breakout_v2",
  "peg_lynch",
] as const satisfies readonly StrategyRuleType[];

// 2026-10 전략 정리로 운영을 종료한 전략. 더 이상 계산하지 않고, DB에 남아 있는 마지막 검증
// 결과(STRATEGY_BACKTEST_DISPLAY_STAGE 행)를 "종료된 전략" 섹션에서 읽기 전용으로만 보여준다.
// 라벨·표시 순서는 이 배열이 기준이다. custom_composite는 백테스트 행이 없어 제외했다.
export const STRATEGY_BACKTEST_ENDED_STRATEGIES = [
  { ruleType: "minervini_trend_template", label: "미너비니 트렌드 템플릿" },
  { ruleType: "reversal_breakout", label: "급등주 찾기 v1 (역배열 반등)" },
] as const;

// 2026-09-24 진단 스크립트(diagnose-strategy-daily-returns.ts 계열)가 쓴 것과 동일한
// 시작 연도 — peg_lynch 펀더멘털 백필 후보 기준(discoverCandidateStockCodes)과 맞춰
// 그 이후 계속 비교 가능하게 유지한다.
// 백테스트 시작 연도 앞에서 미리 읽어 둘 시세 연수. 이동평균 448봉(약 2년) 워밍업이 시작일에 이미 끝나 있게 한다
// (2026-10-07 기본 로드 시작을 2011 → 시작 연도 -2로 조정: 2011~2014 파일이 전종목으로 바뀌며 늘어난 메모리 절감).
export const STRATEGY_BACKTEST_PRICE_FETCH_LOOKBACK_YEARS = 2;

// KRX 일별매매정보로 받을 수 있는 가장 이른 연도(2010-01-04부터 조회됨, 2009-12-30 이전은 빈 응답 — 2026-10-06 실측).
export const STOCK_DATA_EARLIEST_YEAR = 2010;

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
//
// 2026-09-30 분할·병합 조정계수 적용 후: 배치 기본 저장값은 'pit_adjusted'(팀장 확인 후 'full'로
// 올릴 때까지 화면 숨김).
export const STRATEGY_BACKTEST_DATA_WIDEN_STAGE_DEFAULT = "pit_adjusted";
export const STRATEGY_BACKTEST_DATA_WIDEN_STAGE_PUBLISHED = "full";
export const STRATEGY_BACKTEST_DATA_WIDEN_STAGE_FALLBACK = "narrow";

// 화면(app/api/strategies/backtest-summary)이 읽는 data_widen_stage. 이 값 한 줄만 바꾸면
// 되돌릴 수 있다(예: 승격 전 화면은 "narrow"). 2026-10-06 사용자 결정으로 시총 5천억 PIT
// + 비용 반영 + 액면조정 결과('pit_adjusted_cap5000')를 화면 기본값으로 올렸다. 다른 stage
// 행은 DB에 그대로 남아 있다(삭제하지 않음). 'narrow'를 가리킬 땐 stage가 비어 있는 기존
// 행도 함께 읽는다.
export const STRATEGY_BACKTEST_DISPLAY_STAGE: string = "pit_adjusted_cap5000";

// 화면 상단 벤치마크 카드로 보여줄 benchmark_summary.benchmark_type과 표시명. kospi/kosdaq은
// 가격지수(배당 미포함), universe_monthly_rebalance는 같은 유니버스·기간의 월간 리밸런싱
// 동일가중(비용 반영)이라 전략의 "벤치마크 열세/우세" 비교 기준이 된다.
export const STRATEGY_BACKTEST_UNIVERSE_BENCHMARK_TYPE = "universe_monthly_rebalance";
export const STRATEGY_BACKTEST_BENCHMARK_CARDS = [
  { type: STRATEGY_BACKTEST_UNIVERSE_BENCHMARK_TYPE, label: "유니버스 동일가중 월간 리밸런싱(비용 반영)" },
  { type: "kospi", label: "KOSPI(가격지수)" },
  { type: "kosdaq", label: "KOSDAQ(가격지수)" },
] as const;

// "표본 적음" 배지 기준: 총 거래 수가 (이 값 × 백테스트 기간 연수)보다 적으면 붙인다. 2026-10-06
// peg_lynch 검증에서 사전 고정한 "연도별 거래 20건 이상"과 같은 값이다(연도별 거래 수는 DB에
// 저장돼 있지 않아 총 거래 수를 연수로 환산해 비교한다).
export const STRATEGY_BACKTEST_MIN_TRADES_PER_YEAR = 20;

// 신호가 특정 시점 이후에만 가능한 전략의 안내. peg_lynch: DART 재무제표 API가 FY2015부터만
// 제공되고(FY2014는 데이터 없음) PEG의 EPS 성장률이 5년 전 동일 연결/별도 기준 값을 요구해서
// (lib/pegConfig.ts PEG_GROWTH_LOOKBACK_YEARS) 첫 신호가 FY2020 공시(2021-03) 이후다.
export const STRATEGY_BACKTEST_SIGNAL_LIMITED_FROM: Partial<Record<StrategyRuleType, string>> = {
  peg_lynch: "2021-03",
};

// 시점별(point-in-time) 유니버스의 유동성 필터(2026-09-30 팀장 결정): 진입 판단일 직전
// PIT_LIQUIDITY_LOOKBACK_DAYS 거래일 평균 거래대금(원)이 기준 이상인 종목만 그날 진입
// 후보로 삼는다. 5억원이 기본, 1억/10억은 벤치마크 민감도로만 계산한다.
export const PIT_LIQUIDITY_LOOKBACK_DAYS = 20;
export const PIT_MIN_AVG_TRADING_VALUE_WON = 500_000_000;
export const PIT_LIQUIDITY_SENSITIVITY_WON = [
  { label: "liq_1e8", minAvgTradingValueWon: 100_000_000 },
  { label: "liq_1e9", minAvgTradingValueWon: 1_000_000_000 },
] as const;

"use client";

import { useMemo } from "react";
import useSWR from "swr";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type { StrategyRule, StrategyRuleType } from "@/lib/backtest";
import { isOperatingRuleType } from "@/lib/strategyVersions";
import { useMarket } from "@/components/MarketContext";
import { MARKET_LABELS, type Market } from "@/lib/market";
import SubTabs, { STRATEGY_BACKTEST_TABS } from "@/components/SubTabs";
import {
  computeScreeningResultStats,
  type ScreeningResultStatRow,
  type ScreeningResultStats,
} from "@/lib/screeningResultStats";
import { formatPercent } from "@/lib/formatNumber";
import { authJsonFetcher } from "@/lib/authFetch";
import {
  STRATEGY_BACKTEST_WINDOW_START_YEAR,
  STRATEGY_BACKTEST_TARGET_RULE_TYPES,
  STRATEGY_BACKTEST_ENDED_STRATEGIES,
  STRATEGY_BACKTEST_CONCENTRATION_WARNING_RATIO,
  STRATEGY_BACKTEST_HIGH_FORCED_LIQUIDATION_RATIO_THRESHOLD,
  STRATEGY_BACKTEST_BENCHMARK_CARDS,
  STRATEGY_BACKTEST_UNIVERSE_BENCHMARK_TYPE,
  STRATEGY_BACKTEST_MIN_TRADES_PER_YEAR,
  STRATEGY_BACKTEST_SIGNAL_LIMITED_FROM,
} from "@/lib/strategyBacktestSummaryConfig";
import { benchmarkVerdict, isLowSampleSize } from "@/lib/strategyBacktestBadges";

export type StrategyRow = StrategyRule & {
  id: string;
  name: string | null;
  market: Market;
  created_at: string;
};

const RULE_TYPE_LABELS: Record<StrategyRuleType, string> = {
  ma_cross: "이평선 골든/데드크로스",
  peg_lynch: "피터린치 PEG전략",
  reversal_breakout_v2: "급등주 찾기 v2 (역배열 반등 - 강화)",
};

const STRATEGY_DESCRIPTIONS: Record<StrategyRuleType, string> = {
  ma_cross:
    "단기 이동평균선이 장기 이동평균선을 아래에서 위로 뚫고 올라가는 골든크로스가 발생하면 매수 신호로, 반대로 위에서 아래로 뚫고 내려가는 데드크로스가 발생하면 매도 신호로 판단합니다.",
  peg_lynch:
    "피터 린치의 PEG(주가수익성장비율) 지표를 쓰는 전략입니다. 적자기업은 제외하고, PEG(=PER÷최근 5년 EPS 성장률)가 기준값 이하인 저평가 성장주를 point-in-time 재무 데이터로 판정합니다. 기준값은 서버 설정(lib/pegConfig.ts)에서 관리됩니다.",
  reversal_breakout_v2:
    "역배열(하락 추세) 상태에서 바닥을 다지다 대량 거래를 동반한 반등이 시작되는 시점을 포착하는 전략입니다. ① 최근 60거래일 중 90% 이상 이동평균이 역배열(20일선<60일선<112일선<244일선<448일선)이었고, ② 최근 20거래일 내 거래량이 직전 평균 대비 3배 이상인 양봉(매집봉)이 있었으며, ③ 현재가가 20일선을 최근 5거래일 이내에 돌파했으면 신호로 판단합니다. 기준값은 서버 설정(lib/reversalBreakoutConfig.ts)에서 관리됩니다.",
};

// 종료된 신호 수가 이보다 적으면 승률/평균·중앙값 수익률이 통계적으로 신뢰하기
// 어려워 "표본 부족" 배지를 붙인다.
const MIN_CLOSED_SAMPLES_FOR_RELIABLE_STATS = 10;

// 전략 성과 비교 섹션 조회용 최소 필드.
interface ScreeningComparisonRow {
  strategy_id: string;
  status: "active" | "stopped" | "profited" | "price_unavailable" | "price_anomaly";
  return_pct: number;
  matched_at: string;
}

function formatPct(value: number | null): string {
  return value === null ? "-" : formatPercent(value);
}

// screening_results 조회 시 Supabase 기본 상한(1000행)에 걸리지 않도록 넉넉히 잡는
// 상한. 신호가 많은 전략은 1000건에 닿아 기본값으로는 잘린다.
const SCREENING_RESULTS_FETCH_LIMIT = 4999;

// "장기 백테스트(2016~오늘)" 섹션 — scripts/compute-strategy-backtest-summary.ts가
// 매주 재계산해 strategy_backtest_summary에 쌓아둔 캐시를 읽는다. 실계좌 스크리닝
// 추적 기반의 위 "전략 성과 비교"와는 별개 지표라 섹션을 분리했다.
interface StrategyBacktestSummaryRow {
  rule_type: string;
  market: Market;
  period_start_date: string;
  period_end_date: string;
  computed_at: string;
  universe_stock_count: number;
  win_rate: number | null;
  avg_return_pct: number | null;
  median_return_pct: number | null;
  mdd_pct: number | null;
  cagr_pct: number | null;
  total_trades: number;
  closed_trades: number;
  forced_liquidation_count: number;
  forced_liquidation_ratio: number | null;
  top5_exclude_return_pct: number | null;
  avg_win_pct: number | null;
  avg_loss_pct: number | null;
  payoff_ratio: number | null;
  cost_included: boolean;
  data_widen_stage: string | null;
}

interface BenchmarkSummaryRow {
  benchmark_type: string;
  period_start_date: string;
  period_end_date: string;
  computed_at: string;
  cagr_pct: number | null;
  mdd_pct: number | null;
  cost_included: boolean;
  data_widen_stage: string | null;
}

interface StrategyBacktestSummaryResponse {
  summaries: StrategyBacktestSummaryRow[];
  benchmarks: BenchmarkSummaryRow[];
}

function formatMdd(value: number | null): string {
  return value === null ? "-" : `-${value.toFixed(2)}%`;
}

/** top5_exclude_return_pct(상위 5개 제외 후 연환산 수익률)가 cagr_pct(원래 연환산
 * 수익률)와 부호가 다르거나 STRATEGY_BACKTEST_CONCENTRATION_WARNING_RATIO 이상
 * 차이나면 "소수 종목 의존"으로 판단한다. 둘 다 연환산(CAGR) 스케일이라 직접
 * 비교할 수 있다 — top5_exclude_return_pct 자체가 배치에서 이미 그렇게 저장된다. */
function isConcentrationWarning(cagrPct: number | null, top5ExcludeReturnPct: number | null): boolean {
  if (cagrPct === null || top5ExcludeReturnPct === null || cagrPct === 0) return false;
  const differentSign = Math.sign(cagrPct) !== Math.sign(top5ExcludeReturnPct);
  const diffRatio = Math.abs(top5ExcludeReturnPct - cagrPct) / Math.abs(cagrPct);
  return differentSign || diffRatio >= STRATEGY_BACKTEST_CONCENTRATION_WARNING_RATIO;
}

/** forced_liquidation_ratio가 임계값 이상이면 true — 승률에 "정상 매도"와 "기간
 * 종료로 강제 청산"이 많이 섞여 있어 다른 전략과 직접 비교하면 오해할 수 있다는
 * 신호(peg_lynch처럼 max_holding_days가 없는 전략에서 특히 자주 발생). */
function isHighForcedLiquidationRatio(forcedLiquidationRatio: number | null): boolean {
  return (
    forcedLiquidationRatio !== null &&
    forcedLiquidationRatio >= STRATEGY_BACKTEST_HIGH_FORCED_LIQUIDATION_RATIO_THRESHOLD
  );
}

function describeParams(strategy: StrategyRow): string {
  if (strategy.rule_type === "peg_lynch" || strategy.rule_type === "reversal_breakout_v2") {
    return "서버 설정 기준값 적용";
  }
  const { short_period, long_period } = strategy.rule_params;
  return `단기 ${short_period}일 / 장기 ${long_period}일`;
}

export function describeStrategy(strategy: StrategyRow): string {
  return `${RULE_TYPE_LABELS[strategy.rule_type]} · ${describeParams(strategy)}`;
}

export function useStrategies(user: User) {
  return useSWR(["strategies", user.id], async ([, userId]: [string, string]) => {
    const { data, error } = await supabase
      .from("strategies")
      .select("id, name, rule_type, rule_params, market, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (error) throw error;
    // 종료된 전략(minervini, v1 등)의 행은 DB에 보존돼 있지만 화면에는 내보내지 않는다.
    return (data as StrategyRow[]).filter((strategy) => isOperatingRuleType(strategy.rule_type));
  });
}

function MetricRow({ label, title, children }: { label: string; title?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="tabular-nums text-ink" title={title}>
        {children}
      </dd>
    </div>
  );
}

/** 장기 백테스트 요약 카드. 운영 전략과 종료된 전략(ended)이 같은 형식을 쓴다 — 종료된 전략은
 * "종료됨" 라벨과 갱신 중단 안내, 마지막 계산 기준일을 함께 보여주는 읽기 전용 카드다. */
function BacktestSummaryCard({
  label,
  summary,
  universeCagrPct,
  signalLimitedFrom,
  ended = false,
}: {
  label: string;
  summary: StrategyBacktestSummaryRow | undefined;
  universeCagrPct: number | null;
  signalLimitedFrom?: string;
  ended?: boolean;
}) {
  const concentrationWarning = summary ? isConcentrationWarning(summary.cagr_pct, summary.top5_exclude_return_pct) : false;
  const highForcedLiquidation = summary ? isHighForcedLiquidationRatio(summary.forced_liquidation_ratio) : false;
  // 신호가 특정 시점 이후에만 가능한 전략은 비교 기간이 벤치마크와 달라 우세/열세 대신 "비교 참고"로 표기한다.
  const verdict = summary && !signalLimitedFrom ? benchmarkVerdict(summary.cagr_pct, universeCagrPct) : null;
  const lowSample = summary
    ? isLowSampleSize(
        summary.total_trades,
        summary.period_start_date,
        summary.period_end_date,
        STRATEGY_BACKTEST_MIN_TRADES_PER_YEAR
      )
    : false;

  return (
    <div className="rounded-card border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{label}</span>
        {ended && (
          <span className="rounded-full border border-border bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-ink-muted">
            종료됨
          </span>
        )}
        {verdict === "behind" && (
          <span className="rounded-full bg-est-soft px-2 py-0.5 text-[10px] font-medium text-est">
            벤치마크 열세(검증 결과)
          </span>
        )}
        {verdict === "ahead" && (
          <span className="rounded-full border border-border bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-ink-muted">
            벤치마크 우세
          </span>
        )}
        {signalLimitedFrom && (
          <>
            <span className="rounded-full bg-est-soft px-2 py-0.5 text-[10px] font-medium text-est">
              비교 참고(신호가 {signalLimitedFrom} 이후라 기간이 벤치마크와 다름)
            </span>
            <span className="rounded-full bg-est-soft px-2 py-0.5 text-[10px] font-medium text-est">
              표본 제한(신호 {signalLimitedFrom} 이후)
            </span>
          </>
        )}
        {lowSample && (
          <span className="rounded-full bg-est-soft px-2 py-0.5 text-[10px] font-medium text-est">표본 적음</span>
        )}
        {concentrationWarning && (
          <span className="rounded-full bg-est-soft px-2 py-0.5 text-[10px] font-medium text-est">소수 종목 의존</span>
        )}
        {highForcedLiquidation && (
          <span className="rounded-full border border-border bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-ink-muted">
            강제청산 비중 높음
          </span>
        )}
      </div>
      {highForcedLiquidation && (
        <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
          승률에 정상 매도와 기간 종료로 강제 청산된 거래가 섞여 있습니다. 강제청산은 실제 매도 판단이 아니라 백테스트
          기간이 끝나 임의로 닫힌 거래라, 이 승률을 다른 전략과 직접 비교하면 오해할 수 있습니다.
        </p>
      )}

      {summary ? (
        <dl className="mt-3 space-y-2 text-sm">
          <MetricRow label="승률">
            {summary.win_rate === null ? "-" : formatPercent(summary.win_rate * 100, { sign: false })}
          </MetricRow>
          <MetricRow label="평균 수익률">{formatPct(summary.avg_return_pct)}</MetricRow>
          <MetricRow label="중앙값 수익률">{formatPct(summary.median_return_pct)}</MetricRow>
          <MetricRow
            label="손익비"
            title={summary.payoff_ratio === null ? "승 또는 패 트레이드가 없어 계산 불가" : undefined}
          >
            {summary.payoff_ratio === null
              ? "-"
              : `${summary.payoff_ratio.toFixed(2)}:1 (${formatPct(summary.avg_win_pct)} / ${formatPct(summary.avg_loss_pct)})`}
          </MetricRow>
          <MetricRow label="MDD">{formatMdd(summary.mdd_pct)}</MetricRow>
          <MetricRow label="CAGR(연환산)">{formatPct(summary.cagr_pct)}</MetricRow>
          <MetricRow label="종료(정상매도 · 기간종료강제청산)">
            {summary.total_trades}건 ({summary.closed_trades}건 · {summary.forced_liquidation_count}건)
          </MetricRow>
          <MetricRow label="강제청산 비율">
            {summary.forced_liquidation_ratio === null
              ? "-"
              : formatPercent(summary.forced_liquidation_ratio * 100, { sign: false })}
          </MetricRow>
          {ended && (
            <MetricRow label="기준일">
              {summary.period_start_date} ~ {summary.period_end_date}
            </MetricRow>
          )}
        </dl>
      ) : (
        <p className="mt-3 text-xs text-ink-muted">{ended ? "저장된 검증 결과가 없습니다" : "재정비 중"}</p>
      )}
    </div>
  );
}

export default function StrategyManager({ user }: { user: User }) {
  const { market } = useMarket();
  const { data: strategies, error, isLoading } = useStrategies(user);

  const marketStrategies = useMemo(
    () => strategies?.filter((s) => s.market === market) ?? [],
    [strategies, market]
  );

  // 각 rule_type에서 첫 번째 전략만 골라 "전략 성과 비교" 대상으로 삼는다. 현재 구조상
  // rule_type별로 계정당 하나씩만 있는 게 정상이라 중복은 방어적 처리일 뿐이다.
  const comparableStrategies = useMemo(() => {
    const seen = new Set<StrategyRuleType>();
    const result: { ruleType: StrategyRuleType; strategy: StrategyRow }[] = [];
    for (const s of marketStrategies) {
      if (seen.has(s.rule_type)) continue;
      seen.add(s.rule_type);
      result.push({ ruleType: s.rule_type, strategy: s });
    }
    return result;
  }, [marketStrategies]);

  const comparisonStrategyIds = useMemo(
    () => comparableStrategies.map((c) => c.strategy.id),
    [comparableStrategies]
  );

  const { data: strategyComparisonRows } = useSWR(
    comparisonStrategyIds.length > 0
      ? ["strategy-performance-comparison", comparisonStrategyIds.join(",")]
      : null,
    async () => {
      const { data, error } = await supabase
        .from("screening_results")
        .select("strategy_id, status, return_pct, matched_at")
        .in("strategy_id", comparisonStrategyIds)
        .range(0, SCREENING_RESULTS_FETCH_LIMIT);

      if (error) throw error;
      return data as ScreeningComparisonRow[];
    }
  );

  const strategyStats = useMemo(() => {
    if (!strategyComparisonRows) return null;

    const ruleTypeById = new Map(comparableStrategies.map((c) => [c.strategy.id, c.ruleType]));
    const rowsByRuleType = new Map<StrategyRuleType, ScreeningResultStatRow[]>();
    for (const row of strategyComparisonRows) {
      const ruleType = ruleTypeById.get(row.strategy_id);
      if (!ruleType) continue;
      const rows = rowsByRuleType.get(ruleType) ?? [];
      rows.push({ status: row.status, returnPct: row.return_pct, matchedAt: row.matched_at });
      rowsByRuleType.set(ruleType, rows);
    }

    const stats = new Map<StrategyRuleType, ScreeningResultStats>();
    for (const { ruleType } of comparableStrategies) {
      stats.set(ruleType, computeScreeningResultStats(rowsByRuleType.get(ruleType) ?? []));
    }
    return stats;
  }, [strategyComparisonRows, comparableStrategies]);

  const { data: backtestSummaryData } = useSWR<StrategyBacktestSummaryResponse>(
    "/api/strategies/backtest-summary",
    authJsonFetcher
  );

  const backtestSummaryByRuleType = useMemo(() => {
    const map = new Map<string, StrategyBacktestSummaryRow>();
    for (const row of backtestSummaryData?.summaries ?? []) {
      if (row.market === "KR") map.set(row.rule_type, row);
    }
    return map;
  }, [backtestSummaryData]);

  const benchmarkByType = useMemo(
    () => new Map((backtestSummaryData?.benchmarks ?? []).map((b) => [b.benchmark_type, b])),
    [backtestSummaryData]
  );
  const universeBenchmark = benchmarkByType.get(STRATEGY_BACKTEST_UNIVERSE_BENCHMARK_TYPE) ?? null;
  // 새 기본 stage에 행이 없는 전략(계산 전/누락)은 카드 대신 "재정비 중"으로 두고 이름을 알려준다.
  const missingBacktestRuleTypes = STRATEGY_BACKTEST_TARGET_RULE_TYPES.filter(
    (ruleType) => !backtestSummaryByRuleType.has(ruleType)
  );

  return (
    <div className="w-full max-w-4xl">
      <SubTabs tabs={STRATEGY_BACKTEST_TABS} />

      {comparableStrategies.length > 0 && (
        <div className="mb-6 rounded-card border border-border bg-surface p-4">
          <h3 className="mb-3 text-sm font-medium text-ink">전략 성과 비교</h3>

          {strategyStats ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {comparableStrategies.map(({ ruleType }) => {
                const stats = strategyStats.get(ruleType);
                const isLowSample = !stats || stats.closedCount < MIN_CLOSED_SAMPLES_FOR_RELIABLE_STATS;
                return (
                  <div
                    key={ruleType}
                    className="rounded-card border border-border bg-surface p-4"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{RULE_TYPE_LABELS[ruleType]}</span>
                      {isLowSample && (
                        <span className="rounded-full bg-est-soft px-2 py-0.5 text-[10px] font-medium text-est">
                          표본 부족
                        </span>
                      )}
                    </div>
                    <dl className="mt-3 space-y-2 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-xs text-ink-muted">신호 수(전체/추적 중/종료)</dt>
                        <dd className="tabular-nums text-ink">
                          {stats ? `${stats.total} / ${stats.activeCount} / ${stats.closedCount}` : "-"}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-xs text-ink-muted">승률(종료 기준)</dt>
                        <dd className="tabular-nums text-ink">
                          {stats?.winRate == null ? "-" : formatPercent(stats.winRate * 100, { sign: false })}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-xs text-ink-muted">평균 수익률(종료 기준)</dt>
                        <dd className="tabular-nums text-ink">{formatPct(stats?.avgReturnPct ?? null)}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-xs text-ink-muted">중앙값 수익률(종료 기준)</dt>
                        <dd className="tabular-nums text-ink">{formatPct(stats?.medianReturnPct ?? null)}</dd>
                      </div>
                    </dl>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-ink-muted">비교 데이터를 불러오는 중...</p>
          )}
        </div>
      )}

      <div className="mb-6 rounded-card border border-border bg-surface p-4">
        <h3 className="text-sm font-medium text-ink">
          장기 백테스트({STRATEGY_BACKTEST_WINDOW_START_YEAR}~오늘)
        </h3>
        <p className="mt-1 mb-2 text-xs text-ink-muted">
          실계좌 스크리닝 추적(위 전략 성과 비교)과 달리, {STRATEGY_BACKTEST_WINDOW_START_YEAR}년부터의 장기 성과를
          과거 시점 기준으로 다시 계산한 결과입니다.
        </p>
        <div className="mb-3 space-y-1 rounded-card bg-surface-sunken px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
          <p>
            <span className="font-medium text-ink">유니버스</span>: 시총 5천억 이상(당시 기준), 상장폐지 종목 포함,
            비용(수수료·세금·슬리피지) 반영, 액면분할·병합 보정
          </p>
          <p>
            <span className="font-medium text-ink">한계</span>: 전략 수익률은 보유한 날의 평균이고 벤치마크는 전액
            투자라 단순 비교에는 한계가 있습니다. 슬리피지는 소형주에 낙관적일 수 있습니다. 과거 성과가 미래를
            보장하지 않습니다.
          </p>
        </div>
        {market !== "US" && missingBacktestRuleTypes.length > 0 && (
          <p className="mb-3 rounded-card bg-est-soft px-3 py-2 text-xs text-est">
            재정비 중: {missingBacktestRuleTypes.map((ruleType) => RULE_TYPE_LABELS[ruleType]).join(", ")}
          </p>
        )}
        {market !== "US" && (
          <div className="mb-4">
            <h4 className="mb-2 text-xs font-medium text-ink-muted">벤치마크(같은 기간)</h4>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {STRATEGY_BACKTEST_BENCHMARK_CARDS.map(({ type, label }) => {
                const benchmark = benchmarkByType.get(type);
                return (
                  <div key={type} className="rounded-card border border-border bg-surface p-3">
                    <p className="text-xs font-medium text-ink">{label}</p>
                    {benchmark ? (
                      <dl className="mt-2 space-y-1 text-sm">
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-xs text-ink-muted">CAGR(연환산)</dt>
                          <dd className="tabular-nums text-ink">{formatPct(benchmark.cagr_pct)}</dd>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <dt className="text-xs text-ink-muted">MDD</dt>
                          <dd className="tabular-nums text-ink">{formatMdd(benchmark.mdd_pct)}</dd>
                        </div>
                        <p className="text-[10px] text-ink-faint">
                          {benchmark.period_start_date} ~ {benchmark.period_end_date}
                        </p>
                      </dl>
                    ) : (
                      <p className="mt-2 text-xs text-ink-muted">재정비 중</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {market === "US" ? (
          <p className="text-sm text-ink-muted">국내(KR) 종목만 제공됩니다.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {STRATEGY_BACKTEST_TARGET_RULE_TYPES.map((ruleType) => {
              return (
                <BacktestSummaryCard
                  key={ruleType}
                  label={RULE_TYPE_LABELS[ruleType]}
                  summary={backtestSummaryByRuleType.get(ruleType)}
                  universeCagrPct={universeBenchmark?.cagr_pct ?? null}
                  signalLimitedFrom={STRATEGY_BACKTEST_SIGNAL_LIMITED_FROM[ruleType]}
                />
              );
            })}
          </div>
        )}
      </div>

      {market !== "US" && (
        <div className="mb-6 rounded-card border border-border bg-surface p-4">
          <h3 className="text-sm font-medium text-ink">종료된 전략 (마지막 검증 결과)</h3>
          <p className="mt-1 mb-3 text-xs text-ink-muted">
            운영을 종료한 전략입니다. 더 이상 갱신되지 않으며, 종료 시점에 저장된 마지막 장기 백테스트 결과만
            읽기 전용으로 보여줍니다.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {STRATEGY_BACKTEST_ENDED_STRATEGIES.map(({ ruleType, label }) => (
              <BacktestSummaryCard
                key={ruleType}
                ended
                label={label}
                summary={backtestSummaryByRuleType.get(ruleType)}
                universeCagrPct={universeBenchmark?.cagr_pct ?? null}
              />
            ))}
          </div>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-ink-muted">전략을 불러오는 중...</p>
      ) : error ? (
        <p className="text-sm text-blue-600 dark:text-blue-400">전략을 불러오지 못했습니다.</p>
      ) : marketStrategies.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {marketStrategies.map((strategy) => (
            <div
              key={strategy.id}
              className="rounded-card border border-border bg-surface p-4"
            >
              <p className="font-medium text-ink">
                <span className="mr-2 rounded-full bg-black/[.06] px-2 py-0.5 text-xs font-normal text-ink-muted dark:bg-white/[.1]">
                  {MARKET_LABELS[strategy.market]}
                </span>
                {RULE_TYPE_LABELS[strategy.rule_type]}
              </p>
              <p className="mt-2 text-sm text-ink-muted">
                {describeParams(strategy)}
              </p>
              <p className="mt-3 border-t border-border pt-3 text-xs text-ink-muted">
                {STRATEGY_DESCRIPTIONS[strategy.rule_type]}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-ink-muted">
          등록된 {MARKET_LABELS[market]} 전략이 없습니다.
        </p>
      )}
    </div>
  );
}

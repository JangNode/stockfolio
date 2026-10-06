"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type { StrategyRule, StrategyRuleType } from "@/lib/backtest";
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
  minervini_trend_template: "미너비니 트렌드 템플릿",
  custom_composite: "커스텀 조건 조합",
  peg_lynch: "피터린치 PEG전략",
  reversal_breakout: "급등주 찾기(역배열 반등)",
  reversal_breakout_v2: "급등주 찾기 v2 (역배열 반등 - 강화)",
};

const STRATEGY_DESCRIPTIONS: Record<StrategyRuleType, string> = {
  ma_cross:
    "단기 이동평균선이 장기 이동평균선을 아래에서 위로 뚫고 올라가는 골든크로스가 발생하면 매수 신호로, 반대로 위에서 아래로 뚫고 내려가는 데드크로스가 발생하면 매도 신호로 판단합니다.",
  minervini_trend_template:
    "마크 미너비니의 추세추종 전략입니다. 주가가 단기·중기·장기 이동평균선 위에 있고 이동평균선이 정배열(단기>중기>장기)을 이루며 장기 이동평균선이 상승 추세이고, 250거래일 신저가 대비 30% 이상 올랐으면서 250거래일 신고가에서 25% 이내인 등 7가지 조건을 모두 만족해야 신호로 인정합니다.",
  custom_composite:
    "실험실에서 직접 구성한 전략입니다. 지정한 조건(이동평균 교차, RSI, 거래량 급증 등)을 모두 동시에 만족해야 신호로 판단합니다.",
  peg_lynch:
    "피터 린치의 PEG(주가수익성장비율) 지표를 쓰는 전략입니다. 적자기업은 제외하고, PEG(=PER÷최근 5년 EPS 성장률)가 기준값 이하인 저평가 성장주를 point-in-time 재무 데이터로 판정합니다. 기준값은 서버 설정(lib/pegConfig.ts)에서 관리됩니다.",
  reversal_breakout:
    "역배열(하락 추세) 상태에서 바닥을 다지다 대량 거래를 동반한 반등이 시작되는 시점을 포착하는 전략입니다. ① 최근 60거래일 중 70% 이상 이동평균이 역배열(20일선<60일선<112일선<244일선<448일선)이었고, ② 최근 20거래일 내 거래량이 직전 평균 대비 3배 이상인 양봉(매집봉)이 있었으며, ③ 현재가가 20일선을 최근 5거래일 이내에 돌파했으면 신호로 판단합니다. 기준값은 서버 설정(lib/reversalBreakoutConfig.ts)에서 관리됩니다.",
  reversal_breakout_v2:
    "기존과 동일한 조건, 역배열비율만 0.9로 강화한 실험 전략입니다(60거래일 중 90% 이상 역배열이어야 인정). '급등주 찾기(역배열 반등)' v1과 나란히 실서비스로 돌려 신호 수 대비 승률·수익률 트레이드오프를 비교하기 위한 목적입니다. 나머지 조건(매집봉, 전환 신호)과 기준값은 v1과 동일합니다.",
};

// 종료된 신호 수가 이보다 적으면 승률/평균·중앙값 수익률이 통계적으로 신뢰하기
// 어려워 "표본 부족" 배지를 붙인다.
const MIN_CLOSED_SAMPLES_FOR_RELIABLE_STATS = 10;

// reversal_breakout(v1)/reversal_breakout_v2, 전략 성과 비교 섹션 조회용 최소 필드.
interface ScreeningComparisonRow {
  strategy_id: string;
  status: "active" | "stopped" | "profited" | "price_unavailable" | "price_anomaly";
  return_pct: number;
  matched_at: string;
}

type ComparisonPeriod = "all" | "7d" | "30d";

const COMPARISON_PERIOD_OPTIONS: { value: ComparisonPeriod; label: string }[] = [
  { value: "all", label: "전체 기간" },
  { value: "7d", label: "최근 7일" },
  { value: "30d", label: "최근 30일" },
];

const COMPARISON_PERIOD_DAYS: Record<Exclude<ComparisonPeriod, "all">, number> = { "7d": 7, "30d": 30 };

function formatPct(value: number | null): string {
  return value === null ? "-" : formatPercent(value);
}

// screening_results 조회 시 Supabase 기본 상한(1000행)에 걸리지 않도록 넉넉히 잡는
// 상한. minervini_trend_template은 이미 1000건에 닿아 있어 기본값으로는 잘린다.
const SCREENING_RESULTS_FETCH_LIMIT = 4999;

// "장기 백테스트(2016~오늘)" 섹션 — scripts/compute-strategy-backtest-summary.ts가
// 매주 재계산해 strategy_backtest_summary에 쌓아둔 캐시를 읽는다. 실계좌 스크리닝
// 추적 기반의 위 "전략 성과 비교"와는 별개 지표라 섹션을 분리했다.
type BacktestSummaryRuleType = (typeof STRATEGY_BACKTEST_TARGET_RULE_TYPES)[number];

interface StrategyBacktestSummaryRow {
  rule_type: BacktestSummaryRuleType;
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

const selectClassName =
  "h-10 rounded-lg border border-border bg-transparent px-3 text-sm text-ink outline-none focus:border-black/30 dark:focus:border-white/30";

function describeParams(strategy: StrategyRow): string {
  if (strategy.rule_type === "minervini_trend_template") {
    const { ma_short, ma_mid, ma_long } = strategy.rule_params;
    return `${ma_short}/${ma_mid}/${ma_long}일`;
  }
  if (strategy.rule_type === "custom_composite") {
    const { ma_cross, rsi, volume_surge, fundamentals, stop_loss_pct, take_profit_pct } = strategy.rule_params;
    const parts: string[] = [];
    if (ma_cross) parts.push(`이평 ${ma_cross.short_period}/${ma_cross.long_period}일 교차`);
    if (rsi) parts.push(`RSI(${rsi.period}) ${rsi.direction === "above" ? "≥" : "≤"} ${rsi.threshold}`);
    if (volume_surge) parts.push(`거래량 ${volume_surge.period}일 평균 대비 ${volume_surge.multiplier}배 이상`);
    if (fundamentals) parts.push(`펀더멘털 조건 ${Object.keys(fundamentals).length}개`);
    if (stop_loss_pct !== undefined) parts.push(`손절 ${stop_loss_pct * 100}%`);
    if (take_profit_pct !== undefined) parts.push(`익절 ${take_profit_pct * 100}%`);
    return parts.length > 0 ? parts.join(", ") : "조건 미지정";
  }
  if (
    strategy.rule_type === "peg_lynch" ||
    strategy.rule_type === "reversal_breakout" ||
    strategy.rule_type === "reversal_breakout_v2"
  ) {
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
    return data as StrategyRow[];
  });
}

export default function StrategyManager({ user }: { user: User }) {
  const { market } = useMarket();
  const { data: strategies, error, isLoading } = useStrategies(user);

  const marketStrategies = useMemo(
    () => strategies?.filter((s) => s.market === market) ?? [],
    [strategies, market]
  );

  // v1(reversal_breakout)/v2(reversal_breakout_v2) 비교 대시보드에 쓸 두 전략의 id.
  // 계정에 둘 다 등록돼 있을 때만 값이 채워진다(마이그레이션이 모든 계정에
  // 시딩하므로 보통 둘 다 있지만, 사용자가 임의로 지웠을 수도 있다).
  const reversalBreakoutPair = useMemo(() => {
    const v1 = marketStrategies.find((s) => s.rule_type === "reversal_breakout");
    const v2 = marketStrategies.find((s) => s.rule_type === "reversal_breakout_v2");
    return { v1, v2 };
  }, [marketStrategies]);

  const [comparisonPeriod, setComparisonPeriod] = useState<ComparisonPeriod>("all");

  const hasComparisonPair = Boolean(reversalBreakoutPair.v1 && reversalBreakoutPair.v2);

  // comparisonPeriod를 SWR 키에 포함시켜, 기간 드롭다운을 바꾸면 그 기간만큼의 결과를
  // 다시 조회한다 — "지금부터 N일 전"의 기준 시각(Date.now())은 렌더 함수 본문이 아니라
  // 이 fetcher(렌더 바깥에서 실행됨) 안에서만 계산해 impure 호출을 렌더 순수성 밖으로 뺀다.
  const { data: comparisonRows } = useSWR(
    reversalBreakoutPair.v1 && reversalBreakoutPair.v2
      ? ["reversal-breakout-comparison", reversalBreakoutPair.v1.id, reversalBreakoutPair.v2.id, comparisonPeriod]
      : null,
    async ([, v1Id, v2Id, period]: [string, string, string, ComparisonPeriod]) => {
      let query = supabase
        .from("screening_results")
        .select("strategy_id, status, return_pct, matched_at")
        .in("strategy_id", [v1Id, v2Id]);

      if (period !== "all") {
        const cutoffIso = new Date(Date.now() - COMPARISON_PERIOD_DAYS[period] * 24 * 60 * 60 * 1000).toISOString();
        query = query.gte("matched_at", cutoffIso);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as ScreeningComparisonRow[];
    }
  );

  const comparisonStats = useMemo(() => {
    if (!comparisonRows || !reversalBreakoutPair.v1 || !reversalBreakoutPair.v2) return null;

    const toStatRows = (strategyId: string): ScreeningResultStatRow[] =>
      comparisonRows
        .filter((r) => r.strategy_id === strategyId)
        .map((r) => ({ status: r.status, returnPct: r.return_pct, matchedAt: r.matched_at }));

    return {
      v1: computeScreeningResultStats(toStatRows(reversalBreakoutPair.v1.id)),
      v2: computeScreeningResultStats(toStatRows(reversalBreakoutPair.v2.id)),
    };
  }, [comparisonRows, reversalBreakoutPair]);

  // custom_composite(사용자마다 조건이 다른 실험 전략)를 제외한 나머지 rule_type
  // 각각에서 첫 번째 전략만 골라 "전략 성과 비교" 대상으로 삼는다. 현재 구조상
  // rule_type별로 계정당 하나씩만 있는 게 정상이라 중복은 방어적 처리일 뿐이다.
  const comparableStrategies = useMemo(() => {
    const seen = new Set<StrategyRuleType>();
    const result: { ruleType: StrategyRuleType; strategy: StrategyRow }[] = [];
    for (const s of marketStrategies) {
      if (s.rule_type === "custom_composite") continue;
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
    const map = new Map<BacktestSummaryRuleType, StrategyBacktestSummaryRow>();
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

      {hasComparisonPair && reversalBreakoutPair.v1 && reversalBreakoutPair.v2 && (
        <div className="mb-6 rounded-card border border-border bg-surface p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-ink">
                급등주 찾기 v1 vs v2 비교
              </h3>
              <p className="text-xs text-ink-muted">
                v2는 역배열비율 임계값만 0.9로 강화한 실험 전략입니다. v2가 항상 v1의 부분집합이라는 성질이
                있지만, active 상태가 갱신되는 타이밍 차이로 완벽히 대칭인 집합은 아닐 수 있습니다.
              </p>
            </div>
            <select
              value={comparisonPeriod}
              onChange={(e) => setComparisonPeriod(e.target.value as ComparisonPeriod)}
              className={selectClassName}
            >
              {COMPARISON_PERIOD_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {comparisonStats ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-ink-muted">
                    <th className="pb-2 pr-4 font-normal"></th>
                    <th className="pb-2 pr-4 font-normal">{reversalBreakoutPair.v1.name ?? "v1"}</th>
                    <th className="pb-2 font-normal">{reversalBreakoutPair.v2.name ?? "v2"}</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums text-ink">
                  <tr className="border-t border-border">
                    <td className="py-2 pr-4 text-ink-muted">신호 수(전체/추적 중/종료)</td>
                    <td className="py-2 pr-4">
                      {comparisonStats.v1.total} / {comparisonStats.v1.activeCount} / {comparisonStats.v1.closedCount}
                    </td>
                    <td className="py-2">
                      {comparisonStats.v2.total} / {comparisonStats.v2.activeCount} / {comparisonStats.v2.closedCount}
                    </td>
                  </tr>
                  {comparisonStats.v1.closedCount === 0 && comparisonStats.v2.closedCount === 0 ? (
                    <tr className="border-t border-border">
                      <td className="py-2 text-ink-muted" colSpan={3}>
                        종료된 신호가 아직 없어 비교할 수 없습니다.
                      </td>
                    </tr>
                  ) : (
                    <>
                      <tr className="border-t border-border">
                        <td className="py-2 pr-4 text-ink-muted">승률(종료 기준)</td>
                        <td className="py-2 pr-4">
                          {comparisonStats.v1.winRate === null
                            ? "-"
                            : formatPercent(comparisonStats.v1.winRate * 100, { sign: false })}
                        </td>
                        <td className="py-2">
                          {comparisonStats.v2.winRate === null
                            ? "-"
                            : formatPercent(comparisonStats.v2.winRate * 100, { sign: false })}
                        </td>
                      </tr>
                      <tr className="border-t border-border">
                        <td className="py-2 pr-4 text-ink-muted">평균 수익률(종료 기준)</td>
                        <td className="py-2 pr-4">{formatPct(comparisonStats.v1.avgReturnPct)}</td>
                        <td className="py-2">{formatPct(comparisonStats.v2.avgReturnPct)}</td>
                      </tr>
                      <tr className="border-t border-border">
                        <td className="py-2 pr-4 text-ink-muted">중앙값 수익률(종료 기준)</td>
                        <td className="py-2 pr-4">{formatPct(comparisonStats.v1.medianReturnPct)}</td>
                        <td className="py-2">{formatPct(comparisonStats.v2.medianReturnPct)}</td>
                      </tr>
                    </>
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-ink-muted">비교 데이터를 불러오는 중...</p>
          )}
        </div>
      )}

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
              const summary = backtestSummaryByRuleType.get(ruleType);
              const concentrationWarning = summary
                ? isConcentrationWarning(summary.cagr_pct, summary.top5_exclude_return_pct)
                : false;
              const highForcedLiquidation = summary
                ? isHighForcedLiquidationRatio(summary.forced_liquidation_ratio)
                : false;
              // 신호가 특정 시점 이후에만 가능한 전략은 비교 기간이 벤치마크와 달라 우세/열세 대신 "비교 참고"로 표기한다.
              const verdict =
                summary && !signalLimitedFrom
                  ? benchmarkVerdict(summary.cagr_pct, universeBenchmark?.cagr_pct ?? null)
                  : null;
              const lowSample = summary
                ? isLowSampleSize(
                    summary.total_trades,
                    summary.period_start_date,
                    summary.period_end_date,
                    STRATEGY_BACKTEST_MIN_TRADES_PER_YEAR
                  )
                : false;

              return (
                <div key={ruleType} className="rounded-card border border-border bg-surface p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{RULE_TYPE_LABELS[ruleType]}</span>
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
                      <span className="rounded-full bg-est-soft px-2 py-0.5 text-[10px] font-medium text-est">
                        표본 적음
                      </span>
                    )}
                    {concentrationWarning && (
                      <span className="rounded-full bg-est-soft px-2 py-0.5 text-[10px] font-medium text-est">
                        소수 종목 의존
                      </span>
                    )}
                    {highForcedLiquidation && (
                      <span className="rounded-full border border-border bg-surface-sunken px-2 py-0.5 text-[10px] font-medium text-ink-muted">
                        강제청산 비중 높음
                      </span>
                    )}
                  </div>
                  {highForcedLiquidation && (
                    <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
                      승률에 정상 매도와 기간 종료로 강제 청산된 거래가 섞여 있습니다. 강제청산은 실제 매도 판단이
                      아니라 백테스트 기간이 끝나 임의로 닫힌 거래라, 이 승률을 다른 전략과 직접 비교하면 오해할 수
                      있습니다.
                    </p>
                  )}

                  {summary ? (
                    <dl className="mt-3 space-y-2 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-xs text-ink-muted">승률</dt>
                        <dd className="tabular-nums text-ink">
                          {summary.win_rate === null ? "-" : formatPercent(summary.win_rate * 100, { sign: false })}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-xs text-ink-muted">평균 수익률</dt>
                        <dd className="tabular-nums text-ink">{formatPct(summary.avg_return_pct)}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-xs text-ink-muted">중앙값 수익률</dt>
                        <dd className="tabular-nums text-ink">{formatPct(summary.median_return_pct)}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-xs text-ink-muted">손익비</dt>
                        <dd
                          className="tabular-nums text-ink"
                          title={summary.payoff_ratio === null ? "승 또는 패 트레이드가 없어 계산 불가" : undefined}
                        >
                          {summary.payoff_ratio === null
                            ? "-"
                            : `${summary.payoff_ratio.toFixed(2)}:1 (${formatPct(summary.avg_win_pct)} / ${formatPct(summary.avg_loss_pct)})`}
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-xs text-ink-muted">MDD</dt>
                        <dd className="tabular-nums text-ink">{formatMdd(summary.mdd_pct)}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-xs text-ink-muted">CAGR(연환산)</dt>
                        <dd className="tabular-nums text-ink">{formatPct(summary.cagr_pct)}</dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-xs text-ink-muted">종료(정상매도 · 기간종료강제청산)</dt>
                        <dd className="tabular-nums text-ink">
                          {summary.total_trades}건 ({summary.closed_trades}건 · {summary.forced_liquidation_count}건)
                        </dd>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <dt className="text-xs text-ink-muted">강제청산 비율</dt>
                        <dd className="tabular-nums text-ink">
                          {summary.forced_liquidation_ratio === null
                            ? "-"
                            : formatPercent(summary.forced_liquidation_ratio * 100, { sign: false })}
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="mt-3 text-xs text-ink-muted">재정비 중</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

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

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
  status: "active" | "stopped" | "profited" | "price_unavailable";
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

  return (
    <div className="w-full max-w-3xl">
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
            <div className="flex flex-wrap gap-4">
              {comparableStrategies.map(({ ruleType }) => {
                const stats = strategyStats.get(ruleType);
                const isLowSample = !stats || stats.closedCount < MIN_CLOSED_SAMPLES_FOR_RELIABLE_STATS;
                return (
                  <div
                    key={ruleType}
                    className="w-full max-w-sm rounded-card border border-border bg-surface p-4"
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

      {isLoading ? (
        <p className="text-sm text-ink-muted">전략을 불러오는 중...</p>
      ) : error ? (
        <p className="text-sm text-blue-600 dark:text-blue-400">전략을 불러오지 못했습니다.</p>
      ) : marketStrategies.length > 0 ? (
        <div className="flex flex-wrap gap-4">
          {marketStrategies.map((strategy) => (
            <div
              key={strategy.id}
              className="w-full max-w-sm rounded-card border border-border bg-surface p-4"
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

"use client";

import useSWR from "swr";
import Link from "next/link";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type { StrategyRule, StrategyRuleType } from "@/lib/backtest";
import { useMarket } from "@/components/MarketContext";
import { MARKET_LABELS, type Market } from "@/lib/market";

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
};

const STRATEGY_DESCRIPTIONS: Record<StrategyRuleType, string> = {
  ma_cross:
    "단기 이동평균선이 장기 이동평균선을 아래에서 위로 뚫고 올라가는 골든크로스가 발생하면 매수 신호로, 반대로 위에서 아래로 뚫고 내려가는 데드크로스가 발생하면 매도 신호로 판단합니다.",
  minervini_trend_template:
    "마크 미너비니의 추세추종 전략입니다. 주가가 단기·중기·장기 이동평균선 위에 있고 이동평균선이 정배열(단기>중기>장기)을 이루며 장기 이동평균선이 상승 추세이고, 250거래일 신저가 대비 30% 이상 올랐으면서 250거래일 신고가에서 25% 이내인 등 7가지 조건을 모두 만족해야 신호로 인정합니다.",
  custom_composite:
    "실험실에서 직접 구성한 전략입니다. 지정한 조건(이동평균 교차, RSI, 거래량 급증 등)을 모두 동시에 만족해야 신호로 판단합니다.",
};

function describeParams(strategy: StrategyRow): string {
  if (strategy.rule_type === "minervini_trend_template") {
    const { ma_short, ma_mid, ma_long } = strategy.rule_params;
    return `${ma_short}/${ma_mid}/${ma_long}일`;
  }
  if (strategy.rule_type === "custom_composite") {
    const { ma_cross, rsi, volume_surge, stop_loss_pct, take_profit_pct } = strategy.rule_params;
    const parts: string[] = [];
    if (ma_cross) parts.push(`이평 ${ma_cross.short_period}/${ma_cross.long_period}일 교차`);
    if (rsi) parts.push(`RSI(${rsi.period}) ${rsi.direction === "above" ? "≥" : "≤"} ${rsi.threshold}`);
    if (volume_surge) parts.push(`거래량 ${volume_surge.period}일 평균 대비 ${volume_surge.multiplier}배 이상`);
    if (stop_loss_pct !== undefined) parts.push(`손절 ${stop_loss_pct * 100}%`);
    if (take_profit_pct !== undefined) parts.push(`익절 ${take_profit_pct * 100}%`);
    return parts.length > 0 ? parts.join(", ") : "조건 미지정";
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
  const marketStrategies = strategies?.filter((s) => s.market === market) ?? [];

  return (
    <div className="w-full max-w-3xl">
      <div className="mb-4 flex items-center gap-4 text-sm">
        <span className="whitespace-nowrap font-medium text-black dark:text-zinc-50">전략 목록</span>
        <Link
          href="/backtest"
          className="whitespace-nowrap text-zinc-500 transition-colors hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          백테스트
        </Link>
      </div>

      {isLoading ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">전략을 불러오는 중...</p>
      ) : error ? (
        <p className="text-sm text-blue-600 dark:text-blue-400">전략을 불러오지 못했습니다.</p>
      ) : marketStrategies.length > 0 ? (
        <div className="flex flex-wrap gap-4">
          {marketStrategies.map((strategy) => (
            <div
              key={strategy.id}
              className="w-full max-w-sm rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950"
            >
              <p className="font-medium text-black dark:text-zinc-50">
                <span className="mr-2 rounded-full bg-black/[.06] px-2 py-0.5 text-xs font-normal text-zinc-600 dark:bg-white/[.1] dark:text-zinc-300">
                  {MARKET_LABELS[strategy.market]}
                </span>
                {RULE_TYPE_LABELS[strategy.rule_type]}
              </p>
              <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                {describeParams(strategy)}
              </p>
              <p className="mt-3 border-t border-black/[.08] pt-3 text-xs text-zinc-500 dark:border-white/[.145] dark:text-zinc-400">
                {STRATEGY_DESCRIPTIONS[strategy.rule_type]}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          등록된 {MARKET_LABELS[market]} 전략이 없습니다.
        </p>
      )}
    </div>
  );
}

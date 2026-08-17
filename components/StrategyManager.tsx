"use client";

import { useState } from "react";
import useSWR from "swr";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type { StrategyRule, StrategyRuleType } from "@/lib/backtest";

export type StrategyRow = StrategyRule & {
  id: string;
  name: string;
  created_at: string;
};

const RULE_TYPE_LABELS: Record<StrategyRuleType, string> = {
  ma_cross: "이평선 골든/데드크로스",
  minervini_trend_template: "미너비니 트렌드 템플릿",
};

// 미너비니 트렌드 템플릿은 원문 표준 정의(50/150/200일)를 그대로 쓰며 사용자가 바꿀 수 없다.
const MINERVINI_PARAMS = { ma_short: 50, ma_mid: 150, ma_long: 200 } as const;

export function describeStrategy(strategy: StrategyRow): string {
  if (strategy.rule_type === "minervini_trend_template") {
    const { ma_short, ma_mid, ma_long } = strategy.rule_params;
    return `${RULE_TYPE_LABELS[strategy.rule_type]} · ${ma_short}/${ma_mid}/${ma_long}일`;
  }
  const { short_period, long_period } = strategy.rule_params;
  return `${RULE_TYPE_LABELS[strategy.rule_type]} · 단기 ${short_period}일 / 장기 ${long_period}일`;
}

export function useStrategies(user: User) {
  return useSWR(["strategies", user.id], async ([, userId]: [string, string]) => {
    const { data, error } = await supabase
      .from("strategies")
      .select("id, name, rule_type, rule_params, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (error) throw error;
    return data as StrategyRow[];
  });
}

export default function StrategyManager({ user }: { user: User }) {
  const [name, setName] = useState("");
  const [ruleType, setRuleType] = useState<StrategyRuleType>("ma_cross");
  const [shortPeriod, setShortPeriod] = useState("5");
  const [longPeriod, setLongPeriod] = useState("20");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { data: strategies, error, isLoading, mutate } = useStrategies(user);

  const handleAdd = async () => {
    setFormError("");

    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError("전략 이름을 입력해주세요.");
      return;
    }

    let insertPayload: { rule_type: StrategyRuleType; rule_params: object };

    if (ruleType === "ma_cross") {
      const short = Number(shortPeriod);
      const long = Number(longPeriod);
      if (!Number.isInteger(short) || short <= 0 || !Number.isInteger(long) || long <= 0) {
        setFormError("이평선 기간은 양의 정수로 입력해주세요.");
        return;
      }
      if (short >= long) {
        setFormError("단기 이평선 기간은 장기 이평선 기간보다 짧아야 합니다.");
        return;
      }
      insertPayload = {
        rule_type: "ma_cross",
        rule_params: { short_period: short, long_period: long },
      };
    } else {
      insertPayload = {
        rule_type: "minervini_trend_template",
        rule_params: { ...MINERVINI_PARAMS },
      };
    }

    setSubmitting(true);
    const { error: insertError } = await supabase.from("strategies").insert({
      user_id: user.id,
      name: trimmedName,
      ...insertPayload,
    });
    setSubmitting(false);

    if (insertError) {
      setFormError(insertError.message);
      return;
    }

    setName("");
    setShortPeriod("5");
    setLongPeriod("20");
    mutate();
  };

  const handleRemove = async (id: string) => {
    await supabase.from("strategies").delete().eq("id", id);
    mutate();
  };

  const inputClassName =
    "h-10 rounded-lg border border-black/[.08] bg-transparent px-3 text-sm text-black outline-none focus:border-black/30 dark:border-white/[.145] dark:text-zinc-50 dark:focus:border-white/30";

  return (
    <div className="w-full max-w-3xl">
      <div className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
        <div className="flex flex-1 min-w-[10rem] flex-col gap-1">
          <label className="text-xs text-zinc-500 dark:text-zinc-400">전략 이름</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: 단기 골든크로스"
            className={inputClassName}
          />
        </div>
        <div className="flex flex-1 min-w-[12rem] flex-col gap-1">
          <label className="text-xs text-zinc-500 dark:text-zinc-400">전략 유형</label>
          <select
            value={ruleType}
            onChange={(e) => setRuleType(e.target.value as StrategyRuleType)}
            className={inputClassName}
          >
            <option value="ma_cross">{RULE_TYPE_LABELS.ma_cross}</option>
            <option value="minervini_trend_template">
              {RULE_TYPE_LABELS.minervini_trend_template}
            </option>
          </select>
        </div>

        {ruleType === "ma_cross" ? (
          <>
            <div className="flex w-28 flex-col gap-1">
              <label className="text-xs text-zinc-500 dark:text-zinc-400">단기 이평선(일)</label>
              <input
                type="number"
                min={1}
                value={shortPeriod}
                onChange={(e) => setShortPeriod(e.target.value)}
                className={inputClassName}
              />
            </div>
            <div className="flex w-28 flex-col gap-1">
              <label className="text-xs text-zinc-500 dark:text-zinc-400">장기 이평선(일)</label>
              <input
                type="number"
                min={1}
                value={longPeriod}
                onChange={(e) => setLongPeriod(e.target.value)}
                className={inputClassName}
              />
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-zinc-500 dark:text-zinc-400">이평선 기간(고정)</span>
            <p className="flex h-10 items-center text-sm text-zinc-600 dark:text-zinc-400">
              단기 {MINERVINI_PARAMS.ma_short}일 · 중기 {MINERVINI_PARAMS.ma_mid}일 · 장기{" "}
              {MINERVINI_PARAMS.ma_long}일
            </p>
          </div>
        )}

        <button
          onClick={handleAdd}
          disabled={submitting}
          className="h-10 rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
        >
          {submitting ? "저장 중..." : "저장"}
        </button>
        {formError && (
          <p className="w-full text-sm text-blue-600 dark:text-blue-400">{formError}</p>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">전략을 불러오는 중...</p>
      ) : error ? (
        <p className="text-sm text-blue-600 dark:text-blue-400">전략을 불러오지 못했습니다.</p>
      ) : strategies && strategies.length > 0 ? (
        <div className="flex flex-wrap gap-4">
          {strategies.map((strategy) => (
            <div
              key={strategy.id}
              className="w-full max-w-xs rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950"
            >
              <div className="flex items-start justify-between">
                <p className="font-medium text-black dark:text-zinc-50">{strategy.name}</p>
                <button
                  onClick={() => handleRemove(strategy.id)}
                  aria-label={`${strategy.name} 전략 삭제`}
                  className="text-zinc-400 transition-colors hover:text-blue-600 dark:text-zinc-500 dark:hover:text-blue-400"
                >
                  ✕
                </button>
              </div>
              <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
                {describeStrategy(strategy)}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          등록된 전략이 없습니다. 위에서 전략을 추가해보세요.
        </p>
      )}
    </div>
  );
}

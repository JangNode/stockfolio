"use client";

import { useState } from "react";
import useSWR from "swr";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { justGoldenCrossed, type DailyPrice } from "@/lib/backtest";
import { useStrategies } from "@/components/StrategyManager";

interface WatchlistStock {
  stock_code: string;
  stock_name: string;
}

interface ScreeningResult {
  stockCode: string;
  stockName: string;
  strategyName: string;
  signalPrice: number;
  currentPrice: number | null;
}

export default function Screening({ user }: { user: User }) {
  const { data: strategies, isLoading: strategiesLoading } = useStrategies(user);
  const { data: watchlist, isLoading: watchlistLoading } = useSWR(
    ["screening-watchlist", user.id],
    async ([, userId]: [string, string]) => {
      const { data, error } = await supabase
        .from("watchlist")
        .select("stock_code, stock_name")
        .eq("user_id", userId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      return data as WatchlistStock[];
    }
  );

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [results, setResults] = useState<ScreeningResult[] | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const toggleStrategy = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleRun = async () => {
    setErrorMsg("");
    setResults(null);

    const selected = strategies?.filter((s) => selectedIds.has(s.id)) ?? [];
    if (selected.length === 0) {
      setErrorMsg("전략을 하나 이상 선택해주세요.");
      return;
    }
    if (!watchlist || watchlist.length === 0) {
      setErrorMsg("관심종목이 없습니다.");
      return;
    }

    setRunning(true);
    const found: ScreeningResult[] = [];

    for (let i = 0; i < watchlist.length; i++) {
      const stock = watchlist[i];
      setProgress({ current: i + 1, total: watchlist.length });

      try {
        const historyRes = await fetch(`/api/stock/${stock.stock_code}/history?period=D`);
        if (!historyRes.ok) continue;
        const prices = (await historyRes.json()) as DailyPrice[];
        if (prices.length === 0) continue;

        const matched = selected.filter((s) =>
          justGoldenCrossed(prices, s.rule_params.short_period, s.rule_params.long_period)
        );
        if (matched.length === 0) continue;

        const signalPrice = prices[prices.length - 1].close;

        let currentPrice: number | null = null;
        const priceRes = await fetch(`/api/stock/${stock.stock_code}`);
        if (priceRes.ok) {
          const priceData = await priceRes.json();
          currentPrice = priceData.currentPrice ?? null;
        }

        for (const strategy of matched) {
          found.push({
            stockCode: stock.stock_code,
            stockName: stock.stock_name,
            strategyName: strategy.name,
            signalPrice,
            currentPrice,
          });
        }
      } catch {
        continue;
      }
    }

    setResults(found);
    setProgress(null);
    setRunning(false);
  };

  return (
    <div className="w-full max-w-3xl">
      <div className="mb-6 rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
          적용할 전략 (하나 이상 선택)
        </p>

        {strategiesLoading ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">전략을 불러오는 중...</p>
        ) : strategies && strategies.length > 0 ? (
          <div className="flex flex-wrap gap-3">
            {strategies.map((s) => (
              <label
                key={s.id}
                className="flex items-center gap-2 rounded-lg border border-black/[.08] px-3 py-2 text-sm text-black dark:border-white/[.145] dark:text-zinc-50"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(s.id)}
                  onChange={() => toggleStrategy(s.id)}
                />
                {s.name} ({s.rule_params.short_period}/{s.rule_params.long_period})
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            등록된 전략이 없습니다. 전략 관리에서 먼저 전략을 추가해주세요.
          </p>
        )}

        <button
          onClick={handleRun}
          disabled={running || strategiesLoading || watchlistLoading}
          className="mt-4 h-10 rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
        >
          {running ? "실행 중..." : "스크리닝 실행"}
        </button>

        {progress && (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            {progress.current} / {progress.total} 종목 확인 중...
          </p>
        )}

        {errorMsg && (
          <p className="mt-2 text-sm text-blue-600 dark:text-blue-400">{errorMsg}</p>
        )}
      </div>

      {results && (
        <div className="rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
          {results.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              오늘 골든크로스가 발생한 종목이 없습니다.
            </p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-zinc-500 dark:text-zinc-400">
                  <th className="pb-2 pr-4 font-normal">종목명</th>
                  <th className="pb-2 pr-4 font-normal">전략</th>
                  <th className="pb-2 pr-4 font-normal">신호 발생가</th>
                  <th className="pb-2 font-normal">현재가</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => {
                  const colorClass =
                    r.currentPrice === null
                      ? "text-black dark:text-zinc-50"
                      : r.currentPrice > r.signalPrice
                        ? "text-red-600 dark:text-red-400"
                        : r.currentPrice < r.signalPrice
                          ? "text-blue-600 dark:text-blue-400"
                          : "text-black dark:text-zinc-50";

                  return (
                    <tr
                      key={`${r.stockCode}-${r.strategyName}-${i}`}
                      className="border-t border-black/[.08] dark:border-white/[.145]"
                    >
                      <td className="py-2 pr-4 text-black dark:text-zinc-50">
                        {r.stockName}{" "}
                        <span className="text-xs text-zinc-400 dark:text-zinc-500">
                          {r.stockCode}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-black dark:text-zinc-50">{r.strategyName}</td>
                      <td className="py-2 pr-4 text-black dark:text-zinc-50">
                        {r.signalPrice.toLocaleString("ko-KR")}
                      </td>
                      <td className={`py-2 ${colorClass}`}>
                        {r.currentPrice !== null ? r.currentPrice.toLocaleString("ko-KR") : "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { describeStrategy, useStrategies } from "@/components/StrategyManager";
import { ScoreValue } from "@/components/ScoreValue";
import { useMarket } from "@/components/MarketContext";
import { formatPrice, MARKET_LABELS, type Market } from "@/lib/market";

interface ScreeningResultRow {
  id: string;
  stock_code: string;
  stock_name: string;
  entry_price: number;
  stop_loss_price: number;
  take_profit_price: number;
  current_price: number;
  return_pct: number;
  score: number | null;
  status: "active" | "stopped" | "profited";
  matched_at: string;
  closed_at: string | null;
}

type StatusTab = "active" | "closed";

const STATUS_TABS: { value: StatusTab; label: string }[] = [
  { value: "active", label: "추적 중" },
  { value: "closed", label: "종료됨" },
];

const STATUS_BADGE: Record<ScreeningResultRow["status"], { label: string; className: string }> = {
  active: { label: "추적 중", className: "text-zinc-500 dark:text-zinc-400" },
  stopped: { label: "손절", className: "text-blue-600 dark:text-blue-400" },
  profited: { label: "익절", className: "text-red-600 dark:text-red-400" },
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// 종료일 드롭다운의 값/표시용. KST 기준 달력 날짜로 묶어야 자정 근처 종료 건이
// 엉뚱한 날짜로 갈리지 않는다.
function closedDateKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function closedDateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}

export default function Screening({ user }: { user: User }) {
  const { market } = useMarket();
  const { data: strategies, isLoading: strategiesLoading } = useStrategies(user);
  const [strategyId, setStrategyId] = useState("");
  const [statusTab, setStatusTab] = useState<StatusTab>("active");
  const [closedDate, setClosedDate] = useState("");

  const marketStrategies = useMemo(
    () => strategies?.filter((s) => s.market === market) ?? [],
    [strategies, market]
  );

  // 전역 시장 전환 시 이전 시장의 전략 선택/종료일 필터가 남아있지 않도록 비운다.
  // 렌더 도중 이전 값과 비교해 조정한다(리액트가 권장하는 "prop이 바뀌면 상태 리셋" 패턴).
  const [prevMarket, setPrevMarket] = useState(market);
  if (market !== prevMarket) {
    setPrevMarket(market);
    setStrategyId("");
    setClosedDate("");
  }

  const { data: lastRun } = useSWR("screening-last-run", async () => {
    const { data, error } = await supabase
      .from("screening_runs")
      .select("finished_at, scanned_count, matched_count")
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data as { finished_at: string; scanned_count: number; matched_count: number } | null;
  });

  const {
    data: results,
    error: resultsError,
    isLoading: resultsLoading,
  } = useSWR(
    strategyId ? ["screening-results", strategyId, statusTab, market] : null,
    async ([, sid, tab, mkt]: [string, string, StatusTab, Market]) => {
      let query = supabase
        .from("screening_results")
        .select(
          "id, stock_code, stock_name, entry_price, stop_loss_price, take_profit_price, current_price, return_pct, score, status, matched_at, closed_at"
        )
        .eq("strategy_id", sid)
        .eq("market", mkt) // strategy_id가 이미 시장을 유일하게 결정하지만, 방어적으로 한 번 더 검증한다.
        .order("score", { ascending: false, nullsFirst: false })
        .order("matched_at", { ascending: false });

      query = tab === "active" ? query.eq("status", "active") : query.in("status", ["stopped", "profited"]);

      const { data, error } = await query;
      if (error) throw error;
      return data as ScreeningResultRow[];
    }
  );

  // 종료됨 탭에서만 쓰는 종료일 드롭다운. 실제 closed_at 값이 있는 날짜만 보여줘서
  // 선택해도 항상 결과가 있도록 한다.
  const closedDateOptions = useMemo(() => {
    if (statusTab !== "closed" || !results) return [];
    const labelByKey = new Map<string, string>();
    for (const r of results) {
      if (!r.closed_at) continue;
      const key = closedDateKey(r.closed_at);
      if (!labelByKey.has(key)) labelByKey.set(key, closedDateLabel(r.closed_at));
    }
    return Array.from(labelByKey.entries())
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([key, label]) => ({ key, label }));
  }, [results, statusTab]);

  const displayedResults =
    statusTab === "closed" && closedDate
      ? results?.filter((r) => r.closed_at && closedDateKey(r.closed_at) === closedDate)
      : results;

  const selectClassName =
    "h-10 rounded-lg border border-black/[.08] bg-transparent px-3 text-sm text-black outline-none focus:border-black/30 dark:border-white/[.145] dark:text-zinc-50 dark:focus:border-white/30";

  return (
    <div className="w-full max-w-4xl">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3 rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
        <div className="flex flex-1 min-w-[14rem] flex-col gap-1">
          <label className="text-xs text-zinc-500 dark:text-zinc-400">전략</label>
          <select
            value={strategyId}
            onChange={(e) => {
              setStrategyId(e.target.value);
              setClosedDate("");
            }}
            className={selectClassName}
          >
            <option value="">전략 선택</option>
            {marketStrategies.map((s) => (
              <option key={s.id} value={s.id}>
                {describeStrategy(s)}
              </option>
            ))}
          </select>
          {strategiesLoading && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">전략을 불러오는 중...</p>
          )}
          {!strategiesLoading && marketStrategies.length === 0 && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              등록된 {MARKET_LABELS[market]} 전략이 없습니다. 전략 관리에서 먼저 전략을 추가해주세요.
            </p>
          )}
        </div>

        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {lastRun
            ? `마지막 스캔: ${formatDateTime(lastRun.finished_at)} (전종목 ${lastRun.scanned_count.toLocaleString(
                "ko-KR"
              )}개 중 ${lastRun.matched_count.toLocaleString("ko-KR")}건 신규 매칭)`
            : "아직 실행된 스캔이 없습니다."}
        </p>
      </div>

      {!strategyId ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">전략을 선택해주세요.</p>
      ) : (
        <div className="rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-1">
              {STATUS_TABS.map((tab) => (
                <button
                  key={tab.value}
                  onClick={() => {
                    setStatusTab(tab.value);
                    setClosedDate("");
                  }}
                  className={`h-8 rounded-full px-3 text-sm font-medium transition-colors ${
                    statusTab === tab.value
                      ? "bg-foreground text-background"
                      : "text-zinc-600 hover:bg-black/[.04] dark:text-zinc-400 dark:hover:bg-white/[.08]"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {statusTab === "closed" && closedDateOptions.length > 0 && (
              <select
                value={closedDate}
                onChange={(e) => setClosedDate(e.target.value)}
                className={selectClassName}
              >
                <option value="">종료일: 전체</option>
                {closedDateOptions.map((opt) => (
                  <option key={opt.key} value={opt.key}>
                    {opt.label} 종료
                  </option>
                ))}
              </select>
            )}
          </div>

          {resultsLoading ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">결과를 불러오는 중...</p>
          ) : resultsError ? (
            <p className="text-sm text-blue-600 dark:text-blue-400">결과를 불러오지 못했습니다.</p>
          ) : displayedResults && displayedResults.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-zinc-500 dark:text-zinc-400">
                    <th className="pb-2 pr-4 font-normal">종목명</th>
                    <th className="pb-2 pr-4 font-normal">점수</th>
                    <th className="pb-2 pr-4 font-normal">진입 추천가</th>
                    <th className="pb-2 pr-4 font-normal">손절가</th>
                    <th className="pb-2 pr-4 font-normal">익절가</th>
                    <th className="pb-2 pr-4 font-normal">현재가</th>
                    <th className="pb-2 pr-4 font-normal">수익률</th>
                    <th className="pb-2 pr-4 font-normal">매칭 시각</th>
                    {statusTab === "closed" && <th className="pb-2 font-normal">결과</th>}
                  </tr>
                </thead>
                <tbody>
                  {displayedResults.map((r) => {
                    const returnColor =
                      r.return_pct > 0
                        ? "text-red-600 dark:text-red-400"
                        : r.return_pct < 0
                          ? "text-blue-600 dark:text-blue-400"
                          : "text-black dark:text-zinc-50";
                    const badge = STATUS_BADGE[r.status];

                    return (
                      <tr key={r.id} className="border-t border-black/[.08] dark:border-white/[.145]">
                        <td className="py-2 pr-4 text-black dark:text-zinc-50">
                          {r.stock_name}{" "}
                          <span className="text-xs text-zinc-400 dark:text-zinc-500">
                            {r.stock_code}
                          </span>
                        </td>
                        <td className="py-2 pr-4">
                          <ScoreValue score={r.score} />
                        </td>
                        <td className="py-2 pr-4 text-black dark:text-zinc-50">
                          {formatPrice(r.entry_price, market)}
                        </td>
                        <td className="py-2 pr-4 text-black dark:text-zinc-50">
                          {formatPrice(r.stop_loss_price, market)}
                        </td>
                        <td className="py-2 pr-4 text-black dark:text-zinc-50">
                          {formatPrice(r.take_profit_price, market)}
                        </td>
                        <td className="py-2 pr-4 text-black dark:text-zinc-50">
                          {formatPrice(r.current_price, market)}
                        </td>
                        <td className={`py-2 pr-4 font-medium ${returnColor}`}>
                          {r.return_pct > 0 ? "+" : ""}
                          {r.return_pct.toFixed(2)}%
                        </td>
                        <td className="py-2 pr-4 text-zinc-500 dark:text-zinc-400">
                          {formatDateTime(r.matched_at)}
                        </td>
                        {statusTab === "closed" && (
                          <td className={`py-2 font-medium ${badge.className}`}>{badge.label}</td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {statusTab === "active"
                ? "현재 추적 중인 종목이 없습니다."
                : closedDate
                  ? "해당 날짜에 종료된 종목이 없습니다."
                  : "종료된 종목이 없습니다."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

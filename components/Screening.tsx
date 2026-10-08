"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { describeStrategy, useStrategies } from "@/components/StrategyManager";
import { ScoreValue } from "@/components/ScoreValue";
import { useMarket } from "@/components/MarketContext";
import { formatPrice, MARKET_LABELS, type Market } from "@/lib/market";
import { toKstDateString, formatKstDate, formatKstDateTime } from "@/lib/formatKst";
import { formatPercent } from "@/lib/formatNumber";
import { isMaCrossV2Signal } from "@/lib/maCrossConfig";

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
  status: "active" | "stopped" | "profited" | "price_unavailable" | "price_anomaly";
  matched_at: string;
  closed_at: string | null;
  signal_details: unknown;
}

type StatusTab = "active" | "closed";

const STATUS_TABS: { value: StatusTab; label: string }[] = [
  { value: "active", label: "추적 중" },
  { value: "closed", label: "종료됨" },
];

const STATUS_BADGE: Record<ScreeningResultRow["status"], { label: string; className: string }> = {
  active: { label: "추적 중", className: "text-ink-muted" },
  stopped: { label: "손절", className: "text-fall" },
  profited: { label: "익절", className: "text-rise" },
  // 시세 조회가 연속 실패해 가격이 멈춘 상태(2026-09-20 추가) — 손절/익절과 확실히
  // 구분되도록 est 토큰을 쓴다. "종료됨" 탭이 아니라 "추적 중" 탭에 계속 남는다.
  price_unavailable: { label: "가격 확인 불가", className: "text-est" },
  // 확정된 액면조정 이벤트 없이 가격제한폭을 넘는 변동이 감지돼 손절/익절·집계에서 제외된 상태(이벤트 확정 시 자동 해제).
  price_anomaly: { label: "가격 이상 확인 중", className: "text-est" },
};

function formatDateTime(iso: string): string {
  return formatKstDateTime(iso, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// 종료일 드롭다운의 값/표시용. KST 기준 달력 날짜로 묶어야 자정 근처 종료 건이
// 엉뚱한 날짜로 갈리지 않는다.
function closedDateKey(iso: string): string {
  return toKstDateString(iso);
}

function closedDateLabel(iso: string): string {
  return formatKstDate(iso, { month: "long", day: "numeric", weekday: "short" });
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

  const selectedIsMaCross = useMemo(
    () => marketStrategies.find((s) => s.id === strategyId)?.rule_type === "ma_cross",
    [marketStrategies, strategyId]
  );

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
          "id, stock_code, stock_name, entry_price, stop_loss_price, take_profit_price, current_price, return_pct, score, status, matched_at, closed_at, signal_details"
        )
        .eq("strategy_id", sid)
        .eq("market", mkt) // strategy_id가 이미 시장을 유일하게 결정하지만, 방어적으로 한 번 더 검증한다.
        .order("score", { ascending: false, nullsFirst: false })
        .order("matched_at", { ascending: false });

      // price_unavailable(시세 조회 연속 실패)은 원 신호가 종료된 게 아니라 아직
      // 확인 중인 상태라 "추적 중" 탭에 남긴다 — 안 그러면 이 상태가 된 종목이 두
      // 탭 어디에도 안 보이고 사라진다(2026-09-20 확인).
      query =
        tab === "active"
          ? query.in("status", ["active", "price_unavailable", "price_anomaly"])
          : query.in("status", ["stopped", "profited"]);

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
    "h-10 rounded-lg border border-border bg-transparent px-3 text-sm text-ink outline-none focus:border-black/30 dark:focus:border-white/30";

  return (
    <div className="w-full max-w-4xl">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3 rounded-card border border-border bg-surface p-4">
        <div className="flex flex-1 min-w-[14rem] flex-col gap-1">
          <label className="text-xs text-ink-muted">전략</label>
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
            <p className="text-xs text-ink-muted">전략을 불러오는 중...</p>
          )}
          {!strategiesLoading && marketStrategies.length === 0 && (
            <p className="text-xs text-ink-muted">
              등록된 {MARKET_LABELS[market]} 전략이 없습니다. 전략 관리에서 먼저 전략을 추가해주세요.
            </p>
          )}
        </div>

        <p className="text-xs text-ink-muted">
          {lastRun
            ? `마지막 스캔: ${formatDateTime(lastRun.finished_at)} (전종목 ${lastRun.scanned_count.toLocaleString(
                "ko-KR"
              )}개 중 ${lastRun.matched_count.toLocaleString("ko-KR")}건 신규 매칭)`
            : "아직 실행된 스캔이 없습니다."}
        </p>
      </div>

      {!strategyId ? (
        <p className="text-sm text-ink-muted">전략을 선택해주세요.</p>
      ) : (
        <div className="rounded-card border border-border bg-surface p-4">
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
                      : "text-ink-muted hover:bg-black/[.04] dark:hover:bg-white/[.08]"
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

          {selectedIsMaCross && (
            <p className="mb-3 rounded-card bg-surface-sunken px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
              &quot;구 규칙(5/20)&quot; 표시가 붙은 행은 2026-10-08 규칙 교체 전에 만들어진 신호입니다. 기록은 그대로 보존되며
              손절·익절로 종료될 때까지 목록에 남습니다. 표시가 없는 행이 현재 규칙(50/200)의 신호입니다.
            </p>
          )}

          {resultsLoading ? (
            <p className="text-sm text-ink-muted">결과를 불러오는 중...</p>
          ) : resultsError ? (
            <p className="text-sm text-blue-600 dark:text-blue-400">결과를 불러오지 못했습니다.</p>
          ) : displayedResults && displayedResults.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-ink-muted">
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
                        ? "text-rise"
                        : r.return_pct < 0
                          ? "text-fall"
                          : "text-flat";
                    const badge = STATUS_BADGE[r.status];

                    return (
                      <tr key={r.id} className="border-t border-border">
                        <td className="py-2 pr-4 tabular-nums text-ink">
                          {r.stock_name}{" "}
                          <span className="text-xs text-ink-faint">
                            {r.stock_code}
                          </span>
                          {selectedIsMaCross && !isMaCrossV2Signal(r.signal_details) && (
                            <span
                              title="2026-10-08 이평선 규칙 교체(5/20 → 50/200) 이전에 만들어진 신호입니다."
                              className="ml-2 rounded-full bg-black/[.06] px-2 py-0.5 text-[10px] font-medium text-ink-muted dark:bg-white/[.1]"
                            >
                              구 규칙(5/20)
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          <ScoreValue score={r.score} />
                        </td>
                        <td className="py-2 pr-4 tabular-nums text-ink">
                          {formatPrice(r.entry_price, market)}
                        </td>
                        <td className="py-2 pr-4 tabular-nums text-ink">
                          {formatPrice(r.stop_loss_price, market)}
                        </td>
                        <td className="py-2 pr-4 tabular-nums text-ink">
                          {formatPrice(r.take_profit_price, market)}
                        </td>
                        <td className="py-2 pr-4 tabular-nums text-ink">
                          {formatPrice(r.current_price, market)}
                        </td>
                        <td className={`py-2 pr-4 tabular-nums font-medium ${returnColor}`}>
                          {formatPercent(r.return_pct)}
                        </td>
                        <td className="py-2 pr-4 tabular-nums text-ink-muted">
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
            <p className="text-sm text-ink-muted">
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

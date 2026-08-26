"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { runBacktest, type BacktestResult, type DailyPrice } from "@/lib/backtest";
import { authFetch } from "@/lib/authFetch";
import { describeStrategy, useStrategies } from "@/components/StrategyManager";
import { useMarket } from "@/components/MarketContext";
import { formatPrice } from "@/lib/market";
import SubTabs, { STRATEGY_BACKTEST_TABS } from "@/components/SubTabs";

const WINDOW_OPTIONS = [
  { months: 3, label: "3개월" },
  { months: 6, label: "6개월" },
  { months: 12, label: "1년" },
  { months: 24, label: "2년" },
] as const;

const SEARCH_DEBOUNCE_MS = 250;

interface StockSuggestion {
  code: string;
  name: string;
}

function windowStartDate(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

export default function Backtest({ user }: { user: User }) {
  const { market } = useMarket();
  const { data: strategies, isLoading: strategiesLoading } = useStrategies(user);
  const marketStrategies = useMemo(
    () => strategies?.filter((s) => s.market === market) ?? [],
    [strategies, market]
  );

  const [strategyId, setStrategyId] = useState("");
  const [stockQuery, setStockQuery] = useState("");
  const [suggestions, setSuggestions] = useState<StockSuggestion[]>([]);
  const [selectedStock, setSelectedStock] = useState<StockSuggestion | null>(null);
  const [months, setMonths] = useState<(typeof WINDOW_OPTIONS)[number]["months"]>(12);
  const [running, setRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [stockLabel, setStockLabel] = useState("");
  const [result, setResult] = useState<BacktestResult | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 시장을 전환하면 이전 시장의 전략/검색어/결과가 남아있지 않도록 비운다. 이펙트
  // 대신 렌더 도중 이전 값과 비교해 조정하는 방식(리액트가 권장하는 "prop이 바뀌면
  // 상태 리셋" 패턴)을 쓴다 — 화면이 잘못된 시장 데이터로 한 프레임 깜빡이는 것도 막는다.
  const [prevMarket, setPrevMarket] = useState(market);
  if (market !== prevMarket) {
    setPrevMarket(market);
    setStrategyId("");
    setStockQuery("");
    setSuggestions([]);
    setSelectedStock(null);
    setResult(null);
    setErrorMsg("");
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const selectedStrategy = marketStrategies.find((s) => s.id === strategyId);

  const handleQueryChange = (value: string) => {
    setStockQuery(value);
    setSelectedStock(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = value.trim();
    if (!trimmed) {
      setSuggestions([]);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const res = await authFetch(
          `/api/stock/search?q=${encodeURIComponent(trimmed)}&market=${market}`
        );
        const data = await res.json();
        setSuggestions(res.ok && Array.isArray(data) ? data : []);
      } catch {
        setSuggestions([]);
      }
    }, SEARCH_DEBOUNCE_MS);
  };

  const handleSelectSuggestion = (stock: StockSuggestion) => {
    setStockQuery(stock.name);
    setSelectedStock(stock);
    setSuggestions([]);
  };

  const handleRun = async () => {
    setErrorMsg("");
    setResult(null);

    if (!selectedStrategy) {
      setErrorMsg("전략을 선택해주세요.");
      return;
    }
    const trimmed = stockQuery.trim();
    if (!trimmed) {
      setErrorMsg("종목코드 또는 종목명을 입력해주세요.");
      return;
    }

    setRunning(true);
    try {
      let resolved: StockSuggestion;

      if (selectedStock && selectedStock.name === trimmed) {
        resolved = selectedStock;
      } else {
        const resolveRes = await authFetch(
          `/api/stock/resolve?q=${encodeURIComponent(trimmed)}&market=${market}`
        );
        const data = await resolveRes.json();
        if (!resolveRes.ok) {
          setErrorMsg(data.error ?? "종목을 찾을 수 없습니다.");
          return;
        }
        resolved = data;
      }

      // 모든 전략이 일봉 기준으로 계산되므로 항상 일봉을 가져온다.
      const historyRes = await authFetch(
        `/api/stock/${resolved.code}/history?period=D&market=${market}`
      );
      const prices: DailyPrice[] | { error: string } = await historyRes.json();
      if (!historyRes.ok) {
        setErrorMsg(
          (prices as { error?: string }).error ?? "시세 데이터를 불러오지 못했습니다."
        );
        return;
      }

      const backtestResult = runBacktest(
        prices as DailyPrice[],
        selectedStrategy,
        windowStartDate(months)
      );

      setStockLabel(`${resolved.name} (${resolved.code})`);
      setResult(backtestResult);
    } catch {
      setErrorMsg("백테스트 실행 중 오류가 발생했습니다.");
    } finally {
      setRunning(false);
    }
  };

  const selectClassName =
    "h-10 rounded-lg border border-black/[.08] bg-transparent px-3 text-sm text-black outline-none focus:border-black/30 dark:border-white/[.145] dark:text-zinc-50 dark:focus:border-white/30";

  return (
    <div className="w-full max-w-3xl">
      <SubTabs tabs={STRATEGY_BACKTEST_TABS} />

      <div className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
        <div className="flex flex-1 min-w-[10rem] flex-col gap-1">
          <label className="text-xs text-zinc-500 dark:text-zinc-400">전략</label>
          <select
            value={strategyId}
            onChange={(e) => setStrategyId(e.target.value)}
            className={selectClassName}
          >
            <option value="">전략 선택</option>
            {marketStrategies.map((s) => (
              <option key={s.id} value={s.id}>
                {describeStrategy(s)}
              </option>
            ))}
          </select>
          {!strategiesLoading && marketStrategies.length === 0 && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              등록된 전략이 없습니다.
            </p>
          )}
        </div>
        <div className="relative flex flex-1 min-w-[10rem] flex-col gap-1">
          <label className="text-xs text-zinc-500 dark:text-zinc-400">종목코드 또는 종목명</label>
          <input
            value={stockQuery}
            onChange={(e) => handleQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !running) handleRun();
              if (e.key === "Escape") setSuggestions([]);
            }}
            onBlur={() => {
              window.setTimeout(() => setSuggestions([]), 150);
            }}
            placeholder={market === "KR" ? "005930 또는 삼성전자" : "AAPL 또는 Apple"}
            autoComplete="off"
            className={selectClassName}
          />

          {suggestions.length > 0 && (
            <ul className="absolute top-full left-0 z-10 mt-1 w-full overflow-hidden rounded-lg border border-black/[.08] bg-white shadow-lg dark:border-white/[.145] dark:bg-zinc-900">
              {suggestions.map((stock) => (
                <li key={stock.code}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleSelectSuggestion(stock);
                    }}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-black hover:bg-black/[.04] dark:text-zinc-50 dark:hover:bg-white/[.08]"
                  >
                    <span>{stock.name}</span>
                    <span className="text-xs text-zinc-400 dark:text-zinc-500">
                      {stock.code}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex w-28 flex-col gap-1">
          <label className="text-xs text-zinc-500 dark:text-zinc-400">기간</label>
          <select
            value={months}
            onChange={(e) =>
              setMonths(Number(e.target.value) as (typeof WINDOW_OPTIONS)[number]["months"])
            }
            className={selectClassName}
          >
            {WINDOW_OPTIONS.map((opt) => (
              <option key={opt.months} value={opt.months}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={handleRun}
          disabled={running || strategiesLoading}
          className="h-10 rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
        >
          {running ? "실행 중..." : "백테스트 실행"}
        </button>
        {errorMsg && (
          <p className="w-full text-sm text-blue-600 dark:text-blue-400">{errorMsg}</p>
        )}
      </div>

      {result && (
        <div className="rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
          <p className="mb-4 text-sm font-medium text-zinc-600 dark:text-zinc-400">
            {stockLabel} · {selectedStrategy && describeStrategy(selectedStrategy)}
          </p>

          {result.insufficientData ? (
            <p className="text-sm text-blue-600 dark:text-blue-400">
              조건을 계산하기에 데이터가 부족합니다.
            </p>
          ) : result.tradeCount === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              선택한 기간에 매매 신호가 없습니다.
            </p>
          ) : (
            <>
              <dl className="grid grid-cols-3 gap-3 border-b border-black/[.08] pb-4 text-sm dark:border-white/[.145]">
                <div>
                  <dt className="text-zinc-500 dark:text-zinc-400">총 수익률</dt>
                  <dd
                    className={
                      result.totalReturnPct > 0
                        ? "mt-1 text-lg font-semibold text-red-600 dark:text-red-400"
                        : result.totalReturnPct < 0
                          ? "mt-1 text-lg font-semibold text-blue-600 dark:text-blue-400"
                          : "mt-1 text-lg font-semibold text-black dark:text-zinc-50"
                    }
                  >
                    {result.totalReturnPct.toFixed(2)}%
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500 dark:text-zinc-400">거래 횟수</dt>
                  <dd className="mt-1 text-lg font-semibold text-black dark:text-zinc-50">
                    {result.tradeCount}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500 dark:text-zinc-400">승률</dt>
                  <dd className="mt-1 text-lg font-semibold text-black dark:text-zinc-50">
                    {(result.winRate * 100).toFixed(1)}%
                  </dd>
                </div>
              </dl>

              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-zinc-500 dark:text-zinc-400">
                      <th className="pb-2 pr-4 font-normal">매수일</th>
                      <th className="pb-2 pr-4 font-normal">매수가</th>
                      <th className="pb-2 pr-4 font-normal">매도일</th>
                      <th className="pb-2 pr-4 font-normal">매도가</th>
                      <th className="pb-2 font-normal">수익률</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.map((trade, i) => (
                      <tr key={i} className="border-t border-black/[.08] dark:border-white/[.145]">
                        <td className="py-2 pr-4 text-black dark:text-zinc-50">{trade.buyDate}</td>
                        <td className="py-2 pr-4 text-black dark:text-zinc-50">
                          {formatPrice(trade.buyPrice, market)}
                        </td>
                        <td className="py-2 pr-4 text-black dark:text-zinc-50">{trade.sellDate}</td>
                        <td className="py-2 pr-4 text-black dark:text-zinc-50">
                          {formatPrice(trade.sellPrice, market)}
                        </td>
                        <td
                          className={
                            trade.returnPct > 0
                              ? "py-2 text-red-600 dark:text-red-400"
                              : trade.returnPct < 0
                                ? "py-2 text-blue-600 dark:text-blue-400"
                                : "py-2 text-black dark:text-zinc-50"
                          }
                        >
                          {(trade.returnPct * 100).toFixed(2)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

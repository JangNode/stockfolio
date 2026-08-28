"use client";

import { useState } from "react";
import useSWR from "swr";
import type { User } from "@supabase/supabase-js";
import { authFetch, authJsonFetcher } from "@/lib/authFetch";
import { useMarket } from "@/components/MarketContext";
import SubTabs, { LAB_PAPER_TRADING_TABS } from "@/components/SubTabs";
import { formatPrice, MARKET_LABELS, type Market } from "@/lib/market";
import { CUSTOM_BACKTEST_PERIOD_MONTHS, FUNDAMENTAL_CONDITION_COMPARATORS } from "@/lib/customBacktestRequest";
import type { BacktestTrade, CustomCompositeParams, CustomFundamentalConditions, FundamentalConditionComparator } from "@/lib/backtest";

const PERIOD_LABELS: Record<(typeof CUSTOM_BACKTEST_PERIOD_MONTHS)[number], string> = {
  12: "최근 1년",
  36: "최근 3년",
};

type FundamentalFieldKey = keyof CustomFundamentalConditions;

const FUNDAMENTAL_FIELD_ORDER: FundamentalFieldKey[] = [
  "market_cap_eok",
  "per",
  "pbr",
  "peg",
  "consecutive_dividend_years",
  "dividend_yield_pct",
];

const FUNDAMENTAL_FIELD_LABELS: Record<FundamentalFieldKey, string> = {
  market_cap_eok: "시가총액(억원)",
  per: "PER(배)",
  pbr: "PBR(배)",
  peg: "PEG",
  consecutive_dividend_years: "배당 연속 지급 연수(년)",
  dividend_yield_pct: "배당수익률(%)",
};

const FUNDAMENTAL_COMPARATOR_LABELS: Record<FundamentalConditionComparator, string> = {
  gte: "이상",
  lte: "이하",
  gt: "초과",
  lt: "미만",
};

interface FundamentalFieldState {
  enabled: boolean;
  comparator: FundamentalConditionComparator;
  value: number;
}

type FundamentalFieldsState = Record<FundamentalFieldKey, FundamentalFieldState>;

// 값 자체는 사용자가 화면에서 바꿔가며 반복 실행하는 게 전제라 상수로 강제하지
// 않는다 — 여기 기본값은 DH전략/PEG전략과 비슷한 감각의 "체크박스를 켰을 때 채워질
// 초기값"일 뿐이다.
const DEFAULT_FUNDAMENTAL_FIELDS: FundamentalFieldsState = {
  market_cap_eok: { enabled: false, comparator: "gte", value: 10000 },
  per: { enabled: false, comparator: "lte", value: 15 },
  pbr: { enabled: false, comparator: "lte", value: 1.5 },
  peg: { enabled: false, comparator: "lte", value: 1 },
  consecutive_dividend_years: { enabled: false, comparator: "gte", value: 5 },
  dividend_yield_pct: { enabled: false, comparator: "gte", value: 3 },
};

/** rule_params.fundamentals(선택된 항목만 comparator+value)를 사람이 읽을 수 있는
 * 조각 문자열 목록으로 바꾼다(요청 이력 요약, 결과 패널 등에서 재사용). */
function describeFundamentalConditions(fc: CustomFundamentalConditions | undefined): string[] {
  if (!fc) return [];
  return FUNDAMENTAL_FIELD_ORDER.filter((key) => fc[key] !== undefined).map((key) => {
    const condition = fc[key]!;
    return `${FUNDAMENTAL_FIELD_LABELS[key]} ${condition.value}${FUNDAMENTAL_COMPARATOR_LABELS[condition.comparator]}`;
  });
}

type RunStatus = "pending" | "running" | "completed" | "failed";

interface RunRow {
  id: string;
  market: Market;
  rule_params: CustomCompositeParams;
  period_months: number;
  status: RunStatus;
  total_return_pct: number | null;
  win_rate: number | null;
  mdd_pct: number | null;
  matched_stock_count: number | null;
  trade_count: number | null;
  error_message: string | null;
  adopted_at: string | null;
  created_at: string;
  finished_at: string | null;
}

interface MatchedStock {
  stockCode: string;
  stockName: string;
  trades: BacktestTrade[];
  totalReturnPct: number;
  tradeCount: number;
  winRate: number;
}

interface RunDetailResponse {
  run: RunRow;
  result: { matchedStocks: MatchedStock[] } | null;
}

const STATUS_LABELS: Record<RunStatus, string> = {
  pending: "대기 중",
  running: "실행 중",
  completed: "완료",
  failed: "실패",
};

const STATUS_BADGE_CLASS: Record<RunStatus, string> = {
  pending: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  running: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
  completed: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400",
  failed: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
};

/** rule_params를 사람이 읽을 수 있는 한 줄 요약으로 바꾼다(요청 이력 목록 표시용). */
function describeRuleParams(params: CustomCompositeParams): string {
  const parts: string[] = [];
  if (params.ma_cross) parts.push(`이평 ${params.ma_cross.short_period}/${params.ma_cross.long_period}일 교차`);
  if (params.rsi) {
    parts.push(`RSI(${params.rsi.period}) ${params.rsi.direction === "above" ? "≥" : "≤"} ${params.rsi.threshold}`);
  }
  if (params.volume_surge) {
    parts.push(`거래량 ${params.volume_surge.period}일 평균 대비 ${params.volume_surge.multiplier}배 이상`);
  }
  parts.push(...describeFundamentalConditions(params.fundamentals));
  return parts.length > 0 ? parts.join(", ") : "조건 없음";
}

function statColorClass(value: number): string {
  if (value > 0) return "text-red-600 dark:text-red-400";
  if (value < 0) return "text-blue-600 dark:text-blue-400";
  return "text-black dark:text-zinc-50";
}

const selectClassName =
  "h-10 rounded-lg border border-black/[.08] bg-transparent px-3 text-sm text-black outline-none focus:border-black/30 dark:border-white/[.145] dark:text-zinc-50 dark:focus:border-white/30";
const numberInputClassName =
  "h-9 w-20 rounded-lg border border-black/[.08] bg-transparent px-2 text-sm text-black outline-none focus:border-black/30 dark:border-white/[.145] dark:text-zinc-50 dark:focus:border-white/30";

function MatchedStockTrades({ trades, market }: { trades: BacktestTrade[]; market: Market }) {
  return (
    <div className="overflow-x-auto">
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
          {trades.map((trade, i) => (
            <tr key={i} className="border-t border-black/[.08] dark:border-white/[.145]">
              <td className="py-2 pr-4 text-black dark:text-zinc-50">{trade.buyDate}</td>
              <td className="py-2 pr-4 text-black dark:text-zinc-50">{formatPrice(trade.buyPrice, market)}</td>
              <td className="py-2 pr-4 text-black dark:text-zinc-50">{trade.sellDate}</td>
              <td className="py-2 pr-4 text-black dark:text-zinc-50">{formatPrice(trade.sellPrice, market)}</td>
              <td className={`py-2 ${statColorClass(trade.returnPct)}`}>{(trade.returnPct * 100).toFixed(2)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunResultPanel({
  run,
  result,
  onAdopt,
  adopting,
  adoptError,
}: {
  run: RunRow;
  result: { matchedStocks: MatchedStock[] } | null;
  onAdopt: () => void;
  adopting: boolean;
  adoptError: string;
}) {
  const [expandedCode, setExpandedCode] = useState<string | null>(null);

  if (run.status === "pending" || run.status === "running") {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        {STATUS_LABELS[run.status]}... 전체 종목 풀을 조회해 백테스트하는 데 시간이 걸릴 수 있습니다(수십 분 이상).
      </p>
    );
  }

  if (run.status === "failed") {
    return (
      <p className="text-sm text-blue-600 dark:text-blue-400">
        백테스트 실행에 실패했습니다{run.error_message ? `: ${run.error_message}` : "."}
      </p>
    );
  }

  if (!result || result.matchedStocks.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">조건에 해당하는 종목이 없습니다.</p>
    );
  }

  return (
    <>
      <dl className="grid grid-cols-2 gap-3 border-b border-black/[.08] pb-4 text-sm sm:grid-cols-5 dark:border-white/[.145]">
        <div>
          <dt className="text-zinc-500 dark:text-zinc-400">전체 수익률</dt>
          <dd className={`mt-1 text-lg font-semibold ${statColorClass(run.total_return_pct ?? 0)}`}>
            {(run.total_return_pct ?? 0).toFixed(2)}%
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500 dark:text-zinc-400">승률</dt>
          <dd className="mt-1 text-lg font-semibold text-black dark:text-zinc-50">
            {((run.win_rate ?? 0) * 100).toFixed(1)}%
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500 dark:text-zinc-400">MDD</dt>
          <dd className="mt-1 text-lg font-semibold text-black dark:text-zinc-50">
            -{(run.mdd_pct ?? 0).toFixed(2)}%
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500 dark:text-zinc-400">매칭 종목</dt>
          <dd className="mt-1 text-lg font-semibold text-black dark:text-zinc-50">{run.matched_stock_count ?? 0}개</dd>
        </div>
        <div>
          <dt className="text-zinc-500 dark:text-zinc-400">총 거래</dt>
          <dd className="mt-1 text-lg font-semibold text-black dark:text-zinc-50">{run.trade_count ?? 0}건</dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center gap-3 border-b border-black/[.08] py-4 dark:border-white/[.145]">
        {run.adopted_at ? (
          <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-700 dark:bg-green-950 dark:text-green-400">
            AI 모의투자(커스텀)로 채택됨
          </span>
        ) : (
          <button
            onClick={onAdopt}
            disabled={adopting}
            className="h-9 rounded-full bg-foreground px-4 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
          >
            {adopting ? "채택 중..." : "이 조건을 AI 모의투자(커스텀)로 채택"}
          </button>
        )}
        {adoptError && <p className="text-sm text-blue-600 dark:text-blue-400">{adoptError}</p>}
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-zinc-500 dark:text-zinc-400">
              <th className="pb-2 pr-4 font-normal">종목</th>
              <th className="pb-2 pr-4 font-normal">수익률</th>
              <th className="pb-2 pr-4 font-normal">거래 횟수</th>
              <th className="pb-2 font-normal">승률</th>
            </tr>
          </thead>
          <tbody>
            {result.matchedStocks.map((stock) => (
              <>
                <tr
                  key={stock.stockCode}
                  onClick={() => setExpandedCode(expandedCode === stock.stockCode ? null : stock.stockCode)}
                  className="cursor-pointer border-t border-black/[.08] hover:bg-black/[.02] dark:border-white/[.145] dark:hover:bg-white/[.04]"
                >
                  <td className="py-2 pr-4 text-black dark:text-zinc-50">
                    {stock.stockName} ({stock.stockCode})
                  </td>
                  <td className={`py-2 pr-4 ${statColorClass(stock.totalReturnPct)}`}>
                    {stock.totalReturnPct.toFixed(2)}%
                  </td>
                  <td className="py-2 pr-4 text-black dark:text-zinc-50">{stock.tradeCount}건</td>
                  <td className="py-2 text-black dark:text-zinc-50">{(stock.winRate * 100).toFixed(1)}%</td>
                </tr>
                {expandedCode === stock.stockCode && (
                  <tr key={`${stock.stockCode}-detail`}>
                    <td colSpan={4} className="bg-black/[.02] p-3 dark:bg-white/[.04]">
                      <MatchedStockTrades trades={stock.trades} market={run.market} />
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// user는 사용하지 않는다(백엔드가 인증 토큰으로 직접 식별) — RequireApproved가
// 로그인 사용자에게만 렌더링하도록 상위(app/lab/page.tsx)에서 이미 보장한다.
export default function StrategyLab({}: { user: User }) {
  const { market } = useMarket();

  const [maCrossEnabled, setMaCrossEnabled] = useState(false);
  const [maShort, setMaShort] = useState(5);
  const [maLong, setMaLong] = useState(20);

  const [rsiEnabled, setRsiEnabled] = useState(false);
  const [rsiPeriod, setRsiPeriod] = useState(14);
  const [rsiThreshold, setRsiThreshold] = useState(30);
  const [rsiDirection, setRsiDirection] = useState<"above" | "below">("below");

  const [volumeEnabled, setVolumeEnabled] = useState(false);
  const [volumePeriod, setVolumePeriod] = useState(20);
  const [volumeMultiplier, setVolumeMultiplier] = useState(2);

  const [fundamentalFields, setFundamentalFields] = useState<FundamentalFieldsState>(DEFAULT_FUNDAMENTAL_FIELDS);
  const updateFundamentalField = (key: FundamentalFieldKey, patch: Partial<FundamentalFieldState>) => {
    setFundamentalFields((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  };

  const [stopLossPct, setStopLossPct] = useState(7);
  const [takeProfitPct, setTakeProfitPct] = useState(20);
  const [periodMonths, setPeriodMonths] = useState<(typeof CUSTOM_BACKTEST_PERIOD_MONTHS)[number]>(12);

  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [viewRunId, setViewRunId] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [adoptError, setAdoptError] = useState("");

  const { data: runsData, mutate: mutateRuns } = useSWR(
    ["lab-backtest-runs"],
    () => authJsonFetcher<{ runs: RunRow[] }>("/api/lab/backtest")
  );

  const { data: viewData, isLoading: viewLoading, mutate: mutateView } = useSWR(
    viewRunId ? ["lab-backtest-run", viewRunId] : null,
    () => authJsonFetcher<RunDetailResponse>(`/api/lab/backtest/${viewRunId}`),
    {
      refreshInterval: (data) =>
        data && (data.run.status === "completed" || data.run.status === "failed") ? 0 : 10000,
      onSuccess: (data) => {
        if (data.run.status === "completed" || data.run.status === "failed") mutateRuns();
      },
    }
  );

  const handleAdopt = async () => {
    if (!viewRunId) return;
    setAdoptError("");
    setAdopting(true);
    try {
      const res = await authFetch(`/api/lab/backtest/${viewRunId}/adopt`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setAdoptError(data.error ?? "채택에 실패했습니다.");
        return;
      }
      mutateView();
      mutateRuns();
    } catch {
      setAdoptError("채택 요청 중 오류가 발생했습니다.");
    } finally {
      setAdopting(false);
    }
  };

  // market="US"에서는 펀더멘털 조건을 아예 보낼 수 없으므로(DART 재무는 국내
  // 상장사만 다룸) 화면에서 체크만 해두고 시장을 KR로 바꾸지 않은 채 제출해도 조용히
  // 무시되도록, 조건 계산 자체를 market === "KR"일 때로 한정한다.
  const fundamentals: CustomFundamentalConditions | undefined =
    market === "KR"
      ? FUNDAMENTAL_FIELD_ORDER.reduce<CustomFundamentalConditions>((acc, key) => {
          const field = fundamentalFields[key];
          if (field.enabled) acc[key] = { comparator: field.comparator, value: field.value };
          return acc;
        }, {})
      : undefined;
  const hasFundamentals = !!fundamentals && Object.keys(fundamentals).length > 0;

  const handleSubmit = async () => {
    setErrorMsg("");

    if (!maCrossEnabled && !rsiEnabled && !volumeEnabled && !hasFundamentals) {
      setErrorMsg("조건을 최소 1개 이상 선택해주세요.");
      return;
    }

    const rule_params: CustomCompositeParams = {
      ...(maCrossEnabled ? { ma_cross: { short_period: maShort, long_period: maLong } } : {}),
      ...(rsiEnabled ? { rsi: { period: rsiPeriod, threshold: rsiThreshold, direction: rsiDirection } } : {}),
      ...(volumeEnabled ? { volume_surge: { period: volumePeriod, multiplier: volumeMultiplier } } : {}),
      ...(hasFundamentals ? { fundamentals } : {}),
      stop_loss_pct: stopLossPct / 100,
      take_profit_pct: takeProfitPct / 100,
    };

    setSubmitting(true);
    try {
      const res = await authFetch("/api/lab/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market, period_months: periodMonths, rule_params }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error ?? "백테스트 요청에 실패했습니다.");
        return;
      }
      setViewRunId(data.id);
      mutateRuns();
    } catch {
      setErrorMsg("백테스트 요청 중 오류가 발생했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-4xl">
      <SubTabs tabs={LAB_PAPER_TRADING_TABS} />

      <div className="mb-6 rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
          조건을 직접 구성해 {MARKET_LABELS[market]} 전체 종목 풀을 대상으로 백테스트합니다. 조건은 모두
          동시에(AND) 만족해야 매칭됩니다.
        </p>

        <div className="mb-4 flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm text-black dark:text-zinc-50">
            <input type="checkbox" checked={maCrossEnabled} onChange={(e) => setMaCrossEnabled(e.target.checked)} />
            이동평균 골든크로스(단기 이평선이 장기 이평선 위)
          </label>
          {maCrossEnabled && (
            <div className="ml-6 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
              단기
              <input
                type="number"
                min={2}
                value={maShort}
                onChange={(e) => setMaShort(Number(e.target.value))}
                className={numberInputClassName}
              />
              일 / 장기
              <input
                type="number"
                min={3}
                value={maLong}
                onChange={(e) => setMaLong(Number(e.target.value))}
                className={numberInputClassName}
              />
              일
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-black dark:text-zinc-50">
            <input type="checkbox" checked={rsiEnabled} onChange={(e) => setRsiEnabled(e.target.checked)} />
            RSI
          </label>
          {rsiEnabled && (
            <div className="ml-6 flex flex-wrap items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
              <input
                type="number"
                min={2}
                value={rsiPeriod}
                onChange={(e) => setRsiPeriod(Number(e.target.value))}
                className={numberInputClassName}
              />
              일 RSI가
              <select
                value={rsiDirection}
                onChange={(e) => setRsiDirection(e.target.value as "above" | "below")}
                className={selectClassName}
              >
                <option value="below">이하</option>
                <option value="above">이상</option>
              </select>
              <input
                type="number"
                min={0}
                max={100}
                value={rsiThreshold}
                onChange={(e) => setRsiThreshold(Number(e.target.value))}
                className={numberInputClassName}
              />
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-black dark:text-zinc-50">
            <input type="checkbox" checked={volumeEnabled} onChange={(e) => setVolumeEnabled(e.target.checked)} />
            거래량 급증
          </label>
          {volumeEnabled && (
            <div className="ml-6 flex flex-wrap items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
              당일 거래량이 최근
              <input
                type="number"
                min={2}
                value={volumePeriod}
                onChange={(e) => setVolumePeriod(Number(e.target.value))}
                className={numberInputClassName}
              />
              일 평균 대비
              <input
                type="number"
                min={1}
                step={0.1}
                value={volumeMultiplier}
                onChange={(e) => setVolumeMultiplier(Number(e.target.value))}
                className={numberInputClassName}
              />
              배 이상
            </div>
          )}
        </div>

        <div className="mb-4 border-t border-black/[.08] pt-3 dark:border-white/[.145]">
          <p className="mb-2 text-sm font-medium text-black dark:text-zinc-50">
            펀더멘털
            {market === "US" && (
              <span className="ml-2 text-xs font-normal text-zinc-500 dark:text-zinc-400">
                (DART 재무 데이터는 국내 상장사만 다뤄 국내(KR) 시장에서만 사용할 수 있습니다)
              </span>
            )}
          </p>
          <div className="flex flex-col gap-3">
            {FUNDAMENTAL_FIELD_ORDER.map((key) => {
              const field = fundamentalFields[key];
              return (
                <div key={key}>
                  <label className="flex items-center gap-2 text-sm text-black dark:text-zinc-50">
                    <input
                      type="checkbox"
                      checked={field.enabled}
                      disabled={market === "US"}
                      onChange={(e) => updateFundamentalField(key, { enabled: e.target.checked })}
                    />
                    {FUNDAMENTAL_FIELD_LABELS[key]}
                  </label>
                  {field.enabled && market === "KR" && (
                    <div className="ml-6 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
                      <select
                        value={field.comparator}
                        onChange={(e) =>
                          updateFundamentalField(key, { comparator: e.target.value as FundamentalConditionComparator })
                        }
                        className={selectClassName}
                      >
                        {FUNDAMENTAL_CONDITION_COMPARATORS.map((c) => (
                          <option key={c} value={c}>
                            {FUNDAMENTAL_COMPARATOR_LABELS[c]}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        step={key === "peg" || key === "pbr" ? 0.1 : 1}
                        value={field.value}
                        onChange={(e) => updateFundamentalField(key, { value: Number(e.target.value) })}
                        className={numberInputClassName}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="mb-4 flex flex-wrap items-end gap-3 border-t border-black/[.08] pt-4 dark:border-white/[.145]">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-zinc-500 dark:text-zinc-400">손절 비율(%)</label>
            <input
              type="number"
              min={1}
              max={90}
              value={stopLossPct}
              onChange={(e) => setStopLossPct(Number(e.target.value))}
              className={numberInputClassName}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-zinc-500 dark:text-zinc-400">익절 비율(%)</label>
            <input
              type="number"
              min={1}
              max={500}
              value={takeProfitPct}
              onChange={(e) => setTakeProfitPct(Number(e.target.value))}
              className={numberInputClassName}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-zinc-500 dark:text-zinc-400">기간</label>
            <select
              value={periodMonths}
              onChange={(e) =>
                setPeriodMonths(Number(e.target.value) as (typeof CUSTOM_BACKTEST_PERIOD_MONTHS)[number])
              }
              className={selectClassName}
            >
              {CUSTOM_BACKTEST_PERIOD_MONTHS.map((m) => (
                <option key={m} value={m}>
                  {PERIOD_LABELS[m]}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="h-10 rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
          >
            {submitting ? "요청 중..." : "백테스트 실행"}
          </button>
        </div>

        {errorMsg && <p className="text-sm text-blue-600 dark:text-blue-400">{errorMsg}</p>}
      </div>

      {viewRunId && (
        <div className="mb-6 rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
          <div className="mb-4 flex items-center gap-2">
            <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">백테스트 결과</p>
            {viewData && (
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS[viewData.run.status]}`}>
                {STATUS_LABELS[viewData.run.status]}
              </span>
            )}
          </div>
          {viewLoading && !viewData ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">불러오는 중...</p>
          ) : viewData ? (
            <RunResultPanel
              run={viewData.run}
              result={viewData.result}
              onAdopt={handleAdopt}
              adopting={adopting}
              adoptError={adoptError}
            />
          ) : null}
        </div>
      )}

      <div className="rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
        <p className="mb-3 text-sm font-medium text-zinc-600 dark:text-zinc-400">지난 요청</p>
        {!runsData ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">불러오는 중...</p>
        ) : runsData.runs.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">아직 요청한 백테스트가 없습니다.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {runsData.runs.map((run) => (
              <li key={run.id}>
                <button
                  onClick={() => setViewRunId(run.id)}
                  className={`flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    viewRunId === run.id
                      ? "border-black/30 dark:border-white/30"
                      : "border-black/[.08] hover:bg-black/[.02] dark:border-white/[.145] dark:hover:bg-white/[.04]"
                  }`}
                >
                  <span className="text-black dark:text-zinc-50">
                    {MARKET_LABELS[run.market]} · {describeRuleParams(run.rule_params)} · {PERIOD_LABELS[run.period_months as (typeof CUSTOM_BACKTEST_PERIOD_MONTHS)[number]] ?? `${run.period_months}개월`}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS[run.status]}`}>
                    {STATUS_LABELS[run.status]}
                    {run.status === "completed" && run.total_return_pct !== null
                      ? ` · ${run.total_return_pct.toFixed(1)}%`
                      : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

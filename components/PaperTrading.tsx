"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { supabase } from "@/lib/supabase";

type PaperStyle = "aggressive" | "conservative";
type SubScreen = "overview" | "detail" | "trades" | "history";

const STYLES: PaperStyle[] = ["aggressive", "conservative"];
const STYLE_LABEL: Record<PaperStyle, string> = {
  aggressive: "공격형",
  conservative: "안정형",
};

const SUB_SCREENS: { value: SubScreen; label: string }[] = [
  { value: "overview", label: "개요" },
  { value: "detail", label: "전략 상세" },
  { value: "trades", label: "매매 내역" },
  { value: "history", label: "전략 히스토리" },
];

interface PortfolioRow {
  id: string;
  style: PaperStyle;
  initial_capital: number;
  cash: number;
}

interface SnapshotRow {
  portfolio_id: string;
  snapshot_date: string;
  cash: number;
  holdings_value: number;
  equity: number;
  daily_return_pct: number;
  cumulative_return_pct: number;
}

interface EntryConditions {
  source_rule_types: string[];
  min_signal_return_pct: number;
  max_signal_return_pct: number;
  max_positions: number;
  position_size_pct: number;
}

interface ExitConditions {
  take_profit_pct: number;
  stop_loss_pct: number;
  max_holding_days: number;
}

interface StockSelectionCriteria {
  prefer_higher_return_pct: boolean;
  max_candidates_to_consider: number;
}

interface StrategyRow {
  id: string;
  style: PaperStyle;
  version: number;
  label: string;
  entry_conditions: EntryConditions;
  exit_conditions: ExitConditions;
  stock_selection_criteria: StockSelectionCriteria;
  rationale: string;
  is_active: boolean;
  created_at: string;
  retired_at: string | null;
}

interface PositionRow {
  id: string;
  portfolio_id: string;
  stock_code: string;
  stock_name: string;
  quantity: number;
  avg_price: number;
  opened_at: string;
  screening_result_id: string | null;
  currentPrice: number | null;
}

interface TradeRow {
  id: string;
  portfolio_id: string;
  stock_code: string;
  stock_name: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  amount: number;
  realized_pnl: number | null;
  rationale: string;
  traded_at: string;
}

const TRADE_HISTORY_LIMIT = 200;

function toKstDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function returnColorClass(pct: number): string {
  if (pct > 0) return "text-red-600 dark:text-red-400";
  if (pct < 0) return "text-blue-600 dark:text-blue-400";
  return "text-black dark:text-zinc-50";
}

function signedPct(pct: number): string {
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function usePortfolios() {
  return useSWR("paper-portfolios", async () => {
    const { data, error } = await supabase
      .from("paper_portfolios")
      .select("id, style, initial_capital, cash");
    if (error) throw error;
    return data as PortfolioRow[];
  });
}

function useSnapshots() {
  return useSWR("paper-daily-snapshots", async () => {
    const { data, error } = await supabase
      .from("paper_daily_snapshots")
      .select("portfolio_id, snapshot_date, cash, holdings_value, equity, daily_return_pct, cumulative_return_pct")
      .order("snapshot_date", { ascending: true });
    if (error) throw error;
    return data as SnapshotRow[];
  });
}

function useStrategies() {
  return useSWR("paper-strategies", async () => {
    const { data, error } = await supabase
      .from("paper_strategies")
      .select(
        "id, style, version, label, entry_conditions, exit_conditions, stock_selection_criteria, rationale, is_active, created_at, retired_at"
      )
      .order("style", { ascending: true })
      .order("version", { ascending: false });
    if (error) throw error;
    return data as StrategyRow[];
  });
}

function usePositions() {
  return useSWR("paper-positions", async () => {
    const { data: positions, error } = await supabase
      .from("paper_positions")
      .select("id, portfolio_id, stock_code, stock_name, quantity, avg_price, opened_at, screening_result_id");
    if (error) throw error;

    const screeningIds = Array.from(
      new Set((positions ?? []).map((p) => p.screening_result_id).filter((id): id is string => id !== null))
    );

    const priceById = new Map<string, number>();
    if (screeningIds.length > 0) {
      const { data: screeningRows, error: screeningError } = await supabase
        .from("screening_results")
        .select("id, current_price")
        .in("id", screeningIds);
      if (screeningError) throw screeningError;
      for (const row of screeningRows ?? []) priceById.set(row.id, row.current_price);
    }

    return (positions ?? []).map((p) => ({
      ...p,
      currentPrice: p.screening_result_id ? (priceById.get(p.screening_result_id) ?? null) : null,
    })) as PositionRow[];
  });
}

function useTrades() {
  return useSWR("paper-trades", async () => {
    const { data, error } = await supabase
      .from("paper_trades")
      .select("id, portfolio_id, stock_code, stock_name, side, quantity, price, amount, realized_pnl, rationale, traded_at")
      .order("traded_at", { ascending: false })
      .limit(TRADE_HISTORY_LIMIT);
    if (error) throw error;
    return data as TradeRow[];
  });
}

/** 전략 버전 하나가 활성이었던 기간(created_at~retired_at, 없으면 지금까지)의
 * 평가금액 변화율. 그 기간에 스냅샷이 없으면(당일 재생성 등) null. */
function computePeriodReturnPct(
  snapshots: SnapshotRow[],
  portfolioId: string,
  createdAt: string,
  retiredAt: string | null
): number | null {
  const startDate = toKstDate(createdAt);
  const endDate = retiredAt ? toKstDate(retiredAt) : null;
  const inRange = snapshots.filter(
    (s) =>
      s.portfolio_id === portfolioId &&
      s.snapshot_date >= startDate &&
      (endDate === null || s.snapshot_date <= endDate)
  );
  if (inRange.length === 0) return null;
  const first = inRange[0];
  const last = inRange[inRange.length - 1];
  if (first.equity <= 0) return null;
  return ((last.equity - first.equity) / first.equity) * 100;
}

/** 의존성 없는 간단한 인라인 SVG 라인 스파크라인. */
function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) {
    return <div className={`flex h-16 items-center text-xs text-zinc-400 ${className ?? ""}`}>데이터 부족</div>;
  }

  const width = 300;
  const height = 56;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const last = values[values.length - 1];
  const first = values[0];
  const stroke = last >= first ? "#dc2626" : "#2563eb";

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={`h-16 w-full ${className ?? ""}`} preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={stroke} strokeWidth={2} />
    </svg>
  );
}

function OverviewScreen({
  portfolios,
  snapshots,
  positions,
}: {
  portfolios: PortfolioRow[];
  snapshots: SnapshotRow[];
  positions: PositionRow[];
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {STYLES.map((style) => {
        const portfolio = portfolios.find((p) => p.style === style);
        const styleSnapshots = snapshots.filter((s) => s.portfolio_id === portfolio?.id);
        const latest = styleSnapshots[styleSnapshots.length - 1];
        const holdingCount = positions.filter((p) => p.portfolio_id === portfolio?.id).length;

        return (
          <div
            key={style}
            className="rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950"
          >
            <p className="text-sm font-medium text-black dark:text-zinc-50">{STYLE_LABEL[style]}</p>

            {!portfolio || !latest ? (
              <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
                아직 실행된 배치가 없습니다.
              </p>
            ) : (
              <>
                <p className="mt-2 text-2xl font-semibold text-black dark:text-zinc-50">
                  {Math.round(latest.equity).toLocaleString("ko-KR")}원
                </p>
                <div className="mt-1 flex gap-4 text-sm">
                  <span className={returnColorClass(latest.cumulative_return_pct)}>
                    누적 {signedPct(latest.cumulative_return_pct)}
                  </span>
                  <span className={returnColorClass(latest.daily_return_pct)}>
                    일간 {signedPct(latest.daily_return_pct)}
                  </span>
                </div>
                <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                  현금 {Math.round(latest.cash).toLocaleString("ko-KR")}원 · 보유 {holdingCount}종목
                </p>
                <Sparkline
                  values={styleSnapshots.map((s) => s.equity)}
                  className="mt-3"
                />
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ConditionsSummary({ strategy }: { strategy: StrategyRow }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div>
        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">진입조건</p>
        <pre className="mt-1 overflow-x-auto rounded-lg bg-black/[.03] p-2 text-xs text-black dark:bg-white/[.06] dark:text-zinc-50">
          {JSON.stringify(strategy.entry_conditions, null, 2)}
        </pre>
      </div>
      <div>
        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">청산조건</p>
        <pre className="mt-1 overflow-x-auto rounded-lg bg-black/[.03] p-2 text-xs text-black dark:bg-white/[.06] dark:text-zinc-50">
          {JSON.stringify(strategy.exit_conditions, null, 2)}
        </pre>
      </div>
      <div>
        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">종목선정기준</p>
        <pre className="mt-1 overflow-x-auto rounded-lg bg-black/[.03] p-2 text-xs text-black dark:bg-white/[.06] dark:text-zinc-50">
          {JSON.stringify(strategy.stock_selection_criteria, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function StyleToggle({ value, onChange }: { value: PaperStyle; onChange: (style: PaperStyle) => void }) {
  return (
    <div className="mb-3 flex gap-1">
      {STYLES.map((style) => (
        <button
          key={style}
          onClick={() => onChange(style)}
          className={`h-8 rounded-full px-3 text-sm font-medium transition-colors ${
            value === style
              ? "bg-foreground text-background"
              : "text-zinc-600 hover:bg-black/[.04] dark:text-zinc-400 dark:hover:bg-white/[.08]"
          }`}
        >
          {STYLE_LABEL[style]}
        </button>
      ))}
    </div>
  );
}

function DetailScreen({
  portfolios,
  strategies,
  positions,
}: {
  portfolios: PortfolioRow[];
  strategies: StrategyRow[];
  positions: PositionRow[];
}) {
  const [style, setStyle] = useState<PaperStyle>("aggressive");
  const portfolio = portfolios.find((p) => p.style === style);
  const active = strategies.find((s) => s.style === style && s.is_active);
  const holdings = positions.filter((p) => p.portfolio_id === portfolio?.id);

  return (
    <div>
      <StyleToggle value={style} onChange={setStyle} />

      {!active ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">아직 생성된 전략이 없습니다.</p>
      ) : (
        <div className="rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
          <p className="font-medium text-black dark:text-zinc-50">
            {active.label} <span className="text-xs text-zinc-400 dark:text-zinc-500">v{active.version}</span>
          </p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{formatDate(active.created_at)} 생성</p>
          <p className="mt-3 text-sm text-black dark:text-zinc-50">{active.rationale}</p>

          <div className="mt-4 border-t border-black/[.08] pt-4 dark:border-white/[.145]">
            <ConditionsSummary strategy={active} />
          </div>
        </div>
      )}

      <div className="mt-4 rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
        <p className="mb-3 text-sm font-medium text-black dark:text-zinc-50">보유 종목 ({holdings.length})</p>

        {holdings.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">보유 중인 종목이 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-zinc-500 dark:text-zinc-400">
                  <th className="pb-2 pr-4 font-normal">종목명</th>
                  <th className="pb-2 pr-4 font-normal">수량</th>
                  <th className="pb-2 pr-4 font-normal">평단가</th>
                  <th className="pb-2 pr-4 font-normal">현재가</th>
                  <th className="pb-2 pr-4 font-normal">평가손익</th>
                  <th className="pb-2 font-normal">매수일</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => {
                  const currentPrice = h.currentPrice ?? h.avg_price;
                  const pnlPct = ((currentPrice - h.avg_price) / h.avg_price) * 100;
                  return (
                    <tr key={h.id} className="border-t border-black/[.08] dark:border-white/[.145]">
                      <td className="py-2 pr-4 text-black dark:text-zinc-50">
                        {h.stock_name}{" "}
                        <span className="text-xs text-zinc-400 dark:text-zinc-500">{h.stock_code}</span>
                      </td>
                      <td className="py-2 pr-4 text-black dark:text-zinc-50">{h.quantity.toLocaleString("ko-KR")}</td>
                      <td className="py-2 pr-4 text-black dark:text-zinc-50">
                        {h.avg_price.toLocaleString("ko-KR")}
                      </td>
                      <td className="py-2 pr-4 text-black dark:text-zinc-50">
                        {currentPrice.toLocaleString("ko-KR")}
                      </td>
                      <td className={`py-2 pr-4 font-medium ${returnColorClass(pnlPct)}`}>{signedPct(pnlPct)}</td>
                      <td className="py-2 text-zinc-500 dark:text-zinc-400">{formatDate(h.opened_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

type TradeFilter = "all" | PaperStyle;

function TradesScreen({ portfolios, trades }: { portfolios: PortfolioRow[]; trades: TradeRow[] }) {
  const [filter, setFilter] = useState<TradeFilter>("all");
  const styleByPortfolioId = useMemo(
    () => new Map(portfolios.map((p) => [p.id, p.style])),
    [portfolios]
  );

  const filtered =
    filter === "all" ? trades : trades.filter((t) => styleByPortfolioId.get(t.portfolio_id) === filter);

  return (
    <div>
      <div className="mb-3 flex gap-1">
        {(["all", ...STYLES] as TradeFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`h-8 rounded-full px-3 text-sm font-medium transition-colors ${
              filter === f
                ? "bg-foreground text-background"
                : "text-zinc-600 hover:bg-black/[.04] dark:text-zinc-400 dark:hover:bg-white/[.08]"
            }`}
          >
            {f === "all" ? "전체" : STYLE_LABEL[f]}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">매매 내역이 없습니다.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {filtered.map((t) => {
            const style = styleByPortfolioId.get(t.portfolio_id);
            return (
              <li
                key={t.id}
                className="rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">{formatDateTime(t.traded_at)}</span>
                    {style && (
                      <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                        [{STYLE_LABEL[style]}]
                      </span>
                    )}
                    <span className="font-medium text-black dark:text-zinc-50">
                      {t.side === "buy" ? "매수" : "매도"} {t.stock_name}({t.stock_code}) {t.quantity.toLocaleString("ko-KR")}주 @
                      {t.price.toLocaleString("ko-KR")}
                    </span>
                  </div>
                  {t.side === "sell" && t.realized_pnl !== null && (
                    <span className={`font-medium ${returnColorClass(t.realized_pnl)}`}>
                      {t.realized_pnl > 0 ? "+" : ""}
                      {Math.round(t.realized_pnl).toLocaleString("ko-KR")}원
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">└ 판단 근거: {t.rationale}</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function HistoryScreen({
  strategies,
  portfolios,
  snapshots,
}: {
  strategies: StrategyRow[];
  portfolios: PortfolioRow[];
  snapshots: SnapshotRow[];
}) {
  const [style, setStyle] = useState<PaperStyle>("aggressive");
  const portfolio = portfolios.find((p) => p.style === style);
  const versions = strategies.filter((s) => s.style === style);

  return (
    <div>
      <StyleToggle value={style} onChange={setStyle} />

      {versions.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">전략 이력이 없습니다.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {versions.map((v) => {
            const periodReturnPct = portfolio
              ? computePeriodReturnPct(snapshots, portfolio.id, v.created_at, v.retired_at)
              : null;

            return (
              <li
                key={v.id}
                className="rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-black dark:text-zinc-50">
                    v{v.version} {v.label}{" "}
                    <span className="text-xs font-normal text-zinc-400 dark:text-zinc-500">
                      {formatDate(v.created_at)} ~ {v.retired_at ? formatDate(v.retired_at) : "진행 중"}
                    </span>
                  </p>
                  {periodReturnPct !== null && (
                    <span className={`text-sm font-medium ${returnColorClass(periodReturnPct)}`}>
                      기간 수익률 {signedPct(periodReturnPct)}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-sm text-black dark:text-zinc-50">{v.rationale}</p>
                <div className="mt-3 border-t border-black/[.08] pt-3 dark:border-white/[.145]">
                  <ConditionsSummary strategy={v} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function PaperTrading() {
  const [subScreen, setSubScreen] = useState<SubScreen>("overview");

  const { data: portfolios, error: portfoliosError, isLoading: portfoliosLoading } = usePortfolios();
  const { data: snapshots } = useSnapshots();
  const { data: strategies } = useStrategies();
  const { data: positions } = usePositions();
  const { data: trades } = useTrades();

  return (
    <div className="w-full max-w-4xl">
      <div className="mb-6 flex flex-wrap gap-1">
        {SUB_SCREENS.map((s) => (
          <button
            key={s.value}
            onClick={() => setSubScreen(s.value)}
            className={`h-9 rounded-full px-4 text-sm font-medium transition-colors ${
              subScreen === s.value
                ? "bg-foreground text-background"
                : "text-zinc-600 hover:bg-black/[.04] dark:text-zinc-400 dark:hover:bg-white/[.08]"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {portfoliosLoading ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">불러오는 중...</p>
      ) : portfoliosError ? (
        <p className="text-sm text-blue-600 dark:text-blue-400">데이터를 불러오지 못했습니다.</p>
      ) : !portfolios || portfolios.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          가상 계좌가 아직 준비되지 않았습니다. 마이그레이션이 적용됐는지 확인해주세요.
        </p>
      ) : (
        <>
          {subScreen === "overview" && (
            <OverviewScreen portfolios={portfolios} snapshots={snapshots ?? []} positions={positions ?? []} />
          )}
          {subScreen === "detail" && (
            <DetailScreen portfolios={portfolios} strategies={strategies ?? []} positions={positions ?? []} />
          )}
          {subScreen === "trades" && <TradesScreen portfolios={portfolios} trades={trades ?? []} />}
          {subScreen === "history" && (
            <HistoryScreen strategies={strategies ?? []} portfolios={portfolios} snapshots={snapshots ?? []} />
          )}
        </>
      )}
    </div>
  );
}

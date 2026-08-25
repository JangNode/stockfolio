"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { supabase } from "@/lib/supabase";
import { ScoreValue } from "@/components/ScoreValue";
import { useMarket } from "@/components/MarketContext";
import { formatPrice, type Market } from "@/lib/market";

type PaperStyle = "aggressive" | "conservative" | "custom";
type SubScreen = "overview" | "detail" | "trades" | "history";

const STYLES: PaperStyle[] = ["aggressive", "conservative", "custom"];
const STYLE_LABEL: Record<PaperStyle, string> = {
  aggressive: "공격형",
  conservative: "안정형",
  custom: "커스텀",
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
  market: Market;
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
  score: number | null;
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

interface PaperRunRow {
  market: Market;
  started_at: string;
  finished_at: string;
  buy_count: number;
  sell_count: number;
  error_count: number;
}

const TRADE_HISTORY_LIMIT = 200;
const PAPER_RUN_HISTORY_LIMIT = 30;

function toKstDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

function todayKstDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/** 오늘(KST) 배치가 이 시장에서 실행됐는지(매매 발생 여부와 무관) — "조건 미충족으로
 * 매매 없음"과 "배치 자체가 안 돎"을 구분하는 데 쓴다. */
function hasRunToday(runs: PaperRunRow[]): boolean {
  const today = todayKstDate();
  return runs.some((r) => toKstDate(r.finished_at) === today);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** dateKey(YYYY-MM-DD)를 "8월 20일 (목)" 형태로 표시한다. 정오(KST)로 고정해 타임존
 * 경계에서 날짜가 하루 밀리는 걸 방지한다. */
function formatDateHeader(dateKey: string): string {
  const date = new Date(`${dateKey}T12:00:00+09:00`);
  return date.toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** traded_at 내림차순으로 이미 정렬된 목록을 KST 날짜별로 묶는다(Map은 삽입 순서를
 * 보존하므로 그룹 순서도 최신 날짜가 먼저 온다). */
function groupByDate(trades: TradeRow[]): [string, TradeRow[]][] {
  const map = new Map<string, TradeRow[]>();
  for (const t of trades) {
    const key = toKstDate(t.traded_at);
    const list = map.get(key);
    if (list) list.push(t);
    else map.set(key, [t]);
  }
  return Array.from(map.entries());
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
      .select("id, style, market, initial_capital, cash");
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
    const scoreById = new Map<string, number | null>();
    if (screeningIds.length > 0) {
      const { data: screeningRows, error: screeningError } = await supabase
        .from("screening_results")
        .select("id, current_price, score")
        .in("id", screeningIds);
      if (screeningError) throw screeningError;
      for (const row of screeningRows ?? []) {
        priceById.set(row.id, row.current_price);
        scoreById.set(row.id, row.score);
      }
    }

    return (positions ?? []).map((p) => ({
      ...p,
      currentPrice: p.screening_result_id ? (priceById.get(p.screening_result_id) ?? null) : null,
      score: p.screening_result_id ? (scoreById.get(p.screening_result_id) ?? null) : null,
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

function usePaperRuns() {
  return useSWR("paper-runs", async () => {
    const { data, error } = await supabase
      .from("paper_runs")
      .select("market, started_at, finished_at, buy_count, sell_count, error_count")
      .order("finished_at", { ascending: false })
      .limit(PAPER_RUN_HISTORY_LIMIT);
    if (error) throw error;
    return data as PaperRunRow[];
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

/** 오늘 이 포트폴리오의 매매 상태를 배치 미실행/조건 미충족/체결 3단계로 구분해 보여준다. */
function TodayBadge({ todayTradeCount, ranToday }: { todayTradeCount: number; ranToday: boolean }) {
  if (todayTradeCount > 0) {
    return (
      <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
        오늘 {todayTradeCount}건 체결
      </span>
    );
  }
  if (ranToday) {
    return (
      <span className="inline-flex items-center rounded-full bg-black/[.04] px-2 py-0.5 text-xs font-medium text-zinc-600 dark:bg-white/[.08] dark:text-zinc-400">
        오늘 조건 미충족으로 매매 없음
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
      ⚠ 오늘 배치 미실행
    </span>
  );
}

function OverviewScreen({
  portfolios,
  snapshots,
  positions,
  trades,
  ranToday,
  market,
}: {
  portfolios: PortfolioRow[];
  snapshots: SnapshotRow[];
  positions: PositionRow[];
  trades: TradeRow[];
  ranToday: boolean;
  market: Market;
}) {
  const today = todayKstDate();

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {STYLES.map((style) => {
        const portfolio = portfolios.find((p) => p.style === style);
        const styleSnapshots = snapshots.filter((s) => s.portfolio_id === portfolio?.id);
        const latest = styleSnapshots[styleSnapshots.length - 1];
        const holdingCount = positions.filter((p) => p.portfolio_id === portfolio?.id).length;
        const todayTradeCount = portfolio
          ? trades.filter((t) => t.portfolio_id === portfolio.id && toKstDate(t.traded_at) === today).length
          : 0;

        return (
          <div
            key={style}
            className="rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-black dark:text-zinc-50">{STYLE_LABEL[style]}</p>
              <TodayBadge todayTradeCount={todayTradeCount} ranToday={ranToday} />
            </div>

            {!portfolio || !latest ? (
              <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
                아직 실행된 배치가 없습니다.
              </p>
            ) : (
              <>
                <p className="mt-2 text-2xl font-semibold text-black dark:text-zinc-50">
                  {formatPrice(latest.equity, market)}
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
                  현금 {formatPrice(latest.cash, market)} · 보유 {holdingCount}종목
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
  market,
}: {
  portfolios: PortfolioRow[];
  strategies: StrategyRow[];
  positions: PositionRow[];
  market: Market;
}) {
  const [style, setStyle] = useState<PaperStyle>("aggressive");
  const [showConditions, setShowConditions] = useState(false);
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

          <button
            onClick={() => setShowConditions((v) => !v)}
            className="mt-3 text-xs font-medium text-zinc-500 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
          >
            {showConditions ? "접기 ▲" : "조건 상세보기 ▼"}
          </button>

          {showConditions && (
            <div className="mt-4 border-t border-black/[.08] pt-4 dark:border-white/[.145]">
              <ConditionsSummary strategy={active} />
            </div>
          )}
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
                  <th className="pb-2 pr-4 font-normal">점수</th>
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
                      <td className="py-2 pr-4">
                        <ScoreValue score={h.score} />
                      </td>
                      <td className="py-2 pr-4 text-black dark:text-zinc-50">{h.quantity.toLocaleString("ko-KR")}</td>
                      <td className="py-2 pr-4 text-black dark:text-zinc-50">
                        {formatPrice(h.avg_price, market)}
                      </td>
                      <td className="py-2 pr-4 text-black dark:text-zinc-50">
                        {formatPrice(currentPrice, market)}
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

/** 날짜 그룹 사이 구분선+헤더. 오늘 그룹은 강조 표시한다. */
function DateGroupHeader({ label, highlight = false }: { label: string; highlight?: boolean }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span
        className={`text-xs font-semibold ${
          highlight ? "text-black dark:text-zinc-50" : "text-zinc-500 dark:text-zinc-400"
        }`}
      >
        {label}
      </span>
      <span className="h-px flex-1 bg-black/[.08] dark:bg-white/[.145]" />
    </div>
  );
}

/** 시각을 좌측에 고정폭으로 크게 보여줘 "언제" 체결됐는지 한눈에 들어오게 한다. 날짜는
 * 상위 DateGroupHeader가 담당하므로 항목 자체엔 반복하지 않는다. */
function TradeItem({
  trade,
  style,
  market,
}: {
  trade: TradeRow;
  style: PaperStyle | undefined;
  market: Market;
}) {
  return (
    <li className="rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
      <div className="flex items-start gap-3">
        <span className="w-12 shrink-0 pt-0.5 text-sm font-semibold tabular-nums text-black dark:text-zinc-50">
          {formatTime(trade.traded_at)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div className="flex items-center gap-2">
              {style && (
                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  [{STYLE_LABEL[style]}]
                </span>
              )}
              <span className="font-medium text-black dark:text-zinc-50">
                <span className={trade.side === "buy" ? "text-red-600 dark:text-red-400" : "text-blue-600 dark:text-blue-400"}>
                  {trade.side === "buy" ? "매수" : "매도"}
                </span>{" "}
                {trade.stock_name}({trade.stock_code}) {trade.quantity.toLocaleString("ko-KR")}주 @
                {formatPrice(trade.price, market)}
              </span>
            </div>
            {trade.side === "sell" && trade.realized_pnl !== null && (
              <span className={`font-medium ${returnColorClass(trade.realized_pnl)}`}>
                {trade.realized_pnl > 0 ? "+" : ""}
                {formatPrice(trade.realized_pnl, market)}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">└ 판단 근거: {trade.rationale}</p>
        </div>
      </div>
    </li>
  );
}

function TradesScreen({
  portfolios,
  trades,
  market,
  ranToday,
}: {
  portfolios: PortfolioRow[];
  trades: TradeRow[];
  market: Market;
  ranToday: boolean;
}) {
  const [filter, setFilter] = useState<TradeFilter>("all");
  const styleByPortfolioId = useMemo(
    () => new Map(portfolios.map((p) => [p.id, p.style])),
    [portfolios]
  );

  const filtered =
    filter === "all" ? trades : trades.filter((t) => styleByPortfolioId.get(t.portfolio_id) === filter);

  const today = todayKstDate();
  const todayTrades = filtered.filter((t) => toKstDate(t.traded_at) === today);
  const historicalGroups = groupByDate(filtered.filter((t) => toKstDate(t.traded_at) !== today));

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

      <div>
        <DateGroupHeader label={`오늘 · ${formatDateHeader(today)}`} highlight />
        {todayTrades.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {todayTrades.map((t) => (
              <TradeItem key={t.id} trade={t} style={styleByPortfolioId.get(t.portfolio_id)} market={market} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {ranToday ? "조건 미충족으로 매매 없음" : "⚠ 오늘 배치가 아직 실행되지 않았습니다"}
          </p>
        )}
      </div>

      {historicalGroups.length > 0 && (
        <div className="mt-6 flex flex-col gap-6">
          {historicalGroups.map(([dateKey, dayTrades]) => (
            <div key={dateKey}>
              <DateGroupHeader label={formatDateHeader(dateKey)} />
              <ul className="flex flex-col gap-3">
                {dayTrades.map((t) => (
                  <TradeItem
                    key={t.id}
                    trade={t}
                    style={styleByPortfolioId.get(t.portfolio_id)}
                    market={market}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
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
  const { market } = useMarket();

  const { data: allPortfolios, error: portfoliosError, isLoading: portfoliosLoading } = usePortfolios();
  const { data: snapshots } = useSnapshots();
  const { data: strategies } = useStrategies();
  const { data: positions } = usePositions();
  const { data: trades } = useTrades();
  const { data: paperRuns } = usePaperRuns();

  const portfolios = useMemo(
    () => (allPortfolios ?? []).filter((p) => p.market === market),
    [allPortfolios, market]
  );
  const portfolioIds = useMemo(() => new Set(portfolios.map((p) => p.id)), [portfolios]);
  const scopedPositions = useMemo(
    () => (positions ?? []).filter((p) => portfolioIds.has(p.portfolio_id)),
    [positions, portfolioIds]
  );
  const scopedTrades = useMemo(
    () => (trades ?? []).filter((t) => portfolioIds.has(t.portfolio_id)),
    [trades, portfolioIds]
  );
  const ranToday = useMemo(
    () => hasRunToday((paperRuns ?? []).filter((r) => r.market === market)),
    [paperRuns, market]
  );

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
      ) : portfolios.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          가상 계좌가 아직 준비되지 않았습니다. 마이그레이션이 적용됐는지 확인해주세요.
        </p>
      ) : (
        <>
          {subScreen === "overview" && (
            <OverviewScreen
              portfolios={portfolios}
              snapshots={snapshots ?? []}
              positions={scopedPositions}
              trades={scopedTrades}
              ranToday={ranToday}
              market={market}
            />
          )}
          {subScreen === "detail" && (
            <DetailScreen portfolios={portfolios} strategies={strategies ?? []} positions={scopedPositions} market={market} />
          )}
          {subScreen === "trades" && (
            <TradesScreen portfolios={portfolios} trades={scopedTrades} market={market} ranToday={ranToday} />
          )}
          {subScreen === "history" && (
            <HistoryScreen strategies={strategies ?? []} portfolios={portfolios} snapshots={snapshots ?? []} />
          )}
        </>
      )}
    </div>
  );
}

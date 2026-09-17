"use client";

import { useRouter } from "next/navigation";
import useSWR from "swr";
import { authJsonFetcher } from "@/lib/authFetch";
import { formatNumber, formatPrice, type Market } from "@/lib/market";
import { ibmPlexSansKr } from "@/lib/fonts";
import { formatAsOfLabel } from "@/lib/formatKst";

interface StockPrice {
  stockCode: string;
  currentPrice: number;
  change: number;
  changeRate: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
  /** 이 시세가 실제로 반영하는 거래일(YYYY-MM-DD). 해외 종목만 채워진다(국내는
   * KIS inquire-price 응답에 이 필드가 없음 — lib/kis.ts의 IndexQuote 주석과
   * 같은 이유). components/MarketSummary.tsx의 해외지수 배지와 동일한 패턴. */
  asOfDate?: string;
}

const STOCK_NAMES: Record<string, string> = {
  "005930": "삼성전자",
};

const fetcher = (url: string) => authJsonFetcher<StockPrice>(url);

interface StockCardProps {
  code: string;
  name?: string;
  market: Market;
  onRemove?: () => void;
}

export default function StockCard({ code, name: nameProp, market, onRemove }: StockCardProps) {
  const router = useRouter();
  const {
    data: price,
    error,
    isLoading,
  } = useSWR(`/api/stock/${code}?market=${market}`, fetcher);

  const name = nameProp ?? STOCK_NAMES[code] ?? code;

  const cardClassName =
    "w-full max-w-sm cursor-pointer rounded-card border border-border bg-surface p-6 transition-colors hover:border-black/20 dark:hover:border-white/30";

  const goToChart = () => {
    router.push(`/stock/${code}?name=${encodeURIComponent(name)}&market=${market}`);
  };

  const cardInteractionProps = {
    role: "button" as const,
    tabIndex: 0,
    onClick: goToChart,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        goToChart();
      }
    },
  };

  const removeButton = onRemove && (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onRemove();
      }}
      aria-label={`${name} 관심종목에서 삭제`}
      className="text-ink-faint transition-colors hover:text-fall"
    >
      ✕
    </button>
  );

  if (isLoading) {
    return (
      <div {...cardInteractionProps} className={`${cardClassName} animate-pulse`}>
        <div className="h-4 w-20 rounded bg-black/[.06] dark:bg-white/[.08]" />
        <div className="mt-4 h-9 w-36 rounded bg-black/[.06] dark:bg-white/[.08]" />
        <div className="mt-2 h-4 w-28 rounded bg-black/[.06] dark:bg-white/[.08]" />
      </div>
    );
  }

  if (error || !price) {
    return (
      <div {...cardInteractionProps} className={cardClassName}>
        <div className="flex items-baseline justify-between">
          <p
            className={`${ibmPlexSansKr.className} text-sm text-zinc-600 dark:text-zinc-400`}
            onClick={(e) => e.stopPropagation()}
          >
            {name}
          </p>
          {removeButton}
        </div>
        <p className="mt-2 text-sm text-blue-600 dark:text-blue-400">
          {error instanceof Error ? error.message : "시세 조회에 실패했습니다."}
        </p>
      </div>
    );
  }

  const isUp = price.change > 0;
  const isDown = price.change < 0;
  const colorClass = isUp ? "text-rise" : isDown ? "text-fall" : "text-zinc-600 dark:text-zinc-400";
  const sign = isUp ? "+" : "";

  return (
    <div {...cardInteractionProps} className={cardClassName}>
      <div className="flex items-baseline justify-between">
        <p
          className={`${ibmPlexSansKr.className} text-sm font-medium text-zinc-600 dark:text-zinc-400`}
          onClick={(e) => e.stopPropagation()}
        >
          {name}
        </p>
        <div className="flex items-center gap-2">
          <p className="text-xs text-zinc-400 dark:text-zinc-500">{code}</p>
          {removeButton}
        </div>
      </div>

      <p className={`mt-2 tabular-nums text-3xl font-semibold ${colorClass}`}>
        {formatPrice(price.currentPrice, market)}
        {market === "KR" ? "원" : ""}
      </p>

      <p className={`mt-1 tabular-nums text-sm font-medium ${colorClass}`}>
        {sign}
        {formatPrice(price.change, market)}
        {market === "KR" ? "원" : ""} ({sign}
        {price.changeRate.toFixed(2)}%)
        {price.asOfDate && (
          <span className="ml-2 text-xs font-normal text-ink-faint">
            {formatAsOfLabel(price.asOfDate)}
          </span>
        )}
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-4 text-sm">
        <div>
          <dt className="text-ink-muted">시가</dt>
          <dd className="tabular-nums text-ink">{formatPrice(price.openPrice, market)}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">거래량</dt>
          <dd className="tabular-nums text-ink">{formatNumber(price.volume, market)}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">고가</dt>
          <dd className="tabular-nums text-rise">{formatPrice(price.highPrice, market)}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">저가</dt>
          <dd className="tabular-nums text-fall">{formatPrice(price.lowPrice, market)}</dd>
        </div>
      </dl>
    </div>
  );
}

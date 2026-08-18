"use client";

import useSWR from "swr";
import { authJsonFetcher } from "@/lib/authFetch";

interface IndexQuote {
  category: "국내" | "해외";
  name: string;
  price: number;
  change: number;
  changeRate: number;
}

interface MarketSummaryData {
  domestic: IndexQuote[];
  overseas: IndexQuote[];
}

const fetcher = (url: string) => authJsonFetcher<MarketSummaryData>(url);

function IndexChip({ quote }: { quote: IndexQuote }) {
  const isUp = quote.change > 0;
  const isDown = quote.change < 0;
  const colorClass = isUp
    ? "text-red-600 dark:text-red-400"
    : isDown
      ? "text-blue-600 dark:text-blue-400"
      : "text-zinc-600 dark:text-zinc-400";
  const sign = isUp ? "+" : "";

  return (
    <div className="flex shrink-0 items-baseline gap-2 whitespace-nowrap">
      <span className="rounded-full bg-black/[.06] px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-white/[.08] dark:text-zinc-400">
        {quote.category}
      </span>
      <span className="text-xs text-zinc-500 dark:text-zinc-400">
        {quote.name}
      </span>
      <span className="text-sm font-semibold text-black dark:text-zinc-50">
        {quote.price.toLocaleString("ko-KR", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
      </span>
      <span className={`text-xs font-medium ${colorClass}`}>
        {sign}
        {quote.changeRate.toFixed(2)}%
      </span>
    </div>
  );
}

export default function MarketSummary() {
  const { data, error, isLoading } = useSWR("/api/market-summary", fetcher);

  if (isLoading) {
    return (
      <div className="w-full max-w-5xl animate-pulse rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
        <div className="h-6 w-full rounded bg-black/[.06] dark:bg-white/[.08]" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="w-full max-w-5xl rounded-xl border border-black/[.08] bg-white p-4 text-sm text-blue-600 dark:border-white/[.145] dark:bg-zinc-950 dark:text-blue-400">
        {error instanceof Error
          ? error.message
          : "시장 지표를 불러오지 못했습니다."}
      </div>
    );
  }

  const quotes = [...data.domestic, ...data.overseas];

  return (
    <div className="w-full max-w-5xl overflow-hidden rounded-xl border border-black/[.08] bg-white py-3 dark:border-white/[.145] dark:bg-zinc-950">
      {/* 같은 목록을 두 벌 이어붙여 트랙을 만들고 -50% 만큼 흘린다. 두 벌의
          너비가 정확히 같으므로 절반을 지나가는 순간 뒤 벌이 앞 벌이 있던
          자리를 그대로 이어받아 끊김 없이 순환하는 것처럼 보인다. */}
      <div className="flex w-max animate-marquee gap-8">
        {[...quotes, ...quotes].map((quote, i) => (
          <IndexChip key={i} quote={quote} />
        ))}
      </div>
    </div>
  );
}

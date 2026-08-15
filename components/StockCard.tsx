"use client";

import useSWR from "swr";

interface StockPrice {
  stockCode: string;
  currentPrice: number;
  change: number;
  changeRate: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  volume: number;
}

const STOCK_NAMES: Record<string, string> = {
  "005930": "삼성전자",
};

const fetcher = async (url: string): Promise<StockPrice> => {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ?? "시세 조회에 실패했습니다.");
  }
  return data;
};

interface StockCardProps {
  code: string;
  name?: string;
  onRemove?: () => void;
}

export default function StockCard({ code, name: nameProp, onRemove }: StockCardProps) {
  const {
    data: price,
    error,
    isLoading,
  } = useSWR(`/api/stock/${code}`, fetcher);

  const name = nameProp ?? STOCK_NAMES[code] ?? code;

  const removeButton = onRemove && (
    <button
      onClick={onRemove}
      aria-label={`${name} 관심종목에서 삭제`}
      className="text-zinc-400 transition-colors hover:text-blue-600 dark:text-zinc-500 dark:hover:text-blue-400"
    >
      ✕
    </button>
  );

  if (isLoading) {
    return (
      <div className="w-full max-w-sm animate-pulse rounded-xl border border-black/[.08] bg-white p-6 dark:border-white/[.145] dark:bg-zinc-950">
        <div className="h-4 w-20 rounded bg-black/[.06] dark:bg-white/[.08]" />
        <div className="mt-4 h-9 w-36 rounded bg-black/[.06] dark:bg-white/[.08]" />
        <div className="mt-2 h-4 w-28 rounded bg-black/[.06] dark:bg-white/[.08]" />
      </div>
    );
  }

  if (error || !price) {
    return (
      <div className="w-full max-w-sm rounded-xl border border-black/[.08] bg-white p-6 dark:border-white/[.145] dark:bg-zinc-950">
        <div className="flex items-baseline justify-between">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{name}</p>
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
  const colorClass = isUp
    ? "text-red-600 dark:text-red-400"
    : isDown
      ? "text-blue-600 dark:text-blue-400"
      : "text-zinc-600 dark:text-zinc-400";
  const sign = isUp ? "+" : "";

  return (
    <div className="w-full max-w-sm rounded-xl border border-black/[.08] bg-white p-6 dark:border-white/[.145] dark:bg-zinc-950">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
          {name}
        </p>
        <div className="flex items-center gap-2">
          <p className="text-xs text-zinc-400 dark:text-zinc-500">{code}</p>
          {removeButton}
        </div>
      </div>

      <p className={`mt-2 text-3xl font-semibold ${colorClass}`}>
        {price.currentPrice.toLocaleString("ko-KR")}원
      </p>

      <p className={`mt-1 text-sm font-medium ${colorClass}`}>
        {sign}
        {price.change.toLocaleString("ko-KR")}원 ({sign}
        {price.changeRate.toFixed(2)}%)
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-black/[.08] pt-4 text-sm dark:border-white/[.145]">
        <div>
          <dt className="text-zinc-500 dark:text-zinc-400">시가</dt>
          <dd className="text-black dark:text-zinc-50">
            {price.openPrice.toLocaleString("ko-KR")}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500 dark:text-zinc-400">거래량</dt>
          <dd className="text-black dark:text-zinc-50">
            {price.volume.toLocaleString("ko-KR")}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500 dark:text-zinc-400">고가</dt>
          <dd className="text-red-600 dark:text-red-400">
            {price.highPrice.toLocaleString("ko-KR")}
          </dd>
        </div>
        <div>
          <dt className="text-zinc-500 dark:text-zinc-400">저가</dt>
          <dd className="text-blue-600 dark:text-blue-400">
            {price.lowPrice.toLocaleString("ko-KR")}
          </dd>
        </div>
      </dl>
    </div>
  );
}

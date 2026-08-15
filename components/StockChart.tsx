"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type LineData,
  type Time,
} from "lightweight-charts";

interface DailyPrice {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

type Period = "D" | "W" | "M";

const PERIOD_LABELS: Record<Period, string> = {
  D: "일봉",
  W: "주봉",
  M: "월봉",
};

const MA_SHORT = 5;
const MA_LONG = 20;

// 앱 전체에서 이미 쓰고 있는 카드 배경/텍스트/테두리 색과 상승(빨강)/하락(파랑) 관례를 그대로 맞춘다.
const THEME = {
  light: {
    surface: "#ffffff",
    text: "#000000",
    muted: "#71717a",
    grid: "rgba(0,0,0,0.08)",
    up: "#dc2626",
    down: "#2563eb",
    ma5: "#eb6834",
    ma20: "#4a3aa7",
  },
  dark: {
    surface: "#09090b",
    text: "#fafafa",
    muted: "#a1a1aa",
    grid: "rgba(255,255,255,0.145)",
    up: "#f87171",
    down: "#60a5fa",
    ma5: "#d95926",
    ma20: "#9085e9",
  },
} as const;

function getTheme() {
  const isDark =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return isDark ? THEME.dark : THEME.light;
}

function timeToDateString(time: Time): string {
  if (typeof time === "string") return time;
  if (typeof time === "object" && "year" in time) {
    const { year, month, day } = time;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return String(time);
}

function computeMovingAverage(
  prices: DailyPrice[],
  length: number
): LineData[] {
  const result: LineData[] = [];
  for (let i = length - 1; i < prices.length; i++) {
    let sum = 0;
    for (let j = i - length + 1; j <= i; j++) sum += prices[j].close;
    result.push({ time: prices[i].date, value: sum / length });
  }
  return result;
}

const fetcher = async (url: string): Promise<DailyPrice[]> => {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ?? "차트 데이터를 불러오지 못했습니다.");
  }
  return data;
};

interface Tooltip {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma5?: number;
  ma20?: number;
}

export default function StockChart({ code }: { code: string }) {
  const [period, setPeriod] = useState<Period>("D");
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const ma5SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const ma20SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const volumeByDateRef = useRef<Map<string, number>>(new Map());
  const lastFitPeriodRef = useRef<Period | null>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  const {
    data: prices,
    error,
    isLoading,
  } = useSWR(`/api/stock/${code}/history?period=${period}`, fetcher);

  // 차트는 한 번만 만들고, 이후에는 데이터/테마 변경 시 옵션과 데이터만 갱신한다.
  useEffect(() => {
    if (!containerRef.current) return;

    const theme = getTheme();

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: theme.surface },
        textColor: theme.muted,
      },
      grid: {
        vertLines: { color: theme.grid },
        horzLines: { color: theme.grid },
      },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { borderColor: theme.grid },
      rightPriceScale: { borderColor: theme.grid },
      autoSize: true,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: theme.up,
      downColor: theme.down,
      borderUpColor: theme.up,
      borderDownColor: theme.down,
      wickUpColor: theme.up,
      wickDownColor: theme.down,
    });

    const ma5Series = chart.addSeries(LineSeries, {
      color: theme.ma5,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const ma20Series = chart.addSeries(LineSeries, {
      color: theme.ma20,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setTooltip(null);
        return;
      }

      const candle = param.seriesData.get(candleSeries) as
        | CandlestickData
        | undefined;
      if (!candle) {
        setTooltip(null);
        return;
      }

      const ma5 = param.seriesData.get(ma5Series) as LineData | undefined;
      const ma20 = param.seriesData.get(ma20Series) as LineData | undefined;
      const dateKey = timeToDateString(param.time);

      setTooltip({
        date: dateKey,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: volumeByDateRef.current.get(dateKey) ?? 0,
        ma5: ma5?.value,
        ma20: ma20?.value,
      });
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    ma5SeriesRef.current = ma5Series;
    ma20SeriesRef.current = ma20Series;

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      ma5SeriesRef.current = null;
      ma20SeriesRef.current = null;
    };
  }, []);

  // 테마(라이트/다크) 변경을 실시간으로 반영한다.
  useEffect(() => {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const theme = getTheme();
      chartRef.current?.applyOptions({
        layout: {
          background: { type: ColorType.Solid, color: theme.surface },
          textColor: theme.muted,
        },
        grid: {
          vertLines: { color: theme.grid },
          horzLines: { color: theme.grid },
        },
        timeScale: { borderColor: theme.grid },
        rightPriceScale: { borderColor: theme.grid },
      });
      candleSeriesRef.current?.applyOptions({
        upColor: theme.up,
        downColor: theme.down,
        borderUpColor: theme.up,
        borderDownColor: theme.down,
        wickUpColor: theme.up,
        wickDownColor: theme.down,
      });
      ma5SeriesRef.current?.applyOptions({ color: theme.ma5 });
      ma20SeriesRef.current?.applyOptions({ color: theme.ma20 });
    };

    mql.addEventListener("change", applyTheme);
    return () => mql.removeEventListener("change", applyTheme);
  }, []);

  // 새 데이터가 오면 캔들/이평선 시리즈를 갱신한다.
  useEffect(() => {
    if (!prices || !candleSeriesRef.current) return;

    candleSeriesRef.current.setData(
      prices.map((p) => ({
        time: p.date,
        open: p.open,
        high: p.high,
        low: p.low,
        close: p.close,
      }))
    );
    ma5SeriesRef.current?.setData(computeMovingAverage(prices, MA_SHORT));
    ma20SeriesRef.current?.setData(computeMovingAverage(prices, MA_LONG));

    volumeByDateRef.current = new Map(prices.map((p) => [p.date, p.volume]));

    // 같은 봉 종류로 백그라운드 재검증이 일어난 것뿐이면 사용자가 확대/이동한
    // 뷰나 호버 중인 툴팁을 건드리지 않는다. 봉 종류가 바뀌었을 때만 새로 맞춘다.
    if (lastFitPeriodRef.current !== period) {
      chartRef.current?.timeScale().fitContent();
      lastFitPeriodRef.current = period;
    }
  }, [prices, period]);

  return (
    <div className="w-full rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1">
          {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`h-8 rounded-full px-3 text-sm font-medium transition-colors ${
                period === p
                  ? "bg-foreground text-background"
                  : "text-zinc-600 hover:bg-black/[.04] dark:text-zinc-400 dark:hover:bg-white/[.08]"
              }`}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="flex items-center gap-1">
            <span className="h-0.5 w-3 bg-[#eb6834] dark:bg-[#d95926]" />
            {MA_SHORT}
          </span>
          <span className="flex items-center gap-1">
            <span className="h-0.5 w-3 bg-[#4a3aa7] dark:bg-[#9085e9]" />
            {MA_LONG}
          </span>
        </div>
      </div>

      <div className="relative">
        <div ref={containerRef} className="h-80 w-full" />

        {isLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/80 text-sm text-zinc-500 dark:bg-zinc-950/80 dark:text-zinc-400">
            차트를 불러오는 중...
          </div>
        )}

        {error && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/80 text-sm text-blue-600 dark:bg-zinc-950/80 dark:text-blue-400">
            {error instanceof Error ? error.message : "차트 데이터를 불러오지 못했습니다."}
          </div>
        )}

        {tooltip && (
          <div className="pointer-events-none absolute top-2 left-2 z-10 rounded-lg border border-black/[.08] bg-white/95 px-3 py-2 text-xs shadow-sm dark:border-white/[.145] dark:bg-zinc-900/95">
            <p className="mb-1 font-medium text-black dark:text-zinc-50">
              {tooltip.date}
            </p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-zinc-600 dark:text-zinc-400">
              <span>
                시가 <span className="text-black dark:text-zinc-50">{tooltip.open.toLocaleString("ko-KR")}</span>
              </span>
              <span>
                고가 <span className="text-black dark:text-zinc-50">{tooltip.high.toLocaleString("ko-KR")}</span>
              </span>
              <span>
                저가 <span className="text-black dark:text-zinc-50">{tooltip.low.toLocaleString("ko-KR")}</span>
              </span>
              <span>
                종가 <span className="text-black dark:text-zinc-50">{tooltip.close.toLocaleString("ko-KR")}</span>
              </span>
              <span className="col-span-2">
                거래량 <span className="text-black dark:text-zinc-50">{tooltip.volume.toLocaleString("ko-KR")}</span>
              </span>
              {tooltip.ma5 !== undefined && (
                <span className="col-span-2" style={{ color: "#eb6834" }}>
                  MA{MA_SHORT} {tooltip.ma5.toLocaleString("ko-KR", { maximumFractionDigits: 0 })}
                </span>
              )}
              {tooltip.ma20 !== undefined && (
                <span className="col-span-2" style={{ color: "#4a3aa7" }}>
                  MA{MA_LONG} {tooltip.ma20.toLocaleString("ko-KR", { maximumFractionDigits: 0 })}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

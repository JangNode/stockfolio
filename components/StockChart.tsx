"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { computeSMA } from "@/lib/sma";
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
  type UTCTimestamp,
} from "lightweight-charts";

interface RawBar {
  date?: string;
  time?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Bar {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

type Period = "min" | "D" | "W" | "M" | "Y";

const PERIOD_LABELS: Record<Period, string> = {
  min: "10분봉",
  D: "일봉",
  W: "주봉",
  M: "월봉",
  Y: "년봉",
};

// 상장 후 전체를 한 번에 보여주면 처음엔 너무 눌려 보이므로, 봉 종류별로
// 보기 편한 최근 구간만 먼저 보여준다. (스크롤/확대로 전체 기록은 그대로 볼 수 있음)
const INITIAL_VISIBLE_BARS: Partial<Record<Period, number>> = {
  D: 42, // 약 2개월(거래일 기준)
  W: 52, // 약 1년
  M: 36, // 약 3년
};

const MA_PERIODS = [5, 20, 60, 112, 224, 448] as const;

// 앱 전체에서 이미 쓰고 있는 카드 배경/텍스트/테두리 색과 상승(빨강)/하락(파랑) 관례를 그대로 맞춘다.
// 이평선 6개는 dataviz 팔레트의 categorical 슬롯 2~7(orange/aqua/yellow/magenta/green/violet)을
// 순서대로 사용한다 — slot 1(blue)/8(red)은 캔들 상승/하락 색과 겹치지 않도록 비워둔다.
const THEME = {
  light: {
    surface: "#ffffff",
    text: "#000000",
    muted: "#71717a",
    grid: "rgba(0,0,0,0.08)",
    up: "#dc2626",
    down: "#2563eb",
    ma: {
      5: "#eb6834",
      20: "#1baf7a",
      60: "#eda100",
      112: "#e87ba4",
      224: "#008300",
      448: "#4a3aa7",
    },
  },
  dark: {
    surface: "#09090b",
    text: "#fafafa",
    muted: "#a1a1aa",
    grid: "rgba(255,255,255,0.145)",
    up: "#f87171",
    down: "#60a5fa",
    ma: {
      5: "#d95926",
      20: "#199e70",
      60: "#c98500",
      112: "#d55181",
      224: "#008300",
      448: "#9085e9",
    },
  },
} as const;

function getTheme() {
  const isDark =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  return isDark ? THEME.dark : THEME.light;
}

// 데이터 조회/조인용 내부 키. 일/주/월/년봉은 "YYYY-MM-DD" 그대로, 분봉은 유닉스 초를 문자열화한다.
function timeToKey(time: Time): string {
  if (typeof time === "string") return time;
  if (typeof time === "object" && "year" in time) {
    const { year, month, day } = time;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return String(time);
}

// 툴팁에 보여줄 한국식 날짜/시각 표기 ("2026.08.14" / "15:30").
function formatDisplayTime(time: Time, intraday: boolean): string {
  if (intraday && typeof time === "number") {
    // 서버에서 KST 벽시계 시각을 그대로 UTC 초로 인코딩했으므로 UTC 메서드로 되돌린다.
    const d = new Date(time * 1000);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  return timeToKey(time).replaceAll("-", ".");
}

function computeMovingAverage(bars: Bar[], length: number): LineData[] {
  const sma = computeSMA(
    bars.map((b) => b.close),
    length
  );
  const result: LineData[] = [];
  for (let i = 0; i < bars.length; i++) {
    const value = sma[i];
    if (value !== undefined) result.push({ time: bars[i].time, value });
  }
  return result;
}

const fetcher = async (url: string): Promise<RawBar[]> => {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ?? "차트 데이터를 불러오지 못했습니다.");
  }
  return data;
};

interface Tooltip {
  label: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma: Partial<Record<(typeof MA_PERIODS)[number], number>>;
}

export default function StockChart({ code }: { code: string }) {
  const [period, setPeriod] = useState<Period>("D");
  const periodRef = useRef(period);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const maSeriesRefs = useRef<
    Partial<Record<(typeof MA_PERIODS)[number], ISeriesApi<"Line">>>
  >({});
  const volumeByKeyRef = useRef<Map<string, number>>(new Map());
  const lastFitKeyRef = useRef<string | null>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  useEffect(() => {
    periodRef.current = period;
  }, [period]);

  const isIntraday = period === "min";
  const fetchKey = `/api/stock/${code}/history?period=${period}`;

  const { data: rawBars, error, isLoading } = useSWR(fetchKey, fetcher);

  // 차트는 한 번만 만들고, 이후에는 데이터/테마/기간 변경 시 옵션과 데이터만 갱신한다.
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
      localization: { locale: "ko-KR" },
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

    const maSeries: Partial<
      Record<(typeof MA_PERIODS)[number], ISeriesApi<"Line">>
    > = {};
    for (const ma of MA_PERIODS) {
      maSeries[ma] = chart.addSeries(LineSeries, {
        color: theme.ma[ma],
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
    }

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

      const ma: Tooltip["ma"] = {};
      for (const maPeriod of MA_PERIODS) {
        const series = maSeries[maPeriod];
        const point = series && (param.seriesData.get(series) as LineData | undefined);
        if (point) ma[maPeriod] = point.value;
      }

      const key = timeToKey(param.time);

      setTooltip({
        label: formatDisplayTime(param.time, periodRef.current === "min"),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: volumeByKeyRef.current.get(key) ?? 0,
        ma,
      });
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    maSeriesRefs.current = maSeries;

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      maSeriesRefs.current = {};
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
      for (const ma of MA_PERIODS) {
        maSeriesRefs.current[ma]?.applyOptions({ color: theme.ma[ma] });
      }
    };

    mql.addEventListener("change", applyTheme);
    return () => mql.removeEventListener("change", applyTheme);
  }, []);

  // 봉 종류가 바뀌면 시간축 표시 형식(날짜 vs 시:분)을 맞춘다.
  useEffect(() => {
    chartRef.current?.applyOptions({
      timeScale: { timeVisible: isIntraday, secondsVisible: false },
    });
  }, [isIntraday]);

  // 새 데이터가 오면 캔들/이평선 시리즈를 갱신한다.
  useEffect(() => {
    if (!rawBars || !candleSeriesRef.current) return;

    const bars: Bar[] = rawBars.map((b) => ({
      time: (isIntraday ? (b.time as number as UTCTimestamp) : (b.date as string)) as Time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    }));

    candleSeriesRef.current.setData(
      bars.map(({ time, open, high, low, close }) => ({
        time,
        open,
        high,
        low,
        close,
      }))
    );

    for (const ma of MA_PERIODS) {
      const series = maSeriesRefs.current[ma];
      if (!series) continue;
      series.applyOptions({ visible: true });
      series.setData(computeMovingAverage(bars, ma));
    }

    volumeByKeyRef.current = new Map(bars.map((b) => [timeToKey(b.time), b.volume]));

    // 같은 봉 종류로 백그라운드 재검증이 일어난 것뿐이면 사용자가 확대/이동한
    // 뷰나 호버 중인 툴팁을 건드리지 않는다. 봉 종류가 바뀌었을 때만 새로 맞춘다.
    if (lastFitKeyRef.current !== period) {
      const visibleBars = INITIAL_VISIBLE_BARS[period];
      if (visibleBars && bars.length > visibleBars) {
        chartRef.current?.timeScale().setVisibleRange({
          from: bars[bars.length - visibleBars].time,
          to: bars[bars.length - 1].time,
        });
      } else {
        chartRef.current?.timeScale().fitContent();
      }
      lastFitKeyRef.current = period;
    }
  }, [rawBars, period, isIntraday]);

  return (
    <div className="w-full rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1">
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

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
          {MA_PERIODS.map((ma) => (
            <span key={ma} className="flex items-center gap-1">
              <span
                className="h-0.5 w-3"
                style={{ backgroundColor: THEME.light.ma[ma] }}
              />
              {ma}
            </span>
          ))}
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
              {tooltip.label}
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
              {MA_PERIODS.map(
                (ma) =>
                  tooltip.ma[ma] !== undefined && (
                    <span key={ma} style={{ color: THEME.light.ma[ma] }}>
                      {ma} {tooltip.ma[ma]!.toLocaleString("ko-KR", { maximumFractionDigits: 0 })}
                    </span>
                  )
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

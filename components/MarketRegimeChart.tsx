"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { REGIME_LABELS, countTransitions, type Regime, type RegimeDay } from "@/lib/marketRegime";
import { REGIME_CHART_PERIODS, REGIME_RECENT_TRANSITIONS } from "@/lib/marketRegimeConfig";
import { downsampleIndices, indexedRuns, monthTicks, nearestIndex, niceTicks, recentTransitions, windowDays, type PeriodKey } from "@/lib/marketRegimeChart";
import { withWeekday } from "@/lib/marketRegimeView";
import { BADGE_CLASS } from "@/components/marketRegimeStyles";

/** 그래프 뒤 배경(국면 색, 투명도로 선이 보이게). 미정은 칠하지 않는다. */
const BG_FILL: Record<Regime, string> = { bull: "fill-rise/15", neutral: "fill-ink-faint/15", bear: "fill-fall/15", crisis: "fill-est/25", undefined: "fill-transparent" };
const SWATCH: Record<Regime, string> = { bull: "bg-rise/15 border-rise/50", neutral: "bg-ink-faint/15 border-ink-faint/50", bear: "bg-fall/15 border-fall/50", crisis: "bg-est/25 border-est/60", undefined: "" };
const LEGEND: Regime[] = ["bull", "neutral", "bear", "crisis"];

const HEIGHT = 220;
const M = { l: 46, r: 8, t: 8, b: 34 };

const fmtClose = (v: number): string => v.toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtAxis = (v: number): string => v.toLocaleString("ko-KR", { maximumFractionDigits: 0 });

function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(Math.floor(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** KOSPI 종가 선 그래프 + 국면 배경색 + 월 눈금 + 기간 선택 + 최근 국면 전환. 새 차트 라이브러리 없이 SVG로 그린다. */
export default function MarketRegimeChart({ days }: { days: RegimeDay[] }) {
  const [period, setPeriod] = useState<PeriodKey>("1y");
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrapRef);
  const win = useMemo(() => windowDays(days, period), [days, period]);
  const transitions = useMemo(() => recentTransitions(days, REGIME_RECENT_TRANSITIONS), [days]);

  if (win.length === 0) return <p className="mt-5 text-sm text-ink-muted">그래프를 그릴 자료가 없습니다.</p>;

  const n = win.length;
  const plotW = Math.max(0, width - M.l - M.r);
  const plotH = HEIGHT - M.t - M.b;
  const closes = win.map((d) => d.kospiClose);
  let lo = Math.min(...closes), hi = Math.max(...closes);
  const pad = (hi - lo) * 0.06 || hi * 0.01;
  lo -= pad; hi += pad;
  const x = (i: number): number => M.l + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const y = (v: number): number => M.t + (1 - (v - lo) / (hi - lo)) * plotH;
  const clampX = (v: number): number => Math.min(M.l + plotW, Math.max(M.l, v));
  const yTicks = niceTicks(lo, hi, 4);
  const xTicks = monthTicks(win.map((d) => d.date), Math.max(2, Math.floor(plotW / 46)));
  const runs = indexedRuns(win);
  const path = downsampleIndices(n, Math.max(2, Math.floor(plotW * 1.5))).map((i, k) => `${k === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(closes[i]).toFixed(1)}`).join("");

  const shown = hover ?? n - 1;
  const point = win[shown];
  const onPointer = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(nearestIndex(e.clientX - r.left, M.l, plotW, n));
  };

  return (
    <div className="mt-5" data-testid="regime-chart">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium text-ink">KOSPI 종가와 국면</p>
        <div role="group" aria-label="기간 선택" className="inline-flex rounded-lg bg-surface-sunken p-0.5">
          {REGIME_CHART_PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={period === p.key}
              onClick={() => { setPeriod(p.key); setHover(null); }}
              className={`h-8 min-w-12 rounded-md px-3 text-xs ${period === p.key ? "bg-surface font-semibold text-ink shadow-sm" : "text-ink-muted"}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <p className="mt-2 flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-testid="regime-readout" aria-live="polite">
        <span className="font-semibold text-ink">{withWeekday(point.date)}</span>
        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${BADGE_CLASS[point.regime]}`}>{REGIME_LABELS[point.regime]}</span>
        <span className="tabular-nums text-ink">KOSPI {fmtClose(point.kospiClose)}</span>
        {hover === null && <span className="text-xs text-ink-faint">(최신)</span>}
      </p>

      <div ref={wrapRef} className="mt-1 w-full select-none" style={{ height: HEIGHT }}>
        {width > 0 && (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={`KOSPI 종가와 시장 국면 그래프, ${win[0].date}부터 ${win[n - 1].date}까지`}
            style={{ touchAction: "pan-y", display: "block" }}
            onPointerDown={onPointer}
            onPointerMove={onPointer}
            onPointerLeave={(e) => { if (e.pointerType === "mouse") setHover(null); }}
          >
            <defs><clipPath id="regime-plot"><rect x={M.l} y={M.t} width={plotW} height={plotH} /></clipPath></defs>
            <g clipPath="url(#regime-plot)">
              {n > 1 && runs.map((r) => {
                const x0 = clampX(x(r.startIndex - 0.5)), x1 = clampX(x(r.startIndex + r.days - 0.5));
                return <rect key={r.startIndex} x={x0} y={M.t} width={Math.max(0, x1 - x0)} height={plotH} className={BG_FILL[r.regime]}><title>{`${REGIME_LABELS[r.regime]} ${r.start}~${r.end} (${r.days}거래일)`}</title></rect>;
              })}
            </g>
            {yTicks.map((v) => (
              <g key={v}>
                <line x1={M.l} x2={M.l + plotW} y1={y(v)} y2={y(v)} className="stroke-border" strokeWidth={1} />
                <text x={M.l - 6} y={y(v) + 3} textAnchor="end" className="fill-ink-faint text-[10px]">{fmtAxis(v)}</text>
              </g>
            ))}
            {xTicks.map((t) => {
              const tx = x(t.index);
              const anchor = tx > M.l + plotW - 14 ? "end" : tx < M.l + 14 ? "start" : "middle";
              return (
                <g key={t.index}>
                  <line x1={tx} x2={tx} y1={M.t + plotH} y2={M.t + plotH + 4} className="stroke-ink-faint" strokeWidth={1} />
                  <text x={tx} y={M.t + plotH + 15} textAnchor={anchor} className="fill-ink-muted text-[10px]">{t.label}</text>
                  {t.year && <text x={tx} y={M.t + plotH + 27} textAnchor={anchor} className="fill-ink text-[10px] font-semibold">{t.year}</text>}
                </g>
              );
            })}
            <path d={path} fill="none" className="stroke-ink" strokeWidth={1.5} strokeLinejoin="round" />
            {n > 1 && hover !== null && <line x1={x(hover)} x2={x(hover)} y1={M.t} y2={M.t + plotH} className="stroke-ink-muted" strokeWidth={1} strokeDasharray="3 3" />}
            <circle cx={x(shown)} cy={y(point.kospiClose)} r={4} className="fill-ink stroke-surface" strokeWidth={2} />
          </svg>
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {LEGEND.map((g) => (
            <span key={g} className="flex items-center gap-1.5 text-xs text-ink-muted">
              <span className={`inline-block h-2.5 w-2.5 rounded-sm border ${SWATCH[g]}`} />
              {REGIME_LABELS[g]}
            </span>
          ))}
        </div>
        <p className="text-xs text-ink-faint">이 기간 전환 {countTransitions(win.map((d) => d.regime))}회</p>
      </div>
      <p className="mt-1 text-[11px] text-ink-faint">그래프를 누르거나 올리면 그 날짜의 국면과 종가를 볼 수 있습니다.</p>

      {transitions.length > 0 && (
        <div className="mt-4" data-testid="regime-transitions">
          <p className="mb-1 text-xs font-medium text-ink">최근 국면 전환 {transitions.length}건</p>
          <ul>
            {transitions.map((t) => (
              <li key={t.date} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border py-1.5 text-sm last:border-0">
                <span className="tabular-nums text-ink">{t.date}</span>
                <span className="flex items-center gap-1">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${BADGE_CLASS[t.from]}`}>{REGIME_LABELS[t.from]}</span>
                  <span aria-hidden="true" className="text-ink-faint">→</span>
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${BADGE_CLASS[t.to]}`}>{REGIME_LABELS[t.to]}</span>
                </span>
                <span className="text-xs text-ink-muted">이전 {REGIME_LABELS[t.from]} {t.fromDays.toLocaleString("ko-KR")}거래일 지속</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

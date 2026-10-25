"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { authJsonFetcher } from "@/lib/authFetch";
import { REGIME_LABELS, type Regime } from "@/lib/marketRegime";
import type { MarketRegimeResponse } from "@/lib/marketRegimeApiTypes";
import { REGIME_TOP_N } from "@/lib/marketRegimeConfig";

/** 국면별 색: 한국 시장 관례(상승=빨강, 하락=파랑)를 따르는 디자인 토큰만 쓴다(색 하드코딩 금지). */
const BADGE_CLASS: Record<Regime, string> = {
  bull: "bg-rise-soft text-rise",
  neutral: "bg-surface-sunken text-ink-muted",
  bear: "bg-fall-soft text-fall",
  crisis: "bg-est-soft text-est",
  undefined: "bg-surface-sunken text-ink-faint",
};
const STRIP_CLASS: Record<Regime, string> = { bull: "bg-rise", neutral: "bg-ink-faint", bear: "bg-fall", crisis: "bg-est", undefined: "bg-border" };
const LEGEND: Regime[] = ["bull", "neutral", "bear", "crisis"];

const fmt = (v: number | null | undefined, digits = 2): string => (v === null || v === undefined || !Number.isFinite(v) ? "-" : v.toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const pct = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const signClass = (v: number | null | undefined): string => (v === null || v === undefined ? "text-ink" : v > 0 ? "text-rise" : v < 0 ? "text-fall" : "text-flat");

function Indicator({ label, value, sub, valueClass = "text-ink" }: { label: string; value: string; sub: string; valueClass?: string }) {
  return (
    <div className="rounded-lg bg-surface-sunken p-3">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className={`mt-1 text-lg font-semibold tabular-nums ${valueClass}`}>{value}</p>
      <p className="mt-0.5 text-xs text-ink-faint">{sub}</p>
    </div>
  );
}

export default function MarketRegimeCard() {
  const { data, error, isLoading } = useSWR<MarketRegimeResponse>("/api/market-regime", authJsonFetcher);

  // 타임라인을 같은 국면이 이어지는 구간으로 묶어 띠로 그린다.
  const runs = useMemo(() => {
    const out: { regime: Regime; start: string; end: string; days: number }[] = [];
    for (const d of data?.timeline ?? []) {
      const last = out[out.length - 1];
      if (last && last.regime === d.regime) { last.end = d.date; last.days++; } else out.push({ regime: d.regime, start: d.date, end: d.date, days: 1 });
    }
    return out;
  }, [data]);

  if (isLoading) {
    return <div className="mb-6 animate-pulse rounded-card border border-border bg-surface p-4"><div className="h-24 w-full rounded bg-surface-sunken" /></div>;
  }
  if (error || !data) {
    return <div className="mb-6 rounded-card border border-border bg-surface p-4 text-sm text-fall">시장 국면을 불러오지 못했습니다.</div>;
  }
  const l = data.latest;
  if (!l) {
    return (
      <div className="mb-6 rounded-card border border-border bg-surface p-4">
        <p className="text-sm font-medium text-ink">시장 국면</p>
        <p className="mt-2 text-sm text-ink-muted">국면 자료가 아직 없습니다(이력 백필 전).</p>
      </div>
    );
  }
  const t = data.thresholds;
  const vsMa200 = l.ma200 ? (l.kospiClose / l.ma200 - 1) * 100 : null;
  const vsMa50 = l.ma50 ? (l.kospiClose / l.ma50 - 1) * 100 : null;
  const pending = l.rawRegime !== l.regime && l.rawRegime !== "undefined";

  return (
    <div className="mb-6 rounded-card border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <p className="text-sm font-medium text-ink">시장 국면</p>
          <span className={`rounded-full px-3 py-1 text-sm font-semibold ${BADGE_CLASS[l.regime]}`}>{REGIME_LABELS[l.regime]}</span>
        </div>
        <p className="text-xs text-ink-muted">직전 거래일 기준 · {l.tradeDate}</p>
      </div>
      {pending && (
        <p className="mt-2 text-xs text-ink-muted">
          그날 신호는 <span className="font-medium text-ink">{REGIME_LABELS[l.rawRegime]}</span>이지만 연속 {t.confirmDays}거래일 같은 신호가 나와야 국면이 바뀌므로 직전 국면을 유지 중입니다.
        </p>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Indicator label="KOSPI vs 200일선" value={pct(vsMa200)} valueClass={signClass(vsMa200)} sub={`${fmt(l.kospiClose)} / ${fmt(l.ma200)}`} />
        <Indicator label="KOSPI vs 50일선" value={pct(vsMa50)} valueClass={signClass(vsMa50)} sub={`50일선 ${fmt(l.ma50)}`} />
        <Indicator label="B50 (50일선 위 종목 비율)" value={`${fmt(l.b50)}%`} sub={`기준: 위기 <${t.crisisB50Below} · 약세 <${t.bearB50Below} · 강세 ≥${t.bullB50AtLeast}`} />
        <Indicator label="B200 (200일선 위, 참고)" value={`${fmt(l.b200)}%`} sub={`구성 ${l.memberCount}종목`} />
        <Indicator label="NH (55일 신고가−신저가)" value={l.nh === null ? "-" : `${l.nh > 0 ? "+" : ""}${l.nh}`} valueClass={signClass(l.nh)} sub={`기준: 강세는 NH > ${t.bullNhAbove}`} />
        <Indicator label="252일 고점 대비" value={`${fmt(l.drawdown)}%`} valueClass={signClass(l.drawdown)} sub={`기준: 위기는 ≤ ${t.crisisDrawdownPct}%`} />
        <Indicator label="20일 변동성(연환산)" value={`${fmt(l.vol20)}%`} sub="국면 판정에는 쓰지 않음" />
        <Indicator label="변동성 1년 백분위" value={l.volPctile === null ? "-" : `${fmt(l.volPctile, 0)}%`} sub="최근 252거래일 대비" />
      </div>

      <div className="mt-5">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <p className="text-xs font-medium text-ink">최근 1년 국면</p>
          <p className="text-xs text-ink-faint">전환 {data.timelineTransitions}회</p>
        </div>
        <div className="flex h-4 w-full overflow-hidden rounded">
          {runs.map((r, i) => (
            <div key={i} className={STRIP_CLASS[r.regime]} style={{ flexGrow: r.days, flexBasis: 0 }} title={`${REGIME_LABELS[r.regime]} ${r.start}~${r.end} (${r.days}거래일)`} />
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-ink-faint">
          <span>{data.timeline[0]?.date}</span>
          <span>{data.timeline[data.timeline.length - 1]?.date}</span>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {LEGEND.map((g) => (
            <span key={g} className="flex items-center gap-1.5 text-xs text-ink-muted">
              <span className={`inline-block h-2.5 w-2.5 rounded-sm ${STRIP_CLASS[g]}`} />
              {REGIME_LABELS[g]}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <p className="text-xs font-medium text-ink">국면별 과거 평균 성과</p>
          <span className="rounded bg-est-soft px-1.5 py-0.5 text-[11px] font-medium text-est">개발 데이터 내 성적</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-ink-muted">
                <th className="py-1.5 pr-2 font-normal">국면</th>
                <th className="py-1.5 pr-2 text-right font-normal">일수 (비율)</th>
                <th className="py-1.5 pr-2 text-right font-normal">{data.stats.forwardDays}거래일 후 평균 (표본 수)</th>
                <th className="py-1.5 text-right font-normal">승률</th>
              </tr>
            </thead>
            <tbody>
              {data.stats.byRegime.map((s) => (
                <tr key={s.regime} className="border-b border-border last:border-0">
                  <td className="py-1.5 pr-2"><span className={`rounded px-1.5 py-0.5 text-xs font-medium ${BADGE_CLASS[s.regime]}`}>{REGIME_LABELS[s.regime]}</span></td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{s.days.toLocaleString("ko-KR")}<span className="block text-xs text-ink-faint">{fmt(s.share, 1)}%</span></td>
                  <td className={`py-1.5 pr-2 text-right tabular-nums ${signClass(s.avgForwardPct)}`}>{pct(s.avgForwardPct)}<span className="block text-xs text-ink-faint">n = {s.samples.toLocaleString("ko-KR")}</span></td>
                  <td className="py-1.5 text-right tabular-nums">{s.winRatePct === null ? "-" : `${fmt(s.winRatePct, 1)}%`}</td>
                </tr>
              ))}
              <tr className="text-ink-muted">
                <td className="py-1.5 pr-2 text-xs">전체</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{data.stats.definedDays.toLocaleString("ko-KR")}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{pct(data.stats.all.avgForwardPct)}<span className="block text-xs text-ink-faint">n = {data.stats.all.samples.toLocaleString("ko-KR")}</span></td>
                <td className="py-1.5 text-right tabular-nums">{data.stats.all.winRatePct === null ? "-" : `${fmt(data.stats.all.winRatePct, 1)}%`}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-ink-faint">
          수익률은 {data.stats.benchmark}의 {data.stats.from}~{data.stats.to} 일별 종가 기준입니다(069500 일별 자료가 없어 지수로 대체, 비용 미반영). 국면은 평균 {fmt(data.stats.transitionsPerYear, 1)}회/년 바뀌고 한 번 바뀌면 중앙값 {fmt(data.stats.medianRunDays, 0)}거래일 유지됐습니다.
        </p>
      </div>

      <div className="mt-4 space-y-1 border-t border-border pt-3 text-xs text-ink-muted">
        <p className="font-medium text-ink">국면 표시는 현재 상태를 설명하는 지표이며 예측이 아닙니다. 연구에서 국면으로 매매를 걸러내는 방식은 수익을 개선하지 못했습니다.</p>
        <p>
          구성 종목은 코스피 시총 상위 {REGIME_TOP_N}개(우선주·스팩·리츠 제외, 20일 평균 거래대금 5억 원 이상)입니다.
          {data.backfillThrough ? ` ${data.backfillThrough}까지의 이력은 월말 시장 구분 기준이고` : ""}
          {data.dailyFrom ? ` ${data.dailyFrom} 이후 일일 계산은 현재 코스피 구성 기준입니다.` : " 이후 일일 계산은 현재 코스피 구성 기준으로 이어집니다."}
        </p>
        {data.status.lastError && <p className="text-est">최근 일일 계산 오류: {data.status.lastError}</p>}
      </div>
    </div>
  );
}

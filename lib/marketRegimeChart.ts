import { regimeRuns, type Regime, type RegimeDay, type RegimeRun } from "@/lib/marketRegime";
import type { MarketRegimeSeries } from "@/lib/marketRegimeApiTypes";
import { REGIME_CHART_PERIODS } from "@/lib/marketRegimeConfig";

/* 시장 국면 카드의 KOSPI 종가 선 그래프용 계산(화면 좌표 계산 제외, 순수 함수). */

/** 응답 series.regimes의 1글자 코드(서버가 만들고 화면이 푼다). */
export const REGIME_SERIES_CODES: Record<Regime, string> = { bull: "B", neutral: "N", bear: "R", crisis: "C", undefined: "U" };
const CODE_TO_REGIME: Record<string, Regime> = { B: "bull", N: "neutral", R: "bear", C: "crisis", U: "undefined" };

export type PeriodKey = (typeof REGIME_CHART_PERIODS)[number]["key"];

/** 열 배열을 날짜별 객체로 푼다. 길이가 서로 맞지 않거나 모르는 코드가 있으면 빈 배열(자료 오류는 그래프를 그리지 않는다). */
export function seriesToDays(s: MarketRegimeSeries | undefined): RegimeDay[] {
  if (!s || s.dates.length !== s.closes.length || s.dates.length !== s.regimes.length) return [];
  const out: RegimeDay[] = [];
  for (let i = 0; i < s.dates.length; i++) {
    const regime = CODE_TO_REGIME[s.regimes[i]];
    if (!regime) return [];
    out.push({ date: s.dates[i], regime, kospiClose: s.closes[i] });
  }
  return out;
}

/** 선택한 기간의 마지막 N거래일(전체면 그대로). 이력이 기간보다 짧으면 있는 만큼만. */
export function windowDays<T>(days: T[], key: PeriodKey): T[] {
  const p = REGIME_CHART_PERIODS.find((x) => x.key === key);
  return p && p.days !== null ? days.slice(-p.days) : days;
}

export interface MonthTick {
  /** 구간 안 거래일 순번(0부터). */
  index: number;
  label: string;
  /** 1월 눈금에만 붙는 연도(눈금 간격이 1년 이상이면 label이 연도라 null). */
  year: string | null;
}

/**
 * 가로축 월 눈금. 각 달의 첫 거래일에 눈금을 두고, 눈금이 maxTicks를 넘지 않도록 월 간격(1·2·3·6개월, 그 이상은 연 단위)을 고른다.
 * 간격은 1월을 기준으로 맞춘다(예: 3개월 간격이면 1·4·7·10월). 구간 첫날이 속한 달은 중간부터 시작한 달이라 눈금을 두지 않는다.
 */
export function monthTicks(dates: string[], maxTicks: number): MonthTick[] {
  const cands: { index: number; year: number; month: number }[] = [];
  for (let i = 1; i < dates.length; i++) {
    if (dates[i].slice(0, 7) !== dates[i - 1].slice(0, 7)) cands.push({ index: i, year: Number(dates[i].slice(0, 4)), month: Number(dates[i].slice(5, 7)) });
  }
  const steps = [1, 2, 3, 6, 12, 24, 60, 120];
  const pick = (step: number) => cands.filter((c) => (step <= 12 ? (c.month - 1) % step === 0 : c.month === 1 && c.year % (step / 12) === 0));
  let chosen = pick(steps[steps.length - 1]), chosenStep = steps[steps.length - 1];
  for (const step of steps) {
    const t = pick(step);
    if (t.length <= maxTicks) { chosen = t; chosenStep = step; break; }
  }
  return chosen.map((c) => (chosenStep >= 12
    ? { index: c.index, label: String(c.year), year: null }
    : { index: c.index, label: `${c.month}월`, year: c.month === 1 ? String(c.year) : null }));
}

/** 세로축 눈금: min~max 안의 "보기 좋은" 값(1·2·5 × 10^k 간격) 중 대략 count개. */
export function niceTicks(min: number, max: number, count: number): number[] {
  if (!(max > min) || count < 1) return [];
  const rough = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

/** 선을 그릴 때 점이 너무 많으면 균등 간격으로 솎는다(처음과 마지막 점은 항상 포함). 마우스·터치 위치 계산은 원본 전체를 쓴다. */
export function downsampleIndices(n: number, maxPoints: number): number[] {
  if (n <= 0) return [];
  if (n <= maxPoints || maxPoints < 2) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(Math.round((i * (n - 1)) / (maxPoints - 1)));
  return out;
}

/** 가로 위치(px) → 가장 가까운 거래일 순번. */
export function nearestIndex(x: number, plotLeft: number, plotWidth: number, n: number): number {
  if (n <= 1 || plotWidth <= 0) return 0;
  return Math.min(n - 1, Math.max(0, Math.round(((x - plotLeft) / plotWidth) * (n - 1))));
}

export interface IndexedRun extends RegimeRun { /** 구간 첫날의 거래일 순번 */ startIndex: number }

/** 같은 국면이 이어지는 구간(배경 색칠용), 순번 포함. */
export function indexedRuns(days: RegimeDay[]): IndexedRun[] {
  let at = 0;
  return regimeRuns(days).map((r) => { const o = { ...r, startIndex: at }; at += r.days; return o; });
}

export interface RegimeTransition {
  /** 새 국면 첫날. */
  date: string;
  from: Regime;
  to: Regime;
  /** 이전 국면이 이어진 거래일 수. */
  fromDays: number;
}

/** 최근 국면 전환 n건(최신 먼저). 미정 → 첫 국면은 전환으로 세지 않는다(lib/marketRegime.ts countTransitions와 같은 정의). */
export function recentTransitions(days: RegimeDay[], n: number): RegimeTransition[] {
  const runs = regimeRuns(days);
  const out: RegimeTransition[] = [];
  for (let i = 1; i < runs.length; i++) {
    if (runs[i].regime === "undefined" || runs[i - 1].regime === "undefined") continue;
    out.push({ date: runs[i].start, from: runs[i - 1].regime, to: runs[i].regime, fromDays: runs[i - 1].days });
  }
  return out.slice(-n).reverse();
}

/**
 * 시장 국면(레짐) 계산 — 순수 함수 모음(I/O 없음). 입력은 KOSPI 지수 종가 시계열과 구성 종목의 종가 시계열.
 * 규칙·창 길이는 lib/marketRegimeConfig.ts. 국면은 현재 상태를 설명하는 지표이며 예측이 아니다.
 */
import {
  REGIME_MA_SHORT, REGIME_MA_LONG, REGIME_NH_WINDOW, REGIME_DRAWDOWN_WINDOW, REGIME_VOL_WINDOW, REGIME_VOL_PCTILE_WINDOW,
  REGIME_TRADING_DAYS_PER_YEAR, REGIME_CRISIS_DRAWDOWN_PCT, REGIME_CRISIS_B50_BELOW, REGIME_BEAR_B50_BELOW, REGIME_BULL_B50_AT_LEAST,
  REGIME_BULL_NH_ABOVE, REGIME_CONFIRM_DAYS, REGIME_SPAC_NAME_KEYWORDS, REGIME_REIT_NAME_SUFFIX, REGIME_REIT_KSIC_PREFIXES,
  REGIME_REIT_EXPLICIT_CODES, REGIME_PRODUCT_TYPE_STOCK,
} from "@/lib/marketRegimeConfig";

export type Regime = "crisis" | "bear" | "neutral" | "bull" | "undefined";
export const REGIME_LABELS: Record<Regime, string> = { crisis: "위기", bear: "약세", neutral: "중립", bull: "강세", undefined: "미정" };

export interface IndexPoint { date: string; close: number }
export interface IndexMetric {
  date: string; close: number;
  ma50: number | null; ma200: number | null;
  /** 252일(창이 다 찬 날만) 고점 대비 낙폭 %, 0 이하. */
  drawdownPct: number | null;
  /** 20일 실현 변동성(일간 수익률 표준편차 × √252, %). */
  vol20: number | null;
  /** vol20이 최근 252거래일(오늘 포함) 값 중 차지하는 백분위(오늘 이하인 값의 비율 %). */
  volPctile: number | null;
}

/** KOSPI 지수 일별 종가(날짜 오름차순)로 이동평균·낙폭·변동성을 계산한다. 창이 덜 찬 날의 값은 null. */
export function computeIndexMetrics(points: IndexPoint[]): IndexMetric[] {
  const n = points.length;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + points[i].close;
  const vol = new Array<number | null>(n).fill(null);
  for (let i = REGIME_VOL_WINDOW; i < n; i++) {
    let sum = 0, sumSq = 0;
    for (let j = i - REGIME_VOL_WINDOW + 1; j <= i; j++) { const r = points[j].close / points[j - 1].close - 1; sum += r; sumSq += r * r; }
    const m = sum / REGIME_VOL_WINDOW;
    const variance = (sumSq - REGIME_VOL_WINDOW * m * m) / (REGIME_VOL_WINDOW - 1);
    vol[i] = Math.sqrt(Math.max(variance, 0)) * Math.sqrt(REGIME_TRADING_DAYS_PER_YEAR) * 100;
  }
  return points.map((p, i) => {
    const ma50 = i >= REGIME_MA_SHORT - 1 ? (pre[i + 1] - pre[i + 1 - REGIME_MA_SHORT]) / REGIME_MA_SHORT : null;
    const ma200 = i >= REGIME_MA_LONG - 1 ? (pre[i + 1] - pre[i + 1 - REGIME_MA_LONG]) / REGIME_MA_LONG : null;
    let drawdownPct: number | null = null;
    if (i >= REGIME_DRAWDOWN_WINDOW - 1) {
      let hi = -Infinity;
      for (let j = i - REGIME_DRAWDOWN_WINDOW + 1; j <= i; j++) if (points[j].close > hi) hi = points[j].close;
      drawdownPct = (p.close / hi - 1) * 100;
    }
    const v = vol[i];
    let volPctile: number | null = null;
    if (v !== null && i >= REGIME_VOL_WINDOW + REGIME_VOL_PCTILE_WINDOW - 1) {
      let le = 0;
      for (let j = i - REGIME_VOL_PCTILE_WINDOW + 1; j <= i; j++) if ((vol[j] as number) <= v) le++;
      volPctile = (le / REGIME_VOL_PCTILE_WINDOW) * 100;
    }
    return { date: p.date, close: p.close, ma50, ma200, drawdownPct, vol20: v, volPctile };
  });
}

// ---- 구성 종목 선정 ----
export interface MemberCandidate { code: string; mcapEok: number; avgTradingValueWon: number; isKospi: boolean; excluded: boolean }

/** 제외 규칙에 해당하는지: 우선주(끝자리 ≠ 0), 스팩, 리츠 이름·업종·명시 코드, (주어지면) 종목구분 ≠ 주식. */
export function isExcludedStock(info: { code: string; name?: string | null; ksic?: string | null; productType?: string | null }): boolean {
  if (info.code[info.code.length - 1] !== "0") return true;
  if (info.productType && info.productType !== REGIME_PRODUCT_TYPE_STOCK) return true;
  const n = info.name ?? undefined;
  if (n !== undefined && (REGIME_SPAC_NAME_KEYWORDS.some((k) => n.includes(k)) || n.trim().endsWith(REGIME_REIT_NAME_SUFFIX))) return true;
  if (info.ksic && REGIME_REIT_KSIC_PREFIXES.some((p) => info.ksic!.startsWith(p))) return true;
  return (REGIME_REIT_EXPLICIT_CODES as readonly string[]).includes(info.code);
}

/** 코스피 ∩ 20일 평균 거래대금 ≥ 하한 ∩ 제외 규칙 통과 종목을 시총 내림차순(동률은 코드 오름차순)으로 topN개. */
export function selectMembers(cands: MemberCandidate[], topN: number, minAvgTradingValueWon: number): string[] {
  return cands
    .filter((c) => c.isKospi && !c.excluded && c.avgTradingValueWon >= minAvgTradingValueWon)
    .sort((a, b) => b.mcapEok - a.mcapEok || (a.code < b.code ? -1 : 1))
    .slice(0, topN)
    .map((c) => c.code);
}

// ---- 시장 폭 ----
export interface StockSeries { code: string; dates: string[]; close: ArrayLike<number> }
export interface IndexedStock { code: string; dates: string[]; close: ArrayLike<number>; idx: Map<string, number>; prefix: Float64Array }

export function indexStock(s: StockSeries): IndexedStock {
  const prefix = new Float64Array(s.dates.length + 1);
  for (let i = 0; i < s.dates.length; i++) prefix[i + 1] = prefix[i] + s.close[i];
  return { code: s.code, dates: s.dates, close: s.close, idx: new Map(s.dates.map((d, i) => [d, i])), prefix };
}

export interface Breadth {
  /** 그날 가격 행이 있는 구성 종목 수. */
  members: number;
  n50: number; a50: number; n200: number; a200: number;
  /** 55일 종가 신고가·신저가 종목 수. */
  highs: number; lows: number;
  /** 50일선 위 종목 비율 %(분모 = 50일선이 정의되는 종목 수). */
  b50: number | null; b200: number | null;
  /** 신고가 수 − 신저가 수. */
  nh: number;
}

/** 날짜 date의 종가까지의 값으로 B50·B200·NH를 센다. 종목 자신의 종가 행 기준(행 수로 창을 센다). */
export function breadthOn(stocks: Map<string, IndexedStock>, members: string[], date: string): Breadth {
  let m = 0, n50 = 0, a50 = 0, n200 = 0, a200 = 0, hi = 0, lo = 0;
  for (const code of members) {
    const s = stocks.get(code);
    const i = s?.idx.get(date);
    if (!s || i === undefined) continue;
    m++;
    const cl = s.close[i];
    if (i >= REGIME_MA_SHORT - 1) { n50++; if (cl > (s.prefix[i + 1] - s.prefix[i + 1 - REGIME_MA_SHORT]) / REGIME_MA_SHORT) a50++; }
    if (i >= REGIME_MA_LONG - 1) { n200++; if (cl > (s.prefix[i + 1] - s.prefix[i + 1 - REGIME_MA_LONG]) / REGIME_MA_LONG) a200++; }
    if (i >= REGIME_NH_WINDOW) {
      let mx = -Infinity, mn = Infinity;
      for (let j = i - REGIME_NH_WINDOW; j < i; j++) { const c = s.close[j]; if (c > mx) mx = c; if (c < mn) mn = c; }
      if (cl > mx) hi++;
      if (cl < mn) lo++;
    }
  }
  return { members: m, n50, a50, n200, a200, highs: hi, lows: lo, b50: n50 ? (a50 / n50) * 100 : null, b200: n200 ? (a200 / n200) * 100 : null, nh: hi - lo };
}

// ---- 국면 판정 ----
export interface RawInput { close: number; ma200: number | null; b50: number | null; nh: number | null; drawdownPct: number | null }

/** 하루치 신호(3일 확인 전). 200일선·B50이 없으면 "미정". 순서: 위기 → 약세 → 강세 → 중립. */
export function classifyRaw(x: RawInput): Regime {
  if (x.ma200 === null || x.b50 === null) return "undefined";
  if (x.drawdownPct !== null && x.drawdownPct <= REGIME_CRISIS_DRAWDOWN_PCT && x.b50 < REGIME_CRISIS_B50_BELOW) return "crisis";
  if (x.close < x.ma200 && x.b50 < REGIME_BEAR_B50_BELOW) return "bear";
  if (x.close > x.ma200 && x.b50 >= REGIME_BULL_B50_AT_LEAST && x.nh !== null && x.nh > REGIME_BULL_NH_ABOVE) return "bull";
  return "neutral";
}

/**
 * 오늘의 국면 = 직전 국면(없거나 "미정"이면 오늘 신호를 바로 채택), 마지막 `days`개 신호가 모두 같고 직전 국면과 다르면 그 신호로 변경,
 * 아니면 직전 국면 유지. 오늘 신호가 "미정"이면 "미정". `recentRaws`는 오늘 신호가 마지막인 최근 신호 목록.
 */
export function nextRegime(prev: Regime | null, recentRaws: Regime[], days: number = REGIME_CONFIRM_DAYS): Regime {
  const today = recentRaws[recentRaws.length - 1];
  if (today === "undefined") return "undefined";
  if (prev === null || prev === "undefined") return today;
  if (recentRaws.length >= days && recentRaws.slice(-days).every((r) => r === today) && today !== prev) return today;
  return prev;
}

/** 신호 시계열 전체에 3일 확인 규칙을 적용한다(days = 1이면 확인 없이 신호 그대로). */
export function confirmRegimes(raws: Regime[], days: number = REGIME_CONFIRM_DAYS): Regime[] {
  const out: Regime[] = [];
  for (let t = 0; t < raws.length; t++) out.push(nextRegime(t === 0 ? null : out[t - 1], raws.slice(Math.max(0, t - days + 1), t + 1), days));
  return out;
}

// ---- 이력 통계 ----
export interface RegimeDay { date: string; regime: Regime; kospiClose: number }
export interface RegimeRun { regime: Regime; start: string; end: string; days: number }

export function regimeRuns(rows: RegimeDay[]): RegimeRun[] {
  const out: RegimeRun[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.regime === r.regime) { last.end = r.date; last.days++; } else out.push({ regime: r.regime, start: r.date, end: r.date, days: 1 });
  }
  return out;
}

/** 국면 전환 횟수(미정 → 첫 국면은 전환으로 세지 않는다). */
export function countTransitions(regimes: Regime[]): number {
  let n = 0, prev: Regime | null = null;
  for (const r of regimes) {
    if (r === "undefined") { prev = null; continue; }
    if (prev !== null && r !== prev) n++;
    prev = r;
  }
  return n;
}

export interface RegimeStat { regime: Regime; days: number; share: number; samples: number; avgForwardPct: number | null; winRatePct: number | null }

/** 국면별 일수·비율(미정 제외 분모)과, 그 국면이었던 날 종가 → h거래일 뒤 종가 수익률의 평균·표본 수·승률(수익률 > 0 비율). */
export function summarizeByRegime(rows: RegimeDay[], h: number): RegimeStat[] {
  const defined = rows.filter((r) => r.regime !== "undefined");
  const order: Regime[] = ["bull", "neutral", "bear", "crisis"];
  return order.map((regime) => {
    const days = defined.filter((r) => r.regime === regime).length;
    const rets: number[] = [];
    rows.forEach((r, i) => { if (r.regime === regime && i + h < rows.length) rets.push(rows[i + h].kospiClose / r.kospiClose - 1); });
    return {
      regime, days, share: defined.length ? (days / defined.length) * 100 : 0, samples: rets.length,
      avgForwardPct: rets.length ? (rets.reduce((a, b) => a + b, 0) / rets.length) * 100 : null,
      winRatePct: rets.length ? (rets.filter((x) => x > 0).length / rets.length) * 100 : null,
    };
  });
}

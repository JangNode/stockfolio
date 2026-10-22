import { PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";
import { FEE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";
import {
  KSS_K200P_SIZE,
  KSS_SPAC_NAME_KEYWORDS,
  KSS_REIT_NAME_SUFFIX,
  KSS_REIT_KSIC_PREFIXES,
  KSS_EXPLICIT_EXCLUDED_CODES,
  KSS_SECTOR_CODE_LENGTH,
  KSS_MOMENTUM_LOOKBACK_MONTHS,
  KSS_MOMENTUM_SKIP_MONTHS,
  KSS_MIN_SECTOR_STOCKS,
  KSS_TOP_SECTORS,
  KSS_STOCKS_PER_SECTOR,
  KSS_SATELLITE_WEIGHT,
  KSS_TRIM_MIN_ACCOUNT_WEIGHT,
  KSS_SATELLITE_CAP,
  KSS_ETF_SLIPPAGE,
} from "@/lib/kodexSectorSatelliteConfig";

/**
 * KODEX 200 + 업종 모멘텀 위성 전략의 순수 계산 모듈(서버·화면 공용, DB/네트워크 없음).
 * 연구 스크립트(연구 브랜치 scripts/research-kodex-sector-satellite-v3_2.ts, 사전등록 d70b1fd)의
 * 신호 계산(K200P → 업종 모멘텀 → 상위 3개 업종 × 업종별 시총 상위 3종목 → 1% 미만 정리)과
 * 실제 계좌 정수 주 리밸런싱(v3.2 B) 규칙을 그대로 옮긴다. 입력 시세는 호출하는 쪽이 준비한다
 * (운영 배치: stock_daily_prices_recent + KRX 당일 응답, 검증: 연구와 같은 Parquet).
 */

/** 종목 하나의 시세 계열(날짜 오름차순). close는 수정주가, avgTv는 각 행의 "직전 20개 행 평균 거래대금"
 * (lib/pitUniverse.ts computeTrailingAvgTradingValue를 수정주가 행에 적용한 값). */
export interface KssStockSeries {
  dates: string[];
  close: ArrayLike<number>;
  mcapEok: ArrayLike<number>;
  avgTv: ArrayLike<number>;
}

export interface KssSignalInput {
  /** 신호일(그 달 마지막 거래일, YYYY-MM-DD). 모든 종목은 이날 행이 있어야 후보가 된다. */
  signalDate: string;
  series: Map<string, KssStockSeries>;
  /** 신호일 기준 KOSPI 상장 종목 코드(운영: 신호일 KRX stk_bydd_trd 응답, 검증: 월말 시장 목록). */
  kospiCodes: Set<string>;
  /** dart_corp_codes.corp_name(스팩·리츠 이름 규칙용). */
  names: Map<string, string>;
  /** stock_industry_classification.induty_code. */
  induty: Map<string, string>;
}

export interface KssSectorRank {
  sector: string;
  validCount: number;
  momentum: number;
}

export interface KssHolding {
  code: string;
  sector: string;
  /** 위성 안 비중(합 1). */
  weight: number;
}

export interface KssSignal {
  signalDate: string;
  momentumFrom: string;
  momentumTo: string;
  k200pCount: number;
  /** 유효 업종 전체를 모멘텀 내림차순(동점 업종 코드 오름차순)으로. */
  sectorRanks: KssSectorRank[];
  topSectors: string[];
  /** 1% 정리 전(v3.1) 위성. */
  preTrimHoldings: KssHolding[];
  /** 정리 후 위성(v3.2). fallbackToEtf면 빈 배열. */
  holdings: KssHolding[];
  /** 정리 후 남는 종목이 없어 위성을 069500으로 대체. */
  fallbackToEtf: boolean;
  /** 모멘텀 시작 월말 데이터가 없어 K200P 전체를 중립으로 쓴 경우(연구 첫 신호일과 같은 처리). */
  neutral: boolean;
}

/** 4c1557a 제외 규칙. */
export function isKssExcluded(code: string, name: string | undefined, induty: string | undefined): boolean {
  if (code[code.length - 1] !== "0") return true;
  if (name !== undefined) {
    if (KSS_SPAC_NAME_KEYWORDS.some((k) => name.includes(k))) return true;
    if (name.trim().endsWith(KSS_REIT_NAME_SUFFIX)) return true;
  }
  if (induty && KSS_REIT_KSIC_PREFIXES.some((p) => induty.startsWith(p))) return true;
  return (KSS_EXPLICIT_EXCLUDED_CODES as readonly string[]).includes(code);
}

export function sectorOf(induty: string | undefined): string | null {
  return induty ? induty.slice(0, KSS_SECTOR_CODE_LENGTH) : null;
}

/** YYYY-MM-DD의 달에서 months개월 앞 달의 말일(달력 기준). 연구의 "m − k번째 월말 거래일 이하 마지막 행"과 같은 행을 고르는 데 쓴다. */
export function monthEndMonthsBefore(dateIso: string, months: number): string {
  const y = Number(dateIso.slice(0, 4)), m = Number(dateIso.slice(5, 7)) - 1 - months;
  return new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
}

function lastIndexLe(dates: string[], d: string): number {
  let lo = 0, hi = dates.length - 1, k = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (dates[m] <= d) { k = m; lo = m + 1; } else hi = m - 1;
  }
  return k;
}

/** K200P(신호일): 신호일 행 있음 + 20일 평균 거래대금 ≥ 5억 + 제외 규칙 아님 → 신호일 시총 내림차순(동점 코드 오름차순) → KOSPI만 → 상위 200. */
export function buildK200P(input: KssSignalInput): { code: string; mcap: number }[] {
  const out: { code: string; mcap: number }[] = [];
  for (const [code, s] of input.series) {
    const i = lastIndexLe(s.dates, input.signalDate);
    if (i < 0 || s.dates[i] !== input.signalDate) continue;
    if (!(s.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON)) continue;
    if (isKssExcluded(code, input.names.get(code), input.induty.get(code))) continue;
    out.push({ code, mcap: s.mcapEok[i] });
  }
  out.sort((a, b) => b.mcap - a.mcap || (a.code < b.code ? -1 : 1));
  return out.filter((x) => input.kospiCodes.has(x.code)).slice(0, KSS_K200P_SIZE);
}

export function computeKssSignal(input: KssSignalInput, opts: { lookbackMonths?: number; topSectors?: number; perSector?: number; trimMinWeight?: number } = {}): KssSignal {
  const L = opts.lookbackMonths ?? KSS_MOMENTUM_LOOKBACK_MONTHS;
  const K = opts.topSectors ?? KSS_TOP_SECTORS;
  const N = opts.perSector ?? KSS_STOCKS_PER_SECTOR;
  const trimMin = opts.trimMinWeight ?? KSS_TRIM_MIN_ACCOUNT_WEIGHT;
  const k200p = buildK200P(input);
  const momentumFrom = monthEndMonthsBefore(input.signalDate, L);
  const momentumTo = monthEndMonthsBefore(input.signalDate, KSS_MOMENTUM_SKIP_MONTHS);

  // 업종 모멘텀(업종 내 유효 종목의 시작 월말 시총 가중 수익률)
  const agg = new Map<string, { w: number; wr: number; n: number }>();
  for (const { code } of k200p) {
    const g = sectorOf(input.induty.get(code));
    const s = input.series.get(code)!;
    const a = lastIndexLe(s.dates, momentumFrom), b = lastIndexLe(s.dates, momentumTo);
    if (!g || a < 0 || b < 0 || !(s.close[a] > 0) || !(s.close[b] > 0) || !(s.mcapEok[a] > 0)) continue;
    const e = agg.get(g) ?? { w: 0, wr: 0, n: 0 };
    e.w += s.mcapEok[a];
    e.wr += s.mcapEok[a] * (s.close[b] / s.close[a] - 1);
    e.n++;
    agg.set(g, e);
  }
  const sectorRanks: KssSectorRank[] = [...agg]
    .filter(([, e]) => e.n >= KSS_MIN_SECTOR_STOCKS)
    .map(([sector, e]) => ({ sector, validCount: e.n, momentum: e.wr / e.w }))
    .sort((x, y) => y.momentum - x.momentum || (x.sector < y.sector ? -1 : 1));
  const neutral = sectorRanks.length === 0;
  const topSectors = sectorRanks.slice(0, Math.min(K, sectorRanks.length)).map((r) => r.sector);
  const top = new Set(topSectors);

  // 위성: 상위 업종마다 K200P 시총 상위 N종목(K200P는 시총 내림차순), 신호일 시총 가중. 중립이면 K200P 전체.
  const cnt = new Map<string, number>();
  const members: { code: string; sector: string; mcap: number }[] = [];
  for (const x of k200p) {
    const g = sectorOf(input.induty.get(x.code)) ?? "";
    if (!neutral) {
      if (!top.has(g)) continue;
      const c = cnt.get(g) ?? 0;
      if (c >= N) continue;
      cnt.set(g, c + 1);
    }
    if (x.mcap > 0) members.push({ code: x.code, sector: g, mcap: x.mcap });
  }
  const tot = members.reduce((acc, x) => acc + x.mcap, 0);
  const preTrimHoldings = members.map((x) => ({ code: x.code, sector: x.sector, weight: x.mcap / tot }));

  // 정리: 계좌 전체 비중(0.2 × 위성 내 비중) < 1% 제외 후 재분배, 남는 게 없으면 069500 대체
  const keep = preTrimHoldings.filter((h) => h.weight * KSS_SATELLITE_WEIGHT >= trimMin);
  const keepTot = keep.reduce((acc, h) => acc + h.weight, 0);
  const holdings = keep.map((h) => ({ ...h, weight: h.weight / keepTot }));
  return { signalDate: input.signalDate, momentumFrom, momentumTo, k200pCount: k200p.length, sectorRanks, topSectors, preTrimHoldings, holdings, fallbackToEtf: holdings.length === 0, neutral };
}

// ---------------- 실제 계좌(정수 주) 리밸런싱 — v3.2 B 규칙 ----------------

export interface KssAccount {
  cash: number;
  etfShares: number;
  /** 종목별 보유 주수(조정 이벤트 뒤에는 소수일 수 있음). */
  holdings: Map<string, number>;
}

export interface KssRebalanceResult {
  account: KssAccount;
  valueBefore: number;
  valueAfter: number;
  satelliteValue: number;
  capHit: boolean;
  /** 위성 목표 종목이 있는데 리밸런싱 후 위성 주수가 모두 0. */
  zeroSatellite: boolean;
}

const roundHalfUp = (x: number): number => Math.floor(x + 0.5);
const etfBuyMult = (1 + KSS_ETF_SLIPPAGE) * (1 + FEE_PCT_PER_SIDE);
const etfSellMult = (1 - KSS_ETF_SLIPPAGE) * (1 - FEE_PCT_PER_SIDE);

/**
 * 리밸런싱일 종가(원 종가)로 계좌를 목표에 맞춘다. 연구 v3.2 B와 같은 순서:
 * 목표 주수 = round_half_up(평가액 × 0.2 × 위성 내 비중 ÷ 종가) → 위성 합계 > 30%면 비싼 종목부터 돌며 1주씩 축소 →
 * (1) 초과분·목표 밖 종목·소수 주 매도 (2) 위성 부족분 매수(현금 부족 시 069500 정수 주 매도, 그래도 부족하면 비싼 종목부터 1주씩 축소)
 * (3) 남은 현금으로 069500 정수 주 매수. prices에는 069500과 보유 종목의 원 종가(그날 행이 없으면 직전 종가)가 있어야 한다.
 */
export function rebalanceKssAccount(
  account: KssAccount,
  satellite: { code: string; weight: number }[],
  prices: { etf: number; stocks: Map<string, number> },
  tradeDate: string
): KssRebalanceResult {
  let cash = account.cash, E = account.etfShares;
  const hold = new Map(account.holdings);
  const pE = prices.etf;
  const px = (code: string): number => {
    const p = prices.stocks.get(code);
    if (!(p !== undefined && p > 0)) throw new Error(`${code}의 ${tradeDate} 종가가 없습니다.`);
    return p;
  };
  const buyMult = computeEffectiveBuyPrice(1), sellMult = computeEffectiveSellPrice(1, tradeDate, "KR");
  let V = cash + E * pE;
  for (const [code, n] of hold) V += n * px(code);
  const valueBefore = V;

  const tgt = new Map<string, { n: number; px: number }>();
  // 연구와 같이 가격이 없는 목표 종목은 건너뛴다(그 몫은 069500으로 간다).
  for (const { code, weight } of satellite) { const p = prices.stocks.get(code); if (p !== undefined && p > 0) tgt.set(code, { n: roundHalfUp((V * KSS_SATELLITE_WEIGHT * weight) / p), px: p }); }
  let satVal = [...tgt.values()].reduce((a, x) => a + x.n * x.px, 0);
  let capHit = false;
  if (satVal > KSS_SATELLITE_CAP * V) {
    capHit = true;
    const order = [...tgt.values()].sort((a, b) => b.px - a.px);
    for (let i = 0; satVal > KSS_SATELLITE_CAP * V; i = (i + 1) % order.length) { const x = order[i]; if (x.n > 0) { x.n--; satVal -= x.px; } }
  }
  // (1) 매도
  for (const [code, n] of [...hold]) {
    const p = px(code), want = tgt.get(code)?.n ?? 0;
    const sellQ = n > want ? n - want : n - Math.floor(n);
    let left = n;
    if (sellQ > 1e-9) { cash += sellQ * p * sellMult; left = n - sellQ; }
    if (left <= 1e-9) hold.delete(code); else hold.set(code, left);
  }
  // (2) 위성 매수
  const need = [...tgt].map(([code, x]) => ({ code, px: x.px, q: Math.max(0, x.n - Math.round(hold.get(code) ?? 0)) }));
  let cost = need.reduce((a, x) => a + x.q * x.px * buyMult, 0);
  if (cost > cash && E > 0) { const kq = Math.min(E, Math.ceil((cost - cash) / (pE * etfSellMult))); cash += kq * pE * etfSellMult; E -= kq; }
  if (cost > cash) {
    const order = [...need].sort((a, b) => b.px - a.px);
    for (let i = 0; cost > cash; i = (i + 1) % order.length) { const x = order[i]; if (x.q > 0) { x.q--; cost -= x.px * buyMult; } else if (order.every((y) => y.q === 0)) break; }
  }
  for (const x of need) {
    if (x.q <= 0) continue;
    cash -= x.q * x.px * buyMult;
    hold.set(x.code, (hold.get(x.code) ?? 0) + x.q);
  }
  // (3) 069500
  if (pE > 0) { const m = Math.floor(cash / (pE * etfBuyMult)); if (m > 0) { E += m; cash -= m * pE * etfBuyMult; } }
  let satelliteValue = 0;
  for (const [code, n] of hold) satelliteValue += n * px(code);
  const valueAfter = cash + E * pE + satelliteValue;
  return { account: { cash, etfShares: E, holdings: hold }, valueBefore, valueAfter, satelliteValue, capHit, zeroSatellite: satellite.length > 0 && hold.size === 0 };
}

/** 보유 주수에 (fromExclusive, toInclusive] 사이 분할·병합 이벤트를 반영한다(연구 B: 주수 ÷ 계수). */
export function applyKssShareAdjustments(
  holdings: Map<string, number>,
  adjustments: Map<string, { eventDate: string; factor: number }[]>,
  fromExclusive: string,
  toInclusive: string
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [code, n] of holdings) {
    let m = n;
    for (const e of adjustments.get(code) ?? []) if (e.eventDate > fromExclusive && e.eventDate <= toInclusive) m /= e.factor;
    out.set(code, m);
  }
  return out;
}

/**
 * 시장 국면 일별 행 계산 조립(순수): 종목 시세 묶음(PriceBook) + KOSPI 지수 + 날짜별 구성 종목 → market_regime_daily 행.
 * 일일 배치(scripts/market-regime.ts)와 이력 백필(scripts/backfill-market-regime.ts)이 같은 함수를 쓴다 —
 * 두 경로의 차이는 날짜별 구성 종목(membersOn)을 어디서 얻느냐뿐이다.
 */
import {
  breadthOn, classifyRaw, computeIndexMetrics, nextRegime, type IndexedStock, type IndexPoint, type MemberCandidate, type Regime,
} from "@/lib/marketRegime";
import { REGIME_CONFIRM_DAYS } from "@/lib/marketRegimeConfig";

export interface BookStock extends IndexedStock {
  /** 시가총액(억 원), 행 단위. */
  mcap: Float64Array;
  /** 직전 20개 행(당일 제외) 평균 거래대금(원), 부족하면 NaN. */
  avgTv: Float64Array;
}
/** 조정 종가 기준 종목 시세 묶음. 키는 종목코드. */
export type PriceBook = Map<string, BookStock>;

export type RegimeSource = "backfill" | "daily";
export interface RegimeRow {
  tradeDate: string; regime: Regime; rawRegime: Regime; kospiClose: number;
  ma50: number | null; ma200: number | null; b50: number | null; b200: number | null; nh: number | null;
  drawdown: number | null; vol20: number | null; volPctile: number | null;
  memberCount: number; source: RegimeSource;
}

/** date에 가격 행이 있는 종목의 구성 후보 정보. isKospi·excluded는 호출자가 경로에 맞게 판정한다. */
export function candidatesOn(book: PriceBook, date: string, isKospi: (code: string) => boolean, isExcluded: (code: string) => boolean): MemberCandidate[] {
  const out: MemberCandidate[] = [];
  for (const [code, s] of book) {
    const i = s.idx.get(date);
    if (i === undefined) continue;
    out.push({ code, mcapEok: s.mcap[i], avgTradingValueWon: s.avgTv[i], isKospi: isKospi(code), excluded: isExcluded(code) });
  }
  return out;
}

export interface ComputeArgs {
  /** 지수 종가(날짜 오름차순). 200일선·252일 고점·변동성 백분위에 필요한 과거를 포함해야 한다. */
  index: IndexPoint[];
  book: PriceBook;
  /** 계산할 거래일(오름차순). 각 날짜가 index에도 있어야 한다. */
  dates: string[];
  membersOn: (date: string) => string[];
  /** 직전 국면과 그 전 신호들(오래된 것 먼저, 최대 days-1개) — 일일 배치가 이어서 계산할 때 쓴다. */
  seed?: { prevRegime: Regime | null; prevRaws: Regime[] };
  source: RegimeSource;
  confirmDays?: number;
}

export function computeRegimeRows(a: ComputeArgs): RegimeRow[] {
  const days = a.confirmDays ?? REGIME_CONFIRM_DAYS;
  const metrics = new Map(computeIndexMetrics(a.index).map((m) => [m.date, m]));
  const rows: RegimeRow[] = [];
  let prev: Regime | null = a.seed?.prevRegime ?? null;
  const raws: Regime[] = [...(a.seed?.prevRaws ?? [])];
  for (const date of a.dates) {
    const m = metrics.get(date);
    if (!m) throw new Error(`${date} KOSPI 지수 종가가 없습니다.`);
    const members = a.membersOn(date);
    const b = breadthOn(a.book, members, date);
    const raw = classifyRaw({ close: m.close, ma200: m.ma200, b50: b.b50, nh: b.nh, drawdownPct: m.drawdownPct });
    raws.push(raw);
    const regime = nextRegime(prev, raws.slice(-days), days);
    prev = regime;
    rows.push({
      tradeDate: date, regime, rawRegime: raw, kospiClose: m.close, ma50: m.ma50, ma200: m.ma200, b50: b.b50, b200: b.b200, nh: b.nh,
      drawdown: m.drawdownPct, vol20: m.vol20, volPctile: m.volPctile, memberCount: b.members, source: a.source,
    });
  }
  return rows;
}

/** dates 중 종목 시세가 한 건도 없는 날짜(Parquet에 아직 안 들어온 날). */
export function datesMissingFromBook(book: PriceBook, dates: string[]): string[] {
  const present = new Set<string>();
  for (const s of book.values()) for (const d of s.dates) present.add(d);
  return dates.filter((d) => !present.has(d));
}

/** 계산 대상 날짜를 "앞에서부터 시세가 있는 날"(available)과 시세가 없는 날(missing)로 나눈다. 첫 번째 빈 날 뒤의 날짜는 이어 계산할 수 없어 available에서 뺀다. */
export function splitByParquetAvailability(book: PriceBook, dates: string[]): { available: string[]; missing: string[] } {
  const missing = datesMissingFromBook(book, dates);
  const first = missing.length ? dates.indexOf(missing[0]) : dates.length;
  return { available: dates.slice(0, first), missing };
}

/**
 * 이력 백필의 마지막 날(포함): 시세 자료의 마지막 날과, 일일 행이 처음 생긴 날의 전날 중 이른 날.
 * 일일 행이 이미 있으면 그 날부터는 일일 배치의 값을 덮어쓰지 않도록 백필이 그 앞에서 멈춘다.
 */
export function backfillEndDate(lastDataDate: string, firstDailyDate: string | null): string {
  if (!firstDailyDate) return lastDataDate;
  const dayBefore = new Date(Date.parse(`${firstDailyDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return dayBefore < lastDataDate ? dayBefore : lastDataDate;
}

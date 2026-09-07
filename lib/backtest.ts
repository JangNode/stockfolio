import { computeSMA } from "@/lib/sma";
import {
  pickFundamentalsAsOf,
  pickDividendsPaidAsOf,
  computeValuationFromSeries,
  type FundamentalsSeries,
  type StockDividendPayment,
} from "@/lib/pointInTimeFundamentals";
import { DH_MIN_MARKET_CAP_EOK, DH_MAX_PER, DH_MAX_PBR, DH_MIN_CONSECUTIVE_DIVIDEND_YEARS } from "@/lib/dhStrategyConfig";
import {
  selectEpsCagrFiscalYears,
  computeEpsCagrFromResolvedShares,
  computeEpsCagrPure,
  computePeg,
  type ListedSharesByFiscalYear,
} from "@/lib/pegRatio";
import { PEG_MAX_RATIO } from "@/lib/pegConfig";
import { computeReversalBreakoutStates } from "@/lib/reversalBreakout";
import { REVERSAL_BREAKOUT_V2_MIN_INVERSE_RATIO } from "@/lib/reversalBreakoutConfig";

// lib/kis.ts(server-only)의 DailyPrice를 import하지 않고 형태만 맞춰 로컬에 둔다.
// /api/stock/[code]/history가 내려주는 JSON 응답과 동일한 모양이다. marketCapEok/
// listedShares는 KIS 일봉엔 없는 값이라 선택 필드다 — lib/stockDailyPricesStorage.ts
// 기반으로 구성한 시리즈(dh_value_dividend 등)에만 채워진다. 이 파일이 클라이언트
// 컴포넌트(components/Backtest.tsx)에서도 쓰이기 때문에 lib/pointInTimeFundamentals.ts
// (server-only 아님, 순수 함수만)에서만 값을 import한다 — lib/stockFundamentals.ts를
// 직접 import하면 그 파일의 "server-only" 표시 때문에 클라이언트 번들 빌드가 깨진다.
export interface DailyPrice {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  marketCapEok?: number;
  listedShares?: number;
}

export interface MaCrossParams {
  short_period: number;
  long_period: number;
  // 매매 추적용 손절/익절 비율(0~1). 지정하지 않으면 기본값(7%/20%)을 쓴다.
  stop_loss_pct?: number;
  take_profit_pct?: number;
}

export interface MinerviniParams {
  ma_short: number;
  ma_mid: number;
  ma_long: number;
  stop_loss_pct?: number;
  take_profit_pct?: number;
}

/** 커스텀 백테스트 펀더멘털 조건의 비교 연산자. */
export type FundamentalConditionComparator = "gte" | "lte" | "gt" | "lt";

/** 펀더멘털 조건 하나(비교 연산자 + 값). 기준값을 상수로 고정하는 DH전략/PEG전략과
 * 달리, 커스텀 백테스트는 사용자가 화면에서 직접 값을 입력하므로 값 자체를
 * rule_params에 담는다. */
export interface FundamentalCondition {
  comparator: FundamentalConditionComparator;
  value: number;
}

/** custom_composite에 추가할 수 있는 펀더멘털 조건 카테고리. 지정된 항목끼리만 모두
 * 만족해야 하고(다른 카테고리와 동일하게 AND), 값 계산은 전부 lib/pointInTimeFundamentals.ts/
 * lib/pegRatio.ts의 point-in-time 순수 함수를 재사용한다(새 판정 로직을 만들지 않는다). */
export interface CustomFundamentalConditions {
  market_cap_eok?: FundamentalCondition;
  per?: FundamentalCondition;
  pbr?: FundamentalCondition;
  peg?: FundamentalCondition;
  consecutive_dividend_years?: FundamentalCondition;
  dividend_yield_pct?: FundamentalCondition;
}

/**
 * 사용자가 직접 고른 조건들을 AND로 조합하는 커스텀 전략. 각 필드는 선택 사항이며,
 * 지정된 필드끼리만 모두 만족해야 참으로 판정한다(최소 1개 이상 지정돼야 의미가 있다 —
 * 검증은 이 값을 만드는 쪽(스키마/UI)의 책임이다).
 */
export interface CustomCompositeParams {
  // 골든크로스 상태: 단기 이평선이 장기 이평선 위에 있는 동안 참(교차 "순간"이 아니라
  // 상태 조건으로 다뤄야 다른 조건과 매일 AND로 조합할 수 있다).
  ma_cross?: { short_period: number; long_period: number };
  rsi?: { period: number; threshold: number; direction: "above" | "below" };
  // 당일 거래량이 최근 period일 평균 거래량의 multiplier배 이상이면 참.
  volume_surge?: { period: number; multiplier: number };
  // 시가총액/PER/PBR/PEG/배당 연속 지급 연수/배당수익률 조건(선택). market="US" 요청은
  // 스키마 단계(lib/customBacktestRequest.ts)에서부터 거부한다 — DART/KRX 재무 데이터는
  // 국내 상장사만 다루기 때문이다.
  fundamentals?: CustomFundamentalConditions;
  stop_loss_pct?: number;
  take_profit_pct?: number;
}

/**
 * DH전략(대형 배당·가치주). 기준값(시가총액/PER/PBR/배당 연속연수)은 lib/dhStrategyConfig.ts
 * 상수로 고정돼 있어 rule_params엔 다른 전략과 공통인 손절/익절만 남는다 — 종목마다
 * 다른 이동평균 기간 같은 개인화 여지가 없는 전략이라, ma_cross/minervini처럼
 * rule_params에 기준값을 담을 이유가 없다(기준값을 바꾸고 싶으면 상수만 고치면
 * 전체 계정 공통으로 적용된다).
 */
export interface DhValueDividendParams {
  stop_loss_pct?: number;
  take_profit_pct?: number;
}

/** 피터린치 PEG전략. DH전략과 같은 이유로 기준값(PEG_MAX_RATIO, lib/pegConfig.ts)을
 * rule_params가 아니라 상수로 고정한다. */
export interface PegLynchParams {
  stop_loss_pct?: number;
  take_profit_pct?: number;
}

/** "급등주 찾기"(역배열 반등) 전략. DH전략/PEG전략과 같은 이유로 기준값(이동평균
 * 기간, 역배열/매집봉/전환 신호 임계값)을 rule_params가 아니라 lib/reversalBreakoutConfig.ts
 * 상수로 고정한다. */
export interface ReversalBreakoutParams {
  stop_loss_pct?: number;
  take_profit_pct?: number;
}

/** rule_type과 rule_params를 항상 짝으로 다루기 위한 판별 유니언. */
export type StrategyRule =
  | { rule_type: "ma_cross"; rule_params: MaCrossParams }
  | { rule_type: "minervini_trend_template"; rule_params: MinerviniParams }
  | { rule_type: "custom_composite"; rule_params: CustomCompositeParams }
  | { rule_type: "dh_value_dividend"; rule_params: DhValueDividendParams }
  | { rule_type: "peg_lynch"; rule_params: PegLynchParams }
  | { rule_type: "reversal_breakout"; rule_params: ReversalBreakoutParams }
  // v1(reversal_breakout)과 나란히 비교하기 위한 실험 전략. 역배열비율 임계값만
  // REVERSAL_BREAKOUT_V2_MIN_INVERSE_RATIO(0.9)로 강화하고 rule_params 형태·나머지
  // 조건은 v1과 동일하다 — ReversalBreakoutParams를 그대로 재사용한다.
  | { rule_type: "reversal_breakout_v2"; rule_params: ReversalBreakoutParams };

export type StrategyRuleType = StrategyRule["rule_type"];

export interface CrossSignal {
  index: number;
  date: string;
  type: "golden" | "dead"; // 조건 진입(golden) / 이탈(dead) — ma_cross 외 전략에도 같은 의미로 재사용
  price: number;
}

/** true/false/undefined(데이터 부족) 상태 배열에서 false→true(golden), true→false(dead) 전환 시점을 찾는다. */
function detectStateTransitions(
  prices: DailyPrice[],
  states: (boolean | undefined)[]
): CrossSignal[] {
  const signals: CrossSignal[] = [];

  for (let i = 1; i < prices.length; i++) {
    const prev = states[i - 1];
    const cur = states[i];
    if (prev === undefined || cur === undefined) continue;

    if (!prev && cur) {
      signals.push({ index: i, date: prices[i].date, type: "golden", price: prices[i].close });
    } else if (prev && !cur) {
      signals.push({ index: i, date: prices[i].date, type: "dead", price: prices[i].close });
    }
  }

  return signals;
}

/**
 * 단기 이평선이 장기 이평선 위에 있는 상태(참)인지 아래에 있는 상태(거짓)인지.
 * 이 상태가 거짓→참으로 바뀌는 순간이 골든크로스, 참→거짓으로 바뀌는 순간이 데드크로스다.
 */
function computeMaCrossStates(
  prices: DailyPrice[],
  params: MaCrossParams
): (boolean | undefined)[] {
  const closes = prices.map((p) => p.close);
  const shortSMA = computeSMA(closes, params.short_period);
  const longSMA = computeSMA(closes, params.long_period);

  return prices.map((_, i) => {
    const s = shortSMA[i];
    const l = longSMA[i];
    if (s === undefined || l === undefined) return undefined;
    return s > l;
  });
}

// 미너비니 원문 그대로 일봉 기준: 52주 신고/신저가 ≈ 250거래일, 장기 이평선 상승 추세
// 확인은 최근 20거래일(약 1개월) 전과 비교한다.
const MINERVINI_HIGH_LOW_WINDOW = 250;
const MINERVINI_TREND_LOOKBACK = 20;

/**
 * 미너비니 트렌드 템플릿(일봉 기준, IBD RS순위 제외 7개 조건). 모두 만족해야 참:
 * 1. 현재가 > 중기·장기 이평선   2. 중기 이평선 > 장기 이평선
 * 3. 장기 이평선이 20거래일 전보다 높음(상승 추세)   4. 단기 이평선 > 중기·장기 이평선
 * 5. 현재가 > 단기 이평선   6. 현재가 ≥ 250거래일 신저가 × 1.3   7. 현재가 ≥ 250거래일 신고가 × 0.75
 */
function computeMinerviniStates(
  prices: DailyPrice[],
  params: MinerviniParams
): (boolean | undefined)[] {
  const { ma_short, ma_mid, ma_long } = params;
  const closes = prices.map((p) => p.close);
  const shortSMA = computeSMA(closes, ma_short);
  const midSMA = computeSMA(closes, ma_mid);
  const longSMA = computeSMA(closes, ma_long);

  // 250거래일 신고/신저가 계산에 필요한 구간과, 장기 이평선의 20거래일 전 값이 존재해야
  // 하는 구간 중 더 늦게 충족되는 인덱스부터 조건 판정이 가능하다.
  const minIndex = Math.max(
    MINERVINI_HIGH_LOW_WINDOW - 1,
    ma_long - 1 + MINERVINI_TREND_LOOKBACK,
    ma_mid - 1,
    ma_short - 1
  );

  return prices.map((_, i) => {
    if (i < minIndex) return undefined;

    const price = closes[i];
    const s = shortSMA[i];
    const m = midSMA[i];
    const l = longSMA[i];
    const lPrev = longSMA[i - MINERVINI_TREND_LOOKBACK];
    if (s === undefined || m === undefined || l === undefined || lPrev === undefined) {
      return undefined;
    }

    let high250 = -Infinity;
    let low250 = Infinity;
    for (let j = i - MINERVINI_HIGH_LOW_WINDOW + 1; j <= i; j++) {
      if (prices[j].high > high250) high250 = prices[j].high;
      if (prices[j].low < low250) low250 = prices[j].low;
    }

    return (
      price > m &&
      price > l &&
      m > l &&
      l > lPrev &&
      s > m &&
      s > l &&
      price > s &&
      price >= low250 * 1.3 &&
      price >= high250 * 0.75
    );
  });
}

/** Wilder's smoothing 방식 RSI(0~100). length - period 이전 인덱스는 undefined. */
export function computeRSI(closes: number[], period: number): (number | undefined)[] {
  const result: (number | undefined)[] = new Array(closes.length).fill(undefined);
  if (closes.length <= period) return result;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gainSum += diff;
    else lossSum += -diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return result;
}

function compareFundamentalCondition(actual: number, condition: FundamentalCondition): boolean {
  switch (condition.comparator) {
    case "gte":
      return actual >= condition.value;
    case "lte":
      return actual <= condition.value;
    case "gt":
      return actual > condition.value;
    case "lt":
      return actual < condition.value;
  }
}

function isoDateDaysAgo(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** asOfDate 기준 최근 완결년도(asOfYear-1)부터 거슬러 올라가며 배당을 지급한 연속
 * 연수를 센다(끊기는 순간 멈춘다). dividends는 이미 point-in-time으로 필터링된 것
 * (pickDividendsPaidAsOf 결과)을 받는다고 가정한다. 커스텀 백테스트의 "배당 연속
 * 지급 연수" 조건 판정에 쓴다 — evaluateConsecutiveDividendYears(고정 임계값 하나만
 * 확인)와 달리 실제 연속 연수를 숫자로 반환해 비교 연산자(gte/lte/gt/lt)와 자유롭게
 * 조합할 수 있게 한다. */
export function computeConsecutiveDividendYearsCount(dividends: StockDividendPayment[], asOfDate: string): number {
  const asOfYear = Number(asOfDate.slice(0, 4));
  const paidYearSet = new Set(dividends.map((d) => Number(d.payDate.slice(0, 4))));

  let count = 0;
  let year = asOfYear - 1;
  while (paidYearSet.has(year)) {
    count++;
    year--;
  }
  return count;
}

/**
 * custom_composite의 "펀더멘털" 조건 카테고리(시가총액/PER/PBR/PEG/배당 연속 지급
 * 연수/배당수익률 중 지정된 항목만 전부 AND로 판정)를 계산한다. 재무 자체가 그
 * 시점까지 공시되지 않았거나(fund가 null) 필요한 시세(marketCapEok/listedShares,
 * DH 가격 레이어에서만 채워짐)가 없으면 undefined(판정 불가) — 적자/역성장 등으로
 * PER·PBR·PEG 계산 자체가 불가능한 경우는 DH전략/PEG전략과 같은 이유로 false(조건
 * 미달)로 구분한다. PER/PBR/PEG를 여러 개 동시에 요청해도 재무 조회는 날짜당 1회만
 * 한다.
 */
function computeCustomFundamentalStates(
  prices: DailyPrice[],
  fc: CustomFundamentalConditions,
  fundamentals: FundamentalsSeries | undefined,
  listedSharesByFiscalYear: ListedSharesByFiscalYear | undefined
): (boolean | undefined)[] {
  if (!fundamentals) return prices.map(() => undefined);

  return prices.map((p) => {
    if (fc.market_cap_eok) {
      if (p.marketCapEok === undefined) return undefined;
      if (!compareFundamentalCondition(p.marketCapEok, fc.market_cap_eok)) return false;
    }

    const needsValuation = fc.per !== undefined || fc.pbr !== undefined || fc.peg !== undefined;
    if (needsValuation) {
      if (p.listedShares === undefined) return undefined;
      const fund = pickFundamentalsAsOf(fundamentals, p.date);
      if (!fund) return undefined; // 그 시점까지 공시된 재무 없음(신규상장 직후 등)

      const { per, pbr } = computeValuationFromSeries(p.close, p.listedShares, fund);

      if (fc.per) {
        if (per === null) return false;
        if (!compareFundamentalCondition(per, fc.per)) return false;
      }
      if (fc.pbr) {
        if (pbr === null) return false;
        if (!compareFundamentalCondition(pbr, fc.pbr)) return false;
      }
      if (fc.peg) {
        if (!listedSharesByFiscalYear) return undefined;
        const growthPct = computeEpsCagrPure(fundamentals, p.date, listedSharesByFiscalYear);
        const peg = computePeg(per, growthPct);
        if (peg === null) return false;
        if (!compareFundamentalCondition(peg, fc.peg)) return false;
      }
    }

    if (fc.consecutive_dividend_years) {
      const dividends = pickDividendsPaidAsOf(fundamentals, p.date);
      const count = computeConsecutiveDividendYearsCount(dividends, p.date);
      if (!compareFundamentalCondition(count, fc.consecutive_dividend_years)) return false;
    }

    if (fc.dividend_yield_pct) {
      const windowStart = isoDateDaysAgo(p.date, 365);
      const dividends = pickDividendsPaidAsOf(fundamentals, p.date, windowStart);
      const total = dividends.reduce((sum, d) => sum + d.cashDividendPerShare, 0);
      const yieldPct = p.close > 0 ? (total / p.close) * 100 : 0;
      if (!compareFundamentalCondition(yieldPct, fc.dividend_yield_pct)) return false;
    }

    return true;
  });
}

/**
 * custom_composite: 지정된 조건들(ma_cross/rsi/volume_surge/fundamentals)을 매일
 * 재평가해 모두 만족하면 참인 상태 조건. 지정되지 않은 조건은 판정에서 제외된다.
 * 조건이 하나도 지정되지 않으면 항상 undefined(데이터 부족과 동일하게 취급 — 매칭
 * 없음). fundamentals/listedSharesByFiscalYear는 rule_params.fundamentals가 지정된
 * 경우에만 쓰인다(dh_value_dividend/peg_lynch와 동일한 인자 — 호출부가 한 번만 로드해
 * 넘긴다).
 */
function computeCustomCompositeStates(
  prices: DailyPrice[],
  params: CustomCompositeParams,
  fundamentals?: FundamentalsSeries,
  listedSharesByFiscalYear?: ListedSharesByFiscalYear
): (boolean | undefined)[] {
  const closes = prices.map((p) => p.close);
  const volumes = prices.map((p) => p.volume);
  const activeStates: (boolean | undefined)[][] = [];

  if (params.ma_cross) {
    const { short_period, long_period } = params.ma_cross;
    const shortSMA = computeSMA(closes, short_period);
    const longSMA = computeSMA(closes, long_period);
    activeStates.push(
      prices.map((_, i) => {
        const s = shortSMA[i];
        const l = longSMA[i];
        if (s === undefined || l === undefined) return undefined;
        return s > l;
      })
    );
  }

  if (params.rsi) {
    const { period, threshold, direction } = params.rsi;
    const rsi = computeRSI(closes, period);
    activeStates.push(
      rsi.map((v) => {
        if (v === undefined) return undefined;
        return direction === "above" ? v >= threshold : v <= threshold;
      })
    );
  }

  if (params.volume_surge) {
    const { period, multiplier } = params.volume_surge;
    const avgVolume = computeSMA(volumes, period);
    activeStates.push(
      prices.map((_, i) => {
        const avg = avgVolume[i];
        if (avg === undefined) return undefined;
        return volumes[i] >= avg * multiplier;
      })
    );
  }

  if (params.fundamentals) {
    activeStates.push(computeCustomFundamentalStates(prices, params.fundamentals, fundamentals, listedSharesByFiscalYear));
  }

  if (activeStates.length === 0) {
    return prices.map(() => undefined);
  }

  return prices.map((_, i) => {
    let allTrue = true;
    for (const state of activeStates) {
      const v = state[i];
      if (v === undefined) return undefined;
      if (!v) allTrue = false;
    }
    return allTrue;
  });
}

/** asOfDate 기준 최근 완결된 years개 연도(asOf 연도 자체는 아직 안 끝났을 수 있어
 * 제외 — asOfYear-years ~ asOfYear-1) 각각 최소 1회 배당을 지급했는지 확인한다.
 * dividends는 이미 point-in-time으로 필터링된 것(pickDividendsPaidAsOf 결과)을
 * 받는다고 가정한다. 지급 확인된 연도 목록(내림차순)도 함께 반환해 판단 근거 로그에
 * 쓸 수 있게 한다. */
export function evaluateConsecutiveDividendYears(
  dividends: StockDividendPayment[],
  asOfDate: string,
  years: number
): { consecutiveOk: boolean; paidYears: number[] } {
  const asOfYear = Number(asOfDate.slice(0, 4));
  const paidYearSet = new Set(dividends.map((d) => Number(d.payDate.slice(0, 4))));

  const requiredYears: number[] = [];
  for (let y = asOfYear - years; y <= asOfYear - 1; y++) requiredYears.push(y);

  const consecutiveOk = requiredYears.every((y) => paidYearSet.has(y));
  const paidYears = requiredYears.filter((y) => paidYearSet.has(y)).sort((a, b) => b - a);

  return { consecutiveOk, paidYears };
}

/**
 * DH전략: 매일 재평가되는 상태 조건. 시가총액/PER/PBR/배당 연속연수 기준을 전부
 * lib/dhStrategyConfig.ts 상수에서 읽는다(값 자체는 나중에 그 파일만 고치면 조정된다).
 * fundamentals가 없으면(호출부가 안 넘겼으면) 전부 undefined(판정 불가)로 취급한다.
 * marketCapEok/listedShares가 없는 날(KIS 기반 시리즈를 잘못 넘긴 경우 등)도 마찬가지다.
 * 조건 미달은 명확히 false로 반환한다(undefined는 "그 시점까지 공시된 재무가 아예
 * 없다"처럼 진짜 판정 불가 상황에만 쓴다) — false/undefined를 섞어 쓰면
 * detectStateTransitions가 데이터 공백을 매도 신호로 착각하지 않는다.
 */
function computeDhValueDividendStates(
  prices: DailyPrice[],
  fundamentals: FundamentalsSeries | undefined
): (boolean | undefined)[] {
  if (!fundamentals) return prices.map(() => undefined);

  return prices.map((p) => {
    if (p.marketCapEok === undefined || p.listedShares === undefined) return undefined;
    if (p.marketCapEok < DH_MIN_MARKET_CAP_EOK) return false;

    const fund = pickFundamentalsAsOf(fundamentals, p.date);
    if (!fund) return undefined; // 그 시점까지 공시된 재무 없음(신규상장 직후 등)

    const { per, pbr } = computeValuationFromSeries(p.close, p.listedShares, fund);
    if (per === null || per <= 0 || per > DH_MAX_PER) return false;
    if (pbr === null || pbr <= 0 || pbr > DH_MAX_PBR) return false;

    const dividends = pickDividendsPaidAsOf(fundamentals, p.date);
    return evaluateConsecutiveDividendYears(dividends, p.date, DH_MIN_CONSECUTIVE_DIVIDEND_YEARS).consecutiveOk;
  });
}

/**
 * 피터린치 PEG전략: 매일 재평가되는 상태 조건. 적자기업은 제외하고(당기순이익 > 0),
 * PEG(=PER÷최근 5년 EPS CAGR)가 PEG_MAX_RATIO(lib/pegConfig.ts) 이하면 참. fundamentals/
 * listedSharesByFiscalYear 중 하나라도 없으면(호출부가 안 넘겼으면) 전부 undefined.
 * "그 시점까지 공시된 재무가 아예 없음"/"5년 전 연도 데이터가 없어 성장률 계산
 * 불가"(상장 초기 등)는 undefined(판정 불가), "적자"/"역성장·PER 계산 불가로 PEG를
 * 못 구함"/"PEG가 기준 초과"는 false(조건 미달)로 구분한다 — DH전략과 같은 이유
 * (computeDhValueDividendStates 코멘트 참고).
 */
function computePegLynchStates(
  prices: DailyPrice[],
  fundamentals: FundamentalsSeries | undefined,
  listedSharesByFiscalYear: ListedSharesByFiscalYear | undefined
): (boolean | undefined)[] {
  if (!fundamentals || !listedSharesByFiscalYear) return prices.map(() => undefined);

  return prices.map((p) => {
    if (p.listedShares === undefined) return undefined;

    const fund = pickFundamentalsAsOf(fundamentals, p.date);
    if (!fund) return undefined; // 그 시점까지 공시된 재무 없음(신규상장 직후 등)
    if (fund.netIncomeParent === null) return undefined; // 순이익 데이터 자체가 없음(공백)
    if (fund.netIncomeParent <= 0) return false; // 적자기업 제외

    const { per } = computeValuationFromSeries(p.close, p.listedShares, fund);

    const pair = selectEpsCagrFiscalYears(fundamentals, p.date);
    if (!pair) return undefined; // 5년 전 연도 데이터가 아예 없음(상장 초기 등) — 판정 불가

    const growthPct = computeEpsCagrFromResolvedShares(pair, listedSharesByFiscalYear);
    const peg = computePeg(per, growthPct);
    if (peg === null) return false; // 역성장/PER 계산 불가 등은 조건 미달로 취급

    return peg <= PEG_MAX_RATIO;
  });
}

/**
 * 전략의 판정 방식.
 * - "event": 교차처럼 순간적으로 발생하는 신호. 오늘 막 발생했는지(직전엔 거짓 → 오늘 참)만 인정.
 * - "state": 미너비니처럼 매일 다시 평가되는 조건. 오늘 조건을 만족하는지만 확인.
 * 새 전략을 추가할 때 여기에 한 줄만 추가하면 matchesToday가 자동으로 맞게 판정한다.
 */
const STRATEGY_KIND: Record<StrategyRuleType, "event" | "state"> = {
  ma_cross: "event",
  minervini_trend_template: "state",
  custom_composite: "state",
  dh_value_dividend: "state",
  peg_lynch: "state",
  reversal_breakout: "state",
  reversal_breakout_v2: "state",
};

/**
 * 전략별 판정 함수 디스패치. 새 전략을 추가하려면:
 * 1) computeXStates(prices, params) 작성 — 봉마다 조건을 만족하는지 true/false/undefined(데이터 부족)로.
 * 2) computeXEntryPrice(prices, ...) 작성 — 신호 발생 시 추천 진입가 (params가 필요 없으면 생략 가능).
 * 3) 위 STRATEGY_KIND에 "event" 또는 "state"로 등록.
 * 4) 아래 computeStates와 computeEntryPlan의 switch에 case 추가.
 * 그 외 matchesToday/runBacktest는 전략 종류와 무관하게 그대로 동작한다.
 *
 * fundamentals는 재무/배당 조건이 필요한 전략(dh_value_dividend, peg_lynch, rule_params에
 * fundamentals가 지정된 custom_composite)만 쓴다 — 순수 가격 기반 전략은 무시한다.
 * 호출부가 lib/stockFundamentals.ts의 loadFundamentalsSeries로 한 번만 로드해 넘기면,
 * pickFundamentalsAsOf/pickDividendsPaidAsOf로 날짜별 point-in-time 판정을 DB 호출
 * 없이 반복한다. listedSharesByFiscalYear는 EPS CAGR(PEG) 계산이 필요한 경우(peg_lynch,
 * fundamentals.peg가 지정된 custom_composite)만 쓴다 — 호출부가
 * loadFundamentalsSeriesWithListedShares로 종목당 한 번만 로드해 넘긴다.
 */
function computeStates(
  prices: DailyPrice[],
  rule: StrategyRule,
  fundamentals?: FundamentalsSeries,
  listedSharesByFiscalYear?: ListedSharesByFiscalYear
): (boolean | undefined)[] {
  switch (rule.rule_type) {
    case "minervini_trend_template":
      return computeMinerviniStates(prices, rule.rule_params);
    case "ma_cross":
      return computeMaCrossStates(prices, rule.rule_params);
    case "custom_composite":
      return computeCustomCompositeStates(prices, rule.rule_params, fundamentals, listedSharesByFiscalYear);
    case "dh_value_dividend":
      return computeDhValueDividendStates(prices, fundamentals);
    case "peg_lynch":
      return computePegLynchStates(prices, fundamentals, listedSharesByFiscalYear);
    case "reversal_breakout":
      return computeReversalBreakoutStates(prices);
    case "reversal_breakout_v2":
      return computeReversalBreakoutStates(prices, REVERSAL_BREAKOUT_V2_MIN_INVERSE_RATIO);
  }
}

export interface BacktestTrade {
  buyDate: string;
  buyPrice: number;
  sellDate: string;
  sellPrice: number;
  returnPct: number;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  totalReturnPct: number;
  tradeCount: number;
  winRate: number;
  mddPct: number;
  insufficientData: boolean;
}

/**
 * 최대 낙폭(MDD, %). buyDate 기준 순서대로 거래를 복리 체결한다고 가정한 자산 곡선에서
 * 고점 대비 최대 하락폭을 구한다. 종목 여러 개의 거래를 합쳐서 넘겨도(전체 종목 풀
 * 백테스트) buyDate로 정렬해 하나의 자산 곡선으로 취급하므로 그대로 재사용할 수 있다.
 */
export function computeMaxDrawdownPct(trades: BacktestTrade[]): number {
  if (trades.length === 0) return 0;

  const sorted = [...trades].sort((a, b) => a.buyDate.localeCompare(b.buyDate));
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;

  for (const trade of sorted) {
    equity *= 1 + trade.returnPct;
    if (equity > peak) peak = equity;
    const drawdown = (peak - equity) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  return maxDrawdown * 100;
}

export interface TradeAggregate {
  totalReturnPct: number;
  tradeCount: number;
  winRate: number;
  mddPct: number;
}

/**
 * 거래 목록의 요약 통계(전체 수익률/거래 수/승률/MDD)를 계산한다. buyDate 순으로 복리
 * 체결한다고 가정한다. runBacktest(단일 종목)와 전체 종목 풀 백테스트(여러 종목의 거래를
 * 하나로 합쳐 같은 방식으로 집계) 양쪽에서 재사용한다.
 */
export function aggregateTrades(trades: BacktestTrade[]): TradeAggregate {
  const tradeCount = trades.length;
  const wins = trades.filter((t) => t.returnPct > 0).length;
  const winRate = tradeCount > 0 ? wins / tradeCount : 0;
  const sorted = [...trades].sort((a, b) => a.buyDate.localeCompare(b.buyDate));
  const totalReturnPct = (sorted.reduce((acc, t) => acc * (1 + t.returnPct), 1) - 1) * 100;
  const mddPct = computeMaxDrawdownPct(trades);

  return { totalReturnPct, tradeCount, winRate, mddPct };
}

/**
 * 조건을 만족하기 시작하는 시점마다 매수, 더 이상 만족하지 않게 되는 시점마다 매도하는
 * 단일 포지션 시뮬레이션. ma_cross는 골든/데드크로스, minervini_trend_template은 7개
 * 조건을 모두 만족/이탈하는 시점이 각각 매수/매도 신호가 된다. 이평선 등은 prices 전체로
 * 계산해 windowStartDate 시점에 이미 안정된 값을 쓰고, windowStartDate 이후에 발생한
 * 신호만 매매에 반영한다. 기간 끝에 매도 신호 없이 포지션이 열려 있으면(미청산) 그
 * 거래는 통계에서 제외한다.
 */
export function runBacktest(
  prices: DailyPrice[],
  rule: StrategyRule,
  windowStartDate: string,
  fundamentals?: FundamentalsSeries,
  listedSharesByFiscalYear?: ListedSharesByFiscalYear
): BacktestResult {
  const states = computeStates(prices, rule, fundamentals, listedSharesByFiscalYear);

  if (states.every((s) => s === undefined)) {
    return { trades: [], totalReturnPct: 0, tradeCount: 0, winRate: 0, mddPct: 0, insufficientData: true };
  }

  const signals = detectStateTransitions(prices, states).filter((s) => s.date >= windowStartDate);

  const trades: BacktestTrade[] = [];
  let openBuy: { date: string; price: number } | null = null;

  for (const signal of signals) {
    if (signal.type === "golden" && !openBuy) {
      openBuy = { date: signal.date, price: signal.price };
    } else if (signal.type === "dead" && openBuy) {
      const returnPct = (signal.price - openBuy.price) / openBuy.price;
      trades.push({
        buyDate: openBuy.date,
        buyPrice: openBuy.price,
        sellDate: signal.date,
        sellPrice: signal.price,
        returnPct,
      });
      openBuy = null;
    }
  }

  return { trades, ...aggregateTrades(trades), insufficientData: false };
}

/**
 * 스크리닝용: 가장 최근 봉이 전략 조건을 만족하는지 확인한다.
 * ma_cross는 "방금 골든크로스가 발생"(직전 봉엔 거짓, 이번 봉에 참)했는지만 인정하고,
 * minervini_trend_template은 매일 재평가되는 상태 조건이므로 이번 봉에 참이면 인정한다.
 */
export function matchesToday(
  prices: DailyPrice[],
  rule: StrategyRule,
  fundamentals?: FundamentalsSeries,
  listedSharesByFiscalYear?: ListedSharesByFiscalYear
): boolean {
  const states = computeStates(prices, rule, fundamentals, listedSharesByFiscalYear);
  const lastState = states[states.length - 1];
  if (lastState === undefined || !lastState) return false;

  if (STRATEGY_KIND[rule.rule_type] === "state") {
    return true;
  }

  const prevState = states[states.length - 2];
  return prevState === false;
}

// 이제 모든 전략이 일봉을 쓰므로, "최근 4주 고점"은 약 20거래일(주 5거래일 × 4주)로 환산한다.
const ENTRY_BREAKOUT_LOOKBACK_BARS = 20;
// scripts/replay-reversal-breakout-closed-results.ts와
// supabase/migrations/20260907000000_fix_reversal_breakout_live_tracking_entry_price.sql이
// rule_params에 손절/익절 비율이 없는 기존 행을 보정할 때 이 값과 정확히 같은 기본값을
// 하드코딩해서 쓴다(마이그레이션은 SQL이라 이 파일을 import할 수 없다) — 이 값을 바꾸면
// 그 두 파일도 함께 확인해야 한다.
export const DEFAULT_STOP_LOSS_PCT = 0.07;
export const DEFAULT_TAKE_PROFIT_PCT = 0.2;

export interface EntryPlan {
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
}

/**
 * ma_cross: 교차 자체가 매수 신호인 이벤트라 "돌파를 기다릴 별도 고점"이 없다. 신호가
 * 발생한 당일 종가(=신호가)를 그대로 진입가로 쓴다. 최근 고점을 쓰면 눌림목 회복 중
 * 교차가 발생했을 때 진입가가 신호가보다 높게 잡혀 "신호는 떴는데 아직 진입가엔
 * 도달 못했다"는 모순이 생긴다.
 */
function computeMaCrossEntryPrice(prices: DailyPrice[]): number {
  return prices[prices.length - 1].close;
}

/**
 * minervini_trend_template: 상태 조건(매일 재평가됨)이라 이미 조건을 만족한 채로 매칭될
 * 수 있다. 최근 20거래일(≈4주) 고점을 VCP 피봇 돌파가로 근사해 그 이상에서 매수하도록 권고한다.
 */
function computeMinerviniEntryPrice(prices: DailyPrice[]): number {
  return Math.max(...prices.slice(-ENTRY_BREAKOUT_LOOKBACK_BARS).map((p) => p.high));
}

/**
 * custom_composite도 minervini와 마찬가지로 상태 조건(이미 조건을 만족한 채로 매칭될 수
 * 있음)이라 같은 방식(최근 20거래일 고점 돌파가)을 진입가로 쓴다.
 */
function computeCustomCompositeEntryPrice(prices: DailyPrice[]): number {
  return Math.max(...prices.slice(-ENTRY_BREAKOUT_LOOKBACK_BARS).map((p) => p.high));
}

/**
 * dh_value_dividend: 가치·배당주 전략이라 돌파 개념이 안 맞는다(추세추종이 아니라
 * "저평가·고배당 상태"를 사는 전략). ma_cross처럼 신호 당일 종가를 그대로 진입가로
 * 쓴다.
 */
function computeDhValueDividendEntryPrice(prices: DailyPrice[]): number {
  return prices[prices.length - 1].close;
}

/** peg_lynch도 dh_value_dividend와 같은 이유(가치주 전략, 돌파 개념 없음)로 신호 당일
 * 종가를 그대로 진입가로 쓴다. */
function computePegLynchEntryPrice(prices: DailyPrice[]): number {
  return prices[prices.length - 1].close;
}

/**
 * reversal_breakout: minervini/custom_composite와 달리 신호 조건 자체(MA20 돌파 시점
 * 포함)가 곧 매수 시점이라 별도로 대기할 피봇가가 필요 없다. 신호일 종가를 그대로
 * 진입가로 쓴다(ma_cross/dh_value_dividend/peg_lynch와 같은 이유).
 * reversal_breakout_v2도 진입가 계산은 임계값과 무관하므로 그대로 재사용한다.
 */
function computeReversalBreakoutEntryPrice(prices: DailyPrice[]): number {
  return prices[prices.length - 1].close;
}

/**
 * 신호가 발생한 시점의 진입/손절/익절가를 계산한다. 손절가/익절가는 rule_params의
 * stop_loss_pct/take_profit_pct(기본 7%/20%)를 진입가 위에 적용한다. 진입가 자체는
 * 전략마다 성격이 달라 computeXEntryPrice로 분리돼 있다 (위 computeStates 디스패치와
 * 동일한 방식 — 새 전략을 추가하면 여기 switch에도 case를 추가한다).
 */
export function computeEntryPlan(prices: DailyPrice[], rule: StrategyRule): EntryPlan {
  const stopLossPct = rule.rule_params.stop_loss_pct ?? DEFAULT_STOP_LOSS_PCT;
  const takeProfitPct = rule.rule_params.take_profit_pct ?? DEFAULT_TAKE_PROFIT_PCT;

  let entryPrice: number;
  switch (rule.rule_type) {
    case "minervini_trend_template":
      entryPrice = computeMinerviniEntryPrice(prices);
      break;
    case "ma_cross":
      entryPrice = computeMaCrossEntryPrice(prices);
      break;
    case "custom_composite":
      entryPrice = computeCustomCompositeEntryPrice(prices);
      break;
    case "dh_value_dividend":
      entryPrice = computeDhValueDividendEntryPrice(prices);
      break;
    case "peg_lynch":
      entryPrice = computePegLynchEntryPrice(prices);
      break;
    case "reversal_breakout":
    case "reversal_breakout_v2":
      entryPrice = computeReversalBreakoutEntryPrice(prices);
      break;
  }

  return {
    entryPrice,
    stopLossPrice: entryPrice * (1 - stopLossPct),
    takeProfitPrice: entryPrice * (1 + takeProfitPct),
  };
}

export type TrackingStatus = "active" | "stopped" | "profited";

/** 현재가가 손절가 이하면 stopped, 익절가 이상이면 profited, 그 사이면 active. */
export function evaluateTrackingStatus(
  currentPrice: number,
  stopLossPrice: number,
  takeProfitPrice: number
): TrackingStatus {
  if (currentPrice <= stopLossPrice) return "stopped";
  if (currentPrice >= takeProfitPrice) return "profited";
  return "active";
}

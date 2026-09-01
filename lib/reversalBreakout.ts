import { computeSMA } from "@/lib/sma";
import {
  REVERSAL_BREAKOUT_MA_PERIODS,
  REVERSAL_HISTORY_LOOKBACK_DAYS,
  REVERSAL_MIN_INVERSE_RATIO,
  ACCUMULATION_LOOKBACK_DAYS,
  ACCUMULATION_VOLUME_MULTIPLIER,
  BREAKOUT_LOOKBACK_DAYS,
} from "@/lib/reversalBreakoutConfig";

/**
 * lib/backtest.ts의 DailyPrice와 순환 참조를 피하기 위해(그 파일이 이 파일의 합성
 * 함수를 가져다 쓴다) 필요한 필드만 로컬로 정의한다 — backtest.ts가 lib/kis.ts의
 * DailyPrice를 그대로 안 쓰고 로컬에 형태만 맞춰 두는 것과 같은 이유다. backtest.ts의
 * DailyPrice를 그대로 넘겨도 구조적으로 호환된다(초과 필드는 문제되지 않는다).
 */
export interface DailyPriceLike {
  date: string;
  open: number;
  close: number;
  volume: number;
}

export interface InverseAlignmentResult {
  /** 유효 일수 중 역배열(오름차순) 정렬이었던 날의 비율(0~1). 유효 일수가 0이면 0. */
  ratio: number;
  /** 5개 이동평균을 전부 계산할 수 있었던(데이터가 충분했던) 날의 수(분모). */
  validDays: number;
}

/**
 * index일 기준 최근 REVERSAL_HISTORY_LOOKBACK_DAYS일 중, smaByPeriod(5개 이동평균,
 * REVERSAL_BREAKOUT_MA_PERIODS와 같은 순서)가 전부 오름차순(단기<장기, 즉
 * MA20<MA60<MA112<MA244<MA448)으로 정렬돼 있던 날의 비율을 계산한다. 이동평균을 계산
 * 못하는(데이터 부족) 날은 분모(validDays)에서 제외한다.
 */
export function computeInverseAlignmentRatio(
  smaByPeriod: (number | undefined)[][],
  index: number
): InverseAlignmentResult {
  const start = Math.max(0, index - REVERSAL_HISTORY_LOOKBACK_DAYS + 1);
  let validDays = 0;
  let alignedDays = 0;

  for (let i = start; i <= index; i++) {
    const values: number[] = [];
    let hasAll = true;
    for (const sma of smaByPeriod) {
      const v = sma[i];
      if (v === undefined) {
        hasAll = false;
        break;
      }
      values.push(v);
    }
    if (!hasAll) continue;
    validDays++;

    let aligned = true;
    for (let k = 1; k < values.length; k++) {
      if (!(values[k - 1] < values[k])) {
        aligned = false;
        break;
      }
    }
    if (aligned) alignedDays++;
  }

  return { ratio: validDays > 0 ? alignedDays / validDays : 0, validDays };
}

/** volumes[i]일 "직전" ACCUMULATION_LOOKBACK_DAYS일 평균 거래량(당일 제외)을 계산한다.
 * computeSMA(volumes, M)을 하루 밀어서(prevAvgVolume[i] = smaVolume[i-1]) 만든다 — 매집봉
 * 당일의 거대한 거래량이 그날의 "직전 평균"에 섞여 평균 자체를 왜곡하지 않게 한다.
 * scripts/diagnose-reversal-breakout-backtest.ts(단계별 통과 종목 수 집계용 진단 스크립트,
 * 확인 후 삭제 예정)가 findAccumulationBar 호출에 필요한 prevAvgVolume을 재구현하지
 * 않고 그대로 재사용할 수 있도록 export한다. */
export function computePrevAverageVolume(volumes: number[]): (number | undefined)[] {
  const sma = computeSMA(volumes, ACCUMULATION_LOOKBACK_DAYS);
  const shifted: (number | undefined)[] = new Array(volumes.length).fill(undefined);
  for (let i = 1; i < volumes.length; i++) shifted[i] = sma[i - 1];
  return shifted;
}

export interface AccumulationBarResult {
  index: number;
  date: string;
  /** 그날 거래량 ÷ 그날 직전 평균 거래량. */
  volumeMultiple: number;
}

/**
 * index일 기준 최근 ACCUMULATION_LOOKBACK_DAYS일 내에서, 거래량이 그 날의 "직전" 평균
 * (prevAvgVolume, 당일 제외) 대비 ACCUMULATION_VOLUME_MULTIPLIER배 이상이면서
 * 종가>시가(양봉)인 가장 최근 날짜를 찾는다. 없으면 null.
 */
export function findAccumulationBar(
  prices: DailyPriceLike[],
  prevAvgVolume: (number | undefined)[],
  index: number
): AccumulationBarResult | null {
  const start = Math.max(0, index - ACCUMULATION_LOOKBACK_DAYS + 1);

  for (let i = index; i >= start; i--) {
    const avg = prevAvgVolume[i];
    if (avg === undefined || avg <= 0) continue;

    const isBullish = prices[i].close > prices[i].open;
    const volumeMultiple = prices[i].volume / avg;
    if (isBullish && volumeMultiple >= ACCUMULATION_VOLUME_MULTIPLIER) {
      return { index: i, date: prices[i].date, volumeMultiple };
    }
  }

  return null;
}

export interface BreakoutFreshnessResult {
  startIndex: number;
  startDate: string;
  /** 오늘(index) - 시작일 기준 경과 일수. 0이면 오늘 막 돌파. */
  daysSinceStart: number;
}

/**
 * index일 기준 현재가가 breakoutSma(MA20) 위인 상태가 연속으로 이어져 온 시작일을
 * 찾는다. index일에 현재가가 MA20 위가 아니면(=전환 상태가 아니면) null.
 */
export function computeBreakoutFreshness(
  prices: DailyPriceLike[],
  breakoutSma: (number | undefined)[],
  index: number
): BreakoutFreshnessResult | null {
  const ma = breakoutSma[index];
  if (ma === undefined || prices[index].close <= ma) return null;

  let start = index;
  while (start > 0) {
    const prevMa = breakoutSma[start - 1];
    if (prevMa === undefined || prices[start - 1].close <= prevMa) break;
    start--;
  }

  return { startIndex: start, startDate: prices[start].date, daysSinceStart: index - start };
}

/**
 * "급등주 찾기"(역배열 반등) 하루 단위 상태 판정(lib/backtest.ts의 computeStates
 * 디스패치용). "역배열 이력 → 매집봉 → 전환 신호" 3단계를 모두 계산할 수 있고 모두
 * 만족하면 true, 계산 자체가 불가능하면(가장 긴 이동평균(448일)조차 구할 데이터가
 * 없는 초반 구간) undefined, 계산은 되는데 조건을 만족하지 않으면 false를 반환한다.
 * 역배열 비율 계산에 필요한 데이터(최장 448일 이평선)가 있으면 매집봉/전환 신호
 * 계산에 필요한 데이터(각각 20일 안팎)는 항상 더 먼저 갖춰지므로, "계산 불가" 여부는
 * 역배열 비율의 유효 일수(validDays)만으로 판단해도 충분하다.
 */
export function computeReversalBreakoutStates(prices: DailyPriceLike[]): (boolean | undefined)[] {
  const closes = prices.map((p) => p.close);
  const volumes = prices.map((p) => p.volume);

  const smaByPeriod = REVERSAL_BREAKOUT_MA_PERIODS.map((period) => computeSMA(closes, period));
  // BREAKOUT_MA_PERIOD는 REVERSAL_BREAKOUT_MA_PERIODS[0]과 같다(reversalBreakoutConfig.ts
  // 주석 참고) — 그래서 smaByPeriod[0]을 그대로 전환 신호 판정에 쓴다.
  const breakoutSma = smaByPeriod[0];
  const prevAvgVolume = computePrevAverageVolume(volumes);

  return prices.map((_, i) => {
    const alignment = computeInverseAlignmentRatio(smaByPeriod, i);
    if (alignment.validDays === 0) return undefined; // 데이터 부족

    const breakout = computeBreakoutFreshness(prices, breakoutSma, i);
    if (!breakout || breakout.daysSinceStart >= BREAKOUT_LOOKBACK_DAYS) return false;

    const accumulation = findAccumulationBar(prices, prevAvgVolume, i);
    if (!accumulation) return false;

    return alignment.ratio >= REVERSAL_MIN_INVERSE_RATIO;
  });
}

export interface ReversalBreakoutSignalDetails {
  inverse_alignment_ratio: number;
  inverse_alignment_valid_days: number;
  accumulation_bar_date: string | null;
  accumulation_volume_multiple: number | null;
  breakout_date: string | null;
  breakout_days_since: number | null;
}

/**
 * 판단 근거 로그(screening_results.signal_details)에 남길 원시 계산값. 실제 매칭 판정
 * (computeReversalBreakoutStates)과 같은 계산 함수(computeInverseAlignmentRatio/
 * findAccumulationBar/computeBreakoutFreshness)를 그대로 재사용한다 — DH전략의
 * buildFundamentalSignalDetails(scripts/screen-all-stocks.ts)와 같은 패턴. 오늘(가장
 * 최근 봉) 기준으로만 계산한다.
 */
export function buildReversalBreakoutSignalDetails(prices: DailyPriceLike[]): ReversalBreakoutSignalDetails {
  const closes = prices.map((p) => p.close);
  const volumes = prices.map((p) => p.volume);
  const index = prices.length - 1;

  const smaByPeriod = REVERSAL_BREAKOUT_MA_PERIODS.map((period) => computeSMA(closes, period));
  const breakoutSma = smaByPeriod[0];
  const prevAvgVolume = computePrevAverageVolume(volumes);

  const alignment = computeInverseAlignmentRatio(smaByPeriod, index);
  const accumulation = findAccumulationBar(prices, prevAvgVolume, index);
  const breakout = computeBreakoutFreshness(prices, breakoutSma, index);

  return {
    inverse_alignment_ratio: alignment.ratio,
    inverse_alignment_valid_days: alignment.validDays,
    accumulation_bar_date: accumulation?.date ?? null,
    accumulation_volume_multiple: accumulation?.volumeMultiple ?? null,
    breakout_date: breakout?.startDate ?? null,
    breakout_days_since: breakout?.daysSinceStart ?? null,
  };
}

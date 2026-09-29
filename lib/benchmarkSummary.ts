import type { DailyPrice } from "@/lib/backtest";
import type { PricePoint } from "@/lib/beta";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";

/**
 * "장기 백테스트" 카드의 벤치마크 비교(코스피/코스닥 지수, 유니버스 동일가중
 * 월간 리밸런싱)를 계산하는 순수 함수 모음.
 * scripts/compute-strategy-backtest-summary.ts가 이 함수들의 결과를
 * benchmark_summary에 저장한다.
 *
 * lib/strategyBacktestSummary.ts의 computeCumulativeAndMdd/computeCagrPct를 그대로
 * 재사용해 전략과 같은 방법론(날짜 단위 복리, 100에서 시작하는 자산곡선)으로
 * 비교 가능하게 만든다 — 이 파일은 각 벤치마크의 "일별 수익률(%) 시계열"만
 * 만들어주고, 그 이후 총수익률/MDD/CAGR 계산은 호출부가
 * lib/strategyBacktestSummary.ts 함수로 이어서 한다.
 */

/** 종가 시리즈(tradeDate 오름차순 가정)에서 종가 대비 종가 일별 수익률(%) 배열을
 * 만든다. computeCumulativeAndMdd/computeCagrPct에 바로 넣을 수 있는 스케일(1=1%)
 * 이다. 코스피/코스닥 지수는 거래비용이 없는 순수 지수라 cost_included: false로
 * 저장한다. */
export function computeIndexDailyReturnsPct(series: PricePoint[]): number[] {
  const returnsPct: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prevClose = series[i - 1].closePrice;
    const close = series[i].closePrice;
    returnsPct.push(((close - prevClose) / prevClose) * 100);
  }
  return returnsPct;
}

/** 칼마 비율(CAGR / |MDD|). mddPct가 0이면(이론상 하한이라 실제로는 발생하지
 * 않지만) 0으로 나누기를 피해 0으로 방어 처리한다. */
export function computeCalmarRatio(cagrPct: number, mddPct: number): number {
  if (mddPct === 0) return 0;
  return cagrPct / Math.abs(mddPct);
}

function sumValues(values: Map<string, number>): number {
  let sum = 0;
  for (const v of values.values()) sum += v;
  return sum;
}

/**
 * 유니버스 동일가중 월간 리밸런싱 벤치마크의 일별 수익률(%) 시계열을 만든다.
 *
 * - point-in-time: 매 리밸런싱마다 "그 날 실제 시세가 있는 종목"만 목표
 *   유니버스로 삼는다. 미래에 상장할 종목을 미리 포함할 수 없고(시세가 아직
 *   없으므로 자동으로 빠짐), 상장폐지된 종목은 그 날짜 이후 시세가 없어 자동으로
 *   빠진다 — 별도의 "미래 정보" 조회 없이 그 시점에 실제로 관찰 가능했던 시세
 *   유무만으로 유니버스가 결정된다.
 * - 생존편향: pricesByStock은 이미 생존편향 보정된 lib/stockDailyPricesStorage.ts의
 *   getDailyPriceSeries에서 온 값(호출부가 전달)이라 상장폐지 종목의 상장폐지
 *   이전 시세도 그대로 포함돼 있다. 상장폐지 이후엔 이 함수가 그 종목을 "동결"
 *   (기여분 0%로 유지)하다가 다음 리밸런싱에서 자동으로 유니버스에서 빠지므로,
 *   상장폐지가 실제로 벤치마크 수익률에 반영된다(생존한 종목만 남기는 사후
 *   선별이 아니다).
 *
 * 거래비용(회전율 기반 매수+매도 비용 드래그)을 매 리밸런싱마다 반영한다 — 5개
 * 전략이 이미 거래비용 반영 CAGR/MDD를 보여주므로, 매달 실제로 매도+매수가
 * 일어나는 이 벤치마크도 비용을 반영해야 공정한 비교가 된다(비용 없이 계산하면
 * 벤치마크만 공짜로 거래하는 셈이 된다).
 *
 * @param pricesByStock 종목코드 → 일별 가격 시계열(전종목, 이미 호출부가 전략
 *   계산에 쓰려고 조회해둔 것을 재사용 — 벤치마크 때문에 다시 조회하지 않는다).
 * @param tradeDateCalendar 실제 KRX 거래일 캘린더로 쓸 날짜 목록(오름차순, 코스피
 *   지수 시리즈의 tradeDate를 그대로 넘긴다).
 * @param periodStartDate 시뮬레이션 시작일(YYYY-MM-DD) — 이 날이 속한 달의 첫
 *   거래일에 최초 매수(전량 리밸런싱)한다.
 */
export function simulateUniverseMonthlyRebalance(
  pricesByStock: Map<string, DailyPrice[]>,
  tradeDateCalendar: string[],
  periodStartDate: string
): number[] {
  const datesInPeriod = tradeDateCalendar.filter((d) => d >= periodStartDate).slice().sort();
  if (datesInPeriod.length === 0) return [];

  // 종목별 date -> closePrice O(1) 조회 맵. 상장폐지 이후엔 이 맵에 해당 날짜가
  // 없으므로, 그 시점부터 "시세 없음"으로 자연스럽게 처리된다.
  const priceMapByStock = new Map<string, Map<string, number>>();
  for (const [code, prices] of pricesByStock) {
    const dateToClose = new Map<string, number>();
    for (const p of prices) dateToClose.set(p.date, p.close);
    priceMapByStock.set(code, dateToClose);
  }

  // 매월 리밸런싱 날짜: 이전 거래일과 연-월이 다른 첫 거래일들 + 기간 시작일이
  // 속한 달의 첫 거래일(최초 매수).
  const rebalanceDates = new Set<string>([datesInPeriod[0]]);
  for (let i = 1; i < datesInPeriod.length; i++) {
    if (datesInPeriod[i].slice(0, 7) !== datesInPeriod[i - 1].slice(0, 7)) {
      rebalanceDates.add(datesInPeriod[i]);
    }
  }

  // 종목코드 → 현재 보유 "가치"(리밸런싱 직후 목표비중으로 초기화되고, 매일
  // 그날 가격변동만큼 곱해져 드리프트된다). 합계가 항상 1은 아니다(드리프트로
  // 리밸런싱 사이에는 포트폴리오 전체 수익률 배수만큼 변한다) — 정규화(값/합계)한
  // 게 "현재 보유 비중"이다. 상장폐지 종목은 시세가 없어 값이 동결된다.
  let values = new Map<string, number>();
  const dailyReturnsPct: number[] = [];

  for (let i = 0; i < datesInPeriod.length; i++) {
    const date = datesInPeriod[i];
    const prevDate = i > 0 ? datesInPeriod[i - 1] : null;

    // 1) 그날의 가격변동을 직전 리밸런싱 이후 드리프트된 보유 가치에 반영한다.
    //    시세가 없는(상장폐지) 종목은 값을 그대로 유지한다(동결 — 기여분 0%).
    const sumBefore = sumValues(values);
    if (prevDate && sumBefore > 0) {
      for (const [code, value] of values) {
        const priceMap = priceMapByStock.get(code);
        const prevClose = priceMap?.get(prevDate);
        const close = priceMap?.get(date);
        if (prevClose !== undefined && close !== undefined) {
          values.set(code, value * (close / prevClose));
        }
      }
    }
    const sumAfter = sumValues(values);
    const dayReturn = sumBefore > 0 ? sumAfter / sumBefore - 1 : 0;

    // 2) 리밸런싱 날짜면 목표 비중(그날 실제 시세가 있는 종목 = point-in-time
    //    유니버스)으로 교체하고, 회전율 기반 비용 드래그를 반영한다.
    let costDrag = 0;
    if (rebalanceDates.has(date)) {
      const universeToday: string[] = [];
      for (const [code, priceMap] of priceMapByStock) {
        if (priceMap.has(date)) universeToday.push(code);
      }

      if (universeToday.length > 0) {
        const currentSum = sumValues(values);
        const currentWeights = new Map<string, number>();
        if (currentSum > 0) {
          for (const [code, value] of values) currentWeights.set(code, value / currentSum);
        }

        const targetWeight = 1 / universeToday.length;
        const targetWeights = new Map<string, number>(universeToday.map((code) => [code, targetWeight]));

        const allCodes = new Set<string>([...currentWeights.keys(), ...targetWeights.keys()]);
        let turnoverSum = 0;
        for (const code of allCodes) {
          turnoverSum += Math.abs((currentWeights.get(code) ?? 0) - (targetWeights.get(code) ?? 0));
        }
        // 현금 잔고도 "종목 하나"처럼 취급해 회전율에 포함한다 — 최초 리밸런싱은
        // 현금 100%에서 종목 100%로 바뀌는 순수 매수라, 종목만 놓고 보면
        // turnoverSum이 1(=현금에서 각 종목으로 나눠 들어간 만큼)에 그쳐 turnover가
        // 0.5로 축소 계산된다(실제로는 전량 매수라 1이어야 함). currentWeights/
        // targetWeights는 둘 다 항상 0 또는 1로 합산되므로(각각 전액 현금 또는
        // 전액 투자), 현금 잔고 = 1 - 종목 비중 합계로 구해 더하면 상시 리밸런싱
        // (현금 유입/유출 없음, 양쪽 다 0)에는 영향을 주지 않고 최초 매수만
        // 올바르게 보정된다.
        const cashBefore = 1 - sumValues(currentWeights);
        const cashTarget = 1 - sumValues(targetWeights);
        turnoverSum += Math.abs(cashBefore - cashTarget);
        const turnover = 0.5 * turnoverSum;

        // computeEffectiveBuyPrice/computeEffectiveSellPrice에 1을 넣어 "1원당
        // 비용 반영 배수"만 뽑아낸다 — 실제 원화 금액이 아니라 회전율에 곱할
        // 비율(매수/매도 각각의 비용률)을 구하는 트릭이다.
        const buyRate = computeEffectiveBuyPrice(1) - 1;
        const sellRate = 1 - computeEffectiveSellPrice(1, date, "KR");
        costDrag = turnover * (buyRate + sellRate);

        values = targetWeights;
      }
    }

    dailyReturnsPct.push(((1 + dayReturn) * (1 - costDrag) - 1) * 100);
  }

  return dailyReturnsPct;
}

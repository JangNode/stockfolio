import type { BacktestTrade, DailyPrice } from "@/lib/backtest";

/**
 * "장기 백테스트(2016~오늘)" 캐시 배치(scripts/compute-strategy-backtest-summary.ts)가
 * 쓰는 순수 계산 함수들. lib/backtest.ts의 aggregateTrades/computeMaxDrawdownPct와는
 * 방법론이 다르다는 점을 반드시 구분해야 한다:
 *
 * - aggregateTrades(거래 단위): 거래별 "매수가→매도가 총수익률"을 buyDate 순으로
 *   복리 체결해 승률/거래수/MDD를 낸다. 하루에 여러 종목이 동시에 거래 중이어도
 *   구분하지 않고 하나의 자산곡선으로 섞는다("100% 몰빵 후 순서대로 갈아탄다"에
 *   가까운 가정).
 * - 이 파일(날짜 단위, 동일가중): 그날 보유 중인 모든 종목의 종가 대비 종가
 *   수익률을 동일가중으로 평균해 "그날의 포트폴리오 수익률"을 만들고, 그 시계열을
 *   복리로 쌓아 총수익률/MDD/CAGR을 낸다("매일 자금을 동일가중으로 분산 투입"에
 *   가까운 가정). 같은 거래 데이터에서 나와도 두 통계가 서로 다른 값이 되는 게
 *   정상이다 — 나중에 헷갈리지 않도록 이 차이를 항상 함께 언급한다.
 *
 * diagnose-strategy-daily-returns.ts(#356)/diagnose-strategy-return-concentration.ts
 * (#358, 둘 다 디스포저블 진단 스크립트 — 정리 PR로 제거될 예정)에서 검증된
 * 로직을 그대로 옮겨 lib 함수로 승격시켰다.
 */

/** 날짜별 종목-수익률 항목. returnPct는 비율 그대로(0.01 = 1%, %가 아니다) — 곱셈
 * 누적(복리) 계산에 바로 쓰기 위해서다. */
export interface StockDateReturn {
  stockCode: string;
  returnPct: number;
}

/** 날짜(YYYY-MM-DD) → 그날 보유 중이던 종목-수익률 목록. accumulateStockDailyReturns가
 * 종목을 하나씩 처리하며 채워나가는 중간 자료구조다. */
export type DailyStockReturns = Map<string, StockDateReturn[]>;

/** 종목별 "자체 복리수익률" 누적 상태 — 그 종목이 보유됐던 모든 날의 수익률을
 * 전부 곱한 배수(예: 1.5면 그 종목만 따로 봤을 때 +50%). rankStockContributions의
 * 입력이다. */
export interface StockContribution {
  stockCode: string;
  multiplier: number;
  tradeCount: number;
}

/**
 * 한 종목의 거래(매수~매도 구간) 목록을 순회하며 dailyReturns/contributions에
 * 기여분을 누적한다(둘 다 호출부가 rule_type별로 하나씩 만들어 여러 종목에 걸쳐
 * 재사용). 매수 다음 거래일부터 매도일까지의 종가 대비 종가 수익률을 매일 하나씩
 * 뽑아 쌓는다 — runBacktest가 이미 windowStartDate 이후 신호만 거래로 만들지만,
 * 종가 변화 자체는 매수일 다음날부터 발생하므로 windowStartDate 이전 날짜가 섞일
 * 수 있어 이 함수에서 한 번 더 걸러낸다.
 */
export function accumulateStockDailyReturns(
  dailyReturns: DailyStockReturns,
  contributions: Map<string, StockContribution>,
  stockCode: string,
  prices: DailyPrice[],
  trades: BacktestTrade[],
  windowStartDate: string
): void {
  if (trades.length === 0) return;

  const dateIndex = new Map(prices.map((p, i) => [p.date, i]));
  const contribution = contributions.get(stockCode) ?? { stockCode, multiplier: 1, tradeCount: 0 };
  contribution.tradeCount += trades.length;

  for (const trade of trades) {
    const buyIdx = dateIndex.get(trade.buyDate);
    const sellIdx = dateIndex.get(trade.sellDate);
    if (buyIdx === undefined || sellIdx === undefined) continue;

    for (let i = buyIdx + 1; i <= sellIdx; i++) {
      const date = prices[i].date;
      if (date < windowStartDate) continue;

      const dailyReturn = (prices[i].close - prices[i - 1].close) / prices[i - 1].close;

      const list = dailyReturns.get(date);
      if (list) list.push({ stockCode, returnPct: dailyReturn });
      else dailyReturns.set(date, [{ stockCode, returnPct: dailyReturn }]);

      contribution.multiplier *= 1 + dailyReturn;
    }
  }

  contributions.set(stockCode, contribution);
}

/**
 * 날짜별 종목-수익률 목록(dailyReturns)을 동일가중 평균한 일별 수익률(%) 시계열로
 * 바꾼다(날짜 오름차순). 그날 보유 중인 종목이 하나도 없으면 0%(현금 보유)로
 * 취급한다. 거래 단위 통계(lib/backtest.ts의 aggregateTrades)와는 다른 방법론이라는
 * 점을 파일 상단 설명과 동일하게 다시 강조한다.
 */
export function computeEqualWeightDailyReturns(dailyReturns: DailyStockReturns): number[] {
  const dates = Array.from(dailyReturns.keys()).sort();
  return dates.map((date) => {
    const entries = dailyReturns.get(date) ?? [];
    if (entries.length === 0) return 0;
    const avg = entries.reduce((sum, e) => sum + e.returnPct, 0) / entries.length;
    return avg * 100;
  });
}

/**
 * 일별 수익률(%) 시계열을 복리로 쌓아 총수익률(%)과 최대낙폭(MDD, %)을 계산한다.
 * 지수를 100에서 시작해 매일 (1 + 수익률/100)을 곱한다 — lib/backtest.ts의
 * computeMaxDrawdownPct(거래 단위 자산곡선)와 달리 날짜 단위 자산곡선을 쓴다는
 * 점이 다르다.
 */
export function computeCumulativeAndMdd(dailyReturnsPct: number[]): { totalReturnPct: number; mddPct: number } {
  let index = 100;
  let peak = 100;
  let maxDrawdownPct = 0;

  for (const r of dailyReturnsPct) {
    index *= 1 + r / 100;
    if (index > peak) peak = index;
    const drawdownPct = ((peak - index) / peak) * 100;
    if (drawdownPct > maxDrawdownPct) maxDrawdownPct = drawdownPct;
  }

  return { totalReturnPct: index - 100, mddPct: maxDrawdownPct };
}

// 그레고리력 평균 연 길이(400년 주기 기준 — 4년마다 윤년 보정 관례). CAGR 연환산에
// 흔히 쓰는 값이다.
const DAYS_PER_YEAR = 365.25;

/**
 * 기간(periodStartDate~periodEndDate, 양 끝 포함) 총수익률(%)을 연평균 성장률
 * (CAGR, %)로 환산한다: ((1 + totalReturnPct/100)^(365.25/기간일수) - 1) * 100.
 * 코드베이스에 기존 CAGR 계산이 없어 이번에 새로 추가하는 로직이다.
 */
export function computeCagrPct(totalReturnPct: number, periodStartDate: string, periodEndDate: string): number {
  const start = new Date(periodStartDate + "T00:00:00Z").getTime();
  const end = new Date(periodEndDate + "T00:00:00Z").getTime();
  const periodDays = (end - start) / (1000 * 60 * 60 * 24);
  if (periodDays <= 0) return 0;

  const totalMultiplier = 1 + totalReturnPct / 100;
  // 원금을 전부(또는 그 이상) 잃은 경우 거듭제곱 밑이 0 이하가 돼 계산이 불가능하다
  // — 이론상 하한인 -100%로 취급한다.
  if (totalMultiplier <= 0) return -100;

  return (Math.pow(totalMultiplier, DAYS_PER_YEAR / periodDays) - 1) * 100;
}

/**
 * 종목별 "자체 복리수익률"((multiplier - 1) * 100) 내림차순으로 정렬한다. 소수
 * 종목 쏠림 확인용 — 한 종목이 여러 번 거래됐으면 그 종목의 모든 거래를 곱해 하나의
 * 자체수익률로 합친다(diagnose-strategy-return-concentration.ts 로직 이동).
 */
export function rankStockContributions(
  contributions: Map<string, StockContribution>
): { stockCode: string; ownReturnPct: number; tradeCount: number }[] {
  return Array.from(contributions.values())
    .map((c) => ({ stockCode: c.stockCode, ownReturnPct: (c.multiplier - 1) * 100, tradeCount: c.tradeCount }))
    .sort((a, b) => b.ownReturnPct - a.ownReturnPct);
}

/**
 * 종목별 자체 복리수익률 상위 topExcludeCount개를 제외한 뒤, 날짜별 동일가중
 * 평균을 다시 계산해 총수익률(%, 연환산하지 않은 기간 전체 수익률)을 반환한다.
 * "몇몇 초대박 종목이 전체 성과를 왜곡하는지" 확인하는 용도
 * (diagnose-strategy-return-concentration.ts 로직 이동) — 호출부가 cagr_pct와
 * 같은 스케일로 비교하려면 이 값을 computeCagrPct로 한 번 더 연환산해야 한다.
 */
export function computeTop5ExcludeReturnPct(
  dailyReturns: DailyStockReturns,
  contributions: Map<string, StockContribution>,
  topExcludeCount: number
): number {
  const ranked = rankStockContributions(contributions);
  const excludeSet = new Set(ranked.slice(0, topExcludeCount).map((r) => r.stockCode));

  const dates = Array.from(dailyReturns.keys()).sort();
  const excludedSeries = dates.map((date) => {
    const entries = (dailyReturns.get(date) ?? []).filter((e) => !excludeSet.has(e.stockCode));
    if (entries.length === 0) return 0;
    return (entries.reduce((sum, e) => sum + e.returnPct, 0) / entries.length) * 100;
  });

  return computeCumulativeAndMdd(excludedSeries).totalReturnPct;
}

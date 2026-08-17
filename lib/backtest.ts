import { computeSMA } from "@/lib/sma";

// lib/kis.ts(server-only)의 DailyPrice를 import하지 않고 형태만 맞춰 로컬에 둔다.
// /api/stock/[code]/history가 내려주는 JSON 응답과 동일한 모양이다.
export interface DailyPrice {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CrossSignal {
  index: number;
  date: string;
  type: "golden" | "dead";
  price: number;
}

/**
 * 단기/장기 이평선의 골든크로스(단기가 장기를 상향 돌파)·데드크로스(하향 돌파) 시점을 찾는다.
 * 장기 이평선은 인덱스 longPeriod - 1부터 존재하지만, 크로스 여부를 판단하려면
 * 그 직전 인덱스의 이평선도 필요하므로 실제로 판단 가능한 첫 인덱스는 longPeriod다.
 */
export function detectCrossoverSignals(
  prices: DailyPrice[],
  shortPeriod: number,
  longPeriod: number
): CrossSignal[] {
  const closes = prices.map((p) => p.close);
  const shortSMA = computeSMA(closes, shortPeriod);
  const longSMA = computeSMA(closes, longPeriod);
  const signals: CrossSignal[] = [];

  for (let i = longPeriod; i < prices.length; i++) {
    const prevShort = shortSMA[i - 1];
    const prevLong = longSMA[i - 1];
    const curShort = shortSMA[i];
    const curLong = longSMA[i];

    if (
      prevShort === undefined ||
      prevLong === undefined ||
      curShort === undefined ||
      curLong === undefined
    ) {
      continue;
    }

    if (prevShort <= prevLong && curShort > curLong) {
      signals.push({ index: i, date: prices[i].date, type: "golden", price: prices[i].close });
    } else if (prevShort >= prevLong && curShort < curLong) {
      signals.push({ index: i, date: prices[i].date, type: "dead", price: prices[i].close });
    }
  }

  return signals;
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
  insufficientData: boolean;
}

/**
 * 골든크로스 시점마다 매수, 데드크로스 시점마다 매도하는 단일 포지션 시뮬레이션.
 * 이평선 자체는 prices 전체로 계산해 windowStartDate 시점에 이미 안정된 값을 쓰고,
 * windowStartDate 이후에 발생한 신호만 매매에 반영한다. 기간 끝에 매도 신호 없이
 * 포지션이 열려 있으면(미청산) 그 거래는 통계에서 제외한다.
 */
export function runBacktest(
  prices: DailyPrice[],
  shortPeriod: number,
  longPeriod: number,
  windowStartDate: string
): BacktestResult {
  if (prices.length <= longPeriod) {
    return { trades: [], totalReturnPct: 0, tradeCount: 0, winRate: 0, insufficientData: true };
  }

  const signals = detectCrossoverSignals(prices, shortPeriod, longPeriod).filter(
    (s) => s.date >= windowStartDate
  );

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

  const tradeCount = trades.length;
  const wins = trades.filter((t) => t.returnPct > 0).length;
  const winRate = tradeCount > 0 ? wins / tradeCount : 0;
  const totalReturnPct =
    (trades.reduce((acc, t) => acc * (1 + t.returnPct), 1) - 1) * 100;

  return { trades, totalReturnPct, tradeCount, winRate, insufficientData: false };
}

/** 스크리닝용: 가장 최근 봉에서 골든크로스가 막 발생했는지 확인한다. */
export function justGoldenCrossed(
  prices: DailyPrice[],
  shortPeriod: number,
  longPeriod: number
): boolean {
  if (prices.length <= longPeriod) return false;

  const signals = detectCrossoverSignals(prices, shortPeriod, longPeriod);
  const last = signals[signals.length - 1];
  return last?.index === prices.length - 1 && last.type === "golden";
}

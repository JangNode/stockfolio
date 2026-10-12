import test from "node:test";
import assert from "node:assert/strict";
import {
  computeAvgTradingValueWon,
  isSignalExitClosed,
  krSignalUniverseRule,
  passesKrSignalUniverse,
  SIGNAL_EXIT_DETAILS,
  SIGNAL_EXIT_REASON,
  statusForSignalExit,
  usesSignalExit,
  withSignalExitReason,
} from "@/lib/screeningSignalRules";
import { PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { MA_CROSS_V3_SIGNAL_DETAILS, MA_CROSS_V2_SIGNAL_DETAILS } from "@/lib/maCrossConfig";
import type { DailyPrice } from "@/lib/backtest";

test("신호 이탈 표식: 표식이 있는 행만 신호 이탈로 닫고, 기존 행(표식 없음/v2/5-20)은 건드리지 않는다", () => {
  assert.equal(usesSignalExit(SIGNAL_EXIT_DETAILS), true);
  assert.equal(usesSignalExit(MA_CROSS_V3_SIGNAL_DETAILS), true);
  assert.equal(usesSignalExit(MA_CROSS_V2_SIGNAL_DETAILS), false);
  assert.equal(usesSignalExit(null), false);
  assert.equal(usesSignalExit({ per: 8, peg: 0.4 }), false);
  assert.equal(usesSignalExit([SIGNAL_EXIT_DETAILS]), false);
});

test("신호 이탈 종료 사유는 signal_details에 합쳐지고 기존 키는 보존된다", () => {
  const merged = withSignalExitReason({ per: 8, ...SIGNAL_EXIT_DETAILS });
  assert.equal(merged.per, 8);
  assert.equal(merged.exit_reason, SIGNAL_EXIT_REASON);
  assert.equal(isSignalExitClosed(merged), true);
  assert.equal(isSignalExitClosed(SIGNAL_EXIT_DETAILS), false);
  assert.deepEqual(withSignalExitReason(null), { exit_reason: SIGNAL_EXIT_REASON });
});

test("신호 이탈 status: 비용 반영 수익률 > 0이면 profited, 0 이하는 stopped(스키마의 기존 status만 사용)", () => {
  assert.equal(statusForSignalExit(0.01), "profited");
  assert.equal(statusForSignalExit(0), "stopped");
  assert.equal(statusForSignalExit(-3), "stopped");
});

function bars(n: number, close: number, volume: number): DailyPrice[] {
  return Array.from({ length: n }, (_, i) => ({ date: `d${i}`, open: close, high: close, low: close, close, volume }));
}

test("20일 평균 거래대금: 직전 20개 봉(당일 제외) 종가×거래량 평균, 20개 미만이면 NaN", () => {
  const prices = bars(25, 1000, 1000); // 100만원/일
  assert.equal(computeAvgTradingValueWon(prices, 24), 1_000_000);
  // 당일(index) 거래량은 평균에 들어가지 않는다 — 당일 거래량이 폭증해도 값이 같다.
  prices[24] = { ...prices[24], volume: 10_000_000 };
  assert.equal(computeAvgTradingValueWon(prices, 24), 1_000_000);
  assert.ok(Number.isNaN(computeAvgTradingValueWon(prices, 19)));
  assert.equal(computeAvgTradingValueWon(prices, 20), 1_000_000);
});

test("후보 유니버스: ma_cross·급등주 v2는 시총 5천억 이상 + 20일 평균 거래대금 5억 이상(경계 포함), 미만은 제외", () => {
  for (const rt of ["ma_cross", "reversal_breakout_v2"] as const) {
    assert.deepEqual(krSignalUniverseRule(rt), { minMarketCapEok: 5000, minAvgTradingValueWon: PIT_MIN_AVG_TRADING_VALUE_WON });
    assert.equal(passesKrSignalUniverse(rt, 5000, PIT_MIN_AVG_TRADING_VALUE_WON), true);
    assert.equal(passesKrSignalUniverse(rt, 4999.9, PIT_MIN_AVG_TRADING_VALUE_WON), false); // 시총 미달
    assert.equal(passesKrSignalUniverse(rt, 5000, PIT_MIN_AVG_TRADING_VALUE_WON - 1), false); // 거래대금 미달
    assert.equal(passesKrSignalUniverse(rt, null, PIT_MIN_AVG_TRADING_VALUE_WON), false); // 시총 모름
    assert.equal(passesKrSignalUniverse(rt, 9000, NaN), false); // 거래대금 계산 불가
  }
  assert.equal(PIT_MIN_AVG_TRADING_VALUE_WON, 5e8);
});

test("peg_lynch 후보 풀은 이번에 바꾸지 않는다(유니버스 규칙 없음)", () => {
  assert.equal(krSignalUniverseRule("peg_lynch"), undefined);
  assert.equal(passesKrSignalUniverse("peg_lynch", 100, 0), true);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  isDeadTransition,
  isEntrySignalAt,
  isGoldenTransition,
  isSignalExitAt,
  matchesEntrySignalToday,
  matchesSignalExitToday,
  passesEntryFilter,
  runBacktest,
  type DailyPrice,
  type StrategyRule,
} from "@/lib/backtest";

const MA_RULE: StrategyRule = { rule_type: "ma_cross", rule_params: { short_period: 2, long_period: 4 } };
const V2_RULE: StrategyRule = { rule_type: "reversal_breakout_v2", rule_params: {} };

function bar(i: number, close: number, high: number = close): DailyPrice {
  return { date: `2024-01-${String(i + 1).padStart(2, "0")}`, open: close, high, low: close, close, volume: 1000 };
}

test("전환 판정: 거짓→참만 골든, 참→거짓만 데드, undefined(데이터 부족)는 전환이 아니다", () => {
  assert.equal(isGoldenTransition(false, true), true);
  assert.equal(isGoldenTransition(true, true), false);
  assert.equal(isGoldenTransition(undefined, true), false);
  assert.equal(isGoldenTransition(false, undefined), false);
  assert.equal(isDeadTransition(true, false), true);
  assert.equal(isDeadTransition(false, false), false);
  assert.equal(isDeadTransition(undefined, false), false);
});

test("등록은 상태 전환 첫날만: 상태가 계속 참인 날은 신호가 아니다(재등록 금지)", () => {
  const prices = [bar(0, 1), bar(1, 1), bar(2, 1), bar(3, 1)];
  const states = [false, true, true, true];
  assert.equal(isEntrySignalAt(prices, states, 1, V2_RULE), true);
  assert.equal(isEntrySignalAt(prices, states, 2, V2_RULE), false);
  assert.equal(isEntrySignalAt(prices, states, 3, V2_RULE), false);
  // 닫힌(거짓) 뒤 다시 참이 될 때만 재등록
  const again = [false, true, true, false, true];
  assert.equal(isEntrySignalAt([...prices, bar(4, 1)], again, 3, V2_RULE), false);
  assert.equal(isEntrySignalAt([...prices, bar(4, 1)], again, 4, V2_RULE), true);
  // 첫 봉/데이터 부족 구간은 신호가 아니다
  assert.equal(isEntrySignalAt(prices, [undefined, true, true, true], 1, V2_RULE), false);
  assert.equal(isEntrySignalAt(prices, states, 0, V2_RULE), false);
});

test("청산: 상태가 거짓이면 청산, 참/undefined는 청산하지 않는다", () => {
  assert.equal(isSignalExitAt([true, false], 1), true);
  assert.equal(isSignalExitAt([true, true], 1), false);
  assert.equal(isSignalExitAt([true, undefined], 1), false);
});

test("진입 필터는 ma_cross에만 적용된다(52주 고가 -18.29% 이내)", () => {
  const far = [bar(0, 100, 100), ...Array.from({ length: 10 }, (_, i) => bar(i + 1, 70, 70))];
  assert.equal(passesEntryFilter(far, 10, MA_RULE), false); // 70/100 - 1 = -30%
  assert.equal(passesEntryFilter(far, 10, V2_RULE), true);
  assert.equal(passesEntryFilter(far, 10, { rule_type: "peg_lynch", rule_params: {} }), true);
});

// 2/4 이평선 골든크로스가 나는 시계열: 하락 후 반등. 종가가 직전 고점(첫 봉 high)에 가까운지로 필터 통과/탈락을 가른다.
function crossSeries(firstHigh: number): DailyPrice[] {
  const closes = [100, 98, 96, 94, 92, 90, 91, 95, 99, 103, 99, 94, 90, 86, 84, 83];
  return closes.map((c, i) => bar(i, c, i === 0 ? firstHigh : c));
}

test("runBacktest: 골든크로스 날 종가가 52주 고가에서 멀면 진입하지 않고, 가까우면 진입한다", () => {
  const near = runBacktest(crossSeries(100), MA_RULE, "2024-01-01", undefined, undefined, { includeTransactionCosts: false });
  assert.equal(near.trades.length, 1);
  assert.ok(near.trades[0].sellDate > near.trades[0].buyDate); // 데드크로스로 청산
  assert.ok(!near.trades[0].isForcedLiquidation);
  // 첫 봉 high를 크게 올려 골든크로스 날(종가 95~99) 종가/고가 - 1 < -18.29%로 만든다.
  const far = runBacktest(crossSeries(130), MA_RULE, "2024-01-01", undefined, undefined, { includeTransactionCosts: false });
  assert.equal(far.trades.length, 0);
});

test("스크리닝 진입 함수와 백테스트 진입일이 같다(같은 함수 호출)", () => {
  const prices = crossSeries(100);
  const bt = runBacktest(prices, MA_RULE, "2024-01-01", undefined, undefined, { includeTransactionCosts: false });
  const buyIdx = prices.findIndex((p) => p.date === bt.trades[0].buyDate);
  for (let i = 0; i < prices.length; i++) {
    const today = matchesEntrySignalToday(prices.slice(0, i + 1), MA_RULE);
    assert.equal(today, i === buyIdx, `index ${i}`);
  }
  const sellIdx = prices.findIndex((p) => p.date === bt.trades[0].sellDate);
  assert.equal(matchesSignalExitToday(prices.slice(0, sellIdx + 1), MA_RULE), true);
  assert.equal(matchesSignalExitToday(prices.slice(0, sellIdx), MA_RULE), false);
});

test("닫힌 뒤 재등록은 다음 골든크로스에서만(백테스트: 한 포지션씩, 청산 후 새 골든에서만 재진입)", () => {
  const closes = [100, 98, 96, 94, 92, 90, 91, 95, 99, 103, 99, 94, 90, 86, 84, 83, 85, 90, 97, 105, 108];
  const prices = closes.map((c, i) => bar(i, c, c));
  const bt = runBacktest(prices, MA_RULE, "2024-01-01", undefined, undefined, { includeTransactionCosts: false });
  assert.equal(bt.trades.length >= 2, true);
  for (let k = 1; k < bt.trades.length; k++) assert.ok(bt.trades[k].buyDate > bt.trades[k - 1].sellDate);
});

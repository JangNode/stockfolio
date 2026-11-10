import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MarketRegimeLatest, MarketRegimeResponse } from "@/lib/marketRegimeApiTypes";
import type { Regime } from "@/lib/marketRegime";
import { currentStreak, kstToday, latestCompletedWeekday, regimeReason, staleness, weekdaysBetween, withWeekday } from "@/lib/marketRegimeView";

const T: MarketRegimeResponse["thresholds"] = { crisisDrawdownPct: -15, crisisB50Below: 20, bearB50Below: 40, bullB50AtLeast: 60, bullNhAbove: 0, confirmDays: 3 };
// 2026-10-26은 월요일.
const kst = (iso: string, hhmm = "10:00") => new Date(`${iso}T${hhmm}:00+09:00`);

describe("날짜 도우미", () => {
  it("한국 날짜는 UTC 자정 경계를 넘겨 계산한다", () => {
    assert.equal(kstToday(new Date("2026-10-25T14:59:00Z")), "2026-10-25");
    assert.equal(kstToday(new Date("2026-10-25T15:00:00Z")), "2026-10-26");
  });
  it("요일을 붙인다", () => {
    assert.equal(withWeekday("2026-10-15"), "2026-10-15 (목)");
    assert.equal(withWeekday("2026-10-25"), "2026-10-25 (일)");
  });
  it("가장 최근 완료 평일은 오늘 이전 평일이다(주말·월요일 처리)", () => {
    assert.equal(latestCompletedWeekday("2026-10-26"), "2026-10-23"); // 월 → 직전 금
    assert.equal(latestCompletedWeekday("2026-10-25"), "2026-10-23"); // 일 → 금
    assert.equal(latestCompletedWeekday("2026-10-24"), "2026-10-23"); // 토 → 금
    assert.equal(latestCompletedWeekday("2026-10-27"), "2026-10-26"); // 화 → 월
  });
  it("평일 수는 (after, through] 구간이며 주말을 건너뛴다", () => {
    assert.equal(weekdaysBetween("2026-10-15", "2026-10-23"), 6);
    assert.equal(weekdaysBetween("2026-10-23", "2026-10-26"), 1);
    assert.equal(weekdaysBetween("2026-10-23", "2026-10-23"), 0);
    assert.equal(weekdaysBetween("2026-10-23", "2026-10-22"), 0);
  });
});

describe("갱신 지연 판정", () => {
  it("마지막 계산일이 전 거래일이면 지연이 아니다(월요일 오전, 금요일 계산분)", () => {
    const s = staleness("2026-10-23", kst("2026-10-26"));
    assert.deepEqual([s.latestCompleted, s.behind, s.stale], ["2026-10-23", 0, false]);
  });
  it("하루 뒤처진 것(일일 계산 직전)은 경고하지 않는다", () => {
    const s = staleness("2026-10-22", kst("2026-10-26"));
    assert.deepEqual([s.behind, s.stale], [1, false]);
  });
  it("2거래일 이상 뒤처지면 경고한다", () => {
    const s = staleness("2026-10-21", kst("2026-10-26"));
    assert.deepEqual([s.behind, s.stale], [2, true]);
  });
  it("10-15 값을 일요일 10-25에 보면 6거래일 지연", () => {
    const s = staleness("2026-10-15", kst("2026-10-25", "21:00"));
    assert.deepEqual([s.latestCompleted, s.behind, s.stale], ["2026-10-23", 6, true]);
  });
  it("한국 날짜 기준이라 UTC로는 아직 전날이어도 한국 자정 이후면 새 날로 본다", () => {
    // 2026-10-26 00:30 KST = 2026-10-25 15:30 UTC → 한국은 월요일 → 완료 거래일 금요일
    assert.equal(staleness("2026-10-23", new Date("2026-10-25T15:30:00Z")).latestCompleted, "2026-10-23");
  });
  it("기준일이 더 최신이면 0", () => {
    assert.equal(staleness("2026-10-26", kst("2026-10-26")).behind, 0);
  });
  it("임계값을 바꿀 수 있다", () => {
    assert.equal(staleness("2026-10-22", kst("2026-10-26"), 1).stale, true);
  });
});

describe("N거래일째", () => {
  const tl = (s: string) => s.split("").map((c, i) => ({ date: `d${i}`, regime: ({ B: "bull", N: "neutral", R: "bear", C: "crisis" } as Record<string, Regime>)[c] }));
  it("끝에서부터 같은 국면이 이어진 일수를 센다", () => {
    assert.deepEqual(currentStreak(tl("NNBBRRR"), "bear"), { days: 3, atLeast: false });
    assert.deepEqual(currentStreak(tl("NNBBRRB"), "bull"), { days: 1, atLeast: false });
  });
  it("타임라인 전체가 같은 국면이면 '이상'으로 표시한다", () => {
    assert.deepEqual(currentStreak(tl("RRRR"), "bear"), { days: 4, atLeast: true });
  });
  it("비었거나 끝 국면이 다르면 0", () => {
    assert.deepEqual(currentStreak([], "bear"), { days: 0, atLeast: false });
    assert.deepEqual(currentStreak(tl("NNB"), "bear"), { days: 0, atLeast: false });
  });
});

describe("판정 이유 문장", () => {
  const base: MarketRegimeLatest = { tradeDate: "2026-10-15", regime: "bear", rawRegime: "bear", kospiClose: 90, ma50: 100, ma200: 100, b50: 20, b200: 24, nh: -54, drawdown: -10, vol20: 30, volPctile: 50, memberCount: 200, source: "backfill" };
  it("약세: 200일선 아래 + B50", () => {
    assert.equal(regimeReason(base, T), "KOSPI가 200일선 아래이고 50일선 위 종목이 20%(기준 40% 미만)");
  });
  it("위기: 낙폭과 B50", () => {
    assert.equal(regimeReason({ ...base, rawRegime: "crisis", drawdown: -39.06, b50: 12.34 }, T), "252일 고점 대비 -39.1%(기준 -15% 이하)이고 50일선 위 종목이 12.3%(기준 20% 미만)");
  });
  it("강세: 200일선 위 + B50 + NH", () => {
    assert.equal(regimeReason({ ...base, rawRegime: "bull", kospiClose: 110, b50: 70, nh: 12 }, T), "KOSPI가 200일선 위이고 50일선 위 종목이 70%(기준 60% 이상), 55일 신고가−신저가 +12");
  });
  it("중립: 약세·강세 중 못 미친 쪽을 말한다", () => {
    assert.match(regimeReason({ ...base, rawRegime: "neutral", b50: 55 }, T), /약세 기준\(40% 미만\)에는 못 미침/);
    assert.match(regimeReason({ ...base, rawRegime: "neutral", kospiClose: 110, b50: 50 }, T), /강세 기준\(60% 이상\)에는 못 미침/);
    assert.match(regimeReason({ ...base, rawRegime: "neutral", kospiClose: 110, b50: 65, nh: 0 }, T), /55일 신고가−신저가가 0\(기준 0 초과\)/);
  });
  it("200일선·B50이 없으면 이력 부족 문구", () => {
    assert.match(regimeReason({ ...base, rawRegime: "undefined", ma200: null }, T), /이력이 아직 부족/);
    assert.match(regimeReason({ ...base, b50: null }, T), /이력이 아직 부족/);
  });
});

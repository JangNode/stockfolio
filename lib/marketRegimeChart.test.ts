import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Regime, RegimeDay } from "@/lib/marketRegime";
import { countTransitions } from "@/lib/marketRegime";
import {
  REGIME_SERIES_CODES, downsampleIndices, indexedRuns, monthTicks, nearestIndex, niceTicks, recentTransitions, seriesToDays, windowDays,
} from "@/lib/marketRegimeChart";

/** 2025-01-01부터 평일만 n개. */
function weekdays(n: number, start = "2025-01-01"): string[] {
  const out: string[] = [];
  for (let ms = Date.parse(`${start}T00:00:00Z`); out.length < n; ms += 86_400_000) { const w = new Date(ms).getUTCDay(); if (w !== 0 && w !== 6) out.push(new Date(ms).toISOString().slice(0, 10)); }
  return out;
}
const mk = (s: string, start = "2025-01-01"): RegimeDay[] => {
  const dates = weekdays(s.length, start);
  return s.split("").map((c, i) => ({ date: dates[i], regime: ({ B: "bull", N: "neutral", R: "bear", C: "crisis", U: "undefined" } as Record<string, Regime>)[c], kospiClose: 100 + i }));
};

describe("series 변환", () => {
  it("열 배열을 날짜별 객체로 푼다(서버 코드와 대응)", () => {
    const days = mk("UNBRC");
    const s = { dates: days.map((d) => d.date), closes: days.map((d) => d.kospiClose), regimes: days.map((d) => REGIME_SERIES_CODES[d.regime]).join("") };
    assert.equal(s.regimes, "UNBRC");
    assert.deepEqual(seriesToDays(s), days);
  });
  it("길이 불일치·모르는 코드·없는 값은 빈 배열", () => {
    assert.deepEqual(seriesToDays({ dates: ["2026-01-02"], closes: [1, 2], regimes: "N" }), []);
    assert.deepEqual(seriesToDays({ dates: ["2026-01-02"], closes: [1], regimes: "X" }), []);
    assert.deepEqual(seriesToDays(undefined), []);
  });
});

describe("기간 구간", () => {
  const days = Array.from({ length: 1000 }, (_, i) => i);
  it("1년=252, 3년=756 거래일, 전체=그대로이고 마지막 날을 포함한다", () => {
    assert.equal(windowDays(days, "1y").length, 252);
    assert.equal(windowDays(days, "1y")[251], 999);
    assert.equal(windowDays(days, "3y").length, 756);
    assert.equal(windowDays(days, "all").length, 1000);
  });
  it("이력이 기간보다 짧으면 있는 만큼만", () => {
    assert.equal(windowDays(days.slice(0, 100), "1y").length, 100);
    assert.equal(windowDays(days.slice(0, 300), "3y").length, 300);
    assert.equal(windowDays([], "1y").length, 0);
  });
});

describe("월 눈금", () => {
  it("1년 구간: 달마다 눈금, 1월에만 연도가 붙고 구간 첫 달(중간 시작)은 제외한다", () => {
    const dates = weekdays(252, "2025-09-29");
    const t = monthTicks(dates, 14);
    assert.deepEqual(t.map((x) => x.label), ["10월", "11월", "12월", "1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월"].slice(0, t.length));
    const jan = t.find((x) => x.label === "1월")!;
    assert.equal(jan.year, "2026");
    assert.equal(t.filter((x) => x.year !== null).length, 1);
    assert.equal(dates[jan.index], "2026-01-01"); // 2026-01-01은 수요일(이 도우미는 휴장일을 모른다)
    assert.equal(t[0].index, dates.indexOf("2025-10-01"));
  });
  it("눈금 수 제한: 좁으면 간격을 넓히고 1월을 기준으로 맞춘다", () => {
    const dates = weekdays(252, "2025-09-29");
    assert.deepEqual(monthTicks(dates, 7).map((x) => x.label), ["11월", "1월", "3월", "5월", "7월", "9월"].slice(0, monthTicks(dates, 7).length)); // 2개월 간격
    const q = monthTicks(dates, 5); // 3개월 간격: 1·4·7·10월
    assert.deepEqual(q.map((x) => x.label), ["10월", "1월", "4월", "7월"]);
    assert.equal(q.find((x) => x.label === "1월")?.year, "2026");
  });
  it("3년 구간: 3개월 이상 간격, 그 이상 길면 연 단위(label이 연도, year는 null)", () => {
    const three = monthTicks(weekdays(756, "2023-10-02"), 9);
    assert.ok(three.length <= 9 && three.length >= 3);
    assert.ok(three.every((x) => ["1월", "4월", "7월", "10월", "1월"].includes(x.label) || /월$/.test(x.label)));
    const all = monthTicks(weekdays(4000, "2010-07-01"), 8);
    assert.ok(all.length <= 8);
    assert.ok(all.every((x) => /^\d{4}$/.test(x.label) && x.year === null));
    const years = all.map((x) => Number(x.label));
    assert.ok(years.every((y, i) => i === 0 || y - years[i - 1] === years[1] - years[0])); // 같은 간격
  });
  it("달이 바뀌지 않는 짧은 구간은 눈금 없음", () => {
    assert.deepEqual(monthTicks(weekdays(10, "2026-03-02"), 10), []);
    assert.deepEqual(monthTicks([], 10), []);
  });
});

describe("세로축 눈금·점 솎기·위치", () => {
  it("보기 좋은 간격의 눈금을 범위 안에서 만든다", () => {
    assert.deepEqual(niceTicks(0, 100, 5), [0, 20, 40, 60, 80, 100]);
    assert.deepEqual(niceTicks(4930, 5810, 4), [5000, 5200, 5400, 5600, 5800]);
    assert.deepEqual(niceTicks(1, 1, 4), []);
  });
  it("점 솎기는 처음·마지막을 포함하고 상한을 넘지 않는다", () => {
    const idx = downsampleIndices(4000, 600);
    assert.equal(idx.length, 600);
    assert.equal(idx[0], 0);
    assert.equal(idx[599], 3999);
    assert.ok(idx.every((v, i) => i === 0 || v > idx[i - 1]));
    assert.deepEqual(downsampleIndices(5, 600), [0, 1, 2, 3, 4]);
    assert.deepEqual(downsampleIndices(0, 10), []);
  });
  it("가로 위치를 가장 가까운 거래일 순번으로 바꾼다(범위 밖은 양 끝)", () => {
    assert.equal(nearestIndex(50, 50, 300, 11), 0);
    assert.equal(nearestIndex(350, 50, 300, 11), 10);
    assert.equal(nearestIndex(200, 50, 300, 11), 5);
    assert.equal(nearestIndex(0, 50, 300, 11), 0);
    assert.equal(nearestIndex(999, 50, 300, 11), 10);
    assert.equal(nearestIndex(100, 50, 300, 1), 0);
  });
});

describe("국면 구간·최근 전환", () => {
  it("구간에 시작 순번이 붙는다", () => {
    assert.deepEqual(indexedRuns(mk("NNBBBR")).map((r) => [r.regime, r.startIndex, r.days]), [["neutral", 0, 2], ["bull", 2, 3], ["bear", 5, 1]]);
  });
  it("최근 전환 n건: 최신 먼저, 날짜·전환 내용·이전 국면 지속 일수", () => {
    const days = mk("NNNBBRRRRC");
    const t = recentTransitions(days, 5);
    assert.deepEqual(t.map((x) => [x.date, x.from, x.to, x.fromDays]), [
      [days[9].date, "bear", "crisis", 4],
      [days[5].date, "bull", "bear", 2],
      [days[3].date, "neutral", "bull", 3],
    ]);
    assert.equal(recentTransitions(days, 2).length, 2);
    assert.equal(recentTransitions(days, 2)[0].to, "crisis");
  });
  it("미정 → 첫 국면은 전환이 아니고, 건수는 countTransitions와 같다", () => {
    const days = mk("UUNNBBNN");
    const t = recentTransitions(days, 10);
    assert.equal(t.length, 2);
    assert.equal(t.length, countTransitions(days.map((d) => d.regime)));
    assert.deepEqual(recentTransitions(mk("UUNN"), 5), []);
    assert.deepEqual(recentTransitions([], 5), []);
  });
});

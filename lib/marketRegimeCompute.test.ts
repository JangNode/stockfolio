import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { indexStock } from "@/lib/marketRegime";
import { backfillEndDate, candidatesOn, computeRegimeRows, datesMissingFromBook, splitByParquetAvailability, type PriceBook } from "@/lib/marketRegimeCompute";

const N = 700;
const dayOf = (i: number): string => new Date(Date.UTC(2018, 0, 1 + i)).toISOString().slice(0, 10);
const dates = Array.from({ length: N }, (_, i) => dayOf(i));
// 결정적 의사난수(사인 합) — 상승·하락 구간이 번갈아 나오도록 느린 파동을 섞는다.
const wave = (i: number, k: number): number => Math.sin(i / (25 + k * 7)) * 0.012 + Math.sin(i * 1.7 + k) * 0.01;
function walk(k: number): number[] { const out: number[] = []; let v = 100 + k; for (let i = 0; i < N; i++) { v *= 1 + wave(i, k); out.push(v); } return out; }

const book: PriceBook = new Map();
for (let k = 0; k < 12; k++) {
  const code = String(100000 + k * 10).padStart(6, "0");
  const close = Float64Array.from(walk(k));
  book.set(code, { ...indexStock({ code, dates, close }), mcap: Float64Array.from(close.map((c) => c * (k + 1) * 10)), avgTv: new Float64Array(N).fill(1e9) });
}
const index = dates.map((d, i) => ({ date: d, close: walk(99)[i] }));
const members = [...book.keys()];

describe("computeRegimeRows", () => {
  const eval0 = dates.slice(300);
  const full = computeRegimeRows({ index, book, dates: eval0, membersOn: () => members, source: "backfill" });
  it("모든 날짜에 한 행씩, 구성 종목 수와 지표가 채워진다", () => {
    assert.equal(full.length, eval0.length);
    assert.ok(full.every((r) => r.memberCount === 12 && r.ma200 !== null && r.b50 !== null && r.drawdown !== null));
    assert.ok(new Set(full.map((r) => r.regime)).size >= 2, "국면이 한 가지로만 나오면 테스트 자료가 의미 없다");
  });
  it("직전 행의 국면·신호로 이어서 계산한 결과(일일 배치)가 한 번에 계산한 결과(백필)와 같다", () => {
    for (const cut of [10, 57, 123, 200]) {
      const head = full.slice(0, cut), tail = eval0.slice(cut);
      const resumed = computeRegimeRows({
        index, book, dates: tail, membersOn: () => members, source: "daily",
        seed: { prevRegime: head[head.length - 1].regime, prevRaws: head.slice(-2).map((r) => r.rawRegime) },
      });
      assert.deepEqual(resumed.map((r) => [r.tradeDate, r.regime, r.rawRegime]), full.slice(cut).map((r) => [r.tradeDate, r.regime, r.rawRegime]));
    }
  });
  it("지수 종가가 없는 날짜가 있으면 던진다", () => {
    assert.throws(() => computeRegimeRows({ index: index.slice(0, 400), book, dates: [dates[500]], membersOn: () => members, source: "daily" }), /KOSPI 지수 종가가 없습니다/);
  });
});

describe("candidatesOn", () => {
  it("그날 가격 행이 있는 종목만 후보가 되고 코스피·제외 판정이 붙는다", () => {
    const c = candidatesOn(book, dates[10], (code) => code !== "100000", (code) => code === "100010");
    assert.equal(c.length, 12);
    assert.equal(c.find((x) => x.code === "100000")!.isKospi, false);
    assert.equal(c.find((x) => x.code === "100010")!.excluded, true);
    assert.equal(candidatesOn(book, "1999-01-01", () => true, () => false).length, 0);
  });
});

describe("Parquet 읽기 전용 처리", () => {
  it("시세가 없는 날짜를 찾고, 앞에서부터 시세가 있는 날만 이어 계산 대상으로 남긴다", () => {
    const want = [dates[10], dates[11], "2030-01-02", "2030-01-03"];
    assert.deepEqual(datesMissingFromBook(book, want), ["2030-01-02", "2030-01-03"]);
    assert.deepEqual(splitByParquetAvailability(book, want), { available: [dates[10], dates[11]], missing: ["2030-01-02", "2030-01-03"] });
    // 첫 빈 날 뒤에 시세가 있는 날이 있어도 이어 계산할 수 없으므로 제외한다
    assert.deepEqual(splitByParquetAvailability(book, [dates[10], "2030-01-02", dates[12]]), { available: [dates[10]], missing: ["2030-01-02"] });
    assert.deepEqual(splitByParquetAvailability(book, ["2030-01-02"]), { available: [], missing: ["2030-01-02"] });
    assert.deepEqual(splitByParquetAvailability(book, [dates[10]]), { available: [dates[10]], missing: [] });
  });
});

describe("백필 마지막 날", () => {
  it("일일 행이 없으면 시세 마지막 날, 있으면 첫 일일 행의 전날과 시세 마지막 날 중 이른 날", () => {
    assert.equal(backfillEndDate("2026-10-15", null), "2026-10-15");
    assert.equal(backfillEndDate("2026-10-15", "2026-10-16"), "2026-10-15");
    assert.equal(backfillEndDate("2026-10-15", "2026-10-14"), "2026-10-13");
    assert.equal(backfillEndDate("2026-10-15", "2026-03-01"), "2026-02-28");
    assert.equal(backfillEndDate("2026-10-15", "2026-01-01"), "2025-12-31");
  });
});

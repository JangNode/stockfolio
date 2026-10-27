import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  breadthOn, classifyRaw, computeIndexMetrics, confirmRegimes, countTransitions, indexStock, isExcludedStock, nextRegime,
  regimeRuns, selectMembers, summarizeByRegime, type Regime, type RegimeDay,
} from "@/lib/marketRegime";

const dayOf = (i: number): string => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);

describe("computeIndexMetrics", () => {
  it("이동평균은 창이 찰 때부터 정의되고 값이 맞다", () => {
    const pts = Array.from({ length: 260 }, (_, i) => ({ date: dayOf(i), close: 100 + i }));
    const m = computeIndexMetrics(pts);
    assert.equal(m[48].ma50, null);
    assert.equal(m[49].ma50, 100 + 24.5);
    assert.equal(m[198].ma200, null);
    assert.equal(m[199].ma200, 100 + 99.5);
  });
  it("낙폭은 252일 창이 다 찬 날부터 고점(오늘 포함) 대비로 계산한다", () => {
    const pts = Array.from({ length: 300 }, (_, i) => ({ date: dayOf(i), close: i === 100 ? 200 : 100 }));
    const m = computeIndexMetrics(pts);
    assert.equal(m[250].drawdownPct, null);
    assert.equal(m[251].drawdownPct, -50);
    assert.equal(m[299].drawdownPct, -50); // 고점 인덱스 100은 j >= 48 창 안
  });
  it("변동성은 일정한 수익률이면 0, 변동이 있으면 연환산 양수, 백분위는 창이 찬 뒤부터", () => {
    const flat = computeIndexMetrics(Array.from({ length: 300 }, (_, i) => ({ date: dayOf(i), close: 100 * 1.001 ** i })));
    assert.ok(Math.abs(flat[40].vol20 as number) < 1e-4);
    const zig = computeIndexMetrics(Array.from({ length: 300 }, (_, i) => ({ date: dayOf(i), close: i % 2 ? 101 : 100 })));
    assert.ok((zig[40].vol20 as number) > 10);
    assert.equal(zig[200].volPctile, null);
    assert.ok((zig[299].volPctile as number) > 0 && (zig[299].volPctile as number) <= 100);
  });
});

describe("classifyRaw", () => {
  const base = { close: 100, ma200: 100, b50: 50, nh: 0, drawdownPct: -5 };
  it("200일선이나 B50이 없으면 미정", () => {
    assert.equal(classifyRaw({ ...base, ma200: null }), "undefined");
    assert.equal(classifyRaw({ ...base, b50: null }), "undefined");
  });
  it("위기가 약세보다 먼저: 낙폭 ≤ -15% 이고 B50 < 20", () => {
    assert.equal(classifyRaw({ close: 80, ma200: 100, b50: 10, nh: -50, drawdownPct: -15 }), "crisis");
    assert.equal(classifyRaw({ close: 80, ma200: 100, b50: 10, nh: -50, drawdownPct: -14.9 }), "bear");
    assert.equal(classifyRaw({ close: 80, ma200: 100, b50: 20, nh: -50, drawdownPct: -30 }), "bear");
  });
  it("약세: 200일선 아래 이고 B50 < 40", () => {
    assert.equal(classifyRaw({ ...base, close: 99, b50: 39.9 }), "bear");
    assert.equal(classifyRaw({ ...base, close: 99, b50: 40 }), "neutral");
    assert.equal(classifyRaw({ ...base, close: 100, b50: 10 }), "neutral"); // 200일선과 같으면 아래가 아님
  });
  it("강세: 200일선 위 이고 B50 ≥ 60 이고 NH > 0 (모두 필요)", () => {
    assert.equal(classifyRaw({ ...base, close: 101, b50: 60, nh: 1 }), "bull");
    assert.equal(classifyRaw({ ...base, close: 101, b50: 60, nh: 0 }), "neutral");
    assert.equal(classifyRaw({ ...base, close: 101, b50: 59.9, nh: 5 }), "neutral");
    assert.equal(classifyRaw({ ...base, close: 99, b50: 70, nh: 5 }), "neutral");
  });
  it("낙폭이 없으면(창 미충족) 위기는 판정하지 않는다", () => {
    assert.equal(classifyRaw({ close: 80, ma200: 100, b50: 10, nh: -50, drawdownPct: null }), "bear");
  });
});

describe("국면 확인(3거래일)", () => {
  const seq = (s: string): Regime[] => s.split("").map((c) => ({ B: "bull", N: "neutral", R: "bear", C: "crisis", U: "undefined" } as Record<string, Regime>)[c]);
  const str = (r: Regime[]): string => r.map((x) => ({ bull: "B", neutral: "N", bear: "R", crisis: "C", undefined: "U" })[x]).join("");
  it("연속 3일 같은 신호여야 바뀌고, 미충족이면 직전 국면을 유지한다", () => {
    assert.equal(str(confirmRegimes(seq("NNNBBNBBBB"))), "NNNNNNNNBB");
  });
  it("중간에 직전 국면과 같은 신호가 끼면 세는 것이 끊긴다", () => {
    assert.equal(str(confirmRegimes(seq("NNNBBNBB"))), "NNNNNNNN");
  });
  it("미정 구간 뒤 첫 국면은 바로 채택하고, 이후부터 확인 규칙을 쓴다", () => {
    assert.equal(str(confirmRegimes(seq("UUUBNNNN"))), "UUUBBBNN");
  });
  it("days = 1이면 신호 그대로", () => {
    assert.equal(str(confirmRegimes(seq("NBNRC"), 1)), "NBNRC");
  });
  it("nextRegime은 전체 계산(confirmRegimes)과 같은 결과를 증분으로 낸다", () => {
    const raws = seq("UUBBNNNRRRCCCCNNN");
    const full = confirmRegimes(raws);
    let prev: Regime | null = null;
    raws.forEach((_, t) => { prev = nextRegime(prev, raws.slice(Math.max(0, t - 2), t + 1)); assert.equal(prev, full[t]); });
  });
  it("전환 횟수: 미정→첫 국면은 세지 않는다", () => {
    assert.equal(countTransitions(seq("UUNNBBBRR")), 2);
    assert.equal(countTransitions(seq("NBNBN")), 4);
  });
});

describe("구성 종목", () => {
  it("코스피 ∩ 거래대금 하한 ∩ 제외 규칙 후 시총 순(동률은 코드)으로 topN", () => {
    const mk = (code: string, mcapEok: number, tv = 1e9, isKospi = true, excluded = false) => ({ code, mcapEok, avgTradingValueWon: tv, isKospi, excluded });
    const r = selectMembers([mk("000010", 100), mk("000020", 300), mk("000030", 300), mk("000040", 900, 1e8), mk("000050", 800, 1e9, false), mk("000060", 700, 1e9, true, true)], 2, 5e8);
    assert.deepEqual(r, ["000020", "000030"]);
  });
  it("제외 규칙: 우선주·스팩·리츠·명시 코드·비주식", () => {
    assert.equal(isExcludedStock({ code: "005935" }), true);
    assert.equal(isExcludedStock({ code: "123450", name: "OO스팩3호" }), true);
    assert.equal(isExcludedStock({ code: "123450", name: "OO기업인수목적1호" }), true);
    assert.equal(isExcludedStock({ code: "123450", name: "ABC리츠" }), true);
    assert.equal(isExcludedStock({ code: "123450", ksic: "64201" }), true);
    assert.equal(isExcludedStock({ code: "088980" }), true);
    assert.equal(isExcludedStock({ code: "123450", productType: "RT" }), true);
    assert.equal(isExcludedStock({ code: "005930", name: "삼성전자", ksic: "26110", productType: "ST" }), false);
  });
});

describe("breadthOn", () => {
  const rise = (n: number, start = 100, step = 1): number[] => Array.from({ length: n }, (_, i) => start + i * step);
  it("50일선 위 비율, 55일 신고가·신저가 수를 센다", () => {
    const n = 80;
    const up = { code: "A", dates: Array.from({ length: n }, (_, i) => dayOf(i)), close: rise(n) };
    const down = { code: "B", dates: up.dates, close: rise(n, 200, -1) };
    const short = { code: "C", dates: up.dates.slice(40), close: rise(40) }; // 행 수 40 < 50
    const m = new Map([up, down, short].map((s) => [s.code, indexStock(s)]));
    const b = breadthOn(m, ["A", "B", "C", "ZZ"], dayOf(n - 1));
    assert.equal(b.members, 3);
    assert.equal(b.n50, 2);
    assert.equal(b.a50, 1);
    assert.equal(b.b50, 50);
    assert.equal(b.n200, 0);
    assert.equal(b.b200, null);
    assert.equal(b.highs, 1);
    assert.equal(b.lows, 1);
    assert.equal(b.nh, 0);
  });
  it("신고가는 직전 55개 종가보다 엄격히 높아야 하고, 행 인덱스 55 이상만 센다", () => {
    const flat = { code: "A", dates: Array.from({ length: 60 }, (_, i) => dayOf(i)), close: Array(60).fill(100) as number[] };
    const m = new Map([[flat.code, indexStock(flat)]]);
    const b = breadthOn(m, ["A"], dayOf(59));
    assert.equal(b.highs, 0);
    assert.equal(b.lows, 0);
    const early = breadthOn(m, ["A"], dayOf(54));
    assert.equal(early.highs + early.lows, 0);
  });
});

describe("이력 통계", () => {
  const rows: RegimeDay[] = [
    ...Array.from({ length: 6 }, (_, i) => ({ date: dayOf(i), regime: "bull" as Regime, kospiClose: 100 + i })),
    ...Array.from({ length: 4 }, (_, i) => ({ date: dayOf(6 + i), regime: "bear" as Regime, kospiClose: 100 - i })),
  ];
  it("연속 구간(run)으로 묶는다", () => {
    const runs = regimeRuns(rows);
    assert.equal(runs.length, 2);
    assert.deepEqual([runs[0].regime, runs[0].days, runs[1].days], ["bull", 6, 4]);
  });
  it("국면별 일수·비율과 h일 뒤 수익률(표본 수·승률)", () => {
    const s = summarizeByRegime(rows, 2);
    const bull = s.find((x) => x.regime === "bull")!;
    assert.equal(bull.days, 6);
    assert.equal(bull.share, 60);
    assert.equal(bull.samples, 6);
    assert.equal(bull.winRatePct, 100 * (4 / 6)); // 마지막 두 날은 2일 뒤가 하락 구간(98, 97 < 104, 105)
    const crisis = s.find((x) => x.regime === "crisis")!;
    assert.equal(crisis.samples, 0);
    assert.equal(crisis.avgForwardPct, null);
  });
});

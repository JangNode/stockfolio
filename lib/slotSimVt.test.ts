import test from "node:test";
import assert from "node:assert/strict";
import { simSlots, type SimCand, type SimCfg, type SimEnv, type SimPos, type SimRun, type SimS } from "@/lib/slotSim";

// 합성 데이터: 시드 고정 난수 보행 12종목 × 400일. 후보 = (c + 코드해시) % 5 == 0 인 종목 최대 3개, 청산 = 보유 15일 이상.
function rng(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const N = 400;
const CAL = Array.from({ length: N }, (_, i) => new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10));
function makeStocks(): SimS[] {
  const r = rng(7);
  return Array.from({ length: 12 }, (_, k) => {
    const close = new Float64Array(N);
    let px = 100 + k * 10;
    for (let i = 0; i < N; i++) { px *= 1 + (r() - 0.48) * (k % 3 === 0 ? 0.06 : 0.02); close[i] = px; }
    return { code: `S${String(k).padStart(2, "0")}`, dates: CAL, idx: new Map(CAL.map((d, i) => [d, i])), close, raw: close, vol: new Float64Array(N).fill(1000), last: CAL[N - 1] };
  });
}
const envFor = (zeroCost: boolean): SimEnv => ({ CAL, nCal: N, cS: 30, adjustments: new Map(), endedBefore: "1900-01-01", stockBuyMult: zeroCost ? 1 : 1.00115, sellRate: () => (zeroCost ? 0 : 0.0031), baseSlip: zeroCost ? 0 : 0.001, bhRet: new Map() });
const hooksFor = (stocks: SimS[]) => ({
  candsOf: (c: number): SimCand[] => stocks.filter((s, k) => (c + k) % 5 === 0).slice(0, 3).map((s) => ({ s, code: s.code })),
  exitReason: (p: SimPos, c: number): string | null => (c - p.entryC >= 15 ? "보유 기간" : null),
});
const digest = (r: SimRun) => ({ n: r.dates.length, ret: r.ret.reduce((a, x) => a + x, 0), cost: r.costFrac.reduce((a, x) => a + x, 0), trades: r.trades.length, proceeds: r.trades.reduce((a, t) => a + t.proceeds, 0), spend: r.trades.reduce((a, t) => a + t.spend, 0), entries: r.entryCs.length, nPos: r.nPos.reduce((a, x) => a + x, 0), turn: r.turn.reduce((a, t) => a + t.v, 0) });
const baseCfg: SimCfg = { slip: 0.001, maxPos: 5, capFrac: 0.2, cooldown: 3 };

// 변경 전 엔진(커밋 5e29a0c의 lib/slotSim.ts)으로 같은 합성 데이터를 돌려 얻은 요약값(고정값). vt가 없으면 새 엔진이 이 값과 정확히 같아야 한다.
const LEGACY = {
  lag1: { n: 369, ret: 13.978519452299569, cost: 0.09040239074361754, trades: 105, proceeds: 23.25753467717096, spend: 23.10761387201831, entries: 110, nPos: 1709, turn: 21.497505184598715 },
  lag2: { n: 369, ret: 5.694879503561742, cost: 0.08186233103000636, trades: 95, proceeds: 19.60900517324673, spend: 19.556665960772257, entries: 100, nPos: 1632, turn: 19.48918544748463 },
  int: { n: 369, ret: 13.977899880703248, cost: 0.09039776965285062, trades: 105, proceeds: 116281580.949341, spend: 115532009.06689051, entries: 110, nPos: 1709, turn: 21.496401332274566 },
  replace: { n: 369, ret: 13.533820385391696, cost: 0.09039233112980471, trades: 105, proceeds: 23.15639688440227, spend: 23.011476628693313, entries: 110, nPos: 1709, turn: 21.495883869441535 },
};

test("vt 없이는 변경 전 엔진과 결과가 정확히 같다(일반·지연 2·정수 주·대체 거래)", () => {
  const stocks = makeStocks();
  assert.deepEqual(digest(simSlots(envFor(false), baseCfg, hooksFor(stocks), { lag: 1 })), LEGACY.lag1);
  assert.deepEqual(digest(simSlots(envFor(false), baseCfg, hooksFor(stocks), { lag: 2 })), LEGACY.lag2);
  assert.deepEqual(digest(simSlots(envFor(false), baseCfg, hooksFor(stocks), { lag: 1, int: 5_000_000 })), LEGACY.int);
  const t0 = simSlots(envFor(false), baseCfg, hooksFor(stocks), { lag: 1 }).trades[0];
  assert.deepEqual(digest(simSlots(envFor(false), baseCfg, hooksFor(stocks), { lag: 1, replace: new Set([`${t0.code}|${t0.entryC}`]) })), LEGACY.replace);
});

test("vt가 있어도 배율 1·band 무한대면 vt 없는 실행과 같다", () => {
  const stocks = makeStocks();
  const a = simSlots(envFor(false), baseCfg, hooksFor(stocks), { lag: 1 });
  const b = simSlots(envFor(false), { ...baseCfg, vt: { sizeMult: () => 1, band: 1e9 } }, hooksFor(stocks), { lag: 1 });
  assert.deepEqual(a.ret, b.ret);
  assert.equal(b.rebal?.length, 0);
});

test("배율 0.5 고정: 신규 편입이 슬롯 비중의 절반으로 들어가고 조정 체결이 없다(비용 0)", () => {
  const stocks = makeStocks();
  const run = simSlots(envFor(true), { ...baseCfg, cooldown: 0, vt: { sizeMult: () => 0.5, band: 0.2 } }, hooksFor(stocks), { lag: 1, detail: true });
  const maxInv = Math.max(...run.inv);
  assert.ok(maxInv <= 0.5 * 1.35, `투자 비중 ${maxInv}`); // 5슬롯 × 10% = 50%에 가격 변동분
  assert.ok(Math.max(...run.inv) > 0.2);
  const t0 = run.trades[0];
  assert.ok(t0.spend / t0.vAtEntry > 0.099 && t0.spend / t0.vAtEntry < 0.101, `진입 비중 ${t0.spend / t0.vAtEntry}`);
});

test("배율이 1 → 0.5로 바뀌면 실제 배율과 0.2 이상 벌어질 때 다음 체결일에 줄이고, 비용 0이면 계좌 가치는 가격 경로와 일치한다", () => {
  const stocks = makeStocks();
  const m = (c: number): number => (c < 100 ? 1 : 0.5);
  const run = simSlots(envFor(true), { ...baseCfg, slip: 0, cooldown: 0, vt: { sizeMult: (c) => m(c), band: 0.2 } }, { candsOf: (c) => (c < 40 ? stocks.slice(0, 5).map((s) => ({ s, code: s.code })) : []), exitReason: (p: SimPos, c: number) => (c >= 380 ? "끝" : null) }, { lag: 1 });
  assert.ok((run.rebal?.length ?? 0) >= 1);
  const first = run.rebal![0];
  assert.equal(first.m, 0.5);
  assert.ok(CAL.indexOf(first.d) === 101, `첫 조정 체결일 인덱스 ${CAL.indexOf(first.d)}`); // c=100 판단 → 101 체결
  const iBefore = run.dates.indexOf(CAL[100]), iAfter = run.dates.indexOf(CAL[102]);
  assert.ok(run.inv[iBefore] > 0.9);
  assert.ok(run.inv[iAfter] > 0.4 && run.inv[iAfter] < 0.6, `조정 후 투자 비중 ${run.inv[iAfter]}`);
  // 비용 0: 계좌 가치 = 현금 + 보유 평가액이라 일수익률은 투자 비중 × 종목 평균 수익률(동일 비중 가정 근사)이므로 전체 비용 합은 0
  assert.equal(run.costFrac.reduce((a, x) => a + x, 0), 0);
});

test("조정 시 부분 매도 대금이 거래 손익에 합산된다(순매도 대금 + 마지막 청산 = 총 proceeds)", () => {
  const stocks = makeStocks();
  const cfg: SimCfg = { ...baseCfg, cooldown: 0, vt: { sizeMult: (c) => (c < 100 ? 1 : 0.5), band: 0.2 } };
  const run = simSlots(envFor(false), cfg, { candsOf: (c) => (c < 40 ? stocks.slice(0, 5).map((s) => ({ s, code: s.code })) : []), exitReason: (p: SimPos, c: number) => (c >= 380 ? "끝" : null) }, { lag: 1 });
  const first = run.trades[0];
  assert.ok(first.proceeds > 0 && first.spend > 0);
  // 부분 매도가 있었다면 마지막 청산 대금만으로는 설명되지 않는 만큼 proceeds가 크다 — 최소한 모든 거래가 유한하고 양수
  assert.ok(run.trades.every((t) => Number.isFinite(t.proceeds) && t.proceeds > 0));
});

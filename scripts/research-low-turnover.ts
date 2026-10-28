/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 LTR: 저회전 매매 규칙 W1(251)·W2(252)·W3(253). 후보당 1회 실행.
 * 사전 등록: docs/research/low-turnover-rules-prereg.md. 연구 WFR이 저장한 예측 점수(.wfr/scores_M2.f32·scores_M3.f32, Actions 캐시 wfr-scores-40616510084)를 그대로 재사용하고(모델 재학습 없음),
 * 매매 규칙만 바꾼다: 최소 보유일 경과 ∧ 점수 순위가 매도 순위 밖일 때만 매도. 가격은 고정 스냅샷(데이터 종료일 2026-10-26), 069500 기준선은 보조 파일. DB·Storage 쓰기 0.
 * 시작 때 WFR의 M2·M3 규칙(최소 보유일 0·매도 순위 30)을 같은 코드로 다시 돌려 기록값(-3.76 / 69.54, -0.09 / 52.60)과 소수 둘째 자리까지 같은지 확인하고, 다르면 중단한다.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { simSlots, type SimCand, type SimPos, type SimRun } from "@/lib/slotSim";
import { L_CANDS, L_SLIPPAGE } from "@/lib/megacapTrendConfig";
import { SAT_KSIC_DIVISION_NAMES, SAT_SECTOR_UNCLASSIFIED } from "@/lib/satelliteV1Config";
import { PEAD_DOWNTURNS, PEAD_H_CAGR_GAIN_PP, PEAD_H_MDD_GAIN_PP, PEAD_H_MDD_GAIN_STRONG_PP, PEAD_H_CAGR_FLOOR_PP } from "@/lib/peadConfig";
import { WFR_EVAL_FROM, WFR_TRAIN_LABEL, WFR_PRICE_FEATURES, WFR_FLOW_FEATURES } from "@/lib/walkforwardRankerConfig";
import { LTR_PRIOR_TESTS, LTR_CANDS, LTR_PORT, LTR_REPRO, LTR_REPRO_RULE, LTR_F_DENOMINATOR, LTR_STYLE_FEATURES } from "@/lib/lowTurnoverConfig";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, SNAP_END, f2, avg, median, type S } from "./researchHarness";
import { evaluate, seedReport, yearlyTable, summaryReport, makeWindows, type CandSpec, type Verdict } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
const SAMSUNG = "005930", HYNIX = "000660";
const RANK_EXIT = "순위 밖", OUT_EXIT = "유니버스 이탈", RANDOM_EXIT = "무작위 이탈";
const DIR = process.env.WFR_DIR?.trim() || ".wfr";
type WId = keyof typeof LTR_CANDS;
interface Episode { peakIdx: number; troughIdx: number; recIdx: number | null; depth: number }
interface DayRank { order: Int32Array; stk: Int32Array; rk: Int16Array }
interface Rule { slots: number; sellRank: number; minHold: number; entryTop: number | null }
type RunOpts = { lag: number; int?: number; replace?: Set<string>; detail?: boolean; onDay?: (c: number, V: number, held: [string, number][]) => void };

function episodes(ret: number[]): Episode[] {
  const out: Episode[] = [];
  let E = 1, peak = 1, peakIdx = -1, cur: Episode | null = null, trough = 1;
  for (let i = 0; i < ret.length; i++) {
    E *= 1 + ret[i] / 100;
    if (E >= peak) {
      if (cur) { cur.recIdx = i; out.push(cur); cur = null; }
      peak = E; peakIdx = i; trough = E;
    } else {
      if (!cur) { cur = { peakIdx, troughIdx: i, recIdx: null, depth: 0 }; trough = E; }
      if (E <= trough) { trough = E; cur.troughIdx = i; cur.depth = 1 - E / peak; }
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function main(): Promise<void> {
  console.log(`연구 LTR 시도 251~253 시험 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const only = new Set((process.env.CAND_ONLY || "W1,W2,W3").split(",").map((x) => x.trim()).filter(Boolean));
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { kAt, indOf, nameOf, excluded, membAt } = await loadK200P(h);
  const cEval = CAL.findIndex((d) => d >= WFR_EVAL_FROM);
  if (cEval < 1) throw new Error(`${WFR_EVAL_FROM} 이후 거래일 없음`);
  const cS = cEval - 1;
  const W = makeWindows(h, cS + 1, WFR_TRAIN_LABEL);
  const FULL = W.FULL, ex26 = { from: FULL.from, to: "2025-12-31" };
  if (FULL.from !== WFR_EVAL_FROM) throw new Error(`수익률 집계 시작 ${FULL.from} ≠ ${WFR_EVAL_FROM}`);
  console.log(`평가 첫 판단일 ${CAL[cEval]}(순번 ${cEval}), 수익률 집계 ${FULL.from}~${h.dataEnd} (직전 거래일 ${CAL[cS]}은 현금 대기) | 구간 ${W.NW.map(([n, w]) => `${n} ${w.from}~${w.to}`).join(" / ")}`);

  // ---- 0. 069500 기준선 ----
  console.log(`\n=== 0. 069500 기준선 (수익 집계 ${FULL.from}~; 원주가, 가격 수익만; CAGR % / MDD %) ===\n기존 = etf_daily_prices만(${h.bhPDb.dates[h.bhPDb.dates.length - 1]}까지), 새 = 보조 파일(${h.bhP.dates[h.bhP.dates.length - 1]}까지) — 게이트 A~H는 새 기준선으로 판정\n| 구간 | 기존 | 새 |\n|---|---|---|`);
  for (const [wn, w] of [...W.ALL, ["2026년 제외 (~2025-12-31)", ex26] as [string, typeof ex26]]) {
    const a = h.st(h.bhPDb, w), b = h.st(h.bhP, w);
    console.log(`| ${wn} | ${f2(a.cagr)} / ${f2(a.mdd)} | ${f2(b.cagr)} / ${f2(b.mdd)} |`);
  }
  const bhFrom = { dates: h.bhP.dates.filter((d) => d >= FULL.from), ret: h.bhP.ret.filter((_, k) => h.bhP.dates[k] >= FULL.from) };
  const bhAsRun = { dates: bhFrom.dates, ret: bhFrom.ret } as unknown as SimRun;

  // ---- 입력(저장된 예측 점수) ----
  const meta = JSON.parse(await fs.readFile(path.join(DIR, "meta.json"), "utf8")) as { nRows: number; nCal: number; codes: string[]; cEval: number; featureNames: string[] };
  if (meta.nCal !== nCal || meta.cEval !== cEval || meta.codes.length !== h.stocks.length || meta.codes.some((c, k) => c !== h.stocks[k].code)) throw new Error("저장된 특성·점수 파일의 달력·종목 순서가 현재 하네스와 다르다");
  const readBuf = async (name: string): Promise<Buffer> => fs.readFile(path.join(DIR, name));
  const rd = async <T extends Float32Array | Int32Array>(name: string, Ctor: { new (b: ArrayBuffer): T }): Promise<T> => { const b = await readBuf(name); return new Ctor(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer); };
  const dayIdx = await rd("dayIdx.i32", Int32Array), stockIdx = await rd("stockIdx.i32", Int32Array);
  if (dayIdx.length !== meta.nRows) throw new Error("행 수 불일치");
  const dayStart = new Int32Array(nCal).fill(-1), dayEnd = new Int32Array(nCal).fill(-1);
  for (let r = 0; r < dayIdx.length; r++) { const c = dayIdx[r]; if (dayStart[c] < 0) dayStart[c] = r; dayEnd[c] = r + 1; }
  for (const v of ["M2", "M3"]) console.log(`점수 파일 scores_${v}.f32 SHA-256 ${createHash("sha256").update(await readBuf(`scores_${v}.f32`)).digest("hex")}`);
  console.log(`입력 정합성: 행 ${meta.nRows}, 종목 ${meta.codes.length}개 순서 일치, 모델 재학습 없음`);

  const stockOf = h.stocks, codeIdx = new Map(h.stocks.map((s, k) => [s.code, k]));
  const rankCache = new Map<string, (DayRank | null)[]>();
  const ranksOf = async (v: string): Promise<(DayRank | null)[]> => {
    let a = rankCache.get(v);
    if (a) return a;
    const sc = await rd(`scores_${v}.f32`, Float32Array);
    a = new Array<DayRank | null>(nCal).fill(null);
    for (let c = cEval; c < nCal; c++) {
      const lo = dayStart[c], hi = dayEnd[c];
      if (lo < 0) continue;
      const rows: number[] = [];
      for (let r = lo; r < hi; r++) if (Number.isFinite(sc[r])) rows.push(r);
      if (!rows.length) continue;
      rows.sort((x, y) => sc[y] - sc[x] || (stockOf[stockIdx[x]].code < stockOf[stockIdx[y]].code ? -1 : 1));
      const order = Int32Array.from(rows.map((r) => stockIdx[r]));
      const byStk = [...order].map((si, k) => [si, k + 1] as const).sort((x, y) => x[0] - y[0]);
      a[c] = { order, stk: Int32Array.from(byStk.map((x) => x[0])), rk: Int16Array.from(byStk.map((x) => x[1])) };
    }
    rankCache.set(v, a);
    return a;
  };
  const rankOf = (dr: DayRank, si: number): number | undefined => { let lo = 0, hi = dr.stk.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (dr.stk[m] === si) return dr.rk[m]; if (dr.stk[m] < si) lo = m + 1; else hi = m - 1; } return undefined; };

  // ---- 매매 규칙 ----
  const env = { CAL, nCal, cS, adjustments: h.adjustments, endedBefore: h.endedBefore, stockBuyMult: h.stockBuyMult, sellRate: h.sellRate, baseSlip: SLIPPAGE_PCT_PER_SIDE, bhRet: h.bhRet };
  const envGross = { ...env, baseSlip: 0, stockBuyMult: 1, sellRate: () => 0 };
  const cfgFor = (slots: number, slip: number = LTR_PORT.slip) => ({ slip, maxPos: slots, capFrac: 1 / slots, cooldown: 0 });
  const label = (code: string): string => `${code} ${nameOf.get(code) ?? "?"}`;
  const sectorOf = (c: string): string => indOf.get(c)?.slice(0, 2) ?? SAT_SECTOR_UNCLASSIFIED;
  const secLabel = (g: string): string => (g === SAT_SECTOR_UNCLASSIFIED ? g : `${g} ${SAT_KSIC_DIVISION_NAMES[g] ?? "?"}`);
  /** 진입 후보: entryTop이 있으면 점수 상위 entryTop위 안 종목만(보유 종목은 엔진이 거른다 — 신규가 없으면 빈 슬롯은 현금), 없으면 WFR처럼 상위 depth위까지.
   *  매도: 보유 판단일 수(c − 체결일) ≥ minHold ∧ 순위 > sellRank(그날 점수가 없으면 순위 밖). 최소 보유일 안에서는 순위와 무관하게 유지. */
  const rankHooks = (rk: (DayRank | null)[], rule: Rule, depth: number) => ({
    candsOf: (c: number): SimCand[] => {
      const dr = c >= cEval ? rk[c] : null;
      if (!dr) return [];
      return Array.from(dr.order.slice(0, rule.entryTop ?? depth), (si) => ({ s: stockOf[si] as S, code: stockOf[si].code }));
    },
    exitReason: (p: SimPos, c: number, i: number | undefined): string | null => {
      if (i === undefined || c < cEval) return null;
      if (c - p.entryC < rule.minHold) return null;
      const dr = rk[c];
      if (!dr) return null;
      const r = rankOf(dr, codeIdx.get(p.code) as number);
      if (r === undefined) return OUT_EXIT;
      return r > rule.sellRank ? RANK_EXIT : null;
    },
  });
  const mkRun = (rk: (DayRank | null)[], rule: Rule, depth: number, e: typeof env = env, slip: number = LTR_PORT.slip) => (o: RunOpts): SimRun =>
    simSlots(e, cfgFor(rule.slots, slip), rankHooks(rk, rule, depth), { lag: o.lag, int: o.int, replace: o.replace, detail: o.detail, onDay: o.onDay });

  // ---- 재현 확인: WFR의 M2·M3 규칙(최소 보유일 0·매도 순위 30) ----
  const refRuns: Record<string, SimRun> = {};
  for (const v of ["M2", "M3"] as const) {
    const rk = await ranksOf(v);
    refRuns[v] = mkRun(rk, { slots: LTR_REPRO_RULE.slots, sellRank: LTR_REPRO_RULE.sellRank, minHold: LTR_REPRO_RULE.minHold, entryTop: null }, LTR_REPRO_RULE.depth)({ lag: 1, detail: true });
    const f = h.st(refRuns[v], FULL), tr = h.st(refRuns[v], W.NW[0][1]);
    const ok = f2(f.cagr) === f2(LTR_REPRO[v].cagr) && f2(f.mdd) === f2(LTR_REPRO[v].mdd) && f2(tr.cagr) === f2(LTR_REPRO[v].mix[0]) && f2(tr.mdd) === f2(LTR_REPRO[v].mix[1]);
    console.log(`재현 확인 ${v}(WFR 규칙): 전체 ${f2(f.cagr)} / ${f2(f.mdd)} (기록 ${LTR_REPRO[v].cagr.toFixed(2)} / ${LTR_REPRO[v].mdd.toFixed(2)}), 학습 구간 ${f2(tr.cagr)} / ${f2(tr.mdd)} (기록 ${LTR_REPRO[v].mix[0].toFixed(2)} / ${LTR_REPRO[v].mix[1].toFixed(2)}) → ${ok ? "일치" : "불일치"}`);
    if (!ok) throw new Error(`${v} 재현 불일치 — 저장된 점수가 기존과 다르므로 중단`);
  }

  // ---- 기저 L3 (참고) ----
  const megaCache = new Map<number, { list: S[]; rank: Map<string, number> }>();
  const megaAt = (c: number): { list: S[]; rank: Map<string, number> } => {
    let v = megaCache.get(c);
    if (!v) {
      const d = CAL[c], m = membAt(d), e: { s: S; mc: number }[] = [];
      if (m) for (const s of h.stocks) {
        const i = s.idx.get(d);
        if (i === undefined || excluded.has(s.code) || m.get(s.code) !== "KOSPI") continue;
        e.push({ s, mc: s.mcapRow[i] });
      }
      e.sort((a, b) => b.mc - a.mc || (a.s.code < b.s.code ? -1 : 1));
      const list = e.slice(0, 30).map((x) => x.s);
      v = { list, rank: new Map(list.map((s, k) => [s.code, k + 1])) };
      megaCache.set(c, v);
    }
    return v;
  };
  const l3 = L_CANDS.L3;
  const l3Run = simSlots(env, { slip: L_SLIPPAGE, maxPos: l3.slots, capFrac: 1 / l3.slots, cooldown: 0 }, {
    candsOf: (c: number): SimCand[] => megaAt(c).list.slice(0, l3.entryRank).map((s) => ({ s, code: s.code })),
    exitReason: (p: SimPos, c: number, i: number | undefined): string | null => (i === undefined ? null : (megaAt(c).rank.get(p.code) ?? Number.POSITIVE_INFINITY) > l3.keepRank ? "시총 순위 밖" : null),
  }, { lag: 1, detail: true });
  { const f = h.st(l3Run, FULL); console.log(`기저 L3(참고) 재계산: 전체 CAGR ${f2(f.cagr)} / MDD ${f2(f.mdd)}`); }

  // ---- 공통 보고 ----
  const hVs = (full: { cagr: number; mdd: number }, rb: { cagr: number; mdd: number }): { ok: boolean; text: string } => {
    const dc = full.cagr - rb.cagr, dm = rb.mdd - full.mdd;
    const c1 = dc >= PEAD_H_CAGR_GAIN_PP, c2 = dm >= PEAD_H_MDD_GAIN_PP && dc >= -PEAD_H_CAGR_FLOOR_PP;
    return { ok: c1 || c2, text: `CAGR ${dc >= 0 ? "+" : ""}${f2(dc)}%p, MDD ${dm >= 0 ? "−" : "+"}${f2(Math.abs(dm))}%p(개선 ${f2(dm)}%p; ${PEAD_H_MDD_GAIN_STRONG_PP}%p 이상 ${dm >= PEAD_H_MDD_GAIN_STRONG_PP ? "O" : "X"}) → 조건1(CAGR +${PEAD_H_CAGR_GAIN_PP}%p) ${c1 ? "O" : "X"}, 조건2(MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p) ${c2 ? "O" : "X"}` };
  };
  const inWin = (d: string, w: { from: string; to: string }): boolean => d >= w.from && d <= w.to;
  const pct = (a: number, b: number): string => f2((a / Math.max(b, 1)) * 100);
  const quant = (v: number[], ps: number[]): string => { const a = [...v].sort((x, y) => x - y); return ps.map((p) => `${Math.round(p * 100)}%=${a.length ? f2(a[Math.min(Math.floor(a.length * p), a.length - 1)]) : "-"}`).join(" / "); };
  const mktAll: number[] = [];
  for (let c = cS + 1; c < nCal; c++) { const r = h.bhRet.get(CAL[c]); if (r !== undefined) mktAll.push(r * 100); }
  // 스타일 쏠림: 보유 종목의 횡단면 순위 정규화 특성 평균(0 = 그날 K200P 최소, 1 = 최대, 유니버스 평균 0.5)
  const X = await rd("X.f32", Float32Array);
  const fIdx = LTR_STYLE_FEATURES.map((f) => [...WFR_PRICE_FEATURES, ...WFR_FLOW_FEATURES].indexOf(f as never));
  if (fIdx.some((k) => k < 0) || meta.featureNames.length !== WFR_PRICE_FEATURES.length + WFR_FLOW_FEATURES.length) throw new Error("스타일 특성 열을 찾지 못했다");
  const rowOf = (c: number, si: number): number => { for (let r = dayStart[c]; r < dayEnd[c]; r++) if (stockIdx[r] === si) return r; return -1; };
  const styleLine = (id: string, rerun: (o: RunOpts) => SimRun): void => {
    const sum = fIdx.map(() => 0);
    let wsum = 0, days = 0;
    rerun({ lag: 1, onDay: (c, V, held) => { if (!held.length || c < cEval) return; days++; for (const [code, val] of held) { const r = rowOf(c, codeIdx.get(code) as number); if (r < 0) continue; const w = val / V; wsum += w; fIdx.forEach((k, j) => { const x = X[r * meta.featureNames.length + k]; if (Number.isFinite(x)) sum[j] += w * x; }); } } });
    console.log(`${id} 보유 종목 스타일(보유 평가액 가중 평균 순위, 0 = 그날 K200P 최소 ~ 1 = 최대, 유니버스 평균 0.50; 보유 있는 ${days}일): ${LTR_STYLE_FEATURES.map((f, j) => `${f} ${f2(sum[j] / Math.max(wsum, 1e-12))}`).join(" | ")}`);
  };

  const commonExtra = (id: string, run: SimRun, rerun: (o: RunOpts) => SimRun, rerunGross: (o: RunOpts) => SimRun, rule: Rule): void => {
    const E = (name: string, r: SimRun): void => { for (const [wn, w] of W.ALL) { const s = h.st(r, w), b = h.st(h.bhP, w); console.log(`  ${name} | ${wn}: CAGR ${f2(s.cagr)} / MDD ${f2(s.mdd)} (069500 ${f2(b.cagr)} / ${f2(b.mdd)})`); } };
    const yrs = (Date.parse(h.dataEnd) - Date.parse(FULL.from)) / 86_400_000 / 365.25;
    console.log(`${id} 구간별 진입·보유·현금·회전율·비용 (비용 합계 % = 구간 안 일별 비용 합)\n| 구간 | 진입 건수 | 평균 동시 보유(전체 날) | 보유 있는 날 평균 | 슬롯 다 찬 날 % | 평균 투자 비중 % | 현금 비중 % | 현금 100% 일수 / 일수 | 연 회전율 % | 비용 합계 % |\n|---|---|---|---|---|---|---|---|---|---|`);
    for (const [wn, w] of W.ALL) {
      const idx: number[] = [];
      for (let i = 0; i < run.dates.length; i++) if (inWin(run.dates[i], w)) idx.push(i);
      const s = h.st(run, w), nPos = idx.map((i) => run.nPos[i]);
      console.log(`| ${wn} | ${run.entryCs.filter((c) => inWin(CAL[c], w)).length} | ${f2(avg(nPos))} | ${f2(avg(nPos.filter((x) => x > 0)))} | ${pct(nPos.filter((x) => x >= rule.slots).length, nPos.length)} | ${f2(s.avgInv)} | ${f2(100 - s.avgInv)} | ${nPos.filter((x) => x === 0).length} / ${idx.length} | ${f2(s.turnover)} | ${f2(s.cost)} |`);
    }
    const fs0 = h.st(run, FULL);
    console.log(`${id} 합계 비용 ${f2(fs0.cost)}% (연평균 ${f2(fs0.cost / yrs)}%, ${f2(yrs)}년) | 연 회전율 ${f2(fs0.turnover)}%`);
    const gross = rerunGross({ lag: 1, detail: true });
    console.log(`${id} 비용 제외 총수익(gross: 수수료·거래세·슬리피지 0) 대비 순수익(net) — CAGR % / MDD %\n| 구간 | gross | net | CAGR 차이 %p | net 구간 비용 합계 % |\n|---|---|---|---|---|`);
    for (const [wn, wd] of W.ALL) { const g = h.st(gross, wd), n = h.st(run, wd); console.log(`| ${wn} | ${f2(g.cagr)} / ${f2(g.mdd)} | ${f2(n.cagr)} / ${f2(n.mdd)} | ${f2(g.cagr - n.cagr)} | ${f2(n.cost)} |`); }
    console.log(`${id} 낙폭 상위 3개 구간 (고점 → 저점 → 회복)`);
    const topEp = (ser: { dates: string[]; ret: number[] }, name: string): void => {
      const ii: number[] = [];
      for (let i = 0; i < ser.dates.length; i++) if (ser.dates[i] >= FULL.from) ii.push(i);
      const dts = ii.map((i) => ser.dates[i]), eps = episodes(ii.map((i) => ser.ret[i])).sort((a, b) => b.depth - a.depth).slice(0, 3);
      console.log(`  ${name}: ${eps.map((e, kk) => `${kk + 1}) 고점 ${e.peakIdx < 0 ? FULL.from : dts[e.peakIdx]} → 저점 ${dts[e.troughIdx]} ${f2(e.depth * 100)}% → 회복 ${e.recIdx === null ? "미회복" : dts[e.recIdx]}`).join(" | ")}`);
    };
    topEp(run, id); topEp(h.bhP, "069500(새)");
    console.log(`${id} 하락 구간 성과 (누적 % / MDD %): 후보 | 069500(새) | M2 | M3 | L3(참고)`);
    for (const [name, f, t] of PEAD_DOWNTURNS) console.log(`  ${name}: ${id} ${h.periodStat(run, f, t)} | 069500 ${h.periodStat(h.bhP, f, t)} | M2 ${h.periodStat(refRuns.M2, f, t)} | M3 ${h.periodStat(refRuns.M3, f, t)} | L3 ${h.periodStat(l3Run, f, t)}`);
    console.log(`${id} 하루 지연(lag 2) 구간별 성적`);
    E(`${id} lag 2`, rerun({ lag: 2, detail: true }));
    const top3 = [...run.trades].sort((a, b) => (b.proceeds - b.spend) / b.vAtEntry - (a.proceeds - a.spend) / a.vAtEntry).slice(0, 3);
    console.log(`${id} 상위 3개 거래(${top3.map((t) => `${label(t.code)} ${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")})를 069500 수익률로 바꾼 구간별 성적(= 제외)`);
    E(`${id} 상위 3개 거래 대체`, rerun({ lag: 1, detail: true, replace: new Set(top3.map((t) => `${t.code}|${t.entryC}`)) }));
    const secN = new Map<string, number>();
    for (const t of run.trades) secN.set(sectorOf(t.code), (secN.get(sectorOf(t.code)) ?? 0) + 1);
    console.log(`${id} 업종별(KSIC 2자리) 진입 분포(닫힌 거래 ${run.trades.length}건): ${[...secN].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([g, n]) => `${secLabel(g)} ${n}건(${pct(n, run.trades.length)}%)`).join(" | ")}`);
    const yearN = new Map<string, number>();
    for (const c of run.entryCs) yearN.set(CAL[c].slice(0, 4), (yearN.get(CAL[c].slice(0, 4)) ?? 0) + 1);
    console.log(`${id} 연도별 진입 건수: ${[...yearN].sort().map(([y, n]) => `${y} ${n}`).join(" | ")}`);
    const wsum = new Map<string, number>();
    let nDays = 0, invSum = 0;
    rerun({ lag: 1, onDay: (_c, V, held) => { nDays++; for (const [code, val] of held) { wsum.set(code, (wsum.get(code) ?? 0) + val / V); invSum += val / V; } } });
    const wavg = (code: string): number => ((wsum.get(code) ?? 0) / Math.max(nDays, 1)) * 100;
    console.log(`${id} 일별 평균 계좌 비중(현금 날 포함; ${nDays}일): 삼성전자 ${f2(wavg(SAMSUNG))}% · SK하이닉스 ${f2(wavg(HYNIX))}% · 합 ${f2(wavg(SAMSUNG) + wavg(HYNIX))}% | 투자분 중 두 종목 비중 ${f2(((wsum.get(SAMSUNG) ?? 0) + (wsum.get(HYNIX) ?? 0)) / Math.max(invSum, 1e-12) * 100)}% | 상위 8: ${[...wsum].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c2, v]) => `${label(c2)} ${f2((v / Math.max(nDays, 1)) * 100)}%`).join(", ")}`);
    styleLine(id, rerun);
    const pnls = run.trades.map((t) => (t.proceeds - t.spend) / t.vAtEntry), totPnl = pnls.reduce((a, x) => a + x, 0), top10 = [...pnls].sort((a, b) => b - a).slice(0, 10).reduce((a, x) => a + x, 0);
    console.log(`${id} 상위 10개 거래 손익 비중: 전 거래 손익 합(진입 시 계좌 대비) ${f2(totPnl * 100)}%p 중 상위 10개 ${f2(top10 * 100)}%p = ${f2(totPnl !== 0 ? (top10 / totPnl) * 100 : NaN)}%`);
    const rets = run.trades.map((t) => (t.proceeds / t.spend - 1) * 100), wins = rets.filter((x) => x > 0), loss = rets.filter((x) => x <= 0);
    console.log(`${id} 거래당 통계(닫힌 거래 ${rets.length}건): 평균 수익 ${f2(avg(rets))}% / 중앙값 ${f2(median(rets))}% | 승률 ${pct(wins.length, rets.length)}% | 평균 이익 ${f2(avg(wins))}% / 평균 손실 ${f2(avg(loss))}% → 손익비 ${f2(Math.abs(avg(wins) / avg(loss)))}`);
    const hd = run.trades.map((t) => t.exitC - t.entryC);
    console.log(`${id} 보유 거래일 수(체결 간격; 닫힌 거래 ${hd.length}건): 평균 ${f2(avg(hd))} / 중앙값 ${f2(median(hd))} | 분포 ${quant(hd, [0.05, 0.25, 0.5, 0.75, 0.95])} | 최대 ${hd.length ? Math.max(...hd) : "-"}`);
    const rs = new Map<string, number>();
    for (const t of run.trades) rs.set(t.reason, (rs.get(t.reason) ?? 0) + 1);
    console.log(`${id} 청산 사유별 건수: ${[...rs].map(([k, v]) => `${k} ${v}건(${pct(v, run.trades.length)}%)`).join(" | ")} | 기간 끝 보유 중 ${run.entryCs.length - run.trades.length}건`);
    const sm: number[] = [];
    for (const c of run.entryCs) { const r = h.bhRet.get(CAL[c - 1]); if (r !== undefined) sm.push(r * 100); }
    console.log(`${id} 진입 판단일 시장(069500) 일수익률 분포: 진입 ${sm.length}건 중 시장이 오른 날 ${pct(sm.filter((x) => x > 0).length, sm.length)}%, 평균 ${f2(avg(sm))}% | 비교 전체 거래일 ${mktAll.length}일: 오른 날 ${pct(mktAll.filter((x) => x > 0).length, mktAll.length)}%, 평균 ${f2(avg(mktAll))}%`);
  };

  // ---- 후보 명세 ----
  const specs: CandSpec[] = [];
  const baseRuns = new Map<string, SimRun>();
  const mkW = async (id: WId): Promise<CandSpec> => {
    const cd = LTR_CANDS[id];
    const rk = await ranksOf(cd.score);
    const rule: Rule = { slots: LTR_PORT.slots, sellRank: cd.sellRank, minHold: cd.minHold, entryTop: LTR_PORT.entryTop };
    const run1 = mkRun(rk, rule, 0);
    const nb: { label: string; run: () => SimRun }[] = [];
    for (const r of cd.nbSellRank) nb.push({ label: `매도 순위 ${r}`, run: () => mkRun(rk, { ...rule, sellRank: r }, 0)({ lag: 1 }) });
    for (const m of cd.nbMinHold) nb.push({ label: `최소 보유 ${m}거래일`, run: () => mkRun(rk, { ...rule, minHold: m }, 0)({ lag: 1 }) });
    return {
      id, trial: cd.trial, title: `K200P, ${cd.score} 점수(WFR 저장 점수 재사용) 상위 ${LTR_PORT.entryTop}위 안 신규 종목 동일가중(최대 ${LTR_PORT.slots}종목), 보유 ${cd.minHold}거래일 이상 경과 ∧ 순위 ${cd.sellRank}위 밖일 때만 매도, 신호 확정일 종가 → 다음 거래일 종가 체결, 슬리피지 ${LTR_PORT.slip * 100}%`,
      defense: false, capFrac: 1 / LTR_PORT.slots, fDenominator: LTR_F_DENOMINATOR, ref: { id: "069500", run: bhAsRun },
      hRule: (full, rb) => { const a = hVs(full, rb); const l = h.st(l3Run, FULL), rm = h.st(refRuns[cd.score], FULL); return { ok: a.ok, note: `${a.text} | 참고(판정 아님): ${cd.score}(WFR 규칙) ${f2(rm.cagr)} / ${f2(rm.mdd)}, L3 ${f2(l.cagr)} / ${f2(l.mdd)}` }; } ,
      run: (o) => { const r = run1(o); if (o.lag === 1 && o.detail && !o.replace) baseRuns.set(id, r); return r; },
      neighbors: nb,
      random: (rng, ordersByDay) => {
        const base = baseRuns.get(id);
        const exits = base ? base.trades.filter((t) => t.reason === RANK_EXIT || t.reason === OUT_EXIT).length : 0;
        const elig = base ? base.trades.reduce((a, t) => a + Math.max(0, t.exitC - t.entryC - cd.minHold), 0) : 1;
        const q = exits / Math.max(elig, 1);
        return simSlots(env, cfgFor(LTR_PORT.slots), {
          candsOf: (c, held, blocked) => {
            const n = ordersByDay.get(c) ?? 0;
            if (!n || c < cEval) return [];
            const pool = kAt(CAL[c]).filter((s) => !held(s.code) && !blocked(s.code));
            const left = [...pool], out: SimCand[] = [];
            while (out.length < n && left.length) { const s = left.splice(Math.floor(rng() * left.length), 1)[0]; out.push({ s, code: s.code }); }
            return out;
          },
          exitReason: (p, c, i) => (i !== undefined && c - p.entryC >= cd.minHold && rng() < q ? RANDOM_EXIT : null),
        }, { lag: 1 });
      },
      reasons: [RANK_EXIT, OUT_EXIT, "폐지"],
      label,
      extra: (run) => {
        commonExtra(id, run, (o) => run1(o), mkRun(rk, rule, 0, envGross, 0), rule);
        const base = run;
        console.log(`${id} 게이트 F 무작위 대조 정의: 실제 진입 판단일·진입 수와 같게 그날 K200P에서 무작위 종목을 뽑고, 최소 보유 ${cd.minHold}거래일 경과 뒤 매일 확률 q = (순위 이탈 청산 ${base.trades.filter((t) => t.reason === RANK_EXIT || t.reason === OUT_EXIT).length}건 ÷ 최소 보유일 경과 후 보유 판단일 합 ${base.trades.reduce((a, t) => a + Math.max(0, t.exitC - t.entryC - cd.minHold), 0)}일)로 이탈`);
      },
    };
  };

  const order: WId[] = (["W1", "W2", "W3"] as const).filter((id) => only.has(id));
  const verdicts: Verdict[] = [];
  for (const id of order) { const sp = await mkW(id); specs.push(sp); verdicts.push(evaluate(h, W, sp)); }

  console.log(`\n=== 구간별 CAGR / MDD — 069500(새 기준선) · M2 · M3 · L3(참고, 같은 코드로 재계산) · 후보 ===\n| 구간 | 069500 | M2(WFR 규칙) | M3(WFR 규칙) | L3 | ${verdicts.map((v) => v.id).join(" | ")} |\n|---|---|---|---|---|${verdicts.map(() => "---").join("|")}|`);
  for (const [wn, w] of [...W.ALL, ["2026년 제외 (~2025-12-31)", ex26] as [string, typeof ex26]]) {
    const cell = (r: { dates: string[]; ret: number[] }): string => { const s = h.st(r, w); return `${f2(s.cagr)} / ${f2(s.mdd)}`; };
    console.log(`| ${wn} | ${cell(h.bhP)} | ${cell(refRuns.M2)} | ${cell(refRuns.M3)} | ${cell(l3Run)} | ${verdicts.map((v) => cell(v.run)).join(" | ")} |`);
  }
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: LTR_PRIOR_TESTS });
  yearlyTable(h, W, [{ id: "L3(재계산)", run: l3Run }, { id: "M2(WFR 규칙)", run: refRuns.M2 }, { id: "M3(WFR 규칙)", run: refRuns.M3 }, ...verdicts.map((v) => ({ id: v.id, run: v.run }))]);
  seedReport(h, W, specs, new Map(verdicts.map((v) => [v.id, v.run])), (code, c) => { const s = byCode.get(code)!, i = s.idx.get(CAL[c]); return i === undefined ? NaN : s.avgTvRow[i]; });
  console.log(`\n=== 비교용: WFR 규칙(최소 보유일 0·매도 순위 30)의 보유 종목 스타일 (같은 정의) ===`);
  for (const v of ["M2", "M3"] as const) styleLine(v, mkRun(await ranksOf(v), { slots: LTR_REPRO_RULE.slots, sellRank: LTR_REPRO_RULE.sellRank, minHold: LTR_REPRO_RULE.minHold, entryTop: null }, LTR_REPRO_RULE.depth));
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${verdicts.map((v) => v.trial).join(", ")}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

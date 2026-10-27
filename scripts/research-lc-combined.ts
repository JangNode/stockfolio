/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 LC: 변동성 목표화(연구 LV 정의) + 절대 모멘텀 청산(연구 AM2 정의)을 함께 쓰는 LC1(232)·LC2(233)·LC3(234). 후보당 1회 실행.
 * 사전 등록: docs/research/combined-protection-prereg.md. 가격 Parquet은 고정 스냅샷(데이터 종료일 2026-10-26, PARQUET_CACHE_FROZEN=1)에서만 읽고, 069500 기준선은 보조 파일(BENCH_AUX_069500=1,
 * SHA-256 대조)로 데이터 종료일까지 채운 값을 쓴다. DB·Storage 쓰기 0. 환경 변수 CAND_ONLY는 크래시 복구 전용.
 * 표의 비교 열 LE2·L3·LV·AM2는 같은 스냅샷으로 다시 계산한다(시도 수에 넣지 않음).
 */
import { simSlots, type SimCand, type SimPos, type SimRun, type SimVt } from "@/lib/slotSim";
import { L_CANDS, L_SLIPPAGE, L_EVAL_AFTER } from "@/lib/megacapTrendConfig";
import { LS_COOLDOWN_DAYS } from "@/lib/megacapTrailingConfig";
import { LE_CANDS, LE_LEGS, LE_ENTRY_LEG, LE_RANK_DEPTH } from "@/lib/momentumEnsembleConfig";
import { AM_CANDS, AM_H_CAGR_GAIN_PP, AM_H_MDD_GAIN_PP, AM_H_MDD_GAIN_STRONG_PP, AM_H_CAGR_FLOOR_PP, AM_EXIT_REASON, type AmLeg } from "@/lib/le2AbsMomentumConfig";
import { LV_CANDS, LV_WINDOW, LV_ANNUAL_DAYS, LV_ROUND_DP, LV_BAND, LV_LOW_MULT } from "@/lib/le2VolTargetConfig";
import { LC_CANDS, LC_PRIOR_TESTS, LC2_KEEP_RANK_NEIGHBORS, LC_LV_NEAREST, LC_REFS, LC2_AM_REENTRY_BAN_DAYS, LC_DOWNTURNS } from "@/lib/combinedProtectionConfig";
import { rankEnsemble, outsiderEnsembleRank, type EnsembleRanking } from "@/lib/momentumEnsemble";
import { alignCloses, equalWeightSigma, volMultiplier } from "@/lib/le2VolTarget";
import { absMomentumTriggered, legReturn } from "@/lib/le2AbsMomentum";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, SNAP_END, f2, avg, median, type S } from "./researchHarness";
import { evaluate, makeWindows, seedReport, yearlyTable, summaryReport, type CandSpec, type Verdict } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
type CId = keyof typeof LC_CANDS;
const SAMSUNG = "005930", HYNIX = "000660";
const LE2 = LE_CANDS.LE2, L3 = L_CANDS.L3, AM2 = AM_CANDS.AM2;
interface Episode { peakIdx: number; troughIdx: number; recIdx: number | null; depth: number }

/** 일수익률(%) 열로 낙폭 구간을 나눈다: 직전 고점 → 저점 → 직전 고점 회복. idx −1 = 첫 수익률 이전(시작). */
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
  console.log(`연구 LC 시험 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const only = new Set((process.env.CAND_ONLY || "LC1,LC2,LC3").split(",").map((x) => x.trim()).filter(Boolean));
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, nameOf } = await loadK200P(h);
  const cS = CAL.findIndex((d) => d >= L_EVAL_AFTER);
  if (cS < 0) throw new Error(`${L_EVAL_AFTER} 이후 거래일 없음`);
  const W = makeWindows(h, cS + 1);
  console.log(`평가 시작 판단일 ${CAL[cS]}(달력 순번 ${cS}), 수익률 집계 ${CAL[cS + 1]}~${h.dataEnd} | 구간 ${W.NW.map(([n, w]) => `${n} ${w.from}~${w.to}`).join(" / ")}`);

  // ---- 0. 069500 기준선: 보조 파일(새) vs DB만(기존) ----
  const ex26 = { from: W.FULL.from, to: "2025-12-31" };
  console.log(`\n=== 0. 069500 기준선 정합 (원주가, 가격 수익만; CAGR % / MDD %) ===\n기존 = etf_daily_prices만(${h.bhPDb.dates[h.bhPDb.dates.length - 1]}까지), 새 = 보조 파일(${h.bhP.dates[h.bhP.dates.length - 1]}까지)\n| 구간 | 기존 | 새 | 차이 CAGR %p / MDD %p |\n|---|---|---|---|`);
  for (const [wn, w] of [...W.ALL, ["2026년 제외 (~2025-12-31)", ex26] as [string, typeof ex26]]) {
    const a = h.st(h.bhPDb, w), b = h.st(h.bhP, w);
    console.log(`| ${wn} | ${f2(a.cagr)} / ${f2(a.mdd)} | ${f2(b.cagr)} / ${f2(b.mdd)} | ${b.cagr - a.cagr >= 0 ? "+" : ""}${f2(b.cagr - a.cagr)} / ${b.mdd - a.mdd >= 0 ? "+" : ""}${f2(b.mdd - a.mdd)} |`);
  }
  const bEp = episodes(h.bhP.ret).sort((a, b) => b.depth - a.depth)[0];
  console.log(`새 기준선 최대 낙폭: 고점 ${h.bhP.dates[bEp.peakIdx] ?? h.bhP.dates[0]} → 저점 ${h.bhP.dates[bEp.troughIdx]} ${f2(bEp.depth * 100)}% (회복 ${bEp.recIdx === null ? "미회복" : h.bhP.dates[bEp.recIdx]}) | 새 기준선 마지막 날짜 ${h.bhP.dates[h.bhP.dates.length - 1]} (스냅샷 전략과 같은 날)`);

  // ---- 시총 순위·앙상블 점수(연구 LE·LV·AM과 같다) ----
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
      const list = e.slice(0, LE_RANK_DEPTH).map((x) => x.s);
      v = { list, rank: new Map(list.map((s, k) => [s.code, k + 1])) };
      megaCache.set(c, v);
    }
    return v;
  };
  const legRets = (s: S, i: number): number[] => LE_LEGS.map((lg) => legReturn(s.close, i, lg));
  const ensCache = new Map<number, EnsembleRanking & { sOf: Map<string, S> }>();
  const ensAt = (c: number): EnsembleRanking & { sOf: Map<string, S> } => {
    let v = ensCache.get(c);
    if (!v) {
      const d = CAL[c], items: { code: string; rets: number[] }[] = [], sOf = new Map<string, S>();
      for (const s of megaAt(c).list.slice(0, LE2.pool)) {
        const rets = legRets(s, s.idx.get(d)!);
        if (rets.every(Number.isFinite)) { items.push({ code: s.code, rets }); sOf.set(s.code, s); }
      }
      v = { ...rankEnsemble(items), sOf };
      ensCache.set(c, v);
    }
    return v;
  };
  const env = { CAL, nCal, cS, adjustments: h.adjustments, endedBefore: h.endedBefore, stockBuyMult: h.stockBuyMult, sellRate: h.sellRate, baseSlip: SLIPPAGE_PCT_PER_SIDE, bhRet: h.bhRet };
  const label = (code: string): string => `${code} ${nameOf.get(code) ?? "?"}`;
  const cfgLe2 = (vt?: SimVt) => ({ slip: L_SLIPPAGE, maxPos: LE2.slots, capFrac: 1 / LE2.slots, cooldown: LS_COOLDOWN_DAYS, vt });
  const cfgL3 = (vt?: SimVt) => ({ slip: L_SLIPPAGE, maxPos: L3.slots, capFrac: 1 / L3.slots, cooldown: 0, vt });
  type Am = { legs: readonly AmLeg[]; minNeg: number };
  const AM_DEF: Am = { legs: AM2.legs, minNeg: AM2.minNeg };

  /** LE2 훅(연구 AM과 같다): 편입 = 풀 안 앙상블 순위 ≤ 5 ∧ 12-1개월 > 0, 청산 = 시총 순위 > 40 → 앙상블 순위 > 10 → (am이 있으면) 절대 모멘텀. */
  const le2Hooks = (am?: Am, exclude?: Set<string>) => ({
    candsOf: (c: number): SimCand[] => {
      const en = ensAt(c), out: SimCand[] = [];
      for (let k = 0; k < LE2.slots && k < en.items.length; k++) { const it = en.items[k]; if (it.rets[LE_ENTRY_LEG] > 0 && !exclude?.has(it.code)) out.push({ s: en.sOf.get(it.code)!, code: it.code }); }
      return out;
    },
    exitReason: (p: SimPos, c: number, i: number | undefined): string | null => {
      if (i === undefined) return null;
      if ((megaAt(c).rank.get(p.code) ?? Number.POSITIVE_INFINITY) > LE2.keepCap) return "시총 순위 밖";
      const s = byCode.get(p.code)!, rets = legRets(s, i);
      if (rets.every(Number.isFinite)) {
        const en = ensAt(c);
        const r = en.rank.get(p.code) ?? outsiderEnsembleRank(en, rets);
        if (r > LE2.keepRank) return "앙상블 순위 밖";
      }
      if (am && absMomentumTriggered(am.legs.map((lg) => legReturn(s.close, i, lg)), am.minNeg) === true) return AM_EXIT_REASON;
      return null;
    },
  });
  /**
   * L3 훅(연구 L·LE의 L3와 같다): 편입 = 시총 상위 5위 안(필터 없음), 청산 = 시총 순위 > keepRank. am이 있으면 그 뒤에 절대 모멘텀 청산을 보고,
   * 절대 모멘텀으로 청산한 종목은 LC2_AM_REENTRY_BAN_DAYS 거래일 동안 재편입 후보에서 뺀다(명세 공백 보완, lib/combinedProtectionConfig.ts). 상태는 이 훅 묶음 하나(= 시뮬레이션 한 번)에만 쓴다.
   */
  const l3Hooks = (am?: Am, keepRank: number = L3.keepRank, exclude?: Set<string>) => {
    const amAt = new Map<string, number>();
    const banned = (code: string, c: number): boolean => { const x = amAt.get(code); return x !== undefined && c - x < LC2_AM_REENTRY_BAN_DAYS; };
    return {
      banned,
      candsOf: (c: number): SimCand[] => megaAt(c).list.slice(0, L3.entryRank).filter((s) => !exclude?.has(s.code) && !banned(s.code, c)).map((s) => ({ s, code: s.code })),
      exitReason: (p: SimPos, c: number, i: number | undefined): string | null => {
        if (i === undefined) return null;
        if ((megaAt(c).rank.get(p.code) ?? Number.POSITIVE_INFINITY) > keepRank) return "시총 순위 밖";
        if (am && absMomentumTriggered(am.legs.map((lg) => legReturn(byCode.get(p.code)!.close, i, lg)), am.minNeg) === true) { amAt.set(p.code, c); return AM_EXIT_REASON; }
        return null;
      },
    };
  };

  // ---- 변동성 목표화(연구 LV와 같다) ----
  const alignedCache = new Map<string, Float64Array>();
  const alignedOf = (code: string): Float64Array => {
    let a = alignedCache.get(code);
    if (!a) { const s = byCode.get(code)!; a = alignCloses(CAL, s.idx, s.close); alignedCache.set(code, a); }
    return a;
  };
  const vtFor = (target: number): SimVt => ({ sizeMult: (c, stocks) => volMultiplier(equalWeightSigma(stocks.map((s) => alignedOf(s.code)), c, LV_WINDOW, LV_ANNUAL_DAYS), target, LV_ROUND_DP), band: LV_BAND });

  // ---- 비교 열: LE2·L3·LV1·LV2·AM2 (같은 스냅샷·엔진으로 다시 계산) ----
  const le2Run = simSlots(env, cfgLe2(), le2Hooks(), { lag: 1, detail: true });
  const l3Run = simSlots(env, cfgL3(), l3Hooks(), { lag: 1, detail: true });
  const lvRun: Record<"LV1" | "LV2", SimRun> = {
    LV1: simSlots(env, cfgLe2(vtFor(LV_CANDS.LV1.target)), le2Hooks(), { lag: 1, detail: true }),
    LV2: simSlots(env, cfgLe2(vtFor(LV_CANDS.LV2.target)), le2Hooks(), { lag: 1, detail: true }),
  };
  const am2Run = simSlots(env, cfgLe2(), le2Hooks(AM_DEF), { lag: 1, detail: true });
  const refs: [string, SimRun, { cagr: number; mdd: number } | undefined][] = [["LE2", le2Run, LC_REFS.LE2], ["L3", l3Run, LC_REFS.L3], ["LV1", lvRun.LV1, LC_REFS.LV1], ["LV2", lvRun.LV2, LC_REFS.LV2], ["AM2", am2Run, undefined]];
  for (const [name, run, ref] of refs) {
    const s = h.st(run, W.FULL);
    console.log(`비교 열 ${name} 재계산(고정 스냅샷): 전체 CAGR ${f2(s.cagr)} / MDD ${f2(s.mdd)}${ref ? ` — 이전 시험 ${ref.cagr.toFixed(2)} / ${ref.mdd.toFixed(2)}와 ${Math.abs(s.cagr - ref.cagr) < 0.006 && Math.abs(s.mdd - ref.mdd) < 0.006 ? "일치" : "불일치(보고만, 중단 안 함)"}` : " (이전 시험 값은 AM 시험 보고 참조)"}`);
  }

  const bhFrom: { dates: string[]; ret: number[] } = { dates: h.bhP.dates.filter((d) => d >= W.FULL.from), ret: h.bhP.ret.filter((_, k) => h.bhP.dates[k] >= W.FULL.from) };
  const hVs = (full: { cagr: number; mdd: number }, rb: { cagr: number; mdd: number }): { ok: boolean; text: string } => {
    const dc = full.cagr - rb.cagr, dm = rb.mdd - full.mdd;
    const c1 = dc >= AM_H_CAGR_GAIN_PP, c2 = dm >= AM_H_MDD_GAIN_PP && dc >= -AM_H_CAGR_FLOOR_PP;
    return { ok: c1 || c2, text: `CAGR ${dc >= 0 ? "+" : ""}${f2(dc)}%p, MDD ${dm >= 0 ? "−" : "+"}${f2(Math.abs(dm))}%p(개선 ${f2(dm)}%p; ${AM_H_MDD_GAIN_STRONG_PP}%p 이상 ${dm >= AM_H_MDD_GAIN_STRONG_PP ? "O" : "X"}) → 조건1(CAGR +${AM_H_CAGR_GAIN_PP}%p) ${c1 ? "O" : "X"}, 조건2(MDD 개선 ${AM_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${AM_H_CAGR_FLOOR_PP}%p) ${c2 ? "O" : "X"}` };
  };
  const inWin = (d: string, w: { from: string; to: string }): boolean => d >= w.from && d <= w.to;
  const addDays = (d: string, n: number): string => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

  const mkSpec = (id: CId): CandSpec => {
    const cd = LC_CANDS[id], isL3 = cd.base === "L3", baseRun = isL3 ? l3Run : le2Run, lvName = LC_LV_NEAREST[id];
    const slots = isL3 ? L3.slots : LE2.slots, cfgOf = isL3 ? cfgL3 : cfgLe2, cfg = cfgOf(vtFor(cd.target));
    const hooksOf = (o: { am?: Am; keepRank?: number; exclude?: Set<string> }) => (isL3 ? l3Hooks(o.am, o.keepRank, o.exclude) : le2Hooks(o.am, o.exclude));
    const nb: { label: string; run: () => SimRun }[] = [];
    for (const t of cd.sigmaNeighbors) nb.push({ label: `목표 변동성 ${Math.round(t * 100)}% (절대 모멘텀 AM2 그대로)`, run: () => simSlots(env, cfgOf(vtFor(t)), hooksOf({ am: AM_DEF }), { lag: 1 }) });
    if (isL3) for (const k of LC2_KEEP_RANK_NEIGHBORS) nb.push({ label: `L3 청산 순위 한도 ${k}`, run: () => simSlots(env, cfg, l3Hooks(AM_DEF, k), { lag: 1 }) });
    else for (const v of AM2.neighbors) nb.push({ label: v.label, run: () => simSlots(env, cfg, le2Hooks({ legs: v.legs, minNeg: AM2.minNeg }), { lag: 1 }) });
    const baseTitle = isL3 ? "L3(시총 상위 5위 안 편입, 순위 10위 밖 매도, 종목당 20%)" : "LE2(시총 상위 30위 풀, 3·6·12-1개월 백분위 평균 상위 5개, 앙상블 10위 밖·시총 40위 밖 매도, 12-1개월 0 이하 편입 금지, 재진입 20거래일 금지)";
    return {
      id, trial: cd.trial, title: `${baseTitle} + 절대 모멘텀 청산 AM2(3·6·12-1개월 수익률 중 2개 이상 0 이하이면 다음 거래일 종가 매도) + 변동성 목표화(직전 ${LV_WINDOW}거래일 σ, 목표 ${Math.round(cd.target * 100)}%, 배율 = min(1, 목표 ÷ σ) 소수 ${LV_ROUND_DP}자리, 실제 배율과 ${LV_BAND} 이상 차이일 때만 조정)`,
      defense: false, capFrac: 1 / slots, fDenominator: 3, ref: { id: cd.base, run: baseRun },
      hRule: (full, base) => { const a = hVs(full, base), lv = h.st(lvRun[lvName], W.FULL), am = h.st(am2Run, W.FULL); return { ok: a.ok, note: `기저 ${cd.base} ${f2(base.cagr)} / ${f2(base.mdd)} 대비 ${a.text} | 참고(판정 아님): ${lvName} 단독 ${f2(lv.cagr)} / ${f2(lv.mdd)}, AM2 단독 ${f2(am.cagr)} / ${f2(am.mdd)}` }; },
      run: (o) => simSlots(env, cfg, hooksOf({ am: AM_DEF, exclude: o.exclude }), { lag: o.lag, int: o.int, replace: o.replace, detail: o.detail }),
      neighbors: nb,
      // 풀 = 편입 가능한 풀 안 12-1개월 수익률 양(+) 종목 중 보유·재진입 금지가 아닌 종목(LC1·LC3 = 앙상블 풀 30, LC2 = 시총 상위 5위 안). 같은 청산(순위 + 절대 모멘텀)·배율 규칙을 적용한다.
      random: (rng, ordersByDay) => {
        const hk = hooksOf({ am: AM_DEF }), l3b = isL3 ? (hk as ReturnType<typeof l3Hooks>) : undefined;
        return simSlots(env, cfg, {
          candsOf: (c, held, blocked) => {
            const n = ordersByDay.get(c) ?? 0;
            if (!n) return [];
            let pool: SimCand[];
            if (isL3) {
              const d = CAL[c];
              pool = megaAt(c).list.slice(0, L3.entryRank).filter((s) => { const i = s.idx.get(d); return i !== undefined && legReturn(s.close, i, LE_LEGS[LE_ENTRY_LEG]) > 0 && !held(s.code) && !blocked(s.code) && !l3b!.banned(s.code, c); }).map((s) => ({ s, code: s.code }));
            } else {
              const en = ensAt(c);
              pool = en.items.filter((it) => it.rets[LE_ENTRY_LEG] > 0 && !held(it.code) && !blocked(it.code)).map((it) => ({ s: en.sOf.get(it.code)!, code: it.code }));
            }
            const out: SimCand[] = [];
            while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
            return out;
          },
          exitReason: hk.exitReason,
        }, { lag: 1 });
      },
      reasons: ["시총 순위 밖", ...(isL3 ? [] : ["앙상블 순위 밖"]), AM_EXIT_REASON, "폐지"],
      label,
      extra: (run) => {
        const E = (name: string, r: SimRun): void => { for (const [wn, w] of W.ALL) { const s = h.st(r, w), b = h.st(h.bhP, w), l = h.st(le2Run, w), l3s = h.st(l3Run, w); console.log(`  ${name} | ${wn}: CAGR ${f2(s.cagr)} / MDD ${f2(s.mdd)} (069500 ${f2(b.cagr)} / ${f2(b.mdd)}, LE2 ${f2(l.cagr)} / ${f2(l.mdd)}, L3 ${f2(l3s.cagr)} / ${f2(l3s.mdd)})`); } };
        console.log(`${id} 진입 ${run.entryCs.length}건 · 보유일 중앙값 ${f2(median(run.trades.map((t) => t.exitC - t.entryC)))}일 (기저 ${cd.base} 진입 ${baseRun.entryCs.length}건 · 보유일 중앙값 ${f2(median(baseRun.trades.map((t) => t.exitC - t.entryC)))}일) · 평균 보유 종목 수(전체 날) ${f2(avg(run.nPos))}`);
        const amTr = run.trades.filter((t) => t.reason === AM_EXIT_REASON);
        console.log(`${id} 청산 사유별(전체): ${["시총 순위 밖", "앙상블 순위 밖", AM_EXIT_REASON, "폐지"].map((r) => `${r} ${run.trades.filter((t) => t.reason === r).length}`).join(" / ")} | 닫힌 거래 ${run.trades.length}건 | 절대 모멘텀 청산 평균 거래 수익률 ${f2(avg(amTr.map((t) => (t.proceeds / t.spend - 1) * 100)))}% (이긴 ${amTr.filter((t) => t.proceeds > t.spend).length}건)`);
        const mult = run.mult ?? [], actual = run.actual ?? [], rebal = run.rebal ?? [];
        console.log(`${id} 배율·투자·현금·회전율·비용 (괄호 = 기저 ${cd.base}; 비용 합계 % = 구간 안 일별 비용 합)`);
        console.log(`| 구간 | 목표 배율 평균 | 실제 배율 평균 | 평균 투자 비중 % | 현금 비중 % | 배율 < ${LV_LOW_MULT} 일수 (목표 배율이 있는 날 중) | 배율 < 1 일수 | 조정 체결 횟수 | 현금 100% 일수 / 일수 | 연 회전율 % | 비용 합계 % |\n|---|---|---|---|---|---|---|---|---|---|---|`);
        for (const [wn, w] of W.ALL) {
          const idx: number[] = [], jdx: number[] = [];
          for (let i = 0; i < run.dates.length; i++) if (inWin(run.dates[i], w)) idx.push(i);
          for (let i = 0; i < baseRun.dates.length; i++) if (inWin(baseRun.dates[i], w)) jdx.push(i);
          const ms = idx.map((i) => mult[i]).filter(Number.isFinite), as = idx.map((i) => actual[i]).filter(Number.isFinite);
          const s = h.st(run, w), b = h.st(baseRun, w);
          console.log(`| ${wn} | ${f2(avg(ms))} | ${f2(avg(as))} | ${f2(s.avgInv)} (${f2(b.avgInv)}) | ${f2(100 - s.avgInv)} (${f2(100 - b.avgInv)}) | ${ms.filter((x) => x < LV_LOW_MULT).length} / ${ms.length} | ${ms.filter((x) => x < 1).length} | ${rebal.filter((r) => inWin(r.d, w)).length} | ${idx.filter((i) => run.nPos[i] === 0).length} (${jdx.filter((i) => baseRun.nPos[i] === 0).length}) / ${idx.length} | ${f2(s.turnover)} (${f2(b.turnover)}) | ${f2(s.cost)} (${f2(b.cost)}) |`);
        }
        const fs = h.st(run, W.FULL), fb = h.st(baseRun, W.FULL), yrs = (Date.parse(h.dataEnd) - Date.parse(W.FULL.from)) / 86_400_000 / 365.25;
        console.log(`${id} 15년 합계 비용 ${f2(fs.cost)}% (연평균 ${f2(fs.cost / yrs)}%) vs ${cd.base} ${f2(fb.cost)}% (연평균 ${f2(fb.cost / yrs)}%) → 차이 ${f2(fs.cost - fb.cost)}%p | 연 회전율 ${f2(fs.turnover)}% vs ${f2(fb.turnover)}%`);
        console.log(`${id} 낙폭 상위 3개 구간 (고점 → 저점 → 회복; 회복 = 직전 고점 이상으로 돌아온 첫 날; 평가 구간 전체 수익률 열 기준)`);
        const topEp = (ser: { dates: string[]; ret: number[] }, name: string): void => {
          const ii: number[] = [];
          for (let i = 0; i < ser.dates.length; i++) if (ser.dates[i] >= W.FULL.from) ii.push(i);
          const dts = ii.map((i) => ser.dates[i]), rr = ii.map((i) => ser.ret[i]);
          const eps = episodes(rr).sort((a, b) => b.depth - a.depth).slice(0, 3);
          console.log(`  ${name}: ${eps.map((e, k) => `${k + 1}) 고점 ${e.peakIdx < 0 ? W.FULL.from : dts[e.peakIdx]} → 저점 ${dts[e.troughIdx]} ${f2(e.depth * 100)}% → 회복 ${e.recIdx === null ? "미회복" : dts[e.recIdx]}`).join(" | ")}`);
        };
        topEp(run, id); topEp(baseRun, cd.base); topEp(h.bhP, "069500(새 기준선)");
        console.log(`${id} 학습 구간(2011~2016) 연도별 수익률: 후보 − 069500 (%p) — ${[2011, 2012, 2013, 2014, 2015, 2016].map((y) => { const a = h.yearRet(run, y), b = h.yearRet(bhFrom, y); return `${y}년 ${f2(a)} vs ${f2(b)} (${a - b >= 0 ? "+" : ""}${f2(a - b)})`; }).join(" | ")}`);
        console.log(`${id} 하루 지연(lag 2) 구간별 성적`);
        E(`${id} lag 2`, simSlots(env, cfg, hooksOf({ am: AM_DEF }), { lag: 2, detail: true }));
        const top3 = [...run.trades].sort((a, b) => (b.proceeds - b.spend) / b.vAtEntry - (a.proceeds - a.spend) / a.vAtEntry).slice(0, 3);
        console.log(`${id} 상위 3개 거래(${top3.map((t) => `${label(t.code)} ${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")})를 069500 수익률로 바꾼 구간별 성적(= 제외)`);
        E(`${id} 상위 3개 거래 대체`, simSlots(env, cfg, hooksOf({ am: AM_DEF }), { lag: 1, detail: true, replace: new Set(top3.map((t) => `${t.code}|${t.entryC}`)) }));
        console.log(`${id} 하락 구간 성과 (누적 % / MDD %) — 후보 | 069500(새) | LE2 | L3 | LV1 | LV2 | AM2 와 두 장치 작동일`);
        for (const [name, f, t, ctxFrom] of LC_DOWNTURNS) {
          console.log(`  ${name}: ${id} ${h.periodStat(run, f, t)} | 069500 ${h.periodStat(h.bhP, f, t)} | LE2 ${h.periodStat(le2Run, f, t)} | L3 ${h.periodStat(l3Run, f, t)} | LV1 ${h.periodStat(lvRun.LV1, f, t)} | LV2 ${h.periodStat(lvRun.LV2, f, t)} | AM2 ${h.periodStat(am2Run, f, t)}`);
          const ex = amTr.filter((x) => CAL[x.exitC] >= f && CAL[x.exitC] <= t).sort((a, b) => a.exitC - b.exitC);
          console.log(`    절대 모멘텀 청산(체결일 = 판단 다음 거래일 종가) ${f}~${t} ${ex.length}건${ex.length ? `: ${ex.slice(0, 40).map((x) => `${CAL[x.exitC]} ${label(x.code)} ${f2((x.proceeds / x.spend - 1) * 100)}%`).join(", ")}${ex.length > 40 ? " …" : ""}` : ""}`);
          const idx: number[] = [];
          for (let i = 0; i < run.dates.length; i++) if (run.dates[i] >= ctxFrom && run.dates[i] <= t) idx.push(i);
          const ser = idx.map((i) => ({ d: run.dates[i], m: mult[i] })).filter((x) => Number.isFinite(x.m));
          const first1 = ser.find((x, k) => x.m < 1 && (k === 0 || ser[k - 1].m >= 1)), firstHalf = ser.find((x) => x.m < LV_LOW_MULT);
          const inRange = ser.filter((x) => x.d >= f), mn = inRange.length ? inRange.reduce((a, b) => (b.m < a.m ? b : a)) : undefined;
          const before = ser.filter((x) => x.d < f);
          console.log(`    변동성 목표 배율(판단일 기준; ${ctxFrom}부터 관측): 구간 시작 직전 ${before.length ? `${before[before.length - 1].d} ${before[before.length - 1].m}` : "-"} | 1 미만으로 처음 내려간 날 ${first1 ? `${first1.d}(${first1.m})${ser[0] === first1 ? " [관측 시작일부터 이미 1 미만]" : ""}` : "없음"} | ${LV_LOW_MULT} 미만 처음 ${firstHalf ? `${firstHalf.d}(${firstHalf.m})` : "없음"} | 구간 안 최저 ${mn ? `${mn.d}(${mn.m})` : "-"} | 구간 안 1 미만 일수 ${inRange.filter((x) => x.m < 1).length}/${inRange.length}`);
          console.log(`    배율 조정 체결일(→ 배율): ${rebal.filter((r) => r.d >= f && r.d <= addDays(t, 4)).map((r) => `${r.d}(→${r.m})`).join(", ") || "없음"}`);
        }
        for (const [wn, w] of W.ALL) { const s = h.st(run, w); console.log(`  ${id} | ${wn}: 평균 투자 비중 ${f2(s.avgInv)}% / 현금 비중 ${f2(100 - s.avgInv)}% / 평균 보유 종목 수 ${f2(s.avgN)}`); }
        const wsum = new Map<string, number>();
        let nDays = 0, invSum = 0;
        simSlots(env, cfg, hooksOf({ am: AM_DEF }), { lag: 1, onDay: (_c, V, held) => { nDays++; for (const [code, val] of held) { wsum.set(code, (wsum.get(code) ?? 0) + val / V); invSum += val / V; } } });
        const wavg = (code: string): number => ((wsum.get(code) ?? 0) / Math.max(nDays, 1)) * 100;
        console.log(`${id} 일별 평균 계좌 비중(현금 날 포함, 열린 포지션 포함; ${nDays}일): 삼성전자 ${f2(wavg(SAMSUNG))}% · SK하이닉스 ${f2(wavg(HYNIX))}% · 합 ${f2(wavg(SAMSUNG) + wavg(HYNIX))}% | 투자분 중 두 종목 비중 ${f2(((wsum.get(SAMSUNG) ?? 0) + (wsum.get(HYNIX) ?? 0)) / Math.max(invSum, 1e-12) * 100)}% | 상위 8: ${[...wsum].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${label(k)} ${f2((v / Math.max(nDays, 1)) * 100)}%`).join(", ")}`);
      },
    };
  };

  const order = (["LC1", "LC2", "LC3"] as CId[]).filter((id) => only.has(id));
  if (!order.length) { console.log(`\n후보를 하나도 시험하지 않았다(사전 점검 모드: 0단계 기준선과 비교 열 재계산만 수행) | ${storageLine()} | Supabase 쓴 행 0 | 외부 요청 0 | 시도 번호 소진 없음`); return; }
  const verdicts: Verdict[] = [], specs: CandSpec[] = [];
  for (const id of order) { const sp = mkSpec(id); specs.push(sp); verdicts.push(evaluate(h, W, sp)); }
  console.log(`\n=== 구간별 CAGR / MDD — 069500(새 기준선) · LE2 · L3 · LV1 · LV2 · AM2(고정 스냅샷 재계산) · 후보 ===\n| 구간 | 069500 | LE2 | L3 | LV1 | LV2 | AM2 | ${verdicts.map((v) => v.id).join(" | ")} |\n|---|---|---|---|---|---|---|${verdicts.map(() => "---").join("|")}|`);
  for (const [wn, w] of [...W.ALL, ["2026년 제외 (~2025-12-31)", ex26] as [string, typeof ex26]]) {
    const cell = (r: { dates: string[]; ret: number[] }): string => { const s = h.st(r, w); return `${f2(s.cagr)} / ${f2(s.mdd)}`; };
    console.log(`| ${wn} | ${cell(h.bhP)} | ${cell(le2Run)} | ${cell(l3Run)} | ${cell(lvRun.LV1)} | ${cell(lvRun.LV2)} | ${cell(am2Run)} | ${verdicts.map((v) => cell(v.run)).join(" | ")} |`);
  }
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: LC_PRIOR_TESTS });
  yearlyTable(h, W, [{ id: "LE2(재계산)", run: le2Run }, { id: "L3(재계산)", run: l3Run }, { id: "LV1(재계산)", run: lvRun.LV1 }, { id: "LV2(재계산)", run: lvRun.LV2 }, { id: "AM2(재계산)", run: am2Run }, ...verdicts.map((v) => ({ id: v.id, run: v.run }))]);
  seedReport(h, W, specs, new Map(verdicts.map((v) => [v.id, v.run])), (code, c) => { const s = byCode.get(code)!, i = s.idx.get(CAL[c]); return i === undefined ? NaN : s.avgTvRow[i]; });
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${verdicts.map((v) => v.trial).join(", ")}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

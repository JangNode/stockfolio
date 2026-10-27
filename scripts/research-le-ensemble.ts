/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 LE: 대형주(시총 상위 풀) 안 모멘텀 앙상블 로테이션 LE1(220)·LE2(221)·LE3(222). 후보당 1회 실행.
 * 사전 등록: docs/research/momentum-ensemble-prereg.md. 가격 Parquet은 고정 스냅샷(데이터 종료일 2026-10-26, PARQUET_CACHE_FROZEN=1)에서만 읽고, 월말 시장 목록(Storage 약 0.2 MiB)·적용된 조정 이벤트·069500 가격·KOSPI 지수는
 * 데이터 종료일 이하만 읽는다. DB·Storage 쓰기 0. 연구 L·LS·LM의 유니버스·시총 순위·엔진을 그대로 쓰고 편입·청산 순위만 앙상블 점수로 바꾼다. 환경 변수 CAND_ONLY는 크래시 복구 전용.
 * 기저 L3·LM2·LM3는 같은 스냅샷으로 한 번 다시 계산해 표에 같이 보인다(LM 시험과 같은 정의).
 */
import { simSlots, type SimCand, type SimPos, type SimRun } from "@/lib/slotSim";
import { L_CANDS, L_SLIPPAGE, L_EVAL_AFTER } from "@/lib/megacapTrendConfig";
import { LS_COOLDOWN_DAYS } from "@/lib/megacapTrailingConfig";
import { LM_CANDS, LM_SKIP } from "@/lib/megacapMomentumConfig";
import { LE_CANDS, LE_PRIOR_TESTS, LE_LEGS, LE_ENTRY_LEG, LE_RANK_DEPTH, LE_H_CAGR_GAIN_PP, LE_H_MDD_GAIN_PP, LE_H_MDD_GAIN_STRONG_PP, LE_H_CAGR_FLOOR_PP, LE_PREV_BASE } from "@/lib/momentumEnsembleConfig";
import { rankEnsemble, outsiderEnsembleRank, type EnsembleRanking } from "@/lib/momentumEnsemble";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, SNAP_END, f2, avg, median, type S } from "./researchHarness";
import { evaluate, makeWindows, seedReport, yearlyTable, summaryReport, type CandSpec, type Verdict } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
type EId = keyof typeof LE_CANDS;
const SAMSUNG = "005930", HYNIX = "000660";
interface Variant { slots: number; keepRank: number }
interface LmPool { items: { s: S; m: number }[]; rank: Map<string, number>; moms: number[] }

async function main(): Promise<void> {
  console.log(`연구 LE 시험 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const only = new Set((process.env.CAND_ONLY || "LE1,LE2,LE3").split(",").map((x) => x.trim()).filter(Boolean));
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, nameOf } = await loadK200P(h);
  const cS = CAL.findIndex((d) => d >= L_EVAL_AFTER);
  if (cS < 0) throw new Error(`${L_EVAL_AFTER} 이후 거래일 없음`);
  const W = makeWindows(h, cS + 1);
  console.log(`평가 시작 판단일 ${CAL[cS]}(달력 순번 ${cS}), 수익률 집계 ${CAL[cS + 1]}~${h.dataEnd} | 구간 ${W.NW.map(([n, w]) => `${n} ${w.from}~${w.to}`).join(" / ")}`);

  // ---- 매일 시총 순위(연구 L·LS·LM과 같다, 깊이만 LE_RANK_DEPTH) ----
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

  // ---- 앙상블: 풀(시총 순위 ≤ pool) 안에서 세 구간 수익률을 모두 계산할 수 있는 종목의 백분위 평균 순위 ----
  /** 종목 자신의 수정 종가 행 기준 수익률 = close[i−skip] ÷ close[i−lookback] − 1. 행이 부족하거나 값이 0 이하면 NaN. */
  const legRets = (s: S, i: number): number[] => LE_LEGS.map((lg) => {
    if (i < lg.lookback) return NaN;
    const a = s.close[i - lg.skip], b = s.close[i - lg.lookback];
    return a > 0 && b > 0 ? a / b - 1 : NaN;
  });
  const ensCache = new Map<string, EnsembleRanking & { sOf: Map<string, S> }>();
  const ensAt = (pool: number, c: number): EnsembleRanking & { sOf: Map<string, S> } => {
    const key = `${pool}|${c}`;
    let v = ensCache.get(key);
    if (!v) {
      const d = CAL[c], items: { code: string; rets: number[] }[] = [], sOf = new Map<string, S>();
      for (const s of megaAt(c).list.slice(0, pool)) {
        const rets = legRets(s, s.idx.get(d)!);
        if (rets.every(Number.isFinite)) { items.push({ code: s.code, rets }); sOf.set(s.code, s); }
      }
      v = { ...rankEnsemble(items), sOf };
      ensCache.set(key, v);
    }
    return v;
  };

  const env = { CAL, nCal, cS, adjustments: h.adjustments, endedBefore: h.endedBefore, stockBuyMult: h.stockBuyMult, sellRate: h.sellRate, baseSlip: SLIPPAGE_PCT_PER_SIDE, bhRet: h.bhRet };
  const label = (code: string): string => `${code} ${nameOf.get(code) ?? "?"}`;
  const cfgFor = (slots: number, cooldown: number) => ({ slip: L_SLIPPAGE, maxPos: slots, capFrac: 1 / slots, cooldown });
  /** 편입 후보(앙상블 순위 순): 풀 안 앙상블 순위 ≤ slots 이고 12-1개월 수익률 > 0(엄격). 후보가 모자라면 빈 슬롯은 현금. */
  const entryList = (id: EId, v: Variant, c: number, exclude?: Set<string>): SimCand[] => {
    const en = ensAt(LE_CANDS[id].pool, c), out: SimCand[] = [];
    for (let k = 0; k < v.slots && k < en.items.length; k++) { const it = en.items[k]; if (it.rets[LE_ENTRY_LEG] > 0 && !exclude?.has(it.code)) out.push({ s: en.sOf.get(it.code)!, code: it.code }); }
    return out;
  };
  /** 청산: 시총 순위 > keepCap(밖) 또는 풀 안(풀 밖이면 끼워 넣은) 앙상블 순위 > keepRank(밖). 판단일 행이 없거나 세 구간 중 하나라도 못 구하면 판단하지 않고 보유 유지. */
  const hooksFor = (id: EId, v: Variant, exclude?: Set<string>) => ({
    candsOf: (c: number): SimCand[] => entryList(id, v, c, exclude),
    exitReason: (p: SimPos, c: number, i: number | undefined): string | null => {
      if (i === undefined) return null;
      const cd = LE_CANDS[id];
      if ((megaAt(c).rank.get(p.code) ?? Number.POSITIVE_INFINITY) > cd.keepCap) return "시총 순위 밖";
      const rets = legRets(byCode.get(p.code)!, i);
      if (!rets.every(Number.isFinite)) return null;
      const en = ensAt(cd.pool, c);
      const r = en.rank.get(p.code) ?? outsiderEnsembleRank(en, rets);
      return r > v.keepRank ? "앙상블 순위 밖" : null;
    },
  });

  // ---- 기저 L3(연구 L)·LM2·LM3(연구 LM)를 같은 엔진·스냅샷으로 다시 계산 ----
  const l3 = L_CANDS.L3;
  const l3Run = simSlots(env, cfgFor(l3.slots, 0), {
    candsOf: (c: number): SimCand[] => megaAt(c).list.slice(0, l3.entryRank).map((s) => ({ s, code: s.code })),
    exitReason: (p: SimPos, c: number, i: number | undefined): string | null => (i === undefined ? null : (megaAt(c).rank.get(p.code) ?? Number.POSITIVE_INFINITY) > l3.keepRank ? "시총 순위 밖" : null),
  }, { lag: 1, detail: true });
  const momOf = (s: S, i: number, lb: number): number => { if (i < lb) return NaN; const a = s.close[i - LM_SKIP], b = s.close[i - lb]; return a > 0 && b > 0 ? a / b - 1 : NaN; };
  const lmPoolCache = new Map<string, LmPool>();
  const lmPoolAt = (pool: number, lb: number, c: number): LmPool => {
    const key = `${pool}|${lb}|${c}`;
    let v = lmPoolCache.get(key);
    if (!v) {
      const d = CAL[c], items: { s: S; m: number }[] = [];
      for (const s of megaAt(c).list.slice(0, pool)) { const m = momOf(s, s.idx.get(d)!, lb); if (Number.isFinite(m)) items.push({ s, m }); }
      items.sort((a, b) => b.m - a.m || (a.s.code < b.s.code ? -1 : 1));
      v = { items, rank: new Map(items.map((x, k) => [x.s.code, k + 1])), moms: items.map((x) => x.m) };
      lmPoolCache.set(key, v);
    }
    return v;
  };
  const lmOutsiderRank = (pl: LmPool, m: number): number => { let lo = 0, hi = pl.moms.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (pl.moms[mid] > m) lo = mid + 1; else hi = mid; } return 1 + lo; };
  const lmRun = (id: "LM2" | "LM3"): SimRun => {
    const cd = LM_CANDS[id];
    return simSlots(env, cfgFor(cd.slots, LS_COOLDOWN_DAYS), {
      candsOf: (c: number): SimCand[] => {
        const pl = lmPoolAt(cd.pool, cd.lookback, c), out: SimCand[] = [];
        for (let k = 0; k < cd.slots && k < pl.items.length; k++) { const it = pl.items[k]; if (it.m > 0) out.push({ s: it.s, code: it.s.code }); }
        return out;
      },
      exitReason: (p: SimPos, c: number, i: number | undefined): string | null => {
        if (i === undefined) return null;
        if ((megaAt(c).rank.get(p.code) ?? Number.POSITIVE_INFINITY) > cd.keepCap) return "시총 순위 밖";
        const m = momOf(byCode.get(p.code)!, i, cd.lookback);
        if (!Number.isFinite(m)) return null;
        const pl = lmPoolAt(cd.pool, cd.lookback, c);
        return (pl.rank.get(p.code) ?? lmOutsiderRank(pl, m)) > cd.keepMom ? "모멘텀 순위 밖" : null;
      },
    }, { lag: 1, detail: true });
  };
  const lm2Run = lmRun("LM2"), lm3Run = lmRun("LM3");
  console.log(`기저 재계산(고정 스냅샷, 데이터 종료일 ${h.dataEnd}; 정의는 LM 시험과 같음)`);
  for (const [name, run] of [["L3", l3Run], ["LM2", lm2Run], ["LM3", lm3Run]] as const) {
    const f = h.st(run, W.FULL), p = LE_PREV_BASE[name];
    console.log(`  ${name}: 전체 CAGR ${f2(f.cagr)} / MDD ${f2(f.mdd)} — LM 시험(데이터 종료일 2026-10-23) ${f2(p.lm.cagr)} / ${f2(p.lm.mdd)} 대비 ${f2(f.cagr - p.lm.cagr)}%p / ${f2(f.mdd - p.lm.mdd)}%p, RG 시험 재계산(종료일 2026-10-26) ${f2(p.rg.cagr)} / ${f2(p.rg.mdd)} 대비 ${f2(f.cagr - p.rg.cagr)}%p / ${f2(f.mdd - p.rg.mdd)}%p`);
  }
  console.log(`  차이 원인(한 줄): 데이터 종료일이 LM 시험 2026-10-23 → 스냅샷 2026-10-26(거래일 1일 추가)로 늘어 전체 CAGR이 달라졌고, 정의·파라미터는 바꾸지 않았다.`);

  const bhFrom: { dates: string[]; ret: number[] } = { dates: h.bhP.dates.filter((d) => d >= W.FULL.from), ret: h.bhP.ret.filter((_, k) => h.bhP.dates[k] >= W.FULL.from) };
  /** 게이트 H: 같은 데이터로 다시 계산한 LM2와 L3 각각에 대해 조건1(CAGR +1%p) 또는 조건2(MDD 3%p 이상 낮고 CAGR −1%p 이내) 중 하나, 두 기준선 모두 만족해야 O. */
  const hVs = (full: { cagr: number; mdd: number }, rb: { cagr: number; mdd: number }): { ok: boolean; text: string } => {
    const dc = full.cagr - rb.cagr, dm = rb.mdd - full.mdd;
    const c1 = dc >= LE_H_CAGR_GAIN_PP, c2 = dm >= LE_H_MDD_GAIN_PP && dc >= -LE_H_CAGR_FLOOR_PP;
    return { ok: c1 || c2, text: `CAGR ${dc >= 0 ? "+" : ""}${f2(dc)}%p, MDD ${dm >= 0 ? "−" : "+"}${f2(Math.abs(dm))}%p(개선 ${f2(dm)}%p; ${LE_H_MDD_GAIN_STRONG_PP}%p 이상 ${dm >= LE_H_MDD_GAIN_STRONG_PP ? "O" : "X"}) → 조건1(CAGR +${LE_H_CAGR_GAIN_PP}%p) ${c1 ? "O" : "X"}, 조건2(MDD 개선 ${LE_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${LE_H_CAGR_FLOOR_PP}%p) ${c2 ? "O" : "X"}` };
  };
  const l3Full = h.st(l3Run, W.FULL);
  const mkSpec = (id: EId): CandSpec => {
    const cd = LE_CANDS[id], base: Variant = { slots: cd.slots, keepRank: cd.keepRank }, cfg = cfgFor(cd.slots, LS_COOLDOWN_DAYS);
    const nb: { label: string; run: () => SimRun }[] = [];
    for (const k of cd.slotsNeighbors) nb.push({ label: `보유 수 ${k}`, run: () => simSlots(env, cfgFor(k, LS_COOLDOWN_DAYS), hooksFor(id, { ...base, slots: k }), { lag: 1 }) });
    for (const k of cd.keepNeighbors) nb.push({ label: `앙상블 순위 매도 한도 ${k}`, run: () => simSlots(env, cfg, hooksFor(id, { ...base, keepRank: k }), { lag: 1 }) });
    return {
      id, trial: cd.trial, title: `시총 상위 ${cd.pool}위 풀, 3·6·12-1개월 수익률 백분위 평균(앙상블) 상위 ${cd.slots}개(종목당 ${f2(100 / cd.slots)}%), 앙상블 순위 ${cd.keepRank}위 밖 또는 시총 ${cd.keepCap}위 밖 시 매도, 12-1개월 수익률 ≤ 0 편입 금지, 재진입 ${LS_COOLDOWN_DAYS}거래일 후`,
      defense: false, capFrac: 1 / cd.slots, fDenominator: 3, ref: { id: "LM2", run: lm2Run },
      hRule: (full, lm2) => { const a = hVs(full, lm2), b = hVs(full, l3Full); return { ok: a.ok && b.ok, note: `${a.text} | L3 ${f2(l3Full.cagr)} / ${f2(l3Full.mdd)} 대비 ${b.text} | 두 기준선 모두 만족 ${a.ok && b.ok ? "O" : "X"}` }; },
      run: (o) => simSlots(env, cfg, hooksFor(id, base, o.exclude), { lag: o.lag, int: o.int, replace: o.replace, detail: o.detail }),
      neighbors: nb,
      // 풀 = 편입 가능한 풀 안 12-1개월 수익률 양(+) 종목 중 보유·재진입 금지가 아닌 종목. 신호일마다 실제 매수 주문 수만큼 무작위로 고른다.
      random: (rng, ordersByDay) => simSlots(env, cfg, {
        candsOf: (c, held, blocked) => {
          const n = ordersByDay.get(c) ?? 0;
          if (!n) return [];
          const en = ensAt(cd.pool, c);
          const pool = en.items.filter((it) => it.rets[LE_ENTRY_LEG] > 0 && !held(it.code) && !blocked(it.code)).map((it) => ({ s: en.sOf.get(it.code)!, code: it.code })), out: SimCand[] = [];
          while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
          return out;
        },
        exitReason: hooksFor(id, base).exitReason,
      }, { lag: 1 }),
      reasons: ["시총 순위 밖", "앙상블 순위 밖", "폐지"],
      label,
      extra: (run) => {
        const E = (name: string, r: SimRun): void => { for (const [wn, w] of W.ALL) { const s = h.st(r, w), b = h.st(h.bhP, w), l = h.st(l3Run, w), m = h.st(lm2Run, w); console.log(`  ${name} | ${wn}: CAGR ${f2(s.cagr)} / MDD ${f2(s.mdd)} (069500 ${f2(b.cagr)} / ${f2(b.mdd)}, L3 ${f2(l.cagr)} / ${f2(l.mdd)}, LM2 ${f2(m.cagr)} / ${f2(m.mdd)})`); } };
        console.log(`${id} 진입 ${run.entryCs.length}건 · 보유일 중앙값 ${f2(median(run.trades.map((t) => t.exitC - t.entryC)))}일 · 평균 보유 종목 수(전체 날) ${f2(avg(run.nPos))}`);
        console.log(`${id} 학습 구간(2011~2016) 연도별 수익률: 후보 − 069500 (%p) — ${[2011, 2012, 2013, 2014, 2015, 2016].map((y) => { const a = h.yearRet(run, y), b = h.yearRet(bhFrom, y); return `${y}년 ${f2(a)} vs ${f2(b)} (${a - b >= 0 ? "+" : ""}${f2(a - b)})`; }).join(" | ")}`);
        console.log(`${id} 하루 지연(lag 2) 구간별 성적`);
        E(`${id} lag 2`, simSlots(env, cfg, hooksFor(id, base), { lag: 2, detail: true }));
        const top3 = [...run.trades].sort((a, b) => (b.proceeds - b.spend) / b.vAtEntry - (a.proceeds - a.spend) / a.vAtEntry).slice(0, 3);
        console.log(`${id} 상위 3개 거래(${top3.map((t) => `${label(t.code)} ${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")})를 069500 수익률로 바꾼 구간별 성적(= 제외)`);
        E(`${id} 상위 3개 거래 대체`, simSlots(env, cfg, hooksFor(id, base), { lag: 1, detail: true, replace: new Set(top3.map((t) => `${t.code}|${t.entryC}`)) }));
        console.log(`${id} 하락 구간 성과 (누적 % / MDD %)`);
        for (const [name, f, t] of [["2020-03", "2020-03-01", "2020-03-31"], ["2022", "2022-01-01", "2022-12-31"], ["2026-10-01~10-15", "2026-10-01", "2026-10-15"]] as const) console.log(`  ${name}: ${id} ${h.periodStat(run, f, t)} | 069500 ${h.periodStat(h.bhP, f, t)} | L3 ${h.periodStat(l3Run, f, t)} | LM2 ${h.periodStat(lm2Run, f, t)}`);
        for (const [wn, w] of W.ALL) { const s = h.st(run, w); console.log(`  ${id} | ${wn}: 평균 투자 비중 ${f2(s.avgInv)}% / 현금 비중 ${f2(100 - s.avgInv)}% / 평균 보유 종목 수 ${f2(s.avgN)}`); }
        const days = new Map<string, number>();
        let tot = 0;
        for (const t of run.trades) { const dd = t.exitC - t.entryC; days.set(t.code, (days.get(t.code) ?? 0) + dd); tot += dd; }
        console.log(`${id} 보유 종목 구성(닫힌 거래 보유 종목-일 ${tot}, 종목 수 ${days.size}): 상위 8: ${[...days].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${label(k)} ${f2((v / Math.max(tot, 1)) * 100)}%`).join(", ")}`);
        const wsum = new Map<string, number>();
        let nDays = 0, invSum = 0;
        simSlots(env, cfg, hooksFor(id, base), { lag: 1, onDay: (_c, V, held) => { nDays++; for (const [code, val] of held) { wsum.set(code, (wsum.get(code) ?? 0) + val / V); invSum += val / V; } } });
        const wavg = (code: string): number => ((wsum.get(code) ?? 0) / Math.max(nDays, 1)) * 100;
        console.log(`${id} 일별 평균 계좌 비중(현금 날 포함, 열린 포지션 포함; ${nDays}일): 삼성전자 ${f2(wavg(SAMSUNG))}% · SK하이닉스 ${f2(wavg(HYNIX))}% · 합 ${f2(wavg(SAMSUNG) + wavg(HYNIX))}% | 투자분 중 두 종목 비중 ${f2(((wsum.get(SAMSUNG) ?? 0) + (wsum.get(HYNIX) ?? 0)) / Math.max(invSum, 1e-12) * 100)}% | 상위 8: ${[...wsum].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${label(k)} ${f2((v / Math.max(nDays, 1)) * 100)}%`).join(", ")}`);
      },
    };
  };

  const order = (["LE1", "LE2", "LE3"] as EId[]).filter((id) => only.has(id));
  const verdicts: Verdict[] = [], specs: CandSpec[] = [];
  for (const id of order) { const sp = mkSpec(id); specs.push(sp); verdicts.push(evaluate(h, W, sp)); }
  console.log(`\n=== 구간별 CAGR / MDD — 069500 · L3 · LM2 · LM3(모두 고정 스냅샷 재계산) · 후보 ===\n| 구간 | 069500 | L3 | LM2 | LM3 | ${verdicts.map((v) => v.id).join(" | ")} |\n|---|---|---|---|---|${verdicts.map(() => "---").join("|")}|`);
  for (const [wn, w] of W.ALL) { const b = h.st(h.bhP, w), l = h.st(l3Run, w), m2 = h.st(lm2Run, w), m3 = h.st(lm3Run, w); console.log(`| ${wn} | ${f2(b.cagr)} / ${f2(b.mdd)} | ${f2(l.cagr)} / ${f2(l.mdd)} | ${f2(m2.cagr)} / ${f2(m2.mdd)} | ${f2(m3.cagr)} / ${f2(m3.mdd)} | ${verdicts.map((v) => { const s = h.st(v.run, w); return `${f2(s.cagr)} / ${f2(s.mdd)}`; }).join(" | ")} |`); }
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: LE_PRIOR_TESTS });
  yearlyTable(h, W, [{ id: "L3(재계산)", run: l3Run }, { id: "LM2(재계산)", run: lm2Run }, { id: "LM3(재계산)", run: lm3Run }, ...verdicts.map((v) => ({ id: v.id, run: v.run }))]);
  seedReport(h, W, specs, new Map(verdicts.map((v) => [v.id, v.run])), (code, c) => { const s = byCode.get(code)!, i = s.idx.get(CAL[c]); return i === undefined ? NaN : s.avgTvRow[i]; });
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${verdicts.map((v) => v.trial).join(", ")}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

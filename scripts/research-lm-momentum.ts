/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 LM: 대형주(시총 상위 풀) 안 모멘텀 로테이션 LM1(214)·LM2(215)·LM3(216). 후보당 1회 실행.
 * 사전 등록: docs/research/megacap-momentum-prereg.md. 가격 Parquet(Actions 캐시)·월말 시장 목록(Storage 약 0.2 MiB)·적용된 조정 이벤트·069500 가격만 읽는다. DB·Storage 쓰기 0.
 * 연구 L·LS의 유니버스·시총 순위·엔진을 그대로 쓰고 편입·청산을 시총 풀 안 모멘텀 순위로 바꾼다. 환경 변수 CAND_ONLY는 크래시 복구 전용.
 */
import { simSlots, type SimCand, type SimPos, type SimRun } from "@/lib/slotSim";
import { L_CANDS, L_SLIPPAGE, L_EVAL_AFTER } from "@/lib/megacapTrendConfig";
import { LS_COOLDOWN_DAYS, LS_REF_L3 } from "@/lib/megacapTrailingConfig";
import { LM_CANDS, LM_PRIOR_TESTS, LM_SKIP, LM_RANK_DEPTH } from "@/lib/megacapMomentumConfig";
import { loadHarness, loadK200P, dbRead, xfer, f2, avg, median, type S } from "./researchHarness";
import { evaluate, makeWindows, seedReport, yearlyTable, summaryReport, type CandSpec, type Verdict } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
type MId = keyof typeof LM_CANDS;
const SAMSUNG = "005930", HYNIX = "000660";
interface Variant { slots: number; keepMom: number; lookback: number }
interface Pool { items: { s: S; m: number }[]; rank: Map<string, number>; moms: number[] }

async function main(): Promise<void> {
  console.log(`연구 LM 시험 시작(읽기 전용): ${new Date().toISOString()}`);
  const only = new Set((process.env.CAND_ONLY || "LM1,LM2,LM3").split(",").map((x) => x.trim()).filter(Boolean));
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, nameOf } = await loadK200P(h);
  const cS = CAL.findIndex((d) => d >= L_EVAL_AFTER);
  if (cS < 0) throw new Error(`${L_EVAL_AFTER} 이후 거래일 없음`);
  const W = makeWindows(h, cS + 1);
  console.log(`평가 시작 판단일 ${CAL[cS]}(달력 순번 ${cS}), 수익률 집계 ${CAL[cS + 1]}~${h.dataEnd} | 구간 ${W.NW.map(([n, w]) => `${n} ${w.from}~${w.to}`).join(" / ")}`);

  // ---- 매일 시총 순위(연구 L·LS와 같다, 깊이만 LM_RANK_DEPTH) ----
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
      const list = e.slice(0, LM_RANK_DEPTH).map((x) => x.s);
      v = { list, rank: new Map(list.map((s, k) => [s.code, k + 1])) };
      megaCache.set(c, v);
    }
    return v;
  };
  /** 종목 자신의 수정 종가 행 기준 모멘텀 = close[i−LM_SKIP] ÷ close[i−lookback] − 1. 행이 부족하면 NaN. */
  const momOf = (s: S, i: number, lb: number): number => {
    if (i < lb) return NaN;
    const a = s.close[i - LM_SKIP], b = s.close[i - lb];
    return a > 0 && b > 0 ? a / b - 1 : NaN;
  };
  /** 풀(시총 순위 ≤ pool) 안에서 모멘텀을 계산할 수 있는 종목을 모멘텀 내림차순(동점 코드 오름차순)으로 세운 순위. */
  const poolCache = new Map<string, Pool>();
  const poolAt = (pool: number, lb: number, c: number): Pool => {
    const key = `${pool}|${lb}|${c}`;
    let v = poolCache.get(key);
    if (!v) {
      const d = CAL[c], items: { s: S; m: number }[] = [];
      for (const s of megaAt(c).list.slice(0, pool)) { const m = momOf(s, s.idx.get(d)!, lb); if (Number.isFinite(m)) items.push({ s, m }); }
      items.sort((a, b) => b.m - a.m || (a.s.code < b.s.code ? -1 : 1));
      v = { items, rank: new Map(items.map((x, k) => [x.s.code, k + 1])), moms: items.map((x) => x.m) };
      poolCache.set(key, v);
    }
    return v;
  };
  /** 풀 밖(시총 순위 > pool)인 보유 종목의 모멘텀 순위 = 1 + 풀에서 모멘텀이 더 높은 종목 수. */
  const outsiderRank = (pl: Pool, m: number): number => { let lo = 0, hi = pl.moms.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (pl.moms[mid] > m) lo = mid + 1; else hi = mid; } return 1 + lo; };

  const env = { CAL, nCal, cS, adjustments: h.adjustments, endedBefore: h.endedBefore, stockBuyMult: h.stockBuyMult, sellRate: h.sellRate, baseSlip: SLIPPAGE_PCT_PER_SIDE, bhRet: h.bhRet };
  const label = (code: string): string => `${code} ${nameOf.get(code) ?? "?"}`;
  const cfgFor = (slots: number, cooldown: number) => ({ slip: L_SLIPPAGE, maxPos: slots, capFrac: 1 / slots, cooldown });
  /** 편입 후보(모멘텀 순위 순): 풀 안 모멘텀 순위 ≤ slots 이고 모멘텀 > 0(엄격). 후보가 모자라면 빈 슬롯은 현금. */
  const entryList = (id: MId, v: Variant, c: number, exclude?: Set<string>): SimCand[] => {
    const pl = poolAt(LM_CANDS[id].pool, v.lookback, c), out: SimCand[] = [];
    for (let k = 0; k < v.slots && k < pl.items.length; k++) { const it = pl.items[k]; if (it.m > 0 && !exclude?.has(it.s.code)) out.push({ s: it.s, code: it.s.code }); }
    return out;
  };
  /** 청산: 시총 순위 > keepCap(밖) 또는 풀 안(풀 밖이면 끼워 넣은) 모멘텀 순위 > keepMom(밖). 판단일 행이 없거나 모멘텀을 못 구하면 판단하지 않고 보유 유지. */
  const hooksFor = (id: MId, v: Variant, exclude?: Set<string>) => ({
    candsOf: (c: number): SimCand[] => entryList(id, v, c, exclude),
    exitReason: (p: SimPos, c: number, i: number | undefined): string | null => {
      if (i === undefined) return null;
      const cd = LM_CANDS[id];
      if ((megaAt(c).rank.get(p.code) ?? Number.POSITIVE_INFINITY) > cd.keepCap) return "시총 순위 밖";
      const m = momOf(byCode.get(p.code)!, i, v.lookback);
      if (!Number.isFinite(m)) return null;
      const pl = poolAt(cd.pool, v.lookback, c);
      const r = pl.rank.get(p.code) ?? outsiderRank(pl, m);
      return r > v.keepMom ? "모멘텀 순위 밖" : null;
    },
  });

  // ---- 기준선 L3(연구 L, 추세·손절 규칙 없음)를 같은 엔진으로 다시 계산해 기존 결과와 일치하는지 확인 ----
  const l3 = L_CANDS.L3;
  const l3Hooks = {
    candsOf: (c: number): SimCand[] => megaAt(c).list.slice(0, l3.entryRank).map((s) => ({ s, code: s.code })),
    exitReason: (p: SimPos, c: number, i: number | undefined): string | null => (i === undefined ? null : (megaAt(c).rank.get(p.code) ?? Number.POSITIVE_INFINITY) > l3.keepRank ? "시총 순위 밖" : null),
  };
  const l3Run = simSlots(env, cfgFor(l3.slots, 0), l3Hooks, { lag: 1, detail: true });
  const l3Full = h.st(l3Run, W.FULL);
  const match = Math.abs(l3Full.cagr - LS_REF_L3.cagr) < 0.006 && Math.abs(l3Full.mdd - LS_REF_L3.mdd) < 0.006;
  console.log(`기준선 L3 재계산(게이트 H 기준): 전체 CAGR ${f2(l3Full.cagr)} / MDD ${f2(l3Full.mdd)} — 기존 결과 ${LS_REF_L3.cagr.toFixed(2)} / ${LS_REF_L3.mdd.toFixed(2)}와 ${match ? "일치" : "불일치(보고만, 중단 안 함)"}`);

  const bhFrom: { dates: string[]; ret: number[] } = { dates: h.bhP.dates.filter((d) => d >= W.FULL.from), ret: h.bhP.ret.filter((_, k) => h.bhP.dates[k] >= W.FULL.from) };
  const mkSpec = (id: MId): CandSpec => {
    const cd = LM_CANDS[id], base: Variant = { slots: cd.slots, keepMom: cd.keepMom, lookback: cd.lookback }, cfg = cfgFor(cd.slots, LS_COOLDOWN_DAYS);
    const nb: { label: string; run: () => SimRun }[] = [];
    for (const k of cd.slotsNeighbors) nb.push({ label: `보유 수 ${k}`, run: () => simSlots(env, cfgFor(k, LS_COOLDOWN_DAYS), hooksFor(id, { ...base, slots: k }), { lag: 1 }) });
    for (const k of cd.keepNeighbors) nb.push({ label: `모멘텀 순위 매도 한도 ${k}`, run: () => simSlots(env, cfg, hooksFor(id, { ...base, keepMom: k }), { lag: 1 }) });
    for (const k of cd.lookbackNeighbors) nb.push({ label: `룩백 ${k}일`, run: () => simSlots(env, cfg, hooksFor(id, { ...base, lookback: k }), { lag: 1 }) });
    return {
      id, trial: cd.trial, title: `시총 상위 ${cd.pool}위 풀, ${cd.lookback}−${LM_SKIP}일 모멘텀 상위 ${cd.slots}개(종목당 ${f2(100 / cd.slots)}%), 모멘텀 순위 ${cd.keepMom}위 밖 또는 시총 ${cd.keepCap}위 밖 시 매도, 모멘텀 ≤ 0 편입 금지, 재진입 ${LS_COOLDOWN_DAYS}거래일 후`,
      defense: false, capFrac: 1 / cd.slots, fDenominator: 3, ref: { id: "L3", run: l3Run },
      run: (o) => simSlots(env, cfg, hooksFor(id, base, o.exclude), { lag: o.lag, int: o.int, replace: o.replace, detail: o.detail }),
      neighbors: nb,
      // 풀 = 편입 가능한 풀 안 모멘텀 양(+) 종목 중 보유·재진입 금지가 아닌 종목. 신호일마다 실제 매수 주문 수만큼 무작위로 고른다.
      random: (rng, ordersByDay) => simSlots(env, cfg, {
        candsOf: (c, held, blocked) => {
          const n = ordersByDay.get(c) ?? 0;
          if (!n) return [];
          const pool = poolAt(cd.pool, cd.lookback, c).items.filter((it) => it.m > 0 && !held(it.s.code) && !blocked(it.s.code)).map((it) => ({ s: it.s, code: it.s.code })), out: SimCand[] = [];
          while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
          return out;
        },
        exitReason: hooksFor(id, base).exitReason,
      }, { lag: 1 }),
      reasons: ["시총 순위 밖", "모멘텀 순위 밖", "폐지"],
      label,
      extra: (run) => {
        const E = (name: string, r: SimRun): void => { for (const [wn, w] of W.ALL) { const s = h.st(r, w), b = h.st(h.bhP, w), l = h.st(l3Run, w); console.log(`  ${name} | ${wn}: CAGR ${f2(s.cagr)} / MDD ${f2(s.mdd)} (069500 ${f2(b.cagr)} / ${f2(b.mdd)}, L3 ${f2(l.cagr)} / ${f2(l.mdd)})`); } };
        console.log(`${id} 진입 ${run.entryCs.length}건 · 보유일 중앙값 ${f2(median(run.trades.map((t) => t.exitC - t.entryC)))}일 · 평균 보유 종목 수(전체 날) ${f2(avg(run.nPos))}`);
        console.log(`${id} 학습 구간(2011~2016) 연도별 수익률: 후보 − 069500 (%p) — ${[2011, 2012, 2013, 2014, 2015, 2016].map((y) => { const a = h.yearRet(run, y), b = h.yearRet(bhFrom, y); return `${y}년 ${f2(a)} vs ${f2(b)} (${a - b >= 0 ? "+" : ""}${f2(a - b)})`; }).join(" | ")}`);
        console.log(`${id} 하루 지연(lag 2) 구간별 성적`);
        E(`${id} lag 2`, simSlots(env, cfg, hooksFor(id, base), { lag: 2, detail: true }));
        const top3 = [...run.trades].sort((a, b) => (b.proceeds - b.spend) / b.vAtEntry - (a.proceeds - a.spend) / a.vAtEntry).slice(0, 3);
        console.log(`${id} 상위 3개 거래(${top3.map((t) => `${label(t.code)} ${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")})를 069500 수익률로 바꾼 구간별 성적(= 제외)`);
        E(`${id} 상위 3개 거래 대체`, simSlots(env, cfg, hooksFor(id, base), { lag: 1, detail: true, replace: new Set(top3.map((t) => `${t.code}|${t.entryC}`)) }));
        console.log(`${id} 하락 구간 성과 (누적 % / MDD %)`);
        for (const [name, f, t] of [["2020-03", "2020-03-01", "2020-03-31"], ["2022", "2022-01-01", "2022-12-31"], ["2026-10-01~10-15", "2026-10-01", "2026-10-15"]] as const) console.log(`  ${name}: ${id} ${h.periodStat(run, f, t)} | 069500 ${h.periodStat(h.bhP, f, t)} | L3 ${h.periodStat(l3Run, f, t)}`);
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

  const order = (["LM1", "LM2", "LM3"] as MId[]).filter((id) => only.has(id));
  const verdicts: Verdict[] = [], specs: CandSpec[] = [];
  for (const id of order) { const sp = mkSpec(id); specs.push(sp); verdicts.push(evaluate(h, W, sp)); }
  console.log(`\n=== 구간별 CAGR / MDD — 069500 · L3(기준선) · 후보 ===\n| 구간 | 069500 | L3 | ${verdicts.map((v) => v.id).join(" | ")} |\n|---|---|---|${verdicts.map(() => "---").join("|")}|`);
  for (const [wn, w] of W.ALL) { const b = h.st(h.bhP, w), l = h.st(l3Run, w); console.log(`| ${wn} | ${f2(b.cagr)} / ${f2(b.mdd)} | ${f2(l.cagr)} / ${f2(l.mdd)} | ${verdicts.map((v) => { const s = h.st(v.run, w); return `${f2(s.cagr)} / ${f2(s.mdd)}`; }).join(" | ")} |`); }
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: LM_PRIOR_TESTS });
  yearlyTable(h, W, [{ id: "L3(기준선)", run: l3Run }, ...verdicts.map((v) => ({ id: v.id, run: v.run }))]);
  seedReport(h, W, specs, new Map(verdicts.map((v) => [v.id, v.run])), (code, c) => { const s = byCode.get(code)!, i = s.idx.get(CAL[c]); return i === undefined ? NaN : s.avgTvRow[i]; });
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Storage 내려받기 합계 ${(xfer.bytes / 1048576).toFixed(2)} MiB(가격 Parquet은 Actions 캐시로 읽어 0) | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${verdicts.map((v) => v.trial).join(", ")}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

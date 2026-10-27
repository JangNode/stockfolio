/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 LW: 앙상블 모멘텀 로테이션의 종목 수 확대 LW1(229)·LW2(230)·LW3(231). 후보당 1회 실행.
 * 사전 등록: docs/research/momentum-wide-prereg.md. 가격 Parquet은 고정 스냅샷(데이터 종료일 2026-10-26, PARQUET_CACHE_FROZEN=1)에서만 읽고, 월말 시장 목록(Storage 약 0.2 MiB)·적용된 조정 이벤트·069500 가격은
 * 데이터 종료일 이하만 읽는다. DB·Storage 쓰기 0. 점수·편입·청산 구조는 연구 LE(scripts/research-le-ensemble.ts)와 같고 풀·보유 수·한도만 다르다. 기준선 LE2·LE3는 같은 스냅샷으로 다시 계산한다(시도 수에 넣지 않음).
 * 환경 변수 CAND_ONLY는 크래시 복구 전용.
 */
import { simSlots, type SimCand, type SimPos, type SimRun } from "@/lib/slotSim";
import { L_SLIPPAGE, L_EVAL_AFTER } from "@/lib/megacapTrendConfig";
import { LS_COOLDOWN_DAYS } from "@/lib/megacapTrailingConfig";
import { LE_LEGS, LE_ENTRY_LEG } from "@/lib/momentumEnsembleConfig";
import { LW_CANDS, LW_PRIOR_TESTS, LW_RANK_DEPTH, LW_BASES, LW_H_CAGR_GAIN_PP, LW_H_MDD_GAIN_PP, LW_H_MDD_GAIN_STRONG_PP, LW_H_CAGR_FLOOR_PP } from "@/lib/momentumWideConfig";
import { rankEnsemble, outsiderEnsembleRank, type EnsembleRanking } from "@/lib/momentumEnsemble";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, SNAP_END, f2, avg, median, type S } from "./researchHarness";
import { evaluate, makeWindows, seedReport, yearlyTable, summaryReport, type CandSpec, type Verdict } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
type WId = keyof typeof LW_CANDS;
interface Params { pool: number; slots: number; keepRank: number; keepCap: number }
const SAMSUNG = "005930", HYNIX = "000660";

async function main(): Promise<void> {
  console.log(`연구 LW 시험 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const only = new Set((process.env.CAND_ONLY || "LW1,LW2,LW3").split(",").map((x) => x.trim()).filter(Boolean));
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, nameOf } = await loadK200P(h);
  const cS = CAL.findIndex((d) => d >= L_EVAL_AFTER);
  if (cS < 0) throw new Error(`${L_EVAL_AFTER} 이후 거래일 없음`);
  const W = makeWindows(h, cS + 1);
  console.log(`평가 시작 판단일 ${CAL[cS]}(달력 순번 ${cS}), 수익률 집계 ${CAL[cS + 1]}~${h.dataEnd} | 구간 ${W.NW.map(([n, w]) => `${n} ${w.from}~${w.to}`).join(" / ")}`);

  // ---- 시총 순위·앙상블 점수(연구 LE와 같다, 깊이만 LW_RANK_DEPTH) ----
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
      const list = e.slice(0, LW_RANK_DEPTH).map((x) => x.s);
      v = { list, rank: new Map(list.map((s, k) => [s.code, k + 1])) };
      megaCache.set(c, v);
    }
    return v;
  };
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
  const cfgFor = (slots: number) => ({ slip: L_SLIPPAGE, maxPos: slots, capFrac: 1 / slots, cooldown: LS_COOLDOWN_DAYS });
  /** 편입 후보(앙상블 순위 순): 풀 안 앙상블 순위 ≤ slots 이고 12-1개월 수익률 > 0(엄격). 후보가 모자라면 빈 슬롯은 현금. */
  const entryList = (P: Params, c: number, exclude?: Set<string>): SimCand[] => {
    const en = ensAt(P.pool, c), out: SimCand[] = [];
    for (let k = 0; k < P.slots && k < en.items.length; k++) { const it = en.items[k]; if (it.rets[LE_ENTRY_LEG] > 0 && !exclude?.has(it.code)) out.push({ s: en.sOf.get(it.code)!, code: it.code }); }
    return out;
  };
  /** 청산: 시총 순위 > keepCap(밖) 또는 풀 안(풀 밖이면 끼워 넣은) 앙상블 순위 > keepRank(밖). 판단일 행이 없거나 세 구간 중 하나라도 못 구하면 판단하지 않고 보유 유지. */
  const hooksFor = (P: Params, exclude?: Set<string>) => ({
    candsOf: (c: number): SimCand[] => entryList(P, c, exclude),
    exitReason: (p: SimPos, c: number, i: number | undefined): string | null => {
      if (i === undefined) return null;
      if ((megaAt(c).rank.get(p.code) ?? Number.POSITIVE_INFINITY) > P.keepCap) return "시총 순위 밖";
      const rets = legRets(byCode.get(p.code)!, i);
      if (!rets.every(Number.isFinite)) return null;
      const en = ensAt(P.pool, c);
      const r = en.rank.get(p.code) ?? outsiderEnsembleRank(en, rets);
      return r > P.keepRank ? "앙상블 순위 밖" : null;
    },
  });

  // ---- 기준선 LE2·LE3를 같은 스냅샷·엔진으로 다시 계산 ----
  const baseRun = (b: Params): SimRun => simSlots(env, cfgFor(b.slots), hooksFor(b), { lag: 1, detail: true });
  const le2Run = baseRun(LW_BASES.LE2), le3Run = baseRun(LW_BASES.LE3);
  for (const [name, run] of [["LE2", le2Run], ["LE3", le3Run]] as const) {
    const f = h.st(run, W.FULL), r = LW_BASES[name].ref;
    console.log(`기준선 ${name} 재계산(고정 스냅샷, 데이터 종료일 ${h.dataEnd}): 전체 CAGR ${f2(f.cagr)} / MDD ${f2(f.mdd)} — LE 시험 ${r.cagr.toFixed(2)} / ${r.mdd.toFixed(2)}와 ${Math.abs(f.cagr - r.cagr) < 0.006 && Math.abs(f.mdd - r.mdd) < 0.006 ? "일치" : "불일치(보고만, 중단 안 함)"}`);
  }
  const le2Full = h.st(le2Run, W.FULL), le3Full = h.st(le3Run, W.FULL);

  const bhFrom: { dates: string[]; ret: number[] } = { dates: h.bhP.dates.filter((d) => d >= W.FULL.from), ret: h.bhP.ret.filter((_, k) => h.bhP.dates[k] >= W.FULL.from) };
  const hVs = (full: { cagr: number; mdd: number }, rb: { cagr: number; mdd: number }): { ok: boolean; text: string } => {
    const dc = full.cagr - rb.cagr, dm = rb.mdd - full.mdd;
    const c1 = dc >= LW_H_CAGR_GAIN_PP, c2 = dm >= LW_H_MDD_GAIN_PP && dc >= -LW_H_CAGR_FLOOR_PP;
    return { ok: c1 || c2, text: `CAGR ${dc >= 0 ? "+" : ""}${f2(dc)}%p, MDD ${dm >= 0 ? "−" : "+"}${f2(Math.abs(dm))}%p(개선 ${f2(dm)}%p; ${LW_H_MDD_GAIN_STRONG_PP}%p 이상 ${dm >= LW_H_MDD_GAIN_STRONG_PP ? "O" : "X"}) → 조건1(CAGR +${LW_H_CAGR_GAIN_PP}%p) ${c1 ? "O" : "X"}, 조건2(MDD 개선 ${LW_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${LW_H_CAGR_FLOOR_PP}%p) ${c2 ? "O" : "X"}` };
  };
  const yrs = (Date.parse(h.dataEnd) - Date.parse(W.FULL.from)) / 86_400_000 / 365.25;

  const mkSpec = (id: WId): CandSpec => {
    const cd = LW_CANDS[id], P: Params = { pool: cd.pool, slots: cd.slots, keepRank: cd.keepRank, keepCap: cd.keepCap }, cfg = cfgFor(cd.slots);
    const nb: { label: string; run: () => SimRun }[] = [];
    for (const k of cd.slotsNeighbors) nb.push({ label: `보유 수 ${k}`, run: () => simSlots(env, cfgFor(k), hooksFor({ ...P, slots: k }), { lag: 1 }) });
    for (const k of cd.keepNeighbors) nb.push({ label: `앙상블 순위 매도 한도 ${k}`, run: () => simSlots(env, cfg, hooksFor({ ...P, keepRank: k }), { lag: 1 }) });
    return {
      id, trial: cd.trial, title: `시총 상위 ${cd.pool}위 풀, 3·6·12-1개월 수익률 백분위 평균(앙상블) 상위 ${cd.slots}개(종목당 ${f2(100 / cd.slots)}%), 앙상블 순위 ${cd.keepRank}위 밖 또는 시총 ${cd.keepCap}위 밖 시 매도, 12-1개월 수익률 ≤ 0 편입 금지, 재진입 ${LS_COOLDOWN_DAYS}거래일 후`,
      defense: false, capFrac: 1 / cd.slots, fDenominator: 3, ref: { id: "LE3", run: le3Run },
      hRule: (full, le3) => { const a = hVs(full, le3), b = hVs(full, le2Full); return { ok: a.ok && b.ok, note: `${a.text} | LE2 ${f2(le2Full.cagr)} / ${f2(le2Full.mdd)} 대비 ${b.text} | 두 기준선 모두 만족 ${a.ok && b.ok ? "O" : "X"}` }; },
      run: (o) => simSlots(env, cfg, hooksFor(P, o.exclude), { lag: o.lag, int: o.int, replace: o.replace, detail: o.detail }),
      neighbors: nb,
      // 풀 = 편입 가능한 풀 안 12-1개월 수익률 양(+) 종목 중 보유·재진입 금지가 아닌 종목. 신호일마다 실제 매수 주문 수만큼 무작위로 고른다.
      random: (rng, ordersByDay) => simSlots(env, cfg, {
        candsOf: (c, held, blocked) => {
          const n = ordersByDay.get(c) ?? 0;
          if (!n) return [];
          const en = ensAt(P.pool, c);
          const pool = en.items.filter((it) => it.rets[LE_ENTRY_LEG] > 0 && !held(it.code) && !blocked(it.code)).map((it) => ({ s: en.sOf.get(it.code)!, code: it.code })), out: SimCand[] = [];
          while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
          return out;
        },
        exitReason: hooksFor(P).exitReason,
      }, { lag: 1 }),
      reasons: ["시총 순위 밖", "앙상블 순위 밖", "폐지"],
      label,
      extra: (run) => {
        const E = (name: string, r: SimRun): void => { for (const [wn, w] of W.ALL) { const s = h.st(r, w), b = h.st(h.bhP, w), l2 = h.st(le2Run, w), l3 = h.st(le3Run, w); console.log(`  ${name} | ${wn}: CAGR ${f2(s.cagr)} / MDD ${f2(s.mdd)} (069500 ${f2(b.cagr)} / ${f2(b.mdd)}, LE2 ${f2(l2.cagr)} / ${f2(l2.mdd)}, LE3 ${f2(l3.cagr)} / ${f2(l3.mdd)})`); } };
        console.log(`${id} 진입 ${run.entryCs.length}건 · 보유일 중앙값 ${f2(median(run.trades.map((t) => t.exitC - t.entryC)))}일 (LE2 ${le2Run.entryCs.length}건 · ${f2(median(le2Run.trades.map((t) => t.exitC - t.entryC)))}일, LE3 ${le3Run.entryCs.length}건 · ${f2(median(le3Run.trades.map((t) => t.exitC - t.entryC)))}일) · 평균 보유 종목 수(전체 날) ${f2(avg(run.nPos))}`);
        console.log(`${id} 현금·투자·회전율·비용 (괄호 = LE2 / LE3)\n| 구간 | 평균 투자 비중 % | 현금 비중 % | 연 회전율 % | 비용 합계 % (구간 안 일별 비용 합) |\n|---|---|---|---|---|`);
        for (const [wn, w] of W.ALL) {
          const s = h.st(run, w), b2 = h.st(le2Run, w), b3 = h.st(le3Run, w);
          console.log(`| ${wn} | ${f2(s.avgInv)} (${f2(b2.avgInv)} / ${f2(b3.avgInv)}) | ${f2(100 - s.avgInv)} (${f2(100 - b2.avgInv)} / ${f2(100 - b3.avgInv)}) | ${f2(s.turnover)} (${f2(b2.turnover)} / ${f2(b3.turnover)}) | ${f2(s.cost)} (${f2(b2.cost)} / ${f2(b3.cost)}) |`);
        }
        const fs = h.st(run, W.FULL);
        console.log(`${id} 15년 합계 비용 ${f2(fs.cost)}% (연평균 ${f2(fs.cost / yrs)}%) vs LE2 ${f2(le2Full.cost)}% (${f2(le2Full.cost / yrs)}%) · LE3 ${f2(le3Full.cost)}% (${f2(le3Full.cost / yrs)}%)`);
        console.log(`${id} 학습 구간(2011~2016) 연도별 수익률: 후보 − 069500 (%p) — ${[2011, 2012, 2013, 2014, 2015, 2016].map((y) => { const a = h.yearRet(run, y), b = h.yearRet(bhFrom, y); return `${y}년 ${f2(a)} vs ${f2(b)} (${a - b >= 0 ? "+" : ""}${f2(a - b)})`; }).join(" | ")}`);
        console.log(`${id} 하루 지연(lag 2) 구간별 성적`);
        E(`${id} lag 2`, simSlots(env, cfg, hooksFor(P), { lag: 2, detail: true }));
        const top3 = [...run.trades].sort((a, b) => (b.proceeds - b.spend) / b.vAtEntry - (a.proceeds - a.spend) / a.vAtEntry).slice(0, 3);
        console.log(`${id} 상위 3개 거래(${top3.map((t) => `${label(t.code)} ${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")})를 069500 수익률로 바꾼 구간별 성적(= 제외)`);
        E(`${id} 상위 3개 거래 대체`, simSlots(env, cfg, hooksFor(P), { lag: 1, detail: true, replace: new Set(top3.map((t) => `${t.code}|${t.entryC}`)) }));
        console.log(`${id} 하락 구간 성과 (누적 % / MDD %)`);
        for (const [name, f, t] of [["2020-03", "2020-03-01", "2020-03-31"], ["2022", "2022-01-01", "2022-12-31"], ["2026-10-01~10-15", "2026-10-01", "2026-10-15"]] as const) console.log(`  ${name}: ${id} ${h.periodStat(run, f, t)} | 069500 ${h.periodStat(h.bhP, f, t)} | LE2 ${h.periodStat(le2Run, f, t)} | LE3 ${h.periodStat(le3Run, f, t)}`);
        for (const [wn, w] of W.ALL) { const s = h.st(run, w); console.log(`  ${id} | ${wn}: 평균 투자 비중 ${f2(s.avgInv)}% / 현금 비중 ${f2(100 - s.avgInv)}% / 평균 보유 종목 수 ${f2(s.avgN)}`); }
        const wsum = new Map<string, number>();
        let nDays = 0, invSum = 0;
        simSlots(env, cfg, hooksFor(P), { lag: 1, onDay: (_c, V, held) => { nDays++; for (const [code, val] of held) { wsum.set(code, (wsum.get(code) ?? 0) + val / V); invSum += val / V; } } });
        const wavg = (code: string): number => ((wsum.get(code) ?? 0) / Math.max(nDays, 1)) * 100;
        console.log(`${id} 일별 평균 계좌 비중(현금 날 포함, 열린 포지션 포함; ${nDays}일): 삼성전자 ${f2(wavg(SAMSUNG))}% · SK하이닉스 ${f2(wavg(HYNIX))}% · 합 ${f2(wavg(SAMSUNG) + wavg(HYNIX))}% | 투자분 중 두 종목 비중 ${f2(((wsum.get(SAMSUNG) ?? 0) + (wsum.get(HYNIX) ?? 0)) / Math.max(invSum, 1e-12) * 100)}% | 상위 8: ${[...wsum].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${label(k)} ${f2((v / Math.max(nDays, 1)) * 100)}%`).join(", ")}`);
      },
    };
  };

  const order = (["LW1", "LW2", "LW3"] as WId[]).filter((id) => only.has(id));
  const verdicts: Verdict[] = [], specs: CandSpec[] = [];
  for (const id of order) { const sp = mkSpec(id); specs.push(sp); verdicts.push(evaluate(h, W, sp)); }
  console.log(`\n=== 구간별 CAGR / MDD — 069500 · LE2 · LE3(고정 스냅샷 재계산) · 후보 ===\n| 구간 | 069500 | LE2 | LE3 | ${verdicts.map((v) => v.id).join(" | ")} |\n|---|---|---|---|${verdicts.map(() => "---").join("|")}|`);
  for (const [wn, w] of W.ALL) { const b = h.st(h.bhP, w), l2 = h.st(le2Run, w), l3 = h.st(le3Run, w); console.log(`| ${wn} | ${f2(b.cagr)} / ${f2(b.mdd)} | ${f2(l2.cagr)} / ${f2(l2.mdd)} | ${f2(l3.cagr)} / ${f2(l3.mdd)} | ${verdicts.map((v) => { const s = h.st(v.run, w); return `${f2(s.cagr)} / ${f2(s.mdd)}`; }).join(" | ")} |`); }
  // ---- 보유 종목 수별 한 장 표 ----
  const rows: { n: string; name: string; pool: string; run: SimRun }[] = [{ n: "5", name: "LE2", pool: "30", run: le2Run }, { n: "10", name: "LE3", pool: "50", run: le3Run }, ...verdicts.map((v) => ({ n: String(LW_CANDS[v.id as WId].slots), name: v.id, pool: String(LW_CANDS[v.id as WId].pool), run: v.run }))].sort((a, b) => Number(a.n) - Number(b.n));
  console.log(`\n=== 보유 종목 수별 한 장 표 (069500 전체 ${f2(h.st(h.bhP, W.FULL).cagr)} / ${f2(h.st(h.bhP, W.FULL).mdd)}, 학습 ${f2(h.st(h.bhP, W.ALL[0][1]).cagr)} / ${f2(h.st(h.bhP, W.ALL[0][1]).mdd)}, 확인 ${f2(h.st(h.bhP, W.ALL[1][1]).cagr)} / ${f2(h.st(h.bhP, W.ALL[1][1]).mdd)}, 보류 ${f2(h.st(h.bhP, W.ALL[2][1]).cagr)} / ${f2(h.st(h.bhP, W.ALL[2][1]).mdd)}) ===\n| 보유 수 | 전략(풀) | 학습 CAGR / MDD | 확인 CAGR / MDD | 보류 CAGR / MDD | 전체 CAGR / MDD | 2026 제외 CAGR / MDD | 연 회전율 % | 15년 합계 비용 % (연평균) | 진입 건수 | 보유일 중앙값 |\n|---|---|---|---|---|---|---|---|---|---|---|`);
  const ex26 = { from: W.FULL.from, to: "2025-12-31" };
  for (const r of rows) { const f = h.st(r.run, W.FULL), x = h.st(r.run, ex26); console.log(`| ${r.n} | ${r.name}(시총 ${r.pool}위) | ${W.NW.map(([, w]) => { const s = h.st(r.run, w); return `${f2(s.cagr)} / ${f2(s.mdd)}`; }).join(" | ")} | ${f2(f.cagr)} / ${f2(f.mdd)} | ${f2(x.cagr)} / ${f2(x.mdd)} | ${f2(f.turnover)} | ${f2(f.cost)} (${f2(f.cost / yrs)}) | ${r.run.entryCs.length} | ${f2(median(r.run.trades.map((t) => t.exitC - t.entryC)))} |`); }
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: LW_PRIOR_TESTS });
  yearlyTable(h, W, [{ id: "LE2(재계산)", run: le2Run }, { id: "LE3(재계산)", run: le3Run }, ...verdicts.map((v) => ({ id: v.id, run: v.run }))]);
  seedReport(h, W, specs, new Map(verdicts.map((v) => [v.id, v.run])), (code, c) => { const s = byCode.get(code)!, i = s.idx.get(CAL[c]); return i === undefined ? NaN : s.avgTvRow[i]; });
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${verdicts.map((v) => v.trial).join(", ")}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

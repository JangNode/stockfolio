/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 AM: LE2(대형주 풀 모멘텀 앙상블 5종목 로테이션)에 종목별 절대 모멘텀 청산(보유 종목 자기 수익률이 0 이하이면 다음 거래일 종가 매도)을 더한
 * AM1(226)·AM2(227)·AM3(228). 후보당 1회 실행. 사전 등록: docs/research/le2-absolute-momentum-prereg.md. 가격 Parquet은 고정 스냅샷(데이터 종료일 2026-10-26, PARQUET_CACHE_FROZEN=1)에서만 읽고,
 * 월말 시장 목록(Storage 약 0.2 MiB)·적용된 조정 이벤트·069500 가격은 데이터 종료일 이하만 읽는다. DB·Storage 쓰기 0. 환경 변수 CAND_ONLY는 크래시 복구 전용.
 * 표의 비교 열 LE2와 LV1(연구 LV, LE2 + 변동성 목표 20%)은 같은 스냅샷으로 다시 계산한다(시도 수에 넣지 않음).
 */
import { simSlots, type SimCand, type SimPos, type SimRun, type SimVt } from "@/lib/slotSim";
import { L_SLIPPAGE, L_EVAL_AFTER } from "@/lib/megacapTrendConfig";
import { LS_COOLDOWN_DAYS } from "@/lib/megacapTrailingConfig";
import { LE_CANDS, LE_LEGS, LE_ENTRY_LEG, LE_RANK_DEPTH } from "@/lib/momentumEnsembleConfig";
import { AM_CANDS, AM_PRIOR_TESTS, AM_LV1_TARGET, AM_LV1_REF, AM_LE2_REF, AM_H_CAGR_GAIN_PP, AM_H_MDD_GAIN_PP, AM_H_MDD_GAIN_STRONG_PP, AM_H_CAGR_FLOOR_PP, AM_EXIT_REASON, type AmLeg } from "@/lib/le2AbsMomentumConfig";
import { LV_WINDOW, LV_ANNUAL_DAYS, LV_ROUND_DP, LV_BAND } from "@/lib/le2VolTargetConfig";
import { rankEnsemble, outsiderEnsembleRank, type EnsembleRanking } from "@/lib/momentumEnsemble";
import { alignCloses, equalWeightSigma, volMultiplier } from "@/lib/le2VolTarget";
import { absMomentumTriggered, legReturn } from "@/lib/le2AbsMomentum";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, SNAP_END, f2, avg, median, type S } from "./researchHarness";
import { evaluate, makeWindows, seedReport, yearlyTable, summaryReport, type CandSpec, type Verdict } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
type AId = keyof typeof AM_CANDS;
const SAMSUNG = "005930", HYNIX = "000660";
const LE2 = LE_CANDS.LE2;

async function main(): Promise<void> {
  console.log(`연구 AM 시험 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const only = new Set((process.env.CAND_ONLY || "AM1,AM2,AM3").split(",").map((x) => x.trim()).filter(Boolean));
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, nameOf } = await loadK200P(h);
  const cS = CAL.findIndex((d) => d >= L_EVAL_AFTER);
  if (cS < 0) throw new Error(`${L_EVAL_AFTER} 이후 거래일 없음`);
  const W = makeWindows(h, cS + 1);
  console.log(`평가 시작 판단일 ${CAL[cS]}(달력 순번 ${cS}), 수익률 집계 ${CAL[cS + 1]}~${h.dataEnd} | 구간 ${W.NW.map(([n, w]) => `${n} ${w.from}~${w.to}`).join(" / ")}`);

  // ---- 시총 순위·앙상블 점수(연구 LE·LV와 같다) ----
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
  const cfgFor = (vt?: SimVt) => ({ slip: L_SLIPPAGE, maxPos: LE2.slots, capFrac: 1 / LE2.slots, cooldown: LS_COOLDOWN_DAYS, vt });
  /** LE2 편입 후보: 풀 안 앙상블 순위 ≤ 5 이고 12-1개월 수익률 > 0(엄격). 절대 모멘텀 청산 후 재진입도 이 조건과 20거래일 금지만 따른다. */
  const entryList = (c: number, exclude?: Set<string>): SimCand[] => {
    const en = ensAt(c), out: SimCand[] = [];
    for (let k = 0; k < LE2.slots && k < en.items.length; k++) { const it = en.items[k]; if (it.rets[LE_ENTRY_LEG] > 0 && !exclude?.has(it.code)) out.push({ s: en.sOf.get(it.code)!, code: it.code }); }
    return out;
  };
  /**
   * LE2 청산(시총 순위 > 40 또는 앙상블 순위 > 10, 판단일 행이 없거나 세 구간 중 하나라도 못 구하면 그 규칙은 판단 안 함)을 먼저 보고,
   * 해당이 없으면 절대 모멘텀 청산(am이 있을 때): 보유 종목 자신의 수익률(legs)이 0 이하인 구간이 minNeg개 이상이면 "절대 모멘텀".
   */
  const hooksFor = (am?: { legs: readonly AmLeg[]; minNeg: number }, exclude?: Set<string>) => ({
    candsOf: (c: number): SimCand[] => entryList(c, exclude),
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
  // 주의: 위 구조는 LE 시험의 LE2 규칙과 같다 — 앙상블 구간 중 하나라도 계산 불가이면 순위 판정을 건너뛰고(보유), 시총 순위 판정은 그와 무관하게 먼저 한다.

  // ---- 비교 열: LE2(기저)·LV1(LE2 + 변동성 목표 20%)을 같은 스냅샷·엔진으로 다시 계산 ----
  const alignedCache = new Map<string, Float64Array>();
  const alignedOf = (code: string): Float64Array => {
    let a = alignedCache.get(code);
    if (!a) { const s = byCode.get(code)!; a = alignCloses(CAL, s.idx, s.close); alignedCache.set(code, a); }
    return a;
  };
  const vtFor = (target: number): SimVt => ({ sizeMult: (c, stocks) => volMultiplier(equalWeightSigma(stocks.map((s) => alignedOf(s.code)), c, LV_WINDOW, LV_ANNUAL_DAYS), target, LV_ROUND_DP), band: LV_BAND });
  const le2Run = simSlots(env, cfgFor(), hooksFor(), { lag: 1, detail: true });
  const lv1Run = simSlots(env, cfgFor(vtFor(AM_LV1_TARGET)), hooksFor(), { lag: 1, detail: true });
  const le2Full = h.st(le2Run, W.FULL), lv1Full = h.st(lv1Run, W.FULL);
  console.log(`기저 LE2 재계산(고정 스냅샷, 데이터 종료일 ${h.dataEnd}): 전체 CAGR ${f2(le2Full.cagr)} / MDD ${f2(le2Full.mdd)} — LE 시험 ${AM_LE2_REF.cagr.toFixed(2)} / ${AM_LE2_REF.mdd.toFixed(2)}와 ${Math.abs(le2Full.cagr - AM_LE2_REF.cagr) < 0.006 && Math.abs(le2Full.mdd - AM_LE2_REF.mdd) < 0.006 ? "일치" : "불일치(보고만, 중단 안 함)"}`);
  console.log(`비교 열 LV1 재계산: 전체 CAGR ${f2(lv1Full.cagr)} / MDD ${f2(lv1Full.mdd)} — LV 시험 ${AM_LV1_REF.cagr.toFixed(2)} / ${AM_LV1_REF.mdd.toFixed(2)}와 ${Math.abs(lv1Full.cagr - AM_LV1_REF.cagr) < 0.006 && Math.abs(lv1Full.mdd - AM_LV1_REF.mdd) < 0.006 ? "일치" : "불일치(보고만, 중단 안 함)"}`);
  console.log(`LE2 기저 청산 사유별(전체): ${["시총 순위 밖", "앙상블 순위 밖", "폐지"].map((r) => `${r} ${le2Run.trades.filter((t) => t.reason === r).length}`).join(" / ")} | 닫힌 거래 ${le2Run.trades.length}건`);

  const bhFrom: { dates: string[]; ret: number[] } = { dates: h.bhP.dates.filter((d) => d >= W.FULL.from), ret: h.bhP.ret.filter((_, k) => h.bhP.dates[k] >= W.FULL.from) };
  const hVs = (full: { cagr: number; mdd: number }, rb: { cagr: number; mdd: number }): { ok: boolean; text: string } => {
    const dc = full.cagr - rb.cagr, dm = rb.mdd - full.mdd;
    const c1 = dc >= AM_H_CAGR_GAIN_PP, c2 = dm >= AM_H_MDD_GAIN_PP && dc >= -AM_H_CAGR_FLOOR_PP;
    return { ok: c1 || c2, text: `CAGR ${dc >= 0 ? "+" : ""}${f2(dc)}%p, MDD ${dm >= 0 ? "−" : "+"}${f2(Math.abs(dm))}%p(개선 ${f2(dm)}%p; ${AM_H_MDD_GAIN_STRONG_PP}%p 이상 ${dm >= AM_H_MDD_GAIN_STRONG_PP ? "O" : "X"}) → 조건1(CAGR +${AM_H_CAGR_GAIN_PP}%p) ${c1 ? "O" : "X"}, 조건2(MDD 개선 ${AM_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${AM_H_CAGR_FLOOR_PP}%p) ${c2 ? "O" : "X"}` };
  };
  const inWin = (d: string, w: { from: string; to: string }): boolean => d >= w.from && d <= w.to;

  const mkSpec = (id: AId): CandSpec => {
    const cd = AM_CANDS[id], am = { legs: cd.legs, minNeg: cd.minNeg }, cfg = cfgFor();
    const nb: { label: string; run: () => SimRun }[] = cd.neighbors.map((v) => ({ label: v.label, run: () => simSlots(env, cfg, hooksFor({ legs: v.legs, minNeg: cd.minNeg }), { lag: 1 }) }));
    return {
      id, trial: cd.trial, title: `LE2(시총 상위 30위 풀, 3·6·12-1개월 백분위 평균 상위 5개, 앙상블 10위 밖·시총 40위 밖 매도) + 절대 모멘텀 청산(보유 종목 ${cd.legs.map((l) => `${l.lookback}−${l.skip}`).join("·")} 수익률 중 ${cd.legs.length > 1 ? `${cd.minNeg}개 이상` : ""} 0 이하이면 다음 거래일 종가 매도)`,
      defense: false, capFrac: 1 / LE2.slots, fDenominator: 3, ref: { id: "LE2", run: le2Run },
      hRule: (full, le2) => { const a = hVs(full, le2); return { ok: a.ok, note: a.text }; },
      run: (o) => simSlots(env, cfg, hooksFor(am, o.exclude), { lag: o.lag, int: o.int, replace: o.replace, detail: o.detail }),
      neighbors: nb,
      // 풀 = 편입 가능한 풀 안 12-1개월 수익률 양(+) 종목 중 보유·재진입 금지가 아닌 종목. 같은 청산 규칙(순위 + 절대 모멘텀)을 적용한다.
      random: (rng, ordersByDay) => simSlots(env, cfg, {
        candsOf: (c, held, blocked) => {
          const n = ordersByDay.get(c) ?? 0;
          if (!n) return [];
          const en = ensAt(c);
          const pool = en.items.filter((it) => it.rets[LE_ENTRY_LEG] > 0 && !held(it.code) && !blocked(it.code)).map((it) => ({ s: en.sOf.get(it.code)!, code: it.code })), out: SimCand[] = [];
          while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
          return out;
        },
        exitReason: hooksFor(am).exitReason,
      }, { lag: 1 }),
      reasons: ["시총 순위 밖", "앙상블 순위 밖", AM_EXIT_REASON, "폐지"],
      label,
      extra: (run) => {
        const E = (name: string, r: SimRun): void => { for (const [wn, w] of W.ALL) { const s = h.st(r, w), b = h.st(h.bhP, w), l = h.st(le2Run, w), v = h.st(lv1Run, w); console.log(`  ${name} | ${wn}: CAGR ${f2(s.cagr)} / MDD ${f2(s.mdd)} (069500 ${f2(b.cagr)} / ${f2(b.mdd)}, LE2 ${f2(l.cagr)} / ${f2(l.mdd)}, LV1 ${f2(v.cagr)} / ${f2(v.mdd)})`); } };
        console.log(`${id} 진입 ${run.entryCs.length}건 · 보유일 중앙값 ${f2(median(run.trades.map((t) => t.exitC - t.entryC)))}일 (LE2 진입 ${le2Run.entryCs.length}건 · 보유일 중앙값 ${f2(median(le2Run.trades.map((t) => t.exitC - t.entryC)))}일) · 평균 보유 종목 수(전체 날) ${f2(avg(run.nPos))}`);
        const am_trades = run.trades.filter((t) => t.reason === AM_EXIT_REASON);
        console.log(`${id} 절대 모멘텀 청산 ${am_trades.length}건 / 닫힌 거래 ${run.trades.length}건 | 평균 거래 수익률 ${f2(avg(am_trades.map((t) => (t.proceeds / t.spend - 1) * 100)))}% (이긴 ${am_trades.filter((t) => t.proceeds > t.spend).length}건) | 연도별: ${[...new Set(am_trades.map((t) => CAL[t.exitC].slice(0, 4)))].sort().map((y) => `${y} ${am_trades.filter((t) => CAL[t.exitC].startsWith(y)).length}`).join(" ")}`);
        console.log(`${id} 현금·투자·회전율·비용 (괄호 = LE2)\n| 구간 | 평균 투자 비중 % | 현금 비중 % | 현금 100% 일수 / 일수 | 연 회전율 % | 비용 합계 % (구간 안 일별 비용 합) |\n|---|---|---|---|---|---|`);
        for (const [wn, w] of W.ALL) {
          const idx = run.dates.map((d, i) => (inWin(d, w) ? i : -1)).filter((i) => i >= 0), jdx = le2Run.dates.map((d, i) => (inWin(d, w) ? i : -1)).filter((i) => i >= 0);
          const s = h.st(run, w), b = h.st(le2Run, w);
          console.log(`| ${wn} | ${f2(s.avgInv)} (${f2(b.avgInv)}) | ${f2(100 - s.avgInv)} (${f2(100 - b.avgInv)}) | ${idx.filter((i) => run.nPos[i] === 0).length} (${jdx.filter((i) => le2Run.nPos[i] === 0).length}) / ${idx.length} | ${f2(s.turnover)} (${f2(b.turnover)}) | ${f2(s.cost)} (${f2(b.cost)}) |`);
        }
        const fs = h.st(run, W.FULL), fb = h.st(le2Run, W.FULL), yrs = (Date.parse(h.dataEnd) - Date.parse(W.FULL.from)) / 86_400_000 / 365.25;
        console.log(`${id} 15년 합계 비용 ${f2(fs.cost)}% (연평균 ${f2(fs.cost / yrs)}%) vs LE2 ${f2(fb.cost)}% (연평균 ${f2(fb.cost / yrs)}%) → 차이 ${f2(fs.cost - fb.cost)}%p`);
        console.log(`${id} 학습 구간(2011~2016) 연도별 수익률: 후보 − 069500 (%p) — ${[2011, 2012, 2013, 2014, 2015, 2016].map((y) => { const a = h.yearRet(run, y), b = h.yearRet(bhFrom, y); return `${y}년 ${f2(a)} vs ${f2(b)} (${a - b >= 0 ? "+" : ""}${f2(a - b)})`; }).join(" | ")}`);
        console.log(`${id} 하루 지연(lag 2) 구간별 성적`);
        E(`${id} lag 2`, simSlots(env, cfg, hooksFor(am), { lag: 2, detail: true }));
        const top3 = [...run.trades].sort((a, b) => (b.proceeds - b.spend) / b.vAtEntry - (a.proceeds - a.spend) / a.vAtEntry).slice(0, 3);
        console.log(`${id} 상위 3개 거래(${top3.map((t) => `${label(t.code)} ${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")})를 069500 수익률로 바꾼 구간별 성적(= 제외)`);
        E(`${id} 상위 3개 거래 대체`, simSlots(env, cfg, hooksFor(am), { lag: 1, detail: true, replace: new Set(top3.map((t) => `${t.code}|${t.entryC}`)) }));
        console.log(`${id} 하락 구간 성과 (누적 % / MDD %)와 절대 모멘텀 청산 (체결일 = 판단 다음 거래일 종가)`);
        for (const [name, f, t, ctxFrom, ctxTo] of [["2020-03", "2020-03-01", "2020-03-31", "2020-02-03", "2020-03-31"], ["2022", "2022-01-01", "2022-12-31", "2022-01-01", "2022-12-31"], ["2026-10-01~10-15", "2026-10-01", "2026-10-15", "2026-09-01", "2026-10-26"]] as const) {
          console.log(`  ${name}: ${id} ${h.periodStat(run, f, t)} | 069500 ${h.periodStat(h.bhP, f, t)} | LE2 ${h.periodStat(le2Run, f, t)} | LV1 ${h.periodStat(lv1Run, f, t)}`);
          const ex = am_trades.filter((x) => CAL[x.exitC] >= ctxFrom && CAL[x.exitC] <= ctxTo).sort((a, b) => a.exitC - b.exitC);
          console.log(`    ${ctxFrom}~${ctxTo} 절대 모멘텀 청산 ${ex.length}건${ex.length ? `: ${ex.slice(0, 40).map((x) => `${CAL[x.exitC]} ${label(x.code)} ${f2((x.proceeds / x.spend - 1) * 100)}%`).join(", ")}${ex.length > 40 ? " …" : ""}` : ""}`);
        }
        for (const [wn, w] of W.ALL) { const s = h.st(run, w); console.log(`  ${id} | ${wn}: 평균 투자 비중 ${f2(s.avgInv)}% / 현금 비중 ${f2(100 - s.avgInv)}% / 평균 보유 종목 수 ${f2(s.avgN)}`); }
        const wsum = new Map<string, number>();
        let nDays = 0, invSum = 0;
        simSlots(env, cfg, hooksFor(am), { lag: 1, onDay: (_c, V, held) => { nDays++; for (const [code, val] of held) { wsum.set(code, (wsum.get(code) ?? 0) + val / V); invSum += val / V; } } });
        const wavg = (code: string): number => ((wsum.get(code) ?? 0) / Math.max(nDays, 1)) * 100;
        console.log(`${id} 일별 평균 계좌 비중(현금 날 포함, 열린 포지션 포함; ${nDays}일): 삼성전자 ${f2(wavg(SAMSUNG))}% · SK하이닉스 ${f2(wavg(HYNIX))}% · 합 ${f2(wavg(SAMSUNG) + wavg(HYNIX))}% | 투자분 중 두 종목 비중 ${f2(((wsum.get(SAMSUNG) ?? 0) + (wsum.get(HYNIX) ?? 0)) / Math.max(invSum, 1e-12) * 100)}% | 상위 8: ${[...wsum].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${label(k)} ${f2((v / Math.max(nDays, 1)) * 100)}%`).join(", ")}`);
      },
    };
  };

  const order = (["AM1", "AM2", "AM3"] as AId[]).filter((id) => only.has(id));
  const verdicts: Verdict[] = [], specs: CandSpec[] = [];
  for (const id of order) { const sp = mkSpec(id); specs.push(sp); verdicts.push(evaluate(h, W, sp)); }
  console.log(`\n=== 구간별 CAGR / MDD — 069500 · LE2 · LV1(고정 스냅샷 재계산) · 후보 ===\n| 구간 | 069500 | LE2 | LV1 | ${verdicts.map((v) => v.id).join(" | ")} |\n|---|---|---|---|${verdicts.map(() => "---").join("|")}|`);
  for (const [wn, w] of W.ALL) { const b = h.st(h.bhP, w), l = h.st(le2Run, w), v1 = h.st(lv1Run, w); console.log(`| ${wn} | ${f2(b.cagr)} / ${f2(b.mdd)} | ${f2(l.cagr)} / ${f2(l.mdd)} | ${f2(v1.cagr)} / ${f2(v1.mdd)} | ${verdicts.map((v) => { const s = h.st(v.run, w); return `${f2(s.cagr)} / ${f2(s.mdd)}`; }).join(" | ")} |`); }
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: AM_PRIOR_TESTS });
  yearlyTable(h, W, [{ id: "LE2(재계산)", run: le2Run }, { id: "LV1(재계산)", run: lv1Run }, ...verdicts.map((v) => ({ id: v.id, run: v.run }))]);
  seedReport(h, W, specs, new Map(verdicts.map((v) => [v.id, v.run])), (code, c) => { const s = byCode.get(code)!, i = s.idx.get(CAL[c]); return i === undefined ? NaN : s.avgTvRow[i]; });
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${verdicts.map((v) => v.trial).join(", ")}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

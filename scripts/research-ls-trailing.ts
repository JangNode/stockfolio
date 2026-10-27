/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 LS: 대형주 집중 + 고점 대비 trailing stop LS1(211)·LS2(212)·LS3(213). 후보당 1회 실행.
 * 사전 등록: docs/research/megacap-trailing-prereg.md. 가격 Parquet(Actions 캐시)·월말 시장 목록(Storage 약 0.2 MiB)·적용된 조정 이벤트·069500 가격만 읽는다. DB·Storage 쓰기 0.
 * 연구 L(scripts/research-l-megacap.ts)의 유니버스·순위·엔진을 그대로 쓰고 추세 규칙 대신 trailing stop과 재진입 금지를 더한다. 환경 변수 CAND_ONLY는 크래시 복구 전용.
 */
import { simSlots, type SimCand, type SimPos, type SimRun } from "@/lib/slotSim";
import { L_CANDS, L_SLIPPAGE, L_RANK_DEPTH, L_EVAL_AFTER } from "@/lib/megacapTrendConfig";
import { LS_CANDS, LS_PRIOR_TESTS, LS_COOLDOWN_DAYS, LS_REF_L3 } from "@/lib/megacapTrailingConfig";
import { loadHarness, loadK200P, dbRead, xfer, f2, avg, median, type S } from "./researchHarness";
import { evaluate, makeWindows, seedReport, yearlyTable, summaryReport, type CandSpec, type Verdict } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
type LId = keyof typeof LS_CANDS;
const SAMSUNG = "005930", HYNIX = "000660";

async function main(): Promise<void> {
  console.log(`연구 LS 시험 시작(읽기 전용): ${new Date().toISOString()}`);
  const only = new Set((process.env.CAND_ONLY || "LS1,LS2,LS3").split(",").map((x) => x.trim()).filter(Boolean));
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, nameOf } = await loadK200P(h);
  const cS = CAL.findIndex((d) => d >= L_EVAL_AFTER);
  if (cS < 0) throw new Error(`${L_EVAL_AFTER} 이후 거래일 없음`);
  const W = makeWindows(h, cS + 1);
  console.log(`평가 시작 판단일 ${CAL[cS]}(달력 순번 ${cS}), 수익률 집계 ${CAL[cS + 1]}~${h.dataEnd} | 구간 ${W.NW.map(([n, w]) => `${n} ${w.from}~${w.to}`).join(" / ")}`);

  // ---- 매일 시총 순위(연구 L과 같다): 코스피 보통주, d 이하 최신 월말 목록의 시장 구분, d 행 시총 내림차순(동점 코드 오름차순) ----
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
      const list = e.slice(0, L_RANK_DEPTH).map((x) => x.s);
      v = { list, rank: new Map(list.map((s, k) => [s.code, k + 1])) };
      megaCache.set(c, v);
    }
    return v;
  };

  const env = { CAL, nCal, cS, adjustments: h.adjustments, endedBefore: h.endedBefore, stockBuyMult: h.stockBuyMult, sellRate: h.sellRate, baseSlip: SLIPPAGE_PCT_PER_SIDE, bhRet: h.bhRet };
  const label = (code: string): string => `${code} ${nameOf.get(code) ?? "?"}`;
  /** 편입 후보(순위 순): 시총 순위 ≤ entryRank. 청산: 순위 > keepRank(순위 밖) 또는 종가 ≤ 진입 후 최고 종가 × (1 − stop). 판단일 행이 없으면 보유 유지. */
  const entryList = (entryRank: number, c: number, exclude?: Set<string>): SimCand[] => megaAt(c).list.slice(0, entryRank).filter((s) => !exclude?.has(s.code)).map((s) => ({ s, code: s.code }));
  const hooksFor = (entryRank: number, keep: number, stop: number | null, exclude?: Set<string>) => ({
    candsOf: (c: number): SimCand[] => entryList(entryRank, c, exclude),
    exitReason: (p: SimPos, c: number, i: number | undefined): string | null => {
      if (i === undefined) return null;
      const r = megaAt(c).rank.get(p.code) ?? Number.POSITIVE_INFINITY;
      if (r > keep) return "시총 순위 밖";
      if (stop !== null && p.s.close[i] <= p.peak * (1 - stop)) return "trailing stop";
      return null;
    },
  });
  const cfgFor = (slots: number, cooldown: number) => ({ slip: L_SLIPPAGE, maxPos: slots, capFrac: 1 / slots, cooldown });

  // ---- 기준선 L3(연구 L, 추세·손절 규칙 없음)를 같은 엔진으로 다시 계산해 기존 결과와 일치하는지 확인 ----
  const l3 = L_CANDS.L3;
  const l3Run = simSlots(env, cfgFor(l3.slots, 0), hooksFor(l3.entryRank, l3.keepRank, null), { lag: 1, detail: true });
  const l3Full = h.st(l3Run, W.FULL);
  const match = Math.abs(l3Full.cagr - LS_REF_L3.cagr) < 0.006 && Math.abs(l3Full.mdd - LS_REF_L3.mdd) < 0.006;
  console.log(`기준선 L3 재계산(게이트 H 기준): 전체 CAGR ${f2(l3Full.cagr)} / MDD ${f2(l3Full.mdd)} — 기존 결과 ${LS_REF_L3.cagr.toFixed(2)} / ${LS_REF_L3.mdd.toFixed(2)}와 ${match ? "일치" : "불일치(보고만, 중단 안 함)"}`);

  const mkSpec = (id: LId): CandSpec => {
    const cd = LS_CANDS[id], cfg = cfgFor(cd.slots, LS_COOLDOWN_DAYS);
    const nb: { label: string; run: () => SimRun }[] = [];
    for (const st of cd.stopNeighbors) nb.push({ label: `trailing stop −${st * 100}%`, run: () => simSlots(env, cfg, hooksFor(cd.entryRank, cd.keepRank, st), { lag: 1 }) });
    for (const k of cd.keepNeighbors) nb.push({ label: `매도 순위 한도 ${k}`, run: () => simSlots(env, cfg, hooksFor(cd.entryRank, k, cd.stop), { lag: 1 }) });
    return {
      id, trial: cd.trial, title: `시총 상위 ${cd.entryRank}위 안 편입(종목당 ${100 / cd.slots}%), 순위 ${cd.keepRank}위 밖 또는 고점 대비 −${cd.stop * 100}% 마감 시 매도, 재진입 ${LS_COOLDOWN_DAYS}거래일 후`,
      defense: false, capFrac: 1 / cd.slots, fDenominator: 3, ref: { id: "L3", run: l3Run },
      run: (o) => simSlots(env, cfg, hooksFor(cd.entryRank, cd.keepRank, cd.stop, o.exclude), { lag: o.lag, int: o.int, replace: o.replace, detail: o.detail }),
      neighbors: nb,
      // 풀 = 편입 가능한 상위 종목. 재진입 금지는 엔진이 후보 목록에 적용하므로 풀 전체를 무작위 순서로 내보내 엔진이 빈 슬롯만큼 채운다.
      random: (rng) => simSlots(env, cfg, {
        candsOf: (c, held) => {
          const pool = entryList(cd.entryRank, c).filter((x) => !held(x.code));
          for (let k = pool.length - 1; k > 0; k--) { const j = Math.floor(rng() * (k + 1)); [pool[k], pool[j]] = [pool[j], pool[k]]; }
          return pool;
        },
        exitReason: hooksFor(cd.entryRank, cd.keepRank, cd.stop).exitReason,
      }, { lag: 1 }),
      reasons: ["시총 순위 밖", "trailing stop", "폐지"],
      label,
      extra: (base) => {
        const E = (name: string, run: SimRun): void => { for (const [wn, w] of W.ALL) { const s = h.st(run, w), b = h.st(h.bhP, w), l = h.st(l3Run, w); console.log(`  ${name} | ${wn}: CAGR ${f2(s.cagr)} / MDD ${f2(s.mdd)} (069500 ${f2(b.cagr)} / ${f2(b.mdd)}, L3 ${f2(l.cagr)} / ${f2(l.mdd)})`); } };
        const nStop = base.trades.filter((t) => t.reason === "trailing stop").length;
        console.log(`${id} trailing stop(−${cd.stop * 100}%) 발동 ${nStop}건 / 닫힌 거래 ${base.trades.length}건 (${f2((nStop / Math.max(base.trades.length, 1)) * 100)}%) | 시총 순위 밖 ${base.trades.filter((t) => t.reason === "시총 순위 밖").length}건 | 진입 ${base.entryCs.length}건 · 보유일 중앙값 ${f2(median(base.trades.map((t) => t.exitC - t.entryC)))}일 · 평균 보유 종목 수(전체 날) ${f2(avg(base.nPos))}`);
        console.log(`${id} 하루 지연(lag 2) 구간별 성적`);
        E(`${id} lag 2`, simSlots(env, cfg, hooksFor(cd.entryRank, cd.keepRank, cd.stop), { lag: 2, detail: true }));
        const top3 = [...base.trades].sort((a, b) => (b.proceeds - b.spend) / b.vAtEntry - (a.proceeds - a.spend) / a.vAtEntry).slice(0, 3);
        console.log(`${id} 상위 3개 거래(${top3.map((t) => `${label(t.code)} ${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")})를 069500 수익률로 바꾼 구간별 성적(= 제외)`);
        E(`${id} 상위 3개 거래 대체`, simSlots(env, cfg, hooksFor(cd.entryRank, cd.keepRank, cd.stop), { lag: 1, detail: true, replace: new Set(top3.map((t) => `${t.code}|${t.entryC}`)) }));
        console.log(`${id} 하락 구간 성과 (누적 % / MDD %)`);
        for (const [name, f, t] of [["2020-03", "2020-03-01", "2020-03-31"], ["2022", "2022-01-01", "2022-12-31"], ["2026-10-01~10-15", "2026-10-01", "2026-10-15"]] as const) console.log(`  ${name}: ${id} ${h.periodStat(base, f, t)} | 069500 ${h.periodStat(h.bhP, f, t)} | L3 ${h.periodStat(l3Run, f, t)}`);
        for (const [wn, w] of W.ALL) { const s = h.st(base, w); console.log(`  ${id} | ${wn}: 평균 투자 비중 ${f2(s.avgInv)}% / 현금 비중 ${f2(100 - s.avgInv)}% / 평균 보유 종목 수 ${f2(s.avgN)}`); }
        // 보유 종목 구성 (1) 닫힌 거래 보유 종목-일 기준, (2) 일별 평균 계좌 비중(열린 포지션 포함, 현금 날 포함) — 같은 기본 실행을 다시 돌려 일별 평가액을 받는다
        const days = new Map<string, number>();
        let tot = 0;
        for (const t of base.trades) { const dd = t.exitC - t.entryC; days.set(t.code, (days.get(t.code) ?? 0) + dd); tot += dd; }
        const big = (days.get(SAMSUNG) ?? 0) + (days.get(HYNIX) ?? 0);
        console.log(`${id} 보유 종목 구성(닫힌 거래 보유 종목-일 ${tot}, 종목 수 ${days.size}): 삼성전자+SK하이닉스 ${f2((big / Math.max(tot, 1)) * 100)}% | 상위 8: ${[...days].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${label(k)} ${f2((v / Math.max(tot, 1)) * 100)}%`).join(", ")}`);
        const wsum = new Map<string, number>();
        let nDays = 0, invSum = 0;
        simSlots(env, cfg, hooksFor(cd.entryRank, cd.keepRank, cd.stop), { lag: 1, onDay: (_c, V, held) => { nDays++; for (const [code, val] of held) { wsum.set(code, (wsum.get(code) ?? 0) + val / V); invSum += val / V; } } });
        const wavg = (code: string): number => ((wsum.get(code) ?? 0) / Math.max(nDays, 1)) * 100;
        console.log(`${id} 일별 평균 계좌 비중(현금 날 포함, 열린 포지션 포함; ${nDays}일): 삼성전자 ${f2(wavg(SAMSUNG))}% · SK하이닉스 ${f2(wavg(HYNIX))}% · 합 ${f2(wavg(SAMSUNG) + wavg(HYNIX))}% | 투자분 중 두 종목 비중 ${f2(((wsum.get(SAMSUNG) ?? 0) + (wsum.get(HYNIX) ?? 0)) / Math.max(invSum, 1e-12) * 100)}% | 상위 8: ${[...wsum].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${label(k)} ${f2((v / Math.max(nDays, 1)) * 100)}%`).join(", ")}`);
      },
    };
  };

  const order = (["LS1", "LS2", "LS3"] as LId[]).filter((id) => only.has(id));
  const verdicts: Verdict[] = [], specs: CandSpec[] = [];
  for (const id of order) { const sp = mkSpec(id); specs.push(sp); verdicts.push(evaluate(h, W, sp)); }
  console.log(`\n=== 구간별 CAGR / MDD — 069500 · L3(기준선) · 후보 ===\n| 구간 | 069500 | L3 | ${verdicts.map((v) => v.id).join(" | ")} |\n|---|---|---|${verdicts.map(() => "---").join("|")}|`);
  for (const [wn, w] of W.ALL) { const b = h.st(h.bhP, w), l = h.st(l3Run, w); console.log(`| ${wn} | ${f2(b.cagr)} / ${f2(b.mdd)} | ${f2(l.cagr)} / ${f2(l.mdd)} | ${verdicts.map((v) => { const s = h.st(v.run, w); return `${f2(s.cagr)} / ${f2(s.mdd)}`; }).join(" | ")} |`); }
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: LS_PRIOR_TESTS });
  yearlyTable(h, W, [{ id: "L3(기준선)", run: l3Run }, ...verdicts.map((v) => ({ id: v.id, run: v.run }))]);
  seedReport(h, W, specs, new Map(verdicts.map((v) => [v.id, v.run])), (code, c) => { const s = byCode.get(code)!, i = s.idx.get(CAL[c]); return i === undefined ? NaN : s.avgTvRow[i]; });
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Storage 내려받기 합계 ${(xfer.bytes / 1048576).toFixed(2)} MiB(가격 Parquet은 Actions 캐시로 읽어 0) | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${verdicts.map((v) => v.trial).join(", ")}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 L: 시총 최상위 대형주 집중 + 200일선 추세 이탈 청산 L1(208)·L2(209)·L3(210, 통제군). 후보당 1회 실행.
 * 사전 등록: docs/research/megacap-trend-prereg.md. 가격 Parquet(Actions 캐시)·월말 시장 목록(Storage 약 0.2 MiB)·적용된 조정 이벤트·069500 가격만 읽는다. DB·Storage 쓰기 0.
 * 환경 변수 CAND_ONLY(예: "L3,L1")는 크래시 복구 전용. 파라미터·게이트 변경 금지.
 */
import { simSlots, type SimCand, type SimPos, type SimRun } from "@/lib/slotSim";
import { L_CANDS, L_PRIOR_TESTS, L_SMA, L_SMA_NEIGHBORS, L_SLIPPAGE, L_RANK_DEPTH, L_EVAL_AFTER } from "@/lib/megacapTrendConfig";
import { loadHarness, loadK200P, dbRead, xfer, f2, avg, median, type S } from "./researchHarness";
import { evaluate, makeWindows, seedReport, yearlyTable, summaryReport, type CandSpec, type Verdict } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
type LId = keyof typeof L_CANDS;
const SAMSUNG = "005930", HYNIX = "000660";

async function main(): Promise<void> {
  console.log(`연구 L 시험 시작(읽기 전용): ${new Date().toISOString()}`);
  const only = new Set((process.env.CAND_ONLY || "L3,L1,L2").split(",").map((x) => x.trim()).filter(Boolean));
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, nameOf } = await loadK200P(h);
  const cS = CAL.findIndex((d) => d >= L_EVAL_AFTER);
  if (cS < 0) throw new Error(`${L_EVAL_AFTER} 이후 거래일 없음`);
  const W = makeWindows(h, cS + 1);
  console.log(`평가 시작 판단일 ${CAL[cS]}(달력 순번 ${cS}), 수익률 집계 ${CAL[cS + 1]}~${h.dataEnd} | 구간 ${W.NW.map(([n, w]) => `${n} ${w.from}~${w.to}`).join(" / ")}`);

  // ---- 매일 시총 순위: 코스피 보통주(제외 규칙 4c1557a), d 이하 최신 월말 목록의 시장 구분, d 행 시총 내림차순(동점 코드 오름차순) ----
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
  // ---- 단순이동평균(종목 자신의 수정 종가 행 N개, 오늘 포함). 행이 N개 미만이면 NaN(위도 아래도 아님) ----
  const smaCache = new Map<string, Float64Array>();
  const smaOf = (s: S, N: number): Float64Array => {
    const k = `${s.code}|${N}`;
    let a = smaCache.get(k);
    if (!a) {
      a = new Float64Array(s.close.length).fill(NaN);
      for (let i = N - 1; i < s.close.length; i++) { let t = 0; for (let j = i - N + 1; j <= i; j++) t += s.close[j]; a[i] = t / N; }
      smaCache.set(k, a);
    }
    return a;
  };

  const env = { CAL, nCal, cS, adjustments: h.adjustments, endedBefore: h.endedBefore, stockBuyMult: h.stockBuyMult, sellRate: h.sellRate, baseSlip: SLIPPAGE_PCT_PER_SIDE, bhRet: h.bhRet };
  const label = (code: string): string => `${code} ${nameOf.get(code) ?? "?"}`;
  const cfgFor = (id: LId) => ({ slip: L_SLIPPAGE, maxPos: L_CANDS[id].slots, capFrac: 1 / L_CANDS[id].slots, cooldown: 0 });
  /** 편입 후보(순위 순): 시총 순위 ≤ entryRank, trend면 종가 > SMA(N). 청산: 순위 > keepRank(순위 밖) 또는 trend면 종가 < SMA(N). 판단일 행이 없으면 판단하지 않고 보유 유지. */
  const entryList = (id: LId, N: number, c: number, exclude?: Set<string>): SimCand[] => {
    const cd = L_CANDS[id], m = megaAt(c), d = CAL[c], out: SimCand[] = [];
    for (let k = 0; k < cd.entryRank && k < m.list.length; k++) {
      const s = m.list[k];
      if (exclude?.has(s.code)) continue;
      if (cd.trend) { const i = s.idx.get(d)!; if (!(s.close[i] > smaOf(s, N)[i])) continue; }
      out.push({ s, code: s.code });
    }
    return out;
  };
  const hooksFor = (id: LId, N: number, keep: number, exclude?: Set<string>) => ({
    candsOf: (c: number): SimCand[] => entryList(id, N, c, exclude),
    exitReason: (p: SimPos, c: number, i: number | undefined): string | null => {
      if (i === undefined) return null;
      const r = megaAt(c).rank.get(p.code) ?? Number.POSITIVE_INFINITY;
      if (r > keep) return "시총 순위 밖";
      if (L_CANDS[id].trend) { const s = byCode.get(p.code)!; if (s.close[i] < smaOf(s, N)[i]) return "200일선 이탈"; }
      return null;
    },
  });

  const mkSpec = (id: LId, ref?: { id: string; run: SimRun }): CandSpec => {
    const cd = L_CANDS[id], cfg = cfgFor(id);
    const nb: { label: string; run: () => SimRun }[] = [];
    if (cd.trend) for (const N of L_SMA_NEIGHBORS) nb.push({ label: `이동평균 ${N}일`, run: () => simSlots(env, cfg, hooksFor(id, N, cd.keepRank), { lag: 1 }) });
    for (const k of cd.keepNeighbors) nb.push({ label: `매도 순위 한도 ${k}`, run: () => simSlots(env, cfg, hooksFor(id, L_SMA, k), { lag: 1 }) });
    return {
      id, trial: cd.trial, title: `시총 상위 ${cd.entryRank}위 안${cd.trend ? ` & 종가 > ${L_SMA}일선` : ""} 편입(종목당 ${100 / cd.slots}%), 순위 ${cd.keepRank}위 밖${cd.trend ? ` 또는 ${L_SMA}일선 아래 마감` : ""} 시 매도${cd.trend ? "" : " (통제군: 추세 규칙 없음)"}`,
      defense: false, capFrac: 1 / cd.slots, fDenominator: 3, ref,
      run: (o) => simSlots(env, cfg, hooksFor(id, L_SMA, cd.keepRank, o.exclude), { lag: o.lag, int: o.int, replace: o.replace, detail: o.detail }),
      neighbors: nb,
      random: (rng, ordersByDay) => simSlots(env, cfg, {
        candsOf: (c, held) => {
          const n = ordersByDay.get(c) ?? 0;
          if (!n) return [];
          const pool = entryList(id, L_SMA, c).filter((x) => !held(x.code)), out: SimCand[] = [];
          while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
          return out;
        },
        exitReason: hooksFor(id, L_SMA, cd.keepRank).exitReason,
      }, { lag: 1 }),
      reasons: ["시총 순위 밖", "200일선 이탈", "폐지"],
      label,
      extra: (base) => {
        const E = (name: string, run: SimRun): void => { for (const [wn, w] of W.ALL) { const s = h.st(run, w), b = h.st(h.bhP, w); console.log(`  ${name} | ${wn}: CAGR ${f2(s.cagr)} / MDD ${f2(s.mdd)} (069500 ${f2(b.cagr)} / ${f2(b.mdd)})`); } };
        console.log(`${id} 하루 지연(lag 2) 구간별 성적`);
        E(`${id} lag 2`, simSlots(env, cfg, hooksFor(id, L_SMA, cd.keepRank), { lag: 2, detail: true }));
        const top3 = [...base.trades].sort((a, b) => (b.proceeds - b.spend) / b.vAtEntry - (a.proceeds - a.spend) / a.vAtEntry).slice(0, 3);
        console.log(`${id} 상위 3개 거래(${top3.map((t) => `${label(t.code)} ${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")})를 069500 수익률로 바꾼 구간별 성적(= 제외)`);
        E(`${id} 상위 3개 거래 대체`, simSlots(env, cfg, hooksFor(id, L_SMA, cd.keepRank), { lag: 1, detail: true, replace: new Set(top3.map((t) => `${t.code}|${t.entryC}`)) }));
        console.log(`${id} 하락 구간 성과 (누적 % / MDD %)`);
        for (const [name, f, t] of [["2020-03", "2020-03-01", "2020-03-31"], ["2022", "2022-01-01", "2022-12-31"], ["2026-10-01~10-15", "2026-10-01", "2026-10-15"]] as const) console.log(`  ${name}: ${id} ${h.periodStat(base, f, t)} | 069500 ${h.periodStat(h.bhP, f, t)}`);
        for (const [wn, w] of W.ALL) { const s = h.st(base, w); console.log(`  ${id} | ${wn}: 평균 투자 비중 ${f2(s.avgInv)}% / 현금 비중 ${f2(100 - s.avgInv)}% / 평균 보유 종목 수 ${f2(s.avgN)}`); }
        // 보유 종목 구성(닫힌 거래의 보유 종목-일 기준; 기간 끝에 열려 있는 거래는 제외)
        const days = new Map<string, number>();
        let tot = 0;
        for (const t of base.trades) { const dd = t.exitC - t.entryC; days.set(t.code, (days.get(t.code) ?? 0) + dd); tot += dd; }
        const big = (days.get(SAMSUNG) ?? 0) + (days.get(HYNIX) ?? 0);
        console.log(`${id} 보유 종목 구성(닫힌 거래 보유 종목-일 ${tot}, 종목 수 ${days.size}): 삼성전자+SK하이닉스 ${f2((big / Math.max(tot, 1)) * 100)}% (삼성전자 ${f2(((days.get(SAMSUNG) ?? 0) / Math.max(tot, 1)) * 100)}% / SK하이닉스 ${f2(((days.get(HYNIX) ?? 0) / Math.max(tot, 1)) * 100)}%) | 상위 8: ${[...days].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${label(k)} ${f2((v / Math.max(tot, 1)) * 100)}%`).join(", ")}`);
        console.log(`${id} 진입 ${base.entryCs.length}건 · 보유일 중앙값 ${f2(median(base.trades.map((t) => t.exitC - t.entryC)))}일 · 평균 보유 종목 수(전체 날) ${f2(avg(base.nPos))}`);
      },
    };
  };

  const order = (["L3", "L1", "L2"] as LId[]).filter((id) => only.has(id));
  const verdicts: Verdict[] = [], specs: CandSpec[] = [];
  let l3Run: SimRun | undefined;
  for (const id of order) {
    const sp = mkSpec(id, id === "L3" ? undefined : l3Run ? { id: "L3", run: l3Run } : undefined);
    specs.push(sp);
    const v = evaluate(h, W, sp);
    verdicts.push(v);
    if (id === "L3") l3Run = v.run;
  }
  verdicts.sort((a, b) => a.trial - b.trial);
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: L_PRIOR_TESTS });
  yearlyTable(h, W, verdicts.map((v) => ({ id: v.id, run: v.run })));
  seedReport(h, W, specs, new Map(verdicts.map((v) => [v.id, v.run])), (code, c) => { const s = byCode.get(code)!, i = s.idx.get(CAL[c]); return i === undefined ? NaN : s.avgTvRow[i]; });
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Storage 내려받기 합계 ${(xfer.bytes / 1048576).toFixed(2)} MiB(가격 Parquet은 Actions 캐시로 읽어 0) | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${verdicts.map((v) => v.trial).join(", ")}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

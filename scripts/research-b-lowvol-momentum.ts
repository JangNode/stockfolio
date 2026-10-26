/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 B 저변동 + 모멘텀 방어 시험 B1(206)·B2(207). 후보당 1회 실행.
 * 사전 등록: docs/research/b-lowvol-quality-prereg.md (커밋 08703d4 기준). 가격 Parquet(Actions 캐시)·적용된 조정 이벤트·069500 가격만 읽는다. DB·Storage 쓰기 0.
 * 환경 변수 CAND_ONLY(예: "B1,B2")로 후보를 고를 수 있다(기본 전체). 파라미터·게이트 변경 금지.
 */
import { simSlots, type SimCand, type SimPos, type SimRun } from "@/lib/slotSim";
import { B_VOL_WINDOW, B_VOL_WINDOW_NEIGHBORS, B_MOM_LOOKBACK, B_MOM_SKIP, B_CANDS, B_KEEP_RANK_NEIGHBORS_B1, B_SLIPPAGE } from "@/lib/lowvolMomentumConfig";
import { loadHarness, loadK200P, dbRead, f2, avg, type S } from "./researchHarness";
import { evaluate, makeWindows, seedReport, yearlyTable, summaryReport, type CandSpec, type Verdict } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
type BId = keyof typeof B_CANDS;
interface BCand extends SimCand { rank: number }
interface DayRank { rank: Map<string, number>; cand: BCand[] }
/** B2 이웃 순위 유지 한도(해석: B1과 같은 방식 — 사전등록 4 게이트 D). */
const B2_KEEP_RANK_NEIGHBORS = [10, 30] as const;

async function main(): Promise<void> {
  console.log(`연구 B 시험 시작(읽기 전용): ${new Date().toISOString()}`);
  const only = new Set((process.env.CAND_ONLY || "B1,B2").split(",").map((x) => x.trim()).filter(Boolean));
  const h = await loadHarness();
  const { CAL, nCal } = h;
  const { kAt, nameOf, indOf } = await loadK200P(h);
  const cS = B_MOM_LOOKBACK, evalFromIdx = cS + 1;
  const W = makeWindows(h, evalFromIdx);
  console.log(`평가 시작 판단일 ${CAL[cS]}(달력 순번 ${cS}), 수익률 집계 ${CAL[evalFromIdx]}~${h.dataEnd} | 구간 ${W.NW.map(([n, w]) => `${n} ${w.from}~${w.to}`).join(" / ")}`);

  // ---- 일별 순위(변동성 창별 캐시) ----
  const cache = new Map<number, Map<number, DayRank>>();
  const dayRank = (vw: number, c: number): DayRank => {
    let m = cache.get(vw);
    if (!m) { m = new Map(); cache.set(vw, m); }
    let v = m.get(c);
    if (v) return v;
    const d = CAL[c];
    const items: { s: S; sig: number; mom: number; rs: number; rm: number }[] = [];
    for (const s of kAt(d)) {
      const i = s.idx.get(d);
      if (i === undefined || i < B_MOM_LOOKBACK || i < vw) continue;
      const a = s.close[i - B_MOM_SKIP], b = s.close[i - B_MOM_LOOKBACK];
      if (!(a > 0) || !(b > 0)) continue;
      let sum = 0, n = 0, bad = false;
      const r: number[] = [];
      for (let k = i - vw + 1; k <= i; k++) { const p0 = s.close[k - 1], p1 = s.close[k]; if (!(p0 > 0) || !(p1 > 0)) { bad = true; break; } const x = p1 / p0 - 1; r.push(x); sum += x; n++; }
      if (bad) continue;
      const mean = sum / n;
      let ss = 0;
      for (const x of r) ss += (x - mean) ** 2;
      items.push({ s, sig: Math.sqrt(ss / (n - 1)), mom: a / b - 1, rs: 0, rm: 0 });
    }
    const byCodeAsc = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
    [...items].sort((x, y) => x.sig - y.sig || byCodeAsc(x.s.code, y.s.code)).forEach((x, k) => { x.rs = k + 1; });
    [...items].sort((x, y) => y.mom - x.mom || byCodeAsc(x.s.code, y.s.code)).forEach((x, k) => { x.rm = k + 1; });
    const ord = [...items].sort((x, y) => (x.rs + x.rm) / 2 - (y.rs + y.rm) / 2 || x.sig - y.sig || byCodeAsc(x.s.code, y.s.code));
    const rank = new Map<string, number>(), cand: BCand[] = [];
    ord.forEach((x, k) => { rank.set(x.s.code, k + 1); if (x.mom > 0) cand.push({ s: x.s, code: x.s.code, rank: k + 1 }); });
    v = { rank, cand };
    m.set(c, v);
    return v;
  };

  const env = { CAL, nCal, cS, adjustments: h.adjustments, endedBefore: h.endedBefore, stockBuyMult: h.stockBuyMult, sellRate: h.sellRate, baseSlip: SLIPPAGE_PCT_PER_SIDE, bhRet: h.bhRet };
  const label = (code: string): string => `${code} ${nameOf.get(code) ?? "?"}`;

  const mkSpec = (id: BId): CandSpec => {
    const cd = B_CANDS[id];
    const cfg = { slip: B_SLIPPAGE, maxPos: cd.slots, capFrac: cd.frac, cooldown: 0 };
    const hooksFor = (vw: number, keep: number) => ({
      candsOf: (c: number): BCand[] => dayRank(vw, c).cand,
      exitReason: (p: SimPos, c: number): string | null => { const r = dayRank(vw, c).rank.get(p.code); return r === undefined || r > keep ? "순위 밖" : null; },
    });
    const keepNb = id === "B1" ? B_KEEP_RANK_NEIGHBORS_B1 : B2_KEEP_RANK_NEIGHBORS;
    const nbList: { label: string; run: () => SimRun }[] = [];
    for (const w of B_VOL_WINDOW_NEIGHBORS) nbList.push({ label: `변동성 창 ${w}거래일`, run: () => simSlots(env, cfg, hooksFor(w, cd.keepRank), { lag: 1 }) });
    for (const k of keepNb) nbList.push({ label: `순위 유지 한도 ${k}`, run: () => simSlots(env, cfg, hooksFor(B_VOL_WINDOW, k), { lag: 1 }) });
    return {
      id, trial: cd.trial, title: `저변동+모멘텀(12-1), ${cd.slots}종목 균등 ${cd.frac * 100}%, 순위 ${cd.keepRank}위 밖이면 매도`, defense: true, capFrac: cd.frac, fDenominator: 2,
      run: (o) => simSlots(env, cfg, hooksFor(B_VOL_WINDOW, cd.keepRank), { lag: o.lag, int: o.int, replace: o.replace, detail: o.detail }),
      neighbors: nbList,
      random: (rng, ordersByDay) => simSlots(env, cfg, {
        candsOf: (c, held) => {
          const n = ordersByDay.get(c) ?? 0;
          if (!n) return [];
          const pool = dayRank(B_VOL_WINDOW, c).cand.filter((x) => x.rank <= cd.keepRank && !held(x.code)), out: BCand[] = [];
          while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
          return out;
        },
        exitReason: hooksFor(B_VOL_WINDOW, cd.keepRank).exitReason,
      }, { lag: 1 }),
      reasons: ["순위 밖", "폐지"],
      label,
      extra: (base) => {
        // 사전등록 5 추가 보고: 특정 기간 성적, 삼성전자+SK하이닉스·업종 쏠림(닫힌 거래의 보유 종목-일 기준 근사)
        for (const [name, f, t] of [["2020-03", "2020-03-01", "2020-03-31"], ["2022", "2022-01-01", "2022-12-31"], ["2026-10-01~10-15", "2026-10-01", "2026-10-15"]] as const) {
          console.log(`${id} 기간 성적 ${name} (누적 % / MDD %): ${id} ${h.periodStat(base, f, t)} | 069500 ${h.periodStat(h.bhP, f, t)}`);
        }
        const dayCount = new Map<string, number>(), indCount = new Map<string, number>();
        let tot = 0;
        for (const t of base.trades) { const d = t.exitC - t.entryC; tot += d; dayCount.set(t.code, (dayCount.get(t.code) ?? 0) + d); const ic = (indOf.get(t.code) ?? "?").slice(0, 2); indCount.set(ic, (indCount.get(ic) ?? 0) + d); }
        const big = (dayCount.get("005930") ?? 0) + (dayCount.get("000660") ?? 0);
        console.log(`${id} 삼성전자+SK하이닉스 보유 종목-일 비중(닫힌 거래 기준 근사): ${f2((big / Math.max(tot, 1)) * 100)}% | 업종(KSIC 2자리) 상위 5: ${[...indCount].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${f2((v / Math.max(tot, 1)) * 100)}%`).join(", ")}`);
        let fewDays = 0, days = 0;
        for (let c = cS; c < nCal; c++) { days++; if (dayRank(B_VOL_WINDOW, c).cand.length < cd.slots) fewDays++; }
        console.log(`${id} 후보(M>0) 수가 슬롯 ${cd.slots}개 미만인 판단일 ${fewDays}/${days} (${f2((fewDays / Math.max(days, 1)) * 100)}%)`);
      },
    };
  };

  const specs = (["B1", "B2"] as const).filter((id) => only.has(id)).map(mkSpec);
  const verdicts: Verdict[] = [];
  for (const sp of specs) verdicts.push(evaluate(h, W, sp));
  summaryReport(verdicts, verdicts.map((v) => v.trial));
  yearlyTable(h, W, verdicts.map((v) => ({ id: v.id, run: v.run })));
  seedReport(h, W, specs, new Map(verdicts.map((v) => [v.id, v.run])), (code, c) => { const s = h.byCode.get(code)!, i = s.idx.get(CAL[c]); return i === undefined ? NaN : s.avgTvRow[i]; });
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 평균 보유 종목 수 참고 ${f2(avg(verdicts.flatMap((v) => v.run.nPos)))}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

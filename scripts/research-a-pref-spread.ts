/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 A 우선주 괴리 회귀 시험 A1(204)·A2(205). 후보당 1회 실행.
 * 사전 등록: docs/research/a-pref-spread-prereg.md (커밋 08703d4 기준). 가격 Parquet(Actions 캐시)·적용된 조정 이벤트·069500 가격만 읽는다. DB·Storage 쓰기 0.
 * 환경 변수 CAND_ONLY(예: "A1,A2")로 후보를 고를 수 있다(기본 전체). 파라미터·게이트 변경 금지.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { simSlots, type SimCand, type SimPos, type SimRun } from "@/lib/slotSim";
import { pairSpread, rollingZ, noTradeOk } from "@/lib/prefSpreadSignals";
import { A_Z_WINDOW, A_Z_WINDOW_NEIGHBORS, A_Z_MIN_OBS_RATIO, A_ENTRY_Z, A_ENTRY_Z_NEIGHBORS, A_EXIT_Z, A_STOP_PRICE_RET, A_STOP_Z, A_MIN_AVG_TV_WON, A_NO_TRADE_WINDOW, A_MAX_NO_TRADE_RATIO, A_REENTRY_BAN_DAYS, A_MAX_POS, A_SLIPPAGE, A_TRIAL_NO } from "@/lib/prefSpreadConfig";
import { B_MOM_LOOKBACK } from "@/lib/lowvolMomentumConfig";
import { loadHarness, selectAll, dbRead, f2, avg, type S } from "./researchHarness";
import { evaluate, makeWindows, seedReport, yearlyTable, summaryReport, type CandSpec, type Verdict } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
interface ACand extends SimCand { z: number }
interface Pair { pref: S; common: S; base: Uint8Array; z: Map<number, Float64Array> }

async function main(): Promise<void> {
  console.log(`연구 A 시험 시작(읽기 전용): ${new Date().toISOString()}`);
  const only = new Set((process.env.CAND_ONLY || "A1,A2").split(",").map((x) => x.trim()).filter(Boolean));
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const cS = B_MOM_LOOKBACK, evalFromIdx = cS + 1;
  const W = makeWindows(h, evalFromIdx);
  console.log(`평가 시작 판단일 ${CAL[cS]}(달력 순번 ${cS}), 수익률 집계 ${CAL[evalFromIdx]}~${h.dataEnd} | 구간 ${W.NW.map(([n, w]) => `${n} ${w.from}~${w.to}`).join(" / ")}`);

  // ---- 쌍 ----
  const align = (s: S, pick: (row: number) => number): Float64Array => { const a = new Float64Array(nCal).fill(NaN); for (let c = 0; c < nCal; c++) { const i = s.idx.get(CAL[c]); if (i !== undefined) a[c] = pick(i); } return a; };
  const prefCodes = h.codes.filter((c) => c.length === 6 && c[5] !== "0" && byCode.has(`${c.slice(0, 5)}0`));
  const pairs: Pair[] = [];
  const windows = [A_Z_WINDOW, ...A_Z_WINDOW_NEIGHBORS];
  for (const pc of prefCodes) {
    const p = byCode.get(pc)!, cm = byCode.get(`${pc.slice(0, 5)}0`)!;
    const s = pairSpread(align(p, (i) => p.close[i]), align(cm, (i) => cm.close[i]), align(p, (i) => p.vol[i]), align(cm, (i) => cm.vol[i]));
    const nt = noTradeOk(s, A_NO_TRADE_WINDOW, A_MAX_NO_TRADE_RATIO), tv = align(p, (i) => p.avgTvRow[i]);
    const base = new Uint8Array(nCal);
    for (let c = 0; c < nCal; c++) base[c] = nt[c] && tv[c] >= A_MIN_AVG_TV_WON ? 1 : 0;
    pairs.push({ pref: p, common: cm, base, z: new Map(windows.map((w) => [w, rollingZ(s, w, A_Z_MIN_OBS_RATIO)])) });
  }
  const byPref = new Map(pairs.map((q) => [q.pref.code, q]));
  console.log(`쌍 ${pairs.length}개`);
  const names = new Map<string, string>();
  for (let i = 0; i < pairs.length; i += 200) {
    const chunk = pairs.slice(i, i + 200).map((q) => q.common.code);
    for (const r of await selectAll<{ corp_code: string; corp_name: string; stock_code: string }>("dart_corp_codes(보통주)", (f, t) => supabaseAdmin.from("dart_corp_codes").select("corp_code, corp_name, stock_code").in("stock_code", chunk).order("corp_code").range(f, t))) names.set(r.stock_code, r.corp_name);
  }
  const label = (pref: string): string => `${pref} ${names.get(`${pref.slice(0, 5)}0`) ?? "?"}우`;

  const env = { CAL, nCal, cS, adjustments: h.adjustments, endedBefore: h.endedBefore, stockBuyMult: h.stockBuyMult, sellRate: h.sellRate, baseSlip: SLIPPAGE_PCT_PER_SIDE, bhRet: h.bhRet };
  const cfg = { slip: A_SLIPPAGE, maxPos: A_MAX_POS, capFrac: 0.2, cooldown: A_REENTRY_BAN_DAYS };
  const exitReason = (Wn: number) => (p: SimPos, c: number, i: number | undefined): string | null => {
    const pr = byPref.get(p.code)!;
    if (i === undefined || pr.common.idx.get(CAL[c]) === undefined) return "강제 청산";
    const z = pr.z.get(Wn)![c];
    if (Number.isFinite(z) && z >= A_EXIT_Z) return "z 회귀";
    if (p.s.close[i] <= p.entryAdj * (1 + A_STOP_PRICE_RET)) return "손절(가격)";
    if (Number.isFinite(z) && z <= A_STOP_Z) return "손절(z)";
    return null;
  };
  const hooksFor = (Wn: number, thr: number, exclude?: Set<string>) => ({
    candsOf: (c: number): ACand[] => {
      const l: ACand[] = [];
      for (const pr of pairs) {
        if (exclude?.has(pr.pref.code) || !pr.base[c]) continue;
        const z = pr.z.get(Wn)![c];
        if (Number.isFinite(z) && z <= thr) l.push({ s: pr.pref, code: pr.pref.code, z });
      }
      return l.sort((a, b) => a.z - b.z || (a.code < b.code ? -1 : 1));
    },
    exitReason: exitReason(Wn),
  });
  // 게이트 F 풀: 진입 z 조건만 빼고 자격 충족 + z < 0
  const poolCache = new Map<number, Pair[]>();
  const poolAt = (c: number): Pair[] => { let v = poolCache.get(c); if (!v) { v = pairs.filter((pr) => pr.base[c] && pr.z.get(A_Z_WINDOW)![c] < 0); poolCache.set(c, v); } return v; };

  const mkSpec = (id: "A1" | "A2"): CandSpec => {
    const thr = A_ENTRY_Z[id];
    const nbList: { label: string; run: () => SimRun }[] = [];
    for (const w of A_Z_WINDOW_NEIGHBORS) nbList.push({ label: `창 ${w}거래일`, run: () => simSlots(env, cfg, hooksFor(w, thr), { lag: 1 }) });
    for (const t of A_ENTRY_Z_NEIGHBORS[id]) nbList.push({ label: `진입 z ${t}`, run: () => simSlots(env, cfg, hooksFor(A_Z_WINDOW, t), { lag: 1 }) });
    return {
      id, trial: A_TRIAL_NO[id], title: `우선주 괴리 회귀, 진입 z ≤ ${thr}, 청산 z ≥ ${A_EXIT_Z}, 손절 ${A_STOP_PRICE_RET * 100}%/z ≤ ${A_STOP_Z}`, defense: false, capFrac: cfg.capFrac, fDenominator: 2,
      run: (o) => simSlots(env, cfg, hooksFor(A_Z_WINDOW, thr, o.exclude), { lag: o.lag, int: o.int, replace: o.replace, detail: o.detail }),
      neighbors: nbList,
      random: (rng, ordersByDay) => simSlots(env, cfg, {
        candsOf: (c) => {
          const n = ordersByDay.get(c) ?? 0;
          if (!n) return [];
          const pool = [...poolAt(c)], out: ACand[] = [];
          while (out.length < n && pool.length) { const k = Math.floor(rng() * pool.length); const pr = pool.splice(k, 1)[0]; out.push({ s: pr.pref, code: pr.pref.code, z: pr.z.get(A_Z_WINDOW)![c] }); }
          return out;
        },
        exitReason: exitReason(A_Z_WINDOW),
      }, { lag: 1 }),
      reasons: ["z 회귀", "손절(가격)", "손절(z)", "강제 청산", "폐지"],
      label,
      extra: (base) => {
        // 사전 점검 대조(검증용): 진입 자격 + z ≤ 진입 z 에피소드 수
        let ep = 0;
        for (const pr of pairs) { let prev = false; const z = pr.z.get(A_Z_WINDOW)!; for (let c = cS; c < nCal; c++) { const cond = !!pr.base[c] && Number.isFinite(z[c]) && z[c] <= thr; if (cond && !prev) ep++; prev = cond; } }
        console.log(`사전 점검 대조: ${id} 에피소드 ${ep}건(사전 점검 보고: A1 1,783 / A2 2,736), 실제 진입 ${base.entryCs.length}건`);
        const pnl = new Map<string, number>();
        for (const t of base.trades) pnl.set(t.code, (pnl.get(t.code) ?? 0) + (t.proceeds - t.spend) / t.vAtEntry);
        const top3 = [...pnl].sort((a, b) => b[1] - a[1]).slice(0, 3);
        const totAll = [...pnl.values()].reduce((a, x) => a + x, 0);
        console.log(`쌍별 손익 기여 상위 3: ${top3.map(([c, v]) => `${label(c)} ${f2(v * 100)}`).join(", ")} (전체 합 ${f2(totAll * 100)}, 단위: 진입 시 계좌 대비 %의 합) | 진입 상위 10개 쌍 비중 ${f2([...base.trades.reduce((m, t) => m.set(t.code, (m.get(t.code) ?? 0) + 1), new Map<string, number>()).values()].sort((a, b) => b - a).slice(0, 10).reduce((a, x) => a + x, 0) / Math.max(base.trades.length, 1) * 100)}%`);
        const ex = new Set(top3.map(([c]) => c));
        const o2 = simSlots(env, cfg, hooksFor(A_Z_WINDOW, thr, ex), { lag: 1, detail: true });
        for (const [name, win] of W.ALL) { const s = h.st(o2, win), b = h.st(h.bhP, win); console.log(`쌍 상위 3개 제외 재계산 ${id} | ${name}: CAGR ${f2(s.cagr)} / MDD ${f2(s.mdd)} (069500 ${f2(b.cagr)} / ${f2(b.mdd)})`); }
      },
    };
  };

  const specs = (["A1", "A2"] as const).filter((id) => only.has(id)).map(mkSpec);
  const verdicts: Verdict[] = [];
  for (const sp of specs) verdicts.push(evaluate(h, W, sp));
  summaryReport(verdicts, verdicts.map((v) => v.trial));
  yearlyTable(h, W, verdicts.map((v) => ({ id: v.id, run: v.run })));
  seedReport(h, W, specs, new Map(verdicts.map((v) => [v.id, v.run])), (code, c) => { const s = byCode.get(code)!, i = s.idx.get(CAL[c]); return i === undefined ? NaN : s.avgTvRow[i]; });
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 평균 보유 종목 수 참고 ${f2(avg(verdicts.flatMap((v) => v.run.nPos)))}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

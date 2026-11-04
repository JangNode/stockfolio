/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 DS7(시도 273): DS6 기본 계좌 + 계좌 전체 노출 배율 s(t) = min(1, 목표변동성 15% ÷ σ(t)). 사전 등록: docs/research/ds7-prereg.md.
 * σ(t) = 전일까지 DS6 기본 계좌(배율 적용 전) 자신의 최근 60거래일 일별 수익률 표준편차 × √252. 줄인 몫은 현금, 배율 변경 이동액에 0.25% 비용, 처음 60거래일 s = 1. 2011-01-04~데이터 끝 연속 계산.
 * 환경 변수 ALLOC_MODE=repro: 재현·DS6 일관성·배율 구조 자체 점검만 하고 DS7 성과는 계산하지 않는다(사전 점검). 공시·DART 사용 없음.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { simSlots, type SimCand, type SimPos, type SimRun, type SimTrade, type SimVt } from "@/lib/slotSim";
import { L_SLIPPAGE, L_EVAL_AFTER } from "@/lib/megacapTrendConfig";
import { LS_COOLDOWN_DAYS } from "@/lib/megacapTrailingConfig";
import { LE_CANDS, LE_LEGS, LE_ENTRY_LEG, LE_RANK_DEPTH } from "@/lib/momentumEnsembleConfig";
import { LV_CANDS, LV_WINDOW, LV_ANNUAL_DAYS, LV_ROUND_DP, LV_BAND } from "@/lib/le2VolTargetConfig";
import { rankEnsemble, outsiderEnsembleRank, type EnsembleRanking } from "@/lib/momentumEnsemble";
import { alignCloses, equalWeightSigma, volMultiplier } from "@/lib/le2VolTarget";
import { PEAD_H_CAGR_GAIN_PP, PEAD_H_MDD_GAIN_PP, PEAD_H_MDD_GAIN_STRONG_PP, PEAD_H_CAGR_FLOOR_PP } from "@/lib/peadConfig";
import { KSS_R3_DRAWS, KSS_R3_SEED, F_E_TOP_TRADES } from "@/lib/kodexSectorSatConfig";
import { ALLOC_SERIES_SHA, type AllocCompId } from "@/lib/strategyAllocationConfig";
import { IVA_VOL_WINDOW, IVA_MOVE_COST, IVA_TARGET_WINDOW, IVA_TARGET_BAND } from "@/lib/inverseVolConfig";
import { DS_F_DENOMINATOR, capRedistribute } from "@/lib/delayRobustCoreSatelliteConfig";
import { DS7_TRIAL, DS7_PRIOR_TESTS, DS7_RUN_START, DS7_TARGET_VOL, DS7_VOL_WINDOW, DS7_ANN_DAYS, DS7_NB_TARGET_VOLS, DS7_NB_WINDOWS, DS7_CAND, DS7_WINDOWS, DS7_DS6_REF, DS7_DROP_TOP } from "@/lib/ds7Config";
import { CS_SWAP_CONFIRM_DAYS, CS_RANK_DEPTH, CS_MOVE_COST, CS_CORE_W_NEIGHBOR, CS_ACCOUNTING_TOL_PP } from "@/lib/coreSatelliteConfig";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, mulberry32, SNAP_END, f2, avg, median, type S, type Win } from "./researchHarness";
import { evaluate, summaryReport, type CandSpec, type Verdict, type Windows } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
const SAMSUNG = "005930";
const sha = (b: Uint8Array | Buffer | string): string => createHash("sha256").update(b).digest("hex");
type CId = AllocCompId;
type CO = { lag: number; replace?: Set<string>; detail?: boolean; onDay?: (c: number, V: number, held: [string, number][]) => void };
interface Comp { id: CId; label: (code: string) => string; run: (o: CO) => SimRun; random: (rng: () => number, ob: Map<number, number>) => SimRun }
/** 공통 평가 시작 이후로 자른 일별 계열(구성요소 하나의 계좌 기준). */
interface Sl { dates: string[]; ret: number[]; costFrac: number[]; nPos: number[]; inv: number[]; turn: number[]; wMax: number[] }

async function main(): Promise<void> {
  const REPRO = process.env.ALLOC_MODE?.trim().toLowerCase() === "repro";
  console.log(`연구 DS7(시도 ${DS7_TRIAL}) ${REPRO ? "사전 점검(재현·DS6 일관성·배율 구조 자체 점검만, DS7 성과 미계산)" : "시험"} 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const h0 = await loadHarness();
  const h = h0;
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, nameOf, indOf } = await loadK200P(h);
  void indOf;

  // ---- 평가 구간: 초기 배분 2011-01-03 종가(LV1 250거래일 워밍업 뒤 첫 거래일), 수익 집계 2011-01-04~데이터 끝 연속, 하위 구간 3개 ----
  const cPE = CAL.findIndex((d) => d >= DS7_RUN_START);
  if (cPE < 0 || CAL[cPE] !== DS7_RUN_START) throw new Error(`${DS7_RUN_START}이 거래일 달력에 없음`);
  const cutC = cPE + 1;
  const NW: [string, Win][] = DS7_WINDOWS.map(([n, f, t]) => [n, { from: f, to: t }]);
  const FULL: Win = { from: CAL[cutC], to: "9999-12-31" };
  const W: Windows = { NW, FULL, ALL: [...NW, ["연속 전체 2011-01~2026-10", FULL]], noEx26: true, contamNote: "경고(오염): 이 구간 전체(2011~2026)는 DS6·DS4·LV1 등 선행 연구에서 이미 반복해 본 데이터다. DS7은 DS6 결과를 본 뒤 만든 변형(선택 편향)이라 순수 검증이 아니다." };
  console.log(`연속 평가: 초기 배분 ${CAL[cPE]} 종가(비용 없음), 수익률 집계 ${FULL.from}~${h.dataEnd}(워밍업 이후 시작일 ${FULL.from}) | 구간 ${NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);

  // ---- 0. 069500 기준선 ----
  console.log(`\n=== 0. 069500 기준선 (수익 집계 ${FULL.from}~; 원주가, 가격 수익만; CAGR % / MDD %) ===\n기존 = etf_daily_prices만(${h.bhPDb.dates[h.bhPDb.dates.length - 1]}까지), 새 = 보조 파일(${h.bhP.dates[h.bhP.dates.length - 1]}까지) — 게이트 A~H는 새 기준선으로 판정\n| 구간 | 기존 | 새 |\n|---|---|---|`);
  for (const [wn, w] of W.ALL) {
    const a = h.st(h.bhPDb, w), b = h.st(h.bhP, w);
    console.log(`| ${wn} | ${f2(a.cagr)} / ${f2(a.mdd)} | ${f2(b.cagr)} / ${f2(b.mdd)} |`);
  }
  const bhFrom = { dates: h.bhP.dates.filter((d) => d >= FULL.from), ret: h.bhP.ret.filter((_, k) => h.bhP.dates[k] >= FULL.from) };
  const bhAsRun = { dates: bhFrom.dates, ret: bhFrom.ret } as unknown as SimRun;
  const env = (cS: number, over: Partial<{ baseSlip: number }> = {}) => ({ CAL, nCal, cS, adjustments: h.adjustments, endedBefore: h.endedBefore, stockBuyMult: h.stockBuyMult, sellRate: h.sellRate, baseSlip: SLIPPAGE_PCT_PER_SIDE, bhRet: h.bhRet, ...over });
  const label = (code: string): string => `${code} ${nameOf.get(code) ?? "?"}`;

  // ---- 시총 순위(W3 아님: L3·LV1용) ----
  const megaCache = new Map<number, { list: S[]; rank: Map<string, number> }>();
  const megaAt = (c: number, depth: number): { list: S[]; rank: Map<string, number> } => {
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
    void depth;
    return v;
  };
  // 주의: L3는 순위 깊이 30, LV1은 60까지 담지만 L3는 상위 5위·10위 밖만, LV1은 풀 30·시총 40위 밖만 본다. 같은 정렬의 앞부분이므로 깊이 60 목록으로 둘 다 재현된다(재현 확인으로 검증).
  const comps: Comp[] = [];

  // ================= LV1 (LE2 + 변동성 목표화) =================
  {
    const LE2 = LE_CANDS.LE2, cd = LV_CANDS.LV1;
    const cS = CAL.findIndex((d) => d >= L_EVAL_AFTER);
    if (cS < 0) throw new Error(`${L_EVAL_AFTER} 이후 거래일 없음`);
    const legRets = (s: S, i: number): number[] => LE_LEGS.map((lg) => {
      if (i < lg.lookback) return NaN;
      const a = s.close[i - lg.skip], b = s.close[i - lg.lookback];
      return a > 0 && b > 0 ? a / b - 1 : NaN;
    });
    const ensCache = new Map<number, EnsembleRanking & { sOf: Map<string, S> }>();
    const ensAt = (c: number): EnsembleRanking & { sOf: Map<string, S> } => {
      let v = ensCache.get(c);
      if (!v) {
        const d = CAL[c], items: { code: string; rets: number[] }[] = [], sOf = new Map<string, S>();
        for (const s of megaAt(c, LE_RANK_DEPTH).list.slice(0, LE2.pool)) {
          const rets = legRets(s, s.idx.get(d)!);
          if (rets.every(Number.isFinite)) { items.push({ code: s.code, rets }); sOf.set(s.code, s); }
        }
        v = { ...rankEnsemble(items), sOf };
        ensCache.set(c, v);
      }
      return v;
    };
    const alignedCache = new Map<string, Float64Array>();
    const alignedOf = (code: string): Float64Array => { let a = alignedCache.get(code); if (!a) { const s = byCode.get(code)!; a = alignCloses(CAL, s.idx, s.close); alignedCache.set(code, a); } return a; };
    const vt: SimVt = { sizeMult: (c, stocks) => volMultiplier(equalWeightSigma(stocks.map((s) => alignedOf(s.code)), c, LV_WINDOW, LV_ANNUAL_DAYS), cd.target, LV_ROUND_DP), band: LV_BAND };
    const cfg = { slip: L_SLIPPAGE, maxPos: LE2.slots, capFrac: 1 / LE2.slots, cooldown: LS_COOLDOWN_DAYS, vt };
    const entryList = (c: number): SimCand[] => {
      const en = ensAt(c), out: SimCand[] = [];
      for (let k = 0; k < LE2.slots && k < en.items.length; k++) { const it = en.items[k]; if (it.rets[LE_ENTRY_LEG] > 0) out.push({ s: en.sOf.get(it.code)!, code: it.code }); }
      return out;
    };
    const hooks = {
      candsOf: (c: number): SimCand[] => entryList(c),
      exitReason: (p: SimPos, c: number, i: number | undefined): string | null => {
        if (i === undefined) return null;
        if ((megaAt(c, LE_RANK_DEPTH).rank.get(p.code) ?? Number.POSITIVE_INFINITY) > LE2.keepCap) return "시총 순위 밖";
        const rets = legRets(byCode.get(p.code)!, i);
        if (!rets.every(Number.isFinite)) return null;
        const en = ensAt(c);
        const r = en.rank.get(p.code) ?? outsiderEnsembleRank(en, rets);
        return r > LE2.keepRank ? "앙상블 순위 밖" : null;
      },
    };
    comps.push({
      id: "LV1", label,
      run: (o) => simSlots(env(cS), cfg, hooks, { lag: o.lag, replace: o.replace, detail: o.detail, onDay: o.onDay }),
      random: (rng, ob) => simSlots(env(cS), cfg, {
        candsOf: (c, held, blocked) => {
          const n = ob.get(c) ?? 0;
          if (!n) return [];
          const en = ensAt(c);
          const pool = en.items.filter((it) => it.rets[LE_ENTRY_LEG] > 0 && !held(it.code) && !blocked(it.code)).map((it) => ({ s: en.sOf.get(it.code)!, code: it.code })), out: SimCand[] = [];
          while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
          return out;
        },
        exitReason: hooks.exitReason,
      }, { lag: 1 }),
    });
  }

  // ================= 코어: 월말 K200P 구성(PIT) 안 당일 시총 상위 N종목, 시총 비율 보유 (연구 CS) =================
  // 신호: 판단일 c 종가에서 megaAt(c)의 상위 N종목(그날 월말 K200P 구성원, 코스피, 제외 규칙 적용 — 연구 L3와 같은 목록). 체결: c + lag 종가.
  // 교체: 보유 종목이 상위 N위 밖에 CS_SWAP_CONFIRM_DAYS 거래일 연속 머물 때만, 그 종목을 팔고 상위 N위 안에 있으나 보유하지 않은 가장 시총 큰 종목으로 바꾼다.
  // 비중: 처음 편입과 구성이 바뀌는 체결일에만 신호일 시총 비율로 맞추고(팔고 사는 금액에만 비용), 그 사이엔 가격 변동 그대로 둔다. 비용: env의 매수 배수·매도 비용률(수수료 0.015% + 거래세 + 슬리피지 0.1%).
  interface CorePos { code: string; s: S; shares: number; lastPx: number; entryC: number; spend: number; vAtEntry: number; rep: boolean; repVal: number; realized: number; out: number }
  interface CoreEvent { c: number; sells: string[]; buys: string[]; set: string[]; w: number[] }
  type CoreRun = SimRun & { open: SimTrade[]; events: CoreEvent[]; forcedExit: number };
  const mcapNear = (s: S, c: number): number => { for (let k = c; k >= Math.max(c - 10, 0); k--) { const i = s.idx.get(CAL[k]); if (i !== undefined && s.mcapRow[i] > 0) return s.mcapRow[i]; } return Number.NaN; };
  const simCore = (N: number, o: { lag: number; replace?: Set<string>; onDay?: (c: number, V: number, held: [string, number][]) => void; exclude?: ReadonlySet<string>; dropTop?: number }): CoreRun => {
    const e = env(cPE), buyMult = e.stockBuyMult;
    const pos = new Map<string, CorePos>();
    let cash = 1, prevV = 1, forcedExit = 0;
    const out: CoreRun = { dates: [], ret: [], costFrac: [], nPos: [], inv: [], turn: [], trades: [], entryCs: [], wMax: [], haltSkip: 0, exitDefer: 0, open: [], events: [], forcedExit: 0 };
    let pend: { c: number; sells: string[]; buys: string[]; mc: Map<string, number> } | null = null;
    const val = (p: CorePos): number => (p.rep ? p.repVal : p.shares * p.lastPx);
    const pushTrade = (p: CorePos, c: number, net: number, reason: string, into: SimTrade[]): void => { into.push({ code: p.code, entryC: p.entryC, exitC: c, spend: p.spend, proceeds: net + p.realized, vAtEntry: p.vAtEntry, reason, entryAdj: 0, peakAdj: 0, exitAdj: 0, entryRaw: 0 }); };
    for (let c = cPE; c < nCal; c++) {
      const d = CAL[c], sr = e.sellRate(d);
      let costF = 0, buyN = 0, sellN = 0;
      for (const p of [...pos.values()]) {
        const i = p.s.idx.get(d);
        if (i !== undefined) { p.lastPx = p.s.close[i]; if (p.rep) p.repVal *= 1 + (e.bhRet.get(d) ?? 0); }
        else if (p.s.last < d && p.s.last < e.endedBefore) { const v = val(p); cash += v * (1 - sr); pushTrade(p, c, v * (1 - sr), "폐지", out.trades); pos.delete(p.code); costF += (v * sr) / prevV; sellN += v; forcedExit++; }
      }
      if (pend && pend.c === c) {
        const ev = pend;
        const final = [...[...pos.keys()].filter((k) => !ev.sells.includes(k)), ...ev.buys];
        const halted = [...new Set([...ev.sells, ...final])].some((code) => { const s = byCode.get(code); const i = s?.idx.get(d); return !s || i === undefined || s.vol[i] === 0; });
        if (halted) { out.haltSkip++; ev.c = c + 1; } else {
          pend = null;
          for (const code of ev.sells) {
            const p = pos.get(code);
            if (!p) continue;
            const v = val(p);
            cash += v * (1 - sr); pushTrade(p, c, v * (1 - sr), "시총 순위 밖", out.trades); pos.delete(code); costF += (v * sr) / prevV; sellN += v;
          }
          const sumMc = final.reduce((a, code) => a + (ev.mc.get(code) as number), 0);
          let V0 = cash;
          for (const p of pos.values()) V0 += val(p);
          const target = (code: string): number => (V0 * (ev.mc.get(code) as number)) / sumMc;
          for (const p of pos.values()) {
            const cur = val(p), t = target(p.code);
            if (!(cur > t)) continue;
            const sold = cur - t;
            p.shares -= sold / p.lastPx;
            if (p.rep) p.repVal -= sold;
            const net = sold * (1 - sr);
            cash += net; p.realized += net; sellN += sold; costF += (sold * sr) / prevV;
          }
          const needs: { code: string; need: number }[] = [];
          for (const code of final) { const p = pos.get(code); const cur = p ? val(p) : 0, t = target(code); if (t > cur) needs.push({ code, need: t - cur }); }
          const totalNeed = needs.reduce((a, x) => a + x.need, 0);
          const scale = totalNeed > 0 ? Math.min(1, cash / (buyMult * totalNeed)) : 0;
          for (const { code, need } of needs) {
            const x = need * scale, outlay = x * buyMult, p = pos.get(code);
            cash -= outlay; buyN += outlay; costF += (outlay - x) / prevV;
            if (p) { p.spend += outlay; p.shares += x / p.lastPx; if (p.rep) p.repVal += x; } else {
              const s = byCode.get(code) as S, i = s.idx.get(d) as number, adj = s.close[i];
              pos.set(code, { code, s, shares: x / adj, lastPx: adj, entryC: c, spend: outlay, vAtEntry: V0, rep: !!o.replace?.has(`${code}|${c}`), repVal: x, realized: 0, out: 0 });
              out.entryCs.push(c);
            }
          }
          const pv = final.map((code) => val(pos.get(code) as CorePos)), pvs = pv.reduce((a, x) => a + x, 0);
          out.events.push({ c, sells: ev.sells, buys: ev.buys, set: final, w: pv.map((x) => x / pvs) });
        }
      }
      let V = cash;
      for (const p of pos.values()) V += val(p);
      if (c > cPE) {
        out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.costFrac.push(costF); out.nPos.push(pos.size);
        out.inv.push(V > 0 ? (V - cash) / V : 0);
        o.onDay?.(c, V, [...pos.values()].map((p) => [p.code, val(p)] as [string, number]));
        if (buyN + sellN > 1e-12) out.turn.push({ d, v: prevV > 0 ? (buyN + sellN) / 2 / prevV : 0 });
        let mx = 0;
        for (const p of pos.values()) { const v = val(p); if (v > mx) mx = v; }
        out.wMax.push(pos.size && V > 0 ? mx / V : Number.NaN);
      }
      if (c + o.lag < nCal) {
        const top = megaAt(c, CS_RANK_DEPTH).list.filter((s) => !o.exclude?.has(s.code)).slice(o.dropTop ?? 0, (o.dropTop ?? 0) + N), topSet = new Set(top.map((s) => s.code));
        for (const p of pos.values()) p.out = topSet.has(p.code) ? 0 : p.out + 1;
        if (!pend) {
          const sells = [...pos.values()].filter((p) => p.out >= CS_SWAP_CONFIRM_DAYS).map((p) => p.code);
          const need = N - (pos.size - sells.length);
          if (sells.length > 0 || need > 0) {
            const buys = top.filter((s) => !pos.has(s.code)).slice(0, Math.max(need, 0)).map((s) => s.code);
            const mc = new Map<string, number>();
            for (const code of [...pos.keys()].filter((k) => !sells.includes(k)).concat(buys)) mc.set(code, mcapNear(byCode.get(code) as S, c));
            if ([...mc.values()].every((x) => Number.isFinite(x) && x > 0) && (sells.length > 0 || buys.length > 0)) pend = { c: c + o.lag, sells, buys, mc };
          }
        }
      }
      prevV = V;
    }
    const last = CAL[nCal - 1], srl = e.sellRate(last);
    for (const p of pos.values()) pushTrade(p, nCal - 1, val(p) * (1 - srl), "기간 끝 평가", out.open);
    out.forcedExit = forcedExit;
    return out;
  };

  // ---- 1. 구성요소 재현 확인 + 일별 순수익 저장 ----
  const runCache = new Map<string, SimRun>();
  const getRun = (cp: Comp, lag: number, repl?: Set<string>): SimRun => {
    const key = `${cp.id}|${lag}|${repl ? [...repl].sort().join(",") : ""}`;
    let r = runCache.get(key);
    if (!r) { r = cp.run({ lag, replace: repl, detail: true }); runCache.set(key, r); }
    return r;
  };
  console.log(`\n=== 1. LV1 재현 확인 (2016-12-30에서 자른 이번 계산의 일별 순수익이, 이전 연구 전체 기간 일별 순수익 캐시의 같은 날짜 앞부분과 소수 오차 1e-9 이내로 같아야 한다; 캐시 파일 SHA-256은 연구 ALLOC 사전등록 해시와 같아야 한다) ===`);
  const refDir = process.env.ALLOC_REF_DIR?.trim();
  if (!refDir) throw new Error("ALLOC_REF_DIR(이전 연구 일별 순수익 캐시)가 없다 — 중단하고 보고한다");
  for (const cp of comps) {
    const r = getRun(cp, 1);
    const buf = await fs.readFile(path.join(refDir, `${cp.id}.json`));
    const refSha = sha(buf), okSha = !ALLOC_SERIES_SHA || ALLOC_SERIES_SHA[cp.id as AllocCompId] === refSha;
    const ref = JSON.parse(buf.toString("utf8")) as { dates: string[]; ret: number[] };
    const n = r.dates.length;
    const sameDates = ref.dates.length >= n && r.dates.every((d, k) => ref.dates[k] === d);
    let maxD = 0, nDiff = 0;
    if (sameDates) for (let k = 0; k < n; k++) { const df = Math.abs(r.ret[k] - ref.ret[k]); if (df > 0) nDiff++; maxD = Math.max(maxD, df); }
    console.log(`  ${cp.id}: 이번 ${r.dates[0]}~${r.dates[n - 1]} ${n}일 | 날짜 앞부분 ${sameDates ? "일치" : "불일치"} | 값이 다른 날 ${nDiff}일, 최대 차이 ${maxD.toExponential(2)}%p | 캐시 파일 SHA-256 ${refSha} ${okSha ? "(ALLOC 해시와 일치)" : "(ALLOC 해시와 불일치)"}`);
    if (!sameDates || !(maxD <= 1e-9) || !okSha) throw new Error(`${cp.id} 재현 불일치 — 중단하고 보고한다`);
  }

  // ---- 2. 공통 평가 시작으로 자른 계열 ----
  const zeros: number[] = [];
  const slice = (r: SimRun): Sl => {
    const k0 = r.dates.findIndex((d) => d >= FULL.from);
    if (k0 < 0) throw new Error("자를 지점 없음");
    const tm = new Map(r.turn.map((x) => [x.d, x.v]));
    const dates = r.dates.slice(k0);
    if (r.costFrac.length !== r.dates.length || r.nPos.length !== r.dates.length || r.inv.length !== r.dates.length) throw new Error("일별 계열 길이 불일치");
    return { dates, ret: r.ret.slice(k0), costFrac: r.costFrac.slice(k0), nPos: r.nPos.slice(k0), inv: r.inv.slice(k0), turn: dates.map((d) => tm.get(d) ?? 0), wMax: r.wMax.length === r.dates.length ? r.wMax.slice(k0) : dates.map(() => NaN) };
  };
  const slCache = new Map<string, Sl>();
  const getSl = (cp: Comp, lag: number, repl?: Set<string>): Sl => {
    const key = `${cp.id}|${lag}|${repl ? [...repl].sort().join(",") : ""}`;
    let s = slCache.get(key);
    if (!s) { s = slice(getRun(cp, lag, repl)); slCache.set(key, s); }
    return s;
  };
  const baseSl = new Map(comps.map((cp) => [cp.id, getSl(cp, 1)]));
  const dates0 = baseSl.get(comps[0].id)!.dates;
  for (const [id, s] of baseSl) if (s.dates.length !== dates0.length || s.dates.some((d, k) => d !== dates0[k])) throw new Error(`${id} 날짜가 첫 구성요소와 다르다`);
  const nDays = dates0.length;
  for (let i = 0; i < nDays; i++) zeros.push(0);
  const zeroSl: Sl = { dates: dates0, ret: zeros, costFrac: zeros, nPos: zeros, inv: zeros, turn: zeros, wMax: zeros };
  const dateIdx = new Map(dates0.map((d, i) => [d, i]));
  // ---- 3. 변동성 역수 배분 ----
  const D = 252, RATE = IVA_MOVE_COST;
  const sdOf = (r: number[]): number => { const m = r.reduce((a, x) => a + x, 0) / Math.max(r.length, 1); return Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(r.length - 1, 1)); };
  /** 구성요소 하나의 입력: full = 원래 평가 시작부터의 일별 순수익(%, 직전 창 계산에 쓴다), k0 = 공통 평가 시작 날의 위치, sl = 공통 구간으로 자른 보고용 계열. */
  interface CD { id: CId; full: ArrayLike<number>; k0: number; sl: Sl }
  interface Out { run: SimRun; cost: number[]; moved: number[]; wAcct: number[][]; expo: number[]; warm: boolean[]; nAdj: number; wTgt: number[][] }
  const stdCache = new WeakMap<object, Map<number, Float64Array>>();
  /** 위치 t의 값까지 직전 win개 일수익률(%)의 표본 표준편차(%). 앞쪽 win − 1개는 NaN(이력 부족). */
  const rollStd = (full: ArrayLike<number>, win: number): Float64Array => {
    let m = stdCache.get(full);
    if (!m) { m = new Map(); stdCache.set(full, m); }
    let a = m.get(win);
    if (!a) {
      const n = full.length, p1 = new Float64Array(n + 1), p2 = new Float64Array(n + 1);
      for (let t = 0; t < n; t++) { p1[t + 1] = p1[t] + full[t]; p2[t + 1] = p2[t] + full[t] * full[t]; }
      a = new Float64Array(n).fill(NaN);
      for (let t = win - 1; t < n; t++) { const s1 = p1[t + 1] - p1[t + 1 - win], s2 = p2[t + 1] - p2[t + 1 - win]; a[t] = Math.sqrt(Math.max(0, (s2 - (s1 * s1) / win) / (win - 1))); }
      m.set(win, a);
    }
    return a;
  };
  const buildAlloc = (cds: CD[], win: number, target: number | null, rate: number = RATE, cap?: { id: CId; v: number }, fixedEq = false): Out => {
    const k = cds.length, sd = cds.map((c) => rollStd(c.full, win));
    /** 종가 i 기준 목표 비중: 모든 구성요소에 직전 win일 이력이 있으면 표준편차 역수 비례, 아니면 이력이 있는 구성요소만 균등(워밍업). */
    const weightsAt = (i: number): { w: number[]; warm: boolean } => {
      if (fixedEq) return { w: cds.map(() => 1 / cds.length), warm: false };
      const v = cds.map((c, j) => { const t = c.k0 + i; return t >= 0 && Number.isFinite(sd[j][t]) ? Math.max(sd[j][t], 1e-9) : NaN; });
      if (v.every(Number.isFinite)) {
        const inv = v.map((x) => 1 / x), s = inv.reduce((a, x) => a + x, 0), w0v = inv.map((x) => x / s), jc = cap ? cds.findIndex((c) => c.id === cap.id) : -1;
        return { w: cap && jc >= 0 ? capRedistribute(w0v, jc, cap.v) : w0v, warm: false };
      }
      const n = v.filter(Number.isFinite).length;
      // 구현 보완(사전 점검에서 드러남): 이력이 있는 구성요소가 하나도 없는 처음 구간(이번 구간 시작이 LV1 자신의 시작과 같다)은 모든 구성요소 균등 비중이다 — 구성요소가 하나인 DS6에서는 LV1 100%.
      if (n === 0) return { w: v.map(() => 1 / v.length), warm: true };
      return { w: v.map((x) => (Number.isFinite(x) ? 1 / n : 0)), warm: true };
    };
    const w0 = weightsAt(-1), s = w0.w.slice();
    let pending = cds.map(() => 0), lastWarm = w0.warm;
    const ret: number[] = [], costFrac: number[] = [], nPos: number[] = [], inv: number[] = [], turn: number[] = [], wMax: number[] = [], cost: number[] = [], moved: number[] = [], warm: boolean[] = [];
    const wClose = cds.map(() => new Array<number>(nDays));
    const wTgt = cds.map(() => [] as number[]);
    for (let i = 0; i < nDays; i++) {
      const Vprev = s.reduce((a, x) => a + x, 0), wPrev = s.map((x) => x / Vprev);
      for (let j = 0; j < k; j++) s[j] *= 1 + cds[j].full[cds[j].k0 + i] / 100;
      let mv = 0, cs = 0;
      if (pending.some((x) => x !== 0)) {
        for (let j = 0; j < k; j++) { s[j] += pending[j]; if (pending[j] > 0) mv += pending[j]; }
        cs = rate * mv;
        if (mv > 0) for (let j = 0; j < k; j++) if (pending[j] > 0) s[j] -= (cs * pending[j]) / mv;
      }
      const V = s.reduce((a, x) => a + x, 0);
      ret.push((V / Vprev - 1) * 100);
      warm.push(lastWarm);
      const wt = weightsAt(i);
      wt.w.forEach((x, j) => wTgt[j].push(x));
      lastWarm = wt.warm;
      pending = wt.w.map((x, j) => x * V - s[j]);
      for (let j = 0; j < k; j++) wClose[j][i] = s[j] / V;
      cost.push(cs / Vprev); moved.push(mv / Vprev);
      costFrac.push(wPrev.reduce((a, w, j) => a + w * cds[j].sl.costFrac[i], 0) + cs / Vprev);
      nPos.push(cds.reduce((a, c) => a + c.sl.nPos[i], 0));
      inv.push(cds.reduce((a, c, j) => a + wClose[j][i] * c.sl.inv[i], 0));
      turn.push(wPrev.reduce((a, w, j) => a + w * cds[j].sl.turn[i], 0) + mv / Vprev);
      const wm = cds.map((c, j) => wPrev[j] * c.sl.wMax[i]).filter(Number.isFinite);
      wMax.push(wm.length ? Math.max(...wm) : NaN);
    }
    const mkRun = (rt: number[], cf: number[], iv: number[], tn: number[], wmx: number[]): SimRun => ({ dates: dates0, ret: rt, costFrac: cf, nPos, inv: iv, turn: tn.map((v, i) => ({ d: dates0[i], v })), trades: [], entryCs: [], wMax: wmx, haltSkip: 0, exitDefer: 0 });
    if (target === null) return { run: mkRun(ret, costFrac, inv, turn, wMax), cost, moved, wAcct: wClose, expo: ret.map(() => 1), warm, nAdj: 0, wTgt };
    // 계좌 변동성 목표: 위 위험 자산 계좌(수익률 ret)의 직전 IVA_TARGET_WINDOW일 실현 변동성(연환산) 기준 배율 = min(1, 목표 ÷ σ), 실제 노출과 band 이상 차이 날 때만 다음 종가에 고정 금액으로 조정, 줄인 몫은 현금
    let risky = 1, cash = 0, pend = 0, nAdj = 0;
    const r2: number[] = [], expo: number[] = [], cost2: number[] = [], moved2: number[] = [], cf2: number[] = [], inv2: number[] = [], tn2: number[] = [], wm2: number[] = [];
    for (let i = 0; i < nDays; i++) {
      const Vprev = risky + cash, aPrev = risky / Vprev;
      risky *= 1 + ret[i] / 100;
      let mv = 0, cs = 0;
      if (pend !== 0) { risky += pend; cash -= pend; mv = Math.abs(pend); cs = rate * mv; }
      const Vpre = risky + cash, kappa = cs / Vpre;
      risky *= 1 - kappa; cash *= 1 - kappa;
      const V = Vpre * (1 - kappa);
      r2.push((V / Vprev - 1) * 100);
      expo.push(risky / V);
      cost2.push(aPrev * cost[i] + cs / Vprev); moved2.push(aPrev * moved[i] + mv / Vprev);
      cf2.push(aPrev * costFrac[i] + cs / Vprev); inv2.push((risky / V) * inv[i]); tn2.push(aPrev * turn[i] + mv / Vprev); wm2.push(aPrev * wMax[i]);
      pend = 0;
      if (i >= IVA_TARGET_WINDOW - 1) {
        const sg = (sdOf(ret.slice(i - IVA_TARGET_WINDOW + 1, i + 1)) / 100) * Math.sqrt(D), mStar = Math.min(1, target / sg), a = risky / V;
        if (Math.abs(mStar - a) >= IVA_TARGET_BAND - 1e-12) { pend = mStar * V - risky; nAdj++; }
      }
    }
    return { run: mkRun(r2, cf2, inv2, tn2, wm2), cost: cost2, moved: moved2, wAcct: wClose.map((row) => row.map((w, i) => w * expo[i])), expo, warm, nAdj, wTgt };
  };
  const cdOf = (cp: Comp, lag: number, repl?: Set<string>): CD => { const r = getRun(cp, lag, repl); return { id: cp.id, full: r.ret, k0: r.dates.findIndex((d) => d >= FULL.from), sl: getSl(cp, lag, repl) }; };
  const compOf = new Map(comps.map((c) => [c.id as CId, c]));
  const pnlOf = (t: SimTrade): number => (t.proceeds - t.spend) / t.vAtEntry;
  const replCache = new Map<CId, Set<string>>();
  /** 게이트 E: 구성요소마다 평가 구간에 닫힌(청산 실행일 ≥ 평가 시작) 거래를 구성요소 계좌 대비 손익으로 정렬한 상위 3개. */
  const replSet = (cp: Comp): Set<string> => {
    let s = replCache.get(cp.id);
    if (!s) {
      const top = getRun(cp, 1).trades.filter((t) => CAL[t.exitC] >= FULL.from).sort((a, b) => pnlOf(b) - pnlOf(a)).slice(0, F_E_TOP_TRADES);
      s = new Set(top.map((t) => `${t.code}|${t.entryC}`));
      replCache.set(cp.id, s);
    }
    return s;
  };
  const tradeMeta = (cps: Comp[], lag: number, repl: boolean): { trades: SimTrade[]; entryCs: number[]; haltSkip: number; exitDefer: number } => {
    const trades: SimTrade[] = [], entryCs: number[] = [];
    let haltSkip = 0, exitDefer = 0;
    for (const cp of cps) {
      const r = getRun(cp, lag, repl ? replSet(cp) : undefined);
      for (const t of r.trades) trades.push({ ...t, vAtEntry: t.vAtEntry * cps.length });
      entryCs.push(...r.entryCs); haltSkip += r.haltSkip; exitDefer += r.exitDefer;
    }
    return { trades, entryCs, haltSkip, exitDefer };
  };

  // ---- 게이트 F: 구성요소별 원래 시험의 무작위 대조(같은 시드·같은 정의, 1,000회)를 같은 번호끼리 합친다 ----
  const randCache = new Map<CId, { full: Float64Array; k0: number }[]>();
  const randOf = (cp: Comp): { full: Float64Array; k0: number }[] => {
    let a = randCache.get(cp.id);
    if (!a) {
      const base = getRun(cp, 1), ob = new Map<number, number>();
      for (const c of base.entryCs) ob.set(c - 1, (ob.get(c - 1) ?? 0) + 1);
      const rng = mulberry32(KSS_R3_SEED);
      a = [];
      for (let k = 0; k < KSS_R3_DRAWS; k++) { const r = cp.random(rng, ob); a.push({ full: Float64Array.from(r.ret), k0: r.dates.findIndex((d) => d >= FULL.from) }); }
      randCache.set(cp.id, a);
      console.log(`  [F] ${cp.id} 무작위 대조 ${KSS_R3_DRAWS}회 준비(${((Date.now() - T0) / 60000).toFixed(1)}분 경과)`);
    }
    return a;
  };

  // ---- 보고용 보조 ----
  const bhRet = new Map(h.bhP.dates.map((d, i) => [d, h.bhP.ret[i]]));
  const bRetAxis = dates0.map((d) => { const r = bhRet.get(d); if (r === undefined) throw new Error(`069500 일수익률 없음 ${d}`); return r; });
  const hVs = (full: { cagr: number; mdd: number }, rb: { cagr: number; mdd: number }): { ok: boolean; text: string } => {
    const dc = full.cagr - rb.cagr, dm = rb.mdd - full.mdd;
    const c1 = dc >= PEAD_H_CAGR_GAIN_PP, c2 = dm >= PEAD_H_MDD_GAIN_PP && dc >= -PEAD_H_CAGR_FLOOR_PP;
    return { ok: c1 || c2, text: `CAGR ${dc >= 0 ? "+" : ""}${f2(dc)}%p, MDD ${dm >= 0 ? "−" : "+"}${f2(Math.abs(dm))}%p(개선 ${f2(dm)}%p; ${PEAD_H_MDD_GAIN_STRONG_PP}%p 이상 ${dm >= PEAD_H_MDD_GAIN_STRONG_PP ? "O" : "X"}) → 조건1(CAGR +${PEAD_H_CAGR_GAIN_PP}%p) ${c1 ? "O" : "X"}, 조건2(MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p) ${c2 ? "O" : "X"}` };
  };
  const pct = (a: number, b: number): string => f2((a / Math.max(b, 1)) * 100);
  const quant = (v: number[], ps: readonly number[]): string => { const a = [...v].sort((x, y) => x - y); return ps.map((p) => `${Math.round(p * 100)}%=${a.length ? f2(a[Math.min(Math.floor(a.length * p), a.length - 1)] * 100) : "-"}`).join(" / "); };
  const warmEnd = (o: Out): number => { const k = o.warm.findIndex((x) => !x); return k < 0 ? nDays : k; };

  // ---- 기준 계열 ----
  const slOf = (r: SimRun): Sl => ({ dates: r.dates, ret: r.ret, costFrac: r.costFrac, nPos: r.nPos, inv: r.inv, turn: r.turn.map((x) => x.v), wMax: r.wMax });
  const coreCache = new Map<string, CoreRun>(), coreSlCache = new Map<string, Sl>();
  const keyC = (N: number, lag: number, repl?: Set<string>): string => `${N}|${lag}|${repl ? [...repl].sort().join(",") : ""}`;
  const getCore = (N: number, lag: number, repl?: Set<string>): CoreRun => { const k = keyC(N, lag, repl); let r = coreCache.get(k); if (!r) { r = simCore(N, { lag, replace: repl }); coreCache.set(k, r); } return r; };
  const getCoreSl = (N: number, lag: number, repl?: Set<string>): Sl => { const k = keyC(N, lag, repl); let s = coreSlCache.get(k); if (!s) { s = slice(getCore(N, lag, repl)); coreSlCache.set(k, s); } return s; };
  const coreTradesAll = (N: number): SimTrade[] => { const r = getCore(N, 1); return [...r.trades, ...r.open].filter((t) => CAL[t.exitC] >= FULL.from); };
  const coreReplSet = (N: number): Set<string> => new Set(coreTradesAll(N).sort((a, b) => pnlOf(b) - pnlOf(a)).slice(0, F_E_TOP_TRADES).map((t) => `${t.code}|${t.entryC}`));
  const coreHolds = (N: number): [string, number][][] => {
    const arr: [string, number][][] = new Array(nDays).fill(null).map(() => []);
    simCore(N, { lag: 1, onDay: (c, V, held) => { const i = dateIdx.get(CAL[c]); if (i !== undefined) arr[i] = held.map(([code, v]) => [code, v / V]); } });
    return arr;
  };
  const evLine = (r: CoreRun): string => r.events.map((e) => `${CAL[e.c]} ${e.sells.length ? `${e.sells.map(label).join("+")} → ` : ""}${e.buys.length ? e.buys.map(label).join("+") : "비중 조정"} [${e.set.map((code, j) => `${nameOf.get(code) ?? code} ${f2(e.w[j] * 100)}%`).join(" / ")}]`).join("\n    ");
  /** 코어 구조·회계 점검(성과 비교 아님): 이벤트 없는 구간에서 시뮬레이터 일수익률이 체결 직후 비중 그대로 가격만 따라간 독립 계산과 같은지 본다. */
  const coreCheck = (N: number): void => {
    const r = getCore(N, 1), ret = new Map(r.dates.map((d, i) => [d, r.ret[i]]));
    let maxDiff = 0, nChk = 0;
    r.events.forEach((ev, k) => {
      const c0 = ev.c, c1 = k + 1 < r.events.length ? r.events[k + 1].c : nCal, ss = ev.set.map((code) => byCode.get(code) as S);
      const px = (c: number): number[] | null => { const a: number[] = []; for (const s of ss) { const i = s.idx.get(CAL[c]); if (i === undefined) return null; a.push(s.close[i]); } return a; };
      const base = px(c0);
      if (!base) return;
      let prev = 1;
      for (let c = c0 + 1; c < c1; c++) {
        const p = px(c), sim = ret.get(CAL[c]);
        if (!p || sim === undefined) break;
        const v = p.reduce((a, x, j) => a + (ev.w[j] * x) / base[j], 0);
        maxDiff = Math.max(maxDiff, Math.abs((v / prev - 1) * 100 - sim)); nChk++; prev = v;
      }
    });
    console.log(`  N=${N}: 이벤트 ${r.events.length}회(처음 편입 포함, 종목 교체 ${r.events.filter((e) => e.sells.length).length}회) | 폐지 강제 청산 ${r.forcedExit}건 | 거래정지로 순연된 체결 ${r.haltSkip}건 | 회계 점검 ${nChk}일, 독립 계산과 최대 차이 ${maxDiff.toExponential(2)}%p ${maxDiff <= CS_ACCOUNTING_TOL_PP ? "통과" : "불일치"}\n    ${evLine(r)}`);
    if (!(maxDiff <= CS_ACCOUNTING_TOL_PP) || r.forcedExit > 0) throw new Error(`코어 N=${N} 구조·회계 점검 실패 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)`);
  };
  console.log(`\n=== 1c. 코어 구조·회계 점검 (성과 계산·비교 아님; 월말 K200P 구성 안 당일 시총 상위 N종목, 교체 확인 ${CS_SWAP_CONFIRM_DAYS}거래일, 체결 다음 거래일 종가) ===`);
  coreCheck(2);
  // ---- 코어-위성 합성: 코어 비중 w, 위성 1 − w, 매일 종가에 목표 비율 계산 → 다음 거래일 종가에 고정 금액 이동(연구 ALLOC P형과 같은 방식), 이동 금액의 CS_MOVE_COST ----
  interface CombOut { run: SimRun; wCore: number[]; cost: number[]; moved: number[] }
  const combineCS = (core: Sl, sat: Sl, wC: number, rate: number): CombOut => {
    const parts = [core, sat], s = [wC, 1 - wC], pending = [0, 0];
    const ret: number[] = [], costFrac: number[] = [], nPos: number[] = [], inv: number[] = [], turn: number[] = [], wMax: number[] = [], wCore: number[] = [], cost: number[] = [], moved: number[] = [];
    for (let i = 0; i < nDays; i++) {
      const Vprev = s[0] + s[1], wPrev = [s[0] / Vprev, s[1] / Vprev];
      for (let j = 0; j < 2; j++) s[j] *= 1 + parts[j].ret[i] / 100;
      let mv = 0, cs = 0;
      if (pending[0] !== 0 || pending[1] !== 0) {
        for (let j = 0; j < 2; j++) { s[j] += pending[j]; if (pending[j] > 0) mv += pending[j]; }
        cs = rate * mv;
        if (mv > 0) for (let j = 0; j < 2; j++) if (pending[j] > 0) s[j] -= (cs * pending[j]) / mv;
      }
      const V = s[0] + s[1], wc = s.map((x) => x / V);
      ret.push((V / Vprev - 1) * 100); wCore.push(wc[0]); cost.push(cs / Vprev); moved.push(mv / Vprev);
      costFrac.push(wPrev[0] * core.costFrac[i] + wPrev[1] * sat.costFrac[i] + cs / Vprev);
      nPos.push(core.nPos[i] + sat.nPos[i]);
      inv.push(wc[0] * core.inv[i] + wc[1] * sat.inv[i]);
      turn.push(wPrev[0] * core.turn[i] + wPrev[1] * sat.turn[i] + mv / Vprev);
      const wm = [wPrev[0] * core.wMax[i], wPrev[1] * sat.wMax[i]].filter(Number.isFinite);
      wMax.push(wm.length ? Math.max(...wm) : Number.NaN);
      pending[0] = wC * V - s[0]; pending[1] = (1 - wC) * V - s[1];
    }
    return { run: { dates: dates0, ret, costFrac, nPos, inv, turn: turn.map((v, i) => ({ d: dates0[i], v })), trades: [], entryCs: [], wMax, haltSkip: 0, exitDefer: 0 }, wCore, cost, moved };
  };

  // ---- 위성 비중 구조 자체 점검 (성과 아님) ----
  const CP = (id: string): Comp => compOf.get(id as CId)!;
  type SatNb = { kind: "fixedEq" } | { kind: "cap"; id: string; v: number } | { kind: "win"; w: number };
  interface DSDef { readonly trial: number; readonly coreW: number; readonly coreN: number; readonly sat: readonly string[]; readonly cap: { id: string; v: number } | null; readonly nNeighbors: readonly number[]; readonly satNb: readonly SatNb[] }
  const CANDS_ALL: Record<string, DSDef> = {
    DS7: { trial: DS7_TRIAL, coreW: DS7_CAND.coreW, coreN: DS7_CAND.coreN, sat: DS7_CAND.sat, cap: null, nNeighbors: [], satNb: [] },
  };
  const buildSat = (ids: readonly string[], lagFor: (id: string) => number, cap: { id: string; v: number } | null, repl = false, o: { win?: number; fixedEq?: boolean } = {}): Out =>
    buildAlloc(ids.map((id) => (repl ? cdOf(CP(id), 1, replSet(CP(id))) : cdOf(CP(id), lagFor(id)))), o.win ?? IVA_VOL_WINDOW, null, RATE, cap === null ? undefined : { id: cap.id as CId, v: cap.v }, !!o.fixedEq);
  console.log(`\n=== 1e. 위성 비중 구조 자체 점검 (성과 아님: 목표 비중과 상한·반반 고정 규칙만 확인) ===`);
  {
    const t1 = capRedistribute([0.5, 0.3, 0.2], 0, 0.2), t2 = capRedistribute([0.1, 0.5, 0.4], 0, 0.2);
    const okT = Math.abs(t1[0] - 0.2) < 1e-12 && Math.abs(t1[1] - 0.48) < 1e-12 && Math.abs(t1[2] - 0.32) < 1e-12 && Math.abs(t1.reduce((a, x) => a + x, 0) - 1) < 1e-12 && t2[0] === 0.1 && t2[1] === 0.5;
    console.log(`  상한 규칙 합성 점검: [0.5,0.3,0.2] 상한 0.2(첫째) → [${t1.map((x) => x.toFixed(2)).join(", ")}] (기대 [0.20, 0.48, 0.32]), 상한 미만은 그대로 [${t2.map((x) => x.toFixed(2)).join(", ")}] ${okT ? "통과" : "불일치"}`);
    if (!okT) throw new Error("상한 규칙 합성 점검 실패 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)");
    for (const [cid, cdv] of Object.entries(CANDS_ALL)) {
      const o = buildSat(cdv.sat, () => 1, cdv.cap), we = warmEnd(o);
      const post = o.wTgt.map((row) => row.slice(we));
      const sumDev = Math.max(...o.wTgt[0].map((_, i) => Math.abs(o.wTgt.reduce((a, row) => a + row[i], 0) - 1)));
      const jc = cdv.cap ? cdv.sat.indexOf(cdv.cap.id) : -1, maxCap = jc >= 0 ? Math.max(...post[jc]) : NaN, nCap = jc >= 0 && cdv.cap ? post[jc].filter((x) => Math.abs(x - (cdv.cap as { v: number }).v) < 1e-12).length : 0;
      console.log(`  ${cid} 위성 ${cdv.sat.join("+")}${cdv.cap ? ` (${cdv.cap.id} 상한 ${cdv.cap.v * 100}%)` : ""}: 워밍업 ${we}일 | 목표 비중 합 최대 편차 ${sumDev.toExponential(2)} | 워밍업 이후 평균 목표 비중 ${cdv.sat.map((id, j) => `${id} ${f2(avg(post[j]) * 100)}%`).join(" / ")}${jc >= 0 ? ` | ${cdv.cap?.id} 목표 최대 ${f2(maxCap * 100)}%, 상한에 걸린 날 ${nCap}/${post[jc].length}일` : ""}`);
      if (sumDev > 1e-9 || (jc >= 0 && cdv.cap && maxCap > cdv.cap.v + 1e-12)) throw new Error(`${cid} 위성 목표 비중 점검 실패 — 중단하고 보고한다`);
      for (const nb of cdv.satNb) {
        if (nb.kind === "fixedEq") {
          const q = buildSat(cdv.sat, () => 1, null, false, { fixedEq: true }), dev = Math.max(...q.wTgt.flat().map((x) => Math.abs(x - 1 / cdv.sat.length)));
          console.log(`  ${cid} 이웃 반반 고정: 목표 비중 ${cdv.sat.map(() => f2(100 / cdv.sat.length)).join(" / ")}% 대비 최대 편차 ${dev.toExponential(2)}`);
          if (dev > 1e-12) throw new Error(`${cid} 반반 고정 점검 실패 — 중단하고 보고한다`);
        } else if (nb.kind === "cap") {
          const q = buildSat(cdv.sat, () => 1, { id: nb.id, v: nb.v }), jq = cdv.sat.indexOf(nb.id), qs = Math.max(...q.wTgt[0].map((_, i) => Math.abs(q.wTgt.reduce((a, row) => a + row[i], 0) - 1))), qm = Math.max(...q.wTgt[jq]), qn = q.wTgt[jq].filter((x) => Math.abs(x - nb.v) < 1e-12).length;
          console.log(`  ${cid} 이웃 ${nb.id} 상한 ${nb.v * 100}%: 목표 비중 합 최대 편차 ${qs.toExponential(2)} | ${nb.id} 목표 최대 ${f2(qm * 100)}%, 상한에 걸린 날 ${qn}/${q.wTgt[jq].length}일`);
          if (qs > 1e-9 || qm > nb.v + 1e-12) throw new Error(`${cid} 한쪽 상한 이웃 점검 실패 — 중단하고 보고한다`);
        } else {
          const q = buildSat(cdv.sat, () => 1, null, false, { win: nb.w }), same = q.run.ret.length === o.run.ret.length && q.run.ret.every((x, i) => x === o.run.ret[i]);
          console.log(`  ${cid} 이웃 변동성 창 ${nb.w}일: 위성 일별 수익이 기준(${IVA_VOL_WINDOW}일)과 ${same ? "비트 단위로 동일 — 구성요소가 하나뿐이라 창 길이가 결과에 영향을 주지 않는다(퇴화 이웃)" : "다름"}`);
        }
      }
    }
  }
  // ---- 후보 ----
  interface Lg { core: number; sat: Record<string, number> }
  const lgAll = (cd: DSDef, n: number): Lg => ({ core: n, sat: Object.fromEntries(cd.sat.map((id) => [id, n])) });
  interface BuiltDS { sat: Out; coreRun: CoreRun; core: Sl; res: CombOut }
  const buildDS = (cd: DSDef, o: { lg?: Lg; N?: number; wC?: number; cap?: { id: string; v: number } | null; win?: number; fixedEq?: boolean; replSat?: boolean; replCore?: boolean }): BuiltDS => {
    const N = o.N ?? cd.coreN, wC = o.wC ?? cd.coreW, lg = o.lg ?? lgAll(cd, 1), cap = o.cap === undefined ? cd.cap : o.cap;
    const sat = buildSat(cd.sat, (id) => lg.sat[id], cap, !!o.replSat, { win: o.win, fixedEq: o.fixedEq });
    const rc = o.replCore ? coreReplSet(N) : undefined, lgc = o.replCore ? 1 : lg.core;
    const coreRun = getCore(N, lgc, rc), core = getCoreSl(N, lgc, rc);
    return { sat, coreRun, core, res: combineCS(core, slOf(sat.run), wC, CS_MOVE_COST) };
  };
  const baseBuilt = new Map<string, BuiltDS>();
  const cd7 = CANDS_ALL["DS7"];
  const lv1 = comps[0];
  const sg = (x: number): string => `${x >= 0 ? "+" : ""}${f2(x)}`;

  // =====================================================================================================================
  // DS7: 계좌 전체 노출 배율 s(t) = min(1, 목표변동성 ÷ σ(t)), σ(t) = 직전 win거래일(전일까지) DS6 기본 계좌(배율 적용 전) 일별 수익률 표본 표준편차 × √252
  // =====================================================================================================================
  interface OvOpts { tv: number; win: number; delay: number; rate: number }
  interface OvOut { ret: number[]; s: number[]; moved: number[]; cost: number[] }
  /**
   * 계산 순서(거래일 t = 0..n−1): ① t일 수익 반영(위험 계좌 X만 DS6 기본 계좌 수익률로 움직이고 현금 C는 수익 0) ② 종가 t에 목표 노출 tgt를 정한다:
   * d[k] = (k ≥ win−1이면) min(1, 목표변동성 ÷ σ_k), 아니면 1; σ_k는 k일 종가까지 직전 win일 기본 계좌 수익률의 표본 표준편차 × √252. tgt = d[t − delay](delay 0 = 같은 종가 체결).
   * ③ 같은 종가에 X를 tgt × 계좌 가치로 맞추는 고정 금액 이동 m을 하고 이동액 |m|의 rate를 받는 쪽 계좌가 부담. ④ s[t+1] = tgt가 t+1일 수익에 적용된다.
   * 따라서 t일 수익에 적용되는 배율은 t−1일 종가까지의 정보만 쓰고 당일 정보는 쓰지 않는다. 처음 win거래일(t = 0..win−1)은 s = 1.
   */
  const overlay = (baseRet: ArrayLike<number>, o: OvOpts): OvOut => {
    const n = baseRet.length, p1 = new Float64Array(n + 1), p2 = new Float64Array(n + 1);
    for (let t = 0; t < n; t++) { p1[t + 1] = p1[t] + baseRet[t]; p2[t + 1] = p2[t] + baseRet[t] * baseRet[t]; }
    const d = new Float64Array(n).fill(1);
    for (let t = o.win - 1; t < n; t++) {
      const s1 = p1[t + 1] - p1[t + 1 - o.win], s2 = p2[t + 1] - p2[t + 1 - o.win];
      const sig = Math.sqrt(Math.max(0, (s2 - (s1 * s1) / o.win) / (o.win - 1))) * Math.sqrt(DS7_ANN_DAYS);
      d[t] = sig > 0 ? Math.min(1, (o.tv * 100) / sig) : 1;
    }
    let X = 1, C = 0;
    const ret: number[] = [], moved: number[] = [], cost: number[] = [], s = new Array<number>(n).fill(1);
    for (let t = 0; t < n; t++) {
      const Vprev = X + C;
      X *= 1 + baseRet[t] / 100;
      const V = X + C, k = t - o.delay, tgt = k >= 0 ? d[k] : 1;
      const m = tgt * V - X, c = o.rate * Math.abs(m);
      if (m > 0) { X += m - c; C -= m; } else { X += m; C += -m - c; }
      ret.push(((X + C) / Vprev - 1) * 100); moved.push(Math.abs(m) / Vprev); cost.push(c / Vprev);
      if (t + 1 < n) s[t + 1] = tgt;
    }
    return { ret, s, moved, cost };
  };
  const makeRun = (r: SimRun, ov: OvOut): SimRun => ({
    ...r, ret: ov.ret,
    costFrac: r.costFrac.map((c, i) => c * ov.s[i] + ov.cost[i]),
    inv: r.inv.map((x, i) => x * ov.s[i]),
    turn: r.turn.map((x, i) => ({ d: x.d, v: x.v * ov.s[i] + ov.moved[i] })),
    wMax: r.wMax.map((x, i) => x * ov.s[i]),
  });
  const ovBase: OvOpts = { tv: DS7_TARGET_VOL, win: DS7_VOL_WINDOW, delay: 0, rate: CS_MOVE_COST };
  const ds7Of = (b: BuiltDS, o: Partial<OvOpts> = {}): SimRun => makeRun(b.res.run, overlay(b.res.run.ret, { ...ovBase, ...o }));

  // ---- 배율 구조 자체 점검 (합성 수익률, 성과 아님) ----
  console.log(`\n=== 1f. 노출 배율 구조 자체 점검 (합성 수익률 400일, 시드 고정; DS7 성과 아님) ===`);
  {
    const rng = mulberry32(20261104), n = 400, r: number[] = [];
    for (let i = 0; i < n; i++) { const sd = i < 150 ? 0.6 : i < 300 ? 2.5 : 0.8; r.push((rng() - 0.5) * 2 * sd * Math.sqrt(3)); }
    const std = (a: number[]): number => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
    const W60 = DS7_VOL_WINDOW, base0 = overlay(r, ovBase);
    // (a) 독립 계산한 s: s[t] = t < win ? 1 : min(1, 목표 ÷ (표본 std(r[t−win..t−1]) × √252)) — 전일까지 정보만 쓴다
    let maxS = 0;
    for (let t = 0; t < n; t++) { const sExp = t < W60 ? 1 : Math.min(1, (DS7_TARGET_VOL * 100) / (std(r.slice(t - W60, t)) * Math.sqrt(DS7_ANN_DAYS))); maxS = Math.max(maxS, Math.abs(sExp - base0.s[t])); }
    // (b) 비용 0이면 일수익률 = s × 기본 수익률, 비용이 있으면 그 차이가 이동 비용
    const noCost = overlay(r, { ...ovBase, rate: 0 });
    let maxA = 0, maxB = 0;
    for (let t = 0; t < n; t++) { maxA = Math.max(maxA, Math.abs(noCost.ret[t] - noCost.s[t] * r[t])); maxB = Math.max(maxB, Math.abs(base0.ret[t] - (base0.s[t] * r[t] - base0.cost[t] * 100))); }
    // (c) 목표가 매우 커서 항상 s = 1이면 기본 수익률 그대로, 이동·비용 0
    const big = overlay(r, { ...ovBase, tv: 100 });
    const maxC = Math.max(...big.ret.map((x, t) => Math.abs(x - r[t]))), mvSum = big.moved.reduce((a, x) => a + x, 0);
    // (d) 미래 수익률을 바꿔도 그 전 배율은 같다(당일·미래 정보 미사용)
    const r2 = r.slice(); r2[250] *= 3;
    const pert = overlay(r2, ovBase);
    let maxD = 0;
    for (let t = 0; t <= 250; t++) maxD = Math.max(maxD, Math.abs(pert.s[t] - base0.s[t]));
    // (e) 하루 지연: s_d[t+1] = s[t]
    const dl = overlay(r, { ...ovBase, delay: 1 });
    let maxE = Math.abs(dl.s[1] - 1);
    for (let t = 1; t + 1 < n; t++) maxE = Math.max(maxE, Math.abs(dl.s[t + 1] - base0.s[t]));
    const nLow = base0.s.filter((x) => x < 1).length, firstLow = base0.s.findIndex((x) => x < 1);
    console.log(`  (a) 독립 계산 s와 최대 차이 ${maxS.toExponential(2)} | (b) 비용 0 일수익 = s×기본 최대 차이 ${maxA.toExponential(2)}, 비용 있을 때 = s×기본 − 이동비용 최대 차이 ${maxB.toExponential(2)} | (c) 목표 100(항상 s=1) 기본과 최대 차이 ${maxC.toExponential(2)}, 이동 합 ${mvSum.toExponential(2)} | (d) 250일 수익률을 3배로 바꿔도 0~250일 배율 최대 변화 ${maxD.toExponential(2)} | (e) 하루 지연 배율 = 전날 배율 최대 차이 ${maxE.toExponential(2)} | 합성 계열에서 s<1인 날 ${nLow}일, 첫 s<1 ${firstLow < 0 ? "-" : `${firstLow}번째 날(워밍업 ${W60}일)`}`);
    if (maxS > 1e-12 || maxA > 1e-9 || maxB > 1e-9 || maxC > 1e-9 || mvSum > 1e-12 || maxD > 0 || maxE > 1e-12 || firstLow < W60) throw new Error("노출 배율 구조 점검 실패 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)");
  }

  // ---- DS6 기본 계좌 일관성 (DS6 후속 진단 기록: 연속 전체 11.70 / 39.15, 구간 1 4.10 / 24.51) ----
  const b6 = buildDS(cd7, {});
  {
    const sF = h.st(b6.res.run, FULL), s1 = h.st(b6.res.run, { from: FULL.from, to: "2016-12-30" });
    const ok = f2(sF.cagr) === f2(DS7_DS6_REF.전체[0]) && f2(sF.mdd) === f2(DS7_DS6_REF.전체[1]) && f2(s1.cagr) === f2(DS7_DS6_REF.구간1[0]) && f2(s1.mdd) === f2(DS7_DS6_REF.구간1[1]);
    console.log(`\nDS6 기본 계좌 일관성: 연속 전체 ${f2(sF.cagr)} / ${f2(sF.mdd)} (기록 ${DS7_DS6_REF.전체.join(" / ")}), 2011-01~2016-12 ${f2(s1.cagr)} / ${f2(s1.mdd)} (기록 ${DS7_DS6_REF.구간1.join(" / ")}) → ${ok ? "일치" : "불일치"}`);
    if (!ok) throw new Error("DS6 기록과 다르다 — 중단하고 보고한다");
  }
  if (REPRO) {
    console.log(`\n사전 점검 종료: LV1 재현(이전 연구 일별 순수익 캐시와 같음), 코어 구조·회계 점검, DS6 기본 계좌 일관성(연속 전체 11.70 / 39.15), 노출 배율 구조 자체 점검 통과. DS7 성과는 계산·출력하지 않았다 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    return;
  }

  const mkSpec = (): CandSpec => {
    const cid = "DS7", N0 = cd7.coreN, wC0 = cd7.coreW, satCpsD = cd7.sat.map(CP);
    const base = b6;
    const nbVariants: { label: string; run: () => SimRun }[] = [
      ...DS7_NB_TARGET_VOLS.map((tv) => ({ label: `목표변동성 ${f2(tv * 100)}%`, run: () => ds7Of(base, { tv }) })),
      ...DS7_NB_WINDOWS.map((win) => ({ label: `σ 창 ${win}일`, run: () => ds7Of(base, { win }) })),
      ...[-CS_CORE_W_NEIGHBOR, CS_CORE_W_NEIGHBOR].map((dw) => ({ label: `코어 비중 ${Math.round((wC0 + dw) * 100)}% (위성 ${Math.round((1 - wC0 - dw) * 100)}%)`, run: () => { const r = combineCS(base.core, slOf(base.sat.run), wC0 + dw, CS_MOVE_COST).run; return makeRun(r, overlay(r.ret, ovBase)); } })),
    ];
    let drawK = 0;
    return {
      id: cid, trial: DS7_TRIAL,
      title: `DS6 기본 계좌(코어 ${Math.round(wC0 * 100)}% = 월말 K200P 안 당일 시총 상위 ${N0}종목 시총 비율·교체 순위 밖 ${CS_SWAP_CONFIRM_DAYS}거래일 연속일 때만 / 위성 ${Math.round((1 - wC0) * 100)}% = LV1 단독 / 일별 목표 비중 리밸 이동 비용 ${CS_MOVE_COST * 100}%) + 계좌 전체 노출 배율 s(t) = min(1, 목표변동성 ${DS7_TARGET_VOL * 100}% ÷ σ(t)), σ(t) = 전일까지 DS6 기본 계좌 최근 ${DS7_VOL_WINDOW}거래일 일수익률 표준편차 × √${DS7_ANN_DAYS}, 줄인 몫은 현금, 배율 변경 이동액 ${CS_MOVE_COST * 100}% 비용, 처음 ${DS7_VOL_WINDOW}거래일 s = 1`,
      defense: false, capFrac: 1 / 10, fDenominator: DS_F_DENOMINATOR, ref: { id: "069500", run: bhAsRun },
      hRule: (full, rb) => {
        const a = hVs(full, rb);
        return { ok: a.ok, note: `[사전등록: 069500만 판정] 069500 ${f2(rb.cagr)} / ${f2(rb.mdd)} → ${a.ok ? "O" : "X"} (${a.text})` };
      },
      run: (o) => {
        const repl = !!o.replace, b = buildDS(cd7, { lg: lgAll(cd7, o.lag), replSat: repl });
        const m = tradeMeta(satCpsD, repl ? 1 : o.lag, repl);
        const r = makeRun(b.res.run, overlay(b.res.run.ret, { ...ovBase, delay: o.lag >= 2 ? 1 : 0 }));
        r.trades = [...m.trades.map((t) => ({ ...t, vAtEntry: t.vAtEntry / (1 - wC0) })), ...b.coreRun.trades.map((t) => ({ ...t, vAtEntry: t.vAtEntry / wC0 }))];
        r.entryCs = [...m.entryCs, ...b.coreRun.entryCs]; r.haltSkip = m.haltSkip + b.coreRun.haltSkip; r.exitDefer = m.exitDefer + b.coreRun.exitDefer;
        if (o.lag === 1 && o.detail && !repl) baseBuilt.set(cid, b);
        return r;
      },
      neighbors: nbVariants,
      random: () => {
        const k = drawK++ % KSS_R3_DRAWS;
        const sat = buildAlloc(satCpsD.map((cp) => { const d = randOf(cp)[k]; return { id: cp.id, full: d.full, k0: d.k0, sl: zeroSl }; }), IVA_VOL_WINDOW, null, RATE);
        const r = combineCS(base.core, slOf(sat.run), wC0, CS_MOVE_COST).run;
        return makeRun(r, overlay(r.ret, ovBase));
      },
      reasons: [], label,
      extra: (run) => {
        const b = baseBuilt.get(cid) as BuiltDS, ds6 = b.res.run, ov = overlay(ds6.ret, ovBase);
        console.log(`${cid} 게이트 C 해석(사전등록): 코어·LV1 체결을 하루 지연(lag 2)하고 노출 배율 변경도 하루 늦게 체결(σ 정보는 그만큼 한 거래일 더 오래된 것)해 같은 합성·배율 규칙으로 돌린다. CAGR 하락 ≤ 1%p ∧ MDD 악화 ≤ 2%p.`);
        console.log(`${cid} 게이트 D 해석(사전등록): 이웃 6개 — 목표변동성 12%·18%, σ 창 40일·90일, 코어 비중 30%·50%(각각 나머지는 기본값). 연속 전체 CAGR ≥ 069500 CAGR이어야 통과, 하나라도 미만이면 탈락.`);
        console.log(`${cid} 게이트 E 해석(사전등록): 판정은 LV1의 평가 구간 닫힌 거래 중 상위 3개를 069500 수익률로 바꾼 위성 + 실제 코어를 DS6와 같이 합성하고 같은 노출 배율(재계산한 σ)을 적용한 연속 전체 CAGR ≥ 069500. 코어 상위 3개·둘 다 대체는 보고만.`);
        console.log(`${cid} 게이트 F 해석(사전등록): LV1 무작위 대조(같은 신호일·주문 수, 같은 청산 규칙, 시드 ${KSS_R3_SEED}, ${KSS_R3_DRAWS}회)를 실제 코어(고정)와 40:60으로 합성하고 같은 노출 배율을 적용한 분포 대비 DS7 실제 CAGR의 백분위 ≥ 95.`);
        console.log(`${cid} 게이트 G: 진입 건수는 LV1 진입 + 코어 진입의 합(연속 구간 전체; LV1 ${getRun(lv1, 1).entryCs.filter((c) => CAL[c] >= FULL.from).length} + 코어 ${b.coreRun.entryCs.filter((c) => CAL[c] >= FULL.from).length}). 노출 배율은 진입을 새로 만들지 않는다.`);
        console.log(`${cid} 게이트 H 해석(사전등록): 기준선 069500만 판정(CAGR +${PEAD_H_CAGR_GAIN_PP}%p, 또는 MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p).`);
        // ---- 보고 1: DS6 대비 ----
        console.log(`\n=== DS7 vs DS6 vs 069500 (CAGR % / MDD %; DS6 기록: 연속 전체 ${DS7_DS6_REF.전체.join(" / ")}) ===\n| 구간 | 069500 | DS6 | DS7 | DS7 − DS6 CAGR %p | DS7 − DS6 MDD %p | DS7 − 069500 CAGR %p | DS7 − 069500 MDD %p |\n|---|---|---|---|---|---|---|---|`);
        for (const [wn, w] of W.ALL) {
          const a = h.st(h.bhP, w), c6 = h.st(ds6, w), c7 = h.st(run, w);
          console.log(`| ${wn} | ${f2(a.cagr)} / ${f2(a.mdd)} | ${f2(c6.cagr)} / ${f2(c6.mdd)} | ${f2(c7.cagr)} / ${f2(c7.mdd)} | ${sg(c7.cagr - c6.cagr)} | ${sg(c7.mdd - c6.mdd)} | ${sg(c7.cagr - a.cagr)} | ${sg(c7.mdd - a.mdd)} |`);
        }
        console.log(`구간별 최악 12개월 %: ${W.ALL.map(([wn, w]) => `${wn} — 069500 ${f2(h.worst12(h.bhP, w))}, DS6 ${f2(h.worst12({ dates: dates0, ret: ds6.ret }, w))}, DS7 ${f2(h.worst12(run, w))}`).join(" | ")}`);
        // ---- 보고 2: 연도별 ----
        {
          const years: number[] = [];
          for (let y = Number(FULL.from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) years.push(y);
          console.log(`\n=== 연도별 수익률 % (일수익률 복리; ${years[0]}년은 ${FULL.from}부터, ${years[years.length - 1]}년은 ${h.dataEnd}까지) ===\n| 연도 | 069500 | DS6 | DS7 | DS7 − 069500 %p | DS7 − DS6 %p |\n|---|---|---|---|---|---|`);
          const ex: number[] = [];
          for (const y of years) {
            const a = h.yearRet({ dates: dates0, ret: bRetAxis }, y), c6 = h.yearRet({ dates: dates0, ret: ds6.ret }, y), c7 = h.yearRet({ dates: dates0, ret: run.ret }, y);
            ex.push(c7 - a);
            console.log(`| ${y} | ${f2(a)} | ${f2(c6)} | ${f2(c7)} | ${sg(c7 - a)} | ${sg(c7 - c6)} |`);
          }
          console.log(`DS7 − 069500 승·패 연수: 승 ${ex.filter((x) => x > 0).length} / 패 ${ex.filter((x) => x < 0).length} (평균 ${sg(avg(ex))}%p, 중앙값 ${sg(median(ex))}%p)`);
        }
        // ---- 보고 3: 롤링 3년 창 (DS6과 나란히) ----
        {
          const ROLL = 36, meSet = new Set(h.monthEnds), anchors: number[] = [];
          for (let i = 0; i < nDays; i++) if (meSet.has(dates0[i])) anchors.push(i);
          const cum = (r: ArrayLike<number>): Float64Array => { const v = new Float64Array(nDays + 1); v[0] = 1; for (let i = 0; i < nDays; i++) v[i + 1] = v[i] * (1 + r[i] / 100); return v; };
          const vb = cum(bRetAxis), v6 = cum(ds6.ret), v7 = cum(run.ret);
          const mddIn = (v: Float64Array, i0: number, i1: number): number => { let pk = v[i0 + 1], m = 0; for (let t = i0 + 1; t <= i1; t++) { const x = v[t + 1]; if (x > pk) pk = x; m = Math.max(m, 1 - x / pk); } return m * 100; };
          interface Rw { start: string; end: number; c7: number; c6: number; cb: number; m7: number; m6: number; mb: number }
          const rows: (Rw & { endD: string })[] = [];
          for (let k = 0; k + ROLL < anchors.length; k++) {
            const i0 = anchors[k], i1 = anchors[k + ROLL], yrs = (Date.parse(dates0[i1]) - Date.parse(dates0[i0])) / 86_400_000 / 365.25;
            const cg = (v: Float64Array): number => (Math.pow(v[i1 + 1] / v[i0 + 1], 1 / yrs) - 1) * 100;
            rows.push({ start: dates0[i0], endD: dates0[i1], end: i1, c7: cg(v7), c6: cg(v6), cb: cg(vb), m7: mddIn(v7, i0, i1), m6: mddIn(v6, i0, i1), mb: mddIn(vb, i0, i1) });
          }
          const qn = (v: number[], p: number): number => { const a = [...v].sort((x, y) => x - y); return a[Math.min(Math.floor(a.length * p), a.length - 1)]; };
          const share = (f: (r: Rw) => boolean, list: Rw[] = rows): string => `${list.filter(f).length}/${list.length} (${f2((list.filter(f).length / Math.max(list.length, 1)) * 100)}%)`;
          console.log(`\n=== 롤링 3년 창(월말 앵커 ${anchors.length}개, 36개월 창을 한 달씩 이동, 창 ${rows.length}개, 서로 겹침; 첫 창 ${rows[0].start}~${rows[0].endD}, 마지막 창 ${rows[rows.length - 1].start}~${rows[rows.length - 1].endD}) — DS6과 나란히 ===`);
          for (const [nm, kc, km] of [["DS6", "c6", "m6"], ["DS7", "c7", "m7"]] as const) {
            const ex = rows.map((r) => r[kc] - r.cb), md = rows.map((r) => r[km] - r.mb);
            console.log(`${nm}: 069500보다 CAGR 높은 창 ${share((r) => r[kc] > r.cb)} | 초과수익 %p 최소 ${sg(Math.min(...ex))} / 25% ${sg(qn(ex, 0.25))} / 중앙값 ${sg(median(ex))} / 75% ${sg(qn(ex, 0.75))} / 최대 ${sg(Math.max(...ex))} / 평균 ${sg(avg(ex))} | 창 안 MDD가 069500보다 작은 창 ${share((r) => r[km] < r.mb)} (MDD 차 중앙값 ${sg(median(md))}%p, 최소 ${sg(Math.min(...md))}, 최대 ${sg(Math.max(...md))}) | 둘 다 ${share((r) => r[kc] > r.cb && r[km] < r.mb)} | 둘 다 아님 ${share((r) => !(r[kc] > r.cb) && !(r[km] < r.mb))} | 롤링 CAGR 최소 ${f2(Math.min(...rows.map((r) => r[kc])))} / 중앙값 ${f2(median(rows.map((r) => r[kc])))} / 최대 ${f2(Math.max(...rows.map((r) => r[kc])))}`);
          }
          console.log(`069500 롤링 3년 CAGR 최소 ${f2(Math.min(...rows.map((r) => r.cb)))} / 중앙값 ${f2(median(rows.map((r) => r.cb)))} / 최대 ${f2(Math.max(...rows.map((r) => r.cb)))} | DS7이 DS6보다 CAGR 높은 창 ${share((r) => r.c7 > r.c6)}, MDD 작은 창 ${share((r) => r.m7 < r.m6)}`);
          console.log(`창 시작 연도별(DS6 / DS7):\n| 시작 연도 | 창 수 | CAGR 높음 DS6 | CAGR 높음 DS7 | MDD 작음 DS6 | MDD 작음 DS7 |\n|---|---|---|---|---|---|`);
          for (const y of [...new Set(rows.map((r) => r.start.slice(0, 4)))].sort()) {
            const l = rows.filter((r) => r.start.startsWith(y));
            console.log(`| ${y} | ${l.length} | ${share((r) => r.c6 > r.cb, l)} | ${share((r) => r.c7 > r.cb, l)} | ${share((r) => r.m6 < r.mb, l)} | ${share((r) => r.m7 < r.mb, l)} |`);
          }
        }
        // ---- 보고 4: 노출·이동·비용 ----
        {
          console.log(`\n=== 노출 배율 s와 이동 비용 (DS6 코어-위성 리밸과 따로) ===\n| 구간 | 평균 s | 평균 현금 비중 % (배율로 만든 몫) | s < 1인 날 비율 | s 최소 | 계좌 전체 평균 투자 비중 % (DS6 → DS7) | 배율 이동 금액 연 % (계좌 대비) | 배율 이동 비용 연 %p | 배율 이동 있는 날 | DS6 리밸 이동 금액 연 % | DS6 리밸 비용 연 %p |\n|---|---|---|---|---|---|---|---|---|---|---|`);
          for (const [wn, w] of W.ALL) {
            const idx: number[] = [];
            for (let i = 0; i < nDays; i++) if (dates0[i] >= w.from && dates0[i] <= w.to) idx.push(i);
            const yrs = Math.max((Date.parse(dates0[idx[idx.length - 1]]) - Date.parse(w.from)) / 86_400_000 / 365.25, 1e-9);
            const sS = idx.map((i) => ov.s[i]), mv = idx.reduce((a, i) => a + ov.moved[i], 0) * 100, cs = idx.reduce((a, i) => a + ov.cost[i], 0) * 100;
            const r6 = idx.reduce((a, i) => a + b.res.moved[i], 0) * 100, c6 = idx.reduce((a, i) => a + b.res.cost[i], 0) * 100;
            const s6 = h.st(ds6, w), s7 = h.st(run, w);
            console.log(`| ${wn} | ${f2(avg(sS))} | ${f2((1 - avg(sS)) * 100)} | ${sS.filter((x) => x < 1).length}/${idx.length} (${f2((sS.filter((x) => x < 1).length / idx.length) * 100)}%) | ${f2(Math.min(...sS))} | ${f2(s6.avgInv)} → ${f2(s7.avgInv)} | ${f2(mv / yrs)} | ${f2(cs / yrs)} | ${idx.filter((i) => ov.moved[i] > 0).length}/${idx.length} | ${f2(r6 / yrs)} | ${f2(c6 / yrs)} |`);
          }
          const sAll = ov.s, ys = [...new Set(dates0.map((d) => d.slice(0, 4)))];
          console.log(`연도별 평균 s: ${ys.map((y) => { const l = dates0.map((d, i) => (d.startsWith(y) ? sAll[i] : NaN)).filter(Number.isFinite); return `${y} ${f2(avg(l))}`; }).join(" | ")}`);
          const sTot = h.st(run, FULL), s6t = h.st(ds6, FULL);
          console.log(`DS7 전체 비용 합계(구성요소 내부 비용 × s + 배율 이동 비용, 계좌 대비 %): ${f2(sTot.cost)} (DS6 ${f2(s6t.cost)}) | 연 회전율 DS7 ${f2(sTot.turnover)}% (DS6 ${f2(s6t.turnover)}%)`);
        }
        // ---- 보고 5: 삼성전자 ----
        {
          const ch = coreHolds(N0), sam = (i: number): number => ch[i].find(([code]) => code === SAMSUNG)?.[1] ?? 0;
          const sAfter = (i: number): number => (i + 1 < nDays ? ov.s[i + 1] : ov.s[i]);
          const w6 = dates0.map((_, i) => b.res.wCore[i] * sam(i) * 100), w7 = dates0.map((_, i) => b.res.wCore[i] * sam(i) * sAfter(i) * 100);
          console.log(`\n=== 삼성전자 일별 평균 계좌 비중 % (현금 날 포함; ${nDays}일) ===\n| 구간 | DS6 | DS7 | 코어 안 평균 삼성전자 비중 % |\n|---|---|---|---|`);
          for (const [wn, w] of W.ALL) {
            const idx: number[] = [];
            for (let i = 0; i < nDays; i++) if (dates0[i] >= w.from && dates0[i] <= w.to) idx.push(i);
            console.log(`| ${wn} | ${f2(avg(idx.map((i) => w6[i])))} | ${f2(avg(idx.map((i) => w7[i])))} | ${f2(avg(idx.map((i) => sam(i) * 100)))} |`);
          }
          const coreXRun = simCore(N0, { lag: 1, dropTop: DS7_DROP_TOP }), coreXSl = slice(coreXRun);
          const xRes = combineCS(coreXSl, slOf(b.sat.run), wC0, CS_MOVE_COST), x6 = xRes.run, x7 = makeRun(xRes.run, overlay(xRes.run.ret, ovBase));
          console.log(`\n=== 코어에서 시총 1위(삼성전자)를 뺀 경우 (매 거래일 코어 순위 목록 맨 앞 1종목 제외, 나머지 규칙·위성·합성·배율은 같음; 새 후보 아님; CAGR % / MDD %) ===\n| 구간 | 069500 | DS6 | DS6-X | DS7 | DS7-X |\n|---|---|---|---|---|---|`);
          for (const [wn, w] of W.ALL) {
            const c1 = (r: { dates: string[]; ret: number[] }): string => { const sv = h.st(r, w); return `${f2(sv.cagr)} / ${f2(sv.mdd)}`; };
            console.log(`| ${wn} | ${c1(h.bhP)} | ${c1(ds6)} | ${c1(x6)} | ${c1(run)} | ${c1(x7)} |`);
          }
          const sx7 = h.st(x7, FULL), sb = h.st(h.bhP, FULL), s7f = h.st(run, FULL);
          console.log(`DS7-X 연속 전체 ${f2(sx7.cagr)} / ${f2(sx7.mdd)} (069500 대비 CAGR ${sg(sx7.cagr - sb.cagr)}%p, MDD ${sg(sx7.mdd - sb.mdd)}%p; DS7 대비 CAGR ${sg(sx7.cagr - s7f.cagr)}%p, MDD ${sg(sx7.mdd - s7f.mdd)}%p)`);
        }
        // ---- 보고 6: 하루 지연 분해(진단), E 보고, 코어 이력 ----
        {
          const variants: [string, BuiltDS, Partial<OvOpts>][] = [
            ["기준(지연 없음)", b, {}],
            ["코어만 하루 지연", buildDS(cd7, { lg: { core: 2, sat: { LV1: 1 } } }), {}],
            ["LV1만 하루 지연", buildDS(cd7, { lg: { core: 1, sat: { LV1: 2 } } }), {}],
            ["노출 배율 체결만 하루 지연", b, { delay: 1 }],
            ["전부 (= 게이트 C)", buildDS(cd7, { lg: lgAll(cd7, 2) }), { delay: 1 }],
          ];
          console.log(`\n=== 진단 [판정 불사용] 게이트 C 분해: 하루 지연 적용 대상별 (CAGR % / MDD %, 변화 %p; 구간별 CAGR 변화) ===\n| 지연 적용 대상 | 연속 전체 | CAGR 변화 | MDD 변화 | ${NW.map(([n]) => n).join(" 변화 | ")} 변화 |\n|---|---|---|---|${NW.map(() => "---").join("|")}|`);
          const b0 = h.st(run, FULL);
          for (const [nm, bb, o] of variants) {
            const r = bb === b && Object.keys(o).length === 0 ? run : ds7Of(bb, o), s = h.st(r, FULL);
            console.log(`| ${nm} | ${f2(s.cagr)} / ${f2(s.mdd)} | ${nm.startsWith("기준") ? "-" : sg(s.cagr - b0.cagr)} | ${nm.startsWith("기준") ? "-" : sg(s.mdd - b0.mdd)} | ${NW.map(([, w]) => (nm.startsWith("기준") ? "-" : sg(h.st(r, w).cagr - h.st(run, w).cagr))).join(" | ")} |`);
          }
          const satRep = h.st(ds7Of(buildDS(cd7, { replSat: true })), FULL), coreRep = h.st(ds7Of(buildDS(cd7, { replCore: true })), FULL), bothRep = h.st(ds7Of(buildDS(cd7, { replSat: true, replCore: true })), FULL), full = h.st(run, FULL), bh = h.st(h.bhP, FULL);
          const ct = coreTradesAll(N0).sort((a, c2) => pnlOf(c2) - pnlOf(a)).slice(0, F_E_TOP_TRADES);
          console.log(`${cid} E 보고 [위성 대체만 판정]: 원래 ${f2(full.cagr)} / ${f2(full.mdd)} | 위성 상위 3개 거래 대체 ${f2(satRep.cagr)} / ${f2(satRep.mdd)} (판정, 기준 ${f2(bh.cagr)}) | 코어 상위 3개 거래 대체 ${f2(coreRep.cagr)} / ${f2(coreRep.mdd)} (보고) | 둘 다 대체 ${f2(bothRep.cagr)} / ${f2(bothRep.mdd)} (보고)`);
          console.log(`  위성 대체 거래: ${satCpsD.map((cp) => `${cp.id} [${[...replSet(cp)].map((k) => { const [code, ec] = k.split("|"); const t = getRun(cp, 1).trades.find((x) => x.code === code && x.entryC === Number(ec)) as SimTrade; return `${label(code)} ${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`; }).join(", ")}]`).join(" | ")}`);
          console.log(`  코어 상위 3개 거래(기간 끝에 열린 보유 포함, 코어 계좌 대비 손익 순): ${ct.map((t) => `${label(t.code)} ${CAL[t.entryC]}~${CAL[t.exitC]}${t.reason === "기간 끝 평가" ? "(보유 중)" : ""} 수익률 ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")}`);
          console.log(`${cid} 코어 구성 이력(월말 K200P 안 당일 시총 상위 ${N0}종목; 체결일 종목 교체·비중 조정):\n    ${evLine(b.coreRun)}`);
        }
        void median; void pct; void quant;
      },
    };
  };

  const sp7 = mkSpec();
  const verdicts: Verdict[] = [evaluate(h, W, sp7)];

  // ---- 공통 보고 ----
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: DS7_PRIOR_TESTS, contamNote: W.contamNote });
  console.log(`DS6 기록(참고, 연속 전체): ${DS7_DS6_REF.전체.join(" / ")} — 위 비교 표 참조`);
  console.log(`
=== 실행 지표 ===
Supabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ") || "없음"} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${verdicts.map((v) => v.trial).join(", ")}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

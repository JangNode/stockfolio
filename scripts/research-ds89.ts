/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 DS8(시도 274)·DS9(시도 275). 사전 등록: docs/research/ds8-ds9-prereg.md.
 * 기본은 DS6(코어 40% = 월말 K200P 안 당일 시총 상위 2종목 시총 비율·교체 순위 밖 5거래일 연속일 때만 / 위성 60% = LV1 단독 / 일별 목표 비중 리밸 이동 비용 0.25%).
 * DS8 = 위성 LV1의 일별 목표 배율 m을 최근 3거래일 단순평균으로 평활. DS9 = 코어를 상위 4종목 시총 비율에 종목당 상한 40%(초과분은 나머지에 시총 비례 재배분)로 바꾼다.
 * ALLOC_MODE=repro: 재현·구조 자체 점검만(DS8·DS9 성과 미계산, DS6 일관성만 계산) / ds8 / ds9: 해당 후보 시험 1회. 공시·DART 사용 없음.
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
import { capWeights } from "@/lib/coreCapWeights";
import { DS89_PRIOR_TESTS, DS8_TRIAL, DS9_TRIAL, DS89_RUN_START, DS89_WINDOWS, DS89_DS6_REF, DS8_SMOOTH_WIN, DS8_NB_WINDOWS, DS9_CORE_N, DS9_CORE_CAP, DS9_NB_N, DS9_NB_CAP, DS89_CORE_W, DS89_F_DENOMINATOR, DS89_SAMSUNG } from "@/lib/ds89Config";
import { CS_SWAP_CONFIRM_DAYS, CS_RANK_DEPTH, CS_MOVE_COST, CS_CORE_W_NEIGHBOR, CS_ACCOUNTING_TOL_PP } from "@/lib/coreSatelliteConfig";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, mulberry32, SNAP_END, f2, avg, median, type S, type Win } from "./researchHarness";
import { evaluate, summaryReport, type CandSpec, type Verdict, type Windows } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
const sha = (b: Uint8Array | Buffer | string): string => createHash("sha256").update(b).digest("hex");
/** 공통 평가 시작 이후로 자른 일별 계열(구성요소 하나의 계좌 기준). */
interface Sl { dates: string[]; ret: number[]; costFrac: number[]; nPos: number[]; inv: number[]; turn: number[]; wMax: number[] }
type LvOpts = { lag: number; smooth?: number; replace?: Set<string> };

async function main(): Promise<void> {
  const MODE = (process.env.ALLOC_MODE ?? "").trim().toLowerCase();
  if (MODE !== "repro" && MODE !== "ds8" && MODE !== "ds9") throw new Error("ALLOC_MODE=repro|ds8|ds9 필요");
  const REPRO = MODE === "repro";
  console.log(`연구 DS8(시도 ${DS8_TRIAL})·DS9(시도 ${DS9_TRIAL}) ${REPRO ? "사전 점검(재현·구조 자체 점검만, DS8·DS9 성과 미계산)" : `시험 ${MODE.toUpperCase()} 1회`} 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, nameOf } = await loadK200P(h);

  // ---- 평가 구간: 초기 배분 2011-01-03 종가(LV1 250거래일 워밍업 뒤 첫 거래일), 수익 집계 2011-01-04~데이터 끝(2026-10-26) 연속, 하위 구간 3개 ----
  const cPE = CAL.findIndex((d) => d >= DS89_RUN_START);
  if (cPE < 0 || CAL[cPE] !== DS89_RUN_START) throw new Error(`${DS89_RUN_START}이 거래일 달력에 없음`);
  const cutC = cPE + 1;
  const NW: [string, Win][] = DS89_WINDOWS.map(([n, f, t]) => [n, { from: f, to: t }]);
  const FULL: Win = { from: CAL[cutC], to: "9999-12-31" };
  if (NW[0][1].from !== FULL.from) throw new Error(`구간 1 시작 ${NW[0][1].from}이 연속 평가 시작 ${FULL.from}과 다르다`);
  const W: Windows = { NW, FULL, ALL: [...NW, ["연속 전체 2011-01~2026-10", FULL]], noEx26: true, contamNote: "경고(오염): 이 구간 전체(2011~2026)는 DS6·DS4·LV1 등 선행 연구에서 이미 반복해 본 데이터다. DS8·DS9은 DS6 결과를 본 뒤 만든 변형(선택 편향)이라 순수 검증이 아니다." };
  console.log(`연속 평가: 초기 배분 ${CAL[cPE]} 종가(비용 없음), 수익률 집계 ${FULL.from}~${h.dataEnd} | 구간 ${NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);

  // ---- 0. 069500 기준선 ----
  console.log(`\n=== 0. 069500 기준선 (수익 집계 ${FULL.from}~; 원주가, 가격 수익만; 모든 구간의 기준선 시작일 = 해당 구간 시작일; CAGR % / MDD %) ===\n| 구간 | 기준선 첫 수익률 날짜 | 069500 (보조 파일) |\n|---|---|---|`);
  for (const [wn, w] of W.ALL) {
    const b = h.st(h.bhP, w), first = h.bhP.dates.find((d) => d >= w.from);
    console.log(`| ${wn} | ${first} | ${f2(b.cagr)} / ${f2(b.mdd)} |`);
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
  let runLV1!: (o: LvOpts) => SimRun;
  let randLV1!: (rng: () => number, ob: Map<number, number>, smooth?: number) => SimRun;
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
    const rawMult = (c: number, stocks: { code: string }[]): number => volMultiplier(equalWeightSigma(stocks.map((s) => alignedOf(s.code)), c, LV_WINDOW, LV_ANNUAL_DAYS), cd.target, LV_ROUND_DP);
    /**
     * DS8: smooth가 있으면 그날 종가 판단의 목표 배율 m(= 위 rawMult, 소수 2자리 반올림 값)을 최근 smooth 거래일(그날 포함, 달력 거래일 기준)의 단순평균으로 바꾼다.
     * 평균은 그 거래일들 중 m이 계산된 날(보유·편입 예정 종목이 있던 날)만 쓰고 추가 반올림은 하지 않는다. 엔진은 sizeMult를 판단일마다 한 번만 부르므로(보유·편입 예정 종목이 없으면 부르지 않음) 실행마다 새 이력 배열을 쓴다.
     */
    const mkVt = (smooth?: number): SimVt => {
      if (smooth === undefined) return { sizeMult: rawMult, band: LV_BAND };
      const hist = new Float64Array(nCal).fill(Number.NaN);
      return { sizeMult: (c, stocks) => { hist[c] = rawMult(c, stocks); let s = 0, n = 0; for (let k = Math.max(0, c - smooth + 1); k <= c; k++) if (Number.isFinite(hist[k])) { s += hist[k]; n++; } return s / n; }, band: LV_BAND };
    };
    const cfgOf = (smooth?: number) => ({ slip: L_SLIPPAGE, maxPos: LE2.slots, capFrac: 1 / LE2.slots, cooldown: LS_COOLDOWN_DAYS, vt: mkVt(smooth) });
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
    runLV1 = (o) => simSlots(env(cS), cfgOf(o.smooth), hooks, { lag: o.lag, replace: o.replace, detail: true });
    randLV1 = (rng, ob, smooth) => simSlots(env(cS), cfgOf(smooth), {
      candsOf: (c, held, blocked) => {
        const n = ob.get(c) ?? 0;
        if (!n) return [];
        const en = ensAt(c);
        const pool = en.items.filter((it) => it.rets[LE_ENTRY_LEG] > 0 && !held(it.code) && !blocked(it.code)).map((it) => ({ s: en.sOf.get(it.code)!, code: it.code })), out: SimCand[] = [];
        while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
        return out;
      },
      exitReason: hooks.exitReason,
    }, { lag: 1 });
  }

  // ================= 코어: 월말 K200P 구성(PIT) 안 당일 시총 상위 N종목, 시총 비율 보유 (연구 CS) =================
  // 신호: 판단일 c 종가에서 megaAt(c)의 상위 N종목(그날 월말 K200P 구성원, 코스피, 제외 규칙 적용 — 연구 L3와 같은 목록). 체결: c + lag 종가.
  // 교체: 보유 종목이 상위 N위 밖에 CS_SWAP_CONFIRM_DAYS 거래일 연속 머물 때만, 그 종목을 팔고 상위 N위 안에 있으나 보유하지 않은 가장 시총 큰 종목으로 바꾼다.
  // 비중: 처음 편입과 구성이 바뀌는 체결일에만 신호일 시총 비율로 맞추고(팔고 사는 금액에만 비용), 그 사이엔 가격 변동 그대로 둔다. 비용: env의 매수 배수·매도 비용률(수수료 0.015% + 거래세 + 슬리피지 0.1%).
  interface CorePos { code: string; s: S; shares: number; lastPx: number; entryC: number; spend: number; vAtEntry: number; rep: boolean; repVal: number; realized: number; out: number }
  interface CoreEvent { c: number; sells: string[]; buys: string[]; set: string[]; w: number[]; /** 신호일 시총(set 순서) */ mcv: number[]; /** 체결일 목표 비중(set 순서; 상한 있으면 상한 적용 뒤) */ tw: number[] }
  type CoreRun = SimRun & { open: SimTrade[]; events: CoreEvent[]; forcedExit: number };
  const mcapNear = (s: S, c: number): number => { for (let k = c; k >= Math.max(c - 10, 0); k--) { const i = s.idx.get(CAL[k]); if (i !== undefined && s.mcapRow[i] > 0) return s.mcapRow[i]; } return Number.NaN; };
  const simCore = (N: number, o: { lag: number; replace?: Set<string>; onDay?: (c: number, V: number, held: [string, number][]) => void; exclude?: ReadonlySet<string>; dropTop?: number; /** 연구 DS9: 코어 안 종목당 상한 비중(없으면 DS6과 같은 시총 비율) */ capW?: number }): CoreRun => {
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
          const mcv = final.map((code) => ev.mc.get(code) as number);
          const tw = o.capW === undefined ? mcv.map((x) => x / sumMc) : capWeights(mcv, o.capW);
          const twOf = new Map(final.map((code, j) => [code, tw[j]] as [string, number]));
          const target = (code: string): number => (o.capW === undefined ? (V0 * (ev.mc.get(code) as number)) / sumMc : V0 * (twOf.get(code) as number));
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
          out.events.push({ c, sells: ev.sells, buys: ev.buys, set: final, w: pv.map((x) => x / pvs), mcv, tw });
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

  // ---- 공통 평가 시작으로 자른 계열 ----
  const slice = (r: SimRun): Sl => {
    const k0 = r.dates.findIndex((d) => d >= FULL.from);
    if (k0 < 0) throw new Error("자를 지점 없음");
    const tm = new Map(r.turn.map((x) => [x.d, x.v]));
    const dates = r.dates.slice(k0);
    if (r.costFrac.length !== r.dates.length || r.nPos.length !== r.dates.length || r.inv.length !== r.dates.length) throw new Error("일별 계열 길이 불일치");
    return { dates, ret: r.ret.slice(k0), costFrac: r.costFrac.slice(k0), nPos: r.nPos.slice(k0), inv: r.inv.slice(k0), turn: dates.map((d) => tm.get(d) ?? 0), wMax: r.wMax.length === r.dates.length ? r.wMax.slice(k0) : dates.map(() => NaN) };
  };
  const pnlOf = (t: SimTrade): number => (t.proceeds - t.spend) / t.vAtEntry;
  const replKey = (repl?: Set<string>): string => (repl ? [...repl].sort().join(",") : "");
  const lv1Cache = new Map<string, { run: SimRun; sl: Sl }>();
  /** LV1 일별 계열. smooth = DS8 평활 창(없으면 DS6의 LV1 그대로). */
  const lv1Of = (lag: number, smooth?: number, repl?: Set<string>): { run: SimRun; sl: Sl } => {
    const key = `${lag}|${smooth ?? "-"}|${replKey(repl)}`;
    let v = lv1Cache.get(key);
    if (!v) { const run = runLV1({ lag, smooth, replace: repl }); v = { run, sl: slice(run) }; lv1Cache.set(key, v); }
    return v;
  };
  /** 게이트 E: LV1 계좌 기준 평가 구간에 닫힌(청산 실행일 ≥ 평가 시작) 거래 중 손익 상위 3개. */
  const lv1ReplSet = (smooth?: number): Set<string> => new Set(lv1Of(1, smooth).run.trades.filter((t) => CAL[t.exitC] >= FULL.from).sort((a, b) => pnlOf(b) - pnlOf(a)).slice(0, F_E_TOP_TRADES).map((t) => `${t.code}|${t.entryC}`));
  const dates0 = lv1Of(1).sl.dates, nDays = dates0.length;
  const zeros: number[] = new Array<number>(nDays).fill(0);
  const zeroSl: Sl = { dates: dates0, ret: zeros, costFrac: zeros, nPos: zeros, inv: zeros, turn: zeros, wMax: zeros };
  const dateIdx = new Map(dates0.map((d, i) => [d, i]));
  const bhRet = new Map(h.bhP.dates.map((d, i) => [d, h.bhP.ret[i]]));
  const bRetAxis = dates0.map((d) => { const r = bhRet.get(d); if (r === undefined) throw new Error(`069500 일수익률 없음 ${d}`); return r; });
  interface CoreX { run: CoreRun; sl: Sl }
  const coreCache = new Map<string, CoreX>();
  const coreOf = (N: number, capW: number | undefined, lag: number, o: { repl?: Set<string>; exclude?: ReadonlySet<string> } = {}): CoreX => {
    const key = `${N}|${capW ?? "-"}|${lag}|${replKey(o.repl)}|${o.exclude ? [...o.exclude].sort().join(",") : ""}`;
    let v = coreCache.get(key);
    if (!v) {
      const run = simCore(N, { lag, replace: o.repl, exclude: o.exclude, capW });
      const sl = slice(run);
      if (sl.dates.length !== nDays || sl.dates.some((d, k) => d !== dates0[k])) throw new Error("코어와 LV1의 날짜 축이 다르다");
      v = { run, sl }; coreCache.set(key, v);
    }
    return v;
  };
  const coreTradesAll = (r: CoreRun): SimTrade[] => [...r.trades, ...r.open].filter((t) => CAL[t.exitC] >= FULL.from);
  const coreReplSet = (r: CoreRun): Set<string> => new Set(coreTradesAll(r).sort((a, b) => pnlOf(b) - pnlOf(a)).slice(0, F_E_TOP_TRADES).map((t) => `${t.code}|${t.entryC}`));
  /** 날짜별 코어 안 보유 종목 비중(코어 평가액 대비). */
  const coreHolds = (N: number, capW: number | undefined, exclude?: ReadonlySet<string>): [string, number][][] => {
    const arr: [string, number][][] = new Array(nDays).fill(null).map(() => []);
    simCore(N, { lag: 1, capW, exclude, onDay: (c, V, held) => { const i = dateIdx.get(CAL[c]); if (i !== undefined) arr[i] = held.map(([code, v]) => [code, v / V]); } });
    return arr;
  };
  const evLine = (r: CoreRun): string => r.events.map((e) => `${CAL[e.c]} ${e.sells.length ? `${e.sells.map(label).join("+")} → ` : ""}${e.buys.length ? e.buys.map(label).join("+") : "비중 조정"} [${e.set.map((code, j) => `${nameOf.get(code) ?? code} ${f2(e.w[j] * 100)}%`).join(" / ")}]`).join("\n    ");

  // ---- 코어-위성 합성: 코어 비중 w, 위성 1 − w, 매일 종가에 목표 비율 계산 → 다음 거래일 종가에 고정 금액 이동(연구 ALLOC P형과 같은 방식), 이동 금액의 CS_MOVE_COST ----
  interface CombOut { run: SimRun; wCore: number[]; cost: number[]; moved: number[] }
  const combineCS = (core: Sl, sat: Sl, wC: number, rate: number, delay = 0): CombOut => {
    // delay: 목표 비중 이동을 더 늦추는 거래일 수(0 = 종가 t에 계산해 t+1 종가 체결, 1 = t+2 종가 체결). 이동 중인 금액은 새 목표 계산에서 이미 반영된 것으로 본다.
    const parts = [core, sat], s = [wC, 1 - wC], q: number[][] = [];
    const ret: number[] = [], costFrac: number[] = [], nPos: number[] = [], inv: number[] = [], turn: number[] = [], wMax: number[] = [], wCore: number[] = [], cost: number[] = [], moved: number[] = [];
    for (let i = 0; i < nDays; i++) {
      const Vprev = s[0] + s[1], wPrev = [s[0] / Vprev, s[1] / Vprev];
      for (let j = 0; j < 2; j++) s[j] *= 1 + parts[j].ret[i] / 100;
      let mv = 0, cs = 0;
      const pending = q.length > delay ? (q.shift() as number[]) : [0, 0];
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
      const infl = [0, 0];
      for (const p of q) { infl[0] += p[0]; infl[1] += p[1]; }
      q.push([wC * V - s[0] - infl[0], (1 - wC) * V - s[1] - infl[1]]);
    }
    return { run: { dates: dates0, ret, costFrac, nPos, inv, turn: turn.map((v, i) => ({ d: dates0[i], v })), trades: [], entryCs: [], wMax, haltSkip: 0, exitDefer: 0 }, wCore, cost, moved };
  };

  // ---- 후보 정의 ----
  interface Def { id: string; trial: number; coreN: number; capW?: number; smooth?: number; wC: number }
  const DS6D: Def = { id: "DS6", trial: 272, coreN: 2, wC: DS89_CORE_W };
  const DS8D: Def = { id: "DS8", trial: DS8_TRIAL, coreN: 2, wC: DS89_CORE_W, smooth: DS8_SMOOTH_WIN };
  const DS9D: Def = { id: "DS9", trial: DS9_TRIAL, coreN: DS9_CORE_N, capW: DS9_CORE_CAP, wC: DS89_CORE_W };
  interface Opts { coreLag?: number; satLag?: number; delay?: number; N?: number; capW?: number | null; wC?: number; smooth?: number | null; replSat?: boolean; replCore?: boolean; exclude?: ReadonlySet<string> }
  interface Built { res: CombOut; coreX: CoreX; satX: { run: SimRun; sl: Sl }; N: number; capW?: number; smooth?: number; wC: number }
  const build = (d: Def, o: Opts = {}): Built => {
    const N = o.N ?? d.coreN;
    const capW = o.capW === undefined ? d.capW : o.capW === null ? undefined : o.capW;
    const smooth = o.smooth === undefined ? d.smooth : o.smooth === null ? undefined : o.smooth;
    const wC = o.wC ?? d.wC;
    const satX = lv1Of(o.satLag ?? 1, smooth, o.replSat ? lv1ReplSet(smooth) : undefined);
    const coreX = o.replCore ? coreOf(N, capW, 1, { repl: coreReplSet(coreOf(N, capW, 1).run), exclude: o.exclude }) : coreOf(N, capW, o.coreLag ?? 1, { exclude: o.exclude });
    return { res: combineCS(coreX.sl, satX.sl, wC, CS_MOVE_COST, o.delay ?? 0), coreX, satX, N, capW, smooth, wC };
  };
  const asRun = (s: Sl): { dates: string[]; ret: number[]; costFrac: number[]; turn: { d: string; v: number }[]; nPos: number[]; inv: number[] } => ({ dates: s.dates, ret: s.ret, costFrac: s.costFrac, turn: s.dates.map((d, i) => ({ d, v: s.turn[i] })), nPos: s.nPos, inv: s.inv });
  const sg = (x: number): string => `${x >= 0 ? "+" : ""}${f2(x)}`;
  const cell = (r: { dates: string[]; ret: number[] }, w: Win): string => { const s = h.st(r, w); return `${f2(s.cagr)} / ${f2(s.mdd)}`; };
  const yrsOf = (w: Win): number => Math.max((Date.parse(w.to > h.dataEnd ? h.dataEnd : w.to) - Date.parse(w.from)) / 86_400_000 / 365.25, 1e-9);

  // ---- 롤링 3년 창 (월말 앵커 36개월, 한 달씩 이동; DS6 기록 대조용 공유 함수) ----
  const ROLL = 36;
  const rollRows = (ret: ArrayLike<number>): { cagrShare: number; mddShare: number; n: number; rows: { start: string; endD: string; c: number; cb: number; m: number; mb: number }[] } => {
    const meSet = new Set(h.monthEnds), anchors: number[] = [];
    for (let i = 0; i < nDays; i++) if (meSet.has(dates0[i])) anchors.push(i);
    const cum = (r: ArrayLike<number>): Float64Array => { const v = new Float64Array(nDays + 1); v[0] = 1; for (let i = 0; i < nDays; i++) v[i + 1] = v[i] * (1 + r[i] / 100); return v; };
    const vb = cum(bRetAxis), vc = cum(ret);
    const mddIn = (v: Float64Array, i0: number, i1: number): number => { let pk = v[i0 + 1], m = 0; for (let t = i0 + 1; t <= i1; t++) { const x = v[t + 1]; if (x > pk) pk = x; m = Math.max(m, 1 - x / pk); } return m * 100; };
    const rows: { start: string; endD: string; c: number; cb: number; m: number; mb: number }[] = [];
    for (let k = 0; k + ROLL < anchors.length; k++) {
      const i0 = anchors[k], i1 = anchors[k + ROLL], yrs = (Date.parse(dates0[i1]) - Date.parse(dates0[i0])) / 86_400_000 / 365.25;
      const cg = (v: Float64Array): number => (Math.pow(v[i1 + 1] / v[i0 + 1], 1 / yrs) - 1) * 100;
      rows.push({ start: dates0[i0], endD: dates0[i1], c: cg(vc), cb: cg(vb), m: mddIn(vc, i0, i1), mb: mddIn(vb, i0, i1) });
    }
    return { cagrShare: (rows.filter((r) => r.c > r.cb).length / rows.length) * 100, mddShare: (rows.filter((r) => r.m < r.mb).length / rows.length) * 100, n: rows.length, rows };
  };

  // =====================================================================================================================
  // 1. 사전 점검 (성과 아님): LV1 재현, 평활 구조, 상한 함수·코어 회계, DS6 일관성
  // =====================================================================================================================
  console.log(`\n=== 1. LV1 재현 확인 (이번 계산의 일별 순수익이 이전 연구 전체 기간 일별 순수익 캐시의 같은 날짜 앞부분과 소수 오차 1e-9 이내로 같아야 한다; 캐시 파일 SHA-256은 연구 ALLOC 사전등록 해시와 같아야 한다) ===`);
  const refDir = process.env.ALLOC_REF_DIR?.trim();
  if (!refDir) throw new Error("ALLOC_REF_DIR(이전 연구 일별 순수익 캐시)가 없다 — 중단하고 보고한다");
  {
    const r = lv1Of(1).run;
    const buf = await fs.readFile(path.join(refDir, "LV1.json"));
    const refSha = sha(buf), okSha = !ALLOC_SERIES_SHA || ALLOC_SERIES_SHA["LV1" as AllocCompId] === refSha;
    const ref = JSON.parse(buf.toString("utf8")) as { dates: string[]; ret: number[] };
    const n = r.dates.length;
    const sameDates = ref.dates.length >= n && r.dates.every((d, k) => ref.dates[k] === d);
    let maxD = 0, nDiff = 0;
    if (sameDates) for (let k = 0; k < n; k++) { const df = Math.abs(r.ret[k] - ref.ret[k]); if (df > 0) nDiff++; maxD = Math.max(maxD, df); }
    console.log(`  LV1: 이번 ${r.dates[0]}~${r.dates[n - 1]} ${n}일 | 날짜 앞부분 ${sameDates ? "일치" : "불일치"} | 값이 다른 날 ${nDiff}일, 최대 차이 ${maxD.toExponential(2)}%p | 캐시 파일 SHA-256 ${refSha} ${okSha ? "(ALLOC 해시와 일치)" : "(ALLOC 해시와 불일치)"}`);
    if (!sameDates || !(maxD <= 1e-9) || !okSha) throw new Error("LV1 재현 불일치 — 중단하고 보고한다");
  }

  console.log(`\n=== 1b. DS8 평활 구조 점검 (성과 아님; 평활 없음 = 기준 LV1, 창 1 = 기준과 비트 동일, 창 ${DS8_SMOOTH_WIN} 배율 = 기준 배율 최근 ${DS8_SMOOTH_WIN}일 중 계산된 날의 단순평균) ===`);
  {
    const r0 = lv1Of(1).run, r1 = lv1Of(1, 1).run, r3 = lv1Of(1, DS8_SMOOTH_WIN).run;
    const same1 = r1.ret.length === r0.ret.length && r1.ret.every((x, i) => x === r0.ret[i]);
    const m0 = r0.mult as number[], m3 = r3.mult as number[];
    let maxDiff = 0, nanMis = 0, nChk = 0, nPartial = 0;
    for (let k = DS8_SMOOTH_WIN - 1; k < m0.length; k++) {
      const win = m0.slice(k - DS8_SMOOTH_WIN + 1, k + 1).filter(Number.isFinite);
      if (Number.isNaN(m0[k]) !== Number.isNaN(m3[k])) { nanMis++; continue; }
      if (!Number.isFinite(m0[k])) continue;
      if (win.length < DS8_SMOOTH_WIN) nPartial++;
      maxDiff = Math.max(maxDiff, Math.abs(m3[k] - win.reduce((a, x) => a + x, 0) / win.length)); nChk++;
    }
    const sameEntries = r3.entryCs.length === r0.entryCs.length && r3.entryCs.every((c, i) => c === r0.entryCs[i]);
    const sameTrades = r3.trades.length === r0.trades.length && r3.trades.every((t, i) => t.code === r0.trades[i].code && t.entryC === r0.trades[i].entryC && t.exitC === r0.trades[i].exitC);
    const fin0 = m0.filter(Number.isFinite), fin3 = m3.filter(Number.isFinite);
    console.log(`  (a) 창 1 일별 수익 = 기준 LV1(비트 동일) ${same1 ? "통과" : "불일치"} | (b) 창 ${DS8_SMOOTH_WIN} 배율 vs 독립 계산: ${nChk}일 최대 차이 ${maxDiff.toExponential(2)}, 계산 여부 불일치 ${nanMis}일, 이력이 창보다 짧아 일부 날만 평균한 날 ${nPartial}일 | (c) 진입 신호일 ${sameEntries ? "기준과 동일" : "기준과 다름"}(${r0.entryCs.length}건 → ${r3.entryCs.length}건), 거래(종목·진입·청산일) ${sameTrades ? "기준과 동일" : "기준과 다름"}(${r0.trades.length}건 → ${r3.trades.length}건) | 배율 계산된 날 ${fin0.length}일, 배율 일간 변화 절대값 평균 기준 ${f2(avg(fin0.slice(1).map((x, i) => Math.abs(x - fin0[i]))))} → 평활 ${f2(avg(fin3.slice(1).map((x, i) => Math.abs(x - fin3[i]))))}`);
    if (!same1 || !(maxDiff <= 1e-12) || nanMis > 0) throw new Error("평활 구조 점검 실패 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)");
  }

  console.log(`\n=== 1c. DS9 상한 비중 함수·코어 회계 점검 (성과 비교 아님) ===`);
  {
    const eq = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-12);
    const t1 = capWeights([0.5, 0.2, 0.15, 0.15], 0.4), t2 = capWeights([0.6, 0.3, 0.05, 0.05], 0.4), t3 = capWeights([0.3, 0.3, 0.2, 0.2], 0.4), t4 = capWeights([5, 3, 1], 0.4);
    const okT = eq(t1, [0.4, 0.24, 0.18, 0.18]) && eq(t2, [0.4, 0.4, 0.1, 0.1]) && eq(t3, [0.3, 0.3, 0.2, 0.2]) && eq(t4, [0.4, 0.4, 0.2]);
    console.log(`  합성 점검: [0.5,0.2,0.15,0.15] 상한 0.4 → [${t1.map((x) => x.toFixed(3)).join(", ")}] (기대 0.4/0.24/0.18/0.18), [0.6,0.3,0.05,0.05] 상한 0.4(재귀 2회) → [${t2.map((x) => x.toFixed(3)).join(", ")}] (기대 0.4/0.4/0.1/0.1), 상한 미만은 그대로 [${t3.map((x) => x.toFixed(3)).join(", ")}], [5,3,1] 상한 0.4 → [${t4.map((x) => x.toFixed(3)).join(", ")}] ${okT ? "통과" : "불일치"}`);
    if (!okT) throw new Error("상한 비중 합성 점검 실패 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)");
    let infeasible = false;
    try { capWeights([1, 1, 1], 0.3); } catch { infeasible = true; }
    if (!infeasible) throw new Error("상한을 지킬 수 없는 입력이 던지지 않았다");
  }
  /** 수준(워터레벨) 이분법 독립 계산: w_i = min(cap, λ·mc_i), 합 1. */
  const waterFill = (mc: number[], cap: number): number[] => {
    let lo = 0, hi = cap / Math.min(...mc);
    for (let k = 0; k < 200; k++) { const mid = (lo + hi) / 2; if (mc.reduce((a, x) => a + Math.min(cap, mid * x), 0) < 1) lo = mid; else hi = mid; }
    return mc.map((x) => Math.min(cap, hi * x));
  };
  /** 코어 구조·회계 점검: 이벤트 없는 구간에서 시뮬레이터 일수익률이 체결 직후 비중 그대로 가격만 따라간 독립 계산과 같은지, 목표 비중이 시총 비율(상한 있으면 독립 계산 상한 적용)과 같은지 본다. */
  const coreCheck = (N: number, capW: number | undefined): void => {
    const r = coreOf(N, capW, 1).run, ret = new Map(r.dates.map((d, i) => [d, r.ret[i]]));
    let maxDiff = 0, nChk = 0, maxTw = 0, maxTwDiff = 0, maxRealDev = 0;
    r.events.forEach((ev, k) => {
      const c0 = ev.c, c1 = k + 1 < r.events.length ? r.events[k + 1].c : nCal, ss = ev.set.map((code) => byCode.get(code) as S);
      const px = (c: number): number[] | null => { const a: number[] = []; for (const s of ss) { const i = s.idx.get(CAL[c]); if (i === undefined) return null; a.push(s.close[i]); } return a; };
      const sumMc = ev.mcv.reduce((a, x) => a + x, 0), expTw = capW === undefined ? ev.mcv.map((x) => x / sumMc) : waterFill(ev.mcv, capW);
      maxTw = Math.max(maxTw, ...ev.tw); maxTwDiff = Math.max(maxTwDiff, ...ev.tw.map((x, j) => Math.abs(x - expTw[j])), Math.abs(ev.tw.reduce((a, x) => a + x, 0) - 1));
      maxRealDev = Math.max(maxRealDev, ...ev.w.map((x, j) => Math.abs(x - ev.tw[j])));
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
    console.log(`  N=${N}${capW === undefined ? "" : ` 상한 ${capW * 100}%`}: 이벤트 ${r.events.length}회(처음 편입 포함, 종목 교체 ${r.events.filter((e) => e.sells.length).length}회) | 폐지 강제 청산 ${r.forcedExit}건 | 거래정지 순연 ${r.haltSkip}건 | 회계 점검 ${nChk}일 독립 계산과 최대 차이 ${maxDiff.toExponential(2)}%p ${maxDiff <= CS_ACCOUNTING_TOL_PP ? "통과" : "불일치"} | 목표 비중 독립 계산(${capW === undefined ? "시총 비율" : "수준 이분법"})과 최대 차이 ${maxTwDiff.toExponential(2)}${capW === undefined ? "" : `, 목표 비중 최대 ${f2(maxTw * 100)}%`} | 체결 직후 실제 비중과 목표 비중의 최대 차이 ${f2(maxRealDev * 100)}%p`);
    if (!(maxDiff <= CS_ACCOUNTING_TOL_PP) || r.forcedExit > 0 || !(maxTwDiff <= 1e-9) || (capW !== undefined && maxTw > capW + 1e-12) || maxRealDev > 0.03) throw new Error(`코어 N=${N} 상한 ${capW ?? "-"} 구조·회계 점검 실패 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)`);
  };
  for (const [N, capW] of [[2, undefined], [DS9_CORE_N, DS9_CORE_CAP], ...DS9_NB_N.map((n) => [n, DS9_CORE_CAP] as const), ...DS9_NB_CAP.map((cp) => [DS9_CORE_N, cp] as const)] as [number, number | undefined][]) coreCheck(N, capW);

  // ---- DS6 기본 계좌 일관성 (DS6 기록: 연속 전체 11.70 / 39.15, 구간 1 4.10 / 24.51, 롤링 창 CAGR 우위 92.81%·MDD 우위 32.03%) ----
  const b6 = build(DS6D);
  {
    // 기록 4.10 / 24.51은 CAGR 기간을 연말 휴장일 2016-12-30까지로 센 값(연구 DS6 시험 272·후속 진단과 같은 계산)이다. 사용자 지정 구간 1 끝(2016-12-29)으로 세면 같은 일별 수익에서 CAGR이 4.11이 된다(MDD 같음).
    const sF = h.st(b6.res.run, FULL), s1 = h.st(b6.res.run, { from: FULL.from, to: "2016-12-30" }), s1b = h.st(b6.res.run, NW[0][1]);
    const rr = rollRows(b6.res.run.ret);
    const ok = f2(sF.cagr) === f2(DS89_DS6_REF.전체[0]) && f2(sF.mdd) === f2(DS89_DS6_REF.전체[1]) && f2(s1.cagr) === f2(DS89_DS6_REF.구간1[0]) && f2(s1.mdd) === f2(DS89_DS6_REF.구간1[1]) && f2(rr.cagrShare) === f2(DS89_DS6_REF.rollCagrShare) && f2(rr.mddShare) === f2(DS89_DS6_REF.rollMddShare);
    console.log(`\nDS6 기본 계좌 일관성: 연속 전체 ${f2(sF.cagr)} / ${f2(sF.mdd)} (기록 ${DS89_DS6_REF.전체.join(" / ")}), 구간 1(기록과 같은 CAGR 기간 ${FULL.from}~2016-12-30) ${f2(s1.cagr)} / ${f2(s1.mdd)} (기록 ${DS89_DS6_REF.구간1.join(" / ")}; 사용자 지정 끝 ${NW[0][1].to}로 세면 ${f2(s1b.cagr)} / ${f2(s1b.mdd)}), 롤링 3년 창 ${rr.n}개 중 069500보다 CAGR 높은 창 ${f2(rr.cagrShare)}% (기록 ${DS89_DS6_REF.rollCagrShare}%) · MDD 작은 창 ${f2(rr.mddShare)}% (기록 ${DS89_DS6_REF.rollMddShare}%) → ${ok ? "일치" : "불일치"}`);
    if (!ok) throw new Error("DS6 기록과 다르다 — 중단하고 보고한다");
  }
  if (REPRO) {
    console.log(`\n사전 점검 종료: LV1 재현, DS8 평활 구조 점검, DS9 상한 함수·코어 회계 점검(N=2/3/4/5, 상한 30/40/50%), DS6 기본 계좌 일관성(연속 전체 11.70 / 39.15, 구간 1 4.10 / 24.51, 롤링 92.81% / 32.03%) 통과. DS8·DS9 성과는 계산·출력하지 않았다 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    return;
  }

  // =====================================================================================================================
  // 2. 시험 (후보 1개, 게이트 A~H)
  // =====================================================================================================================
  const hVs = (full: { cagr: number; mdd: number }, rb: { cagr: number; mdd: number }): { ok: boolean; text: string } => {
    const dc = full.cagr - rb.cagr, dm = rb.mdd - full.mdd;
    const c1 = dc >= PEAD_H_CAGR_GAIN_PP, c2 = dm >= PEAD_H_MDD_GAIN_PP && dc >= -PEAD_H_CAGR_FLOOR_PP;
    return { ok: c1 || c2, text: `CAGR ${dc >= 0 ? "+" : ""}${f2(dc)}%p, MDD ${dm >= 0 ? "−" : "+"}${f2(Math.abs(dm))}%p(개선 ${f2(dm)}%p; ${PEAD_H_MDD_GAIN_STRONG_PP}%p 이상 ${dm >= PEAD_H_MDD_GAIN_STRONG_PP ? "O" : "X"}) → 조건1(CAGR +${PEAD_H_CAGR_GAIN_PP}%p) ${c1 ? "O" : "X"}, 조건2(MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p) ${c2 ? "O" : "X"}` };
  };
  /** 게이트 F: LV1 무작위 대조(같은 신호일·주문 수, 같은 청산 규칙, 시드·횟수 고정) — 평활 설정마다 따로 만든다. */
  const randCache = new Map<string, { full: Float64Array; k0: number }[]>();
  const randOf = (smooth?: number): { full: Float64Array; k0: number }[] => {
    const key = `${smooth ?? "-"}`;
    let a = randCache.get(key);
    if (!a) {
      const base = lv1Of(1, smooth).run, ob = new Map<number, number>();
      for (const c of base.entryCs) ob.set(c - 1, (ob.get(c - 1) ?? 0) + 1);
      const rng = mulberry32(KSS_R3_SEED);
      a = [];
      for (let k = 0; k < KSS_R3_DRAWS; k++) { const r = randLV1(rng, ob, smooth); a.push({ full: Float64Array.from(r.ret), k0: r.dates.findIndex((dd) => dd >= FULL.from) }); }
      randCache.set(key, a);
      console.log(`  [F] LV1${smooth === undefined ? "" : ` 평활 ${smooth}일`} 무작위 대조 ${KSS_R3_DRAWS}회 준비(${((Date.now() - T0) / 60000).toFixed(1)}분 경과)`);
    }
    return a;
  };
  const quant = (v: number[], p: number): number => { const a = [...v].sort((x, y) => x - y); return a[Math.min(Math.floor(a.length * p), a.length - 1)]; };
  const share = (n: number, m: number): string => `${n}/${m} (${f2((n / Math.max(m, 1)) * 100)}%)`;

  const mkSpec = (d: Def, nbs: { label: string; run: () => SimRun }[], notes: string[], extra: (run: SimRun, base: Built) => void): CandSpec => {
    let drawK = 0;
    const base = build(d);
    return {
      id: d.id, trial: d.trial,
      title: `${d.id}: 코어 ${Math.round(d.wC * 100)}% = 월말 K200P 안 당일 시총 상위 ${d.coreN}종목 시총 비율${d.capW === undefined ? "" : `(코어 안 종목당 상한 ${d.capW * 100}%, 초과분은 나머지에 시총 비례 재배분)`}·교체 순위 밖 ${CS_SWAP_CONFIRM_DAYS}거래일 연속일 때만 / 위성 ${Math.round((1 - d.wC) * 100)}% = LV1 단독${d.smooth === undefined ? "" : `(일별 목표 배율 최근 ${d.smooth}거래일 단순평균)`} / 일별 목표 비중 리밸 이동 비용 ${CS_MOVE_COST * 100}%`,
      defense: false, capFrac: 1 / 10, fDenominator: DS89_F_DENOMINATOR, ref: { id: "069500", run: bhAsRun },
      hRule: (full, rb) => { const a = hVs(full, rb); return { ok: a.ok, note: `[사전등록: 069500만 판정] 069500 ${f2(rb.cagr)} / ${f2(rb.mdd)} → ${a.ok ? "O" : "X"} (${a.text})` }; },
      run: (o) => {
        const repl = !!o.replace, b = repl ? build(d, { replSat: true }) : build(d, { coreLag: o.lag, satLag: o.lag });
        const r: SimRun = { ...b.res.run }, sat = b.satX.run, core = b.coreX.run;
        r.trades = [...sat.trades.map((t) => ({ ...t, vAtEntry: t.vAtEntry / (1 - d.wC) })), ...core.trades.map((t) => ({ ...t, vAtEntry: t.vAtEntry / d.wC }))];
        r.entryCs = [...sat.entryCs, ...core.entryCs]; r.haltSkip = sat.haltSkip + core.haltSkip; r.exitDefer = sat.exitDefer + core.exitDefer;
        return r;
      },
      neighbors: nbs,
      random: () => {
        const dr = randOf(d.smooth)[drawK++ % KSS_R3_DRAWS];
        return combineCS(base.coreX.sl, { ...zeroSl, ret: Array.from(dr.full.subarray(dr.k0)) }, d.wC, CS_MOVE_COST).run;
      },
      reasons: [], label,
      extra: (run) => {
        for (const n of notes) console.log(n);
        console.log(`${d.id} 게이트 C 해석(사전등록, DS7과 같음): 코어·LV1 체결을 모두 하루 지연(lag 2)해 같은 합성 규칙으로 돌린다(코어-위성 리밸 이동 자체는 지연하지 않음). CAGR 하락 ≤ 1%p ∧ MDD 악화 ≤ 2%p.`);
        console.log(`${d.id} 게이트 E 해석(사전등록): 판정은 LV1의 평가 구간 닫힌 거래 중 손익 상위 3개를 069500 수익률로 바꾼 위성 + 실제 코어를 같은 합성 규칙으로 돌린 연속 전체 CAGR ≥ 069500. 코어 상위 3개·둘 다 대체는 보고만.`);
        console.log(`${d.id} 게이트 F 해석(사전등록): LV1 무작위 대조(같은 신호일·주문 수, 같은 청산 규칙${d.smooth === undefined ? "" : `, 같은 평활 ${d.smooth}일`}, 시드 ${KSS_R3_SEED}, ${KSS_R3_DRAWS}회)를 실제 코어(고정)와 40:60으로 합성한 분포 대비 ${d.id} 실제 CAGR의 백분위 ≥ 95.`);
        console.log(`${d.id} 게이트 G: 진입 건수 = LV1 진입 + 코어 진입의 합(연속 구간 전체; LV1 ${base.satX.run.entryCs.filter((c) => CAL[c] >= FULL.from).length} + 코어 ${base.coreX.run.entryCs.filter((c) => CAL[c] >= FULL.from).length}).`);
        console.log(`${d.id} 게이트 H 해석(사전등록): 기준선 069500만 판정(CAGR +${PEAD_H_CAGR_GAIN_PP}%p, 또는 MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p).`);
        // ---- 보고 1: DS6 대비 ----
        const ds6 = b6.res.run;
        console.log(`\n=== ${d.id} vs DS6 vs 069500 (CAGR % / MDD %; DS6 기록: 연속 전체 ${DS89_DS6_REF.전체.join(" / ")}, 구간 1 ${DS89_DS6_REF.구간1.join(" / ")}) ===\n| 구간 | 069500 | DS6 | ${d.id} | ${d.id} − DS6 CAGR %p | ${d.id} − DS6 MDD %p | ${d.id} − 069500 CAGR %p | ${d.id} − 069500 MDD %p |\n|---|---|---|---|---|---|---|---|`);
        for (const [wn, w] of W.ALL) {
          const a = h.st(h.bhP, w), s6 = h.st(ds6, w), sc = h.st(run, w);
          console.log(`| ${wn} | ${f2(a.cagr)} / ${f2(a.mdd)} | ${f2(s6.cagr)} / ${f2(s6.mdd)} | ${f2(sc.cagr)} / ${f2(sc.mdd)} | ${sg(sc.cagr - s6.cagr)} | ${sg(sc.mdd - s6.mdd)} | ${sg(sc.cagr - a.cagr)} | ${sg(sc.mdd - a.mdd)} |`);
        }
        console.log(`구간별 최악 12개월 %: ${W.ALL.map(([wn, w]) => `${wn} — 069500 ${f2(h.worst12(h.bhP, w))}, DS6 ${f2(h.worst12({ dates: dates0, ret: ds6.ret }, w))}, ${d.id} ${f2(h.worst12(run, w))}`).join(" | ")}`);
        // ---- 보고 2: 연도별 ----
        {
          const years: number[] = [];
          for (let y = Number(FULL.from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) years.push(y);
          console.log(`\n=== 연도별 수익률 % (일수익률 복리; ${years[0]}년은 ${FULL.from}부터, ${years[years.length - 1]}년은 ${h.dataEnd}까지) ===\n| 연도 | 069500 | DS6 | ${d.id} | ${d.id} − 069500 %p | ${d.id} − DS6 %p |\n|---|---|---|---|---|---|`);
          const ex: number[] = [];
          for (const y of years) {
            const a = h.yearRet({ dates: dates0, ret: bRetAxis }, y), c6 = h.yearRet({ dates: dates0, ret: ds6.ret }, y), cc = h.yearRet({ dates: dates0, ret: run.ret }, y);
            ex.push(cc - a);
            console.log(`| ${y} | ${f2(a)} | ${f2(c6)} | ${f2(cc)} | ${sg(cc - a)} | ${sg(cc - c6)} |`);
          }
          console.log(`${d.id} − 069500 승·패 연수: 승 ${ex.filter((x) => x > 0).length} / 패 ${ex.filter((x) => x < 0).length} (평균 ${sg(avg(ex))}%p, 중앙값 ${sg(median(ex))}%p)`);
        }
        // ---- 보고 3: 롤링 3년 창 (DS6과 나란히) ----
        {
          const r6 = rollRows(ds6.ret), rc = rollRows(run.ret);
          console.log(`\n=== 롤링 3년 창(월말 앵커 36개월 창을 한 달씩 이동, 창 ${rc.n}개, 서로 겹침; 첫 창 ${rc.rows[0].start}~${rc.rows[0].endD}, 마지막 창 ${rc.rows[rc.n - 1].start}~${rc.rows[rc.n - 1].endD}) — DS6 기록: CAGR 우위 ${DS89_DS6_REF.rollCagrShare}% · MDD 우위 ${DS89_DS6_REF.rollMddShare}% ===`);
          for (const [nm, rr] of [["DS6", r6], [d.id, rc]] as const) {
            const ex = rr.rows.map((r) => r.c - r.cb), md = rr.rows.map((r) => r.m - r.mb);
            console.log(`${nm}: 069500보다 CAGR 높은 창 ${share(rr.rows.filter((r) => r.c > r.cb).length, rr.n)} | 초과수익 %p 최소 ${sg(Math.min(...ex))} / 25% ${sg(quant(ex, 0.25))} / 중앙값 ${sg(median(ex))} / 75% ${sg(quant(ex, 0.75))} / 최대 ${sg(Math.max(...ex))} / 평균 ${sg(avg(ex))} | 창 안 MDD가 069500보다 작은 창 ${share(rr.rows.filter((r) => r.m < r.mb).length, rr.n)} (MDD 차 중앙값 ${sg(median(md))}%p, 최소 ${sg(Math.min(...md))}, 최대 ${sg(Math.max(...md))}) | 둘 다 ${share(rr.rows.filter((r) => r.c > r.cb && r.m < r.mb).length, rr.n)} | 둘 다 아님 ${share(rr.rows.filter((r) => !(r.c > r.cb) && !(r.m < r.mb)).length, rr.n)} | 롤링 CAGR 최소 ${f2(Math.min(...rr.rows.map((r) => r.c)))} / 중앙값 ${f2(median(rr.rows.map((r) => r.c)))} / 최대 ${f2(Math.max(...rr.rows.map((r) => r.c)))}`);
          }
          console.log(`창 시작 연도별(CAGR 우위 / MDD 우위 창 수):\n| 시작 연도 | 창 수 | CAGR 우위 DS6 | CAGR 우위 ${d.id} | MDD 우위 DS6 | MDD 우위 ${d.id} |\n|---|---|---|---|---|---|`);
          for (const y of [...new Set(rc.rows.map((r) => r.start.slice(0, 4)))].sort()) {
            const i6 = r6.rows.filter((r) => r.start.startsWith(y)), ic = rc.rows.filter((r) => r.start.startsWith(y));
            console.log(`| ${y} | ${ic.length} | ${share(i6.filter((r) => r.c > r.cb).length, i6.length)} | ${share(ic.filter((r) => r.c > r.cb).length, ic.length)} | ${share(i6.filter((r) => r.m < r.mb).length, i6.length)} | ${share(ic.filter((r) => r.m < r.mb).length, ic.length)} |`);
          }
        }
        // ---- 보고 4: 평균 투자 비중·회전율·비용 (DS6과 나란히) ----
        {
          const bb = build(d), s6all = b6.res;
          console.log(`\n=== 투자 비중·회전·비용 (DS6 → ${d.id}) ===\n| 구간 | 평균 투자 비중 % | 연 회전율 % | 비용 합계 % (일별 비용 합) | 코어-위성 리밸 이동 금액 연 % | 리밸 비용 연 %p |\n|---|---|---|---|---|---|`);
          for (const [wn, w] of W.ALL) {
            const idx: number[] = [];
            for (let i = 0; i < nDays; i++) if (dates0[i] >= w.from && dates0[i] <= (w.to > h.dataEnd ? h.dataEnd : w.to)) idx.push(i);
            const yr = yrsOf(w), s6 = h.st(ds6, w), sc = h.st(run, w);
            const mv6 = idx.reduce((a, i) => a + s6all.moved[i], 0) * 100 / yr, mvc = idx.reduce((a, i) => a + bb.res.moved[i], 0) * 100 / yr, cs6 = idx.reduce((a, i) => a + s6all.cost[i], 0) * 100 / yr, csc = idx.reduce((a, i) => a + bb.res.cost[i], 0) * 100 / yr;
            console.log(`| ${wn} | ${f2(s6.avgInv)} → ${f2(sc.avgInv)} | ${f2(s6.turnover)} → ${f2(sc.turnover)} | ${f2(s6.cost)} → ${f2(sc.cost)} | ${f2(mv6)} → ${f2(mvc)} | ${f2(cs6)} → ${f2(csc)} |`);
          }
        }
        // ---- 보고 5: E 보고 ----
        {
          const full = h.st(run, FULL), bh = h.st(h.bhP, FULL);
          const satRep = h.st(build(d, { replSat: true }).res.run, FULL), coreRep = h.st(build(d, { replCore: true }).res.run, FULL), bothRep = h.st(build(d, { replSat: true, replCore: true }).res.run, FULL);
          console.log(`${d.id} E 보고 [위성 대체만 판정]: 원래 ${f2(full.cagr)} / ${f2(full.mdd)} | LV1 상위 3개 거래 대체 ${f2(satRep.cagr)} / ${f2(satRep.mdd)} (판정, 기준 ${f2(bh.cagr)}) | 코어 상위 3개 거래 대체 ${f2(coreRep.cagr)} / ${f2(coreRep.mdd)} (보고) | 둘 다 대체 ${f2(bothRep.cagr)} / ${f2(bothRep.mdd)} (보고)`);
          const lvT = [...lv1ReplSet(d.smooth)].map((k) => { const [code, ec] = k.split("|"); const t = base.satX.run.trades.find((x) => x.code === code && x.entryC === Number(ec)) as SimTrade; return `${label(code)} ${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`; });
          const ct = coreTradesAll(base.coreX.run).sort((a, c2) => pnlOf(c2) - pnlOf(a)).slice(0, F_E_TOP_TRADES);
          console.log(`  LV1 대체 거래: [${lvT.join(", ")}]`);
          console.log(`  코어 상위 3개 거래(기간 끝에 열린 보유 포함, 코어 계좌 대비 손익 순): ${ct.map((t) => `${label(t.code)} ${CAL[t.entryC]}~${CAL[t.exitC]}${t.reason === "기간 끝 평가" ? "(보유 중)" : ""} 수익률 ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")}`);
        }
        extra(run, base);
      },
    };
  };

  // ---- DS8 ----
  const ds8Extra = (run: SimRun, base: Built): void => {
    void run;
    // 진단 1: 구간별 하루 지연 분해 (코어만 / LV1만 / 리밸만 / 전부), DS6과 DS8 나란히
    const variants: [string, Opts][] = [
      ["기준(지연 없음)", {}],
      ["코어만 하루 지연", { coreLag: 2 }],
      ["LV1만 하루 지연", { satLag: 2 }],
      ["코어-위성 리밸 이동만 하루 지연", { delay: 1 }],
      ["코어+LV1 (= 게이트 C)", { coreLag: 2, satLag: 2 }],
      ["코어+LV1+리밸 이동 (전부)", { coreLag: 2, satLag: 2, delay: 1 }],
    ];
    for (const dd of [DS6D, DS8D]) {
      console.log(`\n=== 진단 [판정 불사용] ${dd.id} 하루 지연 분해 (CAGR % / MDD %, 변화 %p; 구간별 CAGR 변화) ===\n| 지연 적용 대상 | 연속 전체 | CAGR 변화 | MDD 변화 | ${NW.map(([n]) => n).join(" CAGR 변화 | ")} CAGR 변화 |\n|---|---|---|---|${NW.map(() => "---").join("|")}|`);
      const b0 = build(dd).res.run, s0 = h.st(b0, FULL);
      for (const [nm, o] of variants) {
        const r = Object.keys(o).length === 0 ? b0 : build(dd, o).res.run, s = h.st(r, FULL), first = Object.keys(o).length === 0;
        console.log(`| ${nm} | ${f2(s.cagr)} / ${f2(s.mdd)} | ${first ? "-" : sg(s.cagr - s0.cagr)} | ${first ? "-" : sg(s.mdd - s0.mdd)} | ${NW.map(([, w]) => (first ? "-" : sg(h.st(r, w).cagr - h.st(b0, w).cagr))).join(" | ")} |`);
      }
    }
    // 진단 2: 평활 전후 LV1 이동 금액·비용
    const l0 = lv1Of(1), l3 = lv1Of(1, DS8_SMOOTH_WIN);
    console.log(`\n=== 진단 [판정 불사용] 평활 전후 LV1(위성 단독 계좌 기준) 이동 금액·비용 — 이동 금액 = 매수+매도 금액의 절반을 일별 합산한 연 회전율(계좌 대비 %), 비용은 일별 비용 합 ===\n| 구간 | LV1 CAGR / MDD 평활 전 → 후 | 연 회전율 % 전 → 후 | 비용 합계 % 전 → 후 | 연 비용 %p 전 → 후 | 크기 조정 체결 연 횟수 전 → 후 | 배율 계산일 평균 배율 전 → 후 |\n|---|---|---|---|---|---|---|`);
    for (const [wn, w] of W.ALL) {
      const a = h.st(asRun(l0.sl), w), b2 = h.st(asRun(l3.sl), w), yr = yrsOf(w), wt = w.to > h.dataEnd ? h.dataEnd : w.to;
      const rb0 = (l0.run.rebal ?? []).filter((x) => x.d >= w.from && x.d <= wt).length, rb3 = (l3.run.rebal ?? []).filter((x) => x.d >= w.from && x.d <= wt).length;
      const mm = (r: SimRun): number => avg((r.mult ?? []).filter((x, i) => Number.isFinite(x) && r.dates[i] >= w.from && r.dates[i] <= wt));
      console.log(`| ${wn} | ${f2(a.cagr)} / ${f2(a.mdd)} → ${f2(b2.cagr)} / ${f2(b2.mdd)} | ${f2(a.turnover)} → ${f2(b2.turnover)} | ${f2(a.cost)} → ${f2(b2.cost)} | ${f2(a.cost / yr)} → ${f2(b2.cost / yr)} | ${f2(rb0 / yr)} → ${f2(rb3 / yr)} | ${f2(mm(l0.run))} → ${f2(mm(l3.run))} |`);
    }
    const s6 = b6.res, s8 = base.res, aw = (o: CombOut, f: (i: number) => number): number => avg(dates0.map((_, i) => f(i)));
    void s6; void s8; void aw;
  };

  // ---- DS9 ----
  const ds9Extra = (run: SimRun, base: Built): void => {
    const ds6 = b6.res.run;
    const ch6 = coreHolds(2, undefined), ch9 = coreHolds(DS9_CORE_N, DS9_CORE_CAP);
    const sam = (ch: [string, number][][], i: number): number => ch[i].find(([code]) => code === DS89_SAMSUNG)?.[1] ?? 0;
    console.log(`\n=== 진단 [판정 불사용] 삼성전자 일별 평균 계좌 비중 % (현금 날 포함; ${nDays}일) ===\n| 구간 | DS6 | DS9 | 코어 안 평균 삼성전자 비중 % DS6 → DS9 | DS9 코어 안 삼성전자 비중이 상한(${DS9_CORE_CAP * 100}%)을 넘은 날 비율 | 같은 날 최대 % |\n|---|---|---|---|---|---|`);
    for (const [wn, w] of W.ALL) {
      const idx: number[] = [];
      for (let i = 0; i < nDays; i++) if (dates0[i] >= w.from && dates0[i] <= (w.to > h.dataEnd ? h.dataEnd : w.to)) idx.push(i);
      const over = idx.filter((i) => sam(ch9, i) > DS9_CORE_CAP + 1e-9);
      console.log(`| ${wn} | ${f2(avg(idx.map((i) => b6.res.wCore[i] * sam(ch6, i) * 100)))} | ${f2(avg(idx.map((i) => base.res.wCore[i] * sam(ch9, i) * 100)))} | ${f2(avg(idx.map((i) => sam(ch6, i) * 100)))} → ${f2(avg(idx.map((i) => sam(ch9, i) * 100)))} | ${share(over.length, idx.length)} | ${f2(Math.max(...idx.map((i) => sam(ch9, i) * 100)))} |`);
    }
    // 삼성전자를 코어에서 뺀 경우
    const ex = new Set([DS89_SAMSUNG]);
    const x6 = build(DS6D, { exclude: ex }).res.run, x9 = build(DS9D, { exclude: ex }).res.run;
    console.log(`\n=== 진단 [판정 불사용] 삼성전자를 코어에서 뺀 경우 (코어 순위 목록에서 ${DS89_SAMSUNG} 제외, 나머지 규칙·위성·합성은 같음; 새 후보 아님; CAGR % / MDD %) ===\n| 구간 | 069500 | DS6 | DS6-X (삼성 제외, 상위 2) | DS9 | DS9-X (삼성 제외, 상위 ${DS9_CORE_N}, 상한 ${DS9_CORE_CAP * 100}%) |\n|---|---|---|---|---|---|`);
    for (const [wn, w] of W.ALL) console.log(`| ${wn} | ${cell(h.bhP, w)} | ${cell(ds6, w)} | ${cell(x6, w)} | ${cell(run, w)} | ${cell(x9, w)} |`);
    const sb = h.st(h.bhP, FULL), sx9 = h.st(x9, FULL), s9 = h.st(run, FULL);
    console.log(`DS9-X 연속 전체 ${f2(sx9.cagr)} / ${f2(sx9.mdd)} (069500 대비 CAGR ${sg(sx9.cagr - sb.cagr)}%p, MDD ${sg(sx9.mdd - sb.mdd)}%p; DS9 대비 CAGR ${sg(sx9.cagr - s9.cagr)}%p, MDD ${sg(sx9.mdd - s9.mdd)}%p)`);
    // 코어 단독 성적
    console.log(`\n=== 진단 [판정 불사용] 코어 단독·LV1 단독 성적 (각 계좌 100%로 본 CAGR % / MDD %; 코어는 현금 없이 상위 종목만 보유) ===\n| 구간 | 069500 | LV1 단독 | DS6 코어(상위 2) | DS9 코어(상위 ${DS9_CORE_N}, 상한 ${DS9_CORE_CAP * 100}%) |\n|---|---|---|---|---|`);
    const c6 = coreOf(2, undefined, 1).sl, c9 = coreOf(DS9_CORE_N, DS9_CORE_CAP, 1).sl, l1 = lv1Of(1).sl;
    for (const [wn, w] of W.ALL) console.log(`| ${wn} | ${cell(h.bhP, w)} | ${cell(asRun(l1), w)} | ${cell(asRun(c6), w)} | ${cell(asRun(c9), w)} |`);
    // 코어 구성 이력
    console.log(`\nDS9 코어 구성 이력(월말 K200P 안 당일 시총 상위 ${DS9_CORE_N}종목; 체결일 종목 교체·비중 조정; 대괄호는 체결 직후 코어 안 실제 비중):\n    ${evLine(base.coreX.run)}`);
    console.log(`DS6 코어 구성 이력(비교용, 상위 2종목):\n    ${evLine(coreOf(2, undefined, 1).run)}`);
  };

  const sp = ((): CandSpec => {
    if (MODE === "ds8") {
      return mkSpec(DS8D,
        DS8_NB_WINDOWS.map((win) => ({ label: `평활 창 ${win}일`, run: () => build(DS8D, { smooth: win }).res.run })),
        [
          `DS8 평활 정의(사전등록): LV1의 일별 목표 배율 m(판단일 c 종가에서 보유 유지 종목 + 편입 예정 종목을 동일 비중으로 담았다고 가정한 20일 실현변동성 기준 min(1, 20% ÷ σ), 소수 2자리 반올림; 슬롯당 목표 비중 = 1/5 × m)을 최근 ${DS8_SMOOTH_WIN}거래일(그날 포함) 중 m이 계산된 날의 단순평균으로 바꾼다. 신규 편입 크기와 크기 조정 판단(실제 배율과 0.2 이상 차이)에 이 평균을 쓴다. 진입·청산 신호(앙상블 순위), 체결 규칙, 코어, 비용은 그대로.`,
          `DS8 게이트 D 해석(사전등록): 이웃 2개 — 평활 창 ${DS8_NB_WINDOWS.join("일·")}일(나머지는 기본값). 연속 전체 CAGR ≥ 069500 CAGR이어야 통과, 하나라도 미만이면 탈락.`,
        ], ds8Extra);
    }
    return mkSpec(DS9D,
      [
        ...DS9_NB_N.map((n) => ({ label: `코어 상위 ${n}종목 (상한 ${DS9_CORE_CAP * 100}%)`, run: () => build(DS9D, { N: n }).res.run })),
        ...DS9_NB_CAP.map((cp) => ({ label: `종목당 상한 ${cp * 100}% (상위 ${DS9_CORE_N}종목)`, run: () => build(DS9D, { capW: cp }).res.run })),
        ...[-CS_CORE_W_NEIGHBOR, CS_CORE_W_NEIGHBOR].map((dw) => ({ label: `코어 비중 ${Math.round((DS89_CORE_W + dw) * 100)}% (위성 ${Math.round((1 - DS89_CORE_W - dw) * 100)}%)`, run: () => build(DS9D, { wC: DS89_CORE_W + dw }).res.run })),
      ],
      [
        `DS9 상한 정의(사전등록): 코어 목표 비중은 DS6과 같은 시점(처음 편입, 종목 교체·채움 체결일)에만 신호일 시총 비율로 정하되, 한 종목이 ${DS9_CORE_CAP * 100}%를 넘으면 ${DS9_CORE_CAP * 100}%로 고정하고 초과분을 나머지 종목에 시총 비례로 다시 나눈다(넘는 종목이 새로 생기면 반복). 체결 사이에는 DS6처럼 가격 변동 그대로 두므로 가격 상승으로 상한을 넘은 종목을 매일 되돌리지 않는다. 교체 규칙: 보유 종목이 상위 ${DS9_CORE_N}위 밖에 ${CS_SWAP_CONFIRM_DAYS}거래일 연속 머물 때만. 위성·합성·비용은 그대로.`,
        `DS9 게이트 D 해석(사전등록): 이웃 6개 — 코어 상위 ${DS9_NB_N.join("·")}종목(상한 ${DS9_CORE_CAP * 100}%), 종목당 상한 ${DS9_NB_CAP.map((x) => x * 100).join("%·")}%(상위 ${DS9_CORE_N}종목), 코어 비중 30%·50%(각각 나머지는 기본값). 연속 전체 CAGR ≥ 069500 CAGR이어야 통과, 하나라도 미만이면 탈락.`,
      ], ds9Extra);
  })();

  const verdicts: Verdict[] = [evaluate(h, W, sp)];
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: sp.trial - 1, contamNote: W.contamNote });
  console.log(`DS6 기록(참고, 연속 전체): ${DS89_DS6_REF.전체.join(" / ")}, 구간 1 ${DS89_DS6_REF.구간1.join(" / ")}, 롤링 CAGR 우위 ${DS89_DS6_REF.rollCagrShare}% · MDD 우위 ${DS89_DS6_REF.rollMddShare}% — 위 비교 표 참조`);
  console.log(`사전 고지: ${sp.id}는 DS6 결과를 본 뒤 만든 변형이다(선택 편향). 평가 구간 전체가 DS6·DS4·LV1 등 선행 연구에서 반복해 본 데이터라 구간이 오염돼 있다. 누적 ${sp.trial}번 기준 우연 통과 기대 ${sp.trial} × 0.05 = ${(sp.trial * 0.05).toFixed(2)}개. 삼성전자 의존: 코어 상위 종목에 삼성전자가 대부분의 기간 포함된다. 두 시험(DS8, DS9) 중 통과하는 쪽이 있어도 독립 확인 전에는 후보일 뿐이다.`);
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ") || "없음"} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${verdicts.map((v) => v.trial).join(", ")}`);
  void membAt; void excluded; void SLIPPAGE_PCT_PER_SIDE; void DS89_PRIOR_TESTS; void CS_RANK_DEPTH; void L_EVAL_AFTER;
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

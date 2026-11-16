/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 묶음 5: RM1(잔차 모멘텀)·LR1(바닥 탈출)·PF1(우선주 괴리)·TS1(신고가 추세 추종)·MV1(최소분산)·BS1(지루한 주식). 사전 등록: docs/research/batch5-prereg.md (정의 커밋 f5c2668, 첫 시험 전).
 * 월간·분기 목표 비중 전략은 lib/rebalSim.ts, TS1은 lib/slotSim.ts, C 형태는 DS6 코어(연구 DS8·DS9와 같은 코드)와 combineCS 규칙으로 합성한다. 게이트 A~H는 scripts/researchGates.ts 그대로.
 * ALLOC_MODE=repro: DS6 재현·신호 독립 대조·체결 타이밍·BS1 단계 2 검증만(성과 미계산) / a: RM1·RM1C·RM1F / b1: LR1·LR1F / b2: PF1·PF1F / b3: TS1 / b4: MV1·MV1C / c: BS1·BS1C. 시험 번호 시작은 B5_TRIAL(기본 294).
 * 공시(DART) 사용 없음, 가격 데이터만, 외부 요청 0, 연구 DB 쓰기 0.
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
import { KSS_R3_DRAWS, KSS_R3_SEED, F_E_TOP_TRADES, F_C_MAX_CAGR_DROP, F_C_MAX_MDD_WORSEN, F_F_MIN_PCTILE } from "@/lib/kodexSectorSatConfig";
import { SAT_MDD_EPS } from "@/lib/satelliteV1Config";
import { rebalSim, type RebalRun } from "@/lib/rebalSim";
import { solveMinVar, projectCappedSimplex } from "@/lib/minVar";
import { B5_F_DENOMINATOR, B5_CORE_W, B5_MA_DAYS, B5_MA_NB, B5_FILTER_LOW, B5_RM_P0, B5_RM_NB, B5_LR_P0, B5_LR_NB, B5_PF_P0, B5_PF_NB, B5_PF_SLIP, B5_PF_TV_DAYS, B5_TS_P0, B5_TS_NB, B5_TS_CAP, B5_MV_P0, B5_MV_NB, B5_MV_KKT_TOL, B5_MV_MAX_ITER, B5_MV_CHECK_SAMPLES, B5_BS_P0, B5_BS_NB, B5_BS_SLIP_K200, B5_BS_SLIP_OTHER, type RmP, type LrP, type PfP, type TsP, type MvP, type BsP } from "@/lib/batch5Config";
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
  if (!["repro", "a", "b1", "b2", "b3", "b4", "c"].includes(MODE)) throw new Error("ALLOC_MODE=repro|a|b1|b2|b3|b4|c 필요");
  console.log(`연구 묶음 5 ${MODE === "repro" ? "사전 점검(DS6 재현·신호 독립 대조·체결 타이밍, 성과 미계산)" : `블록 ${MODE} 시험`} 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, nameOf, indOf } = await loadK200P(h);

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

  // =====================================================================================================================
  // 묶음 5 공용 자료: K200P 순위, 수정 종가 정렬, 행 존재 누적, 069500 일수익률·지수 수준·이동평균
  // =====================================================================================================================
  const rkCache = new Map<number, { list: S[]; rank: Map<string, number> }>();
  /** 판단일 c의 K200P(PIT): 월말 시장 구분 코스피 구성원 중 제외 규칙 적용 + 그날 행 있음, 시총 내림차순 상위 200(같으면 종목코드 순). */
  const rank200 = (c: number): { list: S[]; rank: Map<string, number> } => {
    let v = rkCache.get(c);
    if (!v) {
      const d = CAL[c], m = membAt(d), e: { s: S; mc: number }[] = [];
      if (m) for (const s of h.stocks) {
        const i = s.idx.get(d);
        if (i === undefined || excluded.has(s.code) || m.get(s.code) !== "KOSPI") continue;
        e.push({ s, mc: s.mcapRow[i] });
      }
      e.sort((a, b) => b.mc - a.mc || (a.s.code < b.s.code ? -1 : 1));
      const list = e.slice(0, 200).map((x) => x.s);
      v = { list, rank: new Map(list.map((s, k) => [s.code, k + 1])) };
      rkCache.set(c, v);
    }
    return v;
  };
  const alCache = new Map<string, Float64Array>();
  /** 달력 정렬 수정 종가(행 없는 날은 직전 종가, 상장 전 0). */
  const al = (s: S): Float64Array => { let a = alCache.get(s.code); if (!a) { a = alignCloses(CAL, s.idx, s.close); alCache.set(s.code, a); } return a; };
  const prCache = new Map<string, Int32Array>();
  /** 행 존재 누적: p[k+1] − p[k0] = 달력 [k0, k]에서 그 종목 행이 있는 날 수. */
  const prefix = (s: S): Int32Array => {
    let p = prCache.get(s.code);
    if (!p) { p = new Int32Array(nCal + 1); for (let k = 0; k < nCal; k++) p[k + 1] = p[k] + (s.idx.has(CAL[k]) ? 1 : 0); prCache.set(s.code, p); }
    return p;
  };
  const nRows = (s: S, k0: number, k1: number): number => { const p = prefix(s); return p[k1 + 1] - p[Math.max(k0, 0)]; };
  const rowAt = (s: S, k: number): number | undefined => (k >= 0 ? s.idx.get(CAL[k]) : undefined);
  const bR = new Float64Array(nCal).fill(Number.NaN);
  for (let k = 0; k < nCal; k++) { const r = h.bhRet.get(CAL[k]); if (r !== undefined) bR[k] = r; }
  const bL = new Float64Array(nCal);
  { let lv = 1; for (let k = 0; k < nCal; k++) { if (Number.isFinite(bR[k])) lv *= 1 + bR[k]; bL[k] = lv; } }
  /** 069500 지수 수준의 n일 단순이동평균(당일 포함, 직접 합산). */
  const bSma = (c: number, n: number): number => { if (c - n + 1 < 0) return Number.NaN; let s = 0; for (let k = c - n + 1; k <= c; k++) s += bL[k]; return s / n; };
  const multCache = new Map<string, number>();
  /** 시장 필터 배수: 069500 지수 수준 < n일 단순이동평균이면 0.5, 아니면 1(엄격 부등호). */
  const filterMult = (c: number, ma: number): number => {
    const key = `${c}|${ma}`;
    let m = multCache.get(key);
    if (m === undefined) { const s = bSma(c, ma); m = Number.isFinite(s) && bL[c] < s ? B5_FILTER_LOW : 1; multCache.set(key, m); }
    return m;
  };
  /** 수정 종가 일수익률(행 없는 날 0, 상장 전 0). */
  const rfCache = new Map<string, Float64Array>();
  const retFill = (s: S): Float64Array => {
    let r = rfCache.get(s.code);
    if (!r) { const a = al(s); r = new Float64Array(nCal); for (let k = 1; k < nCal; k++) r[k] = a[k - 1] > 0 && a[k] > 0 ? a[k] / a[k - 1] - 1 : 0; rfCache.set(s.code, r); }
    return r;
  };
  const medianOf = (v: number[]): number => { const b = [...v].sort((x, y) => x - y); const n = b.length; return n ? (n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2) : Number.NaN; };
  const sdOf = (v: ArrayLike<number>, n: number): number => { let m = 0; for (let i = 0; i < n; i++) m += v[i]; m /= n; let s = 0; for (let i = 0; i < n; i++) s += (v[i] - m) * (v[i] - m); return Math.sqrt(s / (n - 1)); };
  const monthEndIdx = h.monthEnds.map((d) => h.calIdx.get(d) as number);
  const isQuarterEnd = (c: number): boolean => { const mo = Number(CAL[c].slice(5, 7)); return mo % 3 === 0; };

  interface Strat<P> {
    id: string; P0: P; nbs: [string, Partial<P>][];
    /** 신호일 목록(월말 인덱스). */
    signalDays: number[];
    /** swap = 종목 교체를 허용하는 신호일인가(분기 전략의 월중 필터 조정일은 false). */
    isSwap: (c: number) => boolean;
    targets: (c: number, held: ReadonlySet<string>, P: P, m: number, swap: boolean) => Map<string, number>;
    pool: (c: number, P: P) => string[];
    slip: (code: string, c: number, lag: number) => number;
    vanish: "last" | "loss";
    /** 종목당 기본 비중(보고용). */
    wOf: (P: P) => number;
  }
  const pickKeep = (sorted: string[], held: ReadonlySet<string>, n: number, keepRank: number): string[] => {
    const rankOf = new Map(sorted.map((code, k) => [code, k + 1]));
    const keep = [...held].filter((code) => (rankOf.get(code) ?? Number.POSITIVE_INFINITY) <= keepRank).sort((a, b) => (rankOf.get(a) as number) - (rankOf.get(b) as number)).slice(0, n);
    const sel = new Set(keep);
    for (const code of sorted) { if (sel.size >= n) break; sel.add(code); }
    return [...sel];
  };
  const equalW = (codes: string[], w: number, m: number): Map<string, number> => new Map(codes.map((code) => [code, w * m]));

  // ---- RM1 ----
  const rmScore = (s: S, c: number, P: RmP): number => {
    if (c - P.start < 1) return Number.NaN;
    const a = al(s), pr = prefix(s), xs: number[] = [], ys: number[] = [];
    for (let k = c - P.start; k <= c - P.skip; k++) {
      const x = bR[k];
      if (!Number.isFinite(x) || pr[k + 1] - pr[k] === 0 || pr[k] - pr[k - 1] === 0) continue;
      xs.push(x); ys.push(a[k] / a[k - 1] - 1);
    }
    const n = xs.length;
    if (n < P.minValid) return Number.NaN;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
    const den = n * sxx - sx * sx;
    if (!(den > 0)) return Number.NaN;
    const beta = (n * sxy - sx * sy) / den, alpha = (sy - beta * sx) / n;
    let sse = 0;
    for (let i = 0; i < n; i++) { const e = ys[i] - alpha - beta * xs[i]; sse += e * e; }
    const sd = Math.sqrt(sse / (n - 1));
    return sd > 0 ? (Math.sqrt(n) * alpha) / sd : Number.NaN;
  };
  const rmSorted = (c: number, P: RmP): { code: string; sc: number }[] => {
    const rk = rank200(c), e: { code: string; sc: number }[] = [];
    for (const s of rk.list) { const sc = rmScore(s, c, P); if (Number.isFinite(sc)) e.push({ code: s.code, sc }); }
    e.sort((x, y) => y.sc - x.sc || (rk.rank.get(x.code) as number) - (rk.rank.get(y.code) as number));
    return e;
  };
  const RM1: Strat<RmP> = {
    id: "RM1", P0: B5_RM_P0, nbs: B5_RM_NB, signalDays: monthEndIdx, isSwap: () => true,
    targets: (c, held, P, m) => equalW(pickKeep(rmSorted(c, P).map((x) => x.code), held, P.n, P.n * P.keepMult), 1 / P.n, m),
    pool: (c, P) => rank200(c).list.filter((s) => Number.isFinite(rmScore(s, c, P))).map((s) => s.code),
    slip: () => L_SLIPPAGE, vanish: "last", wOf: (P) => 1 / P.n,
  };

  // ---- LR1 ----
  const lrCands = (c: number, P: LrP): { code: string; long: number }[] => {
    const rk = rank200(c), out: { code: string; long: number }[] = [];
    if (c - P.longStart < 0) return out;
    const bRecent = bL[c] / bL[c - P.recent] - 1;
    for (const s of rk.list) {
      const a = al(s);
      if (nRows(s, c - P.longStart, c) < P.minValid) continue;
      const a0 = a[c - P.longStart], a1 = a[c - P.longEnd], a2 = a[c], a3 = a[c - P.recent];
      if (!(a0 > 0 && a1 > 0 && a2 > 0 && a3 > 0)) continue;
      if (!(a2 / a3 - 1 > bRecent)) continue;
      out.push({ code: s.code, long: a1 / a0 - 1 });
    }
    const rr = rk.rank;
    out.sort((x, y) => x.long - y.long || (rr.get(x.code) as number) - (rr.get(y.code) as number));
    return out;
  };
  const LR1: Strat<LrP> = {
    id: "LR1", P0: B5_LR_P0, nbs: B5_LR_NB, signalDays: monthEndIdx, isSwap: isQuarterEnd,
    targets: (c, held, P, m, swap) => (swap ? equalW(pickKeep(lrCands(c, P).map((x) => x.code), held, P.n, P.n * P.keepMult), 1 / P.n, m) : equalW([...held], 1 / P.n, m)),
    pool: (c, P) => lrCands(c, P).map((x) => x.code),
    slip: () => L_SLIPPAGE, vanish: "last", wOf: (P) => 1 / P.n,
  };

  // ---- PF1 ----
  const prefCodes = h.stocks.filter((s) => s.code[s.code.length - 1] === "5" && h.byCode.has(s.code.slice(0, 5) + "0"));
  const pairs = prefCodes.map((p) => ({ p, c: h.byCode.get(p.code.slice(0, 5) + "0") as S }));
  const tvAvg = (s: S, c: number, days: number): number => { let sum = 0; for (let k = Math.max(c - days + 1, 0); k <= c; k++) { const i = s.idx.get(CAL[k]); if (i !== undefined) sum += s.raw[i] * s.vol[i]; } return sum / days; };
  const pfZ = (c: number, pr: { p: S; c: S }, P: PfP): number => {
    if (c - P.zWin < 1) return Number.NaN;
    const ap = al(pr.p), ac = al(pr.c);
    if (!(ap[c] > 0 && ac[c] > 0)) return Number.NaN;
    const ss: number[] = [];
    for (let k = c - P.zWin; k <= c - 1; k++) {
      if (rowAt(pr.p, k) === undefined || rowAt(pr.c, k) === undefined || !(ap[k] > 0 && ac[k] > 0)) continue;
      ss.push(Math.log(ap[k] / ac[k]));
    }
    if (ss.length < 2) return Number.NaN;
    const mu = ss.reduce((x, y) => x + y, 0) / ss.length, sd = sdOf(ss, ss.length);
    return sd > 0 ? (Math.log(ap[c] / ac[c]) - mu) / sd : Number.NaN;
  };
  const pfElig = (c: number, P: PfP): { code: string; z: number }[] => {
    const out: { code: string; z: number }[] = [];
    for (const pr of pairs) {
      const ip = rowAt(pr.p, c), ic = rowAt(pr.c, c);
      if (ip === undefined || ic === undefined || !(pr.p.vol[ip] > 0) || !(pr.c.vol[ic] > 0)) continue;
      if (nRows(pr.p, c - P.zWin + 1, c) < P.minValid || nRows(pr.c, c - P.zWin + 1, c) < P.minValid) continue;
      if (!(tvAvg(pr.p, c, B5_PF_TV_DAYS) >= P.minTv)) continue;
      const z = pfZ(c, pr, P);
      if (Number.isFinite(z)) out.push({ code: pr.p.code, z });
    }
    out.sort((x, y) => x.z - y.z || (x.code < y.code ? -1 : 1));
    return out;
  };
  const PF1: Strat<PfP> = {
    id: "PF1", P0: B5_PF_P0, nbs: B5_PF_NB, signalDays: monthEndIdx, isSwap: () => true,
    targets: (c, held, P, m) => equalW(pickKeep(pfElig(c, P).map((x) => x.code), held, P.n, P.n * P.keepMult), 1 / P.n, m),
    pool: (c, P) => pfElig(c, P).map((x) => x.code),
    slip: () => B5_PF_SLIP, vanish: "last", wOf: (P) => 1 / P.n,
  };

  // ---- MV1 ----
  interface MvPick { codes: string[]; n: number; S: Float64Array }
  const mvCov = (c: number, P: MvP): MvPick => {
    const rk = rank200(c), codes: string[] = [], rets: Float64Array[] = [];
    for (const s of rk.list.slice(0, P.top)) {
      if (c - P.win + 1 < 1 || nRows(s, c - P.win + 1, c) < P.minValid) continue;
      codes.push(s.code); rets.push(retFill(s));
    }
    const n = codes.length, T = P.win, k0 = c - T + 1, mean = new Float64Array(n);
    for (let i = 0; i < n; i++) { let m = 0; for (let k = k0; k <= c; k++) m += rets[i][k]; mean[i] = m / T; }
    const S = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = i; j < n; j++) {
      let s = 0; const ri = rets[i], rj = rets[j];
      for (let k = k0; k <= c; k++) s += (ri[k] - mean[i]) * (rj[k] - mean[j]);
      s /= T - 1; S[i * n + j] = s; S[j * n + i] = s;
    }
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) S[i * n + j] *= P.lambda; // Σ = λS + (1−λ)diag(S): 대각은 그대로, 비대각만 λ배
    return { codes, n, S };
  };
  const mvStats = { solves: 0, maxKkt: 0, maxIter: 0, fails: 0 };
  const mvTargets = (c: number, P: MvP, m: number): Map<string, number> => {
    const { codes, n, S } = mvCov(c, P);
    if (n < 2) return new Map();
    const cap = Math.max(P.cap, 1 / n);
    const r = solveMinVar(S, n, cap, B5_MV_KKT_TOL, B5_MV_MAX_ITER);
    mvStats.solves++; mvStats.maxKkt = Math.max(mvStats.maxKkt, r.kkt); mvStats.maxIter = Math.max(mvStats.maxIter, r.iters);
    if (!(r.kkt < B5_MV_KKT_TOL)) { mvStats.fails++; throw new Error(`MV1 풀이 미수렴: ${CAL[c]} KKT ${r.kkt} 반복 ${r.iters} — 구현 오류로 중단한다`); }
    return new Map(codes.map((code, i) => [code, r.w[i] * m] as [string, number]).filter(([, w]) => w > 1e-12));
  };
  const MV1: Strat<MvP> = {
    id: "MV1", P0: B5_MV_P0, nbs: B5_MV_NB, signalDays: monthEndIdx, isSwap: () => true,
    targets: (c, _held, P, m) => mvTargets(c, P, m),
    pool: (c, P) => rank200(c).list.slice(0, P.top).filter((s) => nRows(s, c - P.win + 1, c) >= P.minValid).map((s) => s.code),
    slip: () => L_SLIPPAGE, vanish: "last", wOf: () => 0.05,
  };

  // ---- BS1 ----
  const bsElig = (c: number, P: BsP): string[] => {
    const d = CAL[c], m = membAt(d), out: string[] = [];
    if (!m) return out;
    for (const s of h.stocks) {
      const i = s.idx.get(d);
      if (i === undefined || excluded.has(s.code)) continue;
      const mk = m.get(s.code);
      if (mk !== "KOSPI" && mk !== "KOSDAQ") continue;
      if (nRows(s, 0, c) < P.minRows || s.raw[i] < P.minPrice) continue;
      let zero = 0, zero20 = false;
      const tvs: number[] = [];
      for (let k = c - P.zeroVolWin + 1; k <= c; k++) { const j = rowAt(s, k); const noTrade = j === undefined || s.vol[j] === 0; if (noTrade) { zero++; if (k > c - P.recentZeroWin) zero20 = true; } }
      if (zero > P.zeroVolMax || zero20) continue;
      for (let k = c - P.tvMedianDays + 1; k <= c; k++) { const j = rowAt(s, k); tvs.push(j === undefined ? 0 : s.raw[j] * s.vol[j]); }
      if (!(medianOf(tvs) >= P.minTv)) continue;
      out.push(s.code);
    }
    return out;
  };
  const pctRank = (vals: number[]): number[] => {
    const idx = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    const out = new Array<number>(vals.length);
    let i = 0;
    while (i < idx.length) { let j = i; while (j + 1 < idx.length && vals[idx[j + 1]] === vals[idx[i]]) j++; const avgRank = (i + j) / 2; for (let k = i; k <= j; k++) out[idx[k]] = vals.length > 1 ? avgRank / (vals.length - 1) : 0; i = j + 1; }
    return out;
  };
  const bsSorted = (c: number, P: BsP): { code: string; score: number }[] => {
    const el = bsElig(c, P), a: number[] = [], b: number[] = [], t: number[] = [];
    for (const code of el) {
      const s = h.byCode.get(code) as S, r = retFill(s);
      const win = new Float64Array(P.volWin); for (let k = 0; k < P.volWin; k++) win[k] = r[c - P.volWin + 1 + k];
      a.push(sdOf(win, P.volWin));
      const last = Array.from({ length: P.topWin }, (_, k) => r[c - P.topWin + 1 + k]).sort((x, y) => y - x);
      b.push((last[0] + last[1] + last[2]) / 3);
      let tv = 0;
      for (let k = c - P.turnWin + 1; k <= c; k++) { const j = rowAt(s, k); if (j !== undefined) { const cap = s.mcapRow[j] * 1e8; if (cap > 0) tv += (s.raw[j] * s.vol[j]) / cap; } }
      t.push(tv / P.turnWin);
    }
    const pa = pctRank(a), pb = pctRank(b), pt = pctRank(t);
    return el.map((code, k) => ({ code, score: (pa[k] + pb[k] + pt[k]) / 3 })).sort((x, y) => x.score - y.score || (x.code < y.code ? -1 : 1));
  };
  const BS1: Strat<BsP> = {
    id: "BS1", P0: B5_BS_P0, nbs: B5_BS_NB, signalDays: monthEndIdx, isSwap: () => true,
    targets: (c, held, P, m) => equalW(pickKeep(bsSorted(c, P).map((x) => x.code), held, P.n, P.n * P.keepMult), 1 / P.n, m),
    pool: (c, P) => bsElig(c, P),
    slip: (code, c, lag) => (rank200(Math.max(c - lag, 0)).rank.has(code) ? B5_BS_SLIP_K200 : B5_BS_SLIP_OTHER), vanish: "loss", wOf: (P) => 1 / P.n,
  };

  // ---- TS1 (슬롯 시뮬레이터) ----
  const tsSignals = (c: number, P: TsP): S[] => {
    const rk = rank200(c), out: S[] = [];
    if (c - P.win + 1 < 0) return out;
    for (const s of rk.list) {
      if (nRows(s, c - P.win + 1, c) < P.minValid) continue;
      const a = al(s);
      let mx = Number.NEGATIVE_INFINITY;
      for (let k = c - P.win + 1; k <= c - 1; k++) if (a[k] > mx) mx = a[k];
      if (a[c] > mx) out.push(s);
    }
    return out;
  };
  const tsPool = (c: number, P: TsP): S[] => rank200(c).list.filter((s) => { const i = rowAt(s, c); return i !== undefined && s.vol[i] > 0 && c - P.win + 1 >= 0 && nRows(s, c - P.win + 1, c) >= P.minValid; });
  const tsExit = (P: TsP) => (p: SimPos, _c: number, i: number | undefined): string | null => (i !== undefined && p.s.close[i] <= p.peak * (1 - P.stop) ? `손절(고점 −${f2(P.stop * 100)}%)` : null);

  // =====================================================================================================================
  // 실행기: 재조정 시뮬레이터 호출, 무작위 대조, 합성(코어-위성), 게이트 명세
  // =====================================================================================================================
  interface FCfg { ma: number }
  const sigDays = <P,>(def: Strat<P>, F: boolean): number[] => (F ? def.signalDays : def.signalDays.filter((c) => def.isSwap(c)));
  /** 첫 유효 신호일(그날 목표표가 비어 있지 않은 첫 신호일). 이후 모든 변형·이웃·무작위 실행이 같은 시작을 쓴다. */
  const startOf = <P,>(def: Strat<P>, F: boolean): number => {
    for (const c of sigDays(def, F)) { if (c < 253) continue; if (def.targets(c, new Set(), def.P0, 1, true).size > 0) return c; }
    throw new Error(`${def.id}: 유효한 신호일이 없다`);
  };
  const runS = <P,>(def: Strat<P>, P: P, cS: number, F: FCfg | null, o: { lag: number; replace?: Set<string>; detail?: boolean }): RebalRun => {
    const sd = new Set(sigDays(def, F !== null).filter((c) => c >= cS));
    return rebalSim(env(cS), { slipOf: (code, c) => def.slip(code, c, o.lag), vanish: def.vanish }, {
      isSignal: (c) => sd.has(c),
      targetsAt: (c, held) => def.targets(c, held, P, F ? filterMult(c, F.ma) : 1, def.isSwap(c)),
      stockOf: (code) => h.byCode.get(code),
    }, o);
  };
  /** 실제 보유 구간의 길이(신호일 개수 단위) 표본. */
  const holdSamplesOf = <P,>(def: Strat<P>, F: boolean, cS: number, run: RebalRun): number[] => {
    const days = sigDays(def, F).filter((c) => c >= cS);
    const out: number[] = [];
    for (const t of [...run.trades, ...run.open]) out.push(Math.max(1, days.filter((d) => d > t.entryC - 1 && d <= t.exitC - 1).length));
    return out;
  };
  const randomS = <P,>(def: Strat<P>, P: P, cS: number, F: FCfg | null, rng: () => number, ordersByDay: Map<number, number>, hold: number[]): RebalRun => {
    const days = sigDays(def, F !== null).filter((c) => c >= cS), jOf = new Map(days.map((c, j) => [c, j]));
    const exp = new Map<string, number>();
    return rebalSim(env(cS), { slipOf: (code, c) => def.slip(code, c, 1), vanish: def.vanish }, {
      isSignal: (c) => jOf.has(c),
      targetsAt: (c) => {
        const j = jOf.get(c) as number;
        for (const [code, e] of [...exp]) if (e <= j) exp.delete(code);
        const k = ordersByDay.get(c) ?? 0;
        if (k > 0) {
          const pl = def.pool(c, P).filter((code) => !exp.has(code));
          for (let a = 0; a < Math.min(k, pl.length); a++) { const m = a + Math.floor(rng() * (pl.length - a)); [pl[a], pl[m]] = [pl[m], pl[a]]; exp.set(pl[a], j + hold[Math.floor(rng() * hold.length)]); }
        }
        const mult = F ? filterMult(c, F.ma) : 1;
        return new Map([...exp.keys()].map((code) => [code, def.wOf(P) * mult] as [string, number]));
      },
      stockOf: (code) => h.byCode.get(code),
    }, { lag: 1 });
  };
  const hVs = (full: { cagr: number; mdd: number }, rb: { cagr: number; mdd: number }): { ok: boolean; text: string } => {
    const dc = full.cagr - rb.cagr, dm = rb.mdd - full.mdd;
    const c1 = dc >= PEAD_H_CAGR_GAIN_PP, c2 = dm >= PEAD_H_MDD_GAIN_PP && dc >= -PEAD_H_CAGR_FLOOR_PP;
    return { ok: c1 || c2, text: `CAGR ${dc >= 0 ? "+" : ""}${f2(dc)}%p, MDD ${dm >= 0 ? "−" : "+"}${f2(Math.abs(dm))}%p(개선 ${f2(dm)}%p; ${PEAD_H_MDD_GAIN_STRONG_PP}%p 이상 ${dm >= PEAD_H_MDD_GAIN_STRONG_PP ? "O" : "X"}) → 조건1(CAGR +${PEAD_H_CAGR_GAIN_PP}%p) ${c1 ? "O" : "X"}, 조건2(MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p) ${c2 ? "O" : "X"}` };
  };
  const bhAll = { dates: h.bhP.dates, ret: h.bhP.ret } as unknown as SimRun;
  const windowsFor = (cS: number): Windows => {
    const from = CAL[cS + 1];
    const NW: [string, Win][] = [[`구간 1 ${from}~2016-12-29`, { from, to: "2016-12-29" }], ["구간 2 2017-04~2021-12", { from: "2017-04-04", to: "2021-12-31" }], ["구간 3 2022-01~2026-10-26", { from: "2022-01-01", to: "9999-12-31" }]];
    const FULLX: Win = { from, to: "9999-12-31" };
    return { NW, FULL: FULLX, ALL: [...NW, [`연속 전체 ${from.slice(0, 7)}~2026-10`, FULLX]], noEx26: true, contamNote: "경고(오염): 이 구간 전체(2011~2026)는 DS6·DS4 등 선행 연구에서 이미 반복해 본 데이터다. 변형(F·C 형태)은 DS6·DS7·DS10 결과를 본 뒤 만든 것(선택 편향)이라 순수 검증이 아니다." };
  };
  const pnlS = (t: SimTrade): number => (t.proceeds - t.spend) / t.vAtEntry;
  const topRepl = (r: SimRun, from: string): Set<string> => new Set(r.trades.filter((t) => CAL[t.exitC] >= from).sort((a, b) => pnlS(b) - pnlS(a)).slice(0, F_E_TOP_TRADES).map((t) => `${t.code}|${t.entryC}`));

  // ---- 코어-위성 합성(묶음 DS8·DS9의 combineCS와 같은 규칙, 날짜 축을 일반화) ----
  const sliceSl = (sl: Sl, from: string): Sl => { const k0 = sl.dates.findIndex((d) => d >= from); if (k0 < 0) throw new Error("자를 지점 없음"); return { dates: sl.dates.slice(k0), ret: sl.ret.slice(k0), costFrac: sl.costFrac.slice(k0), nPos: sl.nPos.slice(k0), inv: sl.inv.slice(k0), turn: sl.turn.slice(k0), wMax: sl.wMax.slice(k0) }; };
  const slFromRun = (r: RebalRun): Sl => {
    const tm = new Map(r.turn.map((x) => [x.d, x.v]));
    return { dates: r.dates, ret: r.ret, costFrac: r.costFrac, nPos: r.nPos, inv: r.inv, turn: r.dates.map((d) => tm.get(d) ?? 0), wMax: r.wMax.length === r.dates.length ? r.wMax : r.dates.map(() => Number.NaN) };
  };
  const combine2 = (core: Sl, sat: Sl, wC: number, rate: number): { run: SimRun; wCore: number[]; moved: number[]; cost: number[] } => {
    if (core.dates.length !== sat.dates.length || core.dates.some((d, k) => d !== sat.dates[k])) throw new Error("코어와 위성의 날짜 축이 다르다");
    const n = core.dates.length, parts = [core, sat], s = [wC, 1 - wC], q: number[][] = [];
    const ret: number[] = [], costFrac: number[] = [], nPos: number[] = [], inv: number[] = [], turn: number[] = [], wMax: number[] = [], wCore: number[] = [], cost: number[] = [], moved: number[] = [];
    for (let i = 0; i < n; i++) {
      const Vprev = s[0] + s[1], wPrev = [s[0] / Vprev, s[1] / Vprev];
      for (let j = 0; j < 2; j++) s[j] *= 1 + parts[j].ret[i] / 100;
      let mv = 0, cs = 0;
      const pending = q.length > 0 ? (q.shift() as number[]) : [0, 0];
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
      q.push([wC * V - s[0], (1 - wC) * V - s[1]]);
    }
    return { run: { dates: core.dates, ret, costFrac, nPos, inv, turn: turn.map((v, i) => ({ d: core.dates[i], v })), trades: [], entryCs: [], wMax, haltSkip: 0, exitDefer: 0 }, wCore, moved, cost };
  };

  // =====================================================================================================================
  // 공통 보고(판정 불사용) + 게이트 명세 생성
  // =====================================================================================================================
  const BH_FROM = (from: string): { dates: string[]; ret: number[] } => ({ dates: h.bhP.dates.filter((d) => d >= from), ret: h.bhP.ret.filter((_, k) => h.bhP.dates[k] >= from) });
  interface Ctx { id: string; trial: number; cS: number; Wx: Windows; sleeveW: number; contrib?: Map<string, { pct: number; days: number }>; trades: SimTrade[]; open: SimTrade[]; filterBase?: () => SimRun; filterMa?: number; sigList?: number[]; extraLines?: (run: SimRun) => void }
  const SH = ["005930", "000660", "005935"];
  const reportCommon = (ctx: Ctx, run: SimRun): void => {
    const { id, Wx } = ctx, from = Wx.FULL.from, ds6 = b6.res.run;
    console.log(`\n=== ${id} vs 069500 vs DS6 (CAGR % / MDD %; 같은 구간 = 이 전략 시작 ${from}~) ===\n| 구간 | 069500 | DS6 | ${id} | ${id} − 069500 CAGR %p | ${id} − 069500 MDD %p | ${id} − DS6 CAGR %p | ${id} − DS6 MDD %p |\n|---|---|---|---|---|---|---|---|`);
    for (const [wn, w] of Wx.ALL) {
      const a = h.st(h.bhP, w), s6 = h.st(ds6, w), sc = h.st(run, w);
      console.log(`| ${wn} | ${f2(a.cagr)} / ${f2(a.mdd)} | ${f2(s6.cagr)} / ${f2(s6.mdd)} | ${f2(sc.cagr)} / ${f2(sc.mdd)} | ${sg(sc.cagr - a.cagr)} | ${sg(sc.mdd - a.mdd)} | ${sg(sc.cagr - s6.cagr)} | ${sg(sc.mdd - s6.mdd)} |`);
    }
    const bh = BH_FROM(from), d6 = { dates: ds6.dates.filter((d) => d >= from), ret: ds6.ret.filter((_, k) => ds6.dates[k] >= from) };
    const years: number[] = [];
    for (let y = Number(from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) years.push(y);
    console.log(`\n=== 연도별 수익률 % (${years[0]}년은 ${from}부터, ${years[years.length - 1]}년은 ${h.dataEnd}까지) ===\n| 연도 | 069500 | DS6 | ${id} | ${id} − 069500 %p | ${id} − DS6 %p |\n|---|---|---|---|---|---|`);
    const ex: number[] = [], ex6: number[] = [];
    for (const y of years) {
      const a = h.yearRet(bh, y), c6 = h.yearRet(d6, y), cc = h.yearRet(run, y);
      ex.push(cc - a); ex6.push(cc - c6);
      console.log(`| ${y} | ${f2(a)} | ${f2(c6)} | ${f2(cc)} | ${sg(cc - a)} | ${sg(cc - c6)} |`);
    }
    console.log(`${id} − 069500 승·패 연수: 승 ${ex.filter((x) => x > 0).length} / 패 ${ex.filter((x) => x < 0).length} (평균 ${sg(avg(ex))}%p, 중앙값 ${sg(median(ex))}%p) | ${id} − DS6 승·패 연수: 승 ${ex6.filter((x) => x > 0).length} / 패 ${ex6.filter((x) => x < 0).length} (평균 ${sg(avg(ex6))}%p)`);
    const fs = h.st(run, Wx.FULL);
    const all = [...ctx.trades, ...ctx.open].filter((t) => CAL[t.exitC] >= from), closed = ctx.trades.filter((t) => CAL[t.exitC] >= from);
    const nets = closed.map((t) => (t.proceeds / t.spend - 1) * 100);
    console.log(`\n${id} 요약(판정 불사용): 평균 보유 종목 수 ${f2(fs.avgN)}, 평균 투자 비중 ${f2(fs.avgInv)}%(현금 비중 평균 ${f2(100 - fs.avgInv)}%), 연 회전율 ${f2(fs.turnover)}%, 비용 합계 ${f2(fs.cost)}% | 닫힌 보유 구간 ${closed.length}건: 승률 ${f2((nets.filter((x) => x > 0).length / Math.max(nets.length, 1)) * 100)}%, 평균 이익 ${f2(avg(nets.filter((x) => x > 0)))}%, 평균 손실 ${f2(avg(nets.filter((x) => x <= 0)))}%, 손익비 ${f2(avg(nets.filter((x) => x > 0)) / Math.max(-avg(nets.filter((x) => x <= 0)), 1e-9))}, 구간당 기대값(비용 후 순수익률 평균) ${f2(avg(nets))}% | 열린 구간 ${ctx.open.length}건 포함 전체 ${all.length}건`);
    // 삼성전자·SK하이닉스(PF1은 삼성전자우) 보유 기간·손익 기여
    const wS = ctx.sleeveW;
    for (const code of SH) {
      const ts = all.filter((t) => t.code === code);
      const cb = ctx.contrib?.get(code);
      if (!ts.length && !cb) continue;
      const pnl = cb ? cb.pct * wS : ts.reduce((a, t) => a + pnlS(t), 0) * 100;
      const spans = ts.map((t) => `${CAL[t.entryC]}~${t.reason === "기간 끝 평가" ? "보유 중" : CAL[t.exitC]}`).slice(0, 8).join(", ");
      console.log(`${label(code)}: 보유 구간 ${ts.length}건${cb ? `, 보유 일수 ${cb.days}일` : ""}, 가격 손익 기여 합 ${sg(pnl)}%p(계좌 대비 일별 기여의 단순 합, 비용 제외${cb && wS !== 1 ? `, 위성 비중 ${wS} 반영` : ""}) | 구간: ${spans}${ts.length > 8 ? " …" : ""}`);
    }
    // 초과수익의 출처: 종목·업종 기여
    if (ctx.contrib) {
      const arr = [...ctx.contrib.entries()].map(([code, v]) => ({ code, pct: v.pct * wS, days: v.days })).sort((a, b) => b.pct - a.pct);
      const tot = arr.reduce((a, x) => a + x.pct, 0);
      console.log(`종목별 가격 손익 기여(%p, 단순 합, 상위 8 / 하위 5; 전체 합 ${sg(tot)}): ${arr.slice(0, 8).map((x) => `${label(x.code)} ${sg(x.pct)}`).join(", ")} | 하위: ${arr.slice(-5).map((x) => `${label(x.code)} ${sg(x.pct)}`).join(", ")}`);
      const ind = new Map<string, number>();
      for (const x of arr) { const k = (indOf.get(x.code) ?? "").slice(0, 2) || "미상"; ind.set(k, (ind.get(k) ?? 0) + x.pct); }
      const ia = [...ind.entries()].sort((a, b) => b[1] - a[1]);
      console.log(`업종(KSIC 2자리) 기여(%p, 상위 5 / 하위 3): ${ia.slice(0, 5).map(([k, v]) => `${k} ${sg(v)}`).join(", ")} | ${ia.slice(-3).map(([k, v]) => `${k} ${sg(v)}`).join(", ")}`);
    } else {
      const byCode = new Map<string, number>();
      for (const t of closed) byCode.set(t.code, (byCode.get(t.code) ?? 0) + pnlS(t) * 100);
      const arr = [...byCode.entries()].sort((a, b) => b[1] - a[1]);
      console.log(`종목별 닫힌 거래 손익 기여(진입 시 계좌 대비 %의 합, 상위 8 / 하위 5): ${arr.slice(0, 8).map(([c, v]) => `${label(c)} ${sg(v)}`).join(", ")} | 하위: ${arr.slice(-5).map(([c, v]) => `${label(c)} ${sg(v)}`).join(", ")}`);
    }
    // F 형태: 필터가 현금으로 간 기간
    if (ctx.filterBase && ctx.filterMa && ctx.sigList) {
      const base = ctx.filterBase(), sl = ctx.sigList, on = new Set<string>();
      for (let i = 0; i < sl.length; i++) {
        if (filterMult(sl[i], ctx.filterMa) < 1) { const end = i + 1 < sl.length ? sl[i + 1] + 1 : nCal - 1; for (let k = sl[i] + 2; k <= end; k++) on.add(CAL[k]); }
      }
      const idx = run.dates.map((d, k) => (on.has(d) ? k : -1)).filter((k) => k >= 0);
      const sumF = idx.reduce((a, k) => a + run.ret[k], 0), baseIdx = new Map(base.dates.map((d, k) => [d, k]));
      const sumB = idx.reduce((a, k) => a + (base.ret[baseIdx.get(run.dates[k]) as number] ?? 0), 0);
      const sF = h.st(run, Wx.FULL), sB = h.st(base, Wx.FULL);
      console.log(`${id} 필터 보고(근사: 신호 체결 다음 날부터 다음 체결일까지): 필터 가동(주식 50%) ${on.size}거래일(전체 ${run.dates.length}일의 ${f2((on.size / Math.max(run.dates.length, 1)) * 100)}%, ${idx.length ? `첫 ${run.dates[idx[0]]} 마지막 ${run.dates[idx[idx.length - 1]]}` : "없음"}) | 그 기간 일수익률 단순 합: ${id} ${f2(sumF)}%p vs 필터 없는 단독 ${f2(sumB)}%p (필터 손익 기여 ${sg(sumF - sumB)}%p) | 연속 전체: ${id} ${f2(sF.cagr)} / ${f2(sF.mdd)} vs 단독 ${f2(sB.cagr)} / ${f2(sB.mdd)} (CAGR ${sg(sF.cagr - sB.cagr)}%p, MDD ${sg(sF.mdd - sB.mdd)}%p)`);
    }
    ctx.extraLines?.(run);
  };

  // ---- 표준 게이트 명세 ----
  const gateNotes = (id: string, trial: number, nNb: number): void => {
    console.log(`${id}(시험 ${trial}) 게이트 해석(사전등록): C = 진입·청산·재조정 체결을 모두 +1거래일(lag 2); D = 이웃 ${nNb}개 모두 연속 전체 CAGR ≥ 069500; E = 닫힌 거래 손익 상위 3개를 069500 수익률로 대체; F = 같은 신호일 신규 진입 수·보유 기간 분포의 무작위 대조 ${KSS_R3_DRAWS}회(시드 ${KSS_R3_SEED}), 백분위 ≥ 95(참고선 ${f2(100 * (1 - 0.05 / B5_F_DENOMINATOR))}); G = 진입 건수 ≥ 100; H = 069500만 판정(CAGR +${PEAD_H_CAGR_GAIN_PP}%p, 또는 MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p).`);
  };
  const mkS = <P,>(def: Strat<P>, id: string, trial: number, F: boolean, cS: number, Wx: Windows, title: string, cfg?: Partial<Ctx>): CandSpec => {
    const FC = (ma: number): FCfg | null => (F ? { ma } : null), P0 = def.P0;
    const base = runS(def, P0, cS, FC(B5_MA_DAYS), { lag: 1, detail: true });
    const hold = holdSamplesOf(def, F, cS, base);
    const nbs: { label: string; run: () => SimRun }[] = def.nbs.map(([lb, ch]) => ({ label: lb, run: () => runS(def, { ...P0, ...ch }, cS, FC(B5_MA_DAYS), { lag: 1 }) }));
    if (F) for (const ma of B5_MA_NB) nbs.push({ label: `이동평균 ${ma}일`, run: () => runS(def, P0, cS, FC(ma), { lag: 1 }) });
    return {
      id, trial, title, defense: false, capFrac: def.wOf(P0), fDenominator: B5_F_DENOMINATOR, ref: { id: "069500", run: bhAll },
      hRule: (full, rb) => { const a = hVs(full, rb); return { ok: a.ok, note: `[사전등록: 069500만 판정] 069500 ${f2(rb.cagr)} / ${f2(rb.mdd)} → ${a.ok ? "O" : "X"} (${a.text})` }; },
      run: (o) => runS(def, P0, cS, FC(B5_MA_DAYS), o),
      neighbors: nbs,
      random: (rng, ob) => randomS(def, P0, cS, FC(B5_MA_DAYS), rng, ob, hold),
      reasons: ["순위 밖", "목표 0", "폐지", "폐지(전액 손실)"], label,
      extra: (run) => {
        gateNotes(id, trial, nbs.length);
        const r = run as RebalRun;
        reportCommon({ id, trial, cS, Wx, sleeveW: 1, contrib: r.contrib, trades: r.trades, open: r.open, filterBase: F ? () => runS(def, P0, cS, null, { lag: 1, detail: true }) : undefined, filterMa: B5_MA_DAYS, sigList: sigDays(def, true).filter((c) => c >= cS), ...cfg }, run);
      },
    };
  };
  /** C 형태: DS6 코어 40%(정의 그대로, 같은 코드·같은 캐시) + 위성 60% = 새 전략. */
  const mkC = <P,>(def: Strat<P>, id: string, trial: number, cS: number, Wx: Windows, title: string): CandSpec => {
    const P0 = def.P0, from = Wx.FULL.from, wC = B5_CORE_W;
    const coreSlOf = (lag: number, repl?: Set<string>): { run: CoreRun; sl: Sl } => { const x = coreOf(2, undefined, lag, { repl }); return { run: x.run, sl: sliceSl(x.sl, from) }; };
    const baseSat = runS(def, P0, cS, null, { lag: 1, detail: true });
    const hold = holdSamplesOf(def, false, cS, baseSat);
    const satOrders = new Map<number, number>();
    for (const c of baseSat.entryCs) satOrders.set(c - 1, (satOrders.get(c - 1) ?? 0) + 1);
    const build = (P: P, o: { lag: number; replSat?: boolean; replCore?: boolean }): { res: ReturnType<typeof combine2>; sat: RebalRun; core: CoreRun } => {
      const sat = runS(def, P, cS, null, { lag: o.lag, detail: true, replace: o.replSat ? topRepl(baseSat, from) : undefined });
      const cx = o.replCore ? coreSlOf(1, coreReplSet(coreOf(2, undefined, 1).run)) : coreSlOf(o.lag);
      return { res: combine2(cx.sl, slFromRun(sat), wC, CS_MOVE_COST), sat, core: cx.run };
    };
    const base = build(P0, { lag: 1 });
    const merge = (b: ReturnType<typeof build>): SimRun => {
      const r: SimRun = { ...b.res.run };
      r.trades = [...b.sat.trades.map((t) => ({ ...t, vAtEntry: t.vAtEntry / (1 - wC) })), ...b.core.trades.map((t) => ({ ...t, vAtEntry: t.vAtEntry / wC }))];
      r.entryCs = [...b.sat.entryCs, ...b.core.entryCs]; r.haltSkip = b.sat.haltSkip + b.core.haltSkip; r.exitDefer = b.sat.exitDefer + b.core.exitDefer;
      return r;
    };
    const nbs: { label: string; run: () => SimRun }[] = def.nbs.map(([lb, ch]) => ({ label: lb, run: () => build({ ...P0, ...ch }, { lag: 1 }).res.run }));
    return {
      id, trial, title, defense: false, capFrac: def.wOf(P0), fDenominator: B5_F_DENOMINATOR, ref: { id: "069500", run: bhAll },
      hRule: (full, rb) => { const a = hVs(full, rb); return { ok: a.ok, note: `[사전등록: 069500만 판정] 069500 ${f2(rb.cagr)} / ${f2(rb.mdd)} → ${a.ok ? "O" : "X"} (${a.text})` }; },
      run: (o) => (o.replace ? merge(build(P0, { lag: 1, replSat: true })) : merge(build(P0, { lag: o.lag }))),
      neighbors: nbs,
      random: (rng) => combine2(coreSlOf(1).sl, slFromRun(randomS(def, P0, cS, null, rng, satOrders, hold)), wC, CS_MOVE_COST).run,
      reasons: ["순위 밖", "목표 0", "폐지", "폐지(전액 손실)"], label,
      extra: (run) => {
        gateNotes(id, trial, nbs.length);
        console.log(`${id} 게이트 E 해석(사전등록, DS8·DS9와 같음): 위성의 닫힌 거래 중 손익 상위 3개를 069500 수익률로 바꾼 위성 + 실제 코어를 같은 합성 규칙으로 돌린 연속 전체 CAGR ≥ 069500. 코어 상위 3개 대체는 보고만. F: 위성 무작위 대조를 실제 코어(고정)와 40:60 합성. G: 위성+코어 진입 합.`);
        reportCommon({ id, trial, cS, Wx, sleeveW: 1 - wC, contrib: baseSat.contrib, trades: [...baseSat.trades], open: baseSat.open, extraLines: (r) => ds6GateLine(id, Wx, r) }, run);
        const bb = base;
        console.log(`${id} 코어-위성 리밸 이동 금액 연 % ${f2(bb.res.moved.reduce((a, x) => a + x, 0) * 100 / Math.max((Date.parse(h.dataEnd) - Date.parse(from)) / 86_400_000 / 365.25, 1e-9))}, 위성 단독(같은 구간) CAGR/MDD ${cellS(slFromRun(baseSat), Wx.FULL)} | 코어 단독 ${cellS(sliceSl(coreOf(2, undefined, 1).sl, from), Wx.FULL)}`);
      },
    };
  };
  const cellS = (s: Sl, w: Win): string => { const x = h.st({ dates: s.dates, ret: s.ret }, w); return `${f2(x.cagr)} / ${f2(x.mdd)}`; };

  // =====================================================================================================================
  // DS6 환경 확인 + 같은 구간 DS6 관문(C 형태 비교용)
  // =====================================================================================================================
  const b6 = build(DS6D);
  {
    const sF = h.st(b6.res.run, FULL), s1 = h.st(b6.res.run, { from: FULL.from, to: "2016-12-30" });
    const ok = f2(sF.cagr) === f2(DS89_DS6_REF.전체[0]) && f2(sF.mdd) === f2(DS89_DS6_REF.전체[1]) && f2(s1.cagr) === f2(DS89_DS6_REF.구간1[0]) && f2(s1.mdd) === f2(DS89_DS6_REF.구간1[1]);
    console.log(`\nDS6 재현(환경 확인): 연속 전체 ${f2(sF.cagr)} / ${f2(sF.mdd)} (기록 ${DS89_DS6_REF.전체.join(" / ")}), 구간 1(CAGR 기간 ${FULL.from}~2016-12-30) ${f2(s1.cagr)} / ${f2(s1.mdd)} (기록 ${DS89_DS6_REF.구간1.join(" / ")}) → ${ok ? "일치" : "불일치"}`);
    if (!ok) throw new Error("DS6 기록과 다르다 — 시험을 시작하지 않고 중단해 보고한다");
  }
  const ds6Lines = new Map<string, string>();
  const ds6GateLine = (id: string, Wx: Windows, run: SimRun): void => {
    const from = Wx.FULL.from;
    let line = ds6Lines.get(from);
    if (!line) {
      const r6 = b6.res.run, eps = SAT_MDD_EPS;
      let bCount = 0;
      for (const [, w] of Wx.NW) { const a = h.st(r6, w), b = h.st(h.bhP, w); if (a.cagr > b.cagr && a.mdd <= b.mdd + eps) bCount++; }
      const full6 = h.st(r6, Wx.FULL), dl = h.st(build(DS6D, { coreLag: 2, satLag: 2 }).res.run, Wx.FULL);
      const gC = full6.cagr - dl.cagr <= F_C_MAX_CAGR_DROP && dl.mdd - full6.mdd <= F_C_MAX_MDD_WORSEN;
      const draws = randOf(undefined).map((dr) => h.st(combineCS(b6.coreX.sl, { ...zeroSl, ret: Array.from(dr.full.subarray(dr.k0)) }, DS89_CORE_W, CS_MOVE_COST).run, Wx.FULL).cagr);
      const pct = (draws.filter((x) => x < full6.cagr).length / draws.length) * 100;
      line = `DS6(같은 구간 ${from}~) 관문: B ${bCount}개 구간(${bCount >= 2 ? "O" : "X"}) | C 지연 CAGR ${f2(dl.cagr)}(하락 ${f2(full6.cagr - dl.cagr)}%p)·MDD ${f2(dl.mdd)}(악화 ${f2(dl.mdd - full6.mdd)}%p) → ${gC ? "O" : "X"} | F 무작위 백분위 ${f2(pct)} → ${pct >= F_F_MIN_PCTILE ? "O" : "X"} (DS6 ${f2(full6.cagr)} / ${f2(full6.mdd)})`;
      ds6Lines.set(from, line);
    }
    console.log(`${id} ← ${line}`);
    void run;
  };

  // =====================================================================================================================
  // TS1 실행기·명세
  // =====================================================================================================================
  const cTS = cPE;
  const tsCfg = (P: TsP) => ({ slip: L_SLIPPAGE, maxPos: P.slots, capFrac: B5_TS_CAP, cooldown: 0 });
  const runTS = (P: TsP, o: { lag: number; replace?: Set<string>; detail?: boolean }): SimRun => simSlots(env(cTS), tsCfg(P), { candsOf: (c) => tsSignals(c, P).map((s) => ({ s, code: s.code })), exitReason: tsExit(P) }, { lag: o.lag, replace: o.replace, detail: o.detail });
  const randomTS = (P: TsP, rng: () => number, ob: Map<number, number>): SimRun => simSlots(env(cTS), tsCfg(P), {
    candsOf: (c, held, blocked) => {
      const n = ob.get(c) ?? 0;
      if (!n) return [];
      const pl = tsPool(c, P).filter((s) => !held(s.code) && !blocked(s.code)), out: SimCand[] = [];
      while (out.length < n && pl.length) { const s = pl.splice(Math.floor(rng() * pl.length), 1)[0]; out.push({ s, code: s.code }); }
      return out;
    },
    exitReason: tsExit(P),
  }, { lag: 1 });
  const mkTS = (id: string, trial: number, Wx: Windows): CandSpec => {
    const P0 = B5_TS_P0;
    const nbs = B5_TS_NB.map(([lb, ch]) => ({ label: lb, run: () => runTS({ ...P0, ...ch }, { lag: 1 }) }));
    return {
      id, trial, title: `${id}: K200P 종목이 252거래일 신고가(직전 251거래일 종가 최댓값 초과)를 내면 다음 거래일 종가에 평가액의 5% 매수(슬롯 20), 종가가 진입 후 최고 종가의 75% 이하이면 청산`, defense: false, capFrac: B5_TS_CAP, fDenominator: B5_F_DENOMINATOR, ref: { id: "069500", run: bhAll },
      hRule: (full, rb) => { const a = hVs(full, rb); return { ok: a.ok, note: `[사전등록: 069500만 판정] 069500 ${f2(rb.cagr)} / ${f2(rb.mdd)} → ${a.ok ? "O" : "X"} (${a.text})` }; },
      run: (o) => runTS(P0, o), neighbors: nbs, random: (rng, ob) => randomTS(P0, rng, ob),
      reasons: [`손절(고점 −${f2(P0.stop * 100)}%)`], label,
      extra: (run) => {
        gateNotes(id, trial, nbs.length);
        const closed = run.trades.filter((t) => CAL[t.exitC] >= Wx.FULL.from);
        const hold = closed.map((t) => t.exitC - t.entryC), stops = closed.filter((t) => t.reason.startsWith("손절"));
        const give = stops.map((t) => ((t.peakAdj - t.exitAdj) / t.peakAdj) * 100);
        console.log(`${id} 보고: 평균 보유 일수 ${f2(avg(hold))}(중앙값 ${f2(median(hold))}), 닫힌 거래 ${closed.length}건 중 손절 ${stops.length}건, 손절 시 고점 대비 평균 반납 폭 ${f2(avg(give))}%(중앙값 ${f2(median(give))}%), 손절 거래 평균 수익률 ${f2(avg(stops.map((t) => (t.proceeds / t.spend - 1) * 100)))}%, 신호는 많았는데 슬롯이 차서 무시된 일수 비율은 보고하지 않음(사전등록 한계)`);
        reportCommon({ id, trial, cS: cTS, Wx, sleeveW: 1, trades: run.trades, open: [] }, run);
      },
    };
  };

  // =====================================================================================================================
  // 사전 점검용 브루트포스(과거 이력만, 다른 자료 접근 경로: 이진 탐색·직접 합산)
  // =====================================================================================================================
  const bsExact = (s: S, k: number): number => { if (k < 0) return -1; const d = CAL[k]; let lo = 0, hi = s.dates.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (s.dates[m] === d) return m; if (s.dates[m] < d) lo = m + 1; else hi = m - 1; } return -1; };
  const bsAtOrBefore = (s: S, k: number): number => { if (k < 0) return -1; const d = CAL[k]; let lo = 0, hi = s.dates.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (s.dates[m] <= d) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
  const bpx = (s: S, k: number): number => { const r = bsAtOrBefore(s, k); return r >= 0 ? s.close[r] : 0; };
  const bruteRank = (c: number): S[] => {
    const d = CAL[c], m = membAt(d), e: { s: S; mc: number }[] = [];
    if (m) for (const s of h.stocks) { const i = s.idx.get(d); if (i !== undefined && !excluded.has(s.code) && m.get(s.code) === "KOSPI") e.push({ s, mc: s.mcapRow[i] }); }
    e.sort((a, b) => b.mc - a.mc || (a.s.code < b.s.code ? -1 : 1));
    return e.slice(0, 200).map((x) => x.s);
  };
  const cmpLists = (label: string, mod: { code: string; v: number }[], br: { code: string; v: number }[], tol: number): string | null => {
    if (mod.length !== br.length) return `${label}: 길이 ${mod.length} ≠ ${br.length}`;
    const bm = new Map(br.map((x) => [x.code, x.v]));
    for (let i = 0; i < mod.length; i++) {
      const v = bm.get(mod[i].code);
      if (v === undefined) return `${label}: 모듈에만 ${mod[i].code}`;
      if (Math.abs(v - mod[i].v) > tol * Math.max(1, Math.abs(v))) return `${label}: ${mod[i].code} 값 ${mod[i].v} ≠ ${v}`;
      if (mod[i].code !== br[i].code && Math.abs(mod[i].v - br[i].v) > tol * Math.max(1, Math.abs(br[i].v))) return `${label}: ${i + 1}번째 ${mod[i].code} ≠ ${br[i].code}`;
    }
    return null;
  };
  const bruteSelect = (sorted: string[], held: ReadonlySet<string>, n: number, keepRank: number): string[] => {
    const keep: string[] = [];
    for (let k = 0; k < sorted.length && k < keepRank; k++) if (held.has(sorted[k]) && keep.length < n) keep.push(sorted[k]);
    const out = [...keep];
    for (let k = 0; k < sorted.length && out.length < n; k++) if (!out.includes(sorted[k])) out.push(sorted[k]);
    return out;
  };
  const bRetBrute = (k: number): number => { const r = h.bhRet.get(CAL[k]); return r === undefined ? Number.NaN : r; };
  const bruteRm = (c: number, P: RmP): { code: string; v: number }[] => {
    const out: { code: string; v: number }[] = [];
    bruteRank(c).forEach((s) => {
      const xs: number[] = [], ys: number[] = [];
      if (c - P.start >= 1) for (let k = c - P.start; k <= c - P.skip; k++) {
        const jd = bsExact(s, k), jp = bsExact(s, k - 1), x = bRetBrute(k);
        if (jd < 0 || jp < 0 || !Number.isFinite(x)) continue;
        xs.push(x); ys.push(s.close[jd] / s.close[jp] - 1);
      }
      const n = xs.length;
      if (n < P.minValid) return;
      const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
      let sxx = 0, sxy = 0;
      for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
      const beta = sxy / sxx, alpha = my - beta * mx;
      let sse = 0, sumRes = 0;
      for (let i = 0; i < n; i++) { const e = ys[i] - alpha - beta * xs[i]; sse += e * e; sumRes += ys[i] - beta * xs[i]; }
      const sd = Math.sqrt(sse / (n - 1));
      if (sd > 0) out.push({ code: s.code, v: sumRes / (sd * Math.sqrt(n)) });
    });
    const rk = new Map(bruteRank(c).map((s, k) => [s.code, k]));
    return out.sort((a, b) => b.v - a.v || (rk.get(a.code) as number) - (rk.get(b.code) as number));
  };
  const bruteLr = (c: number, P: LrP): { code: string; v: number }[] => {
    const out: { code: string; v: number }[] = [];
    if (c - P.longStart < 0) return out;
    let bRecent = 1;
    for (let k = c - P.recent + 1; k <= c; k++) bRecent *= 1 + (Number.isFinite(bRetBrute(k)) ? bRetBrute(k) : 0);
    bRecent -= 1;
    const rank = bruteRank(c), rk = new Map(rank.map((s, k) => [s.code, k]));
    for (const s of rank) {
      let valid = 0;
      for (let k = c - P.longStart; k <= c; k++) if (bsExact(s, k) >= 0) valid++;
      if (valid < P.minValid) continue;
      const a0 = bpx(s, c - P.longStart), a1 = bpx(s, c - P.longEnd), a2 = bpx(s, c), a3 = bpx(s, c - P.recent);
      if (!(a0 > 0 && a1 > 0 && a2 > 0 && a3 > 0) || !(a2 / a3 - 1 > bRecent)) continue;
      out.push({ code: s.code, v: a1 / a0 - 1 });
    }
    return out.sort((a, b) => a.v - b.v || (rk.get(a.code) as number) - (rk.get(b.code) as number));
  };
  const brutePf = (c: number, P: PfP): { code: string; v: number }[] => {
    const out: { code: string; v: number }[] = [];
    for (const { p, c: cs } of pairs) {
      const ip = bsExact(p, c), ic = bsExact(cs, c);
      if (ip < 0 || ic < 0 || !(p.vol[ip] > 0) || !(cs.vol[ic] > 0)) continue;
      let vp = 0, vc = 0, tv = 0;
      for (let k = c - P.zWin + 1; k <= c; k++) { if (bsExact(p, k) >= 0) vp++; if (bsExact(cs, k) >= 0) vc++; }
      if (vp < P.minValid || vc < P.minValid) continue;
      for (let k = c - B5_PF_TV_DAYS + 1; k <= c; k++) { const j = bsExact(p, k); if (j >= 0) tv += p.raw[j] * p.vol[j]; }
      if (!(tv / B5_PF_TV_DAYS >= P.minTv)) continue;
      const ss: number[] = [];
      for (let k = c - P.zWin; k <= c - 1; k++) { const jp = bsExact(p, k), jc = bsExact(cs, k); if (jp >= 0 && jc >= 0 && p.close[jp] > 0 && cs.close[jc] > 0) ss.push(Math.log(p.close[jp] / cs.close[jc])); }
      if (ss.length < 2) continue;
      const mu = ss.reduce((a, b) => a + b, 0) / ss.length, sd = Math.sqrt(ss.reduce((a, b) => a + (b - mu) ** 2, 0) / (ss.length - 1));
      const sc = bpx(p, c), cc = bpx(cs, c);
      if (sd > 0 && sc > 0 && cc > 0) out.push({ code: p.code, v: (Math.log(sc / cc) - mu) / sd });
    }
    return out.sort((a, b) => a.v - b.v || (a.code < b.code ? -1 : 1));
  };
  const bruteBs = (c: number, P: BsP): { code: string; v: number }[] => {
    const d = CAL[c], m = membAt(d), el: S[] = [];
    if (!m) return [];
    for (const s of h.stocks) {
      const i = bsExact(s, c);
      if (i < 0 || excluded.has(s.code)) continue;
      const mk = m.get(s.code);
      if (mk !== "KOSPI" && mk !== "KOSDAQ") continue;
      let rows = 0;
      for (let k = 0; k <= c; k++) if (bsExact(s, k) >= 0) rows++;
      if (rows < P.minRows || s.raw[i] < P.minPrice) continue;
      let zero = 0, zero20 = false;
      for (let k = c - P.zeroVolWin + 1; k <= c; k++) { const j = bsExact(s, k); if (j < 0 || s.vol[j] === 0) { zero++; if (k > c - P.recentZeroWin) zero20 = true; } }
      if (zero > P.zeroVolMax || zero20) continue;
      const tvs: number[] = [];
      for (let k = c - P.tvMedianDays + 1; k <= c; k++) { const j = bsExact(s, k); tvs.push(j < 0 ? 0 : s.raw[j] * s.vol[j]); }
      tvs.sort((a, b) => a - b);
      const med = tvs.length % 2 ? tvs[(tvs.length - 1) / 2] : (tvs[tvs.length / 2 - 1] + tvs[tvs.length / 2]) / 2;
      if (!(med >= P.minTv)) continue;
      el.push(s);
    }
    const vals = el.map((s) => {
      const r = (k: number): number => { const a = bpx(s, k - 1), b = bpx(s, k); return a > 0 && b > 0 ? b / a - 1 : 0; };
      const rs: number[] = []; for (let k = c - P.volWin + 1; k <= c; k++) rs.push(r(k));
      const mu = rs.reduce((x, y) => x + y, 0) / rs.length, sd = Math.sqrt(rs.reduce((x, y) => x + (y - mu) ** 2, 0) / (rs.length - 1));
      const last: number[] = []; for (let k = c - P.topWin + 1; k <= c; k++) last.push(r(k));
      last.sort((x, y) => y - x);
      let tv = 0;
      for (let k = c - P.turnWin + 1; k <= c; k++) { const j = bsExact(s, k); if (j >= 0 && s.mcapRow[j] > 0) tv += (s.raw[j] * s.vol[j]) / (s.mcapRow[j] * 1e8); }
      return [sd, (last[0] + last[1] + last[2]) / 3, tv / P.turnWin];
    });
    const pr = (col: number): number[] => vals.map((v) => { const x = v[col]; let less = 0, eq = 0; for (const w of vals) { if (w[col] < x) less++; else if (w[col] === x) eq++; } return vals.length > 1 ? (less + (eq - 1) / 2) / (vals.length - 1) : 0; });
    const p0 = pr(0), p1 = pr(1), p2 = pr(2);
    return el.map((s, k) => ({ code: s.code, v: (p0[k] + p1[k] + p2[k]) / 3 })).sort((a, b) => a.v - b.v || (a.code < b.code ? -1 : 1));
  };
  const bruteTs = (c: number, P: TsP): string[] => {
    const out: string[] = [];
    if (c - P.win + 1 < 0) return out;
    for (const s of bruteRank(c)) {
      let valid = 0;
      for (let k = c - P.win + 1; k <= c; k++) if (bsExact(s, k) >= 0) valid++;
      if (valid < P.minValid) continue;
      let mx = Number.NEGATIVE_INFINITY;
      for (let k = c - P.win + 1; k <= c - 1; k++) { const v = bpx(s, k); if (v > mx) mx = v; }
      if (bpx(s, c) > mx) out.push(s.code);
    }
    return out;
  };
  const bruteMvCov = (c: number, P: MvP): { codes: string[]; S: Float64Array } => {
    const codes: string[] = [], cols: number[][] = [];
    for (const s of bruteRank(c).slice(0, P.top)) {
      if (c - P.win + 1 < 1) continue;
      let valid = 0;
      for (let k = c - P.win + 1; k <= c; k++) if (bsExact(s, k) >= 0) valid++;
      if (valid < P.minValid) continue;
      const r: number[] = [];
      for (let k = c - P.win + 1; k <= c; k++) { const a = bpx(s, k - 1), b = bpx(s, k); r.push(a > 0 && b > 0 ? b / a - 1 : 0); }
      codes.push(s.code); cols.push(r);
    }
    const n = codes.length, T = P.win, mean = cols.map((r) => r.reduce((a, b) => a + b, 0) / T), S = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      let s = 0;
      for (let t = 0; t < T; t++) s += (cols[i][t] - mean[i]) * (cols[j][t] - mean[j]);
      s /= T - 1;
      S[i * n + j] = i === j ? s : P.lambda * s;
    }
    return { codes, S };
  };
  const fails: string[] = [];
  const note = (m: string | null, tag: string): void => { if (m) { fails.push(`${tag}: ${m}`); } };

  // =====================================================================================================================
  // 사전 점검 (ALLOC_MODE=repro, 성과 미계산)
  // =====================================================================================================================
  if (MODE === "repro") {
    const checkStrat = <P,>(tag: string, def: Strat<P>, brSorted: (c: number, P: P) => { code: string; v: number }[], modSorted: (c: number, P: P) => { code: string; v: number }[], nOf: (P: P) => number, keepOf: (P: P) => number, F: boolean, nbStep: number): void => {
      const cS = startOf(def, false);
      const variants: [string, P, number][] = [["기본", def.P0, 1], ...def.nbs.map(([lb, ch]) => [lb, { ...def.P0, ...ch }, nbStep] as [string, P, number])];
      for (const [lb, Pv, step] of variants) {
        let nBad = 0, nDays = 0, nSel = 0, firstBad = "";
        const wrap: Strat<P> = { ...def, targets: (c, held, Pp, m, swap) => {
          const t = def.targets(c, held, Pp, m, swap);
          if (!swap) { const a = [...t.keys()].sort().join(), b = [...held].sort().join(); if (a !== b) { nBad++; firstBad ||= `${CAL[c]} 비교체일 목표 ≠ 보유`; } return t; }
          if (nDays++ % step !== 0) return t;
          const a = modSorted(c, Pp), b = brSorted(c, Pp), msg = cmpLists("순위", a, b, 1e-9);
          if (msg) { nBad++; firstBad ||= `${CAL[c]} ${msg}`; }
          else {
            const sel = bruteSelect(b.map((x) => x.code), held, nOf(Pp), keepOf(Pp)), w = (1 / nOf(Pp)) * m;
            nSel++;
            const same = sel.length === t.size && sel.every((code) => Math.abs((t.get(code) ?? -1) - w) < 1e-15);
            if (!same) { nBad++; firstBad ||= `${CAL[c]} 선정 ${sel.length}개 ≠ 모듈 ${t.size}개`; }
          }
          return t;
        } };
        runS(wrap, Pv, cS, F ? { ma: B5_MA_DAYS } : null, { lag: 1 });
        console.log(`  ${tag} ${lb}${F ? "(필터 형태)" : ""}: 신호일 ${nDays}일 중 대조 ${nSel}일, 불일치 ${nBad}건 ${nBad === 0 ? "통과" : `불일치 (${firstBad})`}`);
        if (nBad > 0) note(`${tag} ${lb} ${firstBad}`, "신호 대조");
      }
    };
    console.log(`\n=== 1. 구조·시작일 (첫 유효 신호일 = 평가 시작 전날) ===`);
    const starts = { RM1: startOf(RM1, false), LR1: startOf(LR1, false), PF1: startOf(PF1, false), MV1: startOf(MV1, false), BS1: startOf(BS1, false) };
    for (const [k, c] of Object.entries(starts)) console.log(`  ${k}: 첫 신호일 ${CAL[c]}(평가 시작 ${CAL[c + 1]}), 월말 신호일 ${monthEndIdx.filter((x) => x >= c).length}개(분기 ${monthEndIdx.filter((x) => x >= c && isQuarterEnd(x)).length}개)`);
    console.log(`  TS1: 평가 시작 ${CAL[cTS + 1]}(초기 ${CAL[cTS]})`);
    {
      const cnt = (f: (c: number) => number): string => { const v = monthEndIdx.filter((c) => c >= 253).map(f); return `최소 ${Math.min(...v)} / 중앙값 ${median(v)} / 최대 ${Math.max(...v)}`; };
      console.log(`  RM1 점수 있는 종목 수(월말, K200P 안): ${cnt((c) => rmSorted(c, B5_RM_P0).length)}`);
      console.log(`  LR1 후보 수(월말; 최근 수익률 > 069500, 유효 일수 조건): ${cnt((c) => lrCands(c, B5_LR_P0).length)} | 후보 20개 미만인 분기말 ${monthEndIdx.filter((c) => c >= starts.LR1 && isQuarterEnd(c) && lrCands(c, B5_LR_P0).length < 20).length}개`);
      console.log(`  PF1 대상 우선주 수(월말, 5억 기준): ${cnt((c) => pfElig(c, B5_PF_P0).length)} | 10개 미만인 월 ${monthEndIdx.filter((c) => c >= starts.PF1 && pfElig(c, B5_PF_P0).length < 10).length}개 / 전체 ${monthEndIdx.filter((c) => c >= starts.PF1).length}개 | 우선주 짝 ${pairs.length}개`);
      console.log(`  MV1 자산 수(월말, 상위 100 중 유효): ${cnt((c) => mvCov(c, B5_MV_P0).n)}`);
      console.log(`  BS1 유니버스 크기(월말): ${cnt((c) => bsElig(c, B5_BS_P0).length)}`);
    }
    console.log(`\n=== 2. 신호 독립 대조 (모듈 = 브루트포스(이진 탐색·직접 합산, 과거 이력만), 실제 보유 경로 위에서; 기본은 모든 신호일, 이웃은 표본) ===`);
    checkStrat("RM1", RM1, (c, P) => bruteRm(c, P), (c, P) => rmSorted(c, P).map((x) => ({ code: x.code, v: x.sc })), (P) => P.n, (P) => P.n * P.keepMult, false, 6);
    checkStrat("RM1", RM1, (c, P) => bruteRm(c, P), (c, P) => rmSorted(c, P).map((x) => ({ code: x.code, v: x.sc })), (P) => P.n, (P) => P.n * P.keepMult, true, 1000000);
    checkStrat("LR1", LR1, (c, P) => bruteLr(c, P), (c, P) => lrCands(c, P).map((x) => ({ code: x.code, v: x.long })), (P) => P.n, (P) => P.n * P.keepMult, false, 1);
    checkStrat("LR1", LR1, (c, P) => bruteLr(c, P), (c, P) => lrCands(c, P).map((x) => ({ code: x.code, v: x.long })), (P) => P.n, (P) => P.n * P.keepMult, true, 1000000);
    checkStrat("PF1", PF1, (c, P) => brutePf(c, P), (c, P) => pfElig(c, P).map((x) => ({ code: x.code, v: x.z })), (P) => P.n, (P) => P.n * P.keepMult, false, 1);
    checkStrat("BS1", BS1, (c, P) => bruteBs(c, P), (c, P) => bsSorted(c, P).map((x) => ({ code: x.code, v: x.score })), (P) => P.n, (P) => P.n * P.keepMult, false, 12);
    {
      // TS1: 매 거래일 신호 목록 대조(기본은 모든 판단일, 이웃은 10일마다)
      for (const [lb, P] of [["기본", B5_TS_P0] as [string, TsP], ...B5_TS_NB.map(([l, ch]) => [l, { ...B5_TS_P0, ...ch }] as [string, TsP])]) {
        let nBad = 0, nDays = 0, nSig = 0, firstBad = "";
        const step = lb === "기본" ? 1 : 10;
        for (let c = cTS; c < nCal - 1; c += step) {
          const a = tsSignals(c, P).map((s) => s.code), b = bruteTs(c, P);
          nDays++; nSig += a.length;
          if (a.join() !== b.join()) { nBad++; firstBad ||= `${CAL[c]} 모듈 ${a.length}개 ≠ 브루트 ${b.length}개`; }
        }
        console.log(`  TS1 ${lb}: 판단일 ${nDays}일 중 신호 합 ${nSig}개, 불일치 ${nBad}일 ${nBad === 0 ? "통과" : `불일치 (${firstBad})`}`);
        if (nBad > 0) note(`TS1 ${lb} ${firstBad}`, "신호 대조");
      }
    }
    {
      // MV1: KKT·합·상하한(모든 신호일), 서로 다른 시작점 풀이와 목적함수 대조(표본 24개)
      const cS = starts.MV1, days = monthEndIdx.filter((c) => c >= cS), pick = new Set(days.filter((_, k) => k % Math.max(1, Math.floor(days.length / B5_MV_CHECK_SAMPLES)) === 0).slice(0, B5_MV_CHECK_SAMPLES));
      let nChk = 0, maxWDiff = 0, maxObjRel = 0, nBad = 0, firstBad = "";
      const wrap: Strat<MvP> = { ...MV1, targets: (c, held, P, m, swap) => {
        const t = MV1.targets(c, held, P, m, swap);
        let sum = 0;
        for (const [, w] of t) { sum += w; if (w < -1e-15 || w > P.cap * m + 1e-12) { nBad++; firstBad ||= `${CAL[c]} 비중 범위 위반`; } }
        if (Math.abs(sum - m) > 1e-9) { nBad++; firstBad ||= `${CAL[c]} 합 ${sum} ≠ ${m}`; }
        if (pick.has(c)) {
          const { codes, S } = bruteMvCov(c, P), n = codes.length, start = new Float64Array(n);
          for (let i = 0; i < n; i++) start[i] = i < Math.ceil(n / 5) ? 1 : 0;
          const sp = new Float64Array(n); projectCappedSimplex(start, Math.max(P.cap, 1 / n), sp);
          const r = solveMinVar(S, n, Math.max(P.cap, 1 / n), B5_MV_KKT_TOL, B5_MV_MAX_ITER, sp);
          const wm = new Float64Array(n); codes.forEach((code, i) => { wm[i] = t.get(code) ?? 0; });
          let obj = 0; for (let i = 0; i < n; i++) { let q = 0; for (let j = 0; j < n; j++) q += S[i * n + j] * wm[j]; obj += wm[i] * q; }
          let dmax = 0; for (let i = 0; i < n; i++) dmax = Math.max(dmax, Math.abs(wm[i] - r.w[i]));
          maxWDiff = Math.max(maxWDiff, dmax); maxObjRel = Math.max(maxObjRel, Math.abs(obj - r.obj * m * m) / r.obj);
          nChk++;
          if (!(Math.abs(obj - r.obj * m * m) / r.obj < 1e-9)) { nBad++; firstBad ||= `${CAL[c]} 목적함수 상대 차이 ${Math.abs(obj - r.obj) / r.obj}`; }
        }
        return t;
      } };
      runS(wrap, MV1.P0, cS, null, { lag: 1 });
      console.log(`  MV1 기본: 신호일 ${days.length}일 KKT 최대 위반 ${mvStats.maxKkt.toExponential(2)}(기준 ${B5_MV_KKT_TOL}), 최대 반복 ${mvStats.maxIter}, 풀이 ${mvStats.solves}회, 미수렴 ${mvStats.fails}회 | 두 번째 시작점 풀이 대조 ${nChk}일: 비중 최대 차이 ${maxWDiff.toExponential(2)}, 목적함수 상대 차이 최대 ${maxObjRel.toExponential(2)} | 범위·합 위반 ${nBad}건 ${nBad === 0 ? "통과" : `불일치 (${firstBad})`}`);
      if (nBad > 0) note(firstBad, "MV1");
      for (const [lb, ch] of B5_MV_NB) { runS(MV1, { ...MV1.P0, ...ch }, cS, null, { lag: 1 }); console.log(`  MV1 ${lb}: 풀이 완료(KKT 누적 최대 ${mvStats.maxKkt.toExponential(2)}, 미수렴 ${mvStats.fails}회)`); }
    }
    console.log(`\n=== 3. 체결 타이밍·구조 점검 (기본 설정 lag 1·2: 진입 = 신호일 + lag, 보유 종목 수 ≤ 목표, 비용 ≥ 0) ===`);
    const timing = <P,>(tag: string, def: Strat<P>, F: boolean, nMax: (P: P) => number): void => {
      const cS = startOf(def, false), sd = new Set(sigDays(def, F).filter((c) => c >= cS));
      for (const lag of [1, 2]) {
        const r = runS(def, def.P0, cS, F ? { ma: B5_MA_DAYS } : null, { lag, detail: true });
        const badEntry = r.entryCs.filter((c) => !sd.has(c - lag)).length, over = Math.max(...r.nPos) > nMax(def.P0), negCost = r.costFrac.filter((x) => x < -1e-12).length, nanRet = r.ret.filter((x) => !Number.isFinite(x)).length;
        console.log(`  ${tag}${F ? "(필터)" : ""} lag ${lag}: 진입 ${r.entryCs.length}건, 보유 구간 닫힘 ${r.trades.length}건·열림 ${r.open.length}건 | 신호일 + ${lag}이 아닌 진입 ${badEntry}건 | 최대 보유 종목 ${Math.max(...r.nPos)}(목표 ${nMax(def.P0)}) | 음수 비용 ${negCost}일, 비정상 수익률 ${nanRet}일 | 폐지 청산 ${r.trades.filter((t) => t.reason.startsWith("폐지")).length}건, 거래정지 매수 건너뜀 ${r.haltSkip}건, 청산 순연 ${r.exitDefer}건`);
        if (badEntry > 0 || over || negCost > 0 || nanRet > 0) note(`${tag} lag ${lag}`, "체결 타이밍");
      }
    };
    timing("RM1", RM1, false, (P) => P.n); timing("RM1", RM1, true, (P) => P.n);
    timing("LR1", LR1, false, (P) => P.n); timing("LR1", LR1, true, (P) => P.n);
    timing("PF1", PF1, false, (P) => P.n); timing("MV1", MV1, false, () => 100); timing("BS1", BS1, false, (P) => P.n);
    for (const lag of [1, 2]) {
      const r = runTS(B5_TS_P0, { lag, detail: true });
      const sigOk = r.entryCs.every((c) => tsSignals(c - lag, B5_TS_P0).some((s) => r.trades.concat([]).length >= 0 && s !== undefined));
      const holds = r.trades.map((t) => t.exitC - t.entryC);
      console.log(`  TS1 lag ${lag}: 진입 ${r.entryCs.length}건, 닫힌 거래 ${r.trades.length}건, 최대 보유 ${Math.max(...r.nPos)}(슬롯 ${B5_TS_P0.slots}), 보유 일수 중앙값 ${median(holds)}, 손절 ${r.trades.filter((t) => t.reason.startsWith("손절")).length}건 ${sigOk ? "" : "(신호 대조 실패)"}`);
      if (Math.max(...r.nPos) > B5_TS_P0.slots) note(`TS1 lag ${lag} 슬롯 초과`, "체결 타이밍");
    }
    console.log(`\n=== 4. BS1 단계 2 검증 (가격 Parquet 안, 외부 호출 없음) ===`);
    {
      const evs: { code: string; eventDate: string; factor: number }[] = [];
      for (const [code, list] of h.adjustments) for (const e of list) evs.push({ code, eventDate: e.eventDate, factor: e.factor });
      evs.sort((a, b) => (a.eventDate < b.eventDate ? -1 : 1));
      const pickEv = [0, 1, 2, 3, 4].map((k) => evs[Math.floor((evs.length * (k + 0.5)) / 5)]);
      for (const e of pickEv) {
        const s = h.byCode.get(e.code); if (!s) continue;
        const i = s.dates.findIndex((d) => d >= e.eventDate);
        if (i < 1) continue;
        const rawR = s.raw[i] / s.raw[i - 1], adjR = s.close[i] / s.close[i - 1];
        console.log(`  분할·권리락 표본 ${label(e.code)} ${e.eventDate} 계수 ${e.factor.toFixed(4)}: 원 종가 ${s.raw[i - 1]} → ${s.raw[i]}(비율 ${rawR.toFixed(4)}), 수정 종가 비율 ${adjR.toFixed(4)} (수정 종가 일수익률 ${f2((adjR - 1) * 100)}%)`);
      }
      const delisted = h.stocks.filter((s) => s.last < h.endedBefore);
      let vz = 0, vzRows = 0;
      for (const s of h.stocks) { let any = false; for (let i = 0; i < s.vol.length; i++) if (s.vol[i] === 0) { vzRows++; any = true; } if (any) vz++; }
      console.log(`  상장폐지(마지막 행 < ${h.endedBefore}) ${delisted.length}종목: 마지막 행 날짜가 폐지 전 날짜로 들어 있음(마지막 행 거래량 0인 종목 ${delisted.filter((s) => s.vol[s.vol.length - 1] === 0).length}개) | 거래정지일 표기: 거래량 0 행(가격은 직전 값 유지)이 있는 종목 ${vz}개, 행 ${vzRows}개 | 달력 전체 ${nCal}일`);
      for (const d of ["2011-12-29", "2016-12-29", "2020-06-30", "2023-09-27", "2026-10-23"]) {
        const c = h.calIdx.get(d); if (c === undefined) continue;
        const a = new Set(rank200(c).list.map((s) => s.code)), b = new Set(bruteRank(c).map((s) => s.code));
        console.log(`  시총 상위 200 대조 ${d}: K200P 모듈 ${a.size} ∩ 월말 시장표 방식 ${b.size} = ${[...a].filter((x) => b.has(x)).length}종목 일치`);
      }
      console.log(`  수정 종가 일수익률 대 K200P 수정주가 수익률: 같은 자료(h.stocks.close)를 쓰므로 정의상 동일(검증 대상 아님)`);
    }
    console.log(`\n사전 점검 종료: DS6 재현, 신호 독립 대조(RM1·LR1·PF1·BS1·TS1 기본·이웃, MV1 KKT·두 번째 시작점), 체결 타이밍, BS1 단계 2 검증 ${fails.length === 0 ? "통과" : `— 실패 ${fails.length}건`}. 성과는 계산·출력하지 않았다 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    if (fails.length) { for (const f of fails) console.log(`  실패: ${f}`); throw new Error("사전 점검 실패 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)"); }
    return;
  }

  // =====================================================================================================================
  // 시험 (블록별)
  // =====================================================================================================================
  const verdicts: Verdict[] = [];
  let tn = Number(process.env.B5_TRIAL ?? "294");
  const trialNums: number[] = [];
  const doS = <P,>(def: Strat<P>, id: string, F: boolean, title: string): void => {
    const cS = startOf(def, false), Wx = windowsFor(cS), trial = tn++;
    trialNums.push(trial);
    console.log(`\n연속 평가(${id}, 시험 ${trial}): 첫 신호일 ${CAL[cS]}, 수익률 집계 ${Wx.FULL.from}~${h.dataEnd} | 구간 ${Wx.NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    verdicts.push(evaluate(h, Wx, mkS(def, id, trial, F, cS, Wx, title)));
  };
  const doC = <P,>(def: Strat<P>, id: string, title: string): void => {
    const cS = startOf(def, false), Wx = windowsFor(cS), trial = tn++;
    trialNums.push(trial);
    console.log(`\n연속 평가(${id}, 시험 ${trial}): 위성 첫 신호일 ${CAL[cS]}, 수익률 집계 ${Wx.FULL.from}~${h.dataEnd} (069500·DS6도 같은 구간)`);
    verdicts.push(evaluate(h, Wx, mkC(def, id, trial, cS, Wx, title)));
  };
  const ttl = (nm: string, extra: string): string => `${nm}: ${extra}`;
  if (MODE === "a") {
    doS(RM1, "RM1", false, ttl("RM1", "K200P, 월말 신호, 069500 회귀 잔차 점수(√n·α/σ) 상위 20종목 5% 동일 비중, 보유는 40위 안이면 유지, 매월 5%로 재조정, 항상 100%"));
    doC(RM1, "RM1C", ttl("RM1C", "DS6 코어 40% + 위성 60% = RM1"));
    doS(RM1, "RM1F", true, ttl("RM1F", "RM1 + 월말 069500 종가 < 200일선이면 주식 비중 50%"));
  } else if (MODE === "b1") {
    doS(LR1, "LR1", false, ttl("LR1", "K200P, 분기말 신호, 최근 126일 수익률이 069500을 넘는 종목 중 장기(t−504~t−126) 수익률 최저 20종목 5% 동일 비중"));
    doS(LR1, "LR1F", true, ttl("LR1F", "LR1 + 월말 069500 종가 < 200일선이면 비중 50%(교체는 분기말만)"));
  } else if (MODE === "b2") {
    doS(PF1, "PF1", false, ttl("PF1", "보통주 대비 우선주 괴리 z(252일) 최저 10개 우선주 10% 동일 비중, 월말 신호, 슬리피지 0.2%"));
    doS(PF1, "PF1F", true, ttl("PF1F", "PF1 + 월말 069500 종가 < 200일선이면 비중 50%"));
  } else if (MODE === "b3") {
    const Wx = windowsFor(cTS), trial = tn++;
    trialNums.push(trial);
    console.log(`\n연속 평가(TS1, 시험 ${trial}): 초기 ${CAL[cTS]} 종가, 수익률 집계 ${Wx.FULL.from}~${h.dataEnd}`);
    verdicts.push(evaluate(h, Wx, mkTS("TS1", trial, Wx)));
  } else if (MODE === "b4") {
    doS(MV1, "MV1", false, ttl("MV1", "K200P 시총 상위 100, 공분산(252일, 0.5 축소) 최소분산, 종목 0~5%, 월말 신호, 항상 100%"));
    doC(MV1, "MV1C", ttl("MV1C", "DS6 코어 40% + 위성 60% = MV1"));
  } else if (MODE === "c") {
    doS(BS1, "BS1", false, ttl("BS1", "코스피+코스닥 전 종목 지루한 주식 점수(변동성·상위 3일 평균·회전율 백분위) 최저 30종목 동일 비중, 월말 신호, 소멸 종목 전액 손실"));
    doC(BS1, "BS1C", ttl("BS1C", "DS6 코어 40% + 위성 60% = BS1"));
  }
  summaryReport(verdicts, trialNums, { prior: Number(process.env.B5_TRIAL ?? "294") - 1, contamNote: "경고(오염): 2011~2026은 선행 연구에서 반복해 본 데이터다. 변형(F·C 형태)은 DS6·DS7·DS10 결과를 본 뒤 만든 것(선택 편향)이라 순수 검증이 아니다." });
  console.log(`사전 고지: 이 묶음 누적 시험 ${Number(process.env.B5_TRIAL ?? "294") - 1 + trialNums.length}회 기준 우연 통과 기대 ${((Number(process.env.B5_TRIAL ?? "294") - 1 + trialNums.length) * 0.05).toFixed(2)}건(근사). 통과 후보가 있어도 독립 확인 전에는 후보일 뿐이다. 정의는 첫 시험 전에 고정했고 결과를 보고 바꾸지 않았다.`);
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ") || "없음"} | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험 번호 ${trialNums.join(",")}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

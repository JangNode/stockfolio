/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 DS10(시도 276)·DS11(시도 277). 사전 등록: docs/research/ds10-ds11-prereg.md.
 * 기본은 DS6(코어 40% = 월말 K200P 안 당일 시총 상위 2종목 시총 비율·교체 순위 밖 5거래일 연속일 때만 / 위성 60% = LV1 단독 / 일별 목표 비중 리밸 이동 비용 0.25%).
 * DS10 = 069500 200일선 위/아래 국면(5거래일 연속 확인)에 따라 코어 비중을 60/20%로 바꾼다. DS11 = 코어를 K200P 시총 상위 10종목 중 126일 수익률 상위 2종목으로 고른다.
 * ALLOC_MODE=repro: 재현·구조 자체 점검만(DS10·DS11 성과 미계산, DS6 일관성만 계산) / ds10 / ds11: 해당 후보 시험 1회. 공시·DART 사용 없음.
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
import { DS89_RUN_START, DS89_WINDOWS, DS89_DS6_REF, DS89_CORE_W, DS89_F_DENOMINATOR, DS89_SAMSUNG } from "@/lib/ds89Config";
import { DS10_TRIAL, DS11_TRIAL, DS10_SMA, DS10_CONFIRM_DAYS, DS10_WARM_CORE, DS10_UP_CORE, DS10_DOWN_CORE, DS10_NB_SMA, DS10_NB_UP_CORE, DS10_NB_DOWN_CORE, DS11_CAND, DS11_WIN, DS11_CORE_N, DS11_NB_CAND, DS11_NB_WIN, DS1011_REC } from "@/lib/ds1011Config";
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
  if (MODE !== "repro" && MODE !== "ds10" && MODE !== "ds11") throw new Error("ALLOC_MODE=repro|ds10|ds11 필요");
  const REPRO = MODE === "repro";
  console.log(`연구 DS10(시도 ${DS10_TRIAL})·DS11(시도 ${DS11_TRIAL}) ${REPRO ? "사전 점검(재현·구조 자체 점검만, DS10·DS11 성과 미계산)" : `시험 ${MODE.toUpperCase()} 1회`} 시작(읽기 전용): ${new Date().toISOString()}`);
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
  const simCore = (N: number, o: { lag: number; replace?: Set<string>; onDay?: (c: number, V: number, held: [string, number][]) => void; exclude?: ReadonlySet<string>; dropTop?: number; /** 연구 DS11: 목표 종목 목록(길이 N, 우선순위 순)을 직접 고른다 */ pick?: (c: number) => S[]; /** 연구 DS11: 비중을 체결일 시총 비율로 맞춘다(없으면 신호일 시총) */ mcAtExec?: boolean; /** 연구 DS9: 코어 안 종목당 상한 비중(없으면 DS6과 같은 시총 비율) */ capW?: number }): CoreRun => {
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
          const mcx = o.mcAtExec ? final.map((code) => mcapNear(byCode.get(code) as S, c)) : null;
          const mcv = mcx && mcx.every((x) => Number.isFinite(x) && x > 0) ? mcx : final.map((code) => ev.mc.get(code) as number);
          const mcOf = new Map(final.map((code, j) => [code, mcv[j]] as [string, number]));
          const sumMc = mcv.reduce((a, x) => a + x, 0);
          let V0 = cash;
          for (const p of pos.values()) V0 += val(p);
          const tw = o.capW === undefined ? mcv.map((x) => x / sumMc) : capWeights(mcv, o.capW);
          const twOf = new Map(final.map((code, j) => [code, tw[j]] as [string, number]));
          const target = (code: string): number => (o.capW === undefined ? (V0 * (mcOf.get(code) as number)) / sumMc : V0 * (twOf.get(code) as number));
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
        const top = o.pick ? o.pick(c) : megaAt(c, CS_RANK_DEPTH).list.filter((s) => !o.exclude?.has(s.code)).slice(o.dropTop ?? 0, (o.dropTop ?? 0) + N), topSet = new Set(top.map((s) => s.code));
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
  const coreOf = (N: number, capW: number | undefined, lag: number, o: { repl?: Set<string>; exclude?: ReadonlySet<string>; pick?: (c: number) => S[]; pickKey?: string; mcAtExec?: boolean } = {}): CoreX => {
    const key = `${N}|${capW ?? "-"}|${lag}|${replKey(o.repl)}|${o.exclude ? [...o.exclude].sort().join(",") : ""}|${o.pickKey ?? "-"}`;
    let v = coreCache.get(key);
    if (!v) {
      const run = simCore(N, { lag, replace: o.repl, exclude: o.exclude, capW, pick: o.pick, mcAtExec: o.mcAtExec });
      const sl = slice(run);
      if (sl.dates.length !== nDays || sl.dates.some((d, k) => d !== dates0[k])) throw new Error("코어와 LV1의 날짜 축이 다르다");
      v = { run, sl }; coreCache.set(key, v);
    }
    return v;
  };
  const coreTradesAll = (r: CoreRun): SimTrade[] => [...r.trades, ...r.open].filter((t) => CAL[t.exitC] >= FULL.from);
  const coreReplSet = (r: CoreRun): Set<string> => new Set(coreTradesAll(r).sort((a, b) => pnlOf(b) - pnlOf(a)).slice(0, F_E_TOP_TRADES).map((t) => `${t.code}|${t.entryC}`));
  /** 날짜별 코어 안 보유 종목 비중(코어 평가액 대비). */
  const coreHolds = (N: number, capW: number | undefined, exclude?: ReadonlySet<string>, ex: { pick?: (c: number) => S[]; mcAtExec?: boolean } = {}): [string, number][][] => {
    const arr: [string, number][][] = new Array(nDays).fill(null).map(() => []);
    simCore(N, { lag: 1, capW, exclude, pick: ex.pick, mcAtExec: ex.mcAtExec, onDay: (c, V, held) => { const i = dateIdx.get(CAL[c]); if (i !== undefined) arr[i] = held.map(([code, v]) => [code, v / V]); } });
    return arr;
  };
  const evLine = (r: CoreRun): string => r.events.map((e) => `${CAL[e.c]} ${e.sells.length ? `${e.sells.map(label).join("+")} → ` : ""}${e.buys.length ? e.buys.map(label).join("+") : "비중 조정"} [${e.set.map((code, j) => `${nameOf.get(code) ?? code} ${f2(e.w[j] * 100)}%`).join(" / ")}]`).join("\n    ");

  // ---- 코어-위성 합성: 코어 비중 w, 위성 1 − w, 매일 종가에 목표 비율 계산 → 다음 거래일 종가에 고정 금액 이동(연구 ALLOC P형과 같은 방식), 이동 금액의 CS_MOVE_COST ----
  interface CombOut { run: SimRun; wCore: number[]; cost: number[]; moved: number[] }
  const combineCS = (core: Sl, sat: Sl, wCin: number | number[], rate: number, delay = 0): CombOut => {
    const wAt = (i: number): number => (typeof wCin === "number" ? wCin : wCin[i]), wC0 = typeof wCin === "number" ? wCin : DS10_WARM_CORE;
    // delay: 목표 비중 이동을 더 늦추는 거래일 수(0 = 종가 t에 계산해 t+1 종가 체결, 1 = t+2 종가 체결). 이동 중인 금액은 새 목표 계산에서 이미 반영된 것으로 본다.
    const parts = [core, sat], s = [wC0, 1 - wC0], q: number[][] = [];
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
      q.push([wAt(i) * V - s[0] - infl[0], (1 - wAt(i)) * V - s[1] - infl[1]]);
    }
    return { run: { dates: dates0, ret, costFrac, nPos, inv, turn: turn.map((v, i) => ({ d: dates0[i], v })), trades: [], entryCs: [], wMax, haltSkip: 0, exitDefer: 0 }, wCore, cost, moved };
  };


  // ---- 후보 정의 ----
  const ALLW = W.ALL;
  interface Regime { sma: number; upW: number; downW: number }
  interface Rs { cand: number; win: number }
  interface Def { id: string; trial: number; wC: number; regime?: Regime; rs?: Rs }
  const DS6D: Def = { id: "DS6", trial: 272, wC: DS89_CORE_W };
  const DS10D: Def = { id: "DS10", trial: DS10_TRIAL, wC: DS89_CORE_W, regime: { sma: DS10_SMA, upW: DS10_UP_CORE, downW: DS10_DOWN_CORE } };
  const DS11D: Def = { id: "DS11", trial: DS11_TRIAL, wC: DS89_CORE_W, rs: { cand: DS11_CAND, win: DS11_WIN } };
  interface Opts { coreLag?: number; satLag?: number; delay?: number; wC?: number; regime?: Partial<Regime>; rs?: Partial<Rs>; sigDelay?: boolean; replSat?: boolean; replCore?: boolean; exclude?: ReadonlySet<string> }

  // ---- DS10 국면 신호: 069500 지수(원주가 일수익 누적; 스파이크 정제 0건이라 원주가 종가와 비율이 같다) 종가 vs 단순이동평균 ----
  const bPos = new Map(h.bhP.dates.map((d, k) => [d, k]));
  const bCumReal = new Float64Array(h.bhP.dates.length + 1);
  bCumReal[0] = 1;
  h.bhP.ret.forEach((r, k) => { bCumReal[k + 1] = bCumReal[k] * (1 + r / 100); });
  /** 판단일 종가까지의 정보만 쓰는 원 상태: 종가 > 최근 sma거래일(당일 포함) 단순평균이면 U, 아니면 D. 이력이 모자라면 null. */
  const rawStates = (sma: number, cum: Float64Array): ("U" | "D" | null)[] => {
    const P = new Float64Array(cum.length + 1);
    for (let j = 0; j < cum.length; j++) P[j + 1] = P[j] + cum[j];
    return dates0.map((d) => {
      const k = bPos.get(d);
      if (k === undefined) return null;
      const j = k + 1;
      if (j + 1 < sma) return null;
      const m = (P[j + 1] - P[j + 1 - sma]) / sma;
      return cum[j] > m ? "U" : "D";
    });
  };
  /** 확인 상태 기계: 워밍업 warm일(평가 시작 후)은 W(DS6 40:60) 고정이고 상태 판정·연속 일수 계산도 그 뒤부터. 현재 확정 상태와 다른 원 상태가 confirm거래일 연속이면 그날 종가에 확정(체결은 다음 거래일 종가). */
  const confirmStates = (raw: ("U" | "D" | null)[], warm: number, confirm: number): ("W" | "U" | "D")[] => {
    const out: ("W" | "U" | "D")[] = [];
    let conf: "W" | "U" | "D" = "W", cand: "U" | "D" | null = null, cnt = 0;
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      if (i >= warm && r !== null) {
        if (r === conf) { cand = null; cnt = 0; } else {
          if (cand === r) cnt++; else { cand = r; cnt = 1; }
          if (cnt >= confirm) { conf = r; cand = null; cnt = 0; }
        }
      }
      out.push(conf);
    }
    return out;
  };
  const regimePath = (r: Regime, sigDelay = false, cum: Float64Array = bCumReal): { w: number[]; st: ("W" | "U" | "D")[]; raw: ("U" | "D" | null)[] } => {
    const raw = rawStates(r.sma, cum), st = confirmStates(raw, r.sma, DS10_CONFIRM_DAYS);
    const w0 = st.map((x) => (x === "U" ? r.upW : x === "D" ? r.downW : DS10_WARM_CORE));
    return { w: sigDelay ? w0.map((_, i) => (i === 0 ? w0[0] : w0[i - 1])) : w0, st, raw };
  };

  // ---- DS11 코어 선택: 판단일 K200P 시총 상위 cand종목 중 최근 win거래일 수익률 상위 N종목(이력이 없는 종목은 뒤로, 같은 값은 시총 큰 순) ----
  const alignedAll = new Map<string, Float64Array>();
  const alignedOf = (code: string): Float64Array => { let a = alignedAll.get(code); if (!a) { const s = byCode.get(code) as S; a = alignCloses(CAL, s.idx, s.close); alignedAll.set(code, a); } return a; };
  const rsPick = (rs: Rs, N: number, exclude?: ReadonlySet<string>): ((c: number) => S[]) => {
    const cache = new Map<number, S[]>();
    return (c) => {
      let v = cache.get(c);
      if (!v) {
        const sc = megaAt(c, CS_RANK_DEPTH).list.filter((s) => !exclude?.has(s.code)).slice(0, rs.cand).map((s, k) => {
          const a = alignedOf(s.code);
          return { s, k, r: c - rs.win >= 0 && a[c] > 0 && a[c - rs.win] > 0 ? a[c] / a[c - rs.win] - 1 : Number.NaN };
        });
        sc.sort((x, y) => {
          const fx = Number.isFinite(x.r), fy = Number.isFinite(y.r);
          if (fx !== fy) return fx ? -1 : 1;
          if (fx && y.r !== x.r) return y.r - x.r;
          return x.k - y.k;
        });
        v = sc.slice(0, N).map((x) => x.s);
        cache.set(c, v);
      }
      return v;
    };
  };
  const coreFor = (d: Def, o: Opts, lag: number, repl?: Set<string>): CoreX => {
    const rs = d.rs ? { ...d.rs, ...o.rs } : undefined;
    if (!rs) return coreOf(2, undefined, lag, { repl, exclude: o.exclude });
    return coreOf(DS11_CORE_N, undefined, lag, { repl, exclude: o.exclude, pick: rsPick(rs, DS11_CORE_N, o.exclude), pickKey: `rs${rs.cand}_${rs.win}`, mcAtExec: true });
  };
  interface Built { res: CombOut; coreX: CoreX; satX: { run: SimRun; sl: Sl }; rp: ReturnType<typeof regimePath> | null; wC: number }
  const build = (d: Def, o: Opts = {}): Built => {
    const wC = o.wC ?? d.wC, reg = d.regime ? { ...d.regime, ...o.regime } : undefined, rp = reg ? regimePath(reg, !!o.sigDelay) : null;
    const satX = lv1Of(o.satLag ?? 1, undefined, o.replSat ? lv1ReplSet() : undefined);
    const coreX = o.replCore ? coreFor(d, o, 1, coreReplSet(coreFor(d, o, 1).run)) : coreFor(d, o, o.coreLag ?? 1);
    return { res: combineCS(coreX.sl, satX.sl, rp ? rp.w : wC, CS_MOVE_COST, o.delay ?? 0), coreX, satX, rp, wC };
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
  // 1. 사전 점검 (성과 아님): LV1 재현, DS10 상태 기계·미래 정보 미사용, DS11 선택·회계, DS6 일관성
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


  console.log(`\n=== 1b. DS10 국면 상태 기계 점검 (성과 아님) ===`);
  {
    // (a) 합성 입력: warm 2, confirm 5. 처음 2일 무시, 5일 연속이어야 확정, 중간에 끊기면 처음부터 다시 센다.
    const U = "U" as const, D = "D" as const;
    const t1 = confirmStates([U, U, U, U, U, U, U, U], 2, 5).join("");
    const t2 = confirmStates([U, U, U, U, U, U, D, D, D, D, U, D, D, D, D, D, U, U], 0, 5).join("");
    const t3 = confirmStates([U, D, U, D, U, D, U, D, U, D, U, D], 0, 5).join("");
    const okS = t1 === "WWWWWWUU" && t2 === "WWWWUUUUUUUUUUUDDD" && t3 === "WWWWWWWWWWWW";
    console.log(`  (a) 합성: warm 2·U×8 → ${t1} (기대 WWWWWWUU), U×6·D×4·U·D×5·U·U → ${t2} (기대 WWWWUUUUUUUUUUUDDD), 번갈아 U/D → ${t3} (기대 W만) ${okS ? "통과" : "불일치"}`);
    if (!okS) throw new Error("상태 기계 합성 점검 실패 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)");
    // (b) 미래 정보 미사용: i0 이후 069500 값을 임의로 바꿔도 i0 이전(포함) 원 상태·확정 상태·목표 비중이 같다
    const base = regimePath({ sma: DS10_SMA, upW: DS10_UP_CORE, downW: DS10_DOWN_CORE });
    const i0 = 1800, k0 = bPos.get(dates0[i0]) as number, pert = Float64Array.from(bCumReal);
    for (let j = k0 + 2; j < pert.length; j++) pert[j] *= 1 + 0.5 * Math.sin(j);
    const pp = regimePath({ sma: DS10_SMA, upW: DS10_UP_CORE, downW: DS10_DOWN_CORE }, false, pert);
    let nDiff = 0;
    for (let i = 0; i <= i0; i++) if (pp.raw[i] !== base.raw[i] || pp.st[i] !== base.st[i] || pp.w[i] !== base.w[i]) nDiff++;
    let nAfter = 0;
    for (let i = i0 + 1; i < nDays; i++) if (pp.raw[i] !== base.raw[i]) nAfter++;
    console.log(`  (b) ${dates0[i0]} 이후 069500 값을 바꿔도 그날까지(${i0 + 1}일) 원 상태·확정 상태·목표 비중이 달라진 날 ${nDiff}일 (기대 0), 그 뒤 원 상태가 달라진 날 ${nAfter}일(점검이 민감함을 확인) ${nDiff === 0 && nAfter > 0 ? "통과" : "불일치"}`);
    if (nDiff !== 0 || nAfter === 0) throw new Error("상태 기계 미래 정보 점검 실패 — 중단하고 보고한다");
    // (c) 실제 상태 경로 구조: 상태별 일 수, 전환(확정) 횟수, 하루 지연 버전은 목표 비중이 하루 밀린 것
    const cnt = { W: 0, U: 0, D: 0 };
    base.st.forEach((x) => { cnt[x]++; });
    const sw: string[] = [];
    base.st.forEach((x, i) => { if (i > 0 && x !== base.st[i - 1]) sw.push(`${dates0[i]} ${base.st[i - 1]}→${x}`); });
    const dl = regimePath({ sma: DS10_SMA, upW: DS10_UP_CORE, downW: DS10_DOWN_CORE }, true);
    const okD = dl.w.every((x, i) => (i === 0 ? x === base.w[0] : x === base.w[i - 1]));
    const bd = build(DS10D), held = (lbl: "W" | "U" | "D"): number => avg(dates0.map((_, i) => i).filter((i) => i >= 2 && base.st[i - 2] === lbl).map((i) => bd.res.wCore[i - 1]));
    console.log(`  (c) 상태 일 수(확정 상태, 워밍업 W ${DS10_SMA}일 포함): W ${cnt.W} / 상승 U ${cnt.U} / 하락 D ${cnt.D}; 확정 전환 ${sw.length}회(W→첫 상태 포함, U↔D ${sw.filter((x) => !x.includes("W→") ).length}회): ${sw.join(", ")}\n      하루 지연 목표 = 하루 밀린 목표 ${okD ? "통과" : "불일치"} | 체결된 평균 코어 비중(2일 전 확정 상태별) W ${f2(held("W") * 100)}% / U ${f2(held("U") * 100)}% / D ${f2(held("D") * 100)}% (목표 40/60/20)`);
    if (!okD || Math.abs(held("W") - 0.4) > 0.03 || Math.abs(held("U") - 0.6) > 0.03 || Math.abs(held("D") - 0.2) > 0.03) throw new Error("DS10 목표 비중 구조 점검 실패 — 중단하고 보고한다");
  }

  console.log(`\n=== 1c. DS11 코어 선택·회계 점검 (성과 비교 아님) ===`);
  {
    // (a) 독립 계산: 판단일마다 h.stocks에서 직접 K200P(월말 PIT, 제외 규칙) 시총 상위 cand종목 → 최근 win일 수익률 순 상위 N종목을 구해 rsPick과 비교
    const lastRow = (s: S, c: number): number => { for (let k = c; k >= 0; k--) { const i = s.idx.get(CAL[k]); if (i !== undefined) return s.close[i]; } return Number.NaN; };
    const brute = (c: number, rs: Rs): string[] => {
      const d = CAL[c], m = membAt(d), e: { s: S; mc: number }[] = [];
      if (m) for (const s of h.stocks) { const i = s.idx.get(d); if (i !== undefined && !excluded.has(s.code) && m.get(s.code) === "KOSPI") e.push({ s, mc: s.mcapRow[i] }); }
      e.sort((a, b) => b.mc - a.mc || (a.s.code < b.s.code ? -1 : 1));
      const cands = e.slice(0, rs.cand).map((x, k) => { const a = lastRow(x.s, c), b = c - rs.win >= 0 ? lastRow(x.s, c - rs.win) : Number.NaN; return { code: x.s.code, k, r: a > 0 && b > 0 ? a / b - 1 : Number.NaN }; });
      cands.sort((x, y) => { const fx = Number.isFinite(x.r), fy = Number.isFinite(y.r); if (fx !== fy) return fx ? -1 : 1; if (fx && y.r !== x.r) return y.r - x.r; return x.k - y.k; });
      return cands.slice(0, DS11_CORE_N).map((x) => x.code);
    };
    for (const rs of [DS11D.rs as Rs, { cand: DS11_NB_CAND[0], win: DS11_WIN }, { cand: DS11_NB_CAND[1], win: DS11_WIN }, { cand: DS11_CAND, win: DS11_NB_WIN[0] }, { cand: DS11_CAND, win: DS11_NB_WIN[1] }]) {
      const pk = rsPick(rs, DS11_CORE_N);
      let nBad = 0, nChk = 0, nNoHist = 0;
      for (let c = cPE; c < nCal; c++) {
        const a = pk(c).map((s) => s.code), b = brute(c, rs);
        nChk++;
        if (a.length !== DS11_CORE_N || new Set(a).size !== a.length || a.join() !== b.join()) nBad++;
        if (c - rs.win < 0) nNoHist++;
      }
      console.log(`  선택 독립 계산 (후보 ${rs.cand}종목, 수익률 창 ${rs.win}일): ${nChk}일 중 불일치 ${nBad}일 (이력 부족으로 시총 순서 대체된 날 ${nNoHist}일) ${nBad === 0 ? "통과" : "불일치"}`);
      if (nBad > 0) throw new Error("DS11 선택 독립 계산 불일치 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)");
    }
    // (b) 회계: 이벤트 없는 구간에서 시뮬레이터 일수익률 = 독립 계산, 목표 비중 = 체결일 시총 비율(독립 계산)
    for (const rs of [DS11D.rs as Rs, { cand: DS11_NB_CAND[0], win: DS11_WIN }, { cand: DS11_NB_CAND[1], win: DS11_WIN }, { cand: DS11_CAND, win: DS11_NB_WIN[0] }, { cand: DS11_CAND, win: DS11_NB_WIN[1] }]) {
      const r = coreOf(DS11_CORE_N, undefined, 1, { pick: rsPick(rs, DS11_CORE_N), pickKey: `rs${rs.cand}_${rs.win}`, mcAtExec: true }).run, ret = new Map(r.dates.map((d, i) => [d, r.ret[i]]));
      let maxDiff = 0, nChk = 0, maxTw = 0, maxReal = 0;
      r.events.forEach((ev, k) => {
        const c0 = ev.c, c1 = k + 1 < r.events.length ? r.events[k + 1].c : nCal, ss = ev.set.map((code) => byCode.get(code) as S);
        const px = (c: number): number[] | null => { const a: number[] = []; for (const s of ss) { const i = s.idx.get(CAL[c]); if (i === undefined) return null; a.push(s.close[i]); } return a; };
        const mc = ss.map((s) => mcapNear(s, c0)), sm = mc.reduce((a, x) => a + x, 0);
        maxTw = Math.max(maxTw, ...ev.tw.map((x, j) => Math.abs(x - mc[j] / sm)));
        maxReal = Math.max(maxReal, ...ev.w.map((x, j) => Math.abs(x - ev.tw[j])));
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
      console.log(`  코어(후보 ${rs.cand}, 창 ${rs.win}일): 이벤트 ${r.events.length}회(교체 ${r.events.filter((e) => e.sells.length).length}회) | 폐지 강제 청산 ${r.forcedExit}건 | 거래정지 순연 ${r.haltSkip}건 | 회계 점검 ${nChk}일 최대 차이 ${maxDiff.toExponential(2)}%p ${maxDiff <= CS_ACCOUNTING_TOL_PP ? "통과" : "불일치"} | 목표 비중 vs 체결일 시총 비율(독립) 최대 차이 ${maxTw.toExponential(2)} | 체결 직후 실제 비중과 목표 차이 ${f2(maxReal * 100)}%p`);
      if (!(maxDiff <= CS_ACCOUNTING_TOL_PP) || r.forcedExit > 0 || !(maxTw <= 1e-12) || maxReal > 0.03) throw new Error("DS11 코어 구조·회계 점검 실패 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)");
    }
  }

  // ---- DS6 기본 계좌 일관성 (DS6 기록: 연속 전체 11.70 / 39.15, 구간 1 4.10 / 24.51(기록과 같은 CAGR 기간), 롤링 92.81% / 32.03%) ----
  const b6 = build(DS6D);
  {
    const sF = h.st(b6.res.run, FULL), s1 = h.st(b6.res.run, { from: FULL.from, to: "2016-12-30" }), s1b = h.st(b6.res.run, NW[0][1]);
    const rr = rollRows(b6.res.run.ret);
    const ok = f2(sF.cagr) === f2(DS89_DS6_REF.전체[0]) && f2(sF.mdd) === f2(DS89_DS6_REF.전체[1]) && f2(s1.cagr) === f2(DS89_DS6_REF.구간1[0]) && f2(s1.mdd) === f2(DS89_DS6_REF.구간1[1]) && f2(rr.cagrShare) === f2(DS89_DS6_REF.rollCagrShare) && f2(rr.mddShare) === f2(DS89_DS6_REF.rollMddShare);
    console.log(`\nDS6 기본 계좌 일관성: 연속 전체 ${f2(sF.cagr)} / ${f2(sF.mdd)} (기록 ${DS89_DS6_REF.전체.join(" / ")}), 구간 1(기록과 같은 CAGR 기간 ${FULL.from}~2016-12-30) ${f2(s1.cagr)} / ${f2(s1.mdd)} (기록 ${DS89_DS6_REF.구간1.join(" / ")}; 사용자 지정 끝 ${NW[0][1].to}로 세면 ${f2(s1b.cagr)} / ${f2(s1b.mdd)}), 롤링 3년 창 ${rr.n}개 중 069500보다 CAGR 높은 창 ${f2(rr.cagrShare)}% (기록 ${DS89_DS6_REF.rollCagrShare}%) · MDD 작은 창 ${f2(rr.mddShare)}% (기록 ${DS89_DS6_REF.rollMddShare}%) → ${ok ? "일치" : "불일치"}`);
    if (!ok) throw new Error("DS6 기록과 다르다 — 중단하고 보고한다");
  }
  if (REPRO) {
    console.log(`\n사전 점검 종료: LV1 재현, DS10 상태 기계(합성·미래 정보 미사용·목표 비중 구조), DS11 선택 독립 계산·코어 회계(후보 5/10/15, 창 63/126/252), DS6 기본 계좌 일관성(연속 전체 11.70 / 39.15, 구간 1 4.10 / 24.51, 롤링 92.81% / 32.03%) 통과. DS10·DS11 성과는 계산·출력하지 않았다 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    return;
  }
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


  // =====================================================================================================================
  // 2. 시험 (후보 1개, 게이트 A~H)
  // =====================================================================================================================
  const REC = DS1011_REC;
  const recCell = (r: readonly number[]): string => `${f2(r[0])} / ${f2(r[1])}`;

  const mkSpec = (d: Def, nbs: { label: string; run: () => SimRun }[], notes: string[], extra: (run: SimRun, base: Built) => void): CandSpec => {
    let drawK = 0;
    const base = build(d);
    return {
      id: d.id, trial: d.trial,
      title: d.regime
        ? `DS10: DS6 + 069500 ${d.regime.sma}일선 국면(${DS10_CONFIRM_DAYS}거래일 연속 확인, 워밍업 ${d.regime.sma}일은 40:60) 상승 코어 ${d.regime.upW * 100} / LV1 ${100 - d.regime.upW * 100}, 하락 코어 ${d.regime.downW * 100} / LV1 ${100 - d.regime.downW * 100}, 이동액 비용 ${CS_MOVE_COST * 100}%`
        : `DS11: DS6 + 코어 선택 = K200P 시총 상위 ${d.rs?.cand}종목 중 최근 ${d.rs?.win}거래일 수익률 상위 ${DS11_CORE_N}종목 시총가중(보유 종목이 상대강도 상위 ${DS11_CORE_N}위 밖이거나 시총 상위 ${d.rs?.cand}위 밖인 상태가 ${CS_SWAP_CONFIRM_DAYS}거래일 연속일 때만 교체, 체결일 시총 비율)`,
      defense: false, capFrac: 1 / 10, fDenominator: DS89_F_DENOMINATOR, ref: { id: "069500", run: bhAsRun },
      hRule: (full, rb) => { const a = hVs(full, rb); return { ok: a.ok, note: `[사전등록: 069500만 판정] 069500 ${f2(rb.cagr)} / ${f2(rb.mdd)} → ${a.ok ? "O" : "X"} (${a.text})` }; },
      run: (o) => {
        const repl = !!o.replace, b = repl ? build(d, { replSat: true }) : build(d, { coreLag: o.lag, satLag: o.lag, sigDelay: o.lag >= 2 });
        const r: SimRun = { ...b.res.run }, sat = b.satX.run, core = b.coreX.run;
        r.trades = [...sat.trades.map((t) => ({ ...t, vAtEntry: t.vAtEntry / (1 - d.wC) })), ...core.trades.map((t) => ({ ...t, vAtEntry: t.vAtEntry / d.wC }))];
        r.entryCs = [...sat.entryCs, ...core.entryCs]; r.haltSkip = sat.haltSkip + core.haltSkip; r.exitDefer = sat.exitDefer + core.exitDefer;
        return r;
      },
      neighbors: nbs,
      random: () => {
        const dr = randOf()[drawK++ % KSS_R3_DRAWS];
        return combineCS(base.coreX.sl, { ...zeroSl, ret: Array.from(dr.full.subarray(dr.k0)) }, base.rp ? base.rp.w : d.wC, CS_MOVE_COST).run;
      },
      reasons: [], label,
      extra: (run) => {
        for (const nn of notes) console.log(nn);
        console.log(`${d.id} 게이트 C 해석(사전등록): 코어·LV1 체결을 모두 하루 지연(lag 2)${d.regime ? "하고 국면 목표 비중도 하루 늦춰(확정 상태의 목표 비중이 하루 뒤에 효력)" : ""} 같은 합성 규칙으로 돌린다(일별 40:60 목표 이동 자체는 지연하지 않음). CAGR 하락 ≤ 1%p ∧ MDD 악화 ≤ 2%p.`);
        console.log(`${d.id} 게이트 E 해석(사전등록): 판정은 LV1의 평가 구간 닫힌 거래 중 손익 상위 3개를 069500 수익률로 바꾼 위성 + 실제 코어${d.regime ? "(국면 비중 그대로)" : ""}를 같은 합성 규칙으로 돌린 연속 전체 CAGR ≥ 069500. 코어 상위 3개·둘 다 대체는 보고만.`);
        console.log(`${d.id} 게이트 F 해석(사전등록): LV1 무작위 대조(같은 신호일·주문 수, 같은 청산 규칙, 시드 ${KSS_R3_SEED}, ${KSS_R3_DRAWS}회)를 실제 코어(고정)와 ${d.regime ? "국면 비중" : "40:60"}으로 합성한 분포 대비 ${d.id} 실제 CAGR의 백분위 ≥ 95.`);
        console.log(`${d.id} 게이트 G: 진입 건수 = LV1 진입 + 코어 진입의 합(연속 구간 전체; LV1 ${base.satX.run.entryCs.filter((c) => CAL[c] >= FULL.from).length} + 코어 ${base.coreX.run.entryCs.filter((c) => CAL[c] >= FULL.from).length}).`);
        console.log(`${d.id} 게이트 H 해석(사전등록): 기준선 069500만 판정(CAGR +${PEAD_H_CAGR_GAIN_PP}%p, 또는 MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p).`);
        const ds6 = b6.res.run;
        console.log(`\n=== ${d.id} vs DS6 · DS8 · DS9 vs 069500 (CAGR % / MDD %; DS6·DS8·DS9는 기록값, DS6 재계산은 기록과 일치) ===\n| 구간 | 069500 | DS6 | DS8 (${REC.DS8.결과}) | DS9 (${REC.DS9.결과}) | ${d.id} | ${d.id} − DS6 CAGR %p | ${d.id} − DS6 MDD %p | ${d.id} − 069500 CAGR %p | ${d.id} − 069500 MDD %p |\n|---|---|---|---|---|---|---|---|---|---|`);
        const recKey: (keyof typeof REC.DS6)[] = ["구간1", "구간2", "구간3", "전체"];
        ALLW.forEach(([wn, w], k) => {
          const a = h.st(h.bhP, w), s6 = h.st(ds6, w), sc = h.st(run, w);
          console.log(`| ${wn} | ${f2(a.cagr)} / ${f2(a.mdd)} | ${recCell(REC.DS6[recKey[k]] as readonly number[])} (재계산 ${f2(s6.cagr)} / ${f2(s6.mdd)}) | ${recCell(REC.DS8[recKey[k]] as readonly number[])} | ${recCell(REC.DS9[recKey[k]] as readonly number[])} | ${f2(sc.cagr)} / ${f2(sc.mdd)} | ${sg(sc.cagr - s6.cagr)} | ${sg(sc.mdd - s6.mdd)} | ${sg(sc.cagr - a.cagr)} | ${sg(sc.mdd - a.mdd)} |`);
        });
        console.log(`구간별 최악 12개월 %: ${ALLW.map(([wn, w]) => `${wn} — 069500 ${f2(h.worst12(h.bhP, w))}, DS6 ${f2(h.worst12({ dates: dates0, ret: ds6.ret }, w))}, ${d.id} ${f2(h.worst12(run, w))}`).join(" | ")}`);
        {
          const yrs: number[] = [];
          for (let y = Number(FULL.from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) yrs.push(y);
          console.log(`\n=== 연도별 수익률 % (일수익률 복리; ${yrs[0]}년은 ${FULL.from}부터, ${yrs[yrs.length - 1]}년은 ${h.dataEnd}까지) ===\n| 연도 | 069500 | DS6 | ${d.id} | ${d.id} − 069500 %p | ${d.id} − DS6 %p |\n|---|---|---|---|---|---|`);
          const ex: number[] = [];
          for (const y of yrs) {
            const a = h.yearRet({ dates: dates0, ret: bRetAxis }, y), c6 = h.yearRet({ dates: dates0, ret: ds6.ret }, y), cc = h.yearRet({ dates: dates0, ret: run.ret }, y);
            ex.push(cc - a);
            console.log(`| ${y} | ${f2(a)} | ${f2(c6)} | ${f2(cc)} | ${sg(cc - a)} | ${sg(cc - c6)} |`);
          }
          console.log(`${d.id} − 069500 승·패 연수: 승 ${ex.filter((x) => x > 0).length} / 패 ${ex.filter((x) => x < 0).length} (평균 ${sg(avg(ex))}%p, 중앙값 ${sg(median(ex))}%p)`);
        }
        {
          const r6 = rollRows(ds6.ret), rc = rollRows(run.ret);
          console.log(`\n=== 롤링 3년 창(월말 앵커 36개월 창을 한 달씩 이동, 창 ${rc.n}개, 서로 겹침) — DS6 기록 CAGR 우위 ${DS89_DS6_REF.rollCagrShare}% · MDD 우위 ${DS89_DS6_REF.rollMddShare}%, DS8 기록 ${REC.DS8.roll[0]}% · ${REC.DS8.roll[1]}%, DS9 기록 ${REC.DS9.roll[0]}% · ${REC.DS9.roll[1]}% ===`);
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
        {
          const bb = build(d), s6all = b6.res;
          console.log(`\n=== 투자 비중·회전·비용 (DS6 → ${d.id}) ===\n| 구간 | 평균 투자 비중 % | 연 회전율 % | 비용 합계 % (일별 비용 합) | 코어-위성 리밸 이동 금액 연 % | 리밸 비용 연 %p |\n|---|---|---|---|---|---|`);
          for (const [wn, w] of ALLW) {
            const idx: number[] = [];
            for (let i = 0; i < nDays; i++) if (dates0[i] >= w.from && dates0[i] <= (w.to > h.dataEnd ? h.dataEnd : w.to)) idx.push(i);
            const yr = yrsOf(w), s6 = h.st(ds6, w), sc = h.st(run, w);
            const mv6 = (idx.reduce((a, i) => a + s6all.moved[i], 0) * 100) / yr, mvc = (idx.reduce((a, i) => a + bb.res.moved[i], 0) * 100) / yr, cs6 = (idx.reduce((a, i) => a + s6all.cost[i], 0) * 100) / yr, csc = (idx.reduce((a, i) => a + bb.res.cost[i], 0) * 100) / yr;
            console.log(`| ${wn} | ${f2(s6.avgInv)} → ${f2(sc.avgInv)} | ${f2(s6.turnover)} → ${f2(sc.turnover)} | ${f2(s6.cost)} → ${f2(sc.cost)} | ${f2(mv6)} → ${f2(mvc)} | ${f2(cs6)} → ${f2(csc)} |`);
          }
        }
        {
          const full = h.st(run, FULL), bh = h.st(h.bhP, FULL);
          const satRep = h.st(build(d, { replSat: true }).res.run, FULL), coreRep = h.st(build(d, { replCore: true }).res.run, FULL), bothRep = h.st(build(d, { replSat: true, replCore: true }).res.run, FULL);
          console.log(`${d.id} E 보고 [위성 대체만 판정]: 원래 ${f2(full.cagr)} / ${f2(full.mdd)} | LV1 상위 3개 거래 대체 ${f2(satRep.cagr)} / ${f2(satRep.mdd)} (판정, 기준 ${f2(bh.cagr)}) | 코어 상위 3개 거래 대체 ${f2(coreRep.cagr)} / ${f2(coreRep.mdd)} (보고) | 둘 다 대체 ${f2(bothRep.cagr)} / ${f2(bothRep.mdd)} (보고)`);
          const lvT = [...lv1ReplSet()].map((k) => { const [code, ec] = k.split("|"); const t = base.satX.run.trades.find((x) => x.code === code && x.entryC === Number(ec)) as SimTrade; return `${label(code)} ${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`; });
          const ct = coreTradesAll(base.coreX.run).sort((a, c2) => pnlOf(c2) - pnlOf(a)).slice(0, F_E_TOP_TRADES);
          console.log(`  LV1 대체 거래: [${lvT.join(", ")}]`);
          console.log(`  코어 상위 3개 거래(기간 끝에 열린 보유 포함, 코어 계좌 대비 손익 순): ${ct.map((t) => `${label(t.code)} ${CAL[t.entryC]}~${CAL[t.exitC]}${t.reason === "기간 끝 평가" ? "(보유 중)" : ""} 수익률 ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")}`);
        }
        extra(run, base);
      },
    };
  };

  // ---- DS10 진단 ----
  const ds10Extra = (run: SimRun, base: Built): void => {
    const rp = base.rp as NonNullable<Built["rp"]>, st = rp.st, ds6 = b6.res.run;
    const lab = (i: number): "W" | "U" | "D" => (i >= 2 ? st[i - 2] : "W");
    const wPrev = (i: number): number => (i === 0 ? DS89_CORE_W : base.res.wCore[i - 1]);
    const coreRet = base.coreX.sl.ret, satRet = base.satX.sl.ret, costPct = base.res.cost.map((x) => x * 100);
    const exCore = dates0.map((_, i) => wPrev(i) * (coreRet[i] - bRetAxis[i])), exSat = dates0.map((_, i) => (1 - wPrev(i)) * (satRet[i] - bRetAxis[i])), exTot = dates0.map((_, i) => run.ret[i] - bRetAxis[i]), ex6 = dates0.map((_, i) => ds6.ret[i] - bRetAxis[i]);
    let maxId = 0;
    for (let i = 0; i < nDays; i++) maxId = Math.max(maxId, Math.abs(exCore[i] + exSat[i] - costPct[i] - exTot[i]));
    console.log(`\n분해 항등식(시간에 따라 변하는 비중): 일별 (코어 기여 + LV1 기여 − 비용) = DS10 − 069500, 최대 차이 ${maxId.toExponential(2)}%p ${maxId < 1e-9 ? "통과" : "불일치"}`);
    const sw: string[] = [];
    st.forEach((x, i) => { if (i > 0 && x !== st[i - 1]) sw.push(`${dates0[i]} ${st[i - 1]}→${x}`); });
    console.log(`\n=== 진단 [판정 불사용] 국면 상태 일 수와 전환 (라벨 = 그날 보유 비중을 정한 확정 상태, 즉 2거래일 전 종가의 확정 상태; W = 워밍업·미확정 40:60, U = 상승, D = 하락) ===\n| 구간 | 일 수 | W | U 상승 | D 하락 | U 비중 % | D 비중 % |\n|---|---|---|---|---|---|---|`);
    for (const [wn, w] of ALLW) {
      const ix = dates0.map((_, i) => i).filter((i) => dates0[i] >= w.from && dates0[i] <= (w.to > h.dataEnd ? h.dataEnd : w.to)), c = { W: 0, U: 0, D: 0 };
      ix.forEach((i) => { c[lab(i)]++; });
      console.log(`| ${wn} | ${ix.length} | ${c.W} | ${c.U} | ${c.D} | ${f2((c.U / ix.length) * 100)} | ${f2((c.D / ix.length) * 100)} |`);
    }
    console.log(`확정 전환 ${sw.length}회(워밍업 W → 첫 확정 포함): ${sw.join(", ")}`);
    console.log(`\n=== 진단 [판정 불사용] 상태별 일평균 초과수익 (일별 %p, 산술 평균; 연환산 ×252; 표준오차는 일 단위) ===\n| 상태 | 일 수 | DS10 − 069500 | 연환산 | 표준오차 | 같은 날 DS6 − 069500 | 연환산 | 코어 기여 | LV1 기여 | 비용 | 평균 보유 코어 비중 % |\n|---|---|---|---|---|---|---|---|---|---|---|`);
    for (const [nm, lbl] of [["W 워밍업·미확정", "W"], ["U 상승", "U"], ["D 하락", "D"]] as const) {
      const g = dates0.map((_, i) => i).filter((i) => lab(i) === lbl);
      if (!g.length) { console.log(`| ${nm} | 0 | - | - | - | - | - | - | - | - | - |`); continue; }
      const e = g.map((i) => exTot[i]);
      console.log(`| ${nm} | ${g.length} | ${sg(avg(e))} | ${sg(avg(e) * 252)} | ${f2(Math.sqrt(e.reduce((a, x) => a + (x - avg(e)) ** 2, 0) / Math.max(e.length - 1, 1)) / Math.sqrt(g.length))} | ${sg(avg(g.map((i) => ex6[i])))} | ${sg(avg(g.map((i) => ex6[i])) * 252)} | ${sg(avg(g.map((i) => exCore[i])))} | ${sg(avg(g.map((i) => exSat[i])))} | ${sg(-avg(g.map((i) => costPct[i])))} | ${f2(avg(g.map((i) => wPrev(i))) * 100)} |`);
    }
    console.log(`\n=== 진단 [판정 불사용] 하락 상태(D)에서 코어·LV1 기여 (일별 산술 합 %p; DS10의 비중 기준, 069500 대비 초과 기여) — 구간별·연도별 ===\n| 구간 | D 일 수 | DS10 − 069500 합 | 코어 기여 합 | LV1 기여 합 | 비용 합 | 같은 날 DS6 − 069500 합 | 같은 날 069500 복리 % |\n|---|---|---|---|---|---|---|---|`);
    const sumI = (a: ArrayLike<number>, ix: number[]): number => ix.reduce((s, i) => s + a[i], 0);
    const cmp = (r: ArrayLike<number>, ix: number[]): number => (ix.reduce((a, i) => a * (1 + r[i] / 100), 1) - 1) * 100;
    for (const [wn, w] of ALLW) {
      const ix = dates0.map((_, i) => i).filter((i) => lab(i) === "D" && dates0[i] >= w.from && dates0[i] <= (w.to > h.dataEnd ? h.dataEnd : w.to));
      console.log(`| ${wn} | ${ix.length} | ${sg(sumI(exTot, ix))} | ${sg(sumI(exCore, ix))} | ${sg(sumI(exSat, ix))} | ${sg(-sumI(costPct, ix))} | ${sg(sumI(ex6, ix))} | ${f2(cmp(bRetAxis, ix))} |`);
    }
    console.log(`\n=== 진단 [판정 불사용] 연도별 초과수익 (복리 연 차이 %p)와 상태 일 수 ===\n| 연도 | DS10 − 069500 | DS6 − 069500 | DS10 − DS6 | W / U / D 일 수 | 평균 보유 코어 비중 % | D 상태 코어 기여 | D 상태 LV1 기여 |\n|---|---|---|---|---|---|---|---|`);
    for (const y of [...new Set(dates0.map((dd) => dd.slice(0, 4)))]) {
      const ix = dates0.map((_, i) => i).filter((i) => dates0[i].startsWith(y)), c = { W: 0, U: 0, D: 0 }, dix = ix.filter((i) => lab(i) === "D");
      ix.forEach((i) => { c[lab(i)]++; });
      console.log(`| ${y} | ${sg(cmp(run.ret, ix) - cmp(bRetAxis, ix))} | ${sg(cmp(ds6.ret, ix) - cmp(bRetAxis, ix))} | ${sg(cmp(run.ret, ix) - cmp(ds6.ret, ix))} | ${c.W} / ${c.U} / ${c.D} | ${f2(avg(ix.map((i) => wPrev(i))) * 100)} | ${dix.length ? sg(sumI(exCore, dix)) : "-"} | ${dix.length ? sg(sumI(exSat, dix)) : "-"} |`);
    }
  };

  // ---- DS11 진단 ----
  const ds11Extra = (run: SimRun, base: Built): void => {
    const ds6 = b6.res.run, c6 = coreFor(DS6D, {}, 1), c11 = base.coreX;
    console.log(`\nDS11 코어 구성 이력(판단일 K200P 시총 상위 ${DS11_CAND}종목 중 ${DS11_WIN}일 수익률 상위 ${DS11_CORE_N}종목; 체결일 종목 교체·비중 조정; 대괄호는 체결 직후 코어 안 실제 비중):\n    ${evLine(c11.run)}`);
    console.log(`\n코어 이벤트 DS6 ${c6.run.events.length}회(교체 ${c6.run.events.filter((e) => e.sells.length).length}회) → DS11 ${c11.run.events.length}회(교체 ${c11.run.events.filter((e) => e.sells.length).length}회), 코어 진입 DS6 ${c6.run.entryCs.length}건 → DS11 ${c11.run.entryCs.length}건, 거래정지 순연 ${c6.run.haltSkip} → ${c11.run.haltSkip}건`);
    const ch6 = coreHolds(2, undefined), ch11 = coreHolds(DS11_CORE_N, undefined, undefined, { pick: rsPick(DS11D.rs as Rs, DS11_CORE_N), mcAtExec: true });
    const samW = (ch: [string, number][][], i: number): number => ch[i].find(([code]) => code === DS89_SAMSUNG)?.[1] ?? 0;
    console.log(`\n=== 진단 [판정 불사용] 삼성전자 일별 평균 계좌 비중 % (현금 날 포함; ${nDays}일) ===\n| 구간 | DS6 | DS11 | 코어 안 평균 삼성전자 비중 % DS6 → DS11 | 삼성전자가 코어에 있던 날 비율 % DS6 → DS11 |\n|---|---|---|---|---|`);
    for (const [wn, w] of ALLW) {
      const ix = dates0.map((_, i) => i).filter((i) => dates0[i] >= w.from && dates0[i] <= (w.to > h.dataEnd ? h.dataEnd : w.to));
      console.log(`| ${wn} | ${f2(avg(ix.map((i) => b6.res.wCore[i] * samW(ch6, i) * 100)))} | ${f2(avg(ix.map((i) => base.res.wCore[i] * samW(ch11, i) * 100)))} | ${f2(avg(ix.map((i) => samW(ch6, i) * 100)))} → ${f2(avg(ix.map((i) => samW(ch11, i) * 100)))} | ${f2((ix.filter((i) => samW(ch6, i) > 0).length / ix.length) * 100)} → ${f2((ix.filter((i) => samW(ch11, i) > 0).length / ix.length) * 100)} |`);
    }
    const exS = new Set([DS89_SAMSUNG]), x6 = build(DS6D, { exclude: exS }).res.run, x11 = build(DS11D, { exclude: exS }).res.run;
    console.log(`\n=== 진단 [판정 불사용] 삼성전자를 후보에서 뺀 경우 (DS6: 코어 순위 목록에서 ${DS89_SAMSUNG} 제외 뒤 상위 2종목, DS11: ${DS89_SAMSUNG} 제외 뒤 시총 상위 ${DS11_CAND}종목에서 선택; 나머지 규칙·위성·합성은 같음; 새 후보 아님; CAGR % / MDD %) ===\n| 구간 | 069500 | DS6 | DS6-X | DS11 | DS11-X |\n|---|---|---|---|---|---|`);
    for (const [wn, w] of ALLW) console.log(`| ${wn} | ${cell(h.bhP, w)} | ${cell(ds6, w)} | ${cell(x6, w)} | ${cell(run, w)} | ${cell(x11, w)} |`);
    const sb = h.st(h.bhP, FULL), sx = h.st(x11, FULL), sc = h.st(run, FULL);
    console.log(`DS11-X 연속 전체 ${f2(sx.cagr)} / ${f2(sx.mdd)} (069500 대비 CAGR ${sg(sx.cagr - sb.cagr)}%p, MDD ${sg(sx.mdd - sb.mdd)}%p; DS11 대비 CAGR ${sg(sx.cagr - sc.cagr)}%p, MDD ${sg(sx.mdd - sc.mdd)}%p)`);
    console.log(`\n=== 진단 [판정 불사용] 코어 단독·LV1 단독 성적 (각 계좌 100%로 본 CAGR % / MDD %) ===\n| 구간 | 069500 | LV1 단독 | DS6 코어(시총 상위 2) | DS11 코어(상대강도 선택) |\n|---|---|---|---|---|`);
    for (const [wn, w] of ALLW) console.log(`| ${wn} | ${cell(h.bhP, w)} | ${cell(asRun(lv1Of(1).sl), w)} | ${cell(asRun(c6.sl), w)} | ${cell(asRun(c11.sl), w)} |`);
  };

  const sp = ((): CandSpec => {
    if (MODE === "ds10") {
      return mkSpec(DS10D, [
        ...DS10_NB_SMA.map((sma) => ({ label: `이동평균 ${sma}일 (워밍업 ${sma}일)`, run: () => build(DS10D, { regime: { sma } }).res.run })),
        ...DS10_NB_UP_CORE.map((u) => ({ label: `상승 코어 ${u * 100}% (하락 ${DS10_DOWN_CORE * 100}% 고정)`, run: () => build(DS10D, { regime: { upW: u } }).res.run })),
        ...DS10_NB_DOWN_CORE.map((dn) => ({ label: `하락 코어 ${dn * 100}% (상승 ${DS10_UP_CORE * 100}% 고정)`, run: () => build(DS10D, { regime: { downW: dn } }).res.run })),
      ], [
        `DS10 국면 정의(사전등록): 069500 원주가 종가가 판단일(신호일) 종가까지의 ${DS10_SMA}거래일 단순이동평균(당일 포함)보다 높으면 상승(U), 같거나 낮으면 하락(D). 새 상태가 ${DS10_CONFIRM_DAYS}거래일 연속 유지될 때에만 확정 상태를 바꾸고 그 판단일 종가의 목표 비중이 바뀌어 다음 거래일 종가에 이동한다(일별 40:60 목표 이동과 같은 방식). 워밍업(평가 시작 후 첫 ${DS10_SMA}거래일)은 40:60이고 원 상태 판정·연속 일수 계산도 그 뒤부터라 가장 이른 확정은 ${DS10_SMA + DS10_CONFIRM_DAYS - 1}번째 거래일이다. 상승 코어 ${DS10_UP_CORE * 100} / LV1 ${100 - DS10_UP_CORE * 100}, 하락 코어 ${DS10_DOWN_CORE * 100} / LV1 ${100 - DS10_DOWN_CORE * 100}. 코어·LV1 자체는 DS6와 같다.`,
        `DS10 게이트 D 해석(사전등록): 이웃 6개 — 이동평균 ${DS10_NB_SMA.join("·")}일(워밍업도 그 길이), 상승 코어 ${DS10_NB_UP_CORE.map((x) => x * 100).join("·")}%(하락 ${DS10_DOWN_CORE * 100}% 고정), 하락 코어 ${DS10_NB_DOWN_CORE.map((x) => x * 100).join("·")}%(상승 ${DS10_UP_CORE * 100}% 고정). 연속 전체 CAGR ≥ 069500 CAGR이어야 통과, 하나라도 미만이면 탈락.`,
      ], ds10Extra);
    }
    return mkSpec(DS11D, [
      ...DS11_NB_CAND.map((cd) => ({ label: `후보 상위 ${cd}종목`, run: () => build(DS11D, { rs: { cand: cd } }).res.run })),
      ...DS11_NB_WIN.map((wn) => ({ label: `수익률 창 ${wn}일`, run: () => build(DS11D, { rs: { win: wn } }).res.run })),
      ...[-CS_CORE_W_NEIGHBOR, CS_CORE_W_NEIGHBOR].map((dw) => ({ label: `코어 비중 ${Math.round((DS89_CORE_W + dw) * 100)}% (위성 ${Math.round((1 - DS89_CORE_W - dw) * 100)}%)`, run: () => build(DS11D, { wC: DS89_CORE_W + dw }).res.run })),
    ], [
      `DS11 코어 선택 정의(사전등록): 판단일 d 종가에서 K200P(월말 PIT, 제외 규칙) 시총 상위 ${DS11_CAND}종목을 후보로 하고 d 종가까지의 최근 ${DS11_WIN}거래일 수익률(조정 종가 c[d] ÷ c[d−${DS11_WIN}] − 1)이 큰 ${DS11_CORE_N}종목을 목표로 한다(이력이 없는 종목은 뒤로, 같은 값은 시총 큰 순). 보유 종목이 목표 ${DS11_CORE_N}종목 밖(= 상대강도 상위 ${DS11_CORE_N}위 밖이거나 시총 상위 ${DS11_CAND}위 밖)인 상태가 ${CS_SWAP_CONFIRM_DAYS}거래일 연속이면 그 종목을 팔고 목표 안의 미보유 종목 중 수익률이 가장 높은 종목으로 바꾼다(신호 종가 d, 체결 종가 d+1). 구성이 바뀌는 체결일에 체결일 시총 비율로 비중을 맞추고 그 사이에는 가격 변동 그대로 둔다. 위성·합성·비용은 그대로.`,
      `DS11 게이트 D 해석(사전등록): 이웃 6개 — 후보 상위 ${DS11_NB_CAND.join("·")}종목, 수익률 창 ${DS11_NB_WIN.join("·")}일, 코어 비중 30%·50%(각각 나머지는 기본값). 연속 전체 CAGR ≥ 069500 CAGR이어야 통과, 하나라도 미만이면 탈락.`,
    ], ds11Extra);
  })();

  const verdicts: Verdict[] = [evaluate(h, W, sp)];
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: sp.trial - 1, contamNote: W.contamNote });
  console.log(`DS6 기록(참고): 연속 전체 ${DS89_DS6_REF.전체.join(" / ")}, 구간 1 ${REC.DS6.구간1.join(" / ")}, 구간 2 ${REC.DS6.구간2.join(" / ")}, 구간 3 ${REC.DS6.구간3.join(" / ")}, 롤링 CAGR 우위 ${DS89_DS6_REF.rollCagrShare}% · MDD 우위 ${DS89_DS6_REF.rollMddShare}%; DS8 ${REC.DS8.결과}, DS9 ${REC.DS9.결과} — 위 비교 표 참조`);
  console.log(`사전 고지: ${sp.id}는 DS6 진단 결과를 본 뒤 만든 변형이라 선택 편향이 크다${sp.id === "DS10" ? "(특히 환경별 해가 4~6개뿐인 관찰에서 나왔다)" : ""}. 2011~2026 구간은 반복해 본 데이터라 오염돼 있다. 누적 ${sp.trial}번 기준 우연 통과 기대 ${sp.trial} × 0.05 = ${(sp.trial * 0.05).toFixed(2)}개. 삼성전자 의존, 최근 3년은 SK하이닉스 몫이 크다. 두 시험(DS10, DS11) 중 통과하는 쪽이 있어도 독립 확인 전에는 후보일 뿐이다.`);
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ") || "없음"} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${verdicts.map((v) => v.trial).join(", ")}`);
  void SLIPPAGE_PCT_PER_SIDE; void CS_RANK_DEPTH; void L_EVAL_AFTER; void DS10_WARM_CORE; void median;
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

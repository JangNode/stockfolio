/**
 * [임시 연구 — 병합 금지] DS13 계산 코드(코어·RM1·MV1·LV1 하위 계좌 계산, 재조정 시뮬레이터 호출, 하위 계좌 합성)를 scripts/research-batch5.ts 의 main 안에서 그대로 옮긴 것.
 * 로직은 한 글자도 바꾸지 않았다(옮기며 인터페이스를 모듈 수준으로 올렸을 뿐). research-batch5.ts 와 포워드 도구(scripts/research-ds6-forward.ts)가 함께 쓴다.
 * 정의 동결: docs/research/ds13-forward-freeze.md. 이 파일은 DB·Storage·외부 요청을 쓰지 않는다.
 */
import { simSlots, type SimCand, type SimPos, type SimRun, type SimTrade, type SimVt } from "@/lib/slotSim";
import { L_SLIPPAGE, L_EVAL_AFTER } from "@/lib/megacapTrendConfig";
import { LS_COOLDOWN_DAYS } from "@/lib/megacapTrailingConfig";
import { LE_CANDS, LE_LEGS, LE_ENTRY_LEG, LE_RANK_DEPTH } from "@/lib/momentumEnsembleConfig";
import { LV_CANDS, LV_WINDOW, LV_ANNUAL_DAYS, LV_ROUND_DP, LV_BAND } from "@/lib/le2VolTargetConfig";
import { rankEnsemble, outsiderEnsembleRank, type EnsembleRanking } from "@/lib/momentumEnsemble";
import { alignCloses, equalWeightSigma, volMultiplier } from "@/lib/le2VolTarget";
import { F_E_TOP_TRADES } from "@/lib/kodexSectorSatConfig";
import { rebalSim, type RebalRun } from "@/lib/rebalSim";
import { solveMinVar } from "@/lib/minVar";
import { capWeights } from "@/lib/coreCapWeights";
import { DS13_W, type Alloc3 } from "@/lib/ds13Config";
import { B5_FILTER_LOW, B5_RM_P0, B5_RM_NB, B5_MV_P0, B5_MV_NB, B5_MV_KKT_TOL, B5_MV_MAX_ITER, type RmP, type MvP } from "@/lib/batch5Config";
import { DS89_RUN_START, DS89_WINDOWS, DS8_TRIAL, DS9_TRIAL, DS8_SMOOTH_WIN, DS9_CORE_N, DS9_CORE_CAP, DS89_CORE_W } from "@/lib/ds89Config";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";
import { CS_SWAP_CONFIRM_DAYS, CS_RANK_DEPTH, CS_MOVE_COST } from "@/lib/coreSatelliteConfig";
import type { Harness, S, Win, loadK200P } from "@/scripts/researchHarness";
import type { Windows } from "@/scripts/researchGates";

const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
export type K200PInfo = Awaited<ReturnType<typeof loadK200P>>;

export interface CorePos { code: string; s: S; shares: number; lastPx: number; entryC: number; spend: number; vAtEntry: number; rep: boolean; repVal: number; realized: number; out: number }
export interface CoreEvent { c: number; sells: string[]; buys: string[]; set: string[]; w: number[]; /** 신호일 시총(set 순서) */ mcv: number[]; /** 체결일 목표 비중(set 순서; 상한 있으면 상한 적용 뒤) */ tw: number[] }
export type CoreRun = SimRun & { open: SimTrade[]; events: CoreEvent[]; forcedExit: number };
export interface CoreX { run: CoreRun; sl: Sl }
export interface CombOut { run: SimRun; wCore: number[]; cost: number[]; moved: number[] }
export interface Def { id: string; trial: number; coreN: number; capW?: number; smooth?: number; wC: number }
export interface Opts { coreLag?: number; satLag?: number; delay?: number; N?: number; capW?: number | null; wC?: number; smooth?: number | null; replSat?: boolean; replCore?: boolean; exclude?: ReadonlySet<string> }
export interface Built { res: CombOut; coreX: CoreX; satX: { run: SimRun; sl: Sl }; N: number; capW?: number; smooth?: number; wC: number }
export interface Strat<P> {
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
  /** 시총 비중형처럼 종목마다 비중이 다른 전략의 무작위 대조용 목표 비중(코드 목록 → 비중, 필터 배수 m 포함). 없으면 동일 비중 wOf × m. */
  wMap?: (c: number, codes: string[], P: P, m: number) => Map<string, number>;
}
export interface MvPick { codes: string[]; n: number; S: Float64Array }
export interface FCfg { ma: number }
export interface D13Parts { res: CombineNOut; rm: RebalRun; low: SimRun; core: CoreRun; sls: Sl[] }
/** 공통 평가 시작 이후로 자른 일별 계열(구성요소 하나의 계좌 기준). */
export interface Sl { dates: string[]; ret: number[]; costFrac: number[]; nPos: number[]; inv: number[]; turn: number[]; wMax: number[] }
export type LvOpts = { lag: number; smooth?: number; replace?: Set<string> };
export interface CombineNOut { run: SimRun; moved: number[]; cost: number[]; contribDaily: number[][]; wEnd: number[][] }

export function makeDs13Engine(h: Harness, k200p: K200PInfo) {
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, nameOf } = k200p;
  // ---- 평가 구간: 초기 배분 2011-01-03 종가(LV1 250거래일 워밍업 뒤 첫 거래일), 수익 집계 2011-01-04~데이터 끝(2026-10-26) 연속, 하위 구간 3개 ----
  const cPE = CAL.findIndex((d) => d >= DS89_RUN_START);
  if (cPE < 0 || CAL[cPE] !== DS89_RUN_START) throw new Error(`${DS89_RUN_START}이 거래일 달력에 없음`);
  const cutC = cPE + 1;
  const NW: [string, Win][] = DS89_WINDOWS.map(([n, f, t]) => [n, { from: f, to: t }]);
  const FULL: Win = { from: CAL[cutC], to: "9999-12-31" };
  if (NW[0][1].from !== FULL.from) throw new Error(`구간 1 시작 ${NW[0][1].from}이 연속 평가 시작 ${FULL.from}과 다르다`);
  const W: Windows = { NW, FULL, ALL: [...NW, ["연속 전체 2011-01~2026-10", FULL]], noEx26: true, contamNote: "경고(오염): 이 구간 전체(2011~2026)는 DS6·DS4·LV1 등 선행 연구에서 이미 반복해 본 데이터다. DS8·DS9은 DS6 결과를 본 뒤 만든 변형(선택 편향)이라 순수 검증이 아니다." };

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

  // ---- 코어-위성 합성: 코어 비중 w, 위성 1 − w, 매일 종가에 목표 비율 계산 → 다음 거래일 종가에 고정 금액 이동(연구 ALLOC P형과 같은 방식), 이동 금액의 CS_MOVE_COST ----
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
  const DS6D: Def = { id: "DS6", trial: 272, coreN: 2, wC: DS89_CORE_W };
  const build = (d: Def, o: Opts = {}): Built => {
    const N = o.N ?? d.coreN;
    const capW = o.capW === undefined ? d.capW : o.capW === null ? undefined : o.capW;
    const smooth = o.smooth === undefined ? d.smooth : o.smooth === null ? undefined : o.smooth;
    const wC = o.wC ?? d.wC;
    const satX = lv1Of(o.satLag ?? 1, smooth, o.replSat ? lv1ReplSet(smooth) : undefined);
    const coreX = o.replCore ? coreOf(N, capW, 1, { repl: coreReplSet(coreOf(N, capW, 1).run), exclude: o.exclude }) : coreOf(N, capW, o.coreLag ?? 1, { exclude: o.exclude });
    return { res: combineCS(coreX.sl, satX.sl, wC, CS_MOVE_COST, o.delay ?? 0), coreX, satX, N, capW, smooth, wC };
  };

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

  // ---- MV1 ----
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

  /** combine2의 N개 하위 계좌 일반화. sigDates가 null이면 매일 재조정(combine2와 같음), 아니면 그 날짜 종가에 목표 금액을 계산해 다음 거래일 종가에 옮긴다. */
  const combineN = (parts: Sl[], w0: readonly number[], rate: number, sigDates: ReadonlySet<string> | null): CombineNOut => {
    const m = parts.length, n = parts[0].dates.length;
    for (const p of parts) if (p.dates.length !== n || p.dates.some((d, k) => d !== parts[0].dates[k])) throw new Error("하위 계좌 날짜 축이 다르다");
    const sleeve = [...w0], q: number[][] = [], zero = new Array<number>(m).fill(0);
    const ret: number[] = [], costFrac: number[] = [], nPos: number[] = [], inv: number[] = [], turn: number[] = [], wMax: number[] = [], cost: number[] = [], moved: number[] = [], wEnd: number[][] = [];
    const contribDaily: number[][] = parts.map(() => []);
    for (let i = 0; i < n; i++) {
      const Vprev = sleeve.reduce((a, x) => a + x, 0), wPrev = sleeve.map((x) => x / Vprev);
      for (let j = 0; j < m; j++) { sleeve[j] *= 1 + parts[j].ret[i] / 100; contribDaily[j].push(wPrev[j] * parts[j].ret[i]); }
      let mv = 0, cs = 0;
      const pending = q.length > 0 ? (q.shift() as number[]) : zero;
      if (pending.some((x) => x !== 0)) {
        for (let j = 0; j < m; j++) { sleeve[j] += pending[j]; if (pending[j] > 0) mv += pending[j]; }
        cs = rate * mv;
        if (mv > 0) for (let j = 0; j < m; j++) if (pending[j] > 0) sleeve[j] -= (cs * pending[j]) / mv;
      }
      const V = sleeve.reduce((a, x) => a + x, 0), wc = sleeve.map((x) => x / V);
      ret.push((V / Vprev - 1) * 100); cost.push(cs / Vprev); moved.push(mv / Vprev); wEnd.push(wc);
      costFrac.push(parts.reduce((a, p, j) => a + wPrev[j] * p.costFrac[i], 0) + cs / Vprev);
      nPos.push(parts.reduce((a, p) => a + p.nPos[i], 0));
      inv.push(parts.reduce((a, p, j) => a + wc[j] * p.inv[i], 0));
      turn.push(parts.reduce((a, p, j) => a + wPrev[j] * p.turn[i], 0) + mv / Vprev);
      const wm = parts.map((p, j) => wPrev[j] * p.wMax[i]).filter(Number.isFinite);
      wMax.push(wm.length ? Math.max(...wm) : Number.NaN);
      q.push(sigDates === null || sigDates.has(parts[0].dates[i]) ? w0.map((w, j) => w * V - sleeve[j]) : zero);
    }
    return { run: { dates: parts[0].dates, ret, costFrac, nPos, inv, turn: turn.map((v, i) => ({ d: parts[0].dates[i], v })), trades: [], entryCs: [], wMax, haltSkip: 0, exitDefer: 0 }, moved, cost, contribDaily, wEnd };
  };

  const d13Of = (kind: "MV1" | "LV1", cS: number, Wx: Windows) => {
    const from = Wx.FULL.from, W0 = DS13_W, rmP0 = RM1.P0;
    const sigSet = new Set(monthEndIdx.filter((c) => c > cS).map((c) => CAL[c]));
    const coreSlOf = (lag: number): { run: CoreRun; sl: Sl } => { const x = coreOf(2, undefined, lag, {}); return { run: x.run, sl: sliceSl(x.sl, from) }; };
    const lowOf = (lag: number, repl?: Set<string>): { run: SimRun; sl: Sl } => {
      if (kind === "MV1") { const r = runS(MV1, MV1.P0, cS, null, { lag, detail: true, replace: repl }); return { run: r, sl: slFromRun(r) }; }
      const x = lv1Of(lag, undefined, repl);
      return { run: x.run, sl: sliceSl(x.sl, from) };
    };
    const build = (o: { w?: Alloc3; rmP?: RmP; lag: number; repl?: { rm: Set<string>; low: Set<string> } }): D13Parts => {
      const rm = runS(RM1, o.rmP ?? rmP0, cS, null, { lag: o.lag, detail: true, replace: o.repl?.rm }), lo = lowOf(o.lag, o.repl?.low), cx = coreSlOf(o.lag);
      const sls = [cx.sl, slFromRun(rm), lo.sl];
      return { res: combineN(sls, o.w ?? W0, CS_MOVE_COST, sigSet), rm, low: lo.run, core: cx.run, sls };
    };
    const merge = (b: D13Parts, w: Alloc3 = W0): SimRun => {
      const r: SimRun = { ...b.res.run };
      r.trades = [...b.rm.trades.map((t) => ({ ...t, vAtEntry: t.vAtEntry / w[1] })), ...b.low.trades.map((t) => ({ ...t, vAtEntry: t.vAtEntry / w[2] })), ...b.core.trades.map((t) => ({ ...t, vAtEntry: t.vAtEntry / w[0] }))];
      r.entryCs = [...b.rm.entryCs, ...b.low.entryCs, ...b.core.entryCs];
      r.haltSkip = b.rm.haltSkip + b.low.haltSkip + b.core.haltSkip; r.exitDefer = b.rm.exitDefer + b.low.exitDefer + b.core.exitDefer;
      return r;
    };
    const base = build({ lag: 1 });
    return { from, W0, rmP0, sigSet, coreSlOf, lowOf, build, merge, base };
  };

  return { cPE, NW, FULL, W, env, label, randLV1, mcapNear, slice, lv1Of, nDays, zeroSl, bhRet, coreOf, coreReplSet, combineCS, DS6D, build, rank200, al, nRows, rowAt, bL, filterMult, retFill, medianOf, sdOf, monthEndIdx, isQuarterEnd, pickKeep, equalW, rmSorted, RM1, mvCov, mvStats, MV1, sigDays, startOf, runS, sliceSl, slFromRun, combine2, combineN, d13Of };
}

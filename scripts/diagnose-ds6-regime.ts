/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 진단: DS6 우위 분해(시험 아님, 시험 번호 275 유지, 판정에 쓰지 않음). 정의: docs/research/ds6-regime-diagnostic.md.
 * ① 대장주(삼성전자) 우위 연도별 ② 환경별(069500 연간 수익, 삼성전자 252일 상대강도) 분해 ③ 코어 쏠림(종목별 보유 기간·기여). DS6 정의는 변경 없음.
 * 사후 분해이며 인과 증명이 아니다(경로 하나). 공시·DART 사용 없음.
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
import { F_E_TOP_TRADES } from "@/lib/kodexSectorSatConfig";
import { ALLOC_SERIES_SHA, type AllocCompId } from "@/lib/strategyAllocationConfig";
import { capWeights } from "@/lib/coreCapWeights";
import { DS89_RUN_START, DS89_WINDOWS, DS89_DS6_REF, DS9_CORE_N, DS89_CORE_W, DS89_SAMSUNG } from "@/lib/ds89Config";
import { CS_SWAP_CONFIRM_DAYS, CS_RANK_DEPTH, CS_MOVE_COST } from "@/lib/coreSatelliteConfig";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, SNAP_END, f2, avg, median, type S, type Win } from "./researchHarness";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
const sha = (b: Uint8Array | Buffer | string): string => createHash("sha256").update(b).digest("hex");
/** 공통 평가 시작 이후로 자른 일별 계열(구성요소 하나의 계좌 기준). */
interface Sl { dates: string[]; ret: number[]; costFrac: number[]; nPos: number[]; inv: number[]; turn: number[]; wMax: number[] }
type LvOpts = { lag: number; smooth?: number; replace?: Set<string> };

async function main(): Promise<void> {
  console.log(`연구 DS6 우위 분해 진단(시험 아님, 시험 번호 275 유지, 판정에 쓰지 않음) 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, nameOf, kAt } = await loadK200P(h);

  // ---- 평가 구간: 초기 배분 2011-01-03 종가(LV1 250거래일 워밍업 뒤 첫 거래일), 수익 집계 2011-01-04~데이터 끝(2026-10-26) 연속, 하위 구간 3개 ----
  const cPE = CAL.findIndex((d) => d >= DS89_RUN_START);
  if (cPE < 0 || CAL[cPE] !== DS89_RUN_START) throw new Error(`${DS89_RUN_START}이 거래일 달력에 없음`);
  const cutC = cPE + 1;
  const NW: [string, Win][] = DS89_WINDOWS.map(([n, f, t]) => [n, { from: f, to: t }]);
  const FULL: Win = { from: CAL[cutC], to: "9999-12-31" };
  if (NW[0][1].from !== FULL.from) throw new Error(`구간 1 시작 ${NW[0][1].from}이 연속 평가 시작 ${FULL.from}과 다르다`);
  const ALLW: [string, Win][] = [...NW, ["연속 전체 2011-01~2026-10", FULL]];
  console.log(`연속 평가: 초기 배분 ${CAL[cPE]} 종가(비용 없음), 수익률 집계 ${FULL.from}~${h.dataEnd} | 구간 ${NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);

  // ---- 0. 069500 기준선 ----
  console.log(`\n=== 0. 069500 기준선 (수익 집계 ${FULL.from}~; 원주가, 가격 수익만; 모든 구간의 기준선 시작일 = 해당 구간 시작일; CAGR % / MDD %) ===\n| 구간 | 기준선 첫 수익률 날짜 | 069500 (보조 파일) |\n|---|---|---|`);
  for (const [wn, w] of ALLW) {
    const b = h.st(h.bhP, w), first = h.bhP.dates.find((d) => d >= w.from);
    console.log(`| ${wn} | ${first} | ${f2(b.cagr)} / ${f2(b.mdd)} |`);
  }

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


  // =====================================================================================================================
  // 0. 기준 계열 재현·일관성 (진단 전 점검)
  // =====================================================================================================================
  const satX = lv1Of(1), coreX = coreOf(2, undefined, 1);
  const res = combineCS(coreX.sl, satX.sl, DS89_CORE_W, CS_MOVE_COST, 0);
  const ds6 = res.run;
  console.log(`\n=== 0. 기준 계열 점검 ===`);
  {
    const refDir = process.env.ALLOC_REF_DIR?.trim();
    if (!refDir) throw new Error("ALLOC_REF_DIR(이전 연구 일별 순수익 캐시)가 없다 — 중단하고 보고한다");
    const r = satX.run;
    const buf = await fs.readFile(path.join(refDir, "LV1.json"));
    const refSha = sha(buf), okSha = !ALLOC_SERIES_SHA || ALLOC_SERIES_SHA["LV1" as AllocCompId] === refSha;
    const ref = JSON.parse(buf.toString("utf8")) as { dates: string[]; ret: number[] };
    const nn = r.dates.length;
    const sameDates = ref.dates.length >= nn && r.dates.every((d, k) => ref.dates[k] === d);
    let maxD = 0;
    if (sameDates) for (let k = 0; k < nn; k++) maxD = Math.max(maxD, Math.abs(r.ret[k] - ref.ret[k]));
    console.log(`  LV1 재현: ${nn}일 날짜 ${sameDates ? "일치" : "불일치"}, 최대 차이 ${maxD.toExponential(2)}%p, 캐시 SHA-256 ${okSha ? "ALLOC 해시와 일치" : "불일치"}`);
    if (!sameDates || !(maxD <= 1e-9) || !okSha) throw new Error("LV1 재현 불일치 — 중단하고 보고한다");
    const sF = h.st(ds6, FULL), s1 = h.st(ds6, { from: FULL.from, to: "2016-12-30" });
    const ok = f2(sF.cagr) === f2(DS89_DS6_REF.전체[0]) && f2(sF.mdd) === f2(DS89_DS6_REF.전체[1]) && f2(s1.cagr) === f2(DS89_DS6_REF.구간1[0]) && f2(s1.mdd) === f2(DS89_DS6_REF.구간1[1]);
    console.log(`  DS6 일관성: 연속 전체 ${f2(sF.cagr)} / ${f2(sF.mdd)} (기록 ${DS89_DS6_REF.전체.join(" / ")}), 구간 1(기록과 같은 CAGR 기간) ${f2(s1.cagr)} / ${f2(s1.mdd)} (기록 ${DS89_DS6_REF.구간1.join(" / ")}) → ${ok ? "일치" : "불일치"}`);
    if (!ok) throw new Error("DS6 기록과 다르다 — 중단하고 보고한다");
  }

  // ---- 일별 계열 (모두 %) ----
  const n = nDays;
  const prevDate = (i: number): string => CAL[(h.calIdx.get(dates0[i]) as number) - 1];
  const bRet = bRetAxis, dsRet = ds6.ret, coreRet = coreX.sl.ret, satRet = satX.sl.ret;
  const wCprev = (i: number): number => (i === 0 ? DS89_CORE_W : res.wCore[i - 1]);
  const costPct = res.cost.map((x) => x * 100);
  const exCore = dates0.map((_, i) => wCprev(i) * (coreRet[i] - bRet[i]));
  const exSat = dates0.map((_, i) => (1 - wCprev(i)) * (satRet[i] - bRet[i]));
  const exTot = dates0.map((_, i) => dsRet[i] - bRet[i]);
  {
    let maxId = 0;
    for (let i = 0; i < n; i++) maxId = Math.max(maxId, Math.abs(exCore[i] + exSat[i] - costPct[i] - exTot[i]));
    console.log(`  분해 항등식: 일별 (코어 기여 + LV1 기여 − 비용) = DS6 − 069500, 최대 차이 ${maxId.toExponential(2)}%p ${maxId < 1e-9 ? "통과" : "불일치"}`);
    if (!(maxId < 1e-9)) throw new Error("분해 항등식 불일치 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)");
  }
  const sam = byCode.get(DS89_SAMSUNG) as S;
  const stockRet = (s: S, i: number): number => { const a = s.idx.get(prevDate(i)), b = s.idx.get(dates0[i]); return a !== undefined && b !== undefined ? (s.close[b] / s.close[a] - 1) * 100 : 0; };
  const samRet = dates0.map((_, i) => stockRet(sam, i));
  const kRet = (excl: boolean): number[] => dates0.map((d, i) => {
    const pd = prevDate(i);
    let wsum = 0, acc = 0;
    for (const s of kAt(pd)) {
      if (excl && s.code === DS89_SAMSUNG) continue;
      const a = s.idx.get(pd), b = s.idx.get(d);
      if (a === undefined) continue;
      const w = s.mcapRow[a];
      if (!(w > 0)) continue;
      wsum += w; acc += w * (b !== undefined ? s.close[b] / s.close[a] - 1 : 0);
    }
    return wsum > 0 ? (acc / wsum) * 100 : 0;
  });
  const k200 = kRet(false), k200x = kRet(true);
  const sg = (x: number): string => `${x >= 0 ? "+" : ""}${f2(x)}`;
  const comp = (r: ArrayLike<number>, idx: number[]): number => (idx.reduce((a, i) => a * (1 + r[i] / 100), 1) - 1) * 100;
  const years = [...new Set(dates0.map((d) => d.slice(0, 4)))];
  const idxY = new Map(years.map((y) => [y, dates0.map((d, i) => (d.startsWith(y) ? i : -1)).filter((i) => i >= 0)]));
  const lastY = years[years.length - 1], firstY = years[0];
  const yTag = (y: string): string => (y === firstY ? `${y}(부분 ${dates0[0]}~)` : y === lastY ? `${y}(부분 ~${dates0[n - 1]})` : y);
  const isPartial = (y: string): boolean => y === firstY || y === lastY;
  const sd = (a: number[]): number => { const m = avg(a); return Math.sqrt(a.reduce((x, z) => x + (z - m) ** 2, 0) / Math.max(a.length - 1, 1)); };

  // =====================================================================================================================
  // [1] 대장주 우위 연도별
  // =====================================================================================================================
  interface YRow { y: string; sam: number; core: number; b: number; k: number; kx: number; ds: number; sat: number }
  const rows: YRow[] = years.map((y) => { const ix = idxY.get(y) as number[]; return { y, sam: comp(samRet, ix), core: comp(coreRet, ix), b: comp(bRet, ix), k: comp(k200, ix), kx: comp(k200x, ix), ds: comp(dsRet, ix), sat: comp(satRet, ix) }; });
  console.log(`\n=== [1-1] 연도별 수익률 % (일수익률 복리; 부분 연도 표시: ${yTag(firstY)}, ${yTag(lastY)}) ===\n| 연도 | 삼성전자 | 코어 상위 2종목(DS6 코어 계좌) | 069500 | K200P 시총가중(전체) | K200P 삼성전자 제외 | 삼성전자 − 069500 %p | DS6 | DS6 − 069500 %p | LV1 단독 |\n|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of rows) console.log(`| ${yTag(r.y)} | ${f2(r.sam)} | ${f2(r.core)} | ${f2(r.b)} | ${f2(r.k)} | ${f2(r.kx)} | ${sg(r.sam - r.b)} | ${f2(r.ds)} | ${sg(r.ds - r.b)} | ${f2(r.sat)} |`);
  console.log(`참고: K200P 시총가중은 전일 월말 K200P(PIT) 구성·전일 시총 가중 일별 가격 수익(비용 없음)이다. 연간 평균(부분 연도 포함 / 제외): 삼성전자 ${f2(avg(rows.map((r) => r.sam)))} / ${f2(avg(rows.filter((r) => !isPartial(r.y)).map((r) => r.sam)))}, 코어 ${f2(avg(rows.map((r) => r.core)))} / ${f2(avg(rows.filter((r) => !isPartial(r.y)).map((r) => r.core)))}, 069500 ${f2(avg(rows.map((r) => r.b)))} / ${f2(avg(rows.filter((r) => !isPartial(r.y)).map((r) => r.b)))}, K200P ${f2(avg(rows.map((r) => r.k)))} / ${f2(avg(rows.filter((r) => !isPartial(r.y)).map((r) => r.k)))}, K200P 삼성전자 제외 ${f2(avg(rows.map((r) => r.kx)))} / ${f2(avg(rows.filter((r) => !isPartial(r.y)).map((r) => r.kx)))}`);
  {
    const win = rows.filter((r) => r.sam > r.b), lose = rows.filter((r) => !(r.sam > r.b)), sorted = [...rows].sort((a, b) => b.sam - b.b - (a.sam - a.b));
    console.log(`\n=== [1-2] 삼성전자 vs 069500 (연도 ${rows.length}개, 부분 연도 포함) ===\n삼성전자가 069500보다 높았던 해 ${win.length}개: ${win.map((r) => yTag(r.y)).join(", ")}\n낮았던 해 ${lose.length}개: ${lose.map((r) => yTag(r.y)).join(", ")}\n삼성전자 − 069500 상위 3개 연도: ${sorted.slice(0, 3).map((r) => `${yTag(r.y)} ${sg(r.sam - r.b)}%p`).join(", ")} | 하위 3개 연도: ${sorted.slice(-3).reverse().map((r) => `${yTag(r.y)} ${sg(r.sam - r.b)}%p`).join(", ")}`);
    const ex = rows.map((r) => ({ y: r.y, e: r.ds - r.b, win: r.sam > r.b })), tot = ex.reduce((a, x) => a + x.e, 0), byE = [...ex].sort((a, b) => b.e - a.e), top3 = byE.slice(0, 3), t3 = top3.reduce((a, x) => a + x.e, 0);
    const wSum = ex.filter((x) => x.win).reduce((a, x) => a + x.e, 0), lSum = ex.filter((x) => !x.win).reduce((a, x) => a + x.e, 0), pos = ex.filter((x) => x.e > 0).reduce((a, x) => a + x.e, 0);
    console.log(`\n=== [1-3] DS6 − 069500 초과수익(해마다 복리 수익의 차, %p)의 집중도 ===\n연도별 합 ${sg(tot)}%p(양의 해만 합 ${sg(pos)}%p, 양의 해 ${ex.filter((x) => x.e > 0).length}개 / 음의 해 ${ex.filter((x) => x.e < 0).length}개) | 초과수익 상위 3개 연도 ${top3.map((x) => `${yTag(x.y)} ${sg(x.e)}%p(삼성전자 ${x.win ? "우위" : "열위"} 해)`).join(", ")} → 합 ${sg(t3)}%p = 전체 합의 ${f2((t3 / tot) * 100)}% (양의 해 합 대비 ${f2((t3 / pos) * 100)}%)`);
    console.log(`삼성전자 우위 해(${ex.filter((x) => x.win).length}개) 초과수익 합 ${sg(wSum)}%p = 전체 합의 ${f2((wSum / tot) * 100)}% | 삼성전자 열위 해(${ex.filter((x) => !x.win).length}개) 합 ${sg(lSum)}%p = ${f2((lSum / tot) * 100)}% | 연도별 DS6 − 069500: ${ex.map((x) => `${x.y} ${sg(x.e)}`).join(", ")}`);
    const exNP = ex.filter((x) => !isPartial(x.y)), totNP = exNP.reduce((a, x) => a + x.e, 0), t3NP = [...exNP].sort((a, b) => b.e - a.e).slice(0, 3);
    console.log(`부분 연도(${yTag(firstY)}, ${yTag(lastY)}) 제외 ${exNP.length}개 연도: 합 ${sg(totNP)}%p, 상위 3개 ${t3NP.map((x) => `${x.y} ${sg(x.e)}`).join(", ")} → 합의 ${f2((t3NP.reduce((a, x) => a + x.e, 0) / totNP) * 100)}%; 삼성전자 우위 해 합 ${sg(exNP.filter((x) => x.win).reduce((a, x) => a + x.e, 0))}%p / 열위 해 합 ${sg(exNP.filter((x) => !x.win).reduce((a, x) => a + x.e, 0))}%p`);
  }

  // =====================================================================================================================
  // [2] 환경별 분해
  // =====================================================================================================================
  const sumIdx = (a: ArrayLike<number>, ix: number[]): number => ix.reduce((s, i) => s + a[i], 0);
  {
    const bucket = (b: number): string => (b >= 10 ? "069500 연 +10% 이상" : b >= 0 ? "069500 연 0~10%" : "069500 하락한 해");
    const names = ["069500 연 +10% 이상", "069500 연 0~10%", "069500 하락한 해"];
    for (const [title, keep] of [["부분 연도 포함", () => true], ["부분 연도 제외", (y: string) => !isPartial(y)]] as [string, (y: string) => boolean][]) {
      console.log(`\n=== [2-1] 069500 연간 수익 환경별 DS6 초과수익 분해 (${title}; 연도별 산술 합 %p의 평균: 코어 기여 / LV1 기여 / 비용 / 합) ===\n| 환경 | 연도 수 | 연도 | DS6 − 069500 평균 %p (복리 연 차이) | 코어 기여 | LV1 기여 | 비용 | 합(일별 산술) | 삼성전자 − 069500 평균 %p |\n|---|---|---|---|---|---|---|---|---|`);
      for (const nm of names) {
        const rs = rows.filter((r) => keep(r.y) && bucket(r.b) === nm);
        if (!rs.length) { console.log(`| ${nm} | 0 | - | - | - | - | - | - | - |`); continue; }
        const ixs = rs.map((r) => idxY.get(r.y) as number[]);
        const m = (f: (ix: number[]) => number): number => avg(ixs.map(f));
        console.log(`| ${nm} | ${rs.length} | ${rs.map((r) => `${r.y}(${f2(r.b)})`).join(" ")} | ${sg(avg(rs.map((r) => r.ds - r.b)))} | ${sg(m((ix) => sumIdx(exCore, ix)))} | ${sg(m((ix) => sumIdx(exSat, ix)))} | ${sg(-m((ix) => sumIdx(costPct, ix)))} | ${sg(m((ix) => sumIdx(exTot, ix)))} | ${sg(avg(rs.map((r) => r.sam - r.b)))} |`);
      }
    }
    console.log(`비고: 코어·LV1 기여는 일별 (전일 비중 × (구성 일수익 − 069500 일수익))의 연 내 산술 합이고 비용은 코어-위성 리밸 이동 비용(음수 기여)이다. 세 항의 합은 일별 DS6 − 069500의 산술 합이라 복리 연 차이(앞의 열)와 다를 수 있다. 환경별 연도 수가 적어 평균의 신뢰는 낮다.`);
  }

  // ---- 삼성전자 252일 상대강도(전일 정보만) ----
  const RS_DAYS = 252;
  const bPos = new Map(h.bhP.dates.map((d, k) => [d, k]));
  const bCum = new Float64Array(h.bhP.dates.length + 1);
  bCum[0] = 1;
  h.bhP.ret.forEach((r, k) => { bCum[k + 1] = bCum[k] * (1 + r / 100); });
  const rs = dates0.map((_, i) => {
    const c = h.calIdx.get(dates0[i]) as number, p1 = CAL[c - 1], p0 = CAL[c - 1 - RS_DAYS];
    const a1 = sam.idx.get(p1), a0 = sam.idx.get(p0), k1 = bPos.get(p1), k0 = bPos.get(p0);
    if (a1 === undefined || a0 === undefined || k1 === undefined || k0 === undefined) return Number.NaN;
    return (sam.close[a1] / sam.close[a0]) / (bCum[k1 + 1] / bCum[k0 + 1]) - 1;
  });
  const hold = coreHolds(2, undefined);
  const samW = (i: number): number => hold[i].find(([code]) => code === DS89_SAMSUNG)?.[1] ?? 0;
  const inCore = dates0.map((_, i) => (i === 0 ? samW(0) : samW(i - 1)) > 0);
  const rsTable = (title: string, ix: number[]): void => {
    console.log(`${title}\n| 삼성전자 252일 상대강도(전일) | 일 수 | 비중 % | DS6 − 069500 일평균 %p | 연환산(×252) %p | 표준오차 %p(일) | 삼성전자 − 069500 일평균 %p | 코어 기여 | LV1 기여 | 비용 | 코어 비중 평균 % |\n|---|---|---|---|---|---|---|---|---|---|---|`);
    const valid = ix.filter((i) => Number.isFinite(rs[i]));
    for (const [nm, f] of [["양수(삼성전자 강함)", (i: number) => rs[i] > 0], ["0 이하(약함)", (i: number) => rs[i] <= 0]] as [string, (i: number) => boolean][]) {
      const g = valid.filter(f);
      if (!g.length) { console.log(`| ${nm} | 0 | - | - | - | - | - | - | - | - | - |`); continue; }
      const e = g.map((i) => exTot[i]);
      console.log(`| ${nm} | ${g.length} | ${f2((g.length / valid.length) * 100)} | ${sg(avg(e))} | ${sg(avg(e) * 252)} | ${f2(sd(e) / Math.sqrt(g.length))} | ${sg(avg(g.map((i) => samRet[i] - bRet[i])))} | ${sg(avg(g.map((i) => exCore[i])))} | ${sg(avg(g.map((i) => exSat[i])))} | ${sg(-avg(g.map((i) => costPct[i])))} | ${f2(avg(g.map((i) => wCprev(i))) * 100)} |`);
    }
    console.log(`(상대강도 계산 불가로 제외 ${ix.length - valid.length}일)`);
  };
  const allIx = dates0.map((_, i) => i);
  rsTable(`\n=== [2-2] 삼성전자 252일 상대강도(069500 대비, 전일 종가까지)별 DS6 일평균 초과수익 — 전체 ${n}일 ===`, allIx);
  for (const [wn, w] of NW) rsTable(`\n[2-2] ${wn}`, allIx.filter((i) => dates0[i] >= w.from && dates0[i] <= (w.to > h.dataEnd ? h.dataEnd : w.to)));
  {
    const stints: [string, string, number][] = [];
    let s0 = -1;
    for (let i = 0; i <= n; i++) {
      if (i < n && inCore[i]) { if (s0 < 0) s0 = i; } else if (s0 >= 0) { stints.push([dates0[s0], dates0[i - 1], i - s0]); s0 = -1; }
    }
    console.log(`\n=== [2-3] 삼성전자가 코어에 머문 기간(전일 종가 기준 코어 보유) ===\n머문 날 ${inCore.filter(Boolean).length}/${n}일(${f2((inCore.filter(Boolean).length / n) * 100)}%), 연속 보유 구간 ${stints.length}개: ${stints.map((x) => `${x[0]}~${x[1]}(${x[2]}일)`).join(", ")}`);
    rsTable(`삼성전자가 코어에 있던 날만(상대강도별 DS6 일평균 초과수익):`, allIx.filter((i) => inCore[i]));
    const notIn = allIx.filter((i) => !inCore[i]);
    if (notIn.length) rsTable(`삼성전자가 코어에 없던 날(${notIn.length}일):`, notIn);
    // 상대강도 약함 에피소드(20거래일 이상 연속)
    const MIN_EP = 20, eps: [number, number][] = [];
    let a = -1;
    for (let i = 0; i <= n; i++) {
      const weak = i < n && Number.isFinite(rs[i]) && rs[i] <= 0;
      if (weak) { if (a < 0) a = i; } else if (a >= 0) { if (i - a >= MIN_EP) eps.push([a, i - 1]); a = -1; }
    }
    console.log(`\n상대강도 0 이하가 ${MIN_EP}거래일 이상 이어진 구간 ${eps.length}개 (일별 합산 %p; 삼성전자가 코어에 있던 날 비율 포함):\n| 시작~끝 | 일 수 | 코어 보유 일 | 삼성전자 − 069500 | DS6 − 069500 | 코어 기여 | LV1 기여 | 비용 | 같은 기간 069500 수익 복리 % |\n|---|---|---|---|---|---|---|---|---|`);
    for (const [s1, e1] of eps) {
      const ix = allIx.filter((i) => i >= s1 && i <= e1);
      console.log(`| ${dates0[s1]}~${dates0[e1]} | ${ix.length} | ${ix.filter((i) => inCore[i]).length} | ${sg(sumIdx(samRet, ix) - sumIdx(bRet, ix))} | ${sg(sumIdx(exTot, ix))} | ${sg(sumIdx(exCore, ix))} | ${sg(sumIdx(exSat, ix))} | ${sg(-sumIdx(costPct, ix))} | ${f2(comp(bRet, ix))} |`);
    }
    const weakIx = allIx.filter((i) => Number.isFinite(rs[i]) && rs[i] <= 0), inEp = new Set(eps.flatMap(([s1, e1]) => allIx.filter((i) => i >= s1 && i <= e1)));
    console.log(`상대강도 0 이하인 날 ${weakIx.length}일 중 위 구간에 든 날 ${weakIx.filter((i) => inEp.has(i)).length}일; 위 구간 밖 약한 날의 DS6 − 069500 일평균 ${sg(avg(weakIx.filter((i) => !inEp.has(i)).map((i) => exTot[i])))}%p, 구간 안 ${sg(avg(weakIx.filter((i) => inEp.has(i)).map((i) => exTot[i])))}%p`);
  }

  // =====================================================================================================================
  // [3] 쏠림 진단: 코어 종목별 보유 기간·기여
  // =====================================================================================================================
  {
    const hw = (i: number): [string, number][] => (i === 0 ? hold[0] : hold[i - 1]);
    interface SRec { code: string; spans: [number, number][]; days: number; wCore: number; wAcct: number; contrib: number; excess: number; byYear: Map<string, number> }
    const recs = new Map<string, SRec>();
    for (let i = 0; i < n; i++) for (const [code, w] of hw(i)) {
      let r = recs.get(code);
      if (!r) { r = { code, spans: [], days: 0, wCore: 0, wAcct: 0, contrib: 0, excess: 0, byYear: new Map() }; recs.set(code, r); }
      const rr = stockRet(byCode.get(code) as S, i), wa = wCprev(i) * w;
      const last = r.spans[r.spans.length - 1];
      if (last && last[1] === i - 1) last[1] = i; else r.spans.push([i, i]);
      r.days++; r.wCore += w; r.wAcct += wa; r.contrib += wa * rr; r.excess += wa * (rr - bRet[i]);
      const y = dates0[i].slice(0, 4); r.byYear.set(y, (r.byYear.get(y) ?? 0) + wa * (rr - bRet[i]));
    }
    const list = [...recs.values()].sort((a, b) => b.excess - a.excess);
    const totEx = sumIdx(exCore, allIx), samR = recs.get(DS89_SAMSUNG), othersEx = list.filter((r) => r.code !== DS89_SAMSUNG).reduce((a, r) => a + r.excess, 0);
    console.log(`\n=== [3-1] 코어 종목별 보유 기간과 기여 (DS6 코어 = 상위 2종목; 기여 = Σ 전일 계좌 비중 × 종목 일수익, 초과 기여 = Σ 전일 계좌 비중 × (종목 일수익 − 069500 일수익); %p 산술 합, ${n}일) ===\n| 종목 | 코어 보유 구간(연속 구간 수) | 보유 일 수 | 코어 안 평균 비중 % | 평균 계좌 비중 % (보유일 평균) | DS6 수익 기여 합 | 069500 대비 초과 기여 합 |\n|---|---|---|---|---|---|---|`);
    for (const r of list) console.log(`| ${r.code} ${nameOf.get(r.code) ?? "?"} | ${r.spans.map(([s1, e1]) => `${dates0[s1]}~${dates0[e1]}`).join(", ")} (${r.spans.length}) | ${r.days} | ${f2((r.wCore / r.days) * 100)} | ${f2((r.wAcct / r.days) * 100)} | ${sg(r.contrib)} | ${sg(r.excess)} |`);
    console.log(`코어 초과 기여 합(코어 비중 × (코어 일수익 − 069500)) ${sg(totEx)}%p = 삼성전자 ${sg(samR?.excess ?? 0)} + 삼성전자 외 ${sg(othersEx)} + 잔차(코어 내부 거래 비용·현금 비중 등) ${sg(totEx - (samR?.excess ?? 0) - othersEx)}`);
    const nSamOnly = allIx.filter((i) => hw(i).length === 1 && hw(i)[0][0] === DS89_SAMSUNG).length, nTwo = allIx.filter((i) => hw(i).length >= 2).length;
    console.log(`삼성전자 외 코어 종목이 같이 있던 날 ${allIx.filter((i) => hw(i).some(([c]) => c !== DS89_SAMSUNG)).length}/${n}일 (코어 종목 2개인 날 ${nTwo}, 삼성전자만 있던 날 ${nSamOnly})`);
    const ys = [...new Set(dates0.map((d) => d.slice(0, 4)))];
    console.log(`\n=== [3-2] 연도별 DS6 − 069500 초과 기여 분해 (일별 산술 합 %p) ===\n| 연도 | 삼성전자 | 삼성전자 외 코어 종목 | 코어 잔차 | LV1 | 비용 | 합 | 삼성전자 외 코어 종목(기여 큰 순) |\n|---|---|---|---|---|---|---|---|`);
    for (const y of ys) {
      const ix = idxY.get(y) as number[], sa = samR?.byYear.get(y) ?? 0;
      const oth = list.filter((r) => r.code !== DS89_SAMSUNG).map((r) => ({ nm: nameOf.get(r.code) ?? r.code, v: r.byYear.get(y) ?? 0 })).filter((x) => x.v !== 0).sort((a, b) => Math.abs(b.v) - Math.abs(a.v)), othSum = oth.reduce((a, x) => a + x.v, 0);
      const core = sumIdx(exCore, ix);
      console.log(`| ${yTag(y)} | ${sg(sa)} | ${sg(othSum)} | ${sg(core - sa - othSum)} | ${sg(sumIdx(exSat, ix))} | ${sg(-sumIdx(costPct, ix))} | ${sg(sumIdx(exTot, ix))} | ${oth.slice(0, 3).map((x) => `${x.nm} ${sg(x.v)}`).join(", ") || "-"} |`);
    }
  }

  // ---- 한계·실행 지표 ----
  console.log(`\n한계: 사후 분해이며 인과 증명이 아니다(2011~2026 경로 하나, 069500 대비). 연도·환경 표본이 적어 평균·비중에 유의성을 주장하지 않는다. 판정·새 후보 설계 근거로 쓰지 않는다. 시험 번호 275 유지, DS6 정의 변경 없음.`);
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ") || "없음"} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
  void randLV1; void lv1ReplSet; void zeroSl; void coreReplSet; void evLine; void median; void membAt; void excluded; void SLIPPAGE_PCT_PER_SIDE; void CS_RANK_DEPTH; void L_EVAL_AFTER; void CS_SWAP_CONFIRM_DAYS; void DS9_CORE_N; void nCal; void capWeights; void F_E_TOP_TRADES; void LV_CANDS;
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

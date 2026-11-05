/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] VKOSPI 후속 1단계: 스캔 후보의 확인 구간 재현 점검(시험 아님, 시험 번호 285 유지). 사전등록: docs/research/vkospi-confirm-prereg.md.
 * 069500 V1(수준)·V4(급등일) H=5·21·63, DS6 V4 H=21을 확인 구간 2017-01-01~2021-12-31에서 같은 방식으로 계산(재현 기준: 같은 부호 + |t(NW)| ≥ 2.0 + 비용 차감 순차이 > 0).
 * 069500의 V1 또는 V4가 세 H 중 2개 이상 재현이면 "재현" → 보류 구간(2022-01~2026-10-26)을 한 번 열어 같은 부호·순차이 > 0인지만 보고(참고용). 아니면 보류 구간은 열지 않는다.
 * DS6 계산은 scripts/diagnose-ds6-followup.ts를 그대로 옮긴 것(정의 변경 없음). VKOSPI 정리본은 Actions 캐시 .vkospi-inputs(Storage 읽기 0).
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
import { ALLOC_SERIES_SHA, type AllocCompId } from "@/lib/strategyAllocationConfig";
import { P17_RUN_START, P17_END, P17_CAND, P17_DROP_TOP } from "@/lib/ds6Pre2017Config";
import { CS_SWAP_CONFIRM_DAYS, CS_RANK_DEPTH, CS_MOVE_COST, CS_ACCOUNTING_TOL_PP } from "@/lib/coreSatelliteConfig";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, SNAP_END, f2, type S, type Win } from "./researchHarness";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";
import { parquetReadObjects } from "hyparquet";
import { FEE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";
import { VK_CACHE_DIR, VK_IDX_NAME, VK_FROM, VK_PCT_WINDOW, VK_SPIKE_RET, VK_HI, VK_LO, vkNwLag, VK_MAX_MISSING_RATIO, VK_SPIKE_MIN_EVENTS_NOTE } from "@/lib/vkospiScanConfig";
import { VC_CONFIRM_FROM, VC_CONFIRM_TO, VC_HOLDOUT_FROM, VC_HOLDOUT_TO, VC_MIN_ABS_T, VC_MIN_H_PASS, VC_SIGNALS_069500, VC_HORIZONS, VC_DS6_ROW, VC_LEARN_SIGN, VC_DS6_FULL_REC, VC_DS6_CAGR_TOL } from "@/lib/vkospiConfirmConfig";

const T0 = Date.now();
const sha = (b: Uint8Array | Buffer | string): string => createHash("sha256").update(b).digest("hex");
type CId = AllocCompId;
type CO = { lag: number; replace?: Set<string>; detail?: boolean; onDay?: (c: number, V: number, held: [string, number][]) => void };
interface Comp { id: CId; label: (code: string) => string; run: (o: CO) => SimRun; random: (rng: () => number, ob: Map<number, number>) => SimRun }
/** 공통 평가 시작 이후로 자른 일별 계열(구성요소 하나의 계좌 기준). */
interface Sl { dates: string[]; ret: number[]; costFrac: number[]; nPos: number[]; inv: number[]; turn: number[]; wMax: number[] }

async function main(): Promise<void> {
  const REPRO = process.env.ALLOC_MODE?.trim().toLowerCase() === "repro";
  console.log(`연구 DS6 후속 진단(시험 아님, 번호 소진 없음, 누적 272 유지) ${REPRO ? "사전 점검(재현·자체 점검만)" : "실행"} 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const h0 = await loadHarness();
  const h = h0;
  const { CAL, nCal, byCode, calIdx } = h;
  const { excluded, membAt, nameOf, indOf } = await loadK200P(h);
  void indOf;

  // ---- 평가 구간: 초기 배분 2011-01-03 종가(LV1 250거래일 워밍업 뒤 첫 거래일), 수익 집계 2011-01-04~데이터 끝 ----
  const cPE = CAL.findIndex((d) => d >= P17_RUN_START);
  if (cPE < 0 || CAL[cPE] !== P17_RUN_START) throw new Error(`${P17_RUN_START}이 거래일 달력에 없음`);
  const cutC = cPE + 1;
  const FULL: Win = { from: CAL[cutC], to: "9999-12-31" };
  const WA: Win = { from: FULL.from, to: P17_END }, WB: Win = { from: "2017-04-04", to: "9999-12-31" };
  const WALL: [string, Win][] = [["구간 A 2011-01~2016-12", WA], ["구간 B 2017-04~2026-10", WB], ["연속 전체 2011-01~2026-10", FULL]];
  console.log(`연속 평가: 초기 배분 ${CAL[cPE]} 종가(비용 없음), 수익률 집계 ${FULL.from}~${h.dataEnd}(LV1 250거래일 워밍업 뒤 첫 수익 집계일 ${FULL.from}) | ${WALL.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);

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

  // ---- 기준 계열 ----
  const coreCache = new Map<string, CoreRun>(), coreSlCache = new Map<string, Sl>();
  const keyC = (N: number, lag: number, repl?: Set<string>): string => `${N}|${lag}|${repl ? [...repl].sort().join(",") : ""}`;
  const getCore = (N: number, lag: number, repl?: Set<string>): CoreRun => { const k = keyC(N, lag, repl); let r = coreCache.get(k); if (!r) { r = simCore(N, { lag, replace: repl }); coreCache.set(k, r); } return r; };
  const getCoreSl = (N: number, lag: number, repl?: Set<string>): Sl => { const k = keyC(N, lag, repl); let s = coreSlCache.get(k); if (!s) { s = slice(getCore(N, lag, repl)); coreSlCache.set(k, s); } return s; };
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
  console.log(`\n=== 1c. 코어 구조·회계 점검 (성과 계산·비교 아님; N=2만; 월말 K200P 구성 안 당일 시총 상위 N종목, 교체 확인 ${CS_SWAP_CONFIRM_DAYS}거래일, 체결 다음 거래일 종가) ===`);
  coreCheck(2);
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
  // 후속 진단 (판정에 쓰지 않는다. 사후 분해이며 인과가 아니다)
  // =====================================================================================================================
  const lv1 = comps[0];
  const satSl = (lag: number): Sl => getSl(lv1, lag);
  const checkAxis = (s: Sl, name: string): void => { if (s.dates.length !== nDays || s.dates.some((d, k) => d !== dates0[k])) throw new Error(`${name} 날짜 축이 기준과 다르다`); };
  const COREW = P17_CAND.coreW, CN = P17_CAND.coreN;
  interface Var { coreLag: number; satLag: number; delay: number; rate?: number; dropTop?: boolean }
  const varCache = new Map<string, CombOut>();
  const coreXCache = new Map<number, { run: CoreRun; sl: Sl }>();
  const coreOf = (lag: number, dropTop: boolean): { run: CoreRun; sl: Sl } => {
    if (!dropTop) return { run: getCore(CN, lag), sl: getCoreSl(CN, lag) };
    let v = coreXCache.get(lag);
    if (!v) { const run = simCore(CN, { lag, dropTop: P17_DROP_TOP }); v = { run, sl: slice(run) }; coreXCache.set(lag, v); }
    return v;
  };
  const build = (v: Var): CombOut => {
    const k = JSON.stringify(v);
    let r = varCache.get(k);
    if (!r) { const c = coreOf(v.coreLag, !!v.dropTop).sl, s = satSl(v.satLag); checkAxis(c, "코어"); checkAxis(s, "LV1"); r = combineCS(c, s, COREW, v.rate ?? CS_MOVE_COST, v.delay); varCache.set(k, r); }
    return r;
  };
  // =====================================================================================================================
  // VKOSPI 신호 스캔 (사전등록 docs/research/vkospi-scan-prereg.md; 학습 구간만, 전략 백테스트 없음)
  // =====================================================================================================================
  const base = build({ coreLag: 1, satLag: 1, delay: 0 });
  // ---- DS6 연속 전체 재현 점검(대상 DS6 행용, 사전등록 1.2절) ----
  let ds6ok = false;
  {
    const sF = h.st(base.run, FULL);
    const dC = Math.abs(sF.cagr - VC_DS6_FULL_REC.cagr);
    ds6ok = dC <= VC_DS6_CAGR_TOL + 1e-9 && f2(sF.mdd) === f2(VC_DS6_FULL_REC.mdd);
    console.log(`\nDS6 연속 전체(${FULL.from}~${h.dataEnd}) CAGR ${sF.cagr.toFixed(6)} / MDD ${sF.mdd.toFixed(6)} | 기록 ${VC_DS6_FULL_REC.cagr} / ${VC_DS6_FULL_REC.mdd} | CAGR 차이 ${dC.toFixed(6)}%p → ${ds6ok ? "통과(DS6 행 계산)" : "불일치(DS6 행은 계산하지 않음)"}`);
  }
  // ---- 대상 수준: 2011-01-03(초기 배분) 종가 = 1 ----
  const lv69 = new Float64Array(nCal).fill(NaN), lvDs = new Float64Array(nCal).fill(NaN);
  {
    const r69 = new Map<string, number>();
    h.bhP.dates.forEach((d, i) => { r69.set(d, h.bhP.ret[i] / 100); });
    const rds = new Map(base.run.dates.map((d, i) => [d, base.run.ret[i] / 100]));
    let a = 1, b = 1;
    for (let k = cPE; k < nCal; k++) {
      if (k > cPE) { const x = r69.get(CAL[k]), y = rds.get(CAL[k]); if (x === undefined || y === undefined) throw new Error(`${CAL[k]} 수익률 없음`); a *= 1 + x; b *= 1 + y; }
      lv69[k] = a; lvDs[k] = b;
    }
  }
  // ---- VKOSPI 정리본: 전 연도 SHA 대조, 값은 연도 상한까지만 읽는다(보류 구간 2022~는 "재현" 판정 뒤에만) ----
  const vkMan = JSON.parse(await fs.readFile(path.join(VK_CACHE_DIR, "manifest.json"), "utf8")) as { idxName: string; files: { name: string; bytes: number; sha256: string; rows: number }[] };
  for (const f of vkMan.files) {
    const buf = await fs.readFile(path.join(VK_CACHE_DIR, f.name));
    if (buf.byteLength !== f.bytes || sha(buf) !== f.sha256) throw new Error(`VKOSPI 정리본 ${f.name} 매니페스트 불일치 — 중단하고 보고한다`);
  }
  console.log(`VKOSPI 정리본 매니페스트 대조 통과: 파일 ${vkMan.files.length}개 SHA-256 일치, 지수명 "${vkMan.idxName}"${vkMan.idxName === VK_IDX_NAME ? "" : " (사전등록과 다름)"}`);
  const Cv = new Float64Array(nCal).fill(NaN);
  const loadedYears = new Set<number>();
  let dupDates = 0, notInCal = 0;
  const loadYearsUpTo = async (maxYear: number): Promise<void> => {
    for (const f of vkMan.files) {
      const y = Number(f.name.slice(0, 4));
      if (y > maxYear || loadedYears.has(y)) continue;
      loadedYears.add(y);
      const buf = await fs.readFile(path.join(VK_CACHE_DIR, f.name));
      const rows = (await parquetReadObjects({ file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer })) as Record<string, unknown>[];
      for (const r of rows) { const k = calIdx.get(String(r.trade_date)); if (k === undefined) { notInCal++; continue; } if (Number.isFinite(Cv[k])) dupDates++; Cv[k] = Number(r.close); }
    }
  };
  // ---- 신호(스캔 사전등록 3절의 V1·V4, 학습 구간 값을 포함해 2011-01-03부터 이어서 계산) ----
  const pctRank = (vals: number[], v: number): number => { let less = 0, eq = 0; for (const x of vals) { if (x < v) less++; else if (x === v) eq++; } return (less + 0.5 * eq) / vals.length; };
  interface Pt { k: number; z1: number; d: number }
  const buildPts = (): Pt[] => {
    const pts: Pt[] = [], hist: number[] = [];
    let j = -1;
    for (let k = 0; k < nCal; k++) {
      if (!Number.isFinite(Cv[k]) || CAL[k] < VK_FROM) continue;
      j++; hist.push(Cv[k]);
      if (j < VK_PCT_WINDOW - 1) continue;
      const c1 = k >= 1 ? Cv[k - 1] : NaN;
      if (!Number.isFinite(c1)) continue;
      pts.push({ k, z1: pctRank(hist, Cv[k]), d: Cv[k] / c1 - 1 >= VK_SPIKE_RET ? 1 : 0 });
    }
    return pts;
  };
  const meanA = (a: number[]): number => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1);
  const olsNw = (x: number[], y: number[], L: number): { b: number; t: number } => {
    const n = x.length, mx = meanA(x), my = meanA(y);
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
    if (!(sxx > 0) || n < 4) return { b: NaN, t: NaN };
    const b = sxy / sxx, u = x.map((xi, i) => (xi - mx) * (y[i] - my - b * (xi - mx)));
    let om = u.reduce((s, v) => s + v * v, 0);
    for (let q = 1; q <= L && q < n; q++) { let s = 0; for (let t = q; t < n; t++) s += u[t] * u[t - q]; om += 2 * (1 - q / (L + 1)) * s; }
    return { b, t: om > 0 ? b / Math.sqrt(om / (sxx * sxx)) : NaN };
  };
  const olsPlainT = (x: number[], y: number[]): number => {
    const n = x.length, mx = meanA(x), my = meanA(y);
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
    if (!(sxx > 0) || n < 10) return NaN;
    const b = sxy / sxx;
    let sse = 0;
    for (let i = 0; i < n; i++) sse += (y[i] - my - b * (x[i] - mx)) ** 2;
    const se = Math.sqrt(sse / (n - 2) / sxx);
    return se > 0 ? b / se : NaN;
  };
  const med = (a: number[]): number => { const b = [...a].filter(Number.isFinite).sort((p, q) => p - q); return b.length ? b[Math.floor(b.length / 2)] : NaN; };
  const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "-");
  const ONEWAY: Record<"069500" | "DS6", number> = { "069500": FEE_PCT_PER_SIDE + SLIPPAGE_PCT_PER_SIDE, DS6: CS_MOVE_COST };
  const lastIdxOnOrBefore = (d: string): number => { let r = -1; for (let k = 0; k < nCal; k++) if (CAL[k] <= d) r = k; return r; };
  interface RowRes { tgt: "069500" | "DS6"; sig: "V1" | "V4"; H: number; n: number; nEff: number; b: number; t: number; tNo: number; nA: number; extra: string; sp: number; cost: number; net: number; signOk: boolean; tOk: boolean; netOk: boolean; pass: boolean }
  const evalRow = (pts: Pt[], tgt: "069500" | "DS6", sig: "V1" | "V4", H: number, from: string, to: string, lastExit: number): RowRes => {
    const lv = tgt === "069500" ? lv69 : lvDs;
    const rows = pts.filter((p) => CAL[p.k] >= from && CAL[p.k] <= to && p.k + 1 + H <= lastExit).map((p) => ({ p, y: lv[p.k + 1 + H] / lv[p.k + 1] - 1 })).filter((r) => Number.isFinite(r.y));
    const spike = sig === "V4";
    const X = rows.map((r) => (spike ? r.p.d : r.p.z1 - 0.5)), Y = rows.map((r) => r.y);
    const { b, t } = olsNw(X, Y, vkNwLag(H));
    const nps: number[] = [];
    for (let o = 0; o < H; o++) { const xs: number[] = [], ys: number[] = []; for (let i = o; i < rows.length; i += H) { xs.push(X[i]); ys.push(Y[i]); } nps.push(olsPlainT(xs, ys)); }
    let sp = NaN, cost = NaN, nA = 0, extra = "";
    if (spike) {
      const yA = rows.filter((r) => r.p.d === 1).map((r) => r.y), yB = rows.filter((r) => r.p.d === 0).map((r) => r.y);
      nA = yA.length; sp = yA.length && yB.length ? (meanA(yA) - meanA(yB)) * 100 : NaN; cost = 2 * ONEWAY[tgt] * 100;
      let lastE = -1e9, ev = 0;
      for (const r of rows) if (r.p.d === 1 && r.p.k - lastE > H) { ev++; lastE = r.p.k; }
      extra = `${ev}${ev < VK_SPIKE_MIN_EVENTS_NOTE ? "(표본 부족)" : ""}`;
    } else {
      const top = rows.filter((r) => r.p.z1 >= VK_HI), bot = rows.filter((r) => r.p.z1 <= VK_LO);
      nA = top.length; extra = String(bot.length);
      sp = top.length && bot.length ? (meanA(top.map((r) => r.y)) - meanA(bot.map((r) => r.y))) * 100 : NaN;
      let prev = -1, ch = 0, tb = 0;
      for (const r of rows) { const st = r.p.z1 >= VK_HI ? 1 : r.p.z1 <= VK_LO ? 0 : -1; if (st < 0) continue; tb++; if (prev >= 0 && st !== prev) ch++; prev = st; }
      cost = tb ? (ch / tb) * 2 * ONEWAY[tgt] * 100 : NaN;
    }
    const dir = Math.sign(b);
    const net = Number.isFinite(sp) && Number.isFinite(cost) ? dir * sp - cost : NaN;
    const signOk = b * VC_LEARN_SIGN > 0, tOk = Number.isFinite(t) && Math.abs(t) >= VC_MIN_ABS_T, netOk = Number.isFinite(net) && net > 0;
    return { tgt, sig, H, n: rows.length, nEff: rows.length / H, b, t, tNo: med(nps), nA, extra, sp, cost, net, signOk, tOk, netOk, pass: signOk && tOk && netOk };
  };
  const SIGN = (b: boolean): string => (b ? "O" : "X");
  const printRows = (title: string, rs: RowRes[], refOnly: boolean): void => {
    console.log(`\n=== ${title} ===\n| 대상 | 신호 | H | 표본일 수 | n_eff | b (%p) | t(NW) | 비중복 t | 상위/급등 표본 | ${"하위 표본 / 독립 사건"} | 차이 % | 비용 % | 방향 반영 순차이 % | 부호 + | ${refOnly ? "순차이 > 0" : "|t| ≥ " + VC_MIN_ABS_T} | ${refOnly ? "(참고)" : "순차이 > 0"} | ${refOnly ? "같은 부호·순차이 > 0" : "재현"} |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
    for (const r of rs) console.log(`| ${r.tgt} | ${r.sig} | ${r.H} | ${r.n} | ${r.nEff.toFixed(0)} | ${f3(r.b * 100)} | ${f2(r.t)} | ${f2(r.tNo)} | ${r.nA} | ${r.extra} | ${f2(r.sp)} | ${f2(r.cost)} | ${f2(r.net)} | ${SIGN(r.signOk)} | ${refOnly ? SIGN(r.netOk) : SIGN(r.tOk)} | ${refOnly ? "" : SIGN(r.netOk)} | ${refOnly ? SIGN(r.signOk && r.netOk) : SIGN(r.pass)} |`);
  };
  const precheck = (label: string, from: string, to: string): boolean => {
    const ks: number[] = [];
    for (let k = 0; k < nCal; k++) if (CAL[k] >= from && CAL[k] <= to) ks.push(k);
    const miss = ks.filter((k) => !Number.isFinite(Cv[k])).length, bad = ks.filter((k) => Number.isFinite(Cv[k]) && !(Cv[k] > 0)).length;
    const jumps: string[] = [];
    for (let q = 1; q < ks.length; q++) { const a = Cv[ks[q - 1]], b = Cv[ks[q]]; if (Number.isFinite(a) && Number.isFinite(b) && (b / a - 1 <= -0.5 || b / a - 1 >= 1)) jumps.push(CAL[ks[q]]); }
    const ok = miss / ks.length <= VK_MAX_MISSING_RATIO && bad === 0 && jumps.length === 0 && dupDates === 0;
    console.log(`선행 조건(${label} ${from}~${to}): 거래일 ${ks.length}일 중 VKOSPI 값 없는 날 ${miss}일(${(miss / ks.length * 100).toFixed(2)}%, 상한 ${VK_MAX_MISSING_RATIO * 100}%) | 종가 0 이하 ${bad}건 | 전일 대비 −50% 이하·+100% 이상 ${jumps.length}건 | 달력에 없는 날짜 ${notInCal}개 | 중복 날짜 ${dupDates} → ${ok ? "통과" : "미충족"}`);
    return ok;
  };

  // =================== 확인 구간 ===================
  await loadYearsUpTo(Number(VC_CONFIRM_TO.slice(0, 4)));
  const lastC = lastIdxOnOrBefore(VC_CONFIRM_TO);
  console.log(`\n확인 구간 ${VC_CONFIRM_FROM}~${VC_CONFIRM_TO}: 마지막 거래일 ${CAL[lastC]}(청산일 상한). VKOSPI 읽은 연도 ${[...loadedYears].sort().join(", ")}(2022년 이후 파일은 읽지 않음)`);
  if (!precheck("확인", VC_CONFIRM_FROM, VC_CONFIRM_TO)) { console.log("선행 조건 미충족 — 점검하지 않고 숫자만 보고한다"); return; }
  const ptsC = buildPts();
  const conf: RowRes[] = [];
  for (const sig of VC_SIGNALS_069500) for (const H of VC_HORIZONS) conf.push(evalRow(ptsC, "069500", sig, H, VC_CONFIRM_FROM, VC_CONFIRM_TO, lastC));
  if (ds6ok) conf.push(evalRow(ptsC, "DS6", VC_DS6_ROW.signal, VC_DS6_ROW.h, VC_CONFIRM_FROM, VC_CONFIRM_TO, lastC));
  printRows(`1단계 확인 구간 ${VC_CONFIRM_FROM}~${VC_CONFIRM_TO} (재현 기준: 부호 + 이고 |t(NW)| ≥ ${VC_MIN_ABS_T} 이고 비용 차감 순차이 > 0)`, conf, false);
  const passBy = (sig: string): number => conf.filter((r) => r.tgt === "069500" && r.sig === sig && r.pass).length;
  const reproduced = VC_SIGNALS_069500.some((s) => passBy(s) >= VC_MIN_H_PASS);
  console.log(`\n판정: 069500 V1 재현 H ${passBy("V1")}/3, V4 재현 H ${passBy("V4")}/3 (기준 ${VC_MIN_H_PASS}개 이상) → **${reproduced ? "재현" : "재현 아님"}**`);

  if (!reproduced) {
    console.log("재현이 아니므로 보류 구간은 열지 않고(VKOSPI 2022년 이후 파일 읽지 않음, 보류 구간 통계 계산 0) 2단계를 하지 않는다.");
  } else {
    // =================== 보류 구간(재현일 때만 한 번, 참고용) ===================
    await loadYearsUpTo(2100);
    const lastH = nCal - 1, lastHds = nCal - 2;
    console.log(`\n보류 구간 ${VC_HOLDOUT_FROM}~${VC_HOLDOUT_TO}: 재현 판정 뒤 VKOSPI 2022년 이후 파일을 읽었다(읽은 연도 ${[...loadedYears].sort().join(", ")}). 마지막 거래일 ${CAL[lastH]}`);
    if (!precheck("보류", VC_HOLDOUT_FROM, VC_HOLDOUT_TO)) { console.log("보류 구간 선행 조건 미충족 — 보류 구간 통계는 계산하지 않는다(참고용이라 2단계 진행에는 영향 없음)"); } else {
      const ptsH = buildPts();
      const hold: RowRes[] = [];
      for (const sig of VC_SIGNALS_069500) for (const H of VC_HORIZONS) hold.push(evalRow(ptsH, "069500", sig, H, VC_HOLDOUT_FROM, VC_HOLDOUT_TO, lastH));
      if (ds6ok) hold.push(evalRow(ptsH, "DS6", VC_DS6_ROW.signal, VC_DS6_ROW.h, VC_HOLDOUT_FROM, VC_HOLDOUT_TO, lastHds));
      printRows(`보류 구간 ${VC_HOLDOUT_FROM}~${VC_HOLDOUT_TO} (참고용: 같은 부호이고 순차이 > 0인지만 보고, 판정·2단계에 쓰지 않음)`, hold, true);
    }
  }
  console.log(`\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)} | 쓴 행 0 | Storage 읽기 0 | 외부 요청 0 | DART 호출 0 | 시험 번호 285 유지(점검) | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

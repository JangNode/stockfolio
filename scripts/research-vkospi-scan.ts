/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] VKOSPI(코스피 200 변동성지수) 신호 스캔(가벼운 버전, 시험 아님, 시험 번호 285 유지). 사전등록: docs/research/vkospi-scan-prereg.md.
 * 신호 4개(수준·5일 변화율·252일 백분위·급등일) → 069500·DS6의 이후 5·21·63거래일 수익률, 학습 구간(~2016-12-31)만, 24행. 후보 = |t(NW)| ≥ 3.0 + 방향 반영 순차이 > 0.
 * DS6 계산은 scripts/diagnose-ds6-followup.ts를 그대로 옮겼고(정의 변경 없음), 달력·시뮬레이션을 학습 구간 끝(RESEARCH_DATA_END=2016-12-29, 학습 구간 마지막 거래일)에서 자른다.
 * 입력: 고정 스냅샷·069500 보조 파일·월말 시장 목록·이전 연구 LV1 일별 순수익 캐시(대조용)·VKOSPI 정리본(Actions 캐시 .vkospi-inputs, Storage 읽기 0). 학습 구간 밖 VKOSPI 연도 파일은 SHA 대조만 하고 읽지 않는다.
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
import { computeCumulativeAndMdd, computeCagrPct } from "@/lib/strategyBacktestSummary";
import { FEE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";
import { SCAN_CANDIDATE_ABS_T } from "@/lib/signalScanConfig";
import { VK_CACHE_DIR, VK_IDX_NAME, VK_FROM, VK_LEARN_END, VK_CHG_DAYS, VK_PCT_WINDOW, VK_SPIKE_RET, VK_HORIZONS, VK_HI, VK_LO, vkNwLag, VK_MAX_MISSING_RATIO, VK_DS6_REPRO, VK_DS6_CAGR_TOL, VK_SPIKE_MIN_EVENTS_NOTE } from "@/lib/vkospiScanConfig";

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
  {
    const sA = h.st(base.run, WA);
    const dC = Math.abs(sA.cagr - Number(VK_DS6_REPRO.cagr));
    const okOld = f2(sA.cagr) === VK_DS6_REPRO.cagr && f2(sA.mdd) === VK_DS6_REPRO.mdd;
    const ok = dC <= VK_DS6_CAGR_TOL + 1e-9 && f2(sA.mdd) === VK_DS6_REPRO.mdd;
    console.log(`\n선행 조건 DS6 재현: 구간 A(${WA.from}~${h.dataEnd}) DS6 CAGR ${sA.cagr.toFixed(6)} / MDD ${sA.mdd.toFixed(6)} (소수 6자리) | 시도 272 기록 ${VK_DS6_REPRO.cagr} / ${VK_DS6_REPRO.mdd}, 묶음 2 기록 4.11 / 24.51 | CAGR 차이 ${dC.toFixed(6)}%p | 소수 둘째 자리 반올림 ${f2(sA.cagr)} / ${f2(sA.mdd)} | 옛 판정(둘째 자리 일치) ${okOld ? "통과" : "불일치"}, 승인된 판정(CAGR 차이 ${VK_DS6_CAGR_TOL}%p 이내 + MDD 둘째 자리 일치) ${ok ? "통과" : "불일치"}`);
    {
      const rIn = base.run.ret.filter((_, i) => base.run.dates[i] >= WA.from && base.run.dates[i] <= WA.to);
      const tot = computeCumulativeAndMdd(rIn).totalReturnPct;
      console.log(`  진단: 구간 A 일수익률 ${rIn.length}개 누적수익 ${tot.toFixed(6)}% | 같은 누적수익의 CAGR: 환산 종료일 ${h.dataEnd} → ${computeCagrPct(tot, WA.from, h.dataEnd).toFixed(6)}, 환산 종료일 ${P17_END}(시도 272·DS6 후속 진단이 쓴 구간 끝, 휴장일) → ${computeCagrPct(tot, WA.from, P17_END).toFixed(6)}`);
    }
    if (!ok) throw new Error("DS6 재현이 승인된 판정 기준을 만족하지 않는다 — 스캔하지 않고 보고한다");
    if (process.env.VKOSPI_MODE === "repro") { console.log("VKOSPI_MODE=repro: 재현 점검만 하고 종료한다(VKOSPI 데이터 읽기 0, 신호 계산 0)"); return; }
  }
  const lastU = nCal - 2; // 마지막 거래일은 시뮬레이터가 기간 끝 강제 청산을 하므로 청산일로 쓰지 않는다
  console.log(`학습 구간 달력 ${CAL[0]}~${CAL[nCal - 1]}(${nCal}일), 청산일 상한 ${CAL[lastU]}`);
  // ---- 대상 수준: 2011-01-03(초기 배분) 종가 = 1 ----
  const lv69 = new Float64Array(nCal).fill(NaN), lvDs = new Float64Array(nCal).fill(NaN);
  {
    const r69 = new Map<string, number>();
    h.bhP.dates.forEach((d, i) => { if (d <= CAL[nCal - 1]) r69.set(d, h.bhP.ret[i] / 100); });
    const rds = new Map(base.run.dates.map((d, i) => [d, base.run.ret[i] / 100]));
    let a = 1, b = 1;
    for (let k = cPE; k < nCal; k++) {
      if (k > cPE) { const x = r69.get(CAL[k]), y = rds.get(CAL[k]); if (x === undefined || y === undefined) throw new Error(`${CAL[k]} 수익률 없음`); a *= 1 + x; b *= 1 + y; }
      lv69[k] = a; lvDs[k] = b;
    }
  }
  // ---- VKOSPI 정리본(학습 구간 연도 파일만 읽는다) ----
  const vkMan = JSON.parse(await fs.readFile(path.join(VK_CACHE_DIR, "manifest.json"), "utf8")) as { idxName: string; files: { name: string; bytes: number; sha256: string; rows: number }[] };
  for (const f of vkMan.files) {
    const buf = await fs.readFile(path.join(VK_CACHE_DIR, f.name));
    if (buf.byteLength !== f.bytes || sha(buf) !== f.sha256) throw new Error(`VKOSPI 정리본 ${f.name} 매니페스트 불일치 — 중단하고 보고한다`);
  }
  console.log(`VKOSPI 정리본 매니페스트 대조 통과: 파일 ${vkMan.files.length}개 SHA-256 일치, 지수명 "${vkMan.idxName}"${vkMan.idxName === VK_IDX_NAME ? "" : " (사전등록과 다름)"}`);
  const vkRaw = new Map<string, number>();
  let dropped = 0, dupDates = 0;
  for (const f of vkMan.files) {
    if (Number(f.name.slice(0, 4)) > Number(VK_LEARN_END.slice(0, 4))) { dropped += f.rows; continue; }
    const buf = await fs.readFile(path.join(VK_CACHE_DIR, f.name));
    const rows = (await parquetReadObjects({ file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer })) as Record<string, unknown>[];
    for (const r of rows) {
      const d = String(r.trade_date);
      if (d > VK_LEARN_END) { dropped++; continue; }
      if (vkRaw.has(d)) dupDates++;
      vkRaw.set(d, Number(r.close));
    }
  }
  console.log(`VKOSPI 읽은 행 ${vkRaw.size}개(${[...vkRaw.keys()].sort()[0]}~${[...vkRaw.keys()].sort().pop()}), 학습 구간 밖 행 ${dropped}개는 읽지 않거나 버림, 중복 날짜 ${dupDates}`);
  const Cv = new Float64Array(nCal).fill(NaN);
  let notInCal = 0;
  for (const [d, v] of vkRaw) { const k = calIdx.get(d); if (k === undefined) notInCal++; else Cv[k] = v; }
  // ---- 선행 조건 ----
  const learnK: number[] = [];
  for (let k = 0; k < nCal; k++) if (CAL[k] >= VK_FROM && CAL[k] <= VK_LEARN_END) learnK.push(k);
  const missK = learnK.filter((k) => !Number.isFinite(Cv[k]));
  const missRatio = missK.length / learnK.length;
  const badClose = learnK.filter((k) => Number.isFinite(Cv[k]) && !(Cv[k] > 0)).length;
  const jumps: string[] = [];
  for (let q = 1; q < learnK.length; q++) { const a = Cv[learnK[q - 1]], b = Cv[learnK[q]]; if (Number.isFinite(a) && Number.isFinite(b) && (b / a - 1 <= -0.5 || b / a - 1 >= 1)) jumps.push(`${CAL[learnK[q]]} ${(a).toFixed(2)}→${(b).toFixed(2)}`); }
  console.log(`\n=== 선행 조건 점검 ===\n학습 구간 KOSPI 거래일 ${learnK.length}일 중 VKOSPI 값 없는 날 ${missK.length}일(${(missRatio * 100).toFixed(2)}%, 상한 ${(VK_MAX_MISSING_RATIO * 100).toFixed(0)}%)${missK.length ? `: ${missK.slice(0, 15).map((k) => CAL[k]).join(", ")}${missK.length > 15 ? " …" : ""}` : ""} | 달력에 없는 VKOSPI 날짜 ${notInCal}개 | 종가 0 이하 ${badClose}건 | 전일 대비 −50% 이하·+100% 이상 ${jumps.length}건${jumps.length ? `: ${jumps.join(", ")}` : ""} | 중복 날짜 ${dupDates}`);
  if (missRatio > VK_MAX_MISSING_RATIO || badClose > 0 || jumps.length > 0 || dupDates > 0) { console.log("선행 조건 미충족 — 스캔하지 않고 숫자만 보고한다"); return; }

  // ---- 신호 ----
  const obsK: number[] = [];
  for (const k of learnK) if (Number.isFinite(Cv[k])) obsK.push(k);
  const pctRank = (vals: number[], v: number): number => { let less = 0, eq = 0; for (const x of vals) { if (x < v) less++; else if (x === v) eq++; } return (less + 0.5 * eq) / vals.length; };
  const r5At = (k: number): number => { const a = Cv[k], b = k >= VK_CHG_DAYS ? Cv[k - VK_CHG_DAYS] : NaN; return Number.isFinite(a) && Number.isFinite(b) ? a / b - 1 : NaN; };
  const SIGV = ["V1", "V2", "V3", "V4"] as const;
  const SIG_LABEL: Record<(typeof SIGV)[number], string> = { V1: "V1 수준(확장 백분위)", V2: "V2 5일 변화율(확장 백분위)", V3: "V3 252일 백분위", V4: "V4 급등일(+15%↑)" };
  interface Pt { k: number; z: number[] } // z[0..2] = 백분위, z[3] = 급등 0/1
  const pts: Pt[] = [];
  const r5hist: number[] = [], lvHist: number[] = [];
  let nInvalid = 0;
  obsK.forEach((k, j) => {
    lvHist.push(Cv[k]);
    const r5 = r5At(k);
    if (Number.isFinite(r5)) r5hist.push(r5);
    if (j < VK_PCT_WINDOW - 1) return;
    const prevK = k - 1, c1 = prevK >= 0 ? Cv[prevK] : NaN;
    if (!Number.isFinite(r5) || !Number.isFinite(c1)) { nInvalid++; return; }
    const z1 = pctRank(lvHist, Cv[k]), z2 = pctRank(r5hist, r5), z3 = pctRank(lvHist.slice(j - VK_PCT_WINDOW + 1, j + 1), Cv[k]);
    pts.push({ k, z: [z1, z2, z3, Cv[k] / c1 - 1 >= VK_SPIKE_RET ? 1 : 0] });
  });
  console.log(`\n공통 표본일: 첫 표본일 ${CAL[pts[0].k]}(${VK_PCT_WINDOW}번째 VKOSPI 관측일) ~ ${CAL[pts[pts.length - 1].k]}, ${pts.length}일 | 신호 계산 불가로 제외 ${nInvalid}일 | 급등일(전일 대비 +${VK_SPIKE_RET * 100}%↑) ${pts.filter((p) => p.z[3] === 1).length}일`);

  // ---- 통계 ----
  const meanA = (a: number[]): number => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1);
  const olsNw = (x: number[], y: number[], L: number): { b: number; t: number } => {
    const n = x.length, mx = meanA(x), my = meanA(y);
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
    if (!(sxx > 0) || n < 4) return { b: NaN, t: NaN };
    const b = sxy / sxx, u = x.map((xi, i) => (xi - mx) * (y[i] - my - b * (xi - mx)));
    let om = u.reduce((s, v) => s + v * v, 0);
    for (let j = 1; j <= L && j < n; j++) { let s = 0; for (let t = j; t < n; t++) s += u[t] * u[t - j]; om += 2 * (1 - j / (L + 1)) * s; }
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
  const targets: { id: "069500" | "DS6"; lv: Float64Array }[] = [{ id: "069500", lv: lv69 }, { id: "DS6", lv: lvDs }];
  let nRows = 0;
  const cands: string[] = [];
  for (const tg of targets) {
    console.log(`\n=== 대상 ${tg.id} (진입 = 신호일 다음 거래일 종가, 청산 = 진입 + H거래일; 학습 구간 ${CAL[pts[0].k]}~${CAL[lastU]}, 편도 비용 ${(ONEWAY[tg.id] * 100).toFixed(3)}%) ===`);
    console.log("t(NW) = b의 Newey-West t, 시차 L = H. 비중복 t = H일 간격 표본(오프셋 H개)의 일반 OLS t 중앙값(정보 열). 연속 신호 b는 z 1.0 변화당 H일 수익(%p). 상위−하위 = z ≥ 2/3 평균 − z ≤ 1/3 평균(%), 급등 − 비급등(%) = D=1 평균 − D=0 평균. 순차이 = 방향(b 부호) × 차이 − 비용(%).");
    console.log("| 신호 | H | 표본일 수 | n_eff | b (%p) | t(NW) | 비중복 t | 상위/급등 표본 | 하위 표본 / 독립 사건 | 차이 % | 비용 % | 방향 반영 순차이 % | 후보 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const H of VK_HORIZONS) {
      const rows = pts.filter((p) => p.k + 1 + H <= lastU).map((p) => ({ p, y: tg.lv[p.k + 1 + H] / tg.lv[p.k + 1] - 1 })).filter((r) => Number.isFinite(r.y));
      for (let s = 0; s < 4; s++) {
        const spike = s === 3;
        const X = rows.map((r) => (spike ? r.p.z[3] : r.p.z[s] - 0.5)), Y = rows.map((r) => r.y);
        const { b, t } = olsNw(X, Y, vkNwLag(H));
        const nps: number[] = [];
        for (let o = 0; o < H; o++) { const xs: number[] = [], ys: number[] = []; for (let i = o; i < rows.length; i += H) { xs.push(X[i]); ys.push(Y[i]); } nps.push(olsPlainT(xs, ys)); }
        const tNo = med(nps);
        let sp = NaN, cost = NaN, nA = 0, nB = 0, extra = "";
        if (spike) {
          const yA = rows.filter((r) => r.p.z[3] === 1).map((r) => r.y), yB = rows.filter((r) => r.p.z[3] === 0).map((r) => r.y);
          nA = yA.length; nB = yB.length;
          sp = yA.length && yB.length ? (meanA(yA) - meanA(yB)) * 100 : NaN;
          cost = 2 * ONEWAY[tg.id] * 100;
          let lastE = -1e9, ev = 0;
          for (const r of rows) if (r.p.z[3] === 1 && r.p.k - lastE > H) { ev++; lastE = r.p.k; }
          extra = `${ev}${ev < VK_SPIKE_MIN_EVENTS_NOTE ? "(표본 부족)" : ""}`;
        } else {
          const top = rows.filter((r) => r.p.z[s] >= VK_HI), bot = rows.filter((r) => r.p.z[s] <= VK_LO);
          nA = top.length; nB = bot.length;
          sp = top.length && bot.length ? (meanA(top.map((r) => r.y)) - meanA(bot.map((r) => r.y))) * 100 : NaN;
          let prev = -1, ch = 0, tb = 0;
          for (const r of rows) { const st = r.p.z[s] >= VK_HI ? 1 : r.p.z[s] <= VK_LO ? 0 : -1; if (st < 0) continue; tb++; if (prev >= 0 && st !== prev) ch++; prev = st; }
          cost = tb ? (ch / tb) * 2 * ONEWAY[tg.id] * 100 : NaN;
          extra = String(nB);
        }
        const dir = Math.sign(b);
        const net = Number.isFinite(sp) && Number.isFinite(cost) ? dir * sp - cost : NaN;
        const isCand = Number.isFinite(t) && Math.abs(t) >= SCAN_CANDIDATE_ABS_T && Number.isFinite(net) && net > 0;
        nRows++;
        if (isCand) cands.push(`${tg.id} ${SIG_LABEL[SIGV[s]]} H=${H}`);
        console.log(`| ${SIG_LABEL[SIGV[s]]} | ${H} | ${rows.length} | ${(rows.length / H).toFixed(0)} | ${f3(b * 100)} | ${f2(t)} | ${f2(tNo)} | ${nA} | ${spike ? extra : extra} | ${f2(sp)} | ${f2(cost)} | ${f2(net)} | ${isCand ? "후보" : ""} |`);
      }
    }
  }
  console.log(`\n=== |t| ≥ ${SCAN_CANDIDATE_ABS_T} 이고 순차이 > 0인 행(후보) ===\n${cands.length ? cands.join("\n") : "없음"}`);
  console.log(`이번 스캔 행 ${nRows}개(사전등록 24) | 누적 스캔 행: 이전 321 + ${nRows} = ${321 + nRows}(대차 4-B 16행 별도, 미실행)`);

  // ---- 신호 간 상관(표본일 기준 스피어만) ----
  {
    const rk = (v: number[]): number[] => { const o = v.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x); const r = new Array<number>(v.length); for (let a = 0; a < o.length;) { let b = a; while (b + 1 < o.length && o[b + 1].x === o[a].x) b++; for (let c = a; c <= b; c++) r[o[c].i] = (a + b) / 2 + 1; a = b + 1; } return r; };
    const pr = (a: number[], b: number[]): number => { const ma = meanA(a), mb = meanA(b); let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; } return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN; };
    const cols = [0, 1, 2, 3].map((s) => rk(pts.map((p) => p.z[s])));
    console.log(`\n=== 신호 간 스피어만 상관(공통 표본일 ${pts.length}일) ===\n| | ${SIGV.map((s) => s).join(" | ")} |\n|---|---|---|---|---|`);
    for (let a = 0; a < 4; a++) console.log(`| ${SIGV[a]} | ${[0, 1, 2, 3].map((b) => f2(pr(cols[a], cols[b]))).join(" | ")} |`);
  }
  console.log(`\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)} (069500 기준선·조정 이벤트·KOSPI 달력 읽기용) | 쓴 행 0 | Storage 읽기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

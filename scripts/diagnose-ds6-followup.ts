/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 DS6 후속 진단(시험 아님, 시험 번호 272 유지). 사전 기록: docs/research/ds6-followup-diagnostic.md.
 * DS6(코어 40% = 월말 K200P 안 당일 시총 상위 2종목 시총 비율·교체 5거래일, 위성 60% = LV1 단독, 이동 비용 0.25%, 일별 목표 비중 리밸)을 정의 변경 없이 2011-01-04~데이터 끝(2026-10-26) 연속 구간으로 계산해
 * ① 069500 대비 성적·연도별 초과·롤링 3년, ② 하루 지연 약점 분해(코어/LV1/리밸/전부), ③ 삼성전자 분해를 본다. 판정에 쓰지 않는 사후 분해다. DS4(PE4·DART 입력)는 계산하지 않는다.
 * 입력은 고정 스냅샷·069500 보조 파일·월말 시장 목록·이전 연구 LV1 일별 순수익 캐시(대조용)뿐이다. 공시·DART 사용 없음.
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
import { P17_RUN_START, P17_END, P17_CAND, P17_DROP_TOP, P17_DS6_LATER } from "@/lib/ds6Pre2017Config";
import { CS_SWAP_CONFIRM_DAYS, CS_RANK_DEPTH, CS_MOVE_COST, CS_MOVE_COST_SENS, CS_ACCOUNTING_TOL_PP } from "@/lib/coreSatelliteConfig";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, SNAP_END, f2, avg, median, type S, type Win } from "./researchHarness";
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
  console.log(`연구 DS6 후속 진단(시험 아님, 번호 소진 없음, 누적 272 유지) ${REPRO ? "사전 점검(재현·자체 점검만)" : "실행"} 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const h0 = await loadHarness();
  const h = h0;
  const { CAL, nCal, byCode } = h;
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

  // ---- 0. 069500 기준선 ----
  console.log(`\n=== 0. 069500 기준선 (수익 집계 ${FULL.from}~; 원주가, 가격 수익만; CAGR % / MDD %) ===\n기존 = etf_daily_prices만(${h.bhPDb.dates[h.bhPDb.dates.length - 1]}까지), 새 = 보조 파일(${h.bhP.dates[h.bhP.dates.length - 1]}까지) — 게이트 A~H는 새 기준선으로 판정\n| 구간 | 기존 | 새 |\n|---|---|---|`);
  for (const [wn, w] of WALL) {
    const a = h.st(h.bhPDb, w), b = h.st(h.bhP, w);
    console.log(`| ${wn} | ${f2(a.cagr)} / ${f2(a.mdd)} | ${f2(b.cagr)} / ${f2(b.mdd)} |`);
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
  const dateIdx = new Map(dates0.map((d, i) => [d, i]));
  const bhRet = new Map(h.bhP.dates.map((d, i) => [d, h.bhP.ret[i]]));
  const bRetAxis = dates0.map((d) => { const r = bhRet.get(d); if (r === undefined) throw new Error(`069500 일수익률 없음 ${d}`); return r; });

  // ---- 기준 계열 ----
  const coreCache = new Map<string, CoreRun>(), coreSlCache = new Map<string, Sl>();
  const keyC = (N: number, lag: number, repl?: Set<string>): string => `${N}|${lag}|${repl ? [...repl].sort().join(",") : ""}`;
  const getCore = (N: number, lag: number, repl?: Set<string>): CoreRun => { const k = keyC(N, lag, repl); let r = coreCache.get(k); if (!r) { r = simCore(N, { lag, replace: repl }); coreCache.set(k, r); } return r; };
  const getCoreSl = (N: number, lag: number, repl?: Set<string>): Sl => { const k = keyC(N, lag, repl); let s = coreSlCache.get(k); if (!s) { s = slice(getCore(N, lag, repl)); coreSlCache.set(k, s); } return s; };
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
  const stS = (x: Sl, w: Win): ReturnType<typeof h.st> => h.st({ dates: x.dates, ret: x.ret }, w);
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
  const sg = (x: number): string => `${x >= 0 ? "+" : ""}${f2(x)}`;
  const base = build({ coreLag: 1, satLag: 1, delay: 0 });
  const bhAx = { dates: dates0, ret: bRetAxis };
  const baseRun = { dates: dates0, ret: base.run.ret };

  // 일관성 확인: 연속 계산의 앞부분(2011-01-04~2016-12-29)이 2017 이전 구간 시험(시도 272)에서 기록된 값과 같아야 한다(인과 시뮬레이션이라 끝을 잘라도 앞부분은 같다).
  {
    const sA = h.st(base.run, WA);
    const ok = f2(sA.cagr) === "4.10" && f2(sA.mdd) === "24.51";
    console.log(`\n일관성: 연속 계산의 구간 A(2011-01-04~2016-12-29) DS6 ${f2(sA.cagr)} / ${f2(sA.mdd)} (시도 272 기록 4.10 / 24.51) → ${ok ? "일치" : "불일치"}`);
    if (!ok) throw new Error("시도 272 기록과 다르다 — 중단하고 보고한다");
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 1. 15년 연속 성적
  // ---------------------------------------------------------------------------------------------------------------
  console.log(`\n=== 1-1. DS6 연속 성적 vs 069500 원주가 (워밍업 이후 시작 ${FULL.from}, 끝 ${h.dataEnd}; CAGR % / MDD %) ===\n| 구간 | DS6 | 069500 | CAGR 차 %p | MDD 차 %p(음수 = DS6이 작음) |\n|---|---|---|---|---|`);
  for (const [wn, w] of WALL) {
    const a = h.st(base.run, w), b = h.st(h.bhP, w);
    console.log(`| ${wn} | ${f2(a.cagr)} / ${f2(a.mdd)} | ${f2(b.cagr)} / ${f2(b.mdd)} | ${sg(a.cagr - b.cagr)} | ${sg(a.mdd - b.mdd)} |`);
  }
  console.log(`참고(분리 계산·기록값): 2017-04-04부터 새로 시작한 DS6 ${P17_DS6_LATER.전체.join(" / ")}(연구 DS5·DS6) — 연속 계산의 구간 B와 코어 구성 시작점이 달라 같지 않다.`);

  {
    const years: number[] = [];
    for (let y = Number(FULL.from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) years.push(y);
    console.log(`\n=== 1-2. 연도별 DS6 − 069500 초과수익 (일수익률 복리 %, ${years[0]}년은 ${FULL.from}부터, ${years[years.length - 1]}년은 ${h.dataEnd}까지의 부분 연도) ===\n| 연도 | DS6 | 069500 | 초과 %p | 승·패 |\n|---|---|---|---|---|`);
    const ex: { y: number; e: number }[] = [];
    for (const y of years) {
      const a1 = h.yearRet(baseRun, y), b1 = h.yearRet(bhAx, y), e = a1 - b1;
      ex.push({ y, e });
      console.log(`| ${y}${y === years[0] || y === years[years.length - 1] ? " (부분)" : ""} | ${f2(a1)} | ${f2(b1)} | ${sg(e)} | ${e > 0 ? "승" : e < 0 ? "패" : "무"} |`);
    }
    const cnt = (list: { y: number; e: number }[]): string => `승 ${list.filter((x) => x.e > 0).length} / 패 ${list.filter((x) => x.e < 0).length} (평균 초과 ${sg(avg(list.map((x) => x.e)))}%p, 중앙값 ${sg(median(list.map((x) => x.e)))}%p)`;
    console.log(`승·패 연수: 전체 ${ex.length}개 연도(부분 연도 포함) ${cnt(ex)} | 온전한 연도(${years[1]}~${years[years.length - 2]}) ${cnt(ex.slice(1, -1))}`);
  }

  // 롤링 3년 창(월말에서 월말로 36개월씩 한 달 단위 이동). 창 안에서 DS6·069500 각각의 CAGR(36개월 수익의 연환산)과 창 안 MDD를 비교한다.
  {
    const ROLL_MONTHS = 36;
    const meSet = new Set(h.monthEnds), anchors: number[] = [];
    for (let i = 0; i < nDays; i++) if (meSet.has(dates0[i])) anchors.push(i);
    const cum = (r: number[]): Float64Array => { const v = new Float64Array(nDays + 1); v[0] = 1; for (let i = 0; i < nDays; i++) v[i + 1] = v[i] * (1 + r[i] / 100); return v; };
    const va = cum(base.run.ret), vb = cum(bRetAxis);
    const rows: { start: string; end: string; ca: number; cb: number; ma: number; mb: number }[] = [];
    const mddIn = (v: Float64Array, i0: number, i1: number): number => { let pk = v[i0 + 1], m = 0; for (let t = i0 + 1; t <= i1; t++) { const x = v[t + 1]; if (x > pk) pk = x; m = Math.max(m, 1 - x / pk); } return m * 100; };
    for (let k = 0; k + ROLL_MONTHS < anchors.length; k++) {
      const i0 = anchors[k], i1 = anchors[k + ROLL_MONTHS];
      const yrs = (Date.parse(dates0[i1]) - Date.parse(dates0[i0])) / 86_400_000 / 365.25;
      rows.push({ start: dates0[i0], end: dates0[i1], ca: (Math.pow(va[i1 + 1] / va[i0 + 1], 1 / yrs) - 1) * 100, cb: (Math.pow(vb[i1 + 1] / vb[i0 + 1], 1 / yrs) - 1) * 100, ma: mddIn(va, i0, i1), mb: mddIn(vb, i0, i1) });
    }
    const qn = (v: number[], p: number): number => { const a = [...v].sort((x, y) => x - y); return a[Math.min(Math.floor(a.length * p), a.length - 1)]; };
    const share = (f: (r: (typeof rows)[number]) => boolean, list = rows): string => `${list.filter(f).length}/${list.length} (${f2((list.filter(f).length / Math.max(list.length, 1)) * 100)}%)`;
    const ex = rows.map((r) => r.ca - r.cb);
    console.log(`\n=== 1-3. 롤링 3년 창(월말 앵커 ${anchors.length}개, 36개월 창을 한 달씩 이동, 첫 창 시작 ${rows[0].start} 끝 ${rows[0].end}, 마지막 창 시작 ${rows[rows.length - 1].start} 끝 ${rows[rows.length - 1].end}; 창 ${rows.length}개, 서로 겹침) ===`);
    console.log(`DS6 CAGR > 069500 CAGR인 창: ${share((r) => r.ca > r.cb)} | 초과수익(CAGR 차, %p) 최소 ${sg(Math.min(...ex))} / 25% ${sg(qn(ex, 0.25))} / 중앙값 ${sg(median(ex))} / 75% ${sg(qn(ex, 0.75))} / 최대 ${sg(Math.max(...ex))} / 평균 ${sg(avg(ex))}`);
    console.log(`DS6 창 안 MDD < 069500 창 안 MDD인 창: ${share((r) => r.ma < r.mb)} | MDD 차(DS6 − 069500, %p) 최소 ${sg(Math.min(...rows.map((r) => r.ma - r.mb)))} / 중앙값 ${sg(median(rows.map((r) => r.ma - r.mb)))} / 최대 ${sg(Math.max(...rows.map((r) => r.ma - r.mb)))}`);
    console.log(`둘 다(CAGR 높고 MDD 작음)인 창: ${share((r) => r.ca > r.cb && r.ma < r.mb)} | 둘 다 아닌 창: ${share((r) => !(r.ca > r.cb) && !(r.ma < r.mb))}`);
    console.log(`DS6 롤링 3년 CAGR 최소 ${f2(Math.min(...rows.map((r) => r.ca)))} / 중앙값 ${f2(median(rows.map((r) => r.ca)))} / 최대 ${f2(Math.max(...rows.map((r) => r.ca)))} | 069500 최소 ${f2(Math.min(...rows.map((r) => r.cb)))} / 중앙값 ${f2(median(rows.map((r) => r.cb)))} / 최대 ${f2(Math.max(...rows.map((r) => r.cb)))}`);
    console.log(`\n창 시작 연도별(창 시작 월말의 연도):\n| 시작 연도 | 창 수 | DS6 CAGR 높음 | MDD 작음 | 초과 중앙값 %p |\n|---|---|---|---|---|`);
    const ys = [...new Set(rows.map((r) => r.start.slice(0, 4)))].sort();
    for (const y of ys) {
      const l = rows.filter((r) => r.start.startsWith(y));
      console.log(`| ${y} | ${l.length} | ${share((r) => r.ca > r.cb, l)} | ${share((r) => r.ma < r.mb, l)} | ${sg(median(l.map((r) => r.ca - r.cb)))} |`);
    }
    const w1 = rows.filter((r) => r.end <= "2016-12-31"), w2 = rows.filter((r) => r.start >= "2016-12-31");
    console.log(`\n창 전체가 구간 A 안(끝 ≤ 2016-12-31) ${w1.length}개: CAGR 높음 ${share((r) => r.ca > r.cb, w1)}, MDD 작음 ${share((r) => r.ma < r.mb, w1)}, 초과 중앙값 ${sg(median(w1.map((r) => r.ca - r.cb)))}%p | 창 시작이 2016-12-31 이후 ${w2.length}개: CAGR 높음 ${share((r) => r.ca > r.cb, w2)}, MDD 작음 ${share((r) => r.ma < r.mb, w2)}, 초과 중앙값 ${sg(median(w2.map((r) => r.ca - r.cb)))}%p`);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 2. 하루 지연 약점 분해
  // ---------------------------------------------------------------------------------------------------------------
  const VARS: [string, Var][] = [
    ["기준(지연 없음)", { coreLag: 1, satLag: 1, delay: 0 }],
    ["코어만 하루 지연", { coreLag: 2, satLag: 1, delay: 0 }],
    ["LV1만 하루 지연", { coreLag: 1, satLag: 2, delay: 0 }],
    ["40:60 리밸만 하루 지연", { coreLag: 1, satLag: 1, delay: 1 }],
    ["코어+LV1 하루 지연 (게이트 C 정의)", { coreLag: 2, satLag: 2, delay: 0 }],
    ["전부(코어+LV1+리밸) 하루 지연", { coreLag: 2, satLag: 2, delay: 1 }],
  ];
  console.log(`\n=== 2-1. 하루 지연 분해 (CAGR % / MDD %, 변화 %p; 적용 순서: 코어만 → LV1만 → 40:60 리밸만 → 코어+LV1(게이트 C) → 전부) ===`);
  for (const [wn, w] of WALL) {
    console.log(`\n[${wn}]\n| 지연 적용 대상 | CAGR | MDD | CAGR 변화 | MDD 변화 |\n|---|---|---|---|---|`);
    const b0 = h.st(base.run, w);
    const rs: ReturnType<typeof h.st>[] = [];
    for (const [nm, v] of VARS) {
      const s = h.st(build(v).run, w);
      rs.push(s);
      console.log(`| ${nm} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${nm.startsWith("기준") ? "-" : sg(s.cagr - b0.cagr)} | ${nm.startsWith("기준") ? "-" : sg(s.mdd - b0.mdd)} |`);
    }
    const indC = rs[1].cagr + rs[2].cagr + rs[3].cagr - 3 * b0.cagr, indM = rs[1].mdd + rs[2].mdd + rs[3].mdd - 3 * b0.mdd;
    console.log(`개별(코어·LV1·리밸) 변화 합 CAGR ${sg(indC)} / MDD ${sg(indM)} vs 전부 CAGR ${sg(rs[5].cagr - b0.cagr)} / MDD ${sg(rs[5].mdd - b0.mdd)} → 어긋남(상호작용) CAGR ${sg(rs[5].cagr - b0.cagr - indC)} / MDD ${sg(rs[5].mdd - b0.mdd - indM)}`);
  }
  console.log(`\n참고: 코어 단독·LV1 단독 계열의 하루 지연 변화 (CAGR % / MDD %)\n| 구간 | 코어 단독 | 코어 단독(하루 지연) | LV1 단독 | LV1 단독(하루 지연) |\n|---|---|---|---|---|`);
  for (const [wn, w] of WALL) {
    const c1 = stS(getCoreSl(CN, 1), w), c2 = stS(getCoreSl(CN, 2), w), l1 = stS(satSl(1), w), l2 = stS(satSl(2), w);
    console.log(`| ${wn} | ${f2(c1.cagr)} / ${f2(c1.mdd)} | ${f2(c2.cagr)} / ${f2(c2.mdd)} | ${f2(l1.cagr)} / ${f2(l1.mdd)} | ${f2(l2.cagr)} / ${f2(l2.mdd)} |`);
  }

  // 2-2. 코어 교체일 민감도: 교체 체결을 하루 늦추면 교체 직후 하루 동안 팔려던 종목을 더 들고 사려던 종목을 덜 갖는다(1차 근사: 교체 후 사려던 종목 비중 × (판 종목 − 산 종목의 다음 날 수익률)).
  {
    const ev1 = getCore(CN, 1).events, c1 = getCoreSl(CN, 1), c2 = getCoreSl(CN, 2);
    const first = ev1[0];
    const swaps = ev1.filter((e) => e.sells.length > 0);
    interface SwapEff { date: string; text: string; effect: number }
    const effs: SwapEff[] = [];
    for (const e of swaps) {
      const cn = e.c + 1;
      if (cn >= nCal) continue;
      const rOf = (code: string): number => { const s = byCode.get(code) as S, i1 = s.idx.get(CAL[cn]), i0 = s.idx.get(CAL[e.c]); return i0 === undefined || i1 === undefined ? Number.NaN : (s.close[i1] / s.close[i0] - 1) * 100; };
      const ro = e.sells.map(rOf), rb = e.buys.map(rOf), wb = e.buys.reduce((a, code) => a + e.w[e.set.indexOf(code)], 0);
      if (![...ro, ...rb].every(Number.isFinite)) continue;
      effs.push({ date: CAL[e.c], text: `${e.sells.map(label).join("+")} → ${e.buys.map(label).join("+")}`, effect: wb * (avg(ro) - avg(rb)) });
    }
    console.log(`\n=== 2-2. 코어 교체(5거래일 조건 충족 후 교체) 하루 지연 민감도 — 1차 근사, 코어 계좌 기준 %p (음수 = 지연이 손해) ===`);
    console.log(`교체 이벤트(처음 편입 제외) ${swaps.length}건, 처음 편입 체결 ${CAL[first.c]} | 근사에 쓴 교체 ${effs.length}건 (다음 날 가격이 없는 교체는 제외)`);
    console.log(`| 구간 | 교체 건수 | 1차 근사 합 %p(코어 계좌) | 건당 평균 | 건당 중앙값 | 건당 최소 | 건당 최대 | 지연이 손해인 건 | DS6 계좌 환산 합 %p(×${COREW}) | 실제 코어 하루 지연 일수익률 합 차 %p | 실제 DS6 코어만 지연 CAGR 변화 %p |\n|---|---|---|---|---|---|---|---|---|---|---|`);
    const b0r = base.run, c1r = build({ coreLag: 2, satLag: 1, delay: 0 }).run;
    for (const [wn, w] of WALL) {
      const inW = effs.filter((x) => x.date >= w.from && x.date <= w.to);
      const idx: number[] = [];
      for (let i = 0; i < nDays; i++) if (dates0[i] >= w.from && dates0[i] <= w.to) idx.push(i);
      const actual = idx.reduce((a, i) => a + c2.ret[i] - c1.ret[i], 0);
      const v = inW.map((x) => x.effect), tot = v.reduce((a, x) => a + x, 0);
      const dC = h.st(c1r, w).cagr - h.st(b0r, w).cagr;
      console.log(`| ${wn} | ${inW.length} | ${sg(tot)} | ${v.length ? sg(avg(v)) : "-"} | ${v.length ? sg(median(v)) : "-"} | ${v.length ? sg(Math.min(...v)) : "-"} | ${v.length ? sg(Math.max(...v)) : "-"} | ${v.filter((x) => x < 0).length}/${v.length} | ${sg(tot * COREW)} | ${sg(actual)} | ${sg(dC)} |`);
    }
    const top = [...effs].sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect)).slice(0, 8);
    console.log(`영향이 큰 교체 상위 8건(절대값): ${top.map((x) => `${x.date} ${x.text} ${sg(x.effect)}`).join(" | ")}`);
    console.log(`한계: 교체 하루 지연의 직접 효과만 본 1차 근사다(이후 보유 비중 차이·비용 차이 등 2차 효과 제외). "실제 코어 하루 지연 일수익률 합 차"는 교체 말고 처음 편입 하루 지연·2차 효과까지 포함한다.`);
  }

  // 2-3. 일별 목표 비중 리밸의 비용과 지연 영향(따로)
  {
    console.log(`\n=== 2-3. 일별 목표 비중 리밸(이동 금액의 ${CS_MOVE_COST * 100}%): 비용과 지연 영향 (따로) ===\n| 구간 | 이동이 있는 날 / 일수 | 이동 금액 합 %(계좌 대비) · 연 | 이동 비용 합 %p · 연 | 비용 0일 때 CAGR 변화 %p(= 비용의 CAGR 영향) | 비용 0.5%일 때 CAGR 변화 %p | 리밸만 하루 지연 CAGR 변화 %p | 리밸만 하루 지연 MDD 변화 %p |\n|---|---|---|---|---|---|---|---|`);
    const z = build({ coreLag: 1, satLag: 1, delay: 0, rate: 0 }), hi = build({ coreLag: 1, satLag: 1, delay: 0, rate: CS_MOVE_COST_SENS }), dl = build({ coreLag: 1, satLag: 1, delay: 1 });
    for (const [wn, w] of WALL) {
      const idx: number[] = [];
      for (let i = 0; i < nDays; i++) if (dates0[i] >= w.from && dates0[i] <= w.to) idx.push(i);
      const yrs = (Date.parse(idx.length ? dates0[idx[idx.length - 1]] : w.from) - Date.parse(w.from)) / 86_400_000 / 365.25;
      const mv = idx.reduce((a, i) => a + base.moved[i], 0) * 100, cs = idx.reduce((a, i) => a + base.cost[i], 0) * 100, nMv = idx.filter((i) => base.moved[i] > 0).length;
      const b0 = h.st(base.run, w), s0 = h.st(z.run, w), s1 = h.st(hi.run, w), sd = h.st(dl.run, w);
      console.log(`| ${wn} | ${nMv}/${idx.length} | ${f2(mv)} · 연 ${f2(mv / yrs)} | ${f2(cs)} · 연 ${f2(cs / yrs)} | ${sg(s0.cagr - b0.cagr)} | ${sg(s1.cagr - b0.cagr)} | ${sg(sd.cagr - b0.cagr)} | ${sg(sd.mdd - b0.mdd)} |`);
    }
    console.log(`해석 한계: 비용 0 변형은 비용만 바꾼 것이고, 리밸 지연 변형은 비용 규칙은 같고 체결일만 하루 늦춘 것이다. 둘은 서로 다른 변형이므로 합하면 안 된다.`);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 3. 삼성전자 분해
  // ---------------------------------------------------------------------------------------------------------------
  {
    const coreSl = getCoreSl(CN, 1), holds = coreHolds(CN);
    const sam = byCode.get(SAMSUNG) as S;
    const dayRet = (code: string, i: number): number => { const s = byCode.get(code) as S, a = s.idx.get(CAL[cutC + i]), b = s.idx.get(CAL[cutC + i - 1]); return a === undefined || b === undefined ? 0 : (s.close[a] / s.close[b] - 1) * 100; };
    const cSam = new Array<number>(nDays).fill(0), cOth = new Array<number>(nDays).fill(0), cRes = new Array<number>(nDays).fill(0), wSamCore = new Array<number>(nDays).fill(0);
    for (let i = 1; i < nDays; i++) {
      let sS = 0, sO = 0;
      for (const [code, w] of holds[i - 1]) { const c = w * dayRet(code, i); if (code === SAMSUNG) sS += c; else sO += c; }
      cSam[i] = sS; cOth[i] = sO; cRes[i] = coreSl.ret[i] - sS - sO;
      wSamCore[i] = (holds[i - 1].find(([code]) => code === SAMSUNG)?.[1] ?? 0) * 100;
    }
    cRes[0] = coreSl.ret[0];
    const wCorePrev = (i: number): number => (i === 0 ? COREW : base.wCore[i - 1]);
    console.log(`\n=== 3-1. 코어 안 삼성전자 기여 vs 그 외 종목 기여 (전일 종가 비중 × 당일 수익률의 산술 합 %p; 잔여 = 체결 비용 등; 코어 계좌 기준과 DS6 계좌 환산) ===`);
    console.log(`| 구간 | 코어 산술 합 | 삼성전자 | 그 외 코어 종목 | 잔여 | 삼성전자 평균 코어 비중 % | 삼성전자 보유 일수 비중 % | DS6 계좌 환산: 삼성전자 | 그 외 코어 | LV1 | 잔여(이동·비용·교차) | DS6 산술 합 | 069500 산술 합 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
    for (const [wn, w] of WALL) {
      const idx: number[] = [];
      for (let i = 0; i < nDays; i++) if (dates0[i] >= w.from && dates0[i] <= w.to) idx.push(i);
      const S = (a: number[]): number => idx.reduce((t, i) => t + a[i], 0);
      const coreTot = S(coreSl.ret), aS = idx.reduce((t, i) => t + wCorePrev(i) * cSam[i], 0), aO = idx.reduce((t, i) => t + wCorePrev(i) * cOth[i], 0), aL = idx.reduce((t, i) => t + (1 - wCorePrev(i)) * satSl(1).ret[i], 0);
      const dsTot = S(base.run.ret);
      console.log(`| ${wn} | ${sg(coreTot)} | ${sg(S(cSam))} | ${sg(S(cOth))} | ${sg(S(cRes))} | ${f2(avg(idx.map((i) => wSamCore[i])))} | ${f2((idx.filter((i) => wSamCore[i] > 0).length / Math.max(idx.length, 1)) * 100)} | ${sg(aS)} | ${sg(aO)} | ${sg(aL)} | ${sg(dsTot - aS - aO - aL)} | ${sg(dsTot)} | ${sg(S(bRetAxis))} |`);
    }
    console.log(`\n연도별 코어 계좌 기준 산술 합 %p:\n| 연도 | 코어 합 | 삼성전자 | 그 외 코어 종목 | 잔여 | 삼성전자 평균 코어 비중 % |\n|---|---|---|---|---|---|`);
    for (let y = Number(FULL.from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) {
      const idx: number[] = [];
      for (let i = 0; i < nDays; i++) if (dates0[i].startsWith(`${y}-`)) idx.push(i);
      const S = (a: number[]): number => idx.reduce((t, i) => t + a[i], 0);
      console.log(`| ${y} | ${sg(S(coreSl.ret))} | ${sg(S(cSam))} | ${sg(S(cOth))} | ${sg(S(cRes))} | ${f2(avg(idx.map((i) => wSamCore[i])))} |`);
    }
    // 삼성전자 단독 보유와 삼성전자 제외 코어의 성적
    const samSer = { dates: dates0, ret: dates0.map((_, i) => dayRet(SAMSUNG, i)) };
    const xb = build({ coreLag: 1, satLag: 1, delay: 0, dropTop: true }), xc = coreOf(1, true);
    console.log(`\n=== 3-2. 성적 비교 (CAGR % / MDD %): 069500 · 삼성전자 단독 보유(비용 없음, 참고) · 코어(N=2) · 삼성전자 제외 코어(시총 1위 제외 N=2, 진단) · DS6 · DS6-X(코어를 삼성전자 제외판으로, 새 후보 아님) ===\n| 구간 | 069500 | 삼성전자 단독 | 코어 | 삼성전자 제외 코어 | DS6 | DS6-X |\n|---|---|---|---|---|---|---|`);
    for (const [wn, w] of WALL) {
      const cell = (r: { dates: string[]; ret: number[] }): string => { const x = h.st(r, w); return `${f2(x.cagr)} / ${f2(x.mdd)}`; };
      console.log(`| ${wn} | ${cell(h.bhP)} | ${cell(samSer)} | ${cell(coreSl)} | ${cell({ dates: xc.sl.dates, ret: xc.sl.ret })} | ${cell(base.run)} | ${cell(xb.run)} |`);
    }
    console.log(`삼성전자 제외 코어(시총 1위 제외) 구성 이력(이벤트 ${xc.run.events.length}회, 종목 교체 ${xc.run.events.filter((e) => e.sells.length).length}회) — 시총 1위가 삼성전자가 아닌 기간에는 그 종목이 제외된다.`);

    // 시총 1위가 삼성전자가 아니었던 기간
    interface Rg { code: string; from: string; to: string; n: number }
    const ranges: Rg[] = [];
    let nSam = 0, nTot = 0;
    const byWin = new Map<string, { sam: number; tot: number }>(WALL.map(([wn]) => [wn, { sam: 0, tot: 0 }]));
    for (let i = 0; i < nDays; i++) {
      const c = cutC + i, top = megaAt(c, CS_RANK_DEPTH).list[0];
      nTot++;
      const isSam = top?.code === SAMSUNG;
      if (isSam) nSam++;
      for (const [wn, w] of WALL) if (dates0[i] >= w.from && dates0[i] <= w.to) { const e = byWin.get(wn) as { sam: number; tot: number }; e.tot++; if (isSam) e.sam++; }
      if (!isSam) {
        const code = top?.code ?? "없음", last = ranges[ranges.length - 1];
        if (last && last.code === code && last.n > 0 && cutC + i - 1 === (h.calIdx.get(last.to) as number)) { last.to = dates0[i]; last.n++; } else ranges.push({ code, from: dates0[i], to: dates0[i], n: 1 });
      }
    }
    console.log(`\n=== 3-3. 삼성전자(005930)가 시총 1위(코스피, 제외 규칙 적용, 당일 시총)였던 날 비중 ===\n전체 ${nSam}/${nTot}일(${f2((nSam / nTot) * 100)}%) | ${WALL.map(([wn]) => { const e = byWin.get(wn) as { sam: number; tot: number }; return `${wn} ${e.sam}/${e.tot}일(${f2((e.sam / Math.max(e.tot, 1)) * 100)}%)`; }).join(" | ")}`);
    if (ranges.length) {
      console.log(`삼성전자가 시총 1위가 아니었던 기간 ${ranges.length}개 (연속 구간별 1위 종목):\n| 시작 | 끝 | 일수 | 1위 종목 | 그 기간 삼성전자 순위 |\n|---|---|---|---|---|`);
      for (const r of ranges) {
        const c = h.calIdx.get(r.from) as number;
        console.log(`| ${r.from} | ${r.to} | ${r.n} | ${label(r.code)} | ${megaAt(c, CS_RANK_DEPTH).rank.get(SAMSUNG) ?? "순위 밖"} (시작일) |`);
      }
    } else console.log("삼성전자가 시총 1위가 아니었던 날은 없다.");
    void sam;
  }

  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ") || "없음"} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험 번호 소진 없음(272 유지) | 판정에 쓰지 않는 사후 분해`);

}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

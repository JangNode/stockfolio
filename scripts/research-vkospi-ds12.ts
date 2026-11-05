/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 DS12(시도 286). 사전 등록: docs/research/vkospi-confirm-prereg.md (커밋 8aa793a594f936f14c72af6583583bdab4b8e9c6, 1단계 값을 열기 전).
 * 기본은 DS6(코어 40% = 월말 K200P 안 당일 시총 상위 2종목 시총 비율·교체 순위 밖 5거래일 연속일 때만 / 위성 60% = LV1 단독 / 일별 목표 비중 리밸 이동 비용 0.25%).
 * 바뀌는 것은 LV1 목표 배율 m뿐: 판단일 c의 전일(CAL[c−1]) VKOSPI 종가가 25 이상이면 m = 1(줄이지 않음), 그 외는 DS6와 같은 m.
 * ALLOC_MODE=repro: 재현·구조 자체 점검만(DS12 성과 미계산, DS6 일관성만 계산) / ds12: 시험 1회. 공시·DART 사용 없음. VKOSPI 정리본은 Actions 캐시(.vkospi-inputs, Storage 읽기 0).
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
import { DS89_RUN_START, DS89_WINDOWS, DS89_DS6_REF, DS89_CORE_W, DS89_SAMSUNG } from "@/lib/ds89Config";
import { DS12_TRIAL, DS12_THR, DS12_NB_THR, DS12_PERSIST_DAYS, DS12_F_DENOMINATOR } from "@/lib/vkospiConfirmConfig";
import { DS1011_REC } from "@/lib/ds1011Config";
import { VK_CACHE_DIR, VK_IDX_NAME } from "@/lib/vkospiScanConfig";
import { parquetReadObjects } from "hyparquet";
import { CS_SWAP_CONFIRM_DAYS, CS_RANK_DEPTH, CS_MOVE_COST, CS_CORE_W_NEIGHBOR } from "@/lib/coreSatelliteConfig";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, mulberry32, SNAP_END, f2, avg, median, type S, type Win } from "./researchHarness";
import { evaluate, summaryReport, type CandSpec, type Verdict, type Windows } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
const sha = (b: Uint8Array | Buffer | string): string => createHash("sha256").update(b).digest("hex");
/** 공통 평가 시작 이후로 자른 일별 계열(구성요소 하나의 계좌 기준). */
interface Sl { dates: string[]; ret: number[]; costFrac: number[]; nPos: number[]; inv: number[]; turn: number[]; wMax: number[] }
interface Vk { thr: number; persist: number }
type MTrace = Map<number, { raw: number; ovr: boolean }>;
type LvOpts = { lag: number; vk?: Vk; vkArr?: Float64Array; trace?: MTrace; replace?: Set<string> };
const vkKey = (vk?: Vk): string => (vk ? `${vk.thr}_${vk.persist}` : "-");

async function main(): Promise<void> {
  const MODE = (process.env.ALLOC_MODE ?? "").trim().toLowerCase();
  if (MODE !== "repro" && MODE !== "ds12") throw new Error("ALLOC_MODE=repro|ds12 필요");
  const REPRO = MODE === "repro";
  console.log(`연구 DS12(시도 ${DS12_TRIAL}) ${REPRO ? "사전 점검(재현·구조 자체 점검만, DS12 성과 미계산)" : "시험 1회"} 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, nameOf } = await loadK200P(h);

  // ---- VKOSPI 일별 종가(정리본 Actions 캐시 .vkospi-inputs): 전 연도 파일 SHA 대조 후 읽는다(DS12는 전 구간 사용, 사전등록 4절 2번) ----
  const vkMan = JSON.parse(await fs.readFile(path.join(VK_CACHE_DIR, "manifest.json"), "utf8")) as { idxName: string; files: { name: string; bytes: number; sha256: string; rows: number }[] };
  const VKA = new Float64Array(nCal).fill(Number.NaN);
  const vkRaw = new Map<string, number>();
  {
    for (const f of vkMan.files) {
      const buf = await fs.readFile(path.join(VK_CACHE_DIR, f.name));
      if (buf.byteLength !== f.bytes || sha(buf) !== f.sha256) throw new Error(`VKOSPI 정리본 ${f.name} 매니페스트 불일치 — 중단하고 보고한다`);
      const rows = (await parquetReadObjects({ file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer })) as Record<string, unknown>[];
      for (const r of rows) { const d = String(r.trade_date), k = h.calIdx.get(d); vkRaw.set(d, Number(r.close)); if (k !== undefined) VKA[k] = Number(r.close); }
    }
    console.log(`VKOSPI 정리본 매니페스트 대조 통과: 파일 ${vkMan.files.length}개 SHA-256 일치, 지수명 "${vkMan.idxName}"${vkMan.idxName === VK_IDX_NAME ? "" : " (사전등록과 다름)"}, 읽은 행 ${vkRaw.size}개 ${[...vkRaw.keys()].sort()[0]}~${[...vkRaw.keys()].sort().pop()}, 달력에 값이 있는 날 ${VKA.filter((x) => Number.isFinite(x)).length}일`);
  }
  /** 판단일 c의 직전 persist거래일(CAL[c−persist..c−1])의 VKOSPI 종가가 모두 thr 이상이면 true(값이 없으면 false = DS6와 같은 m). */
  const vkHigh = (arr: Float64Array, c: number, vk: Vk): boolean => { for (let q = 1; q <= vk.persist; q++) { const k = c - q; if (k < 0 || !(arr[k] >= vk.thr)) return false; } return true; };

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
  let randLV1!: (rng: () => number, ob: Map<number, number>, vk?: Vk) => SimRun;
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
    /** DS12: vk가 있으면 판단일 c의 전일 VKOSPI가 thr 이상(persist거래일 연속)인 날 m = 1, 아니면 DS6와 같은 m(rawMult). 판단일마다 한 번 불리므로 trace에 (raw m, 적용 여부)를 남긴다(진단용). */
    const mkVt = (vk: Vk | undefined, arr: Float64Array, trace?: MTrace): SimVt => {
      if (!vk) return { sizeMult: rawMult, band: LV_BAND };
      return { sizeMult: (c, stocks) => { const raw = rawMult(c, stocks), ovr = vkHigh(arr, c, vk); trace?.set(c, { raw, ovr }); return ovr ? 1 : raw; }, band: LV_BAND };
    };
    const cfgOf = (vk?: Vk, arr?: Float64Array, trace?: MTrace) => ({ slip: L_SLIPPAGE, maxPos: LE2.slots, capFrac: 1 / LE2.slots, cooldown: LS_COOLDOWN_DAYS, vt: mkVt(vk, arr ?? VKA, trace) });
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
    runLV1 = (o) => simSlots(env(cS), cfgOf(o.vk, o.vkArr, o.trace), hooks, { lag: o.lag, replace: o.replace, detail: true });
    randLV1 = (rng, ob, vk) => simSlots(env(cS), cfgOf(vk), {
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
  const lv1Cache = new Map<string, { run: SimRun; sl: Sl; trace: MTrace }>();
  /** LV1 일별 계열. vk = DS12 VKOSPI 규칙(없으면 DS6의 LV1 그대로). */
  const lv1Of = (lag: number, vk?: Vk, repl?: Set<string>): { run: SimRun; sl: Sl; trace: MTrace } => {
    const key = `${lag}|${vkKey(vk)}|${replKey(repl)}`;
    let v = lv1Cache.get(key);
    if (!v) { const trace: MTrace = new Map(); const run = runLV1({ lag, vk, replace: repl, trace }); v = { run, sl: slice(run), trace }; lv1Cache.set(key, v); }
    return v;
  };
  /** 게이트 E: LV1 계좌 기준 평가 구간에 닫힌(청산 실행일 ≥ 평가 시작) 거래 중 손익 상위 3개. */
  const lv1ReplSet = (vk?: Vk): Set<string> => new Set(lv1Of(1, vk).run.trades.filter((t) => CAL[t.exitC] >= FULL.from).sort((a, b) => pnlOf(b) - pnlOf(a)).slice(0, F_E_TOP_TRADES).map((t) => `${t.code}|${t.entryC}`));
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

  // ---- 코어-위성 합성: 코어 비중 w, 위성 1 − w, 매일 종가에 목표 비율 계산 → 다음 거래일 종가에 고정 금액 이동(연구 ALLOC P형과 같은 방식), 이동 금액의 CS_MOVE_COST ----
  interface CombOut { run: SimRun; wCore: number[]; cost: number[]; moved: number[] }
  const combineCS = (core: Sl, sat: Sl, wCin: number, rate: number, delay = 0): CombOut => {
    const wAt = (i: number): number => (void i, wCin), wC0 = wCin;
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
  interface Def { id: string; trial: number; wC: number; vk?: Vk }
  const DS6D: Def = { id: "DS6", trial: 272, wC: DS89_CORE_W };
  const DS12D: Def = { id: "DS12", trial: DS12_TRIAL, wC: DS89_CORE_W, vk: { thr: DS12_THR, persist: 1 } };
  interface Opts { coreLag?: number; satLag?: number; delay?: number; wC?: number; vk?: Partial<Vk>; replSat?: boolean; replCore?: boolean; exclude?: ReadonlySet<string> }
  interface Built { res: CombOut; coreX: CoreX; satX: { run: SimRun; sl: Sl; trace: MTrace }; wC: number; vk?: Vk }
  const build = (d: Def, o: Opts = {}): Built => {
    const wC = o.wC ?? d.wC, vk = d.vk ? { ...d.vk, ...o.vk } : undefined;
    const satX = lv1Of(o.satLag ?? 1, vk, o.replSat ? lv1ReplSet(vk) : undefined);
    const coreX = o.replCore ? coreOf(2, undefined, 1, { repl: coreReplSet(coreOf(2, undefined, 1, { exclude: o.exclude }).run), exclude: o.exclude }) : coreOf(2, undefined, o.coreLag ?? 1, { exclude: o.exclude });
    return { res: combineCS(coreX.sl, satX.sl, wC, CS_MOVE_COST, o.delay ?? 0), coreX, satX, wC, vk };
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
  // 1. 사전 점검 (성과 아님): LV1 재현, DS12 VKOSPI 적용 구조·미래 정보 미사용, DS6 일관성
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


  console.log(`\n=== 1b. DS12 VKOSPI 적용 구조 점검 (성과 아님) ===`);
  {
    const vkBase: Vk = { thr: DS12_THR, persist: 1 };
    // (a) 독립 재계산: 판단일 c마다 직전 거래일 날짜의 VKOSPI(정리본 날짜 맵)로 다시 판정해 vkHigh와 비교한다.
    const indep = (c: number, vk: Vk): boolean => { for (let q = 1; q <= vk.persist; q++) { if (c - q < 0) return false; const v = vkRaw.get(CAL[c - q]); if (v === undefined || !(v >= vk.thr)) return false; } return true; };
    for (const vk of [vkBase, { thr: DS12_NB_THR[0], persist: 1 }, { thr: DS12_NB_THR[1], persist: 1 }, { thr: DS12_THR, persist: DS12_PERSIST_DAYS }]) {
      let nBad = 0, nHi = 0;
      for (let c = cPE; c < nCal; c++) { const a = vkHigh(VKA, c, vk), b = indep(c, vk); if (a !== b) nBad++; if (a) nHi++; }
      console.log(`  (a) 임계값 ${vk.thr}·연속 ${vk.persist}일: 판단일 ${nCal - cPE}일 중 적용일 ${nHi}일, 독립 재계산과 불일치 ${nBad}건`);
      if (nBad > 0) throw new Error("VKOSPI 적용일 독립 재계산 불일치 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)");
    }
    // (b) 항등: 임계값이 무한대면 적용일이 없어 DS6의 LV1과 일별 수익이 정확히 같아야 한다.
    {
      const never = runLV1({ lag: 1, vk: { thr: Number.POSITIVE_INFINITY, persist: 1 } }), ref = lv1Of(1).run;
      let maxD = 0;
      for (let k = 0; k < ref.ret.length; k++) maxD = Math.max(maxD, Math.abs(never.ret[k] - ref.ret[k]));
      console.log(`  (b) 임계값 ∞ 대조: LV1 일별 수익 ${ref.ret.length}일, DS6 LV1과 최대 차이 ${maxD.toExponential(2)}%p`);
      if (!(maxD <= 1e-12)) throw new Error("임계값 ∞ 항등 불일치 — 중단하고 보고한다");
    }
    // (c) 미래 정보 미사용: K일 이후 VKOSPI를 모두 99로 바꿔도 CAL[K+1]까지의 LV1 일별 수익은 같아야 하고(판단일 ≤ K는 K−1까지의 값만 쓴다), 그 뒤에서는 달라져야 한다(점검의 검출력).
    {
      const K = h.calIdx.get("2019-06-28") as number, pert = Float64Array.from(VKA);
      for (let k = K; k < nCal; k++) if (Number.isFinite(pert[k])) pert[k] = 99;
      const a = runLV1({ lag: 1, vk: vkBase }), b = runLV1({ lag: 1, vk: vkBase, vkArr: pert });
      let maxBefore = 0, nAfter = 0;
      for (let k = 0; k < a.ret.length; k++) { const d = a.dates[k]; if (d <= CAL[K + 1]) maxBefore = Math.max(maxBefore, Math.abs(a.ret[k] - b.ret[k])); else if (a.ret[k] !== b.ret[k]) nAfter++; }
      console.log(`  (c) 미래 정보 점검(${CAL[K]} 이후 VKOSPI를 99로 교란): ${CAL[K + 1]}까지 일별 수익 최대 차이 ${maxBefore.toExponential(2)}%p, 그 뒤 달라진 날 ${nAfter}일`);
      if (!(maxBefore <= 1e-12) || nAfter === 0) throw new Error("미래 정보 점검 실패 — 중단하고 보고한다");
    }
    // (d) 적용 일수(성과 아님): VKOSPI 전일 종가 ≥ 임계값인 판단일 수와 m이 실제로 1로 바뀐 판단일 수(DS6 m < 1이었던 날) — 연속 평가 구간 기준 개수만 보고.
    const tr = lv1Of(1, vkBase).trace;
    const chg = [...tr.values()].filter((x) => x.ovr && x.raw < 1).length, ovr = [...tr.values()].filter((x) => x.ovr).length;
    console.log(`  (d) 기본 DS12 LV1의 m 판단 ${tr.size}회 중 VKOSPI 규칙 적용 ${ovr}회, 그중 DS6 m < 1이었다가 1로 바뀐 판단 ${chg}회 (개수만, 수익 계산 없음)`);
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
    console.log(`\n사전 점검 종료: LV1 재현, DS12 VKOSPI 적용 구조(독립 재계산·임계값 ∞ 항등·미래 정보 미사용), DS6 기본 계좌 일관성(연속 전체 11.70 / 39.15, 구간 1 4.10 / 24.51, 롤링 92.81% / 32.03%) 통과. DS12 성과는 계산하지 않았다 | Supabase 읽은 행 ${Object.values(dbRead).reduce((a, b) => a + b, 0)} | Supabase 쓴 행 0 | Storage 읽기·쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    return;
  }
  const hVs = (full: { cagr: number; mdd: number }, rb: { cagr: number; mdd: number }): { ok: boolean; text: string } => {
    const dc = full.cagr - rb.cagr, dm = rb.mdd - full.mdd;
    const c1 = dc >= PEAD_H_CAGR_GAIN_PP, c2 = dm >= PEAD_H_MDD_GAIN_PP && dc >= -PEAD_H_CAGR_FLOOR_PP;
    return { ok: c1 || c2, text: `CAGR ${dc >= 0 ? "+" : ""}${f2(dc)}%p, MDD ${dm >= 0 ? "−" : "+"}${f2(Math.abs(dm))}%p(개선 ${f2(dm)}%p; ${PEAD_H_MDD_GAIN_STRONG_PP}%p 이상 ${dm >= PEAD_H_MDD_GAIN_STRONG_PP ? "O" : "X"}) → 조건1(CAGR +${PEAD_H_CAGR_GAIN_PP}%p) ${c1 ? "O" : "X"}, 조건2(MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p) ${c2 ? "O" : "X"}` };
  };
  /** 게이트 F: LV1 무작위 대조(같은 신호일·주문 수, 같은 청산 규칙, 시드·횟수 고정) — 평활 설정마다 따로 만든다. */
  const randCache = new Map<string, { full: Float64Array; k0: number }[]>();
  const randOf = (vk?: Vk): { full: Float64Array; k0: number }[] => {
    const key = vkKey(vk);
    let a = randCache.get(key);
    if (!a) {
      const base = lv1Of(1, vk).run, ob = new Map<number, number>();
      for (const c of base.entryCs) ob.set(c - 1, (ob.get(c - 1) ?? 0) + 1);
      const rng = mulberry32(KSS_R3_SEED);
      a = [];
      for (let k = 0; k < KSS_R3_DRAWS; k++) { const r = randLV1(rng, ob, vk); a.push({ full: Float64Array.from(r.ret), k0: r.dates.findIndex((dd) => dd >= FULL.from) }); }
      randCache.set(key, a);
      console.log(`  [F] LV1${vk ? ` VKOSPI 규칙 ${vkKey(vk)}` : ""} 무작위 대조 ${KSS_R3_DRAWS}회 준비(${((Date.now() - T0) / 60000).toFixed(1)}분 경과)`);
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
      title: `DS12: DS6 + LV1 목표 배율 m = 1 (전일 VKOSPI 종가 ≥ ${d.vk?.thr}인 판단일; 그 외는 DS6와 같은 m), 코어 ${d.wC * 100}% K200P 상위 2종목 시총가중 / 위성 ${100 - d.wC * 100}% LV1, 일별 목표 비중 리밸 이동 비용 ${CS_MOVE_COST * 100}%`,
      defense: false, capFrac: 1 / 10, fDenominator: DS12_F_DENOMINATOR, ref: { id: "069500", run: bhAsRun },
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
        const dr = randOf(base.vk)[drawK++ % KSS_R3_DRAWS];
        return combineCS(base.coreX.sl, { ...zeroSl, ret: Array.from(dr.full.subarray(dr.k0)) }, d.wC, CS_MOVE_COST).run;
      },
      reasons: [], label,
      extra: (run) => {
        for (const nn of notes) console.log(nn);
        console.log(`${d.id} 게이트 C 해석(사전등록): 코어·LV1 체결을 모두 하루 지연(lag 2) 같은 합성 규칙으로 돌린다(일별 40:60 목표 이동 자체는 지연하지 않음). CAGR 하락 ≤ 1%p ∧ MDD 악화 ≤ 2%p.`);
        console.log(`${d.id} 게이트 E 해석(사전등록): 판정은 LV1의 평가 구간 닫힌 거래 중 손익 상위 3개를 069500 수익률로 바꾼 위성 + 실제 코어를 같은 합성 규칙으로 돌린 연속 전체 CAGR ≥ 069500. 코어 상위 3개·둘 다 대체는 보고만.`);
        console.log(`${d.id} 게이트 F 해석(사전등록): LV1 무작위 대조(같은 신호일·주문 수, 같은 청산 규칙, 시드 ${KSS_R3_SEED}, ${KSS_R3_DRAWS}회)를 실제 코어(고정)와 40:60으로 합성한 분포 대비 ${d.id} 실제 CAGR의 백분위 ≥ 95.`);
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
          const lvT = [...lv1ReplSet(base.vk)].map((k) => { const [code, ec] = k.split("|"); const t = base.satX.run.trades.find((x) => x.code === code && x.entryC === Number(ec)) as SimTrade; return `${label(code)} ${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`; });
          const ct = coreTradesAll(base.coreX.run).sort((a, c2) => pnlOf(c2) - pnlOf(a)).slice(0, F_E_TOP_TRADES);
          console.log(`  LV1 대체 거래: [${lvT.join(", ")}]`);
          console.log(`  코어 상위 3개 거래(기간 끝에 열린 보유 포함, 코어 계좌 대비 손익 순): ${ct.map((t) => `${label(t.code)} ${CAL[t.entryC]}~${CAL[t.exitC]}${t.reason === "기간 끝 평가" ? "(보유 중)" : ""} 수익률 ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")}`);
        }
        extra(run, base);
      },
    };
  };

  // ---- DS12 진단 [판정 불사용] ----
  const ds12Extra = (run: SimRun, base: Built): void => {
    const ds6 = b6.res.run, vk = base.vk as Vk, tr = base.satX.trace;
    const winIdx = (w: Win): number[] => dates0.map((_, i) => i).filter((i) => dates0[i] >= w.from && dates0[i] <= (w.to > h.dataEnd ? h.dataEnd : w.to));
    const kOf = (i: number): number => h.calIdx.get(dates0[i]) as number;
    // 1) VKOSPI 전일 종가 ≥ 임계값인 판단일 수와 분포
    const hi = dates0.map((_, i) => vkHigh(VKA, kOf(i), vk)), hi5 = dates0.map((_, i) => vkHigh(VKA, kOf(i), { thr: vk.thr, persist: DS12_PERSIST_DAYS })), has = dates0.map((_, i) => Number.isFinite(VKA[kOf(i) - 1]));
    console.log(`\n=== 진단 [판정 불사용] VKOSPI 전일 종가 ≥ ${vk.thr}인 판단일 수와 구간별 분포 (판단일 = 평가 구간 거래일) ===\n| 구간 | 거래일 | 전일 VKOSPI 값 있는 날 | ≥ ${vk.thr}인 날 | 비율 % | 연속 ${DS12_PERSIST_DAYS}일 이상 유지한 날 |\n|---|---|---|---|---|---|`);
    for (const [wn, w] of ALLW) { const ix = winIdx(w), n = ix.length, nh = ix.filter((i) => hi[i]).length; console.log(`| ${wn} | ${n} | ${ix.filter((i) => has[i]).length} | ${nh} | ${f2((nh / Math.max(n, 1)) * 100)} | ${ix.filter((i) => hi5[i]).length} |`); }
    const yrs: number[] = [];
    for (let y = Number(FULL.from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) yrs.push(y);
    console.log(`연도별 ≥ ${vk.thr}인 날 수: ${yrs.map((y) => `${y} ${dates0.filter((d, i) => d.startsWith(`${y}-`) && hi[i]).length}`).join(" | ")}`);
    // 2) m이 1로 바뀐 판단일(규칙 적용 + DS6 m < 1)과 수익 기여(상태 기반 근사: 판단일 c의 영향은 c+1 종가 체결 뒤인 c+2 거래일 수익부터)
    const chg = new Set<number>([...tr].filter(([, v]) => v.ovr && v.raw < 1).map(([c]) => c));
    console.log(`\n=== 진단 [판정 불사용] m이 1로 바뀐 판단일(규칙 적용 ∧ DS6 m < 1)과 계좌 수익 기여 (근사: 판단일 c의 바뀐 m은 c+1 종가 체결이라 c+2 거래일 수익부터 영향; 영향받는 날 = c+2인 날; 일별 DS12 − DS6 계좌 수익률 %p의 단순 합) ===\n| 구간 | m 판단 횟수 | 규칙 적용 | 그중 m이 1로 바뀐 판단 | 바뀐 판단의 DS6 m 평균 | 영향받는 날 수 | 영향받는 날 DS12 − DS6 합 %p | 전체 날 DS12 − DS6 합 %p |\n|---|---|---|---|---|---|---|---|`);
    for (const [wn, w] of ALLW) {
      const ix = winIdx(w), cs = [...tr.keys()].filter((c) => CAL[c] >= w.from && CAL[c] <= (w.to > h.dataEnd ? h.dataEnd : w.to)), ch = cs.filter((c) => chg.has(c));
      const aff = ix.filter((i) => chg.has(kOf(i) - 2));
      console.log(`| ${wn} | ${cs.length} | ${cs.filter((c) => (tr.get(c) as { ovr: boolean }).ovr).length} | ${ch.length} | ${ch.length ? f2(avg(ch.map((c) => (tr.get(c) as { raw: number }).raw))) : "-"} | ${aff.length} | ${f2(aff.reduce((a, i) => a + (run.ret[i] - ds6.ret[i]), 0))} | ${f2(ix.reduce((a, i) => a + (run.ret[i] - ds6.ret[i]), 0))} |`);
    }
    // 3) 삼성전자 의존 (코어는 DS6와 같고 코어-위성 비중 이동만 다르다)
    const ch6 = coreHolds(2, undefined);
    const samW = (i: number): number => ch6[i].find(([code]) => code === DS89_SAMSUNG)?.[1] ?? 0;
    console.log(`\n=== 진단 [판정 불사용] 삼성전자 일별 평균 계좌 비중 % (코어 안 삼성전자 비중 × 코어 계좌 비중; 현금 날 포함; ${nDays}일) ===\n| 구간 | DS6 | DS12 | 코어 안 평균 삼성전자 비중 % | 삼성전자가 코어에 있던 날 비율 % |\n|---|---|---|---|---|`);
    for (const [wn, w] of ALLW) { const ix = winIdx(w); console.log(`| ${wn} | ${f2(avg(ix.map((i) => b6.res.wCore[i] * samW(i) * 100)))} | ${f2(avg(ix.map((i) => base.res.wCore[i] * samW(i) * 100)))} | ${f2(avg(ix.map((i) => samW(i) * 100)))} | ${f2((ix.filter((i) => samW(i) > 0).length / ix.length) * 100)} |`); }
    const exS = new Set([DS89_SAMSUNG]), x6 = build(DS6D, { exclude: exS }).res.run, x12 = build(DS12D, { exclude: exS }).res.run;
    console.log(`\n=== 진단 [판정 불사용] 삼성전자를 코어 후보에서 뺀 경우 (코어 순위 목록에서 ${DS89_SAMSUNG} 제외 뒤 상위 2종목; 위성·합성은 같음; 새 후보 아님; CAGR % / MDD %) ===\n| 구간 | 069500 | DS6 | DS6-X | DS12 | DS12-X |\n|---|---|---|---|---|---|`);
    for (const [wn, w] of ALLW) console.log(`| ${wn} | ${cell(h.bhP, w)} | ${cell(ds6, w)} | ${cell(x6, w)} | ${cell(run, w)} | ${cell(x12, w)} |`);
    const sb = h.st(h.bhP, FULL), sx = h.st(x12, FULL), sc = h.st(run, FULL);
    console.log(`DS12-X 연속 전체 ${f2(sx.cagr)} / ${f2(sx.mdd)} (069500 대비 CAGR ${sg(sx.cagr - sb.cagr)}%p, MDD ${sg(sx.mdd - sb.mdd)}%p; DS12 대비 CAGR ${sg(sx.cagr - sc.cagr)}%p, MDD ${sg(sx.mdd - sc.mdd)}%p)`);
    console.log(`\n=== 진단 [판정 불사용] 코어 단독·LV1 단독 성적 (각 계좌 100%로 본 CAGR % / MDD %) ===\n| 구간 | 069500 | DS6의 LV1 | DS12의 LV1(VKOSPI 규칙) | 코어(시총 상위 2, DS6·DS12 공통) |\n|---|---|---|---|---|`);
    for (const [wn, w] of ALLW) console.log(`| ${wn} | ${cell(h.bhP, w)} | ${cell(asRun(lv1Of(1).sl), w)} | ${cell(asRun(base.satX.sl), w)} | ${cell(asRun(base.coreX.sl), w)} |`);
  };

  const sp = mkSpec(DS12D, [
    ...DS12_NB_THR.map((thr) => ({ label: `임계값 ${thr}`, run: () => build(DS12D, { vk: { thr } }).res.run })),
    { label: `임계값 ${DS12_THR}에서 ${DS12_PERSIST_DAYS}거래일 연속 유지 후 적용`, run: () => build(DS12D, { vk: { persist: DS12_PERSIST_DAYS } }).res.run },
    ...[-CS_CORE_W_NEIGHBOR, CS_CORE_W_NEIGHBOR].map((dw) => ({ label: `코어 비중 ${Math.round((DS89_CORE_W + dw) * 100)}% (위성 ${Math.round((1 - DS89_CORE_W - dw) * 100)}%)`, run: () => build(DS12D, { wC: DS89_CORE_W + dw }).res.run })),
  ], [
    `DS12 정의(사전등록): DS6에서 LV1의 목표 배율 m만 바꾼다. 판단일 c의 직전 거래일(CAL[c−1]) VKOSPI 종가가 ${DS12_THR} 이상이면 m = 1(줄이지 않음), 그 외·VKOSPI 값이 없는 날(2011-01-03 이전)은 DS6와 같은 m(20일 변동성 기준 min(1, 20% ÷ σ), 소수 2자리 반올림). 밴드·진입·청산·체결(판단일 종가 → 다음 거래일 종가)·코어·비용·일별 목표 비중 리밸은 DS6 그대로다.`,
    `DS12 게이트 D 해석(사전등록): 이웃 5개 — 임계값 ${DS12_NB_THR.join("·")}, 임계값 ${DS12_THR}에서 ${DS12_PERSIST_DAYS}거래일 연속 유지(CAL[c−${DS12_PERSIST_DAYS}..c−1]이 모두 ≥ ${DS12_THR}) 후 적용, 코어 비중 30%·50%(위성 70%·50%). 연속 전체 CAGR ≥ 069500 CAGR이어야 통과, 하나라도 미만이면 탈락.`,
  ], ds12Extra);

  const verdicts: Verdict[] = [evaluate(h, W, sp)];
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: sp.trial - 1, contamNote: W.contamNote });
  console.log(`DS6 기록(참고): 연속 전체 ${DS89_DS6_REF.전체.join(" / ")}, 구간 1 ${REC.DS6.구간1.join(" / ")}, 구간 2 ${REC.DS6.구간2.join(" / ")}, 구간 3 ${REC.DS6.구간3.join(" / ")}, 롤링 CAGR 우위 ${DS89_DS6_REF.rollCagrShare}% · MDD 우위 ${DS89_DS6_REF.rollMddShare}%; DS8 ${REC.DS8.결과}, DS9 ${REC.DS9.결과} — 위 비교 표 참조`);
  console.log(`사전 고지: ${sp.id}(시도 ${sp.trial})는 DS6 진단과 VKOSPI 스캔(학습 구간 7행 후보, 확인 점검 재현 판정) 결과를 본 뒤 만든 변형이라 선택 편향이 크고, 후보 신호는 같은 시계열(VKOSPI)에서 나와 독립이 아니며 독립 사건 수가 적다. 2011~2026 구간은 DS6·DS4·LV1 등 선행 연구에서 반복해 본 데이터라 오염돼 있다. 누적 ${sp.trial}번 기준 우연 통과 기대 ${sp.trial} × 0.05 = ${(sp.trial * 0.05).toFixed(2)}개. 삼성전자 의존이 크다. 통과 여부와 무관하게 운영 적용·PR은 하지 않는다.`);
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ") || "없음"} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${verdicts.map((v) => v.trial).join(", ")}`);
  void SLIPPAGE_PCT_PER_SIDE; void CS_RANK_DEPTH; void L_EVAL_AFTER; void median;
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

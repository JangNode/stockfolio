/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 DS5(270)·DS6(271): 공시(DART) 데이터를 쓰지 않는 DS4 변형. 사전 등록: docs/research/ds5-prereg.md.
 * DS5 = 코어 40% + 위성 60%(W3 + LV1 변동성 역수, PE4 제거), DS6 = 코어 40% + 위성 60%(LV1 단독). 코어는 연구 DS4와 같다(월말 K200P 안 당일 시총 상위 2종목 시총 비율, 순위 밖 5거래일 연속일 때만 교체).
 * 구성요소는 연구 ALLOC·CAPREC·IVA·CS·DS와 같은 코드·같은 캐시에서 다시 돌린다(Storage 읽기 0, 공시·DART 키 사용 없음). 환경 변수 ALLOC_MODE=repro: 재현·자체 점검만 하고 DS5·DS6 성과는 계산하지 않는다(사전 점검).
 * 공시(DART) 데이터는 쓰지 않는다: PE4 구성요소와 그 입력(공시 부분집합 캐시)을 아예 읽지 않으며, DS4·CS2·DS2 같은 PE4가 들어간 참고 열은 다시 계산하지 않고 연구 기록값(lib/ds56Config.ts DS56_RECORDED)을 그대로 표시한다. DART 호출·키 사용 없음.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { simSlots, type SimCand, type SimPos, type SimRun, type SimTrade, type SimVt } from "@/lib/slotSim";
import { L_CANDS, L_SLIPPAGE, L_EVAL_AFTER } from "@/lib/megacapTrendConfig";
import { LS_COOLDOWN_DAYS } from "@/lib/megacapTrailingConfig";
import { LE_CANDS, LE_LEGS, LE_ENTRY_LEG, LE_RANK_DEPTH } from "@/lib/momentumEnsembleConfig";
import { LV_CANDS, LV_WINDOW, LV_ANNUAL_DAYS, LV_ROUND_DP, LV_BAND } from "@/lib/le2VolTargetConfig";
import { rankEnsemble, outsiderEnsembleRank, type EnsembleRanking } from "@/lib/momentumEnsemble";
import { alignCloses, equalWeightSigma, volMultiplier } from "@/lib/le2VolTarget";
import { PEAD_SHORT_CANDS, PEAD_MAX_POS, PEAD_COOLDOWN_DAYS, PEAD_RUN_START, PEAD_WINDOWS, PEAD_SLIPPAGE, PEAD_DOWNTURNS, PEAD_H_CAGR_GAIN_PP, PEAD_H_MDD_GAIN_PP, PEAD_H_MDD_GAIN_STRONG_PP, PEAD_H_CAGR_FLOOR_PP, PEAD_PRELIM_STUDY } from "@/lib/peadConfig";
import { WFR_EVAL_FROM } from "@/lib/walkforwardRankerConfig";
import { LTR_CANDS, LTR_PORT } from "@/lib/lowTurnoverConfig";
import { KSS_R3_DRAWS, KSS_R3_SEED, F_E_TOP_TRADES } from "@/lib/kodexSectorSatConfig";
import { ALLOC_COMP_IDS, ALLOC_REPRO, ALLOC_REBAL_COST, ALLOC_SERIES_SHA, type AllocCompId } from "@/lib/strategyAllocationConfig";
import { IVA_VOL_WINDOW, IVA_MOVE_COST, IVA_P2_REF, IVA_W_QUANTILES, IVA_TARGET_WINDOW, IVA_TARGET_BAND } from "@/lib/inverseVolConfig";
import { CAPREC_COMP_CUT_REF } from "@/lib/capitalRecyclingConfig";
import { DS_F_DENOMINATOR, DS_CANDS, DS_REF, capRedistribute } from "@/lib/delayRobustCoreSatelliteConfig";
import { DS4_CAND, DS4_REF } from "@/lib/ds4Config";
import { DS56_PRIOR_TESTS, DS5_SIDE_CAP, DS56_CANDS, DS56_RECORDED } from "@/lib/ds56Config";
import { CS_PRIOR_TESTS, CS_SWAP_CONFIRM_DAYS, CS_RANK_DEPTH, CS_MOVE_COST, CS_MOVE_COST_SENS, CS_CORE_W_NEIGHBOR, CS_F_DENOMINATOR, CS_SAT_COMPS, CS_CANDS, CS_R3_REF, CS_R1_REF, CS_ACCOUNTING_TOL_PP } from "@/lib/coreSatelliteConfig";
import { computeCumulativeAndMdd, computeCagrPct } from "@/lib/strategyBacktestSummary";
import { RMD_WINDOWS_2017, RMD_DOWN_DAY, RMD_K_ITER, RMD_BENCH_REF } from "@/lib/riskMatchedDiagnosticConfig";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, mulberry32, SNAP_END, f2, avg, median, type S, type Win } from "./researchHarness";
import { evaluate, yearlyTable, summaryReport, type CandSpec, type Verdict, type Windows } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
const SAMSUNG = "005930", HYNIX = "000660";
const sha = (b: Uint8Array | Buffer | string): string => createHash("sha256").update(b).digest("hex");
type CId = AllocCompId;
type CO = { lag: number; replace?: Set<string>; detail?: boolean; onDay?: (c: number, V: number, held: [string, number][]) => void };
interface Comp { id: CId; label: (code: string) => string; run: (o: CO) => SimRun; random: (rng: () => number, ob: Map<number, number>) => SimRun }
/** 공통 평가 시작 이후로 자른 일별 계열(구성요소 하나의 계좌 기준). */
interface Sl { dates: string[]; ret: number[]; costFrac: number[]; nPos: number[]; inv: number[]; turn: number[]; wMax: number[] }
interface Episode { peakIdx: number; troughIdx: number; recIdx: number | null; depth: number }

function episodes(ret: number[]): Episode[] {
  const out: Episode[] = [];
  let E = 1, peak = 1, peakIdx = -1, cur: Episode | null = null, trough = 1;
  for (let i = 0; i < ret.length; i++) {
    E *= 1 + ret[i] / 100;
    if (E >= peak) {
      if (cur) { cur.recIdx = i; out.push(cur); cur = null; }
      peak = E; peakIdx = i; trough = E;
    } else {
      if (!cur) { cur = { peakIdx, troughIdx: i, recIdx: null, depth: 0 }; trough = E; }
      if (E <= trough) { trough = E; cur.troughIdx = i; cur.depth = 1 - E / peak; }
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function main(): Promise<void> {
  const REPRO = process.env.ALLOC_MODE?.trim().toLowerCase() === "repro";
  console.log(`연구 DS5·DS6(공시 미사용 DS4 변형) ${REPRO ? "사전 점검(재현·자체 점검만, DS5·DS6 성과 미계산)" : "시도 270~271 시험"} 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, kAt, nameOf, indOf } = await loadK200P(h);
  void indOf;

  // ---- 공통 평가 구간: 수익 집계 2017-04-04~, 학습 2017-04-04~2019-12-31 / 확인 2020~2021 / 보류 2022~ ----
  const cPE = CAL.findIndex((d) => d >= PEAD_RUN_START);
  if (cPE < 0 || CAL[cPE] !== PEAD_RUN_START) throw new Error(`${PEAD_RUN_START}이 거래일 달력에 없음`);
  const cutC = cPE + 1;
  const NW: [string, Win][] = PEAD_WINDOWS.map(([n, f, t]) => [n, { from: f, to: t }]);
  const FULL: Win = { from: CAL[cutC], to: "9999-12-31" };
  const W: Windows = { NW, FULL, ALL: [...NW, ["평가 구간 전체", FULL]] };
  const ex26 = { from: FULL.from, to: "2025-12-31" };
  console.log(`공통 평가: 초기 배분 ${CAL[cPE]} 종가(비용 없음), 수익률 집계 ${FULL.from}~${h.dataEnd} | 구간 ${NW.map(([n, w]) => `${n} ${w.from}~${w.to}`).join(" / ")}`);

  // ---- 0. 069500 기준선 ----
  console.log(`\n=== 0. 069500 기준선 (수익 집계 ${FULL.from}~; 원주가, 가격 수익만; CAGR % / MDD %) ===\n기존 = etf_daily_prices만(${h.bhPDb.dates[h.bhPDb.dates.length - 1]}까지), 새 = 보조 파일(${h.bhP.dates[h.bhP.dates.length - 1]}까지) — 게이트 A~H는 새 기준선으로 판정\n| 구간 | 기존 | 새 |\n|---|---|---|`);
  for (const [wn, w] of [...W.ALL, ["2026년 제외 (~2025-12-31)", ex26] as [string, Win]]) {
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

  // ================= W3 (저장된 WFR 점수) =================
  {
    const cd = LTR_CANDS.W3;
    const DIR = process.env.WFR_DIR?.trim() || ".wfr";
    const RANK_EXIT = "순위 밖", OUT_EXIT = "유니버스 이탈", RANDOM_EXIT = "무작위 이탈";
    const cEval = CAL.findIndex((d) => d >= WFR_EVAL_FROM);
    if (cEval < 1) throw new Error(`${WFR_EVAL_FROM} 이후 거래일 없음`);
    const cS = cEval - 1;
    const meta = JSON.parse(await fs.readFile(path.join(DIR, "meta.json"), "utf8")) as { nRows: number; nCal: number; codes: string[]; cEval: number };
    if (meta.nCal !== nCal || meta.cEval !== cEval || meta.codes.length !== h.stocks.length || meta.codes.some((c, k) => c !== h.stocks[k].code)) throw new Error("저장된 점수 파일의 달력·종목 순서가 현재 하네스와 다르다");
    const rd = async <T extends Float32Array | Int32Array>(name: string, Ctor: { new (b: ArrayBuffer): T }): Promise<T> => { const b = await fs.readFile(path.join(DIR, name)); return new Ctor(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer); };
    const dayIdx = await rd("dayIdx.i32", Int32Array), stockIdx = await rd("stockIdx.i32", Int32Array);
    if (dayIdx.length !== meta.nRows) throw new Error("행 수 불일치");
    const dayStart = new Int32Array(nCal).fill(-1), dayEnd = new Int32Array(nCal).fill(-1);
    for (let r = 0; r < dayIdx.length; r++) { const c = dayIdx[r]; if (dayStart[c] < 0) dayStart[c] = r; dayEnd[c] = r + 1; }
    console.log(`W3 입력: 점수 파일 scores_M3.f32 SHA-256 ${sha(await fs.readFile(path.join(DIR, "scores_M3.f32")))} | 행 ${meta.nRows}, 종목 ${meta.codes.length}개 순서 일치, 모델 재학습 없음`);
    const stockOf = h.stocks, codeIdx = new Map(h.stocks.map((s, k) => [s.code, k]));
    const sc = await rd("scores_M3.f32", Float32Array);
    interface DayRank { order: Int32Array; stk: Int32Array; rk: Int16Array }
    const rk: (DayRank | null)[] = new Array<DayRank | null>(nCal).fill(null);
    for (let c = cEval; c < nCal; c++) {
      const lo = dayStart[c], hi = dayEnd[c];
      if (lo < 0) continue;
      const rows: number[] = [];
      for (let r = lo; r < hi; r++) if (Number.isFinite(sc[r])) rows.push(r);
      if (!rows.length) continue;
      rows.sort((x, y) => sc[y] - sc[x] || (stockOf[stockIdx[x]].code < stockOf[stockIdx[y]].code ? -1 : 1));
      const order = Int32Array.from(rows.map((r) => stockIdx[r]));
      const byStk = [...order].map((si, k) => [si, k + 1] as const).sort((x, y) => x[0] - y[0]);
      rk[c] = { order, stk: Int32Array.from(byStk.map((x) => x[0])), rk: Int16Array.from(byStk.map((x) => x[1])) };
    }
    const rankOf = (dr: DayRank, si: number): number | undefined => { let lo = 0, hi = dr.stk.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (dr.stk[m] === si) return dr.rk[m]; if (dr.stk[m] < si) lo = m + 1; else hi = m - 1; } return undefined; };
    const cfg = { slip: LTR_PORT.slip, maxPos: LTR_PORT.slots, capFrac: 1 / LTR_PORT.slots, cooldown: 0 };
    const hooks = {
      candsOf: (c: number): SimCand[] => {
        const dr = c >= cEval ? rk[c] : null;
        if (!dr) return [];
        return Array.from(dr.order.slice(0, LTR_PORT.entryTop), (si) => ({ s: stockOf[si] as S, code: stockOf[si].code }));
      },
      exitReason: (p: SimPos, c: number, i: number | undefined): string | null => {
        if (i === undefined || c < cEval) return null;
        if (c - p.entryC < cd.minHold) return null;
        const dr = rk[c];
        if (!dr) return null;
        const r = rankOf(dr, codeIdx.get(p.code) as number);
        if (r === undefined) return OUT_EXIT;
        return r > cd.sellRank ? RANK_EXIT : null;
      },
    };
    let baseCache: SimRun | null = null;
    comps.push({
      id: "W3", label,
      run: (o) => { const r = simSlots(env(cS), cfg, hooks, { lag: o.lag, replace: o.replace, detail: o.detail, onDay: o.onDay }); if (o.lag === 1 && o.detail && !o.replace && !o.onDay) baseCache = r; return r; },
      random: (rng, ob) => {
        const base = baseCache;
        const exits = base ? base.trades.filter((t) => t.reason === RANK_EXIT || t.reason === OUT_EXIT).length : 0;
        const elig = base ? base.trades.reduce((a, t) => a + Math.max(0, t.exitC - t.entryC - cd.minHold), 0) : 1;
        const q = exits / Math.max(elig, 1);
        return simSlots(env(cS), cfg, {
          candsOf: (c, held, blocked) => {
            const n = ob.get(c) ?? 0;
            if (!n || c < cEval) return [];
            const pool = kAt(CAL[c]).filter((s) => !held(s.code) && !blocked(s.code));
            const left = [...pool], out: SimCand[] = [];
            while (out.length < n && left.length) { const s = left.splice(Math.floor(rng() * left.length), 1)[0]; out.push({ s, code: s.code }); }
            return out;
          },
          exitReason: (p, c, i) => (i !== undefined && c - p.entryC >= cd.minHold && rng() < q ? RANDOM_EXIT : null),
        }, { lag: 1 });
      },
    });
  }

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

  // ================= L3 (대형주 상위 5위 집중, 통제군) =================
  {
    const l3 = L_CANDS.L3;
    const cS = CAL.findIndex((d) => d >= L_EVAL_AFTER);
    const cfg = { slip: L_SLIPPAGE, maxPos: l3.slots, capFrac: 1 / l3.slots, cooldown: 0 };
    const entryList = (c: number): SimCand[] => megaAt(c, LE_RANK_DEPTH).list.slice(0, l3.entryRank).map((s) => ({ s, code: s.code }));
    const hooks = {
      candsOf: (c: number): SimCand[] => entryList(c),
      exitReason: (p: SimPos, c: number, i: number | undefined): string | null => (i === undefined ? null : (megaAt(c, LE_RANK_DEPTH).rank.get(p.code) ?? Number.POSITIVE_INFINITY) > l3.keepRank ? "시총 순위 밖" : null),
    };
    comps.push({
      id: "L3", label,
      run: (o) => simSlots(env(cS), cfg, hooks, { lag: o.lag, replace: o.replace, detail: o.detail, onDay: o.onDay }),
      random: (rng, ob) => simSlots(env(cS), cfg, {
        candsOf: (c, held) => {
          const n = ob.get(c) ?? 0;
          if (!n) return [];
          const pool = entryList(c).filter((x) => !held(x.code)), out: SimCand[] = [];
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
  const simCore = (N: number, o: { lag: number; replace?: Set<string>; onDay?: (c: number, V: number, held: [string, number][]) => void; exclude?: ReadonlySet<string> }): CoreRun => {
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
        const top = megaAt(c, CS_RANK_DEPTH).list.filter((s) => !o.exclude?.has(s.code)).slice(0, N), topSet = new Set(top.map((s) => s.code));
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
  console.log(`\n=== 1. 구성요소 재현 확인 (원래 평가 시작 기준 전체 구간 CAGR % / MDD %; 기록과 소수 둘째 자리까지 같아야 하고, 일별 순수익 SHA-256이 연구 ALLOC 사전등록 해시와 같아야 한다) ===\n| 구성요소 | 원래 평가 시작 | 이번 재계산 | 원래 시험 기록 | 일치 | 일별 순수익 파일 SHA-256 | ALLOC 해시와 |\n|---|---|---|---|---|---|---|`);
  const outDir = process.env.ALLOC_OUT_DIR?.trim() || ".iva-returns";
  await fs.mkdir(outDir, { recursive: true });
  const seriesSha: Record<string, string> = {};
  const mism: string[] = [];
  for (const cp of comps) {
    const r = getRun(cp, 1);
    const s = h.st(r, { from: r.dates[0], to: "9999-12-31" }), rec = ALLOC_REPRO[cp.id];
    const body = JSON.stringify({ id: cp.id, note: "일별 순수익(%, 비용 반영 후), 원래 평가 시작부터", dates: r.dates, ret: r.ret });
    await fs.writeFile(path.join(outDir, `${cp.id}.json`), body);
    seriesSha[cp.id] = sha(body);
    const ok = f2(s.cagr) === f2(rec.cagr) && f2(s.mdd) === f2(rec.mdd), okSha = !ALLOC_SERIES_SHA || ALLOC_SERIES_SHA[cp.id as AllocCompId] === seriesSha[cp.id];
    if (!ok || !okSha) mism.push(cp.id);
    console.log(`| ${cp.id} | ${r.dates[0]} | ${f2(s.cagr)} / ${f2(s.mdd)} | ${rec.cagr.toFixed(2)} / ${rec.mdd.toFixed(2)} | ${ok ? "일치" : "불일치"} | ${seriesSha[cp.id]} | ${okSha ? "일치" : "불일치"} |`);
  }
  if (mism.length) throw new Error(`구성요소 재현 불일치(${mism.join(", ")}) — 중단하고 보고한다`);
  const refDir = process.env.ALLOC_REF_DIR?.trim();
  if (refDir) {
    const lines: string[] = [];
    for (const cp of comps) {
      try { lines.push(`${cp.id} ${sha(await fs.readFile(path.join(refDir, `${cp.id}.json`))) === seriesSha[cp.id] ? "일치" : "불일치"}`); } catch { lines.push(`${cp.id} 파일 없음`); }
    }
    console.log(`이전 연구 일별 순수익 캐시(${refDir}) 파일 해시 대조: ${lines.join(" | ")}`);
    if (lines.some((l) => l.endsWith("불일치"))) throw new Error("이전 연구 일별 순수익 캐시와 다르다");
  } else console.log("이전 연구 일별 순수익 캐시 복원 없음 — 재계산 해시를 ALLOC 사전등록 기록과 대조해 통과");

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
  console.log(`\n구성요소 공통 평가 구간(${FULL.from}~) 전체 CAGR / MDD 재현 (연구 ALLOC·CAPREC 보고 표)\n| 구성요소 | 이번 | 기록 | 일치 |\n|---|---|---|---|`);
  const mism2: string[] = [];
  for (const cp of comps) {
    const bq = baseSl.get(cp.id)!, s = h.st({ dates: bq.dates, ret: bq.ret }, FULL), rec = CAPREC_COMP_CUT_REF[cp.id as keyof typeof CAPREC_COMP_CUT_REF];
    const ok = f2(s.cagr) === f2(rec.cagr) && f2(s.mdd) === f2(rec.mdd);
    if (!ok) mism2.push(cp.id);
    console.log(`| ${cp.id} | ${f2(s.cagr)} / ${f2(s.mdd)} | ${rec.cagr.toFixed(2)} / ${rec.mdd.toFixed(2)} | ${ok ? "일치" : "불일치"} |`);
  }
  if (mism2.length) throw new Error(`공통 구간 재현 불일치(${mism2.join(", ")}) — 중단하고 보고한다`);

  {
    const b = h.st(h.bhP, FULL), okb = f2(b.cagr) === f2(RMD_BENCH_REF.cagr) && f2(b.mdd) === f2(RMD_BENCH_REF.mdd);
    console.log(`069500 기준선 전체 ${f2(b.cagr)} / ${f2(b.mdd)} (기록 ${RMD_BENCH_REF.cagr.toFixed(2)} / ${RMD_BENCH_REF.mdd.toFixed(2)}) → ${okb ? "일치" : "불일치"}`);
    if (!okb) throw new Error("069500 기준선이 기록과 다르다 — 중단");
  }
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
  const holdings = new Map<CId, [string, number][][]>();
  const holdOf = (cp: Comp): [string, number][][] => {
    let a = holdings.get(cp.id);
    if (!a) {
      const arr: [string, number][][] = new Array(nDays).fill(null).map(() => []);
      cp.run({ lag: 1, onDay: (c, V, held) => { const i = dateIdx.get(CAL[c]); if (i !== undefined) arr[i] = held.map(([code, val]) => [code, val / V]); } });
      holdings.set(cp.id, arr); a = arr;
    }
    return a;
  };
  const compSer = new Map<CId, { dates: string[]; ret: number[] }>(comps.map((cp) => { const s = baseSl.get(cp.id)!; return [cp.id, { dates: s.dates, ret: s.ret }]; }));
  const bhRet = new Map(h.bhP.dates.map((d, i) => [d, h.bhP.ret[i]]));
  const bRetAxis = dates0.map((d) => { const r = bhRet.get(d); if (r === undefined) throw new Error(`069500 일수익률 없음 ${d}`); return r; });
  const inWin = (d: string, w: Win): boolean => d >= w.from && d <= w.to;
  const hVs = (full: { cagr: number; mdd: number }, rb: { cagr: number; mdd: number }): { ok: boolean; text: string } => {
    const dc = full.cagr - rb.cagr, dm = rb.mdd - full.mdd;
    const c1 = dc >= PEAD_H_CAGR_GAIN_PP, c2 = dm >= PEAD_H_MDD_GAIN_PP && dc >= -PEAD_H_CAGR_FLOOR_PP;
    return { ok: c1 || c2, text: `CAGR ${dc >= 0 ? "+" : ""}${f2(dc)}%p, MDD ${dm >= 0 ? "−" : "+"}${f2(Math.abs(dm))}%p(개선 ${f2(dm)}%p; ${PEAD_H_MDD_GAIN_STRONG_PP}%p 이상 ${dm >= PEAD_H_MDD_GAIN_STRONG_PP ? "O" : "X"}) → 조건1(CAGR +${PEAD_H_CAGR_GAIN_PP}%p) ${c1 ? "O" : "X"}, 조건2(MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p) ${c2 ? "O" : "X"}` };
  };
  const pct = (a: number, b: number): string => f2((a / Math.max(b, 1)) * 100);
  const quant = (v: number[], ps: readonly number[]): string => { const a = [...v].sort((x, y) => x - y); return ps.map((p) => `${Math.round(p * 100)}%=${a.length ? f2(a[Math.min(Math.floor(a.length * p), a.length - 1)] * 100) : "-"}`).join(" / "); };
  // 위험 일치 069500 진단용(연구 진단 risk-matched-benchmark-diagnostic과 같은 정의)
  const mddOfR = (r: number[]): number => computeCumulativeAndMdd(r).mddPct;
  const cagrOfR = (r: number[], w: Win): number => computeCagrPct(computeCumulativeAndMdd(r).totalReturnPct, w.from, w.to > h.dataEnd ? h.dataEnd : w.to);
  const volAnn = (r: number[]): number => sdOf(r) * Math.sqrt(D);
  const kForMdd = (bench: number[], target: number): number => { if (mddOfR(bench) <= target) return 1; let lo = 0, hi = 1; for (let i = 0; i < RMD_K_ITER; i++) { const m = (lo + hi) / 2; if (mddOfR(bench.map((x) => x * m)) > target) hi = m; else lo = m; } return (lo + hi) / 2; };
  const olsR = (x: number[], y: number[]): { beta: number; alphaAnn: number; r2: number } => {
    const n = x.length, mx = x.reduce((a, v) => a + v, 0) / n, my = y.reduce((a, v) => a + v, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
    const beta = sxy / sxx;
    return { beta, alphaAnn: (my - beta * mx) * D, r2: (sxy * sxy) / (sxx * syy) };
  };
  const allocBase = new Map<string, Out>();
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
  for (const N of [1, 2, 3]) coreCheck(N);
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

  // ---- 시총가중 K200P 지수형(가격 기준, 비용 없음, 전일 구성·전일 시총 가중)과 삼성전자·SK하이닉스를 뺀 것 — 진단용(연구 진단 semiconductor-contribution과 같은 정의) ----
  const idxInc: number[] = [], idxEx: number[] = [];
  for (let i = 0; i < nDays; i++) {
    const c = cutC + i;
    if (CAL[c] !== dates0[i]) throw new Error("달력 축 불일치");
    let sw = 0, swr = 0, swEx = 0, swrEx = 0;
    for (const s of kAt(CAL[c - 1])) {
      const ip = s.idx.get(CAL[c - 1]), ic = s.idx.get(CAL[c]);
      if (ip === undefined || ic === undefined) continue;
      const mc = s.mcapRow[ip], r = (s.close[ic] / s.close[ip] - 1) * 100;
      if (!(mc > 0) || !Number.isFinite(r)) continue;
      sw += mc; swr += mc * r;
      if (s.code !== SAMSUNG && s.code !== HYNIX) { swEx += mc; swrEx += mc * r; }
    }
    idxInc.push(swr / sw); idxEx.push(swrEx / swEx);
  }


  // ---- 위성 비중 구조 자체 점검 (성과 아님) ----
  const CP = (id: string): Comp => compOf.get(id as CId)!;
  type SatNb = { kind: "fixedEq" } | { kind: "cap"; id: string; v: number } | { kind: "win"; w: number };
  interface DSDef { readonly trial: number; readonly coreW: number; readonly coreN: number; readonly sat: readonly string[]; readonly cap: { id: string; v: number } | null; readonly nNeighbors: readonly number[]; readonly satNb: readonly SatNb[] }
  const nbOf = (c: { fixedEqNb: boolean; sideCapNb: readonly string[]; winNb: readonly number[] }): SatNb[] => [...(c.fixedEqNb ? [{ kind: "fixedEq" } as SatNb] : []), ...c.sideCapNb.map((id) => ({ kind: "cap", id, v: DS5_SIDE_CAP }) as SatNb), ...c.winNb.map((w) => ({ kind: "win", w }) as SatNb)];
  const CANDS_ALL: Record<string, DSDef> = {
    DS5: { trial: DS56_CANDS.DS5.trial, coreW: DS56_CANDS.DS5.coreW, coreN: DS56_CANDS.DS5.coreN, sat: DS56_CANDS.DS5.sat, cap: null, nNeighbors: DS56_CANDS.DS5.nNeighbors, satNb: nbOf(DS56_CANDS.DS5) },
    DS6: { trial: DS56_CANDS.DS6.trial, coreW: DS56_CANDS.DS6.coreW, coreN: DS56_CANDS.DS6.coreN, sat: DS56_CANDS.DS6.sat, cap: null, nNeighbors: DS56_CANDS.DS6.nNeighbors, satNb: nbOf(DS56_CANDS.DS6) },
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
  const WIN = W;
  const coreSerOf = (N: number): { dates: string[]; ret: number[] } => { const sl0 = getCoreSl(N, 1); return { dates: sl0.dates, ret: sl0.ret }; };
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
  if (REPRO) {
    console.log(`\n사전 점검 종료: 구성요소(W3·LV1·L3) 재현(원래 시작·공통 구간)·일별 순수익 해시·W3·LV1·L3 구성요소 재현과 069500 기준선이 일치, 코어 구조·회계 점검과 위성 비중 구조(상한·반반 고정·창 이웃) 점검 통과. DS5·DS6 성과는 계산·출력하지 않았다 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    return;
  }
  const mkSpec = (cid: "DS5" | "DS6"): CandSpec => {
    const cd = CANDS_ALL[cid], N0 = cd.coreN, wC0 = cd.coreW, satCpsD = cd.sat.map(CP);
    const base = buildDS(cd, {});
    const nbVariants: { label: string; run: () => SimRun }[] = [
      ...[-CS_CORE_W_NEIGHBOR, CS_CORE_W_NEIGHBOR].map((dw) => ({ label: `코어 비중 ${Math.round((wC0 + dw) * 100)}% (위성 ${Math.round((1 - wC0 - dw) * 100)}%)`, run: () => combineCS(base.core, slOf(base.sat.run), wC0 + dw, CS_MOVE_COST).run })),
      ...cd.nNeighbors.map((n) => ({ label: `코어 대상 ${n}종목`, run: () => combineCS(getCoreSl(n, 1), slOf(base.sat.run), wC0, CS_MOVE_COST).run })),
      ...cd.satNb.map((nb) => (nb.kind === "fixedEq"
        ? { label: `위성 ${cd.sat.join(":")} 비중 반반 고정`, run: () => buildDS(cd, { fixedEq: true }).res.run }
        : nb.kind === "cap"
          ? { label: `위성 ${nb.id} 비중 상한 ${Math.round(nb.v * 100)}%`, run: () => buildDS(cd, { cap: { id: nb.id, v: nb.v } }).res.run }
          : { label: `위성 변동성 창 ${nb.w}일`, run: () => buildDS(cd, { win: nb.w }).res.run })),
    ];
    let drawK = 0;
    return {
      id: cid, trial: cd.trial,
      title: `코어 ${Math.round(wC0 * 100)}%(월말 K200P 안 당일 시총 상위 ${N0}종목, 시총 비율, 교체는 순위 밖 ${CS_SWAP_CONFIRM_DAYS}거래일 연속일 때만, 신호 종가·체결 다음 거래일 종가) + 위성 ${Math.round((1 - wC0) * 100)}%(${cd.sat.join("+")}${cd.sat.length > 1 ? ` 변동성 역수 비중, 직전 ${IVA_VOL_WINDOW}거래일` : " 단독"}), 매일 목표 비율로 되돌림(이동 금액의 ${CS_MOVE_COST * 100}%)`,
      defense: false, capFrac: 1 / 10, fDenominator: DS_F_DENOMINATOR, ref: { id: "069500", run: bhAsRun },
      hRule: (full, rb) => {
        const a = hVs(full, rb), refTxt = ([["DS4", DS56_RECORDED.DS4.전체], ["DS2", DS56_RECORDED.DS2.전체], ["CS2", DS56_RECORDED.CS2.전체]] as const).map(([n, r]) => { const sv = { cagr: r[0], mdd: r[1] }, v = hVs(full, sv); return `${n}(연구 기록값) ${f2(sv.cagr)} / ${f2(sv.mdd)} → ${v.ok ? "O" : "X"} (${v.text})`; }).join(" | ");
        return { ok: a.ok, note: `[사전등록: 069500만 판정] 069500 ${f2(rb.cagr)} / ${f2(rb.mdd)} → ${a.ok ? "O" : "X"} (${a.text}) | 참고(판정 아님): ${refTxt}` };
      },
      run: (o) => {
        const repl = !!o.replace, b = buildDS(cd, { lg: lgAll(cd, o.lag), replSat: repl });
        const m = tradeMeta(satCpsD, repl ? 1 : o.lag, repl);
        b.res.run.trades = [...m.trades.map((t) => ({ ...t, vAtEntry: t.vAtEntry / (1 - wC0) })), ...b.coreRun.trades.map((t) => ({ ...t, vAtEntry: t.vAtEntry / wC0 }))];
        b.res.run.entryCs = [...m.entryCs, ...b.coreRun.entryCs]; b.res.run.haltSkip = m.haltSkip + b.coreRun.haltSkip; b.res.run.exitDefer = m.exitDefer + b.coreRun.exitDefer;
        if (o.lag === 1 && o.detail && !repl) baseBuilt.set(cid, b);
        return b.res.run;
      },
      neighbors: nbVariants,
      random: () => {
        const k = drawK++ % KSS_R3_DRAWS;
        const sat = buildAlloc(satCpsD.map((cp) => { const d = randOf(cp)[k]; return { id: cp.id, full: d.full, k0: d.k0, sl: zeroSl }; }), IVA_VOL_WINDOW, null, RATE, cd.cap === null ? undefined : { id: cd.cap.id as CId, v: cd.cap.v });
        return combineCS(base.core, slOf(sat.run), wC0, CS_MOVE_COST).run;
      },
      reasons: [], label,
      extra: (run) => {
        const b = baseBuilt.get(cid)!, al = b.sat, we = warmEnd(al), yrs = (Date.parse(h.dataEnd) - Date.parse(FULL.from)) / 86_400_000 / 365.25, sg = (x: number): string => `${x >= 0 ? "+" : ""}${f2(x)}`;
        console.log(`${cid} 게이트 C 해석(사전등록): 위성 구성요소(${cd.sat.join("·")}) 모두 원래 규칙을 하루 지연(lag 2)한 순수익(변동성 창 이력 포함)과 코어를 체결 2거래일 뒤(lag 2)로 돌려 같은 합성 규칙을 적용했다.`);
        console.log(`${cid} 게이트 D 해석(사전등록): 코어 비중 ±${CS_CORE_W_NEIGHBOR * 100}%p(${Math.round((wC0 - CS_CORE_W_NEIGHBOR) * 100)}%·${Math.round((wC0 + CS_CORE_W_NEIGHBOR) * 100)}%), 코어 종목 수 ${cd.nNeighbors.join("·")}종목(기준 ${N0}종목)${cd.satNb.length ? `, 위성 구성 이웃: ${cd.satNb.map((nb) => (nb.kind === "fixedEq" ? `${cd.sat.join(":")} 비중 반반 고정` : nb.kind === "cap" ? `${nb.id} 비중 상한 ${nb.v * 100}%(초과분은 나머지에 비례)` : `변동성 창 ${nb.w}일`)).join(" · ")}` : ""} 변형, 각 변형은 CAGR ≥ 069500이어야 통과.`);
        console.log(`${cid} 게이트 E 해석(사전등록): 판정은 위성 구성요소(${cd.sat.join("·")}) 각각의 평가 구간 닫힌 거래 중 구성요소 계좌 대비 손익 상위 3개를 069500 수익률로 바꾼 위성과 실제 코어를 합성한 전체 CAGR ≥ 069500. 코어 상위 3개 거래(기간 끝에 열린 보유 포함) 대체와 둘 다 대체는 아래에 보고만 하고 판정하지 않는다.`);
        console.log(`${cid} 게이트 F 해석(사전등록): 위성 구성요소(${cd.sat.join("·")})마다 원래 시험의 무작위 대조(같은 신호일·주문 수, 같은 청산 규칙, 시드 ${KSS_R3_SEED}, ${KSS_R3_DRAWS}회)를 같은 번호끼리 같은 배분 규칙(변동성 역수 비중, 상한 없음)으로 합친 위성 + 실제 코어(고정)를 같은 비율로 합성한 분포 대비 백분위. 코어는 무작위화하지 않는다.`);
        console.log(`${cid} 게이트 G: 진입 건수는 위성 구성요소 진입 건수 + 코어 진입 건수의 합(평가 시작 이후; 위성 ${satCpsD.map((cp) => `${cp.id} ${getRun(cp, 1).entryCs.filter((c) => CAL[c] >= FULL.from).length}`).join(" + ")} + 코어 ${b.coreRun.entryCs.filter((c) => CAL[c] >= FULL.from).length})`);
        console.log(`${cid} 게이트 H 해석(사전등록): 기준선 069500만 판정(기존 H 규칙: CAGR +${PEAD_H_CAGR_GAIN_PP}%p, 또는 MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p). DS4·DS2·CS2(연구 기록값)는 참고 표시.`);
        console.log(`${cid} 위성 워밍업: ${cd.sat.includes("PE4") ? `PE4 이력이 ${IVA_VOL_WINDOW}거래일 미만인 동안 가용 구성요소만 균등 비중(표시). 워밍업 ${we}일(${dates0[0]}~${dates0[Math.max(we - 1, 0)]}), 변동성 역수 비중 시작일 ${we < nDays ? dates0[we] : "없음"}` : `${cd.sat.join("·")}은 평가 시작 전 이력이 충분해 워밍업 ${we}일`}`);
        // E 보고
        {
          const satRep = h.st(buildDS(cd, { replSat: true }).res.run, FULL), coreRep = h.st(buildDS(cd, { replCore: true }).res.run, FULL), bothRep = h.st(buildDS(cd, { replSat: true, replCore: true }).res.run, FULL), full = h.st(run, FULL), bh = h.st(h.bhP, FULL);
          const ct = coreTradesAll(N0).sort((a, c2) => pnlOf(c2) - pnlOf(a)).slice(0, F_E_TOP_TRADES);
          console.log(`${cid} E 보고 [위성 대체만 판정]: 원래 ${f2(full.cagr)} / ${f2(full.mdd)} | 위성 상위 3개 거래 대체 ${f2(satRep.cagr)} / ${f2(satRep.mdd)} (판정, 기준 ${f2(bh.cagr)}) | 코어 상위 3개 거래 대체 ${f2(coreRep.cagr)} / ${f2(coreRep.mdd)} (보고) | 둘 다 대체 ${f2(bothRep.cagr)} / ${f2(bothRep.mdd)} (보고)`);
          console.log(`  위성 대체 거래: ${satCpsD.map((cp) => `${cp.id} [${[...replSet(cp)].map((k) => { const [code, ec] = k.split("|"); const t = getRun(cp, 1).trades.find((x) => x.code === code && x.entryC === Number(ec))!; return `${label(code)} ${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`; }).join(", ")}]`).join(" | ")}`);
          console.log(`  코어 상위 3개 거래(기간 끝에 열린 보유 포함, 코어 계좌 대비 손익 순): ${ct.map((t) => `${label(t.code)} ${CAL[t.entryC]}~${CAL[t.exitC]}${t.reason === "기간 끝 평가" ? "(보유 중)" : ""} 수익률 ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")}`);
        }
        console.log(`${cid} 코어 구성 이력(월말 K200P 안 당일 시총 상위 ${N0}종목; 체결일 종목 교체·비중 조정):\n    ${evLine(b.coreRun)}`);
        // 지연 분해 (진단)
        {
          const ks = ["base", "core", ...cd.sat, "sat", "all", "all2"];
          const lgOf = (k: string): Lg => {
            if (k === "base") return lgAll(cd, 1);
            if (k === "core") return { ...lgAll(cd, 1), core: 2 };
            if (k === "sat") return { core: 1, sat: Object.fromEntries(cd.sat.map((id) => [id, 2])) };
            if (k === "all") return lgAll(cd, 2);
            if (k === "all2") return lgAll(cd, 3);
            return { core: 1, sat: Object.fromEntries(cd.sat.map((id) => [id, id === k ? 2 : 1])) };
          };
          const nm = (k: string): string => (k === "base" ? "기준(지연 없음)" : k === "core" ? "코어만 하루 지연" : k === "sat" ? "위성 전체" : k === "all" ? "전부 (= 게이트 C)" : k === "all2" ? "[참고] 전부 2일 지연" : `위성 ${k}만`);
          const rs = new Map(ks.map((k) => [k, h.st(k === "base" ? run : buildDS(cd, { lg: lgOf(k) }).res.run, FULL)]));
          const b0 = rs.get("base")!;
          console.log(`${cid} 진단 [판정 불사용] 지연 분해 (전체 CAGR / MDD, 변화 %p)\n| 지연 적용 대상 | CAGR | MDD | CAGR 변화 | MDD 변화 |\n|---|---|---|---|---|`);
          for (const k of ks) { const s = rs.get(k)!; console.log(`| ${nm(k)} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${k === "base" ? "-" : sg(s.cagr - b0.cagr)} | ${k === "base" ? "-" : sg(s.mdd - b0.mdd)} |`); }
          const ind = ["core", ...cd.sat].reduce((a, k) => a + (rs.get(k)!.cagr - b0.cagr), 0), indM = ["core", ...cd.sat].reduce((a, k) => a + (rs.get(k)!.mdd - b0.mdd), 0), dAll = rs.get("all")!.cagr - b0.cagr, dAllM = rs.get("all")!.mdd - b0.mdd;
          console.log(`${cid} 지연 분해 상호작용: CAGR 개별 합 ${sg(ind)} vs 전부 ${sg(dAll)} → 어긋남 ${sg(dAll - ind)}%p | MDD 개별 합 ${sg(indM)} vs 전부 ${sg(dAllM)} → 어긋남 ${sg(dAllM - indM)}%p`);
          console.log(`${cid} 지연 분해 구간별 CAGR 변화 %p (전부 하루 지연 / 전부 2일 지연 / 위성 전체 / 코어만)\n| 구간 | 기준 CAGR | 전부 하루 | 전부 2일 | 위성 전체 | 코어만 |\n|---|---|---|---|---|---|`);
          const bs = new Map(ks.map((k) => [k, k === "base" ? run : buildDS(cd, { lg: lgOf(k) }).res.run]));
          for (const [wn, w] of W.ALL) { const c0 = h.st(bs.get("base")!, w).cagr; console.log(`| ${wn} | ${f2(c0)} | ${sg(h.st(bs.get("all")!, w).cagr - c0)} | ${sg(h.st(bs.get("all2")!, w).cagr - c0)} | ${sg(h.st(bs.get("sat")!, w).cagr - c0)} | ${sg(h.st(bs.get("core")!, w).cagr - c0)} |`); }
        }
        // 비용
        {
          const sumCost = b.res.cost.reduce((a, x) => a + x, 0) * 100, sumMv = b.res.moved.reduce((a, x) => a + x, 0) * 100;
          console.log(`${cid} 코어-위성 이동·비용: 이동 금액 합(계좌 대비 %) ${f2(sumMv)} (연 ${f2(sumMv / yrs)}) | 이동이 있었던 날 ${b.res.moved.filter((x) => x > 0).length}/${nDays}일 | 이동 비용 합계 ${f2(sumCost)}%p (연 ${f2(sumCost / yrs)}%p; 이동 금액의 ${CS_MOVE_COST * 100}%) | 위성 내부 이동 연 ${f2(al.moved.reduce((a, x) => a + x, 0) * 100 / yrs)}% · 비용 연 ${f2(al.cost.reduce((a, x) => a + x, 0) * 100 / yrs)}%p (위성 계좌 대비) | 코어·구성요소 내부 거래 비용은 각 계열 순수익에 이미 반영`);
          const sens = h.st(combineCS(b.core, slOf(al.run), wC0, CS_MOVE_COST_SENS).run, FULL), zero = h.st(combineCS(b.core, slOf(al.run), wC0, 0).run, FULL), jf = h.st(run, FULL);
          console.log(`${cid} [정보용, 판정 불사용] 이동 금액의 ${CS_MOVE_COST_SENS * 100}% 적용: ${f2(sens.cagr)} / ${f2(sens.mdd)} | 이동 비용 0: ${f2(zero.cagr)} / ${f2(zero.mdd)} | 판정값(${CS_MOVE_COST * 100}%): ${f2(jf.cagr)} / ${f2(jf.mdd)}`);
          const cs = h.st(b.coreRun, FULL), ss = h.st(al.run, FULL);
          console.log(`${cid} 내부 비용: 코어 연 회전율 ${f2(cs.turnover)}% · 비용 합계 ${f2(cs.cost)}% (코어 계좌 대비) | 위성 연 회전율 ${f2(ss.turnover)}% · 비용 합계 ${f2(ss.cost)}% (위성 계좌 대비)`);
        }
        // 코어 단독, 상관, 투자·현금
        {
          const cSer = { dates: b.core.dates, ret: b.core.ret, inv: b.core.inv }, sSer = { dates: dates0, ret: al.run.ret, inv: al.run.inv };
          console.log(`${cid} 코어 단독 vs 위성 단독 vs 합성 (CAGR % / MDD %) · 일별 수익률 상관 · 평균 투자 비중 %
| 구간 | 코어 단독 | 위성 단독 | ${cid} | 069500 | 코어-위성 일별 상관 | 평균 투자 비중 ${cid} (현금) | 코어 | 위성 |
|---|---|---|---|---|---|---|---|---|`);
          for (const [wn, w] of [...WIN.ALL, ["2026년 제외 (~2025-12-31)", ex26] as [string, Win]]) {
            const idx: number[] = [];
            for (let i = 0; i < nDays; i++) if (inWin(dates0[i], w)) idx.push(i);
            const x = idx.map((i) => b.core.ret[i]), y = idx.map((i) => al.run.ret[i]), mx = avg(x), my = avg(y);
            let sxy = 0, sxx = 0, syy = 0;
            for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
            const a = h.st(cSer, w), s = h.st(sSer, w), t = h.st(run, w), bb = h.st(h.bhP, w), tinv = h.st({ dates: dates0, ret: run.ret, inv: run.inv }, w);
            console.log(`| ${wn} | ${f2(a.cagr)} / ${f2(a.mdd)} | ${f2(s.cagr)} / ${f2(s.mdd)} | ${f2(t.cagr)} / ${f2(t.mdd)} | ${f2(bb.cagr)} / ${f2(bb.mdd)} | ${f2(sxy / Math.sqrt(sxx * syy))} | ${f2(tinv.avgInv)} (${f2(100 - tinv.avgInv)}) | ${f2(a.avgInv)} | ${f2(s.avgInv)} |`);
          }
          console.log(`${cid} 계좌 안 코어 비중(종가, 이동 후) 평균 ${f2(avg(b.res.wCore) * 100)}% | 분위(${IVA_W_QUANTILES.map((p) => Math.round(p * 100)).join("/")}%) ${quant(b.res.wCore, IVA_W_QUANTILES)} | 위성 안 구성요소별 비중(종가) 평균: ${satCpsD.map((cp, j) => `${cp.id} ${f2(avg(al.wAcct[j]) * 100)}%`).join(" / ")}`);
        }
        // 낙폭·하락 구간
        console.log(`${cid} 낙폭 상위 3개 구간 (고점 → 저점 → 회복)`);
        const topEp = (ser: { dates: string[]; ret: number[] }, name: string): void => {
          const dts = ser.dates, eps = episodes(ser.ret).sort((a, c2) => c2.depth - a.depth).slice(0, 3);
          console.log(`  ${name}: ${eps.map((e, kk) => `${kk + 1}) 고점 ${e.peakIdx < 0 ? FULL.from : dts[e.peakIdx]} → 저점 ${dts[e.troughIdx]} ${f2(e.depth * 100)}% → 회복 ${e.recIdx === null ? "미회복" : dts[e.recIdx]}`).join(" | ")}`);
        };
        topEp(run, cid); topEp(coreSerOf(N0), `코어 단독(N=${N0})`); topEp(bhFrom, "069500(새)");
        console.log(`${cid} 하락 구간 성과 (누적 % / MDD %): ${cid} | 코어 | 위성 단독 | 069500`);
        for (const [name, f, t] of PEAD_DOWNTURNS) console.log(`  ${name}: ${cid} ${h.periodStat(run, f, t)} | 코어 ${h.periodStat(coreSerOf(N0), f, t)} | 위성 단독 ${h.periodStat(al.run, f, t)} | 069500 ${h.periodStat(bhFrom, f, t)}`);
        // 위험 일치, 두 종목 뺀 K200P
        console.log(`${cid} 진단 [판정 불사용] 위험 일치 기준선 대비 CAGR 차이 (%p; 기준선 = 일수익률 × k + 현금, MDD 일치 / 변동성 일치)
| 구간 | ${cid} CAGR / MDD / 변동성 | 069500 MDD 일치 k | 기준선 CAGR | 차이 | 069500 변동성 일치 k | 기준선 CAGR | 차이 | K200P ex-두 종목 CAGR / MDD | ${cid} − K200P ex | K200P ex MDD 일치 k | 기준선 CAGR | 차이 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
        for (const [wn, w] of RMD_WINDOWS_2017) {
          const idx: number[] = [];
          for (let i = 0; i < nDays; i++) if (inWin(dates0[i], w)) idx.push(i);
          const s = idx.map((i) => run.ret[i]), bb = idx.map((i) => bRetAxis[i]), kx = idx.map((i) => idxEx[i]);
          const c = cagrOfR(s, w), m = mddOfR(s), v = volAnn(s), k1 = kForMdd(bb, m), k2 = Math.min(1, v / volAnn(bb)), c1 = cagrOfR(bb.map((x) => x * k1), w), c2 = cagrOfR(bb.map((x) => x * k2), w);
          const ck = cagrOfR(kx, w), mk = mddOfR(kx), k3 = kForMdd(kx, m), c3 = cagrOfR(kx.map((x) => x * k3), w);
          console.log(`| ${wn} | ${f2(c)} / ${f2(m)} / ${f2(v)} | ${k1.toFixed(3)}${k1 >= 1 ? " (상한)" : ""} | ${f2(c1)} | ${sg(c - c1)} | ${k2.toFixed(3)}${k2 >= 1 ? " (상한)" : ""} | ${f2(c2)} | ${sg(c - c2)} | ${f2(ck)} / ${f2(mk)} | ${sg(c - ck)} | ${k3.toFixed(3)}${k3 >= 1 ? " (상한)" : ""} | ${f2(c3)} | ${sg(c - c3)} |`);
        }
        {
          const x = bRetAxis.map((r) => r / 100), xk = idxEx.map((r) => r / 100), y = run.ret.map((r) => r / 100), dn: number[] = [], up: number[] = [];
          x.forEach((r, i) => { if (r <= RMD_DOWN_DAY) dn.push(i); if (r >= -RMD_DOWN_DAY) up.push(i); });
          const a = olsR(x, y), ak = olsR(xk, y), cap2 = (idx: number[]): number => idx.reduce((s, i) => s + y[i], 0) / idx.reduce((s, i) => s + x[i], 0);
          console.log(`${cid} 진단 일별 회귀(전체 ${nDays}일): 069500 대비 β ${f2(a.beta)}, α ${f2(a.alphaAnn * 100)}%p(연환산), R² ${f2(a.r2)} | K200P ex-두 종목 대비 β ${f2(ak.beta)}, α ${f2(ak.alphaAnn * 100)}%p, R² ${f2(ak.r2)} | 하락일(069500 ≤ ${RMD_DOWN_DAY * 100}%) ${dn.length}일 하락 포착률 ${f2(cap2(dn))} | 상승일 ${up.length}일 상승 포착률 ${f2(cap2(up))}`);
        }
        // 삼성전자·SK하이닉스 평균 계좌 비중
        {
          const ch = coreHolds(N0), wsum = new Map<string, number>();
          let invested = 0;
          for (let i = 0; i < nDays; i++) {
            const wc = b.res.wCore[i], ws = 1 - wc;
            for (const [code, f] of ch[i]) { wsum.set(code, (wsum.get(code) ?? 0) + wc * f); invested += wc * f; }
            satCpsD.forEach((cp, j) => { for (const [code, f] of holdOf(cp)[i]) { const ww = ws * al.wAcct[j][i] * f; wsum.set(code, (wsum.get(code) ?? 0) + ww); invested += ww; } });
          }
          const wavg = (code: string): number => ((wsum.get(code) ?? 0) / nDays) * 100;
          const coreOnly = (code: string): number => (ch.reduce((a, d) => a + (d.find(([cd2]) => cd2 === code)?.[1] ?? 0), 0) / nDays) * 100;
          console.log(`${cid} 일별 평균 계좌 비중(현금 날 포함; ${nDays}일): 삼성전자 ${f2(wavg(SAMSUNG))}% · SK하이닉스 ${f2(wavg(HYNIX))}% · 합 ${f2(wavg(SAMSUNG) + wavg(HYNIX))}% | 투자분 중 두 종목 ${f2(((wsum.get(SAMSUNG) ?? 0) + (wsum.get(HYNIX) ?? 0)) / Math.max(invested, 1e-12) * 100)}% | 코어 계좌 안 평균 삼성전자 ${f2(coreOnly(SAMSUNG))}% · SK하이닉스 ${f2(coreOnly(HYNIX))}%`);
          console.log(`${cid} 계좌 합산 평균 비중 상위 8개 종목: ${[...wsum].sort((a, c2) => c2[1] - a[1]).slice(0, 8).map(([code, v]) => `${label(code)} ${f2((v / nDays) * 100)}%`).join(" | ")}`);
        }
        // ---- 진단 1: 연도별 초과수익 ----
        {
          const years: number[] = [];
          for (let y = Number(FULL.from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) years.push(y);
          const d4s = { dates: run.dates, ret: run.ret }, b0 = { dates: bhFrom.dates, ret: bhFrom.ret };
          console.log(`${cid} 진단 [판정 불사용] 연도별 ${cid} − 069500 초과수익 (연도별 일수익률 복리 %, ${years[0]}년은 ${FULL.from}부터·${years[years.length - 1]}년은 ${h.dataEnd}까지의 부분 연도)\n| 연도 | ${cid} | 069500 | 초과 %p | 승·패 |\n|---|---|---|---|---|`);
          const ex: { y: number; e: number }[] = [];
          for (const y of years) {
            const a1 = h.yearRet(d4s, y), b1 = h.yearRet(b0, y), e = a1 - b1;
            ex.push({ y, e });
            console.log(`| ${y}${y === years[0] || y === years[years.length - 1] ? " (부분)" : ""} | ${f2(a1)} | ${f2(b1)} | ${sg(e)} | ${e > 0 ? "승" : e < 0 ? "패" : "무"} |`);
          }
          const cnt = (list: { y: number; e: number }[]): string => `승 ${list.filter((x) => x.e > 0).length} / 패 ${list.filter((x) => x.e < 0).length} / 무 ${list.filter((x) => x.e === 0).length} (평균 초과 ${sg(avg(list.map((x) => x.e)))}%p, 중앙값 ${sg(median(list.map((x) => x.e)))}%p)`;
          console.log(`${cid} 승·패 연수: 전체 ${ex.length}개 연도(부분 연도 포함) ${cnt(ex)} | 온전한 연도(${years[1]}~${years[years.length - 2]}) ${cnt(ex.slice(1, -1))} | 2026 제외(${years[0]}~${years[years.length - 2]}) ${cnt(ex.slice(0, -1))}`);
        }
        // ---- 진단 2: 코어에서 삼성전자·SK하이닉스를 뺀 경우 ----
        {
          const EXC = new Set<string>([SAMSUNG, HYNIX]);
          const coreXRun = simCore(N0, { lag: 1, exclude: EXC }), coreXSl = slice(coreXRun);
          const xRes = combineCS(coreXSl, slOf(al.run), wC0, CS_MOVE_COST), runX = xRes.run;
          const arrX: [string, number][][] = new Array(nDays).fill(null).map(() => []);
          simCore(N0, { lag: 1, exclude: EXC, onDay: (c, V, held) => { const i = dateIdx.get(CAL[c]); if (i !== undefined) arrX[i] = held.map(([code, v]) => [code, v / V]); } });
          console.log(`${cid} 진단 [판정 불사용] 코어 제외판 ${cid}-X (코어 순위 목록에서 삼성전자·SK하이닉스만 제외, 나머지 규칙·위성·합성은 같음; 새 후보 아님) — 코어 구성 이력(처음 편입 포함 이벤트 ${coreXRun.events.length}회, 종목 교체 ${coreXRun.events.filter((e) => e.sells.length).length}회)`);
          console.log(`| 구간 | 069500 | ${cid} | ${cid}-X | 코어-X 단독 | 코어 단독 | 위성 단독 |\n|---|---|---|---|---|---|---|`);
          for (const [wn, w] of [...WIN.ALL, ["2026년 제외 (~2025-12-31)", ex26] as [string, Win]]) {
            const c1 = (r: { dates: string[]; ret: number[] }): string => { const sv = h.st(r, w); return `${f2(sv.cagr)} / ${f2(sv.mdd)}`; };
            console.log(`| ${wn} | ${c1(h.bhP)} | ${c1(run)} | ${c1(runX)} | ${c1({ dates: coreXSl.dates, ret: coreXSl.ret })} | ${c1({ dates: b.core.dates, ret: b.core.ret })} | ${c1(al.run)} |`);
          }
          const wsum = new Map<string, number>();
          for (let i = 0; i < nDays; i++) {
            const wc = xRes.wCore[i], ws = 1 - wc;
            for (const [code, f] of arrX[i]) wsum.set(code, (wsum.get(code) ?? 0) + wc * f);
            satCpsD.forEach((cp, j) => { for (const [code, f] of holdOf(cp)[i]) wsum.set(code, (wsum.get(code) ?? 0) + ws * al.wAcct[j][i] * f); });
          }
          const wavgX = (code: string): number => ((wsum.get(code) ?? 0) / nDays) * 100;
          const sx = h.st(runX, FULL), sd0 = h.st(run, FULL), sb = h.st(h.bhP, FULL);
          console.log(`${cid}-X 전체 ${f2(sx.cagr)} / ${f2(sx.mdd)} (069500 대비 CAGR ${sg(sx.cagr - sb.cagr)}%p, MDD ${sg(sx.mdd - sb.mdd)}%p; ${cid} 대비 CAGR ${sg(sx.cagr - sd0.cagr)}%p, MDD ${sg(sx.mdd - sd0.mdd)}%p) | ${cid}-X 일별 평균 계좌 비중(위성 안 보유분만): 삼성전자 ${f2(wavgX(SAMSUNG))}% · SK하이닉스 ${f2(wavgX(HYNIX))}% · 합 ${f2(wavgX(SAMSUNG) + wavgX(HYNIX))}%`);
          console.log(`${cid}-X 연도별 수익률 %: ${[2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026].map((y) => `${y} ${f2(h.yearRet({ dates: runX.dates, ret: runX.ret }, y))}`).join(" | ")}`);
        }
        // ---- 진단 3: 구성요소별 기여 (전일 종가 비중 × (구성요소 일수익률 − 069500 일수익률)의 구간 합, 산술 %p) ----
        {
          const compS = satCpsD.map((cp) => getSl(cp, 1)), rTot = run.ret, rB = bRetAxis, rCore = b.core.ret;
          const names = ["코어", ...cd.sat.map((id) => `위성 ${id}`)];
          const wcPrev = (i: number): number => (i === 0 ? wC0 : b.res.wCore[i - 1]);
          const wPrevOf = (k: number, i: number): number => (i === 0 ? 0 : k === 0 ? wcPrev(i) : (1 - wcPrev(i)) * al.wAcct[k - 1][i - 1]);
          const rOf = (k: number, i: number): number => (k === 0 ? rCore[i] : compS[k - 1].ret[i]);
          console.log(`${cid} 진단 [판정 불사용] 구성요소별 초과 기여 %p (${cid} − 069500 산술 합 = 구성요소별 합 + 잔여[이동·내부 비용, 첫 거래일은 귀속하지 않음])\n| 구간 | ${cid} − 069500 산술 합 | ${names.map((n2) => `${n2} %p`).join(" | ")} | 잔여 %p | 복리 CAGR 차이 %p | 코어 평균 비중 % | ${cd.sat.map((id) => `${id} 평균 비중 %`).join(" | ")} |\n|---|---|${names.map(() => "---").join("|")}|---|---|---|${cd.sat.map(() => "---").join("|")}|`);
          for (const [wn, w] of WIN.ALL) {
            const idx: number[] = [];
            for (let i = 0; i < nDays; i++) if (inWin(dates0[i], w)) idx.push(i);
            const tot = idx.reduce((a, i) => a + (rTot[i] - rB[i]), 0), parts = names.map((_, k) => idx.reduce((a, i) => a + wPrevOf(k, i) * (rOf(k, i) - rB[i]), 0));
            const dc = cagrOfR(idx.map((i) => rTot[i]), w) - cagrOfR(idx.map((i) => rB[i]), w);
            console.log(`| ${wn} | ${sg(tot)} | ${parts.map(sg).join(" | ")} | ${sg(tot - parts.reduce((a, x) => a + x, 0))} | ${sg(dc)} | ${f2(avg(idx.map((i) => wPrevOf(0, i))) * 100)} | ${cd.sat.map((_, j) => f2(avg(idx.map((i) => wPrevOf(j + 1, i))) * 100)).join(" | ")} |`);
          }
          console.log(`${cid} 구성요소 단독 성적 (CAGR % / MDD %): ${WIN.ALL.map(([wn, w]) => `${wn} — 코어 ${(() => { const sv = h.st({ dates: b.core.dates, ret: b.core.ret }, w); return `${f2(sv.cagr)} / ${f2(sv.mdd)}`; })()}, ${cd.sat.map((id, j) => `${id} ${(() => { const sv = h.st({ dates: compS[j].dates, ret: compS[j].ret }, w); return `${f2(sv.cagr)} / ${f2(sv.mdd)}`; })()}`).join(", ")}`).join(" | ")}`);
        }
        void median; void pct;
      },
    };
  };

  const specs: CandSpec[] = [], verdicts: Verdict[] = [];
  for (const cid of ["DS5", "DS6"] as const) { const sp = mkSpec(cid); specs.push(sp); verdicts.push(evaluate(h, W, sp)); }

  // ---- 공통 보고 ----
  const coreN2 = coreSerOf(2);
  const winKeys = ["학습", "확인", "보류", "전체"] as const;
  const recCell = (r: readonly [number, number]): string => `${f2(r[0])} / ${f2(r[1])}`;
  console.log(`
=== 구간별 CAGR / MDD — 069500(새 기준선) · CS2·DS2·DS4(연구 기록값, 재계산 없음) · 코어 단독 N=2 · 후보 ===
| 구간 | 069500 | CS2 (기록) | DS2 (기록) | DS4 (기록) | 코어 N=2 | ${verdicts.map((v) => v.id).join(" | ")} |
|---|---|---|---|---|---|${verdicts.map(() => "---").join("|")}|`);
  for (const [k, [wn, w]] of ([...W.ALL, ["2026년 제외 (~2025-12-31)", ex26] as [string, Win]]).entries()) {
    const cell = (r: { dates: string[]; ret: number[] }): string => { const sv = h.st(r, w); return `${f2(sv.cagr)} / ${f2(sv.mdd)}`; };
    const key = k < 4 ? winKeys[k] : "ex26";
    console.log(`| ${wn} | ${cell(h.bhP)} | ${recCell(DS56_RECORDED.CS2[key])} | ${recCell(DS56_RECORDED.DS2[key])} | ${recCell(DS56_RECORDED.DS4[key])} | ${cell(coreN2)} | ${verdicts.map((v) => cell(v.run)).join(" | ")} |`);
  }
  console.log(`
구간별 최악 12개월 %: ${W.ALL.map(([wn, w]) => `${wn} — 069500 ${f2(h.worst12(h.bhP, w))}, ${verdicts.map((v) => `${v.id} ${f2(h.worst12(v.run, w))}`).join(", ")}`).join(" | ")}`);
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: DS56_PRIOR_TESTS });
  yearlyTable(h, W, [{ id: "코어 단독 N=2", run: coreN2 as unknown as SimRun }, ...verdicts.map((v) => ({ id: v.id, run: v.run }))]);
  console.log(`연도별 연구 기록값(재계산 없음) %: 2017~2026 순서\n| DS4 (기록) | ${DS56_RECORDED.yearly.DS4.map(f2).join(" | ")} |\n| CS2 (기록) | ${DS56_RECORDED.yearly.CS2.map(f2).join(" | ")} |`);
  console.log(`
=== 실행 지표 ===
Supabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ") || "없음"} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 공시 부분집합 캐시 읽기 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${verdicts.map((v) => v.trial).join(", ")}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

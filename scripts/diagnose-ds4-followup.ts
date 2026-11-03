/**
 * [임시 연구 진단 — 시험 아님, 시험 번호 269 유지, 병합 금지, 읽기 전용, 외부 요청 0건] DS4 후속 진단. 문서: docs/research/ds4-followup-diagnostic.md.
 * DS4 정의(커밋 2b72658, 코어 40% 시총 상위 2종목 + PE4 20% 상한 위성)는 바꾸지 않는다. ① 연도별 DS4 − 069500 초과수익과 승·패 연수, ② 코어를 삼성전자·SK하이닉스 제외 시총 상위 2종목으로 바꾼 진단,
 * ③ 위성 단독(코어 0%)과 코어 단독(코어 100%) 성적, ④ 학습 구간 DS4 − 069500 초과수익의 구성요소별 분해를 같은 캐시에서 계산한다. 게이트·통과 판정에 쓰지 않는다.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { simSlots, type SimCand, type SimPos, type SimRun, type SimTrade, type SimVt } from "@/lib/slotSim";
import { decodeTable } from "@/lib/nBookStore";
import { eventsByCorp, type FinRow, type FilingRow } from "@/lib/rFinMetrics";
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
import { DS4_FIXED_REF, DS4_FREEZE_DATE, DS4_EXCLUDE_CORE } from "@/lib/ds4ForwardConfig";
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
  console.log(`DS4 후속 진단(시험 아님, 시험 번호 269 유지) 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  const subDir = process.env.RESEARCH_SUBSET_DIR?.trim();
  if (!subDir) throw new Error("PE4 입력 부분집합 폴더(RESEARCH_SUBSET_DIR)가 없다 — Storage에서 다시 읽지 않는다");
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

  // ================= PE4 =================
  {
    const cd = PEAD_SHORT_CANDS.PE4, HOLD_REASON = "보유 만료";
    const cS = cPE;
    for (const [f, want] of Object.entries(PEAD_PRELIM_STUDY.subsetSha256)) {
      const got = sha(await fs.readFile(path.join(subDir, f)));
      if (got !== want) throw new Error(`PE4 입력 부분집합 ${f} SHA-256 불일치: ${got}`);
    }
    const ab = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    const finRows = (await decodeTable(ab(await fs.readFile(path.join(subDir, "fin_sub.parquet"))))) as unknown as FinRow[];
    const filRows = (await decodeTable(ab(await fs.readFile(path.join(subDir, "filings_sub.parquet"))))) as unknown as FilingRow[];
    console.log(`PE4 입력: 부분집합 SHA-256 대조 통과 | fin ${finRows.length}행, filings ${filRows.length}행 (Storage 읽기 0)`);
    const stockOfCorp = new Map<string, string>();
    for (const r of finRows) if (r.stock_code) stockOfCorp.set(r.corp_code, r.stock_code);
    const evOrig = eventsByCorp(finRows, filRows);
    const lowerBound = (d: string): number => { let lo = 0, hi = nCal; while (lo < hi) { const m = (lo + hi) >> 1; if (CAL[m] < d) lo = m + 1; else hi = m; } return lo; };
    const closeAtOrBefore = (s: S, c: number): number => { for (let k = c; k >= Math.max(c - 5, 0); k--) { const i = s.idx.get(CAL[k]); if (i !== undefined) return s.close[i]; } return NaN; };
    interface Ev { code: string; sig: number; qOi: number; qOiPrev: number; growth: number; up: boolean }
    const evK = new Map<number, Ev[]>();
    const kSet = new Map<number, Set<string>>();
    const inK = (c: number, code: string): boolean => { let v = kSet.get(c); if (!v) { v = new Set(kAt(CAL[c]).map((s) => s.code)); kSet.set(c, v); } return v.has(code); };
    let nEv = 0;
    for (const [corp, list] of evOrig) {
      const code = stockOfCorp.get(corp), s = code ? byCode.get(code) : undefined;
      if (!s) continue;
      for (const e of list) {
        if (e.qOi === null || e.qOiPrev === null) continue;
        const r0 = lowerBound(e.rceptDt), sig = r0 + 1;
        if (sig >= nCal - 1 || sig < cS) continue;
        nEv++;
        if (!inK(sig, s.code)) continue;
        const l = evK.get(sig) ?? [];
        l.push({ code: s.code, sig, qOi: e.qOi, qOiPrev: e.qOiPrev, growth: e.qOiPrev > 0 ? e.qOi / e.qOiPrev - 1 : NaN, up: closeAtOrBefore(s, sig) > closeAtOrBefore(s, r0) });
        evK.set(sig, l);
      }
    }
    console.log(`PE4 이벤트: 분기 영업이익·전년 동기 값이 있는 원본 접수 이벤트(신호 확정일 ${PEAD_RUN_START} 이후) ${nEv}건 | K200P 안 ${[...evK.values()].reduce((a, l) => a + l.length, 0)}건`);
    const cfg = { slip: PEAD_SLIPPAGE.K200P, maxPos: PEAD_MAX_POS, capFrac: 1 / PEAD_MAX_POS, cooldown: PEAD_COOLDOWN_DAYS };
    const hooks = {
      candsOf: (c: number): SimCand[] => {
        const l = evK.get(c);
        if (!l) return [];
        return l.filter((e) => e.qOi > 0 && e.qOiPrev > 0 && e.growth >= cd.growth - 1e-12 && e.up).sort((a, b) => b.growth - a.growth || (a.code < b.code ? -1 : 1)).map((e) => ({ s: byCode.get(e.code)!, code: e.code }));
      },
      exitReason: (p: SimPos, c: number): string | null => (c - p.entryC >= cd.hold ? HOLD_REASON : null),
    };
    comps.push({
      id: "PE4", label,
      run: (o) => simSlots(env(cS), cfg, hooks, { lag: o.lag, replace: o.replace, detail: o.detail, onDay: o.onDay }),
      random: (rng, ob) => simSlots(env(cS), cfg, {
        candsOf: (c, held, blocked) => {
          const n = ob.get(c) ?? 0;
          if (!n) return [];
          const pool = (evK.get(c) ?? []).filter((e) => e.up && !held(e.code) && !blocked(e.code)), out: SimCand[] = [];
          while (out.length < n && pool.length) { const e = pool.splice(Math.floor(rng() * pool.length), 1)[0]; out.push({ s: byCode.get(e.code)!, code: e.code }); }
          return out;
        },
        exitReason: hooks.exitReason,
      }, { lag: 1 }),
    });
  }

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
  const dates0 = baseSl.get("PE4")!.dates;
  for (const [id, s] of baseSl) if (s.dates.length !== dates0.length || s.dates.some((d, k) => d !== dates0[k])) throw new Error(`${id} 날짜가 PE4와 다르다`);
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

  // ---- 연구 ALLOC P2 재계산(재현 확인과 비교 열) ----
  const combineP = (parts: { sl: Sl; w: number }[], rate: number): SimRun => {
    const k = parts.length, s = parts.map((p) => p.w), pending = parts.map(() => 0), ret: number[] = [];
    for (let i = 0; i < nDays; i++) {
      const Vprev = s.reduce((a, x) => a + x, 0);
      for (let j = 0; j < k; j++) s[j] *= 1 + parts[j].sl.ret[i] / 100;
      let mv = 0;
      if (pending.some((x) => x !== 0)) {
        for (let j = 0; j < k; j++) { s[j] += pending[j]; if (pending[j] > 0) mv += pending[j]; }
        const cs = rate * mv;
        if (mv > 0) for (let j = 0; j < k; j++) if (pending[j] > 0) s[j] -= (cs * pending[j]) / mv;
      }
      const V = s.reduce((a, x) => a + x, 0);
      ret.push((V / Vprev - 1) * 100);
      for (let j = 0; j < k; j++) pending[j] = parts[j].w * V - s[j];
    }
    return { dates: dates0, ret } as unknown as SimRun;
  };
  const p2Run = combineP(comps.map((cp) => ({ sl: baseSl.get(cp.id)!, w: 0.25 })), ALLOC_REBAL_COST);
  {
    const s = h.st(p2Run, FULL), ok = f2(s.cagr) === f2(IVA_P2_REF.cagr) && f2(s.mdd) === f2(IVA_P2_REF.mdd);
    console.log(`P2(연구 ALLOC, 4개 균등·매일 재배분·이동 금액의 0.25%) 재계산: ${f2(s.cagr)} / ${f2(s.mdd)} (기록 ${IVA_P2_REF.cagr.toFixed(2)} / ${IVA_P2_REF.mdd.toFixed(2)}) → ${ok ? "일치" : "불일치"}`);
    if (!ok) throw new Error("P2 재계산이 연구 ALLOC 기록과 다르다 — 중단");
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
  const buildAlloc = (cds: CD[], win: number, target: number | null, rate: number = RATE, cap?: { id: CId; v: number }): Out => {
    const k = cds.length, sd = cds.map((c) => rollStd(c.full, win));
    /** 종가 i 기준 목표 비중: 모든 구성요소에 직전 win일 이력이 있으면 표준편차 역수 비례, 아니면 이력이 있는 구성요소만 균등(워밍업). */
    const weightsAt = (i: number): { w: number[]; warm: boolean } => {
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

  // ---- 기준 계열: R1(4개 구성요소), R3(위성) ----
  const slOf = (r: SimRun): Sl => ({ dates: r.dates, ret: r.ret, costFrac: r.costFrac, nPos: r.nPos, inv: r.inv, turn: r.turn.map((x) => x.v), wMax: r.wMax });
  const satCps = CS_SAT_COMPS.map((id) => compOf.get(id as CId)!);
  const r1Out = buildAlloc(comps.map((cp) => cdOf(cp, 1)), IVA_VOL_WINDOW, null);
  const r3Out = buildAlloc(satCps.map((cp) => cdOf(cp, 1)), IVA_VOL_WINDOW, null);
  console.log(`\n=== 1b. 위성·기준 계열 재현 (변동성 역수 배분, 직전 ${IVA_VOL_WINDOW}거래일, 이동 금액의 ${IVA_MOVE_COST * 100}%; 평가 구간 전체 CAGR % / MDD %) ===\n| 대상 | 이번 | 연구 IVA 기록 | 일치 |\n|---|---|---|---|`);
  {
    const mism3: string[] = [];
    for (const [id, out, ref] of [["R1 (PE4+W3+LV1+L3)", r1Out, CS_R1_REF], ["R3 (PE4+W3+LV1) = 위성", r3Out, CS_R3_REF]] as const) {
      const s = h.st(out.run, FULL), ok = f2(s.cagr) === f2(ref.cagr) && f2(s.mdd) === f2(ref.mdd);
      if (!ok) mism3.push(id);
      console.log(`| ${id} | ${f2(s.cagr)} / ${f2(s.mdd)} | ${ref.cagr.toFixed(2)} / ${ref.mdd.toFixed(2)} | ${ok ? "일치" : "불일치"} |`);
    }
    if (mism3.length) throw new Error(`R1·R3 재현 불일치(${mism3.join(", ")}) — 중단하고 보고한다`);
  }
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


  // ---- 연구 CS 후보(CS1·CS2)와 위성 R3 기준 계열 (참고 표시·재현용; 새 후보 아님) ----
  const coreSl2 = getCoreSl(2, 1);
  const cs1Run = combineCS(coreSl2, slOf(r3Out.run), CS_CANDS.CS1.coreW, CS_MOVE_COST).run, cs2Run = combineCS(coreSl2, slOf(r3Out.run), CS_CANDS.CS2.coreW, CS_MOVE_COST).run;
  console.log(`\n=== 1d. 연구 CS 후보 재현 (평가 구간 전체 CAGR % / MDD %; 소수 둘째 자리까지 같아야 한다) ===\n| 대상 | 이번 | 연구 CS·IVA 기록 | 일치 |\n|---|---|---|---|`);
  {
    const mism5: string[] = [];
    for (const [id, run, ref] of [["CS1", cs1Run, DS_REF.CS1], ["CS2", cs2Run, DS_REF.CS2], ["R3", r3Out.run, DS_REF.R3]] as const) {
      const s = h.st(run, FULL), ok = f2(s.cagr) === f2(ref.cagr) && f2(s.mdd) === f2(ref.mdd);
      if (!ok) mism5.push(id);
      console.log(`| ${id} | ${f2(s.cagr)} / ${f2(s.mdd)} | ${ref.cagr.toFixed(2)} / ${ref.mdd.toFixed(2)} | ${ok ? "일치" : "불일치"} |`);
    }
    if (mism5.length) throw new Error(`CS1·CS2·R3 재현 불일치(${mism5.join(", ")}) — 중단하고 보고한다`);
  }

  // ---- 위성 비중 구조·상한 자체 점검 (성과 아님) ----
  const CP = (id: string): Comp => compOf.get(id as CId)!;
  interface DSDef { readonly trial: number; readonly coreW: number; readonly coreN: number; readonly sat: readonly string[]; readonly pe4Cap: number | null; readonly nNeighbors: readonly number[]; readonly capNeighbors: readonly number[] }
  const CANDS_ALL: Record<string, DSDef> = { DS2: DS_CANDS.DS2, DS3: DS_CANDS.DS3, DS4: DS4_CAND };
  const buildSat = (ids: readonly string[], lagFor: (id: string) => number, capV: number | null, repl = false): Out =>
    buildAlloc(ids.map((id) => (repl ? cdOf(CP(id), 1, replSet(CP(id))) : cdOf(CP(id), lagFor(id)))), IVA_VOL_WINDOW, null, RATE, capV === null ? undefined : { id: "PE4" as CId, v: capV });
  console.log(`\n=== 1e. 위성 비중 구조 자체 점검 (성과 아님: 목표 비중과 상한 규칙만 확인) ===`);
  {
    const t1 = capRedistribute([0.5, 0.3, 0.2], 0, 0.2), t2 = capRedistribute([0.1, 0.5, 0.4], 0, 0.2);
    const okT = Math.abs(t1[0] - 0.2) < 1e-12 && Math.abs(t1[1] - 0.48) < 1e-12 && Math.abs(t1[2] - 0.32) < 1e-12 && Math.abs(t1.reduce((a, x) => a + x, 0) - 1) < 1e-12 && t2[0] === 0.1 && t2[1] === 0.5;
    console.log(`  상한 규칙 합성 점검: [0.5,0.3,0.2] 상한 0.2(첫째) → [${t1.map((x) => x.toFixed(2)).join(", ")}] (기대 [0.20, 0.48, 0.32]), 상한 미만은 그대로 [${t2.map((x) => x.toFixed(2)).join(", ")}] ${okT ? "통과" : "불일치"}`);
    if (!okT) throw new Error("상한 규칙 합성 점검 실패 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)");
    for (const [cid, cdv] of Object.entries(CANDS_ALL)) {
      const o = buildSat(cdv.sat, () => 1, cdv.pe4Cap), we = warmEnd(o);
      const post = o.wTgt.map((row) => row.slice(we));
      const sumDev = Math.max(...o.wTgt[0].map((_, i) => Math.abs(o.wTgt.reduce((a, row) => a + row[i], 0) - 1)));
      const j4 = cdv.sat.indexOf("PE4"), maxPe = j4 >= 0 ? Math.max(...post[j4]) : NaN, nCap = j4 >= 0 ? post[j4].filter((x) => cdv.pe4Cap !== null && Math.abs(x - cdv.pe4Cap) < 1e-12).length : 0;
      const raw = j4 >= 0 ? buildSat(cdv.sat, () => 1, null) : null, rawPe = raw ? raw.wTgt[j4].slice(warmEnd(raw)) : [];
      console.log(`  ${cid} 위성 ${cdv.sat.join("+")}${cdv.pe4Cap === null ? "" : ` (PE4 상한 ${cdv.pe4Cap * 100}%)`}: 워밍업 ${we}일 | 목표 비중 합 최대 편차 ${sumDev.toExponential(2)} | 워밍업 이후 평균 목표 비중 ${cdv.sat.map((id, j) => `${id} ${f2(avg(post[j]) * 100)}%`).join(" / ")}${j4 >= 0 ? ` | PE4 목표 최대 ${f2(maxPe * 100)}% (상한 ${(cdv.pe4Cap ?? 0) * 100}%), 상한에 걸린 날 ${nCap}/${post[j4].length}일, 상한 전 PE4 평균 ${f2(avg(rawPe) * 100)}%` : ""}`);
      if (sumDev > 1e-9 || (j4 >= 0 && cdv.pe4Cap !== null && maxPe > cdv.pe4Cap + 1e-12)) throw new Error(`${cid} 위성 목표 비중 점검 실패 — 중단하고 보고한다`);
    }
  }
  // ---- 후보 ----
  const WIN = W;
  const p2Ser = p2Run as unknown as { dates: string[]; ret: number[] };
  const r3Ser = r3Out.run as unknown as { dates: string[]; ret: number[] }, cs1Ser = cs1Run as unknown as { dates: string[]; ret: number[] }, cs2Ser = cs2Run as unknown as { dates: string[]; ret: number[] };
  const coreSerOf = (N: number): { dates: string[]; ret: number[] } => { const s = getCoreSl(N, 1); return { dates: s.dates, ret: s.ret }; };
  interface Lg { core: number; sat: Record<string, number> }
  const lgAll = (cd: DSDef, n: number): Lg => ({ core: n, sat: Object.fromEntries(cd.sat.map((id) => [id, n])) });
  interface BuiltDS { sat: Out; coreRun: CoreRun; core: Sl; res: CombOut }
  const buildDS = (cd: DSDef, o: { lg?: Lg; N?: number; wC?: number; capV?: number | null; replSat?: boolean; replCore?: boolean }): BuiltDS => {
    const N = o.N ?? cd.coreN, wC = o.wC ?? cd.coreW, lg = o.lg ?? lgAll(cd, 1), capV = o.capV === undefined ? cd.pe4Cap : o.capV;
    const sat = buildSat(cd.sat, (id) => lg.sat[id], capV, !!o.replSat);
    const rc = o.replCore ? coreReplSet(N) : undefined, lgc = o.replCore ? 1 : lg.core;
    const coreRun = getCore(N, lgc, rc), core = getCoreSl(N, lgc, rc);
    return { sat, coreRun, core, res: combineCS(core, slOf(sat.run), wC, CS_MOVE_COST) };
  };
  const baseBuilt = new Map<string, BuiltDS>();
  const ds2Run = buildDS(CANDS_ALL.DS2, {}).res.run, ds3Run = buildDS(CANDS_ALL.DS3, {}).res.run;
  const ds2Ser = ds2Run as unknown as { dates: string[]; ret: number[] }, ds3Ser = ds3Run as unknown as { dates: string[]; ret: number[] };
  console.log(`\n=== 1f. 연구 DS 참고 계열 재현 (평가 구간 전체 CAGR % / MDD %; 소수 둘째 자리까지 같아야 한다) ===\n| 대상 | 이번 | 연구 DS 기록 | 일치 |\n|---|---|---|---|`);
  {
    const mism6: string[] = [];
    for (const [id, run, ref] of [["DS2", ds2Run, DS4_REF.DS2], ["DS3", ds3Run, DS4_REF.DS3]] as const) {
      const sv = h.st(run, FULL), ok = f2(sv.cagr) === f2(ref.cagr) && f2(sv.mdd) === f2(ref.mdd);
      if (!ok) mism6.push(id);
      console.log(`| ${id} | ${f2(sv.cagr)} / ${f2(sv.mdd)} | ${ref.cagr.toFixed(2)} / ${ref.mdd.toFixed(2)} | ${ok ? "일치" : "불일치"} |`);
    }
    if (mism6.length) throw new Error(`DS2·DS3 재현 불일치(${mism6.join(", ")}) — 중단하고 보고한다`);
  }
  if (REPRO) {
    console.log(`\n사전 점검 종료: 구성요소 4개 재현(원래 시작·공통 구간)·일별 순수익 해시·P2·R1·R3·CS1·CS2·DS2·DS3·069500 기준선 모두 일치, 코어 구조·회계 점검과 위성 비중 상한 점검 통과. DS4 성과는 계산·출력하지 않았다 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    return;
  }
  // ================= DS4 후속 진단 =================
  const cd4 = CANDS_ALL.DS4, wC4 = cd4.coreW, N4 = cd4.coreN, sg = (x: number): string => `${x >= 0 ? "+" : ""}${f2(x)}`;
  const base4 = buildDS(cd4, {}), run4 = base4.res.run;
  console.log(`\n=== 1g. DS4 고정판 재현 (평가 구간 전체 CAGR % / MDD %; 소수 둘째 자리까지 같아야 한다) ===\n| 대상 | 이번 | 연구 DS4 기록 | 일치 |\n|---|---|---|---|`);
  {
    const sv = h.st(run4, FULL), ok = f2(sv.cagr) === f2(DS4_FIXED_REF.cagr) && f2(sv.mdd) === f2(DS4_FIXED_REF.mdd);
    console.log(`| DS4 (고정 날짜 ${DS4_FREEZE_DATE}) | ${f2(sv.cagr)} / ${f2(sv.mdd)} | ${DS4_FIXED_REF.cagr.toFixed(2)} / ${DS4_FIXED_REF.mdd.toFixed(2)} | ${ok ? "일치" : "불일치"} |`);
    if (!ok) throw new Error("DS4 고정판 재현 불일치 — 중단하고 보고한다");
  }
  const winsAll: [string, Win][] = [...W.ALL, ["2026년 제외 (~2025-12-31)", ex26]];
  const ser = (r: { dates: string[]; ret: number[] }): { dates: string[]; ret: number[] } => ({ dates: r.dates, ret: r.ret });
  const cellOf = (r: { dates: string[]; ret: number[] }, w: Win): string => { const sv = h.st(r, w); return `${f2(sv.cagr)} / ${f2(sv.mdd)}`; };
  const idxOf = (w: Win): number[] => { const a: number[] = []; for (let i = 0; i < nDays; i++) if (inWin(dates0[i], w)) a.push(i); return a; };

  // ---- 2-1. 연도별 DS4 − 069500 초과수익과 승·패 ----
  {
    const years: number[] = [];
    for (let y = Number(FULL.from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) years.push(y);
    const d4 = ser(run4), b0 = ser(bhFrom);
    console.log(`\n##### 2-1. 연도별 DS4 − 069500 초과수익 (연도별 일수익률 복리 %, 진단) — ${years[0]}년은 ${FULL.from}부터, ${years[years.length - 1]}년은 ${h.dataEnd}까지의 부분 연도 #####\n| 연도 | DS4 | 069500 | 초과 %p | 승·패 |\n|---|---|---|---|---|`);
    const ex: { y: number; e: number }[] = [];
    for (const y of years) {
      const a = h.yearRet(d4, y), b = h.yearRet(b0, y), e = a - b;
      ex.push({ y, e });
      console.log(`| ${y}${y === years[0] || y === years[years.length - 1] ? " (부분)" : ""} | ${f2(a)} | ${f2(b)} | ${sg(e)} | ${e > 0 ? "승" : e < 0 ? "패" : "무"} |`);
    }
    const cnt = (list: { y: number; e: number }[]): string => `승 ${list.filter((x) => x.e > 0).length} / 패 ${list.filter((x) => x.e < 0).length} / 무 ${list.filter((x) => x.e === 0).length} (평균 초과 ${sg(avg(list.map((x) => x.e)))}%p, 중앙값 ${sg(median(list.map((x) => x.e)))}%p)`;
    console.log(`승·패 연수: 전체 ${ex.length}개 연도(부분 연도 포함) ${cnt(ex)} | 온전한 연도(${years[1]}~${years[years.length - 2]}) ${cnt(ex.slice(1, -1))} | 2026 제외(${years[0]}~${years[years.length - 2]}) ${cnt(ex.slice(0, -1))}`);
  }

  // ---- 2-3. 위성 단독(코어 0%)과 코어 단독(코어 100%), 같은 구간 ----
  const coreSl = getCoreSl(N4, 1), satRun = base4.sat.run;
  console.log(`\n##### 2-3. DS4 구성요소 단독 — 위성 단독(코어 0%: PE4 20% 상한 + W3 + LV1 변동성 역수) · 코어 단독(코어 100%: 시총 상위 2종목) · DS4(40:60) · 069500 (CAGR % / MDD %, 평균 투자 비중 %) #####\n| 구간 | 위성 단독 | 코어 단독 | DS4 (코어 40%) | 069500 | 위성 투자 비중 | 코어 투자 비중 | DS4 투자 비중 |\n|---|---|---|---|---|---|---|---|`);
  for (const [wn, w] of winsAll) {
    const iv = (r: { dates: string[]; ret: number[]; inv: number[] }): string => f2(h.st(r, w).avgInv);
    console.log(`| ${wn} | ${cellOf(ser(satRun), w)} | ${cellOf(ser(coreSl), w)} | ${cellOf(ser(run4), w)} | ${cellOf(h.bhP, w)} | ${iv({ dates: dates0, ret: satRun.ret, inv: satRun.inv })} | ${iv({ dates: coreSl.dates, ret: coreSl.ret, inv: coreSl.inv })} | ${iv({ dates: dates0, ret: run4.ret, inv: run4.inv })} |`);
  }

  // ---- 2-2. 코어를 삼성전자·SK하이닉스 제외 시총 상위 2종목으로 바꾼 DS4-X ----
  {
    const EXC = new Set<string>(DS4_EXCLUDE_CORE);
    const coreXRun = simCore(N4, { lag: 1, exclude: EXC }), coreXSl = slice(coreXRun);
    const xRes = combineCS(coreXSl, slOf(base4.sat.run), wC4, CS_MOVE_COST), runX = xRes.run;
    const arrX: [string, number][][] = new Array(nDays).fill(null).map(() => []);
    simCore(N4, { lag: 1, exclude: EXC, onDay: (c, V, held) => { const i = dateIdx.get(CAL[c]); if (i !== undefined) arrX[i] = held.map(([code, v]) => [code, v / V]); } });
    console.log(`\n##### 2-2. 코어 제외 진단 DS4-X — 코어 규칙은 그대로(월말 K200P 구성 안 당일 시총 순위, 시총 비율, 순위 밖 ${CS_SWAP_CONFIRM_DAYS}거래일 연속일 때만 교체)이고 순위 목록에서 삼성전자·SK하이닉스만 뺀다. 코어 40% · 위성(PE4 20% 상한 + W3 + LV1) 60%·합성 규칙은 DS4와 같다. 새 후보가 아니라 의존도 진단이다 #####`);
    console.log(`코어 구성 이력(삼성전자·SK하이닉스 제외 시총 상위 ${N4}종목; 체결일 종목 교체·비중 조정):\n    ${evLine(coreXRun)}`);
    console.log(`| 구간 | 069500 | DS4 | DS4-X (코어 제외판) | 코어-X 단독 | DS4 코어 단독 | 위성 단독 |\n|---|---|---|---|---|---|---|`);
    for (const [wn, w] of winsAll) console.log(`| ${wn} | ${cellOf(h.bhP, w)} | ${cellOf(ser(run4), w)} | ${cellOf(ser(runX), w)} | ${cellOf(ser(coreXSl), w)} | ${cellOf(ser(coreSl), w)} | ${cellOf(ser(satRun), w)} |`);
    const xs = h.st(runX, FULL), ds = h.st(run4, FULL), bs = h.st(h.bhP, FULL);
    console.log(`DS4-X 전체: ${f2(xs.cagr)} / ${f2(xs.mdd)} (069500 대비 CAGR ${sg(xs.cagr - bs.cagr)}%p, MDD ${sg(xs.mdd - bs.mdd)}%p) | DS4 대비 CAGR ${sg(xs.cagr - ds.cagr)}%p, MDD ${sg(xs.mdd - ds.mdd)}%p`);
    // 삼성전자·SK하이닉스 계좌 비중: 코어-X에는 없고 위성 안에서만
    const wsum = new Map<string, number>();
    for (let i = 0; i < nDays; i++) {
      const wc = xRes.wCore[i], ws = 1 - wc;
      for (const [code, f] of arrX[i]) wsum.set(code, (wsum.get(code) ?? 0) + wc * f);
      cd4.sat.map(CP).forEach((cp, j) => { for (const [code, f] of holdOf(cp)[i]) wsum.set(code, (wsum.get(code) ?? 0) + ws * base4.sat.wAcct[j][i] * f); });
    }
    const wavg = (code: string): number => ((wsum.get(code) ?? 0) / nDays) * 100;
    console.log(`DS4-X 일별 평균 계좌 비중(현금 날 포함): 삼성전자 ${f2(wavg(SAMSUNG))}% · SK하이닉스 ${f2(wavg(HYNIX))}% · 합 ${f2(wavg(SAMSUNG) + wavg(HYNIX))}% (코어에는 없고 위성 안 보유분만) | 상위 8개 종목: ${[...wsum].sort((a, c2) => c2[1] - a[1]).slice(0, 8).map(([code, v]) => `${label(code)} ${f2((v / nDays) * 100)}%`).join(" | ")}`);
    console.log(`DS4-X 진단: 위험 일치 069500 기준선(069500 × k + 현금, MDD 일치 / 변동성 일치) 대비 CAGR 차이 %p\n| 구간 | DS4-X CAGR / MDD / 변동성 | MDD 일치 k | 기준선 CAGR | 차이 | 변동성 일치 k | 기준선 CAGR | 차이 | DS4 MDD 일치 차이(참고) |\n|---|---|---|---|---|---|---|---|---|`);
    for (const [wn, w] of RMD_WINDOWS_2017) {
      const idx = idxOf(w), s = idx.map((i) => runX.ret[i]), s4 = idx.map((i) => run4.ret[i]), bb = idx.map((i) => bRetAxis[i]);
      const c = cagrOfR(s, w), m = mddOfR(s), v = volAnn(s), k1 = kForMdd(bb, m), k2 = Math.min(1, v / volAnn(bb)), c1 = cagrOfR(bb.map((x) => x * k1), w), c2 = cagrOfR(bb.map((x) => x * k2), w);
      const c4 = cagrOfR(s4, w), m4 = mddOfR(s4), k4 = kForMdd(bb, m4), cb4 = cagrOfR(bb.map((x) => x * k4), w);
      console.log(`| ${wn} | ${f2(c)} / ${f2(m)} / ${f2(v)} | ${k1.toFixed(3)}${k1 >= 1 ? " (상한)" : ""} | ${f2(c1)} | ${sg(c - c1)} | ${k2.toFixed(3)}${k2 >= 1 ? " (상한)" : ""} | ${f2(c2)} | ${sg(c - c2)} | ${sg(c4 - cb4)} |`);
    }
    console.log(`DS4-X 연도별 수익률 %: ${[2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026].map((y) => `${y} ${f2(h.yearRet(ser(runX), y))} (069500 ${f2(h.yearRet(ser(bhFrom), y))})`).join(" | ")}`);
  }

  // ---- 2-4. 학습 구간(2017-04~2019) DS4가 069500보다 앞선 이유: 구성요소별 초과 기여 분해 ----
  {
    const comps4 = cd4.sat.map(CP), compS = comps4.map((cp) => getSl(cp, 1));
    const al = base4.sat, rTot = run4.ret, rB = bRetAxis, rCore = coreSl.ret;
    const wcPrev = (i: number): number => (i === 0 ? wC4 : base4.res.wCore[i - 1]);
    const fPrev = (j: number, i: number): number => al.wAcct[j][i - 1];
    const names = ["코어(시총 상위 2종목)", ...cd4.sat.map((id) => `위성 ${id}`)];
    const wPrevOf = (k: number, i: number): number => (i === 0 ? 0 : k === 0 ? wcPrev(i) : (1 - wcPrev(i)) * fPrev(k - 1, i));
    const rOf = (k: number, i: number): number => (k === 0 ? rCore[i] : compS[k - 1].ret[i]);
    console.log(`\n##### 2-4. DS4 − 069500 초과수익의 구성요소별 분해 (진단; 전일 종가 비중 × (구성요소 일수익률 − 069500 일수익률)의 구간 합 %p, 산술 합) — 첫 거래일은 초기 비중이 달라 귀속하지 않고 잔여에 둔다 #####`);
    console.log(`| 구간 | DS4 − 069500 산술 합 %p | ${names.map((n) => `${n} %p`).join(" | ")} | 잔여(이동·내부 비용, 첫날) %p | 복리 CAGR 차이 %p |\n|---|---|${names.map(() => "---").join("|")}|---|---|`);
    for (const [wn, w] of W.ALL) {
      const idx = idxOf(w);
      const tot = idx.reduce((a, i) => a + (rTot[i] - rB[i]), 0);
      const parts = names.map((_, k) => idx.reduce((a, i) => a + wPrevOf(k, i) * (rOf(k, i) - rB[i]), 0));
      const resid = tot - parts.reduce((a, x) => a + x, 0);
      const dc = cagrOfR(idx.map((i) => rTot[i]), w) - cagrOfR(idx.map((i) => rB[i]), w);
      console.log(`| ${wn} | ${sg(tot)} | ${parts.map(sg).join(" | ")} | ${sg(resid)} | ${sg(dc)} |`);
    }
    console.log(`\n구성요소를 069500으로 바꾼 반사실(실제 비중 유지, 그 구성요소 몫의 일수익률만 069500으로 대체; 산술 근사) — CAGR % / MDD %\n| 구간 | DS4 실제 | 코어→069500 | ${comps4.map((c) => `${c.id}→069500`).join(" | ")} | 전부→069500(참고: 069500 − 비용) | 069500 |\n|---|---|---|${comps4.map(() => "---").join("|")}|---|---|`);
    const cf = (kList: number[]): number[] => rTot.map((r, i) => r - kList.reduce((a, k) => a + wPrevOf(k, i) * (rOf(k, i) - rB[i]), 0));
    const series = [rTot, cf([0]), ...comps4.map((_, j) => cf([j + 1])), cf([0, ...comps4.map((_, j) => j + 1)])];
    for (const [wn, w] of W.ALL) {
      const idx = idxOf(w);
      console.log(`| ${wn} | ${series.map((sr) => `${f2(cagrOfR(idx.map((i) => sr[i]), w))} / ${f2(mddOfR(idx.map((i) => sr[i])))}`).join(" | ")} | ${f2(cagrOfR(idx.map((i) => rB[i]), w))} / ${f2(mddOfR(idx.map((i) => rB[i])))} |`);
    }
    console.log(`\n구성요소 단독 성적과 계좌 평균 비중 (구성요소 계좌 단독 CAGR % / MDD %, 괄호 안은 DS4 계좌 안 평균 비중 %)\n| 구간 | 코어 | ${comps4.map((c) => c.id).join(" | ")} | 069500 | 평균 투자 비중 DS4 (현금) |\n|---|---|${comps4.map(() => "---").join("|")}|---|---|`);
    for (const [wn, w] of W.ALL) {
      const idx = idxOf(w);
      const wavgK = (k: number): string => f2(avg(idx.map((i) => wPrevOf(k, i))) * 100);
      const sv = h.st({ dates: dates0, ret: run4.ret, inv: run4.inv }, w);
      console.log(`| ${wn} | ${cellOf(ser(coreSl), w)} (${wavgK(0)}) | ${compS.map((c, j) => `${cellOf(ser(c), w)} (${wavgK(j + 1)})`).join(" | ")} | ${cellOf(h.bhP, w)} | ${f2(sv.avgInv)} (${f2(100 - sv.avgInv)}) |`);
    }
    // 학습 구간 연도별 초과(2017·2018·2019)와 PE4/코어 기여
    console.log(`\n학습 구간 연도별 산술 합 초과 기여 %p (2017은 04-04부터)\n| 연도 | DS4 − 069500 | ${names.join(" | ")} | 잔여 |\n|---|---|${names.map(() => "---").join("|")}|---|`);
    for (const y of [2017, 2018, 2019]) {
      const idx = idxOf({ from: `${y}-01-01`, to: `${y}-12-31` });
      const tot = idx.reduce((a, i) => a + (rTot[i] - rB[i]), 0), parts = names.map((_, k) => idx.reduce((a, i) => a + wPrevOf(k, i) * (rOf(k, i) - rB[i]), 0));
      console.log(`| ${y} | ${sg(tot)} | ${parts.map(sg).join(" | ")} | ${sg(tot - parts.reduce((a, x) => a + x, 0))} |`);
    }
  }
  console.log(`
=== 실행 지표 ===
Supabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ") || "없음"} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험 번호 소진 없음(269 유지)`);
  void ds2Ser; void ds3Ser; void r3Ser; void cs2Ser; void DS4_REF; void quant; void olsR; void episodes; void pct;
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

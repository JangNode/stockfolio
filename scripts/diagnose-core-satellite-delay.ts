/**
 * [임시 연구 진단 — 시험 아님, 번호 소진 없음, 병합 금지, 읽기 전용, 외부 요청 0건] 코어-위성 하루 지연 민감도(게이트 C) 분해.
 * 문서: docs/research/core-satellite-delay-diagnostic.md. 연구 CS의 CS1·CS2를 그대로 쓰고(새 후보 없음) 지연 적용 대상을 하나씩 바꿔 전체 CAGR/MDD 변화를 본다.
 * 같은 캐시(가격 스냅샷, 069500 보조 파일, PE4 입력, 저장된 WFR 점수)에서 구성요소를 다시 돌리며 재현 확인(CS1 14.94/27.81, CS2 16.26/31.01, 069500 12.20/42.03, 게이트 C 지연 버전)을 통과해야 계속한다. 게이트·통과 판정에 쓰지 않는다.
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
import { CSD_REF, CSD_LAGS, CSD_MIN_BASE_CAGR_FOR_RATIO } from "@/lib/coreSatelliteDelayConfig";
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
  console.log(`연구 진단 코어-위성 하루 지연 민감도 분해(시험 아님, 번호 소진 없음) 시작(읽기 전용): ${new Date().toISOString()}`);
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
  const simCore = (N: number, o: { lag: number; replace?: Set<string>; onDay?: (c: number, V: number, held: [string, number][]) => void }): CoreRun => {
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
        const top = megaAt(c, CS_RANK_DEPTH).list.slice(0, N), topSet = new Set(top.map((s) => s.code));
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
  interface Out { run: SimRun; cost: number[]; moved: number[]; wAcct: number[][]; expo: number[]; warm: boolean[]; nAdj: number }
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
  const buildAlloc = (cds: CD[], win: number, target: number | null, rate: number = RATE): Out => {
    const k = cds.length, sd = cds.map((c) => rollStd(c.full, win));
    /** 종가 i 기준 목표 비중: 모든 구성요소에 직전 win일 이력이 있으면 표준편차 역수 비례, 아니면 이력이 있는 구성요소만 균등(워밍업). */
    const weightsAt = (i: number): { w: number[]; warm: boolean } => {
      const v = cds.map((c, j) => { const t = c.k0 + i; return t >= 0 && Number.isFinite(sd[j][t]) ? Math.max(sd[j][t], 1e-9) : NaN; });
      if (v.every(Number.isFinite)) { const inv = v.map((x) => 1 / x), s = inv.reduce((a, x) => a + x, 0); return { w: inv.map((x) => x / s), warm: false }; }
      const n = v.filter(Number.isFinite).length;
      return { w: v.map((x) => (Number.isFinite(x) ? 1 / n : 0)), warm: true };
    };
    const w0 = weightsAt(-1), s = w0.w.slice();
    let pending = cds.map(() => 0), lastWarm = w0.warm;
    const ret: number[] = [], costFrac: number[] = [], nPos: number[] = [], inv: number[] = [], turn: number[] = [], wMax: number[] = [], cost: number[] = [], moved: number[] = [], warm: boolean[] = [];
    const wClose = cds.map(() => new Array<number>(nDays));
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
    if (target === null) return { run: mkRun(ret, costFrac, inv, turn, wMax), cost, moved, wAcct: wClose, expo: ret.map(() => 1), warm, nAdj: 0 };
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
    return { run: mkRun(r2, cf2, inv2, tn2, wm2), cost: cost2, moved: moved2, wAcct: wClose.map((row) => row.map((w, i) => w * expo[i])), expo, warm, nAdj };
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
  if (REPRO) {
    console.log(`\n사전 점검 종료: 구성요소 4개 재현(원래 시작·공통 구간)·일별 순수익 해시·P2·R1·R3·069500 기준선 모두 일치, 코어 구조·회계 점검 통과. 후보 CS1~CS3 성과와 코어 단독 성과는 계산·출력하지 않았다 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    return;
  }

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

  // ================= 지연 민감도 진단 =================
  const CSN = 2; // 코어 대상 종목 수(CS1·CS2)
  const SAT_IDS = ["PE4", "W3", "LV1"] as const;
  type SatId = (typeof SAT_IDS)[number];
  interface Lags { core: number; PE4: number; W3: number; LV1: number }
  const L1: Lags = { core: 1, PE4: 1, W3: 1, LV1: 1 };
  const buildCS = (wC: number, lg: Lags, rate: number = CS_MOVE_COST): { sat: Out; core: Sl; res: CombOut } => {
    const sat = buildAlloc(satCps.map((cp) => cdOf(cp, lg[cp.id as SatId])), IVA_VOL_WINDOW, null);
    const core = getCoreSl(CSN, lg.core);
    return { sat, core, res: combineCS(core, slOf(sat.run), wC, rate) };
  };
  const yrs = (Date.parse(h.dataEnd) - Date.parse(FULL.from)) / 86_400_000 / 365.25;
  const sg = (x: number): string => `${x >= 0 ? "+" : ""}${f2(x)}`;
  const CANDS = [{ id: "CS1", wC: CS_CANDS.CS1.coreW }, { id: "CS2", wC: CS_CANDS.CS2.coreW }] as const;

  // ---- 1. 재현 확인 ----
  console.log(`\n=== 1d. 후보 재현 확인 (평가 구간 전체 CAGR % / MDD %; 소수 둘째 자리까지 같아야 한다) ===\n| 대상 | 이번 | 연구 CS 기록 | 일치 |\n|---|---|---|---|`);
  const mism4: string[] = [];
  for (const cd of CANDS) {
    const b = buildCS(cd.wC, L1), s = h.st(b.res.run, FULL), ref = CSD_REF[cd.id].base, ok = f2(s.cagr) === f2(ref.cagr) && f2(s.mdd) === f2(ref.mdd);
    if (!ok) mism4.push(cd.id);
    console.log(`| ${cd.id} (지연 없음) | ${f2(s.cagr)} / ${f2(s.mdd)} | ${ref.cagr.toFixed(2)} / ${ref.mdd.toFixed(2)} | ${ok ? "일치" : "불일치"} |`);
    const a = buildCS(cd.wC, { core: 2, PE4: 2, W3: 2, LV1: 2 }), sd = h.st(a.res.run, FULL), rd = CSD_REF[cd.id].delay1, okd = f2(sd.cagr) === f2(rd.cagr) && f2(sd.mdd) === f2(rd.mdd);
    if (!okd) mism4.push(`${cd.id} 지연`);
    console.log(`| ${cd.id} (전부 하루 지연 = 게이트 C) | ${f2(sd.cagr)} / ${f2(sd.mdd)} | ${rd.cagr.toFixed(2)} / ${rd.mdd.toFixed(2)} | ${okd ? "일치" : "불일치"} |`);
  }
  {
    const b = h.st(h.bhP, FULL), okb = f2(b.cagr) === f2(RMD_BENCH_REF.cagr) && f2(b.mdd) === f2(RMD_BENCH_REF.mdd);
    if (!okb) mism4.push("069500");
    console.log(`| 069500 | ${f2(b.cagr)} / ${f2(b.mdd)} | ${RMD_BENCH_REF.cagr.toFixed(2)} / ${RMD_BENCH_REF.mdd.toFixed(2)} | ${okb ? "일치" : "불일치"} |`);
  }
  if (mism4.length) throw new Error(`후보 재현 불일치(${mism4.join(", ")}) — 중단하고 보고한다`);

  // ---- 2. 하루 지연 분해 ----
  const cases: { key: string; label: string; lg: Lags }[] = [
    { key: "base", label: "기준(지연 없음)", lg: L1 },
    { key: "a", label: "(a) 코어만 하루 지연", lg: { ...L1, core: 2 } },
    { key: "b", label: "(b) 위성 PE4만", lg: { ...L1, PE4: 2 } },
    { key: "c", label: "(c) 위성 W3만", lg: { ...L1, W3: 2 } },
    { key: "d", label: "(d) 위성 LV1만", lg: { ...L1, LV1: 2 } },
    { key: "e", label: "(e) 위성 전체(PE4+W3+LV1)", lg: { ...L1, PE4: 2, W3: 2, LV1: 2 } },
    { key: "f", label: "(f) 전부 (= 게이트 C)", lg: { core: 2, PE4: 2, W3: 2, LV1: 2 } },
    { key: "g", label: "(g) [참고] 전부 2일 지연", lg: { core: 3, PE4: 3, W3: 3, LV1: 3 } },
  ];
  const built = new Map<string, ReturnType<typeof buildCS>>();
  for (const cd of CANDS) for (const c of cases) built.set(`${cd.id}|${c.key}`, buildCS(cd.wC, c.lg));
  const statOf = (id: string, key: string, w: Win = FULL): { cagr: number; mdd: number } => h.st(built.get(`${id}|${key}`)!.res.run, w);
  console.log(`\n##### 2. 하루 지연 분해 — 지연 적용 대상을 하나씩 바꿔 평가 구간 전체(${FULL.from}~) CAGR / MDD 변화 (진단, 게이트·판정 불사용) #####\n"하루 지연" = 해당 요소의 체결을 신호 다음 거래일이 아니라 그다음 거래일 종가로 미룸(lag 2, 연구 게이트 C와 같음). 위성 변동성 역수 비중은 지연된 순수익으로 다시 계산한다.`);
  for (const cd of CANDS) {
    const base = statOf(cd.id, "base");
    console.log(`\n${cd.id} (코어 ${Math.round(cd.wC * 100)}% / 위성 ${Math.round((1 - cd.wC) * 100)}%)\n| 지연 적용 대상 | CAGR | MDD | CAGR 변화 %p | MDD 변화 %p | 전체 변화 대비 % |\n|---|---|---|---|---|---|`);
    const dF = statOf(cd.id, "f").cagr - base.cagr;
    const dOf = (k: string): number => statOf(cd.id, k).cagr - base.cagr;
    for (const c of cases) {
      const s = statOf(cd.id, c.key), d = s.cagr - base.cagr, dm = s.mdd - base.mdd;
      console.log(`| ${c.label} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${c.key === "base" ? "-" : sg(d)} | ${c.key === "base" ? "-" : sg(dm)} | ${c.key === "base" || c.key === "g" ? "-" : f2((d / dF) * 100)} |`);
    }
    const sumInd = dOf("a") + dOf("b") + dOf("c") + dOf("d"), dm = (k: string): number => statOf(cd.id, k).mdd - base.mdd, sumM = dm("a") + dm("b") + dm("c") + dm("d");
    console.log(`상호작용(CAGR %p): 개별 합 (a)+(b)+(c)+(d) = ${sg(sumInd)} vs 전부 (f) = ${sg(dF)} → 어긋남(f − 합) ${sg(dF - sumInd)}%p | 위성 안: (b)+(c)+(d) = ${sg(dOf("b") + dOf("c") + dOf("d"))} vs (e) = ${sg(dOf("e"))} → ${sg(dOf("e") - (dOf("b") + dOf("c") + dOf("d")))}%p | 코어×위성: (a)+(e) = ${sg(dOf("a") + dOf("e"))} vs (f) = ${sg(dF)} → ${sg(dF - (dOf("a") + dOf("e")))}%p`);
    console.log(`상호작용(MDD %p): 개별 합 ${sg(sumM)} vs 전부 ${sg(dm("f"))} → 어긋남 ${sg(dm("f") - sumM)}%p`);
    console.log(`구간별 CAGR 변화 %p (전부 하루 지연 (f) / 2일 지연 (g) / (a) 코어만 / (e) 위성 전체)\n| 구간 | 기준 CAGR | (a) | (e) | (f) | (g) |\n|---|---|---|---|---|---|`);
    for (const [wn, w] of W.ALL) {
      const b0 = statOf(cd.id, "base", w).cagr;
      console.log(`| ${wn} | ${f2(b0)} | ${sg(statOf(cd.id, "a", w).cagr - b0)} | ${sg(statOf(cd.id, "e", w).cagr - b0)} | ${sg(statOf(cd.id, "f", w).cagr - b0)} | ${sg(statOf(cd.id, "g", w).cagr - b0)} |`);
    }
  }

  // ---- 3. 구성요소 단독 지연 민감도 ----
  console.log(`\n##### 3. 구성요소 단독 지연 민감도 — 구성요소 계좌 단독(${FULL.from}부터 자른 일별 순수익)의 CAGR (%) / 기준 대비 변화 %p / 변화율 % (기준 CAGR 대비) #####\n하루 지연 = lag 2, 2일 지연 = lag 3. 기준 CAGR 절댓값이 ${CSD_MIN_BASE_CAGR_FOR_RATIO}% 미만이면 변화율은 "-".`);
  const compSl = (id: string, lag: number): Sl => (id === "코어(N=2)" ? getCoreSl(CSN, lag) : getSl(compOf.get(id as CId)!, lag));
  const ratio = (d: number, b0: number): string => (Math.abs(b0) >= CSD_MIN_BASE_CAGR_FOR_RATIO ? f2((d / b0) * 100) : "-");
  console.log(`| 구성요소 | 지연 | ${W.ALL.map(([n]) => n).join(" | ")} |\n|---|---|${W.ALL.map(() => "---").join("|")}|`);
  for (const id of ["PE4", "W3", "LV1", "코어(N=2)"]) {
    const baseS = compSl(id, 1), bases = W.ALL.map(([, w]) => h.st({ dates: baseS.dates, ret: baseS.ret }, w).cagr);
    for (const lag of CSD_LAGS) {
      const s = compSl(id, lag);
      const cells = W.ALL.map(([, w], k) => {
        const c = h.st({ dates: s.dates, ret: s.ret }, w).cagr;
        return lag === 1 ? f2(c) : `${f2(c)} (${sg(c - bases[k])}%p, ${ratio(c - bases[k], bases[k])}%)`;
      });
      console.log(`| ${id} | ${lag === 1 ? "기준" : lag === 2 ? "하루 지연" : "2일 지연"} | ${cells.join(" | ")} |`);
    }
  }

  // ---- 4. 지연 시 비중·비용 변화 ----
  console.log(`\n##### 4. 지연 시 비중 변화(위성 안 구성요소별 평균 비중 %, 변동성 역수 배분 R3)와 리밸런싱 비용 #####`);
  const wAvg = (o: Out, w: Win): number[] => {
    const idx: number[] = [];
    for (let i = 0; i < nDays; i++) if (inWin(dates0[i], w)) idx.push(i);
    return o.wAcct.map((row) => avg(idx.map((i) => row[i])) * 100);
  };
  const satCases = cases.filter((c) => c.key !== "a");
  const satOf = (key: string): Out => built.get(`CS1|${key}`)!.sat; // 위성은 코어 비중과 무관하므로 CS1 계산을 쓴다
  console.log(`위성 안 구성요소별 평균 비중 % (PE4 / W3 / LV1) — 기준 대비 변화 %p\n| 지연 적용 대상 | ${W.ALL.map(([n]) => n).join(" | ")} |\n|---|${W.ALL.map(() => "---").join("|")}|`);
  const baseW = W.ALL.map(([, w]) => wAvg(satOf("base"), w));
  for (const c of satCases) {
    const cells = W.ALL.map(([, w], k) => { const v = wAvg(satOf(c.key), w); return c.key === "base" ? v.map(f2).join(" / ") : `${v.map(f2).join(" / ")} (${v.map((x, j) => sg(x - baseW[k][j])).join(" / ")})`; });
    console.log(`| ${c.label} | ${cells.join(" | ")} |`);
  }
  const warmOf = (o: Out): number => warmEnd(o);
  console.log(`위성 워밍업 일수(변동성 역수 비중이 시작되는 날): ${satCases.map((c) => `${c.label} ${warmOf(satOf(c.key))}일`).join(" | ")}`);
  console.log(`\n리밸런싱 비용 (연 이동 금액 % / 연 비용 %p; 위성 내부 = 위성 계좌 대비 PE4·W3·LV1 간 이동, 상위 = 계좌 대비 코어↔위성 이동; 구성요소 내부 거래 비용은 각 순수익에 반영)\n| 지연 적용 대상 | 위성 내부 이동 | 위성 내부 비용 | CS1 상위 이동 | CS1 상위 비용 | CS2 상위 이동 | CS2 상위 비용 |\n|---|---|---|---|---|---|---|`);
  for (const c of cases) {
    const so = satOf(c.key), smv = so.moved.reduce((a, x) => a + x, 0) * 100, sct = so.cost.reduce((a, x) => a + x, 0) * 100;
    const top = (id: string): string => { const r = built.get(`${id}|${c.key}`)!.res, mv = r.moved.reduce((a, x) => a + x, 0) * 100, ct = r.cost.reduce((a, x) => a + x, 0) * 100; return `${f2(mv / yrs)} | ${f2(ct / yrs)}`; };
    console.log(`| ${c.label} | ${f2(smv / yrs)} | ${f2(sct / yrs)} | ${top("CS1")} | ${top("CS2")} |`);
  }
  console.log(`\n구성요소 내부 비용(연 회전율 % / 비용 합계 %, 구성요소 계좌 대비, 평가 구간)\n| 구성요소 | 기준 | 하루 지연 | 2일 지연 |\n|---|---|---|---|`);
  for (const id of ["PE4", "W3", "LV1", "코어(N=2)"]) {
    const cell = (lag: number): string => { const r = id === "코어(N=2)" ? getCore(CSN, lag) : getRun(compOf.get(id as CId)!, lag); const s = h.st(r, FULL); return `${f2(s.turnover)} / ${f2(s.cost)}`; };
    console.log(`| ${id} | ${cell(1)} | ${cell(2)} | ${cell(3)} |`);
  }

  // ---- 5. 위험 일치 알파(MDD 일치 069500 대비) ----
  console.log(`\n##### 5. 위험 일치 알파 — 위험 일치 069500 기준선(069500 일수익률 × k + 현금, MDD 일치 / 변동성 일치, 연구 진단 risk-matched-benchmark-diagnostic과 같은 정의) 대비 CAGR 차이 %p. 전부(코어+위성) 지연 #####`);
  for (const cd of CANDS) {
    console.log(`\n${cd.id}\n| 구간 | 지연 | CAGR / MDD / 변동성 | MDD 일치 k | 기준선 CAGR | MDD 일치 차이 | 변동성 일치 k | 기준선 CAGR | 변동성 일치 차이 |\n|---|---|---|---|---|---|---|---|---|`);
    for (const [wn, w] of RMD_WINDOWS_2017) {
      const idx: number[] = [];
      for (let i = 0; i < nDays; i++) if (inWin(dates0[i], w)) idx.push(i);
      const bb = idx.map((i) => bRetAxis[i]);
      for (const lag of CSD_LAGS) {
        const key = lag === 1 ? "base" : lag === 2 ? "f" : "g", s = idx.map((i) => built.get(`${cd.id}|${key}`)!.res.run.ret[i]);
        const c = cagrOfR(s, w), m = mddOfR(s), v = volAnn(s), k1 = kForMdd(bb, m), k2 = Math.min(1, v / volAnn(bb)), c1 = cagrOfR(bb.map((x) => x * k1), w), c2 = cagrOfR(bb.map((x) => x * k2), w);
        console.log(`| ${wn} | ${lag === 1 ? "기준" : lag === 2 ? "하루" : "2일"} | ${f2(c)} / ${f2(m)} / ${f2(v)} | ${k1.toFixed(3)}${k1 >= 1 ? " (상한)" : ""} | ${f2(c1)} | ${sg(c - c1)} | ${k2.toFixed(3)}${k2 >= 1 ? " (상한)" : ""} | ${f2(c2)} | ${sg(c - c2)} |`);
      }
    }
  }
  console.log(`
=== 실행 지표 ===
Supabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ") || "없음"} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시도 번호 소진 없음`);
  void median; void pct; void olsR; void holdOf; void quant;
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

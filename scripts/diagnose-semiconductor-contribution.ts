/**
 * [임시 연구 진단 — 시험 아님, 번호 소진 없음, 병합 금지, 읽기 전용, 외부 요청 0건] 삼성전자(005930)·SK하이닉스(000660) 기여 분해.
 * 문서: docs/research/semiconductor-contribution-diagnostic.md. 연구 ALLOC·CAPREC·IVA와 같은 캐시(가격 스냅샷, 069500 보조 파일, PE4 입력, 저장된 WFR 점수)에서 구성요소를 같은 설정으로 다시 돌리되
 * 일별 보유 비중을 함께 기록해(onDay) 두 종목의 일별 기여를 분리한다. 재현 확인(기록값·일별 순수익 해시·기준 실행과 일치)을 통과해야 계속한다. 게이트·통과 판정에 쓰지 않는다.
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
import { IVA_PRIOR_TESTS, IVA_VOL_WINDOW, IVA_WINDOW_NEIGHBORS, IVA_MOVE_COST, IVA_MOVE_COST_SENS, IVA_TARGET_NEIGHBORS, IVA_TARGET_WINDOW, IVA_TARGET_BAND, IVA_F_DENOMINATOR, IVA_CANDS, IVA_P2_REF, IVA_W_QUANTILES } from "@/lib/inverseVolConfig";
import { CAPREC_COMP_CUT_REF, CAPREC_CANDS } from "@/lib/capitalRecyclingConfig";
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
  console.log(`연구 ALLOC 전략 배분 포트폴리오 ${REPRO ? "사전 점검(구성요소 재현·일별 수익 저장만, 후보 성과 미계산)" : "시도 254~256 시험"} 시작(읽기 전용): ${new Date().toISOString()}`);
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

  // ---- 1. 구성요소 재현 확인 + 일별 순수익 저장 ----
  const runCache = new Map<string, SimRun>();
  const getRun = (cp: Comp, lag: number, repl?: Set<string>): SimRun => {
    const key = `${cp.id}|${lag}|${repl ? [...repl].sort().join(",") : ""}`;
    let r = runCache.get(key);
    if (!r) { r = cp.run({ lag, replace: repl, detail: true }); runCache.set(key, r); }
    return r;
  };
  console.log(`\n=== 1. 구성요소 재현 확인 (원래 평가 시작 기준 전체 구간 CAGR % / MDD %; 기록과 소수 둘째 자리까지 같아야 하고, 일별 순수익 SHA-256이 연구 ALLOC 사전등록 해시와 같아야 한다) ===\n| 구성요소 | 원래 평가 시작 | 이번 재계산 | 원래 시험 기록 | 일치 | 일별 순수익 파일 SHA-256 | ALLOC 해시와 |\n|---|---|---|---|---|---|---|`);
  const outDir = process.env.ALLOC_OUT_DIR?.trim() || ".semi-returns";
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
  if (REPRO) {
    console.log(`\n사전 점검 종료: 구성요소 4개 재현(원래 시작·공통 구간)·일별 순수익 해시·P2·069500 기준선 모두 일치. 후보 R1~R3 성과는 계산하지 않았다 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시도 번호 소진 없음`);
    return;
  }

  const compOf = new Map(comps.map((c) => [c.id as CId, c]));
  // ================= A. 삼성전자·SK하이닉스 기여 분해 (진단, 게이트·판정 불사용) =================
  const D = 252, SAM = "005930", HYN = "000660";
  const cuts = (c: CId): number[] => baseSl.get(c)!.ret;
  // ---- 구성요소 일별 보유 비중(종가, 계좌 대비)과 두 종목 일수익률 ----
  const fracSam = new Map<CId, Float64Array>(), fracHyn = new Map<CId, Float64Array>();
  for (const cp of comps) {
    const sam = new Float64Array(nCal), hyn = new Float64Array(nCal);
    const r = cp.run({ lag: 1, detail: true, onDay: (c, V, held) => { for (const [code, val] of held) { if (code === SAM) sam[c] = val / V; else if (code === HYN) hyn[c] = val / V; } } });
    const base = getRun(cp, 1);
    if (r.ret.length !== base.ret.length || r.ret.some((x, i) => x !== base.ret[i])) throw new Error(`${cp.id} 보유 기록 실행이 기준 실행과 다르다 — 중단`);
    fracSam.set(cp.id, sam); fracHyn.set(cp.id, hyn);
  }
  const stockRet = (code: string): Float64Array => {
    const s = byCode.get(code)!, out = new Float64Array(nCal);
    let last = NaN;
    for (let c = 0; c < nCal; c++) { const i = s.idx.get(CAL[c]); if (i !== undefined) { if (Number.isFinite(last)) out[c] = (s.close[i] / last - 1) * 100; last = s.close[i]; } }
    return out;
  };
  const rSam = stockRet(SAM), rHyn = stockRet(HYN);
  const bRetAxis = dates0.map((d) => { const r = h.bhRet.get(d); if (r === undefined) throw new Error(`069500 일수익률 없음 ${d}`); return r * 100; });
  const axisC = (i: number): number => cutC + i;
  for (let i = 0; i < nDays; i++) if (CAL[axisC(i)] !== dates0[i]) throw new Error("달력 축 불일치");

  // ---- 합성 계좌 재조립(연구 ALLOC·IVA·CAPREC와 같은 규칙) + 슬리브 비중 ----
  const RATE = 0.0025;
  /** 연구 ALLOC P2 방식: 목표 비중 w, 전일 정한 고정 금액을 다음 종가에 이동, 이동 금액의 RATE. wPrev[j][i] = 그날 시작 슬리브 비중. */
  const simP = (rets: number[][], w: number[]): { ret: number[]; wPrev: number[][] } => {
    const k = rets.length, s = w.slice(), pending = rets.map(() => 0), ret: number[] = [], wPrev = rets.map(() => new Array<number>(nDays));
    for (let i = 0; i < nDays; i++) {
      const Vprev = s.reduce((a, x) => a + x, 0);
      for (let j = 0; j < k; j++) { wPrev[j][i] = s[j] / Vprev; s[j] *= 1 + rets[j][i] / 100; }
      let mv = 0;
      if (pending.some((x) => x !== 0)) {
        for (let j = 0; j < k; j++) { s[j] += pending[j]; if (pending[j] > 0) mv += pending[j]; }
        const cs = RATE * mv;
        if (mv > 0) for (let j = 0; j < k; j++) if (pending[j] > 0) s[j] -= (cs * pending[j]) / mv;
      }
      const V = s.reduce((a, x) => a + x, 0);
      ret.push((V / Vprev - 1) * 100);
      for (let j = 0; j < k; j++) pending[j] = w[j] * V - s[j];
    }
    return { ret, wPrev };
  };
  /** 연구 IVA R1: 직전 250거래일 표본 표준편차 역수 비중(워밍업은 이력 있는 구성요소 균등). */
  const rollStd = (full: ArrayLike<number>, win: number): Float64Array => {
    const n = full.length, p1 = new Float64Array(n + 1), p2 = new Float64Array(n + 1), a = new Float64Array(n).fill(NaN);
    for (let t = 0; t < n; t++) { p1[t + 1] = p1[t] + full[t]; p2[t + 1] = p2[t] + full[t] * full[t]; }
    for (let t = win - 1; t < n; t++) { const s1 = p1[t + 1] - p1[t + 1 - win], s2 = p2[t + 1] - p2[t + 1 - win]; a[t] = Math.sqrt(Math.max(0, (s2 - (s1 * s1) / win) / (win - 1))); }
    return a;
  };
  const simIV = (ids: CId[]): { ret: number[]; wPrev: number[][] } => {
    const cds = ids.map((id) => { const r = getRun(compOf.get(id)!, 1); return { full: r.ret, k0: r.dates.findIndex((d) => d >= FULL.from) }; });
    const sd = cds.map((c) => rollStd(c.full, IVA_VOL_WINDOW));
    const weightsAt = (i: number): number[] => {
      const v = cds.map((c, j) => { const t = c.k0 + i; return t >= 0 && Number.isFinite(sd[j][t]) ? Math.max(sd[j][t], 1e-9) : NaN; });
      if (v.every(Number.isFinite)) { const inv = v.map((x) => 1 / x), s = inv.reduce((a, x) => a + x, 0); return inv.map((x) => x / s); }
      const n = v.filter(Number.isFinite).length;
      return v.map((x) => (Number.isFinite(x) ? 1 / n : 0));
    };
    const k = cds.length, s = weightsAt(-1);
    let pending = cds.map(() => 0);
    const ret: number[] = [], wPrev = cds.map(() => new Array<number>(nDays));
    for (let i = 0; i < nDays; i++) {
      const Vprev = s.reduce((a, x) => a + x, 0);
      for (let j = 0; j < k; j++) { wPrev[j][i] = s[j] / Vprev; s[j] *= 1 + cds[j].full[cds[j].k0 + i] / 100; }
      let mv = 0;
      if (pending.some((x) => x !== 0)) {
        for (let j = 0; j < k; j++) { s[j] += pending[j]; if (pending[j] > 0) mv += pending[j]; }
        const cs = RATE * mv;
        if (mv > 0) for (let j = 0; j < k; j++) if (pending[j] > 0) s[j] -= (cs * pending[j]) / mv;
      }
      const V = s.reduce((a, x) => a + x, 0);
      ret.push((V / Vprev - 1) * 100);
      const wt = weightsAt(i);
      pending = wt.map((x, j) => x * V - s[j]);
    }
    return { ret, wPrev };
  };
  /** 연구 CAPREC Q2: PE4 슬리브 = W × f × 계좌(PE4 명목 = W × 계좌), 나머지 코어 균등(전일 정한 고정 금액 이동). wPrev[0] = 그날 PE4 명목 비중(W), 이후 코어 슬리브. */
  const simQ = (W: number, core: CId[]): { ret: number[]; wPrev: number[][] } => {
    const peRun = getRun(compOf.get("PE4")!, 1), k0 = peRun.dates.findIndex((d) => d >= FULL.from);
    const pr = peRun.ret.slice(k0), pc = peRun.costFrac.slice(k0), f = peRun.inv.slice(k0), fp0 = k0 > 0 ? peRun.inv[k0 - 1] : 0;
    const rHold = pr.map((x, i) => { const fp = i === 0 ? fp0 : f[i - 1]; return fp > 1e-12 ? (x / 100 + pc[i]) / fp : 0; });
    const m = core.length, coreRet = core.map((id) => cuts(id));
    let Sp = 0;
    const Sk = core.map(() => 1 / m);
    let pend = core.map(() => 0);
    const ret: number[] = [], wPrev = [new Array<number>(nDays), ...core.map(() => new Array<number>(nDays))];
    for (let i = 0; i < nDays; i++) {
      const Vprev = Sp + Sk.reduce((a, x) => a + x, 0), N = W * Vprev;
      wPrev[0][i] = W;
      for (let j = 0; j < m; j++) wPrev[j + 1][i] = Sk[j] / Vprev;
      Sp = Sp * (1 + rHold[i]) - N * pc[i];
      for (let j = 0; j < m; j++) Sk[j] *= 1 + coreRet[j][i] / 100;
      let mv1 = 0;
      if (pend.some((x) => x !== 0)) for (let j = 0; j < m; j++) { Sk[j] += pend[j]; if (pend[j] > 0) mv1 += pend[j]; }
      const Vpre = Sp + Sk.reduce((a, x) => a + x, 0);
      const target = W * f[i] * Vpre, dp = target - Sp, Ct = Vpre - Sp;
      for (let j = 0; j < m; j++) Sk[j] -= (dp * Sk[j]) / Ct;
      Sp = target;
      const kappa = (RATE * (mv1 + Math.abs(dp))) / Vpre;
      Sp *= 1 - kappa;
      for (let j = 0; j < m; j++) Sk[j] *= 1 - kappa;
      const V = Vpre * (1 - kappa);
      ret.push((V / Vprev - 1) * 100);
      const Cn = Sk.reduce((a, x) => a + x, 0);
      pend = Sk.map((x) => Cn / m - x);
    }
    return { ret, wPrev };
  };

  // ---- 전략 객체: 일수익률 r(%), 그날 시작 계좌 대비 삼성전자·SK하이닉스 비중 wS·wH(소수) ----
  interface Strat { id: string; r: number[]; wS: number[]; wH: number[] }
  const strats: Strat[] = [];
  const stockW = (parts: { w: number[]; id: CId }[]): { wS: number[]; wH: number[] } => {
    const wS = new Array<number>(nDays).fill(0), wH = new Array<number>(nDays).fill(0);
    for (const { w, id } of parts) { const fs_ = fracSam.get(id)!, fh = fracHyn.get(id)!; for (let i = 0; i < nDays; i++) { wS[i] += w[i] * fs_[axisC(i) - 1]; wH[i] += w[i] * fh[axisC(i) - 1]; } }
    return { wS, wH };
  };
  const ones = new Array<number>(nDays).fill(1);
  for (const cp of comps) strats.push({ id: cp.id, r: cuts(cp.id), ...stockW([{ w: ones, id: cp.id }]) });
  const ids4: CId[] = ["PE4", "W3", "LV1", "L3"];
  const p2 = simP(ids4.map((id) => cuts(id)), [0.25, 0.25, 0.25, 0.25]);
  strats.push({ id: "P2", r: p2.ret, ...stockW(ids4.map((id, j) => ({ w: p2.wPrev[j], id }))) });
  const r1 = simIV(ids4);
  strats.push({ id: "R1", r: r1.ret, ...stockW(ids4.map((id, j) => ({ w: r1.wPrev[j], id }))) });
  const q2 = simQ(CAPREC_CANDS.Q2.w, [...CAPREC_CANDS.Q2.core] as CId[]);
  strats.push({ id: "Q2", r: q2.ret, ...stockW([{ w: q2.wPrev[0], id: "PE4" as CId }, ...CAPREC_CANDS.Q2.core.map((id, j) => ({ w: q2.wPrev[j + 1], id: id as CId }))]) });
  // 재현 확인(합성 계좌)
  console.log(`\n합성 계좌 재조립 재현 확인 (평가 구간 전체 CAGR / MDD)\n| 대상 | 이번 | 이전 보고 | 일치 |\n|---|---|---|---|`);
  for (const [id, ref] of [["P2", { cagr: 13.08, mdd: 29.84 }], ["R1", { cagr: 12.6, mdd: 28.34 }], ["Q2", { cagr: 13.35, mdd: 36.62 }]] as const) {
    const st = strats.find((x) => x.id === id)!, s = h.st({ dates: dates0, ret: st.r }, FULL), ok = f2(s.cagr) === f2(ref.cagr) && f2(s.mdd) === f2(ref.mdd);
    console.log(`| ${id} | ${f2(s.cagr)} / ${f2(s.mdd)} | ${f2(ref.cagr)} / ${f2(ref.mdd)} | ${ok ? "일치" : "불일치"} |`);
    if (!ok) throw new Error(`${id} 재조립이 이전 보고와 다르다 — 중단`);
  }

  // ---- 시총가중 K200P 지수형 수익률(가격 기준, 비용 없음): 전일 시총 가중, 전일 K200P 구성 ----
  const idxInc: number[] = [], idxEx: number[] = [], wTwoIdx: number[] = [], wSidx: number[] = [], wHidx: number[] = [], nIdx: number[] = [];
  for (let i = 0; i < nDays; i++) {
    const c = axisC(i), list = kAt(CAL[c - 1]);
    let sw = 0, swr = 0, swEx = 0, swrEx = 0, wS = 0, wH = 0, n = 0;
    for (const s of list) {
      const ip = s.idx.get(CAL[c - 1]), ic = s.idx.get(CAL[c]);
      if (ip === undefined || ic === undefined) continue;
      const mc = s.mcapRow[ip];
      if (!(mc > 0)) continue;
      const r = (s.close[ic] / s.close[ip] - 1) * 100;
      if (!Number.isFinite(r)) continue;
      sw += mc; swr += mc * r; n++;
      if (s.code === SAM) wS = mc; else if (s.code === HYN) wH = mc;
      else { swEx += mc; swrEx += mc * r; }
    }
    idxInc.push(swr / sw); idxEx.push(swrEx / swEx); wSidx.push(wS / sw); wHidx.push(wH / sw); wTwoIdx.push((wS + wH) / sw); nIdx.push(n);
  }
  strats.push({ id: "069500(근사)", r: bRetAxis, wS: wSidx, wH: wHidx });

  // ---- 분해 계열 ----
  interface Dec { id: string; r: number[]; ra: number[]; rb: number[]; cS: number[]; cH: number[]; wS: number[]; wH: number[] }
  const decs: Dec[] = strats.map((st) => {
    const cS = st.wS.map((w, i) => w * rSam[axisC(i)]), cH = st.wH.map((w, i) => w * rHyn[axisC(i)]);
    return { id: st.id, r: st.r, ra: st.r.map((x, i) => x - cS[i] - cH[i]), rb: st.r.map((x, i) => x - st.wS[i] * (rSam[axisC(i)] - bRetAxis[i]) - st.wH[i] * (rHyn[axisC(i)] - bRetAxis[i])), cS, cH, wS: st.wS, wH: st.wH };
  });
  const decOf = (id: string): Dec => decs.find((d) => d.id === id)!;
  const NAMES = ["PE4", "W3", "LV1", "L3", "P2", "R1", "Q2", "069500(근사)"];
  const inWin = (d: string, w: Win): boolean => d >= w.from && d <= w.to;
  const idxIn = (w: Win): number[] => { const a: number[] = []; for (let i = 0; i < nDays; i++) if (inWin(dates0[i], w)) a.push(i); return a; };
  const cagrR = (r: number[], w: Win): number => computeCagrPct(computeCumulativeAndMdd(r).totalReturnPct, w.from, w.to > h.dataEnd ? h.dataEnd : w.to);
  const mddR = (r: number[]): number => computeCumulativeAndMdd(r).mddPct;
  const stat = (r: number[], w: Win): string => { const ix = idxIn(w), x = ix.map((i) => r[i]); return `${f2(cagrR(x, w))} / ${f2(mddR(x))}`; };
  const sumW = (a: number[], w: Win): number => idxIn(w).reduce((s, i) => s + a[i], 0);
  const sdOf = (r: number[]): number => { const m = r.reduce((a, x) => a + x, 0) / Math.max(r.length, 1); return Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(r.length - 1, 1)); };
  const kForMdd = (bench: number[], target: number): number => { if (mddR(bench) <= target) return 1; let lo = 0, hi = 1; for (let i = 0; i < RMD_K_ITER; i++) { const m = (lo + hi) / 2; if (mddR(bench.map((x) => x * m)) > target) hi = m; else lo = m; } return (lo + hi) / 2; };
  const WINS = RMD_WINDOWS_2017;

  console.log(`\n##### A1. 삼성전자·SK하이닉스 기여 분해 (진단, 게이트·판정 불사용). (a) 두 종목 기여를 0으로(그 몫은 현금), (b) 두 종목 몫을 069500 수익률로 대체. 누적 기여 = 구간 안 일별 기여(전일 계좌 대비 비중 × 종목 일수익률)의 단순 합(%p). 069500은 K200P 시총 비중으로 근사 #####`);
  for (const [wn, w] of WINS) {
    console.log(`\nA1 — ${wn}\n| 대상 | 실제 CAGR / MDD | (a) 두 종목 제외(현금) CAGR / MDD | (b) 두 종목→069500 CAGR / MDD | 삼성전자 누적 기여 %p | SK하이닉스 누적 기여 %p | 두 종목 평균 계좌 비중 % |\n|---|---|---|---|---|---|---|`);
    for (const id of NAMES) {
      const d = decOf(id), ix = idxIn(w);
      console.log(`| ${id} | ${stat(d.r, w)} | ${stat(d.ra, w)} | ${id === "069500(근사)" ? "—" : stat(d.rb, w)} | ${f2(sumW(d.cS, w))} | ${f2(sumW(d.cH, w))} | ${f2((ix.reduce((s, i) => s + d.wS[i] + d.wH[i], 0) / Math.max(ix.length, 1)) * 100)} |`);
    }
  }
  console.log(`\n##### A2. 연도별 누적 기여 %p (삼성전자 / SK하이닉스, 일별 기여의 단순 합) #####\n| 대상 | ${[2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026].join(" | ")} |\n|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const id of NAMES) {
    const d = decOf(id);
    console.log(`| ${id} | ${[2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026].map((y) => { const w = { from: `${y}-01-01`, to: `${y}-12-31` }; return `${f2(sumW(d.cS, w))} / ${f2(sumW(d.cH, w))}`; }).join(" | ")} |`);
  }
  console.log(`\n연도별 수익률 % 비교 — 실제 / (a) 두 종목 제외(현금)\n| 대상 | ${[2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026].join(" | ")} |\n|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const id of NAMES) {
    const d = decOf(id);
    console.log(`| ${id} | ${[2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026].map((y) => { const w = { from: `${y}-01-01`, to: `${y}-12-31` }, ix = idxIn(w); return `${f2(computeCumulativeAndMdd(ix.map((i) => d.r[i])).totalReturnPct)} / ${f2(computeCumulativeAndMdd(ix.map((i) => d.ra[i])).totalReturnPct)}`; }).join(" | ")} |`);
  }

  // ---- A3. K200P 시총가중 벤치마크 ----
  const cS_idx = wSidx.map((w, i) => w * rSam[axisC(i)]), cH_idx = wHidx.map((w, i) => w * rHyn[axisC(i)]);
  console.log(`\n##### A3. 시총가중 K200P 지수형 벤치마크 (근사: 월말 K200P 구성·전일 시총 가중, 가격 수익만·비용 없음; 전일·당일 행이 모두 있는 종목만, 평균 구성 ${f2(avg(nIdx))}종목) #####\n| 구간 | 069500 | K200P(두 종목 포함) | K200P ex-두 종목 | K200P 안 두 종목 평균 시총 비중 % | 삼성전자 기여 %p | SK하이닉스 기여 %p |\n|---|---|---|---|---|---|---|`);
  for (const [wn, w] of WINS) { const ix = idxIn(w); console.log(`| ${wn} | ${stat(bRetAxis, w)} | ${stat(idxInc, w)} | ${stat(idxEx, w)} | ${f2(avg(ix.map((i) => wTwoIdx[i])) * 100)} | ${f2(sumW(cS_idx, w))} | ${f2(sumW(cH_idx, w))} |`); }
  console.log(`\nA3 연도별 수익률 %: 069500 / K200P / K200P ex-두 종목 / 두 종목 비중 평균 % / 삼성전자·SK하이닉스 기여 %p\n| 연도 | 069500 | K200P | K200P ex-두 종목 | 두 종목 비중 | 삼성전자 기여 | SK하이닉스 기여 |\n|---|---|---|---|---|---|---|`);
  for (const y of [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]) {
    const w = { from: `${y}-01-01`, to: `${y}-12-31` }, ix = idxIn(w), tot = (a: number[]): number => computeCumulativeAndMdd(ix.map((i) => a[i])).totalReturnPct;
    console.log(`| ${y} | ${f2(tot(bRetAxis))} | ${f2(tot(idxInc))} | ${f2(tot(idxEx))} | ${f2(avg(ix.map((i) => wTwoIdx[i])) * 100)} | ${f2(sumW(cS_idx, w))} | ${f2(sumW(cH_idx, w))} |`);
  }
  console.log(`069500 자체의 두 종목 기여 추정: 069500 구성 비중 자료가 없어(재수집 금지) K200P 시총 비중으로 근사했다. 전체 구간 K200P의 두 종목 기여 합 ${f2(sumW(cS_idx, FULL) + sumW(cH_idx, FULL))}%p (평균 비중 ${f2(avg(wTwoIdx) * 100)}%). 069500 − K200P(두 종목 포함) CAGR 차이 ${f2(cagrR(bRetAxis, FULL) - cagrR(idxInc, FULL))}%p로 근사의 크기를 가늠한다.`);

  // ---- A4. 두 종목 제외 비교 ----
  console.log(`\n##### A4. 두 종목 제외 성적 vs 069500·K200P ex-두 종목 (CAGR %; (a) 현금 대체 / (b) 069500 대체) #####`);
  for (const [wn, w] of WINS) {
    const ix = idxIn(w), cB = cagrR(ix.map((i) => bRetAxis[i]), w);
    const kx = cagrR(ix.map((i) => idxEx[i]), w), kxm = mddR(ix.map((i) => idxEx[i]));
    console.log(`\nA4 — ${wn} | 069500 CAGR ${f2(cB)} | K200P ex-두 종목 CAGR ${f2(kx)} / MDD ${f2(kxm)}\n| 대상 | 실제 CAGR | (a) CAGR / MDD | (a) − 069500 | (a) − K200P ex | (b) CAGR / MDD | (b) − 069500 | (b) − K200P ex |\n|---|---|---|---|---|---|---|---|`);
    for (const id of NAMES.filter((n) => n !== "069500(근사)")) {
      const d = decOf(id), a = ix.map((i) => d.ra[i]), b = ix.map((i) => d.rb[i]), ca = cagrR(a, w), cb = cagrR(b, w), c0 = cagrR(ix.map((i) => d.r[i]), w);
      console.log(`| ${id} | ${f2(c0)} | ${f2(ca)} / ${f2(mddR(a))} | ${ca - cB >= 0 ? "+" : ""}${f2(ca - cB)} | ${ca - kx >= 0 ? "+" : ""}${f2(ca - kx)} | ${f2(cb)} / ${f2(mddR(b))} | ${cb - cB >= 0 ? "+" : ""}${f2(cb - cB)} | ${cb - kx >= 0 ? "+" : ""}${f2(cb - kx)} |`);
    }
  }

  // ---- A4b. 위험 일치 알파(MDD 일치) 두 종목 제외 기준 ----
  console.log(`\n##### A4b. 위험 일치 알파(MDD 일치, 진단): 두 종목 제외 (a)·(b) 계열의 MDD와 같은 MDD가 되도록 벤치마크 일수익률 × k + 현금. 벤치마크 = 069500 / K200P ex-두 종목. 차이 = 전략 CAGR − 기준선 CAGR (%p) #####`);
  for (const [wn, w] of WINS) {
    const ix = idxIn(w), bb = ix.map((i) => bRetAxis[i]), bk = ix.map((i) => idxEx[i]);
    console.log(`\nA4b — ${wn}\n| 대상 | 실제 vs 069500 (k, 차이) | (a) vs 069500 (k, 차이) | (a) vs K200P ex (k, 차이) | (b) vs 069500 (k, 차이) | (b) vs K200P ex (k, 차이) |\n|---|---|---|---|---|---|`);
    const cell = (s: number[], b: number[]): string => { const m = mddR(s), k = kForMdd(b, m), cb = cagrR(b.map((x) => x * k), w), c = cagrR(s, w); return `${k.toFixed(3)}${k >= 1 ? "(상한)" : ""}, ${c - cb >= 0 ? "+" : ""}${f2(c - cb)}`; };
    for (const id of NAMES.filter((n) => n !== "069500(근사)")) {
      const d = decOf(id), s0 = ix.map((i) => d.r[i]), a = ix.map((i) => d.ra[i]), b = ix.map((i) => d.rb[i]);
      console.log(`| ${id} | ${cell(s0, bb)} | ${cell(a, bb)} | ${cell(a, bk)} | ${cell(b, bb)} | ${cell(b, bk)} |`);
    }
  }
  // ---- A5. P2·R1이 두 종목 없이도 K200P ex-두 종목을 이기는가 ----
  console.log(`\n##### A5. P2·R1(참고 Q2)이 두 종목 없이도 K200P ex-두 종목을 이기는가 (CAGR 우위 %p / MDD 차이 %p, MDD 차이가 음수면 전략 낙폭이 작다) #####\n| 구간 | K200P ex CAGR / MDD | P2 (a) | P2 (b) | R1 (a) | R1 (b) | Q2 (a) | Q2 (b) |\n|---|---|---|---|---|---|---|---|`);
  for (const [wn, w] of WINS) {
    const ix = idxIn(w), kx = ix.map((i) => idxEx[i]), ck = cagrR(kx, w), mk = mddR(kx);
    const cell = (s: number[]): string => { const c = cagrR(s, w), m = mddR(s); return `${c - ck >= 0 ? "+" : ""}${f2(c - ck)} / ${m - mk >= 0 ? "+" : ""}${f2(m - mk)}`; };
    console.log(`| ${wn} | ${f2(ck)} / ${f2(mk)} | ${(["P2", "R1", "Q2"] as const).map((id) => `${cell(ix.map((i) => decOf(id).ra[i]))} | ${cell(ix.map((i) => decOf(id).rb[i]))}`).join(" | ")} |`);
  }
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ") || "없음"} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시도 번호 소진 없음`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 CAPREC: 자본 재활용 배분 Q1(257)·Q2(258)·Q3(259). 후보당 1회 실행.
 * 사전 등록: docs/research/capital-recycling-prereg.md. 구성요소 PE4·W3·LV1·L3는 연구 ALLOC(scripts/research-strategy-allocation.ts)의 정의를 그대로 옮겨 같은 설정으로 다시 돌리고,
 * 일별 순수익 해시(연구 ALLOC 사전등록 기록)와 공통 평가 구간 성적이 기록과 같은지 확인한다(다르면 중단). PE4는 일별 투입 비율 f_t(계좌 자본 중 보유 비중)와 투입된 자본 수익률로 분리해 저장한다.
 * 배분: 계좌 = PE4 비중 W + 코어. 매일 종가에 PE4 슬리브를 W × f_t × 계좌 가치로 맞추고 나머지는 코어(균등, 매일 되돌림)에 둔다. 이동 금액의 0.25% 비용.
 * 가격은 고정 스냅샷·069500 보조 파일, PE4 재무·공시·월말 목록은 부분집합 캐시, W3 점수는 저장된 WFR 점수만 읽는다(Storage 읽기 0). DB·Storage 쓰기 0.
 * 환경 변수 ALLOC_MODE=repro: 구성요소 재현·PE4 분해 저장·P2 재계산 확인만 하고 후보 성과는 계산하지 않는다(사전 점검).
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
import { CAPREC_PRIOR_TESTS, CAPREC_COMP_CUT_REF, CAPREC_P2_REF, CAPREC_MOVE_COST, CAPREC_MOVE_COST_SENS, CAPREC_F_DENOMINATOR, CAPREC_W_NEIGHBOR, CAPREC_F_QUANTILES, CAPREC_CANDS } from "@/lib/capitalRecyclingConfig";
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
/** PE4 분해: f = 그날 종가 체결 뒤 투입 비율(보유 평가액 ÷ 계좌), rHold = 투입된 자본의 거래비용 차감 전 수익률(소수). 일수익률 = 전일 f × rHold − 거래비용(계좌 대비). */
interface PeSl extends Sl { f: number[]; rHold: number[] }
interface QAlloc { run: SimRun; cost: number[]; moved: number[]; wP: number[]; wClose: number[][] }
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
  const outDir = process.env.ALLOC_OUT_DIR?.trim() || ".capr-returns";
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
  // 이전 연구의 일별 순수익 캐시(있으면)와 파일 해시 대조
  const refDir = process.env.ALLOC_REF_DIR?.trim();
  if (refDir) {
    const lines: string[] = [];
    for (const cp of comps) {
      try { lines.push(`${cp.id} ${sha(await fs.readFile(path.join(refDir, `${cp.id}.json`))) === seriesSha[cp.id] ? "일치" : "불일치"}`); } catch { lines.push(`${cp.id} 파일 없음`); }
    }
    console.log(`이전 연구 일별 순수익 캐시(${refDir}) 파일 해시 대조: ${lines.join(" | ")}${lines.some((l) => l.endsWith("불일치")) ? " — 불일치, 중단" : ""}`);
    if (lines.some((l) => l.endsWith("불일치"))) throw new Error("이전 연구 일별 순수익 캐시와 다르다");
  } else console.log("이전 연구 일별 순수익 캐시 복원 없음(캐시가 지워졌거나 복원하지 않음) — 재계산 해시를 ALLOC 사전등록 기록과 대조해 통과");

  // ---- 2. 공통 평가 시작으로 자르기 + PE4 분해 ----
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
  /** 투입 비율 f와 투입된 자본 수익률 rHold로 분해: 일수익률 = 전일 f × rHold − 거래비용(계좌 대비). 전일 f가 0이면 rHold = 0(그날 수익률은 거래비용뿐). */
  const peFrom = (ret: ArrayLike<number>, costFrac: ArrayLike<number>, f: ArrayLike<number>, fPrev0: number, base?: Sl): PeSl => {
    const n = ret.length, rHold = new Array<number>(n);
    for (let i = 0; i < n; i++) { const fp = i === 0 ? fPrev0 : f[i - 1]; rHold[i] = fp > 1e-12 ? (ret[i] / 100 + costFrac[i]) / fp : 0; }
    return { dates: dates0, ret: Array.from(ret), costFrac: Array.from(costFrac), nPos: base?.nPos ?? zeros, inv: base?.inv ?? zeros, turn: base?.turn ?? zeros, wMax: base?.wMax ?? zeros, f: Array.from(f), rHold };
  };
  const peSplit = (r: SimRun): PeSl => {
    const k0 = r.dates.findIndex((d) => d >= FULL.from), base = slice(r);
    return peFrom(base.ret, base.costFrac, r.inv.slice(k0), k0 > 0 ? r.inv[k0 - 1] : 0, base);
  };
  const baseSl = new Map(comps.map((cp) => [cp.id, getSl(cp, 1)]));
  const dates0 = baseSl.get("PE4")!.dates;
  for (const [id, s] of baseSl) if (s.dates.length !== dates0.length || s.dates.some((d, k) => d !== dates0[k])) throw new Error(`${id} 날짜가 PE4와 다르다`);
  const nDays = dates0.length;
  for (let i = 0; i < nDays; i++) zeros.push(0);
  const dateIdx = new Map(dates0.map((d, i) => [d, i]));
  const peOf = (cp: Comp, lag: number, repl?: Set<string>): PeSl => peSplit(getRun(cp, lag, repl));
  const pe4 = comps.find((c) => c.id === "PE4")!;
  const peBase = peOf(pe4, 1);
  let resid = 0;
  for (let i = 0; i < nDays; i++) { const fp = i === 0 ? 0 : peBase.f[i - 1]; resid = Math.max(resid, Math.abs(fp * peBase.rHold[i] - peBase.costFrac[i] - peBase.ret[i] / 100)); }
  { const fs0 = peBase.f; const sorted = [...fs0].sort((a, b) => a - b);
    console.log(`PE4 분해 검증: 일수익률 = 전일 f × rHold − 거래비용, 최대 잔차 ${resid.toExponential(2)} (전일 f = 0인 날 rHold = 0) | f 평균 ${f2(avg(fs0) * 100)}%, f = 0인 날 ${fs0.filter((x) => x < 1e-12).length}/${nDays}일, f 최대 ${f2(sorted[sorted.length - 1] * 100)}%`);
    if (resid > 1e-9) throw new Error("PE4 분해 잔차가 크다 — 중단"); }
  const splitBody = JSON.stringify({ id: "PE4", note: "PE4 분해(공통 평가 구간): f = 종가 체결 뒤 투입 비율, rHold = 투입된 자본의 거래비용 차감 전 수익률(소수), costFrac = 거래비용(계좌 대비), ret = 일수익률(%)", dates: dates0, f: peBase.f, rHold: peBase.rHold, costFrac: peBase.costFrac, ret: peBase.ret });
  await fs.writeFile(path.join(outDir, "PE4_split.json"), splitBody);
  console.log(`PE4 분해 파일 ${outDir}/PE4_split.json SHA-256 ${sha(splitBody)}`);

  // 공통 평가 구간(2017-04-04~) 성적이 연구 ALLOC 보고 표와 같은지 확인
  console.log(`\n구성요소 공통 평가 구간(${FULL.from}~) 전체 CAGR / MDD 재현 (연구 ALLOC 보고 표)\n| 구성요소 | 이번 | 기록 | 일치 |\n|---|---|---|---|`);
  const mism2: string[] = [];
  for (const cp of comps) {
    const bq = baseSl.get(cp.id)!, s = h.st({ dates: bq.dates, ret: bq.ret }, FULL), rec = CAPREC_COMP_CUT_REF[cp.id as keyof typeof CAPREC_COMP_CUT_REF];
    const ok = f2(s.cagr) === f2(rec.cagr) && f2(s.mdd) === f2(rec.mdd);
    if (!ok) mism2.push(cp.id);
    console.log(`| ${cp.id} | ${f2(s.cagr)} / ${f2(s.mdd)} | ${rec.cagr.toFixed(2)} / ${rec.mdd.toFixed(2)} | ${ok ? "일치" : "불일치"} |`);
  }
  if (mism2.length) throw new Error(`공통 구간 재현 불일치(${mism2.join(", ")}) — 중단하고 보고한다`);

  // ---- 3a. 연구 ALLOC 방식(P2: 4개 균등, 매일 재배분) 재계산: 재현 확인과 비교 열 ----
  const combineP = (parts: { sl: Sl; w: number }[], rate: number): SimRun => {
    const k = parts.length, s = parts.map((p) => p.w), pending = parts.map(() => 0);
    const ret: number[] = [];
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
  { const s = h.st(p2Run, FULL), ok = f2(s.cagr) === f2(CAPREC_P2_REF.cagr) && f2(s.mdd) === f2(CAPREC_P2_REF.mdd);
    console.log(`P2(연구 ALLOC, 4개 균등·매일 재배분·이동 금액의 0.25%) 재계산: ${f2(s.cagr)} / ${f2(s.mdd)} (기록 ${CAPREC_P2_REF.cagr.toFixed(2)} / ${CAPREC_P2_REF.mdd.toFixed(2)}) → ${ok ? "일치" : "불일치"}`);
    if (!ok) throw new Error("P2 재계산이 연구 ALLOC 기록과 다르다 — 중단"); }
  if (REPRO) {
    console.log(`\n사전 점검 종료: 구성요소 4개 재현(원래 시작·공통 구간)·일별 순수익 해시·PE4 분해·P2 재현 모두 일치. 후보 Q1~Q3 성과는 계산하지 않았다 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시도 번호 소진 없음`);
    return;
  }

  // ---- 3. 자본 재활용 배분 ----
  /** PE4 슬리브 S_p = W × f × 계좌, 코어 슬리브들 = 나머지를 균등. 하루 순서: 수익 반영 → 전일 정한 코어 균등 이동 → PE4 슬리브를 W × f(그날 종가) × 계좌로 맞추는 이동(코어에서 비례로 조달·반납) → 이동 금액 × rate를 모든 슬리브에서 비례 차감 → 코어 균등 이동량을 다음 날용으로 정함. */
  const qCombine = (pe: PeSl, core: { sl: Sl }[], W: number, rate: number, extra?: { trades: SimTrade[]; entryCs: number[]; haltSkip: number; exitDefer: number }): QAlloc => {
    const m = core.length;
    let Sp = 0;
    const Sk = core.map(() => 1 / m); // 초기(2017-04-03 종가): PE4는 전부 현금이라 투입 비율 0, 계좌 전부 코어
    let pend = core.map(() => 0);
    const ret: number[] = [], costFrac: number[] = [], nPos: number[] = [], inv: number[] = [], turn: { d: string; v: number }[] = [], wMax: number[] = [], cost: number[] = [], moved: number[] = [], wP: number[] = [];
    const wClose = core.map(() => new Array<number>(nDays));
    for (let i = 0; i < nDays; i++) {
      const Vprev = Sp + Sk.reduce((a, x) => a + x, 0), N = W * Vprev, spPrev = Sp / Vprev, wPrev = Sk.map((x) => x / Vprev);
      Sp = Sp * (1 + pe.rHold[i]) - N * pe.costFrac[i];
      for (let j = 0; j < m; j++) Sk[j] *= 1 + core[j].sl.ret[i] / 100;
      let mv1 = 0;
      if (pend.some((x) => x !== 0)) for (let j = 0; j < m; j++) { Sk[j] += pend[j]; if (pend[j] > 0) mv1 += pend[j]; }
      const Vpre = Sp + Sk.reduce((a, x) => a + x, 0);
      const target = W * pe.f[i] * Vpre, dp = target - Sp, Ct = Vpre - Sp;
      for (let j = 0; j < m; j++) Sk[j] -= (dp * Sk[j]) / Ct;
      Sp = target;
      const mv2 = Math.abs(dp), cs = rate * (mv1 + mv2), kappa = cs / Vpre;
      Sp *= 1 - kappa;
      for (let j = 0; j < m; j++) Sk[j] *= 1 - kappa;
      const V = Vpre * (1 - kappa);
      ret.push((V / Vprev - 1) * 100);
      const Cn = Sk.reduce((a, x) => a + x, 0);
      pend = Sk.map((x) => Cn / m - x);
      for (let j = 0; j < m; j++) wClose[j][i] = Sk[j] / V;
      wP.push(Sp / V);
      cost.push(cs / Vprev); moved.push((mv1 + mv2) / Vprev);
      costFrac.push(W * pe.costFrac[i] + wPrev.reduce((a, w, j) => a + w * core[j].sl.costFrac[i], 0) + cs / Vprev);
      nPos.push(pe.nPos[i] + core.reduce((a, c) => a + c.sl.nPos[i], 0));
      inv.push(Sp / V + core.reduce((a, c, j) => a + wClose[j][i] * c.sl.inv[i], 0));
      turn.push({ d: dates0[i], v: W * pe.turn[i] + wPrev.reduce((a, w, j) => a + w * core[j].sl.turn[i], 0) + (mv1 + mv2) / Vprev });
      const wm = [W * pe.wMax[i], ...core.map((c, j) => wPrev[j] * c.sl.wMax[i])].filter(Number.isFinite);
      wMax.push(wm.length ? Math.max(...wm) : NaN);
      void spPrev;
    }
    return { run: { dates: dates0, ret, costFrac, nPos, inv, turn, trades: extra?.trades ?? [], entryCs: extra?.entryCs ?? [], wMax, haltSkip: extra?.haltSkip ?? 0, exitDefer: extra?.exitDefer ?? 0 }, cost, moved, wP, wClose };
  };
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
  const tradeMeta = (list: { cp: Comp; w: number }[], lag: number, repl: boolean): { trades: SimTrade[]; entryCs: number[]; haltSkip: number; exitDefer: number } => {
    const trades: SimTrade[] = [], entryCs: number[] = [];
    let haltSkip = 0, exitDefer = 0;
    for (const { cp, w } of list) {
      const r = getRun(cp, lag, repl ? replSet(cp) : undefined);
      for (const t of r.trades) trades.push({ ...t, vAtEntry: t.vAtEntry / w });
      entryCs.push(...r.entryCs); haltSkip += r.haltSkip; exitDefer += r.exitDefer;
    }
    return { trades, entryCs, haltSkip, exitDefer };
  };

  // ---- 게이트 F: 구성요소별 원래 시험의 무작위 대조(같은 시드·같은 정의, 1,000회)를 같은 번호끼리 합친다 ----
  const randCache = new Map<CId, { ret: Float64Array; cost: Float64Array; f: Float64Array; fPrev0: number }[]>();
  const randOf = (cp: Comp): { ret: Float64Array; cost: Float64Array; f: Float64Array; fPrev0: number }[] => {
    let a = randCache.get(cp.id);
    if (!a) {
      const base = getRun(cp, 1), ob = new Map<number, number>();
      for (const c of base.entryCs) ob.set(c - 1, (ob.get(c - 1) ?? 0) + 1);
      const rng = mulberry32(KSS_R3_SEED);
      a = [];
      for (let k = 0; k < KSS_R3_DRAWS; k++) {
        const r = cp.random(rng, ob), k0 = r.dates.findIndex((d) => d >= FULL.from);
        a.push({ ret: Float64Array.from(r.ret.slice(k0)), cost: Float64Array.from(r.costFrac.slice(k0)), f: Float64Array.from(r.inv.slice(k0)), fPrev0: k0 > 0 ? r.inv[k0 - 1] : 0 });
      }
      randCache.set(cp.id, a);
      console.log(`  [F] ${cp.id} 무작위 대조 ${KSS_R3_DRAWS}회 준비(${((Date.now() - T0) / 60000).toFixed(1)}분 경과)`);
    }
    return a;
  };
  const constSl = (ret: Float64Array): Sl => ({ dates: dates0, ret: Array.from(ret), costFrac: zeros, nPos: zeros, inv: zeros, turn: zeros, wMax: zeros });

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
  const inWin = (d: string, w: Win): boolean => d >= w.from && d <= w.to;
  const hVs = (full: { cagr: number; mdd: number }, rb: { cagr: number; mdd: number }): { ok: boolean; text: string } => {
    const dc = full.cagr - rb.cagr, dm = rb.mdd - full.mdd;
    const c1 = dc >= PEAD_H_CAGR_GAIN_PP, c2 = dm >= PEAD_H_MDD_GAIN_PP && dc >= -PEAD_H_CAGR_FLOOR_PP;
    return { ok: c1 || c2, text: `CAGR ${dc >= 0 ? "+" : ""}${f2(dc)}%p, MDD ${dm >= 0 ? "−" : "+"}${f2(Math.abs(dm))}%p(개선 ${f2(dm)}%p; ${PEAD_H_MDD_GAIN_STRONG_PP}%p 이상 ${dm >= PEAD_H_MDD_GAIN_STRONG_PP ? "O" : "X"}) → 조건1(CAGR +${PEAD_H_CAGR_GAIN_PP}%p) ${c1 ? "O" : "X"}, 조건2(MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p) ${c2 ? "O" : "X"}` };
  };
  const pct = (a: number, b: number): string => f2((a / Math.max(b, 1)) * 100);
  const quant = (v: number[], ps: readonly number[]): string => { const a = [...v].sort((x, y) => x - y); return ps.map((p) => `${Math.round(p * 100)}%=${a.length ? f2(a[Math.min(Math.floor(a.length * p), a.length - 1)] * 100) : "-"}`).join(" / "); };
  const allocBase = new Map<string, QAlloc>();
  const fmtW = (W: number): string => `${f2(W * 100)}%`;

  const WIN = W;
  const mkSpec = (qid: "Q1" | "Q2" | "Q3"): CandSpec => {
    const cd = CAPREC_CANDS[qid], Wq = cd.w, coreCps = cd.core.map((id) => compOf.get(id as CId)!);
    const metaList = (core: Comp[], Wc: number): { cp: Comp; w: number }[] => [{ cp: pe4, w: Wc }, ...core.map((cp) => ({ cp, w: (1 - Wc) / core.length }))];
    const runQ = (o: { lag: number; replace?: Set<string> }): QAlloc => {
      const repl = !!o.replace;
      const pe = repl ? peOf(pe4, 1, replSet(pe4)) : peOf(pe4, o.lag);
      const core = coreCps.map((cp) => ({ sl: repl ? getSl(cp, 1, replSet(cp)) : getSl(cp, o.lag) }));
      return qCombine(pe, core, Wq, CAPREC_MOVE_COST, tradeMeta(metaList(coreCps, Wq), repl ? 1 : o.lag, repl));
    };
    const variants: { label: string; Wq: number; core: Comp[] }[] = [
      { label: `PE4 비중 ${fmtW(Wq - CAPREC_W_NEIGHBOR)}`, Wq: Wq - CAPREC_W_NEIGHBOR, core: coreCps },
      { label: `PE4 비중 ${fmtW(Wq + CAPREC_W_NEIGHBOR)}`, Wq: Wq + CAPREC_W_NEIGHBOR, core: coreCps },
      ...coreCps.map((drop) => ({ label: `코어에서 ${drop.id} 제외 (코어 ${coreCps.filter((c) => c !== drop).map((c) => c.id).join("+")})`, Wq, core: coreCps.filter((c) => c !== drop) })),
    ];
    let drawK = 0;
    return {
      id: qid, trial: cd.trial,
      title: `PE4 비중 ${fmtW(Wq)} (실제 보유 비중 f_t × W만 PE4에 투입, 나머지는 코어) + 코어 ${cd.core.join("+")} 균등(매일 되돌림), 이동 금액의 ${CAPREC_MOVE_COST * 100}%`,
      defense: false, capFrac: 1 / 10, fDenominator: CAPREC_F_DENOMINATOR, ref: { id: "069500", run: bhAsRun },
      hRule: (full, rb) => { const a = hVs(full, rb), p2 = h.st(p2Run, FULL), pe = h.st(compSer.get("PE4")!, FULL); return { ok: a.ok, note: `${a.text} | 참고(판정 아님): P2 ${f2(p2.cagr)} / ${f2(p2.mdd)} 대비 CAGR ${full.cagr - p2.cagr >= 0 ? "+" : ""}${f2(full.cagr - p2.cagr)}%p, MDD ${full.mdd - p2.mdd >= 0 ? "+" : ""}${f2(full.mdd - p2.mdd)}%p | PE4 단독 ${f2(pe.cagr)} / ${f2(pe.mdd)} 대비 CAGR ${full.cagr - pe.cagr >= 0 ? "+" : ""}${f2(full.cagr - pe.cagr)}%p, MDD ${full.mdd - pe.mdd >= 0 ? "+" : ""}${f2(full.mdd - pe.mdd)}%p` }; },
      run: (o) => { const a = runQ(o); if (o.lag === 1 && o.detail && !o.replace) allocBase.set(qid, a); return a.run; },
      neighbors: variants.map((v) => ({ label: v.label, run: () => qCombine(peBase, v.core.map((cp) => ({ sl: getSl(cp, 1) })), v.Wq, CAPREC_MOVE_COST).run })),
      random: () => {
        const k = drawK++ % KSS_R3_DRAWS, pd = randOf(pe4)[k];
        return qCombine(peFrom(pd.ret, pd.cost, pd.f, pd.fPrev0), coreCps.map((cp) => ({ sl: constSl(randOf(cp)[k].ret) })), Wq, CAPREC_MOVE_COST).run;
      },
      reasons: [], label,
      extra: (run) => {
        const al = allocBase.get(qid)!, list = metaList(coreCps, Wq);
        console.log(`${qid} 게이트 C 해석(사전등록): PE4(f_t·투입 수익률 포함)와 코어 구성요소 모두 원래 규칙을 하루 지연(lag 2)해 돌린 순수익으로 같은 배분 규칙을 적용했다.`);
        console.log(`${qid} 게이트 E 해석(사전등록): 위 "E:" 줄의 상위 3개 거래 이름은 합산 계좌 기준 표시일 뿐이고, 실제 대체는 구성요소마다 평가 구간에 닫힌 거래 중 구성요소 계좌 대비 손익 상위 3개를 069500 수익률로 바꾼 것이다(PE4는 대체 후 f_t·투입 수익률도 다시 만든다): ${list.map(({ cp }) => `${cp.id} [${[...replSet(cp)].map((k) => { const [code, ec] = k.split("|"); const t = getRun(cp, 1).trades.find((x) => x.code === code && String(x.entryC) === ec)!; return `${label(code)} ${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`; }).join(", ")}]`).join(" / ")}`);
        console.log(`${qid} 게이트 F 해석(사전등록): 구성요소마다 원래 시험의 무작위 대조(같은 신호일·주문 수, 같은 청산 규칙, 시드 ${KSS_R3_SEED}, ${KSS_R3_DRAWS}회)를 같은 번호끼리 합쳐(PE4는 무작위 실행의 f_t·투입 수익률 포함) 같은 배분 규칙을 적용했다.`);
        console.log(`${qid} 게이트 G: 진입 건수는 구성요소 진입 건수의 합(평가 시작 이후 ${list.map(({ cp }) => `${cp.id} ${getRun(cp, 1).entryCs.filter((c) => CAL[c] >= FULL.from).length}`).join(" + ")})`);
        const yrs = (Date.parse(h.dataEnd) - Date.parse(FULL.from)) / 86_400_000 / 365.25;
        const sumCost = al.cost.reduce((a, x) => a + x, 0) * 100, sumMv = al.moved.reduce((a, x) => a + x, 0) * 100;
        console.log(`${qid} 이동·비용: 이동 금액 합(계좌 대비 %) ${f2(sumMv)} (연 ${f2(sumMv / yrs)}) | 이동이 있었던 날 ${al.moved.filter((x) => x > 0).length}/${nDays}일 | 이동 비용 합계 ${f2(sumCost)}%p (연 ${f2(sumCost / yrs)}%p; 이동 금액의 ${CAPREC_MOVE_COST * 100}%) | 구성요소 내부 거래 비용은 각 순수익에 이미 반영`);
        const sens = h.st(qCombine(peBase, coreCps.map((cp) => ({ sl: getSl(cp, 1) })), Wq, CAPREC_MOVE_COST_SENS).run, FULL), zero = h.st(qCombine(peBase, coreCps.map((cp) => ({ sl: getSl(cp, 1) })), Wq, 0).run, FULL), jf = h.st(run, FULL);
        console.log(`${qid} [정보용, 판정 불사용] 이동 금액의 ${CAPREC_MOVE_COST_SENS * 100}% 적용: ${f2(sens.cagr)} / ${f2(sens.mdd)} | 이동 비용 0: ${f2(zero.cagr)} / ${f2(zero.mdd)} | 판정값(${CAPREC_MOVE_COST * 100}%): ${f2(jf.cagr)} / ${f2(jf.mdd)}`);
        console.log(`${qid} PE4 투입 비율 f_t 분포(계좌 대비 Wq × f_t = PE4 슬리브 비중; f_t = PE4 계좌 자본 중 보유 비중, 분위 ${CAPREC_F_QUANTILES.map((p) => Math.round(p * 100)).join("/")}%, %)\n| 구간 | f 평균 | f 분위 | f = 0인 날 | PE4 슬리브 평균 계좌 비중 Wq × f | 코어 평균 계좌 비중 |\n|---|---|---|---|---|---|`);
        for (const [wn, w] of WIN.ALL) {
          const idx: number[] = [];
          for (let i = 0; i < nDays; i++) if (inWin(dates0[i], w)) idx.push(i);
          const fv = idx.map((i) => peBase.f[i]);
          console.log(`| ${wn} | ${f2(avg(fv) * 100)} | ${quant(fv, CAPREC_F_QUANTILES)} | ${fv.filter((x) => x < 1e-12).length}/${idx.length} | ${f2(avg(idx.map((i) => al.wP[i])) * 100)} | ${f2((1 - avg(idx.map((i) => al.wP[i]))) * 100)} |`);
        }
        console.log(`${qid} 계좌 단위 평균 투자 비중 / 현금 비중 % (PE4 슬리브는 전부 투자, 코어 구성요소는 각자의 투자 비중 × 슬리브 비중)\n| 구간 | 평균 투자 비중 | 현금 비중 | 구성요소별 평균 투자 비중 PE4 ${cd.core.join(" / ")} |\n|---|---|---|---|`);
        for (const [wn, w] of WIN.ALL) {
          const s = h.st(run, w);
          console.log(`| ${wn} | ${f2(s.avgInv)} | ${f2(100 - s.avgInv)} | ${[pe4, ...coreCps].map((cp) => { const q = baseSl.get(cp.id)!; return f2(h.st({ dates: q.dates, ret: q.ret, inv: q.inv }, w).avgInv); }).join(" / ")} |`);
        }
        console.log(`${qid} 낙폭 상위 3개 구간 (고점 → 저점 → 회복)`);
        const topEp = (ser: { dates: string[]; ret: number[] }, name: string): void => {
          const dts = ser.dates, eps = episodes(ser.ret).sort((a, b) => b.depth - a.depth).slice(0, 3);
          console.log(`  ${name}: ${eps.map((e, kk) => `${kk + 1}) 고점 ${e.peakIdx < 0 ? FULL.from : dts[e.peakIdx]} → 저점 ${dts[e.troughIdx]} ${f2(e.depth * 100)}% → 회복 ${e.recIdx === null ? "미회복" : dts[e.recIdx]}`).join(" | ")}`);
        };
        topEp(run, qid); topEp(bhFrom, "069500(새)"); topEp(p2Run as unknown as { dates: string[]; ret: number[] }, "P2(재계산)");
        for (const { cp } of list) topEp(compSer.get(cp.id)!, `${cp.id} 단독`);
        console.log(`${qid} 하락 구간 성과 (누적 % / MDD %): ${qid} | 069500 | P2 | ${list.map(({ cp }) => `${cp.id} 단독`).join(" | ")}`);
        for (const [name, f, t] of PEAD_DOWNTURNS) console.log(`  ${name}: ${qid} ${h.periodStat(run, f, t)} | 069500 ${h.periodStat(bhFrom, f, t)} | P2 ${h.periodStat(p2Run as unknown as { dates: string[]; ret: number[] }, f, t)} | ${list.map(({ cp }) => `${cp.id} ${h.periodStat(compSer.get(cp.id)!, f, t)}`).join(" | ")}`);
        // 종목 비중·중복: PE4 계좌 비중 = 슬리브 비중 ÷ f × 보유 비율 = Wq × 보유 비율(PE4 계좌 대비), 코어 = 슬리브 비중 × 보유 비율
        const wsum = new Map<string, number>(), byComp = new Map<string, number[]>(), multiDays = new Map<string, number>(), heldDays = new Map<string, number>();
        let anyOverlapDays = 0, overlapW = 0, investedW = 0;
        for (let i = 0; i < nDays; i++) {
          const day = new Map<string, { w: number; n: number }>();
          const add = (j: number, code: string, ww: number): void => {
            const e = day.get(code) ?? { w: 0, n: 0 };
            e.w += ww; e.n++; day.set(code, e);
            wsum.set(code, (wsum.get(code) ?? 0) + ww);
            const bc = byComp.get(code) ?? list.map(() => 0); bc[j] += ww; byComp.set(code, bc);
          };
          for (const [code, f] of holdOf(pe4)[i]) add(0, code, Wq * f);
          coreCps.forEach((cp, j) => { for (const [code, f] of holdOf(cp)[i]) add(j + 1, code, al.wClose[j][i] * f); });
          let ov = false;
          for (const [code, e] of day) { heldDays.set(code, (heldDays.get(code) ?? 0) + 1); investedW += e.w; if (e.n >= 2) { ov = true; overlapW += e.w; multiDays.set(code, (multiDays.get(code) ?? 0) + 1); } }
          if (ov) anyOverlapDays++;
        }
        const wavg = (code: string): number => ((wsum.get(code) ?? 0) / nDays) * 100;
        console.log(`${qid} 일별 평균 계좌 비중(현금 날 포함; ${nDays}일): 삼성전자 ${f2(wavg(SAMSUNG))}% · SK하이닉스 ${f2(wavg(HYNIX))}% · 합 ${f2(wavg(SAMSUNG) + wavg(HYNIX))}% | 투자분 중 두 종목 비중 ${f2(((wsum.get(SAMSUNG) ?? 0) + (wsum.get(HYNIX) ?? 0)) / Math.max(investedW, 1e-12) * 100)}%`);
        console.log(`${qid} 같은 종목 중복 보유: 둘 이상의 구성요소가 같은 종목을 든 날 ${anyOverlapDays}/${nDays}일(${pct(anyOverlapDays, nDays)}%) | 중복된 종목-날의 계좌 비중 합 ÷ 전체 투자 비중 합 = ${f2(overlapW / Math.max(investedW, 1e-12) * 100)}%`);
        console.log(`${qid} 계좌 합산 평균 비중 상위 10개 종목\n| 종목 | 평균 계좌 비중 % | 구성요소별 평균 기여 % (${list.map(({ cp }) => cp.id).join(" / ")}) | 보유한 날 | 그중 둘 이상 구성요소가 동시에 든 날 |\n|---|---|---|---|---|`);
        for (const [code, v] of [...wsum].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`| ${label(code)} | ${f2((v / nDays) * 100)} | ${byComp.get(code)!.map((x) => f2((x / nDays) * 100)).join(" / ")} | ${heldDays.get(code)} | ${multiDays.get(code) ?? 0} |`);
        const tr = tradeMeta(list, 1, false).trades.filter((t) => CAL[t.exitC] >= FULL.from).map(pnlOf);
        const tot = tr.reduce((a, x) => a + x, 0), top10 = [...tr].sort((a, b) => b - a).slice(0, 10).reduce((a, x) => a + x, 0);
        console.log(`${qid} 상위 10개 거래 손익 비중(평가 구간에 닫힌 ${tr.length}건, 구성요소 계좌 대비 손익 × 명목 비중[PE4 Wq, 코어 (1−Wq) ÷ 코어 수]로 환산한 근사): 전 거래 손익 합 ${f2(tot * 100)}%p 중 상위 10개 ${f2(top10 * 100)}%p = ${f2(tot !== 0 ? (top10 / tot) * 100 : NaN)}%`);
        void median;
      },
    };
  };

  const specs: CandSpec[] = [], verdicts: Verdict[] = [];
  for (const qid of ["Q1", "Q2", "Q3"] as const) { const sp = mkSpec(qid); specs.push(sp); verdicts.push(evaluate(h, W, sp)); }

  // ---- 공통 보고 ----
  const p2Ser = p2Run as unknown as { dates: string[]; ret: number[] };
  console.log(`\n=== 구간별 CAGR / MDD — 069500(새 기준선) · P2(연구 ALLOC 재계산) · 구성요소 단독(${FULL.from}부터 자른 것) · 후보 ===\n| 구간 | 069500 | P2 | ${ALLOC_COMP_IDS.join(" | ")} | ${verdicts.map((v) => v.id).join(" | ")} |\n|---|---|---|${ALLOC_COMP_IDS.map(() => "---").join("|")}|${verdicts.map(() => "---").join("|")}|`);
  for (const [wn, w] of [...W.ALL, ["2026년 제외 (~2025-12-31)", ex26] as [string, Win]]) {
    const cell = (r: { dates: string[]; ret: number[] }): string => { const s = h.st(r, w); return `${f2(s.cagr)} / ${f2(s.mdd)}`; };
    console.log(`| ${wn} | ${cell(h.bhP)} | ${cell(p2Ser)} | ${ALLOC_COMP_IDS.map((id) => cell(compSer.get(id)!)).join(" | ")} | ${verdicts.map((v) => cell(v.run)).join(" | ")} |`);
  }
  console.log(`\n구간별 최악 12개월 %: ${W.ALL.map(([wn, w]) => `${wn} — 069500 ${f2(h.worst12(h.bhP, w))}, P2 ${f2(h.worst12(p2Ser, w))}, ${ALLOC_COMP_IDS.map((id) => `${id} ${f2(h.worst12(compSer.get(id)!, w))}`).join(", ")}, ${verdicts.map((v) => `${v.id} ${f2(h.worst12(v.run, w))}`).join(", ")}`).join(" | ")}`);
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: CAPREC_PRIOR_TESTS });
  yearlyTable(h, W, [{ id: "P2(재계산)", run: p2Ser as unknown as SimRun }, ...ALLOC_COMP_IDS.map((id) => ({ id: `${id} 단독`, run: compSer.get(id)! as unknown as SimRun })), ...verdicts.map((v) => ({ id: v.id, run: v.run }))]);
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ") || "없음"} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${verdicts.map((v) => v.trial).join(", ")}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

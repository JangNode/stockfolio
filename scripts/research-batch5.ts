/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 묶음 5: RM1(잔차 모멘텀)·LR1(바닥 탈출)·PF1(우선주 괴리)·TS1(신고가 추세 추종)·MV1(최소분산)·BS1(지루한 주식). 사전 등록: docs/research/batch5-prereg.md (정의 커밋 f5c2668, 첫 시험 전).
 * 월간·분기 목표 비중 전략은 lib/rebalSim.ts, TS1은 lib/slotSim.ts, C 형태는 DS6 코어(연구 DS8·DS9와 같은 코드)와 combineCS 규칙으로 합성한다. 게이트 A~H는 scripts/researchGates.ts 그대로.
 * ALLOC_MODE=repro: DS6 재현·신호 독립 대조·체결 타이밍·BS1 단계 2 검증만(성과 미계산) / a: RM1·RM1C·RM1F / b1: LR1·LR1F / b2: PF1·PF1F / b3: TS1 / b4: MV1·MV1C / c: BS1·BS1C. 시험 번호 시작은 B5_TRIAL(기본 294).
 * 공시(DART) 사용 없음, 가격 데이터만, 외부 요청 0, 연구 DB 쓰기 0.
 */
import { createHash } from "node:crypto";
import { simSlots, type SimCand, type SimPos, type SimRun, type SimTrade } from "@/lib/slotSim";
import { L_SLIPPAGE } from "@/lib/megacapTrendConfig";
import { PEAD_H_CAGR_GAIN_PP, PEAD_H_MDD_GAIN_PP, PEAD_H_MDD_GAIN_STRONG_PP, PEAD_H_CAGR_FLOOR_PP } from "@/lib/peadConfig";
import { KSS_R3_DRAWS, KSS_R3_SEED, F_E_TOP_TRADES, F_C_MAX_CAGR_DROP, F_C_MAX_MDD_WORSEN, F_F_MIN_PCTILE } from "@/lib/kodexSectorSatConfig";
import { SAT_MDD_EPS } from "@/lib/satelliteV1Config";
import { rebalSim, type RebalRun } from "@/lib/rebalSim";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET } from "@/lib/investorFlowConfig";
import { PRICE_CORRECTION_PATH, loadPriceOverrides, type PriceOverride, type PriceOverrideFile } from "@/lib/priceCorrection";
import { K200P_CORR_TARGETS, K200P_CORR_CONTROLS, K200P_CORR_CONTROL_MAX_DIFF_PP, K200P_CORR_CONTROL_MAX_SHIFT_DAYS, K200P_CORR_MAX_CALLS, K200P_CORR_SLEEP_MS, KRX_API_BASE } from "@/lib/k200pCorrectionConfig";
import { blockedNow, kst, sleep } from "@/lib/forwardCollectKit";
import { DS13_W, DS13_NB_W, DS13_NB_RM_N, DS13_WIN2, DS13_WATCH } from "@/lib/ds13Config";
import { RT1_P0, RT2_P0, RT1_NB, RT2_NB, RT_BASELINE_MAX_GAP_PP, RT_WATCH, RT_TOP_N_WEIGHT, type RtP } from "@/lib/rt1Config";
import { DQ_LIMIT_CHANGE_DATE, DQ_LIMIT_BEFORE, DQ_LIMIT_AFTER, DQ_LIMIT_TOL, DQ_LISTING_MAX_ROW, DQ_RESUME_MIN_GAP, DQ_LIQUIDATION_ROWS, DQ_MCAP_DIFF_FRAC, DQ_VANISH_WINDOW_DAYS, DQ_VANISH_HALT_DAYS, DQ_VANISH_MIN_CLOSE, DQ_ALT_LAST_ROWS, DQ_ALT_LAST_RETURN, DQ_RECENT_VANISH_DAYS, DQ_LIST_MAX, DQ_RECOVER_ROWS, DQ_RECOVER_TOL } from "@/lib/dataQualityConfig";
import { solveMinVar, projectCappedSimplex } from "@/lib/minVar";
import { B5_F_DENOMINATOR, B5_CORE_W, B5_MA_DAYS, B5_MA_NB, B5_RM_P0, B5_LR_P0, B5_LR_NB, B5_PF_P0, B5_PF_NB, B5_PF_SLIP, B5_PF_TV_DAYS, B5_TS_P0, B5_TS_NB, B5_TS_CAP, B5_MV_P0, B5_MV_NB, B5_MV_KKT_TOL, B5_MV_MAX_ITER, B5_MV_CHECK_SAMPLES, B5_BS_P0, B5_BS_NB, B5_BS_SLIP_K200, B5_BS_SLIP_OTHER, type RmP, type LrP, type PfP, type TsP, type MvP, type BsP } from "@/lib/batch5Config";
import { capWeights } from "@/lib/coreCapWeights";
import { DS89_DS6_REF, DS8_SMOOTH_WIN, DS89_CORE_W } from "@/lib/ds89Config";
import { CS_MOVE_COST } from "@/lib/coreSatelliteConfig";
import { makeDs13Engine, type Sl, type CoreRun, type Strat, type FCfg } from "@/lib/ds13Engine";
import { downloadBuf, decodeTable } from "@/lib/nBookStore";
import { R_STORE_PREFIX } from "@/lib/kodexSectorSatConfig";
import { selectAll } from "./researchHarness";
import { ZERO_SUSPECT_ON, suspectLog } from "./researchHarness";
import { VB1_P0, VB2_P0, VB1_NB, VB2_NB, VB_FIRST_TRIAL, VB_PRIOR_TESTS, VB_F_DENOMINATOR, VB_COVERAGE_MIN, VB_C2_START, VB_C2_WINDOW1_TO, VB_C2_WINDOW2_FROM, type VbP } from "@/lib/valueConfig";
import { VEQ_DATA_FILE } from "@/lib/valueEquityConfig";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, mulberry32, SNAP_END, f2, avg, median, PRICE_CORRECTION_ON, NEUTRALIZE_ON, type S, type Win } from "./researchHarness";
import { evaluate, summaryReport, type CandSpec, type Verdict, type Windows } from "./researchGates";


const T0 = Date.now();
const sha = (b: Uint8Array | Buffer | string): string => createHash("sha256").update(b).digest("hex");
/** 공통 평가 시작 이후로 자른 일별 계열(구성요소 하나의 계좌 기준). */

async function main(): Promise<void> {
  const MODE = (process.env.ALLOC_MODE ?? "").trim().toLowerCase();
  if (!["repro", "a", "b1", "b2", "b3", "b4", "c", "info", "bsv", "dq", "rtpre", "rt", "kcorr", "kcov", "ds13pre", "ds13", "ds13ex", "ds13rob", "vdata", "vcov", "vpre", "vinfo", "vtest"].includes(MODE)) throw new Error("ALLOC_MODE=repro|a|b1|b2|b3|b4|c|info|bsv|dq|rtpre|rt|kcorr|kcov|ds13pre|ds13|ds13ex|ds13rob|vdata|vcov|vpre|vinfo|vtest 필요");
  const IDS = (process.env.B5_IDS ?? "").trim() ? new Set((process.env.B5_IDS as string).split(",").map((x) => x.trim())) : null;
  if (NEUTRALIZE_ON) console.log(`*** 정보용 중립화 모드(NEUTRALIZE_CODES=${process.env.NEUTRALIZE_CODES}): 해당 종목의 수정 수익률을 전 기간 0으로 둔다(시험 아님) ***`);
  if (PRICE_CORRECTION_ON && MODE !== "ds13pre" && MODE !== "ds13" && MODE !== "ds13ex" && MODE !== "ds13rob" && MODE !== "vdata" && MODE !== "vcov" && MODE !== "vpre" && MODE !== "vinfo" && MODE !== "vtest") console.log(`*** 보정 재채점 모드(PRICE_CORRECTION=k200p17): 정의·관문·이웃값·난수 시드는 그대로, 가격 입력만 보정. 시험 번호는 원 시험 번호 표지이며 누적 시험 횟수에 더하지 않는다. 대상 ID: ${IDS ? [...IDS].join(",") : "전체"} ***`);
  console.log(`연구 묶음 5 ${MODE === "repro" ? "사전 점검(DS6 재현·신호 독립 대조·체결 타이밍, 성과 미계산)" : `블록 ${MODE} 시험`} 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const k200pInfo = await loadK200P(h);
  const { excluded, membAt, nameOf, indOf } = k200pInfo;
  const E = makeDs13Engine(h, k200pInfo);
  const { cPE, NW, FULL, W, env, label, randLV1, mcapNear, lv1Of, zeroSl, coreOf, coreReplSet, combineCS, DS6D, build, rank200, al, nRows, rowAt, bL, filterMult, retFill, medianOf, sdOf, monthEndIdx, isQuarterEnd, pickKeep, equalW, rmSorted, RM1, mvCov, mvStats, MV1, sigDays, startOf, runS, sliceSl, slFromRun, combine2, combineN, d13Of } = E;

  console.log(`연속 평가: 초기 배분 ${CAL[cPE]} 종가(비용 없음), 수익률 집계 ${FULL.from}~${h.dataEnd} | 구간 ${NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);

  // ---- 0. 069500 기준선 ----
  console.log(`\n=== 0. 069500 기준선 (수익 집계 ${FULL.from}~; 원주가, 가격 수익만; 모든 구간의 기준선 시작일 = 해당 구간 시작일; CAGR % / MDD %) ===\n| 구간 | 기준선 첫 수익률 날짜 | 069500 (보조 파일) |\n|---|---|---|`);
  for (const [wn, w] of W.ALL) {
    const b = h.st(h.bhP, w), first = h.bhP.dates.find((d) => d >= w.from);
    console.log(`| ${wn} | ${first} | ${f2(b.cagr)} / ${f2(b.mdd)} |`);
  }
  const bhFrom = { dates: h.bhP.dates.filter((d) => d >= FULL.from), ret: h.bhP.ret.filter((_, k) => h.bhP.dates[k] >= FULL.from) };
  const bhAsRun = { dates: bhFrom.dates, ret: bhFrom.ret } as unknown as SimRun;




  const asRun = (s: Sl): { dates: string[]; ret: number[]; costFrac: number[]; turn: { d: string; v: number }[]; nPos: number[]; inv: number[] } => ({ dates: s.dates, ret: s.ret, costFrac: s.costFrac, turn: s.dates.map((d, i) => ({ d, v: s.turn[i] })), nPos: s.nPos, inv: s.inv });
  const sg = (x: number): string => `${x >= 0 ? "+" : ""}${f2(x)}`;
  const cell = (r: { dates: string[]; ret: number[] }, w: Win): string => { const s = h.st(r, w); return `${f2(s.cagr)} / ${f2(s.mdd)}`; };
  /** 게이트 F: LV1 무작위 대조(같은 신호일·주문 수, 같은 청산 규칙, 시드·횟수 고정) — 평활 설정마다 따로 만든다. */
  const randCache = new Map<string, { full: Float64Array; k0: number }[]>();
  const randOf = (smooth?: number): { full: Float64Array; k0: number }[] => {
    const key = `${smooth ?? "-"}`;
    let a = randCache.get(key);
    if (!a) {
      const base = lv1Of(1, smooth).run, ob = new Map<number, number>();
      for (const c of base.entryCs) ob.set(c - 1, (ob.get(c - 1) ?? 0) + 1);
      const rng = mulberry32(KSS_R3_SEED);
      a = [];
      for (let k = 0; k < KSS_R3_DRAWS; k++) { const r = randLV1(rng, ob, smooth); a.push({ full: Float64Array.from(r.ret), k0: r.dates.findIndex((dd) => dd >= FULL.from) }); }
      randCache.set(key, a);
      console.log(`  [F] LV1${smooth === undefined ? "" : ` 평활 ${smooth}일`} 무작위 대조 ${KSS_R3_DRAWS}회 준비(${((Date.now() - T0) / 60000).toFixed(1)}분 경과)`);
    }
    return a;
  };

  // =====================================================================================================================
  // 묶음 5 공용 자료: K200P 순위, 수정 종가 정렬, 행 존재 누적, 069500 일수익률·지수 수준·이동평균
  // =====================================================================================================================


  // ---- RT1·RT2 (시가총액 비중 + 잔차 모멘텀 기울기) / RT0(기준선: K200P 전 종목 시총 비중) ----
  const mcAt = (s: S, c: number): number => { const i = rowAt(s, c); return i === undefined ? Number.NaN : s.mcapRow[i]; };
  /** 상한 cap으로 시총 비중을 만든다(기존 capWeights). 상한 × 종목 수 < 1이면 균등 비중(방어 규칙). */
  const capW = (mcs: number[], cap: number): number[] => (cap * mcs.length < 1 - 1e-12 ? mcs.map(() => 1 / mcs.length) : capWeights(mcs, cap));
  const rtSorted = (c: number, P: RtP): { code: string; sc: number }[] => rmSorted(c, { ...B5_RM_P0, start: P.start, skip: P.skip, minValid: P.minValid });
  const rtPick = (c: number, held: ReadonlySet<string>, P: RtP): string[] => {
    const sorted = rtSorted(c, P).map((x) => x.code), nS = sorted.length;
    return pickKeep(sorted, held, Math.ceil(P.share * nS), Math.ceil((P.share + P.keepOff) * nS));
  };
  const rtWeights = (c: number, codes: string[], cap: number, m: number): Map<string, number> => {
    const live = codes.filter((code) => { const s = byCode.get(code) as S; return mcAt(s, c) > 0; });
    if (!live.length) return new Map();
    const w = capW(live.map((code) => mcAt(byCode.get(code) as S, c)), cap);
    return new Map(live.map((code, k) => [code, w[k] * m] as [string, number]));
  };
  const RT1: Strat<RtP> = {
    id: "RT1", P0: RT1_P0, nbs: RT1_NB, signalDays: monthEndIdx, isSwap: () => true,
    targets: (c, held, P, m) => rtWeights(c, rtPick(c, held, P), P.cap, m),
    pool: (c, P) => rtSorted(c, P).map((x) => x.code),
    slip: () => L_SLIPPAGE, vanish: "last", wOf: (P) => P.cap,
    wMap: (c, codes, P, m) => rtWeights(c, codes, P.cap, m),
  };
  const RT2: Strat<RtP> = { ...RT1, id: "RT2", P0: RT2_P0, nbs: RT2_NB };
  const RT0: Strat<RtP> = {
    id: "RT0", P0: RT1_P0, nbs: [], signalDays: monthEndIdx, isSwap: () => true,
    targets: (c, _held, P, m) => rtWeights(c, rank200(c).list.map((s) => s.code), P.cap, m),
    pool: (c) => rank200(c).list.map((s) => s.code),
    slip: () => L_SLIPPAGE, vanish: "last", wOf: (P) => P.cap,
  };

  // ---- LR1 ----
  const lrCands = (c: number, P: LrP): { code: string; long: number }[] => {
    const rk = rank200(c), out: { code: string; long: number }[] = [];
    if (c - P.longStart < 0) return out;
    const bRecent = bL[c] / bL[c - P.recent] - 1;
    for (const s of rk.list) {
      const a = al(s);
      if (nRows(s, c - P.longStart, c) < P.minValid) continue;
      const a0 = a[c - P.longStart], a1 = a[c - P.longEnd], a2 = a[c], a3 = a[c - P.recent];
      if (!(a0 > 0 && a1 > 0 && a2 > 0 && a3 > 0)) continue;
      if (!(a2 / a3 - 1 > bRecent)) continue;
      out.push({ code: s.code, long: a1 / a0 - 1 });
    }
    const rr = rk.rank;
    out.sort((x, y) => x.long - y.long || (rr.get(x.code) as number) - (rr.get(y.code) as number));
    return out;
  };
  const LR1: Strat<LrP> = {
    id: "LR1", P0: B5_LR_P0, nbs: B5_LR_NB, signalDays: monthEndIdx, isSwap: isQuarterEnd,
    targets: (c, held, P, m, swap) => (swap ? equalW(pickKeep(lrCands(c, P).map((x) => x.code), held, P.n, P.n * P.keepMult), 1 / P.n, m) : equalW([...held], 1 / P.n, m)),
    pool: (c, P) => lrCands(c, P).map((x) => x.code),
    slip: () => L_SLIPPAGE, vanish: "last", wOf: (P) => 1 / P.n,
  };

  // ---- PF1 ----
  const prefCodes = h.stocks.filter((s) => s.code[s.code.length - 1] === "5" && h.byCode.has(s.code.slice(0, 5) + "0"));
  const pairs = prefCodes.map((p) => ({ p, c: h.byCode.get(p.code.slice(0, 5) + "0") as S }));
  const tvAvg = (s: S, c: number, days: number): number => { let sum = 0; for (let k = Math.max(c - days + 1, 0); k <= c; k++) { const i = s.idx.get(CAL[k]); if (i !== undefined) sum += s.raw[i] * s.vol[i]; } return sum / days; };
  const pfZ = (c: number, pr: { p: S; c: S }, P: PfP): number => {
    const ap = al(pr.p), ac = al(pr.c);
    if (!(ap[c] > 0 && ac[c] > 0)) return Number.NaN;
    const ss: number[] = [];
    for (let k = Math.max(c - P.zWin, 0); k <= c - 1; k++) {
      if (rowAt(pr.p, k) === undefined || rowAt(pr.c, k) === undefined || !(ap[k] > 0 && ac[k] > 0)) continue;
      ss.push(Math.log(ap[k] / ac[k]));
    }
    if (ss.length < 2) return Number.NaN;
    const mu = ss.reduce((x, y) => x + y, 0) / ss.length, sd = sdOf(ss, ss.length);
    return sd > 0 ? (Math.log(ap[c] / ac[c]) - mu) / sd : Number.NaN;
  };
  const pfElig = (c: number, P: PfP): { code: string; z: number }[] => {
    const out: { code: string; z: number }[] = [];
    for (const pr of pairs) {
      const ip = rowAt(pr.p, c), ic = rowAt(pr.c, c);
      if (ip === undefined || ic === undefined || !(pr.p.vol[ip] > 0) || !(pr.c.vol[ic] > 0)) continue;
      if (nRows(pr.p, c - P.zWin + 1, c) < P.minValid || nRows(pr.c, c - P.zWin + 1, c) < P.minValid) continue;
      if (!(tvAvg(pr.p, c, B5_PF_TV_DAYS) >= P.minTv)) continue;
      const z = pfZ(c, pr, P);
      if (Number.isFinite(z)) out.push({ code: pr.p.code, z });
    }
    out.sort((x, y) => x.z - y.z || (x.code < y.code ? -1 : 1));
    return out;
  };
  const PF1: Strat<PfP> = {
    id: "PF1", P0: B5_PF_P0, nbs: B5_PF_NB, signalDays: monthEndIdx, isSwap: () => true,
    targets: (c, held, P, m) => equalW(pickKeep(pfElig(c, P).map((x) => x.code), held, P.n, P.n * P.keepMult), 1 / P.n, m),
    pool: (c, P) => pfElig(c, P).map((x) => x.code),
    slip: () => B5_PF_SLIP, vanish: "last", wOf: (P) => 1 / P.n,
  };


  // ---- BS1 ----
  // 성능 전용 메모이제이션(결과 불변): 같은 (신호일, 파라미터)의 적격 목록·정렬을 무작위 대조 1000회·이웃이 반복 계산하지 않게 한다.
  const bsEligMemo = new Map<string, string[]>(), bsSortedMemo = new Map<string, { code: string; score: number }[]>();
  const bsElig = (c: number, P: BsP): string[] => {
    const key = `${c}|${JSON.stringify(P)}`, hit = bsEligMemo.get(key);
    if (hit) return hit;
    const r = bsEligRaw(c, P);
    bsEligMemo.set(key, r);
    return r;
  };
  const bsEligRaw = (c: number, P: BsP): string[] => {
    const d = CAL[c], m = membAt(d), out: string[] = [];
    if (!m) return out;
    for (const s of h.stocks) {
      const i = s.idx.get(d);
      if (i === undefined || excluded.has(s.code)) continue;
      const mk = m.get(s.code);
      if (mk !== "KOSPI" && mk !== "KOSDAQ") continue;
      if (nRows(s, 0, c) < P.minRows || s.raw[i] < P.minPrice) continue;
      let zero = 0, zero20 = false;
      const tvs: number[] = [];
      for (let k = c - P.zeroVolWin + 1; k <= c; k++) { const j = rowAt(s, k); const noTrade = j === undefined || s.vol[j] === 0; if (noTrade) { zero++; if (k > c - P.recentZeroWin) zero20 = true; } }
      if (zero > P.zeroVolMax || zero20) continue;
      for (let k = c - P.tvMedianDays + 1; k <= c; k++) { const j = rowAt(s, k); tvs.push(j === undefined ? 0 : s.raw[j] * s.vol[j]); }
      if (!(medianOf(tvs) >= P.minTv)) continue;
      out.push(s.code);
    }
    return out;
  };
  const pctRank = (vals: number[]): number[] => {
    const idx = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
    const out = new Array<number>(vals.length);
    let i = 0;
    while (i < idx.length) { let j = i; while (j + 1 < idx.length && vals[idx[j + 1]] === vals[idx[i]]) j++; const avgRank = (i + j) / 2; for (let k = i; k <= j; k++) out[idx[k]] = vals.length > 1 ? avgRank / (vals.length - 1) : 0; i = j + 1; }
    return out;
  };
  const bsSorted = (c: number, P: BsP): { code: string; score: number }[] => {
    const key = `${c}|${JSON.stringify(P)}`, hit = bsSortedMemo.get(key);
    if (hit) return hit;
    const r = bsSortedRaw(c, P);
    bsSortedMemo.set(key, r);
    return r;
  };
  const bsSortedRaw = (c: number, P: BsP): { code: string; score: number }[] => {
    const el = bsElig(c, P), a: number[] = [], b: number[] = [], t: number[] = [];
    for (const code of el) {
      const s = h.byCode.get(code) as S, r = retFill(s);
      const win = new Float64Array(P.volWin); for (let k = 0; k < P.volWin; k++) win[k] = r[c - P.volWin + 1 + k];
      a.push(sdOf(win, P.volWin));
      const last = Array.from({ length: P.topWin }, (_, k) => r[c - P.topWin + 1 + k]).sort((x, y) => y - x);
      b.push((last[0] + last[1] + last[2]) / 3);
      let tv = 0;
      for (let k = c - P.turnWin + 1; k <= c; k++) { const j = rowAt(s, k); if (j !== undefined) { const cap = s.mcapRow[j] * 1e8; if (cap > 0) tv += (s.raw[j] * s.vol[j]) / cap; } }
      t.push(tv / P.turnWin);
    }
    const pa = pctRank(a), pb = pctRank(b), pt = pctRank(t);
    return el.map((code, k) => ({ code, score: (pa[k] + pb[k] + pt[k]) / 3 })).sort((x, y) => x.score - y.score || (x.code < y.code ? -1 : 1));
  };
  const BS1: Strat<BsP> = {
    id: "BS1", P0: B5_BS_P0, nbs: B5_BS_NB, signalDays: monthEndIdx, isSwap: () => true,
    targets: (c, held, P, m) => equalW(pickKeep(bsSorted(c, P).map((x) => x.code), held, P.n, P.n * P.keepMult), 1 / P.n, m),
    pool: (c, P) => bsElig(c, P),
    slip: (code, c, lag) => (rank200(Math.max(c - lag, 0)).rank.has(code) ? B5_BS_SLIP_K200 : B5_BS_SLIP_OTHER), vanish: "loss", wOf: (P) => 1 / P.n,
  };

  // ---- TS1 (슬롯 시뮬레이터) ----
  const tsSignals = (c: number, P: TsP): S[] => {
    const rk = rank200(c), out: S[] = [];
    if (c - P.win + 1 < 0) return out;
    for (const s of rk.list) {
      if (nRows(s, c - P.win + 1, c) < P.minValid) continue;
      const a = al(s);
      let mx = Number.NEGATIVE_INFINITY;
      for (let k = c - P.win + 1; k <= c - 1; k++) if (a[k] > mx) mx = a[k];
      if (a[c] > mx) out.push(s);
    }
    return out;
  };
  const tsPool = (c: number, P: TsP): S[] => rank200(c).list.filter((s) => { const i = rowAt(s, c); return i !== undefined && s.vol[i] > 0 && c - P.win + 1 >= 0 && nRows(s, c - P.win + 1, c) >= P.minValid; });
  const tsExit = (P: TsP) => (p: SimPos, _c: number, i: number | undefined): string | null => (i !== undefined && p.s.close[i] <= p.peak * (1 - P.stop) ? `손절(고점 −${f2(P.stop * 100)}%)` : null);

  // =====================================================================================================================
  // 실행기: 재조정 시뮬레이터 호출, 무작위 대조, 합성(코어-위성), 게이트 명세
  // =====================================================================================================================
  /** 실제 보유 구간의 길이(신호일 개수 단위) 표본. */
  const holdSamplesOf = <P,>(def: Strat<P>, F: boolean, cS: number, run: RebalRun): number[] => {
    const days = sigDays(def, F).filter((c) => c >= cS);
    const out: number[] = [];
    for (const t of [...run.trades, ...run.open]) out.push(Math.max(1, days.filter((d) => d > t.entryC - 1 && d <= t.exitC - 1).length));
    return out;
  };
  const randomS = <P,>(def: Strat<P>, P: P, cS: number, F: FCfg | null, rng: () => number, ordersByDay: Map<number, number>, hold: number[]): RebalRun => {
    const days = sigDays(def, F !== null).filter((c) => c >= cS), jOf = new Map(days.map((c, j) => [c, j]));
    const exp = new Map<string, number>();
    return rebalSim(env(cS), { slipOf: (code, c) => def.slip(code, c, 1), vanish: def.vanish, vanishLoss: def.vanishLoss }, {
      isSignal: (c) => jOf.has(c),
      targetsAt: (c) => {
        const j = jOf.get(c) as number;
        for (const [code, e] of [...exp]) if (e <= j) exp.delete(code);
        const k = ordersByDay.get(c) ?? 0;
        if (k > 0) {
          const pl = def.pool(c, P).filter((code) => !exp.has(code));
          for (let a = 0; a < Math.min(k, pl.length); a++) { const m = a + Math.floor(rng() * (pl.length - a)); [pl[a], pl[m]] = [pl[m], pl[a]]; exp.set(pl[a], j + hold[Math.floor(rng() * hold.length)]); }
        }
        const mult = F ? filterMult(c, F.ma) : 1;
        return def.wMap ? def.wMap(c, [...exp.keys()], P, mult) : new Map([...exp.keys()].map((code) => [code, def.wOf(P) * mult] as [string, number]));
      },
      stockOf: (code) => h.byCode.get(code),
    }, { lag: 1 });
  };
  const hVs = (full: { cagr: number; mdd: number }, rb: { cagr: number; mdd: number }): { ok: boolean; text: string } => {
    const dc = full.cagr - rb.cagr, dm = rb.mdd - full.mdd;
    const c1 = dc >= PEAD_H_CAGR_GAIN_PP, c2 = dm >= PEAD_H_MDD_GAIN_PP && dc >= -PEAD_H_CAGR_FLOOR_PP;
    return { ok: c1 || c2, text: `CAGR ${dc >= 0 ? "+" : ""}${f2(dc)}%p, MDD ${dm >= 0 ? "−" : "+"}${f2(Math.abs(dm))}%p(개선 ${f2(dm)}%p; ${PEAD_H_MDD_GAIN_STRONG_PP}%p 이상 ${dm >= PEAD_H_MDD_GAIN_STRONG_PP ? "O" : "X"}) → 조건1(CAGR +${PEAD_H_CAGR_GAIN_PP}%p) ${c1 ? "O" : "X"}, 조건2(MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p) ${c2 ? "O" : "X"}` };
  };
  const bhAll = { dates: h.bhP.dates, ret: h.bhP.ret } as unknown as SimRun;
  const windowsFor = (cS: number): Windows => {
    const from = CAL[cS + 1];
    const NW: [string, Win][] = [[`구간 1 ${from}~2016-12-29`, { from, to: "2016-12-29" }], ["구간 2 2017-04~2021-12", { from: "2017-04-04", to: "2021-12-31" }], ["구간 3 2022-01~2026-10-26", { from: "2022-01-01", to: "9999-12-31" }]];
    const FULLX: Win = { from, to: "9999-12-31" };
    return { NW, FULL: FULLX, ALL: [...NW, [`연속 전체 ${from.slice(0, 7)}~2026-10`, FULLX]], noEx26: true, contamNote: "경고(오염): 이 구간 전체(2011~2026)는 DS6·DS4 등 선행 연구에서 이미 반복해 본 데이터다. 변형(F·C 형태)은 DS6·DS7·DS10 결과를 본 뒤 만든 것(선택 편향)이라 순수 검증이 아니다." };
  };
  const pnlS = (t: SimTrade): number => (t.proceeds - t.spend) / t.vAtEntry;
  const topRepl = (r: SimRun, from: string): Set<string> => new Set(r.trades.filter((t) => CAL[t.exitC] >= from).sort((a, b) => pnlS(b) - pnlS(a)).slice(0, F_E_TOP_TRADES).map((t) => `${t.code}|${t.entryC}`));


  // =====================================================================================================================
  // 공통 보고(판정 불사용) + 게이트 명세 생성
  // =====================================================================================================================
  const BH_FROM = (from: string): { dates: string[]; ret: number[] } => ({ dates: h.bhP.dates.filter((d) => d >= from), ret: h.bhP.ret.filter((_, k) => h.bhP.dates[k] >= from) });
  interface Ctx { id: string; trial: number; cS: number; Wx: Windows; sleeveW: number; contrib?: Map<string, { pct: number; days: number }>; trades: SimTrade[]; open: SimTrade[]; filterBase?: () => SimRun; filterMa?: number; sigList?: number[]; extraLines?: (run: SimRun) => void }
  const SH = ["005930", "000660", "005935"];
  const reportCommon = (ctx: Ctx, run: SimRun): void => {
    const { id, Wx } = ctx, from = Wx.FULL.from, ds6 = b6.res.run;
    console.log(`\n=== ${id} vs 069500 vs DS6 (CAGR % / MDD %; 같은 구간 = 이 전략 시작 ${from}~) ===\n| 구간 | 069500 | DS6 | ${id} | ${id} − 069500 CAGR %p | ${id} − 069500 MDD %p | ${id} − DS6 CAGR %p | ${id} − DS6 MDD %p |\n|---|---|---|---|---|---|---|---|`);
    for (const [wn, w] of Wx.ALL) {
      const a = h.st(h.bhP, w), s6 = h.st(ds6, w), sc = h.st(run, w);
      console.log(`| ${wn} | ${f2(a.cagr)} / ${f2(a.mdd)} | ${f2(s6.cagr)} / ${f2(s6.mdd)} | ${f2(sc.cagr)} / ${f2(sc.mdd)} | ${sg(sc.cagr - a.cagr)} | ${sg(sc.mdd - a.mdd)} | ${sg(sc.cagr - s6.cagr)} | ${sg(sc.mdd - s6.mdd)} |`);
    }
    const bh = BH_FROM(from), d6 = { dates: ds6.dates.filter((d) => d >= from), ret: ds6.ret.filter((_, k) => ds6.dates[k] >= from) };
    const years: number[] = [];
    for (let y = Number(from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) years.push(y);
    console.log(`\n=== 연도별 수익률 % (${years[0]}년은 ${from}부터, ${years[years.length - 1]}년은 ${h.dataEnd}까지) ===\n| 연도 | 069500 | DS6 | ${id} | ${id} − 069500 %p | ${id} − DS6 %p |\n|---|---|---|---|---|---|`);
    const ex: number[] = [], ex6: number[] = [];
    for (const y of years) {
      const a = h.yearRet(bh, y), c6 = h.yearRet(d6, y), cc = h.yearRet(run, y);
      ex.push(cc - a); ex6.push(cc - c6);
      console.log(`| ${y} | ${f2(a)} | ${f2(c6)} | ${f2(cc)} | ${sg(cc - a)} | ${sg(cc - c6)} |`);
    }
    console.log(`${id} − 069500 승·패 연수: 승 ${ex.filter((x) => x > 0).length} / 패 ${ex.filter((x) => x < 0).length} (평균 ${sg(avg(ex))}%p, 중앙값 ${sg(median(ex))}%p) | ${id} − DS6 승·패 연수: 승 ${ex6.filter((x) => x > 0).length} / 패 ${ex6.filter((x) => x < 0).length} (평균 ${sg(avg(ex6))}%p)`);
    const fs = h.st(run, Wx.FULL);
    const all = [...ctx.trades, ...ctx.open].filter((t) => CAL[t.exitC] >= from), closed = ctx.trades.filter((t) => CAL[t.exitC] >= from);
    const nets = closed.map((t) => (t.proceeds / t.spend - 1) * 100);
    console.log(`\n${id} 요약(판정 불사용): 평균 보유 종목 수 ${f2(fs.avgN)}, 평균 투자 비중 ${f2(fs.avgInv)}%(현금 비중 평균 ${f2(100 - fs.avgInv)}%), 연 회전율 ${f2(fs.turnover)}%, 비용 합계 ${f2(fs.cost)}% | 닫힌 보유 구간 ${closed.length}건: 승률 ${f2((nets.filter((x) => x > 0).length / Math.max(nets.length, 1)) * 100)}%, 평균 이익 ${f2(avg(nets.filter((x) => x > 0)))}%, 평균 손실 ${f2(avg(nets.filter((x) => x <= 0)))}%, 손익비 ${f2(avg(nets.filter((x) => x > 0)) / Math.max(-avg(nets.filter((x) => x <= 0)), 1e-9))}, 구간당 기대값(비용 후 순수익률 평균) ${f2(avg(nets))}% | 열린 구간 ${ctx.open.length}건 포함 전체 ${all.length}건`);
    // 삼성전자·SK하이닉스(PF1은 삼성전자우) 보유 기간·손익 기여
    const wS = ctx.sleeveW;
    for (const code of SH) {
      const ts = all.filter((t) => t.code === code);
      const cb = ctx.contrib?.get(code);
      if (!ts.length && !cb) continue;
      const pnl = cb ? cb.pct * wS : ts.reduce((a, t) => a + pnlS(t), 0) * 100;
      const spans = ts.map((t) => `${CAL[t.entryC]}~${t.reason === "기간 끝 평가" ? "보유 중" : CAL[t.exitC]}`).slice(0, 8).join(", ");
      console.log(`${label(code)}: 보유 구간 ${ts.length}건${cb ? `, 보유 일수 ${cb.days}일` : ""}, 가격 손익 기여 합 ${sg(pnl)}%p(계좌 대비 일별 기여의 단순 합, 비용 제외${cb && wS !== 1 ? `, 위성 비중 ${wS} 반영` : ""}) | 구간: ${spans}${ts.length > 8 ? " …" : ""}`);
    }
    // 초과수익의 출처: 종목·업종 기여
    if (ctx.contrib) {
      const arr = [...ctx.contrib.entries()].map(([code, v]) => ({ code, pct: v.pct * wS, days: v.days })).sort((a, b) => b.pct - a.pct);
      const tot = arr.reduce((a, x) => a + x.pct, 0);
      console.log(`종목별 가격 손익 기여(%p, 단순 합, 상위 8 / 하위 5; 전체 합 ${sg(tot)}): ${arr.slice(0, 8).map((x) => `${label(x.code)} ${sg(x.pct)}`).join(", ")} | 하위: ${arr.slice(-5).map((x) => `${label(x.code)} ${sg(x.pct)}`).join(", ")}`);
      const ind = new Map<string, number>();
      for (const x of arr) { const k = (indOf.get(x.code) ?? "").slice(0, 2) || "미상"; ind.set(k, (ind.get(k) ?? 0) + x.pct); }
      const ia = [...ind.entries()].sort((a, b) => b[1] - a[1]);
      console.log(`업종(KSIC 2자리) 기여(%p, 상위 5 / 하위 3): ${ia.slice(0, 5).map(([k, v]) => `${k} ${sg(v)}`).join(", ")} | ${ia.slice(-3).map(([k, v]) => `${k} ${sg(v)}`).join(", ")}`);
    } else {
      const byCode = new Map<string, number>();
      for (const t of closed) byCode.set(t.code, (byCode.get(t.code) ?? 0) + pnlS(t) * 100);
      const arr = [...byCode.entries()].sort((a, b) => b[1] - a[1]);
      console.log(`종목별 닫힌 거래 손익 기여(진입 시 계좌 대비 %의 합, 상위 8 / 하위 5): ${arr.slice(0, 8).map(([c, v]) => `${label(c)} ${sg(v)}`).join(", ")} | 하위: ${arr.slice(-5).map(([c, v]) => `${label(c)} ${sg(v)}`).join(", ")}`);
    }
    // F 형태: 필터가 현금으로 간 기간
    if (ctx.filterBase && ctx.filterMa && ctx.sigList) {
      const base = ctx.filterBase(), sl = ctx.sigList, on = new Set<string>();
      for (let i = 0; i < sl.length; i++) {
        if (filterMult(sl[i], ctx.filterMa) < 1) { const end = i + 1 < sl.length ? sl[i + 1] + 1 : nCal - 1; for (let k = sl[i] + 2; k <= end; k++) on.add(CAL[k]); }
      }
      const idx = run.dates.map((d, k) => (on.has(d) ? k : -1)).filter((k) => k >= 0);
      const sumF = idx.reduce((a, k) => a + run.ret[k], 0), baseIdx = new Map(base.dates.map((d, k) => [d, k]));
      const sumB = idx.reduce((a, k) => a + (base.ret[baseIdx.get(run.dates[k]) as number] ?? 0), 0);
      const sF = h.st(run, Wx.FULL), sB = h.st(base, Wx.FULL);
      console.log(`${id} 필터 보고(근사: 신호 체결 다음 날부터 다음 체결일까지): 필터 가동(주식 50%) ${on.size}거래일(전체 ${run.dates.length}일의 ${f2((on.size / Math.max(run.dates.length, 1)) * 100)}%, ${idx.length ? `첫 ${run.dates[idx[0]]} 마지막 ${run.dates[idx[idx.length - 1]]}` : "없음"}) | 그 기간 일수익률 단순 합: ${id} ${f2(sumF)}%p vs 필터 없는 단독 ${f2(sumB)}%p (필터 손익 기여 ${sg(sumF - sumB)}%p) | 연속 전체: ${id} ${f2(sF.cagr)} / ${f2(sF.mdd)} vs 단독 ${f2(sB.cagr)} / ${f2(sB.mdd)} (CAGR ${sg(sF.cagr - sB.cagr)}%p, MDD ${sg(sF.mdd - sB.mdd)}%p)`);
    }
    ctx.extraLines?.(run);
  };

  // ---- 표준 게이트 명세 ----
  const gateNotes = (id: string, trial: number, nNb: number): void => {
    console.log(`${id}(시험 ${trial}) 게이트 해석(사전등록): C = 진입·청산·재조정 체결을 모두 +1거래일(lag 2); D = 이웃 ${nNb}개 모두 연속 전체 CAGR ≥ 069500; E = 닫힌 거래 손익 상위 3개를 069500 수익률로 대체; F = 같은 신호일 신규 진입 수·보유 기간 분포의 무작위 대조 ${KSS_R3_DRAWS}회(시드 ${KSS_R3_SEED}), 백분위 ≥ 95(참고선 ${f2(100 * (1 - 0.05 / B5_F_DENOMINATOR))}); G = 진입 건수 ≥ 100; H = 069500만 판정(CAGR +${PEAD_H_CAGR_GAIN_PP}%p, 또는 MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p).`);
  };
  const mkS = <P,>(def: Strat<P>, id: string, trial: number, F: boolean, cS: number, Wx: Windows, title: string, cfg?: Partial<Ctx>): CandSpec => {
    const FC = (ma: number): FCfg | null => (F ? { ma } : null), P0 = def.P0;
    const base = runS(def, P0, cS, FC(B5_MA_DAYS), { lag: 1, detail: true });
    const hold = holdSamplesOf(def, F, cS, base);
    const nbs: { label: string; run: () => SimRun }[] = def.nbs.map(([lb, ch]) => ({ label: lb, run: () => runS(def, { ...P0, ...ch }, cS, FC(B5_MA_DAYS), { lag: 1 }) }));
    if (F) for (const ma of B5_MA_NB) nbs.push({ label: `이동평균 ${ma}일`, run: () => runS(def, P0, cS, FC(ma), { lag: 1 }) });
    return {
      id, trial, title, defense: false, capFrac: def.wOf(P0), fDenominator: MODE === "vtest" ? VB_F_DENOMINATOR : B5_F_DENOMINATOR, ref: { id: "069500", run: bhAll },
      hRule: (full, rb) => { const a = hVs(full, rb); return { ok: a.ok, note: `[사전등록: 069500만 판정] 069500 ${f2(rb.cagr)} / ${f2(rb.mdd)} → ${a.ok ? "O" : "X"} (${a.text})` }; },
      run: (o) => runS(def, P0, cS, FC(B5_MA_DAYS), o),
      neighbors: nbs,
      random: (rng, ob) => randomS(def, P0, cS, FC(B5_MA_DAYS), rng, ob, hold),
      reasons: ["순위 밖", "목표 0", "폐지", "폐지(전액 손실)"], label,
      extra: (run) => {
        gateNotes(id, trial, nbs.length);
        const r = run as RebalRun;
        reportCommon({ id, trial, cS, Wx, sleeveW: 1, contrib: r.contrib, trades: r.trades, open: r.open, filterBase: F ? () => runS(def, P0, cS, null, { lag: 1, detail: true }) : undefined, filterMa: B5_MA_DAYS, sigList: sigDays(def, true).filter((c) => c >= cS), ...cfg }, run);
      },
    };
  };
  /** C 형태: DS6 코어 40%(정의 그대로, 같은 코드·같은 캐시) + 위성 60% = 새 전략. */
  const mkC = <P,>(def: Strat<P>, id: string, trial: number, cS: number, Wx: Windows, title: string): CandSpec => {
    const P0 = def.P0, from = Wx.FULL.from, wC = B5_CORE_W;
    const coreSlOf = (lag: number, repl?: Set<string>): { run: CoreRun; sl: Sl } => { const x = coreOf(2, undefined, lag, { repl }); return { run: x.run, sl: sliceSl(x.sl, from) }; };
    const baseSat = runS(def, P0, cS, null, { lag: 1, detail: true });
    const hold = holdSamplesOf(def, false, cS, baseSat);
    const satOrders = new Map<number, number>();
    for (const c of baseSat.entryCs) satOrders.set(c - 1, (satOrders.get(c - 1) ?? 0) + 1);
    const build = (P: P, o: { lag: number; replSat?: boolean; replCore?: boolean }): { res: ReturnType<typeof combine2>; sat: RebalRun; core: CoreRun } => {
      const sat = runS(def, P, cS, null, { lag: o.lag, detail: true, replace: o.replSat ? topRepl(baseSat, from) : undefined });
      const cx = o.replCore ? coreSlOf(1, coreReplSet(coreOf(2, undefined, 1).run)) : coreSlOf(o.lag);
      return { res: combine2(cx.sl, slFromRun(sat), wC, CS_MOVE_COST), sat, core: cx.run };
    };
    const base = build(P0, { lag: 1 });
    const merge = (b: ReturnType<typeof build>): SimRun => {
      const r: SimRun = { ...b.res.run };
      r.trades = [...b.sat.trades.map((t) => ({ ...t, vAtEntry: t.vAtEntry / (1 - wC) })), ...b.core.trades.map((t) => ({ ...t, vAtEntry: t.vAtEntry / wC }))];
      r.entryCs = [...b.sat.entryCs, ...b.core.entryCs]; r.haltSkip = b.sat.haltSkip + b.core.haltSkip; r.exitDefer = b.sat.exitDefer + b.core.exitDefer;
      return r;
    };
    const nbs: { label: string; run: () => SimRun }[] = def.nbs.map(([lb, ch]) => ({ label: lb, run: () => build({ ...P0, ...ch }, { lag: 1 }).res.run }));
    return {
      id, trial, title, defense: false, capFrac: def.wOf(P0), fDenominator: MODE === "vtest" ? VB_F_DENOMINATOR : B5_F_DENOMINATOR, ref: { id: "069500", run: bhAll },
      hRule: (full, rb) => { const a = hVs(full, rb); return { ok: a.ok, note: `[사전등록: 069500만 판정] 069500 ${f2(rb.cagr)} / ${f2(rb.mdd)} → ${a.ok ? "O" : "X"} (${a.text})` }; },
      run: (o) => (o.replace ? merge(build(P0, { lag: 1, replSat: true })) : merge(build(P0, { lag: o.lag }))),
      neighbors: nbs,
      random: (rng) => combine2(coreSlOf(1).sl, slFromRun(randomS(def, P0, cS, null, rng, satOrders, hold)), wC, CS_MOVE_COST).run,
      reasons: ["순위 밖", "목표 0", "폐지", "폐지(전액 손실)"], label,
      extra: (run) => {
        gateNotes(id, trial, nbs.length);
        console.log(`${id} 게이트 E 해석(사전등록, DS8·DS9와 같음): 위성의 닫힌 거래 중 손익 상위 3개를 069500 수익률로 바꾼 위성 + 실제 코어를 같은 합성 규칙으로 돌린 연속 전체 CAGR ≥ 069500. 코어 상위 3개 대체는 보고만. F: 위성 무작위 대조를 실제 코어(고정)와 40:60 합성. G: 위성+코어 진입 합.`);
        reportCommon({ id, trial, cS, Wx, sleeveW: 1 - wC, contrib: baseSat.contrib, trades: [...baseSat.trades], open: baseSat.open, extraLines: (r) => ds6GateLine(id, Wx, r) }, run);
        const bb = base;
        console.log(`${id} 코어-위성 리밸 이동 금액 연 % ${f2(bb.res.moved.reduce((a, x) => a + x, 0) * 100 / Math.max((Date.parse(h.dataEnd) - Date.parse(from)) / 86_400_000 / 365.25, 1e-9))}, 위성 단독(같은 구간) CAGR/MDD ${cellS(slFromRun(baseSat), Wx.FULL)} | 코어 단독 ${cellS(sliceSl(coreOf(2, undefined, 1).sl, from), Wx.FULL)}`);
      },
    };
  };
  const cellS = (s: Sl, w: Win): string => { const x = h.st({ dates: s.dates, ret: s.ret }, w); return `${f2(x.cagr)} / ${f2(x.mdd)}`; };

  // =====================================================================================================================
  // DS13: 코어 40% + 모멘텀 위성(RM1) 30% + 저위험 위성(MV1 또는 LV1) 30%, 하위 계좌 간 월 1회 재조정
  // =====================================================================================================================
  /** 신호일마다 목표 비중표를 실제 보유 경로(이전 목표 = 보유)로 이어 만든다(보고용 근사). */
  const pathTgG = <P,>(def: Strat<P>, c0: number): { c: number; t: Map<string, number> }[] => {
    const out: { c: number; t: Map<string, number> }[] = [];
    let held: ReadonlySet<string> = new Set();
    for (const c of sigDays(def, false).filter((x) => x >= c0)) { const t = def.targets(c, held, def.P0, 1, true); out.push({ c, t }); held = new Set(t.keys()); }
    return out;
  };
  /** 구간 내 복리 수익률 %와 고점일·저점일. */
  const winStat = (r: { dates: string[]; ret: number[] }, a: string, b: string): { tot: number; mdd: number; peak: string; trough: string } => {
    let v = 1, pk = 1, pkD = a, mdd = 0, mp = a, mt = a, any = false;
    for (let i = 0; i < r.dates.length; i++) {
      const d = r.dates[i];
      if (d < a || d > b) continue;
      if (!any) { any = true; pkD = d; mp = d; mt = d; }
      v *= 1 + r.ret[i] / 100;
      if (v > pk) { pk = v; pkD = d; }
      const dd = 1 - v / pk;
      if (dd > mdd) { mdd = dd; mp = pkD; mt = d; }
    }
    return { tot: (v - 1) * 100, mdd: mdd * 100, peak: mp, trough: mt };
  };
  const win2Detail = (runs: { name: string; run: { dates: string[]; ret: number[] } }[]): void => {
    const { from: wa, to: wb } = DS13_WIN2;
    console.log(`\n=== 구간 2 상세(${wa}~${wb}): 연도별 수익률 % (2017은 ${wa}부터)와 이 구간의 최대 낙폭(고점일 → 저점일) ===`);
    console.log(`| 연도 | ${runs.map((x) => x.name).join(" | ")} |\n|---|${runs.map(() => "---").join("|")}|`);
    for (let y = 2017; y <= 2021; y++) console.log(`| ${y} | ${runs.map((x) => f2(winStat(x.run, y === 2017 ? wa : `${y}-01-01`, y === 2021 ? wb : `${y}-12-31`).tot)).join(" | ")} |`);
    console.log(`| 구간 전체 복리 | ${runs.map((x) => f2(winStat(x.run, wa, wb).tot)).join(" | ")} |`);
    console.log(`| 구간 MDD % (고점일 → 저점일) | ${runs.map((x) => { const w = winStat(x.run, wa, wb); return `${f2(w.mdd)} (${w.peak} → ${w.trough})`; }).join(" | ")} |`);
  };
  const D13_KIND_LABEL = { MV1: "MV1(최소분산)", LV1: "LV1(DS6 위성)" } as const;
  const d13Handles = new Map<string, ReturnType<typeof d13Of>>();
  const mkD13 = (id: string, trial: number, kind: "MV1" | "LV1", cS: number, Wx: Windows, title: string): CandSpec => {
    const d = d13Of(kind, cS, Wx), { from, W0, rmP0, sigSet } = d;
    d13Handles.set(id, d);
    const baseRm = d.base.rm, baseLow = d.base.low;
    if (baseRm.dates[0] !== from || d.base.res.run.dates[0] !== from) throw new Error(`${id}: 하위 계좌 시작일이 ${from}과 다르다`);
    const rmHold = holdSamplesOf(RM1, false, cS, baseRm), rmOrders = new Map<number, number>();
    for (const c of baseRm.entryCs) rmOrders.set(c - 1, (rmOrders.get(c - 1) ?? 0) + 1);
    const lowHold = kind === "MV1" ? holdSamplesOf(MV1, false, cS, baseLow as RebalRun) : [], lowOrders = new Map<number, number>();
    for (const c of baseLow.entryCs) lowOrders.set(c - 1, (lowOrders.get(c - 1) ?? 0) + 1);
    const coreFixed = d.coreSlOf(1).sl;
    const topRepl2 = (): { rm: Set<string>; low: Set<string> } => {
      const arr: { sl: "rm" | "low"; key: string; pnl: number }[] = [];
      for (const t of baseRm.trades) if (CAL[t.exitC] >= from) arr.push({ sl: "rm", key: `${t.code}|${t.entryC}`, pnl: pnlS(t) * W0[1] });
      for (const t of baseLow.trades) if (CAL[t.exitC] >= from) arr.push({ sl: "low", key: `${t.code}|${t.entryC}`, pnl: pnlS(t) * W0[2] });
      arr.sort((a, b) => b.pnl - a.pnl);
      const top = arr.slice(0, F_E_TOP_TRADES);
      return { rm: new Set(top.filter((x) => x.sl === "rm").map((x) => x.key)), low: new Set(top.filter((x) => x.sl === "low").map((x) => x.key)) };
    };
    const nbs: { label: string; run: () => SimRun }[] = [
      ...DS13_NB_W.map(([lb, w]) => ({ label: lb, run: () => d.build({ w, lag: 1 }).res.run })),
      ...DS13_NB_RM_N.map((n) => ({ label: `RM1 종목 수 ${n}`, run: () => d.build({ rmP: { ...rmP0, n }, lag: 1 }).res.run })),
    ];
    let kLv = 0;
    return {
      id, trial, title, defense: false, capFrac: 0.015, fDenominator: MODE === "vtest" ? VB_F_DENOMINATOR : B5_F_DENOMINATOR, ref: { id: "069500", run: bhAll },
      hRule: (full, rb) => { const a = hVs(full, rb); return { ok: a.ok, note: `[사전등록: 069500만 판정] 069500 ${f2(rb.cagr)} / ${f2(rb.mdd)} → ${a.ok ? "O" : "X"} (${a.text})` }; },
      run: (o) => (o.replace ? d.merge(d.build({ lag: 1, repl: topRepl2() })) : d.merge(d.build({ lag: o.lag }))),
      neighbors: nbs,
      random: (rng) => {
        const rmR = randomS(RM1, rmP0, cS, null, rng, rmOrders, rmHold);
        let lowSl: Sl;
        if (kind === "MV1") lowSl = slFromRun(randomS(MV1, MV1.P0, cS, null, rng, lowOrders, lowHold));
        else { const dr = randOf(undefined), x = dr[kLv++ % dr.length]; lowSl = sliceSl({ ...zeroSl, ret: Array.from(x.full.subarray(x.k0)) }, from); }
        return combineN([coreFixed, slFromRun(rmR), lowSl], W0, CS_MOVE_COST, sigSet).run;
      },
      reasons: ["순위 밖", "목표 0", "폐지", "폐지(전액 손실)"], label,
      extra: (run) => {
        gateNotes(id, trial, nbs.length);
        console.log(`${id} 게이트 E 해석(사전등록): 두 위성(모멘텀 + 저위험)의 닫힌 거래 중 계좌 기준 손익 상위 3개를 069500 수익률로 바꾸고 코어는 실제 그대로 돌린 연속 전체 CAGR ≥ 069500(출력의 상위 거래 목록은 코어 포함 참고용). F: 위성별 무작위 대조(모멘텀: RM1 무작위, 저위험: ${kind === "MV1" ? "MV1 무작위" : "LV1 기존 무작위 같은 번호 표본"})를 실제 코어와 40/30/30으로 합성, 시드 20261022 1,000회, 백분위 ≥ 95. G: 코어 + 두 위성 진입 합.`);
        const b = d.base, contrib = new Map<string, { pct: number; days: number }>();
        for (const [code, v] of baseRm.contrib) contrib.set(code, { pct: v.pct * W0[1], days: v.days });
        if (kind === "MV1") for (const [code, v] of (baseLow as RebalRun).contrib) { const o = contrib.get(code); contrib.set(code, { pct: (o?.pct ?? 0) + v.pct * W0[2], days: (o?.days ?? 0) + v.days }); }
        reportCommon({ id, trial, cS, Wx, sleeveW: 1, contrib, trades: [...baseRm.trades, ...baseLow.trades], open: [...baseRm.open, ...((baseLow as RebalRun).open ?? [])], extraLines: (r) => ds6GateLine(id, Wx, r) }, run);
        // 손익 분해(하위 계좌 비중 × 일별 수익률 단순 합 %p), 재조정 이동·비용
        const names = ["코어(DS6 코어)", "모멘텀 위성(RM1)", `저위험 위성(${D13_KIND_LABEL[kind]})`];
        const win = (a: string, z: string): number[] => names.map((_, j) => b.res.run.dates.reduce((acc, dd, i) => (dd >= a && dd <= z ? acc + b.res.contribDaily[j][i] : acc), 0));
        const yrs = Math.max((Date.parse(h.dataEnd) - Date.parse(from)) / 86_400_000 / 365.25, 1e-9);
        const fullC = win(from, h.dataEnd), w2C = win(DS13_WIN2.from, DS13_WIN2.to), totC = fullC.reduce((x, y) => x + y, 0), totW2 = w2C.reduce((x, y) => x + y, 0);
        console.log(`\n${id} 손익 분해(하위 계좌 비중 × 일별 수익률의 단순 합 %p; 비용은 각 하위 계좌 수익률에 이미 반영, 재조정 비용 별도)`);
        console.log("| 하위 계좌 | 연속 전체 기여 %p (비중) | 구간 2 기여 %p | 평균 비중(종가, 이동 후) % | 단독(같은 구간) CAGR / MDD |\n|---|---|---|---|---|");
        names.forEach((nm, j) => console.log(`| ${nm} | ${f2(fullC[j])} (${f2(totC ? (fullC[j] / totC) * 100 : 0)}%) | ${f2(w2C[j])} (${f2(totW2 ? (w2C[j] / totW2) * 100 : 0)}%) | ${f2(avg(b.res.wEnd.map((w) => w[j])) * 100)} | ${cellS(b.sls[j], Wx.FULL)} |`));
        console.log(`재조정(월 1회) 이동 금액 연 ${f2(b.res.moved.reduce((x, y) => x + y, 0) * 100 / yrs)}%(계좌 대비), 이동 비용 합계 ${f2(b.res.cost.reduce((x, y) => x + y, 0) * 100)}%p(연 ${f2(b.res.cost.reduce((x, y) => x + y, 0) * 100 / yrs)}%p) | 하위 계좌 비중이 목표에서 벗어난 정도(종가 기준 최대 이탈 %p): ${names.map((nm, j) => `${nm.split("(")[0]} ${f2(Math.max(...b.res.wEnd.map((w) => Math.abs(w[j] - W0[j]))) * 100)}`).join(", ")}`);
        // 삼성전자·SK하이닉스 평균 비중(코어 + 위성 합산, 월말 신호일 목표 기준 근사)
        const ptRm = pathTgG(RM1, cS), ptMv = kind === "MV1" ? pathTgG(MV1, cS) : [];
        const lowSl = b.sls[2], lv = baseLow;
        for (const code of DS13_WATCH) {
          let sc = 0, sr = 0, sl2 = 0, nSig = 0;
          for (let jj = 0; jj < ptRm.length; jj++) {
            const c = ptRm[jj].c; nSig++;
            const ev = [...b.core.events].filter((e) => e.c <= c + 1).pop(), wCore = ev ? (ev.w[ev.set.indexOf(code)] ?? 0) : 0;
            sc += wCore; sr += ptRm[jj].t.get(code) ?? 0;
            if (kind === "MV1") sl2 += ptMv[jj]?.t.get(code) ?? 0;
            else { const di = lowSl.dates.indexOf(CAL[c + 1]); const held = lv.trades.filter((t) => t.entryC < c + 1 && c + 1 <= t.exitC).map((t) => t.code); if (di >= 0 && held.includes(code)) sl2 += lowSl.inv[di] / Math.max(held.length, 1); }
          }
          console.log(`${label(code)} 평균 목표 비중(월말 신호일 ${nSig}개 평균, 계좌 기준 %): 코어 ${f2((sc / nSig) * W0[0] * 100)} + 모멘텀 위성 ${f2((sr / nSig) * W0[1] * 100)} + 저위험 위성 ${f2((sl2 / nSig) * W0[2] * 100)} = ${f2(((sc / nSig) * W0[0] + (sr / nSig) * W0[1] + (sl2 / nSig) * W0[2]) * 100)}% (코어는 교체 이벤트 시점 비중, 저위험 위성 ${kind === "LV1" ? "LV1은 투자 비중 ÷ 보유 종목 수로 근사" : "MV1 목표 비중"})`);
        }
      },
    };
  };

  // =====================================================================================================================
  // DS6 환경 확인 + 같은 구간 DS6 관문(C 형태 비교용)
  // =====================================================================================================================
  const b6 = build(DS6D);
  {
    const sF = h.st(b6.res.run, FULL), s1 = h.st(b6.res.run, { from: FULL.from, to: "2016-12-30" });
    const ok = f2(sF.cagr) === f2(DS89_DS6_REF.전체[0]) && f2(sF.mdd) === f2(DS89_DS6_REF.전체[1]) && f2(s1.cagr) === f2(DS89_DS6_REF.구간1[0]) && f2(s1.mdd) === f2(DS89_DS6_REF.구간1[1]);
    console.log(`\nDS6 재현(환경 확인): 연속 전체 ${f2(sF.cagr)} / ${f2(sF.mdd)} (기록 ${DS89_DS6_REF.전체.join(" / ")}), 구간 1(CAGR 기간 ${FULL.from}~2016-12-30) ${f2(s1.cagr)} / ${f2(s1.mdd)} (기록 ${DS89_DS6_REF.구간1.join(" / ")}) → ${ok ? "일치" : "불일치"}`);
    if (!ok && (MODE === "vpre" || MODE === "vtest" || MODE === "vinfo" || (!PRICE_CORRECTION_ON && !NEUTRALIZE_ON))) throw new Error("DS6 기록과 다르다 — 시험을 시작하지 않고 중단해 보고한다");
    if (!ok) console.log("  (보정 적용·중립화 모드: 기록값과 달라짐은 기대된 결과이며 중단하지 않는다)");
  }
  const ds6Lines = new Map<string, string>();
  const ds6GateLine = (id: string, Wx: Windows, run: SimRun): void => {
    const from = Wx.FULL.from;
    let line = ds6Lines.get(from);
    if (!line) {
      const r6 = b6.res.run, eps = SAT_MDD_EPS;
      let bCount = 0;
      for (const [, w] of Wx.NW) { const a = h.st(r6, w), b = h.st(h.bhP, w); if (a.cagr > b.cagr && a.mdd <= b.mdd + eps) bCount++; }
      const full6 = h.st(r6, Wx.FULL), dl = h.st(build(DS6D, { coreLag: 2, satLag: 2 }).res.run, Wx.FULL);
      const gC = full6.cagr - dl.cagr <= F_C_MAX_CAGR_DROP && dl.mdd - full6.mdd <= F_C_MAX_MDD_WORSEN;
      const draws = randOf(undefined).map((dr) => h.st(combineCS(b6.coreX.sl, { ...zeroSl, ret: Array.from(dr.full.subarray(dr.k0)) }, DS89_CORE_W, CS_MOVE_COST).run, Wx.FULL).cagr);
      const pct = (draws.filter((x) => x < full6.cagr).length / draws.length) * 100;
      line = `DS6(같은 구간 ${from}~) 관문: B ${bCount}개 구간(${bCount >= 2 ? "O" : "X"}) | C 지연 CAGR ${f2(dl.cagr)}(하락 ${f2(full6.cagr - dl.cagr)}%p)·MDD ${f2(dl.mdd)}(악화 ${f2(dl.mdd - full6.mdd)}%p) → ${gC ? "O" : "X"} | F 무작위 백분위 ${f2(pct)} → ${pct >= F_F_MIN_PCTILE ? "O" : "X"} (DS6 ${f2(full6.cagr)} / ${f2(full6.mdd)})`;
      ds6Lines.set(from, line);
    }
    console.log(`${id} ← ${line}`);
    void run;
  };

  // =====================================================================================================================
  // TS1 실행기·명세
  // =====================================================================================================================
  const cTS = cPE;
  const tsCfg = (P: TsP) => ({ slip: L_SLIPPAGE, maxPos: P.slots, capFrac: B5_TS_CAP, cooldown: 0 });
  const runTS = (P: TsP, o: { lag: number; replace?: Set<string>; detail?: boolean }): SimRun => simSlots(env(cTS), tsCfg(P), { candsOf: (c) => tsSignals(c, P).map((s) => ({ s, code: s.code })), exitReason: tsExit(P) }, { lag: o.lag, replace: o.replace, detail: o.detail });
  const randomTS = (P: TsP, rng: () => number, ob: Map<number, number>): SimRun => simSlots(env(cTS), tsCfg(P), {
    candsOf: (c, held, blocked) => {
      const n = ob.get(c) ?? 0;
      if (!n) return [];
      const pl = tsPool(c, P).filter((s) => !held(s.code) && !blocked(s.code)), out: SimCand[] = [];
      while (out.length < n && pl.length) { const s = pl.splice(Math.floor(rng() * pl.length), 1)[0]; out.push({ s, code: s.code }); }
      return out;
    },
    exitReason: tsExit(P),
  }, { lag: 1 });
  const mkTS = (id: string, trial: number, Wx: Windows): CandSpec => {
    const P0 = B5_TS_P0;
    const nbs = B5_TS_NB.map(([lb, ch]) => ({ label: lb, run: () => runTS({ ...P0, ...ch }, { lag: 1 }) }));
    return {
      id, trial, title: `${id}: K200P 종목이 252거래일 신고가(직전 251거래일 종가 최댓값 초과)를 내면 다음 거래일 종가에 평가액의 5% 매수(슬롯 20), 종가가 진입 후 최고 종가의 75% 이하이면 청산`, defense: false, capFrac: B5_TS_CAP, fDenominator: MODE === "vtest" ? VB_F_DENOMINATOR : B5_F_DENOMINATOR, ref: { id: "069500", run: bhAll },
      hRule: (full, rb) => { const a = hVs(full, rb); return { ok: a.ok, note: `[사전등록: 069500만 판정] 069500 ${f2(rb.cagr)} / ${f2(rb.mdd)} → ${a.ok ? "O" : "X"} (${a.text})` }; },
      run: (o) => runTS(P0, o), neighbors: nbs, random: (rng, ob) => randomTS(P0, rng, ob),
      reasons: [`손절(고점 −${f2(P0.stop * 100)}%)`], label,
      extra: (run) => {
        gateNotes(id, trial, nbs.length);
        const closed = run.trades.filter((t) => CAL[t.exitC] >= Wx.FULL.from);
        const hold = closed.map((t) => t.exitC - t.entryC), stops = closed.filter((t) => t.reason.startsWith("손절"));
        const give = stops.map((t) => ((t.peakAdj - t.exitAdj) / t.peakAdj) * 100);
        console.log(`${id} 보고: 평균 보유 일수 ${f2(avg(hold))}(중앙값 ${f2(median(hold))}), 닫힌 거래 ${closed.length}건 중 손절 ${stops.length}건, 손절 시 고점 대비 평균 반납 폭 ${f2(avg(give))}%(중앙값 ${f2(median(give))}%), 손절 거래 평균 수익률 ${f2(avg(stops.map((t) => (t.proceeds / t.spend - 1) * 100)))}%, 신호는 많았는데 슬롯이 차서 무시된 일수 비율은 보고하지 않음(사전등록 한계)`);
        reportCommon({ id, trial, cS: cTS, Wx, sleeveW: 1, trades: run.trades, open: [] }, run);
      },
    };
  };

  // =====================================================================================================================
  // 사전 점검용 브루트포스(과거 이력만, 다른 자료 접근 경로: 이진 탐색·직접 합산)
  // =====================================================================================================================
  const bsExact = (s: S, k: number): number => { if (k < 0) return -1; const d = CAL[k]; let lo = 0, hi = s.dates.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (s.dates[m] === d) return m; if (s.dates[m] < d) lo = m + 1; else hi = m - 1; } return -1; };
  const bsAtOrBefore = (s: S, k: number): number => { if (k < 0) return -1; const d = CAL[k]; let lo = 0, hi = s.dates.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (s.dates[m] <= d) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
  const bpx = (s: S, k: number): number => { const r = bsAtOrBefore(s, k); return r >= 0 ? s.close[r] : 0; };
  const bruteRank = (c: number): S[] => {
    const d = CAL[c], m = membAt(d), e: { s: S; mc: number }[] = [];
    if (m) for (const s of h.stocks) { const i = s.idx.get(d); if (i !== undefined && !excluded.has(s.code) && m.get(s.code) === "KOSPI") e.push({ s, mc: s.mcapRow[i] }); }
    e.sort((a, b) => b.mc - a.mc || (a.s.code < b.s.code ? -1 : 1));
    return e.slice(0, 200).map((x) => x.s);
  };
  const cmpLists = (label: string, mod: { code: string; v: number }[], br: { code: string; v: number }[], tol: number): string | null => {
    if (mod.length !== br.length) return `${label}: 길이 ${mod.length} ≠ ${br.length}`;
    const bm = new Map(br.map((x) => [x.code, x.v]));
    for (let i = 0; i < mod.length; i++) {
      const v = bm.get(mod[i].code);
      if (v === undefined) return `${label}: 모듈에만 ${mod[i].code}`;
      if (Math.abs(v - mod[i].v) > tol * Math.max(1, Math.abs(v))) return `${label}: ${mod[i].code} 값 ${mod[i].v} ≠ ${v}`;
      if (mod[i].code !== br[i].code && Math.abs(mod[i].v - br[i].v) > tol * Math.max(1, Math.abs(br[i].v))) return `${label}: ${i + 1}번째 ${mod[i].code} ≠ ${br[i].code}`;
    }
    return null;
  };
  const bruteSelect = (sorted: string[], held: ReadonlySet<string>, n: number, keepRank: number): string[] => {
    const keep: string[] = [];
    for (let k = 0; k < sorted.length && k < keepRank; k++) if (held.has(sorted[k]) && keep.length < n) keep.push(sorted[k]);
    const out = [...keep];
    for (let k = 0; k < sorted.length && out.length < n; k++) if (!out.includes(sorted[k])) out.push(sorted[k]);
    return out;
  };
  const bRetBrute = (k: number): number => { const r = h.bhRet.get(CAL[k]); return r === undefined ? Number.NaN : r; };
  const bruteRm = (c: number, P: RmP): { code: string; v: number }[] => {
    const out: { code: string; v: number }[] = [];
    bruteRank(c).forEach((s) => {
      const xs: number[] = [], ys: number[] = [];
      if (c - P.start >= 1) for (let k = c - P.start; k <= c - P.skip; k++) {
        const jd = bsExact(s, k), jp = bsExact(s, k - 1), x = bRetBrute(k);
        if (jd < 0 || jp < 0 || !Number.isFinite(x)) continue;
        xs.push(x); ys.push(s.close[jd] / s.close[jp] - 1);
      }
      const n = xs.length;
      if (n < P.minValid) return;
      const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
      let sxx = 0, sxy = 0;
      for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
      const beta = sxy / sxx, alpha = my - beta * mx;
      let sse = 0, sumRes = 0;
      for (let i = 0; i < n; i++) { const e = ys[i] - alpha - beta * xs[i]; sse += e * e; sumRes += ys[i] - beta * xs[i]; }
      const sd = Math.sqrt(sse / (n - 1));
      if (sd > 0) out.push({ code: s.code, v: sumRes / (sd * Math.sqrt(n)) });
    });
    const rk = new Map(bruteRank(c).map((s, k) => [s.code, k]));
    return out.sort((a, b) => b.v - a.v || (rk.get(a.code) as number) - (rk.get(b.code) as number));
  };
  const bruteLr = (c: number, P: LrP): { code: string; v: number }[] => {
    const out: { code: string; v: number }[] = [];
    if (c - P.longStart < 0) return out;
    let bRecent = 1;
    for (let k = c - P.recent + 1; k <= c; k++) bRecent *= 1 + (Number.isFinite(bRetBrute(k)) ? bRetBrute(k) : 0);
    bRecent -= 1;
    const rank = bruteRank(c), rk = new Map(rank.map((s, k) => [s.code, k]));
    for (const s of rank) {
      let valid = 0;
      for (let k = c - P.longStart; k <= c; k++) if (bsExact(s, k) >= 0) valid++;
      if (valid < P.minValid) continue;
      const a0 = bpx(s, c - P.longStart), a1 = bpx(s, c - P.longEnd), a2 = bpx(s, c), a3 = bpx(s, c - P.recent);
      if (!(a0 > 0 && a1 > 0 && a2 > 0 && a3 > 0) || !(a2 / a3 - 1 > bRecent)) continue;
      out.push({ code: s.code, v: a1 / a0 - 1 });
    }
    return out.sort((a, b) => a.v - b.v || (rk.get(a.code) as number) - (rk.get(b.code) as number));
  };
  const brutePf = (c: number, P: PfP): { code: string; v: number }[] => {
    const out: { code: string; v: number }[] = [];
    for (const { p, c: cs } of pairs) {
      const ip = bsExact(p, c), ic = bsExact(cs, c);
      if (ip < 0 || ic < 0 || !(p.vol[ip] > 0) || !(cs.vol[ic] > 0)) continue;
      let vp = 0, vc = 0, tv = 0;
      for (let k = c - P.zWin + 1; k <= c; k++) { if (bsExact(p, k) >= 0) vp++; if (bsExact(cs, k) >= 0) vc++; }
      if (vp < P.minValid || vc < P.minValid) continue;
      for (let k = c - B5_PF_TV_DAYS + 1; k <= c; k++) { const j = bsExact(p, k); if (j >= 0) tv += p.raw[j] * p.vol[j]; }
      if (!(tv / B5_PF_TV_DAYS >= P.minTv)) continue;
      const ss: number[] = [];
      for (let k = c - P.zWin; k <= c - 1; k++) { const jp = bsExact(p, k), jc = bsExact(cs, k); if (jp >= 0 && jc >= 0 && p.close[jp] > 0 && cs.close[jc] > 0) ss.push(Math.log(p.close[jp] / cs.close[jc])); }
      if (ss.length < 2) continue;
      const mu = ss.reduce((a, b) => a + b, 0) / ss.length, sd = Math.sqrt(ss.reduce((a, b) => a + (b - mu) ** 2, 0) / (ss.length - 1));
      const sc = bpx(p, c), cc = bpx(cs, c);
      if (sd > 0 && sc > 0 && cc > 0) out.push({ code: p.code, v: (Math.log(sc / cc) - mu) / sd });
    }
    return out.sort((a, b) => a.v - b.v || (a.code < b.code ? -1 : 1));
  };
  const bruteBs = (c: number, P: BsP): { code: string; v: number }[] => {
    const d = CAL[c], m = membAt(d), el: S[] = [];
    if (!m) return [];
    for (const s of h.stocks) {
      const i = bsExact(s, c);
      if (i < 0 || excluded.has(s.code)) continue;
      const mk = m.get(s.code);
      if (mk !== "KOSPI" && mk !== "KOSDAQ") continue;
      let rows = 0;
      for (let k = 0; k <= c; k++) if (bsExact(s, k) >= 0) rows++;
      if (rows < P.minRows || s.raw[i] < P.minPrice) continue;
      let zero = 0, zero20 = false;
      for (let k = c - P.zeroVolWin + 1; k <= c; k++) { const j = bsExact(s, k); if (j < 0 || s.vol[j] === 0) { zero++; if (k > c - P.recentZeroWin) zero20 = true; } }
      if (zero > P.zeroVolMax || zero20) continue;
      const tvs: number[] = [];
      for (let k = c - P.tvMedianDays + 1; k <= c; k++) { const j = bsExact(s, k); tvs.push(j < 0 ? 0 : s.raw[j] * s.vol[j]); }
      tvs.sort((a, b) => a - b);
      const med = tvs.length % 2 ? tvs[(tvs.length - 1) / 2] : (tvs[tvs.length / 2 - 1] + tvs[tvs.length / 2]) / 2;
      if (!(med >= P.minTv)) continue;
      el.push(s);
    }
    const vals = el.map((s) => {
      const r = (k: number): number => { const a = bpx(s, k - 1), b = bpx(s, k); return a > 0 && b > 0 ? b / a - 1 : 0; };
      const rs: number[] = []; for (let k = c - P.volWin + 1; k <= c; k++) rs.push(r(k));
      const mu = rs.reduce((x, y) => x + y, 0) / rs.length, sd = Math.sqrt(rs.reduce((x, y) => x + (y - mu) ** 2, 0) / (rs.length - 1));
      const last: number[] = []; for (let k = c - P.topWin + 1; k <= c; k++) last.push(r(k));
      last.sort((x, y) => y - x);
      let tv = 0;
      for (let k = c - P.turnWin + 1; k <= c; k++) { const j = bsExact(s, k); if (j >= 0 && s.mcapRow[j] > 0) tv += (s.raw[j] * s.vol[j]) / (s.mcapRow[j] * 1e8); }
      return [sd, (last[0] + last[1] + last[2]) / 3, tv / P.turnWin];
    });
    const pr = (col: number): number[] => vals.map((v) => { const x = v[col]; let less = 0, eq = 0; for (const w of vals) { if (w[col] < x) less++; else if (w[col] === x) eq++; } return vals.length > 1 ? (less + (eq - 1) / 2) / (vals.length - 1) : 0; });
    const p0 = pr(0), p1 = pr(1), p2 = pr(2);
    return el.map((s, k) => ({ code: s.code, v: (p0[k] + p1[k] + p2[k]) / 3 })).sort((a, b) => a.v - b.v || (a.code < b.code ? -1 : 1));
  };
  const bruteTs = (c: number, P: TsP): string[] => {
    const out: string[] = [];
    if (c - P.win + 1 < 0) return out;
    for (const s of bruteRank(c)) {
      let valid = 0;
      for (let k = c - P.win + 1; k <= c; k++) if (bsExact(s, k) >= 0) valid++;
      if (valid < P.minValid) continue;
      let mx = Number.NEGATIVE_INFINITY;
      for (let k = c - P.win + 1; k <= c - 1; k++) { const v = bpx(s, k); if (v > mx) mx = v; }
      if (bpx(s, c) > mx) out.push(s.code);
    }
    return out;
  };
  const bruteMvCov = (c: number, P: MvP): { codes: string[]; S: Float64Array } => {
    const codes: string[] = [], cols: number[][] = [];
    for (const s of bruteRank(c).slice(0, P.top)) {
      if (c - P.win + 1 < 1) continue;
      let valid = 0;
      for (let k = c - P.win + 1; k <= c; k++) if (bsExact(s, k) >= 0) valid++;
      if (valid < P.minValid) continue;
      const r: number[] = [];
      for (let k = c - P.win + 1; k <= c; k++) { const a = bpx(s, k - 1), b = bpx(s, k); r.push(a > 0 && b > 0 ? b / a - 1 : 0); }
      codes.push(s.code); cols.push(r);
    }
    const n = codes.length, T = P.win, mean = cols.map((r) => r.reduce((a, b) => a + b, 0) / T), S = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      let s = 0;
      for (let t = 0; t < T; t++) s += (cols[i][t] - mean[i]) * (cols[j][t] - mean[j]);
      s /= T - 1;
      S[i * n + j] = i === j ? s : P.lambda * s;
    }
    return { codes, S };
  };
  const fails: string[] = [];
  const note = (m: string | null, tag: string): void => { if (m) { fails.push(`${tag}: ${m}`); } };

  // =====================================================================================================================
  // 사전 점검 (ALLOC_MODE=repro, 성과 미계산)
  // =====================================================================================================================
  if (MODE === "repro") {
    const checkStrat = <P,>(tag: string, def: Strat<P>, brSorted: (c: number, P: P) => { code: string; v: number }[], modSorted: (c: number, P: P) => { code: string; v: number }[], nOf: (P: P) => number, keepOf: (P: P) => number, F: boolean, nbStep: number): void => {
      const cS = startOf(def, false);
      const variants: [string, P, number][] = [["기본", def.P0, 1], ...def.nbs.map(([lb, ch]) => [lb, { ...def.P0, ...ch }, nbStep] as [string, P, number])];
      for (const [lb, Pv, step] of variants) {
        let nBad = 0, nDays = 0, nSel = 0, firstBad = "";
        const wrap: Strat<P> = { ...def, targets: (c, held, Pp, m, swap) => {
          const t = def.targets(c, held, Pp, m, swap);
          if (!swap) { const a = [...t.keys()].sort().join(), b = [...held].sort().join(); if (a !== b) { nBad++; firstBad ||= `${CAL[c]} 비교체일 목표 ≠ 보유`; } return t; }
          if (nDays++ % step !== 0) return t;
          const a = modSorted(c, Pp), b = brSorted(c, Pp), msg = cmpLists("순위", a, b, 1e-9);
          if (msg) { nBad++; firstBad ||= `${CAL[c]} ${msg}`; }
          else {
            const sel = bruteSelect(b.map((x) => x.code), held, nOf(Pp), keepOf(Pp)), w = (1 / nOf(Pp)) * m;
            nSel++;
            const same = sel.length === t.size && sel.every((code) => Math.abs((t.get(code) ?? -1) - w) < 1e-15);
            if (!same) { nBad++; firstBad ||= `${CAL[c]} 선정 ${sel.length}개 ≠ 모듈 ${t.size}개`; }
          }
          return t;
        } };
        runS(wrap, Pv, cS, F ? { ma: B5_MA_DAYS } : null, { lag: 1 });
        console.log(`  ${tag} ${lb}${F ? "(필터 형태)" : ""}: 신호일 ${nDays}일 중 대조 ${nSel}일, 불일치 ${nBad}건 ${nBad === 0 ? "통과" : `불일치 (${firstBad})`}`);
        if (nBad > 0) note(`${tag} ${lb} ${firstBad}`, "신호 대조");
      }
    };
    console.log(`\n=== 1. 구조·시작일 (첫 유효 신호일 = 평가 시작 전날) ===`);
    const starts = { RM1: startOf(RM1, false), LR1: startOf(LR1, false), PF1: startOf(PF1, false), MV1: startOf(MV1, false), BS1: startOf(BS1, false) };
    for (const [k, c] of Object.entries(starts)) console.log(`  ${k}: 첫 신호일 ${CAL[c]}(평가 시작 ${CAL[c + 1]}), 월말 신호일 ${monthEndIdx.filter((x) => x >= c).length}개(분기 ${monthEndIdx.filter((x) => x >= c && isQuarterEnd(x)).length}개)`);
    console.log(`  TS1: 평가 시작 ${CAL[cTS + 1]}(초기 ${CAL[cTS]})`);
    {
      const cnt = (f: (c: number) => number): string => { const v = monthEndIdx.filter((c) => c >= 253).map(f); return `최소 ${Math.min(...v)} / 중앙값 ${median(v)} / 최대 ${Math.max(...v)}`; };
      console.log(`  RM1 점수 있는 종목 수(월말, K200P 안): ${cnt((c) => rmSorted(c, B5_RM_P0).length)}`);
      console.log(`  LR1 후보 수(월말; 최근 수익률 > 069500, 유효 일수 조건): ${cnt((c) => lrCands(c, B5_LR_P0).length)} | 후보 20개 미만인 분기말 ${monthEndIdx.filter((c) => c >= starts.LR1 && isQuarterEnd(c) && lrCands(c, B5_LR_P0).length < 20).length}개`);
      console.log(`  PF1 대상 우선주 수(월말, 5억 기준): ${cnt((c) => pfElig(c, B5_PF_P0).length)} | 10개 미만인 월 ${monthEndIdx.filter((c) => c >= starts.PF1 && pfElig(c, B5_PF_P0).length < 10).length}개 / 전체 ${monthEndIdx.filter((c) => c >= starts.PF1).length}개 | 우선주 짝 ${pairs.length}개`);
      console.log(`  MV1 자산 수(월말, 상위 100 중 유효): ${cnt((c) => mvCov(c, B5_MV_P0).n)}`);
      console.log(`  BS1 유니버스 크기(월말): ${cnt((c) => bsElig(c, B5_BS_P0).length)}`);
    }
    console.log(`\n=== 2. 신호 독립 대조 (모듈 = 브루트포스(이진 탐색·직접 합산, 과거 이력만), 실제 보유 경로 위에서; 기본은 모든 신호일, 이웃은 표본) ===`);
    checkStrat("RM1", RM1, (c, P) => bruteRm(c, P), (c, P) => rmSorted(c, P).map((x) => ({ code: x.code, v: x.sc })), (P) => P.n, (P) => P.n * P.keepMult, false, 6);
    checkStrat("RM1", RM1, (c, P) => bruteRm(c, P), (c, P) => rmSorted(c, P).map((x) => ({ code: x.code, v: x.sc })), (P) => P.n, (P) => P.n * P.keepMult, true, 1000000);
    checkStrat("LR1", LR1, (c, P) => bruteLr(c, P), (c, P) => lrCands(c, P).map((x) => ({ code: x.code, v: x.long })), (P) => P.n, (P) => P.n * P.keepMult, false, 1);
    checkStrat("LR1", LR1, (c, P) => bruteLr(c, P), (c, P) => lrCands(c, P).map((x) => ({ code: x.code, v: x.long })), (P) => P.n, (P) => P.n * P.keepMult, true, 1000000);
    checkStrat("PF1", PF1, (c, P) => brutePf(c, P), (c, P) => pfElig(c, P).map((x) => ({ code: x.code, v: x.z })), (P) => P.n, (P) => P.n * P.keepMult, false, 1);
    checkStrat("BS1", BS1, (c, P) => bruteBs(c, P), (c, P) => bsSorted(c, P).map((x) => ({ code: x.code, v: x.score })), (P) => P.n, (P) => P.n * P.keepMult, false, 12);
    {
      // TS1: 매 거래일 신호 목록 대조(기본은 모든 판단일, 이웃은 10일마다)
      for (const [lb, P] of [["기본", B5_TS_P0] as [string, TsP], ...B5_TS_NB.map(([l, ch]) => [l, { ...B5_TS_P0, ...ch }] as [string, TsP])]) {
        let nBad = 0, nDays = 0, nSig = 0, firstBad = "";
        const step = lb === "기본" ? 1 : 10;
        for (let c = cTS; c < nCal - 1; c += step) {
          const a = tsSignals(c, P).map((s) => s.code), b = bruteTs(c, P);
          nDays++; nSig += a.length;
          if (a.join() !== b.join()) { nBad++; firstBad ||= `${CAL[c]} 모듈 ${a.length}개 ≠ 브루트 ${b.length}개`; }
        }
        console.log(`  TS1 ${lb}: 판단일 ${nDays}일 중 신호 합 ${nSig}개, 불일치 ${nBad}일 ${nBad === 0 ? "통과" : `불일치 (${firstBad})`}`);
        if (nBad > 0) note(`TS1 ${lb} ${firstBad}`, "신호 대조");
      }
    }
    {
      // MV1: KKT·합·상하한(모든 신호일), 서로 다른 시작점 풀이와 목적함수 대조(표본 24개)
      const cS = starts.MV1, days = monthEndIdx.filter((c) => c >= cS), pick = new Set(days.filter((_, k) => k % Math.max(1, Math.floor(days.length / B5_MV_CHECK_SAMPLES)) === 0).slice(0, B5_MV_CHECK_SAMPLES));
      let nChk = 0, maxWDiff = 0, maxObjRel = 0, nBad = 0, firstBad = "";
      const wrap: Strat<MvP> = { ...MV1, targets: (c, held, P, m, swap) => {
        const t = MV1.targets(c, held, P, m, swap);
        let sum = 0;
        for (const [, w] of t) { sum += w; if (w < -1e-15 || w > P.cap * m + 1e-12) { nBad++; firstBad ||= `${CAL[c]} 비중 범위 위반`; } }
        if (Math.abs(sum - m) > 1e-9) { nBad++; firstBad ||= `${CAL[c]} 합 ${sum} ≠ ${m}`; }
        if (pick.has(c)) {
          const { codes, S } = bruteMvCov(c, P), n = codes.length, start = new Float64Array(n);
          for (let i = 0; i < n; i++) start[i] = i < Math.ceil(n / 5) ? 1 : 0;
          const sp = new Float64Array(n); projectCappedSimplex(start, Math.max(P.cap, 1 / n), sp);
          const r = solveMinVar(S, n, Math.max(P.cap, 1 / n), B5_MV_KKT_TOL, B5_MV_MAX_ITER, sp);
          const wm = new Float64Array(n); codes.forEach((code, i) => { wm[i] = t.get(code) ?? 0; });
          let obj = 0; for (let i = 0; i < n; i++) { let q = 0; for (let j = 0; j < n; j++) q += S[i * n + j] * wm[j]; obj += wm[i] * q; }
          let dmax = 0; for (let i = 0; i < n; i++) dmax = Math.max(dmax, Math.abs(wm[i] - r.w[i]));
          maxWDiff = Math.max(maxWDiff, dmax); maxObjRel = Math.max(maxObjRel, Math.abs(obj - r.obj * m * m) / r.obj);
          nChk++;
          if (!(Math.abs(obj - r.obj * m * m) / r.obj < 1e-9)) { nBad++; firstBad ||= `${CAL[c]} 목적함수 상대 차이 ${Math.abs(obj - r.obj) / r.obj}`; }
        }
        return t;
      } };
      runS(wrap, MV1.P0, cS, null, { lag: 1 });
      console.log(`  MV1 기본: 신호일 ${days.length}일 KKT 최대 위반 ${mvStats.maxKkt.toExponential(2)}(기준 ${B5_MV_KKT_TOL}), 최대 반복 ${mvStats.maxIter}, 풀이 ${mvStats.solves}회, 미수렴 ${mvStats.fails}회 | 두 번째 시작점 풀이 대조 ${nChk}일: 비중 최대 차이 ${maxWDiff.toExponential(2)}, 목적함수 상대 차이 최대 ${maxObjRel.toExponential(2)} | 범위·합 위반 ${nBad}건 ${nBad === 0 ? "통과" : `불일치 (${firstBad})`}`);
      if (nBad > 0) note(firstBad, "MV1");
      for (const [lb, ch] of B5_MV_NB) { runS(MV1, { ...MV1.P0, ...ch }, cS, null, { lag: 1 }); console.log(`  MV1 ${lb}: 풀이 완료(KKT 누적 최대 ${mvStats.maxKkt.toExponential(2)}, 미수렴 ${mvStats.fails}회)`); }
    }
    console.log(`\n=== 3. 체결 타이밍·구조 점검 (기본 설정 lag 1·2: 진입 = 신호일 + lag, 보유 종목 수 ≤ 목표, 비용 ≥ 0) ===`);
    const timing = <P,>(tag: string, def: Strat<P>, F: boolean, nMax: (P: P) => number): void => {
      const cS = startOf(def, false), sd = new Set(sigDays(def, F).filter((c) => c >= cS));
      for (const lag of [1, 2]) {
        const r = runS(def, def.P0, cS, F ? { ma: B5_MA_DAYS } : null, { lag, detail: true });
        const badEntry = r.entryCs.filter((c) => !sd.has(c - lag)).length, over = r.nPos.some((n, i) => n - r.nDefer[i] > nMax(def.P0)), negCost = r.costFrac.filter((x) => x < -1e-12).length, nanRet = r.ret.filter((x) => !Number.isFinite(x)).length;
        console.log(`  ${tag}${F ? "(필터)" : ""} lag ${lag}: 진입 ${r.entryCs.length}건, 보유 구간 닫힘 ${r.trades.length}건·열림 ${r.open.length}건 | 신호일 + ${lag}이 아닌 진입 ${badEntry}건 | 최대 보유 종목 ${Math.max(...r.nPos)}(순연 청산 제외 ${Math.max(...r.nPos.map((n, i) => n - r.nDefer[i]))}, 목표 ${nMax(def.P0)}) | 음수 비용 ${negCost}일, 비정상 수익률 ${nanRet}일 | 폐지 청산 ${r.trades.filter((t) => t.reason.startsWith("폐지")).length}건, 거래정지 매수 건너뜀 ${r.haltSkip}건, 청산 순연 ${r.exitDefer}건`);
        if (badEntry > 0 || over || negCost > 0 || nanRet > 0) note(`${tag} lag ${lag}`, "체결 타이밍");
      }
    };
    timing("RM1", RM1, false, (P) => P.n); timing("RM1", RM1, true, (P) => P.n);
    timing("LR1", LR1, false, (P) => P.n); timing("LR1", LR1, true, (P) => P.n);
    timing("PF1", PF1, false, (P) => P.n); timing("MV1", MV1, false, () => 100); timing("BS1", BS1, false, (P) => P.n);
    for (const lag of [1, 2]) {
      const r = runTS(B5_TS_P0, { lag, detail: true });
      const sigOk = r.entryCs.every((c) => tsSignals(c - lag, B5_TS_P0).some((s) => r.trades.concat([]).length >= 0 && s !== undefined));
      const holds = r.trades.map((t) => t.exitC - t.entryC);
      console.log(`  TS1 lag ${lag}: 진입 ${r.entryCs.length}건, 닫힌 거래 ${r.trades.length}건, 최대 보유 ${Math.max(...r.nPos)}(슬롯 ${B5_TS_P0.slots}), 보유 일수 중앙값 ${median(holds)}, 손절 ${r.trades.filter((t) => t.reason.startsWith("손절")).length}건 ${sigOk ? "" : "(신호 대조 실패)"}`);
      if (Math.max(...r.nPos) > B5_TS_P0.slots) note(`TS1 lag ${lag} 슬롯 초과`, "체결 타이밍");
    }
    console.log(`\n=== 4. BS1 단계 2 검증 (가격 Parquet 안, 외부 호출 없음) ===`);
    {
      const evs: { code: string; eventDate: string; factor: number }[] = [];
      for (const [code, list] of h.adjustments) for (const e of list) evs.push({ code, eventDate: e.eventDate, factor: e.factor });
      evs.sort((a, b) => (a.eventDate < b.eventDate ? -1 : 1));
      const pickEv = [0, 1, 2, 3, 4].map((k) => evs[Math.floor((evs.length * (k + 0.5)) / 5)]);
      for (const e of pickEv) {
        const s = h.byCode.get(e.code); if (!s) continue;
        const i = s.dates.findIndex((d) => d >= e.eventDate);
        if (i < 1) continue;
        const rawR = s.raw[i] / s.raw[i - 1], adjR = s.close[i] / s.close[i - 1];
        console.log(`  분할·권리락 표본 ${label(e.code)} ${e.eventDate} 계수 ${e.factor.toFixed(4)}: 원 종가 ${s.raw[i - 1]} → ${s.raw[i]}(비율 ${rawR.toFixed(4)}), 수정 종가 비율 ${adjR.toFixed(4)} (수정 종가 일수익률 ${f2((adjR - 1) * 100)}%)`);
      }
      const delisted = h.stocks.filter((s) => s.last < h.endedBefore);
      let vz = 0, vzRows = 0;
      for (const s of h.stocks) { let any = false; for (let i = 0; i < s.vol.length; i++) if (s.vol[i] === 0) { vzRows++; any = true; } if (any) vz++; }
      console.log(`  상장폐지(마지막 행 < ${h.endedBefore}) ${delisted.length}종목: 마지막 행 날짜가 폐지 전 날짜로 들어 있음(마지막 행 거래량 0인 종목 ${delisted.filter((s) => s.vol[s.vol.length - 1] === 0).length}개) | 거래정지일 표기: 거래량 0 행(가격은 직전 값 유지)이 있는 종목 ${vz}개, 행 ${vzRows}개 | 달력 전체 ${nCal}일`);
      for (const d of ["2011-12-29", "2016-12-29", "2020-06-30", "2023-09-27", "2026-10-23"]) {
        const c = h.calIdx.get(d); if (c === undefined) continue;
        const a = new Set(rank200(c).list.map((s) => s.code)), b = new Set(bruteRank(c).map((s) => s.code));
        console.log(`  시총 상위 200 대조 ${d}: K200P 모듈 ${a.size} ∩ 월말 시장표 방식 ${b.size} = ${[...a].filter((x) => b.has(x)).length}종목 일치`);
      }
      console.log(`  수정 종가 일수익률 대 K200P 수정주가 수익률: 같은 자료(h.stocks.close)를 쓰므로 정의상 동일(검증 대상 아님)`);
    }
    console.log(`\n사전 점검 종료: DS6 재현, 신호 독립 대조(RM1·LR1·PF1·BS1·TS1 기본·이웃, MV1 KKT·두 번째 시작점), 체결 타이밍, BS1 단계 2 검증 ${fails.length === 0 ? "통과" : `— 실패 ${fails.length}건`}. 성과는 계산·출력하지 않았다 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    if (fails.length) { for (const f of fails) console.log(`  실패: ${f}`); throw new Error("사전 점검 실패 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)"); }
    return;
  }

  // =====================================================================================================================
  // 시험 (블록별)
  // =====================================================================================================================
  const verdicts: Verdict[] = [];
  let tn = Number(process.env.B5_TRIAL ?? "294");
  const trialNums: number[] = [];
  const doS = <P,>(def: Strat<P>, id: string, F: boolean, title: string): void => {
    if (IDS && !IDS.has(id)) return;
    const cS = startOf(def, false), Wx = windowsFor(cS), trial = tn++;
    trialNums.push(trial);
    console.log(`\n연속 평가(${id}, 시험 ${trial}): 첫 신호일 ${CAL[cS]}, 수익률 집계 ${Wx.FULL.from}~${h.dataEnd} | 구간 ${Wx.NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    verdicts.push(evaluate(h, Wx, mkS(def, id, trial, F, cS, Wx, title)));
  };
  const doC = <P,>(def: Strat<P>, id: string, title: string): void => {
    if (IDS && !IDS.has(id)) return;
    const cS = startOf(def, false), Wx = windowsFor(cS), trial = tn++;
    trialNums.push(trial);
    console.log(`\n연속 평가(${id}, 시험 ${trial}): 위성 첫 신호일 ${CAL[cS]}, 수익률 집계 ${Wx.FULL.from}~${h.dataEnd} (069500·DS6도 같은 구간)`);
    verdicts.push(evaluate(h, Wx, mkC(def, id, trial, cS, Wx, title)));
  };
  const ttl = (nm: string, extra: string): string => `${nm}: ${extra}`;

  // =====================================================================================================================
  // 저평가(PBR) VB1·VB2·VB1C 공용: 자본(정기 재무, 접수일 < 신호일) · PBR · 소멸 규칙 · 시작일·구간
  // =====================================================================================================================
  interface EqRec { rcept: string; eq: number; cfs: boolean }
  const eqBy = new Map<string, EqRec[]>();
  const eqSrc = { r: 0, pre: 0 };
  const loadEqTables = async (): Promise<void> => {
    const isoD = (d: unknown): string => { const x = String(d ?? ""); return /^\d{8}$/.test(x) ? `${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6)}` : x.slice(0, 10); };
    const push = (stock: string, rcept: string, eq: number, cfs: boolean): void => { if (!rcept) return; const a = eqBy.get(stock) ?? []; a.push({ rcept, eq, cfs }); eqBy.set(stock, a); };
    const finBuf = await downloadBuf(`${R_STORE_PREFIX}/fin.parquet`);
    if (!finBuf) throw new Error("research/r_allcap/fin.parquet이 없다 — 중단");
    for (const r of await decodeTable(finBuf)) { const eq = typeof r.eq_c === "number" && Number.isFinite(r.eq_c) ? r.eq_c : null; if (eq === null) continue; push(String(r.stock_code), isoD(r.rcept_dt), eq, String(r.fs_div) === "CFS"); eqSrc.r++; }
    const pre = await downloadBuf(VEQ_DATA_FILE);
    if (pre) for (const r of await decodeTable(pre)) { const eq = typeof r.eq_total === "number" && Number.isFinite(r.eq_total) ? r.eq_total : null; if (eq === null) continue; push(String(r.stock_code), isoD(r.rcept_dt), eq, String(r.eq_total_basis) === "cons"); eqSrc.pre++; }
    // 접수일 오름차순, 같은 접수일이면 별도 → 연결 순(마지막 = 연결 우선)
    for (const a of eqBy.values()) a.sort((x, y) => (x.rcept < y.rcept ? -1 : x.rcept > y.rcept ? 1 : 0) || Number(x.cfs) - Number(y.cfs));
    console.log(`자본 자료 적재: R fin ${eqSrc.r}행 + 2016 이전 수집 ${eqSrc.pre}행(${pre ? "있음" : "없음"}), 종목 ${eqBy.size}개`);
  };
  const dayDiffV = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / 86_400_000;
  /** 접수일 < 신호일(접수일 다음 거래일부터 반영)인 가장 최근 보고서. 같은 접수일이 여럿이면 연결 우선. */
  const latestEq = (code: string, d: string): EqRec | undefined => {
    const a = eqBy.get(code);
    if (!a) return undefined;
    let lo = 0, hi = a.length - 1, r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m].rcept < d) { r = m; lo = m + 1; } else hi = m - 1; }
    return r >= 0 ? a[r] : undefined;
  };
  type PbrWhy = "ok" | "no_report" | "stale" | "neg" | "no_row";
  const pbrAt = (c: number, s: S, maxAge: number): { pbr: number; why: PbrWhy } => {
    const d = CAL[c], i = s.idx.get(d);
    if (i === undefined) return { pbr: Number.NaN, why: "no_row" };
    const e = latestEq(s.code, d);
    if (!e) return { pbr: Number.NaN, why: "no_report" };
    if (dayDiffV(e.rcept, d) > maxAge) return { pbr: Number.NaN, why: "stale" };
    if (!(e.eq > 0)) return { pbr: Number.NaN, why: "neg" };
    return { pbr: (s.mcapRow[i] * 1e8) / e.eq, why: "ok" };
  };
  const vbMemo = new Map<string, string[]>();
  /** BS1 적격 종목 중 PBR이 있는 종목을 점수 오름차순(낮을수록 좋음)으로. wB = 0이면 PBR 순위만, 아니면 (wB × BS1 점수 + wP × PBR 백분위) ÷ (wB + wP). */
  const vbSorted = (c: number, P: VbP): string[] => {
    const key = `${c}|${P.maxAge}|${P.wB}|${P.wP}`, hit = vbMemo.get(key);
    if (hit) return hit;
    const el = bsElig(c, B5_BS_P0), list: { code: string; pbr: number }[] = [];
    for (const code of el) { const x = pbrAt(c, h.byCode.get(code) as S, P.maxAge); if (x.why === "ok") list.push({ code, pbr: x.pbr }); }
    let out: string[];
    if (P.wB === 0) out = list.sort((a, b) => a.pbr - b.pbr || (a.code < b.code ? -1 : 1)).map((x) => x.code);
    else {
      const bsMap = new Map(bsSorted(c, B5_BS_P0).map((x) => [x.code, x.score] as [string, number]));
      const pr = pctRank(list.map((x) => x.pbr));
      out = list.map((x, k) => ({ code: x.code, sc: (P.wB * (bsMap.get(x.code) as number) + P.wP * pr[k]) / (P.wB + P.wP) })).sort((a, b) => a.sc - b.sc || (a.code < b.code ? -1 : 1)).map((x) => x.code);
    }
    vbMemo.set(key, out);
    return out;
  };
  /** 소멸 처리(사용자 지정 2026-11-20, 이번 결과를 보기 전에 정함): 마지막 종가 청산, 단 사라지기 직전 DQ_VANISH_WINDOW_DAYS(20)거래일 안 거래정지(행 없는 날) DQ_VANISH_HALT_DAYS(5)일 이상이거나 마지막 종가가 DQ_VANISH_MIN_CLOSE(1,000원) 미만이면 전액 손실. */
  const vanishMemo = new Map<string, boolean>();
  const vbVanishLoss = (code: string): boolean => {
    let v = vanishMemo.get(code);
    if (v === undefined) {
      const s = h.byCode.get(code) as S, li = h.calIdx.get(s.last) as number;
      let halt = 0;
      for (let k = Math.max(li - DQ_VANISH_WINDOW_DAYS + 1, 0); k <= li; k++) if (!s.idx.has(CAL[k])) halt++;
      v = halt >= DQ_VANISH_HALT_DAYS || s.raw[s.dates.length - 1] < DQ_VANISH_MIN_CLOSE;
      vanishMemo.set(code, v);
    }
    return v;
  };
  const V_START = (process.env.V_START ?? "").trim(), V_CASE = V_START >= VB_C2_START ? "C2" : "C1"; // 시작 월말이 2016-05-31 이후면 C-2 규칙(두 구간), 이전이면 C-1(기존 3구간)
  const cStartV = V_START ? CAL.indexOf(V_START) : -1;
  const mkVB = (id: string, P0: VbP, nbs: [string, Partial<VbP>][]): Strat<VbP> => ({
    id, P0, nbs, signalDays: monthEndIdx.filter((c) => c >= cStartV), isSwap: () => true,
    targets: (c, held, P, m) => equalW(pickKeep(vbSorted(c, P), held, P.n, P.n * P.keepMult), 1 / P.n, m),
    pool: (c, P) => vbSorted(c, P),
    slip: (code, c, lag) => (rank200(Math.max(c - lag, 0)).rank.has(code) ? B5_BS_SLIP_K200 : B5_BS_SLIP_OTHER), vanish: "rule", vanishLoss: vbVanishLoss, wOf: (P) => 1 / P.n,
  });
  const requireStart = (): void => { if (cStartV < 0 || !monthEndIdx.includes(cStartV)) throw new Error(`V_START=${V_START || "(없음)"}이 월말 신호일이 아니다 — 중단`); };
  /** 연속 + 구간: C-2는 2016-05~2021-12 / 2022-01~2026-10-26(두 구간 모두 069500 우위일 때 B 통과), C-1은 기존 3구간. */
  const windowsV = (cS: number): Windows => {
    const from = CAL[cS + 1];
    if (V_CASE !== "C2") return windowsFor(cS);
    const NW: [string, Win][] = [[`구간 1 ${from}~${VB_C2_WINDOW1_TO}`, { from, to: VB_C2_WINDOW1_TO }], [`구간 2 ${VB_C2_WINDOW2_FROM}~${h.dataEnd}`, { from: VB_C2_WINDOW2_FROM, to: "9999-12-31" }]];
    const FULLX: Win = { from, to: "9999-12-31" };
    return { NW, FULL: FULLX, ALL: [...NW, [`연속 전체 ${from.slice(0, 7)}~${h.dataEnd.slice(0, 7)}`, FULLX]], noEx26: true, contamNote: "경고(오염): 이 구간(2011~2026)은 선행 연구에서 반복해 본 데이터다. 이 가설은 BS1·RT1·DS13 결과를 본 뒤 만든 것(선택 편향)이라 순수 검증이 아니다." };
  };
  const BSA_FOR_V: Strat<BsP> = { ...BS1, targets: (c, _held, P, m) => { const el = bsElig(c, P); return equalW(el, 1 / Math.max(el.length, 1), m); } };
  if (MODE === "kcorr") {
    // K200P 가격 오류 17건 보정값 수집(KRX Open API 일별매매정보 공식 등락률), 사전등록 docs/research/k200p-correction-prereg.md.
    if (PRICE_CORRECTION_ON) throw new Error("kcorr는 보정 미적용으로만 실행한다");
    if (blockedNow()) throw new Error(`호출 금지 시간대(KST 14:00~15:40, 03:50~06:20)라 실행하지 않는다 (KST ${kst()})`);
    const key = (process.env.KRX_API_KEY ?? "").trim();
    if (!key) throw new Error("KRX_API_KEY가 없다");
    let calls = 0;
    type Rw = Record<string, string>;
    const dayCache = new Map<string, { rows: Rw[]; note: string }>();
    const krx = async (endpoint: string, date8: string): Promise<{ rows: Rw[]; note: string }> => {
      const ck = `${endpoint}|${date8}`, hit = dayCache.get(ck);
      if (hit) return hit;
      if (calls >= K200P_CORR_MAX_CALLS) throw new Error(`KRX 호출 상한 ${K200P_CORR_MAX_CALLS}회 도달`);
      calls++;
      await sleep(K200P_CORR_SLEEP_MS);
      let out: { rows: Rw[]; note: string };
      try {
        const res = await fetch(`${KRX_API_BASE}/${endpoint}?basDd=${date8}`, { headers: { AUTH_KEY: key } });
        const text = await res.text();
        let j: Record<string, unknown> | null = null;
        try { j = JSON.parse(text) as Record<string, unknown>; } catch { j = null; }
        out = { rows: (j?.OutBlock_1 as Rw[] | undefined) ?? [], note: `HTTP ${res.status} ${String(j?.respCode ?? "-")} ${String(j?.respMsg ?? "").slice(0, 40)}` };
      } catch (e) { out = { rows: [], note: `fetch 실패 ${e instanceof Error ? e.message.slice(0, 60) : ""}` }; }
      dayCache.set(ck, out);
      return out;
    };
    const codeOf = (r: Rw): string => { const c = r.ISU_SRT_CD ?? r.ISU_CD ?? ""; return c.length === 12 ? c.slice(3, 9) : c; };
    const flucOf = (r: Rw | undefined): number | null => { if (!r) return null; const n = Number(String(r.FLUC_RT ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
    const ourRet = (code: string, d: string): number | null => { const s2 = byCode.get(code); if (!s2) return null; const i = s2.dates.indexOf(d); return i >= 1 && s2.close[i - 1] > 0 ? s2.close[i] / s2.close[i - 1] - 1 : null; };
    const find = async (code: string, d: string): Promise<{ fl: number | null; mkt: string; note: string }> => {
      const d8 = d.replace(/-/g, "");
      for (const [ep, nm] of [["sto/stk_bydd_trd", "유가증권"], ["sto/ksq_bydd_trd", "코스닥"]] as const) {
        const r = await krx(ep, d8), row = r.rows.find((x) => codeOf(x) === code);
        if (row) return { fl: flucOf(row), mkt: nm, note: r.note };
        if (ep === "sto/stk_bydd_trd" && r.rows.length === 0) return { fl: null, mkt: "-", note: `${r.note} (응답 행 없음)` };
      }
      return { fl: null, mkt: "-", note: "종목 없음" };
    };
    console.log(`\n=== KRX 보정값 수집(KST ${kst()}; 호출 상한 ${K200P_CORR_MAX_CALLS}회) ===`);
    // (c) 대조용 정상일 5건
    console.log("| 대조 종목 | 대조 날짜(미룬 경우 실제) | 기존 수정 수익률 % | KRX 등락률 % | 차이 %p | 판정 |\n|---|---|---|---|---|---|");
    let controlFail = 0;
    for (const c0 of K200P_CORR_CONTROLS) {
      let d = c0.date, res: { fl: number | null; mkt: string; note: string } = { fl: null, mkt: "-", note: "" }, mine: number | null = null;
      for (let shift = 0; shift <= K200P_CORR_CONTROL_MAX_SHIFT_DAYS; shift++) {
        if (shift > 0) { let t = new Date(Date.parse(d) + 86_400_000); while (t.getUTCDay() === 0 || t.getUTCDay() === 6) t = new Date(t.getTime() + 86_400_000); d = t.toISOString().slice(0, 10); }
        mine = ourRet(c0.code, d);
        if (mine === null) continue;
        res = await find(c0.code, d);
        if (res.fl !== null) break;
      }
      const diff = res.fl !== null && mine !== null ? res.fl - mine * 100 : Number.NaN, ok = Number.isFinite(diff) && Math.abs(diff) <= K200P_CORR_CONTROL_MAX_DIFF_PP + 1e-9;
      if (!ok) controlFail++;
      console.log(`| ${label(c0.code)} | ${d}${d !== c0.date ? ` (원 ${c0.date})` : ""} | ${mine === null ? "-" : f2(mine * 100)} | ${res.fl === null ? "-" : f2(res.fl)} | ${Number.isFinite(diff) ? f2(diff) : "-"} | ${ok ? "일치(≤0.1%p)" : "불일치·대조 불가 → 중단 조건"} |`);
    }
    // 17건
    const rows: PriceOverride[] = [];
    console.log("\n| # | 종목 | 날짜 | 기존 수정 수익률 % | KRX 등락률 % | 적용값 % | 구분 | 제한폭 | 시장 |\n|---|---|---|---|---|---|---|---|---|");
    let n17 = 0;
    for (const t of K200P_CORR_TARGETS) {
      n17++;
      const old = ourRet(t.code, t.date);
      if (old === null) throw new Error(`기존 수익률을 계산할 수 없다: ${t.code} ${t.date}`);
      const r = await find(t.code, t.date), lim = (t.date <= DQ_LIMIT_CHANGE_DATE ? DQ_LIMIT_BEFORE : DQ_LIMIT_AFTER) + DQ_LIMIT_TOL;
      const okK = r.fl !== null && Math.abs(r.fl / 100) <= lim;
      const row: PriceOverride = { code: t.code, date: t.date, ret: okK ? (r.fl as number) / 100 : 0, kind: okK ? "확인" : "미확인", krxFluc: r.fl, oldRet: old };
      rows.push(row);
      console.log(`| ${n17} | ${label(t.code)} | ${t.date} | ${f2(old * 100)} | ${r.fl === null ? "-" : f2(r.fl)} | ${f2(row.ret * 100)} | ${row.kind} | ±${f2(lim * 100)}% | ${r.mkt} |`);
    }
    // 이벤트일 교차 대조(무료: 같은 응답 안의 다른 종목, 정보용)
    {
      let nb = 0, nok = 0;
      for (const t of K200P_CORR_TARGETS) {
        const r = dayCache.get(`sto/stk_bydd_trd|${t.date.replace(/-/g, "")}`);
        if (!r) continue;
        for (const x of r.rows) { const code = codeOf(x), mine = ourRet(code, t.date), fl = flucOf(x); if (mine === null || fl === null || K200P_CORR_TARGETS.some((q) => q.code === code && q.date === t.date)) continue; nb++; if (Math.abs(fl - mine * 100) <= 0.1) nok++; }
      }
      console.log(`이벤트일 응답 교차 대조(정보용): 보정 대상이 아닌 종목-일 ${nb}개 중 |KRX 등락률 − 기존 수정 수익률| ≤ 0.1%p ${nok}개(${nb ? f2((nok / nb) * 100) : "-"}%)`);
    }
    console.log(`확인 ${rows.filter((x) => x.kind === "확인").length}건 / 미확인(0% 처리) ${rows.filter((x) => x.kind === "미확인").length}건 | KRX 호출 ${calls}회(상한 ${K200P_CORR_MAX_CALLS}) | 대조 불일치·불가 ${controlFail}건`);
    if (controlFail > 0) { console.log("대조용 정상일에서 0.1%p 넘게 다르거나 대조가 안 됨 — 보정을 중단하고 보고한다(덮어쓰기 표를 저장하지 않음)"); throw new Error("보정 중단: 대조 실패"); }
    const body: PriceOverrideFile = { version: 1, createdAt: new Date().toISOString(), rows };
    const bytes = new TextEncoder().encode(JSON.stringify(body, null, 1));
    const up = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).upload(PRICE_CORRECTION_PATH, bytes, { contentType: "application/json", upsert: true });
    if (up.error) throw new Error(`덮어쓰기 표 저장 실패: ${up.error.message}`);
    console.log(`덮어쓰기 표 저장: Storage ${PRICE_CORRECTION_PATH} (${bytes.byteLength} B, SHA-256 ${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}…) | Supabase 쓴 행 0 | KIS 호출 0 | DART 0 | ${storageLine()}`);
    return;
  }
  if (MODE === "kcov") {
    // 17건이 각 전략의 보유와 겹쳤는가(보정 미적용 보유 경로 + 보정값으로 영향 추정, 시험 아님).
    if (PRICE_CORRECTION_ON) throw new Error("kcov는 보정 미적용으로만 실행한다");
    const ov = await loadPriceOverrides();
    const pathTg = <P,>(def: Strat<P>, F: boolean, c0: number): { c: number; t: Map<string, number> }[] => {
      const out: { c: number; t: Map<string, number> }[] = [];
      let held: ReadonlySet<string> = new Set();
      for (const c of sigDays(def, F).filter((x) => x >= c0)) { const t = def.targets(c, held, def.P0, F ? filterMult(c, B5_MA_DAYS) : 1, true); out.push({ c, t }); held = new Set(t.keys()); }
      return out;
    };
    const wAt = (pt: { c: number; t: Map<string, number> }[], code: string, k: number): number => { let w = 0; for (const x of pt) { if (x.c + 1 < k) w = x.t.get(code) ?? 0; else break; } return w; };
    const cRm = startOf(RM1, false), cMv = startOf(MV1, false), cRt = startOf(RT1, false);
    const ptRm = pathTg(RM1, false, cRm), ptMv = pathTg(MV1, false, cMv), ptRt = pathTg(RT1, false, cRt), ptRtF = pathTg(RT1, true, cRt);
    const spell = (r: { trades: { code: string; entryC: number; exitC: number }[]; open?: { code: string; entryC: number }[] }, code: string, k: number): boolean => r.trades.some((t) => t.code === code && t.entryC < k && k <= t.exitC) || (r.open ?? []).some((t) => t.code === code && t.entryC < k);
    const ds6 = b6.satX.run, ds8 = build(DS6D, { smooth: DS8_SMOOTH_WIN }).satX.run;
    const names = ["DS6(위성 LV1 6%)", "DS8(위성 LV1 평활 6%)", "RM1C(위성 RM1 3%)", "MV1C(위성 MV1 비중×0.6)", "RT1(시총 비중)", "RT1F(시총 비중×필터)"] as const;
    const tot = new Map<string, { n: number; sum: number }>(names.map((n) => [n, { n: 0, sum: 0 }]));
    console.log(`\n=== 17건 보유 겹침(보정 미적용 경로; 영향 추정 = 비중 × (보정 수익률 − 기존 수익률), 단순 합 %p) ===`);
    console.log("| # | 종목 | 날짜 | 기존 → 보정 수익률 % | 겹친 전략: 비중 → 영향 %p |\n|---|---|---|---|---|");
    let idx = 0;
    for (const o of ov) {
      idx++;
      const k = h.calIdx.get(o.date) as number, d = (o.ret - o.oldRet) * 100, hits: string[] = [];
      const add = (nm: typeof names[number], w: number): void => { if (w > 0) { hits.push(`${nm}: ${f2(w * 100)}% → ${f2(w * d)}`); const t = tot.get(nm) as { n: number; sum: number }; t.n++; t.sum += w * d; } };
      if (spell(ds6, o.code, k)) add(names[0], 0.06);
      if (spell(ds8, o.code, k)) add(names[1], 0.06);
      add(names[2], 0.6 * wAt(ptRm, o.code, k)); add(names[3], 0.6 * wAt(ptMv, o.code, k)); add(names[4], wAt(ptRt, o.code, k)); add(names[5], wAt(ptRtF, o.code, k));
      console.log(`| ${idx} | ${label(o.code)} | ${o.date} | ${f2(o.oldRet * 100)} → ${f2(o.ret * 100)}(${o.kind}) | ${hits.length ? hits.join(" ; ") : "겹침 없음"} |`);
    }
    console.log("\n| 전략 | 겹친 건수 | 영향 추정 합(%p, 단순) |\n|---|---|---|");
    for (const nm of names) { const t = tot.get(nm) as { n: number; sum: number }; console.log(`| ${nm} | ${t.n} | ${f2(t.sum)} |`); }
    console.log(`\n겹침 점검 종료 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    return;
  }
  if (MODE === "ds13pre") {
    // DS13 사전 점검(성과 미계산): 하위 계좌 날짜 축·시작일, 3계좌 합성 회계(일별 설정에서 combine2와 동일, 값 기반 독립 재계산), 월말 재조정 후 비중 이탈.
    const fails: string[] = [];
    const cS13 = startOf(RM1, false), W13 = windowsFor(cS13);
    console.log(`\n=== DS13 사전 점검 (데이터 표준: ${PRICE_CORRECTION_ON ? "K200P 17건 보정 적용" : "보정 미적용(재현 확인용)"}) ===`);
    console.log(`DS6 재현 값은 위 "DS6 재현(환경 확인)" 줄 참고(보정 ${PRICE_CORRECTION_ON ? "적용" : "미적용"}). 첫 신호일 ${CAL[cS13]}(RM1), MV1 첫 신호일 ${CAL[startOf(MV1, false)]}, 수익 집계 시작 ${W13.FULL.from}`);
    if (startOf(MV1, false) !== cS13) fails.push("RM1과 MV1의 첫 신호일이 다르다");
    for (const kind of ["MV1", "LV1"] as const) {
      const d = d13Of(kind, cS13, W13), b = d.base, n = b.res.run.dates.length;
      console.log(`${kind}: 하위 계좌 ${b.sls.map((x) => `${x.dates[0]}~${x.dates[x.dates.length - 1]}(${x.dates.length}일)`).join(" | ")} | 월말 재조정 신호일 ${d.sigSet.size}개(첫 ${[...d.sigSet][0]})`);
      if (b.sls.some((x) => x.dates.length !== n)) fails.push(`${kind} 날짜 축 길이`);
      // 1) 일별 재조정·2계좌에서 combine2와 비트 동일
      const c2 = combine2(b.sls[0], b.sls[1], 0.4, CS_MOVE_COST), cn = combineN([b.sls[0], b.sls[1]], [0.4, 0.6], CS_MOVE_COST, null);
      const dev = Math.max(...c2.run.ret.map((x, i) => Math.abs(x - cn.run.ret[i])), ...c2.run.costFrac.map((x, i) => Math.abs(x - cn.run.costFrac[i])));
      console.log(`  ${kind} 합성 회계 1) combineN(일별, 코어+RM1 40:60) vs combine2: 일수익률·비용 최대 편차 ${dev.toExponential(2)} ${dev <= 1e-12 ? "통과" : "불일치"}`);
      if (!(dev <= 1e-12)) fails.push(`${kind} combineN ≠ combine2`);
      // 2) 값 기반 독립 재계산(단위·지수 수준 방식), 월말 재조정 설정
      {
        const w0 = DS13_W, m = 3, L = new Array<number>(m).fill(1), u = [...w0];
        const q: number[][] = [], ret: number[] = [];
        for (let i = 0; i < n; i++) {
          const vPrev = u.reduce((a, x, j) => a + x * L[j], 0);
          for (let j = 0; j < m; j++) L[j] *= 1 + b.sls[j].ret[i] / 100;
          const pend = q.length ? (q.shift() as number[]) : [0, 0, 0];
          const mv = pend.reduce((a, x) => a + Math.max(x, 0), 0), cs = CS_MOVE_COST * mv;
          if (mv > 0) for (let j = 0; j < m; j++) { u[j] += pend[j] / L[j]; if (pend[j] > 0) u[j] -= (cs * pend[j]) / mv / L[j]; }
          else for (let j = 0; j < m; j++) u[j] += pend[j] / L[j];
          const V = u.reduce((a, x, j) => a + x * L[j], 0);
          ret.push((V / vPrev - 1) * 100);
          q.push(d.sigSet.has(b.sls[0].dates[i]) ? w0.map((w, j) => w * V - u[j] * L[j]) : [0, 0, 0]);
        }
        const dv = Math.max(...ret.map((x, i) => Math.abs(x - b.res.run.ret[i])));
        console.log(`  ${kind} 합성 회계 2) 단위·지수 수준 방식 독립 재계산 vs combineN(월말 재조정, 40/30/30): 일수익률 최대 편차 ${dv.toExponential(2)} ${dv <= 1e-9 ? "통과" : "불일치"}`);
        if (!(dv <= 1e-9)) fails.push(`${kind} 독립 재계산 불일치`);
      }
      // 3) 월말 재조정 효과: 이동 후 비중 이탈
      const wDev = [0, 1, 2].map((j) => Math.max(...b.res.wEnd.map((w) => Math.abs(w[j] - DS13_W[j]))) * 100), wAvg = [0, 1, 2].map((j) => avg(b.res.wEnd.map((w) => w[j])) * 100);
      console.log(`  ${kind} 하위 계좌 평균 비중(종가) 코어 ${f2(wAvg[0])}% / 모멘텀 ${f2(wAvg[1])}% / 저위험 ${f2(wAvg[2])}% | 목표 대비 최대 이탈 ${wDev.map((x) => f2(x)).join(" / ")}%p | 월 재조정 이동 금액 연 ${f2(b.res.moved.reduce((x, y) => x + y, 0) * 100 / Math.max((Date.parse(h.dataEnd) - Date.parse(d.from)) / 86_400_000 / 365.25, 1e-9))}%`);
      if (b.res.wEnd.some((w) => !w.every(Number.isFinite) || Math.abs(w.reduce((a, x) => a + x, 0) - 1) > 1e-9)) fails.push(`${kind} 비중 합 ≠ 1`);
      // 4) lag 2 구조
      const b2 = d.build({ lag: 2 });
      console.log(`  ${kind} lag 2 구조: 하위 계좌 날짜 축 일치, 진입 RM1 ${b2.rm.entryCs.length}건·저위험 ${b2.low.entryCs.length}건·코어 ${b2.core.entryCs.length}건 (lag 1: ${b.rm.entryCs.length} / ${b.low.entryCs.length} / ${b.core.entryCs.length})`);
    }
    console.log(`\nDS13 사전 점검 종료: 날짜 축·합성 회계(독립 재계산 포함)·비중 이탈 ${fails.length === 0 ? "통과" : `— 실패 ${fails.length}건`}. DS13M·DS13L 성과는 계산·출력하지 않았다 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    for (const f of fails) console.log(`  실패: ${f}`);
    if (fails.length) throw new Error("DS13 사전 점검 실패 — 시험을 시작하지 않고 중단해 보고한다");
    return;
  }
  if (MODE === "vdata") {
    // 정보용 데이터 확인(시험 아님, 시험 번호·게이트 없음, 외부 호출 0, 성과 미계산): 이미 받아 둔 재무·공시일 자료의 항목·기간·종목 수·접수일·정정 처리·폐지 종목 포함 여부와 PBR용 자본 커버리지.
    const iso = (d: unknown): string => { const x = String(d ?? ""); return /^\d{8}$/.test(x) ? `${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6)}` : x.slice(0, 10); };
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    interface ER { rcept: string; eq: number; src: string }
    const bySrc = new Map<string, Map<string, ER[]>>();
    const addRec = (src: string, stock: string, rcept: string, eq: number | null): void => { if (eq === null || !rcept) return; let m = bySrc.get(src); if (!m) { m = new Map(); bySrc.set(src, m); } const a = m.get(stock) ?? []; a.push({ rcept, eq, src }); m.set(stock, a); };
    const tableLine = (label: string, rows: { fy: string; has: boolean; stock: string; extra?: string }[]): void => {
      const by = new Map<string, { n: number; has: number; st: Set<string> }>();
      for (const r of rows) { const x = by.get(r.fy) ?? { n: 0, has: 0, st: new Set<string>() }; x.n++; if (r.has) { x.has++; x.st.add(r.stock); } by.set(r.fy, x); }
      console.log(`${label}: ` + [...by].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([fy, x]) => `${fy} ${x.n}행/자본 있음 ${x.has}행/종목 ${x.st.size}`).join(" | "));
    };
    console.log(`\n=== V1. research/r_allcap/fin.parquet (연구 R, DART 주요계정 다중회사 API 전 종목) ===`);
    const finBuf = await downloadBuf(`${R_STORE_PREFIX}/fin.parquet`), filBuf = await downloadBuf(`${R_STORE_PREFIX}/filings.parquet`);
    if (!finBuf || !filBuf) throw new Error("fin.parquet 또는 filings.parquet이 Storage에 없다 — 중단");
    const fin = await decodeTable(finBuf), fil = await decodeTable(filBuf);
    console.log(`fin 행 ${fin.length} | 열: ${Object.keys(fin[0] ?? {}).join(",")}`);
    const stC = new Map<string, number>(), fsC = new Map<string, number>();
    for (const r of fin) { stC.set(String(r.status), (stC.get(String(r.status)) ?? 0) + 1); fsC.set(String(r.fs_div), (fsC.get(String(r.fs_div)) ?? 0) + 1); }
    console.log(`상태별(orig=최초 접수본 값, corr=정정본 값, unk=판정불가): ${[...stC].map(([k, v]) => `${k} ${v}`).join(", ")} | 연결/별도: ${[...fsC].map(([k, v]) => `${k} ${v}`).join(", ")}`);
    tableLine("사업연도별 행·자본(eq_c) 있음·종목", fin.map((r) => ({ fy: `${String(r.bsns_year)}`, has: num(r.eq_c) !== null, stock: String(r.stock_code) })));
    const repC = new Map<string, number>();
    for (const r of fin) if (num(r.eq_c) !== null) { const k = `${String(r.bsns_year)}-${String(r.reprt_code)}`; repC.set(k, (repC.get(k) ?? 0) + 1); }
    console.log(`사업연도·보고서(11013 1분기·11012 반기·11014 3분기·11011 사업)별 자본 있는 행: ${[...repC].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k} ${v}`).join(" | ")}`);
    const eqRows = fin.filter((r) => num(r.eq_c) !== null);
    const rd = eqRows.map((r) => iso(r.rcept_dt)).filter(Boolean).sort();
    console.log(`자본 있는 행 ${eqRows.length}/${fin.length}, 접수일 범위 ${rd[0] ?? "-"}~${rd[rd.length - 1] ?? "-"} | 접수번호 앞 8자리와 접수일 불일치 ${fin.filter((r) => String(r.rcept_no).length >= 8 && String(r.rcept_no).slice(0, 8) !== String(r.rcept_dt).replace(/-/g, "").slice(0, 8)).length}행`);
    console.log(`계정: 매출액(rev_*)·영업이익(oi_*)·당기순이익(ni_*; 당기·누적·전기·전기누적)·자산총계(assets_c)·부채총계(liab_c)·자본총계(eq_c 당기, eq_p 전기). **지배주주지분 항목 없음**(자본총계만; 비지배지분 포함).`);
    for (const r of fin) addRec("R", String(r.stock_code), iso(r.rcept_dt), num(r.eq_c));
    const fyC = new Map<string, number>(), corrC = { y: 0, n: 0 };
    for (const r of fil) { const y = iso(r.rcept_dt).slice(0, 4); fyC.set(y, (fyC.get(y) ?? 0) + 1); if (String(r.correction) === "Y") corrC.y++; else corrC.n++; }
    const frd = fil.map((r) => iso(r.rcept_dt)).filter(Boolean).sort();
    console.log(`\nfilings.parquet(정기공시 목록): ${fil.length}건(정정 ${corrC.y}), 접수일 ${frd[0]}~${frd[frd.length - 1]} | 연도별 ${[...fyC].sort().map(([y, n]) => `${y} ${n}`).join(" ")}`);

    console.log(`\n=== V2. Supabase 표(읽기만) ===`);
    const xb = await selectAll<Record<string, unknown>>("dart_xbrl_fundamentals", (f, t) => supabaseAdmin.from("dart_xbrl_fundamentals").select("stock_code, fiscal_year, source, rcept_dt, equity_parent, status").range(f, t));
    tableLine("dart_xbrl_fundamentals(FY2010~2014, 지배주주 자본, 사업보고서)", xb.map((r) => ({ fy: String(r.fiscal_year), has: num(r.equity_parent) !== null, stock: String(r.stock_code) })));
    const xbSt = new Map<string, number>(); for (const r of xb) xbSt.set(String(r.status), (xbSt.get(String(r.status)) ?? 0) + 1);
    console.log(`  상태별: ${[...xbSt].map(([k, v]) => `${k} ${v}`).join(", ")} (amended_only = 정정본만 있어 값 없음)`);
    for (const r of xb) addRec("DB", String(r.stock_code), iso(r.rcept_dt), num(r.equity_parent));
    const af = await selectAll<Record<string, unknown>>("stock_annual_fundamentals", (f, t) => supabaseAdmin.from("stock_annual_fundamentals").select("stock_code, fiscal_year, rcept_date, equity_parent").range(f, t));
    tableLine("stock_annual_fundamentals(FY2015~, 사업보고서)", af.map((r) => ({ fy: String(r.fiscal_year), has: num(r.equity_parent) !== null, stock: String(r.stock_code) })));
    for (const r of af) addRec("DB", String(r.stock_code), iso(r.rcept_date), num(r.equity_parent));
    const aff = await selectAll<Record<string, unknown>>("stock_annual_fundamentals_fill", (f, t) => supabaseAdmin.from("stock_annual_fundamentals_fill").select("stock_code, fiscal_year, rcept_date, equity_parent, status").range(f, t));
    tableLine("stock_annual_fundamentals_fill(보완)", aff.map((r) => ({ fy: String(r.fiscal_year), has: num(r.equity_parent) !== null, stock: String(r.stock_code) })));
    for (const r of aff) addRec("DB", String(r.stock_code), iso(r.rcept_date), num(r.equity_parent));
    const qf = await selectAll<Record<string, unknown>>("dart_quarterly_fundamentals", (f, t) => supabaseAdmin.from("dart_quarterly_fundamentals").select("stock_code, fiscal_year, quarter, rcept_date, equity_parent, status").range(f, t));
    tableLine("dart_quarterly_fundamentals(1~3분기, 지배주주 자본)", qf.map((r) => ({ fy: String(r.fiscal_year), has: num(r.equity_parent) !== null, stock: String(r.stock_code) })));
    for (const r of qf) addRec("DB", String(r.stock_code), iso(r.rcept_date), num(r.equity_parent));

    console.log(`\n=== V3. 월말 신호일 기준 PBR용 자본 커버리지(보고서 접수일 < 신호일, 접수 후 400일 이내, 정보용) — 연도별 월말 평균 % ===`);
    const latest = (m: Map<string, ER[]> | undefined, code: string, d: string): ER | undefined => { const a = m?.get(code); if (!a) return undefined; let best: ER | undefined; for (const x of a) if (x.rcept < d && (!best || x.rcept > best.rcept)) best = x; return best; };
    const allMap = new Map<string, ER[]>();
    for (const m of bySrc.values()) for (const [c, a] of m) allMap.set(c, [...(allMap.get(c) ?? []), ...a]);
    const dayDiffS = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / 86_400_000;
    type Acc = { n: number; mc: number; rN: number; rMc: number; dN: number; dMc: number; aN: number; aMc: number; neg: number; months: number };
    const accA = new Map<string, Acc>(), accB = new Map<string, Acc>();
    const mk = (): Acc => ({ n: 0, mc: 0, rN: 0, rMc: 0, dN: 0, dMc: 0, aN: 0, aMc: 0, neg: 0, months: 0 });
    const firstOver: Record<string, string> = {};
    for (const d of h.monthEnds) {
      if (d < "2010-01-01") continue;
      const m = membAt(d), y = d.slice(0, 4);
      const cur = { A: { n: 0, mc: 0, r: 0, rm: 0, db: 0, dm: 0, al: 0, am: 0, neg: 0 }, B: { n: 0, mc: 0, r: 0, rm: 0, db: 0, dm: 0, al: 0, am: 0, neg: 0 } };
      for (const s of h.stocks) {
        const i = s.idx.get(d);
        if (i === undefined || excluded.has(s.code) || !m || !m.has(s.code) || !(s.mcapRow[i] > 0)) continue;
        const mc = s.mcapRow[i], liquid = s.avgTvRow[i] >= 3e8 && s.raw[i] >= 1000;
        const ok = (e: ER | undefined): boolean => !!e && dayDiffS(e.rcept, d) <= 400;
        const eR = latest(bySrc.get("R"), s.code, d), eD = latest(bySrc.get("DB"), s.code, d), eA = latest(allMap, s.code, d);
        for (const [k, on] of [["A", true], ["B", liquid]] as const) {
          if (!on) continue;
          const c = cur[k]; c.n++; c.mc += mc;
          if (ok(eR)) { c.r++; c.rm += mc; }
          if (ok(eD)) { c.db++; c.dm += mc; }
          if (ok(eA)) { c.al++; c.am += mc; if ((eA as ER).eq <= 0) c.neg++; }
        }
      }
      for (const [k, acc] of [["A", accA], ["B", accB]] as const) {
        const c = cur[k], a = acc.get(y) ?? mk();
        if (c.n > 0) { a.n += c.n; a.mc += c.mc; a.rN += c.r; a.rMc += c.rm; a.dN += c.db; a.dMc += c.dm; a.aN += c.al; a.aMc += c.am; a.neg += c.neg; a.months++; acc.set(y, a); if (k === "A" && !firstOver.all && c.al / c.n >= 0.7) firstOver.all = d; if (k === "A" && !firstOver.r && c.r / c.n >= 0.7) firstOver.r = d; if (k === "A" && !firstOver.db && c.db / c.n >= 0.7) firstOver.db = d; }
      }
    }
    for (const [lbl, acc] of [["A. 전 종목(코스피·코스닥, 제외 규칙 적용, 월말 시총>0)", accA], ["B. BS1 적격(20일 평균 거래대금 ≥3억·종가 ≥1,000원)", accB]] as const) {
      console.log(`\n${lbl}\n| 연도 | 월수 | 월평균 종목 수 | R 전체시장 재무(자본총계) 종목% / 시총% | Supabase 표(지배주주) 종목% / 시총% | 합집합 종목% / 시총% | 합집합 중 자본≤0 % |\n|---|---|---|---|---|---|---|`);
      for (const [y, a] of [...acc].sort()) console.log(`| ${y} | ${a.months} | ${(a.n / a.months).toFixed(0)} | ${f2((a.rN / a.n) * 100)} / ${f2((a.rMc / a.mc) * 100)} | ${f2((a.dN / a.n) * 100)} / ${f2((a.dMc / a.mc) * 100)} | ${f2((a.aN / a.n) * 100)} / ${f2((a.aMc / a.mc) * 100)} | ${f2(a.aN ? (a.neg / a.aN) * 100 : 0)} |`);
    }
    console.log(`\n전 종목 기준 월말 커버리지(종목 수) 70% 이상이 처음 되는 월말: R ${firstOver.r ?? "없음"} | Supabase 표 ${firstOver.db ?? "없음"} | 합집합 ${firstOver.all ?? "없음"}`);

    console.log(`\n=== V4. 상장폐지 종목 포함 여부 ===`);
    const endD = CAL[nCal - 1], gone = h.stocks.filter((s) => s.last < endD && dayDiffS(s.last, endD) > 20);
    const gy = new Map<string, { n: number; r: number; any: number }>();
    for (const s of gone) { const y = s.last.slice(0, 4), g = gy.get(y) ?? { n: 0, r: 0, any: 0 }; g.n++; if (bySrc.get("R")?.has(s.code)) g.r++; if (allMap.has(s.code)) g.any++; gy.set(y, g); }
    console.log(`가격 Parquet의 소멸 종목 ${gone.length}개 중 R 재무 있음 ${gone.filter((s) => bySrc.get("R")?.has(s.code)).length}, 어느 표든 있음 ${gone.filter((s) => allMap.has(s.code)).length}`);
    console.log(`소멸 연도별(종목 수 / R 재무 있음 / 어느 표든): ${[...gy].sort().map(([y, g]) => `${y} ${g.n}/${g.r}/${g.any}`).join(" | ")}`);
    console.log(`\n=== V5. 새 수집 계획용 대상 수(2011-03~2016-04 월말, R 자료 이전 구간) ===`);
    const corpRows = await selectAll<Record<string, unknown>>("dart_corp_codes", (f, t) => supabaseAdmin.from("dart_corp_codes").select("stock_code, corp_code").range(f, t));
    const corpOf = new Map(corpRows.map((r) => [String(r.stock_code), String(r.corp_code)]));
    const monthsOf = new Map<string, { a: number; b: number; goneBefore2016: boolean }>();
    for (const d of h.monthEnds) {
      if (d < "2011-03-01" || d > "2016-04-30") continue;
      const m = membAt(d);
      for (const s of h.stocks) {
        const i = s.idx.get(d);
        if (i === undefined || excluded.has(s.code) || !m || !m.has(s.code) || !(s.mcapRow[i] > 0)) continue;
        const x = monthsOf.get(s.code) ?? { a: 0, b: 0, goneBefore2016: s.last < "2016-05-01" };
        x.a++; if (s.avgTvRow[i] >= 3e8 && s.raw[i] >= 1000) x.b++;
        monthsOf.set(s.code, x);
      }
    }
    const stocksA = [...monthsOf.keys()], stocksB = [...monthsOf].filter(([, x]) => x.b > 0).map(([c]) => c);
    const noRecA = stocksA.filter((c) => !allMap.has(c)), noRecB = stocksB.filter((c) => !allMap.has(c));
    const mapped = (arr: string[]): number => arr.filter((c) => corpOf.has(c)).length;
    const mm = (arr: string[], k: "a" | "b"): number => arr.reduce((acc, c) => acc + (monthsOf.get(c) as { a: number; b: number })[k], 0);
    console.log(`구간 안에 한 번이라도 월말 목록·가격 행·제외 규칙 통과: 전 종목 A ${stocksA.length}개(corp_code 매핑 ${mapped(stocksA)}개), BS1 적격 한 번이라도 B ${stocksB.length}개(매핑 ${mapped(stocksB)}개)`);
    console.log(`그중 기존 자료(R·Supabase 표)에 자본 기록이 전혀 없는 종목: A ${noRecA.length}개(매핑 ${mapped(noRecA)}), B ${noRecB.length}개(매핑 ${mapped(noRecB)}) | 구간 안에 소멸(2016-05 전 마지막 행): A ${stocksA.filter((c) => (monthsOf.get(c) as { goneBefore2016: boolean }).goneBefore2016).length}개`);
    console.log(`종목-월 합계: A ${mm(stocksA, "a")}, B ${mm(stocksB, "b")} → 분기보고서 수 추정(종목-월 ÷ 3) A ${Math.round(mm(stocksA, "a") / 3)}, B ${Math.round(mm(stocksB, "b") / 3)} / 사업보고서만(÷ 12) A ${Math.round(mm(stocksA, "a") / 12)}, B ${Math.round(mm(stocksB, "b") / 12)}`);
    console.log(`\n읽기: fin·filings 파일 ${((finBuf.byteLength + filBuf.byteLength) / 1048576).toFixed(2)} MiB | ${storageLine()} | Supabase 쓴 행 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    return;
  }
  if (MODE === "vcov") {
    // 정보용(시험 아님): 합친 자본 커버리지(월말, BS1 적격 종목 기준 종목 수·시총) — 70% 이상이 되는 첫 월말(그 뒤 모든 월말도 70% 이상)을 시험 시작일로 확정한다.
    await loadEqTables();
    const accY = new Map<string, { n: number; ok: number; mc: number; okMc: number; why: Record<string, number>; months: number }>();
    const perMonth: { d: string; cov: number }[] = [];
    for (const c of monthEndIdx) {
      const d = CAL[c];
      if (d < "2011-01-01") continue;
      const el = bsElig(c, B5_BS_P0);
      if (!el.length) continue;
      let ok = 0, mc = 0, okMc = 0;
      const why: Record<string, number> = { no_report: 0, stale: 0, neg: 0 };
      for (const code of el) { const s = h.byCode.get(code) as S, i = s.idx.get(d) as number, x = pbrAt(c, s, VB1_P0.maxAge); mc += s.mcapRow[i]; if (x.why === "ok") { ok++; okMc += s.mcapRow[i]; } else why[x.why]++; }
      perMonth.push({ d, cov: ok / el.length });
      const y = d.slice(0, 4), a = accY.get(y) ?? { n: 0, ok: 0, mc: 0, okMc: 0, why: { no_report: 0, stale: 0, neg: 0 }, months: 0 };
      a.n += el.length; a.ok += ok; a.mc += mc; a.okMc += okMc; a.months++; for (const k of Object.keys(why)) a.why[k] += why[k]; accY.set(y, a);
    }
    console.log(`\n=== 자본 커버리지(월말 평균 %, BS1 적격 종목 기준, PBR 가능 = 접수일 < 신호일 ∧ 경과 ≤ ${VB1_P0.maxAge}일 ∧ 자본 > 0) ===\n| 연도 | 월수 | 월평균 적격 종목 | 종목 수 % | 시총 % | 제외: 보고서 없음 % | 제외: 경과 초과 % | 제외: 자본 ≤ 0 % |\n|---|---|---|---|---|---|---|---|`);
    for (const [y, a] of [...accY].sort()) console.log(`| ${y} | ${a.months} | ${(a.n / a.months).toFixed(0)} | ${f2((a.ok / a.n) * 100)} | ${f2((a.okMc / a.mc) * 100)} | ${f2((a.why.no_report / a.n) * 100)} | ${f2((a.why.stale / a.n) * 100)} | ${f2((a.why.neg / a.n) * 100)} |`);
    let first = "";
    for (let k = perMonth.length - 1; k >= 0; k--) { if (perMonth[k].cov >= VB_COVERAGE_MIN) first = perMonth[k].d; else break; }
    const firstEver = perMonth.find((x) => x.cov >= VB_COVERAGE_MIN)?.d ?? "없음";
    console.log(`\n시험 시작일 확정: 종목 수 커버리지 ${VB_COVERAGE_MIN * 100}% 이상이 처음 되는 월말 = ${firstEver}, 그 뒤 모든 월말도 ${VB_COVERAGE_MIN * 100}% 이상인 첫 월말 = **${first || "없음"}** | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "vpre") {
    // 사전 점검(성과 미계산): 자본·PBR 독립 재계산, 소멸 규칙, 의심 종목-일 건수, 시작일·구간·체결 타이밍, DS6 재현(위 DS6 재현 줄, 불일치면 중단).
    await loadEqTables();
    requireStart();
    const fails: string[] = [];
    const rngV = mulberry32(20261120);
    // PBR 독립 재계산: 선형 탐색으로 접수일 < 신호일인 가장 최근 보고서를 찾아 비교
    let nChk = 0;
    for (let t = 0; t < 40; t++) {
      const c = monthEndIdx.filter((x) => x >= cStartV)[Math.floor(rngV() * monthEndIdx.filter((x) => x >= cStartV).length)], el = bsElig(c, B5_BS_P0);
      if (!el.length) continue;
      const code = el[Math.floor(rngV() * el.length)], s = h.byCode.get(code) as S, d = CAL[c], i = s.idx.get(d) as number;
      let best: EqRec | undefined;
      for (const e of eqBy.get(code) ?? []) if (e.rcept < d && (!best || e.rcept > best.rcept || (e.rcept === best.rcept && e.cfs))) best = e;
      const x = pbrAt(c, s, 400);
      const exp = !best ? Number.NaN : dayDiffV(best.rcept, d) > 400 || !(best.eq > 0) ? Number.NaN : (s.mcapRow[i] * 1e8) / best.eq;
      nChk++;
      if (!(Number.isNaN(exp) && Number.isNaN(x.pbr)) && !(Math.abs(exp - x.pbr) <= 1e-9 * Math.abs(exp))) fails.push(`PBR 불일치 ${code} ${d}: 모듈 ${x.pbr} 독립 ${exp}`);
      if (best && best.rcept >= d) fails.push(`미래 접수일 사용 ${code} ${d}`);
    }
    console.log(`PBR 독립 재계산 ${nChk}건 일치 확인(접수일 < 신호일 규칙 포함)`);
    // 소멸 규칙 표본
    const gone = h.stocks.filter((s) => s.last < "2026-09-01").slice(0, 400);
    const lossN = gone.filter((s) => vbVanishLoss(s.code)).length;
    console.log(`소멸 종목 표본 ${gone.length}개 중 전액 손실 처리 ${lossN}개(${f2((lossN / Math.max(gone.length, 1)) * 100)}%), 마지막 종가 청산 ${gone.length - lossN}개`);
    // 구조: VB1 첫 신호일·종목 수·시작 구간
    const defs: [string, VbP, [string, Partial<VbP>][]][] = [["VB1", VB1_P0, VB1_NB], ["VB2", VB2_P0, VB2_NB]];
    for (const [id, P0, nb] of defs) {
      const def = mkVB(id, P0, nb), cS = startOf(def, false), Wx = windowsV(cS);
      const run = runS(def, P0, cS, null, { lag: 1, detail: true });
      const hmax = Math.max(...run.nPos.map((x, k) => x - (run.nDefer[k] ?? 0)));
      console.log(`${id}: 시작 첫 신호일 ${CAL[cS]}, 수익률 집계 ${Wx.FULL.from}~${h.dataEnd}, 구간 ${Wx.NW.map(([n, w]) => `${n}`).join(" / ")} | 보유 종목 수 최대(순연 제외) ${hmax} (목표 ${P0.n}) | 진입 ${run.entryCs.length}건 | 폐지 청산 ${run.trades.filter((t) => t.reason === "폐지").length}건, 폐지(전액 손실) ${run.trades.filter((t) => t.reason === "폐지(전액 손실)").length}건`);
      if (hmax > P0.n) fails.push(`${id}: 보유 종목 수 ${hmax} > 목표 ${P0.n}`);
      const first = run.entryCs[0];
      if (first !== undefined && first !== cS + 1) fails.push(`${id}: 첫 체결일 ${CAL[first]}이 첫 신호일 다음 거래일 ${CAL[cS + 1]}과 다르다`);
    }
    console.log(`의심 종목-일 0% 처리(ZERO_SUSPECT): ${ZERO_SUSPECT_ON ? `적용 ${suspectLog.length}건` : "미적용"}`);
    if (fails.length) { console.log(`\n사전 점검 실패 ${fails.length}건:\n${fails.join("\n")}`); throw new Error("저평가 사전 점검 실패 — 시험을 시작하지 않고 중단해 보고한다"); }
    console.log(`\n저평가 사전 점검 통과(성과는 계산·출력하지 않았다) | ${storageLine()}`);
    return;
  }
  if (MODE === "vinfo") {
    // 정보용(시험 아님, 시험 번호·게이트 없음): VB1·VB2·VB1C 기준 실행의 구간별 CAGR/MDD만 — 데이터 처리(810건 0% 처리 유무) 비교용.
    await loadEqTables();
    requireStart();
    const rows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [];
    let Wx: Windows | null = null;
    for (const [id, P0, nb] of [["VB1", VB1_P0, VB1_NB], ["VB2", VB2_P0, VB2_NB]] as [string, VbP, [string, Partial<VbP>][]][]) {
      const def = mkVB(id, P0, nb), cS = startOf(def, false);
      Wx = windowsV(cS);
      rows.push({ nm: id, run: runS(def, P0, cS, null, { lag: 1, detail: true }) });
      if (id === "VB1") rows.push({ nm: "VB1C", run: combine2(sliceSl(coreOf(2, undefined, 1, {}).sl, Wx.FULL.from), slFromRun(rows[0].run as RebalRun), B5_CORE_W, CS_MOVE_COST).run });
    }
    rows.push({ nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run });
    console.log(`\n=== 정보용: ${ZERO_SUSPECT_ON ? `의심 종목-일 0% 처리 적용(${suspectLog.length}건)` : "의심 종목-일 처리 없음"} — CAGR % / MDD % (같은 구간 ${(Wx as Windows).FULL.from}~) ===\n| 구간 | ${rows.map((r) => r.nm).join(" | ")} |\n|---|${rows.map(() => "---").join("|")}|`);
    for (const [nm, w] of (Wx as Windows).ALL) console.log(`| ${nm} | ${rows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    console.log(`\n정보용 실행 종료(시험 아님) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "ds13rob") {
    // 정보용 견고성 점검(시험 번호·게이트 없음, 판정에 쓰지 않음): 월 신호일(RM1·MV1 신호, 하위 계좌 간 재조정 신호)을 마지막 거래일에서 5·10거래일 앞당긴다. 코어·LV1은 월 신호가 아닌 일별 규칙이라 그대로. 첫 신호일(2011-01-31)은 같게 둬 평가 구간을 맞춘다.
    const cS13 = startOf(RM1, false), W13 = windowsFor(cS13), from13 = W13.FULL.from;
    const SHIFTS = [0, 5, 10];
    const res: { id: string; shift: number; run: { dates: string[]; ret: number[] } }[] = [];
    for (const [id, kind] of [["DS13L", "LV1"], ["DS13M", "MV1"]] as const) for (const sh of SHIFTS) res.push({ id, shift: sh, run: d13Of(kind, cS13, W13, sh).base.res.run });
    console.log(`\n=== 정보용 견고성 점검: 월 신호일 앞당김(마지막 거래일 − N거래일) — CAGR % / MDD % (같은 구간 ${from13}~, 보정 적용 데이터) ===`);
    console.log(`| 구간 | 069500 | ${res.map((r) => `${r.id} −${r.shift}일`).join(" | ")} |\n|---|---|${res.map(() => "---").join("|")}|`);
    for (const [nm, w] of W13.ALL) console.log(`| ${nm} | ${cell({ dates: h.bhP.dates, ret: h.bhP.ret }, w)} | ${res.map((r) => cell(r.run, w)).join(" | ")} |`);
    const fullOf = (r: { run: { dates: string[]; ret: number[] } }): { cagr: number; mdd: number } => h.st(r.run, W13.FULL);
    console.log(`\n| 전략 | 앞당김 | 연속 CAGR | MDD | CAGR − 기준(0일) %p | MDD − 기준 %p | CAGR 차이 1.5%p 초과 |\n|---|---|---|---|---|---|---|`);
    for (const r of res) { const b0 = fullOf(res.find((x) => x.id === r.id && x.shift === 0) as (typeof res)[number]), f = fullOf(r), dc = f.cagr - b0.cagr, dm = f.mdd - b0.mdd; console.log(`| ${r.id} | −${r.shift}일 | ${f2(f.cagr)} | ${f2(f.mdd)} | ${sg(dc)} | ${sg(dm)} | ${Math.abs(dc) > 1.5 ? "예" : "아니오"} |`); }
    const big = res.filter((r) => r.shift > 0).some((r) => Math.abs(fullOf(r).cagr - fullOf(res.find((x) => x.id === r.id && x.shift === 0) as (typeof res)[number]).cagr) > 1.5);
    console.log(`\n견고성 점검 요약: 연속 CAGR 차이가 1.5%p를 넘는 경우 ${big ? "있음(위 표 참고)" : "없음"} | 시험 아님, 시험 번호 쓰지 않음, 판정 불사용 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    return;
  }
  if (MODE === "ds13ex") {
    // 정보용: 환경 변수 NEUTRALIZE_CODES(삼성전자·SK하이닉스)의 수정 수익률을 0으로 둔 별도 실행(시험 아님, 시험 번호·게이트 없음).
    if (!NEUTRALIZE_ON) throw new Error("ds13ex는 NEUTRALIZE_CODES가 있어야 한다");
    const cS13 = startOf(RM1, false), W13 = windowsFor(cS13), from13 = W13.FULL.from;
    const cF = <P,>(def: Strat<P>): SimRun => combine2(sliceSl(coreOf(2, undefined, 1, {}).sl, from13), slFromRun(runS(def, def.P0, cS13, null, { lag: 1, detail: true })), B5_CORE_W, CS_MOVE_COST).run;
    const rows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [{ nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run }, { nm: "RM1C", run: cF(RM1) }, { nm: "MV1C", run: cF(MV1) }, { nm: "DS13M", run: d13Of("MV1", cS13, W13).base.res.run }, { nm: "DS13L", run: d13Of("LV1", cS13, W13).base.res.run }];
    console.log(`\n=== 정보용: 삼성전자·SK하이닉스 수익률 0 처리(${process.env.NEUTRALIZE_CODES}) 실행 — CAGR % / MDD % (같은 구간 ${from13}~) ===`);
    console.log(`| 구간 | ${rows.map((r) => r.nm).join(" | ")} |\n|---|${rows.map(() => "---").join("|")}|`);
    for (const [nm, w] of W13.ALL) console.log(`| ${nm} | ${rows.map((r) => cellS({ dates: r.run.dates, ret: r.run.ret, costFrac: [], nPos: [], inv: [], turn: [], wMax: [] }, w)).join(" | ")} |`);
    console.log(`\n중립화 실행 종료 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    return;
  }
  if (MODE === "rtpre") {
    // RT 사전 점검(성과 미계산): 기준선 RT0 vs 069500(±RT_BASELINE_MAX_GAP_PP %p 넘으면 중단), 목표 비중표 독립 대조(모든 신호일), 체결 타이밍.
    const fails: string[] = [];
    const cT = startOf(RT1, false), WT = windowsFor(cT);
    console.log(`\n=== RT-0. 기준선 RT0: K200P 전 종목 시총 비중(상한 ${RT1_P0.cap * 100}%), 월말 신호·다음 거래일 종가 체결, 항상 100%, 정보용(시험 아님) — 첫 신호일 ${CAL[cT]}, 수익 집계 ${WT.FULL.from}~${h.dataEnd} ===`);
    const r0 = runS(RT0, RT1.P0, cT, null, { lag: 1, detail: true });
    console.log("| 구간 | 069500 | RT0 | RT0 − 069500 CAGR %p | RT0 − 069500 MDD %p |\n|---|---|---|---|---|");
    let fullGap = Number.NaN;
    for (const [nm, w] of WT.ALL) { const a = h.st(h.bhP, w), b = h.st(r0, w); if (nm.startsWith("연속")) fullGap = b.cagr - a.cagr; console.log(`| ${nm} | ${f2(a.cagr)} / ${f2(a.mdd)} | ${f2(b.cagr)} / ${f2(b.mdd)} | ${b.cagr - a.cagr >= 0 ? "+" : ""}${f2(b.cagr - a.cagr)} | ${b.mdd - a.mdd >= 0 ? "+" : ""}${f2(b.mdd - a.mdd)} |`); }
    const sF = h.st(r0, WT.FULL);
    console.log(`RT0 연속 전체: 평균 보유 종목 ${f2(sF.avgN)}, 평균 투자 비중 ${f2(sF.avgInv)}%, 연 회전율 ${f2(sF.turnover)}%, 비용 합계 ${f2(sF.cost)}%`);
    if (!(Math.abs(fullGap) <= RT_BASELINE_MAX_GAP_PP)) { console.log(`기준선 연속 CAGR 차이 ${f2(fullGap)}%p — 허용 ${RT_BASELINE_MAX_GAP_PP}%p 초과: 원인 조사 정보 출력`); fails.push(`기준선 RT0 연속 CAGR 차이 ${f2(fullGap)}%p`); }
    else console.log(`기준선 연속 CAGR 차이 ${f2(fullGap)}%p — 허용 ${RT_BASELINE_MAX_GAP_PP}%p 이내`);
    // 원인 조사용(차이가 클 때만 의미): 비용 없는 순수 가격 지수형, 삼성전자·SK하이닉스 평균 비중
    {
      const sigs = sigDays(RT0, false).filter((c) => c >= cT);
      let sam = 0, sk = 0, nn = 0, top1 = 0;
      for (const c of sigs) { const t = RT0.targets(c, new Set(), RT1.P0, 1, true); sam += t.get("005930") ?? 0; sk += t.get("000660") ?? 0; top1 += Math.max(...t.values()); nn++; }
      console.log(`RT0 신호일 평균: 삼성전자 비중 ${f2((sam / nn) * 100)}%, SK하이닉스 ${f2((sk / nn) * 100)}%, 최대 단일 비중 평균 ${f2((top1 / nn) * 100)}%, K200P 종목 수 평균 ${f2(sigs.reduce((a, c) => a + RT0.targets(c, new Set(), RT1.P0, 1, true).size, 0) / sigs.length)}`);
    }

    // 목표 비중표 독립 대조: 브루트포스 점수(bruteRm) + 선정(bruteSelect) + 정렬 기반 상한 비중(bruteCapW), 실제 보유 경로 위에서
    const bruteCapW = (mcs: number[], cap: number): number[] => {
      const n = mcs.length;
      if (cap * n < 1 - 1e-12) return mcs.map(() => 1 / n);
      const order = mcs.map((_, i) => i).sort((a, b) => mcs[b] - mcs[a]);
      for (let k = 0; k <= n; k++) {
        if (k === n) return mcs.map(() => cap);
        const restSum = order.slice(k).reduce((a, i) => a + mcs[i], 0), rest = 1 - cap * k;
        if (rest * mcs[order[k]] / restSum <= cap + 1e-15) { const w = new Array<number>(n).fill(cap); for (let q = k; q < n; q++) w[order[q]] = (rest * mcs[order[q]]) / restSum; return w; }
      }
      throw new Error("상한 비중 계산 실패");
    };
    const checkRt = (tag: string, def: Strat<RtP>, F: boolean, step: number): void => {
      const variants: [string, RtP, number][] = [["기본", def.P0, 1], ...def.nbs.map(([lb, ch]) => [lb, { ...def.P0, ...ch }, step] as [string, RtP, number])];
      for (const [lb, Pv, st2] of variants) {
        let nBad = 0, nDays = 0, nChk = 0, first = "";
        const wrap: Strat<RtP> = { ...def, targets: (c, held, Pp, m, swap) => {
          const t = def.targets(c, held, Pp, m, swap);
          if (nDays++ % st2 !== 0) return t;
          const rp = { ...B5_RM_P0, start: Pp.start, skip: Pp.skip, minValid: Pp.minValid };
          const a = rtSorted(c, Pp).map((x) => ({ code: x.code, v: x.sc })), b = bruteRm(c, rp), msg = cmpLists("순위", a, b, 1e-9);
          if (msg) { nBad++; first ||= `${CAL[c]} ${msg}`; return t; }
          const nS = b.length, sel = bruteSelect(b.map((x) => x.code), held, Math.ceil(Pp.share * nS), Math.ceil((Pp.share + Pp.keepOff) * nS));
          const rk = new Map(bruteRank(c).map((s2) => [s2.code, s2])), mcs = sel.map((code) => { const s2 = rk.get(code) as S, j = bsExact(s2, c); return s2.mcapRow[j]; });
          const w = bruteCapW(mcs, Pp.cap);
          nChk++;
          let ok = sel.length === t.size, sum = 0, mx = 0;
          for (let k = 0; k < sel.length && ok; k++) { const mv = t.get(sel[k]); if (mv === undefined || Math.abs(mv - w[k] * m) > 1e-12) ok = false; }
          for (const v of t.values()) { sum += v; mx = Math.max(mx, v); }
          if (!ok) { nBad++; first ||= `${CAL[c]} 선정 ${sel.length}개 ≠ 모듈 ${t.size}개 또는 비중 불일치`; }
          else if (Math.abs(sum - m) > 1e-9 || mx > Pp.cap * m + 1e-12) { nBad++; first ||= `${CAL[c]} 비중 합 ${sum} 또는 최대 ${mx} 위반`; }
          return t;
        } };
        runS(wrap, Pv, cT, F ? { ma: B5_MA_DAYS } : null, { lag: 1 });
        console.log(`  ${tag} ${lb}${F ? "(필터 형태)" : ""}: 신호일 ${nDays}일 중 대조 ${nChk}일, 불일치 ${nBad}건 ${nBad === 0 ? "통과" : `불일치 (${first})`}`);
        if (nBad > 0) fails.push(`${tag} ${lb}: ${first}`);
      }
    };
    console.log(`\n=== RT-1. 목표 비중표 독립 대조 (모듈 vs 브루트포스, 실제 보유 경로 위에서; 기본은 모든 신호일, 이웃은 6일마다) ===`);
    checkRt("RT1", RT1, false, 6); checkRt("RT1", RT1, true, 1000000); checkRt("RT2", RT2, false, 6);
    console.log(`\n=== RT-2. 체결 타이밍·구조 (lag 1·2) ===`);
    for (const [tag, def, F] of [["RT1", RT1, false], ["RT1", RT1, true], ["RT2", RT2, false]] as [string, Strat<RtP>, boolean][]) {
      const sd = new Set(sigDays(def, F).filter((c) => c >= cT));
      for (const lag of [1, 2]) {
        const r = runS(def, def.P0, cT, F ? { ma: B5_MA_DAYS } : null, { lag, detail: true });
        const badEntry = r.entryCs.filter((c) => !sd.has(c - lag)).length, negCost = r.costFrac.filter((x) => x < -1e-12).length, nanRet = r.ret.filter((x) => !Number.isFinite(x)).length;
        const wMaxAll = Math.max(...r.wMax.filter(Number.isFinite)), over = r.nPos.some((n, i) => n - r.nDefer[i] > Math.ceil(0.6 * 200));
        console.log(`  ${tag}${F ? "(필터)" : ""} lag ${lag}: 진입 ${r.entryCs.length}건, 보유 구간 닫힘 ${r.trades.length}건·열림 ${r.open.length}건 | 신호일 + ${lag}이 아닌 진입 ${badEntry}건 | 보유 종목 평균 ${f2(avg(r.nPos))} 최대 ${Math.max(...r.nPos)} | 단일 종목 최대 비중 ${f2(wMaxAll * 100)}% | 음수 비용 ${negCost}일, 비정상 수익률 ${nanRet}일 | 폐지 청산 ${r.trades.filter((t) => t.reason.startsWith("폐지")).length}건, 거래정지 매수 건너뜀 ${r.haltSkip}건, 청산 순연 ${r.exitDefer}건`);
        if (badEntry > 0 || negCost > 0 || nanRet > 0 || over) fails.push(`${tag} lag ${lag} 체결 타이밍`);
      }
    }
    console.log(`\nRT 사전 점검 종료: DS6 재현(위), 기준선, 목표 비중표 독립 대조, 체결 타이밍 ${fails.length === 0 ? "통과" : `— 실패 ${fails.length}건`}. RT1·RT1F·RT2 성과는 계산·출력하지 않았다 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    for (const f of fails) console.log(`  실패: ${f}`);
    if (fails.length) throw new Error("RT 사전 점검 실패 — 시험을 시작하지 않고 중단해 보고한다");
    return;
  }
  if (MODE === "dq") {
    // 전 종목 가격 데이터 품질 점검(시험 아님, 시험 번호·게이트 없음, 읽기 전용, 가격 데이터만 사용).
    const dataEnd = CAL[nCal - 1];
    const evBy = new Map<string, string[]>();
    for (const [code, list] of h.adjustments) evBy.set(code, list.map((e) => e.eventDate).sort());
    const hasEv = (code: string, a: string, b: string): boolean => (evBy.get(code) ?? []).some((d) => d > a && d <= b);
    const meIdx = monthEndIdx;
    const lastMeBefore = (k: number): number => { let lo = 0, hi = meIdx.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (meIdx[m] <= k - 1) { r = meIdx[m]; lo = m + 1; } else hi = m - 1; } return r; };
    interface Ex { code: string; d: string; adjR: number; rawR: number; mcR: number; shR: number; vol: number; gap: number; ev: boolean; listing: boolean; resume: boolean; liq: boolean; cls: "가" | "나" | "다"; ex: boolean; k200: number; rec: number; recJ: number }
    const exs: Ex[] = [];
    let rowsAll = 0, daysAll = 0;
    for (const s2 of h.stocks) {
      const n = s2.dates.length, vanished = s2.last < dataEnd;
      for (let i = 1; i < n; i++) {
        rowsAll++;
        const d = s2.dates[i], pi = i - 1;
        if (!(s2.close[pi] > 0 && s2.close[i] > 0)) continue;
        daysAll++;
        const adjR = s2.close[i] / s2.close[pi] - 1, lim = d <= DQ_LIMIT_CHANGE_DATE ? DQ_LIMIT_BEFORE : DQ_LIMIT_AFTER;
        if (Math.abs(adjR) <= lim + DQ_LIMIT_TOL) continue;
        const rawR = s2.raw[i] / s2.raw[pi] - 1, gap = (h.calIdx.get(d) as number) - (h.calIdx.get(s2.dates[pi]) as number);
        const mcOk = s2.mcapRow[i] > 0 && s2.mcapRow[pi] > 0 && s2.raw[i] > 0 && s2.raw[pi] > 0;
        const mcR = mcOk ? s2.mcapRow[i] / s2.mcapRow[pi] - 1 : Number.NaN, shR = mcOk ? s2.mcapRow[i] / s2.raw[i] / (s2.mcapRow[pi] / s2.raw[pi]) : Number.NaN;
        const cls: "가" | "나" | "다" = !mcOk ? "다" : Math.abs(mcR - adjR) > DQ_MCAP_DIFF_FRAC * Math.abs(adjR) ? "가" : "나";
        const c = lastMeBefore(h.calIdx.get(d) as number), rk = c >= 0 ? rank200(c).rank.get(s2.code) : undefined;
        exs.push({ code: s2.code, d, adjR, rawR, mcR, shR, vol: s2.vol[i], gap, ev: hasEv(s2.code, s2.dates[pi], d), listing: i <= DQ_LISTING_MAX_ROW, resume: gap >= DQ_RESUME_MIN_GAP, liq: vanished && i >= n - DQ_LIQUIDATION_ROWS, cls, ex: excluded.has(s2.code), k200: rk === undefined ? -1 : rk, ...(() => { let best = Number.POSITIVE_INFINITY, bj = 0; for (let j = 1; j <= DQ_RECOVER_ROWS && i + j < n; j++) { if (!(s2.mcapRow[i + j] > 0 && s2.mcapRow[pi] > 0)) continue; const v = Math.abs(s2.mcapRow[i + j] / s2.mcapRow[pi] - 1); if (v < best) { best = v; bj = j; } } return { rec: best, recJ: bj }; })() });
      }
    }
    console.log(`\n=== Q1. 제한폭 초과 종목-일 (전 종목 ${h.stocks.length}개, 수익률 계산 가능한 종목-일 ${daysAll.toLocaleString()}개, ${CAL[0]}~${dataEnd}) ===`);
    console.log(`기준: 수정주가 일간 수익률 절댓값 > 제한폭(${DQ_LIMIT_CHANGE_DATE}까지 ±${DQ_LIMIT_BEFORE * 100}%, 이후 ±${DQ_LIMIT_AFTER * 100}%) + 허용 ${DQ_LIMIT_TOL * 100}%p. 직전 행 대비(행 없는 날 = 거래정지·미상장).`);
    const special = (e: Ex): boolean => e.listing || e.resume || e.liq;
    const tot = exs.length, spc = exs.filter(special).length;
    console.log(`초과 ${tot}건(ETF 등 제외 대상 ${exs.filter((e) => e.ex).length}건 포함): 신규상장 직후 표시 ${exs.filter((e) => e.listing).length} | 거래 재개(직전 행과 ${DQ_RESUME_MIN_GAP}거래일 이상 간격) 표시 ${exs.filter((e) => e.resume).length} | 정리매매 기간(소멸 종목 마지막 ${DQ_LIQUIDATION_ROWS}행) 표시 ${exs.filter((e) => e.liq).length} | 위 셋 중 하나 이상 ${spc}건, 아무 표시 없음 ${tot - spc}건 | 조정 이벤트 있는 날 ${exs.filter((e) => e.ev).length}건`);
    console.log("| 분류 | 전체 | 표시(상장·재개·정리매매) 아님 | 표시 아님 + 조정 이벤트 없음 | 그중 K200P 월말 순위 안(코스피 시총 상위 200) |\n|---|---|---|---|---|");
    for (const cl of ["가", "나", "다"] as const) {
      const a = exs.filter((e) => e.cls === cl), b = a.filter((e) => !special(e)), c2 = b.filter((e) => !e.ev);
      console.log(`| (${cl}) ${cl === "가" ? "주가는 제한폭을 넘게 변했는데 시총 변동이 가격 변동과 크게 어긋남 → 미조정 분할·무상증자·감자 의심" : cl === "나" ? "시총도 같이 변함 → 실제 변동·거래 재개(또는 시총이 가격 × 이전 주식 수로 계산된 경우)" : "시총 값 없음 → 판단 불가"} | ${a.length} | ${b.length} | ${c2.length} | ${c2.filter((e) => e.k200 >= 0).length} |`);
    }
    const A = exs.filter((e) => e.cls === "가");
    console.log(`\n=== Q2. 분류 (가) ${A.length}건 — 연도별 분포 ===`);
    console.log("| 연도 | (가) 전체 | (가) 표시 아님 | (가) 표시 아님 + 이벤트 없음 | (나) 전체 |\n|---|---|---|---|---|");
    for (let y = 2010; y <= 2026; y++) {
      const ys = `${y}-`, a = A.filter((e) => e.d.startsWith(ys)), b = a.filter((e) => !special(e)), c2 = b.filter((e) => !e.ev), nn = exs.filter((e) => e.cls === "나" && e.d.startsWith(ys)).length;
      console.log(`| ${y} | ${a.length} | ${b.length} | ${c2.length} | ${nn} |`);
    }
    const fmt = (e: Ex): string => `| ${label(e.code)}${e.ex ? "(제외 대상)" : ""} | ${e.d} | ${f2(e.adjR * 100)} | ${f2(e.rawR * 100)} | ${f2(e.mcR * 100)} | ${f2(e.shR)} | ${e.vol} | ${e.gap} | ${[e.ev ? "이벤트 있음" : "", e.listing ? "상장직후" : "", e.resume ? "재개" : "", e.liq ? "정리매매" : ""].filter(Boolean).join("·") || "-"} | ${e.k200 >= 0 ? `K200P ${e.k200}위` : "-"} |`;
    const head = "| 종목 | 날짜 | 수정 수익률 % | 원 종가 수익률 % | 시총 변동 % | 시총÷가격 비 | 거래량 | 직전 행 간격 | 표시 | K200P |\n|---|---|---|---|---|---|---|---|---|---|";
    const k2 = A.filter((e) => e.k200 >= 0);
    console.log(`\n=== Q3. (가) 중 K200P(월말 코스피 시총 상위 200) 해당 ${k2.length}건 ===`);
    console.log(head); for (const e of k2.sort((x, y) => (x.d < y.d ? -1 : 1))) console.log(fmt(e));
    const main = A.filter((e) => !special(e) && !e.ev && !e.ex).sort((x, y) => Math.abs(y.adjR) - Math.abs(x.adjR));
    console.log(`\n=== Q4. (가) 중 표시 아님·이벤트 없음·제외 대상 아님 ${main.length}건 (|수정 수익률| 큰 순, 상위 ${Math.min(main.length, DQ_LIST_MAX)}건) ===`);
    console.log(head); for (const e of main.slice(0, DQ_LIST_MAX)) console.log(fmt(e));
    const rest = A.filter((e) => special(e) || e.ev || e.ex);
    console.log(`\n(가) 중 표시 있음·이벤트 있음·제외 대상 ${rest.length}건 — 표시별: 상장직후 ${rest.filter((e) => e.listing).length}, 재개 ${rest.filter((e) => e.resume).length}, 정리매매 ${rest.filter((e) => e.liq).length}, 이벤트 있음 ${rest.filter((e) => e.ev).length}, 제외 대상 ${rest.filter((e) => e.ex).length}`);
    console.log(`BS1 의심 3일(동서 2012-11-28·2013-11-27, 싸이토젠 2022-09-28)의 분류: ${exs.filter((e) => (e.code === "026960" && (e.d === "2012-11-28" || e.d === "2013-11-27")) || (e.code === "217330" && e.d === "2022-09-28")).map((e) => `${label(e.code)} ${e.d} → (${e.cls}) 시총 ${f2(e.mcR * 100)}% 시총÷가격 ${f2(e.shR)}`).join(" | ")}`);

    // ---- Q6. 시총 회복형(주식 수가 뒤따라 바뀌는 형태) 보조 탐지 ----
    {
      const flagged = (e: Ex): boolean => Number.isFinite(e.rec) && e.rec <= DQ_RECOVER_TOL;
      const B = exs.filter((e) => e.cls === "나" && !special(e) && !e.ev && !e.ex);
      console.log(`\n=== Q6. 보조 탐지: 가격이 제한폭을 넘어 변한 뒤 ${DQ_RECOVER_ROWS}행 안에 시총이 직전(변동 전 행) 수준 ±${DQ_RECOVER_TOL * 100}% 안으로 돌아오는가(상장주식수가 며칠 뒤 갱신되는 분할·무상증자·감자 패턴) ===`);
      console.log(`(나) 표시 아님·이벤트 없음·제외 대상 아님 ${B.length}건 중 회복형 ${B.filter(flagged).length}건, 비회복형 ${B.length - B.filter(flagged).length}건 | K200P 해당 ${B.filter((e) => e.k200 >= 0).length}건 중 회복형 ${B.filter((e) => e.k200 >= 0 && flagged(e)).length}건`);
      console.log("| 연도 | (나) 표시 아님·이벤트 없음 | 그중 회복형 |\n|---|---|---|");
      for (let y = 2010; y <= 2026; y++) { const a = B.filter((e) => e.d.startsWith(`${y}-`)); console.log(`| ${y} | ${a.length} | ${a.filter(flagged).length} |`); }
      const fm = (e: Ex): string => `| ${label(e.code)} | ${e.d} | ${f2(e.adjR * 100)} | ${f2(e.mcR * 100)} | ${e.vol} | ${Number.isFinite(e.rec) ? `${f2(e.rec * 100)}% (${e.recJ}행 뒤)` : "-"} | ${flagged(e) ? "회복형" : "비회복형"} | ${e.k200 >= 0 ? `K200P ${e.k200}위` : "-"} |`;
      const hd = "| 종목 | 날짜 | 수정 수익률 % | 시총 변동 % | 거래량 | 시총이 직전 수준에 가장 가까워진 거리(시점) | 판정 | K200P |\n|---|---|---|---|---|---|---|---|";
      console.log("\nK200P 해당 (나) 표시 아님·이벤트 없음:"); console.log(hd); for (const e of B.filter((x) => x.k200 >= 0).sort((a, b) => (a.d < b.d ? -1 : 1))) console.log(fm(e));
      console.log("\n회복형 중 제한폭 초과 크기 상위 " + Math.min(DQ_LIST_MAX, B.filter(flagged).length) + "건:"); console.log(hd);
      for (const e of B.filter(flagged).sort((a, b) => Math.abs(b.adjR) - Math.abs(a.adjR)).slice(0, DQ_LIST_MAX)) console.log(fm(e));
      console.log("\nBS1 의심 3일: " + exs.filter((e) => (e.code === "026960" && (e.d === "2012-11-28" || e.d === "2013-11-27")) || (e.code === "217330" && e.d === "2022-09-28")).map((e) => fm(e)).join(" ||"));
    }
    // ---- Q7. K200P 해당 미조정 의심일이 과거 K200P 시험의 보유와 겹쳤는가(가늠) ----
    {
      const K = exs.filter((e) => e.cls === "나" && !special(e) && !e.ev && !e.ex && e.k200 >= 0).sort((x, y) => (x.d < y.d ? -1 : 1));
      const cRm = startOf(RM1, false), cLr = startOf(LR1, false), cMv = startOf(MV1, false);
      const runsK: { nm: string; w: number; spells: { code: string; a: number; b: number }[] }[] = [];
      const addR = (nm: string, w: number, r: { trades: { code: string; entryC: number; exitC: number }[]; open?: { code: string; entryC: number }[] }): void => { runsK.push({ nm, w, spells: [...r.trades.map((t) => ({ code: t.code, a: t.entryC, b: t.exitC })), ...(r.open ?? []).map((t) => ({ code: t.code, a: t.entryC, b: nCal }))] }); };
      addR("RM1(5%)", 0.05, runS(RM1, RM1.P0, cRm, null, { lag: 1 })); addR("LR1(5%)", 0.05, runS(LR1, LR1.P0, cLr, null, { lag: 1 })); addR("MV1(상한 5%)", 0.05, runS(MV1, MV1.P0, cMv, null, { lag: 1 }));
      addR("TS1(5%)", 0.05, runTS(B5_TS_P0, { lag: 1 })); addR("DS6 위성 LV1(10% × 위성 60% = 6%)", 0.06, b6.satX.run);
      console.log(`\n=== Q7. 미조정 의심 K200P 해당 ${K.length}건(위 (나) 표시 아님·이벤트 없음)이 묶음 5·DS6 위성 보유와 겹쳤는가 ===`);
      console.log("| 종목 | 날짜 | 수정 수익률 % | 겹친 시험(비중 가정) | 계좌 영향 추정 %p (= 비중 × 수익률) |\n|---|---|---|---|---|");
      let any = 0;
      for (const e of K) {
        const k = h.calIdx.get(e.d) as number, hit = runsK.filter((r) => r.spells.some((sp) => sp.code === e.code && sp.a < k && k <= sp.b));
        if (hit.length) any++;
        console.log(`| ${label(e.code)} | ${e.d} | ${f2(e.adjR * 100)} | ${hit.length ? hit.map((r) => r.nm).join(", ") : "겹침 없음"} | ${hit.length ? hit.map((r) => f2(r.w * e.adjR * 100)).join(" / ") : "-"} |`);
      }
      console.log(`겹친 의심일 ${any}건 / ${K.length}건. DS6 코어(K200P 시총 상위 2종목)는 의심 종목의 당시 순위가 모두 3위 밖이라 영향 없음(가장 높은 순위 ${K.map((e) => e.k200).sort((a, b) => a - b)[0]}위).`);
    }
    {
      const L = exs.filter((e) => e.cls === "나" && !special(e) && !e.ev && !e.ex);
      const mk = (e: Ex): string => membAt(e.d)?.get(e.code) ?? "?";
      const dates = new Set(L.map((e) => e.d)), dm = new Set(L.map((e) => `${e.d}|${mk(e)}`));
      const byM = new Map<string, number>(); for (const e of L) byM.set(mk(e), (byM.get(mk(e)) ?? 0) + 1);
      console.log(`\n=== Q8. 의심 ${L.length}건을 KRX 공식 등락률로 보정할 때의 호출 수 ===`);
      console.log(`시장 구분(월말 시장표 기준): ${[...byM].map(([k2, v]) => `${k2} ${v}건`).join(", ")} | 서로 다른 날짜 ${dates.size}개 | (날짜, 시장) 조합 ${dm.size}개 → 일별매매정보는 날짜·시장당 1회 호출(전 종목 응답)이므로 **최소 ${dm.size}회**(시장을 모르면 날짜당 2회 시도 시 최대 ${dates.size * 2}회). K200P 17건과 같은 날짜가 겹치는 것은 이미 호출했으므로 제외 가능.`);
    }
    // ---- Q5. 소멸 종목 처리 관례 제안 집계 ----
    console.log(`\n=== Q5. 소멸 종목 집계 (마지막 행이 데이터 끝 ${dataEnd}보다 앞인 종목) ===`);
    interface Va { code: string; last: string; lastIdx: number; close: number; halts: number; r7: number; r20: number; volRatio: number; ex: boolean; recent: boolean }
    const vas: Va[] = [];
    for (const s2 of h.stocks) {
      if (!(s2.last < dataEnd)) continue;
      const n = s2.dates.length, li = h.calIdx.get(s2.last) as number, fi = h.calIdx.get(s2.dates[0]) as number;
      let halts = 0;
      for (let k = Math.max(li - DQ_VANISH_WINDOW_DAYS + 1, fi); k <= li; k++) if (!s2.idx.has(CAL[k])) halts++;
      const back = (m: number): number => (n - 1 - m >= 0 && s2.close[n - 1 - m] > 0 ? s2.close[n - 1] / s2.close[n - 1 - m] - 1 : Number.NaN);
      let vs = 0, vc = 0;
      for (let q = Math.max(n - 61, 0); q < n - 1; q++) { vs += s2.vol[q]; vc++; }
      vas.push({ code: s2.code, last: s2.last, lastIdx: li, close: s2.raw[n - 1], halts, r7: back(DQ_ALT_LAST_ROWS), r20: back(DQ_VANISH_WINDOW_DAYS), volRatio: vc && vs > 0 ? s2.vol[n - 1] / (vs / vc) : Number.NaN, ex: excluded.has(s2.code), recent: nCal - 1 - li < DQ_RECENT_VANISH_DAYS });
    }
    const lossP = (v: Va): { halt: boolean; px: boolean } => ({ halt: v.halts >= DQ_VANISH_HALT_DAYS, px: v.close < DQ_VANISH_MIN_CLOSE });
    const cnt = (list: Va[]): { clear: number; haltOnly: number; pxOnly: number; both: number } => ({ clear: list.filter((v) => !lossP(v).halt && !lossP(v).px).length, haltOnly: list.filter((v) => lossP(v).halt && !lossP(v).px).length, pxOnly: list.filter((v) => !lossP(v).halt && lossP(v).px).length, both: list.filter((v) => lossP(v).halt && lossP(v).px).length });
    const row = (nm: string, list: Va[]): string => { const c2 = cnt(list); return `| ${nm} | ${list.length} | ${c2.clear} | ${c2.haltOnly} | ${c2.pxOnly} | ${c2.both} | ${list.length - c2.clear} |`; };
    console.log(`전체 ${vas.length}개(ETF 등 제외 대상 ${vas.filter((v) => v.ex).length}개, 최근 ${DQ_RECENT_VANISH_DAYS}거래일 안 소멸·미확정 ${vas.filter((v) => v.recent).length}개 포함). 제안 규칙: 마지막 종가로 청산하되, 소멸 직전 ${DQ_VANISH_WINDOW_DAYS}거래일 안 거래정지(행 없는 날) ${DQ_VANISH_HALT_DAYS}일 이상이거나 마지막 종가 ${DQ_VANISH_MIN_CLOSE}원 미만이면 전액 손실.`);
    console.log("| 구분 | 종목 수 | 마지막 종가 청산 | 전액 손실(정지만) | 전액 손실(종가만) | 전액 손실(둘 다) | 전액 손실 합 |\n|---|---|---|---|---|---|---|");
    console.log(row("전체", vas)); console.log(row("제외 대상(ETF 등) 뺀 나머지", vas.filter((v) => !v.ex)));
    console.log(row("그중 최근 소멸(미확정) 뺀 나머지", vas.filter((v) => !v.ex && !v.recent)));
    for (let y = 2010; y <= 2026; y++) { const l = vas.filter((v) => !v.ex && v.last.startsWith(`${y}-`)); if (l.length) console.log(row(`${y}년 소멸`, l)); }
    const med = (arr: number[]): number => { const b = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : Number.NaN; };
    const grp = (nm: string, l: Va[]): string => `| ${nm} | ${l.length} | ${f2(med(l.map((v) => v.r7)) * 100)} | ${f2(med(l.map((v) => v.r20)) * 100)} | ${f2(med(l.map((v) => v.close)))} | ${f2(med(l.map((v) => v.halts)))} | ${f2(med(l.map((v) => v.volRatio)))} |`;
    const nonEx = vas.filter((v) => !v.ex && !v.recent), clearL = nonEx.filter((v) => !lossP(v).halt && !lossP(v).px), lossL = nonEx.filter((v) => lossP(v).halt || lossP(v).px);
    const bs7 = ["004010", "004940", "192530", "000030", "005190", "002270", "003410"];
    console.log("\n가격 기반 구분 신호(중앙값): 마지막 7행 수익률 % / 마지막 20행 수익률 % / 마지막 원 종가 / 직전 20거래일 정지일수 / 마지막 날 거래량 ÷ 직전 60행 평균");
    console.log("| 집단 | 종목 수 | r7 % | r20 % | 마지막 종가 | 정지일수 | 거래량 배수 |\n|---|---|---|---|---|---|---|");
    console.log(grp("제안 규칙: 마지막 종가 청산 집단", clearL)); console.log(grp("제안 규칙: 전액 손실 집단", lossL)); console.log(grp("BS1 소멸 7건(합병·교환·이전 추정)", vas.filter((v) => bs7.includes(v.code))));
    const alt = (v: Va): boolean => (Number.isFinite(v.r7) && v.r7 <= DQ_ALT_LAST_RETURN) || (Number.isFinite(v.r20) && v.r20 <= DQ_ALT_LAST_RETURN);
    const altLoss = nonEx.filter((v) => lossP(v).halt || lossP(v).px || alt(v));
    {
      const stable = (v: Va): boolean => Number.isFinite(v.r7) && Number.isFinite(v.r20) && v.r7 >= -0.1 && v.r20 >= -0.2;
      const sub = (nm: string, l: Va[]): string => `${nm} ${l.length}개 중 가격 안정형(마지막 7행 수익률 ≥ −10% ∧ 20행 ≥ −20%) ${l.filter(stable).length}개, 마지막 종가 중앙값 ${f2(med(l.map((v) => v.close)))}, 정지일수 중앙값 ${f2(med(l.map((v) => v.halts)))}`;
      console.log("\n전액 손실 집단 세부(제외 대상·최근 소멸 뺀 나머지): " + [sub("정지만 걸림", nonEx.filter((v) => lossP(v).halt && !lossP(v).px)), sub("종가 1,000원 미만만 걸림", nonEx.filter((v) => !lossP(v).halt && lossP(v).px)), sub("둘 다 걸림", nonEx.filter((v) => lossP(v).halt && lossP(v).px))].join(" | "));
    }
    console.log(`\n대안 신호(제안만): 제안 규칙 OR 마지막 ${DQ_ALT_LAST_ROWS}행 또는 ${DQ_VANISH_WINDOW_DAYS}행 수익률 ≤ ${DQ_ALT_LAST_RETURN * 100}% → 전액 손실 ${altLoss.length}개 / 청산 ${nonEx.length - altLoss.length}개(제안 규칙 단독은 손실 ${lossL.length} / 청산 ${clearL.length}). 제안 규칙에는 안 걸리고 대안에만 걸린 종목 ${altLoss.length - lossL.length}개.`);
    console.log("BS1 소멸 7건의 제안 규칙 적용: " + vas.filter((v) => bs7.includes(v.code)).map((v) => `${label(v.code)} 마지막 종가 ${v.close} 정지일수 ${v.halts} r7 ${f2(v.r7 * 100)}% r20 ${f2(v.r20 * 100)}% → ${lossP(v).halt || lossP(v).px ? "전액 손실" : "마지막 종가 청산"}`).join(" | "));
    console.log(`\n전 종목 점검 종료 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    return;
  }
  if (MODE === "bsv") {
    // BS1 데이터·구현 검증(시험 아님, 시험 번호·게이트 없음, 읽기 전용).
    const cB = startOf(BS1, false), WB = windowsFor(cB), bs = runS(BS1, BS1.P0, cB, null, { lag: 1, detail: true });
    const dataEndIdx = nCal - 1;
    console.log(`\n=== V1. 데이터 출처·기간·종목 수 ===`);
    console.log(`출처: 고정 스냅샷 연도별 가격 Parquet(2010~2026, Supabase Storage → Actions 캐시, 매니페스트 SHA-256 일치) + 적용된 조정 이벤트 ${[...h.adjustments.values()].reduce((a, l) => a + l.length, 0)}건 | 거래일 ${nCal}일 ${CAL[0]}~${CAL[dataEndIdx]} | 월말 시장 구분(KOSPI/KOSDAQ) 목록: KRX Open API 월말 스냅샷(저장본)`);
    console.log("| 연도 | 그 해 행이 있는 종목 | 마지막 월말 시장표 코스피 | 코스닥 | BS1 적격 유니버스(코스피 / 코스닥) | 그 해 마지막 행으로 사라진 종목(상장폐지 포함 소멸) |\n|---|---|---|---|---|---|");
    for (let y = 2011; y <= 2026; y++) {
      const ys = `${y}-`, endsY = monthEndIdx.filter((c) => CAL[c].startsWith(ys)), cL = endsY.length ? endsY[endsY.length - 1] : -1;
      let present = 0, gone = 0, kp = 0, kq = 0, ekp = 0, ekq = 0;
      for (const s2 of h.stocks) { if (s2.dates.some((d) => d.startsWith(ys))) present++; if (s2.last.startsWith(ys) && s2.last < CAL[dataEndIdx]) gone++; }
      if (cL >= 0) {
        const m = membAt(CAL[cL]);
        if (m) for (const [, mk] of m) { if (mk === "KOSPI") kp++; else if (mk === "KOSDAQ") kq++; }
        for (const code of bsElig(cL, BS1.P0)) { const mk = m?.get(code); if (mk === "KOSPI") ekp++; else if (mk === "KOSDAQ") ekq++; }
      }
      console.log(`| ${y} | ${present} | ${kp} | ${kq} | ${ekp + ekq}(${ekp} / ${ekq}) | ${gone} |`);
    }
    const goneAll = h.stocks.filter((s2) => s2.last < CAL[dataEndIdx]).length;
    console.log(`상장폐지·소멸 포함 여부: 마지막 행이 데이터 끝(${CAL[dataEndIdx]})보다 앞인 종목 ${goneAll}개가 데이터에 들어 있고 월말 시장표도 그 시점 구성(과거 스냅샷)이라 BS1 유니버스에 포함됨(생존 편향 없음). 코스닥 포함: 월말 시장표가 KOSDAQ인 종목 포함(위 표).`);

    console.log(`\n=== V2. 일간 수익률 산식 ===`);
    console.log(`수익률 = 조정 종가의 전일 대비 비율(수정주가: 가격 Parquet 종가에 적용된 조정 이벤트 계수를 거꾸로 곱함, 등락률 열 미사용). 행이 없는 날(거래정지·미상장) 수익률 0, 상장 전 0. 체결·평가는 조정 종가, 거래대금 조건은 원 종가 × 거래량.`);
    const evs: { code: string; eventDate: string; factor: number; adjR: number; rawR: number; i: number }[] = [];
    for (const [code, list] of h.adjustments) for (const e of list) {
      const s2 = h.byCode.get(code); if (!s2) continue;
      const i = s2.dates.findIndex((d) => d >= e.eventDate);
      if (i < 1 || !(s2.raw[i - 1] > 0)) continue;
      evs.push({ code, eventDate: e.eventDate, factor: e.factor, adjR: s2.close[i] / s2.close[i - 1] - 1, rawR: s2.raw[i] / s2.raw[i - 1] - 1, i });
    }
    evs.sort((a, b) => (a.eventDate < b.eventDate ? -1 : 1));
    const big = (t: number): number => evs.filter((e) => Math.abs(e.adjR) > t).length;
    console.log(`조정 이벤트 ${evs.length}건(종목 행이 있는 건): 이벤트 당일 수정 수익률 절댓값 > 10% ${big(0.1)}건, > 20% ${big(0.2)}건, > 30% ${big(0.3)}건.`);
    const pick5 = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => evs[Math.floor((evs.length * (k + 0.5)) / 8)]);
    const topBig = [...evs].sort((a, b) => Math.abs(b.adjR) - Math.abs(a.adjR)).slice(0, 4);
    console.log("| 표본 | 종목 | 이벤트일 | 계수 | 원 종가 전일 → 당일 | 원 종가 수익률 % | 수정 종가 수익률 % | 거래량 당일 |\n|---|---|---|---|---|---|---|---|");
    for (const [tag, list] of [["고른 8건(시기별 균등)", pick5], ["수정 수익률 절댓값 최대 4건", topBig]] as const) for (const e of list) { const s2 = h.byCode.get(e.code) as S; console.log(`| ${tag} | ${label(e.code)} | ${e.eventDate} | ${e.factor.toFixed(4)} | ${s2.raw[e.i - 1]} → ${s2.raw[e.i]} | ${f2(e.rawR * 100)} | ${f2(e.adjR * 100)} | ${s2.vol[e.i]} |`); }

    console.log(`\n=== V3. BS1 보유 중 일간 수정 수익률 ≤ −25% 또는 ≥ +25%인 날 전부 분류 ===`);
    const evByCodeDate = new Map<string, { factor: number }>();
    for (const [code, list] of h.adjustments) for (const e of list) evByCodeDate.set(`${code}|${e.eventDate}`, { factor: e.factor });
    interface Flag { code: string; d: string; adjR: number; rawR: number; vol: number; gap: number; cls: string; mcR: number; shR: number }
    const flags: Flag[] = [];
    let heldDays = 0;
    for (const t of [...bs.trades, ...bs.open]) {
      const s2 = h.byCode.get(t.code); if (!s2) continue;
      const endC = t.exitC !== undefined && Number.isFinite(t.exitC) ? Math.min(t.exitC, dataEndIdx) : dataEndIdx;
      const a = al(s2);
      for (let k = t.entryC + 1; k <= endC; k++) {
        heldDays++;
        const r = a[k - 1] > 0 && a[k] > 0 ? a[k] / a[k - 1] - 1 : 0;
        if (Math.abs(r) < 0.25) continue;
        const i = s2.idx.get(CAL[k]);
        let pi = -1;
        for (let q = k - 1; q >= 0; q--) { const j = s2.idx.get(CAL[q]); if (j !== undefined) { pi = j; break; } }
        const rawR = i !== undefined && pi >= 0 ? s2.raw[i] / s2.raw[pi] - 1 : Number.NaN;
        const prevK = pi >= 0 ? (h.calIdx.get(s2.dates[pi]) as number) : k - 1, gap = k - prevK;
        let hasEv = false;
        for (let q = prevK + 1; q <= k; q++) if (evByCodeDate.has(`${t.code}|${CAL[q]}`)) hasEv = true;
        const vol = i !== undefined ? s2.vol[i] : 0;
        const mcR = i !== undefined && pi >= 0 && s2.mcapRow[pi] > 0 ? s2.mcapRow[i] / s2.mcapRow[pi] : Number.NaN, shR = Number.isFinite(mcR) && Number.isFinite(rawR) ? mcR / (1 + rawR) : Number.NaN;
        const cls = i === undefined ? "당일 행 없음(전일 값 유지 중 → 이 날 수익률은 다음 행에 반영)" : hasEv ? "조정 이벤트 구간(수정 수익률 별도 검토)" : gap > 5 ? `긴 공백 뒤 재개(${gap}거래일 만에 행)` : Number.isFinite(shR) && Math.abs(shR - 1) > 0.2 ? "시가총액 ÷ 가격(주식 수)이 크게 변함 — 미조정 분할·증자·감자 의심" : Math.abs(rawR) > 0.3 + 1e-9 ? "가격제한폭 초과 변동인데 이벤트 없음(의심)" : vol === 0 ? "거래량 0" : "실제 가격 변동으로 보임(원 종가 변동 = 수정 종가 변동, 이벤트 없음, 거래량 > 0, 제한폭 이내)";
        flags.push({ code: t.code, d: CAL[k], adjR: r, rawR, vol, gap, cls, mcR, shR });
      }
    }
    flags.sort((x, y) => (x.d < y.d ? -1 : 1));
    const byCls = new Map<string, number>();
    for (const f of flags) byCls.set(f.cls.split("(")[0], (byCls.get(f.cls.split("(")[0]) ?? 0) + 1);
    console.log(`보유 종목-일 ${heldDays}개 중 |수정 수익률| ≥ 25%인 날 ${flags.length}개: ${[...byCls].map(([k2, v]) => `${k2} ${v}건`).join(", ") || "없음"}`);
    console.log("| 종목 | 날짜 | 수정 수익률 % | 원 종가 수익률 % | 시가총액 변동 % | 시총÷가격 비(주식 수 변화) | 거래량 | 직전 행과 간격(거래일) | 분류 |\n|---|---|---|---|---|---|---|---|---|");
    for (const f of flags.slice(0, 80)) console.log(`| ${label(f.code)} | ${f.d} | ${f2(f.adjR * 100)} | ${f2(f.rawR * 100)} | ${f2((f.mcR - 1) * 100)} | ${f2(f.shR)} | ${f.vol} | ${f.gap} | ${f.cls} |`);
    if (flags.length > 80) console.log(`… 나머지 ${flags.length - 80}건 생략(위는 날짜순 앞 80건)`);

    console.log(`\n=== V4. 소멸(폐지) 처리 ${bs.trades.filter((t) => t.reason.startsWith("폐지")).length}건 ===`);
    console.log("| 종목 | 진입(체결일) | 청산(체결일) | 마지막 행 날짜 | 마지막 원 종가 / 거래량 | 보유 구간 수익률 % | 같은 이름의 다른 코드(코드 변경·이전상장 후보) |\n|---|---|---|---|---|---|---|");
    for (const t of bs.trades.filter((x) => x.reason.startsWith("폐지"))) {
      const s2 = h.byCode.get(t.code) as S, li = s2.dates.length - 1, nm = nameOf.get(t.code);
      const same = nm ? h.stocks.filter((o2) => o2.code !== t.code && nameOf.get(o2.code) === nm).map((o2) => `${o2.code}(${o2.dates[0]}~${o2.last})`).join(", ") : "";
      console.log(`| ${label(t.code)} | ${CAL[t.entryC]} | ${CAL[t.exitC]} | ${s2.last} | ${s2.raw[li]} / ${s2.vol[li]} | ${f2((t.proceeds / t.spend - 1) * 100)} | ${same || "없음"} |`);
    }

    console.log(`\n=== V5. BS1 최대 낙폭(MDD) 구간 ===`);
    {
      const rr = bs.ret.map((x, i2) => ({ d: bs.dates[i2], r: x })).filter((x) => x.d >= WB.FULL.from);
      let v = 1, peak = 1, peakD = rr[0].d, mdd = 0, mp = rr[0].d, mt = rr[0].d;
      for (const x of rr) { v *= 1 + x.r / 100; if (v > peak) { peak = v; peakD = x.d; } const dd = 1 - v / peak; if (dd > mdd) { mdd = dd; mp = peakD; mt = x.d; } }
      console.log(`BS1 연속 전체 MDD ${f2(mdd * 100)}%: 고점일 ${mp} → 저점일 ${mt}`);
      const kospi = await getIndexPriceSeries("KOSPI", "2009-01-01", CAL[dataEndIdx]), kosdaq = await getIndexPriceSeries("KOSDAQ", "2009-01-01", CAL[dataEndIdx]);
      dbRead["beta_price_history(KOSPI)"] = kospi.length; dbRead["beta_price_history(KOSDAQ)"] = kosdaq.length;
      const chg = (ser: { tradeDate: string; closePrice: number }[], a: string, b: string): number => { const x = [...ser].reverse().find((p2) => p2.tradeDate <= a), y = [...ser].reverse().find((p2) => p2.tradeDate <= b); return x && y ? (y.closePrice / x.closePrice - 1) * 100 : Number.NaN; };
      const ew = runS(BSA_FOR_V, BS1.P0, cB, null, { lag: 1 }), ewr = ew.dates.map((d, i2) => ({ d, r: ew.ret[i2] }));
      const curveChg = (rs: { d: string; r: number }[], a: string, b: string): number => { let vv = 1; for (const x of rs) if (x.d > a && x.d <= b) vv *= 1 + x.r / 100; return (vv - 1) * 100; };
      const bh = h.bhP.dates.map((d, i2) => ({ d, r: h.bhP.ret[i2] }));
      console.log(`같은 구간(${mp}~${mt}) 등락 %: BS1 ${f2(curveChg(rr, mp, mt))} | 전 종목 동일 비중 ${f2(curveChg(ewr, mp, mt))} | 069500 ${f2(curveChg(bh, mp, mt))} | KOSPI 지수 ${f2(chg(kospi, mp, mt))} | KOSDAQ 지수 ${f2(chg(kosdaq, mp, mt))} (지수 행 수 KOSPI ${kospi.length}, KOSDAQ ${kosdaq.length})`);
    }
    console.log(`\nBS1 검증 종료 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    return;
  }
  if (MODE === "info") {
    // 사전등록 정보용 보고(시험 아님, 시험 번호·게이트 없음): PF1 짝 보통주 대체 분해·보유 종목 거래대금, MV1 실현 변동성.
    const cP = startOf(PF1, false), WP = windowsFor(cP);
    const pf = runS(PF1, PF1.P0, cP, null, { lag: 1, detail: true });
    const comOf = (code: string): string => code.slice(0, 5) + "0", prefOf = (code: string): string => code.slice(0, 5) + "5";
    const PF1S: Strat<PfP> = { ...PF1, targets: (c, held, P, m) => new Map([...PF1.targets(c, new Set([...held].map(prefOf)), P, m, true)].map(([k, v]) => [comOf(k), v] as [string, number])) };
    const sw = runS(PF1S, PF1.P0, cP, null, { lag: 1, detail: true });
    console.log(`\n=== 정보용 1. PF1 우선주 대 짝 보통주 대체(같은 월말 선정·같은 비중·같은 슬리피지 ${B5_PF_SLIP * 100}%·같은 체결, 시험 아님; CAGR % / MDD %) ===`);
    console.log("| 구간 | PF1(우선주) | 같은 선정을 짝 보통주로 | 차이(우선주 − 보통주) CAGR %p |\n|---|---|---|---|");
    for (const [nm, w] of WP.ALL) { const a = h.st(pf, w), b = h.st(sw, w); console.log(`| ${nm} | ${f2(a.cagr)} / ${f2(a.mdd)} | ${f2(b.cagr)} / ${f2(b.mdd)} | ${a.cagr - b.cagr >= 0 ? "+" : ""}${f2(a.cagr - b.cagr)} |`); }
    const tvs: number[] = [];
    for (const t of [...pf.trades, ...pf.open]) { const st = h.byCode.get(t.code); if (st) tvs.push(tvAvg(st, t.entryC - 1, B5_PF_TV_DAYS)); }
    tvs.sort((x, y) => x - y);
    console.log(`PF1 보유 종목(진입 시점, 우선주 ${B5_PF_TV_DAYS}일 평균 거래대금 = 원 종가 × 거래량) ${tvs.length}건: 최솟값 ${f2(tvs[0] / 1e8)}억 원 | 하위 10% ${f2(tvs[Math.floor(tvs.length * 0.1)] / 1e8)}억 | 중앙값 ${f2(median(tvs) / 1e8)}억 | 대상 기준 ${f2(B5_PF_P0.minTv / 1e8)}억`);
    const cM = startOf(MV1, false), WM = windowsFor(cM), mv = runS(MV1, MV1.P0, cM, null, { lag: 1, detail: true });
    console.log(`\n=== 정보용 2. MV1 연 실현 변동성(일수익률 표준편차 연율화(하니스 ETF_TRADING_DAYS_PER_YEAR), %) 대 069500(같은 구간) ===`);
    console.log("| 구간 | MV1 | 069500 | MV1 / 069500 |\n|---|---|---|---|");
    for (const [nm, w] of WM.ALL) { const a = h.st(mv, w), b = h.st(h.bhP, w); console.log(`| ${nm} | ${f2(a.vol)} | ${f2(b.vol)} | ${f2(a.vol / b.vol)} |`); }
    // ---- 정보용 3. BS1 정보(시험 아님) ----
    {
      const cB = startOf(BS1, false), WB = windowsFor(cB), bs = runS(BS1, BS1.P0, cB, null, { lag: 1, detail: true });
      const BSL: Strat<BsP> = { ...BS1, vanish: "last" };
      const BSA: Strat<BsP> = { ...BS1, targets: (c, _held, P, m) => { const el = bsElig(c, P); return equalW(el, 1 / Math.max(el.length, 1), m); } };
      const bl = runS(BSL, BS1.P0, cB, null, { lag: 1 }), ba = runS(BSA, BS1.P0, cB, null, { lag: 1 });
      console.log(`\n=== 정보용 3. BS1 정보(시험 아님; 소멸 종목 처리·전 종목 동일 비중 대조) ===`);
      console.log("| 구간 | BS1(소멸 = 전액 손실) | 소멸 = 마지막 종가 청산 | 전 종목(적격) 동일 비중 월 재조정 |\n|---|---|---|---|");
      for (const [nm, w] of WB.ALL) { const a = h.st(bs, w), b = h.st(bl, w), c2 = h.st(ba, w); console.log(`| ${nm} | ${f2(a.cagr)} / ${f2(a.mdd)} | ${f2(b.cagr)} / ${f2(b.mdd)} | ${f2(c2.cagr)} / ${f2(c2.mdd)} |`); }
      const ents = [...bs.trades, ...bs.open];
      let kospi = 0, kosdaq = 0;
      const caps: number[] = [], ratios: number[] = [];
      for (const t of ents) {
        const c = t.entryC - 1, sk = h.byCode.get(t.code);
        if (!sk) continue;
        const mk = membAt(CAL[c])?.get(t.code);
        if (mk === "KOSPI") kospi++; else if (mk === "KOSDAQ") kosdaq++;
        const mc = mcapNear(sk, c);
        if (Number.isFinite(mc)) caps.push(mc);
        const tvs: number[] = [];
        for (let k = c - BS1.P0.tvMedianDays + 1; k <= c; k++) { const j = rowAt(sk, k); tvs.push(j === undefined ? 0 : sk.raw[j] * sk.vol[j]); }
        const md = medianOf(tvs);
        if (md > 0) ratios.push(1e8 / md);
      }
      caps.sort((x, y) => x - y); ratios.sort((x, y) => x - y);
      const q = (arr: number[], f: number): number => arr[Math.min(arr.length - 1, Math.floor(arr.length * f))];
      console.log(`BS1 보유 진입 ${ents.length}건: 코스피 ${kospi}건(${f2((kospi / Math.max(kospi + kosdaq, 1)) * 100)}%) / 코스닥 ${kosdaq}건(${f2((kosdaq / Math.max(kospi + kosdaq, 1)) * 100)}%) | 진입 시 시가총액 중앙값 ${f2(median(caps))}억 원(하위 10% ${f2(q(caps, 0.1))}억, 상위 10% ${f2(q(caps, 0.9))}억) | 1억 원 주문 ÷ 60일 거래대금 중앙값: 중앙값 ${f2(median(ratios) * 100)}% / 90분위 ${f2(q(ratios, 0.9) * 100)}% / 최대 ${f2(ratios[ratios.length - 1] * 100)}%`);
      const dl = ents.filter((t) => t.reason.startsWith("폐지")), allPnl = ents.reduce((a, t) => a + pnlS(t), 0), dlPnl = dl.reduce((a, t) => a + pnlS(t), 0);
      console.log(`BS1 소멸(폐지) 청산 ${dl.length}건: 계좌 대비 손익 합 ${f2(dlPnl * 100)}%p(전 거래 손익 합 ${f2(allPnl * 100)}%p, 진입 시 계좌 대비 합) | 진입 체결일 거래정지로 건너뜀 ${bs.haltSkip}건, 청산 순연 ${bs.exitDefer}건 | 평균 보유 종목 수 ${f2(h.st(bs, WB.FULL).avgN)}`);
    }
    // ---- 정보용 4. 시험한 전략들의 일수익률 상관(시험 아님) ----
    {
      const mk = (name: string, dates: string[], ret: number[]): { name: string; m: Map<string, number> } => ({ name, m: new Map(dates.map((d, i) => [d, ret[i]])) });
      const cT = startOf(RM1, false);
      const series = [
        mk("069500", h.bhP.dates, h.bhP.ret), mk("DS6", b6.res.run.dates, b6.res.run.ret),
        (() => { const r = runS(RM1, RM1.P0, cT, null, { lag: 1 }); return mk("RM1", r.dates, r.ret); })(),
        (() => { const r = runS(LR1, LR1.P0, startOf(LR1, false), null, { lag: 1 }); return mk("LR1", r.dates, r.ret); })(),
        (() => { const r = runS(PF1, PF1.P0, startOf(PF1, false), null, { lag: 1 }); return mk("PF1", r.dates, r.ret); })(),
        (() => { const r = runTS(B5_TS_P0, { lag: 1 }); return mk("TS1", r.dates, r.ret); })(),
        (() => { const r = runS(MV1, MV1.P0, startOf(MV1, false), null, { lag: 1 }); return mk("MV1", r.dates, r.ret); })(),
        (() => { const r = runS(BS1, BS1.P0, startOf(BS1, false), null, { lag: 1 }); return mk("BS1", r.dates, r.ret); })(),
      ];
      const first = series.slice(2).reduce((mx, x) => { const d = [...x.m.keys()].sort()[0]; return d > mx ? d : mx; }, "");
      const days = [...series[1].m.keys()].filter((d) => d >= first && series.every((x) => x.m.has(d))).sort();
      const corr = (a: Map<string, number>, b: Map<string, number>): number => {
        const xs = days.map((d) => a.get(d) as number), ys = days.map((d) => b.get(d) as number), n = xs.length;
        const mx = xs.reduce((u, v) => u + v, 0) / n, my = ys.reduce((u, v) => u + v, 0) / n;
        let sxy = 0, sxx = 0, syy = 0;
        for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
        return sxy / Math.sqrt(sxx * syy);
      };
      console.log(`\n=== 정보용 4. 시험한 전략(단독형)·DS6·069500 일수익률 상관계수(공통 구간 ${days[0]}~${days[days.length - 1]}, ${days.length}일, 시험 아님) ===`);
      console.log(`| | ${series.map((x) => x.name).join(" | ")} |\n|---|${series.map(() => "---").join("|")}|`);
      for (const a of series) console.log(`| ${a.name} | ${series.map((b) => f2(corr(a.m, b.m))).join(" | ")} |`);
    }
    console.log(`\n정보용 실행 종료 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    return;
  }
  if (MODE === "a") {
    doS(RM1, "RM1", false, ttl("RM1", "K200P, 월말 신호, 069500 회귀 잔차 점수(√n·α/σ) 상위 20종목 5% 동일 비중, 보유는 40위 안이면 유지, 매월 5%로 재조정, 항상 100%"));
    doC(RM1, "RM1C", ttl("RM1C", "DS6 코어 40% + 위성 60% = RM1"));
    doS(RM1, "RM1F", true, ttl("RM1F", "RM1 + 월말 069500 종가 < 200일선이면 주식 비중 50%"));
  } else if (MODE === "b1") {
    doS(LR1, "LR1", false, ttl("LR1", "K200P, 분기말 신호, 최근 126일 수익률이 069500을 넘는 종목 중 장기(t−504~t−126) 수익률 최저 20종목 5% 동일 비중"));
    doS(LR1, "LR1F", true, ttl("LR1F", "LR1 + 월말 069500 종가 < 200일선이면 비중 50%(교체는 분기말만)"));
  } else if (MODE === "b2") {
    doS(PF1, "PF1", false, ttl("PF1", "보통주 대비 우선주 괴리 z(252일) 최저 10개 우선주 10% 동일 비중, 월말 신호, 슬리피지 0.2%"));
    doS(PF1, "PF1F", true, ttl("PF1F", "PF1 + 월말 069500 종가 < 200일선이면 비중 50%"));
  } else if (MODE === "b3") {
    const Wx = windowsFor(cTS), trial = tn++;
    trialNums.push(trial);
    console.log(`\n연속 평가(TS1, 시험 ${trial}): 초기 ${CAL[cTS]} 종가, 수익률 집계 ${Wx.FULL.from}~${h.dataEnd}`);
    verdicts.push(evaluate(h, Wx, mkTS("TS1", trial, Wx)));
  } else if (MODE === "b4") {
    doS(MV1, "MV1", false, ttl("MV1", "K200P 시총 상위 100, 공분산(252일, 0.5 축소) 최소분산, 종목 0~5%, 월말 신호, 항상 100%"));
    doC(MV1, "MV1C", ttl("MV1C", "DS6 코어 40% + 위성 60% = MV1"));
  } else if (MODE === "c") {
    doS(BS1, "BS1", false, ttl("BS1", "코스피+코스닥 전 종목 지루한 주식 점수(변동성·상위 3일 평균·회전율 백분위) 최저 30종목 동일 비중, 월말 신호, 소멸 종목 전액 손실"));
    doC(BS1, "BS1C", ttl("BS1C", "DS6 코어 40% + 위성 60% = BS1"));
  } else if (MODE === "rt") {
    doS(RT1, "RT1", false, ttl("RT1", "K200P(PIT) 월말 신호, 069500 회귀 잔차 모멘텀 점수 상위 50% 종목을 시총 비중(상한 30%)으로 보유, 기존 보유는 상위 60% 안이면 유지, 매월 목표 비중으로 재조정, 항상 100%"));
    doS(RT1, "RT1F", true, ttl("RT1F", "RT1 + 월말 069500 종가 < 200일선이면 주식 비중 50%"));
    doS(RT2, "RT2", false, ttl("RT2", "RT1에서 점수 상위 25%, 유지 35%"));
    // ---- RT 정보용 보고(사전등록 2절 항목 2~6) ----
    if (!IDS) {
    const cR = startOf(RT1, false), WR = windowsFor(cR);
    const base = (def: Strat<RtP>, F: boolean): RebalRun => runS(def, def.P0, cR, F ? { ma: B5_MA_DAYS } : null, { lag: 1, detail: true });
    const rt1 = base(RT1, false), rt1f = base(RT1, true), rt2 = base(RT2, false), rt0 = base(RT0, false), rm1 = runS(RM1, RM1.P0, startOf(RM1, false), null, { lag: 1 });
    console.log(`\n=== RT 정보 1. 기준선 RT0(K200P 전 종목 시총 비중, 상한 30%) 대 RT1·RT1F·RT2 (CAGR % / MDD %; 시험 아님, 같은 구간 ${WR.FULL.from}~) ===`);
    console.log("| 구간 | 069500 | RT0 | RT1 | RT1F | RT2 | RT1 − RT0 CAGR %p / MDD %p | RT1F − RT0 | RT2 − RT0 |\n|---|---|---|---|---|---|---|---|---|");
    for (const [nm, w] of WR.ALL) {
      const b = h.st(h.bhP, w), z = h.st(rt0, w), a1 = h.st(rt1, w), a2 = h.st(rt1f, w), a3 = h.st(rt2, w);
      const d = (x: { cagr: number; mdd: number }): string => `${x.cagr - z.cagr >= 0 ? "+" : ""}${f2(x.cagr - z.cagr)} / ${x.mdd - z.mdd >= 0 ? "+" : ""}${f2(x.mdd - z.mdd)}`;
      console.log(`| ${nm} | ${f2(b.cagr)} / ${f2(b.mdd)} | ${f2(z.cagr)} / ${f2(z.mdd)} | ${f2(a1.cagr)} / ${f2(a1.mdd)} | ${f2(a2.cagr)} / ${f2(a2.mdd)} | ${f2(a3.cagr)} / ${f2(a3.mdd)} | ${d(a1)} | ${d(a2)} | ${d(a3)} |`);
    }
    const pathTg = (def: Strat<RtP>, F: boolean): { c: number; t: Map<string, number> }[] => {
      const out: { c: number; t: Map<string, number> }[] = [];
      let held: ReadonlySet<string> = new Set();
      for (const c of sigDays(def, F).filter((x) => x >= cR)) { const t = def.targets(c, held, def.P0, F ? filterMult(c, B5_MA_DAYS) : 1, true); out.push({ c, t }); held = new Set(t.keys()); }
      return out;
    };
    const A = al;
    console.log(`\n=== RT 정보 2. 삼성전자·SK하이닉스: 보유에서 빠진 달(K200P에 있으나 목표에서 빠진 신호월), 그 달 구간(체결일 → 다음 체결일)의 종목 수익률 − 069500, 평균 목표 비중(신호일, 빠진 달 0 포함), 가격 손익 기여 ===`);
    console.log("| 시험 | 종목 | K200P 신호월 | 빠진 달 | 빠진 달 평균 초과(%p/월) | 빠진 달 초과 합(%p) | 빠진 달 종목 복리 % / 069500 복리 % | 평균 목표 비중 % | 보유 달 평균 비중 % | 가격 손익 기여(%p) |\n|---|---|---|---|---|---|---|---|---|---|");
    for (const [nm, def, F, run] of [["RT1", RT1, false, rt1], ["RT1F", RT1, true, rt1f], ["RT2", RT2, false, rt2]] as [string, Strat<RtP>, boolean, RebalRun][]) {
      const pt = pathTg(def, F);
      for (const code of RT_WATCH) {
        const s2 = byCode.get(code) as S, a = A(s2);
        let inK = 0, out = 0, exSum = 0, cS2 = 1, cB = 1, wSum = 0, held = 0, wHeld = 0;
        for (let j = 0; j < pt.length; j++) {
          const { c, t } = pt[j], c2 = j + 1 < pt.length ? pt[j + 1].c : nCal - 2;
          const w = t.get(code) ?? 0;
          wSum += w;
          if (w > 0) { held++; wHeld += w; }
          if (rank200(c).rank.has(code)) {
            inK++;
            if (w === 0) { out++; const e0 = c + 1, e1 = Math.min(c2 + 1, nCal - 1), st = a[e1] / a[e0] - 1, bm = bL[e1] / bL[e0] - 1; exSum += st - bm; cS2 *= 1 + st; cB *= 1 + bm; }
          }
        }
        console.log(`| ${nm} | ${label(code)} | ${inK} | ${out} | ${out ? f2((exSum / out) * 100) : "-"} | ${f2(exSum * 100)} | ${f2((cS2 - 1) * 100)} / ${f2((cB - 1) * 100)} | ${f2((wSum / pt.length) * 100)} | ${held ? f2((wHeld / held) * 100) : "-"} | ${f2(run.contrib.get(code)?.pct ?? 0)} |`);
      }
    }
    console.log(`\n=== RT 정보 3. 평균 보유 종목 수, 신호일 상위 ${RT_TOP_N_WEIGHT}종목 비중 합의 평균(목표 비중 합 대비 %) ===`);
    console.log("| 시험 | 평균 보유 종목 수(일별, 연속 전체) | 신호일 목표 종목 수 평균 | 상위 5종목 비중 합 평균 % | 신호일 최대 단일 비중 평균 % | 가격 손익 기여 상위 5종목 |\n|---|---|---|---|---|---|");
    for (const [nm, def, F, run] of [["RT0", RT0, false, rt0], ["RT1", RT1, false, rt1], ["RT1F", RT1, true, rt1f], ["RT2", RT2, false, rt2]] as [string, Strat<RtP>, boolean, RebalRun][]) {
      const pt = pathTg(def, F);
      let n = 0, top5 = 0, top1 = 0;
      for (const { t } of pt) { const v = [...t.values()].sort((x, y) => y - x), tot = v.reduce((x, y) => x + y, 0); n += v.length; top5 += v.slice(0, RT_TOP_N_WEIGHT).reduce((x, y) => x + y, 0) / tot; top1 += v[0] / tot; }
      const topC = [...run.contrib].sort((x, y) => y[1].pct - x[1].pct).slice(0, 5).map(([code, v]) => `${label(code)} ${f2(v.pct)}`).join(", ");
      console.log(`| ${nm} | ${f2(h.st(run, WR.FULL).avgN)} | ${f2(n / pt.length)} | ${f2((top5 / pt.length) * 100)} | ${f2((top1 / pt.length) * 100)} | ${topC} |`);
    }
    console.log(`\n=== RT 정보 4. 일간 수익률 상관계수(공통 구간 ${WR.FULL.from}~${h.dataEnd}, 정보용) ===`);
    {
      const mkSer = (name: string, dates: string[], ret: number[]): { name: string; m: Map<string, number> } => ({ name, m: new Map(dates.map((d, i2) => [d, ret[i2]])) });
      const ser = [mkSer("069500", h.bhP.dates, h.bhP.ret), mkSer("DS6", b6.res.run.dates, b6.res.run.ret), mkSer("RM1", rm1.dates, rm1.ret), mkSer("RT0", rt0.dates, rt0.ret), mkSer("RT1", rt1.dates, rt1.ret), mkSer("RT1F", rt1f.dates, rt1f.ret), mkSer("RT2", rt2.dates, rt2.ret)];
      const days = rt1.dates.filter((d) => d >= WR.FULL.from && ser.every((x) => x.m.has(d)));
      const corr = (x: Map<string, number>, y: Map<string, number>): number => { const xs = days.map((d) => x.get(d) as number), ys = days.map((d) => y.get(d) as number), n = xs.length, mx = avg(xs), my = avg(ys); let sxy = 0, sxx = 0, syy = 0; for (let i2 = 0; i2 < n; i2++) { sxy += (xs[i2] - mx) * (ys[i2] - my); sxx += (xs[i2] - mx) ** 2; syy += (ys[i2] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
      console.log(`공통 ${days.length}일`);
      console.log(`| | ${ser.map((x) => x.name).join(" | ")} |\n|---|${ser.map(() => "---").join("|")}|`);
      for (const x of ser) console.log(`| ${x.name} | ${ser.map((y) => f2(corr(x.m, y.m))).join(" | ")} |`);
    }
    }
  } else if (MODE === "ds13") {
    const cS13 = startOf(RM1, false), W13 = windowsFor(cS13), from13 = W13.FULL.from;
    if (startOf(MV1, false) !== cS13) throw new Error("RM1과 MV1의 첫 신호일이 다르다");
    for (const [id, kind, ttl] of [["DS13M", "MV1", "코어 40%(DS6 코어) + 모멘텀 위성 30%(RM1) + 저위험 위성 30%(MV1), 매월 하위 계좌 40/30/30 재조정"], ["DS13L", "LV1", "코어 40%(DS6 코어) + 모멘텀 위성 30%(RM1) + 저위험 위성 30%(LV1 = DS6 위성 축소), 매월 하위 계좌 40/30/30 재조정"]] as const) {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(${id}, 시험 ${trial}): 첫 신호일 ${CAL[cS13]}, 수익률 집계 ${from13}~${h.dataEnd} | 구간 ${W13.NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")} | 데이터: ${PRICE_CORRECTION_ON ? "K200P 17건 보정 적용(표준)" : "보정 미적용"}`);
      verdicts.push(evaluate(h, W13, mkD13(id, trial, kind, cS13, W13, ttl)));
    }
    // 같은 보정 데이터 기준 비교표와 구간 2 상세
    const cF = <P,>(def: Strat<P>): SimRun => combine2(sliceSl(coreOf(2, undefined, 1, {}).sl, from13), slFromRun(runS(def, def.P0, cS13, null, { lag: 1, detail: true })), B5_CORE_W, CS_MOVE_COST).run;
    const rm1c = cF(RM1), mv1c = cF(MV1), ds8 = build(DS6D, { smooth: DS8_SMOOTH_WIN }).res.run, dm = (d13Handles.get("DS13M") as ReturnType<typeof d13Of>).base.res.run, dl = (d13Handles.get("DS13L") as ReturnType<typeof d13Of>).base.res.run;
    const cmpRows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [{ nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run }, { nm: "DS8", run: ds8 }, { nm: "RM1C", run: rm1c }, { nm: "MV1C", run: mv1c }, { nm: "DS13M", run: dm }, { nm: "DS13L", run: dl }];
    console.log(`\n=== 같은 데이터(${PRICE_CORRECTION_ON ? "보정 적용" : "보정 미적용"}) 기준 비교표 (CAGR % / MDD %; 같은 구간 ${from13}~; DS6·DS8·RM1C·MV1C는 일별 40:60 재조정, DS13은 월 1회 40/30/30) ===`);
    console.log(`| 구간 | ${cmpRows.map((r) => r.nm).join(" | ")} |\n|---|${cmpRows.map(() => "---").join("|")}|`);
    for (const [nm, w] of W13.ALL) console.log(`| ${nm} | ${cmpRows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    const fl = cmpRows.map((r) => ({ nm: r.nm, s: h.st(r.run, W13.FULL) }));
    console.log(`연 회전율 % / 비용 합계 %: ${fl.map((x) => `${x.nm} ${f2(x.s.turnover)} / ${f2(x.s.cost)}`).join(" | ")}`);
    win2Detail(["DS13M", "DS13L", "RM1C", "MV1C", "DS6", "069500"].map((nm) => ({ name: nm, run: (cmpRows.find((r) => r.nm === nm) as { run: { dates: string[]; ret: number[] } }).run })));  } else if (MODE === "vtest") {
    await loadEqTables();
    requireStart();
        console.log(`저평가 시험 설정: ${V_CASE}, 시작 월말 ${V_START}, 데이터: ${PRICE_CORRECTION_ON ? "K200P 17건 보정 적용" : "보정 미적용"} + ${ZERO_SUSPECT_ON ? `의심 종목-일 0% 처리 ${suspectLog.length}건(보정 후보 A)` : "의심 종목-일 처리 없음"}`);
    const vb1 = mkVB("VB1", VB1_P0, VB1_NB), vb2 = mkVB("VB2", VB2_P0, VB2_NB);
    const ttlV = (nm: string, extra: string): string => `${nm}: ${extra}`;
    const doV = (def: Strat<VbP>, id: string, kind: "S" | "C", title: string): void => {
      const cS = startOf(def, false), Wx = windowsV(cS), trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(${id}, 시험 ${trial}): 첫 신호일 ${CAL[cS]}, 수익률 집계 ${Wx.FULL.from}~${h.dataEnd} | 구간 ${Wx.NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
      verdicts.push(evaluate(h, Wx, kind === "S" ? mkS(def, id, trial, false, cS, Wx, title) : mkC(def, id, trial, cS, Wx, title)));
    };
    doV(vb1, "VB1", "S", ttlV("VB1", "BS1 적격 유니버스 중 PBR(시총 ÷ 자본총계) 하위 30종목 동일 비중, 기존 보유는 하위 90위 안이면 유지, 월말 신호"));
    doV(vb2, "VB2", "S", ttlV("VB2", "VB1과 같되 점수 = BS1 점수와 PBR 백분위의 1:1 평균, 하위 30종목"));
    doV(vb1, "VB1C", "C", ttlV("VB1C", "DS6 코어 40% + 위성 60% = VB1"));
    // ---- 정보용 보고 ----
    const cS1 = startOf(vb1, false), Wv = windowsV(cS1);
    console.log(`\n=== 정보용: 제외 종목-월 비율(BS1 적격 종목 중 PBR 없음; 정정 전 원본이 없어 정정된 보고서는 정정 접수일 전에 자료 없음), 자본잠식, VB1 보유 종목 평균 PBR·시장 비중 ===`);
    let nEl = 0, nNo = 0, nStale = 0, nNeg = 0, nOk = 0;
    const kp = { KOSPI: 0, KOSDAQ: 0, 기타: 0 };
    let pbrSum = 0, pbrN = 0;
    for (const { c, t } of pathTgG(vb1, cS1)) {
      const d = CAL[c], m = membAt(d);
      for (const code of bsElig(c, B5_BS_P0)) { const x = pbrAt(c, h.byCode.get(code) as S, 400); nEl++; if (x.why === "ok") nOk++; else if (x.why === "no_report") nNo++; else if (x.why === "stale") nStale++; else if (x.why === "neg") nNeg++; }
      for (const code of t.keys()) { const mk = m?.get(code); if (mk === "KOSPI") kp.KOSPI++; else if (mk === "KOSDAQ") kp.KOSDAQ++; else kp.기타++; const x = pbrAt(c, h.byCode.get(code) as S, 400); if (x.why === "ok") { pbrSum += x.pbr; pbrN++; } }
    }
    console.log(`BS1 적격 종목-월 ${nEl}개 중 PBR 있음 ${nOk}(${f2((nOk / nEl) * 100)}%) · 제외 ${nEl - nOk}(${f2(((nEl - nOk) / nEl) * 100)}%): 보고서 없음 ${nNo}(${f2((nNo / nEl) * 100)}%) · 경과 ${VB1_P0.maxAge}일 초과 ${nStale}(${f2((nStale / nEl) * 100)}%) · 자본 ≤ 0(자본잠식) ${nNeg}(${f2((nNeg / nEl) * 100)}%)`);
    console.log(`VB1 월말 목표 보유(근사: 이전 목표 = 보유) 평균 PBR ${f2(pbrSum / Math.max(pbrN, 1))} | 시장 비중 KOSPI ${f2((kp.KOSPI / Math.max(kp.KOSPI + kp.KOSDAQ + kp.기타, 1)) * 100)}% / KOSDAQ ${f2((kp.KOSDAQ / Math.max(kp.KOSPI + kp.KOSDAQ + kp.기타, 1)) * 100)}% / 기타 ${f2((kp.기타 / Math.max(kp.KOSPI + kp.KOSDAQ + kp.기타, 1)) * 100)}% | 관리종목 비율: 과거 이력 자료가 없어 계산하지 않음(사전등록 한계)`);
    const vbaDef: Strat<VbP> = { ...vb1, id: "VBA", targets: (c, _held, P, m) => { const l = vbSorted(c, P); return equalW(l, 1 / Math.max(l.length, 1), m); } };
    const vba = runS(vbaDef, VB1_P0, cS1, null, { lag: 1, detail: true });
    console.log(`\n전 종목 동일 비중(같은 유니버스: BS1 적격 ∧ PBR 있음, 월말 재조정) 대비 — CAGR % / MDD %\n| 구간 | VB1 | 전 종목 동일 비중 | VB1 − 전 종목 CAGR %p |\n|---|---|---|---|`);
    const vb1Run = verdicts.find((v) => v.id === "VB1")?.run;
    for (const [nm, w] of Wv.ALL) { const a = vb1Run ? h.st(vb1Run, w) : null, b = h.st(vba, w); console.log(`| ${nm} | ${a ? `${f2(a.cagr)} / ${f2(a.mdd)}` : "-"} | ${f2(b.cagr)} / ${f2(b.mdd)} | ${a ? sg(a.cagr - b.cagr) : "-"} |`); }
  }
  summaryReport(verdicts, trialNums, { prior: Number(process.env.B5_TRIAL ?? "294") - 1, contamNote: "경고(오염): 2011~2026은 선행 연구에서 반복해 본 데이터다. 변형(F·C 형태)은 DS6·DS7·DS10 결과를 본 뒤 만든 것(선택 편향)이라 순수 검증이 아니다." });
  if (PRICE_CORRECTION_ON) console.log("※ 보정 재채점: 아래 누적 시험 횟수·기대 건수는 원 시험 번호 기준 표기이며 이 재채점은 누적 시험 308에 더하지 않는다(사용자 지정).");
  console.log(`사전 고지: 이 묶음 누적 시험 ${Number(process.env.B5_TRIAL ?? "294") - 1 + trialNums.length}회 기준 우연 통과 기대 ${((Number(process.env.B5_TRIAL ?? "294") - 1 + trialNums.length) * 0.05).toFixed(2)}건(근사). 통과 후보가 있어도 독립 확인 전에는 후보일 뿐이다. 정의는 첫 시험 전에 고정했고 결과를 보고 바꾸지 않았다.`);
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ") || "없음"} | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험 번호 ${trialNums.join(",")}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

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
import { DS13_W, DS13_NB_W, DS13_NB_RM_N, DS13_WIN2, DS13_WATCH, type Alloc3 } from "@/lib/ds13Config";
import { RT1_P0, RT2_P0, RT1_NB, RT2_NB, RT_BASELINE_MAX_GAP_PP, RT_WATCH, RT_TOP_N_WEIGHT, type RtP } from "@/lib/rt1Config";
import { DQ_LIMIT_CHANGE_DATE, DQ_LIMIT_BEFORE, DQ_LIMIT_AFTER, DQ_LIMIT_TOL, DQ_LISTING_MAX_ROW, DQ_RESUME_MIN_GAP, DQ_LIQUIDATION_ROWS, DQ_MCAP_DIFF_FRAC, DQ_VANISH_WINDOW_DAYS, DQ_VANISH_HALT_DAYS, DQ_VANISH_MIN_CLOSE, DQ_ALT_LAST_ROWS, DQ_ALT_LAST_RETURN, DQ_RECENT_VANISH_DAYS, DQ_LIST_MAX, DQ_RECOVER_ROWS, DQ_RECOVER_TOL } from "@/lib/dataQualityConfig";
import { solveMinVar, projectCappedSimplex } from "@/lib/minVar";
import { B5_F_DENOMINATOR, B5_CORE_W, B5_MA_DAYS, B5_MA_NB, B5_RM_P0, B5_LR_P0, B5_LR_NB, B5_PF_P0, B5_PF_NB, B5_PF_SLIP, B5_PF_TV_DAYS, B5_TS_P0, B5_TS_NB, B5_TS_CAP, B5_MV_P0, B5_MV_NB, B5_MV_KKT_TOL, B5_MV_MAX_ITER, B5_MV_CHECK_SAMPLES, B5_BS_P0, B5_BS_NB, B5_BS_SLIP_K200, B5_BS_SLIP_OTHER, type RmP, type LrP, type PfP, type TsP, type MvP, type BsP, B5_FILTER_LOW } from "@/lib/batch5Config";
import { capWeights } from "@/lib/coreCapWeights";
import { DS89_DS6_REF, DS8_SMOOTH_WIN, DS89_CORE_W } from "@/lib/ds89Config";
import { CS_MOVE_COST } from "@/lib/coreSatelliteConfig";
import { makeDs13Engine, type Sl, type CoreRun, type Strat, type FCfg } from "@/lib/ds13Engine";
import { downloadBuf, decodeTable } from "@/lib/nBookStore";
import { cachedBytes } from "@/lib/researchFileCache";
import { intradayInspect } from "./intradayInspect";
import { intradayStats } from "./intradayStats";
import { intradayPre, intradayTest } from "./intradayTest";
import { makeRoeIndex, preRowToRep, type FinRep, type RoeOut, type RoeWhy } from "@/lib/qualityRoe";
import { R_STORE_PREFIX } from "@/lib/kodexSectorSatConfig";
import { selectAll } from "./researchHarness";
import { ZERO_SUSPECT_ON, suspectLog, zeroSuspects } from "./researchHarness";
import { VB1_P0, VB2_P0, VB1_NB, VB2_NB, VB_FIRST_TRIAL, VB_PRIOR_TESTS, VB_F_DENOMINATOR, VB_COVERAGE_MIN, VB_C2_START, VB_C2_WINDOW1_TO, VB_C2_WINDOW2_FROM, VB_EQ_AGE_NB, type VbP } from "@/lib/valueConfig";
import { V2_W, V2_NB_W, V2_F_DENOMINATOR, V2_START, V2_WATCH, V2_LOSS_FROM } from "@/lib/value2Config";
import { V3_F_DENOMINATOR, V3_TOP_N, V3_MDD_WINDOW, V3_TERCILES, V3_WATCH, VL1_P0, VL1_NB, type VlP, type VlUniv } from "@/lib/value3Config";
import { VEQ_DATA_FILE, VEQ_DATA_CACHE_NAME } from "@/lib/valueEquityConfig";
import { VS_F_DENOMINATOR, VS_START, VS_REF, VB1S_P0, VB1S_NB, type VbsP } from "@/lib/vbStopConfig";
import { CM_F_DENOMINATOR, CM_START, CM_REF, CM1_P0, CM1S_P0, CM1_NB, CM1S_NB, type CmP } from "@/lib/compositeConfig";
import { EG_F_DENOMINATOR, EG_LAG_MONTHS, EG_COVERAGE_MIN, EG_START, EG_REF, EG1_P0, EGM1_P0, EG_NB, type EgP } from "@/lib/roeChgConfig";
import { RV_F_DENOMINATOR, RV_MIN_VALID_FRAC, RV_REF, RV1_P0, RV1_NB, type RvP } from "@/lib/rm1vConfig";
import { DS15_F_DENOMINATOR, DS15_NB_W, DS15_REF } from "@/lib/ds15Config";
import { DIV_DATA_FILE } from "@/lib/dividendConfig";
import { DV_F_DENOMINATOR, DV_FIRST_TRIAL, DV_PRIOR_TESTS, DV1_P0, DV_NB, DV_COVERAGE_MIN, DV1C_W, DV_WIN1_TO, DV_WIN2_FROM, DV_DS6_REF, DV_RECALC_N, DV_START, DV_HIST_YEARS, type DvP } from "@/lib/dividendTestConfig";
import { S_F_DENOMINATOR, S_NEXT_MONTH_DAYS, S_REF, RM1S_P0, RM1S_NB, type RmsP } from "@/lib/stopConfig";
import { E_F_DENOMINATOR, E_PLANNED_START, EY1_P0, EY1_NB, type EyP } from "@/lib/eyConfig";
import { M_F_DENOMINATOR, M_REF_CAPW, M_REF_CAPW_USER, TC1_P0, TC1_NB, TC2_P0, TC2_NB, type TcP } from "@/lib/megacapConfig";
import { H_F_DENOMINATOR, HM1_P0, HM1_NB, type HmP } from "@/lib/high52Config";
import { Q_FIRST_TRIAL, Q_PRIOR_TESTS, Q_F_DENOMINATOR, Q1_P0, QV1_P0, Q1_NB, QV1_NB, Q_PLANNED_START, Q_FIN_KSIC, type QP } from "@/lib/qualityConfig";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, mulberry32, SNAP_END, f2, avg, median, PRICE_CORRECTION_ON, NEUTRALIZE_ON, type S, type Win } from "./researchHarness";
import { evaluate, summaryReport, type CandSpec, type Verdict, type Windows } from "./researchGates";


const T0 = Date.now();
const sha = (b: Uint8Array | Buffer | string): string => createHash("sha256").update(b).digest("hex");
/** 공통 평가 시작 이후로 자른 일별 계열(구성요소 하나의 계좌 기준). */

async function main(): Promise<void> {
  const MODE = (process.env.ALLOC_MODE ?? "").trim().toLowerCase();
  if (!["repro", "a", "b1", "b2", "b3", "b4", "c", "info", "bsv", "dq", "rtpre", "rt", "kcorr", "kcov", "ds13pre", "ds13", "ds13ex", "ds13rob", "vdata", "vcov", "vpre", "vinfo", "vtest", "v2pre", "v2info", "v2test", "v3pre", "v3info", "v3test", "mininsp", "mininsp2", "intpre", "inttest", "qdata", "qpre", "qinfo", "qtest", "hpre", "htest", "hinfo", "mpre", "mtest", "minfo", "epre", "etest", "einfo", "spre", "stest", "sinfo", "sinfo2", "vbspre", "vbstest", "vbsinfo", "vbsinfo2", "cmpre", "cmtest", "cminfo", "cminfo2", "egcov", "egpre", "egtest", "eginfo", "eginfo2", "rvpre", "rvtest", "rvinfo", "rvinfo2", "ds15pre", "ds15test", "ds15info", "ds15info2", "dvcov", "dvraw", "dvpre", "dvtest", "dvinfo", "dvinfo2"].includes(MODE)) throw new Error("ALLOC_MODE=repro|a|b1|b2|b3|b4|c|info|bsv|dq|rtpre|rt|kcorr|kcov|ds13pre|ds13|ds13ex|ds13rob|vdata|vcov|vpre|vinfo|vtest|v2pre|v2info|v2test|v3pre|v3info|v3test|mininsp|mininsp2|intpre|inttest|qdata 필요");
  const IDS = (process.env.B5_IDS ?? "").trim() ? new Set((process.env.B5_IDS as string).split(",").map((x) => x.trim())) : null;
  if (NEUTRALIZE_ON) console.log(`*** 정보용 중립화 모드(NEUTRALIZE_CODES=${process.env.NEUTRALIZE_CODES}): 해당 종목의 수정 수익률을 전 기간 0으로 둔다(시험 아님) ***`);
  if (PRICE_CORRECTION_ON && MODE !== "ds13pre" && MODE !== "ds13" && MODE !== "ds13ex" && MODE !== "ds13rob" && MODE !== "vdata" && MODE !== "vcov" && MODE !== "vpre" && MODE !== "vinfo" && MODE !== "vtest" && !/^v[23]/.test(MODE) && !(/^(q|h|m|e|s)(pre|info|test)$/.test(MODE) || /^(vbs|cm|eg|rv|ds15|dv)(pre|info|test)$/.test(MODE)) && !((MODE === "minfo" || MODE === "sinfo" || MODE === "vbsinfo" || MODE === "cminfo" || MODE === "rvinfo" || MODE === "ds15info" || MODE === "dvinfo") && NEUTRALIZE_ON)) console.log(`*** 보정 재채점 모드(PRICE_CORRECTION=k200p17): 정의·관문·이웃값·난수 시드는 그대로, 가격 입력만 보정. 시험 번호는 원 시험 번호 표지이며 누적 시험 횟수에 더하지 않는다. 대상 ID: ${IDS ? [...IDS].join(",") : "전체"} ***`);
  console.log(`연구 묶음 5 ${MODE === "repro" ? "사전 점검(DS6 재현·신호 독립 대조·체결 타이밍, 성과 미계산)" : `블록 ${MODE} 시험`} 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const k200pInfo = await loadK200P(h);
  const { excluded, membAt, nameOf, indOf } = k200pInfo;
  if (ZERO_SUSPECT_ON) zeroSuspects(h, excluded);
  const E = makeDs13Engine(h, k200pInfo);
  const { cPE, NW, FULL, W, env, label, randLV1, mcapNear, lv1Of, zeroSl, coreOf, coreReplSet, combineCS, DS6D, build, rank200, al, nRows, rowAt, bL, filterMult, retFill, medianOf, sdOf, monthEndIdx, isQuarterEnd, pickKeep, equalW, rmSorted, rmScore, RM1, mvCov, mvStats, MV1, sigDays, startOf, runS, sliceSl, slFromRun, combine2, combineN, d13Of, mkRMS, rmsLog, rm1scOf, makeStopper } = E;

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
      id, trial, title, defense: false, capFrac: def.wOf(P0), fDenominator: MODE === "vtest" ? VB_F_DENOMINATOR : MODE === "v2test" ? V2_F_DENOMINATOR : MODE === "v3test" ? V3_F_DENOMINATOR : MODE === "qtest" ? Q_F_DENOMINATOR : MODE === "htest" ? H_F_DENOMINATOR : MODE === "mtest" ? M_F_DENOMINATOR : MODE === "etest" ? E_F_DENOMINATOR : MODE === "stest" ? S_F_DENOMINATOR : MODE === "vbstest" ? VS_F_DENOMINATOR : MODE === "cmtest" ? CM_F_DENOMINATOR : MODE === "egtest" ? EG_F_DENOMINATOR : MODE === "rvtest" ? RV_F_DENOMINATOR : MODE === "dvtest" ? DV_F_DENOMINATOR : B5_F_DENOMINATOR, ref: { id: "069500", run: bhAll },
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
  const mkC = <P,>(def: Strat<P>, id: string, trial: number, cS: number, Wx: Windows, title: string, monthlySig?: ReadonlySet<string>): CandSpec => {
    const P0 = def.P0, from = Wx.FULL.from, wC = B5_CORE_W;
    /** 코어-위성 합성: monthlySig가 있으면 그 날짜 종가에 목표 금액을 계산해 다음 거래일 종가에 옮기는 월 리밸런스(combineN), 없으면 기존 일별 40:60 재조정(combine2). */
    const comb = (core: Sl, sat: Sl): { run: SimRun; moved: number[] } => (monthlySig ? combineN([core, sat], [wC, 1 - wC], CS_MOVE_COST, monthlySig) : combine2(core, sat, wC, CS_MOVE_COST));
    const coreSlOf = (lag: number, repl?: Set<string>): { run: CoreRun; sl: Sl } => { const x = coreOf(2, undefined, lag, { repl }); return { run: x.run, sl: sliceSl(x.sl, from) }; };
    const baseSat = runS(def, P0, cS, null, { lag: 1, detail: true });
    const hold = holdSamplesOf(def, false, cS, baseSat);
    const satOrders = new Map<number, number>();
    for (const c of baseSat.entryCs) satOrders.set(c - 1, (satOrders.get(c - 1) ?? 0) + 1);
    const build = (P: P, o: { lag: number; replSat?: boolean; replCore?: boolean }): { res: { run: SimRun; moved: number[] }; sat: RebalRun; core: CoreRun } => {
      const sat = runS(def, P, cS, null, { lag: o.lag, detail: true, replace: o.replSat ? topRepl(baseSat, from) : undefined });
      const cx = o.replCore ? coreSlOf(1, coreReplSet(coreOf(2, undefined, 1).run)) : coreSlOf(o.lag);
      return { res: comb(cx.sl, slFromRun(sat)), sat, core: cx.run };
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
      id, trial, title, defense: false, capFrac: def.wOf(P0), fDenominator: MODE === "vtest" ? VB_F_DENOMINATOR : MODE === "v2test" ? V2_F_DENOMINATOR : MODE === "v3test" ? V3_F_DENOMINATOR : MODE === "qtest" ? Q_F_DENOMINATOR : MODE === "htest" ? H_F_DENOMINATOR : MODE === "mtest" ? M_F_DENOMINATOR : MODE === "etest" ? E_F_DENOMINATOR : MODE === "stest" ? S_F_DENOMINATOR : MODE === "vbstest" ? VS_F_DENOMINATOR : MODE === "cmtest" ? CM_F_DENOMINATOR : MODE === "egtest" ? EG_F_DENOMINATOR : MODE === "rvtest" ? RV_F_DENOMINATOR : MODE === "dvtest" ? DV_F_DENOMINATOR : B5_F_DENOMINATOR, ref: { id: "069500", run: bhAll },
      hRule: (full, rb) => { const a = hVs(full, rb); return { ok: a.ok, note: `[사전등록: 069500만 판정] 069500 ${f2(rb.cagr)} / ${f2(rb.mdd)} → ${a.ok ? "O" : "X"} (${a.text})` }; },
      run: (o) => (o.replace ? merge(build(P0, { lag: 1, replSat: true })) : merge(build(P0, { lag: o.lag }))),
      neighbors: nbs,
      random: (rng) => comb(coreSlOf(1).sl, slFromRun(randomS(def, P0, cS, null, rng, satOrders, hold))).run,
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
      id, trial, title, defense: false, capFrac: 0.015, fDenominator: MODE === "vtest" ? VB_F_DENOMINATOR : MODE === "v2test" ? V2_F_DENOMINATOR : MODE === "v3test" ? V3_F_DENOMINATOR : MODE === "qtest" ? Q_F_DENOMINATOR : MODE === "htest" ? H_F_DENOMINATOR : MODE === "mtest" ? M_F_DENOMINATOR : MODE === "etest" ? E_F_DENOMINATOR : MODE === "stest" ? S_F_DENOMINATOR : MODE === "vbstest" ? VS_F_DENOMINATOR : MODE === "cmtest" ? CM_F_DENOMINATOR : MODE === "egtest" ? EG_F_DENOMINATOR : MODE === "rvtest" ? RV_F_DENOMINATOR : MODE === "dvtest" ? DV_F_DENOMINATOR : B5_F_DENOMINATOR, ref: { id: "069500", run: bhAll },
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
  // DS15L(339)·DS15M(340): 사전등록 docs/research/ds15-prereg.md, 기준값 lib/ds15Config.ts — DS13의 모멘텀 위성(RM1)만 RM1S(329와 같은 손절 구현)로 바꾼 3계좌 월 재조정
  // =====================================================================================================================
  const d15Of = (kind: "MV1" | "LV1", cS: number, Wx: Windows, shift = 0) => {
    const from = Wx.FULL.from, W0 = DS13_W;
    // shift > 0은 정보용 견고성 점검: 첫 신호일(cS) 뒤의 월 신호일(RM1S·MV1 신호, 하위 계좌 간 재조정 신호)만 마지막 거래일에서 shift 거래일 앞당긴다(DS13과 같은 방식).
    const MV1x = shift === 0 ? MV1 : { ...MV1, signalDays: MV1.signalDays.map((c) => (c > cS ? c - shift : c)) };
    const rms = mkRMS("RM1S", RM1S_P0, RM1S_NB, { shift });
    const sigSet = new Set(monthEndIdx.filter((c) => c > cS).map((c) => CAL[c - shift]));
    const coreSlOf = (lag: number): { run: CoreRun; sl: Sl } => { const x = coreOf(2, undefined, lag, {}); return { run: x.run, sl: sliceSl(x.sl, from) }; };
    const lowOf = (lag: number, repl?: Set<string>): { run: SimRun; sl: Sl } => {
      if (kind === "MV1") { const r = runS(MV1x, MV1.P0, cS, null, { lag, detail: true, replace: repl }); return { run: r, sl: slFromRun(r) }; }
      const x = lv1Of(lag, undefined, repl);
      return { run: x.run, sl: sliceSl(x.sl, from) };
    };
    const build = (o: { w?: Alloc3; stopP?: Partial<RmsP>; lag: number; repl?: { rm: Set<string>; low: Set<string> } }) => {
      const rm = runS(rms, { ...RM1S_P0, ...o.stopP }, cS, null, { lag: o.lag, detail: true, replace: o.repl?.rm }), lo = lowOf(o.lag, o.repl?.low), cx = coreSlOf(o.lag);
      const sls = [cx.sl, slFromRun(rm), lo.sl];
      return { res: combineN(sls, o.w ?? W0, CS_MOVE_COST, sigSet), rm, low: lo.run, core: cx.run, sls, nStops: rmsLog.length };
    };
    type D15Parts = ReturnType<typeof build>;
    const merge = (b: D15Parts, w: Alloc3 = W0): SimRun => {
      const r: SimRun = { ...b.res.run };
      r.trades = [...b.rm.trades.map((t) => ({ ...t, vAtEntry: t.vAtEntry / w[1] })), ...b.low.trades.map((t) => ({ ...t, vAtEntry: t.vAtEntry / w[2] })), ...b.core.trades.map((t) => ({ ...t, vAtEntry: t.vAtEntry / w[0] }))];
      r.entryCs = [...b.rm.entryCs, ...b.low.entryCs, ...b.core.entryCs];
      r.haltSkip = b.rm.haltSkip + b.low.haltSkip + b.core.haltSkip; r.exitDefer = b.rm.exitDefer + b.low.exitDefer + b.core.exitDefer;
      return r;
    };
    const base = build({ lag: 1 }), stopsBase = [...rmsLog];
    return { from, W0, sigSet, coreSlOf, lowOf, build, merge, base, rms, stopsBase };
  };
  const mkD15 = (id: string, trial: number, kind: "MV1" | "LV1", cS: number, Wx: Windows, title: string): CandSpec => {
    const d = d15Of(kind, cS, Wx), { from, W0, sigSet, rms } = d;
    const baseRm = d.base.rm, baseLow = d.base.low;
    if (baseRm.dates[0] !== from || d.base.res.run.dates[0] !== from) throw new Error(`${id}: 하위 계좌 시작일이 ${from}과 다르다`);
    const rmHold = holdSamplesOf(rms, false, cS, baseRm), rmOrders = new Map<number, number>();
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
      ...RM1S_NB.map(([lb, ch]) => ({ label: lb, run: () => d.merge(d.build({ stopP: ch, lag: 1 })) })),
      ...DS15_NB_W.map(([lb, w]) => ({ label: lb, run: () => d.merge(d.build({ w, lag: 1 }), w) })),
    ];
    let kLv = 0;
    return {
      id, trial, title, defense: false, capFrac: 0.015, fDenominator: DS15_F_DENOMINATOR, ref: { id: "069500", run: bhAll },
      hRule: (full, rb) => { const a = hVs(full, rb); return { ok: a.ok, note: `[사전등록: 069500만 판정] 069500 ${f2(rb.cagr)} / ${f2(rb.mdd)} → ${a.ok ? "O" : "X"} (${a.text})` }; },
      run: (o) => (o.replace ? d.merge(d.build({ lag: 1, repl: topRepl2() })) : d.merge(d.build({ lag: o.lag }))),
      neighbors: nbs,
      random: (rng) => {
        const rmR = randomS(rms, RM1S_P0, cS, null, rng, rmOrders, rmHold);
        let lowSl: Sl;
        if (kind === "MV1") lowSl = slFromRun(randomS(MV1, MV1.P0, cS, null, rng, lowOrders, lowHold));
        else { const dr = randOf(undefined), x = dr[kLv++ % dr.length]; lowSl = sliceSl({ ...zeroSl, ret: Array.from(x.full.subarray(x.k0)) }, from); }
        return combineN([coreFixed, slFromRun(rmR), lowSl], W0, CS_MOVE_COST, sigSet).run;
      },
      reasons: ["순위 밖", "목표 0", "폐지", "폐지(전액 손실)"], label,
      extra: (run) => {
        gateNotes(id, trial, nbs.length);
        console.log(`${id} 게이트 E 해석(사전등록): 두 위성(RM1S + 저위험)의 닫힌 거래 중 계좌 기준 손익 상위 3개를 069500 수익률로 바꾸고 코어는 실제 그대로 돌린 연속 전체 CAGR ≥ 069500. F: 위성별 무작위 대조(모멘텀: 손절 없는 RM1S 진입 건수·보유 분포 무작위, 저위험: ${kind === "MV1" ? "MV1 무작위" : "LV1 기존 무작위 같은 번호 표본"})를 실제 코어와 40/30/30으로 합성, 시드 20261022 1,000회, 백분위 ≥ 95(참고선 97.50). G: 코어 + 두 위성 진입 합. 손절 발동(기본 −20%) ${d.stopsBase.length}건.`);
        const b = d.base, contrib = new Map<string, { pct: number; days: number }>();
        for (const [code, v] of baseRm.contrib) contrib.set(code, { pct: v.pct * W0[1], days: v.days });
        if (kind === "MV1") for (const [code, v] of (baseLow as RebalRun).contrib) { const o = contrib.get(code); contrib.set(code, { pct: (o?.pct ?? 0) + v.pct * W0[2], days: (o?.days ?? 0) + v.days }); }
        reportCommon({ id, trial, cS, Wx, sleeveW: 1, contrib, trades: [...baseRm.trades, ...baseLow.trades], open: [...baseRm.open, ...((baseLow as RebalRun).open ?? [])], extraLines: (r) => ds6GateLine(id, Wx, r) }, run);
        const names = ["코어(DS6 코어)", "모멘텀 위성(RM1S)", `저위험 위성(${D13_KIND_LABEL[kind]})`];
        const win = (a: string, z: string): number[] => names.map((_, j) => b.res.run.dates.reduce((acc, dd, i) => (dd >= a && dd <= z ? acc + b.res.contribDaily[j][i] : acc), 0));
        const yrs = Math.max((Date.parse(h.dataEnd) - Date.parse(from)) / 86_400_000 / 365.25, 1e-9);
        const fullC = win(from, h.dataEnd), totC = fullC.reduce((x, y) => x + y, 0);
        console.log(`\n${id} 손익 분해(하위 계좌 비중 × 일별 수익률의 단순 합 %p; 비용은 각 하위 계좌 수익률에 이미 반영, 재조정 비용 별도)`);
        console.log("| 하위 계좌 | 연속 전체 기여 %p (비중) | 평균 비중(종가, 이동 후) % | 단독(같은 구간) CAGR / MDD |\n|---|---|---|---|");
        names.forEach((nm, j) => console.log(`| ${nm} | ${f2(fullC[j])} (${f2(totC ? (fullC[j] / totC) * 100 : 0)}%) | ${f2(avg(b.res.wEnd.map((w) => w[j])) * 100)} | ${cellS(b.sls[j], Wx.FULL)} |`));
        console.log(`재조정(월 1회) 이동 금액 연 ${f2(b.res.moved.reduce((x, y) => x + y, 0) * 100 / yrs)}%(계좌 대비), 이동 비용 합계 ${f2(b.res.cost.reduce((x, y) => x + y, 0) * 100)}%p(연 ${f2(b.res.cost.reduce((x, y) => x + y, 0) * 100 / yrs)}%p) | 하위 계좌 비중이 목표에서 벗어난 정도(종가 기준 최대 이탈 %p): ${names.map((nm, j) => `${nm.split("(")[0]} ${f2(Math.max(...b.res.wEnd.map((w) => Math.abs(w[j] - W0[j]))) * 100)}`).join(", ")}`);
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
    if (!ok && (MODE === "vpre" || MODE === "vtest" || MODE === "vinfo" || /^v[23]/.test(MODE) || (/^(q|h|m|e|s)(pre|info|test)$/.test(MODE) || /^(vbs|cm|eg|rv|ds15|dv)(pre|info|test)$/.test(MODE)) && !((MODE === "minfo" || MODE === "sinfo" || MODE === "vbsinfo" || MODE === "cminfo" || MODE === "rvinfo" || MODE === "ds15info" || MODE === "dvinfo") && NEUTRALIZE_ON) || (!PRICE_CORRECTION_ON && !NEUTRALIZE_ON))) throw new Error("DS6 기록과 다르다 — 시험을 시작하지 않고 중단해 보고한다");
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
      id, trial, title: `${id}: K200P 종목이 252거래일 신고가(직전 251거래일 종가 최댓값 초과)를 내면 다음 거래일 종가에 평가액의 5% 매수(슬롯 20), 종가가 진입 후 최고 종가의 75% 이하이면 청산`, defense: false, capFrac: B5_TS_CAP, fDenominator: MODE === "vtest" ? VB_F_DENOMINATOR : MODE === "v2test" ? V2_F_DENOMINATOR : MODE === "v3test" ? V3_F_DENOMINATOR : MODE === "qtest" ? Q_F_DENOMINATOR : MODE === "htest" ? H_F_DENOMINATOR : MODE === "mtest" ? M_F_DENOMINATOR : MODE === "etest" ? E_F_DENOMINATOR : MODE === "stest" ? S_F_DENOMINATOR : MODE === "vbstest" ? VS_F_DENOMINATOR : MODE === "cmtest" ? CM_F_DENOMINATOR : MODE === "egtest" ? EG_F_DENOMINATOR : MODE === "rvtest" ? RV_F_DENOMINATOR : MODE === "dvtest" ? DV_F_DENOMINATOR : B5_F_DENOMINATOR, ref: { id: "069500", run: bhAll },
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
    const finBuf = await cachedBytes(`${R_STORE_PREFIX}/fin.parquet`, () => downloadBuf(`${R_STORE_PREFIX}/fin.parquet`));
    if (!finBuf) throw new Error("research/r_allcap/fin.parquet이 없다 — 중단");
    for (const r of await decodeTable(finBuf)) { const eq = typeof r.eq_c === "number" && Number.isFinite(r.eq_c) ? r.eq_c : null; if (eq === null) continue; push(String(r.stock_code), isoD(r.rcept_dt), eq, String(r.fs_div) === "CFS"); eqSrc.r++; }
    const pre = await cachedBytes(VEQ_DATA_CACHE_NAME, () => downloadBuf(VEQ_DATA_FILE));
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
  const V_START = (process.env.V_START ?? "").trim(), V_CASE = V_START >= VB_C2_START || process.env.V_FORCE_C2 === "1" ? "C2" : "C1"; // 시작 월말이 2016-05-31 이후면 C-2 규칙(두 구간), 이전이면 C-1(기존 3구간)
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
  const mkVB1F = (): Strat<VbP> => ({ ...mkVB("VB1", VB1_P0, VB1_NB), id: "VB1F", nbs: [] });
  // =====================================================================================================================
  // 저PBR 대형주 VL1(316)·VL1C(317): VB1 정의 + 유니버스를 신호일 K200P(PIT) ∩ BS1 적격(이웃값: 시총 상위 300)으로 제한
  // =====================================================================================================================
  const vlMemo = new Map<string, string[]>();
  /** 유니버스 후보(PBR 확인 전): k200p = BS1 적격 ∩ 신호일 K200P(PIT), top300 = BS1 적격 중 신호일 시총 상위 V3_TOP_N. */
  const vlPool = (c: number, univ: VlUniv): string[] => {
    const el = bsElig(c, B5_BS_P0);
    if (univ === "k200p") { const k = rank200(c).rank; return el.filter((code) => k.has(code)); }
    return el.map((code) => ({ code, mc: mcAt(h.byCode.get(code) as S, c) })).sort((a, b) => b.mc - a.mc || (a.code < b.code ? -1 : 1)).slice(0, V3_TOP_N).map((x) => x.code);
  };
  /** 유니버스 ∩ PBR 있음을 PBR 오름차순(같으면 종목코드 순)으로. */
  const vlSorted = (c: number, P: VlP): string[] => {
    const key = `${c}|${P.univ}|${P.maxAge}`, hit = vlMemo.get(key);
    if (hit) return hit;
    const list: { code: string; pbr: number }[] = [];
    for (const code of vlPool(c, P.univ)) { const x = pbrAt(c, h.byCode.get(code) as S, P.maxAge); if (x.why === "ok") list.push({ code, pbr: x.pbr }); }
    const out = list.sort((a, b) => a.pbr - b.pbr || (a.code < b.code ? -1 : 1)).map((x) => x.code);
    vlMemo.set(key, out);
    return out;
  };
  const mkVL = (id: string, P0: VlP, nbs: [string, Partial<VlP>][]): Strat<VlP> => ({
    id, P0, nbs, signalDays: monthEndIdx.filter((c) => c >= cStartV), isSwap: () => true,
    targets: (c, held, P, m) => equalW(pickKeep(vlSorted(c, P), held, P.n, P.n * P.keepMult), 1 / P.n, m),
    pool: (c, P) => vlSorted(c, P),
    slip: (code, c, lag) => (rank200(Math.max(c - lag, 0)).rank.has(code) ? B5_BS_SLIP_K200 : B5_BS_SLIP_OTHER), vanish: "rule", vanishLoss: vbVanishLoss, wOf: (P) => 1 / P.n,
  });
  // =====================================================================================================================
  // 재무 품질(ROE) Q1(320)·QV1(321)·QV1C(322): ROE 정의는 lib/qualityRoe.ts(고정), 사전등록 docs/research/quality-prereg.md
  // =====================================================================================================================
  const loadRoeReps = async (): Promise<{ fin: Record<string, unknown>[]; pre: Record<string, unknown>[]; repsR: FinRep[]; repsPre: FinRep[] }> => {
    const isoD = (d: unknown): string => { const x = String(d ?? ""); return /^\d{8}$/.test(x) ? `${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6)}` : x.slice(0, 10); };
    const nn = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const finBuf = await cachedBytes(`${R_STORE_PREFIX}/fin.parquet`, () => downloadBuf(`${R_STORE_PREFIX}/fin.parquet`)), preBuf = await cachedBytes(VEQ_DATA_CACHE_NAME, () => downloadBuf(VEQ_DATA_FILE));
    if (!finBuf || !preBuf) throw new Error("재무 파일이 없다 — 중단");
    const fin = await decodeTable(finBuf), pre = await decodeTable(preBuf);
    const repsR: FinRep[] = fin.map((r) => ({ code: String(r.stock_code), year: Number(r.bsns_year), rc: String(r.reprt_code), fs: String(r.fs_div), rcept: isoD(r.rcept_dt), rceptNo: String(r.rcept_no), status: String(r.status), niC: nn(r.ni_c), niA: nn(r.ni_a), niP: nn(r.ni_p), niPA: nn(r.ni_pa), eqC: nn(r.eq_c) }));
    // 백필 행은 R fin에 같은 (종목, 사업연도, 보고서)가 있으면 R을 우선한다(같은 보고서를 두 번 세지 않는다).
    const have = new Set(repsR.map((r) => `${r.code}|${r.year}|${r.rc}`)), repsPre: FinRep[] = [];
    for (const r of pre) {
      const x = preRowToRep({ code: String(r.stock_code), kind: String(r.kind), year: Number(r.bsns_year), periodEnd: String(r.period_end), rceptNo: String(r.rcept_no), rcept: isoD(r.rcept_dt), basis: r.eq_total_basis === null || r.eq_total_basis === undefined ? null : String(r.eq_total_basis), eqTotal: nn(r.eq_total), niYtd: nn(r.ni_ytd), niPrev: nn(r.ni_prev_ytd), niMonths: nn(r.ni_months) });
      if (x && !have.has(`${x.code}|${x.year}|${x.rc}`)) repsPre.push(x);
    }
    return { fin, pre, repsR, repsPre };
  };
  let roeIdx: ReturnType<typeof makeRoeIndex> | undefined;
  const loadRoe = async (): Promise<void> => {
    const x = await loadRoeReps();
    roeIdx = makeRoeIndex([...x.repsR, ...x.repsPre]);
    console.log(`ROE 자료 적재: R fin ${x.repsR.length}행 + 2016 이전 백필 ${x.repsPre.length}행(R과 겹치는 보고서 제외), 종목 ${roeIdx.nStocks}개`);
  };
  const roeOf = (code: string, d: string, maxAge: number): RoeOut => (roeIdx as ReturnType<typeof makeRoeIndex>).roeAt(code, d, maxAge);

  // =====================================================================================================================
  // 배당(DV1·DV1C): DART alotMatter 수집본(research/dividend/dividend.parquet) · 배당수익률 · 연속성
  // =====================================================================================================================
  /** 한 (종목, 사업연도) 행. d0 = 그 사업연도 보통주 주당 현금배당금(당기), d1·d2 = 전기·전전기(같은 보고서). null = 숫자 아님. dash = 당기 표기가 "-"(무배당·해당 없음). */
  interface DivRec { fy: number; rcept: string; d0: number | null; d1: number | null; d2: number | null; kind: "num" | "dash" | "none" | "nocommon"; amended: boolean; no: string }
  const divBy = new Map<string, DivRec[]>();
  const divStat = { rows: 0, s000: 0, s013: 0, num: 0, dash: 0, nocommon: 0, none: 0, amended: 0 };
  const divRaw: { code: string; fy: number; status: string; rcept: string; raw: string; rows: string; d0: number | null; d1: number | null; d2: number | null }[] = [];
  /** 보통주 행 판별(사전등록 div-prereg.md §데이터 해석): "보통" 표기 행이 있으면 그 첫 행, 없으면 첫 행이 우선·종류 표기가 아닐 때 첫 행(원행 점검 dvraw: 보통·우선 표기가 같이 있는 12,468행에서 보통주가 첫 행인 경우 98.85%). */
  const divParse = (rows: string): { knd: string; tok: string[] }[] => rows.split(";").filter((x) => x !== "").map((x) => { const a = x.split("|"); return { knd: (a[0] ?? "").trim(), tok: [(a[1] ?? "").trim(), (a[2] ?? "").trim(), (a[3] ?? "").trim()] }; });
  const divNum = (t: string): number | null => { const u = t.replace(/,/g, ""); if (u === "" || u === "-") return null; const v = Number(u); return Number.isFinite(v) ? v : null; };
  const divPick = (ps: { knd: string; tok: string[] }[]): { knd: string; tok: string[] } | undefined => ps.find((x) => /보통/.test(x.knd)) ?? (ps.length > 0 && !ps.some((x) => /보통/.test(x.knd)) && !/우선|종류/.test(ps[0].knd) ? ps[0] : undefined);
  const loadDiv = async (): Promise<void> => {
    const buf = await cachedBytes("div_dividend.parquet", () => downloadBuf(DIV_DATA_FILE));
    if (!buf) throw new Error("research/dividend/dividend.parquet가 없다 — 중단");
    const nz = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    let nStoredDiff = 0, nStoredSame = 0;
    for (const r of await decodeTable(buf)) {
      divStat.rows++;
      const status = String(r.status), code = String(r.stock_code), fy = Number(r.bsns_year), rcept = String(r.rcept_dt ?? ""), rows = String(r.dps_rows ?? "");
      const com = divPick(divParse(rows)), raw = com ? com.tok[0] : "", d0 = com ? divNum(com.tok[0]) : null, d1 = com ? divNum(com.tok[1]) : null, d2 = com ? divNum(com.tok[2]) : null;
      divRaw.push({ code, fy, status, rcept, raw, rows, d0, d1, d2 });
      if (status === "013") { divStat.s013++; continue; }
      if (status !== "000") continue;
      divStat.s000++;
      if (!rcept) continue;
      const sd = nz(r.dps_common); // 수집 시점 파서 값(보통 표기 행 또는 단일 행)과의 일관성 점검
      if (sd !== null) { if (sd === d0) nStoredSame++; else nStoredDiff++; }
      let kind: DivRec["kind"];
      if (d0 !== null) { kind = "num"; divStat.num++; }
      else if (raw === "-") { kind = "dash"; divStat.dash++; }
      else if (rows === "") { kind = "none"; divStat.none++; }
      else { kind = "nocommon"; divStat.nocommon++; }
      const am = String(r.amended ?? "") === "Y"; if (am) divStat.amended++;
      const a = divBy.get(code) ?? []; a.push({ fy, rcept, d0, d1, d2, kind, amended: am, no: String(r.rcept_no ?? "") }); divBy.set(code, a);
    }
    for (const a of divBy.values()) a.sort((x, y) => x.fy - y.fy || (x.rcept < y.rcept ? -1 : 1));
    console.log(`배당 자료 적재: 행 ${divStat.rows}(status 000 ${divStat.s000} · 013 ${divStat.s013}), 접수일 있는 000 행: 숫자 ${divStat.num} · 대시("-") ${divStat.dash} · 보통주 행 판별 불가 ${divStat.nocommon} · 배당 항목 없음 ${divStat.none} | 정정본 ${divStat.amended} | 종목 ${divBy.size}개 | 수집 시점 파서 값이 있던 행 ${nStoredSame + nStoredDiff}건 중 재해석과 같음 ${nStoredSame} · 다름 ${nStoredDiff}`);
  };
  type DivWhy = "ok" | "no_report" | "stale" | "no_common" | "no_value";
  interface DivOut { why: DivWhy; fy?: number; rcept?: string; dps?: number; d1?: number | null; d2?: number | null; age?: number }
  /** 접수일 < 신호일(접수일 다음 거래일부터 반영)인 보고서 중 사업연도가 가장 큰 것(같은 사업연도면 접수일이 늦은 것). 경과 maxAge일 초과면 "stale". 숫자 또는 "-"(= 무배당 0)이면 계산됨. */
  const divAt = (code: string, d: string, maxAge: number): DivOut => {
    const a = divBy.get(code);
    if (!a) return { why: "no_report" };
    let F: DivRec | undefined;
    for (const r of a) { if (r.rcept >= d) continue; if (!F || r.fy > F.fy || (r.fy === F.fy && r.rcept > F.rcept)) F = r; }
    if (!F) return { why: "no_report" };
    const age = dayDiffV(F.rcept, d);
    if (age > maxAge) return { why: "stale", fy: F.fy, rcept: F.rcept, age };
    if (F.kind === "nocommon" || F.kind === "none") return { why: "no_common", fy: F.fy, rcept: F.rcept, age };
    const dps = F.kind === "dash" ? 0 : F.d0;
    if (dps === null) return { why: "no_value", fy: F.fy, rcept: F.rcept, age };
    return { why: "ok", fy: F.fy, rcept: F.rcept, dps, d1: F.kind === "dash" ? null : F.d1, d2: F.kind === "dash" ? null : F.d2, age };
  };
  const qMemo = new Map<string, string[]>();
  /** BS1 적격 ∧ ROE 있음(∧ wP > 0이면 PBR 있음)을 점수 내림차순으로. wP = 0이면 ROE 순위만(Q1), 아니면 (wP × PBR 하위 백분위 + wR × ROE 상위 백분위) ÷ (wP + wR). 같으면 종목코드 순. */
  const qSorted = (c: number, P: QP): string[] => {
    const key = `${c}|${P.maxAge}|${P.wP}|${P.wR}`, hit = qMemo.get(key);
    if (hit) return hit;
    const d = CAL[c], list: { code: string; pbr: number; roe: number }[] = [];
    for (const code of bsElig(c, B5_BS_P0)) {
      const r = roeOf(code, d, P.maxAge);
      if (r.why !== "ok") continue;
      let pbr = Number.NaN;
      if (P.wP > 0) { const x = pbrAt(c, h.byCode.get(code) as S, P.maxAge); if (x.why !== "ok") continue; pbr = x.pbr; }
      list.push({ code, pbr, roe: r.roe as number });
    }
    let out: string[];
    if (P.wP === 0) out = list.sort((a, b) => b.roe - a.roe || (a.code < b.code ? -1 : 1)).map((x) => x.code);
    else {
      const pp = pctRank(list.map((x) => x.pbr)), pr = pctRank(list.map((x) => x.roe));
      out = list.map((x, k) => ({ code: x.code, sc: (P.wP * (1 - pp[k]) + P.wR * pr[k]) / (P.wP + P.wR) })).sort((a, b) => b.sc - a.sc || (a.code < b.code ? -1 : 1)).map((x) => x.code);
    }
    qMemo.set(key, out);
    return out;
  };
  const mkQ = (id: string, P0: QP, nbs: [string, Partial<QP>][]): Strat<QP> => ({
    id, P0, nbs, signalDays: monthEndIdx.filter((c) => c >= cStartV), isSwap: () => true,
    targets: (c, held, P, m) => equalW(pickKeep(qSorted(c, P), held, P.n, P.n * P.keepMult), 1 / P.n, m),
    pool: (c, P) => qSorted(c, P),
    slip: (code, c, lag) => (rank200(Math.max(c - lag, 0)).rank.has(code) ? B5_BS_SLIP_K200 : B5_BS_SLIP_OTHER), vanish: "rule", vanishLoss: vbVanishLoss, wOf: (P) => 1 / P.n,
  });
  // =====================================================================================================================
  // ROE 변화 EG1(335)·EGM1(336): 사전등록 docs/research/roechg-prereg.md, 기준값 lib/roeChgConfig.ts (ROE는 lib/qualityRoe.ts의 TTM 정의 그대로, 유니버스·체결·비용은 VB1·Q1과 같음, 모멘텀 점수는 RM1 rmScore)
  // =====================================================================================================================
  const egPrevMap = new Map<number, number>();
  /** 신호일(월말) c보다 EG_LAG_MONTHS개월 앞선 월말 인덱스(없으면 −1). */
  const egPrevC = (c: number): number => {
    if (!egPrevMap.size) monthEndIdx.forEach((x, j) => { if (j >= EG_LAG_MONTHS) egPrevMap.set(x, monthEndIdx[j - EG_LAG_MONTHS]); });
    return egPrevMap.get(c) ?? -1;
  };
  type EgRow = { code: string; roe: number; prev: number; chg: number };
  const egMemo = new Map<string, EgRow[]>();
  /** 신호일 c(ROE 기준일 CAL[c])와 1년 전 기준 인덱스 cp(ROE 기준일 CAL[cp])로: BS1 적격 ∩ ROE(지금)·ROE(1년 전) 둘 다 "계산됨"인 종목을 ROE 변화 내림차순(동점은 종목코드)으로. */
  const egRowsAt = (c: number, cp: number): EgRow[] => {
    if (cp < 0) return [];
    const key = `${c}|${cp}`, hit = egMemo.get(key);
    if (hit) return hit;
    const out: EgRow[] = [], d = CAL[c], dp = CAL[cp];
    for (const code of bsElig(c, B5_BS_P0)) {
      const a = roeOf(code, d, EG1_P0.maxAge);
      if (a.why !== "ok") continue;
      const b = roeOf(code, dp, EG1_P0.maxAge);
      if (b.why !== "ok") continue;
      out.push({ code, roe: a.roe as number, prev: b.roe as number, chg: (a.roe as number) - (b.roe as number) });
    }
    out.sort((x, y) => y.chg - x.chg || (x.code < y.code ? -1 : 1));
    egMemo.set(key, out);
    return out;
  };
  type EgmRow = EgRow & { sc: number; rC: number; rM: number; avg: number };
  const egmMemo = new Map<string, EgmRow[]>();
  /** EGM1: EG1 후보 ∩ RM1 점수 계산 가능, (ROE 변화 순위 + 모멘텀 순위) ÷ 2 오름차순(동점은 ROE 변화 순위 → 종목코드). */
  const egmRowsAt = (c: number, cp: number): EgmRow[] => {
    const key = `${c}|${cp}`, hit = egmMemo.get(key);
    if (hit) return hit;
    const base = egRowsAt(c, cp).map((x) => ({ ...x, sc: rmScore(h.byCode.get(x.code) as S, c, EGM1_P0.rm) })).filter((x) => Number.isFinite(x.sc));
    const rC = new Map(base.map((x, k) => [x.code, k + 1] as [string, number])), rM = new Map([...base].sort((a, b) => b.sc - a.sc || (a.code < b.code ? -1 : 1)).map((x, k) => [x.code, k + 1] as [string, number]));
    const out = base.map((x) => ({ ...x, rC: rC.get(x.code) as number, rM: rM.get(x.code) as number, avg: ((rC.get(x.code) as number) + (rM.get(x.code) as number)) / 2 })).sort((a, b) => a.avg - b.avg || a.rC - b.rC || (a.code < b.code ? -1 : 1));
    egmMemo.set(key, out);
    return out;
  };
  const egSorted = (c: number): string[] => egRowsAt(c, egPrevC(c)).map((x) => x.code);
  const egmSorted = (c: number): string[] => egmRowsAt(c, egPrevC(c)).map((x) => x.code);
  /** shift > 0(정보용 견고성 점검): 첫 신호일 뒤 월 신호일을 shift 거래일 앞당기고, 1년 전 기준일도 같은 만큼 앞당긴다. */
  const mkEG = (id: string, P0: EgP, nbs: [string, Partial<EgP>][], withMom: boolean, o: { shift?: number } = {}): Strat<EgP> => {
    const shift = o.shift ?? 0, first = monthEndIdx.find((x) => x >= cStartV) as number;
    const meOf = (c: number): number => (shift === 0 || c === first ? c : c + shift);
    const cpOf = (c: number): number => { const cp = egPrevC(meOf(c)); return cp < 0 ? -1 : meOf(c) === c ? cp : cp - shift; };
    const sorted = (c: number): string[] => (withMom ? egmRowsAt(c, cpOf(c)) : egRowsAt(c, cpOf(c))).map((x) => x.code);
    return {
      id, P0, nbs, signalDays: monthEndIdx.filter((c) => c >= cStartV).map((c) => (shift > 0 && c > first ? c - shift : c)), isSwap: () => true,
      targets: (c, held, P, m) => equalW(pickKeep(sorted(c), held, P.n, P.n * P.keepMult), 1 / P.n, m),
      pool: (c) => sorted(c),
      slip: (code, c, lag) => (rank200(Math.max(c - lag, 0)).rank.has(code) ? B5_BS_SLIP_K200 : B5_BS_SLIP_OTHER), vanish: "rule", vanishLoss: vbVanishLoss, wOf: (P) => 1 / P.n,
    };
  };
  // =====================================================================================================================
  // 배당 DV1(341)·DV1C(342): 사전등록 docs/research/div-prereg.md, 기준값 lib/dividendTestConfig.ts (배당 자료 = research/dividend/dividend.parquet, 유니버스·체결·비용은 VB1·Q1·EG1과 같음)
  // =====================================================================================================================
  type DvRow = { code: string; yld: number; dps: number; fy: number; rcept: string };
  const dvMemo = new Map<string, DvRow[]>();
  /**
   * 신호일 c: BS1 적격 ∩ 배당 계산됨(divAt "ok": 접수일 < 신호일, 경과 maxAge일 이내, 보통주 당기 값 숫자 또는 "-") ∩ 배당 연속성(직전 3개 사업연도 = 가장 최근 보고서의 당기·전기·전전기 보통주 주당 현금배당금이 모두 > 0)
   * ∩ 순이익 TTM > 0 ∧ 자본 > 0(Q1 roeAt "ok") ∩ 원종가 > 0. 배당수익률 = 주당 현금배당금(당기) ÷ 신호일 원종가, 내림차순(동점은 종목코드).
   */
  const dvRowsAt = (c: number, P: DvP): DvRow[] => {
    const key = `${c}|${P.maxAge}`, hit = dvMemo.get(key);
    if (hit) return hit;
    const out: DvRow[] = [], d = CAL[c];
    for (const code of bsElig(c, B5_BS_P0)) {
      const o = divAt(code, d, P.maxAge);
      if (o.why !== "ok" || !((o.dps as number) > 0 && (o.d1 ?? 0) > 0 && (o.d2 ?? 0) > 0)) continue;
      if (roeOf(code, d, P.maxAge).why !== "ok") continue;
      const s = h.byCode.get(code) as S, px = s.raw[s.idx.get(d) as number];
      if (!(px > 0)) continue;
      out.push({ code, yld: (o.dps as number) / px, dps: o.dps as number, fy: o.fy as number, rcept: o.rcept as string });
    }
    out.sort((x, y) => y.yld - x.yld || (x.code < y.code ? -1 : 1));
    dvMemo.set(key, out);
    return out;
  };
  const dvSorted = (c: number, P: DvP): string[] => dvRowsAt(c, P).map((x) => x.code);
  /** shift > 0(정보용 견고성 점검): 첫 신호일 뒤 월 신호일을 shift 거래일 앞당긴다(신호일의 배당·ROE는 그 신호일 기준으로 다시 계산한다). */
  const mkDV = (id: string, P0: DvP, nbs: [string, Partial<DvP>][], o: { shift?: number } = {}): Strat<DvP> => {
    const shift = o.shift ?? 0, first = monthEndIdx.find((x) => x >= cStartV) as number;
    return {
      id, P0, nbs, signalDays: monthEndIdx.filter((c) => c >= cStartV).map((c) => (shift > 0 && c > first ? c - shift : c)), isSwap: () => true,
      targets: (c, held, P, m) => equalW(pickKeep(dvSorted(c, P), held, P.n, P.n * P.keepMult), 1 / P.n, m),
      pool: (c, P) => dvSorted(c, P),
      slip: (code, c, lag) => (rank200(Math.max(c - lag, 0)).rank.has(code) ? B5_BS_SLIP_K200 : B5_BS_SLIP_OTHER), vanish: "rule", vanishLoss: vbVanishLoss, wOf: (P) => 1 / P.n,
    };
  };
  // =====================================================================================================================
  // 잔차 모멘텀 + 역변동성 비중 RM1V(337)·RM1VC(338): 사전등록 docs/research/rm1v-prereg.md, 기준값 lib/rm1vConfig.ts (신호·유니버스·유지·체결은 RM1 그대로, 비중만 역변동성 + 상한)
  // =====================================================================================================================
  const rvVolMemo = new Map<string, number>();
  /** 신호일 c까지 직전 win거래일 일간 수익률(달력 앞채움 종가, 행 없는 날 0)의 표본 표준편차. 창 안 실제 종가 행이 win × RV_MIN_VALID_FRAC개 미만이거나 표준편차가 0이면 NaN. */
  const rvVol = (code: string, c: number, win: number): number => {
    const key = `${code}|${c}|${win}`, hit = rvVolMemo.get(key);
    if (hit !== undefined) return hit;
    const s = h.byCode.get(code) as S;
    let v = Number.NaN;
    if (c - win + 1 >= 1 && nRows(s, c - win + 1, c) >= Math.ceil(RV_MIN_VALID_FRAC * win - 1e-9)) {
      const r = retFill(s);
      let m = 0;
      for (let k = c - win + 1; k <= c; k++) m += r[k];
      m /= win;
      let ss = 0;
      for (let k = c - win + 1; k <= c; k++) ss += (r[k] - m) ** 2;
      const sd = Math.sqrt(ss / (win - 1));
      if (sd > 0 && Number.isFinite(sd)) v = sd;
    }
    rvVolMemo.set(key, v);
    return v;
  };
  /** 종목들(선정 순서 그대로)의 목표 비중: 1/σ에 비례, 합 100%, 종목당 상한 cap(넘는 몫은 나머지에 역변동성 비율로 재배분, 반복). σ 불가 종목은 σ가 계산되는 종목들의 중앙값으로 대체(없으면 동일 비중). 모두 상한에 걸려 합이 100% 미만이면 나머지는 현금. */
  const rvWeights = (c: number, codes: string[], P: RvP, m: number): Map<string, number> => {
    const vols = codes.map((code) => rvVol(code, c, P.volWin)), fin = vols.filter((v) => Number.isFinite(v)), med = fin.length ? medianOf(fin) : Number.NaN;
    const inv = vols.map((v) => (fin.length ? 1 / (Number.isFinite(v) ? v : med) : 1)), w = new Array<number>(codes.length).fill(0), free = new Set(codes.map((_, i) => i));
    let rem = 1;
    while (free.size) {
      let si = 0;
      for (const i of free) si += inv[i];
      const over = [...free].filter((i) => (rem * inv[i]) / si > P.cap);
      if (!over.length) { for (const i of free) w[i] = (rem * inv[i]) / si; break; }
      for (const i of over) { w[i] = P.cap; free.delete(i); }
      rem -= over.length * P.cap;
    }
    return new Map(codes.map((code, i) => [code, w[i] * m] as [string, number]).filter(([, x]) => x > 0));
  };
  /** shift > 0(정보용 견고성 점검): 첫 신호일 뒤 월 신호일을 shift 거래일 앞당긴다(변동성·모멘텀은 그 앞당긴 날 기준). */
  const mkRV = (id: string, P0: RvP, nbs: [string, Partial<RvP>][], o: { shift?: number } = {}): Strat<RvP> => {
    const shift = o.shift ?? 0;
    return {
      ...(RM1 as unknown as Strat<RvP>), id, P0, nbs, signalDays: monthEndIdx.map((c) => (shift > 0 && c > cFirstME ? c - shift : c)), isSwap: () => true,
      targets: (c, held, P, m) => rvWeights(c, pickKeep(rmSorted(c, P).map((x) => x.code), held, P.n, P.n * P.keepMult), P, m),
      pool: (c, P) => RM1.pool(c, P),
      wMap: (c, codes, P, m) => rvWeights(c, codes, P, m), wOf: (P) => P.cap,
    };
  };
  /** RM1VC = 코어 40% + RM1V 60%, 월 리밸런스(combineN). shift > 0은 정보용 견고성 점검. */
  const rvcOf = (cS: number, Wx: Windows, o: { lag?: number; shift?: number; P?: Partial<RvP> } = {}) => {
    const lag = o.lag ?? 1, shift = o.shift ?? 0, from = Wx.FULL.from, rv = mkRV("RM1V", RV1_P0, RV1_NB, { shift });
    const sigSet = new Set(monthEndIdx.filter((c) => c > cS).map((c) => CAL[c - shift]));
    const sat = runS(rv, { ...RV1_P0, ...o.P }, cS, null, { lag, detail: true }), cx = coreOf(2, undefined, lag, {}), core = sliceSl(cx.sl, from), sls = [core, slFromRun(sat)];
    return { res: combineN(sls, [B5_CORE_W, 1 - B5_CORE_W], CS_MOVE_COST, sigSet), sat, core: cx.run, sls, rv, sigSet, from };
  };
  // =====================================================================================================================
  // 52주 신고가 근접 HM1(323)·HM1C(324): 사전등록 docs/research/high52-prereg.md, 기준값 lib/high52Config.ts
  // =====================================================================================================================
  const hmMemo = new Map<string, { code: string; sc: number }[]>();
  /** 신호일 c의 K200P(PIT) 종목 점수 = 신호일 종가 ÷ 직전 lookback거래일(당일 제외) 최고 종가(수정 종가, 실제 종가 행만 사용 — 달력 앞채움 안 씀). 행이 lookback × minValidFrac개 미만이면 제외. 높은 순, 동점은 시총 순위. */
  const hmSorted = (c: number, P: HmP): { code: string; sc: number }[] => {
    const key = `${c}|${P.lookback}|${P.minValidFrac}`;
    const memo = hmMemo.get(key);
    if (memo) return memo;
    const rk = rank200(c), e: { code: string; sc: number }[] = [], k0 = c - P.lookback, need = Math.ceil(P.lookback * P.minValidFrac);
    if (k0 >= 0) for (const s of rk.list) {
      const ic = rowAt(s, c);
      if (ic === undefined) continue;
      let mx = Number.NEGATIVE_INFINITY, n = 0;
      for (let k = k0; k <= c - 1; k++) { const i = s.idx.get(CAL[k]); if (i === undefined) continue; n++; if (s.close[i] > mx) mx = s.close[i]; }
      if (n < need || !(mx > 0) || !Number.isFinite(s.close[ic])) continue;
      e.push({ code: s.code, sc: s.close[ic] / mx });
    }
    e.sort((x, y) => y.sc - x.sc || (rk.rank.get(x.code) as number) - (rk.rank.get(y.code) as number));
    hmMemo.set(key, e);
    return e;
  };
  const mkHM = (id: string, P0: HmP, nbs: [string, Partial<HmP>][]): Strat<HmP> => ({
    id, P0, nbs, signalDays: monthEndIdx, isSwap: () => true,
    targets: (c, held, P, m) => equalW(pickKeep(hmSorted(c, P).map((x) => x.code), held, P.n, P.n * P.keepMult), 1 / P.n, m),
    pool: (c, P) => hmSorted(c, P).map((x) => x.code),
    slip: (code, c, lag) => (rank200(Math.max(c - lag, 0)).rank.has(code) ? B5_BS_SLIP_K200 : B5_BS_SLIP_OTHER), vanish: "rule", vanishLoss: vbVanishLoss, wOf: (P) => 1 / P.n,
  });
  // =====================================================================================================================
  // 시총 상위 5종목 TC1(325)·TC2(326): 사전등록 docs/research/megacap-prereg.md, 기준값 lib/megacapConfig.ts
  // =====================================================================================================================
  const meSet = new Set(monthEndIdx), cFirstME = monthEndIdx.find((x) => x >= 253) as number;
  /** 각 거래일 c 이하 가장 가까운 월말 인덱스(없으면 −1): 월 중에는 그 월말에 정한 시총 상위 그룹을 그대로 쓴다. */
  const meAt = new Int32Array(CAL.length).fill(-1);
  { let k = 0; for (let c = 0; c < CAL.length; c++) { while (k < monthEndIdx.length && monthEndIdx[k] <= c) k++; meAt[c] = k > 0 ? monthEndIdx[k - 1] : -1; } }
  /** 신호일 c의 그룹 = 직전(포함) 월말 신호일의 K200P(PIT) 시총 상위 n종목(시총 같으면 종목코드 순). */
  const tcGroup = (c: number, P: TcP): S[] => { const g = meAt[c]; return g < 0 ? [] : rank200(g).list.slice(0, P.n); };
  const tcMemo = new Map<string, boolean | undefined>();
  /** 이동평균 조건: 그날 종가 > 직전 ma거래일(당일 포함) 종가 행 평균(수정 종가). ma = 0이면 항상 true, 그날 종가 행이 없으면 undefined(상태 유지), 기간 안 행이 ma × minValidFrac개 미만이거나 기간이 모자라면 false. */
  const tcCond = (s: S, c: number, P: TcP): boolean | undefined => {
    if (P.ma === 0) return true;
    const ic = rowAt(s, c);
    if (ic === undefined) return undefined;
    const key = `${s.code}|${c}|${P.ma}|${P.minValidFrac}`, memo = tcMemo.get(key);
    if (memo !== undefined) return memo;
    let v = false;
    const k0 = c - P.ma + 1;
    if (k0 >= 0) {
      let sum = 0, n = 0;
      for (let k = k0; k <= c; k++) { const i = s.idx.get(CAL[k]); if (i !== undefined) { sum += s.close[i]; n++; } }
      v = n >= Math.ceil(P.ma * P.minValidFrac) && s.close[ic] > sum / n;
    }
    tcMemo.set(key, v);
    return v;
  };
  const mkTC = (id: string, P0: TcP, nbs: [string, Partial<TcP>][], daily: boolean): Strat<TcP> => ({
    id, P0, nbs, signalDays: daily ? Array.from({ length: CAL.length - cFirstME }, (_, k) => cFirstME + k) : monthEndIdx, isSwap: () => true,
    targets: (c, held, P) => {
      const out = new Map<string, number>(), isME = meSet.has(c);
      for (const s of tcGroup(c, P)) {
        const cd = tcCond(s, c, P), isHeld = held.has(s.code);
        if (cd === undefined) { if (isHeld) out.set(s.code, -1); continue; }
        if (!cd) continue;
        out.set(s.code, isME || !isHeld ? 1 / P.n : -1);
      }
      return out;
    },
    pool: (c) => rank200(c).list.map((s) => s.code),
    slip: (code, c, lag) => (rank200(Math.max(c - lag, 0)).rank.has(code) ? B5_BS_SLIP_K200 : B5_BS_SLIP_OTHER), vanish: "rule", vanishLoss: vbVanishLoss, wOf: (P) => 1 / P.n,
  });
  /** 보고용: 거래일 c ≥ cS 중 코드가 (그룹 ∧ 조건)이던 날의 비율 × 1/n = 평균 목표 비중(계좌 기준, 비중 표류·체결 지연 무시). */
  const tcAvgW = (code: string, P: TcP, cS: number): number => {
    let sum = 0, n = 0;
    for (let c = cS; c < CAL.length; c++) { n++; const g = tcGroup(c, P).find((s) => s.code === code); if (g && tcCond(g, c, P) === true) sum += 1 / P.n; }
    return n ? sum / n : 0;
  };
  // =====================================================================================================================
  // 이익수익률 EY1(327)·EY1C(328): 사전등록 docs/research/ey-prereg.md, 기준값 lib/eyConfig.ts (ROE 정의는 lib/qualityRoe.ts 그대로)
  // =====================================================================================================================
  const eyMemo = new Map<string, { code: string; ey: number }[]>();
  /** BS1 적격 ∧ TTM 순이익 > 0 ∧ 자본 > 0(ROE 정의의 ok)인 종목을 이익수익률(TTM 순이익 ÷ 시가총액) 내림차순으로. 시가총액 = 신호일 mcapRow × 1억원(PBR과 같음). 같으면 종목코드 순. */
  const eySorted = (c: number, P: EyP): { code: string; ey: number }[] => {
    const key = `${c}|${P.maxAge}`, hit = eyMemo.get(key);
    if (hit) return hit;
    const d = CAL[c], list: { code: string; ey: number }[] = [];
    for (const code of bsElig(c, B5_BS_P0)) {
      const r = roeOf(code, d, P.maxAge);
      if (r.why !== "ok") continue;
      const s = h.byCode.get(code) as S, i = s.idx.get(d);
      if (i === undefined) continue;
      const mc = s.mcapRow[i] * 1e8;
      if (!(mc > 0)) continue;
      list.push({ code, ey: (r.ttm as number) / mc });
    }
    list.sort((a, b) => b.ey - a.ey || (a.code < b.code ? -1 : 1));
    eyMemo.set(key, list);
    return list;
  };
  const mkEY = (id: string, P0: EyP, nbs: [string, Partial<EyP>][]): Strat<EyP> => ({
    id, P0, nbs, signalDays: monthEndIdx.filter((c) => c >= cStartV), isSwap: () => true,
    targets: (c, held, P, m) => equalW(pickKeep(eySorted(c, P).map((x) => x.code), held, P.n, P.n * P.keepMult), 1 / P.n, m),
    pool: (c, P) => eySorted(c, P).map((x) => x.code),
    slip: (code, c, lag) => (rank200(Math.max(c - lag, 0)).rank.has(code) ? B5_BS_SLIP_K200 : B5_BS_SLIP_OTHER), vanish: "rule", vanishLoss: vbVanishLoss, wOf: (P) => 1 / P.n,
  });
  // =====================================================================================================================
  // 잔차 모멘텀 + 손절 RM1S(329)·RM1SC(330): 사전등록 docs/research/stop-prereg.md, 기준값 lib/stopConfig.ts (신호·유니버스·체결·비용은 RM1 그대로)
  // =====================================================================================================================
  // RM1S 전략(mkRMS)·손절 기록(rmsLog)은 lib/ds13Engine.ts에서 가져온다(시험 코드를 옮긴 그대로, 포워드 도구와 같은 코드).
  /** 손절 발동 뒤 다음 달 수익: 매도 체결일(c + 1) 종가 → 그 뒤 S_NEXT_MONTH_DAYS거래일 종가(수정 종가, 달력 앞채움 값). */
  const stopNext = (ev: { code: string; c: number }): number => {
    const a = al(h.byCode.get(ev.code) as S), f = ev.c + 1, g = Math.min(f + S_NEXT_MONTH_DAYS, CAL.length - 1);
    return a[f] > 0 && a[g] > 0 ? a[g] / a[f] - 1 : Number.NaN;
  };
  // =====================================================================================================================
  // 저PBR + 손절 VB1S(331)·VB1SC(332): 사전등록 docs/research/vbstop-prereg.md, 기준값 lib/vbStopConfig.ts (신호·유니버스·체결·비용은 VB1 그대로, 손절은 RM1S와 같은 lib/ds13Engine.ts makeStopper)
  // =====================================================================================================================
  const vbStopper = makeStopper(), vbsLog = vbStopper.log;
  const mkVBS = (id: string, P0: VbsP, nbs: [string, Partial<VbsP>][], o: { shift?: number } = {}): Strat<VbsP> =>
    vbStopper.mk<VbsP>(id, mkVB(id, VB1_P0, []) as unknown as Strat<VbsP>, (c, P) => vbSorted(c, P), P0, nbs, { firstC: cStartV, shift: o.shift });
  /** VB1SC = 코어 40% + VB1S 60%, 월 리밸런스(combineN). shift > 0은 정보용 견고성 점검(첫 신호일 뒤 월 신호일과 하위 계좌 간 재조정 신호를 shift 거래일 앞당김). */
  const vbscOf = (cS: number, Wx: Windows, o: { lag?: number; shift?: number; stopP?: Partial<VbsP> } = {}) => {
    const lag = o.lag ?? 1, shift = o.shift ?? 0, from = Wx.FULL.from, vbs = mkVBS("VB1S", VB1S_P0, VB1S_NB, { shift });
    const sigSet = new Set(monthEndIdx.filter((c) => c > cS).map((c) => CAL[c - shift]));
    const sat = runS(vbs, { ...VB1S_P0, ...o.stopP }, cS, null, { lag, detail: true }), cx = coreOf(2, undefined, lag, {}), core = sliceSl(cx.sl, from), sls = [core, slFromRun(sat)];
    return { res: combineN(sls, [B5_CORE_W, 1 - B5_CORE_W], CS_MOVE_COST, sigSet), sat, core: cx.run, sls, vbs, sigSet, from };
  };
  // =====================================================================================================================
  // 저PBR + 잔차 모멘텀 복합 CM1(333)·CM1S(334): 사전등록 docs/research/composite-prereg.md, 기준값 lib/compositeConfig.ts (유니버스·PBR 조건·체결·비용은 VB1, 모멘텀 점수는 RM1 rmScore, 손절은 RM1S·VB1S와 같은 makeStopper)
  // =====================================================================================================================
  type CmRow = { code: string; pbr: number; sc: number; rP: number; rM: number; avg: number };
  const cmMemo = new Map<number, CmRow[]>();
  /** 신호일 c의 후보 집합(BS1 적격 ∩ PBR 있음(접수일 < 신호일·경과 maxAge·자본 > 0) ∩ RM1 점수 계산 가능)을 평균 순위 순으로. 순위는 후보 집합 안에서 서수(PBR 오름차순, 모멘텀 점수 내림차순, 동점은 종목코드), 평균 동점은 PBR 순위 → 종목코드. */
  const cmRows = (c: number): CmRow[] => {
    const hit = cmMemo.get(c);
    if (hit) return hit;
    const list: { code: string; pbr: number; sc: number }[] = [];
    for (const code of bsElig(c, B5_BS_P0)) {
      const s = h.byCode.get(code) as S, x = pbrAt(c, s, CM1_P0.maxAge);
      if (x.why !== "ok") continue;
      const sc = rmScore(s, c, CM1_P0.rm);
      if (!Number.isFinite(sc)) continue;
      list.push({ code, pbr: x.pbr, sc });
    }
    const rP = new Map([...list].sort((a, b) => a.pbr - b.pbr || (a.code < b.code ? -1 : 1)).map((x, k) => [x.code, k + 1] as [string, number]));
    const rM = new Map([...list].sort((a, b) => b.sc - a.sc || (a.code < b.code ? -1 : 1)).map((x, k) => [x.code, k + 1] as [string, number]));
    const out = list.map((x) => ({ ...x, rP: rP.get(x.code) as number, rM: rM.get(x.code) as number, avg: ((rP.get(x.code) as number) + (rM.get(x.code) as number)) / 2 })).sort((a, b) => a.avg - b.avg || a.rP - b.rP || (a.code < b.code ? -1 : 1));
    cmMemo.set(c, out);
    return out;
  };
  const cmSorted = (c: number, _P: CmP): string[] => cmRows(c).map((x) => x.code);
  const mkCM = (id: string, P0: CmP, nbs: [string, Partial<CmP>][]): Strat<CmP> => ({
    id, P0, nbs, signalDays: monthEndIdx.filter((c) => c >= cStartV), isSwap: () => true,
    targets: (c, held, P, m) => equalW(pickKeep(cmSorted(c, P), held, P.n, P.n * P.keepMult), 1 / P.n, m),
    pool: (c, P) => cmSorted(c, P),
    slip: (code, c, lag) => (rank200(Math.max(c - lag, 0)).rank.has(code) ? B5_BS_SLIP_K200 : B5_BS_SLIP_OTHER), vanish: "rule", vanishLoss: vbVanishLoss, wOf: (P) => 1 / P.n,
  });
  const cmStopper = makeStopper(), cmsLog = cmStopper.log;
  const mkCMS = (id: string, P0: CmP, nbs: [string, Partial<CmP>][], o: { shift?: number } = {}): Strat<CmP> =>
    cmStopper.mk<CmP>(id, mkCM(id, CM1_P0, []), (c, P) => cmSorted(c, P), P0, nbs, { firstC: cStartV, shift: o.shift });
  // =====================================================================================================================
  // 저평가 후속 VB1F(314)·DS14(315): 시장 필터 / 코어 40% + 모멘텀 위성(RM1) 30% + 가치 위성(VB1) 30%, 하위 계좌 간 월 1회 재조정
  // =====================================================================================================================
  const d14Of = (cV: number, Wx: Windows) => {
    const from = Wx.FULL.from, W0 = V2_W, rmP0 = RM1.P0, vb = mkVB("VB1", VB1_P0, VB1_NB);
    const sigSet = new Set(monthEndIdx.filter((c) => c > cV).map((c) => CAL[c]));
    const coreSlOf = (lag: number): { run: CoreRun; sl: Sl } => { const x = coreOf(2, undefined, lag, {}); return { run: x.run, sl: sliceSl(x.sl, from) }; };
    const build = (o: { w?: Alloc3; vP?: Partial<VbP>; lag: number; repl?: { rm: Set<string>; va: Set<string> } }) => {
      const rm = runS(RM1, rmP0, cV, null, { lag: o.lag, detail: true, replace: o.repl?.rm });
      const va = runS(vb, { ...VB1_P0, ...o.vP }, cV, null, { lag: o.lag, detail: true, replace: o.repl?.va });
      const cx = coreSlOf(o.lag), sls = [cx.sl, slFromRun(rm), slFromRun(va)];
      return { res: combineN(sls, o.w ?? W0, CS_MOVE_COST, sigSet), rm, va, core: cx.run, sls };
    };
    type D14Parts = ReturnType<typeof build>;
    const merge = (b: D14Parts, w: Alloc3 = W0): SimRun => {
      const r: SimRun = { ...b.res.run };
      r.trades = [...b.rm.trades.map((x) => ({ ...x, vAtEntry: x.vAtEntry / w[1] })), ...b.va.trades.map((x) => ({ ...x, vAtEntry: x.vAtEntry / w[2] })), ...b.core.trades.map((x) => ({ ...x, vAtEntry: x.vAtEntry / w[0] }))];
      r.entryCs = [...b.rm.entryCs, ...b.va.entryCs, ...b.core.entryCs];
      r.haltSkip = b.rm.haltSkip + b.va.haltSkip + b.core.haltSkip; r.exitDefer = b.rm.exitDefer + b.va.exitDefer + b.core.exitDefer;
      return r;
    };
    return { from, W0, rmP0, vb, sigSet, coreSlOf, build, merge, base: build({ lag: 1 }) };
  };
  const d14Handles = new Map<string, ReturnType<typeof d14Of>>();
  const mkD14 = (id: string, trial: number, cV: number, Wx: Windows, title: string): CandSpec => {
    const d = d14Of(cV, Wx), { from, W0, rmP0, vb, sigSet } = d;
    d14Handles.set(id, d);
    const baseRm = d.base.rm, baseVa = d.base.va;
    if (baseRm.dates[0] !== from || baseVa.dates[0] !== from || d.base.res.run.dates[0] !== from) throw new Error(`${id}: 하위 계좌 시작일이 ${from}과 다르다`);
    const rmHold = holdSamplesOf(RM1, false, cV, baseRm), vaHold = holdSamplesOf(vb, false, cV, baseVa);
    const rmOrders = new Map<number, number>(), vaOrders = new Map<number, number>();
    for (const c of baseRm.entryCs) rmOrders.set(c - 1, (rmOrders.get(c - 1) ?? 0) + 1);
    for (const c of baseVa.entryCs) vaOrders.set(c - 1, (vaOrders.get(c - 1) ?? 0) + 1);
    const coreFixed = d.coreSlOf(1).sl;
    const topRepl2 = (): { rm: Set<string>; va: Set<string> } => {
      const arr: { sl: "rm" | "va"; key: string; pnl: number }[] = [];
      for (const t of baseRm.trades) if (CAL[t.exitC] >= from) arr.push({ sl: "rm", key: `${t.code}|${t.entryC}`, pnl: pnlS(t) * W0[1] });
      for (const t of baseVa.trades) if (CAL[t.exitC] >= from) arr.push({ sl: "va", key: `${t.code}|${t.entryC}`, pnl: pnlS(t) * W0[2] });
      arr.sort((a, b) => b.pnl - a.pnl);
      const top = arr.slice(0, F_E_TOP_TRADES);
      return { rm: new Set(top.filter((x) => x.sl === "rm").map((x) => x.key)), va: new Set(top.filter((x) => x.sl === "va").map((x) => x.key)) };
    };
    const nbs: { label: string; run: () => SimRun }[] = [
      ...V2_NB_W.map(([lb, w]) => ({ label: lb, run: () => d.build({ w, lag: 1 }).res.run })),
      ...VB_EQ_AGE_NB.map((a) => ({ label: `PBR 보고서 최대 경과일 ${a}`, run: () => d.build({ vP: { maxAge: a }, lag: 1 }).res.run })),
    ];
    return {
      id, trial, title, defense: false, capFrac: 0.015, fDenominator: V2_F_DENOMINATOR, ref: { id: "069500", run: bhAll },
      hRule: (full, rb) => { const a = hVs(full, rb); return { ok: a.ok, note: `[사전등록: 069500만 판정] 069500 ${f2(rb.cagr)} / ${f2(rb.mdd)} → ${a.ok ? "O" : "X"} (${a.text})` }; },
      run: (o) => (o.replace ? d.merge(d.build({ lag: 1, repl: topRepl2() })) : d.merge(d.build({ lag: o.lag }))),
      neighbors: nbs,
      random: (rng) => {
        const rmR = randomS(RM1, rmP0, cV, null, rng, rmOrders, rmHold), vaR = randomS(vb, VB1_P0, cV, null, rng, vaOrders, vaHold);
        return combineN([coreFixed, slFromRun(rmR), slFromRun(vaR)], W0, CS_MOVE_COST, sigSet).run;
      },
      reasons: ["순위 밖", "목표 0", "폐지", "폐지(전액 손실)"], label,
      extra: (run) => {
        gateNotes(id, trial, nbs.length);
        console.log(`${id} 게이트 E 해석(사전등록): 두 위성(모멘텀 + 가치)의 닫힌 거래 중 계좌 기준 손익 상위 3개를 069500 수익률로 바꾸고 코어는 실제 그대로 돌린 연속 전체 CAGR ≥ 069500(출력의 상위 거래 목록은 코어 포함 참고용). F: 위성별 무작위 대조(모멘텀: RM1 무작위, 가치: 같은 유니버스에서 PBR 있는 종목 무작위, 신호 건수·보유 기간 분포 같음)를 실제 코어와 40/30/30으로 합성, 시드 ${KSS_R3_SEED} ${KSS_R3_DRAWS}회, 백분위 ≥ 95. G: 코어 + 두 위성 진입 합.`);
        const b = d.base, contrib = new Map<string, { pct: number; days: number }>();
        for (const [code, v] of baseRm.contrib) contrib.set(code, { pct: v.pct * W0[1], days: v.days });
        for (const [code, v] of baseVa.contrib) { const o = contrib.get(code); contrib.set(code, { pct: (o?.pct ?? 0) + v.pct * W0[2], days: (o?.days ?? 0) + v.days }); }
        reportCommon({ id, trial, cS: cV, Wx, sleeveW: 1, contrib, trades: [...baseRm.trades, ...baseVa.trades], open: [...baseRm.open, ...baseVa.open], extraLines: (r) => ds6GateLine(id, Wx, r) }, run);
        // I6 손익 분해(하위 계좌 비중 × 일별 수익률 단순 합 %p), 재조정 이동·비용
        const names = ["코어(DS6 코어)", "모멘텀 위성(RM1)", "가치 위성(VB1)"];
        const win = (a: string, z: string): number[] => names.map((_, j) => b.res.run.dates.reduce((acc, dd, i) => (dd >= a && dd <= z ? acc + b.res.contribDaily[j][i] : acc), 0));
        const yrs = Math.max((Date.parse(h.dataEnd) - Date.parse(from)) / 86_400_000 / 365.25, 1e-9);
        const fullC = win(from, h.dataEnd), w2C = win(DS13_WIN2.from, DS13_WIN2.to), totC = fullC.reduce((x, y) => x + y, 0), totW2 = w2C.reduce((x, y) => x + y, 0);
        console.log(`\n[I6] ${id} 손익 분해(하위 계좌 비중 × 일별 수익률의 단순 합 %p; 비용은 각 하위 계좌 수익률에 이미 반영, 재조정 비용 별도)`);
        console.log("| 하위 계좌 | 연속 전체 기여 %p (비중) | 구간 2 기여 %p | 평균 비중(종가, 이동 후) % | 단독(같은 구간) CAGR / MDD |\n|---|---|---|---|---|");
        names.forEach((nm, j) => console.log(`| ${nm} | ${f2(fullC[j])} (${f2(totC ? (fullC[j] / totC) * 100 : 0)}%) | ${f2(w2C[j])} (${f2(totW2 ? (w2C[j] / totW2) * 100 : 0)}%) | ${f2(avg(b.res.wEnd.map((w) => w[j])) * 100)} | ${cellS(b.sls[j], Wx.FULL)} |`));
        console.log(`재조정(월 1회) 이동 금액 연 ${f2(b.res.moved.reduce((x, y) => x + y, 0) * 100 / yrs)}%(계좌 대비), 이동 비용 합계 ${f2(b.res.cost.reduce((x, y) => x + y, 0) * 100)}%p(연 ${f2(b.res.cost.reduce((x, y) => x + y, 0) * 100 / yrs)}%p) | 하위 계좌 비중 종가 기준 최대 이탈 %p: ${names.map((nm, j) => `${nm.split("(")[0]} ${f2(Math.max(...b.res.wEnd.map((w) => Math.abs(w[j] - W0[j]))) * 100)}`).join(", ")}`);
        // I7 삼성전자·SK하이닉스 평균 목표 비중(코어 + 모멘텀 + 가치, 월말 신호일 목표 기준 근사)
        const ptRm = pathTgG(RM1, cV), ptVa = pathTgG(vb, cV);
        for (const code of V2_WATCH) {
          let sc = 0, sr = 0, sv = 0;
          const nSig = ptRm.length;
          for (let jj = 0; jj < nSig; jj++) {
            const c = ptRm[jj].c, ev = [...b.core.events].filter((e) => e.c <= c + 1).pop();
            sc += ev ? (ev.w[ev.set.indexOf(code)] ?? 0) : 0; sr += ptRm[jj].t.get(code) ?? 0; sv += ptVa[jj]?.t.get(code) ?? 0;
          }
          console.log(`[I7] ${label(code)} 평균 목표 비중(월말 신호일 ${nSig}개 평균, 계좌 기준 %): 코어 ${f2((sc / nSig) * W0[0] * 100)} + 모멘텀 위성 ${f2((sr / nSig) * W0[1] * 100)} + 가치 위성 ${f2((sv / nSig) * W0[2] * 100)} = ${f2(((sc / nSig) * W0[0] + (sr / nSig) * W0[1] + (sv / nSig) * W0[2]) * 100)}% (코어는 교체 이벤트 시점 비중, 모멘텀·가치 위성은 목표 비중)`);
        }
      },
    };
  };
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
    const finBuf = await cachedBytes(`${R_STORE_PREFIX}/fin.parquet`, () => downloadBuf(`${R_STORE_PREFIX}/fin.parquet`)), filBuf = await cachedBytes(`${R_STORE_PREFIX}/filings.parquet`, () => downloadBuf(`${R_STORE_PREFIX}/filings.parquet`));
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
  if (MODE === "v2pre") {
    // 저평가 후속 사전 점검(성과 미계산): DS6 재현(위 줄, 불일치면 중단), PBR 독립 재계산, 시장 필터 독립 재계산, VB1F 구조, DS14 구조·합성 회계, 정보용 항목 목록.
    await loadEqTables();
    requireStart();
    if (V_START !== V2_START) throw new Error(`V_START=${V_START}이 사전등록 시작일 ${V2_START}과 다르다 — 중단`);
    const fails: string[] = [];
    const rngV = mulberry32(20261121);
    const vb1 = mkVB("VB1", VB1_P0, VB1_NB), vb1f = mkVB1F();
    const cV = startOf(vb1, false), Wd = windowsV(cV);
    let nChk = 0;
    for (let t = 0; t < 40; t++) {
      const days = monthEndIdx.filter((x) => x >= cStartV), c = days[Math.floor(rngV() * days.length)], el = bsElig(c, B5_BS_P0);
      if (!el.length) continue;
      const code = el[Math.floor(rngV() * el.length)], s = h.byCode.get(code) as S, d = CAL[c], i = s.idx.get(d) as number;
      let best: EqRec | undefined;
      for (const e of eqBy.get(code) ?? []) if (e.rcept < d && (!best || e.rcept > best.rcept || (e.rcept === best.rcept && e.cfs))) best = e;
      const x = pbrAt(c, s, VB1_P0.maxAge);
      const exp = !best ? Number.NaN : dayDiffV(best.rcept, d) > VB1_P0.maxAge || !(best.eq > 0) ? Number.NaN : (s.mcapRow[i] * 1e8) / best.eq;
      nChk++;
      if (!(Number.isNaN(exp) && Number.isNaN(x.pbr)) && !(Math.abs(exp - x.pbr) <= 1e-9 * Math.abs(exp))) fails.push(`PBR 불일치 ${code} ${d}: 모듈 ${x.pbr} 독립 ${exp}`);
      if (best && best.rcept >= d) fails.push(`미래 접수일 사용 ${code} ${d}`);
    }
    console.log(`[점검 1] PBR 독립 재계산 ${nChk}건 일치 확인(접수일 < 신호일 규칙 포함)`);
    // 시장 필터 독립 재계산: 069500 원주가 일수익률로 지수 수준을 따로 만들고 누적합으로 이동평균(당일 포함)을 구해 filterMult와 대조
    {
      const lv: number[] = [];
      let x = 1;
      for (let k = 0; k < nCal; k++) { const r = h.bhRet.get(CAL[k]); if (r !== undefined && Number.isFinite(r)) x *= 1 + r; lv.push(x); }
      const pre: number[] = [0];
      for (let k = 0; k < nCal; k++) pre.push(pre[k] + lv[k]);
      let n = 0, nSig = 0, nLow = 0, skipped = 0;
      for (const c of monthEndIdx.filter((k) => k >= cStartV)) {
        for (const ma of [B5_MA_DAYS, ...B5_MA_NB]) {
          const sma = (pre[c + 1] - pre[c - ma + 1]) / ma, exp = lv[c] < sma ? B5_FILTER_LOW : 1, got = filterMult(c, ma);
          if (Math.abs(lv[c] - sma) < 1e-9 * sma) { skipped++; continue; }
          n++;
          if (exp !== got) fails.push(`시장 필터 불일치 ${CAL[c]} MA${ma}: 모듈 ${got} 독립 ${exp}`);
          if (ma === B5_MA_DAYS) { nSig++; if (exp < 1) nLow++; }
        }
      }
      console.log(`[점검 2] 시장 필터 독립 재계산 ${n}건(월말 신호일 × 이동평균 ${[B5_MA_DAYS, ...B5_MA_NB].join("·")}일) 일치 확인${skipped ? `(경계 동률 ${skipped}건 제외)` : ""} | 200일 기준 필터 가동(주식 50%) 신호일 ${nLow}/${nSig}(${f2((nLow / Math.max(nSig, 1)) * 100)}%) | 지수 수준 첫 ${lv[0].toFixed(4)} 마지막 ${lv[nCal - 1].toFixed(4)}`);
    }
    // VB1F 구조
    {
      const cS = startOf(vb1f, true);
      if (cS !== cV) fails.push(`VB1F 첫 신호일 ${CAL[cS]} ≠ VB1 첫 신호일 ${CAL[cV]}`);
      const run = runS(vb1f, VB1_P0, cS, { ma: B5_MA_DAYS }, { lag: 1, detail: true });
      const hmax = Math.max(...run.nPos.map((x, k) => x - (run.nDefer[k] ?? 0)));
      let held: ReadonlySet<string> = new Set(), nT = 0;
      for (const c of vb1f.signalDays.filter((x) => x >= cS)) {
        const m = filterMult(c, B5_MA_DAYS), t = vb1f.targets(c, held, VB1_P0, m, true), sum = [...t.values()].reduce((a, x) => a + x, 0);
        nT++;
        if (t.size > VB1_P0.n) fails.push(`VB1F ${CAL[c]} 목표 종목 ${t.size} > ${VB1_P0.n}`);
        if (Math.abs(sum - (t.size / VB1_P0.n) * m) > 1e-12) fails.push(`VB1F ${CAL[c]} 목표 비중 합 ${sum} ≠ ${(t.size / VB1_P0.n) * m}`);
        held = new Set(t.keys());
      }
      console.log(`[점검 3] VB1F: 첫 신호일 ${CAL[cS]}, 수익률 집계 ${Wd.FULL.from}~${h.dataEnd}, 구간 ${Wd.NW.map(([nm]) => nm).join(" / ")} | 신호일 ${nT}개 목표 비중 합 = 종목 수/30 × 필터 배수 확인 | 보유 종목 수 최대(순연 제외) ${hmax} (목표 ${VB1_P0.n}) | 진입 ${run.entryCs.length}건`);
      if (hmax > VB1_P0.n) fails.push(`VB1F 보유 종목 수 ${hmax} > ${VB1_P0.n}`);
      if (run.entryCs[0] !== undefined && run.entryCs[0] !== cS + 1) fails.push(`VB1F 첫 체결일 ${CAL[run.entryCs[0]]} ≠ 첫 신호일 다음 거래일 ${CAL[cS + 1]}`);
    }
    // DS14 구조·합성 회계
    {
      const d = d14Of(cV, Wd), b = d.base, n = b.res.run.dates.length;
      console.log(`[점검 4] DS14: 하위 계좌 ${b.sls.map((x) => `${x.dates[0]}~${x.dates[x.dates.length - 1]}(${x.dates.length}일)`).join(" | ")} | 월말 재조정 신호일 ${d.sigSet.size}개(첫 ${[...d.sigSet][0]}) | 진입 코어 ${b.core.entryCs.length}·모멘텀 ${b.rm.entryCs.length}·가치 ${b.va.entryCs.length}건`);
      if (b.sls.some((x) => x.dates.length !== n || x.dates[0] !== d.from)) fails.push("DS14 하위 계좌 날짜 축·시작일");
      if (b.rm.entryCs[0] !== cV + 1) fails.push(`DS14 모멘텀 첫 체결일 ${CAL[b.rm.entryCs[0]]} ≠ ${CAL[cV + 1]}`);
      if (b.va.entryCs[0] !== cV + 1) fails.push(`DS14 가치 첫 체결일 ${CAL[b.va.entryCs[0]]} ≠ ${CAL[cV + 1]}`);
      const ptRm = pathTgG(RM1, cV), ptVa = pathTgG(d.vb, cV);
      console.log(`  월말 신호일 수 모멘텀 ${ptRm.length} · 가치 ${ptVa.length}`);
      if (ptRm.length !== ptVa.length || ptRm.some((x, k) => x.c !== ptVa[k].c)) fails.push("DS14 모멘텀·가치 신호일 불일치");
      // 가치 위성이 VB1 단독 실행과 일치(정의 그대로)
      const solo = runS(vb1, VB1_P0, cV, null, { lag: 1, detail: true });
      const dv0 = Math.max(...solo.ret.map((x, i) => Math.abs(x - b.va.ret[i])), solo.ret.length === b.va.ret.length ? 0 : Number.POSITIVE_INFINITY);
      console.log(`  가치 위성 = VB1 단독 일수익률 최대 편차 ${dv0.toExponential(2)} ${dv0 <= 1e-12 ? "통과" : "불일치"}`);
      if (!(dv0 <= 1e-12)) fails.push("가치 위성 ≠ VB1");
      // 값 기반 독립 재계산(단위·지수 수준 방식), 월말 재조정 설정
      const w0 = V2_W, m = 3, L = new Array<number>(m).fill(1), u = [...w0], q: number[][] = [], ret: number[] = [];
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
      console.log(`  합성 회계 독립 재계산(단위·지수 수준 방식) vs combineN(월말 재조정, 40/30/30): 일수익률 최대 편차 ${dv.toExponential(2)} ${dv <= 1e-9 ? "통과" : "불일치"}`);
      if (!(dv <= 1e-9)) fails.push("DS14 합성 회계 불일치");
      const wDev = [0, 1, 2].map((j) => Math.max(...b.res.wEnd.map((w) => Math.abs(w[j] - w0[j]))) * 100);
      console.log(`  월말 재조정 후 하위 계좌 비중 목표 대비 최대 이탈 ${wDev.map((x) => f2(x)).join(" / ")}%p`);
      if (b.res.wEnd.some((w) => !w.every(Number.isFinite) || Math.abs(w.reduce((a, x) => a + x, 0) - 1) > 1e-9)) fails.push("DS14 비중 합 ≠ 1");
    }
    console.log(`의심 종목-일 0% 처리(ZERO_SUSPECT): ${ZERO_SUSPECT_ON ? `적용 ${suspectLog.length}건` : "미적용"}`);
    console.log(`\n정보용 항목 구현 목록(시험 출력에서 이 머리표로 대조): [I1] 일간 수익률 상관계수 · [I2] VB1 MDD 구간과 069500·KOSPI·KOSDAQ 등락 · [I3] VB1 삼성전자·SK하이닉스 보유 · [I4] VB1 2025~2026 손실 업종·시장 · [I5] VB1F 필터 가동 비율·기여(공통 보고의 "필터 보고") · [I6] DS14 손익 분해 · [I7] DS14 삼성전자·SK하이닉스 평균 비중 · [I8] 하루 지연(C) 줄 · [I9] 처리 없음 비교(v2info) · [I10] 누적 시험·우연 통과 기대(요약) + [R3] 연도별 DS13L 대비 · [R5] 나란히 비교 표`);
    if (fails.length) { console.log(`\n사전 점검 실패 ${fails.length}건:\n${fails.join("\n")}`); throw new Error("저평가 후속 사전 점검 실패 — 시험을 시작하지 않고 중단해 보고한다"); }
    console.log(`\n저평가 후속 사전 점검 통과(성과는 계산·출력하지 않았다) | ${storageLine()}`);
    return;
  }
  if (MODE === "v2info") {
    // 정보용(시험 아님, 시험 번호·게이트 없음): VB1·VB1F·DS14·DS13L 기준 실행의 구간별 CAGR/MDD — 데이터 처리(810건 0% 처리 유무) 비교용.
    await loadEqTables();
    requireStart();
    if (V_START !== V2_START) throw new Error(`V_START=${V_START}이 사전등록 시작일 ${V2_START}과 다르다 — 중단`);
    const vb1 = mkVB("VB1", VB1_P0, VB1_NB), vb1f = mkVB1F(), cV = startOf(vb1, false), Wx = windowsV(cV);
    const rows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [
      { nm: "VB1", run: runS(vb1, VB1_P0, cV, null, { lag: 1, detail: true }) },
      { nm: "VB1F", run: runS(vb1f, VB1_P0, cV, { ma: B5_MA_DAYS }, { lag: 1, detail: true }) },
      { nm: "DS14", run: d14Of(cV, Wx).base.res.run },
      { nm: "DS13L", run: d13Of("LV1", cV, Wx).base.res.run },
      { nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run },
    ];
    console.log(`\n=== [I9] 정보용: ${ZERO_SUSPECT_ON ? `의심 종목-일 0% 처리 적용(${suspectLog.length}건)` : "의심 종목-일 처리 없음"} — CAGR % / MDD % (같은 구간 ${Wx.FULL.from}~) ===\n| 구간 | ${rows.map((r) => r.nm).join(" | ")} |\n|---|${rows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${rows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    console.log(`\n정보용 실행 종료(시험 아님) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "intpre") {
    await intradayPre(h, label);
    console.log(`\n${storageLine()} | 연구 DB 쓰기 0 | 외부 요청 0 | DART·KIS 호출 0`);
    return;
  }
  if (MODE === "inttest") {
    await intradayTest(h, label, { dates: h.bhP.dates, ret: h.bhP.ret }, Number(process.env.B5_TRIAL ?? "318"));
    console.log(`\n${storageLine()} | 연구 DB 쓰기 0 | 외부 요청 0 | DART·KIS 호출 0`);
    return;
  }
  if (MODE === "qdata") {
    // 재무 품질(ROE) 데이터 확인(집계만, 수익·신호 계산 없음): docs/research/quality-data-check.md. 연구 R fin.parquet(2015~)과 2011~2015 백필(fin_pre2016.parquet)의 당기순이익·자본총계 확보율.
    await loadEqTables();
    const { fin, pre, repsR, repsPre } = await loadRoeReps();
    const isoD = (d: unknown): string => { const x = String(d ?? ""); return /^\d{8}$/.test(x) ? `${x.slice(0, 4)}-${x.slice(4, 6)}-${x.slice(6)}` : x.slice(0, 10); };
    const reps: FinRep[] = [...repsR, ...repsPre];
    const useBoth = process.env.Q_PRE !== "0";
    console.log(`\n=== [Q0] 재무 자료 구성 ===\nR fin.parquet(2015~): ${fin.length}행, 열 ${Object.keys(fin[0]).join(",")}`);
    console.log(`2011~2015 백필 fin_pre2016.parquet: ${pre.length}행, 열 ${Object.keys(pre[0]).join(",")} → **당기순이익 열 ${Object.keys(pre[0]).some((k) => /^ni|net/i.test(k)) ? "있음" : "없음(자본총계·지배주주지분만 수집)"}**`);
    const cnt = (f: (r: FinRep) => boolean): number => repsR.filter(f).length;
    console.log(`R fin 보고서 종류: ${["11013", "11012", "11014", "11011"].map((rc) => `${rc} ${cnt((r) => r.rc === rc)}`).join(" · ")} | 연결 ${cnt((r) => r.fs === "CFS")} · 별도 ${cnt((r) => r.fs === "OFS")} | 상태 orig ${cnt((r) => r.status === "orig")} · 정정 ${cnt((r) => r.status !== "orig")} | 사업연도 ${[...new Set(reps.map((r) => r.year))].sort().join(",")}`);
    console.log(`백필 보고서 종류(kind): ${[...pre.reduce((m2, r) => m2.set(String(r.kind), (m2.get(String(r.kind)) ?? 0) + 1), new Map<string, number>()).entries()].map(([k, v]) => `${k} ${v}`).join(" · ")} | 백필 기준일 범위 ${pre.map((r) => isoD(r.rcept_dt)).sort()[0]}~${pre.map((r) => isoD(r.rcept_dt)).sort().pop()}`);
    // 누적치 확인: 반기·3분기의 당기누적(ni_a)이 (당기 3개월 + 직전 분기 누적)과 일치하는가
    {
      const byK = new Map<string, FinRep>();
      for (const r of repsR) byK.set(`${r.code}|${r.year}|${r.rc}|${r.fs}`, r);
      let nQ2 = 0, okQ2 = 0, nQ3 = 0, okQ3 = 0, nA = 0, nC = 0, q1same = 0, nQ1 = 0;
      for (const r of repsR) {
        if (r.rc === "11012" && r.niA !== null && r.niC !== null) { const q1 = byK.get(`${r.code}|${r.year}|11013|${r.fs}`); if (q1 && q1.niC !== null) { nQ2++; if (Math.abs(r.niA - (r.niC + q1.niC)) <= 1e-6 * Math.max(Math.abs(r.niA), 1)) okQ2++; } if (r.niA !== r.niC) nA++; nC++; }
        if (r.rc === "11014" && r.niA !== null && r.niC !== null) { const q2 = byK.get(`${r.code}|${r.year}|11012|${r.fs}`); if (q2 && q2.niA !== null) { nQ3++; if (Math.abs(r.niA - (q2.niA + r.niC)) <= 1e-6 * Math.max(Math.abs(r.niA), 1)) okQ3++; } if (r.niA !== r.niC) nA++; nC++; }
        if (r.rc === "11013" && r.niA !== null && r.niC !== null) { nQ1++; if (r.niA === r.niC) q1same++; }
      }
      const have = (rc: string, f: (r: FinRep) => number | null): string => `${f2((repsR.filter((r) => r.rc === rc && f(r) !== null).length / Math.max(cnt((r) => r.rc === rc), 1)) * 100)}%`;
      console.log(`\n=== [Q1] 분기 보고서 누적치 확인 ===`);
      console.log(`반기(11012): 당기누적 ≠ 당기(3개월)인 비율 ${f2((nA / Math.max(nC, 1)) * 100)}%(반기·3분기 합산 ${nC}건) | 반기 누적 = 당기 + 1분기 당기: ${okQ2}/${nQ2} 일치 | 3분기(11014) 누적 = 당기 + 반기 누적: ${okQ3}/${nQ3} 일치 | 1분기(11013) 당기 = 당기누적: ${q1same}/${nQ1}`);
      console.log(`값 확보율(그 보고서 종류 안): 당기순이익 당기 ni_c — 1분기 ${have("11013", (r) => r.niC)} 반기 ${have("11012", (r) => r.niC)} 3분기 ${have("11014", (r) => r.niC)} 사업 ${have("11011", (r) => r.niC)} | 당기누적 ni_a — 반기 ${have("11012", (r) => r.niA)} 3분기 ${have("11014", (r) => r.niA)} | 전기 ni_p — 1분기 ${have("11013", (r) => r.niP)} 사업 ${have("11011", (r) => r.niP)} | 전기누적 ni_pa — 반기 ${have("11012", (r) => r.niPA)} 3분기 ${have("11014", (r) => r.niPA)} | 자본총계 eq_c — 전체 ${f2((repsR.filter((r) => r.eqC !== null).length / repsR.length) * 100)}%`);
    }
    // 월말 커버리지(BS1 적격 종목 기준 종목 수): 자본(PBR 가능) · 당기순이익 TTM 계산 가능 · ROE 대상(자본>0 ∧ TTM>0)
    const idx = makeRoeIndex(useBoth ? reps : repsR), cV0 = monthEndIdx.find((c) => CAL[c] >= "2011-05-31") as number, mes = monthEndIdx.filter((c) => c >= cV0);
    const per = new Map<string, { n: number; el: number; pbr: number; ttm: number; roe: number; why: Map<RoeWhy, number> }>(), monthly: string[] = [];
    let firstOk = "";
    const covByMonth: { d: string; c: number }[] = [];
    for (const c of mes) {
      const d = CAL[c], el = bsElig(c, B5_BS_P0), w = new Map<RoeWhy, number>();
      let pbrN = 0, ttmN = 0, roeN = 0;
      for (const code of el) {
        const s = h.byCode.get(code) as S;
        if (pbrAt(c, s, 400).why === "ok") pbrN++;
        const r = idx.roeAt(code, d, 400);
        w.set(r.why, (w.get(r.why) ?? 0) + 1);
        if (r.why === "ok" || r.why === "ttm_nonpos" || r.why === "eq_nonpos") { if (r.ttm !== undefined) ttmN++; }
        if (r.why === "ok") roeN++;
      }
      const y = d.slice(0, 4), e = per.get(y) ?? { n: 0, el: 0, pbr: 0, ttm: 0, roe: 0, why: new Map<RoeWhy, number>() };
      e.n++; e.el += el.length; e.pbr += pbrN; e.ttm += ttmN; e.roe += roeN; for (const [k, v] of w) e.why.set(k, (e.why.get(k) ?? 0) + v);
      per.set(y, e);
      covByMonth.push({ d, c: ttmN / Math.max(el.length, 1) });
      if (y >= "2016" && y <= "2017") monthly.push(`${d} 적격 ${el.length} 자본 ${f2((pbrN / el.length) * 100)}% TTM 가능 ${f2((ttmN / el.length) * 100)}% ROE 대상 ${f2((roeN / el.length) * 100)}%`);
    }
    for (let i = 0; i < covByMonth.length; i++) if (covByMonth.slice(i).every((x) => x.c >= 0.6)) { firstOk = covByMonth[i].d; break; }
    console.log(`\n=== [Q2] 월말 커버리지(BS1 적격 종목 수 기준, 연도별 월말 평균 %): 자본총계(PBR 가능) · 당기순이익 TTM 계산 가능(자본·TTM 부호 무관) · ROE 대상(자본 > 0 ∧ TTM > 0) ===\n| 연도 | 월수 | 월평균 적격 종목 | 자본 확보 % | TTM 계산 가능 % | ROE 대상 % | 제외 사유 %(보고서 없음 / 경과 400일 초과 / 직전 사업보고서 없음 / 순이익 값 없음 / 자본 값 없음 / 자본 ≤ 0 / TTM ≤ 0) |\n|---|---|---|---|---|---|---|`);
    for (const [y, e] of [...per.entries()].sort()) {
      const w = (k: RoeWhy): string => f2(((e.why.get(k) ?? 0) / Math.max(e.el, 1)) * 100);
      console.log(`| ${y} | ${e.n} | ${f2(e.el / e.n)} | ${f2((e.pbr / e.el) * 100)} | ${f2((e.ttm / e.el) * 100)} | ${f2((e.roe / e.el) * 100)} | ${w("no_report")} / ${w("stale")} / ${w("no_annual")} / ${w("null_ni")} / ${w("null_eq")} / ${w("eq_nonpos")} / ${w("ttm_nonpos")} |`);
    }
    console.log(`\n2016~2017 월별: ${monthly.join(" | ")}`);
    const at0 = covByMonth[0];
    console.log(`\n=== [Q3] 중단 조건 판정(TTM 계산 가능 종목이 월말 종목 수의 60% 미만이면 시험하지 않는다) ===\n사전 시작일 ${at0.d} 월말 TTM 계산 가능 ${f2(at0.c * 100)}% (< 60%) | 60% 이상이 처음 되고 이후 계속 유지되는 첫 월말: ${firstOk || "없음"} | 2011~2015 월말 중 60% 이상인 달 ${covByMonth.filter((x) => x.d < "2016-01-01" && x.c >= 0.6).length}/${covByMonth.filter((x) => x.d < "2016-01-01").length}개`);
    const nPre = pre.length, nPreKind = pre.reduce((m2, r) => m2.set(String(r.kind), (m2.get(String(r.kind)) ?? 0) + 1), new Map<string, number>());
    console.log(`\n=== [Q4] 필요한 수집(보고만) ===\n백필 보고서 ${nPre}건(자본 있음 ${pre.filter((r) => typeof r.eq_total === "number").length}건) 종류별 ${[...nPreKind.entries()].map(([k, v]) => `${k} ${v}`).join(" · ")}. 당기순이익은 수집하지 않았으므로 2011~2015 TTM 계산에는 같은 보고서(XBRL 재무제표)에서 당기순이익·분기·반기 당기누적·전년 같은 기간 값을 다시 파싱해야 한다(원문은 저장하지 않았다).`);
    console.log(`\n${storageLine()} | 연구 DB 쓰기 0 | 외부 요청 0 | DART·KIS 호출 0`);
    return;
  }
  if (MODE === "mininsp2") {
    await intradayStats(h, label);
    console.log(`\n${storageLine()} | 연구 DB 쓰기 0 | 외부 요청 0 | DART·KIS 호출 0`);
    return;
  }
  if (MODE === "mininsp") {
    // 분봉 데이터 점검 1단계(집계만, 수익·신호·성과 계산 없음). docs/research/intraday-design.md 1절.
    await intradayInspect(h, label, { dates: h.bhP.dates, ret: h.bhP.ret });
    console.log(`\n${storageLine()} | 연구 DB 쓰기 0 | 외부 요청 0 | DART·KIS 호출 0`);
    return;
  }
  if (MODE === "v3pre") {
    // 저PBR 대형주 사전 점검(성과 미계산): DS6 재현(위 줄), PBR 독립 재계산, K200P(PIT)·유니버스 독립 재계산, VL1 구조, VL1C 날짜 축, 후보 수, 정보용 항목 목록.
    await loadEqTables();
    requireStart();
    if (V_START !== V2_START) throw new Error(`V_START=${V_START}이 사전등록 시작일 ${V2_START}과 다르다 — 중단`);
    const fails: string[] = [];
    const rngV = mulberry32(20261122);
    const vl1 = mkVL("VL1", VL1_P0, VL1_NB), cV = startOf(vl1, false), Wd = windowsV(cV), days = monthEndIdx.filter((x) => x >= cStartV);
    let nChk = 0;
    for (let t = 0; t < 40; t++) {
      const c = days[Math.floor(rngV() * days.length)], el = bsElig(c, B5_BS_P0);
      if (!el.length) continue;
      const code = el[Math.floor(rngV() * el.length)], s = h.byCode.get(code) as S, d = CAL[c], i = s.idx.get(d) as number;
      let best: EqRec | undefined;
      for (const e of eqBy.get(code) ?? []) if (e.rcept < d && (!best || e.rcept > best.rcept || (e.rcept === best.rcept && e.cfs))) best = e;
      const x = pbrAt(c, s, VB1_P0.maxAge);
      const exp = !best ? Number.NaN : dayDiffV(best.rcept, d) > VB1_P0.maxAge || !(best.eq > 0) ? Number.NaN : (s.mcapRow[i] * 1e8) / best.eq;
      nChk++;
      if (!(Number.isNaN(exp) && Number.isNaN(x.pbr)) && !(Math.abs(exp - x.pbr) <= 1e-9 * Math.abs(exp))) fails.push(`PBR 불일치 ${code} ${d}: 모듈 ${x.pbr} 독립 ${exp}`);
      if (best && best.rcept >= d) fails.push(`미래 접수일 사용 ${code} ${d}`);
    }
    console.log(`[점검 1] PBR 독립 재계산 ${nChk}건 일치 확인(접수일 < 신호일 규칙 포함)`);
    // K200P(PIT)·유니버스 독립 재계산: 모든 종목을 직접 훑어 코스피 시총 상위 200을 만들고 VL1·시총 상위 300 후보 정렬을 따로 만들어 대조
    {
      let nU = 0;
      for (let t = 0; t < 30; t++) {
        const c = days[Math.floor(rngV() * days.length)], d = CAL[c], m = membAt(d);
        const e: { code: string; mc: number }[] = [];
        if (m) for (const s of h.stocks) { const i = s.idx.get(d); if (i === undefined || excluded.has(s.code) || m.get(s.code) !== "KOSPI") continue; e.push({ code: s.code, mc: s.mcapRow[i] }); }
        e.sort((a, b) => b.mc - a.mc || (a.code < b.code ? -1 : 1));
        const k = new Set(e.slice(0, 200).map((x) => x.code)), mod = rank200(c).list.map((s) => s.code);
        if (mod.length !== Math.min(200, e.length) || mod.some((code, j) => code !== e[j].code)) fails.push(`K200P(PIT) 불일치 ${d}`);
        const el = bsElig(c, B5_BS_P0), pb = (code: string): number => pbrAt(c, h.byCode.get(code) as S, VB1_P0.maxAge).pbr;
        const brute = el.filter((code) => k.has(code) && Number.isFinite(pb(code))).sort((a, b) => pb(a) - pb(b) || (a < b ? -1 : 1));
        const got = vlSorted(c, VL1_P0);
        if (brute.length !== got.length || brute.some((code, j) => code !== got[j])) fails.push(`VL1 후보 불일치 ${d}: 모듈 ${got.length} 독립 ${brute.length}`);
        const top = [...el].map((code) => ({ code, mc: (h.byCode.get(code) as S).mcapRow[(h.byCode.get(code) as S).idx.get(d) as number] })).sort((a, b) => b.mc - a.mc || (a.code < b.code ? -1 : 1)).slice(0, V3_TOP_N).map((x) => x.code);
        const topSet = new Set(top), brute3 = [...topSet].filter((code) => Number.isFinite(pb(code))).sort((a, b) => pb(a) - pb(b) || (a < b ? -1 : 1)), got3 = vlSorted(c, { ...VL1_P0, univ: "top300" });
        if (brute3.length !== got3.length || brute3.some((code, j) => code !== got3[j])) fails.push(`시총 상위 ${V3_TOP_N} 후보 불일치 ${d}`);
        nU++;
      }
      console.log(`[점검 2] K200P(PIT)·VL1 후보·시총 상위 ${V3_TOP_N} 후보 독립 재계산(전 종목 직접 훑기) ${nU}개 월말 일치 확인`);
    }
    // VL1 구조·후보 수
    {
      const cS = startOf(vl1, false);
      if (cS !== cV) fails.push("VL1 첫 신호일 불일치");
      const run = runS(vl1, VL1_P0, cS, null, { lag: 1, detail: true });
      const hmax = Math.max(...run.nPos.map((x, k) => x - (run.nDefer[k] ?? 0)));
      const cnt = vl1.signalDays.filter((x) => x >= cS).map((c) => vlSorted(c, VL1_P0).length);
      console.log(`[점검 3] VL1: 첫 신호일 ${CAL[cS]}, 수익률 집계 ${Wd.FULL.from}~${h.dataEnd}, 구간 ${Wd.NW.map(([nm]) => nm).join(" / ")} | 보유 종목 수 최대(순연 제외) ${hmax} (목표 ${VL1_P0.n}) | 진입 ${run.entryCs.length}건 | 신호일 ${cnt.length}개, 후보 수 최소 ${Math.min(...cnt)} 평균 ${f2(avg(cnt))} 최대 ${Math.max(...cnt)}, 후보 ${VL1_P0.n}개 미만인 월 ${cnt.filter((x) => x < VL1_P0.n).length}개`);
      if (hmax > VL1_P0.n) fails.push(`VL1 보유 종목 수 ${hmax} > ${VL1_P0.n}`);
      if (run.entryCs[0] !== undefined && run.entryCs[0] !== cS + 1) fails.push(`VL1 첫 체결일 ${CAL[run.entryCs[0]]} ≠ ${CAL[cS + 1]}`);
      const inK = run.trades.concat(run.open).every((t) => { const s = h.byCode.get(t.code) as S; return rank200(Math.max(t.entryC - 1, 0)).rank.has(t.code) || !s; });
      if (!inK) fails.push("VL1 진입 종목이 진입 신호일 K200P(PIT)가 아니다");
      const coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, Wd.FULL.from), sat = slFromRun(run);
      console.log(`[점검 4] VL1C: 코어 ${coreFull.dates[0]}~${coreFull.dates[coreFull.dates.length - 1]}(${coreFull.dates.length}일) · 위성 ${sat.dates[0]}~${sat.dates[sat.dates.length - 1]}(${sat.dates.length}일) 날짜 축 ${coreFull.dates.length === sat.dates.length && coreFull.dates.every((x, k) => x === sat.dates[k]) ? "일치" : "불일치"}`);
      if (coreFull.dates.length !== sat.dates.length || coreFull.dates.some((x, k) => x !== sat.dates[k])) fails.push("VL1C 날짜 축");
    }
    console.log(`의심 종목-일 0% 처리(ZERO_SUSPECT): ${ZERO_SUSPECT_ON ? `적용 ${suspectLog.length}건` : "미적용"}`);
    console.log(`\n정보용 항목 구현 목록(시험 출력에서 이 머리표로 대조): [J1] VB1 MDD 구간 시총 3분위 손익 분해 · [J2] 일간 수익률 상관계수 · [J3] 평균 PBR · [J4] 삼성전자·SK하이닉스 보유·평균 비중 · [J5] 하루 지연(C) 줄 · [J6] 후보 수·30개 미만 월 · [J7] 처리 없음 비교(v3info) · [J8] 누적 시험·우연 통과 기대(요약) + [R3] 연도별 DS13L 대비 · [R5] 나란히 비교 표`);
    if (fails.length) { console.log(`\n사전 점검 실패 ${fails.length}건:\n${fails.join("\n")}`); throw new Error("저PBR 대형주 사전 점검 실패 — 시험을 시작하지 않고 중단해 보고한다"); }
    console.log(`\n저PBR 대형주 사전 점검 통과(성과는 계산·출력하지 않았다) | ${storageLine()}`);
    return;
  }
  if (MODE === "qpre") {
    // 재무 품질(ROE) 사전 점검(성과 미계산): DS6 재현(위 줄), ROE 독립 재계산, 보유 수·첫 체결일, QV1 점수 독립 재계산, 후보 수, VB1 재현, 정보용 항목 목록.
    await loadEqTables();
    await loadRoe();
    requireStart();
    const fails: string[] = [];
    const rngQ = mulberry32(20261123);
    const q1 = mkQ("Q1", Q1_P0, Q1_NB), qv1 = mkQ("QV1", QV1_P0, QV1_NB), cQ = startOf(q1, false), Wd = windowsV(cQ), days = monthEndIdx.filter((x) => x >= cStartV);
    console.log(`시험 설정: ${V_CASE}, 시작 월말 ${V_START}(사전등록 계획 ${Q_PLANNED_START}${V_START === Q_PLANNED_START ? "과 같음" : "에서 완화됨 — quality-prereg.md에 사유 기록"}), 구간 ${Wd.NW.map(([nm]) => nm).join(" / ")}`);
    // [점검 1] ROE 독립 재계산: 같은 보고서 자료에서 따로 짠 직접 계산과 비교 + 접수일 < 신호일
    {
      const all = await loadRoeReps(), flat = [...all.repsR, ...all.repsPre], byC = new Map<string, FinRep[]>();
      for (const r of flat) { const a = byC.get(r.code) ?? []; a.push(r); byC.set(r.code, a); }
      const ord: Record<string, number> = { "11013": 1, "11012": 2, "11014": 3, "11011": 4 };
      const brute = (code: string, d: string, maxAge: number): { why: string; roe?: number } => {
        const rs = byC.get(code) ?? [], best = new Map<string, FinRep>();
        for (const r of rs) { const k = `${r.year}|${r.rc}`, o = best.get(k); if (!o || (r.fs === "CFS" && o.fs !== "CFS")) best.set(k, r); }
        const avail = [...best.values()].filter((r) => r.rcept < d).sort((a, b) => a.year * 10 + ord[a.rc] - (b.year * 10 + ord[b.rc]) || (a.rceptNo < b.rceptNo ? -1 : 1));
        const F = avail[avail.length - 1];
        if (!F) return { why: "no_report" };
        if ((Date.parse(d) - Date.parse(F.rcept)) / 86_400_000 > maxAge) return { why: "stale" };
        let ttm: number;
        if (F.rc === "11011") { if (F.niC === null) return { why: "null_ni" }; ttm = F.niC; }
        else {
          const an = avail.find((r) => r.rc === "11011" && r.year === F.year - 1 && r.rcept < F.rcept);
          if (!an) return { why: "no_annual" };
          const ytd = F.rc === "11013" ? F.niC : F.niA, pv = F.rc === "11013" ? F.niP : F.niPA;
          if (an.niC === null || ytd === null || pv === null) return { why: "null_ni" };
          ttm = an.niC + ytd - pv;
        }
        if (F.eqC === null) return { why: "null_eq" };
        if (!(F.eqC > 0)) return { why: "eq_nonpos" };
        if (!(ttm > 0)) return { why: "ttm_nonpos" };
        return { why: "ok", roe: ttm / F.eqC };
      };
      let nChk = 0, nOk = 0;
      const whyCnt = new Map<string, number>();
      for (let t = 0; t < 400; t++) {
        const c = days[Math.floor(rngQ() * days.length)], el = bsElig(c, B5_BS_P0);
        if (!el.length) continue;
        const code = el[Math.floor(rngQ() * el.length)], d = CAL[c], a = roeOf(code, d, 400), b = brute(code, d, 400);
        nChk++; whyCnt.set(a.why, (whyCnt.get(a.why) ?? 0) + 1);
        if (a.why !== b.why) fails.push(`ROE 사유 불일치 ${code} ${d}: 모듈 ${a.why} 독립 ${b.why}`);
        else if (a.why === "ok") { nOk++; if (!(Math.abs((a.roe as number) - (b.roe as number)) <= 1e-9 * Math.abs(b.roe as number))) fails.push(`ROE 값 불일치 ${code} ${d}: ${a.roe} vs ${b.roe}`); }
      }
      console.log(`[점검 1] ROE 독립 재계산 ${nChk}건(값 비교 ${nOk}건) 일치 확인(접수일 < 신호일 규칙 포함) | 사유 분포 ${[...whyCnt.entries()].map(([k, v]) => `${k} ${v}`).join(" · ")}`);
    }
    // [점검 2] 구조: 보유 수·첫 체결일·진입 종목의 ROE 유효성
    for (const [id, def, P0] of [["Q1", q1, Q1_P0], ["QV1", qv1, QV1_P0]] as [string, Strat<QP>, QP][]) {
      const run = runS(def, P0, cQ, null, { lag: 1, detail: true });
      const hmax = Math.max(...run.nPos.map((x, k) => x - (run.nDefer[k] ?? 0)));
      const cnt = def.signalDays.filter((x) => x >= cQ).map((c) => qSorted(c, P0).length);
      console.log(`[점검 2] ${id}: 첫 신호일 ${CAL[cQ]}, 수익률 집계 ${Wd.FULL.from}~${h.dataEnd} | 보유 종목 수 최대(순연 제외) ${hmax} (목표 ${P0.n}) | 첫 체결일 ${CAL[run.entryCs[0]]} (신호일 다음 거래일 ${CAL[cQ + 1]}) | 진입 ${run.entryCs.length}건 | 신호일 ${cnt.length}개, 후보 수 최소 ${Math.min(...cnt)} 평균 ${f2(avg(cnt))} 최대 ${Math.max(...cnt)}, 후보 ${P0.n}개 미만인 월 ${cnt.filter((x) => x < P0.n).length}개`);
      if (hmax > P0.n) fails.push(`${id} 보유 종목 수 ${hmax} > ${P0.n}`);
      if (run.entryCs[0] !== undefined && run.entryCs[0] !== cQ + 1) fails.push(`${id} 첫 체결일 ${CAL[run.entryCs[0]]} ≠ ${CAL[cQ + 1]}`);
      const bad = run.trades.concat(run.open).filter((t) => roeOf(t.code, CAL[t.entryC - 1], P0.maxAge).why !== "ok").length;
      if (bad) fails.push(`${id} 진입 종목 중 신호일 ROE가 없는 경우 ${bad}건`);
      if (id === "QV1") {
        const bad2 = run.trades.concat(run.open).filter((t) => pbrAt(t.entryC - 1, h.byCode.get(t.code) as S, P0.maxAge).why !== "ok").length;
        if (bad2) fails.push(`QV1 진입 종목 중 신호일 PBR이 없는 경우 ${bad2}건`);
      }
      const coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, Wd.FULL.from), sat = slFromRun(run);
      if (coreFull.dates.length !== sat.dates.length || coreFull.dates.some((x, k) => x !== sat.dates[k])) fails.push(`${id}C 날짜 축`);
      else console.log(`[점검 2] ${id}C 날짜 축: 코어 ${coreFull.dates[0]}~${coreFull.dates[coreFull.dates.length - 1]}(${coreFull.dates.length}일) = 위성 일치`);
    }
    // [점검 3] QV1 점수 독립 재계산: 전 종목을 직접 훑어 백분위를 세어 상위 목록 대조
    {
      let nU = 0;
      for (let t = 0; t < 20; t++) {
        const c = days[Math.floor(rngQ() * days.length)], d = CAL[c], P = QV1_P0, rows: { code: string; pbr: number; roe: number }[] = [];
        for (const code of bsElig(c, B5_BS_P0)) { const r = roeOf(code, d, P.maxAge), x = pbrAt(c, h.byCode.get(code) as S, P.maxAge); if (r.why === "ok" && x.why === "ok") rows.push({ code, pbr: x.pbr, roe: r.roe as number }); }
        const pct = (vals: number[], v: number): number => { let lt = 0, eq = 0; for (const u of vals) { if (u < v) lt++; else if (u === v) eq++; } return rows.length > 1 ? (lt + (eq - 1) / 2) / (rows.length - 1) : 0; };
        const pv = rows.map((x) => x.pbr), rv = rows.map((x) => x.roe);
        const exp = rows.map((x) => ({ code: x.code, sc: ((1 - pct(pv, x.pbr)) + pct(rv, x.roe)) / 2 })).sort((a, b) => b.sc - a.sc || (a.code < b.code ? -1 : 1)).map((x) => x.code), got = qSorted(c, P);
        if (exp.length !== got.length || exp.some((code, j) => code !== got[j])) fails.push(`QV1 점수 정렬 불일치 ${d}: 모듈 ${got.length} 독립 ${exp.length}`);
        const rg = qSorted(c, Q1_P0), er = bsElig(c, B5_BS_P0).map((code) => ({ code, r: roeOf(code, d, Q1_P0.maxAge) })).filter((x) => x.r.why === "ok").sort((a, b) => (b.r.roe as number) - (a.r.roe as number) || (a.code < b.code ? -1 : 1)).map((x) => x.code);
        if (er.length !== rg.length || er.some((code, j) => code !== rg[j])) fails.push(`Q1 ROE 정렬 불일치 ${d}`);
        nU++;
      }
      console.log(`[점검 3] Q1 ROE 정렬·QV1 점수(PBR 하위 백분위 + ROE 상위 백분위 ÷ 2) 독립 재계산(전 종목 직접 훑기) ${nU}개 월말 일치 확인`);
    }
    // [점검 4] VB1 재현(순이익 열 추가 뒤에도 자본 입력이 같은지): 기록 연속 10.07 / 64.17(시작 ${V2_START})
    {
      const vbRep: Strat<VbP> = { ...mkVB("VB1", VB1_P0, VB1_NB), signalDays: monthEndIdx.filter((c) => CAL[c] >= V2_START) };
      const cR = startOf(vbRep, false), run = runS(vbRep, VB1_P0, cR, null, { lag: 1, detail: true }), st = h.st(run, { from: CAL[cR + 1], to: "9999-12-31" });
      const ok = f2(st.cagr) === "10.07" && f2(st.mdd) === "64.17";
      console.log(`[점검 4] VB1 재현(시작 ${CAL[cR]}, 집계 ${CAL[cR + 1]}~): 연속 ${f2(st.cagr)} / ${f2(st.mdd)} (기록 10.07 / 64.17) → ${ok ? "일치" : "불일치"}`);
      if (!ok) fails.push("VB1 재현 불일치(자본 입력이 달라졌을 가능성)");
    }
    // [점검 5] TTM 커버리지(시작일 이후 매 월말, BS1 적격 기준)
    {
      const rows = days.map((c) => { const el = bsElig(c, B5_BS_P0), d = CAL[c]; let ttm = 0; for (const code of el) { const r = roeOf(code, d, 400); if (r.ttm !== undefined) ttm++; } return { d, v: ttm / Math.max(el.length, 1) }; });
      const mn = rows.reduce((a, x) => (x.v < a.v ? x : a), rows[0]);
      console.log(`[점검 5] TTM 계산 가능 비율(BS1 적격 종목 수 기준) 시작일 이후 ${rows.length}개 월말: 최소 ${f2(mn.v * 100)}%(${mn.d}) 평균 ${f2(avg(rows.map((x) => x.v)) * 100)}% | 60% 미만 월 ${rows.filter((x) => x.v < 0.6).length}개`);
      if (rows.some((x) => x.v < 0.6)) fails.push("시작일 이후 TTM 커버리지 60% 미만인 월이 있다");
    }
    console.log(`의심 종목-일 0% 처리(ZERO_SUSPECT): ${ZERO_SUSPECT_ON ? `적용 ${suspectLog.length}건` : "미적용"}`);
    console.log(`\n정보용 항목 구현 목록(시험 출력에서 이 머리표로 대조): [Q1] VB1 MDD 구간(2018-01-29~2020-03-23) Q1·QV1 구간 수익·낙폭 · [Q2] 보유 종목 평균 ROE·PBR · [Q3] 금융주 비중 · [Q4] 삼성전자·SK하이닉스 보유·평균 비중 · [Q5] 일간 수익률 상관계수(Q1·QV1·VB1·RM1·DS13L) · [Q6] 하루 지연(C) CAGR·MDD 변화(평가 출력의 "지연 버전" 줄 + 요약 표) · [Q7] TTM 계산 불가 제외 종목-월 비율 · [Q8] 누적 시험·우연 통과 기대(요약) + [R3] 연도별 069500·DS6·DS13L 대비 승패 · [R4] 승률·손익비·기대값(평가 출력의 "요약" 줄) · [R5] VB1·VB1C·DS13L 나란히 비교 표 · [R6] 연 회전율`);
    if (fails.length) { console.log(`\n사전 점검 실패 ${fails.length}건:\n${fails.join("\n")}`); throw new Error("재무 품질 사전 점검 실패 — 시험을 시작하지 않고 중단해 보고한다"); }
    console.log(`\n재무 품질 사전 점검 통과(성과는 계산·출력하지 않았다; 단 점검 4는 VB1 재현값, DS6 재현 줄은 환경 확인용) | ${storageLine()}`);
    return;
  }
  if (MODE === "qinfo") {
    // 정보용(시험 아님, 시험 번호·게이트 없음): Q1·QV1·QV1C·VB1·VB1C·DS13L 기준 실행의 구간별 CAGR/MDD — 데이터 처리(의심 종목-일 0% 처리 유무) 비교용.
    await loadEqTables();
    await loadRoe();
    requireStart();
    const q1 = mkQ("Q1", Q1_P0, Q1_NB), qv1 = mkQ("QV1", QV1_P0, QV1_NB), vb1 = mkVB("VB1", VB1_P0, VB1_NB), cQ = startOf(q1, false), Wx = windowsV(cQ);
    const coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, Wx.FULL.from);
    const q1Run = runS(q1, Q1_P0, cQ, null, { lag: 1, detail: true }), qvRun = runS(qv1, QV1_P0, cQ, null, { lag: 1, detail: true }), vbRun = runS(vb1, VB1_P0, cQ, null, { lag: 1, detail: true });
    const rows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [
      { nm: "Q1", run: q1Run }, { nm: "QV1", run: qvRun }, { nm: "QV1C", run: combine2(coreFull, slFromRun(qvRun), B5_CORE_W, CS_MOVE_COST).run },
      { nm: "VB1", run: vbRun }, { nm: "VB1C", run: combine2(coreFull, slFromRun(vbRun), B5_CORE_W, CS_MOVE_COST).run },
      { nm: "DS13L", run: d13Of("LV1", cQ, Wx).base.res.run }, { nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run },
    ];
    console.log(`\n=== [Q9] 정보용: ${ZERO_SUSPECT_ON ? `의심 종목-일 0% 처리 적용(${suspectLog.length}건)` : "의심 종목-일 처리 없음"} — CAGR % / MDD % (같은 구간 ${Wx.FULL.from}~) ===\n| 구간 | ${rows.map((r) => r.nm).join(" | ")} |\n|---|${rows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${rows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    console.log(`\n정보용 실행 종료(시험 아님) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "hpre") {
    // 52주 신고가 근접 사전 점검(성과 미계산): DS6 재현(위 줄, 불일치면 중단), 데이터 표준, 첫 신호일 정합, 점수·정렬 독립 재계산, 보유 수·첫 체결일, 날짜 축, 월 재조정 경로, 이웃값 후보 수, 소멸 관례, 정보용 항목 목록.
    const fails: string[] = [];
    const rngH = mulberry32(20261125);
    const hm1 = mkHM("HM1", HM1_P0, HM1_NB), cH = startOf(hm1, false), cR = startOf(RM1, false), Wd = windowsFor(cH), days = monthEndIdx.filter((x) => x >= cH);
    console.log(`[점검 1] 데이터 표준: 가격 보정 ${PRICE_CORRECTION_ON ? "k200p17 적용" : "미적용"} · 의심 종목-일 0% 처리 ${ZERO_SUSPECT_ON ? `적용 ${suspectLog.length}건` : "미적용"} | 소멸 관례: 마지막 종가 청산하되 직전 20거래일 중 거래정지 5일 이상이거나 마지막 종가 1,000원 미만이면 전액 손실(VB·VL·Q와 같은 vbVanishLoss) | 슬리피지 신호일 K200P 구성원 ${B5_BS_SLIP_K200 * 100}%·그 밖 ${B5_BS_SLIP_OTHER * 100}%`);
    if (!PRICE_CORRECTION_ON || !ZERO_SUSPECT_ON) fails.push("보정 또는 의심 종목-일 0% 처리 미적용(correct=k200p17 zero=1 필요)");
    console.log(`[점검 2] 첫 신호일: HM1 ${CAL[cH]} / RM1 ${CAL[cR]} | 수익률 집계 ${Wd.FULL.from}~${h.dataEnd} | 구간 ${Wd.NW.map(([nm, w]) => `${nm} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    if (cH !== cR) fails.push(`HM1 첫 신호일 ${CAL[cH]} ≠ RM1 첫 신호일 ${CAL[cR]}(DS13L 비교 구간이 어긋난다)`);
    // [점검 3] 점수·정렬 독립 재계산: 달력 인덱스·캐시를 쓰지 않고 종목의 종가 행을 날짜 문자열로 직접 훑는다(K200P(PIT) 목록은 앞선 repro·v3pre에서 독립 검증된 rank200 사용)
    {
      let nCk = 0, nCmp = 0;
      const sets: HmP[] = [HM1_P0, ...HM1_NB.map(([, ch]) => ({ ...HM1_P0, ...ch }))];
      for (let t = 0; t < 20; t++) {
        const c = days[Math.floor(rngH() * days.length)];
        for (const P of sets) {
          nCk++;
          const got = hmSorted(c, P);
          if (c - P.lookback < 0) { if (got.length) fails.push(`HM1 룩백 ${P.lookback} 신호일 ${CAL[c]}: 기간 부족인데 후보 ${got.length}개`); continue; }
          const rk = rank200(c), d0 = CAL[c - P.lookback], d1 = CAL[c - 1], dc = CAL[c], exp: { code: string; sc: number }[] = [];
          for (const s of rk.list) {
            let mx = Number.NEGATIVE_INFINITY, n = 0;
            for (const [d, i] of s.idx) if (d >= d0 && d <= d1) { n++; if (s.close[i] > mx) mx = s.close[i]; }
            const ic = s.idx.get(dc);
            if (ic === undefined || n < Math.ceil(P.lookback * P.minValidFrac) || !(mx > 0) || !Number.isFinite(s.close[ic])) continue;
            exp.push({ code: s.code, sc: s.close[ic] / mx });
          }
          exp.sort((x, y) => y.sc - x.sc || (rk.rank.get(x.code) as number) - (rk.rank.get(y.code) as number));
          if (exp.length !== got.length || exp.some((x, j) => x.code !== got[j].code || !(Math.abs(x.sc - got[j].sc) <= 1e-12))) fails.push(`HM1 점수·정렬 불일치 ${dc} 룩백 ${P.lookback}: 모듈 ${got.length} 독립 ${exp.length}`);
          else nCmp++;
        }
      }
      console.log(`[점검 3] HM1 점수(종가 ÷ 직전 lookback거래일 최고 종가, 당일 제외)·정렬 독립 재계산: ${nCk}건(기본 + 이웃 4개 × 월말 20개) 중 일치 ${nCmp}건(나머지는 룩백이 달력보다 길어 후보 없음 확인)`);
    }
    // [점검 4] 구조: 보유 수·첫 체결일·진입 종목의 후보 포함·소멸 처리
    {
      const run = runS(hm1, HM1_P0, cH, null, { lag: 1, detail: true });
      const hmax = Math.max(...run.nPos.map((x, k) => x - (run.nDefer[k] ?? 0)));
      const cnt = hm1.signalDays.filter((x) => x >= cH).map((c) => hmSorted(c, HM1_P0).length);
      console.log(`[점검 4] HM1: 보유 종목 수 최대(순연 제외) ${hmax} (목표 ${HM1_P0.n}) | 첫 체결일 ${CAL[run.entryCs[0]]} (신호일 다음 거래일 ${CAL[cH + 1]}) | 진입 ${run.entryCs.length}건 | 신호일 ${cnt.length}개, 후보 수 최소 ${Math.min(...cnt)} 평균 ${f2(avg(cnt))} 최대 ${Math.max(...cnt)}, 후보 ${HM1_P0.n}개 미만인 월 ${cnt.filter((x) => x < HM1_P0.n).length}개 | 평균 투자 비중 ${f2(avg(run.inv) * 100)}%`);
      if (hmax > HM1_P0.n) fails.push(`HM1 보유 종목 수 ${hmax} > ${HM1_P0.n}`);
      if (run.entryCs[0] !== undefined && run.entryCs[0] !== cH + 1) fails.push(`HM1 첫 체결일 ${CAL[run.entryCs[0]]} ≠ ${CAL[cH + 1]}`);
      const bad = run.trades.concat(run.open).filter((t) => !hmSorted(t.entryC - 1, HM1_P0).some((x) => x.code === t.code)).length;
      if (bad) fails.push(`HM1 진입 종목 중 신호일 후보가 아닌 경우 ${bad}건`);
      const closed = run.trades, vl = closed.filter((t) => t.reason === "폐지(전액 손실)").length, vs = closed.filter((t) => t.reason === "폐지").length;
      console.log(`[점검 4] HM1 소멸 종목 청산: 마지막 종가 청산 ${vs}건 · 전액 손실 ${vl}건(닫힌 거래 ${closed.length}건 중)`);
      const coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, Wd.FULL.from), sat = slFromRun(run);
      if (coreFull.dates.length !== sat.dates.length || coreFull.dates.some((x, k) => x !== sat.dates[k])) fails.push("HM1C 날짜 축");
      else console.log(`[점검 4] HM1C 날짜 축: 코어 ${coreFull.dates[0]}~${coreFull.dates[coreFull.dates.length - 1]}(${coreFull.dates.length}일) = 위성 일치`);
      // [점검 5] 월 리밸런스 경로: combineN을 매일 재조정(null)으로 돌린 결과가 combine2와 같은지, 월 신호일 집합이 HM1 월말 신호일과 같은지
      const a = combineN([coreFull, sat], [B5_CORE_W, 1 - B5_CORE_W], CS_MOVE_COST, null).run.ret, b = combine2(coreFull, sat, B5_CORE_W, CS_MOVE_COST).run.ret;
      let mxd = 0;
      for (let k = 0; k < a.length; k++) mxd = Math.max(mxd, Math.abs(a[k] - b[k]));
      const sig = [...new Set(monthEndIdx.filter((c) => c > cH).map((c) => CAL[c]))], sg1 = hm1.signalDays.filter((c) => c > cH).map((c) => CAL[c]);
      console.log(`[점검 5] 월 리밸런스 경로: combineN(매일) ↔ combine2 일수익률 최대 차이 ${mxd.toExponential(2)}%p | 월 재조정 신호일 ${sig.length}개(${sig[0]}~${sig[sig.length - 1]}), HM1 월말 신호일(첫 신호일 제외)과 ${sig.length === sg1.length && sig.every((d, k) => d === sg1[k]) ? "일치" : "불일치"}`);
      if (!(mxd < 1e-9)) fails.push(`combineN(매일) ≠ combine2 (최대 차이 ${mxd})`);
      if (!(sig.length === sg1.length && sig.every((d, k) => d === sg1[k]))) fails.push("월 재조정 신호일 ≠ HM1 월말 신호일");
      const mm = combineN([coreFull, sat], [B5_CORE_W, 1 - B5_CORE_W], CS_MOVE_COST, new Set(sig)), yrs = (Date.parse(h.dataEnd) - Date.parse(Wd.FULL.from)) / 86_400_000 / 365.25;
      console.log(`[점검 5] HM1C 월 리밸런스 이동 금액 연 ${f2((mm.moved.reduce((s2, x) => s2 + x, 0) * 100) / yrs)}% (이동 비용 ${CS_MOVE_COST * 100}%)`);
    }
    // [점검 6] 이웃값 후보 수
    for (const [lb, ch] of HM1_NB) {
      const P = { ...HM1_P0, ...ch }, cnt = days.filter((c) => c - P.lookback >= 0).map((c) => hmSorted(c, P).length);
      console.log(`[점검 6] 이웃 ${lb}: 후보 수 최소 ${Math.min(...cnt)} 평균 ${f2(avg(cnt))} 최대 ${Math.max(...cnt)} (룩백을 채우는 신호일 ${cnt.length}/${days.length}개; 후보 ${P.n}개 미만인 월 ${cnt.filter((x) => x < P.n).length}개)`);
    }
    console.log(`\n정보용 항목 구현 목록(시험 출력에서 이 머리표로 대조): [R3] 연도별 069500·DS6·DS13L 대비 승패 · [R4] 승률·손익비·기대값(평가 출력의 "요약" 줄) · [R5] 나란히 비교 표 · [R6] 연 회전율·비용 · [R7] 상위 10개 거래 손익 비중(평가 출력의 "상위 10개 거래" 줄) · [H1] 삼성전자·SK하이닉스 보유·평균 비중 · [H2] 일간 상관(RM1 포함) · [H3] VB1 MDD 구간(2018-01-29~2020-03-23) 구간 수익 · [H4] 하루 지연(C) · [H5] 의심 종목-일 처리 없음 비교(hinfo) · [H6] 누적 시험·우연 통과 기대(요약)`);
    if (fails.length) { console.log(`\n사전 점검 실패 ${fails.length}건:\n${fails.map((x) => `  - ${x}`).join("\n")}`); throw new Error("사전 점검 실패 — 시험하지 않고 중단해 보고한다"); }
    console.log(`\n52주 신고가 사전 점검 통과(성과는 계산·출력하지 않았다; DS6 재현 줄은 환경 확인용) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "hinfo") {
    // 정보용(시험 아님, 시험 번호·게이트 없음): HM1·HM1C·RM1C·DS13L 기준 실행의 구간별 CAGR/MDD — 의심 종목-일 0% 처리 유무 비교용.
    const hm1 = mkHM("HM1", HM1_P0, HM1_NB), cH = startOf(hm1, false), Wx = windowsFor(cH), from = Wx.FULL.from;
    if (cH !== startOf(RM1, false)) throw new Error("HM1 첫 신호일 ≠ RM1 첫 신호일 — 중단");
    const coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, from), sigSet = new Set(monthEndIdx.filter((c) => c > cH).map((c) => CAL[c]));
    const hmRun = runS(hm1, HM1_P0, cH, null, { lag: 1, detail: true }), rm1Run = runS(RM1, RM1.P0, cH, null, { lag: 1, detail: true });
    const rows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [
      { nm: "HM1", run: hmRun }, { nm: "HM1C", run: combineN([coreFull, slFromRun(hmRun)], [B5_CORE_W, 1 - B5_CORE_W], CS_MOVE_COST, sigSet).run },
      { nm: "RM1C", run: combine2(coreFull, slFromRun(rm1Run), B5_CORE_W, CS_MOVE_COST).run }, { nm: "DS13L", run: d13Of("LV1", cH, Wx).base.res.run }, { nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run },
    ];
    console.log(`\n=== [H5] 정보용: ${ZERO_SUSPECT_ON ? `의심 종목-일 0% 처리 적용(${suspectLog.length}건)` : "의심 종목-일 처리 없음"} — CAGR % / MDD % (같은 구간 ${from}~) ===\n| 구간 | ${rows.map((r) => r.nm).join(" | ")} |\n|---|${rows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${rows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    console.log(`\n정보용 실행 종료(시험 아님) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "mpre") {
    // 시총 상위 5종목 사전 점검(성과 미계산): DS6 재현(위 줄, 불일치면 중단), 데이터 표준, 첫 신호일 정합, 시총 상위 목록·이동평균 독립 재계산, 보유 수·첫 체결일, TC2 거래일 구조, RT0 재현, 소멸 관례, 정보용 항목 목록.
    const fails: string[] = [];
    const rngM = mulberry32(20261126);
    const tc1 = mkTC("TC1", TC1_P0, TC1_NB, false), tc2 = mkTC("TC2", TC2_P0, TC2_NB, true);
    const cT1 = startOf(tc1, false), cT2 = startOf(tc2, false), cR = startOf(RM1, false), Wd = windowsFor(cT1), days = monthEndIdx.filter((x) => x >= cT1);
    console.log(`[점검 1] 데이터 표준: 가격 보정 ${PRICE_CORRECTION_ON ? "k200p17 적용" : "미적용"} · 의심 종목-일 0% 처리 ${ZERO_SUSPECT_ON ? `적용 ${suspectLog.length}건` : "미적용"} | 소멸 관례: vbVanishLoss(VB·VL·Q·HM과 같음) | 슬리피지 신호일 K200P 구성원 ${B5_BS_SLIP_K200 * 100}%·그 밖 ${B5_BS_SLIP_OTHER * 100}%`);
    if (!PRICE_CORRECTION_ON || !ZERO_SUSPECT_ON) fails.push("보정 또는 의심 종목-일 0% 처리 미적용(correct=k200p17 zero=1 필요)");
    console.log(`[점검 2] 첫 신호일: TC1 ${CAL[cT1]} / TC2 ${CAL[cT2]} / RM1 ${CAL[cR]} | 수익률 집계 ${Wd.FULL.from}~${h.dataEnd} | 구간 ${Wd.NW.map(([nm, w]) => `${nm} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    if (cT1 !== cT2 || cT1 !== cR) fails.push(`첫 신호일 불일치: TC1 ${CAL[cT1]} TC2 ${CAL[cT2]} RM1 ${CAL[cR]}`);
    // [점검 3] K200P(PIT) 시총 상위 10종목 독립 재계산(시장 구분·제외 규칙·시총 직접 정렬)
    {
      let nOk = 0;
      for (let t = 0; t < 20; t++) {
        const c = days[Math.floor(rngM() * days.length)], got = rank200(c).list.slice(0, 10).map((s) => s.code), exp = bruteRank(c).slice(0, 10).map((s) => s.code);
        if (got.length !== exp.length || got.some((x, k) => x !== exp[k])) fails.push(`시총 상위 10 불일치 ${CAL[c]}`); else nOk++;
        const g5 = tcGroup(c, TC1_P0).map((s) => s.code);
        if (g5.join() !== exp.slice(0, 5).join()) fails.push(`TC 그룹(월말) ≠ 독립 상위 5 ${CAL[c]}`);
      }
      console.log(`[점검 3] K200P(PIT) 시총 상위 10종목 독립 재계산 월말 20개 중 일치 ${nOk}개, TC 그룹 = 상위 5종목`);
    }
    // [점검 4] 이동평균 조건 독립 재계산(종목의 종가 행을 날짜 문자열로 직접 합산)
    {
      let nCk = 0, nTrue = 0;
      for (let t = 0; t < 300; t++) {
        const c = cT1 + Math.floor(rngM() * (CAL.length - cT1)), ma = [200, 150, 250][t % 3], P: TcP = { ...TC2_P0, ma };
        for (const s of tcGroup(c, P)) {
          const got = tcCond(s, c, P), ic = s.idx.get(CAL[c]);
          if (ic === undefined) { if (got !== undefined) fails.push(`MA 행 없음인데 ${got} ${s.code} ${CAL[c]}`); continue; }
          let sum = 0, n = 0;
          const d0 = CAL[c - ma + 1];
          for (const [d, i] of s.idx) if (d >= d0 && d <= CAL[c]) { sum += s.close[i]; n++; }
          const exp = n >= Math.ceil(ma * P.minValidFrac) && s.close[ic] > sum / n;
          nCk++; if (exp) nTrue++;
          if (got !== exp) fails.push(`MA${ma} 조건 불일치 ${s.code} ${CAL[c]}: 모듈 ${got} 독립 ${exp}`);
        }
      }
      console.log(`[점검 4] 이동평균 조건(200·150·250일) 독립 재계산 ${nCk}건 일치 확인(그중 조건 충족 ${nTrue}건)`);
    }
    // [점검 5] 구조
    {
      const r1 = runS(tc1, TC1_P0, cT1, null, { lag: 1, detail: true }), r2 = runS(tc2, TC2_P0, cT2, null, { lag: 1, detail: true });
      for (const [id, run, P0, cS] of [["TC1", r1, TC1_P0, cT1], ["TC2", r2, TC2_P0, cT2]] as [string, RebalRun, TcP, number][]) {
        const hmax = Math.max(...run.nPos.map((x, k) => x - (run.nDefer[k] ?? 0)));
        console.log(`[점검 5] ${id}: 보유 종목 수 최대(순연 제외) ${hmax} (상한 ${P0.n}) | 첫 체결일 ${CAL[run.entryCs[0]]} (신호일 다음 거래일 ${CAL[cS + 1]}) | 진입 ${run.entryCs.length}건 | 평균 투자 비중 ${f2(avg(run.inv) * 100)}% | 체결이 있는 날 ${run.turn.length}일`);
        if (hmax > P0.n) fails.push(`${id} 보유 종목 수 ${hmax} > ${P0.n}`);
        if (run.entryCs[0] !== undefined && run.entryCs[0] !== cS + 1) fails.push(`${id} 첫 체결일 ${CAL[run.entryCs[0]]} ≠ ${CAL[cS + 1]}`);
      }
      // TC2: 월말·조건 변화 이후가 아닌 날의 체결이 없는지(월 중 매일 재균형 안 함)
      const flips = new Set<number>();
      for (let c = cT2 + 1; c < CAL.length; c++) for (const s of tcGroup(c, TC2_P0)) { const a = tcCond(s, c, TC2_P0), b = tcCond(s, c - 1, TC2_P0); if (a !== b) { flips.add(c + 1); flips.add(c + 2); } }
      const idxOf = new Map(CAL.map((d, k) => [d, k] as [string, number]));
      const tradeDays = r2.turn.map((x) => idxOf.get(x.d) as number), meNext = new Set([...meSet].flatMap((x) => [x + 1, x + 2]));
      const unexplained = tradeDays.filter((c) => !flips.has(c) && !meNext.has(c));
      console.log(`[점검 5] TC2 체결일 ${tradeDays.length}일 중 월말 다음 거래일·조건 변화(이탈·재진입) 다음 거래일이 아닌 날 ${unexplained.length}일(거래정지로 밀린 체결·소멸 청산 등)${unexplained.length ? ` 예: ${unexplained.slice(0, 5).map((c) => CAL[c]).join(", ")}` : ""}`);
      if (unexplained.length > Math.max(5, tradeDays.length * 0.03)) fails.push(`TC2 월 중 설명되지 않는 체결 ${unexplained.length}일`);
      console.log(`[점검 5] 닫힌 거래: TC1 ${r1.trades.length}건(소멸 청산 ${r1.trades.filter((t) => t.reason.startsWith("폐지")).length}건) · TC2 ${r2.trades.length}건(소멸 청산 ${r2.trades.filter((t) => t.reason.startsWith("폐지")).length}건)`);
    }
    // [점검 6] 비교 기준 K200P 시총 비중(RT0) 재현
    {
      const r0 = runS(RT0, RT0.P0, cT1, null, { lag: 1 }), s0 = h.st(r0, Wd.FULL);
      const ok = f2(s0.cagr) === f2(M_REF_CAPW.cagr) && f2(s0.mdd) === f2(M_REF_CAPW.mdd);
      console.log(`[점검 6] K200P 시총 비중(RT0, 종목당 상한 ${RT1_P0.cap * 100}%) 재현: 연속 ${f2(s0.cagr)} / ${f2(s0.mdd)} (시험과 같은 데이터 기준 기록 ${M_REF_CAPW.cagr} / ${M_REF_CAPW.mdd}; 사용자 참고값 ${M_REF_CAPW_USER.cagr} / ${M_REF_CAPW_USER.mdd}와 차이 있음 — 보정 적용 전 기록으로 추정) → ${ok ? "일치" : "불일치"}`);
      if (!ok) fails.push(`RT0 재현 ${f2(s0.cagr)} / ${f2(s0.mdd)} ≠ ${M_REF_CAPW.cagr} / ${M_REF_CAPW.mdd}`);
    }
    console.log(`\n정보용 항목 구현 목록(시험 출력에서 이 머리표로 대조): [R3] 연도별 069500·DS6·DS13L 대비 승패 · [R4] 승률·손익비·기대값 · [R5] 나란히 비교 표(DS6·DS13L·K200P 시총 비중) · [R6] 연 회전율·비용 · [R7] 상위 10개 거래 손익 비중 · [M1] 삼성전자·SK하이닉스 평균 목표 비중 · [M2] 현금 비중 평균(평가 출력의 "평균 투자 비중" 줄, TC2) · [M3] VB1 MDD 구간 수익 · [M4] 하루 지연(C) · [M5] 삼성전자·SK하이닉스 수익을 0으로 한 경우(mneut) · [M6] 의심 종목-일 처리 없음 비교(minfo) · [M7] 누적 시험·우연 통과 기대(요약)`);
    if (fails.length) { console.log(`\n사전 점검 실패 ${fails.length}건:\n${fails.map((x) => `  - ${x}`).join("\n")}`); throw new Error("사전 점검 실패 — 시험하지 않고 중단해 보고한다"); }
    console.log(`\n시총 상위 5종목 사전 점검 통과(성과는 계산·출력하지 않았다; DS6·RT0 재현 줄은 환경 확인용) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "minfo") {
    // 정보용(시험 아님, 시험 번호·게이트 없음): TC1·TC2·K200P 시총 비중·DS13L·DS6 기준 실행의 구간별 CAGR/MDD — 의심 종목-일 0% 처리 유무 또는 두 종목(NEUTRALIZE_CODES) 수익 0 비교용.
    const tc1 = mkTC("TC1", TC1_P0, TC1_NB, false), tc2 = mkTC("TC2", TC2_P0, TC2_NB, true), cT = startOf(tc1, false), Wx = windowsFor(cT);
    if (cT !== startOf(tc2, false) || cT !== startOf(RM1, false)) throw new Error("TC1·TC2·RM1 첫 신호일 불일치 — 중단");
    const rows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [
      { nm: "TC1", run: runS(tc1, TC1_P0, cT, null, { lag: 1, detail: true }) }, { nm: "TC2", run: runS(tc2, TC2_P0, cT, null, { lag: 1, detail: true }) },
      { nm: "K200P 시총 비중", run: runS(RT0, RT0.P0, cT, null, { lag: 1 }) }, { nm: "DS13L", run: d13Of("LV1", cT, Wx).base.res.run }, { nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run },
    ];
    console.log(`\n=== [${NEUTRALIZE_ON ? "M5" : "M6"}] 정보용: ${NEUTRALIZE_ON ? `수정 수익률을 0으로 둔 종목 ${process.env.NEUTRALIZE_CODES}(069500 기준선은 그대로, DS6·DS13L 코어도 영향을 받음) · ` : ""}${ZERO_SUSPECT_ON ? `의심 종목-일 0% 처리 적용(${suspectLog.length}건)` : "의심 종목-일 처리 없음"} — CAGR % / MDD % (같은 구간 ${Wx.FULL.from}~) ===\n| 구간 | ${rows.map((r) => r.nm).join(" | ")} |\n|---|${rows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${rows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    console.log(`\n정보용 실행 종료(시험 아님) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "epre") {
    // 이익수익률 사전 점검(성과 미계산): DS6 재현(위 줄, 불일치면 중단), 데이터 표준, TTM·이익수익률 독립 재계산, 보유 수·첫 체결일, EY1C 날짜 축·월 재조정 경로, VB1 재현, TTM 커버리지, 소멸 관례, 정보용 항목 목록.
    await loadEqTables();
    await loadRoe();
    requireStart();
    const fails: string[] = [];
    const rngQ = mulberry32(20261127);
    const ey1 = mkEY("EY1", EY1_P0, EY1_NB), cE = startOf(ey1, false), Wd = windowsV(cE), days = monthEndIdx.filter((x) => x >= cStartV);
    console.log(`시험 설정: ${V_CASE}, 시작 월말 ${V_START}(사전등록 ${E_PLANNED_START}${V_START === E_PLANNED_START ? "과 같음" : "와 다름"}), 구간 ${Wd.NW.map(([nm]) => nm).join(" / ")}`);
    console.log(`[점검 0] 데이터 표준: 가격 보정 ${PRICE_CORRECTION_ON ? "k200p17 적용" : "미적용"} · 의심 종목-일 0% 처리 ${ZERO_SUSPECT_ON ? `적용 ${suspectLog.length}건` : "미적용"} | 소멸 관례: vbVanishLoss | 슬리피지 신호일 K200P 구성원 ${B5_BS_SLIP_K200 * 100}%·그 밖 ${B5_BS_SLIP_OTHER * 100}%`);
    if (!PRICE_CORRECTION_ON || !ZERO_SUSPECT_ON) fails.push("보정 또는 의심 종목-일 0% 처리 미적용(correct=k200p17 zero=1 필요)");
    if (V_START !== E_PLANNED_START) fails.push(`V_START ${V_START} ≠ 사전등록 ${E_PLANNED_START}`);
    // [점검 1] ROE 독립 재계산: 같은 보고서 자료에서 따로 짠 직접 계산과 비교 + 접수일 < 신호일
    {
      const all = await loadRoeReps(), flat = [...all.repsR, ...all.repsPre], byC = new Map<string, FinRep[]>();
      for (const r of flat) { const a = byC.get(r.code) ?? []; a.push(r); byC.set(r.code, a); }
      const ord: Record<string, number> = { "11013": 1, "11012": 2, "11014": 3, "11011": 4 };
      const brute = (code: string, d: string, maxAge: number): { why: string; roe?: number; ttm?: number } => {
        const rs = byC.get(code) ?? [], best = new Map<string, FinRep>();
        for (const r of rs) { const k = `${r.year}|${r.rc}`, o = best.get(k); if (!o || (r.fs === "CFS" && o.fs !== "CFS")) best.set(k, r); }
        const avail = [...best.values()].filter((r) => r.rcept < d).sort((a, b) => a.year * 10 + ord[a.rc] - (b.year * 10 + ord[b.rc]) || (a.rceptNo < b.rceptNo ? -1 : 1));
        const F = avail[avail.length - 1];
        if (!F) return { why: "no_report" };
        if ((Date.parse(d) - Date.parse(F.rcept)) / 86_400_000 > maxAge) return { why: "stale" };
        let ttm: number;
        if (F.rc === "11011") { if (F.niC === null) return { why: "null_ni" }; ttm = F.niC; }
        else {
          const an = avail.find((r) => r.rc === "11011" && r.year === F.year - 1 && r.rcept < F.rcept);
          if (!an) return { why: "no_annual" };
          const ytd = F.rc === "11013" ? F.niC : F.niA, pv = F.rc === "11013" ? F.niP : F.niPA;
          if (an.niC === null || ytd === null || pv === null) return { why: "null_ni" };
          ttm = an.niC + ytd - pv;
        }
        if (F.eqC === null) return { why: "null_eq" };
        if (!(F.eqC > 0)) return { why: "eq_nonpos" };
        if (!(ttm > 0)) return { why: "ttm_nonpos" };
        return { why: "ok", roe: ttm / F.eqC, ttm };
      };
      let nChk = 0, nOk = 0;
      const whyCnt = new Map<string, number>();
      for (let t = 0; t < 400; t++) {
        const c = days[Math.floor(rngQ() * days.length)], el = bsElig(c, B5_BS_P0);
        if (!el.length) continue;
        const code = el[Math.floor(rngQ() * el.length)], d = CAL[c], a = roeOf(code, d, 400), b = brute(code, d, 400);
        nChk++; whyCnt.set(a.why, (whyCnt.get(a.why) ?? 0) + 1);
        if (a.why !== b.why) fails.push(`ROE 사유 불일치 ${code} ${d}: 모듈 ${a.why} 독립 ${b.why}`);
        else if (a.why === "ok") { nOk++; if (!(Math.abs((a.roe as number) - (b.roe as number)) <= 1e-9 * Math.abs(b.roe as number))) fails.push(`ROE 값 불일치 ${code} ${d}: ${a.roe} vs ${b.roe}`); }
      }
      console.log(`[점검 1] ROE 독립 재계산 ${nChk}건(값 비교 ${nOk}건) 일치 확인(접수일 < 신호일 규칙 포함) | 사유 분포 ${[...whyCnt.entries()].map(([k, v]) => `${k} ${v}`).join(" · ")}`);
      // [점검 2] 이익수익률 정렬 독립 재계산: 직접 계산한 TTM·자본과 신호일 시가총액으로 전 종목을 다시 정렬해 대조
      {
        let nU = 0, nMax = 0;
        for (let t2 = 0; t2 < 20; t2++) {
          const c = days[Math.floor(rngQ() * days.length)], d = CAL[c], exp: { code: string; ey: number }[] = [];
          for (const code of bsElig(c, B5_BS_P0)) {
            const b = brute(code, d, EY1_P0.maxAge), s = h.byCode.get(code) as S, i2 = s.idx.get(d);
            if (b.why !== "ok" || i2 === undefined) continue;
            exp.push({ code, ey: (b.ttm as number) / (s.mcapRow[i2] * 1e8) });
          }
          exp.sort((x, y) => y.ey - x.ey || (x.code < y.code ? -1 : 1));
          const got = eySorted(c, EY1_P0);
          if (exp.length !== got.length || exp.some((x, j) => x.code !== got[j].code || !(Math.abs(x.ey - got[j].ey) <= 1e-12 * Math.max(1, Math.abs(x.ey))))) fails.push(`EY 정렬 불일치 ${d}: 모듈 ${got.length} 독립 ${exp.length}`);
          nU++; nMax = Math.max(nMax, exp.length);
        }
        console.log(`[점검 2] 이익수익률(TTM 순이익 ÷ 시가총액) 정렬 독립 재계산(전 종목 직접 훑기) ${nU}개 월말 일치 확인(월별 후보 최대 ${nMax}개)`);
      }
    }
    // [점검 3] 구조: 보유 수·첫 체결일·진입 종목 유효성·EY1C 날짜 축·월 재조정 경로
    {
      const run = runS(ey1, EY1_P0, cE, null, { lag: 1, detail: true });
      const hmax = Math.max(...run.nPos.map((x, k) => x - (run.nDefer[k] ?? 0)));
      const cnt = ey1.signalDays.filter((x) => x >= cE).map((c) => eySorted(c, EY1_P0).length);
      console.log(`[점검 3] EY1: 첫 신호일 ${CAL[cE]}, 수익률 집계 ${Wd.FULL.from}~${h.dataEnd} | 보유 종목 수 최대(순연 제외) ${hmax} (목표 ${EY1_P0.n}) | 첫 체결일 ${CAL[run.entryCs[0]]} (신호일 다음 거래일 ${CAL[cE + 1]}) | 진입 ${run.entryCs.length}건 | 신호일 ${cnt.length}개, 후보 수 최소 ${Math.min(...cnt)} 평균 ${f2(avg(cnt))} 최대 ${Math.max(...cnt)}, 후보 ${EY1_P0.n}개 미만인 월 ${cnt.filter((x) => x < EY1_P0.n).length}개 | 평균 투자 비중 ${f2(avg(run.inv) * 100)}%`);
      if (hmax > EY1_P0.n) fails.push(`EY1 보유 종목 수 ${hmax} > ${EY1_P0.n}`);
      if (run.entryCs[0] !== undefined && run.entryCs[0] !== cE + 1) fails.push(`EY1 첫 체결일 ${CAL[run.entryCs[0]]} ≠ ${CAL[cE + 1]}`);
      const bad = run.trades.concat(run.open).filter((t3) => !eySorted(t3.entryC - 1, EY1_P0).some((x) => x.code === t3.code)).length;
      if (bad) fails.push(`EY1 진입 종목 중 신호일 후보가 아닌 경우 ${bad}건`);
      for (const [lb, ch] of EY1_NB) { const P = { ...EY1_P0, ...ch }, cn = days.map((c) => eySorted(c, P).length); console.log(`[점검 3] 이웃 ${lb}: 목표 종목 ${P.n}, 유지 순위 ${P.n * P.keepMult} | 후보 수 최소 ${Math.min(...cn)}(${cn.filter((x) => x < P.n).length}개 월이 ${P.n}개 미만)`); }
      const closed = run.trades, vl = closed.filter((t3) => t3.reason === "폐지(전액 손실)").length, vs = closed.filter((t3) => t3.reason === "폐지").length;
      console.log(`[점검 3] EY1 소멸 종목 청산: 마지막 종가 청산 ${vs}건 · 전액 손실 ${vl}건(닫힌 거래 ${closed.length}건 중)`);
      const coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, Wd.FULL.from), sat = slFromRun(run);
      if (coreFull.dates.length !== sat.dates.length || coreFull.dates.some((x, k) => x !== sat.dates[k])) fails.push("EY1C 날짜 축");
      else console.log(`[점검 3] EY1C 날짜 축: 코어 ${coreFull.dates[0]}~${coreFull.dates[coreFull.dates.length - 1]}(${coreFull.dates.length}일) = 위성 일치`);
      const a = combineN([coreFull, sat], [B5_CORE_W, 1 - B5_CORE_W], CS_MOVE_COST, null).run.ret, b = combine2(coreFull, sat, B5_CORE_W, CS_MOVE_COST).run.ret;
      let mxd = 0;
      for (let k = 0; k < a.length; k++) mxd = Math.max(mxd, Math.abs(a[k] - b[k]));
      const sig = [...new Set(monthEndIdx.filter((c) => c > cE).map((c) => CAL[c]))], sg1 = ey1.signalDays.filter((c) => c > cE).map((c) => CAL[c]);
      console.log(`[점검 3] 월 리밸런스 경로: combineN(매일) ↔ combine2 일수익률 최대 차이 ${mxd.toExponential(2)}%p | 월 재조정 신호일 ${sig.length}개(${sig[0]}~${sig[sig.length - 1]}), EY1 월말 신호일(첫 신호일 제외)과 ${sig.length === sg1.length && sig.every((d, k) => d === sg1[k]) ? "일치" : "불일치"}`);
      if (!(mxd < 1e-9)) fails.push(`combineN(매일) ≠ combine2 (최대 차이 ${mxd})`);
      if (!(sig.length === sg1.length && sig.every((d, k) => d === sg1[k]))) fails.push("월 재조정 신호일 ≠ EY1 월말 신호일");
    }
    // [점검 4] VB1 재현(순이익 열 추가 뒤에도 자본 입력이 같은지): 기록 연속 10.07 / 64.17(시작 ${V2_START})
    {
      const vbRep: Strat<VbP> = { ...mkVB("VB1", VB1_P0, VB1_NB), signalDays: monthEndIdx.filter((c) => CAL[c] >= V2_START) };
      const cR = startOf(vbRep, false), run = runS(vbRep, VB1_P0, cR, null, { lag: 1, detail: true }), st = h.st(run, { from: CAL[cR + 1], to: "9999-12-31" });
      const ok = f2(st.cagr) === "10.07" && f2(st.mdd) === "64.17";
      console.log(`[점검 4] VB1 재현(시작 ${CAL[cR]}, 집계 ${CAL[cR + 1]}~): 연속 ${f2(st.cagr)} / ${f2(st.mdd)} (기록 10.07 / 64.17) → ${ok ? "일치" : "불일치"}`);
      if (!ok) fails.push("VB1 재현 불일치(자본 입력이 달라졌을 가능성)");
    }
    // [점검 5] TTM 커버리지(시작일 이후 매 월말, BS1 적격 기준)
    {
      const rows = days.map((c) => { const el = bsElig(c, B5_BS_P0), d = CAL[c]; let ttm = 0; for (const code of el) { const r = roeOf(code, d, 400); if (r.ttm !== undefined) ttm++; } return { d, v: ttm / Math.max(el.length, 1) }; });
      const mn = rows.reduce((a, x) => (x.v < a.v ? x : a), rows[0]);
      console.log(`[점검 5] TTM 계산 가능 비율(BS1 적격 종목 수 기준) 시작일 이후 ${rows.length}개 월말: 최소 ${f2(mn.v * 100)}%(${mn.d}) 평균 ${f2(avg(rows.map((x) => x.v)) * 100)}% | 60% 미만 월 ${rows.filter((x) => x.v < 0.6).length}개`);
      if (rows.some((x) => x.v < 0.6)) fails.push("시작일 이후 TTM 커버리지 60% 미만인 월이 있다");
    }
    console.log(`\n정보용 항목 구현 목록(시험 출력에서 이 머리표로 대조): [R3] 연도별 069500·DS6·DS13L 대비 승패 · [R4] 승률·손익비·기대값 · [R5] 나란히 비교 표(DS6·DS13L·VB1·QV1) · [R6] 연 회전율·비용 · [R7] 상위 10개 거래 손익 비중 · [E1] 보유 종목 평균 PER·PBR · [E2] 금융주 비중 · [E3] 삼성전자·SK하이닉스 평균 비중 · [E4] VB1·QV1 등 일간 상관 · [E5] VB1 MDD 구간(2018-01-29~2020-03-23) 구간 수익 · [E6] 하루 지연(C) · [E7] TTM 계산 불가 제외 종목-월 비율 · [E8] 의심 종목-일 처리 없음 비교(einfo) · [E9] 누적 시험·우연 통과 기대(요약)`);
    if (fails.length) { console.log(`\n사전 점검 실패 ${fails.length}건:\n${fails.map((x) => `  - ${x}`).join("\n")}`); throw new Error("사전 점검 실패 — 시험하지 않고 중단해 보고한다"); }
    console.log(`\n이익수익률 사전 점검 통과(성과는 계산·출력하지 않았다; 점검 4는 VB1 재현값, DS6 재현 줄은 환경 확인용) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "einfo") {
    // 정보용(시험 아님, 시험 번호·게이트 없음): EY1·EY1C·VB1·QV1·DS13L 기준 실행의 구간별 CAGR/MDD — 의심 종목-일 0% 처리 유무 비교용.
    await loadEqTables();
    await loadRoe();
    requireStart();
    const ey1 = mkEY("EY1", EY1_P0, EY1_NB), qv1 = mkQ("QV1", QV1_P0, QV1_NB), vb1 = mkVB("VB1", VB1_P0, VB1_NB), cE = startOf(ey1, false), Wx = windowsV(cE);
    const coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, Wx.FULL.from), sigSet = new Set(monthEndIdx.filter((c) => c > cE).map((c) => CAL[c]));
    const eyRun = runS(ey1, EY1_P0, cE, null, { lag: 1, detail: true });
    const rows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [
      { nm: "EY1", run: eyRun }, { nm: "EY1C", run: combineN([coreFull, slFromRun(eyRun)], [B5_CORE_W, 1 - B5_CORE_W], CS_MOVE_COST, sigSet).run },
      { nm: "VB1", run: runS(vb1, VB1_P0, cE, null, { lag: 1, detail: true }) }, { nm: "QV1", run: runS(qv1, QV1_P0, cE, null, { lag: 1, detail: true }) },
      { nm: "DS13L", run: d13Of("LV1", cE, Wx).base.res.run }, { nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run },
    ];
    console.log(`\n=== [E8] 정보용: ${ZERO_SUSPECT_ON ? `의심 종목-일 0% 처리 적용(${suspectLog.length}건)` : "의심 종목-일 처리 없음"} — CAGR % / MDD % (같은 구간 ${Wx.FULL.from}~) ===\n| 구간 | ${rows.map((r) => r.nm).join(" | ")} |\n|---|${rows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${rows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    console.log(`\n정보용 실행 종료(시험 아님) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "spre") {
    // 잔차 모멘텀 손절 사전 점검(RM1S·RM1SC 성과 미계산): DS6 재현(위 줄), RM1 재현, 손절 없는 RM1S = RM1, 손절 조건 독립 재계산, 보유 수·첫 체결일, RM1SC 월 재조정 경로, 손절 발동 건수.
    const fails: string[] = [];
    const rms = mkRMS("RM1S", RM1S_P0, RM1S_NB), cS = startOf(rms, false), cR = startOf(RM1, false), Wd = windowsFor(cS);
    const std = PRICE_CORRECTION_ON && ZERO_SUSPECT_ON ? "correctZero" : PRICE_CORRECTION_ON ? "correct" : "none";
    console.log(`[점검 1] 데이터 표준: 가격 보정 ${PRICE_CORRECTION_ON ? "k200p17 적용" : "미적용"} · 의심 종목-일 0% 처리 ${ZERO_SUSPECT_ON ? `적용 ${suspectLog.length}건` : "미적용"} → ${std === "correctZero" ? "시험 표준(공식)" : std === "none" ? "원 설정(RM1 재현 전용 실행)" : "보정만(재현 전용)"} | 소멸 관례: RM1과 같음(마지막 종가 청산), 슬리피지 L_SLIPPAGE`);
    console.log(`[점검 2] 첫 신호일: RM1S ${CAL[cS]} / RM1 ${CAL[cR]} | 수익률 집계 ${Wd.FULL.from}~${h.dataEnd} | 구간 ${Wd.NW.map(([nm, w]) => `${nm} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    if (cS !== cR) fails.push(`RM1S 첫 신호일 ${CAL[cS]} ≠ RM1 ${CAL[cR]}`);
    // [점검 3] RM1 재현
    const rm1 = runS(RM1, RM1.P0, cS, null, { lag: 1, detail: true }), coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, Wd.FULL.from);
    {
      const s1 = h.st(rm1, Wd.FULL), c1 = h.st(combine2(coreFull, slFromRun(rm1), B5_CORE_W, CS_MOVE_COST).run, Wd.FULL);
      const ref = S_REF[std as keyof typeof S_REF] as { rm1?: readonly number[]; rm1c: readonly number[] };
      const okC = f2(c1.cagr) === f2(ref.rm1c[0]) && f2(c1.mdd) === f2(ref.rm1c[1]), okR = ref.rm1 ? f2(s1.cagr) === f2(ref.rm1[0]) && f2(s1.mdd) === f2(ref.rm1[1]) : true;
      console.log(`[점검 3] RM1 재현(${std}): RM1C 연속 ${f2(c1.cagr)} / ${f2(c1.mdd)} (기록 ${ref.rm1c.join(" / ")}) → ${okC ? "일치" : "불일치"}${ref.rm1 ? ` | RM1 단독 ${f2(s1.cagr)} / ${f2(s1.mdd)} (기록 ${ref.rm1.join(" / ")}) → ${okR ? "일치" : "불일치"}` : ` | RM1 단독 ${f2(s1.cagr)} / ${f2(s1.mdd)}(이 데이터 표준의 기록 없음)`}`);
      if (!okC) fails.push(`RM1C 재현 불일치(${std})`);
      if (!okR) fails.push(`RM1 재현 불일치(${std})`);
    }
    // [점검 4] 손절 100%(발동 불가) RM1S = RM1(일별 수익률까지)
    {
      const never = runS(rms, { ...RM1S_P0, stop: 1 }, cS, null, { lag: 1, detail: true });
      let mx = 0;
      if (never.dates.length !== rm1.dates.length) fails.push("RM1S(손절 없음)와 RM1의 날짜 축이 다르다");
      else for (let k = 0; k < never.ret.length; k++) mx = Math.max(mx, Math.abs(never.ret[k] - rm1.ret[k]));
      console.log(`[점검 4] 손절 없는 RM1S(손절 100%) ↔ RM1 일수익률 최대 차이 ${mx.toExponential(2)}%p, 손절 발동 ${rmsLog.length}건, 체결 있는 날 ${never.turn.length} vs ${rm1.turn.length}일`);
      if (!(mx < 1e-9)) fails.push(`RM1S(손절 없음) ≠ RM1 (최대 차이 ${mx})`);
      if (rmsLog.length) fails.push(`손절 100%인데 발동 ${rmsLog.length}건`);
      // 하루 지연(lag 2)에서도 손절 없는 RM1S는 지연된 RM1과 같아야 한다(월 중 신호·유지 표지가 지연 경로에서 RM1을 바꾸지 않는지)
      const never2 = runS(rms, { ...RM1S_P0, stop: 1 }, cS, null, { lag: 2, detail: true }), rm1d = runS(RM1, RM1.P0, cS, null, { lag: 2, detail: true });
      let mx2 = 0;
      if (never2.dates.length !== rm1d.dates.length) fails.push("지연 RM1S(손절 없음)와 지연 RM1의 날짜 축이 다르다");
      else for (let k = 0; k < never2.ret.length; k++) mx2 = Math.max(mx2, Math.abs(never2.ret[k] - rm1d.ret[k]));
      console.log(`[점검 4b] 하루 지연(lag 2): 손절 없는 RM1S ↔ RM1 일수익률 최대 차이 ${mx2.toExponential(2)}%p, 진입 ${never2.entryCs.length} vs ${rm1d.entryCs.length}건, 닫힌 거래 ${never2.trades.length} vs ${rm1d.trades.length}건, 보유일 1일 거래 ${never2.trades.filter((x) => x.exitC - x.entryC <= 1).length} vs ${rm1d.trades.filter((x) => x.exitC - x.entryC <= 1).length}건`);
      if (!(mx2 < 1e-9)) fails.push(`지연(lag 2) RM1S(손절 없음) ≠ RM1 (최대 차이 ${mx2})`);
    }
    // [점검 5] 손절 조건 독립 재계산 + 구조
    {
      const run = runS(rms, RM1S_P0, cS, null, { lag: 1, detail: true }), log = [...rmsLog];
      const hmax = Math.max(...run.nPos.map((x, k) => x - (run.nDefer[k] ?? 0)));
      console.log(`[점검 5] RM1S: 보유 종목 수 최대(순연 제외) ${hmax} (목표 ${RM1S_P0.n}) | 첫 체결일 ${CAL[run.entryCs[0]]} (신호일 다음 거래일 ${CAL[cS + 1]}) | 진입 ${run.entryCs.length}건 | 손절 발동 ${log.length}건`);
      if (hmax > RM1S_P0.n) fails.push(`RM1S 보유 종목 수 ${hmax} > ${RM1S_P0.n}`);
      if (run.entryCs[0] !== undefined && run.entryCs[0] !== cS + 1) fails.push(`RM1S 첫 체결일 ${CAL[run.entryCs[0]]} ≠ ${CAL[cS + 1]}`);
      const all = [...run.trades, ...run.open];
      let nOk = 0, nNoTrade = 0, nBad = 0;
      for (const ev of log) {
        const t = all.find((x) => x.code === ev.code && x.entryC <= ev.c && ev.c <= x.exitC);
        if (!t) { nNoTrade++; continue; }
        const s = h.byCode.get(ev.code) as S;
        let pk = Number.NEGATIVE_INFINITY, early = false;
        for (let k = t.entryC; k <= ev.c; k++) {
          const i = s.idx.get(CAL[k]);
          if (i === undefined) continue;
          pk = Math.max(pk, s.close[i]);
          if (k < ev.c && s.close[i] <= pk * (1 - RM1S_P0.stop)) early = true;
        }
        const ie = s.idx.get(CAL[ev.c]);
        if (ie !== undefined && s.close[ie] <= pk * (1 - RM1S_P0.stop) && !early) nOk++; else nBad++;
      }
      console.log(`[점검 5] 손절 조건 독립 재계산: 발동 ${log.length}건 중 일치 ${nOk}건 · 불일치 ${nBad}건 · 거래 구간을 못 찾음 ${nNoTrade}건`);
      if (nBad || nNoTrade) fails.push(`손절 독립 재계산 불일치 ${nBad}건·거래 없음 ${nNoTrade}건`);
      // 월 중 체결은 손절 다음 거래일뿐인지
      const stopDays = new Set(log.map((e) => e.c + 1)), idxOf = new Map(CAL.map((d, k) => [d, k] as [string, number])), meNext = new Set([...meSet].flatMap((x) => [x + 1, x + 2]));
      const unexplained = run.turn.map((x) => idxOf.get(x.d) as number).filter((c) => !stopDays.has(c) && !stopDays.has(c - 1) && !meNext.has(c));
      console.log(`[점검 5] RM1S 체결일 ${run.turn.length}일 중 월말 다음 거래일·손절 다음 거래일이 아닌 날 ${unexplained.length}일(거래정지로 밀린 체결 등)`);
      if (unexplained.length > Math.max(5, run.turn.length * 0.03)) fails.push(`RM1S 월 중 설명되지 않는 체결 ${unexplained.length}일`);
      // RM1SC 월 재조정 경로
      const sat = slFromRun(run);
      if (coreFull.dates.length !== sat.dates.length || coreFull.dates.some((x, k) => x !== sat.dates[k])) fails.push("RM1SC 날짜 축");
      else console.log(`[점검 5] RM1SC 날짜 축: 코어 ${coreFull.dates[0]}~${coreFull.dates[coreFull.dates.length - 1]}(${coreFull.dates.length}일) = 위성 일치`);
      const a = combineN([coreFull, sat], [B5_CORE_W, 1 - B5_CORE_W], CS_MOVE_COST, null).run.ret, b = combine2(coreFull, sat, B5_CORE_W, CS_MOVE_COST).run.ret;
      let mxd = 0;
      for (let k = 0; k < a.length; k++) mxd = Math.max(mxd, Math.abs(a[k] - b[k]));
      const sig = [...new Set(monthEndIdx.filter((c) => c > cS).map((c) => CAL[c]))];
      console.log(`[점검 5] 월 리밸런스 경로: combineN(매일) ↔ combine2 일수익률 최대 차이 ${mxd.toExponential(2)}%p | 월 재조정 신호일 ${sig.length}개(${sig[0]}~${sig[sig.length - 1]})`);
      if (!(mxd < 1e-9)) fails.push(`combineN(매일) ≠ combine2 (최대 차이 ${mxd})`);
    }
    // [점검 6] 손절 수준별 발동 건수(성과 아님)
    for (const [lb, ch] of [["손절 -20%(기본)", {}], ...RM1S_NB] as [string, Partial<RmsP>][]) { runS(rms, { ...RM1S_P0, ...ch }, cS, null, { lag: 1 }); console.log(`[점검 6] ${lb}: 손절 발동 ${rmsLog.length}건`); }
    console.log(`\n정보용 항목 구현 목록(시험 출력에서 이 머리표로 대조): [R3] 연도별 069500·DS6·DS13L 대비 승패 · [R4] 승률·손익비·기대값 · [R5] 나란히 비교 표(DS6·DS13L·RM1·RM1C) · [R6] 연 회전율·비용 · [R7] 상위 10개 거래 손익 비중 · [S1] 손절 발동 횟수와 손절 후 다음 달 수익 · [S2] 평균 현금 비중(평가 출력의 "평균 투자 비중" 줄) · [S3] 삼성전자·SK하이닉스 평균 비중 · [S4] VB1 MDD 구간(2018-01-29~2020-03-23) 구간 수익 · [S5] 하루 지연(C) · [S6] 의심 종목-일 처리 없음 비교(sinfo) · [S7] 누적 시험·우연 통과 기대(요약)`);
    if (fails.length) { console.log(`\n사전 점검 실패 ${fails.length}건:\n${fails.map((x) => `  - ${x}`).join("\n")}`); throw new Error("사전 점검 실패 — 시험하지 않고 중단해 보고한다"); }
    console.log(`\n잔차 모멘텀 손절 사전 점검 통과(RM1S·RM1SC 성과는 계산·출력하지 않았다; DS6·RM1 재현 줄은 환경 확인용) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "sinfo") {
    // 정보용(시험 아님, 시험 번호·게이트 없음): RM1S·RM1SC·RM1·RM1C·DS13L 기준 실행의 구간별 CAGR/MDD — 의심 종목-일 0% 처리 유무 비교용.
    const rms = mkRMS("RM1S", RM1S_P0, RM1S_NB), cS = startOf(rms, false), Wx = windowsFor(cS), coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, Wx.FULL.from), sigSet = new Set(monthEndIdx.filter((c) => c > cS).map((c) => CAL[c]));
    if (cS !== startOf(RM1, false)) throw new Error("RM1S 첫 신호일 ≠ RM1 — 중단");
    const rmsRun = runS(rms, RM1S_P0, cS, null, { lag: 1, detail: true }), rm1 = runS(RM1, RM1.P0, cS, null, { lag: 1, detail: true });
    const rows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [
      { nm: "RM1", run: rm1 }, { nm: "RM1C", run: combine2(coreFull, slFromRun(rm1), B5_CORE_W, CS_MOVE_COST).run }, { nm: "RM1S", run: rmsRun },
      { nm: "RM1SC", run: combineN([coreFull, slFromRun(rmsRun)], [B5_CORE_W, 1 - B5_CORE_W], CS_MOVE_COST, sigSet).run },
      { nm: "DS13L", run: d13Of("LV1", cS, Wx).base.res.run }, { nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run },
    ];
    console.log(`\n=== [S6] 정보용: ${ZERO_SUSPECT_ON ? `의심 종목-일 0% 처리 적용(${suspectLog.length}건)` : "의심 종목-일 처리 없음"} — CAGR % / MDD % (같은 구간 ${Wx.FULL.from}~) ===\n| 구간 | ${rows.map((r) => r.nm).join(" | ")} |\n|---|${rows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${rows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    console.log(`\n정보용 실행 종료(시험 아님) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "sinfo2") {
    // 정보용(시험 아님, 판정 변경 없음, RM1SC 후속 점검): ① 월 신호일 5·10거래일 앞당김 ② RM1SC·DS13L·DS13M 일간 상관과 연도별 승패표 ③ 손절 발동이 몰린 연도와 그때 현금 비중. (삼성전자·SK하이닉스 수익 0은 sinfo + NEUTRALIZE_CODES.)
    const rms0 = mkRMS("RM1S", RM1S_P0, RM1S_NB), cS = startOf(rms0, false), Wx = windowsFor(cS), from = Wx.FULL.from;
    if (cS !== startOf(RM1, false)) throw new Error("RM1S 첫 신호일 ≠ RM1 — 중단");
    const base = rm1scOf(cS, Wx), events = [...rmsLog];
    const bRun = { dates: h.bhP.dates, ret: h.bhP.ret };
    // [F1] 월 신호일 앞당김
    const shifts = [0, 5, 10].map((sh) => ({ sh, run: sh === 0 ? base.res.run : rm1scOf(cS, Wx, { shift: sh }).res.run }));
    console.log(`\n=== [F1] 정보용 견고성 점검: 월 신호일(RM1 신호·월말 손절 겹침 처리·하위 계좌 간 재조정 신호)을 마지막 거래일에서 5·10거래일 앞당김 — CAGR % / MDD % (같은 구간 ${from}~, 보정 + 0% 처리 데이터; 첫 신호일 ${CAL[cS]}과 코어(일별 규칙)·손절(일별 규칙)은 그대로) ===`);
    console.log(`| 구간 | 069500 | RM1SC 0 | −5일 | −10일 |\n|---|---|---|---|---|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${f2(h.st(bRun, w).cagr)} / ${f2(h.st(bRun, w).mdd)} | ${shifts.map((x) => `${f2(h.st(x.run, w).cagr)} / ${f2(h.st(x.run, w).mdd)}`).join(" | ")} |`);
    const f0 = h.st(shifts[0].run, Wx.FULL);
    console.log(`연속 CAGR 차이(기준 대비 %p): ${shifts.slice(1).map((x) => `−${x.sh}일 ${sg(h.st(x.run, Wx.FULL).cagr - f0.cagr)}(MDD ${sg(h.st(x.run, Wx.FULL).mdd - f0.mdd)}%p)`).join(" · ")} | CAGR 차이 1.5%p 초과 ${shifts.slice(1).some((x) => Math.abs(h.st(x.run, Wx.FULL).cagr - f0.cagr) > 1.5) ? "있음" : "없음"}`);
    // [F2] 상관·연도별 승패
    const dL = d13Of("LV1", cS, Wx).base.res.run, dM = d13Of("MV1", cS, Wx).base.res.run, rm1 = runS(RM1, RM1.P0, cS, null, { lag: 1, detail: true });
    const rm1c = combine2(sliceSl(coreOf(2, undefined, 1, {}).sl, from), slFromRun(rm1), B5_CORE_W, CS_MOVE_COST).run;
    console.log(`\n=== [F2] RM1SC·DS13L·DS13M 등 일간 수익률 상관계수(공통 구간 ${from}~${h.dataEnd}, 정보용) ===`);
    {
      const mkSer = (name: string, r: { dates: string[]; ret: number[] }): { name: string; m: Map<string, number> } => ({ name, m: new Map(r.dates.map((d, i2) => [d, r.ret[i2]])) });
      const ser = [mkSer("RM1SC", base.res.run), mkSer("DS13L", dL), mkSer("DS13M", dM), mkSer("DS6", b6.res.run), mkSer("RM1C", rm1c), mkSer("RM1", rm1), mkSer("069500", bRun)];
      const dd = base.res.run.dates.filter((d) => d >= from && ser.every((x) => x.m.has(d)));
      const corr = (x: Map<string, number>, y: Map<string, number>): number => { const xs = dd.map((d) => x.get(d) as number), ys = dd.map((d) => y.get(d) as number), n = xs.length, mx = avg(xs), my = avg(ys); let sxy = 0, sxx = 0, syy = 0; for (let i2 = 0; i2 < n; i2++) { sxy += (xs[i2] - mx) * (ys[i2] - my); sxx += (xs[i2] - mx) ** 2; syy += (ys[i2] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
      console.log(`공통 ${dd.length}일\n| | ${ser.map((x) => x.name).join(" | ")} |\n|---|${ser.map(() => "---").join("|")}|`);
      for (const x of ser) console.log(`| ${x.name} | ${ser.map((y) => f2(corr(x.m, y.m))).join(" | ")} |`);
    }
    console.log(`\n=== [F2] RM1SC 연도별 수익률 % (069500·DS6·DS13L·DS13M 대비 승패) ===\n| 연도 | 069500 | DS6 | DS13L | DS13M | RM1SC | RM1SC − 069500 %p | − DS6 %p | − DS13L %p | − DS13M %p |\n|---|---|---|---|---|---|---|---|---|---|`);
    {
      const bh = BH_FROM(from), ex: number[][] = [[], [], [], []], d6 = { dates: b6.res.run.dates.filter((d) => d >= from), ret: b6.res.run.ret.filter((_, k) => b6.res.run.dates[k] >= from) };
      for (let y = Number(from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) {
        const a = h.yearRet(bh, y), c6 = h.yearRet(d6, y), cl = h.yearRet(dL, y), cm = h.yearRet(dM, y), cc = h.yearRet(base.res.run, y);
        ex[0].push(cc - a); ex[1].push(cc - c6); ex[2].push(cc - cl); ex[3].push(cc - cm);
        console.log(`| ${y} | ${f2(a)} | ${f2(c6)} | ${f2(cl)} | ${f2(cm)} | ${f2(cc)} | ${sg(cc - a)} | ${sg(cc - c6)} | ${sg(cc - cl)} | ${sg(cc - cm)} |`);
      }
      console.log(`RM1SC 승·패 연수: 069500 대비 승 ${ex[0].filter((x) => x > 0).length} / 패 ${ex[0].filter((x) => x < 0).length}(평균 ${sg(avg(ex[0]))}%p) | DS6 대비 승 ${ex[1].filter((x) => x > 0).length} / 패 ${ex[1].filter((x) => x < 0).length}(평균 ${sg(avg(ex[1]))}%p) | DS13L 대비 승 ${ex[2].filter((x) => x > 0).length} / 패 ${ex[2].filter((x) => x < 0).length}(평균 ${sg(avg(ex[2]))}%p) | DS13M 대비 승 ${ex[3].filter((x) => x > 0).length} / 패 ${ex[3].filter((x) => x < 0).length}(평균 ${sg(avg(ex[3]))}%p)`);
    }
    // [F3] 손절이 몰린 연도와 현금 비중
    console.log(`\n=== [F3] 연도별 손절 발동 건수와 현금 비중(RM1S 위성 계좌 안·RM1SC 계좌 기준, 일 평균 %; 손절 -20%) ===\n| 연도 | 손절 발동 | 발동 비율(연 보유 종목-일 대비 ‰) | RM1S 현금 % | RM1SC 현금 % | RM1SC 연 수익 % | 069500 연 수익 % |\n|---|---|---|---|---|---|---|`);
    {
      const byY = new Map<string, number>(), cashS = new Map<string, number[]>(), cashC = new Map<string, number[]>(), posD = new Map<string, number>();
      for (const e of events) byY.set(CAL[e.c].slice(0, 4), (byY.get(CAL[e.c].slice(0, 4)) ?? 0) + 1);
      base.sat.dates.forEach((d, i2) => { const y = d.slice(0, 4); (cashS.get(y) ?? cashS.set(y, []).get(y) as number[]).push((1 - base.sat.inv[i2]) * 100); (cashC.get(y) ?? cashC.set(y, []).get(y) as number[]).push((1 - base.res.run.inv[i2]) * 100); posD.set(y, (posD.get(y) ?? 0) + base.sat.nPos[i2]); });
      const bh = BH_FROM(from);
      let tot = 0;
      for (let y = Number(from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) {
        const ys = String(y), n = byY.get(ys) ?? 0;
        tot += n;
        console.log(`| ${y} | ${n} | ${f2((n / Math.max(posD.get(ys) ?? 1, 1)) * 1000)} | ${f2(avg(cashS.get(ys) ?? [0]))} | ${f2(avg(cashC.get(ys) ?? [0]))} | ${f2(h.yearRet(base.res.run, y))} | ${f2(h.yearRet(bh, y))} |`);
      }
      const top = [...byY.entries()].sort((x, y2) => y2[1] - x[1]).slice(0, 4);
      console.log(`합계 ${tot}건, 발동이 많았던 해 ${top.map(([y, n]) => `${y} ${n}건`).join(" · ")} | 평균 현금 비중(전체 평균) RM1S ${f2(avg([...cashS.values()].flat()))}% · RM1SC ${f2(avg([...cashC.values()].flat()))}%`);
    }
    console.log(`\n정보용 실행 종료(시험 아님, 판정 변경 없음) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "egcov") {
    // ROE 변화 데이터 점검(집계만, 수익·신호 성과 계산 없음): 월말마다 BS1 적격 종목 중 ROE(지금)·ROE(1년 전)가 모두 "계산됨"인 비율 → 시작일 규칙(EG_COVERAGE_MIN) 적용.
    await loadEqTables();
    await loadRoe();
    const mes = monthEndIdx.filter((c) => egPrevC(c) >= 0);
    const rows = mes.map((c) => {
      const d = CAL[c], dp = CAL[egPrevC(c)], el = bsElig(c, B5_BS_P0), whyNow = new Map<RoeWhy, number>(), whyPrev = new Map<RoeWhy, number>();
      let nowOk = 0, prevOk = 0, both = 0;
      for (const code of el) {
        const a = roeOf(code, d, EG1_P0.maxAge), b = roeOf(code, dp, EG1_P0.maxAge);
        if (a.why === "ok") nowOk++; else whyNow.set(a.why, (whyNow.get(a.why) ?? 0) + 1);
        if (b.why === "ok") prevOk++; else whyPrev.set(b.why, (whyPrev.get(b.why) ?? 0) + 1);
        if (a.why === "ok" && b.why === "ok") both++;
      }
      const n = Math.max(el.length, 1);
      return { d, dp, n: el.length, nowOk, prevOk, both, rNow: nowOk / n, rPrev: prevOk / n, rBoth: both / n, whyNow, whyPrev };
    });
    console.log(`\n=== [E0] 월말별 ROE(지금)·ROE(1년 전) 계산 비율(BS1 적격 종목 수 기준; 계산됨 = Q1 roeAt "ok": 경과 ${EG1_P0.maxAge}일 이내 ∧ TTM 계산 가능 ∧ 자본 > 0 ∧ 순이익 TTM > 0) — 연도별 월평균과 처음 60% 근처 월 ===`);
    const byY = new Map<string, typeof rows>();
    for (const r of rows) { const y = r.d.slice(0, 4), a = byY.get(y) ?? []; a.push(r); byY.set(y, a); }
    for (const [y, a] of [...byY.entries()].sort()) console.log(`${y}: 월말 ${a.length}개 | 지금 ${f2(avg(a.map((x) => x.rNow)) * 100)}% · 1년 전 ${f2(avg(a.map((x) => x.rPrev)) * 100)}% · 둘 다 ${f2(avg(a.map((x) => x.rBoth)) * 100)}% | 둘 다 60% 이상 ${a.filter((x) => x.rBoth >= EG_COVERAGE_MIN).length}/${a.length}개월`);
    const first = rows.find((r) => r.rBoth >= EG_COVERAGE_MIN);
    console.log(`\n월별(2011~2014): 월말 | BS1 적격 | 지금 계산 | 1년 전 계산 | 둘 다 | 둘 다 비율`);
    for (const r of rows.filter((x) => x.d < "2014-01-01")) console.log(`${r.d} | ${r.n} | ${r.nowOk} | ${r.prevOk} | ${r.both} | ${f2(r.rBoth * 100)}%${first && r.d === first.d ? "  ← 처음 60% 이상" : ""}`);
    if (!first) { console.log(`\n시작일 규칙(둘 다 계산 비율 ≥ ${EG_COVERAGE_MIN * 100}%인 첫 월말) 충족 월 없음 — 시험하지 않고 멈춰 보고한다`); throw new Error("ROE 변화 시작일 규칙 충족 월 없음 — 중단"); }
    const after = rows.filter((x) => x.d >= first.d), dips = after.filter((x) => x.rBoth < EG_COVERAGE_MIN);
    const fmtWhy = (m: Map<RoeWhy, number>): string => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ");
    console.log(`\n시작일(규칙 적용 결과): **${first.d}**(1년 전 기준일 ${first.dp}) | BS1 적격 ${first.n}, 지금 계산 ${first.nowOk}, 1년 전 계산 ${first.prevOk}, 둘 다 ${first.both}(${f2(first.rBoth * 100)}%) | 지금 불가 사유 ${fmtWhy(first.whyNow)} | 1년 전 불가 사유 ${fmtWhy(first.whyPrev)}`);
    console.log(`시작일 이후 월말 ${after.length}개: 둘 다 비율 최소 ${f2(Math.min(...after.map((x) => x.rBoth)) * 100)}% 평균 ${f2(avg(after.map((x) => x.rBoth)) * 100)}% | 60% 미만으로 다시 떨어진 월 ${dips.length}개${dips.length ? `(${dips.slice(0, 12).map((x) => `${x.d} ${f2(x.rBoth * 100)}%`).join(", ")})` : ""}`);
    const cands = after.map((x) => egRowsAt(monthEndIdx.find((c) => CAL[c] === x.d) as number, egPrevC(monthEndIdx.find((c) => CAL[c] === x.d) as number)).length);
    console.log(`EG1 후보 수(시작일 이후 월말): 최소 ${Math.min(...cands)} · 평균 ${f2(avg(cands))} · 최대 ${Math.max(...cands)} | 30개 미만 월 ${cands.filter((x) => x < EG1_P0.n).length}개`);
    console.log(`\nROE 변화 데이터 점검 종료(성과 미계산) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "dvraw") {
    // 배당 원행 형태 점검(집계만, 성과·신호 계산 없음): 보통주 행 판별 불가 행의 원행 패턴을 세고, 우선주 표기가 있는 행에서 "첫 행 = 보통주" 관례를 검증한다. 파서 규칙을 사전등록에 적기 위한 자료 형식 확인.
    await loadDiv();
    type PR = { knd: string; v: (number | null)[]; raw: string[] };
    const parse = (rows: string): PR[] => rows.split(";").filter((x) => x !== "").map((x) => { const a = x.split("|"), nm = (t: string | undefined): number | null => { const u = (t ?? "").trim().replace(/,/g, ""); if (u === "" || u === "-") return null; const v = Number(u); return Number.isFinite(v) ? v : null; }; return { knd: a[0], v: [nm(a[1]), nm(a[2]), nm(a[3])], raw: [a[1] ?? "", a[2] ?? "", a[3] ?? ""] }; });
    const cls = (k: string): string => (/보통/.test(k) ? "C" : /우선|종류/.test(k) ? "P" : k === "-" ? "-" : "U");
    const lab = new Map<string, number>(), pat = new Map<string, number>(), pat000 = new Map<string, number>();
    let nAll = 0, nNo = 0, nBothLab = 0, cFirst = 0, cOther = 0;
    for (const r of divRaw) {
      if (r.status !== "000" || r.rows === "") continue;
      const ps = parse(r.rows); nAll++;
      for (const x of ps) lab.set(x.knd, (lab.get(x.knd) ?? 0) + 1);
      const key = ps.map((x) => cls(x.knd)).join("");
      pat.set(key, (pat.get(key) ?? 0) + 1);
      if (r.d0 === null && r.raw !== "-") { nNo++; const k2 = `${key} | 첫 행 당기 ${ps[0] ? (ps[0].v[0] === null ? (ps[0].raw[0] === "-" ? "대시" : "빈값") : ps[0].v[0] > 0 ? "숫자>0" : "숫자0") : "없음"} · 둘째 행 당기 ${ps[1] ? (ps[1].v[0] === null ? (ps[1].raw[0] === "-" ? "대시" : "빈값") : ps[1].v[0] > 0 ? "숫자>0" : "숫자0") : "없음"}`; pat000.set(k2, (pat000.get(k2) ?? 0) + 1); }
      const iC = ps.findIndex((x) => cls(x.knd) === "C"), hasP = ps.some((x) => cls(x.knd) === "P");
      if (iC >= 0 && hasP) { nBothLab++; if (iC === 0) cFirst++; else cOther++; }
    }
    const top = (m: Map<string, number>, n: number): string => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(" · ");
    console.log(`\n=== [W1] 배당 항목(주당 현금배당금 행)이 있는 status 000 행 ${nAll}건 | 종류 표기(stock_knd) 빈도: ${top(lab, 14)} ===`);
    console.log(`행 구성 패턴(C=보통, P=우선·종류, -=표기 "-", U=그 밖; 왼쪽부터 원행 순서): ${top(pat, 14)}`);
    console.log(`\n=== [W2] 보통주 행 판별 불가 ${nNo}건의 패턴(첫 행·둘째 행 당기 값 유형 포함) ===\n${top(pat000, 20)}`);
    console.log(`\n=== [W3] 관례 검증: 보통 표기와 우선 표기가 같이 있는 ${nBothLab}건에서 보통주 행이 첫 행인 경우 ${cFirst}건(${f2((cFirst / Math.max(nBothLab, 1)) * 100)}%) · 둘째 이후 ${cOther}건 ===`);
    // [W4] 표기 없는 행의 첫 행 vs 둘째 행: 사업연도 간 일관성(FY y의 전기값 = FY y−1의 당기값)으로 어느 쪽이 연속 시계열인지 본다
    {
      const byKey = new Map<string, (typeof divRaw)[number]>();
      for (const r of divRaw) if (r.status === "000" && r.rows !== "") byKey.set(`${r.code}|${r.fy}`, r);
      let nPair = 0, firstSame = 0, secondSame = 0, firstOnlyNum = 0;
      for (const r of divRaw) {
        if (r.status !== "000" || r.rows === "" || r.d0 !== null || r.raw === "-") continue;
        const prev = byKey.get(`${r.code}|${r.fy - 1}`);
        if (!prev) continue;
        const a = parse(r.rows), b = parse(prev.rows);
        if (a.length < 2 || b.length < 2 || a.some((x) => cls(x.knd) !== "-") || b.some((x) => cls(x.knd) !== "-")) continue;
        nPair++;
        const f = a[0].v[1] !== null && b[0].v[0] !== null && a[0].v[1] === b[0].v[0], s2 = a[1].v[1] !== null && b[1].v[0] !== null && a[1].v[1] === b[1].v[0];
        if (f) firstSame++; if (s2) secondSame++;
        if (a[0].v[0] !== null && a[1].v[0] === null) firstOnlyNum++;
      }
      console.log(`\n=== [W4] 표기가 모두 "-"이고 행이 2개 이상인 연속 두 해 ${nPair}쌍: 첫 행 전기값 = 전해 당기값 ${firstSame}쌍 · 둘째 행 ${secondSame}쌍 | 첫 행만 숫자(둘째 행은 숫자 아님) ${firstOnlyNum}건 ===`);
    }
    console.log(`\n배당 원행 점검 종료(성과 미계산) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "dvcov") {
    // 배당 데이터 점검(집계만, 수익·신호 성과 계산 없음): ① 사업연도별 수집 커버리지 ② 월말마다 배당수익률 계산 가능 비율 → 시작일 규칙(DV_COVERAGE_MIN) 적용.
    await loadDiv();
    await loadRoe();
    console.log(`\n=== [V0] 사업연도별 수집 커버리지(종목 × 사업연도 행; status 000 = 자료 있음, 013 = 자료 없음) ===`);
    const fyRows = new Map<number, { n: number; s000: number; s013: number; pos: number; zero: number; dash: number; nocommon: number; none: number; other: number }>();
    for (const r of divRaw) {
      const o = fyRows.get(r.fy) ?? { n: 0, s000: 0, s013: 0, pos: 0, zero: 0, dash: 0, nocommon: 0, none: 0, other: 0 };
      o.n++;
      if (r.status === "013") o.s013++;
      else if (r.status !== "000") o.other++;
      else {
        o.s000++;
        if (r.d0 !== null) { if (r.d0 > 0) o.pos++; else o.zero++; }
        else if (r.raw === "-") o.dash++;
        else if (r.rows === "") o.none++;
        else o.nocommon++;
      }
      fyRows.set(r.fy, o);
    }
    console.log(`| 사업연도 | 행 | status 000 | 013 | 기타 | 보통주 숫자 > 0 | 숫자 0 | "-"(무배당) | 보통주 행 판별 불가 | 배당 항목 없음 | 값 확보(숫자+대시)/행 |\n|---|---|---|---|---|---|---|---|---|---|---|`);
    let tot = { n: 0, ok: 0 };
    for (const [fy, o] of [...fyRows.entries()].sort((a, b) => a[0] - b[0])) { tot.n += o.n; tot.ok += o.pos + o.zero + o.dash; console.log(`| ${fy} | ${o.n} | ${o.s000} | ${o.s013} | ${o.other} | ${o.pos} | ${o.zero} | ${o.dash} | ${o.nocommon} | ${o.none} | ${f2(((o.pos + o.zero + o.dash) / Math.max(o.n, 1)) * 100)}% |`); }
    console.log(`합계: 행 ${tot.n}, 값 확보 ${tot.ok}(${f2((tot.ok / Math.max(tot.n, 1)) * 100)}%) | 종목 ${divBy.size}개가 status 000 행을 가짐`);
    const nocommonSamples = divRaw.filter((r) => r.status === "000" && r.d0 === null && r.raw !== "-" && r.rows !== "").slice(0, 12);
    console.log(`보통주 행 판별 불가 표본(원행 종류|당기|전기|전전기, 최대 12개): ${nocommonSamples.map((r) => `${r.code}/${r.fy}: ${r.rows.slice(0, 90)}`).join(" || ")}`);
    const rowByCode = new Map<string, number>(); for (const r of divRaw) rowByCode.set(r.code, (rowByCode.get(r.code) ?? 0) + 1);

    const mes = monthEndIdx.filter((c) => CAL[c] >= "2015-06-01");
    const rows = mes.map((c) => {
      const d = CAL[c], el = bsElig(c, B5_BS_P0), why = new Map<DivWhy, number>();
      let ok = 0, cont = 0, pos = 0;
      for (const code of el) {
        const o = divAt(code, d, DV1_P0.maxAge);
        if (o.why === "ok") {
          ok++; if ((o.dps as number) > 0) pos++;
          const rr = roeOf(code, d, DV1_P0.maxAge);
          if ((o.dps as number) > 0 && (o.d1 ?? 0) > 0 && (o.d2 ?? 0) > 0 && rr.why === "ok") cont++;
        } else why.set(o.why, (why.get(o.why) ?? 0) + 1);
      }
      // 참고(정보용): 시장(KOSPI·KOSDAQ) 가격 행이 있는 비제외 전 종목 대비 비율
      const m = membAt(d); let all = 0, allOk = 0;
      if (m) for (const st of h.stocks) { const i = st.idx.get(d); if (i === undefined || excluded.has(st.code)) continue; const mk = m.get(st.code); if (mk !== "KOSPI" && mk !== "KOSDAQ") continue; all++; if (divAt(st.code, d, DV1_P0.maxAge).why === "ok") allOk++; }
      return { d, n: el.length, ok, pos, cont, r: ok / Math.max(el.length, 1), why, all, allOk, rAll: allOk / Math.max(all, 1) };
    });
    console.log(`\n=== [V1] 월말별 배당수익률 계산 비율(분모 = BS1 적격 종목 수; 계산됨 = 접수일 < 월말 ∧ 경과 ${DV1_P0.maxAge}일 이내 ∧ 보통주 당기 값이 숫자 또는 "-"(0)) — 연도별 월평균 ===`);
    const byY = new Map<string, typeof rows>();
    for (const r of rows) { const y = r.d.slice(0, 4), a = byY.get(y) ?? []; a.push(r); byY.set(y, a); }
    for (const [y, a] of [...byY.entries()].sort()) console.log(`${y}: 월말 ${a.length}개 | 계산 비율(BS1 적격) ${f2(avg(a.map((x) => x.r)) * 100)}% · (참고: 시장 전 종목) ${f2(avg(a.map((x) => x.rAll)) * 100)}% | 60% 이상 ${a.filter((x) => x.r >= DV_COVERAGE_MIN).length}/${a.length}개월 | 배당수익률 > 0 평균 ${f2(avg(a.map((x) => x.pos)))}개 | 연속성 만족 평균 ${f2(avg(a.map((x) => x.cont)))}개`);
    const fmtWhy = (m: Map<DivWhy, number>): string => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ");
    console.log(`\n월별(2015-06 ~ 2017-12): 월말 | BS1 적격 | 계산 | 비율 | 연속성 만족 | 불가 사유`);
    const first = rows.find((x) => x.r >= DV_COVERAGE_MIN);
    for (const r of rows.filter((x) => x.d < "2018-01-01")) console.log(`${r.d} | ${r.n} | ${r.ok} | ${f2(r.r * 100)}% | ${r.cont} | ${fmtWhy(r.why)}${first && r.d === first.d ? "  ← 처음 60% 이상" : ""}`);
    if (!first) { console.log(`\n시작일 규칙(계산 비율 ≥ ${DV_COVERAGE_MIN * 100}%인 첫 월말) 충족 월 없음 — 시험하지 않고 멈춰 보고한다`); throw new Error("배당 시작일 규칙 충족 월 없음 — 중단"); }
    const after = rows.filter((x) => x.d >= first.d), dips = after.filter((x) => x.r < DV_COVERAGE_MIN);
    console.log(`\n시작일(규칙 적용 결과): **${first.d}** | BS1 적격 ${first.n}, 계산 ${first.ok}(${f2(first.r * 100)}%), 연속성 만족 ${first.cont} | 불가 사유 ${fmtWhy(first.why)}`);
    console.log(`시작일 이후 월말 ${after.length}개: 계산 비율 최소 ${f2(Math.min(...after.map((x) => x.r)) * 100)}% 평균 ${f2(avg(after.map((x) => x.r)) * 100)}% | 60% 미만으로 다시 떨어진 월 ${dips.length}개${dips.length ? `(${dips.slice(0, 12).map((x) => `${x.d} ${f2(x.r * 100)}%`).join(", ")})` : ""}`);
    const cands = after.map((x) => x.cont);
    console.log(`DV1 후보 수(연속성 만족, 시작일 이후 월말): 최소 ${Math.min(...cands)} · 평균 ${f2(avg(cands))} · 최대 ${Math.max(...cands)} | ${DV1_P0.n}개 미만 월 ${cands.filter((x) => x < DV1_P0.n).length}개 | 20개 미만 월 ${cands.filter((x) => x < 20).length}개`);
    console.log(`\n배당 데이터 점검 종료(성과 미계산) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "dvpre") {
    // 배당 사전 점검(DV1·DV1C 성과 미계산): DS6 재현(위 줄), 배당 값·후보 독립 재계산(400건 + 월말 20개 전 종목 직접 훑기), 접수일 다음 거래일 반영 경계, 보유 수·첫 체결일, 월 리밸런스 경로, 시작일 커버리지, 후보 수, 소멸 관례.
    await loadDiv();
    await loadRoe();
    requireStart();
    const fails: string[] = [];
    const rngD = mulberry32(20261128);
    const dv1 = mkDV("DV1", DV1_P0, DV_NB), cD = startOf(dv1, false), Wd = windowsV(cD), days = monthEndIdx.filter((x) => x >= cStartV);
    console.log(`[점검 1] 데이터 표준: 가격 보정 ${PRICE_CORRECTION_ON ? "k200p17 적용" : "미적용"} · 의심 종목-일 0% 처리 ${ZERO_SUSPECT_ON ? `적용 ${suspectLog.length}건` : "미적용"} | 소멸 관례: 저PBR·ROE 시험과 같음(vbVanishLoss), 슬리피지 신호일 K200P 구성원 ${B5_BS_SLIP_K200 * 100}%·그 밖 ${B5_BS_SLIP_OTHER * 100}%`);
    if (!PRICE_CORRECTION_ON || !ZERO_SUSPECT_ON) fails.push("보정 또는 의심 종목-일 0% 처리 미적용(correct=k200p17 zero=1 필요)");
    console.log(`[점검 2] 시작: V_START ${V_START}(DV_START ${DV_START}) | 첫 신호일 ${CAL[cD]} | 케이스 ${V_CASE} | 수익률 집계 ${Wd.FULL.from}~${h.dataEnd} | 구간 ${Wd.NW.map(([nm, w]) => `${nm} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")} | DS6 재현 기록 ${DV_DS6_REF.join(" / ")}(위 "DS6 재현" 줄과 같은 값이어야 함)`);
    if (!DV_START || V_START !== DV_START || V_CASE !== "C2") fails.push(`시작·구간 불일치: V_START ${V_START} (사전등록 ${DV_START || "미확정"}), 케이스 ${V_CASE}`);
    if (DV1C_W[0] !== B5_CORE_W || DV1C_W[0] + DV1C_W[1] !== 1) fails.push(`DV1C 비중 ${DV1C_W.join("/")} ≠ 코어 ${B5_CORE_W}`);
    // [점검 3] 배당 독립 재계산: 원행(divRaw)만 쓰는 따로 짠 코드(접수일 문자열 비교·Date.parse 경과일·원문 "-" 처리)
    const rawBy = new Map<string, typeof divRaw>();
    for (const r of divRaw) { const a = rawBy.get(r.code) ?? []; a.push(r); rawBy.set(r.code, a); }
    // 보통주 행 해석도 따로 짠다(includes·인덱스 순회; 모듈은 정규식 find)
    const bruteCommon = (rows: string): { t0: string; t1: string; t2: string } | null => {
      const ps = rows.split(";").filter((x) => x.length > 0).map((x) => x.split("|"));
      let idx = -1;
      for (let i = 0; i < ps.length; i++) if ((ps[i][0] ?? "").includes("보통")) { idx = i; break; }
      if (idx < 0) { if (ps.length === 0) return null; const k = ps[0][0] ?? ""; if (k.includes("우선") || k.includes("종류")) return null; idx = 0; }
      return { t0: (ps[idx][1] ?? "").trim(), t1: (ps[idx][2] ?? "").trim(), t2: (ps[idx][3] ?? "").trim() };
    };
    const bruteNum = (t: string): number | null => { if (t === "" || t === "-") return null; const v = Number(t.split(",").join("")); return Number.isNaN(v) ? null : v; };
    const bruteDiv = (code: string, d: string, maxAge: number): { why: string; dps?: number; d1?: number | null; d2?: number | null } => {
      const rs = (rawBy.get(code) ?? []).filter((r) => r.status === "000" && r.rcept !== "" && r.rcept < d).sort((a, b) => a.fy - b.fy || (a.rcept < b.rcept ? -1 : 1));
      if (!rs.length) return { why: "no_report" };
      const F = rs[rs.length - 1];
      if ((Date.parse(d) - Date.parse(F.rcept)) / 86_400_000 > maxAge) return { why: "stale" };
      const c = bruteCommon(F.rows);
      if (c === null) return { why: "no_common" };
      const v0 = bruteNum(c.t0);
      if (v0 !== null) return { why: "ok", dps: v0, d1: bruteNum(c.t1), d2: bruteNum(c.t2) };
      if (c.t0 === "-") return { why: "ok", dps: 0, d1: null, d2: null };
      return { why: "no_common" };
    };
    {
      const marchDays = days.filter((x) => CAL[x].slice(5, 7) === "03");
      let nChk = 0, nOk = 0, nCand = 0, nBoundary = 0;
      const whyCnt = new Map<string, number>();
      for (let t = 0; t < DV_RECALC_N; t++) {
        // 400건 중 앞 1/4은 3월 월말(사업보고서 접수 집중 시기, 접수일 = 신호일인 경계 사례 포함)에서 뽑는다
        const c = (t < DV_RECALC_N / 4 && marchDays.length ? marchDays : days)[Math.floor(rngD() * (t < DV_RECALC_N / 4 && marchDays.length ? marchDays.length : days.length))], el = bsElig(c, B5_BS_P0);
        if (!el.length) continue;
        const code = el[Math.floor(rngD() * el.length)], d = CAL[c], a = divAt(code, d, DV1_P0.maxAge), b = bruteDiv(code, d, DV1_P0.maxAge);
        nChk++;
        const sameDay = (rawBy.get(code) ?? []).some((r) => r.status === "000" && r.rcept === d); if (sameDay) nBoundary++;
        const mapped = a.why === "ok" ? "ok" : a.why === "no_value" ? "no_common" : a.why;
        whyCnt.set(`${a.why}/${b.why}`, (whyCnt.get(`${a.why}/${b.why}`) ?? 0) + 1);
        if (mapped !== b.why) { fails.push(`배당 사유 불일치 ${code} ${d}: 모듈 ${a.why} 독립 ${b.why}`); continue; }
        const inRows = dvRowsAt(c, DV1_P0).find((x) => x.code === code);
        if (b.why === "ok") {
          nOk++;
          if (a.dps !== b.dps) fails.push(`주당 배당금 불일치 ${code} ${d}: ${a.dps} vs ${b.dps}`);
          const roe = roeOf(code, d, DV1_P0.maxAge), s = h.byCode.get(code) as S, px = s.raw[s.idx.get(d) as number];
          const cand = (b.dps as number) > 0 && ((b.d1 ?? 0) > 0) && ((b.d2 ?? 0) > 0) && roe.why === "ok" && px > 0;
          if (cand) { nCand++; if (!inRows || Math.abs(inRows.yld - (b.dps as number) / px) > 1e-12 * Math.max(Math.abs(inRows.yld), 1e-12)) fails.push(`배당수익률 불일치 ${code} ${d}: 모듈 ${inRows?.yld} 독립 ${(b.dps as number) / px}`); }
          else if (inRows) fails.push(`후보 조건 불충족인데 후보에 있음 ${code} ${d}`);
        } else if (inRows) fails.push(`배당 계산 불가인데 후보에 있음 ${code} ${d}`);
      }
      console.log(`[점검 3] 배당 독립 재계산 ${nChk}건(앞 ${DV_RECALC_N / 4}건은 3월 월말; 계산됨 ${nOk}건, 그중 후보 ${nCand}건 값 대조; 접수일 = 신호일인 경계 사례 ${nBoundary}건 포함) | 모듈/독립 사유 분포 ${[...whyCnt.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
      if (nChk < DV_RECALC_N * 0.9) fails.push(`독립 재계산 건수 부족 ${nChk}/${DV_RECALC_N}`);
      if (nBoundary === 0) console.log(`  (참고: 접수일 = 신호일 경계 사례가 표본에 0건 — 경계 규칙은 독립 코드에서 접수일 < 신호일 문자열 비교로 같게 적용됨)`);
    }
    // [점검 4] 후보 집합·순위 독립 재계산(월말 20개): 전 종목을 직접 훑어 연속성 조건·배당수익률 순서 비교
    {
      const picks = Array.from({ length: 20 }, (_, k) => days[Math.floor((k * (days.length - 1)) / 19)]);
      let nOk = 0;
      const rowsOut: string[] = [];
      for (const c of picks) {
        const d = CAL[c], el = bruteBs(c, B5_BS_P0).map((x) => x.code), br: { code: string; yld: number }[] = [];
        for (const code of el) {
          const b = bruteDiv(code, d, DV1_P0.maxAge);
          if (b.why !== "ok" || !((b.dps as number) > 0 && (b.d1 ?? 0) > 0 && (b.d2 ?? 0) > 0)) continue;
          if (roeOf(code, d, DV1_P0.maxAge).why !== "ok") continue;
          const s = h.byCode.get(code) as S, px = s.raw[s.idx.get(d) as number];
          if (!(px > 0)) continue;
          br.push({ code, yld: (b.dps as number) / px });
        }
        br.sort((x, y) => y.yld - x.yld || (x.code < y.code ? -1 : 1));
        const mod = dvRowsAt(c, DV1_P0);
        const ok = mod.length === br.length && mod.every((x, k) => x.code === br[k].code && Math.abs(x.yld - br[k].yld) <= 1e-12 * Math.max(Math.abs(br[k].yld), 1e-12));
        if (ok) nOk++; else fails.push(`DV1 후보·순서 불일치 ${d}: 모듈 ${mod.length} 독립 ${br.length}`);
        rowsOut.push(`${d} 적격 ${el.length} → 후보 ${br.length}(모듈 ${mod.length}) | 상위 3 ${mod.slice(0, 3).map((x) => `${label(x.code)}(${f2(x.yld * 100)}%, FY${x.fy})`).join(", ")}`);
      }
      console.log(`[점검 4] 후보 집합·순서 독립 재계산(전 종목 직접 훑기) 월말 ${picks.length}개: 일치 ${nOk}개\n${rowsOut.map((x) => `  ${x}`).join("\n")}`);
    }
    // [점검 5] 구조: 보유 수·첫 체결일·진입 종목의 후보 여부, 후보 수, 소멸 관례, DV1C 날짜 축·월 리밸런스 경로
    {
      const run = runS(dv1, DV1_P0, cD, null, { lag: 1, detail: true });
      const hmax = Math.max(...run.nPos.map((x, k) => x - (run.nDefer[k] ?? 0))), cnt = days.map((c) => dvRowsAt(c, DV1_P0).length);
      console.log(`[점검 5] DV1: 보유 종목 수 최대(순연 제외) ${hmax} (목표 ${DV1_P0.n}) | 첫 체결일 ${CAL[run.entryCs[0]]} (신호일 다음 거래일 ${CAL[cD + 1]}) | 진입 ${run.entryCs.length}건 | 후보 수(월말 ${cnt.length}개) 최소 ${Math.min(...cnt)} 평균 ${f2(avg(cnt))} 최대 ${Math.max(...cnt)}, ${DV1_P0.n}개 미만 월 ${cnt.filter((x) => x < DV1_P0.n).length}개`);
      if (hmax > DV1_P0.n) fails.push(`DV1 보유 종목 수 ${hmax} > ${DV1_P0.n}`);
      if (run.entryCs[0] !== cD + 1) fails.push(`DV1 첫 체결일 ${CAL[run.entryCs[0]]} ≠ ${CAL[cD + 1]}`);
      if (cnt.some((x) => x < DV1_P0.n)) fails.push(`DV1 후보 ${DV1_P0.n}개 미만인 월 ${cnt.filter((x) => x < DV1_P0.n).length}개`);
      const bad = run.trades.concat(run.open).filter((t) => !dvRowsAt(t.entryC - 1, DV1_P0).some((x) => x.code === t.code)).length;
      if (bad) fails.push(`DV1 진입 종목 중 신호일 후보가 아닌 경우 ${bad}건`);
      const closed = run.trades;
      console.log(`[점검 5] DV1 소멸 종목 청산: 마지막 종가 청산 ${closed.filter((x) => x.reason === "폐지").length}건 · 전액 손실 ${closed.filter((x) => x.reason === "폐지(전액 손실)").length}건(닫힌 거래 ${closed.length}건 중)`);
      for (const [lb, ch] of DV_NB) { const P = { ...DV1_P0, ...ch }, c2 = days.map((c) => dvRowsAt(c, P).length); console.log(`[점검 5] 이웃 ${lb}: 후보 수 최소 ${Math.min(...c2)} 평균 ${f2(avg(c2))} (목표 ${P.n}개 미만 월 ${c2.filter((x) => x < P.n).length}개)`); if (c2.some((x) => x < P.n)) fails.push(`이웃 ${lb} 후보 부족`); }
      const coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, Wd.FULL.from), sat = slFromRun(run);
      if (coreFull.dates.length !== sat.dates.length || coreFull.dates.some((x, k) => x !== sat.dates[k])) fails.push("DV1C 날짜 축");
      else console.log(`[점검 5] DV1C 날짜 축: 코어 ${coreFull.dates[0]}~${coreFull.dates[coreFull.dates.length - 1]}(${coreFull.dates.length}일) = 위성 일치`);
      const a = combineN([coreFull, sat], [DV1C_W[0], DV1C_W[1]], CS_MOVE_COST, null).run.ret, b = combine2(coreFull, sat, DV1C_W[0], CS_MOVE_COST).run.ret;
      let mxd = 0;
      for (let k = 0; k < a.length; k++) mxd = Math.max(mxd, Math.abs(a[k] - b[k]));
      const sig = [...new Set(monthEndIdx.filter((c) => c > cD).map((c) => CAL[c]))], sg1 = dv1.signalDays.filter((c) => c > cD).map((c) => CAL[c]);
      console.log(`[점검 5] 월 리밸런스 경로: combineN(매일) ↔ combine2 일수익률 최대 차이 ${mxd.toExponential(2)}%p | 월 재조정 신호일 ${sig.length}개(${sig[0]}~${sig[sig.length - 1]}), DV1 월말 신호일(첫 신호일 제외)과 ${sig.length === sg1.length && sig.every((d, k) => d === sg1[k]) ? "일치" : "불일치"}`);
      if (!(mxd < 1e-9)) fails.push(`combineN(매일) ≠ combine2 (최대 차이 ${mxd})`);
      if (!(sig.length === sg1.length && sig.every((d, k) => d === sg1[k]))) fails.push("월 재조정 신호일 ≠ DV1 월말 신호일");
      const mm = combineN([coreFull, sat], [DV1C_W[0], DV1C_W[1]], CS_MOVE_COST, new Set(sig)), yrs = (Date.parse(h.dataEnd) - Date.parse(Wd.FULL.from)) / 86_400_000 / 365.25;
      console.log(`[점검 5] DV1C 월 리밸런스 이동 금액 연 ${f2((mm.moved.reduce((s2, x) => s2 + x, 0) * 100) / yrs)}% (이동 비용 ${CS_MOVE_COST * 100}%)`);
    }
    {
      const el = bsElig(cD, B5_BS_P0), ok = el.filter((code) => divAt(code, CAL[cD], DV1_P0.maxAge).why === "ok").length, r = ok / Math.max(el.length, 1);
      console.log(`[점검 6] 시작일 ${CAL[cD]} 배당수익률 계산 비율: BS1 적격 ${el.length}, 계산 ${ok} = ${f2(r * 100)}%(기준 ${DV_COVERAGE_MIN * 100}% 이상) | 연속성 직전 ${DV_HIST_YEARS}개 사업연도`);
      if (r < DV_COVERAGE_MIN) fails.push(`시작일 커버리지 ${f2(r * 100)}% < ${DV_COVERAGE_MIN * 100}%`);
    }
    console.log(`\n정보용 항목 구현 목록(시험 출력에서 이 머리표로 대조): [R3] 연도별 069500·DS6·DS13L 대비 승패 · [R4] 승률·손익비·기대값(평가 출력의 "요약" 줄) · [R5] 나란히 비교 표(DS6·DS13L·RM1SC·VB1·QV1) · [R6] 연 회전율·비용 · [R7] 상위 10개 거래 손익 비중 · [V3] 삼성전자·SK하이닉스 평균 비중 · [V4] VB1 MDD 구간 수익 · [V5] 하루 지연 · [V6] VB1·QV1·RM1 등 일간 상관 · [V7] 월 신호일 앞당김 민감도(dvinfo2) · [V8] 의심 종목-일 처리 없음 비교(dvinfo) · [D1] 평균 배당수익률·PBR·금융주·지주사 비중 · [D2] 후보 집합 크기 · [D3] 제외 종목-월 비율 · [V9] 누적 시험·우연 통과 기대(요약)`);
    if (fails.length) { console.log(`\n사전 점검 실패 ${fails.length}건:\n${fails.slice(0, 40).map((x) => `  - ${x}`).join("\n")}`); throw new Error("사전 점검 실패 — 시험하지 않고 중단해 보고한다"); }
    console.log(`\n배당 사전 점검 통과(DV1·DV1C 성과는 계산·출력하지 않았다; DS6 재현 줄은 환경 확인용) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "dvinfo") {
    // 정보용(시험 아님): DV1·DV1C·QV1·VB1·RM1·RM1SC·DS13L·DS6·069500 기준 실행의 구간별 CAGR/MDD — 의심 종목-일 0% 처리 유무(zero=0) 또는 삼성전자·SK하이닉스 수익 0(neutralize) 비교용.
    await loadEqTables();
    await loadDiv();
    await loadRoe();
    requireStart();
    const dv1 = mkDV("DV1", DV1_P0, DV_NB), vb1 = mkVB("VB1", VB1_P0, VB1_NB), qv1 = mkQ("QV1", QV1_P0, QV1_NB), cV = startOf(dv1, false), Wx = windowsV(cV);
    const dvRun = runS(dv1, DV1_P0, cV, null, { lag: 1, detail: true });
    const sigSet = new Set(monthEndIdx.filter((c) => c > cV).map((c) => CAL[c]));
    const dvc = combineN([sliceSl(coreOf(2, undefined, 1, {}).sl, Wx.FULL.from), slFromRun(dvRun)], [DV1C_W[0], DV1C_W[1]], CS_MOVE_COST, sigSet).run;
    const rows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [
      { nm: "DV1", run: dvRun }, { nm: "DV1C", run: dvc }, { nm: "QV1", run: runS(qv1, QV1_P0, cV, null, { lag: 1, detail: true }) },
      { nm: "VB1", run: runS(vb1, VB1_P0, cV, null, { lag: 1, detail: true }) }, { nm: "RM1", run: runS(RM1, RM1.P0, cV, null, { lag: 1, detail: true }) }, { nm: "RM1SC", run: rm1scOf(cV, Wx).res.run },
      { nm: "DS13L", run: d13Of("LV1", cV, Wx).base.res.run }, { nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run },
    ];
    console.log(`\n=== [V8] 정보용: ${ZERO_SUSPECT_ON ? `의심 종목-일 0% 처리 적용(${suspectLog.length}건)` : "의심 종목-일 처리 없음"}${NEUTRALIZE_ON ? ` · 수익 0 처리 종목 ${process.env.NEUTRALIZE_CODES ?? ""}(가격 수익만 0으로 둔 중립화)` : ""} — CAGR % / MDD % (같은 구간 ${Wx.FULL.from}~) ===\n| 구간 | ${rows.map((r) => r.nm).join(" | ")} |\n|---|${rows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${rows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    console.log(`\n정보용 실행 종료(시험 아님) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "dvinfo2") {
    // 정보용(시험 아님, 판정 변경 없음): 월 신호일을 마지막 거래일에서 5·10거래일 앞당긴 민감도(DV1·DV1C). 배당·ROE 조건은 앞당긴 신호일 기준으로 다시 계산한다.
    await loadEqTables();
    await loadDiv();
    await loadRoe();
    requireStart();
    const dv0 = mkDV("DV1", DV1_P0, DV_NB), cV = startOf(dv0, false), Wx = windowsV(cV), from = Wx.FULL.from, bRun = { dates: h.bhP.dates, ret: h.bhP.ret };
    const coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, from);
    const shifts = [0, 5, 10].map((sh) => {
      const def = mkDV("DV1", DV1_P0, DV_NB, { shift: sh }), run = runS(def, DV1_P0, cV, null, { lag: 1, detail: true });
      const sig = new Set(def.signalDays.filter((c) => c > cV).map((c) => CAL[c]));
      return { sh, dv1: run, dvc: combineN([coreFull, slFromRun(run)], [DV1C_W[0], DV1C_W[1]], CS_MOVE_COST, sig).run };
    });
    console.log(`\n=== [V7] 정보용 견고성 점검: 월 신호일을 마지막 거래일에서 5·10거래일 앞당김 — CAGR % / MDD % (같은 구간 ${from}~, 보정 + 0% 처리 데이터) ===`);
    for (const [lb, pick] of [["DV1", (x: (typeof shifts)[number]) => x.dv1], ["DV1C", (x: (typeof shifts)[number]) => x.dvc]] as [string, (x: (typeof shifts)[number]) => { dates: string[]; ret: number[] }][]) {
      console.log(`${lb}\n| 구간 | 069500 | 기준(0일) | −5일 | −10일 |\n|---|---|---|---|---|`);
      for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${f2(h.st(bRun, w).cagr)} / ${f2(h.st(bRun, w).mdd)} | ${shifts.map((x) => `${f2(h.st(pick(x), w).cagr)} / ${f2(h.st(pick(x), w).mdd)}`).join(" | ")} |`);
      const f0 = h.st(pick(shifts[0]), Wx.FULL);
      console.log(`${lb} 연속 CAGR 차이(기준 대비 %p): ${shifts.slice(1).map((x) => `−${x.sh}일 ${sg(h.st(pick(x), Wx.FULL).cagr - f0.cagr)}(MDD ${sg(h.st(pick(x), Wx.FULL).mdd - f0.mdd)}%p)`).join(" · ")} | CAGR 차이 1.5%p 초과 ${shifts.slice(1).some((x) => Math.abs(h.st(pick(x), Wx.FULL).cagr - f0.cagr) > 1.5) ? "있음" : "없음"}`);
    }
    console.log(`\n정보용 실행 종료(시험 아님, 판정 변경 없음) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "egpre") {
    // ROE 변화 사전 점검(EG1·EGM1 성과 미계산): DS6 재현(위 줄), Q1·QV1 재현, ROE 변화 독립 재계산 400건, 후보 집합·순위 독립 재계산, 보유 수·첫 체결일, 시작일 커버리지, 후보 수, 소멸 관례.
    await loadEqTables();
    await loadRoe();
    requireStart();
    const fails: string[] = [];
    const rngE = mulberry32(20261127);
    const eg1 = mkEG("EG1", EG1_P0, EG_NB, false), egm1 = mkEG("EGM1", EGM1_P0, EG_NB, true), cE = startOf(eg1, false), cM = startOf(egm1, false), Wd = windowsV(cE), days = monthEndIdx.filter((x) => x >= cStartV);
    console.log(`[점검 1] 데이터 표준: 가격 보정 ${PRICE_CORRECTION_ON ? "k200p17 적용" : "미적용"} · 의심 종목-일 0% 처리 ${ZERO_SUSPECT_ON ? `적용 ${suspectLog.length}건` : "미적용"} | 소멸 관례: 저PBR·ROE 시험과 같음(vbVanishLoss), 슬리피지 신호일 K200P 구성원 ${B5_BS_SLIP_K200 * 100}%·그 밖 ${B5_BS_SLIP_OTHER * 100}%`);
    if (!PRICE_CORRECTION_ON || !ZERO_SUSPECT_ON) fails.push("보정 또는 의심 종목-일 0% 처리 미적용(correct=k200p17 zero=1 필요)");
    console.log(`[점검 2] 시작: V_START ${V_START}(EG_START ${EG_START}) | 첫 신호일 EG1 ${CAL[cE]} / EGM1 ${CAL[cM]} | 케이스 ${V_CASE} | 수익률 집계 ${Wd.FULL.from}~${h.dataEnd} | 구간 ${Wd.NW.map(([nm, w]) => `${nm} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    if (!EG_START || V_START !== EG_START || cE !== cM || V_CASE !== "C2") fails.push(`시작·구간 불일치: V_START ${V_START} (사전등록 ${EG_START || "미확정"}), EG1 ${CAL[cE]} EGM1 ${CAL[cM]}, 케이스 ${V_CASE}`);
    // [점검 3] Q1·QV1 재현(ROE 시험 시작 2012-04-30)
    {
      const cQ = monthEndIdx.find((x) => CAL[x] === EG_REF.qStart) as number;
      for (const [id, P0, ref] of [["Q1", Q1_P0, EG_REF.q1], ["QV1", QV1_P0, EG_REF.qv1]] as [string, QP, readonly number[]][]) {
        const def: Strat<QP> = { ...mkQ(id, P0, []), signalDays: monthEndIdx.filter((x) => x >= cQ) }, run = runS(def, P0, cQ, null, { lag: 1, detail: true }), st = h.st(run, { from: CAL[cQ + 1], to: "9999-12-31" });
        const ok = f2(st.cagr) === f2(ref[0]) && f2(st.mdd) === f2(ref[1]);
        console.log(`[점검 3] ${id} 재현(시작 ${CAL[cQ]}, 집계 ${CAL[cQ + 1]}~): 연속 ${f2(st.cagr)} / ${f2(st.mdd)} (ROE 시험 기록 ${ref.join(" / ")}) → ${ok ? "일치" : "불일치"}`);
        if (!ok) fails.push(`${id} 재현 불일치`);
      }
    }
    // [점검 4] ROE 변화 독립 재계산 400건(같은 보고서 자료에서 따로 짠 직접 계산, 1년 전 기준일도 CAL 문자열 스캔으로 따로 구함)
    {
      const all = await loadRoeReps(), flat = [...all.repsR, ...all.repsPre], byC = new Map<string, FinRep[]>();
      for (const r of flat) { const a = byC.get(r.code) ?? []; a.push(r); byC.set(r.code, a); }
      const ord: Record<string, number> = { "11013": 1, "11012": 2, "11014": 3, "11011": 4 };
      const brute = (code: string, d: string, maxAge: number): { why: string; roe?: number } => {
        const rs = byC.get(code) ?? [], best = new Map<string, FinRep>();
        for (const r of rs) { const k = `${r.year}|${r.rc}`, o = best.get(k); if (!o || (r.fs === "CFS" && o.fs !== "CFS")) best.set(k, r); }
        const avail = [...best.values()].filter((r) => r.rcept < d).sort((a, b) => a.year * 10 + ord[a.rc] - (b.year * 10 + ord[b.rc]) || (a.rceptNo < b.rceptNo ? -1 : 1));
        const F = avail[avail.length - 1];
        if (!F) return { why: "no_report" };
        if ((Date.parse(d) - Date.parse(F.rcept)) / 86_400_000 > maxAge) return { why: "stale" };
        let ttm: number;
        if (F.rc === "11011") { if (F.niC === null) return { why: "null_ni" }; ttm = F.niC; }
        else {
          const an = avail.find((r) => r.rc === "11011" && r.year === F.year - 1 && r.rcept < F.rcept);
          if (!an) return { why: "no_annual" };
          const ytd = F.rc === "11013" ? F.niC : F.niA, pv = F.rc === "11013" ? F.niP : F.niPA;
          if (an.niC === null || ytd === null || pv === null) return { why: "null_ni" };
          ttm = an.niC + ytd - pv;
        }
        if (F.eqC === null) return { why: "null_eq" };
        if (!(F.eqC > 0)) return { why: "eq_nonpos" };
        if (!(ttm > 0)) return { why: "ttm_nonpos" };
        return { why: "ok", roe: ttm / F.eqC };
      };
      // 1년 전 월말 거래일: (연도 − 1, 같은 월)의 마지막 거래일(CAL 문자열 스캔)
      const prevMonthEnd = (d: string): string => { const pre = `${Number(d.slice(0, 4)) - 1}-${d.slice(5, 7)}`; let last = ""; for (const x of CAL) { if (x.startsWith(pre)) last = x; else if (x > `${pre}-31`) break; } return last; };
      let nChk = 0, nBoth = 0, nPrevDateBad = 0;
      const whyCnt = new Map<string, number>();
      for (let t = 0; t < 400; t++) {
        const c = days[Math.floor(rngE() * days.length)], el = bsElig(c, B5_BS_P0);
        if (!el.length) continue;
        const code = el[Math.floor(rngE() * el.length)], d = CAL[c], dpB = prevMonthEnd(d), cp = egPrevC(c);
        if (CAL[cp] !== dpB) { nPrevDateBad++; fails.push(`1년 전 기준일 불일치 ${d}: 모듈 ${CAL[cp]} 독립 ${dpB}`); continue; }
        const a = roeOf(code, d, EG1_P0.maxAge), b = roeOf(code, dpB, EG1_P0.maxAge), ba = brute(code, d, EG1_P0.maxAge), bb = brute(code, dpB, EG1_P0.maxAge);
        nChk++;
        const wk = `${a.why}/${b.why}`; whyCnt.set(wk, (whyCnt.get(wk) ?? 0) + 1);
        if (a.why !== ba.why || b.why !== bb.why) { fails.push(`ROE 사유 불일치 ${code} ${d}: 모듈 ${a.why}/${b.why} 독립 ${ba.why}/${bb.why}`); continue; }
        if (a.why === "ok" && b.why === "ok") {
          nBoth++;
          const chgM = (a.roe as number) - (b.roe as number), chgB = (ba.roe as number) - (bb.roe as number), inRows = egRowsAt(c, cp).find((x) => x.code === code);
          if (!(Math.abs(chgM - chgB) <= 1e-9 * Math.max(Math.abs(chgB), 1e-9))) fails.push(`ROE 변화 값 불일치 ${code} ${d}: ${chgM} vs ${chgB}`);
          if (!inRows || Math.abs(inRows.chg - chgB) > 1e-9 * Math.max(Math.abs(chgB), 1e-9)) fails.push(`후보 행의 ROE 변화 불일치 ${code} ${d}`);
        } else if (egRowsAt(c, cp).some((x) => x.code === code)) fails.push(`계산 불가인데 후보에 있음 ${code} ${d}`);
      }
      console.log(`[점검 4] ROE 변화 독립 재계산 ${nChk}건(둘 다 계산돼 값·후보 행 비교 ${nBoth}건) 일치 확인(접수일 < 기준일 규칙, 1년 전 기준일 독립 계산 포함, 기준일 불일치 ${nPrevDateBad}건) | 지금/1년 전 사유 분포 ${[...whyCnt.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
    }
    // [점검 5] 후보 집합·순위 독립 재계산(월말 20개): 전 종목을 직접 훑어 ROE 변화·모멘텀 순위·평균 순위 상위 30 비교
    {
      const picks = Array.from({ length: 20 }, (_, k) => days[Math.floor((k * (days.length - 1)) / 19)]);
      const brRm = (s: S, c: number, P: RmP): number => {
        const xs: number[] = [], ys: number[] = [];
        if (c - P.start >= 1) for (let k = c - P.start; k <= c - P.skip; k++) {
          const jd = bsExact(s, k), jp = bsExact(s, k - 1), x = bRetBrute(k);
          if (jd < 0 || jp < 0 || !Number.isFinite(x)) continue;
          xs.push(x); ys.push(s.close[jd] / s.close[jp] - 1);
        }
        const n = xs.length;
        if (n < P.minValid) return Number.NaN;
        const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
        let sxx = 0, sxy = 0;
        for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
        if (!(sxx > 0)) return Number.NaN;
        const beta = sxy / sxx, alpha = my - beta * mx;
        let sse = 0, sumRes = 0;
        for (let i = 0; i < n; i++) { const e = ys[i] - alpha - beta * xs[i]; sse += e * e; sumRes += ys[i] - beta * xs[i]; }
        const sd = Math.sqrt(sse / (n - 1));
        return sd > 0 ? sumRes / (sd * Math.sqrt(n)) : Number.NaN;
      };
      let nOk1 = 0, nOk2 = 0;
      const rowsOut: string[] = [];
      for (const c of picks) {
        const d = CAL[c], cp = egPrevC(c), el = bruteBs(c, B5_BS_P0).map((x) => x.code), br: { code: string; chg: number; sc: number }[] = [];
        for (const code of el) {
          const a = roeOf(code, d, EG1_P0.maxAge), b = roeOf(code, CAL[cp], EG1_P0.maxAge);
          if (a.why !== "ok" || b.why !== "ok") continue;
          br.push({ code, chg: (a.roe as number) - (b.roe as number), sc: brRm(h.byCode.get(code) as S, c, EGM1_P0.rm) });
        }
        const e1 = [...br].sort((a, b) => b.chg - a.chg || (a.code < b.code ? -1 : 1)), m1 = e1.filter((x) => Number.isFinite(x.sc));
        const rC = new Map(m1.map((x, k) => [x.code, k + 1] as [string, number])), rM = new Map([...m1].sort((a, b) => b.sc - a.sc || (a.code < b.code ? -1 : 1)).map((x, k) => [x.code, k + 1] as [string, number]));
        const avgSorted = m1.map((x) => ({ code: x.code, rC: rC.get(x.code) as number, rM: rM.get(x.code) as number, avg: ((rC.get(x.code) as number) + (rM.get(x.code) as number)) / 2 })).sort((a, b) => a.avg - b.avg || a.rC - b.rC || (a.code < b.code ? -1 : 1));
        const mod1 = egRowsAt(c, cp), mod2 = egmRowsAt(c, cp);
        const ok1 = mod1.length === e1.length && mod1.every((x, k) => x.code === e1[k].code && Math.abs(x.chg - e1[k].chg) <= 1e-9 * Math.max(Math.abs(e1[k].chg), 1e-9));
        const ok2 = mod2.length === avgSorted.length && mod2.every((x, k) => x.code === avgSorted[k].code && x.rC === avgSorted[k].rC && x.rM === avgSorted[k].rM && Math.abs(x.avg - avgSorted[k].avg) < 1e-12);
        if (ok1) nOk1++; else fails.push(`EG1 후보·순서 불일치 ${d}: 모듈 ${mod1.length} 독립 ${e1.length}`);
        if (ok2) nOk2++; else fails.push(`EGM1 후보·순위 불일치 ${d}: 모듈 ${mod2.length} 독립 ${avgSorted.length}`);
        rowsOut.push(`${d}(1년 전 ${CAL[cp]}) 적격 ${el.length} → ROE 변화 계산 ${e1.length}(모듈 ${mod1.length}) → 모멘텀도 가능 ${avgSorted.length}(모듈 ${mod2.length}) | EG1 상위 3 ${mod1.slice(0, 3).map((x) => `${label(x.code)}(${f2(x.chg * 100)}%p)`).join(", ")}`);
      }
      console.log(`[점검 5] 후보 집합·순서·평균 순위 독립 재계산(전 종목 직접 훑기) 월말 ${picks.length}개: EG1 일치 ${nOk1}개 · EGM1 일치 ${nOk2}개\n${rowsOut.map((x) => `  ${x}`).join("\n")}`);
    }
    // [점검 6] 구조: 보유 수·첫 체결일·진입 종목의 ROE 변화 유효성, 후보 수, 시작일 커버리지
    for (const [id, def, P0, rows] of [["EG1", eg1, EG1_P0, (c: number) => egRowsAt(c, egPrevC(c)).length], ["EGM1", egm1, EGM1_P0, (c: number) => egmRowsAt(c, egPrevC(c)).length]] as [string, Strat<EgP>, EgP, (c: number) => number][]) {
      const run = runS(def, P0, cE, null, { lag: 1, detail: true });
      const hmax = Math.max(...run.nPos.map((x, k) => x - (run.nDefer[k] ?? 0))), cnt = days.map(rows);
      console.log(`[점검 6] ${id}: 보유 종목 수 최대(순연 제외) ${hmax} (목표 ${P0.n}) | 첫 체결일 ${CAL[run.entryCs[0]]} (신호일 다음 거래일 ${CAL[cE + 1]}) | 진입 ${run.entryCs.length}건 | 후보 수(월말 ${cnt.length}개) 최소 ${Math.min(...cnt)} 평균 ${f2(avg(cnt))} 최대 ${Math.max(...cnt)}, ${P0.n}개 미만 월 ${cnt.filter((x) => x < P0.n).length}개`);
      if (hmax > P0.n) fails.push(`${id} 보유 종목 수 ${hmax} > ${P0.n}`);
      if (run.entryCs[0] !== cE + 1) fails.push(`${id} 첫 체결일 ${CAL[run.entryCs[0]]} ≠ ${CAL[cE + 1]}`);
      if (cnt.some((x) => x < P0.n)) fails.push(`${id} 후보 ${P0.n}개 미만인 월 ${cnt.filter((x) => x < P0.n).length}개`);
      const bad = run.trades.concat(run.open).filter((t) => { const cs = t.entryC - 1; return !egRowsAt(cs, egPrevC(cs)).some((x) => x.code === t.code); }).length;
      if (bad && id === "EG1") fails.push(`EG1 진입 종목 중 신호일 ROE 변화가 없는 경우 ${bad}건`);
      if (id === "EGM1") { const bad2 = run.trades.concat(run.open).filter((t) => { const cs = t.entryC - 1; return !egmRowsAt(cs, egPrevC(cs)).some((x) => x.code === t.code); }).length; if (bad2) fails.push(`EGM1 진입 종목 중 신호일 후보가 아닌 경우 ${bad2}건`); }
      const closed = run.trades;
      console.log(`[점검 6] ${id} 소멸 종목 청산: 마지막 종가 청산 ${closed.filter((x) => x.reason === "폐지").length}건 · 전액 손실 ${closed.filter((x) => x.reason === "폐지(전액 손실)").length}건(닫힌 거래 ${closed.length}건 중)`);
    }
    {
      const el = bsElig(cE, B5_BS_P0).length, both = egRowsAt(cE, egPrevC(cE)).length, r = both / Math.max(el, 1);
      console.log(`[점검 7] 시작일 ${CAL[cE]} 두 값 계산 비율: BS1 적격 ${el}, 둘 다 계산 ${both} = ${f2(r * 100)}%(기준 ${EG_COVERAGE_MIN * 100}% 이상)`);
      if (r < EG_COVERAGE_MIN) fails.push(`시작일 커버리지 ${f2(r * 100)}% < ${EG_COVERAGE_MIN * 100}%`);
    }
    console.log(`\n정보용 항목 구현 목록(시험 출력에서 이 머리표로 대조): [R3] 연도별 승패 · [R4] 승률·손익비·기대값 · [R5] 나란히 비교 표(DS6·DS13L·RM1SC·VB1·RM1·QV1) · [R6] 연 회전율·비용 · [R7] 상위 10개 거래 손익 비중 · [V2] 평균 현금 비중 · [V3] 삼성전자·SK하이닉스 평균 비중 · [V4] VB1 MDD 구간 구간 수익 · [V5] 하루 지연(C) · [V6] VB1·RM1·CM1·QV1 등 일간 상관 · [V7] 월 신호일 앞당김 민감도(eginfo2) · [V8] 의심 종목-일 처리 없음 비교(eginfo) · [E1] 평균 ROE·PBR·금융주 비중 · [E2] 후보 집합 크기 · [E3] 제외 종목-월 비율 · [V9] 누적 시험·우연 통과 기대(요약)`);
    if (fails.length) { console.log(`\n사전 점검 실패 ${fails.length}건:\n${fails.slice(0, 40).map((x) => `  - ${x}`).join("\n")}`); throw new Error("사전 점검 실패 — 시험하지 않고 중단해 보고한다"); }
    console.log(`\nROE 변화 사전 점검 통과(EG1·EGM1 성과는 계산·출력하지 않았다; DS6·Q1·QV1 재현 줄은 환경 확인용) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "eginfo") {
    // 정보용(시험 아님): EG1·EGM1·QV1·VB1·RM1·RM1SC·DS13L·DS6·069500 기준 실행의 구간별 CAGR/MDD — 의심 종목-일 0% 처리 유무 비교용.
    await loadEqTables();
    await loadRoe();
    requireStart();
    const eg1 = mkEG("EG1", EG1_P0, EG_NB, false), egm1 = mkEG("EGM1", EGM1_P0, EG_NB, true), vb1 = mkVB("VB1", VB1_P0, VB1_NB), qv1 = mkQ("QV1", QV1_P0, QV1_NB), cV = startOf(eg1, false), Wx = windowsV(cV);
    const rows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [
      { nm: "EG1", run: runS(eg1, EG1_P0, cV, null, { lag: 1, detail: true }) }, { nm: "EGM1", run: runS(egm1, EGM1_P0, cV, null, { lag: 1, detail: true }) }, { nm: "QV1", run: runS(qv1, QV1_P0, cV, null, { lag: 1, detail: true }) },
      { nm: "VB1", run: runS(vb1, VB1_P0, cV, null, { lag: 1, detail: true }) }, { nm: "RM1", run: runS(RM1, RM1.P0, cV, null, { lag: 1, detail: true }) }, { nm: "RM1SC", run: rm1scOf(cV, Wx).res.run },
      { nm: "DS13L", run: d13Of("LV1", cV, Wx).base.res.run }, { nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run },
    ];
    console.log(`\n=== [V8] 정보용: ${ZERO_SUSPECT_ON ? `의심 종목-일 0% 처리 적용(${suspectLog.length}건)` : "의심 종목-일 처리 없음"} — CAGR % / MDD % (같은 구간 ${Wx.FULL.from}~) ===\n| 구간 | ${rows.map((r) => r.nm).join(" | ")} |\n|---|${rows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${rows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    console.log(`\n정보용 실행 종료(시험 아님) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "eginfo2") {
    // 정보용(시험 아님, 판정 변경 없음): 월 신호일을 마지막 거래일에서 5·10거래일 앞당긴 민감도(EG1·EGM1). ROE 두 시점(지금·1년 전)도 같은 만큼 앞당긴다.
    await loadEqTables();
    await loadRoe();
    requireStart();
    const eg0 = mkEG("EG1", EG1_P0, EG_NB, false), cV = startOf(eg0, false), Wx = windowsV(cV), from = Wx.FULL.from, bRun = { dates: h.bhP.dates, ret: h.bhP.ret };
    const shifts = [0, 5, 10].map((sh) => ({ sh, eg1: runS(mkEG("EG1", EG1_P0, EG_NB, false, { shift: sh }), EG1_P0, cV, null, { lag: 1, detail: true }), egm1: runS(mkEG("EGM1", EGM1_P0, EG_NB, true, { shift: sh }), EGM1_P0, cV, null, { lag: 1, detail: true }) }));
    console.log(`\n=== [V7] 정보용 견고성 점검: 월 신호일(ROE 두 시점 포함)을 마지막 거래일에서 5·10거래일 앞당김 — CAGR % / MDD % (같은 구간 ${from}~, 보정 + 0% 처리 데이터) ===`);
    for (const [lb, pick] of [["EG1", (x: (typeof shifts)[number]) => x.eg1], ["EGM1", (x: (typeof shifts)[number]) => x.egm1]] as [string, (x: (typeof shifts)[number]) => { dates: string[]; ret: number[] }][]) {
      console.log(`${lb}\n| 구간 | 069500 | 기준(0일) | −5일 | −10일 |\n|---|---|---|---|---|`);
      for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${f2(h.st(bRun, w).cagr)} / ${f2(h.st(bRun, w).mdd)} | ${shifts.map((x) => `${f2(h.st(pick(x), w).cagr)} / ${f2(h.st(pick(x), w).mdd)}`).join(" | ")} |`);
      const f0 = h.st(pick(shifts[0]), Wx.FULL);
      console.log(`${lb} 연속 CAGR 차이(기준 대비 %p): ${shifts.slice(1).map((x) => `−${x.sh}일 ${sg(h.st(pick(x), Wx.FULL).cagr - f0.cagr)}(MDD ${sg(h.st(pick(x), Wx.FULL).mdd - f0.mdd)}%p)`).join(" · ")} | CAGR 차이 1.5%p 초과 ${shifts.slice(1).some((x) => Math.abs(h.st(pick(x), Wx.FULL).cagr - f0.cagr) > 1.5) ? "있음" : "없음"}`);
    }
    console.log(`\n정보용 실행 종료(시험 아님, 판정 변경 없음) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "rvpre") {
    // 역변동성 비중 사전 점검(RM1V·RM1VC 성과 미계산, 하루 지연 경로 포함): DS6 재현(위 줄), RM1·RM1C 재현, 상한 1/n이면 RM1V = RM1(기본·지연), 변동성·비중 독립 재계산, 보유 수·첫 체결일, 날짜 축, 월 중 체결.
    const fails: string[] = [];
    const std = PRICE_CORRECTION_ON && ZERO_SUSPECT_ON ? "correctZero" : PRICE_CORRECTION_ON ? "correct" : "none";
    const rv = mkRV("RM1V", RV1_P0, RV1_NB), cS = startOf(rv, false), cR = startOf(RM1, false), Wd = windowsFor(cS);
    console.log(`[점검 1] 데이터 표준: 가격 보정 ${PRICE_CORRECTION_ON ? "k200p17 적용" : "미적용"} · 의심 종목-일 0% 처리 ${ZERO_SUSPECT_ON ? `적용 ${suspectLog.length}건` : "미적용"} → ${std === "correctZero" ? "시험 표준(공식)" : std === "none" ? "원 설정(RM1 재현 전용 실행)" : "보정만(재현 전용)"} | 소멸 관례·슬리피지: RM1과 같음(마지막 종가 청산, L_SLIPPAGE)`);
    console.log(`[점검 2] 첫 신호일: RM1V ${CAL[cS]} / RM1 ${CAL[cR]} | 수익률 집계 ${Wd.FULL.from}~${h.dataEnd} | 구간 ${Wd.NW.map(([nm, w]) => `${nm} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    if (cS !== cR) fails.push(`RM1V 첫 신호일 ${CAL[cS]} ≠ RM1 ${CAL[cR]}`);
    // [점검 3] RM1·RM1C 재현
    const rm1Run = runS(RM1, RM1.P0, cR, null, { lag: 1, detail: true }), coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, Wd.FULL.from);
    {
      const s1 = h.st(rm1Run, Wd.FULL), c1 = h.st(combine2(coreFull, slFromRun(rm1Run), B5_CORE_W, CS_MOVE_COST).run, Wd.FULL);
      const ref = (std === "none" ? RV_REF.none : RV_REF.std) as { rm1: readonly number[]; rm1c: readonly number[] };
      const okR = f2(s1.cagr) === f2(ref.rm1[0]) && f2(s1.mdd) === f2(ref.rm1[1]), okC = f2(c1.cagr) === f2(ref.rm1c[0]) && f2(c1.mdd) === f2(ref.rm1c[1]);
      console.log(`[점검 3] RM1 재현(${std}): RM1 단독 ${f2(s1.cagr)} / ${f2(s1.mdd)} (기록 ${ref.rm1.join(" / ")}) → ${okR ? "일치" : "불일치"} | RM1C 연속 ${f2(c1.cagr)} / ${f2(c1.mdd)} (기록 ${ref.rm1c.join(" / ")}) → ${okC ? "일치" : "불일치"}`);
      if (!okR) fails.push(`RM1 재현 불일치(${std})`);
      if (!okC) fails.push(`RM1C 재현 불일치(${std})`);
    }
    if (std !== "correctZero" && std !== "none") fails.push("보정만 적용된 실행은 지원하지 않는다");
    if (std === "none") {
      console.log(`\n(이 실행은 RM1 재현 전용이다: 보정·0% 처리가 모두 적용된 시험 표준 실행에서만 RM1V 점검을 한다)`);
      if (fails.length) { console.log(`\n사전 점검 실패 ${fails.length}건:\n${fails.map((x) => `  - ${x}`).join("\n")}`); throw new Error("사전 점검 실패 — 시험하지 않고 중단해 보고한다"); }
      console.log(`\nRM1 재현 점검 통과(${std}) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
      return;
    }
    // [점검 4] 불변식: 종목당 상한 1/n이면 RM1V = RM1 (기본 경로 lag 1, 하루 지연 경로 lag 2)
    const Peq: RvP = { ...RV1_P0, cap: 1 / RV1_P0.n };
    for (const lag of [1, 2]) {
      const ref = lag === 1 ? rm1Run : runS(RM1, RM1.P0, cS, null, { lag, detail: true }), eq = runS(rv, Peq, cS, null, { lag, detail: true });
      let mx = 0;
      if (eq.dates.length !== ref.dates.length) fails.push(`RM1V(상한 1/n)와 RM1의 날짜 축이 다르다(lag ${lag})`);
      else for (let k = 0; k < eq.ret.length; k++) mx = Math.max(mx, Math.abs(eq.ret[k] - ref.ret[k]));
      console.log(`[점검 4] ${lag === 1 ? "기본 경로(lag 1)" : "하루 지연(lag 2)"}: 상한 ${f2(Peq.cap * 100)}%(= 동일 비중) RM1V ↔ RM1 일수익률 최대 차이 ${mx.toExponential(2)}%p, 진입 ${eq.entryCs.length} vs ${ref.entryCs.length}건, 닫힌 거래 ${eq.trades.length} vs ${ref.trades.length}건, 체결 있는 날 ${eq.turn.length} vs ${ref.turn.length}일`);
      if (!(mx < 1e-9)) fails.push(`상한 1/n RM1V ≠ RM1 (lag ${lag}, 최대 차이 ${mx})`);
      if (eq.entryCs.length !== ref.entryCs.length || eq.trades.length !== ref.trades.length || eq.turn.length !== ref.turn.length) fails.push(`상한 1/n RM1V와 RM1의 진입·거래·체결일 수가 다르다(lag ${lag})`);
    }
    // [점검 5] 변동성·비중 독립 재계산(월말 20개 × 파라미터 5세트)
    {
      const pt = pathTgG(RM1, cS), picks = Array.from({ length: 20 }, (_, k) => 1 + Math.floor((k * (pt.length - 2)) / 19));
      const brVol = (code: string, c: number, win: number): number => {
        const s = h.byCode.get(code) as S;
        let rows = 0;
        for (let k = c - win + 1; k <= c; k++) if (bsExact(s, k) >= 0) rows++;
        if (c - win + 1 < 1 || rows < Math.ceil(RV_MIN_VALID_FRAC * win - 1e-9)) return Number.NaN;
        const r: number[] = [];
        for (let k = c - win + 1; k <= c; k++) { const a = bpx(s, k - 1), b = bpx(s, k); r.push(a > 0 && b > 0 ? b / a - 1 : 0); }
        const mu = r.reduce((x, y) => x + y, 0) / win, sd = Math.sqrt(r.reduce((x, y) => x + (y - mu) ** 2, 0) / (win - 1));
        return sd > 0 && Number.isFinite(sd) ? sd : Number.NaN;
      };
      const brWeights = (vols: number[], cap: number): number[] => {
        const fin = vols.filter((v) => Number.isFinite(v)).sort((a, b) => a - b), med = fin.length ? (fin.length % 2 ? fin[(fin.length - 1) / 2] : (fin[fin.length / 2 - 1] + fin[fin.length / 2]) / 2) : Number.NaN;
        const inv = vols.map((v) => (fin.length ? 1 / (Number.isFinite(v) ? v : med) : 1)), n = inv.length, order = inv.map((_, i) => i).sort((a, b) => inv[b] - inv[a]), w = new Array<number>(n).fill(0);
        for (let k = 0; k <= n; k++) {
          const rest = order.slice(k), sr = rest.reduce((x, i) => x + inv[i], 0);
          if (!rest.length) { for (const i of order) w[i] = cap; return w; }
          const lam = (1 - k * cap) / sr;
          if (lam * inv[rest[0]] <= cap) { for (let q = 0; q < k; q++) w[order[q]] = cap; for (const i of rest) w[i] = lam * inv[i]; return w; }
        }
        return w;
      };
      let nOk = 0, nBad = 0, nSel = 0, nFb = 0, maxDiff = 0;
      const sets: [string, RvP][] = [["기본", RV1_P0], ...RV1_NB.map(([lb, ch]) => [lb, { ...RV1_P0, ...ch }] as [string, RvP])];
      for (const j of picks) {
        const c = pt[j].c, held = new Set(pt[j - 1].t.keys()), selR = [...RM1.targets(c, held, RM1.P0, 1, true).keys()];
        for (const [lb, P] of sets) {
          const t = rv.targets(c, held, P, 1, true), names = [...t.keys()];
          if (names.length !== selR.length || !names.every((x) => selR.includes(x))) { nBad++; fails.push(`선정 집합이 RM1과 다르다 ${CAL[c]} (${lb})`); continue; }
          const vols = names.map((x) => brVol(x, c, P.volWin)), vm = names.map((x) => rvVol(x, c, P.volWin)), bw = brWeights(vols, P.cap);
          const volOk = vols.every((v, i) => (Number.isNaN(v) && Number.isNaN(vm[i])) || Math.abs(v - vm[i]) <= 1e-12 * Math.max(Math.abs(v), 1e-12));
          let wd = 0, sum = 0, mxw = 0;
          names.forEach((x, i) => { const d = Math.abs((t.get(x) as number) - bw[i]); wd = Math.max(wd, d); sum += t.get(x) as number; mxw = Math.max(mxw, t.get(x) as number); });
          maxDiff = Math.max(maxDiff, wd);
          if (lb === "기본") { nSel++; nFb += vols.filter((v) => !Number.isFinite(v)).length; }
          const ok = volOk && wd < 1e-12 && Math.abs(sum - 1) < 1e-9 && mxw <= P.cap + 1e-12;
          if (ok) nOk++; else { nBad++; fails.push(`변동성·비중 불일치 ${CAL[c]} (${lb}): σ ${volOk ? "일치" : "불일치"}, 비중 최대 차이 ${wd.toExponential(2)}, 합 ${sum}, 최대 ${mxw}`); }
        }
      }
      console.log(`[점검 5] 변동성·비중 독립 재계산(전 종목 직접 훑기 σ, 정렬 기반 다른 풀이로 비중) 월말 ${picks.length}개 × 파라미터 ${sets.length}세트 = ${picks.length * sets.length}건: 일치 ${nOk}건 · 불일치 ${nBad}건 | 비중 최대 차이 ${maxDiff.toExponential(2)} | 합 100%·상한 준수·선정 집합 = RM1 확인 | 기본 세트 선정 ${nSel}회 중 변동성 불가(대체 σ 사용) 종목 ${nFb}건`);
      const pt2 = pathTgG(rv, cS);
      let nFbAll = 0, nAll = 0;
      for (const { c, t } of pt2) for (const code of t.keys()) { nAll++; if (!Number.isFinite(rvVol(code, c, RV1_P0.volWin))) nFbAll++; }
      console.log(`[점검 5] 전체 월말 ${pt2.length}개 목표 종목-월 ${nAll}건 중 변동성 불가 ${nFbAll}건(${f2((nFbAll / Math.max(nAll, 1)) * 100)}%)`);
    }
    // [점검 6] 구조: 보유 수·첫 체결일·월 중 체결·RM1VC 날짜 축
    {
      const run = runS(rv, RV1_P0, cS, null, { lag: 1, detail: true }), hmax = Math.max(...run.nPos.map((x, k) => x - (run.nDefer[k] ?? 0)));
      console.log(`[점검 6] RM1V: 보유 종목 수 최대(순연 제외) ${hmax} (목표 ${RV1_P0.n}) | 첫 체결일 ${CAL[run.entryCs[0]]} (신호일 다음 거래일 ${CAL[cS + 1]}) | 진입 ${run.entryCs.length}건 | 체결 있는 날 ${run.turn.length}일`);
      if (hmax > RV1_P0.n) fails.push(`RM1V 보유 종목 수 ${hmax} > ${RV1_P0.n}`);
      if (run.entryCs[0] !== cS + 1) fails.push(`RM1V 첫 체결일 ${CAL[run.entryCs[0]]} ≠ ${CAL[cS + 1]}`);
      const idxOf = new Map(CAL.map((d, k) => [d, k] as [string, number])), meNext = new Set([...monthEndIdx].flatMap((x) => [x + 1, x + 2]));
      const unexplained = run.turn.map((x) => idxOf.get(x.d) as number).filter((c) => !meNext.has(c)), unexpRef = rm1Run.turn.map((x) => idxOf.get(x.d) as number).filter((c) => !meNext.has(c));
      console.log(`[점검 6] RM1V 체결일 ${run.turn.length}일 중 월말 다음 거래일이 아닌 날 ${unexplained.length}일(거래정지로 밀린 체결·소멸 청산 등): ${unexplained.map((c) => CAL[c]).join(", ")} | 같은 기준 RM1(동일 비중) ${rm1Run.turn.length}일 중 ${unexpRef.length}일: ${unexpRef.map((c) => CAL[c]).join(", ")} | RM1V에만 있는 날 ${unexplained.filter((c) => !unexpRef.includes(c)).length}일`);
      // 기준 구현(RM1)에도 거래정지로 밀린 체결이 있으므로, 월 중 체결이 RM1보다 눈에 띄게 많을 때만 실패로 본다(첫 실행의 고정 임계 3%는 RM1 자체의 밀린 체결 수를 고려하지 않은 점검 결함, rm1v-prereg.md §7)
      if (unexplained.length > unexpRef.length + 5) fails.push(`RM1V 월 중 설명되지 않는 체결 ${unexplained.length}일 > RM1 ${unexpRef.length}일 + 5`);
      console.log(`[점검 6] RM1V 소멸 종목 청산: 마지막 종가 청산 ${run.trades.filter((x) => x.reason === "폐지").length}건 · 전액 손실 ${run.trades.filter((x) => x.reason === "폐지(전액 손실)").length}건(닫힌 거래 ${run.trades.length}건 중)`);
      const sat = slFromRun(run);
      if (coreFull.dates.length !== sat.dates.length || coreFull.dates.some((x, k) => x !== sat.dates[k])) fails.push("RM1VC 날짜 축");
      else console.log(`[점검 6] RM1VC 날짜 축: 코어 ${coreFull.dates[0]}~${coreFull.dates[coreFull.dates.length - 1]}(${coreFull.dates.length}일) = 위성 일치`);
      const a = combineN([coreFull, sat], [B5_CORE_W, 1 - B5_CORE_W], CS_MOVE_COST, null).run.ret, b = combine2(coreFull, sat, B5_CORE_W, CS_MOVE_COST).run.ret;
      let mxd = 0;
      for (let k = 0; k < a.length; k++) mxd = Math.max(mxd, Math.abs(a[k] - b[k]));
      console.log(`[점검 6] 월 리밸런스 경로: combineN(매일) ↔ combine2 일수익률 최대 차이 ${mxd.toExponential(2)}%p`);
      if (!(mxd < 1e-9)) fails.push(`combineN(매일) ≠ combine2 (최대 차이 ${mxd})`);
    }
    console.log(`\n정보용 항목 구현 목록(시험 출력에서 이 머리표로 대조): [R3] 연도별 승패 · [R4] 승률·손익비·기대값 · [R5] 나란히 비교 표(DS6·DS13L·RM1·RM1C·RM1SC) · [R6] 연 회전율·비용 · [R7] 상위 10개 거래 손익 비중 · [V3] 삼성전자·SK하이닉스 평균 비중(두 종목 수익 0 = rvinfo + NEUTRALIZE_CODES) · [V4] VB1 MDD 구간 구간 수익 · [V5] 하루 지연(C) · [V6] RM1·RM1SC·DS13L 등 일간 상관 · [V7] 월 신호일 앞당김 민감도(rvinfo2) · [V8] 의심 종목-일 처리 없음 비교(rvinfo) · [RV1] 평균 상한 도달 종목 수·비중 범위 · [RV2] 변동성 불가 종목 발생 · [V9] 누적 시험·우연 통과 기대(요약)`);
    if (fails.length) { console.log(`\n사전 점검 실패 ${fails.length}건:\n${fails.slice(0, 40).map((x) => `  - ${x}`).join("\n")}`); throw new Error("사전 점검 실패 — 시험하지 않고 중단해 보고한다"); }
    console.log(`\n역변동성 비중 사전 점검 통과(RM1V·RM1VC 성과는 계산·출력하지 않았다; DS6·RM1·RM1C 재현 줄은 환경 확인용) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "rvinfo") {
    // 정보용(시험 아님): RM1V·RM1VC·RM1·RM1C·RM1SC·DS13L·DS6·069500 기준 실행의 구간별 CAGR/MDD — 의심 종목-일 0% 처리 유무 비교 또는 두 종목(NEUTRALIZE_CODES) 수익 0 비교용.
    const rv = mkRV("RM1V", RV1_P0, RV1_NB), cS = startOf(rv, false), Wx = windowsFor(cS), coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, Wx.FULL.from);
    const rm1Run = runS(RM1, RM1.P0, cS, null, { lag: 1, detail: true }), rvc = rvcOf(cS, Wx);
    const rows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [
      { nm: "RM1", run: rm1Run }, { nm: "RM1C", run: combine2(coreFull, slFromRun(rm1Run), B5_CORE_W, CS_MOVE_COST).run }, { nm: "RM1SC", run: rm1scOf(cS, Wx).res.run }, { nm: "RM1V", run: rvc.sat }, { nm: "RM1VC", run: rvc.res.run },
      { nm: "DS13L", run: d13Of("LV1", cS, Wx).base.res.run }, { nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run },
    ];
    console.log(`\n=== [V8] 정보용: ${NEUTRALIZE_ON ? `수정 수익률을 0으로 둔 종목 ${process.env.NEUTRALIZE_CODES}(069500 기준선은 그대로, DS6·DS13L 코어도 영향을 받음) · ` : ""}${ZERO_SUSPECT_ON ? `의심 종목-일 0% 처리 적용(${suspectLog.length}건)` : "의심 종목-일 처리 없음"} — CAGR % / MDD % (같은 구간 ${Wx.FULL.from}~) ===\n| 구간 | ${rows.map((r) => r.nm).join(" | ")} |\n|---|${rows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${rows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    console.log(`\n정보용 실행 종료(시험 아님) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "rvinfo2") {
    // 정보용(시험 아님, 판정 변경 없음): 월 신호일을 마지막 거래일에서 5·10거래일 앞당긴 민감도(RM1V·RM1VC). 첫 신호일·코어(일별 규칙)는 그대로.
    const rv0 = mkRV("RM1V", RV1_P0, RV1_NB), cS = startOf(rv0, false), Wx = windowsFor(cS), from = Wx.FULL.from, bRun = { dates: h.bhP.dates, ret: h.bhP.ret };
    const shifts = [0, 5, 10].map((sh) => ({ sh, x: rvcOf(cS, Wx, { shift: sh }) }));
    console.log(`\n=== [V7] 정보용 견고성 점검: 월 신호일(순위 선정·변동성·하위 계좌 간 재조정 신호)을 마지막 거래일에서 5·10거래일 앞당김 — CAGR % / MDD % (같은 구간 ${from}~, 보정 + 0% 처리 데이터) ===`);
    for (const [lb, pick] of [["RM1VC", (x: (typeof shifts)[number]["x"]) => x.res.run], ["RM1V(위성 단독)", (x: (typeof shifts)[number]["x"]) => x.sat]] as [string, (x: (typeof shifts)[number]["x"]) => { dates: string[]; ret: number[] }][]) {
      console.log(`${lb}\n| 구간 | 069500 | 기준(0일) | −5일 | −10일 |\n|---|---|---|---|---|`);
      for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${f2(h.st(bRun, w).cagr)} / ${f2(h.st(bRun, w).mdd)} | ${shifts.map((x) => `${f2(h.st(pick(x.x), w).cagr)} / ${f2(h.st(pick(x.x), w).mdd)}`).join(" | ")} |`);
      const f0 = h.st(pick(shifts[0].x), Wx.FULL);
      console.log(`${lb} 연속 CAGR 차이(기준 대비 %p): ${shifts.slice(1).map((x) => `−${x.sh}일 ${sg(h.st(pick(x.x), Wx.FULL).cagr - f0.cagr)}(MDD ${sg(h.st(pick(x.x), Wx.FULL).mdd - f0.mdd)}%p)`).join(" · ")} | CAGR 차이 1.5%p 초과 ${shifts.slice(1).some((x) => Math.abs(h.st(pick(x.x), Wx.FULL).cagr - f0.cagr) > 1.5) ? "있음" : "없음"}`);
    }
    console.log(`\n정보용 실행 종료(시험 아님, 판정 변경 없음) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "ds15pre") {
    // DS15 사전 점검(DS15L·DS15M 성과 미계산, 하루 지연 경로 포함): DS6 재현(위 줄), DS13L·DS13M·RM1SC 재현, 손절 없는 RM1S = RM1, 손절 없는 DS15 = DS13(기본·지연), 하위 계좌 동일성, 손절 건수, 날짜 축·첫날 비중.
    const fails: string[] = [];
    const std = PRICE_CORRECTION_ON && ZERO_SUSPECT_ON ? "std" : PRICE_CORRECTION_ON ? "correct" : "none";
    const cS = startOf(RM1, false), Wd = windowsFor(cS);
    console.log(`[점검 1] 데이터 표준: 가격 보정 ${PRICE_CORRECTION_ON ? "k200p17 적용" : "미적용"} · 의심 종목-일 0% 처리 ${ZERO_SUSPECT_ON ? `적용 ${suspectLog.length}건` : "미적용"} → ${std === "std" ? "시험 표준(공식)" : std === "correct" ? "보정만(DS13 시험 기록 대조용)" : "미지원"}`);
    if (std === "none") fails.push("보정 미적용 실행은 지원하지 않는다(correct=k200p17 필요)");
    console.log(`[점검 2] 첫 신호일 ${CAL[cS]} | 수익률 집계 ${Wd.FULL.from}~${h.dataEnd} | 구간 ${Wd.NW.map(([nm, w]) => `${nm} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    if (Wd.FULL.from !== "2011-02-01") fails.push(`수익률 집계 시작 ${Wd.FULL.from} ≠ 2011-02-01`);
    // [점검 3] DS13L·DS13M·RM1SC 재현
    const dL = d13Of("LV1", cS, Wd), dM = d13Of("MV1", cS, Wd), rmsc = rm1scOf(cS, Wd);
    {
      const sL = h.st(dL.base.res.run, Wd.FULL), sM = h.st(dM.base.res.run, Wd.FULL), sR = h.st(rmsc.res.run, Wd.FULL);
      const ref = (std === "std" ? DS15_REF.std : DS15_REF.correct) as { rm1sc: readonly number[]; ds13l: readonly number[]; ds13m?: readonly number[] };
      const okL = f2(sL.cagr) === f2(ref.ds13l[0]) && f2(sL.mdd) === f2(ref.ds13l[1]), okR = f2(sR.cagr) === f2(ref.rm1sc[0]) && f2(sR.mdd) === f2(ref.rm1sc[1]), okM = ref.ds13m ? f2(sM.cagr) === f2(ref.ds13m[0]) && f2(sM.mdd) === f2(ref.ds13m[1]) : true;
      console.log(`[점검 3] 재현(${std}): DS13L ${f2(sL.cagr)} / ${f2(sL.mdd)} (기록 ${ref.ds13l.join(" / ")}) → ${okL ? "일치" : "불일치"} | DS13M ${f2(sM.cagr)} / ${f2(sM.mdd)} (${ref.ds13m ? `기록 ${ref.ds13m.join(" / ")}) → ${okM ? "일치" : "불일치"}` : "이 데이터 표준의 기록 없음, 값만 보고)"} | RM1SC ${f2(sR.cagr)} / ${f2(sR.mdd)} (기록 ${ref.rm1sc.join(" / ")}) → ${okR ? "일치" : "불일치"} | 손절 발동(RM1SC 위성) ${rmsLog.length}건`);
      if (!okL) fails.push(`DS13L 재현 불일치(${std})`);
      if (!okM) fails.push(`DS13M 재현 불일치(${std})`);
      if (!okR) fails.push(`RM1SC 재현 불일치(${std})`);
    }
    if (std === "correct") {
      console.log(`\n(이 실행은 DS13L·DS13M·RM1SC 재현(보정만 적용 표준) 전용이다: 보정 + 0% 처리가 모두 적용된 시험 표준 실행에서만 DS15 점검을 한다)`);
      if (fails.length) { console.log(`\n사전 점검 실패 ${fails.length}건:\n${fails.map((x) => `  - ${x}`).join("\n")}`); throw new Error("사전 점검 실패 — 시험하지 않고 중단해 보고한다"); }
      console.log(`\nDS13·RM1SC 재현 점검 통과(${std}) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
      return;
    }
    // [점검 4] 손절 없는 RM1S = RM1 (기본·하루 지연)
    const rms = mkRMS("RM1S", RM1S_P0, RM1S_NB);
    for (const lag of [1, 2]) {
      const ref = runS(RM1, RM1.P0, cS, null, { lag, detail: true }), never = runS(rms, { ...RM1S_P0, stop: 1 }, cS, null, { lag, detail: true }), nStop = rmsLog.length;
      let mx = 0;
      if (never.dates.length !== ref.dates.length) fails.push(`RM1S(손절 없음)와 RM1의 날짜 축이 다르다(lag ${lag})`);
      else for (let k = 0; k < never.ret.length; k++) mx = Math.max(mx, Math.abs(never.ret[k] - ref.ret[k]));
      console.log(`[점검 4] ${lag === 1 ? "기본 경로(lag 1)" : "하루 지연(lag 2)"}: 손절 없는 RM1S ↔ RM1 일수익률 최대 차이 ${mx.toExponential(2)}%p, 손절 발동 ${nStop}건, 진입 ${never.entryCs.length} vs ${ref.entryCs.length}건, 닫힌 거래 ${never.trades.length} vs ${ref.trades.length}건, 체결 있는 날 ${never.turn.length} vs ${ref.turn.length}일`);
      if (!(mx < 1e-9)) fails.push(`손절 없는 RM1S ≠ RM1 (lag ${lag}, 최대 차이 ${mx})`);
      if (nStop) fails.push(`손절 100%인데 발동 ${nStop}건 (lag ${lag})`);
    }
    // [점검 5] 손절 없는 DS15 = DS13 (L·M × 기본·하루 지연)
    for (const [kind, d13] of [["LV1", dL], ["MV1", dM]] as const) {
      const d15 = d15Of(kind, cS, Wd);
      for (const lag of [1, 2]) {
        const ref = lag === 1 ? d13.base : d13.build({ lag }), got = d15.build({ stopP: { stop: 1 }, lag }), nStop = rmsLog.length;
        let mx = 0;
        if (got.res.run.dates.length !== ref.res.run.dates.length) fails.push(`손절 없는 DS15(${kind})와 DS13의 날짜 축이 다르다(lag ${lag})`);
        else for (let k = 0; k < got.res.run.ret.length; k++) mx = Math.max(mx, Math.abs(got.res.run.ret[k] - ref.res.run.ret[k]));
        console.log(`[점검 5] ${kind === "LV1" ? "DS15L ↔ DS13L" : "DS15M ↔ DS13M"} ${lag === 1 ? "기본 경로(lag 1)" : "하루 지연(lag 2)"}: 손절을 끈 DS15 일수익률 최대 차이 ${mx.toExponential(2)}%p, 손절 발동 ${nStop}건, 이동 금액 합 ${f2(got.res.moved.reduce((a, x) => a + x, 0))} vs ${f2(ref.res.moved.reduce((a, x) => a + x, 0))}`);
        if (!(mx < 1e-9)) fails.push(`손절 없는 DS15(${kind}) ≠ DS13 (lag ${lag}, 최대 차이 ${mx})`);
        if (nStop) fails.push(`손절 100%인데 DS15 발동 ${nStop}건 (${kind}, lag ${lag})`);
      }
    }
    // [점검 6] 하위 계좌 동일성·손절 건수·날짜 축·첫날 비중
    for (const [kind, d13] of [["LV1", dL], ["MV1", dM]] as const) {
      const d15 = d15Of(kind, cS, Wd), b = d15.base, id = kind === "LV1" ? "DS15L" : "DS15M";
      const cmp = (a: number[], c: number[]): number => { let mx = a.length === c.length ? 0 : Number.POSITIVE_INFINITY; for (let k = 0; k < Math.min(a.length, c.length); k++) mx = Math.max(mx, Math.abs(a[k] - c[k])); return mx; };
      const dSat = cmp(b.sls[1].ret, rmsc.sat.ret), dLow = cmp(b.sls[2].ret, d13.base.sls[2].ret), dCore = cmp(b.sls[0].ret, d13.base.sls[0].ret);
      console.log(`[점검 6] ${id}: 모멘텀 위성 ↔ RM1SC의 RM1S 위성 일수익률 최대 차이 ${dSat.toExponential(2)}%p · 저위험 위성 ↔ DS13 ${dLow.toExponential(2)}%p · 코어 ↔ DS13 ${dCore.toExponential(2)}%p | 손절 발동 ${d15.stopsBase.length}건 | 하위 계좌 날짜 축 ${b.sls.every((s) => s.dates.length === b.sls[0].dates.length && s.dates.every((x, k) => x === b.sls[0].dates[k])) ? "일치" : "불일치"}(${b.sls[0].dates[0]}~${b.sls[0].dates[b.sls[0].dates.length - 1]}, ${b.sls[0].dates.length}일) | 첫 신호일 다음 거래일 모멘텀 위성 첫 체결 ${CAL[b.rm.entryCs[0]]}(기대 ${CAL[cS + 1]})`);
      if (!(dSat < 1e-9)) fails.push(`${id} 모멘텀 위성 ≠ RM1SC 위성(${dSat})`);
      if (!(dLow < 1e-9)) fails.push(`${id} 저위험 위성 ≠ DS13(${dLow})`);
      if (!(dCore < 1e-9)) fails.push(`${id} 코어 ≠ DS13(${dCore})`);
      if (b.rm.entryCs[0] !== cS + 1) fails.push(`${id} 모멘텀 위성 첫 체결일 ${CAL[b.rm.entryCs[0]]} ≠ ${CAL[cS + 1]}`);
      if (!b.sls.every((s) => s.dates.length === b.sls[0].dates.length && s.dates.every((x, k) => x === b.sls[0].dates[k]))) fails.push(`${id} 하위 계좌 날짜 축`);
      if (b.res.wEnd.length && Math.abs(b.res.wEnd[0].reduce((x, y) => x + y, 0) - 1) > 1e-9) fails.push(`${id} 첫날 하위 계좌 비중 합 ≠ 1`);
      console.log(`[점검 6] ${id}: 첫날 종가 하위 계좌 비중 ${b.res.wEnd[0].map((x) => f2(x * 100)).join(" / ")}% (목표 ${d15.W0.map((x) => f2(x * 100)).join(" / ")}%) | 월 재조정 신호일 ${d15.sigSet.size}개 | 이웃 코어 비중 목표 ${DS15_NB_W.map(([, w]) => w.map((x) => f2(x * 100)).join("/")).join(" · ")}`);
    }
    {
      const nStops = new Map<string, number>();
      for (const [lb, ch] of [["손절 -20%(기본)", {}], ...RM1S_NB] as [string, Partial<RmsP>][]) { runS(rms, { ...RM1S_P0, ...ch }, cS, null, { lag: 1 }); nStops.set(lb, rmsLog.length); }
      console.log(`[점검 6] 모멘텀 위성(RM1S) 단독 손절 발동: ${[...nStops.entries()].map(([k, v]) => `${k} ${v}건`).join(" · ")} (앞선 RM1S 사전 점검: −20% 739건)`);
      if (nStops.get("손절 -20%(기본)") !== 739) fails.push(`RM1S 손절 발동 ${nStops.get("손절 -20%(기본)")}건 ≠ 앞선 기록 739건`);
    }
    console.log(`\n정보용 항목 구현 목록(시험 출력에서 이 머리표로 대조): [R3] 연도별 승패(2025·2026 069500 대비 포함) · [R4] 승률·손익비·기대값 · [R5] 나란히 비교 표(DS6·DS13L·DS13M·RM1SC) · [R6] 연 회전율·비용 · [R7] 상위 10개 거래 손익 비중 · [V1] 손절 발동 횟수와 손절 후 21거래일 수익 · [V3] 삼성전자·SK하이닉스 평균 비중(두 종목 수익 0 = ds15info + NEUTRALIZE_CODES) · [V4] VB1 MDD 구간 구간 수익 · [V5] 하루 지연(C) · [V6] DS13L·RM1SC 등 일간 상관 · [V7] 월 신호일 앞당김 민감도(ds15info2, RM1SC·DS13L·DS13M 비교) · [V8] 의심 종목-일 처리 없음 비교(ds15info) · [V9] 누적 시험·우연 통과 기대(요약) · 손익 분해(평가 출력)`);
    if (fails.length) { console.log(`\n사전 점검 실패 ${fails.length}건:\n${fails.slice(0, 40).map((x) => `  - ${x}`).join("\n")}`); throw new Error("사전 점검 실패 — 시험하지 않고 중단해 보고한다"); }
    console.log(`\nDS15 사전 점검 통과(DS15L·DS15M 성과는 계산·출력하지 않았다; DS6·DS13·RM1SC 재현 줄은 환경 확인용) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "ds15info") {
    // 정보용(시험 아님): DS15L·DS15M·DS13L·DS13M·RM1SC·DS6·069500 기준 실행의 구간별 CAGR/MDD — 의심 종목-일 0% 처리 유무 비교 또는 두 종목(NEUTRALIZE_CODES) 수익 0 비교용.
    const cS = startOf(RM1, false), Wx = windowsFor(cS);
    const rows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [
      { nm: "DS15L", run: d15Of("LV1", cS, Wx).base.res.run }, { nm: "DS15M", run: d15Of("MV1", cS, Wx).base.res.run }, { nm: "DS13L", run: d13Of("LV1", cS, Wx).base.res.run }, { nm: "DS13M", run: d13Of("MV1", cS, Wx).base.res.run },
      { nm: "RM1SC", run: rm1scOf(cS, Wx).res.run }, { nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run },
    ];
    console.log(`\n=== [V8] 정보용: ${NEUTRALIZE_ON ? `수정 수익률을 0으로 둔 종목 ${process.env.NEUTRALIZE_CODES}(069500 기준선은 그대로, DS6·DS13 코어도 영향을 받음) · ` : ""}${ZERO_SUSPECT_ON ? `의심 종목-일 0% 처리 적용(${suspectLog.length}건)` : "의심 종목-일 처리 없음"} — CAGR % / MDD % (같은 구간 ${Wx.FULL.from}~) ===\n| 구간 | ${rows.map((r) => r.nm).join(" | ")} |\n|---|${rows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${rows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    console.log(`\n정보용 실행 종료(시험 아님) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "ds15info2") {
    // 정보용(시험 아님, 판정 변경 없음): 월 신호일을 마지막 거래일에서 5·10거래일 앞당긴 민감도 — DS15L·DS15M을 RM1SC·DS13L·DS13M과 나란히. 첫 신호일·코어(일별 규칙)·LV1(일별 규칙)은 그대로.
    const cS = startOf(RM1, false), Wx = windowsFor(cS), from = Wx.FULL.from, bRun = { dates: h.bhP.dates, ret: h.bhP.ret };
    const SH = [0, 5, 10];
    const sets: { nm: string; runs: { dates: string[]; ret: number[] }[] }[] = [
      { nm: "DS15L", runs: SH.map((sh) => d15Of("LV1", cS, Wx, sh).base.res.run) }, { nm: "DS15M", runs: SH.map((sh) => d15Of("MV1", cS, Wx, sh).base.res.run) },
      { nm: "RM1SC", runs: SH.map((sh) => rm1scOf(cS, Wx, { shift: sh }).res.run) }, { nm: "DS13L", runs: SH.map((sh) => d13Of("LV1", cS, Wx, sh).base.res.run) }, { nm: "DS13M", runs: SH.map((sh) => d13Of("MV1", cS, Wx, sh).base.res.run) },
    ];
    console.log(`\n=== [V7] 정보용 견고성 점검: 월 신호일(모멘텀 선정·손절 겹침 처리·MV1·하위 계좌 간 재조정 신호)을 마지막 거래일에서 5·10거래일 앞당김 — CAGR % / MDD % (같은 구간 ${from}~, 보정 + 0% 처리 데이터) ===`);
    for (const s of sets) {
      console.log(`${s.nm}\n| 구간 | 069500 | 기준(0일) | −5일 | −10일 |\n|---|---|---|---|---|`);
      for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${f2(h.st(bRun, w).cagr)} / ${f2(h.st(bRun, w).mdd)} | ${s.runs.map((r) => `${f2(h.st(r, w).cagr)} / ${f2(h.st(r, w).mdd)}`).join(" | ")} |`);
      const f0 = h.st(s.runs[0], Wx.FULL);
      console.log(`${s.nm} 연속 CAGR 차이(기준 대비 %p): ${[1, 2].map((k) => `−${SH[k]}일 ${sg(h.st(s.runs[k], Wx.FULL).cagr - f0.cagr)}(MDD ${sg(h.st(s.runs[k], Wx.FULL).mdd - f0.mdd)}%p)`).join(" · ")} | CAGR 차이 1.5%p 초과 ${[1, 2].some((k) => Math.abs(h.st(s.runs[k], Wx.FULL).cagr - f0.cagr) > 1.5) ? "있음" : "없음"} | 앞당김 모두 MDD ≤ 069500(${f2(h.st(bRun, Wx.FULL).mdd)}) ${[0, 1, 2].every((k) => h.st(s.runs[k], Wx.FULL).mdd <= h.st(bRun, Wx.FULL).mdd) ? "예" : "아니오"}`);
    }
    console.log(`\n정보용 실행 종료(시험 아님, 판정 변경 없음) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "cmpre") {
    // 복합 사전 점검(CM1·CM1S 성과 미계산, 하루 지연 경로 포함): DS6 재현(위 줄), VB1 재현, RM1 재현, 후보 집합·PBR 순위·RM1 순위 독립 재계산, 손절 없는 CM1S = CM1(기본·지연), 손절 독립 재계산, 보유 수·첫 체결일, 후보 수.
    await loadEqTables();
    const fails: string[] = [];
    const std = PRICE_CORRECTION_ON && ZERO_SUSPECT_ON ? "correctZero" : PRICE_CORRECTION_ON ? "correct" : "none";
    console.log(`[점검 1] 데이터 표준: 가격 보정 ${PRICE_CORRECTION_ON ? "k200p17 적용" : "미적용"} · 의심 종목-일 0% 처리 ${ZERO_SUSPECT_ON ? `적용 ${suspectLog.length}건` : "미적용"} → ${std === "correctZero" ? "시험 표준(공식)" : std === "none" ? "원 설정(RM1 재현 전용 실행)" : "보정만(재현 전용)"} | 소멸 관례: 저PBR 시험(VB1)과 같음(vbVanishLoss), 슬리피지 신호일 K200P 구성원 ${B5_BS_SLIP_K200 * 100}%·그 밖 ${B5_BS_SLIP_OTHER * 100}%`);
    // [점검 3] RM1 재현(RM1 자신의 시작, 앞선 RM1S 사전 점검과 같은 기준)
    {
      const cR = startOf(RM1, false), Wr = windowsFor(cR), rm1 = runS(RM1, RM1.P0, cR, null, { lag: 1, detail: true }), coreR = sliceSl(coreOf(2, undefined, 1, {}).sl, Wr.FULL.from);
      const s1 = h.st(rm1, Wr.FULL), c1 = h.st(combine2(coreR, slFromRun(rm1), B5_CORE_W, CS_MOVE_COST).run, Wr.FULL);
      const ref = S_REF[std as keyof typeof S_REF] as { rm1?: readonly number[]; rm1c: readonly number[] };
      const okC = f2(c1.cagr) === f2(ref.rm1c[0]) && f2(c1.mdd) === f2(ref.rm1c[1]), okR = ref.rm1 ? f2(s1.cagr) === f2(ref.rm1[0]) && f2(s1.mdd) === f2(ref.rm1[1]) : true;
      console.log(`[점검 3] RM1 재현(${std}, 시작 ${CAL[cR]}): RM1C 연속 ${f2(c1.cagr)} / ${f2(c1.mdd)} (기록 ${ref.rm1c.join(" / ")}) → ${okC ? "일치" : "불일치"}${ref.rm1 ? ` | RM1 단독 ${f2(s1.cagr)} / ${f2(s1.mdd)} (기록 ${ref.rm1.join(" / ")}) → ${okR ? "일치" : "불일치"}` : ` | RM1 단독 ${f2(s1.cagr)} / ${f2(s1.mdd)}(이 데이터 표준의 기록 없음)`}`);
      if (!okC) fails.push(`RM1C 재현 불일치(${std})`);
      if (!okR) fails.push(`RM1 재현 불일치(${std})`);
    }
    if (std !== "correctZero") {
      console.log(`\n(이 실행은 RM1 재현 전용이다: 보정·0% 처리가 모두 적용된 시험 표준 실행에서만 CM1 점검을 한다)`);
      if (fails.length) { console.log(`\n사전 점검 실패 ${fails.length}건:\n${fails.map((x) => `  - ${x}`).join("\n")}`); throw new Error("사전 점검 실패 — 시험하지 않고 중단해 보고한다"); }
      console.log(`\nRM1 재현 점검 통과(${std}) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
      return;
    }
    requireStart();
    const vb1 = mkVB("VB1", VB1_P0, VB1_NB), cm1 = mkCM("CM1", CM1_P0, CM1_NB), cms = mkCMS("CM1S", CM1S_P0, CM1S_NB), cV = startOf(vb1, false), cC = startOf(cm1, false), cSS = startOf(cms, false), Wd = windowsV(cV);
    console.log(`[점검 2] 시작: V_START ${V_START}(CM_START ${CM_START}) | 첫 신호일 VB1 ${CAL[cV]} / CM1 ${CAL[cC]} / CM1S ${CAL[cSS]} | 수익률 집계 ${Wd.FULL.from}~${h.dataEnd} | 구간 ${Wd.NW.map(([nm, w]) => `${nm} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    if (V_START !== CM_START || cV !== cC || cV !== cSS) fails.push(`시작 불일치: V_START ${V_START} (사전등록 ${CM_START}), VB1 ${CAL[cV]} CM1 ${CAL[cC]} CM1S ${CAL[cSS]}`);
    // VB1 재현
    const vb1Run = runS(vb1, VB1_P0, cV, null, { lag: 1, detail: true });
    {
      const s1 = h.st(vb1Run, Wd.FULL), ok1 = f2(s1.cagr) === f2(CM_REF.vb1[0]) && f2(s1.mdd) === f2(CM_REF.vb1[1]);
      console.log(`[점검 3] VB1 재현: 연속 ${f2(s1.cagr)} / ${f2(s1.mdd)} (기록 ${CM_REF.vb1.join(" / ")}) → ${ok1 ? "일치" : "불일치"}`);
      if (!ok1) fails.push("VB1 재현 불일치");
    }
    // [점검 4] 손절 없는 CM1S = CM1 (기본 경로 lag 1, 하루 지연 경로 lag 2)
    for (const lag of [1, 2]) {
      const ref = runS(cm1, CM1_P0, cV, null, { lag, detail: true }), never = runS(cms, { ...CM1S_P0, stop: 1 }, cV, null, { lag, detail: true }), nStop = cmsLog.length;
      let mx = 0;
      if (never.dates.length !== ref.dates.length) fails.push(`CM1S(손절 없음)와 CM1의 날짜 축이 다르다(lag ${lag})`);
      else for (let k = 0; k < never.ret.length; k++) mx = Math.max(mx, Math.abs(never.ret[k] - ref.ret[k]));
      console.log(`[점검 4] ${lag === 1 ? "기본 경로(lag 1)" : "하루 지연(lag 2)"}: 손절 없는 CM1S ↔ CM1 일수익률 최대 차이 ${mx.toExponential(2)}%p, 손절 발동 ${nStop}건, 진입 ${never.entryCs.length} vs ${ref.entryCs.length}건, 닫힌 거래 ${never.trades.length} vs ${ref.trades.length}건, 보유일 1일 거래 ${never.trades.filter((x) => x.exitC - x.entryC <= 1).length} vs ${ref.trades.filter((x) => x.exitC - x.entryC <= 1).length}건, 체결 있는 날 ${never.turn.length} vs ${ref.turn.length}일`);
      if (!(mx < 1e-9)) fails.push(`손절 없는 CM1S ≠ CM1 (lag ${lag}, 최대 차이 ${mx})`);
      if (nStop) fails.push(`손절 100%인데 발동 ${nStop}건 (lag ${lag})`);
    }
    // [점검 5] 후보 집합·PBR 순위·RM1 순위 독립 재계산(전 종목 직접 훑기, 월말 20개)
    {
      const mes = monthEndIdx.filter((x) => x >= cV), picks = Array.from({ length: 20 }, (_, k) => mes[Math.floor((k * (mes.length - 1)) / 19)]);
      const brRm = (s: S, c: number, P: RmP): number => {
        const xs: number[] = [], ys: number[] = [];
        if (c - P.start >= 1) for (let k = c - P.start; k <= c - P.skip; k++) {
          const jd = bsExact(s, k), jp = bsExact(s, k - 1), x = bRetBrute(k);
          if (jd < 0 || jp < 0 || !Number.isFinite(x)) continue;
          xs.push(x); ys.push(s.close[jd] / s.close[jp] - 1);
        }
        const n = xs.length;
        if (n < P.minValid) return Number.NaN;
        const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
        let sxx = 0, sxy = 0;
        for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
        if (!(sxx > 0)) return Number.NaN;
        const beta = sxy / sxx, alpha = my - beta * mx;
        let sse = 0, sumRes = 0;
        for (let i = 0; i < n; i++) { const e = ys[i] - alpha - beta * xs[i]; sse += e * e; sumRes += ys[i] - beta * xs[i]; }
        const sd = Math.sqrt(sse / (n - 1));
        return sd > 0 ? sumRes / (sd * Math.sqrt(n)) : Number.NaN;
      };
      let nOkAll = 0, nSetBad = 0, nRankBad = 0, nTopBad = 0, minC = 1e9, maxC = 0, sumC = 0, nLt = 0;
      let nCandChk = 0, nDupDiff = 0;
      const dupEx: string[] = [];
      const rows: string[] = [];
      for (const c of picks) {
        const d = CAL[c], el = bruteBs(c, B5_BS_P0).map((x) => x.code), br: { code: string; pbr: number; sc: number }[] = [];
        let nPbr = 0, nRm = 0;
        for (const code of el) {
          const s = h.byCode.get(code) as S, i = bsExact(s, c);
          if (i < 0) continue;
          // 접수일 < 신호일 중 가장 늦은 접수일, 같은 접수일이면 연결 우선, 접수일·구분이 같은 중복 행은 자료 파일 순서상 마지막 행(VB1 모듈 latestEq와 같은 규칙; 첫 실행의 독립 계산은 이 마지막 규칙이 없어 불일치했다)
          let best: EqRec | undefined;
          for (const e of eqBy.get(code) ?? []) if (e.rcept < d && (!best || e.rcept > best.rcept || (e.rcept === best.rcept && Number(e.cfs) >= Number(best.cfs)))) best = e;
          if (best) { const dp = (eqBy.get(code) ?? []).filter((e) => e.rcept === best?.rcept && e.cfs === best?.cfs && e.eq !== best?.eq); nCandChk++; if (dp.length) { nDupDiff++; if (dupEx.length < 6) dupEx.push(`${code} 접수일 ${best.rcept} ${best.cfs ? "연결" : "별도"} 선택 ${best.eq} · 같은 접수일·구분 다른 자본값 ${dp.map((x) => x.eq).join("/")}`); } }
          const pbr = !best ? Number.NaN : dayDiffV(best.rcept, d) > CM1_P0.maxAge || !(best.eq > 0) ? Number.NaN : (s.mcapRow[i] * 1e8) / best.eq;
          if (Number.isFinite(pbr)) nPbr++;
          const sc = brRm(s, c, CM1_P0.rm);
          if (Number.isFinite(sc)) nRm++;
          if (Number.isFinite(pbr) && Number.isFinite(sc)) br.push({ code, pbr, sc });
        }
        const bP = [...br].sort((a, b) => a.pbr - b.pbr || (a.code < b.code ? -1 : 1)).map((x, k) => [x.code, k + 1] as [string, number]), bM = [...br].sort((a, b) => b.sc - a.sc || (a.code < b.code ? -1 : 1)).map((x, k) => [x.code, k + 1] as [string, number]);
        const mP = new Map(bP), mM = new Map(bM);
        const bAvg = br.map((x) => ({ code: x.code, rP: mP.get(x.code) as number, rM: mM.get(x.code) as number, avg: ((mP.get(x.code) as number) + (mM.get(x.code) as number)) / 2 })).sort((a, b) => a.avg - b.avg || a.rP - b.rP || (a.code < b.code ? -1 : 1));
        const md = cmRows(c);
        const setOk = md.length === bAvg.length && new Set(md.map((x) => x.code)).size === new Set(bAvg.map((x) => x.code)).size && md.every((x) => mP.has(x.code));
        const rankOk = md.length === bAvg.length && md.every((x, k) => x.rP === bAvg[k].rP && x.rM === bAvg[k].rM && x.code === bAvg[k].code && Math.abs(x.avg - bAvg[k].avg) < 1e-12);
        const topOk = md.slice(0, 30).map((x) => x.code).join() === bAvg.slice(0, 30).map((x) => x.code).join();
        if (!rankOk) {
          // 진단 출력(성과 아님): 어느 순위가 어떻게 다른지
          const bSc = new Map(br.map((x) => [x.code, x.sc] as [string, number])), bPb = new Map(br.map((x) => [x.code, x.pbr] as [string, number]));
          const rPbad = md.filter((x) => mP.get(x.code) !== x.rP).length, rMbad = md.filter((x) => mM.get(x.code) !== x.rM).length, ordBad = md.filter((x, k) => x.code !== bAvg[k]?.code).length;
          let dSc = 0, dPb = 0;
          for (const x of md) { dSc = Math.max(dSc, Math.abs(x.sc - (bSc.get(x.code) as number))); dPb = Math.max(dPb, Math.abs(x.pbr - (bPb.get(x.code) as number)) / Math.abs(x.pbr)); }
          const firstBad = md.map((x, k) => ({ x, k })).filter(({ x, k }) => x.code !== bAvg[k]?.code || x.rP !== bAvg[k]?.rP || x.rM !== bAvg[k]?.rM).slice(0, 3);
          console.log(`  [진단] ${d}: PBR 순위 다른 종목 ${rPbad}개 · 모멘텀 순위 다른 종목 ${rMbad}개 · 평균 순위 순서 다른 위치 ${ordBad}개 | 점수 최대 차이 ${dSc.toExponential(2)} · PBR 최대 상대 차이 ${dPb.toExponential(2)} | 처음 다른 위치 ${firstBad.map(({ x, k }) => `#${k + 1} 모듈 ${x.code}(${x.rP}·${x.rM}·${x.avg}) vs 독립 ${bAvg[k]?.code}(${bAvg[k]?.rP}·${bAvg[k]?.rM}·${bAvg[k]?.avg})`).join(" ; ")}`);
        }
        if (!setOk) nSetBad++;
        if (!rankOk) nRankBad++;
        if (!topOk) nTopBad++;
        if (setOk && rankOk && topOk) nOkAll++;
        minC = Math.min(minC, md.length); maxC = Math.max(maxC, md.length); sumC += md.length; if (md.length < CM1_P0.n) nLt++;
        rows.push(`${d} 적격 ${el.length} → PBR 있음 ${nPbr} → 모멘텀 점수 있음 ${nRm} → 후보 ${bAvg.length}(모듈 ${md.length}) | 상위 3 ${md.slice(0, 3).map((x) => `${label(x.code)}(${x.rP}·${x.rM})`).join(", ")}`);
      }
      console.log(`[점검 5] 후보 집합·PBR 순위·RM1 순위·평균 순위 상위 30 독립 재계산(전 종목 직접 훑기) 월말 ${picks.length}개: 전부 일치 ${nOkAll}개 | 후보 집합 불일치 ${nSetBad} · 순위 불일치 ${nRankBad} · 상위 30 불일치 ${nTopBad}\n${rows.map((x) => `  ${x}`).join("\n")}`);
      console.log(`[점검 5] 참고: 독립 재계산 대상 적격 종목-월 ${nCandChk}건 중 접수일·구분이 같은데 자본값이 다른 중복 행이 있는 경우 ${nDupDiff}건(VB1과 같은 규칙: 자료 파일 순서상 마지막 행 사용)${dupEx.length ? ` | 예: ${dupEx.join(" ; ")}` : ""}`);
      if (nOkAll !== picks.length) fails.push(`독립 재계산 불일치(집합 ${nSetBad}·순위 ${nRankBad}·상위 30 ${nTopBad})`);
      const all = mes.map((c) => cmRows(c).length);
      console.log(`[점검 5] 후보 집합 크기(월말 ${mes.length}개 전체): 최소 ${Math.min(...all)} · 평균 ${f2(avg(all))} · 최대 ${Math.max(...all)} | 30개 미만 월 ${all.filter((x) => x < CM1_P0.n).length}개 | 첫 신호일 후보 ${all[0]}개`);
      if (all[0] < CM1_P0.n) fails.push(`첫 신호일 후보 ${all[0]} < ${CM1_P0.n}`);
      if (all.some((x) => x < CM1_P0.n)) fails.push(`후보 30개 미만 월 ${all.filter((x) => x < CM1_P0.n).length}개`);
    }
    // [점검 6] 구조·손절 독립 재계산
    {
      const run = runS(cms, CM1S_P0, cV, null, { lag: 1, detail: true }), log = [...cmsLog], base = runS(cm1, CM1_P0, cV, null, { lag: 1, detail: true });
      const hmax = Math.max(...run.nPos.map((x, k) => x - (run.nDefer[k] ?? 0))), hmaxB = Math.max(...base.nPos.map((x, k) => x - (base.nDefer[k] ?? 0)));
      console.log(`[점검 6] 보유 종목 수 최대(순연 제외): CM1 ${hmaxB} · CM1S ${hmax} (목표 ${CM1_P0.n}) | 첫 체결일 CM1S ${CAL[run.entryCs[0]]} / CM1 ${CAL[base.entryCs[0]]} (신호일 다음 거래일 ${CAL[cV + 1]}) | 진입 CM1 ${base.entryCs.length}건 · CM1S ${run.entryCs.length}건 | 손절 발동 ${log.length}건`);
      if (hmax > CM1_P0.n || hmaxB > CM1_P0.n) fails.push(`보유 종목 수 초과 CM1 ${hmaxB} CM1S ${hmax}`);
      if (run.entryCs[0] !== cV + 1 || base.entryCs[0] !== cV + 1) fails.push(`첫 체결일 ${CAL[run.entryCs[0]]}·${CAL[base.entryCs[0]]} ≠ ${CAL[cV + 1]}`);
      const all = [...run.trades, ...run.open];
      let nOk = 0, nNoTrade = 0, nBad = 0;
      for (const ev of log) {
        const t = all.find((x) => x.code === ev.code && x.entryC <= ev.c && ev.c <= x.exitC);
        if (!t) { nNoTrade++; continue; }
        const s = h.byCode.get(ev.code) as S;
        let pk = Number.NEGATIVE_INFINITY, early = false;
        for (let k = t.entryC; k <= ev.c; k++) {
          const i = s.idx.get(CAL[k]);
          if (i === undefined) continue;
          pk = Math.max(pk, s.close[i]);
          if (k < ev.c && s.close[i] <= pk * (1 - CM1S_P0.stop)) early = true;
        }
        const ie = s.idx.get(CAL[ev.c]);
        if (ie !== undefined && s.close[ie] <= pk * (1 - CM1S_P0.stop) && !early) nOk++; else nBad++;
      }
      console.log(`[점검 6] 손절 조건 독립 재계산: 발동 ${log.length}건 중 일치 ${nOk}건 · 불일치 ${nBad}건 · 거래 구간을 못 찾음 ${nNoTrade}건`);
      if (nBad || nNoTrade) fails.push(`손절 독립 재계산 불일치 ${nBad}건·거래 없음 ${nNoTrade}건`);
      const stopDays = new Set(log.map((e) => e.c + 1)), idxOf = new Map(CAL.map((d, k) => [d, k] as [string, number])), meNext = new Set([...monthEndIdx].flatMap((x) => [x + 1, x + 2]));
      for (const [nm, r] of [["CM1", base], ["CM1S", run]] as [string, RebalRun][]) {
        const unexplained = r.turn.map((x) => idxOf.get(x.d) as number).filter((c) => !stopDays.has(c) && !stopDays.has(c - 1) && !meNext.has(c));
        console.log(`[점검 6] ${nm} 체결일 ${r.turn.length}일 중 월말 다음 거래일·손절 다음 거래일이 아닌 날 ${unexplained.length}일(거래정지로 밀린 체결·소멸 청산 등)`);
        if (nm === "CM1S" && unexplained.length > Math.max(5, r.turn.length * 0.03)) fails.push(`CM1S 월 중 설명되지 않는 체결 ${unexplained.length}일`);
      }
      console.log(`[점검 6] 소멸 종목 청산(CM1S): 마지막 종가 청산 ${run.trades.filter((x) => x.reason === "폐지").length}건 · 전액 손실 ${run.trades.filter((x) => x.reason === "폐지(전액 손실)").length}건(닫힌 거래 ${run.trades.length}건 중)`);
    }
    // [점검 7] 손절 수준별 발동 건수(성과 아님)
    for (const [lb, ch] of [["손절 -20%(기본)", {}], ...CM1S_NB] as [string, Partial<CmP>][]) { runS(cms, { ...CM1S_P0, ...ch }, cV, null, { lag: 1 }); console.log(`[점검 7] ${lb}: 손절 발동 ${cmsLog.length}건`); }
    console.log(`\n정보용 항목 구현 목록(시험 출력에서 이 머리표로 대조): [R3] 연도별 승패 · [R4] 승률·손익비·기대값 · [R5] 나란히 비교 표(DS6·DS13L·RM1SC·VB1·RM1) · [R6] 연 회전율·비용 · [R7] 상위 10개 거래 손익 비중 · [V1] 손절 발동 횟수와 손절 후 21거래일 수익 · [V2] 평균 현금 비중(평가 출력의 "평균 투자 비중" 줄) · [V3] 삼성전자·SK하이닉스 평균 비중(두 종목 수익 0 = cminfo + NEUTRALIZE_CODES) · [V4] VB1 MDD 구간(2018-01-29~2020-03-23) 구간 수익 · [V5] 하루 지연(C) · [V6] VB1·RM1·RM1SC 등 일간 상관 · [V7] 월 신호일 앞당김 민감도(cminfo2) · [V8] 의심 종목-일 처리 없음 비교(cminfo) · [C1] 평균 PBR·금융주 비중 · [C2] 월별 후보 집합 크기 · [V9] 누적 시험·우연 통과 기대(요약)`);
    if (fails.length) { console.log(`\n사전 점검 실패 ${fails.length}건:\n${fails.map((x) => `  - ${x}`).join("\n")}`); throw new Error("사전 점검 실패 — 시험하지 않고 중단해 보고한다"); }
    console.log(`\n복합 사전 점검 통과(CM1·CM1S 성과는 계산·출력하지 않았다; DS6·VB1·RM1 재현 줄은 환경 확인용) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "cminfo") {
    // 정보용(시험 아님): CM1·CM1S·VB1·RM1·RM1SC·DS13L·DS6·069500 기준 실행의 구간별 CAGR/MDD — 의심 종목-일 0% 처리 유무 비교 또는 두 종목(NEUTRALIZE_CODES) 수익 0 비교용.
    await loadEqTables();
    requireStart();
    const vb1 = mkVB("VB1", VB1_P0, VB1_NB), cm1 = mkCM("CM1", CM1_P0, CM1_NB), cms = mkCMS("CM1S", CM1S_P0, CM1S_NB), cV = startOf(vb1, false), Wx = windowsV(cV);
    const vb1Run = runS(vb1, VB1_P0, cV, null, { lag: 1, detail: true }), rm1Run = runS(RM1, RM1.P0, cV, null, { lag: 1, detail: true }), cm1Run = runS(cm1, CM1_P0, cV, null, { lag: 1, detail: true }), cmsRun = runS(cms, CM1S_P0, cV, null, { lag: 1, detail: true }), rmsc = rm1scOf(cV, Wx);
    const rows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [
      { nm: "VB1", run: vb1Run }, { nm: "RM1", run: rm1Run }, { nm: "CM1", run: cm1Run }, { nm: "CM1S", run: cmsRun }, { nm: "RM1SC", run: rmsc.res.run },
      { nm: "DS13L", run: d13Of("LV1", cV, Wx).base.res.run }, { nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run },
    ];
    console.log(`\n=== [V8] 정보용: ${NEUTRALIZE_ON ? `수정 수익률을 0으로 둔 종목 ${process.env.NEUTRALIZE_CODES}(069500 기준선은 그대로, DS6·DS13L 코어도 영향을 받음) · ` : ""}${ZERO_SUSPECT_ON ? `의심 종목-일 0% 처리 적용(${suspectLog.length}건)` : "의심 종목-일 처리 없음"} — CAGR % / MDD % (같은 구간 ${Wx.FULL.from}~) ===\n| 구간 | ${rows.map((r) => r.nm).join(" | ")} |\n|---|${rows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${rows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    console.log(`\n정보용 실행 종료(시험 아님) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "cminfo2") {
    // 정보용(시험 아님, 판정 변경 없음): 월 신호일을 마지막 거래일에서 5·10거래일 앞당긴 민감도(CM1·CM1S). CM1은 손절 100%(발동 불가)의 CM1S로 계산(사전 점검에서 CM1과 일수익률까지 같음을 확인).
    await loadEqTables();
    requireStart();
    const vb1 = mkVB("VB1", VB1_P0, VB1_NB), cV = startOf(vb1, false), Wx = windowsV(cV), from = Wx.FULL.from, bRun = { dates: h.bhP.dates, ret: h.bhP.ret };
    const shifts = [0, 5, 10].map((sh) => { const def = mkCMS("CM1S", CM1S_P0, CM1S_NB, { shift: sh }); return { sh, cm1: runS(def, { ...CM1S_P0, stop: 1 }, cV, null, { lag: 1, detail: true }), cms: runS(def, CM1S_P0, cV, null, { lag: 1, detail: true }) }; });
    console.log(`\n=== [V7] 정보용 견고성 점검: 월 신호일(순위 선정·월말 손절 겹침 처리)을 마지막 거래일에서 5·10거래일 앞당김 — CAGR % / MDD % (같은 구간 ${from}~, 보정 + 0% 처리 데이터) ===`);
    for (const [lb, pick] of [["CM1", (x: (typeof shifts)[number]) => x.cm1], ["CM1S", (x: (typeof shifts)[number]) => x.cms]] as [string, (x: (typeof shifts)[number]) => { dates: string[]; ret: number[] }][]) {
      console.log(`${lb}\n| 구간 | 069500 | 기준(0일) | −5일 | −10일 |\n|---|---|---|---|---|`);
      for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${f2(h.st(bRun, w).cagr)} / ${f2(h.st(bRun, w).mdd)} | ${shifts.map((x) => `${f2(h.st(pick(x), w).cagr)} / ${f2(h.st(pick(x), w).mdd)}`).join(" | ")} |`);
      const f0 = h.st(pick(shifts[0]), Wx.FULL);
      console.log(`${lb} 연속 CAGR 차이(기준 대비 %p): ${shifts.slice(1).map((x) => `−${x.sh}일 ${sg(h.st(pick(x), Wx.FULL).cagr - f0.cagr)}(MDD ${sg(h.st(pick(x), Wx.FULL).mdd - f0.mdd)}%p)`).join(" · ")} | CAGR 차이 1.5%p 초과 ${shifts.slice(1).some((x) => Math.abs(h.st(pick(x), Wx.FULL).cagr - f0.cagr) > 1.5) ? "있음" : "없음"}`);
    }
    console.log(`\n정보용 실행 종료(시험 아님, 판정 변경 없음) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "vbspre") {
    // 저PBR 손절 사전 점검(VB1S·VB1SC 성과 미계산, 하루 지연 경로 포함): DS6 재현(위 줄), VB1·VB1C 재현, 손절 없는 VB1S = VB1(기본·지연), 손절 독립 재계산, 보유 수·첫 체결일, VB1SC 월 재조정 경로, 손절 발동 건수.
    await loadEqTables();
    requireStart();
    const fails: string[] = [];
    const vb1 = mkVB("VB1", VB1_P0, VB1_NB), vbs = mkVBS("VB1S", VB1S_P0, VB1S_NB), cV = startOf(vb1, false), cSS = startOf(vbs, false), Wd = windowsV(cV);
    console.log(`[점검 1] 데이터 표준: 가격 보정 ${PRICE_CORRECTION_ON ? "k200p17 적용" : "미적용"} · 의심 종목-일 0% 처리 ${ZERO_SUSPECT_ON ? `적용 ${suspectLog.length}건` : "미적용"} | 소멸 관례: 저PBR 시험(VB1)과 같음(vbVanishLoss), 슬리피지 신호일 K200P 구성원 ${B5_BS_SLIP_K200 * 100}%·그 밖 ${B5_BS_SLIP_OTHER * 100}%`);
    if (!PRICE_CORRECTION_ON || !ZERO_SUSPECT_ON) fails.push("보정 또는 의심 종목-일 0% 처리 미적용(correct=k200p17 zero=1 필요)");
    console.log(`[점검 2] 시작: V_START ${V_START}(VS_START ${VS_START}) | 첫 신호일 VB1 ${CAL[cV]} / VB1S ${CAL[cSS]} | 수익률 집계 ${Wd.FULL.from}~${h.dataEnd} | 구간 ${Wd.NW.map(([nm, w]) => `${nm} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    if (V_START !== VS_START || cV !== cSS) fails.push(`시작 불일치: V_START ${V_START} (사전등록 ${VS_START}), VB1 ${CAL[cV]} VB1S ${CAL[cSS]}`);
    // [점검 3] VB1·VB1C 재현
    const vb1Run = runS(vb1, VB1_P0, cV, null, { lag: 1, detail: true }), coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, Wd.FULL.from);
    {
      const s1 = h.st(vb1Run, Wd.FULL), c1 = h.st(combine2(coreFull, slFromRun(vb1Run), B5_CORE_W, CS_MOVE_COST).run, Wd.FULL);
      const ok1 = f2(s1.cagr) === f2(VS_REF.vb1[0]) && f2(s1.mdd) === f2(VS_REF.vb1[1]), okc = f2(c1.cagr) === f2(VS_REF.vb1c[0]) && f2(c1.mdd) === f2(VS_REF.vb1c[1]);
      console.log(`[점검 3] VB1 재현: 연속 ${f2(s1.cagr)} / ${f2(s1.mdd)} (기록 ${VS_REF.vb1.join(" / ")}) → ${ok1 ? "일치" : "불일치"} | VB1C 재현(일별 40:60): ${f2(c1.cagr)} / ${f2(c1.mdd)} (기록 ${VS_REF.vb1c.join(" / ")}) → ${okc ? "일치" : "불일치"}`);
      if (!ok1) fails.push("VB1 재현 불일치");
      if (!okc) fails.push("VB1C 재현 불일치");
    }
    // [점검 4] 손절 없는 VB1S = VB1 (기본 경로 lag 1, 하루 지연 경로 lag 2)
    for (const lag of [1, 2]) {
      const ref = lag === 1 ? vb1Run : runS(vb1, VB1_P0, cV, null, { lag, detail: true }), never = runS(vbs, { ...VB1S_P0, stop: 1 }, cV, null, { lag, detail: true }), nStop = vbsLog.length;
      let mx = 0;
      if (never.dates.length !== ref.dates.length) fails.push(`VB1S(손절 없음)와 VB1의 날짜 축이 다르다(lag ${lag})`);
      else for (let k = 0; k < never.ret.length; k++) mx = Math.max(mx, Math.abs(never.ret[k] - ref.ret[k]));
      console.log(`[점검 4] ${lag === 1 ? "기본 경로(lag 1)" : "하루 지연(lag 2)"}: 손절 없는 VB1S ↔ VB1 일수익률 최대 차이 ${mx.toExponential(2)}%p, 손절 발동 ${nStop}건, 진입 ${never.entryCs.length} vs ${ref.entryCs.length}건, 닫힌 거래 ${never.trades.length} vs ${ref.trades.length}건, 보유일 1일 거래 ${never.trades.filter((x) => x.exitC - x.entryC <= 1).length} vs ${ref.trades.filter((x) => x.exitC - x.entryC <= 1).length}건, 체결 있는 날 ${never.turn.length} vs ${ref.turn.length}일`);
      if (!(mx < 1e-9)) fails.push(`손절 없는 VB1S ≠ VB1 (lag ${lag}, 최대 차이 ${mx})`);
      if (nStop) fails.push(`손절 100%인데 발동 ${nStop}건 (lag ${lag})`);
    }
    // [점검 5] 손절 조건 독립 재계산 + 구조
    {
      const run = runS(vbs, VB1S_P0, cV, null, { lag: 1, detail: true }), log = [...vbsLog];
      const hmax = Math.max(...run.nPos.map((x, k) => x - (run.nDefer[k] ?? 0)));
      console.log(`[점검 5] VB1S: 보유 종목 수 최대(순연 제외) ${hmax} (목표 ${VB1S_P0.n}) | 첫 체결일 ${CAL[run.entryCs[0]]} (신호일 다음 거래일 ${CAL[cV + 1]}) | 진입 ${run.entryCs.length}건 | 손절 발동 ${log.length}건`);
      if (hmax > VB1S_P0.n) fails.push(`VB1S 보유 종목 수 ${hmax} > ${VB1S_P0.n}`);
      if (run.entryCs[0] !== undefined && run.entryCs[0] !== cV + 1) fails.push(`VB1S 첫 체결일 ${CAL[run.entryCs[0]]} ≠ ${CAL[cV + 1]}`);
      const all = [...run.trades, ...run.open];
      let nOk = 0, nNoTrade = 0, nBad = 0;
      for (const ev of log) {
        const t = all.find((x) => x.code === ev.code && x.entryC <= ev.c && ev.c <= x.exitC);
        if (!t) { nNoTrade++; continue; }
        const s = h.byCode.get(ev.code) as S;
        let pk = Number.NEGATIVE_INFINITY, early = false;
        for (let k = t.entryC; k <= ev.c; k++) {
          const i = s.idx.get(CAL[k]);
          if (i === undefined) continue;
          pk = Math.max(pk, s.close[i]);
          if (k < ev.c && s.close[i] <= pk * (1 - VB1S_P0.stop)) early = true;
        }
        const ie = s.idx.get(CAL[ev.c]);
        if (ie !== undefined && s.close[ie] <= pk * (1 - VB1S_P0.stop) && !early) nOk++; else nBad++;
      }
      console.log(`[점검 5] 손절 조건 독립 재계산: 발동 ${log.length}건 중 일치 ${nOk}건 · 불일치 ${nBad}건 · 거래 구간을 못 찾음 ${nNoTrade}건`);
      if (nBad || nNoTrade) fails.push(`손절 독립 재계산 불일치 ${nBad}건·거래 없음 ${nNoTrade}건`);
      const stopDays = new Set(log.map((e) => e.c + 1)), idxOf = new Map(CAL.map((d, k) => [d, k] as [string, number])), meNext = new Set([...monthEndIdx].flatMap((x) => [x + 1, x + 2]));
      const unexplained = run.turn.map((x) => idxOf.get(x.d) as number).filter((c) => !stopDays.has(c) && !stopDays.has(c - 1) && !meNext.has(c));
      console.log(`[점검 5] VB1S 체결일 ${run.turn.length}일 중 월말 다음 거래일·손절 다음 거래일이 아닌 날 ${unexplained.length}일(거래정지로 밀린 체결·소멸 청산 등)`);
      if (unexplained.length > Math.max(5, run.turn.length * 0.03)) fails.push(`VB1S 월 중 설명되지 않는 체결 ${unexplained.length}일`);
      const closed = run.trades;
      console.log(`[점검 5] VB1S 소멸 종목 청산: 마지막 종가 청산 ${closed.filter((x) => x.reason === "폐지").length}건 · 전액 손실 ${closed.filter((x) => x.reason === "폐지(전액 손실)").length}건(닫힌 거래 ${closed.length}건 중)`);
      const sat = slFromRun(run);
      if (coreFull.dates.length !== sat.dates.length || coreFull.dates.some((x, k) => x !== sat.dates[k])) fails.push("VB1SC 날짜 축");
      else console.log(`[점검 5] VB1SC 날짜 축: 코어 ${coreFull.dates[0]}~${coreFull.dates[coreFull.dates.length - 1]}(${coreFull.dates.length}일) = 위성 일치`);
      const a = combineN([coreFull, sat], [B5_CORE_W, 1 - B5_CORE_W], CS_MOVE_COST, null).run.ret, b = combine2(coreFull, sat, B5_CORE_W, CS_MOVE_COST).run.ret;
      let mxd = 0;
      for (let k = 0; k < a.length; k++) mxd = Math.max(mxd, Math.abs(a[k] - b[k]));
      const sig = [...new Set(monthEndIdx.filter((c) => c > cV).map((c) => CAL[c]))];
      console.log(`[점검 5] 월 리밸런스 경로: combineN(매일) ↔ combine2 일수익률 최대 차이 ${mxd.toExponential(2)}%p | 월 재조정 신호일 ${sig.length}개(${sig[0]}~${sig[sig.length - 1]})`);
      if (!(mxd < 1e-9)) fails.push(`combineN(매일) ≠ combine2 (최대 차이 ${mxd})`);
    }
    // [점검 6] 손절 수준별 발동 건수(성과 아님)
    for (const [lb, ch] of [["손절 -20%(기본)", {}], ...VB1S_NB] as [string, Partial<VbsP>][]) { runS(vbs, { ...VB1S_P0, ...ch }, cV, null, { lag: 1 }); console.log(`[점검 6] ${lb}: 손절 발동 ${vbsLog.length}건`); }
    console.log(`\n정보용 항목 구현 목록(시험 출력에서 이 머리표로 대조): [R3] 연도별 승패 · [R4] 승률·손익비·기대값 · [R5] 나란히 비교 표(DS6·DS13L·VB1·VB1C·RM1SC) · [R6] 연 회전율·비용 · [R7] 상위 10개 거래 손익 비중 · [V1] 손절 발동 횟수와 손절 후 21거래일 수익 · [V2] 평균 현금 비중(평가 출력의 "평균 투자 비중" 줄) · [V3] 삼성전자·SK하이닉스 평균 비중(두 종목 수익 0 = vbsinfo + NEUTRALIZE_CODES) · [V4] VB1 MDD 구간(2018-01-29~2020-03-23) 구간 수익 · [V5] 하루 지연(C) · [V6] RM1SC·DS13L 등 일간 상관 · [V7] 월 신호일 앞당김 민감도(vbsinfo2) · [V8] 의심 종목-일 처리 없음 비교(vbsinfo) · [V9] 누적 시험·우연 통과 기대(요약)`);
    if (fails.length) { console.log(`\n사전 점검 실패 ${fails.length}건:\n${fails.map((x) => `  - ${x}`).join("\n")}`); throw new Error("사전 점검 실패 — 시험하지 않고 중단해 보고한다"); }
    console.log(`\n저PBR 손절 사전 점검 통과(VB1S·VB1SC 성과는 계산·출력하지 않았다; DS6·VB1·VB1C 재현 줄은 환경 확인용) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "vbsinfo") {
    // 정보용(시험 아님): VB1S·VB1SC·VB1·VB1C·RM1SC·DS13L 기준 실행의 구간별 CAGR/MDD — 의심 종목-일 0% 처리 유무 비교 또는 두 종목(NEUTRALIZE_CODES) 수익 0 비교용.
    await loadEqTables();
    requireStart();
    const vb1 = mkVB("VB1", VB1_P0, VB1_NB), cV = startOf(vb1, false), Wx = windowsV(cV), coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, Wx.FULL.from);
    const vb1Run = runS(vb1, VB1_P0, cV, null, { lag: 1, detail: true }), vbsc = vbscOf(cV, Wx), rmsc = rm1scOf(cV, Wx);
    const rows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [
      { nm: "VB1", run: vb1Run }, { nm: "VB1C", run: combine2(coreFull, slFromRun(vb1Run), B5_CORE_W, CS_MOVE_COST).run }, { nm: "VB1S", run: vbsc.sat }, { nm: "VB1SC", run: vbsc.res.run }, { nm: "RM1SC", run: rmsc.res.run },
      { nm: "DS13L", run: d13Of("LV1", cV, Wx).base.res.run }, { nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run },
    ];
    console.log(`\n=== [V8] 정보용: ${NEUTRALIZE_ON ? `수정 수익률을 0으로 둔 종목 ${process.env.NEUTRALIZE_CODES}(069500 기준선은 그대로, DS6·DS13L 코어도 영향을 받음) · ` : ""}${ZERO_SUSPECT_ON ? `의심 종목-일 0% 처리 적용(${suspectLog.length}건)` : "의심 종목-일 처리 없음"} — CAGR % / MDD % (같은 구간 ${Wx.FULL.from}~) ===\n| 구간 | ${rows.map((r) => r.nm).join(" | ")} |\n|---|${rows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${rows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    console.log(`\n정보용 실행 종료(시험 아님) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "vbsinfo2") {
    // 정보용(시험 아님, 판정 변경 없음): 월 신호일을 마지막 거래일에서 5·10거래일 앞당긴 민감도(VB1S·VB1SC). 첫 신호일·코어(일별 규칙)·손절(일별 규칙)은 그대로.
    await loadEqTables();
    requireStart();
    const vb1 = mkVB("VB1", VB1_P0, VB1_NB), cV = startOf(vb1, false), Wx = windowsV(cV), from = Wx.FULL.from, bRun = { dates: h.bhP.dates, ret: h.bhP.ret };
    const shifts = [0, 5, 10].map((sh) => ({ sh, x: vbscOf(cV, Wx, { shift: sh }) }));
    console.log(`\n=== [V7] 정보용 견고성 점검: 월 신호일(VB1 신호·월말 손절 겹침 처리·하위 계좌 간 재조정 신호)을 마지막 거래일에서 5·10거래일 앞당김 — CAGR % / MDD % (같은 구간 ${from}~, 보정 + 0% 처리 데이터) ===`);
    for (const [lb, pick] of [["VB1SC", (x: (typeof shifts)[number]["x"]) => x.res.run], ["VB1S(위성 단독)", (x: (typeof shifts)[number]["x"]) => x.sat]] as [string, (x: (typeof shifts)[number]["x"]) => { dates: string[]; ret: number[] }][]) {
      console.log(`${lb}\n| 구간 | 069500 | 기준(0일) | −5일 | −10일 |\n|---|---|---|---|---|`);
      for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${f2(h.st(bRun, w).cagr)} / ${f2(h.st(bRun, w).mdd)} | ${shifts.map((x) => `${f2(h.st(pick(x.x), w).cagr)} / ${f2(h.st(pick(x.x), w).mdd)}`).join(" | ")} |`);
      const f0 = h.st(pick(shifts[0].x), Wx.FULL);
      console.log(`${lb} 연속 CAGR 차이(기준 대비 %p): ${shifts.slice(1).map((x) => `−${x.sh}일 ${sg(h.st(pick(x.x), Wx.FULL).cagr - f0.cagr)}(MDD ${sg(h.st(pick(x.x), Wx.FULL).mdd - f0.mdd)}%p)`).join(" · ")} | CAGR 차이 1.5%p 초과 ${shifts.slice(1).some((x) => Math.abs(h.st(pick(x.x), Wx.FULL).cagr - f0.cagr) > 1.5) ? "있음" : "없음"}`);
    }
    console.log(`\n정보용 실행 종료(시험 아님, 판정 변경 없음) | ${storageLine()} | 외부 요청 0 | DART 호출 0 | 연구 DB 쓰기 0`);
    return;
  }
  if (MODE === "v3info") {
    // 정보용(시험 아님, 시험 번호·게이트 없음): VL1·VL1C·VB1·VB1C·DS13L 기준 실행의 구간별 CAGR/MDD — 데이터 처리(810건 0% 처리 유무) 비교용.
    await loadEqTables();
    requireStart();
    if (V_START !== V2_START) throw new Error(`V_START=${V_START}이 사전등록 시작일 ${V2_START}과 다르다 — 중단`);
    const vl1 = mkVL("VL1", VL1_P0, VL1_NB), vb1 = mkVB("VB1", VB1_P0, VB1_NB), cV = startOf(vl1, false), Wx = windowsV(cV);
    const coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, Wx.FULL.from);
    const vlRun = runS(vl1, VL1_P0, cV, null, { lag: 1, detail: true }), vbRun = runS(vb1, VB1_P0, cV, null, { lag: 1, detail: true });
    const rows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [
      { nm: "VL1", run: vlRun }, { nm: "VL1C", run: combine2(coreFull, slFromRun(vlRun), B5_CORE_W, CS_MOVE_COST).run },
      { nm: "VB1", run: vbRun }, { nm: "VB1C", run: combine2(coreFull, slFromRun(vbRun), B5_CORE_W, CS_MOVE_COST).run },
      { nm: "DS13L", run: d13Of("LV1", cV, Wx).base.res.run }, { nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run },
    ];
    console.log(`\n=== [J7] 정보용: ${ZERO_SUSPECT_ON ? `의심 종목-일 0% 처리 적용(${suspectLog.length}건)` : "의심 종목-일 처리 없음"} — CAGR % / MDD % (같은 구간 ${Wx.FULL.from}~) ===\n| 구간 | ${rows.map((r) => r.nm).join(" | ")} |\n|---|${rows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${rows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
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
  } else if (MODE === "v2test") {
    await loadEqTables();
    requireStart();
    if (V_START !== V2_START) throw new Error(`V_START=${V_START}이 사전등록 시작일 ${V2_START}과 다르다 — 중단`);
    console.log(`저평가 후속 시험 설정: ${V_CASE}, 시작 월말 ${V_START}, 데이터: ${PRICE_CORRECTION_ON ? "K200P 17건 보정 적용" : "보정 미적용"} + ${ZERO_SUSPECT_ON ? `의심 종목-일 0% 처리 ${suspectLog.length}건(보정 후보 A)` : "의심 종목-일 처리 없음"}`);
    const vb1 = mkVB("VB1", VB1_P0, VB1_NB), vb1f = mkVB1F();
    const cV = startOf(vb1, false), Wx = windowsV(cV), from = Wx.FULL.from;
    console.log(`연속 평가 공통: 첫 신호일 ${CAL[cV]}, 수익률 집계 ${from}~${h.dataEnd} | 구간 ${Wx.NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(VB1F, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkS(vb1f, "VB1F", trial, true, cV, Wx, "VB1F: VB1 + 시장 필터(월말 신호일 069500 종가가 200일 단순이동평균 미만이면 주식 비중 50%, 이상이면 100%), 이웃 이동평균 150·250일")));
    }
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(DS14, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkD14("DS14", trial, cV, Wx, "DS14: 코어 40%(DS6 코어) + 모멘텀 위성 30%(RM1) + 가치 위성 30%(VB1), 매월 하위 계좌 40/30/30 재조정")));
    }
    // ---- 나란히 비교 [R5] ----
    const vb1Run = runS(vb1, VB1_P0, cV, null, { lag: 1, detail: true }), rm1Run = runS(RM1, RM1.P0, cV, null, { lag: 1, detail: true });
    const coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, from);
    const rm1c = combine2(coreFull, slFromRun(rm1Run), B5_CORE_W, CS_MOVE_COST).run, vb1c = combine2(coreFull, slFromRun(vb1Run), B5_CORE_W, CS_MOVE_COST).run;
    const d13l = d13Of("LV1", cV, Wx).base.res.run, d13m = d13Of("MV1", cV, Wx).base.res.run;
    const vbfRun = verdicts.find((v) => v.id === "VB1F")?.run as SimRun, ds14Run = verdicts.find((v) => v.id === "DS14")?.run as SimRun;
    const cmpRows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [{ nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run }, { nm: "DS13L", run: d13l }, { nm: "DS13M", run: d13m }, { nm: "VB1", run: vb1Run }, { nm: "VB1C", run: vb1c }, { nm: "RM1C", run: rm1c }, { nm: "VB1F", run: vbfRun }, { nm: "DS14", run: ds14Run }];
    console.log(`\n=== [R5] 같은 데이터(${PRICE_CORRECTION_ON ? "보정 적용" : "보정 미적용"} + ${ZERO_SUSPECT_ON ? "의심 종목-일 0% 처리" : "처리 없음"}) 기준 나란히 비교 (CAGR % / MDD %; 같은 구간 ${from}~; DS6·VB1C·RM1C는 일별 40:60 재조정, DS13L·DS14는 월 1회 40/30/30) ===`);
    console.log(`| 구간 | ${cmpRows.map((r) => r.nm).join(" | ")} |\n|---|${cmpRows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${cmpRows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    const fl = cmpRows.map((r) => ({ nm: r.nm, s: h.st(r.run, Wx.FULL) }));
    console.log(`연 회전율 % / 비용 합계 %(연속): ${fl.map((x) => `${x.nm} ${f2(x.s.turnover)} / ${f2(x.s.cost)}`).join(" | ")}`);
    // ---- [R3] 연도별 DS13L 대비 ----
    const bh = BH_FROM(from);
    for (const [nm, run] of [["VB1F", vbfRun], ["DS14", ds14Run]] as [string, SimRun][]) {
      console.log(`\n=== [R3] ${nm} 연도별 수익률 % (DS13L 대비; 069500·DS6 대비는 위 공통 보고) ===\n| 연도 | 069500 | DS6 | DS13L | ${nm} | ${nm} − DS13L %p |\n|---|---|---|---|---|---|`);
      const ex: number[] = [];
      for (let y = Number(from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) {
        const a = h.yearRet(bh, y), c6 = h.yearRet({ dates: b6.res.run.dates.filter((d) => d >= from), ret: b6.res.run.ret.filter((_, k) => b6.res.run.dates[k] >= from) }, y), cl = h.yearRet(d13l, y), cc = h.yearRet(run, y);
        ex.push(cc - cl);
        console.log(`| ${y} | ${f2(a)} | ${f2(c6)} | ${f2(cl)} | ${f2(cc)} | ${sg(cc - cl)} |`);
      }
      console.log(`${nm} − DS13L 승·패 연수: 승 ${ex.filter((x) => x > 0).length} / 패 ${ex.filter((x) => x < 0).length} (평균 ${sg(avg(ex))}%p, 중앙값 ${sg(median(ex))}%p)`);
    }
    // ---- [I1] 일간 수익률 상관계수 ----
    console.log(`\n=== [I1] 일간 수익률 상관계수(공통 구간 ${from}~${h.dataEnd}, 정보용) ===`);
    {
      const mkSer = (name: string, r: { dates: string[]; ret: number[] }): { name: string; m: Map<string, number> } => ({ name, m: new Map(r.dates.map((d, i2) => [d, r.ret[i2]])) });
      const ser = [mkSer("VB1", vb1Run), mkSer("RM1", rm1Run), mkSer("DS13L", d13l), mkSer("DS14", ds14Run), mkSer("VB1F", vbfRun), mkSer("069500", { dates: h.bhP.dates, ret: h.bhP.ret })];
      const days = vb1Run.dates.filter((d) => d >= from && ser.every((x) => x.m.has(d)));
      const corr = (x: Map<string, number>, y: Map<string, number>): number => { const xs = days.map((d) => x.get(d) as number), ys = days.map((d) => y.get(d) as number), n = xs.length, mx = avg(xs), my = avg(ys); let sxy = 0, sxx = 0, syy = 0; for (let i2 = 0; i2 < n; i2++) { sxy += (xs[i2] - mx) * (ys[i2] - my); sxx += (xs[i2] - mx) ** 2; syy += (ys[i2] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
      console.log(`공통 ${days.length}일`);
      console.log(`| | ${ser.map((x) => x.name).join(" | ")} |\n|---|${ser.map(() => "---").join("|")}|`);
      for (const x of ser) console.log(`| ${x.name} | ${ser.map((y) => f2(corr(x.m, y.m))).join(" | ")} |`);
    }
    // ---- [I2] VB1 MDD 구간과 지수 등락 ----
    console.log(`\n=== [I2] VB1 최대 낙폭(MDD) 구간 ===`);
    {
      const w = winStat(vb1Run, from, "9999-12-31");
      console.log(`VB1 연속 전체 MDD ${f2(w.mdd)}%: 고점일 ${w.peak} → 저점일 ${w.trough}`);
      const kospi = await getIndexPriceSeries("KOSPI", "2009-01-01", h.dataEnd), kosdaq = await getIndexPriceSeries("KOSDAQ", "2009-01-01", h.dataEnd);
      dbRead["beta_price_history(KOSPI)"] = kospi.length; dbRead["beta_price_history(KOSDAQ)"] = kosdaq.length;
      const chg = (ser: { tradeDate: string; closePrice: number }[], a: string, b: string): number => { const x = [...ser].reverse().find((p2) => p2.tradeDate <= a), y = [...ser].reverse().find((p2) => p2.tradeDate <= b); return x && y ? (y.closePrice / x.closePrice - 1) * 100 : Number.NaN; };
      const curveChg = (r: { dates: string[]; ret: number[] }, a: string, b: string): number => { let vv = 1; for (let i2 = 0; i2 < r.dates.length; i2++) if (r.dates[i2] > a && r.dates[i2] <= b) vv *= 1 + r.ret[i2] / 100; return (vv - 1) * 100; };
      console.log(`같은 구간(${w.peak}~${w.trough}) 등락 %: VB1 ${f2(curveChg(vb1Run, w.peak, w.trough))} | 069500 ${f2(curveChg({ dates: h.bhP.dates, ret: h.bhP.ret }, w.peak, w.trough))} | KOSPI 지수 ${f2(chg(kospi, w.peak, w.trough))} | KOSDAQ 지수 ${f2(chg(kosdaq, w.peak, w.trough))} | VB1F ${f2(curveChg(vbfRun, w.peak, w.trough))} | VB1C ${f2(curveChg(vb1c, w.peak, w.trough))} | DS13L ${f2(curveChg(d13l, w.peak, w.trough))} | DS14 ${f2(curveChg(ds14Run, w.peak, w.trough))} (지수 행 수 KOSPI ${kospi.length}, KOSDAQ ${kosdaq.length})`);
    }
    // ---- [I3] VB1 삼성전자·SK하이닉스 보유 ----
    console.log(`\n=== [I3] VB1 보유 종목의 삼성전자·SK하이닉스 보유 여부 ===`);
    {
      const ptV = pathTgG(vb1, cV), all = [...vb1Run.trades, ...vb1Run.open];
      for (const code of V2_WATCH) {
        const ts = all.filter((t) => t.code === code), nT = ptV.filter((x) => x.t.has(code)).length;
        console.log(`${label(code)}: 월말 목표 보유 ${nT}/${ptV.length}개 신호일 | 보유 구간 ${ts.length}건${ts.length ? `: ${ts.map((t) => `${CAL[t.entryC]}~${t.reason === "기간 끝 평가" ? "보유 중" : CAL[t.exitC]}`).slice(0, 8).join(", ")}` : " (보유한 적 없음)"} | 가격 손익 기여 ${sg(vb1Run.contrib.get(code)?.pct ?? 0)}%p`);
      }
    }
    // ---- [I4] VB1 2025~2026 손실 업종·시장 ----
    console.log(`\n=== [I4] VB1 ${V2_LOSS_FROM.slice(0, 4)}~${h.dataEnd.slice(0, 4)} 손실 분해(종목별 일 가격 손익 기여 %p의 합, 비용 제외; 업종 = KSIC 2자리, 시장 = 2025-12월말 목록 우선) ===`);
    {
      const years = [...vb1Run.contribY.keys()].filter((y) => y >= V2_LOSS_FROM.slice(0, 4)).sort();
      const byCode = new Map<string, number>();
      for (const y of years) {
        const m = vb1Run.contribY.get(y) as Map<string, number>;
        let tot = 0, pos = 0, neg = 0;
        for (const [code, v] of m) { tot += v; if (v > 0) pos += v; else neg += v; byCode.set(code, (byCode.get(code) ?? 0) + v); }
        console.log(`${y}년: 종목 가격 손익 기여 합 ${sg(tot)}%p (이익 종목 합 ${sg(pos)} / 손실 종목 합 ${sg(neg)}) | VB1 수익률 ${f2(h.yearRet(vb1Run, Number(y)))}% vs 069500 ${f2(h.yearRet(bh, Number(y)))}%`);
      }
      const marketOf = (code: string): string => { for (const d of ["2025-12-31", "2025-06-30", "2024-12-31", "2023-12-31"]) { const v = membAt(d)?.get(code); if (v) return v; } return "?"; };
      const indOfC = (code: string): string => (indOf.get(code) ?? "").slice(0, 2) || "미상";
      const ind = new Map<string, { sum: number; n: number }>(), mkt = new Map<string, number>();
      for (const [code, v] of byCode) { const k = indOfC(code), e = ind.get(k) ?? { sum: 0, n: 0 }; e.sum += v; e.n++; ind.set(k, e); mkt.set(marketOf(code), (mkt.get(marketOf(code)) ?? 0) + v); }
      const ia = [...ind.entries()].sort((a, b) => a[1].sum - b[1].sum);
      const tot = [...byCode.values()].reduce((a, x) => a + x, 0), unk = ind.get("미상");
      console.log(`${years.join("~")} 합계 ${sg(tot)}%p | 업종별(손실 큰 순 상위 8 / 이익 큰 순 상위 3): ${ia.slice(0, 8).map(([k, v]) => `${k}(${v.n}종목) ${sg(v.sum)}`).join(", ")} | ${ia.slice(-3).reverse().map(([k, v]) => `${k}(${v.n}종목) ${sg(v.sum)}`).join(", ")} | 업종 미상 ${unk ? `${unk.n}종목 ${sg(unk.sum)}%p(합계 대비 ${f2((unk.sum / (tot || 1)) * 100)}%)` : "0종목"}`);
      console.log(`시장별 기여 %p: ${[...mkt.entries()].map(([k, v]) => `${k} ${sg(v)}`).join(" | ")}`);
      const sa = [...byCode.entries()].sort((a, b) => a[1] - b[1]);
      console.log(`손실 큰 종목 상위 8: ${sa.slice(0, 8).map(([c, v]) => `${label(c)}[${indOfC(c)}·${marketOf(c)}] ${sg(v)}`).join(", ")} | 이익 큰 종목 상위 5: ${sa.slice(-5).reverse().map(([c, v]) => `${label(c)}[${indOfC(c)}·${marketOf(c)}] ${sg(v)}`).join(", ")}`);
    }
  } else if (MODE === "v3test") {
    await loadEqTables();
    requireStart();
    if (V_START !== V2_START) throw new Error(`V_START=${V_START}이 사전등록 시작일 ${V2_START}과 다르다 — 중단`);
    console.log(`저PBR 대형주 시험 설정: ${V_CASE}, 시작 월말 ${V_START}, 데이터: ${PRICE_CORRECTION_ON ? "K200P 17건 보정 적용" : "보정 미적용"} + ${ZERO_SUSPECT_ON ? `의심 종목-일 0% 처리 ${suspectLog.length}건(보정 후보 A)` : "의심 종목-일 처리 없음"}`);
    const vl1 = mkVL("VL1", VL1_P0, VL1_NB), vb1 = mkVB("VB1", VB1_P0, VB1_NB);
    const cV = startOf(vl1, false), Wx = windowsV(cV), from = Wx.FULL.from;
    console.log(`연속 평가 공통: 첫 신호일 ${CAL[cV]}, 수익률 집계 ${from}~${h.dataEnd} | 구간 ${Wx.NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(VL1, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkS(vl1, "VL1", trial, false, cV, Wx, "VL1: 신호일 K200P(PIT) ∩ BS1 적격 중 PBR 하위 30종목 동일 비중(1/30, 후보 부족 시 나머지 현금), 기존 보유는 하위 90위 안이면 유지, 월말 신호")));
    }
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(VL1C, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkC(vl1, "VL1C", trial, cV, Wx, "VL1C: DS6 코어 40% + 위성 60% = VL1")));
    }
    // ---- 기준 실행(보고용) ----
    // [J1] VB1 MDD 구간 시총 3분위 분해를 위해 VB1 기준 실행에 종목-일 기여 콜백을 건다.
    const win = V3_MDD_WINDOW, lastMeBefore = (d: string): number => { let lo = 0, hi = monthEndIdx.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (CAL[monthEndIdx[m]] < d) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
    const terMemo = new Map<number, Map<string, number>>();
    const terAt = (c: number): Map<string, number> => {
      let m = terMemo.get(c);
      if (!m) {
        const list = vbSorted(c, VB1_P0).map((code) => ({ code, mc: mcAt(h.byCode.get(code) as S, c) })).filter((x) => Number.isFinite(x.mc)).sort((a, b) => a.mc - b.mc || (a.code < b.code ? -1 : 1));
        m = new Map(list.map((x, k) => [x.code, Math.min(Math.floor((k * V3_TERCILES) / list.length), V3_TERCILES - 1)]));
        terMemo.set(c, m);
      }
      return m;
    };
    const terOf = (d: string, code: string): number => { const k0 = lastMeBefore(d); for (let k = k0; k >= Math.max(k0 - 3, 0); k--) { const v = terAt(monthEndIdx[k]).get(code); if (v !== undefined) return v; } return -1; };
    const acc = new Array<number>(V3_TERCILES + 1).fill(0), neg = new Array<number>(V3_TERCILES + 1).fill(0), dayCnt = new Array<number>(V3_TERCILES + 1).fill(0), winDays = new Set<string>();
    const vb1Run = runS(vb1, VB1_P0, cV, null, { lag: 1, detail: true, onContrib: (d, code, pct) => { if (d > win.from && d <= win.to) { const k = terOf(d, code), j = k < 0 ? V3_TERCILES : k; acc[j] += pct; dayCnt[j]++; if (pct < 0) neg[j] += pct; winDays.add(d); } } });
    const rm1Run = runS(RM1, RM1.P0, cV, null, { lag: 1, detail: true });
    const coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, from);
    const rm1c = combine2(coreFull, slFromRun(rm1Run), B5_CORE_W, CS_MOVE_COST).run, vb1c = combine2(coreFull, slFromRun(vb1Run), B5_CORE_W, CS_MOVE_COST).run;
    const d13l = d13Of("LV1", cV, Wx).base.res.run, d13m = d13Of("MV1", cV, Wx).base.res.run, ds14 = d14Of(cV, Wx).base.res.run;
    const vl1Run = verdicts.find((v) => v.id === "VL1")?.run as SimRun, vl1cRun = verdicts.find((v) => v.id === "VL1C")?.run as SimRun;
    // ---- [R5] 나란히 비교 ----
    const cmpRows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [{ nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run }, { nm: "DS13L", run: d13l }, { nm: "DS13M", run: d13m }, { nm: "VB1", run: vb1Run }, { nm: "VB1C", run: vb1c }, { nm: "RM1C", run: rm1c }, { nm: "DS14", run: ds14 }, { nm: "VL1", run: vl1Run }, { nm: "VL1C", run: vl1cRun }];
    console.log(`\n=== [R5] 같은 데이터(${PRICE_CORRECTION_ON ? "보정 적용" : "보정 미적용"} + ${ZERO_SUSPECT_ON ? "의심 종목-일 0% 처리" : "처리 없음"}) 기준 나란히 비교 (CAGR % / MDD %; 같은 구간 ${from}~; DS6·VB1C·RM1C·VL1C는 일별 40:60 재조정, DS13L·DS14는 월 1회 재조정) ===`);
    console.log(`| 구간 | ${cmpRows.map((r) => r.nm).join(" | ")} |\n|---|${cmpRows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${cmpRows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    const fl = cmpRows.map((r) => ({ nm: r.nm, s: h.st(r.run, Wx.FULL) }));
    console.log(`연 회전율 % / 비용 합계 %(연속): ${fl.map((x) => `${x.nm} ${f2(x.s.turnover)} / ${f2(x.s.cost)}`).join(" | ")}`);
    // ---- [R3] 연도별 DS13L 대비 ----
    const bh = BH_FROM(from);
    for (const [nm, run] of [["VL1", vl1Run], ["VL1C", vl1cRun]] as [string, SimRun][]) {
      console.log(`\n=== [R3] ${nm} 연도별 수익률 % (DS13L 대비; 069500·DS6 대비는 위 공통 보고) ===\n| 연도 | 069500 | DS6 | DS13L | ${nm} | ${nm} − DS13L %p |\n|---|---|---|---|---|---|`);
      const ex: number[] = [];
      for (let y = Number(from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) {
        const a = h.yearRet(bh, y), c6 = h.yearRet({ dates: b6.res.run.dates.filter((d) => d >= from), ret: b6.res.run.ret.filter((_, k) => b6.res.run.dates[k] >= from) }, y), cl = h.yearRet(d13l, y), cc = h.yearRet(run, y);
        ex.push(cc - cl);
        console.log(`| ${y} | ${f2(a)} | ${f2(c6)} | ${f2(cl)} | ${f2(cc)} | ${sg(cc - cl)} |`);
      }
      console.log(`${nm} − DS13L 승·패 연수: 승 ${ex.filter((x) => x > 0).length} / 패 ${ex.filter((x) => x < 0).length} (평균 ${sg(avg(ex))}%p, 중앙값 ${sg(median(ex))}%p)`);
    }
    // ---- [J1] VB1 MDD 구간 시총 3분위 분해 ----
    console.log(`\n=== [J1] VB1 MDD 구간(${win.from}~${win.to}) 보유 종목 신호월 시가총액 3분위 손익 분해(종목 가격 손익 기여 %p의 단순 합, 비용 제외; 분류 = 그 달 월말 BS1 적격 ∧ PBR 있는 유니버스의 시총 3등분, 직전 월말 분류 없으면 최대 3개월 소급) ===`);
    {
      const w = winStat(vb1Run, from, "9999-12-31"), wv = winStat(vb1Run, win.from, win.to);
      console.log(`VB1 연속 전체 MDD ${f2(w.mdd)}%: 고점일 ${w.peak} → 저점일 ${w.trough} (사전등록 구간 ${win.from}~${win.to}과 ${w.peak === win.from && w.trough === win.to ? "일치" : "다름"}) | 사전등록 구간 VB1 복리 ${f2(wv.tot)}%`);
      const tot = acc.reduce((a, x) => a + x, 0), nd = Math.max(winDays.size, 1), lab = ["하위(소형) 1/3", "중위 1/3", "상위(대형) 1/3", "분류 불가"];
      console.log("| 시총 분류 | 구간 가격 손익 기여 합 %p | 전체 합 대비 % | 손실 종목-일 기여 합 %p | 일평균 보유 종목 수 |\n|---|---|---|---|---|");
      acc.forEach((v, j) => console.log(`| ${lab[j]} | ${sg(v)} | ${f2(tot ? (v / tot) * 100 : 0)} | ${sg(neg[j])} | ${f2(dayCnt[j] / nd)} |`));
      console.log(`합계 ${sg(tot)}%p(구간 ${winDays.size}거래일) → **하위(소형) 3분위가 낙폭의 ${f2(tot ? (acc[0] / tot) * 100 : 0)}%** (하위 합 ${sg(acc[0])}%p ÷ 전체 합 ${sg(tot)}%p; 손실 종목-일 합 기준 하위 비중 ${f2(neg.reduce((a, x) => a + x, 0) ? (neg[0] / neg.reduce((a, x) => a + x, 0)) * 100 : 0)}%)`);
      const wl = winStat(vl1Run, win.from, win.to), wcl = winStat(vl1cRun, win.from, win.to);
      console.log(`같은 구간(${win.from}~${win.to}) 복리 %: VB1 ${f2(wv.tot)} | VL1 ${f2(wl.tot)} | VL1C ${f2(wcl.tot)} | 069500 ${f2(winStat({ dates: h.bhP.dates, ret: h.bhP.ret }, win.from, win.to).tot)} | DS13L ${f2(winStat(d13l, win.from, win.to).tot)}`);
    }
    // ---- [J2] 일간 수익률 상관계수 ----
    console.log(`\n=== [J2] 일간 수익률 상관계수(공통 구간 ${from}~${h.dataEnd}, 정보용) ===`);
    {
      const mkSer = (name: string, r: { dates: string[]; ret: number[] }): { name: string; m: Map<string, number> } => ({ name, m: new Map(r.dates.map((d, i2) => [d, r.ret[i2]])) });
      const ser = [mkSer("VL1", vl1Run), mkSer("VB1", vb1Run), mkSer("RM1", rm1Run), mkSer("DS13L", d13l), mkSer("VL1C", vl1cRun), mkSer("069500", { dates: h.bhP.dates, ret: h.bhP.ret })];
      const dd = vl1Run.dates.filter((d) => d >= from && ser.every((x) => x.m.has(d)));
      const corr = (x: Map<string, number>, y: Map<string, number>): number => { const xs = dd.map((d) => x.get(d) as number), ys = dd.map((d) => y.get(d) as number), n = xs.length, mx = avg(xs), my = avg(ys); let sxy = 0, sxx = 0, syy = 0; for (let i2 = 0; i2 < n; i2++) { sxy += (xs[i2] - mx) * (ys[i2] - my); sxx += (xs[i2] - mx) ** 2; syy += (ys[i2] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
      console.log(`공통 ${dd.length}일`);
      console.log(`| | ${ser.map((x) => x.name).join(" | ")} |\n|---|${ser.map(() => "---").join("|")}|`);
      for (const x of ser) console.log(`| ${x.name} | ${ser.map((y) => f2(corr(x.m, y.m))).join(" | ")} |`);
    }
    // ---- [J3] 평균 PBR · [J6] 후보 수 ----
    console.log(`\n=== [J3] 보유 종목 평균 PBR(월말 신호일 목표 종목, 근사: 이전 목표 = 보유) · [J6] 후보 수 ===`);
    {
      const ptL = pathTgG(vl1, cV), ptB = pathTgG(vb1, cV);
      const pbrStat = (pt: { c: number; t: Map<string, number> }[]): { mean: number; med: number; n: number } => { const v: number[] = []; for (const { c, t } of pt) for (const code of t.keys()) { const x = pbrAt(c, h.byCode.get(code) as S, VB1_P0.maxAge); if (x.why === "ok") v.push(x.pbr); } return { mean: avg(v), med: median(v), n: v.length }; };
      const a = pbrStat(ptL), b = pbrStat(ptB);
      console.log(`평균 PBR: VL1 ${f2(a.mean)}(중앙값 ${f2(a.med)}, ${a.n}건) | VB1 ${f2(b.mean)}(중앙값 ${f2(b.med)}, ${b.n}건)`);
      const cnt = vl1.signalDays.filter((x) => x >= cV).map((c) => vlSorted(c, VL1_P0).length), held = ptL.map((x) => x.t.size);
      console.log(`VL1 후보 수(K200P ∩ BS1 적격 ∧ PBR 있음) 신호일 ${cnt.length}개: 최소 ${Math.min(...cnt)} 평균 ${f2(avg(cnt))} 최대 ${Math.max(...cnt)} | 후보 ${VL1_P0.n}개 미만인 월 ${cnt.filter((x) => x < VL1_P0.n).length}개 | 목표 종목 수 평균 ${f2(avg(held))}(최소 ${Math.min(...held)}) → 평균 투자 비중 ${f2((avg(held) / VL1_P0.n) * 100)}%`);
    }
    // ---- [J4] 삼성전자·SK하이닉스 ----
    console.log(`\n=== [J4] VL1·VL1C의 삼성전자·SK하이닉스 보유 여부와 평균 목표 비중 ===`);
    {
      const ptL = pathTgG(vl1, cV), coreRun = coreOf(2, undefined, 1, {}).run, all = [...vl1Run.trades, ...((vl1Run as RebalRun).open ?? [])];
      for (const code of V3_WATCH) {
        let nHold = 0, wL = 0, wCore = 0;
        for (const { c, t } of ptL) { const w = t.get(code) ?? 0; if (w > 0) nHold++; wL += w; const ev = [...coreRun.events].filter((e) => e.c <= c + 1).pop(); wCore += ev ? (ev.w[ev.set.indexOf(code)] ?? 0) : 0; }
        const n = ptL.length, ts = all.filter((t) => t.code === code);
        console.log(`${label(code)}: VL1 월말 목표 보유 ${nHold}/${n}개 신호일(구간 ${ts.length}건${ts.length ? `: ${ts.map((t) => `${CAL[t.entryC]}~${t.reason === "기간 끝 평가" ? "보유 중" : CAL[t.exitC]}`).slice(0, 6).join(", ")}` : ""}) | 평균 목표 비중(계좌 기준 %): VL1 ${f2((wL / n) * 100)} | VL1C = 코어 40% × ${f2((wCore / n) * 100)} + 위성 60% × ${f2((wL / n) * 100)} = ${f2(0.4 * (wCore / n) * 100 + 0.6 * (wL / n) * 100)}%`);
      }
    }
  } else if (MODE === "qtest") {
    await loadEqTables();
    await loadRoe();
    requireStart();
    console.log(`재무 품질(ROE) 시험 설정: ${V_CASE}, 시작 월말 ${V_START}(사전등록 계획 ${Q_PLANNED_START}${V_START === Q_PLANNED_START ? "과 같음" : "에서 완화됨"}), 데이터: ${PRICE_CORRECTION_ON ? "K200P 17건 보정 적용" : "보정 미적용"} + ${ZERO_SUSPECT_ON ? `의심 종목-일 0% 처리 ${suspectLog.length}건(보정 후보 A)` : "의심 종목-일 처리 없음"}`);
    const q1 = mkQ("Q1", Q1_P0, Q1_NB), qv1 = mkQ("QV1", QV1_P0, QV1_NB), vb1 = mkVB("VB1", VB1_P0, VB1_NB);
    const cV = startOf(q1, false), Wx = windowsV(cV), from = Wx.FULL.from;
    console.log(`연속 평가 공통: 첫 신호일 ${CAL[cV]}, 수익률 집계 ${from}~${h.dataEnd} | 구간 ${Wx.NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(Q1, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkS(q1, "Q1", trial, false, cV, Wx, "Q1: BS1 적격 ∧ ROE(TTM 당기순이익 ÷ 자본총계, 자본·TTM > 0) 상위 30종목 동일 비중(1/30), 기존 보유는 ROE 순위 90위 안이면 유지, 월말 신호")));
    }
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(QV1, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkS(qv1, "QV1", trial, false, cV, Wx, "QV1: (PBR 하위 백분위 + ROE 상위 백분위) ÷ 2 상위 30종목 동일 비중, 기존 보유는 점수 순위 90위 안이면 유지, 월말 신호")));
    }
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(QV1C, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkC(qv1, "QV1C", trial, cV, Wx, "QV1C: DS6 코어 40% + 위성 60% = QV1")));
    }
    // ---- 기준 실행(보고용) ----
    const win = V3_MDD_WINDOW;
    const vb1Run = runS(vb1, VB1_P0, cV, null, { lag: 1, detail: true }), rm1Run = runS(RM1, RM1.P0, cV, null, { lag: 1, detail: true });
    const coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, from);
    const rm1c = combine2(coreFull, slFromRun(rm1Run), B5_CORE_W, CS_MOVE_COST).run, vb1c = combine2(coreFull, slFromRun(vb1Run), B5_CORE_W, CS_MOVE_COST).run;
    const d13l = d13Of("LV1", cV, Wx).base.res.run;
    const q1Run = verdicts.find((v) => v.id === "Q1")?.run as SimRun, qvRun = verdicts.find((v) => v.id === "QV1")?.run as SimRun, qcRun = verdicts.find((v) => v.id === "QV1C")?.run as SimRun;
    // ---- [R5] 나란히 비교 ----
    const cmpRows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [{ nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run }, { nm: "DS13L", run: d13l }, { nm: "VB1", run: vb1Run }, { nm: "VB1C", run: vb1c }, { nm: "RM1C", run: rm1c }, { nm: "Q1", run: q1Run }, { nm: "QV1", run: qvRun }, { nm: "QV1C", run: qcRun }];
    console.log(`\n=== [R5] 같은 데이터(${PRICE_CORRECTION_ON ? "보정 적용" : "보정 미적용"} + ${ZERO_SUSPECT_ON ? "의심 종목-일 0% 처리" : "처리 없음"}) 기준 나란히 비교 (CAGR % / MDD %; 같은 구간 ${from}~; DS6·VB1C·RM1C·QV1C는 일별 40:60 재조정, DS13L은 월 1회 재조정) ===`);
    console.log(`| 구간 | ${cmpRows.map((r) => r.nm).join(" | ")} |\n|---|${cmpRows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${cmpRows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    console.log(`참고(앞선 시험 기록, 시작 2011-05-31·집계 2011-06-01~): VB1 10.07 / 64.17 · VB1C 14.23 / 48.78 · DS13L 12.15 / 37.91 — 위 표의 VB1·VB1C·DS13L은 이번 시작일(${V_START})로 다시 계산한 값이라 기록과 조금 다를 수 있다.`);
    const fl = cmpRows.map((r) => ({ nm: r.nm, s: h.st(r.run, Wx.FULL) }));
    console.log(`\n=== [R6] 연 회전율 % / 비용 합계 %(연속) ===\n${fl.map((x) => `${x.nm} ${f2(x.s.turnover)} / ${f2(x.s.cost)}`).join(" | ")}`);
    // ---- [R3] 연도별 069500·DS6·DS13L 대비 ----
    const bh = BH_FROM(from);
    for (const [nm, run] of [["Q1", q1Run], ["QV1", qvRun], ["QV1C", qcRun]] as [string, SimRun][]) {
      console.log(`\n=== [R3] ${nm} 연도별 수익률 % ===\n| 연도 | 069500 | DS6 | DS13L | ${nm} | ${nm} − 069500 %p | ${nm} − DS6 %p | ${nm} − DS13L %p |\n|---|---|---|---|---|---|---|---|`);
      const ex: number[][] = [[], [], []];
      for (let y = Number(from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) {
        const a = h.yearRet(bh, y), c6 = h.yearRet({ dates: b6.res.run.dates.filter((d) => d >= from), ret: b6.res.run.ret.filter((_, k) => b6.res.run.dates[k] >= from) }, y), cl = h.yearRet(d13l, y), cc = h.yearRet(run, y);
        ex[0].push(cc - a); ex[1].push(cc - c6); ex[2].push(cc - cl);
        console.log(`| ${y} | ${f2(a)} | ${f2(c6)} | ${f2(cl)} | ${f2(cc)} | ${sg(cc - a)} | ${sg(cc - c6)} | ${sg(cc - cl)} |`);
      }
      console.log(`${nm} 승·패 연수: 069500 대비 승 ${ex[0].filter((x) => x > 0).length} / 패 ${ex[0].filter((x) => x < 0).length} | DS6 대비 승 ${ex[1].filter((x) => x > 0).length} / 패 ${ex[1].filter((x) => x < 0).length} | DS13L 대비 승 ${ex[2].filter((x) => x > 0).length} / 패 ${ex[2].filter((x) => x < 0).length} (DS13L 대비 평균 ${sg(avg(ex[2]))}%p, 중앙값 ${sg(median(ex[2]))}%p)`);
    }
    // ---- [Q1] VB1 MDD 구간에서 Q1·QV1 ----
    console.log(`\n=== [Q1] VB1 MDD 구간(${win.from}~${win.to}) 구간 수익·낙폭: 품질 필터가 가치 함정 낙폭을 줄였는가(정보용) ===`);
    {
      const w = winStat(vb1Run, from, "9999-12-31");
      console.log(`VB1 연속 전체 MDD ${f2(w.mdd)}%: 고점일 ${w.peak} → 저점일 ${w.trough} (사전등록 구간 ${win.from}~${win.to}과 ${w.peak === win.from && w.trough === win.to ? "일치" : "다름"})`);
      console.log("| 전략 | 구간 복리 수익 % | 구간 내 낙폭 MDD % | 연속 전체 MDD % |\n|---|---|---|---|");
      for (const [nm, run] of [["Q1", q1Run], ["QV1", qvRun], ["QV1C", qcRun], ["VB1", vb1Run], ["VB1C", vb1c], ["DS13L", d13l], ["069500", { dates: h.bhP.dates, ret: h.bhP.ret }]] as [string, { dates: string[]; ret: number[] }][]) {
        const ws = winStat(run, win.from, win.to);
        console.log(`| ${nm} | ${f2(ws.tot)} | ${f2(ws.mdd)} | ${f2(h.st(run, Wx.FULL).mdd)} |`);
      }
    }
    // ---- [Q2] 평균 ROE·PBR · [Q3] 금융주 비중 ----
    console.log(`\n=== [Q2] 보유 종목 평균 ROE·PBR · [Q3] 금융주 비중(월말 신호일 목표 종목, 근사: 이전 목표 = 보유; 금융 = KSIC ${Q_FIN_KSIC.join("·")}) ===`);
    {
      for (const [nm, def, P0] of [["Q1", q1, Q1_P0], ["QV1", qv1, QV1_P0]] as [string, Strat<QP>, QP][]) {
        const pt = pathTgG(def, cV), rv: number[] = [], pv: number[] = [];
        let nFin = 0, nAll = 0, nSigFin = 0;
        for (const { c, t } of pt) {
          let nf = 0;
          for (const code of t.keys()) {
            const r = roeOf(code, CAL[c], P0.maxAge), x = pbrAt(c, h.byCode.get(code) as S, P0.maxAge);
            if (r.why === "ok") rv.push(r.roe as number);
            if (x.why === "ok") pv.push(x.pbr);
            nAll++; if ((Q_FIN_KSIC as readonly string[]).includes((indOf.get(code) ?? "").slice(0, 2))) { nFin++; nf++; }
          }
          if (nf > 0) nSigFin++;
        }
        console.log(`${nm}: 평균 ROE ${f2(avg(rv) * 100)}%(중앙값 ${f2(median(rv) * 100)}%, ${rv.length}건) | 평균 PBR ${f2(avg(pv))}(중앙값 ${f2(median(pv))}, ${pv.length}건) | 금융주 비중 ${f2((nFin / Math.max(nAll, 1)) * 100)}%(보유 종목-월 ${nAll}건 중 ${nFin}건, 금융주가 1개 이상인 신호일 ${nSigFin}/${pt.length})`);
      }
      const ptB = pathTgG(vb1, cV), pvB: number[] = [], rvB: number[] = [];
      let nFinB = 0, nAllB = 0;
      for (const { c, t } of ptB) for (const code of t.keys()) { const x = pbrAt(c, h.byCode.get(code) as S, VB1_P0.maxAge), r = roeOf(code, CAL[c], 400); if (x.why === "ok") pvB.push(x.pbr); if (r.why === "ok") rvB.push(r.roe as number); nAllB++; if ((Q_FIN_KSIC as readonly string[]).includes((indOf.get(code) ?? "").slice(0, 2))) nFinB++; }
      console.log(`참고 VB1: 평균 PBR ${f2(avg(pvB))}(중앙값 ${f2(median(pvB))}) | ROE가 계산되는 보유 종목만의 평균 ROE ${f2(avg(rvB) * 100)}%(${rvB.length}/${nAllB}건) | 금융주 비중 ${f2((nFinB / Math.max(nAllB, 1)) * 100)}%`);
    }
    // ---- [Q4] 삼성전자·SK하이닉스 ----
    console.log(`\n=== [Q4] Q1·QV1·QV1C의 삼성전자·SK하이닉스 보유 여부와 평균 목표 비중 ===`);
    {
      const coreRun = coreOf(2, undefined, 1, {}).run;
      for (const [nm, def, run] of [["Q1", q1, q1Run], ["QV1", qv1, qvRun]] as [string, Strat<QP>, SimRun][]) {
        const pt = pathTgG(def, cV), all = [...run.trades, ...((run as RebalRun).open ?? [])];
        for (const code of V3_WATCH) {
          let nHold = 0, wS = 0, wCore = 0;
          for (const { c, t } of pt) { const w = t.get(code) ?? 0; if (w > 0) nHold++; wS += w; const ev = [...coreRun.events].filter((e) => e.c <= c + 1).pop(); wCore += ev ? (ev.w[ev.set.indexOf(code)] ?? 0) : 0; }
          const n = pt.length, ts = all.filter((t) => t.code === code);
          console.log(`${label(code)} ${nm}: 월말 목표 보유 ${nHold}/${n}개 신호일(구간 ${ts.length}건${ts.length ? `: ${ts.map((t) => `${CAL[t.entryC]}~${t.reason === "기간 끝 평가" ? "보유 중" : CAL[t.exitC]}`).slice(0, 6).join(", ")}` : ""}) | 평균 목표 비중(계좌 기준 %): ${nm} ${f2((wS / n) * 100)}${nm === "QV1" ? ` | QV1C = 코어 40% × ${f2((wCore / n) * 100)} + 위성 60% × ${f2((wS / n) * 100)} = ${f2(0.4 * (wCore / n) * 100 + 0.6 * (wS / n) * 100)}%` : ""}`);
        }
      }
    }
    // ---- [Q5] 일간 수익률 상관계수 ----
    console.log(`\n=== [Q5] 일간 수익률 상관계수(공통 구간 ${from}~${h.dataEnd}, 정보용) ===`);
    {
      const mkSer = (name: string, r: { dates: string[]; ret: number[] }): { name: string; m: Map<string, number> } => ({ name, m: new Map(r.dates.map((d, i2) => [d, r.ret[i2]])) });
      const ser = [mkSer("Q1", q1Run), mkSer("QV1", qvRun), mkSer("VB1", vb1Run), mkSer("RM1", rm1Run), mkSer("DS13L", d13l), mkSer("QV1C", qcRun), mkSer("069500", { dates: h.bhP.dates, ret: h.bhP.ret })];
      const dd = q1Run.dates.filter((d) => d >= from && ser.every((x) => x.m.has(d)));
      const corr = (x: Map<string, number>, y: Map<string, number>): number => { const xs = dd.map((d) => x.get(d) as number), ys = dd.map((d) => y.get(d) as number), n = xs.length, mx = avg(xs), my = avg(ys); let sxy = 0, sxx = 0, syy = 0; for (let i2 = 0; i2 < n; i2++) { sxy += (xs[i2] - mx) * (ys[i2] - my); sxx += (xs[i2] - mx) ** 2; syy += (ys[i2] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
      console.log(`공통 ${dd.length}일`);
      console.log(`| | ${ser.map((x) => x.name).join(" | ")} |\n|---|${ser.map(() => "---").join("|")}|`);
      for (const x of ser) console.log(`| ${x.name} | ${ser.map((y) => f2(corr(x.m, y.m))).join(" | ")} |`);
    }
    // ---- [Q6] 하루 지연(C) ----
    console.log(`\n=== [Q6] 하루 지연(C 관문, 진입·청산·재조정 +1거래일) 연속 CAGR·MDD 변화 — 각 시험의 "지연 버전" 줄과 같은 값을 다시 모은 요약 ===`);
    {
      for (const [nm, def, P0, base] of [["Q1", q1, Q1_P0, q1Run], ["QV1", qv1, QV1_P0, qvRun]] as [string, Strat<QP>, QP, SimRun][]) {
        const dl = runS(def, P0, cV, null, { lag: 2, detail: true }), b = h.st(base, Wx.FULL), d2 = h.st(dl, Wx.FULL);
        console.log(`${nm}: 기준 ${f2(b.cagr)} / ${f2(b.mdd)} → 지연 ${f2(d2.cagr)} / ${f2(d2.mdd)} (CAGR ${sg(d2.cagr - b.cagr)}%p, MDD ${sg(d2.mdd - b.mdd)}%p)`);
      }
    }
    // ---- [Q7] TTM 계산 불가로 제외된 종목-월 비율 ----
    console.log(`\n=== [Q7] BS1 적격 종목-월 중 ROE를 못 쓰는 비율(시작일 이후 매 월말, maxAge ${Q1_P0.maxAge}일) ===`);
    {
      const why = new Map<RoeWhy, number>(), per = new Map<string, { n: number; ttmFail: number }>();
      let nAll = 0, nFail = 0;
      for (const c of monthEndIdx.filter((x) => x >= cV)) {
        const d = CAL[c], y = d.slice(0, 4), e = per.get(y) ?? { n: 0, ttmFail: 0 };
        for (const code of bsElig(c, B5_BS_P0)) {
          const r = roeOf(code, d, Q1_P0.maxAge);
          why.set(r.why, (why.get(r.why) ?? 0) + 1); nAll++; e.n++;
          if (r.why === "no_report" || r.why === "stale" || r.why === "no_annual" || r.why === "null_ni" || r.why === "null_eq") { nFail++; e.ttmFail++; }
        }
        per.set(y, e);
      }
      console.log(`전체 ${nAll}종목-월 중 TTM 계산 불가로 제외 ${nFail}건(${f2((nFail / nAll) * 100)}%) | 사유 분포 %: ${[...why.entries()].map(([k, v]) => `${k} ${f2((v / nAll) * 100)}`).join(" · ")} (ok = ROE 사용 가능, eq_nonpos·ttm_nonpos = 자본 ≤ 0·적자로 정의상 제외)`);
      console.log(`연도별 TTM 계산 불가 비율 %: ${[...per.entries()].sort().map(([y, e]) => `${y} ${f2((e.ttmFail / Math.max(e.n, 1)) * 100)}`).join(" · ")}`);
    }
  } else if (MODE === "htest") {
    if (!PRICE_CORRECTION_ON || !ZERO_SUSPECT_ON) throw new Error("보정 또는 의심 종목-일 0% 처리 미적용(correct=k200p17 zero=1 필요) — 시험하지 않고 중단해 보고한다");
    console.log(`52주 신고가 근접 시험 설정: 데이터: K200P 17건 보정 적용 + 의심 종목-일 0% 처리 ${suspectLog.length}건(보정 후보 A), 소멸 관례 vbVanishLoss(VB·VL·Q와 같음)`);
    const hm1 = mkHM("HM1", HM1_P0, HM1_NB);
    const cH = startOf(hm1, false), Wx = windowsFor(cH), from = Wx.FULL.from;
    if (cH !== startOf(RM1, false)) throw new Error(`HM1 첫 신호일 ${CAL[cH]} ≠ RM1 첫 신호일 — 중단`);
    const sigSet = new Set(monthEndIdx.filter((c) => c > cH).map((c) => CAL[c]));
    console.log(`연속 평가 공통: 첫 신호일 ${CAL[cH]}, 수익률 집계 ${from}~${h.dataEnd} | 구간 ${Wx.NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(HM1, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkS(hm1, "HM1", trial, false, cH, Wx, "HM1: K200P(PIT) 종목 중 종가 ÷ 직전 252거래일 최고 종가(당일 제외) 상위 20종목 동일 비중(1/20), 기존 보유는 순위 40위 안이면 유지, 월말 신호·다음 거래일 종가 체결, 현금 없이 전량 투자")));
    }
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(HM1C, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkC(hm1, "HM1C", trial, cH, Wx, "HM1C: DS6 코어 40% + 위성 60% = HM1, 월 리밸런스", sigSet)));
    }
    // ---- 기준 실행(보고용) ----
    const win = V3_MDD_WINDOW;
    const rm1Run = runS(RM1, RM1.P0, cH, null, { lag: 1, detail: true });
    const coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, from);
    const rm1c = combine2(coreFull, slFromRun(rm1Run), B5_CORE_W, CS_MOVE_COST).run;
    const d13l = d13Of("LV1", cH, Wx).base.res.run;
    const hmRun = verdicts.find((v) => v.id === "HM1")?.run as SimRun, hcRun = verdicts.find((v) => v.id === "HM1C")?.run as SimRun;
    // ---- [R5] 나란히 비교 ----
    const cmpRows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [{ nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run }, { nm: "DS13L", run: d13l }, { nm: "RM1C", run: rm1c }, { nm: "HM1", run: hmRun }, { nm: "HM1C", run: hcRun }];
    console.log(`\n=== [R5] 같은 데이터(보정 적용 + 의심 종목-일 0% 처리) 기준 나란히 비교 (CAGR % / MDD %; 같은 구간 ${from}~; DS6·RM1C는 일별 40:60 재조정, DS13L·HM1C는 월 1회 재조정) ===`);
    console.log(`| 구간 | ${cmpRows.map((r) => r.nm).join(" | ")} |\n|---|${cmpRows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${cmpRows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    console.log(`참고(앞선 시험 기록, 시작 2011-05-31·집계 2011-06-01~, 일별 재조정): VB1 10.07 / 64.17 · VB1C 14.23 / 48.78 · DS13L 12.15 / 37.91 — 시작일이 달라 위 표와 직접 비교하지 않는다.`);
    const fl = cmpRows.map((r) => ({ nm: r.nm, s: h.st(r.run, Wx.FULL) }));
    console.log(`\n=== [R6] 연 회전율 % / 비용 합계 %(연속) ===\n${fl.map((x) => `${x.nm} ${f2(x.s.turnover)} / ${f2(x.s.cost)}`).join(" | ")}`);
    // ---- [R3] 연도별 069500·DS6·DS13L 대비 ----
    const bh = BH_FROM(from);
    for (const [nm, run] of [["HM1", hmRun], ["HM1C", hcRun]] as [string, SimRun][]) {
      console.log(`\n=== [R3] ${nm} 연도별 수익률 % ===\n| 연도 | 069500 | DS6 | DS13L | ${nm} | ${nm} − 069500 %p | ${nm} − DS6 %p | ${nm} − DS13L %p |\n|---|---|---|---|---|---|---|---|`);
      const ex: number[][] = [[], [], []];
      for (let y = Number(from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) {
        const a = h.yearRet(bh, y), c6 = h.yearRet({ dates: b6.res.run.dates.filter((d) => d >= from), ret: b6.res.run.ret.filter((_, k) => b6.res.run.dates[k] >= from) }, y), cl = h.yearRet(d13l, y), cc = h.yearRet(run, y);
        ex[0].push(cc - a); ex[1].push(cc - c6); ex[2].push(cc - cl);
        console.log(`| ${y} | ${f2(a)} | ${f2(c6)} | ${f2(cl)} | ${f2(cc)} | ${sg(cc - a)} | ${sg(cc - c6)} | ${sg(cc - cl)} |`);
      }
      console.log(`${nm} 승·패 연수: 069500 대비 승 ${ex[0].filter((x) => x > 0).length} / 패 ${ex[0].filter((x) => x < 0).length} (평균 ${sg(avg(ex[0]))}%p, 중앙값 ${sg(median(ex[0]))}%p) | DS6 대비 승 ${ex[1].filter((x) => x > 0).length} / 패 ${ex[1].filter((x) => x < 0).length} (평균 ${sg(avg(ex[1]))}%p) | DS13L 대비 승 ${ex[2].filter((x) => x > 0).length} / 패 ${ex[2].filter((x) => x < 0).length} (평균 ${sg(avg(ex[2]))}%p, 중앙값 ${sg(median(ex[2]))}%p)`);
    }
    // ---- [H1] 삼성전자·SK하이닉스 ----
    console.log(`\n=== [H1] HM1·HM1C의 삼성전자·SK하이닉스 보유 여부와 평균 목표 비중 ===`);
    {
      const coreRun = coreOf(2, undefined, 1, {}).run, pt = pathTgG(hm1, cH), all = [...hmRun.trades, ...((hmRun as RebalRun).open ?? [])];
      for (const code of V3_WATCH) {
        let nHold = 0, wS = 0, wCore = 0;
        for (const { c, t } of pt) { const w = t.get(code) ?? 0; if (w > 0) nHold++; wS += w; const ev = [...coreRun.events].filter((e) => e.c <= c + 1).pop(); wCore += ev ? (ev.w[ev.set.indexOf(code)] ?? 0) : 0; }
        const n = pt.length, ts = all.filter((t) => t.code === code);
        console.log(`${label(code)} HM1: 월말 목표 보유 ${nHold}/${n}개 신호일(구간 ${ts.length}건${ts.length ? `: ${ts.map((t) => `${CAL[t.entryC]}~${t.reason === "기간 끝 평가" ? "보유 중" : CAL[t.exitC]}`).slice(0, 6).join(", ")}` : ""}) | 평균 목표 비중(계좌 기준 %): HM1 ${f2((wS / n) * 100)} | HM1C = 코어 40% × ${f2((wCore / n) * 100)} + 위성 60% × ${f2((wS / n) * 100)} = ${f2(0.4 * (wCore / n) * 100 + 0.6 * (wS / n) * 100)}%`);
      }
    }
    // ---- [H2] 일간 수익률 상관계수 ----
    console.log(`\n=== [H2] 일간 수익률 상관계수(공통 구간 ${from}~${h.dataEnd}, 정보용) ===`);
    {
      const mkSer = (name: string, r: { dates: string[]; ret: number[] }): { name: string; m: Map<string, number> } => ({ name, m: new Map(r.dates.map((d, i2) => [d, r.ret[i2]])) });
      const ser = [mkSer("HM1", hmRun), mkSer("HM1C", hcRun), mkSer("RM1", rm1Run), mkSer("DS13L", d13l), mkSer("DS6", b6.res.run), mkSer("069500", { dates: h.bhP.dates, ret: h.bhP.ret })];
      const dd = hmRun.dates.filter((d) => d >= from && ser.every((x) => x.m.has(d)));
      const corr = (x: Map<string, number>, y: Map<string, number>): number => { const xs = dd.map((d) => x.get(d) as number), ys = dd.map((d) => y.get(d) as number), n = xs.length, mx = avg(xs), my = avg(ys); let sxy = 0, sxx = 0, syy = 0; for (let i2 = 0; i2 < n; i2++) { sxy += (xs[i2] - mx) * (ys[i2] - my); sxx += (xs[i2] - mx) ** 2; syy += (ys[i2] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
      console.log(`공통 ${dd.length}일`);
      console.log(`| | ${ser.map((x) => x.name).join(" | ")} |\n|---|${ser.map(() => "---").join("|")}|`);
      for (const x of ser) console.log(`| ${x.name} | ${ser.map((y) => f2(corr(x.m, y.m))).join(" | ")} |`);
    }
    // ---- [H3] VB1 MDD 구간 ----
    console.log(`\n=== [H3] VB1 MDD 구간(${win.from}~${win.to}) 구간 수익·낙폭(정보용; VB1 앞선 기록: 구간 복리 -63.31% / MDD 64.17%, VB1C -47.89% / 48.78%) ===`);
    {
      console.log("| 전략 | 구간 복리 수익 % | 구간 내 낙폭 MDD % | 연속 전체 MDD % |\n|---|---|---|---|");
      for (const r of cmpRows) { const ws = winStat(r.run, win.from, win.to); console.log(`| ${r.nm} | ${f2(ws.tot)} | ${f2(ws.mdd)} | ${f2(h.st(r.run, Wx.FULL).mdd)} |`); }
    }
    // ---- [H4] 하루 지연(C) ----
    console.log(`\n=== [H4] 하루 지연(C 관문, 진입·청산·재조정 +1거래일) 연속 CAGR·MDD 변화 — 각 시험의 "지연 버전" 줄과 같은 값을 다시 모은 요약 ===`);
    {
      const dl = runS(hm1, HM1_P0, cH, null, { lag: 2, detail: true }), b = h.st(hmRun, Wx.FULL), d2 = h.st(dl, Wx.FULL);
      console.log(`HM1: 기준 ${f2(b.cagr)} / ${f2(b.mdd)} → 지연 ${f2(d2.cagr)} / ${f2(d2.mdd)} (CAGR ${sg(d2.cagr - b.cagr)}%p, MDD ${sg(d2.mdd - b.mdd)}%p)`);
      const dlC = combineN([sliceSl(coreOf(2, undefined, 2, {}).sl, from), slFromRun(dl)], [B5_CORE_W, 1 - B5_CORE_W], CS_MOVE_COST, sigSet).run, bc = h.st(hcRun, Wx.FULL), dc = h.st(dlC, Wx.FULL);
      console.log(`HM1C: 기준 ${f2(bc.cagr)} / ${f2(bc.mdd)} → 지연 ${f2(dc.cagr)} / ${f2(dc.mdd)} (CAGR ${sg(dc.cagr - bc.cagr)}%p, MDD ${sg(dc.mdd - bc.mdd)}%p)`);
    }
  } else if (MODE === "mtest") {
    if (!PRICE_CORRECTION_ON || !ZERO_SUSPECT_ON) throw new Error("보정 또는 의심 종목-일 0% 처리 미적용(correct=k200p17 zero=1 필요) — 시험하지 않고 중단해 보고한다");
    console.log(`시총 상위 5종목 시험 설정: 데이터: K200P 17건 보정 적용 + 의심 종목-일 0% 처리 ${suspectLog.length}건(보정 후보 A), 소멸 관례 vbVanishLoss(VB·VL·Q·HM과 같음)`);
    const tc1 = mkTC("TC1", TC1_P0, TC1_NB, false), tc2 = mkTC("TC2", TC2_P0, TC2_NB, true);
    const cT = startOf(tc1, false), Wx = windowsFor(cT), from = Wx.FULL.from;
    if (cT !== startOf(tc2, false) || cT !== startOf(RM1, false)) throw new Error(`TC1·TC2·RM1 첫 신호일 불일치 — 중단`);
    console.log(`연속 평가 공통: 첫 신호일 ${CAL[cT]}, 수익률 집계 ${from}~${h.dataEnd} | 구간 ${Wx.NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(TC1, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkS(tc1, "TC1", trial, false, cT, Wx, "TC1: 매월 말 종가 기준 K200P(PIT) 시총 상위 5종목 동일 비중(1/5), 다음 거래일 종가 체결, 전량 투자")));
    }
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(TC2, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkS(tc2, "TC2", trial, false, cT, Wx, "TC2: TC1과 같은 5종목(월말 결정), 종가가 200일 이동평균 위인 종목만 보유(매일 종가 확인·다음 거래일 종가 체결), 미충족 비중은 현금")));
    }
    // ---- 기준 실행(보고용) ----
    const win = V3_MDD_WINDOW;
    const rt0Run = runS(RT0, RT0.P0, cT, null, { lag: 1 }), d13l = d13Of("LV1", cT, Wx).base.res.run;
    const t1Run = verdicts.find((v) => v.id === "TC1")?.run as SimRun, t2Run = verdicts.find((v) => v.id === "TC2")?.run as SimRun;
    // ---- [R5] 나란히 비교 ----
    const cmpRows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [{ nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run }, { nm: "DS13L", run: d13l }, { nm: "K200P 시총 비중", run: rt0Run }, { nm: "TC1", run: t1Run }, { nm: "TC2", run: t2Run }];
    console.log(`\n=== [R5] 같은 데이터(보정 적용 + 의심 종목-일 0% 처리) 기준 나란히 비교 (CAGR % / MDD %; 같은 구간 ${from}~; DS6는 일별 재조정, DS13L은 월 1회 재조정, K200P 시총 비중 = RT0 종목당 상한 30% 월말 재조정; 시험과 같은 데이터 기준 값이며 사용자 참고값 ${M_REF_CAPW_USER.cagr} / ${M_REF_CAPW_USER.mdd}와 차이가 있다 — 참고값은 가격 보정 적용 전 기록으로 추정) ===`);
    console.log(`| 구간 | ${cmpRows.map((r) => r.nm).join(" | ")} |\n|---|${cmpRows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${cmpRows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    const fl = cmpRows.map((r) => ({ nm: r.nm, s: h.st(r.run, Wx.FULL) }));
    console.log(`\n=== [R6] 연 회전율 % / 비용 합계 %(연속) ===\n${fl.map((x) => `${x.nm} ${f2(x.s.turnover)} / ${f2(x.s.cost)}`).join(" | ")}`);
    // ---- [R3] 연도별 069500·DS6·DS13L 대비 ----
    const bh = BH_FROM(from);
    for (const [nm, run] of [["TC1", t1Run], ["TC2", t2Run]] as [string, SimRun][]) {
      console.log(`\n=== [R3] ${nm} 연도별 수익률 % ===\n| 연도 | 069500 | DS6 | DS13L | ${nm} | ${nm} − 069500 %p | ${nm} − DS6 %p | ${nm} − DS13L %p |\n|---|---|---|---|---|---|---|---|`);
      const ex: number[][] = [[], [], []];
      for (let y = Number(from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) {
        const a = h.yearRet(bh, y), c6 = h.yearRet({ dates: b6.res.run.dates.filter((d) => d >= from), ret: b6.res.run.ret.filter((_, k) => b6.res.run.dates[k] >= from) }, y), cl = h.yearRet(d13l, y), cc = h.yearRet(run, y);
        ex[0].push(cc - a); ex[1].push(cc - c6); ex[2].push(cc - cl);
        console.log(`| ${y} | ${f2(a)} | ${f2(c6)} | ${f2(cl)} | ${f2(cc)} | ${sg(cc - a)} | ${sg(cc - c6)} | ${sg(cc - cl)} |`);
      }
      console.log(`${nm} 승·패 연수: 069500 대비 승 ${ex[0].filter((x) => x > 0).length} / 패 ${ex[0].filter((x) => x < 0).length} (평균 ${sg(avg(ex[0]))}%p, 중앙값 ${sg(median(ex[0]))}%p) | DS6 대비 승 ${ex[1].filter((x) => x > 0).length} / 패 ${ex[1].filter((x) => x < 0).length} (평균 ${sg(avg(ex[1]))}%p) | DS13L 대비 승 ${ex[2].filter((x) => x > 0).length} / 패 ${ex[2].filter((x) => x < 0).length} (평균 ${sg(avg(ex[2]))}%p, 중앙값 ${sg(median(ex[2]))}%p)`);
    }
    // ---- [M1] 삼성전자·SK하이닉스 평균 목표 비중 ----
    console.log(`\n=== [M1] TC1·TC2의 삼성전자·SK하이닉스 평균 목표 비중(계좌 기준 %, 첫 신호일부터 매 거래일 (그룹 ∧ 조건)이면 1/5, 아니면 0의 평균; 비중 표류·체결 지연 무시) ===`);
    for (const code of V3_WATCH) {
      const gDays = (() => { let n = 0; for (let c = cT; c < CAL.length; c++) if (tcGroup(c, TC1_P0).some((s) => s.code === code)) n++; return n; })();
      console.log(`${label(code)}: TC1 ${f2(tcAvgW(code, TC1_P0, cT) * 100)} | TC2 ${f2(tcAvgW(code, TC2_P0, cT) * 100)} (시총 상위 5 그룹에 있던 날 ${gDays}/${CAL.length - cT}일 = ${f2((gDays / (CAL.length - cT)) * 100)}%)`);
    }
    // ---- [M3] VB1 MDD 구간 ----
    console.log(`\n=== [M3] VB1 MDD 구간(${win.from}~${win.to}) 구간 수익·낙폭(정보용; VB1 앞선 기록: 구간 복리 -63.31% / MDD 64.17%, VB1C -47.89% / 48.78%) ===`);
    {
      console.log("| 전략 | 구간 복리 수익 % | 구간 내 낙폭 MDD % | 연속 전체 MDD % |\n|---|---|---|---|");
      for (const r of cmpRows) { const ws = winStat(r.run, win.from, win.to); console.log(`| ${r.nm} | ${f2(ws.tot)} | ${f2(ws.mdd)} | ${f2(h.st(r.run, Wx.FULL).mdd)} |`); }
    }
    // ---- [M4] 하루 지연(C) ----
    console.log(`\n=== [M4] 하루 지연(C 관문, 진입·청산·재조정 +1거래일) 연속 CAGR·MDD 변화 — 각 시험의 "지연 버전" 줄과 같은 값을 다시 모은 요약 ===`);
    for (const [nm, def, P0, base] of [["TC1", tc1, TC1_P0, t1Run], ["TC2", tc2, TC2_P0, t2Run]] as [string, Strat<TcP>, TcP, SimRun][]) {
      const dl = runS(def, P0, cT, null, { lag: 2, detail: true }), b = h.st(base, Wx.FULL), d2 = h.st(dl, Wx.FULL);
      console.log(`${nm}: 기준 ${f2(b.cagr)} / ${f2(b.mdd)} → 지연 ${f2(d2.cagr)} / ${f2(d2.mdd)} (CAGR ${sg(d2.cagr - b.cagr)}%p, MDD ${sg(d2.mdd - b.mdd)}%p)`);
    }

  } else if (MODE === "etest") {
    await loadEqTables();
    await loadRoe();
    requireStart();
    if (!PRICE_CORRECTION_ON || !ZERO_SUSPECT_ON) throw new Error("보정 또는 의심 종목-일 0% 처리 미적용(correct=k200p17 zero=1 필요) — 시험하지 않고 중단해 보고한다");
    if (V_START !== E_PLANNED_START) throw new Error(`V_START=${V_START} ≠ 사전등록 ${E_PLANNED_START} — 중단`);
    console.log(`이익수익률 시험 설정: ${V_CASE}, 시작 월말 ${V_START}, 데이터: K200P 17건 보정 적용 + 의심 종목-일 0% 처리 ${suspectLog.length}건(보정 후보 A), 소멸 관례 vbVanishLoss`);
    const ey1 = mkEY("EY1", EY1_P0, EY1_NB), vb1 = mkVB("VB1", VB1_P0, VB1_NB), qv1 = mkQ("QV1", QV1_P0, QV1_NB);
    const cV = startOf(ey1, false), Wx = windowsV(cV), from = Wx.FULL.from;
    const sigSet = new Set(monthEndIdx.filter((c) => c > cV).map((c) => CAL[c]));
    console.log(`연속 평가 공통: 첫 신호일 ${CAL[cV]}, 수익률 집계 ${from}~${h.dataEnd} | 구간 ${Wx.NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(EY1, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkS(ey1, "EY1", trial, false, cV, Wx, "EY1: BS1 적격 ∧ TTM 순이익 > 0 ∧ 자본 > 0 종목 중 이익수익률(TTM 순이익 ÷ 시가총액) 상위 30종목 동일 비중(1/30), 기존 보유는 순위 60위 안이면 유지, 월말 신호·다음 거래일 종가 체결")));
    }
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(EY1C, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkC(ey1, "EY1C", trial, cV, Wx, "EY1C: DS6 코어 40% + 위성 60% = EY1, 월 리밸런스", sigSet)));
    }
    // ---- 기준 실행(보고용) ----
    const win = V3_MDD_WINDOW;
    const vb1Run = runS(vb1, VB1_P0, cV, null, { lag: 1, detail: true }), qvRun = runS(qv1, QV1_P0, cV, null, { lag: 1, detail: true }), d13l = d13Of("LV1", cV, Wx).base.res.run;
    const coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, from), vb1c = combine2(coreFull, slFromRun(vb1Run), B5_CORE_W, CS_MOVE_COST).run;
    const eyRun = verdicts.find((v) => v.id === "EY1")?.run as SimRun, ecRun = verdicts.find((v) => v.id === "EY1C")?.run as SimRun;
    // ---- [R5] 나란히 비교 ----
    const cmpRows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [{ nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run }, { nm: "DS13L", run: d13l }, { nm: "VB1", run: vb1Run }, { nm: "VB1C", run: vb1c }, { nm: "QV1", run: qvRun }, { nm: "EY1", run: eyRun }, { nm: "EY1C", run: ecRun }];
    console.log(`\n=== [R5] 같은 데이터(보정 적용 + 의심 종목-일 0% 처리) 기준 나란히 비교 (CAGR % / MDD %; 같은 구간 ${from}~; DS6·VB1C는 일별 40:60 재조정, DS13L·EY1C는 월 1회 재조정) ===`);
    console.log(`| 구간 | ${cmpRows.map((r) => r.nm).join(" | ")} |\n|---|${cmpRows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${cmpRows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    const fl = cmpRows.map((r) => ({ nm: r.nm, s: h.st(r.run, Wx.FULL) }));
    console.log(`\n=== [R6] 연 회전율 % / 비용 합계 %(연속) ===\n${fl.map((x) => `${x.nm} ${f2(x.s.turnover)} / ${f2(x.s.cost)}`).join(" | ")}`);
    // ---- [R3] 연도별 069500·DS6·DS13L 대비 ----
    const bh = BH_FROM(from);
    for (const [nm, run] of [["EY1", eyRun], ["EY1C", ecRun]] as [string, SimRun][]) {
      console.log(`\n=== [R3] ${nm} 연도별 수익률 % ===\n| 연도 | 069500 | DS6 | DS13L | ${nm} | ${nm} − 069500 %p | ${nm} − DS6 %p | ${nm} − DS13L %p |\n|---|---|---|---|---|---|---|---|`);
      const ex: number[][] = [[], [], []];
      for (let y = Number(from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) {
        const a = h.yearRet(bh, y), c6 = h.yearRet({ dates: b6.res.run.dates.filter((d) => d >= from), ret: b6.res.run.ret.filter((_, k) => b6.res.run.dates[k] >= from) }, y), cl = h.yearRet(d13l, y), cc = h.yearRet(run, y);
        ex[0].push(cc - a); ex[1].push(cc - c6); ex[2].push(cc - cl);
        console.log(`| ${y} | ${f2(a)} | ${f2(c6)} | ${f2(cl)} | ${f2(cc)} | ${sg(cc - a)} | ${sg(cc - c6)} | ${sg(cc - cl)} |`);
      }
      console.log(`${nm} 승·패 연수: 069500 대비 승 ${ex[0].filter((x) => x > 0).length} / 패 ${ex[0].filter((x) => x < 0).length} (평균 ${sg(avg(ex[0]))}%p, 중앙값 ${sg(median(ex[0]))}%p) | DS6 대비 승 ${ex[1].filter((x) => x > 0).length} / 패 ${ex[1].filter((x) => x < 0).length} (평균 ${sg(avg(ex[1]))}%p) | DS13L 대비 승 ${ex[2].filter((x) => x > 0).length} / 패 ${ex[2].filter((x) => x < 0).length} (평균 ${sg(avg(ex[2]))}%p, 중앙값 ${sg(median(ex[2]))}%p)`);
    }
    // ---- [E1] 보유 종목 평균 PER·PBR · [E2] 금융주 비중 ----
    console.log(`\n=== [E1] 보유 종목 평균 PER·PBR · [E2] 금융주 비중(월말 신호일 목표 종목, 근사: 이전 목표 = 보유; 금융 = KSIC ${Q_FIN_KSIC.join("·")}) ===`);
    {
      const pt = pathTgG(ey1, cV), per: number[] = [], pb: number[] = [], eyv: number[] = [];
      let nFin = 0, nAll = 0, nSigFin = 0;
      for (const { c, t } of pt) {
        let nf = 0;
        for (const code of t.keys()) {
          const r = roeOf(code, CAL[c], EY1_P0.maxAge), s = h.byCode.get(code) as S, i = s.idx.get(CAL[c]), x = pbrAt(c, s, EY1_P0.maxAge);
          if (r.why === "ok" && i !== undefined) { const mc = s.mcapRow[i] * 1e8; per.push(mc / (r.ttm as number)); eyv.push((r.ttm as number) / mc); }
          if (x.why === "ok") pb.push(x.pbr);
          nAll++; if ((Q_FIN_KSIC as readonly string[]).includes((indOf.get(code) ?? "").slice(0, 2))) { nFin++; nf++; }
        }
        if (nf > 0) nSigFin++;
      }
      console.log(`EY1: 평균 PER ${f2(avg(per))}(중앙값 ${f2(median(per))}, ${per.length}건) | 평균 이익수익률 ${f2(avg(eyv) * 100)}%(중앙값 ${f2(median(eyv) * 100)}%) | 평균 PBR ${f2(avg(pb))}(중앙값 ${f2(median(pb))}, ${pb.length}건) | 금융주 비중 ${f2((nFin / Math.max(nAll, 1)) * 100)}%(보유 종목-월 ${nAll}건 중 ${nFin}건, 금융주가 1개 이상인 신호일 ${nSigFin}/${pt.length})`);
      const ptB = pathTgG(vb1, cV), pvB: number[] = [], perB: number[] = [];
      let nFinB = 0, nAllB = 0;
      for (const { c, t } of ptB) for (const code of t.keys()) { const x = pbrAt(c, h.byCode.get(code) as S, VB1_P0.maxAge), r = roeOf(code, CAL[c], 400), s = h.byCode.get(code) as S, i = s.idx.get(CAL[c]); if (x.why === "ok") pvB.push(x.pbr); if (r.why === "ok" && i !== undefined) perB.push((s.mcapRow[i] * 1e8) / (r.ttm as number)); nAllB++; if ((Q_FIN_KSIC as readonly string[]).includes((indOf.get(code) ?? "").slice(0, 2))) nFinB++; }
      console.log(`참고 VB1: 평균 PBR ${f2(avg(pvB))}(중앙값 ${f2(median(pvB))}) | TTM 흑자 종목만의 평균 PER ${f2(avg(perB))}(중앙값 ${f2(median(perB))}, ${perB.length}/${nAllB}건) | 금융주 비중 ${f2((nFinB / Math.max(nAllB, 1)) * 100)}%`);
    }
    // ---- [E3] 삼성전자·SK하이닉스 ----
    console.log(`\n=== [E3] EY1·EY1C의 삼성전자·SK하이닉스 보유 여부와 평균 목표 비중 ===`);
    {
      const coreRun = coreOf(2, undefined, 1, {}).run, pt = pathTgG(ey1, cV), all = [...eyRun.trades, ...((eyRun as RebalRun).open ?? [])];
      for (const code of V3_WATCH) {
        let nHold = 0, wS = 0, wCore = 0;
        for (const { c, t } of pt) { const w = t.get(code) ?? 0; if (w > 0) nHold++; wS += w; const ev = [...coreRun.events].filter((e) => e.c <= c + 1).pop(); wCore += ev ? (ev.w[ev.set.indexOf(code)] ?? 0) : 0; }
        const n = pt.length, ts = all.filter((t) => t.code === code);
        console.log(`${label(code)} EY1: 월말 목표 보유 ${nHold}/${n}개 신호일(구간 ${ts.length}건${ts.length ? `: ${ts.map((t) => `${CAL[t.entryC]}~${t.reason === "기간 끝 평가" ? "보유 중" : CAL[t.exitC]}`).slice(0, 6).join(", ")}` : ""}) | 평균 목표 비중(계좌 기준 %): EY1 ${f2((wS / n) * 100)} | EY1C = 코어 40% × ${f2((wCore / n) * 100)} + 위성 60% × ${f2((wS / n) * 100)} = ${f2(0.4 * (wCore / n) * 100 + 0.6 * (wS / n) * 100)}%`);
      }
    }
    // ---- [E4] 일간 수익률 상관계수 ----
    console.log(`\n=== [E4] 일간 수익률 상관계수(공통 구간 ${from}~${h.dataEnd}, 정보용) ===`);
    {
      const mkSer = (name: string, r: { dates: string[]; ret: number[] }): { name: string; m: Map<string, number> } => ({ name, m: new Map(r.dates.map((d, i2) => [d, r.ret[i2]])) });
      const ser = [mkSer("EY1", eyRun), mkSer("EY1C", ecRun), mkSer("VB1", vb1Run), mkSer("QV1", qvRun), mkSer("DS13L", d13l), mkSer("DS6", b6.res.run), mkSer("069500", { dates: h.bhP.dates, ret: h.bhP.ret })];
      const dd = eyRun.dates.filter((d) => d >= from && ser.every((x) => x.m.has(d)));
      const corr = (x: Map<string, number>, y: Map<string, number>): number => { const xs = dd.map((d) => x.get(d) as number), ys = dd.map((d) => y.get(d) as number), n = xs.length, mx = avg(xs), my = avg(ys); let sxy = 0, sxx = 0, syy = 0; for (let i2 = 0; i2 < n; i2++) { sxy += (xs[i2] - mx) * (ys[i2] - my); sxx += (xs[i2] - mx) ** 2; syy += (ys[i2] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
      console.log(`공통 ${dd.length}일`);
      console.log(`| | ${ser.map((x) => x.name).join(" | ")} |\n|---|${ser.map(() => "---").join("|")}|`);
      for (const x of ser) console.log(`| ${x.name} | ${ser.map((y) => f2(corr(x.m, y.m))).join(" | ")} |`);
    }
    // ---- [E5] VB1 MDD 구간 ----
    console.log(`\n=== [E5] VB1 MDD 구간(${win.from}~${win.to}) 구간 수익·낙폭(정보용) ===`);
    {
      console.log("| 전략 | 구간 복리 수익 % | 구간 내 낙폭 MDD % | 연속 전체 MDD % |\n|---|---|---|---|");
      for (const r of cmpRows) { const ws = winStat(r.run, win.from, win.to); console.log(`| ${r.nm} | ${f2(ws.tot)} | ${f2(ws.mdd)} | ${f2(h.st(r.run, Wx.FULL).mdd)} |`); }
    }
    // ---- [E6] 하루 지연(C) ----
    console.log(`\n=== [E6] 하루 지연(C 관문, 진입·청산·재조정 +1거래일) 연속 CAGR·MDD 변화 — 각 시험의 "지연 버전" 줄과 같은 값을 다시 모은 요약 ===`);
    {
      const dl = runS(ey1, EY1_P0, cV, null, { lag: 2, detail: true }), b = h.st(eyRun, Wx.FULL), d2 = h.st(dl, Wx.FULL);
      console.log(`EY1: 기준 ${f2(b.cagr)} / ${f2(b.mdd)} → 지연 ${f2(d2.cagr)} / ${f2(d2.mdd)} (CAGR ${sg(d2.cagr - b.cagr)}%p, MDD ${sg(d2.mdd - b.mdd)}%p)`);
      const dlC = combineN([sliceSl(coreOf(2, undefined, 2, {}).sl, from), slFromRun(dl)], [B5_CORE_W, 1 - B5_CORE_W], CS_MOVE_COST, sigSet).run, bc = h.st(ecRun, Wx.FULL), dc = h.st(dlC, Wx.FULL);
      console.log(`EY1C: 기준 ${f2(bc.cagr)} / ${f2(bc.mdd)} → 지연 ${f2(dc.cagr)} / ${f2(dc.mdd)} (CAGR ${sg(dc.cagr - bc.cagr)}%p, MDD ${sg(dc.mdd - bc.mdd)}%p)`);
    }
    // ---- [E7] TTM 계산 불가로 제외된 종목-월 비율 ----
    console.log(`\n=== [E7] BS1 적격 종목-월 중 TTM 순이익을 못 쓰는 비율(시작일 이후 매 월말, maxAge ${EY1_P0.maxAge}일) ===`);
    {
      const why = new Map<RoeWhy, number>(), per = new Map<string, { n: number; ttmFail: number }>();
      let nAll = 0, nFail = 0;
      for (const c of monthEndIdx.filter((x) => x >= cV)) {
        const d = CAL[c], y = d.slice(0, 4), e = per.get(y) ?? { n: 0, ttmFail: 0 };
        for (const code of bsElig(c, B5_BS_P0)) {
          const r = roeOf(code, d, EY1_P0.maxAge);
          why.set(r.why, (why.get(r.why) ?? 0) + 1); nAll++; e.n++;
          if (r.why === "no_report" || r.why === "stale" || r.why === "no_annual" || r.why === "null_ni" || r.why === "null_eq") { nFail++; e.ttmFail++; }
        }
        per.set(y, e);
      }
      console.log(`전체 ${nAll}종목-월 중 TTM 계산 불가로 제외 ${nFail}건(${f2((nFail / nAll) * 100)}%) | 사유 분포 %: ${[...why.entries()].map(([k, v]) => `${k} ${f2((v / nAll) * 100)}`).join(" · ")} (ok = 사용 가능, eq_nonpos·ttm_nonpos = 자본 ≤ 0·적자로 정의상 제외)`);
      console.log(`연도별 TTM 계산 불가 비율 %: ${[...per.entries()].sort().map(([y, e]) => `${y} ${f2((e.ttmFail / Math.max(e.n, 1)) * 100)}`).join(" · ")}`);
    }

  } else if (MODE === "stest") {
    if (!PRICE_CORRECTION_ON || !ZERO_SUSPECT_ON) throw new Error("보정 또는 의심 종목-일 0% 처리 미적용(correct=k200p17 zero=1 필요) — 시험하지 않고 중단해 보고한다");
    console.log(`잔차 모멘텀 손절 시험 설정: 데이터: K200P 17건 보정 적용 + 의심 종목-일 0% 처리 ${suspectLog.length}건(보정 후보 A), 소멸 관례 RM1과 같음(마지막 종가 청산)`);
    const rms = mkRMS("RM1S", RM1S_P0, RM1S_NB);
    const cS = startOf(rms, false), Wx = windowsFor(cS), from = Wx.FULL.from;
    if (cS !== startOf(RM1, false)) throw new Error(`RM1S 첫 신호일 ${CAL[cS]} ≠ RM1 — 중단`);
    const sigSet = new Set(monthEndIdx.filter((c) => c > cS).map((c) => CAL[c]));
    console.log(`연속 평가 공통: 첫 신호일 ${CAL[cS]}, 수익률 집계 ${from}~${h.dataEnd} | 구간 ${Wx.NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(RM1S, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkS(rms, "RM1S", trial, false, cS, Wx, "RM1S: RM1(K200P 잔차 모멘텀 상위 20 동일 비중, 유지 순위 40, 월 리밸런스)과 같고, 보유 종목 종가가 진입 후 최고 종가 대비 -20% 이하면 다음 거래일 종가에 전량 매도(현금), 다음 월말 전까지 재진입·재배분 없음")));
    }
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(RM1SC, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkC(rms, "RM1SC", trial, cS, Wx, "RM1SC: DS6 코어 40% + 위성 60% = RM1S, 월 리밸런스", sigSet)));
    }
    // ---- 기준 실행(보고용) ----
    const win = V3_MDD_WINDOW;
    const rm1Run = runS(RM1, RM1.P0, cS, null, { lag: 1, detail: true }), d13l = d13Of("LV1", cS, Wx).base.res.run;
    const coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, from), rm1c = combine2(coreFull, slFromRun(rm1Run), B5_CORE_W, CS_MOVE_COST).run;
    const sRun = verdicts.find((v) => v.id === "RM1S")?.run as SimRun, scRun = verdicts.find((v) => v.id === "RM1SC")?.run as SimRun;
    // ---- [R5] 나란히 비교 ----
    const cmpRows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [{ nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run }, { nm: "DS13L", run: d13l }, { nm: "RM1", run: rm1Run }, { nm: "RM1C", run: rm1c }, { nm: "RM1S", run: sRun }, { nm: "RM1SC", run: scRun }];
    console.log(`\n=== [R5] 같은 데이터(보정 적용 + 의심 종목-일 0% 처리) 기준 나란히 비교 (CAGR % / MDD %; 같은 구간 ${from}~; DS6·RM1C는 일별 40:60 재조정, DS13L·RM1SC는 월 1회 재조정) ===`);
    console.log(`| 구간 | ${cmpRows.map((r) => r.nm).join(" | ")} |\n|---|${cmpRows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${cmpRows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    const fl = cmpRows.map((r) => ({ nm: r.nm, s: h.st(r.run, Wx.FULL) }));
    console.log(`\n=== [R6] 연 회전율 % / 비용 합계 %(연속) ===\n${fl.map((x) => `${x.nm} ${f2(x.s.turnover)} / ${f2(x.s.cost)}`).join(" | ")}`);
    // ---- [R3] 연도별 069500·DS6·DS13L 대비 ----
    const bh = BH_FROM(from);
    for (const [nm, run] of [["RM1S", sRun], ["RM1SC", scRun]] as [string, SimRun][]) {
      console.log(`\n=== [R3] ${nm} 연도별 수익률 % ===\n| 연도 | 069500 | DS6 | DS13L | ${nm} | ${nm} − 069500 %p | ${nm} − DS6 %p | ${nm} − DS13L %p |\n|---|---|---|---|---|---|---|---|`);
      const ex: number[][] = [[], [], []];
      for (let y = Number(from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) {
        const a = h.yearRet(bh, y), c6 = h.yearRet({ dates: b6.res.run.dates.filter((d) => d >= from), ret: b6.res.run.ret.filter((_, k) => b6.res.run.dates[k] >= from) }, y), cl = h.yearRet(d13l, y), cc = h.yearRet(run, y);
        ex[0].push(cc - a); ex[1].push(cc - c6); ex[2].push(cc - cl);
        console.log(`| ${y} | ${f2(a)} | ${f2(c6)} | ${f2(cl)} | ${f2(cc)} | ${sg(cc - a)} | ${sg(cc - c6)} | ${sg(cc - cl)} |`);
      }
      console.log(`${nm} 승·패 연수: 069500 대비 승 ${ex[0].filter((x) => x > 0).length} / 패 ${ex[0].filter((x) => x < 0).length} (평균 ${sg(avg(ex[0]))}%p, 중앙값 ${sg(median(ex[0]))}%p) | DS6 대비 승 ${ex[1].filter((x) => x > 0).length} / 패 ${ex[1].filter((x) => x < 0).length} (평균 ${sg(avg(ex[1]))}%p) | DS13L 대비 승 ${ex[2].filter((x) => x > 0).length} / 패 ${ex[2].filter((x) => x < 0).length} (평균 ${sg(avg(ex[2]))}%p, 중앙값 ${sg(median(ex[2]))}%p)`);
    }
    // ---- [S1] 손절 발동 횟수와 손절 후 다음 달 수익 ----
    console.log(`\n=== [S1] 손절 발동 횟수와 손절 후 다음 달 수익(손절 체결일 종가 → 이후 ${S_NEXT_MONTH_DAYS}거래일 종가, 수정 종가 수익률; 양수 = 손절 뒤 오른 것 = 손절이 틀림, 음수 = 더 내림 = 손절이 맞음) ===`);
    {
      const yrs = (Date.parse(h.dataEnd) - Date.parse(from)) / 86_400_000 / 365.25;
      for (const [lb, ch] of [["손절 -20%(기본)", {}], ...RM1S_NB] as [string, Partial<RmsP>][]) {
        runS(rms, { ...RM1S_P0, ...ch }, cS, null, { lag: 1, detail: true });
        const ev = [...rmsLog], rv = ev.map(stopNext).filter((x) => Number.isFinite(x)), byY = new Map<string, number>();
        for (const e of ev) byY.set(CAL[e.c].slice(0, 4), (byY.get(CAL[e.c].slice(0, 4)) ?? 0) + 1);
        console.log(`${lb}: 발동 ${ev.length}건(연 평균 ${f2(ev.length / yrs)}건) | 손절 후 다음 달 수익 평균 ${f2(avg(rv) * 100)}%·중앙값 ${f2(median(rv) * 100)}% (${rv.length}건) | 양수(손절이 틀림) ${rv.filter((x) => x > 0).length}건 ${f2((rv.filter((x) => x > 0).length / Math.max(rv.length, 1)) * 100)}% · 음수(손절이 맞음) ${rv.filter((x) => x < 0).length}건 ${f2((rv.filter((x) => x < 0).length / Math.max(rv.length, 1)) * 100)}% | 연도별 ${[...byY.entries()].sort().map(([y, n]) => `${y} ${n}`).join(" · ")}`);
      }
    }
    // ---- [S3] 삼성전자·SK하이닉스 평균 비중(보유 일수 × 1/20 근사) ----
    console.log(`\n=== [S3] RM1S·RM1SC의 삼성전자·SK하이닉스 보유 일수와 평균 비중(RM1S 보유 일수 비율 × 1/${RM1S_P0.n}, 비중 표류·현금 무시 근사; RM1SC 코어는 DS6 코어 목표 비중 평균) ===`);
    {
      const coreRun = coreOf(2, undefined, 1, {}).run, base = runS(rms, RM1S_P0, cS, null, { lag: 1, detail: true }), nDays = base.dates.length, all = [...base.trades, ...base.open];
      for (const code of V3_WATCH) {
        const ct = base.contrib.get(code), wS = ct ? (ct.days / nDays) / RM1S_P0.n : 0;
        let wCore = 0, k = 0;
        for (let c = cS; c < CAL.length; c++) { const ev = [...coreRun.events].filter((e) => e.c <= c + 1).pop(); wCore += ev ? (ev.w[ev.set.indexOf(code)] ?? 0) : 0; k++; }
        const ts = all.filter((t) => t.code === code);
        console.log(`${label(code)} RM1S: 보유 일수 ${ct?.days ?? 0}/${nDays}일(구간 ${ts.length}건${ts.length ? `: ${ts.map((t) => `${CAL[t.entryC]}~${t.reason === "기간 끝 평가" ? "보유 중" : CAL[t.exitC]}`).slice(0, 6).join(", ")}` : ""}) | 평균 비중(근사): RM1S ${f2(wS * 100)}% | RM1SC = 코어 40% × ${f2((wCore / k) * 100)} + 위성 60% × ${f2(wS * 100)} = ${f2(0.4 * (wCore / k) * 100 + 0.6 * wS * 100)}%`);
      }
    }
    // ---- [S4] VB1 MDD 구간 ----
    console.log(`\n=== [S4] VB1 MDD 구간(${win.from}~${win.to}) 구간 수익·낙폭(정보용; VB1 앞선 기록: 구간 복리 -63.31% / MDD 64.17%, VB1C -47.89% / 48.78%) ===`);
    {
      console.log("| 전략 | 구간 복리 수익 % | 구간 내 낙폭 MDD % | 연속 전체 MDD % |\n|---|---|---|---|");
      for (const r of cmpRows) { const ws = winStat(r.run, win.from, win.to); console.log(`| ${r.nm} | ${f2(ws.tot)} | ${f2(ws.mdd)} | ${f2(h.st(r.run, Wx.FULL).mdd)} |`); }
    }
    // ---- [S5] 하루 지연(C) ----
    console.log(`\n=== [S5] 하루 지연(C 관문, 진입·청산·재조정 +1거래일) 연속 CAGR·MDD 변화 — 각 시험의 "지연 버전" 줄과 같은 값을 다시 모은 요약 ===`);
    {
      const dl = runS(rms, RM1S_P0, cS, null, { lag: 2, detail: true }), b = h.st(sRun, Wx.FULL), d2 = h.st(dl, Wx.FULL);
      console.log(`RM1S: 기준 ${f2(b.cagr)} / ${f2(b.mdd)} → 지연 ${f2(d2.cagr)} / ${f2(d2.mdd)} (CAGR ${sg(d2.cagr - b.cagr)}%p, MDD ${sg(d2.mdd - b.mdd)}%p)`);
      const dlC = combineN([sliceSl(coreOf(2, undefined, 2, {}).sl, from), slFromRun(dl)], [B5_CORE_W, 1 - B5_CORE_W], CS_MOVE_COST, sigSet).run, bc = h.st(scRun, Wx.FULL), dc = h.st(dlC, Wx.FULL);
      console.log(`RM1SC: 기준 ${f2(bc.cagr)} / ${f2(bc.mdd)} → 지연 ${f2(dc.cagr)} / ${f2(dc.mdd)} (CAGR ${sg(dc.cagr - bc.cagr)}%p, MDD ${sg(dc.mdd - bc.mdd)}%p)`);
    }

  } else if (MODE === "vbstest") {
    await loadEqTables();
    requireStart();
    if (!PRICE_CORRECTION_ON || !ZERO_SUSPECT_ON) throw new Error("보정 또는 의심 종목-일 0% 처리 미적용(correct=k200p17 zero=1 필요) — 시험하지 않고 중단해 보고한다");
    if (V_START !== VS_START) throw new Error(`V_START=${V_START} ≠ 사전등록 ${VS_START} — 중단`);
    console.log(`저PBR 손절 시험 설정: ${V_CASE}, 시작 월말 ${V_START}, 데이터: K200P 17건 보정 적용 + 의심 종목-일 0% 처리 ${suspectLog.length}건(보정 후보 A), 소멸 관례 저PBR 시험(VB1)과 같음`);
    const vb1 = mkVB("VB1", VB1_P0, VB1_NB), vbs = mkVBS("VB1S", VB1S_P0, VB1S_NB);
    const cV = startOf(vbs, false), Wx = windowsV(cV), from = Wx.FULL.from;
    if (cV !== startOf(vb1, false)) throw new Error("VB1S 첫 신호일 ≠ VB1 — 중단");
    const sigSet = new Set(monthEndIdx.filter((c) => c > cV).map((c) => CAL[c]));
    console.log(`연속 평가 공통: 첫 신호일 ${CAL[cV]}, 수익률 집계 ${from}~${h.dataEnd} | 구간 ${Wx.NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(VB1S, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkS(vbs, "VB1S", trial, false, cV, Wx, "VB1S: VB1(BS1 적격 유니버스 중 PBR 하위 30종목 동일 비중, 하위 90위 안이면 유지, 월말 신호)과 같고, 보유 종목 종가가 진입 후 최고 종가 대비 -20% 이하면 다음 거래일 종가에 전량 매도(현금), 다음 월말 전까지 재진입·재배분 없음")));
    }
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(VB1SC, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkC(vbs, "VB1SC", trial, cV, Wx, "VB1SC: DS6 코어 40% + 위성 60% = VB1S, 월 리밸런스", sigSet)));
    }
    // ---- 기준 실행(보고용) ----
    const win = V3_MDD_WINDOW;
    const vb1Run = runS(vb1, VB1_P0, cV, null, { lag: 1, detail: true }), d13l = d13Of("LV1", cV, Wx).base.res.run, rmsc = rm1scOf(cV, Wx);
    const coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, from), vb1c = combine2(coreFull, slFromRun(vb1Run), B5_CORE_W, CS_MOVE_COST).run;
    const sRun = verdicts.find((v) => v.id === "VB1S")?.run as SimRun, scRun = verdicts.find((v) => v.id === "VB1SC")?.run as SimRun;
    // ---- [R5] 나란히 비교 ----
    const cmpRows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [{ nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run }, { nm: "DS13L", run: d13l }, { nm: "VB1", run: vb1Run }, { nm: "VB1C", run: vb1c }, { nm: "RM1SC", run: rmsc.res.run }, { nm: "VB1S", run: sRun }, { nm: "VB1SC", run: scRun }];
    console.log(`\n=== [R5] 같은 데이터(보정 적용 + 의심 종목-일 0% 처리) 기준 나란히 비교 (CAGR % / MDD %; 같은 시작일 ${from}~, RM1SC·DS13L은 같은 시작일로 새로 계산; DS6·VB1C는 일별 40:60 재조정, DS13L·RM1SC·VB1SC는 월 1회 재조정) ===`);
    console.log(`| 구간 | ${cmpRows.map((r) => r.nm).join(" | ")} |\n|---|${cmpRows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${cmpRows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    const fl = cmpRows.map((r) => ({ nm: r.nm, s: h.st(r.run, Wx.FULL) }));
    console.log(`\n=== [R6] 연 회전율 % / 비용 합계 %(연속) ===\n${fl.map((x) => `${x.nm} ${f2(x.s.turnover)} / ${f2(x.s.cost)}`).join(" | ")}`);
    // ---- [R3] 연도별 069500·DS6·DS13L 대비 ----
    const bh = BH_FROM(from);
    for (const [nm, run] of [["VB1S", sRun], ["VB1SC", scRun]] as [string, SimRun][]) {
      console.log(`\n=== [R3] ${nm} 연도별 수익률 % ===\n| 연도 | 069500 | DS6 | DS13L | ${nm} | ${nm} − 069500 %p | ${nm} − DS6 %p | ${nm} − DS13L %p |\n|---|---|---|---|---|---|---|---|`);
      const ex: number[][] = [[], [], []];
      for (let y = Number(from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) {
        const a = h.yearRet(bh, y), c6 = h.yearRet({ dates: b6.res.run.dates.filter((d) => d >= from), ret: b6.res.run.ret.filter((_, k) => b6.res.run.dates[k] >= from) }, y), cl = h.yearRet(d13l, y), cc = h.yearRet(run, y);
        ex[0].push(cc - a); ex[1].push(cc - c6); ex[2].push(cc - cl);
        console.log(`| ${y} | ${f2(a)} | ${f2(c6)} | ${f2(cl)} | ${f2(cc)} | ${sg(cc - a)} | ${sg(cc - c6)} | ${sg(cc - cl)} |`);
      }
      console.log(`${nm} 승·패 연수: 069500 대비 승 ${ex[0].filter((x) => x > 0).length} / 패 ${ex[0].filter((x) => x < 0).length} (평균 ${sg(avg(ex[0]))}%p, 중앙값 ${sg(median(ex[0]))}%p) | DS6 대비 승 ${ex[1].filter((x) => x > 0).length} / 패 ${ex[1].filter((x) => x < 0).length} (평균 ${sg(avg(ex[1]))}%p) | DS13L 대비 승 ${ex[2].filter((x) => x > 0).length} / 패 ${ex[2].filter((x) => x < 0).length} (평균 ${sg(avg(ex[2]))}%p, 중앙값 ${sg(median(ex[2]))}%p)`);
    }
    // ---- [V1] 손절 발동 횟수와 손절 후 21거래일 수익 ----
    console.log(`\n=== [V1] 손절 발동 횟수와 손절 후 21거래일 수익(손절 체결일 종가 → 이후 ${S_NEXT_MONTH_DAYS}거래일 종가, 수정 종가 수익률; 양수 = 손절 뒤 오른 것 = 손절이 틀림, 음수 = 더 내림 = 손절이 맞음) ===`);
    {
      const yrs = (Date.parse(h.dataEnd) - Date.parse(from)) / 86_400_000 / 365.25;
      for (const [lb, ch] of [["손절 -20%(기본)", {}], ...VB1S_NB] as [string, Partial<VbsP>][]) {
        runS(vbs, { ...VB1S_P0, ...ch }, cV, null, { lag: 1, detail: true });
        const ev = [...vbsLog], rv = ev.map(stopNext).filter((x) => Number.isFinite(x)), byY = new Map<string, number>();
        for (const e of ev) byY.set(CAL[e.c].slice(0, 4), (byY.get(CAL[e.c].slice(0, 4)) ?? 0) + 1);
        console.log(`${lb}: 발동 ${ev.length}건(연 평균 ${f2(ev.length / yrs)}건) | 손절 후 21거래일 수익 평균 ${f2(avg(rv) * 100)}%·중앙값 ${f2(median(rv) * 100)}% (${rv.length}건) | 양수(손절이 틀림) ${rv.filter((x) => x > 0).length}건 ${f2((rv.filter((x) => x > 0).length / Math.max(rv.length, 1)) * 100)}% · 음수(손절이 맞음) ${rv.filter((x) => x < 0).length}건 ${f2((rv.filter((x) => x < 0).length / Math.max(rv.length, 1)) * 100)}% | 연도별 ${[...byY.entries()].sort().map(([y, n]) => `${y} ${n}`).join(" · ")}`);
      }
    }
    // ---- [V3] 삼성전자·SK하이닉스 평균 비중(보유 일수 × 1/30 근사) ----
    console.log(`\n=== [V3] VB1S·VB1SC의 삼성전자·SK하이닉스 보유 일수와 평균 비중(VB1S 보유 일수 비율 × 1/${VB1S_P0.n}, 비중 표류·현금 무시 근사; VB1SC 코어는 DS6 코어 목표 비중 평균) ===`);
    {
      const coreRun = coreOf(2, undefined, 1, {}).run, base = runS(vbs, VB1S_P0, cV, null, { lag: 1, detail: true }), nDays = base.dates.length, all = [...base.trades, ...base.open];
      for (const code of V3_WATCH) {
        const ct = base.contrib.get(code), wS = ct ? (ct.days / nDays) / VB1S_P0.n : 0;
        let wCore = 0, k = 0;
        for (let c = cV; c < CAL.length; c++) { const ev = [...coreRun.events].filter((e) => e.c <= c + 1).pop(); wCore += ev ? (ev.w[ev.set.indexOf(code)] ?? 0) : 0; k++; }
        const ts = all.filter((t) => t.code === code);
        console.log(`${label(code)} VB1S: 보유 일수 ${ct?.days ?? 0}/${nDays}일(구간 ${ts.length}건) | 평균 비중(근사): VB1S ${f2(wS * 100)}% | VB1SC = 코어 40% × ${f2((wCore / k) * 100)} + 위성 60% × ${f2(wS * 100)} = ${f2(0.4 * (wCore / k) * 100 + 0.6 * wS * 100)}%`);
      }
    }
    // ---- [V4] VB1 MDD 구간 ----
    console.log(`\n=== [V4] VB1 MDD 구간(${win.from}~${win.to}) 구간 수익·낙폭(정보용; VB1 앞선 기록: 구간 복리 -63.31% / MDD 64.17%, VB1C -47.89% / 48.78%) ===`);
    {
      console.log("| 전략 | 구간 복리 수익 % | 구간 내 낙폭 MDD % | 연속 전체 MDD % |\n|---|---|---|---|");
      for (const r of cmpRows) { const ws = winStat(r.run, win.from, win.to); console.log(`| ${r.nm} | ${f2(ws.tot)} | ${f2(ws.mdd)} | ${f2(h.st(r.run, Wx.FULL).mdd)} |`); }
    }
    // ---- [V5] 하루 지연(C) ----
    console.log(`\n=== [V5] 하루 지연(C 관문, 진입·청산·재조정 +1거래일) 연속 CAGR·MDD 변화 — 각 시험의 "지연 버전" 줄과 같은 값을 다시 모은 요약 ===`);
    {
      const dl = vbscOf(cV, Wx, { lag: 2 }), b = h.st(sRun, Wx.FULL), d2 = h.st(dl.sat, Wx.FULL), bc = h.st(scRun, Wx.FULL), dc = h.st(dl.res.run, Wx.FULL);
      console.log(`VB1S: 기준 ${f2(b.cagr)} / ${f2(b.mdd)} → 지연 ${f2(d2.cagr)} / ${f2(d2.mdd)} (CAGR ${sg(d2.cagr - b.cagr)}%p, MDD ${sg(d2.mdd - b.mdd)}%p)`);
      console.log(`VB1SC: 기준 ${f2(bc.cagr)} / ${f2(bc.mdd)} → 지연 ${f2(dc.cagr)} / ${f2(dc.mdd)} (CAGR ${sg(dc.cagr - bc.cagr)}%p, MDD ${sg(dc.mdd - bc.mdd)}%p)`);
    }
    // ---- [V6] 일간 상관 ----
    console.log(`\n=== [V6] 일간 수익률 상관계수(공통 구간 ${from}~${h.dataEnd}, 정보용) ===`);
    {
      const mkSer = (name: string, r: { dates: string[]; ret: number[] }): { name: string; m: Map<string, number> } => ({ name, m: new Map(r.dates.map((d, i2) => [d, r.ret[i2]])) });
      const ser = cmpRows.map((r) => mkSer(r.nm, r.run));
      const dd = sRun.dates.filter((d) => d >= from && ser.every((x) => x.m.has(d)));
      const corr = (x: Map<string, number>, y: Map<string, number>): number => { const xs = dd.map((d) => x.get(d) as number), ys = dd.map((d) => y.get(d) as number), n = xs.length, mx = avg(xs), my = avg(ys); let sxy = 0, sxx = 0, syy = 0; for (let i2 = 0; i2 < n; i2++) { sxy += (xs[i2] - mx) * (ys[i2] - my); sxx += (xs[i2] - mx) ** 2; syy += (ys[i2] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
      console.log(`공통 ${dd.length}일\n| | ${ser.map((x) => x.name).join(" | ")} |\n|---|${ser.map(() => "---").join("|")}|`);
      for (const x of ser) console.log(`| ${x.name} | ${ser.map((y) => f2(corr(x.m, y.m))).join(" | ")} |`);
    }
  } else if (MODE === "cmtest") {
    await loadEqTables();
    requireStart();
    if (!PRICE_CORRECTION_ON || !ZERO_SUSPECT_ON) throw new Error("보정 또는 의심 종목-일 0% 처리 미적용(correct=k200p17 zero=1 필요) — 시험하지 않고 중단해 보고한다");
    if (V_START !== CM_START) throw new Error(`V_START=${V_START} ≠ 사전등록 ${CM_START} — 중단`);
    console.log(`복합(저PBR + 잔차 모멘텀) 시험 설정: ${V_CASE}, 시작 월말 ${V_START}, 데이터: K200P 17건 보정 적용 + 의심 종목-일 0% 처리 ${suspectLog.length}건(보정 후보 A), 소멸 관례 저PBR 시험(VB1)과 같음, 코어 없음(단독 전략)`);
    const vb1 = mkVB("VB1", VB1_P0, VB1_NB), cm1 = mkCM("CM1", CM1_P0, CM1_NB), cms = mkCMS("CM1S", CM1S_P0, CM1S_NB);
    const cV = startOf(cm1, false), Wx = windowsV(cV), from = Wx.FULL.from;
    if (cV !== startOf(vb1, false) || cV !== startOf(cms, false)) throw new Error("CM1·CM1S 첫 신호일 ≠ VB1 — 중단");
    console.log(`연속 평가 공통: 첫 신호일 ${CAL[cV]}, 수익률 집계 ${from}~${h.dataEnd} | 구간 ${Wx.NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(CM1, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkS(cm1, "CM1", trial, false, cV, Wx, "CM1: VB1 유니버스(BS1 적격 전 종목 PIT) 중 PBR 가능·RM1 점수 가능 종목의 (PBR 순위 + 잔차 모멘텀 순위) ÷ 2 상위 30종목 동일 비중, 평균 순위 60 안이면 유지, 월말 신호, 코어 없음")));
    }
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(CM1S, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkS(cms, "CM1S", trial, false, cV, Wx, "CM1S: CM1과 같고, 보유 종목 종가가 진입 후 최고 종가 대비 -20% 이하면 다음 거래일 종가에 전량 매도(현금), 다음 월말 전까지 재진입·재배분 없음")));
    }
    // ---- 기준 실행(보고용) ----
    const win = V3_MDD_WINDOW;
    const vb1Run = runS(vb1, VB1_P0, cV, null, { lag: 1, detail: true }), rm1Run = runS(RM1, RM1.P0, cV, null, { lag: 1, detail: true }), d13l = d13Of("LV1", cV, Wx).base.res.run, rmsc = rm1scOf(cV, Wx);
    const c1Run = verdicts.find((v) => v.id === "CM1")?.run as SimRun, csRun = verdicts.find((v) => v.id === "CM1S")?.run as SimRun;
    // ---- [R5] 나란히 비교 ----
    const cmpRows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [{ nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run }, { nm: "DS13L", run: d13l }, { nm: "RM1SC", run: rmsc.res.run }, { nm: "VB1", run: vb1Run }, { nm: "RM1", run: rm1Run }, { nm: "CM1", run: c1Run }, { nm: "CM1S", run: csRun }];
    console.log(`\n=== [R5] 같은 데이터(보정 적용 + 의심 종목-일 0% 처리) 기준 나란히 비교 (CAGR % / MDD %; 같은 시작일 ${from}~, RM1SC·RM1·DS13L은 같은 시작일로 새로 계산; DS6은 일별 40:60 재조정, DS13L·RM1SC는 월 1회 재조정; VB1·RM1·CM1·CM1S는 코어 없는 단독 전략) ===`);
    console.log(`| 구간 | ${cmpRows.map((r) => r.nm).join(" | ")} |\n|---|${cmpRows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${cmpRows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    const fl = cmpRows.map((r) => ({ nm: r.nm, s: h.st(r.run, Wx.FULL) }));
    console.log(`\n=== [R6] 연 회전율 % / 비용 합계 %(연속) ===\n${fl.map((x) => `${x.nm} ${f2(x.s.turnover)} / ${f2(x.s.cost)}`).join(" | ")}`);
    // ---- [R3] 연도별 069500·DS6·DS13L 대비 ----
    const bh = BH_FROM(from);
    for (const [nm, run] of [["CM1", c1Run], ["CM1S", csRun]] as [string, SimRun][]) {
      console.log(`\n=== [R3] ${nm} 연도별 수익률 % ===\n| 연도 | 069500 | DS6 | DS13L | ${nm} | ${nm} − 069500 %p | ${nm} − DS6 %p | ${nm} − DS13L %p |\n|---|---|---|---|---|---|---|---|`);
      const ex: number[][] = [[], [], []];
      for (let y = Number(from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) {
        const a = h.yearRet(bh, y), c6 = h.yearRet({ dates: b6.res.run.dates.filter((d) => d >= from), ret: b6.res.run.ret.filter((_, k) => b6.res.run.dates[k] >= from) }, y), cl = h.yearRet(d13l, y), cc = h.yearRet(run, y);
        ex[0].push(cc - a); ex[1].push(cc - c6); ex[2].push(cc - cl);
        console.log(`| ${y} | ${f2(a)} | ${f2(c6)} | ${f2(cl)} | ${f2(cc)} | ${sg(cc - a)} | ${sg(cc - c6)} | ${sg(cc - cl)} |`);
      }
      console.log(`${nm} 승·패 연수: 069500 대비 승 ${ex[0].filter((x) => x > 0).length} / 패 ${ex[0].filter((x) => x < 0).length} (평균 ${sg(avg(ex[0]))}%p, 중앙값 ${sg(median(ex[0]))}%p) | DS6 대비 승 ${ex[1].filter((x) => x > 0).length} / 패 ${ex[1].filter((x) => x < 0).length} (평균 ${sg(avg(ex[1]))}%p) | DS13L 대비 승 ${ex[2].filter((x) => x > 0).length} / 패 ${ex[2].filter((x) => x < 0).length} (평균 ${sg(avg(ex[2]))}%p, 중앙값 ${sg(median(ex[2]))}%p)`);
    }
    // ---- [V1] 손절 발동 횟수와 손절 후 21거래일 수익(CM1S) ----
    console.log(`\n=== [V1] CM1S 손절 발동 횟수와 손절 후 21거래일 수익(손절 체결일 종가 → 이후 ${S_NEXT_MONTH_DAYS}거래일 종가, 수정 종가 수익률; 양수 = 손절 뒤 오른 것 = 손절이 틀림, 음수 = 더 내림 = 손절이 맞음) ===`);
    {
      const yrs = (Date.parse(h.dataEnd) - Date.parse(from)) / 86_400_000 / 365.25;
      for (const [lb, ch] of [["손절 -20%(기본)", {}], ...CM1S_NB] as [string, Partial<CmP>][]) {
        runS(cms, { ...CM1S_P0, ...ch }, cV, null, { lag: 1, detail: true });
        const ev = [...cmsLog], rv = ev.map(stopNext).filter((x) => Number.isFinite(x)), byY = new Map<string, number>();
        for (const e of ev) byY.set(CAL[e.c].slice(0, 4), (byY.get(CAL[e.c].slice(0, 4)) ?? 0) + 1);
        console.log(`${lb}: 발동 ${ev.length}건(연 평균 ${f2(ev.length / yrs)}건) | 손절 후 21거래일 수익 평균 ${f2(avg(rv) * 100)}%·중앙값 ${f2(median(rv) * 100)}% (${rv.length}건) | 양수(손절이 틀림) ${rv.filter((x) => x > 0).length}건 ${f2((rv.filter((x) => x > 0).length / Math.max(rv.length, 1)) * 100)}% · 음수(손절이 맞음) ${rv.filter((x) => x < 0).length}건 ${f2((rv.filter((x) => x < 0).length / Math.max(rv.length, 1)) * 100)}% | 연도별 ${[...byY.entries()].sort().map(([y, n]) => `${y} ${n}`).join(" · ")}`);
      }
    }
    // ---- [V3] 삼성전자·SK하이닉스 평균 비중(보유 일수 × 1/30 근사) ----
    console.log(`\n=== [V3] CM1·CM1S의 삼성전자·SK하이닉스 보유 일수와 평균 비중(보유 일수 비율 × 1/${CM1_P0.n}, 비중 표류·현금 무시 근사; 코어 없음) ===`);
    {
      const bC = runS(cm1, CM1_P0, cV, null, { lag: 1, detail: true }), bS = runS(cms, CM1S_P0, cV, null, { lag: 1, detail: true }), nDays = bC.dates.length;
      for (const code of V3_WATCH) {
        const a = bC.contrib.get(code), b = bS.contrib.get(code);
        console.log(`${label(code)} CM1: 보유 일수 ${a?.days ?? 0}/${nDays}일(구간 ${[...bC.trades, ...bC.open].filter((t) => t.code === code).length}건) 평균 비중(근사) ${f2((((a?.days ?? 0) / nDays) / CM1_P0.n) * 100)}% | CM1S: 보유 일수 ${b?.days ?? 0}/${nDays}일(구간 ${[...bS.trades, ...bS.open].filter((t) => t.code === code).length}건) 평균 비중(근사) ${f2((((b?.days ?? 0) / nDays) / CM1_P0.n) * 100)}%`);
      }
    }
    // ---- [V4] VB1 MDD 구간 ----
    console.log(`\n=== [V4] VB1 MDD 구간(${win.from}~${win.to}) 구간 수익·낙폭(정보용; VB1 앞선 기록: 구간 복리 -63.31% / MDD 64.17%) ===`);
    {
      console.log("| 전략 | 구간 복리 수익 % | 구간 내 낙폭 MDD % | 연속 전체 MDD % |\n|---|---|---|---|");
      for (const r of cmpRows) { const ws = winStat(r.run, win.from, win.to); console.log(`| ${r.nm} | ${f2(ws.tot)} | ${f2(ws.mdd)} | ${f2(h.st(r.run, Wx.FULL).mdd)} |`); }
    }
    // ---- [V5] 하루 지연(C) ----
    console.log(`\n=== [V5] 하루 지연(C 관문, 진입·청산 +1거래일) 연속 CAGR·MDD 변화 — 각 시험의 "지연 버전" 줄과 같은 값을 다시 모은 요약 ===`);
    {
      for (const [nm, def, P0, base] of [["CM1", cm1, CM1_P0, c1Run], ["CM1S", cms, CM1S_P0, csRun]] as [string, Strat<CmP>, CmP, SimRun][]) {
        const d2 = h.st(runS(def, P0, cV, null, { lag: 2, detail: true }), Wx.FULL), b = h.st(base, Wx.FULL);
        console.log(`${nm}: 기준 ${f2(b.cagr)} / ${f2(b.mdd)} → 지연 ${f2(d2.cagr)} / ${f2(d2.mdd)} (CAGR ${sg(d2.cagr - b.cagr)}%p, MDD ${sg(d2.mdd - b.mdd)}%p)`);
      }
    }
    // ---- [V6] 일간 상관 ----
    console.log(`\n=== [V6] 일간 수익률 상관계수(공통 구간 ${from}~${h.dataEnd}, 정보용) ===`);
    {
      const mkSer = (name: string, r: { dates: string[]; ret: number[] }): { name: string; m: Map<string, number> } => ({ name, m: new Map(r.dates.map((d, i2) => [d, r.ret[i2]])) });
      const ser = cmpRows.map((r) => mkSer(r.nm, r.run));
      const dd = c1Run.dates.filter((d) => d >= from && ser.every((x) => x.m.has(d)));
      const corr = (x: Map<string, number>, y: Map<string, number>): number => { const xs = dd.map((d) => x.get(d) as number), ys = dd.map((d) => y.get(d) as number), n = xs.length, mx = avg(xs), my = avg(ys); let sxy = 0, sxx = 0, syy = 0; for (let i2 = 0; i2 < n; i2++) { sxy += (xs[i2] - mx) * (ys[i2] - my); sxx += (xs[i2] - mx) ** 2; syy += (ys[i2] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
      console.log(`공통 ${dd.length}일\n| | ${ser.map((x) => x.name).join(" | ")} |\n|---|${ser.map(() => "---").join("|")}|`);
      for (const x of ser) console.log(`| ${x.name} | ${ser.map((y) => f2(corr(x.m, y.m))).join(" | ")} |`);
    }
    // ---- [C1] 평균 PBR·금융주 비중 · [C2] 후보 집합 크기 ----
    console.log(`\n=== [C1] 보유 종목 평균 PBR · 금융주 비중(월말 신호일 목표 종목, 근사: 이전 목표 = 보유; 금융 = KSIC ${Q_FIN_KSIC.join("·")}) ===`);
    {
      for (const [nm, pt] of [["CM1", pathTgG(cm1, cV)], ["VB1", pathTgG(vb1, cV)], ["RM1", pathTgG(RM1, cV)]] as [string, { c: number; t: Map<string, number> }[]][]) {
        const pv: number[] = [];
        let nFin = 0, nAll = 0, nSigFin = 0;
        for (const { c, t } of pt) {
          let nf = 0;
          for (const code of t.keys()) {
            const x = pbrAt(c, h.byCode.get(code) as S, VB1_P0.maxAge);
            if (x.why === "ok") pv.push(x.pbr);
            nAll++; if ((Q_FIN_KSIC as readonly string[]).includes((indOf.get(code) ?? "").slice(0, 2))) { nFin++; nf++; }
          }
          if (nf > 0) nSigFin++;
        }
        console.log(`${nm}: 평균 PBR ${f2(avg(pv))}(중앙값 ${f2(median(pv))}, PBR 계산 ${pv.length}/${nAll}건) | 금융주 비중 ${f2((nFin / Math.max(nAll, 1)) * 100)}%(보유 종목-월 ${nAll}건 중 ${nFin}건, 금융주가 1개 이상인 신호일 ${nSigFin}/${pt.length})`);
      }
    }
    console.log(`\n=== [C2] 후보 집합 크기(BS1 적격 ∩ PBR 있음 ∩ RM1 점수 있음, 월말 신호일 ${monthEndIdx.filter((x) => x >= cV).length}개) ===`);
    {
      const sz = monthEndIdx.filter((x) => x >= cV).map((c) => cmRows(c).length);
      console.log(`최소 ${Math.min(...sz)} · 평균 ${f2(avg(sz))} · 최대 ${Math.max(...sz)} | 30개 미만 ${sz.filter((x) => x < CM1_P0.n).length}개월`);
    }
  } else if (MODE === "dvtest") {
    await loadEqTables();
    await loadDiv();
    await loadRoe();
    requireStart();
    if (!PRICE_CORRECTION_ON || !ZERO_SUSPECT_ON) throw new Error("보정 또는 의심 종목-일 0% 처리 미적용(correct=k200p17 zero=1 필요) — 시험하지 않고 중단해 보고한다");
    if (!DV_START || V_START !== DV_START) throw new Error(`V_START=${V_START} ≠ 사전등록 ${DV_START || "미확정"} — 중단`);
    if (V_CASE !== "C2") throw new Error(`구간 케이스 ${V_CASE} ≠ C2(두 구간) — 중단`);
    console.log(`배당 시험 설정: ${V_CASE}(두 구간, B는 두 구간 모두 069500 우위), 시작 월말 ${V_START}, 데이터: K200P 17건 보정 적용 + 의심 종목-일 0% 처리 ${suspectLog.length}건(보정 후보 A), 소멸 관례 저PBR·ROE 시험과 같음, DV1 = 코어 없음(단독) · DV1C = DS6 코어 40% + DV1 60% 월 리밸런스`);
    const dv1 = mkDV("DV1", DV1_P0, DV_NB), cD = startOf(dv1, false), Wx = windowsV(cD), from = Wx.FULL.from;
    const sigSet = new Set(monthEndIdx.filter((c) => c > cD).map((c) => CAL[c]));
    console.log(`연속 평가 공통: 첫 신호일 ${CAL[cD]}, 수익률 집계 ${from}~${h.dataEnd} | 구간 ${Wx.NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(DV1, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkS(dv1, "DV1", trial, false, cD, Wx, "DV1: BS1 적격 전 종목 PIT 중 배당 연속성(직전 3개 사업연도 보통주 주당 현금배당금 모두 > 0 ∧ 순이익 TTM > 0 ∧ 자본 > 0)을 만족하는 종목의 배당수익률(가장 최근 접수 사업연도 보통주 주당 현금배당금 ÷ 월말 종가) 상위 30종목 동일 비중, 순위 60 안이면 유지, 접수일 다음 거래일부터 반영·접수 후 400일 초과 제외, 월말 신호·다음 거래일 종가 체결, 코어 없음")));
    }
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(DV1C, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkC(dv1, "DV1C", trial, cD, Wx, "DV1C: DS6 코어 40% + 위성 60% = DV1, 월 리밸런스", sigSet)));
    }
    // ---- 기준 실행(보고용) ----
    const win = V3_MDD_WINDOW, vb1 = mkVB("VB1", VB1_P0, VB1_NB), qv1 = mkQ("QV1", QV1_P0, QV1_NB);
    const vb1Run = runS(vb1, VB1_P0, cD, null, { lag: 1, detail: true }), rm1Run = runS(RM1, RM1.P0, cD, null, { lag: 1, detail: true }), qvRun = runS(qv1, QV1_P0, cD, null, { lag: 1, detail: true }), d13l = d13Of("LV1", cD, Wx).base.res.run, rmsc = rm1scOf(cD, Wx);
    const gRun = verdicts.find((v) => v.id === "DV1")?.run as SimRun, cRun = verdicts.find((v) => v.id === "DV1C")?.run as SimRun;
    // ---- [R5] 나란히 비교 ----
    const cmpRows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [{ nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run }, { nm: "DS13L", run: d13l }, { nm: "RM1SC", run: rmsc.res.run }, { nm: "VB1", run: vb1Run }, { nm: "QV1", run: qvRun }, { nm: "DV1", run: gRun }, { nm: "DV1C", run: cRun }];
    console.log(`\n=== [R5] 같은 데이터(보정 적용 + 의심 종목-일 0% 처리) 기준 나란히 비교 (CAGR % / MDD %; 같은 시작일 ${from}~, 두 구간, RM1SC·DS13L·VB1·QV1은 같은 시작일로 새로 계산; DS6은 일별 40:60 재조정, DS13L·RM1SC·DV1C는 월 1회 재조정; VB1·QV1·DV1은 코어 없는 단독 전략) ===`);
    console.log(`| 구간 | ${cmpRows.map((r) => r.nm).join(" | ")} |\n|---|${cmpRows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${cmpRows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    const fl = cmpRows.map((r) => ({ nm: r.nm, s: h.st(r.run, Wx.FULL) }));
    console.log(`\n=== [R6] 연 회전율 % / 비용 합계 %(연속) ===\n${fl.map((x) => `${x.nm} ${f2(x.s.turnover)} / ${f2(x.s.cost)}`).join(" | ")}`);
    // ---- [R3] 연도별 069500·DS6·DS13L 대비 ----
    const bh = BH_FROM(from);
    for (const [nm, run] of [["DV1", gRun], ["DV1C", cRun]] as [string, SimRun][]) {
      console.log(`\n=== [R3] ${nm} 연도별 수익률 % ===\n| 연도 | 069500 | DS6 | DS13L | ${nm} | ${nm} − 069500 %p | ${nm} − DS6 %p | ${nm} − DS13L %p |\n|---|---|---|---|---|---|---|---|`);
      const ex: number[][] = [[], [], []];
      for (let y = Number(from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) {
        const a = h.yearRet(bh, y), c6 = h.yearRet({ dates: b6.res.run.dates.filter((d) => d >= from), ret: b6.res.run.ret.filter((_, k) => b6.res.run.dates[k] >= from) }, y), cl = h.yearRet(d13l, y), cc = h.yearRet(run, y);
        ex[0].push(cc - a); ex[1].push(cc - c6); ex[2].push(cc - cl);
        console.log(`| ${y} | ${f2(a)} | ${f2(c6)} | ${f2(cl)} | ${f2(cc)} | ${sg(cc - a)} | ${sg(cc - c6)} | ${sg(cc - cl)} |`);
      }
      console.log(`${nm} 승·패 연수: 069500 대비 승 ${ex[0].filter((x) => x > 0).length} / 패 ${ex[0].filter((x) => x < 0).length} (평균 ${sg(avg(ex[0]))}%p, 중앙값 ${sg(median(ex[0]))}%p) | DS6 대비 승 ${ex[1].filter((x) => x > 0).length} / 패 ${ex[1].filter((x) => x < 0).length} (평균 ${sg(avg(ex[1]))}%p) | DS13L 대비 승 ${ex[2].filter((x) => x > 0).length} / 패 ${ex[2].filter((x) => x < 0).length} (평균 ${sg(avg(ex[2]))}%p, 중앙값 ${sg(median(ex[2]))}%p)`);
    }
    // ---- [V3] 삼성전자·SK하이닉스 평균 비중 ----
    console.log(`\n=== [V3] DV1·DV1C의 삼성전자·SK하이닉스 보유 여부와 평균 목표 비중(월말 신호일 목표, 근사: 이전 목표 = 보유; DV1C = 코어 40% × 코어 내 비중 + 위성 60% × DV1 비중) ===`);
    {
      const coreRun = coreOf(2, undefined, 1, {}).run, pt = pathTgG(dv1, cD), all = [...gRun.trades, ...((gRun as RebalRun).open ?? [])];
      for (const code of V3_WATCH) {
        let nHold = 0, wS = 0, wCore = 0;
        for (const { c, t } of pt) { const w = t.get(code) ?? 0; if (w > 0) nHold++; wS += w; const ev = [...coreRun.events].filter((e) => e.c <= c + 1).pop(); wCore += ev ? (ev.w[ev.set.indexOf(code)] ?? 0) : 0; }
        const n = pt.length, ts = all.filter((t) => t.code === code);
        console.log(`${label(code)} DV1: 월말 목표 보유 ${nHold}/${n}개 신호일(구간 ${ts.length}건${ts.length ? `: ${ts.map((t) => `${CAL[t.entryC]}~${t.reason === "기간 끝 평가" ? "보유 중" : CAL[t.exitC]}`).slice(0, 6).join(", ")}` : ""}) | 평균 목표 비중(계좌 기준 %): DV1 ${f2((wS / n) * 100)} | DV1C = 코어 40% × ${f2((wCore / n) * 100)} + 위성 60% × ${f2((wS / n) * 100)} = ${f2(0.4 * (wCore / n) * 100 + 0.6 * (wS / n) * 100)}%`);
      }
    }
    // ---- [V4] VB1 MDD 구간 ----
    console.log(`\n=== [V4] VB1 MDD 구간(${win.from}~${win.to}) 구간 수익·낙폭(정보용; VB1 앞선 기록: 구간 복리 -63.31% / MDD 64.17%) ===`);
    {
      console.log("| 전략 | 구간 복리 수익 % | 구간 내 낙폭 MDD % | 연속 전체 MDD % |\n|---|---|---|---|");
      for (const r of cmpRows) { const ws = winStat(r.run, win.from, win.to); console.log(`| ${r.nm} | ${f2(ws.tot)} | ${f2(ws.mdd)} | ${f2(h.st(r.run, Wx.FULL).mdd)} |`); }
    }
    // ---- [V5] 하루 지연(C) ----
    console.log(`\n=== [V5] 하루 지연(C 관문, 진입·청산·재조정 +1거래일) 연속 CAGR·MDD 변화 — 각 시험의 "지연 버전" 줄과 같은 값을 다시 모은 요약 ===`);
    {
      const dl = runS(dv1, DV1_P0, cD, null, { lag: 2, detail: true }), b = h.st(gRun, Wx.FULL), d2 = h.st(dl, Wx.FULL);
      console.log(`DV1: 기준 ${f2(b.cagr)} / ${f2(b.mdd)} → 지연 ${f2(d2.cagr)} / ${f2(d2.mdd)} (CAGR ${sg(d2.cagr - b.cagr)}%p, MDD ${sg(d2.mdd - b.mdd)}%p)`);
      const dlC = combineN([sliceSl(coreOf(2, undefined, 2, {}).sl, from), slFromRun(dl)], [DV1C_W[0], DV1C_W[1]], CS_MOVE_COST, sigSet).run, bc = h.st(cRun, Wx.FULL), dc = h.st(dlC, Wx.FULL);
      console.log(`DV1C: 기준 ${f2(bc.cagr)} / ${f2(bc.mdd)} → 지연 ${f2(dc.cagr)} / ${f2(dc.mdd)} (CAGR ${sg(dc.cagr - bc.cagr)}%p, MDD ${sg(dc.mdd - bc.mdd)}%p)`);
    }
    // ---- [V6] 일간 상관 ----
    console.log(`\n=== [V6] 일간 수익률 상관계수(공통 구간 ${from}~${h.dataEnd}, 정보용; VB1·QV1·RM1 포함) ===`);
    {
      const mkSer = (name: string, r: { dates: string[]; ret: number[] }): { name: string; m: Map<string, number> } => ({ name, m: new Map(r.dates.map((d, i2) => [d, r.ret[i2]])) });
      const ser = [...cmpRows, { nm: "RM1", run: rm1Run }].map((r) => mkSer(r.nm, r.run));
      const dd = gRun.dates.filter((d) => d >= from && ser.every((x) => x.m.has(d)));
      const corr = (x: Map<string, number>, y: Map<string, number>): number => { const xs = dd.map((d) => x.get(d) as number), ys = dd.map((d) => y.get(d) as number), n = xs.length, mx = avg(xs), my = avg(ys); let sxy = 0, sxx = 0, syy = 0; for (let i2 = 0; i2 < n; i2++) { sxy += (xs[i2] - mx) * (ys[i2] - my); sxx += (xs[i2] - mx) ** 2; syy += (ys[i2] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
      console.log(`공통 ${dd.length}일\n| | ${ser.map((x) => x.name).join(" | ")} |\n|---|${ser.map(() => "---").join("|")}|`);
      for (const x of ser) console.log(`| ${x.name} | ${ser.map((y) => f2(corr(x.m, y.m))).join(" | ")} |`);
    }
    // ---- [D1] 평균 배당수익률·PBR · 금융주·지주사 비중 ----
    console.log(`\n=== [D1] 보유 종목 평균 배당수익률·PBR · 금융주·지주사 비중(월말 신호일 목표 종목, 근사: 이전 목표 = 보유; 금융 = KSIC ${Q_FIN_KSIC.join("·")}, 지주사 = 종목명에 "홀딩스"·"지주"·"Holdings" 포함(이름 기반 근사)) ===`);
    {
      for (const [nm, pt] of [["DV1", pathTgG(dv1, cD)], ["VB1", pathTgG(vb1, cD)], ["QV1", pathTgG(qv1, cD)]] as [string, { c: number; t: Map<string, number> }[]][]) {
        const yv: number[] = [], pv: number[] = [];
        let nFin = 0, nHold = 0, nAll = 0;
        for (const { c, t } of pt) {
          const yl = new Map(dvRowsAt(c, DV1_P0).map((x) => [x.code, x.yld] as [string, number]));
          for (const code of t.keys()) {
            const y0 = yl.get(code), x = pbrAt(c, h.byCode.get(code) as S, VB1_P0.maxAge);
            if (y0 !== undefined) yv.push(y0);
            if (x.why === "ok") pv.push(x.pbr);
            nAll++;
            if ((Q_FIN_KSIC as readonly string[]).includes((indOf.get(code) ?? "").slice(0, 2))) nFin++;
            if (/홀딩스|지주|Holdings/i.test(label(code))) nHold++;
          }
        }
        console.log(`${nm}: 배당수익률 30% 초과 보유 종목-월 ${yv.filter((x) => x > 0.3).length}건 · 100% 초과 ${yv.filter((x) => x > 1).length}건 · 최댓값 ${f2(Math.max(...yv, 0) * 100)}%(액면분할 직후 미보정·단위 오류 이상치 영향 확인용, 정의는 바꾸지 않음)
${nm}: 평균 배당수익률 ${f2(avg(yv) * 100)}%(중앙값 ${f2(median(yv) * 100)}%, 계산 ${yv.length}/${nAll}건) | 평균 PBR ${f2(avg(pv))}(중앙값 ${f2(median(pv))}, PBR 계산 ${pv.length}/${nAll}건) | 금융주 비중 ${f2((nFin / Math.max(nAll, 1)) * 100)}%(보유 종목-월 ${nAll}건 중 ${nFin}건) | 지주사 비중 ${f2((nHold / Math.max(nAll, 1)) * 100)}%(${nHold}건)`);
      }
    }
    // ---- [D2] 후보 집합 크기 · [D3] 제외 종목-월 비율 ----
    console.log(`\n=== [D2] 후보 집합 크기(월말 신호일 ${monthEndIdx.filter((x) => x >= cD).length}개) · [D3] 제외 종목-월 비율(BS1 적격 종목-월 기준) ===`);
    {
      const days = monthEndIdx.filter((x) => x >= cD), s1 = days.map((c) => dvRowsAt(c, DV1_P0).length);
      console.log(`DV1 후보 수: 최소 ${Math.min(...s1)} · 평균 ${f2(avg(s1))} · 최대 ${Math.max(...s1)} | ${DV1_P0.n}개 미만 월 ${s1.filter((x) => x < DV1_P0.n).length}개`);
      let nAll = 0, nOk = 0, nNoDiv = 0, nNoCont = 0, nRoe = 0;
      const whyD = new Map<string, number>();
      for (const c of days) {
        const d = CAL[c];
        for (const code of bsElig(c, B5_BS_P0)) {
          nAll++;
          const o = divAt(code, d, DV1_P0.maxAge);
          if (o.why !== "ok") { nNoDiv++; whyD.set(o.why, (whyD.get(o.why) ?? 0) + 1); continue; }
          if (!((o.dps as number) > 0 && (o.d1 ?? 0) > 0 && (o.d2 ?? 0) > 0)) { nNoCont++; continue; }
          if (roeOf(code, d, DV1_P0.maxAge).why !== "ok") { nRoe++; continue; }
          nOk++;
        }
      }
      const pc = (x: number): string => `${f2((x / Math.max(nAll, 1)) * 100)}%`;
      console.log(`적격 종목-월 ${nAll}건 중 후보 ${nOk}건 ${pc(nOk)} | 제외: 배당 계산 불가 ${nNoDiv}건 ${pc(nNoDiv)}(${[...whyD.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(" · ")}) · 연속성 불충족(무배당·3년 중 하나라도 배당 ≤ 0) ${nNoCont}건 ${pc(nNoCont)} · 순이익 TTM ≤ 0 또는 자본 ≤ 0 등 ROE 불가 ${nRoe}건 ${pc(nRoe)}`);
    }
  } else if (MODE === "egtest") {
    await loadEqTables();
    await loadRoe();
    requireStart();
    if (!PRICE_CORRECTION_ON || !ZERO_SUSPECT_ON) throw new Error("보정 또는 의심 종목-일 0% 처리 미적용(correct=k200p17 zero=1 필요) — 시험하지 않고 중단해 보고한다");
    if (!EG_START || V_START !== EG_START) throw new Error(`V_START=${V_START} ≠ 사전등록 ${EG_START || "미확정"} — 중단`);
    if (V_CASE !== "C2") throw new Error(`구간 케이스 ${V_CASE} ≠ C2(두 구간) — 중단`);
    console.log(`ROE 변화 시험 설정: ${V_CASE}(두 구간, B는 두 구간 모두 069500 우위), 시작 월말 ${V_START}, 데이터: K200P 17건 보정 적용 + 의심 종목-일 0% 처리 ${suspectLog.length}건(보정 후보 A), 소멸 관례 저PBR·ROE 시험과 같음, 코어 없음(단독 전략)`);
    const eg1 = mkEG("EG1", EG1_P0, EG_NB, false), egm1 = mkEG("EGM1", EGM1_P0, EG_NB, true);
    const cV = startOf(eg1, false), Wx = windowsV(cV), from = Wx.FULL.from;
    if (cV !== startOf(egm1, false)) throw new Error("EG1·EGM1 첫 신호일 불일치 — 중단");
    console.log(`연속 평가 공통: 첫 신호일 ${CAL[cV]}, 수익률 집계 ${from}~${h.dataEnd} | 구간 ${Wx.NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(EG1, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkS(eg1, "EG1", trial, false, cV, Wx, "EG1: BS1 적격 전 종목 PIT 중 ROE(TTM, 지금)·ROE(TTM, 12개월 전) 둘 다 계산되는 종목(순이익 TTM > 0, 자본 > 0)의 ROE 변화 상위 30종목 동일 비중, 순위 60 안이면 유지, 월말 신호, 코어 없음")));
    }
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(EGM1, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkS(egm1, "EGM1", trial, false, cV, Wx, "EGM1: EG1 후보 중 RM1 점수도 계산되는 종목의 (ROE 변화 순위 + 잔차 모멘텀 순위) ÷ 2 상위 30종목 동일 비중, 평균 순위 60 안이면 유지, 월말 신호, 코어 없음")));
    }
    // ---- 기준 실행(보고용) ----
    const win = V3_MDD_WINDOW, vb1 = mkVB("VB1", VB1_P0, VB1_NB), qv1 = mkQ("QV1", QV1_P0, QV1_NB), cm1 = mkCM("CM1", CM1_P0, CM1_NB);
    const vb1Run = runS(vb1, VB1_P0, cV, null, { lag: 1, detail: true }), rm1Run = runS(RM1, RM1.P0, cV, null, { lag: 1, detail: true }), qvRun = runS(qv1, QV1_P0, cV, null, { lag: 1, detail: true }), cm1Run = runS(cm1, CM1_P0, cV, null, { lag: 1, detail: true }), d13l = d13Of("LV1", cV, Wx).base.res.run, rmsc = rm1scOf(cV, Wx);
    const gRun = verdicts.find((v) => v.id === "EG1")?.run as SimRun, mRun = verdicts.find((v) => v.id === "EGM1")?.run as SimRun;
    // ---- [R5] 나란히 비교 ----
    const cmpRows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [{ nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run }, { nm: "DS13L", run: d13l }, { nm: "RM1SC", run: rmsc.res.run }, { nm: "VB1", run: vb1Run }, { nm: "RM1", run: rm1Run }, { nm: "QV1", run: qvRun }, { nm: "EG1", run: gRun }, { nm: "EGM1", run: mRun }];
    console.log(`\n=== [R5] 같은 데이터(보정 적용 + 의심 종목-일 0% 처리) 기준 나란히 비교 (CAGR % / MDD %; 같은 시작일 ${from}~, 두 구간, RM1SC·RM1·DS13L·VB1·QV1은 같은 시작일로 새로 계산; DS6은 일별 40:60 재조정, DS13L·RM1SC는 월 1회 재조정; VB1·RM1·QV1·EG1·EGM1은 코어 없는 단독 전략) ===`);
    console.log(`| 구간 | ${cmpRows.map((r) => r.nm).join(" | ")} |\n|---|${cmpRows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${cmpRows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    const fl = cmpRows.map((r) => ({ nm: r.nm, s: h.st(r.run, Wx.FULL) }));
    console.log(`\n=== [R6] 연 회전율 % / 비용 합계 %(연속) ===\n${fl.map((x) => `${x.nm} ${f2(x.s.turnover)} / ${f2(x.s.cost)}`).join(" | ")}`);
    // ---- [R3] 연도별 069500·DS6·DS13L 대비 ----
    const bh = BH_FROM(from);
    for (const [nm, run] of [["EG1", gRun], ["EGM1", mRun]] as [string, SimRun][]) {
      console.log(`\n=== [R3] ${nm} 연도별 수익률 % ===\n| 연도 | 069500 | DS6 | DS13L | ${nm} | ${nm} − 069500 %p | ${nm} − DS6 %p | ${nm} − DS13L %p |\n|---|---|---|---|---|---|---|---|`);
      const ex: number[][] = [[], [], []];
      for (let y = Number(from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) {
        const a = h.yearRet(bh, y), c6 = h.yearRet({ dates: b6.res.run.dates.filter((d) => d >= from), ret: b6.res.run.ret.filter((_, k) => b6.res.run.dates[k] >= from) }, y), cl = h.yearRet(d13l, y), cc = h.yearRet(run, y);
        ex[0].push(cc - a); ex[1].push(cc - c6); ex[2].push(cc - cl);
        console.log(`| ${y} | ${f2(a)} | ${f2(c6)} | ${f2(cl)} | ${f2(cc)} | ${sg(cc - a)} | ${sg(cc - c6)} | ${sg(cc - cl)} |`);
      }
      console.log(`${nm} 승·패 연수: 069500 대비 승 ${ex[0].filter((x) => x > 0).length} / 패 ${ex[0].filter((x) => x < 0).length} (평균 ${sg(avg(ex[0]))}%p, 중앙값 ${sg(median(ex[0]))}%p) | DS6 대비 승 ${ex[1].filter((x) => x > 0).length} / 패 ${ex[1].filter((x) => x < 0).length} (평균 ${sg(avg(ex[1]))}%p) | DS13L 대비 승 ${ex[2].filter((x) => x > 0).length} / 패 ${ex[2].filter((x) => x < 0).length} (평균 ${sg(avg(ex[2]))}%p, 중앙값 ${sg(median(ex[2]))}%p)`);
    }
    // ---- [V3] 삼성전자·SK하이닉스 평균 비중(보유 일수 × 1/30 근사) ----
    console.log(`\n=== [V3] EG1·EGM1의 삼성전자·SK하이닉스 보유 일수와 평균 비중(보유 일수 비율 × 1/${EG1_P0.n}, 비중 표류·현금 무시 근사; 코어 없음) ===`);
    {
      const nDays = (gRun as unknown as RebalRun).dates.length;
      for (const code of V3_WATCH) {
        const a = (gRun as unknown as RebalRun).contrib.get(code), b = (mRun as unknown as RebalRun).contrib.get(code);
        console.log(`${label(code)} EG1: 보유 일수 ${a?.days ?? 0}/${nDays}일(구간 ${[...(gRun as unknown as RebalRun).trades, ...(gRun as unknown as RebalRun).open].filter((t) => t.code === code).length}건) 평균 비중(근사) ${f2((((a?.days ?? 0) / nDays) / EG1_P0.n) * 100)}% | EGM1: 보유 일수 ${b?.days ?? 0}/${nDays}일(구간 ${[...(mRun as unknown as RebalRun).trades, ...(mRun as unknown as RebalRun).open].filter((t) => t.code === code).length}건) 평균 비중(근사) ${f2((((b?.days ?? 0) / nDays) / EGM1_P0.n) * 100)}%`);
      }
    }
    // ---- [V4] VB1 MDD 구간 ----
    console.log(`\n=== [V4] VB1 MDD 구간(${win.from}~${win.to}) 구간 수익·낙폭(정보용; VB1 앞선 기록: 구간 복리 -63.31% / MDD 64.17%) ===`);
    {
      console.log("| 전략 | 구간 복리 수익 % | 구간 내 낙폭 MDD % | 연속 전체 MDD % |\n|---|---|---|---|");
      for (const r of cmpRows) { const ws = winStat(r.run, win.from, win.to); console.log(`| ${r.nm} | ${f2(ws.tot)} | ${f2(ws.mdd)} | ${f2(h.st(r.run, Wx.FULL).mdd)} |`); }
    }
    // ---- [V5] 하루 지연(C) ----
    console.log(`\n=== [V5] 하루 지연(C 관문, 진입·청산 +1거래일) 연속 CAGR·MDD 변화 — 각 시험의 "지연 버전" 줄과 같은 값을 다시 모은 요약 ===`);
    for (const [nm, def, P0, base] of [["EG1", eg1, EG1_P0, gRun], ["EGM1", egm1, EGM1_P0, mRun]] as [string, Strat<EgP>, EgP, SimRun][]) {
      const d2 = h.st(runS(def, P0, cV, null, { lag: 2, detail: true }), Wx.FULL), b = h.st(base, Wx.FULL);
      console.log(`${nm}: 기준 ${f2(b.cagr)} / ${f2(b.mdd)} → 지연 ${f2(d2.cagr)} / ${f2(d2.mdd)} (CAGR ${sg(d2.cagr - b.cagr)}%p, MDD ${sg(d2.mdd - b.mdd)}%p)`);
    }
    // ---- [V6] 일간 상관 ----
    console.log(`\n=== [V6] 일간 수익률 상관계수(공통 구간 ${from}~${h.dataEnd}, 정보용) ===`);
    {
      const mkSer = (name: string, r: { dates: string[]; ret: number[] }): { name: string; m: Map<string, number> } => ({ name, m: new Map(r.dates.map((d, i2) => [d, r.ret[i2]])) });
      const ser = [...cmpRows, { nm: "CM1", run: cm1Run }].map((r) => mkSer(r.nm, r.run));
      const dd = gRun.dates.filter((d) => d >= from && ser.every((x) => x.m.has(d)));
      const corr = (x: Map<string, number>, y: Map<string, number>): number => { const xs = dd.map((d) => x.get(d) as number), ys = dd.map((d) => y.get(d) as number), n = xs.length, mx = avg(xs), my = avg(ys); let sxy = 0, sxx = 0, syy = 0; for (let i2 = 0; i2 < n; i2++) { sxy += (xs[i2] - mx) * (ys[i2] - my); sxx += (xs[i2] - mx) ** 2; syy += (ys[i2] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
      console.log(`공통 ${dd.length}일\n| | ${ser.map((x) => x.name).join(" | ")} |\n|---|${ser.map(() => "---").join("|")}|`);
      for (const x of ser) console.log(`| ${x.name} | ${ser.map((y) => f2(corr(x.m, y.m))).join(" | ")} |`);
    }
    // ---- [E1] 평균 ROE·PBR · 금융주 비중 ----
    console.log(`\n=== [E1] 보유 종목 평균 ROE·PBR · 금융주 비중(월말 신호일 목표 종목, 근사: 이전 목표 = 보유; 금융 = KSIC ${Q_FIN_KSIC.join("·")}) ===`);
    {
      for (const [nm, pt] of [["EG1", pathTgG(eg1, cV)], ["EGM1", pathTgG(egm1, cV)], ["QV1", pathTgG(qv1, cV)], ["VB1", pathTgG(vb1, cV)]] as [string, { c: number; t: Map<string, number> }[]][]) {
        const rv: number[] = [], pv: number[] = [], cg: number[] = [];
        let nFin = 0, nAll = 0, nSigFin = 0;
        for (const { c, t } of pt) {
          let nf = 0;
          for (const code of t.keys()) {
            const r = roeOf(code, CAL[c], 400), x = pbrAt(c, h.byCode.get(code) as S, VB1_P0.maxAge), r0 = egPrevC(c) >= 0 ? roeOf(code, CAL[egPrevC(c)], 400) : { why: "no_report" };
            if (r.why === "ok") rv.push(r.roe as number);
            if (x.why === "ok") pv.push(x.pbr);
            if (r.why === "ok" && r0.why === "ok") cg.push((r.roe as number) - ((r0 as { roe: number }).roe));
            nAll++; if ((Q_FIN_KSIC as readonly string[]).includes((indOf.get(code) ?? "").slice(0, 2))) { nFin++; nf++; }
          }
          if (nf > 0) nSigFin++;
        }
        console.log(`${nm}: 평균 ROE ${f2(avg(rv) * 100)}%(중앙값 ${f2(median(rv) * 100)}%, ${rv.length}/${nAll}건) | 평균 ROE 변화 ${f2(avg(cg) * 100)}%p(중앙값 ${f2(median(cg) * 100)}%p, ${cg.length}건) | 평균 PBR ${f2(avg(pv))}(중앙값 ${f2(median(pv))}, PBR 계산 ${pv.length}/${nAll}건) | 금융주 비중 ${f2((nFin / Math.max(nAll, 1)) * 100)}%(보유 종목-월 ${nAll}건 중 ${nFin}건, 금융주가 1개 이상인 신호일 ${nSigFin}/${pt.length})`);
      }
    }
    // ---- [E2] 후보 집합 크기 · [E3] 제외 종목-월 비율 ----
    console.log(`\n=== [E2] 후보 집합 크기(월말 신호일 ${monthEndIdx.filter((x) => x >= cV).length}개) · [E3] 제외 종목-월 비율(BS1 적격 종목-월 기준) ===`);
    {
      const days = monthEndIdx.filter((x) => x >= cV), s1 = days.map((c) => egRowsAt(c, egPrevC(c)).length), s2 = days.map((c) => egmRowsAt(c, egPrevC(c)).length);
      console.log(`EG1 후보 수: 최소 ${Math.min(...s1)} · 평균 ${f2(avg(s1))} · 최대 ${Math.max(...s1)} | EGM1 후보 수: 최소 ${Math.min(...s2)} · 평균 ${f2(avg(s2))} · 최대 ${Math.max(...s2)} | 30개 미만 월 ${s1.filter((x) => x < 30).length} / ${s2.filter((x) => x < 30).length}개`);
      let nAll = 0, nNowBad = 0, nPrevBad = 0, nBothBad = 0, nBothOk = 0, nMomBad = 0;
      const whyNow = new Map<string, number>(), whyPrev = new Map<string, number>();
      for (const c of days) {
        const d = CAL[c], dp = CAL[egPrevC(c)];
        for (const code of bsElig(c, B5_BS_P0)) {
          const a = roeOf(code, d, 400), b = roeOf(code, dp, 400);
          nAll++;
          if (a.why !== "ok") { nNowBad++; whyNow.set(a.why, (whyNow.get(a.why) ?? 0) + 1); }
          if (b.why !== "ok") { nPrevBad++; whyPrev.set(b.why, (whyPrev.get(b.why) ?? 0) + 1); }
          if (a.why !== "ok" || b.why !== "ok") nBothBad++; else { nBothOk++; if (!Number.isFinite(rmScore(h.byCode.get(code) as S, c, EGM1_P0.rm))) nMomBad++; }
        }
      }
      const pc = (x: number): string => `${f2((x / Math.max(nAll, 1)) * 100)}%`;
      console.log(`적격 종목-월 ${nAll}건 중 EG1 제외(둘 중 하나라도 계산 불가) ${nBothBad}건 ${pc(nBothBad)} — 지금 ROE 불가 ${nNowBad}건 ${pc(nNowBad)}(${[...whyNow.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(" · ")}) · 1년 전 ROE 불가 ${nPrevBad}건 ${pc(nPrevBad)}(${[...whyPrev.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(" · ")}) | EGM1은 추가로 모멘텀 불가 ${nMomBad}건 ${pc(nMomBad)} 제외 → EGM1 제외 합계 ${pc(nBothBad + nMomBad)}(후보 ${nBothOk - nMomBad}건)`);
    }
  } else if (MODE === "rvtest") {
    if (!PRICE_CORRECTION_ON || !ZERO_SUSPECT_ON) throw new Error("보정 또는 의심 종목-일 0% 처리 미적용(correct=k200p17 zero=1 필요) — 시험하지 않고 중단해 보고한다");
    const rv = mkRV("RM1V", RV1_P0, RV1_NB), cS = startOf(rv, false), Wx = windowsFor(cS), from = Wx.FULL.from;
    if (cS !== startOf(RM1, false)) throw new Error("RM1V 첫 신호일 ≠ RM1 — 중단");
    console.log(`역변동성 비중 시험 설정: 시작 첫 신호일 ${CAL[cS]}(RM1과 같음), 데이터: K200P 17건 보정 적용 + 의심 종목-일 0% 처리 ${suspectLog.length}건(보정 후보 A), 소멸 관례 RM1과 같음(마지막 종가 청산)`);
    console.log(`연속 평가 공통: 첫 신호일 ${CAL[cS]}, 수익률 집계 ${from}~${h.dataEnd} | 구간 ${Wx.NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    const sigSet = new Set(monthEndIdx.filter((c) => c > cS).map((c) => CAL[c]));
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(RM1V, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkS(rv, "RM1V", trial, false, cS, Wx, "RM1V: RM1(K200P 잔차 모멘텀 상위 20, 순위 40 안이면 유지, 월말 신호)과 같고 비중만 직전 60거래일 일간 수익률 표준편차의 역수에 비례(합 100%, 종목당 상한 10%, 넘는 몫은 나머지에 재배분), 월 리밸 때만 조정")));
    }
    {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(RM1VC, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkC(rv, "RM1VC", trial, cS, Wx, "RM1VC: DS6 코어 40% + 위성 60% = RM1V, 월 리밸런스", sigSet)));
    }
    // ---- 기준 실행(보고용) ----
    const win = V3_MDD_WINDOW;
    const rm1Run = runS(RM1, RM1.P0, cS, null, { lag: 1, detail: true }), d13l = d13Of("LV1", cS, Wx).base.res.run, rmsc = rm1scOf(cS, Wx);
    const coreFull = sliceSl(coreOf(2, undefined, 1, {}).sl, from), rm1c = combine2(coreFull, slFromRun(rm1Run), B5_CORE_W, CS_MOVE_COST).run;
    const vRun = verdicts.find((v) => v.id === "RM1V")?.run as SimRun, vcRun = verdicts.find((v) => v.id === "RM1VC")?.run as SimRun;
    // ---- [R5] 나란히 비교 ----
    const cmpRows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [{ nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run }, { nm: "DS13L", run: d13l }, { nm: "RM1", run: rm1Run }, { nm: "RM1C", run: rm1c }, { nm: "RM1SC", run: rmsc.res.run }, { nm: "RM1V", run: vRun }, { nm: "RM1VC", run: vcRun }];
    console.log(`\n=== [R5] 같은 데이터(보정 적용 + 의심 종목-일 0% 처리) 기준 나란히 비교 (CAGR % / MDD %; 같은 시작일 ${from}~, DS13L·RM1SC는 같은 시작일로 새로 계산; DS6·RM1C는 일별 40:60 재조정, DS13L·RM1SC·RM1VC는 월 1회 재조정; RM1·RM1V는 코어 없는 단독) ===`);
    console.log(`| 구간 | ${cmpRows.map((r) => r.nm).join(" | ")} |\n|---|${cmpRows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${cmpRows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    const fl = cmpRows.map((r) => ({ nm: r.nm, s: h.st(r.run, Wx.FULL) }));
    console.log(`\n=== [R6] 연 회전율 % / 비용 합계 %(연속) ===\n${fl.map((x) => `${x.nm} ${f2(x.s.turnover)} / ${f2(x.s.cost)}`).join(" | ")}`);
    // ---- [R3] 연도별 069500·DS6·DS13L 대비 ----
    const bh = BH_FROM(from);
    for (const [nm, run] of [["RM1V", vRun], ["RM1VC", vcRun]] as [string, SimRun][]) {
      console.log(`\n=== [R3] ${nm} 연도별 수익률 % ===\n| 연도 | 069500 | DS6 | DS13L | ${nm} | ${nm} − 069500 %p | ${nm} − DS6 %p | ${nm} − DS13L %p |\n|---|---|---|---|---|---|---|---|`);
      const ex: number[][] = [[], [], []];
      for (let y = Number(from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) {
        const a = h.yearRet(bh, y), c6 = h.yearRet({ dates: b6.res.run.dates.filter((d) => d >= from), ret: b6.res.run.ret.filter((_, k) => b6.res.run.dates[k] >= from) }, y), cl = h.yearRet(d13l, y), cc = h.yearRet(run, y);
        ex[0].push(cc - a); ex[1].push(cc - c6); ex[2].push(cc - cl);
        console.log(`| ${y} | ${f2(a)} | ${f2(c6)} | ${f2(cl)} | ${f2(cc)} | ${sg(cc - a)} | ${sg(cc - c6)} | ${sg(cc - cl)} |`);
      }
      console.log(`${nm} 승·패 연수: 069500 대비 승 ${ex[0].filter((x) => x > 0).length} / 패 ${ex[0].filter((x) => x < 0).length} (평균 ${sg(avg(ex[0]))}%p, 중앙값 ${sg(median(ex[0]))}%p) | DS6 대비 승 ${ex[1].filter((x) => x > 0).length} / 패 ${ex[1].filter((x) => x < 0).length} (평균 ${sg(avg(ex[1]))}%p) | DS13L 대비 승 ${ex[2].filter((x) => x > 0).length} / 패 ${ex[2].filter((x) => x < 0).length} (평균 ${sg(avg(ex[2]))}%p, 중앙값 ${sg(median(ex[2]))}%p)`);
    }
    // ---- [V3] 삼성전자·SK하이닉스 평균 비중(월말 목표 비중의 평균; RM1VC는 코어 40% 포함) ----
    console.log(`\n=== [V3] RM1·RM1V·RM1VC의 삼성전자·SK하이닉스 평균 비중(위성: 월말 신호일 목표 비중의 평균(미보유 월은 0), 이전 목표 = 보유 근사; RM1VC 코어는 DS6 코어 목표 비중 평균) ===`);
    {
      const coreRun = coreOf(2, undefined, 1, {}).run, ptR = pathTgG(RM1, cS), ptV = pathTgG(rv, cS), cnt = (pt: { c: number; t: Map<string, number> }[], code: string): { avg: number; months: number } => ({ avg: avg(pt.map((x) => x.t.get(code) ?? 0)), months: pt.filter((x) => x.t.has(code)).length });
      for (const code of V3_WATCH) {
        const a = cnt(ptR, code), b = cnt(ptV, code);
        let wCore = 0, k = 0;
        for (let c = cS; c < CAL.length; c++) { const ev = [...coreRun.events].filter((e) => e.c <= c + 1).pop(); wCore += ev ? (ev.w[ev.set.indexOf(code)] ?? 0) : 0; k++; }
        console.log(`${label(code)} RM1: 목표에 있던 월말 ${a.months}/${ptR.length}개 평균 비중 ${f2(a.avg * 100)}% | RM1V: ${b.months}/${ptV.length}개 평균 비중 ${f2(b.avg * 100)}% | RM1VC = 코어 40% × ${f2((wCore / k) * 100)} + 위성 60% × ${f2(b.avg * 100)} = ${f2(0.4 * (wCore / k) * 100 + 0.6 * b.avg * 100)}%`);
      }
    }
    // ---- [RV1] 평균 상한 도달 종목 수·비중 범위 · [RV2] 변동성 불가 ----
    console.log(`\n=== [RV1] 월말 목표 비중표의 상한 도달 종목 수·비중 범위(이전 목표 = 보유 근사) · [RV2] 변동성 불가 종목 ===`);
    {
      const sets: [string, RvP][] = [["기본(창 60일·상한 10%)", RV1_P0], ...RV1_NB.map(([lb, ch]) => [lb, { ...RV1_P0, ...ch }] as [string, RvP])];
      for (const [lb, P] of sets) {
        const days = monthEndIdx.filter((x) => x >= cS), capped: number[] = [], nNames: number[] = [], wMin: number[] = [], wMax: number[] = [], nFb: number[] = [];
        let held: ReadonlySet<string> = new Set();
        for (const c of days) {
          const t = rv.targets(c, held, P, 1, true), w = [...t.values()];
          capped.push(w.filter((x) => x >= P.cap - 1e-9).length); nNames.push(w.length); wMin.push(Math.min(...w)); wMax.push(Math.max(...w));
          nFb.push([...t.keys()].filter((code) => !Number.isFinite(rvVol(code, c, P.volWin))).length);
          held = new Set(t.keys());
        }
        console.log(`${lb}: 월말 ${days.length}개 | 상한 도달 종목 수 평균 ${f2(avg(capped))}개(최소 ${Math.min(...capped)}·최대 ${Math.max(...capped)}), 상한 도달 종목이 하나도 없는 월 ${capped.filter((x) => x === 0).length}개 | 목표 종목 수 평균 ${f2(avg(nNames))} | 비중 최소 평균 ${f2(avg(wMin) * 100)}%·최대 평균 ${f2(avg(wMax) * 100)}% | 변동성 불가 종목 ${nFb.reduce((a, x) => a + x, 0)}건`);
      }
    }
    // ---- [V4] VB1 MDD 구간 ----
    console.log(`\n=== [V4] VB1 MDD 구간(${win.from}~${win.to}) 구간 수익·낙폭(정보용; VB1 앞선 기록: 구간 복리 -63.31% / MDD 64.17%) ===`);
    {
      console.log("| 전략 | 구간 복리 수익 % | 구간 내 낙폭 MDD % | 연속 전체 MDD % |\n|---|---|---|---|");
      for (const r of cmpRows) { const ws = winStat(r.run, win.from, win.to); console.log(`| ${r.nm} | ${f2(ws.tot)} | ${f2(ws.mdd)} | ${f2(h.st(r.run, Wx.FULL).mdd)} |`); }
    }
    // ---- [V5] 하루 지연(C) ----
    console.log(`\n=== [V5] 하루 지연(C 관문, 진입·청산 +1거래일) 연속 CAGR·MDD 변화 — 각 시험의 "지연 버전" 줄과 같은 값을 다시 모은 요약 ===`);
    {
      const dl = rvcOf(cS, Wx, { lag: 2 }), b = h.st(vRun, Wx.FULL), d2 = h.st(dl.sat, Wx.FULL), bc = h.st(vcRun, Wx.FULL), dc = h.st(dl.res.run, Wx.FULL);
      console.log(`RM1V: 기준 ${f2(b.cagr)} / ${f2(b.mdd)} → 지연 ${f2(d2.cagr)} / ${f2(d2.mdd)} (CAGR ${sg(d2.cagr - b.cagr)}%p, MDD ${sg(d2.mdd - b.mdd)}%p)`);
      console.log(`RM1VC: 기준 ${f2(bc.cagr)} / ${f2(bc.mdd)} → 지연 ${f2(dc.cagr)} / ${f2(dc.mdd)} (CAGR ${sg(dc.cagr - bc.cagr)}%p, MDD ${sg(dc.mdd - bc.mdd)}%p)`);
    }
    // ---- [V6] 일간 상관 ----
    console.log(`\n=== [V6] 일간 수익률 상관계수(공통 구간 ${from}~${h.dataEnd}, 정보용) ===`);
    {
      const mkSer = (name: string, r: { dates: string[]; ret: number[] }): { name: string; m: Map<string, number> } => ({ name, m: new Map(r.dates.map((d, i2) => [d, r.ret[i2]])) });
      const ser = cmpRows.map((r) => mkSer(r.nm, r.run));
      const dd = vRun.dates.filter((d) => d >= from && ser.every((x) => x.m.has(d)));
      const corr = (x: Map<string, number>, y: Map<string, number>): number => { const xs = dd.map((d) => x.get(d) as number), ys = dd.map((d) => y.get(d) as number), n = xs.length, mx = avg(xs), my = avg(ys); let sxy = 0, sxx = 0, syy = 0; for (let i2 = 0; i2 < n; i2++) { sxy += (xs[i2] - mx) * (ys[i2] - my); sxx += (xs[i2] - mx) ** 2; syy += (ys[i2] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
      console.log(`공통 ${dd.length}일\n| | ${ser.map((x) => x.name).join(" | ")} |\n|---|${ser.map(() => "---").join("|")}|`);
      for (const x of ser) console.log(`| ${x.name} | ${ser.map((y) => f2(corr(x.m, y.m))).join(" | ")} |`);
    }
  } else if (MODE === "ds15test") {
    if (!PRICE_CORRECTION_ON || !ZERO_SUSPECT_ON) throw new Error("보정 또는 의심 종목-일 0% 처리 미적용(correct=k200p17 zero=1 필요) — 시험하지 않고 중단해 보고한다");
    const cS = startOf(RM1, false), Wx = windowsFor(cS), from = Wx.FULL.from;
    if (from !== "2011-02-01") throw new Error(`수익률 집계 시작 ${from} ≠ 2011-02-01 — 중단`);
    console.log(`DS15 시험 설정: 첫 신호일 ${CAL[cS]}(RM1·DS13과 같음), 데이터: K200P 17건 보정 적용 + 의심 종목-일 0% 처리 ${suspectLog.length}건(보정 후보 A), 하위 계좌 40/30/30 월 재조정`);
    console.log(`연속 평가 공통: 첫 신호일 ${CAL[cS]}, 수익률 집계 ${from}~${h.dataEnd} | 구간 ${Wx.NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
    const handles = new Map<string, ReturnType<typeof d15Of>>();
    for (const [id, kind, ttl] of [["DS15L", "LV1", "코어 40%(DS6 코어) + 모멘텀 위성 30%(RM1S = RM1 + 최고 종가 대비 -20% 손절) + 저위험 위성 30%(LV1 = DS6 위성 축소), 매월 하위 계좌 40/30/30 재조정"], ["DS15M", "MV1", "코어 40%(DS6 코어) + 모멘텀 위성 30%(RM1S) + 저위험 위성 30%(MV1 최소분산), 매월 하위 계좌 40/30/30 재조정"]] as const) {
      const trial = tn++;
      trialNums.push(trial);
      console.log(`\n연속 평가(${id}, 시험 ${trial})`);
      verdicts.push(evaluate(h, Wx, mkD15(id, trial, kind, cS, Wx, ttl)));
      handles.set(id, d15Of(kind, cS, Wx));
    }
    // ---- 기준 실행(보고용) ----
    const win = V3_MDD_WINDOW, dL = d13Of("LV1", cS, Wx), dM = d13Of("MV1", cS, Wx), rmsc = rm1scOf(cS, Wx);
    const gL = verdicts.find((v) => v.id === "DS15L")?.run as SimRun, gM = verdicts.find((v) => v.id === "DS15M")?.run as SimRun;
    const cmpRows: { nm: string; run: { dates: string[]; ret: number[] } }[] = [{ nm: "069500", run: { dates: h.bhP.dates, ret: h.bhP.ret } }, { nm: "DS6", run: b6.res.run }, { nm: "DS13L", run: dL.base.res.run }, { nm: "DS13M", run: dM.base.res.run }, { nm: "RM1SC", run: rmsc.res.run }, { nm: "DS15L", run: gL }, { nm: "DS15M", run: gM }];
    console.log(`\n=== [R5] 같은 데이터(보정 적용 + 의심 종목-일 0% 처리) 기준 나란히 비교 (CAGR % / MDD %; 같은 시작일 ${from}~, 모두 같은 시작일로 새로 계산; DS6은 일별 40:60 재조정, 나머지는 월 1회 재조정) ===`);
    console.log(`| 구간 | ${cmpRows.map((r) => r.nm).join(" | ")} |\n|---|${cmpRows.map(() => "---").join("|")}|`);
    for (const [nm, w] of Wx.ALL) console.log(`| ${nm} | ${cmpRows.map((r) => `${f2(h.st(r.run, w).cagr)} / ${f2(h.st(r.run, w).mdd)}`).join(" | ")} |`);
    const fl = cmpRows.map((r) => ({ nm: r.nm, s: h.st(r.run, Wx.FULL) }));
    console.log(`\n=== [R6] 연 회전율 % / 비용 합계 %(연속) ===\n${fl.map((x) => `${x.nm} ${f2(x.s.turnover)} / ${f2(x.s.cost)}`).join(" | ")}`);
    // ---- [R3] 연도별 069500·DS6·DS13L 대비 ----
    const bh = BH_FROM(from);
    for (const [nm, run] of [["DS15L", gL], ["DS15M", gM]] as [string, SimRun][]) {
      console.log(`\n=== [R3] ${nm} 연도별 수익률 % ===\n| 연도 | 069500 | DS6 | DS13L | RM1SC | ${nm} | ${nm} − 069500 %p | ${nm} − DS6 %p | ${nm} − DS13L %p |\n|---|---|---|---|---|---|---|---|---|`);
      const ex: number[][] = [[], [], []];
      for (let y = Number(from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) {
        const a = h.yearRet(bh, y), c6 = h.yearRet({ dates: b6.res.run.dates.filter((d) => d >= from), ret: b6.res.run.ret.filter((_, k) => b6.res.run.dates[k] >= from) }, y), cl = h.yearRet(dL.base.res.run, y), cr = h.yearRet(rmsc.res.run, y), cc = h.yearRet(run, y);
        ex[0].push(cc - a); ex[1].push(cc - c6); ex[2].push(cc - cl);
        console.log(`| ${y} | ${f2(a)} | ${f2(c6)} | ${f2(cl)} | ${f2(cr)} | ${f2(cc)} | ${sg(cc - a)} | ${sg(cc - c6)} | ${sg(cc - cl)} |`);
      }
      console.log(`${nm} 승·패 연수: 069500 대비 승 ${ex[0].filter((x) => x > 0).length} / 패 ${ex[0].filter((x) => x < 0).length} (평균 ${sg(avg(ex[0]))}%p, 중앙값 ${sg(median(ex[0]))}%p) | DS6 대비 승 ${ex[1].filter((x) => x > 0).length} / 패 ${ex[1].filter((x) => x < 0).length} (평균 ${sg(avg(ex[1]))}%p) | DS13L 대비 승 ${ex[2].filter((x) => x > 0).length} / 패 ${ex[2].filter((x) => x < 0).length} (평균 ${sg(avg(ex[2]))}%p, 중앙값 ${sg(median(ex[2]))}%p)`);
      console.log(`${nm} 2025·2026년 069500 대비: 2025 ${f2(h.yearRet(run, 2025))}% vs ${f2(h.yearRet(bh, 2025))}%(${sg(h.yearRet(run, 2025) - h.yearRet(bh, 2025))}%p) | 2026 ${f2(h.yearRet(run, 2026))}% vs ${f2(h.yearRet(bh, 2026))}%(${sg(h.yearRet(run, 2026) - h.yearRet(bh, 2026))}%p)`);
    }
    // ---- [V1] 손절 발동 횟수와 손절 후 21거래일 수익(모멘텀 위성, DS15L·DS15M 공통) ----
    console.log(`\n=== [V1] 모멘텀 위성(RM1S) 손절 발동 횟수와 손절 후 21거래일 수익(손절 체결일 종가 → 이후 ${S_NEXT_MONTH_DAYS}거래일 종가, 수정 종가 수익률; 양수 = 손절 뒤 오른 것 = 손절이 틀림, 음수 = 더 내림 = 손절이 맞음) — DS15L·DS15M 공통 위성 ===`);
    {
      const yrs = (Date.parse(h.dataEnd) - Date.parse(from)) / 86_400_000 / 365.25, rmsX = mkRMS("RM1S", RM1S_P0, RM1S_NB);
      for (const [lb, ch] of [["손절 -20%(기본)", {}], ...RM1S_NB] as [string, Partial<RmsP>][]) {
        runS(rmsX, { ...RM1S_P0, ...ch }, cS, null, { lag: 1, detail: true });
        const ev = [...rmsLog], rv = ev.map(stopNext).filter((x) => Number.isFinite(x)), byY = new Map<string, number>();
        for (const e of ev) byY.set(CAL[e.c].slice(0, 4), (byY.get(CAL[e.c].slice(0, 4)) ?? 0) + 1);
        console.log(`${lb}: 발동 ${ev.length}건(연 평균 ${f2(ev.length / yrs)}건) | 손절 후 21거래일 수익 평균 ${f2(avg(rv) * 100)}%·중앙값 ${f2(median(rv) * 100)}% (${rv.length}건) | 양수(손절이 틀림) ${rv.filter((x) => x > 0).length}건 ${f2((rv.filter((x) => x > 0).length / Math.max(rv.length, 1)) * 100)}% · 음수(손절이 맞음) ${rv.filter((x) => x < 0).length}건 ${f2((rv.filter((x) => x < 0).length / Math.max(rv.length, 1)) * 100)}% | 연도별 ${[...byY.entries()].sort().map(([y, n]) => `${y} ${n}`).join(" · ")}`);
      }
    }
    // ---- [V3] 삼성전자·SK하이닉스 평균 비중(코어 + 위성 합산, 월말 신호일 목표 기준 근사) ----
    console.log(`\n=== [V3] DS15L·DS15M의 삼성전자·SK하이닉스 평균 비중(월말 신호일 평균, 계좌 기준 %; 코어는 교체 이벤트 시점 비중, 모멘텀 위성은 RM1 월말 목표 비중으로 근사(손절 제외 미반영), 저위험 위성 LV1은 투자 비중 ÷ 보유 종목 수·MV1은 목표 비중) ===`);
    {
      const ptRm = pathTgG(RM1, cS), ptMv = pathTgG(MV1, cS);
      for (const [id, kind] of [["DS15L", "LV1"], ["DS15M", "MV1"]] as const) {
        const b = (handles.get(id) as ReturnType<typeof d15Of>).base, W0 = DS13_W, lowSl = b.sls[2], lv = b.low as RebalRun;
        for (const code of DS13_WATCH) {
          let sc = 0, sr = 0, sl2 = 0, nSig = 0;
          for (let jj = 0; jj < ptRm.length; jj++) {
            const c = ptRm[jj].c; nSig++;
            const ev = [...b.core.events].filter((e) => e.c <= c + 1).pop(), wCore = ev ? (ev.w[ev.set.indexOf(code)] ?? 0) : 0;
            sc += wCore; sr += ptRm[jj].t.get(code) ?? 0;
            if (kind === "MV1") sl2 += ptMv[jj]?.t.get(code) ?? 0;
            else { const di = lowSl.dates.indexOf(CAL[c + 1]); const held = lv.trades.filter((t) => t.entryC < c + 1 && c + 1 <= t.exitC).map((t) => t.code); if (di >= 0 && held.includes(code)) sl2 += lowSl.inv[di] / Math.max(held.length, 1); }
          }
          console.log(`${id} ${label(code)}: 코어 ${f2((sc / nSig) * W0[0] * 100)} + 모멘텀 위성 ${f2((sr / nSig) * W0[1] * 100)} + 저위험 위성 ${f2((sl2 / nSig) * W0[2] * 100)} = ${f2(((sc / nSig) * W0[0] + (sr / nSig) * W0[1] + (sl2 / nSig) * W0[2]) * 100)}% (월말 신호일 ${nSig}개)`);
        }
      }
    }
    // ---- [V4] VB1 MDD 구간 ----
    console.log(`\n=== [V4] VB1 MDD 구간(${win.from}~${win.to}) 구간 수익·낙폭(정보용; VB1 앞선 기록: 구간 복리 -63.31% / MDD 64.17%) ===`);
    {
      console.log("| 전략 | 구간 복리 수익 % | 구간 내 낙폭 MDD % | 연속 전체 MDD % |\n|---|---|---|---|");
      for (const r of cmpRows) { const ws = winStat(r.run, win.from, win.to); console.log(`| ${r.nm} | ${f2(ws.tot)} | ${f2(ws.mdd)} | ${f2(h.st(r.run, Wx.FULL).mdd)} |`); }
    }
    // ---- [V5] 하루 지연(C) ----
    console.log(`\n=== [V5] 하루 지연(C 관문, 진입·청산 +1거래일) 연속 CAGR·MDD 변화 — 각 시험의 "지연 버전" 줄과 같은 값을 다시 모은 요약 ===`);
    for (const [id, base] of [["DS15L", gL], ["DS15M", gM]] as [string, SimRun][]) {
      const d2 = h.st((handles.get(id) as ReturnType<typeof d15Of>).build({ lag: 2 }).res.run, Wx.FULL), b = h.st(base, Wx.FULL);
      console.log(`${id}: 기준 ${f2(b.cagr)} / ${f2(b.mdd)} → 지연 ${f2(d2.cagr)} / ${f2(d2.mdd)} (CAGR ${sg(d2.cagr - b.cagr)}%p, MDD ${sg(d2.mdd - b.mdd)}%p)`);
    }
    // ---- [V6] 일간 상관 ----
    console.log(`\n=== [V6] 일간 수익률 상관계수(공통 구간 ${from}~${h.dataEnd}, 정보용) ===`);
    {
      const mkSer = (name: string, r: { dates: string[]; ret: number[] }): { name: string; m: Map<string, number> } => ({ name, m: new Map(r.dates.map((d, i2) => [d, r.ret[i2]])) });
      const ser = cmpRows.map((r) => mkSer(r.nm, r.run));
      const dd = gL.dates.filter((d) => d >= from && ser.every((x) => x.m.has(d)));
      const corr = (x: Map<string, number>, y: Map<string, number>): number => { const xs = dd.map((d) => x.get(d) as number), ys = dd.map((d) => y.get(d) as number), n = xs.length, mx = avg(xs), my = avg(ys); let sxy = 0, sxx = 0, syy = 0; for (let i2 = 0; i2 < n; i2++) { sxy += (xs[i2] - mx) * (ys[i2] - my); sxx += (xs[i2] - mx) ** 2; syy += (ys[i2] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
      console.log(`공통 ${dd.length}일\n| | ${ser.map((x) => x.name).join(" | ")} |\n|---|${ser.map(() => "---").join("|")}|`);
      for (const x of ser) console.log(`| ${x.name} | ${ser.map((y) => f2(corr(x.m, y.m))).join(" | ")} |`);
    }

  }
  summaryReport(verdicts, trialNums, { prior: Number(process.env.B5_TRIAL ?? "294") - 1, contamNote: "경고(오염): 2011~2026은 선행 연구에서 반복해 본 데이터다. 변형(F·C 형태)은 DS6·DS7·DS10 결과를 본 뒤 만든 것(선택 편향)이라 순수 검증이 아니다." });
  if (PRICE_CORRECTION_ON) console.log("※ 보정 재채점: 아래 누적 시험 횟수·기대 건수는 원 시험 번호 기준 표기이며 이 재채점은 누적 시험 308에 더하지 않는다(사용자 지정).");
  console.log(`사전 고지: 이 묶음 누적 시험 ${Number(process.env.B5_TRIAL ?? "294") - 1 + trialNums.length}회 기준 우연 통과 기대 ${((Number(process.env.B5_TRIAL ?? "294") - 1 + trialNums.length) * 0.05).toFixed(2)}건(근사). 통과 후보가 있어도 독립 확인 전에는 후보일 뿐이다. 정의는 첫 시험 전에 고정했고 결과를 보고 바꾸지 않았다.`);
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ") || "없음"} | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험 번호 ${trialNums.join(",")}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

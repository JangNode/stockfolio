/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 묶음 2(R1~R4, 시도 282~285). 사전 등록: docs/research/batch2-prereg.md.
 * R1 강한 마감 / R2 코스피·코스닥 대형주 로테이션 / R3 신저가 후 V자 / R4 잔차 모멘텀.
 * R1·R3·R4는 공용 슬롯 시뮬레이터(lib/slotSim.ts, 수정 없음)에서 후보·청산 훅만 다르고, R2는 DS6 코어(scripts/research-ds89.ts simCore)와 같은 시총 비율 보유 시뮬레이터를 쓴다.
 * ALLOC_MODE=repro: 신호 독립 대조(과거 이력만 쓰는 브루트포스와 매일 비교 = 미래 정보 점검 겸용)·체결 타이밍·구조 통계만 하고 성과는 계산·출력하지 않는다 / r1|r2|r3|r4: 해당 가설 시험 1회. 공시·DART 사용 없음.
 */
import { simSlots, type SimCand, type SimHooks, type SimPos, type SimRun, type SimTrade } from "@/lib/slotSim";
import { L_SLIPPAGE } from "@/lib/megacapTrendConfig";
import { alignCloses } from "@/lib/le2VolTarget";
import { PEAD_H_CAGR_GAIN_PP, PEAD_H_MDD_GAIN_PP, PEAD_H_MDD_GAIN_STRONG_PP, PEAD_H_CAGR_FLOOR_PP } from "@/lib/peadConfig";
import { KSS_R3_DRAWS, KSS_R3_SEED } from "@/lib/kodexSectorSatConfig";
import { DS89_RUN_START, DS89_WINDOWS, DS89_SAMSUNG } from "@/lib/ds89Config";
import { CS_SWAP_CONFIRM_DAYS } from "@/lib/coreSatelliteConfig";
import { B2_PRIOR_TESTS, B2_TRIALS, B2_RANK_DEPTH, B2_OUT_RANK, B2_R1_P0, B2_R1_NB, B2_R2_P0, B2_R2_NB, B2_R2_SWAP_CONFIRM, B2_R3_P0, B2_R3_NB, B2_R4_P0, B2_R4_NB, B2_F_DENOMINATOR, B2_DS6_REC, B2_DS6_YEARLY, type B2P } from "@/lib/batch2Config";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, mulberry32, SNAP_END, f2, avg, median, type S, type Win } from "./researchHarness";
import { evaluate, summaryReport, type CandSpec, type Verdict, type Windows } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
type Ex = ReadonlySet<string> | undefined;
type Mkt = "KOSPI" | "KOSDAQ";
interface QDef {
  id: string; trial: number; P0: B2P; nbs: [string, B2P][]; reasons: string[];
  slots: (P: B2P) => number;
  title: (P: B2P) => string;
  /** 판단일 c 종가의 후보(우선순위 순). */
  signals: (c: number, P: B2P, ex: Ex) => S[];
  /** 게이트 F 무작위 진입의 후보 풀. */
  pool: (c: number, P: B2P, ex: Ex) => S[];
  /** 청산 판단(판단일 c 종가, i = 그날 종목 행). lag = 체결 지연(1 = 다음 거래일). */
  exit: (p: SimPos, c: number, i: number | undefined, P: B2P, lag: number) => string | null;
  /** R4: 게이트 F의 청산을 실제 거래 보유 일수 분포에서 뽑은 보유 일수로 한다. */
  randomHold?: boolean;
}
interface MPos { code: string; s: S; shares: number; lastPx: number; entryC: number; spend: number; vAtEntry: number; rep: boolean; repVal: number; realized: number; out: number }
interface MEvent { sigC: number; c: number; kind: "첫 매수" | "전환" | "교체"; mk: number; sells: string[]; buys: string[] }
type MRun = SimRun & { events: MEvent[]; open: SimTrade[] };

async function main(): Promise<void> {
  const MODE = (process.env.ALLOC_MODE ?? "").trim().toLowerCase();
  if (!["repro", "r1", "r2", "r3", "r4"].includes(MODE)) throw new Error("ALLOC_MODE=repro|r1|r2|r3|r4 필요");
  const REPRO = MODE === "repro";
  console.log(`연구 묶음 2(R1~R4, 시도 ${B2_TRIALS.r1}~${B2_TRIALS.r4}) ${REPRO ? "사전 점검(신호 독립 대조·체결 타이밍·구조 통계만, 성과 미계산)" : `시험 ${MODE.toUpperCase()} 1회`} 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, nameOf } = await loadK200P(h);

  // ---- 평가 구간 (묶음 1과 같음) ----
  const cPE = CAL.findIndex((d) => d >= DS89_RUN_START);
  if (cPE < 0 || CAL[cPE] !== DS89_RUN_START) throw new Error(`${DS89_RUN_START}이 거래일 달력에 없음`);
  const NW: [string, Win][] = DS89_WINDOWS.map(([n, f, t]) => [n, { from: f, to: t }]);
  const FULL: Win = { from: CAL[cPE + 1], to: "9999-12-31" };
  if (NW[0][1].from !== FULL.from) throw new Error(`구간 1 시작 ${NW[0][1].from}이 연속 평가 시작 ${FULL.from}과 다르다`);
  const W: Windows = { NW, FULL, ALL: [...NW, ["연속 전체 2011-01~2026-10", FULL]], noEx26: true, contamNote: "경고(오염): 이 구간 전체(2011~2026)는 DS6·DS4·LV1 등 선행 연구에서 이미 반복해 본 데이터다. 묶음 2의 가설은 묶음 1과 DS6 계열 결과를 본 뒤 정한 것이라 순수 검증이 아니다." };
  const ALLW = W.ALL;
  console.log(`연속 평가: 초기 ${CAL[cPE]} 종가 기준, 수익률 집계 ${FULL.from}~${h.dataEnd} | 구간 ${NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
  console.log(`\n=== 0. 069500 기준선 (원주가, 가격 수익만; 기준선 시작일 = 구간 시작일) ===\n| 구간 | 기준선 첫 수익률 날짜 | CAGR % / MDD % |\n|---|---|---|`);
  for (const [wn, w] of ALLW) { const b = h.st(h.bhP, w); console.log(`| ${wn} | ${h.bhP.dates.find((d) => d >= w.from)} | ${f2(b.cagr)} / ${f2(b.mdd)} |`); }
  const bhAsRun = { dates: h.bhP.dates.filter((d) => d >= FULL.from), ret: h.bhP.ret.filter((_, k) => h.bhP.dates[k] >= FULL.from) } as unknown as SimRun;
  const bRetAxis = (() => { const m = new Map(h.bhP.dates.map((d, i) => [d, h.bhP.ret[i]])); return CAL.slice(cPE + 1).map((d) => m.get(d) as number); })();
  const env = (cS: number) => ({ CAL, nCal, cS, adjustments: h.adjustments, endedBefore: h.endedBefore, stockBuyMult: h.stockBuyMult, sellRate: h.sellRate, baseSlip: SLIPPAGE_PCT_PER_SIDE, bhRet: h.bhRet });
  const label = (code: string): string => `${code} ${nameOf.get(code) ?? "?"}`;

  // ---- 시장별 시총 순위 목록(깊이 200)·수정 종가 정렬·이동평균 ----
  const rankCache = new Map<string, { list: S[]; rank: Map<string, number> }>();
  const rankMkt = (c: number, mkt: Mkt): { list: S[]; rank: Map<string, number> } => {
    const key = `${mkt}|${c}`;
    let v = rankCache.get(key);
    if (!v) {
      const d = CAL[c], m = membAt(d), e: { s: S; mc: number }[] = [];
      if (m) for (const s of h.stocks) {
        const i = s.idx.get(d);
        if (i === undefined || excluded.has(s.code) || m.get(s.code) !== mkt) continue;
        e.push({ s, mc: s.mcapRow[i] });
      }
      e.sort((a, b) => b.mc - a.mc || (a.s.code < b.s.code ? -1 : 1));
      const list = e.slice(0, B2_RANK_DEPTH).map((x) => x.s);
      v = { list, rank: new Map(list.map((s, k) => [s.code, k + 1])) };
      rankCache.set(key, v);
    }
    return v;
  };
  const rankAt = (c: number): { list: S[]; rank: Map<string, number> } => rankMkt(c, "KOSPI");
  const alignedCache = new Map<string, Float64Array>(), prefCache = new Map<string, Float64Array>();
  const alignedOf = (code: string): Float64Array => { let a = alignedCache.get(code); if (!a) { const s = byCode.get(code) as S; a = alignCloses(CAL, s.idx, s.close); alignedCache.set(code, a); } return a; };
  const smaAt = (s: S, c: number, ma: number): number => {
    const a = alignedOf(s.code);
    if (c - ma + 1 < 0 || !(a[c - ma + 1] > 0)) return Number.NaN;
    let p = prefCache.get(s.code);
    if (!p) { p = new Float64Array(nCal + 1); for (let k = 0; k < nCal; k++) p[k + 1] = p[k] + (a[k] > 0 ? a[k] : 0); prefCache.set(s.code, p); }
    return (p[c + 1] - p[c + 1 - ma]) / ma;
  };
  const holdDone = (p: SimPos, c: number, hold: number, lag: number): boolean => c >= p.entryC + hold - lag;
  const tvOf = (s: S, i: number): number => s.raw[i] * s.vol[i];
  const rowLive = (s: S, c: number): number | undefined => { const i = s.idx.get(CAL[c]); return i !== undefined && s.vol[i] > 0 ? i : undefined; };

  // ---- R1: 강한 마감 ----
  const R1: QDef = {
    id: "R1", trial: B2_TRIALS.r1, P0: B2_R1_P0, nbs: B2_R1_NB, reasons: ["보유 만료"], slots: (P) => P.slots,
    title: (P) => `R1: K200P 중 종가 위치 ≥ ${P.pos}, 당일 거래대금 ≥ 직전 ${P.avgWin}행 평균의 ${P.vol}배, 종가 > ${P.ma}일선인 종목을 다음 거래일 종가에 매수, ${P.hold}거래일 보유, 슬롯 ${P.slots}개`,
    signals: (c, P, ex) => {
      const out: { s: S; tv: number }[] = [];
      for (const s of rankAt(c).list) {
        if (ex?.has(s.code)) continue;
        const i = rowLive(s, c);
        if (i === undefined) continue;
        const hi = s.high[i], lo = s.low[i], cl = s.close[i];
        if (!(hi > lo) || (cl - lo) / (hi - lo) < P.pos) continue;
        if (i < P.avgWin) continue;
        let sum = 0;
        for (let k = i - P.avgWin; k < i; k++) sum += tvOf(s, k);
        const av = sum / P.avgWin, tv = tvOf(s, i);
        if (!(av > 0) || tv < P.vol * av) continue;
        const m = smaAt(s, c, P.ma);
        if (!(cl > m)) continue;
        out.push({ s, tv });
      }
      out.sort((a, b) => b.tv - a.tv || (a.s.code < b.s.code ? -1 : 1));
      return out.map((x) => x.s);
    },
    pool: (c, _P, ex) => rankAt(c).list.filter((s) => !ex?.has(s.code) && rowLive(s, c) !== undefined),
    exit: (p, c, _i, P, lag) => (holdDone(p, c, P.hold, lag) ? "보유 만료" : null),
  };

  // ---- R3: 신저가 후 V자 ----
  const flagCache = new Map<string, Uint8Array>();
  /** 날 k의 수정 종가가 직전 low−1거래일 수정 종가 최솟값보다 엄격히 작고 low일 이력이 모두 있으면 1(슬라이딩 최솟값). */
  const newLowFlags = (s: S, low: number): Uint8Array => {
    const key = `${s.code}|${low}`;
    let f = flagCache.get(key);
    if (!f) {
      const a = alignedOf(s.code), dq = new Int32Array(nCal);
      f = new Uint8Array(nCal);
      let head = 0, tail = 0;
      for (let k = 0; k < nCal; k++) {
        if (k >= 1) { const j = k - 1; if (a[j] > 0) { while (tail > head && a[dq[tail - 1]] >= a[j]) tail--; dq[tail++] = j; } }
        while (tail > head && dq[head] < k - low + 1) head++;
        if (k - low + 1 >= 0 && a[k - low + 1] > 0 && a[k] > 0 && tail > head && a[k] < a[dq[head]]) f[k] = 1;
      }
      flagCache.set(key, f);
    }
    return f;
  };
  const R3: QDef = {
    id: "R3", trial: B2_TRIALS.r3, P0: B2_R3_P0, nbs: B2_R3_NB, reasons: ["이평 이탈", "보유 만료"], slots: (P) => P.slots,
    title: (P) => `R3: K200P 중 최근 ${P.within}거래일 안에 ${P.low}일 신저가를 찍고 종가가 그 저점 대비 +${f2(P.rec * 100)}% 이상 회복, 종가 > ${P.ma}일선인 종목을 다음 거래일 종가에 매수, ${P.ma}일선 아래 종가 또는 ${P.timeout}거래일 후 청산, 슬롯 ${P.slots}개`,
    signals: (c, P, ex) => {
      const out: S[] = [];
      for (const s of rankAt(c).list) {
        if (ex?.has(s.code)) continue;
        if (rowLive(s, c) === undefined) continue;
        const f = newLowFlags(s, P.low), a = alignedOf(s.code);
        let L = Number.POSITIVE_INFINITY;
        for (let k = Math.max(0, c - P.within + 1); k <= c; k++) if (f[k] && a[k] < L) L = a[k];
        if (!Number.isFinite(L)) continue;
        const cl = a[c];
        if (!(cl >= L * (1 + P.rec))) continue;
        const m = smaAt(s, c, P.ma);
        if (!(cl > m)) continue;
        out.push(s);
      }
      return out;
    },
    pool: (c, _P, ex) => rankAt(c).list.filter((s) => !ex?.has(s.code) && rowLive(s, c) !== undefined),
    exit: (p, c, i, P, lag) => {
      if (i !== undefined) { const m = smaAt(byCode.get(p.code) as S, c, P.ma); if (Number.isFinite(m) && p.s.close[i] < m) return "이평 이탈"; }
      return holdDone(p, c, P.timeout, lag) ? "보유 만료" : null;
    },
  };

  // ---- R4: 잔차 모멘텀 ----
  const rmAt = (k: number): number => h.bhRet.get(CAL[k]) ?? Number.NaN;
  const scoreOf = (s: S, c: number, win: number, skip: number): number => {
    const e = c - skip, b = e - win + 1;
    if (b - 1 < 0) return Number.NaN;
    const a = alignedOf(s.code);
    let n = 0, sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let k = b; k <= e; k++) {
      const x = rmAt(k);
      if (!(a[k] > 0) || !(a[k - 1] > 0) || !Number.isFinite(x)) return Number.NaN;
      const y = a[k] / a[k - 1] - 1;
      n++; sx += x; sy += y; sxy += x * y; sxx += x * x;
    }
    const den = n * sxx - sx * sx;
    if (!(den > 0)) return Number.NaN;
    const beta = (n * sxy - sx * sy) / den;
    return sy - beta * sx;
  };
  const rankedCache = new Map<string, { list: S[]; rank: Map<string, number> }>();
  /** 판단일 c의 점수 순위(유니버스 = K200P 시총 상위 depth, 점수가 있는 종목만, 점수 내림차순 → 시총 순위). */
  const scoreRanked = (c: number, P: B2P): { list: S[]; rank: Map<string, number> } => {
    const key = `${P.win}|${P.skip}|${P.depth}|${c}`;
    let v = rankedCache.get(key);
    if (!v) {
      const sc: { s: S; k: number; r: number }[] = [];
      rankAt(c).list.slice(0, P.depth).forEach((s, k) => { const r = scoreOf(s, c, P.win, P.skip); if (Number.isFinite(r)) sc.push({ s, k, r }); });
      sc.sort((x, y) => y.r - x.r || x.k - y.k);
      const list = sc.map((x) => x.s);
      v = { list, rank: new Map(list.map((s, k) => [s.code, k + 1])) };
      rankedCache.set(key, v);
      if (rankedCache.size > 12000) rankedCache.delete(rankedCache.keys().next().value as string);
    }
    return v;
  };
  const R4: QDef = {
    id: "R4", trial: B2_TRIALS.r4, P0: B2_R4_P0, nbs: B2_R4_NB, reasons: ["순위 밖"], slots: (P) => P.n, randomHold: true,
    title: (P) => `R4: K200P 시총 상위 ${P.depth} 중 069500 대비 ${P.win}일 회귀 잔차 수익률(최근 ${P.skip}일 제외) 상위 ${P.n}종목 균등 매수(다음 거래일 종가), 순위가 ${P.exitRank}위 밖이면 청산`,
    signals: (c, P, ex) => scoreRanked(c, P).list.filter((s) => !ex?.has(s.code)).slice(0, P.n),
    pool: (c, P, ex) => rankAt(c).list.slice(0, P.depth).filter((s) => !ex?.has(s.code)),
    exit: (p, c, _i, P) => ((scoreRanked(c, P).rank.get(p.code) ?? Number.POSITIVE_INFINITY) > P.exitRank ? "순위 밖" : null),
  };
  const QS: Record<string, QDef> = { r1: R1, r3: R3, r4: R4 };

  // ---- R2: 시장 지수·확정 상태·시총 비율 보유 ----
  const MK: Mkt[] = ["KOSPI", "KOSDAQ"];
  const idxCache = new Map<string, Float64Array>();
  /** 시장 지수 수준: 일 t 수익률 = 전일 t−1 구성(시총 상위 n, 전일 시총 비율)의 t−1→t 수정 종가 수익률(행 없으면 0). 첫 구성이 가능한 날에 1. */
  const idxLevel = (mkt: Mkt, n: number): Float64Array => {
    const key = `${mkt}|${n}`;
    let L = idxCache.get(key);
    if (!L) {
      L = new Float64Array(nCal).fill(Number.NaN);
      let started = false;
      for (let t = 1; t < nCal; t++) {
        let wsum = 0, acc = 0;
        for (const s of rankMkt(t - 1, mkt).list.slice(0, n)) {
          const a = s.idx.get(CAL[t - 1]), b = s.idx.get(CAL[t]);
          if (a === undefined) continue;
          const w = s.mcapRow[a];
          if (!(w > 0)) continue;
          wsum += w; acc += w * (b !== undefined ? s.close[b] / s.close[a] - 1 : 0);
        }
        if (!(wsum > 0)) continue;
        const r = acc / wsum;
        if (!started) { L[t - 1] = 1; started = true; }
        L[t] = L[t - 1] * (1 + r);
      }
      idxCache.set(key, L);
    }
    return L;
  };
  interface ConfX { conf: Int8Array; c0: number; switches: number[] }
  const confCache = new Map<string, ConfX>();
  /** 확정 상태(0 코스피, 1 코스닥, −1 아직 없음) 경로와 전환 신호일. */
  const confOf = (P: B2P): ConfX => {
    const key = `${P.idx}|${P.win}|${P.confirm}`;
    let v = confCache.get(key);
    if (!v) {
      const kp = idxLevel("KOSPI", P.idx), kq = idxLevel("KOSDAQ", P.idx);
      const R = (L: Float64Array, c: number): number => (c - P.win >= 0 && L[c] > 0 && L[c - P.win] > 0 ? L[c] / L[c - P.win] - 1 : Number.NaN);
      const conf = new Int8Array(nCal).fill(-1), switches: number[] = [];
      let cur = -1, cnt = 0, c0 = -1;
      for (let c = 0; c < nCal; c++) {
        const rk = R(kp, c), rq = R(kq, c);
        if (!Number.isFinite(rk) || !Number.isFinite(rq)) continue;
        const raw = rq > rk ? 1 : 0;
        if (cur < 0) { cur = raw; c0 = c; } else if (raw === cur) cnt = 0; else { cnt++; if (cnt >= P.confirm) { cur = raw; cnt = 0; switches.push(c); } }
        conf[c] = cur;
      }
      v = { conf, c0, switches };
      confCache.set(key, v);
    }
    return v;
  };
  const mcapNear = (s: S, c: number): number => { for (let k = c; k >= Math.max(c - 10, 0); k--) { const i = s.idx.get(CAL[k]); if (i !== undefined && s.mcapRow[i] > 0) return s.mcapRow[i]; } return Number.NaN; };
  const simMkt = (P: B2P, o: { lag: number; replace?: Set<string>; conf?: Int8Array; exclude?: ReadonlySet<string> }): MRun => {
    const N = P.n, e = env(cPE), buyMult = e.stockBuyMult, conf = o.conf ?? confOf(P).conf;
    const pos = new Map<string, MPos>();
    let cash = 1, prevV = 1, forcedExit = 0, holdMk = -1;
    const out: MRun = { dates: [], ret: [], costFrac: [], nPos: [], inv: [], turn: [], trades: [], entryCs: [], wMax: [], haltSkip: 0, exitDefer: 0, open: [], events: [] };
    let pend: { c: number; sigC: number; kind: MEvent["kind"]; mk: number; sells: string[]; buys: string[]; mc: Map<string, number> } | null = null;
    const val = (p: MPos): number => (p.rep ? p.repVal : p.shares * p.lastPx);
    const pushTrade = (p: MPos, c: number, net: number, reason: string, into: SimTrade[]): void => { into.push({ code: p.code, entryC: p.entryC, exitC: c, spend: p.spend, proceeds: net + p.realized, vAtEntry: p.vAtEntry, reason, entryAdj: 0, peakAdj: 0, exitAdj: 0, entryRaw: 0 }); };
    const topAt = (c: number, mk: number): S[] => rankMkt(c, MK[mk]).list.filter((s) => !o.exclude?.has(s.code)).slice(0, N);
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
            cash += v * (1 - sr); pushTrade(p, c, v * (1 - sr), ev.kind === "교체" ? "시총 순위 밖" : "시장 전환", out.trades); pos.delete(code); costF += (v * sr) / prevV; sellN += v;
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
          out.events.push({ sigC: ev.sigC, c, kind: ev.kind, mk: ev.mk, sells: ev.sells, buys: ev.buys });
        }
      }
      let V = cash;
      for (const p of pos.values()) V += val(p);
      if (c > cPE) {
        out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.costFrac.push(costF); out.nPos.push(pos.size);
        out.inv.push(V > 0 ? (V - cash) / V : 0);
        if (buyN + sellN > 1e-12) out.turn.push({ d, v: prevV > 0 ? (buyN + sellN) / 2 / prevV : 0 });
        let mx = 0;
        for (const p of pos.values()) { const v = val(p); if (v > mx) mx = v; }
        out.wMax.push(pos.size && V > 0 ? mx / V : Number.NaN);
      }
      if (c + o.lag < nCal && conf[c] >= 0) {
        const mk = conf[c], top = topAt(c, mk), topSet = new Set(top.map((s) => s.code));
        for (const p of pos.values()) p.out = topSet.has(p.code) ? 0 : p.out + 1;
        if (!pend) {
          if (holdMk !== mk) {
            const sells = [...pos.keys()], buys = top.map((s) => s.code), mc = new Map<string, number>();
            for (const code of buys) mc.set(code, mcapNear(byCode.get(code) as S, c));
            if (buys.length > 0 && [...mc.values()].every((x) => Number.isFinite(x) && x > 0)) { pend = { c: c + o.lag, sigC: c, kind: holdMk < 0 ? "첫 매수" : "전환", mk, sells, buys, mc }; holdMk = mk; }
          } else {
            const sells = [...pos.values()].filter((p) => p.out >= B2_R2_SWAP_CONFIRM).map((p) => p.code);
            const need = N - (pos.size - sells.length);
            if (sells.length > 0 || need > 0) {
              const buys = top.filter((s) => !pos.has(s.code)).slice(0, Math.max(need, 0)).map((s) => s.code);
              const mc = new Map<string, number>();
              for (const code of [...pos.keys()].filter((k) => !sells.includes(k)).concat(buys)) mc.set(code, mcapNear(byCode.get(code) as S, c));
              if ([...mc.values()].every((x) => Number.isFinite(x) && x > 0) && (sells.length > 0 || buys.length > 0)) pend = { c: c + o.lag, sigC: c, kind: "교체", mk, sells, buys, mc };
            }
          }
        }
      }
      prevV = V;
    }
    const last = CAL[nCal - 1], srl = e.sellRate(last);
    for (const p of pos.values()) pushTrade(p, nCal - 1, val(p) * (1 - srl), "기간 끝 평가", out.open);
    void forcedExit;
    return out;
  };
  const randConf = (P: B2P, k: number, rng: () => number): Int8Array => {
    const base = confOf(P).conf, cand: number[] = [];
    for (let c = cPE; c < nCal - 1; c++) cand.push(c);
    for (let j = cand.length - 1; j > 0; j--) { const m = Math.floor(rng() * (j + 1)); [cand[j], cand[m]] = [cand[m], cand[j]]; }
    const days = new Set(cand.slice(0, k));
    const conf = new Int8Array(nCal).fill(-1);
    let cur = base[cPE];
    for (let c = cPE; c < nCal; c++) { if (days.has(c)) cur = 1 - cur; conf[c] = cur; }
    return conf;
  };

  // ---- 실행 ----
  const hooksFor = (q: QDef, P: B2P, lag: number, ex?: Ex): SimHooks<SimCand> => ({
    candsOf: (c) => q.signals(c, P, ex).map((s) => ({ s, code: s.code })),
    exitReason: (p, c, i) => q.exit(p, c, i, P, lag),
  });
  const cfgOf = (q: QDef, P: B2P) => ({ slip: L_SLIPPAGE, maxPos: q.slots(P), capFrac: 1 / q.slots(P), cooldown: 0 });
  const runQ = (q: QDef, P: B2P, o: { lag: number; replace?: Set<string>; detail?: boolean }, ex?: Ex): SimRun => simSlots(env(cPE), cfgOf(q, P), hooksFor(q, P, o.lag, ex), { lag: o.lag, replace: o.replace, detail: o.detail });
  let actualHolds: number[] = [];
  const randomRun = (q: QDef, P: B2P, rng: () => number, ob: Map<number, number>): SimRun => {
    const holdNote = new Map<string, number>();
    const hooks: SimHooks<SimCand> = {
      candsOf: (c, held, blocked) => {
        const n = ob.get(c) ?? 0;
        if (!n) return [];
        const pool = q.pool(c, P, undefined).filter((s) => !held(s.code) && !blocked(s.code)), out: SimCand[] = [];
        while (out.length < n && pool.length) {
          const s = pool.splice(Math.floor(rng() * pool.length), 1)[0];
          if (q.randomHold) holdNote.set(`${s.code}|${c + 1}`, actualHolds[Math.floor(rng() * actualHolds.length)]);
          out.push({ s, code: s.code });
        }
        return out;
      },
      exitReason: (p, c, i) => {
        if (q.randomHold) { const hd = holdNote.get(`${p.code}|${p.entryC}`); return hd !== undefined && holdDone(p, c, hd, 1) ? "순위 밖" : null; }
        return q.exit(p, c, i, P, 1);
      },
    };
    return simSlots(env(cPE), cfgOf(q, P), hooks, { lag: 1 });
  };

  // =====================================================================================================================
  // 1. 사전 점검 (성과 아님): 신호 독립 대조(과거 이력만 쓰는 브루트포스), 체결 타이밍, 구조 통계
  // =====================================================================================================================
  /** 브루트포스: 캐시·정렬된 배열 없이 판단일 c까지(k ≤ c)의 행만 직접 읽는다. */
  const lastClose = (s: S, c: number): number => { for (let k = c; k >= 0; k--) { const i = s.idx.get(CAL[k]); if (i !== undefined) return s.close[i]; } return Number.NaN; };
  const bruteRankM = (c: number, mkt: Mkt, depth: number): string[] => {
    const d = CAL[c], m = membAt(d), e: { code: string; mc: number }[] = [];
    if (m) for (const s of h.stocks) { const i = s.idx.get(d); if (i !== undefined && !excluded.has(s.code) && m.get(s.code) === mkt) e.push({ code: s.code, mc: s.mcapRow[i] }); }
    e.sort((a, b) => b.mc - a.mc || (a.code < b.code ? -1 : 1));
    return e.slice(0, depth).map((x) => x.code);
  };
  const bseries = new Map<string, Float64Array>();
  /** 브루트포스 달력 정렬 종가: 행이 있는 날 그 종가, 없으면 직전 행 종가, 상장 전 NaN. */
  const bseriesOf = (code: string): Float64Array => {
    let a = bseries.get(code);
    if (!a) {
      const s = byCode.get(code) as S;
      a = new Float64Array(nCal);
      let last = Number.NaN, r = 0;
      for (let k = 0; k < nCal; k++) { while (r < s.dates.length && s.dates[r] < CAL[k]) r++; if (r < s.dates.length && s.dates[r] === CAL[k]) last = s.close[r]; a[k] = last; }
      bseries.set(code, a);
    }
    return a;
  };
  const brSignals = (id: string, c: number, P: B2P): string[] => {
    const rk = bruteRankM(c, "KOSPI", B2_RANK_DEPTH);
    if (id === "R1") {
      const out: { code: string; tv: number }[] = [];
      for (const code of rk) {
        const s = byCode.get(code) as S, i = s.idx.get(CAL[c]);
        if (i === undefined || s.vol[i] === 0) continue;
        const hi = s.high[i], lo = s.low[i], cl = s.close[i];
        if (!(hi > lo)) continue;
        if ((cl - lo) / (hi - lo) < P.pos) continue;
        if (i < P.avgWin) continue;
        let sum = 0;
        for (let k = i - P.avgWin; k <= i - 1; k++) sum += s.raw[k] * s.vol[k];
        const tv = s.raw[i] * s.vol[i];
        if (!(sum / P.avgWin > 0) || tv < P.vol * (sum / P.avgWin)) continue;
        if (c - P.ma + 1 < 0) continue;
        let sm = 0;
        for (let k = c - P.ma + 1; k <= c; k++) sm += lastClose(s, k);
        if (!(cl > sm / P.ma)) continue;
        out.push({ code, tv });
      }
      return out.sort((a, b) => b.tv - a.tv || (a.code < b.code ? -1 : 1)).map((x) => x.code);
    }
    if (id === "R3") {
      const out: string[] = [];
      for (const code of rk) {
        const s = byCode.get(code) as S, i = s.idx.get(CAL[c]);
        if (i === undefined || s.vol[i] === 0) continue;
        const bc = bseriesOf(code);
        let L = Number.POSITIVE_INFINITY;
        for (let k = Math.max(0, c - P.within + 1); k <= c; k++) {
          if (k - P.low + 1 < 0 || !(bc[k - P.low + 1] > 0)) continue;
          let isLow = true;
          for (let j = k - P.low + 1; j <= k - 1; j++) if (!(bc[k] < bc[j])) { isLow = false; break; }
          if (isLow && bc[k] < L) L = bc[k];
        }
        if (!Number.isFinite(L) || !(bc[c] >= L * (1 + P.rec))) continue;
        if (c - P.ma + 1 < 0) continue;
        let sm = 0;
        for (let k = c - P.ma + 1; k <= c; k++) sm += bc[k];
        if (bc[c] > sm / P.ma) out.push(code);
      }
      return out;
    }
    // R4: 점수 순위(상위 max(n, exitRank)개). 평균 제거 형태로 회귀한다.
    const rm = (k: number): number => { const j = h.bhP.dates.indexOf(CAL[k]); return j >= 0 ? h.bhP.ret[j] / 100 : Number.NaN; };
    const e = c - P.skip, b = e - P.win + 1;
    const xs: number[] = [];
    if (b - 1 >= 0) for (let k = b; k <= e; k++) xs.push(rmCache(k, rm));
    const sc: { code: string; k: number; r: number }[] = [];
    rk.slice(0, P.depth).forEach((code, k) => {
      if (!xs.length || xs.some((x) => !Number.isFinite(x))) return;
      const bc = bseriesOf(code), ys: number[] = [];
      for (let q = b; q <= e; q++) { if (!(bc[q] > 0) || !(bc[q - 1] > 0)) return; ys.push(bc[q] / bc[q - 1] - 1); }
      const mx = xs.reduce((a, x) => a + x, 0) / xs.length, my = ys.reduce((a, x) => a + x, 0) / ys.length;
      let sxy = 0, sxx = 0;
      for (let q = 0; q < xs.length; q++) { sxy += (xs[q] - mx) * (ys[q] - my); sxx += (xs[q] - mx) ** 2; }
      if (!(sxx > 0)) return;
      const beta = sxy / sxx;
      sc.push({ code, k, r: ys.reduce((a, y, q) => a + (y - beta * xs[q]), 0) });
    });
    sc.sort((x, y) => y.r - x.r || x.k - y.k);
    return sc.slice(0, Math.max(P.n, P.exitRank)).map((x) => x.code);
  };
  const rmMemo = new Map<number, number>();
  const rmCache = (k: number, f: (k: number) => number): number => { let v = rmMemo.get(k); if (v === undefined) { v = f(k); rmMemo.set(k, v); } return v; };
  /** 모듈 쪽 비교 대상: R1·R3은 신호 목록 전체, R4는 점수 순위 상위 max(n, exitRank). */
  const modSignals = (q: QDef, c: number, P: B2P): string[] => (q.id === "R4" ? scoreRanked(c, P).list.slice(0, Math.max(P.n, P.exitRank)).map((s) => s.code) : q.signals(c, P, undefined).map((s) => s.code));

  // R2 브루트포스: 시장 지수·확정 상태·목표 구성을 처음부터 따로 만든다.
  const bListMemo = new Map<string, string[]>();
  const bListM = (c: number, mkt: Mkt): string[] => { const key = `${mkt}|${c}`; let v = bListMemo.get(key); if (!v) { v = bruteRankM(c, mkt, 100); bListMemo.set(key, v); } return v; };
  const bIdx = (mkt: Mkt, n: number): number[] => {
    const lv: number[] = new Array<number>(nCal).fill(Number.NaN);
    let started = false;
    for (let t = 1; t < nCal; t++) {
      const codes = bListM(t - 1, mkt).slice(0, n);
      let ws = 0, ac = 0;
      for (const code of codes) {
        const s = byCode.get(code) as S, a = s.idx.get(CAL[t - 1]);
        if (a === undefined || !(s.mcapRow[a] > 0)) continue;
        const b = s.idx.get(CAL[t]);
        ws += s.mcapRow[a]; ac += s.mcapRow[a] * (b === undefined ? 0 : s.close[b] / s.close[a] - 1);
      }
      if (!(ws > 0)) continue;
      if (!started) { lv[t - 1] = 1; started = true; }
      lv[t] = lv[t - 1] * (1 + ac / ws);
    }
    return lv;
  };
  const bConf = (P: B2P): number[] => {
    const kp = bIdx("KOSPI", P.idx), kq = bIdx("KOSDAQ", P.idx), out: number[] = new Array<number>(nCal).fill(-1);
    let cur = -1, run = 0;
    for (let c = P.win; c < nCal; c++) {
      if (!(kp[c] > 0 && kp[c - P.win] > 0 && kq[c] > 0 && kq[c - P.win] > 0)) continue;
      const raw = kq[c] / kq[c - P.win] > kp[c] / kp[c - P.win] ? 1 : 0;
      if (cur < 0) cur = raw;
      else if (raw !== cur) { run++; if (run >= P.confirm) { cur = raw; run = 0; } } else run = 0;
      out[c] = cur;
    }
    return out;
  };

  if (REPRO) {
    console.log(`\n=== 1. 신호 독립 대조 (판단일마다 모듈 신호 = 브루트포스(과거 이력만) 신호, 순서까지; ${CAL[cPE]}~${CAL[nCal - 2]}) ===`);
    for (const q of [R1, R3, R4]) {
      for (const [nm, P] of [["기본", q.P0] as [string, B2P], ...q.nbs.map(([l, ch]) => [l, { ...q.P0, ...ch }] as [string, B2P])]) {
        let nBad = 0, nSig = 0, nDays = 0, firstBad = "";
        for (let c = cPE; c < nCal - 1; c++) {
          const a = modSignals(q, c, P), b = brSignals(q.id, c, P);
          if (a.join() !== b.join()) { nBad++; if (!firstBad) firstBad = `${CAL[c]} 모듈 ${a.slice(0, 5).join(",")} / 브루트 ${b.slice(0, 5).join(",")}`; }
          if (a.length) { nDays++; nSig += a.length; }
        }
        console.log(`  ${q.id} ${nm}: ${q.id === "R4" ? "점수 순위가 있는 날" : "신호가 있는 날"} ${nDays}일, ${q.id === "R4" ? "순위 항목" : "신호"} 합 ${nSig}개 | 브루트포스와 불일치 ${nBad}일 ${nBad === 0 ? "통과" : `불일치 (${firstBad})`}`);
        if (nBad > 0) throw new Error(`${q.id} 신호 독립 대조 불일치 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)`);
      }
    }
    console.log(`\n=== 1a. R2 지수·확정 상태·목표 구성 독립 대조 (브루트포스는 따로 지수를 처음부터 만든다) ===`);
    for (const [nm, P] of [["기본", B2_R2_P0] as [string, B2P], ...B2_R2_NB.map(([l, ch]) => [l, { ...B2_R2_P0, ...ch }] as [string, B2P])]) {
      const cx = confOf(P), bc = bConf(P);
      let nBad = 0, nBadTop = 0, nDays = 0;
      for (let c = 0; c < nCal; c++) if (cx.conf[c] !== bc[c]) nBad++;
      for (let c = cPE; c < nCal - 1; c++) {
        if (cx.conf[c] < 0) continue;
        nDays++;
        const mk = cx.conf[c], a = rankMkt(c, MK[mk]).list.slice(0, P.n).map((s) => s.code), b = bListM(c, MK[mk]).slice(0, P.n);
        if (a.join() !== b.join()) nBadTop++;
      }
      console.log(`  R2 ${nm}: 확정 상태 시작일 ${CAL[cx.c0]}, 전환 ${cx.switches.length}회(평가 구간 ${cx.switches.filter((c) => c >= cPE).length}회), 확정 상태 불일치 ${nBad}일, 목표 구성 불일치 ${nBadTop}일(${nDays}일 비교) ${nBad === 0 && nBadTop === 0 ? "통과" : "불일치"}`);
      if (nBad > 0 || nBadTop > 0) throw new Error(`R2 독립 대조 불일치 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)`);
    }
    console.log(`\n=== 1b. 체결·보유 타이밍 점검 (진입 = 신호일 + lag, 청산 판정 규칙, 기본 설정 lag 1·2; 성과 미출력) ===`);
    const halted = (s: S, k: number): boolean => { const j = s.idx.get(CAL[k]); return j === undefined || s.vol[j] === 0; };
    for (const q of [R1, R3, R4]) {
      for (const lag of [1, 2]) {
        const r = runQ(q, q.P0, { lag, detail: true });
        let badEntry = 0, badHold = 0, badRule = 0, nDeferred = 0;
        const holdKey = q.id === "R1" ? "hold" : "timeout";
        for (const t of r.trades) {
          const s = byCode.get(t.code) as S;
          if (!brSignals(q.id, t.entryC - lag, q.P0).slice(0, q.id === "R4" ? q.P0.n : undefined).includes(t.code)) badEntry++;
          if (t.reason === "보유 만료" && q.id !== "R4") {
            const due = t.entryC + q.P0[holdKey];
            if (t.exitC < due) badHold++;
            else if (t.exitC > due) { nDeferred++; for (let k = due; k < t.exitC; k++) if (!halted(s, k)) { badHold++; break; } }
          }
          if (q.id === "R3" && t.reason === "이평 이탈") {
            const bc = bseriesOf(t.code);
            let ok = false;
            for (let k = t.entryC; k <= t.exitC - lag && !ok; k++) { if (halted(s, k)) continue; let sm = 0; for (let j = k - q.P0.ma + 1; j <= k; j++) sm += bc[j]; if (bc[k] < sm / q.P0.ma) ok = true; }
            if (!ok) badRule++;
          }
          if (q.id === "R4" && t.reason === "순위 밖") {
            let ok = false;
            for (let k = t.entryC; k <= t.exitC - lag && !ok; k++) if (!brSignals("R4", k, q.P0).slice(0, q.P0.exitRank).includes(t.code)) ok = true;
            if (!ok) badRule++;
          }
        }
        console.log(`  ${q.id} lag ${lag}: 진입 ${r.entryCs.length}건, 청산 ${r.trades.length}건 | 신호일+${lag}이 아닌 진입 ${badEntry}건 | 보유 만료가 규칙일보다 이른 날 또는 정지일이 아닌데 늦은 청산 ${badHold}건 (거래정지로 순연된 정상 청산 ${nDeferred}건) | 규칙 조건이 한 번도 성립하지 않은 규칙 청산 ${badRule}건 ${badEntry === 0 && badHold === 0 && badRule === 0 ? "통과" : "불일치"}`);
        if (badEntry > 0 || badHold > 0 || badRule > 0) throw new Error(`${q.id} 체결 타이밍 점검 실패 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)`);
      }
    }
    for (const lag of [1, 2]) {
      const P = B2_R2_P0, r = simMkt(P, { lag }), bc = bConf(P);
      let badSig = 0, badSwap = 0, nSw = 0, nDef = 0, nSwapEv = 0, prevMk = -2;
      for (const ev of r.events) {
        if (ev.c < ev.sigC + lag) badSig++;
        if (ev.c > ev.sigC + lag) nDef++;
        if (ev.kind === "교체") {
          nSwapEv++;
          const top = new Set(bListM(ev.sigC, MK[ev.mk]).slice(0, P.n));
          for (const code of ev.sells) { let allOut = true; for (let k = ev.sigC - B2_R2_SWAP_CONFIRM + 1; k <= ev.sigC; k++) if (bListM(k, MK[ev.mk]).slice(0, P.n).includes(code)) allOut = false; if (!allOut) badSwap++; }
          for (const code of ev.buys) if (!top.has(code)) badSwap++;
          if (bc[ev.sigC] !== ev.mk) badSwap++;
        } else {
          nSw++;
          if (bc[ev.sigC] !== ev.mk || (ev.kind === "전환" && ev.mk === prevMk)) badSwap++;
          if (ev.buys.join() !== bListM(ev.sigC, MK[ev.mk]).slice(0, P.n).join()) badSwap++;
        }
        if (ev.kind !== "교체") prevMk = ev.mk;
      }
      console.log(`  R2 lag ${lag}: 구성 이벤트 ${r.events.length}건(첫 매수·전환 ${nSw}, 교체 ${nSwapEv}), 진입 ${r.entryCs.length}건, 청산 ${r.trades.length}건 | 체결이 신호일+${lag}보다 이른 이벤트 ${badSig}건 | 신호 조건 불일치 ${badSwap}건 (거래정지로 순연된 정상 체결 ${nDef}건) ${badSig === 0 && badSwap === 0 ? "통과" : "불일치"}`);
      if (badSig > 0 || badSwap > 0) throw new Error("R2 체결 타이밍 점검 실패 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)");
    }
    console.log(`\n=== 1c. 구조 통계 (성과 아님) ===`);
    {
      for (const md of ["2010-01-29", "2015-12-30", "2020-12-30", "2026-10-22"]) { const d = CAL.filter((x) => x <= md).pop() as string, m = membAt(d); if (m) { const cc = new Map<string, number>(); for (const [, v] of m) cc.set(v, (cc.get(v) ?? 0) + 1); console.log(`  시장 구분표 ${d} 기준 값 분포: ${[...cc].map(([k, v]) => `${k} ${v}`).join(", ")}`); } }
      const mcAt = (c: number, mkt: Mkt, r: number): number => { const s0 = rankMkt(c, mkt).list[r - 1]; return s0 ? s0.mcapRow[s0.idx.get(CAL[c]) as number] : Number.NaN; };
      for (let c = cPE; c < nCal - 1; c += 500) console.log(`  ${CAL[c]}: 목록 코스피 ${rankMkt(c, "KOSPI").list.length}종목·코스닥 ${rankMkt(c, "KOSDAQ").list.length}종목 | 50위 시총(억) 코스피 ${f2(mcAt(c, "KOSPI", 50))}, 코스닥 ${f2(mcAt(c, "KOSDAQ", 50))} | 1위 시총(억) 코스피 ${f2(mcAt(c, "KOSPI", 1))}, 코스닥 ${f2(mcAt(c, "KOSDAQ", 1))}`);
      const cx = confOf(B2_R2_P0);
      console.log(`  R2 기본 확정 전환 신호일 ${cx.switches.length}회: ${cx.switches.map((c) => `${CAL[c]}→${MK[cx.conf[c]]}`).join(", ")}`);
      const first069 = CAL.findIndex((_, k) => Number.isFinite(rmAt(k)));
      console.log(`  069500 일수익률 계열: 달력 ${CAL[first069]}부터 존재(하네스 기준선), 평가 시작 ${CAL[cPE]}`);
      let firstScore = -1;
      for (let c = 0; c < nCal && firstScore < 0; c++) if (scoreRanked(c, B2_R4_P0).list.length > 0) firstScore = c;
      console.log(`  R4 첫 점수 순위가 생기는 판단일 ${CAL[firstScore]}(평가 시작 후 ${firstScore - cPE}거래일째), 그날 점수가 있는 종목 ${scoreRanked(firstScore, B2_R4_P0).list.length}개 / 상위 150 목록 ${rankAt(firstScore).list.slice(0, 150).length}개`);
      for (let c = cPE + 300; c < nCal - 1; c += 750) console.log(`  R4 ${CAL[c]}: 점수가 있는 종목 ${scoreRanked(c, B2_R4_P0).list.length}개`);
      for (const q of [R1, R3]) { let nd = 0, ns = 0, mx = 0; for (let c = cPE; c < nCal - 1; c++) { const n = q.signals(c, q.P0, undefined).length; if (n) nd++; ns += n; mx = Math.max(mx, n); } console.log(`  ${q.id} 신호가 있는 날 ${nd}일 / ${nCal - 1 - cPE}일, 신호 합 ${ns}, 하루 최대 ${mx}개`); }
    }
    console.log(`\n사전 점검 종료: 신호 독립 대조(R1·R3·R4 기본·이웃 설정 전부 모든 판단일, R2 지수·확정 상태·목표 구성), 체결 타이밍(lag 1·2), 구조 통계 통과. 시험 성과는 계산·출력하지 않았다 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    void B2_PRIOR_TESTS; void CS_SWAP_CONFIRM_DAYS; void B2_OUT_RANK;
    return;
  }

  // =====================================================================================================================
  // 2. 시험 (가설 1개, 게이트 A~H)
  // =====================================================================================================================
  const hVs = (full: { cagr: number; mdd: number }, rb: { cagr: number; mdd: number }): { ok: boolean; text: string } => {
    const dc = full.cagr - rb.cagr, dm = rb.mdd - full.mdd;
    const c1 = dc >= PEAD_H_CAGR_GAIN_PP, c2 = dm >= PEAD_H_MDD_GAIN_PP && dc >= -PEAD_H_CAGR_FLOOR_PP;
    return { ok: c1 || c2, text: `CAGR ${dc >= 0 ? "+" : ""}${f2(dc)}%p, MDD ${dm >= 0 ? "−" : "+"}${f2(Math.abs(dm))}%p(개선 ${f2(dm)}%p; ${PEAD_H_MDD_GAIN_STRONG_PP}%p 이상 ${dm >= PEAD_H_MDD_GAIN_STRONG_PP ? "O" : "X"}) → 조건1(CAGR +${PEAD_H_CAGR_GAIN_PP}%p) ${c1 ? "O" : "X"}, 조건2(MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p) ${c2 ? "O" : "X"}` };
  };
  const sg = (x: number): string => `${x >= 0 ? "+" : ""}${f2(x)}`;
  const isR2 = MODE === "r2";
  const q = isR2 ? null : QS[MODE];
  const id = isR2 ? "R2" : (q as QDef).id, trial = isR2 ? B2_TRIALS.r2 : (q as QDef).trial;
  const P0 = isR2 ? B2_R2_P0 : (q as QDef).P0, nbs = isR2 ? B2_R2_NB : (q as QDef).nbs;
  const title = isR2 ? `R2: 코스피 시총 상위 ${P0.idx} 시총가중 지수 vs 코스닥 시총 상위 ${P0.idx} 시총가중 지수의 ${P0.win}거래일 수익률 중 강한 시장의 상위 ${P0.n}종목을 시총 비율로 보유, 반대편이 ${P0.confirm}거래일 연속 더 강할 때만 전환(다음 거래일 종가 체결)` : (q as QDef).title(P0);
  const nSlots = isR2 ? P0.n : (q as QDef).slots(P0);
  const runAny = (P: B2P, o: { lag: number; replace?: Set<string>; detail?: boolean }, ex?: Ex): SimRun => (isR2 ? simMkt(P, { lag: o.lag, replace: o.replace, exclude: ex }) : runQ(q as QDef, P, o, ex));
  const nSwitchActual = confOf(P0).switches.filter((c) => c >= cPE && c < nCal - 1).length;
  const spec: CandSpec = {
    id, trial, title, defense: false, capFrac: 1 / nSlots, fDenominator: B2_F_DENOMINATOR, ref: { id: "069500", run: bhAsRun },
    hRule: (full, rb) => { const a = hVs(full, rb); return { ok: a.ok, note: `[사전등록: 069500만 판정] 069500 ${f2(rb.cagr)} / ${f2(rb.mdd)} → ${a.ok ? "O" : "X"} (${a.text})` }; },
    run: (o) => { const r = runAny(P0, o); if (q?.randomHold && o.lag === 1 && !o.replace) actualHolds = r.trades.map((t) => t.exitC - t.entryC); return r; },
    neighbors: nbs.map(([lb, ch]) => ({ label: lb, run: () => runAny({ ...P0, ...ch }, { lag: 1 }) })),
    random: (rng, ob) => (isR2 ? simMkt(P0, { lag: 1, conf: randConf(P0, nSwitchActual, rng) }) : randomRun(q as QDef, P0, rng, ob)),
    reasons: isR2 ? ["시장 전환", "시총 순위 밖"] : (q as QDef).reasons, label,
    extra: (run) => {
      console.log(`${id} 게이트 C 해석(사전등록): 진입·청산 체결을 모두 +1거래일(lag 2). CAGR 하락 ≤ 1%p ∧ MDD 악화 ≤ 2%p.`);
      console.log(`${id} 게이트 D 해석(사전등록): 이웃 ${nbs.length}개(${nbs.map(([l]) => l).join(", ")}). 연속 전체 CAGR ≥ 069500 CAGR이어야 통과, 하나라도 미만이면 탈락.`);
      console.log(`${id} 게이트 E 해석(사전등록): 평가 구간 닫힌 거래 중 손익 상위 3개를 069500 수익률로 대체한 연속 전체 CAGR ≥ 069500.`);
      console.log(`${id} 게이트 F 해석(사전등록): ${isR2 ? `실제 확정 전환 횟수(${nSwitchActual}회)와 같은 수의 무작위 전환 신호일(시작 시장은 실제와 같음)` : q?.randomHold ? "실제 신호일·주문 수와 같게 유니버스에서 무작위로 고른 진입, 청산은 실제 거래 보유 일수 분포에서 뽑은 보유 일수" : "실제 신호일·주문 수와 같게 후보 풀에서 무작위로 고른 진입"}, 같은 보유·비용, 시드 ${KSS_R3_SEED}, ${KSS_R3_DRAWS}회, 백분위 ≥ 95.`);
      console.log(`${id} 게이트 G: 진입 건수(종목별 진입)는 evaluate 결과 참조. H 해석(사전등록): 069500만 판정(CAGR +${PEAD_H_CAGR_GAIN_PP}%p, 또는 MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p).`);
      const rec = B2_DS6_REC;
      console.log(`\n=== ${id} vs 069500 vs DS6 기록 (CAGR % / MDD %; DS6 기록 연속 전체 ${rec.전체.join(" / ")}) ===\n| 구간 | 069500 | DS6 기록 | ${id} | ${id} − 069500 CAGR %p | ${id} − 069500 MDD %p | ${id} − DS6 CAGR %p | ${id} − DS6 MDD %p |\n|---|---|---|---|---|---|---|---|`);
      const recs = [rec.구간1, rec.구간2, rec.구간3, rec.전체];
      ALLW.forEach(([wn, w], k) => {
        const a = h.st(h.bhP, w), s = h.st(run, w), d6 = recs[k] as readonly number[];
        console.log(`| ${wn} | ${f2(a.cagr)} / ${f2(a.mdd)} | ${d6[0].toFixed(2)} / ${d6[1].toFixed(2)} | ${f2(s.cagr)} / ${f2(s.mdd)} | ${sg(s.cagr - a.cagr)} | ${sg(s.mdd - a.mdd)} | ${sg(s.cagr - d6[0])} | ${sg(s.mdd - d6[1])} |`);
      });
      {
        const yrs: number[] = [];
        for (let y = Number(FULL.from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) yrs.push(y);
        console.log(`\n=== 연도별 수익률 % (일수익률 복리; ${yrs[0]}년은 ${FULL.from}부터, ${yrs[yrs.length - 1]}년은 ${h.dataEnd}까지; DS6는 기록값) ===\n| 연도 | 069500 | DS6 기록 | ${id} | ${id} − 069500 %p | ${id} − DS6 %p |\n|---|---|---|---|---|---|`);
        const ex: number[] = [];
        for (const y of yrs) {
          const a = h.yearRet({ dates: CAL.slice(cPE + 1), ret: bRetAxis }, y), cc = h.yearRet(run, y), d6 = B2_DS6_YEARLY[String(y)];
          ex.push(cc - a);
          console.log(`| ${y} | ${f2(a)} | ${f2(d6)} | ${f2(cc)} | ${sg(cc - a)} | ${sg(cc - d6)} |`);
        }
        console.log(`${id} − 069500 승·패 연수: 승 ${ex.filter((x) => x > 0).length} / 패 ${ex.filter((x) => x < 0).length} (평균 ${sg(avg(ex))}%p, 중앙값 ${sg(median(ex))}%p)`);
      }
      {
        const s = h.st(run, FULL);
        console.log(`\n=== 거래 회전율과 비용 (연속 전체; DS6 기록 연 회전율 ${rec.turnover}%, 비용 합계 ${rec.cost}%) ===\n연 회전율 ${f2(s.turnover)}% | 비용 합계 ${f2(s.cost)}% (일별 비용 합) | 평균 투자 비중 ${f2(s.avgInv)}% | 평균 보유 종목 수 ${f2(s.avgN)}`);
      }
      {
        const sam = run.trades.filter((t) => t.code === DS89_SAMSUNG && run.dates[0] <= CAL[t.exitC]), tot = run.trades.reduce((a, t) => a + (t.proceeds - t.spend) / t.vAtEntry, 0), sp = sam.reduce((a, t) => a + (t.proceeds - t.spend) / t.vAtEntry, 0);
        const exS = new Set([DS89_SAMSUNG]), xr = runAny(P0, { lag: 1 }, exS), sx = h.st(xr, FULL), s0 = h.st(run, FULL), b0 = h.st(h.bhP, FULL);
        console.log(`\n=== 진단 [판정 불사용] 삼성전자 포함 여부 ===\n삼성전자 거래 ${sam.length}건 (닫힌 거래 ${run.trades.length}건 중 ${f2((sam.length / Math.max(run.trades.length, 1)) * 100)}%), 손익 기여 합 ${sg(sp * 100)} (전 거래 손익 합 ${sg(tot * 100)}의 ${f2(tot !== 0 ? (sp / tot) * 100 : 0)}%) | 삼성전자를 후보에서 뺀 경우 연속 전체 ${f2(sx.cagr)} / ${f2(sx.mdd)} (원래 ${f2(s0.cagr)} / ${f2(s0.mdd)}, 069500 대비 CAGR ${sg(sx.cagr - b0.cagr)}%p, 진입 ${xr.entryCs.filter((c) => CAL[c] >= FULL.from).length}건)`);
      }
      const top = [...run.trades].sort((a, b) => (b.proceeds - b.spend) / b.vAtEntry - (a.proceeds - a.spend) / a.vAtEntry).slice(0, 5) as SimTrade[];
      console.log(`상위 거래(진입 시 계좌 대비 손익 순): ${top.map((t) => `${label(t.code)} ${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")}`);
      if (isR2) {
        const r2 = run as MRun, cx = confOf(P0);
        console.log(`R2 확정 전환 신호일(평가 구간) ${nSwitchActual}회: ${cx.switches.filter((c) => c >= cPE).map((c) => `${CAL[c]}→${MK[cx.conf[c]]}`).join(", ")} | 구성 이벤트 ${r2.events.length}건(전환 ${r2.events.filter((x) => x.kind === "전환").length}, 교체 ${r2.events.filter((x) => x.kind === "교체").length}) | 코스닥 확정 상태 일수 비율 ${f2((cx.conf.slice(cPE + 1).filter((x) => x === 1).length / Math.max(nCal - cPE - 1, 1)) * 100)}%`);
      }
    },
  };
  const verdicts: Verdict[] = [evaluate(h, W, spec)];
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: trial - 1, contamNote: W.contamNote });
  console.log(`사전 고지: 누적 285회 기준 우연 통과 기대 285 × 0.05 = ${(285 * 0.05).toFixed(2)}건(근사). 통과 후보가 있어도 독립 확인 전에는 후보일 뿐이다. 2011~2026 구간은 반복해서 본 데이터라 오염돼 있다. 가설 4개의 정의는 첫 시험 전에 고정했고 결과를 보고 바꾸지 않았다. 묶음 2 시험 번호 ${B2_TRIALS.r1}~${B2_TRIALS.r4}, 이 실행 ${trial}.`);
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ") || "없음"} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${trial}`);
  void B2_PRIOR_TESTS; void mulberry32; void CS_SWAP_CONFIRM_DAYS; void B2_OUT_RANK;
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

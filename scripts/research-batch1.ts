/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 묶음 1(Q1~Q4, 시도 278~281). 사전 등록: docs/research/batch1-prereg.md.
 * Q1 업종 내 리드-래그 / Q2 시총 순위 상승 모멘텀 / Q3 대형주 단기 낙폭 반등 / Q4 시장 패닉일 반등. 공용 슬롯 시뮬레이터(lib/slotSim.ts, 수정 없음) 위에서 후보·청산 훅만 다르다.
 * ALLOC_MODE=repro: 신호 독립 대조(과거 이력만 쓰는 브루트포스와 매일 비교 = 미래 정보 점검 겸용)·체결 타이밍·구조 통계만 하고 성과는 계산·출력하지 않는다 / q1|q2|q3|q4: 해당 가설 시험 1회. 공시·DART 사용 없음.
 */
import { simSlots, type SimCand, type SimHooks, type SimPos, type SimRun, type SimTrade } from "@/lib/slotSim";
import { L_SLIPPAGE } from "@/lib/megacapTrendConfig";
import { alignCloses } from "@/lib/le2VolTarget";
import { PEAD_H_CAGR_GAIN_PP, PEAD_H_MDD_GAIN_PP, PEAD_H_MDD_GAIN_STRONG_PP, PEAD_H_CAGR_FLOOR_PP } from "@/lib/peadConfig";
import { KSS_R3_DRAWS, KSS_R3_SEED } from "@/lib/kodexSectorSatConfig";
import { DS89_RUN_START, DS89_WINDOWS, DS89_SAMSUNG } from "@/lib/ds89Config";
import { B1_PRIOR_TESTS, B1_TRIALS, B1_RANK_DEPTH, B1_OUT_RANK, B1_IND_PREFIX, B1_Q1_RANK_FROM, B1_Q1_RANK_TO, B1_Q1_P0, B1_Q1_NB, B1_Q2_P0, B1_Q2_NB, B1_Q3_P0, B1_Q3_NB, B1_Q4_P0, B1_Q4_NB, B1_F_DENOMINATOR, B1_DS6_REC, B1_DS6_YEARLY, type B1P } from "@/lib/batch1Config";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, mulberry32, SNAP_END, f2, avg, median, type S, type Win } from "./researchHarness";
import { evaluate, summaryReport, type CandSpec, type Verdict, type Windows } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
type Ex = ReadonlySet<string> | undefined;
type Note = (code: string, v: number) => void;
interface QDef {
  id: string; trial: number; P0: B1P; nbs: [string, B1P][]; reasons: string[];
  slots: (P: B1P) => number;
  title: (P: B1P) => string;
  /** 판단일 c 종가의 후보(우선순위 순). note(code, v)는 편입 시점 값(Q2는 신호일 순위)을 남긴다. */
  signals: (c: number, P: B1P, ex: Ex, note: Note) => S[];
  /** 게이트 F 무작위 진입의 후보 풀. */
  pool: (c: number, P: B1P, ex: Ex, note: Note) => S[];
  /** 청산 판단(판단일 c 종가, i = 그날 종목 행). lag = 체결 지연(1 = 다음 거래일). entryNote = 편입 시점에 남긴 값. */
  exit: (p: SimPos, c: number, i: number | undefined, P: B1P, lag: number, entryNote: number | undefined) => string | null;
  /** Q4: 게이트 F를 무작위 신호일로 한다. */
  randomDays?: boolean;
}

async function main(): Promise<void> {
  const MODE = (process.env.ALLOC_MODE ?? "").trim().toLowerCase();
  if (!["repro", "q1", "q2", "q3", "q4"].includes(MODE)) throw new Error("ALLOC_MODE=repro|q1|q2|q3|q4 필요");
  const REPRO = MODE === "repro";
  console.log(`연구 묶음 1(Q1~Q4, 시도 ${B1_TRIALS.q1}~${B1_TRIALS.q4}) ${REPRO ? "사전 점검(신호 독립 대조·체결 타이밍·구조 통계만, 성과 미계산)" : `시험 ${MODE.toUpperCase()} 1회`} 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, nameOf, indOf } = await loadK200P(h);

  // ---- 평가 구간 (DS8~DS11과 같음) ----
  const cPE = CAL.findIndex((d) => d >= DS89_RUN_START);
  if (cPE < 0 || CAL[cPE] !== DS89_RUN_START) throw new Error(`${DS89_RUN_START}이 거래일 달력에 없음`);
  const NW: [string, Win][] = DS89_WINDOWS.map(([n, f, t]) => [n, { from: f, to: t }]);
  const FULL: Win = { from: CAL[cPE + 1], to: "9999-12-31" };
  if (NW[0][1].from !== FULL.from) throw new Error(`구간 1 시작 ${NW[0][1].from}이 연속 평가 시작 ${FULL.from}과 다르다`);
  const W: Windows = { NW, FULL, ALL: [...NW, ["연속 전체 2011-01~2026-10", FULL]], noEx26: true, contamNote: "경고(오염): 이 구간 전체(2011~2026)는 DS6·DS4·LV1 등 선행 연구에서 이미 반복해 본 데이터다. 묶음 1의 가설은 DS6 계열 결과를 본 뒤 정한 것이라 순수 검증이 아니다." };
  const ALLW = W.ALL;
  console.log(`연속 평가: 초기 ${CAL[cPE]} 종가 기준, 수익률 집계 ${FULL.from}~${h.dataEnd} | 구간 ${NW.map(([n, w]) => `${n} ${w.from}~${w.to === "9999-12-31" ? h.dataEnd : w.to}`).join(" / ")}`);
  console.log(`\n=== 0. 069500 기준선 (원주가, 가격 수익만; 기준선 시작일 = 구간 시작일) ===\n| 구간 | 기준선 첫 수익률 날짜 | CAGR % / MDD % |\n|---|---|---|`);
  for (const [wn, w] of ALLW) { const b = h.st(h.bhP, w); console.log(`| ${wn} | ${h.bhP.dates.find((d) => d >= w.from)} | ${f2(b.cagr)} / ${f2(b.mdd)} |`); }
  const bhAsRun = { dates: h.bhP.dates.filter((d) => d >= FULL.from), ret: h.bhP.ret.filter((_, k) => h.bhP.dates[k] >= FULL.from) } as unknown as SimRun;
  const bRetAxis = (() => { const m = new Map(h.bhP.dates.map((d, i) => [d, h.bhP.ret[i]])); return CAL.slice(cPE + 1).map((d) => m.get(d) as number); })();
  const env = (cS: number) => ({ CAL, nCal, cS, adjustments: h.adjustments, endedBefore: h.endedBefore, stockBuyMult: h.stockBuyMult, sellRate: h.sellRate, baseSlip: SLIPPAGE_PCT_PER_SIDE, bhRet: h.bhRet });
  const label = (code: string): string => `${code} ${nameOf.get(code) ?? "?"}`;

  // ---- K200P 순위 목록(깊이 200)·수정 종가 정렬·이동평균 ----
  const rankCache = new Map<number, { list: S[]; rank: Map<string, number> }>();
  const rankAt = (c: number): { list: S[]; rank: Map<string, number> } => {
    let v = rankCache.get(c);
    if (!v) {
      const d = CAL[c], m = membAt(d), e: { s: S; mc: number }[] = [];
      if (m) for (const s of h.stocks) {
        const i = s.idx.get(d);
        if (i === undefined || excluded.has(s.code) || m.get(s.code) !== "KOSPI") continue;
        e.push({ s, mc: s.mcapRow[i] });
      }
      e.sort((a, b) => b.mc - a.mc || (a.s.code < b.s.code ? -1 : 1));
      const list = e.slice(0, B1_RANK_DEPTH).map((x) => x.s);
      v = { list, rank: new Map(list.map((s, k) => [s.code, k + 1])) };
      rankCache.set(c, v);
    }
    return v;
  };
  const alignedCache = new Map<string, Float64Array>(), prefCache = new Map<string, Float64Array>();
  const alignedOf = (code: string): Float64Array => { let a = alignedCache.get(code); if (!a) { const s = byCode.get(code) as S; a = alignCloses(CAL, s.idx, s.close); alignedCache.set(code, a); } return a; };
  const ret = (s: S, c: number, look: number): number => { const a = alignedOf(s.code); return c - look >= 0 && a[c] > 0 && a[c - look] > 0 ? a[c] / a[c - look] - 1 : Number.NaN; };
  const smaAt = (s: S, c: number, ma: number): number => {
    const a = alignedOf(s.code);
    if (c - ma + 1 < 0 || !(a[c - ma + 1] > 0)) return Number.NaN;
    let p = prefCache.get(s.code);
    if (!p) { p = new Float64Array(nCal + 1); for (let k = 0; k < nCal; k++) p[k + 1] = p[k] + (a[k] > 0 ? a[k] : 0); prefCache.set(s.code, p); }
    return (p[c + 1] - p[c + 1 - ma]) / ma;
  };
  const indKey = (code: string): string | undefined => { const v = indOf.get(code); return v ? v.slice(0, B1_IND_PREFIX) : undefined; };
  const groupsAt = (c: number, ex: Ex): Map<string, S[]> => {
    const g = new Map<string, S[]>();
    for (const s of rankAt(c).list) {
      if (ex?.has(s.code)) continue;
      const k = indKey(s.code);
      if (!k) continue;
      const arr = g.get(k);
      if (arr) arr.push(s); else g.set(k, [s]);
    }
    return g;
  };
  const holdDone = (p: SimPos, c: number, hold: number, lag: number): boolean => c >= p.entryC + hold - lag;

  // ---- 가설 정의 ----
  const Q1: QDef = {
    id: "Q1", trial: B1_TRIALS.q1, P0: B1_Q1_P0, nbs: B1_Q1_NB, reasons: ["보유 만료"], slots: (P) => P.slots,
    title: (P) => `Q1: 업종(${B1_IND_PREFIX}자리) 시총 1위 ${P.look}거래일 수익률 ≥ +${f2(P.lead * 100)}%이면 같은 업종 시총 ${B1_Q1_RANK_FROM}~${B1_Q1_RANK_TO}위 중 ${P.look}거래일 수익률 < 리더의 ${P.lagFrac}배인 종목을 다음 거래일 종가에 매수, ${P.hold}거래일 보유, 슬롯 ${P.slots}개`,
    signals: (c, P, ex) => {
      const out: { s: S; gap: number }[] = [];
      for (const mem of groupsAt(c, ex).values()) {
        if (mem.length < 2) continue;
        const rl = ret(mem[0], c, P.look);
        if (!(rl >= P.lead)) continue;
        for (let k = B1_Q1_RANK_FROM - 1; k < Math.min(mem.length, B1_Q1_RANK_TO); k++) { const r = ret(mem[k], c, P.look); if (Number.isFinite(r) && r < P.lagFrac * rl) out.push({ s: mem[k], gap: rl - r }); }
      }
      out.sort((a, b) => b.gap - a.gap || (a.s.code < b.s.code ? -1 : 1));
      return out.map((x) => x.s);
    },
    pool: (c, _P, ex) => { const out: S[] = []; for (const mem of groupsAt(c, ex).values()) if (mem.length >= 2) out.push(...mem.slice(B1_Q1_RANK_FROM - 1, B1_Q1_RANK_TO)); return out; },
    exit: (p, c, _i, P, lag) => (holdDone(p, c, P.hold, lag) ? "보유 만료" : null),
  };
  const Q2: QDef = {
    id: "Q2", trial: B1_TRIALS.q2, P0: B1_Q2_P0, nbs: B1_Q2_NB, reasons: ["순위 하락", "보유 만료"], slots: (P) => P.slots,
    title: (P) => `Q2: K200P 시총 순위가 ${P.look}거래일 동안 ${P.rise}위 이상 오른 종목 편입(최대 ${P.slots}종목 균등), 순위가 편입 시점보다 ${P.dropExit}위 이상 내려가거나 ${P.maxHold}거래일이 지나면 청산, 일별 확인`,
    signals: (c, P, ex, note) => {
      if (c - P.look < 0) return [];
      const now = rankAt(c), prev = rankAt(c - P.look).rank, out: { s: S; gain: number; r: number }[] = [];
      now.list.forEach((s, k) => {
        if (ex?.has(s.code)) return;
        const gain = (prev.get(s.code) ?? B1_OUT_RANK) - (k + 1);
        if (gain >= P.rise) { out.push({ s, gain, r: k + 1 }); note(s.code, k + 1); }
      });
      out.sort((a, b) => b.gain - a.gain || a.r - b.r);
      return out.map((x) => x.s);
    },
    pool: (c, _P, ex, note) => { const l = rankAt(c).list.filter((s) => !ex?.has(s.code)); l.forEach((s) => note(s.code, (rankAt(c).rank.get(s.code) as number))); return l; },
    exit: (p, c, _i, P, lag, entryRank) => {
      const rn = rankAt(c).rank.get(p.code) ?? B1_OUT_RANK;
      if (entryRank !== undefined && rn >= entryRank + P.dropExit) return "순위 하락";
      return holdDone(p, c, P.maxHold, lag) ? "보유 만료" : null;
    },
  };
  const Q3: QDef = {
    id: "Q3", trial: B1_TRIALS.q3, P0: B1_Q3_P0, nbs: B1_Q3_NB, reasons: ["익절", "보유 만료"], slots: (P) => P.slots,
    title: (P) => `Q3: K200P 시총 상위 ${P.top} 중 ${P.look}거래일 수익률 ≤ ${f2(P.drop * 100)}%이고 종가 > ${P.ma}일선인 종목을 다음 거래일 종가에 매수, ${P.hold}거래일 후 또는 +${f2(P.take * 100)}% 도달 시(먼저) 청산, 슬롯 ${P.slots}개`,
    signals: (c, P, ex) => {
      const out: { s: S; r: number }[] = [];
      for (const s of rankAt(c).list.slice(0, P.top)) {
        if (ex?.has(s.code)) continue;
        const r = ret(s, c, P.look), a = alignedOf(s.code)[c], m = smaAt(s, c, P.ma);
        if (Number.isFinite(r) && r <= P.drop && Number.isFinite(m) && a > m) out.push({ s, r });
      }
      out.sort((a, b) => a.r - b.r || (a.s.code < b.s.code ? -1 : 1));
      return out.map((x) => x.s);
    },
    pool: (c, P, ex) => rankAt(c).list.slice(0, P.top).filter((s) => !ex?.has(s.code)),
    exit: (p, c, i, P, lag) => {
      if (i !== undefined && p.s.close[i] / p.entryAdj - 1 >= P.take) return "익절";
      return holdDone(p, c, P.hold, lag) ? "보유 만료" : null;
    },
  };
  const bhRetOn = (c: number): number => h.bhRet.get(CAL[c]) ?? 0;
  const basket = (c: number, P: B1P, ex: Ex): S[] => rankAt(c).list.filter((s) => !ex?.has(s.code)).slice(0, P.top);
  const Q4: QDef = {
    id: "Q4", trial: B1_TRIALS.q4, P0: B1_Q4_P0, nbs: B1_Q4_NB, reasons: ["보유 만료"], slots: (P) => P.top, randomDays: true,
    title: (P) => `Q4: 069500이 하루 ${f2(P.thr * 100)}% 이하로 마감한 날 K200P 시총 상위 ${P.top} 균등 매수(다음 거래일 종가), 체결일부터 ${P.hold}거래일 보유 후 청산`,
    signals: (c, P, ex) => (bhRetOn(c) <= P.thr ? basket(c, P, ex) : []),
    pool: (c, P, ex) => basket(c, P, ex),
    exit: (p, c, _i, P, lag) => (holdDone(p, c, P.hold, lag) ? "보유 만료" : null),
  };
  const QS: Record<string, QDef> = { q1: Q1, q2: Q2, q3: Q3, q4: Q4 };
  const panicDays = (thr: number): number[] => { const out: number[] = []; for (let c = cPE; c < nCal; c++) if (bhRetOn(c) <= thr) out.push(c); return out; };

  // ---- 실행 ----
  const hooksFor = (q: QDef, P: B1P, lag: number, ex?: Ex): SimHooks<SimCand> => {
    const note = new Map<string, number>();
    return {
      candsOf: (c) => q.signals(c, P, ex, (code, v) => note.set(`${code}|${c + lag}`, v)).map((s) => ({ s, code: s.code })),
      exitReason: (p, c, i) => q.exit(p, c, i, P, lag, note.get(`${p.code}|${p.entryC}`)),
    };
  };
  const cfgOf = (q: QDef, P: B1P) => ({ slip: L_SLIPPAGE, maxPos: q.slots(P), capFrac: 1 / q.slots(P), cooldown: 0 });
  const runQ = (q: QDef, P: B1P, o: { lag: number; replace?: Set<string>; detail?: boolean }, ex?: Ex): SimRun => simSlots(env(cPE), cfgOf(q, P), hooksFor(q, P, o.lag, ex), { lag: o.lag, replace: o.replace, detail: o.detail });
  const randomRun = (q: QDef, P: B1P, rng: () => number, ob: Map<number, number>): SimRun => {
    const note = new Map<string, number>();
    let days: Set<number> | null = null;
    if (q.randomDays) {
      const cand: number[] = [];
      for (let c = cPE; c < nCal - 1; c++) cand.push(c);
      for (let k = cand.length - 1; k > 0; k--) { const j = Math.floor(rng() * (k + 1)); [cand[k], cand[j]] = [cand[j], cand[k]]; }
      days = new Set(cand.slice(0, ob.size));
    }
    const hooks: SimHooks<SimCand> = {
      candsOf: (c, held, blocked) => {
        if (days) return days.has(c) ? basket(c, P, undefined).map((s) => ({ s, code: s.code })) : [];
        const n = ob.get(c) ?? 0;
        if (!n) return [];
        const pool = q.pool(c, P, undefined, (code, v) => note.set(`${code}|${c + 1}`, v)).filter((s) => !held(s.code) && !blocked(s.code)), out: SimCand[] = [];
        while (out.length < n && pool.length) { const s = pool.splice(Math.floor(rng() * pool.length), 1)[0]; out.push({ s, code: s.code }); }
        return out;
      },
      exitReason: (p, c, i) => q.exit(p, c, i, P, 1, note.get(`${p.code}|${p.entryC}`)),
    };
    return simSlots(env(cPE), cfgOf(q, P), hooks, { lag: 1 });
  };

  // =====================================================================================================================
  // 1. 사전 점검 (성과 아님): 신호 독립 대조(과거 이력만 쓰는 브루트포스), 체결 타이밍, 구조 통계
  // =====================================================================================================================
  /** 브루트포스: 캐시·정렬된 배열 없이 판단일 c까지(k ≤ c)의 행만 직접 읽는다. */
  const lastClose = (s: S, c: number): number => { for (let k = c; k >= 0; k--) { const i = s.idx.get(CAL[k]); if (i !== undefined) return s.close[i]; } return Number.NaN; };
  const bruteRank = (c: number): string[] => {
    const d = CAL[c], m = membAt(d), e: { code: string; mc: number }[] = [];
    if (m) for (const s of h.stocks) { const i = s.idx.get(d); if (i !== undefined && !excluded.has(s.code) && m.get(s.code) === "KOSPI") e.push({ code: s.code, mc: s.mcapRow[i] }); }
    e.sort((a, b) => b.mc - a.mc || (a.code < b.code ? -1 : 1));
    return e.slice(0, B1_RANK_DEPTH).map((x) => x.code);
  };
  const bRet = (code: string, c: number, look: number): number => { const s = byCode.get(code) as S; const a = lastClose(s, c), b = c - look >= 0 ? lastClose(s, c - look) : Number.NaN; return a > 0 && b > 0 ? a / b - 1 : Number.NaN; };
  const bruteSignals = (id: string, c: number, P: B1P): string[] => {
    const rk = bruteRank(c);
    if (id === "Q1") {
      const g = new Map<string, string[]>();
      for (const code of rk) { const v = indOf.get(code); if (!v) continue; const k = v.slice(0, B1_IND_PREFIX); const arr = g.get(k); if (arr) arr.push(code); else g.set(k, [code]); }
      const out: { code: string; gap: number }[] = [];
      for (const mem of g.values()) {
        if (mem.length < 2) continue;
        const rl = bRet(mem[0], c, P.look);
        if (!(rl >= P.lead)) continue;
        for (let k = 1; k < Math.min(mem.length, 6); k++) { const r = bRet(mem[k], c, P.look); if (Number.isFinite(r) && r < P.lagFrac * rl) out.push({ code: mem[k], gap: rl - r }); }
      }
      return out.sort((a, b) => b.gap - a.gap || (a.code < b.code ? -1 : 1)).map((x) => x.code);
    }
    if (id === "Q2") {
      if (c - P.look < 0) return [];
      const prev = bruteRank(c - P.look), pm = new Map(prev.map((code, k) => [code, k + 1])), out: { code: string; gain: number; r: number }[] = [];
      rk.forEach((code, k) => { const gain = (pm.get(code) ?? 201) - (k + 1); if (gain >= P.rise) out.push({ code, gain, r: k + 1 }); });
      return out.sort((a, b) => b.gain - a.gain || a.r - b.r).map((x) => x.code);
    }
    if (id === "Q3") {
      const out: { code: string; r: number }[] = [];
      for (const code of rk.slice(0, P.top)) {
        const s = byCode.get(code) as S, r = bRet(code, c, P.look);
        if (c - P.ma + 1 < 0) continue;
        let sum = 0;
        for (let k = c - P.ma + 1; k <= c; k++) sum += lastClose(s, k);
        const m = sum / P.ma, a = lastClose(s, c);
        if (Number.isFinite(r) && r <= P.drop && Number.isFinite(m) && a > m) out.push({ code, r });
      }
      return out.sort((a, b) => a.r - b.r || (a.code < b.code ? -1 : 1)).map((x) => x.code);
    }
    const pr = h.bhP.ret[h.bhP.dates.indexOf(CAL[c])];
    return pr !== undefined && pr / 100 <= P.thr ? rk.slice(0, P.top) : [];
  };
  if (REPRO) {
    console.log(`\n=== 1. 신호 독립 대조 (판단일마다 모듈 신호 = 브루트포스(과거 이력만) 신호, 순서까지; ${CAL[cPE]}~${CAL[nCal - 2]}) ===`);
    for (const q of [Q1, Q2, Q3, Q4]) {
      for (const [nm, P] of [["기본", q.P0] as [string, B1P], ...q.nbs.map(([l, ch]) => [l, { ...q.P0, ...ch }] as [string, B1P])]) {
        let nBad = 0, nSig = 0, nDays = 0;
        for (let c = cPE; c < nCal - 1; c++) {
          const a = q.signals(c, P, undefined, () => {}).map((s) => s.code), b = bruteSignals(q.id, c, P);
          if (a.join() !== b.join()) nBad++;
          if (a.length) { nDays++; nSig += a.length; }
        }
        console.log(`  ${q.id} ${nm}: 신호가 있는 날 ${nDays}일, 신호 합 ${nSig}개 | 브루트포스와 불일치 ${nBad}일 ${nBad === 0 ? "통과" : "불일치"}`);
        if (nBad > 0) throw new Error(`${q.id} 신호 독립 대조 불일치 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)`);
      }
    }
    console.log(`\n=== 1b. 체결·보유 타이밍 점검 (진입 = 신호일 + lag, 청산 판정 규칙, 기본 설정 lag 1·2; 성과 미출력) ===`);
    for (const q of [Q1, Q2, Q3, Q4]) {
      for (const lag of [1, 2]) {
        const r = runQ(q, q.P0, { lag, detail: true });
        let badEntry = 0, badHold = 0, badRule = 0;
        const holdKey = q.id === "Q2" ? "maxHold" : "hold", hold = q.P0[holdKey];
        for (const t of r.trades) {
          const sig = q.signals(t.entryC - lag, q.P0, undefined, () => {}).map((s) => s.code);
          if (!sig.includes(t.code)) badEntry++;
          if (t.reason === "보유 만료" && t.exitC - t.entryC !== hold) badHold++;
          if (q.id === "Q3" && t.reason === "익절") { const s = byCode.get(t.code) as S, j = s.idx.get(CAL[t.exitC - lag]); if (j === undefined || s.close[j] / t.entryAdj - 1 < q.P0.take - 1e-12) badRule++; }
          if (q.id === "Q2" && t.reason === "순위 하락") {
            const er = rankAt(t.entryC - lag).rank.get(t.code) ?? B1_OUT_RANK, rn = rankAt(t.exitC - lag).rank.get(t.code) ?? B1_OUT_RANK;
            if (rn < er + q.P0.dropExit) badRule++;
          }
        }
        if (q.id === "Q4") for (const t of r.trades) if (!(bhRetOn(t.entryC - lag) <= q.P0.thr)) badEntry++;
        const nHalt = r.exitDefer + r.haltSkip;
        console.log(`  ${q.id} lag ${lag}: 진입 ${r.entryCs.length}건, 청산 ${r.trades.length}건 | 신호일+${lag}이 아닌 진입 ${badEntry}건 | 보유 일수가 규칙과 다른 만료 청산 ${badHold}건 (거래정지 순연 ${r.exitDefer}건·진입 건너뜀 ${r.haltSkip}건) | 규칙 위반 ${badRule}건 ${badEntry === 0 && badHold <= r.exitDefer && badRule <= r.exitDefer ? "통과" : "불일치"}`);
        if (badEntry > 0 || badHold > r.exitDefer || badRule > r.exitDefer) throw new Error(`${q.id} 체결 타이밍 점검 실패 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)`);
        void nHalt;
      }
    }
    console.log(`\n=== 1c. 구조 통계 (성과 아님) ===`);
    {
      const codes = [...indOf.values()], lens = new Map<number, number>();
      codes.forEach((v) => lens.set(v.length, (lens.get(v.length) ?? 0) + 1));
      const samples = [...new Set(codes)].sort().slice(0, 12);
      console.log(`  업종코드(induty_code): 종목 ${codes.length}개, 자리수 분포 ${[...lens].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}자리 ${v}개`).join(", ")}, 숫자만 ${codes.every((v) => /^\d+$/.test(v)) ? "예" : "아니오"}, 예시 ${samples.join(" ")}`);
      const rows: string[] = [];
      for (let c = cPE; c < nCal - 1; c += 250) {
        const rl = rankAt(c).list, withCode = rl.filter((s) => indKey(s.code)).length, g = groupsAt(c, undefined), sizes = [...g.values()].map((m) => m.length);
        rows.push(`${CAL[c]}: 상위 200 중 업종코드 있음 ${withCode}종목, 업종 ${g.size}개(2종목 이상 ${sizes.filter((x) => x >= 2).length}개, 6종목 이상 ${sizes.filter((x) => x >= 6).length}개, 최대 ${Math.max(...sizes)}종목)`);
      }
      console.log(`  Q1 업종 구조(${B1_IND_PREFIX}자리, K200P 상위 200 안; 250거래일 간격 표본):\n    ${rows.join("\n    ")}`);
      const pd = panicDays(Q4.P0.thr);
      console.log(`  Q4 패닉일(069500 하루 ≤ ${Q4.P0.thr * 100}%, 판단일 기준) ${pd.length}일: ${pd.map((c) => CAL[c]).join(", ")}`);
      const pdY = new Map<string, number>();
      pd.forEach((c) => pdY.set(CAL[c].slice(0, 4), (pdY.get(CAL[c].slice(0, 4)) ?? 0) + 1));
      console.log(`  연도별 패닉일 수: ${[...pdY].map(([y, n]) => `${y} ${n}`).join(", ")} | 이웃 임계 −2% ${panicDays(-0.02).length}일, −4% ${panicDays(-0.04).length}일`);
    }
    console.log(`\n사전 점검 종료: 신호 독립 대조(기본·이웃 설정 전부, 모든 판단일), 체결 타이밍(lag 1·2), 구조 통계 통과. 시험 성과는 계산·출력하지 않았다 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
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
  const q = QS[MODE], P0 = q.P0;
  const spec: CandSpec = {
    id: q.id, trial: q.trial, title: q.title(P0), defense: false, capFrac: 1 / q.slots(P0), fDenominator: B1_F_DENOMINATOR, ref: { id: "069500", run: bhAsRun },
    hRule: (full, rb) => { const a = hVs(full, rb); return { ok: a.ok, note: `[사전등록: 069500만 판정] 069500 ${f2(rb.cagr)} / ${f2(rb.mdd)} → ${a.ok ? "O" : "X"} (${a.text})` }; },
    run: (o) => runQ(q, P0, o),
    neighbors: q.nbs.map(([lb, ch]) => ({ label: lb, run: () => runQ(q, { ...P0, ...ch }, { lag: 1 }) })),
    random: (rng, ob) => randomRun(q, P0, rng, ob),
    reasons: q.reasons, label,
    extra: (run) => {
      console.log(`${q.id} 게이트 C 해석(사전등록): 진입·청산 체결을 모두 +1거래일(lag 2). CAGR 하락 ≤ 1%p ∧ MDD 악화 ≤ 2%p.`);
      console.log(`${q.id} 게이트 D 해석(사전등록): 이웃 ${q.nbs.length}개(${q.nbs.map(([l]) => l).join(", ")}). 연속 전체 CAGR ≥ 069500 CAGR이어야 통과, 하나라도 미만이면 탈락.`);
      console.log(`${q.id} 게이트 E 해석(사전등록): 평가 구간 닫힌 거래 중 손익 상위 3개를 069500 수익률로 대체한 연속 전체 CAGR ≥ 069500.`);
      console.log(`${q.id} 게이트 F 해석(사전등록): ${q.randomDays ? "실제 신호일 수와 같은 수의 무작위 신호일에 같은 바스켓" : "실제 신호일·주문 수와 같게 후보 풀에서 무작위로 고른 진입"}, 같은 보유·비용, 시드 ${KSS_R3_SEED}, ${KSS_R3_DRAWS}회, 백분위 ≥ 95.`);
      console.log(`${q.id} 게이트 G: 진입 건수(종목별 진입)는 evaluate 결과 참조. H 해석(사전등록): 069500만 판정(CAGR +${PEAD_H_CAGR_GAIN_PP}%p, 또는 MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p).`);
      const rec = B1_DS6_REC;
      console.log(`\n=== ${q.id} vs 069500 vs DS6 기록 (CAGR % / MDD %; DS6 기록 연속 전체 ${rec.전체.join(" / ")}) ===\n| 구간 | 069500 | DS6 기록 | ${q.id} | ${q.id} − 069500 CAGR %p | ${q.id} − 069500 MDD %p | ${q.id} − DS6 CAGR %p | ${q.id} − DS6 MDD %p |\n|---|---|---|---|---|---|---|---|`);
      const recs = [rec.구간1, rec.구간2, rec.구간3, rec.전체];
      ALLW.forEach(([wn, w], k) => {
        const a = h.st(h.bhP, w), s = h.st(run, w), d6 = recs[k] as readonly number[];
        console.log(`| ${wn} | ${f2(a.cagr)} / ${f2(a.mdd)} | ${d6[0].toFixed(2)} / ${d6[1].toFixed(2)} | ${f2(s.cagr)} / ${f2(s.mdd)} | ${sg(s.cagr - a.cagr)} | ${sg(s.mdd - a.mdd)} | ${sg(s.cagr - d6[0])} | ${sg(s.mdd - d6[1])} |`);
      });
      {
        const yrs: number[] = [];
        for (let y = Number(FULL.from.slice(0, 4)); y <= Number(h.dataEnd.slice(0, 4)); y++) yrs.push(y);
        console.log(`\n=== 연도별 수익률 % (일수익률 복리; ${yrs[0]}년은 ${FULL.from}부터, ${yrs[yrs.length - 1]}년은 ${h.dataEnd}까지; DS6는 기록값) ===\n| 연도 | 069500 | DS6 기록 | ${q.id} | ${q.id} − 069500 %p | ${q.id} − DS6 %p |\n|---|---|---|---|---|---|`);
        const ex: number[] = [];
        for (const y of yrs) {
          const a = h.yearRet({ dates: CAL.slice(cPE + 1), ret: bRetAxis }, y), cc = h.yearRet(run, y), d6 = B1_DS6_YEARLY[String(y)];
          ex.push(cc - a);
          console.log(`| ${y} | ${f2(a)} | ${f2(d6)} | ${f2(cc)} | ${sg(cc - a)} | ${sg(cc - d6)} |`);
        }
        console.log(`${q.id} − 069500 승·패 연수: 승 ${ex.filter((x) => x > 0).length} / 패 ${ex.filter((x) => x < 0).length} (평균 ${sg(avg(ex))}%p, 중앙값 ${sg(median(ex))}%p)`);
      }
      {
        const s = h.st(run, FULL);
        console.log(`\n=== 거래 회전율과 비용 (연속 전체; DS6 기록 연 회전율 ${rec.turnover}%, 비용 합계 ${rec.cost}%) ===\n연 회전율 ${f2(s.turnover)}% | 비용 합계 ${f2(s.cost)}% (일별 비용 합) | 평균 투자 비중 ${f2(s.avgInv)}% | 평균 보유 종목 수 ${f2(s.avgN)}`);
      }
      {
        const sam = run.trades.filter((t) => t.code === DS89_SAMSUNG && run.dates[0] <= CAL[t.exitC]), tot = run.trades.reduce((a, t) => a + (t.proceeds - t.spend) / t.vAtEntry, 0), sp = sam.reduce((a, t) => a + (t.proceeds - t.spend) / t.vAtEntry, 0);
        const exS = new Set([DS89_SAMSUNG]), xr = runQ(q, P0, { lag: 1 }, exS), sx = h.st(xr, FULL), s0 = h.st(run, FULL), b0 = h.st(h.bhP, FULL);
        console.log(`\n=== 진단 [판정 불사용] 삼성전자 포함 여부 ===\n삼성전자 거래 ${sam.length}건 (닫힌 거래 ${run.trades.length}건 중 ${f2((sam.length / Math.max(run.trades.length, 1)) * 100)}%), 손익 기여 합 ${sg(sp * 100)} (전 거래 손익 합 ${sg(tot * 100)}의 ${f2(tot !== 0 ? (sp / tot) * 100 : 0)}%) | 삼성전자를 후보에서 뺀 경우 연속 전체 ${f2(sx.cagr)} / ${f2(sx.mdd)} (원래 ${f2(s0.cagr)} / ${f2(s0.mdd)}, 069500 대비 CAGR ${sg(sx.cagr - b0.cagr)}%p, 진입 ${xr.entryCs.filter((c) => CAL[c] >= FULL.from).length}건)`);
      }
      const top = [...run.trades].sort((a, b) => (b.proceeds - b.spend) / b.vAtEntry - (a.proceeds - a.spend) / a.vAtEntry).slice(0, 5) as SimTrade[];
      console.log(`상위 거래(진입 시 계좌 대비 손익 순): ${top.map((t) => `${label(t.code)} ${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")}`);
    },
  };
  const verdicts: Verdict[] = [evaluate(h, W, spec)];
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: q.trial - 1, contamNote: W.contamNote });
  console.log(`사전 고지: 누적 281회 기준 우연 통과 기대 281 × 0.05 = ${(281 * 0.05).toFixed(2)}건(근사). 통과 후보가 있어도 독립 확인 전에는 후보일 뿐이다. 2011~2026 구간은 반복해서 본 데이터라 오염돼 있다. 가설 4개의 정의는 첫 시험 전에 고정했고 결과를 보고 바꾸지 않았다. 묶음 1 시험 번호 ${B1_TRIALS.q1}~${B1_TRIALS.q4}, 이 실행 ${q.trial}.${q.id === "Q1" ? " 업종 분류는 현재 값 하나라는 한계(과거 시점 분류가 아님)가 있다." : ""}`);
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ") || "없음"} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${q.trial}`);
  void B1_PRIOR_TESTS; void mulberry32;
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

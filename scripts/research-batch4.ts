/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 묶음 4(M1~M3, 시도 291~293). 사전 등록: docs/research/batch4-prereg.md (정의 커밋 192be75, 첫 시험 전).
 * M1 원/달러 급등 → KSIC 26·30 / M2 WTI 급등 → KSIC 19·20, 급락 → KSIC 51 / M3 국고채 10년 금리 급등 → KSIC 64·65. 모두 공용 슬롯 시뮬레이터(lib/slotSim.ts, 수정 없음)에서 후보·청산 훅만 다르다.
 * ALLOC_MODE=repro: 매크로 변화·업종 선택 독립 대조(obs_date ≤ 판단일 전일 관측만 쓰는 브루트포스와 매일 비교, 미래 값 변조 점검 겸용)·체결 타이밍·업종 매핑 범위·구조 통계만 하고 성과는 계산·출력하지 않는다 / m1|m2|m3: 해당 가설 시험 1회. 공시·DART 호출 없음(업종 코드 보완값은 DB에서 읽기만).
 * 매크로 입력은 Storage research/macro_daily/macro_daily.parquet(약 0.23 MiB 읽기, 매니페스트 SHA-256 대조)이며 추가 수집 호출은 없다.
 */
import { createHash } from "node:crypto";
import { parquetReadObjects } from "hyparquet";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET } from "@/lib/investorFlowConfig";
import { MACRO_PARQUET, MACRO_MANIFEST } from "@/lib/macroDailyConfig";
import { simSlots, type SimCand, type SimHooks, type SimPos, type SimRun, type SimTrade } from "@/lib/slotSim";
import { L_SLIPPAGE } from "@/lib/megacapTrendConfig";
import { alignCloses } from "@/lib/le2VolTarget";
import { PEAD_H_CAGR_GAIN_PP, PEAD_H_MDD_GAIN_PP, PEAD_H_MDD_GAIN_STRONG_PP, PEAD_H_CAGR_FLOOR_PP } from "@/lib/peadConfig";
import { KSS_R3_DRAWS, KSS_R3_SEED } from "@/lib/kodexSectorSatConfig";
import { DS89_RUN_START, DS89_WINDOWS, DS89_SAMSUNG } from "@/lib/ds89Config";
import { B4_PRIOR_TESTS, B4_TRIALS, B4_RANK_DEPTH, B4_CHG_DAYS, B4_KSIC_PREFIX_LEN, B4_SERIES, B4_IND, B4_FWD_DAYS, B4_CUM_TRIALS, B4_M1_P0, B4_M1_NB, B4_M2_P0, B4_M2_NB, B4_M3_P0, B4_M3_NB, B4_F_DENOMINATOR, B4_DS6_REC, B4_DS6_YEARLY, type B4P } from "@/lib/batch4Config";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, mulberry32, xfer, SNAP_END, f2, avg, median, type S, type Win } from "./researchHarness";
import { evaluate, summaryReport, type CandSpec, type Verdict, type Windows } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
type Ex = ReadonlySet<string> | undefined;
type Mkt = "KOSPI" | "KOSDAQ";
const sha = (b: Uint8Array | Buffer | string): string => createHash("sha256").update(b).digest("hex");
interface QDef {
  id: string; trial: number; P0: B4P; nbs: [string, B4P][]; reasons: string[];
  slots: (P: B4P) => number;
  title: (P: B4P) => string;
  /** 판단일 c 종가의 후보(우선순위 순). */
  signals: (c: number, P: B4P, ex: Ex) => S[];
  /** 게이트 F 무작위 진입의 후보 풀. */
  pool: (c: number, P: B4P, ex: Ex) => S[];
  /** 청산 판단(판단일 c 종가, i = 그날 종목 행). lag = 체결 지연(1 = 다음 거래일). */
  exit: (p: SimPos, c: number, i: number | undefined, P: B4P, lag: number) => string | null;
}
async function main(): Promise<void> {
  const MODE = (process.env.ALLOC_MODE ?? "").trim().toLowerCase();
  if (!["repro", "m1", "m2", "m3"].includes(MODE)) throw new Error("ALLOC_MODE=repro|m1|m2|m3 필요");
  const REPRO = MODE === "repro";
  console.log(`연구 묶음 4(M1~M3, 시도 ${B4_TRIALS.m1}~${B4_TRIALS.m3}) ${REPRO ? "사전 점검(신호 독립 대조·체결 타이밍·구조 통계만, 성과 미계산)" : `시험 ${MODE.toUpperCase()} 1회`} 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, nameOf, indOf } = await loadK200P(h);

  // ---- 평가 구간 (묶음 1과 같음) ----
  const cPE = CAL.findIndex((d) => d >= DS89_RUN_START);
  if (cPE < 0 || CAL[cPE] !== DS89_RUN_START) throw new Error(`${DS89_RUN_START}이 거래일 달력에 없음`);
  const NW: [string, Win][] = DS89_WINDOWS.map(([n, f, t]) => [n, { from: f, to: t }]);
  const FULL: Win = { from: CAL[cPE + 1], to: "9999-12-31" };
  if (NW[0][1].from !== FULL.from) throw new Error(`구간 1 시작 ${NW[0][1].from}이 연속 평가 시작 ${FULL.from}과 다르다`);
  const W: Windows = { NW, FULL, ALL: [...NW, ["연속 전체 2011-01~2026-10", FULL]], noEx26: true, contamNote: "경고(오염): 이 구간 전체(2011~2026)는 DS6·DS4·LV1 등 선행 연구에서 이미 반복해 본 데이터다. 묶음 4의 가설은 묶음 1~3과 DS6 계열 결과, 매크로 가용성 점검을 본 뒤 정한 것이라 순수 검증이 아니다." };
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
      const list = e.slice(0, B4_RANK_DEPTH).map((x) => x.s);
      v = { list, rank: new Map(list.map((s, k) => [s.code, k + 1])) };
      rankCache.set(key, v);
    }
    return v;
  };
  const rankAt = (c: number): { list: S[]; rank: Map<string, number> } => rankMkt(c, "KOSPI");
  const alignedCache = new Map<string, Float64Array>();
  const alignedOf = (code: string): Float64Array => { let a = alignedCache.get(code); if (!a) { const s = byCode.get(code) as S; a = alignCloses(CAL, s.idx, s.close); alignedCache.set(code, a); } return a; };
  const holdDone = (p: SimPos, c: number, hold: number, lag: number): boolean => c >= p.entryC + hold - lag;
  const rowLive = (s: S, c: number): number | undefined => { const i = s.idx.get(CAL[c]); return i !== undefined && s.vol[i] > 0 ? i : undefined; };

  // ---- 매크로 일별 원본(Storage Parquet, 약 0.23 MiB 읽기, 매니페스트 SHA-256 대조) → 한국 거래일 전진 채움 ----
  interface Obs { d: string; v: number }
  const macroObs = new Map<string, Obs[]>();
  {
    const dl = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).download(MACRO_PARQUET), ml = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).download(MACRO_MANIFEST);
    if (dl.error || !dl.data || ml.error || !ml.data) throw new Error("매크로 Parquet·매니페스트가 Storage에 없다 — 재수집하지 않고 중단하고 보고한다");
    const pBuf = await dl.data.arrayBuffer(), mTxt = await ml.data.text();
    xfer.bytes += (dl.data as Blob).size + (ml.data as Blob).size;
    const man = JSON.parse(mTxt) as { sha256: string; rows: number; bytes: number; series: { id: string; rows: number; nulls: number; first: string; last: string }[] };
    if (pBuf.byteLength !== man.bytes || sha(new Uint8Array(pBuf)) !== man.sha256) throw new Error("매크로 Parquet이 매니페스트(SHA-256·바이트)와 다르다 — 중단하고 보고한다");
    const rows = (await parquetReadObjects({ file: pBuf })) as { series_id: string; obs_date: string; value: number | null }[];
    if (rows.length !== man.rows) throw new Error(`매크로 행 수 ${rows.length} ≠ 매니페스트 ${man.rows}`);
    for (const r of rows) { if (r.value === null || !Number.isFinite(Number(r.value))) continue; let l = macroObs.get(r.series_id); if (!l) { l = []; macroObs.set(r.series_id, l); } l.push({ d: r.obs_date, v: Number(r.value) }); }
    for (const l of macroObs.values()) l.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    console.log(`매크로 Parquet 매니페스트 대조 통과: ${rows.length}행 ${(pBuf.byteLength / 1024).toFixed(1)} KiB SHA-256 일치 | ${Object.values(B4_SERIES).map((id) => { const l = macroObs.get(id); return `${id} 비결측 ${l?.length ?? 0}행 ${l?.[0]?.d ?? "-"}~${l?.[l.length - 1]?.d ?? "-"}`; }).join(" / ")}`);
    for (const id of Object.values(B4_SERIES)) if (!macroObs.get(id)?.length) throw new Error(`${id} 시리즈가 비었다 — 중단하고 보고한다`);
  }
  /** 한국 거래일 k의 x[k] = obs_date ≤ CAL[k]인 최신 비결측 관측값(없으면 NaN). age[k] = 그 관측일에서 CAL[k]까지 달력 일수. */
  const ffCache = new Map<string, { x: Float64Array; age: Int32Array }>();
  const ffOf = (id: string): { x: Float64Array; age: Int32Array } => {
    let v = ffCache.get(id);
    if (!v) {
      const obs = macroObs.get(id) as Obs[], x = new Float64Array(nCal).fill(Number.NaN), age = new Int32Array(nCal).fill(-1);
      let r = 0, last: Obs | undefined;
      for (let k = 0; k < nCal; k++) {
        while (r < obs.length && obs[r].d <= CAL[k]) { last = obs[r]; r++; }
        if (last) { x[k] = last.v; age[k] = Math.round((Date.parse(CAL[k]) - Date.parse(last.d)) / 86_400_000); }
      }
      v = { x, age };
      ffCache.set(id, v);
    }
    return v;
  };
  /** 판단일 c의 20거래일 변화: M3(KTB10Y) = x[c−1] − x[c−21](%p), 나머지 = (x[c−1] ÷ x[c−21] − 1) × 100(%). 값이 없거나(비율은 ≤ 0 포함) 계산 불가면 NaN. */
  const chgExpr = (id: string, a: number, b: number): number => {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
    if (id === B4_SERIES.m3) return a - b;
    if (!(a > 0) || !(b > 0)) return Number.NaN;
    return (a / b - 1) * 100;
  };
  const chgCache = new Map<string, Float64Array>();
  const chgOf = (id: string): Float64Array => {
    let v = chgCache.get(id);
    if (!v) {
      const x = ffOf(id).x;
      v = new Float64Array(nCal).fill(Number.NaN);
      for (let c = B4_CHG_DAYS + 1; c < nCal; c++) v[c] = chgExpr(id, x[c - 1], x[c - 1 - B4_CHG_DAYS]);
      chgCache.set(id, v);
    }
    return v;
  };
  /** cond(c): up = 변화 ≥ +thr, dn = 변화 ≤ −thr (비엄격, NaN이면 거짓). edge(c) = cond(c) ∧ ¬cond(c−1). */
  const condAt = (ch: Float64Array, c: number, thr: number, dir: "up" | "dn"): boolean => (c >= 0 && (dir === "up" ? ch[c] >= thr : ch[c] <= -thr));
  const edgeAt = (id: string, c: number, thr: number, dir: "up" | "dn"): boolean => { const ch = chgOf(id); return condAt(ch, c, thr, dir) && !condAt(ch, c - 1, thr, dir); };
  /** 업종 코드 앞 2자리(코드 없으면 빈 문자열). */
  const indPre = (code: string): string => (indOf.get(code) ?? "").slice(0, B4_KSIC_PREFIX_LEN);
  /** 판단일 c의 K200P(행 있고 거래량 > 0) 중 업종별 시총 상위 k종목, 시총 순위 순. */
  const pick = (c: number, prefixes: readonly string[], k: number, ex: Ex): S[] => {
    const rk = rankAt(c), live = rk.list.filter((s) => !ex?.has(s.code) && rowLive(s, c) !== undefined), out: S[] = [];
    for (const pf of prefixes) { let n = 0; for (const s of live) if (indPre(s.code) === pf) { out.push(s); if (++n >= k) break; } }
    return out.sort((a, b) => (rk.rank.get(a.code) as number) - (rk.rank.get(b.code) as number));
  };
  const pool = (c: number, _P: B4P, ex: Ex): S[] => rankAt(c).list.filter((s) => !ex?.has(s.code) && rowLive(s, c) !== undefined);
  const exitHold = (p: SimPos, c: number, _i: number | undefined, P: B4P, lag: number): string | null => (holdDone(p, c, P.hold, lag) ? "보유 만료" : null);
  const M1: QDef = {
    id: "M1", trial: B4_TRIALS.m1, P0: B4_M1_P0, nbs: B4_M1_NB, reasons: ["보유 만료"], slots: (P) => 2 * P.k,
    title: (P) => `M1: 원/달러(ECOS 매매기준율) 20거래일 변화 ≥ +${P.thr}%가 새로 성립하면 K200P 중 KSIC ${B4_IND.m1.join("·")} 업종별 시총 상위 ${P.k}종목을 다음 거래일 종가에 동일 비중 매수, ${P.hold}거래일 보유, 슬롯 ${2 * P.k}개`,
    signals: (c, P, ex) => (edgeAt(B4_SERIES.m1, c, P.thr, "up") ? pick(c, B4_IND.m1, P.k, ex) : []), pool, exit: exitHold,
  };
  const M2: QDef = {
    id: "M2", trial: B4_TRIALS.m2, P0: B4_M2_P0, nbs: B4_M2_NB, reasons: ["보유 만료"], slots: (P) => 2 * P.k,
    title: (P) => `M2: WTI 20거래일 변화 ≥ +${P.thr}%가 새로 성립하면 KSIC ${B4_IND.m2up.join("·")} 업종별 시총 상위 ${P.k}종목, ≤ −${P.thr}%가 새로 성립하면 KSIC ${B4_IND.m2dn.join("·")} 시총 상위 ${P.k}종목을 다음 거래일 종가에 동일 비중 매수, ${P.hold}거래일 보유, 슬롯 ${2 * P.k}개(두 규칙 한 시험)`,
    signals: (c, P, ex) => (edgeAt(B4_SERIES.m2, c, P.thr, "up") ? pick(c, B4_IND.m2up, P.k, ex) : edgeAt(B4_SERIES.m2, c, P.thr, "dn") ? pick(c, B4_IND.m2dn, P.k, ex) : []), pool, exit: exitHold,
  };
  const M3: QDef = {
    id: "M3", trial: B4_TRIALS.m3, P0: B4_M3_P0, nbs: B4_M3_NB, reasons: ["보유 만료"], slots: (P) => 2 * P.k,
    title: (P) => `M3: 국고채 10년 금리 20거래일 차이 ≥ +${P.thr}%p가 새로 성립하면 K200P 중 KSIC ${B4_IND.m3.join("·")} 업종별 시총 상위 ${P.k}종목을 다음 거래일 종가에 동일 비중 매수, ${P.hold}거래일 보유, 슬롯 ${2 * P.k}개`,
    signals: (c, P, ex) => (edgeAt(B4_SERIES.m3, c, P.thr, "up") ? pick(c, B4_IND.m3, P.k, ex) : []), pool, exit: exitHold,
  };
  const QS: Record<string, QDef> = { m1: M1, m2: M2, m3: M3 };

  // ---- 실행 ----
  const hooksFor = (q: QDef, P: B4P, lag: number, ex?: Ex): SimHooks<SimCand> => ({
    candsOf: (c) => q.signals(c, P, ex).map((s) => ({ s, code: s.code })),
    exitReason: (p, c, i) => q.exit(p, c, i, P, lag),
  });
  const cfgOf = (q: QDef, P: B4P) => ({ slip: L_SLIPPAGE, maxPos: q.slots(P), capFrac: 1 / q.slots(P), cooldown: 0 });
  const runQ = (q: QDef, P: B4P, o: { lag: number; replace?: Set<string>; detail?: boolean }, ex?: Ex): SimRun => simSlots(env(cPE), cfgOf(q, P), hooksFor(q, P, o.lag, ex), { lag: o.lag, replace: o.replace, detail: o.detail });
  const randomRun = (q: QDef, P: B4P, rng: () => number, ob: Map<number, number>): SimRun => {
    const hooks: SimHooks<SimCand> = {
      candsOf: (c, held, blocked) => {
        const n = ob.get(c) ?? 0;
        if (!n) return [];
        const pl = q.pool(c, P, undefined).filter((s) => !held(s.code) && !blocked(s.code)), out: SimCand[] = [];
        while (out.length < n && pl.length) { const s = pl.splice(Math.floor(rng() * pl.length), 1)[0]; out.push({ s, code: s.code }); }
        return out;
      },
      exitReason: (p, c, i) => q.exit(p, c, i, P, 1),
    };
    return simSlots(env(cPE), cfgOf(q, P), hooks, { lag: 1 });
  };

  // =====================================================================================================================
  // 1. 사전 점검 (성과 아님): 매크로 변화·업종 선택 독립 대조(과거 관측만 쓰는 브루트포스), 체결 타이밍, 업종 매핑 범위, 구조 통계
  // =====================================================================================================================
  const bruteRank = (c: number): string[] => {
    const d = CAL[c], m = membAt(d), e: { code: string; mc: number }[] = [];
    if (m) for (const s of h.stocks) { const i = s.idx.get(d); if (i !== undefined && !excluded.has(s.code) && m.get(s.code) === "KOSPI") e.push({ code: s.code, mc: s.mcapRow[i] }); }
    e.sort((a, b) => b.mc - a.mc || (a.code < b.code ? -1 : 1));
    return e.slice(0, B4_RANK_DEPTH).map((x) => x.code);
  };
  /** 브루트 매크로 변화: 판단일 c에서 obs_date ≤ CAL[c−1]인 관측만 걸러낸 목록에서 직접 찾는다(전진 채움 배열·모듈 캐시 없음). */
  const bChg = (id: string, c: number): number => {
    if (c - 1 - B4_CHG_DAYS < 0) return Number.NaN;
    const obs = macroObs.get(id) as Obs[], past = obs.filter((o) => o.d <= CAL[c - 1]);
    const lastLe = (date: string): number => { let v = Number.NaN; for (const o of past) { if (o.d <= date) v = o.v; else break; } return v; };
    return chgExpr(id, lastLe(CAL[c - 1]), lastLe(CAL[c - 1 - B4_CHG_DAYS]));
  };
  const bChgCache = new Map<string, Float64Array>();
  const bChgArr = (id: string): Float64Array => { let a = bChgCache.get(id); if (!a) { a = new Float64Array(nCal).fill(Number.NaN); for (let c = B4_CHG_DAYS + 1; c < nCal; c++) a[c] = bChg(id, c); bChgCache.set(id, a); } return a; };
  const bEdge = (id: string, c: number, thr: number, dir: "up" | "dn"): boolean => { const a = bChgArr(id), t = (k: number): boolean => (k >= 0 && (dir === "up" ? a[k] >= thr : a[k] <= -thr)); return t(c) && !t(c - 1); };
  const bPick = (c: number, prefixes: readonly string[], k: number): string[] => {
    const rk = bruteRank(c), live = rk.filter((code) => { const s = byCode.get(code) as S, i = s.idx.get(CAL[c]); return i !== undefined && s.vol[i] > 0; }), out: string[] = [];
    for (const pf of prefixes) { let n = 0; for (const code of live) if ((indOf.get(code) ?? "").slice(0, 2) === pf) { out.push(code); if (++n >= k) break; } }
    return out.sort((a, b) => rk.indexOf(a) - rk.indexOf(b));
  };
  const brSignals = (id: string, c: number, P: B4P): string[] => {
    if (id === "M1") return bEdge(B4_SERIES.m1, c, P.thr, "up") ? bPick(c, B4_IND.m1, P.k) : [];
    if (id === "M2") return bEdge(B4_SERIES.m2, c, P.thr, "up") ? bPick(c, B4_IND.m2up, P.k) : bEdge(B4_SERIES.m2, c, P.thr, "dn") ? bPick(c, B4_IND.m2dn, P.k) : [];
    return bEdge(B4_SERIES.m3, c, P.thr, "up") ? bPick(c, B4_IND.m3, P.k) : [];
  };
  const modSignals = (q: QDef, c: number, P: B4P): string[] => q.signals(c, P, undefined).map((s) => s.code);

  if (REPRO) {
    console.log(`\n=== 1. 매크로 자료 점검 (전진 채움 규칙: x[k] = obs_date ≤ CAL[k] 최신 비결측값; 평가 구간 ${CAL[cPE]}~${CAL[nCal - 2]}) ===`);
    for (const id of Object.values(B4_SERIES)) {
      const ff = ffOf(id), obs = macroObs.get(id) as Obs[];
      let stale = 0, maxAge = 0, nan = 0, neg = 0;
      for (let k = cPE - B4_CHG_DAYS - 1; k < nCal; k++) { if (!Number.isFinite(ff.x[k])) nan++; else { if (ff.age[k] > 7) stale++; if (ff.age[k] > maxAge) maxAge = ff.age[k]; if (!(ff.x[k] > 0)) neg++; } }
      const lastObs = obs[obs.length - 1].d, tail = CAL[nCal - 1];
      console.log(`  ${id}: 비결측 관측 ${obs.length}행 ${obs[0].d}~${lastObs} | 평가 구간(+20일 앞) 값 없는 거래일 ${nan}일, 채움 나이 7일 초과 ${stale}일(최대 ${maxAge}일), 값 ≤ 0인 날 ${neg}일 | 달력 마지막 ${tail}, 마지막 관측 ${lastObs}`);
    }
    console.log(`\n=== 2. 매크로 변화 독립 대조 (판단일마다 모듈 = 브루트포스(obs_date ≤ CAL[c−1]만 사용); 미래 정보 점검 겸용) ===`);
    for (const id of Object.values(B4_SERIES)) {
      const a = chgOf(id), b = bChgArr(id);
      let nBad = 0, nDef = 0, first = "";
      for (let c = cPE - 1; c < nCal - 1; c++) { const same = Object.is(a[c], b[c]) || (Number.isNaN(a[c]) && Number.isNaN(b[c])); if (!same) { nBad++; if (!first) first = `${CAL[c]} 모듈 ${a[c]} 브루트 ${b[c]}`; } if (Number.isFinite(a[c])) nDef++; }
      console.log(`  ${id}: 판단일 ${nCal - 1 - cPE + 1}일 중 값 있는 날 ${nDef}일 | 불일치 ${nBad}일 ${nBad === 0 ? "통과" : `불일치 (${first})`}`);
      if (nBad > 0) throw new Error(`${id} 매크로 변화 독립 대조 불일치 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)`);
    }
    {
      // 미래 값 변조 점검: 판단일 c 이후(obs_date ≥ CAL[c]) 관측을 모두 터무니없는 값으로 바꿔도 c의 변화가 같아야 한다(무작위 40일).
      const rng = mulberry32(20261114);
      let nBad = 0, nT = 0;
      for (const id of Object.values(B4_SERIES)) {
        const obs = macroObs.get(id) as Obs[], a = chgOf(id);
        for (let t = 0; t < 40; t++) {
          const c = cPE + Math.floor(rng() * (nCal - 1 - cPE)), tam = obs.map((o) => ({ d: o.d, v: o.d >= CAL[c] ? 1e9 : o.v }));
          const lastLe = (date: string): number => { let v = Number.NaN; for (const o of tam) { if (o.d <= date) v = o.v; else break; } return v; };
          // 변조 목록에서 c−1 시점 값은 obs_date ≤ CAL[c−1]인 관측만으로 정해져야 하므로, 변조(≥ CAL[c])가 들어와도 같은 값이어야 한다.
          const v = chgExpr(id, lastLe(CAL[c - 1]), lastLe(CAL[c - 1 - B4_CHG_DAYS]));
          nT++;
          if (!(Object.is(v, a[c]) || (Number.isNaN(v) && Number.isNaN(a[c])))) nBad++;
        }
      }
      console.log(`  미래 값 변조 점검(판단일 이후 관측을 1e9로 바꿔 다시 계산) ${nT}건 중 변화 달라진 건 ${nBad}건 ${nBad === 0 ? "통과" : "실패"}`);
      if (nBad > 0) throw new Error("미래 값 변조 점검 실패 — 중단하고 보고한다");
    }
    console.log(`\n=== 3. 신호 독립 대조 (판단일마다 모듈 신호 = 브루트포스(업종 선택 포함, 순서까지); ${CAL[cPE]}~${CAL[nCal - 2]}) ===`);
    for (const q of [M1, M2, M3]) {
      for (const [nm, P] of [["기본", q.P0] as [string, B4P], ...q.nbs.map(([l, ch]) => [l, { ...q.P0, ...ch }] as [string, B4P])]) {
        let nBad = 0, nSig = 0, nDays = 0, firstBad = "";
        for (let c = cPE; c < nCal - 1; c++) {
          const a = modSignals(q, c, P), b = brSignals(q.id, c, P);
          if (a.join() !== b.join()) { nBad++; if (!firstBad) firstBad = `${CAL[c]} 모듈 ${a.join(",") || "-"} / 브루트 ${b.join(",") || "-"}`; }
          if (a.length) { nDays++; nSig += a.length; }
        }
        console.log(`  ${q.id} ${nm}: 신호가 있는 날(사건) ${nDays}일, 신호 합 ${nSig}개 | 브루트포스와 불일치 ${nBad}일 ${nBad === 0 ? "통과" : `불일치 (${firstBad})`}`);
        if (nBad > 0) throw new Error(`${q.id} 신호 독립 대조 불일치 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)`);
      }
    }
    console.log(`\n=== 3b. 체결·보유 타이밍 점검 (진입 = 신호일 + lag, 청산 = 체결일 + hold(거래정지 순연 제외), 기본 설정 lag 1·2; 성과 미출력) ===`);
    const halted = (s: S, k: number): boolean => { const j = s.idx.get(CAL[k]); return j === undefined || s.vol[j] === 0; };
    for (const q of [M1, M2, M3]) {
      for (const lag of [1, 2]) {
        const r = runQ(q, q.P0, { lag, detail: true }), P = q.P0;
        let badEntry = 0, badHold = 0, nDeferred = 0, badEdge = 0, nDelist = 0;
        for (const t of r.trades) {
          const s = byCode.get(t.code) as S;
          if (!brSignals(q.id, t.entryC - lag, P).includes(t.code)) badEntry++;
          if (t.reason !== "보유 만료") { nDelist++; continue; }
          const due = t.entryC + P.hold;
          if (t.exitC < due) badHold++;
          else if (t.exitC > due) { nDeferred++; for (let k = due; k < t.exitC; k++) if (!halted(s, k)) { badHold++; break; } }
        }
        // 재진입 규칙: 같은 사건(연속으로 조건이 참인 구간) 안에서는 신호일이 한 번뿐이어야 한다.
        for (let c = cPE + 1; c < nCal - 1; c++) if (modSignals(q, c, P).length && modSignals(q, c - 1, P).length) badEdge++;
        console.log(`  ${q.id} lag ${lag}: 진입 ${r.entryCs.length}건, 청산 ${r.trades.length}건 | 신호일+${lag}이 아닌 진입 ${badEntry}건 | 보유 만료가 규칙일보다 이른 날 또는 정지일이 아닌데 늦은 청산 ${badHold}건 (거래정지로 순연된 정상 청산 ${nDeferred}건, 상장폐지 청산 ${nDelist}건) | 이틀 연속 신호 ${badEdge}일`);
        if (badEntry > 0 || badHold > 0 || badEdge > 0) throw new Error(`${q.id} 체결 타이밍 점검 실패 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)`);
      }
    }
    console.log(`\n=== 4. 업종 매핑 범위 (종목별 현재 induty_code 앞 2자리, 평가 구간 K200P; 성과 아님) ===`);
    {
      const allPre = [...new Set([...B4_IND.m1, ...B4_IND.m2up, ...B4_IND.m2dn, ...B4_IND.m3])];
      console.log(`업종 코드가 있는 종목 ${indOf.size}개(유니버스 ${h.codes.length}개 중), 제외 규칙 해당 ${excluded.size}개`);
      console.log(`| 연말 판단일 | K200P 종목 | 업종 코드 없는 종목 | ${allPre.map((p) => `KSIC ${p}`).join(" | ")} |\n|---|---|---|${allPre.map(() => "---").join("|")}|`);
      for (let y = Number(CAL[cPE].slice(0, 4)); y <= Number(CAL[nCal - 1].slice(0, 4)); y++) {
        let c = -1;
        for (let k = nCal - 1; k >= 0; k--) if (CAL[k].startsWith(String(y))) { c = k; break; }
        if (c < 0) continue;
        const list = rankAt(c).list, noInd = list.filter((s) => !indOf.has(s.code)).length;
        console.log(`| ${CAL[c]} | ${list.length} | ${noInd} | ${allPre.map((p) => list.filter((s) => indPre(s.code) === p).length).join(" | ")} |`);
      }
      const nm = (pf: readonly string[]): string => { const c = nCal - 2, l = rankAt(c).list.filter((s) => (pf as readonly string[]).includes(indPre(s.code))); return l.slice(0, 8).map((s) => `${label(s.code)}(${indPre(s.code)})`).join(", "); };
      console.log(`마지막 판단일 ${CAL[nCal - 2]} 시총 상위 종목(업종 접두사): M1 ${nm(B4_IND.m1)} | M2 상승 ${nm(B4_IND.m2up)} / 하락 ${nm(B4_IND.m2dn)} | M3 ${nm(B4_IND.m3)}`);
    }
    console.log(`\n=== 5. 구조 통계 (기본 설정, 성과 아님) ===`);
    for (const q of [M1, M2, M3]) {
      const ev: number[] = [];
      let mx = 0, ns = 0;
      for (let c = cPE; c < nCal - 1; c++) { const n = q.signals(c, q.P0, undefined).length; if (n) { ev.push(c); ns += n; if (n > mx) mx = n; } }
      const gaps = ev.slice(1).map((c, i) => c - ev[i]);
      console.log(`  ${q.id}: 진입 사건 ${ev.length}회(조건 첫 성립일 중 후보가 있는 날), 후보 합 ${ns}, 사건당 최대 ${mx}종목, 사건 간격(거래일) 최소 ${gaps.length ? Math.min(...gaps) : "-"} / 중앙값 ${gaps.length ? median(gaps) : "-"} / 최대 ${gaps.length ? Math.max(...gaps) : "-"} | 사건일: ${ev.map((c) => CAL[c]).join(" ")}`);
    }
    console.log(`\n사전 점검 종료: 매크로 변화 독립 대조·미래 값 변조 점검, 신호 독립 대조(M1~M3 기본·이웃 설정 전부 모든 판단일), 체결·보유 타이밍(lag 1·2), 업종 매핑 범위, 구조 통계 통과. 시험 성과는 계산·출력하지 않았다 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    void B4_PRIOR_TESTS;
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
  const q = QS[MODE] as QDef;
  const { id, trial, P0, nbs } = q;
  const title = q.title(P0);
  const nSlots = q.slots(P0);
  const runAny = (P: B4P, o: { lag: number; replace?: Set<string>; detail?: boolean }, ex?: Ex): SimRun => runQ(q, P, o, ex);
  const spec: CandSpec = {
    id, trial, title, defense: false, capFrac: 1 / nSlots, fDenominator: B4_F_DENOMINATOR, ref: { id: "069500", run: bhAsRun },
    hRule: (full, rb) => { const a = hVs(full, rb); return { ok: a.ok, note: `[사전등록: 069500만 판정] 069500 ${f2(rb.cagr)} / ${f2(rb.mdd)} → ${a.ok ? "O" : "X"} (${a.text})` }; },
    run: (o) => runAny(P0, o),
    neighbors: nbs.map(([lb, ch]) => ({ label: lb, run: () => runAny({ ...P0, ...ch }, { lag: 1 }) })),
    random: (rng, ob) => randomRun(q, P0, rng, ob),
    reasons: q.reasons, label,
    extra: (run) => {
      console.log(`${id} 게이트 C 해석(사전등록): 진입·청산 체결을 모두 +1거래일(lag 2). CAGR 하락 ≤ 1%p ∧ MDD 악화 ≤ 2%p.`);
      console.log(`${id} 게이트 D 해석(사전등록): 이웃 ${nbs.length}개(${nbs.map(([l]) => l).join(", ")}). 연속 전체 CAGR ≥ 069500 CAGR이어야 통과, 하나라도 미만이면 탈락.`);
      console.log(`${id} 게이트 E 해석(사전등록): 평가 구간 닫힌 거래 중 손익 상위 3개를 069500 수익률로 대체한 연속 전체 CAGR ≥ 069500.`);
      console.log(`${id} 게이트 F 해석(사전등록): 실제 신호일·주문 수와 같게 후보 풀(그날 행이 있고 거래량 > 0인 K200P 종목)에서 무작위로 고른 진입, 같은 청산 규칙·비용, 시드 ${KSS_R3_SEED}, ${KSS_R3_DRAWS}회, 백분위 ≥ 95(참고선 ${f2((1 - 0.05 / B4_F_DENOMINATOR) * 100)}).`);
      console.log(`${id} 게이트 G: 진입 건수(종목별 진입)는 evaluate 결과 참조. H 해석(사전등록): 069500만 판정(CAGR +${PEAD_H_CAGR_GAIN_PP}%p, 또는 MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p).`);
      const rec = B4_DS6_REC;
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
          const a = h.yearRet({ dates: CAL.slice(cPE + 1), ret: bRetAxis }, y), cc = h.yearRet(run, y), d6 = B4_DS6_YEARLY[String(y)];
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

      // ---- 승률·손익 공통 보고 [판정 불사용] ----
      {
        const nets = run.trades.map((t) => (t.proceeds / t.spend - 1) * 100), wins = nets.filter((x) => x > 0), loss = nets.filter((x) => x <= 0);
        const aw = wins.length ? avg(wins) : Number.NaN, al = loss.length ? avg(loss) : Number.NaN;
        const s = h.st(run, FULL);
        console.log(`\n=== 승률·손익 공통 보고 [판정 불사용] (평가 구간 닫힌 거래 ${nets.length}건, 비용 차감 후 순수익률) ===\n| 승률 % | 평균 이익 % | 평균 손실 % | 손익비 | 거래당 기대값 % | 보유 일수 중앙값 | 연 회전율 % | 비용 합계 % |\n|---|---|---|---|---|---|---|---|\n| ${f2((wins.length / Math.max(nets.length, 1)) * 100)} | ${f2(aw)} | ${f2(al)} | ${f2(aw / Math.abs(al))} | ${f2(avg(nets))} | ${median(run.trades.map((t) => t.exitC - t.entryC))} | ${f2(s.turnover)} | ${f2(s.cost)} |`);
      }
      // ---- 진입 후 5·10·20거래일 전방 수익 대 무작위 진입(같은 날·같은 수) [판정 불사용] ----
      {
        const ents = run.trades.filter((t) => t.entryC >= cPE + 1), byDay = new Map<number, string[]>();
        for (const t of ents) { const l = byDay.get(t.entryC) ?? []; l.push(t.code); byDay.set(t.entryC, l); }
        const fwd = (code: string, c: number, k: number): number => { const a = alignedOf(code); return c + k < nCal && a[c] > 0 && a[c + k] > 0 ? (a[c + k] / a[c] - 1) * 100 : Number.NaN; };
        const actual = B4_FWD_DAYS.map((k) => { let sm = 0, n = 0; for (const t of ents) { const v = fwd(t.code, t.entryC, k); if (Number.isFinite(v)) { sm += v; n++; } } return { sm: n ? sm / n : Number.NaN, n }; });
        // 날마다 후보 풀(판단일 = 진입일 − 1)과 풀 종목의 전방 수익을 한 번만 만든다.
        const days = [...byDay.keys()].sort((a, b) => a - b);
        const poolF = new Map<number, { f: Float64Array[]; len: number }>();
        for (const c of days) { const pl = q.pool(c - 1, P0, undefined); poolF.set(c, { len: pl.length, f: B4_FWD_DAYS.map((k) => Float64Array.from(pl.map((s) => fwd(s.code, c, k)))) }); }
        const rng = mulberry32(KSS_R3_SEED), draws = KSS_R3_DRAWS, rm: number[][] = B4_FWD_DAYS.map(() => []);
        for (let dI = 0; dI < draws; dI++) {
          const sums = B4_FWD_DAYS.map(() => ({ s: 0, n: 0 }));
          for (const c of days) {
            const pf = poolF.get(c) as { f: Float64Array[]; len: number }, need = Math.min((byDay.get(c) as string[]).length, pf.len), idx = Array.from({ length: pf.len }, (_, k) => k);
            for (let j = 0; j < need; j++) { const m = j + Math.floor(rng() * (pf.len - j)); [idx[j], idx[m]] = [idx[m], idx[j]]; const ii = idx[j]; B4_FWD_DAYS.forEach((_, kk) => { const v = pf.f[kk][ii]; if (Number.isFinite(v)) { sums[kk].s += v; sums[kk].n++; } }); }
          }
          sums.forEach((x, kk) => rm[kk].push(x.n ? x.s / x.n : Number.NaN));
        }
        console.log(`\n=== 진입 후 전방 수익 [판정 불사용] (닫힌 거래의 진입 체결일 종가 → +k거래일 종가, 비용 미차감; 무작위 = 같은 날·같은 수를 후보 풀에서 ${draws}회 무작위, 시드 ${KSS_R3_SEED}) ===\n| 보유 기간 | 진입 수(값 있음) | 실제 평균 % | 무작위 평균의 평균 % | 실제 − 무작위 %p | 백분위(무작위 평균이 실제보다 작은 비율 %) |\n|---|---|---|---|---|---|`);
        B4_FWD_DAYS.forEach((k, kk) => {
          const arr = rm[kk].filter((x) => Number.isFinite(x)), a = actual[kk].sm;
          const below = arr.filter((x) => x < a).length + arr.filter((x) => x === a).length / 2, mu = avg(arr);
          console.log(`| ${k}거래일 | ${actual[kk].n} | ${f2(a)} | ${f2(mu)} | ${sg(a - mu)} | ${f2((below / Math.max(arr.length, 1)) * 100)} |`);
        });
      }
    },
  };
  const verdicts: Verdict[] = [evaluate(h, W, spec)];
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: trial - 1, contamNote: W.contamNote });
  console.log(`사전 고지: 누적 ${B4_CUM_TRIALS}회 기준 우연 통과 기대 ${B4_CUM_TRIALS} × 0.05 = ${(B4_CUM_TRIALS * 0.05).toFixed(2)}건(근사). 통과 후보가 있어도 독립 확인 전에는 후보일 뿐이다. 2011~2026 구간은 반복해서 본 데이터라 오염돼 있다. 가설 3개의 정의는 첫 시험 전에 고정했고 결과를 보고 바꾸지 않았다. 묶음 4 시험 번호 ${B4_TRIALS.m1}~${B4_TRIALS.m3}, 이 실행 ${trial}.`);
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ") || "없음"} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${trial}`);
  void B4_PRIOR_TESTS;
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 묶음 3(S1~S4, 시도 287~290). 사전 등록: docs/research/batch3-prereg.md (정의 커밋 141a794, 첫 시험 전).
 * S1 볼린저 하단 복귀+RSI / S2 볼린저 수축 후 상단 돌파 / S3 공포 구간(전일 VKOSPI ≥ 25) 볼린저 하단 복귀 / S4 ADX 추세 필터+돌파. 모두 공용 슬롯 시뮬레이터(lib/slotSim.ts, 수정 없음)에서 후보·청산 훅만 다르다.
 * ALLOC_MODE=repro: 신호 독립 대조(과거 이력만 쓰는 브루트포스와 매일 비교 = 미래 정보 점검 겸용)·체결 타이밍·VKOSPI 적용 재계산·구조 통계만 하고 성과는 계산·출력하지 않는다 / s1|s2|s3|s4: 해당 가설 시험 1회. 공시·DART 사용 없음.
 * VKOSPI 정리본은 Actions 캐시(.vkospi-inputs, Storage 읽기 0)이며 S3·사전 점검에서만 읽는다.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parquetReadObjects } from "hyparquet";
import { simSlots, type SimCand, type SimHooks, type SimPos, type SimRun, type SimTrade } from "@/lib/slotSim";
import { L_SLIPPAGE } from "@/lib/megacapTrendConfig";
import { alignCloses } from "@/lib/le2VolTarget";
import { PEAD_H_CAGR_GAIN_PP, PEAD_H_MDD_GAIN_PP, PEAD_H_MDD_GAIN_STRONG_PP, PEAD_H_CAGR_FLOOR_PP } from "@/lib/peadConfig";
import { KSS_R3_DRAWS, KSS_R3_SEED } from "@/lib/kodexSectorSatConfig";
import { DS89_RUN_START, DS89_WINDOWS, DS89_SAMSUNG } from "@/lib/ds89Config";
import { VK_CACHE_DIR, VK_IDX_NAME } from "@/lib/vkospiScanConfig";
import { B3_PRIOR_TESTS, B3_TRIALS, B3_RANK_DEPTH, B3_RSI_N, B3_FWD_DAYS, B3_CUM_TRIALS, B3_S1_P0, B3_S1_NB, B3_S2_P0, B3_S2_NB, B3_S3_P0, B3_S3_NB, B3_S4_P0, B3_S4_NB, B3_F_DENOMINATOR, B3_DS6_REC, B3_DS6_YEARLY, type B3P } from "@/lib/batch3Config";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, mulberry32, SNAP_END, f2, avg, median, type S, type Win } from "./researchHarness";
import { evaluate, summaryReport, type CandSpec, type Verdict, type Windows } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
type Ex = ReadonlySet<string> | undefined;
type Mkt = "KOSPI" | "KOSDAQ";
const sha = (b: Uint8Array | Buffer | string): string => createHash("sha256").update(b).digest("hex");
interface QDef {
  id: string; trial: number; P0: B3P; nbs: [string, B3P][]; reasons: string[];
  slots: (P: B3P) => number;
  title: (P: B3P) => string;
  /** 판단일 c 종가의 후보(우선순위 순). */
  signals: (c: number, P: B3P, ex: Ex) => S[];
  /** 게이트 F 무작위 진입의 후보 풀. */
  pool: (c: number, P: B3P, ex: Ex) => S[];
  /** 청산 판단(판단일 c 종가, i = 그날 종목 행). lag = 체결 지연(1 = 다음 거래일). */
  exit: (p: SimPos, c: number, i: number | undefined, P: B3P, lag: number) => string | null;
}

async function main(): Promise<void> {
  const MODE = (process.env.ALLOC_MODE ?? "").trim().toLowerCase();
  if (!["repro", "s1", "s2", "s3", "s4"].includes(MODE)) throw new Error("ALLOC_MODE=repro|s1|s2|s3|s4 필요");
  const REPRO = MODE === "repro";
  console.log(`연구 묶음 3(S1~S4, 시도 ${B3_TRIALS.s1}~${B3_TRIALS.s4}) ${REPRO ? "사전 점검(신호 독립 대조·체결 타이밍·구조 통계만, 성과 미계산)" : `시험 ${MODE.toUpperCase()} 1회`} 시작(읽기 전용): ${new Date().toISOString()}`);
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
  const W: Windows = { NW, FULL, ALL: [...NW, ["연속 전체 2011-01~2026-10", FULL]], noEx26: true, contamNote: "경고(오염): 이 구간 전체(2011~2026)는 DS6·DS4·LV1 등 선행 연구에서 이미 반복해 본 데이터다. 묶음 3의 가설은 묶음 1·2와 DS6·VKOSPI 계열 결과를 본 뒤 정한 것이라 순수 검증이 아니다." };
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
      const list = e.slice(0, B3_RANK_DEPTH).map((x) => x.s);
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

  // ---- VKOSPI 일별 종가(정리본 Actions 캐시 .vkospi-inputs): S3·사전 점검에서만 읽는다. 전 연도 파일 SHA 대조 ----
  const needVk = REPRO || MODE === "s3";
  const VKA = new Float64Array(nCal).fill(Number.NaN);
  const vkRaw = new Map<string, number>();
  if (needVk) {
    let vkMan: { idxName: string; files: { name: string; bytes: number; sha256: string; rows: number }[] };
    try { vkMan = JSON.parse(await fs.readFile(path.join(VK_CACHE_DIR, "manifest.json"), "utf8")); } catch { throw new Error("VKOSPI 정리본 캐시(.vkospi-inputs)가 없다 — 재수집하지 않고 중단하고 보고한다"); }
    for (const f of vkMan.files) {
      const buf = await fs.readFile(path.join(VK_CACHE_DIR, f.name));
      if (buf.byteLength !== f.bytes || sha(buf) !== f.sha256) throw new Error(`VKOSPI 정리본 ${f.name} 매니페스트 불일치 — 중단하고 보고한다`);
      const rows = (await parquetReadObjects({ file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer })) as Record<string, unknown>[];
      for (const r of rows) { const d = String(r.trade_date), k = h.calIdx.get(d); vkRaw.set(d, Number(r.close)); if (k !== undefined) VKA[k] = Number(r.close); }
    }
    const ks = [...vkRaw.keys()].sort();
    console.log(`VKOSPI 정리본 매니페스트 대조 통과: 파일 ${vkMan.files.length}개 SHA-256 일치, 지수명 "${vkMan.idxName}"${vkMan.idxName === VK_IDX_NAME ? "" : " (사전등록과 다름)"}, 읽은 행 ${vkRaw.size}개 ${ks[0]}~${ks[ks.length - 1]}, 달력에 값이 있는 날 ${VKA.filter((x) => Number.isFinite(x)).length}일`);
  }

  // ---- 지표(정렬 수정 종가 기준, 판단일 c까지의 정보만): 볼린저·RSI·ADX·수축일 ----
  const bbCache = new Map<string, { mid: Float64Array; sd: Float64Array }>();
  /** 볼린저 중심선·모집단 표준편차(분모 n, 당일 포함). 창 안에 결측이 있으면 NaN. 직접 합산(앞에서부터)이라 브루트포스와 같은 산술이다. */
  const bbOf = (code: string, n: number): { mid: Float64Array; sd: Float64Array } => {
    const key = `${code}|${n}`;
    let v = bbCache.get(key);
    if (!v) {
      const a = alignedOf(code), mid = new Float64Array(nCal).fill(Number.NaN), sd = new Float64Array(nCal).fill(Number.NaN);
      for (let c = n - 1; c < nCal; c++) {
        let ok = true, sum = 0;
        for (let k = c - n + 1; k <= c; k++) { if (!(a[k] > 0)) { ok = false; break; } sum += a[k]; }
        if (!ok) continue;
        const m = sum / n;
        let ss = 0;
        for (let k = c - n + 1; k <= c; k++) { const d = a[k] - m; ss += d * d; }
        mid[c] = m; sd[c] = Math.sqrt(ss / n);
      }
      v = { mid, sd };
      bbCache.set(key, v);
    }
    return v;
  };
  const rsiVal = (ag: number, al: number): number => (al === 0 ? (ag === 0 ? 50 : 100) : 100 - 100 / (1 + ag / al));
  const rsiCache = new Map<string, Float64Array>();
  /** Wilder RSI(14): 첫 유효 종가 f 다음날부터의 변화 처음 14개 단순평균이 첫 평균, 이후 (직전×13+오늘)/14. k = f+14에서 첫 값. */
  const rsiOf = (code: string): Float64Array => {
    let out = rsiCache.get(code);
    if (!out) {
      const a = alignedOf(code), N = B3_RSI_N;
      out = new Float64Array(nCal).fill(Number.NaN);
      let f = -1;
      for (let k = 0; k < nCal; k++) if (a[k] > 0) { f = k; break; }
      if (f >= 0 && f + N < nCal) {
        let sg = 0, sl = 0;
        for (let k = f + 1; k <= f + N; k++) { const d = a[k] - a[k - 1]; sg += d > 0 ? d : 0; sl += d < 0 ? -d : 0; }
        let ag = sg / N, al = sl / N;
        out[f + N] = rsiVal(ag, al);
        for (let k = f + N + 1; k < nCal; k++) { const d = a[k] - a[k - 1]; ag = (ag * (N - 1) + (d > 0 ? d : 0)) / N; al = (al * (N - 1) + (d < 0 ? -d : 0)) / N; out[k] = rsiVal(ag, al); }
      }
      rsiCache.set(code, out);
    }
    return out;
  };
  interface Adx { adx: Float64Array; pdi: Float64Array; mdi: Float64Array }
  const adxCache = new Map<string, Adx>();
  /** Wilder ADX(n), 종목 자체 행(행 번호 기준). 처음 n개(행 1~n)의 TR·+DM·−DM 합이 첫 평활값, 이후 평활값 = 직전 − 직전/n + 오늘. 첫 ADX는 행 2n−1(행 n~2n−1의 DX 평균). */
  const adxOf = (s: S, n: number): Adx => {
    const key = `${s.code}|${n}`;
    let v = adxCache.get(key);
    if (!v) {
      const m = s.dates.length, adx = new Float64Array(m).fill(Number.NaN), pdi = new Float64Array(m).fill(Number.NaN), mdi = new Float64Array(m).fill(Number.NaN);
      const H = s.high, L = s.low, C = s.close;
      let sT = 0, sP = 0, sM = 0, dxSum = 0, ad = Number.NaN;
      for (let i = 1; i < m; i++) {
        const tr = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
        const up = H[i] - H[i - 1], dn = L[i - 1] - L[i];
        const pm = up > dn && up > 0 ? up : 0, mm = dn > up && dn > 0 ? dn : 0;
        if (i <= n) { sT += tr; sP += pm; sM += mm; } else { sT = sT - sT / n + tr; sP = sP - sP / n + pm; sM = sM - sM / n + mm; }
        if (i < n) continue;
        const pi = sT > 0 ? (100 * sP) / sT : 0, mi = sT > 0 ? (100 * sM) / sT : 0;
        pdi[i] = pi; mdi[i] = mi;
        const dx = pi + mi > 0 ? (100 * Math.abs(pi - mi)) / (pi + mi) : 0;
        if (i < 2 * n - 1) dxSum += dx;
        else if (i === 2 * n - 1) { dxSum += dx; ad = dxSum / n; adx[i] = ad; } else { ad = (ad * (n - 1) + dx) / n; adx[i] = ad; }
      }
      v = { adx, pdi, mdi };
      adxCache.set(key, v);
    }
    return v;
  };
  const sqCache = new Map<string, Uint8Array>();
  /** S2 수축일 플래그: 날 k의 밴드폭 w[k] = 2K·σ ÷ 중심선이 k까지 최근 win일(k 포함) 밴드폭 중 하위 pct(순위 = 1 + 엄격히 작은 날 수 ≤ round(pct·win))이면 1. 창에 밴드폭이 모두 있어야 한다. */
  const squeezeOf = (code: string, P: B3P): Uint8Array => {
    const key = `${code}|${P.bbN}|${P.bbK}|${P.win}|${P.pct}`;
    let f = sqCache.get(key);
    if (!f) {
      const bb = bbOf(code, P.bbN), w = new Float64Array(nCal);
      for (let k = 0; k < nCal; k++) w[k] = (2 * P.bbK * bb.sd[k]) / bb.mid[k];
      f = new Uint8Array(nCal);
      const lim = Math.round(P.pct * P.win);
      for (let k = P.win - 1; k < nCal; k++) {
        let ok = true, less = 0;
        for (let j = k - P.win + 1; j <= k; j++) { if (!Number.isFinite(w[j])) { ok = false; break; } if (w[j] < w[k]) less++; }
        if (ok && Number.isFinite(w[k]) && 1 + less <= lim) f[k] = 1;
      }
      sqCache.set(key, f);
    }
    return f;
  };
  const vkPrev = (c: number): number => (c >= 1 ? VKA[c - 1] : Number.NaN);

  // ---- S1·S3: 볼린저 하단 복귀 + RSI (+ 전일 VKOSPI) ----
  /** 볼린저 복귀 신호의 RSI(신호가 아니면 NaN). ① a[c−1] < 하단(c−1) ② a[c] > 하단(c) ③ RSI ≤ rsiMax ④ a[c] > SMA_trend. */
  const bbRsi = (s: S, c: number, P: B3P): number => {
    if (c < 1) return Number.NaN;
    const a = alignedOf(s.code), bb = bbOf(s.code, P.bbN);
    const lo1 = bb.mid[c - 1] - P.bbK * bb.sd[c - 1], lo0 = bb.mid[c] - P.bbK * bb.sd[c];
    if (!(a[c - 1] < lo1) || !(a[c] > lo0)) return Number.NaN;
    const r = rsiOf(s.code)[c];
    if (!(r <= P.rsiMax)) return Number.NaN;
    if (!(a[c] > smaAt(s, c, P.trend))) return Number.NaN;
    return r;
  };
  const sigBb = (c: number, P: B3P, ex: Ex, useVk: boolean): S[] => {
    if (useVk && !(vkPrev(c) >= P.vk)) return [];
    const out: { s: S; r: number }[] = [];
    for (const s of rankAt(c).list) {
      if (ex?.has(s.code) || rowLive(s, c) === undefined) continue;
      const r = bbRsi(s, c, P);
      if (Number.isFinite(r)) out.push({ s, r });
    }
    out.sort((x, y) => x.r - y.r || (x.s.code < y.s.code ? -1 : 1));
    return out.map((x) => x.s);
  };
  const exitBb = (p: SimPos, c: number, i: number | undefined, P: B3P, lag: number): string | null => {
    if (i !== undefined && p.s.close[i] >= bbOf(p.code, P.bbN).mid[c]) return "중심선 도달";
    return holdDone(p, c, P.hold, lag) ? "보유 만료" : null;
  };
  const pool = (c: number, _P: B3P, ex: Ex): S[] => rankAt(c).list.filter((s) => !ex?.has(s.code) && rowLive(s, c) !== undefined);
  const S1: QDef = {
    id: "S1", trial: B3_TRIALS.s1, P0: B3_S1_P0, nbs: B3_S1_NB, reasons: ["중심선 도달", "보유 만료"], slots: (P) => P.slots,
    title: (P) => `S1: K200P 중 어제 종가가 볼린저(${P.bbN}일, ${P.bbK}σ) 하단 아래였다가 당일 종가가 하단 위로 복귀, RSI(14) ≤ ${P.rsiMax}, 종가 > ${P.trend}일선인 종목을 다음 거래일 종가에 매수, 종가가 중심선(${P.bbN}일선)에 도달하거나 ${P.hold}거래일 경과 시 청산, 슬롯 ${P.slots}개`,
    signals: (c, P, ex) => sigBb(c, P, ex, false), pool, exit: exitBb,
  };
  const S3: QDef = {
    id: "S3", trial: B3_TRIALS.s3, P0: B3_S3_P0, nbs: B3_S3_NB, reasons: ["중심선 도달", "보유 만료"], slots: (P) => P.slots,
    title: (P) => `S3: S1 진입 조건 + 전일 VKOSPI 종가 ≥ ${P.vk} (볼린저 ${P.bbN}일 ${P.bbK}σ 하단 복귀, RSI(14) ≤ ${P.rsiMax}, 종가 > ${P.trend}일선), 청산 중심선 도달 또는 ${P.hold}거래일, 슬롯 ${P.slots}개`,
    signals: (c, P, ex) => sigBb(c, P, ex, true), pool, exit: exitBb,
  };

  // ---- S2: 볼린저 수축 후 상단 돌파 ----
  const S2: QDef = {
    id: "S2", trial: B3_TRIALS.s2, P0: B3_S2_P0, nbs: B3_S2_NB, reasons: ["이평 이탈"], slots: (P) => P.slots,
    title: (P) => `S2: K200P 중 직전 ${P.back}거래일 안에 밴드폭(${P.bbN}일, ${P.bbK}σ)이 최근 ${P.win}거래일 중 하위 ${f2(P.pct * 100)}%였던 날이 있고, 당일 종가가 상단 위로 돌파, 종가 > ${P.ma1}일선 > ${P.ma2}일선인 종목을 다음 거래일 종가에 매수, 종가가 ${P.exitMa}일선 아래이면 청산, 슬롯 ${P.slots}개`,
    signals: (c, P, ex) => {
      const out: { s: S; tv: number }[] = [];
      for (const s of rankAt(c).list) {
        if (ex?.has(s.code)) continue;
        const i = rowLive(s, c);
        if (i === undefined || c < 1) continue;
        const a = alignedOf(s.code), bb = bbOf(s.code, P.bbN);
        if (!(a[c] > bb.mid[c] + P.bbK * bb.sd[c])) continue;
        const m1 = smaAt(s, c, P.ma1), m2 = smaAt(s, c, P.ma2);
        if (!(a[c] > m1) || !(a[c] > m2) || !(m1 > m2)) continue;
        const sq = squeezeOf(s.code, P);
        let any = false;
        for (let k = Math.max(0, c - P.back); k <= c - 1; k++) if (sq[k]) { any = true; break; }
        if (!any) continue;
        out.push({ s, tv: tvOf(s, i) });
      }
      out.sort((x, y) => y.tv - x.tv || (x.s.code < y.s.code ? -1 : 1));
      return out.map((x) => x.s);
    },
    pool,
    exit: (p, c, i, P) => (i !== undefined && p.s.close[i] < smaAt(byCode.get(p.code) as S, c, P.exitMa) ? "이평 이탈" : null),
  };

  // ---- S4: ADX 추세 필터 + 돌파 ----
  const S4: QDef = {
    id: "S4", trial: B3_TRIALS.s4, P0: B3_S4_P0, nbs: B3_S4_NB, reasons: ["이평 이탈", "ADX 약화"], slots: (P) => P.slots,
    title: (P) => `S4: K200P 중 ADX(${P.adxN}) ≥ ${P.adxMin}, +DI > −DI, 종가가 직전 ${P.hi}거래일 종가 최댓값 돌파, 종가 > ${P.ma1}일선 > ${P.ma2}일선인 종목을 다음 거래일 종가에 매수, 종가가 ${P.exitMa}일선 아래이거나 ADX < ${P.adxExit}이면 청산, 슬롯 ${P.slots}개`,
    signals: (c, P, ex) => {
      const out: { s: S; adx: number }[] = [];
      for (const s of rankAt(c).list) {
        if (ex?.has(s.code)) continue;
        const i = rowLive(s, c);
        if (i === undefined || c < P.hi) continue;
        const x = adxOf(s, P.adxN);
        if (!(x.adx[i] >= P.adxMin) || !(x.pdi[i] > x.mdi[i])) continue;
        const a = alignedOf(s.code);
        let mx = Number.NEGATIVE_INFINITY, ok = true;
        for (let k = c - P.hi; k <= c - 1; k++) { if (!(a[k] > 0)) { ok = false; break; } if (a[k] > mx) mx = a[k]; }
        if (!ok || !(a[c] > mx)) continue;
        const m1 = smaAt(s, c, P.ma1), m2 = smaAt(s, c, P.ma2);
        if (!(a[c] > m1) || !(a[c] > m2) || !(m1 > m2)) continue;
        out.push({ s, adx: x.adx[i] });
      }
      out.sort((x, y) => y.adx - x.adx || (x.s.code < y.s.code ? -1 : 1));
      return out.map((x) => x.s);
    },
    pool,
    exit: (p, c, i, P) => {
      if (i === undefined) return null;
      if (p.s.close[i] < smaAt(byCode.get(p.code) as S, c, P.exitMa)) return "이평 이탈";
      return adxOf(byCode.get(p.code) as S, P.adxN).adx[i] < P.adxExit ? "ADX 약화" : null;
    },
  };
  const QS: Record<string, QDef> = { s1: S1, s2: S2, s3: S3, s4: S4 };

  // ---- 실행 ----
  const hooksFor = (q: QDef, P: B3P, lag: number, ex?: Ex): SimHooks<SimCand> => ({
    candsOf: (c) => q.signals(c, P, ex).map((s) => ({ s, code: s.code })),
    exitReason: (p, c, i) => q.exit(p, c, i, P, lag),
  });
  const cfgOf = (q: QDef, P: B3P) => ({ slip: L_SLIPPAGE, maxPos: q.slots(P), capFrac: 1 / q.slots(P), cooldown: 0 });
  const runQ = (q: QDef, P: B3P, o: { lag: number; replace?: Set<string>; detail?: boolean }, ex?: Ex): SimRun => simSlots(env(cPE), cfgOf(q, P), hooksFor(q, P, o.lag, ex), { lag: o.lag, replace: o.replace, detail: o.detail });
  const randomRun = (q: QDef, P: B3P, rng: () => number, ob: Map<number, number>): SimRun => {
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
  // 1. 사전 점검 (성과 아님): 신호 독립 대조(과거 이력만 쓰는 브루트포스), 체결 타이밍, VKOSPI 적용 재계산, 구조 통계
  // =====================================================================================================================
  /** 브루트포스: 캐시·prefix 합·모듈 지표 배열 없이 판단일 c까지(k ≤ c)의 행만 직접 읽는다. RSI·ADX는 모듈과 다른 대수 형태(합 평활 ↔ 평균 평활)로 따로 만든다. */
  const bruteRank = (c: number): string[] => {
    const d = CAL[c], m = membAt(d), e: { code: string; mc: number }[] = [];
    if (m) for (const s of h.stocks) { const i = s.idx.get(d); if (i !== undefined && !excluded.has(s.code) && m.get(s.code) === "KOSPI") e.push({ code: s.code, mc: s.mcapRow[i] }); }
    e.sort((a, b) => b.mc - a.mc || (a.code < b.code ? -1 : 1));
    return e.slice(0, B3_RANK_DEPTH).map((x) => x.code);
  };
  const bseries = new Map<string, Float64Array>();
  /** 달력 정렬 종가: 행이 있는 날 그 종가, 없으면 직전 행 종가, 상장 전 NaN. */
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
  const bRsiMap = new Map<string, Float64Array>();
  /** 브루트 RSI: Wilder 합 평활(SG_t = SG − SG/14 + g). 첫 합 = 처음 14개 변화의 합. */
  const bRsi = (code: string): Float64Array => {
    let o = bRsiMap.get(code);
    if (!o) {
      const a = bseriesOf(code);
      o = new Float64Array(nCal).fill(Number.NaN);
      let f = 0;
      while (f < nCal && !(a[f] > 0)) f++;
      if (f + 14 < nCal) {
        let g = 0, l = 0;
        for (let k = f + 1; k <= f + 14; k++) { const d = a[k] - a[k - 1]; if (d > 0) g += d; else l += -d; }
        const val = (): number => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l));
        o[f + 14] = val();
        for (let k = f + 15; k < nCal; k++) { const d = a[k] - a[k - 1]; g = g - g / 14 + (d > 0 ? d : 0); l = l - l / 14 + (d < 0 ? -d : 0); o[k] = val(); }
      }
      bRsiMap.set(code, o);
    }
    return o;
  };
  const bAdxMap = new Map<string, { adx: Float64Array; pdi: Float64Array; mdi: Float64Array }>();
  /** 브루트 ADX: Wilder 평균 평활(평균 = (직전×13 + 오늘)/14, 첫 평균 = 처음 14개 평균). */
  const bAdx = (code: string): { adx: Float64Array; pdi: Float64Array; mdi: Float64Array } => {
    let o = bAdxMap.get(code);
    if (!o) {
      const s = byCode.get(code) as S, m = s.dates.length;
      const adx = new Float64Array(m).fill(Number.NaN), pdi = new Float64Array(m).fill(Number.NaN), mdi = new Float64Array(m).fill(Number.NaN);
      const trs: number[] = [0], pms: number[] = [0], mms: number[] = [0];
      for (let i = 1; i < m; i++) {
        trs.push(Math.max(s.high[i] - s.low[i], Math.abs(s.high[i] - s.close[i - 1]), Math.abs(s.low[i] - s.close[i - 1])));
        const up = s.high[i] - s.high[i - 1], dn = s.low[i - 1] - s.low[i];
        pms.push(up > dn && up > 0 ? up : 0); mms.push(dn > up && dn > 0 ? dn : 0);
      }
      let aT = 0, aP = 0, aM = 0;
      const dxs: number[] = [];
      let aa = Number.NaN;
      for (let i = 1; i < m; i++) {
        if (i <= 14) { aT += trs[i] / 14; aP += pms[i] / 14; aM += mms[i] / 14; } else { aT = (aT * 13 + trs[i]) / 14; aP = (aP * 13 + pms[i]) / 14; aM = (aM * 13 + mms[i]) / 14; }
        if (i < 14) continue;
        const pi = aT > 0 ? (100 * aP) / aT : 0, mi = aT > 0 ? (100 * aM) / aT : 0;
        pdi[i] = pi; mdi[i] = mi;
        const dx = pi + mi > 0 ? (100 * Math.abs(pi - mi)) / (pi + mi) : 0;
        dxs.push(dx);
        if (i === 27) { aa = dxs.reduce((x, y) => x + y, 0) / 14; adx[i] = aa; } else if (i > 27) { aa = (aa * 13 + dx) / 14; adx[i] = aa; }
      }
      o = { adx, pdi, mdi };
      bAdxMap.set(code, o);
    }
    return o;
  };
  const bSma = (bc: Float64Array, c: number, n: number): number => { if (c - n + 1 < 0) return Number.NaN; let s = 0; for (let k = c - n + 1; k <= c; k++) { if (!(bc[k] > 0)) return Number.NaN; s += bc[k]; } return s / n; };
  const bBand = (bc: Float64Array, c: number, n: number, K: number): { mid: number; lo: number; up: number; w: number } => {
    const mid = bSma(bc, c, n);
    if (!Number.isFinite(mid)) return { mid: Number.NaN, lo: Number.NaN, up: Number.NaN, w: Number.NaN };
    let ss = 0;
    for (let k = c - n + 1; k <= c; k++) ss += (bc[k] - mid) * (bc[k] - mid);
    const sd = Math.sqrt(ss / n);
    return { mid, lo: mid - K * sd, up: mid + K * sd, w: (2 * K * sd) / mid };
  };
  const bSqueeze = (bc: Float64Array, k: number, P: B3P): boolean => {
    if (k - P.win + 1 < 0) return false;
    const wk = bBand(bc, k, P.bbN, P.bbK).w;
    if (!Number.isFinite(wk)) return false;
    let less = 0;
    for (let j = k - P.win + 1; j <= k; j++) { const wj = bBand(bc, j, P.bbN, P.bbK).w; if (!Number.isFinite(wj)) return false; if (wj < wk) less++; }
    return 1 + less <= Math.round(P.pct * P.win);
  };
  const brSignals = (id: string, c: number, P: B3P): string[] => {
    const rk = bruteRank(c);
    if (id === "S3") { const vd = c >= 1 ? vkRaw.get(CAL[c - 1]) : undefined; if (!(vd !== undefined && vd >= P.vk)) return []; }
    const out: { code: string; key: number }[] = [];
    for (const code of rk) {
      const s = byCode.get(code) as S, i = s.idx.get(CAL[c]);
      if (i === undefined || s.vol[i] === 0 || c < 1) continue;
      const bc = bseriesOf(code);
      if (id === "S1" || id === "S3") {
        const b1 = bBand(bc, c - 1, P.bbN, P.bbK), b0 = bBand(bc, c, P.bbN, P.bbK);
        if (!(bc[c - 1] < b1.lo) || !(bc[c] > b0.lo)) continue;
        const r = bRsi(code)[c];
        if (!(r <= P.rsiMax)) continue;
        if (!(bc[c] > bSma(bc, c, P.trend))) continue;
        out.push({ code, key: r });
      } else if (id === "S2") {
        const b0 = bBand(bc, c, P.bbN, P.bbK);
        if (!(bc[c] > b0.up)) continue;
        const m1 = bSma(bc, c, P.ma1), m2 = bSma(bc, c, P.ma2);
        if (!(bc[c] > m1) || !(bc[c] > m2) || !(m1 > m2)) continue;
        let any = false;
        for (let k = Math.max(0, c - P.back); k <= c - 1 && !any; k++) if (bSqueeze(bc, k, P)) any = true;
        if (!any) continue;
        out.push({ code, key: -(s.raw[i] * s.vol[i]) });
      } else {
        if (c < P.hi) continue;
        const x = bAdx(code);
        if (!(x.adx[i] >= P.adxMin) || !(x.pdi[i] > x.mdi[i])) continue;
        let mx = Number.NEGATIVE_INFINITY, ok = true;
        for (let k = c - P.hi; k <= c - 1; k++) { if (!(bc[k] > 0)) { ok = false; break; } if (bc[k] > mx) mx = bc[k]; }
        if (!ok || !(bc[c] > mx)) continue;
        const m1 = bSma(bc, c, P.ma1), m2 = bSma(bc, c, P.ma2);
        if (!(bc[c] > m1) || !(bc[c] > m2) || !(m1 > m2)) continue;
        out.push({ code, key: -x.adx[i] });
      }
    }
    return out.sort((a, b) => a.key - b.key || (a.code < b.code ? -1 : 1)).map((x) => x.code);
  };
  const modSignals = (q: QDef, c: number, P: B3P): string[] => q.signals(c, P, undefined).map((s) => s.code);

  if (REPRO) {
    console.log(`\n=== 1. 신호 독립 대조 (판단일마다 모듈 신호 = 브루트포스(과거 이력만, RSI·ADX는 다른 평활 형태) 신호, 순서까지; ${CAL[cPE]}~${CAL[nCal - 2]}) ===`);
    for (const q of [S1, S2, S3, S4]) {
      for (const [nm, P] of [["기본", q.P0] as [string, B3P], ...q.nbs.map(([l, ch]) => [l, { ...q.P0, ...ch }] as [string, B3P])]) {
        let nBad = 0, nSig = 0, nDays = 0, firstBad = "";
        for (let c = cPE; c < nCal - 1; c++) {
          const a = modSignals(q, c, P), b = brSignals(q.id, c, P);
          if (a.join() !== b.join()) { nBad++; if (!firstBad) firstBad = `${CAL[c]} 모듈 ${a.slice(0, 5).join(",")} / 브루트 ${b.slice(0, 5).join(",")}`; }
          if (a.length) { nDays++; nSig += a.length; }
        }
        console.log(`  ${q.id} ${nm}: 신호가 있는 날 ${nDays}일, 신호 합 ${nSig}개 | 브루트포스와 불일치 ${nBad}일 ${nBad === 0 ? "통과" : `불일치 (${firstBad})`}`);
        if (nBad > 0) throw new Error(`${q.id} 신호 독립 대조 불일치 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)`);
      }
    }
    console.log(`\n=== 1b. 체결·보유·청산 타이밍 점검 (진입 = 신호일 + lag, 청산 규칙 성립, 기본 설정 lag 1·2; 성과 미출력) ===`);
    const halted = (s: S, k: number): boolean => { const j = s.idx.get(CAL[k]); return j === undefined || s.vol[j] === 0; };
    for (const q of [S1, S2, S3, S4]) {
      for (const lag of [1, 2]) {
        const r = runQ(q, q.P0, { lag, detail: true }), P = q.P0;
        let badEntry = 0, badHold = 0, badRule = 0, nDeferred = 0;
        const cnt: Record<string, number> = {};
        for (const t of r.trades) {
          const s = byCode.get(t.code) as S, bc = bseriesOf(t.code);
          cnt[t.reason] = (cnt[t.reason] ?? 0) + 1;
          if (!brSignals(q.id, t.entryC - lag, P).includes(t.code)) badEntry++;
          if (t.reason === "보유 만료") {
            const due = t.entryC + P.hold;
            if (t.exitC < due) badHold++;
            else if (t.exitC > due) { nDeferred++; for (let k = due; k < t.exitC; k++) if (!halted(s, k)) { badHold++; break; } }
          }
          if (t.reason === "중심선 도달" || t.reason === "이평 이탈" || t.reason === "ADX 약화") {
            let ok = false;
            for (let k = t.entryC; k <= t.exitC - lag && !ok; k++) {
              if (halted(s, k)) continue;
              const j = s.idx.get(CAL[k]) as number;
              if (t.reason === "중심선 도달") ok = s.close[j] >= bBand(bc, k, P.bbN, P.bbK).mid;
              else if (t.reason === "이평 이탈") ok = s.close[j] < bSma(bc, k, q.id === "S2" ? P.exitMa : P.exitMa);
              else ok = bAdx(t.code).adx[j] < P.adxExit;
            }
            if (!ok) badRule++;
          }
        }
        console.log(`  ${q.id} lag ${lag}: 진입 ${r.entryCs.length}건, 청산 ${r.trades.length}건(${Object.entries(cnt).map(([k, v]) => `${k} ${v}`).join(", ")}) | 신호일+${lag}이 아닌 진입 ${badEntry}건 | 보유 만료가 규칙일보다 이른 날 또는 정지일이 아닌데 늦은 청산 ${badHold}건 (거래정지로 순연된 정상 청산 ${nDeferred}건) | 규칙 조건이 한 번도 성립하지 않은 규칙 청산 ${badRule}건 ${badEntry === 0 && badHold === 0 && badRule === 0 ? "통과" : "불일치"}`);
        if (badEntry > 0 || badHold > 0 || badRule > 0) throw new Error(`${q.id} 체결 타이밍 점검 실패 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)`);
      }
    }
    console.log(`\n=== 1c. S3 VKOSPI 적용 재계산 (판단일 c의 전일 = CAL[c−1] 날짜의 정리본 값으로 다시 판정; 값 없는 날은 신호 없음) ===`);
    for (const thr of [B3_S3_P0.vk, 22, 28]) {
      let nBad = 0, nOn = 0, nMiss = 0;
      for (let c = cPE; c < nCal - 1; c++) {
        const vd = vkRaw.get(CAL[c - 1]), a = vkPrev(c) >= thr, b = vd !== undefined && vd >= thr;
        if (a !== b) nBad++;
        if (a) nOn++;
        if (vd === undefined) nMiss++;
      }
      console.log(`  전일 VKOSPI ≥ ${thr}: 판단일 ${nOn}일 (평가 구간 ${nCal - 1 - cPE}일 중), 정리본에 값이 없는 판단일 ${nMiss}일, 재계산 불일치 ${nBad}일 ${nBad === 0 ? "통과" : "불일치"}`);
      if (nBad > 0) throw new Error("VKOSPI 적용일 재계산 불일치 — 중단하고 보고한다(구현 오류만 수정, 사유 기록)");
    }
    console.log(`\n=== 1d. 구조 통계 (기본 설정, 성과 아님) ===`);
    for (const q of [S1, S2, S3, S4]) {
      let nd = 0, ns = 0, mx = 0;
      for (let c = cPE; c < nCal - 1; c++) { const n = q.signals(c, q.P0, undefined).length; if (n) nd++; ns += n; mx = Math.max(mx, n); }
      console.log(`  ${q.id} 신호가 있는 날 ${nd}일 / ${nCal - 1 - cPE}일, 신호 합 ${ns}, 하루 최대 ${mx}개`);
    }
    const rs = rsiOf("005930"), bsr = bRsi("005930");
    let mxd = 0;
    for (let k = 0; k < nCal; k++) if (Number.isFinite(rs[k]) && Number.isFinite(bsr[k])) mxd = Math.max(mxd, Math.abs(rs[k] - bsr[k]));
    console.log(`  RSI 평균 평활 대 합 평활 최대 차이(삼성전자, 참고) ${mxd.toExponential(2)}`);
    console.log(`\n사전 점검 종료: 신호 독립 대조(S1~S4 기본·이웃 설정 전부 모든 판단일), 체결·청산 타이밍(lag 1·2), VKOSPI 적용 재계산, 구조 통계 통과. 시험 성과는 계산·출력하지 않았다 | ${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    void B3_PRIOR_TESTS;
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
  const runAny = (P: B3P, o: { lag: number; replace?: Set<string>; detail?: boolean }, ex?: Ex): SimRun => runQ(q, P, o, ex);
  const spec: CandSpec = {
    id, trial, title, defense: false, capFrac: 1 / nSlots, fDenominator: B3_F_DENOMINATOR, ref: { id: "069500", run: bhAsRun },
    hRule: (full, rb) => { const a = hVs(full, rb); return { ok: a.ok, note: `[사전등록: 069500만 판정] 069500 ${f2(rb.cagr)} / ${f2(rb.mdd)} → ${a.ok ? "O" : "X"} (${a.text})` }; },
    run: (o) => runAny(P0, o),
    neighbors: nbs.map(([lb, ch]) => ({ label: lb, run: () => runAny({ ...P0, ...ch }, { lag: 1 }) })),
    random: (rng, ob) => randomRun(q, P0, rng, ob),
    reasons: q.reasons, label,
    extra: (run) => {
      console.log(`${id} 게이트 C 해석(사전등록): 진입·청산 체결을 모두 +1거래일(lag 2). CAGR 하락 ≤ 1%p ∧ MDD 악화 ≤ 2%p.`);
      console.log(`${id} 게이트 D 해석(사전등록): 이웃 ${nbs.length}개(${nbs.map(([l]) => l).join(", ")}). 연속 전체 CAGR ≥ 069500 CAGR이어야 통과, 하나라도 미만이면 탈락.`);
      console.log(`${id} 게이트 E 해석(사전등록): 평가 구간 닫힌 거래 중 손익 상위 3개를 069500 수익률로 대체한 연속 전체 CAGR ≥ 069500.`);
      console.log(`${id} 게이트 F 해석(사전등록): 실제 신호일·주문 수와 같게 후보 풀(그날 행이 있고 거래량 > 0인 K200P 종목)에서 무작위로 고른 진입, 같은 청산 규칙·비용, 시드 ${KSS_R3_SEED}, ${KSS_R3_DRAWS}회, 백분위 ≥ 95(참고선 ${f2((1 - 0.05 / B3_F_DENOMINATOR) * 100)}).`);
      console.log(`${id} 게이트 G: 진입 건수(종목별 진입)는 evaluate 결과 참조. H 해석(사전등록): 069500만 판정(CAGR +${PEAD_H_CAGR_GAIN_PP}%p, 또는 MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p).`);
      const rec = B3_DS6_REC;
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
          const a = h.yearRet({ dates: CAL.slice(cPE + 1), ret: bRetAxis }, y), cc = h.yearRet(run, y), d6 = B3_DS6_YEARLY[String(y)];
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
        const actual = B3_FWD_DAYS.map((k) => { let sm = 0, n = 0; for (const t of ents) { const v = fwd(t.code, t.entryC, k); if (Number.isFinite(v)) { sm += v; n++; } } return { sm: n ? sm / n : Number.NaN, n }; });
        // 날마다 후보 풀(판단일 = 진입일 − 1)과 풀 종목의 전방 수익을 한 번만 만든다.
        const days = [...byDay.keys()].sort((a, b) => a - b);
        const poolF = new Map<number, { f: Float64Array[]; len: number }>();
        for (const c of days) { const pl = q.pool(c - 1, P0, undefined); poolF.set(c, { len: pl.length, f: B3_FWD_DAYS.map((k) => Float64Array.from(pl.map((s) => fwd(s.code, c, k)))) }); }
        const rng = mulberry32(KSS_R3_SEED), draws = KSS_R3_DRAWS, rm: number[][] = B3_FWD_DAYS.map(() => []);
        for (let dI = 0; dI < draws; dI++) {
          const sums = B3_FWD_DAYS.map(() => ({ s: 0, n: 0 }));
          for (const c of days) {
            const pf = poolF.get(c) as { f: Float64Array[]; len: number }, need = Math.min((byDay.get(c) as string[]).length, pf.len), idx = Array.from({ length: pf.len }, (_, k) => k);
            for (let j = 0; j < need; j++) { const m = j + Math.floor(rng() * (pf.len - j)); [idx[j], idx[m]] = [idx[m], idx[j]]; const ii = idx[j]; B3_FWD_DAYS.forEach((_, kk) => { const v = pf.f[kk][ii]; if (Number.isFinite(v)) { sums[kk].s += v; sums[kk].n++; } }); }
          }
          sums.forEach((x, kk) => rm[kk].push(x.n ? x.s / x.n : Number.NaN));
        }
        console.log(`\n=== 진입 후 전방 수익 [판정 불사용] (닫힌 거래의 진입 체결일 종가 → +k거래일 종가, 비용 미차감; 무작위 = 같은 날·같은 수를 후보 풀에서 ${draws}회 무작위, 시드 ${KSS_R3_SEED}) ===\n| 보유 기간 | 진입 수(값 있음) | 실제 평균 % | 무작위 평균의 평균 % | 실제 − 무작위 %p | 백분위(무작위 평균이 실제보다 작은 비율 %) |\n|---|---|---|---|---|---|`);
        B3_FWD_DAYS.forEach((k, kk) => {
          const arr = rm[kk].filter((x) => Number.isFinite(x)), a = actual[kk].sm;
          const below = arr.filter((x) => x < a).length + arr.filter((x) => x === a).length / 2, mu = avg(arr);
          console.log(`| ${k}거래일 | ${actual[kk].n} | ${f2(a)} | ${f2(mu)} | ${sg(a - mu)} | ${f2((below / Math.max(arr.length, 1)) * 100)} |`);
        });
      }
    },
  };
  const verdicts: Verdict[] = [evaluate(h, W, spec)];
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: trial - 1, contamNote: W.contamNote });
  console.log(`사전 고지: 누적 ${B3_CUM_TRIALS}회 기준 우연 통과 기대 ${B3_CUM_TRIALS} × 0.05 = ${(B3_CUM_TRIALS * 0.05).toFixed(2)}건(근사). 통과 후보가 있어도 독립 확인 전에는 후보일 뿐이다. 2011~2026 구간은 반복해서 본 데이터라 오염돼 있다. 가설 4개의 정의는 첫 시험 전에 고정했고 결과를 보고 바꾸지 않았다. 묶음 3 시험 번호 ${B3_TRIALS.s1}~${B3_TRIALS.s4}, 이 실행 ${trial}.`);
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ") || "없음"} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | DART 호출 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${trial}`);
  void B3_PRIOR_TESTS; void mulberry32;
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

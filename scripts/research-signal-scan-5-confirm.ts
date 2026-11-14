/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 5-A 후보 확인 점검(시험 아님, 시험 번호 290 유지). 사전 등록: docs/research/signal-scan-5-confirm-prereg.md (수집 전 커밋).
 * 대상 3행(POOL 외국계 순매수 5일 합 월간 21일, POOL 20일 합 주간 5일, MID 20일 합 주간 5일)만 확인 구간(SCAN5_ONLY=confirm, 2017-01-01~2021-12-31) 또는 보류 구간(SCAN5_ONLY=holdout:행 번호 목록, 2022-01-01~2026-10-26)에서 같은 정의로 계산한다.
 * 재현 기준(사용자 지정): 같은 부호(음) ∧ Newey-West |t| ≥ 2.0 ∧ 신호 방향(음)으로 계산한 비용 차감 순차이 > 0. 보류 구간은 확인에서 재현된 행만(holdout:행 번호 목록) 열고 부호·순차이를 참고용으로 보고한다.
 * 입력: 학습 구간 정리본(.scan5-fm-inputs, 20일 창 연속성용)·확인 구간 정리본(.scan5-fmc-inputs)·(보류) .scan5-fmh-inputs와 외국인 투자자 순매수 부분집합(.research-flow), Storage 읽기 0.
 */
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { parquetReadObjects } from "hyparquet";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";
import { PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { decodeTable } from "@/lib/nBookStore";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { SCAN_HORIZONS, SCAN_SPACING_MONTHLY_DAYS, SCAN_SPACING_WEEKLY_DAYS, SCAN_CAP_EOK, SCAN_POOL_SIZE, SCAN_MIN_CROSS_SECTION, SCAN_MOM_LONG_DAYS, SCAN_MOM_SKIP_DAYS, SCAN_H52_DAYS, SCAN_H52_MIN_ROWS, SCAN_VOL_DAYS, SCAN_VOL_MIN_RETURNS } from "@/lib/signalScanConfig";
import {
  S5_CACHE_DIR_FM, S5_FMC_FROM, S5_FMC_TO, S5_FMH_FROM, S5_FMH_TO, S5_CACHE_DIR_FMC, S5_CACHE_DIR_FMH, S5_CONFIRM_MIN_ABS_T, S5_CONFIRM_ROWS, S5_MID_TO, S5_EOK_TO_WON,
  S5_FM_WINDOWS, S5_FM_MIN_VALID, S5_FI_KAPPAS, S5_FI_RATIO_MIN, S5_FI_RATIO_MAX, S5_ID_TOP_N, S5_ID_MIN_CORR, S5_NTBY_IDENTITY_MAX_RATIO, S5_CLOSE_TOL, S5_CLOSE_MIN_SHARE,
  S5_MAX_ALL_ZERO_STOCK_RATIO, S5_MAX_MISSING_DAY_RATIO, S5_LOAN_LAG_DAYS, S5_LOAN_CARRY_DAYS, S5_LOAN_CHG_DAYS, S5_NONOVERLAP_MIN_SAMPLES, S5_FLOW_SUBSET_DIR, S5_FLOW_SUBSET_FILE, S5_FLOW_SUBSET_SHA256,
} from "@/lib/scan5Config";
import { loadHarness, verifySnapshotManifest, SNAP_END, dbRead, type S as HS } from "./researchHarness";

const T0 = Date.now();
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "-");
const MS_DAY = 86_400_000;
const rd = { bytes: 0, rows: 0, dropped: 0 };
const SCAN_MODE = "a";
const ONLY = (process.env.SCAN5_ONLY ?? "").trim().toLowerCase(), PERIOD = ONLY.split(":")[0], ROWS_ARG = ONLY.includes(":") ? ONLY.split(":")[1] : "";
if (!["confirm", "holdout"].includes(PERIOD)) throw new Error("SCAN5_ONLY=confirm 또는 holdout:<행 번호 목록> 필요");
const SCAN_START = PERIOD === "confirm" ? S5_FMC_FROM : S5_FMH_FROM, SCAN_END = PERIOD === "confirm" ? S5_FMC_TO : S5_FMH_TO;
const SIGNALS: string[] = SCAN_MODE === "a" ? ["FM5", "FM20", "FMD", "MOM", "REV", "VOL", "H52", "FI5"] : ["L1", "L2", "MOM", "REV", "VOL", "H52"];
const NT = SCAN_MODE === "a" ? 3 : 2, NS = SIGNALS.length; // 검정 행은 앞 NT개
const SIG_LABEL: Record<string, string> = { FM5: "외국계 창구 순매수 5일 합(÷시총)", FM20: "외국계 창구 순매수 20일 합(÷시총)", FMD: "외국계 창구 − 외국인 투자자 5일 합(÷시총)", L1: "대차잔고율", L2: "대차잔고 20일 변화율", MOM: "12-1개월 모멘텀", REV: "1개월 반전", VOL: "60일 변동성(낮을수록)", H52: "52주 고가 대비", FI5: "외국인 투자자 순매수 5일 합(÷시총, 정보용)" };

interface S { code: string; idx: Map<string, number>; mcapRow: Float64Array; avgTvRow: Float64Array; closeA: Float64Array; SXv: Float64Array; SCn: Int32Array; SFv: Float64Array; SFn: Int32Array; rm: Float64Array; listed: Float64Array; hasData: boolean }
interface DD { list: S[]; vals: Float64Array }
type Kind = "M" | "W";
type U = "POOL" | "MID";

const rank = (v: number[]): number[] => {
  const o = v.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x);
  const r = new Array<number>(v.length);
  for (let a = 0; a < o.length;) { let b = a; while (b + 1 < o.length && o[b + 1].x === o[a].x) b++; for (let c = a; c <= b; c++) r[o[c].i] = (a + b) / 2 + 1; a = b + 1; }
  return r;
};
const pearson = (a: number[], b: number[]): number => {
  const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
};
const spearman = (a: number[], b: number[]): number => pearson(rank(a), rank(b));
const mean = (a: number[]): number => a.reduce((s, x) => s + x, 0) / Math.max(a.length, 1);
const sdev = (a: number[]): number => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(a.length - 1, 1)); };
function nwT(x: number[], L: number): number {
  const n = x.length;
  if (n < 3) return NaN;
  const m = mean(x);
  const g = (j: number): number => { let s = 0; for (let t = j; t < n; t++) s += (x[t] - m) * (x[t - j] - m); return s / n; };
  let v = g(0);
  for (let j = 1; j <= L && j < n; j++) v += 2 * (1 - j / (L + 1)) * g(j);
  return v > 0 ? m / Math.sqrt(v / n) : NaN;
}
/** 최소제곱 잔차(절편 포함). X: n×k 열 목록. 실패 시 null. */
function olsResid(cols: number[][], y: number[]): number[] | null {
  const n = y.length, k = cols.length + 1;
  const X = Array.from({ length: n }, (_, i) => [1, ...cols.map((c) => c[i])]);
  const A = Array.from({ length: k }, () => new Array<number>(k + 1).fill(0));
  for (let i = 0; i < n; i++) for (let a = 0; a < k; a++) { A[a][k] += X[i][a] * y[i]; for (let b = 0; b < k; b++) A[a][b] += X[i][a] * X[i][b]; }
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < k; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let q = c; q <= k; q++) A[r][q] -= f * A[c][q]; }
  }
  const beta = A.map((row, i) => row[k] / row[i]);
  return y.map((yi, i) => yi - X[i].reduce((s, v, a) => s + v * beta[a], 0));
}
const groupOf = (i: number, n: number): number => Math.floor((i * 3) / n);

void olsResid;
async function main(): Promise<void> {
  const ISA = SCAN_MODE === "a";
  console.log(`신호 스캔 5회차 ${ISA ? "5-A(외국계 창구 신호 3개, 24행)" : "5-B(대차 신호 2개, 16행)"} 시작(읽기 전용, 학습 구간 ${SCAN_START}~${SCAN_END}만): ${new Date().toISOString()} (사전등록 docs/research/signal-scan-5-prereg.md 확정 커밋 이후)`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  // ---- 입력 정리본 (Actions 캐시): manifest 대조 ----
  const DIRS = PERIOD === "holdout" ? [S5_CACHE_DIR_FM, S5_CACHE_DIR_FMC, S5_CACHE_DIR_FMH] : [S5_CACHE_DIR_FM, S5_CACHE_DIR_FMC];
  type Man = { dataset: string; files: { path: string; rows: number; bytes: number; sha256: string }[]; stocks: string[]; delisted: string[]; createdAt: string };
  type FmRow = { b: number; s: number; n: number; c: number };
  const flowBy = new Map<string, Map<string, FmRow>>();
  const loanBy = new Map<string, Map<string, number>>();
  let man: Man | null = null;
  for (const dir of DIRS) {
    const mm = JSON.parse(await fsp.readFile(path.join(dir, "manifest.json"), "utf8")) as Man;
    if (mm.dataset !== "fm") throw new Error(`정리본 종류(${mm.dataset})가 외국계 창구(fm)와 다르다: ${dir}`);
    man = mm;
    for (const f of mm.files) {
      const buf = await fsp.readFile(path.join(dir, f.path));
      if (buf.byteLength !== f.bytes || createHash("sha256").update(buf).digest("hex") !== f.sha256) throw new Error(`정리본 ${dir}/${f.path}이 매니페스트와 다르다`);
      rd.bytes += buf.byteLength;
      const rows = (await parquetReadObjects({ file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer })) as Record<string, unknown>[];
      for (const r of rows) {
        const d = r.trade_date as string, code = r.stock_code as string;
        if (d > SCAN_END) { rd.dropped++; continue; }
        rd.rows++;
        let m = flowBy.get(code); if (!m) { m = new Map(); flowBy.set(code, m); }
        m.set(d, { b: Number(r.shnu_qty), s: Number(r.seln_qty), n: r.ntby_qty === null ? NaN : Number(r.ntby_qty), c: r.close === null ? NaN : Number(r.close) });
      }
    }
    console.log(`  입력 정리본 ${dir}: 매니페스트 SHA-256 일치, 생성 ${mm.createdAt}, 파일 ${mm.files.length}개, 요청 종목 ${mm.stocks.length}개(상장폐지 ${mm.delisted.length})`);
  }
  if (!man) throw new Error("입력 정리본이 없다");
  console.log(`입력 합계: ${(rd.bytes / 1048576).toFixed(2)} MiB 읽음, 사용 행 ${rd.rows}(구간 끝 ${SCAN_END} 뒤라 버린 행 ${rd.dropped}) | 종목 ${flowBy.size}개`);
  // ---- 외국인 투자자 순매수 대금 부분집합(FMD용, 5-A) ----
  const fiBy = new Map<string, Map<string, number>>();
  if (ISA) {
    const fb = await fsp.readFile(path.join(S5_FLOW_SUBSET_DIR, S5_FLOW_SUBSET_FILE));
    const got = createHash("sha256").update(fb).digest("hex");
    if (got !== S5_FLOW_SUBSET_SHA256) throw new Error(`수급 부분집합 SHA-256 불일치(${got.slice(0, 12)}… ≠ ${S5_FLOW_SUBSET_SHA256.slice(0, 12)}…)`);
    let nIn = 0;
    for (const r of await decodeTable(fb.buffer.slice(fb.byteOffset, fb.byteOffset + fb.byteLength) as ArrayBuffer)) {
      const d = String(r.trade_date);
      if (d > SCAN_END || r.frgn_ntby_amt === null || r.frgn_ntby_amt === undefined) continue;
      let m = fiBy.get(String(r.stock_code)); if (!m) { m = new Map(); fiBy.set(String(r.stock_code), m); }
      m.set(d, Number(r.frgn_ntby_amt)); nIn++;
    }
    console.log(`외국인 투자자 순매수 대금 부분집합(SHA-256 일치): 종목 ${fiBy.size}개, 학습 구간 행 ${nIn}`);
  }

  // ---- 가격 (고정 스냅샷, 데이터 종료일은 학습 구간 마지막 거래일) ----
  const h = await loadHarness();
  const CAL = h.CAL.filter((d) => d <= SCAN_END);
  const nCal = CAL.length, lastIdx = nCal - 1;
  const calIdx = new Map(CAL.map((d, i) => [d, i]));
  console.log(`가격 종목 ${h.stocks.length}개, 달력 ${nCal}일 ${CAL[0]}~${CAL[lastIdx]}(학습 구간 밖 ${h.nCal - nCal}일 버림)`);
  // 상장주식수(5-B 신호): 가격 Parquet 행에서(학습 구간 연도까지만 읽음)
  const listedBy = new Map<string, Float64Array>();
  if (!ISA) {
    const raw = await loadAllStockSeriesFromParquet(2010, Number(SCAN_END.slice(0, 4)));
    for (const [code, rows] of raw) {
      const arr = new Float64Array(nCal).fill(NaN);
      for (const r of rows) { const c = calIdx.get(r.tradeDate); if (c !== undefined && r.listedShares > 0) arr[c] = r.listedShares; }
      listedBy.set(code, arr);
    }
    raw.clear();
  }

  // ---- 종목 구조 ----
  const hasEligible = (s: HS): boolean => { for (let i = 1; i < s.dates.length; i++) { if (s.dates[i] > SCAN_END) break; if (s.dates[i] >= "2010-01-01" && s.mcapRow[i - 1] >= SCAN_CAP_EOK && s.avgTvRow[i] >= PIT_MIN_AVG_TRADING_VALUE_WON) return true; } return false; };
  const ratios: number[] = []; // |외국인 투자자 대금| ÷ |외국계 창구 순매수 대금| (κ 규칙용)
  const stocks: S[] = h.stocks.filter(hasEligible).map((hs) => {
    const closeA = new Float64Array(nCal).fill(NaN);
    const SXv = new Float64Array(ISA ? nCal + 1 : 0), SCn = new Int32Array(ISA ? nCal + 1 : 0), SFv = new Float64Array(ISA ? nCal + 1 : 0), SFn = new Int32Array(ISA ? nCal + 1 : 0);
    const rm = new Float64Array(ISA ? 0 : nCal).fill(NaN);
    const fm = flowBy.get(hs.code), fi = fiBy.get(hs.code), ln = loanBy.get(hs.code);
    for (let c = 0; c < nCal; c++) {
      const i = hs.idx.get(CAL[c]);
      let x = NaN, f = NaN;
      if (i !== undefined) {
        if (hs.close[i] > 0) closeA[c] = hs.close[i];
        if (ISA) {
          const mPrev = i >= 1 ? hs.mcapRow[i - 1] * S5_EOK_TO_WON : NaN;
          const fv = fm?.get(CAL[c]);
          if (hs.close[i] > 0 && mPrev > 0) {
            if (fv && Number.isFinite(fv.b) && Number.isFinite(fv.s) && hs.raw[i] > 0) x = ((fv.b - fv.s) * hs.raw[i]) / mPrev;
            const fa = fi?.get(CAL[c]);
            if (fa !== undefined && Number.isFinite(fa)) f = fa / mPrev;
            if (CAL[c] >= SCAN_START && fv && Number.isFinite(x) && fa !== undefined && Number.isFinite(fa) && x !== 0 && fa !== 0) ratios.push(Math.abs(fa) / Math.abs(x * mPrev));
          }
        } else if (ln) { const v = ln.get(CAL[c]); if (v !== undefined) rm[c] = v; }
      }
      if (ISA) {
        SXv[c + 1] = SXv[c] + (Number.isFinite(x) ? x : 0); SCn[c + 1] = SCn[c] + (Number.isFinite(x) ? 1 : 0);
        SFv[c + 1] = SFv[c] + (Number.isFinite(f) ? f : 0); SFn[c + 1] = SFn[c] + (Number.isFinite(f) ? 1 : 0);
      }
    }
    return { code: hs.code, idx: hs.idx, mcapRow: hs.mcapRow, avgTvRow: hs.avgTvRow, closeA, SXv, SCn, SFv, SFn, rm, listed: listedBy.get(hs.code) ?? new Float64Array(0), hasData: ISA ? !!fm : !!ln };
  });
  stocks.sort((a, b) => (a.code < b.code ? -1 : 1));
  console.log(`PIT 적격 이력이 있는 종목 ${stocks.length}개 중 ${ISA ? "외국계 창구" : "대차"} 정리본이 있는 종목 ${stocks.filter((s) => s.hasData).length}개`);

  // ================= 선행 조건 (사전등록 7절; 하나라도 실패하면 스캔하지 않고 숫자만 보고) =================
  console.log(`\n=== 선행 조건 점검 (사전등록 7절) ===`);
  let precondOk = true;
  const byCode = new Map(h.stocks.map((s) => [s.code, s]));
  {
    const req = man.stocks, own = ISA ? flowBy : loanBy;
    const allZero = req.filter((c) => { const m = own.get(c); if (!m) return true; if (ISA) return ![...(m as Map<string, FmRow>).entries()].some(([dd, r]) => dd >= SCAN_START && (r.b !== 0 || r.s !== 0)); return ![...(m as Map<string, number>).values()].some((v) => v !== 0); });
    let priceDaysN = 0, haveN = 0;
    for (const c of req) {
      const hs = byCode.get(c), m = own.get(c);
      if (!hs) continue;
      const fromD = SCAN_START;
      for (let i = 0; i < hs.dates.length; i++) { const d = hs.dates[i]; if (d < fromD || d > SCAN_END || !(hs.close[i] > 0)) continue; priceDaysN++; if (m?.has(d)) haveN++; }
    }
    const zRatio = allZero.length / Math.max(req.length, 1), mRatio = (priceDaysN - haveN) / Math.max(priceDaysN, 1);
    const ok1 = zRatio <= S5_MAX_ALL_ZERO_STOCK_RATIO, ok2 = mRatio <= S5_MAX_MISSING_DAY_RATIO;
    console.log(`값이 전부 0이거나 행이 없는 종목 ${allZero.length}/${req.length}(${(zRatio * 100).toFixed(2)}%, 상한 ${S5_MAX_ALL_ZERO_STOCK_RATIO * 100}%) → ${ok1 ? "통과" : "미충족"} | 가격은 있는데 데이터 없는 날 ${priceDaysN - haveN}/${priceDaysN}(${(mRatio * 100).toFixed(2)}%, 상한 ${S5_MAX_MISSING_DAY_RATIO * 100}%) → ${ok2 ? "통과" : "미충족"}`);
    precondOk = precondOk && ok1 && ok2;
  }
  let kappa = NaN;
  if (ISA) {
    let idBad = 0, idN = 0, closeOk = 0, closeN = 0;
    for (const [code, m] of flowBy) {
      const hs = byCode.get(code);
      for (const [d, r] of m) {
        if (d < SCAN_START) continue;
        if (Number.isFinite(r.n)) { idN++; if (r.b - r.s !== r.n) idBad++; }
        const i = hs?.idx.get(d);
        if (hs && i !== undefined && hs.raw[i] > 0 && Number.isFinite(r.c)) { closeN++; if (Math.abs(r.c / hs.raw[i] - 1) <= S5_CLOSE_TOL) closeOk++; }
      }
    }
    const ok3 = idBad / Math.max(idN, 1) <= S5_NTBY_IDENTITY_MAX_RATIO, ok4 = closeOk / Math.max(closeN, 1) >= S5_CLOSE_MIN_SHARE;
    console.log(`순매수 항등(매수−매도=순매수) 불일치 ${idBad}/${idN}(${((idBad / Math.max(idN, 1)) * 100).toFixed(3)}%, 상한 ${S5_NTBY_IDENTITY_MAX_RATIO * 100}%) → ${ok3 ? "통과" : "미충족"} | 응답 종가가 가격 Parquet 원주가 종가의 ±${S5_CLOSE_TOL * 100}% 안 ${closeOk}/${closeN}(${((closeOk / Math.max(closeN, 1)) * 100).toFixed(2)}%, 하한 ${S5_CLOSE_MIN_SHARE * 100}%) → ${ok4 ? "통과" : "미충족"}`);
    precondOk = precondOk && ok3 && ok4;
    // κ 규칙
    ratios.sort((a, b) => a - b);
    const med = ratios.length ? ratios[Math.floor(ratios.length / 2)] : NaN;
    const cand = S5_FI_KAPPAS.filter((k) => med * k >= S5_FI_RATIO_MIN && med * k <= S5_FI_RATIO_MAX);
    console.log(`κ 규칙: |frgn_ntby_amt| ÷ |외국계 창구 순매수 × 종가| 중앙값(원 단위 비교 전, 표본 ${ratios.length}) ${med.toExponential(3)} → κ 후보 중 [${S5_FI_RATIO_MIN}, ${S5_FI_RATIO_MAX}]에 드는 값 ${cand.length ? cand.join(", ") : "없음"}`);
    if (cand.length === 1) kappa = cand[0]; else { console.log("κ가 유일하게 정해지지 않아 FMD는 계산하지 않는다(보고)"); }
    // 99999 의미 대조: 학습 구간 마지막 월말 시총 상위 N종목의 일별 x와 fi의 피어슨 상관 중앙값
    let lastMe = -1;
    for (let k = 0; k + 1 < nCal; k++) if (CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) lastMe = k;
    if (lastMe < 0) lastMe = lastIdx;
    const top = stocks.filter((s) => s.hasData && fiBy.has(s.code)).map((s) => ({ s, mc: s.mcapRow[s.idx.get(CAL[lastMe]) ?? -1] ?? NaN })).filter((x) => Number.isFinite(x.mc)).sort((a, b) => b.mc - a.mc).slice(0, S5_ID_TOP_N);
    const cors: number[] = [];
    for (const { s } of top) {
      const xs: number[] = [], fs: number[] = [];
      for (let c = 0; c < nCal; c++) { if (CAL[c] < SCAN_START) continue; const x = s.SXv[c + 1] - s.SXv[c], nx = s.SCn[c + 1] - s.SCn[c], f = s.SFv[c + 1] - s.SFv[c], nf = s.SFn[c + 1] - s.SFn[c]; if (nx === 1 && nf === 1) { xs.push(x); fs.push(f); } }
      if (xs.length >= 100) { const r = pearson(xs, fs); if (Number.isFinite(r)) cors.push(r); }
    }
    cors.sort((a, b) => a - b);
    const medC = cors.length ? cors[Math.floor(cors.length / 2)] : NaN;
    const ok5 = Number.isFinite(medC) && medC >= S5_ID_MIN_CORR;
    console.log(`99999 의미 대조: ${CAL[lastMe]} 시총 상위 ${top.length}종목의 일별 x와 외국인 투자자 fi의 피어슨 상관 ${cors.length}종목 중앙값 ${f3(medC)}(최소 ${f3(cors[0] ?? NaN)}, 최대 ${f3(cors[cors.length - 1] ?? NaN)}, 기준 ${S5_ID_MIN_CORR} 이상) → ${ok5 ? "통과" : "미충족"}`);
    precondOk = precondOk && ok5;
  }
  if (!precondOk) { console.log("\n선행 조건 미충족 — 스캔하지 않고 숫자만 보고한다"); return; }
  console.log("선행 조건 모두 통과 — 스캔 진행");
  const FIK = ISA && Number.isFinite(kappa) ? kappa : NaN;

  // ---- 유니버스: POOL = 적격 중 시총 상위 100, MID = 적격 중 시총 101~150위 ----
  const eligCache = new Map<string, { s: S; mcap: number }[]>();
  const elig = (d: string): { s: S; mcap: number }[] => {
    let e = eligCache.get(d);
    if (!e) {
      e = [];
      for (const s of stocks) { const i = s.idx.get(d); if (i === undefined || i < 1 || !(s.mcapRow[i - 1] >= SCAN_CAP_EOK) || !(s.avgTvRow[i] >= PIT_MIN_AVG_TRADING_VALUE_WON)) continue; e.push({ s, mcap: s.mcapRow[i] }); }
      e.sort((a, b) => b.mcap - a.mcap || (a.s.code < b.s.code ? -1 : 1));
      eligCache.set(d, e);
    }
    return e;
  };
  const universeAt = (u: U, d: string): S[] => { const sorted = elig(d).map((x) => x.s); return u === "POOL" ? sorted.slice(0, SCAN_POOL_SIZE) : sorted.slice(SCAN_POOL_SIZE, S5_MID_TO); };

  // ---- 신호 ----
  const winMean = (SV: Float64Array, SN: Int32Array, c: number, w: number, minValid: number): number => {
    if (c - w + 1 < 0) return NaN;
    const n = SN[c + 1] - SN[c - w + 1];
    return n >= minValid ? ((SV[c + 1] - SV[c - w + 1]) / n) * w : NaN; // 합 환산
  };
  const lv = (s: S, j: number): number => { for (let k = j; k >= Math.max(j - S5_LOAN_CARRY_DAYS, 0); k--) { const v = s.rm[k]; if (Number.isFinite(v)) return v; } return NaN; };
  function signalsAt(s: S, c: number, out: Float64Array, off: number): void {
    out.fill(NaN, off, off + NS);
    if (ISA) {
      if (s.hasData) {
        const f5 = winMean(s.SXv, s.SCn, c, S5_FM_WINDOWS[0], S5_FM_MIN_VALID[5]), f20 = winMean(s.SXv, s.SCn, c, S5_FM_WINDOWS[1], S5_FM_MIN_VALID[20]);
        out[off + 0] = f5; out[off + 1] = f20;
        const i5 = winMean(s.SFv, s.SFn, c, S5_FM_WINDOWS[0], S5_FM_MIN_VALID[5]) * (Number.isFinite(FIK) ? FIK : NaN);
        if (Number.isFinite(f5) && Number.isFinite(i5)) out[off + 2] = f5 - i5;
        out[off + NT + 4] = i5; // FI5(정보용)
      }
    } else if (s.hasData) {
      const j = c - S5_LOAN_LAG_DAYS;
      if (j >= 0) {
        const v = lv(s, j), lst = s.listed[c];
        if (Number.isFinite(v) && lst > 0) out[off + 0] = v / lst;
        const v0 = j - S5_LOAN_CHG_DAYS >= 0 ? lv(s, j - S5_LOAN_CHG_DAYS) : NaN;
        if (Number.isFinite(v) && Number.isFinite(v0) && v0 > 0) out[off + 1] = v / v0 - 1;
      }
    }
    const cl = s.closeA;
    if (c >= SCAN_MOM_LONG_DAYS) { const a = cl[c - SCAN_MOM_SKIP_DAYS], b = cl[c - SCAN_MOM_LONG_DAYS]; if (a > 0 && b > 0) out[off + NT] = a / b - 1; }
    if (c >= SCAN_MOM_SKIP_DAYS) { const a = cl[c], b = cl[c - SCAN_MOM_SKIP_DAYS]; if (a > 0 && b > 0) out[off + NT + 1] = -(a / b - 1); }
    if (c >= SCAN_VOL_DAYS) {
      let n = 0, sum = 0, sum2 = 0;
      for (let jj = c - SCAN_VOL_DAYS + 1; jj <= c; jj++) if (cl[jj] > 0 && cl[jj - 1] > 0) { const r = cl[jj] / cl[jj - 1] - 1; n++; sum += r; sum2 += r * r; }
      if (n >= SCAN_VOL_MIN_RETURNS) { const m = sum / n; out[off + NT + 2] = -Math.sqrt(Math.max((sum2 - n * m * m) / (n - 1), 0)); }
    }
    if (c >= SCAN_H52_DAYS - 1 && cl[c] > 0) {
      let mx = 0, n = 0;
      for (let jj = c - SCAN_H52_DAYS + 1; jj <= c; jj++) if (cl[jj] > 0) { n++; if (cl[jj] > mx) mx = cl[jj]; }
      if (n >= SCAN_H52_MIN_ROWS && mx > 0) out[off + NT + 3] = cl[c] / mx;
    }
  }
  const ddCache = new Map<string, DD>();
  function dataAt(u: U, d: string): DD {
    const key = `${u}|${d}`;
    let dd = ddCache.get(key);
    if (dd) return dd;
    const list = universeAt(u, d), c = calIdx.get(d)!;
    const vals = new Float64Array(list.length * NS);
    list.forEach((s, k) => signalsAt(s, c, vals, k * NS));
    dd = { list, vals };
    ddCache.set(key, dd);
    return dd;
  }
  const buyRate = computeEffectiveBuyPrice(1) - 1;
  const sellRate = (d: string): number => 1 - computeEffectiveSellPrice(1, d, "KR");
  function fwd(s: S, c: number, H: number): number {
    const e = s.closeA[c + 1];
    if (!(e > 0)) return NaN;
    for (let j = c + 1 + H; j > c + 1; j--) { if (s.closeA[j] > 0) return s.closeA[j] / e - 1; }
    return 0;
  }
  function legs(items: { code: string; v: number }[]): { top: Set<string>; bot: Set<string> } {
    const sorted = [...items].sort((a, b) => b.v - a.v || (a.code < b.code ? -1 : 1));
    const top = new Set<string>(), bot = new Set<string>();
    sorted.forEach((x, i) => { const g = groupOf(i, sorted.length); if (g === 0) top.add(x.code); else if (g === 2) bot.add(x.code); });
    return { top, bot };
  }

  // ---- 표본일 ----
  const weekKey = (d: string): number => Math.floor((Date.parse(d) / MS_DAY + 3) / 7);
  const monthSamples: string[] = [], weekSamples: string[] = [];
  for (let k = 0; k + 1 < nCal; k++) {
    if (CAL[k] < SCAN_START) continue;
    if (CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) monthSamples.push(CAL[k]);
    if (weekKey(CAL[k]) !== weekKey(CAL[k + 1])) weekSamples.push(CAL[k]);
  }
  console.log(`월간 표본일 ${monthSamples.length}개(${monthSamples[0]}~${monthSamples[monthSamples.length - 1]}), 주간 표본일 ${weekSamples.length}개`);

  // =========== 종목 단위 (신호 NT개 × 4조합 × POOL·MID) ===========
  interface Res { kind: Kind; H: number; u: U; s: number; n: number; avgN: number; rho: number[]; spread: number[]; cost: number[] }
  const results: Res[] = [];
  const combos: { kind: Kind; H: number }[] = [...SCAN_HORIZONS.map((H) => ({ kind: "M" as Kind, H })), { kind: "W", H: SCAN_HORIZONS[0] }];
  const ROWSEL = ROWS_ARG === "" ? S5_CONFIRM_ROWS.map((_, i) => i) : ROWS_ARG.split(",").map((x) => Number(x.trim()));
  if (PERIOD === "holdout" && ROWS_ARG === "") throw new Error("holdout은 확인에서 재현된 행 번호가 필요하다(예 holdout:0,2)");
  if (ROWSEL.some((i) => !Number.isInteger(i) || i < 0 || i >= S5_CONFIRM_ROWS.length)) throw new Error("행 번호 오류");
  const targets = ROWSEL.map((i) => S5_CONFIRM_ROWS[i]);
  for (const u of ["POOL", "MID"] as U[]) for (const { kind, H } of combos) {
    if (!targets.some((t) => t[0] === u && t[2] === kind && t[3] === H)) continue;
    const samples = (kind === "M" ? monthSamples : weekSamples).filter((d) => calIdx.get(d)! + 1 + H <= lastIdx);
    const acc = Array.from({ length: NT }, () => ({ rho: [] as number[], spread: [] as number[], cost: [] as number[], ns: [] as number[] }));
    for (const d of samples) {
      const c = calIdx.get(d)!;
      const dd = dataAt(u, d), d2 = CAL[c + H], dd2 = dataAt(u, d2);
      const rets = dd.list.map((s) => fwd(s, c, H));
      const unit = buyRate + sellRate(CAL[c + H + 1]);
      for (let si = 0; si < NT; si++) {
        const items: { code: string; v: number; r: number }[] = [];
        dd.list.forEach((s, k) => { const v = dd.vals[k * NS + si], r = rets[k]; if (Number.isFinite(v) && Number.isFinite(r)) items.push({ code: s.code, v, r }); });
        if (items.length < SCAN_MIN_CROSS_SECTION) continue;
        acc[si].ns.push(items.length);
        const rho = spearman(items.map((x) => x.v), items.map((x) => x.r));
        if (Number.isFinite(rho)) acc[si].rho.push(rho);
        const lg = legs(items);
        const topR = items.filter((x) => lg.top.has(x.code)).map((x) => x.r), botR = items.filter((x) => lg.bot.has(x.code)).map((x) => x.r);
        if (!(topR.length > 0 && botR.length > 0)) continue;
        acc[si].spread.push(mean(topR) - mean(botR));
        const items2: { code: string; v: number }[] = [];
        dd2.list.forEach((s, k) => { const v = dd2.vals[k * NS + si]; if (Number.isFinite(v)) items2.push({ code: s.code, v }); });
        if (items2.length < SCAN_MIN_CROSS_SECTION) continue;
        const lg2 = legs(items2);
        const uTop = [...lg.top].filter((x) => !lg2.top.has(x)).length / Math.max(lg.top.size, 1);
        const uBot = [...lg.bot].filter((x) => !lg2.bot.has(x)).length / Math.max(lg.bot.size, 1);
        acc[si].cost.push((uTop + uBot) * unit);
      }
    }
    for (let si = 0; si < NT; si++) results.push({ kind, H, u, s: si, n: acc[si].rho.length, avgN: mean(acc[si].ns), rho: acc[si].rho, spread: acc[si].spread, cost: acc[si].cost });
    console.log(`  완료: ${u} ${kind === "M" ? "월간" : "주간"} ${H}일 — 표본일 ${samples.length}개 (${((Date.now() - T0) / 60e3).toFixed(1)}분)`);
  }
  const spacingOf = (kind: Kind): number => (kind === "M" ? SCAN_SPACING_MONTHLY_DAYS : SCAN_SPACING_WEEKLY_DAYS);
  const nonOverlapT = (rho: number[], step: number): number => {
    const ts: number[] = [];
    for (let o = 0; o < step; o++) {
      const xs: number[] = [];
      for (let i = o; i < rho.length; i += step) xs.push(rho[i]);
      if (xs.length >= S5_NONOVERLAP_MIN_SAMPLES) { const m = mean(xs), sd = sdev(xs); if (sd > 0) ts.push(m / (sd / Math.sqrt(xs.length))); }
    }
    ts.sort((a, b) => a - b);
    return ts.length ? ts[Math.floor(ts.length / 2)] : NaN;
  };

  console.log(`\n=== 확인 점검 대상 행 (${PERIOD === "confirm" ? "확인 구간" : "보류 구간(참고용)"} ${SCAN_START}~${SCAN_END}) ===`);
  console.log("순위상관 = 표본일별 횡단면 스피어만의 평균, t = Newey-West(시차 L = max(1, round(H ÷ 표본 간격))), 순차이 = 신호 방향(음, 학습 구간 부호) × (상위−하위) 부호 반영 − 교체 비용(%, 예측 기간 수익률 기준). 재현 기준: 순위상관 평균 < 0 ∧ NW |t| ≥ " + S5_CONFIRM_MIN_ABS_T + " ∧ 순차이 > 0.");
  console.log("| # | 유니버스 | 신호 | 기간 | 표본일 수(상관) | n_eff | 평균 종목 수 | 순위상관 평균 | 표준편차 | t(NW) | 비중복 t | 양수 비율 % | 상위−하위 % | 교체 비용 % | 신호 방향(음) 순차이 % | 같은 부호 | |t| ≥ " + S5_CONFIRM_MIN_ABS_T + " | 순차이 > 0 | 재현 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  const reproduced: number[] = [];
  ROWSEL.forEach((ri) => {
    const [u, si, kind, H] = S5_CONFIRM_ROWS[ri];
    const r = results.find((x) => x.u === u && x.s === si && x.kind === kind && x.H === H)!;
    const m = mean(r.rho), L = Math.max(1, Math.round(H / spacingOf(kind))), step = Math.max(1, Math.ceil(H / spacingOf(kind)));
    const t = r.rho.length >= 3 ? nwT(r.rho, L) : NaN;
    const sp = mean(r.spread) * 100, cs = mean(r.cost) * 100;
    const net = r.spread.length && r.cost.length ? -sp - cs : NaN;
    const sameSign = m < 0, tOk = Number.isFinite(t) && Math.abs(t) >= S5_CONFIRM_MIN_ABS_T, netOk = Number.isFinite(net) && net > 0;
    const rep = sameSign && tOk && netOk;
    if (rep) reproduced.push(ri);
    console.log(`| ${ri} | ${u} | ${SIG_LABEL[SIGNALS[si]]} | ${kind === "M" ? "월간" : "주간"} ${H}일 | ${r.rho.length} | ${f2(r.rho.length / step)} | ${f2(r.avgN)} | ${f3(m)} | ${f3(sdev(r.rho))} | ${f2(t)} | ${f2(nonOverlapT(r.rho, step))} | ${f2((r.rho.filter((x) => x > 0).length / Math.max(r.rho.length, 1)) * 100)} | ${f2(sp)} | ${f2(cs)} | ${f2(net)} | ${sameSign ? "예" : "아니오"} | ${tOk ? "예" : "아니오"} | ${netOk ? "예" : "아니오"} | ${rep ? "재현" : "미재현"} |`);
  });
  console.log(`\n재현 판정: ${reproduced.length}/${ROWSEL.length}행 재현${reproduced.length ? ` (행 번호 ${reproduced.join(",")})` : ""}${PERIOD === "confirm" ? (reproduced.length ? " → 보류 구간을 한 번 열어 같은 방식으로 참고용 보고(재현 행만)" : " → 재현 행이 없어 보류 구간은 열지 않는다") : " (보류 구간은 참고용, 판정에 쓰지 않는다)"}`);
  console.log("\n조합별 표본일 수(예측 기간 청산일이 구간 이내인 표본일):");
  for (const { kind, H } of combos) if (targets.some((t) => t[2] === kind && t[3] === H)) console.log(`  ${kind === "M" ? "월간" : "주간"} ${H}일: ${(kind === "M" ? monthSamples : weekSamples).filter((d) => calIdx.get(d)! + 1 + H <= lastIdx).length}개`);
  console.log(`\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)} (069500 기준선·조정 이벤트용 읽기)`);
  console.log(`입력 정리본(Actions 캐시) 읽은 바이트 ${rd.bytes} B (${(rd.bytes / 1048576).toFixed(2)} MiB), Storage 다운로드 0 | Supabase 쓴 행: 0 | 외부 요청 0 | DART 호출 0 | 확인 점검 평가 행 ${ROWSEL.length}(스캔 행 누적 385 그대로, 시험 번호 290 그대로) | 소요 ${((Date.now() - T0) / 60e3).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

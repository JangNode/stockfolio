/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 신호 스캔 4회차 4-A(체결강도 3신호 + 프로그램매매 시장 단위 3신호, 학습 구간 2011-04-01~2016-12-31만, 전략 백테스트 없음).
 * 사전 등록: docs/research/signal-scan-3-prereg.md (확정 커밋 b7edd74). 종목 단위 측정은 research/signal-scan-prereg.md(19d3eea)와 같고 MID만 시총 101~150위(이전 스캔 MID와 직접 비교 불가).
 * 입력: 수집 정리본(Actions 캐시 .scan4a-inputs, Storage 읽기 0)과 고정 가격 스냅샷. 2016-12-31을 넘는 가격·체결량·프로그램매매 행은 읽은 직후 버린다. 숫자와 표만 출력한다.
 */
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { parquetReadObjects } from "hyparquet";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";
import { PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { SCAN_HORIZONS, SCAN_SPACING_MONTHLY_DAYS, SCAN_SPACING_WEEKLY_DAYS, SCAN_CAP_EOK, SCAN_POOL_SIZE, SCAN_MIN_CROSS_SECTION, SCAN_CANDIDATE_ABS_T, SCAN_FLOW_MIN_PRICE_DAY_RATIO, SCAN_MOM_LONG_DAYS, SCAN_MOM_SKIP_DAYS, SCAN_H52_DAYS, SCAN_H52_MIN_ROWS, SCAN_VOL_DAYS, SCAN_VOL_MIN_RETURNS } from "@/lib/signalScanConfig";
import { S4_CACHE_DIR, S4_SCAN_START, S4_SCAN_END, S4_MID_TO, S4_T_WINDOWS, S4_PG_WINDOW, S4_PG_MIN_PRIOR, S4_PG_HI, S4_PG_LO, S4_MKT_HORIZONS, S4_PREREG_COMMIT } from "@/lib/scan4aConfig";
import { loadHarness, verifySnapshotManifest, SNAP_END, dbRead, type S as HS } from "./researchHarness";

const T0 = Date.now();
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "-");
const MS_DAY = 86_400_000;
const rd = { bytes: 0, rows: 0, dropped: 0 };

const SIGNALS = ["T5", "T20", "TD", "MOM", "REV", "VOL", "H52"] as const;
const NS = SIGNALS.length, NT = 3; // 검정 행은 앞 3개(체결강도)
const SIG_LABEL: Record<(typeof SIGNALS)[number], string> = { T5: "체결강도 5일 평균", T20: "체결강도 20일 평균", TD: "체결강도 변화(T5−T20)", MOM: "12-1개월 모멘텀", REV: "1개월 반전", VOL: "60일 변동성(낮을수록)", H52: "52주 고가 대비" };
const PG = ["PG_all", "PG_arb", "PG_nonarb"] as const;
const PG_LABEL: Record<(typeof PG)[number], string> = { PG_all: "프로그램 전체 순매수 비율(5일)", PG_arb: "프로그램 차익 순매수 비율(5일)", PG_nonarb: "프로그램 비차익 순매수 비율(5일)" };
const PG_COLS: Record<(typeof PG)[number], [string, string]> = { PG_all: ["whol_smtn_shnu_tr_pbmn", "whol_smtn_seln_tr_pbmn"], PG_arb: ["arbt_smtn_shnu_tr_pbmn", "arbt_smtn_seln_tr_pbmn"], PG_nonarb: ["nabt_smtn_shnu_tr_pbmn", "nabt_smtn_seln_tr_pbmn"] };

interface S { code: string; idx: Map<string, number>; mcapRow: Float64Array; avgTvRow: Float64Array; closeA: Float64Array; mcapA: Float64Array; PD: Float64Array; SXv: Float64Array; SCn: Int32Array; hasFlow: boolean }
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
/** OLS 기울기와 Newey-West(Bartlett) t. y = a + b x. */
function olsSlopeNw(x: number[], y: number[], L: number): { b: number; t: number } {
  const n = x.length, mx = mean(x), my = mean(y);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
  if (!(sxx > 0) || n < 4) return { b: NaN, t: NaN };
  const b = sxy / sxx;
  const u = x.map((xi, i) => (xi - mx) * (y[i] - my - b * (xi - mx)));
  let om = u.reduce((s, v) => s + v * v, 0);
  for (let j = 1; j <= L && j < n; j++) { let s = 0; for (let t = j; t < n; t++) s += u[t] * u[t - j]; om += 2 * (1 - j / (L + 1)) * s; }
  return { b, t: om > 0 ? b / Math.sqrt(om / (sxx * sxx)) : NaN };
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

async function main(): Promise<void> {
  console.log(`신호 스캔 4회차 4-A 시작(읽기 전용, 학습 구간 ${S4_SCAN_START}~${S4_SCAN_END}만): ${new Date().toISOString()} (사전등록 ${S4_PREREG_COMMIT} 이후) — 스캔 4회차 4-A(신호 6개, 33행)`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  // ---- 입력 정리본 (Actions 캐시): manifest 대조 ----
  const dir = process.env.SCAN4A_DIR?.trim() || S4_CACHE_DIR;
  const man = JSON.parse(await fsp.readFile(path.join(dir, "manifest.json"), "utf8")) as { files: { path: string; rows: number; bytes: number; sha256: string }[]; stocks: string[]; delisted: string[]; createdAt: string };
  const flowBy = new Map<string, Map<string, [number, number]>>();
  const mkt = new Map<string, Map<string, Record<string, number>>>(); // market -> date -> cols
  for (const f of man.files) {
    const buf = await fsp.readFile(path.join(dir, f.path));
    if (buf.byteLength !== f.bytes || createHash("sha256").update(buf).digest("hex") !== f.sha256) throw new Error(`정리본 ${f.path}이 매니페스트와 다르다`);
    rd.bytes += buf.byteLength;
    const rows = (await parquetReadObjects({ file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer })) as Record<string, unknown>[];
    for (const r of rows) {
      const d = r.trade_date as string;
      if (d > S4_SCAN_END) { rd.dropped++; continue; }
      rd.rows++;
      if (f.path.startsWith("exec_strength_clean")) {
        let m = flowBy.get(r.stock_code as string);
        if (!m) { m = new Map(); flowBy.set(r.stock_code as string, m); }
        m.set(d, [Number(r.total_shnu_qty), Number(r.total_seln_qty)]);
      } else {
        let m = mkt.get(r.market as string);
        if (!m) { m = new Map(); mkt.set(r.market as string, m); }
        const o: Record<string, number> = {};
        for (const k of Object.keys(r)) if (k !== "market" && k !== "trade_date") o[k] = r[k] === null || r[k] === undefined ? NaN : Number(r[k]);
        m.set(d, o);
      }
    }
  }
  console.log(`입력 정리본(매니페스트 SHA-256 일치, 생성 ${man.createdAt}): 파일 ${man.files.length}개 ${(rd.bytes / 1048576).toFixed(2)} MiB 읽음, 사용 행 ${rd.rows}, 학습 구간 밖이라 버린 행 ${rd.dropped} | 체결강도 종목 ${flowBy.size}개 | 요청 대상 ${man.stocks.length}종목(상장폐지 ${man.delisted.length})`);

  // ---- 가격 (고정 스냅샷): 학습 구간 밖 달력은 즉시 버린다 ----
  const h = await loadHarness();
  const CAL = h.CAL.filter((d) => d <= S4_SCAN_END);
  const nCal = CAL.length, lastIdx = nCal - 1;
  const calIdx = new Map(CAL.map((d, i) => [d, i]));
  console.log(`가격 종목 ${h.stocks.length}개, 달력 ${nCal}일 ${CAL[0]}~${CAL[lastIdx]}(학습 구간 밖 ${h.nCal - nCal}일 버림)`);
  // 069500 원주가 지수(가격 수익만, 학습 구간까지만)
  const bhRetByDate = new Map<string, number>();
  h.bhP.dates.forEach((d, i) => { if (d <= S4_SCAN_END) bhRetByDate.set(d, h.bhP.ret[i] / 100); });
  const lvl = new Float64Array(nCal).fill(NaN);
  { let v = 1; for (let k = 0; k < nCal; k++) { const r = bhRetByDate.get(CAL[k]); if (r !== undefined) v *= 1 + r; lvl[k] = v; } }

  // ---- 종목 구조 ----
  const hasEligible = (s: HS): boolean => { for (let i = 1; i < s.dates.length; i++) { if (s.dates[i] > S4_SCAN_END) break; if (s.dates[i] >= "2010-01-01" && s.mcapRow[i - 1] >= SCAN_CAP_EOK && s.avgTvRow[i] >= PIT_MIN_AVG_TRADING_VALUE_WON) return true; } return false; };
  const stocks: S[] = h.stocks.filter(hasEligible).map((hs) => {
    const closeA = new Float64Array(nCal).fill(NaN), mcapA = new Float64Array(nCal).fill(NaN);
    const PD = new Float64Array(nCal + 1), SXv = new Float64Array(nCal + 1), SCn = new Int32Array(nCal + 1);
    const fm = flowBy.get(hs.code);
    for (let c = 0; c < nCal; c++) {
      const i = hs.idx.get(CAL[c]);
      let pd = 0, x = NaN;
      if (i !== undefined) {
        if (hs.close[i] > 0) { closeA[c] = hs.close[i]; pd = 1; }
        mcapA[c] = hs.mcapRow[i];
        const fv = fm?.get(CAL[c]);
        if (pd && fv && hs.vol[i] > 0 && Number.isFinite(fv[0]) && Number.isFinite(fv[1])) x = (fv[0] - fv[1]) / hs.vol[i];
      }
      PD[c + 1] = PD[c] + pd;
      SXv[c + 1] = SXv[c] + (Number.isFinite(x) ? x : 0);
      SCn[c + 1] = SCn[c] + (Number.isFinite(x) ? 1 : 0);
    }
    return { code: hs.code, idx: hs.idx, mcapRow: hs.mcapRow, avgTvRow: hs.avgTvRow, closeA, mcapA, PD, SXv, SCn, hasFlow: !!fm };
  });
  stocks.sort((a, b) => (a.code < b.code ? -1 : 1));
  console.log(`PIT 적격 이력이 있는 종목 ${stocks.length}개 중 체결강도 정리본이 있는 종목 ${stocks.filter((s) => s.hasFlow).length}개`);

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
  const universeAt = (u: U, d: string): S[] => { const sorted = elig(d).map((x) => x.s); return u === "POOL" ? sorted.slice(0, SCAN_POOL_SIZE) : sorted.slice(SCAN_POOL_SIZE, S4_MID_TO); };

  // ---- 신호 ----
  const minDays = (w: number): number => Math.ceil(w * SCAN_FLOW_MIN_PRICE_DAY_RATIO);
  const tMean = (s: S, c: number, w: number): number => {
    if (!s.hasFlow || c - w + 1 < 0) return NaN;
    const n = s.SCn[c + 1] - s.SCn[c - w + 1];
    return n >= minDays(w) ? (s.SXv[c + 1] - s.SXv[c - w + 1]) / n : NaN;
  };
  function signalsAt(s: S, c: number, out: Float64Array, off: number): void {
    out.fill(NaN, off, off + NS);
    const t5 = tMean(s, c, S4_T_WINDOWS[0]), t20 = tMean(s, c, S4_T_WINDOWS[1]);
    out[off + 0] = t5; out[off + 1] = t20;
    if (Number.isFinite(t5) && Number.isFinite(t20)) out[off + 2] = t5 - t20;
    const cl = s.closeA;
    if (c >= SCAN_MOM_LONG_DAYS) { const a = cl[c - SCAN_MOM_SKIP_DAYS], b = cl[c - SCAN_MOM_LONG_DAYS]; if (a > 0 && b > 0) out[off + 3] = a / b - 1; }
    if (c >= SCAN_MOM_SKIP_DAYS) { const a = cl[c], b = cl[c - SCAN_MOM_SKIP_DAYS]; if (a > 0 && b > 0) out[off + 4] = -(a / b - 1); }
    if (c >= SCAN_VOL_DAYS) {
      let n = 0, sum = 0, sum2 = 0;
      for (let jj = c - SCAN_VOL_DAYS + 1; jj <= c; jj++) if (cl[jj] > 0 && cl[jj - 1] > 0) { const r = cl[jj] / cl[jj - 1] - 1; n++; sum += r; sum2 += r * r; }
      if (n >= SCAN_VOL_MIN_RETURNS) { const m = sum / n; out[off + 5] = -Math.sqrt(Math.max((sum2 - n * m * m) / (n - 1), 0)); }
    }
    if (c >= SCAN_H52_DAYS - 1 && cl[c] > 0) {
      let mx = 0, n = 0;
      for (let jj = c - SCAN_H52_DAYS + 1; jj <= c; jj++) if (cl[jj] > 0) { n++; if (cl[jj] > mx) mx = cl[jj]; }
      if (n >= SCAN_H52_MIN_ROWS && mx > 0) out[off + 6] = cl[c] / mx;
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
    if (CAL[k] < S4_SCAN_START) continue;
    if (CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) monthSamples.push(CAL[k]);
    if (weekKey(CAL[k]) !== weekKey(CAL[k + 1])) weekSamples.push(CAL[k]);
  }
  console.log(`월간 표본일 ${monthSamples.length}개(${monthSamples[0]}~${monthSamples[monthSamples.length - 1]}), 주간 표본일 ${weekSamples.length}개`);

  // =========== 종목 단위 (체결강도 3신호 × 4조합 × POOL·MID = 24행) ===========
  interface Res { kind: Kind; H: number; u: U; s: number; n: number; avgN: number; rho: number[]; spread: number[]; cost: number[] }
  const results: Res[] = [];
  const combos: { kind: Kind; H: number }[] = [...SCAN_HORIZONS.map((H) => ({ kind: "M" as Kind, H })), { kind: "W", H: SCAN_HORIZONS[0] }];
  for (const u of ["POOL", "MID"] as U[]) for (const { kind, H } of combos) {
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

  console.log(`\n=== (b-1) 종목 단위 신호 × 기간 × 유니버스 (${S4_SCAN_START}~${S4_SCAN_END}) ===`);
  console.log("순위상관 = 표본일별 횡단면 스피어만의 평균, t = Newey-West, 상위−하위·비용·순차이는 %(예측 기간 수익률 기준). 순차이 = 방향(순위상관 평균의 부호) × (상위−하위) − 비용. MID = PIT 적격 중 시총 101~150위(이전 스캔의 MID와 범위가 달라 직접 비교 불가).");
  let nCand = 0, nRows = 0;
  const big: string[] = [];
  const candRows: { u: U; s: number; kind: Kind; H: number }[] = [];
  for (const u of ["POOL", "MID"] as U[]) {
    console.log(`\n[유니버스 ${u === "POOL" ? "POOL(PIT 시총 상위 100)" : "MID(PIT 적격 중 시총 101~150위)"}]`);
    console.log("| 신호 | 기간 | 표본일 수(상관) | 평균 종목 수 | 순위상관 평균 | 표준편차 | t(NW) | 양수 비율 % | 상위−하위 % | 교체 비용 % | 방향 반영 순차이 % | 후보 |\n|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (let si = 0; si < NT; si++) for (const { kind, H } of combos) {
      const r = results.find((x) => x.u === u && x.s === si && x.kind === kind && x.H === H)!;
      const m = mean(r.rho), L = Math.max(1, Math.round(H / (kind === "M" ? SCAN_SPACING_MONTHLY_DAYS : SCAN_SPACING_WEEKLY_DAYS)));
      const t = r.rho.length >= 3 ? nwT(r.rho, L) : NaN;
      const dir = m >= 0 ? 1 : -1;
      const sp = mean(r.spread) * 100, cs = mean(r.cost) * 100;
      const net = r.spread.length && r.cost.length ? dir * sp - cs : NaN;
      const cand = Number.isFinite(t) && Math.abs(t) >= SCAN_CANDIDATE_ABS_T && Number.isFinite(net) && net > 0;
      nRows++; if (cand) { nCand++; candRows.push({ u, s: si, kind, H }); }
      const line = `| ${SIG_LABEL[SIGNALS[si]]} | ${kind === "M" ? "월간" : "주간"} ${H}일 | ${r.rho.length} | ${f2(r.avgN)} | ${f3(m)} | ${f3(sdev(r.rho))} | ${f2(t)} | ${f2((r.rho.filter((x) => x > 0).length / Math.max(r.rho.length, 1)) * 100)} | ${r.spread.length ? f2(sp) : "-"} | ${r.cost.length ? f2(cs) : "-"} | ${f2(net)} | ${cand ? "후보" : ""} |`;
      console.log(line);
      if (Number.isFinite(t) && Math.abs(t) >= SCAN_CANDIDATE_ABS_T) big.push(`| ${u} | ${line.slice(2)}`);
    }
  }

  // =========== 시장 단위 (프로그램매매 3신호 × 3조합 = 9행, 069500) ===========
  const K = mkt.get("K") ?? new Map<string, Record<string, number>>();
  const pgAt = (sig: (typeof PG)[number], c: number): number => {
    if (c - S4_PG_WINDOW + 1 < 0) return NaN;
    const [bc, sc] = PG_COLS[sig];
    let num = 0, den = 0, n = 0;
    for (let j = c - S4_PG_WINDOW + 1; j <= c; j++) {
      const r = K.get(CAL[j]);
      if (!r) continue;
      const b = r[bc], s = r[sc];
      if (!Number.isFinite(b) || !Number.isFinite(s)) continue;
      num += b - s; den += b + s; n++;
    }
    return n >= S4_PG_WINDOW - 1 && den > 0 ? num / den : NaN;
  };
  const mcombos: { kind: Kind; H: number }[] = [{ kind: "W", H: S4_MKT_HORIZONS[0] }, { kind: "M", H: S4_MKT_HORIZONS[0] }, { kind: "M", H: S4_MKT_HORIZONS[1] }];
  console.log(`\n=== (b-2) 프로그램매매 시장 단위(코스피) → 069500 (${S4_SCAN_START}~${S4_SCAN_END}) ===`);
  console.log(`z = 학습 구간 시작부터 그 표본일까지 신호값 중 확장 백분위(앞선 유효 표본 ${S4_PG_MIN_PRIOR}개 미만이면 제외). OLS: 수익률 = a + b·(z − 0.5), t = b의 Newey-West. 상위−하위 = z ≥ ${f2(S4_PG_HI)} 평균 수익 − z ≤ ${f2(S4_PG_LO)} 평균 수익(%). 비용 = 상위/하위 표본 중 직전 표본과 상태가 달라진 비율 × 2 × 편도 비용(수수료+슬리피지, ETF 거래세 없음). 순차이 = 방향(b 부호) × (상위−하위) − 비용.`);
  console.log("| 신호 | 기간 | 표본일 수 | 기울기 b | t(NW) | 상위 표본 수 | 하위 표본 수 | 상위−하위 % | 비용 % | 방향 반영 순차이 % | 후보 |\n|---|---|---|---|---|---|---|---|---|---|---|");
  for (const sig of PG) for (const { kind, H } of mcombos) {
    const samples = (kind === "M" ? monthSamples : weekSamples).filter((d) => calIdx.get(d)! + 1 + H <= lastIdx);
    const vs: number[] = [], ys: number[] = [];
    for (const d of samples) { const c = calIdx.get(d)!, v = pgAt(sig, c), y = lvl[c + 1 + H] / lvl[c + 1] - 1; if (Number.isFinite(v) && Number.isFinite(y)) { vs.push(v); ys.push(y); } }
    const X: number[] = [], Y: number[] = [];
    for (let t = 0; t < vs.length; t++) {
      if (t < S4_PG_MIN_PRIOR) continue;
      let less = 0, eq = 0;
      for (let q = 0; q <= t; q++) { if (vs[q] < vs[t]) less++; else if (vs[q] === vs[t]) eq++; }
      X.push((less + 0.5 * eq) / (t + 1)); Y.push(ys[t]);
    }
    const L = 1;
    const { b, t } = olsSlopeNw(X.map((z) => z - 0.5), Y, L);
    const topIdx: number[] = [], botIdx: number[] = [];
    X.forEach((z, i) => { if (z >= S4_PG_HI) topIdx.push(i); else if (z <= S4_PG_LO) botIdx.push(i); });
    const sp = topIdx.length && botIdx.length ? (mean(topIdx.map((i) => Y[i])) - mean(botIdx.map((i) => Y[i]))) * 100 : NaN;
    const state = X.map((z) => (z >= S4_PG_HI ? 1 : z <= S4_PG_LO ? 0 : -1));
    let prev = -1, changes = 0, tb = 0;
    for (const s of state) { if (s < 0) continue; tb++; if (prev >= 0 && s !== prev) changes++; prev = s; }
    const cs = tb ? (changes / tb) * 2 * buyRate * 100 : NaN;
    const dir = Number.isFinite(b) ? (b >= 0 ? 1 : -1) : 1;
    const net = Number.isFinite(sp) && Number.isFinite(cs) ? dir * sp - cs : NaN;
    const cand = Number.isFinite(t) && Math.abs(t) >= SCAN_CANDIDATE_ABS_T && Number.isFinite(net) && net > 0;
    nRows++; if (cand) nCand++;
    const line = `| ${PG_LABEL[sig]} | ${kind === "M" ? "월간" : "주간"} ${H}일 | ${X.length} | ${f3(b)} | ${f2(t)} | ${topIdx.length} | ${botIdx.length} | ${f2(sp)} | ${f2(cs)} | ${f2(net)} | ${cand ? "후보" : ""} |`;
    console.log(line);
    if (Number.isFinite(t) && Math.abs(t) >= SCAN_CANDIDATE_ABS_T) big.push(`| 시장 | ${line.slice(2)}`);
  }
  console.log(`\n후보 표시 ${nCand}행 / 전체 ${nRows}행 (스캔 4회차 4-A, 신호 수 6개; 누적 스캔 행 288 + ${nRows} = ${288 + nRows})`);
  console.log(`\n=== (c) |t| ≥ ${SCAN_CANDIDATE_ABS_T} 행 목록 (${big.length}행) ===`);
  if (big.length) console.log(big.join("\n")); else console.log("없음");

  // =========== (b-3) 회귀 잔차 확인 (종목 단위 후보 행이 있을 때만) ===========
  if (candRows.length) {
    console.log(`\n=== (b-3) 기존 신호(VOL·H52·MOM·REV) 회귀 잔차 확인: 종목 단위 후보 ${candRows.length}행 ===\n| 유니버스 | 신호 | 기간 | 표본일 수 | 잔차 순위상관 평균 | t(NW) | |t| ≥ ${SCAN_CANDIDATE_ABS_T} 유지 |\n|---|---|---|---|---|---|---|`);
    for (const cr of candRows) {
      const samples = (cr.kind === "M" ? monthSamples : weekSamples).filter((d) => calIdx.get(d)! + 1 + cr.H <= lastIdx);
      const rhos: number[] = [];
      for (const d of samples) {
        const c = calIdx.get(d)!, dd = dataAt(cr.u, d);
        const rets = dd.list.map((s) => fwd(s, c, cr.H));
        const items: { v: number; r: number; e: number[] }[] = [];
        dd.list.forEach((s, k) => { const v = dd.vals[k * NS + cr.s], r = rets[k], e = [3, 4, 5, 6].map((q) => dd.vals[k * NS + q]); if (Number.isFinite(v) && Number.isFinite(r) && e.every(Number.isFinite)) items.push({ v, r, e }); });
        if (items.length < SCAN_MIN_CROSS_SECTION) continue;
        const rv = rank(items.map((x) => x.v)), cols = [0, 1, 2, 3].map((q) => rank(items.map((x) => x.e[q])));
        const res = olsResid(cols, rv);
        if (!res) continue;
        const rho = spearman(res, items.map((x) => x.r));
        if (Number.isFinite(rho)) rhos.push(rho);
      }
      const L = Math.max(1, Math.round(cr.H / (cr.kind === "M" ? SCAN_SPACING_MONTHLY_DAYS : SCAN_SPACING_WEEKLY_DAYS)));
      const t = rhos.length >= 3 ? nwT(rhos, L) : NaN;
      console.log(`| ${cr.u} | ${SIG_LABEL[SIGNALS[cr.s]]} | ${cr.kind === "M" ? "월간" : "주간"} ${cr.H}일 | ${rhos.length} | ${f3(mean(rhos))} | ${f2(t)} | ${Number.isFinite(t) && Math.abs(t) >= SCAN_CANDIDATE_ABS_T ? "유지" : "미달"} |`);
    }
    console.log("(신용잔고 C1·C2를 회귀 변수에 더한 잔차 t는 11-14 이후 별도 단계)");
  } else console.log("\n(b-3) 종목 단위 후보 행이 없어 회귀 잔차 확인은 하지 않는다.");

  // =========== (d) 상관 행렬 ===========
  for (const u of ["POOL", "MID"] as U[]) {
    console.log(`\n=== (d) 신호 간 상관 행렬 (월말 표본일 ${S4_SCAN_START}~${S4_SCAN_END}, ${u}, 스피어만 월 평균; 신용잔고 제외) ===`);
    const sumM = Array.from({ length: NS }, () => new Array<number>(NS).fill(0)), cntM = Array.from({ length: NS }, () => new Array<number>(NS).fill(0));
    for (const d of monthSamples) {
      const dd = dataAt(u, d);
      for (let a = 0; a < NS; a++) for (let b = a + 1; b < NS; b++) {
        const xa: number[] = [], xb: number[] = [];
        for (let k = 0; k < dd.list.length; k++) { const va = dd.vals[k * NS + a], vb = dd.vals[k * NS + b]; if (Number.isFinite(va) && Number.isFinite(vb)) { xa.push(va); xb.push(vb); } }
        if (xa.length < SCAN_MIN_CROSS_SECTION) continue;
        const r = spearman(xa, xb);
        if (Number.isFinite(r)) { sumM[a][b] += r; cntM[a][b]++; }
      }
    }
    console.log("| | " + SIGNALS.join(" | ") + " |\n|---|" + SIGNALS.map(() => "---").join("|") + "|");
    for (let a = 0; a < NS; a++) console.log(`| ${SIGNALS[a]} | ${SIGNALS.map((_, b) => (a === b ? "1.00" : (a < b ? (cntM[a][b] ? f2(sumM[a][b] / cntM[a][b]) : "-") : (cntM[b][a] ? f2(sumM[b][a] / cntM[b][a]) : "-")))).join(" | ")} |`);
    let minCnt = Infinity, maxCnt = 0;
    for (let a = 0; a < NS; a++) for (let b = a + 1; b < NS; b++) { minCnt = Math.min(minCnt, cntM[a][b]); maxCnt = Math.max(maxCnt, cntM[a][b]); }
    console.log(`(상관 계산 월 수: 쌍별 최소 ${minCnt}, 최대 ${maxCnt})`);
  }

  // =========== (e) 표본 수·결측 ===========
  console.log("\n=== (e) 표본 수·결측 ===");
  for (const u of ["POOL", "MID"] as U[]) {
    const dds = monthSamples.map((d) => dataAt(u, d));
    const tot = dds.reduce((a, x) => a + x.list.length, 0);
    const distinct = new Set<string>();
    for (const dd of dds) for (const s of dd.list) distinct.add(s.code);
    const noFlowMembers = dds.reduce((a, dd) => a + dd.list.filter((s) => !s.hasFlow).length, 0);
    console.log(`\n[${u}] 월간 표본일 ${monthSamples.length}개, 표본일당 평균 구성원 ${(tot / monthSamples.length).toFixed(1)}종목, 구간 내 서로 다른 종목 ${distinct.size}개, 월말 구성원-신호 쌍 ${tot}개 (체결강도 수집 목록에 없는 구성원 쌍 ${noFlowMembers}개 = ${f2((noFlowMembers / tot) * 100)}%)`);
    console.log("| 신호 | 결측 비율 % |\n|---|---|");
    for (let si = 0; si < NS; si++) { let miss = 0; for (const dd of dds) for (let k = 0; k < dd.list.length; k++) if (!Number.isFinite(dd.vals[k * NS + si])) miss++; console.log(`| ${SIG_LABEL[SIGNALS[si]]} | ${f2((miss / tot) * 100)} |`); }
  }
  const kDays = CAL.filter((d) => d >= S4_SCAN_START).length, kHave = CAL.filter((d) => d >= S4_SCAN_START && K.has(d)).length;
  console.log(`\n프로그램매매(코스피) 학습 구간 거래일 ${kDays}일 중 값이 있는 날 ${kHave}일`);
  console.log("\n조합별 표본일 수(예측 기간 청산일이 2016-12-31 이내인 표본일):");
  for (const { kind, H } of combos) console.log(`  ${kind === "M" ? "월간" : "주간"} ${H}일: ${(kind === "M" ? monthSamples : weekSamples).filter((d) => calIdx.get(d)! + 1 + H <= lastIdx).length}개`);
  console.log(`\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)} (069500 기준선·조정 이벤트용 읽기)`);
  console.log(`입력 정리본(Actions 캐시) 읽은 바이트 ${rd.bytes} B (${(rd.bytes / 1048576).toFixed(2)} MiB), Storage 다운로드 0(월말 시장 목록 등도 읽지 않음) | Supabase 쓴 행: 0 | 외부 요청 0 | 스캔 행 수 ${nRows}(누적 ${288 + nRows}) | 소요 ${((Date.now() - T0) / 60e3).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

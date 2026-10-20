/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건(Storage 다운로드 제외)] 신용잔고 신호(C1) 증분 확인 1단계(학습 구간만, 전략 백테스트 없음).
 * 사전 등록: research/credit-incremental-prereg.md (커밋 0214842, 정정 포함). 측정 방법은 스캔 3회차(decfccb)와 같다. 숫자와 표만 출력한다.
 * 2016-12-31을 넘는 가격·신용잔고 행은 읽은 직후 버린다.
 */
import { parquetReadObjects } from "hyparquet";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { applyAdjustmentsInPlace } from "@/lib/priceAdjustment";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET } from "@/lib/investorFlowConfig";
import {
  SCAN_START, SCAN_END, SCAN_SPACING_MONTHLY_DAYS, SCAN_CAP_EOK, SCAN_POOL_SIZE, SCAN_MIN_CROSS_SECTION, SCAN_MOM_LONG_DAYS, SCAN_MOM_SKIP_DAYS, SCAN_H52_DAYS,
  SCAN_H52_MIN_ROWS, SCAN_VOL_DAYS, SCAN_VOL_MIN_RETURNS,
} from "@/lib/signalScanConfig";
import { SCS_CREDIT_LAG_DAYS, SCS_CREDIT_CARRY_MAX_DAYS, SCS_CREDIT_CLEAN_PREFIX, SCS_FIRST_YEAR } from "@/lib/shortCreditScanConfig";
import { CI_HORIZONS, CI_GATE_HORIZON, CI_GATE_ABS_T, CI_MEDIAN_PERCENTILE, CI_GROUPS, CI_MIN_CELL, CI_CONST_VAR_EPS, CI_PIVOT_EPS } from "@/lib/creditIncrementalConfig";

const T0 = Date.now();
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "-");
const dbRead: Record<string, number> = {};
const dl = { creditBytes: 0, creditRows: 0, creditDropped: 0 };

interface S {
  code: string; idx: Map<string, number>; mcapRow: Float64Array; avgTvRow: Float64Array; closeA: Float64Array; CR: Float64Array; lastCr: Int32Array;
}
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
const groupOf = (i: number, n: number): number => Math.floor((i * CI_GROUPS) / n);
/** 평균순위(동점 평균)를 퍼센타일 (순위 − 0.5) ÷ m 으로 바꾼다. */
const pctRank = (v: number[]): number[] => rank(v).map((r) => (r - 0.5) / v.length);

/** y를 [1, X열들]에 최소제곱 회귀한 잔차. 피벗이 너무 작으면(특이) null. */
function olsResidual(y: number[], cols: number[][]): number[] | null {
  const n = y.length, k = cols.length + 1;
  const X: number[][] = Array.from({ length: n }, (_, i) => [1, ...cols.map((c) => c[i])]);
  const A: number[][] = Array.from({ length: k }, () => new Array<number>(k + 1).fill(0));
  for (let i = 0; i < n; i++) for (let a = 0; a < k; a++) { for (let b = 0; b < k; b++) A[a][b] += X[i][a] * X[i][b]; A[a][k] += X[i][a] * y[i]; }
  for (let p = 0; p < k; p++) {
    let piv = p;
    for (let r = p + 1; r < k; r++) if (Math.abs(A[r][p]) > Math.abs(A[piv][p])) piv = r;
    if (Math.abs(A[piv][p]) < CI_PIVOT_EPS) return null;
    [A[p], A[piv]] = [A[piv], A[p]];
    for (let r = 0; r < k; r++) { if (r === p) continue; const f = A[r][p] / A[p][p]; for (let c = p; c <= k; c++) A[r][c] -= f * A[p][c]; }
  }
  const beta = A.map((row, i) => row[k] / row[i]);
  return y.map((yi, i) => yi - X[i].reduce((s, x, a) => s + x * beta[a], 0));
}

async function main(): Promise<void> {
  console.log(`신용잔고 신호 증분 확인 1단계 시작(읽기 전용, 학습 구간만): ${new Date().toISOString()} (사전등록 0214842 이후)`);
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear());

  // ---- 신용잔고 정리본 (2009~2016, 달력에 없는 날짜는 아래에서 쓰이지 않음) ----
  type CRow = number;
  const creditBy = new Map<string, Map<string, CRow>>();
  for (let y = SCS_FIRST_YEAR; y <= Number(SCAN_END.slice(0, 4)); y++) {
    const { data, error } = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).download(`${SCS_CREDIT_CLEAN_PREFIX}/${y}.parquet`);
    if (error) { console.log(`${SCS_CREDIT_CLEAN_PREFIX}/${y}.parquet 없음`); continue; }
    const buf = await data.arrayBuffer();
    dl.creditBytes += buf.byteLength;
    for (const r of (await parquetReadObjects({ file: buf, columns: ["stock_code", "deal_date", "whol_loan_rmnd_rate"] })) as { stock_code: string; deal_date: string; whol_loan_rmnd_rate: number | null }[]) {
      dl.creditRows++;
      if (r.deal_date > SCAN_END) { dl.creditDropped++; continue; }
      let m = creditBy.get(r.stock_code);
      if (!m) { m = new Map(); creditBy.set(r.stock_code, m); }
      m.set(r.deal_date, r.whol_loan_rmnd_rate === null || r.whol_loan_rmnd_rate === undefined ? NaN : Number(r.whol_loan_rmnd_rate));
    }
  }
  console.log(`신용잔고 정리본(2009~2016, C1 열만): 종목 ${creditBy.size}개, ${dl.creditRows}행, 다운로드 ${dl.creditBytes} B (${(dl.creditBytes / 1048576).toFixed(2)} MiB), 2016-12-31 초과로 버린 행 ${dl.creditDropped}`);

  // ---- 가격: 2016-12-31 이후 행 버리고 수정주가 사본 ----
  interface Row0 { code: string; dates: string[]; close: Float64Array; mcap: Float64Array; avgTv: Float64Array }
  const rows0: Row0[] = [];
  const calSet = new Set<string>();
  let droppedRows = 0;
  for (const [code, rows] of series) {
    const kept = rows.filter((r) => r.tradeDate <= SCAN_END);
    droppedRows += rows.length - kept.length;
    series.delete(code);
    if (!kept.length) continue;
    const adj = kept.map((r) => ({ ...r }));
    const al = adjustments.get(code);
    if (al) applyAdjustmentsInPlace(adj, al);
    for (const r of kept) if (r.tradeDate >= "2010-01-01") calSet.add(r.tradeDate);
    rows0.push({ code, dates: kept.map((r) => r.tradeDate), close: Float64Array.from(adj.map((r) => r.closePrice)), mcap: Float64Array.from(kept.map((r) => r.marketCapEok)), avgTv: computeTrailingAvgTradingValue(adj, PIT_LIQUIDITY_LOOKBACK_DAYS) });
  }
  const CAL = [...calSet].sort();
  const nCal = CAL.length, lastIdx = nCal - 1;
  const calIdx = new Map(CAL.map((d, i) => [d, i]));
  console.log(`종목 ${rows0.length}개, 거래일 ${nCal}일 ${CAL[0]}~${CAL[lastIdx]}, 학습 구간 밖이라 버린 가격 행 ${droppedRows}`);
  const candidates = rows0.filter((r) => { for (let i = 1; i < r.dates.length; i++) if (r.dates[i] >= "2010-01-01" && r.mcap[i - 1] >= SCAN_CAP_EOK && r.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON) return true; return false; });
  console.log(`PIT 적격 이력이 있는 종목 ${candidates.length}개`);

  const stocks: S[] = candidates.map((r) => {
    const idx = new Map(r.dates.map((d, i) => [d, i]));
    const closeA = new Float64Array(nCal).fill(NaN), CR = new Float64Array(nCal).fill(NaN);
    const lastCr = new Int32Array(nCal).fill(-1);
    const cm = creditBy.get(r.code);
    let last = -1;
    for (let c = 0; c < nCal; c++) {
      const i = idx.get(CAL[c]);
      if (i !== undefined && r.close[i] > 0) closeA[c] = r.close[i];
      const cv = cm?.get(CAL[c]);
      if (cv !== undefined) { CR[c] = cv; last = c; }
      lastCr[c] = last;
    }
    return { code: r.code, idx, mcapRow: r.mcap, avgTvRow: r.avgTv, closeA, CR, lastCr };
  });
  stocks.sort((a, b) => (a.code < b.code ? -1 : 1));
  rows0.length = 0; creditBy.clear();

  // ---- 유니버스 ----
  const eligCache = new Map<string, { s: S; mcap: number }[]>();
  const elig = (d: string): { s: S; mcap: number }[] => {
    let e = eligCache.get(d);
    if (!e) {
      e = [];
      for (const s of stocks) {
        const i = s.idx.get(d);
        if (i === undefined || i < 1 || !(s.mcapRow[i - 1] >= SCAN_CAP_EOK) || !(s.avgTvRow[i] >= PIT_MIN_AVG_TRADING_VALUE_WON)) continue;
        e.push({ s, mcap: s.mcapRow[i] });
      }
      eligCache.set(d, e);
    }
    return e;
  };
  const universeAt = (u: U, d: string): S[] => {
    const sorted = [...elig(d)].sort((a, b) => b.mcap - a.mcap || (a.s.code < b.s.code ? -1 : 1)).map((x) => x.s);
    return u === "POOL" ? sorted.slice(0, SCAN_POOL_SIZE) : sorted.slice(SCAN_POOL_SIZE);
  };

  // ---- 신호 ----
  const c1At = (s: S, c: number): number => {
    const j = c - SCS_CREDIT_LAG_DAYS;
    if (j < 0) return NaN;
    const li = s.lastCr[j];
    return li >= 0 && j - li <= SCS_CREDIT_CARRY_MAX_DAYS ? s.CR[li] : NaN;
  };
  /** 표준편차 σ(60일 일수익률 표본, 수익률 40개 이상). NaN이면 결측. */
  const sigmaAt = (s: S, c: number): number => {
    if (c < SCAN_VOL_DAYS) return NaN;
    const cl = s.closeA;
    let n = 0, sum = 0, sum2 = 0;
    for (let j = c - SCAN_VOL_DAYS + 1; j <= c; j++) if (cl[j] > 0 && cl[j - 1] > 0) { const r = cl[j] / cl[j - 1] - 1; n++; sum += r; sum2 += r * r; }
    if (n < SCAN_VOL_MIN_RETURNS) return NaN;
    const m = sum / n;
    return Math.sqrt(Math.max((sum2 - n * m * m) / (n - 1), 0));
  };
  const h52At = (s: S, c: number): number => {
    const cl = s.closeA;
    if (c < SCAN_H52_DAYS - 1 || !(cl[c] > 0)) return NaN;
    let mx = 0, n = 0;
    for (let j = c - SCAN_H52_DAYS + 1; j <= c; j++) if (cl[j] > 0) { n++; if (cl[j] > mx) mx = cl[j]; }
    return n >= SCAN_H52_MIN_ROWS && mx > 0 ? cl[c] / mx : NaN;
  };
  const momAt = (s: S, c: number): number => {
    if (c < SCAN_MOM_LONG_DAYS) return NaN;
    const a = s.closeA[c - SCAN_MOM_SKIP_DAYS], b = s.closeA[c - SCAN_MOM_LONG_DAYS];
    return a > 0 && b > 0 ? a / b - 1 : NaN;
  };
  function fwd(s: S, c: number, H: number): number {
    const e = s.closeA[c + 1];
    if (!(e > 0)) return NaN;
    for (let j = c + 1 + H; j > c + 1; j--) { if (s.closeA[j] > 0) return s.closeA[j] / e - 1; }
    return 0;
  }

  const monthSamples: string[] = [];
  for (let k = 0; k + 1 < nCal; k++) if (CAL[k] >= SCAN_START && CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) monthSamples.push(CAL[k]);
  console.log(`월간 표본일 ${monthSamples.length}개(${monthSamples[0]}~${monthSamples[monthSamples.length - 1]})`);

  // ---- 측정 ----
  interface UAcc { rhoR: Record<number, number[]>; rhoRaw: Record<number, number[]>; nX: Record<number, number[]>; skipped: number; dropH52: number; dropMom: number; months: number; cell: number[][][]; diff: number[][] }
  const acc: Record<U, UAcc> = {} as Record<U, UAcc>;
  const emptyAcc = (): UAcc => ({ rhoR: { 21: [], 63: [] }, rhoRaw: { 21: [], 63: [] }, nX: { 21: [], 63: [] }, skipped: 0, dropH52: 0, dropMom: 0, months: 0, cell: Array.from({ length: CI_GROUPS }, () => Array.from({ length: CI_GROUPS }, () => [] as number[])), diff: Array.from({ length: CI_GROUPS }, () => [] as number[]) });
  for (const u of ["POOL", "MID"] as U[]) {
    const a = emptyAcc(); acc[u] = a;
    for (const d of monthSamples) {
      const c = calIdx.get(d)!;
      const list = universeAt(u, d);
      const X: { s: S; c1: number; sig: number; h52: number; mom: number }[] = [];
      for (const s of list) { const c1 = c1At(s, c), sig = sigmaAt(s, c); if (Number.isFinite(c1) && Number.isFinite(sig)) X.push({ s, c1, sig, h52: h52At(s, c), mom: momAt(s, c) }); }
      if (X.length < SCAN_MIN_CROSS_SECTION) continue;
      // 퍼센타일 순위(MOM·H52는 값이 있는 종목끼리 순위, 결측은 중앙 0.5)
      const pc1 = pctRank(X.map((x) => x.c1)), pvol = pctRank(X.map((x) => x.sig));
      const fill = (get: (x: (typeof X)[number]) => number): number[] => {
        const ids = X.map((x, i) => (Number.isFinite(get(x)) ? i : -1)).filter((i) => i >= 0);
        const out = new Array<number>(X.length).fill(CI_MEDIAN_PERCENTILE);
        if (ids.length) { const p = pctRank(ids.map((i) => get(X[i]))); ids.forEach((i, k) => { out[i] = p[k]; }); }
        return out;
      };
      const ph52 = fill((x) => x.h52), pmom = fill((x) => x.mom);
      const varOf = (v: number[]): number => sdev(v) ** 2;
      const cols: number[][] = [pvol];
      if (varOf(ph52) > CI_CONST_VAR_EPS) cols.push(ph52); else a.dropH52++;
      if (varOf(pmom) > CI_CONST_VAR_EPS) cols.push(pmom); else a.dropMom++;
      const res = olsResidual(pc1, cols);
      if (!res) { a.skipped++; continue; }
      a.months++;
      for (const H of CI_HORIZONS) {
        if (c + 1 + H > lastIdx) continue;
        const items: { r: number; c1: number; ret: number }[] = [];
        X.forEach((x, i) => { const ret = fwd(x.s, c, H); if (Number.isFinite(ret)) items.push({ r: res[i], c1: x.c1, ret }); });
        if (items.length < SCAN_MIN_CROSS_SECTION) continue;
        const rho = spearman(items.map((x) => x.r), items.map((x) => x.ret));
        const rhoRaw = spearman(items.map((x) => x.c1), items.map((x) => x.ret));
        if (Number.isFinite(rho)) { a.rhoR[H].push(rho); a.nX[H].push(items.length); }
        if (Number.isFinite(rhoRaw)) a.rhoRaw[H].push(rhoRaw);
      }
      // 이중 정렬 (63일)
      if (c + 1 + CI_GATE_HORIZON <= lastIdx) {
        const it = X.map((x) => ({ code: x.s.code, sig: x.sig, c1: x.c1, ret: fwd(x.s, c, CI_GATE_HORIZON) })).filter((x) => Number.isFinite(x.ret));
        if (it.length >= SCAN_MIN_CROSS_SECTION) {
          it.sort((p, q) => p.sig - q.sig || (p.code < q.code ? -1 : 1));
          const diffs: number[] = new Array(CI_GROUPS).fill(NaN);
          for (let g = 0; g < CI_GROUPS; g++) {
            const grp = it.filter((_, i) => groupOf(i, it.length) === g).sort((p, q) => p.c1 - q.c1 || (p.code < q.code ? -1 : 1));
            if (grp.length < CI_MIN_CELL * CI_GROUPS) continue;
            const m: number[] = [];
            for (let h = 0; h < CI_GROUPS; h++) { const cell = grp.filter((_, i) => groupOf(i, grp.length) === h).map((x) => x.ret); m.push(mean(cell)); a.cell[g][h].push(mean(cell)); }
            diffs[g] = m[0] - m[CI_GROUPS - 1];
            a.diff[g].push(diffs[g]);
          }
        }
      }
    }
    console.log(`  완료: ${u} (${((Date.now() - T0) / 60e3).toFixed(1)}분)`);
  }

  // ---- 보고 ----
  console.log("\n=== 1단계: C1R(C1 퍼센타일 − VOL·H52·MOM 퍼센타일 회귀 잔차)과 다음 H거래일 수익률의 월별 순위상관 (2010-04-01~2016-12-31) ===");
  console.log("t = Newey-West(시차 L = max(1, round(H ÷ 21)) 월 표본 단위: 월21 L=1, 월63 L=3). C1 원신호는 참고(같은 횡단면).");
  console.log("| 유니버스 | 기간 | 사용 월 수 | 평균 종목 수 | C1R 순위상관 평균 | 표준편차 | t(NW) | 양수 비율 % | (참고) C1 원신호 순위상관 평균 | (참고) C1 t(NW) |\n|---|---|---|---|---|---|---|---|---|---|");
  const gate: Record<U, { m: number; t: number }> = { POOL: { m: NaN, t: NaN }, MID: { m: NaN, t: NaN } };
  for (const u of ["POOL", "MID"] as U[]) for (const H of CI_HORIZONS) {
    const a = acc[u], x = a.rhoR[H], L = Math.max(1, Math.round(H / SCAN_SPACING_MONTHLY_DAYS));
    const m = mean(x), t = x.length >= 3 ? nwT(x, L) : NaN;
    const mr = mean(a.rhoRaw[H]), tr = a.rhoRaw[H].length >= 3 ? nwT(a.rhoRaw[H], L) : NaN;
    if (H === CI_GATE_HORIZON) gate[u] = { m, t };
    console.log(`| ${u} | 월${H} | ${x.length} | ${f2(mean(a.nX[H]))} | ${f3(m)} | ${f3(sdev(x))} | ${f2(t)} | ${f2((x.filter((v) => v > 0).length / Math.max(x.length, 1)) * 100)} | ${f3(mr)} | ${f2(tr)} |`);
  }
  console.log(`회귀를 건너뛴 달(특이): POOL ${acc.POOL.skipped}, MID ${acc.MID.skipped} | 회귀에서 변수를 뺀 달: POOL H52 ${acc.POOL.dropH52}·MOM ${acc.POOL.dropMom}, MID H52 ${acc.MID.dropH52}·MOM ${acc.MID.dropMom} | 회귀한 달 POOL ${acc.POOL.months}, MID ${acc.MID.months}`);

  console.log("\n=== 이중 정렬: VOL 3등분(σ 오름차순: 저변동/중변동/고변동) 안에서 C1 3등분(낮음/중간/높음)의 다음 63거래일 평균 수익률 % ===");
  console.log("| 유니버스 | VOL 그룹 | 월 수 | C1 낮음 | C1 중간 | C1 높음 | 낮음 − 높음(월 평균) |\n|---|---|---|---|---|---|---|");
  const vname = ["저변동", "중변동", "고변동"];
  for (const u of ["POOL", "MID"] as U[]) {
    const a = acc[u];
    for (let g = 0; g < CI_GROUPS; g++) console.log(`| ${u} | ${vname[g]} | ${a.diff[g].length} | ${f2(mean(a.cell[g][0]) * 100)} | ${f2(mean(a.cell[g][1]) * 100)} | ${f2(mean(a.cell[g][2]) * 100)} | ${f2(mean(a.diff[g]) * 100)} |`);
    console.log(`| ${u} | 세 VOL 그룹 평균 | - | ${f2(mean([0, 1, 2].map((g) => mean(a.cell[g][0]))) * 100)} | ${f2(mean([0, 1, 2].map((g) => mean(a.cell[g][1]))) * 100)} | ${f2(mean([0, 1, 2].map((g) => mean(a.cell[g][2]))) * 100)} | ${f2(mean([0, 1, 2].map((g) => mean(a.diff[g]))) * 100)} |`);
  }

  const pass = (["POOL", "MID"] as U[]).map((u) => ({ u, ok: gate[u].m < 0 && Math.abs(gate[u].t) >= CI_GATE_ABS_T }));
  console.log(`\n=== 게이트 (C1R 월63 순위상관 평균 < 0 그리고 |t| ≥ ${CI_GATE_ABS_T}) ===`);
  console.log("| 유니버스 | 순위상관 평균 | t(NW) | 조건 |\n|---|---|---|---|");
  for (const p of pass) console.log(`| ${p.u} | ${f3(gate[p.u].m)} | ${f2(gate[p.u].t)} | ${p.ok ? "충족" : "미충족"} |`);
  console.log(`게이트 결과: ${pass.every((p) => p.ok) ? "통과 (2단계 실행 대상)" : "미통과 (2단계 실행하지 않음)"}`);

  console.log(`\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Storage 다운로드: 신용잔고 정리본 ${dl.creditRows}행 ${dl.creditBytes} B (${(dl.creditBytes / 1048576).toFixed(2)} MiB) | Supabase 쓴 행: 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60e3).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

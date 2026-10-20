/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건(Storage 다운로드 제외)] 신호 스캔 3회차(공매도·신용잔고, 학습 구간만, 전략 백테스트 없음): 신호 7개, 유니버스 POOL·MID.
 * 사전 등록: research/signal-scan-short-credit-prereg.md (커밋 decfccb8). 측정 방법은 research/signal-scan-prereg.md(19d3eeaf)와 같다. 숫자와 표만 출력한다.
 * 2016-12-31을 넘는 가격·수급·공매도·신용잔고 행은 읽은 직후 버린다. stnd_vol_smtn·stnd_tr_pbmn_smtn 열은 읽지도 쓰지도 않는다.
 */
import { parquetReadObjects } from "hyparquet";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { applyAdjustmentsInPlace } from "@/lib/priceAdjustment";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET, INVESTOR_FLOW_STOCK_FIRST_YEAR } from "@/lib/investorFlowConfig";
import { FLOW_TILT_CLEAN_PREFIX } from "@/lib/foreignFlowTiltConfig";
import {
  SCAN_START, SCAN_END, SCAN_HORIZONS, SCAN_SPACING_MONTHLY_DAYS, SCAN_SPACING_WEEKLY_DAYS, SCAN_CAP_EOK, SCAN_POOL_SIZE, SCAN_MIN_CROSS_SECTION,
  SCAN_CANDIDATE_ABS_T, SCAN_FLOW_WINDOWS, SCAN_FLOW_MIN_PRICE_DAY_RATIO, SCAN_MOM_LONG_DAYS, SCAN_MOM_SKIP_DAYS, SCAN_H52_DAYS, SCAN_H52_MIN_ROWS, SCAN_VOL_DAYS,
  SCAN_VOL_MIN_RETURNS,
} from "@/lib/signalScanConfig";
import {
  SCS_SHORT_LAG_DAYS, SCS_CREDIT_LAG_DAYS, SCS_S1_DAYS, SCS_S2_DAYS, SCS_S3_PRIOR_DAYS, SCS_CREDIT_CARRY_MAX_DAYS, SCS_C2_DAYS, SCS_MIN_PRICE_DAY_RATIO,
  SCS_SHORT_CLEAN_PREFIX, SCS_CREDIT_CLEAN_PREFIX, SCS_FIRST_YEAR,
} from "@/lib/shortCreditScanConfig";

const T0 = Date.now();
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "-");
const bucket = (): ReturnType<typeof supabaseAdmin.storage.from> => supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET);
const MS_DAY = 86_400_000;
const dbRead: Record<string, number> = {};
const dl = { flowBytes: 0, flowRows: 0, shortBytes: 0, shortRows: 0, creditBytes: 0, creditRows: 0, shortDropped: 0, creditDropped: 0 };

const SIGNALS = ["S1", "S2", "S3", "C1", "C2", "C3", "C4", "F5", "F20", "F60", "MOM", "REV", "VOL", "H52"] as const;
const NS = SIGNALS.length;
const NT = 7; // 검정 행에 쓰는 새 신호 수(앞 7개)
const SIG_LABEL: Record<(typeof SIGNALS)[number], string> = {
  S1: "공매도 비중 20일", S2: "공매도 비중 60일", S3: "공매도 비중 변화(S1−직전 60일)", C1: "신용잔고율", C2: "신용잔고 20일 증감률", C3: "시총 대비 신용잔고 금액", C4: "대주잔고율",
  F5: "외국인 강도 5일", F20: "외국인 강도 20일", F60: "외국인 강도 60일", MOM: "12-1개월 모멘텀", REV: "1개월 반전", VOL: "60일 변동성(낮을수록)", H52: "52주 고가 대비",
};

interface S {
  code: string; idx: Map<string, number>; mcapRow: Float64Array; avgTvRow: Float64Array; sharesRow: Float64Array;
  closeA: Float64Array; mcapA: Float64Array; PF: Float64Array; PD: Float64Array; VP: Float64Array; SP: Float64Array; hasFlow: boolean; hasShort: boolean;
  SQ: Float64Array; CR: Float64Array; CQ: Float64Array; CA: Float64Array; CS: Float64Array; lastCr: Int32Array; hasCredit: boolean;
}
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
const groupOf = (i: number, n: number): number => Math.floor((i * 3) / n);

async function readClean(prefix: string, firstYear: number, columns: string[], onRow: (r: Record<string, unknown>) => void, kind: "flow" | "short" | "credit"): Promise<void> {
  for (let y = firstYear; y <= Number(SCAN_END.slice(0, 4)); y++) {
    const { data, error } = await bucket().download(`${prefix}/${y}.parquet`);
    if (error) { console.log(`${prefix}/${y}.parquet 없음`); continue; }
    const buf = await data.arrayBuffer();
    dl[`${kind}Bytes`] += buf.byteLength;
    for (const r of (await parquetReadObjects({ file: buf, columns })) as Record<string, unknown>[]) { onRow(r); dl[`${kind}Rows`]++; }
  }
}

async function main(): Promise<void> {
  console.log(`신호 스캔 3회차(공매도·신용잔고) 시작(읽기 전용, 학습 구간만): ${new Date().toISOString()} (사전등록 decfccb8 이후) — 스캔 3회차(신호 수 ${NT}개)`);
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear());

  // ---- 수급 정리본 (외국인만, 2010~2016) ----
  const flowBy = new Map<string, Map<string, number>>();
  await readClean(FLOW_TILT_CLEAN_PREFIX, INVESTOR_FLOW_STOCK_FIRST_YEAR, ["stock_code", "trade_date", "frgn_ntby_amt"], (r) => {
    const d = r.trade_date as string;
    if (d > SCAN_END) return;
    let m = flowBy.get(r.stock_code as string);
    if (!m) { m = new Map(); flowBy.set(r.stock_code as string, m); }
    m.set(d, (r.frgn_ntby_amt as number | null) ?? 0);
  }, "flow");
  console.log(`수급 정리본(외국인, 2010~2016): 종목 ${flowBy.size}개, ${dl.flowRows}행, 다운로드 ${dl.flowBytes} B (${(dl.flowBytes / 1048576).toFixed(2)} MiB)`);
  // ---- 공매도·신용잔고 정리본 (2009~2016; 달력에 없는 날짜는 아래에서 버림) ----
  const shortBy = new Map<string, Map<string, number>>();
  await readClean(SCS_SHORT_CLEAN_PREFIX, SCS_FIRST_YEAR, ["stock_code", "trade_date", "ssts_cntg_qty"], (r) => {
    const d = r.trade_date as string;
    if (d > SCAN_END) { dl.shortDropped++; return; }
    let m = shortBy.get(r.stock_code as string);
    if (!m) { m = new Map(); shortBy.set(r.stock_code as string, m); }
    m.set(d, (r.ssts_cntg_qty as number | null) ?? 0);
  }, "short");
  console.log(`공매도 정리본(2009~2016): 종목 ${shortBy.size}개, ${dl.shortRows}행, 다운로드 ${dl.shortBytes} B (${(dl.shortBytes / 1048576).toFixed(2)} MiB), 2016-12-31 초과로 버린 행 ${dl.shortDropped}`);
  type CR = [number, number, number, number];
  const creditBy = new Map<string, Map<string, CR>>();
  await readClean(SCS_CREDIT_CLEAN_PREFIX, SCS_FIRST_YEAR, ["stock_code", "deal_date", "whol_loan_rmnd_stcn", "whol_loan_rmnd_amt", "whol_loan_rmnd_rate", "whol_stln_rmnd_stcn"], (r) => {
    const d = r.deal_date as string;
    if (d > SCAN_END) { dl.creditDropped++; return; }
    let m = creditBy.get(r.stock_code as string);
    if (!m) { m = new Map(); creditBy.set(r.stock_code as string, m); }
    const n = (v: unknown): number => (v === null || v === undefined ? NaN : Number(v));
    m.set(d, [n(r.whol_loan_rmnd_stcn), n(r.whol_loan_rmnd_amt), n(r.whol_loan_rmnd_rate), n(r.whol_stln_rmnd_stcn)]);
  }, "credit");
  console.log(`신용잔고 정리본(2009~2016): 종목 ${creditBy.size}개, ${dl.creditRows}행, 다운로드 ${dl.creditBytes} B (${(dl.creditBytes / 1048576).toFixed(2)} MiB), 2016-12-31 초과로 버린 행 ${dl.creditDropped}`);

  // ---- 가격: 2016-12-31 이후 행 버리고 수정주가 사본 ----
  interface Row0 { code: string; dates: string[]; close: Float64Array; mcap: Float64Array; avgTv: Float64Array; vol: Float64Array; shares: Float64Array }
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
    rows0.push({ code, dates: kept.map((r) => r.tradeDate), close: Float64Array.from(adj.map((r) => r.closePrice)), mcap: Float64Array.from(kept.map((r) => r.marketCapEok)), avgTv: computeTrailingAvgTradingValue(adj, PIT_LIQUIDITY_LOOKBACK_DAYS), vol: Float64Array.from(kept.map((r) => r.volume)), shares: Float64Array.from(kept.map((r) => r.listedShares)) });
  }
  const CAL = [...calSet].sort();
  const nCal = CAL.length, lastIdx = nCal - 1;
  const calIdx = new Map(CAL.map((d, i) => [d, i]));
  console.log(`종목 ${rows0.length}개, 거래일 ${nCal}일 ${CAL[0]}~${CAL[lastIdx]}, 학습 구간 밖이라 버린 가격 행 ${droppedRows}`);

  // ---- 후보 종목(한 번이라도 PIT 적격) ----
  const candidates = rows0.filter((r) => { for (let i = 1; i < r.dates.length; i++) if (r.dates[i] >= "2010-01-01" && r.mcap[i - 1] >= SCAN_CAP_EOK && r.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON) return true; return false; });
  console.log(`PIT 적격 이력이 있는 종목 ${candidates.length}개`);

  // ---- 종목 구조 ----
  const carried = { emptyDays: 0, carriedDays: 0, missingDays: 0, priceDays: 0, shortNoRowPriceDays: 0 };
  const stocks: S[] = candidates.map((r) => {
    const idx = new Map(r.dates.map((d, i) => [d, i]));
    const closeA = new Float64Array(nCal).fill(NaN), mcapA = new Float64Array(nCal).fill(NaN);
    const PF = new Float64Array(nCal + 1), PD = new Float64Array(nCal + 1), VP = new Float64Array(nCal + 1), SP = new Float64Array(nCal + 1);
    const SQ = new Float64Array(nCal).fill(NaN), CR = new Float64Array(nCal).fill(NaN), CQ = new Float64Array(nCal).fill(NaN), CA = new Float64Array(nCal).fill(NaN), CS = new Float64Array(nCal).fill(NaN);
    const lastCr = new Int32Array(nCal).fill(-1);
    const fm = flowBy.get(r.code), sm = shortBy.get(r.code), cm = creditBy.get(r.code);
    let last = -1;
    for (let c = 0; c < nCal; c++) {
      const i = idx.get(CAL[c]);
      let f = 0, pd = 0, vp = 0, sp = 0;
      if (i !== undefined) {
        if (r.close[i] > 0) { closeA[c] = r.close[i]; pd = 1; }
        mcapA[c] = r.mcap[i];
        f = fm?.get(CAL[c]) ?? 0;
        if (pd) vp = r.vol[i] > 0 ? r.vol[i] : 0;
        const q = sm?.get(CAL[c]);
        if (q !== undefined) { SQ[c] = q; if (pd) sp = q; }
        else if (pd) carried.shortNoRowPriceDays++;
      }
      PF[c + 1] = PF[c] + f; PD[c + 1] = PD[c] + pd; VP[c + 1] = VP[c] + vp; SP[c + 1] = SP[c] + sp;
      const cv = cm?.get(CAL[c]);
      if (cv) { CQ[c] = cv[0]; CA[c] = cv[1]; CR[c] = cv[2]; CS[c] = cv[3]; last = c; }
      lastCr[c] = last;
      if (pd) {
        carried.priceDays++;
        if (!cv) { carried.emptyDays++; if (last >= 0 && c - last <= SCS_CREDIT_CARRY_MAX_DAYS) carried.carriedDays++; else carried.missingDays++; }
      }
    }
    return { code: r.code, idx, mcapRow: r.mcap, avgTvRow: r.avgTv, sharesRow: r.shares, closeA, mcapA, PF, PD, VP, SP, hasFlow: !!fm, hasShort: !!sm, SQ, CR, CQ, CA, CS, lastCr, hasCredit: !!cm };
  });
  stocks.sort((a, b) => (a.code < b.code ? -1 : 1));
  rows0.length = 0;
  shortBy.clear(); creditBy.clear(); flowBy.clear();

  // ---- 유니버스 ----
  const eligibleAt = (d: string): { s: S; mcap: number }[] => {
    const out: { s: S; mcap: number }[] = [];
    for (const s of stocks) {
      const i = s.idx.get(d);
      if (i === undefined || i < 1 || !(s.mcapRow[i - 1] >= SCAN_CAP_EOK) || !(s.avgTvRow[i] >= PIT_MIN_AVG_TRADING_VALUE_WON)) continue;
      out.push({ s, mcap: s.mcapRow[i] });
    }
    return out;
  };
  const eligCache = new Map<string, { s: S; mcap: number }[]>();
  const elig = (d: string): { s: S; mcap: number }[] => { let e = eligCache.get(d); if (!e) { e = eligibleAt(d); eligCache.set(d, e); } return e; };
  const universeAt = (u: U, d: string): S[] => {
    const sorted = [...elig(d)].sort((a, b) => b.mcap - a.mcap || (a.s.code < b.s.code ? -1 : 1)).map((x) => x.s);
    return u === "POOL" ? sorted.slice(0, SCAN_POOL_SIZE) : sorted.slice(SCAN_POOL_SIZE);
  };

  // ---- 신호 계산 ----
  const minDays = (w: number): number => Math.ceil(w * SCAN_FLOW_MIN_PRICE_DAY_RATIO);
  const carryIdx = (s: S, j: number): number => {
    if (j < 0) return -1;
    const li = s.lastCr[j];
    return li >= 0 && j - li <= SCS_CREDIT_CARRY_MAX_DAYS ? li : -1;
  };
  /** CAL 인덱스 [lo, hi] 창의 공매도 수량 합 ÷ 거래량 합. 창이 범위 밖이거나 주가 있는 날이 모자라거나 거래량 합이 0이면 NaN. */
  const shortRatio = (s: S, lo: number, hi: number): number => {
    if (lo < 0 || hi >= nCal) return NaN;
    const w = hi - lo + 1;
    if (s.PD[hi + 1] - s.PD[lo] < Math.ceil(w * SCS_MIN_PRICE_DAY_RATIO)) return NaN;
    const vol = s.VP[hi + 1] - s.VP[lo];
    return vol > 0 ? (s.SP[hi + 1] - s.SP[lo]) / vol : NaN;
  };
  function signalsAt(s: S, c: number, out: Float64Array, off: number): void {
    out.fill(NaN, off, off + NS);
    const mc = s.mcapA[c];
    // 공매도 (신호일 1거래일 전까지)
    const e = c - SCS_SHORT_LAG_DAYS;
    const s1 = shortRatio(s, e - SCS_S1_DAYS + 1, e);
    out[off + 0] = s1;
    out[off + 1] = shortRatio(s, e - SCS_S2_DAYS + 1, e);
    const prior = shortRatio(s, e - SCS_S1_DAYS - SCS_S3_PRIOR_DAYS + 1, e - SCS_S1_DAYS);
    if (Number.isFinite(s1) && Number.isFinite(prior)) out[off + 2] = s1 - prior;
    // 신용잔고·대주잔고 (deal_date가 신호일 2거래일 전까지, 빈 날은 직전 값을 최대 5거래일 이어 씀)
    const j = c - SCS_CREDIT_LAG_DAYS;
    const k = carryIdx(s, j);
    if (k >= 0) {
      out[off + 3] = s.CR[k];
      const k2 = carryIdx(s, j - SCS_C2_DAYS);
      if (k2 >= 0 && s.CQ[k2] > 0 && Number.isFinite(s.CQ[k])) out[off + 4] = s.CQ[k] / s.CQ[k2] - 1;
      if (mc > 0 && Number.isFinite(s.CA[k])) out[off + 5] = s.CA[k] / mc;
      const i = s.idx.get(CAL[c]);
      if (i !== undefined && s.sharesRow[i] > 0 && Number.isFinite(s.CS[k])) out[off + 6] = s.CS[k] / s.sharesRow[i];
    }
    // 기존 신호(행렬용)
    const flow = (w: number): number => {
      if (!s.hasFlow || c - w + 1 < 0 || !(mc > 0)) return NaN;
      if (s.PD[c + 1] - s.PD[c - w + 1] < minDays(w)) return NaN;
      return (s.PF[c + 1] - s.PF[c - w + 1]) / mc;
    };
    const W = SCAN_FLOW_WINDOWS;
    out[off + 7] = flow(W.F[0]); out[off + 8] = flow(W.F[1]); out[off + 9] = flow(W.F[2]);
    const cl = s.closeA;
    if (c >= SCAN_MOM_LONG_DAYS) { const a = cl[c - SCAN_MOM_SKIP_DAYS], b = cl[c - SCAN_MOM_LONG_DAYS]; if (a > 0 && b > 0) out[off + 10] = a / b - 1; }
    if (c >= SCAN_MOM_SKIP_DAYS) { const a = cl[c], b = cl[c - SCAN_MOM_SKIP_DAYS]; if (a > 0 && b > 0) out[off + 11] = -(a / b - 1); }
    if (c >= SCAN_VOL_DAYS) {
      let n = 0, sum = 0, sum2 = 0;
      for (let jj = c - SCAN_VOL_DAYS + 1; jj <= c; jj++) if (cl[jj] > 0 && cl[jj - 1] > 0) { const r = cl[jj] / cl[jj - 1] - 1; n++; sum += r; sum2 += r * r; }
      if (n >= SCAN_VOL_MIN_RETURNS) { const m = sum / n; out[off + 12] = -Math.sqrt(Math.max((sum2 - n * m * m) / (n - 1), 0)); }
    }
    if (c >= SCAN_H52_DAYS - 1 && cl[c] > 0) {
      let mx = 0, n = 0;
      for (let jj = c - SCAN_H52_DAYS + 1; jj <= c; jj++) if (cl[jj] > 0) { n++; if (cl[jj] > mx) mx = cl[jj]; }
      if (n >= SCAN_H52_MIN_ROWS && mx > 0) out[off + 13] = cl[c] / mx;
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
      const exec = CAL[c + H + 1];
      const unit = buyRate + sellRate(exec);
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

  // ---- (b) 표 ----
  console.log("\n=== (b) 신호 × 기간 × 유니버스 (2010-04-01~2016-12-31) ===");
  console.log("순위상관 = 표본일별 횡단면 스피어만의 평균, t = Newey-West, 상위−하위·비용·순차이는 %(예측 기간 수익률 기준). 순차이 = 방향(순위상관 평균의 부호) × (상위−하위) − 비용.");
  let nCand = 0, nRows = 0;
  const big: string[] = [];
  for (const u of ["POOL", "MID"] as U[]) {
    console.log(`\n[유니버스 ${u === "POOL" ? "POOL(PIT 시총 상위 100)" : "MID(PIT 유니버스 − 상위 100)"}]`);
    console.log("| 신호 | 기간 | 표본일 수(상관) | 평균 종목 수 | 순위상관 평균 | 표준편차 | t(NW) | 양수 비율 % | 상위−하위 % | 교체 비용 % | 방향 반영 순차이 % | 후보 |\n|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (let si = 0; si < NT; si++) for (const { kind, H } of combos) {
      const r = results.find((x) => x.u === u && x.s === si && x.kind === kind && x.H === H)!;
      const m = mean(r.rho), L = Math.max(1, Math.round(H / (kind === "M" ? SCAN_SPACING_MONTHLY_DAYS : SCAN_SPACING_WEEKLY_DAYS)));
      const t = r.rho.length >= 3 ? nwT(r.rho, L) : NaN;
      const dir = m >= 0 ? 1 : -1;
      const sp = mean(r.spread) * 100, cs = mean(r.cost) * 100;
      const net = r.spread.length && r.cost.length ? dir * sp - cs : NaN;
      const cand = Number.isFinite(t) && Math.abs(t) >= SCAN_CANDIDATE_ABS_T && Number.isFinite(net) && net > 0;
      nRows++; if (cand) nCand++;
      const line = `| ${SIG_LABEL[SIGNALS[si]]} | ${kind === "M" ? "월간" : "주간"} ${H}일 | ${r.rho.length} | ${f2(r.avgN)} | ${f3(m)} | ${f3(sdev(r.rho))} | ${f2(t)} | ${f2((r.rho.filter((x) => x > 0).length / Math.max(r.rho.length, 1)) * 100)} | ${r.spread.length ? f2(sp) : "-"} | ${r.cost.length ? f2(cs) : "-"} | ${f2(net)} | ${cand ? "후보" : ""} |`;
      console.log(line);
      if (Number.isFinite(t) && Math.abs(t) >= SCAN_CANDIDATE_ABS_T) big.push(`| ${u} | ${line.slice(2)}`);
    }
  }
  console.log(`\n후보 표시 ${nCand}행 / 전체 ${nRows}행 (스캔 3회차, 신호 수 ${NT}개)`);
  console.log(`\n=== (c) |t| ≥ ${SCAN_CANDIDATE_ABS_T} 행 목록 (${big.length}행) ===`);
  if (big.length) console.log("| 유니버스 | 신호 | 기간 | 표본일 수(상관) | 평균 종목 수 | 순위상관 평균 | 표준편차 | t(NW) | 양수 비율 % | 상위−하위 % | 교체 비용 % | 방향 반영 순차이 % | 후보 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n" + big.join("\n"));
  else console.log("없음");

  // ---- (d) 상관 행렬 (월말, POOL·MID) ----
  for (const u of ["POOL", "MID"] as U[]) {
    console.log(`\n=== (d) 신호 간 상관 행렬 (월말 표본일 2010-04~2016-12, ${u}, 스피어만 월 평균) ===`);
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

  // ---- (e) 표본 수·결측·공매도 0 비율 ----
  console.log("\n=== (e) 표본 수·결측 ===");
  const zeroByYear: Record<U, Map<string, { z: number; n: number }>> = { POOL: new Map(), MID: new Map() };
  let carriedSamples = 0, carriedSampleChecks = 0;
  for (const u of ["POOL", "MID"] as U[]) {
    const dds = monthSamples.map((d) => dataAt(u, d));
    const tot = dds.reduce((a, x) => a + x.list.length, 0);
    const distinct = new Set<string>();
    for (const dd of dds) for (const s of dd.list) distinct.add(s.code);
    console.log(`\n[${u}] 월간 표본일 ${monthSamples.length}개, 표본일당 평균 구성원 ${(tot / monthSamples.length).toFixed(1)}종목, 구간 내 서로 다른 종목 ${distinct.size}개, 월말 구성원-신호 쌍 ${tot}개`);
    console.log("| 신호 | 결측 비율 % |\n|---|---|");
    for (let si = 0; si < NS; si++) { let miss = 0; for (const dd of dds) for (let k = 0; k < dd.list.length; k++) if (!Number.isFinite(dd.vals[k * NS + si])) miss++; console.log(`| ${SIG_LABEL[SIGNALS[si]]} | ${f2((miss / tot) * 100)} |`); }
    monthSamples.forEach((d, mi) => {
      const c = calIdx.get(d)!, y = d.slice(0, 4);
      for (const s of dds[mi].list) {
        const q = s.SQ[c];
        if (Number.isFinite(q)) { const e = zeroByYear[u].get(y) ?? { z: 0, n: 0 }; e.n++; if (q === 0) e.z++; zeroByYear[u].set(y, e); }
        const j = c - SCS_CREDIT_LAG_DAYS;
        if (s.hasCredit && j >= 0 && s.closeA[j] > 0) { carriedSampleChecks++; if (s.lastCr[j] !== j && carryIdx(s, j) >= 0) carriedSamples++; }
      }
    });
  }
  console.log("\n공매도 0인 종목-일 비율(연도별, 월간 표본일 구성원이 그날 가진 공매도 행 중 체결수량 0 비율)\n| 연도 | POOL 행 | POOL 0 행 | POOL 비율 % | MID 행 | MID 0 행 | MID 비율 % |\n|---|---|---|---|---|---|---|");
  for (let y = 2010; y <= 2016; y++) {
    const a = zeroByYear.POOL.get(String(y)) ?? { z: 0, n: 0 }, b = zeroByYear.MID.get(String(y)) ?? { z: 0, n: 0 };
    console.log(`| ${y} | ${a.n} | ${a.z} | ${f2((a.z / Math.max(a.n, 1)) * 100)} | ${b.n} | ${b.z} | ${f2((b.z / Math.max(b.n, 1)) * 100)} |`);
  }
  const allZero = new Map<string, { z: number; n: number }>();
  for (const s of stocks) for (let c = 0; c < nCal; c++) { const q = s.SQ[c]; if (!Number.isFinite(q)) continue; const y = CAL[c].slice(0, 4); const e = allZero.get(y) ?? { z: 0, n: 0 }; e.n++; if (q === 0) e.z++; allZero.set(y, e); }
  console.log("\n공매도 0인 종목-일 비율(연도별, 후보 종목 전체의 정리본 공매도 행 기준; 참고)\n| 연도 | 행 | 0 행 | 비율 % |\n|---|---|---|---|");
  for (const y of [...allZero.keys()].sort()) { const e = allZero.get(y)!; console.log(`| ${y} | ${e.n} | ${e.z} | ${f2((e.z / e.n) * 100)} |`); }
  console.log(`\n신용잔고 이어 쓰기: 후보 종목 ${stocks.length}개 × 2010-01-04~2016-12-30 기준, 주가 있는 종목-일 ${carried.priceDays}개 중 신용잔고 행이 없는 날 ${carried.emptyDays}개(${f2((carried.emptyDays / carried.priceDays) * 100)}%) — 직전 값 이어 쓰기(5거래일 이내) ${carried.carriedDays}개, 5거래일 초과 또는 이전 행 없음으로 결측 ${carried.missingDays}개`);
  console.log(`월간 표본일 신호에서 j = 신호일 2거래일 전에 이어 쓴 (종목, 표본일) 쌍 ${carriedSamples}개 / 신용잔고가 있는 종목의 (종목, 표본일) 쌍 ${carriedSampleChecks}개 (POOL+MID 합)`);
  console.log(`주가 행이 있는데 공매도 행이 없는 종목-일(공매도 0으로 합산) ${carried.shortNoRowPriceDays}개`);
  console.log("\n조합별 표본일 수(예측 기간 청산일이 2016-12-31 이내인 표본일):");
  for (const { kind, H } of combos) console.log(`  ${kind === "M" ? "월간" : "주간"} ${H}일: ${(kind === "M" ? monthSamples : weekSamples).filter((d) => calIdx.get(d)! + 1 + H <= lastIdx).length}개`);
  console.log(`\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Storage 다운로드: 수급 정리본 ${dl.flowRows}행 ${dl.flowBytes} B, 공매도 정리본 ${dl.shortRows}행 ${dl.shortBytes} B, 신용잔고 정리본 ${dl.creditRows}행 ${dl.creditBytes} B | 합계 ${dl.flowBytes + dl.shortBytes + dl.creditBytes} B (${((dl.flowBytes + dl.shortBytes + dl.creditBytes) / 1048576).toFixed(2)} MiB)`);
  console.log(`Supabase 쓴 행: 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60e3).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

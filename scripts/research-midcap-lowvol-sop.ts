/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 중형주(MID) 저변동성·영업이익 N1·N2·N3, 0단계 재측정 포함(한 번의 실행).
 * 사전 등록: research/midcap-lowvol-sop-prereg.md (커밋 5238523a). 정의·게이트·선택 규칙은 그 문서가 고정한다. 숫자와 표, O/X만 출력한다.
 */
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { applyAdjustmentsInPlace } from "@/lib/priceAdjustment";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { computeCumulativeAndMdd, computeCagrPct } from "@/lib/strategyBacktestSummary";
import { computeIndexDailyReturnsPct } from "@/lib/benchmarkSummary";
import { computeEffectiveBuyPrice, computeEffectiveSellPrice } from "@/lib/transactionCost";
import { ETF_SPIKE_MIN_ABS_RET, ETF_SPIKE_MAX_NET_ABS, ETF_SPIKE_KOSPI_EXEMPT_RATIO, ETF_TRADING_DAYS_PER_YEAR } from "@/lib/etfAllocationConfig";
import { SEASON_STOCK_CODE } from "@/lib/seasonalityConfig";
import {
  SCAN_START, SCAN_END, SCAN_CAP_EOK, SCAN_POOL_SIZE, SCAN_MIN_CROSS_SECTION, SCAN_CANDIDATE_ABS_T, SCAN_SPACING_MONTHLY_DAYS, SCAN_VOL_DAYS, SCAN_VOL_MIN_RETURNS,
  SCAN_QUARTER_FRESH_DAYS, SCAN_DB_CHUNK,
} from "@/lib/signalScanConfig";
import { FLOW_TILT_ENDED_GRACE_DAYS } from "@/lib/foreignFlowTiltConfig";
import {
  LV_VOL_DAYS, LV_R1_VOL_DAYS, LV_MIN_PRICE_DAY_RATIO, LV_QUARTER_MONTHS, LV_FIRST_SIGNAL_MONTH, LV_LEARN, LV_CONFIRM, LV_HOLDOUT_FROM,
  LV_G1_CAGR_MARGIN_PP, LV_G3_MDD_MARGIN_PP, LV_G4_MAX_DELAY_DROP_PP, LV_R_CAGR_MARGIN_PP, LV_R3_DRAWS, LV_R3_SEED, LV_R3_TOP_FRACTION, LV_QUARTERS_PER_YEAR,
} from "@/lib/smallcapLowvolConfig";
import { MV_GATE0_SOP_HORIZONS, MV_GATE0_VOL_HORIZON, MV_N1_PARTS, MV_N2_PARTS, MV_N3_PARTS, MV_N3_MIN_COUNT } from "@/lib/midcapLowvolSopConfig";

const T0 = Date.now();
const MS_DAY = 86_400_000;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "-");
const ox = (b: boolean): string => (b ? "O" : "X");
const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;
const dbRead: Record<string, number> = {};
async function selectAll<T>(label: string, build: (f: number, t: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(`${label}: ${error.message}`);
    out.push(...(data ?? []));
    dbRead[label] = (dbRead[label] ?? 0) + (data?.length ?? 0);
    if ((data?.length ?? 0) < 1000) break;
  }
  return out;
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

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

interface S {
  code: string; idx: Map<string, number>; close: Float64Array; closeA: Float64Array; mcapRow: Float64Array; avgTvRow: Float64Array; last: string;
  qrecs: { rcept: string; order: number; op: number | null; prev: number | null }[];
}
interface Target { w: Map<string, number>; tv: number[]; fallback: boolean; n: number }
interface Out { dates: string[]; ret: number[]; costFrac: number[]; turn: { d: string; v: number }[]; nPos: number[]; liq: string[] }
interface Win { from: string; to: string }
type Kind = "N1" | "N2" | "N3" | "MEW";
const DESC: Record<Kind, string> = { N1: "N1 VOL 하위 1/3", N2: "N2 SOP 상위 1/3", N3: "N3 VOL 하위 1/2 ∩ SOP 상위 1/2", MEW: "MEW(MID 전체 동일가중)" };
const groupOf = (i: number, n: number, parts: number): number => Math.floor((i * parts) / n);

async function main(): Promise<void> {
  console.log(`중형주 저변동성·영업이익 N1~N3(0단계 포함) 시작(읽기 전용): ${new Date().toISOString()} (사전등록 5238523a 이후)`);
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear());
  const today = new Date().toISOString().slice(0, 10);
  const kospi = await getIndexPriceSeries("KOSPI", "2009-01-01", today);
  const kosdaq = await getIndexPriceSeries("KOSDAQ", "2009-01-01", today);
  dbRead["beta_price_history(KOSPI)"] = kospi.length; dbRead["beta_price_history(KOSDAQ)"] = kosdaq.length;

  interface Row0 { code: string; dates: string[]; close: Float64Array; mcap: Float64Array; avgTv: Float64Array }
  const rows0: Row0[] = [];
  const calSet = new Set<string>();
  for (const [code, rows] of series) {
    series.delete(code);
    if (!rows.length) continue;
    const adj = rows.map((r) => ({ ...r }));
    const al = adjustments.get(code);
    if (al) applyAdjustmentsInPlace(adj, al);
    for (const r of rows) if (r.tradeDate >= "2010-01-01") calSet.add(r.tradeDate);
    rows0.push({ code, dates: rows.map((r) => r.tradeDate), close: Float64Array.from(adj.map((r) => r.closePrice)), mcap: Float64Array.from(rows.map((r) => r.marketCapEok)), avgTv: computeTrailingAvgTradingValue(adj, PIT_LIQUIDITY_LOOKBACK_DAYS) });
  }
  const CAL = [...calSet].sort();
  const nCal = CAL.length, lastIdx = nCal - 1, dataEnd = CAL[lastIdx];
  const calIdx = new Map(CAL.map((d, i) => [d, i]));
  const monthEnds: string[] = [];
  for (let k = 0; k + 1 < nCal; k++) if (CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) monthEnds.push(CAL[k]);
  const endedBefore = new Date(Date.parse(dataEnd) - FLOW_TILT_ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  const firstSignal = monthEnds.find((d) => d.slice(0, 7) === LV_FIRST_SIGNAL_MONTH)!;
  const quarterSignals = monthEnds.filter((d) => d >= firstSignal && (LV_QUARTER_MONTHS as readonly number[]).includes(Number(d.slice(5, 7))));
  const monthlySignals = monthEnds.filter((d) => d >= firstSignal);
  const firstExec = CAL[calIdx.get(firstSignal)! + 1];
  let lastLearnIdx = 0;
  for (let c = 0; c < nCal; c++) if (CAL[c] <= SCAN_END) lastLearnIdx = c;
  console.log(`종목 ${rows0.length}개, 거래일(2010~) ${nCal}일 ${CAL[0]}~${dataEnd}, 분기 신호 ${quarterSignals.length}개(첫 신호 ${firstSignal}, 첫 체결 ${firstExec}), 월간 신호 ${monthlySignals.length}개`);

  // ---- ELIG 이력이 있는 종목(어느 날이든 한 번이라도 PIT 적격) ----
  const isElig = (r: { mcap: Float64Array; avgTv: Float64Array }, i: number): boolean => i >= 1 && r.mcap[i - 1] >= SCAN_CAP_EOK && r.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON;
  const cand = rows0.filter((r) => { for (let i = 1; i < r.dates.length; i++) if (r.dates[i] >= "2010-01-01" && isElig(r, i)) return true; return false; });
  console.log(`PIT 적격(시총 5천억 + 거래대금 5억)이 된 적 있는 종목 ${cand.length}개`);

  // ---- 분기 재무 ----
  const qBy = new Map<string, S["qrecs"]>();
  const QEND: Record<number, string> = { 1: "03-31", 2: "06-30", 3: "09-30" };
  const codes = cand.map((r) => r.code);
  for (let i = 0; i < codes.length; i += SCAN_DB_CHUNK) {
    const chunk = codes.slice(i, i + SCAN_DB_CHUNK);
    const q = await selectAll<{ stock_code: string; fiscal_year: number; quarter: number; rcept_date: string | null; op_income_q: number | null; op_income_prev_q: number | null; off_cycle: boolean }>("dart_quarterly_fundamentals(ok)", (f, t) => supabaseAdmin.from("dart_quarterly_fundamentals").select("stock_code, fiscal_year, quarter, rcept_date, op_income_q, op_income_prev_q, off_cycle").eq("status", "ok").in("stock_code", chunk).order("corp_code").order("fiscal_year").order("quarter").range(f, t));
    for (const r of q) {
      if (r.off_cycle || !r.rcept_date || r.quarter < 1 || r.quarter > 3 || r.rcept_date < `${r.fiscal_year}-${QEND[r.quarter]}`) continue;
      const a = qBy.get(r.stock_code) ?? [];
      a.push({ rcept: r.rcept_date, order: r.fiscal_year * 10 + r.quarter, op: r.op_income_q === null ? null : Number(r.op_income_q), prev: r.op_income_prev_q === null ? null : Number(r.op_income_prev_q) });
      qBy.set(r.stock_code, a);
    }
  }
  const stocks: S[] = cand.map((r) => {
    const idx = new Map(r.dates.map((d, i) => [d, i]));
    const closeA = new Float64Array(nCal).fill(NaN);
    for (let c = 0; c < nCal; c++) { const i = idx.get(CAL[c]); if (i !== undefined && r.close[i] > 0) closeA[c] = r.close[i]; }
    const q = (qBy.get(r.code) ?? []).sort((a, b) => (a.rcept === b.rcept ? a.order - b.order : a.rcept < b.rcept ? -1 : 1));
    return { code: r.code, idx, close: r.close, closeA, mcapRow: r.mcap, avgTvRow: r.avgTv, last: r.dates[r.dates.length - 1], qrecs: q };
  });
  stocks.sort((a, b) => (a.code < b.code ? -1 : 1));
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  rows0.length = 0;

  // ---- 유니버스(MID)·신호 ----
  const midCache = new Map<string, S[]>();
  const midAt = (d: string): S[] => {
    let v = midCache.get(d);
    if (!v) {
      const e: { s: S; mcap: number }[] = [];
      for (const s of stocks) {
        const i = s.idx.get(d);
        if (i === undefined || !isElig({ mcap: s.mcapRow, avgTv: s.avgTvRow }, i)) continue;
        e.push({ s, mcap: s.mcapRow[i] });
      }
      v = e.sort((a, b) => b.mcap - a.mcap || (a.s.code < b.s.code ? -1 : 1)).slice(SCAN_POOL_SIZE).map((x) => x.s);
      midCache.set(d, v);
    }
    return v;
  };
  function volAt(s: S, c: number, N: number): number {
    if (c - N + 1 < 0) return NaN;
    const cl = s.closeA;
    let days = 0, n = 0, sum = 0, sum2 = 0;
    for (let j = c - N + 1; j <= c; j++) {
      if (cl[j] > 0) { days++; if (j > c - N + 1 && cl[j - 1] > 0) { const r = cl[j] / cl[j - 1] - 1; n++; sum += r; sum2 += r * r; } }
    }
    if (days < Math.ceil(N * LV_MIN_PRICE_DAY_RATIO) || n < 2) return NaN;
    const m = sum / n;
    return Math.sqrt(Math.max((sum2 - n * m * m) / (n - 1), 0));
  }
  function freshRec(s: S, d: string): S["qrecs"][number] | null {
    let rec: S["qrecs"][number] | null = null;
    for (const r of s.qrecs) { if (r.rcept <= d) rec = r; else break; }
    return rec && dayDiff(rec.rcept, d) <= SCAN_QUARTER_FRESH_DAYS ? rec : null;
  }
  function sopAt(s: S, d: string): number {
    const rec = freshRec(s, d);
    if (rec && rec.op !== null && rec.prev !== null && rec.prev !== 0) return (rec.op - rec.prev) / Math.abs(rec.prev);
    return NaN;
  }
  const buyRate = computeEffectiveBuyPrice(1) - 1;
  const sellRate = (d: string): number => 1 - computeEffectiveSellPrice(1, d, "KR");

  // ================= 0단계: 스캔 2회차 MID 행 재측정(학습 구간만) =================
  console.log(`\n=== 0단계: 정렬 수정 코드로 MID 행 재측정 (스캔 2회차 fcc2f16f와 같은 정의, ${SCAN_START}~${SCAN_END}만) ===`);
  const scanVol = (s: S, c: number): number => {
    const cl = s.closeA;
    if (c < SCAN_VOL_DAYS) return NaN;
    let n = 0, sum = 0, sum2 = 0;
    for (let j = c - SCAN_VOL_DAYS + 1; j <= c; j++) if (cl[j] > 0 && cl[j - 1] > 0) { const r = cl[j] / cl[j - 1] - 1; n++; sum += r; sum2 += r * r; }
    if (n < SCAN_VOL_MIN_RETURNS) return NaN;
    const m = sum / n;
    return -Math.sqrt(Math.max((sum2 - n * m * m) / (n - 1), 0));
  };
  const fwd = (s: S, c: number, H: number): number => {
    const e = s.closeA[c + 1];
    if (!(e > 0)) return NaN;
    for (let j = c + 1 + H; j > c + 1; j--) { if (s.closeA[j] > 0) return s.closeA[j] / e - 1; }
    return 0;
  };
  const legs = (items: { code: string; v: number }[]): { top: Set<string>; bot: Set<string> } => {
    const sorted = [...items].sort((a, b) => b.v - a.v || (a.code < b.code ? -1 : 1));
    const top = new Set<string>(), bot = new Set<string>();
    sorted.forEach((x, i) => { const g = Math.floor((i * 3) / sorted.length); if (g === 0) top.add(x.code); else if (g === 2) bot.add(x.code); });
    return { top, bot };
  };
  const sampleDays: string[] = [];
  for (let k = 0; k + 1 < nCal; k++) if (CAL[k] >= SCAN_START && CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) sampleDays.push(CAL[k]);
  const sigVal = (sig: "SOP" | "VOL", s: S, c: number, d: string): number => (sig === "SOP" ? sopAt(s, d) : scanVol(s, c));
  const g0Specs = [...MV_GATE0_SOP_HORIZONS.map((H) => ({ sig: "SOP" as const, H })), { sig: "VOL" as const, H: MV_GATE0_VOL_HORIZON }];
  const g0Rows: { label: string; sig: string; H: number; n: number; avgN: number; m: number; sd: number; t: number; pos: number; sp: number; cs: number; net: number; cand: boolean }[] = [];
  for (const { sig, H } of g0Specs) {
    const samples = sampleDays.filter((d) => calIdx.get(d)! + 1 + H <= lastLearnIdx);
    const rhos: number[] = [], spreads: number[] = [], costs: number[] = [], ns: number[] = [];
    for (const d of samples) {
      const c = calIdx.get(d)!, list = midAt(d);
      const items: { code: string; v: number; r: number }[] = [];
      for (const s of list) { const v = sigVal(sig, s, c, d), r = fwd(s, c, H); if (Number.isFinite(v) && Number.isFinite(r)) items.push({ code: s.code, v, r }); }
      if (items.length < SCAN_MIN_CROSS_SECTION) continue;
      ns.push(items.length);
      const rho = spearman(items.map((x) => x.v), items.map((x) => x.r));
      if (Number.isFinite(rho)) rhos.push(rho);
      const lg = legs(items);
      const topR = items.filter((x) => lg.top.has(x.code)).map((x) => x.r), botR = items.filter((x) => lg.bot.has(x.code)).map((x) => x.r);
      if (!(topR.length > 0 && botR.length > 0)) continue;
      spreads.push(mean(topR) - mean(botR));
      const c2 = c + H, d2 = CAL[c2];
      const items2: { code: string; v: number }[] = [];
      for (const s of midAt(d2)) { const v = sigVal(sig, s, c2, d2); if (Number.isFinite(v)) items2.push({ code: s.code, v }); }
      if (items2.length < SCAN_MIN_CROSS_SECTION) continue;
      const lg2 = legs(items2);
      const uTop = [...lg.top].filter((x) => !lg2.top.has(x)).length / Math.max(lg.top.size, 1);
      const uBot = [...lg.bot].filter((x) => !lg2.bot.has(x)).length / Math.max(lg.bot.size, 1);
      const unit = buyRate + sellRate(CAL[c + H + 1]);
      costs.push((uTop + uBot) * unit);
    }
    const m = mean(rhos), L = Math.max(1, Math.round(H / SCAN_SPACING_MONTHLY_DAYS));
    const t = rhos.length >= 3 ? nwT(rhos, L) : NaN;
    const dir = m >= 0 ? 1 : -1;
    const sp = mean(spreads) * 100, cs = mean(costs) * 100;
    const net = spreads.length && costs.length ? dir * sp - cs : NaN;
    const isCand = Number.isFinite(t) && Math.abs(t) >= SCAN_CANDIDATE_ABS_T && Number.isFinite(net) && net > 0;
    g0Rows.push({ label: `${sig === "SOP" ? "분기 영업이익 증가율" : "60일 변동성(낮을수록)"} 월간 ${H}일`, sig, H, n: rhos.length, avgN: mean(ns), m, sd: sdev(rhos), t, pos: (rhos.filter((x) => x > 0).length / Math.max(rhos.length, 1)) * 100, sp, cs, net, cand: isCand });
  }
  console.log("| 신호 | 기간 | 표본일 수(상관) | 평균 종목 수 | 순위상관 평균 | 표준편차 | t(NW) | 양수 비율 % | 상위−하위 % | 교체 비용 % | 방향 반영 순차이 % | 후보 |\n|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of g0Rows) console.log(`| MID ${r.label.split(" 월간")[0]} | 월간 ${r.H}일 | ${r.n} | ${f2(r.avgN)} | ${f3(r.m)} | ${f3(r.sd)} | ${f2(r.t)} | ${f2(r.pos)} | ${f2(r.sp)} | ${f2(r.cs)} | ${f2(r.net)} | ${r.cand ? "후보" : ""} |`);
  const sopRows = g0Rows.filter((r) => r.sig === "SOP");
  const gatePass = sopRows.length === MV_GATE0_SOP_HORIZONS.length && sopRows.every((r) => r.cand);
  const VARIANTS: Kind[] = gatePass ? ["N1", "N2", "N3"] : ["N1"];
  console.log(`게이트: SOP 월21 후보=${ox(sopRows[0].cand)}(t ${f2(sopRows[0].t)}, 순차이 ${f2(sopRows[0].net)}, 순위상관 부호 ${sopRows[0].m >= 0 ? "+" : "-"}), SOP 월63 후보=${ox(sopRows[1].cand)}(t ${f2(sopRows[1].t)}, 순차이 ${f2(sopRows[1].net)}, 순위상관 부호 ${sopRows[1].m >= 0 ? "+" : "-"}) → ${gatePass ? "통과" : "미통과"}`);
  console.log(`실행 변형 목록: ${VARIANTS.join(", ")} (시도 번호 ${VARIANTS.map((k, i) => `${k}=${130 + i}`).join(", ")})`);

  // ---- 추가 확인: 신호일별 MID 구성원의 분기 데이터 보유율과 진입 여부 ----
  const firstElig = new Map<string, string>();
  for (const s of stocks) for (const d of monthEnds) { const i = s.idx.get(d); if (i !== undefined && isElig({ mcap: s.mcapRow, avgTv: s.avgTvRow }, i)) { firstElig.set(s.code, d); break; } }
  console.log(`\n=== 추가 확인: 분기 신호일별 MID 구성원 (학습 구간 ${SCAN_START}~${SCAN_END}, 진입 = 최초 PIT 진입 월말(시총 5천억 + 거래대금 5억) ≤ 신호일) ===`);
  console.log("| 신호일 | MID 구성원 | 이미 진입 | 이후 진입 | 분기 데이터 보유 | 보유율 % | SOP 계산 가능 | 가능률 % | 이미 진입 중 보유율 % |\n|---|---|---|---|---|---|---|---|---|");
  const cov = { mem: 0, already: 0, future: 0, have: 0, sop: 0, haveAlready: 0, n: 0 };
  for (const d of quarterSignals.filter((x) => x <= SCAN_END)) {
    const list = midAt(d);
    let already = 0, future = 0, have = 0, sop = 0, haveAlready = 0;
    for (const s of list) {
      const fe = firstElig.get(s.code);
      const isAlready = fe !== undefined && fe <= d;
      if (isAlready) already++; else future++;
      if (freshRec(s, d)) { have++; if (isAlready) haveAlready++; }
      if (Number.isFinite(sopAt(s, d))) sop++;
    }
    cov.mem += list.length; cov.already += already; cov.future += future; cov.have += have; cov.sop += sop; cov.haveAlready += haveAlready; cov.n++;
    console.log(`| ${d} | ${list.length} | ${already} | ${future} | ${have} | ${f2((have / Math.max(list.length, 1)) * 100)} | ${sop} | ${f2((sop / Math.max(list.length, 1)) * 100)} | ${f2((haveAlready / Math.max(already, 1)) * 100)} |`);
  }
  console.log(`| 평균(신호일 ${cov.n}개) | ${f2(cov.mem / cov.n)} | ${f2(cov.already / cov.n)} | ${f2(cov.future / cov.n)} | ${f2(cov.have / cov.n)} | ${f2((cov.have / Math.max(cov.mem, 1)) * 100)} | ${f2(cov.sop / cov.n)} | ${f2((cov.sop / Math.max(cov.mem, 1)) * 100)} | ${f2((cov.haveAlready / Math.max(cov.already, 1)) * 100)} |`);

  // ================= 백테스트 =================
  const planCache = new Map<string, { members: S[]; items: { s: S; vol: number }[] }>();
  function planAt(d: string, N: number): { members: S[]; items: { s: S; vol: number }[] } {
    const key = `${d}|${N}`;
    let p = planCache.get(key);
    if (!p) {
      const c = calIdx.get(d)!, members = midAt(d);
      const items = members.map((s) => ({ s, vol: volAt(s, c, N) })).filter((x) => Number.isFinite(x.vol)).sort((a, b) => a.vol - b.vol || (a.s.code < b.s.code ? -1 : 1));
      p = { members, items };
      planCache.set(key, p);
    }
    return p;
  }
  const sopCache = new Map<string, S[]>();
  const sopRanked = (d: string): S[] => {
    let v = sopCache.get(d);
    if (!v) {
      v = midAt(d).map((s) => ({ s, sop: sopAt(s, d) })).filter((x) => Number.isFinite(x.sop)).sort((a, b) => b.sop - a.sop || (a.s.code < b.s.code ? -1 : 1)).map((x) => x.s);
      sopCache.set(d, v);
    }
    return v;
  };
  const mkTarget = (sel: S[], d: string, fallback: boolean): Target => {
    const w = new Map<string, number>(), tv: number[] = [];
    for (const s of sel) { w.set(s.code, 1 / sel.length); tv.push(s.avgTvRow[s.idx.get(d)!]); }
    return { w, tv, fallback, n: sel.length };
  };
  function targetFor(kind: Kind, d: string, N: number): Target {
    const { members, items } = planAt(d, N);
    if (kind === "MEW") return mkTarget(members, d, false);
    const n = items.length;
    const n1 = items.filter((_, i) => groupOf(i, n, MV_N1_PARTS) === 0).map((x) => x.s);
    if (kind === "N1") return mkTarget(n1, d, false);
    const sr = sopRanked(d), m = sr.length;
    if (kind === "N2") return mkTarget(sr.filter((_, j) => groupOf(j, m, MV_N2_PARTS) === 0), d, false);
    const volHalf = new Set(items.filter((_, i) => groupOf(i, n, MV_N3_PARTS) === 0).map((x) => x.s.code));
    const inter = sr.filter((_, j) => groupOf(j, m, MV_N3_PARTS) === 0).filter((s) => volHalf.has(s.code));
    return inter.length < MV_N3_MIN_COUNT ? mkTarget(n1, d, true) : mkTarget(inter, d, false);
  }
  const targetsOf = (kind: Kind, sigs: string[], N: number): Target[] => sigs.map((d) => targetFor(kind, d, N));

  // ---- 엔진 ----
  function run(targets: Target[], sigs: string[], delay: boolean, endD: string): Out {
    const execAt = new Map<string, Target>();
    sigs.forEach((d, k) => { const j = calIdx.get(d)! + 1 + (delay ? 1 : 0); if (j < nCal && k < targets.length) execAt.set(CAL[j], targets[k]); });
    let cash = 1, prevV = 1;
    const pos = new Map<string, { val: number; last: number }>();
    const out: Out = { dates: [], ret: [], costFrac: [], turn: [], nPos: [], liq: [] };
    for (let c = calIdx.get(firstExec)!; c < nCal; c++) {
      const d = CAL[c];
      if (d > endD) break;
      const sr = sellRate(d);
      let costF = 0;
      for (const [code, p] of pos) {
        const sk = byCode.get(code)!;
        const i = sk.idx.get(d);
        if (i !== undefined) { p.val = (p.val * sk.close[i]) / p.last; p.last = sk.close[i]; }
        else if (sk.last < d && sk.last < endedBefore) { costF += (p.val * sr) / prevV; cash += p.val * (1 - sr); pos.delete(code); out.liq.push(d); }
      }
      const now = execAt.get(d);
      if (now) {
        let V = cash;
        for (const p of pos.values()) V += p.val;
        const tg = new Map<string, number>();
        for (const [code, w] of now.w) if (byCode.get(code)!.idx.has(d) && w > 0) tg.set(code, w);
        let buyN = 0, sellN = 0;
        for (const [code, p] of pos) if (!tg.has(code)) sellN += p.val;
        for (const [code, w] of tg) { const diff = w * V - (pos.get(code)?.val ?? 0); if (diff > 0) buyN += diff; else sellN += -diff; }
        const C = buyN * buyRate + sellN * sr, scale = V > 0 ? (V - C) / V : 1;
        pos.clear();
        let inv = 0;
        for (const [code, w] of tg) { const sk = byCode.get(code)!; const val = w * V * scale; pos.set(code, { val, last: sk.close[sk.idx.get(d)!] }); inv += val; }
        cash = V - C - inv;
        costF += V > 0 ? C / V : 0;
        if (buyN + sellN > 0) out.turn.push({ d, v: V > 0 ? (buyN + sellN) / 2 / V : 0 });
      }
      let V = cash;
      for (const p of pos.values()) V += p.val;
      out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.costFrac.push(costF); out.nPos.push(pos.size);
      prevV = V;
    }
    return out;
  }

  // ---- 지표 ----
  function st(o: { dates: string[]; ret: number[]; costFrac?: number[]; turn?: { d: string; v: number }[]; nPos?: number[]; liq?: string[] }, win: Win, retOverride?: number[]) {
    const to = win.to > dataEnd ? dataEnd : win.to;
    const idx: number[] = [];
    for (let i = 0; i < o.dates.length; i++) if (o.dates[i] >= win.from && o.dates[i] <= win.to && o.dates[i] > firstExec) idx.push(i);
    const r = idx.map((i) => (retOverride ? retOverride[i] : o.ret[i]));
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
    const cagr = computeCagrPct(totalReturnPct, win.from, to);
    const m = r.reduce((a, x) => a + x, 0) / Math.max(r.length, 1);
    const sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(r.length - 1, 1));
    const yrs = Math.max(dayDiff(win.from, to) / 365.25, 1e-9);
    return {
      cagr, mdd: mddPct, sharpe: sd > 0 ? (m * ETF_TRADING_DAYS_PER_YEAR) / (sd * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR)) : NaN, vol: sd * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR),
      turnover: o.turn ? (o.turn.filter((x) => x.d >= win.from && x.d <= win.to && x.d > firstExec).reduce((a, x) => a + x.v, 0) / (yrs * LV_QUARTERS_PER_YEAR)) * 100 : NaN,
      cost: o.costFrac ? idx.reduce((a, i) => a + o.costFrac![i], 0) * 100 : NaN,
      avgN: o.nPos ? idx.reduce((a, i) => a + o.nPos![i], 0) / Math.max(idx.length, 1) : NaN,
      liq: o.liq ? o.liq.filter((d) => d >= win.from && d <= win.to && d > firstExec).length : NaN,
    };
  }
  type Stat = ReturnType<typeof st>;
  const yearRet = (o: { dates: string[]; ret: number[] }, y: number, win: Win): number => computeCumulativeAndMdd(o.ret.filter((_, i) => o.dates[i].startsWith(`${y}-`) && o.dates[i] >= win.from && o.dates[i] <= win.to && o.dates[i] > firstExec)).totalReturnPct;
  const medianTv = (sigs: string[], targets: Target[], win: Win): number => {
    const v: number[] = [];
    sigs.forEach((d, k) => { const j = calIdx.get(d)! + 1; if (j >= nCal || k >= targets.length) return; const e = CAL[j]; if (e >= win.from && e <= win.to && e > firstExec) v.push(...targets[k].tv); });
    v.sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] / 1e8 : NaN;
  };
  const fbCount = (sigs: string[], targets: Target[], win: Win): string => {
    let fb = 0, tot = 0, empty = 0;
    sigs.forEach((d, k) => { const j = calIdx.get(d)! + 1; if (j >= nCal || k >= targets.length) return; const e = CAL[j]; if (e >= win.from && e <= win.to && e > firstExec) { tot++; if (targets[k].fallback) fb++; if (targets[k].n === 0) empty++; } });
    return `N1 대체 ${fb}/${tot}, 선정 0개(전액 현금) ${empty}/${tot}`;
  };

  // ---- B&H, KOSDAQ, KOSPI ----
  const rawEtf: { date: string; px: number }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from("etf_daily_prices").select("trade_date, adj_close").eq("code", SEASON_STOCK_CODE).order("trade_date").range(from, from + 999);
    if (error) throw new Error(`etf_daily_prices: ${error.message}`);
    for (const r of data ?? []) rawEtf.push({ date: r.trade_date as string, px: Number(r.adj_close) });
    dbRead["etf_daily_prices(069500)"] = (dbRead["etf_daily_prices(069500)"] ?? 0) + (data?.length ?? 0);
    if (!data || data.length < 1000) break;
  }
  const kRetByDate = new Map<string, number>();
  for (let i = 1; i < kospi.length; i++) kRetByDate.set(kospi[i].tradeDate, kospi[i].closePrice / kospi[i - 1].closePrice - 1);
  const etf = rawEtf.map((x) => ({ ...x }));
  {
    const r = rawEtf.map((x, i) => (i === 0 ? NaN : x.px / rawEtf[i - 1].px - 1));
    let nCh = 0;
    for (let t = 1; t + 1 < rawEtf.length; t++) {
      if (!(Math.abs(r[t]) > ETF_SPIKE_MIN_ABS_RET) || !(Math.sign(r[t + 1]) === -Math.sign(r[t])) || !(Math.abs((1 + r[t]) * (1 + r[t + 1]) - 1) < ETF_SPIKE_MAX_NET_ABS)) continue;
      const kr = kRetByDate.get(rawEtf[t].date);
      if (kr !== undefined && Math.sign(kr) === Math.sign(r[t]) && Math.abs(kr) >= ETF_SPIKE_KOSPI_EXEMPT_RATIO * Math.abs(r[t])) continue;
      etf[t].px = Math.sqrt(rawEtf[t - 1].px * rawEtf[t + 1].px); nCh++;
    }
    console.log(`069500 정제로 바꾼 날 ${nCh}개`);
  }
  const bh = { dates: etf.slice(1).map((x) => x.date), ret: etf.slice(1).map((x, i) => (x.px / etf[i].px - 1) * 100) };
  const idxSeries = (pts: typeof kospi): { dates: string[]; ret: number[] } => { const p = pts.filter((x) => x.tradeDate >= "2009-12-01"); return { dates: p.slice(1).map((x) => x.tradeDate), ret: computeIndexDailyReturnsPct(p as never) }; };
  const kos = idxSeries(kospi), kdq = idxSeries(kosdaq);
  console.log(`KOSDAQ 지수 ${kosdaq.length}행 ${kosdaq[0]?.tradeDate}~${kosdaq[kosdaq.length - 1]?.tradeDate}`);

  const LEARN: Win = { ...LV_LEARN }, CONFIRM: Win = { ...LV_CONFIRM }, HOLD: Win = { from: LV_HOLDOUT_FROM, to: "9999-12-31" }, FULL: Win = { from: LV_LEARN.from, to: "9999-12-31" };
  const gatesOf = (x: Stat, mew: Stat, b: Stat, drop: number): boolean[] => [x.cagr >= mew.cagr + LV_G1_CAGR_MARGIN_PP, x.cagr > b.cagr, x.mdd <= b.mdd + LV_G3_MDD_MARGIN_PP, drop <= LV_G4_MAX_DELAY_DROP_PP];
  const HEAD = "| 구성 | CAGR % | MDD % | 샤프 | 연변동성 % | 분기 평균 회전율 % | 누적 비용 % | 평균 보유 종목 수 | 보유 종목 20일 평균 거래대금 중앙값(억원) | 폐지 청산 건수 | 지연 CAGR % | 하락 %p | G1 | G2 | G3 | G4 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const row = (lab: string, s: Stat, tv: number, extra: string): string => `| ${lab} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${f2(s.vol)} | ${f2(s.turnover)} | ${f2(s.cost)} | ${f2(s.avgN)} | ${f2(tv)} | ${Number.isFinite(s.liq) ? s.liq : "-"} | ${extra}`;
  const refRow = (lab: string, s: Stat): string => `| ${lab} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${f2(s.vol)} | - | - | - | - | - | | | | | | |`;
  const yrsOf = (win: Win): number[] => { const a: number[] = []; for (let y = Number(win.from.slice(0, 4)); y <= Math.min(Number(win.to.slice(0, 4)), Number(dataEnd.slice(0, 4))); y++) a.push(y); return a; };

  // ---- 학습 ----
  const learnSigs = quarterSignals.filter((d) => d <= LEARN.to);
  const tgt = new Map<Kind, Target[]>();
  for (const k of [...VARIANTS, "MEW"] as Kind[]) tgt.set(k, targetsOf(k, learnSigs, LV_VOL_DAYS));
  const L: Record<string, { base: Out; delay?: Out }> = {};
  for (const k of VARIANTS) L[k] = { base: run(tgt.get(k)!, learnSigs, false, LEARN.to), delay: run(tgt.get(k)!, learnSigs, true, LEARN.to) };
  L.MEW = { base: run(tgt.get("MEW")!, learnSigs, false, LEARN.to) };
  const sL = new Map<string, Stat>();
  for (const k of [...VARIANTS, "MEW"] as Kind[]) sL.set(k, st(L[k].base, LEARN));
  const bhL = st(bh, LEARN), kL = st(kos, LEARN), dL = st(kdq, LEARN), mewL = sL.get("MEW")!;
  console.log(`\n=== (b) 학습 ${LEARN.from}~${LEARN.to} ===\n${HEAD}`);
  const qual = new Map<Kind, { ok: boolean; excess: number; turn: number }>();
  for (const k of VARIANTS) {
    const s = sL.get(k)!, sd = st(L[k].delay!, LEARN), drop = s.cagr - sd.cagr, g = gatesOf(s, mewL, bhL, drop);
    qual.set(k, { ok: g.every(Boolean), excess: s.cagr - mewL.cagr, turn: s.turnover });
    console.log(row(DESC[k], s, medianTv(learnSigs, tgt.get(k)!, LEARN), `${f2(sd.cagr)} | ${f2(drop)} | ${g.map(ox).join(" | ")} |`));
  }
  console.log(row(DESC.MEW, mewL, medianTv(learnSigs, tgt.get("MEW")!, LEARN), "| | | | | | |"));
  console.log(refRow("B&H(069500)", bhL)); console.log(refRow("KOSDAQ", dL)); console.log(refRow("KOSPI", kL));
  console.log(`기준: G1 CAGR ≥ MEW ${f2(mewL.cagr)} + ${LV_G1_CAGR_MARGIN_PP} = ${f2(mewL.cagr + LV_G1_CAGR_MARGIN_PP)}, G2 CAGR > B&H ${f2(bhL.cagr)}, G3 MDD ≤ B&H ${f2(bhL.mdd)} + ${LV_G3_MDD_MARGIN_PP} = ${f2(bhL.mdd + LV_G3_MDD_MARGIN_PP)}, G4 지연 하락 ≤ ${LV_G4_MAX_DELAY_DROP_PP}`);
  for (const k of VARIANTS) if (k !== "N1") console.log(`${k} 선정 현황(학습 창 신호일): ${fbCount(learnSigs, tgt.get(k)!, LEARN)}`);
  console.log(`연도별 수익률 %\n| 연도 | ${VARIANTS.join(" | ")} | MEW | B&H |\n|---|${VARIANTS.map(() => "---|").join("")}---|---|`);
  for (const y of yrsOf(LEARN)) console.log(`| ${y} | ${VARIANTS.map((k) => f2(yearRet(L[k].base, y, LEARN))).join(" | ")} | ${f2(yearRet(L.MEW.base, y, LEARN))} | ${f2(yearRet(bh, y, LEARN))} |`);

  const qualified = VARIANTS.filter((k) => qual.get(k)!.ok).sort((a, b) => qual.get(b)!.excess - qual.get(a)!.excess || qual.get(a)!.turn - qual.get(b)!.turn || (a < b ? -1 : 1));
  console.log("\n=== (c) 선택 결과 ===");
  if (!qualified.length) { console.log("선택 없음 (G1~G4 전부 O인 변형 0개) — 확인 계산을 하지 않고 종료합니다."); return finish(); }
  const sel = qualified[0];
  console.log(`G1~G4 전부 O 변형 ${qualified.length}개: ${qualified.map((k) => `${k}(초과 ${f2(qual.get(k)!.excess)}%p)`).join(", ")} → 선택: ${sel}`);

  // ---- 선택 변형 전체 경로 ----
  const tS = targetsOf(sel, quarterSignals, LV_VOL_DAYS), tW = targetsOf("MEW", quarterSignals, LV_VOL_DAYS);
  const FB = run(tS, quarterSignals, false, "9999-12-31"), FD = run(tS, quarterSignals, true, "9999-12-31"), FW = run(tW, quarterSignals, false, "9999-12-31");
  const stage = (label: string, win: Win): boolean => {
    const s = st(FB, win), sd = st(FD, win), w = st(FW, win), b = st(bh, win), k = st(kos, win), q = st(kdq, win);
    const drop = s.cagr - sd.cagr, g = gatesOf(s, w, b, drop);
    console.log(`\n=== ${label} ${win.from}~${win.to > dataEnd ? dataEnd : win.to} ===\n${HEAD}`);
    console.log(row(DESC[sel], s, medianTv(quarterSignals, tS, win), `${f2(sd.cagr)} | ${f2(drop)} | ${g.map(ox).join(" | ")} |`));
    console.log(row(DESC.MEW, w, medianTv(quarterSignals, tW, win), "| | | | | | |"));
    console.log(refRow("B&H(069500)", b)); console.log(refRow("KOSDAQ", q)); console.log(refRow("KOSPI", k));
    console.log(`기준: G1 ≥ ${f2(w.cagr + LV_G1_CAGR_MARGIN_PP)}, G2 > ${f2(b.cagr)}, G3 ≤ ${f2(b.mdd + LV_G3_MDD_MARGIN_PP)}, G4 하락 ≤ ${LV_G4_MAX_DELAY_DROP_PP}`);
    if (sel !== "N1") console.log(`${sel} 선정 현황(이 창 신호일): ${fbCount(quarterSignals, tS, win)}`);
    console.log(`연도별 수익률 %\n| 연도 | ${sel} | MEW | B&H |\n|---|---|---|---|`);
    for (const y of yrsOf(win)) console.log(`| ${y} | ${f2(yearRet(FB, y, win))} | ${f2(yearRet(FW, y, win))} | ${f2(yearRet(bh, y, win))} |`);
    return g.every(Boolean);
  };
  if (!stage("(d) 확인", CONFIRM)) { console.log("\n확인 결과: 통과 아님 (홀드아웃 계산하지 않음)"); return finish(); }
  console.log(`\n홀드아웃 계산 실행 → 누적 시도 +1 (${129 + VARIANTS.length + 1})`);
  if (!stage("(d) 홀드아웃", HOLD)) { console.log("\n홀드아웃 결과: 통과 아님 (R1~R3 계산하지 않음)"); return finish(); }

  // ---- 추가 검증 ----
  const fullS = st(FB, FULL), fullW = st(FW, FULL), thr = fullW.cagr + LV_R_CAGR_MARGIN_PP;
  console.log(`\n=== (e) 추가 검증 R1~R3 (전 기간 ${FULL.from}~${dataEnd}; 전략 CAGR ${f2(fullS.cagr)}, MEW CAGR ${f2(fullW.cagr)}, 기준 ${f2(thr)}) ===`);
  const r1: { label: string; cagr: number; ok: boolean }[] = [];
  for (const n of LV_R1_VOL_DAYS) { const s = st(run(targetsOf(sel, quarterSignals, n), quarterSignals, false, "9999-12-31"), FULL); r1.push({ label: `VOL 창 ${n}일`, cagr: s.cagr, ok: s.cagr >= thr }); }
  { const s = st(run(targetsOf(sel, monthlySignals, LV_VOL_DAYS), monthlySignals, false, "9999-12-31"), FULL); r1.push({ label: "매월 리밸런싱", cagr: s.cagr, ok: s.cagr >= thr }); }
  console.log("R1\n| 조합 | 전 기간 CAGR % | O/X |\n|---|---|---|");
  for (const x of r1) console.log(`| ${x.label} | ${f2(x.cagr)} | ${ox(x.ok)} |`);
  const r1ok = r1.every((x) => x.ok);
  const qk = (d: string): string => `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
  const qm = new Map<string, { s: number[]; w: number[]; idx: number[] }>();
  FB.dates.forEach((d, i) => { if (d < FULL.from || d <= firstExec) return; const k = qk(d); const e = qm.get(k) ?? { s: [], w: [], idx: [] }; e.s.push(FB.ret[i]); e.w.push(FW.ret[i]); e.idx.push(i); qm.set(k, e); });
  let best = { q: "", ex: -Infinity };
  for (const [k, e] of qm) { const ex = computeCumulativeAndMdd(e.s).totalReturnPct - computeCumulativeAndMdd(e.w).totalReturnPct; if (ex > best.ex) best = { q: k, ex }; }
  const repl = [...FB.ret];
  for (const i of qm.get(best.q)!.idx) repl[i] = FW.ret[i];
  const r2s = st(FB, FULL, repl), r2ok = r2s.cagr >= thr;
  console.log(`R2: MEW 대비 분기 초과 수익 최대 ${best.q} (${f2(best.ex)}%p) 를 MEW 수익으로 바꾼 전 기간 CAGR ${f2(r2s.cagr)} vs 기준 ${f2(thr)} → ${ox(r2ok)}`);
  const r3 = (label: string, poolOf: (d: string) => S[]): boolean => {
    const rng = mulberry32(LV_R3_SEED);
    let ge = 0;
    const draws: number[] = [];
    const pools = quarterSignals.map((d) => poolOf(d));
    for (let n = 0; n < LV_R3_DRAWS; n++) {
      const tg: Target[] = quarterSignals.map((d, k) => {
        const pl = pools[k], cnt = Math.min(tS[k].n, pl.length), a = [...pl];
        for (let i = 0; i < cnt; i++) { const j = i + Math.floor(rng() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; }
        const w = new Map<string, number>();
        for (let i = 0; i < cnt; i++) w.set(a[i].code, 1 / cnt);
        return { w, tv: [], fallback: false, n: cnt };
      });
      const c = st(run(tg, quarterSignals, false, "9999-12-31"), FULL).cagr;
      draws.push(c);
      if (c >= fullS.cagr) ge++;
    }
    draws.sort((a, b) => a - b);
    const p = ge / LV_R3_DRAWS, ok = p <= LV_R3_TOP_FRACTION;
    console.log(`R3 ${label}: 무작위 ${LV_R3_DRAWS}회 전 기간 CAGR 중앙값 ${f2(draws[Math.floor(draws.length / 2)])}, 95분위 ${f2(draws[Math.floor(draws.length * 0.95)])}, 최대 ${f2(draws[draws.length - 1])}; 전략 ${f2(fullS.cagr)} 이상인 횟수 ${ge} (${f2(p * 100)}%) → ${ox(ok)} (기준 상위 ${LV_R3_TOP_FRACTION * 100}% 이내)`);
    return ok;
  };
  const r3a = r3("(a) MID 전체", (d) => midAt(d));
  const r3b = sel === "N1" ? true : r3("(b) SOP 보유 종목", (d) => sopRanked(d));
  const r3ok = r3a && r3b;
  console.log(`\n최종: ${r1ok && r2ok && r3ok ? "통과" : "통과 아님"} (R1 ${ox(r1ok)} R2 ${ox(r2ok)} R3 ${ox(r3ok)})`);
  finish();

  function finish(): void {
    console.log("\n=== (f) 실행 지표 ===");
    console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
    console.log(`Supabase 쓴 행: 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

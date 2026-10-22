/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] W: 워크포워드(매년 과거 데이터로만 설정 재선정) W1·W2 (누적 시험 166~167).
 * 사전 등록: docs/research/w-walkforward-prereg.md (acd11e3). 입력·제외 규칙·비용·K200P·일별 업종 순위·골든크로스·슬롯 엔진은
 * scripts/research-f-daily-trend.ts(94afefb)·research-h-divergence-impulse.ts(a7b6a8b) 그대로.
 */
import { parquetReadObjects } from "hyparquet";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET } from "@/lib/investorFlowConfig";
import { MM_PARQUET_PATH, MM_LOG_PATH, MM_FROM_MONTH, MM_TO_MONTH, MM_ENDPOINTS } from "@/lib/marketMembershipConfig";
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
import { FLOW_TILT_ENDED_GRACE_DAYS } from "@/lib/foreignFlowTiltConfig";
import { LV_CONFIRM, LV_HOLDOUT_FROM } from "@/lib/smallcapLowvolConfig";
import { SAT_SPAC_NAME_KEYWORDS, SAT_REIT_NAME_SUFFIX, SAT_REIT_KSIC_PREFIXES, SAT_REIT_EXPLICIT_CODES, SAT_MDD_EPS, SAT_SECTOR_UNCLASSIFIED, SAT_KSIC_DIVISION_NAMES } from "@/lib/satelliteV1Config";
import {
  SMT_FIRST_SIGNAL_MONTH, SMT_LEARN, SMT_LOOKBACK_MONTHS, SMT_SKIP_MONTHS, SMT_MIN_SECTOR_STOCKS,
  SMT_MONTHS_PER_YEAR, SMT21_K_SIZE, SMT21_STAGE0_MAX_UNKNOWN_PCT,
} from "@/lib/sectorMomTiltConfig";
import { SAT_MIX_BAND, SAT_ETF_COST_PER_SIDE } from "@/lib/satelliteV1Config";
import { KSS_TOP_K, KSS_MIX_WEIGHTS, KSS_DEFAULT_W, KSS_G1_MARGIN_PP, KSS_G2_MDD_MARGIN_PP, KSS_G4_MAX_DELAY_DROP_PP, KSS_R1_TOP_KS, KSS_R3_DRAWS, KSS_R3_SEED, KSS31_PER_SECTOR, KSS31_R1_LOOKBACKS, KSS31_PRACTICAL_FROM, KSS32_TRIM_MIN_WEIGHT, KSS32_R1_TRIMS, KSS32_SEEDS_WON, KSS32_ETF_SLIPPAGE, D_RECENT_FROM, D_RECENT_TO, F_SHORT, F_LONG, F_R1_MAS, F_TOP_SECTORS, F_R1_TOPS, F_MAX_POS, F_R1_POS, F_ENTRY_FRAC, F_COOLDOWN, F_STOP, F_R1_STOPS, F_TRAIL_G2, F_R1_TRAIL_G2, F_TRAIL_G4, F_R1_TRAIL_G4, F_A_EXCESS_PP, F_B_MIN_PERIODS, F_C_MAX_CAGR_DROP, F_C_MAX_MDD_WORSEN, F_E_TOP_TRADES, F_F_MIN_PCTILE, F_TESTS, F_PRIOR_TESTS, F_TOP_TRADES_N, F_LONG_HOLD_DAYS, H_MACD_FAST, H_MACD_SLOW, H_MACD_SIGNAL, H_WEEKLY_EMA, H_WEEKLY_VALID_FROM, W_FIRST_EVAL_YEAR, W_LAG_FIRST_SELECT_YEAR, W_MIN_ENTRIES_SCORE, W_CALMAR_MDD_FLOOR_PCT, W1_MA_PAIRS, W1_TOPS, W1_POS, W1_STOPS, W1_TRAILS, W1_IMPULSE, W2_MOMS, W2_SECTORS, W2_PER, W2_WEIGHTS, W2_CASH_FILTER, W_A_EXCESS_PP, W_B_SPLIT_END, W_B_LATE_FROM, W_C_MAX_CAGR_DROP, W_C_MAX_MDD_WORSEN, W_E_TOP, W_F_DRAWS, W_F_MIN_PCTILE, W1_MIN_ENTRIES, W_TESTS, W_PRIOR_TESTS } from "@/lib/kodexSectorSatConfig";
import { FEE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const ETF_CODE = SEASON_STOCK_CODE;

const T0 = Date.now();
const MS_DAY = 86_400_000;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
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

interface S { code: string; dates: string[]; idx: Map<string, number>; close: Float64Array; raw: Float64Array; mcapRow: Float64Array; avgTvRow: Float64Array; last: string }
interface Target { w: Map<string, number>; n: number }
interface Out { dates: string[]; ret: number[]; costFrac: number[]; turn: { d: string; v: number }[]; nPos: number[]; liq: string[] }
interface Win { from: string; to: string }

async function main(): Promise<void> {
  console.log(`KODEX 200 + 업종 모멘텀 위성 W 워크포워드(acd11e3) 시작(읽기 전용): ${new Date().toISOString()}`);
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear());
  const kospi = await getIndexPriceSeries("KOSPI", "2009-01-01", new Date().toISOString().slice(0, 10));
  dbRead["beta_price_history(KOSPI)"] = kospi.length;

  interface Row0 { code: string; dates: string[]; close: Float64Array; raw: Float64Array; mcap: Float64Array; avgTv: Float64Array }
  const rows0: Row0[] = [];
  const calSet = new Set<string>();
  for (const [code, rows] of series) {
    series.delete(code);
    if (!rows.length) continue;
    const adj = rows.map((r) => ({ ...r }));
    const al = adjustments.get(code);
    if (al) applyAdjustmentsInPlace(adj, al);
    for (const r of rows) if (r.tradeDate >= "2010-01-01") calSet.add(r.tradeDate);
    rows0.push({ code, dates: rows.map((r) => r.tradeDate), close: Float64Array.from(adj.map((r) => r.closePrice)), raw: Float64Array.from(rows.map((r) => r.closePrice)), mcap: Float64Array.from(rows.map((r) => r.marketCapEok)), avgTv: computeTrailingAvgTradingValue(adj, PIT_LIQUIDITY_LOOKBACK_DAYS) });
  }
  const CAL = [...calSet].sort();
  const nCal = CAL.length, dataEnd = CAL[nCal - 1];
  const calIdx = new Map(CAL.map((d, i) => [d, i]));
  const monthEnds: string[] = [];
  for (let k = 0; k + 1 < nCal; k++) if (CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) monthEnds.push(CAL[k]);
  const endedBefore = new Date(Date.parse(dataEnd) - FLOW_TILT_ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  const firstSignal = monthEnds.find((d) => d.slice(0, 7) === SMT_FIRST_SIGNAL_MONTH)!;
  const sigs = monthEnds.filter((d) => d >= firstSignal);
  const meIdx = new Map(monthEnds.map((d, i) => [d, i]));
  const firstExec = CAL[calIdx.get(firstSignal)! + 1];
  console.log(`종목 ${rows0.length}개, 거래일 ${nCal}일 ${CAL[0]}~${dataEnd}, 월간 신호 ${sigs.length}개(첫 신호 ${firstSignal}, 첫 체결 ${firstExec}, 마지막 신호 ${sigs[sigs.length - 1]})`);

  const stocks: S[] = rows0
    .filter((r) => r.dates.some((d) => d >= "2010-01-01"))
    .map((r) => ({ code: r.code, dates: r.dates, idx: new Map(r.dates.map((d, i) => [d, i])), close: r.close, raw: r.raw, mcapRow: r.mcap, avgTvRow: r.avgTv, last: r.dates[r.dates.length - 1] }))
    .sort((a, b) => (a.code < b.code ? -1 : 1));
  rows0.length = 0;
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  const codes = stocks.map((s) => s.code);
  console.log(`2010년 이후 가격 행이 있는 종목 ${codes.length}개`);

  // ---- 이름·업종·제외 규칙(4c1557a) ----
  const nameOf = new Map<string, string>(), indOf = new Map<string, string>(), etfSet = new Set<string>();
  for (let i = 0; i < codes.length; i += 200) {
    const chunk = codes.slice(i, i + 200);
    for (const r of await selectAll<{ isu_cd: string }>("etf_krx_daily(유니버스 코드와 겹치는 행)", (f, t) => supabaseAdmin.from("etf_krx_daily").select("isu_cd").in("isu_cd", chunk).order("isu_cd").order("bas_dd").range(f, t))) etfSet.add(r.isu_cd);
    for (const r of await selectAll<{ code: string }>("etf_daily_prices(유니버스 코드와 겹치는 행)", (f, t) => supabaseAdmin.from("etf_daily_prices").select("code").in("code", chunk).order("code").order("trade_date").range(f, t))) etfSet.add(r.code);
    for (const r of await selectAll<{ corp_code: string; corp_name: string; stock_code: string }>("dart_corp_codes(유니버스 코드)", (f, t) => supabaseAdmin.from("dart_corp_codes").select("corp_code, corp_name, stock_code").in("stock_code", chunk).order("corp_code").range(f, t))) nameOf.set(r.stock_code, r.corp_name);
    for (const r of await selectAll<{ stock_code: string; induty_code: string | null }>("stock_industry_classification(유니버스 코드)", (f, t) => supabaseAdmin.from("stock_industry_classification").select("stock_code, induty_code").in("stock_code", chunk).order("stock_code").range(f, t))) if (r.induty_code) indOf.set(r.stock_code, r.induty_code);
  }
  const excluded = new Set<string>();
  for (const c of codes) {
    const n = nameOf.get(c), ic = indOf.get(c);
    if (c[c.length - 1] !== "0" || etfSet.has(c)) excluded.add(c);
    if (n !== undefined && (SAT_SPAC_NAME_KEYWORDS.some((k) => n.includes(k)) || n.trim().endsWith(SAT_REIT_NAME_SUFFIX))) excluded.add(c);
    if (ic && SAT_REIT_KSIC_PREFIXES.some((p) => ic.startsWith(p))) excluded.add(c);
    if ((SAT_REIT_EXPLICIT_CODES as readonly string[]).includes(c)) excluded.add(c);
  }
  console.log(`제외 규칙(4c1557a) 해당 ${excluded.size}개 (ETF 겹침 ${etfSet.size}개) | 업종 분류 보유 ${codes.filter((c) => indOf.has(c)).length}/${codes.length}개`);
  const sectorOf = (c: string): string => indOf.get(c)?.slice(0, 2) ?? SAT_SECTOR_UNCLASSIFIED;
  const secLabel = (g: string): string => (g === SAT_SECTOR_UNCLASSIFIED ? g : `${g} ${SAT_KSIC_DIVISION_NAMES[g] ?? "?"}`);

  // ---- 유니버스(K200P는 0단계 블록에서 정의) ----
  const mcapAt = (s: S, d: string): number => s.mcapRow[s.idx.get(d)!];

  // ---- 0단계: 시장 구분(월말 수집 목록) ----
  const mmDl = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).download(MM_PARQUET_PATH);
  if (mmDl.error || !mmDl.data) throw new Error(`${MM_PARQUET_PATH} 없음`);
  const mmBuf = await mmDl.data.arrayBuffer();
  const mmRows = (await parquetReadObjects({ file: mmBuf })) as { trade_date: string; stock_code: string; market: string }[];
  const mmLogDl = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).download(MM_LOG_PATH);
  const mmLog = mmLogDl.data ? (JSON.parse(await mmLogDl.data.text()) as { requests: number; empty: { date: string; market: string }[] }) : { requests: NaN, empty: [] };
  console.log(`\n=== 월말 시장 구분 목록 ===\n${MM_PARQUET_PATH}: ${mmRows.length}행, ${mmBuf.byteLength} B | 수집 기록: 요청 ${mmLog.requests}건, 빈 응답 ${mmLog.empty.length}건`);
  const memb = new Map<string, Map<string, string>>(), both = new Map<string, number>();
  for (const r of mmRows) {
    let m = memb.get(r.trade_date);
    if (!m) { m = new Map(); memb.set(r.trade_date, m); }
    if (m.has(r.stock_code) && m.get(r.stock_code) !== r.market) both.set(r.trade_date, (both.get(r.trade_date) ?? 0) + 1);
    m.set(r.stock_code, r.market);
  }
  const mmTargets: string[] = [];
  for (let k = 0; k < nCal; k++) if (k + 1 === nCal || CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) if (CAL[k].slice(0, 7) >= MM_FROM_MONTH && CAL[k].slice(0, 7) <= MM_TO_MONTH) mmTargets.push(CAL[k]);
  const emptySet = new Set(mmLog.empty.map((e) => `${e.date}|${e.market}`));
  const missing = mmTargets.flatMap((d) => MM_ENDPOINTS.map(([mk]) => mk).filter((mk) => !emptySet.has(`${d}|${mk}`) && ![...(memb.get(d)?.values() ?? [])].includes(mk)).map((mk) => `${d} ${mk}`));
  console.log(`대상 월말 ${mmTargets.length}개 × 2시장, 목록에 없는 (월말, 시장) ${missing.length}개${missing.length ? `: ${missing.slice(0, 20).join(", ")}` : ""}`);
  if (missing.length) { console.log("수집 미완료 → 0단계 판정·실행하지 않음"); return finish(); }

  // 점검 표(연도별 집계)
  console.log("\n=== 점검: 월말 목록 vs 가격 Parquet (연도별 집계) ===\n| 연도 | 월말 수 | 가격 행 종목 수(평균) | 두 시장 어디에도 없음 종목 수 (평균 / 최대) | 없음 시총 비율 % (평균 / 최대) | 두 시장 동시 등장 종목 수(합) |\n|---|---|---|---|---|---|");
  for (let y = Number(MM_FROM_MONTH.slice(0, 4)); y <= Number(MM_TO_MONTH.slice(0, 4)); y++) {
    const ds = mmTargets.filter((d) => d.startsWith(`${y}-`));
    const nP: number[] = [], nN: number[] = [], sh: number[] = [];
    let bothN = 0;
    for (const d of ds) {
      const m = memb.get(d) ?? new Map<string, string>();
      let tot = 0, miss = 0, cnt = 0, nm = 0;
      for (const s of stocks) { const i = s.idx.get(d); if (i === undefined) continue; cnt++; tot += s.mcapRow[i]; if (!m.has(s.code)) { nm++; miss += s.mcapRow[i]; } }
      nP.push(cnt); nN.push(nm); sh.push(tot > 0 ? (miss / tot) * 100 : NaN); bothN += both.get(d) ?? 0;
    }
    const avg = (a: number[]): number => a.reduce((x, z) => x + z, 0) / a.length;
    console.log(`| ${y} | ${ds.length} | ${f2(avg(nP))} | ${f2(avg(nN))} / ${Math.max(...nN)} | ${f2(avg(sh))} / ${f2(Math.max(...sh))} | ${bothN} |`);
  }
  const betaRows = await selectAll<{ stock_code: string; market: string }>("stock_beta", (f, t) => supabaseAdmin.from("stock_beta").select("stock_code, market").order("stock_code").range(f, t));
  const lastM = memb.get(mmTargets[mmTargets.length - 1])!;
  const inBoth = betaRows.filter((r) => lastM.has(r.stock_code));
  console.log(`stock_beta.market(현재 값) vs 최근 월말(${mmTargets[mmTargets.length - 1]}) 목록: stock_beta ${betaRows.length}종목 중 목록에 있음 ${inBoth.length}, 일치 ${inBoth.filter((r) => lastM.get(r.stock_code) === r.market).length} (${f2((inBoth.filter((r) => lastM.get(r.stock_code) === r.market).length / Math.max(inBoth.length, 1)) * 100)}%), 목록에 없음 ${betaRows.length - inBoth.length}`);
  const prevMk = new Map<string, string>(), toKospi: { code: string; d: string }[] = [], toKosdaq: { code: string; d: string }[] = [];
  for (const d of mmTargets) for (const [c, mk] of memb.get(d)!) { const p = prevMk.get(c); if (p === "KOSDAQ" && mk === "KOSPI") toKospi.push({ code: c, d }); if (p === "KOSPI" && mk === "KOSDAQ") toKosdaq.push({ code: c, d }); prevMk.set(c, mk); }
  console.log(`코스닥→코스피 이전(직전 등장 월말 KOSDAQ → 이번 월말 KOSPI) ${toKospi.length}건(종목 ${new Set(toKospi.map((x) => x.code)).size}개), 코스피→코스닥 ${toKosdaq.length}건`);
  console.log(`예시 5개(이전 확인 월말 순): ${toKospi.slice(0, 5).map((x) => `${x.code} ${nameOf.get(x.code) ?? "-"} (${x.d})`).join(", ")}`);
  console.log(`최근 5개: ${toKospi.slice(-5).map((x) => `${x.code} ${nameOf.get(x.code) ?? "-"} (${x.d})`).join(", ")}`);

  const mktAt = (d: string, c: string): string | undefined => memb.get(d)?.get(c);
  const liquidAt = (d: string): { s: S; mcap: number }[] => {
    const e: { s: S; mcap: number }[] = [];
    for (const s of stocks) { const i = s.idx.get(d); if (i !== undefined && s.avgTvRow[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && !excluded.has(s.code)) e.push({ s, mcap: s.mcapRow[i] }); }
    return e.sort((a, b) => b.mcap - a.mcap || (a.s.code < b.s.code ? -1 : 1));
  };
  const kCache = new Map<string, S[]>();
  const kAt = (d: string): S[] => {
    let v = kCache.get(d);
    if (!v) { v = liquidAt(d).filter((x) => mktAt(d, x.s.code) === "KOSPI").slice(0, SMT21_K_SIZE).map((x) => x.s); kCache.set(d, v); }
    return v;
  };
  console.log(`\n=== 0단계(e1ab2e6 게이트, 시장 = 신호일 월말 목록 값) ===\n| 연도 | 신호일 수 | 후보 C(d) 평균 종목 수 | 시장 미상 시총 비율 % (평균) | (최대) | 미상 종목 수 평균 | K200P 평균 종목 수 | K200P 업종 분류 보유 % (시총, 평균) |\n|---|---|---|---|---|---|---|---|`);
  let stage0Ok = true;
  for (let y = Number(firstSignal.slice(0, 4)); y <= Number(dataEnd.slice(0, 4)); y++) {
    const ds = sigs.filter((d) => d.startsWith(`${y}-`));
    const share: number[] = [], nC: number[] = [], nU: number[] = [], nK: number[] = [], ind: number[] = [];
    for (const d of ds) {
      const L = liquidAt(d), K = kAt(d);
      const cut200 = K.length ? mcapAt(K[K.length - 1], d) : Infinity;
      const C = L.filter((x) => x.mcap >= cut200);
      const tot = C.reduce((a, x) => a + x.mcap, 0), unk = C.filter((x) => mktAt(d, x.s.code) === undefined);
      share.push((unk.reduce((a, x) => a + x.mcap, 0) / tot) * 100); nC.push(C.length); nU.push(unk.length); nK.push(K.length);
      const kt = K.reduce((a, s) => a + mcapAt(s, d), 0);
      ind.push((K.filter((s) => indOf.has(s.code)).reduce((a, s) => a + mcapAt(s, d), 0) / kt) * 100);
    }
    const avg = (a: number[]): number => a.reduce((x, z) => x + z, 0) / a.length;
    if (!(avg(share) <= SMT21_STAGE0_MAX_UNKNOWN_PCT)) stage0Ok = false;
    console.log(`| ${y} | ${ds.length} | ${f2(avg(nC))} | ${f2(avg(share))} | ${f2(Math.max(...share))} | ${f2(avg(nU))} | ${f2(avg(nK))} | ${f2(avg(ind))} |`);
  }
  console.log(`0단계 게이트: ${stage0Ok ? `모든 연도 시장 미상 시총 비율 ≤ ${SMT21_STAGE0_MAX_UNKNOWN_PCT}% → v2.1 계산` : `시장 미상 시총 비율 ${SMT21_STAGE0_MAX_UNKNOWN_PCT}% 초과 연도 있음 → 이후 계산하지 않음`}`);
  if (!stage0Ok) return finish();

  // ---- 업종 모멘텀·목표 비중 ----
  const pxLe = (s: S, d: string): { px: number; mcap: number } | null => {
    let lo = 0, hi = s.dates.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (s.dates[m] <= d) { k = m; lo = m + 1; } else hi = m - 1; }
    return k >= 0 && s.close[k] > 0 ? { px: s.close[k], mcap: s.mcapRow[k] } : null;
  };
  const momCache = new Map<string, Map<string, { n: number; mom: number }>>();
  /** 유효 업종(종목 2개 이상)별 모멘텀. 시작 월말이 없으면 빈 맵(전부 중립). */
  const sectorMom = (d: string, L: number): Map<string, { n: number; mom: number }> => {
    const key = `${d}|${L}`;
    let v = momCache.get(key);
    if (v) return v;
    v = new Map();
    const m = meIdx.get(d)!, sI = m - L, eI = m - SMT_SKIP_MONTHS;
    if (sI >= 0) {
      const S0 = monthEnds[sI], E0 = monthEnds[eI];
      const agg = new Map<string, { w: number; wr: number; n: number }>();
      for (const s of kAt(d)) {
        const g = sectorOf(s.code);
        if (g === SAT_SECTOR_UNCLASSIFIED) continue;
        const a = pxLe(s, S0), b = pxLe(s, E0);
        if (!a || !b || !(a.mcap > 0)) continue;
        const e = agg.get(g) ?? { w: 0, wr: 0, n: 0 };
        e.w += a.mcap; e.wr += a.mcap * (b.px / a.px - 1); e.n++;
        agg.set(g, e);
      }
      for (const [g, e] of agg) if (e.n >= SMT_MIN_SECTOR_STOCKS) v.set(g, { n: e.n, mom: e.wr / e.w });
    }
    momCache.set(key, v);
    return v;
  };
  const rankedSectors = (d: string, L: number): string[] => [...sectorMom(d, L)].sort((a, b) => b[1].mom - a[1].mom || (a[0] < b[0] ? -1 : 1)).map((x) => x[0]);

  const buyRate = computeEffectiveBuyPrice(1) - 1;
  const sellRate = (d: string): number => 1 - computeEffectiveSellPrice(1, d, "KR");
  function run(targets: Target[], delay: boolean): Out {
    const execAt = new Map<string, Target>();
    sigs.forEach((d, k) => { const j = calIdx.get(d)! + 1 + (delay ? 1 : 0); if (j < nCal) execAt.set(CAL[j], targets[k]); });
    let cash = 1, prevV = 1;
    const pos = new Map<string, { val: number; last: number }>();
    const out: Out = { dates: [], ret: [], costFrac: [], turn: [], nPos: [], liq: [] };
    for (let c = calIdx.get(firstExec)!; c < nCal; c++) {
      const d = CAL[c];
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
        let buyN = 0, sellN = 0, C = 0;
        // 069500(A 위성 대체)은 편도 0.015% + 0.05%, 거래세 없음. 나머지는 주식 비용.
        const bR = (code: string): number => (code === ETF_CODE ? SAT_ETF_COST_PER_SIDE : buyRate), sR = (code: string): number => (code === ETF_CODE ? SAT_ETF_COST_PER_SIDE : sr);
        for (const [code, p] of pos) if (!tg.has(code)) { sellN += p.val; C += p.val * sR(code); }
        for (const [code, w] of tg) { const diff = w * V - (pos.get(code)?.val ?? 0); if (diff > 0) { buyN += diff; C += diff * bR(code); } else { sellN += -diff; C += -diff * sR(code); } }
        const scale = V > 0 ? (V - C) / V : 1;
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
  function st(o: { dates: string[]; ret: number[]; costFrac?: number[]; turn?: { d: string; v: number }[]; nPos?: number[] }, win: Win) {
    const to = win.to > dataEnd ? dataEnd : win.to;
    const idx: number[] = [];
    for (let i = 0; i < o.dates.length; i++) if (o.dates[i] >= win.from && o.dates[i] <= win.to && o.dates[i] > firstExec) idx.push(i);
    const r = idx.map((i) => o.ret[i]);
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
    const m = r.reduce((a, x) => a + x, 0) / Math.max(r.length, 1);
    const sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(r.length - 1, 1));
    const yrs = Math.max(dayDiff(win.from, to) / 365.25, 1e-9);
    return {
      cagr: computeCagrPct(totalReturnPct, win.from, to), mdd: mddPct, sharpe: sd > 0 ? (m * ETF_TRADING_DAYS_PER_YEAR) / (sd * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR)) : NaN, vol: sd * Math.sqrt(ETF_TRADING_DAYS_PER_YEAR),
      turnover: o.turn ? (o.turn.filter((x) => x.d >= win.from && x.d <= win.to && x.d > firstExec).reduce((a, x) => a + x.v, 0) / (yrs * SMT_MONTHS_PER_YEAR)) * 100 : NaN,
      cost: o.costFrac ? idx.reduce((a, i) => a + o.costFrac![i], 0) * 100 : NaN,
      avgN: o.nPos ? idx.reduce((a, i) => a + o.nPos![i], 0) / Math.max(idx.length, 1) : NaN,
    };
  }
  const yearRet = (o: { dates: string[]; ret: number[] }, y: number): number => computeCumulativeAndMdd(o.ret.filter((_, i) => o.dates[i].startsWith(`${y}-`) && o.dates[i] > firstExec)).totalReturnPct;

  // ---- B&H(가격·총수익), KOSPI ----
  const etfRows = await selectAll<{ trade_date: string; adj_close: number | null; raw_close: number | null }>("etf_daily_prices(069500)", (f, t) => supabaseAdmin.from("etf_daily_prices").select("trade_date, adj_close, raw_close").eq("code", SEASON_STOCK_CODE).order("trade_date").range(f, t));
  const kRetByDate = new Map<string, number>();
  for (let i = 1; i < kospi.length; i++) kRetByDate.set(kospi[i].tradeDate, kospi[i].closePrice / kospi[i - 1].closePrice - 1);
  const cut = (o: { dates: string[]; ret: number[] }): { dates: string[]; ret: number[] } => { const k = o.dates.filter((d) => d <= dataEnd).length; return { dates: o.dates.slice(0, k), ret: o.ret.slice(0, k) }; };
  const clean = (raw0: { date: string; px: number }[], label: string): { dates: string[]; ret: number[] } => {
    const e = raw0.map((x) => ({ ...x }));
    const r = raw0.map((x, i) => (i === 0 ? NaN : x.px / raw0[i - 1].px - 1));
    let nCh = 0;
    for (let t = 1; t + 1 < raw0.length; t++) {
      if (!(Math.abs(r[t]) > ETF_SPIKE_MIN_ABS_RET) || !(Math.sign(r[t + 1]) === -Math.sign(r[t])) || !(Math.abs((1 + r[t]) * (1 + r[t + 1]) - 1) < ETF_SPIKE_MAX_NET_ABS)) continue;
      const kr = kRetByDate.get(raw0[t].date);
      if (kr !== undefined && Math.sign(kr) === Math.sign(r[t]) && Math.abs(kr) >= ETF_SPIKE_KOSPI_EXEMPT_RATIO * Math.abs(r[t])) continue;
      e[t].px = Math.sqrt(raw0[t - 1].px * raw0[t + 1].px); nCh++;
    }
    console.log(`069500 ${label}: ${raw0.length}행 ${raw0[0]?.date}~${raw0[raw0.length - 1]?.date}, 정제로 바꾼 날 ${nCh}개`);
    return cut({ dates: e.slice(1).map((x) => x.date), ret: e.slice(1).map((x, i) => (x.px / e[i].px - 1) * 100) });
  };
  const bhP = clean(etfRows.filter((r) => r.raw_close !== null).map((r) => ({ date: r.trade_date, px: Number(r.raw_close) })), "원주가(raw_close, 가격)");
  const bhT = clean(etfRows.filter((r) => r.adj_close !== null).map((r) => ({ date: r.trade_date, px: Number(r.adj_close) })), "수정주가(adj_close, 총수익)");
  const kp = kospi.filter((x) => x.tradeDate >= "2009-12-01");
  const kos = cut({ dates: kp.slice(1).map((x) => x.tradeDate), ret: computeIndexDailyReturnsPct(kp as never) });

  // ---- 위성 S3 ----
  interface SCfg { L: number; K: number; ew: boolean; N: number }
  /** v3 기본(업종 전 종목, N = 무한). v3.1은 N = 업종별 시총 상위 종목 수. */
  const S_BASE: SCfg = { L: SMT_LOOKBACK_MONTHS, K: KSS_TOP_K, ew: false, N: Infinity };
  const satW = (d: string, top: Set<string> | null, ew: boolean, N = Infinity): Target => {
    const U = kAt(d);
    let mem: S[] = U;
    if (top) {
      const cnt = new Map<string, number>();
      mem = [];
      for (const s of U) { const g = sectorOf(s.code); if (!top.has(g)) continue; const c = cnt.get(g) ?? 0; if (c < N) { mem.push(s); cnt.set(g, c + 1); } }
    }
    const w = new Map<string, number>();
    let tot = 0;
    for (const s of mem) { const x = ew ? 1 : mcapAt(s, d); if (x > 0) { w.set(s.code, x); tot += x; } }
    for (const [k, x] of w) w.set(k, x / tot);
    return { w, n: w.size };
  };
  /** 유효 업종이 없으면(모멘텀 시작 월말 없음) null = K200P 중립. */
  const topSet = (order: string[], K: number): Set<string> | null => (order.length ? new Set(order.slice(0, Math.min(K, order.length))) : null);
  const satTargets = (c: SCfg): Target[] => sigs.map((d) => satW(d, topSet(rankedSectors(d, c.L), c.K), c.ew, c.N));

  type Ser = { dates: string[]; ret: number[] };
  const mix = (SAT: Ser, w: number, etf: Ser): Ser => {
    const by = new Map(etf.dates.map((d, i) => [d, etf.ret[i] / 100]));
    let E = 1 - w, Sv = w, prevV = 1, due = false;
    const out: Ser = { dates: [], ret: [] };
    for (let i = 0; i < SAT.dates.length; i++) {
      const d = SAT.dates[i], c = calIdx.get(d)!;
      if (i > 0) { E *= 1 + (by.get(d) ?? 0); Sv *= 1 + SAT.ret[i] / 100; }
      if (due) { const V = E + Sv, x = Math.abs(Sv - w * V); const C = x * SAT_ETF_COST_PER_SIDE + x * (Sv < w * V ? buyRate : sellRate(d)); E = (1 - w) * (V - C); Sv = w * (V - C); due = false; }
      const V = E + Sv;
      out.dates.push(d); out.ret.push((V / prevV - 1) * 100);
      prevV = V;
      const yearEnd = c + 1 < nCal && CAL[c + 1].slice(0, 4) !== d.slice(0, 4);
      if (yearEnd || Math.abs(Sv / V - w) >= SAT_MIX_BAND) due = true;
    }
    return out;
  };

  // ---- 069500 가상 종목(A 위성 대체용, 원주가) ----
  const etfRawRows = etfRows.filter((r) => r.raw_close !== null && r.trade_date <= dataEnd).map((r) => ({ d: r.trade_date, px: Number(r.raw_close) }));
  {
    const dates = etfRawRows.map((x) => x.d), px = Float64Array.from(etfRawRows.map((x) => x.px));
    byCode.set(ETF_CODE, { code: ETF_CODE, dates, idx: new Map(dates.map((d, i) => [d, i])), close: px, raw: px, mcapRow: new Float64Array(dates.length), avgTvRow: new Float64Array(dates.length), last: dates[dates.length - 1] });
  }
  const trim = (t: Target, thr: number): Target & { etf: boolean } => {
    if (!(thr > 0)) return { ...t, etf: false };
    const keep = [...t.w].filter(([, w]) => w * KSS_DEFAULT_W >= thr);
    if (!keep.length) return { w: new Map([[ETF_CODE, 1]]), n: 0, etf: true };
    const tot = keep.reduce((a, [, w]) => a + w, 0);
    return { w: new Map(keep.map(([c, w]) => [c, w / tot])), n: keep.length, etf: false };
  };
  const C31: SCfg = { ...S_BASE, N: KSS31_PER_SECTOR };
  const trimmedTargets = (c: SCfg, thr: number): (Target & { etf: boolean })[] => satTargets(c).map((t) => trim(t, thr));
  const LEARN: Win = { ...SMT_LEARN }, CONFIRM: Win = { ...LV_CONFIRM }, HOLD: Win = { from: LV_HOLDOUT_FROM, to: "9999-12-31" }, FULL: Win = { from: SMT_LEARN.from, to: "9999-12-31" };
  const GW: [string, Win][] = [["학습", LEARN], ["확인", CONFIRM], ["보류", HOLD]];
  const ALLW: [string, Win][] = [...GW, ["전 기간", FULL]];
  const winTo = (w: Win): string => (w.to > dataEnd ? dataEnd : w.to);
  const avg = (a: number[]): number => a.reduce((x, z) => x + z, 0) / Math.max(a.length, 1);
  const median = (a: number[]): number => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };
  const seedLab = (seed: number): string => `${(seed / 10_000).toLocaleString("ko-KR")}만 원`;
  const worst12 = (o: Ser, win: Win): number => {
    const val = new Map<string, number>();
    let V = 1;
    for (let i = 0; i < o.dates.length; i++) { V *= 1 + o.ret[i] / 100; val.set(o.dates[i], V); }
    const before = o.dates.filter((d) => d < win.from);
    const anchors = [before.length ? before[before.length - 1] : o.dates[0], ...monthEnds.filter((d) => d >= win.from && d <= winTo(win) && val.has(d))];
    let w = Infinity;
    for (let i = 0; i + 12 < anchors.length; i++) w = Math.min(w, (val.get(anchors[i + 12])! / val.get(anchors[i])! - 1) * 100);
    return w;
  };
  const recentRet = (o: Ser): number => { let V = 1; o.dates.forEach((d, i) => { if (d > D_RECENT_FROM && d <= D_RECENT_TO) V *= 1 + o.ret[i] / 100; }); return (V - 1) * 100; };
  const etfRawLe = (d: string): number => { let lo = 0, hi = etfRawRows.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (etfRawRows[m].d <= d) { k = m; lo = m + 1; } else hi = m - 1; } return k >= 0 ? etfRawRows[k].px : NaN; };
  const rawLe = (code: string, d: string): number => {
    const s = byCode.get(code)!;
    const i = s.idx.get(d);
    if (i !== undefined) return s.raw[i];
    let lo = 0, hi = s.dates.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (s.dates[m] <= d) { k = m; lo = m + 1; } else hi = m - 1; }
    return k >= 0 ? s.raw[k] : NaN;
  };
  const etfP = CAL.map((d) => etfRawLe(d));
  const smaAbove = (c: number, N: number): boolean => {
    if (c < N - 1) throw new Error(`${CAL[c]}: 이동평균 ${N}일 자료 부족`);
    let s = 0;
    for (let k = c - N + 1; k <= c; k++) s += etfP[k];
    return etfP[c] > s / N;
  };
  const c0 = calIdx.get(firstSignal)!;
  // ---- 연속 비중 엔진(run()과 같은 비용·청산, 체결 시점은 decide가 정함) ----
  type Decide = (d: string, c: number, V: number, invested: boolean, entered: boolean) => Map<string, number> | undefined;
  interface EOut extends Ser { costFrac: number[]; nPos: number[]; tradeDays: string[]; turn: { d: string; v: number }[] }
  function engine(decide: Decide, lag: number): EOut {
    const pending = new Map<number, Map<string, number>>();
    let cash = 1, prevV = 1, invested = false;
    const pos = new Map<string, { val: number; last: number }>();
    const out: EOut = { dates: [], ret: [], costFrac: [], nPos: [], tradeDays: [], turn: [] };
    for (let c = c0; c < nCal; c++) {
      const d = CAL[c];
      const sr = sellRate(d);
      let costF = 0, entered = false;
      for (const [code, p] of pos) {
        const sk = byCode.get(code)!;
        const i = sk.idx.get(d);
        if (i !== undefined) { p.val = (p.val * sk.close[i]) / p.last; p.last = sk.close[i]; }
        else if (sk.last < d && sk.last < endedBefore) { costF += (p.val * sr) / prevV; cash += p.val * (1 - sr); pos.delete(code); }
      }
      const now = pending.get(c);
      if (now) {
        pending.delete(c);
        let V = cash;
        for (const p of pos.values()) V += p.val;
        const tg = new Map<string, number>();
        for (const [code, w] of now) if (code !== ETF_CODE && byCode.get(code)?.idx.has(d) && w > 0) tg.set(code, w);
        let buyN = 0, sellN = 0, C = 0;
        for (const [code, p] of pos) if (!tg.has(code)) { sellN += p.val; C += p.val * sr; }
        for (const [code, w] of tg) { const diff = w * V - (pos.get(code)?.val ?? 0); if (diff > 0) { buyN += diff; C += diff * buyRate; } else { sellN += -diff; C += -diff * sr; } }
        const scale = V > 0 ? (V - C) / V : 1;
        pos.clear();
        let inv = 0;
        for (const [code, w] of tg) { const sk = byCode.get(code)!; const val = w * V * scale; pos.set(code, { val, last: sk.close[sk.idx.get(d)!] }); inv += val; }
        cash = V - C - inv;
        costF += V > 0 ? C / V : 0;
        if (buyN + sellN > 1e-12) { out.tradeDays.push(d); out.turn.push({ d, v: V > 0 ? (buyN + sellN) / 2 / V : 0 }); }
        entered = !invested && tg.size > 0;
        invested = tg.size > 0;
      }
      let V = cash;
      for (const p of pos.values()) V += p.val;
      if (c > c0) { out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.costFrac.push(costF); out.nPos.push(pos.size); }
      const dec = decide(d, c, V, invested && pos.size > 0, entered);
      if (dec && c + lag < nCal) pending.set(c + lag, dec);
      prevV = V;
    }
    return out;
  }
  const mkTargets = (m: Map<string, Map<string, number>>): Decide => (d) => m.get(d);
  const r2Of = (o: Ser, bench: Ser): { m: string; ex: number; cagr: number } => {
    const bBy = new Map(bench.dates.map((d, i) => [d, bench.ret[i]]));
    const mm = new Map<string, { s: number[]; w: number[]; idx: number[] }>();
    o.dates.forEach((d, i) => { if (d <= firstExec) return; const k = d.slice(0, 7); const e = mm.get(k) ?? { s: [], w: [], idx: [] }; e.s.push(o.ret[i]); e.w.push(bBy.get(d) ?? 0); e.idx.push(i); mm.set(k, e); });
    let best = { m: "", ex: -Infinity };
    for (const [k, e] of mm) { const ex = computeCumulativeAndMdd(e.s).totalReturnPct - computeCumulativeAndMdd(e.w).totalReturnPct; if (ex > best.ex) best = { m: k, ex }; }
    const repl = [...o.ret];
    for (const i of mm.get(best.m)!.idx) repl[i] = bBy.get(o.dates[i]) ?? 0;
    return { ...best, cagr: st({ dates: o.dates, ret: repl }, FULL).cagr };
  };
  const pctOf = (draws: number[], v: number): number => (draws.filter((x) => x < v).length / draws.length) * 100;
  const pairOf = (m: Map<string, number>): number => (m.get("005930") ?? 0) + (m.get("000660") ?? 0);
  const minAcctOf = (m: Map<string, number>, d: string): { v: number; who: string } => { let b = { v: 0, who: "-" }; for (const [code, w] of m) { const v = rawLe(code, d) / w; if (v > b.v) b = { v, who: code }; } return b; };
  const stockBuyMult = computeEffectiveBuyPrice(1), stockSellMult = (d: string): number => computeEffectiveSellPrice(1, d, "KR");
  interface IOut extends Ser { held: number[] }
  function engineInt(decide: Decide, seed: number): IOut {
    const pending = new Map<number, Map<string, number>>();
    let cash = seed, prevV = seed, invested = false;
    const hold = new Map<string, { n: number; ev: number }>();
    const out: IOut = { dates: [], ret: [], held: [] };
    const evOf = (code: string): { eventDate: string; factor: number }[] => adjustments.get(code) ?? [];
    for (let c = c0; c < nCal; c++) {
      const d = CAL[c];
      let entered = false;
      for (const [code, h] of hold) {
        const evs = evOf(code);
        while (h.ev < evs.length && evs[h.ev].eventDate <= d) { h.n /= evs[h.ev].factor; h.ev++; }
        const s = byCode.get(code)!;
        if (!s.idx.has(d) && s.last < d && s.last < endedBefore) { cash += h.n * rawLe(code, d) * stockSellMult(d); hold.delete(code); }
      }
      const now = pending.get(c);
      if (now) {
        pending.delete(c);
        let V = cash;
        for (const [code, h] of hold) V += h.n * rawLe(code, d);
        let w = new Map([...now].filter(([code, x]) => code !== ETF_CODE && x > 0 && byCode.get(code)?.idx.has(d)));
        let tgt = new Map<string, number>();
        for (;;) {
          const tot = [...w.values()].reduce((a, x) => a + x, 0);
          tgt = new Map([...w].map(([code, x]) => [code, Math.floor((V * (x / tot)) / rawLe(code, d))]));
          const zero = [...tgt].filter(([, n]) => n <= 0).map(([code]) => code);
          if (!zero.length || !w.size) break;
          w = new Map([...w].filter(([code]) => !zero.includes(code)));
          if (!w.size) { tgt = new Map(); break; }
        }
        for (const [code, h] of [...hold]) {
          const want = tgt.get(code) ?? 0, px = rawLe(code, d);
          const sellQ = h.n > want ? h.n - want : h.n - Math.floor(h.n);
          if (sellQ > 1e-9) { cash += sellQ * px * stockSellMult(d); h.n -= sellQ; }
          if (h.n <= 1e-9) hold.delete(code);
        }
        const need = [...tgt].map(([code, n]) => ({ code, px: rawLe(code, d), q: Math.max(0, n - Math.round(hold.get(code)?.n ?? 0)) }));
        let cost = need.reduce((a, x) => a + x.q * x.px * stockBuyMult, 0);
        if (cost > cash) { const order = [...need].sort((a, b) => b.px - a.px); for (let i = 0; cost > cash; i = (i + 1) % order.length) { const x = order[i]; if (x.q > 0) { x.q--; cost -= x.px * stockBuyMult; } else if (order.every((y) => y.q === 0)) break; } }
        for (const x of need) {
          if (x.q <= 0) continue;
          cash -= x.q * x.px * stockBuyMult;
          const h = hold.get(x.code);
          if (h) h.n += x.q;
          else { const evs = evOf(x.code); let ev = 0; while (ev < evs.length && evs[ev].eventDate <= d) ev++; hold.set(x.code, { n: x.q, ev }); }
        }
        entered = !invested && hold.size > 0;
        invested = hold.size > 0;
        if (now.size > 0) out.held.push(hold.size);
      }
      let V = cash;
      for (const [code, h] of hold) V += h.n * rawLe(code, d);
      if (c > c0) { out.dates.push(d); out.ret.push((V / prevV - 1) * 100); }
      const dec = decide(d, c, V, invested, entered);
      if (dec && c + 1 < nCal) pending.set(c + 1, dec);
      prevV = V;
    }
    return out;
  }


  // ===================== F (b4378c4) =====================
  // ---- K200P(d): 월말 시장 목록(d 이하 최신) + 유동성·제외 규칙 + 시총 상위 200 ----
  const mmDates = [...memb.keys()].sort();
  const mmFor = (d: string): string | undefined => { let lo = 0, hi = mmDates.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (mmDates[m] <= d) { k = m; lo = m + 1; } else hi = m - 1; } return k >= 0 ? mmDates[k] : undefined; };
  const kwCache = new Map<string, S[]>();
  const kAtW = (d: string): S[] => {
    let v = kwCache.get(d);
    if (!v) { const md = mmFor(d); v = liquidAt(d).filter((x) => md !== undefined && memb.get(md)!.get(x.s.code) === "KOSPI").slice(0, SMT21_K_SIZE).map((x) => x.s); kwCache.set(d, v); }
    return v;
  };
  const shiftMonths = (d: string, m: number): string => {
    const y = Number(d.slice(0, 4)), mo = Number(d.slice(5, 7)) - 1 + m, day = Number(d.slice(8, 10));
    const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, mo, Math.min(day, last))).toISOString().slice(0, 10);
  };
  const rankWCache = new Map<string, string[]>();
  const rankedW = (d: string, L: number): string[] => {
    const key = `${d}|${L}`;
    let v = rankWCache.get(key);
    if (v) return v;
    const S0 = shiftMonths(d, -L), E0 = shiftMonths(d, -SMT_SKIP_MONTHS);
    const agg = new Map<string, { w: number; wr: number; n: number }>();
    for (const s of kAtW(d)) {
      const g = sectorOf(s.code);
      if (g === SAT_SECTOR_UNCLASSIFIED) continue;
      const a = pxLe(s, S0), b = pxLe(s, E0);
      if (!a || !b || !(a.mcap > 0)) continue;
      const e = agg.get(g) ?? { w: 0, wr: 0, n: 0 };
      e.w += a.mcap; e.wr += a.mcap * (b.px / a.px - 1); e.n++;
      agg.set(g, e);
    }
    v = [...agg].filter(([, e]) => e.n >= SMT_MIN_SECTOR_STOCKS).map(([g, e]) => [g, e.wr / e.w] as [string, number]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map((x) => x[0]);
    rankWCache.set(key, v);
    return v;
  };

  // ---- 이동평균 신호(종목 자신의 수정 종가 행 기준) ----
  interface MaSig { above: Uint8Array; dead: Uint8Array; cross: Uint8Array }
  const maCache = new Map<string, Map<string, MaSig>>();
  const maSigs = (sh: number, lg: number): Map<string, MaSig> => {
    const key = `${sh}|${lg}`;
    let v = maCache.get(key);
    if (v) return v;
    v = new Map();
    for (const s of stocks) {
      const n = s.dates.length;
      const pre = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + s.close[i];
      const above = new Uint8Array(n), dead = new Uint8Array(n), cross = new Uint8Array(n);
      let prevDef = false, prevAbove = false;
      for (let i = 0; i < n; i++) {
        if (i + 1 >= lg) {
          const a = (pre[i + 1] - pre[i + 1 - sh]) / sh, b = (pre[i + 1] - pre[i + 1 - lg]) / lg;
          const up = a > b;
          above[i] = up ? 1 : 0;
          dead[i] = a < b ? 1 : 0;
          cross[i] = prevDef && up && !prevAbove ? 1 : 0;
          prevDef = true; prevAbove = up;
        }
      }
      v.set(s.code, { above, dead, cross });
    }
    maCache.set(key, v);
    return v;
  };

  // ===================== W (acd11e3) =====================
  // ---- 주봉 임펄스(직전 완결 주): 1 빨강, 2 파랑, 3 초록, 0 계산 불가 ----
  const everK = new Set<string>();
  for (let c = c0; c < nCal; c++) for (const s of kAtW(CAL[c])) everK.add(s.code);
  console.log(`K200P에 한 번이라도 든 종목 ${everK.size}개`);
  const wkMemo = new Map<string, string>();
  const weekKeyOf = (d: string): string => {
    let v = wkMemo.get(d);
    if (v === undefined) { const t = Date.parse(`${d}T00:00:00Z`); const dow = (new Date(t).getUTCDay() + 6) % 7; v = new Date(t - dow * MS_DAY).toISOString().slice(0, 10); wkMemo.set(d, v); }
    return v;
  };
  const emaArr = (x: ArrayLike<number>, N: number): Float64Array => {
    const a = 2 / (N + 1), o = new Float64Array(x.length);
    if (x.length) o[0] = x[0];
    for (let i = 1; i < x.length; i++) o[i] = a * x[i] + (1 - a) * o[i - 1];
    return o;
  };
  const macdHist = (x: ArrayLike<number>): Float64Array => {
    const f = emaArr(x, H_MACD_FAST), sl = emaArr(x, H_MACD_SLOW), m = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) m[i] = f[i] - sl[i];
    const sg = emaArr(m, H_MACD_SIGNAL), h = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) h[i] = m[i] - sg[i];
    return h;
  };
  const impOf = new Map<string, Uint8Array>();
  for (const code of everK) {
    const s = byCode.get(code)!;
    const n = s.dates.length;
    const wKey: string[] = [], wClose: number[] = [];
    for (let i = 0; i < n; i++) {
      const k = weekKeyOf(s.dates[i]);
      if (wKey.length && wKey[wKey.length - 1] === k) wClose[wClose.length - 1] = s.close[i];
      else { wKey.push(k); wClose.push(s.close[i]); }
    }
    const wEma = emaArr(wClose, H_WEEKLY_EMA), wHist = macdHist(wClose);
    const impW = new Uint8Array(wKey.length);
    for (let w = H_WEEKLY_VALID_FROM; w < wKey.length; w++) {
      const dE = wEma[w] - wEma[w - 1], dH = wHist[w] - wHist[w - 1];
      impW[w] = dE < 0 && dH < 0 ? 1 : dE > 0 && dH > 0 ? 3 : 2;
    }
    const imp = new Uint8Array(n);
    let wi = -1;
    for (let i = 0; i < n; i++) {
      const wk = weekKeyOf(s.dates[i]);
      while (wi + 1 < wKey.length && wKey[wi + 1] < wk) wi++;
      imp[i] = wi >= 0 ? impW[wi] : 0;
    }
    impOf.set(code, imp);
  }

  // ---- 후보·일별 상위 업종 ----
  interface Cand { s: S; code: string; mcap: number; sector: string; imp: number }
  const mkCand = (s: S, i: number): Cand => ({ s, code: s.code, mcap: s.mcapRow[i], sector: sectorOf(s.code), imp: impOf.get(s.code)![i] });
  const crossCache = new Map<string, Cand[][]>();
  const crossDays = (sh: number, lg: number): Cand[][] => {
    const key = `${sh}|${lg}`;
    let v = crossCache.get(key);
    if (v) return v;
    const ms = maSigs(sh, lg);
    const arr: Cand[][] = new Array(nCal);
    for (let c = 0; c < nCal; c++) arr[c] = [];
    for (let c = c0; c < nCal; c++) {
      const d = CAL[c];
      for (const s of kAtW(d)) { const i = s.idx.get(d); if (i !== undefined && ms.get(s.code)!.cross[i]) arr[c].push(mkCand(s, i)); }
    }
    v = arr;
    crossCache.set(key, v);
    return v;
  };
  const topSetCache = new Map<string, Set<string>>();
  const topSetAt = (c: number, N: number): Set<string> => {
    const key = `${c}|${N}`;
    let v = topSetCache.get(key);
    if (!v) { v = new Set(rankedW(CAL[c], SMT_LOOKBACK_MONTHS).slice(0, N)); topSetCache.set(key, v); }
    return v;
  };

  // ---- 선정일·설정 스케줄 ----
  const lastYear = Number(dataEnd.slice(0, 4));
  const selYears: number[] = [];
  for (let y = W_LAG_FIRST_SELECT_YEAR; y <= lastYear; y++) selYears.push(y);
  const selC = selYears.map((y) => CAL.findIndex((d) => d.startsWith(`${y}-`)));
  if (selC.some((x) => x < 0)) throw new Error("선정일(1월 첫 거래일)을 찾지 못한 해가 있음");
  const evalC = selC[selYears.indexOf(W_FIRST_EVAL_YEAR)];
  /** yiOfC[c] = 판단일 c의 설정을 정한 선정 연도의 selYears 인덱스(선정일 < c인 가장 최근, 2015 이전은 -1). */
  const yiOfC = new Int8Array(nCal).fill(-1);
  for (let yi = selYears.indexOf(W_FIRST_EVAL_YEAR); yi < selYears.length; yi++) {
    const to = yi + 1 < selYears.length ? selC[yi + 1] : nCal - 1;
    for (let c = selC[yi] + 1; c <= to; c++) yiOfC[c] = yi;
  }
  const EVAL: Win = { from: CAL[evalC + 1], to: "9999-12-31" };
  const EARLY: Win = { from: EVAL.from, to: W_B_SPLIT_END }, LATE: Win = { from: W_B_LATE_FROM, to: "9999-12-31" };
  const WINS: [string, Win][] = [["평가 구간 전체", EVAL], ["2015~2019", EARLY], ["2020~최신", LATE], ["2022~(참고)", { from: LV_HOLDOUT_FROM, to: "9999-12-31" }]];
  console.log(`선정일 ${selYears.map((y, i) => `${y}:${CAL[selC[i]]}`).join(" ")} | 평가 구간 ${EVAL.from}~${dataEnd}`);
  const cfgAtSched = <T,>(sels: (number | null)[], grid: T[]) => (c: number): T | null => {
    const yi = yiOfC[c];
    if (yi < 0) return null;
    const k = sels[yi];
    return k === null || k === undefined ? null : grid[k];
  };

  // ---- 공통 출력 형태 ----
  interface WTrade { code: string; entryC: number; exitC: number; spend: number; proceeds: number; vAtEntry: number; frac: number; entryRaw: number }
  interface RunOut extends Ser { costFrac: number[]; nPos: number[]; turn: { d: string; v: number }[]; inv: number[]; entryCs: number[]; wPair: number[]; trades: WTrade[] }
  const bhRet = new Map(bhP.dates.map((d, i) => [d, bhP.ret[i] / 100]));

  // ---- W1 시뮬레이터(F/H의 simF와 같은 규칙, 설정이 날짜별로 바뀔 수 있음) ----
  interface W1Cfg { sh: number; lg: number; topN: number; K: number; stop: number; trail: number; imp: boolean }
  const candMemo = new Map<string, Map<number, Cand[]>>();
  const candsW1 = (cfg: W1Cfg, c: number): Cand[] => {
    const base = crossDays(cfg.sh, cfg.lg)[c];
    if (!base.length) return base;
    const key = `${cfg.sh}|${cfg.lg}|${cfg.topN}|${cfg.imp}`;
    let m = candMemo.get(key);
    if (!m) { m = new Map(); candMemo.set(key, m); }
    let v = m.get(c);
    if (!v) { const top = topSetAt(c, cfg.topN); v = base.filter((x) => top.has(x.sector) && (!cfg.imp || x.imp !== 1)); m.set(c, v); }
    return v;
  };
  interface W1Opts { lag: number; int?: number; replace?: Set<string>; detail?: boolean }
  function simW1(cfgAt: (c: number) => W1Cfg | null, o: W1Opts): RunOut {
    const int = o.int !== undefined;
    const cap = int ? (o.int as number) : 1;
    interface Pos { code: string; s: S; shares: number; lastPx: number; entryC: number; entryAdj: number; entryRaw: number; peak: number; spend: number; vAtEntry: number; frac: number; ev: number; rep: boolean; repVal: number; exitSched: boolean }
    const pos = new Map<string, Pos>();
    const pendExit = new Map<number, Set<string>>();
    const pendEnt = new Map<number, { list: Cand[]; free: number; frac: number }[]>();
    let reserved = 0, cash = cap, prevV = cap;
    const lastExit = new Map<string, number>();
    const out: RunOut = { dates: [], ret: [], costFrac: [], nPos: [], turn: [], inv: [], entryCs: [], wPair: [], trades: [] };
    const posValue = (p: Pos): number => (p.rep ? p.repVal : p.shares * p.lastPx);
    const evOf = (code: string): { eventDate: string; factor: number }[] => adjustments.get(code) ?? [];
    const closePos = (p: Pos, c: number, sr: number): number => {
      const val = posValue(p);
      cash += val * (1 - sr);
      out.trades.push({ code: p.code, entryC: p.entryC, exitC: c, spend: p.spend, proceeds: val * (1 - sr), vAtEntry: p.vAtEntry, frac: p.frac, entryRaw: p.entryRaw });
      pos.delete(p.code);
      lastExit.set(p.code, c);
      return val;
    };
    const sched = (c: number, code: string): void => { const m = pendExit.get(c) ?? new Set<string>(); m.add(code); pendExit.set(c, m); };
    for (let c = c0; c < nCal; c++) {
      const d = CAL[c], sr = sellRate(d);
      let costF = 0, buyN = 0, sellN = 0;
      for (const p of [...pos.values()]) {
        const i = p.s.idx.get(d);
        if (int) { const evs = evOf(p.code); while (p.ev < evs.length && evs[p.ev].eventDate <= d) { p.shares /= evs[p.ev].factor; p.ev++; } }
        if (i !== undefined) { p.lastPx = int ? p.s.raw[i] : p.s.close[i]; if (p.rep) p.repVal *= 1 + (bhRet.get(d) ?? 0); }
        else if (p.s.last < d && p.s.last < endedBefore) { const v = closePos(p, c, sr); costF += (v * sr) / prevV; sellN += v; }
      }
      const ex = pendExit.get(c);
      if (ex) {
        pendExit.delete(c);
        for (const code of ex) {
          const p = pos.get(code);
          if (!p) continue;
          if (!p.s.idx.has(d)) { sched(c + 1, code); continue; }
          const v = closePos(p, c, sr);
          costF += (v * sr) / prevV; sellN += v;
        }
      }
      const en = pendEnt.get(c);
      if (en) {
        pendEnt.delete(c);
        let V = cash;
        for (const p of pos.values()) V += posValue(p);
        for (const { list, free, frac } of en) {
          reserved -= free;
          let filled = 0;
          for (const cd of list) {
            if (filled >= free) break;
            if (pos.has(cd.code)) continue;
            const i = cd.s.idx.get(d);
            if (i === undefined) continue;
            const amt = Math.min(frac * V, cash);
            if (!(amt > 0)) continue;
            const adj = cd.s.close[i], rawPx = cd.s.raw[i];
            let shares: number, spend: number, lastPx: number;
            if (int) { shares = Math.floor(amt / (rawPx * stockBuyMult)); if (shares < 1) continue; spend = shares * rawPx * stockBuyMult; lastPx = rawPx; }
            else { spend = amt; shares = amt / (adj * stockBuyMult); lastPx = adj; }
            cash -= spend; buyN += spend; costF += (spend - shares * lastPx) / prevV;
            const evs = evOf(cd.code);
            let ev = 0;
            while (ev < evs.length && evs[ev].eventDate <= d) ev++;
            const rep = !!o.replace?.has(`${cd.code}|${c}`);
            pos.set(cd.code, { code: cd.code, s: cd.s, shares, lastPx, entryC: c, entryAdj: adj, entryRaw: rawPx, peak: adj, spend, vAtEntry: V, frac, ev, rep, repVal: shares * lastPx, exitSched: false });
            out.entryCs.push(c);
            filled++;
          }
        }
      }
      let V = cash;
      for (const p of pos.values()) V += posValue(p);
      if (c > c0) {
        out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.costFrac.push(costF); out.nPos.push(pos.size);
        out.inv.push(V > 0 ? (V - cash) / V : 0);
        if (buyN + sellN > 1e-12) out.turn.push({ d, v: prevV > 0 ? (buyN + sellN) / 2 / prevV : 0 });
        if (o.detail) {
          let pair = 0;
          for (const p of pos.values()) if (p.code === "005930" || p.code === "000660") pair += posValue(p);
          out.wPair.push(V > 0 ? pair / V : 0);
        }
      }
      if (c + o.lag < nCal) {
        const cfg = cfgAt(c);
        if (cfg === null) {
          for (const p of pos.values()) if (!p.exitSched && p.s.idx.has(d)) { p.exitSched = true; sched(c + o.lag, p.code); }
        } else {
          const ms = maSigs(cfg.sh, cfg.lg);
          for (const p of pos.values()) {
            if (p.exitSched) continue;
            const i = p.s.idx.get(d);
            if (i === undefined) continue;
            const adj = p.s.close[i];
            p.peak = Math.max(p.peak, adj);
            if (adj <= Math.max(p.entryAdj * (1 - cfg.stop), p.peak * (1 - cfg.trail)) || ms.get(p.code)!.dead[i]) { p.exitSched = true; sched(c + o.lag, p.code); }
          }
          const free = cfg.K - pos.size - reserved;
          if (free > 0) {
            const list = candsW1(cfg, c).filter((x) => !pos.has(x.code) && (lastExit.get(x.code) === undefined || c - (lastExit.get(x.code) as number) >= F_COOLDOWN));
            if (list.length) {
              const arr = pendEnt.get(c + o.lag) ?? [];
              arr.push({ list, free, frac: 1 / cfg.K });
              pendEnt.set(c + o.lag, arr);
              reserved += free;
            }
          }
        }
      }
      prevV = V;
    }
    return out;
  }

  // ---- W2: 월간 업종 모멘텀 집중형(위성 100%) ----
  interface W2Cfg { L: number; skip: number; nSec: number; per: number; ew: boolean; cashF: boolean }
  const sigSet = new Set(sigs);
  const rankMomCache = new Map<string, [string, number][]>();
  const rankMom = (d: string, L: number, skip: number): [string, number][] => {
    const key = `${d}|${L}|${skip}`;
    let v = rankMomCache.get(key);
    if (v) return v;
    const S0 = shiftMonths(d, -L), E0 = skip === 0 ? d : shiftMonths(d, -skip);
    const agg = new Map<string, { w: number; wr: number; n: number }>();
    for (const s of kAtW(d)) {
      const g = sectorOf(s.code);
      if (g === SAT_SECTOR_UNCLASSIFIED) continue;
      const a = pxLe(s, S0), b = pxLe(s, E0);
      if (!a || !b || !(a.mcap > 0)) continue;
      const e = agg.get(g) ?? { w: 0, wr: 0, n: 0 };
      e.w += a.mcap; e.wr += a.mcap * (b.px / a.px - 1); e.n++;
      agg.set(g, e);
    }
    v = [...agg].filter(([, e]) => e.n >= SMT_MIN_SECTOR_STOCKS).map(([g, e]) => [g, e.wr / e.w] as [string, number]).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    rankMomCache.set(key, v);
    return v;
  };
  const w2Memo = new Map<string, Map<string, number>>();
  const w2Target = (cfg: W2Cfg, d: string): Map<string, number> => {
    const key = `${cfg.L}|${cfg.skip}|${cfg.nSec}|${cfg.per}|${cfg.ew}|${cfg.cashF}|${d}`;
    let v = w2Memo.get(key);
    if (v) return v;
    v = new Map();
    const rk = rankMom(d, cfg.L, cfg.skip);
    const top = rk.slice(0, cfg.nSec);
    if (top.length && !(cfg.cashF && top.every(([, m]) => m < 0))) {
      const names: { s: S; x: number }[] = [];
      const U = kAtW(d);
      for (const [g] of top) {
        let cnt = 0;
        for (const s of U) if (sectorOf(s.code) === g && cnt < cfg.per) { names.push({ s, x: cfg.ew ? 1 : mcapAt(s, d) }); cnt++; }
      }
      const tot0 = names.reduce((a, n) => a + n.x, 0);
      const keep = names.filter((n) => n.x / tot0 >= KSS32_TRIM_MIN_WEIGHT / KSS_DEFAULT_W);
      const tot = keep.reduce((a, n) => a + n.x, 0);
      for (const n of keep) v.set(n.s.code, n.x / tot);
    }
    w2Memo.set(key, v);
    return v;
  };
  type Decide2 = (d: string, c: number) => Map<string, number> | undefined;
  function engineW(decide: Decide2, lag: number): RunOut {
    const pending = new Map<number, Map<string, number>>();
    let cash = 1, prevV = 1;
    const pos = new Map<string, { val: number; last: number }>();
    const out: RunOut = { dates: [], ret: [], costFrac: [], nPos: [], turn: [], inv: [], entryCs: [], wPair: [], trades: [] };
    for (let c = c0; c < nCal; c++) {
      const d = CAL[c];
      const sr = sellRate(d);
      let costF = 0, buyN = 0, sellN = 0;
      for (const [code, p] of pos) {
        const sk = byCode.get(code)!;
        const i = sk.idx.get(d);
        if (i !== undefined) { p.val = (p.val * sk.close[i]) / p.last; p.last = sk.close[i]; }
        else if (sk.last < d && sk.last < endedBefore) { costF += (p.val * sr) / prevV; cash += p.val * (1 - sr); sellN += p.val; pos.delete(code); }
      }
      const now = pending.get(c);
      if (now) {
        pending.delete(c);
        let V = cash;
        for (const p of pos.values()) V += p.val;
        const tg = new Map<string, number>();
        for (const [code, w] of now) if (byCode.get(code)?.idx.has(d) && w > 0) tg.set(code, w);
        let C = 0;
        for (const [code, p] of pos) if (!tg.has(code)) { sellN += p.val; C += p.val * sr; }
        for (const [code, w] of tg) { const diff = w * V - (pos.get(code)?.val ?? 0); if (diff > 0) { buyN += diff; C += diff * buyRate; } else { sellN += -diff; C += -diff * sr; } }
        const scale = V > 0 ? (V - C) / V : 1;
        const had = new Set(pos.keys());
        pos.clear();
        let invested = 0;
        for (const [code, w] of tg) { const sk = byCode.get(code)!; const val = w * V * scale; pos.set(code, { val, last: sk.close[sk.idx.get(d)!] }); invested += val; if (!had.has(code)) out.entryCs.push(c); }
        cash = V - C - invested;
        costF += V > 0 ? C / V : 0;
      }
      let V = cash;
      for (const p of pos.values()) V += p.val;
      if (c > c0) {
        out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.costFrac.push(costF); out.nPos.push(pos.size);
        out.inv.push(V > 0 ? (V - cash) / V : 0);
        out.wPair.push(V > 0 ? ((pos.get("005930")?.val ?? 0) + (pos.get("000660")?.val ?? 0)) / V : 0);
        if (buyN + sellN > 1e-12) out.turn.push({ d, v: prevV > 0 ? (buyN + sellN) / 2 / prevV : 0 });
      }
      const dec = decide(d, c);
      if (dec && c + lag < nCal) pending.set(c + lag, dec);
      prevV = V;
    }
    return out;
  }
  /** 정수 주 W2(목표 비중 내림, 1주 미만 종목 제외 후 재정규화, 남는 돈 현금). 일별 보유 종목 수를 함께 기록. */
  function engineIntW(decide: Decide2, seed: number): Ser & { nPos: number[] } {
    const pending = new Map<number, Map<string, number>>();
    let cash = seed, prevV = seed;
    const hold = new Map<string, { n: number; ev: number }>();
    const out: Ser & { nPos: number[] } = { dates: [], ret: [], nPos: [] };
    const evOf = (code: string): { eventDate: string; factor: number }[] => adjustments.get(code) ?? [];
    for (let c = c0; c < nCal; c++) {
      const d = CAL[c];
      for (const [code, h] of hold) {
        const evs = evOf(code);
        while (h.ev < evs.length && evs[h.ev].eventDate <= d) { h.n /= evs[h.ev].factor; h.ev++; }
        const s = byCode.get(code)!;
        if (!s.idx.has(d) && s.last < d && s.last < endedBefore) { cash += h.n * rawLe(code, d) * stockSellMult(d); hold.delete(code); }
      }
      const now = pending.get(c);
      if (now) {
        pending.delete(c);
        let V = cash;
        for (const [code, h] of hold) V += h.n * rawLe(code, d);
        let w = new Map([...now].filter(([code, x]) => x > 0 && byCode.get(code)?.idx.has(d)));
        let tgt = new Map<string, number>();
        for (;;) {
          const tot = [...w.values()].reduce((a, x) => a + x, 0);
          tgt = new Map([...w].map(([code, x]) => [code, Math.floor((V * (x / tot)) / rawLe(code, d))]));
          const zero = [...tgt].filter(([, n]) => n <= 0).map(([code]) => code);
          if (!zero.length || !w.size) break;
          w = new Map([...w].filter(([code]) => !zero.includes(code)));
          if (!w.size) { tgt = new Map(); break; }
        }
        for (const [code, h] of [...hold]) {
          const want = tgt.get(code) ?? 0, px = rawLe(code, d);
          const sellQ = h.n > want ? h.n - want : h.n - Math.floor(h.n);
          if (sellQ > 1e-9) { cash += sellQ * px * stockSellMult(d); h.n -= sellQ; }
          if (h.n <= 1e-9) hold.delete(code);
        }
        const need = [...tgt].map(([code, n]) => ({ code, px: rawLe(code, d), q: Math.max(0, n - Math.round(hold.get(code)?.n ?? 0)) }));
        let cost = need.reduce((a, x) => a + x.q * x.px * stockBuyMult, 0);
        if (cost > cash) { const order = [...need].sort((a, b) => b.px - a.px); for (let i = 0; cost > cash; i = (i + 1) % order.length) { const x = order[i]; if (x.q > 0) { x.q--; cost -= x.px * stockBuyMult; } else if (order.every((y) => y.q === 0)) break; } }
        for (const x of need) {
          if (x.q <= 0) continue;
          cash -= x.q * x.px * stockBuyMult;
          const h = hold.get(x.code);
          if (h) h.n += x.q;
          else { const evs = evOf(x.code); let ev = 0; while (ev < evs.length && evs[ev].eventDate <= d) ev++; hold.set(x.code, { n: x.q, ev }); }
        }
      }
      let V = cash;
      for (const [code, h] of hold) V += h.n * rawLe(code, d);
      if (c > c0) { out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.nPos.push(hold.size); }
      const dec = decide(d, c);
      if (dec && c + 1 < nCal) pending.set(c + 1, dec);
      prevV = V;
    }
    return out;
  }

  // ---- 격자·이웃·가족 정의 ----
  const pctTxt = (x: number): string => `${Math.round(x * 1000) / 10}%`;
  interface Fam<T> {
    id: string; no: number; title: string;
    grid: T[]; coords: number[][]; dimNames: string[]; nbr: number[][];
    label: (t: T) => string;
    runFixed: (i: number, lag: number) => RunOut;
    runSched: (sels: (number | null)[], lag: number, o?: { detail?: boolean; replace?: Set<string> }) => RunOut;
    runInt: (sels: (number | null)[], seed: number) => Ser & { nPos: number[] };
    r2: (out: RunOut, sels: (number | null)[]) => { desc: string; cagr: number };
    minCaps: (out: RunOut, sels: (number | null)[]) => number[];
  }
  const buildNbr = (coords: number[][], sizes: number[]): number[][] => {
    const at = new Map(coords.map((c, i) => [c.join(","), i]));
    return coords.map((c) => {
      const out: number[] = [];
      for (let dm = 0; dm < sizes.length; dm++) for (const dv of [-1, 1]) {
        const k = c[dm] + dv;
        if (k < 0 || k >= sizes[dm]) continue;
        const cc = [...c]; cc[dm] = k;
        out.push(at.get(cc.join(","))!);
      }
      return out;
    });
  };
  const grid1: W1Cfg[] = [], coords1: number[][] = [];
  W1_MA_PAIRS.forEach(([sh, lg], a) => W1_TOPS.forEach((topN, b) => W1_POS.forEach((K, k) => W1_STOPS.forEach((stop, s) => W1_TRAILS.forEach((trail, t) => W1_IMPULSE.forEach((imp, m) => { grid1.push({ sh, lg, topN, K, stop, trail, imp }); coords1.push([a, b, k, s, t, m]); }))))));
  const sizes1 = [W1_MA_PAIRS.length, W1_TOPS.length, W1_POS.length, W1_STOPS.length, W1_TRAILS.length, W1_IMPULSE.length];
  const grid2: W2Cfg[] = [], coords2: number[][] = [];
  W2_MOMS.forEach(([L, skip], a) => W2_SECTORS.forEach((nSec, b) => W2_PER.forEach((per, k) => W2_WEIGHTS.forEach((w, s) => W2_CASH_FILTER.forEach((cashF, t) => { grid2.push({ L, skip, nSec, per, ew: w === "equal", cashF }); coords2.push([a, b, k, s, t]); })))));
  const sizes2 = [W2_MOMS.length, W2_SECTORS.length, W2_PER.length, W2_WEIGHTS.length, W2_CASH_FILTER.length];
  console.log(`격자: W1 ${grid1.length}점, W2 ${grid2.length}점`);

  const periodOf = (o: Ser, fromExcl: string, toIncl: string): { ret: number; mdd: number } => {
    const r = o.ret.filter((_, i) => o.dates[i] > fromExcl && o.dates[i] <= toIncl);
    const x = computeCumulativeAndMdd(r);
    return { ret: x.totalReturnPct, mdd: x.mddPct };
  };
  const monthRetMap = (o: Ser): Map<string, { idx: number[]; ret: number }> => {
    const mm = new Map<string, { idx: number[]; ret: number }>();
    o.dates.forEach((d, i) => { if (d <= CAL[evalC]) return; const k = d.slice(0, 7); const e = mm.get(k) ?? { idx: [], ret: 0 }; e.idx.push(i); mm.set(k, e); });
    for (const e of mm.values()) e.ret = computeCumulativeAndMdd(e.idx.map((i) => o.ret[i])).totalReturnPct;
    return mm;
  };
  const fam1: Fam<W1Cfg> = {
    id: "W1", no: W_PRIOR_TESTS + 1, title: "일별 추세추종(골든크로스 ∩ 상위 N업종, 손절·트레일링·데드크로스, 임펄스 on/off) 워크포워드",
    grid: grid1, coords: coords1, dimNames: ["이동평균", "상위 업종 수", "동시 보유", "손절", "트레일링", "임펄스"], nbr: buildNbr(coords1, sizes1),
    label: (t) => `MA ${t.sh}/${t.lg} · 상위 ${t.topN}업종 · ${t.K}종목 · 손절 ${pctTxt(t.stop)} · 트레일링 ${pctTxt(t.trail)} · 임펄스 ${t.imp ? "on" : "off"}`,
    runFixed: (i, lag) => simW1(() => grid1[i], { lag }),
    runSched: (sels, lag, o) => simW1(cfgAtSched(sels, grid1), { lag, detail: o?.detail, replace: o?.replace }),
    runInt: (sels, seed) => simW1(cfgAtSched(sels, grid1), { lag: 1, int: seed }),
    r2: (out, sels) => {
      const top3 = [...out.trades].sort((a, b) => (b.proceeds - b.spend) / b.vAtEntry - (a.proceeds - a.spend) / a.vAtEntry).slice(0, W_E_TOP);
      const rep = new Set(top3.map((t) => `${t.code}|${t.entryC}`));
      const o2 = simW1(cfgAtSched(sels, grid1), { lag: 1, replace: rep });
      return { desc: top3.map((t) => `${t.code} ${nameOf.get(t.code) ?? ""} ${CAL[t.entryC]}~${CAL[t.exitC]} 수익률 ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", "), cagr: st(o2, EVAL).cagr };
    },
    minCaps: (out) => out.trades.filter((t) => CAL[t.entryC].slice(0, 7) >= KSS31_PRACTICAL_FROM).map((t) => t.entryRaw / t.frac),
  };
  const decide2 = (sels: (number | null)[]): Decide2 => (d, c) => {
    if (!sigSet.has(d)) return undefined;
    const yi = yiOfC[c];
    if (yi < 0) return undefined;
    const k = sels[yi];
    return k === null || k === undefined ? new Map() : w2Target(grid2[k], d);
  };
  const fam2: Fam<W2Cfg> = {
    id: "W2", no: W_PRIOR_TESTS + 2, title: "월간 업종 모멘텀 집중형(위성 100%, ETF 없음) 워크포워드",
    grid: grid2, coords: coords2, dimNames: ["모멘텀(기간,건너뛰기)", "업종 수", "업종당 종목 수", "가중", "현금 필터"], nbr: buildNbr(coords2, sizes2),
    label: (t) => `모멘텀 (${t.L},${t.skip}) · 업종 ${t.nSec} · 업종당 ${t.per} · ${t.ew ? "동일" : "시총"}가중 · 현금필터 ${t.cashF ? "on" : "off"}`,
    runFixed: (i, lag) => engineW((d) => (sigSet.has(d) ? w2Target(grid2[i], d) : undefined), lag),
    runSched: (sels, lag) => engineW(decide2(sels), lag),
    runInt: (sels, seed) => engineIntW(decide2(sels), seed),
    r2: (out) => {
      const mm = monthRetMap(out);
      const bBy = new Map(bhP.dates.map((d, i) => [d, bhP.ret[i]]));
      const ex = [...mm].map(([k, e]) => ({ k, e, ex: e.ret - computeCumulativeAndMdd(e.idx.map((i) => bBy.get(out.dates[i]) ?? 0)).totalReturnPct })).sort((a, b) => b.ex - a.ex).slice(0, W_E_TOP);
      const repl = [...out.ret];
      for (const x of ex) for (const i of x.e.idx) repl[i] = bBy.get(out.dates[i]) ?? 0;
      return { desc: ex.map((x) => `${x.k} (전략 ${f2(x.e.ret)}% − 069500 ${f2(x.e.ret - x.ex)}% = 초과 ${f2(x.ex)}%p)`).join(", "), cagr: st({ dates: out.dates, ret: repl }, EVAL).cagr };
    },
    minCaps: (_o, sels) => {
      const v: number[] = [];
      for (const d of sigs) {
        if (d.slice(0, 7) < KSS31_PRACTICAL_FROM || d >= dataEnd) continue;
        const yi = yiOfC[calIdx.get(d)!];
        if (yi < 0) continue;
        const k = sels[yi];
        if (k === null || k === undefined) continue;
        const t = w2Target(grid2[k], d);
        if (t.size) v.push(Math.max(...[...t].map(([code, w]) => rawLe(code, d) / w)));
      }
      return v;
    },
  };

  // ---- 점수 요약(고정 설정 한 경로 → 선정 연도별) ----
  interface YSum { score: number | null; ent: number; nxt: number }
  const summarize = (r: RunOut): YSum[] => {
    const n = r.ret.length;
    const eq = new Float64Array(n), pk = new Float64Array(n), md = new Float64Array(n);
    let e = 1, p = 1, m = 0;
    for (let i = 0; i < n; i++) {
      e *= 1 + r.ret[i] / 100;
      if (e > p) p = e;
      const dd = (p - e) / p;
      if (dd > m) m = dd;
      eq[i] = e; pk[i] = p; md[i] = m;
    }
    return selYears.map((_, yi) => {
      const sC = selC[yi], i = sC - c0 - 1;
      const eqAdj = eq[i] * (1 - r.inv[i] * sellRate(CAL[sC]));
      const peak = Math.max(i > 0 ? pk[i - 1] : 1, eqAdj);
      const mddPct = Math.max(i > 0 ? md[i - 1] : 0, 1 - eqAdj / peak) * 100;
      const cagr = computeCagrPct((eqAdj - 1) * 100, CAL[c0], CAL[sC]);
      let ent = 0;
      for (const c of r.entryCs) { if (c <= sC) ent++; else break; }
      const endI = yi + 1 < selYears.length ? selC[yi + 1] - c0 - 1 : n - 1;
      return { score: ent >= W_MIN_ENTRIES_SCORE ? cagr / Math.max(mddPct, W_CALMAR_MDD_FLOOR_PCT) : null, ent, nxt: (eq[endI] / eq[i] - 1) * 100 };
    });
  };
  interface Pick { idx: number; fin: number; own: number; nEl: number }
  const finalScores = (nbr: number[][], sc: (number | null)[]): { fin: (number | null)[]; nb: number[] } => {
    const fin: (number | null)[] = [], nb: number[] = [];
    for (let i = 0; i < sc.length; i++) {
      if (sc[i] === null) { fin.push(null); nb.push(-Infinity); continue; }
      const ns = nbr[i].map((j) => sc[j]).filter((x): x is number => x !== null);
      const sNb = ns.reduce((a, x) => a + x, 0);
      fin.push(((sc[i] as number) + sNb) / (1 + ns.length));
      nb.push(ns.length ? sNb / ns.length : -Infinity);
    }
    return { fin, nb };
  };
  const pickBest = (nbr: number[][], sc: (number | null)[]): Pick | null => {
    const { fin, nb } = finalScores(nbr, sc);
    let best: Pick | null = null, bnb = -Infinity;
    for (let i = 0; i < sc.length; i++) {
      const f = fin[i];
      if (f === null) continue;
      if (!best || f > best.fin + 1e-12 || (Math.abs(f - best.fin) <= 1e-12 && nb[i] > bnb + 1e-12)) { best = { idx: i, fin: f, own: sc[i] as number, nEl: 0 }; bnb = nb[i]; }
    }
    if (best) best.nEl = sc.filter((x) => x !== null).length;
    return best;
  };
  const rankArr = (a: number[]): number[] => {
    const ix = a.map((_, i) => i).sort((x, y) => a[x] - a[y]);
    const r = new Array<number>(a.length);
    for (let i = 0; i < ix.length;) {
      let j = i;
      while (j + 1 < ix.length && a[ix[j + 1]] === a[ix[i]]) j++;
      for (let k = i; k <= j; k++) r[ix[k]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const pearson = (x: number[], y: number[]): number => {
    const n = x.length;
    if (n < 3) return NaN;
    const mx = avg(x), my = avg(y);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
  };
  const spearman = (x: number[], y: number[]): number => pearson(rankArr(x), rankArr(y));

  const bFull = st(bhP, EVAL);
  const epsM = SAT_MDD_EPS;
  const bonfW = 100 * (1 - 0.05 / W_TESTS);
  const summaryW: string[] = [];
  const pairKey = (a: number | null, b: number | null): boolean => a !== null && a === b;

  function runFamily<T>(fam: Fam<T>): void {
    const t1 = Date.now();
    console.log(`\n##### ${fam.id} (시험 ${fam.no}) — ${fam.title} #####`);
    // 1) 격자 전체 한 번씩(체결 지연 1·2) → 선정 연도별 요약
    const sums: YSum[][][] = [[], []];
    for (const lag of [1, 2]) {
      for (let i = 0; i < fam.grid.length; i++) {
        sums[lag - 1].push(summarize(fam.runFixed(i, lag)));
        if ((i + 1) % 100 === 0) console.log(`  [${fam.id}] 격자 계산 lag ${lag}: ${i + 1}/${fam.grid.length} (${((Date.now() - t1) / 60000).toFixed(1)}분)`);
      }
    }
    const picks = [1, 2].map((lag) => selYears.map((_, yi) => pickBest(fam.nbr, sums[lag - 1].map((s) => s[yi].score))));
    const sels1 = picks[0].map((p) => (p ? p.idx : null)), sels2 = picks[1].map((p) => (p ? p.idx : null));
    const selsLag: (number | null)[] = selYears.map((_, yi) => (yi >= 1 ? sels1[yi - 1] : null));
    // 2) 이어 붙인 시뮬레이션
    const wf = fam.runSched(sels1, 1, { detail: true }), wfD = fam.runSched(sels2, 2), wfL = fam.runSched(selsLag, 1);
    const evalYi = selYears.indexOf(W_FIRST_EVAL_YEAR);

    // 선정 설정 표(연도별)
    console.log(`\n${fam.id} 해마다 선정된 설정과 그 해 실제 성적 (선정 직전 과거 구간 = 2010-06-30 ~ 선정일 종가, 보유 포지션은 선정일 종가 청산 가정으로 평가)\n| 선정 연도 | 선정일 | 선정 설정 | 원점수(Calmar) | 최종 점수(이웃 평균) | 진입 건수 | 점수 있는 격자점 | 이어 붙인 결과 수익률 % / MDD % | 선정 설정 단독 수익률 % | 점수 있는 격자점 단독 수익률 중앙값 % | 069500 원주가 수익률 % |\n|---|---|---|---|---|---|---|---|---|---|---|`);
    const yrRows: { y: number; fin: number; own: number; stRet: number; wfRet: number; nxt: number; medNxt: number }[] = [];
    for (let yi = evalYi; yi < selYears.length; yi++) {
      const y = selYears[yi], p = picks[0][yi];
      const from = CAL[selC[yi]], to = yi + 1 < selYears.length ? CAL[selC[yi + 1]] : dataEnd;
      const w = periodOf(wf, from, to), b = periodOf(bhP, from, to);
      if (p) {
        const nxts = sums[0].map((s) => s[yi]).filter((s) => s.score !== null).map((s) => s.nxt);
        const sm = sums[0][p.idx][yi];
        yrRows.push({ y, fin: p.fin, own: p.own, stRet: sm.nxt, wfRet: w.ret, nxt: sm.nxt, medNxt: median(nxts) });
        console.log(`| ${y} | ${from} | ${fam.label(fam.grid[p.idx])} | ${f2(p.own)} | ${f2(p.fin)} | ${sm.ent} | ${p.nEl} | ${f2(w.ret)} / ${f2(w.mdd)} | ${f2(sm.nxt)} | ${f2(median(nxts))} | ${f2(b.ret)} |`);
      } else console.log(`| ${y} | ${from} | (점수 있는 격자점 없음 → 현금) | - | - | - | 0 | ${f2(w.ret)} / ${f2(w.mdd)} | - | - | ${f2(b.ret)} |`);
    }
    // 안정성
    let same = 0, pairs = 0;
    const chg = fam.dimNames.map(() => 0);
    for (let yi = evalYi + 1; yi < selYears.length; yi++) {
      const a = sels1[yi - 1], b = sels1[yi];
      pairs++;
      if (pairKey(a, b)) same++;
      if (a !== null && b !== null) fam.dimNames.forEach((_, dm) => { if (fam.coords[a][dm] !== fam.coords[b][dm]) chg[dm]++; });
    }
    const nCashYears = sels1.slice(evalYi).filter((x) => x === null).length;
    console.log(`안정성: 연속 연도 쌍 ${pairs}개 중 설정이 완전히 같은 쌍 ${same}개 (${f2((same / Math.max(pairs, 1)) * 100)}%) | 파라미터별 바뀐 쌍: ${fam.dimNames.map((n, dm) => `${n} ${chg[dm]}`).join(" / ")} | 현금(선정 불가) 해 ${nCashYears}개`);

    // 점수-이듬해 성적 상관
    console.log(`\n${fam.id} 선정 점수와 이듬해 성적의 상관 (점수 있는 격자점 전체 스피어만, 최종 점수 ↔ 그 설정 단독의 S(y)→S(y+1) 수익률)\n| 선정 연도 | 점수 있는 격자점 수 | 스피어만 | 원점수 스피어만 |\n|---|---|---|---|`);
    const rhos: number[] = [], rhosRaw: number[] = [];
    for (let yi = evalYi; yi < selYears.length; yi++) {
      const sc = sums[0].map((s) => s[yi].score);
      const { fin } = finalScores(fam.nbr, sc);
      const ix = sc.map((x, i) => i).filter((i) => sc[i] !== null);
      if (ix.length < 3) { console.log(`| ${selYears[yi]} | ${ix.length} | - | - |`); continue; }
      const rho = spearman(ix.map((i) => fin[i] as number), ix.map((i) => sums[0][i][yi].nxt));
      const rhoR = spearman(ix.map((i) => sc[i] as number), ix.map((i) => sums[0][i][yi].nxt));
      rhos.push(rho); rhosRaw.push(rhoR);
      console.log(`| ${selYears[yi]} | ${ix.length} | ${f2(rho)} | ${f2(rhoR)} |`);
    }
    console.log(`연도 평균 스피어만 ${f2(avg(rhos.filter(Number.isFinite)))} (원점수 ${f2(avg(rhosRaw.filter(Number.isFinite)))}) | 선정된 설정만 모은 12점 상관: 최종 점수 ↔ 단독 이듬해 수익률 피어슨 ${f2(pearson(yrRows.map((r) => r.fin), yrRows.map((r) => r.nxt)))}, 최종 점수 ↔ 이어 붙인 결과 그 해 수익률 피어슨 ${f2(pearson(yrRows.map((r) => r.fin), yrRows.map((r) => r.wfRet)))}`);

    // 구간별 성적표
    console.log(`\n${fam.id} 성적표 (비용 포함, 이어 붙인 결과)\n| 구간 | CAGR % | MDD % | 최악 12개월 % | 샤프 | 069500 원주가 CAGR / MDD / 최악 12개월 | 지연(체결 +1일) CAGR / MDD | 1년 지연 고정 CAGR / MDD |\n|---|---|---|---|---|---|---|---|`);
    for (const [name, win] of WINS) {
      const s = st(wf, win), b = st(bhP, win), sd = st(wfD, win), sl = st(wfL, win);
      console.log(`| ${name} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(worst12(wf, win))} | ${f2(s.sharpe)} | ${f2(b.cagr)} / ${f2(b.mdd)} / ${f2(worst12(bhP, win))} | ${f2(sd.cagr)} / ${f2(sd.mdd)} | ${f2(sl.cagr)} / ${f2(sl.mdd)} |`);
    }
    const full = st(wf, EVAL), fullD = st(wfD, EVAL), fullL = st(wfL, EVAL);
    const early = st(wf, EARLY), late = st(wf, LATE), bE = st(bhP, EARLY), bL = st(bhP, LATE);
    const gA = full.cagr >= bFull.cagr + W_A_EXCESS_PP && full.mdd <= bFull.mdd + epsM;
    const okE = early.cagr > bE.cagr && early.mdd <= bE.mdd + epsM, okL = late.cagr > bL.cagr && late.mdd <= bL.mdd + epsM;
    const gB = okE && okL;
    const gC = full.cagr - fullD.cagr <= W_C_MAX_CAGR_DROP && fullD.mdd - full.mdd <= W_C_MAX_MDD_WORSEN;
    const gD = fullL.cagr >= bFull.cagr;
    console.log(`지연 워크포워드(체결 +1일, 지연 세계에서 재선정): 설정 ${sels2.slice(evalYi).map((k) => (k === null ? "현금" : String(k))).join(",")} (기준과 같은 해 ${sels2.slice(evalYi).filter((k, i) => k === sels1[evalYi + i]).length}/${selYears.length - evalYi}) | CAGR 하락 ${f2(full.cagr - fullD.cagr)}%p, MDD 악화 ${f2(fullD.mdd - full.mdd)}%p`);
    // R2
    const r2 = fam.r2(wf, sels1), gE = r2.cagr >= bFull.cagr;
    console.log(`R2: 상위 ${W_E_TOP}개(${r2.desc})를 069500 원주가 수익률로 대체 → 평가 구간 CAGR ${f2(r2.cagr)} (기준 ${f2(bFull.cagr)}) ${ox(gE)}`);
    // R3
    const rng = mulberry32(KSS_R3_SEED), draws: number[] = [];
    for (let n = 0; n < W_F_DRAWS; n++) {
      const sels = selYears.map((_, yi) => (yi < evalYi ? null : Math.floor(rng() * fam.grid.length)));
      draws.push(st(fam.runSched(sels, 1), EVAL).cagr);
    }
    const sd = [...draws].sort((a, b) => a - b), pct = pctOf(draws, full.cagr), gF = pct >= W_F_MIN_PCTILE;
    console.log(`R3 무작위 설정 워크포워드(해마다 격자 전체에서 균등 무작위, ${W_F_DRAWS}회, 시드 ${KSS_R3_SEED}): 최소 ${f2(sd[0])}, 중앙값 ${f2(sd[Math.floor(sd.length / 2)])}, 95분위 ${f2(sd[Math.floor(sd.length * 0.95)])}, 최대 ${f2(sd[sd.length - 1])}, ${fam.id} ${f2(full.cagr)} → 백분위 ${f2(pct)} | 참고 1−0.05/${W_TESTS} = ${f2(bonfW)} 이상 ${ox(pct >= bonfW)}`);
    // G
    const nEnt = wf.entryCs.filter((c) => CAL[c] >= EVAL.from).length;
    const nMonths = sigs.filter((d) => d >= EVAL.from).length;
    const gG = fam.id === "W1" ? nEnt >= W1_MIN_ENTRIES : true;
    const gates = [gA, gB, gC, gD, gE, gF];
    if (fam.id === "W1") gates.push(gG);
    const pass = gates.every(Boolean);
    const why = ["A", "B", "C", "D", "E", "F", "G"].filter((_, i) => i < gates.length && !gates[i]).join(", ");
    console.log(`${fam.id} 게이트: A ${ox(gA)} | B ${ox(gB)}(2015~2019 ${ox(okE)}, 2020~ ${ox(okL)}) | C ${ox(gC)} | D ${ox(gD)}(1년 지연 고정 CAGR ${f2(fullL.cagr)} vs ${f2(bFull.cagr)}) | E ${ox(gE)} | F ${ox(gF)} | G ${fam.id === "W1" ? `${ox(gG)}(진입 ${nEnt}건)` : `보고(월 ${nMonths}개, 신규 편입 ${nEnt}건, 판정 제외)`} → ${pass ? "통과" : `탈락(${why})`}`);
    summaryW.push(`| ${fam.id} (${fam.no}) | ${ox(gA)} | ${ox(gB)} | ${ox(gC)} | ${ox(gD)} | ${ox(gE)} | ${ox(gF)} | ${fam.id === "W1" ? ox(gG) : "보고"} | F(참고, ≥ ${f2(bonfW)}) ${ox(pct >= bonfW)} | ${pass ? "통과" : "탈락"} | ${why || "-"} |`);

    // 추가 보고
    console.log(`${fam.id} 보유·비용 (평가 구간 전체)\n| 평균 보유 종목 수 | 현금 100% 기간 % | 연 회전율 % | 연 비용 % | 삼성전자+SK하이닉스 합산 비중 평균 / 최대 % | 2026-10-01~10-15 수익률 % (069500 원주가) |\n|---|---|---|---|---|---|`);
    const idx = wf.dates.map((d, i) => [d, i] as [string, number]).filter(([d]) => d >= EVAL.from).map(([, i]) => i);
    const yrs = Math.max(dayDiff(EVAL.from, dataEnd) / 365.25, 1e-9);
    const tv = wf.turn.filter((x) => x.d >= EVAL.from).reduce((a, x) => a + x.v, 0);
    const pairs2 = idx.map((i) => wf.wPair[i]);
    console.log(`| ${f2(avg(idx.map((i) => wf.nPos[i])))} | ${f2((idx.filter((i) => wf.nPos[i] === 0).length / Math.max(idx.length, 1)) * 100)} | ${f2((tv / yrs) * 100)} | ${f2((idx.reduce((a, i) => a + wf.costFrac[i], 0) / yrs) * 100)} | ${f2(avg(pairs2) * 100)} / ${f2(Math.max(...pairs2) * 100)} | ${f2(recentRet(wf))} (${f2(recentRet(bhP))}) |`);

    // 시드 모의
    console.log(`\n${fam.id} 시드 정수 주 모의 (평가 구간 이어 붙인 설정, 남는 돈은 현금)\n| 시드 | 평가 구간 CAGR % | MDD % | 최종 평가액(원) | 평균 보유 종목 수(전체 날 / 보유 있는 날) |\n|---|---|---|---|---|`);
    for (const seed of KSS32_SEEDS_WON) {
      const o = fam.runInt(sels1, seed);
      const s = st(o, EVAL);
      let V = seed;
      for (const r of o.ret) V *= 1 + r / 100;
      const np = o.nPos.filter((_, i) => o.dates[i] >= EVAL.from);
      console.log(`| ${seedLab(seed)} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${Math.round(V).toLocaleString("ko-KR")} | ${f2(avg(np))} / ${f2(avg(np.filter((n) => n > 0)))} |`);
    }
    const mc = fam.minCaps(wf, sels1);
    console.log(`최소 필요 금액(${KSS31_PRACTICAL_FROM} 이후 ${fam.id === "W1" ? "진입" : "신호"} ${mc.length}건): 중앙값 ${mc.length ? Math.round(median(mc)).toLocaleString("ko-KR") : "-"}원, 최대 ${mc.length ? Math.round(Math.max(...mc)).toLocaleString("ko-KR") : "-"}원`);
    console.log(`(${fam.id} 소요 ${((Date.now() - t1) / 60000).toFixed(1)}분)`);
  }

  console.log(`\n참고: 069500 원주가 평가 구간 전체 CAGR ${f2(bFull.cagr)} / MDD ${f2(bFull.mdd)} | 2015~2019 ${f2(st(bhP, EARLY).cagr)} / ${f2(st(bhP, EARLY).mdd)} | 2020~최신 ${f2(st(bhP, LATE).cagr)} / ${f2(st(bhP, LATE).mdd)}`);
  runFamily(fam1);
  runFamily(fam2);
  console.log(`\n=== 요약 (누적 ${W_PRIOR_TESTS} + ${W_TESTS} = ${W_PRIOR_TESTS + W_TESTS}) ===\n| 후보 | A | B | C | D | E | F | G | F(참고) | 결과 | 탈락 사유 |\n|---|---|---|---|---|---|---|---|---|---|---|\n${summaryW.join("\n")}`);
  console.log("주의: 보류 구간(2022~)은 이미 여러 번 본 데이터라 순수 검증이 아니다. 격자 범위 자체가 이전 결과를 본 뒤 정한 것이다. 평가 시작(2015-01) 시점의 과거 구간은 약 4.5년이라 '최소 5년'에 못 미친다.");
  finish();

  function finish(): void {
    console.log("\n=== 실행 지표 ===");
    console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
    console.log(`Supabase 쓴 행: 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

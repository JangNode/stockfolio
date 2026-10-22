/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] E: 새 목표(연 15%↑, MDD −30% 이내) 개별 종목 후보 E1~E5 (누적 시험 154~).
 * 사전 등록: docs/research/e-new-goal-prereg.md (9def1f0). 입력·제외 규칙·엔진은 scripts/research-d-frequency.ts(8e9ee10) 그대로.
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
import { KSS_TOP_K, KSS_MIX_WEIGHTS, KSS_DEFAULT_W, KSS_G1_MARGIN_PP, KSS_G2_MDD_MARGIN_PP, KSS_G4_MAX_DELAY_DROP_PP, KSS_R1_TOP_KS, KSS_R3_DRAWS, KSS_R3_SEED, KSS31_PER_SECTOR, KSS31_R1_LOOKBACKS, KSS31_PRACTICAL_FROM, KSS32_TRIM_MIN_WEIGHT, KSS32_R1_TRIMS, KSS32_SEEDS_WON, KSS32_ETF_SLIPPAGE, D_RECENT_FROM, D_RECENT_TO, E_K, E_R1_KS, E_MAX_WEIGHT, E_MOM_L, E_R1_MOM_LS, E_MOM_SKIP, E_HIGH_W, E_R1_HIGH_WS, E_MIN_ROW_RATIO, E3_TOP_PCT, E3_R1_TOP_PCTS, E_VOL_DAYS, E_VOL_MIN_DAYS, E5_FLOW_DAYS, E5_FLOW_MIN_DAYS, E3_QUARTER_FRESH_DAYS, E5_GATE_TOPN, E5_GATE_MIN_COVER, E3_GATE_MIN_COVER, E_A_MIN_CAGR, E_A_MAX_MDD, E_B_EXCESS_PP, E_B_MIN_PERIODS, E_C_MIN_CAGR, E_C_MAX_MDD, E_D_MIN_CAGR, E_D_MAX_MDD, E_E_MIN_CAGR, E_F_MIN_PCTILE, E_PRIOR_TESTS } from "@/lib/kodexSectorSatConfig";
import { STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK } from "@/lib/stockDataConfig";
import { INVESTOR_FLOW_STOCK_FIRST_YEAR, INVESTOR_FLOW_STOCK_CLEAN_PREFIX } from "@/lib/investorFlowConfig";
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
  console.log(`KODEX 200 + 업종 모멘텀 위성 E(9def1f0) 시작(읽기 전용): ${new Date().toISOString()} (사전등록 d70b1fd 이후)`);
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

  // ===================== E (9def1f0) =====================
  // ---- 분기 영업이익(dart_quarterly_fundamentals ok, XBRL 백필 포함) ----
  type QRec = { rcept: string; order: number; op: number | null; prev: number | null };
  const qBy = new Map<string, QRec[]>();
  {
    const QEND: Record<number, string> = { 1: "03-31", 2: "06-30", 3: "09-30" };
    const codes = stocks.map((s) => s.code);
    for (let i = 0; i < codes.length; i += 200) {
      const chunk = codes.slice(i, i + 200);
      const q = await selectAll<{ stock_code: string; fiscal_year: number; quarter: number; rcept_date: string | null; op_income_q: number | null; op_income_prev_q: number | null; off_cycle: boolean }>("dart_quarterly_fundamentals(ok)", (f, t) => supabaseAdmin.from("dart_quarterly_fundamentals").select("stock_code, fiscal_year, quarter, rcept_date, op_income_q, op_income_prev_q, off_cycle").eq("status", "ok").in("stock_code", chunk).order("corp_code").order("fiscal_year").order("quarter").range(f, t));
      for (const r of q) {
        if (r.off_cycle || !r.rcept_date || r.quarter < 1 || r.quarter > 3 || r.rcept_date < `${r.fiscal_year}-${QEND[r.quarter]}`) continue;
        const a = qBy.get(r.stock_code) ?? [];
        a.push({ rcept: r.rcept_date, order: r.fiscal_year * 10 + r.quarter, op: r.op_income_q === null ? null : Number(r.op_income_q), prev: r.op_income_prev_q === null ? null : Number(r.op_income_prev_q) });
        qBy.set(r.stock_code, a);
      }
    }
    for (const a of qBy.values()) a.sort((x, y) => (x.rcept === y.rcept ? x.order - y.order : x.rcept < y.rcept ? -1 : 1));
  }
  // ---- 외국인 수급 정리본(Storage Parquet) ----
  const flowBy = new Map<string, Map<string, number>>();
  let flowRows = 0;
  for (let y = INVESTOR_FLOW_STOCK_FIRST_YEAR; y <= new Date().getUTCFullYear(); y++) {
    const { data, error } = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).download(`${INVESTOR_FLOW_STOCK_CLEAN_PREFIX}/${y}.parquet`);
    if (error || !data) { console.log(`수급 정리본 ${y}.parquet 없음`); continue; }
    for (const r of (await parquetReadObjects({ file: await data.arrayBuffer() })) as { stock_code: string; trade_date: string; frgn_ntby_amt: number | null }[]) {
      let m = flowBy.get(r.stock_code);
      if (!m) { m = new Map(); flowBy.set(r.stock_code, m); }
      m.set(r.trade_date, Number(r.frgn_ntby_amt ?? 0));
      flowRows++;
    }
  }
  console.log(`분기 재무: 종목 ${qBy.size}개 | 수급 정리본: 종목 ${flowBy.size}개, ${flowRows}행`);

  // ---- 유니버스·신호 ----
  const uCache = new Map<string, S[]>();
  const univAt = (d: string): S[] => {
    let v = uCache.get(d);
    if (!v) {
      v = [];
      for (const s of stocks) { const i = s.idx.get(d); if (i === undefined || i === 0) continue; if (s.mcapRow[i - 1] >= STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK && s.avgTvRow[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && !excluded.has(s.code)) v.push(s); }
      uCache.set(d, v);
    }
    return v;
  };
  const closeOn = (s: S, c: number): number => { const i = s.idx.get(CAL[c]); return i !== undefined && s.close[i] > 0 ? s.close[i] : NaN; };
  const momOf = (s: S, c: number, L: number): number => { if (c - L < 0) return NaN; const a = closeOn(s, c - L), b = closeOn(s, c - E_MOM_SKIP); return a > 0 && b > 0 ? b / a - 1 : NaN; };
  const highOf = (s: S, c: number, W: number): number => {
    if (c - W + 1 < 0) return NaN;
    let mx = 0, n = 0;
    for (let k = c - W + 1; k <= c; k++) { const p = closeOn(s, k); if (p > 0) { n++; if (p > mx) mx = p; } }
    const p = closeOn(s, c);
    return n >= Math.ceil(W * E_MIN_ROW_RATIO) && p > 0 && mx > 0 ? p / mx : NaN;
  };
  const volOf = (s: S, c: number): number => {
    if (c - E_VOL_DAYS + 1 < 0) return NaN;
    let days = 0, n = 0, sum = 0, sum2 = 0;
    for (let k = c - E_VOL_DAYS + 1; k <= c; k++) { const p = closeOn(s, k); if (p > 0) { days++; if (k > c - E_VOL_DAYS + 1) { const q = closeOn(s, k - 1); if (q > 0) { const r = p / q - 1; n++; sum += r; sum2 += r * r; } } } }
    if (days < E_VOL_MIN_DAYS || n < 2) return NaN;
    const m = sum / n;
    return Math.sqrt(Math.max((sum2 - n * m * m) / (n - 1), 0));
  };
  const sopOf = (s: S, d: string): number => {
    let rec: QRec | null = null;
    for (const r of qBy.get(s.code) ?? []) { if (r.rcept <= d) rec = r; else break; }
    if (rec && dayDiff(rec.rcept, d) <= E3_QUARTER_FRESH_DAYS && rec.op !== null && rec.prev !== null && rec.prev !== 0) return (rec.op - rec.prev) / Math.abs(rec.prev);
    return NaN;
  };
  const flowOf = (s: S, c: number): number => {
    const m = flowBy.get(s.code);
    if (!m || c - E5_FLOW_DAYS + 1 < 0) return NaN;
    let n = 0, sum = 0;
    for (let k = c - E5_FLOW_DAYS + 1; k <= c; k++) { const v = m.get(CAL[k]); if (v !== undefined) { n++; sum += v; } }
    return n >= E5_FLOW_MIN_DAYS ? sum : NaN;
  };
  const rankBy = (U: S[], f: (s: S) => number): S[] => U.map((s) => ({ s, v: f(s) })).filter((x) => Number.isFinite(x.v)).sort((a, b) => b.v - a.v || (a.s.code < b.s.code ? -1 : 1)).map((x) => x.s);
  const memo = new Map<string, S[]>();
  const momRank = (d: string, L: number): S[] => { const k = `m|${d}|${L}`; let v = memo.get(k); if (!v) { const c = calIdx.get(d)!; v = rankBy(univAt(d), (s) => momOf(s, c, L)); memo.set(k, v); } return v; };
  const highRank = (d: string, W: number): S[] => { const k = `h|${d}|${W}`; let v = memo.get(k); if (!v) { const c = calIdx.get(d)!; v = rankBy(univAt(d), (s) => highOf(s, c, W)); memo.set(k, v); } return v; };
  const lowVolSet = new Map<string, Set<string>>();
  const lowVolAt = (d: string): Set<string> => { let v = lowVolSet.get(d); if (!v) { const c = calIdx.get(d)!; const r = rankBy(univAt(d), (s) => -volOf(s, c)); v = new Set(r.slice(0, Math.floor(r.length / 2)).map((s) => s.code)); lowVolSet.set(d, v); } return v; };

  type Kind = "E1" | "E2" | "E3" | "E4" | "E5";
  interface ECfg { kind: Kind; K: number; L: number; W: number; topPct: number }
  const BASE_CFG = (kind: Kind): ECfg => ({ kind, K: E_K, L: E_MOM_L, W: E_HIGH_W, topPct: E3_TOP_PCT });
  const pickAt = (cfg: ECfg, d: string): S[] => {
    const c = calIdx.get(d)!;
    switch (cfg.kind) {
      case "E1": return momRank(d, cfg.L).slice(0, cfg.K);
      case "E2": return highRank(d, cfg.W).slice(0, cfg.K);
      case "E3": { const m = momRank(d, cfg.L); const top = m.slice(0, Math.ceil(cfg.topPct * m.length)); return rankBy(top, (s) => sopOf(s, d)).slice(0, cfg.K); }
      case "E4": { const lv = lowVolAt(d); return momRank(d, cfg.L).filter((s) => lv.has(s.code)).slice(0, cfg.K); }
      case "E5": return highRank(d, cfg.W).filter((s) => flowOf(s, c) > 0).slice(0, cfg.K);
    }
  };
  const targetsOf = (cfg: ECfg): Map<string, Map<string, number>> => new Map(sigs.map((d) => [d, new Map(pickAt(cfg, d).map((s) => [s.code, Math.min(1 / cfg.K, E_MAX_WEIGHT)]))]));

  // ---- 데이터 게이트 ----
  const years = [...new Set(sigs.map((d) => d.slice(0, 4)))].filter((y) => y >= "2011");
  const gateTable = (label: string, cover: (d: string) => number, min: number): boolean => {
    let ok = true;
    const cells: string[] = [];
    for (const y of years) {
      const vals = sigs.filter((d) => d.startsWith(y)).map(cover).filter((x) => Number.isFinite(x));
      const a = avg(vals);
      if (!(a >= min)) ok = false;
      cells.push(`${y} ${f2(a * 100)}`);
    }
    console.log(`${label} 연평균 %: ${cells.join(" | ")} → 기준 ${min * 100}% ${ok ? "충족 → 실행" : "미충족 → 제외"}`);
    return ok;
  };
  console.log("\n=== 데이터 게이트(백테스트 전) ===");
  const e3ok = gateTable("E3 모멘텀 상위 30% 중 SOP 계산 가능 비율", (d) => { const m = momRank(d, E_MOM_L); const top = m.slice(0, Math.ceil(E3_TOP_PCT * m.length)); return top.length ? top.filter((s) => Number.isFinite(sopOf(s, d))).length / top.length : NaN; }, E3_GATE_MIN_COVER);
  const e5ok = gateTable(`E5 52주 근접도 상위 ${E5_GATE_TOPN} 중 수급 자료 비율`, (d) => { const c = calIdx.get(d)!; const top = highRank(d, E_HIGH_W).slice(0, E5_GATE_TOPN); return top.length ? top.filter((s) => Number.isFinite(flowOf(s, c))).length / top.length : NaN; }, E5_GATE_MIN_COVER);
  const kinds: Kind[] = (["E1", "E2", "E3", "E4", "E5"] as Kind[]).filter((k) => (k === "E3" ? e3ok : k === "E5" ? e5ok : true));
  const N = kinds.length;
  const bonf = 100 * (1 - 0.05 / N);
  console.log(`실행 후보 ${kinds.join(", ")} (N = ${N}) | 누적 시험 ${E_PRIOR_TESTS} + ${N} = ${E_PRIOR_TESTS + N} | 시험 번호 ${kinds.map((k, i) => `${k} = ${E_PRIOR_TESTS + 1 + i}`).join(", ")} | Bonferroni 참고 기준 백분위 ≥ ${f2(bonf)}`);
  console.log(`참고(0단계, 재실행 없음): S-A 상대 모멘텀(20종목, 당일 체결) 기존 로그 CAGR / MDD — 전체 -1.17 / 81.39, 학습 2010~2018 3.30 / 44.39, 확인 2019~ -6.09 / 79.61`);

  // ---- 무작위 10종목(R3) ----
  const rng = mulberry32(KSS_R3_SEED), r3: number[] = [];
  for (let n = 0; n < KSS_R3_DRAWS; n++) {
    const m = new Map(sigs.map((d) => {
      const a = [...univAt(d)];
      const take = Math.min(E_K, a.length);
      for (let i = 0; i < take; i++) { const j = i + Math.floor(rng() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; }
      return [d, new Map(a.slice(0, take).map((s) => [s.code, 1 / E_K]))];
    }));
    r3.push(st(engine(mkTargets(m), 1), FULL).cagr);
  }
  const r3s = [...r3].sort((a, b) => a - b);
  console.log(`R3 무작위 10종목 ${KSS_R3_DRAWS}회(시드 ${KSS_R3_SEED}) 전 기간 CAGR: 중앙값 ${f2(r3s[Math.floor(r3s.length / 2)])}, 95분위 ${f2(r3s[Math.floor(r3s.length * 0.95)])}, 최대 ${f2(r3s[r3s.length - 1])}`);

  const bP = (w: Win) => st(bhP, w);
  const summary: string[] = [];
  const desc: Record<Kind, string> = { E1: "12-1 모멘텀 상위 10", E2: "52주 신고가 근접도 상위 10", E3: "모멘텀 상위 30% 중 분기 영업이익 증가율 상위 10", E4: "모멘텀 순 + 60일 변동성 하위 50%", E5: "52주 근접도 순 + 외국인 20일 순매수 > 0" };
  const r1Of = (k: Kind): { label: string; cfg: ECfg }[] => {
    const b = BASE_CFG(k);
    const kn = E_R1_KS.map((K) => ({ label: `종목 ${K}개`, cfg: { ...b, K } }));
    if (k === "E1" || k === "E4") return [...E_R1_MOM_LS.map((L) => ({ label: `모멘텀 ${Math.round(L / 21)}-1개월`, cfg: { ...b, L } })), ...kn];
    if (k === "E2" || k === "E5") return [...E_R1_HIGH_WS.map((W) => ({ label: `${Math.round(W / 252 * 52)}주 고가`, cfg: { ...b, W } })), ...kn];
    return [...E3_R1_TOP_PCTS.map((p) => ({ label: `모멘텀 상위 ${p * 100}%`, cfg: { ...b, topPct: p } })), ...kn];
  };
  const tgMaps = new Map<Kind, Map<string, Map<string, number>>>();
  kinds.forEach((k, idx) => {
    const tg = targetsOf(BASE_CFG(k));
    tgMaps.set(k, tg);
    const o = engine(mkTargets(tg), 1), od = engine(mkTargets(tg), 2);
    const full = st(o, FULL), fullD = st(od, FULL);
    console.log(`\n##### ${k} (시험 ${E_PRIOR_TESTS + 1 + idx}) — ${desc[k]}, 동일가중, 개별 주식 + 현금 #####\n| 구간 | CAGR % | MDD % | 최악 12개월 % | 샤프 | 069500 원주가 CAGR / MDD | B 조건 |\n|---|---|---|---|---|---|---|`);
    let bCount = 0;
    for (const [name, win] of ALLW) {
      const s = st(o, win), b = bP(win);
      const okB = s.cagr >= b.cagr + E_B_EXCESS_PP && s.mdd <= E_A_MAX_MDD + SAT_MDD_EPS;
      if (win !== FULL && okB) bCount++;
      console.log(`| ${name} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(worst12(o, win))} | ${f2(s.sharpe)} | ${f2(b.cagr)} / ${f2(b.mdd)} | ${win === FULL ? "-" : ox(okB)} |`);
    }
    const gA = full.cagr >= E_A_MIN_CAGR && full.mdd <= E_A_MAX_MDD + SAT_MDD_EPS;
    const gB = bCount >= E_B_MIN_PERIODS;
    const gC = fullD.cagr >= E_C_MIN_CAGR && fullD.mdd <= E_C_MAX_MDD + SAT_MDD_EPS;
    console.log(`지연 버전 전 기간 CAGR ${f2(fullD.cagr)} / MDD ${f2(fullD.mdd)}`);
    let gD = true;
    console.log(`R1 이웃값\n| 변형 | 전 기간 CAGR % | MDD % | 판정 |\n|---|---|---|---|`);
    for (const nb of r1Of(k)) { const s = st(engine(mkTargets(targetsOf(nb.cfg)), 1), FULL); const ok = s.cagr >= E_D_MIN_CAGR && s.mdd <= E_D_MAX_MDD + SAT_MDD_EPS; if (!ok) gD = false; console.log(`| ${nb.label} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${ox(ok)} |`); }
    const r2 = r2Of(o, bhP), gE = r2.cagr >= E_E_MIN_CAGR;
    const pct = pctOf(r3, full.cagr), gF = pct >= E_F_MIN_PCTILE, gG = pct >= bonf;
    console.log(`R2: 바꾼 달 ${r2.m}(그 달 차이 ${f2(r2.ex)}%p) → 전 기간 CAGR ${f2(r2.cagr)} | R3 백분위 ${f2(pct)}`);
    const gates7 = [gA, gB, gC, gD, gE, gF];
    const pass = gates7.every(Boolean);
    const why = ["A", "B", "C", "D", "E", "F"].filter((_, i) => !gates7[i]).join(", ");
    console.log(`${k} 게이트: A ${ox(gA)} | B ${ox(gB)}(${bCount}개 구간) | C ${ox(gC)} | D ${ox(gD)} | E ${ox(gE)} | F ${ox(gF)} | G(참고, ≥ ${f2(bonf)}) ${ox(gG)} → ${pass ? "통과" : `탈락(${why})`}`);
    summary.push(`| ${k} (${E_PRIOR_TESTS + 1 + idx}) | ${gates7.map(ox).join(" | ")} | ${ox(gG)} | ${pass ? "통과" : "탈락"} | ${why || "-"} |`);
    // 추가 보고
    console.log(`추가 보고\n| 구간 | 연 회전율 % | 연 비용 % | 현금 보유 기간 % |\n|---|---|---|---|`);
    for (const [name, win] of ALLW) {
      const idx2 = o.dates.map((d, i) => [d, i] as [string, number]).filter(([d]) => d >= win.from && d <= win.to && d > firstExec).map(([, i]) => i);
      const yrs = Math.max(dayDiff(win.from, winTo(win)) / 365.25, 1e-9);
      const tv = o.turn.filter((x) => x.d >= win.from && x.d <= win.to).reduce((a, x) => a + x.v, 0);
      console.log(`| ${name} | ${f2((tv / yrs) * 100)} | ${f2((idx2.reduce((a, i) => a + o.costFrac[i], 0) / yrs) * 100)} | ${f2((idx2.filter((i) => o.nPos[i] === 0).length / Math.max(idx2.length, 1)) * 100)} |`);
    }
    const nonEmpty = [...tg.values()].filter((m) => m.size > 0);
    const pair = nonEmpty.map(pairOf);
    const secMax = nonEmpty.map((m) => { const g = new Map<string, number>(); for (const [c, w] of m) g.set(sectorOf(c), (g.get(sectorOf(c)) ?? 0) + w); return Math.max(...g.values()) / [...m.values()].reduce((a, x) => a + x, 0); });
    console.log(`2026-10-01~10-15 수익률 ${f2(recentRet(o))}% (069500 원주가 ${f2(recentRet(bhP))}%) | 삼성전자+SK하이닉스 목표 비중 합 평균 ${f2(avg(pair) * 100)}% / 최대 ${f2(Math.max(...pair) * 100)}% | 최대 업종 비중(투자 비중 대비) 평균 ${f2(avg(secMax) * 100)}% / 최대 ${f2(Math.max(...secMax) * 100)}% | 평균 선정 종목 수 ${f2(avg([...tg.values()].map((m) => m.size)))} (선정 0개 신호일 ${[...tg.values()].filter((m) => m.size === 0).length}개)`);
  });
  console.log(`\n=== 요약 (N = ${N}, 누적 ${E_PRIOR_TESTS} + ${N} = ${E_PRIOR_TESTS + N}) ===\n| 후보 | A | B | C | D | E | F | G(참고) | 결과 | 탈락 사유 |\n|---|---|---|---|---|---|---|---|---|---|\n${summary.join("\n")}`);
  console.log("주의: 보류 구간(2022~)은 이미 여러 번 본 데이터라 순수 검증이 아니다.");

  // ---- 시드 정수 주 모의 ----
  console.log(`\n=== 시드 정수 주 모의 (남는 돈은 현금) ===\n| 후보 | 시드 | 학습 CAGR / MDD | 확인 CAGR / MDD | 보류 CAGR / MDD | 전 기간 CAGR / MDD | 최종 평가액(원) | 평균 보유 종목 수 |\n|---|---|---|---|---|---|---|---|`);
  for (const k of kinds) {
    for (const seed of KSS32_SEEDS_WON) {
      const o = engineInt(mkTargets(tgMaps.get(k)!), seed);
      const cells = ALLW.map(([, win]) => { const s = st(o, win); return `${f2(s.cagr)} / ${f2(s.mdd)}`; });
      let V = seed;
      for (const r of o.ret) V *= 1 + r / 100;
      console.log(`| ${k} | ${seedLab(seed)} | ${cells.join(" | ")} | ${Math.round(V).toLocaleString("ko-KR")} | ${f2(avg(o.held))} |`);
    }
  }
  console.log(`\n=== 최소 필요 금액(1주씩, max 원 종가 ÷ 목표 비중; ${KSS31_PRACTICAL_FROM} 이후 신호일) ===\n| 후보 | 신호일 수 | 중앙값(원) | 최대(원) | 최근 신호일 | 최근 값(원) | 결정 종목 |\n|---|---|---|---|---|---|---|`);
  for (const k of kinds) {
    const rec = [...tgMaps.get(k)!].filter(([d, m]) => d.slice(0, 7) >= KSS31_PRACTICAL_FROM && m.size > 0);
    if (!rec.length) { console.log(`| ${k} | 0 | - | - | - | - | - |`); continue; }
    const vals = rec.map(([d, m]) => minAcctOf(m, d).v), [ld, lm] = rec[rec.length - 1], l = minAcctOf(lm, ld);
    console.log(`| ${k} | ${rec.length} | ${Math.round(median(vals)).toLocaleString("ko-KR")} | ${Math.round(Math.max(...vals)).toLocaleString("ko-KR")} | ${ld} | ${Math.round(l.v).toLocaleString("ko-KR")} | ${l.who} ${nameOf.get(l.who) ?? ""} |`);
  }
  finish();

  function finish(): void {
    console.log("\n=== 실행 지표 ===");
    console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
    console.log(`Supabase 쓴 행: 0 | Storage 다운로드: 수급 정리본 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

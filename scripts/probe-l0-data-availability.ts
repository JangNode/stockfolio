/**
 * [임시 점검 — 병합 금지, 읽기 전용, 시험 횟수에 넣지 않음] L-0: 새 정보원 데이터 가용성 점검(시장 폭, KOSPI200 구성, DART 공시 목록·본문, 임원·주요주주 소유보고, 수급 Parquet, 분기 실적 공시일).
 * DART는 연구용 키(DART_API_KEY_3 → DART_API_KEY_2)만, 요청 190건 이하. DB·Storage 쓰기 0, KIS·KRX 요청 0. 숫자와 표만 출력한다(전략 시험·성적 계산 없음).
 */
import AdmZip from "adm-zip";
import { DartKeyPool } from "./dartKeyPool";
import { INVESTOR_FLOW_STOCK_CLEAN_PREFIX, INVESTOR_FLOW_STOCK_FIRST_YEAR, INVESTOR_FLOW_TOP_N } from "@/lib/investorFlowConfig";
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
import { KSS_TOP_K, KSS_MIX_WEIGHTS, KSS_DEFAULT_W, KSS_G1_MARGIN_PP, KSS_G2_MDD_MARGIN_PP, KSS_G4_MAX_DELAY_DROP_PP, KSS_R1_TOP_KS, KSS_R3_DRAWS, KSS_R3_SEED, KSS31_PER_SECTOR, KSS31_R1_LOOKBACKS, KSS31_PRACTICAL_FROM, KSS32_TRIM_MIN_WEIGHT, KSS32_R1_TRIMS, KSS32_SEEDS_WON, KSS32_ETF_SLIPPAGE, D_RECENT_FROM, D_RECENT_TO, F_SHORT, F_LONG, F_R1_MAS, F_TOP_SECTORS, F_R1_TOPS, F_MAX_POS, F_R1_POS, F_ENTRY_FRAC, F_COOLDOWN, F_STOP, F_R1_STOPS, F_TRAIL_G2, F_R1_TRAIL_G2, F_TRAIL_G4, F_R1_TRAIL_G4, F_A_EXCESS_PP, F_B_MIN_PERIODS, F_C_MAX_CAGR_DROP, F_C_MAX_MDD_WORSEN, F_E_TOP_TRADES, F_F_MIN_PCTILE, F_TESTS, F_PRIOR_TESTS, F_TOP_TRADES_N, F_LONG_HOLD_DAYS } from "@/lib/kodexSectorSatConfig";
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
  console.log(`L-0 데이터 가용성 점검(읽기 전용, 시험 아님) 시작: ${new Date().toISOString()}`);
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

  // ===================== L-0 (데이터 가용성 점검 — 전략 시험 아님, 시험 횟수에 넣지 않음) =====================
  const fmtD = (d: string): string => (d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d || "-");
  const pct1 = (n: number, d: number): string => (d > 0 ? f2((n / d) * 100) : "-");
  const pctile = (a: number[], p: number): number => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor((b.length - 1) * p))]; };
  const yearOf = (d: string): string => d.slice(0, 4);

  // ---------- 1. 시장 폭 (가격 Parquet + K200P) ----------
  console.log(`\n=== 1. 시장 폭: K200P 일별 구성·지표 계산 가능 비율 (연도별, 판단일 ${CAL[c0]} 이후) ===\n| 연도 | 거래일 수 | K200P 평균 종목 수 | 200개 미만인 날 | 50일선 계산 가능 % | 200일선 계산 가능 % | 55일 신고·신저가 계산 가능 % |\n|---|---|---|---|---|---|---|`);
  {
    const acc = new Map<string, { days: number; size: number; lt: number; m50: number; m200: number; h55: number; rows: number }>();
    let firstOk95: string | null = null;
    for (let c = c0; c < nCal; c++) {
      const d = CAL[c], y = yearOf(d), U = kAtW(d);
      const e = acc.get(y) ?? { days: 0, size: 0, lt: 0, m50: 0, m200: 0, h55: 0, rows: 0 };
      e.days++; e.size += U.length; if (U.length < SMT21_K_SIZE) e.lt++;
      let a200 = 0;
      for (const s of U) { const i = s.idx.get(d)!; e.rows++; if (i >= 49) e.m50++; if (i >= 199) { e.m200++; a200++; } if (i >= 55) e.h55++; }
      if (firstOk95 === null && U.length && a200 / U.length >= 0.95) firstOk95 = d;
      acc.set(y, e);
    }
    for (const [y, e] of [...acc].sort()) console.log(`| ${y} | ${e.days} | ${f2(e.size / e.days)} | ${e.lt} | ${pct1(e.m50, e.rows)} | ${pct1(e.m200, e.rows)} | ${pct1(e.h55, e.rows)} |`);
    console.log(`200일선 계산 가능 비율이 처음 95% 이상이 된 날: ${firstOk95 ?? "없음"} (가격 Parquet은 2010-01-04부터라 첫 200거래일 동안은 200일선 불가)`);
  }
  console.log("\n3개 날짜 예시(값 계산 확인용, 해석 없음):\n| 날짜 | K200P 종목 수 | 50일선 위 % (계산 가능 수) | 200일선 위 % (계산 가능 수) | 55일 신고가 수 | 55일 신저가 수 | 55일 계산 가능 수 |\n|---|---|---|---|---|---|---|");
  for (const d of ["2012-12-28", "2020-03-23", dataEnd]) {
    const U = kAtW(d);
    let n50 = 0, a50 = 0, n200 = 0, a200 = 0, nh = 0, hi = 0, lo = 0;
    for (const s of U) {
      const i = s.idx.get(d)!;
      const sma = (N: number): number => { let t = 0; for (let k = i - N + 1; k <= i; k++) t += s.close[k]; return t / N; };
      if (i >= 49) { n50++; if (s.close[i] > sma(50)) a50++; }
      if (i >= 199) { n200++; if (s.close[i] > sma(200)) a200++; }
      if (i >= 55) { nh++; let mx = -Infinity, mn = Infinity; for (let k = i - 55; k < i; k++) { mx = Math.max(mx, s.close[k]); mn = Math.min(mn, s.close[k]); } if (s.close[i] > mx) hi++; if (s.close[i] < mn) lo++; }
    }
    console.log(`| ${d} | ${U.length} | ${pct1(a50, n50)} (${n50}) | ${pct1(a200, n200)} (${n200}) | ${hi} | ${lo} | ${nh} |`);
  }

  // ---------- 2. KOSPI200 편입·편출 ----------
  console.log("\n=== 2. KOSPI200 구성 종목 자료 ===");
  {
    const bucket = INVESTOR_FLOW_STOCK_STORE_BUCKET;
    for (const prefix of ["", "research"]) {
      const { data, error } = await supabaseAdmin.storage.from(bucket).list(prefix, { limit: 200 });
      console.log(`Storage ${bucket}/${prefix || "(루트)"} 목록: ${error ? `오류 ${error.message}` : (data ?? []).map((x) => x.name).join(", ")}`);
    }
    const { data: rs } = await supabaseAdmin.storage.from(bucket).list("research", { limit: 200 });
    for (const f of (rs ?? []).filter((x) => x.id === null)) {
      const { data } = await supabaseAdmin.storage.from(bucket).list(`research/${f.name}`, { limit: 100 });
      console.log(`  research/${f.name}: ${(data ?? []).map((x) => x.name).slice(0, 30).join(", ")}${(data?.length ?? 0) > 30 ? " …" : ""}`);
    }
    console.log(`market_membership Parquet 컬럼: ${Object.keys(mmRows[0] as object).join(", ")} | market 값: ${[...new Set(mmRows.map((r) => r.market))].join(", ")} | 월말 ${mmTargets.length}개`);
    console.log("KOSPI200 구성 종목·편입 발표일 컬럼: 저장 자료에 없음(시장 구분은 KOSPI/KOSDAQ 두 값뿐).");
  }
  console.log("\nK200P(시총 상위 200, 월말 시장 목록 + 유동성·제외 규칙) 월말 구성 변화 — 실제 KOSPI200은 정기변경이 연 2회(6월·12월)라 순위 근사는 매월 바뀜:\n| 연도 | 월말 수 | 신규 편입 합계 | 6·12월 월말 편입 | 그 외 월말 편입 | 월평균 편입 |\n|---|---|---|---|---|---|");
  {
    const mes = monthEnds.filter((d) => d >= CAL[c0]);
    const acc = new Map<string, { n: number; add: number; addJD: number }>();
    let prev: Set<string> | null = null;
    for (const d of mes) {
      const cur = new Set(kAtW(d).map((s) => s.code));
      if (prev) {
        let add = 0;
        for (const x of cur) if (!prev.has(x)) add++;
        const y = yearOf(d), e = acc.get(y) ?? { n: 0, add: 0, addJD: 0 };
        e.n++; e.add += add; if (d.slice(5, 7) === "06" || d.slice(5, 7) === "12") e.addJD += add;
        acc.set(y, e);
      }
      prev = cur;
    }
    for (const [y, e] of [...acc].sort()) console.log(`| ${y} | ${e.n} | ${e.add} | ${e.addJD} | ${e.add - e.addJD} | ${f2(e.add / e.n)} |`);
  }
  console.log("\nK200P 시가총액가중 일별 가격수익률 vs 069500 원주가 일수익률 (근사 오차 진단, 전략 아님; 구성은 전일 K200P·전일 시총 가중, 거래정지 종목 0%):\n| 연도 | 일 수 | K200P 연 수익률 % | 069500 연 수익률 % | 차이 %p | 일수익률 상관 | 연환산 추적오차 % |\n|---|---|---|---|---|---|---|");
  {
    const bhBy = new Map(bhP.dates.map((d, i) => [d, bhP.ret[i] / 100]));
    const byY = new Map<string, { a: number[]; b: number[] }>();
    for (let c = c0 + 1; c < nCal; c++) {
      const pd = CAL[c - 1], d = CAL[c];
      const b = bhBy.get(d);
      if (b === undefined) continue;
      let w = 0, wr = 0;
      for (const s of kAtW(pd)) {
        const ip = s.idx.get(pd)!, m = s.mcapRow[ip];
        if (!(m > 0)) continue;
        const i = s.idx.get(d);
        const r = i === undefined ? 0 : s.close[i] / s.close[ip] - 1;
        w += m; wr += m * r;
      }
      const y = yearOf(d), e = byY.get(y) ?? { a: [], b: [] };
      e.a.push(wr / w); e.b.push(b); byY.set(y, e);
    }
    const comp = (x: number[]): number => x.reduce((p, r) => p * (1 + r), 1) - 1;
    const corr = (x: number[], y: number[]): number => { const mx = avg(x), my = avg(y); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
    for (const [y, e] of [...byY].sort()) {
      const diff = e.a.map((r, i) => r - e.b[i]), m = avg(diff), sd = Math.sqrt(diff.reduce((p, x) => p + (x - m) ** 2, 0) / Math.max(diff.length - 1, 1));
      console.log(`| ${y} | ${e.a.length} | ${f2(comp(e.a) * 100)} | ${f2(comp(e.b) * 100)} | ${f2((comp(e.a) - comp(e.b)) * 100)} | ${f2(corr(e.a, e.b))} | ${f2(sd * Math.sqrt(252) * 100)} |`);
    }
  }

  // ---------- 5. 투자자별 수급 Parquet 커버리지 ----------
  console.log(`\n=== 5. 종목별 투자자 수급 정리본 (${INVESTOR_FLOW_STOCK_STORE_BUCKET}/${INVESTOR_FLOW_STOCK_CLEAN_PREFIX}/연도.parquet) 커버리지 ===\n| 연도 | 행 수 | 종목 수 | K200P 종목-일 | 수급 행 있는 비율 % | 그중 K200P 순위 1~150 % | 순위 151~200 % | 외국인 금액 결측 % | 기관 금액 결측 % | 개인 금액 결측 % |\n|---|---|---|---|---|---|---|---|---|---|`);
  {
    let cols = "";
    for (let y = INVESTOR_FLOW_STOCK_FIRST_YEAR; y <= Number(dataEnd.slice(0, 4)); y++) {
      const { data, error } = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).download(`${INVESTOR_FLOW_STOCK_CLEAN_PREFIX}/${y}.parquet`);
      if (error || !data) { console.log(`| ${y} | 파일 없음 | - | - | - | - | - | - | - | - |`); continue; }
      const rows = (await parquetReadObjects({ file: await data.arrayBuffer() })) as Record<string, unknown>[];
      if (!cols && rows.length) cols = Object.keys(rows[0]).join(", ");
      const has = new Map<string, Set<string>>(), codes = new Set<string>();
      let nF = 0, nO = 0, nP = 0;
      for (const r of rows) {
        const d = String(r.trade_date), code = String(r.stock_code);
        let s = has.get(d); if (!s) { s = new Set(); has.set(d, s); } s.add(code); codes.add(code);
        if (r.frgn_ntby_amt === null || r.frgn_ntby_amt === undefined) nF++;
        if (r.orgn_ntby_amt === null || r.orgn_ntby_amt === undefined) nO++;
        if (r.prsn_ntby_amt === null || r.prsn_ntby_amt === undefined) nP++;
      }
      let tot = 0, cov = 0, tot1 = 0, cov1 = 0, tot2 = 0, cov2 = 0;
      for (let c = c0; c < nCal; c++) {
        const d = CAL[c];
        if (!d.startsWith(`${y}-`)) continue;
        const hs = has.get(d);
        kAtW(d).forEach((s, rank) => { tot++; const ok = hs?.has(s.code) ? 1 : 0; cov += ok; if (rank < INVESTOR_FLOW_TOP_N) { tot1++; cov1 += ok; } else { tot2++; cov2 += ok; } });
      }
      console.log(`| ${y} | ${rows.length} | ${codes.size} | ${tot} | ${pct1(cov, tot)} | ${pct1(cov1, tot1)} | ${pct1(cov2, tot2)} | ${pct1(nF, rows.length)} | ${pct1(nO, rows.length)} | ${pct1(nP, rows.length)} |`);
    }
    console.log(`정리본 컬럼: ${cols || "-"}`);
  }

  // ---------- 6. dart_quarterly_fundamentals 공시일 ----------
  console.log("\n=== 6. dart_quarterly_fundamentals: 공시일(rcept_date) 사용 가능성 ===");
  {
    type QRow = { stock_code: string; fiscal_year: number; quarter: number; status: string; source: string | null; rcept_no: string | null; rcept_date: string | null; off_cycle: boolean; op_income_q: number | null; op_income_prev_q: number | null };
    const rows: QRow[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabaseAdmin.from("dart_quarterly_fundamentals").select("stock_code, fiscal_year, quarter, status, source, rcept_no, rcept_date, off_cycle, op_income_q, op_income_prev_q").order("corp_code").order("fiscal_year").order("quarter").range(from, from + 999);
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as QRow[]));
      dbRead["dart_quarterly_fundamentals(전체)"] = (dbRead["dart_quarterly_fundamentals(전체)"] ?? 0) + (data?.length ?? 0);
      if ((data?.length ?? 0) < 1000) break;
    }
    const QEND: Record<number, string> = { 1: "03-31", 2: "06-30", 3: "09-30" };
    const stat = new Map<string, number>();
    for (const r of rows) stat.set(`${r.status}/${r.source ?? "-"}`, (stat.get(`${r.status}/${r.source ?? "-"}`) ?? 0) + 1);
    console.log(`전체 ${rows.length}행 | status/source별: ${[...stat].sort().map(([k, v]) => `${k} ${v}`).join(", ")} | 분기는 1·2·3분기만 저장(4분기는 연간 − 3분기 누적으로 파생해야 하며 표에 없음)`);
    console.log("| 회계연도·분기 | ok 행 | rcept_date 있음 % | rcept_date < 분기말 | rcept_no 앞 8자리 = rcept_date % | 접수일−분기말(일) 5% / 중앙 / 95% | 정기 시기 외(off_cycle) % | 영업이익·전년동기 둘 다 있음 % | 분기 후 75일 시점 K200P 중 사용 가능 % |\n|---|---|---|---|---|---|---|---|---|");
    for (let fy = 2011; fy <= Number(dataEnd.slice(0, 4)); fy++) {
      for (const q of [1, 2, 3]) {
        const ok = rows.filter((r) => r.fiscal_year === fy && r.quarter === q && r.status === "ok");
        if (!ok.length) continue;
        const qend = `${fy}-${QEND[q]}`;
        const lag = ok.filter((r) => r.rcept_date).map((r) => (Date.parse(r.rcept_date as string) - Date.parse(qend)) / MS_DAY);
        const refAll = new Date(Date.parse(qend) + 75 * MS_DAY).toISOString().slice(0, 10);
        const refC = CAL.findIndex((x) => x >= refAll);
        let covTxt = "-";
        if (refC >= c0 && CAL[refC] <= dataEnd) {
          const d = CAL[refC], U = kAtW(d);
          const have = new Set(ok.filter((r) => !r.off_cycle && r.rcept_date && (r.rcept_date as string) <= d && r.op_income_q !== null && r.op_income_prev_q !== null).map((r) => r.stock_code));
          covTxt = `${pct1(U.filter((s) => have.has(s.code)).length, U.length)} (${d})`;
        }
        console.log(`| ${fy} Q${q} | ${ok.length} | ${pct1(ok.filter((r) => r.rcept_date).length, ok.length)} | ${ok.filter((r) => r.rcept_date && (r.rcept_date as string) < qend).length} | ${pct1(ok.filter((r) => r.rcept_no && r.rcept_date && r.rcept_no.slice(0, 8) === (r.rcept_date as string).replace(/-/g, "")).length, ok.filter((r) => r.rcept_no).length)} | ${f2(pctile(lag, 0.05))} / ${f2(pctile(lag, 0.5))} / ${f2(pctile(lag, 0.95))} | ${pct1(ok.filter((r) => r.off_cycle).length, ok.length)} | ${pct1(ok.filter((r) => r.op_income_q !== null && r.op_income_prev_q !== null).length, ok.length)} | ${covTxt} |`);
      }
    }
  }

  // ---------- 3·4. DART (연구용 키만, 요청 상한) ----------
  const REQUEST_CAP = 190;
  const k3 = process.env.DART_API_KEY_3, k2 = process.env.DART_API_KEY_2;
  if (!k3 || !k2) { console.log("\nDART_API_KEY_3 / DART_API_KEY_2 없음 → 3·4항 건너뜀"); return finish(); }
  const pool = new DartKeyPool([{ name: "DART_API_KEY_3", value: k3 }, { name: "DART_API_KEY_2", value: k2 }], REQUEST_CAP);
  const BASE = "https://opendart.fss.or.kr/api";
  let nextSlot = 0;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const slot = async (): Promise<void> => { const now = Date.now(); const s = Math.max(now, nextSlot); nextSlot = s + 150; if (s > now) await sleep(s - now); };
  async function dartJson(build: (k: string) => string): Promise<Record<string, unknown> | null> {
    for (let attempt = 0; attempt <= 2;) {
      const k = pool.reserve();
      if (!k) return null;
      await slot();
      try {
        const res = await fetch(build(k.value));
        const text = await res.text();
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        const j = JSON.parse(text) as Record<string, unknown>;
        if (j.status === "020") { if (pool.on020(k.name)) continue; return null; }
        if (j.status === "800") throw new Error("800");
        return j;
      } catch { if (attempt < 2) await sleep(1000 * 2 ** attempt); attempt++; }
    }
    return null;
  }
  async function dartDoc(rceptNo: string): Promise<string | null> {
    for (let attempt = 0; attempt <= 1; attempt++) {
      const k = pool.reserve();
      if (!k) return null;
      await slot();
      try {
        const res = await fetch(`${BASE}/document.xml?crtfc_key=${k.value}&rcept_no=${rceptNo}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const zip = new AdmZip(buf);
        const ent = zip.getEntries()[0];
        if (!ent) return null;
        let text = new TextDecoder("utf-8").decode(ent.getData());
        if ((text.match(/�/g) ?? []).length > 20) text = new TextDecoder("euc-kr").decode(ent.getData());
        return text.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ");
      } catch { await sleep(1000); }
    }
    return null;
  }
  const rowsOf = (j: Record<string, unknown> | null): Record<string, string>[] => ((j?.list as Record<string, string>[] | undefined) ?? []);
  const norm = (s: string): string => s.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, "");
  console.log(`\nDART 점검 시작: ${new Date().toISOString()} | 요청 상한 ${REQUEST_CAP}건 | 키 1순위 DART_API_KEY_3, 2순위 DART_API_KEY_2, 운영 키 미사용`);

  // ---- 3. 공시 목록(list.json) 월 샘플: 유가증권시장(corp_cls=Y)만 ----
  const SAMPLES: [string, string, string][] = [["2010", "20101001", "20101031"], ["2015", "20151001", "20151031"], ["2020", "20201001", "20201031"], ["2025", "20251001", "20251031"]];
  const KW: [string, RegExp][] = [["단일판매·공급계약체결", /단일판매.{0,2}공급계약체결/], ["유상증자결정", /유상증자결정/], ["무상증자결정", /무상증자결정/], ["전환사채권발행결정", /전환사채권발행결정/], ["신주인수권부사채권발행결정", /신주인수권부사채권발행결정/]];
  const TYPES: { label: string; q: string; cap: number }[] = [{ label: "B001 주요사항보고서", q: "pblntf_ty=B&pblntf_detail_ty=B001", cap: 6 }, { label: "I001 수시공시", q: "pblntf_ty=I&pblntf_detail_ty=I001", cap: 20 }];
  const sample = new Map<string, { rcept_no: string; corp_code: string; corp_name: string; report_nm: string; ym: string }>();
  console.log("\n=== 3. DART 공시검색(list.json) 월 샘플 (유가증권시장 corp_cls=Y, 페이지당 100건) ===\n| 월 | 유형 | status | 총 건수 | 총 페이지 | 받은 페이지 | 받은 행 | 접수일 종류 수 | rcept_no 앞 8자리 ≠ rcept_dt 행 | 정정(기재정정 등) 행 % | 키워드별 받은 행 수 → 총 건수 환산 |\n|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [ym, bgn, end] of SAMPLES) {
    for (const t of TYPES) {
      let total = 0, totalPage = 0, fetched = 0, status = "-";
      const got: Record<string, string>[] = [];
      for (let p = 1; p <= t.cap; p++) {
        const j = await dartJson((k) => `${BASE}/list.json?crtfc_key=${k}&bgn_de=${bgn}&end_de=${end}&corp_cls=Y&${t.q}&page_no=${p}&page_count=100`);
        if (!j) { status = status === "-" ? "요청 실패/상한" : status; break; }
        if (p === 1) { status = String(j.status); total = Number(j.total_count ?? 0); totalPage = Number(j.total_page ?? 0); }
        if (j.status !== "000") break;
        fetched++;
        got.push(...rowsOf(j));
        if (p >= totalPage) break;
      }
      const kwTxt = KW.map(([name, re]) => {
        const hit = got.filter((r) => re.test(norm(r.report_nm ?? "")));
        for (const r of hit) { const key = `${name}|${ym}`; if (!sample.has(key)) sample.set(key, { rcept_no: r.rcept_no, corp_code: r.corp_code, corp_name: r.corp_name, report_nm: r.report_nm, ym }); }
        return `${name} ${hit.length}→${got.length ? Math.round((hit.length / got.length) * total) : 0}`;
      }).join(" / ");
      const days = new Set(got.map((r) => r.rcept_dt)).size;
      const mismatch = got.filter((r) => (r.rcept_no ?? "").slice(0, 8) !== r.rcept_dt).length;
      const corr = got.filter((r) => /정정/.test(r.report_nm ?? "") || /정정/.test(r.rm ?? "")).length;
      console.log(`| ${ym}-10 | ${t.label} | ${status} | ${total} | ${totalPage} | ${fetched} | ${got.length} | ${days} | ${mismatch} | ${pct1(corr, got.length)} | ${kwTxt} |`);
    }
  }
  console.log("받은 행 수가 총 건수보다 작으면(페이지 상한) 키워드 환산 = 받은 행 중 비율 × 총 건수의 근사. list.json 응답 필드: 접수번호(rcept_no)·접수일(rcept_dt, 날짜만)·보고서명·제출인·비고 — 접수 시각(시·분)은 없음.");

  // ---- 3-b. 본문 수치 추출 가능성 (document.xml 샘플) ----
  console.log("\n=== 3-b. 공시 본문(document.xml) 수치 추출 샘플 ===");
  const LABELS: Record<string, string[]> = {
    "단일판매·공급계약체결": ["계약금액", "계약상대", "계약기간", "매출액 대비", "계약내역"],
    "유상증자결정": ["신주의 종류와 수", "증자방식", "자금조달의 목적", "발행가액", "증자전 발행주식총수"],
    "전환사채권발행결정": ["사채의 권면(전자등록)총액", "권면총액", "전환가액", "표면이자율", "사채만기일"],
  };
  const docPick: [string, string][] = [["단일판매·공급계약체결", "2025"], ["단일판매·공급계약체결", "2015"], ["유상증자결정", "2020"], ["전환사채권발행결정", "2020"]];
  for (const [kw, ym] of docPick) {
    const sm = sample.get(`${kw}|${ym}`) ?? [...sample.entries()].find(([k]) => k.startsWith(`${kw}|`))?.[1];
    if (!sm) { console.log(`- ${kw} ${ym}-10 표본 없음`); continue; }
    const text = await dartDoc(sm.rcept_no);
    if (!text) { console.log(`- ${kw} (${sm.ym}-10, ${sm.corp_name}, ${sm.rcept_no.slice(0, 8)}) 본문 받기 실패`); continue; }
    const found = (LABELS[kw] ?? []).map((lb) => { const i = text.indexOf(lb); return i >= 0 ? `[${lb}] ${text.slice(i + lb.length, i + lb.length + 70).trim()}` : `[${lb}] (못 찾음)`; });
    console.log(`- ${kw} (${sm.ym}-10, ${sm.corp_name}, 접수 ${fmtD(sm.rcept_no.slice(0, 8))}): 본문 ${text.length}자 | ${found.join(" | ")}`);
  }

  // ---- 3-c. 구조화 API(DS005) 시작 연도·필드 ----
  console.log("\n=== 3-c. 주요사항보고서 구조화 API(DS005) 샘플: 표본 회사 1곳씩, 2015-01-01~데이터 끝 ===");
  const ds5: [string, string][] = [["유상증자결정", "piicDecsn.json"], ["전환사채권발행결정", "cvbdIsDecsn.json"], ["신주인수권부사채권발행결정", "bdwtIsDecsn.json"], ["무상증자결정", "fricDecsn.json"]];
  for (const [kw, path] of ds5) {
    const sm = [...sample.entries()].filter(([k]) => k.startsWith(`${kw}|`)).map(([, v]) => v).sort((a, b) => (a.ym < b.ym ? 1 : -1))[0];
    if (!sm) { console.log(`- ${kw}: 표본 월에 대상 공시가 없어 호출 안 함`); continue; }
    const j = await dartJson((k) => `${BASE}/${path}?crtfc_key=${k}&corp_code=${sm.corp_code}&bgn_de=20150101&end_de=${dataEnd.replace(/-/g, "")}`);
    const rs = rowsOf(j);
    const ds = rs.map((r) => (r.rcept_no ?? "").slice(0, 8)).sort();
    console.log(`- ${kw} (${path}, ${sm.corp_name}): status ${j ? String(j.status) : "요청 실패"} | 건수 ${rs.length} | 접수일 ${ds.length ? `${fmtD(ds[0])} ~ ${fmtD(ds[ds.length - 1])}` : "-"} | 필드 ${rs[0] ? Object.keys(rs[0]).join(",") : "-"} | 예시 ${rs[0] ? JSON.stringify(rs[0]).slice(0, 420) : "-"}`);
  }
  {
    const sm = sample.get("유상증자결정|2010");
    if (sm) {
      const j = await dartJson((k) => `${BASE}/piicDecsn.json?crtfc_key=${k}&corp_code=${sm.corp_code}&bgn_de=20100101&end_de=20101231`);
      console.log(`- 유상증자결정 2010년 표본(${sm.corp_name}, 접수 ${fmtD(sm.rcept_no.slice(0, 8))}): piicDecsn.json 2010 조회 status ${j ? String(j.status) : "요청 실패"} | 메시지 ${j ? String(j.message ?? "") : "-"} | 건수 ${rowsOf(j).length}`);
    } else console.log("- 2010년 유상증자결정 표본 없음");
  }
  console.log("단일판매·공급계약체결은 OpenDART 구조화 API(DS005 목록)에 해당 엔드포인트가 없는 것으로 알고 있으며(문서 기준, 호출로 확인하지는 않음) 본문 파싱이 필요하다.");

  // ---- 4. 임원·주요주주 소유보고 (elestock.json) ----
  console.log("\n=== 4. 임원·주요주주 특정증권등 소유상황보고(elestock.json) ===");
  {
    const codes = ["005930", "000660", "005850"];
    const corpMap = new Map<string, string>();
    const { data } = await supabaseAdmin.from("dart_corp_codes").select("corp_code, stock_code, corp_name").in("stock_code", codes);
    dbRead["dart_corp_codes(표본)"] = (data?.length ?? 0);
    for (const r of data ?? []) corpMap.set(r.stock_code as string, r.corp_code as string);
    const docRceipts: { code: string; rcept_no: string; rcept_dt: string }[] = [];
    console.log("| 종목 | status | 총 건수 | 연도별 건수 | 가장 이른 접수일 | 가장 늦은 접수일 | 필드 |\n|---|---|---|---|---|---|---|");
    for (const code of codes) {
      const corp = corpMap.get(code);
      if (!corp) { console.log(`| ${code} | corp_code 없음 | - | - | - | - | - |`); continue; }
      const j = await dartJson((k) => `${BASE}/elestock.json?crtfc_key=${k}&corp_code=${corp}`);
      const rs = rowsOf(j);
      const byYear = new Map<string, number>();
      for (const r of rs) byYear.set((r.rcept_dt ?? "").slice(0, 4), (byYear.get((r.rcept_dt ?? "").slice(0, 4)) ?? 0) + 1);
      const ds = rs.map((r) => r.rcept_dt ?? "").filter(Boolean).sort();
      console.log(`| ${code} | ${j ? String(j.status) : "요청 실패"} | ${rs.length} | ${[...byYear].sort().map(([y, n]) => `${y}:${n}`).join(" ")} | ${ds.length ? fmtD(ds[0]) : "-"} | ${ds.length ? fmtD(ds[ds.length - 1]) : "-"} | ${rs[0] ? Object.keys(rs[0]).join(",") : "-"} |`);
      if (code === "005850" || (code === "000660" && !docRceipts.length)) {
        const srt = [...rs].sort((a, b) => ((a.rcept_dt ?? "") < (b.rcept_dt ?? "") ? -1 : 1));
        for (const pick of [srt[0], srt[Math.floor(srt.length / 2)], srt[srt.length - 1]]) if (pick && docRceipts.length < 3 && !docRceipts.some((x) => x.rcept_no === pick.rcept_no)) docRceipts.push({ code, rcept_no: pick.rcept_no, rcept_dt: pick.rcept_dt });
      }
    }
    console.log("elestock.json 응답에는 변동(거래)일 필드가 없음 → 거래일은 본문에서 읽어야 하는지 본문 샘플로 확인:");
    for (const dr of docRceipts) {
      const text = await dartDoc(dr.rcept_no);
      if (!text) { console.log(`- ${dr.code} 접수 ${fmtD(dr.rcept_dt)}: 본문 받기 실패`); continue; }
      const i = text.indexOf("변동일"), j2 = text.indexOf("취득/처분");
      const snip = i >= 0 ? text.slice(i, i + 140) : "(변동일 못 찾음)";
      const dm = i >= 0 ? text.slice(i, i + 200).match(/(\d{4})[-.\s년]+(\d{1,2})[-.\s월]+(\d{1,2})/) : null;
      const trade = dm ? `${dm[1]}-${dm[2].padStart(2, "0")}-${dm[3].padStart(2, "0")}` : null;
      console.log(`- ${dr.code} 접수 ${fmtD(dr.rcept_dt)} 본문 ${text.length}자 | 변동일 근처: ${snip} | 처음 읽힌 날짜 ${trade ?? "-"} → 접수일과 간격 ${trade ? Math.round((Date.parse(fmtD(dr.rcept_dt)) - Date.parse(trade)) / MS_DAY) : "-"}일 | '취득/처분' 위치 ${j2}`);
    }
  }
  console.log(`\nDART 요청 수: ${pool.total} (상한 ${REQUEST_CAP}) | 키별: ${[...pool.used].map(([n, v]) => `${n} ${v}`).join(", ")} | status 020: ${[...pool.got020].map(([n, v]) => `${n} ${v}`).join(", ")} | 중단 사유: ${pool.stopReason ?? "없음"}`);
  finish();

  function finish(): void {
    console.log("\n=== 실행 지표 ===");
    console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
    console.log(`Supabase 쓴 행: 0 | Storage 쓰기 0 | KIS·KRX 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

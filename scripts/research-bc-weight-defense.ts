/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] B·C: 위성 비중 변형(60:40) / 주식 아니면 현금 방어형(C1~C3) (누적 시험 146~149).
 * 사전 등록: docs/research/bc-weight-defense-prereg.md (a28dfbd). 입력·K200P·업종 모멘텀·정리·엔진·조합은
 * scripts/research-kodex-sector-satellite-v3_2.ts(0158359) 그대로 복사.
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
import { KSS_TOP_K, KSS_MIX_WEIGHTS, KSS_DEFAULT_W, KSS_G1_MARGIN_PP, KSS_G2_MDD_MARGIN_PP, KSS_G4_MAX_DELAY_DROP_PP, KSS_R1_TOP_KS, KSS_R3_DRAWS, KSS_R3_SEED, KSS31_PER_SECTOR, KSS31_R1_LOOKBACKS, KSS31_PRACTICAL_FROM, KSS32_TRIM_MIN_WEIGHT, KSS32_R1_TRIMS, KSS32_SEEDS_WON, KSS32_ETF_SLIPPAGE, BC_B_WEIGHT, BC_B_SAT_CAP, BC_R3_MIN_PCTILE, BC_C_MA_MONTHS, BC_C_R1_MA_MONTHS, BC_C2_EXPOSURE, BC_C_G1_MIN_CAGR, BC_C_G2_MAX_MDD, BC_C_G3_MIN_WORST12 } from "@/lib/kodexSectorSatConfig";
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
  console.log(`KODEX 200 + 업종 모멘텀 위성 B·C(a28dfbd) 시작(읽기 전용): ${new Date().toISOString()} (사전등록 d70b1fd 이후)`);
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


  // ===================== B·C (a28dfbd) =====================
  const tA = trimmedTargets(C31, KSS32_TRIM_MIN_WEIGHT);
  const S3 = run(tA, false), S3D = run(tA, true);
  const LEARN: Win = { ...SMT_LEARN }, CONFIRM: Win = { ...LV_CONFIRM }, HOLD: Win = { from: LV_HOLDOUT_FROM, to: "9999-12-31" }, FULL: Win = { from: SMT_LEARN.from, to: "9999-12-31" };
  const GW: [string, Win][] = [["학습", LEARN], ["확인", CONFIRM], ["보류", HOLD]];
  const ALLW: [string, Win][] = [...GW, ["전 기간", FULL]];
  const winTo = (w: Win): string => (w.to > dataEnd ? dataEnd : w.to);
  /** 최악 12개월: 기준점 = 구간 시작 직전 날(없으면 첫 날) + 구간 안 월말 거래일, i ~ i+12 수익률 최솟값. */
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
  const avg = (a: number[]): number => a.reduce((x, z) => x + z, 0) / Math.max(a.length, 1);
  const median = (a: number[]): number => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };
  const seedLab = (seed: number): string => `${(seed / 10_000).toLocaleString("ko-KR")}만 원`;
  // ---- B 실제 시드 시뮬레이션 ----
  const etfRawLe = (d: string): number => { let lo = 0, hi = etfRawRows.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (etfRawRows[m].d <= d) { k = m; lo = m + 1; } else hi = m - 1; } return k >= 0 ? etfRawRows[k].px : NaN; };
  const rawLe = (c: string, d: string): { px: number; sub: boolean } => {
    const s = byCode.get(c)!;
    const i = s.idx.get(d);
    if (i !== undefined) return { px: s.raw[i], sub: false };
    let lo = 0, hi = s.dates.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (s.dates[m] <= d) { k = m; lo = m + 1; } else hi = m - 1; }
    return { px: k >= 0 ? s.raw[k] : NaN, sub: true };
  };
  const roundHalfUp = (x: number): number => Math.floor(x + 0.5);
  const stockBuyMult = computeEffectiveBuyPrice(1), stockSellMult = (d: string): number => computeEffectiveSellPrice(1, d, "KR");
  const etfBuyMult = (1 + KSS32_ETF_SLIPPAGE) * (1 + FEE_PCT_PER_SIDE), etfSellMult = (1 - KSS32_ETF_SLIPPAGE) * (1 - FEE_PCT_PER_SIDE);
  const execIdx = new Map<number, number>();
  sigs.forEach((d, k) => { const j = calIdx.get(d)! + 1; if (j < nCal) execIdx.set(j, k); });
  interface SimOut { dates: string[]; ret: number[]; cashW: number[]; satW: number[]; capHits: number; zeroMonths: number; finalV: number; subs: string[]; adjApplied: number; liq: number; lastHold: { code: string; n: number; px: number }[]; lastEtf: { n: number; px: number }; lastCash: number; lastV: number }
  const simulate = (seed: number, targets: (Target & { etf: boolean })[], simW: number, simCap: number): SimOut => {
    let cash = seed, E = 0, prevV = seed;
    const hold = new Map<string, { n: number; ev: number }>();
    const out: SimOut = { dates: [], ret: [], cashW: [], satW: [], capHits: 0, zeroMonths: 0, finalV: 0, subs: [], adjApplied: 0, liq: 0, lastHold: [], lastEtf: { n: 0, px: 0 }, lastCash: 0, lastV: 0 };
    const evOf = (c: string): { eventDate: string; factor: number }[] => adjustments.get(c) ?? [];
    for (let c = calIdx.get(firstExec)!; c < nCal; c++) {
      const d = CAL[c];
      // 조정 이벤트·폐지
      for (const [code, h] of hold) {
        const evs = evOf(code);
        while (h.ev < evs.length && evs[h.ev].eventDate <= d) { h.n /= evs[h.ev].factor; h.ev++; out.adjApplied++; }
        const s = byCode.get(code)!;
        if (!s.idx.has(d) && s.last < d && s.last < endedBefore) { cash += h.n * rawLe(code, d).px * stockSellMult(d); hold.delete(code); out.liq++; }
      }
      const pE = etfRawLe(d);
      const k = execIdx.get(c);
      if (k !== undefined) {
        const t = targets[k];
        let V = cash + E * pE;
        for (const [code, h] of hold) V += h.n * rawLe(code, d).px;
        const tgt = new Map<string, { n: number; px: number }>();
        if (!t.etf) for (const [code, w] of t.w) { const r = rawLe(code, d); if (r.sub) out.subs.push(`${d} ${code} 대체 ${r.px}`); if (r.px > 0) tgt.set(code, { n: roundHalfUp((V * simW * w) / r.px), px: r.px }); }
        let satVal = [...tgt.values()].reduce((a, x) => a + x.n * x.px, 0);
        if (satVal > simCap * V) {
          out.capHits++;
          const order = [...tgt.entries()].sort((a, b) => b[1].px - a[1].px);
          for (let i = 0; satVal > simCap * V; i = (i + 1) % order.length) { const x = order[i][1]; if (x.n > 0) { x.n--; satVal -= x.px; } }
        }
        // (1) 매도: 소수 주수, 목표 초과분
        for (const [code, h] of hold) {
          const px = rawLe(code, d).px, want = tgt.get(code)?.n ?? 0;
          const sellQ = h.n > want ? h.n - want : h.n - Math.floor(h.n);
          if (sellQ > 1e-9) { cash += sellQ * px * stockSellMult(d); h.n -= sellQ; }
          if (h.n <= 1e-9) hold.delete(code);
        }
        // (2) 위성 매수(현금 부족 시 069500 매도, 그래도 부족하면 비싼 종목부터 1주씩 축소)
        const need = [...tgt.entries()].map(([code, x]) => ({ code, px: x.px, q: Math.max(0, x.n - Math.round(hold.get(code)?.n ?? 0)) }));
        let cost = need.reduce((a, x) => a + x.q * x.px * stockBuyMult, 0);
        if (cost > cash && E > 0) { const kq = Math.min(E, Math.ceil((cost - cash) / (pE * etfSellMult))); cash += kq * pE * etfSellMult; E -= kq; }
        if (cost > cash) {
          const order = [...need].sort((a, b) => b.px - a.px);
          for (let i = 0; cost > cash; i = (i + 1) % order.length) { const x = order[i]; if (x.q > 0) { x.q--; cost -= x.px * stockBuyMult; } else if (order.every((y) => y.q === 0)) break; }
        }
        for (const x of need) {
          if (x.q <= 0) continue;
          cash -= x.q * x.px * stockBuyMult;
          const h = hold.get(x.code);
          if (h) h.n += x.q;
          else { const evs = evOf(x.code); let ev = 0; while (ev < evs.length && evs[ev].eventDate <= d) ev++; hold.set(x.code, { n: x.q, ev }); }
        }
        // (3) 남은 현금으로 069500
        if (pE > 0) { const m = Math.floor(cash / (pE * etfBuyMult)); if (m > 0) { E += m; cash -= m * pE * etfBuyMult; } }
        let Va = cash + E * pE, sv = 0;
        for (const [code, h] of hold) { const v = h.n * rawLe(code, d).px; Va += v; sv += v; }
        out.satW.push(Va > 0 ? sv / Va : 0);
        if (!t.etf && t.n > 0 && hold.size === 0) out.zeroMonths++;
        if (k === sigs.length - 1) { out.lastHold = [...hold].map(([code, h]) => ({ code, n: h.n, px: rawLe(code, d).px })); out.lastEtf = { n: E, px: pE }; out.lastCash = cash; out.lastV = Va; }
      }
      let V = cash + E * pE;
      for (const [code, h] of hold) V += h.n * rawLe(code, d).px;
      out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.cashW.push(V > 0 ? cash / V : 0);
      prevV = V;
      out.finalV = V;
    }
    return out;
  };

  // ---------------- B 60:40 (시험 146) ----------------
  const W6 = BC_B_WEIGHT, lab6 = `${Math.round((1 - W6) * 100)}:${Math.round(W6 * 100)}`;
  const M6 = mix(S3, W6, bhP), M6D = mix(S3D, W6, bhP), M80 = mix(S3, KSS_DEFAULT_W, bhP);
  console.log(`\n##### B. 069500:위성 = ${lab6} (시험 146) — 80:20은 기준선(계수 안 함) #####`);
  let bGates = true;
  for (const [name, win] of ALLW) {
    const graded = win !== FULL;
    const m = st(M6, win), md = st(M6D, win), b = st(bhP, win), base = st(M80, win);
    const drop = m.cagr - md.cagr;
    const g = [m.cagr >= b.cagr + KSS_G1_MARGIN_PP, m.mdd <= b.mdd + KSS_G2_MDD_MARGIN_PP + SAT_MDD_EPS, m.sharpe >= b.sharpe, drop <= KSS_G4_MAX_DELAY_DROP_PP];
    if (graded && !g.every(Boolean)) bGates = false;
    console.log(`\n=== B ${name} ${win.from}~${winTo(win)} ===\n| 구성 | CAGR % | MDD % | 샤프 | 연변동성 % | 최악 12개월 % | 지연 CAGR % | 지연 하락 %p |\n|---|---|---|---|---|---|---|---|`);
    console.log(`| ${lab6} | ${f2(m.cagr)} | ${f2(m.mdd)} | ${f2(m.sharpe)} | ${f2(m.vol)} | ${f2(worst12(M6, win))} | ${f2(md.cagr)} | ${f2(drop)} |`);
    console.log(`| 80:20 기준선 | ${f2(base.cagr)} | ${f2(base.mdd)} | ${f2(base.sharpe)} | ${f2(base.vol)} | ${f2(worst12(M80, win))} | - | - |`);
    console.log(`| B&H 가격(069500 원주가) | ${f2(b.cagr)} | ${f2(b.mdd)} | ${f2(b.sharpe)} | ${f2(b.vol)} | ${f2(worst12(bhP, win))} | - | - |`);
    console.log(`G1 CAGR ≥ ${f2(b.cagr + KSS_G1_MARGIN_PP)} → ${graded ? ox(g[0]) : "-"} | G2 MDD ≤ ${f2(b.mdd + KSS_G2_MDD_MARGIN_PP)} → ${graded ? ox(g[1]) : "-"} | G3 샤프 ≥ ${f2(b.sharpe)} → ${graded ? ox(g[2]) : "-"} | G4 지연 하락 ${f2(drop)} ≤ ${KSS_G4_MAX_DELAY_DROP_PP} → ${graded ? ox(g[3]) : "-"}`);
  }
  const full6 = st(M6, FULL), fullB = st(bhP, FULL);
  console.log(`\n=== B R1 이웃값 (${lab6}, 전 기간; 기본 CAGR ${f2(full6.cagr)}; 기준 B&H 가격 CAGR ${f2(fullB.cagr)} 초과) ===\n| 변형 | CAGR % | 샤프 | MDD % | > B&H |\n|---|---|---|---|---|`);
  let r1Ok = true;
  const r1 = (label: string, c: SCfg, thr: number): void => { const m = st(mix(run(trimmedTargets(c, thr), false), W6, bhP), FULL); const ok = m.cagr > fullB.cagr; if (!ok) r1Ok = false; console.log(`| ${label} | ${f2(m.cagr)} | ${f2(m.sharpe)} | ${f2(m.mdd)} | ${ox(ok)} |`); };
  for (const L of KSS31_R1_LOOKBACKS) r1(`모멘텀 기간 ${L}개월(최근 1개월 제외)`, { ...C31, L }, KSS32_TRIM_MIN_WEIGHT);
  for (const thr of KSS32_R1_TRIMS) r1(`정리 기준 ${thr * 100}%`, C31, thr);
  for (const K of KSS_R1_TOP_KS) r1(`상위 ${K}개 업종`, { ...C31, K }, KSS32_TRIM_MIN_WEIGHT);
  const bhBy = new Map(bhP.dates.map((d, i) => [d, bhP.ret[i]]));
  const mm2 = new Map<string, { s: number[]; w: number[]; idx: number[] }>();
  M6.dates.forEach((d, i) => { if (d <= firstExec) return; const kk = d.slice(0, 7); const e = mm2.get(kk) ?? { s: [], w: [], idx: [] }; e.s.push(M6.ret[i]); e.w.push(bhBy.get(d) ?? 0); e.idx.push(i); mm2.set(kk, e); });
  let best = { m: "", ex: -Infinity };
  for (const [k, e] of mm2) { const ex = computeCumulativeAndMdd(e.s).totalReturnPct - computeCumulativeAndMdd(e.w).totalReturnPct; if (ex > best.ex) best = { m: k, ex }; }
  const repl = [...M6.ret];
  for (const i of mm2.get(best.m)!.idx) repl[i] = bhBy.get(M6.dates[i]) ?? 0;
  const r2c = st({ dates: M6.dates, ret: repl }, FULL).cagr, r2Ok = r2c > fullB.cagr;
  console.log(`\n=== B R2 상위 사건 제거 (${lab6} vs B&H 가격) ===\n| 바꾼 달 | 그 달 차이 %p | 바꾼 뒤 전 기간 CAGR % | 바꾸기 전 CAGR % | B&H 가격 CAGR % | > B&H |\n|---|---|---|---|---|---|\n| ${best.m} | ${f2(best.ex)} | ${f2(r2c)} | ${f2(full6.cagr)} | ${f2(fullB.cagr)} | ${ox(r2Ok)} |`);
  const rng = mulberry32(KSS_R3_SEED);
  const orders = sigs.map((d) => rankedSectors(d, C31.L));
  const cg: number[] = [];
  for (let n = 0; n < KSS_R3_DRAWS; n++) {
    const tg = sigs.map((d, k) => {
      const a = [...orders[k]];
      const take = Math.min(C31.K, a.length);
      for (let i = 0; i < take; i++) { const j = i + Math.floor(rng() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; }
      return trim(satW(d, a.length ? new Set(a.slice(0, take)) : null, false, C31.N), KSS32_TRIM_MIN_WEIGHT);
    });
    cg.push(st(mix(run(tg, false), W6, bhP), FULL).cagr);
  }
  const sorted = [...cg].sort((x, y) => x - y), pct = (cg.filter((x) => x < full6.cagr).length / cg.length) * 100, r3Ok = pct >= BC_R3_MIN_PCTILE;
  console.log(`\n=== B R3 무작위 업종 (${KSS_R3_DRAWS}회, 시드 ${KSS_R3_SEED}, ${lab6}, 전 기간) ===\n| 지표 | 무작위 중앙값 | 95분위 | 최대 | ${lab6} | 이상 회수 | 백분위 | ≥ ${BC_R3_MIN_PCTILE} |\n|---|---|---|---|---|---|---|---|\n| CAGR % | ${f2(sorted[Math.floor(sorted.length / 2)])} | ${f2(sorted[Math.floor(sorted.length * 0.95)])} | ${f2(sorted[sorted.length - 1])} | ${f2(full6.cagr)} | ${cg.filter((x) => x >= full6.cagr).length} | ${f2(pct)} | ${ox(r3Ok)} |`);
  console.log(`\nB 60:40 통과 여부: G1~G4(학습·확인·보류) ${ox(bGates)} | R1 ${ox(r1Ok)} | R2 ${ox(r2Ok)} | R3 ${ox(r3Ok)} → ${bGates && r1Ok && r2Ok && r3Ok ? "통과" : "탈락"}`);

  // 삼성전자 + SK하이닉스
  const pairIn = tA.map((t) => (t.etf ? 0 : (t.w.get("005930") ?? 0) + (t.w.get("000660") ?? 0)));
  const recentK = sigs.map((d, k) => [d, k] as [string, number]).filter(([d]) => d.slice(0, 7) >= KSS31_PRACTICAL_FROM).map(([, k]) => k);
  console.log(`\n=== B 삼성전자+SK하이닉스 직접 보유 합산 비중 (신호일 목표, KODEX 200 안 간접 보유 제외) ===\n| 범위 | 신호일 수 | 위성 내 평균 % | 위성 내 최대 % | ${lab6} 계좌 평균 % | ${lab6} 계좌 최대 % |\n|---|---|---|---|---|---|`);
  for (const [lab, ks] of [["전 기간", sigs.map((_, k) => k)], [`${KSS31_PRACTICAL_FROM} 이후`, recentK]] as [string, number[]][]) {
    const v = ks.map((k) => pairIn[k]);
    console.log(`| ${lab} | ${v.length} | ${f2(avg(v) * 100)} | ${f2(Math.max(...v) * 100)} | ${f2(avg(v) * W6 * 100)} | ${f2(Math.max(...v) * W6 * 100)} |`);
  }

  // 시드 정수 주 모의
  console.log(`\n=== B 시드 정수 주 모의 (${lab6}, 위성 목표 ${W6 * 100}%, 위성 상한 ${BC_B_SAT_CAP * 100}%) ===\n| 시드 | 구간 | CAGR % | MDD % | 최악 12개월 % | 샤프 | B&H 가격 대비 CAGR %p |\n|---|---|---|---|---|---|---|`);
  const SIMS = KSS32_SEEDS_WON.map((seed) => ({ seed, o: simulate(seed, tA, W6, BC_B_SAT_CAP) }));
  for (const { seed, o } of SIMS) for (const [name, win] of ALLW) { const s = st(o, win), b = st(bhP, win); console.log(`| ${seedLab(seed)} | ${name} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(worst12(o, win))} | ${f2(s.sharpe)} | ${f2(s.cagr - b.cagr)} |`); }
  console.log(`\n| 시드 | 평균 현금 비중 % | 위성 실제 비중 % (평균 / 최소 / 최대) | 상한 발동 | 위성 0주 달 | 최종 평가액(원) | 조정 이벤트 | 폐지 청산 | 대체 가격 |\n|---|---|---|---|---|---|---|---|---|`);
  for (const { seed, o } of SIMS) console.log(`| ${seedLab(seed)} | ${f2(avg(o.cashW) * 100)} | ${f2(avg(o.satW) * 100)} / ${f2(Math.min(...o.satW) * 100)} / ${f2(Math.max(...o.satW) * 100)} | ${o.capHits} | ${o.zeroMonths} | ${Math.round(o.finalV).toLocaleString("ko-KR")} | ${o.adjApplied} | ${o.liq} | ${o.subs.length} |`);

  // ---------------- C 방어형 (시험 147~149) ----------------
  // 069500 월말 원 종가: 2010 이전은 069500 행의 월말, 이후는 가격 달력 월말(신호일 목록과 같음).
  const etfME: string[] = [];
  for (let i = 0; i < etfRawRows.length; i++) { const d = etfRawRows[i].d; if (d >= CAL[0]) break; if (i + 1 === etfRawRows.length || etfRawRows[i + 1].d.slice(0, 7) !== d.slice(0, 7)) etfME.push(d); }
  const allME = [...etfME.filter((d) => d.slice(0, 7) < CAL[0].slice(0, 7)), ...monthEnds];
  const allMEIdx = new Map(allME.map((d, i) => [d, i]));
  const isAbove = (d: string, N: number): boolean => {
    const i = allMEIdx.get(d)!;
    if (i < N - 1) throw new Error(`${d}: 이동평균 ${N}개월 자료 부족`);
    let s = 0;
    for (let k = i - N + 1; k <= i; k++) s += etfRawLe(allME[k]);
    return etfRawLe(d) > s / N;
  };
  const etfLeg = 1 - KSS_DEFAULT_W;
  interface DefOut extends Ser { expo: number[]; execE: { d: string; e: number }[] }
  const defense = (base: Ser, eOn: number, N: number, delay: boolean, stockOnly: boolean): DefOut => {
    const exec = new Map<string, number>();
    sigs.forEach((d, k) => { const j = calIdx.get(d)! + 1 + (delay ? 1 : 0); if (j < nCal) exec.set(CAL[j], isAbove(sigs[k], N) ? eOn : 0); });
    const e0 = isAbove(sigs[0], N) ? eOn : 0;
    let Sv = e0, Cv = 1 - e0, prevV = 1;
    const out: DefOut = { dates: [], ret: [], expo: [], execE: [] };
    for (let i = 0; i < base.dates.length; i++) {
      const d = base.dates[i];
      if (i > 0) Sv *= 1 + base.ret[i] / 100;
      const e = exec.get(d);
      if (e !== undefined) {
        out.execE.push({ d, e });
        if (i > 0) {
          const V = Sv + Cv, x = e * V - Sv;
          const rate = x > 0 ? (stockOnly ? buyRate : etfLeg * SAT_ETF_COST_PER_SIDE + KSS_DEFAULT_W * buyRate) : stockOnly ? sellRate(d) : etfLeg * SAT_ETF_COST_PER_SIDE + KSS_DEFAULT_W * sellRate(d);
          const V2 = V - Math.abs(x) * rate;
          Sv = e * V2; Cv = (1 - e) * V2;
        }
      }
      const V = Sv + Cv;
      out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.expo.push(V > 0 ? Sv / V : 0);
      prevV = V;
    }
    return out;
  };
  const S3only = S3 as Ser, S3Donly = S3D as Ser, M80D = mix(S3D, KSS_DEFAULT_W, bhP);
  const CS = [
    { id: "C1", no: 147, eOn: 1, base: M80 as Ser, baseD: M80D as Ser, stockOnly: false, satW: KSS_DEFAULT_W, etfW: etfLeg },
    { id: "C2", no: 148, eOn: BC_C2_EXPOSURE, base: M80 as Ser, baseD: M80D as Ser, stockOnly: false, satW: KSS_DEFAULT_W * BC_C2_EXPOSURE, etfW: etfLeg * BC_C2_EXPOSURE },
    { id: "C3", no: 149, eOn: 1, base: S3only, baseD: S3Donly, stockOnly: true, satW: 1, etfW: 0 },
  ];
  const g13 = (o: Ser, win: Win): { cagr: number; mdd: number; w12: number; ok: boolean[] } => {
    const s = st(o, win), w12 = worst12(o, win);
    return { cagr: s.cagr, mdd: s.mdd, w12, ok: [s.cagr >= BC_C_G1_MIN_CAGR, s.mdd <= BC_C_G2_MAX_MDD + SAT_MDD_EPS, w12 >= BC_C_G3_MIN_WORST12] };
  };
  const passAll = (o: Ser): boolean => GW.every(([, w]) => g13(o, w).ok.every(Boolean));
  console.log(`\n##### C. 방어형(069500 월말 원 종가 vs ${BC_C_MA_MONTHS}개월 이동평균, 아래면 현금 100%, 이자 0) #####`);
  console.log(`판정: G1 CAGR ≥ ${BC_C_G1_MIN_CAGR}, G2 MDD ≤ ${BC_C_G2_MAX_MDD}, G3 최악 12개월 ≥ ${BC_C_G3_MIN_WORST12}, G4 지연 버전 G1~G3, R1 이동평균 ${BC_C_R1_MA_MONTHS.join("·")}개월 G1~G3 — 학습·확인·보류 각각`);
  const summary: string[] = [];
  for (const c of CS) {
    const o = defense(c.base, c.eOn, BC_C_MA_MONTHS, false, c.stockOnly), od = defense(c.baseD, c.eOn, BC_C_MA_MONTHS, true, c.stockOnly);
    const nb = BC_C_R1_MA_MONTHS.map((N) => ({ N, o: defense(c.base, c.eOn, N, false, c.stockOnly) }));
    console.log(`\n=== ${c.id} (시험 ${c.no}) — 위: ${c.stockOnly ? "위성 100%" : "80:20 전략"} ${c.eOn * 100}%${c.eOn < 1 ? ` + 현금 ${Math.round((1 - c.eOn) * 100)}%` : ""} ===\n| 구간 | CAGR % | MDD % | 최악 12개월 % | G1 | G2 | G3 | 지연 CAGR / MDD / 최악12 | G4 | ${nb.map((x) => `MA${x.N} CAGR / MDD / 최악12`).join(" | ")} | R1 |\n|---|---|---|---|---|---|---|---|---|${nb.map(() => "---").join("|")}|---|`);
    for (const [name, win] of ALLW) {
      const graded = win !== FULL;
      const a = g13(o, win), ad = g13(od, win), an = nb.map((x) => g13(x.o, win));
      const mk = (b: boolean): string => (graded ? ox(b) : "-");
      console.log(`| ${name} | ${f2(a.cagr)} | ${f2(a.mdd)} | ${f2(a.w12)} | ${mk(a.ok[0])} | ${mk(a.ok[1])} | ${mk(a.ok[2])} | ${f2(ad.cagr)} / ${f2(ad.mdd)} / ${f2(ad.w12)} | ${mk(ad.ok.every(Boolean))} | ${an.map((x) => `${f2(x.cagr)} / ${f2(x.mdd)} / ${f2(x.w12)}`).join(" | ")} | ${mk(an.every((x) => x.ok.every(Boolean)))} |`);
    }
    const gPass = passAll(o), g4 = passAll(od), r1c = nb.every((x) => passAll(x.o));
    const fails: string[] = [];
    for (const [name, win] of GW) { const a = g13(o, win); ["G1", "G2", "G3"].forEach((g, i) => { if (!a.ok[i]) fails.push(`${name} ${g}`); }); }
    if (!g4) fails.push("G4"); if (!r1c) fails.push("R1");
    console.log(`${c.id} 통과 여부: G1~G3 ${ox(gPass)} | G4 ${ox(g4)} | R1 ${ox(r1c)} → ${gPass && g4 && r1c ? "통과" : `탈락(${fails.join(", ")})`}`);
    summary.push(`| ${c.id} (${c.no}) | ${gPass && g4 && r1c ? "통과" : "탈락"} | ${fails.join(", ") || "-"} |`);
    // 참고
    console.log(`참고(판정 아님)\n| 구간 | B&H 가격 CAGR % | CAGR 차이 %p | 연변동성 % | 현금 100% 일수 비율 % | 평균 현금 비중 % | 필터 전환 횟수 |\n|---|---|---|---|---|---|---|`);
    for (const [name, win] of ALLW) {
      const idx = o.dates.map((d, i) => [d, i] as [string, number]).filter(([d]) => d >= win.from && d <= win.to && d > firstExec).map(([, i]) => i);
      const s = st(o, win), b = st(bhP, win);
      const ex = o.execE.filter((x) => x.d >= win.from && x.d <= win.to);
      let sw = 0;
      for (let i = 0; i < o.execE.length; i++) { const x = o.execE[i]; if (x.d < win.from || x.d > win.to || i === 0) continue; if ((x.e > 0) !== (o.execE[i - 1].e > 0)) sw++; }
      console.log(`| ${name} | ${f2(b.cagr)} | ${f2(s.cagr - b.cagr)} | ${f2(s.vol)} | ${f2((idx.filter((i) => o.expo[i] <= 1e-12).length / Math.max(idx.length, 1)) * 100)} | ${f2(avg(idx.map((i) => 1 - o.expo[i])) * 100)} | ${sw} (체결일 ${ex.length}개 중) |`);
    }
  }
  console.log(`\n=== 요약 ===\n| 시험 | 결과 | 탈락 사유 |\n|---|---|---|\n| B ${lab6} (146) | ${bGates && r1Ok && r2Ok && r3Ok ? "통과" : "탈락"} | ${[bGates ? "" : "G1~G4 일부 X", r1Ok ? "" : "R1", r2Ok ? "" : "R2", r3Ok ? "" : "R3"].filter(Boolean).join(", ") || "-"} |\n${summary.join("\n")}`);

  // ---------------- 최소 필요 금액 ----------------
  console.log(`\n=== 최소 필요 금액(1주씩, 정리 후 위성, 신호일 원 종가; ${KSS31_PRACTICAL_FROM} 이후 신호일 ${recentK.length}개) ===\n| 구성 | 069500 비중 | 위성 비중 | 중앙값(원) | 최대(원) | 최근 ${sigs[sigs.length - 1]}(원) | 최근 결정 종목 |\n|---|---|---|---|---|---|---|`);
  const minAcct = (k: number, satWt: number, etfWt: number): { v: number; who: string } => {
    const d = sigs[k];
    let best2 = { v: etfWt > 0 ? etfRawLe(d) / etfWt : 0, who: etfWt > 0 ? ETF_CODE : "-" };
    for (const [code, w] of tA[k].w) { const px = code === ETF_CODE ? etfRawLe(d) : rawLe(code, d).px; const v = px / (satWt * w); if (v > best2.v) best2 = { v, who: code }; }
    return best2;
  };
  for (const [lab, satWt, etfWt] of [[`B ${lab6}`, W6, 1 - W6], ["C1 (위 = 80:20)", KSS_DEFAULT_W, etfLeg], ["C2 (위 = 80:20 × 70%)", KSS_DEFAULT_W * BC_C2_EXPOSURE, etfLeg * BC_C2_EXPOSURE], ["C3 (위 = 위성 100%)", 1, 0]] as [string, number, number][]) {
    const v = recentK.map((k) => minAcct(k, satWt, etfWt).v), last = minAcct(sigs.length - 1, satWt, etfWt);
    console.log(`| ${lab} | ${f2(etfWt * 100)}% | ${f2(satWt * 100)}% | ${Math.round(median(v)).toLocaleString("ko-KR")} | ${Math.round(Math.max(...v)).toLocaleString("ko-KR")} | ${Math.round(last.v).toLocaleString("ko-KR")} | ${last.who} ${last.who === ETF_CODE ? "KODEX 200" : nameOf.get(last.who) ?? ""} |`);
  }
  finish();

  function finish(): void {
    console.log("\n=== 실행 지표 ===");
    console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
    console.log(`Supabase 쓴 행: 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

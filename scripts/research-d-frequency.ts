/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] D: 매매 주기 단축 D1~D4 (누적 시험 150~153).
 * 사전 등록: docs/research/d-frequency-prereg.md (5194e70). 입력·K200P·업종 모멘텀·정리·비용은
 * scripts/research-bc-weight-defense.ts(4ed6ebf, v3.2 0158359 복사본) 그대로.
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
import { KSS_TOP_K, KSS_MIX_WEIGHTS, KSS_DEFAULT_W, KSS_G1_MARGIN_PP, KSS_G2_MDD_MARGIN_PP, KSS_G4_MAX_DELAY_DROP_PP, KSS_R1_TOP_KS, KSS_R3_DRAWS, KSS_R3_SEED, KSS31_PER_SECTOR, KSS31_R1_LOOKBACKS, KSS31_PRACTICAL_FROM, KSS32_TRIM_MIN_WEIGHT, KSS32_R1_TRIMS, KSS32_SEEDS_WON, KSS32_ETF_SLIPPAGE, D_SMA_DAYS, D_R1_SMA_DAYS, D_STOP, D_R1_STOPS, D_R3_MIN_PCTILE, D_RECENT_FROM, D_RECENT_TO } from "@/lib/kodexSectorSatConfig";
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
  console.log(`KODEX 200 + 업종 모멘텀 위성 D(5194e70) 시작(읽기 전용): ${new Date().toISOString()} (사전등록 d70b1fd 이후)`);
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

  // ===================== D (5194e70) =====================
  const tA = trimmedTargets(C31, KSS32_TRIM_MIN_WEIGHT);
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
  const wOf = (t: Target & { etf: boolean }): Map<string, number> => (t.etf ? new Map() : t.w);
  const monthlyOf = (ts: (Target & { etf: boolean })[]): Map<string, Map<string, number>> => new Map(sigs.map((d, k) => [d, wOf(ts[k])]));
  const monthlyAt = monthlyOf(tA);

  // ---- D1 주간 신호: 주(월~일) 마지막 CAL 거래일, 롤링 6-1개월 모멘텀, 최근 월말 시장 목록 ----
  const weekKey = (d: string): string => { const t = Date.parse(`${d}T00:00:00Z`); const dow = (new Date(t).getUTCDay() + 6) % 7; return new Date(t - dow * MS_DAY).toISOString().slice(0, 10); };
  const weekly: string[] = [];
  for (let c = c0 + 1; c + 1 < nCal; c++) if (weekKey(CAL[c]) !== weekKey(CAL[c + 1])) weekly.push(CAL[c]);
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
  const satWW = (d: string, top: Set<string> | null, N: number): Target => {
    const U = kAtW(d);
    let mem: S[] = U;
    if (top) { const cnt = new Map<string, number>(); mem = []; for (const s of U) { const g = sectorOf(s.code); if (!top.has(g)) continue; const c = cnt.get(g) ?? 0; if (c < N) { mem.push(s); cnt.set(g, c + 1); } } }
    const w = new Map<string, number>();
    let tot = 0;
    for (const s of mem) { const x = mcapAt(s, d); if (x > 0) { w.set(s.code, x); tot += x; } }
    for (const [k, x] of w) w.set(k, x / tot);
    return { w, n: w.size };
  };
  const d1Dates = [firstSignal, ...weekly];
  const d1TargetsOf = (pick: (d: string, k: number) => string[] | null): Map<string, Map<string, number>> =>
    new Map(d1Dates.map((d, k) => {
      if (k === 0) return [d, wOf(tA[0])];
      const order = pick(d, k) ?? rankedW(d, C31.L);
      return [d, wOf(trim(satWW(d, order.length ? new Set(order.slice(0, Math.min(C31.K, order.length))) : null, C31.N), KSS32_TRIM_MIN_WEIGHT))];
    }));
  const d1At = d1TargetsOf(() => null);
  const d1TwoWeek = new Map([...d1At].filter((_, k) => k === 0 || k % 2 === 0));
  console.log(`D1 신호일 ${d1Dates.length}개(${d1Dates[0]}~${d1Dates[d1Dates.length - 1]}), 2주 주기 ${d1TwoWeek.size}개, 월간 ${sigs.length}개 | 주간 현금(정리 후 종목 없음) ${[...d1At.values()].filter((m) => m.size === 0).length}회`);

  // ---- 연속 비중 엔진(run()과 같은 비용·청산, 체결 시점은 decide가 정함) ----
  type Decide = (d: string, c: number, V: number, invested: boolean, entered: boolean) => Map<string, number> | undefined;
  interface EOut extends Ser { costFrac: number[]; nPos: number[]; tradeDays: string[] }
  function engine(decide: Decide, lag: number): EOut {
    const pending = new Map<number, Map<string, number>>();
    let cash = 1, prevV = 1, invested = false;
    const pos = new Map<string, { val: number; last: number }>();
    const out: EOut = { dates: [], ret: [], costFrac: [], nPos: [], tradeDays: [] };
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
        if (buyN + sellN > 1e-12) out.tradeDays.push(d);
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
  // ---- 판단 규칙 ----
  const mkTargets = (m: Map<string, Map<string, number>>): Decide => (d) => m.get(d);
  const mkD2 = (monthly: Map<string, Map<string, number>>, N: number): Decide => {
    let intended = false, latest = new Map<string, number>();
    return (d, c) => {
      const m = monthly.get(d);
      if (m) latest = m;
      const up = smaAbove(c, N);
      if (c === c0) { intended = up; return up ? latest : new Map(); }
      if (intended) { if (!up) { intended = false; return new Map(); } return m ? latest : undefined; }
      if (up) { intended = true; return latest; }
      return undefined;
    };
  };
  const mkD3 = (monthly: Map<string, Map<string, number>>, stop: number): Decide => {
    let intended = true, latest = new Map<string, number>(), peak = 0;
    return (d, c, V, invested, entered) => {
      const m = monthly.get(d);
      if (m) latest = m;
      if (c === c0) { intended = true; return latest; }
      if (entered) peak = V;
      if (intended) {
        if (invested) { peak = Math.max(peak, V); if (V <= (1 - stop) * peak) { intended = false; return new Map(); } }
        return m ? latest : undefined;
      }
      if (!invested && smaAbove(c, D_SMA_DAYS) && !smaAbove(c - 1, D_SMA_DAYS)) { intended = true; return latest; }
      return undefined;
    };
  };

  // ---- D4: 069500 상태 수열(수정주가 수익률, 원 종가 신호) ----
  const adjRet = new Map(bhT.dates.map((d, i) => [d, bhT.ret[i] / 100]));
  /** flags[c] = 그날(c) 보유 여부(직전 종가 체결 상태). c0+1(첫 체결일) 종가에 첫 상태를 비용 없이 잡는다. */
  const d4Flags = (N: number, lag: number): boolean[] => {
    const ex: boolean[] = new Array(nCal).fill(false), fl: boolean[] = new Array(nCal).fill(false);
    for (let c = c0 + 1; c < nCal; c++) ex[c] = c - lag >= c0 ? smaAbove(c - lag, N) : smaAbove(c0, N);
    for (let c = c0 + 2; c < nCal; c++) fl[c] = ex[c - 1];
    return fl;
  };
  const fromFlags = (fl: boolean[]): EOut => {
    const out: EOut = { dates: [], ret: [], costFrac: [], nPos: [], tradeDays: [] };
    for (let c = c0 + 1; c < nCal; c++) {
      const d = CAL[c];
      let r = fl[c] ? adjRet.get(d) ?? 0 : 0, cost = 0;
      const nextIn = c + 1 < nCal ? fl[c + 1] : fl[c];
      if (c > c0 + 1 && nextIn !== fl[c]) { cost = SAT_ETF_COST_PER_SIDE; out.tradeDays.push(d); }
      if (c === c0 + 1 && nextIn) out.tradeDays.push(d);
      r = (1 + r) * (1 - cost) - 1;
      out.dates.push(d); out.ret.push(r * 100); out.costFrac.push(cost); out.nPos.push(nextIn ? 1 : 0);
    }
    return out;
  };

  // ---- 공통 보고 ----
  const gates = (o: Ser, od: Ser, bench: Ser): { rows: string[]; pass: boolean } => {
    let pass = true;
    const rows: string[] = [];
    for (const [name, win] of ALLW) {
      const graded = win !== FULL;
      const m = st(o, win), md = st(od, win), b = st(bench, win);
      const drop = m.cagr - md.cagr;
      const g = [m.cagr >= b.cagr + KSS_G1_MARGIN_PP, m.mdd <= b.mdd + KSS_G2_MDD_MARGIN_PP + SAT_MDD_EPS, m.sharpe >= b.sharpe, drop <= KSS_G4_MAX_DELAY_DROP_PP];
      if (graded && !g.every(Boolean)) pass = false;
      rows.push(`| ${name} | ${f2(m.cagr)} | ${f2(m.mdd)} | ${f2(worst12(o, win))} | ${f2(m.sharpe)} | ${f2(b.cagr)} / ${f2(b.mdd)} / ${f2(b.sharpe)} | ${f2(md.cagr)} (${f2(drop)}) | ${graded ? g.map(ox).join(" / ") : "-"} |`);
    }
    return { rows, pass };
  };
  const extras = (o: EOut, label: string): void => {
    console.log(`${label} 추가 보고\n| 구간 | 연간 매매일 수 | 연간 비용 합계 % | 현금 보유 기간 % |\n|---|---|---|---|`);
    for (const [name, win] of ALLW) {
      const idx = o.dates.map((d, i) => [d, i] as [string, number]).filter(([d]) => d >= win.from && d <= win.to && d > firstExec).map(([, i]) => i);
      const yrs = Math.max(dayDiff(win.from, winTo(win)) / 365.25, 1e-9);
      const td = o.tradeDays.filter((d) => d >= win.from && d <= win.to).length;
      console.log(`| ${name} | ${f2(td / yrs)} | ${f2((idx.reduce((a, i) => a + o.costFrac[i], 0) / yrs) * 100)} | ${f2((idx.filter((i) => o.nPos[i] === 0).length / Math.max(idx.length, 1)) * 100)} |`);
    }
    console.log(`2026-10-01~10-15 수익률(${D_RECENT_FROM} 종가 → ${D_RECENT_TO} 종가): ${f2(recentRet(o))}%`);
  };
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
  const summary: string[] = [];

  // ---- 무작위 업종 목표(R3) ----
  const randMonthly = (rng: () => number): Map<string, Map<string, number>> => monthlyOf(sigs.map((d) => {
    const a = [...rankedSectors(d, C31.L)];
    const take = Math.min(C31.K, a.length);
    for (let i = 0; i < take; i++) { const j = i + Math.floor(rng() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; }
    return trim(satW(d, a.length ? new Set(a.slice(0, take)) : null, false, C31.N), KSS32_TRIM_MIN_WEIGHT);
  }));
  const randWeekly = (rng: () => number): Map<string, Map<string, number>> => d1TargetsOf((d) => {
    const a = [...rankedW(d, C31.L)];
    const take = Math.min(C31.K, a.length);
    for (let i = 0; i < take; i++) { const j = i + Math.floor(rng() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; }
    return a.slice(0, take);
  });

  // ---- 기준선(월간 위성 100%, 계수 안 함) ----
  const BASE = engine(mkTargets(monthlyAt), 1);
  console.log(`\n=== 기준선: 위성 100% 월간(v3.2 0:100, 계수 안 함) — 이번 실행 재계산 (v3.2 로그: 학습 5.89/32.05, 확인 12.37/59.07, 2022~ 21.78/49.01, 전 기간 12.36/60.27) ===\n| 구간 | CAGR % | MDD % | 최악 12개월 % | 샤프 |\n|---|---|---|---|---|`);
  for (const [name, win] of ALLW) { const s = st(BASE, win); console.log(`| ${name} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(worst12(BASE, win))} | ${f2(s.sharpe)} |`); }
  extras(BASE, "기준선");

  // ---- D1~D3 ----
  interface DSpec { id: string; no: number; title: string; make: (lag: number) => Decide; r1: { label: string; make: () => Decide }[]; randMake: (rng: () => number) => Decide; targetsForPair: Map<string, number>[]; minAcctList: { d: string; m: Map<string, number> }[] }
  const specs: DSpec[] = [
    {
      id: "D1", no: 150, title: "주간 리밸런싱",
      make: () => mkTargets(d1At),
      r1: [{ label: "2주 주기", make: () => mkTargets(d1TwoWeek) }, { label: "월 주기(= 기준선)", make: () => mkTargets(monthlyAt) }],
      randMake: (rng) => mkTargets(randWeekly(rng)),
      targetsForPair: [...d1At.values()], minAcctList: [...d1At].map(([d, m]) => ({ d, m })),
    },
    {
      id: "D2", no: 151, title: `월간 + 069500 ${D_SMA_DAYS}일 이동평균 아래면 현금`,
      make: () => mkD2(monthlyAt, D_SMA_DAYS),
      r1: D_R1_SMA_DAYS.map((N) => ({ label: `이동평균 ${N}일`, make: () => mkD2(monthlyAt, N) })),
      randMake: (rng) => mkD2(randMonthly(rng), D_SMA_DAYS),
      targetsForPair: [...monthlyAt.values()], minAcctList: [...monthlyAt].map(([d, m]) => ({ d, m })),
    },
    {
      id: "D3", no: 152, title: `월간 + 계좌 고점 대비 -${D_STOP * 100}% 손절, 069500 ${D_SMA_DAYS}일선 상향 돌파 시 재진입`,
      make: () => mkD3(monthlyAt, D_STOP),
      r1: D_R1_STOPS.map((s) => ({ label: `손절 -${s * 100}%`, make: () => mkD3(monthlyAt, s) })),
      randMake: (rng) => mkD3(randMonthly(rng), D_STOP),
      targetsForPair: [...monthlyAt.values()], minAcctList: [...monthlyAt].map(([d, m]) => ({ d, m })),
    },
  ];
  const fullBP = st(bhP, FULL), fullBT = st(bhT, FULL);
  const resultsD: { id: string; o: EOut }[] = [];
  for (const sp of specs) {
    const o = engine(sp.make(1), 1), od = engine(sp.make(2), 2);
    resultsD.push({ id: sp.id, o });
    console.log(`\n##### ${sp.id} (시험 ${sp.no}) — ${sp.title}, 개별 주식 + 현금 #####\n| 구간 | CAGR % | MDD % | 최악 12개월 % | 샤프 | B&H 가격 CAGR / MDD / 샤프 | 지연 CAGR (하락 %p) | G1 / G2 / G3 / G4 |\n|---|---|---|---|---|---|---|---|`);
    const g = gates(o, od, bhP);
    g.rows.forEach((r) => console.log(r));
    extras(o, sp.id);
    let r1Ok = true;
    console.log(`R1 이웃값(전 기간 CAGR > B&H 가격 ${f2(fullBP.cagr)})\n| 변형 | CAGR % | MDD % | 샤프 | 판정 |\n|---|---|---|---|---|`);
    for (const nb of sp.r1) { const s = st(engine(nb.make(), 1), FULL); const ok = s.cagr > fullBP.cagr; if (!ok) r1Ok = false; console.log(`| ${nb.label} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${ox(ok)} |`); }
    const r2 = r2Of(o, bhP), r2Ok = r2.cagr > fullBP.cagr;
    console.log(`R2: 바꾼 달 ${r2.m}(그 달 차이 ${f2(r2.ex)}%p) → 전 기간 CAGR ${f2(r2.cagr)} (기준 ${f2(fullBP.cagr)}) ${ox(r2Ok)}`);
    const rng = mulberry32(KSS_R3_SEED), draws: number[] = [];
    for (let n = 0; n < KSS_R3_DRAWS; n++) draws.push(st(engine(sp.randMake(rng), 1), FULL).cagr);
    const fullO = st(o, FULL).cagr, pct = pctOf(draws, fullO), r3Ok = pct >= D_R3_MIN_PCTILE;
    const sd = [...draws].sort((a, b) => a - b);
    console.log(`R3 무작위 업종 ${KSS_R3_DRAWS}회(시드 ${KSS_R3_SEED}): 중앙값 ${f2(sd[Math.floor(sd.length / 2)])}, 95분위 ${f2(sd[Math.floor(sd.length * 0.95)])}, 최대 ${f2(sd[sd.length - 1])}, ${sp.id} ${f2(fullO)} → 백분위 ${f2(pct)} ${ox(r3Ok)}`);
    const pass = g.pass && r1Ok && r2Ok && r3Ok;
    const why = [g.pass ? "" : "G1~G4 일부 X", r1Ok ? "" : "R1", r2Ok ? "" : "R2", r3Ok ? "" : "R3"].filter(Boolean).join(", ");
    console.log(`${sp.id} 통과 여부: G1~G4 ${ox(g.pass)} | R1 ${ox(r1Ok)} | R2 ${ox(r2Ok)} | R3 ${ox(r3Ok)} → ${pass ? "통과" : `탈락(${why})`}`);
    summary.push(`| ${sp.id} (${sp.no}) | ${pass ? "통과" : "탈락"} | ${why || "-"} |`);
    const pairAll = sp.targetsForPair.map(pairOf), pairRec = sp.minAcctList.filter((x) => x.d.slice(0, 7) >= KSS31_PRACTICAL_FROM).map((x) => pairOf(x.m));
    console.log(`삼성전자+SK하이닉스 목표 비중 합: 전 기간 평균 ${f2(avg(pairAll) * 100)}% / 최대 ${f2(Math.max(...pairAll) * 100)}% | ${KSS31_PRACTICAL_FROM} 이후 평균 ${f2(avg(pairRec) * 100)}% / 최대 ${f2(Math.max(...pairRec) * 100)}%`);
  }

  // ---- D4 ----
  {
    const o = fromFlags(d4Flags(D_SMA_DAYS, 1)), od = fromFlags(d4Flags(D_SMA_DAYS, 2));
    resultsD.push({ id: "D4", o });
    console.log(`\n##### D4 (시험 153) — 069500 원 종가 > ${D_SMA_DAYS}일 이동평균이면 069500 100%, 아니면 현금(수정주가 수익률) #####\n| 구간 | CAGR % | MDD % | 최악 12개월 % | 샤프 | B&H 총수익 CAGR / MDD / 샤프 | 지연 CAGR (하락 %p) | G1 / G2 / G3 / G4 |\n|---|---|---|---|---|---|---|---|`);
    const g = gates(o, od, bhT);
    g.rows.forEach((r) => console.log(r));
    extras(o, "D4");
    console.log(`B&H 총수익 2026-10-01~10-15: ${f2(recentRet(bhT))}% | B&H 가격: ${f2(recentRet(bhP))}%`);
    let r1Ok = true;
    console.log(`R1 이웃값(전 기간 CAGR > B&H 총수익 ${f2(fullBT.cagr)})\n| 변형 | CAGR % | MDD % | 샤프 | 판정 |\n|---|---|---|---|---|`);
    for (const N of D_R1_SMA_DAYS) { const s = st(fromFlags(d4Flags(N, 1)), FULL); const ok = s.cagr > fullBT.cagr; if (!ok) r1Ok = false; console.log(`| 이동평균 ${N}일 | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)} | ${ox(ok)} |`); }
    const r2 = r2Of(o, bhT), r2Ok = r2.cagr > fullBT.cagr;
    console.log(`R2: 바꾼 달 ${r2.m}(그 달 차이 ${f2(r2.ex)}%p) → 전 기간 CAGR ${f2(r2.cagr)} (기준 ${f2(fullBT.cagr)}) ${ox(r2Ok)}`);
    const base = d4Flags(D_SMA_DAYS, 1), seg = base.slice(c0 + 2), n = seg.length;
    const rng = mulberry32(KSS_R3_SEED), draws: number[] = [];
    for (let k = 0; k < KSS_R3_DRAWS; k++) { const sh = 1 + Math.floor(rng() * (n - 1)); const fl = [...base]; for (let i = 0; i < n; i++) fl[c0 + 2 + i] = seg[(i + sh) % n]; draws.push(st(fromFlags(fl), FULL).cagr); }
    const fullO = st(o, FULL).cagr, pct = pctOf(draws, fullO), r3Ok = pct >= D_R3_MIN_PCTILE;
    const sd = [...draws].sort((a, b) => a - b);
    console.log(`R3 상태 수열 원형 이동 ${KSS_R3_DRAWS}회(시드 ${KSS_R3_SEED}, 현금 비중 ${f2((seg.filter((x) => !x).length / n) * 100)}% 유지): 중앙값 ${f2(sd[Math.floor(sd.length / 2)])}, 95분위 ${f2(sd[Math.floor(sd.length * 0.95)])}, 최대 ${f2(sd[sd.length - 1])}, D4 ${f2(fullO)} → 백분위 ${f2(pct)} ${ox(r3Ok)}`);
    const pass = g.pass && r1Ok && r2Ok && r3Ok;
    const why = [g.pass ? "" : "G1~G4 일부 X", r1Ok ? "" : "R1", r2Ok ? "" : "R2", r3Ok ? "" : "R3"].filter(Boolean).join(", ");
    console.log(`D4 통과 여부: G1~G4 ${ox(g.pass)} | R1 ${ox(r1Ok)} | R2 ${ox(r2Ok)} | R3 ${ox(r3Ok)} → ${pass ? "통과" : `탈락(${why})`}`);
    summary.push(`| D4 (153) | ${pass ? "통과" : "탈락"} | ${why || "-"} |`);
  }
  console.log(`\n=== 요약 ===\n| 시험 | 결과 | 탈락 사유 |\n|---|---|---|\n${summary.join("\n")}`);

  // ---- 시드 정수 주 모의 ----
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
  const d4Int = (seed: number): IOut => {
    const fl = d4Flags(D_SMA_DAYS, 1);
    // 수정주가 누적 수준(분배금 재투자 근사)을 데이터 끝 원 종가에 맞춰 축척하고, CAL 날짜마다 직전 값을 쓴다.
    const lvl: number[] = new Array(nCal).fill(NaN);
    { let P = 1, j = 0; const lvBy = new Map<string, number>(); for (let i = 0; i < bhT.dates.length; i++) { P *= 1 + bhT.ret[i] / 100; lvBy.set(bhT.dates[i], P); } let lastV = NaN; for (let c = 0; c < nCal; c++) { const v = lvBy.get(CAL[c]); if (v !== undefined) lastV = v; lvl[c] = lastV; j++; } }
    const scale = etfRawLe(dataEnd) / lvl[nCal - 1];
    let cash = seed, E = 0, prevV = seed;
    const out: IOut = { dates: [], ret: [], held: [] };
    const buyM = (1 + KSS32_ETF_SLIPPAGE) * (1 + FEE_PCT_PER_SIDE), sellM = (1 - KSS32_ETF_SLIPPAGE) * (1 - FEE_PCT_PER_SIDE);
    for (let c = c0 + 1; c < nCal; c++) {
      const d = CAL[c], p = lvl[c] * scale, want = c + 1 < nCal ? fl[c + 1] : fl[c];
      const holdNow = E > 0;
      if (want && !holdNow) { const m = Math.floor(cash / (p * buyM)); E += m; cash -= m * p * buyM; out.held.push(E > 0 ? 1 : 0); }
      else if (!want && holdNow) { cash += E * p * sellM; E = 0; }
      const V = cash + E * p;
      out.dates.push(d); out.ret.push((V / prevV - 1) * 100);
      prevV = V;
    }
    return out;
  };
  console.log(`\n=== 시드 정수 주 모의 (남는 돈은 현금, ETF로 채우지 않음; D4는 069500 정수 주 + 현금) ===\n| 변형 | 시드 | 학습 CAGR / MDD | 확인 CAGR / MDD | 보류 CAGR / MDD | 전 기간 CAGR / MDD | 최종 평가액(원) | 보유 종목 수 평균 / 최소 |\n|---|---|---|---|---|---|---|---|`);
  for (const sp of [...specs.map((s) => ({ id: s.id, make: () => s.make(1) })), { id: "D4", make: null as null | (() => Decide) }]) {
    for (const seed of KSS32_SEEDS_WON) {
      const o = sp.make ? engineInt(sp.make(), seed) : d4Int(seed);
      const cells = ALLW.map(([, win]) => { const s = st(o, win); return `${f2(s.cagr)} / ${f2(s.mdd)}`; });
      let V = seed;
      for (const r of o.ret) V *= 1 + r / 100;
      console.log(`| ${sp.id} | ${seedLab(seed)} | ${cells.join(" | ")} | ${Math.round(V).toLocaleString("ko-KR")} | ${f2(avg(o.held))} / ${o.held.length ? Math.min(...o.held) : "-"} |`);
    }
  }
  console.log(`\n=== 최소 필요 금액(1주씩, max 원 종가 ÷ 목표 비중; ${KSS31_PRACTICAL_FROM} 이후 신호일) ===\n| 변형 | 신호일 수 | 중앙값(원) | 최대(원) | 최근 신호일 | 최근 값(원) | 결정 종목 |\n|---|---|---|---|---|---|---|`);
  for (const sp of specs) {
    const rec = sp.minAcctList.filter((x) => x.d.slice(0, 7) >= KSS31_PRACTICAL_FROM && x.m.size > 0);
    const vals = rec.map((x) => minAcctOf(x.m, x.d).v), last = rec[rec.length - 1], lm = minAcctOf(last.m, last.d);
    console.log(`| ${sp.id} | ${rec.length} | ${Math.round(median(vals)).toLocaleString("ko-KR")} | ${Math.round(Math.max(...vals)).toLocaleString("ko-KR")} | ${last.d} | ${Math.round(lm.v).toLocaleString("ko-KR")} | ${lm.who} ${nameOf.get(lm.who) ?? ""} |`);
  }
  {
    const rec = sigs.filter((d) => d.slice(0, 7) >= KSS31_PRACTICAL_FROM).map((d) => etfRawLe(d));
    console.log(`| D4 | ${rec.length} | ${Math.round(median(rec)).toLocaleString("ko-KR")} | ${Math.round(Math.max(...rec)).toLocaleString("ko-KR")} | ${dataEnd} | ${Math.round(etfRawLe(dataEnd)).toLocaleString("ko-KR")} | 069500 1주 |`);
  }
  finish();

  function finish(): void {
    console.log("\n=== 실행 지표 ===");
    console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
    console.log(`Supabase 쓴 행: 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

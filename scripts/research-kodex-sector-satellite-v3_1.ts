/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] KODEX 200 + 업종 모멘텀 위성 v3.1(업종별 시총 상위 3종목) 백테스트(누적 시도 144).
 * 사전 등록: research/kodex-sector-satellite-v3-prereg.md (a55a878) + research/kodex-sector-satellite-v3_1-prereg.md (b01d69f). K200P·업종 모멘텀·엔진은 scripts/research-sector-mom-tilt-v2_1-mm.ts(4c845e4) 그대로.
 * 숫자와 표, O/X만 출력한다.
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
import { KSS_TOP_K, KSS_MIX_WEIGHTS, KSS_DEFAULT_W, KSS_G1_MARGIN_PP, KSS_G2_MDD_MARGIN_PP, KSS_G4_MAX_DELAY_DROP_PP, KSS_R1_TOP_KS, KSS_R3_DRAWS, KSS_R3_SEED, KSS31_PER_SECTOR, KSS31_R1_LOOKBACKS, KSS31_R1_PER_SECTOR, KSS31_PRACTICAL_FROM, KSS31_ACCOUNTS_WON, KSS31_RECENT_SIGNALS } from "@/lib/kodexSectorSatConfig";

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
  console.log(`KODEX 200 + 업종 모멘텀 위성 v3.1 시작(읽기 전용): ${new Date().toISOString()} (사전등록 b01d69f 이후)`);
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

  // ---- 실행 ----
  const C31: SCfg = { ...S_BASE, N: KSS31_PER_SECTOR };
  const tS = satTargets(C31), tS3 = satTargets(S_BASE);
  const S3 = run(tS, false), S3D = run(tS, true), V3 = run(tS3, false);
  const MIXES = KSS_MIX_WEIGHTS.map((w) => ({ w, label: `${Math.round((1 - w) * 100)}:${Math.round(w * 100)}`, o: mix(S3, w, bhP) }));
  const M80 = mix(S3, KSS_DEFAULT_W, bhP), M80D = mix(S3D, KSS_DEFAULT_W, bhP), M80T = mix(S3, KSS_DEFAULT_W, bhT), V3M80 = mix(V3, KSS_DEFAULT_W, bhP);
  const LEARN: Win = { ...SMT_LEARN }, CONFIRM: Win = { ...LV_CONFIRM }, HOLD: Win = { from: LV_HOLDOUT_FROM, to: "9999-12-31" }, FULL: Win = { from: SMT_LEARN.from, to: "9999-12-31" };
  const WINS: [string, Win, boolean][] = [["학습", LEARN, true], ["확인", CONFIRM, true], ["2022~", HOLD, true], ["전 기간", FULL, false]];
  for (const [name, win, graded] of WINS) {
    const m = st(M80, win), md = st(M80D, win), b = st(bhP, win);
    const drop = m.cagr - md.cagr;
    const g = [m.cagr >= b.cagr + KSS_G1_MARGIN_PP, m.mdd <= b.mdd + KSS_G2_MDD_MARGIN_PP + SAT_MDD_EPS, m.sharpe >= b.sharpe, drop <= KSS_G4_MAX_DELAY_DROP_PP];
    console.log(`\n=== ${name} ${win.from}~${win.to > dataEnd ? dataEnd : win.to} ===\n| 구성 | CAGR % | MDD % | 샤프 | 연변동성 % | 월 평균 회전율 %(위성) | 누적 비용 % | 지연 CAGR % | 지연 하락 %p |\n|---|---|---|---|---|---|---|---|---|`);
    const row = (lab: string, o: Ser & { turn?: { d: string; v: number }[]; costFrac?: number[] }, od: Ser | null): void => {
      const x = st(o, win), xd = od ? st(od, win) : null;
      console.log(`| ${lab} | ${f2(x.cagr)} | ${f2(x.mdd)} | ${f2(x.sharpe)} | ${f2(x.vol)} | ${o.turn ? f2(x.turnover) : "-"} | ${o.costFrac ? f2(x.cost) : "-"} | ${xd ? f2(xd.cagr) : "-"} | ${xd ? f2(x.cagr - xd.cagr) : "-"} |`);
    };
    row("v3.1 S3 단독", S3, S3D);
    for (const mx of MIXES) row(`v3.1 069500:S3 = ${mx.label}${mx.w === KSS_DEFAULT_W ? " (기본)" : ""}`, mx.o, mx.w === KSS_DEFAULT_W ? M80D : null);
    row("참고: v3.1 80:20 (069500 다리 = 수정주가 총수익)", M80T, null);
    row("v3 80:20 (a55a878)", V3M80, null);
    row("v3 S3 단독 (참고)", V3, null);
    row("B&H 가격(069500 원주가)", bhP, null);
    row("B&H 총수익(069500 수정, 참고)", bhT, null);
    row("KOSPI", kos, null);
    console.log(`v3.1 80:20 참고 기준: G1 CAGR ≥ ${f2(b.cagr + KSS_G1_MARGIN_PP)} → ${graded ? ox(g[0]) : "-"} | G2 MDD ≤ ${f2(b.mdd + KSS_G2_MDD_MARGIN_PP)} → ${graded ? ox(g[1]) : "-"} | G3 샤프 ≥ ${f2(b.sharpe)} → ${graded ? ox(g[2]) : "-"} | G4 지연 하락 ${f2(drop)} ≤ ${KSS_G4_MAX_DELAY_DROP_PP} → ${graded ? ox(g[3]) : "-"}`);
  }

  console.log("\n=== 연도별 수익률 % ===\n| 연도 | v3.1 80:20 | v3 80:20 | B&H 가격 | v3.1 80:20 − B&H 가격 %p |\n|---|---|---|---|---|");
  for (let y = Number(firstExec.slice(0, 4)); y <= Number(dataEnd.slice(0, 4)); y++) { const a = yearRet(M80, y), b = yearRet(bhP, y); console.log(`| ${y} | ${f2(a)} | ${f2(yearRet(V3M80, y))} | ${f2(b)} | ${f2(a - b)} |`); }

  // ---- 실투자 점검 ----
  const etfRaw = etfRows.filter((r) => r.raw_close !== null).map((r) => ({ d: r.trade_date, px: Number(r.raw_close) }));
  const etfRawAt = (d: string): number => { let v = NaN; for (const x of etfRaw) { if (x.d <= d) v = x.px; else break; } return v; };
  const rawAt = (c: string, d: string): number => { const s = byCode.get(c)!; const i = s.idx.get(d); return i === undefined ? NaN : s.raw[i]; };
  const avg = (a: number[]): number => a.reduce((x, z) => x + z, 0) / Math.max(a.length, 1);
  const med = (a: number[]): number => { const b = [...a].sort((x, y) => x - y); return b.length ? (b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2) : NaN; };
  const nAll = tS.map((t) => t.n), recentIdx = sigs.map((d, k) => [d, k] as const).filter(([d]) => d.slice(0, 7) >= KSS31_PRACTICAL_FROM);
  console.log(`\n=== 실투자 점검 (80:20 기준, 가격 = 신호일 원 종가) ===\n(1) 위성 보유 종목 수: 전 기간 평균 ${f2(avg(nAll))}, 최대 ${Math.max(...nAll)}, 최소 ${Math.min(...nAll)} | ${KSS31_PRACTICAL_FROM} 이후 평균 ${f2(avg(recentIdx.map(([, k]) => nAll[k])))}, 최대 ${Math.max(...recentIdx.map(([, k]) => nAll[k]))} (v3 참고: 전 기간 평균 ${f2(avg(tS3.map((t) => t.n)))}, 최대 ${Math.max(...tS3.map((t) => t.n))})`);
  const minAcct = (k: number): { v: number; who: string } => {
    const d = sigs[k];
    let best = { v: etfRawAt(d) / (1 - KSS_DEFAULT_W), who: "069500" };
    for (const [c, w] of tS[k].w) { const v = rawAt(c, d) / (w * KSS_DEFAULT_W); if (v > best.v) best = { v, who: c }; }
    return best;
  };
  const mins = recentIdx.map(([, k]) => minAcct(k));
  const lastK = sigs.length - 1, lastMin = minAcct(lastK);
  console.log(`(2) 최소 운용 금액(원): ${KSS31_PRACTICAL_FROM} 이후 신호일 ${mins.length}개 중앙값 ${Math.round(med(mins.map((x) => x.v))).toLocaleString("ko-KR")}, 최대 ${Math.round(Math.max(...mins.map((x) => x.v))).toLocaleString("ko-KR")}, 가장 최근(${sigs[lastK]}) ${Math.round(lastMin.v).toLocaleString("ko-KR")} (결정 종목 ${lastMin.who} ${nameOf.get(lastMin.who) ?? ""})`);
  console.log("| 신호일 | 최소 운용 금액(원) | 결정 종목 |\n|---|---|---|");
  recentIdx.forEach(([d], j) => console.log(`| ${d} | ${Math.round(mins[j].v).toLocaleString("ko-KR")} | ${mins[j].who} ${mins[j].who === "069500" ? "KODEX 200" : nameOf.get(mins[j].who) ?? ""} |`));
  console.log(`(3) 1주 단위 반올림 시 목표 비중과의 차이 합(최근 ${KSS31_RECENT_SIGNALS}개 신호일 평균, 069500 포함)\n| 계좌 | 차이 합 평균 %p | 주식 수 0인 종목 수 평균 | 가장 최근 신호일 차이 합 %p |\n|---|---|---|---|`);
  const lastSigs = sigs.map((_, k) => k).slice(-KSS31_RECENT_SIGNALS);
  for (const A of KSS31_ACCOUNTS_WON) {
    const res = lastSigs.map((k) => {
      const d = sigs[k];
      const pos: { w: number; px: number }[] = [{ w: 1 - KSS_DEFAULT_W, px: etfRawAt(d) }, ...[...tS[k].w].map(([c, w]) => ({ w: w * KSS_DEFAULT_W, px: rawAt(c, d) }))];
      let diff = 0, zero = 0;
      for (const p of pos) { const sh = Math.round((A * p.w) / p.px); if (sh === 0) zero++; diff += Math.abs((sh * p.px) / A - p.w); }
      return { diff: diff * 100, zero };
    });
    console.log(`| ${(A / 10_000).toLocaleString("ko-KR")}만 원 | ${f2(avg(res.map((r) => r.diff)))} | ${f2(avg(res.map((r) => r.zero)))} | ${f2(res[res.length - 1].diff)} |`);
  }

  // ---- R1~R3 (80:20, 전 기간) ----
  const fullM = st(M80, FULL), fullB = st(bhP, FULL);
  console.log(`\n=== R1 주변 값 (v3.1 80:20, 전 기간; 기본 CAGR ${f2(fullM.cagr)}, 샤프 ${f2(fullM.sharpe)}, MDD ${f2(fullM.mdd)}; B&H 가격 CAGR ${f2(fullB.cagr)}, 샤프 ${f2(fullB.sharpe)}) ===\n| 변형 | 80:20 CAGR % | 80:20 샤프 | 80:20 MDD % | S3 단독 CAGR % |\n|---|---|---|---|---|`);
  const r1 = (label: string, c: SCfg): void => { const s = run(satTargets(c), false), m = st(mix(s, KSS_DEFAULT_W, bhP), FULL); console.log(`| ${label} | ${f2(m.cagr)} | ${f2(m.sharpe)} | ${f2(m.mdd)} | ${f2(st(s, FULL).cagr)} |`); };
  for (const L of KSS31_R1_LOOKBACKS) r1(`모멘텀 기간 ${L}개월(최근 1개월 제외)`, { ...C31, L });
  for (const K of KSS_R1_TOP_KS) r1(`상위 ${K}개 업종`, { ...C31, K });
  for (const N of KSS31_R1_PER_SECTOR) r1(`업종별 상위 ${N}종목`, { ...C31, N });

  const bhBy = new Map(bhP.dates.map((d, i) => [d, bhP.ret[i]]));
  const mm2 = new Map<string, { s: number[]; w: number[]; idx: number[] }>();
  M80.dates.forEach((d, i) => { if (d <= firstExec) return; const k = d.slice(0, 7); const e = mm2.get(k) ?? { s: [], w: [], idx: [] }; e.s.push(M80.ret[i]); e.w.push(bhBy.get(d) ?? 0); e.idx.push(i); mm2.set(k, e); });
  let best = { m: "", ex: -Infinity };
  for (const [k, e] of mm2) { const ex = computeCumulativeAndMdd(e.s).totalReturnPct - computeCumulativeAndMdd(e.w).totalReturnPct; if (ex > best.ex) best = { m: k, ex }; }
  const repl = [...M80.ret];
  for (const i of mm2.get(best.m)!.idx) repl[i] = bhBy.get(M80.dates[i]) ?? 0;
  console.log(`\n=== R2 상위 사건 제거 (v3.1 80:20 vs B&H 가격) ===\n| 바꾼 달 | 그 달 80:20 − B&H %p | 바꾼 뒤 전 기간 CAGR % | 바꾸기 전 CAGR % | B&H 가격 CAGR % |\n|---|---|---|---|---|\n| ${best.m} | ${f2(best.ex)} | ${f2(st({ dates: M80.dates, ret: repl }, FULL).cagr)} | ${f2(fullM.cagr)} | ${f2(fullB.cagr)} |`);

  const rng = mulberry32(KSS_R3_SEED);
  const orders = sigs.map((d) => rankedSectors(d, C31.L));
  const cg: number[] = [], sh: number[] = [];
  for (let n = 0; n < KSS_R3_DRAWS; n++) {
    const tg = sigs.map((d, k) => {
      const a = [...orders[k]];
      const take = Math.min(C31.K, a.length);
      for (let i = 0; i < take; i++) { const j = i + Math.floor(rng() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; }
      return satW(d, a.length ? new Set(a.slice(0, take)) : null, false, C31.N);
    });
    const m = st(mix(run(tg, false), KSS_DEFAULT_W, bhP), FULL);
    cg.push(m.cagr); sh.push(m.sharpe);
  }
  const summ = (arr: number[], v: number): string => { const b = [...arr].sort((x, y) => x - y); return `${f2(b[Math.floor(b.length / 2)])} | ${f2(b[Math.floor(b.length * 0.95)])} | ${f2(b[b.length - 1])} | ${f2(v)} | ${arr.filter((x) => x >= v).length} | ${f2((arr.filter((x) => x < v).length / arr.length) * 100)}`; };
  console.log(`\n=== R3 무작위 업종 3개·업종별 상위 3종목 (${KSS_R3_DRAWS}회, 시드 ${KSS_R3_SEED}, 80:20, 전 기간) ===\n| 지표 | 무작위 중앙값 | 95분위 | 최대 | v3.1 80:20 | 이상 회수 | 백분위 |\n|---|---|---|---|---|---|---|`);
  console.log(`| CAGR % | ${summ(cg, fullM.cagr)} |`);
  console.log(`| 샤프 | ${summ(sh, fullM.sharpe)} |`);

  // ---- 최근 신호일 ----
  const dl = sigs[lastK];
  const mom = sectorMom(dl, C31.L), order = rankedSectors(dl, C31.L);
  console.log(`\n=== 최근 신호일 ${dl} (체결 ${CAL[calIdx.get(dl)! + 1] ?? "-"}), 모멘텀 ${monthEnds[meIdx.get(dl)! - C31.L]}~${monthEnds[meIdx.get(dl)! - SMT_SKIP_MONTHS]} ===\n상위 3개 업종: ${order.slice(0, C31.K).map((g) => `${secLabel(g)}(유효 ${mom.get(g)!.n}종목, ${f2(mom.get(g)!.mom * 100)}%)`).join(", ")} | 069500 원 종가 ${etfRawAt(dl).toLocaleString("ko-KR")}원, 전체 비중 ${f2((1 - KSS_DEFAULT_W) * 100)}%`);
  console.log(`위성 보유 ${tS[lastK].n}종목\n| 순위 | 코드 | 이름 | 업종 | 위성 내 비중 % | 80:20 전체 비중 % | 신호일 원 종가(원) |\n|---|---|---|---|---|---|---|`);
  [...tS[lastK].w].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).forEach(([c, x], i) => console.log(`| ${i + 1} | ${c} | ${nameOf.get(c) ?? "-"} | ${secLabel(sectorOf(c))} | ${f2(x * 100)} | ${f2(x * KSS_DEFAULT_W * 100)} | ${rawAt(c, dl).toLocaleString("ko-KR")} |`));
  finish();

  function finish(): void {
    console.log("\n=== 실행 지표 ===");
    console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
    console.log(`Supabase 쓴 행: 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

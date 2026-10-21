/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건(Storage 다운로드 제외)] 위성 v1.2a(업종 상한, 시도 139)·v1.2b(대형주 + 업종 상한, 시도 140) 백테스트.
 * 사전 등록: research/satellite-v1-prereg.md (21ee3e0) + research/satellite-v1_1-prereg.md (472cc3d) + research/satellite-v1_2-prereg.md (4c1557a). 정의·참고 기준·비중 선택 규칙은 그 문서들이 고정한다. 숫자와 표, O/X만 출력한다.
 */
import { parquetReadObjects } from "hyparquet";
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
import { INVESTOR_FLOW_STOCK_STORE_BUCKET, INVESTOR_FLOW_STOCK_FIRST_YEAR } from "@/lib/investorFlowConfig";
import { SCAN_CAP_EOK, SCAN_POOL_SIZE } from "@/lib/signalScanConfig";
import { FLOW_TILT_ENDED_GRACE_DAYS, FLOW_TILT_CLEAN_PREFIX } from "@/lib/foreignFlowTiltConfig";
import { LV_QUARTER_MONTHS, LV_FIRST_SIGNAL_MONTH, LV_LEARN, LV_CONFIRM, LV_HOLDOUT_FROM, LV_QUARTERS_PER_YEAR, LV_VOL_DAYS, LV_MIN_PRICE_DAY_RATIO } from "@/lib/smallcapLowvolConfig";
import { SCS_CREDIT_LAG_DAYS, SCS_CREDIT_CARRY_MAX_DAYS, SCS_CREDIT_CLEAN_PREFIX } from "@/lib/shortCreditScanConfig";
import { CT_CREDIT_FIRST_YEAR, CT_CREDIT_LAST_YEAR } from "@/lib/creditTiltConfig";
import {
  SAT_HOLD_COUNT, SAT_KEEP_RANK, SAT_C1_EXCLUDE_PARTS, SAT_FLOW_DAYS, SAT_FLOW_TOP_PARTS, SAT_BUY_DELAY_DAYS, SAT_MIX_WEIGHTS, SAT_MIX_BAND, SAT_ETF_COST_PER_SIDE,
  SAT_MIX_CAGR_TOL_PP, SAT_MIX_DEFAULT_W, SAT_SPAC_NAME_KEYWORDS,
  SAT_MDD_EPS, SAT_REIT_NAME_SUFFIX, SAT_REIT_KSIC_PREFIXES, SAT_REIT_EXPLICIT_CODES, SAT_SECTOR_CAP, SAT_R1_SECTOR_CAPS, SAT_SECTOR_UNCLASSIFIED, SAT_KEEP_MULT, SAT_R1_HOLD_COUNTS, SAT_R1_VOL_DAYS, SAT_R3_DRAWS, SAT_R3_SEED, SAT_KSIC_DIVISION_NAMES,
} from "@/lib/satelliteV1Config";

const T0 = Date.now();
const MS_DAY = 86_400_000;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const ox = (b: boolean): string => (b ? "O" : "X");
const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;
const dbRead: Record<string, number> = {};
const dl = { creditBytes: 0, creditRows: 0, flowBytes: 0, flowRows: 0 };
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
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

interface S { code: string; idx: Map<string, number>; close: Float64Array; closeA: Float64Array; mcapRow: Float64Array; avgTvRow: Float64Array; last: string; CR: Float64Array; lastCr: Int32Array; flowCum: Float64Array | null }
interface Target { w: Map<string, number>; n: number; delayed: Set<string> }
interface Out { dates: string[]; ret: number[]; costFrac: number[]; turn: { d: string; v: number }[]; nPos: number[]; liq: string[]; delayedBought: number; delayedMissed: number }
interface Win { from: string; to: string }
interface Pick { code: string; c1: number; vol: number; score: number }

async function main(): Promise<void> {
  console.log(`위성 v1.2a·v1.2b 시작(읽기 전용): ${new Date().toISOString()} (사전등록 4c1557a 이후)`);
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear());
  const today = new Date().toISOString().slice(0, 10);
  const kospi = await getIndexPriceSeries("KOSPI", "2009-01-01", today);
  dbRead["beta_price_history(KOSPI)"] = kospi.length;

  // ---- 신용잔고 정리본 (2009~2026, 신용잔고율만) ----
  const creditBy = new Map<string, Map<string, number>>();
  for (let y = CT_CREDIT_FIRST_YEAR; y <= CT_CREDIT_LAST_YEAR; y++) {
    const { data, error } = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).download(`${SCS_CREDIT_CLEAN_PREFIX}/${y}.parquet`);
    if (error) { console.log(`${SCS_CREDIT_CLEAN_PREFIX}/${y}.parquet 없음`); continue; }
    const buf = await data.arrayBuffer();
    dl.creditBytes += buf.byteLength;
    for (const r of (await parquetReadObjects({ file: buf, columns: ["stock_code", "deal_date", "whol_loan_rmnd_rate"] })) as { stock_code: string; deal_date: string; whol_loan_rmnd_rate: number | null }[]) {
      dl.creditRows++;
      let m = creditBy.get(r.stock_code);
      if (!m) { m = new Map(); creditBy.set(r.stock_code, m); }
      m.set(r.deal_date, r.whol_loan_rmnd_rate === null ? NaN : Number(r.whol_loan_rmnd_rate));
    }
  }
  console.log(`신용잔고 정리본(2009~2026): 종목 ${creditBy.size}개, ${dl.creditRows}행, 다운로드 ${dl.creditBytes} B (${(dl.creditBytes / 1048576).toFixed(2)} MiB)`);

  // ---- 외국인 수급 정리본 ----
  const flowBy = new Map<string, Map<string, number>>();
  for (let y = INVESTOR_FLOW_STOCK_FIRST_YEAR; y <= new Date().getUTCFullYear(); y++) {
    const { data, error } = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).download(`${FLOW_TILT_CLEAN_PREFIX}/${y}.parquet`);
    if (error) { console.log(`${FLOW_TILT_CLEAN_PREFIX}/${y}.parquet 없음`); continue; }
    const buf = await data.arrayBuffer();
    dl.flowBytes += buf.byteLength;
    for (const r of (await parquetReadObjects({ file: buf, columns: ["stock_code", "trade_date", "frgn_ntby_amt"] })) as { stock_code: string; trade_date: string; frgn_ntby_amt: number | null }[]) {
      dl.flowRows++;
      let m = flowBy.get(r.stock_code);
      if (!m) { m = new Map(); flowBy.set(r.stock_code, m); }
      m.set(r.trade_date, r.frgn_ntby_amt === null ? 0 : Number(r.frgn_ntby_amt));
    }
  }
  console.log(`외국인 수급 정리본: 종목 ${flowBy.size}개, ${dl.flowRows}행, 다운로드 ${dl.flowBytes} B (${(dl.flowBytes / 1048576).toFixed(2)} MiB)`);

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
  const nCal = CAL.length, dataEnd = CAL[nCal - 1];
  const calIdx = new Map(CAL.map((d, i) => [d, i]));
  const monthEnds: string[] = [];
  for (let k = 0; k + 1 < nCal; k++) if (CAL[k].slice(0, 7) !== CAL[k + 1].slice(0, 7)) monthEnds.push(CAL[k]);
  const endedBefore = new Date(Date.parse(dataEnd) - FLOW_TILT_ENDED_GRACE_DAYS * MS_DAY).toISOString().slice(0, 10);
  const firstSignal = monthEnds.find((d) => d.slice(0, 7) === LV_FIRST_SIGNAL_MONTH)!;
  const quarterSignals = monthEnds.filter((d) => d >= firstSignal && (LV_QUARTER_MONTHS as readonly number[]).includes(Number(d.slice(5, 7))));
  const firstExec = CAL[calIdx.get(firstSignal)! + 1];
  console.log(`종목 ${rows0.length}개, 거래일(2010~) ${nCal}일 ${CAL[0]}~${dataEnd}, 분기 신호 ${quarterSignals.length}개(첫 신호 ${firstSignal}, 첫 체결 ${firstExec}, 마지막 신호 ${quarterSignals[quarterSignals.length - 1]})`);

  const isElig = (r: { mcap: Float64Array; avgTv: Float64Array }, i: number): boolean => i >= 1 && r.mcap[i - 1] >= SCAN_CAP_EOK && r.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON;
  const cand = rows0.filter((r) => { for (let i = 1; i < r.dates.length; i++) if (r.dates[i] >= "2010-01-01" && isElig(r, i)) return true; return false; });
  console.log(`PIT 적격이 된 적 있는 종목 ${cand.length}개`);
  const stocks: S[] = cand.map((r) => {
    const idx = new Map(r.dates.map((d, i) => [d, i]));
    const closeA = new Float64Array(nCal).fill(NaN), CR = new Float64Array(nCal).fill(NaN), lastCr = new Int32Array(nCal).fill(-1);
    const cm = creditBy.get(r.code), fm = flowBy.get(r.code);
    const flowCum = fm ? new Float64Array(nCal + 1) : null;
    let last = -1;
    for (let c = 0; c < nCal; c++) {
      const i = idx.get(CAL[c]);
      if (i !== undefined && r.close[i] > 0) closeA[c] = r.close[i];
      const v = cm?.get(CAL[c]);
      if (v !== undefined) { CR[c] = v; last = c; }
      lastCr[c] = last;
      if (flowCum) flowCum[c + 1] = flowCum[c] + (fm!.get(CAL[c]) ?? 0);
    }
    return { code: r.code, idx, close: r.close, closeA, mcapRow: r.mcap, avgTvRow: r.avgTv, last: r.dates[r.dates.length - 1], CR, lastCr, flowCum };
  });
  stocks.sort((a, b) => (a.code < b.code ? -1 : 1));
  const byCode = new Map(stocks.map((s) => [s.code, s]));
  rows0.length = 0; creditBy.clear(); flowBy.clear();

  // ---- 제외 규칙 식별 (우선주·ETF·스팩) ----
  const codes = stocks.map((s) => s.code);
  const prefSet = new Set(codes.filter((c) => c[c.length - 1] !== "0"));
  const etfSet = new Set<string>();
  const nameOf = new Map<string, string>(), indOf = new Map<string, string>();
  for (let i = 0; i < codes.length; i += 200) {
    const chunk = codes.slice(i, i + 200);
    const a = await selectAll<{ isu_cd: string }>("etf_krx_daily(유니버스 코드와 겹치는 행)", (f, t) => supabaseAdmin.from("etf_krx_daily").select("isu_cd").in("isu_cd", chunk).order("isu_cd").order("bas_dd").range(f, t));
    for (const r of a) etfSet.add(r.isu_cd);
    const b = await selectAll<{ code: string }>("etf_daily_prices(유니버스 코드와 겹치는 행)", (f, t) => supabaseAdmin.from("etf_daily_prices").select("code").in("code", chunk).order("code").order("trade_date").range(f, t));
    for (const r of b) etfSet.add(r.code);
    const c = await selectAll<{ corp_code: string; corp_name: string; stock_code: string }>("dart_corp_codes(유니버스 코드)", (f, t) => supabaseAdmin.from("dart_corp_codes").select("corp_code, corp_name, stock_code").in("stock_code", chunk).order("corp_code").range(f, t));
    for (const r of c) nameOf.set(r.stock_code, r.corp_name);
    const ind = await selectAll<{ stock_code: string; induty_code: string | null }>("stock_industry_classification(유니버스 코드)", (f, t) => supabaseAdmin.from("stock_industry_classification").select("stock_code, induty_code").in("stock_code", chunk).order("stock_code").range(f, t));
    for (const r of ind) if (r.induty_code) indOf.set(r.stock_code, r.induty_code);
  }
  const spacSet = new Set(codes.filter((c) => { const n = nameOf.get(c); return n !== undefined && SAT_SPAC_NAME_KEYWORDS.some((k) => n.includes(k)); }));
  const excludedV1 = new Set([...prefSet, ...etfSet, ...spacSet]);
  const reitWhy = new Map<string, string[]>();
  for (const c of codes) {
    const why: string[] = [];
    const n = nameOf.get(c);
    if (n !== undefined && n.trim().endsWith(SAT_REIT_NAME_SUFFIX)) why.push(`이름이 "${SAT_REIT_NAME_SUFFIX}"로 끝남`);
    const ic = indOf.get(c);
    if (ic && SAT_REIT_KSIC_PREFIXES.some((p) => ic.startsWith(p))) why.push(`업종 ${ic}`);
    if ((SAT_REIT_EXPLICIT_CODES as readonly string[]).includes(c)) why.push("명시 목록");
    if (why.length) reitWhy.set(c, why);
  }
  const excluded = new Set([...excludedV1, ...reitWhy.keys()]);
  const indLabel = (c: string): string => { const x = indOf.get(c); return x ? `${x} ${SAT_KSIC_DIVISION_NAMES[x.slice(0, 2)] ?? "?"}` : "-"; };
  console.log(`\n=== 제외 규칙 식별 (PIT 적격이 된 적 있는 ${codes.length}개 기준) ===`);
  console.log("| 규칙 | 식별 방법 | 해당 종목 수 |\n|---|---|---|");
  console.log(`| 우선주 | 종목코드 끝자리 ≠ '0' | ${prefSet.size} |`);
  console.log(`| ETF | 가격 Parquet 원천이 KRX 주식 일별매매정보(ETF 미포함) + etf_krx_daily·etf_daily_prices 코드와 겹침 | ${etfSet.size}${etfSet.size ? ` (${[...etfSet].join(", ")})` : ""} |`);
  console.log(`| 스팩 | dart_corp_codes.corp_name에 ${SAT_SPAC_NAME_KEYWORDS.map((k) => `"${k}"`).join("/")} 포함 | ${spacSet.size}${spacSet.size ? ` (${[...spacSet].join(", ")})` : ""} |`);
  console.log(`dart_corp_codes에 이름이 없는 코드(스팩 여부 확인 불가) ${codes.filter((c) => !nameOf.has(c)).length}개, 그중 우선주 아닌 코드 ${codes.filter((c) => !nameOf.has(c) && !prefSet.has(c)).length}개 | v1 제외 합계 ${excludedV1.size}개`);
  console.log(`업종 표(stock_industry_classification) 적용 범위: ${codes.length}개 중 ${codes.filter((c) => indOf.has(c)).length}개`);
  console.log(`\n부동산·인프라 투자회사 제외 ${reitWhy.size}개 (이름이 "${SAT_REIT_NAME_SUFFIX}"로 끝남, 업종 코드 ${SAT_REIT_KSIC_PREFIXES.join("·")}로 시작, 명시 ${SAT_REIT_EXPLICIT_CODES.join("·")})\n| 코드 | 이름 | 업종 | 걸린 규칙 | 우선주·ETF·스팩과 중복 |\n|---|---|---|---|---|`);
  for (const [c, why] of [...reitWhy].sort((a, b) => (a[0] < b[0] ? -1 : 1))) console.log(`| ${c} | ${nameOf.get(c) ?? "-"} | ${indLabel(c)} | ${why.join(", ")} | ${excludedV1.has(c) ? "O" : ""} |`);
  console.log(`최종 제외 합계 ${excluded.size}개`);
  const sectorOf = (c: string): string => indOf.get(c)?.slice(0, 2) ?? SAT_SECTOR_UNCLASSIFIED;
  const sectorLabel = (g: string): string => (g === SAT_SECTOR_UNCLASSIFIED ? g : `${g} ${SAT_KSIC_DIVISION_NAMES[g] ?? "?"}`);

  // ---- 유니버스·신호 ----
  const eCache = new Map<string, S[]>();
  const eligAt = (d: string): S[] => {
    let v = eCache.get(d);
    if (!v) {
      const e: { s: S; mcap: number }[] = [];
      for (const s of stocks) { const i = s.idx.get(d); if (i !== undefined && isElig({ mcap: s.mcapRow, avgTv: s.avgTvRow }, i)) e.push({ s, mcap: s.mcapRow[i] }); }
      v = e.sort((a, b) => b.mcap - a.mcap || (a.s.code < b.s.code ? -1 : 1)).map((x) => x.s);
      eCache.set(d, v);
    }
    return v;
  };
  type Univ = "ALL" | "TOP100";
  const uAt = (d: string, univ: Univ = "ALL"): S[] => (univ === "ALL" ? eligAt(d) : eligAt(d).slice(0, SCAN_POOL_SIZE)).filter((s) => !excluded.has(s.code));
  const mcapAt = (s: S, d: string): number => s.mcapRow[s.idx.get(d)!];
  const c1At = (s: S, d: string): number => {
    const j = calIdx.get(d)! - SCS_CREDIT_LAG_DAYS;
    if (j < 0) return NaN;
    const li = s.lastCr[j];
    if (li < 0 || j - li > SCS_CREDIT_CARRY_MAX_DAYS) return NaN;
    return s.CR[li];
  };
  const volAt = (s: S, c: number, N: number): number => {
    if (c - N + 1 < 0) return NaN;
    const cl = s.closeA;
    let days = 0, n = 0, sum = 0, sum2 = 0;
    for (let j = c - N + 1; j <= c; j++) {
      if (cl[j] > 0) { days++; if (j > c - N + 1 && cl[j - 1] > 0) { const r = cl[j] / cl[j - 1] - 1; n++; sum += r; sum2 += r * r; } }
    }
    if (days < Math.ceil(N * LV_MIN_PRICE_DAY_RATIO) || n < 2) return NaN;
    const m = sum / n;
    return Math.sqrt(Math.max((sum2 - n * m * m) / (n - 1), 0));
  };
  const byCodeAsc = (a: { code: string }, b: { code: string }): number => (a.code < b.code ? -1 : 1);

  /** 분기별 위성 목표(보유 유지 규칙 때문에 순서대로 계산). */
  interface SatCfg { univ: Univ; cap: number; hold: number; keep: number; volN: number; c1Parts: number }
  const BASE: SatCfg = { univ: "ALL", cap: Infinity, hold: SAT_HOLD_COUNT, keep: SAT_KEEP_RANK, volN: LV_VOL_DAYS, c1Parts: SAT_C1_EXCLUDE_PARTS };
  function satBuild(cfg: SatCfg): { targets: Target[]; picks: Pick[][]; nNew: number[]; nSel: number[] } {
    const targets: Target[] = [], picks: Pick[][] = [], nNew: number[] = [], nSel: number[] = [];
    let prev = new Set<string>();
    for (const d of quarterSignals) {
      const c = calIdx.get(d)!;
      const U = uAt(d, cfg.univ);
      const items = U.map((s) => ({ s, code: s.code, c1: c1At(s, d), vol: volAt(s, c, cfg.volN) })).filter((x) => Number.isFinite(x.c1) && Number.isFinite(x.vol));
      const byC1Desc = [...items].sort((a, b) => b.c1 - a.c1 || byCodeAsc(a, b));
      const n = byC1Desc.length;
      const rest = byC1Desc.filter((_, i) => Math.floor((i * cfg.c1Parts) / n) !== 0);
      const rC = new Map([...rest].sort((a, b) => a.c1 - b.c1 || byCodeAsc(a, b)).map((x, i) => [x.code, i + 1]));
      const rV = new Map([...rest].sort((a, b) => a.vol - b.vol || byCodeAsc(a, b)).map((x, i) => [x.code, i + 1]));
      const ranked = rest.map((x) => ({ ...x, score: (rC.get(x.code)! + rV.get(x.code)!) / 2 })).sort((a, b) => a.score - b.score || a.vol - b.vol || byCodeAsc(a, b));
      const cnt = new Map<string, number>();
      const chosen: typeof ranked = [];
      const take = (x: (typeof ranked)[number]): void => { const g = sectorOf(x.code); if (chosen.length < cfg.hold && (cnt.get(g) ?? 0) < cfg.cap) { chosen.push(x); cnt.set(g, (cnt.get(g) ?? 0) + 1); } };
      const keptCand = ranked.filter((x, i) => i < cfg.keep && prev.has(x.code));
      const keptSet = new Set(keptCand.map((x) => x.code));
      for (const x of keptCand) take(x);
      for (const x of ranked) { if (chosen.length >= cfg.hold) break; if (!keptSet.has(x.code)) take(x); }
      chosen.sort((a, b) => a.score - b.score || a.vol - b.vol || byCodeAsc(a, b));
      // 매수 지연 대상: 새 종목 중 F5/시총이 U(d)(정리본 있는 종목) 상위 10%
      const fItems = U.filter((s) => s.flowCum).map((s) => ({ code: s.code, f: (s.flowCum![c + 1] - s.flowCum![Math.max(c + 1 - SAT_FLOW_DAYS, 0)]) / mcapAt(s, d) })).sort((a, b) => b.f - a.f || byCodeAsc(a, b));
      const topF = new Set(fItems.filter((_, i) => Math.floor((i * SAT_FLOW_TOP_PARTS) / fItems.length) === 0).map((x) => x.code));
      const newCodes = chosen.filter((x) => !prev.has(x.code)).map((x) => x.code);
      const w = new Map(chosen.map((x) => [x.code, 1 / chosen.length]));
      targets.push({ w, n: chosen.length, delayed: new Set(newCodes.filter((code) => topF.has(code))) });
      picks.push(chosen.map((x) => ({ code: x.code, c1: x.c1, vol: x.vol, score: x.score })));
      nNew.push(newCodes.length); nSel.push(chosen.length);
      prev = new Set(chosen.map((x) => x.code));
    }
    return { targets, picks, nNew, nSel };
  }
  const CFG_V11 = BASE, CFG_A: SatCfg = { ...BASE, cap: SAT_SECTOR_CAP }, CFG_B: SatCfg = { ...BASE, cap: SAT_SECTOR_CAP, univ: "TOP100" };
  const bV11 = satBuild(CFG_V11), bA = satBuild(CFG_A), bB = satBuild(CFG_B);
  const pewTargets: Target[] = quarterSignals.map((d) => { const U = uAt(d); return { w: new Map(U.map((s) => [s.code, 1 / U.length])), n: U.length, delayed: new Set<string>() }; });
  const pew100Targets: Target[] = quarterSignals.map((d) => { const P = eligAt(d).slice(0, SCAN_POOL_SIZE); return { w: new Map(P.map((s) => [s.code, 1 / P.length])), n: P.length, delayed: new Set<string>() }; });
  const poolTargets: Target[] = quarterSignals.map((d) => {
    const P = eligAt(d).slice(0, SCAN_POOL_SIZE);
    let tot = 0;
    const w = new Map<string, number>();
    for (const s of P) { const x = mcapAt(s, d); if (x > 0) { w.set(s.code, x); tot += x; } }
    for (const [k, x] of w) w.set(k, x / tot);
    return { w, n: w.size, delayed: new Set<string>() };
  });

  const buyRate = computeEffectiveBuyPrice(1) - 1;
  const sellRate = (d: string): number => 1 - computeEffectiveSellPrice(1, d, "KR");

  // ---- 엔진 (매수 지연 포함) ----
  function run(targets: Target[], delay: boolean): Out {
    const execAt = new Map<string, Target>();
    quarterSignals.forEach((d, k) => { const j = calIdx.get(d)! + 1 + (delay ? 1 : 0); if (j < nCal) execAt.set(CAL[j], targets[k]); });
    let cash = 1, prevV = 1;
    const pos = new Map<string, { val: number; last: number }>();
    let pending = new Map<string, { amt: number; day: number }>();
    const out: Out = { dates: [], ret: [], costFrac: [], turn: [], nPos: [], liq: [], delayedBought: 0, delayedMissed: 0 };
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
        out.delayedMissed += pending.size;
        pending = new Map();
        let V = cash;
        for (const p of pos.values()) V += p.val;
        const tg = new Map<string, number>();
        for (const [code, w] of now.w) if (byCode.get(code)!.idx.has(d) && w > 0) tg.set(code, w);
        let buyN = 0, sellN = 0;
        for (const [code, p] of pos) if (!tg.has(code) || now.delayed.has(code)) sellN += p.val;
        for (const [code, w] of tg) { if (now.delayed.has(code)) continue; const diff = w * V - (pos.get(code)?.val ?? 0); if (diff > 0) buyN += diff; else sellN += -diff; }
        const C = buyN * buyRate + sellN * sr, scale = V > 0 ? (V - C) / V : 1;
        pos.clear();
        let inv = 0;
        for (const [code, w] of tg) {
          if (now.delayed.has(code)) { pending.set(code, { amt: w * V * scale, day: c + SAT_BUY_DELAY_DAYS }); continue; }
          const sk = byCode.get(code)!; const val = w * V * scale; pos.set(code, { val, last: sk.close[sk.idx.get(d)!] }); inv += val;
        }
        cash = V - C - inv;
        costF += V > 0 ? C / V : 0;
        if (buyN + sellN > 0) out.turn.push({ d, v: V > 0 ? (buyN + sellN) / 2 / V : 0 });
      } else if (pending.size) {
        let V = cash;
        for (const p of pos.values()) V += p.val;
        for (const [code, p] of pending) {
          if (p.day !== c) continue;
          pending.delete(code);
          const sk = byCode.get(code)!;
          const i = sk.idx.get(d);
          if (i === undefined) { out.delayedMissed++; continue; }
          const C = p.amt * buyRate;
          pos.set(code, { val: p.amt - C, last: sk.close[i] });
          cash -= p.amt;
          costF += C / prevV;
          out.turn.push({ d, v: V > 0 ? p.amt / 2 / V : 0 });
          out.delayedBought++;
        }
      }
      let V = cash;
      for (const p of pos.values()) V += p.val;
      out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.costFrac.push(costF); out.nPos.push(pos.size);
      prevV = V;
    }
    out.delayedMissed += pending.size;
    return out;
  }

  // ---- 지표 ----
  function st(o: { dates: string[]; ret: number[]; costFrac?: number[]; turn?: { d: string; v: number }[]; nPos?: number[] }, win: Win) {
    const to = win.to > dataEnd ? dataEnd : win.to;
    const idx: number[] = [];
    for (let i = 0; i < o.dates.length; i++) if (o.dates[i] >= win.from && o.dates[i] <= win.to && o.dates[i] > firstExec) idx.push(i);
    const r = idx.map((i) => o.ret[i]);
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
    };
  }
  const yearRet = (o: { dates: string[]; ret: number[] }, y: number): number => computeCumulativeAndMdd(o.ret.filter((_, i) => o.dates[i].startsWith(`${y}-`) && o.dates[i] > firstExec)).totalReturnPct;

  // ---- B&H, KOSPI ----
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
  const bhAll = { dates: etf.slice(1).map((x) => x.date), ret: etf.slice(1).map((x, i) => (x.px / etf[i].px - 1) * 100) };
  const cut = (o: { dates: string[]; ret: number[] }): { dates: string[]; ret: number[] } => { const k = o.dates.filter((d) => d <= dataEnd).length; return { dates: o.dates.slice(0, k), ret: o.ret.slice(0, k) }; };
  const bh = cut(bhAll);
  console.log(`069500 마지막 날 ${bhAll.dates[bhAll.dates.length - 1]} → 기간 끝 ${dataEnd}에서 자름(뺀 날 ${bhAll.dates.length - bh.dates.length}개)`);
  const kp = kospi.filter((x) => x.tradeDate >= "2009-12-01");
  const kosAll = { dates: kp.slice(1).map((x) => x.tradeDate), ret: computeIndexDailyReturnsPct(kp as never) };
  const kos = cut(kosAll);
  console.log(`KOSPI 마지막 날 ${kosAll.dates[kosAll.dates.length - 1]} → 뺀 날 ${kosAll.dates.length - kos.dates.length}개`);

  // ---- 실행 ----
  const V11 = run(bV11.targets, false), V11D = run(bV11.targets, true);
  const A = run(bA.targets, false), AD = run(bA.targets, true);
  const B = run(bB.targets, false), BD = run(bB.targets, true);
  const PEW = run(pewTargets, false), PEWD = run(pewTargets, true);
  const PEW100 = run(pew100Targets, false), PEW100D = run(pew100Targets, true);
  const POOL = run(poolTargets, false), POOLD = run(poolTargets, true);

  // ---- 조합 ----
  const bhRetBy = new Map(bh.dates.map((d, i) => [d, bh.ret[i] / 100]));
  const mix = (SAT: Out, w: number): { dates: string[]; ret: number[]; rebals: number } => {
    let E = 1 - w, Sv = w, prevV = 1, due = false, rebals = 0;
    const out = { dates: [] as string[], ret: [] as number[], rebals: 0 };
    for (let i = 0; i < SAT.dates.length; i++) {
      const d = SAT.dates[i], c = calIdx.get(d)!;
      if (i > 0) { E *= 1 + (bhRetBy.get(d) ?? 0); Sv *= 1 + SAT.ret[i] / 100; }
      if (due) {
        const V = E + Sv, x = Math.abs(Sv - w * V);
        const C = x * SAT_ETF_COST_PER_SIDE + x * (Sv < w * V ? buyRate : sellRate(d));
        if (x > 0) rebals++;
        E = (1 - w) * (V - C); Sv = w * (V - C);
        due = false;
      }
      const V = E + Sv;
      out.dates.push(d); out.ret.push((V / prevV - 1) * 100);
      prevV = V;
      const yearEnd = c + 1 < nCal && CAL[c + 1].slice(0, 4) !== d.slice(0, 4);
      if (yearEnd || Math.abs(Sv / V - w) >= SAT_MIX_BAND) due = true;
    }
    out.rebals = rebals;
    return out;
  };

  // ---- 출력 ----
  const LEARN: Win = { ...LV_LEARN }, CONFIRM: Win = { ...LV_CONFIRM }, HOLD: Win = { from: LV_HOLDOUT_FROM, to: "9999-12-31" }, FULL: Win = { from: LV_LEARN.from, to: "9999-12-31" };
  const WINS: [string, Win][] = [["학습", LEARN], ["확인", CONFIRM], ["2022~(참고)", HOLD], ["전 기간", FULL]];
  const winLabel = (w: Win): string => `${w.from}~${w.to > dataEnd ? dataEnd : w.to}`;
  const ROWS: [string, { dates: string[]; ret: number[] }, Out | null][] = [
    ["v1.1(제외 수정)", V11, V11D], ["v1.2a(업종 상한)", A, AD], ["v1.2b(대형주 + 업종 상한)", B, BD],
    ["PEW", PEW, PEWD], ["PEW100", PEW100, PEW100D], ["POOL", POOL, POOLD], ["B&H(069500)", bh, null], ["KOSPI", kos, null],
  ];
  for (const [name, win] of WINS) {
    console.log(`\n=== ${name} ${winLabel(win)} ===`);
    console.log("| 구성 | CAGR % | MDD % | 샤프 | 연변동성 % | 분기 평균 회전율 % | 누적 비용 % | 평균 보유 종목 | 지연 CAGR % | 지연 하락 %p |\n|---|---|---|---|---|---|---|---|---|---|");
    for (const [lab, o, od] of ROWS) {
      const x = st(o, win), xd = od ? st(od, win) : null;
      console.log(`| ${lab} | ${f2(x.cagr)} | ${f2(x.mdd)} | ${f2(x.sharpe)} | ${f2(x.vol)} | ${f2(x.turnover)} | ${f2(x.cost)} | ${f2(x.avgN)} | ${xd ? f2(xd.cagr) : "-"} | ${xd ? f2(x.cagr - xd.cagr) : "-"} |`);
    }
  }

  const bhL = st(bh, LEARN);
  for (const [vname, SAT] of [["v1.2a", A], ["v1.2b", B]] as [string, Out][]) {
    const MIX = SAT_MIX_WEIGHTS.map((w) => ({ w, label: `P${Math.round((1 - w) * 100)}`, o: mix(SAT, w) }));
    const learnRows = MIX.map((m) => { const s = st(m.o, LEARN); return { ...m, s, ok: s.cagr >= bhL.cagr - SAT_MIX_CAGR_TOL_PP && s.mdd <= bhL.mdd + SAT_MDD_EPS }; });
    const okRows = learnRows.filter((r) => r.ok).sort((a, b) => b.s.sharpe - a.s.sharpe || a.w - b.w);
    const selW = okRows.length ? okRows[0].w : SAT_MIX_DEFAULT_W;
    const selLabel = MIX.find((m) => m.w === selW)!.label;
    console.log(`\n=== ${vname} 비중 선택 (학습; B&H CAGR ${f2(bhL.cagr)}, MDD ${f2(bhL.mdd)}, 샤프 ${f2(bhL.sharpe)}) ===`);
    console.log(`| 비중 | 학습 CAGR % | 학습 MDD % | 학습 샤프 | CAGR ≥ ${f2(bhL.cagr - SAT_MIX_CAGR_TOL_PP)} | MDD ≤ ${f2(bhL.mdd)} | 후보 | 되돌림 횟수(전 기간) |\n|---|---|---|---|---|---|---|---|`);
    for (const r of learnRows) console.log(`| ${r.label} | ${f2(r.s.cagr)} | ${f2(r.s.mdd)} | ${f2(r.s.sharpe)} | ${ox(r.s.cagr >= bhL.cagr - SAT_MIX_CAGR_TOL_PP)} | ${ox(r.s.mdd <= bhL.mdd + SAT_MDD_EPS)} | ${ox(r.ok)} | ${r.o.rebals} |`);
    console.log(okRows.length ? `선택: ${selLabel} (후보 ${okRows.length}개 중 학습 샤프 최대 ${f2(okRows[0].s.sharpe)})` : `후보 없음 → 기본 표시 ${selLabel}`);
    console.log(`\n=== ${vname} 7개 비중 구간별 CAGR % / MDD % / 샤프 ===`);
    console.log(`| 비중 | ${WINS.map(([n]) => `${n} CAGR | ${n} MDD | ${n} 샤프`).join(" | ")} |\n|---|${WINS.map(() => "---|---|---|").join("")}`);
    for (const m of MIX) console.log(`| ${m.label}${m.w === selW ? "(선택)" : ""} | ${WINS.map(([, w]) => { const s = st(m.o, w); return `${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)}`; }).join(" | ")} |`);
    console.log(`| B&H(069500) | ${WINS.map(([, w]) => { const s = st(bh, w); return `${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.sharpe)}`; }).join(" | ")} |`);
  }

  console.log(`\n=== 연도별 수익률 % ===\n| 연도 | v1.1(제외 수정) | v1.2a | v1.2b | POOL | B&H |\n|---|---|---|---|---|---|`);
  for (let y = Number(firstExec.slice(0, 4)); y <= Number(dataEnd.slice(0, 4)); y++) console.log(`| ${y} | ${f2(yearRet(V11, y))} | ${f2(yearRet(A, y))} | ${f2(yearRet(B, y))} | ${f2(yearRet(POOL, y))} | ${f2(yearRet(bh, y))} |`);

  const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1);
  console.log("\n=== 분기 구성 ===\n| 변형 | 선정 종목 수 평균 | 최소 | 최대 | 교체 수 평균(첫 분기 제외) | 매수 지연 대상 | 지연 매수 | 지연 후 미매수 | 폐지 청산 |\n|---|---|---|---|---|---|---|---|---|");
  for (const [lab, b, o] of [["v1.1(제외 수정)", bV11, V11], ["v1.2a", bA, A], ["v1.2b", bB, B]] as [string, typeof bA, Out][]) {
    console.log(`| ${lab} | ${f2(avg(b.nSel))} | ${Math.min(...b.nSel)} | ${Math.max(...b.nSel)} | ${f2(avg(b.nNew.slice(1)))} | ${b.targets.reduce((a, t) => a + t.delayed.size, 0)} | ${o.delayedBought} | ${o.delayedMissed} | ${o.liq.length} |`);
  }

  const lastK = quarterSignals.length - 1;
  for (const [vname, b] of [["v1.2a", bA], ["v1.2b", bB]] as [string, typeof bA][]) {
    console.log(`\n=== ${vname} 가장 최근 리밸런싱 (신호 ${quarterSignals[lastK]}, 체결 ${CAL[calIdx.get(quarterSignals[lastK])! + 1] ?? "-"}) ${b.picks[lastK].length}종목 ===`);
    console.log("| 순서 | 코드 | 이름 | 업종 | C1 신용잔고율 % | VOL 일표준편차 % | 점수 | 매수 지연 대상 |\n|---|---|---|---|---|---|---|---|");
    b.picks[lastK].forEach((x, i) => console.log(`| ${i + 1} | ${x.code} | ${nameOf.get(x.code) ?? "-"} | ${indLabel(x.code)} | ${f2(x.c1)} | ${f2(x.vol * 100)} | ${f2(x.score)} | ${b.targets[lastK].delayed.has(x.code) ? "O" : ""} |`));
    const dist = new Map<string, number>();
    for (const x of b.picks[lastK]) { const g = sectorLabel(sectorOf(x.code)); dist.set(g, (dist.get(g) ?? 0) + 1); }
    console.log("업종 분포(앞 2자리)\n| 업종 | 종목 수 |\n|---|---|");
    for (const [k, v] of [...dist].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1))) console.log(`| ${k} | ${v} |`);
  }

  // ---- 튼튼함 검사 R1~R3 (전 기간, 두 변형) ----
  const qk = (d: string): string => `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
  for (const [vname, cfg, SAT, BEN, benName] of [["v1.2a", CFG_A, A, PEW, "PEW"], ["v1.2b", CFG_B, B, POOL, "POOL"]] as [string, SatCfg, Out, Out, string][]) {
    const fullS = st(SAT, FULL);
    console.log(`\n=== ${vname} R1 주변 값 (전 기간 ${winLabel(FULL)}; 기본 CAGR ${f2(fullS.cagr)}, 샤프 ${f2(fullS.sharpe)}, MDD ${f2(fullS.mdd)}) ===\n| 변형 | CAGR % | 샤프 | MDD % |\n|---|---|---|---|`);
    const r1 = (label: string, c: SatCfg): void => { const s = st(run(satBuild(c).targets, false), FULL); console.log(`| ${label} | ${f2(s.cagr)} | ${f2(s.sharpe)} | ${f2(s.mdd)} |`); };
    for (const h of SAT_R1_HOLD_COUNTS) r1(`보유 ${h}(유지 순위 ${h * SAT_KEEP_MULT})`, { ...cfg, hold: h, keep: h * SAT_KEEP_MULT });
    for (const n of SAT_R1_VOL_DAYS) r1(`VOL 창 ${n}일`, { ...cfg, volN: n });
    for (const k of SAT_R1_SECTOR_CAPS) r1(`업종 상한 ${k}`, { ...cfg, cap: k });

    const qm = new Map<string, { s: number[]; w: number[]; idx: number[] }>();
    SAT.dates.forEach((d, i) => { if (d <= firstExec) return; const k = qk(d); const e = qm.get(k) ?? { s: [], w: [], idx: [] }; e.s.push(SAT.ret[i]); e.w.push(BEN.ret[i]); e.idx.push(i); qm.set(k, e); });
    let best = { q: "", ex: -Infinity };
    for (const [k, e] of qm) { const ex = computeCumulativeAndMdd(e.s).totalReturnPct - computeCumulativeAndMdd(e.w).totalReturnPct; if (ex > best.ex) best = { q: k, ex }; }
    const repl = [...SAT.ret];
    for (const i of qm.get(best.q)!.idx) repl[i] = BEN.ret[i];
    const r2s = st({ dates: SAT.dates, ret: repl }, FULL);
    console.log(`\n=== ${vname} R2 상위 사건 제거 (비교 기준 ${benName}) ===\n| 바꾼 분기 | 그 분기 ${vname} − ${benName} %p | 바꾼 뒤 전 기간 CAGR % | 바꾸기 전 CAGR % | ${benName} 전 기간 CAGR % |\n|---|---|---|---|---|\n| ${best.q} | ${f2(best.ex)} | ${f2(r2s.cagr)} | ${f2(fullS.cagr)} | ${f2(st(BEN, FULL).cagr)} |`);

    const rng = mulberry32(SAT_R3_SEED);
    const uList = quarterSignals.map((d) => uAt(d, cfg.univ));
    const cg: number[] = [], sh: number[] = [];
    for (let n = 0; n < SAT_R3_DRAWS; n++) {
      const tg: Target[] = uList.map((U) => {
        const a = [...U];
        for (let i = 0; i < a.length - 1; i++) { const j = i + Math.floor(rng() * (a.length - i)); [a[i], a[j]] = [a[j], a[i]]; }
        const cnt = new Map<string, number>(), pick: S[] = [];
        for (const s of a) { if (pick.length >= SAT_HOLD_COUNT) break; const g = sectorOf(s.code); if ((cnt.get(g) ?? 0) < cfg.cap) { pick.push(s); cnt.set(g, (cnt.get(g) ?? 0) + 1); } }
        return { w: new Map(pick.map((s) => [s.code, 1 / pick.length])), n: pick.length, delayed: new Set<string>() };
      });
      const s = st(run(tg, false), FULL);
      cg.push(s.cagr); sh.push(s.sharpe);
    }
    const summ = (arr: number[], v: number): string => { const b = [...arr].sort((x, y) => x - y); return `${f2(b[Math.floor(b.length / 2)])} | ${f2(b[Math.floor(b.length * 0.95)])} | ${f2(b[b.length - 1])} | ${f2(v)} | ${arr.filter((x) => x >= v).length} | ${f2((arr.filter((x) => x < v).length / arr.length) * 100)}`; };
    console.log(`\n=== ${vname} R3 무작위 비교 (매 분기 같은 유니버스에서 업종 상한 ${cfg.cap} 지키며 ${SAT_HOLD_COUNT}종목 무작위 동일가중, ${SAT_R3_DRAWS}회, 시드 ${SAT_R3_SEED}, 전 기간) ===\n| 지표 | 무작위 중앙값 | 95분위 | 최대 | ${vname} | ${vname} 이상 회수 | 백분위 |\n|---|---|---|---|---|---|---|`);
    console.log(`| CAGR % | ${summ(cg, fullS.cagr)} |`);
    console.log(`| 샤프 | ${summ(sh, fullS.sharpe)} |`);
  }

  console.log("\n=== 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Storage 다운로드: 신용잔고 정리본 ${dl.creditRows}행 ${(dl.creditBytes / 1048576).toFixed(2)} MiB, 외국인 수급 정리본 ${dl.flowRows}행 ${(dl.flowBytes / 1048576).toFixed(2)} MiB | Supabase 쓴 행: 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건(Storage 다운로드 제외), 시도 아님] 배당 포함 총수익 재측정.
 * 사전 등록: research/total-return-remeasure-prereg.md (38f87ca). 1단계(배당 데이터 점검) → 게이트 → 통과 시 2단계(총수익 재측정). 대상 정의는
 * research/satellite-v1_2-prereg.md(4c1557a)·research/credit-tilt-prereg.md(1b6bf3f)·research/credit-tilt-cr1-prereg.md(e148f21) 그대로. 숫자와 표만 출력한다.
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
import { CT_CREDIT_FIRST_YEAR, CT_CREDIT_LAST_YEAR, CT_GROUPS, CT_MULT_HIGH, CT_MULT_MID, CT_MULT_LOW } from "@/lib/creditTiltConfig";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";
import {
  SAT_HOLD_COUNT, SAT_KEEP_RANK, SAT_C1_EXCLUDE_PARTS, SAT_FLOW_DAYS, SAT_FLOW_TOP_PARTS, SAT_BUY_DELAY_DAYS, SAT_MIX_BAND, SAT_ETF_COST_PER_SIDE, SAT_MIX_DEFAULT_W, SAT_SPAC_NAME_KEYWORDS,
  SAT_REIT_NAME_SUFFIX, SAT_REIT_KSIC_PREFIXES, SAT_REIT_EXPLICIT_CODES, SAT_SECTOR_CAP, SAT_SECTOR_UNCLASSIFIED, SAT_KSIC_DIVISION_NAMES,
} from "@/lib/satelliteV1Config";

const T0 = Date.now();
const MS_DAY = 86_400_000;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;
const dbRead: Record<string, number> = {};
const dl = { creditBytes: 0, creditRows: 0, flowBytes: 0, flowRows: 0 };
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

interface S { code: string; idx: Map<string, number>; close: Float64Array; raw: Float64Array; tr: Float64Array; closeA: Float64Array; mcapRow: Float64Array; avgTvRow: Float64Array; last: string; CR: Float64Array; lastCr: Int32Array; flowCum: Float64Array | null }
interface Target { w: Map<string, number>; n: number; delayed: Set<string> }
interface Out { dates: string[]; ret: number[]; costFrac: number[]; turn: { d: string; v: number }[]; nPos: number[]; liq: string[]; delayedBought: number; delayedMissed: number }
interface Win { from: string; to: string }
interface Pick { code: string; c1: number; vol: number; score: number }

async function main(): Promise<void> {
  console.log(`배당 포함 총수익 재측정 시작(읽기 전용): ${new Date().toISOString()} (사전등록 38f87ca 이후)`);
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

  interface Row0 { code: string; dates: string[]; close: Float64Array; raw: Float64Array; mcap: Float64Array; avgTv: Float64Array }
  /** 배당 수집 대상 규칙 재현: 가격 Parquet 2011~ 어느 하루라도 시총 ≥ 1조. */
  const cand1t = new Set<string>();
  const rows0: Row0[] = [];
  const calSet = new Set<string>();
  for (const [code, rows] of series) {
    series.delete(code);
    if (!rows.length) continue;
    const adj = rows.map((r) => ({ ...r }));
    const al = adjustments.get(code);
    if (al) applyAdjustmentsInPlace(adj, al);
    for (const r of rows) if (r.tradeDate >= "2010-01-01") calSet.add(r.tradeDate);
    if (rows.some((r) => r.tradeDate >= "2011-01-01" && r.marketCapEok >= STOCK_DATA_CANDIDATE_MARKET_CAP_EOK)) cand1t.add(code);
    rows0.push({ code, dates: rows.map((r) => r.tradeDate), close: Float64Array.from(adj.map((r) => r.closePrice)), raw: Float64Array.from(rows.map((r) => r.closePrice)), mcap: Float64Array.from(rows.map((r) => r.marketCapEok)), avgTv: computeTrailingAvgTradingValue(adj, PIT_LIQUIDITY_LOOKBACK_DAYS) });
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
    return { code: r.code, idx, close: r.close, raw: r.raw, tr: Float64Array.from(r.close), closeA, mcapRow: r.mcap, avgTvRow: r.avgTv, last: r.dates[r.dates.length - 1], CR, lastCr, flowCum };
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
  const bA = satBuild({ ...BASE, cap: SAT_SECTOR_CAP }), bB = satBuild({ ...BASE, cap: SAT_SECTOR_CAP, univ: "TOP100" });
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
  function run(targets: Target[], delay: boolean, tr = false): Out {
    const P = (sk: S): Float64Array => (tr ? sk.tr : sk.close);
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
        if (i !== undefined) { p.val = (p.val * P(sk)[i]) / p.last; p.last = P(sk)[i]; }
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
          const sk = byCode.get(code)!; const val = w * V * scale; pos.set(code, { val, last: P(sk)[sk.idx.get(d)!] }); inv += val;
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
          pos.set(code, { val: p.amt - C, last: P(sk)[i] });
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
  const rawEtf: { date: string; px: number }[] = [], rawEtfR: { date: string; px: number }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from("etf_daily_prices").select("trade_date, adj_close, raw_close").eq("code", SEASON_STOCK_CODE).order("trade_date").range(from, from + 999);
    if (error) throw new Error(`etf_daily_prices: ${error.message}`);
    for (const r of data ?? []) { if (r.adj_close !== null) rawEtf.push({ date: r.trade_date as string, px: Number(r.adj_close) }); if (r.raw_close !== null) rawEtfR.push({ date: r.trade_date as string, px: Number(r.raw_close) }); }
    dbRead["etf_daily_prices(069500)"] = (dbRead["etf_daily_prices(069500)"] ?? 0) + (data?.length ?? 0);
    if (!data || data.length < 1000) break;
  }
  const kRetByDate = new Map<string, number>();
  for (let i = 1; i < kospi.length; i++) kRetByDate.set(kospi[i].tradeDate, kospi[i].closePrice / kospi[i - 1].closePrice - 1);
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
    return { dates: e.slice(1).map((x) => x.date), ret: e.slice(1).map((x, i) => (x.px / e[i].px - 1) * 100) };
  };
  const bhAll = clean(rawEtf, "수정주가(adj_close)"), bhRawAll = clean(rawEtfR, "원주가(raw_close)");
  const cut = (o: { dates: string[]; ret: number[] }): { dates: string[]; ret: number[] } => { const k = o.dates.filter((d) => d <= dataEnd).length; return { dates: o.dates.slice(0, k), ret: o.ret.slice(0, k) }; };
  const bh = cut(bhAll), bhRaw = cut(bhRawAll);
  console.log(`069500 마지막 날 ${bhAll.dates[bhAll.dates.length - 1]} → 기간 끝 ${dataEnd}에서 자름(뺀 날 ${bhAll.dates.length - bh.dates.length}개)`);
  const kp = kospi.filter((x) => x.tradeDate >= "2009-12-01");
  const kosAll = { dates: kp.slice(1).map((x) => x.tradeDate), ret: computeIndexDailyReturnsPct(kp as never) };
  const kos = cut(kosAll);
  console.log(`KOSPI 마지막 날 ${kosAll.dates[kosAll.dates.length - 1]} → 뺀 날 ${kosAll.dates.length - kos.dates.length}개`);

  // ================= 1단계: 배당 데이터 점검 =================
  const divRows = await selectAll<{ stock_code: string; record_date: string; cash_dividend_per_share: number | string }>("stock_dividend_history", (f, t) => supabaseAdmin.from("stock_dividend_history").select("stock_code, record_date, cash_dividend_per_share").order("stock_code").order("record_date").range(f, t));
  const runsRows = await selectAll<{ started_at: string; finished_at: string | null; rows_fetched: number | null; error_count: number | null }>("stock_data_backfill_runs(dividends)", (f, t) => supabaseAdmin.from("stock_data_backfill_runs").select("started_at, finished_at, rows_fetched, error_count").eq("data_source", "dividends").order("started_at").range(f, t));
  const divBy = new Map<string, { rec: string; amt: number }[]>();
  let nonPos = 0;
  const rowsByYear = new Map<string, number>();
  for (const r of divRows) {
    const amt = Number(r.cash_dividend_per_share);
    rowsByYear.set(r.record_date.slice(0, 4), (rowsByYear.get(r.record_date.slice(0, 4)) ?? 0) + 1);
    if (!(amt > 0)) { nonPos++; continue; }
    const a = divBy.get(r.stock_code) ?? [];
    a.push({ rec: r.record_date, amt });
    divBy.set(r.stock_code, a);
  }
  const divCodesAll = new Set(divRows.map((r) => r.stock_code));
  const recDates = divRows.map((r) => r.record_date).sort();
  console.log("\n=== 1단계: 배당 데이터 점검 ===");
  console.log(`stock_dividend_history: ${divRows.length}행, 종목 ${divCodesAll.size}개, record_date ${recDates[0] ?? "-"}~${recDates[recDates.length - 1] ?? "-"}, 금액 ≤ 0 행 ${nonPos}개`);
  console.log(`연도별 행 수: ${[...rowsByYear].sort().map(([y, n]) => `${y} ${n}`).join(", ")}`);
  console.log(`stock_data_backfill_runs(dividends): ${runsRows.length ? runsRows.map((r) => `시작 ${r.started_at} 종료 ${r.finished_at ?? "-"} 행 ${r.rows_fetched ?? "-"} 실패 ${r.error_count ?? "-"}`).join(" | ") : "없음"}`);
  console.log(`수집 대상 규칙 재현(가격 Parquet 2011~ 어느 하루라도 시총 ≥ ${STOCK_DATA_CANDIDATE_MARKET_CAP_EOK}억): ${cand1t.size}종목, 그중 배당 표에 행이 있는 종목 ${[...cand1t].filter((c) => divCodesAll.has(c)).length}개 | 배당 표 종목 중 규칙 밖 ${[...divCodesAll].filter((c) => !cand1t.has(c)).length}개`);
  console.log("DART 교차 확인: 배당 표 dart_dividends는 20260827010000에서 삭제됐고 다른 표에 배당 컬럼이 없어 불가");

  const hasDivInYear = (c: string, y: number): boolean => (divBy.get(c) ?? []).some((x) => x.rec.startsWith(`${y}-`));
  let gateOk = true;
  let missingTotal = 0;
  const missingCodes = new Set<string>();
  console.log("\n연도별 구성원 점검 (구성원 = 그 해 분기 신호일 유니버스의 합집합)\n| 연도 | POOL 구성원 | 그 해 배당 기록 % | 수집 규칙 포함 % | 배당 표 행 있음 % | PIT 구성원 | 그 해 배당 기록 % | 수집 규칙 포함 % | 배당 표 행 있음 % |\n|---|---|---|---|---|---|---|---|---|");
  for (let y = 2010; y <= Number(dataEnd.slice(0, 4)); y++) {
    const sigs = quarterSignals.filter((d) => d.startsWith(`${y}-`));
    const pool = new Set<string>(), pit = new Set<string>();
    for (const d of sigs) { const E = eligAt(d); E.slice(0, SCAN_POOL_SIZE).forEach((s) => pool.add(s.code)); E.forEach((s) => pit.add(s.code)); }
    const pc = (set: Set<string>, f: (c: string) => boolean): number => (set.size ? ([...set].filter(f).length / set.size) * 100 : NaN);
    const pd = pc(pool, (c) => hasDivInYear(c, y)), pr = pc(pool, (c) => cand1t.has(c)), pa = pc(pool, (c) => divCodesAll.has(c));
    const ud = pc(pit, (c) => hasDivInYear(c, y)), ur = pc(pit, (c) => cand1t.has(c)), ua = pc(pit, (c) => divCodesAll.has(c));
    for (const c of [...pool, ...pit]) if (!cand1t.has(c)) missingCodes.add(c);
    missingTotal += [...pit].filter((c) => !cand1t.has(c)).length;
    if (!(pd >= 70) || !(ud >= 70)) gateOk = false;
    console.log(`| ${y} | ${pool.size} | ${f2(pd)} | ${f2(pr)} | ${f2(pa)} | ${pit.size} | ${f2(ud)} | ${f2(ur)} | ${f2(ua)} |`);
  }
  if (missingCodes.size) gateOk = false;
  console.log(`수집 규칙 밖 구성원: 서로 다른 종목 ${missingCodes.size}개 (연도별 PIT 구성원 기준 합계 ${missingTotal}건)`);

  console.log("\n069500 수정주가(adj_close) vs 원주가(raw_close) 연도별 수익률 %\n| 연도 | 수정 | 원주가 | 차이(분배금 효과) %p |\n|---|---|---|---|");
  for (let y = Number(firstExec.slice(0, 4)); y <= Number(dataEnd.slice(0, 4)); y++) {
    const a = yearRet(bh, y), b = yearRet(bhRaw, y);
    console.log(`| ${y} | ${f2(a)} | ${f2(b)} | ${f2(a - b)} |`);
  }

  console.log(`\n=== 게이트: ${gateOk ? "통과 → 2단계 계산" : "통과 아님 → 2단계 계산하지 않음"} (기준: 매년 POOL·PIT 그 해 배당 기록 ≥ 70%, 수집 규칙 밖 구성원 0개) ===`);
  if (gateOk) {
    // ================= 2단계: 총수익 재측정 =================
    let applied = 0, skipped = 0;
    for (const s of stocks) {
      const divAdj = new Float64Array(s.close.length);
      for (const x of divBy.get(s.code) ?? []) {
        let lo = 0, hi = nCal - 1, k = -1;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (CAL[m] <= x.rec) { k = m; lo = m + 1; } else hi = m - 1; }
        const i = k >= 1 ? s.idx.get(CAL[k - 1]) : undefined;
        if (i === undefined || i === 0 || !(s.raw[i] > 0)) { skipped++; continue; }
        divAdj[i] += x.amt * (s.close[i] / s.raw[i]);
        applied++;
      }
      s.tr[0] = s.close[0];
      for (let i = 1; i < s.close.length; i++) s.tr[i] = s.close[i - 1] > 0 ? (s.tr[i - 1] * (s.close[i] + divAdj[i])) / s.close[i - 1] : s.close[i];
    }
    console.log(`\n=== 2단계: 총수익 재측정 ===\n배당 반영 ${applied}건, 반영 못 함(배당락일 행 없음 등) ${skipped}건 (PIT 적격 이력 종목 ${stocks.length}개 대상)`);

    const cr1Targets: Target[] = quarterSignals.map((d) => {
      const members = eligAt(d).slice(0, SCAN_POOL_SIZE);
      const items = members.map((s) => ({ s, v: c1At(s, d) })).filter((x) => Number.isFinite(x.v)).sort((a, b) => b.v - a.v || (a.s.code < b.s.code ? -1 : 1));
      const grp = new Map<string, number>(members.map((s) => [s.code, 1]));
      items.forEach((x, i) => { const g = Math.floor((i * CT_GROUPS) / items.length); grp.set(x.s.code, g === 0 ? 0 : g === CT_GROUPS - 1 ? 2 : 1); });
      const w = new Map<string, number>();
      let tot = 0;
      for (const s of members) { const x = mcapAt(s, d) * [CT_MULT_HIGH, CT_MULT_MID, CT_MULT_LOW][grp.get(s.code)!]; if (x > 0) { w.set(s.code, x); tot += x; } }
      for (const [k, x] of w) w.set(k, x / tot);
      return { w, n: w.size, delayed: new Set<string>() };
    });
    const pair = (tg: Target[]): [Out, Out] => [run(tg, false, false), run(tg, false, true)];
    const [POOLp, POOLt] = pair(poolTargets), [P100p, P100t] = pair(pew100Targets), [PEWp, PEWt] = pair(pewTargets);
    const [Ap, At] = pair(bA.targets), [Bp, Bt] = pair(bB.targets), [CRp, CRt] = pair(cr1Targets);
    const mixWith = (SAT: { dates: string[]; ret: number[] }, w: number, bench: { dates: string[]; ret: number[] }): { dates: string[]; ret: number[] } => {
      const by = new Map(bench.dates.map((d, i) => [d, bench.ret[i] / 100]));
      let E = 1 - w, Sv = w, prevV = 1, due = false;
      const out = { dates: [] as string[], ret: [] as number[] };
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
    const W80 = SAT_MIX_DEFAULT_W; // P80(069500 80 : 위성 20)
    type Ser = { dates: string[]; ret: number[] };
    const TARGETS: [string, Ser, Ser | null][] = [
      ["POOL", POOLp, POOLt], ["PEW100", P100p, P100t], ["PEW(v1.2 U)", PEWp, PEWt], ["KOSPI(가격만)", kos, null],
      ["B&H 069500 (가격=원주가, 총수익=수정)", bhRaw, bh], ["위성 v1.2a", Ap, At], ["위성 v1.2b", Bp, Bt], ["CR1", CRp, CRt],
      ["v1.2a P80 (가격+B&H 원주가 / 총수익+B&H 수정)", mixWith(Ap, W80, bhRaw), mixWith(At, W80, bh)],
      ["v1.2b P80 (가격+B&H 원주가 / 총수익+B&H 수정)", mixWith(Bp, W80, bhRaw), mixWith(Bt, W80, bh)],
      ["참고: v1.2a P80 기존 정의(가격+B&H 수정)", mixWith(Ap, W80, bh), null], ["참고: v1.2b P80 기존 정의(가격+B&H 수정)", mixWith(Bp, W80, bh), null],
    ];
    const LEARN: Win = { ...LV_LEARN }, CONFIRM: Win = { ...LV_CONFIRM }, HOLD: Win = { from: LV_HOLDOUT_FROM, to: "9999-12-31" }, FULL: Win = { from: LV_LEARN.from, to: "9999-12-31" };
    const WINS: [string, Win][] = [["학습", LEARN], ["확인", CONFIRM], ["2022~", HOLD], ["전 기간", FULL]];
    for (const [name, win] of WINS) {
      console.log(`\n--- ${name} ${win.from}~${win.to > dataEnd ? dataEnd : win.to} ---\n| 대상 | 가격 CAGR % | 총수익 CAGR % | 배당 기여 %p | 가격 MDD % | 총수익 MDD % | 가격 샤프 | 총수익 샤프 |\n|---|---|---|---|---|---|---|---|`);
      for (const [lab, p, t] of TARGETS) {
        const a = st(p, win), b = t ? st(t, win) : null;
        console.log(`| ${lab} | ${f2(a.cagr)} | ${b ? f2(b.cagr) : "-"} | ${b ? f2(b.cagr - a.cagr) : "-"} | ${f2(a.mdd)} | ${b ? f2(b.mdd) : "-"} | ${f2(a.sharpe)} | ${b ? f2(b.sharpe) : "-"} |`);
      }
    }
    const withTr = TARGETS.filter((x) => x[2]) as [string, Ser, Ser][];
    console.log(`\n--- 연도별 배당 기여 %p (총수익 연수익률 − 가격 연수익률) ---\n| 연도 | ${withTr.map((x) => x[0]).join(" | ")} |\n|---|${withTr.map(() => "---|").join("")}`);
    for (let y = Number(firstExec.slice(0, 4)); y <= Number(dataEnd.slice(0, 4)); y++) console.log(`| ${y} | ${withTr.map(([, p, t]) => f2(yearRet(t, y) - yearRet(p, y))).join(" | ")} |`);
  }

  console.log("\n=== 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Storage 다운로드: 신용잔고 정리본 ${dl.creditRows}행 ${(dl.creditBytes / 1048576).toFixed(2)} MiB, 외국인 수급 정리본 ${dl.flowRows}행 ${(dl.flowBytes / 1048576).toFixed(2)} MiB | Supabase 쓴 행: 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

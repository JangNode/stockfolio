/**
 * peg 신호 커버리지 점검 코어(scripts/research-peg-coverage.ts, 커밋 561a1a5와 같은 정의·판정 코드를 함수로 분리).
 * 재무 소스 우선순위: stock_annual_fundamentals > stock_annual_fundamentals_fill(ok 행) > dart_xbrl_fundamentals.
 * 행이 "있다" = rcept 날짜가 있는 행. 탈락 사유 우선순위: 1 end 행 없음 2 start 행 없음 3 순이익 null 4 주식수 null 5 fs_div 불일치 6 적자 7 역성장.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet, DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { computeTrailingAvgTradingValue, pickListedSharesOnOrBefore } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { PEG_GROWTH_LOOKBACK_YEARS } from "@/lib/pegConfig";
import { XBRL_BACKFILL_UNIVERSE_MIN_CAP_EOK, XBRL_BACKFILL_PIT_FROM, XBRL_BACKFILL_DB_IN_CHUNK, FIN_NAME_RE } from "@/lib/dartXbrlBackfillConfig";

export const SEG_FROM = "2016-03-01";
export const BASE_FROM = "2021-03-01";
export const pc = (a: number, b: number): string => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

export interface Ann { fy: number; rcept: string; ni: number | null; fsDiv: string | null; src: "stock" | "fill" | "xbrl" }
export type Reason = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const REASON_NAME: Record<Reason, string> = { 1: "end 행 없음", 2: "start 행 없음", 3: "순이익 null", 4: "주식수 null", 5: "fs_div 불일치", 6: "적자", 7: "역성장" };
export const REASONS = [1, 2, 3, 4, 5, 6, 7] as Reason[];
export interface MM { code: string; date: string; seg: "ext" | "base"; year: number; group: string; reason: Reason | null; missFy: number | null }
export interface Ctx {
  series: Map<string, StockDailyPriceRow[]>; lastTrade: Map<string, string>; dataEnd: string;
  monthEnds: string[]; members: Map<string, string[]>; codes: string[];
  corpMap: Map<string, { corp: string; name: string }>;
  stockRows: Map<string, Ann[]>; xbrlAnn: Map<string, Ann[]>;
  xbrlStatus: Map<string, Map<number, { status: string; ni: number | null }>>;
  dbRead: Record<string, number>;
}

export async function selectAll<T>(dbRead: Record<string, number>, label: string, build: (f: number, t: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
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

export async function loadCtx(): Promise<Ctx> {
  const dbRead: Record<string, number> = {};
  const adjustments = await loadAppliedAdjustments();
  dbRead["stock_price_adjustment_events(applied)"] = [...adjustments.values()].reduce((a, l) => a + l.length, 0);
  const series: Map<string, StockDailyPriceRow[]> = await loadAllStockSeriesFromParquet(2010, 2026, adjustments);
  let dataEnd = "";
  const lastTrade = new Map<string, string>();
  for (const [code, rows] of series) { const l = rows[rows.length - 1].tradeDate; lastTrade.set(code, l); if (l > dataEnd) dataEnd = l; }
  const dates = new Set<string>();
  for (const rows of series.values()) for (const r of rows) if (r.tradeDate >= XBRL_BACKFILL_PIT_FROM) dates.add(r.tradeDate);
  const cal = [...dates].sort();
  const meSet = new Set<string>();
  for (let k = 0; k + 1 < cal.length; k++) if (cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7)) meSet.add(cal[k]);
  const members = new Map<string, string[]>();
  const ever = new Set<string>();
  for (const [code, rows] of series) {
    const tv = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
    for (let i = 1; i < rows.length; i++) {
      const d = rows[i].tradeDate;
      if (d < XBRL_BACKFILL_PIT_FROM || !meSet.has(d)) continue;
      if (rows[i - 1].marketCapEok >= XBRL_BACKFILL_UNIVERSE_MIN_CAP_EOK && tv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON) { members.set(d, [...(members.get(d) ?? []), code]); ever.add(code); }
    }
  }
  const codes = [...ever].sort();
  const corpMap = new Map<string, { corp: string; name: string }>();
  for (let i = 0; i < codes.length; i += XBRL_BACKFILL_DB_IN_CHUNK) {
    const chunk = codes.slice(i, i + XBRL_BACKFILL_DB_IN_CHUNK);
    const rs = await selectAll<{ corp_code: string; corp_name: string; stock_code: string | null }>(dbRead, "dart_corp_codes", (f, t) => supabaseAdmin.from("dart_corp_codes").select("corp_code, corp_name, stock_code").in("stock_code", chunk).range(f, t));
    for (const r of rs) if (r.stock_code && !corpMap.has(r.stock_code)) corpMap.set(r.stock_code, { corp: r.corp_code, name: r.corp_name });
  }
  const stockRows = new Map<string, Ann[]>();
  for (let i = 0; i < codes.length; i += XBRL_BACKFILL_DB_IN_CHUNK / 2) {
    const chunk = codes.slice(i, i + XBRL_BACKFILL_DB_IN_CHUNK / 2);
    const rs = await selectAll<{ stock_code: string; fiscal_year: number; rcept_date: string; net_income_parent: number | null; fs_div: string }>(dbRead, "stock_annual_fundamentals", (f, t) => supabaseAdmin.from("stock_annual_fundamentals").select("stock_code, fiscal_year, rcept_date, net_income_parent, fs_div").in("stock_code", chunk).range(f, t));
    for (const r of rs) stockRows.set(r.stock_code, [...(stockRows.get(r.stock_code) ?? []), { fy: r.fiscal_year, rcept: r.rcept_date, ni: r.net_income_parent === null ? null : Number(r.net_income_parent), fsDiv: r.fs_div, src: "stock" }]);
  }
  const xbrlAnn = new Map<string, Ann[]>();
  const xbrlStatus = new Map<string, Map<number, { status: string; ni: number | null }>>();
  const corpCodes = codes.filter((c) => corpMap.has(c)).map((c) => corpMap.get(c)!.corp);
  for (let i = 0; i < corpCodes.length; i += XBRL_BACKFILL_DB_IN_CHUNK / 2) {
    const chunk = corpCodes.slice(i, i + XBRL_BACKFILL_DB_IN_CHUNK / 2);
    const rs = await selectAll<{ stock_code: string; fiscal_year: number; rcept_dt: string | null; ni_parent: number | null; ni_basis: string | null; status: string }>(dbRead, "dart_xbrl_fundamentals", (f, t) => supabaseAdmin.from("dart_xbrl_fundamentals").select("stock_code, fiscal_year, rcept_dt, ni_parent, ni_basis, status").in("corp_code", chunk).range(f, t));
    for (const r of rs) {
      const m = xbrlStatus.get(r.stock_code) ?? new Map();
      m.set(r.fiscal_year, { status: r.status, ni: r.ni_parent === null ? null : Number(r.ni_parent) });
      xbrlStatus.set(r.stock_code, m);
      if (!r.rcept_dt) continue;
      xbrlAnn.set(r.stock_code, [...(xbrlAnn.get(r.stock_code) ?? []), { fy: r.fiscal_year, rcept: r.rcept_dt, ni: r.ni_parent === null ? null : Number(r.ni_parent), fsDiv: r.ni_basis === "cons" ? "CFS" : r.ni_basis === "sep" ? "OFS" : r.ni_basis, src: "xbrl" }]);
    }
  }
  return { series, lastTrade, dataEnd, monthEnds: [...meSet].sort(), members, codes, corpMap, stockRows, xbrlAnn, xbrlStatus, dbRead };
}

export const groupOf = (ctx: Ctx, code: string): string => { const c = ctx.corpMap.get(code); return !c ? "이름 불명(corp_code 없음)" : FIN_NAME_RE.test(c.name) ? "금융(이름 기준)" : "비금융"; };
export const expectedFy = (d: string): number => (Number(d.slice(5, 7)) >= 4 ? Number(d.slice(0, 4)) - 1 : Number(d.slice(0, 4)) - 2);

/** 종목별 연도 행: stock > fill > xbrl (같은 FY면 앞선 소스 우선), rcept 오름차순(동률은 FY 오름차순). */
export function buildAnnual(ctx: Ctx, fill: Map<string, Ann[]>): Map<string, Ann[]> {
  const annual = new Map<string, Ann[]>();
  for (const code of ctx.codes) {
    const byFy = new Map<number, Ann>();
    for (const a of ctx.xbrlAnn.get(code) ?? []) byFy.set(a.fy, a);
    for (const a of fill.get(code) ?? []) byFy.set(a.fy, a);
    for (const a of ctx.stockRows.get(code) ?? []) byFy.set(a.fy, a);
    annual.set(code, [...byFy.values()].sort((x, y) => (x.rcept === y.rcept ? x.fy - y.fy : x.rcept < y.rcept ? -1 : 1)));
  }
  return annual;
}

export function judge(ctx: Ctx, annual: Map<string, Ann[]>): MM[] {
  const mms: MM[] = [];
  for (const d of ctx.monthEnds) {
    if (d < SEG_FROM) continue;
    for (const code of ctx.members.get(d) ?? []) {
      const rows = ctx.series.get(code)!;
      const vis = (annual.get(code) ?? []).filter((a) => a.rcept <= d);
      let reason: Reason | null = null, missFy: number | null = null;
      const end = vis[vis.length - 1];
      if (!end) { reason = 1; missFy = expectedFy(d); }
      else {
        const start = vis.find((a) => a.fy === end.fy - PEG_GROWTH_LOOKBACK_YEARS);
        if (!start) { reason = 2; missFy = end.fy - PEG_GROWTH_LOOKBACK_YEARS; }
        else if (start.ni === null || end.ni === null) reason = 3;
        else {
          const sS = pickListedSharesOnOrBefore(rows, start.rcept, DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS), eS = pickListedSharesOnOrBefore(rows, end.rcept, DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS);
          if (sS === null || sS <= 0 || eS === null || eS <= 0) reason = 4;
          else if (start.fsDiv !== end.fsDiv) reason = 5;
          else {
            const e0 = start.ni / sS, e1 = end.ni / eS;
            if (e0 <= 0 || e1 <= 0) reason = 6;
            else if (Math.pow(e1 / e0, 1 / PEG_GROWTH_LOOKBACK_YEARS) - 1 <= 0) reason = 7;
          }
        }
      }
      mms.push({ code, date: d, seg: d >= BASE_FROM ? "base" : "ext", year: Number(d.slice(0, 4)), group: groupOf(ctx, code), reason, missFy });
    }
  }
  return mms;
}

/** stock_annual_fundamentals(+fill ok) 행 맵 — (b)/(c) 분류의 "기존 표에 행이 있음" 판정용. */
export function stockLike(ctx: Ctx, fill: Map<string, Ann[]>): Map<string, Ann[]> {
  const m = new Map<string, Ann[]>();
  for (const code of ctx.codes) {
    const rows = [...(ctx.stockRows.get(code) ?? []), ...(fill.get(code) ?? [])];
    if (rows.length) m.set(code, rows);
  }
  return m;
}

export interface Classified { stockCat: Map<string, "a" | "b" | "c">; drop: MM[]; isDelisted: (c: string) => boolean; sl: Map<string, Ann[]> }
export function classify(ctx: Ctx, mms: MM[], fill: Map<string, Ann[]>): Classified {
  const sl = stockLike(ctx, fill);
  const drop = mms.filter((m) => m.reason === 1 || m.reason === 2);
  const isDelisted = (code: string): boolean => ctx.lastTrade.get(code)! < ctx.dataEnd;
  const minFy = (code: string): number => Math.min(...(sl.get(code) ?? []).map((a) => a.fy), 9999);
  const bEvidence = (m: MM): boolean => {
    const y = m.missFy!;
    if (y <= 2014) return ctx.xbrlStatus.get(m.code)?.get(y)?.status === "no_report";
    return sl.has(m.code) && minFy(m.code) > y;
  };
  const byStock = new Map<string, MM[]>();
  for (const m of drop) byStock.set(m.code, [...(byStock.get(m.code) ?? []), m]);
  const stockCat = new Map<string, "a" | "b" | "c">();
  for (const [code, ms] of byStock) stockCat.set(code, isDelisted(code) ? "a" : ms.every(bEvidence) ? "b" : "c");
  return { stockCat, drop, isDelisted, sl };
}

export function printCoverage(pre: MM[], post: MM[]): void {
  console.log("\n=== 연도별 커버리지 (직전 정의 = 채움 전 / 채움 후), 구성원-월 기준 ===");
  console.log(`| 구간 | 연도 | 구분 | 월 수 | 구성원-월 | 월평균 | 채움 전 계산 가능 | 비율 | 채움 후 계산 가능 | 비율 | ${REASONS.map((r) => `후 ${r} ${REASON_NAME[r]}`).join(" | ")} |`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|${REASONS.map(() => "---").join("|")}|`);
  const groups = ["전체", "비금융", "금융(이름 기준)", "이름 불명(corp_code 없음)"];
  for (const seg of ["ext", "base"] as const) {
    const lab = seg === "ext" ? "2016-03~2021-02(확장)" : "2021-03 이후(기존 검증)";
    const years = [...new Set(post.filter((m) => m.seg === seg).map((m) => m.year))].sort();
    for (const y of [...years, 0]) {
      for (const g of groups) {
        const f = (m: MM): boolean => m.seg === seg && (y === 0 || m.year === y) && (g === "전체" || m.group === g);
        const a = post.filter(f), b = pre.filter(f);
        if (g !== "전체" && !a.length) continue;
        const months = new Set(a.map((m) => m.date)).size;
        const okA = a.filter((m) => m.reason === null).length, okB = b.filter((m) => m.reason === null).length;
        console.log(`| ${lab} | ${y === 0 ? "합계" : y} | ${g} | ${months} | ${a.length} | ${months ? (a.length / months).toFixed(1) : "-"} | ${okB} | ${pc(okB, b.length)} | ${okA} | ${pc(okA, a.length)} | ${REASONS.map((r) => a.filter((m) => m.reason === r).length).join(" | ")} |`);
      }
    }
  }
}

export function printClassification(ctx: Ctx, mms: MM[], cl: Classified, label: string): void {
  console.log(`\n=== 누락 종목 분류 (${label}) — end/start 행 없음 구성원-월 ${cl.drop.length}건, ${cl.stockCat.size}종목 ===`);
  console.log("| 분류 | 종목 수 | 구성원-월(end 없음) | 구성원-월(start 없음) | 합 |\n|---|---|---|---|---|");
  for (const [k, lab] of [["a", "(a) 이후 상장폐지·합병"], ["b", "(b) 보고서가 원래 없음"], ["c", "(c) 그 외 = 기존 표 미적재 후보"]] as const) {
    const cs = [...cl.stockCat.entries()].filter(([, v]) => v === k).map(([c]) => c);
    const ms = cl.drop.filter((m) => cl.stockCat.get(m.code) === k);
    console.log(`| ${lab} | ${cs.length} | ${ms.filter((m) => m.reason === 1).length} | ${ms.filter((m) => m.reason === 2).length} | ${ms.length} |`);
  }
  console.log(`| 합계 | ${cl.stockCat.size} | ${cl.drop.filter((m) => m.reason === 1).length} | ${cl.drop.filter((m) => m.reason === 2).length} | ${cl.drop.length} |`);
  const aStocks = [...cl.stockCat.entries()].filter(([, v]) => v === "a").map(([c]) => c);
  const lastFy = (c: string): number => { const l = ctx.lastTrade.get(c)!; return Number(l.slice(5, 7)) >= 4 ? Number(l.slice(0, 4)) - 1 : Number(l.slice(0, 4)) - 2; };
  const covered = aStocks.filter((c) => lastFy(c) >= 2015 && Math.max(...(cl.sl.get(c) ?? []).map((a) => a.fy), 0) >= lastFy(c));
  const not = aStocks.filter((c) => lastFy(c) >= 2015 && !covered.includes(c));
  console.log(`(a) ${aStocks.length}개 중 기존 표(stock_annual_fundamentals${label.includes("후") ? " + fill ok" : ""})에 마지막 상장 연도까지의 행이 있는 종목 ${covered.length}개 / 없는 종목 ${not.length}개 / 해당 없음 ${aStocks.length - covered.length - not.length}개`);
  const cStocks = [...cl.stockCat.entries()].filter(([, v]) => v === "c").map(([c]) => c);
  console.log(`(c) ${cStocks.length}개 (corp_code 없음 ${cStocks.filter((c) => !ctx.corpMap.has(c)).length}개, 기존 표+fill에 행이 전혀 없는 종목 ${cStocks.filter((c) => !cl.sl.has(c)).length}개)`);
  void mms;
}

export function printSurvival(ctx: Ctx, mms: MM[], annual: Map<string, Ann[]>, label: string): void {
  console.log(`\n=== 생존편향 점검 (${label}) ===`);
  const isDel = (c: string): boolean => ctx.lastTrade.get(c)! < ctx.dataEnd;
  for (const seg of ["base", "ext"] as const) {
    const sm = mms.filter((m) => m.seg === seg);
    const okm = sm.filter((m) => m.reason === null);
    const delOk = okm.filter((m) => isDel(m.code));
    console.log(`\n[${seg === "base" ? "2021-03 이후(기존 검증 구간)" : "2016-03~2021-02(확장 구간)"}] 계산 가능 구성원-월 ${okm.length}건 중 이후 상장폐지·합병 종목 ${delOk.length}건 (${pc(delOk.length, okm.length)}); 전체 구성원-월 ${sm.length}건 중 상장폐지 종목 ${sm.filter((m) => isDel(m.code)).length}건 (${pc(sm.filter((m) => isDel(m.code)).length, sm.length)})`);
    const stocksIn = [...new Set(sm.map((m) => m.code))];
    const hasRow = (c: string): boolean => (annual.get(c) ?? []).some((a) => a.ni !== null);
    console.log("| 구분 | 구성원 종목 수 | 순이익 있는 재무 행 보유 종목 | 보유 비율 | 구성원-월 | 계산 가능 | 계산 가능 비율 | end 행 없음 월 비율 |\n|---|---|---|---|---|---|---|---|");
    for (const [l, f] of [["상장폐지·합병", (c: string) => isDel(c)], ["생존", (c: string) => !isDel(c)]] as [string, (c: string) => boolean][]) {
      const ss = stocksIn.filter(f), ms = sm.filter((m) => f(m.code));
      console.log(`| ${l} | ${ss.length} | ${ss.filter(hasRow).length} | ${pc(ss.filter(hasRow).length, ss.length)} | ${ms.length} | ${ms.filter((m) => m.reason === null).length} | ${pc(ms.filter((m) => m.reason === null).length, ms.length)} | ${pc(ms.filter((m) => m.reason === 1).length, ms.length)} |`);
    }
  }
}

/** start 없음(사유 2) 구성원-월을 start 회계연도의 소스 상태별로 센다. */
export function printStartMiss(ctx: Ctx, mms: MM[], fillStatus: Map<string, Map<number, string>>): void {
  console.log("\n=== start 없음 구성원-월의 start 회계연도 상태 ===");
  const r2 = mms.filter((m) => m.reason === 2);
  const lo = new Map<string, number>(), hi = new Map<string, number>();
  for (const m of r2) {
    const y = m.missFy!;
    if (y <= 2014) {
      const s = ctx.xbrlStatus.get(m.code)?.get(y);
      const k = !s ? "XBRL 표에 해당 키 없음(대상 아님·3월 결산 제외·corp_code 없음)" : s.status === "ok" && s.ni === null ? "ok인데 ni null" : s.status;
      lo.set(k, (lo.get(k) ?? 0) + 1);
    } else {
      const s = fillStatus.get(m.code)?.get(y);
      const k = !s ? "fill 표에 해당 키 없음(대상 아님·채우지 않음)" : s;
      hi.set(k, (hi.get(k) ?? 0) + 1);
    }
  }
  console.log(`start 없음 ${r2.length}건 = start FY≤2014 ${[...lo.values()].reduce((a, b) => a + b, 0)}건 + start FY≥2015 ${[...hi.values()].reduce((a, b) => a + b, 0)}건`);
  console.log("| start FY | 상태 | 구성원-월 |\n|---|---|---|");
  for (const [k, v] of [...lo.entries()].sort((a, b) => b[1] - a[1])) console.log(`| ≤FY2014 (dart_xbrl_fundamentals) | ${k} | ${v} |`);
  for (const [k, v] of [...hi.entries()].sort((a, b) => b[1] - a[1])) console.log(`| ≥FY2015 (fill 표) | ${k} | ${v} |`);
}

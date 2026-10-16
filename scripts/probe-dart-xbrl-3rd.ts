/**
 * [임시 점검 — 병합 금지, 읽기 전용, 저장 없음] DART XBRL 3차 점검: 추출 실패 진단 + 개선 규칙 재측정 + 교차 검증 + 금융업 참고.
 * 외부 요청은 DART만 총 130건 이하. DB는 REST로 dart_corp_codes만 읽는다. 숫자와 사실만 출력한다.
 * 추출 규칙은 실행 전에 고정했다(결과를 보고 바꾸지 않는다):
 *  - 컨텍스트 우선순위: 연결(ConsolidatedMember) > 차원 없음 > 별도(SeparateMember), 당기(보고서 회계연도 말과 정확히 일치하는 기간/기말)만 선택.
 *  - 각 컨텍스트 순위 안에서 태그 우선순위(원본 태그 → 폴백 태그). 컨텍스트가 먼저, 태그가 다음.
 */
import AdmZip from "adm-zip";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { parseFundamentalsList, type DartAccountRow } from "@/lib/dartFundamentalsParse";

// ---- 점검 상수 ----
const REQUEST_BUDGET = 130;
const DART_BASE_URL = "https://opendart.fss.or.kr/api";
const SAMPLE_CODES = ["005830", "016360", "000810", "052690", "130960", "001430", "001040", "004020", "105630", "079160", "085620", "068870", "082640", "112040", "170900", "048260", "020000", "053800", "015750", "003240", "003540", "192530", "000370", "108320", "083790", "032190", "005880", "029530", "023160", "038500"];
const PREV_NOT_FOUND = new Set(["005830-2011", "016360-2011", "000810-2011", "085620-2011", "082640-2011", "170900-2011", "003540-2011", "192530-2011", "000370-2011"]);
const SAMPLE_SEED = 20261016;
const SAMPLE_PER_TERCILE = 10;
const SAMPLE_FIN_PER_TERCILE = 3;
const B_FYS = [2011, 2014];
const B_LIST_RANGE = ["20120101", "20151231"] as const;
const X_STOCKS = ["005930", "000660", "035420"];
const X_FYS = [2015, 2016];
const X_LIST_RANGE = ["20160101", "20171231"] as const;
const FIN_CHECK_FYS = [2011, 2013, 2014];
const FIN_CHECK_N = 3;
const PIT_FROM = "2010-01-01";
const PIT_TO = "2016-12-31";
const CAP_EOK = 5000;
const DB_IN_CHUNK = 200;
const TOP_AGG = 30;
const FIN_NAME_RE = /(은행|금융|증권|보험|화재|생명|카드|캐피탈|저축|손해|해상|재보험)/;
const MS_DAY = 86_400_000;

let used = 0;
const reqLog: string[] = [];
interface Ext { status: number; ms: number; buf: Buffer }
async function ext(label: string, url: string): Promise<Ext | null> {
  if (used >= REQUEST_BUDGET) { console.log(`[요청 한도 도달] ${label} 생략`); return null; }
  used++;
  const t0 = Date.now();
  try {
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    reqLog.push(`#${used} ${label} | HTTP ${res.status} | ${buf.length} B | ${Date.now() - t0} ms`);
    return { status: res.status, ms: Date.now() - t0, buf };
  } catch (e) {
    reqLog.push(`#${used} ${label} | 요청 실패: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
const isZip = (b: Buffer): boolean => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b;
const parseJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };
const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;
function mulberry32(a: number): () => number {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---- XBRL 파서 (넓은 필터) ----
const BROAD = /(Profit|Income|Equity|EarningsPerShare|EarningsLossPerShare)/i;
export type Item = "NI" | "EQ" | "EPS";
const ITEMS: Item[] = ["NI", "EQ", "EPS"];
const ITEM_NAME: Record<Item, string> = { NI: "당기순이익(지배)", EQ: "자본총계(지배)", EPS: "기본주당이익" };
const DURATION: Record<Item, boolean> = { NI: true, EQ: false, EPS: true };
export interface RFact { local: string; tag: string; end: string; start?: string; dims: string[]; unit: string; decimals: string; value: string }
export interface Inst { prefixes: string[]; ifrs: boolean; facts: RFact[]; instance: string | null }

export function parseInst(buf: Buffer): Inst | { error: string } {
  let zip: AdmZip;
  try { zip = new AdmZip(buf); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  const inst = zip.getEntries().find((e) => /\.xbrl$/i.test(e.entryName));
  if (!inst) return { prefixes: [], ifrs: false, facts: [], instance: null };
  const xml = inst.getData().toString("utf-8");
  const prefixes = [...new Set([...xml.matchAll(/xmlns:([\w-]+)=/g)].map((m) => m[1]))];
  const ctxs = new Map<string, { start?: string; end: string; dims: string[] }>();
  for (const m of xml.matchAll(/<(?:\w+:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?context>/g)) {
    const b = m[2];
    const instant = /<(?:\w+:)?instant>([^<]+)</.exec(b)?.[1];
    const s = /<(?:\w+:)?startDate>([^<]+)</.exec(b)?.[1], e = /<(?:\w+:)?endDate>([^<]+)</.exec(b)?.[1];
    const dims = [...b.matchAll(/<(?:\w+:)?(explicitMember|typedMember)\b[^>]*dimension="([^"]+)"[^>]*>([^<]*)/g)].map((d) => `${d[2]}=${d[3].trim() || d[1]}`);
    ctxs.set(m[1], { start: instant ? undefined : s, end: instant ?? e ?? "?", dims });
  }
  const facts: RFact[] = [];
  for (const m of xml.matchAll(/<([\w.-]+):([\w.-]+)\b([^>]*\bcontextRef="([^"]+)"[^>]*)>([^<]*)</g)) {
    if (!BROAD.test(m[2])) continue;
    const c = ctxs.get(m[4]);
    if (!c) continue;
    facts.push({ local: m[2], tag: `${m[1]}:${m[2]}`, end: c.end, start: c.start, dims: c.dims, unit: /unitRef="([^"]+)"/.exec(m[3])?.[1] ?? "-", decimals: /decimals="([^"]+)"/.exec(m[3])?.[1] ?? "-", value: m[5].trim() });
  }
  return { prefixes, ifrs: prefixes.some((p) => /^ifrs(-full)?$/i.test(p)), facts, instance: inst.entryName };
}

type CtxKind = "연결" | "없음" | "별도" | "기타 차원";
export function ctxKind(dims: string[]): CtxKind {
  if (dims.length === 0) return "없음";
  const axisOk = dims.every((x) => /ConsolidatedAndSeparate/i.test(x.split("=")[0]));
  if (axisOk && dims.every((x) => /Consolidated/i.test(x.split("=")[1]) && !/Separate/i.test(x.split("=")[1]))) return "연결";
  if (axisOk && dims.every((x) => /Separate/i.test(x.split("=")[1]))) return "별도";
  return "기타 차원";
}
const periodKind = (f: RFact): string => (f.start ? "기간" : "시점");

// ---- 직전 규칙(2차 점검과 동일) — 실패 진단용 ----
const OLD_RE: Record<Item, RegExp> = {
  NI: /^(ProfitLossAttributableToOwnersOfParent|NetIncomeAttributableToOwnersOfParent)$/i,
  EQ: /^(EquityAttributableToOwnersOfParent)$/i,
  EPS: /^(BasicEarningsLossPerShare|BasicEarningsPerShare|BasicAndDilutedEarningsLossPerShare)$/i,
};
const oldConsOnly = (d: string[]): boolean => d.length > 0 && d.every((x) => /ConsolidatedAndSeparate/i.test(x.split("=")[0])) && d.every((x) => /Consolidated/i.test(x.split("=")[1]) && !/Separate/i.test(x.split("=")[1]));
function oldPrimary(facts: RFact[], item: Item): RFact | null {
  const all = facts.filter((f) => OLD_RE[item].test(f.local) && (!DURATION[item] || (f.start && dayDiff(f.start, f.end) > 300)));
  const ends = [...new Set(all.map((f) => f.end))].sort().reverse();
  if (!ends.length) return null;
  const at = all.filter((f) => f.end === ends[0]);
  return at.find((f) => oldConsOnly(f.dims)) ?? at.find((f) => f.dims.length === 0) ?? null;
}
export type FailReason = "태그 없음" | "태그는 있는데 차원이 달라서" | "기간이 안 맞아서" | "기타";
function oldFailReason(facts: RFact[], item: Item): FailReason | null {
  if (oldPrimary(facts, item)) return null;
  const tagged = facts.filter((f) => OLD_RE[item].test(f.local));
  if (!tagged.length) return "태그 없음";
  const valid = tagged.filter((f) => !DURATION[item] || (f.start && dayDiff(f.start, f.end) > 300));
  if (!valid.length) return "기간이 안 맞아서";
  if (valid.some((f) => oldConsOnly(f.dims) || f.dims.length === 0)) return "기간이 안 맞아서";
  return "태그는 있는데 차원이 달라서";
}

// ---- 새 규칙(고정) ----
const CHAINS: Record<Item, ((local: string) => boolean)[]> = {
  NI: [(l) => l === "ProfitLossAttributableToOwnersOfParent", (l) => l === "ProfitLoss"],
  EQ: [(l) => l === "EquityAttributableToOwnersOfParent", (l) => l === "Equity"],
  EPS: [(l) => l === "BasicEarningsLossPerShare", (l) => l === "BasicAndDilutedEarningsLossPerShare", (l) => /^Basic(?!.*Diluted).*EarningsLossPerShare$/i.test(l)],
};
const KIND_ORDER: CtxKind[] = ["연결", "없음", "별도"];
export interface Pick { fact: RFact; kind: CtxKind; fallback: boolean; chainIdx: number }
export function newPick(facts: RFact[], item: Item, end: string): Pick | null {
  const valid = facts.filter((f) => f.end === end && (!DURATION[item] || (f.start && dayDiff(f.start, f.end) > 300)));
  for (const kind of KIND_ORDER) {
    for (let ci = 0; ci < CHAINS[item].length; ci++) {
      const f = valid.find((x) => ctxKind(x.dims) === kind && CHAINS[item][ci](x.local));
      if (f) return { fact: f, kind, fallback: ci > 0, chainIdx: ci };
    }
  }
  return null;
}
const lastDayOfMonth = (y: number, m: number): string => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
const prevYear = (d: string): string => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;

// ---- DART ----
interface Filing { report_nm: string; rcept_no: string; rcept_dt: string }
const periodOf = (nm: string): { y: number; m: number } | null => { const m = /\((\d{4})\.(\d{2})\)/.exec(nm); return m ? { y: Number(m[1]), m: Number(m[2]) } : null; };
interface FyPick { original: Filing | null; latest: Filing | null; all: Filing[] }
function pickFy(filings: Filing[], fy: number): FyPick {
  const fs = filings.filter((f) => /사업보고서/.test(f.report_nm) && periodOf(f.report_nm)?.y === fy).sort((a, b) => (a.rcept_no < b.rcept_no ? -1 : 1));
  const plain = fs.filter((f) => !/^\[/.test(f.report_nm));
  return { original: plain[0] ?? fs[0] ?? null, latest: fs[fs.length - 1] ?? null, all: fs };
}
async function dartList(key: string, corp: string, label: string, range: readonly [string, string]): Promise<{ rows: Filing[]; total: number | null; pages: number } | null> {
  const rows: Filing[] = [];
  let total: number | null = null, pages = 1;
  for (let page = 1; page <= pages; page++) {
    const r = await ext(`list ${label} p${page}`, `${DART_BASE_URL}/list.json?crtfc_key=${key}&corp_code=${corp}&bgn_de=${range[0]}&end_de=${range[1]}&pblntf_ty=A&page_no=${page}&page_count=100`);
    if (!r) return rows.length ? { rows, total, pages } : null;
    const j = parseJson(r.buf.toString("utf-8")) as { status?: string; list?: Filing[]; total_count?: number; total_page?: number } | null;
    rows.push(...(j?.list ?? []));
    total = j?.total_count ?? total;
    pages = j?.total_page ?? 1;
  }
  return { rows, total, pages };
}
type XStat = { kind: "있음"; inst: Inst; bytes: number } | { kind: "014" | "기타" | "요청 안 됨"; note: string };
async function fetchXbrl(key: string, label: string, rcept: string): Promise<XStat> {
  const r = await ext(`xbrl ${label}`, `${DART_BASE_URL}/fnlttXbrl.xml?crtfc_key=${key}&rcept_no=${rcept}&reprt_code=11011`);
  if (!r) return { kind: "요청 안 됨", note: "요청 실패/한도" };
  if (!isZip(r.buf)) {
    const txt = r.buf.toString("utf-8");
    const st = /<status>([^<]*)</.exec(txt)?.[1] ?? "-", msg = /<message>([^<]*)</.exec(txt)?.[1] ?? txt.slice(0, 40);
    return st === "014" ? { kind: "014", note: msg } : { kind: "기타", note: `HTTP ${r.status} status ${st} ${msg}` };
  }
  const p = parseInst(r.buf);
  if ("error" in p) return { kind: "기타", note: `zip 해석 실패 ${p.error}` };
  return { kind: "있음", inst: p, bytes: r.buf.length };
}
const num = (s: string | undefined): number => (s === undefined || s === "" ? NaN : Number(s));
const fmt = (n: number): string => (Number.isFinite(n) ? n.toLocaleString("en-US") : "-");

export interface Deps {
  dartKey: string;
  series: Map<string, StockDailyPriceRow[]>;
  dbCorp: (codes: string[]) => Promise<{ rows: number; map: Map<string, { corp_code: string; corp_name: string }> }>;
}

interface RowRes {
  code: string; name: string; fin: boolean; fy: number; prevNotFound: boolean;
  pick: FyPick; x: XStat | null; end: string | null;
  ni: Pick | null; eq: Pick | null; eps: Pick | null; niPrior: Pick | null; eqPrior: Pick | null;
  old: Record<Item, FailReason | null>;
}

export async function runProbe(d: Deps): Promise<void> {
  // ---- PIT 유니버스 + 표본 재현 확인 ----
  const dates = new Set<string>();
  for (const rows of d.series.values()) for (const r of rows) if (r.tradeDate >= PIT_FROM && r.tradeDate <= PIT_TO) dates.add(r.tradeDate);
  const cal = [...dates].sort();
  const monthEnds = new Set<string>();
  for (let k = 0; k + 1 < cal.length; k++) if (cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7)) monthEnds.add(cal[k]);
  const pit = new Map<string, number>();
  for (const [code, rows] of d.series) {
    const tv = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
    let peak = 0, ever = false;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].tradeDate < PIT_FROM || rows[i].tradeDate > PIT_TO) continue;
      if (rows[i].marketCapEok > peak) peak = rows[i].marketCapEok;
      if (i >= 1 && monthEnds.has(rows[i].tradeDate) && rows[i - 1].marketCapEok >= CAP_EOK && tv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON) ever = true;
    }
    if (ever) pit.set(code, peak);
  }
  const need = [...new Set([...pit.keys(), ...SAMPLE_CODES, ...X_STOCKS])];
  const corp = await d.dbCorp(need);
  const pitWith = [...pit.keys()].filter((c) => corp.map.has(c));
  console.log(`월말 PIT 유니버스 고유 종목 ${pit.size}개, corp_code 있음 ${pitWith.length}개`);
  console.log(`DB 읽은 행: dart_corp_codes ${corp.rows}행 (종목코드 ${need.length}개 IN 조회)`);
  {
    const ranked = pitWith.map((c) => ({ code: c, peak: pit.get(c)!, name: corp.map.get(c)!.corp_name })).sort((a, b) => b.peak - a.peak || (a.code < b.code ? -1 : 1));
    const third = Math.ceil(ranked.length / 3);
    const rng = mulberry32(SAMPLE_SEED);
    const shuffle = <T,>(a: T[]): T[] => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
    const redo: string[] = [];
    [ranked.slice(0, third), ranked.slice(third, 2 * third), ranked.slice(2 * third)].forEach((tr) => {
      const fin = shuffle(tr.filter((x) => FIN_NAME_RE.test(x.name))), non = shuffle(tr.filter((x) => !FIN_NAME_RE.test(x.name)));
      const nf = Math.min(SAMPLE_FIN_PER_TERCILE, fin.length);
      redo.push(...[...fin.slice(0, nf), ...non.slice(0, SAMPLE_PER_TERCILE - nf)].map((x) => x.code));
    });
    console.log(`표본 재현(시드 ${SAMPLE_SEED}): 직전 30종목과 ${redo.length === SAMPLE_CODES.length && redo.every((c, i) => c === SAMPLE_CODES[i]) ? "일치" : "불일치"} (처리에는 직전 30종목 코드를 그대로 사용)`);
  }

  // ---- 공시검색 + XBRL (표본 30 × FY2011·FY2014, 원본 rcept_no 기준) ----
  const rows: RowRes[] = [];
  const noReportDiag: string[] = [];
  for (const code of SAMPLE_CODES) {
    const c = corp.map.get(code);
    if (!c) { console.log(`${code}: corp_code 없음`); continue; }
    const l = await dartList(d.dartKey, c.corp_code, `${code} (B)`, B_LIST_RANGE);
    for (const fy of B_FYS) {
      const pick = pickFy(l?.rows ?? [], fy);
      if (!pick.original) {
        const nms = (l?.rows ?? []).filter((x) => /사업|연차|결산/.test(x.report_nm)).map((x) => `${x.report_nm}/${x.rcept_dt}`);
        noReportDiag.push(`${code} FY${fy}: list ${l?.rows.length ?? 0}건/total_count ${l?.total ?? "-"}/페이지 ${l?.pages ?? "-"} | '사업·연차·결산' 포함 보고서명: ${nms.join("; ") || "(없음)"}`);
      }
      rows.push({ code, name: c.corp_name, fin: FIN_NAME_RE.test(c.corp_name), fy, prevNotFound: PREV_NOT_FOUND.has(`${code}-${fy}`), pick, x: null, end: null, ni: null, eq: null, eps: null, niPrior: null, eqPrior: null, old: { NI: null, EQ: null, EPS: null } });
    }
  }
  for (const r of rows) {
    if (!r.pick.original) continue;
    const per = periodOf(r.pick.original.report_nm)!;
    r.end = lastDayOfMonth(per.y, per.m);
    r.x = await fetchXbrl(d.dartKey, `${r.code} FY${r.fy}`, r.pick.original.rcept_no);
    if (r.x.kind === "있음") {
      const f = r.x.inst.facts;
      r.ni = newPick(f, "NI", r.end); r.eq = newPick(f, "EQ", r.end); r.eps = newPick(f, "EPS", r.end);
      r.niPrior = newPick(f, "NI", prevYear(r.end)); r.eqPrior = newPick(f, "EQ", prevYear(r.end));
      for (const it of ITEMS) r.old[it] = oldFailReason(f, it);
    }
  }

  // ---- 1. 실패 원인 진단 ----
  const failed = rows.filter((r) => r.x?.kind === "있음" && ITEMS.some((it) => r.old[it]));
  console.log(`\n=== 1. 실패 원인 진단 (직전 규칙으로 NI·자본·EPS 중 하나라도 못 뽑은 XBRL 보고서 ${failed.length}건 / XBRL 있음 ${rows.filter((r) => r.x?.kind === "있음").length}건) ===`);
  const agg = new Map<string, { n: number; reports: Set<string> }>();
  for (const r of failed) {
    if (r.x?.kind !== "있음") continue;
    for (const f of r.x.inst.facts) {
      const key = `${f.tag} | ${f.dims.length ? [...f.dims].sort().join(" & ") : "차원 없음"} | ${periodKind(f)} | ${f.unit}`;
      const a = agg.get(key) ?? { n: 0, reports: new Set<string>() };
      a.n++; a.reports.add(`${r.code}-${r.fy}`);
      agg.set(key, a);
    }
  }
  console.log(`태그(Profit·Income·Equity·EarningsPerShare 포함) × 차원 × 기간 종류 × 단위 조합 ${agg.size}개 중 상위 ${TOP_AGG} (사실 건수 / 해당 보고서 수):`);
  console.log("| # | 태그 | 차원(축=멤버) | 기간 종류 | 단위 | 사실 건수 | 보고서 수 |");
  console.log("|---|---|---|---|---|---|---|");
  [...agg.entries()].sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1)).slice(0, TOP_AGG).forEach(([k, v], i) => {
    const [tag, dim, pk, unit] = k.split(" | ");
    console.log(`| ${i + 1} | ${tag} | ${dim} | ${pk} | ${unit} | ${v.n} | ${v.reports.size} |`);
  });
  console.log("\n종목·연도별 실패 사유 (직전 규칙 기준):");
  for (const r of failed) {
    const parts = ITEMS.filter((it) => r.old[it]).map((it) => `${ITEM_NAME[it]}=${r.old[it]}`);
    console.log(`- ${r.code} ${r.name} FY${r.fy}: ${parts.join(", ")}`);
  }
  const reasonCnt = new Map<string, number>();
  for (const r of failed) for (const it of ITEMS) if (r.old[it]) reasonCnt.set(`${ITEM_NAME[it]}: ${r.old[it]}`, (reasonCnt.get(`${ITEM_NAME[it]}: ${r.old[it]}`) ?? 0) + 1);
  console.log(`사유 집계: ${[...reasonCnt.entries()].sort().map(([k, v]) => `${k} ${v}건`).join(" | ")}`);

  // ---- 3. 재측정 ----
  console.log(`\n=== 3. 개선 규칙 재측정 (같은 30종목 × FY2011·FY2014, 원본 rcept_no, list.json page_count=100 + 추가 페이지) ===`);
  console.log("직전 '보고서 없음' 9건: " + [...PREV_NOT_FOUND].map((k) => { const r = rows.find((x) => `${x.code}-${x.fy}` === k); return `${k}→${r?.pick.original ? `이번엔 있음(${r.pick.original.rcept_no})` : "이번에도 없음"}`; }).join(", "));
  if (noReportDiag.length) { console.log("보고서를 찾지 못한 건의 목록 진단:"); for (const l of noReportDiag) console.log(`  ${l}`); }
  const tg = (p: Pick | null): string => (p ? `${fmt(num(p.fact.value))} [${p.kind}/${p.fact.local}${p.fallback ? "(폴백)" : ""}]` : "-");
  console.log("\n| 종목 | 구분 | FY | 직전 없음 | rcept_no | XBRL | NI(지배) 당기 [컨텍스트/태그] | 자본(지배) 당기 | EPS 당기 | NI 전기(기록) | 자본 전기(기록) | 3개 모두 |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const all3 = !!(r.ni && r.eq && r.eps);
    console.log(`| ${r.code} ${r.name} | ${r.fin ? "금융" : "비금융"} | FY${r.fy} | ${r.prevNotFound ? "예" : ""} | ${r.pick.original?.rcept_no ?? "-"} | ${r.x ? (r.x.kind === "있음" ? "있음" : r.x.kind === "014" ? "status 014" : r.x.kind) : "보고서 없음"} | ${tg(r.ni)} | ${tg(r.eq)} | ${tg(r.eps)} | ${r.niPrior ? fmt(num(r.niPrior.fact.value)) : "-"} | ${r.eqPrior ? fmt(num(r.eqPrior.fact.value)) : "-"} | ${all3 ? "O" : "X"} |`);
  }
  const pc = (a: number, b: number): string => (b ? ((a / b) * 100).toFixed(1) + "%" : "-");
  console.log("\n집계 (XBRL 있음 보고서 중 NI·자본·EPS 3개 모두 추출)");
  console.log("| FY | 구분 | XBRL 있음 | 3개 모두 | 비율 | NI 추출 | 자본 추출 | EPS 추출 |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const fy of B_FYS) {
    for (const [lab, filt] of [["전체", () => true], ["금융(이름 기준)", (r: RowRes) => r.fin], ["비금융", (r: RowRes) => !r.fin]] as [string, (r: RowRes) => boolean][]) {
      const xs = rows.filter((r) => r.fy === fy && filt(r) && r.x?.kind === "있음");
      console.log(`| FY${fy} | ${lab} | ${xs.length} | ${xs.filter((r) => r.ni && r.eq && r.eps).length} | ${pc(xs.filter((r) => r.ni && r.eq && r.eps).length, xs.length)} | ${xs.filter((r) => r.ni).length} | ${xs.filter((r) => r.eq).length} | ${xs.filter((r) => r.eps).length} |`);
    }
  }
  const xs = rows.filter((r) => r.x?.kind === "있음");
  console.log("\n선택된 태그·컨텍스트 집계 (XBRL 있음 보고서):");
  console.log("| 항목 | 연결 | 차원 없음 | 별도 | 추출 못함 | 원본 태그 | 폴백 태그 |");
  console.log("|---|---|---|---|---|---|---|");
  for (const it of ITEMS) {
    const ps = xs.map((r) => (it === "NI" ? r.ni : it === "EQ" ? r.eq : r.eps));
    console.log(`| ${ITEM_NAME[it]} | ${ps.filter((p) => p?.kind === "연결").length} | ${ps.filter((p) => p?.kind === "없음").length} | ${ps.filter((p) => p?.kind === "별도").length} | ${ps.filter((p) => !p).length} | ${ps.filter((p) => p && !p.fallback).length} | ${ps.filter((p) => p?.fallback).length} |`);
  }
  const fbTags = new Map<string, number>();
  for (const r of xs) for (const p of [r.ni, r.eq, r.eps]) if (p?.fallback) fbTags.set(p.fact.local, (fbTags.get(p.fact.local) ?? 0) + 1);
  console.log(`폴백으로 사용된 태그별 건수: ${[...fbTags.entries()].map(([k, v]) => `${k} ${v}`).join(" | ") || "(없음)"}`);
  const fbReports = xs.filter((r) => [r.ni, r.eq, r.eps].some((p) => p?.fallback));
  const fbAll3 = fbReports.filter((r) => r.ni && r.eq && r.eps);
  const sane = fbAll3.filter((r) => num(r.eq!.fact.value) > 0 && Math.sign(num(r.eps!.fact.value)) === Math.sign(num(r.ni!.fact.value)));
  console.log(`폴백 태그를 하나라도 쓴 보고서 ${fbReports.length}건 중 3개 모두 추출 ${fbAll3.length}건, 그중 sanity(자본>0 그리고 EPS 부호=NI 부호) 통과 ${sane.length}건 / 위반 ${fbAll3.length - sane.length}건`);
  const allAll3 = xs.filter((r) => r.ni && r.eq && r.eps);
  const saneAll = allAll3.filter((r) => num(r.eq!.fact.value) > 0 && Math.sign(num(r.eps!.fact.value)) === Math.sign(num(r.ni!.fact.value)));
  console.log(`(참고) 3개 모두 추출된 ${allAll3.length}건 전체의 sanity 통과 ${saneAll.length}건 / 위반 ${allAll3.length - saneAll.length}건`);

  // ---- 4. 교차 검증 ----
  console.log(`\n=== 4. 교차 검증: 새 규칙 XBRL vs fnlttSinglAcntAll(CFS) ===`);
  console.log("| 종목 | FY | rcept_no(XBRL) | NI XBRL | NI singl | NI 일치 | 자본 XBRL | 자본 singl | 자본 일치 | 선택 컨텍스트/태그(NI, 자본) |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  for (const code of X_STOCKS) {
    const c = corp.map.get(code);
    if (!c) { console.log(`| ${code} | corp_code 없음 | | | | | | | | |`); continue; }
    const l = await dartList(d.dartKey, c.corp_code, `${code} (X)`, X_LIST_RANGE);
    for (const fy of X_FYS) {
      const pick = pickFy(l?.rows ?? [], fy);
      let ni: Pick | null = null, eq: Pick | null = null, rc = "-";
      if (pick.original) {
        rc = pick.original.rcept_no;
        const x = await fetchXbrl(d.dartKey, `${code} FY${fy} (X)`, rc);
        if (x.kind === "있음") { const per = periodOf(pick.original.report_nm)!; const end = lastDayOfMonth(per.y, per.m); ni = newPick(x.inst.facts, "NI", end); eq = newPick(x.inst.facts, "EQ", end); }
        else console.log(`  ${code} FY${fy}: XBRL ${x.kind} ${"note" in x ? x.note : ""}`);
      }
      let sNi: number | null = null, sEq: number | null = null;
      const r = await ext(`singl ${code} FY${fy}`, `${DART_BASE_URL}/fnlttSinglAcntAll.json?crtfc_key=${d.dartKey}&corp_code=${c.corp_code}&bsns_year=${fy}&reprt_code=11011&fs_div=CFS`);
      const j = r ? (parseJson(r.buf.toString("utf-8")) as { status?: string; list?: DartAccountRow[] } | null) : null;
      if (j?.status === "000" && j.list?.length) { const pf = parseFundamentalsList(j.list); sNi = pf.netIncomeParent; sEq = pf.equityParent; }
      const xn = ni ? num(ni.fact.value) : NaN, xe = eq ? num(eq.fact.value) : NaN;
      const cmp = (a: number, b: number | null): string => (!Number.isFinite(a) || b === null ? "비교 불가" : a === b ? "같음" : `다름(차이 ${fmt(a - b)})`);
      console.log(`| ${code} | FY${fy} | ${rc} | ${fmt(xn)} | ${sNi ?? "-"} | ${cmp(xn, sNi)} | ${fmt(xe)} | ${sEq ?? "-"} | ${cmp(xe, sEq)} | ${ni ? `${ni.kind}/${ni.fact.local}` : "-"}, ${eq ? `${eq.kind}/${eq.fact.local}` : "-"} |`);
    }
  }

  // ---- 5. 금융업 참고 ----
  console.log(`\n=== 5. 금융 표본 중 FY2014 XBRL status 014인 종목: fnlttSinglAcntAll(CFS) 응답 ===`);
  const finTargets = rows.filter((r) => r.fin && r.fy === 2014 && r.x?.kind === "014").slice(0, FIN_CHECK_N);
  console.log("| 종목 | FY | HTTP | DART status | message | 계정 행 수 | NI(지배) 파싱 | 자본(지배) 파싱 |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const t of finTargets) {
    const c = corp.map.get(t.code)!;
    for (const fy of FIN_CHECK_FYS) {
      const r = await ext(`singl ${t.code} FY${fy} (금융)`, `${DART_BASE_URL}/fnlttSinglAcntAll.json?crtfc_key=${d.dartKey}&corp_code=${c.corp_code}&bsns_year=${fy}&reprt_code=11011&fs_div=CFS`);
      if (!r) { console.log(`| ${t.code} ${t.name} | FY${fy} | 요청 실패/한도 | - | - | - | - | - |`); continue; }
      const j = parseJson(r.buf.toString("utf-8")) as { status?: string; message?: string; list?: DartAccountRow[] } | null;
      let niS = "-", eqS = "-";
      if (j?.status === "000" && j.list?.length) { const pf = parseFundamentalsList(j.list); niS = String(pf.netIncomeParent ?? "null"); eqS = String(pf.equityParent ?? "null"); }
      console.log(`| ${t.code} ${t.name} | FY${fy} | ${r.status} | ${j?.status ?? "-"} | ${j?.message ?? "-"} | ${j?.list?.length ?? 0} | ${niS} | ${eqS} |`);
    }
  }
  if (!finTargets.length) console.log("| (FY2014 status 014인 금융 표본 없음) | | | | | | | |");

  console.log(`\nDART 외부 요청 사용: ${used}/${REQUEST_BUDGET}건`);
  console.log("요청 로그:");
  for (const l of reqLog) console.log(`  ${l}`);
  console.log("\n완료");
}

async function main(): Promise<void> {
  const dartKey = process.env.DART_API_KEY;
  if (!dartKey) throw new Error("DART_API_KEY 환경변수가 필요합니다.");
  console.log(`DART XBRL 3차 점검 시작(읽기 전용): ${new Date().toISOString()}`);
  const series = await loadAllStockSeriesFromParquet(2010, 2016);
  console.log(`종목 ${series.size}개 로드(2010~2016)`);
  await runProbe({
    dartKey, series,
    dbCorp: async (codes) => {
      const map = new Map<string, { corp_code: string; corp_name: string }>();
      let rows = 0;
      for (let i = 0; i < codes.length; i += DB_IN_CHUNK) {
        const { data, error } = await supabaseAdmin.from("dart_corp_codes").select("corp_code, corp_name, stock_code").in("stock_code", codes.slice(i, i + DB_IN_CHUNK));
        if (error) throw new Error(error.message);
        rows += data?.length ?? 0;
        for (const r of data ?? []) if (r.stock_code && !map.has(r.stock_code)) map.set(r.stock_code, { corp_code: r.corp_code, corp_name: r.corp_name });
      }
      return { rows, map };
    },
  });
}
if (process.argv[1] && process.argv[1].endsWith("probe-dart-xbrl-3rd.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

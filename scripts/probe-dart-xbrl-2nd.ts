/**
 * [임시 점검 — 병합 금지, 읽기 전용, 저장 없음] DART XBRL 2차 점검: 값 추출 검증(A) + 커버리지 표본(B) + 규모 재계산(C).
 * 외부 요청은 DART만 총 120건 이하. DB는 REST로 dart_corp_codes만 읽는다. 숫자와 사실만 출력한다.
 */
import AdmZip from "adm-zip";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { parseFundamentalsList, type DartAccountRow } from "@/lib/dartFundamentalsParse";

// ---- 점검 상수 ----
const REQUEST_BUDGET = 120;
const DART_BASE_URL = "https://opendart.fss.or.kr/api";
const DART_DAILY_LIMIT_ASSUMED = 20_000;
const A_STOCKS = { samsung: "005930", woori: "053000", ssm: "000830" };
const A_LIST_RANGE = ["20120101", "20161231"] as const;
const B_LIST_RANGE = ["20120101", "20151231"] as const;
const B_FYS = [2011, 2014];
const C_FYS = [2011, 2012, 2013, 2014];
const SAMPLE_N = 30;
const SAMPLE_PER_TERCILE = 10;
const SAMPLE_FIN_PER_TERCILE = 3;
const SAMPLE_SEED = 20261016;
const PIT_FROM = "2010-01-01";
const PIT_TO = "2016-12-31";
const CAP_EOK = 5000;
const DB_IN_CHUNK = 200;
const FIN_NAME_RE = /(은행|금융|증권|보험|화재|생명|카드|캐피탈|저축|손해|해상|재보험)/;
const MAX_FACT_ROWS = 8;
const MAX_LABEL_ROWS = 30;
const MS_DAY = 86_400_000;

let used = 0;
const reqLog: string[] = [];
const maskKey = (u: string): string => u.replace(/(crtfc_key=)[^&]+/, "$1***");
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
const f0 = (x: number): string => (Number.isFinite(x) ? x.toLocaleString("en-US") : "-");
const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;
function mulberry32(a: number): () => number {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---- XBRL 인스턴스 파서 ----
type Item = "NI" | "EQ" | "EPS" | "SH";
const ITEM_NAME: Record<Item, string> = { NI: "당기순이익(지배)", EQ: "자본총계(지배)", EPS: "기본주당이익", SH: "발행주식수" };
const ITEM_RE: Record<Item, RegExp> = {
  NI: /^(ProfitLossAttributableToOwnersOfParent|NetIncomeAttributableToOwnersOfParent)$/i,
  EQ: /^(EquityAttributableToOwnersOfParent)$/i,
  EPS: /^(BasicEarningsLossPerShare|BasicEarningsPerShare|BasicAndDilutedEarningsLossPerShare)$/i,
  SH: /(NumberOfSharesIssued|NumberOfSharesOutstanding|NumberOfShares|SharesIssued|IssuedShares)/i,
};
const DURATION_ITEMS: Item[] = ["NI", "EPS"];
interface Ctx { start?: string; end: string; dims: string[] }
export interface Fact { item: Item; tag: string; end: string; start?: string; dims: string[]; unit: string; decimals: string; value: string }
export interface Parsed {
  files: string[]; instance: string | null; prefixes: string[]; ifrs: boolean; facts: Fact[];
  labelRows: { id: string; text: string }[]; labelFile: string | null;
}

export function parseXbrl(buf: Buffer): Parsed | { error: string } {
  let zip: AdmZip;
  try { zip = new AdmZip(buf); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  const entries = zip.getEntries();
  const files = entries.map((e) => `${e.entryName} (${e.header.size} B)`);
  const inst = entries.find((e) => /\.xbrl$/i.test(e.entryName));
  const out: Parsed = { files, instance: inst?.entryName ?? null, prefixes: [], ifrs: false, facts: [], labelRows: [], labelFile: null };
  if (inst) {
    const xml = inst.getData().toString("utf-8");
    out.prefixes = [...new Set([...xml.matchAll(/xmlns:([\w-]+)=/g)].map((m) => m[1]))];
    out.ifrs = out.prefixes.some((p) => /^ifrs(-full)?$/i.test(p));
    const ctxs = new Map<string, Ctx>();
    for (const m of xml.matchAll(/<(?:\w+:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?context>/g)) {
      const b = m[2];
      const instant = /<(?:\w+:)?instant>([^<]+)</.exec(b)?.[1];
      const s = /<(?:\w+:)?startDate>([^<]+)</.exec(b)?.[1], e = /<(?:\w+:)?endDate>([^<]+)</.exec(b)?.[1];
      const dims = [...b.matchAll(/<(?:\w+:)?(explicitMember|typedMember)\b[^>]*dimension="([^"]+)"[^>]*>([^<]*)/g)].map((d) => `${d[2]}=${d[3].trim() || d[1]}`);
      ctxs.set(m[1], { start: instant ? undefined : s, end: instant ?? e ?? "?", dims });
    }
    for (const m of xml.matchAll(/<([\w.-]+):([\w.-]+)\b([^>]*\bcontextRef="([^"]+)"[^>]*)>([^<]*)</g)) {
      const local = m[2];
      const item = (Object.keys(ITEM_RE) as Item[]).find((k) => ITEM_RE[k].test(local));
      if (!item) continue;
      const c = ctxs.get(m[4]);
      if (!c) continue;
      out.facts.push({ item, tag: `${m[1]}:${local}`, end: c.end, start: c.start, dims: c.dims, unit: /unitRef="([^"]+)"/.exec(m[3])?.[1] ?? "-", decimals: /decimals="([^"]+)"/.exec(m[3])?.[1] ?? "-", value: m[5].trim() });
    }
  }
  const lab = entries.find((e) => /lab_.*-ko.*\.xml$/i.test(e.entryName) || /-lab\.xml$/i.test(e.entryName));
  if (lab) {
    out.labelFile = lab.entryName;
    const x = lab.getData().toString("utf-8");
    const locToId = new Map<string, string>();
    for (const m of x.matchAll(/<(?:\w+:)?loc\b([^>]*)\/>/g)) {
      const href = /xlink:href="[^"#]*#([^"]+)"/.exec(m[1])?.[1], lb = /xlink:label="([^"]+)"/.exec(m[1])?.[1];
      if (href && lb) locToId.set(lb, href);
    }
    const labText = new Map<string, string>();
    for (const m of x.matchAll(/<(?:\w+:)?label\b([^>]*)>([^<]*)<\/(?:\w+:)?label>/g)) {
      const lb = /xlink:label="([^"]+)"/.exec(m[1])?.[1], role = /xlink:role="([^"]+)"/.exec(m[1])?.[1] ?? "";
      if (lb && /\/label$/.test(role)) labText.set(lb, m[2].trim());
    }
    for (const m of x.matchAll(/<(?:\w+:)?labelArc\b([^>]*)\/>/g)) {
      const from = /xlink:from="([^"]+)"/.exec(m[1])?.[1], to = /xlink:to="([^"]+)"/.exec(m[1])?.[1];
      const id = from ? locToId.get(from) : undefined, text = to ? labText.get(to) : undefined;
      if (id && text) out.labelRows.push({ id, text });
    }
  }
  return out;
}

const isConsolidatedOnly = (d: string[]): boolean => d.length > 0 && d.every((x) => /ConsolidatedAndSeparate/i.test(x.split("=")[0])) && d.every((x) => /Consolidated/i.test(x.split("=")[1]) && !/Separate/i.test(x.split("=")[1]));
/** 항목의 당기/전기 "대표" 사실: 연결 차원만 가진 사실 > 차원 없는 사실. 기간 끝이 가장 늦은 것이 당기, 그 다음(약 1년 전)이 전기. */
export function pickPrimary(p: Parsed, item: Item, which: "cur" | "prior"): { fact: Fact; via: string } | null {
  const dur = DURATION_ITEMS.includes(item);
  const all = p.facts.filter((f) => f.item === item && (!dur || (f.start && dayDiff(f.start, f.end) > 300)));
  const ends = [...new Set(all.map((f) => f.end))].sort().reverse();
  if (!ends.length) return null;
  let end = ends[0];
  if (which === "prior") {
    const prior = ends.find((e) => dayDiff(e, ends[0]) > 330 && dayDiff(e, ends[0]) < 400);
    if (!prior) return null;
    end = prior;
  }
  const at = all.filter((f) => f.end === end);
  const cons = at.find((f) => isConsolidatedOnly(f.dims));
  if (cons) return { fact: cons, via: "연결 차원" };
  const none = at.find((f) => f.dims.length === 0);
  if (none) return { fact: none, via: "차원 없음" };
  return null;
}

// ---- DART 공시검색 ----
interface Filing { report_nm: string; rcept_no: string; rcept_dt: string }
const periodYear = (nm: string): number | null => { const m = /\((\d{4})\.\d{2}\)/.exec(nm); return m ? Number(m[1]) : null; };
interface FyPick { original: Filing | null; latest: Filing | null; hasCorrection: boolean; all: Filing[] }
function pickFy(filings: Filing[], fy: number): FyPick {
  const fs = filings.filter((f) => /사업보고서/.test(f.report_nm) && periodYear(f.report_nm) === fy).sort((a, b) => (a.rcept_no < b.rcept_no ? -1 : 1));
  const plain = fs.filter((f) => !/^\[/.test(f.report_nm));
  return { original: plain[0] ?? fs[0] ?? null, latest: fs[fs.length - 1] ?? null, hasCorrection: fs.some((f) => /정정/.test(f.report_nm)), all: fs };
}
async function dartList(key: string, corp: string, label: string, range: readonly [string, string]): Promise<Filing[] | null> {
  const r = await ext(`list ${label}`, `${DART_BASE_URL}/list.json?crtfc_key=${key}&corp_code=${corp}&bgn_de=${range[0]}&end_de=${range[1]}&pblntf_ty=A&page_no=1&page_count=100`);
  if (!r) return null;
  const j = parseJson(r.buf.toString("utf-8")) as { status?: string; list?: Filing[] } | null;
  return j?.list ?? [];
}
type XStatus = { kind: "있음"; parsed: Parsed; bytes: number } | { kind: "014" | "기타"; note: string; bytes: number } | { kind: "요청 안 됨"; note: string };
async function fetchXbrl(key: string, label: string, rcept: string): Promise<XStatus> {
  const r = await ext(`xbrl ${label}`, `${DART_BASE_URL}/fnlttXbrl.xml?crtfc_key=${key}&rcept_no=${rcept}&reprt_code=11011`);
  if (!r) return { kind: "요청 안 됨", note: "요청 실패/한도" };
  if (!isZip(r.buf)) {
    const txt = r.buf.toString("utf-8");
    const st = /<status>([^<]*)</.exec(txt)?.[1] ?? "-", msg = /<message>([^<]*)</.exec(txt)?.[1] ?? txt.slice(0, 40);
    return st === "014" ? { kind: "014", note: msg, bytes: r.buf.length } : { kind: "기타", note: `HTTP ${r.status} status ${st} ${msg}`, bytes: r.buf.length };
  }
  const p = parseXbrl(r.buf);
  if ("error" in p) return { kind: "기타", note: `zip 해석 실패 ${p.error}`, bytes: r.buf.length };
  return { kind: "있음", parsed: p, bytes: r.buf.length };
}

function factLine(f: Fact): string {
  return `${f.tag} | ${f.start ? `${f.start}~${f.end}` : f.end} | 차원 ${f.dims.length ? f.dims.join(" & ") : "없음"} | 값 ${f.value} | unitRef ${f.unit} | decimals ${f.decimals}`;
}
function printFacts(title: string, p: Parsed): void {
  console.log(`  [${title}] 인스턴스 ${p.instance ?? "없음"} | 접두사 ${p.prefixes.join(",")} | IFRS 접두사 ${p.ifrs ? "있음" : "없음"}`);
  console.log("  | 항목 | 태그 | 컨텍스트 기간 | 차원 | 값 | unitRef | decimals | 구분 |");
  console.log("  |---|---|---|---|---|---|---|---|");
  for (const it of Object.keys(ITEM_RE) as Item[]) {
    const fs = p.facts.filter((f) => f.item === it);
    const prim = [pickPrimary(p, it, "cur")?.fact, pickPrimary(p, it, "prior")?.fact];
    const ends = [...new Set(fs.map((f) => f.end))].sort().reverse().slice(0, 2);
    const shown = fs.filter((f) => ends.includes(f.end)).sort((a, b) => (a.end < b.end ? 1 : -1)).slice(0, MAX_FACT_ROWS);
    if (!shown.length) console.log(`  | ${ITEM_NAME[it]} | (해당 태그 사실 없음) | - | - | - | - | - | - |`);
    for (const f of shown) {
      const tagKind = prim[0] === f ? "당기 대표" : prim[1] === f ? "전기 대표" : f.end === ends[0] ? "당기(기타 차원)" : "전기(기타 차원)";
      console.log(`  | ${ITEM_NAME[it]} | ${f.tag} | ${f.start ? `${f.start}~${f.end}` : f.end} | ${f.dims.length ? f.dims.join(" & ") : "없음"} | ${f.value} | ${f.unit} | ${f.decimals} | ${tagKind} |`);
    }
    console.log(`  (${ITEM_NAME[it]} 전체 사실 ${fs.length}건)`);
  }
}
function printLabels(title: string, p: Parsed): void {
  const KW = /(지배|당기순이익|주당이익|주당순이익|자본총계|발행주식|주식수)/;
  const rel = /(ProfitLoss|NetIncome|Equity|EarningsLossPerShare|EarningsPerShare|Shares)/i;
  const rows = p.labelRows.filter((r) => KW.test(r.text) && rel.test(r.id));
  console.log(`  [라벨 ${title}] 라벨 파일 ${p.labelFile ?? "없음"} | 라벨 ${p.labelRows.length}개 중 키워드·태그 조건 일치 ${rows.length}개 (최대 ${MAX_LABEL_ROWS}개 표시)`);
  console.log("  | 태그 ID | 한글 라벨 |");
  console.log("  |---|---|");
  for (const r of rows.slice(0, MAX_LABEL_ROWS)) console.log(`  | ${r.id} | ${r.text} |`);
}

export interface Deps {
  dartKey: string;
  series: Map<string, StockDailyPriceRow[]>;
  dbCorp: (codes: string[]) => Promise<{ rows: number; map: Map<string, { corp_code: string; corp_name: string }> }>;
}

export async function runProbe(d: Deps): Promise<void> {
  // ---- PIT 유니버스 (2010-01~2016-12 월말) ----
  const dates = new Set<string>();
  for (const rows of d.series.values()) for (const r of rows) if (r.tradeDate >= PIT_FROM && r.tradeDate <= PIT_TO) dates.add(r.tradeDate);
  const cal = [...dates].sort();
  const monthEnds = new Set<string>();
  for (let k = 0; k + 1 < cal.length; k++) if (cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7)) monthEnds.add(cal[k]);
  const pit = new Map<string, number>(); // code → 최대 시총(억)
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
  const need = [...new Set([...pit.keys(), ...Object.values(A_STOCKS)])];
  const corp = await d.dbCorp(need);
  const pitWith = [...pit.keys()].filter((c) => corp.map.has(c));
  console.log(`월말 PIT 유니버스(2010-01~2016-12) 고유 종목 ${pit.size}개, corp_code 있음 ${pitWith.length}개 / 없음 ${pit.size - pitWith.length}개`);
  console.log(`DB 읽은 행: dart_corp_codes ${corp.rows}행 (종목코드 ${need.length}개 IN 조회)`);

  // ================= A =================
  console.log("\n=== A. 값 추출 ===");
  const A = [
    { key: "samsung", code: A_STOCKS.samsung, fys: [2011, 2012, 2013, 2014, 2015] },
    { key: "woori", code: A_STOCKS.woori, fys: [2011, 2012] },
    { key: "ssm", code: A_STOCKS.ssm, fys: [2011, 2012] },
  ];
  const parsedA = new Map<string, Parsed>();
  const rceptA = new Map<string, string>();
  for (const s of A) {
    const c = corp.map.get(s.code);
    if (!c) { console.log(`${s.code}: corp_code 없음`); continue; }
    const filings = (await dartList(d.dartKey, c.corp_code, `${s.code} (A)`, A_LIST_RANGE)) ?? [];
    for (const fy of s.fys) {
      const pick = pickFy(filings, fy);
      if (!pick.original) { console.log(`${s.code} FY${fy}: 사업보고서 없음`); continue; }
      rceptA.set(`${s.code}-${fy}`, pick.original.rcept_no);
      const r = await fetchXbrl(d.dartKey, `${s.code} FY${fy}`, pick.original.rcept_no);
      console.log(`\n${s.code}(${c.corp_name}) FY${fy} 원본 ${pick.original.rcept_no} (${pick.original.report_nm}) 최신 ${pick.latest?.rcept_no}: XBRL ${r.kind}${r.kind === "있음" ? ` ${r.bytes} B` : ` ${"note" in r ? r.note : ""}`}`);
      if (r.kind !== "있음") continue;
      parsedA.set(`${s.code}-${fy}`, r.parsed);
      if ((s.key === "samsung" && fy === 2011) || (s.key === "woori" && fy === 2011)) printLabels(`${s.code} FY${fy}`, r.parsed);
      printFacts(`${s.code} FY${fy}`, r.parsed);
    }
  }

  // A3: 당기 vs 다음 보고서 전기 (005930)
  console.log("\n=== A3. 005930 보고서 간 전기값 = 당기값 비교 ===");
  console.log("| 비교 | 항목 | 앞 보고서 당기 | 뒤 보고서 전기 | 결과 |");
  console.log("|---|---|---|---|---|");
  for (const fy of [2011, 2012, 2013]) {
    const a = parsedA.get(`005930-${fy}`), b = parsedA.get(`005930-${fy + 1}`);
    for (const it of ["NI", "EQ"] as Item[]) {
      const cur = a ? pickPrimary(a, it, "cur") : null, pri = b ? pickPrimary(b, it, "prior") : null;
      console.log(`| FY${fy} 보고서 당기 vs FY${fy + 1} 보고서 전기(${fy}) | ${ITEM_NAME[it]} | ${cur?.fact.value ?? "-"} | ${pri?.fact.value ?? "-"} | ${cur && pri ? (cur.fact.value === pri.fact.value ? "같음" : "다름") : "비교 불가"} |`);
    }
  }
  {
    const b = parsedA.get("005930-2011");
    for (const it of ["NI", "EQ"] as Item[]) {
      const pri = b ? pickPrimary(b, it, "prior") : null;
      console.log(`| FY2010 보고서 당기 vs FY2011 보고서 전기(2010) | ${ITEM_NAME[it]} | (FY2010 XBRL 없음: 이전 점검 status 014) | ${pri?.fact.value ?? "-"} | 비교 불가 |`);
    }
  }

  // A4: FY2015 XBRL vs fnlttSinglAcntAll
  console.log("\n=== A4. 005930 FY2015: XBRL vs fnlttSinglAcntAll(CFS) ===");
  const sc = corp.map.get(A_STOCKS.samsung);
  const x15 = parsedA.get("005930-2015");
  let singl: { ni: number | null; eq: number | null; rcept: string } | null = null;
  if (sc) {
    const r = await ext("singl 005930 FY2015", `${DART_BASE_URL}/fnlttSinglAcntAll.json?crtfc_key=${d.dartKey}&corp_code=${sc.corp_code}&bsns_year=2015&reprt_code=11011&fs_div=CFS`);
    const j = r ? (parseJson(r.buf.toString("utf-8")) as { status?: string; list?: DartAccountRow[] } | null) : null;
    if (j?.status === "000" && j.list?.length) { const pf = parseFundamentalsList(j.list); singl = { ni: pf.netIncomeParent, eq: pf.equityParent, rcept: pf.rceptNo }; }
    else console.log(`fnlttSinglAcntAll 응답: status ${j?.status ?? "-"}`);
  }
  console.log("| 항목 | XBRL 값(대표 사실) | XBRL 선택 근거 | fnlttSinglAcntAll 값 | 일치 |");
  console.log("|---|---|---|---|---|");
  for (const [it, sv] of [["NI", singl?.ni], ["EQ", singl?.eq]] as [Item, number | null | undefined][]) {
    const pr = x15 ? pickPrimary(x15, it, "cur") : null;
    const xv = pr ? Number(pr.fact.value) : NaN;
    console.log(`| ${ITEM_NAME[it]} | ${pr?.fact.value ?? "-"} (${pr?.fact.unit ?? "-"}, decimals ${pr?.fact.decimals ?? "-"}) | ${pr?.via ?? "-"} | ${sv ?? "-"} | ${Number.isFinite(xv) && sv != null ? (xv === sv ? "같음" : `다름(차이 ${f0(xv - sv)})`) : "비교 불가"} |`);
  }
  if (singl) console.log(`(fnlttSinglAcntAll rcept_no ${singl.rcept}, XBRL rcept_no ${rceptA.get("005930-2015") ?? "-"})`);

  // A5
  console.log("\n=== A5. 053000·000830 FY2011 회계기준(접두사)과 태그 비교 ===");
  console.log("| 종목 | FY2011 IFRS 접두사 | 접두사 | NI 태그 | EQ 태그 | EPS 태그 | 발행주식수 태그 |");
  console.log("|---|---|---|---|---|---|---|");
  const tagsOf = (p: Parsed | undefined, it: Item): string => (p ? [...new Set(p.facts.filter((f) => f.item === it).map((f) => f.tag))].join(", ") || "(없음)" : "-");
  for (const code of Object.values(A_STOCKS)) {
    const p = parsedA.get(`${code}-2011`);
    console.log(`| ${code} | ${p ? (p.ifrs ? "예" : "아니오") : "XBRL 없음"} | ${p?.prefixes.join(",") ?? "-"} | ${tagsOf(p, "NI")} | ${tagsOf(p, "EQ")} | ${tagsOf(p, "EPS")} | ${tagsOf(p, "SH")} |`);
  }
  {
    const s = parsedA.get("005930-2011"), w = parsedA.get("053000-2011");
    const set = (p: Parsed | undefined, it: Item): string => [...new Set((p?.facts ?? []).filter((f) => f.item === it).map((f) => f.tag.split(":")[1]))].sort().join("|");
    for (const it of ["NI", "EQ"] as Item[]) console.log(`053000 vs 005930 ${ITEM_NAME[it]} 태그(로컬명) 집합: ${set(w, it) === set(s, it) ? "같음" : "다름"} (053000: ${set(w, it) || "-"} / 005930: ${set(s, it) || "-"})`);
  }

  // ================= B =================
  console.log("\n=== B. 커버리지 표본 ===");
  const ranked = pitWith.map((c) => ({ code: c, peak: pit.get(c)!, name: corp.map.get(c)!.corp_name })).sort((a, b) => b.peak - a.peak || (a.code < b.code ? -1 : 1));
  const third = Math.ceil(ranked.length / 3);
  const terciles = [ranked.slice(0, third), ranked.slice(third, 2 * third), ranked.slice(2 * third)];
  const tName = ["상위", "중위", "하위"];
  const rng = mulberry32(SAMPLE_SEED);
  const shuffle = <T,>(a: T[]): T[] => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
  const sample: { code: string; name: string; tercile: string; fin: boolean }[] = [];
  terciles.forEach((tr, ti) => {
    const fin = shuffle(tr.filter((x) => FIN_NAME_RE.test(x.name))), non = shuffle(tr.filter((x) => !FIN_NAME_RE.test(x.name)));
    const nf = Math.min(SAMPLE_FIN_PER_TERCILE, fin.length);
    for (const x of [...fin.slice(0, nf), ...non.slice(0, SAMPLE_PER_TERCILE - nf)]) sample.push({ code: x.code, name: x.name, tercile: tName[ti], fin: FIN_NAME_RE.test(x.name) });
  });
  console.log(`시드 ${SAMPLE_SEED}, 후보 ${ranked.length}개(시총 최대값 기준 3분위 ${terciles.map((t) => t.length).join("/")}), 이름 기반 금융 분류(은행·금융·증권·보험·화재·생명·카드·캐피탈·저축·손해·해상·재보험) 후보 내 ${ranked.filter((x) => FIN_NAME_RE.test(x.name)).length}개, 표본 ${sample.length}개`);
  console.log("| # | 종목 | 이름 | 시총 구간 | 금융(이름 기준) |");
  console.log("|---|---|---|---|---|");
  sample.forEach((s, i) => console.log(`| ${i + 1} | ${s.code} | ${s.name} | ${s.tercile} | ${s.fin ? "예" : "아니오"} |`));

  interface Row { s: (typeof sample)[number]; fy: number; pick: FyPick; x: XStatus | null }
  const rows: Row[] = [];
  for (const s of sample) {
    const filings = (await dartList(d.dartKey, corp.map.get(s.code)!.corp_code, `${s.code} (B)`, B_LIST_RANGE)) ?? [];
    for (const fy of B_FYS) rows.push({ s, fy, pick: pickFy(filings, fy), x: null });
  }
  for (const r of rows) r.x = r.pick.original ? await fetchXbrl(d.dartKey, `${r.s.code} FY${r.fy}`, r.pick.original.rcept_no) : null;
  const extra: Row[] = [];
  for (const r of rows) {
    if (r.pick.original && r.pick.latest && r.pick.latest.rcept_no !== r.pick.original.rcept_no && used < REQUEST_BUDGET) {
      extra.push({ s: r.s, fy: r.fy, pick: r.pick, x: await fetchXbrl(d.dartKey, `${r.s.code} FY${r.fy} 최신`, r.pick.latest.rcept_no) });
    }
  }
  const ext4 = (x: XStatus | null): { st: string; ifrs: string; items: Record<Item, boolean>; all: boolean } => {
    const none = { NI: false, EQ: false, EPS: false, SH: false } as Record<Item, boolean>;
    if (!x) return { st: "보고서 없음", ifrs: "-", items: none, all: false };
    if (x.kind !== "있음") return { st: x.kind === "014" ? "status 014" : x.kind === "기타" ? `기타(${x.note.slice(0, 40)})` : x.kind, ifrs: "-", items: none, all: false };
    const items = { NI: !!pickPrimary(x.parsed, "NI", "cur"), EQ: !!pickPrimary(x.parsed, "EQ", "cur"), EPS: !!pickPrimary(x.parsed, "EPS", "cur"), SH: !!pickPrimary(x.parsed, "SH", "cur") };
    return { st: "있음", ifrs: x.parsed.ifrs ? "예" : "아니오", items, all: items.NI && items.EQ && items.EPS && items.SH };
  };
  const yn = (b: boolean): string => (b ? "O" : "X");
  console.log("\n| 종목 | 구분 | FY | 원본 rcept_no | 최신 rcept_no | 정정공시 | XBRL(원본) | IFRS 접두사 | NI | EQ | EPS | 주식수 | 4개 모두 |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const e = ext4(r.x);
    console.log(`| ${r.s.code} | ${r.s.fin ? "금융" : "비금융"} | FY${r.fy} | ${r.pick.original?.rcept_no ?? "-"} | ${r.pick.latest?.rcept_no ?? "-"} | ${r.pick.hasCorrection ? "있음" : "없음"} | ${e.st} | ${e.ifrs} | ${yn(e.items.NI)} | ${yn(e.items.EQ)} | ${yn(e.items.EPS)} | ${yn(e.items.SH)} | ${yn(e.all)} |`);
  }
  if (extra.length) {
    console.log("\n정정공시가 있어 최신 rcept_no로도 요청한 건:");
    console.log("| 종목 | FY | 최신 rcept_no | XBRL | IFRS 접두사 | NI | EQ | EPS | 주식수 | 4개 모두 |");
    console.log("|---|---|---|---|---|---|---|---|---|---|");
    for (const r of extra) { const e = ext4(r.x); console.log(`| ${r.s.code} | FY${r.fy} | ${r.pick.latest?.rcept_no} | ${e.st} | ${e.ifrs} | ${yn(e.items.NI)} | ${yn(e.items.EQ)} | ${yn(e.items.EPS)} | ${yn(e.items.SH)} | ${yn(e.all)} |`); }
  }
  console.log("\n집계 (표본 30개 기준)");
  console.log("| FY | 구분 | 표본 수 | 보고서 있음 | XBRL 있음 | XBRL 있음 비율 | 4개 항목 모두 추출 | 추출 성공 비율(표본 대비) | 추출 성공 비율(XBRL 있음 대비) |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const fy of B_FYS) {
    for (const [lab, filt] of [["전체", () => true], ["금융(이름 기준)", (r: Row) => r.s.fin], ["비금융", (r: Row) => !r.s.fin]] as [string, (r: Row) => boolean][]) {
      const rs = rows.filter((r) => r.fy === fy && filt(r));
      const found = rs.filter((r) => r.pick.original).length;
      const has = rs.filter((r) => ext4(r.x).st === "있음").length;
      const ok = rs.filter((r) => ext4(r.x).all).length;
      const pc = (a: number, b: number): string => (b ? ((a / b) * 100).toFixed(1) + "%" : "-");
      console.log(`| FY${fy} | ${lab} | ${rs.length} | ${found} | ${has} | ${pc(has, rs.length)} | ${ok} | ${pc(ok, rs.length)} | ${pc(ok, has)} |`);
    }
  }
  const kinds = new Map<string, number>();
  for (const r of rows) { const k = ext4(r.x).st; kinds.set(k, (kinds.get(k) ?? 0) + 1); }
  console.log(`XBRL 상태 분포(표본×2개 연도 ${rows.length}건): ${[...kinds.entries()].map(([k, v]) => `${k} ${v}`).join(" | ")}`);

  // ================= C =================
  const n = pitWith.length;
  console.log("\n=== C. 규모 재계산 ===");
  console.log("| 항목 | 값 |");
  console.log("|---|---|");
  console.log(`| corp_code 있는 PIT 종목 수 | ${n} |`);
  console.log(`| 회계연도 ${C_FYS[0]}~${C_FYS[C_FYS.length - 1]} (${C_FYS.length}개) × ${n} = 필요한 XBRL 요청 수 | ${C_FYS.length * n} |`);
  console.log(`| ÷ 일일 호출 한도 ${f0(DART_DAILY_LIMIT_ASSUMED)} (가정: 응답에서 한도 값은 확인되지 않음) | ${((C_FYS.length * n / DART_DAILY_LIMIT_ASSUMED) * 100).toFixed(1)}% |`);
  console.log(`| 공시검색(list.json) 추가 요청 수 (종목당 1회 가정) | ${n} |`);

  console.log(`\nDART 외부 요청 사용: ${used}/${REQUEST_BUDGET}건`);
  console.log("요청 로그:");
  for (const l of reqLog) console.log(`  ${l}`);
  console.log("\n완료");
}

async function main(): Promise<void> {
  const dartKey = process.env.DART_API_KEY;
  if (!dartKey) throw new Error("DART_API_KEY 환경변수가 필요합니다.");
  console.log(`DART XBRL 2차 점검 시작(읽기 전용): ${new Date().toISOString()}`);
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
if (process.argv[1] && process.argv[1].endsWith("probe-dart-xbrl-2nd.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
void maskKey;

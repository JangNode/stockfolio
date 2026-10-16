/**
 * DART fnlttXbrl.xml(zip 안의 .xbrl 인스턴스)에서 지배주주 당기순이익·자본·기본EPS를 뽑는 규칙.
 * 3차 점검(커밋 f65e29a, scripts/probe-dart-xbrl-3rd.ts)에서 고정한 규칙과 동일하다 — 바꾸지 않는다:
 *  - 컨텍스트 우선순위: 연결(ConsolidatedMember) > 차원 없음 > 별도(SeparateMember), 당기(회계연도 말과
 *    정확히 일치하는 기간/기말)만 선택. 컨텍스트가 먼저, 그 안에서 태그 우선순위(원본 → 폴백).
 *  - 당기순이익: ProfitLossAttributableToOwnersOfParent → ProfitLoss
 *  - 자본: EquityAttributableToOwnersOfParent → Equity
 *  - EPS: BasicEarningsLossPerShare → BasicAndDilutedEarningsLossPerShare → Basic…EarningsLossPerShare 계열
 */
import AdmZip from "adm-zip";

const MS_DAY = 86_400_000;
const MIN_DURATION_DAYS = 300;
const BROAD = /(Profit|Income|Equity|EarningsPerShare|EarningsLossPerShare)/i;

export type Item = "NI" | "EQ" | "EPS";
export const ITEMS: Item[] = ["NI", "EQ", "EPS"];
const DURATION: Record<Item, boolean> = { NI: true, EQ: false, EPS: true };

export interface RFact { local: string; tag: string; end: string; start?: string; dims: string[]; unit: string; decimals: string; value: string }
export interface Inst { facts: RFact[]; instance: string | null }

export const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;

export function parseInst(buf: Buffer): Inst | { error: string } {
  let zip: AdmZip;
  try { zip = new AdmZip(buf); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  const inst = zip.getEntries().find((e) => /\.xbrl$/i.test(e.entryName));
  if (!inst) return { facts: [], instance: null };
  const xml = inst.getData().toString("utf-8");
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
  return { facts, instance: inst.entryName };
}

export type CtxKind = "연결" | "없음" | "별도" | "기타 차원";
export function ctxKind(dims: string[]): CtxKind {
  if (dims.length === 0) return "없음";
  const axisOk = dims.every((x) => /ConsolidatedAndSeparate/i.test(x.split("=")[0]));
  if (axisOk && dims.every((x) => /Consolidated/i.test(x.split("=")[1]) && !/Separate/i.test(x.split("=")[1]))) return "연결";
  if (axisOk && dims.every((x) => /Separate/i.test(x.split("=")[1]))) return "별도";
  return "기타 차원";
}

export const CHAINS: Record<Item, ((local: string) => boolean)[]> = {
  NI: [(l) => l === "ProfitLossAttributableToOwnersOfParent", (l) => l === "ProfitLoss"],
  EQ: [(l) => l === "EquityAttributableToOwnersOfParent", (l) => l === "Equity"],
  EPS: [(l) => l === "BasicEarningsLossPerShare", (l) => l === "BasicAndDilutedEarningsLossPerShare", (l) => /^Basic(?!.*Diluted).*EarningsLossPerShare$/i.test(l)],
};
const KIND_ORDER: CtxKind[] = ["연결", "없음", "별도"];
export interface Pick { fact: RFact; kind: CtxKind; fallback: boolean; chainIdx: number }

export function newPick(facts: RFact[], item: Item, end: string): Pick | null {
  const valid = facts.filter((f) => f.end === end && (!DURATION[item] || (f.start && dayDiff(f.start, f.end) > MIN_DURATION_DAYS)));
  for (const kind of KIND_ORDER) {
    for (let ci = 0; ci < CHAINS[item].length; ci++) {
      const f = valid.find((x) => ctxKind(x.dims) === kind && CHAINS[item][ci](x.local));
      if (f) return { fact: f, kind, fallback: ci > 0, chainIdx: ci };
    }
  }
  return null;
}

export type MissReason = "no_tag" | "dim" | "period";
/** newPick이 null일 때 사유: 체인 태그가 아예 없음 / 기간·시점이 안 맞음 / 기간은 맞는데 차원(기타 차원)만 있음. */
export function missReason(facts: RFact[], item: Item, end: string): MissReason {
  const tagged = facts.filter((f) => CHAINS[item].some((fn) => fn(f.local)));
  if (!tagged.length) return "no_tag";
  const periodOk = tagged.filter((f) => f.end === end && (!DURATION[item] || (f.start && dayDiff(f.start, f.end) > MIN_DURATION_DAYS)));
  return periodOk.length ? "dim" : "period";
}

export type Basis = "cons" | "nodim" | "sep";
export const basisOf = (k: CtxKind): Basis => (k === "연결" ? "cons" : k === "없음" ? "nodim" : "sep");

export interface ExtractedItem { value: number | null; tag: string | null; basis: Basis | null; miss: MissReason | null }
export function extractItem(facts: RFact[], item: Item, end: string): ExtractedItem {
  const p = newPick(facts, item, end);
  if (!p) return { value: null, tag: null, basis: null, miss: missReason(facts, item, end) };
  const v = Number(p.fact.value);
  return Number.isFinite(v) ? { value: v, tag: p.fact.tag, basis: basisOf(p.kind), miss: null } : { value: null, tag: null, basis: null, miss: "no_tag" };
}

export interface Filing { report_nm: string; rcept_no: string; rcept_dt: string }
export const periodOf = (nm: string): { y: number; m: number } | null => { const m = /\((\d{4})\.(\d{2})\)/.exec(nm); return m ? { y: Number(m[1]), m: Number(m[2]) } : null; };
export const lastDayOfMonth = (y: number, m: number): string => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

export interface ReportPick { filing: Filing | null; amendedOnly: boolean }
/** 해당 회계연도 12월 사업보고서 중 정정([…정정] 제목) 제외, 접수일이 가장 빠른 것. "[첨부추가]"는 정정이 아니다.
 * 정정만 있으면 그중 가장 빠른 것을 쓰고 amendedOnly=true. */
export function pickReport(filings: Filing[], fy: number, month: number): ReportPick {
  const fs = filings
    .filter((f) => /사업보고서/.test(f.report_nm) && periodOf(f.report_nm)?.y === fy && periodOf(f.report_nm)?.m === month)
    .sort((a, b) => (a.rcept_dt === b.rcept_dt ? (a.rcept_no < b.rcept_no ? -1 : 1) : a.rcept_dt < b.rcept_dt ? -1 : 1));
  const plain = fs.filter((f) => !/정정/.test(f.report_nm));
  if (plain.length) return { filing: plain[0], amendedOnly: false };
  return { filing: fs[0] ?? null, amendedOnly: fs.length > 0 };
}

export type XbrlStatus = "ok" | "partial" | "xbrl_014" | "no_report" | "amended_only";
export interface XbrlRow {
  corp_code: string; stock_code: string; fiscal_year: number; source: "own" | "prior_col";
  rcept_no: string | null; rcept_dt: string | null;
  ni_parent: number | null; ni_tag: string | null; ni_basis: Basis | null;
  equity_parent: number | null; equity_tag: string | null; equity_basis: Basis | null;
  eps_basic: number | null; eps_basis: Basis | null;
  status: XbrlStatus; miss_reason: string | null; fetched_at: string;
}
export type XFetch = { kind: "inst"; facts: RFact[] } | { kind: "014" };
const toDate = (d: string): string => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

/** 보고서 선택 결과 + XBRL 조회 결과 + 추출 대상 기말(end)로 저장 행 1개를 만든다(값이 없어도 1행). */
export function buildRow(base: { corp_code: string; stock_code: string; fiscal_year: number; source: "own" | "prior_col" }, pick: ReportPick, x: XFetch | null, end: string, fetchedAt: string): XbrlRow {
  const empty = { ni_parent: null, ni_tag: null, ni_basis: null, equity_parent: null, equity_tag: null, equity_basis: null, eps_basic: null, eps_basis: null };
  if (!pick.filing || !x) return { ...base, rcept_no: null, rcept_dt: null, ...empty, status: "no_report", miss_reason: "no_report", fetched_at: fetchedAt };
  const common = { ...base, rcept_no: pick.filing.rcept_no, rcept_dt: toDate(pick.filing.rcept_dt), fetched_at: fetchedAt };
  if (x.kind === "014") return { ...common, ...empty, status: pick.amendedOnly ? "amended_only" : "xbrl_014", miss_reason: "xbrl:014" };
  const ni = extractItem(x.facts, "NI", end), eq = extractItem(x.facts, "EQ", end), eps = extractItem(x.facts, "EPS", end);
  const misses = [["ni", ni], ["equity", eq], ["eps", eps]].filter(([, e]) => (e as ExtractedItem).miss).map(([n, e]) => `${n}:${(e as ExtractedItem).miss}`);
  const all3 = misses.length === 0;
  return {
    ...common,
    ni_parent: ni.value, ni_tag: ni.tag, ni_basis: ni.basis,
    equity_parent: eq.value, equity_tag: eq.tag, equity_basis: eq.basis,
    eps_basic: eps.value, eps_basis: eps.basis,
    status: pick.amendedOnly ? "amended_only" : all3 ? "ok" : "partial",
    miss_reason: all3 ? null : misses.join(";"),
  };
}

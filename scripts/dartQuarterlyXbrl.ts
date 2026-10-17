/**
 * [연구용] 분기·반기 보고서 fnlttXbrl.xml 추출. 규칙은 research/quarterly-tilt-holdout-prereg.md(5df8ab2) 3항이 고정한다.
 * 컨텍스트 순서 연결 → 차원 없음 → 별도, 3개월/누적/전년 3개월/전년 누적, 순이익 지배 → ProfitLoss 폴백, 자본 지배 → Equity 폴백.
 */
import AdmZip from "adm-zip";
import { ctxKind, dayDiff, periodOf, type CtxKind, type Filing, type RFact } from "@/lib/dartXbrlExtract";
import { QUARTERLY_REPORTS, QUARTERLY_XBRL_DURATION_MAX_DAYS, QUARTERLY_XBRL_DURATION_MIN_DAYS } from "@/lib/dartQuarterlyBackfillConfig";

const BROAD = /(ProfitLoss|Revenue|OperatingIncomeLoss|Equity)/;

export function parseQuarterInst(buf: Buffer): { facts: RFact[]; instance: string | null } | { error: string } {
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
    ctxs.set(m[1], { start: instant ? undefined : s?.trim(), end: (instant ?? e ?? "?").trim(), dims });
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

export interface QExtract {
  basis: "cons" | "nodim" | "sep"; fs_div: "CFS" | "OFS" | null;
  ni_tag: "parent" | "profitloss" | null;
  ni_parent_q: number | null; ni_parent_cum: number | null; ni_parent_prev_q: number | null; ni_parent_prev_cum: number | null;
  revenue_q: number | null; revenue_prev_q: number | null; op_income_q: number | null; op_income_prev_q: number | null; equity_parent: number | null;
  used: string;
}
const KIND_ORDER: CtxKind[] = ["연결", "없음", "별도"];
const BASIS = { 연결: "cons", 없음: "nodim", 별도: "sep" } as const;
const numOrNull = (s: string | undefined): number | null => { if (s === undefined) return null; const n = Number(s.replace(/,/g, "")); return Number.isFinite(n) ? n : null; };

/** 분기 보고서 1건의 팩트에서 값을 뽑는다. 3개월 컨텍스트가 하나도 없으면 null. */
export function extractQuarter(facts: RFact[], fy: number, quarter: number): QExtract | null {
  const rep = QUARTERLY_REPORTS.find((r) => r.quarter === quarter)!;
  const E = `${fy}-${rep.qEndMmdd}`, E1 = `${fy - 1}-${rep.qEndMmdd}`, S = `${fy}-01-01`, S1 = `${fy - 1}-01-01`;
  const is3m = (f: RFact, end: string): boolean => f.end === end && f.start !== undefined && dayDiff(f.start, f.end) >= QUARTERLY_XBRL_DURATION_MIN_DAYS && dayDiff(f.start, f.end) <= QUARTERLY_XBRL_DURATION_MAX_DAYS;
  const isCum = (f: RFact, end: string, start: string): boolean => f.end === end && f.start === start;
  for (const kind of KIND_ORDER) {
    const ff = facts.filter((f) => ctxKind(f.dims) === kind);
    if (!["ProfitLossAttributableToOwnersOfParent", "ProfitLoss", "OperatingIncomeLoss", "Revenue"].some((l) => ff.some((f) => f.local === l && is3m(f, E)))) continue;
    const pick = (local: string, pred: (f: RFact) => boolean): number | null => numOrNull(ff.find((f) => f.local === local && pred(f))?.value);
    const niLocal = ff.some((f) => f.local === "ProfitLossAttributableToOwnersOfParent" && is3m(f, E)) ? "ProfitLossAttributableToOwnersOfParent" : "ProfitLoss";
    const niFound = ff.some((f) => f.local === niLocal && is3m(f, E));
    const q3 = (l: string, end: string): number | null => pick(l, (f) => is3m(f, end));
    const cum = (l: string, end: string, start: string): number | null => (quarter === 1 ? q3(l, end) : pick(l, (f) => isCum(f, end, start)));
    const eqLocal = ff.some((f) => f.local === "EquityAttributableToOwnersOfParent" && f.start === undefined && f.end === E) ? "EquityAttributableToOwnersOfParent" : "Equity";
    const out = {
      ni_parent_q: q3(niLocal, E), ni_parent_cum: cum(niLocal, E, S), ni_parent_prev_q: q3(niLocal, E1), ni_parent_prev_cum: cum(niLocal, E1, S1),
      revenue_q: q3("Revenue", E), revenue_prev_q: q3("Revenue", E1), op_income_q: q3("OperatingIncomeLoss", E), op_income_prev_q: q3("OperatingIncomeLoss", E1),
      equity_parent: pick(eqLocal, (f) => f.start === undefined && f.end === E),
    };
    const has = (l: string): boolean => ff.some((f) => f.local === l && is3m(f, E));
    return {
      basis: BASIS[kind as "연결"], fs_div: kind === "연결" ? "CFS" : kind === "별도" ? "OFS" : null,
      ni_tag: niFound ? (niLocal === "ProfitLossAttributableToOwnersOfParent" ? "parent" : "profitloss") : null,
      ...out,
      used: `xbrl;ni:${niFound ? niLocal : "no_match"};rev:${has("Revenue") ? "Revenue" : "no_match"};op:${has("OperatingIncomeLoss") ? "OperatingIncomeLoss" : "no_match"};eq:${out.equity_parent !== null ? eqLocal : "no_match"};basis=${BASIS[kind as "연결"]}`,
    };
  }
  return null;
}

/** 해당 회계연도·분기의 분기/반기보고서: 정정 표기 없는 원본 중 가장 빠른 접수, 원본이 없고 정정만 있으면 그중 가장 빠른 것. */
export function pickQuarterReport(filings: Filing[], fy: number, quarter: number): Filing | null {
  const month = quarter * 3;
  const word = quarter === 2 ? /반기보고서/ : /분기보고서/;
  const fs = filings
    .filter((f) => word.test(f.report_nm) && !(quarter !== 2 && /반기보고서/.test(f.report_nm)) && periodOf(f.report_nm)?.y === fy && periodOf(f.report_nm)?.m === month)
    .sort((a, b) => (a.rcept_dt === b.rcept_dt ? (a.rcept_no < b.rcept_no ? -1 : 1) : a.rcept_dt < b.rcept_dt ? -1 : 1));
  const plain = fs.filter((f) => !/정정/.test(f.report_nm));
  return plain[0] ?? fs[0] ?? null;
}

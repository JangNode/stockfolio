// 합성 입력 검증: 추출 규칙이 3차 점검(f65e29a)의 newPick과 동일한지, 보고서 선택·행 생성 규칙이 지시와 맞는지.
import assert from "node:assert/strict";
import { newPick as probeNewPick } from "./probe-dart-xbrl-3rd";
import { newPick, pickReport, buildRow, missReason, type RFact } from "@/lib/dartXbrlExtract";

const C = ["ifrs:ConsolidatedAndSeparateFinancialStatementsAxis=ifrs:ConsolidatedMember"], S = ["ifrs:ConsolidatedAndSeparateFinancialStatementsAxis=ifrs:SeparateMember"];
const f = (local: string, end: string, dims: string[], value: string, dur = true): RFact => ({ local, tag: `ifrs:${local}`, end, start: dur ? `${end.slice(0, 4)}-01-01` : undefined, dims, unit: "KRW", decimals: "0", value });
const facts: RFact[] = [
  f("ProfitLoss", "2012-12-31", S, "10"), f("ProfitLoss", "2012-12-31", [], "20"), f("ProfitLossAttributableToOwnersOfParent", "2012-12-31", C, "30"),
  f("Equity", "2012-12-31", S, "100", false), f("Equity", "2012-12-31", C, "200", false), f("EquityAttributableToOwnersOfParent", "2012-12-31", [], "150", false),
  f("BasicEarningsLossPerShare", "2012-12-31", S, "5"), f("ProfitLoss", "2011-12-31", C, "7"),
  f("ProfitLoss", "2012-12-31", ["ifrs:ComponentsOfEquityAxis=ifrs:IssuedCapitalMember"], "99"),
];
for (const end of ["2012-12-31", "2011-12-31", "2010-12-31"]) for (const it of ["NI", "EQ", "EPS"] as const) {
  const a = newPick(facts, it, end), b = probeNewPick(facts, it, end);
  assert.deepEqual(a && [a.fact.value, a.kind, a.fallback], b && [b.fact.value, b.kind, b.fallback], `${it} ${end}`);
}
assert.equal(newPick(facts, "NI", "2012-12-31")!.fact.value, "30");
assert.equal(newPick(facts, "EQ", "2012-12-31")!.fact.value, "200"); // 컨텍스트가 먼저: 연결 Equity(폴백)가 차원 없음 원본 태그보다 우선
assert.equal(newPick(facts, "EPS", "2012-12-31")!.kind, "별도");
assert.equal(newPick(facts, "NI", "2011-12-31")!.fallback, true);
assert.equal(newPick(facts, "NI", "2010-12-31"), null);
assert.equal(missReason(facts, "NI", "2010-12-31"), "period");
assert.equal(missReason([f("ProfitLoss", "2012-12-31", ["ifrs:ComponentsOfEquityAxis=ifrs:IssuedCapitalMember"], "1")], "NI", "2012-12-31"), "dim");
assert.equal(missReason([], "EPS", "2012-12-31"), "no_tag");

const fl = (nm: string, no: string, dt: string) => ({ report_nm: nm, rcept_no: no, rcept_dt: dt });
const list = [
  fl("[기재정정]사업보고서 (2012.12)", "20130520000001", "20130520"),
  fl("사업보고서 (2012.12)", "20130330000002", "20130330"),
  fl("[첨부추가]사업보고서 (2012.12)", "20130325000003", "20130325"),
  fl("[기재정정]사업보고서 (2013.12)", "20140520000004", "20140520"),
  fl("[첨부정정]사업보고서 (2013.12)", "20140410000005", "20140410"),
  fl("사업보고서 (2014.03)", "20140630000006", "20140630"),
  fl("반기보고서 (2014.06)", "20140815000007", "20140815"),
];
assert.equal(pickReport(list, 2012, 12).filing!.rcept_no, "20130325000003"); // [첨부추가]는 정정이 아님, 접수일 가장 빠른 것
assert.equal(pickReport(list, 2012, 12).amendedOnly, false);
const am = pickReport(list, 2013, 12);
assert.equal(am.filing!.rcept_no, "20140410000005"); assert.equal(am.amendedOnly, true);
assert.equal(pickReport(list, 2014, 12).filing, null); // 3월 결산은 12월 대상이 아님
assert.equal(pickReport(list, 2014, 3).filing!.rcept_no, "20140630000006");

const base = { corp_code: "00000001", stock_code: "000001", fiscal_year: 2012, source: "own" as const };
const full = buildRow(base, pickReport(list, 2012, 12), { kind: "inst", facts }, "2012-12-31", "t");
assert.equal(full.status, "ok"); assert.equal(full.ni_parent, 30); assert.equal(full.ni_basis, "cons"); assert.equal(full.equity_basis, "cons"); assert.equal(full.eps_basis, "sep");
assert.equal(full.rcept_dt, "2013-03-25");
const part = buildRow(base, pickReport(list, 2012, 12), { kind: "inst", facts: facts.filter((x) => !/PerShare/.test(x.local)) }, "2012-12-31", "t");
assert.equal(part.status, "partial"); assert.equal(part.miss_reason, "eps:no_tag"); assert.equal(part.eps_basic, null);
assert.equal(buildRow(base, pickReport(list, 2012, 12), { kind: "014" }, "2012-12-31", "t").status, "xbrl_014");
const amRow = buildRow(base, am, { kind: "inst", facts }, "2012-12-31", "t");
assert.equal(amRow.status, "amended_only");
assert.equal(buildRow(base, pickReport(list, 2014, 12), null, "2014-12-31", "t").status, "no_report");
// 전기(FY2010 prior_col): FY2011 보고서의 2010-12-31 컨텍스트, 접수일은 FY2011 보고서 것
const pf = [f("ProfitLossAttributableToOwnersOfParent", "2010-12-31", C, "11"), f("EquityAttributableToOwnersOfParent", "2010-12-31", C, "22", false), f("BasicEarningsLossPerShare", "2010-12-31", C, "3")];
const prior = buildRow({ ...base, fiscal_year: 2010, source: "prior_col" }, { filing: fl("사업보고서 (2011.12)", "20120330000009", "20120330"), amendedOnly: false }, { kind: "inst", facts: pf }, "2010-12-31", "t");
assert.equal(prior.status, "ok"); assert.equal(prior.rcept_dt, "2012-03-30"); assert.equal(prior.ni_parent, 11);
console.log("합성 검증 통과");

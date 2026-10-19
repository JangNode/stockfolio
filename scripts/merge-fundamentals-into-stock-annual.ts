/**
 * stock_annual_fundamentals에 빠진 (종목, 회계연도)를 연구용 보강 표로 채우는 병합 스크립트.
 *  (a) stock_annual_fundamentals_fill 의 status='ok' 행
 *  (b) dart_xbrl_fundamentals 의 ni_parent·rcept_no·rcept_dt 가 모두 null 이 아닌 행 (FY2010 prior_col 포함)
 * 기본 모드는 --dry-run(DB 읽기만). 실제 삽입은 --apply 일 때만 하며, 이미 같은 (stock_code, fiscal_year)가 있으면
 * 건드리지 않는다(덮어쓰기 금지, ignoreDuplicates). 삽입 키 목록(종목, FY, 소스)은 JSON으로 저장해 되돌릴 수 있게 한다.
 *
 *   tsx --conditions=react-server scripts/merge-fundamentals-into-stock-annual.ts            # dry-run
 *   tsx --conditions=react-server scripts/merge-fundamentals-into-stock-annual.ts --apply    # 실제 삽입(사용자 승인 후에만)
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. 외부 API 호출 없음.
 */
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { pickFundamentalsAsOf, type FundamentalsSeries, type StockFundamentalsAsOf } from "@/lib/pointInTimeFundamentals";
import { selectEpsCagrFiscalYears, computeEpsCagrFromResolvedShares, computePeg, type ListedSharesByFiscalYear } from "@/lib/pegRatio";
import { computeValuationFromSeries } from "@/lib/pointInTimeFundamentals";
import { PEG_MAX_RATIO } from "@/lib/pegConfig";
import { loadFundamentalsSeries } from "@/lib/stockFundamentals";
import { getDailyPriceOnOrBefore } from "@/lib/stockDailyPricesStorage";

const APPLY = process.argv.includes("--apply");
const T0 = Date.now();
const INSERT_BATCH = 200;
// 단위 이상치 기준(원): 절댓값이 1,000조 이상이거나, 0이 아닌데 1,000원 미만이면 단위 오류 후보로 센다.
const UNIT_MAX_ABS_WON = 1e15;
const UNIT_MIN_NONZERO_ABS_WON = 1e3;

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

interface Row { stock_code: string; corp_code: string; fiscal_year: number; fs_div: "CFS" | "OFS"; rcept_no: string; rcept_date: string; net_income_parent: number | null; equity_parent: number | null }
type Src = "fill" | "xbrl";
interface Plan extends Row { src: Src }
interface Existing { stock_code: string; corp_code: string; fiscal_year: number; fs_div: string; rcept_no: string; rcept_date: string; net_income_parent: number | null; equity_parent: number | null }

const num = (x: unknown): number | null => (x === null || x === undefined ? null : Number(x));
function seriesOf(rows: { fiscal_year: number; rcept_no: string; rcept_date: string; net_income_parent: number | null; equity_parent: number | null; fs_div: string }[]): FundamentalsSeries {
  const annual: StockFundamentalsAsOf[] = [...rows]
    .sort((a, b) => (a.rcept_date === b.rcept_date ? a.fiscal_year - b.fiscal_year : a.rcept_date < b.rcept_date ? -1 : 1))
    .map((r) => ({ fiscalYear: r.fiscal_year, rceptNo: r.rcept_no, rceptDate: r.rcept_date, netIncomeParent: r.net_income_parent, equityParent: r.equity_parent, fsDiv: r.fs_div as "CFS" | "OFS" }));
  return { annual, dividends: [] };
}

type InputRow = { fiscal_year: number; rcept_no: string; rcept_date: string; net_income_parent: number | null; equity_parent: number | null; fs_div: string };
/** 스크리닝 peg 판정에 필요한 재무 입력(공시된 최신 순이익, 5년 전 연도쌍, 같은 fs_div)이 오늘 기준으로 갖춰졌는지. */
function classify(rows: InputRow[], extra: InputRow[]): string {
  const all = [...rows, ...extra];
  if (!all.length) return "재무 행 없음";
  const series = seriesOf(all);
  const asOf = new Date().toISOString().slice(0, 10);
  const fund = pickFundamentalsAsOf(series, asOf);
  if (!fund) return "공시된 재무 없음";
  if (fund.netIncomeParent === null) return "최신 순이익 null";
  const pair = selectEpsCagrFiscalYears(series, asOf);
  if (!pair) return "EPS 연도쌍 없음(5년 전 연도 행 없음)";
  if (pair.start.netIncomeParent === null || pair.end.netIncomeParent === null) return "연도쌍 순이익 null";
  if (pair.start.fsDiv !== pair.end.fsDiv) return "연결/별도 불일치";
  return "입력 갖춤";
}

async function main(): Promise<void> {
  console.log(`병합 스크립트 시작 (${APPLY ? "--apply: 실제 삽입" : "--dry-run: 쓰기 없음"}): ${new Date().toISOString()}`);

  // ---- 스키마 확인(실제 응답 키) ----
  const probe = async (t: string): Promise<string[]> => {
    const { data, error } = await supabaseAdmin.from(t).select("*").limit(1);
    if (error) throw new Error(`${t}: ${error.message}`);
    dbRead[`${t}(스키마 확인)`] = (dbRead[`${t}(스키마 확인)`] ?? 0) + (data?.length ?? 0);
    return data && data[0] ? Object.keys(data[0]) : [];
  };
  console.log("\n=== 컬럼 매핑 ===");
  console.log(`stock_annual_fundamentals 실제 컬럼: ${(await probe("stock_annual_fundamentals")).join(", ")}`);
  console.log(`stock_annual_fundamentals_fill 실제 컬럼: ${(await probe("stock_annual_fundamentals_fill")).join(", ")}`);
  console.log(`dart_xbrl_fundamentals 실제 컬럼: ${(await probe("dart_xbrl_fundamentals")).join(", ")}`);
  console.log("대상 표 제약(supabase/migrations/20260827050000_create_dh_strategy_backfill_tables.sql + 20260828010000 rename + 20260908040000 fs_div): PK (stock_code, fiscal_year); NOT NULL: stock_code, corp_code, fiscal_year, rcept_no, rcept_date, fs_div(default 'CFS', check CFS/OFS); nullable: net_income_parent, equity_parent(numeric, 단위 원); 인덱스 (stock_code, rcept_date).");
  console.log("| 대상 컬럼 | fill 표 | dart_xbrl_fundamentals |\n|---|---|---|");
  console.log("| stock_code | stock_code | stock_code |\n| corp_code | corp_code | corp_code |\n| fiscal_year | fiscal_year | fiscal_year (FY2010 = source 'prior_col' 행, 그대로 2010) |");
  console.log("| fs_div | fs_div | ni_basis: cons→CFS, sep→OFS (nodim은 매핑 불가 → 제외·건수 보고) |\n| rcept_no | rcept_no | rcept_no (prior_col 행은 FY2011 보고서 접수번호) |");
  console.log("| rcept_date | rcept_date | rcept_dt (prior_col 행은 FY2011 접수일 그대로) |\n| net_income_parent | net_income_parent | ni_parent |\n| equity_parent | equity_parent | equity_parent |");
  console.log("| (소스 필터) | status='ok' | ni_parent·rcept_no·rcept_dt 모두 not null |");

  // ---- 기존 표 ----
  const existing = await selectAll<Existing>("stock_annual_fundamentals", (f, t) => supabaseAdmin.from("stock_annual_fundamentals").select("stock_code, corp_code, fiscal_year, fs_div, rcept_no, rcept_date, net_income_parent, equity_parent").order("stock_code").order("fiscal_year").range(f, t));
  const exKey = new Map(existing.map((r) => [`${r.stock_code}|${r.fiscal_year}`, r]));
  const exByStock = new Map<string, Existing[]>();
  for (const r of existing) exByStock.set(r.stock_code, [...(exByStock.get(r.stock_code) ?? []), { ...r, net_income_parent: num(r.net_income_parent), equity_parent: num(r.equity_parent) }]);

  // ---- 소스 ----
  const fillRaw = await selectAll<{ stock_code: string; corp_code: string; fiscal_year: number; fs_div: string | null; rcept_no: string | null; rcept_date: string | null; net_income_parent: number | null; equity_parent: number | null; status: string }>("stock_annual_fundamentals_fill", (f, t) => supabaseAdmin.from("stock_annual_fundamentals_fill").select("stock_code, corp_code, fiscal_year, fs_div, rcept_no, rcept_date, net_income_parent, equity_parent, status").order("stock_code").order("fiscal_year").range(f, t));
  const xbrlRaw = await selectAll<{ stock_code: string; corp_code: string; fiscal_year: number; source: string; rcept_no: string | null; rcept_dt: string | null; ni_parent: number | null; equity_parent: number | null; ni_basis: string | null; status: string }>("dart_xbrl_fundamentals", (f, t) => supabaseAdmin.from("dart_xbrl_fundamentals").select("stock_code, corp_code, fiscal_year, source, rcept_no, rcept_dt, ni_parent, equity_parent, ni_basis, status").order("stock_code").order("fiscal_year").range(f, t));

  const excluded: Record<string, number> = {};
  const bump = (k: string): void => { excluded[k] = (excluded[k] ?? 0) + 1; };
  const candidates: Plan[] = [];
  for (const r of fillRaw) {
    if (r.status !== "ok") { bump(`fill: status ${r.status} (대상 아님)`); continue; }
    if (!r.rcept_no || !r.rcept_date || !r.fs_div || !r.stock_code || !r.corp_code) { bump("fill: 필수값 null"); continue; }
    candidates.push({ src: "fill", stock_code: r.stock_code, corp_code: r.corp_code, fiscal_year: r.fiscal_year, fs_div: r.fs_div as "CFS" | "OFS", rcept_no: r.rcept_no, rcept_date: r.rcept_date, net_income_parent: num(r.net_income_parent), equity_parent: num(r.equity_parent) });
  }
  for (const r of xbrlRaw) {
    if (r.ni_parent === null) { bump(`xbrl: ni_parent null (status ${r.status})`); continue; }
    if (!r.rcept_no || !r.rcept_dt) { bump(`xbrl: rcept_no/rcept_dt null (status ${r.status})`); continue; }
    const fs = r.ni_basis === "cons" ? "CFS" : r.ni_basis === "sep" ? "OFS" : null;
    if (!fs) { bump(`xbrl: fs_div 매핑 불가(ni_basis ${r.ni_basis})`); continue; }
    candidates.push({ src: "xbrl", stock_code: r.stock_code, corp_code: r.corp_code, fiscal_year: r.fiscal_year, fs_div: fs, rcept_no: r.rcept_no, rcept_date: r.rcept_dt, net_income_parent: num(r.ni_parent), equity_parent: num(r.equity_parent) });
  }

  // ---- 충돌/중복 처리 ----
  const planned = new Map<string, Plan>();
  let conflictFill = 0, conflictXbrl = 0, dupWithinSources = 0;
  const conflictSame = { same: 0, diff: 0 };
  for (const c of candidates) {
    const k = `${c.stock_code}|${c.fiscal_year}`;
    const ex = exKey.get(k);
    if (ex) {
      if (c.src === "fill") conflictFill++; else conflictXbrl++;
      const same = num(ex.net_income_parent) === c.net_income_parent && ex.fs_div === c.fs_div;
      if (same) conflictSame.same++; else conflictSame.diff++;
      continue;
    }
    if (planned.has(k)) { dupWithinSources++; if (c.src === "fill") planned.set(k, c); continue; } // fill 우선
    planned.set(k, c);
  }
  const allPlanned = [...planned.values()].sort((a, b) => (a.stock_code === b.stock_code ? a.fiscal_year - b.fiscal_year : a.stock_code < b.stock_code ? -1 : 1));

  // ---- 제외 규칙(2026-10-16 사용자 지정): (a) 단위 이상치 (b) rcept_date < 회계연도 12-31 (c) rcept_no 앞 8자리 ≠ rcept_date.
  // 유지: 자본 음수, equity_parent null. ----
  const unitBad = (v: number | null): boolean => v !== null && (Math.abs(v) >= UNIT_MAX_ABS_WON || (v !== 0 && Math.abs(v) < UNIT_MIN_NONZERO_ABS_WON));
  const reasonsOf = (p: Plan): string[] => {
    const r: string[] = [];
    if (unitBad(p.net_income_parent) || unitBad(p.equity_parent)) r.push(`(a) 단위 이상치(${[unitBad(p.net_income_parent) ? "ni" : "", unitBad(p.equity_parent) ? "equity" : ""].filter(Boolean).join("+")})`);
    if (p.rcept_date < `${p.fiscal_year}-12-31`) r.push("(b) rcept_date < 회계연도 12-31");
    if (p.rcept_no.slice(0, 8) !== p.rcept_date.replace(/-/g, "")) r.push("(c) rcept_no 앞 8자리 ≠ rcept_date");
    return r;
  };
  const excludedRows: { p: Plan; reasons: string[] }[] = [];
  const plan: Plan[] = [];
  for (const p of allPlanned) { const reasons = reasonsOf(p); if (reasons.length) excludedRows.push({ p, reasons }); else plan.push(p); }
  console.log(`\n=== 제외 행 (적용 규칙 (a)(b)(c)) — ${excludedRows.length}건 / 후보 ${allPlanned.length}건 ===`);
  console.log("| 종목 | FY | 소스 | 사유 | ni_parent | equity_parent | rcept_no | rcept_date |\n|---|---|---|---|---|---|---|---|");
  for (const { p, reasons } of excludedRows) console.log(`| ${p.stock_code} | ${p.fiscal_year} | ${p.src} | ${reasons.join("; ")} | ${p.net_income_parent} | ${p.equity_parent} | ${p.rcept_no} | ${p.rcept_date} |`);
  const exclCount = { a: 0, b: 0, c: 0 };
  for (const { reasons } of excludedRows) for (const r of reasons) { if (r.startsWith("(a)")) exclCount.a++; else if (r.startsWith("(b)")) exclCount.b++; else exclCount.c++; }
  console.log(`사유별(중복 포함): (a) ${exclCount.a} / (b) ${exclCount.b} / (c) ${exclCount.c}; 소스별: fill ${excludedRows.filter((x) => x.p.src === "fill").length} / xbrl ${excludedRows.filter((x) => x.p.src === "xbrl").length}`);

  // ---- 매핑 이상(제외 후 남은 삽입 예정 행 기준) ----
  const anomalies = { niNull: 0, equityNull: 0, equityNegative: 0, niUnit: 0, equityUnit: 0, rceptMismatch: 0, rceptBeforeFyEnd: 0 };
  for (const p of plan) {
    if (p.net_income_parent === null) anomalies.niNull++;
    if (p.equity_parent === null) anomalies.equityNull++;
    if (p.equity_parent !== null && p.equity_parent < 0) anomalies.equityNegative++;
    if (unitBad(p.net_income_parent)) anomalies.niUnit++;
    if (unitBad(p.equity_parent)) anomalies.equityUnit++;
    if (p.rcept_no.slice(0, 8) !== p.rcept_date.replace(/-/g, "")) anomalies.rceptMismatch++;
    if (p.rcept_date < `${p.fiscal_year}-12-31`) anomalies.rceptBeforeFyEnd++;
  }

  // ---- 보고 ----
  const fys = [...new Set(plan.map((p) => p.fiscal_year))].sort();
  console.log("\n=== 삽입 예정 행 (소스별 × 회계연도) ===");
  console.log(`| 소스 | ${fys.join(" | ")} | 합계 |\n|---|${fys.map(() => "---").join("|")}|---|`);
  for (const s of ["fill", "xbrl"] as Src[]) console.log(`| ${s} | ${fys.map((y) => plan.filter((p) => p.src === s && p.fiscal_year === y).length).join(" | ")} | ${plan.filter((p) => p.src === s).length} |`);
  console.log(`| 합계 | ${fys.map((y) => plan.filter((p) => p.fiscal_year === y).length).join(" | ")} | ${plan.length} |`);
  console.log(`\n읽은 소스 행: fill 표 ${fillRaw.length}행 (ok ${fillRaw.filter((r) => r.status === "ok").length}), dart_xbrl_fundamentals ${xbrlRaw.length}행`);
  console.log(`충돌로 건너뛸 행(이미 같은 (종목, FY)가 stock_annual_fundamentals에 있음): fill ${conflictFill}건, xbrl ${conflictXbrl}건 (그중 기존 값과 net_income_parent·fs_div가 같음 ${conflictSame.same} / 다름 ${conflictSame.diff})`);
  console.log(`소스 간 중복((종목, FY)가 fill·xbrl 모두 후보): ${dupWithinSources}건 → fill 우선`);
  console.log("대상에서 제외된 소스 행:");
  console.log("| 사유 | 건수 |\n|---|---|");
  for (const [k, v] of Object.entries(excluded).sort((a, b) => b[1] - a[1])) console.log(`| ${k} | ${v} |`);
  console.log("\n매핑 이상(삽입 예정 행 기준):");
  console.log("| 항목 | 건수 |\n|---|---|");
  console.log(`| net_income_parent null (fill 소스; 기존 표에서도 허용되는 nullable) | ${anomalies.niNull} |`);
  console.log(`| equity_parent null (nullable) | ${anomalies.equityNull} |`);
  console.log(`| equity_parent 음수(자본잠식) | ${anomalies.equityNegative} |`);
  console.log(`| 단위 이상치 net_income_parent (|값|≥1e15 또는 0<|값|<1e3 원) | ${anomalies.niUnit} |`);
  console.log(`| 단위 이상치 equity_parent | ${anomalies.equityUnit} |`);
  console.log(`| rcept_no 앞 8자리 ≠ rcept_date | ${anomalies.rceptMismatch} (FY2010 prior_col은 FY2011 접수일이라 rcept_no도 FY2011 것) |`);
  console.log(`| rcept_date < 회계연도 12-31 | ${anomalies.rceptBeforeFyEnd} |`);

  // ---- 병합 후 예상 ----
  const afterStocks = new Set([...existing.map((r) => r.stock_code), ...plan.map((p) => p.stock_code)]);
  const beforeStocks = new Set(existing.map((r) => r.stock_code));
  const fyBefore = new Map<number, number>(), fyAfter = new Map<number, number>();
  for (const r of existing) { fyBefore.set(r.fiscal_year, (fyBefore.get(r.fiscal_year) ?? 0) + 1); fyAfter.set(r.fiscal_year, (fyAfter.get(r.fiscal_year) ?? 0) + 1); }
  for (const p of plan) fyAfter.set(p.fiscal_year, (fyAfter.get(p.fiscal_year) ?? 0) + 1);
  console.log("\n=== 병합 후 stock_annual_fundamentals 예상 ===");
  console.log(`행 수 ${existing.length} → ${existing.length + plan.length} (+${plan.length}); 종목 수 ${beforeStocks.size} → ${afterStocks.size} (+${afterStocks.size - beforeStocks.size})`);
  const allFy = [...new Set([...fyBefore.keys(), ...fyAfter.keys()])].sort();
  console.log("| FY | 현재 | 병합 후 |\n|---|---|---|");
  for (const y of allFy) console.log(`| ${y} | ${fyBefore.get(y) ?? 0} | ${fyAfter.get(y) ?? 0} |`);

  // ---- 적용 전 기존 상태 해시 ----
  const sha = (lines: string[]): string => createHash("sha256").update(lines.join("\n")).digest("hex");
  const rowLine = (r: Existing): string => [r.stock_code, r.fiscal_year, r.net_income_parent === null ? "" : Number(r.net_income_parent), r.equity_parent === null ? "" : Number(r.equity_parent), r.fs_div, r.rcept_no, r.rcept_date, r.corp_code].join("|");
  const preKeys = existing.map((r) => `${r.stock_code}|${r.fiscal_year}`).sort();
  const preKeyHash = sha(preKeys);
  const preRowHash = sha([...existing].sort((a, b) => (a.stock_code === b.stock_code ? a.fiscal_year - b.fiscal_year : a.stock_code < b.stock_code ? -1 : 1)).map(rowLine));
  console.log(`\n적용 전 기존 표: 행 ${existing.length}, 키 집합 SHA-256 ${preKeyHash.slice(0, 16)}…, 값 포함 행 해시 ${preRowHash.slice(0, 16)}…`);

  // ---- 삽입 키 JSON ----
  const keysFile = APPLY ? "docs/peg-fundamentals-merge-applied-keys.json" : `merge-fundamentals-plan-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const keysJson = JSON.stringify({ mode: APPLY ? "apply" : "dry-run", created_at: new Date().toISOString(), rule: "excluded: (a) unit outlier |v|>=1e15 or 0<|v|<1e3 won, (b) rcept_date < FY-12-31, (c) rcept_no[0:8] != rcept_date", count: plan.length, keys: plan.map((p) => ({ stock_code: p.stock_code, fiscal_year: p.fiscal_year, source: p.src === "fill" ? "stock_annual_fundamentals_fill" : "dart_xbrl_fundamentals" })) }, null, 1);
  writeFileSync(keysFile, keysJson);
  console.log(`삽입 키 목록 JSON: ${keysFile} (${plan.length}건; 되돌리기 = 이 목록의 (stock_code, fiscal_year) 행만 삭제)`);

  // ---- 적용 ----
  let written = 0;
  if (APPLY) {
    console.log("\n--apply: 삽입 시작(같은 (종목, FY)가 있으면 건드리지 않음)");
    for (let i = 0; i < plan.length; i += INSERT_BATCH) {
      const batch = plan.slice(i, i + INSERT_BATCH).map((p) => ({ stock_code: p.stock_code, corp_code: p.corp_code, fiscal_year: p.fiscal_year, fs_div: p.fs_div, rcept_no: p.rcept_no, rcept_date: p.rcept_date, net_income_parent: p.net_income_parent, equity_parent: p.equity_parent }));
      const { error } = await supabaseAdmin.from("stock_annual_fundamentals").upsert(batch, { onConflict: "stock_code,fiscal_year", ignoreDuplicates: true });
      if (error) throw new Error(`삽입 실패(배치 ${i / INSERT_BATCH}): ${error.message}`);
      written += batch.length;
    }
    console.log(`삽입 전송 ${written}행`);
    const gz = gzipSync(Buffer.from(keysJson)).toString("base64");
    console.log(`삽입 키 JSON(gzip+base64, 복원: base64 -d | gunzip), ${gz.length}자:`);
    for (let i = 0; i < gz.length; i += 3000) console.log(`KEYS_B64 ${gz.slice(i, i + 3000)}`);
  } else {
    console.log("\n--dry-run: 쓰기 없음");
  }

  // ---- 적용 후 검증(읽기) ----
  let postRows: Existing[] = existing;
  try {
  if (APPLY) {
    postRows = await selectAll<Existing>("stock_annual_fundamentals(적용 후)", (f, t) => supabaseAdmin.from("stock_annual_fundamentals").select("stock_code, corp_code, fiscal_year, fs_div, rcept_no, rcept_date, net_income_parent, equity_parent").order("stock_code").order("fiscal_year").range(f, t));
    const postStocks = new Set(postRows.map((r) => r.stock_code));
    const expectRows = 9988 - excludedRows.length;
    console.log("\n=== 2. 적용 후 검증 ===");
    console.log("| 소스 | " + fys.join(" | ") + " | 합계 |\n|---|" + fys.map(() => "---").join("|") + "|---|");
    for (const sname of ["fill", "xbrl"] as Src[]) console.log(`| ${sname} 삽입 | ${fys.map((y) => plan.filter((p) => p.src === sname && p.fiscal_year === y).length).join(" | ")} | ${plan.filter((p) => p.src === sname).length} |`);
    console.log(`제외 행 ${excludedRows.length}건(규칙별 중복 포함: (a) ${exclCount.a} / (b) ${exclCount.b} / (c) ${exclCount.c})`);
    console.log(`적용 후 stock_annual_fundamentals: 행 ${postRows.length} (적용 전 ${existing.length} + 삽입 ${plan.length} = ${existing.length + plan.length}; 드라이런 예상 9,988 − 제외 ${excludedRows.length} = ${expectRows}) → ${postRows.length === expectRows ? "일치" : "불일치"}; 종목 ${postStocks.size} (드라이런 예상 1,062; 제외 행만으로 사라진 종목 ${[...new Set(excludedRows.map((x) => x.p.stock_code))].filter((c) => !postStocks.has(c)).length}개)`);
    const preSet = new Set(preKeys);
    const postPre = postRows.filter((r) => preSet.has(`${r.stock_code}|${r.fiscal_year}`));
    const postKeyHash = sha(postPre.map((r) => `${r.stock_code}|${r.fiscal_year}`).sort());
    const postRowHash = sha([...postPre].sort((a, b) => (a.stock_code === b.stock_code ? a.fiscal_year - b.fiscal_year : a.stock_code < b.stock_code ? -1 : 1)).map(rowLine));
    console.log(`기존 키 ${preKeys.length}개 중 적용 후 존재 ${postPre.length}개; 키 집합 해시 ${postKeyHash === preKeyHash ? "일치" : "불일치"} (${postKeyHash.slice(0, 16)}…); 값 포함 행 해시 ${postRowHash === preRowHash ? "일치" : "불일치"} (${postRowHash.slice(0, 16)}…)`);
    const fyAfter2 = new Map<number, number>();
    for (const r of postRows) fyAfter2.set(r.fiscal_year, (fyAfter2.get(r.fiscal_year) ?? 0) + 1);
    console.log("적용 후 FY 분포: " + [...fyAfter2.entries()].sort((a, b) => a[0] - b[0]).map(([y, n]) => `${y}:${n}`).join(", "));

    // loadFundamentalsSeries 확인
    const sorted = [...postStocks].sort();
    const rng = mulberry32(20261016);
    const sh = [...sorted];
    for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
    console.log("\nloadFundamentalsSeries 확인 (무작위 10종목, 시드 20261016) + 005930");
    console.log("| 종목 | 반환 행 | 회계연도 | 신규 삽입 FY |\n|---|---|---|---|");
    const insertedBy = new Map<string, number[]>();
    for (const p of plan) insertedBy.set(p.stock_code, [...(insertedBy.get(p.stock_code) ?? []), p.fiscal_year]);
    for (const code of [...sh.slice(0, 10), "005930"]) {
      const series = await loadFundamentalsSeries(code);
      dbRead["loadFundamentalsSeries(annual+dividend 별도 집계 없음)"] = (dbRead["loadFundamentalsSeries(annual+dividend 별도 집계 없음)"] ?? 0) + series.annual.length + series.dividends.length;
      const fysRet = series.annual.map((a) => a.fiscalYear).sort((a, b) => a - b);
      console.log(`| ${code} | ${series.annual.length} | ${fysRet.join(",")} | ${(insertedBy.get(code) ?? []).sort().join(",") || "-"} |`);
      if (code === "005930") {
        const missing = Array.from({ length: 16 }, (_, i) => 2010 + i).filter((y) => !fysRet.includes(y));
        console.log(`005930 FY2010~2025 중 없는 연도: ${missing.length ? missing.join(",") : "없음(전부 있음)"}`);
      }
    }
  }
  } catch (e) { console.log(`[적용 후 검증] 오류: ${e instanceof Error ? e.message : String(e)}`); }

  // ---- 3. 스크리닝 입력/후보 (읽기) ----
  try {
  console.log("\n=== 3-c. 오늘 기준 peg 입력·후보 (시총 ≥ 5,000억 풀, hot 표 최근 2거래일) ===");
  const { data: dts, error: dtErr } = await supabaseAdmin.from("stock_daily_prices_recent").select("trade_date").order("trade_date", { ascending: false }).limit(1);
  if (dtErr) throw new Error(dtErr.message);
  const asOf = dts?.[0]?.trade_date as string;
  const { data: dts2, error: dt2Err } = await supabaseAdmin.from("stock_daily_prices_recent").select("trade_date").lt("trade_date", asOf).order("trade_date", { ascending: false }).limit(1);
  if (dt2Err) throw new Error(dt2Err.message);
  const prevDate = dts2?.[0]?.trade_date as string;
  dbRead["stock_daily_prices_recent(날짜)"] = 2;
  type Bar = { stock_code: string; close_price: number; market_cap_eok: number; listed_shares: number };
  const barsOn = async (d: string): Promise<Map<string, Bar>> => {
    const rs = await selectAll<Bar>(`stock_daily_prices_recent(${d})`, (f, t) => supabaseAdmin.from("stock_daily_prices_recent").select("stock_code, close_price, market_cap_eok, listed_shares").eq("trade_date", d).range(f, t));
    return new Map(rs.map((r) => [r.stock_code, { ...r, close_price: Number(r.close_price), market_cap_eok: Number(r.market_cap_eok), listed_shares: Number(r.listed_shares) }]));
  };
  const todayBars = await barsOn(asOf), prevBars = await barsOn(prevDate);
  console.log(`기준일 ${asOf}(직전 ${prevDate}), 행 ${todayBars.size}/${prevBars.size}종목`);
  const planByStock = new Map<string, Plan[]>();
  for (const p of plan) planByStock.set(p.stock_code, [...(planByStock.get(p.stock_code) ?? []), p]);
  const sharesMemo = new Map<string, number | null>();
  const sharesAt = async (code: string, date: string): Promise<number | null> => {
    const k = `${code}|${date}`;
    if (sharesMemo.has(k)) return sharesMemo.get(k)!;
    const row = await getDailyPriceOnOrBefore(code, date);
    const v = row ? row.listedShares : null;
    sharesMemo.set(k, v);
    return v;
  };
  const stateAt = async (code: string, series: FundamentalsSeries, date: string, bar: Bar | undefined): Promise<boolean | undefined> => {
    if (!bar) return undefined;
    const fund = pickFundamentalsAsOf(series, date);
    if (!fund || fund.netIncomeParent === null) return undefined;
    if (fund.netIncomeParent <= 0) return false;
    const { per } = computeValuationFromSeries(bar.close_price, bar.listed_shares, fund);
    const pair = selectEpsCagrFiscalYears(series, date);
    if (!pair) return undefined;
    const ls: ListedSharesByFiscalYear = new Map([[pair.start.fiscalYear, await sharesAt(code, pair.start.rceptDate)], [pair.end.fiscalYear, await sharesAt(code, pair.end.rceptDate)]]);
    const peg = computePeg(per, computeEpsCagrFromResolvedShares(pair, ls));
    if (peg === null) return false;
    return peg <= PEG_MAX_RATIO;
  };
  const pool = [...todayBars.values()].filter((b) => b.market_cap_eok >= 5000).map((b) => b.stock_code).sort();
  const exByStock2 = new Map<string, Existing[]>();
  for (const r of postRows) exByStock2.set(r.stock_code, [...(exByStock2.get(r.stock_code) ?? []), r]);
  const insertedKeySet = new Set(plan.map((p) => `${p.stock_code}|${p.fiscal_year}`));
  const results: { code: string; preInput: boolean; postInput: boolean; preTrue: boolean; postTrue: boolean; preNew: boolean; postNew: boolean; postComputable: boolean; preComputable: boolean }[] = [];
  for (const code of pool) {
    const postRowsOf = exByStock2.get(code) ?? [];
    const preRowsOf = postRowsOf.filter((r) => !(APPLY && insertedKeySet.has(`${r.stock_code}|${r.fiscal_year}`)));
    const postAll = APPLY ? postRowsOf : [...postRowsOf, ...(planByStock.get(code) ?? []).map((p) => ({ ...p }))];
    const preS = seriesOf(preRowsOf), postS = seriesOf(postAll);
    const preInput = classify(preRowsOf, []) === "입력 갖춤", postInput = classify(postAll, []) === "입력 갖춤";
    const t = async (S: FundamentalsSeries, input: boolean): Promise<{ today: boolean | undefined; prev: boolean | undefined }> => input ? { today: await stateAt(code, S, asOf, todayBars.get(code)), prev: await stateAt(code, S, prevDate, prevBars.get(code)) } : { today: undefined, prev: undefined };
    const a = await t(preS, preInput), b = await t(postS, postInput);
    results.push({ code, preInput, postInput, preComputable: a.today !== undefined, postComputable: b.today !== undefined, preTrue: a.today === true, postTrue: b.today === true, preNew: a.prev === false && a.today === true, postNew: b.prev === false && b.today === true });
  }
  const newlyInput = results.filter((r) => !r.preInput && r.postInput);
  console.log("| 구분 | 종목 수 | 입력 갖춤 | 판정 가능(상태 정의됨) | PEG ≤ 1.0(오늘 true) | 신규 진입 전환(전일 false → 오늘 true) |\n|---|---|---|---|---|---|");
  console.log(`| 풀 전체, 병합 전 | ${results.length} | ${results.filter((r) => r.preInput).length} | ${results.filter((r) => r.preComputable).length} | ${results.filter((r) => r.preTrue).length} | ${results.filter((r) => r.preNew).length} |`);
  console.log(`| 풀 전체, 병합 후 | ${results.length} | ${results.filter((r) => r.postInput).length} | ${results.filter((r) => r.postComputable).length} | ${results.filter((r) => r.postTrue).length} | ${results.filter((r) => r.postNew).length} |`);
  console.log(`| 입력이 새로 갖춰진 종목(병합 후 기준) | ${newlyInput.length} | ${newlyInput.length} | ${newlyInput.filter((r) => r.postComputable).length} | ${newlyInput.filter((r) => r.postTrue).length} | ${newlyInput.filter((r) => r.postNew).length} |`);
  console.log(`새로 true가 된 종목(병합 전 false/undefined → 병합 후 true): ${results.filter((r) => !r.preTrue && r.postTrue).length}개: ${results.filter((r) => !r.preTrue && r.postTrue).map((r) => r.code).join(",") || "-"}`);
  } catch (e) { console.log(`[3-c] 오류: ${e instanceof Error ? e.message : String(e)}`); }

  // ---- 3-b. screening_runs / 결과 ----
  try {
  console.log("\n=== 3-b. screening_runs 최근 10건과 전략별 신규 매칭(그 실행 시간 구간의 screening_results.matched_at) ===");
  const { data: runsData, error: runsErr } = await supabaseAdmin.from("screening_runs").select("*").order("started_at", { ascending: false }).limit(10);
  if (runsErr) throw new Error(runsErr.message);
  const runs = (runsData ?? []) as { started_at: string; finished_at: string; scanned_count: number; matched_count: number; error_count: number; market?: string }[];
  dbRead["screening_runs(최근)"] = runs.length;
  const strategies = await selectAll<{ id: string; rule_type: string; name: string }>("strategies(전체)", (f, t) => supabaseAdmin.from("strategies").select("id, rule_type, name").range(f, t));
  const typeOf = new Map(strategies.map((x) => [x.id, x.rule_type]));
  const since = runs.length ? runs[runs.length - 1].started_at : new Date().toISOString();
  const resAll = await selectAll<{ strategy_id: string; status: string; matched_at: string }>("screening_results(최근 실행 구간)", (f, t) => supabaseAdmin.from("screening_results").select("strategy_id, status, matched_at").gte("matched_at", since).range(f, t));
  const activeAll = await selectAll<{ strategy_id: string }>("screening_results(active)", (f, t) => supabaseAdmin.from("screening_results").select("strategy_id").eq("status", "active").range(f, t));
  const typeList = [...new Set(strategies.map((x) => x.rule_type))].sort();
  console.log(`| 시작(UTC) | 종료(UTC) | market | 스캔 | 매칭(합산) | 오류 | ${typeList.map((t2) => `신규 ${t2}`).join(" | ")} |\n|---|---|---|---|---|---|${typeList.map(() => "---").join("|")}|`);
  for (const r of runs) {
    const inRun = resAll.filter((x) => x.matched_at >= r.started_at && x.matched_at <= r.finished_at);
    console.log(`| ${r.started_at.slice(0, 16)} | ${r.finished_at.slice(0, 16)} | ${r.market ?? "-"} | ${r.scanned_count} | ${r.matched_count} | ${r.error_count} | ${typeList.map((t2) => inRun.filter((x) => typeOf.get(x.strategy_id) === t2).length).join(" | ")} |`);
  }
  console.log(`현재 active 행(전략 유형별): ${typeList.map((t2) => `${t2} ${activeAll.filter((x) => typeOf.get(x.strategy_id) === t2).length}`).join(" | ")} (합계 ${activeAll.length})`);
  } catch (e) { console.log(`[3-b] 오류: ${e instanceof Error ? e.message : String(e)}`); }

  console.log("\n=== 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: ${written} | 외부 요청(DART/KIS 등): 0 | 소요 ${((Date.now() - T0) / 1000).toFixed(0)}초`);
}
function mulberry32(a: number): () => number {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
main().catch((e) => { console.error(e); process.exit(1); });

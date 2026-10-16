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
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { pickFundamentalsAsOf, type FundamentalsSeries, type StockFundamentalsAsOf } from "@/lib/pointInTimeFundamentals";
import { selectEpsCagrFiscalYears } from "@/lib/pegRatio";

const APPLY = process.argv.includes("--apply");
const T0 = Date.now();
const INSERT_BATCH = 200;
// 단위 이상치 기준(원): 절댓값이 1,000조 이상이거나, 0이 아닌데 1,000원 미만이면 단위 오류 후보로 센다.
const UNIT_MAX_ABS_WON = 1e15;
const UNIT_MIN_NONZERO_ABS_WON = 1e3;
// 스크리닝 대상 풀 근사: 가장 최근 hot 거래일의 시가총액(억원). 실제 풀은 lib/stockDataConfig.ts의 1조(과거 이력 포함)다.
const POOL_CAP_EOK = [10_000, 5_000] as const;
const MS_DAY = 86_400_000;

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
const mean = (v: number[]): number => (v.length ? v.reduce((a, x) => a + x, 0) / v.length : NaN);

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
  const plan = [...planned.values()].sort((a, b) => (a.stock_code === b.stock_code ? a.fiscal_year - b.fiscal_year : a.stock_code < b.stock_code ? -1 : 1));

  // ---- 매핑 이상 ----
  const anomalies = { niNull: 0, equityNull: 0, equityNegative: 0, niUnit: 0, equityUnit: 0, rceptMismatch: 0, rceptBeforeFyEnd: 0 };
  const unitBad = (v: number | null): boolean => v !== null && (Math.abs(v) >= UNIT_MAX_ABS_WON || (v !== 0 && Math.abs(v) < UNIT_MIN_NONZERO_ABS_WON));
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

  // ---- 삽입 키 JSON ----
  const keysFile = `merge-fundamentals-${APPLY ? "applied" : "plan"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(keysFile, JSON.stringify({ mode: APPLY ? "apply" : "dry-run", created_at: new Date().toISOString(), keys: plan.map((p) => ({ stock_code: p.stock_code, fiscal_year: p.fiscal_year, source: p.src === "fill" ? "stock_annual_fundamentals_fill" : "dart_xbrl_fundamentals" })) }, null, 1));
  console.log(`\n삽입 키 목록 JSON: ${keysFile} (${plan.length}건; 되돌리기 = 이 목록의 (stock_code, fiscal_year)에 해당하는 행만 삭제)`);

  // ---- 스크리닝 입력 완비도(읽기 전용 추정) ----
  console.log("\n=== 스크리닝 peg 입력 완비도 추정 (오늘 기준 EPS 연도쌍·순이익) ===");
  const { data: latest, error: latestErr } = await supabaseAdmin.from("stock_daily_prices_recent").select("trade_date").order("trade_date", { ascending: false }).limit(1);
  if (latestErr) throw new Error(`stock_daily_prices_recent: ${latestErr.message}`);
  dbRead["stock_daily_prices_recent(최근일)"] = latest?.length ?? 0;
  const asOf = latest?.[0]?.trade_date as string | undefined;
  if (!asOf) throw new Error("stock_daily_prices_recent 최근 거래일을 찾지 못했습니다.");
  const today = await selectAll<{ stock_code: string; market_cap_eok: number }>("stock_daily_prices_recent(최근일 시총)", (f, t) => supabaseAdmin.from("stock_daily_prices_recent").select("stock_code, market_cap_eok").eq("trade_date", asOf).range(f, t));
  console.log(`기준일(hot 표 최근 거래일) ${asOf}, 그날 행 ${today.length}개 종목`);
  const classify = (rows: Existing[] | undefined, extra: Plan[]): string => {
    const all = [...(rows ?? []), ...extra.map((p) => ({ ...p }))];
    if (!all.length) return "재무 행 없음";
    const series = seriesOf(all);
    const fund = pickFundamentalsAsOf(series, asOf);
    if (!fund) return "공시된 재무 없음";
    if (fund.netIncomeParent === null) return "최신 순이익 null";
    const pair = selectEpsCagrFiscalYears(series, asOf);
    if (!pair) return "EPS 연도쌍 없음(5년 전 연도 행 없음)";
    if (pair.start.netIncomeParent === null || pair.end.netIncomeParent === null) return "연도쌍 순이익 null";
    if (pair.start.fsDiv !== pair.end.fsDiv) return "연결/별도 불일치";
    return "입력 갖춤";
  };
  const planBy = new Map<string, Plan[]>();
  for (const p of plan) planBy.set(p.stock_code, [...(planBy.get(p.stock_code) ?? []), p]);
  const cats = ["재무 행 없음", "공시된 재무 없음", "최신 순이익 null", "EPS 연도쌍 없음(5년 전 연도 행 없음)", "연도쌍 순이익 null", "연결/별도 불일치", "입력 갖춤"];
  console.log("| 풀(기준일 시총) | 종목 수 | 구분 | " + cats.join(" | ") + " |\n|---|---|---|" + cats.map(() => "---").join("|") + "|");
  for (const cap of POOL_CAP_EOK) {
    const pool = today.filter((r) => Number(r.market_cap_eok) >= cap).map((r) => r.stock_code);
    for (const [lab, withPlan] of [["현재", false], ["병합 후", true]] as const) {
      const cnt = new Map<string, number>();
      for (const c of pool) { const k = classify(exByStock.get(c), withPlan ? planBy.get(c) ?? [] : []); cnt.set(k, (cnt.get(k) ?? 0) + 1); }
      console.log(`| 시총 ≥ ${cap}억 | ${pool.length} | ${lab} | ${cats.map((k) => cnt.get(k) ?? 0).join(" | ")} |`);
    }
  }

  // ---- 최근 스크리닝 결과 ----
  const strategies = await selectAll<{ id: string }>("strategies(peg_lynch)", (f, t) => supabaseAdmin.from("strategies").select("id").eq("rule_type", "peg_lynch").range(f, t));
  const ids = strategies.map((s) => s.id);
  console.log(`\n=== 최근 peg_lynch 스크리닝 결과 (전략 행 ${ids.length}개) ===`);
  if (ids.length) {
    const since = new Date(Date.now() - 30 * MS_DAY).toISOString();
    const res = await selectAll<{ stock_code: string; status: string; matched_at: string }>("screening_results(peg_lynch)", (f, t) => supabaseAdmin.from("screening_results").select("stock_code, status, matched_at").in("strategy_id", ids).gte("matched_at", since).order("matched_at", { ascending: false }).range(f, t));
    const byDay = new Map<string, number>();
    for (const r of res) byDay.set(r.matched_at.slice(0, 10), (byDay.get(r.matched_at.slice(0, 10)) ?? 0) + 1);
    const byStatus = new Map<string, number>();
    for (const r of res) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    console.log(`최근 30일 매칭 행 ${res.length}건, 서로 다른 종목 ${new Set(res.map((r) => r.stock_code)).size}개, 상태별: ${[...byStatus.entries()].map(([k, v]) => `${k} ${v}`).join(" | ") || "-"}`);
    console.log(`매칭 발생 일수 ${byDay.size}일, 일별 평균 ${mean([...byDay.values()]).toFixed(2)}건, 최대 ${Math.max(0, ...byDay.values())}건`);
    const active = await selectAll<{ stock_code: string }>("screening_results(peg_lynch active)", (f, t) => supabaseAdmin.from("screening_results").select("stock_code").in("strategy_id", ids).eq("status", "active").range(f, t));
    console.log(`현재 active 행 ${active.length}건 (서로 다른 종목 ${new Set(active.map((r) => r.stock_code)).size}개)`);
  }
  const { data: runsData, error: runsErr } = await supabaseAdmin.from("screening_runs").select("started_at, scanned_count, matched_count, error_count").order("started_at", { ascending: false }).limit(10);
  if (runsErr) throw new Error(`screening_runs: ${runsErr.message}`);
  const runs = (runsData ?? []) as { started_at: string; scanned_count: number; matched_count: number; error_count: number }[];
  dbRead["screening_runs(최근)"] = runs.length;
  console.log("screening_runs 최근 10건(전 전략 합산 매칭 수):");
  console.log("| 시작 | 스캔 | 매칭 | 오류 |\n|---|---|---|---|");
  for (const r of runs.slice(0, 10)) console.log(`| ${r.started_at.slice(0, 16)} | ${r.scanned_count} | ${r.matched_count} | ${r.error_count} |`);

  // ---- 적용 ----
  let written = 0;
  if (APPLY) {
    console.log("\n--apply: 삽입 시작(충돌 시 건드리지 않음)");
    for (let i = 0; i < plan.length; i += INSERT_BATCH) {
      const batch = plan.slice(i, i + INSERT_BATCH).map((p) => ({ stock_code: p.stock_code, corp_code: p.corp_code, fiscal_year: p.fiscal_year, fs_div: p.fs_div, rcept_no: p.rcept_no, rcept_date: p.rcept_date, net_income_parent: p.net_income_parent, equity_parent: p.equity_parent }));
      const { error } = await supabaseAdmin.from("stock_annual_fundamentals").upsert(batch, { onConflict: "stock_code,fiscal_year", ignoreDuplicates: true });
      if (error) throw new Error(`삽입 실패(배치 ${i / INSERT_BATCH}): ${error.message}`);
      written += batch.length;
    }
  } else {
    console.log("\n--dry-run: 쓰기 없음");
  }
  console.log("\n=== 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: ${written} | 외부 요청(DART/KIS 등): 0 | 소요 ${((Date.now() - T0) / 1000).toFixed(0)}초`);
}
main().catch((e) => { console.error(e); process.exit(1); });

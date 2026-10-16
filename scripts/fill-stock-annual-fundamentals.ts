/**
 * [연구용, 병합 금지] stock_annual_fundamentals에 없는 (종목, FY2015~2025)를 새 표 stock_annual_fundamentals_fill에 채우고
 * peg 커버리지를 재측정한다. 조회·추출 로직은 scripts/backfill-stock-annual-fundamentals.ts와 동일하다
 * (fnlttSinglAcntAll, reprt_code=11011, 연결 CFS 우선·없으면(013) 별도 OFS 폴백, lib/dartFundamentalsParse.ts의 parseFundamentalsList,
 * rcept_no = 응답 list[0].rcept_no — 최초/정정 선택 없이 DART가 그 사업연도에 대해 돌려주는 보고서를 그대로 쓴다).
 * 다른 점: 동시 4·최소 간격·429/5xx 최대 2회 재시도(요청 지시), 013도 1행 저장, 사업보고서 기간 말이 12월이 아니면 no_report.
 * 대상 선정·재측정은 scripts/pegCoverageCore.ts(커밋 561a1a5 정의와 동일). DB는 REST만. 기존 표는 읽기만.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { parseFundamentalsList, type DartAccountRow } from "@/lib/dartFundamentalsParse";
import { loadCtx, buildAnnual, judge, classify, expectedFy, selectAll, printCoverage, printClassification, printSurvival, printStartMiss, type Ann, type Ctx } from "./pegCoverageCore";

const DART_BASE_URL = "https://opendart.fss.or.kr/api";
const FILL_TABLE = "stock_annual_fundamentals_fill";
const FY_FROM = 2015;
const FY_TO = 2025;
const MAX_REQUESTS = 8000;
const CONCURRENCY = 4;
const MIN_GAP_MS = 100;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 2000;
const SOFT_DEADLINE_MIN = 120;
const UPSERT_BATCH = 200;
const PROGRESS_EVERY = 200;
const VALIDATE_N = 30;
const VALIDATE_FY = 2020;
const SEED = 20261016;
const T0 = Date.now();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function mulberry32(a: number): () => number {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

let used = 0, limitHit = false, budgetHit = false, nextSlot = 0;
async function slot(): Promise<void> { const now = Date.now(); const s = Math.max(now, nextSlot); nextSlot = s + MIN_GAP_MS; if (s > now) await sleep(s - now); }

type CallRes = { kind: "list"; list: (DartAccountRow & { thstrm_dt?: string })[] } | { kind: "013" } | { kind: "error"; note: string } | { kind: "stop" };
async function callSingl(corp: string, fy: number, fsDiv: "CFS" | "OFS", key: string): Promise<CallRes> {
  const url = `${DART_BASE_URL}/fnlttSinglAcntAll.json?crtfc_key=${key}&corp_code=${corp}&bsns_year=${fy}&reprt_code=11011&fs_div=${fsDiv}`;
  let note = "";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (limitHit || budgetHit) return { kind: "stop" };
    if (used >= MAX_REQUESTS) { budgetHit = true; return { kind: "stop" }; }
    await slot();
    used++;
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return { kind: "error", note: `HTTP ${res.status}` };
      const body = (await res.json()) as { status: string; list?: (DartAccountRow & { thstrm_dt?: string })[] };
      if (body.status === "020") { limitHit = true; return { kind: "stop" }; }
      if (body.status === "800") throw new Error("status 800");
      if (body.status === "013") return { kind: "013" };
      if (body.status !== "000" || !body.list || body.list.length === 0) return { kind: "error", note: `status ${body.status}` };
      return { kind: "list", list: body.list };
    } catch (e) {
      note = e instanceof Error ? e.message : String(e);
      if (attempt < MAX_RETRIES) await sleep(RETRY_BASE_MS * 2 ** attempt);
    }
  }
  return { kind: "error", note };
}

export interface Fetched { status: "ok" | "no_data_013" | "no_report" | "error" | "stop"; fsDiv?: "CFS" | "OFS"; rceptNo?: string; rceptDate?: string; ni?: number | null; eq?: number | null; periodUnknown?: boolean; note?: string }
async function fetchOne(corp: string, fy: number, key: string): Promise<Fetched> {
  let r = await callSingl(corp, fy, "CFS", key);
  let fsDiv: "CFS" | "OFS" = "CFS";
  if (r.kind === "013") { r = await callSingl(corp, fy, "OFS", key); fsDiv = "OFS"; }
  if (r.kind === "stop") return { status: "stop" };
  if (r.kind === "error") return { status: "error", note: r.note };
  if (r.kind === "013") return { status: "no_data_013" };
  const p = parseFundamentalsList(r.list);
  const dates = r.list.map((x) => x.thstrm_dt).filter((x): x is string => !!x).map((x) => [...x.matchAll(/\d{4}\.\d{2}\.\d{2}/g)].map((m) => m[0]).pop()).filter((x): x is string => !!x);
  const endMonth = dates.length ? Number(dates[0].slice(5, 7)) : null;
  if (endMonth !== null && endMonth !== 12) return { status: "no_report", fsDiv, rceptNo: p.rceptNo, rceptDate: p.rceptDate, note: `기간 말 ${dates[0]}` };
  return { status: "ok", fsDiv, rceptNo: p.rceptNo, rceptDate: p.rceptDate, ni: p.netIncomeParent, eq: p.equityParent, periodUnknown: endMonth === null };
}

function neededPairs(ctx: Ctx, annualAll: Map<string, Ann[]>, cats: Map<string, "a" | "b" | "c">): Map<string, Set<number>> {
  void annualAll;
  const need = new Map<string, Set<number>>();
  for (const code of cats.keys()) {
    const have = new Set((ctx.stockRows.get(code) ?? []).map((a) => a.fy));
    const minFy = Math.min(...(ctx.stockRows.get(code) ?? []).map((a) => a.fy), 9999);
    const s = new Set<number>();
    for (const d of ctx.monthEnds) {
      if (d < "2016-03-01" || !(ctx.members.get(d) ?? []).includes(code)) continue;
      const e = expectedFy(d);
      for (const y of [e, e - 5]) {
        if (y < FY_FROM || y > FY_TO || have.has(y)) continue;
        if (ctx.stockRows.has(code) && minFy > y) continue; // (b) 규칙: 기존 표 첫 행 연도가 더 뒤 = 보고서가 원래 없음
        s.add(y);
      }
    }
    if (s.size) need.set(code, s);
  }
  return need;
}

async function main(): Promise<void> {
  const keyEnv = process.env.DART_API_KEY;
  if (!keyEnv) throw new Error("DART_API_KEY 환경변수가 필요합니다.");
  const key: string = keyEnv;
  console.log(`누락 재무 채우기 시작: ${new Date().toISOString()}`);
  console.log("보고서 선택 규칙(기존 scripts/backfill-stock-annual-fundamentals.ts): 최초 원본/정정 선택 없음 — fnlttSinglAcntAll(bsns_year, reprt_code=11011)이 돌려주는 보고서의 list[0].rcept_no를 그대로 저장(lib/dartFundamentalsParse.ts parseFundamentalsList), CFS 먼저·013이면 OFS(백필 스크립트 232~238행).");
  const ctx = await loadCtx();
  console.log(`종목 ${ctx.series.size}개 로드, 데이터 끝 ${ctx.dataEnd}, 월말 ${ctx.monthEnds.length}개, PIT 진입 고유 종목 ${ctx.codes.length}개`);

  // ---- 채움 전 상태(직전 점검과 동일 정의) ----
  const noFill = new Map<string, Ann[]>();
  const annualPre = buildAnnual(ctx, noFill);
  const mmsPre = judge(ctx, annualPre);
  const clPre = classify(ctx, mmsPre, noFill);

  // ---- 이미 저장된 채움 키 ----
  const fillStatus = new Map<string, Map<number, string>>();
  const fillRows = new Map<string, Ann[]>();
  async function loadFill(label: string): Promise<void> {
    fillStatus.clear(); fillRows.clear();
    const corps = [...new Set([...ctx.corpMap.values()].map((c) => c.corp))];
    for (let i = 0; i < corps.length; i += 100) {
      const chunk = corps.slice(i, i + 100);
      const rs = await selectAll<{ stock_code: string; fiscal_year: number; status: string; rcept_date: string | null; net_income_parent: number | null; fs_div: string | null }>(ctx.dbRead, label, (f, t) => supabaseAdmin.from(FILL_TABLE).select("stock_code, fiscal_year, status, rcept_date, net_income_parent, fs_div").in("corp_code", chunk).range(f, t));
      for (const r of rs) {
        const m = fillStatus.get(r.stock_code) ?? new Map();
        m.set(r.fiscal_year, r.status); fillStatus.set(r.stock_code, m);
        if (r.status === "ok" && r.rcept_date) fillRows.set(r.stock_code, [...(fillRows.get(r.stock_code) ?? []), { fy: r.fiscal_year, rcept: r.rcept_date, ni: r.net_income_parent === null ? null : Number(r.net_income_parent), fsDiv: r.fs_div, src: "fill" }]);
      }
    }
  }
  await loadFill(`${FILL_TABLE}(스킵 확인)`);

  // ---- 대상 ----
  const targetCats = new Map([...clPre.stockCat.entries()].filter(([, v]) => v === "a" || v === "c"));
  const need = neededPairs(ctx, annualPre, targetCats);
  const nonDec = new Set([...targetCats.keys()].filter((c) => ctx.corpMap.has(c) && !ctx.xbrlStatus.has(c)));
  const noCorp = [...need.keys()].filter((c) => !ctx.corpMap.has(c));
  const pairs: { code: string; corp: string; fy: number }[] = [];
  for (const [code, fys] of [...need.entries()].sort()) {
    if (!ctx.corpMap.has(code) || nonDec.has(code)) continue;
    for (const fy of [...fys].sort()) if (!fillStatus.get(code)?.has(fy) || fillStatus.get(code)?.get(fy) === "error") pairs.push({ code, corp: ctx.corpMap.get(code)!.corp, fy });
  }
  const aN = [...targetCats.values()].filter((v) => v === "a").length, cN = [...targetCats.values()].filter((v) => v === "c").length;
  console.log(`\n=== 채울 대상 ===\n분류 (a) ${aN}종목 + (c) ${cN}종목 중 필요한 (종목, FY) 행이 없는 종목 ${need.size}개; corp_code 없어 건너뜀 ${noCorp.length}종목(필요 (종목,FY) ${noCorp.reduce((a, c) => a + need.get(c)!.size, 0)}건); 12월 결산 아님으로 제외(XBRL 백필 제외 종목) ${[...nonDec].filter((c) => need.has(c)).length}종목`);
  console.log("| FY | 대상 (종목, FY) 건수 | 추정 요청 수(상한: CFS 1 + OFS 폴백 1) |\n|---|---|---|");
  for (let fy = FY_FROM; fy <= FY_TO; fy++) { const n = pairs.filter((p) => p.fy === fy).length; console.log(`| FY${fy} | ${n} | ${n * 2} |`); }
  const planned = pairs.length * 2 + VALIDATE_N * 2;
  console.log(`| 합계 | ${pairs.length} | ${pairs.length * 2} |\n사전 검증 ${VALIDATE_N}건 포함 요청 수 상한: ${pairs.length * 2} + ${VALIDATE_N * 2} = ${planned} (한도 ${MAX_REQUESTS})`);
  if (planned > MAX_REQUESTS) { console.log(`상한이 ${MAX_REQUESTS}건을 넘어 실행하지 않습니다.`); return; }

  // ---- 사전 검증 30건(저장 없음) ----
  const have2020 = ctx.codes.filter((c) => ctx.corpMap.has(c) && (ctx.stockRows.get(c) ?? []).some((a) => a.fy === VALIDATE_FY)).sort();
  const rng = mulberry32(SEED);
  const sh = [...have2020];
  for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
  const valCodes = sh.slice(0, VALIDATE_N);
  const exist2020 = new Map<string, { ni: number | null; eq: number | null; fs: string; rcept: string }>();
  for (let i = 0; i < valCodes.length; i += 100) {
    const rs = await selectAll<{ stock_code: string; net_income_parent: number | null; equity_parent: number | null; fs_div: string; rcept_no: string }>(ctx.dbRead, "stock_annual_fundamentals(사전 검증)", (f, t) => supabaseAdmin.from("stock_annual_fundamentals").select("stock_code, net_income_parent, equity_parent, fs_div, rcept_no").eq("fiscal_year", VALIDATE_FY).in("stock_code", valCodes.slice(i, i + 100)).range(f, t));
    for (const r of rs) exist2020.set(r.stock_code, { ni: r.net_income_parent === null ? null : Number(r.net_income_parent), eq: r.equity_parent === null ? null : Number(r.equity_parent), fs: r.fs_div, rcept: r.rcept_no });
  }
  console.log(`\n=== 사전 검증: 기존 표 FY${VALIDATE_FY} 보유 종목 중 무작위 ${valCodes.length}개(시드 ${SEED}) 재조회 vs 기존 표 (저장 안 함) ===`);
  let same = 0, diff = 0, vErr = 0, rceptDiff = 0;
  const diffs: string[] = [];
  const vq = [...valCodes];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const code = vq.shift(); if (!code) return;
      const f = await fetchOne(ctx.corpMap.get(code)!.corp, VALIDATE_FY, key);
      const e = exist2020.get(code)!;
      if (f.status !== "ok") { vErr++; diffs.push(`${code}: 재조회 ${f.status}${f.note ? ` (${f.note})` : ""}`); continue; }
      if (f.rceptNo !== e.rcept) rceptDiff++;
      if (f.ni === e.ni && f.eq === e.eq && f.fsDiv === e.fs) same++;
      else { diff++; diffs.push(`${code}: NI ${e.ni}→${f.ni} / 자본 ${e.eq}→${f.eq} / fs_div ${e.fs}→${f.fsDiv}`); }
    }
  }));
  console.log(`비교 대상 ${valCodes.length}건 (기존 표에 FY${VALIDATE_FY} 값이 있는 종목): 같음 ${same} / 다름 ${diff} / 재조회 실패·비정상 ${vErr} / rcept_no가 기존과 다른 건 ${rceptDiff}`);
  for (const d of diffs) console.log(`  - ${d}`);
  if (limitHit) { console.log("status 020 수신 — 즉시 중단"); }

  // ---- 채우기 ----
  const stats = { ok: 0, no_data_013: 0, no_report: 0, error: 0, periodUnknown: 0, ofs: 0, cfs: 0 };
  const buffer: Record<string, unknown>[] = [];
  let written = 0;
  async function flush(force: boolean): Promise<void> {
    while (buffer.length >= UPSERT_BATCH || (force && buffer.length > 0)) {
      const batch = buffer.splice(0, UPSERT_BATCH);
      const { error } = await supabaseAdmin.from(FILL_TABLE).upsert(batch, { onConflict: "stock_code,fiscal_year" });
      if (error) throw new Error(`${FILL_TABLE} upsert 실패: ${error.message}`);
      written += batch.length;
    }
  }
  const deadline = T0 + SOFT_DEADLINE_MIN * 60_000;
  let stopReason: string | null = limitHit ? "DART status 020(한도 초과) 수신" : null;
  let cursor = 0, done = 0;
  async function worker(): Promise<void> {
    while (!stopReason) {
      if (limitHit) { stopReason = "DART status 020(한도 초과) 수신"; break; }
      if (budgetHit) { stopReason = `요청 한도 ${MAX_REQUESTS}건 도달`; break; }
      if (Date.now() > deadline) { stopReason = `소프트 데드라인 ${SOFT_DEADLINE_MIN}분 도달`; break; }
      const i = cursor++;
      if (i >= pairs.length) break;
      const p = pairs[i];
      const f = await fetchOne(p.corp, p.fy, key);
      if (f.status === "stop") break;
      stats[f.status]++;
      if (f.status === "ok") { if (f.fsDiv === "OFS") stats.ofs++; else stats.cfs++; if (f.periodUnknown) stats.periodUnknown++; }
      buffer.push({
        stock_code: p.code, corp_code: p.corp, fiscal_year: p.fy,
        fs_div: f.status === "ok" || f.status === "no_report" ? f.fsDiv ?? null : null,
        rcept_no: f.status === "ok" || f.status === "no_report" ? f.rceptNo ?? null : null,
        rcept_date: f.status === "ok" || f.status === "no_report" ? f.rceptDate ?? null : null,
        net_income_parent: f.status === "ok" ? f.ni ?? null : null,
        equity_parent: f.status === "ok" ? f.eq ?? null : null,
        status: f.status, fetched_at: new Date().toISOString(),
      });
      await flush(false);
      done++;
      if (done % PROGRESS_EVERY === 0) console.log(`진행 ${done}/${pairs.length}건 | 요청 ${used} | ok ${stats.ok} 013 ${stats.no_data_013} no_report ${stats.no_report} error ${stats.error} | 경과 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  await flush(true);
  if (limitHit && !stopReason) stopReason = "DART status 020(한도 초과) 수신";
  console.log(`\n채우기 종료: ${stopReason ?? "전체 대상 처리 완료"} | 진행 ${done}/${pairs.length}건`);
  console.log(`저장 행(이번 실행 upsert 전송): ${written} — status별: ok ${stats.ok} (CFS ${stats.cfs} / OFS ${stats.ofs}, 기간 말 미확인 ${stats.periodUnknown}) | no_data_013 ${stats.no_data_013} | no_report ${stats.no_report} | error ${stats.error}`);

  // ---- 재측정 ----
  await loadFill(`${FILL_TABLE}(결과 집계)`);
  const annualPost = buildAnnual(ctx, fillRows);
  const mmsPost = judge(ctx, annualPost);
  const clPost = classify(ctx, mmsPost, fillRows);
  console.log("\n#### 재측정 (채움 전 = 직전 점검 정의, 이번 실행에서 다시 계산) ####");
  printCoverage(mmsPre, mmsPost);
  printClassification(ctx, mmsPre, clPre, "채움 전");
  printClassification(ctx, mmsPost, clPost, "채움 후");
  printSurvival(ctx, mmsPre, annualPre, "채움 전");
  printSurvival(ctx, mmsPost, annualPost, "채움 후");
  printStartMiss(ctx, mmsPost, fillStatus);
  const fillCount = new Map<string, number>();
  for (const m of fillStatus.values()) for (const s of m.values()) fillCount.set(s, (fillCount.get(s) ?? 0) + 1);
  console.log(`\n채움 표 전체 행 status별: ${[...fillCount.entries()].map(([k, v]) => `${k} ${v}`).join(" | ")}`);

  console.log("\n=== 실행 지표 ===");
  console.log(`Supabase 읽은 행: ${Object.entries(ctx.dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(ctx.dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Supabase 쓴 행: ${written} (${FILL_TABLE}만) | DART 요청: ${used}건(재시도 포함, 사전 검증 포함) | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | status 020 수신: ${limitHit ? "예" : "아니오"} | 중단: ${stopReason ?? "없음"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

/**
 * [임시 점검 — 병합 금지, 읽기 전용, 저장 없음] KRX 채권지수 총수익지수로 국고채 ETF(114260, 148070) 월 수익률 검증.
 * KRX 요청 총 250건 이하(AUTH_KEY = 기존 KRX_API_KEY, 키 값 출력 금지). DART·KIS 0건. DB는 etf_daily_prices·KOSPI 지수 읽기만. 숫자와 표만 출력한다.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import {
  KRX_BOND_TR_REQUEST_CAP, KRX_BOND_TR_GAP_MS, KRX_BOND_TR_FIRST_MONTH, KRX_BOND_TR_LAST_MONTH, KRX_BOND_TR_PROBE_DATE, KRX_BOND_TR_DIFF_REPORT_PP,
  KRX_BOND_TR_NO_ADJ_FROM_MONTH, KRX_BOND_TR_NO_ADJ_TO_MONTH, KRX_BOND_TR_MIN_COVERAGE_MONTHS,
} from "@/lib/krxBondTrConfig";

const T0 = Date.now();
const BASE = "https://data-dbg.krx.co.kr/svc/apis";
let requests = 0;
let retries = 0;
const dbRead: Record<string, number> = {};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "-");
type Row = Record<string, string>;
interface Resp { http: number | string; code: string; msg: string; rows: Row[]; head: string }

async function krx(path: string, basDd: string, key: string): Promise<Resp> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (requests >= KRX_BOND_TR_REQUEST_CAP) return { http: "-", code: "-", msg: "요청 상한", rows: [], head: "" };
    requests++;
    if (attempt > 0) retries++;
    await sleep(KRX_BOND_TR_GAP_MS);
    try {
      const res = await fetch(`${BASE}/${path}?basDd=${basDd}`, { headers: { AUTH_KEY: key } });
      const text = await res.text();
      let j: Record<string, unknown> | null = null;
      try { j = JSON.parse(text) as Record<string, unknown>; } catch { j = null; }
      const out: Resp = { http: res.status, code: String(j?.respCode ?? "-"), msg: String(j?.respMsg ?? "-"), rows: (j?.OutBlock_1 as Row[] | undefined) ?? [], head: text.slice(0, 160).replace(/\s+/g, " ") };
      if (res.status >= 500 && attempt === 0) continue;
      return out;
    } catch (e) {
      if (attempt === 0) continue;
      return { http: "fetch 실패", code: "-", msg: e instanceof Error ? e.message : String(e), rows: [], head: "" };
    }
  }
  return { http: "-", code: "-", msg: "-", rows: [], head: "" };
}

async function readEtf(code: string): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from("etf_daily_prices").select("trade_date, adj_close").eq("code", code).order("trade_date").range(from, from + 999);
    if (error) throw new Error(`etf_daily_prices 읽기 실패 ${code}: ${error.message}`);
    for (const r of data ?? []) m.set(r.trade_date as string, Number(r.adj_close));
    dbRead[`etf_daily_prices(${code})`] = (dbRead[`etf_daily_prices(${code})`] ?? 0) + (data?.length ?? 0);
    if (!data || data.length < 1000) break;
  }
  return m;
}

const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1);
const sd = (a: number[]): number => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(a.length - 1, 1)); };

async function main(): Promise<void> {
  const key = process.env.KRX_API_KEY;
  if (!key) throw new Error("KRX_API_KEY 환경변수가 필요합니다.");
  console.log(`KRX 채권 총수익지수 검증 시작(읽기 전용): ${new Date().toISOString()} | 요청 상한 ${KRX_BOND_TR_REQUEST_CAP}`);

  // ---- 1. 권한 ----
  console.log(`\n=== 1. 권한 확인 (${KRX_BOND_TR_PROBE_DATE}) ===\n| 경로 | HTTP | respCode | respMsg | 행 수 |\n|---|---|---|---|---|`);
  const paths = ["idx/bon_dd_trd", "etp/etf_bydd_trd", "gen/gold_bydd_trd"];
  const probe: Record<string, Resp> = {};
  for (const p of paths) { probe[p] = await krx(p, KRX_BOND_TR_PROBE_DATE, key); const r = probe[p]; console.log(`| ${p} | ${r.http} | ${r.code} | ${r.msg} | ${r.rows.length} |`); }
  if (paths.every((p) => probe[p].http === 401)) { console.log("\n셋 다 401 — 여기서 멈춤."); finish(); return; }

  // ---- 5 (미리 수집한 응답 사용). 먼저 출력은 순서대로 ----
  const bon = probe["idx/bon_dd_trd"];
  let bonOk = bon.rows.length > 0;
  let nameKey = "", dateKey = "", trKey = "";
  if (bonOk) {
    const keys = Object.keys(bon.rows[0]);
    console.log(`\n=== 2. bon_dd_trd ${KRX_BOND_TR_PROBE_DATE} ===\n필드명(${keys.length}개): ${keys.join(", ")}`);
    nameKey = keys.find((k) => /IDX_NM$/.test(k) && !/GRP/.test(k)) ?? keys.find((k) => /NM/.test(k)) ?? "";
    dateKey = keys.find((k) => k === "BAS_DD") ?? "";
    trKey = keys.find((k) => /TOT_EARNG/.test(k) && !/CMPPREVDD|FLUC/.test(k)) ?? "";
    console.log(`행 수 ${bon.rows.length} | 지수명 필드=${nameKey || "-"} | 총수익 필드(필드명 TOT_EARNG 포함)=${trKey || "-"}`);
    console.log("\n지수명 전체 목록:");
    const grpKey = keys.find((k) => /GRP/.test(k));
    bon.rows.forEach((r, i) => console.log(`  ${i + 1}. ${grpKey ? `[${r[grpKey]}] ` : ""}${r[nameKey] ?? JSON.stringify(r).slice(0, 80)}`));
    const CAND = /국고채|국채|KTB/i;
    const cands = bon.rows.filter((r) => CAND.test(r[nameKey] ?? ""));
    const numKeys = keys.filter((k) => k !== nameKey && k !== dateKey && !(grpKey && k === grpKey));
    console.log(`\n국고채 관련 지수 ${cands.length}개 — 필드별 값 (분류는 필드명 기반 추정: TOT_EARNG=총수익, NETPRC/MKT_PRC=가격, REINVST=재투자 변형)`);
    console.log(`| 지수명 | ${numKeys.join(" | ")} |\n|---|${numKeys.map(() => "---").join("|")}|`);
    for (const r of cands) console.log(`| ${r[nameKey]} | ${numKeys.map((k) => r[k]).join(" | ")} |`);
    if (!trKey) { console.log("총수익 필드를 찾지 못해 3·4 건너뜀."); bonOk = false; }
  } else console.log(`\n=== 2. bon_dd_trd: 응답 행 없음 (HTTP ${bon.http}, ${bon.code}, ${bon.msg}) — 2~4 건너뜀 ===`);

  if (bonOk) {
    // ---- 3. 월말 수집 ----
    const kospi = await getIndexPriceSeries("KOSPI", "2011-08-01", "2026-10-31");
    dbRead["beta_price_history(KOSPI)"] = kospi.length;
    const lastOf = new Map<string, string>();
    for (const p of kospi) lastOf.set(p.tradeDate.slice(0, 7), p.tradeDate);
    const months: string[] = [];
    const [fy, fm] = KRX_BOND_TR_FIRST_MONTH.split("-").map(Number);
    let y = fy, m = fm - 1;
    if (m === 0) { y--; m = 12; }
    for (;;) {
      const ym = `${y}-${String(m).padStart(2, "0")}`;
      if (ym > KRX_BOND_TR_LAST_MONTH) break;
      if (!lastOf.has(ym)) throw new Error(`KOSPI 월말 없음 ${ym}`);
      months.push(ym);
      m++; if (m === 13) { m = 1; y++; }
    }
    console.log(`\n=== 3. 월말 수집: ${months[0]}~${months[months.length - 1]} ${months.length}개월 (첫 달은 수익률 기준 전월 말) ===`);
    const idxVal = new Map<string, Map<string, number>>(); // 지수명 → 월 → 총수익지수
    const failed: string[] = [];
    for (const ym of months) {
      const d = lastOf.get(ym)!.replace(/-/g, "");
      const r = await krx("idx/bon_dd_trd", d, key);
      if (!r.rows.length) { failed.push(`${ym}(${d}: HTTP ${r.http}/${r.code}/${r.msg})`); continue; }
      for (const row of r.rows) {
        const name = row[nameKey]; const v = Number(String(row[trKey] ?? "").replace(/,/g, ""));
        if (!name || !Number.isFinite(v) || v <= 0) continue;
        if (!idxVal.has(name)) idxVal.set(name, new Map());
        idxVal.get(name)!.set(ym, v);
      }
    }
    console.log(`수집 실패 월 ${failed.length}개${failed.length ? `: ${failed.join(", ")}` : ""} | 지수명 ${idxVal.size}종 | 요청 누적 ${requests} (재시도 ${retries})`);

    // ---- 4. 비교 ----
    const etf: Record<string, Map<string, number>> = { "114260": await readEtf("114260"), "148070": await readEtf("148070") };
    const etfM = (code: string, ym: string): number | undefined => etf[code].get(lastOf.get(ym)!);
    const CAND = /국고채|국채|KTB/i;
    const candNames = [...idxVal.keys()].filter((n) => CAND.test(n));
    const monthRet = (code: string, name: string): { ym: string; e: number; i: number }[] => {
      const out: { ym: string; e: number; i: number }[] = [];
      for (let k = 1; k < months.length; k++) {
        const e0 = etfM(code, months[k - 1]), e1 = etfM(code, months[k]);
        const i0 = idxVal.get(name)?.get(months[k - 1]), i1 = idxVal.get(name)?.get(months[k]);
        if (e0 && e1 && i0 && i1) out.push({ ym: months[k], e: (e1 / e0 - 1) * 100, i: (i1 / i0 - 1) * 100 });
      }
      return out;
    };
    const annDiff = (code: string, name: string): { e: number; i: number; n: number } | null => {
      const a = KRX_BOND_TR_NO_ADJ_FROM_MONTH, b = KRX_BOND_TR_NO_ADJ_TO_MONTH;
      const e0 = etfM(code, a), e1 = etfM(code, b), i0 = idxVal.get(name)?.get(a), i1 = idxVal.get(name)?.get(b);
      if (!e0 || !e1 || !i0 || !i1) return null;
      const n = months.indexOf(b) - months.indexOf(a);
      return { e: (Math.pow(e1 / e0, 12 / n) - 1) * 100, i: (Math.pow(i1 / i0, 12 / n) - 1) * 100, n };
    };

    console.log(`\n=== 4-0. 후보 요약 (이름에 국고채/국채/KTB 포함, ${candNames.length}종) ===`);
    console.log("| ETF | 지수명 | 월수 | 월 차이 평균 %p | 월 차이 표준편차 %p | |차이|>0.5%p 월수 | 2018-12→2025-11 연환산 ETF % | 지수 % | 차이 %p |\n|---|---|---|---|---|---|---|---|---|");
    const stat: { code: string; name: string; n: number; sd: number }[] = [];
    for (const code of ["114260", "148070"]) for (const name of candNames) {
      const mr = monthRet(code, name);
      if (!mr.length) continue;
      const diffs = mr.map((x) => x.e - x.i);
      const ad = annDiff(code, name);
      stat.push({ code, name, n: mr.length, sd: sd(diffs) });
      console.log(`| ${code} | ${name} | ${mr.length} | ${f3(mean(diffs))} | ${f3(sd(diffs))} | ${diffs.filter((d) => Math.abs(d) > KRX_BOND_TR_DIFF_REPORT_PP).length} | ${ad ? f2(ad.e) : "-"} | ${ad ? f2(ad.i) : "-"} | ${ad ? f2(ad.e - ad.i) : "-"} |`);
    }

    const tok: Record<string, RegExp> = { "114260": /(^|[^0-9])3\s*(년|Y)/i, "148070": /10\s*(년|Y)/i };
    for (const code of ["114260", "148070"]) {
      const pool = stat.filter((s) => s.code === code && s.n >= KRX_BOND_TR_MIN_COVERAGE_MONTHS);
      const byTok = pool.filter((s) => tok[code].test(s.name));
      const use = byTok.length ? byTok : pool;
      console.log(`\n=== 4. ${code} 상세 — 선정 규칙: 이름에 만기 토큰(${code === "114260" ? "3년/3Y" : "10년/10Y"}) 일치 후보 중 월 차이 표준편차 최소${byTok.length ? "" : " (일치 후보 없음 → 월수 ≥150 전체 후보 중 최소)"} ===`);
      if (!use.length) { console.log("해당 후보 없음"); continue; }
      use.sort((a, b) => a.sd - b.sd);
      const name = use[0].name;
      console.log(`선정 지수: ${name}`);
      const mr = monthRet(code, name);
      const years = [...new Set(mr.map((x) => x.ym.slice(0, 4)))];
      console.log("연도별 수익률 % (ETF/지수 모두 값이 있는 월만 복리)\n| 연도 | 월수 | ETF | 지수 | 차이 %p |\n|---|---|---|---|---|");
      for (const yr of years) {
        const rows = mr.filter((x) => x.ym.startsWith(yr));
        const e = (rows.reduce((a, x) => a * (1 + x.e / 100), 1) - 1) * 100, i = (rows.reduce((a, x) => a * (1 + x.i / 100), 1) - 1) * 100;
        console.log(`| ${yr} | ${rows.length} | ${f2(e)} | ${f2(i)} | ${f2(e - i)} |`);
      }
      const diffs = mr.map((x) => x.e - x.i);
      console.log(`월 수익률 차이: 월수 ${diffs.length} 평균 ${f3(mean(diffs))}%p 표준편차 ${f3(sd(diffs))}%p`);
      const big = mr.filter((x) => Math.abs(x.e - x.i) > KRX_BOND_TR_DIFF_REPORT_PP);
      console.log(`|차이|>${KRX_BOND_TR_DIFF_REPORT_PP}%p 월 ${big.length}개:`);
      if (big.length) { console.log("| 월 | ETF % | 지수 % | 차이 %p |\n|---|---|---|---|"); for (const x of big) console.log(`| ${x.ym} | ${f2(x.e)} | ${f2(x.i)} | ${f2(x.e - x.i)} |`); }
      const ad = annDiff(code, name);
      console.log(ad ? `${KRX_BOND_TR_NO_ADJ_FROM_MONTH}→${KRX_BOND_TR_NO_ADJ_TO_MONTH} (${ad.n}개월) 연환산: ETF ${f2(ad.e)}% 지수 ${f2(ad.i)}% 차이 ${f2(ad.e - ad.i)}%p` : "구간 연환산 계산 불가(값 없음)");
    }
  }

  // ---- 5. ETF 행 필드 ----
  const etfResp = probe["etp/etf_bydd_trd"];
  console.log(`\n=== 5. etf_bydd_trd ${KRX_BOND_TR_PROBE_DATE} ===`);
  if (!etfResp.rows.length) console.log(`응답 행 없음 (HTTP ${etfResp.http}, ${etfResp.code}, ${etfResp.msg})`);
  else {
    const keys = Object.keys(etfResp.rows[0]);
    console.log(`행 수 ${etfResp.rows.length} | 필드명(${keys.length}개): ${keys.join(", ")}`);
    for (const code of ["114260", "148070"]) {
      const row = etfResp.rows.find((r) => (r.ISU_SRT_CD ?? r.ISU_CD) === code);
      console.log(row ? `${code}: ${JSON.stringify(row)}` : `${code}: 행 없음`);
    }
    console.log(`NAV 필드 존재(필드명에 NAV 포함): ${keys.filter((k) => /NAV/i.test(k)).join(",") || "없음"} | 분배금 관련 필드 후보(필드명에 DIV/DIST/분배 포함): ${keys.filter((k) => /DIV|DIST|분배/i.test(k)).join(",") || "없음"}`);
  }
  finish();
}

function finish(): void {
  console.log(`\nKRX 요청 ${requests}건 (재시도 ${retries}) | Supabase 읽은 행 ${JSON.stringify(dbRead)} 쓴 행 0 | DART·KIS 0 | 소요 ${((Date.now() - T0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e, `KRX시도=${requests}`); process.exit(1); });

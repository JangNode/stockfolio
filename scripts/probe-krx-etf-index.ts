/**
 * [임시 점검 — 병합 금지, 읽기 전용, 저장 없음] 148070·132030(·114260·069500) ETF 월 수익률을 NAV·기초지수와 비교.
 * KRX 요청 총 200건 이하(AUTH_KEY = 기존 KRX_API_KEY, 키 값 출력 금지). DART·KIS 0건. DB는 etf_daily_prices·KOSPI 지수 읽기만. 숫자와 표만 출력한다.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import {
  KRX_ETF_INDEX_REQUEST_CAP, KRX_ETF_INDEX_GAP_MS, KRX_ETF_INDEX_FIRST_MONTH, KRX_ETF_INDEX_LAST_MONTH, KRX_ETF_INDEX_CODES, KRX_ETF_INDEX_DIFF_REPORT_PP,
  KRX_ETF_INDEX_LIST_MAX, KRX_ETF_INDEX_PERIODS,
} from "@/lib/krxEtfIndexConfig";

const T0 = Date.now();
const BASE = "https://data-dbg.krx.co.kr/svc/apis";
let requests = 0;
let retries = 0;
const dbRead: Record<string, number> = {};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "-");
type Row = Record<string, string>;
interface Resp { http: number | string; code: string; msg: string; rows: Row[] }
const num = (s: string | undefined): number => Number(String(s ?? "").replace(/,/g, ""));

async function krx(path: string, basDd: string, key: string): Promise<Resp> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (requests >= KRX_ETF_INDEX_REQUEST_CAP) return { http: "-", code: "-", msg: "요청 상한", rows: [] };
    requests++;
    if (attempt > 0) retries++;
    await sleep(KRX_ETF_INDEX_GAP_MS);
    try {
      const res = await fetch(`${BASE}/${path}?basDd=${basDd}`, { headers: { AUTH_KEY: key } });
      const text = await res.text();
      let j: Record<string, unknown> | null = null;
      try { j = JSON.parse(text) as Record<string, unknown>; } catch { j = null; }
      const out: Resp = { http: res.status, code: String(j?.respCode ?? "-"), msg: String(j?.respMsg ?? "-"), rows: (j?.OutBlock_1 as Row[] | undefined) ?? [] };
      if (res.status >= 500 && attempt === 0) continue;
      return out;
    } catch (e) {
      if (attempt === 0) continue;
      return { http: "fetch 실패", code: "-", msg: e instanceof Error ? e.message : String(e), rows: [] };
    }
  }
  return { http: "-", code: "-", msg: "-", rows: [] };
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

interface Mon { px: number; nav: number; idxNm: string; idx: number }

async function main(): Promise<void> {
  const key = process.env.KRX_API_KEY;
  if (!key) throw new Error("KRX_API_KEY 환경변수가 필요합니다.");
  console.log(`KRX ETF vs 기초지수 비교 시작(읽기 전용): ${new Date().toISOString()} | 요청 상한 ${KRX_ETF_INDEX_REQUEST_CAP}`);

  const kospi = await getIndexPriceSeries("KOSPI", "2011-08-01", "2026-10-31");
  dbRead["beta_price_history(KOSPI)"] = kospi.length;
  const lastOf = new Map<string, string>();
  for (const p of kospi) lastOf.set(p.tradeDate.slice(0, 7), p.tradeDate);
  const months: string[] = [];
  const [fy, fm] = KRX_ETF_INDEX_FIRST_MONTH.split("-").map(Number);
  let y = fy, m = fm - 1;
  if (m === 0) { y--; m = 12; }
  for (;;) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    if (ym > KRX_ETF_INDEX_LAST_MONTH) break;
    if (!lastOf.has(ym)) throw new Error(`KOSPI 월말 없음 ${ym}`);
    months.push(ym);
    m++; if (m === 13) { m = 1; y++; }
  }

  console.log(`\n=== 1. 월말 수집: ${months[0]}~${months[months.length - 1]} ${months.length}개월 ===`);
  const data = new Map<string, Map<string, Mon>>(); // 코드 → 월 → 값
  for (const c of KRX_ETF_INDEX_CODES) data.set(c, new Map());
  const failed: string[] = [];
  let fieldCheck = false;
  for (const ym of months) {
    const d = lastOf.get(ym)!.replace(/-/g, "");
    const r = await krx("etp/etf_bydd_trd", d, key);
    if (!r.rows.length) { failed.push(`${ym}(${d}: HTTP ${r.http}/${r.code}/${r.msg})`); continue; }
    if (!fieldCheck) { fieldCheck = true; console.log(`첫 응답(${d}) 행 수 ${r.rows.length}, 필드: ${Object.keys(r.rows[0]).join(", ")}`); }
    for (const c of KRX_ETF_INDEX_CODES) {
      const row = r.rows.find((x) => (x.ISU_CD ?? x.ISU_SRT_CD) === c);
      if (!row) continue;
      const px = num(row.TDD_CLSPRC), nav = num(row.NAV), idx = num(row.OBJ_STKPRC_IDX);
      data.get(c)!.set(ym, { px, nav, idxNm: row.IDX_IND_NM ?? "", idx });
    }
  }
  console.log(`응답 없는 월 ${failed.length}개${failed.length ? `: ${failed.join(", ")}` : ""} | 요청 ${requests} (재시도 ${retries})`);
  console.log("종목별 행이 있는 월 수 (건너뛴 월 = 전체 월 − 이 값)\n| 종목 | 행 있는 월 | 건너뛴 월 | 첫 월 | 마지막 월 |\n|---|---|---|---|---|");
  for (const c of KRX_ETF_INDEX_CODES) { const mm = [...data.get(c)!.keys()].sort(); console.log(`| ${c} | ${mm.length} | ${months.length - failed.length - mm.length} | ${mm[0] ?? "-"} | ${mm[mm.length - 1] ?? "-"} |`); }

  for (const c of KRX_ETF_INDEX_CODES) {
    const etf = await readEtf(c);
    const mon = data.get(c)!;
    console.log(`\n################ ${c} ################`);
    interface MR { ym: string; a: number; b: number; i: number; nameChange: boolean }
    const mr: MR[] = [];
    for (let k = 1; k < months.length; k++) {
      const p0 = mon.get(months[k - 1]), p1 = mon.get(months[k]);
      const a0 = etf.get(lastOf.get(months[k - 1])!), a1 = etf.get(lastOf.get(months[k])!);
      if (!p0 || !p1 || !a0 || !a1 || !(p0.nav > 0) || !(p0.idx > 0) || !(p1.nav > 0) || !(p1.idx > 0)) continue;
      mr.push({ ym: months[k], a: (a1 / a0 - 1) * 100, b: (p1.nav / p0.nav - 1) * 100, i: (p1.idx / p0.idx - 1) * 100, nameChange: p0.idxNm !== p1.idxNm });
    }
    console.log(`월 수익률 비교 가능 월수 ${mr.length}`);
    if (!mr.length) continue;

    // 3. 이름 변경
    console.log("\n기초지수 이름(IDX_IND_NM):");
    const seq = months.filter((ym) => mon.has(ym));
    const runs: { nm: string; from: string; to: string }[] = [];
    for (const ym of seq) { const nm = mon.get(ym)!.idxNm; const last = runs[runs.length - 1]; if (last && last.nm === nm) last.to = ym; else runs.push({ nm, from: ym, to: ym }); }
    console.log("| 이름 | 첫 월 | 마지막 월 |\n|---|---|---|");
    for (const r of runs) console.log(`| ${r.nm} | ${r.from} | ${r.to} |`);
    if (runs.length > 1) {
      console.log("이름이 바뀐 달 (전 이름 → 후 이름):");
      for (let k = 1; k < runs.length; k++) console.log(`  ${runs[k].from}: ${runs[k - 1].nm} (${runs[k - 1].to}) → ${runs[k].nm}`);
    } else console.log("이름이 바뀐 달 없음");

    // 2. 월 차이
    const lists: [string, (x: MR) => number][] = [["(a)−(c) ETF adj_close − 기초지수", (x) => x.a - x.i], ["(b)−(c) NAV − 기초지수", (x) => x.b - x.i]];
    console.log("\n월 수익률 차이");
    console.log("| 비교 | 월수 | 평균 %p | 표준편차 %p | \\|차이\\|>0.5%p 월수 |\n|---|---|---|---|---|");
    for (const [lab, fn] of lists) { const d = mr.map(fn); console.log(`| ${lab} | ${d.length} | ${f3(mean(d))} | ${f3(sd(d))} | ${d.filter((v) => Math.abs(v) > KRX_ETF_INDEX_DIFF_REPORT_PP).length} |`); }
    for (const [lab, fn] of lists) {
      const big = mr.filter((x) => Math.abs(fn(x)) > KRX_ETF_INDEX_DIFF_REPORT_PP).sort((p, q) => Math.abs(fn(q)) - Math.abs(fn(p))).slice(0, KRX_ETF_INDEX_LIST_MAX);
      console.log(`\n${lab}: |차이|>${KRX_ETF_INDEX_DIFF_REPORT_PP}%p 월 상위 ${big.length}개 (|차이| 큰 순, *=이름 변경 달)\n| 월 | (a) % | (b) % | (c) % | 차이 %p |\n|---|---|---|---|---|`);
      for (const x of big) console.log(`| ${x.ym}${x.nameChange ? "*" : ""} | ${f2(x.a)} | ${f2(x.b)} | ${f2(x.i)} | ${f2(fn(x))} |`);
    }

    // 연도별
    console.log("\n연도별 수익률 % (세 값이 모두 있는 월만 복리)\n| 연도 | 월수 | (a) | (b) | (c) | (a)−(c) |\n|---|---|---|---|---|---|");
    for (const yr of [...new Set(mr.map((x) => x.ym.slice(0, 4)))]) {
      const rows = mr.filter((x) => x.ym.startsWith(yr));
      const comp = (g: (x: MR) => number): number => (rows.reduce((p, x) => p * (1 + g(x) / 100), 1) - 1) * 100;
      const a = comp((x) => x.a), b = comp((x) => x.b), i = comp((x) => x.i);
      console.log(`| ${yr} | ${rows.length} | ${f2(a)} | ${f2(b)} | ${f2(i)} | ${f2(a - i)} |`);
    }

    // 구간 연환산
    console.log("\n구간 연환산 % (기준 월말 → 종료 월말)\n| 구간 | 개월 | (a) | (c) | (a)−(c) |\n|---|---|---|---|---|");
    for (const pd of KRX_ETF_INDEX_PERIODS) {
      const p0 = mon.get(pd.base), p1 = mon.get(pd.end);
      const a0 = months.includes(pd.base) ? etf.get(lastOf.get(pd.base)!) : undefined, a1 = months.includes(pd.end) ? etf.get(lastOf.get(pd.end)!) : undefined;
      if (!p0 || !p1 || !a0 || !a1 || !(p0.idx > 0) || !(p1.idx > 0)) { console.log(`| ${pd.label} | - | - | - | - |`); continue; }
      const n = months.indexOf(pd.end) - months.indexOf(pd.base);
      const a = (Math.pow(a1 / a0, 12 / n) - 1) * 100, ci = (Math.pow(p1.idx / p0.idx, 12 / n) - 1) * 100;
      console.log(`| ${pd.label} | ${n} | ${f2(a)} | ${f2(ci)} | ${f2(a - ci)} |`);
    }
  }
  console.log(`\nKRX 요청 ${requests}건 (재시도 ${retries}) | Supabase 읽은 행 ${JSON.stringify(dbRead)} 쓴 행 0 | DART·KIS 0 | 소요 ${((Date.now() - T0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e, `KRX시도=${requests}`); process.exit(1); });

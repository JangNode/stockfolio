/**
 * [임시 점검 — 병합 금지, 읽기 전용, 저장 없음] DART XBRL(fnlttXbrl)로 2010~2014 재무를 확보할 수 있는지 점검.
 * 외부 요청(DART·KIS) 총 30건 이하. DB는 REST(HTTPS) 소량 조회만. 숫자와 사실만 출력한다.
 */
import AdmZip from "adm-zip";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS, PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";

// ---- 점검 상수 ----
const EXTERNAL_REQUEST_BUDGET = 30;
const DART_BASE_URL = "https://opendart.fss.or.kr/api";
const DART_DAILY_LIMIT = 20_000; // 가정: DART 오픈API 개인 키 일일 호출 한도(실행 중 확인 불가)
const SAMPLE_LISTED = "005930";
const KIS_LISTED = ["005930", "000660", "035420"];
const LIST_FROM = "20110101";
const LIST_TO = "20151231";
const FY_FROM = 2010;
const FY_TO = 2014;
const DELISTED_FROM = "2013-01-01";
const DELISTED_TO = "2015-12-31";
const DELISTED_PICK = 2;
const DELISTED_XBRL_PER_STOCK = 2;
const PIT_FROM = "2010-01-01";
const PIT_TO = "2016-12-31";
const CAP_EOK = 5000;
const DB_IN_CHUNK = 200;
const FACT_SAMPLE = 4;

let used = 0;
const reqLog: string[] = [];
const maskKey = (u: string): string => u.replace(/(crtfc_key=)[^&]+/, "$1***");
interface Ext { status: number; ms: number; buf: Buffer }
async function ext(label: string, url: string): Promise<Ext | null> {
  if (used >= EXTERNAL_REQUEST_BUDGET) { console.log(`[요청 한도 도달] ${label} 생략`); return null; }
  used++;
  const t0 = Date.now();
  try {
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    reqLog.push(`#${used} ${label} | HTTP ${res.status} | ${buf.length} B | ${Date.now() - t0} ms | ${maskKey(url)}`);
    return { status: res.status, ms: Date.now() - t0, buf };
  } catch (e) {
    reqLog.push(`#${used} ${label} | 요청 실패: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
const parseJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };
const isZip = (b: Buffer): boolean => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b;
const f0 = (x: number): string => (Number.isFinite(x) ? x.toLocaleString("en-US") : "-");

interface DartFiling { corp_name?: string; stock_code?: string; report_nm: string; rcept_no: string; rcept_dt: string }
const fyOf = (reportNm: string): number | null => { const m = /\((\d{4})\.\d{2}\)/.exec(reportNm); return m ? Number(m[1]) : null; };

export interface XbrlFact { tag: string; ctx: string; period: string; dim: boolean; unit: string; decimals: string; value: string }
export interface XbrlParsed { files: string[]; instance: string | null; prefixes: string[]; schemaRefs: string[]; factCount: number; facts: XbrlFact[] }
const TARGET_TAGS = ["ProfitLossAttributableToOwnersOfParent", "EquityAttributableToOwnersOfParent", "ProfitLoss", "Equity"];

export function parseXbrlZip(buf: Buffer): XbrlParsed | { error: string } {
  let zip: AdmZip;
  try { zip = new AdmZip(buf); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  const entries = zip.getEntries();
  const files = entries.map((e) => `${e.entryName} (${e.header.size} B)`);
  const inst = entries.find((e) => /\.xbrl$/i.test(e.entryName));
  if (!inst) return { files, instance: null, prefixes: [], schemaRefs: [], factCount: 0, facts: [] };
  const xml = inst.getData().toString("utf-8");
  const prefixes = [...new Set([...xml.matchAll(/xmlns:([\w-]+)=/g)].map((m) => m[1]))];
  const schemaRefs = [...xml.matchAll(/<link:schemaRef[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  const ctxInfo = new Map<string, { period: string; dim: boolean }>();
  for (const m of xml.matchAll(/<(?:\w+:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?context>/g)) {
    const body = m[2];
    const inst2 = /<(?:\w+:)?instant>([^<]+)</.exec(body)?.[1];
    const s = /<(?:\w+:)?startDate>([^<]+)</.exec(body)?.[1], e = /<(?:\w+:)?endDate>([^<]+)</.exec(body)?.[1];
    ctxInfo.set(m[1], { period: inst2 ?? `${s ?? "?"}~${e ?? "?"}`, dim: /explicitMember|typedMember/.test(body) });
  }
  const facts: XbrlFact[] = [];
  let factCount = 0;
  const re = new RegExp(`<([\\w.-]+):(${TARGET_TAGS.join("|")})\\b([^>]*)>([^<]*)<`, "g");
  for (const m of xml.matchAll(re)) {
    factCount++;
    const attrs = m[3];
    const ctx = /contextRef="([^"]+)"/.exec(attrs)?.[1] ?? "";
    const ci = ctxInfo.get(ctx);
    facts.push({ tag: `${m[1]}:${m[2]}`, ctx, period: ci?.period ?? "?", dim: ci?.dim ?? false, unit: /unitRef="([^"]+)"/.exec(attrs)?.[1] ?? "?", decimals: /decimals="([^"]+)"/.exec(attrs)?.[1] ?? "?", value: m[4].trim() });
  }
  return { files, instance: inst.entryName, prefixes, schemaRefs, factCount, facts };
}

export interface ProbeDeps {
  dartKey: string;
  series: Map<string, StockDailyPriceRow[]>; // 원본 시세(2010~)
  dbCorp: (stockCodes: string[]) => Promise<{ rows: number; map: Map<string, { corp_code: string; corp_name: string }> }>;
  kis: {
    income: (c: string) => Promise<{ year: number; netIncome: number | null }[]>;
    balance: (c: string) => Promise<{ year: number; totalEquity: number | null }[]>;
    price: (c: string) => Promise<{ eps: number | null; bps: number | null; per: number | null; pbr: number | null }>;
  } | null;
}

async function dartList(key: string, corp: string, label: string): Promise<{ rows: DartFiling[]; total: number | null; raw: string } | null> {
  const url = `${DART_BASE_URL}/list.json?crtfc_key=${key}&corp_code=${corp}&bgn_de=${LIST_FROM}&end_de=${LIST_TO}&pblntf_ty=A&page_no=1&page_count=100`;
  const r = await ext(`DART list ${label}`, url);
  if (!r) return null;
  const j = parseJson(r.buf.toString("utf-8")) as { status?: string; message?: string; list?: DartFiling[]; total_count?: number } | null;
  console.log(`  list.json ${label}: HTTP ${r.status}, status=${j?.status ?? "-"} (${j?.message ?? "-"}), total_count=${j?.total_count ?? "-"}, 응답 ${r.buf.length} B, ${r.ms} ms`);
  return { rows: j?.list ?? [], total: j?.total_count ?? null, raw: r.buf.toString("utf-8").slice(0, 100) };
}

async function xbrlProbe(key: string, label: string, f: DartFiling, fy: number): Promise<{ usable: boolean }> {
  const url = `${DART_BASE_URL}/fnlttXbrl.xml?crtfc_key=${key}&rcept_no=${f.rcept_no}&reprt_code=11011`;
  const r = await ext(`DART fnlttXbrl ${label} FY${fy}`, url);
  if (!r) { console.log(`| ${label} | FY${fy} | ${f.rcept_no} | 요청 실패 | - | - | - | - |`); return { usable: false }; }
  if (!isZip(r.buf)) {
    const txt = r.buf.toString("utf-8");
    const st = /<status>([^<]*)</.exec(txt)?.[1], msg = /<message>([^<]*)</.exec(txt)?.[1];
    console.log(`| ${label} | FY${fy} | ${f.rcept_no} | ${r.status} | ${st ?? "-"} / ${msg ?? txt.slice(0, 60).replace(/\s+/g, " ")} | ${r.buf.length} B | (zip 아님) | - |`);
    return { usable: false };
  }
  const p = parseXbrlZip(r.buf);
  if ("error" in p) { console.log(`| ${label} | FY${fy} | ${f.rcept_no} | ${r.status} | zip 해석 실패: ${p.error} | ${r.buf.length} B | - | - |`); return { usable: false }; }
  console.log(`| ${label} | FY${fy} | ${f.rcept_no} | ${r.status} | zip | ${r.buf.length} B | ${p.files.slice(0, 8).join("; ")}${p.files.length > 8 ? ` 외 ${p.files.length - 8}개` : ""} | 사실 ${p.factCount}건 |`);
  console.log(`    인스턴스: ${p.instance ?? "없음"} | 네임스페이스 접두사: ${p.prefixes.join(",") || "-"} | schemaRef: ${p.schemaRefs.join(" ; ") || "-"}`);
  const picks = TARGET_TAGS.map((t) => p.facts.filter((x) => x.tag.endsWith(`:${t}`) && !x.dim).slice(0, FACT_SAMPLE));
  for (const l of picks) for (const x of l) console.log(`    ${x.tag} | 기간 ${x.period} | 단위 ${x.unit} | decimals ${x.decimals} | 값 ${x.value}`);
  return { usable: p.factCount > 0 };
}

async function docProbe(key: string, label: string, f: DartFiling): Promise<void> {
  const r = await ext(`DART document ${label}`, `${DART_BASE_URL}/document.xml?crtfc_key=${key}&rcept_no=${f.rcept_no}`);
  if (!r) return;
  if (!isZip(r.buf)) { console.log(`  document.xml ${label} ${f.rcept_no}: HTTP ${r.status}, ${r.buf.length} B, zip 아님: ${r.buf.toString("utf-8").slice(0, 80).replace(/\s+/g, " ")}`); return; }
  const zip = new AdmZip(r.buf);
  const ents = zip.getEntries();
  const text = ents.map((e) => e.getData().toString("utf-8")).join("\n");
  const cnt = (re: RegExp): number => (text.match(re) ?? []).length;
  console.log(`  document.xml ${label} ${f.rcept_no}: HTTP ${r.status}, 응답 ${r.buf.length} B, 파일 ${ents.length}개(${ents.map((e) => `${e.entryName} ${e.header.size} B`).slice(0, 4).join("; ")}), 압축 해제 합계 ${ents.reduce((a, e) => a + e.header.size, 0)} B, ${r.ms} ms`);
  console.log(`    문자열 존재 여부(파싱 아님): "재무상태표" ${cnt(/재무상태표/g)}회, "재무제표" ${cnt(/재무제표/g)}회, 표 태그(<TABLE) ${cnt(/<TABLE/gi)}개, "한국채택국제회계기준" ${cnt(/한국채택국제회계기준/g)}회, "일반기업회계기준" ${cnt(/일반기업회계기준/g)}회`);
}

export async function runProbe(d: ProbeDeps): Promise<void> {
  // ---- 시세 기반 선별 (항목 6 + 폐지 종목 선정) ----
  const monthEnds = new Set<string>();
  const allDates = new Set<string>();
  for (const rows of d.series.values()) for (const r of rows) if (r.tradeDate >= PIT_FROM && r.tradeDate <= PIT_TO) allDates.add(r.tradeDate);
  const cal = [...allDates].sort();
  for (let k = 0; k + 1 < cal.length; k++) if (cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7)) monthEnds.add(cal[k]);
  const pitEver = new Set<string>();
  const delisted: { code: string; last: string; peakMcap: number; inPit: boolean }[] = [];
  for (const [code, rows] of d.series) {
    const tv = computeTrailingAvgTradingValue(rows, PIT_LIQUIDITY_LOOKBACK_DAYS);
    let peak = 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].marketCapEok > peak) peak = rows[i].marketCapEok;
      if (i >= 1 && monthEnds.has(rows[i].tradeDate) && rows[i - 1].marketCapEok >= CAP_EOK && tv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON) pitEver.add(code);
    }
    const last = rows[rows.length - 1].tradeDate;
    if (last >= DELISTED_FROM && last <= DELISTED_TO) delisted.push({ code, last, peakMcap: peak, inPit: false });
  }
  for (const x of delisted) x.inPit = pitEver.has(x.code);

  const codesForDb = [...new Set([...pitEver, ...delisted.map((x) => x.code), SAMPLE_LISTED])];
  const corp = await d.dbCorp(codesForDb);
  const hasCorp = (c: string): boolean => corp.map.has(c);

  // ---- 항목 1 ----
  console.log("=== 항목 1: DART 공시검색(list.json, 정기공시 pblntf_ty=A, 2011-01-01~2015-12-31) ===");
  console.log(`DB 조회: dart_corp_codes ${corp.rows}행 읽음(대상 종목코드 ${codesForDb.length}개 IN 조회)`);
  console.log(`2013-01-01~2015-12-31에 마지막 거래일이 있는 종목(상장폐지·합병 후보) ${delisted.length}개 | 그중 2010~2016 월말 PIT 유니버스 진입 이력 ${delisted.filter((x) => x.inPit).length}개 | corp_code 있음 ${delisted.filter((x) => hasCorp(x.code)).length}개 / 없음 ${delisted.filter((x) => !hasCorp(x.code)).length}개 (PIT 진입 이력 종목만: 있음 ${delisted.filter((x) => x.inPit && hasCorp(x.code)).length} / 없음 ${delisted.filter((x) => x.inPit && !hasCorp(x.code)).length})`);
  const picks = delisted.filter((x) => hasCorp(x.code)).sort((a, b) => b.peakMcap - a.peakMcap || (a.code < b.code ? -1 : 1)).slice(0, DELISTED_PICK);
  console.log("선정한 폐지 종목(corp_code 있는 후보 중 최대 시총 상위):");
  console.log("| 종목 | corp_code | corp_name | 마지막 거래일 | 최대 시총(억) | PIT 진입 이력 |");
  console.log("|---|---|---|---|---|---|");
  for (const x of picks) console.log(`| ${x.code} | ${corp.map.get(x.code)!.corp_code} | ${corp.map.get(x.code)!.corp_name} | ${x.last} | ${f0(x.peakMcap)} | ${x.inPit ? "예" : "아니오"} |`);
  if (!picks.length) console.log("| (corp_code가 있는 폐지 종목 없음) | | | | | |");

  const targets: { label: string; code: string; corpCode: string; delisted: boolean }[] = [];
  const s = corp.map.get(SAMPLE_LISTED);
  if (s) targets.push({ label: SAMPLE_LISTED, code: SAMPLE_LISTED, corpCode: s.corp_code, delisted: false });
  else console.log(`${SAMPLE_LISTED}: dart_corp_codes에 corp_code 없음`);
  for (const x of picks) targets.push({ label: `${x.code}(폐지 ${x.last})`, code: x.code, corpCode: corp.map.get(x.code)!.corp_code, delisted: true });

  const annual = new Map<string, DartFiling[]>();
  console.log("\n| 종목 | 보고서명 | rcept_no | rcept_dt |");
  console.log("|---|---|---|---|");
  for (const t of targets) {
    const l = await dartList(d.dartKey, t.corpCode, t.label);
    const biz = (l?.rows ?? []).filter((x) => /사업보고서/.test(x.report_nm)).sort((a, b) => (a.rcept_dt < b.rcept_dt ? -1 : 1));
    annual.set(t.label, biz);
    for (const x of biz) console.log(`| ${t.label} | ${x.report_nm} | ${x.rcept_no} | ${x.rcept_dt} |`);
    if (!biz.length) console.log(`| ${t.label} | (사업보고서 없음) | - | - |`);
    console.log(`  ${t.label}: 전체 정기공시 ${l?.rows.length ?? 0}건 조회, 사업보고서(정정 포함) ${biz.length}건`);
  }

  // ---- 항목 2 ----
  console.log("\n=== 항목 2: 재무제표 원본파일(XBRL) fnlttXbrl.xml, reprt_code=11011 ===");
  console.log("| 종목 | 회계연도 | rcept_no | HTTP | DART status/message 또는 형식 | 응답 크기 | zip 내부 파일 | 대상 태그 사실 수 |");
  console.log("|---|---|---|---|---|---|---|---|");
  const usable = new Map<string, boolean>();
  for (const t of targets) {
    const biz = (annual.get(t.label) ?? []).filter((x) => !/정정/.test(x.report_nm));
    const byFy = new Map<number, DartFiling>();
    for (const x of biz) { const fy = fyOf(x.report_nm); if (fy !== null && !byFy.has(fy)) byFy.set(fy, x); }
    let fys = [...byFy.keys()].filter((fy) => fy >= FY_FROM && fy <= FY_TO).sort();
    if (t.delisted && fys.length > DELISTED_XBRL_PER_STOCK) fys = [fys[0], fys[fys.length - 1]];
    for (const fy of fys) {
      const r = await xbrlProbe(d.dartKey, t.label, byFy.get(fy)!, fy);
      usable.set(t.label, (usable.get(t.label) ?? false) || r.usable);
    }
    if (!fys.length) console.log(`| ${t.label} | (회계연도 ${FY_FROM}~${FY_TO} 사업보고서 없음) | - | - | - | - | - | - |`);
  }

  // ---- 항목 3 ----
  console.log("\n=== 항목 3: 사업보고서 원문(document.xml) — XBRL이 안 된 경우만 (크기와 표 존재 여부만) ===");
  let did3 = false;
  for (const t of targets) {
    if (usable.get(t.label)) continue;
    const first = (annual.get(t.label) ?? []).filter((x) => !/정정/.test(x.report_nm) && (fyOf(x.report_nm) ?? 0) >= FY_FROM)[0];
    if (!first) continue;
    did3 = true;
    await docProbe(d.dartKey, t.label, first);
  }
  if (!did3) console.log("XBRL 응답으로 필요한 태그를 확인했거나 대상 보고서가 없어 요청하지 않았습니다.");

  // ---- 항목 5 ----
  console.log("\n=== 항목 5: KIS 재무 API (lib/kis.ts) ===");
  console.log("래퍼 필드: getIncomeStatementYears(stac_yymm, sale_account, bsop_prti, thtr_ntin → year/revenue/operatingIncome/netIncome), getBalanceSheetYears(stac_yymm, total_aset, total_lblt, total_cptl → year/totalAssets/totalLiabilities/totalEquity), getStockPrice(현재가: eps, bps, per, pbr — 현재 값 1건). 래퍼는 12월 결산 행만 남긴다(annualYearFromStacYymm).");
  if (!d.kis) console.log("KIS 자격 증명이 없어 요청하지 않았습니다.");
  else {
    console.log("| 종목 | 구분 | 호출 | 연도 범위(최소~최대) | 연도 수 | 비고 |");
    console.log("|---|---|---|---|---|---|");
    const kisTargets = [...KIS_LISTED.map((c) => ({ c, tag: "상장" })), ...(picks[0] ? [{ c: picks[0].code, tag: `폐지(${picks[0].last})` }] : [])];
    for (const { c, tag } of kisTargets) {
      for (const [name, fn] of [["손익계산서", async () => (await d.kis!.income(c)).map((x) => x.year)], ["대차대조표", async () => (await d.kis!.balance(c)).map((x) => x.year)]] as [string, () => Promise<number[]>][]) {
        if (used >= EXTERNAL_REQUEST_BUDGET) { console.log(`| ${c} | ${tag} | ${name} | 요청 한도 도달 | - | - |`); continue; }
        used++;
        try {
          const ys = await fn();
          console.log(`| ${c} | ${tag} | ${name} | ${ys.length ? `${Math.min(...ys)}~${Math.max(...ys)}` : "-"} | ${ys.length} | ${ys.length ? ys.sort().join(",") : "빈 응답"} |`);
        } catch (e) {
          console.log(`| ${c} | ${tag} | ${name} | 오류 | - | ${e instanceof Error ? e.message.slice(0, 100) : String(e)} |`);
        }
      }
      if (used < EXTERNAL_REQUEST_BUDGET) {
        used++;
        try {
          const p = await d.kis!.price(c);
          console.log(`| ${c} | ${tag} | 현재가(EPS/BPS) | 현재 시점 1건 | 1 | eps ${p.eps}, bps ${p.bps}, per ${p.per}, pbr ${p.pbr} |`);
        } catch (e) {
          console.log(`| ${c} | ${tag} | 현재가(EPS/BPS) | 오류 | - | ${e instanceof Error ? e.message.slice(0, 100) : String(e)} |`);
        }
      }
    }
  }

  // ---- 항목 6 ----
  const pitCodes = [...pitEver];
  const withCorp = pitCodes.filter(hasCorp).length;
  const fyCount = FY_TO - FY_FROM + 1;
  console.log("\n=== 항목 6: 규모 추정 (2010-01~2016-12 월말 PIT 유니버스: 직전 행 시총 >= 5천억 + 직전 20거래일 평균 거래대금 >= 5억) ===");
  console.log("| 항목 | 값 |");
  console.log("|---|---|");
  console.log(`| 월말 수 | ${monthEnds.size} |`);
  console.log(`| 한 번이라도 진입한 고유 종목 수 | ${pitCodes.length} |`);
  console.log(`| 그중 dart_corp_codes에 corp_code 있음 | ${withCorp} |`);
  console.log(`| 그중 corp_code 없음 | ${pitCodes.length - withCorp} |`);
  console.log(`| 회계연도 ${FY_FROM}~${FY_TO} (${fyCount}개) × corp_code 있는 종목 = 필요한 XBRL 요청 수 | ${fyCount * withCorp} |`);
  console.log(`| 위 요청 수 ÷ DART 일일 호출 한도 ${f0(DART_DAILY_LIMIT)} (가정) | ${((fyCount * withCorp / DART_DAILY_LIMIT) * 100).toFixed(1)}% |`);
  console.log(`| Supabase에 쓸 행 수 추정 (종목·회계연도 1행, 상한) | ${fyCount * withCorp} (corp_code 없는 종목 포함 시 상한 ${fyCount * pitCodes.length}) |`);
  console.log(`\n외부 요청 사용: ${used}/${EXTERNAL_REQUEST_BUDGET}건 (KIS 토큰 발급이 필요했다면 그 1건은 별도)`);
  console.log("외부 요청 로그(DART):");
  for (const l of reqLog) console.log(`  ${l}`);
  console.log("\n완료");
}

async function main(): Promise<void> {
  const dartKey = process.env.DART_API_KEY;
  if (!dartKey) throw new Error("DART_API_KEY 환경변수가 필요합니다.");
  console.log(`DART XBRL 2010~2014 확보 가능성 점검 시작(읽기 전용): ${new Date().toISOString()}`);
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear());
  console.log(`종목 ${series.size}개 로드`);
  const hasKis = !!process.env.KIS_APP_KEY && !!process.env.KIS_APP_SECRET;
  const kisMod = hasKis ? await import("@/lib/kis") : null;
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
    kis: kisMod ? {
      income: (c) => kisMod.getIncomeStatementYears(c, "batch"),
      balance: (c) => kisMod.getBalanceSheetYears(c, "batch"),
      price: (c) => kisMod.getStockPrice(c, "batch"),
    } : null,
  });
}
if (process.argv[1] && process.argv[1].endsWith("probe-dart-xbrl-2010.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

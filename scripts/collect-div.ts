/**
 * [임시 연구 — 병합 금지] 배당 시험용 DART "배당에 관한 사항"(alotMatter) 가능성 점검·수집. 사용자 지시 2026-11-28. 문서: docs/research/div-data-check.md.
 * D_MODE=pilot: 30개사 × FY2011~2025 alotMatter(reprt_code 11011) + list.json(정정·원본 접수일 확인)로 호출당 연도 수·접수일·정정·보통주/우선주·무배당 표기·확보율을 재고 호출 수·시간을 추정한다(저장 없음, 로그 표만).
 * D_MODE=collect: 대상 종목 전체 × FY2011~2025를 Storage research/dividend/ 한 사본(parquet)에 이어받기로 쌓는다.
 * DART는 alotMatter.json·list.json만 호출. 연구용 키 DART_API_KEY_3 → _2만(키당 하루 16,000건 = 한도 20,000의 80%). 연구 DB 쓰기 0, 키 값 출력 없음, 원문은 저장하지 않는다(파싱 결과만).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { encodeTable, decodeTable, downloadBuf, uploadBuf, storageUsage, MiB, kstDate, type ColDef, type Row } from "@/lib/nBookStore";
import { periodOf, type Filing } from "@/lib/dartXbrlExtract";
import {
  DIV_DATA_FILE, DIV_PROGRESS_FILE, DIV_FY_FROM, DIV_FY_TO, DIV_REPRT_CODE, DIV_SIGNAL_FROM, DIV_SIGNAL_TO, DIV_LIST_FROM, DIV_LIST_TO, DIV_LIST_PAGE_COUNT,
  DIV_KEY_ENVS, DIV_KEY_DAILY_LIMIT, DIV_KEY_DAILY_CAP, DIV_PILOT_CALL_CAP, DIV_TOTAL_CALL_CAP, DIV_GAP_MS, DIV_CONCURRENCY, DIV_MAX_RETRIES, DIV_RETRY_BASE_MS,
  DIV_FETCH_TIMEOUT_MS, DIV_SOFT_DEADLINE_MINUTES, DIV_FLUSH_EVERY_CORPS, DIV_PILOT, DIV_PASS,
} from "@/lib/dividendConfig";
import { type PoolKey } from "./dartKeyPool";
import { loadHarness, loadK200P, verifySnapshotManifest, selectAll, mulberry32, SNAP_END, storageLine } from "./researchHarness";

const DART = "https://opendart.fss.or.kr/api";
const T0 = Date.now();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pc = (a: number, b: number): string => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const isoOf = (d: string): string => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d.slice(0, 10));
const statusOf = (buf: Buffer): string | undefined => /"status"\s*:\s*"(\d+)"/.exec(buf.toString("utf-8", 0, 400))?.[1];

// ---- DART 호출: 키별 하루 한도 풀 + 동시 16 + 최소 간격 ----
class DailyKeyPool {
  used = new Map<string, number>(); got020 = new Map<string, number>(); total = 0; stopReason: string | null = null;
  private disabled = new Set<string>();
  constructor(private keys: PoolKey[], private totalCap: number) { for (const k of keys) { this.used.set(k.name, 0); this.got020.set(k.name, 0); } }
  private open(k: PoolKey): boolean { return !this.disabled.has(k.name) && (k.cap === undefined || (this.used.get(k.name) ?? 0) < k.cap); }
  reserve(): PoolKey | null {
    if (this.stopReason) return null;
    if (this.total >= this.totalCap) { this.stopReason = `전체 요청 상한 ${this.totalCap}건 도달`; return null; }
    const k = this.keys.find((x) => this.open(x));
    if (!k) { this.stopReason = "모든 키가 오늘 한도(또는 status 020)에 도달"; return null; }
    this.total++; this.used.set(k.name, (this.used.get(k.name) ?? 0) + 1);
    return k;
  }
  on020(name: string): boolean { this.got020.set(name, (this.got020.get(name) ?? 0) + 1); this.disabled.add(name); const more = this.keys.some((x) => this.open(x)); if (!more) this.stopReason = `${name} status 020 수신, 전환할 키 없음`; return more; }
}
let pool: DailyKeyPool;
let nextSlot = 0;
const slot = async (): Promise<void> => { const now = Date.now(), s = Math.max(now, nextSlot); nextSlot = s + DIV_GAP_MS; if (s > now) await sleep(s - now); };
interface Resp { buf: Buffer; status?: string; http: number }
const stats = { calls: 0, retries: 0, timeouts: 0, http5xx: 0, ms: 0 };
async function dartGet(build: (key: string) => string): Promise<Resp | null> {
  for (let attempt = 0; attempt <= DIV_MAX_RETRIES; attempt++) {
    const k = pool.reserve();
    if (!k) return null;
    await slot();
    const t1 = Date.now();
    try {
      const ac = new AbortController(), to = setTimeout(() => ac.abort(), DIV_FETCH_TIMEOUT_MS);
      let res: Response;
      try { res = await fetch(build(k.value), { signal: ac.signal }); } finally { clearTimeout(to); }
      const buf = Buffer.from(await res.arrayBuffer());
      stats.calls++; stats.ms += Date.now() - t1;
      if (res.status === 429 || res.status >= 500) { stats.http5xx++; throw new Error(`HTTP ${res.status}`); }
      const st = statusOf(buf);
      if (st === "020") { if (pool.on020(k.name)) { attempt--; continue; } return null; }
      if (st === "800") throw new Error("status 800");
      return { buf, status: st, http: res.status };
    } catch (e) { if ((e as Error).name === "AbortError") stats.timeouts++; if (attempt < DIV_MAX_RETRIES) { stats.retries++; await sleep(DIV_RETRY_BASE_MS * 2 ** attempt); } }
  }
  return null;
}
async function dartList(corp: string): Promise<Filing[] | null> {
  const rows: Filing[] = [];
  for (let page = 1, pages = 1; page <= pages; page++) {
    const r = await dartGet((key) => `${DART}/list.json?crtfc_key=${key}&corp_code=${corp}&bgn_de=${DIV_LIST_FROM}&end_de=${DIV_LIST_TO}&pblntf_ty=A&page_no=${page}&page_count=${DIV_LIST_PAGE_COUNT}`);
    if (!r) return null;
    let j: { status?: string; list?: Filing[]; total_page?: number } | null = null;
    try { j = JSON.parse(r.buf.toString("utf-8")); } catch { return null; }
    if (j?.status === "013") return rows;
    if (j?.status !== "000") return null;
    rows.push(...(j.list ?? []));
    pages = j.total_page ?? 1;
  }
  return rows;
}

// ---- alotMatter 파싱 ----
interface AlotItem { rcept_no?: string; se?: string; stock_knd?: string; thstrm?: string; frmtrm?: string; lwfr?: string }
interface AlotOut { status: string; items: AlotItem[] }
async function fetchAlot(corp: string, fy: number): Promise<AlotOut | null> {
  const r = await dartGet((key) => `${DART}/alotMatter.json?crtfc_key=${key}&corp_code=${corp}&bsns_year=${fy}&reprt_code=${DIV_REPRT_CODE}`);
  if (!r) return null;
  let j: { status?: string; list?: AlotItem[] } | null = null;
  try { j = JSON.parse(r.buf.toString("utf-8")); } catch { return null; }
  return { status: j?.status ?? "?", items: j?.list ?? [] };
}
const isDps = (se: string | undefined): boolean => /주당\s*현금\s*배당금/.test(se ?? "");
const isCommon = (k: string | undefined): boolean => /보통/.test(k ?? "");
const isPref = (k: string | undefined): boolean => /우선|종류/.test(k ?? "");
type Tok = "num_pos" | "num_zero" | "dash" | "empty" | "other";
const tokOf = (s: string | undefined): Tok => { const t = (s ?? "").trim(); if (t === "") return "empty"; if (t === "-") return "dash"; const v = Number(t.replace(/,/g, "")); if (Number.isFinite(v)) return v > 0 ? "num_pos" : "num_zero"; return "other"; };
const numOf = (s: string | undefined): number | null => { const t = (s ?? "").trim().replace(/,/g, ""); if (t === "" || t === "-") return null; const v = Number(t); return Number.isFinite(v) ? v : null; };

type Harn = Awaited<ReturnType<typeof loadHarness>>;
type St = Harn["stocks"][number];
interface Cand { code: string; corp: string; last: string; first: string }
async function main(): Promise<void> {
  const MODE = (process.env.D_MODE ?? "").trim();
  if (MODE !== "pilot" && MODE !== "collect") throw new Error("D_MODE=pilot|collect 필요");
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  console.log(`배당(alotMatter) ${MODE} 시작: ${new Date().toISOString()} | DART는 alotMatter.json·list.json만, 키 비출력, DB 쓰기 0, 키당 하루 한도 ${DIV_KEY_DAILY_LIMIT}건의 80% = ${DIV_KEY_DAILY_CAP}건 이내`);
  console.log(await verifySnapshotManifest());
  const keys: PoolKey[] = [];
  for (const e of DIV_KEY_ENVS) { const v = process.env[e]; if (v) keys.push({ name: e, value: v }); }
  if (!keys.length) throw new Error("연구용 DART 키(DART_API_KEY_3 또는 _2)가 없다");
  const h = await loadHarness();
  const { excluded, membAt } = await loadK200P(h);
  const seen = new Map<string, Cand>();
  const corpRows = await selectAll<Record<string, unknown>>("dart_corp_codes", (f, t) => supabaseAdmin.from("dart_corp_codes").select("stock_code, corp_code").range(f, t));
  const corpOf = new Map(corpRows.map((r) => [String(r.stock_code), String(r.corp_code)]));
  for (const d of h.monthEnds) {
    if (d < DIV_SIGNAL_FROM || d > DIV_SIGNAL_TO) continue;
    const m = membAt(d);
    if (!m) continue;
    for (const s of h.stocks) {
      const i = s.idx.get(d);
      if (i === undefined || excluded.has(s.code) || !m.has(s.code) || !(s.mcapRow[i] > 0)) continue;
      if (!seen.has(s.code)) seen.set(s.code, { code: s.code, corp: corpOf.get(s.code) ?? "", last: s.last, first: s.dates[0] });
    }
  }
  const all = [...seen.values()].sort((a, b) => (a.code < b.code ? -1 : 1));
  console.log(`2011-03~2016-04 월말 구간 후보 종목 ${all.length}개, corp_code 매핑 ${all.filter((c) => c.corp).length}개(없는 종목은 제외·보고)`);
  const sOf = new Map(h.stocks.map((s) => [s.code, s]));
  if (MODE === "pilot") { await pilot(all, sOf, keys); return; }
  await collectAll(all, keys);
}

async function pilot(all: Cand[], sOf: Map<string, St>, keys: PoolKey[]): Promise<void> {
  const P = DIV_PILOT;
  pool = new DailyKeyPool(keys.map((k) => ({ ...k, cap: DIV_KEY_DAILY_CAP })), DIV_PILOT_CALL_CAP);
  const rng = mulberry32(P.seed);
  const shuffle = <T,>(a: T[]): T[] => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  const withRef = all.filter((c) => c.corp && sOf.get(c.code)!.idx.has(P.refDate));
  const mcapAt = (c: Cand): number => { const s = sOf.get(c.code) as St; return s.mcapRow[s.idx.get(P.refDate) as number]; };
  const sel: { c: Cand; band: string }[] = [];
  const missing: string[] = [];
  for (const code of P.named) { const c = all.find((x) => x.code === code && x.corp); if (c) sel.push({ c, band: "지정" }); else missing.push(code); }
  const taken = new Set(sel.map((x) => x.c.code));
  const vSel = shuffle(withRef.filter((c) => c.last >= P.vanishedLastFrom && c.last <= P.vanishedLastTo && !taken.has(c.code))).slice(0, P.vanished);
  for (const c of vSel) { sel.push({ c, band: "소멸" }); taken.add(c.code); }
  const surv = withRef.filter((c) => c.last > P.vanishedLastTo && !taken.has(c.code));
  const bandOf = (c: Cand): number => P.bands.findIndex(([lo, hi]) => mcapAt(c) >= lo && mcapAt(c) < hi);
  let carry = 0;
  P.bands.forEach(([lo, hi, quota], b) => {
    const take = shuffle(surv.filter((c) => bandOf(c) === b && !taken.has(c.code))).slice(0, quota + carry);
    carry = quota + carry - take.length;
    for (const c of take) { sel.push({ c, band: `${lo}~${hi === Number.POSITIVE_INFINITY ? "∞" : hi}억` }); taken.add(c.code); }
  });
  console.log(`\n=== 점검 대상 ${sel.length}개사(지정 ${sel.filter((x) => x.band === "지정").length} · 소멸 ${vSel.length} · 층화 ${sel.filter((x) => !["지정", "소멸"].includes(x.band)).length}, 시드 ${P.seed}) ${missing.length ? `| 지정 종목 중 후보에 없음: ${missing.join(",")}` : ""} ===`);
  console.log(`| # | 종목 | 구분 | ${P.refDate} 시총(억) | 첫 가격 행 | 마지막 가격 행 |\n|---|---|---|---|---|---|`);
  sel.forEach((x, i) => console.log(`| ${i + 1} | ${x.c.code} | ${x.band} | ${(sOf.get(x.c.code)!.idx.has(P.refDate) ? mcapAt(x.c).toFixed(0) : "-")} | ${x.c.first} | ${x.c.last} |`));

  interface Rec { code: string; band: string; fy: number; expected: boolean; status: string; nItems: number; rcept: string; common: AlotItem | undefined; prefN: number; rows: AlotItem[] }
  const recs: Rec[] = [];
  const listInfo = new Map<string, Filing[]>();
  let listFail = 0, fetchFail = 0;
  const seLabels = new Map<string, number>(), kndLabels = new Map<string, number>(), tokDps = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string): void => { m.set(k, (m.get(k) ?? 0) + 1); };
  for (const { c, band } of sel) {
    const s = sOf.get(c.code) as St;
    const fl = await dartList(c.corp);
    if (fl) listInfo.set(c.code, fl); else listFail++;
    for (let fy = DIV_FY_FROM; fy <= DIV_FY_TO; fy++) {
      const expected = s.dates[0] <= `${fy}-12-31` && s.last >= `${fy + 1}-03-31`;
      const r = await fetchAlot(c.corp, fy);
      if (!r) { fetchFail++; recs.push({ code: c.code, band, fy, expected, status: "fail", nItems: 0, rcept: "", common: undefined, prefN: 0, rows: [] }); continue; }
      for (const it of r.items) { bump(seLabels, `${it.se ?? "?"}`); bump(kndLabels, `${it.stock_knd ?? "(없음)"}`); }
      const dps = r.items.filter((x) => isDps(x.se)), common = dps.find((x) => isCommon(x.stock_knd)) ?? (dps.length === 1 && !isPref(dps[0].stock_knd) ? dps[0] : undefined);
      for (const x of dps) bump(tokDps, `${isCommon(x.stock_knd) ? "보통" : isPref(x.stock_knd) ? "우선" : `기타(${x.stock_knd ?? "없음"})`}:${tokOf(x.thstrm)}`);
      recs.push({ code: c.code, band, fy, expected, status: r.status, nItems: r.items.length, rcept: r.items[0]?.rcept_no ?? "", common, prefN: dps.filter((x) => isPref(x.stock_knd)).length, rows: dps });
    }
  }
  // ---- 호출당 연도·접수일·응답 구조 ----
  const ok = recs.filter((x) => x.status === "000");
  console.log(`\n=== [D1] 응답 구조 (alotMatter 호출 ${recs.length}건: status 000 ${ok.length} · 013(자료 없음) ${recs.filter((x) => x.status === "013").length} · 기타·실패 ${recs.filter((x) => x.status !== "000" && x.status !== "013").length}) ===`);
  const per = ok.length ? ok.reduce((a, x) => a + x.nItems, 0) / ok.length : 0;
  const triple = ok.filter((x) => x.common && [x.common.thstrm, x.common.frmtrm, x.common.lwfr].every((v) => v !== undefined)).length;
  console.log(`status 000 응답당 항목 평균 ${per.toFixed(1)}개 | 보통주 주당 현금배당금 행에 당기·전기·전전기 3개 연도 값 필드가 모두 있는 응답 ${triple}/${ok.filter((x) => x.common).length}(호출 1회 = 사업연도 3개 값: 당기 = 요청 사업연도, 전기, 전전기)`);
  console.log(`접수번호 형식: ${ok.slice(0, 3).map((x) => `${x.code} FY${x.fy} ${x.rcept}`).join(" · ")} | 접수번호 앞 8자리가 날짜(YYYYMMDD)로 해석되는 응답 ${ok.filter((x) => /^(20\d\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d+$/.test(x.rcept)).length}/${ok.length}`);
  const top = (m: Map<string, number>, n: number): string => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(" · ");
  console.log(`구분(se) 라벨 상위: ${top(seLabels, 14)}`);
  console.log(`stock_knd 값: ${top(kndLabels, 8)}`);
  console.log(`주당 현금배당금 행 당기값 표기(종류:표기): ${top(tokDps, 12)}`);
  // ---- 확보율 ----
  const exp = recs.filter((x) => x.expected), got = exp.filter((x) => x.common && numOf(x.common.thstrm) !== null), zeroOrDash = exp.filter((x) => x.common && numOf(x.common.thstrm) === null);
  console.log(`\n=== [D2] 확보율(분모 = 기대: 그 사업연도 말 전에 가격 행이 있고 다음 해 3월 말까지 가격이 이어진 회사-연도) ===`);
  console.log(`기대 ${exp.length}건 | alotMatter status 000 ${exp.filter((x) => x.status === "000").length}(${pc(exp.filter((x) => x.status === "000").length, exp.length)}) | 보통주 주당 현금배당금 숫자 값 ${got.length}(${pc(got.length, exp.length)}; 그중 > 0 ${got.filter((x) => (numOf(x.common?.thstrm) ?? 0) > 0).length}, = 0 ${got.filter((x) => numOf(x.common?.thstrm) === 0).length}) | 보통주 행은 있으나 값이 "-"·빈칸 ${zeroOrDash.length} | 013 ${exp.filter((x) => x.status === "013").length} | 실패 ${exp.filter((x) => x.status === "fail").length}`);
  console.log(`**확보율(숫자 값 + "-"·빈칸 무배당 표기 포함, 기대 대비)**: ${pc(got.length + zeroOrDash.length, exp.length)} | 숫자 값만: ${pc(got.length, exp.length)}`);
  console.log(`| 구분 | 기대 | status 000 | 보통주 숫자 값 | 확보율(숫자) |\n|---|---|---|---|---|`);
  for (const b of [...new Set(sel.map((x) => x.band))]) { const r = exp.filter((x) => x.band === b); console.log(`| ${b} | ${r.length} | ${r.filter((x) => x.status === "000").length} | ${r.filter((x) => x.common && numOf(x.common.thstrm) !== null).length} | ${pc(r.filter((x) => x.common && numOf(x.common.thstrm) !== null).length, r.length)} |`); }
  console.log(`사업연도별: ${Array.from({ length: DIV_FY_TO - DIV_FY_FROM + 1 }, (_, k) => DIV_FY_FROM + k).map((fy) => { const r = exp.filter((x) => x.fy === fy); return `FY${fy} ${r.filter((x) => x.common && numOf(x.common.thstrm) !== null).length}/${r.length}`; }).join(" · ")}`);
  // ---- 접수일·정정 ----
  console.log(`\n=== [D3] 접수일·정정 (list.json 정기공시와 비교; list 실패 ${listFail}개사) ===`);
  let nCmp = 0, nOrig = 0, nCorr = 0, nNoList = 0, nWithCorr = 0, nLate = 0;
  const lateDays: number[] = [];
  for (const x of ok) {
    const fl = listInfo.get(x.code);
    if (!fl) { nNoList++; continue; }
    const ann = fl.filter((f) => /사업보고서/.test(f.report_nm) && periodOf(f.report_nm)?.y === x.fy);
    if (!ann.length) continue;
    nCmp++;
    const orig = [...ann.filter((f) => !/정정/.test(f.report_nm))].sort((a, b) => (a.rcept_no < b.rcept_no ? -1 : 1))[0];
    if (ann.some((f) => /정정/.test(f.report_nm))) nWithCorr++;
    if (orig && x.rcept === orig.rcept_no) nOrig++;
    else { nCorr++; if (orig) { const dd = (Date.parse(isoOf(x.rcept.slice(0, 8))) - Date.parse(isoOf(orig.rcept_dt))) / 86_400_000; lateDays.push(dd); if (dd > 30) nLate++; } }
  }
  console.log(`사업보고서가 list에 있는 응답 ${nCmp}건 중: 접수번호 = 원본(정정 표기 없는 최초 접수본) ${nOrig}건 · ≠ 원본(정정본 또는 다른 접수) ${nCorr}건(그중 원본보다 30일 넘게 늦음 ${nLate}건; 지연일 중앙값 ${lateDays.length ? [...lateDays].sort((a, b) => a - b)[Math.floor(lateDays.length / 2)] : "-"}) | 그 회사-연도에 정정 사업보고서가 있는 응답 ${nWithCorr}건 | list 없음 ${nNoList}`);
  // ---- 값 일관성(정정·재작성 시 값이 바뀌는지): Y의 당기 vs Y+1의 전기, Y+2의 전전기 ----
  let eq1 = 0, ne1 = 0, eq2 = 0, ne2 = 0;
  const diffs: string[] = [];
  const keyed = new Map(recs.map((x) => [`${x.code}|${x.fy}`, x]));
  for (const x of recs) {
    const cur = x.common ? numOf(x.common.thstrm) : null;
    if (cur === null) continue;
    const n1 = keyed.get(`${x.code}|${x.fy + 1}`)?.common, n2 = keyed.get(`${x.code}|${x.fy + 2}`)?.common;
    if (n1 && numOf(n1.frmtrm) !== null) { if (numOf(n1.frmtrm) === cur) eq1++; else { ne1++; if (diffs.length < 8) diffs.push(`${x.code} FY${x.fy} 당시 ${cur} → 다음 해 보고서의 전기 ${numOf(n1.frmtrm)}`); } }
    if (n2 && numOf(n2.lwfr) !== null) { if (numOf(n2.lwfr) === cur) eq2++; else ne2++; }
  }
  console.log(`값 일관성: FY Y 당기값 vs FY Y+1 보고서의 전기값 같음 ${eq1} · 다름 ${ne1} | vs FY Y+2 보고서의 전전기값 같음 ${eq2} · 다름 ${ne2}${diffs.length ? ` | 다른 예: ${diffs.join(" ; ")}` : ""}`);
  console.log(`(정정 공시 전 원본 값은 alotMatter로 얻을 수 없다: 요청은 회사·사업연도·보고서 종류만 받아 최신 접수본을 돌려준다 → 한계로 기록. 접수번호가 원본이 아니면 그 접수일을 쓰면 PIT는 안전(늦게 반영)하지만 값이 정정값일 수 있다.)`);
  // ---- 우선주·보통주 ----
  const withPref = recs.filter((x) => x.prefN > 0);
  console.log(`\n=== [D4] 우선주 구분·무배당 표기 ===`);
  console.log(`우선주 주당 현금배당금 행이 있는 응답 ${withPref.length}건(회사 ${new Set(withPref.map((x) => x.code)).size}개: ${[...new Set(withPref.map((x) => x.code))].join(",")}) | 보통주 행 판별 불가(stock_knd 없음·여러 행) ${ok.filter((x) => !x.common && x.rows.length > 0).length}건`);
  console.log(`예시(지정 6개사 FY2023 주당 현금배당금 행): ${recs.filter((x) => x.band === "지정" && x.fy === 2023).map((x) => `${x.code}[${x.rows.map((r) => `${r.stock_knd ?? "-"} 당기 ${r.thstrm ?? "-"} 전기 ${r.frmtrm ?? "-"}`).join("; ")}] ${x.rcept}`).join(" | ")}`);
  // ---- 호출 수·시간 추정 ----
  const nFull = all.filter((c) => c.corp).length, years = DIV_FY_TO - DIV_FY_FROM + 1, elapsedMin = (Date.now() - T0) / 60_000, callsPerMin = stats.calls / Math.max(elapsedMin, 1e-9);
  const listPerCorp = sel.length - listFail > 0 ? 1.2 : 1;
  const estAlot = nFull * years, estList = Math.round(nFull * listPerCorp), est = estAlot + estList, daily = DIV_KEY_DAILY_CAP * keys.length;
  console.log(`\n=== [D5] 호출 수·시간 추정 ===`);
  console.log(`점검: DART 호출 ${pool.total}건(요청 성공 ${stats.calls}, 재시도 ${stats.retries}, 시간 초과 ${stats.timeouts}, HTTP 5xx·429 ${stats.http5xx}) | 키별 ${[...pool.used].map(([k, v]) => `${k} ${v}`).join(", ")} | status 020 ${[...pool.got020].reduce((a, [, v]) => a + v, 0)}회 | alotMatter 실패 ${fetchFail} | list 실패 ${listFail} | 소요 ${elapsedMin.toFixed(1)}분(분당 약 ${callsPerMin.toFixed(0)}건)`);
  console.log(`본 수집 추정: 대상 ${nFull}개사 × ${years}개 사업연도 = alotMatter ${estAlot}건 + list.json 약 ${estList}건(원본·정정 접수일 확인용, 회사당 1회) = 약 ${est}건 | 하루 가능 ${daily}건(키 ${keys.length}개 × ${DIV_KEY_DAILY_CAP}) → ${Math.ceil(est / daily)}일 | 순수 호출 소요 약 ${(est / Math.max(callsPerMin, 1) / 60).toFixed(1)}시간(연속 실행 ${DIV_SOFT_DEADLINE_MINUTES}분씩이면 ${Math.ceil(est / (callsPerMin * DIV_SOFT_DEADLINE_MINUTES))}회차)`);
  const cov = got.length / Math.max(exp.length, 1), days = Math.ceil(est / daily);
  const passA = triple > 0 && ok.length > 0, passB = ok.length > 0 && ok.filter((x) => /^(20\d\d)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d+$/.test(x.rcept)).length === ok.length, passC = cov >= DIV_PASS.minCoverage, passD = days <= DIV_PASS.maxDays;
  console.log(`\n**판정(사전 고정 기준)**: ① 호출 1회로 당기 값·접수번호 수신 ${passA ? "O" : "X"} · ② 접수일을 접수번호에서 알 수 있음 ${passB ? "O" : "X"} · ③ 기대 대비 보통주 숫자 값 확보율 ${(cov * 100).toFixed(1)}% ≥ ${DIV_PASS.minCoverage * 100}% ${passC ? "O" : "X"} · ④ 키 일일 한도(80%) 안에서 ${days}일 ≤ ${DIV_PASS.maxDays}일 ${passD ? "O" : "X"} → ${passA && passB && passC && passD ? "**통과**" : "**불통과 — 멈추고 보고**"}`);
  console.log(`\n점검 종료(저장 없음) | ${storageLine()} | 연구 DB 쓰기 0 | 키 값 출력 없음`);
}

// ---- 본 수집 ----
const DATA_COLS: ColDef[] = [["corp_code", "STRING"], ["stock_code", "STRING"], ["bsns_year", "STRING"], ["status", "STRING"], ["rcept_no", "STRING"], ["rcept_dt", "STRING"], ["dps_common", "DOUBLE"], ["dps_common_raw", "STRING"], ["dps_pref", "DOUBLE"], ["frmtrm_common", "DOUBLE"], ["lwfr_common", "DOUBLE"], ["orig_rcept_no", "STRING"], ["amended", "STRING"]].map(([name, type]) => ({ name, type: type as "STRING" | "DOUBLE" }));
interface Progress { version: 1; done: string[]; daily: Record<string, Record<string, number>>; runs: { at: string; corps: number; calls: number; stop: string }[] }

async function collectAll(all: Cand[], keys: PoolKey[]): Promise<void> {
  const targets = all.filter((c) => c.corp);
  const today = kstDate();
  const progBuf = await downloadBuf(DIV_PROGRESS_FILE), dataBuf = await downloadBuf(DIV_DATA_FILE);
  const prog: Progress = progBuf ? JSON.parse(Buffer.from(progBuf).toString("utf8")) : { version: 1, done: [], daily: {}, runs: [] };
  const rows: Row[] = dataBuf ? await decodeTable(dataBuf) : [];
  const done = new Set(prog.done);
  const used = prog.daily[today] ?? {};
  const capped: PoolKey[] = keys.map((k) => ({ ...k, cap: Math.max(DIV_KEY_DAILY_CAP - (used[k.name] ?? 0), 0) }));
  pool = new DailyKeyPool(capped.filter((k) => (k.cap ?? 0) > 0), DIV_TOTAL_CALL_CAP);
  console.log(`대상 ${targets.length}개사(corp_code 있음), 이미 완료 ${done.size}개사, 저장 행 ${rows.length} | 오늘(${today}) 키별 남은 한도 ${capped.map((k) => `${k.name} ${k.cap}`).join(", ")}`);
  const todo = targets.filter((c) => !done.has(c.corp));
  let cursor = 0, doneNow = 0, stop = "전체 처리 완료", listFail = 0, fetchFail = 0;
  const deadline = T0 + DIV_SOFT_DEADLINE_MINUTES * 60_000;
  const newDone: string[] = [];
  const st = { corps: 0, alotOk: 0, alot013: 0, withCommon: 0, amended: 0 };
  const flush = async (): Promise<void> => {
    const usage = await storageUsage();
    const buf = encodeTable(DATA_COLS, rows);
    await uploadBuf(DIV_DATA_FILE, buf);
    for (const c of newDone) done.add(c);
    newDone.length = 0;
    prog.done = [...done];
    const dn = prog.daily[today] ?? {};
    for (const [k, v] of pool.used) dn[k] = (used[k] ?? 0) + v;
    prog.daily[today] = dn;
    await uploadBuf(DIV_PROGRESS_FILE, new TextEncoder().encode(JSON.stringify(prog)));
    console.log(`  저장: 완료 ${done.size}/${targets.length}개사, 행 ${rows.length}, 파일 ${(buf.byteLength / MiB).toFixed(2)} MiB, Storage 총량 ${(usage.total / MiB).toFixed(2)} MiB`);
  };
  const worker = async (): Promise<void> => {
    for (;;) {
      if (Date.now() > deadline) { stop = `소프트 마감 ${DIV_SOFT_DEADLINE_MINUTES}분 도달`; return; }
      const c = todo[cursor++];
      if (!c) return;
      const fl = await dartList(c.corp);
      if (!fl) { listFail++; if (pool.stopReason) { stop = pool.stopReason; return; } continue; }
      const origBy = new Map<number, Filing>(), anyBy = new Map<number, Filing[]>();
      for (const f of fl) { const p = /사업보고서/.test(f.report_nm) ? periodOf(f.report_nm) : null; if (!p) continue; anyBy.set(p.y, [...(anyBy.get(p.y) ?? []), f]); if (!/정정/.test(f.report_nm)) { const o = origBy.get(p.y); if (!o || f.rcept_no < o.rcept_no) origBy.set(p.y, f); } }
      const out: Row[] = [];
      let failed = false;
      for (let fy = DIV_FY_FROM; fy <= DIV_FY_TO; fy++) {
        const r = await fetchAlot(c.corp, fy);
        if (!r) { fetchFail++; failed = true; break; }
        const dps = r.items.filter((x) => isDps(x.se)), common = dps.find((x) => isCommon(x.stock_knd)) ?? (dps.length === 1 && !isPref(dps[0].stock_knd) ? dps[0] : undefined), pref = dps.find((x) => isPref(x.stock_knd));
        const rcept = r.items[0]?.rcept_no ?? "", orig = origBy.get(fy);
        if (r.status === "000") st.alotOk++; else if (r.status === "013") st.alot013++;
        if (common) st.withCommon++;
        const amended = !!rcept && !!orig && rcept !== orig.rcept_no;
        if (amended) st.amended++;
        out.push({ corp_code: c.corp, stock_code: c.code, bsns_year: String(fy), status: r.status, rcept_no: rcept, rcept_dt: /^\d{8}/.test(rcept) ? isoOf(rcept.slice(0, 8)) : "", dps_common: common ? numOf(common.thstrm) : null, dps_common_raw: common?.thstrm ?? "", dps_pref: pref ? numOf(pref.thstrm) : null, frmtrm_common: common ? numOf(common.frmtrm) : null, lwfr_common: common ? numOf(common.lwfr) : null, orig_rcept_no: orig?.rcept_no ?? "", amended: amended ? "Y" : "" });
      }
      if (failed) { if (pool.stopReason) { stop = pool.stopReason; return; } continue; }
      rows.push(...out); newDone.push(c.corp); st.corps++; doneNow++;
      if (doneNow % DIV_FLUSH_EVERY_CORPS === 0) { await flush(); console.log(`  진행: 이번 실행 ${doneNow}개사, DART ${pool.total}건, 소요 ${((Date.now() - T0) / 60_000).toFixed(1)}분`); }
    }
  };
  await Promise.all(Array.from({ length: DIV_CONCURRENCY }, worker));
  if (pool.stopReason && stop === "전체 처리 완료") stop = pool.stopReason;
  await flush();
  prog.runs.push({ at: new Date().toISOString(), corps: doneNow, calls: pool.total, stop });
  await uploadBuf(DIV_PROGRESS_FILE, new TextEncoder().encode(JSON.stringify(prog)));
  console.log(`\n=== 본 수집 결과(이번 실행) ===\n처리 ${doneNow}개사(누적 ${done.size}/${targets.length}), 남은 ${targets.length - done.size}개사 | 정지 사유: ${stop}\nalotMatter status 000 ${st.alotOk} · 013 ${st.alot013} | 보통주 주당 현금배당금 행 ${st.withCommon} | 접수번호 ≠ 원본(정정 등) ${st.amended} | list 실패 ${listFail} · alotMatter 실패 ${fetchFail}\nDART 호출 ${pool.total}건 | 키별 ${[...pool.used].map(([k, v]) => `${k} ${v}`).join(", ")} | status 020 ${[...pool.got020].reduce((a, [, v]) => a + v, 0)}회 | 오늘 누적 사용 ${[...pool.used].map(([k, v]) => `${k} ${(used[k] ?? 0) + v}`).join(", ")}(한도 ${DIV_KEY_DAILY_CAP}) | 재시도 ${stats.retries} · 시간 초과 ${stats.timeouts} | 소요 ${((Date.now() - T0) / 60_000).toFixed(1)}분\n${storageLine()} | 연구 DB 쓰기 0 | 키 값 출력 없음`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

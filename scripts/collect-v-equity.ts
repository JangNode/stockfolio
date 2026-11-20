/**
 * [임시 연구 — 병합 금지] 저평가(PBR) 시험용 2016년 이전 자본총계 수집. 사용자 승인 2026-11-20. 문서: docs/research/value-data-check.md (파일럿 기준은 호출 전 커밋 db14d26·1d33434).
 * V_MODE=pilot: 30개사 × FY2011~2014 사업보고서(+ 10개사 FY2013 반기·분기) XBRL로 자본 확보율을 잰다(저장 없음, 로그 표만).
 * V_MODE=collect: 2011-03~2016-04 월말 구간 종목 전체의 사업·반기·분기 보고서(원본 접수본)에서 자본총계를 파싱해 Storage research/v_equity/ 한 사본에 쌓는다(이어받기).
 * DART는 정기 재무로 PBR을 만드는 용도로만, list.json·fnlttXbrl.xml만 호출. 연구용 키 DART_API_KEY_3 → _2만. 연구 DB 쓰기 0, 키 값 출력 없음, 문서·원문은 저장하지 않는다(파싱 결과만).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { encodeTable, decodeTable, downloadBuf, uploadBuf, storageUsage, MiB, kstDate, type ColDef, type Row } from "@/lib/nBookStore";
import { parseInst, ctxKind, periodOf, lastDayOfMonth, type Filing, type RFact } from "@/lib/dartXbrlExtract";
import {
  VEQ_DATA_FILE, VEQ_PROGRESS_FILE, VEQ_SIGNAL_FROM, VEQ_SIGNAL_TO, VEQ_LIST_FROM, VEQ_LIST_TO, VEQ_LIST_PAGE_COUNT, VEQ_PILOT,
  VEQ_ANNUAL_DUE_MMDD, VEQ_QUARTER_DUE_DAYS, VEQ_KEY_ENVS, VEQ_KEY_DAILY_CAP, VEQ_TOTAL_CALL_CAP, VEQ_GAP_MS, VEQ_CONCURRENCY, VEQ_MAX_RETRIES,
  VEQ_RETRY_BASE_MS, VEQ_SOFT_DEADLINE_MINUTES, VEQ_FLUSH_EVERY_CORPS, VEQ_USER_EQUITY_LOCAL, VEQ_PARENT_EQUITY_LOCAL,
} from "@/lib/valueEquityConfig";
import { DartKeyPool, type PoolKey } from "./dartKeyPool";
import { loadHarness, loadK200P, verifySnapshotManifest, selectAll, mulberry32, SNAP_END, storageLine } from "./researchHarness";

const DART = "https://opendart.fss.or.kr/api";
const T0 = Date.now();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isZip = (b: Buffer): boolean => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b;
const toIso = (d: string): string => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d.slice(0, 10));
const pc = (a: number, b: number): string => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const addDays = (iso: string, n: number): string => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);

// ---- DART 호출: 키 풀 + 동시 4 + 최소 간격 ----
let pool: DartKeyPool;
let nextSlot = 0;
const slot = async (): Promise<void> => { const now = Date.now(), s = Math.max(now, nextSlot); nextSlot = s + VEQ_GAP_MS; if (s > now) await sleep(s - now); };
const statusOf = (buf: Buffer): string | undefined => { const t = buf.toString("utf-8", 0, 400); return /"status"\s*:\s*"(\d+)"/.exec(t)?.[1] ?? /<status>(\d+)</.exec(t)?.[1]; };
interface Resp { buf: Buffer; zip: boolean; status?: string }
const callsByKey = new Map<string, number>();
async function dartGet(build: (key: string) => string): Promise<Resp | null> {
  for (let attempt = 0; attempt <= VEQ_MAX_RETRIES; attempt++) {
    const k = pool.reserve();
    if (!k) return null;
    await slot();
    try {
      const res = await fetch(build(k.value));
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (isZip(buf)) return { buf, zip: true };
      const st = statusOf(buf);
      if (st === "020") { if (pool.on020(k.name)) { attempt--; continue; } return null; }
      if (st === "800") throw new Error("status 800");
      return { buf, zip: false, status: st };
    } catch { if (attempt < VEQ_MAX_RETRIES) await sleep(VEQ_RETRY_BASE_MS * 2 ** attempt); }
  }
  return null;
}
async function dartList(corp: string): Promise<Filing[] | null> {
  const rows: Filing[] = [];
  for (let page = 1, pages = 1; page <= pages; page++) {
    const r = await dartGet((key) => `${DART}/list.json?crtfc_key=${key}&corp_code=${corp}&bgn_de=${VEQ_LIST_FROM}&end_de=${VEQ_LIST_TO}&pblntf_ty=A&page_no=${page}&page_count=${VEQ_LIST_PAGE_COUNT}`);
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

// ---- 보고서 선택·자본 추출 ----
type Kind = "annual" | "half" | "quarter";
const kindOf = (nm: string): Kind | null => (/사업보고서/.test(nm) ? "annual" : /반기보고서/.test(nm) ? "half" : /분기보고서/.test(nm) ? "quarter" : null);
const reprtOf = (k: Kind, m: number): string => (k === "annual" ? "11011" : k === "half" ? "11012" : m <= 6 ? "11013" : "11014");
interface Rep { kind: Kind; y: number; m: number; end: string; filing: Filing; amendedOnly: boolean }
/** 원본(정정 표기 없는) 중 가장 빠른 접수본 — 정정만 있으면 그중 가장 빠른 것(amendedOnly). 기간(y, m, 종류)마다 1건. */
function reportsOf(filings: Filing[]): Rep[] {
  const by = new Map<string, Filing[]>();
  for (const f of filings) { const k = kindOf(f.report_nm), p = periodOf(f.report_nm); if (!k || !p) continue; const key = `${k}|${p.y}|${p.m}`; by.set(key, [...(by.get(key) ?? []), f]); }
  const out: Rep[] = [];
  for (const [key, fs] of by) {
    const [k, y, m] = key.split("|"), sorted = [...fs].sort((a, b) => (a.rcept_dt === b.rcept_dt ? (a.rcept_no < b.rcept_no ? -1 : 1) : a.rcept_dt < b.rcept_dt ? -1 : 1));
    const plain = sorted.filter((f) => !/정정/.test(f.report_nm)), f = plain[0] ?? sorted[0];
    out.push({ kind: k as Kind, y: Number(y), m: Number(m), end: lastDayOfMonth(Number(y), Number(m)), filing: f, amendedOnly: plain.length === 0 });
  }
  return out;
}
interface EqOut { total: number | null; totalBasis: string | null; parent: number | null; parentBasis: string | null }
const KIND_ORDER = ["연결", "없음", "별도"] as const;
const BASIS = { 연결: "cons", 없음: "nodim", 별도: "sep" } as const;
function pickEq(facts: RFact[], end: string, local: string): { v: number; basis: string } | null {
  for (const kind of KIND_ORDER) {
    const f = facts.find((x) => x.local === local && x.start === undefined && x.end === end && ctxKind(x.dims) === kind);
    if (f) { const v = Number(f.value.replace(/,/g, "")); if (Number.isFinite(v)) return { v, basis: BASIS[kind] }; }
  }
  return null;
}
type Fetched = { status: "ok" | "xbrl_014" | "no_equity" | "fail"; eq: EqOut };
const NONE: EqOut = { total: null, totalBasis: null, parent: null, parentBasis: null };
async function fetchEq(rep: Rep): Promise<Fetched> {
  const r = await dartGet((key) => `${DART}/fnlttXbrl.xml?crtfc_key=${key}&rcept_no=${rep.filing.rcept_no}&reprt_code=${reprtOf(rep.kind, rep.m)}`);
  if (!r) return { status: "fail", eq: NONE };
  if (!r.zip) return { status: r.status === "014" || r.status === "013" ? "xbrl_014" : "fail", eq: NONE };
  const p = parseInst(r.buf);
  if ("error" in p) return { status: "fail", eq: NONE };
  const t = pickEq(p.facts, rep.end, VEQ_USER_EQUITY_LOCAL), q = pickEq(p.facts, rep.end, VEQ_PARENT_EQUITY_LOCAL);
  const eq: EqOut = { total: t?.v ?? null, totalBasis: t?.basis ?? null, parent: q?.v ?? null, parentBasis: q?.basis ?? null };
  return { status: t ? "ok" : "no_equity", eq };
}

type Harn = Awaited<ReturnType<typeof loadHarness>>;
type St = Harn["stocks"][number];
// ---- 가격 자료 기반 대상 ----
interface Cand { code: string; corp: string; mcap: number; last: string; first: string }
async function main(): Promise<void> {
  const MODE = (process.env.V_MODE ?? "").trim();
  if (MODE !== "pilot" && MODE !== "collect") throw new Error("V_MODE=pilot|collect 필요");
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  console.log(`저평가(PBR) 자본 수집(${MODE}) 시작: ${new Date().toISOString()} | DART는 정기 재무→PBR 용도(list.json·fnlttXbrl.xml만), 키 비출력, DB 쓰기 0`);
  console.log(await verifySnapshotManifest());
  const keys: PoolKey[] = [];
  for (const e of VEQ_KEY_ENVS) { const v = process.env[e]; if (v) keys.push({ name: e, value: v }); }
  if (!keys.length) throw new Error("연구용 DART 키(DART_API_KEY_3 또는 _2)가 없다");
  const h = await loadHarness();
  const { CAL, nCal } = h;
  const { excluded, membAt } = await loadK200P(h);

  // 월말 구간 후보(제외 규칙 통과·월말 목록·가격 행·시총>0)
  const seen = new Map<string, Cand>();
  const corpRows = await selectAll<Record<string, unknown>>("dart_corp_codes", (f, t) => supabaseAdmin.from("dart_corp_codes").select("stock_code, corp_code").range(f, t));
  const corpOf = new Map(corpRows.map((r) => [String(r.stock_code), String(r.corp_code)]));
  const refIdx = (() => { let k = -1; for (let i = 0; i < nCal; i++) if (CAL[i] <= VEQ_PILOT.refDate) k = i; return k; })();
  const refDate = CAL[refIdx];
  for (const d of h.monthEnds) {
    if (d < VEQ_SIGNAL_FROM || d > VEQ_SIGNAL_TO) continue;
    const m = membAt(d);
    if (!m) continue;
    for (const s of h.stocks) {
      const i = s.idx.get(d);
      if (i === undefined || excluded.has(s.code) || !m.has(s.code) || !(s.mcapRow[i] > 0)) continue;
      if (!seen.has(s.code)) seen.set(s.code, { code: s.code, corp: corpOf.get(s.code) ?? "", mcap: 0, last: s.last, first: s.dates[0] });
    }
  }
  const all = [...seen.values()].sort((a, b) => (a.code < b.code ? -1 : 1));
  console.log(`2011-03~2016-04 월말 구간 후보 종목 ${all.length}개, corp_code 매핑 ${all.filter((c) => c.corp).length}개(없는 종목은 제외·보고)`);
  const sOf = new Map(h.stocks.map((s) => [s.code, s]));

  if (MODE === "pilot") { await pilot(all, sOf, refDate, keys); return; }
  await collectAll(all, keys);
}

async function pilot(all: Cand[], sOf: Map<string, St>, refDate: string, keys: PoolKey[]): Promise<void> {
  const P = VEQ_PILOT;
  pool = new DartKeyPool(keys, 240);
  const rng = mulberry32(P.seed);
  const shuffle = <T,>(a: T[]): T[] => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  const withRef = all.filter((c) => c.corp && sOf.get(c.code)!.idx.has(refDate));
  const mcapAt = (c: Cand): number => { const s = sOf.get(c.code) as St; return s.mcapRow[s.idx.get(refDate) as number]; };
  const vanishedPool = withRef.filter((c) => c.last >= P.vanishedLastFrom && c.last <= P.vanishedLastTo);
  const vSel = shuffle(vanishedPool).slice(0, P.vanished);
  const vSet = new Set(vSel.map((c) => c.code));
  const surv = withRef.filter((c) => c.last > P.vanishedLastTo && !vSet.has(c.code));
  const bandOf = (c: Cand): number => P.bands.findIndex(([lo, hi]) => mcapAt(c) >= lo && mcapAt(c) < hi);
  const sel: { c: Cand; band: string }[] = vSel.map((c) => ({ c, band: "소멸" }));
  const notes: string[] = [];
  let carry = 0;
  P.bands.forEach(([lo, hi, quota], b) => {
    const cands = shuffle(surv.filter((c) => bandOf(c) === b && !sel.some((x) => x.c.code === c.code)));
    const take = cands.slice(0, quota + carry);
    if (take.length < quota + carry) { notes.push(`구간 ${lo}~${hi === Number.POSITIVE_INFINITY ? "∞" : hi}억 후보 부족(${take.length}/${quota + carry}) → 다음 구간으로 이월`); carry = quota + carry - take.length; } else carry = 0;
    for (const c of take) sel.push({ c, band: `${lo}~${hi === Number.POSITIVE_INFINITY ? "∞" : hi}억` });
  });
  console.log(`\n=== 파일럿 대상 ${sel.length}개사 (기준일 ${refDate} 시총 구간 층화, 시드 ${P.seed}; 소멸 ${vSel.length}개) ===${notes.length ? "\n" + notes.join("\n") : ""}`);
  console.log(`| # | 종목 | 구분 | ${refDate} 시총(억) | 마지막 가격 행 |\n|---|---|---|---|---|`);
  sel.forEach((x, i) => console.log(`| ${i + 1} | ${x.c.code} | ${x.band} | ${mcapAt(x.c).toFixed(0)} | ${x.c.last} |`));

  interface Row2 { code: string; band: string; kind: Kind; y: number; expected: boolean; found: boolean; rcept: string; status: string; eqTotal: number | null; eqParent: number | null; m: number; amended: boolean }
  const rows: Row2[] = [];
  let listFail = 0;
  for (let n = 0; n < sel.length; n++) {
    const { c, band } = sel[n], s = sOf.get(c.code) as St;
    const filings = await dartList(c.corp);
    if (!filings) { listFail++; continue; }
    const reps = reportsOf(filings);
    const hasRowBefore = (iso: string): boolean => s.dates[0] <= iso;
    const aliveTo = (iso: string): boolean => s.last >= iso;
    for (let fy = P.fyFrom; fy <= P.fyTo; fy++) {
      const expected = hasRowBefore(`${fy}-12-31`) && aliveTo(`${fy + 1}-${VEQ_ANNUAL_DUE_MMDD}`);
      const rep = reps.find((r) => r.kind === "annual" && r.y === fy);
      let status = "no_report", eqT: number | null = null, eqP: number | null = null;
      if (rep && expected) { const f = await fetchEq(rep); status = f.status; eqT = f.eq.total; eqP = f.eq.parent; }
      rows.push({ code: c.code, band, kind: "annual", y: fy, expected, found: !!rep, rcept: rep ? toIso(rep.filing.rcept_dt) : "", status, eqTotal: eqT, eqParent: eqP, m: rep?.m ?? 0, amended: !!rep?.amendedOnly });
    }
    if (n < P.quarterlyCompanies) {
      for (const m of [3, 6, 9]) {
        const end = lastDayOfMonth(P.quarterlyFy, m), due = addDays(end, VEQ_QUARTER_DUE_DAYS);
        const expected = hasRowBefore(end) && aliveTo(due);
        const rep = reps.find((r) => (r.kind === "half" || r.kind === "quarter") && r.y === P.quarterlyFy && r.m === m);
        let status = "no_report", eqT: number | null = null, eqP: number | null = null;
        if (rep && expected) { const f = await fetchEq(rep); status = f.status; eqT = f.eq.total; eqP = f.eq.parent; }
        rows.push({ code: c.code, band, kind: m === 6 ? "half" : "quarter", y: P.quarterlyFy, expected, found: !!rep, rcept: rep ? toIso(rep.filing.rcept_dt) : "", status, eqTotal: eqT, eqParent: eqP, m, amended: !!rep?.amendedOnly });
      }
    }
  }
  console.log(`\n=== 파일럿 결과 (분모 = 기대 보고서 수: 그 기말 전에 가격 행이 있고 접수 예정일까지 가격 행이 이어진 회사-기간) ===`);
  const kinds: Kind[] = ["annual", "half", "quarter"];
  console.log(`| 보고서 | 기대 | 접수일 확보(list에서 원본 찾음) | 자본(Equity) 파싱 | **자본 확보율(기대 대비)** | 지배주주지분 파싱 | XBRL 없음(014) | 자본 항목 없음 | 호출 실패 | 정정본만 |\n|---|---|---|---|---|---|---|---|---|---|`);
  for (const k of kinds) {
    const r = rows.filter((x) => x.kind === k && x.expected), got = r.filter((x) => x.found), ok = r.filter((x) => x.eqTotal !== null);
    console.log(`| ${k === "annual" ? "사업(FY2011~2014)" : k === "half" ? `반기(FY${P.quarterlyFy}, 10개사)` : `분기 1·3(FY${P.quarterlyFy}, 10개사)`} | ${r.length} | ${got.length} (${pc(got.length, r.length)}) | ${ok.length} | **${pc(ok.length, r.length)}** | ${r.filter((x) => x.eqParent !== null).length} | ${r.filter((x) => x.status === "xbrl_014").length} | ${r.filter((x) => x.status === "no_equity").length} | ${r.filter((x) => x.status === "fail").length} | ${r.filter((x) => x.amended).length} |`);
  }
  console.log(`\n사업보고서 구분별(시총 구간·소멸):\n| 구분 | 기대 | 접수일 확보 | 자본 파싱 | 자본 확보율 |\n|---|---|---|---|---|`);
  for (const b of [...new Set(sel.map((x) => x.band))]) { const r = rows.filter((x) => x.kind === "annual" && x.expected && x.band === b); console.log(`| ${b} | ${r.length} | ${r.filter((x) => x.found).length} | ${r.filter((x) => x.eqTotal !== null).length} | ${pc(r.filter((x) => x.eqTotal !== null).length, r.length)} |`); }
  const fyRows = (fy: number): Row2[] => rows.filter((x) => x.kind === "annual" && x.expected && x.y === fy);
  console.log(`\n사업보고서 회계연도별: ${[2011, 2012, 2013, 2014].map((fy) => `FY${fy} 기대 ${fyRows(fy).length} · 자본 ${fyRows(fy).filter((x) => x.eqTotal !== null).length} (${pc(fyRows(fy).filter((x) => x.eqTotal !== null).length, fyRows(fy).length)})`).join(" | ")}`);
  const nonDec = rows.filter((x) => x.kind === "annual" && x.found && x.m !== 12);
  console.log(`결산월 12월이 아닌 사업보고서: ${nonDec.length}건(자본 파싱 ${nonDec.filter((x) => x.eqTotal !== null).length}) | 연결·별도·차원없음 기준: ${["cons", "nodim", "sep"].map((b) => `${b} -`).join(" ")}`);
  const annual = rows.filter((x) => x.kind === "annual" && x.expected), cap = annual.length ? annual.filter((x) => x.eqTotal !== null).length / annual.length : 0;
  console.log(`\n**판정(사전 고정 기준: 사업보고서 기준 자본 확보율 ≥ ${(P.passAnnualCapture * 100).toFixed(0)}%)**: 자본 확보율 ${(cap * 100).toFixed(1)}% (${annual.filter((x) => x.eqTotal !== null).length}/${annual.length}) → ${cap >= P.passAnnualCapture ? "**통과 → B(본 수집) 진행**" : "**미달 → B 건너뜀, C-2(2016-05 이후만)로 진행**"}`);
  console.log(`분기 보고서 비율(보조): 반기·분기 기대 ${rows.filter((x) => x.kind !== "annual" && x.expected).length}건 중 자본 파싱 ${rows.filter((x) => x.kind !== "annual" && x.expected && x.eqTotal !== null).length}건`);
  console.log(`\nDART 호출 ${pool.total}건(list ${sel.length - listFail + listFail}회 이상 + XBRL) | 키별 ${[...pool.used].map(([k, v]) => `${k} ${v}`).join(", ")} | status 020 ${[...pool.got020].reduce((a, [, v]) => a + v, 0)}회 | list 실패 ${listFail} | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | Storage 쓰기 0 | 연구 DB 쓰기 0 | ${storageLine()}`);
}

// ---- 본 수집 ----
const DATA_COLS: ColDef[] = [["corp_code", "STRING"], ["stock_code", "STRING"], ["kind", "STRING"], ["bsns_year", "STRING"], ["period_end", "STRING"], ["rcept_no", "STRING"], ["rcept_dt", "STRING"], ["status", "STRING"], ["amended_only", "STRING"], ["eq_total", "DOUBLE"], ["eq_total_basis", "STRING"], ["eq_parent", "DOUBLE"], ["eq_parent_basis", "STRING"]].map(([name, type]) => ({ name, type: type as "STRING" | "DOUBLE" }));
interface Progress { version: 1; done: string[]; daily: Record<string, Record<string, number>>; runs: { at: string; corps: number; calls: number; stop: string }[] }

async function collectAll(all: Cand[], keys: PoolKey[]): Promise<void> {
  const targets = all.filter((c) => c.corp);
  const today = kstDate();
  const progBuf = await downloadBuf(VEQ_PROGRESS_FILE), dataBuf = await downloadBuf(VEQ_DATA_FILE);
  const prog: Progress = progBuf ? JSON.parse(Buffer.from(progBuf).toString("utf8")) : { version: 1, done: [], daily: {}, runs: [] };
  const rows: Row[] = dataBuf ? await decodeTable(dataBuf) : [];
  const done = new Set(prog.done);
  const used = prog.daily[today] ?? {};
  const capped: PoolKey[] = keys.map((k) => ({ ...k, cap: Math.max(VEQ_KEY_DAILY_CAP - (used[k.name] ?? 0), 0) }));
  pool = new DartKeyPool(capped.filter((k) => (k.cap ?? 0) > 0), VEQ_TOTAL_CALL_CAP);
  console.log(`대상 ${targets.length}개사(corp_code 있음), 이미 완료 ${done.size}개사, 저장 행 ${rows.length} | 오늘(${today}) 키별 남은 한도 ${capped.map((k) => `${k.name} ${k.cap}`).join(", ")}`);
  const todo = targets.filter((c) => !done.has(c.corp));
  let cursor = 0, doneNow = 0, stop = "전체 처리 완료", listFail = 0, fetchFail = 0;
  const deadline = T0 + VEQ_SOFT_DEADLINE_MINUTES * 60_000;
  const newDone: string[] = [];
  const stats = { ok: 0, xbrl_014: 0, no_equity: 0, fail: 0, reports: 0 };
  const flush = async (): Promise<void> => {
    const t = await storageUsage();
    if (t.total + 5 * MiB > 800 * MiB) throw new Error(`Storage 총량 ${(t.total / MiB).toFixed(2)} MiB — 800 MiB 가드(여유 5 MiB 미만)라 쓰지 않는다`);
    await uploadBuf(VEQ_DATA_FILE, encodeTable(DATA_COLS, rows));
    prog.done = [...done]; prog.daily[today] = Object.fromEntries([...pool.used].map(([k, v]) => [k, (used[k] ?? 0) + v]));
    await uploadBuf(VEQ_PROGRESS_FILE, new TextEncoder().encode(JSON.stringify(prog)));
  };
  let sinceFlush = 0;
  async function worker(): Promise<void> {
    while (!pool.stopReason) {
      if (Date.now() > deadline) { stop = `소프트 데드라인 ${VEQ_SOFT_DEADLINE_MINUTES}분 도달`; return; }
      const i = cursor++;
      if (i >= todo.length) return;
      const c = todo[i];
      const filings = await dartList(c.corp);
      if (!filings) { listFail++; if (pool.stopReason) return; continue; }
      const reps = reportsOf(filings).filter((r) => r.filing.rcept_dt <= VEQ_LIST_TO && toIso(r.filing.rcept_dt) >= `${VEQ_LIST_FROM.slice(0, 4)}-${VEQ_LIST_FROM.slice(4, 6)}-${VEQ_LIST_FROM.slice(6, 8)}`);
      const out: Row[] = [];
      let broke = false;
      for (const rep of reps) {
        const f = await fetchEq(rep);
        if (f.status === "fail") { fetchFail++; if (pool.stopReason) { broke = true; break; } continue; }
        stats[f.status]++; stats.reports++;
        out.push({ corp_code: c.corp, stock_code: c.code, kind: rep.kind, bsns_year: String(rep.y), period_end: rep.end, rcept_no: rep.filing.rcept_no, rcept_dt: toIso(rep.filing.rcept_dt), status: f.status, amended_only: rep.amendedOnly ? "Y" : "N", eq_total: f.eq.total, eq_total_basis: f.eq.totalBasis, eq_parent: f.eq.parent, eq_parent_basis: f.eq.parentBasis });
      }
      if (broke) return;
      rows.push(...out); done.add(c.corp); newDone.push(c.corp); doneNow++; sinceFlush++;
      if (doneNow % 50 === 0) console.log(`진행 ${doneNow}/${todo.length}개사 | DART ${pool.total}건 | 저장 대기 행 ${rows.length}`);
      if (sinceFlush >= VEQ_FLUSH_EVERY_CORPS) { sinceFlush = 0; await flush(); }
    }
  }
  await Promise.all(Array.from({ length: VEQ_CONCURRENCY }, () => worker()));
  if (pool.stopReason) stop = pool.stopReason;
  await flush();
  prog.runs.push({ at: new Date().toISOString(), corps: doneNow, calls: pool.total, stop }); await uploadBuf(VEQ_PROGRESS_FILE, new TextEncoder().encode(JSON.stringify(prog)));
  const usage = await storageUsage();
  const eqRows = rows.filter((r) => r.eq_total !== null);
  console.log(`\n=== 본 수집 종료: ${stop} ===\n이번 실행 ${doneNow}개사 처리 / 남은 ${targets.length - done.size}개사 | DART ${pool.total}건(키별 ${[...pool.used].map(([k, v]) => `${k} ${v}`).join(", ")}, status 020 ${[...pool.got020].reduce((a, [, v]) => a + v, 0)}회) | list 실패 ${listFail}, XBRL 실패 ${fetchFail} | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
  console.log(`이번 실행 보고서 ${stats.reports}건: 자본 파싱 ${stats.ok} · XBRL 없음 ${stats.xbrl_014} · 자본 항목 없음 ${stats.no_equity} | 누적 행 ${rows.length}, 자본 있음 ${eqRows.length} (${pc(eqRows.length, rows.length)})`);
  const byK = new Map<string, { n: number; ok: number }>();
  for (const r of rows) { const k = `${String(r.kind)}`; const x = byK.get(k) ?? { n: 0, ok: 0 }; x.n++; if (r.eq_total !== null) x.ok++; byK.set(k, x); }
  console.log(`보고서 종류별 누적(자본 있음/전체): ${[...byK].map(([k, x]) => `${k} ${x.ok}/${x.n}`).join(" | ")}`);
  console.log(`Storage 총량 ${(usage.total / MiB).toFixed(2)} MiB(가드 800 MiB) | 데이터 파일 한 사본 research/v_equity/ | 연구 DB 쓰기 0 | ${storageLine()}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

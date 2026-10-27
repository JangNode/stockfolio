/**
 * [임시 연구 — 병합 금지] 연구 PEAD 잠정실적(PE7) 대량 수집 + 데이터 품질 점검. 시험이 아니다(가격 성과 계산 없음, 시도 번호 소진 없음).
 * 코스피(corp_cls=Y) 거래소공시(pblntf_ty=I) 중 제목에 '영업(잠정)실적'이 있는 비정정 공시를 2017-01-01~2026-10-26 분기 창으로 목록에서 모으고, 문서(document.xml)를 받아
 * 당기·전년 동기 분기 영업이익을 읽어 원 단위로 통일한 파싱 결과만 Parquet(.research-prelim/)에 저장한다(원문 비저장). DART 연구용 키(DART_API_KEY_2/_3)만 쓴다. Supabase 읽기·쓰기 0, Storage 읽기 0(부분집합 캐시만 읽음).
 * 품질 문턱(변경 금지, lib/peadConfig.ts PEAD_PRELIM_STUDY): 파싱 실패율 ≤ 10%, 같은 기업·분기 정기보고서(fin 부분집합) 당기 영업이익과 1%(또는 표기 단위 1개) 이내 일치율 ≥ 70%.
 * 환경 변수 PCOL_SAMPLE=1이면 목록은 전부 모으되 문서는 연도별 층화 무작위 표본(연 40건)만 받는 파일럿이다(판정 아님).
 */
import AdmZip from "adm-zip";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { decodeTable, encodeTable, type ColDef, type Row } from "@/lib/nBookStore";
import { PEAD_PRELIM_STUDY as S } from "@/lib/peadConfig";
import { selectPrelim, type PrelimRec } from "@/lib/peadPrelimSelect";
import { f2, mulberry32, median } from "./researchHarness";

const T0 = Date.now();
const BASE = "https://opendart.fss.or.kr/api";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const MiB = 1048576;
const sample = process.env.PCOL_SAMPLE === "1";
const scrub = (m: string): string => m.replace(/crtfc_key=[^&\s"]+/g, "crtfc_key=***");

// ---- DART 호출: 키 2개 × 일꾼 2개. 키별 호출 수·한도, 한도 초과(020) 표시 ----
interface Key { name: string; value: string; used: number; off: boolean }
const keys: Key[] = [{ name: "DART_API_KEY_2", value: process.env.DART_API_KEY_2 ?? "", used: 0, off: false }, { name: "DART_API_KEY_3", value: process.env.DART_API_KEY_3 ?? "", used: 0, off: false }];
const net = { calls: 0, listBytes: 0, docBytes: 0 };
function takeKey(preferred: Key): Key | null {
  const ok = (k: Key): boolean => !k.off && !!k.value && k.used < S.dailyCapPerKey;
  if (ok(preferred)) return preferred;
  return keys.find(ok) ?? null;
}
class Exhausted extends Error {}

async function dartGet(pref: Key, path_: string, params: Record<string, string | number>): Promise<{ res: Response; k: Key }> {
  for (;;) {
    const k = takeKey(pref);
    if (!k) throw new Exhausted("사용 가능한 연구용 DART 키가 없음(일 한도 또는 한도 초과)");
    k.used++; net.calls++;
    await sleep(S.gapMs);
    const qs = new URLSearchParams({ crtfc_key: k.value, ...Object.fromEntries(Object.entries(params).map(([a, b]) => [a, String(b)])) });
    const res = await fetch(`${BASE}/${path_}?${qs}`);
    return { res, k };
  }
}

interface ListRow { corp_code: string; corp_name: string; stock_code: string; corp_cls: string; report_nm: string; rcept_no: string; rcept_dt: string }
interface ListRes { status: string; message: string; total_count?: number; total_page?: number; list?: ListRow[] }

async function listPage(pref: Key, from: string, to: string, page: number): Promise<ListRes> {
  let lastErr = "";
  for (let attempt = 0; attempt <= S.retries; attempt++) {
    try {
      const { res, k } = await dartGet(pref, "list.json", { bgn_de: from.replace(/-/g, ""), end_de: to.replace(/-/g, ""), corp_cls: "Y", pblntf_ty: "I", page_count: S.listPageCount, page_no: page, sort: "date", sort_mth: "asc" });
      const txt = await res.text();
      net.listBytes += txt.length;
      const j = JSON.parse(txt) as ListRes;
      if (j.status === "020") { k.off = true; attempt--; continue; }
      if (j.status !== "000" && j.status !== "013") throw new Error(`status ${j.status} ${j.message}`);
      return j;
    } catch (e) {
      if (e instanceof Exhausted) throw e;
      lastErr = scrub(e instanceof Error ? e.message : String(e));
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(`list.json ${from}~${to} p${page} 실패: ${lastErr}`);
}

// ---- 문서 파서 ----
const numOf = (s: string): number | null => {
  const t = s.replace(/[\s,+%]/g, "");
  const m = /^([(△▲\-－]?)(\d+(?:\.\d+)?)\)?$/.exec(t);
  return m ? (m[1] ? -Number(m[2]) : Number(m[2])) : null;
};
const CELL_TEXT = /^(?:-|－|—|N\/A|해당\s*없음|(?:흑자|적자)\s*(?:전환|지속)|흑자|적자)$/;
const isCell = (x: string): boolean => numOf(x) !== null || CELL_TEXT.test(x.replace(/\s+/g, ""));
const UNITS: Record<string, number> = { 억원: 1e8, 백만원: 1e6, 만원: 1e4, 천원: 1e3, 원: 1 };
const RC_OF_Q: Record<number, string> = { 1: "11013", 2: "11012", 3: "11014", 4: "11011" };

interface Parsed { ok: boolean; fail: string; unit: string; scale: number; cur: number | null; prevY: number | null; year: number | null; q: number | null; periodSrc: string }
/** 영업(잠정)실적 공정공시 표 파서(셀이 한 줄씩 나열된 구조): 헤더 역할로 열을 정하고, 안 맞으면 값 칸 수(5: 흑자적자전환 열 없음 / 7: 있음)로 정한다. */
function parseDoc(text: string, rceptDt: string): Parsed {
  const tk = text.split(/[\n|]/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
  const um = /단위\s*[:：]?\s*(억원|백만원|만원|천원|원)/.exec(text);
  const unit = um?.[1] ?? "", scale = unit ? UNITS[unit] : NaN;
  const base: Parsed = { ok: false, fail: "", unit, scale: Number.isFinite(scale) ? scale : NaN, cur: null, prevY: null, year: null, q: null, periodSrc: "" };
  // 기간: 헤더(구분 ~ 매출액) 사이 토큰의 첫 분기 표기 = 당기
  const i0 = Math.max(tk.findIndex((x) => x.startsWith("구분")), 0);
  const iRev = tk.findIndex((x, i) => i > i0 && /^매출액|^영업수익|^수익\(매출액\)/.test(x));
  const hdr = iRev > i0 ? tk.slice(i0 + 1, iRev) : [];
  for (const h of hdr) {
    const m1 = /(\d{4}|\d{2})\s*(?:년|\.|-|\/)?\s*([1-4])\s*(?:분기|Q|q)/.exec(h.replace(/['’`]/g, "")) , m2 = /([1-4])\s*[Qq]\s*(\d{4}|\d{2})/.exec(h.replace(/['’`]/g, ""));
    const m = m1 ? { y: m1[1], q: m1[2] } : m2 ? { y: m2[2], q: m2[1] } : null;
    if (m) { base.year = m.y.length === 2 ? 2000 + Number(m.y) : Number(m.y); base.q = Number(m.q); base.periodSrc = "label"; break; }
  }
  if (base.year === null) {
    const y = Number(rceptDt.slice(0, 4)), mo = Number(rceptDt.slice(5, 7));
    base.year = mo <= 3 ? y - 1 : y; base.q = mo <= 3 ? 4 : mo <= 6 ? 1 : mo <= 9 ? 2 : 3; base.periodSrc = "inferred";
  }
  if (!unit) { base.fail = "단위 불명"; return base; }
  const ii = tk.findIndex((x) => /^영업\s*(이익|손익)(\s*\(.*\))?$/.test(x));
  if (ii < 0) { base.fail = "영업이익 행 없음"; return base; }
  let j = ii + 1;
  if (tk[j] === "당해실적" || tk[j] === "당해") j++;
  const cells: string[] = [];
  for (; j < tk.length && isCell(tk[j]) && cells.length < 12; j++) cells.push(tk[j]);
  // 열 배치는 표준 양식의 값 칸 수로 정한다(머리글이 줄바꿈으로 쪼개져 역할 판독이 불안정): 5칸 = [당기, 전기, 전기대비, 전년동기, 전년동기대비], 7칸 = 전기대비·전년동기대비 뒤에 흑자적자전환여부 칸이 하나씩 더.
  // 7칸이면 흑자적자전환 칸(3번째·6번째 인덱스)이 숫자가 아니어야 한다(숫자면 배치를 잘못 읽은 것이므로 값을 쓰지 않고 실패로 처리한다).
  let ci = -1, pi = -1;
  if (cells.length === 5) { ci = 0; pi = 3; }
  else if (cells.length === 7 && numOf(cells[3]) === null && numOf(cells[6]) === null) { ci = 0; pi = 4; }
  else { base.fail = `열 판별 실패(값 칸 ${cells.length})`; return base; }
  const cur = numOf(cells[ci]), prevY = numOf(cells[pi]);
  if (cur === null || prevY === null) { base.fail = `값 누락(당기 "${cells[ci]}", 전년동기 "${cells[pi]}")`; return base; }
  base.cur = cur * base.scale; base.prevY = prevY * base.scale; base.ok = true;
  return base;
}

async function fetchDoc(pref: Key, rcept: string): Promise<{ text: string; bytes: number }> {
  let lastErr = "";
  for (let attempt = 0; attempt <= S.retries; attempt++) {
    try {
      const { res, k } = await dartGet(pref, "document.xml", { rcept_no: rcept });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
        const head = buf.toString("utf8").slice(0, 400);
        if (/<status>020<\/status>/.test(head)) { k.off = true; attempt--; continue; }
        throw new Error(`zip 아님: ${head.replace(/\s+/g, " ").slice(0, 120)}`);
      }
      net.docBytes += buf.byteLength;
      const ent = new AdmZip(buf).getEntries().filter((e) => !e.isDirectory)[0]?.getData();
      if (!ent) throw new Error("zip 안에 파일 없음");
      const u = ent.toString("utf8");
      const raw = (u.match(/�/g) ?? []).length < 5 ? u : new TextDecoder("euc-kr").decode(ent);
      const text = raw.replace(/<\/(TD|TH|TE|TU)\s*>/gi, " | ").replace(/<\/(TR|P|BR|TITLE|SECTION-\d|TABLE|LIBRARY)\s*>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[ \t ]+/g, " ");
      return { text, bytes: buf.byteLength };
    } catch (e) {
      if (e instanceof Exhausted) throw e;
      lastErr = scrub(e instanceof Error ? e.message : String(e));
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(lastErr);
}

/** 일꾼 풀: 키마다 일꾼 2개. 작업 큐에서 하나씩 꺼내 처리한다. 키가 모두 소진되면 처리하지 못한 작업(실행 중이던 것 + 아직 꺼내지 않은 것)을 left로 반환한다. */
async function pool<T>(items: T[], fn: (item: T, pref: Key) => Promise<void>): Promise<{ done: number; left: T[] }> {
  let next = 0, done = 0, stop = false;
  const left: T[] = [];
  const workers = keys.flatMap((k) => [k, k]).map(async (k) => {
    while (!stop) {
      const i = next++;
      if (i >= items.length) return;
      try { await fn(items[i], k); done++; } catch (e) { if (e instanceof Exhausted) { stop = true; left.push(items[i]); return; } throw e; }
    }
  });
  await Promise.all(workers);
  return { done, left: stop ? [...left, ...items.slice(Math.min(next, items.length))] : [] };
}
const ab = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const str = (n: string): ColDef => ({ name: n, type: "STRING" });
const num = (n: string): ColDef => ({ name: n, type: "DOUBLE" });
const PARSED_COLS = [str("corp_code"), str("stock_code"), str("rcept_no"), str("rcept_dt"), str("report_nm"), str("cons"), num("cur_won"), num("prevy_won"), str("unit"), num("period_year"), num("period_q"), str("period_src"), num("ok"), str("fail"), num("zip_bytes")];
type Rec = PrelimRec;
const toRow = (r: Rec): Row => ({ ...r, cons: r.cons ? "Y" : "N", ok: r.ok ? 1 : 0 });

async function main(): Promise<void> {
  console.log(`연구 PEAD 잠정실적 ${sample ? "파일럿(표본)" : "대량"} 수집 + 품질 점검 시작(시험 아님): ${new Date().toISOString()} | 키 ${keys.filter((x) => x.value).length}개 확인(값 비출력)`);
  if (keys.some((k) => !k.value)) throw new Error("DART_API_KEY_2, DART_API_KEY_3가 필요합니다.");
  for (const [f, want] of Object.entries(S.subsetSha256)) {
    const got = sha(await fs.readFile(path.join(S.subsetDir, f)));
    if (got !== want) throw new Error(`부분집합 ${f} SHA-256 불일치(${got.slice(0, 8)}… ≠ ${want.slice(0, 8)}…)`);
  }
  console.log(`부분집합 SHA-256 대조 통과(${Object.keys(S.subsetSha256).join(", ")})`);
  await fs.mkdir(S.parsedDir, { recursive: true });
  const parsedPath = path.join(S.parsedDir, S.parsedFile);
  const prev = new Map<string, Rec>();
  try {
    for (const r of await decodeTable(ab(await fs.readFile(parsedPath)))) prev.set(String(r.rcept_no), { ...(r as unknown as Rec), cons: r.cons === "Y", ok: r.ok === 1 });
    console.log(`이어받기: 기존 파싱 결과 ${prev.size}건(덮어쓰지 않고 없는 접수번호만 받음)`);
  } catch { /* 처음 실행 */ }

  // ---- 진단 모드: PCOL_SAMPLE=debug:<접수번호,...> — 목록 없이 해당 문서만 받아 영업이익 행 주변 토큰을 보여 준다(파서 점검 전용, 저장 없음) ----
  if (process.env.PCOL_SAMPLE?.startsWith("debug:")) {
    for (const no of process.env.PCOL_SAMPLE.slice(6).split(",").filter(Boolean)) {
      const d = await fetchDoc(keys[0], no);
      const tk = d.text.split(/[\n|]/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
      const i = tk.findIndex((x) => /^영업\s*(이익|손익)(\s*\(.*\))?$/.test(x));
      const g = tk.findIndex((x) => x.startsWith("구분")), m = tk.findIndex((x, ix) => ix > g && /^매출액|^영업수익|^수익\(매출액\)/.test(x));
      console.log(`[debug ${no}] zip ${d.bytes} B, 토큰 ${tk.length}개, 구분 위치 ${g}, 첫 영업이익 행 위치 ${i} | 머리글(구분~매출액): ${g >= 0 && m > g ? tk.slice(g, m + 1).join(" ¦ ") : "-"}\n  영업이익 주변: ${i < 0 ? "-" : tk.slice(Math.max(0, i - 12), i + 26).join(" ¦ ")}\n  파싱: ${JSON.stringify(parseDoc(d.text, "2020-01-01"))}`);
    }
    return;
  }
  // ---- 1. 목록: 분기 창 40개, 모든 페이지 ----
  const windows: { from: string; to: string; total: number; pages: number }[] = [];
  for (let y = Number(S.from.slice(0, 4)); y <= Number(S.to.slice(0, 4)); y++) for (const [a, b] of [["01-01", "03-31"], ["04-01", "06-30"], ["07-01", "09-30"], ["10-01", "12-31"]]) { const from = `${y}-${a}`, to = `${y}-${b}` > S.to ? S.to : `${y}-${b}`; if (from <= S.to) windows.push({ from, to, total: 0, pages: 0 }); }
  const rows: ListRow[] = [];
  const addRows = (l: ListRow[]): void => { for (const x of l) rows.push({ ...x, rcept_dt: /^\d{8}$/.test(x.rcept_dt) ? `${x.rcept_dt.slice(0, 4)}-${x.rcept_dt.slice(4, 6)}-${x.rcept_dt.slice(6, 8)}` : x.rcept_dt }); };
  const first = await pool(windows, async (w, k) => { const r = await listPage(k, w.from, w.to, 1); w.total = r.total_count ?? 0; w.pages = r.total_page ?? 0; addRows(r.list ?? []); });
  if (first.left.length) throw new Error("목록 1페이지 수집 중 키 소진");
  const rest: [number, number][] = [];
  windows.forEach((w, wi) => { for (let p = 2; p <= w.pages; p++) rest.push([wi, p]); });
  const restRes = await pool(rest, async ([wi, p], k) => { const w = windows[wi]; addRows((await listPage(k, w.from, w.to, p)).list ?? []); });
  if (restRes.left.length) throw new Error(`목록 수집 중 키 소진(${restRes.left.length}쪽 남음)`);
  const listTotal = windows.reduce((a, w) => a + w.total, 0);
  console.log(`\n=== 1. 목록 (코스피 거래소공시, ${S.from}~${S.to}, 창 ${windows.length}개) ===\n전체 공시 ${listTotal}건 중 받은 행 ${rows.length}건(차이 ${listTotal - rows.length}) | 목록 호출 ${net.calls}건`);
  const seen = new Set<string>();
  const kw = rows.filter((r) => r.report_nm.includes(S.keyword) && !seen.has(r.rcept_no) && seen.add(r.rcept_no));
  const corrected = kw.filter((r) => S.correctionPattern.test(r.report_nm));
  const cand = kw.filter((r) => !S.correctionPattern.test(r.report_nm));
  console.log(`제목에 '${S.keyword}' 포함 ${kw.length}건 | 정정·첨부추가 제외 ${corrected.length}건 | 비정정 후보 ${cand.length}건(연결 ${cand.filter((r) => r.report_nm.includes("연결")).length} / 별도 ${cand.filter((r) => !r.report_nm.includes("연결")).length})`);
  const byYear = new Map<string, ListRow[]>();
  for (const r of cand) { const l = byYear.get(r.rcept_dt.slice(0, 4)) ?? []; l.push(r); byYear.set(r.rcept_dt.slice(0, 4), l); }

  // ---- 2. 문서 수집·파싱 ----
  const fin = new Map<string, Row>();
  let toGet = cand.filter((r) => !prev.has(r.rcept_no));
  if (sample) {
    const rng = mulberry32(20261028);
    toGet = [];
    for (const [, l] of [...byYear].sort()) { const pool_ = [...l]; for (let n = 0; n < 40 && pool_.length; n++) toGet.push(pool_.splice(Math.floor(rng() * pool_.length), 1)[0]); }
    console.log(`파일럿 표본: 연도별 최대 40건 무작위 → ${toGet.length}건`);
  }
  const recs = new Map(prev);
  const failures: { rcept_no: string; name: string; reason: string }[] = [];
  const callsBefore = net.calls;
  let n = 0;
  const run = await pool(toGet, async (r, k) => {
    let d: { text: string; bytes: number };
    try { d = await fetchDoc(k, r.rcept_no); } catch (e) { if (e instanceof Exhausted) throw e; failures.push({ rcept_no: r.rcept_no, name: `${r.rcept_dt} ${r.corp_name}`, reason: scrub(e instanceof Error ? e.message : String(e)) }); return; }
    const p = parseDoc(d.text, r.rcept_dt);
    recs.set(r.rcept_no, { corp_code: r.corp_code, stock_code: r.stock_code, rcept_no: r.rcept_no, rcept_dt: r.rcept_dt, report_nm: r.report_nm.replace(/\s+/g, " "), cons: r.report_nm.includes("연결"), cur_won: p.cur, prevy_won: p.prevY, unit: p.unit, period_year: p.year ?? 0, period_q: p.q ?? 0, period_src: p.periodSrc, ok: p.ok, fail: p.fail, zip_bytes: d.bytes });
    if (++n % 2000 === 0) console.log(`  문서 ${n}/${toGet.length}건 처리 (${((Date.now() - T0) / 60000).toFixed(1)}분)`);
  });
  const unfetched = run.left;
  console.log(`\n=== 2. 문서 수집 ===\n대상 ${toGet.length}건 | 처리 ${run.done}건 | 수집 실패 ${failures.length}건(문서별 최대 ${S.retries}회 재시도 후) | 키 한도로 못 받은 ${unfetched.length}건 | 문서 호출 ${net.calls - callsBefore}건(재시도 포함)`);
  if (failures.length) { console.log(`수집 실패 목록(최대 40건): ${failures.slice(0, 40).map((f) => `${f.rcept_no} ${f.name} [${f.reason.slice(0, 80)}]`).join(" | ")}`); }
  const all = [...recs.values()];
  const body = new Uint8Array(encodeTable(PARSED_COLS, all.map(toRow)));
  await fs.writeFile(parsedPath, body);
  await fs.writeFile(path.join(S.parsedDir, S.failFile), JSON.stringify({ failures, unfetched: unfetched.map((r) => r.rcept_no) }, null, 1));
  console.log(`파싱 결과 저장: ${parsedPath} ${all.length}건 ${body.byteLength} B (${(body.byteLength / MiB).toFixed(2)} MiB) SHA-256 ${sha(body)}`);

  // ---- 3. 파싱 실패율 ----
  const bad = all.filter((r) => !r.ok), ratio = all.length ? bad.length / all.length : NaN;
  const reasons = new Map<string, number>();
  for (const r of bad) { const k = r.fail.replace(/\d+/g, "#").replace(/"[^"]*"/g, '"…"'); reasons.set(k, (reasons.get(k) ?? 0) + 1); }
  console.log(`\n=== 3. 파싱 실패율 (열 판별 실패·값 누락·단위 불명·행 없음 문서 / 받은 문서 전체) ===\n실패 ${bad.length}건 / ${all.length}건 = ${f2(ratio * 100)}% (문턱 ${S.parseFailMax * 100}% 이하)\n사유: ${[...reasons].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}건`).join(" | ") || "없음"}`);
  const badEx = bad.filter((_, i) => i % Math.max(Math.floor(bad.length / 6), 1) === 0).slice(0, 6);
  console.log(`실패 예(${badEx.length}건): ${badEx.map((r) => `${r.rcept_dt} ${r.report_nm.slice(0, 30)} ${r.rcept_no} [${r.fail}]`).join(" | ") || "-"}`);
  const unitDist = new Map<string, number>();
  for (const r of all) unitDist.set(r.unit || "불명", (unitDist.get(r.unit || "불명") ?? 0) + 1);
  console.log(`단위 분포: ${[...unitDist].map(([k, v]) => `${k} ${v}`).join(" / ")} | 기간 표기 출처: ${["label", "inferred"].map((s) => `${s} ${all.filter((r) => r.period_src === s).length}`).join(" / ")}`);

  // ---- 4. 정기보고서 값과 전수 대조 ----
  const fr = (await decodeTable(ab(await fs.readFile(path.join(S.subsetDir, "fin_sub.parquet")))));
  for (const r of fr) fin.set(`${r.corp_code}|${r.bsns_year}|${r.reprt_code}|${r.fs_div}`, r);
  const nz = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const regOf = (corp: string, y: number, q: number, fsd: string): { cur: number; prev: number | null; cum: number | null; dt: string } | null => {
    if (q < 4) { const r = fin.get(`${corp}|${y}|${RC_OF_Q[q]}|${fsd}`); const c = r ? nz(r.oi_c) : null; return r && c !== null ? { cur: c, prev: nz(r.oi_p), cum: nz(r.oi_a), dt: String(r.rcept_dt) } : null; }
    const f = fin.get(`${corp}|${y}|11011|${fsd}`), q3 = fin.get(`${corp}|${y}|11014|${fsd}`);
    const fc = f ? nz(f.oi_c) : null, qa = q3 ? nz(q3.oi_a) : null;
    if (!f || fc === null || qa === null) return null;
    const fp = nz(f.oi_p), qpa = q3 ? nz(q3.oi_pa) : null;
    return { cur: fc - qa, prev: fp !== null && qpa !== null ? fp - qpa : null, cum: fc, dt: String(f.rcept_dt) };
  };
  const sel = selectPrelim(all);
  const selOk = [...sel.values()].filter((r) => r.ok);
  let cmp = 0, hit = 0, noReg = 0, hitPrev = 0, cmpPrev = 0;
  const miss: { r: Rec; reg: { cur: number; prev: number | null; cum: number | null }; cls: string }[] = [];
  for (const r of selOk) {
    const reg = regOf(r.corp_code, r.period_year, r.period_q, r.cons ? "CFS" : "OFS");
    if (!reg) { noReg++; continue; }
    cmp++;
    const sc = UNITS[r.unit], tol = Math.max(S.matchRelTol * Math.abs(reg.cur), sc);
    if (Math.abs((r.cur_won as number) - reg.cur) <= tol) hit++;
    else {
      const x = r.cur_won as number, rg = reg.cur, ratio_ = rg === 0 ? NaN : x / rg;
      const near = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(S.matchRelTol * Math.abs(b), sc);
      const pow10 = Number.isFinite(ratio_) && ratio_ !== 0 && [1, 2, 3, 4, 5, 6].some((k) => [Math.pow(10, k), Math.pow(10, -k)].some((p) => Math.abs(Math.abs(ratio_) / p - 1) < 0.02));
      const cls = (Number.isFinite(ratio_) && Math.abs(ratio_ + 1) < 0.02) || pow10 || (reg.cum !== null && near(x, reg.cum)) || (reg.prev !== null && near(x, reg.prev)) ? "파싱 오류 의심(부호 반전·자릿수 차이·누계/전년 값과 일치)" : Number.isFinite(ratio_) && Math.abs(ratio_ - 1) <= 0.3 ? "잠정·확정 차이 의심(차이 30% 이내)" : "기타(차이 30% 초과)";
      miss.push({ r, reg, cls });
    }
    const rp = reg.prev;
    if (rp !== null) { cmpPrev++; if (Math.abs((r.prevy_won as number) - rp) <= Math.max(S.matchRelTol * Math.abs(rp), sc)) hitPrev++; }
  }
  const rate = cmp ? hit / cmp : NaN;
  console.log(`\n=== 4. 정기보고서(fin 부분집합) 값과 전수 대조 — 기업·분기당 선택 문서(연결 우선) 중 파싱 성공 ${selOk.length}건 ===\n비교 가능 ${cmp}건(정기보고서 값 없음·기간 불일치로 비교 불가 ${noReg}건) 중 당기 영업이익 일치(1% 또는 표기 단위 1개 이내) ${hit}건 = ${f2(rate * 100)}% (문턱 ${S.matchMin * 100}% 이상) | 참고: 전년 동기 값 일치 ${hitPrev}/${cmpPrev} = ${f2((hitPrev / Math.max(cmpPrev, 1)) * 100)}%`);
  const clsN = new Map<string, number>();
  for (const m of miss) clsN.set(m.cls, (clsN.get(m.cls) ?? 0) + 1);
  console.log(`불일치 ${miss.length}건 분류(기계적 규칙): ${[...clsN].map(([k, v]) => `${k} ${v}건`).join(" | ") || "없음"}`);
  for (const c of [...clsN.keys()]) {
    const l = miss.filter((m) => m.cls === c), pick = l.length <= 3 ? l : [l[Math.floor(l.length / 6)], l[Math.floor(l.length / 2)], l[Math.floor((l.length * 5) / 6)]];
    console.log(`  대표 예 — ${c}: ${pick.map((m) => `${m.r.rcept_dt} ${m.r.stock_code} ${m.r.cons ? "연결" : "별도"} ${m.r.period_year}Q${m.r.period_q}(${m.r.period_src}) 문서 ${m.r.cur_won}원 vs 정기 ${m.reg.cur}원 (${m.r.rcept_no})`).join(" | ")}`);
  }

  // ---- 5. 연도별 이벤트 수 ----
  console.log(`\n=== 5. 연도별 문서·이벤트 수 (접수 연도 기준) ===\n| 연도 | 비정정 후보 | 받은 문서 | 파싱 성공 | 선택 문서(연결 우선) | 선택·성공 | 당기·전년 동기 > 0 | 증가율 ≥ 30% | 정기보고서보다 먼저(비교 가능 중) |\n|---|---|---|---|---|---|---|---|---|`);
  for (const y of [...byYear.keys()].sort()) {
    const ys = all.filter((r) => r.rcept_dt.startsWith(y)), so = selOk.filter((r) => r.rcept_dt.startsWith(y)), selAll = [...sel.values()].filter((r) => r.rcept_dt.startsWith(y));
    const pos = so.filter((r) => (r.cur_won as number) > 0 && (r.prevy_won as number) > 0), g30 = pos.filter((r) => (r.cur_won as number) / (r.prevy_won as number) - 1 >= 0.3);
    let earlier = 0, comp = 0;
    for (const r of so) { const reg = regOf(r.corp_code, r.period_year, r.period_q, r.cons ? "CFS" : "OFS"); if (reg) { comp++; if (r.rcept_dt < reg.dt) earlier++; } }
    console.log(`| ${y} | ${byYear.get(y)!.length} | ${ys.length} | ${ys.filter((r) => r.ok).length} | ${selAll.length} | ${so.length} | ${pos.length} | ${g30.length} | ${earlier}/${comp} |`);
  }
  const leads = selOk.map((r) => { const reg = regOf(r.corp_code, r.period_year, r.period_q, r.cons ? "CFS" : "OFS"); return reg ? (Date.parse(reg.dt) - Date.parse(r.rcept_dt)) / 86_400_000 : null; }).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const q = (p: number): string => (leads.length ? String(leads[Math.min(Math.floor(leads.length * p), leads.length - 1)]) : "-");
  console.log(`잠정실적 → 같은 분기 정기보고서 접수까지 달력일(선택·성공·비교 가능 ${leads.length}건): 최소 ${q(0)} / 10분위 ${q(0.1)} / 중앙값 ${q(0.5)} / 90분위 ${q(0.9)} / 최대 ${leads.length ? leads[leads.length - 1] : "-"} | 음수(정기보고서가 먼저) ${leads.filter((x) => x < 0).length}건, 0일 ${leads.filter((x) => x === 0).length}건 | 중앙값 ${median(leads)}`);

  // ---- 판정 ----
  const pf = ratio <= S.parseFailMax, mt = rate >= S.matchMin;
  const calls = net.calls, perKey = keys.map((k) => `${k.name} ${k.used}`).join(", ");
  console.log(`\n=== 6. 판정 ===\n${sample ? "(파일럿 표본 — 판정 아님) " : ""}파싱 실패율 ${f2(ratio * 100)}% ${pf ? "≤" : ">"} ${S.parseFailMax * 100}% → ${pf ? "통과" : "중단"} | 일치율 ${f2(rate * 100)}% ${mt ? "≥" : "<"} ${S.matchMin * 100}% → ${mt ? "통과" : "중단"} | 수집 완료 여부: 키 한도로 못 받은 ${unfetched.length}건(0이어야 함), 수집 실패 ${failures.length}건(목록 보고, 이벤트에서 제외; 이어받기 한 번 더 시도) → 문턱 ${pf && mt && !unfetched.length ? "통과(시험 진행 가능)" : "미통과 또는 미완(시험 금지)"}`);
  console.log(`DART 호출 ${calls}건(키별 ${perKey}) | 내려받기 목록 ${(net.listBytes / MiB).toFixed(2)} MiB + 문서 zip ${(net.docBytes / MiB).toFixed(2)} MiB = ${((net.listBytes + net.docBytes) / MiB).toFixed(2)} MiB | 연구 호출 누적 ${S.rUsed + S.prevPrelimCalls + calls}건 (상한 ${S.totalCap}) | Supabase·Storage 읽기·쓰기 0 | 가격 성과 계산 없음 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시도 번호 소진 없음`);
}

main().catch((e) => { console.error(scrub(e instanceof Error ? e.stack ?? e.message : String(e))); process.exit(1); });

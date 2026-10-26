/**
 * [임시 연구 — 병합 금지] 연구 R 재무 지표 계산(순수 함수, I/O 없음). 정의: docs/research/r-allcap-fundamentals-prereg.md 단계 2의 6항.
 * 입력은 research/r_allcap/fin.parquet 행(상태 orig만 값이 있음)과 filings.parquet 행.
 */

export interface FinRow {
  corp_code: string; stock_code: string; bsns_year: string; reprt_code: string; fs_div: string; rcept_no: string; rcept_dt: string; status: string;
  oi_c: number | null; oi_a: number | null; oi_p: number | null; oi_pa: number | null;
  ni_c: number | null; ni_a: number | null; ni_p: number | null; ni_pa: number | null;
  eq_c: number | null; eq_p: number | null;
}

/** 한 보고서 접수 시점에 알 수 있는 지표 묶음. 계산 불가는 null. */
export interface FinEvent {
  rceptDt: string; rceptNo: string;
  ttmOi: number | null; ttmNi: number | null; eq: number | null; // 수익성 묶음(같은 fs_div, 셋 다 있어야 값이 있음)
  eqPbr: number | null; // PBR용 자본 = 수익성 묶음이 완비되면 그 자본, 아니면 CFS 우선·없으면 OFS의 자본총계
  qOi: number | null; qOiPrev: number | null; // 성장 묶음(같은 fs_div)
  /** 진단용(커버리지 보고): 연결·별도 어느 쪽이든 TTM 영업이익 / TTM 순이익 / 자본총계가 각각 계산 가능한지. 수익성 묶음 규칙과는 무관. */
  hasOi?: boolean; hasNi?: boolean; hasEq?: boolean;
  /** 정정 점 시점 규칙(eventsByCorpPit)의 재계산 이벤트에만 있다: 이 값이 가리키는 보고서의 최초(비정정) 접수일 — 200일 신선도는 정정일이 아니라 이 날짜부터 센다. */
  baseDt?: string;
}

const FS_ORDER = ["CFS", "OFS"] as const;

/** (corp, 사업연도, 보고서, fs_div) → 행. 상태 orig 행만 값이 있다. */
type Index = Map<string, FinRow>;
const keyOf = (corp: string, y: number | string, rc: string, fs: string): string => `${corp}|${y}|${rc}|${fs}`;

const nn = (x: number | null | undefined): number | null => (x === null || x === undefined || !Number.isFinite(x) ? null : x);

/** YTD(당기 누적)과 YTD_prev(전기 같은 시점 누적). 11013·11011은 thstrm/frmtrm, 11012·11014는 add 계열. */
function ytd(r: FinRow, item: "oi" | "ni"): { cur: number | null; prev: number | null } {
  const add = r.reprt_code === "11012" || r.reprt_code === "11014";
  const c = item === "oi" ? (add ? r.oi_a : r.oi_c) : (add ? r.ni_a : r.ni_c);
  const p = item === "oi" ? (add ? r.oi_pa : r.oi_p) : (add ? r.ni_pa : r.ni_p);
  return { cur: nn(c), prev: nn(p) };
}

/** asOf가 있으면(정정 점 시점 규칙) 상태 orig·corr 행 모두, 접수일이 asOf 이하인 것만 쓴다. 없으면 기존 규칙(orig만, 직전 사업보고서는 이 보고서보다 먼저 접수). */
const usableAt = (r: FinRow | undefined, asOf: string | undefined): r is FinRow => !!r && (asOf === undefined ? r.status === "orig" : (r.status === "orig" || r.status === "corr") && r.rcept_dt <= asOf);

function ttm(idx: Index, r: FinRow, item: "oi" | "ni", fs: string, asOf?: string): number | null {
  const y = ytd(r, item);
  if (y.cur === null) return null;
  if (r.reprt_code === "11011") return y.cur;
  if (y.prev === null) return null;
  const fy = idx.get(keyOf(r.corp_code, Number(r.bsns_year) - 1, "11011", fs));
  if (!usableAt(fy, asOf) || (asOf === undefined && fy.rcept_dt >= r.rcept_dt)) return null;
  const fyv = nn(item === "oi" ? fy.oi_c : fy.ni_c);
  return fyv === null ? null : fyv + y.cur - y.prev;
}

/** 분기 영업이익(당분기, 전년 동기). 사업보고서는 연간 − 3분기 누적. */
function quarterOi(idx: Index, r: FinRow, fs: string, asOf?: string): { q: number | null; prev: number | null } {
  if (r.reprt_code !== "11011") return { q: nn(r.oi_c), prev: nn(r.oi_p) };
  const q3 = idx.get(keyOf(r.corp_code, r.bsns_year, "11014", fs));
  if (!usableAt(q3, asOf) || (asOf === undefined && q3.rcept_dt >= r.rcept_dt)) return { q: null, prev: null };
  const fy = nn(r.oi_c), fyPrev = nn(r.oi_p), c = nn(q3.oi_a), p = nn(q3.oi_pa);
  return { q: fy !== null && c !== null ? fy - c : null, prev: fyPrev !== null && p !== null ? fyPrev - p : null };
}

/**
 * 보고서 하나(연결/별도 구분 없이 같은 (corp, y, reprt))를 FinEvent로 바꾼다.
 * 지표 묶음마다 CFS가 완비되면 CFS, 아니면 OFS가 완비될 때 OFS, 둘 다 아니면 null — 연결·별도를 섞지 않는다.
 */
export function eventOf(idx: Index, corp: string, y: string, rc: string, asOf?: string): FinEvent | null {
  let base: FinRow | undefined;
  for (const fs of FS_ORDER) { const r = idx.get(keyOf(corp, y, rc, fs)); if (usableAt(r, asOf)) { base = r; break; } }
  if (!base) return null;
  const ev: FinEvent = { rceptDt: base.rcept_dt, rceptNo: base.rcept_no, ttmOi: null, ttmNi: null, eq: null, eqPbr: null, qOi: null, qOiPrev: null };
  for (const fs of FS_ORDER) {
    const r = idx.get(keyOf(corp, y, rc, fs));
    if (!usableAt(r, asOf)) continue;
    const o = ttm(idx, r, "oi", fs, asOf), n = ttm(idx, r, "ni", fs, asOf), e = nn(r.eq_c);
    if (o !== null && n !== null && e !== null) { ev.ttmOi = o; ev.ttmNi = n; ev.eq = e; break; }
  }
  ev.hasOi = false; ev.hasNi = false; ev.hasEq = false;
  for (const fs of FS_ORDER) {
    const r = idx.get(keyOf(corp, y, rc, fs));
    if (!usableAt(r, asOf)) continue;
    if (ttm(idx, r, "oi", fs, asOf) !== null) ev.hasOi = true;
    if (ttm(idx, r, "ni", fs, asOf) !== null) ev.hasNi = true;
    if (nn(r.eq_c) !== null) ev.hasEq = true;
  }
  ev.eqPbr = ev.eq;
  if (ev.eqPbr === null) for (const fs of FS_ORDER) { const r = idx.get(keyOf(corp, y, rc, fs)); const e = usableAt(r, asOf) ? nn(r.eq_c) : null; if (e !== null) { ev.eqPbr = e; break; } }
  for (const fs of FS_ORDER) {
    const r = idx.get(keyOf(corp, y, rc, fs));
    if (!usableAt(r, asOf)) continue;
    const q = quarterOi(idx, r, fs, asOf);
    if (q.q !== null && q.prev !== null) { ev.qOi = q.q; ev.qOiPrev = q.prev; break; }
  }
  return ev;
}

export function buildIndex(rows: FinRow[]): Index {
  const idx: Index = new Map();
  for (const r of rows) idx.set(keyOf(r.corp_code, r.bsns_year, r.reprt_code, r.fs_div), r);
  return idx;
}

/** 회사별 이벤트 목록(접수일·접수번호 오름차순). 값이 전부 null인 이벤트도 포함 — 직전 보고서가 "자료 없음"일 수 있다. */
export interface FilingRow { corp_code: string; rcept_no: string; rcept_dt: string; correction: string; report_nm: string }

export function eventsByCorp(rows: FinRow[], filings: FilingRow[]): Map<string, FinEvent[]> {
  const idx = buildIndex(rows);
  const seen = new Set<string>();
  const out = new Map<string, FinEvent[]>();
  for (const r of rows) {
    if (r.status !== "orig") continue;
    const k = `${r.corp_code}|${r.bsns_year}|${r.reprt_code}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const ev = eventOf(idx, r.corp_code, r.bsns_year, r.reprt_code);
    if (!ev) continue;
    const l = out.get(r.corp_code) ?? [];
    l.push(ev);
    out.set(r.corp_code, l);
  }
  // 비정정 정기공시인데 값 행이 없는 접수(정정으로 값이 대체됐거나 API 자료 없음)는 값이 전부 null인 이벤트 — 그 접수일 이후엔 "자료 없음"이지 더 오래된 보고서로 대체하지 않는다.
  const have = new Set([...out.values()].flat().map((e) => e.rceptNo));
  for (const f of filings) {
    if (f.correction !== "N" || have.has(f.rcept_no)) continue;
    const l = out.get(f.corp_code) ?? [];
    l.push({ rceptDt: f.rcept_dt, rceptNo: f.rcept_no, ttmOi: null, ttmNi: null, eq: null, eqPbr: null, qOi: null, qOiPrev: null });
    out.set(f.corp_code, l);
  }
  for (const l of out.values()) l.sort((a, b) => (a.rceptDt < b.rceptDt ? -1 : a.rceptDt > b.rceptDt ? 1 : a.rceptNo < b.rceptNo ? -1 : 1));
  return out;
}

/** 보고서명에서 정정 머리말([기재정정] 등)과 공백을 지워 같은 기간의 원본·정정 접수를 짝짓는 키로 쓴다. */
const periodNameKey = (nm: string): string => nm.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, "");

/**
 * 정정 점 시점 규칙(사용자 승인 2026-10-26, 자료 처리 정의 변경 — 전략 결과와 무관): 정정 접수일부터 정정 후 값을 쓰고 그 전까지는 원본을 쓴다.
 * eventsByCorp의 이벤트(원본 접수일에 알 수 있던 값)는 그대로 두고, 상태 corr 행(정정 후 값)이 있는 정정 접수일 D마다
 * "D 시점의 최신 보고서(접수일 ≤ D인 비정정 접수 중 마지막)"의 이벤트를 접수일 D 기준으로 다시 계산해 덧붙인다(정정이 그 보고서 자신이거나, 그 보고서의 직전 사업보고서처럼 TTM 계산에 쓰이는 보고서일 때 값이 바뀐다).
 * 한계: fin.parquet에는 (회사, 연도, 보고서, 연결/별도)마다 한 줄뿐이라 정정된 보고서의 정정 전 원본 값과 중간 정정본은 보관돼 있지 않다 — 정정 접수일 전까지는 기존처럼 "자료 없음"이다(원본 값을 쓰는 규칙보다 보수적인 하한).
 * 200일 신선도는 최초 접수일(baseDt)부터 센다. 정정 접수가 최신 보고서를 바꾸지는 않는다.
 */
export function eventsByCorpPit(rows: FinRow[], filings: FilingRow[]): { events: Map<string, FinEvent[]>; added: number; corrRows: number } {
  const out = eventsByCorp(rows, filings);
  const idx = buildIndex(rows);
  const filOf = new Map<string, FilingRow>();
  const origs = new Map<string, FilingRow[]>();
  for (const f of filings) {
    filOf.set(f.rcept_no, f);
    if (f.correction === "N") { const l = origs.get(f.corp_code) ?? []; l.push(f); origs.set(f.corp_code, l); }
  }
  for (const l of origs.values()) l.sort((a, b) => (a.rcept_dt < b.rcept_dt ? -1 : a.rcept_dt > b.rcept_dt ? 1 : a.rcept_no < b.rcept_no ? -1 : 1));
  // 회사별 보고서명 키 → 기간(연도, 보고서): 값 행의 접수번호가 가리키는 접수의 보고서명으로 만든다(원본·정정이 같은 키).
  const periodOf = new Map<string, Map<string, { y: string; rc: string }>>();
  for (const r of rows) {
    if (r.status !== "orig" && r.status !== "corr") continue;
    const f = filOf.get(r.rcept_no);
    if (!f) continue;
    const m = periodOf.get(r.corp_code) ?? new Map<string, { y: string; rc: string }>();
    m.set(periodNameKey(f.report_nm ?? ""), { y: r.bsns_year, rc: r.reprt_code });
    periodOf.set(r.corp_code, m);
  }
  let added = 0, corrRows = 0;
  const done = new Set<string>();
  for (const r of rows) {
    if (r.status !== "corr") continue;
    corrRows++;
    const D = r.rcept_dt;
    const os = origs.get(r.corp_code);
    if (!os) continue;
    let cur: FilingRow | undefined;
    for (const o of os) if (o.rcept_dt <= D) cur = o; else break; // D 시점의 최신 비정정 접수
    if (!cur) continue;
    const per = periodOf.get(r.corp_code)?.get(periodNameKey(cur.report_nm ?? ""));
    if (!per) continue; // 최신 보고서의 기간을 알 수 없으면(값 행이 하나도 없음) 계산할 값도 없다
    const key = `${r.corp_code}|${cur.rcept_no}|${D}`;
    if (done.has(key)) continue;
    done.add(key);
    const ev = eventOf(idx, r.corp_code, per.y, per.rc, D);
    if (!ev) continue;
    ev.rceptDt = D; ev.rceptNo = r.rcept_no; ev.baseDt = cur.rcept_dt;
    const l = out.get(r.corp_code) ?? [];
    l.push(ev);
    out.set(r.corp_code, l);
    added++;
  }
  // 같은 접수일이면 원본 이벤트(baseDt 없음)가 먼저, 정정 재계산 이벤트가 나중 — 같은 날 접수된 정정이 그날의 최신 상태가 된다.
  for (const l of out.values()) l.sort((a, b) => (a.rceptDt < b.rceptDt ? -1 : a.rceptDt > b.rceptDt ? 1 : (a.baseDt ? 1 : 0) - (b.baseDt ? 1 : 0) || (a.rceptNo < b.rceptNo ? -1 : 1)));
  return { events: out, added, corrRows };
}

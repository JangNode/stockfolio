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

function ttm(idx: Index, r: FinRow, item: "oi" | "ni", fs: string): number | null {
  const y = ytd(r, item);
  if (y.cur === null) return null;
  if (r.reprt_code === "11011") return y.cur;
  if (y.prev === null) return null;
  const fy = idx.get(keyOf(r.corp_code, Number(r.bsns_year) - 1, "11011", fs));
  if (!fy || fy.status !== "orig" || fy.rcept_dt >= r.rcept_dt) return null;
  const fyv = nn(item === "oi" ? fy.oi_c : fy.ni_c);
  return fyv === null ? null : fyv + y.cur - y.prev;
}

/** 분기 영업이익(당분기, 전년 동기). 사업보고서는 연간 − 3분기 누적. */
function quarterOi(idx: Index, r: FinRow, fs: string): { q: number | null; prev: number | null } {
  if (r.reprt_code !== "11011") return { q: nn(r.oi_c), prev: nn(r.oi_p) };
  const q3 = idx.get(keyOf(r.corp_code, r.bsns_year, "11014", fs));
  if (!q3 || q3.status !== "orig" || q3.rcept_dt >= r.rcept_dt) return { q: null, prev: null };
  const fy = nn(r.oi_c), fyPrev = nn(r.oi_p), c = nn(q3.oi_a), p = nn(q3.oi_pa);
  return { q: fy !== null && c !== null ? fy - c : null, prev: fyPrev !== null && p !== null ? fyPrev - p : null };
}

/**
 * 보고서 하나(연결/별도 구분 없이 같은 (corp, y, reprt))를 FinEvent로 바꾼다.
 * 지표 묶음마다 CFS가 완비되면 CFS, 아니면 OFS가 완비될 때 OFS, 둘 다 아니면 null — 연결·별도를 섞지 않는다.
 */
export function eventOf(idx: Index, corp: string, y: string, rc: string): FinEvent | null {
  let base: FinRow | undefined;
  for (const fs of FS_ORDER) { const r = idx.get(keyOf(corp, y, rc, fs)); if (r && r.status === "orig") { base = r; break; } }
  if (!base) return null;
  const ev: FinEvent = { rceptDt: base.rcept_dt, rceptNo: base.rcept_no, ttmOi: null, ttmNi: null, eq: null, eqPbr: null, qOi: null, qOiPrev: null };
  for (const fs of FS_ORDER) {
    const r = idx.get(keyOf(corp, y, rc, fs));
    if (!r || r.status !== "orig") continue;
    const o = ttm(idx, r, "oi", fs), n = ttm(idx, r, "ni", fs), e = nn(r.eq_c);
    if (o !== null && n !== null && e !== null) { ev.ttmOi = o; ev.ttmNi = n; ev.eq = e; break; }
  }
  ev.eqPbr = ev.eq;
  if (ev.eqPbr === null) for (const fs of FS_ORDER) { const r = idx.get(keyOf(corp, y, rc, fs)); const e = r && r.status === "orig" ? nn(r.eq_c) : null; if (e !== null) { ev.eqPbr = e; break; } }
  for (const fs of FS_ORDER) {
    const r = idx.get(keyOf(corp, y, rc, fs));
    if (!r || r.status !== "orig") continue;
    const q = quarterOi(idx, r, fs);
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

/**
 * [임시 연구 — 병합 금지] 연구 C 재무 지표 계산(순수 함수, I/O 없음). 정의: docs/research/guru-composite-prereg.md 4절(수정 후 사전등록 반영).
 * 입력은 research/r_allcap/fin.parquet 행(매출액·영업이익·순이익 4열 + 자산·부채·자본)과 filings.parquet 행. 정정 점 시점 규칙은 lib/rFinMetrics.ts의 eventsByCorpPit와 같다
 * (정정 접수일부터 정정 후 값, 신선도는 최초 접수일부터). 어떤 계산도 이벤트 기준일(원본: 그 보고서 접수일, 정정 재계산: 정정 접수일) 이후에 접수된 보고서를 쓰지 않는다.
 * 이벤트 흐름이 둘이다: (1) 분기·반기·사업보고서마다의 이벤트(V·Q용, 신선도 200일), (2) 사업보고서만의 이벤트(Gr용, 신선도 400일).
 */
import type { FilingRow } from "@/lib/rFinMetrics";
import { G_QUARTERS } from "@/lib/guruCompositeConfig";

export interface GuruFinRow {
  corp_code: string; stock_code: string; bsns_year: string; reprt_code: string; fs_div: string; rcept_no: string; rcept_dt: string; status: string;
  rev_c: number | null; rev_a: number | null; rev_p: number | null; rev_pa: number | null;
  oi_c: number | null; oi_a: number | null; oi_p: number | null; oi_pa: number | null;
  ni_c: number | null; ni_a: number | null; ni_p: number | null; ni_pa: number | null;
  liab_c: number | null; eq_c: number | null; eq_p: number | null;
}
type Item = "rev" | "oi" | "ni";
type Idx = Map<string, GuruFinRow>;
const key = (corp: string, y: number | string, rc: string, fs: string): string => `${corp}|${y}|${rc}|${fs}`;
const nn = (x: number | null | undefined): number | null => (x === null || x === undefined || !Number.isFinite(x) ? null : x);
const FS = ["CFS", "OFS"] as const;
const RC_OF_Q = ["11013", "11012", "11014", "11011"] as const; // 분기 1~4가 만들어지는 보고서
export const buildGuruIndex = (rows: GuruFinRow[]): Idx => { const m: Idx = new Map(); for (const r of rows) m.set(key(r.corp_code, r.bsns_year, r.reprt_code, r.fs_div), r); return m; };

const val = (r: GuruFinRow, item: Item, k: "c" | "a" | "p" | "pa"): number | null => nn(r[`${item}_${k}` as const]);
/** 기준일 lim 이하에 접수된 행만 쓴다. pit면 원본·정정 행 모두, 아니면 원본 행만. */
const usable = (r: GuruFinRow | undefined, lim: string, pit: boolean): r is GuruFinRow => !!r && r.rcept_dt <= lim && (r.status === "orig" || (pit && r.status === "corr"));
/** YTD(당기 누적)과 직전 연도 같은 시점 누적. 11013·11011은 thstrm/frmtrm, 11012·11014는 add 계열(수집기 규약). */
function ytd(r: GuruFinRow, item: Item): { cur: number | null; prev: number | null } {
  const add = r.reprt_code === "11012" || r.reprt_code === "11014";
  return { cur: val(r, item, add ? "a" : "c"), prev: val(r, item, add ? "pa" : "p") };
}

/** TTM(직전 4분기 합). 사업보고서는 연간 값. 나머지는 직전 사업연도 + 올해 누적 − 전년 같은 시점 누적. */
function ttm(idx: Idx, r: GuruFinRow, item: Item, fs: string, lim: string, pit: boolean): number | null {
  const yt = ytd(r, item);
  if (r.reprt_code === "11011") return yt.cur;
  const fy = idx.get(key(r.corp_code, Number(r.bsns_year) - 1, "11011", fs));
  const fyv = usable(fy, lim, pit) ? val(fy, item, "c") : null;
  return yt.cur !== null && yt.prev !== null && fyv !== null ? fyv + yt.cur - yt.prev : null;
}

/** 분기 순이익(연도 Y의 분기 k = 1..4). 자기 보고서의 당분기 값, 없으면 다음 해 같은 보고서의 전년 값. 4분기 = 연간 − 3분기 누적. */
function quarterNi(idx: Idx, corp: string, Y: number, k: number, fs: string, lim: string, pit: boolean): number | null {
  const own = idx.get(key(corp, Y, RC_OF_Q[k - 1], fs));
  if (usable(own, lim, pit)) {
    if (k < 4) { const v = val(own, "ni", "c"); if (v !== null) return v; }
    else { const q3 = idx.get(key(corp, Y, "11014", fs)); if (usable(q3, lim, pit)) { const fy = val(own, "ni", "c"), c9 = val(q3, "ni", "a"); if (fy !== null && c9 !== null) return fy - c9; } }
  }
  const nx = idx.get(key(corp, Y + 1, RC_OF_Q[k - 1], fs));
  if (usable(nx, lim, pit)) {
    if (k < 4) { const v = val(nx, "ni", "p"); if (v !== null) return v; }
    else { const q3 = idx.get(key(corp, Y + 1, "11014", fs)); if (usable(q3, lim, pit)) { const fy = val(nx, "ni", "p"), c9 = val(q3, "ni", "pa"); if (fy !== null && c9 !== null) return fy - c9; } }
  }
  return null;
}

/** 보고서(Y, rc)가 가리키는 분기부터 거꾸로 n개 분기의 순이익. 하나라도 계산 불가면 null. */
function lastQuarters(idx: Idx, corp: string, Y: number, rc: string, n: number, fs: string, lim: string, pit: boolean): number[] | null {
  let k = RC_OF_Q.indexOf(rc as (typeof RC_OF_Q)[number]) + 1, yy = Y;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = quarterNi(idx, corp, yy, k, fs, lim, pit);
    if (v === null) return null;
    out.push(v);
    if (--k === 0) { k = 4; yy--; }
  }
  return out;
}

/** 분기·반기·사업보고서 하나를 기준일까지 알 수 있는 값으로 만든 이벤트(V·Q용). 계산 불가는 null. */
export interface GuruEvent {
  rceptDt: string; rceptNo: string; baseDt?: string;
  /** 점수 묶음별 원자료. 같은 묶음 안에서는 연결/별도를 섞지 않는다(CFS가 완비되면 CFS, 아니면 OFS). */
  v: { ni: number; eq: number } | null;
  q: { ni: number; oi: number; rev: number; eq: number; eqPrev: number; liab: number; posQ: number } | null;
  /** Q'(흑자 분기 수 제외): q와 같되 최근 4분기 순이익이 없어도 값이 있다. */
  qp: { ni: number; oi: number; rev: number; eq: number; eqPrev: number; liab: number } | null;
  /** 진단용 계정별 계산 가능 여부(연결·별도 어느 쪽이든). */
  has: { rev: boolean; oi: boolean; ni: boolean; ni4: boolean; eq: boolean; eqAvg: boolean; liab: boolean };
}
export const GURU_ACCOUNT_LABELS: [keyof GuruEvent["has"], string][] = [
  ["rev", "매출액 TTM"], ["oi", "영업이익 TTM"], ["ni", "당기순이익 TTM"], ["ni4", "당기순이익 최근 4분기"], ["eq", "자본총계"], ["eqAvg", "자본총계(보고 시점·직전 연말)"], ["liab", "부채총계"],
];
const noHas = (): GuruEvent["has"] => ({ rev: false, oi: false, ni: false, ni4: false, eq: false, eqAvg: false, liab: false });

/** 보고서(Y, rc)를 기준일 lim까지 알 수 있는 값으로 GuruEvent로 만든다. base 보고서가 lim까지 사용 가능하지 않으면 null. */
export function guruEventOf(idx: Idx, corp: string, y: string, rc: string, lim: string, pit: boolean): GuruEvent | null {
  let base: GuruFinRow | undefined;
  for (const fs of FS) { const r = idx.get(key(corp, y, rc, fs)); if (usable(r, lim, pit)) { base = r; break; } }
  if (!base) return null;
  const ev: GuruEvent = { rceptDt: base.rcept_dt, rceptNo: base.rcept_no, v: null, q: null, qp: null, has: noHas() };
  for (const fs of FS) {
    const r = idx.get(key(corp, y, rc, fs));
    if (!usable(r, lim, pit)) continue;
    const rev = ttm(idx, r, "rev", fs, lim, pit), oi = ttm(idx, r, "oi", fs, lim, pit), ni = ttm(idx, r, "ni", fs, lim, pit);
    const eq = nn(r.eq_c), eqP = nn(r.eq_p), liab = nn(r.liab_c);
    const q4 = lastQuarters(idx, corp, Number(y), rc, G_QUARTERS, fs, lim, pit);
    const h = ev.has;
    h.rev ||= rev !== null; h.oi ||= oi !== null; h.ni ||= ni !== null; h.ni4 ||= q4 !== null;
    h.eq ||= eq !== null; h.eqAvg ||= eq !== null && eqP !== null; h.liab ||= liab !== null;
    if (!ev.v && ni !== null && eq !== null) ev.v = { ni, eq };
    if (!ev.qp && ni !== null && oi !== null && rev !== null && eq !== null && eqP !== null && liab !== null) ev.qp = { ni, oi, rev, eq, eqPrev: eqP, liab };
    if (!ev.q && ni !== null && oi !== null && rev !== null && eq !== null && eqP !== null && liab !== null && q4 !== null) ev.q = { ni, oi, rev, eq, eqPrev: eqP, liab, posQ: q4.filter((x) => x > 0).length };
  }
  return ev;
}

/** 사업보고서만의 이벤트(Gr용): 사업연도 y 사업보고서의 당기·전기 연간 값(= 직전 사업연도, 전전 사업연도). */
export interface GuruAnnualEvent {
  rceptDt: string; rceptNo: string; baseDt?: string;
  g: { rev: number; revPrev: number; oi: number; oiPrev: number } | null;
  /** 진단용: 매출액·영업이익 각각 당기·전기 연간 값이 모두 있는지(연결·별도 어느 쪽이든). */
  has: { rev: boolean; oi: boolean };
}

export function annualEventOf(idx: Idx, corp: string, y: string, lim: string, pit: boolean): GuruAnnualEvent | null {
  let base: GuruFinRow | undefined;
  for (const fs of FS) { const r = idx.get(key(corp, y, "11011", fs)); if (usable(r, lim, pit)) { base = r; break; } }
  if (!base) return null;
  const ev: GuruAnnualEvent = { rceptDt: base.rcept_dt, rceptNo: base.rcept_no, g: null, has: { rev: false, oi: false } };
  for (const fs of FS) {
    const r = idx.get(key(corp, y, "11011", fs));
    if (!usable(r, lim, pit)) continue;
    const rev = val(r, "rev", "c"), revP = val(r, "rev", "p"), oi = val(r, "oi", "c"), oiP = val(r, "oi", "p");
    ev.has.rev ||= rev !== null && revP !== null; ev.has.oi ||= oi !== null && oiP !== null;
    if (!ev.g && rev !== null && revP !== null && oi !== null && oiP !== null) ev.g = { rev, revPrev: revP, oi, oiPrev: oiP };
  }
  return ev;
}

const periodNameKey = (nm: string): string => nm.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, "");
const isAnnualFiling = (f: FilingRow): boolean => (f.report_nm ?? "").includes("사업보고서");

/**
 * 회사별 이벤트 목록(접수일·접수번호 오름차순). 원본 이벤트 = 비정정 정기공시 접수일 기준, 정정 재계산 이벤트 = 상태 corr 행이 있는 정정 접수일 D마다
 * "D 시점의 최신 비정정 보고서"를 D 기준으로 다시 계산(baseDt = 그 보고서의 최초 접수일). rFinMetrics.eventsByCorpPit와 같은 규칙.
 * 값 행이 없는 비정정 접수는 값이 전부 null인 이벤트로 넣는다(그 접수일 이후 "자료 없음", 더 오래된 보고서로 대체하지 않음).
 * annual은 사업보고서만의 같은 구조 흐름(정정 재계산은 D 시점의 최신 사업보고서가 그 정정의 보고서일 때만).
 */
export function guruEventsByCorp(rows: GuruFinRow[], filings: FilingRow[]): { events: Map<string, GuruEvent[]>; annual: Map<string, GuruAnnualEvent[]>; added: number; addedAnnual: number } {
  const idx = buildGuruIndex(rows);
  const out = new Map<string, GuruEvent[]>(), ann = new Map<string, GuruAnnualEvent[]>();
  const push = <T,>(m: Map<string, T[]>, corp: string, e: T): void => { const l = m.get(corp) ?? []; l.push(e); m.set(corp, l); };
  const seen = new Set<string>(), seenAnn = new Set<string>();
  for (const r of rows) {
    if (r.status !== "orig") continue;
    const k = `${r.corp_code}|${r.bsns_year}|${r.reprt_code}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const ev = guruEventOf(idx, r.corp_code, r.bsns_year, r.reprt_code, r.rcept_dt, false);
    if (ev) push(out, r.corp_code, ev);
    if (r.reprt_code === "11011") { const a = annualEventOf(idx, r.corp_code, r.bsns_year, r.rcept_dt, false); if (a) { push(ann, r.corp_code, a); seenAnn.add(a.rceptNo); } }
  }
  const have = new Set([...out.values()].flat().map((e) => e.rceptNo));
  const origs = new Map<string, FilingRow[]>(), annOrigs = new Map<string, FilingRow[]>(), filOf = new Map<string, FilingRow>();
  for (const f of filings) {
    filOf.set(f.rcept_no, f);
    if (f.correction !== "N") continue;
    push(origs, f.corp_code, f);
    if (isAnnualFiling(f)) push(annOrigs, f.corp_code, f);
    if (!have.has(f.rcept_no)) push(out, f.corp_code, { rceptDt: f.rcept_dt, rceptNo: f.rcept_no, v: null, q: null, qp: null, has: noHas() });
    if (isAnnualFiling(f) && !seenAnn.has(f.rcept_no)) push(ann, f.corp_code, { rceptDt: f.rcept_dt, rceptNo: f.rcept_no, g: null, has: { rev: false, oi: false } });
  }
  const byDt = (a: FilingRow, b: FilingRow): number => (a.rcept_dt < b.rcept_dt ? -1 : a.rcept_dt > b.rcept_dt ? 1 : a.rcept_no < b.rcept_no ? -1 : 1);
  for (const l of origs.values()) l.sort(byDt);
  for (const l of annOrigs.values()) l.sort(byDt);
  const periodOf = new Map<string, Map<string, { y: string; rc: string }>>();
  for (const r of rows) {
    if (r.status !== "orig" && r.status !== "corr") continue;
    const f = filOf.get(r.rcept_no);
    if (!f) continue;
    const m = periodOf.get(r.corp_code) ?? new Map<string, { y: string; rc: string }>();
    m.set(periodNameKey(f.report_nm ?? ""), { y: r.bsns_year, rc: r.reprt_code });
    periodOf.set(r.corp_code, m);
  }
  const latestAt = (os: FilingRow[] | undefined, D: string): FilingRow | undefined => { let cur: FilingRow | undefined; for (const o of os ?? []) if (o.rcept_dt <= D) cur = o; else break; return cur; };
  let added = 0, addedAnnual = 0;
  const done = new Set<string>(), doneAnn = new Set<string>();
  for (const r of rows) {
    if (r.status !== "corr") continue;
    const D = r.rcept_dt;
    const cur = latestAt(origs.get(r.corp_code), D);
    if (cur) {
      const per = periodOf.get(r.corp_code)?.get(periodNameKey(cur.report_nm ?? ""));
      const dk = `${r.corp_code}|${cur.rcept_no}|${D}`;
      if (per && !done.has(dk)) {
        done.add(dk);
        const ev = guruEventOf(idx, r.corp_code, per.y, per.rc, D, true);
        if (ev) { ev.rceptDt = D; ev.rceptNo = r.rcept_no; ev.baseDt = cur.rcept_dt; push(out, r.corp_code, ev); added++; }
      }
    }
    if (r.reprt_code === "11011") {
      const ca = latestAt(annOrigs.get(r.corp_code), D), cf = filOf.get(r.rcept_no);
      const dk = `${r.corp_code}|${r.rcept_no}|${D}`;
      if (ca && cf && periodNameKey(cf.report_nm ?? "") === periodNameKey(ca.report_nm ?? "") && !doneAnn.has(dk)) {
        doneAnn.add(dk);
        const a = annualEventOf(idx, r.corp_code, r.bsns_year, D, true);
        if (a) { a.rceptDt = D; a.rceptNo = r.rcept_no; a.baseDt = ca.rcept_dt; push(ann, r.corp_code, a); addedAnnual++; }
      }
    }
  }
  const ord = <T extends { rceptDt: string; rceptNo: string; baseDt?: string }>(a: T, b: T): number => (a.rceptDt < b.rceptDt ? -1 : a.rceptDt > b.rceptDt ? 1 : (a.baseDt ? 1 : 0) - (b.baseDt ? 1 : 0) || (a.rceptNo < b.rceptNo ? -1 : 1));
  for (const l of out.values()) l.sort(ord);
  for (const l of ann.values()) l.sort(ord);
  return { events: out, annual: ann, added, addedAnnual };
}

/**
 * [임시 연구 — 병합 금지] 재무 품질(ROE) 지표: 정기 재무(연구 R fin.parquet)로 TTM 당기순이익·자본총계·ROE를 만드는 순수 함수. 사전 정의: docs/research/quality-prereg.md.
 * ROE = TTM 당기순이익 ÷ 자본총계(그 보고서 기말). TTM: 사업보고서면 그 보고서 당기, 분기·반기면 직전 사업연도 사업보고서 당기 + 당기 누적 − 전년 같은 기간 누적(같은 보고서의 전기·전기누적 값).
 * 계산이 불가능하면 최근 사업보고서 값으로 대체하지 않고 "제외". 연결 우선, 없으면 별도. 보고서는 접수일 < 신호일(접수일 다음 거래일부터 반영)인 것만 쓴다.
 */
export interface FinRep { code: string; year: number; rc: string; fs: string; rcept: string; rceptNo: string; status: string; niC: number | null; niA: number | null; niP: number | null; niPA: number | null; eqC: number | null }
export type RoeWhy = "ok" | "no_report" | "stale" | "no_annual" | "null_ni" | "null_eq" | "eq_nonpos" | "ttm_nonpos";
export interface RoeOut { why: RoeWhy; ttm?: number; eq?: number; roe?: number; repKey?: string }
const PERIOD_ORDER: Record<string, number> = { "11013": 1, "11012": 2, "11014": 3, "11011": 4 };
const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / 86_400_000;

export function makeRoeIndex(rows: FinRep[]): { roeAt: (code: string, d: string, maxAge: number) => RoeOut; nStocks: number } {
  // (종목, 사업연도, 보고서) 별로 연결(CFS) 우선, 없으면 별도(OFS) 한 건
  const pick = new Map<string, FinRep>();
  for (const r of rows) {
    const k = `${r.code}|${r.year}|${r.rc}`, o = pick.get(k);
    if (!o || (r.fs === "CFS" && o.fs !== "CFS")) pick.set(k, r);
  }
  const byCode = new Map<string, FinRep[]>();
  for (const r of pick.values()) { const a = byCode.get(r.code) ?? []; a.push(r); byCode.set(r.code, a); }
  for (const a of byCode.values()) a.sort((x, y) => (x.rcept < y.rcept ? -1 : x.rcept > y.rcept ? 1 : 0));
  const key = (r: FinRep): number => r.year * 10 + (PERIOD_ORDER[r.rc] ?? 0);
  const roeAt = (code: string, d: string, maxAge: number): RoeOut => {
    const a = byCode.get(code);
    if (!a) return { why: "no_report" };
    // 접수일 < 신호일인 보고서 중 기간 순번이 가장 늦은 것(늦게 접수된 과거 기간 정정본이 최신으로 보이는 것을 막는다)
    let F: FinRep | undefined;
    for (const r of a) { if (r.rcept >= d) break; if (!F || key(r) > key(F) || (key(r) === key(F) && r.rceptNo > F.rceptNo)) F = r; }
    if (!F) return { why: "no_report" };
    if (dayDiff(F.rcept, d) > maxAge) return { why: "stale" };
    let ttm: number;
    if (F.rc === "11011") { if (F.niC === null) return { why: "null_ni" }; ttm = F.niC; }
    else {
      const annual = a.find((r) => r.rc === "11011" && r.year === F.year - 1 && r.rcept < d && r.rcept < F.rcept);
      if (!annual) return { why: "no_annual" };
      const ytd = F.rc === "11013" ? F.niC : F.niA, prev = F.rc === "11013" ? F.niP : F.niPA;
      if (annual.niC === null || ytd === null || prev === null) return { why: "null_ni" };
      ttm = annual.niC + ytd - prev;
    }
    if (F.eqC === null) return { why: "null_eq" };
    if (!(F.eqC > 0)) return { why: "eq_nonpos", ttm, eq: F.eqC };
    if (!(ttm > 0)) return { why: "ttm_nonpos", ttm, eq: F.eqC };
    return { why: "ok", ttm, eq: F.eqC, roe: ttm / F.eqC, repKey: `${F.year}|${F.rc}` };
  };
  return { roeAt, nStocks: byCode.size };
}

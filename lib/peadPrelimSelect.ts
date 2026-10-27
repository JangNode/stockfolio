/**
 * [임시 연구 — 병합 금지] 연구 PEAD 잠정실적(PE7) 문서 선택 규칙(순수 함수). 수집 점검(scripts/collect-pead-prelim.ts)과 시험(scripts/research-pead-prelim.ts)이 같이 쓴다.
 * 규칙(사전등록 docs/research/pead-preliminary-disclosure-prereg.md): 같은 (기업, 기간) 연결 문서가 하나라도 있으면(파싱 실패 포함) 별도 문서는 쓰지 않는다. 같은 종류가 여러 개면 접수일이 이른 것(같은 날이면 접수번호 순).
 */
export interface PrelimRec {
  corp_code: string; stock_code: string; rcept_no: string; rcept_dt: string; report_nm: string; cons: boolean;
  cur_won: number | null; prevy_won: number | null; unit: string; period_year: number; period_q: number; period_src: string; ok: boolean; fail: string; zip_bytes: number;
}
export const prelimKey = (r: PrelimRec): string => `${r.corp_code}|${r.period_year}|${r.period_q}`;
export function selectPrelim(all: PrelimRec[]): Map<string, PrelimRec> {
  const hasCons = new Set(all.filter((r) => r.cons).map(prelimKey));
  const sel = new Map<string, PrelimRec>();
  for (const r of [...all].sort((a, b) => (a.rcept_dt < b.rcept_dt ? -1 : a.rcept_dt > b.rcept_dt ? 1 : a.rcept_no < b.rcept_no ? -1 : a.rcept_no > b.rcept_no ? 1 : 0))) {
    if (!r.cons && hasCons.has(prelimKey(r))) continue;
    if (!sel.has(prelimKey(r))) sel.set(prelimKey(r), r);
  }
  return sel;
}

import { NextResponse } from "next/server";
import { requireApproved } from "@/lib/requireApproved";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

interface ScreeningPriceRow {
  id: string;
  current_price: number;
  score: number | null;
}

/**
 * AI 모의투자 보유종목 표(components/PaperTrading.tsx)가 필요로 하는
 * screening_results.current_price/score만 서버 admin 권한으로 조회해 돌려준다.
 *
 * screening_results의 select RLS 정책(screening_results_select_own)은 "그 행의
 * strategy_id가 가리키는 strategies.user_id가 로그인한 사용자와 같아야" 통과한다 —
 * 사용자가 직접 만든 전략의 스크리닝 결과 화면 전용으로 설계된 정책이다. 하지만
 * AI 모의투자는 계정과 무관한 공유 포트폴리오이고, 그 매수 후보(dh_value_dividend/
 * peg_lynch/reversal_breakout처럼 계정마다 한 행씩 시딩되는 rule_type 포함)는 어느
 * 계정 소유 전략이든 참조할 수 있다. 클라이언트가 screening_results를 직접
 * 조회하면 로그인한 사용자 소유가 아닌 행은 못 읽어 현재가가 항상 매수가로
 * 대체 표시된다(2026-09-02 급등주 계좌에서 실제 재현 — 보유 5종목 전부 현재가=
 * 평단가로 보였던 원인).
 */
export async function GET(request: Request) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  const url = new URL(request.url);
  const idsParam = url.searchParams.get("ids");
  const ids = idsParam ? idsParam.split(",").filter(Boolean) : [];
  if (ids.length === 0) return NextResponse.json({ prices: [] });

  const { data, error } = await supabaseAdmin
    .from("screening_results")
    .select("id, current_price, score")
    .in("id", ids);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }

  return NextResponse.json({ prices: (data ?? []) as ScreeningPriceRow[] });
}

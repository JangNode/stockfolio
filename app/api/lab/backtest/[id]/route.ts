import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireApprovedUser } from "@/lib/requireApproved";
import { downloadCustomBacktestResult } from "@/lib/customBacktestStorage";

/**
 * 백테스트 요청 상태를 조회한다. 완료(status=completed)됐으면 Supabase Storage에 저장된
 * 원본 결과(매칭 종목/거래 내역 전체)도 함께 내려준다 — 클라이언트가 Storage에 직접
 * 접근하지 않고(비공개 버킷) 항상 이 라우트를 거치게 해 result_storage_path를
 * 노출하지 않는다.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApprovedUser(request);
  if ("response" in auth) return auth.response;

  const { id } = await params;

  const { data: run, error } = await supabaseAdmin
    .from("custom_backtest_runs")
    .select(
      "id, user_id, market, rule_params, period_months, status, total_return_pct, win_rate, mdd_pct, matched_stock_count, trade_count, result_storage_path, error_message, adopted_at, created_at, finished_at"
    )
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: `백테스트 조회 실패: ${error.message}` }, { status: 502 });
  }
  if (!run || run.user_id !== auth.user.id) {
    return NextResponse.json({ error: "존재하지 않는 백테스트입니다." }, { status: 404 });
  }

  const { result_storage_path, ...runWithoutPath } = run;

  if (run.status !== "completed" || !result_storage_path) {
    return NextResponse.json({ run: runWithoutPath, result: null });
  }

  try {
    const result = await downloadCustomBacktestResult(result_storage_path);
    return NextResponse.json({ run: runWithoutPath, result });
  } catch (downloadError) {
    const message = downloadError instanceof Error ? downloadError.message : "알 수 없는 오류";
    return NextResponse.json({ error: `결과 다운로드 실패: ${message}` }, { status: 502 });
  }
}

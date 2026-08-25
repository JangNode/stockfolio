import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireApprovedUser } from "@/lib/requireApproved";
import { CustomBacktestRequestSchema } from "@/lib/customBacktestRequest";
import { dispatchCustomBacktestWorkflow } from "@/lib/githubDispatch";

/** "실험실" 탭의 지난 백테스트 요청 목록(요약 통계만, 결과 원본은 [id] 라우트에서 내려받음). */
export async function GET(request: Request) {
  const auth = await requireApprovedUser(request);
  if ("response" in auth) return auth.response;

  const { data, error } = await supabaseAdmin
    .from("custom_backtest_runs")
    .select(
      "id, market, rule_params, period_months, status, total_return_pct, win_rate, mdd_pct, matched_stock_count, trade_count, error_message, adopted_at, created_at, finished_at"
    )
    .eq("user_id", auth.user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: `백테스트 목록 조회 실패: ${error.message}` }, { status: 502 });
  }

  return NextResponse.json({ runs: data ?? [] });
}

/**
 * 커스텀 조건 백테스트 요청을 접수한다. custom_backtest_runs에 pending 행을 만들고,
 * 전체 종목 풀 조회+백테스트를 실제로 수행하는 GitHub Actions 워크플로
 * (.github/workflows/custom-backtest.yml, scripts/run-custom-backtest.ts)를 트리거한다.
 * Vercel 서버리스 함수 실행 시간 제한 안에 전종목 스캔을 끝낼 수 없어 계산 자체는
 * 여기서 하지 않는다 — 클라이언트는 반환된 id로 GET [id]를 폴링해 진행 상황을 본다.
 */
export async function POST(request: Request) {
  const auth = await requireApprovedUser(request);
  if ("response" in auth) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문이 올바른 JSON이 아닙니다." }, { status: 400 });
  }

  const parsed = CustomBacktestRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "요청 형식이 올바르지 않습니다." },
      { status: 400 }
    );
  }

  const { market, period_months, rule_params } = parsed.data;

  const { data: run, error: insertError } = await supabaseAdmin
    .from("custom_backtest_runs")
    .insert({
      user_id: auth.user.id,
      market,
      period_months,
      rule_params,
      status: "pending",
    })
    .select("id")
    .single();

  if (insertError || !run) {
    return NextResponse.json(
      { error: `백테스트 요청 저장 실패: ${insertError?.message ?? "알 수 없는 오류"}` },
      { status: 502 }
    );
  }

  try {
    await dispatchCustomBacktestWorkflow(run.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "알 수 없는 오류";
    await supabaseAdmin
      .from("custom_backtest_runs")
      .update({
        status: "failed",
        error_message: message.slice(0, 2000),
        finished_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    return NextResponse.json({ error: `백테스트 실행 트리거 실패: ${message}` }, { status: 502 });
  }

  return NextResponse.json({ id: run.id }, { status: 201 });
}

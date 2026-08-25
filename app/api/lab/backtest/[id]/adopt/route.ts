import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { requireApprovedUser } from "@/lib/requireApproved";
import type { CustomCompositeParams } from "@/lib/backtest";

// paper_portfolios/paper_strategies의 3번째 슬롯. 계좌 자체는
// supabase/migrations/20260825020000_seed_custom_paper_portfolio.sql이 미리 만들어
// 뒀고, 이 라우트가 처음으로 paper_strategies 행을 채운다.
const PAPER_STYLE = "custom";

// paper_strategies 스키마(lib/paperStrategy.ts의 PaperStrategyConditionsSchema)가
// 요구하지만 실험실 조건 빌더에는 없는 값들의 기본값. 기존 라우틴 생성 전략(공격형/
// 안정형)과 비슷한 범위로 잡았다 — 이 값들을 개별 조정하는 UI는 아직 없다.
const DEFAULT_MIN_SIGNAL_RETURN_PCT = 0;
const DEFAULT_MAX_SIGNAL_RETURN_PCT = 50;
const DEFAULT_MAX_POSITIONS = 5;
const DEFAULT_POSITION_SIZE_PCT = 20;
const DEFAULT_TAKE_PROFIT_PCT = 20;
const DEFAULT_STOP_LOSS_PCT = 7;
const DEFAULT_MAX_HOLDING_DAYS = 30;
const DEFAULT_MAX_CANDIDATES_TO_CONSIDER = 10;

/**
 * 완료된 커스텀 백테스트의 조건을 "AI 모의투자" 커스텀 슬롯으로 채택한다.
 * 1) strategies에 custom_composite 전략을 저장한다 — 다음 야간 스크리닝(screen-all-
 *    stocks.ts/screen-us-stocks.ts)부터 이 조건으로 전체 종목을 스캔해 screening_results를
 *    채운다(진입조건까지 실제로 연결되는 지점).
 * 2) paper_strategies의 기존 활성 'custom' 버전을 retire하고 새 버전을 활성화한다.
 * 3) custom_backtest_runs.adopted_at을 채워 보관 정리 배치(다음 단계)가 이 결과를
 *    지우지 않게 한다.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireApprovedUser(request);
  if ("response" in auth) return auth.response;

  const { id } = await params;

  const { data: run, error } = await supabaseAdmin
    .from("custom_backtest_runs")
    .select("id, user_id, market, rule_params, status, total_return_pct, win_rate, mdd_pct, adopted_at")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: `백테스트 조회 실패: ${error.message}` }, { status: 502 });
  }
  if (!run || run.user_id !== auth.user.id) {
    return NextResponse.json({ error: "존재하지 않는 백테스트입니다." }, { status: 404 });
  }
  if (run.status !== "completed") {
    return NextResponse.json({ error: "완료된 백테스트만 채택할 수 있습니다." }, { status: 400 });
  }
  if (run.adopted_at) {
    return NextResponse.json({ error: "이미 채택된 백테스트입니다." }, { status: 400 });
  }

  const ruleParams = run.rule_params as CustomCompositeParams;
  const takeProfitPct = (ruleParams.take_profit_pct ?? DEFAULT_TAKE_PROFIT_PCT / 100) * 100;
  const stopLossPct = (ruleParams.stop_loss_pct ?? DEFAULT_STOP_LOSS_PCT / 100) * 100;

  const { data: strategy, error: strategyError } = await supabaseAdmin
    .from("strategies")
    .insert({
      user_id: auth.user.id,
      name: `실험실 채택 전략(${new Date().toISOString().slice(0, 10)})`,
      rule_type: "custom_composite",
      rule_params: ruleParams,
      market: run.market,
    })
    .select("id")
    .single();

  if (strategyError || !strategy) {
    return NextResponse.json(
      { error: `전략 저장 실패: ${strategyError?.message ?? "알 수 없는 오류"}` },
      { status: 502 }
    );
  }

  const { data: previousActive, error: previousError } = await supabaseAdmin
    .from("paper_strategies")
    .select("id, version")
    .eq("style", PAPER_STYLE)
    .eq("is_active", true)
    .maybeSingle();
  if (previousError) {
    return NextResponse.json({ error: `기존 커스텀 전략 조회 실패: ${previousError.message}` }, { status: 502 });
  }

  if (previousActive) {
    const { error: retireError } = await supabaseAdmin
      .from("paper_strategies")
      .update({ is_active: false, retired_at: new Date().toISOString() })
      .eq("id", previousActive.id);
    if (retireError) {
      return NextResponse.json({ error: `기존 커스텀 전략 정리 실패: ${retireError.message}` }, { status: 502 });
    }
  }

  const nextVersion = (previousActive?.version ?? 0) + 1;
  const rationale =
    `실험실에서 백테스트한 조건을 그대로 채택했습니다(수익률 ${(run.total_return_pct ?? 0).toFixed(2)}%, ` +
    `승률 ${((run.win_rate ?? 0) * 100).toFixed(1)}%, MDD ${(run.mdd_pct ?? 0).toFixed(2)}%, ` +
    `${run.market === "KR" ? "국내" : "미국"} 전체 종목 풀 대상).`;

  const { error: insertError } = await supabaseAdmin.from("paper_strategies").insert({
    style: PAPER_STYLE,
    version: nextVersion,
    label: `커스텀 전략 v${nextVersion}`,
    entry_conditions: {
      source_rule_types: ["custom_composite"],
      min_signal_return_pct: DEFAULT_MIN_SIGNAL_RETURN_PCT,
      max_signal_return_pct: DEFAULT_MAX_SIGNAL_RETURN_PCT,
      max_positions: DEFAULT_MAX_POSITIONS,
      position_size_pct: DEFAULT_POSITION_SIZE_PCT,
    },
    exit_conditions: {
      take_profit_pct: takeProfitPct,
      stop_loss_pct: stopLossPct,
      max_holding_days: DEFAULT_MAX_HOLDING_DAYS,
    },
    stock_selection_criteria: {
      prefer_higher_return_pct: true,
      max_candidates_to_consider: DEFAULT_MAX_CANDIDATES_TO_CONSIDER,
    },
    rationale,
    model: "lab-adopted",
    raw_response: null,
  });

  if (insertError) {
    return NextResponse.json({ error: `커스텀 전략 저장 실패: ${insertError.message}` }, { status: 502 });
  }

  const { error: adoptedError } = await supabaseAdmin
    .from("custom_backtest_runs")
    .update({ adopted_at: new Date().toISOString() })
    .eq("id", run.id);
  if (adoptedError) {
    console.error(`custom_backtest_runs.adopted_at 갱신 실패(${run.id}): ${adoptedError.message}`);
  }

  return NextResponse.json({ ok: true });
}

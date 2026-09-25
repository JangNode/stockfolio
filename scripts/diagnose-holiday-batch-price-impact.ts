/**
 * [디스포저블 진단 스크립트] 2026-09-24/25 추석 연휴 KRX 휴장일에 국내 스크리닝/AI
 * 모의투자 배치가 정상 거래일처럼 실행돼 발생한 매칭/손절이 실제 가격 변화 기반인지,
 * 가격 동결/오류 기반인지 확인한다. DB에 어떤 쓰기도 하지 않는다(select만).
 *
 * 배경: 배치 로그(GitHub Actions run 35960209045/9·24, 36098813556/9·25) 기준으로는
 * 이미 "9/24·25 신규 minervini 매칭 19건, 손절가가 양일 동일하고 9/23 실시간가와는
 * 다름(=9/23 종가에서 동결)"이 확인됐다 — 이 스크립트는 그 결론을 DB 원본 행으로
 * 재확인한다.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-holiday-batch-price-impact.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function bar(title: string) {
  console.log(`\n${"=".repeat(10)} ${title} ${"=".repeat(10)}`);
}

async function main() {
  bar("1. screening_runs (KR) 2026-09-22 ~ 2026-09-25");
  {
    const { data, error } = await supabaseAdmin
      .from("screening_runs")
      .select("*")
      .eq("market", "KR")
      .gte("finished_at", "2026-09-22T00:00:00Z")
      .lte("finished_at", "2026-09-26T00:00:00Z")
      .order("finished_at", { ascending: true });
    if (error) console.error(error);
    else console.log(JSON.stringify(data, null, 2));
  }

  bar("2. paper_runs (KR) 2026-09-22 ~ 2026-09-25");
  {
    const { data, error } = await supabaseAdmin
      .from("paper_runs")
      .select("*")
      .eq("market", "KR")
      .gte("finished_at", "2026-09-22T00:00:00Z")
      .lte("finished_at", "2026-09-26T00:00:00Z")
      .order("finished_at", { ascending: true });
    if (error) console.error(error);
    else console.log(JSON.stringify(data, null, 2));
  }

  bar("3. screening_results: matched_at이 2026-09-25(KST)인 minervini_trend_template 신규 매칭");
  let newMatches: any[] = [];
  {
    // strategies에서 minervini_trend_template rule_type id 목록 먼저 조회
    const { data: strategies, error: stratErr } = await supabaseAdmin
      .from("strategies")
      .select("id, name, rule_type, market")
      .eq("rule_type", "minervini_trend_template");
    if (stratErr) console.error(stratErr);
    console.log("minervini_trend_template 전략들:", JSON.stringify(strategies, null, 2));

    const stratIds = (strategies ?? []).map((s) => s.id);
    if (stratIds.length > 0) {
      const { data, error } = await supabaseAdmin
        .from("screening_results")
        .select(
          "id, strategy_id, stock_code, stock_name, signal_price, entry_price, stop_loss_price, take_profit_price, current_price, return_pct, status, matched_at, closed_at, market"
        )
        .in("strategy_id", stratIds)
        .gte("matched_at", "2026-09-24T14:00:00Z") // KST 2026-09-24 23:00 이후 ~ 넉넉히
        .lte("matched_at", "2026-09-26T06:00:00Z")
        .order("matched_at", { ascending: true });
      if (error) console.error(error);
      else {
        newMatches = data ?? [];
        console.log(`건수: ${newMatches.length}`);
        console.log(JSON.stringify(newMatches, null, 2));
      }
    }
  }

  bar("4. paper_trades: 2026-09-25 KST 발생한 sell(손절 추정) 거래");
  let sellTrades: any[] = [];
  {
    const { data, error } = await supabaseAdmin
      .from("paper_trades")
      .select(
        "id, portfolio_id, strategy_id, stock_code, stock_name, side, quantity, price, amount, realized_pnl, rationale, screening_result_id, market, traded_at"
      )
      .eq("market", "KR")
      .eq("side", "sell")
      .gte("traded_at", "2026-09-24T14:00:00Z")
      .lte("traded_at", "2026-09-26T06:00:00Z")
      .order("traded_at", { ascending: true });
    if (error) console.error(error);
    else {
      sellTrades = data ?? [];
      console.log(`건수: ${sellTrades.length}`);
      console.log(JSON.stringify(sellTrades, null, 2));
    }
  }

  bar("5. stock_daily_prices_recent: 9/23, 9/24, 9/25 종가 비교 (신규매칭 19건 종목)");
  {
    const codes = Array.from(new Set(newMatches.map((m) => m.stock_code)));
    if (codes.length > 0) {
      const { data, error } = await supabaseAdmin
        .from("stock_daily_prices_recent")
        .select("stock_code, trade_date, open_price, high_price, low_price, close_price, volume")
        .in("stock_code", codes)
        .gte("trade_date", "2026-09-22")
        .lte("trade_date", "2026-09-25")
        .order("stock_code", { ascending: true })
        .order("trade_date", { ascending: true });
      if (error) console.error(error);
      else console.log(JSON.stringify(data, null, 2));
    } else {
      console.log("신규 매칭 종목 없음");
    }
  }

  bar("6. stock_daily_prices_recent: 9/23, 9/24, 9/25 종가 비교 (손절 매도 종목)");
  {
    const codes = Array.from(new Set(sellTrades.map((t) => t.stock_code)));
    if (codes.length > 0) {
      const { data, error } = await supabaseAdmin
        .from("stock_daily_prices_recent")
        .select("stock_code, trade_date, open_price, high_price, low_price, close_price, volume")
        .in("stock_code", codes)
        .gte("trade_date", "2026-09-22")
        .lte("trade_date", "2026-09-25")
        .order("stock_code", { ascending: true })
        .order("trade_date", { ascending: true });
      if (error) console.error(error);
      else console.log(JSON.stringify(data, null, 2));
    } else {
      console.log("손절 매도 종목 없음");
    }
  }

  bar("7. 손절 매도의 원본 screening_results 행(진입가/손절가/실제 매도가 비교)");
  {
    const ids = Array.from(new Set(sellTrades.map((t) => t.screening_result_id).filter(Boolean)));
    if (ids.length > 0) {
      const { data, error } = await supabaseAdmin
        .from("screening_results")
        .select(
          "id, strategy_id, stock_code, stock_name, signal_price, entry_price, stop_loss_price, take_profit_price, current_price, return_pct, status, matched_at, closed_at"
        )
        .in("id", ids as string[]);
      if (error) console.error(error);
      else console.log(JSON.stringify(data, null, 2));
    } else {
      console.log("screening_result_id 없음");
    }
  }

  bar("8. screening_results: status='stopped', closed_at 2026-09-25(KST) 전체 (paper_trades와 별개로 직접 확인)");
  {
    const { data, error } = await supabaseAdmin
      .from("screening_results")
      .select(
        "id, strategy_id, stock_code, stock_name, signal_price, entry_price, stop_loss_price, take_profit_price, current_price, return_pct, status, matched_at, closed_at, market"
      )
      .eq("status", "stopped")
      .eq("market", "KR")
      .gte("closed_at", "2026-09-24T14:00:00Z")
      .lte("closed_at", "2026-09-26T06:00:00Z")
      .order("closed_at", { ascending: true });
    if (error) console.error(error);
    else {
      console.log(`건수: ${data?.length ?? 0}`);
      console.log(JSON.stringify(data, null, 2));
    }
  }

  bar("9. 참고: stock_daily_prices_recent 전체에서 9/24, 9/25 날짜 자체가 존재하는지(휴장일 데이터 유입 여부)");
  {
    const { data, error } = await supabaseAdmin
      .from("stock_daily_prices_recent")
      .select("trade_date")
      .in("trade_date", ["2026-09-23", "2026-09-24", "2026-09-25"]);
    if (error) console.error(error);
    else {
      const counts: Record<string, number> = {};
      for (const row of data ?? []) counts[row.trade_date] = (counts[row.trade_date] ?? 0) + 1;
      console.log(JSON.stringify(counts, null, 2));
    }
  }
}

main()
  .then(() => {
    console.log("\n조사 완료.");
  })
  .catch((error) => {
    console.error("조사 중 오류:", error);
    process.exit(1);
  });

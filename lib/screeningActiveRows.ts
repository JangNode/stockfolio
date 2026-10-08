import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAllRows } from "@/lib/supabasePagination";

/** screen-all-stocks.ts의 "기존 추적 종목 갱신" 단계가 쓰는 screening_results 행. */
export interface ActiveRow {
  id: string;
  stock_code: string;
  status: "active" | "price_anomaly";
  matched_at: string;
  entry_price: number;
  stop_loss_price: number;
  take_profit_price: number;
  current_price: number;
  last_price_fetch_success_at: string;
  price_fetch_failure_count: number;
}

/** 국내(KR) 추적 대상 전체(active + price_anomaly). 1,000건을 넘어도 전부 읽는다. */
export async function loadKrTrackingRows(): Promise<ActiveRow[]> {
  // market="US" 행은 별도 배치(screen-us-stocks.ts)가 다룬다 — 국내 getStockPrice(6자리 종목코드 전제)로 미국 티커를
  // 조회하면 잘못된 값을 받거나 실패하므로 반드시 국내 행만 골라야 한다.
  return fetchAllRows<ActiveRow>((from, to) =>
    supabaseAdmin
      .from("screening_results")
      .select(
        "id, stock_code, status, matched_at, entry_price, stop_loss_price, take_profit_price, current_price, last_price_fetch_success_at, price_fetch_failure_count"
      )
      // price_anomaly 행도 매번 다시 평가한다 — 확정된 조정계수 이벤트가 등록되면 자동으로 active로 복귀한다.
      .in("status", ["active", "price_anomaly"])
      .eq("market", "KR")
      .order("id")
      .range(from, to)
  );
}

/**
 * 이미 추적 중인(status=active) (전략, 종목) 쌍의 키("strategy_id:stock_code") 집합. 같은 쌍을 다시 저장하다 active 유일
 * 제약에 걸리지 않게 하는 중복 확인용이라, 일부만 읽으면 중복 저장 오류가 난다. strategyIds를 주면 그 전략만 본다.
 */
export async function loadActiveStrategyStockKeys(strategyIds?: string[]): Promise<Set<string>> {
  const rows = await fetchAllRows<{ strategy_id: string; stock_code: string }>((from, to) => {
    let query = supabaseAdmin.from("screening_results").select("strategy_id, stock_code").eq("status", "active");
    if (strategyIds) query = query.in("strategy_id", strategyIds);
    return query.order("id").range(from, to);
  });
  return new Set(rows.map((r) => `${r.strategy_id}:${r.stock_code}`));
}

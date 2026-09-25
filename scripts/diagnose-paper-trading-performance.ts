/**
 * [디스포저블 진단 스크립트] AI 모의투자(안정형/공격형/급등주/실험조합형) 라이브 성과
 * 정리 — "수익률이 안 좋다"는 인상이 실제 숫자로도 맞는지 확인한다. DB 쓰기 없음
 * (순수 조회+계산).
 *
 * 계좌(style x market)별로:
 * 1. 현재 누적수익률/평가금액, 시작일, 실제 스냅샷(활성 거래일)수
 * 2. 같은 기간 코스피/코스닥 지수 수익률(beta_price_history, 커버리지 부족하면 명시)
 * 3. 매도 거래를 손절/익절/최대보유기간초과/기타로 분류 + 보유 중(미청산) 포지션 수
 * 4. 가장 큰 단일 손실 거래가 전체 실현손익에서 차지하는 비중(쏠림 확인)
 * 5. 실험조합형(experimental_blend)은 rule_type별 현재 보유비중을 목표(54/36/10)와 비교
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-paper-trading-performance.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { EXPERIMENTAL_BLEND_TARGET_WEIGHTS } from "@/lib/experimentalBlendConfig";
import type { Market } from "@/lib/market";

interface PortfolioRow {
  id: string;
  style: string;
  market: Market;
  initial_capital: number;
  cash: number;
}

interface SnapshotRow {
  snapshot_date: string;
  equity: number;
  cumulative_return_pct: number;
}

interface TradeRow {
  side: "buy" | "sell";
  quantity: number;
  price: number;
  amount: number;
  realized_pnl: number | null;
  rationale: string;
  stock_code: string;
  traded_at: string;
}

interface PositionRow {
  id: string;
  stock_code: string;
  stock_name: string;
  quantity: number;
  avg_price: number;
  screening_result_id: string | null;
  opened_at: string;
}

function classifyExitReason(rationale: string): "손절" | "익절" | "최대보유기간" | "기타" {
  if (rationale.includes("최대 보유기간")) return "최대보유기간";
  if (rationale.includes("손절")) return "손절";
  if (rationale.includes("익절")) return "익절";
  return "기타";
}

async function main(): Promise<void> {
  const { data: portfolios, error: portfoliosError } = await supabaseAdmin
    .from("paper_portfolios")
    .select("id, style, market, initial_capital, cash")
    .order("style", { ascending: true });
  if (portfoliosError) throw new Error(`paper_portfolios 조회 실패: ${portfoliosError.message}`);

  for (const portfolio of (portfolios ?? []) as PortfolioRow[]) {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`[${portfolio.style} / ${portfolio.market}]`);

    const { data: snapshots, error: snapshotsError } = await supabaseAdmin
      .from("paper_daily_snapshots")
      .select("snapshot_date, equity, cumulative_return_pct")
      .eq("portfolio_id", portfolio.id)
      .order("snapshot_date", { ascending: true });
    if (snapshotsError) throw new Error(`스냅샷 조회 실패: ${snapshotsError.message}`);

    const snaps = (snapshots ?? []) as SnapshotRow[];
    if (snaps.length === 0) {
      console.log("  스냅샷 0건 — 아직 라이브 데이터 없음");
      continue;
    }

    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    console.log(
      `  기간: ${first.snapshot_date} ~ ${last.snapshot_date} (${snaps.length}일), 시작자본 ${portfolio.initial_capital.toLocaleString()}, 현재평가금액 ${last.equity.toLocaleString()}`
    );
    console.log(`  누적수익률: ${last.cumulative_return_pct.toFixed(2)}%`);

    // 벤치마크(코스피/코스닥)
    if (portfolio.market === "KR") {
      for (const idxMarket of ["KOSPI", "KOSDAQ"] as const) {
        try {
          const idx = await getIndexPriceSeries(idxMarket, first.snapshot_date, last.snapshot_date);
          if (idx.length >= 2) {
            const chg = ((idx[idx.length - 1].closePrice - idx[0].closePrice) / idx[0].closePrice) * 100;
            console.log(`  ${idxMarket} 같은 기간: ${chg.toFixed(2)}% (${idx.length}거래일 데이터)`);
          } else {
            console.log(`  ${idxMarket} 같은 기간: 데이터 부족(${idx.length}건) — beta_price_history 커버리지 확인 필요`);
          }
        } catch (error) {
          console.log(`  ${idxMarket} 조회 실패: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else {
      console.log("  US 지수(S&P500/NASDAQ) 데이터는 DB에 없음 — 별도 확인 필요");
    }

    // 매매 로그
    const { data: trades, error: tradesError } = await supabaseAdmin
      .from("paper_trades")
      .select("side, quantity, price, amount, realized_pnl, rationale, stock_code, traded_at")
      .eq("portfolio_id", portfolio.id)
      .order("traded_at", { ascending: true });
    if (tradesError) throw new Error(`거래 내역 조회 실패: ${tradesError.message}`);

    const allTrades = (trades ?? []) as TradeRow[];
    const buys = allTrades.filter((t) => t.side === "buy");
    const sells = allTrades.filter((t) => t.side === "sell");
    console.log(`  매매: 매수 ${buys.length}건, 매도 ${sells.length}건`);

    const reasonCounts: Record<string, number> = { 손절: 0, 익절: 0, 최대보유기간: 0, 기타: 0 };
    let totalRealizedPnl = 0;
    let worstTrade: TradeRow | null = null;
    let totalNegativePnl = 0;
    for (const sell of sells) {
      const reason = classifyExitReason(sell.rationale);
      reasonCounts[reason]++;
      const pnl = sell.realized_pnl ?? 0;
      totalRealizedPnl += pnl;
      if (pnl < 0) totalNegativePnl += pnl;
      if (!worstTrade || pnl < (worstTrade.realized_pnl ?? 0)) worstTrade = sell;
    }
    if (sells.length > 0) {
      console.log(
        `  매도 사유: 손절 ${reasonCounts["손절"]}건, 익절 ${reasonCounts["익절"]}건, 최대보유기간초과 ${reasonCounts["최대보유기간"]}건, 기타 ${reasonCounts["기타"]}건`
      );
      console.log(`  총 실현손익: ${Math.round(totalRealizedPnl).toLocaleString()}`);
      if (worstTrade) {
        const share = totalNegativePnl !== 0 ? ((worstTrade.realized_pnl ?? 0) / totalNegativePnl) * 100 : 0;
        console.log(
          `  최악의 단일 거래: ${worstTrade.stock_code} ${Math.round(worstTrade.realized_pnl ?? 0).toLocaleString()} ` +
            `(전체 손실 합계 중 ${share.toFixed(1)}%, ${worstTrade.traded_at.slice(0, 10)})`
        );
      }
    }

    // 보유 중(미청산) 포지션
    const { data: positions, error: positionsError } = await supabaseAdmin
      .from("paper_positions")
      .select("id, stock_code, stock_name, quantity, avg_price, screening_result_id, opened_at")
      .eq("portfolio_id", portfolio.id);
    if (positionsError) throw new Error(`보유 포지션 조회 실패: ${positionsError.message}`);

    const openPositions = (positions ?? []) as PositionRow[];
    console.log(`  현재 보유 중(미청산): ${openPositions.length}건`);

    if (openPositions.length > 0) {
      const screeningIds = openPositions
        .map((p) => p.screening_result_id)
        .filter((id): id is string => id !== null);
      const priceById = new Map<string, number>();
      const strategyIdByScreeningId = new Map<string, string>();
      if (screeningIds.length > 0) {
        const { data: screeningRows, error: screeningError } = await supabaseAdmin
          .from("screening_results")
          .select("id, current_price, strategy_id")
          .in("id", screeningIds);
        if (screeningError) throw new Error(`보유 포지션 원본 스크리닝 조회 실패: ${screeningError.message}`);
        for (const row of screeningRows ?? []) {
          priceById.set(row.id, row.current_price);
          strategyIdByScreeningId.set(row.id, row.strategy_id);
        }
      }

      let unrealized = 0;
      for (const p of openPositions) {
        const currentPrice = (p.screening_result_id ? priceById.get(p.screening_result_id) : undefined) ?? p.avg_price;
        unrealized += (currentPrice - p.avg_price) * p.quantity;
      }
      console.log(`  미청산 포지션 평가손익(추정): ${Math.round(unrealized).toLocaleString()}`);

      // 실험조합형: rule_type별 보유비중
      if (portfolio.style === "experimental_blend") {
        const strategyIds = Array.from(new Set(strategyIdByScreeningId.values()));
        const { data: strategyRows } = await supabaseAdmin
          .from("strategies")
          .select("id, rule_type")
          .in("id", strategyIds);
        const ruleTypeByStrategyId = new Map((strategyRows ?? []).map((s) => [s.id, s.rule_type]));

        const ruleTypeByScreeningId = new Map(
          Array.from(strategyIdByScreeningId.entries()).map(([screeningId, strategyId]) => [
            screeningId,
            ruleTypeByStrategyId.get(strategyId) ?? "unknown",
          ])
        );

        const valueByRuleType = new Map<string, number>();
        let totalPositionsValue = 0;
        for (const p of openPositions) {
          const currentPrice = (p.screening_result_id ? priceById.get(p.screening_result_id) : undefined) ?? p.avg_price;
          const value = currentPrice * p.quantity;
          totalPositionsValue += value;
          const ruleType = p.screening_result_id ? ruleTypeByScreeningId.get(p.screening_result_id) ?? "unknown" : "unknown";
          valueByRuleType.set(ruleType, (valueByRuleType.get(ruleType) ?? 0) + value);
        }

        const totalEquity = last.equity;
        console.log("  실험조합형 rule_type별 보유비중(목표 대비):");
        for (const [ruleType, targetWeight] of Object.entries(EXPERIMENTAL_BLEND_TARGET_WEIGHTS)) {
          const value = valueByRuleType.get(ruleType) ?? 0;
          const actualPct = (value / totalEquity) * 100;
          console.log(
            `    ${ruleType}: 목표 ${(targetWeight * 100).toFixed(0)}%, 실제 ${actualPct.toFixed(1)}% (평가금액 ${Math.round(value).toLocaleString()})`
          );
        }
        const untracked = totalPositionsValue - Array.from(valueByRuleType.entries())
          .filter(([rt]) => rt in EXPERIMENTAL_BLEND_TARGET_WEIGHTS)
          .reduce((s, [, v]) => s + v, 0);
        if (Math.abs(untracked) > 1) {
          console.log(`    (목표비중 미정의 rule_type 등 기타: ${Math.round(untracked).toLocaleString()})`);
        }
        console.log(`  보유 종목 상세: ${openPositions.map((p) => `${p.stock_code}(${p.quantity}주)`).join(", ")}`);
      }
    }
  }

  console.log("\n완료");
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});

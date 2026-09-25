/**
 * [디스포저블 진단 스크립트] 실험조합형(experimental_blend) KR 계좌의 콜드스타트
 * 17건 매수 되돌리기 전, 실제 DB 상태(포트폴리오 현금, 오늘 매수 거래, 대응
 * 포지션, 스냅샷)를 확인한다. DB 쓰기 없음(순수 조회).
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-experimental-blend-cold-start.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { EXPERIMENTAL_BLEND_STYLE } from "@/lib/experimentalBlendConfig";

async function printNextKrxTradingDay(): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("krx_trading_calendar")
    .select("trade_date, is_open")
    .gt("trade_date", "2026-09-25")
    .eq("is_open", true)
    .order("trade_date", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`거래일 캘린더 조회 실패: ${error.message}`);
  console.log("다음 KRX 개장일(2026-09-25 이후):", JSON.stringify(data));
}

async function main(): Promise<void> {
  await printNextKrxTradingDay();

  const { data: portfolio, error: portfolioError } = await supabaseAdmin
    .from("paper_portfolios")
    .select("*")
    .eq("style", EXPERIMENTAL_BLEND_STYLE)
    .eq("market", "KR")
    .maybeSingle();
  if (portfolioError) throw new Error(`포트폴리오 조회 실패: ${portfolioError.message}`);
  console.log("포트폴리오:", JSON.stringify(portfolio, null, 2));
  if (!portfolio) return;

  const { data: allTrades, error: tradesError } = await supabaseAdmin
    .from("paper_trades")
    .select("*")
    .eq("portfolio_id", portfolio.id)
    .order("traded_at", { ascending: true });
  if (tradesError) throw new Error(`거래 조회 실패: ${tradesError.message}`);
  console.log(`\n전체 거래 건수: ${allTrades?.length ?? 0}`);
  console.log(JSON.stringify(allTrades, null, 2));

  const { data: positions, error: positionsError } = await supabaseAdmin
    .from("paper_positions")
    .select("*")
    .eq("portfolio_id", portfolio.id);
  if (positionsError) throw new Error(`포지션 조회 실패: ${positionsError.message}`);
  console.log(`\n현재 보유 포지션 건수: ${positions?.length ?? 0}`);
  console.log(JSON.stringify(positions, null, 2));

  const { data: snapshots, error: snapshotsError } = await supabaseAdmin
    .from("paper_daily_snapshots")
    .select("*")
    .eq("portfolio_id", portfolio.id)
    .order("snapshot_date", { ascending: true });
  if (snapshotsError) throw new Error(`스냅샷 조회 실패: ${snapshotsError.message}`);
  console.log(`\n스냅샷 건수: ${snapshots?.length ?? 0}`);
  console.log(JSON.stringify(snapshots, null, 2));

  const buyTrades = (allTrades ?? []).filter((t) => t.side === "buy");
  const sellTrades = (allTrades ?? []).filter((t) => t.side === "sell");
  const totalBuyAmount = buyTrades.reduce((sum, t) => sum + Number(t.amount), 0);
  console.log(
    `\n요약: 매수 ${buyTrades.length}건(총 ${totalBuyAmount.toLocaleString()}원), ` +
      `매도 ${sellTrades.length}건, 현재 cash=${portfolio.cash}, initial_capital=${portfolio.initial_capital}, ` +
      `cash+totalBuyAmount=${Number(portfolio.cash) + totalBuyAmount}`
  );
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});

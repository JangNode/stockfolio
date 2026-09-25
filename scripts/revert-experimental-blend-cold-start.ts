/**
 * [디스포저블 정리 스크립트, 1회성] 실험조합형(experimental_blend) KR 계좌의
 * 콜드스타트 첫 매수 17건을 전부 취소하고 원상복구한다(4단계, 사용자 확인
 * 완료). 진짜 돈이 아니라 모의투자이고, 이게 이 계좌의 첫 매매라 지금
 * 되돌리면 게이팅 로직 개선 후 "정상적인 첫 매매"를 다시 볼 수 있다.
 *
 * scripts/diagnose-experimental-blend-cold-start.ts로 이미 확인한 상태:
 * 매수 17건(총 716,382원), 매도 0건, 포지션 17건(매수 17건과 정확히 대응),
 * 스냅샷 1건(2026-09-25), cash(283,618) + 매수총액(716,382) = initial_capital
 * (1,000,000) — 이 계좌 최초 거래일이라 매도가 전혀 없어 되돌리기가 단순하다.
 *
 * 기본은 계획만 출력하는 드라이런이다. 실제로 DB에 반영하려면
 * REVERT_EXPERIMENTAL_BLEND_APPLY=true 환경변수를 줘야 한다.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/revert-experimental-blend-cold-start.ts
 *   REVERT_EXPERIMENTAL_BLEND_APPLY=true tsx --conditions=react-server scripts/revert-experimental-blend-cold-start.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { EXPERIMENTAL_BLEND_STYLE } from "@/lib/experimentalBlendConfig";

async function main(): Promise<void> {
  const apply = process.env.REVERT_EXPERIMENTAL_BLEND_APPLY === "true";
  console.log(apply ? "*** APPLY 모드: 실제로 DB를 수정합니다 ***" : "드라이런 모드(계획만 출력, DB 미수정)");

  const { data: portfolio, error: portfolioError } = await supabaseAdmin
    .from("paper_portfolios")
    .select("*")
    .eq("style", EXPERIMENTAL_BLEND_STYLE)
    .eq("market", "KR")
    .maybeSingle();
  if (portfolioError) throw new Error(`포트폴리오 조회 실패: ${portfolioError.message}`);
  if (!portfolio) throw new Error("실험조합형 KR 포트폴리오를 찾을 수 없습니다.");

  const { data: trades, error: tradesError } = await supabaseAdmin
    .from("paper_trades")
    .select("*")
    .eq("portfolio_id", portfolio.id);
  if (tradesError) throw new Error(`거래 조회 실패: ${tradesError.message}`);

  const buyTrades = (trades ?? []).filter((t) => t.side === "buy");
  const sellTrades = (trades ?? []).filter((t) => t.side === "sell");

  // 안전 가드: 이 계좌 최초 거래일이라 매도가 전혀 없어야 되돌리기가 단순하다.
  // 매도가 하나라도 있으면 가정이 깨지므로(예: 다음 정상 거래일 배치가 먼저
  // 돌아 매도가 생긴 경우) 자동으로 처리하지 않는다.
  if (sellTrades.length > 0) {
    console.error(`매도 거래가 ${sellTrades.length}건 존재합니다 — 가정이 깨져 안전을 위해 중단합니다.`);
    process.exit(1);
  }

  const { data: positions, error: positionsError } = await supabaseAdmin
    .from("paper_positions")
    .select("*")
    .eq("portfolio_id", portfolio.id);
  if (positionsError) throw new Error(`포지션 조회 실패: ${positionsError.message}`);

  const totalBuyAmount = buyTrades.reduce((sum, t) => sum + Number(t.amount), 0);
  const restoredCash = Number(portfolio.cash) + totalBuyAmount;

  console.log(`\n포트폴리오: ${portfolio.id} (cash=${portfolio.cash}, initial_capital=${portfolio.initial_capital})`);
  console.log(`삭제 대상 거래: ${buyTrades.length}건(총 ${totalBuyAmount.toLocaleString()}원)`);
  console.log(`삭제 대상 포지션: ${positions?.length ?? 0}건`);
  console.log(`복원할 cash: ${portfolio.cash} + ${totalBuyAmount} = ${restoredCash}`);

  if (restoredCash !== Number(portfolio.initial_capital)) {
    console.error(
      `복원될 cash(${restoredCash})가 initial_capital(${portfolio.initial_capital})과 다릅니다 — ` +
        `가정이 깨져 안전을 위해 중단합니다.`
    );
    process.exit(1);
  }

  if (!apply) {
    console.log("\n드라이런 종료 — 실제 반영 없음. REVERT_EXPERIMENTAL_BLEND_APPLY=true로 재실행하면 반영됩니다.");
    return;
  }

  if ((positions?.length ?? 0) > 0) {
    const { error } = await supabaseAdmin
      .from("paper_positions")
      .delete()
      .in("id", (positions ?? []).map((p) => p.id));
    if (error) throw new Error(`포지션 삭제 실패: ${error.message}`);
  }
  console.log(`포지션 삭제 완료: ${positions?.length ?? 0}건`);

  if (buyTrades.length > 0) {
    const { error } = await supabaseAdmin
      .from("paper_trades")
      .delete()
      .in("id", buyTrades.map((t) => t.id));
    if (error) throw new Error(`거래 삭제 실패: ${error.message}`);
  }
  console.log(`거래 삭제 완료: ${buyTrades.length}건`);

  const { error: snapshotError } = await supabaseAdmin
    .from("paper_daily_snapshots")
    .delete()
    .eq("portfolio_id", portfolio.id)
    .eq("snapshot_date", "2026-09-25");
  if (snapshotError) throw new Error(`스냅샷 삭제 실패: ${snapshotError.message}`);
  console.log("2026-09-25 스냅샷 삭제 완료");

  const { error: cashError } = await supabaseAdmin
    .from("paper_portfolios")
    .update({ cash: portfolio.initial_capital })
    .eq("id", portfolio.id);
  if (cashError) throw new Error(`현금 복원 실패: ${cashError.message}`);
  console.log(`현금 복원 완료: cash=${portfolio.initial_capital}`);
}

main().catch((error) => {
  console.error("되돌리기 스크립트 중 오류:", error);
  process.exit(1);
});

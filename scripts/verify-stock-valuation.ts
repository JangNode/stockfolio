/**
 * 관심종목 적정주가(RIM 잔여이익모델 + 방법A 업종 평균 PER) 실데이터 검증용
 * 디스포저블 스크립트. app/api/stock/[code]/valuation/route.ts의 GET 핸들러가 하는
 * 계산을 그대로 재현해(동일 lib 함수 호출) 실제 응답에 들어갈 rim/peerPer 필드가
 * 기대한 구조·범위인지 확인한다.
 *
 * requireApproved(로그인 세션) 검증은 이 스크립트에서 건너뛴다 — GitHub Actions에는
 * 브라우저 세션이 없고, 이 검증의 목적은 새로 추가된 RIM/방법A 계산 로직 자체의
 * 실데이터 검증이라 인증 레이어(기존 코드, 이번 PR과 무관)는 대상이 아니다.
 *
 * 확인 순서:
 * 1. stock_beta에서 beta가 산출된 종목, stock_industry_classification에서 업종
 *    분류가 있는 종목을 조회해 테스트 대상을 정한다(베타+업종 PER 둘 다 있는 종목,
 *    베타가 없는 종목, 업종 분류가 없는 종목).
 * 2. 각 대상 종목에 대해 라우트와 동일한 순서로 KIS/ECOS/DB 데이터를 모아 rim,
 *    peerPer를 계산하고, 중간값(BPS, ROE, 베타, 무위험이자율, 요구수익률)까지
 *    전부 출력한다 — 수동 검산에 쓴다.
 *
 * DB에는 아무것도 쓰지 않는 읽기 전용 검증 — 확인 끝나면 정리 PR에서 스크립트/
 * 워크플로와 함께 삭제한다.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, KIS_APP_KEY,
 *   KIS_APP_SECRET, ECOS_API_KEY
 *   tsx --conditions=react-server scripts/verify-stock-valuation.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getStockPrice, getProfitRatioYears, getDividendRecords } from "@/lib/kis";
import { getEcosSeries } from "@/lib/ecosClient";
import { getStockBeta } from "@/lib/stockBetaStorage";
import { computeRimFairValue } from "@/lib/rimValuation";
import { computeRequiredReturnPct } from "@/lib/capm";
import { getStockIndustry } from "@/lib/industryClassificationStorage";
import { getIndustryAveragePer } from "@/lib/industryAveragePerStorage";
import { computePeerPerFairValue } from "@/lib/peerPerValuation";

const ECOS_RISK_FREE_LOOKBACK_DAYS = 30;

function yyyymmddDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function todayKstIsoDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

interface Candidate {
  stockCode: string;
  beta: number | null;
  indutyGroup: string | null;
  groupMedianPer: number | null;
  peerCount: number;
}

async function pickCandidates(): Promise<{
  bothAvailable: Candidate | null;
  betaOnly: Candidate | null;
  neitherAvailable: Candidate | null;
}> {
  console.log("########## 1. 테스트 대상 종목 조회 ##########\n");

  // 삼성전자가 후보군(시총 1조 이상 이력)에 있는지, 베타/업종분류가 있는지 먼저 확인.
  const { data: samsungBeta } = await supabaseAdmin
    .from("stock_beta")
    .select("stock_code, beta, data_points")
    .eq("stock_code", "005930")
    .maybeSingle();
  const { data: samsungIndustry } = await supabaseAdmin
    .from("stock_industry_classification")
    .select("stock_code, induty_group")
    .eq("stock_code", "005930")
    .maybeSingle();
  console.log("005930(삼성전자) stock_beta:", JSON.stringify(samsungBeta));
  console.log("005930(삼성전자) stock_industry_classification:", JSON.stringify(samsungIndustry));

  const { data: betaRows, error: betaError } = await supabaseAdmin
    .from("stock_beta")
    .select("stock_code, beta, data_points")
    .not("beta", "is", null)
    .order("data_points", { ascending: false })
    .limit(30);
  if (betaError) throw new Error(`stock_beta 조회 실패: ${betaError.message}`);
  console.log(`\nbeta not null 종목 수(상위 30개 중): ${betaRows?.length ?? 0}`);

  const { data: industryRows, error: industryError } = await supabaseAdmin
    .from("stock_industry_classification")
    .select("stock_code, induty_group")
    .not("induty_group", "is", null)
    .limit(2000);
  if (industryError) throw new Error(`stock_industry_classification 조회 실패: ${industryError.message}`);
  const industryByCode = new Map<string, string>((industryRows ?? []).map((r) => [r.stock_code as string, r.induty_group as string]));

  const { data: averagePerRows, error: averagePerError } = await supabaseAdmin
    .from("industry_average_per")
    .select("induty_group, median_per, peer_count")
    .not("median_per", "is", null);
  if (averagePerError) throw new Error(`industry_average_per 조회 실패: ${averagePerError.message}`);
  const averagePerByGroup = new Map<string, { medianPer: number; peerCount: number }>(
    (averagePerRows ?? []).map((r) => [r.induty_group as string, { medianPer: Number(r.median_per), peerCount: r.peer_count as number }])
  );

  let bothAvailable: Candidate | null = null;
  for (const row of betaRows ?? []) {
    const code = row.stock_code as string;
    const indutyGroup = industryByCode.get(code) ?? null;
    if (!indutyGroup) continue;
    const avgPer = averagePerByGroup.get(indutyGroup);
    if (!avgPer) continue;
    bothAvailable = {
      stockCode: code,
      beta: Number(row.beta),
      indutyGroup,
      groupMedianPer: avgPer.medianPer,
      peerCount: avgPer.peerCount,
    };
    break;
  }

  // 베타는 있지만 업종 분류가 없는(혹은 업종 PER 미산출) 종목 — RIM은 되고 방법A는
  // 안 되는 케이스.
  let betaOnly: Candidate | null = null;
  for (const row of betaRows ?? []) {
    const code = row.stock_code as string;
    const indutyGroup = industryByCode.get(code) ?? null;
    if (indutyGroup && averagePerByGroup.has(indutyGroup)) continue; // bothAvailable 케이스는 제외
    betaOnly = { stockCode: code, beta: Number(row.beta), indutyGroup, groupMedianPer: null, peerCount: 0 };
    break;
  }

  // 베타가 null인(상장 3년 미만 등) 후보종목 하나 — RIM 산출 불가 케이스.
  const { data: nullBetaRows, error: nullBetaError } = await supabaseAdmin
    .from("stock_beta")
    .select("stock_code, beta")
    .is("beta", null)
    .limit(1);
  if (nullBetaError) throw new Error(`stock_beta(null) 조회 실패: ${nullBetaError.message}`);
  const neitherAvailable = nullBetaRows && nullBetaRows.length > 0 ? { stockCode: nullBetaRows[0].stock_code as string, beta: null, indutyGroup: null, groupMedianPer: null, peerCount: 0 } : null;

  console.log("\n선정 결과:");
  console.log("  베타+업종PER 둘 다 산출:", bothAvailable);
  console.log("  베타만 산출(업종PER 없음):", betaOnly);
  console.log("  베타 산출 불가(상장3년미만 등):", neitherAvailable);

  return { bothAvailable, betaOnly, neitherAvailable };
}

/** app/api/stock/[code]/valuation/route.ts의 GET 핸들러 로직을 그대로 재현한다. */
async function verifyValuation(stockCode: string, label: string): Promise<void> {
  console.log(`\n########## ${label}: ${stockCode} ##########\n`);

  const [price, profitRatioYears, dividendRecords] = await Promise.all([
    getStockPrice(stockCode),
    getProfitRatioYears(stockCode),
    getDividendRecords(stockCode, 5),
  ]);
  const latestRoePct = profitRatioYears[0]?.roePct ?? null;

  console.log("PER/PBR/EPS/BPS/현재가:", {
    currentPrice: price.currentPrice,
    per: price.per,
    pbr: price.pbr,
    eps: price.eps,
    bps: price.bps,
  });
  console.log("최근 ROE(%):", latestRoePct);

  const totalsByYear = new Map<number, number>();
  for (const r of dividendRecords) {
    const year = Number(r.recordDate.slice(0, 4));
    totalsByYear.set(year, (totalsByYear.get(year) ?? 0) + r.cashDividendPerShare);
  }
  const today = yyyymmddDaysAgo(0);
  const completedYear = Number(todayKstIsoDate().slice(0, 4)) - 1;
  const completedYearDividendTotal = totalsByYear.get(completedYear) ?? 0;
  const payoutRatio = price.eps !== null && price.eps > 0 ? Math.min(1, Math.max(0, completedYearDividendTotal / price.eps)) : 0;
  console.log(`배당성향(${completedYear}년 배당합계 ${completedYearDividendTotal} / EPS ${price.eps}):`, payoutRatio);

  let rim;
  try {
    const [betaRow, riskFreeSeries] = await Promise.all([
      getStockBeta(stockCode),
      getEcosSeries("817Y002", "010210000", yyyymmddDaysAgo(ECOS_RISK_FREE_LOOKBACK_DAYS), today),
    ]);
    const riskFreeRatePct = riskFreeSeries.length > 0 ? riskFreeSeries[riskFreeSeries.length - 1].value : null;
    console.log("베타:", betaRow?.beta ?? null, "/ 무위험이자율(국고채10년,%):", riskFreeRatePct);
    if (betaRow?.beta !== null && betaRow?.beta !== undefined && riskFreeRatePct !== null) {
      console.log("요구수익률(CAPM,%) =", computeRequiredReturnPct(riskFreeRatePct, betaRow.beta));
    }

    rim = computeRimFairValue({
      currentPrice: price.currentPrice,
      currentBps: price.bps,
      latestRoePct,
      beta: betaRow?.beta ?? null,
      riskFreeRatePct,
      payoutRatio,
    });
  } catch (error) {
    console.error(`RIM 계산 실패: ${error instanceof Error ? error.message : String(error)}`);
    rim = { method: "RIM", fairPrice: null, gapPercent: null, verdict: "UNKNOWN", reason: "일시적 오류로 산출 실패" };
  }
  console.log("rim:", JSON.stringify(rim));

  let peerPer;
  try {
    const industryRow = await getStockIndustry(stockCode);
    const indutyGroup = industryRow?.indutyGroup ?? null;
    const averagePerRow = indutyGroup ? await getIndustryAveragePer(indutyGroup) : null;
    console.log("업종그룹:", indutyGroup, "/ 업종 PER 중앙값:", averagePerRow?.medianPer ?? null, "/ 표본수:", averagePerRow?.peerCount ?? 0);

    peerPer = computePeerPerFairValue({
      currentPrice: price.currentPrice,
      eps: price.eps,
      indutyGroup,
      groupMedianPer: averagePerRow?.medianPer ?? null,
      peerCount: averagePerRow?.peerCount ?? 0,
    });
  } catch (error) {
    console.error(`업종 평균 PER 계산 실패: ${error instanceof Error ? error.message : String(error)}`);
    peerPer = { method: "PEER_PER", fairPrice: null, gapPercent: null, verdict: "UNKNOWN", reason: "일시적 오류로 산출 실패" };
  }
  console.log("peerPer:", JSON.stringify(peerPer));

  console.log("\n(참고) 나머지 응답 필드 정상 여부 — PER/PBR/배당수익률이 rim/peerPer 실패와 무관하게 채워지는지:");
  console.log({
    marketCapEok: price.marketCapEok,
    sharesOutstanding: price.sharesOutstanding,
    week52High: price.week52High,
    week52Low: price.week52Low,
    dividendsYears: Array.from(totalsByYear.keys()),
  });
}

async function main(): Promise<void> {
  const { bothAvailable, betaOnly, neitherAvailable } = await pickCandidates();

  if (bothAvailable) {
    await verifyValuation(bothAvailable.stockCode, "케이스1: 베타+업종PER 둘 다 산출된 종목");
  } else {
    console.log("\n케이스1 스킵: 베타+업종PER 둘 다 산출된 종목을 찾지 못함");
  }

  if (betaOnly) {
    await verifyValuation(betaOnly.stockCode, "케이스2: 베타만 산출(업종PER 없음/부족)된 종목");
  } else {
    console.log("\n케이스2 스킵: 해당 종목을 찾지 못함");
  }

  if (neitherAvailable) {
    await verifyValuation(neitherAvailable.stockCode, "케이스3: 베타 산출 불가(상장3년미만 등) 종목");
  } else {
    console.log("\n케이스3 스킵: beta is null인 종목을 찾지 못함");
  }

  console.log("\n=== 검증 종료 ===");
}

main().catch((error) => {
  console.error("검증 스크립트 실행 중 오류:", error);
  process.exit(1);
});

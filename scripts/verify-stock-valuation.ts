/**
 * 관심종목 적정주가(RIM 잔여이익모델 + 방법A 업종 평균 PER + DCF 현금흐름할인법)
 * 실데이터 검증용 디스포저블 스크립트. app/api/stock/[code]/valuation/route.ts의
 * GET 핸들러가 하는 계산을 그대로 재현해(동일 lib 함수 호출) 실제 응답에 들어갈
 * rim/peerPer/dcf 필드가 기대한 구조·범위인지 확인한다.
 *
 * requireApproved(로그인 세션) 검증은 이 스크립트에서 건너뛴다 — GitHub Actions에는
 * 브라우저 세션이 없고, 이 검증의 목적은 새로 추가된 RIM/방법A/DCF 계산 로직 자체의
 * 실데이터 검증이라 인증 레이어(기존 코드, 이번 PR과 무관)는 대상이 아니다.
 *
 * 확인 순서:
 * 1. stock_beta에서 beta가 산출된 종목, stock_industry_classification에서 업종
 *    분류가 있는 종목을 조회해 테스트 대상을 정한다(베타+업종 PER 둘 다 있는 종목,
 *    베타가 없는 종목, 업종 분류가 없는 종목).
 * 2. 각 대상 종목에 대해 라우트와 동일한 순서로 KIS/ECOS/DB 데이터를 모아 rim,
 *    peerPer를 계산하고, 중간값(BPS, ROE, 베타, 무위험이자율, 요구수익률)까지
 *    전부 출력한다 — 수동 검산에 쓴다.
 * 3. (2단계 추가) dart_cashflow_statements/dart_debt_structure를 조회해 DCF 산출
 *    가능/불가 케이스별 종목을 찾고, route.ts와 동일한 순서로 DCF를 계산해 FCF
 *    5개년/CAGR/WACC 분해/영구성장률 스프레드/최종 fairPrice까지 출력한다.
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
import { computeRimFairValue, computeRoeFadePath, computeBpsRollForward } from "@/lib/rimValuation";
import { computeRequiredReturnPct } from "@/lib/capm";
import { RIM_MARKET_RISK_PREMIUM_PCT, RIM_PROJECTION_YEARS } from "@/lib/rimConfig";
import { getStockIndustry } from "@/lib/industryClassificationStorage";
import { getIndustryPerSamples } from "@/lib/industryPerSamplesStorage";
import { computePeerPerFairValue } from "@/lib/peerPerValuation";
import { getCashflowStatements, getDebtStructure } from "@/lib/dartCashflowDebtStorage";
import {
  computeDcfFairValue,
  computeFcfSeries,
  computeFcfGrowthRatePct,
  computeTotalInterestBearingDebtWon,
  computeCostOfDebtPct,
  computeWaccPct,
} from "@/lib/dcfValuation";
import { DCF_TERMINAL_GROWTH_RATE_PCT, DCF_WACC_TERMINAL_GROWTH_MIN_SPREAD_PCT, DCF_CORPORATE_TAX_RATE_PCT } from "@/lib/dcfConfig";
import { DART_VALUATION_FISCAL_YEARS } from "@/lib/dartValuationConfig";

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
  peerCountExcludingSelf: number;
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

  // 업종그룹별 유효 PER 표본 수(leave-one-out 계산 시 "자기 제외"하고도
  // INDUSTRY_PEER_MIN_GROUP_SIZE 이상 남는지 판단용).
  const { data: perRows, error: perError } = await supabaseAdmin.from("stock_industry_per").select("stock_code, induty_group, per").not("per", "is", null);
  if (perError) throw new Error(`stock_industry_per 조회 실패: ${perError.message}`);
  const validPerCountByGroup = new Map<string, number>();
  for (const r of perRows ?? []) {
    const group = r.induty_group as string;
    validPerCountByGroup.set(group, (validPerCountByGroup.get(group) ?? 0) + 1);
  }
  // "자기 제외" 표본 수 = 그룹 전체 유효 표본 수 - (자기 자신이 유효 PER을 가졌으면 1).
  const validPerCodesByGroup = new Map<string, Set<string>>();
  for (const r of perRows ?? []) {
    const group = r.induty_group as string;
    const set = validPerCodesByGroup.get(group) ?? new Set<string>();
    set.add(r.stock_code as string);
    validPerCodesByGroup.set(group, set);
  }
  function peerCountExcludingSelf(code: string, group: string): number {
    const total = validPerCountByGroup.get(group) ?? 0;
    const selfHasValidPer = validPerCodesByGroup.get(group)?.has(code) ?? false;
    return selfHasValidPer ? total - 1 : total;
  }

  let bothAvailable: Candidate | null = null;
  for (const row of betaRows ?? []) {
    const code = row.stock_code as string;
    const indutyGroup = industryByCode.get(code) ?? null;
    if (!indutyGroup) continue;
    const count = peerCountExcludingSelf(code, indutyGroup);
    if (count < 1) continue; // 최소 표본 기준은 pickCandidates 밖(computePeerPerFairValue)에서 다시 확인되므로, 여기선 "표본이 존재하는지"만 거른다.
    bothAvailable = { stockCode: code, beta: Number(row.beta), indutyGroup, peerCountExcludingSelf: count };
    break;
  }

  // 베타는 있지만 업종 분류가 없는(혹은 업종 PER 미산출) 종목 — RIM은 되고 방법A는
  // 안 되는 케이스.
  let betaOnly: Candidate | null = null;
  for (const row of betaRows ?? []) {
    const code = row.stock_code as string;
    const indutyGroup = industryByCode.get(code) ?? null;
    if (indutyGroup && peerCountExcludingSelf(code, indutyGroup) >= 1) continue; // bothAvailable 케이스는 제외
    betaOnly = { stockCode: code, beta: Number(row.beta), indutyGroup, peerCountExcludingSelf: 0 };
    break;
  }

  // 베타가 null인(상장 3년 미만 등) 후보종목 하나 — RIM 산출 불가 케이스.
  const { data: nullBetaRows, error: nullBetaError } = await supabaseAdmin
    .from("stock_beta")
    .select("stock_code, beta")
    .is("beta", null)
    .limit(1);
  if (nullBetaError) throw new Error(`stock_beta(null) 조회 실패: ${nullBetaError.message}`);
  const neitherAvailable = nullBetaRows && nullBetaRows.length > 0 ? { stockCode: nullBetaRows[0].stock_code as string, beta: null, indutyGroup: null, peerCountExcludingSelf: 0 } : null;

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

  let betaRow: Awaited<ReturnType<typeof getStockBeta>> = null;
  let riskFreeRatePct: number | null = null;
  let requiredReturnPct: number | null = null;
  try {
    const [b, riskFreeSeries] = await Promise.all([
      getStockBeta(stockCode),
      getEcosSeries("817Y002", "010210000", yyyymmddDaysAgo(ECOS_RISK_FREE_LOOKBACK_DAYS), today),
    ]);
    betaRow = b;
    riskFreeRatePct = riskFreeSeries.length > 0 ? riskFreeSeries[riskFreeSeries.length - 1].value : null;
    console.log("베타:", betaRow?.beta ?? null, "/ 무위험이자율(국고채10년,%):", riskFreeRatePct);
    if (betaRow?.beta != null && riskFreeRatePct !== null) {
      requiredReturnPct = computeRequiredReturnPct(riskFreeRatePct, betaRow.beta);
      console.log("요구수익률(CAPM,%) =", requiredReturnPct);
    }
  } catch (error) {
    console.error(`베타/무위험이자율 조회 실패: ${error instanceof Error ? error.message : String(error)}`);
  }

  let rim;
  try {
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
    const groupSamples = indutyGroup ? await getIndustryPerSamples(indutyGroup) : [];
    console.log("업종그룹:", indutyGroup, "/ 표본(자기포함):", groupSamples.length, "/ 유효PER(자기제외):", groupSamples.filter((s) => s.stockCode !== stockCode && s.per !== null).length);

    peerPer = computePeerPerFairValue({
      currentPrice: price.currentPrice,
      eps: price.eps,
      stockCode,
      indutyGroup,
      groupSamples,
    });
  } catch (error) {
    console.error(`업종 평균 PER 계산 실패: ${error instanceof Error ? error.message : String(error)}`);
    peerPer = { method: "PEER_PER", fairPrice: null, gapPercent: null, verdict: "UNKNOWN", reason: "일시적 오류로 산출 실패" };
  }
  console.log("peerPer:", JSON.stringify(peerPer));

  let dcf;
  try {
    const [cashflowRows, debtRows] = await Promise.all([getCashflowStatements(stockCode), getDebtStructure(stockCode)]);
    console.log(`dart_cashflow_statements 행수: ${cashflowRows.length}, dart_debt_structure 행수: ${debtRows.length}`);
    dcf = computeDcfFairValue({
      currentPrice: price.currentPrice,
      sharesOutstanding: price.sharesOutstanding,
      marketCapEok: price.marketCapEok,
      cashflowRows,
      debtRows,
      beta: betaRow?.beta ?? null,
      riskFreeRatePct,
      requiredReturnPct,
    });
  } catch (error) {
    console.error(`DCF 계산 실패: ${error instanceof Error ? error.message : String(error)}`);
    dcf = { method: "DCF", fairPrice: null, gapPercent: null, verdict: "UNKNOWN", reason: "일시적 오류로 산출 실패" };
  }
  console.log("dcf:", JSON.stringify(dcf));

  console.log("\n(참고) 나머지 응답 필드 정상 여부 — PER/PBR/배당수익률이 rim/peerPer/dcf 실패와 무관하게 채워지는지:");
  console.log({
    marketCapEok: price.marketCapEok,
    sharesOutstanding: price.sharesOutstanding,
    week52High: price.week52High,
    week52Low: price.week52Low,
    dividendsYears: Array.from(totalsByYear.keys()),
  });
}

/** 사용자가 삼성전자(005930) RIM 결과가 이상해 보인다고 제기한 건 확인용 심층
 * 진단. ROE fade 경로/BPS 롤포워드 경로를 연도별로 전부 출력하고, 요구수익률이
 * 최근 ROE보다 높으면(잔여이익 합이 음수가 나는 게 설계상 당연한 경우) 그 사실을
 * 명시한다. 방법A는 삼성전자의 업종그룹 내 시총 비중(자기 자신이 중앙값을 사실상
 * 좌우하는지)도 함께 확인한다. */
async function diagnoseSamsung(): Promise<void> {
  const stockCode = "005930";
  console.log(`\n########## 심층 진단: ${stockCode}(삼성전자) ##########\n`);

  const [price, profitRatioYears, betaRow, riskFreeSeries] = await Promise.all([
    getStockPrice(stockCode),
    getProfitRatioYears(stockCode),
    getStockBeta(stockCode),
    getEcosSeries("817Y002", "010210000", yyyymmddDaysAgo(ECOS_RISK_FREE_LOOKBACK_DAYS), yyyymmddDaysAgo(0)),
  ]);
  const latestRoePct = profitRatioYears[0]?.roePct ?? null;
  const riskFreeRatePct = riskFreeSeries.length > 0 ? riskFreeSeries[riskFreeSeries.length - 1].value : null;

  console.log("현재가:", price.currentPrice, "/ PBR:", price.pbr, "/ BPS(KIS):", price.bps, "/ EPS:", price.eps);
  console.log("최근 ROE(%):", latestRoePct);
  console.log("베타:", betaRow?.beta ?? null, "(data_points:", betaRow?.dataPoints ?? null, ", window:", betaRow?.windowStartDate, "~", betaRow?.windowEndDate, ")");
  console.log("무위험이자율(국고채10년,%, ECOS 최신값):", riskFreeRatePct, "/ raw series 마지막 5개:", JSON.stringify(riskFreeSeries.slice(-5)));
  console.log("시장위험프리미엄 상수(%):", RIM_MARKET_RISK_PREMIUM_PCT, "/ 예측기간(년):", RIM_PROJECTION_YEARS);

  // route.ts와 동일한 방식(완료된 달력연도 배당합계 / EPS)으로 배당성향을 한 번만
  // 계산해 아래 경로 출력과 최종 computeRimFairValue 호출에 동일하게 재사용한다.
  const dividendRecords = await getDividendRecords(stockCode, 5);
  const totalsByYear = new Map<number, number>();
  for (const r of dividendRecords) {
    const year = Number(r.recordDate.slice(0, 4));
    totalsByYear.set(year, (totalsByYear.get(year) ?? 0) + r.cashDividendPerShare);
  }
  const completedYear = Number(todayKstIsoDate().slice(0, 4)) - 1;
  const completedYearDividendTotal = totalsByYear.get(completedYear) ?? 0;
  const payoutRatio = price.eps !== null && price.eps > 0 ? Math.min(1, Math.max(0, completedYearDividendTotal / price.eps)) : 0;
  console.log(`배당성향(${completedYear}년 배당합계 ${completedYearDividendTotal} / EPS ${price.eps}):`, payoutRatio);

  let requiredReturnPct: number | null = null;
  if (betaRow?.beta != null && riskFreeRatePct !== null && latestRoePct !== null && price.bps !== null) {
    requiredReturnPct = computeRequiredReturnPct(riskFreeRatePct, betaRow.beta);
    console.log(`\n요구수익률 r = 무위험이자율(${riskFreeRatePct}) + 베타(${betaRow.beta}) × 시장위험프리미엄(${RIM_MARKET_RISK_PREMIUM_PCT}) = ${requiredReturnPct}%`);
    console.log(`최근 ROE(${latestRoePct}%) vs 요구수익률(${requiredReturnPct}%): ${latestRoePct < requiredReturnPct ? "ROE < r → 5년 페이드 경로 내내 초과이익이 음수(설계상 fairPrice가 BPS보다 낮게 나올 수 있음)" : "ROE > r → 초과이익이 양수"}`);

    const roeFadePath = computeRoeFadePath(latestRoePct, requiredReturnPct);
    console.log("\nROE fade 경로(연도별, %):", roeFadePath.map((v, i) => `t=${i + 1}: ${v.toFixed(4)}`).join(", "));

    const bpsPath = computeBpsRollForward(price.bps, roeFadePath, payoutRatio);
    console.log("BPS 롤포워드 경로(연도별):", bpsPath.map((v, i) => `t=${i + 1}: ${v.toFixed(2)}`).join(", "));

    let presentValueSum = 0;
    console.log("\n연도별 잔여이익 현재가치:");
    for (let i = 0; i < roeFadePath.length; i++) {
      const t = i + 1;
      const prevBps = i === 0 ? price.bps : bpsPath[i - 1];
      const residualIncome = (roeFadePath[i] / 100 - requiredReturnPct / 100) * prevBps;
      const pv = residualIncome / Math.pow(1 + requiredReturnPct / 100, t);
      presentValueSum += pv;
      console.log(
        `  t=${t}: (ROE_t ${roeFadePath[i].toFixed(4)}% - r ${requiredReturnPct.toFixed(4)}%) × BPS_(t-1) ${prevBps.toFixed(2)} = ${residualIncome.toFixed(2)}, 현재가치 = ${pv.toFixed(2)}`
      );
    }
    console.log(`잔여이익 현재가치 합계: ${presentValueSum.toFixed(2)} (BPS ${price.bps} + 합계 = 적정주가)`);
  } else {
    console.log("베타/무위험이자율/ROE/BPS 중 하나 이상이 없어 상세 경로를 계산할 수 없음.");
  }

  const rim = computeRimFairValue({
    currentPrice: price.currentPrice,
    currentBps: price.bps,
    latestRoePct,
    beta: betaRow?.beta ?? null,
    riskFreeRatePct,
    payoutRatio,
  });
  console.log("\nrim (route.ts와 동일 함수 재호출):", JSON.stringify(rim));
  console.log(
    "\n[회귀 확인용] 이번 PR(DCF 2단계)이 route.ts의 베타/무위험이자율 조회 로직을 리팩터했으므로, 위 베타/무위험이자율/요구수익률/rim 값이 RIM 검증(1단계) 때 확인한 값과 동일한지 팀장/사용자가 대조해야 한다."
  );

  // 방법A: 삼성전자 업종그룹 내 시총 비중 확인 — leave-one-out(자기 제외) 중앙값이
  // 그룹 전체(자기 포함) 중앙값과 실제로 달라지는지, 시총 비중이 압도적인지 확인.
  const industryRow = await getStockIndustry(stockCode);
  console.log("\n업종그룹:", industryRow?.indutyGroup ?? null);
  if (industryRow?.indutyGroup) {
    const groupSamples = await getIndustryPerSamples(industryRow.indutyGroup);
    const allValidPers = groupSamples.map((s) => s.per).filter((per): per is number => per !== null && per > 0);
    const selfExcludedPers = groupSamples.filter((s) => s.stockCode !== stockCode).map((s) => s.per).filter((per): per is number => per !== null && per > 0);
    const medianOf = (values: number[]): number | null => {
      if (values.length === 0) return null;
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    };
    console.log(
      `업종 PER 중앙값 — 자기 포함(구설계, 참고용): ${medianOf(allValidPers)} (표본 ${allValidPers.length}) / 자기 제외(leave-one-out, 실제 적용): ${medianOf(selfExcludedPers)} (표본 ${selfExcludedPers.length})`
    );
    const peerPerLeaveOneOut = computePeerPerFairValue({
      currentPrice: price.currentPrice,
      eps: price.eps,
      stockCode,
      indutyGroup: industryRow.indutyGroup,
      groupSamples,
    });
    console.log("peerPer (leave-one-out 적용, route.ts와 동일 함수 재호출):", JSON.stringify(peerPerLeaveOneOut));

    const memberCodes = groupSamples.map((s) => s.stockCode);
    console.log(`업종그룹 '${industryRow.indutyGroup}' 소속 종목 수(분류상): ${memberCodes.length}개`);

    const marketCaps: { code: string; marketCapEok: number; per: number | null }[] = [];
    for (const code of memberCodes) {
      try {
        const p = await getStockPrice(code);
        marketCaps.push({ code, marketCapEok: p.marketCapEok, per: p.per });
      } catch {
        // 개별 조회 실패는 건너뛴다(진단 목적, 전체 실패로 이어지지 않게).
      }
    }
    const totalMarketCap = marketCaps.reduce((sum, m) => sum + m.marketCapEok, 0);
    const samsung = marketCaps.find((m) => m.code === stockCode);
    console.log(
      `업종그룹 전체 시총(억원): ${totalMarketCap.toLocaleString()} / 삼성전자 시총(억원): ${samsung?.marketCapEok.toLocaleString() ?? "?"} / 삼성전자 비중: ${
        samsung && totalMarketCap > 0 ? ((samsung.marketCapEok / totalMarketCap) * 100).toFixed(1) + "%" : "?"
      }`
    );
    console.log("그룹 내 종목별 시총/PER:", JSON.stringify(marketCaps.sort((a, b) => b.marketCapEok - a.marketCapEok)));
  }

  // DCF 심층 진단: 삼성전자가 정상 산출 케이스로 적합한지(5개년 현금흐름/부채 데이터,
  // FCF 5개년 값·CAGR 캡 적용 여부, WACC 분해, 영구성장률 스프레드, 최종 fairPrice)를
  // 전부 단계별로 출력한다.
  console.log(`\n########## DCF 심층 진단: ${stockCode}(삼성전자) ##########\n`);
  const [cashflowRows, debtRows] = await Promise.all([getCashflowStatements(stockCode), getDebtStructure(stockCode)]);
  console.log("dart_cashflow_statements(fiscal_year 오름차순):", JSON.stringify(cashflowRows));
  console.log("dart_debt_structure(fiscal_year 오름차순):", JSON.stringify(debtRows));

  const fcfSeries = computeFcfSeries(cashflowRows);
  console.log(`\nFCF 5개년(영업CF - capex), ${fcfSeries.length}개년 확보:`, JSON.stringify(fcfSeries));
  if (fcfSeries.length >= 2) {
    const fcfValues = fcfSeries.map((r) => r.fcf);
    const rawFirst = fcfValues[0];
    const rawLast = fcfValues[fcfValues.length - 1];
    const rawCagrPct = rawFirst > 0 && rawLast > 0 ? (Math.pow(rawLast / rawFirst, 1 / (fcfValues.length - 1)) - 1) * 100 : null;
    const cappedGrowthRatePct = computeFcfGrowthRatePct(fcfValues);
    console.log(
      `첫해(${fcfSeries[0].fiscalYear}) FCF: ${rawFirst.toLocaleString()}원, 마지막해(${fcfSeries[fcfSeries.length - 1].fiscalYear}) FCF: ${rawLast.toLocaleString()}원`
    );
    console.log(`캡 적용 전 CAGR: ${rawCagrPct === null ? "계산 불가(첫해 또는 마지막해 FCF <= 0)" : rawCagrPct.toFixed(2) + "%"}`);
    console.log(`캡(±50%) 적용 후 성장률(computeFcfGrowthRatePct): ${cappedGrowthRatePct === null ? "null" : cappedGrowthRatePct.toFixed(2) + "%"}`);
    console.log(
      `캡 적용 여부: ${rawCagrPct !== null && cappedGrowthRatePct !== null && Math.abs(rawCagrPct - cappedGrowthRatePct) > 0.001 ? "적용됨(캡에 걸림)" : "미적용(캡 안에 있음)"}`
    );
    console.log(
      "중간 연도(2023년 등) FCF가 음수여도 첫해/마지막해가 양수면 CAGR 계산이 정상 진행되는지: 첫해/마지막해만 보고 계산하므로 중간 연도 부호와 무관함(설계상 의도)"
    );
  }

  if (betaRow?.beta != null && riskFreeRatePct !== null) {
    const costOfEquityPct = requiredReturnPct ?? computeRequiredReturnPct(riskFreeRatePct, betaRow.beta);
    const latestDebtRow = debtRows[debtRows.length - 1] ?? null;
    console.log("\n최근년도 부채구조 행:", JSON.stringify(latestDebtRow));
    if (latestDebtRow) {
      const totalDebtWon = computeTotalInterestBearingDebtWon(latestDebtRow);
      console.log(`총 이자부채(단기+장기+사채): ${totalDebtWon === null ? "null(세 필드 모두 null — 데이터 확인 불가)" : totalDebtWon.toLocaleString() + "원"}`);
      if (totalDebtWon !== null) {
        const costOfDebtPct = computeCostOfDebtPct(latestDebtRow.interestExpense, totalDebtWon);
        console.log(`타인자본비용(이자비용/총이자부채): ${costOfDebtPct === null ? "null(이자비용 데이터 없음)" : costOfDebtPct.toFixed(4) + "%"}`);
        if (costOfDebtPct !== null) {
          const marketCapWon = price.marketCapEok * 100_000_000;
          const waccPct = computeWaccPct(costOfEquityPct, costOfDebtPct, marketCapWon, totalDebtWon);
          const equityWeight = marketCapWon + totalDebtWon === 0 ? 1 : marketCapWon / (marketCapWon + totalDebtWon);
          const debtWeight = 1 - equityWeight;
          console.log(
            `WACC = 자기자본비중(${(equityWeight * 100).toFixed(2)}%) × 자기자본비용(${costOfEquityPct.toFixed(4)}%) + 타인자본비중(${(debtWeight * 100).toFixed(2)}%) × 세후타인자본비용(${(costOfDebtPct * (1 - DCF_CORPORATE_TAX_RATE_PCT / 100)).toFixed(4)}%) = ${waccPct.toFixed(4)}%`
          );
          console.log(`영구성장률: ${DCF_TERMINAL_GROWTH_RATE_PCT}%, WACC-영구성장률 스프레드: ${(waccPct - DCF_TERMINAL_GROWTH_RATE_PCT).toFixed(4)}%p (최소 요구: ${DCF_WACC_TERMINAL_GROWTH_MIN_SPREAD_PCT}%p)`);
          console.log(`WACC이 상식적 범위(5~15%)인지: ${waccPct >= 5 && waccPct <= 15 ? "예" : "아니오 — 확인 필요"}`);
        }
      }
    }
  }

  const dcf = computeDcfFairValue({
    currentPrice: price.currentPrice,
    sharesOutstanding: price.sharesOutstanding,
    marketCapEok: price.marketCapEok,
    cashflowRows,
    debtRows,
    beta: betaRow?.beta ?? null,
    riskFreeRatePct,
    requiredReturnPct,
  });
  console.log("\ndcf (route.ts와 동일 함수 재호출):", JSON.stringify(dcf));
  if (dcf.fairPrice !== null) {
    console.log(
      `fairPrice(${dcf.fairPrice.toFixed(0)}원)가 현재가(${price.currentPrice.toLocaleString()}원) 대비 상식적 범위인지(음수 아님, 수백 배 아님): ${
        dcf.fairPrice > 0 && dcf.fairPrice < price.currentPrice * 100 ? "예" : "아니오 — 확인 필요"
      }`
    );
  }
  console.log(`reason에 현금성자산 caveat 포함 여부(성공 케이스에서도): ${dcf.reason.includes("현금성자산") ? "포함됨" : "미포함"}`);
}

/** dart_cashflow_statements/dart_debt_structure를 스캔해 DCF 산출 불가 케이스별
 * 대상 종목을 찾는다. 페이지네이션으로 전체를 가져온 뒤 종목코드별로 그룹핑한다. */
async function fetchAllRows<T extends { stock_code: string }>(table: string, columns: string): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await supabaseAdmin.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} 조회 실패: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as unknown as T[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function pickDcfCandidates(): Promise<{
  insufficientYears: string | null;
  noInterestExpense: string | null;
}> {
  console.log("\n########## DCF 케이스별 대상 종목 조회 ##########\n");

  interface CfRow {
    stock_code: string;
    fiscal_year: number;
    operating_cf: number | string | null;
    capex: number | string | null;
  }
  interface DebtRow {
    stock_code: string;
    fiscal_year: number;
    short_term_debt: number | string | null;
    long_term_debt: number | string | null;
    bonds_payable: number | string | null;
    interest_expense: number | string | null;
  }

  const cfRows = await fetchAllRows<CfRow>("dart_cashflow_statements", "stock_code, fiscal_year, operating_cf, capex");
  const debtRows = await fetchAllRows<DebtRow>("dart_debt_structure", "stock_code, fiscal_year, short_term_debt, long_term_debt, bonds_payable, interest_expense");

  const cfYearsByStock = new Map<string, number>();
  for (const r of cfRows) {
    cfYearsByStock.set(r.stock_code, (cfYearsByStock.get(r.stock_code) ?? 0) + 1);
  }

  const debtByStock = new Map<string, DebtRow[]>();
  for (const r of debtRows) {
    const arr = debtByStock.get(r.stock_code) ?? [];
    arr.push(r);
    debtByStock.set(r.stock_code, arr);
  }

  // 케이스: 현금흐름 데이터가 1~4개년만 있는 종목("5개년 미만").
  let insufficientYears: string | null = null;
  for (const [code, years] of cfYearsByStock) {
    if (years >= 1 && years < DART_VALUATION_FISCAL_YEARS) {
      insufficientYears = code;
      break;
    }
  }
  console.log(`5개년 미만 현금흐름 데이터 종목: ${insufficientYears ?? "찾지 못함"}${insufficientYears ? ` (보유 ${cfYearsByStock.get(insufficientYears)}개년)` : ""}`);

  // 케이스: 현금흐름 5개년 이상 확보 + 최근년도 부채는 있는데(총 이자부채 > 0)
  // 이자비용이 null인 종목.
  let noInterestExpense: string | null = null;
  for (const [code, years] of cfYearsByStock) {
    if (years < DART_VALUATION_FISCAL_YEARS) continue;
    const debts = (debtByStock.get(code) ?? []).sort((a, b) => a.fiscal_year - b.fiscal_year);
    const latest = debts[debts.length - 1];
    if (!latest) continue;
    const shortTerm = latest.short_term_debt === null ? 0 : Number(latest.short_term_debt);
    const longTerm = latest.long_term_debt === null ? 0 : Number(latest.long_term_debt);
    const bonds = latest.bonds_payable === null ? 0 : Number(latest.bonds_payable);
    const totalDebt = shortTerm + longTerm + bonds;
    const hasAnyDebtField = latest.short_term_debt !== null || latest.long_term_debt !== null || latest.bonds_payable !== null;
    if (hasAnyDebtField && totalDebt > 0 && latest.interest_expense === null) {
      noInterestExpense = code;
      break;
    }
  }
  console.log(`이자비용 데이터 없음(부채>0, 5개년 현금흐름 확보) 종목: ${noInterestExpense ?? "찾지 못함"}`);

  return { insufficientYears, noInterestExpense };
}

async function main(): Promise<void> {
  await diagnoseSamsung();

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
    await verifyValuation(neitherAvailable.stockCode, "케이스3: 베타 산출 불가(상장3년미만 등) 종목 — DCF도 동일하게 '베타 산출 불가'로 산출 불가여야 함");
  } else {
    console.log("\n케이스3 스킵: beta is null인 종목을 찾지 못함");
  }

  const { insufficientYears, noInterestExpense } = await pickDcfCandidates();

  if (insufficientYears) {
    await verifyValuation(insufficientYears, "케이스4(DCF): 과거 현금흐름 5개년 미만 종목 — DCF는 '과거 현금흐름 데이터 5개년 미만'으로 산출 불가여야 함");
  } else {
    console.log("\n케이스4 스킵: 5개년 미만 현금흐름 데이터 종목을 찾지 못함");
  }

  if (noInterestExpense) {
    await verifyValuation(noInterestExpense, "케이스5(DCF): 부채는 있는데 이자비용 데이터가 없는 종목 — DCF는 '이자비용 데이터 없음'으로 산출 불가여야 함");
  } else {
    console.log("\n케이스5 스킵: 해당 조건(부채>0, 이자비용 null, 5개년 현금흐름 확보) 종목을 찾지 못함");
  }

  console.log("\n=== 검증 종료 ===");
}

main().catch((error) => {
  console.error("검증 스크립트 실행 중 오류:", error);
  process.exit(1);
});

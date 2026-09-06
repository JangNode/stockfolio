/**
 * 사용자 요청: "급등주 찾기"(reversal_breakout) 전략을 2011~2026년 과거 시세로
 * 백테스트하기 전, (1) 실제 라이브 매매에서 매수됐던 종목들이 stock_daily_prices
 * (hot 2년 테이블 + Storage Parquet 과거분) 백필 후보군(시총 5천억 이상)에
 * 포함돼 있는지, (2) 그 백필 데이터로 reversal_breakout 로직을 그대로 재현할 수
 * 있는지(시가/거래량 필드 존재 여부)를 먼저 확인한다. 코드/스키마 변경 없음 — 읽기
 * 전용 1회성 확인 스크립트, 확인 후 삭제 예정.
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-reversal-breakout-data-coverage.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { findByExactName } from "@/lib/stockMaster";
import { getDailyPriceSeries } from "@/lib/stockDailyPricesStorage";

const TARGET_STOCK_NAMES = ["에스트래픽", "삼화왕관", "HDC랩스", "애경산업", "종근당", "한국비엔씨"];

const START_DATE = "2011-01-01";
const TODAY = new Date().toISOString().slice(0, 10);

async function reportStockCoverage(name: string): Promise<void> {
  console.log(`\n--- ${name} ---`);
  const entry = await findByExactName(name);
  if (!entry) {
    console.log(`  종목마스터(KIS)에서 이름 매칭 실패 — 상장폐지/이름 변경 가능성 확인 필요`);
    return;
  }
  console.log(`  종목코드: ${entry.code} (시장: ${entry.market})`);

  const series = await getDailyPriceSeries(entry.code, START_DATE, TODAY);
  console.log(`  stock_daily_prices(hot+Storage) 보유 행 수: ${series.length}`);
  if (series.length === 0) {
    console.log(`  결론: 백필 후보군에 전혀 포함 안 됨(시총 5천억 미만이었거나 데이터 공백)`);
    return;
  }
  console.log(`  보유 기간: ${series[0].tradeDate} ~ ${series[series.length - 1].tradeDate}`);

  // 연도별로 실제 존재하는 연도만 나열해, 중간에 비는 연도(시총이 기준 밑으로
  // 내려간 구간)가 있는지 확인한다.
  const yearsWithData = new Set(series.map((r) => r.tradeDate.slice(0, 4)));
  const allYears: string[] = [];
  for (let y = 2011; y <= new Date().getFullYear(); y++) allYears.push(String(y));
  const missingYears = allYears.filter((y) => !yearsWithData.has(y));
  console.log(`  데이터 있는 연도: ${Array.from(yearsWithData).sort().join(", ")}`);
  if (missingYears.length > 0) {
    console.log(`  데이터 없는 연도(범위 내): ${missingYears.join(", ")}`);
  }

  const sample = series[Math.floor(series.length / 2)];
  console.log(`  샘플 행(중간 지점) 필드: ${JSON.stringify(sample)}`);
}

async function reportSchemaGap(): Promise<void> {
  console.log(`\n########## 아키텍처 확인: reversal_breakout 재현에 필요한 필드(시가/거래량) 존재 여부 ##########`);
  console.log(`  reversal_breakout 판정(lib/reversalBreakout.ts)은 종가·시가(양봉 판정)·거래량(매집봉 배수)을 쓴다.`);
  console.log(`  stock_daily_prices_recent/Storage Parquet 스키마(마이그레이션 20260828000000/20260827050000):`);
  console.log(`    stock_code, trade_date, close_price, market_cap_eok, listed_shares — 시가(open)/거래량(volume) 컬럼 없음.`);

  const { data, error } = await supabaseAdmin
    .from("stock_daily_prices_recent")
    .select("*")
    .limit(1);
  if (error) {
    console.log(`  실측 조회 실패: ${error.message}`);
    return;
  }
  console.log(`  실측(stock_daily_prices_recent 샘플 1행) 컬럼: ${data && data[0] ? Object.keys(data[0]).join(", ") : "(데이터 없음)"}`);
  console.log(`  → open/volume 컬럼이 실제로 없으면, 이 데이터만으로는 reversal_breakout의 매집봉(거래량 배수+양봉) 조건을 계산할 수 없음.`);
}

async function main(): Promise<void> {
  console.log("########## 1. 실제 매수됐던 종목의 백필 후보군 포함 여부 ##########");
  for (const name of TARGET_STOCK_NAMES) {
    await reportStockCoverage(name);
  }

  await reportSchemaGap();

  console.log("\n=== 확인 종료 ===");
}

main().catch((error) => {
  console.error("확인 스크립트 실행 중 오류:", error);
  process.exit(1);
});

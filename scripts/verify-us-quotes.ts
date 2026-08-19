/**
 * [검증용 임시 스크립트] 실제 KIS 계정으로 미국주식 API 응답을 몇 개 종목만 호출해
 * 필드 파싱이 맞는지 확인한다. DB는 전혀 건드리지 않는다(screening_results/strategies
 * 조회·기록 없음) — 순수하게 lib/kis.ts, lib/stockMasterOverseas.ts의 파싱 결과를
 * 눈으로 확인하기 위한 용도다.
 *
 * 검증 끝나면 이 스크립트와 .github/workflows/verify-us-quotes.yml,
 * package.json의 verify:us-quotes 항목을 지운다(이전 rate-limit 검증 스크립트와
 * 동일한 절차).
 *
 *   tsx --conditions=react-server scripts/verify-us-quotes.ts
 *
 * 필요 환경변수: KIS_APP_KEY, KIS_APP_SECRET, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * (KIS 토큰 캐시가 kis_tokens 테이블을 쓰므로 Supabase 접속 정보는 필요하다 — DB에
 * 쓰는 데이터는 그 토큰 캐시뿐이고 screening_results 등 실제 스크리닝 데이터는 안 건드린다.)
 */

import {
  getOverseasStockPrice,
  getOverseasPriceDetail,
  getOverseasDailyPrices,
  type OverseasExchangeCode,
} from "@/lib/kis";
import { getAllOverseasStocks } from "@/lib/stockMasterOverseas";

const CHECKS: { code: string; excd: OverseasExchangeCode; label: string }[] = [
  { code: "AAPL", excd: "NAS", label: "애플(나스닥)" },
  { code: "MSFT", excd: "NAS", label: "마이크로소프트(나스닥)" },
  { code: "JPM", excd: "NYS", label: "JP모건(뉴욕)" },
];

let failCount = 0;

function check(label: string, condition: boolean, detail: string): void {
  if (condition) {
    console.log(`  ✓ ${label}: ${detail}`);
  } else {
    failCount++;
    console.log(`  ✕ ${label}: ${detail}`);
  }
}

async function verifyMasterFile(): Promise<void> {
  console.log("=== 1. 종목마스터 파일 다운로드/파싱 ===");
  const stocks = await getAllOverseasStocks();
  const byExchange = { NAS: 0, NYS: 0, AMS: 0 };
  for (const s of stocks) byExchange[s.exchange]++;

  console.log(
    `  전체 ${stocks.length}개 (NAS ${byExchange.NAS}, NYS ${byExchange.NYS}, AMS ${byExchange.AMS})`
  );
  check("전체 종목 수", stocks.length > 1000, `${stocks.length}개 (1000개 이상 기대)`);
  check(
    "거래소별 종목 존재",
    byExchange.NAS > 0 && byExchange.NYS > 0,
    `NAS ${byExchange.NAS}개, NYS ${byExchange.NYS}개`
  );

  const aapl = stocks.find((s) => s.code === "AAPL" && s.exchange === "NAS");
  check("AAPL 마스터파일에 존재", !!aapl, aapl ? `${aapl.code} / ${aapl.name}` : "찾지 못함");
  if (aapl) {
    check(
      "AAPL 종목명에 Apple 포함",
      /apple/i.test(aapl.name),
      `실제 이름: "${aapl.name}"`
    );
  }
}

async function verifyPriceEndpoints(): Promise<void> {
  console.log("\n=== 2. 현재가/현재가상세/기간별시세 API ===");

  for (const { code, excd, label } of CHECKS) {
    console.log(`\n  --- ${label} (${excd}:${code}) ---`);

    try {
      const price = await getOverseasStockPrice(excd, code, "user");
      console.log(`  getOverseasStockPrice 원본:`, JSON.stringify(price));
      check(
        `${code} 현재가 양수`,
        price.currentPrice > 0,
        `currentPrice=${price.currentPrice}`
      );
      check(
        `${code} 전일종가 양수`,
        price.prevClose > 0,
        `prevClose=${price.prevClose}`
      );
      check(
        `${code} 등락률 상식적 범위(-50~50%)`,
        Math.abs(price.changeRate) < 50,
        `changeRate=${price.changeRate}`
      );
    } catch (error) {
      failCount++;
      console.log(`  ✕ getOverseasStockPrice 호출 실패: ${error instanceof Error ? error.message : error}`);
    }

    try {
      const detail = await getOverseasPriceDetail(excd, code, "user");
      console.log(`  getOverseasPriceDetail 원본:`, JSON.stringify(detail));
      check(
        `${code} 시가총액 최소 $10억 이상(대형주 전제)`,
        detail.marketCap > 1_000_000_000,
        `marketCap=${detail.marketCap} ${detail.currency}`
      );
      check(`${code} 통화 USD`, detail.currency === "USD", `currency="${detail.currency}"`);
      check(
        `${code} 52주 고가 ≥ 52주 저가`,
        detail.high52w >= detail.low52w,
        `high52w=${detail.high52w}, low52w=${detail.low52w}`
      );
    } catch (error) {
      failCount++;
      console.log(`  ✕ getOverseasPriceDetail 호출 실패: ${error instanceof Error ? error.message : error}`);
    }

    try {
      const daily = await getOverseasDailyPrices(excd, code, 10, "user");
      console.log(
        `  getOverseasDailyPrices(10건 요청) 원본:`,
        JSON.stringify(daily.slice(-3))
      );
      check(`${code} 일봉 데이터 수신`, daily.length > 0, `${daily.length}건`);
      if (daily.length > 0) {
        const last = daily[daily.length - 1];
        check(
          `${code} 마지막 봉 날짜 형식(YYYY-MM-DD)`,
          /^\d{4}-\d{2}-\d{2}$/.test(last.date),
          `date="${last.date}"`
        );
        check(
          `${code} 마지막 봉 고가 ≥ 저가`,
          last.high >= last.low,
          `high=${last.high}, low=${last.low}`
        );
        check(
          `${code} 일봉이 과거→최신 순 정렬`,
          daily.every((d, i) => i === 0 || d.date >= daily[i - 1].date),
          `첫 날짜=${daily[0].date}, 마지막 날짜=${last.date}`
        );
      }
    } catch (error) {
      failCount++;
      console.log(`  ✕ getOverseasDailyPrices 호출 실패: ${error instanceof Error ? error.message : error}`);
    }
  }
}

async function main(): Promise<void> {
  console.log("미국주식 API 응답 스팟체크 시작\n");

  await verifyMasterFile();
  await verifyPriceEndpoints();

  console.log(`\n=== 결과: ${failCount === 0 ? "전부 통과" : `${failCount}건 실패`} ===`);
  if (failCount > 0) process.exit(1);
}

main().catch((error) => {
  console.error("검증 스크립트 실행 중 오류:", error);
  process.exit(1);
});

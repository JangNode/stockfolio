/**
 * [디스포저블 검증 스크립트] 생존편향 백필 3단계 결과 검증 — 재백필된
 * Parquet에서 한진해운/STX조선해양/우경/신양오라컴의 거래정지 구간(가격 동결,
 * 거래량 0으로 실측 확인된 날짜)이 실제로 빠지고, 정상 거래 구간은 저장됐는지
 * 확인한다. DB/Storage 쓰기 없음(순수 조회).
 *
 * 필요 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/verify-delisted-stock-backfill.ts
 */

import { getDailyPrice } from "@/lib/stockDailyPricesStorage";

interface CheckPoint {
  date: string;
  label: string;
  expected: "present" | "absent";
}

interface SampleStock {
  code: string;
  name: string;
  checkpoints: CheckPoint[];
}

const SAMPLES: SampleStock[] = [
  {
    code: "117930",
    name: "한진해운",
    checkpoints: [
      { date: "2016-01-20", label: "정상 거래(정리매매 400일 전)", expected: "present" },
      { date: "2017-01-24", label: "정상 거래(정리매매 30일 전)", expected: "present" },
      { date: "2017-02-09", label: "거래정지(거래량 0으로 실측 확인)", expected: "absent" },
      { date: "2017-02-16", label: "거래정지(거래량 0으로 실측 확인)", expected: "absent" },
      { date: "2017-02-22", label: "거래정지(거래량 0으로 실측 확인)", expected: "absent" },
      { date: "2017-02-23", label: "정리매매 시작일(실거래 재개)", expected: "present" },
      { date: "2017-03-06", label: "정리매매 종료일(실거래)", expected: "present" },
    ],
  },
  {
    code: "067250",
    name: "STX조선해양",
    checkpoints: [
      { date: "2013-02-28", label: "정상 거래(정리매매 400일 전)", expected: "present" },
      { date: "2014-03-05", label: "거래정지(거래량 0으로 실측 확인)", expected: "absent" },
      { date: "2014-03-28", label: "거래정지(거래량 0으로 실측 확인)", expected: "absent" },
      { date: "2014-04-04", label: "정리매매 시작일(실거래 재개)", expected: "present" },
    ],
  },
  {
    code: "025920",
    name: "우경",
    checkpoints: [
      { date: "2012-05-25", label: "정상 거래(정리매매 400일 전)", expected: "present" },
      { date: "2013-05-31", label: "거래정지(거래량 0으로 실측 확인)", expected: "absent" },
      { date: "2013-07-01", label: "정리매매 시작일(실거래 재개)", expected: "present" },
    ],
  },
  {
    code: "086830",
    name: "신양오라컴",
    checkpoints: [
      { date: "2017-01-24", label: "정상 거래(정리매매 90일 전)", expected: "present" },
      { date: "2017-03-24", label: "거래정지(거래량 0으로 실측 확인)", expected: "absent" },
      { date: "2017-04-24", label: "정리매매 시작일(실거래 재개)", expected: "present" },
    ],
  },
];

async function main(): Promise<void> {
  let mismatches = 0;

  for (const stock of SAMPLES) {
    console.log(`\n=== ${stock.name}(${stock.code}) ===`);
    for (const cp of stock.checkpoints) {
      const row = await getDailyPrice(stock.code, cp.date);
      const actual = row ? "present" : "absent";
      const ok = actual === cp.expected;
      if (!ok) mismatches++;
      console.log(
        `  ${cp.date}[${cp.label}]: 기대=${cp.expected}, 실제=${actual}${row ? `(종가 ${row.closePrice}, 거래량 ${row.volume})` : ""} ${ok ? "✓" : "✕ 불일치"}`
      );
    }
  }

  console.log(`\n검증 완료 — 불일치 ${mismatches}건`);
  if (mismatches > 0) process.exit(1);
}

main().catch((error) => {
  console.error("검증 중 오류:", error);
  process.exit(1);
});

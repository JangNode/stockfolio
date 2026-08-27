/**
 * (임시) 배당 이력 버그 수정 검증 — output/output1 필드명 둘 다 읽도록 고친
 * getDividendRecords가 실제로 정상 동작하는지 005930 기준 확인한다. DB는 건드리지
 * 않는다 — 확인 후 삭제 예정.
 *
 *   tsx --conditions=react-server scripts/verify-valuation-005930.ts
 */

import { getDividendRecords } from "@/lib/kis";

async function main(): Promise<void> {
  console.log("=== getDividendRecords(005930, 5) 호출 (output/output1 둘 다 읽는 수정 후) ===");
  const records = await getDividendRecords("005930", 5);
  console.log(`받은 행 개수: ${records.length}`);
  console.log(JSON.stringify(records.slice(0, 5), null, 2));

  const oneYearAgo = new Date();
  oneYearAgo.setDate(oneYearAgo.getDate() - 365);
  const cutoff = `${oneYearAgo.getFullYear()}${String(oneYearAgo.getMonth() + 1).padStart(2, "0")}${String(oneYearAgo.getDate()).padStart(2, "0")}`;
  const lastYearCount = records.filter((r) => r.recordDate >= cutoff).length;
  console.log(`\n최근 365일(>= ${cutoff}) 배당 이벤트 수: ${lastYearCount}`);
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});

/**
 * (임시) 배당 이력이 빈 배열로 오는 버그 진단용 읽기 전용 스크립트 — 005930(삼성전자)
 * 기준. 실제 배포된 코드가 쓰는 lib/kis.ts의 getDividendRecords를 그대로 호출해
 * 무엇이 오는지 확인한다(수기로 다시 구현한 별도 fetch가 아니라 진짜 함수를 그대로
 * 씀). DB/코드는 건드리지 않는다 — 확인 후 삭제 예정.
 *
 *   tsx --conditions=react-server scripts/verify-valuation-005930.ts
 */

import { getDividendRecords } from "@/lib/kis";

async function main(): Promise<void> {
  console.log("=== getDividendRecords(005930, 5) 호출 ===");
  try {
    const records = await getDividendRecords("005930", 5);
    console.log(`받은 행 개수: ${records.length}`);
    console.log(JSON.stringify(records, null, 2));
  } catch (error) {
    console.error("오류 발생:", error);
  }
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});

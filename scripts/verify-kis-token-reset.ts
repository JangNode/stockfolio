/**
 * (1회성 검증) kis_tokens 강제 초기화(마이그레이션) 이후, 실제 KIS 호출이
 * "기간이 만료된 token입니다"(EGW00123) 없이 정상 동작하는지 확인한다.
 * 검증 후 삭제 예정.
 */
import { getStockPrice } from "@/lib/kis";

async function main(): Promise<void> {
  console.log("=== 005930 실시간 시세 조회 ===");
  const price = await getStockPrice("005930");
  console.log(JSON.stringify(price, null, 2));
  console.log("\n검증 완료: KIS 호출 정상.");
}

main().catch((error) => {
  console.error("검증 중 오류:", error);
  process.exit(1);
});

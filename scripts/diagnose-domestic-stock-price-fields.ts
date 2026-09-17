/**
 * "관심종목 카드 기준시점(국내 종목)" 표시 기능 구현 전, KIS 국내 주식 현재가
 * 조회(inquire-price) 응답에 실제로 어떤 필드가 있는지 확인하는 디스포저블
 * 스크립트(읽기 전용, DB에 아무것도 안 씀). lib/kis.ts의 getStockPrice는 지금
 * stck_prpr/prdy_vrss/prdy_ctrt 등 시세·가치평가 필드만 뽑아 쓰는데, 그 외에
 * 기준시점(영업일자·체결시각 등) 필드가 있는지 실제 응답으로 확인한다. 확인 후
 * 삭제 예정(lib/kis.ts의 debugRawStockPrice도 같이 제거).
 *   npx tsx --conditions=react-server scripts/diagnose-domestic-stock-price-fields.ts
 */
import { debugRawStockPrice } from "@/lib/kis";

async function main(): Promise<void> {
  const targets: { code: string; label: string }[] = [
    { code: "005930", label: "삼성전자" },
  ];

  for (const t of targets) {
    console.log(`=== ${t.label} (${t.code}) ===`);
    const raw = await debugRawStockPrice(t.code);
    console.log(JSON.stringify(raw, null, 2));
    console.log();
  }
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});

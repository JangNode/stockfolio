/**
 * "해외지수 기준시점" 표시 기능 구현 전, KIS 해외지수 조회(inquire-daily-chartprice)
 * 응답에 실제로 어떤 필드가 있는지 확인하는 디스포저블 스크립트(읽기 전용, DB에
 * 아무것도 안 씀). lib/kis.ts의 getOverseasIndex는 지금 output1.ovrs_nmix_prpr/
 * ovrs_nmix_prdy_vrss/prdy_ctrt 3개 필드만 뽑아 쓰는데, 그 외에 기준시점(영업일자 등)
 * 필드가 있는지 실제 응답으로 확인한다. 확인 후 삭제 예정
 * (lib/kis.ts의 debugRawOverseasIndex도 같이 제거).
 *   npx tsx --conditions=react-server scripts/diagnose-overseas-index-fields.ts
 */
import { debugRawOverseasIndex } from "@/lib/kis";

async function main(): Promise<void> {
  // 나스닥 종합(COMP)과 원/달러 환율(FX@KRW) 두 종류(N/X)를 각각 확인한다.
  const targets: { marketDiv: "N" | "X"; code: string; label: string }[] = [
    { marketDiv: "N", code: "COMP", label: "나스닥 종합" },
    { marketDiv: "X", code: "FX@KRW", label: "원/달러 환율" },
  ];

  for (const t of targets) {
    console.log(`=== ${t.label} (${t.marketDiv}/${t.code}) ===`);
    const raw = await debugRawOverseasIndex(t.marketDiv, t.code);
    console.log(JSON.stringify(raw, null, 2));
    console.log();
  }
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});

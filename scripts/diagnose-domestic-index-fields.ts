/**
 * "국내지수 기준시점" 표시 기능 구현 전, KIS 국내 업종지수 조회(inquire-index-price)
 * 응답에 실제로 어떤 필드가 있는지 확인하는 디스포저블 스크립트(읽기 전용, DB에
 * 아무것도 안 씀). lib/kis.ts의 getDomesticIndex는 지금 output.bstp_nmix_prpr/
 * bstp_nmix_prdy_vrss/bstp_nmix_prdy_ctrt 3개 필드만 뽑아 쓰는데, 그 외에
 * 기준시점(영업일자·현지시각 등) 필드가 있는지 실제 응답으로 확인한다. 확인 후
 * 삭제 예정(lib/kis.ts의 debugRawDomesticIndex도 같이 제거).
 *   npx tsx --conditions=react-server scripts/diagnose-domestic-index-fields.ts
 */
import { debugRawDomesticIndex } from "@/lib/kis";

async function main(): Promise<void> {
  const targets: { code: string; label: string }[] = [
    { code: "0001", label: "코스피" },
    { code: "1001", label: "코스닥" },
  ];

  for (const t of targets) {
    console.log(`=== ${t.label} (${t.code}) ===`);
    const raw = await debugRawDomesticIndex(t.code);
    console.log(JSON.stringify(raw, null, 2));
    console.log();
  }
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});

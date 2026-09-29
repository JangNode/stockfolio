/**
 * [디스포저블 진단, 조사 끝나면 정리 PR로 제거] scripts/backfill-stock-daily-prices.ts가
 * 실제로 쓰는 필드(ISU_CD/TDD_CLSPRC/TDD_OPNPRC/TDD_HGPRC/TDD_LWPRC/ACC_TRDVOL/
 * MKTCAP/LIST_SHRS) 외에 KRX 일별매매정보(stk_bydd_trd/ksq_bydd_trd) 응답에 조정계수나
 * 액면가, 거래대금 등 추가 필드가 있는지 원본 JSON을 그대로 찍어 확인한다
 * (2026-09-29 조사). 날짜 1개 × 시장 2개(KOSPI/KOSDAQ, 삼성전자가 포함된 KOSPI 위주로
 * 확인)만 호출한다 — 전종목/전기간 재조회 없음. DB에는 아무것도 쓰지 않는다.
 *
 * 실행: tsx --conditions=react-server scripts/diagnose-krx-response-fields.ts
 * 필요 환경변수: KRX_API_KEY
 */

const KRX_BASE_URL = "https://data-dbg.krx.co.kr/svc/apis/sto";

// 삼성전자 50:1 액면분할일(권리 이벤트가 실제로 있었던 날 — 이 날 응답에 조정
// 관련 필드가 있다면 가장 먼저 드러날 것이다) + 참고로 평범한 최근 거래일 하루.
const SAMPLE_DATES = ["20180504", "20180503"];

async function fetchRaw(endpoint: "stk_bydd_trd" | "ksq_bydd_trd", basDd: string, apiKey: string): Promise<unknown> {
  const res = await fetch(`${KRX_BASE_URL}/${endpoint}?basDd=${basDd}`, { headers: { AUTH_KEY: apiKey } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main(): Promise<void> {
  console.log(`KRX 응답 필드 확인 시작: ${new Date().toISOString()}`);
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");

  for (const basDd of SAMPLE_DATES) {
    console.log(`\n=== ${basDd} (KOSPI, stk_bydd_trd) ===`);
    const body = (await fetchRaw("stk_bydd_trd", basDd, apiKey)) as { OutBlock_1?: Record<string, unknown>[] };
    const rows = body.OutBlock_1 ?? [];
    console.log(`  전체 행 수: ${rows.length}`);
    const samsung = rows.find((r) => r.ISU_CD === "005930");
    if (samsung) {
      console.log(`  005930(삼성전자) 원본 행 전체 필드:`);
      console.log(`    ${JSON.stringify(samsung, null, 2).replaceAll("\n", "\n    ")}`);
    } else {
      console.log(`  005930을 이 날짜 응답에서 찾지 못했습니다. 첫 행 샘플:`);
      if (rows[0]) console.log(`    ${JSON.stringify(rows[0], null, 2).replaceAll("\n", "\n    ")}`);
    }
    // 필드 목록만 한 번 더 요약(전체 행에서 키 합집합 — 행마다 필드가 다를 수 있어서).
    const keySet = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r)) keySet.add(k);
    console.log(`  이 응답에 등장하는 전체 필드 키: ${Array.from(keySet).sort().join(", ")}`);
  }

  console.log("\n완료 — 현재 백필 스크립트가 쓰는 필드(ISU_CD/TDD_CLSPRC/TDD_OPNPRC/TDD_HGPRC/TDD_LWPRC/ACC_TRDVOL/MKTCAP/LIST_SHRS) 대비 위 필드 목록을 비교해 조정계수/액면가/거래대금 등 미사용 필드가 있는지 확인하세요.");
}

main().catch((error) => {
  console.error("KRX 응답 필드 확인 중 오류:", error);
  process.exit(1);
});

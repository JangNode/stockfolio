/**
 * RIM(잔여이익모델) 적정주가 기능의 1단계(베타 계산)에 필요한 외부 소스가 실제로
 * 확보 가능한지 확인한다. 전부 이 세션 샌드박스에서 직접 접근 불가능한 도메인
 * (opendart와 마찬가지로 openapi.koreainvestment.com, ecos.bok.or.kr,
 * data-dbg.krx.co.kr)이라 GitHub Actions로 실행해 실응답을 봐야 한다(SKILLS.md 원칙).
 *
 * 1차 진단(이미 완료, 결과 반영됨): KIS 개별종목 일봉 엔드포인트
 * (inquire-daily-itemchartprice)를 지수용 시장구분코드("U")로 호출 →
 * "ERROR INVALID FID_COND_MRKT_DIV_CODE"로 명확히 거부됨. KIS 자체엔 국내 지수
 * 과거 일별시세 조회 기능이 없는 것으로 결론(diagnoseDomesticIndexDailyPricesRaw는
 * 이 이유로 제거하고, 대신 이 스크립트에서 KRX Open API로 재시도한다).
 *
 * 이번 진단:
 * 1) KRX Open API의 지수 일별시세 서비스 후보 endpoint 몇 개를 실제로 호출해서
 *    어느 것이(혹은 어느 것도 아닌지) 코스피/코스닥 지수 과거 종가를 주는지 확인한다.
 *    기존 종목 시세 백필(scripts/backfill-stock-daily-prices.ts)과 동일한 인증
 *    방식(AUTH_KEY 헤더, 같은 KRX_API_KEY)을 그대로 재사용한다 — 새 계약 여부는
 *    이 결과로 판단(같은 키로 되면 새 계약 불필요, 안 되면 별도 서비스 승인 필요).
 * 2) ECOS 국고채 10년물 통계항목코드 — 1차 진단에서 StatisticItemList 호출 자체는
 *    성공(27개 항목)했으나 스크립트의 필드명 파싱이 잘못돼(item_code=undefined)
 *    실제 값을 못 봤다. 이번엔 raw JSON을 그대로 찍어 정확한 필드명과 항목코드를
 *    확인한다.
 *
 * DB에는 아무것도 쓰지 않는 읽기 전용 진단 — 확인 끝나면 정리 PR에서 스크립트/
 * 워크플로와 함께 삭제한다.
 *
 * 필요 환경변수: KRX_API_KEY, ECOS_API_KEY
 *   tsx --conditions=react-server scripts/diagnose-rim-external-sources.ts
 */

const KRX_BASE_URL = "https://data-dbg.krx.co.kr/svc/apis";

function toBasDd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// KRX Open API는 서비스를 카테고리(sto=주식, idx=지수 등)로 나눈다. 정확한 지수
// endpoint 이름이 문서로 확인 안 돼(이 세션에서 openapi.krx.co.kr 접근 불가),
// 알려진 후보 몇 개를 순서대로 시도한다. 하루 전 영업일 기준으로 조회한다
// (당일 지수는 정산 전일 수 있어 기존 종목 시세 백필과 동일하게 D-1을 씀).
const KRX_INDEX_ENDPOINT_CANDIDATES = ["idx/idx_bydd_trd", "idx/kospi_dd_trd", "idx/kosdaq_dd_trd"];

async function diagnoseKrxIndexHistory(): Promise<void> {
  console.log("########## KRX Open API 지수 일별시세 endpoint 후보 진단 ##########\n");
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");

  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const basDd = toBasDd(yesterday);

  for (const endpoint of KRX_INDEX_ENDPOINT_CANDIDATES) {
    console.log(`--- ${endpoint} (basDd=${basDd}) ---`);
    try {
      const res = await fetch(`${KRX_BASE_URL}/${endpoint}?basDd=${basDd}`, {
        headers: { AUTH_KEY: apiKey },
      });
      const text = await res.text();
      console.log(`  HTTP ${res.status}`);
      console.log(`  ${text.slice(0, 2000)}`);
    } catch (error) {
      console.log(`  호출 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log();
  }
}

async function diagnoseEcosTreasury10y(): Promise<void> {
  console.log("########## ECOS 국고채 10년물 통계항목코드 진단(raw) ##########\n");
  const apiKey = process.env.ECOS_API_KEY;
  if (!apiKey) throw new Error("ECOS_API_KEY 환경 변수가 없습니다.");

  const statCode = "817Y002";
  const url = `https://ecos.bok.or.kr/api/StatisticItemList/${apiKey}/json/kr/1/100/${statCode}`;
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log(text.slice(0, 6000));
}

async function main(): Promise<void> {
  await diagnoseKrxIndexHistory();
  await diagnoseEcosTreasury10y();
  console.log("\n=== 진단 종료 ===");
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});

/**
 * RIM(잔여이익모델) 적정주가 기능의 1단계(베타 계산)에 필요한 두 외부 소스가
 * 실제로 기존 연동만으로 확보 가능한지 확인한다. 둘 다 이 세션 샌드박스에서
 * 직접 접근 불가능한 도메인(opendart와 마찬가지로 openapi.koreainvestment.com,
 * ecos.bok.or.kr)이라 GitHub Actions로 실행해 실응답을 봐야 한다(SKILLS.md 원칙).
 *
 * 1) KIS 국내 지수(코스피 0001/코스닥 1001) 과거 일별시세 — lib/kis.ts에 현재가
 *    1건 조회(getDomesticIndex)만 있고 시계열 조회 함수가 없어, 개별종목 일봉
 *    엔드포인트(inquire-daily-itemchartprice)를 지수용 시장구분코드("U",
 *    getDomesticIndex와 동일한 관례)로 호출했을 때 실제로 과거 데이터를 주는지,
 *    필드명이 무엇인지 raw 응답을 그대로 찍어서 확인한다
 *    (lib/kis.ts의 diagnoseDomesticIndexDailyPricesRaw, 임시 진단 전용 함수).
 *    안 되면 계획대로 KRX Open API(idx_bydd_trd)로 전환 검토.
 *
 * 2) ECOS 국고채 10년물 금리 — 통계표코드 817Y002("시장금리(일별)")가 유력하나
 *    정확한 통계항목코드(item code)를 몰라, ECOS StatisticItemList API로 817Y002의
 *    전체 항목 목록을 조회해 국고채(10년) 항목을 찾는다.
 *
 * DB에는 아무것도 쓰지 않는 읽기 전용 진단 — 확인 끝나면 정리 PR에서 스크립트/
 * 워크플로와 함께 삭제한다(단, 진단 결과가 KIS 방식으로 확정되면
 * diagnoseDomesticIndexDailyPricesRaw는 정식 함수로 교체 후 제거).
 *
 * 필요 환경변수: KIS_APP_KEY, KIS_APP_SECRET, ECOS_API_KEY,
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY(KIS 토큰 저장용)
 *   tsx --conditions=react-server scripts/diagnose-rim-external-sources.ts
 */

import { diagnoseDomesticIndexDailyPricesRaw } from "@/lib/kis";

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function diagnoseKisIndexHistory(): Promise<void> {
  console.log("########## 1) KIS 국내 지수 과거 일별시세 진단 ##########\n");
  const endDate = formatDate(new Date());

  for (const [code, name] of [
    ["0001", "코스피"],
    ["1001", "코스닥"],
  ] as const) {
    console.log(`--- ${name}(${code}) ---`);
    try {
      const raw = await diagnoseDomesticIndexDailyPricesRaw(code, endDate);
      console.log(JSON.stringify(raw, null, 2).slice(0, 3000));
    } catch (error) {
      console.log(`  호출 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log();
  }
}

interface EcosItemListResponse {
  StatisticItemList?: {
    row?: { STAT_CODE: string; STAT_NAME: string; ITEM_CODE1: string; ITEM_NAME1: string }[];
  };
  RESULT?: { CODE: string; MESSAGE: string };
}

async function diagnoseEcosTreasury10y(): Promise<void> {
  console.log("########## 2) ECOS 국고채 10년물 통계항목코드 진단 ##########\n");
  const apiKey = process.env.ECOS_API_KEY;
  if (!apiKey) throw new Error("ECOS_API_KEY 환경 변수가 없습니다.");

  const statCode = "817Y002";
  const url = `https://ecos.bok.or.kr/api/StatisticItemList/${apiKey}/json/kr/1/100/${statCode}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    console.log(`  StatisticItemList 호출 실패: HTTP ${res.status}`);
    return;
  }
  const data: EcosItemListResponse = await res.json();
  if (data.RESULT && data.RESULT.CODE !== "INFO-000") {
    console.log(`  ECOS 오류(${data.RESULT.CODE}): ${data.RESULT.MESSAGE}`);
    return;
  }

  const rows = data.StatisticItemList?.row ?? [];
  console.log(`  통계표(${statCode}) 전체 항목 ${rows.length}개:`);
  for (const row of rows) {
    console.log(`    item_code=${row.ITEM_CODE1} name=${row.ITEM_NAME1}`);
  }

  const treasuryCandidates = rows.filter((r) => /국고채/.test(r.ITEM_NAME1) && /10년/.test(r.ITEM_NAME1));
  console.log(`\n  "국고채"+"10년" 키워드 매칭 항목:`);
  for (const row of treasuryCandidates) {
    console.log(`    item_code=${row.ITEM_CODE1} name=${row.ITEM_NAME1}`);
  }
}

async function main(): Promise<void> {
  await diagnoseKisIndexHistory();
  await diagnoseEcosTreasury10y();
  console.log("\n=== 진단 종료 ===");
}

main().catch((error) => {
  console.error("진단 스크립트 실행 중 오류:", error);
  process.exit(1);
});

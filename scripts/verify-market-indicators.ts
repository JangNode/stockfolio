/**
 * (1회성 검증) FRED/ECOS 실데이터로 미국/한국 기준금리 동기화가 정상 동작하는지
 * 확인한다. 이 실행 자체가 최초 전체 이력 적재(백필)를 겸한다(syncXxxRate는 항상
 * 전체 재동기화). 검증 후 삭제 예정.
 */
import { syncUsFedRate, syncKrBaseRate } from "@/lib/rateSync";
import { getUsFedRateHistory, getKrBaseRateHistory } from "@/lib/rateStorage";
import { computeChangePoints, hasLatestChanged, type RatePoint } from "@/lib/rateChangeDetection";

async function main(): Promise<void> {
  console.log("=== 합성 케이스: computeChangePoints / hasLatestChanged ===");
  const synthetic: RatePoint[] = [
    { effectiveDate: "2020-01-01", values: [1, 0.75] },
    { effectiveDate: "2020-01-02", values: [1, 0.75] },
    { effectiveDate: "2020-01-03", values: [1.25, 1] },
    { effectiveDate: "2020-01-04", values: [1.25, 1] },
    { effectiveDate: "2020-01-05", values: [1.25, 1] },
    { effectiveDate: "2020-01-06", values: [1, 0.75] },
  ];
  const changePoints = computeChangePoints(synthetic);
  console.log(`변경점 ${changePoints.length}개(기대: 3개) →`, JSON.stringify(changePoints));
  console.log(
    `hasLatestChanged(동일값) → ${hasLatestChanged(changePoints[0], { ...changePoints[0] })} (기대: false)`
  );
  console.log(
    `hasLatestChanged(다른값) → ${hasLatestChanged(changePoints[0], changePoints[1])} (기대: true)`
  );
  console.log(`hasLatestChanged(이전 없음) → ${hasLatestChanged(null, changePoints[0])} (기대: true)`);

  console.log("\n=== 미국 기준금리(FRED) 동기화 ===");
  const usResult = await syncUsFedRate();
  console.log(`동기화 결과: changed=${usResult.changed}, latest=${JSON.stringify(usResult.latest)}`);
  const usHistory = await getUsFedRateHistory();
  console.log(`저장된 변경점 총 ${usHistory.length}건`);
  console.log("최근 5건:", JSON.stringify(usHistory.slice(-5), null, 2));

  console.log("\n=== ECOS KeyStatisticList(100대 통계지표)에서 '기준금리' 검색 ===");
  const apiKey = process.env.ECOS_API_KEY;
  const keyStatUrl = `https://ecos.bok.or.kr/api/KeyStatisticList/${apiKey}/json/kr/1/100`;
  const keyStatRes = await fetch(keyStatUrl);
  const keyStatData: { KeyStatisticList?: { row?: { CLASS_NAME: string; KEYSTAT_NAME: string; DATA_VALUE: string; CYCLE?: string; UNIT_NAME?: string }[] }; RESULT?: { CODE: string; MESSAGE: string } } =
    await keyStatRes.json();
  console.log(`상태: ${keyStatRes.status}, RESULT: ${JSON.stringify(keyStatData.RESULT ?? null)}`);
  const rows = keyStatData.KeyStatisticList?.row ?? [];
  console.log(`전체 ${rows.length}건 중 '기준금리' 포함 항목:`);
  console.log(JSON.stringify(rows.filter((r) => r.KEYSTAT_NAME?.includes("기준금리")), null, 2));

  console.log("\n=== 후보 조합 직접 테스트 ===");
  const candidates: { statCode: string; itemCode: string; cycle: string }[] = [
    { statCode: "722Y001", itemCode: "0101000", cycle: "D" },
    { statCode: "722Y001", itemCode: "0101000", cycle: "M" },
    { statCode: "902Y006", itemCode: "KR", cycle: "M" },
  ];
  for (const c of candidates) {
    const url = `https://ecos.bok.or.kr/api/StatisticSearch/${apiKey}/json/kr/1/10/${c.statCode}/${c.cycle}/20240101/20260830/${c.itemCode}`;
    const res = await fetch(url);
    const text = await res.text();
    console.log(`[${c.statCode}/${c.itemCode}/${c.cycle}] 상태 ${res.status}: ${text.slice(0, 500)}`);
  }

  console.log("\n=== 한국 기준금리(ECOS) 동기화 ===");
  const krResult = await syncKrBaseRate();
  console.log(`동기화 결과: changed=${krResult.changed}, latest=${JSON.stringify(krResult.latest)}`);
  const krHistory = await getKrBaseRateHistory();
  console.log(`저장된 변경점 총 ${krHistory.length}건`);
  console.log("최근 5건:", JSON.stringify(krHistory.slice(-5), null, 2));

  console.log("\n검증 완료.");
}

main().catch((error) => {
  console.error("검증 중 오류:", error);
  process.exit(1);
});

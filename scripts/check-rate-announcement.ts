/**
 * FOMC/금통위 발표 감지 배치. MARKET(US|KR)과 OFFSETS_MIN(콤마 구분 분 단위, 예:
 * "0" 또는 "0,5,15,30,60,120")을 받아, 순서대로 그 간격만큼 sleep하며 최신값을
 * 확인한다. 한 번이라도 이전 값과 달라지면 즉시 DB를 갱신하고 종료(이후 오프셋은
 * 건너뜀) — FRED/ECOS는 연준·한은 발표를 받아 정리하는 2차 소스라 발표 순간과 몇 분
 * 지연이 있을 수 있어 이 재시도가 필요하다. 마지막 오프셋까지 변화가 없으면 그대로
 * 종료한다(다음날 정기 배치나 다음 오프셋 트리거가 이어받음).
 *
 * 필요 환경변수: MARKET(US|KR), OFFSETS_MIN, FRED_API_KEY 또는 ECOS_API_KEY(해당
 *   시장에 맞게), NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   MARKET=US OFFSETS_MIN=0,5,15,30,60,120 tsx --conditions=react-server scripts/check-rate-announcement.ts
 */
import { syncUsFedRate, syncKrBaseRate, type RateSyncResult } from "@/lib/rateSync";
import { logRateCheckAttempt } from "@/lib/rateStorage";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const market = process.env.MARKET;
  if (market !== "US" && market !== "KR") {
    throw new Error("MARKET 환경변수는 US 또는 KR이어야 합니다.");
  }

  const offsets = (process.env.OFFSETS_MIN ?? "0")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (offsets.length === 0) {
    throw new Error("OFFSETS_MIN 환경변수를 파싱하지 못했습니다.");
  }

  console.log(`발표 감지 시작: market=${market}, offsets=${offsets.join(",")}분`);

  for (let i = 0; i < offsets.length; i++) {
    if (i > 0) {
      const waitMin = offsets[i] - offsets[i - 1];
      console.log(`  ${waitMin}분 대기...`);
      await sleep(waitMin * 60_000);
    }

    console.log(`  T+${offsets[i]}분 확인 중...`);
    const result: RateSyncResult = market === "US" ? await syncUsFedRate() : await syncKrBaseRate();
    await logRateCheckAttempt(market, offsets[i], result.changed, result.latest);

    if (result.changed) {
      console.log(`  변경 감지: ${JSON.stringify(result.latest)} — 갱신 완료, 종료합니다.`);
      return;
    }
    console.log("  변화 없음.");
  }

  console.log("모든 오프셋을 확인했지만 변화가 없었습니다. 종료합니다.");
}

main().catch((error) => {
  console.error("발표 감지 배치 중 오류가 발생했습니다:", error);
  process.exit(1);
});

/**
 * (1회성 검증) "지난 회의 결과" 목록이 동결(값 안 바뀐) 회의도 빠짐없이 보여주는지
 * 확인한다 — 저장된 변경점만 쓰면 동결 회의가 아예 안 보이는 버그가 있었다(2026년
 * 미국 FOMC 회의가 화면에 하나도 안 뜨는 증상으로 나타남). 검증 후 삭제 예정.
 */
import { getUsFedRateHistory, getKrBaseRateHistory } from "@/lib/rateStorage";
import { pickValueAsOf, pickValueBefore, buildMeetingResultDates, type RatePoint } from "@/lib/rateChangeDetection";
import { FOMC_SCHEDULE, MPC_SCHEDULE } from "@/lib/rateScheduleConfig";

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  console.log("=== 합성 케이스: pickValueAsOf / pickValueBefore / buildMeetingResultDates ===");
  const synthetic: RatePoint[] = [{ effectiveDate: "2025-12-11", values: [3.75, 3.5] }];
  console.log(
    `pickValueAsOf(2026-01-28) → ${JSON.stringify(pickValueAsOf(synthetic, "2026-01-28"))} (기대: 2025-12-11 값 그대로)`
  );
  console.log(
    `pickValueBefore(2025-12-11) → ${JSON.stringify(pickValueBefore(synthetic, "2025-12-11"))} (기대: null, 그 전엔 기록 없음)`
  );
  console.log(
    `buildMeetingResultDates → ${JSON.stringify(buildMeetingResultDates(synthetic, ["2026-01-28", "2099-01-01"], "2026-08-30"))} (기대: [2025-12-11, 2026-01-28]만, 미래 일정 2099는 제외)`
  );

  const today = todayIsoDate();

  console.log("\n=== 실데이터: 미국 2026년 FOMC 회의 결과(동결 포함 전부 보여야 함) ===");
  const usHistory = await getUsFedRateHistory();
  const usDates = buildMeetingResultDates(usHistory, FOMC_SCHEDULE.map((s) => s.date), today);
  const usRows2026 = usDates.filter((d) => d.startsWith("2026"));
  console.log(`2026년 날짜 ${usRows2026.length}건: ${JSON.stringify(usRows2026)}`);
  for (const d of usRows2026) {
    const cur = pickValueAsOf(usHistory, d);
    const prev = pickValueBefore(usHistory, d);
    console.log(
      `  ${d}: 이전=${prev ? `${prev.targetLowerPct}~${prev.targetUpperPct}%` : "없음"} → 현재=${cur ? `${cur.targetLowerPct}~${cur.targetUpperPct}%` : "없음"}`
    );
  }

  console.log("\n=== 실데이터: 한국 2026년 금통위 회의 결과 ===");
  const krHistory = await getKrBaseRateHistory();
  const krDates = buildMeetingResultDates(krHistory, MPC_SCHEDULE.map((s) => s.date), today);
  const krRows2026 = krDates.filter((d) => d.startsWith("2026"));
  console.log(`2026년 날짜 ${krRows2026.length}건: ${JSON.stringify(krRows2026)}`);
  for (const d of krRows2026) {
    const cur = pickValueAsOf(krHistory, d);
    const prev = pickValueBefore(krHistory, d);
    console.log(`  ${d}: 이전=${JSON.stringify(prev?.ratePct)} → 현재=${JSON.stringify(cur?.ratePct)}`);
  }

  console.log("\n검증 완료.");
}

main().catch((error) => {
  console.error("검증 중 오류:", error);
  process.exit(1);
});

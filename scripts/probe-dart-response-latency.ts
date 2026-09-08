/**
 * (임시) 2026-09-08 DART 재무제표 백필 사건 이후 재실행 전 가벼운 사전 점검용.
 * 이미 실제 데이터가 있음을 확인한 고정 (corp_code, fiscal_year) 하나(이오테크닉스
 * 039030, corp_code=00246417, FY2015 — diagnose-dart-cfs-ofs-hypothesis.ts에서
 * CFS로 확인됨)를 반복 조회해 콜당 평균 응답 시간을 잰다.
 *
 * 기준: 그날 진단(diagnose-dart-status-code-masking.ts) 재현 실행에서 정상 시
 * 0.1~0.2초/콜, DART 응답이 느려진 상태에서는 약 3.8초/콜이었다. 정상 대비 5배
 * 이상 여유를 두면서도 사건 수준보다는 확실히 낮은 1.0초를 임계값으로 잡는다.
 *
 * GitHub Actions에서 실행되면 결과를 GITHUB_OUTPUT에 healthy=true/false로 남겨,
 * 다음 스텝(실제 백필)의 조건부 실행에 쓴다. 로컬 실행 시엔 콘솔 출력만 한다.
 * 읽기 전용, DART API만 호출하고 아무것도 쓰지 않는다. 확인 후 즉시 삭제 예정.
 * tsx --conditions=react-server scripts/probe-dart-response-latency.ts
 */
import { appendFileSync } from "node:fs";

const DART_BASE_URL = "https://opendart.fss.or.kr/api";
const PROBE_CORP_CODE = "00246417"; // 이오테크닉스(039030)
const PROBE_FISCAL_YEAR = 2015;
const PROBE_SAMPLE_SIZE = 15;
const HEALTHY_AVG_LATENCY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) throw new Error("DART_API_KEY 환경 변수가 없습니다.");

  const url = new URL(`${DART_BASE_URL}/fnlttSinglAcntAll.json`);
  url.searchParams.set("crtfc_key", apiKey);
  url.searchParams.set("corp_code", PROBE_CORP_CODE);
  url.searchParams.set("bsns_year", String(PROBE_FISCAL_YEAR));
  url.searchParams.set("reprt_code", "11011");
  url.searchParams.set("fs_div", "CFS");

  const latencies: number[] = [];
  let successCount = 0;

  for (let i = 0; i < PROBE_SAMPLE_SIZE; i++) {
    const startedAt = Date.now();
    try {
      const res = await fetch(url);
      const elapsed = Date.now() - startedAt;
      latencies.push(elapsed);
      if (res.ok) {
        const body = (await res.json()) as { status: string };
        if (body.status === "000") successCount++;
        console.log(`  #${i + 1}: ${elapsed}ms (status=${body.status})`);
      } else {
        console.log(`  #${i + 1}: ${elapsed}ms (HTTP ${res.status})`);
      }
    } catch (error) {
      const elapsed = Date.now() - startedAt;
      latencies.push(elapsed);
      console.log(`  #${i + 1}: ${elapsed}ms (에러: ${error instanceof Error ? error.message : String(error)})`);
    }
    await sleep(300);
  }

  const avgLatencyMs = latencies.reduce((sum, v) => sum + v, 0) / latencies.length;
  const healthy = avgLatencyMs <= HEALTHY_AVG_LATENCY_MS && successCount === PROBE_SAMPLE_SIZE;

  console.log(`\n평균 응답 시간: ${avgLatencyMs.toFixed(0)}ms (임계값 ${HEALTHY_AVG_LATENCY_MS}ms)`);
  console.log(`정상 응답(status=000) ${successCount}/${PROBE_SAMPLE_SIZE}건`);
  console.log(`판정: ${healthy ? "정상(healthy) — 재실행 가능" : "느림(unhealthy) — 재실행 보류 권장"}`);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `healthy=${healthy}\n`);
    appendFileSync(process.env.GITHUB_OUTPUT, `avg_latency_ms=${avgLatencyMs.toFixed(0)}\n`);
  }
}

main().catch((error) => {
  console.error("점검 중 오류:", error);
  process.exit(1);
});

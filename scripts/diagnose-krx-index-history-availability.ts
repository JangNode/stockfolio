/**
 * [디스포저블 진단 스크립트, 1회성] KRX Open API(idx/kospi_dd_trd, idx/kosdaq_dd_trd)가
 * 2016년처럼 오래된 날짜도 서빙하는지 실제 호출로 확인한다. DB에는 아무것도 쓰지
 * 않는다(순수 조회 진단).
 *
 * "장기 백테스트" 벤치마크 비교 조사(2026-09-29)용 — 확인이 끝나면 이 스크립트와
 * 대응 워크플로(.github/workflows/diagnose-index-coverage-and-krx-availability.yml)는
 * 정리 PR로 제거한다.
 *
 * 호출 방식은 scripts/backfill-index-daily-prices.ts와 동일(AUTH_KEY 헤더, 정확히
 * "코스피"/"코스닥"인 행만 채택).
 *
 * 실행: tsx --conditions=react-server scripts/diagnose-krx-index-history-availability.ts
 * 필요 환경변수: KRX_API_KEY
 */

import type { KrxMarket } from "@/lib/stockMaster";

const KRX_BASE_URL = "https://data-dbg.krx.co.kr/svc/apis/idx";
const THROTTLE_DELAY_MS = 300;

const INDEX_ENDPOINTS: Record<KrxMarket, { endpoint: string; exactName: string }> = {
  KOSPI: { endpoint: "kospi_dd_trd", exactName: "코스피" },
  KOSDAQ: { endpoint: "kosdaq_dd_trd", exactName: "코스닥" },
};

// point-in-time 원칙과는 무관한 순수 API 가용성 확인용 샘플 날짜(2016년 초/중,
// 2020년 초 — 사용자가 지정한 날짜 그대로).
const SAMPLE_DATES = ["2016-01-04", "2016-06-15", "2020-01-02"];

interface KrxIndexRow {
  IDX_NM: string;
  CLSPRC_IDX: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toBasDd(dateKey: string): string {
  return dateKey.replaceAll("-", "");
}

async function fetchKrxIndexDaily(market: KrxMarket, basDd: string, apiKey: string): Promise<KrxIndexRow[]> {
  const { endpoint } = INDEX_ENDPOINTS[market];
  const res = await fetch(`${KRX_BASE_URL}/${endpoint}?basDd=${basDd}`, { headers: { AUTH_KEY: apiKey } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { OutBlock_1?: KrxIndexRow[] };
  return body.OutBlock_1 ?? [];
}

async function main(): Promise<void> {
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");

  const markets: KrxMarket[] = ["KOSPI", "KOSDAQ"];

  for (const dateKey of SAMPLE_DATES) {
    const basDd = toBasDd(dateKey);
    for (const market of markets) {
      await sleep(THROTTLE_DELAY_MS);
      try {
        const rows = await fetchKrxIndexDaily(market, basDd, apiKey);
        const exactName = INDEX_ENDPOINTS[market].exactName;
        const matched = rows.find((row) => row.IDX_NM === exactName);
        if (matched && matched.CLSPRC_IDX && matched.CLSPRC_IDX !== "-") {
          console.log(`[${dateKey}] [${market}] 조회 성공: 종가 ${matched.CLSPRC_IDX} (응답 행 ${rows.length}개)`);
        } else {
          console.log(`[${dateKey}] [${market}] 응답에 "${exactName}" 행 없음(휴장일이거나 데이터 없음) — 응답 행 ${rows.length}개: ${JSON.stringify(rows.slice(0, 3))}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[${dateKey}] [${market}] 호출 실패: ${message}`);
      }
    }
  }

  console.log("완료");
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});

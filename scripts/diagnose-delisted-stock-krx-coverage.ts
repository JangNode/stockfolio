/**
 * [디스포저블 진단 스크립트] 생존편향 백필(0단계) — KRX 일별매매정보(stk_bydd_trd/
 * ksq_bydd_trd)가 "오늘은 상장폐지됐지만 그 날짜엔 실제로 거래된 종목"의 행을
 * 과거 날짜 조회에서 실제로 돌려주는지 실측 확인한다. 지금까지는 이 응답에 걸린
 * 종목도 저장 단계(시가총액 하한 필터)에서 버려져 왔기 때문에, 응답 자체에
 * 포함되는지는 한 번도 실측된 적이 없다(계획 문서 0단계 참고).
 *
 * 대형주(한진해운/STX조선해양) + 소형주(우경/신양오라컴) 4종목을, 정리매매
 * 시작일(ArrantEnforceDate) 기준 여러 시점(-400/-180/-90/-30/-14/-7/-1일,
 * 정리매매 기간 중, 상장폐지 이후)으로 조회해 어느 시점부터 응답에서 사라지는지
 * 확인한다 — "거래정지가 상장폐지보다 몇 개월 먼저 시작"되는 패턴이 실제로
 * KRX 응답에 반영되는지가 계획 4번 항목(공백 처리 방식)의 전제다.
 *
 * DB에 아무것도 쓰지 않는다(순수 조회 + 로그). 확인이 끝나면 이 스크립트와
 * 워크플로는 정리 PR로 제거한다.
 *
 * 필요 환경변수: KRX_API_KEY
 *   tsx --conditions=react-server scripts/diagnose-delisted-stock-krx-coverage.ts
 */

const KRX_BASE_URL = "https://data-dbg.krx.co.kr/svc/apis/sto";

interface KrxTradeRow {
  ISU_CD: string;
  ISU_NM: string;
  TDD_CLSPRC: string;
  ACC_TRDVOL: string;
}

interface SampleStock {
  code: string;
  name: string;
  market: "KOSPI" | "KOSDAQ";
  delistingDate: string; // YYYY-MM-DD
  arrantEnforceDate: string; // 정리매매 시작일
  arrantEndDate: string; // 정리매매 종료일
}

// data/listing/delisting/2026-09-17.csv(raw.githubusercontent.com/FinanceData/fdr_krx_data_cache)
// 원본에서 직접 확인한 값 — 대형주 2종(잘 알려진 사례) + 소형주 2종(무작위 표본).
const SAMPLE_STOCKS: SampleStock[] = [
  {
    code: "117930",
    name: "한진해운",
    market: "KOSPI",
    delistingDate: "2017-03-07",
    arrantEnforceDate: "2017-02-23",
    arrantEndDate: "2017-03-06",
  },
  {
    code: "067250",
    name: "STX조선해양",
    market: "KOSPI",
    delistingDate: "2014-04-15",
    arrantEnforceDate: "2014-04-04",
    arrantEndDate: "2014-04-14",
  },
  {
    code: "025920",
    name: "우경",
    market: "KOSDAQ",
    delistingDate: "2013-07-10",
    arrantEnforceDate: "2013-07-01",
    arrantEndDate: "2013-07-09",
  },
  {
    code: "086830",
    name: "신양오라컴",
    market: "KOSDAQ",
    delistingDate: "2017-05-08",
    arrantEnforceDate: "2017-04-24",
    arrantEndDate: "2017-05-04",
  },
];

// 정리매매 시작일 기준 상대 오프셋(일). 음수는 그 이전, 0은 정리매매 첫날.
const PROBE_OFFSETS_DAYS = [-400, -180, -90, -30, -14, -7, -1, 0];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toBasDd(dateKey: string): string {
  return dateKey.replaceAll("-", "");
}

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

/** offsetDays를 더한 뒤 주말이면 가장 가까운 이전 평일로 당긴다(공휴일은 못 거른다
 * — 그날 응답이 전체(양쪽 시장 다) 비어있으면 로그에서 "공휴일 의심"으로 표시). */
function resolveTradingDateGuess(baseDateKey: string, offsetDays: number): string {
  const d = new Date(`${baseDateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  while (isWeekend(d)) d.setUTCDate(d.getUTCDate() - 1);
  return toDateKey(d);
}

async function fetchKrxDaily(
  endpoint: "stk_bydd_trd" | "ksq_bydd_trd",
  basDd: string,
  apiKey: string
): Promise<KrxTradeRow[]> {
  const res = await fetch(`${KRX_BASE_URL}/${endpoint}?basDd=${basDd}`, {
    headers: { AUTH_KEY: apiKey },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { OutBlock_1?: KrxTradeRow[] };
  return body.OutBlock_1 ?? [];
}

async function probeDate(stock: SampleStock, dateKey: string): Promise<void> {
  const endpoint = stock.market === "KOSPI" ? "stk_bydd_trd" : "ksq_bydd_trd";
  const apiKey = process.env.KRX_API_KEY!;

  let rows: KrxTradeRow[];
  try {
    rows = await fetchKrxDaily(endpoint, toBasDd(dateKey), apiKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`    ${dateKey}: 조회 실패(${message})`);
    return;
  }

  const found = rows.find((r) => r.ISU_CD === stock.code);
  if (found) {
    console.log(
      `    ${dateKey}: ✓ 포함됨 (종가 ${found.TDD_CLSPRC}, 거래량 ${found.ACC_TRDVOL}, 이 날 전체 ${rows.length}건)`
    );
  } else if (rows.length === 0) {
    console.log(`    ${dateKey}: ✕ 없음 — 이 날 전체 응답이 0건이라 공휴일일 가능성(휴장일이면 원래 없는 게 정상)`);
  } else {
    console.log(`    ${dateKey}: ✕ 없음 (이 날 전체 ${rows.length}건 중엔 없음)`);
  }

  await sleep(300); // KRX 초당 호출 제한 여유
}

async function diagnoseStock(stock: SampleStock): Promise<void> {
  console.log(`\n=== ${stock.name}(${stock.code}, ${stock.market}) ===`);
  console.log(
    `    상장폐지일=${stock.delistingDate}, 정리매매=${stock.arrantEnforceDate}~${stock.arrantEndDate}`
  );

  for (const offset of PROBE_OFFSETS_DAYS) {
    const dateKey = resolveTradingDateGuess(stock.arrantEnforceDate, offset);
    const label = offset === 0 ? "정리매매 시작일" : `정리매매 ${-offset}일 전`;
    console.log(`  [${label}]`);
    await probeDate(stock, dateKey);
  }

  console.log(`  [정리매매 종료일]`);
  await probeDate(stock, stock.arrantEndDate);

  const afterDelisting = resolveTradingDateGuess(stock.delistingDate, 5);
  console.log(`  [상장폐지 후 +5거래일 근처, ${afterDelisting}]`);
  await probeDate(stock, afterDelisting);
}

async function main(): Promise<void> {
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");

  console.log("KRX 상장폐지 종목 시세 커버리지 진단 시작");
  for (const stock of SAMPLE_STOCKS) {
    await diagnoseStock(stock);
  }
  console.log("\n진단 완료 — 위 로그에서 '✓ 포함됨'이 사라지는 시점을 확인하세요.");
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});

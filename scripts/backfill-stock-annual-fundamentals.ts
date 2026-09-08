/**
 * 종목 재무 원자료(여러 전략이 공유) 백필 2단계 — 후보종목(백필 기간 중 단 하루라도
 * 시가총액 1조원을 넘은 적 있는 종목)을 1단계가 Storage에 쓴 연도별 Parquet 파일
 * (stock-daily-prices/{year}.parquet)에서 직접 뽑고, 각 종목×연도에 대해 DART
 * fnlttSinglAcntAll(단일회사 전체 재무제표)을 호출해 지배기업 소유주지분
 * 당기순이익/자본총계를 stock_annual_fundamentals에 채운다. "오늘 기준 대형주 리스트"가
 * 아니라 실제 과거 시가총액으로 후보를 뽑기 때문에 생존편향이 없다(과거엔 컸는데 지금
 * 작아진 회사도 포함, 반대도 마찬가지).
 *
 * 연도 범위: 백테스트 기간 시작(2016년, 5년 배당 lookback 포함 2011년)의 point-in-time
 * 조회가 항상 유효한 재무를 찾을 수 있도록 FY2009부터(2010년 3월경 공시, 2011년 초
 * 조회 시점에 이미 최신 공개 재무) 최신 사업연도까지를 대상으로 한다.
 *
 * stock_annual_fundamentals는 (stock_code, fiscal_year) 기본키라 이미 있는 조합은
 * upsert로 건너뛰지 않고 다시 채워도 안전하다(idempotent) — 그래서 별도 날짜 체크포인트
 * 대신, 이미 있는 (stock_code, fiscal_year) 조합은 호출 전에 걸러내는 방식으로 재개한다.
 *
 * server-only로 막힌 lib/supabaseAdmin.ts를 순수 Node 스크립트에서도 재사용하려면
 * "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/backfill-stock-annual-fundamentals.ts
 *
 * 필요 환경변수: DART_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * 2026-09-07 동시성 완화(8→2)/지수 백오프 적용: 2026-09-03~09-04 사이 4회 연속 실행
 * (신규 반영 0건, 매번 5,544~5,547건 전부 "fetch failed")이 실측됐다. 같은 시기 같은
 * DART API 키를 쓰는 scripts/backfill-dart-cashflow-debt.ts가 겪은 것과 동일한
 * burst rate limit 증상(상태코드 없는 네트워크 단절, 고정 1.5초 재시도로는 회복 안 됨)
 * 인데, 그 스크립트는 PR #211로 이미 고쳤고 이 스크립트만 고치지 않은 채 남아있었다.
 * 같은 수정(동시성 2, 5·10·20초 지수 백오프)을 그대로 적용한다.
 *
 * 2026-09-08 CFS→OFS 폴백 + 상태코드 방어 로직 + 배치 이상 감지 추가: 위 수정 이후
 * 재실행하니 실패는 0건이 됐지만 6,564건 중 6,553건이 "데이터없음(013)"으로 나와
 * 신규 반영이 11건뿐이었다. 원인 진단 스크립트(diagnose-dart-cfs-ofs-hypothesis.ts,
 * diagnose-dart-status-code-masking.ts, 둘 다 사용 후 삭제됨)로 확인한 결과:
 * (1) CFS/OFS 구분 문제는 일부만 설명한다(표본 8종목 중 2종목만, 그것도 1~2개 연도만
 *     구제됨) — 그래도 실제 도움이 되니 backfill-dart-cashflow-debt.ts와 동일한 CFS
 *     우선 조회 후 OFS 폴백 패턴을 이식한다.
 * (2) fetchFundamentals가 status==="013"과 "list 필드가 없는 다른 모든 상태"(예:
 *     020 요청 제한 초과)를 구분하지 않고 전부 "데이터없음"으로 처리하던 게 위험한
 *     잠재 버그였다 — 013이 아닌데 list가 없으면 이제 에러로 올려 재시도·로그되게
 *     고쳤다(운영 재현 진단에서 이번 사건 자체가 상태코드 마스킹이었다는 직접 증거는
 *     못 찾았지만, 앞으로 비슷한 일이 생기면 최소한 조용히 넘어가지는 않는다).
 * (3) 진짜 문제는 6,553/6,564(99.8%)라는 비정상 비율이 error_count=0으로 기록되며
 *     "성공"으로 끝났다는 점 — 013 자체가 정상 응답이라 에러로 안 잡힌다. 배치 종료
 *     시 013 비율을 계산해 임계값을 넘으면 stock_data_backfill_runs에 status='anomaly'로
 *     남기게 했다(알림 없이 기록만).
 *
 * 2026-09-08 이상 감지를 절대 임계값(80%)에서 "직전 동일 data_source 실행 대비 013
 * 비율 변화"로 바꿈: 위 절대 임계값 방식으로 실제 재실행(6,553건 처리, 채움 595건)을
 * 돌려보니 013 비율이 90.9%로 나와 또 anomaly로 잡혔다. 그런데 이건 버그가 아니었다
 * — 원인 진단 스크립트(diagnose-dart-cfs-ofs-hypothesis.ts)가 "자연 발생률 40~60%"를
 * 추정할 때 표본을 페이지네이션 없이(1000행 제한) 뽑아서, 이미 데이터가 있던 종목들을
 * "신규 후보"로 잘못 분류해 표본이 오염돼 있었다. 실제 신규 편입 소형주 후보군(자회사가
 * 없고 어린 회사 비중이 높음)은 013 비율이 90%대인 게 오히려 정상일 수 있다 — 즉
 * "이미 데이터가 확인된 종목"과 "신규 편입 후보군"은 성격이 다른 두 집단이라 하나의
 * 절대 임계값으로 재는 것 자체가 잘못된 접근이었다. 절대값을 다시 추정해도 표본에 따라
 * 또 달라질 뿐이라, 절대 기준 대신 "직전 실행 대비 급증"으로 바꿨다 — 9/3~9/4 사건
 * (평소 수준에서 갑자기 99.8%로 뛴 경우)은 잡히고, 신규 소형주 편입으로 자연스럽게
 * 013 비율이 높아지는 경우는 잡히지 않는다. 채움 건수가 처리 대상 대비 지나치게 적은
 * 경우(9/8 00:42 UTC 사건처럼 6,564건 처리에 11건만 채워진 경우)는 013 비율과 무관하게
 * 별도 절대 임계값으로 잡는다 — 이건 "정상 집단이 원래 낮다/높다"는 표본 문제가 없는
 * 순수한 실패 신호라 절대값으로 재도 안전하다.
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { discoverCandidateStockCodes } from "@/lib/stockDailyPricesStorage";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";

const DART_BASE_URL = "https://opendart.fss.or.kr/api";
const DATA_SOURCE = "dart_fundamentals" as const;
const FISCAL_YEAR_START = 2009;
const CONCURRENCY = 2;
const CALL_RETRY_COUNT = 3;
const CALL_RETRY_BASE_DELAY_MS = 5000;

// 013(데이터없음) 비율의 "정상 범위"는 그때그때 후보군 구성에 따라 달라져(이미
// 데이터가 확인된 종목 위주면 낮고, 신규 편입 소형주 위주면 자연스럽게 90%대까지도
// 나올 수 있다) 절대 임계값으로 재면 안 된다 — 그래서 직전 동일 data_source 실행
// 대비 "얼마나 뛰었는지"로 이상을 감지한다. 20%p는 임의값이라 이후 실행 데이터가
// 쌓이면(현재는 anomaly 실행 이력이 1건뿐이라 근거가 부족) 조정 대상이다.
const NO_DATA_RATIO_JUMP_THRESHOLD_PP = 0.2;

// 채움 건수가 처리 대상 대비 지나치게 적으면(2026-09-08 00:42 UTC 사건: 6,564건 처리
// 중 11건, 0.17%) 013 비율의 "정상 범위"가 표본마다 다르다는 문제 없이 절대값으로
// 재도 안전한 순수 실패 신호다. 0.5%는 위 사건(0.17%)보다는 여유를 두면서, 정상
// 실행(수백~수천 건 채움)과는 확실히 구분되는 값으로 잡았다 — 역시 조정 대상이다.
const MIN_FETCHED_RATIO = 0.005;

const NET_INCOME_ACCOUNT_ID = "ifrs-full_ProfitLossAttributableToOwnersOfParent";
const EQUITY_ACCOUNT_ID = "ifrs-full_EquityAttributableToOwnersOfParent";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  async function runOne(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
}

// 1단계(scripts/backfill-stock-daily-prices.ts)의 BACKFILL_START_YEAR와 동일해야
// 후보종목이 빠짐없이 뽑힌다.
const PRICE_BACKFILL_START_YEAR = 2011;

/** 백필 기간 중 단 하루라도 시가총액 1조원을 넘은 적 있는 종목을 뽑는다. "오늘 기준"이
 * 아니라 실측 과거 시가총액을 쓰므로 생존편향이 없다. */
async function discoverCandidates(): Promise<string[]> {
  const currentYear = new Date().getUTCFullYear();
  const years = Array.from(
    { length: currentYear - PRICE_BACKFILL_START_YEAR + 1 },
    (_, i) => PRICE_BACKFILL_START_YEAR + i
  );
  return discoverCandidateStockCodes(years, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK);
}

async function getCorpCodeMap(stockCodes: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const CHUNK = 500;
  for (let i = 0; i < stockCodes.length; i += CHUNK) {
    const chunk = stockCodes.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin
      .from("dart_corp_codes")
      .select("stock_code, corp_code")
      .in("stock_code", chunk);
    if (error) throw new Error(`corp_code 조회 실패: ${error.message}`);
    for (const row of data ?? []) {
      if (row.stock_code) map.set(row.stock_code, row.corp_code);
    }
  }
  return map;
}

/** 같은 data_source의 가장 최근 실행 기록에서 013 비율을 가져온다 — 이번 실행의
 * 013 비율과 비교해 "직전 대비 급증" 여부를 판단하는 기준이 된다. no_data_ratio가
 * 없는(이 감지 로직이 생기기 전) 옛 기록은 비교 기준으로 쓸 수 없어 제외한다. */
async function getPreviousRunNoDataRatio(): Promise<number | null> {
  const { data, error } = await supabaseAdmin
    .from("stock_data_backfill_runs")
    .select("no_data_ratio")
    .eq("data_source", DATA_SOURCE)
    .not("no_data_ratio", "is", null)
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`직전 실행 기록 조회 실패: ${error.message}`);
  return data?.[0]?.no_data_ratio ?? null;
}

async function getExistingPairs(): Promise<Set<string>> {
  const existing = new Set<string>();
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("stock_annual_fundamentals")
      .select("stock_code, fiscal_year")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`기존 재무 데이터 조회 실패: ${error.message}`);
    for (const row of data ?? []) existing.add(`${row.stock_code}:${row.fiscal_year}`);
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return existing;
}

interface DartAccountRow {
  rcept_no: string;
  sj_div: string;
  account_id: string;
  thstrm_amount: string;
}

interface FetchedFundamentals {
  rceptNo: string;
  rceptDate: string;
  fsDiv: "CFS" | "OFS";
  netIncomeParent: number | null;
  equityParent: number | null;
}

// 콜당 평균 응답 시간 — 배치 이상 감지 시 원인 추적 단서로 남긴다(2026-09-08 사건
// 재현 진단에서 정상 시 0.1~0.2초/콜, 사건 재현 시도 시 약 3.8초/콜로 뚜렷한 차이가
// 있었다). 실패로 끝난 시도도 포함해 실제 걸린 시간을 그대로 잰다.
let totalCallLatencyMs = 0;
let callLatencyCount = 0;

async function callSingleAcntAll(
  corpCode: string,
  fiscalYear: number,
  fsDiv: "CFS" | "OFS",
  apiKey: string
): Promise<DartAccountRow[] | null> {
  const url = new URL(`${DART_BASE_URL}/fnlttSinglAcntAll.json`);
  url.searchParams.set("crtfc_key", apiKey);
  url.searchParams.set("corp_code", corpCode);
  url.searchParams.set("bsns_year", String(fiscalYear));
  url.searchParams.set("reprt_code", "11011"); // 사업보고서
  url.searchParams.set("fs_div", fsDiv);

  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(url);
  } finally {
    totalCallLatencyMs += Date.now() - startedAt;
    callLatencyCount++;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { status: string; list?: DartAccountRow[] };

  // status "013"은 "조회된 데이터가 없습니다" — 그 연도에 사업보고서가 없는 경우
  // (상장 전 등)라 정상적인 "없음"으로 취급하고 에러로 올리지 않는다. 그 외에
  // list가 없는 모든 경우(예: 020 요청 제한 초과)는 "없음"으로 조용히 넘기지 않고
  // 에러로 올려 재시도·로그되게 한다 — 013과 다른 실패를 뭉뚱그리면 요청 제한 같은
  // 진짜 문제가 "데이터없음"으로 위장돼 조용히 묻힌다(2026-09-08 사건 이후 추가된
  // 방어 로직, 위 파일 상단 주석 참고).
  if (body.status === "013") return null;
  if (body.status !== "000" || !body.list || body.list.length === 0) {
    throw new Error(`DART 오류 또는 예상치 못한 응답(status=${body.status})`);
  }
  return body.list;
}

async function fetchFundamentals(
  corpCode: string,
  fiscalYear: number,
  apiKey: string
): Promise<FetchedFundamentals | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= CALL_RETRY_COUNT; attempt++) {
    try {
      // 연결재무제표(CFS)를 우선 조회하고, 없으면 별도재무제표(OFS)로 폴백한다 —
      // backfill-dart-cashflow-debt.ts와 동일한 패턴(자회사가 없는 종목은 애초에
      // CFS를 작성하지 않는 경우가 있다).
      let list = await callSingleAcntAll(corpCode, fiscalYear, "CFS", apiKey);
      let fsDiv: "CFS" | "OFS" = "CFS";
      if (!list) {
        list = await callSingleAcntAll(corpCode, fiscalYear, "OFS", apiKey);
        fsDiv = "OFS";
      }
      if (!list) return null;

      const rceptNo = list[0].rcept_no;
      const netIncomeRow = list.find((r) => r.account_id === NET_INCOME_ACCOUNT_ID);
      const equityRow = list.find((r) => r.account_id === EQUITY_ACCOUNT_ID);

      // 접속사·지주사가 아니거나 비지배지분이 없는 회사는 "지배기업 소유주지분"이
      // 별도 항목으로 안 나오고 전체 당기순이익/자본총계 항목만 있을 수 있다 — 이
      // 경우 전체 값을 그대로 쓴다(비지배지분이 없으니 전체=지배지분).
      const fallbackNetIncome = list.find((r) => r.sj_div === "IS" && r.account_id === "ifrs-full_ProfitLoss");
      const fallbackEquity = list.find((r) => r.sj_div === "BS" && r.account_id === "ifrs-full_Equity");

      const netIncomeSource = netIncomeRow ?? fallbackNetIncome;
      const equitySource = equityRow ?? fallbackEquity;

      return {
        rceptNo,
        rceptDate: `${rceptNo.slice(0, 4)}-${rceptNo.slice(4, 6)}-${rceptNo.slice(6, 8)}`,
        fsDiv,
        netIncomeParent: netIncomeSource ? Number(netIncomeSource.thstrm_amount) : null,
        equityParent: equitySource ? Number(equitySource.thstrm_amount) : null,
      };
    } catch (error) {
      lastError = error;
      // 지수 백오프(5초, 10초, 20초) — burst rate limit으로 추정되는 "fetch failed"가
      // 짧은 고정 간격 재시도로는 회복되지 않았던 실측 결과를 반영했다(위 상단 주석 참고).
      if (attempt < CALL_RETRY_COUNT) await sleep(CALL_RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main(): Promise<void> {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) throw new Error("DART_API_KEY 환경 변수가 없습니다.");

  const startedAt = new Date();
  const currentYear = new Date().getFullYear();
  const fiscalYears = Array.from(
    { length: currentYear - FISCAL_YEAR_START },
    (_, i) => FISCAL_YEAR_START + i
  ); // 최신 연도는 아직 사업보고서가 안 나왔을 수 있어 제외(currentYear 미포함)

  console.log("후보종목 발굴 중...");
  const candidates = await discoverCandidates();
  console.log(`후보종목 ${candidates.length}개 (시가총액 1조원 이상 이력 있는 종목)`);

  const corpCodeMap = await getCorpCodeMap(candidates);
  console.log(`corp_code 매핑 확인된 종목 ${corpCodeMap.size}개 (매핑 안 된 ${candidates.length - corpCodeMap.size}개는 건너뜀)`);

  const existingPairs = await getExistingPairs();

  const targets: { stockCode: string; corpCode: string; fiscalYear: number }[] = [];
  for (const stockCode of candidates) {
    const corpCode = corpCodeMap.get(stockCode);
    if (!corpCode) continue;
    for (const fiscalYear of fiscalYears) {
      if (!existingPairs.has(`${stockCode}:${fiscalYear}`)) {
        targets.push({ stockCode, corpCode, fiscalYear });
      }
    }
  }

  console.log(`처리 대상 ${targets.length}건 (이미 있는 조합은 건너뜀)`);
  if (targets.length === 0) {
    console.log("처리할 항목이 없습니다. 이미 최신 상태입니다.");
    return;
  }

  let fetched = 0;
  let skippedNoData = 0;
  let errorCount = 0;
  let completed = 0;
  let fetchedViaCfs = 0;
  let fetchedViaOfs = 0;

  await runWithConcurrency(targets, CONCURRENCY, async (target) => {
    try {
      const result = await fetchFundamentals(target.corpCode, target.fiscalYear, apiKey);
      if (result) {
        const { error } = await supabaseAdmin.from("stock_annual_fundamentals").upsert({
          stock_code: target.stockCode,
          corp_code: target.corpCode,
          fiscal_year: target.fiscalYear,
          fs_div: result.fsDiv,
          rcept_no: result.rceptNo,
          rcept_date: result.rceptDate,
          net_income_parent: result.netIncomeParent,
          equity_parent: result.equityParent,
        });
        if (error) throw new Error(error.message);
        fetched++;
        if (result.fsDiv === "OFS") fetchedViaOfs++;
        else fetchedViaCfs++;
      } else {
        skippedNoData++;
      }
    } catch (error) {
      errorCount++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${target.stockCode} FY${target.fiscalYear} 실패: ${message}`);
    } finally {
      completed++;
      if (completed % 200 === 0 || completed === targets.length) {
        console.log(`진행: ${completed}/${targets.length}건 (채움 ${fetched}, 데이터없음 ${skippedNoData}, 실패 ${errorCount})`);
      }
    }
  });

  const noDataRatio = targets.length > 0 ? skippedNoData / targets.length : 0;
  const avgResponseTimeMs = callLatencyCount > 0 ? totalCallLatencyMs / callLatencyCount : null;
  const fetchedRatio = targets.length > 0 ? fetched / targets.length : 0;

  const previousNoDataRatio = await getPreviousRunNoDataRatio();
  const anomalyReasons: string[] = [];
  if (fetchedRatio < MIN_FETCHED_RATIO) {
    anomalyReasons.push(
      `채움 비율 부족(${fetched}/${targets.length}건, ${(fetchedRatio * 100).toFixed(2)}% < 임계값 ${(MIN_FETCHED_RATIO * 100).toFixed(2)}%)`
    );
  }
  if (previousNoDataRatio === null) {
    console.log("비교할 직전 실행 기록이 없어 013 비율 변화 판정은 건너뜁니다.");
  } else {
    const jumpPp = noDataRatio - previousNoDataRatio;
    if (jumpPp >= NO_DATA_RATIO_JUMP_THRESHOLD_PP) {
      anomalyReasons.push(
        `013 비율 급증(직전 ${(previousNoDataRatio * 100).toFixed(1)}% → 이번 ${(noDataRatio * 100).toFixed(1)}%, +${(jumpPp * 100).toFixed(1)}%p ≥ 임계값 ${(NO_DATA_RATIO_JUMP_THRESHOLD_PP * 100).toFixed(0)}%p)`
      );
    }
  }
  const status = anomalyReasons.length > 0 ? "anomaly" : "success";

  const { error: checkpointError } = await supabaseAdmin.from("stock_data_backfill_runs").insert({
    data_source: DATA_SOURCE,
    last_completed_date: null,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    rows_fetched: fetched,
    error_count: errorCount,
    status,
    total_targets: targets.length,
    no_data_ratio: noDataRatio,
    avg_response_time_ms: avgResponseTimeMs,
  });
  if (checkpointError) console.error(`체크포인트 저장 실패: ${checkpointError.message}`);

  console.log(
    `DART 재무 백필 완료: 채움 ${fetched}건(CFS ${fetchedViaCfs}, OFS ${fetchedViaOfs}), 데이터없음 ${skippedNoData}건, 실패 ${errorCount}건 (실패분은 다음 실행에서 재시도됨)`
  );
  console.log(
    `데이터없음 비율 ${(noDataRatio * 100).toFixed(1)}%, 콜당 평균 응답 시간 ${avgResponseTimeMs?.toFixed(0) ?? "?"}ms, 배치 상태: ${status}`
  );
  if (status === "anomaly") {
    console.warn(`이상 종료로 기록됨 — ${anomalyReasons.join("; ")}`);
  }
}

main().catch((error) => {
  console.error("백필 중 오류:", error);
  process.exit(1);
});

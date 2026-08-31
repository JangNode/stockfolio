/**
 * 한국 주식(KOSPI+KOSDAQ) 전종목을 대상으로 저장된 전략들을 스캔해 screening_results
 * 테이블을 갱신하는 배치 스크립트. GitHub Actions에서 매일 실행된다 (.github/workflows/screening.yml).
 *
 * server-only로 막힌 lib/kis.ts, lib/supabaseAdmin.ts, lib/stockMaster.ts를 순수 Node
 * 스크립트에서도 그대로 재사용하기 위해 "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/screen-all-stocks.ts
 * (package.json의 screen:all-stocks 스크립트가 이 플래그를 포함한다.)
 *
 * 필요 환경변수: KIS_APP_KEY, KIS_APP_SECRET, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getDailyPrices, getKisCallStats, getStockPrice } from "@/lib/kis";
import { getAllStocks, type StockEntry } from "@/lib/stockMaster";
import {
  computeEntryPlan,
  evaluateConsecutiveDividendYears,
  evaluateTrackingStatus,
  matchesToday,
  type DailyPrice,
  type StrategyRule,
  type StrategyRuleType,
} from "@/lib/backtest";
import { computeSignalScore, MIN_SCREENING_SCORE } from "@/lib/screeningScore";
import { getDailyPrice, discoverCandidateStockCodes } from "@/lib/stockDailyPricesStorage";
import {
  loadFundamentalsSeries,
  loadFundamentalsSeriesWithListedShares,
  pickFundamentalsAsOf,
  pickDividendsPaidAsOf,
  computeValuationFromSeries,
  type FundamentalsSeries,
} from "@/lib/stockFundamentals";
import { selectEpsCagrFiscalYears, computeEpsCagrFromResolvedShares, computePeg, type ListedSharesByFiscalYear } from "@/lib/pegRatio";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK } from "@/lib/stockDataConfig";
import { DH_MIN_CONSECUTIVE_DIVIDEND_YEARS } from "@/lib/dhStrategyConfig";
import { THEME_CODES, THEME_LABELS, THEME_CONSTITUENTS_RETENTION_YEARS, type ThemeCode } from "@/lib/themeConfig";

// ===== 잡주 필터링 조건 (숫자/목록 조정은 여기서) =====
// 종목명에 이 문자열이 포함되면 제외한다 (스팩).
const EXCLUDED_NAME_SUBSTRINGS = ["스팩"];
// 종목마스터의 종목구분코드 기준 제외 대상: RT=리츠, EF=ETF, EN=ETN.
const EXCLUDED_PRODUCT_TYPES = new Set(["RT", "EF", "EN"]);
// 상장 후 이 개월 수 미만인 종목은 제외한다 (신규 상장 변동성 회피).
const MIN_LISTED_MONTHS = 6;
// 이 시가총액(억원) 미만인 종목은 제외한다.
const MIN_MARKET_CAP_EOK = 500;
// 이 가격(원) 미만인 종목(동전주)은 제외한다.
const MIN_PRICE_WON = 1000;
// 점수 계산(안정성 항목)에서 시가총액이 이 값(억원) 이상이면 만점으로 친다.
const MARKET_CAP_SCORE_FULL_EOK = 10000;

// 스크리닝은 조건 판정만 하면 되므로 차트용 최대치(500건)가 아니라 필요 최소한만 가져온다.
// 미너비니 템플릿은 250거래일 신고/신저가 조건 때문에 250~300건이 필요해 KIS 페이지당
// 한도(100건) 상 종목당 최대 3회 호출이 든다 — ma_cross만 등록돼 있다면 훨씬 적게 든다.
// 실제 초당 호출 제한은 lib/kis.ts의 우선순위 토큰버킷이 지킨다(이 배치는 "batch"
// 우선순위로 호출하므로 사용자 요청보다 낮은 한도 안에서 돈다). 여기서는 그 한도를
// 최대한 채워 쓰도록 여러 종목을 동시에 처리한다 — 아래 BATCH_CONCURRENCY 참고.
const DAILY_TARGET_ROWS_DEFAULT = 100;
const MINERVINI_DAILY_TARGET_ROWS = 300;

// 동시에 진행할 최대 종목 수. 실제 처리량은 lib/kis.ts의 토큰버킷(배치 초당 12건)이
// 최종적으로 제한하므로, 이 값은 "그 12건/초를 항상 채울 만큼만" 있으면 된다 — 너무
// 작으면 요청 사이 네트워크 왕복 시간 동안 큐가 비어 처리량이 12건/초에 못 미치고,
// 너무 크면 (동시 요청 수 × 네트워크/메모리) 자원만 낭비하고 속도에는 도움이 안 된다.
const BATCH_CONCURRENCY = 10;

const CALL_RETRY_COUNT = 2;
const CALL_RETRY_DELAY_MS = 2000;
const PROGRESS_LOG_INTERVAL = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * items를 최대 limit개까지 동시에 처리한다. worker 안에서 발생한 예외는 이 함수
 * 밖으로 던지지 않는다고 가정한다(각 호출부가 자체적으로 흡수해서 다른 종목 처리에
 * 영향이 가지 않게 한다) — 그래야 하나가 실패해도 워커가 죽지 않고 계속 다음
 * 항목을 집어간다. 완료 순서가 입력 순서와 다를 수 있으므로, 호출부의 진행 로그는
 * "몇 번째 항목인지"가 아니라 "몇 개가 끝났는지" 기준으로 찍어야 한다.
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;

  async function runOne(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, runOne)
  );
}

/** kis.ts 내부적으로도 초당 제한(EGW00201)에 대한 재시도가 있지만, 그 외의 일시적 오류
 * (네트워크 오류, 게이트웨이 오류 등)까지 흡수하기 위한 한 겹 더 바깥의 재시도. */
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= CALL_RETRY_COUNT; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < CALL_RETRY_COUNT) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`    [재시도 ${attempt + 1}/${CALL_RETRY_COUNT}] ${label}: ${message}`);
        await sleep(CALL_RETRY_DELAY_MS);
      }
    }
  }

  throw lastError;
}

type StrategyRow = StrategyRule & { id: string; name: string | null };

async function loadStrategies(): Promise<StrategyRow[]> {
  // market="US" 전략은 screen-us-stocks.ts가 별도로 스캔한다 — 여기서 같이 돌리면
  // 국내 일봉 데이터에 미국 전략 조건을 판정해 의미 없는 결과가 쌓인다.
  const { data, error } = await supabaseAdmin
    .from("strategies")
    .select("id, name, rule_type, rule_params")
    .eq("market", "KR");

  if (error) throw new Error(`전략 조회 실패: ${error.message}`);
  return (data ?? []) as StrategyRow[];
}

/**
 * 등록된 전략들이 필요로 하는 최대 일봉 건수를 계산한다. 종목당 한 번만 조회해서 모든
 * 전략 판정에 재사용하므로, 가장 많이 필요로 하는 전략 기준으로 한 번에 넉넉히 가져온다.
 */
function computeDailyTargetRows(strategies: StrategyRow[]): number {
  let target = DAILY_TARGET_ROWS_DEFAULT;

  for (const strategy of strategies) {
    if (strategy.rule_type === "minervini_trend_template") {
      target = Math.max(target, MINERVINI_DAILY_TARGET_ROWS);
    } else if (strategy.rule_type === "ma_cross") {
      target = Math.max(target, strategy.rule_params.long_period + 20);
    } else if (strategy.rule_type === "custom_composite") {
      const { ma_cross, rsi, volume_surge } = strategy.rule_params;
      const maxPeriod = Math.max(ma_cross?.long_period ?? 0, rsi?.period ?? 0, volume_surge?.period ?? 0);
      target = Math.max(target, maxPeriod + 20);
    }
    // dh_value_dividend는 KIS 일봉을 아예 안 쓰므로(scanFundamentalStrategies가 별도
    // 경로로 처리) 여기 대상에서 제외한다 — target에 영향 없음.
  }

  return target;
}

/** 상장일자(YYYYMMDD) 기준으로 상장 후 지난 개월 수를 계산한다. 파싱 실패 시 null. */
function monthsSinceListing(listedDate: string | null, now: Date): number | null {
  if (!listedDate) return null;

  const year = Number(listedDate.slice(0, 4));
  const month = Number(listedDate.slice(4, 6));
  const day = Number(listedDate.slice(6, 8));
  // Date 생성자는 범위를 벗어난 월/일을 예외 없이 다른 날짜로 밀어버리므로(예: 0월 0일 →
  // 전년도 12월 어느 날), "00000000" 같은 빈 값을 걸러내려면 먼저 범위를 직접 검증해야 한다.
  if (year < 1950 || month < 1 || month > 12 || day < 1 || day > 31) return null;

  const listed = new Date(year, month - 1, day);
  if (Number.isNaN(listed.getTime())) return null;

  return (
    (now.getFullYear() - listed.getFullYear()) * 12 +
    (now.getMonth() - listed.getMonth()) -
    (now.getDate() < listed.getDate() ? 1 : 0)
  );
}

interface MasterFilterCounts {
  spac: number;
  reitEtfEtn: number;
  newlyListed: number;
  delistingRisk: number;
}

/**
 * 종목마스터 정보만으로 판단 가능한 조건(스팩/리츠·ETF·ETN/신규상장/상장폐지 위험)을
 * 개별 시세 API 호출 전에 걸러낸다. 상장일을 파싱하지 못한 종목은 신규상장 여부를 알
 * 수 없으므로 걸러내지 않고 통과시킨다 — 데이터가 없다고 잘못 제외하는 것보다 안전하다.
 */
function filterByMaster(
  stocks: StockEntry[]
): { survivors: StockEntry[]; counts: MasterFilterCounts } {
  const now = new Date();
  const counts: MasterFilterCounts = { spac: 0, reitEtfEtn: 0, newlyListed: 0, delistingRisk: 0 };
  const survivors: StockEntry[] = [];

  for (const stock of stocks) {
    if (EXCLUDED_NAME_SUBSTRINGS.some((s) => stock.name.includes(s))) {
      counts.spac++;
      continue;
    }
    if (EXCLUDED_PRODUCT_TYPES.has(stock.productType)) {
      counts.reitEtfEtn++;
      continue;
    }
    if (stock.isTradingHalted || stock.isLiquidationTrading || stock.isAdministrativeIssue) {
      counts.delistingRisk++;
      continue;
    }

    const months = monthsSinceListing(stock.listedDate, now);
    if (months !== null && months < MIN_LISTED_MONTHS) {
      counts.newlyListed++;
      continue;
    }

    survivors.push(stock);
  }

  return { survivors, counts };
}

export interface ChangeRateEntry {
  name: string;
  changeRate: number;
}

/**
 * 종목마스터에 없는 조건(시가총액, 동전주 여부)은 시세 조회로 걸러낸다. 이후 단계인
 * 일봉 수집(종목당 최대 3회 호출)보다 먼저 실행해, 여기서 제외되는 종목은 그 호출을
 * 아예 하지 않게 한다.
 */
async function filterByQuote(
  stocks: StockEntry[]
): Promise<{
  survivors: StockEntry[];
  marketCapByCode: Map<string, number>;
  changeRateByCode: Map<string, ChangeRateEntry>;
  excludedCount: number;
  fetchErrors: number;
}> {
  const survivors: StockEntry[] = [];
  // 시세 필터 단계에서 이미 조회한 시가총액을 점수 계산(안정성 항목)에 재사용한다 —
  // 그 단계 이후 별도로 다시 조회하지 않는다.
  const marketCapByCode = new Map<string, number>();
  // 테마별 등락률 집계(scripts 뒷부분)에 재사용하려고, 여기서 이미 조회한 전일대비
  // 등락율을 시가총액/동전주 기준 통과 여부와 무관하게 모아둔다 — 새 KIS 호출을
  // 늘리지 않기 위해서다. 저시가총액/동전주로 스크리닝 대상에서는 빠지더라도 테마
  // 등락률 집계에는 포함시킨다(테마 대표성이 스크리닝 후보 조건과 같을 필요는 없다).
  const changeRateByCode = new Map<string, ChangeRateEntry>();
  let excludedCount = 0;
  let fetchErrors = 0;
  let completed = 0;

  await runWithConcurrency(stocks, BATCH_CONCURRENCY, async (stock) => {
    try {
      const price = await withRetry(
        () => getStockPrice(stock.code, "batch"),
        `${stock.code}(${stock.name}) 시세 조회`
      );

      changeRateByCode.set(stock.code, { name: stock.name, changeRate: price.changeRate });

      if (price.currentPrice < MIN_PRICE_WON || price.marketCapEok < MIN_MARKET_CAP_EOK) {
        excludedCount++;
      } else {
        survivors.push(stock);
        marketCapByCode.set(stock.code, price.marketCapEok);
      }
    } catch (error) {
      fetchErrors++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `    ${stock.code}(${stock.name}) 시세 조회 실패, 이번 실행에서는 건너뜁니다: ${message}`
      );
    } finally {
      completed++;
      if (
        completed === 1 ||
        completed % PROGRESS_LOG_INTERVAL === 0 ||
        completed === stocks.length
      ) {
        console.log(
          `  [${completed}/${stocks.length}] 시세 필터 진행 중... (제외 ${excludedCount}건, 조회 실패 ${fetchErrors}건)`
        );
      }
    }
  });

  return { survivors, marketCapByCode, changeRateByCode, excludedCount, fetchErrors };
}

interface ActiveRow {
  id: string;
  stock_code: string;
  entry_price: number;
  stop_loss_price: number;
  take_profit_price: number;
}

/** status=active인 기존 추적 종목의 현재가를 갱신하고, 손절/익절 조건에 걸리면 종료 처리한다. */
async function updateActiveTracking(): Promise<{
  updated: number;
  stopped: number;
  profited: number;
}> {
  console.log("=== 1단계: 기존 추적 종목 갱신 ===");

  // market="US" 행은 별도 배치(screen-us-stocks.ts)가 다룬다 — 이 함수가 국내
  // getStockPrice(6자리 종목코드 전제)로 미국 티커를 조회하면 잘못된 값을 받거나
  // 실패하므로 반드시 국내 행만 골라야 한다.
  const { data: activeRows, error } = await supabaseAdmin
    .from("screening_results")
    .select("id, stock_code, entry_price, stop_loss_price, take_profit_price")
    .eq("status", "active")
    .eq("market", "KR");

  if (error) throw new Error(`추적 종목 조회 실패: ${error.message}`);

  if (!activeRows || activeRows.length === 0) {
    console.log("추적 중인 종목이 없습니다.");
    return { updated: 0, stopped: 0, profited: 0 };
  }

  // 같은 종목이 여러 전략에서 동시에 active일 수 있으니 종목코드별로 현재가를 한 번만 조회한다.
  const uniqueCodes = Array.from(new Set(activeRows.map((r) => r.stock_code)));
  console.log(`추적 중인 종목 ${activeRows.length}건 (종목코드 기준 ${uniqueCodes.length}개)`);

  const priceByCode = new Map<string, number>();
  let completed = 0;

  await runWithConcurrency(uniqueCodes, BATCH_CONCURRENCY, async (code) => {
    try {
      const price = await withRetry(
        () => getStockPrice(code, "batch"),
        `${code} 현재가 조회`
      );
      priceByCode.set(code, price.currentPrice);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`    ${code} 현재가 조회 실패, 이번 실행에서는 건너뜁니다: ${message}`);
    } finally {
      completed++;
      if (
        completed === 1 ||
        completed % PROGRESS_LOG_INTERVAL === 0 ||
        completed === uniqueCodes.length
      ) {
        console.log(`  [${completed}/${uniqueCodes.length}] 현재가 조회 진행 중...`);
      }
    }
  });

  let updated = 0;
  let stopped = 0;
  let profited = 0;

  for (const row of activeRows as ActiveRow[]) {
    const currentPrice = priceByCode.get(row.stock_code);
    if (currentPrice === undefined) continue;

    const returnPct = ((currentPrice - row.entry_price) / row.entry_price) * 100;
    const status = evaluateTrackingStatus(
      currentPrice,
      row.stop_loss_price,
      row.take_profit_price
    );

    const update: Record<string, unknown> = {
      current_price: currentPrice,
      return_pct: returnPct,
    };
    if (status !== "active") {
      update.status = status;
      update.closed_at = new Date().toISOString();
    }

    const { error: updateError } = await supabaseAdmin
      .from("screening_results")
      .update(update)
      .eq("id", row.id);

    if (updateError) {
      console.error(`    ${row.stock_code} 갱신 실패: ${updateError.message}`);
      continue;
    }

    updated++;
    if (status === "stopped") {
      stopped++;
      console.log(`    ✕ 손절 처리: ${row.stock_code} (${currentPrice} ≤ ${row.stop_loss_price})`);
    } else if (status === "profited") {
      profited++;
      console.log(`    ✓ 익절 처리: ${row.stock_code} (${currentPrice} ≥ ${row.take_profit_price})`);
    }
  }

  console.log(`갱신 완료: ${updated}건 (손절 ${stopped}건, 익절 ${profited}건)`);
  return { updated, stopped, profited };
}

interface StockPriceEntry {
  name: string;
  prices: DailyPrice[];
}

/**
 * 전종목의 일봉 데이터를 종목당 정확히 한 번씩만 조회해 메모리에 모은다. 이렇게 모아둔
 * 데이터를 이후 전략별 판정 단계에서 재사용하므로, 등록된 전략이 몇 개든 종목당 조회
 * 횟수는 늘지 않는다.
 */
async function collectDailyPrices(
  allStocks: { code: string; name: string }[],
  dailyTargetRows: number
): Promise<{ priceByCode: Map<string, StockPriceEntry>; fetchErrors: number }> {
  console.log(`=== 3단계: 전종목 일봉 데이터 수집 (종목당 ${dailyTargetRows}건) ===`);

  const priceByCode = new Map<string, StockPriceEntry>();
  let fetchErrors = 0;
  let completed = 0;

  await runWithConcurrency(allStocks, BATCH_CONCURRENCY, async (stock) => {
    try {
      const prices = await withRetry(
        () => getDailyPrices(stock.code, "D", dailyTargetRows, "batch"),
        `${stock.code}(${stock.name}) 일봉 조회`
      );
      if (prices.length > 0) {
        priceByCode.set(stock.code, { name: stock.name, prices });
      }
    } catch (error) {
      fetchErrors++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`    ${stock.code}(${stock.name}) 일봉 조회 실패, 건너뜁니다: ${message}`);
    } finally {
      completed++;
      if (
        completed === 1 ||
        completed % PROGRESS_LOG_INTERVAL === 0 ||
        completed === allStocks.length
      ) {
        console.log(`  [${completed}/${allStocks.length}] 데이터 수집 중... (조회 실패 ${fetchErrors}건)`);
      }
    }
  });

  console.log(`데이터 수집 완료: ${priceByCode.size}개 종목 확보, 조회 실패 ${fetchErrors}건`);
  return { priceByCode, fetchErrors };
}

/**
 * 전략 하나를 이미 수집된 전종목 데이터에 대해 판정한다. 이 전략에서 발생하는 오류(판정
 * 함수 버그, 저장 실패 등)는 여기서만 처리되어 다른 전략의 판정에 영향을 주지 않는다.
 */
async function runStrategyScan(
  strategy: StrategyRow,
  priceByCode: Map<string, StockPriceEntry>,
  activeKeys: Set<string>,
  marketCapByCode: Map<string, number>
): Promise<{ matched: number; lowScore: number; errors: number }> {
  const label = `${strategy.name ?? strategy.rule_type}(${strategy.rule_type})`;
  console.log(`  --- [${label}] 판정 시작 (대상 ${priceByCode.size}종목) ---`);

  let matched = 0;
  let lowScore = 0;
  let errors = 0;

  // 실험실에서 채택된 custom_composite 전략은 rule_params.fundamentals(시가총액/PER/
  // PBR/PEG/배당 연속 지급 연수/배당수익률)를 실을 수 있다 — 이 값은 KIS 일봉(prices)엔
  // 없고 DH 가격 레이어 + 재무 이력을 종목마다 추가 조회해야 판정할 수 있다. 매번
  // 전종목에 대해 조회하면 비용이 크므로, 이평/RSI/거래량 같은 기술 조건이 하나라도
  // 같이 지정돼 있으면 그것부터(DB 호출 없이) 먼저 확인해 이미 기술 조건에서 탈락하는
  // 종목은 펀더멘털 조회를 건너뛴다(AND 조합이므로 기술 조건이 거짓이면 전체도 거짓).
  // 기술 조건이 전혀 없는(펀더멘털 단독) 전략은 이 사전 필터를 쓸 수 없어 전종목을
  // 조회한다.
  const fundamentalConditions =
    strategy.rule_type === "custom_composite" ? strategy.rule_params.fundamentals : undefined;
  const needsListedShares = fundamentalConditions?.peg !== undefined;
  const hasTechnicalConditions =
    strategy.rule_type === "custom_composite" &&
    (strategy.rule_params.ma_cross !== undefined ||
      strategy.rule_params.rsi !== undefined ||
      strategy.rule_params.volume_surge !== undefined);

  for (const [stockCode, { name: stockName, prices }] of priceByCode) {
    try {
      let evalPrices = prices;

      if (fundamentalConditions && strategy.rule_type === "custom_composite") {
        if (hasTechnicalConditions) {
          const technicalOnlyRule: StrategyRule = {
            rule_type: "custom_composite",
            rule_params: {
              ma_cross: strategy.rule_params.ma_cross,
              rsi: strategy.rule_params.rsi,
              volume_surge: strategy.rule_params.volume_surge,
            },
          };
          if (!matchesToday(prices, technicalOnlyRule)) continue;
        }

        const today = prices[prices.length - 1].date;
        const [priceRow, fundamentalsData] = await Promise.all([
          getDailyPrice(stockCode, today),
          needsListedShares
            ? loadFundamentalsSeriesWithListedShares(stockCode)
            : loadFundamentalsSeries(stockCode).then((series) => ({ series, listedSharesByFiscalYear: undefined })),
        ]);
        if (!priceRow) continue; // DH 가격 레이어에 오늘자 데이터 없음(백필 하한 미달 등) — 판정 불가로 건너뜀

        evalPrices = [
          ...prices.slice(0, -1),
          { ...prices[prices.length - 1], marketCapEok: priceRow.marketCapEok, listedShares: priceRow.listedShares },
        ];

        if (!matchesToday(evalPrices, strategy, fundamentalsData.series, fundamentalsData.listedSharesByFiscalYear)) continue;
      } else {
        if (!matchesToday(evalPrices, strategy)) continue;
      }

      const key = `${strategy.id}:${stockCode}`;
      if (activeKeys.has(key)) continue; // 이미 추적 중

      const signalPrice = evalPrices[evalPrices.length - 1].close;
      const { entryPrice, stopLossPrice, takeProfitPrice } = computeEntryPlan(evalPrices, strategy);
      const marketCapEok = marketCapByCode.get(stockCode) ?? null;
      const score = computeSignalScore(
        evalPrices,
        strategy,
        marketCapEok === null ? null : marketCapEok / MARKET_CAP_SCORE_FULL_EOK
      );

      if (score <= MIN_SCREENING_SCORE) {
        lowScore++;
        continue;
      }

      const { error: insertError } = await supabaseAdmin.from("screening_results").insert({
        strategy_id: strategy.id,
        stock_code: stockCode,
        stock_name: stockName,
        signal_price: signalPrice,
        entry_price: entryPrice,
        stop_loss_price: stopLossPrice,
        take_profit_price: takeProfitPrice,
        current_price: signalPrice,
        return_pct: 0,
        status: "active",
        score,
        market: "KR",
      });

      if (insertError) {
        errors++;
        console.error(`    [${label}] ${stockCode} 저장 실패: ${insertError.message}`);
        continue;
      }

      activeKeys.add(key); // 같은 실행 내 중복 방지(다른 전략 판정과도 공유되는 집합)
      matched++;
      console.log(
        `    [${label}] ✓ 신규 매칭: ${stockName}(${stockCode}) (진입가 ${entryPrice.toLocaleString("ko-KR")}, 점수 ${score})`
      );
    } catch (error) {
      // 판정 함수 자체가 예외를 던지는 경우(버그, 예상 밖의 rule_params 등)까지 종목
      // 단위로 흡수해 이 전략의 나머지 종목 판정과 다른 전략에 영향이 가지 않게 한다.
      errors++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`    [${label}] ${stockCode} 판정 중 오류, 건너뜁니다: ${message}`);
    }
  }

  console.log(
    `  --- [${label}] 판정 완료: 신규 매칭 ${matched}건, 저점수 제외 ${lowScore}건, 오류 ${errors}건 ---`
  );
  return { matched, lowScore, errors };
}

/** 전종목을 스캔해 저장된 전략 조건을 새로 만족하는 종목을 screening_results에 추가한다.
 * changeRateByCode는 테마별 등락률 집계(computeAndStoreThemeReturns)에 재사용한다 —
 * 등록된 전략이 없어 시세 필터 자체를 돌지 않은 날은 빈 맵을 돌려주고, 그날은 테마
 * 등락률 갱신도 건너뛴다(새 KIS 호출을 추가하지 않기 위해서다). */
async function scanAllStocks(
  strategies: StrategyRow[]
): Promise<{ scanned: number; matched: number; errors: number; changeRateByCode: Map<string, ChangeRateEntry> }> {
  if (strategies.length === 0) {
    console.log("등록된 전략이 없어 스캔을 건너뜁니다.");
    return { scanned: 0, matched: 0, errors: 0, changeRateByCode: new Map() };
  }

  console.log("=== 2단계: 잡주 필터링 ===");

  const allStocks = await getAllStocks();
  const { survivors: masterSurvivors, counts: masterCounts } = filterByMaster(allStocks);
  console.log(
    `  마스터 필터: ${allStocks.length}개 → ${masterSurvivors.length}개 ` +
      `(스팩 ${masterCounts.spac}개, 리츠/ETF/ETN ${masterCounts.reitEtfEtn}개, ` +
      `상장폐지 위험(거래정지/정리매매/관리종목) ${masterCounts.delistingRisk}개, ` +
      `신규상장 ${masterCounts.newlyListed}개 제외)`
  );

  console.log(`  시세 필터 조회 중... (대상 ${masterSurvivors.length}개)`);
  const {
    survivors: finalStocks,
    marketCapByCode,
    changeRateByCode,
    excludedCount: quoteExcluded,
    fetchErrors: quoteFetchErrors,
  } = await filterByQuote(masterSurvivors);
  console.log(
    `  시세 필터: ${masterSurvivors.length}개 → ${finalStocks.length}개 ` +
      `(저시가총액/동전주 ${quoteExcluded}개 제외, 조회 실패 ${quoteFetchErrors}건)`
  );
  console.log(`최종 스캔 대상: ${finalStocks.length}개 종목`);

  const dailyTargetRows = computeDailyTargetRows(strategies);
  const callsPerStock = Math.ceil(dailyTargetRows / 100);
  console.log(
    `등록 전략 ${strategies.length}개(${strategies
      .map((s) => s.rule_type)
      .join(", ")}), 종목당 일봉 ${dailyTargetRows}건(호출 ${callsPerStock}회)`
  );

  const { priceByCode, fetchErrors } = await collectDailyPrices(finalStocks, dailyTargetRows);

  // 이미 추적 중인 (전략, 종목) 쌍은 다시 추가하지 않는다. 여러 전략 판정이 공유하는
  // 집합이라, 한 전략에서 새로 매칭된 것도 곧바로 다른 전략 판정에 반영된다(같은 종목을
  // 서로 다른 전략이 중복으로 추적하는 건 막지 않는다 — strategy_id가 다르면 별개 추적).
  const { data: existingActive, error: activeError } = await supabaseAdmin
    .from("screening_results")
    .select("strategy_id, stock_code")
    .eq("status", "active");

  if (activeError) throw new Error(`추적 중인 종목 조회 실패: ${activeError.message}`);

  const activeKeys = new Set(
    (existingActive ?? []).map((r) => `${r.strategy_id}:${r.stock_code}`)
  );

  console.log(`=== 4단계: 전략별 판정 (${strategies.length}개 전략, 전략마다 독립적으로 진행) ===`);

  let totalMatched = 0;
  let totalLowScore = 0;
  let totalErrors = fetchErrors + quoteFetchErrors;

  for (const strategy of strategies) {
    try {
      const { matched, lowScore, errors } = await runStrategyScan(
        strategy,
        priceByCode,
        activeKeys,
        marketCapByCode
      );
      totalMatched += matched;
      totalLowScore += lowScore;
      totalErrors += errors;
    } catch (error) {
      // runStrategyScan 내부에서 이미 종목 단위로 오류를 흡수하지만, 혹시 그 바깥에서
      // 예외가 터지더라도(예: 전략 판정 자체가 준비 단계에서 실패) 다른 전략 판정은
      // 계속 진행되도록 여기서 한 번 더 막는다.
      totalErrors++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `  전략 "${strategy.name ?? strategy.rule_type}" 판정이 처리되지 않은 오류로 중단됐습니다: ${message}`
      );
    }
  }

  console.log(
    `스캔 완료: 신규 매칭 ${totalMatched}건, 저점수(${MIN_SCREENING_SCORE}점 이하) 제외 ${totalLowScore}건, 오류 ${totalErrors}건`
  );
  return { scanned: finalStocks.length, matched: totalMatched, errors: totalErrors, changeRateByCode };
}

// dh_value_dividend처럼 KIS 일봉이 아니라 lib/stockDailyPricesStorage.ts(종가/시가총액/
// 상장주식수, DH 백필 인프라) + lib/stockFundamentals.ts(point-in-time 재무/배당)를 쓰는
// 전략들. 위 scanAllStocks/collectDailyPrices와는 데이터 소스 자체가 달라 별도 경로로
// 처리한다(가격 히스토리도 필요 없다 — 조건 자체가 매일 재평가되는 단일 시점 재무
// 스냅샷 판정이라 오늘 하루치 데이터면 충분하다).
const FUNDAMENTAL_RULE_TYPES = new Set<StrategyRuleType>(["dh_value_dividend", "peg_lynch"]);

// 1단계(scripts/backfill-stock-daily-prices.ts)의 BACKFILL_START_YEAR와 동일해야
// 후보종목이 빠짐없이 뽑힌다.
const FUNDAMENTAL_CANDIDATE_START_YEAR = 2011;

/** 백필 기간 중 단 하루라도 후보 기준(STOCK_DATA_CANDIDATE_MARKET_CAP_EOK) 시가총액을
 * 넘은 적 있는 종목을 뽑는다 — dh_value_dividend 등 펀더멘털 전략의 스캔 대상 풀이다.
 * "오늘 기준"이 아니라 실측 과거 시가총액을 쓰므로 생존편향이 없고, 그보다 작은
 * 종목은 애초에 DH 가격 레이어에 데이터가 없다. */
async function discoverFundamentalCandidates(): Promise<string[]> {
  const currentYear = new Date().getUTCFullYear();
  const years = Array.from(
    { length: currentYear - FUNDAMENTAL_CANDIDATE_START_YEAR + 1 },
    (_, i) => FUNDAMENTAL_CANDIDATE_START_YEAR + i
  );
  return discoverCandidateStockCodes(years, STOCK_DATA_CANDIDATE_MARKET_CAP_EOK);
}

/** 판단 근거 로그(screening_results.signal_details)에 남길 시가총액/PER/PBR/배당
 * 지급 연도를 만든다. 실제 매칭 판정(computeDhValueDividendStates)과 같은 point-in-time
 * 규칙을 재사용한다. */
function buildFundamentalSignalDetails(
  closePrice: number,
  marketCapEok: number,
  listedShares: number,
  fundamentals: FundamentalsSeries,
  today: string
): Record<string, unknown> {
  const fund = pickFundamentalsAsOf(fundamentals, today);
  const { per, pbr } = computeValuationFromSeries(closePrice, listedShares, fund);
  const dividends = pickDividendsPaidAsOf(fundamentals, today);
  const { paidYears } = evaluateConsecutiveDividendYears(dividends, today, DH_MIN_CONSECUTIVE_DIVIDEND_YEARS);

  return {
    market_cap_eok: marketCapEok,
    per,
    pbr,
    dividend_years_paid: paidYears,
  };
}

/** 판단 근거 로그에 남길 PER/EPS 성장률/PEG를 만든다. 실제 매칭 판정
 * (computePegLynchStates)과 같은 point-in-time 규칙을 재사용한다. */
function buildPegLynchSignalDetails(
  closePrice: number,
  listedShares: number,
  fundamentals: FundamentalsSeries,
  listedSharesByFiscalYear: ListedSharesByFiscalYear | undefined,
  today: string
): Record<string, unknown> {
  const fund = pickFundamentalsAsOf(fundamentals, today);
  const { per } = computeValuationFromSeries(closePrice, listedShares, fund);

  const pair = selectEpsCagrFiscalYears(fundamentals, today);
  const growthPct = pair && listedSharesByFiscalYear ? computeEpsCagrFromResolvedShares(pair, listedSharesByFiscalYear) : null;
  const peg = computePeg(per, growthPct);

  return { per, eps_growth_pct: growthPct, peg };
}

/**
 * dh_value_dividend/peg_lynch 등 펀더멘털 전략을 스캔한다. 대상은
 * discoverFundamentalCandidates로 좁힌 뒤(DH 데이터 자체가 그만큼만 있음) 마스터
 * 필터(스팩/리츠/ETF/ETN/상장폐지 위험)를 적용하고, 종목당 오늘자 시세 1건 + 재무/
 * 배당 전체 이력 1회만 조회한다(가격 히스토리 불필요). peg_lynch가 등록돼 있으면
 * EPS 성장률 계산에 필요한 연도별 상장주식수도 함께 조회한다(loadFundamentalsSeriesWithListedShares
 * — dh_value_dividend만 있으면 이 추가 조회를 하지 않는다). 신호 품질 점수
 * (computeSignalScore)는 이평선/추세 기반이라 이 전략들엔 안 맞아 계산하지 않는다
 * (score를 null로 저장) — 조건 자체가 이미 엄격한 임계값 필터라 별도 품질 등급이
 * 필요하지 않다.
 */
async function scanFundamentalStrategies(
  strategies: StrategyRow[]
): Promise<{ matched: number; errors: number }> {
  const targets = strategies.filter((s) => FUNDAMENTAL_RULE_TYPES.has(s.rule_type));
  if (targets.length === 0) return { matched: 0, errors: 0 };

  console.log(`=== 펀더멘털 전략 판정 (${targets.length}개: ${targets.map((s) => s.rule_type).join(", ")}) ===`);

  const needsListedShares = targets.some((s) => s.rule_type === "peg_lynch");

  const [allStocks, candidateCodes] = await Promise.all([getAllStocks(), discoverFundamentalCandidates()]);
  const { survivors: masterSurvivors } = filterByMaster(allStocks);
  const survivorByCode = new Map(masterSurvivors.map((s) => [s.code, s]));
  const candidates = candidateCodes
    .map((code) => survivorByCode.get(code))
    .filter((s): s is StockEntry => s !== undefined);

  console.log(`  후보종목 ${candidateCodes.length}개 중 마스터 필터 통과 ${candidates.length}개`);

  const today = todayKstDate();

  const { data: existingActive, error: activeError } = await supabaseAdmin
    .from("screening_results")
    .select("strategy_id, stock_code")
    .eq("status", "active")
    .in("strategy_id", targets.map((s) => s.id));
  if (activeError) throw new Error(`추적 중인 종목 조회 실패: ${activeError.message}`);
  const activeKeys = new Set((existingActive ?? []).map((r) => `${r.strategy_id}:${r.stock_code}`));

  let matched = 0;
  let errors = 0;
  let completed = 0;

  await runWithConcurrency(candidates, BATCH_CONCURRENCY, async (stock) => {
    try {
      const [priceRow, fundamentalsData] = await Promise.all([
        getDailyPrice(stock.code, today),
        needsListedShares
          ? loadFundamentalsSeriesWithListedShares(stock.code)
          : loadFundamentalsSeries(stock.code).then((series) => ({ series, listedSharesByFiscalYear: undefined })),
      ]);
      if (!priceRow) return; // 오늘 시세 없음(휴장, 데이터 지연 등)
      const { series: fundamentals, listedSharesByFiscalYear } = fundamentalsData;

      const prices: DailyPrice[] = [
        {
          date: priceRow.tradeDate,
          open: priceRow.closePrice,
          high: priceRow.closePrice,
          low: priceRow.closePrice,
          close: priceRow.closePrice,
          volume: 0,
          marketCapEok: priceRow.marketCapEok,
          listedShares: priceRow.listedShares,
        },
      ];

      for (const strategy of targets) {
        if (!matchesToday(prices, strategy, fundamentals, listedSharesByFiscalYear)) continue;

        const key = `${strategy.id}:${stock.code}`;
        if (activeKeys.has(key)) continue;

        const { entryPrice, stopLossPrice, takeProfitPrice } = computeEntryPlan(prices, strategy);
        const signalDetails =
          strategy.rule_type === "peg_lynch"
            ? buildPegLynchSignalDetails(priceRow.closePrice, priceRow.listedShares, fundamentals, listedSharesByFiscalYear, today)
            : buildFundamentalSignalDetails(priceRow.closePrice, priceRow.marketCapEok, priceRow.listedShares, fundamentals, today);

        const { error: insertError } = await supabaseAdmin.from("screening_results").insert({
          strategy_id: strategy.id,
          stock_code: stock.code,
          stock_name: stock.name,
          signal_price: priceRow.closePrice,
          entry_price: entryPrice,
          stop_loss_price: stopLossPrice,
          take_profit_price: takeProfitPrice,
          current_price: priceRow.closePrice,
          return_pct: 0,
          status: "active",
          score: null,
          market: "KR",
          signal_details: signalDetails,
        });

        if (insertError) {
          errors++;
          console.error(`    [${strategy.rule_type}] ${stock.code} 저장 실패: ${insertError.message}`);
          continue;
        }

        activeKeys.add(key);
        matched++;
        console.log(`    [${strategy.rule_type}] ✓ 신규 매칭: ${stock.name}(${stock.code})`, signalDetails);
      }
    } catch (error) {
      errors++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`    ${stock.code}(${stock.name}) 펀더멘털 판정 중 오류, 건너뜁니다: ${message}`);
    } finally {
      completed++;
      if (completed === 1 || completed % PROGRESS_LOG_INTERVAL === 0 || completed === candidates.length) {
        console.log(`  [${completed}/${candidates.length}] 펀더멘털 전략 판정 진행 중...`);
      }
    }
  });

  console.log(`  --- 펀더멘털 전략 판정 완료: 신규 매칭 ${matched}건, 오류 ${errors}건 ---`);
  return { matched, errors };
}

interface ThemeAggregate {
  changeRateSum: number;
  count: number;
  upCount: number;
  downCount: number;
  constituents: { code: string; name: string; changeRate: number }[];
}

/**
 * 테마(KRX 섹터, lib/themeConfig.ts)별 당일 등락률(구성종목 단순평균)을 집계해
 * theme_daily_returns에 upsert한다. changeRateByCode는 시세 필터 단계
 * (filterByQuote)에서 이미 조회한 전일대비등락율을 그대로 재사용한다 — 여기서
 * 별도 KIS 호출을 하지 않는다. 종목마스터의 themeFlags로 종목을 테마에 배정하며,
 * 한 종목이 여러 테마에 동시에 속할 수 있다.
 */
async function computeAndStoreThemeReturns(
  changeRateByCode: Map<string, ChangeRateEntry>
): Promise<{ updatedThemes: number }> {
  if (changeRateByCode.size === 0) {
    console.log("테마 등락률 집계에 쓸 시세가 없어 건너뜁니다.");
    return { updatedThemes: 0 };
  }

  console.log("=== 5단계: 테마별 등락률 집계 ===");

  const allStocks = await getAllStocks();
  const aggregates = new Map<ThemeCode, ThemeAggregate>(
    THEME_CODES.map((code) => [code, { changeRateSum: 0, count: 0, upCount: 0, downCount: 0, constituents: [] }])
  );

  for (const stock of allStocks) {
    const entry = changeRateByCode.get(stock.code);
    if (!entry) continue;

    for (const themeCode of THEME_CODES) {
      if (!stock.themeFlags[themeCode]) continue;
      const agg = aggregates.get(themeCode)!;
      agg.changeRateSum += entry.changeRate;
      agg.count++;
      if (entry.changeRate > 0) agg.upCount++;
      else if (entry.changeRate < 0) agg.downCount++;
      agg.constituents.push({ code: stock.code, name: entry.name, changeRate: entry.changeRate });
    }
  }

  const today = todayKstDate();
  const rows = THEME_CODES.filter((code) => aggregates.get(code)!.count > 0).map((code) => {
    const agg = aggregates.get(code)!;
    return {
      trade_date: today,
      theme_code: code,
      change_rate_pct: agg.changeRateSum / agg.count,
      constituent_count: agg.count,
      up_count: agg.upCount,
      down_count: agg.downCount,
      constituents: agg.constituents,
    };
  });

  if (rows.length === 0) {
    console.log("구성종목 시세를 확인할 수 있는 테마가 없어 저장을 건너뜁니다.");
    return { updatedThemes: 0 };
  }

  const { error } = await supabaseAdmin
    .from("theme_daily_returns")
    .upsert(rows, { onConflict: "trade_date,theme_code" });

  if (error) {
    console.error(`테마 등락률 저장 실패: ${error.message}`);
    return { updatedThemes: 0 };
  }

  console.log(
    `테마 등락률 집계 완료: ${rows
      .map((r) => `${THEME_LABELS[r.theme_code as ThemeCode]} ${r.change_rate_pct.toFixed(2)}%(${r.constituent_count}종목)`)
      .join(", ")}`
  );
  return { updatedThemes: rows.length };
}

/** DB 용량 절약을 위해 THEME_CONSTITUENTS_RETENTION_YEARS(lib/themeConfig.ts)가 지난
 * 행의 구성종목 상세(constituents)만 비운다 — 집계값(change_rate_pct 등)은 그대로
 * 유지되므로 순위·복리 누적 계산에는 영향이 없다. 이미 비운 행은 다시 갱신 대상에서
 * 빼서(constituents가 이미 빈 배열인 행 제외), 매일 실행돼도 갱신 행 수가 시간이
 * 지날수록 무한히 늘어나지 않고 그날 새로 3년을 넘긴 행만큼만 갱신되게 한다. */
async function cleanupOldThemeConstituents(): Promise<void> {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - THEME_CONSTITUENTS_RETENTION_YEARS);
  const cutoffDate = cutoff.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });

  const { data, error } = await supabaseAdmin
    .from("theme_daily_returns")
    .update({ constituents: [] })
    .lt("trade_date", cutoffDate)
    .not("constituents", "eq", "[]")
    .select("theme_code");

  if (error) {
    console.error(`오래된 테마 구성종목 정리 실패: ${error.message}`);
    return;
  }
  if (data && data.length > 0) {
    console.log(`오래된(${cutoffDate} 이전) 테마 구성종목 상세 ${data.length}건 정리 완료`);
  }
}

async function recordRun(
  startedAt: Date,
  scanned: number,
  matched: number,
  errors: number
): Promise<void> {
  const { error } = await supabaseAdmin.from("screening_runs").insert({
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    scanned_count: scanned,
    matched_count: matched,
    error_count: errors,
    market: "KR",
  });

  if (error) {
    console.error(`실행 기록 저장 실패: ${error.message}`);
  }
}

function todayKstDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/** 오늘(KST) 이미 완료된 국내 스크리닝 실행 기록이 있는지 확인한다. GitHub Actions의
 * schedule 트리거는 부하가 높을 때 몇 시간씩 지연되는 경우가 있어(공식 문서에 명시된
 * 동작), 정시 실행을 위해 Supabase pg_cron이 workflow_dispatch API를 직접 호출하는
 * 방식으로 전환했다 — 이제 이 워크플로엔 schedule 트리거가 없고 항상 workflow_dispatch로만
 * 들어온다. 그래서 트리거 종류로 "예약 실행 vs 수동 실행"을 구분할 수 없으므로, 당일
 * 중복 실행 방지 가드를 트리거 종류와 무관하게 항상 적용하고, 의도적인 재실행이 필요할
 * 때만 workflow_dispatch의 force_rescan 입력으로 우회한다 — paper-trade.ts의
 * alreadyRanToday와 동일한 패턴. */
async function alreadyRanToday(): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("screening_runs")
    .select("finished_at")
    .eq("market", "KR")
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`배치 실행 이력 조회 실패: ${error.message}`);
  if (!data) return false;

  const lastRunDate = new Date(data.finished_at).toLocaleDateString("en-CA", {
    timeZone: "Asia/Seoul",
  });
  return lastRunDate === todayKstDate();
}

async function main(): Promise<void> {
  const startedAt = new Date();
  console.log(`스크리닝 배치 시작: ${startedAt.toISOString()}`);

  const forceRescan = process.env.FORCE_RESCAN === "true";
  if (!forceRescan && (await alreadyRanToday())) {
    console.log(
      "오늘 국내 스크리닝 배치가 이미 실행된 기록이 있어 건너뜁니다(중복 스캔 방지). " +
        "강제로 다시 돌리려면 workflow_dispatch 실행 시 force_rescan 입력을 true로 설정하세요."
    );
    return;
  }

  const strategies = await loadStrategies();
  console.log(`등록된 전략 수: ${strategies.length}`);

  // dh_value_dividend 등은 KIS 일봉이 아니라 DH 가격 레이어를 쓰는 별도 경로
  // (scanFundamentalStrategies)로 처리한다 — scanAllStocks/collectDailyPrices에는
  // 순수 가격 기반 전략만 넘긴다.
  const technicalStrategies = strategies.filter((s) => !FUNDAMENTAL_RULE_TYPES.has(s.rule_type));
  const fundamentalStrategies = strategies.filter((s) => FUNDAMENTAL_RULE_TYPES.has(s.rule_type));

  await updateActiveTracking();
  const { scanned, matched, errors, changeRateByCode } = await scanAllStocks(technicalStrategies);
  const { matched: fundamentalMatched, errors: fundamentalErrors } =
    await scanFundamentalStrategies(fundamentalStrategies);

  await recordRun(startedAt, scanned, matched + fundamentalMatched, errors + fundamentalErrors);

  // 스캔에서 이미 조회한 changeRate를 재사용하므로 추가 KIS 호출 없음. 같은 배치 끝에
  // 이어붙여 별도 정리 배치를 두지 않는다(SKILLS.md 배치 스케줄링 방식 선택 참고).
  await computeAndStoreThemeReturns(changeRateByCode);
  await cleanupOldThemeConstituents();

  const elapsedSec = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
  const kisStats = getKisCallStats();
  console.log(
    `스크리닝 배치 종료: ${elapsedSec}초 소요 (KIS 호출 ${kisStats.total}건, ` +
      `EGW00201 재시도 ${kisStats.retried}건)`
  );
}

main().catch((error) => {
  console.error("배치 실행 중 오류가 발생했습니다:", error);
  process.exit(1);
});

/**
 * (임시, 디스포저블) 상장폐지 종목 커버리지·생존편향 실측 — 순수 조회(읽기 전용).
 * 2026-09-16 팀장이 명시적으로 main 병합→실행→정리 PR 절차를 승인해 만든 스크립트다
 * (이전 조사 브랜치 claude/investigate-survivorship-bias의 동명 스크립트를 베이스로,
 * 이번 요청의 세부 항목에 맞춰 재작성했다).
 *
 * 이미 코드로 확인된 전제(이 스크립트가 다시 검증하려는 게 아니라 출발점으로 삼는 사실):
 *   scripts/run-custom-backtest.ts의 collectUniverse()와 scripts/screen-all-stocks.ts의
 *   기술/펀더멘털 스캔 모두 lib/stockMaster.ts의 getAllStocks()(오늘 기준 KIS 종목마스터)로
 *   시작한다 — 상장폐지 종목은 그 마스터에 존재하지 않으므로 규모·업종과 무관하게 100%
 *   구조적으로 백테스트/스크리닝 유니버스에서 빠진다. 이 스크립트는 "고쳤다면 얼마나
 *   많은/큰 종목이 새로 들어왔을지"를 실측한다.
 *
 * 절차:
 *   1. KRX 상장폐지종목 공식 통계를 미러링하는 FinanceDataReader 캐시(raw.githubusercontent.com/
 *      FinanceData/fdr_krx_data_cache, 원본은 data.krx.co.kr MDCSTAT23801)에서 2011~오늘
 *      KOSPI/KOSDAQ 보통주(SecuGroup=주권) 상장폐지 목록을 가져온다(726개 확인됨).
 *   2. lib/stockMaster.ts의 getAllStocks()(오늘 실시간 KIS 마스터)에 726개 중 몇 개가
 *      남아있는지 확인한다 — 0이어야 정상(구조적 배제 재확인). 0이 아니면 원인을 로그로
 *      남긴다(코드 재사용, 형식 불일치 등 가능성).
 *   3. lib/stockDailyPricesStorage.ts의 downloadYearPrices(2011~오늘, cold)와
 *      stock_daily_prices_recent(hot)에서 각 상장폐지 종목의 "상장폐지 이전" 데이터를
 *      찾는다 — 있으면 마지막 기록일/그날 시총, 폐지 전 최고 시총을 기록해 규모 구간별로
 *      분류한다(5천억 미만=원자료 자체에 없음 / 5천억~1조 / 1조~2조 / 2조 이상).
 *   4. 3번에서 데이터가 있는 종목에 대해 stock_annual_fundamentals(DART 백필) 커버리지를
 *      확인하고, 있으면 lib/stockFundamentals.ts/lib/backtest.ts의 실제 판정 함수를 그대로
 *      재사용해 DH전략(PER/PBR/배당연속연수, lib/dhStrategyConfig.ts)과 PEG전략
 *      (lib/pegConfig.ts) 조건을 만족했을 가능성을 계산한다. dart_corp_codes(DART 전체
 *      법인 목록)에 이 종목들이 애초에 있는지도 확인해 백필 구조 자체의 한계를 판단한다.
 *   5. 데이터가 많은 대표 사례 2~3개를 골라 상장폐지일 근처 마지막 20거래일 종가/시총을
 *      출력한다(완만한 하락 vs 거래정지로 인한 급단절 패턴 확인용).
 *
 * 읽기 전용, DB/Storage/외부 HTTP만 조회하고 아무것도 쓰지 않는다. 확인 후 정리 PR로
 * 스크립트/워크플로 삭제 예정.
 *
 * tsx --conditions=react-server scripts/diagnose-delisted-stock-coverage.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getAllStocks } from "@/lib/stockMaster";
import { downloadYearPrices, hotWindowStartDate, getDailyPriceSeries } from "@/lib/stockDailyPricesStorage";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK, STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK } from "@/lib/stockDataConfig";
import { DH_MIN_MARKET_CAP_EOK, DH_MAX_PER, DH_MAX_PBR, DH_MIN_CONSECUTIVE_DIVIDEND_YEARS } from "@/lib/dhStrategyConfig";
import { PEG_MAX_RATIO, PEG_GROWTH_LOOKBACK_YEARS } from "@/lib/pegConfig";
import { computeValuationAsOf, computeEpsCagrAsOf, getDividendsPaidAsOf } from "@/lib/stockFundamentals";
import { evaluateConsecutiveDividendYears } from "@/lib/backtest";
import { computePeg } from "@/lib/pegRatio";

const BACKFILL_START_YEAR = 2011; // scripts/backfill-stock-daily-prices.ts와 동일
const DELISTING_CACHE_LOOKBACK_DAYS = 21; // 캐시가 매일 갱신되진 않을 수 있어 여유를 둔다
const SUPABASE_IN_CHUNK_SIZE = 300; // .in() 쿼리 URL 길이 방어
const LAST_N_TRADING_DAYS_FOR_EXAMPLES = 20;
const EXAMPLE_COUNT = 3;

interface DelistingRow {
  symbol: string;
  name: string;
  market: string;
  secuGroup: string;
  delistingDate: string; // YYYY-MM-DD
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(dateIso: string, days: number): string {
  const d = new Date(dateIso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** RFC4180류 최소 CSV 파서 — 따옴표로 감싼 필드 안의 콤마/줄바꿈/이스케이프된 큰따옴표(""))를
 * 처리한다. 이 캐시 CSV의 Reason/Name 컬럼에 콤마가 섞여 있어 단순 split(",")로는 깨진다. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // skip, \n이 뒤따라옴
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** raw.githubusercontent.com의 FinanceDataReader KRX 상장폐지 캐시를 가져온다(SKILLS.md의
 * "샌드박스가 직접 접근하지 못하는 도메인" 주의사항과 무관 — 이 도메인은 이미 이전 조사에서
 * 접근 가능함을 확인했고, 이 스크립트는 GitHub Actions 러너에서 실행된다). */
async function fetchDelistingCsv(): Promise<{ date: string; rows: DelistingRow[] }> {
  let date = todayIsoDate();
  for (let i = 0; i <= DELISTING_CACHE_LOOKBACK_DAYS; i++) {
    const url = `https://raw.githubusercontent.com/FinanceData/fdr_krx_data_cache/refs/heads/master/data/listing/delisting/${date}.csv`;
    const res = await fetch(url);
    if (res.ok) {
      const text = await res.text();
      const table = parseCsv(text);
      const header = table[0];
      const idx = {
        symbol: header.indexOf("Symbol"),
        name: header.indexOf("Name"),
        market: header.indexOf("Market"),
        secuGroup: header.indexOf("SecuGroup"),
        delistingDate: header.indexOf("DelistingDate"),
      };
      if (Object.values(idx).some((v) => v < 0)) {
        throw new Error(`상장폐지 캐시 CSV(${date}) 헤더가 예상과 다릅니다: ${header.join("|")}`);
      }
      const rows: DelistingRow[] = table
        .slice(1)
        .filter((r) => r.length > 1 && r[idx.symbol])
        .map((r) => ({
          symbol: r[idx.symbol].trim().padStart(6, "0"),
          name: r[idx.name],
          market: r[idx.market],
          secuGroup: r[idx.secuGroup],
          delistingDate: r[idx.delistingDate],
        }));
      return { date, rows };
    }
    date = addDaysIso(date, -1);
  }
  throw new Error(`상장폐지 캐시 CSV를 ${DELISTING_CACHE_LOOKBACK_DAYS}일 범위 안에서 찾지 못했습니다.`);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface CoverageEntry {
  lastDate: string | null;
  lastCapEok: number | null;
  maxCapEok: number | null;
  maxCapDate: string | null;
}

async function main(): Promise<void> {
  console.log("########## 상장폐지 종목 커버리지·생존편향 실측 ##########\n");

  // --- 1. 상장폐지 목록 확보 ---
  console.log("--- 1. KRX 상장폐지종목 목록(FinanceDataReader 캐시) 가져오는 중 ---");
  const { date: csvDate, rows: allDelisted } = await fetchDelistingCsv();
  const todayIso = todayIsoDate();
  const startIso = `${BACKFILL_START_YEAR}-01-01`;
  const delisted = allDelisted.filter(
    (r) =>
      (r.market === "KOSPI" || r.market === "KOSDAQ") &&
      r.secuGroup === "주권" &&
      r.delistingDate >= startIso &&
      r.delistingDate <= todayIso
  );
  console.log(`  캐시 날짜: ${csvDate}, 전체 행: ${allDelisted.length}`);
  console.log(`  ${BACKFILL_START_YEAR}~${todayIso} KOSPI+KOSDAQ 보통주(주권) 상장폐지: ${delisted.length}개\n`);

  const delistedByCode = new Map(delisted.map((r) => [r.symbol, r]));

  // --- 2. 오늘 KIS 마스터에 몇 개가 남아있는지 재확인 ---
  console.log("--- 2. 오늘 KIS 종목마스터(getAllStocks) 대조 ---");
  const master = await getAllStocks();
  const masterCodes = new Set(master.map((e) => e.code.trim().padStart(6, "0")));
  const stillInMaster = delisted.filter((r) => masterCodes.has(r.symbol));
  console.log(`  오늘 마스터 전체 종목 수: ${master.length}`);
  console.log(`  상장폐지 ${delisted.length}개 중 오늘 마스터에 남아있는 종목: ${stillInMaster.length}개`);
  if (stillInMaster.length > 0) {
    console.warn("  [예상과 다름] 아래 종목은 상장폐지 목록에 있는데 오늘 마스터에도 존재합니다 — 원인 확인 필요:");
    for (const r of stillInMaster) {
      const masterEntry = master.find((e) => e.code.trim().padStart(6, "0") === r.symbol);
      console.warn(
        `    ${r.symbol} ${r.name} (폐지일 ${r.delistingDate}) ↔ 마스터: ${masterEntry?.name}, 상장일 ${masterEntry?.listedDate}`
      );
    }
  } else {
    console.log("  → 0/726, 구조적 배제 재확인됨(예상대로).");
  }
  console.log();

  // --- 3. 연도별 Parquet(cold) + hot 테이블에서 상장폐지 이전 데이터 존재 여부 확인 ---
  console.log("--- 3. 상장폐지 이전 데이터 커버리지(Parquet cold + hot) ---");
  const currentYear = new Date().getUTCFullYear();
  const years = Array.from({ length: currentYear - BACKFILL_START_YEAR + 1 }, (_, i) => BACKFILL_START_YEAR + i);
  const coverage = new Map<string, CoverageEntry>();
  for (const r of delisted) {
    coverage.set(r.symbol, { lastDate: null, lastCapEok: null, maxCapEok: null, maxCapDate: null });
  }

  function updateCoverage(code: string, tradeDate: string, marketCapEok: number, delistingDate: string): void {
    if (tradeDate > delistingDate) return; // point-in-time: 폐지 이후 데이터는 보지 않는다
    const entry = coverage.get(code);
    if (!entry) return;
    if (entry.lastDate === null || tradeDate > entry.lastDate) {
      entry.lastDate = tradeDate;
      entry.lastCapEok = marketCapEok;
    }
    if (entry.maxCapEok === null || marketCapEok > entry.maxCapEok) {
      entry.maxCapEok = marketCapEok;
      entry.maxCapDate = tradeDate;
    }
  }

  for (const year of years) {
    const rows = await downloadYearPrices(year);
    let matched = 0;
    for (const row of rows) {
      const delistRow = delistedByCode.get(row.stockCode);
      if (!delistRow) continue;
      matched++;
      updateCoverage(row.stockCode, row.tradeDate, row.marketCapEok, delistRow.delistingDate);
    }
    console.log(`  ${year}년 Parquet: 전체 ${rows.length}행 중 상장폐지 종목 매칭 ${matched}행`);
  }

  console.log("\n  hot 테이블(stock_daily_prices_recent) 확인 중...");
  const hotStart = hotWindowStartDate();
  const delistedCodesArr = Array.from(delistedByCode.keys());
  let hotMatched = 0;
  for (const codeChunk of chunk(delistedCodesArr, SUPABASE_IN_CHUNK_SIZE)) {
    const { data, error } = await supabaseAdmin
      .from("stock_daily_prices_recent")
      .select("stock_code, trade_date, market_cap_eok")
      .in("stock_code", codeChunk)
      .gte("trade_date", hotStart);
    if (error) throw new Error(`hot 테이블 조회 실패: ${error.message}`);
    for (const row of data ?? []) {
      const delistRow = delistedByCode.get(row.stock_code);
      if (!delistRow) continue;
      hotMatched++;
      updateCoverage(row.stock_code, row.trade_date, Number(row.market_cap_eok), delistRow.delistingDate);
    }
  }
  console.log(`  hot 구간 시작일: ${hotStart}, 상장폐지 종목 매칭 ${hotMatched}행\n`);

  // 규모 구간별 분류
  const bucketNoData: DelistingRow[] = [];
  const bucket5000to10000: DelistingRow[] = [];
  const bucket10000to20000: DelistingRow[] = [];
  const bucket20000plus: DelistingRow[] = [];

  for (const r of delisted) {
    const entry = coverage.get(r.symbol)!;
    if (entry.maxCapEok === null) {
      bucketNoData.push(r);
    } else if (entry.maxCapEok < STOCK_DATA_CANDIDATE_MARKET_CAP_EOK) {
      bucket5000to10000.push(r);
    } else if (entry.maxCapEok < DH_MIN_MARKET_CAP_EOK) {
      bucket10000to20000.push(r);
    } else {
      bucket20000plus.push(r);
    }
  }

  console.log("--- 3-결과. 상장폐지 726개 규모 구간별 분류 ---");
  console.log(
    `  (a) 원자료 자체에 없음(저장 시점 하한 ${STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK}억원 미만으로 추정): ${bucketNoData.length}개`
  );
  console.log(
    `  (b) ${STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK / 10000}조~${STOCK_DATA_CANDIDATE_MARKET_CAP_EOK / 10000}조원: ${bucket5000to10000.length}개`
  );
  console.log(
    `  (c) ${STOCK_DATA_CANDIDATE_MARKET_CAP_EOK / 10000}조~${DH_MIN_MARKET_CAP_EOK / 10000}조원: ${bucket10000to20000.length}개`
  );
  console.log(`  (d) ${DH_MIN_MARKET_CAP_EOK / 10000}조원 이상 도달한 적 있음: ${bucket20000plus.length}개`);
  if (bucket20000plus.length > 0) {
    console.log("  (d) 상세 — 폐지 전 최고 시총 내림차순:");
    for (const r of [...bucket20000plus].sort((a, b) => (coverage.get(b.symbol)!.maxCapEok ?? 0) - (coverage.get(a.symbol)!.maxCapEok ?? 0))) {
      const c = coverage.get(r.symbol)!;
      console.log(
        `    ${r.symbol} ${r.name} (${r.market}, 폐지일 ${r.delistingDate}): 최고 시총 ${c.maxCapEok?.toFixed(0)}억원(${c.maxCapDate}), 마지막 기록일 ${c.lastDate} 시총 ${c.lastCapEok?.toFixed(0)}억원`
      );
    }
  }
  if (bucket10000to20000.length > 0) {
    console.log(`  (c) 상세(최대 15개, 최고 시총 내림차순):`);
    for (const r of [...bucket10000to20000]
      .sort((a, b) => (coverage.get(b.symbol)!.maxCapEok ?? 0) - (coverage.get(a.symbol)!.maxCapEok ?? 0))
      .slice(0, 15)) {
      const c = coverage.get(r.symbol)!;
      console.log(
        `    ${r.symbol} ${r.name} (폐지일 ${r.delistingDate}): 최고 시총 ${c.maxCapEok?.toFixed(0)}억원(${c.maxCapDate})`
      );
    }
  }
  console.log();

  // --- 4. DH/PEG 재무 데이터 커버리지 ---
  console.log("--- 4. DH/PEG 재무 데이터 커버리지 ---");
  const withAnyData = delisted.filter((r) => coverage.get(r.symbol)!.maxCapEok !== null);
  console.log(`  상장폐지 전 시세 데이터가 조금이라도 있는 종목: ${withAnyData.length}개`);

  const withAnyDataCodes = withAnyData.map((r) => r.symbol);
  const fundamentalsCodesWithData = new Set<string>();
  for (const codeChunk of chunk(withAnyDataCodes, SUPABASE_IN_CHUNK_SIZE)) {
    const { data, error } = await supabaseAdmin
      .from("stock_annual_fundamentals")
      .select("stock_code")
      .in("stock_code", codeChunk);
    if (error) throw new Error(`stock_annual_fundamentals 조회 실패: ${error.message}`);
    for (const row of data ?? []) fundamentalsCodesWithData.add(row.stock_code);
  }
  console.log(`  이 중 stock_annual_fundamentals에 재무 데이터가 있는 종목: ${fundamentalsCodesWithData.size}개`);

  // dart_corp_codes 매핑 구조 확인: 726개 상장폐지 종목 자체가 DART 법인 목록에 존재하는지
  const dartCorpCodeMatches = new Set<string>();
  for (const codeChunk of chunk(delistedCodesArr, SUPABASE_IN_CHUNK_SIZE)) {
    const { data, error } = await supabaseAdmin.from("dart_corp_codes").select("stock_code").in("stock_code", codeChunk);
    if (error) throw new Error(`dart_corp_codes 조회 실패: ${error.message}`);
    for (const row of data ?? []) {
      if (row.stock_code) dartCorpCodeMatches.add(row.stock_code);
    }
  }
  console.log(
    `  dart_corp_codes(DART 전체 법인 목록, 매주 갱신)에 stock_code로 매핑되는 상장폐지 종목: ${dartCorpCodeMatches.size}/${delisted.length}개` +
      ` — 이 매핑이 없으면 종목이 1조원을 넘었어도 재무 백필 자체가 불가능하다.`
  );

  console.log(
    `\n  참고: backfill-stock-annual-fundamentals.ts는 discoverCandidateStockCodes(과거 실측 시총 ${STOCK_DATA_CANDIDATE_MARKET_CAP_EOK}억원 이상 이력)로 후보를 뽑는다 —`
  );
  console.log(
    `  "오늘 기준 마스터"가 아니라 과거 시총을 직접 쓰므로 이 레이어 자체는 생존편향 설계가 아니다. 문제는 corp_code 매핑 존재 여부와, 이 재무 데이터에 실제로`
  );
  console.log(`  도달하는 경로(스크리닝/백테스트 유니버스)가 오늘 마스터로 다시 필터링된다는 점이다.\n`);

  // 재무 데이터가 있는 종목들에 대해 실제 DH/PEG 조건 계산
  const dhHits: { code: string; name: string; asOfDate: string; per: number; pbr: number; marketCapEok: number; dividendYears: number }[] = [];
  const pegHits: { code: string; name: string; asOfDate: string; per: number; growthPct: number; peg: number }[] = [];
  let evaluated = 0;

  for (const r of withAnyData) {
    if (!fundamentalsCodesWithData.has(r.symbol)) continue;
    const c = coverage.get(r.symbol)!;
    if (!c.lastDate) continue;
    evaluated++;

    try {
      const valuation = await computeValuationAsOf(r.symbol, c.lastDate);
      if (!valuation || valuation.per === null || valuation.pbr === null) continue;

      // DH전략 조건
      const dividends = await getDividendsPaidAsOf(r.symbol, c.lastDate);
      const { consecutiveOk, paidYears } = evaluateConsecutiveDividendYears(dividends, c.lastDate, DH_MIN_CONSECUTIVE_DIVIDEND_YEARS);
      if (
        valuation.marketCapEok >= DH_MIN_MARKET_CAP_EOK &&
        valuation.per > 0 &&
        valuation.per <= DH_MAX_PER &&
        valuation.pbr > 0 &&
        valuation.pbr <= DH_MAX_PBR &&
        consecutiveOk
      ) {
        dhHits.push({
          code: r.symbol,
          name: r.name,
          asOfDate: c.lastDate,
          per: valuation.per,
          pbr: valuation.pbr,
          marketCapEok: valuation.marketCapEok,
          dividendYears: paidYears.length,
        });
      }

      // PEG전략 조건
      const cagr = await computeEpsCagrAsOf(r.symbol, c.lastDate, PEG_GROWTH_LOOKBACK_YEARS);
      const peg = computePeg(valuation.per, cagr?.growthPct ?? null);
      if (peg !== null && peg <= PEG_MAX_RATIO) {
        pegHits.push({
          code: r.symbol,
          name: r.name,
          asOfDate: c.lastDate,
          per: valuation.per,
          growthPct: cagr!.growthPct!,
          peg,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ${r.symbol} ${r.name} 조건 계산 중 오류(건너뜀): ${message}`);
    }
  }

  console.log(`  마지막 기록일 기준 PER/PBR 계산 시도: ${evaluated}개`);
  console.log(`  DH전략 조건(시총≥${DH_MIN_MARKET_CAP_EOK}억, PER≤${DH_MAX_PER}, PBR≤${DH_MAX_PBR}, 배당 ${DH_MIN_CONSECUTIVE_DIVIDEND_YEARS}년 연속) 만족: ${dhHits.length}개`);
  for (const h of dhHits) {
    console.log(
      `    ${h.code} ${h.name} (${h.asOfDate} 기준): PER ${h.per.toFixed(1)}, PBR ${h.pbr.toFixed(2)}, 시총 ${h.marketCapEok.toFixed(0)}억, 배당연속 ${h.dividendYears}년`
    );
  }
  console.log(`  PEG전략 조건(PEG≤${PEG_MAX_RATIO}) 만족: ${pegHits.length}개`);
  for (const h of pegHits) {
    console.log(`    ${h.code} ${h.name} (${h.asOfDate} 기준): PER ${h.per.toFixed(1)}, EPS 5년 CAGR ${h.growthPct.toFixed(1)}%, PEG ${h.peg.toFixed(2)}`);
  }
  console.log();

  // --- 5. 대표 사례 2~3개의 마지막 20거래일 추이 ---
  console.log(`--- 5. 대표 사례 ${EXAMPLE_COUNT}개 — 상장폐지 전 마지막 ${LAST_N_TRADING_DAYS_FOR_EXAMPLES}거래일 추이 ---`);
  const examplePool = [...bucket20000plus, ...bucket10000to20000].sort(
    (a, b) => (coverage.get(b.symbol)!.maxCapEok ?? 0) - (coverage.get(a.symbol)!.maxCapEok ?? 0)
  );
  const examples = examplePool.slice(0, EXAMPLE_COUNT);
  if (examples.length === 0) {
    console.log("  (c)/(d) 구간에 해당하는 종목이 없어 대표 사례를 뽑을 수 없습니다.");
  }
  for (const r of examples) {
    const c = coverage.get(r.symbol)!;
    console.log(`\n  ## ${r.symbol} ${r.name} (${r.market}, 폐지일 ${r.delistingDate}, 폐지 전 최고 시총 ${c.maxCapEok?.toFixed(0)}억원)`);
    const rangeStart = addDaysIso(r.delistingDate, -90);
    const series = await getDailyPriceSeries(r.symbol, rangeStart, r.delistingDate);
    const lastN = series.slice(-LAST_N_TRADING_DAYS_FOR_EXAMPLES);
    if (lastN.length === 0) {
      console.log("    (해당 구간 데이터 없음)");
      continue;
    }
    for (const row of lastN) {
      console.log(`    ${row.tradeDate}  종가 ${row.closePrice.toLocaleString()}원  시총 ${row.marketCapEok.toFixed(0)}억원`);
    }
    const gapDays =
      (new Date(r.delistingDate + "T00:00:00Z").getTime() - new Date(lastN[lastN.length - 1].tradeDate + "T00:00:00Z").getTime()) /
      (1000 * 60 * 60 * 24);
    console.log(`    → 마지막 데이터일과 공식 폐지일 사이 간격: ${gapDays.toFixed(0)}일`);
  }

  console.log("\n=== 확인 종료 ===");
  console.log(
    `(참고) 저장 하한 ${STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK}억원 / 후보 기준 ${STOCK_DATA_CANDIDATE_MARKET_CAP_EOK}억원 / DH 기준 ${DH_MIN_MARKET_CAP_EOK}억원`
  );
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});

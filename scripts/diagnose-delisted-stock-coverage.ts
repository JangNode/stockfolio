/**
 * (임시, 디스포저블) 생존편향(survivorship bias) 조사용 — 순수 조회(읽기 전용).
 *
 * 배경: 급등주 찾기(reversal_breakout)/DH전략/PEG전략의 백테스트 종목 유니버스는
 * scripts/backfill-stock-daily-prices.ts가 만든 일별시세 원자료(연도별 Parquet +
 * stock_daily_prices_recent)에서 lib/stockDailyPricesStorage.ts의
 * discoverCandidateStockCodes()로 뽑는다. 그런데 그 원자료 자체가 저장 시점에
 * 시가총액 STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK(5천억원) 미만 행을(예외 2가지
 * 제외) 걸러낸다 — 상장폐지 종목은 그 두 예외(오늘 기준 테마 플래그, 지금까지
 * reversal_breakout 매칭 이력)에 해당하기 어려워, 체계적으로 원자료에서 빠졌을
 * 가능성이 있다. 이 스크립트는 그 가설을 실데이터로 확인한다.
 *
 * 절차:
 *   1. FinanceDataReader의 KRX 상장폐지종목 캐시(raw.githubusercontent.com/
 *      FinanceData/fdr_krx_data_cache, data.krx.co.kr 공식 API
 *      dbms/MDC/STAT/issue/MDCSTAT23801을 그대로 미러링한 CSV)에서 2011~오늘
 *      KOSPI/KOSDAQ 보통주(SecuGroup=주권) 상장폐지 종목 목록을 가져온다.
 *   2. lib/stockDailyPricesStorage.ts의 downloadYearPrices()로 2011~오늘 연도별
 *      Parquet를 전부 내려받아(다른 백필/스크리닝 스크립트가 이미 재사용하는 그대로
 *      export된 함수) 각 상장폐지 종목이 상장폐지 이전 어느 연도에 데이터가 있는지
 *      확인한다. 최근 2년 구간은 stock_daily_prices_recent(hot)도 확인한다.
 *   3. discoverCandidateStockCodes(2011~오늘, 1조원) — 급등주(reversal_breakout)
 *      등 기술적 전략이 쓰는 후보 유니버스 — 에 상장폐지 종목이 몇 개나 포함됐는지.
 *   4. stock_annual_fundamentals / stock_dividend_history distinct 종목 수와
 *      교집합(DH전략 후보 모수) — 상장폐지 종목이 몇 개나 포함됐는지.
 *
 * 읽기 전용, DB/Storage/외부 HTTP만 조회하고 아무것도 쓰지 않는다. 확인 후
 * 정리 PR로 스크립트/워크플로 삭제 예정.
 *
 * tsx --conditions=react-server scripts/diagnose-delisted-stock-coverage.ts
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { downloadYearPrices, hotWindowStartDate } from "@/lib/stockDailyPricesStorage";
import { STOCK_DATA_CANDIDATE_MARKET_CAP_EOK, STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK } from "@/lib/stockDataConfig";

const BACKFILL_START_YEAR = 2011; // scripts/backfill-stock-daily-prices.ts와 동일
const DELISTING_CACHE_LOOKBACK_DAYS = 21; // 캐시가 매일 갱신되진 않을 수 있어 여유를 둔다

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

/** raw.githubusercontent.com의 FinanceDataReader KRX 상장폐지 캐시를 가져온다.
 * data.krx.co.kr 공식 API(dbms/MDC/STAT/issue/MDCSTAT23801)를 매일 미러링한
 * 공개 CSV다(FinanceDataReader 라이브러리가 실제로 쓰는 소스,
 * src/FinanceDataReader/krx/listing.py의 KrxDelistingCache 참고). 최신 파일
 * 날짜를 모르므로 오늘부터 며칠 거슬러 올라가며 처음 성공하는 날짜를 쓴다. */
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
      const rows: DelistingRow[] = table.slice(1).filter((r) => r.length > 1 && r[idx.symbol]).map((r) => ({
        symbol: r[idx.symbol],
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

async function fetchAllRows<T>(table: string, columns: string): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} 조회 실패: ${error.message}`);
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

// 조사 과정에서 확인한 대표 사례(과거 대형주였다가 상장폐지된 종목들) — 상세 로그로
// 따로 찍는다. 나머지는 CSV에서 받은 전체 상장폐지 목록을 그대로 쓴다.
const NOTABLE_CODES = new Set([
  "117930", // 한진해운
  "067250", // STX조선해양
  "000800", // 경남기업
  "103130", // 웅진에너지
  "005900", // 동양건설
  "005980", // 성지건설
]);

async function main(): Promise<void> {
  console.log("########## 상장폐지 종목 커버리지(생존편향) 진단 ##########\n");

  console.log("--- 1. KRX 상장폐지종목 목록(FinanceDataReader 캐시) 가져오는 중 ---");
  const { date: csvDate, rows: allDelisted } = await fetchDelistingCsv();
  console.log(`  캐시 날짜: ${csvDate}, 전체 행(전 시장/전 증권종류, 1960~): ${allDelisted.length}`);

  const todayIso = todayIsoDate();
  const startIso = `${BACKFILL_START_YEAR}-01-01`;
  const delisted = allDelisted.filter(
    (r) =>
      (r.market === "KOSPI" || r.market === "KOSDAQ") &&
      r.secuGroup === "주권" &&
      r.delistingDate >= startIso &&
      r.delistingDate <= todayIso
  );
  console.log(
    `  ${BACKFILL_START_YEAR}~${todayIso} KOSPI+KOSDAQ 보통주(주권) 상장폐지: ${delisted.length}개`
  );
  const byYear = new Map<string, number>();
  for (const r of delisted) {
    const y = r.delistingDate.slice(0, 4);
    byYear.set(y, (byYear.get(y) ?? 0) + 1);
  }
  for (const y of Array.from(byYear.keys()).sort()) {
    console.log(`    ${y}: ${byYear.get(y)}개`);
  }

  console.log(
    "\n--- 2/3. 연도별 Parquet 전량 다운로드해 종목코드 존재 여부 + 후보유니버스(1조원) 인덱싱 ---"
  );
  console.log(
    "  (lib/stockDailyPricesStorage.ts의 discoverCandidateStockCodes()와 완전히 같은 기준으로 직접 계산 —\n" +
      "   같은 Parquet를 두 번 내려받지 않으려고 이 스크립트에서 그 로직을 재현한다.)"
  );
  const currentYear = new Date().getUTCFullYear();
  const years = Array.from({ length: currentYear - BACKFILL_START_YEAR + 1 }, (_, i) => BACKFILL_START_YEAR + i);
  const presenceByYear = new Map<number, Set<string>>(); // 저장돼 있으면(=stored) 무관하게 존재 여부
  const candidateCodes = new Set<string>(); // marketCapEok >= STOCK_DATA_CANDIDATE_MARKET_CAP_EOK(1조원)였던 적 있는 종목
  for (const year of years) {
    const rows = await downloadYearPrices(year);
    const codes = new Set(rows.map((r) => r.stockCode));
    presenceByYear.set(year, codes);
    for (const r of rows) {
      if (r.marketCapEok >= STOCK_DATA_CANDIDATE_MARKET_CAP_EOK) candidateCodes.add(r.stockCode);
    }
    console.log(`  ${year}년: 행 ${rows.length}건, distinct 종목 ${codes.size}개`);
  }

  console.log("\n--- 2-1. hot 테이블(stock_daily_prices_recent) 종목코드 존재 여부 + 후보유니버스 ---");
  const hotStart = hotWindowStartDate();
  const { data: hotCodesData, error: hotErr } = await supabaseAdmin
    .from("stock_daily_prices_recent")
    .select("stock_code, market_cap_eok")
    .gte("trade_date", hotStart);
  if (hotErr) throw new Error(`hot 테이블 조회 실패: ${hotErr.message}`);
  const hotRows = (hotCodesData ?? []) as { stock_code: string; market_cap_eok: number }[];
  const hotCodes = new Set(hotRows.map((r) => r.stock_code));
  for (const r of hotRows) {
    if (Number(r.market_cap_eok) >= STOCK_DATA_CANDIDATE_MARKET_CAP_EOK) candidateCodes.add(r.stock_code);
  }
  console.log(`  hot 구간 시작일: ${hotStart}, distinct 종목 ${hotCodes.size}개`);
  console.log(
    `  급등주(reversal_breakout 등 기술적 전략) 후보 유니버스(1조원 이상이었던 적 있는 종목) 합계: ${candidateCodes.size}개`
  );

  console.log("\n--- 4. DH/PEG전략 재무 후보 유니버스 ---");
  const fundamentalsRows = await fetchAllRows<{ stock_code: string }>("stock_annual_fundamentals", "stock_code");
  const fundamentalsStocks = new Set(fundamentalsRows.map((r) => r.stock_code));
  const dividendRows = await fetchAllRows<{ stock_code: string }>("stock_dividend_history", "stock_code");
  const dividendStocks = new Set(dividendRows.map((r) => r.stock_code));
  const dhCandidates = new Set(Array.from(fundamentalsStocks).filter((c) => dividendStocks.has(c)));
  console.log(`  재무(stock_annual_fundamentals) distinct 종목: ${fundamentalsStocks.size}개`);
  console.log(`  배당(stock_dividend_history) distinct 종목: ${dividendStocks.size}개`);
  console.log(`  재무+배당 둘 다 있는 종목(DH전략 후보 모수): ${dhCandidates.size}개`);

  console.log("\n--- 5. 상장폐지 종목 커버리지 집계 ---");
  let neverAnyData = 0;
  let hasAnyDataBeforeDelisting = 0;
  let inCandidateUniverse = 0;
  let inFundamentalsUniverse = 0;
  let inDhUniverse = 0;

  const detailRows: string[] = [];

  for (const r of delisted) {
    const delistYear = Number(r.delistingDate.slice(0, 4));
    let anyData = false;
    let lastYearWithData: number | null = null;
    let firstYearWithData: number | null = null;
    for (const year of years) {
      if (year > delistYear) continue;
      const set = presenceByYear.get(year);
      if (set?.has(r.symbol)) {
        anyData = true;
        if (firstYearWithData === null) firstYearWithData = year;
        lastYearWithData = year;
      }
    }
    // hot 테이블도 확인(상장폐지가 최근 2년 이내인 경우)
    const inHot = hotCodes.has(r.symbol);
    if (inHot) anyData = true;

    if (!anyData) neverAnyData++;
    else hasAnyDataBeforeDelisting++;

    const inCandidate = candidateCodes.has(r.symbol);
    const inFundamentals = fundamentalsStocks.has(r.symbol);
    const inDh = dhCandidates.has(r.symbol);
    if (inCandidate) inCandidateUniverse++;
    if (inFundamentals) inFundamentalsUniverse++;
    if (inDh) inDhUniverse++;

    if (NOTABLE_CODES.has(r.symbol)) {
      detailRows.push(
        `  [주목] ${r.symbol} ${r.name} (${r.market}, 폐지일 ${r.delistingDate}): ` +
          `데이터 ${anyData ? `있음(${firstYearWithData}~${lastYearWithData}${inHot ? ", hot 포함" : ""})` : "전혀 없음"}, ` +
          `후보유니버스(1조)=${inCandidate}, 재무데이터=${inFundamentals}, DH후보(재무+배당)=${inDh}`
      );
    }
  }

  console.log(`  상장폐지 총 ${delisted.length}개 중:`);
  console.log(
    `    - 상장폐지 이전 구간에 일별시세가 전혀 없음: ${neverAnyData}개 (${((neverAnyData / delisted.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `    - 어느 시점이든 일별시세가 있음: ${hasAnyDataBeforeDelisting}개 (${((hasAnyDataBeforeDelisting / delisted.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `    - 급등주 후보 유니버스(discoverCandidateStockCodes, 1조원)에 포함: ${inCandidateUniverse}개 (${((inCandidateUniverse / delisted.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `    - 재무 데이터(stock_annual_fundamentals) 있음: ${inFundamentalsUniverse}개 (${((inFundamentalsUniverse / delisted.length) * 100).toFixed(1)}%)`
  );
  console.log(
    `    - DH전략 후보 모수(재무+배당)에 포함: ${inDhUniverse}개 (${((inDhUniverse / delisted.length) * 100).toFixed(1)}%)`
  );

  console.log("\n--- 6. 주목 종목(과거 대형주였다가 상장폐지) 상세 ---");
  for (const line of detailRows) console.log(line);

  console.log("\n--- 7. 데이터가 '일부만' 있는 상장폐지 종목 샘플(최대 15개) ---");
  let shown = 0;
  for (const r of delisted) {
    if (shown >= 15) break;
    const delistYear = Number(r.delistingDate.slice(0, 4));
    const yearsWithData: number[] = [];
    for (const year of years) {
      if (year > delistYear) continue;
      if (presenceByYear.get(year)?.has(r.symbol)) yearsWithData.push(year);
    }
    const totalYearsBeforeDelisting = years.filter((y) => y <= delistYear).length;
    if (yearsWithData.length > 0 && yearsWithData.length < totalYearsBeforeDelisting) {
      console.log(
        `  ${r.symbol} ${r.name} (폐지일 ${r.delistingDate}): 데이터 있는 연도=[${yearsWithData.join(",")}] / 폐지 전 전체 연도 ${totalYearsBeforeDelisting}개`
      );
      shown++;
    }
  }

  console.log("\n=== 확인 종료 ===");
  console.log(`(참고) 백필 저장 시점 시총 하한: ${STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK}억원, 후보 기준: ${STOCK_DATA_CANDIDATE_MARKET_CAP_EOK}억원`);
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});

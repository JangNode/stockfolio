import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { parquetReadObjects } from "hyparquet";
import { parquetWriteBuffer } from "hyparquet-writer";
import { STOCK_DATA_HOT_WINDOW_YEARS } from "@/lib/stockDataConfig";

/**
 * 종목 일별시세(종가/시가총액/상장주식수) — 여러 전략이 같이 쓰는 공유 원자료라
 * dh_(DH전략) 접두사 없이 stock_으로 둔다. hot/cold로 나눠 저장한다(용량 예산
 * 재산정, 2026-08-28) — 최근 STOCK_DATA_HOT_WINDOW_YEARS년치는
 * Postgres(stock_daily_prices_recent, 매일 INSERT만 하면 됨)에, 그보다 오래된 건
 * 연도별 Parquet 파일(stock-daily-prices 버킷, Storage)에 둔다. Parquet만 쓰던
 * 이전 버전은 매일 갱신하려면 그 해 파일 전체를 다시 써야 해서 부담이 컸다
 * (supabase/migrations의 20260827060000_dh_daily_prices_to_storage.sql 참고 —
 * 애초에 Postgres 단일 표였다가 DB 500MB 한도를 넘겨 Storage로 옮긴 전례가 있어,
 * 이번엔 반대로 최근 구간만 다시 Postgres로 가져와 매일 갱신 부담을 없앤다). 연 1회
 * scripts/archive-stock-daily-prices.ts가 hot 구간을 벗어난 행을 Parquet에 합쳐
 * 넣고 Postgres에서 지운다. 조회 시 그 시점 재무(stock_annual_fundamentals, 여전히
 * Postgres)와 조합해 PER/PBR을 계산하는 건 lib/stockFundamentals.ts가 한다.
 */

const BUCKET = "stock-daily-prices";
const HOT_TABLE = "stock_daily_prices_recent";

export interface StockDailyPriceRow {
  stockCode: string;
  tradeDate: string; // YYYY-MM-DD
  closePrice: number;
  marketCapEok: number;
  listedShares: number;
  // 2026-09-06 급등주 찾기(reversal_breakout) 15년 백테스트 요청으로 추가(그 전까지는
  // DH전략/방법A 등 종가·시총·상장주식수만 쓰는 전략만 있어 필요 없었다).
  // reversal_breakout의 매집봉 판정(거래량 배수 + 양봉)에 필요하다.
  openPrice: number;
  volume: number;
}

function objectPath(year: number): string {
  return `${year}.parquet`;
}

/** 한 해치 시세를 Parquet로 직렬화해 업로드한다(덮어쓰기). 연도 단위 파일이라 한 해가
 * 통째로 성공했을 때만 부른다 — 중간에 실패하면 그 해는 아예 안 올라가므로, 이전에
 * 이미 올라간 다른 해 파일이 부분 데이터로 오염될 일이 없다. */
export async function uploadYearPrices(year: number, rows: StockDailyPriceRow[]): Promise<void> {
  const buffer = parquetWriteBuffer({
    columnData: [
      { name: "stock_code", data: rows.map((r) => r.stockCode), type: "STRING" },
      { name: "trade_date", data: rows.map((r) => r.tradeDate), type: "STRING" },
      { name: "close_price", data: rows.map((r) => r.closePrice), type: "DOUBLE" },
      { name: "market_cap_eok", data: rows.map((r) => r.marketCapEok), type: "DOUBLE" },
      { name: "listed_shares", data: rows.map((r) => r.listedShares), type: "DOUBLE" },
      { name: "open_price", data: rows.map((r) => r.openPrice), type: "DOUBLE" },
      { name: "volume", data: rows.map((r) => r.volume), type: "DOUBLE" },
    ],
  });

  const { error } = await supabaseAdmin.storage.from(BUCKET).upload(objectPath(year), buffer, {
    contentType: "application/octet-stream",
    upsert: true,
  });
  if (error) throw new Error(`${year}년 시세 업로드 실패: ${error.message}`);
}

/** 특정 연도 파일이 이미 Storage에 있는지 확인한다(백필 재개 시 완료된 연도를 건너뛰는 데 씀). */
export async function yearPricesExist(year: number): Promise<boolean> {
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).list("", { search: objectPath(year) });
  if (error) throw new Error(`${year}년 시세 존재 확인 실패: ${error.message}`);
  return (data ?? []).some((entry) => entry.name === objectPath(year));
}

interface ParquetRawRow {
  stock_code: string;
  trade_date: string;
  close_price: number;
  market_cap_eok: number;
  listed_shares: number;
  // 2011~2026년 재백필(2026-09-06) 이전 연도 파일에는 아직 이 두 컬럼이 없을 수 있다 —
  // 재백필 완료 전까지는 undefined일 수 있으므로 downloadYearPrices에서 0으로 채운다.
  open_price?: number;
  volume?: number;
}

/** year 파일을 그대로 다운로드+파싱한다(내부용) — 아카이빙 배치가 기존 파일과 새로
 * 옮길 행을 합칠 때 직접 쓴다. */
export async function downloadYearPrices(year: number): Promise<StockDailyPriceRow[]> {
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(objectPath(year));
  if (error) {
    // 아직 그 연도 파일이 없는 경우(예: 미래 연도, 백필 전)는 빈 배열로 취급한다.
    if (error.message.toLowerCase().includes("not found")) return [];
    throw new Error(`${year}년 시세 다운로드 실패: ${error.message}`);
  }
  const buffer = await data.arrayBuffer();
  const rows = (await parquetReadObjects({ file: buffer })) as ParquetRawRow[];
  return rows.map((r) => ({
    stockCode: r.stock_code,
    tradeDate: r.trade_date,
    closePrice: r.close_price,
    marketCapEok: r.market_cap_eok,
    listedShares: r.listed_shares,
    openPrice: r.open_price ?? 0,
    volume: r.volume ?? 0,
  }));
}

// 프로세스(스크립트 1회 실행 또는 서버리스 함수 인스턴스) 생존 기간 동안만 유지되는
// 연도별 캐시. 같은 실행 안에서 같은 연도를 여러 번 조회하는 경우(백테스트가 여러
// 종목×여러 날짜를 훑을 때 흔함)가 많아, 매번 다시 내려받지 않게 한다.
const yearCache = new Map<number, Promise<Map<string, StockDailyPriceRow>>>();

function toLookupKey(stockCode: string, tradeDate: string): string {
  return `${stockCode}:${tradeDate}`;
}

async function getYearLookup(year: number): Promise<Map<string, StockDailyPriceRow>> {
  let cached = yearCache.get(year);
  if (!cached) {
    cached = downloadYearPrices(year).then((rows) => {
      const map = new Map<string, StockDailyPriceRow>();
      for (const row of rows) map.set(toLookupKey(row.stockCode, row.tradeDate), row);
      return map;
    });
    yearCache.set(year, cached);
  }
  return cached;
}

/** 오늘 기준 hot 구간(Postgres에 두는 최근 구간)의 시작 날짜(YYYY-MM-DD). 이 날짜
 * 이후는 stock_daily_prices_recent, 이전은 Parquet에서 찾는다. */
export function hotWindowStartDate(referenceDate: Date = new Date()): string {
  const d = new Date(referenceDate);
  d.setUTCFullYear(d.getUTCFullYear() - STOCK_DATA_HOT_WINDOW_YEARS);
  return d.toISOString().slice(0, 10);
}

interface HotTableRow {
  stock_code: string;
  trade_date: string;
  close_price: number;
  market_cap_eok: number;
  listed_shares: number;
  open_price: number;
  volume: number;
}

function fromHotRow(row: HotTableRow): StockDailyPriceRow {
  return {
    stockCode: row.stock_code,
    tradeDate: row.trade_date,
    closePrice: Number(row.close_price),
    marketCapEok: Number(row.market_cap_eok),
    listedShares: Number(row.listed_shares),
    openPrice: Number(row.open_price),
    volume: Number(row.volume),
  };
}

/** date(YYYY-MM-DD) 시점 종목의 종가/시가총액/상장주식수를 찾는다. hot 구간이면
 * Postgres, 아니면 그 연도 Parquet 파일에서 찾는다(비영업일, 백필 하한 미달 등이면
 * null). hot 구간인데 stock_daily_prices_recent에 아직 없으면(시딩 전 등) Parquet에도
 * 한 번 더 확인한다 — 원래 15년 백필이 이미 최근 구간도 채워뒀을 수 있어서다. */
export async function getDailyPrice(stockCode: string, date: string): Promise<StockDailyPriceRow | null> {
  if (date >= hotWindowStartDate()) {
    const { data, error } = await supabaseAdmin
      .from(HOT_TABLE)
      .select("stock_code, trade_date, close_price, market_cap_eok, listed_shares, open_price, volume")
      .eq("stock_code", stockCode)
      .eq("trade_date", date)
      .maybeSingle();
    if (error) throw new Error(`${stockCode} ${date} 최근 시세 조회 실패: ${error.message}`);
    if (data) return fromHotRow(data as HotTableRow);
  }

  const year = Number(date.slice(0, 4));
  const lookup = await getYearLookup(year);
  return lookup.get(toLookupKey(stockCode, date)) ?? null;
}

const DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS = 10;

/** date 이전(포함) 가장 가까운 거래일의 시세를 찾는다(최대 maxLookbackDays일 전까지
 * 하루씩 물러나며 시도). 재무 공시일(rcept_date)이 주말/공휴일인 경우가 있어, "그
 * 시점 상장주식수"가 필요한데 정확히 그날 시세가 없을 수 있는 경우(EPS 성장률 계산
 * 등)에 쓴다. */
export async function getDailyPriceOnOrBefore(
  stockCode: string,
  date: string,
  maxLookbackDays: number = DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS
): Promise<StockDailyPriceRow | null> {
  let d = date;
  for (let i = 0; i <= maxLookbackDays; i++) {
    const row = await getDailyPrice(stockCode, d);
    if (row) return row;
    d = addDays(d, -1);
  }
  return null;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 여러 종목의 date 이전(포함) 가장 가까운 거래일 시세를 배치로 찾는다(최대
 * maxLookbackDays일 전까지 하루씩 물러나며 시도) — getDailyPriceOnOrBefore와 계산
 * 규칙은 같지만, 종목마다 개별 쿼리하지 않고 날짜별로 아직 못 찾은 종목들만 모아
 * 한 번에 조회한다(hot: `.in("stock_code", codes)` 단일 쿼리, cold: 그 연도
 * lookup을 코드 집합으로 필터). 테마 등락률 계산(lib/themeReturns.ts)처럼 한 번에
 * 수십~수백 종목의 시작/종료 시점 종가가 필요한 경우, 종목별 개별 조회 대비 쿼리
 * 횟수가 종목 수와 무관하게 날짜 수(최대 maxLookbackDays)만큼으로 줄어든다. */
export async function getDailyPricesForStocksOnOrBefore(
  stockCodes: string[],
  date: string,
  maxLookbackDays: number = DEFAULT_ON_OR_BEFORE_LOOKBACK_DAYS
): Promise<Map<string, StockDailyPriceRow>> {
  const remaining = new Set(stockCodes);
  const result = new Map<string, StockDailyPriceRow>();
  let d = date;

  for (let i = 0; i <= maxLookbackDays && remaining.size > 0; i++) {
    const codes = Array.from(remaining);
    let rows: StockDailyPriceRow[];

    if (d >= hotWindowStartDate()) {
      const { data, error } = await supabaseAdmin
        .from(HOT_TABLE)
        .select("stock_code, trade_date, close_price, market_cap_eok, listed_shares, open_price, volume")
        .in("stock_code", codes)
        .eq("trade_date", d);
      if (error) throw new Error(`${d} 최근 시세 배치 조회 실패: ${error.message}`);
      rows = (data ?? []).map((row) => fromHotRow(row as HotTableRow));
    } else {
      const lookup = await getYearLookup(Number(d.slice(0, 4)));
      rows = codes
        .map((code) => lookup.get(toLookupKey(code, d)))
        .filter((row): row is StockDailyPriceRow => row !== undefined);
    }

    for (const row of rows) {
      result.set(row.stockCode, row);
      remaining.delete(row.stockCode);
    }

    d = addDays(d, -1);
  }

  return result;
}

/** stockCode의 [startDate, endDate](양 끝 포함) 구간 일별시세를 tradeDate 오름차순으로
 * 반환한다 — 백테스트/스크리닝이 날짜별로 매번 getDailyPrice를 부르지 않고 한 번에
 * 확보하는 용도(예: DH전략처럼 재무 시계열을 매일 재평가하는 전략의 백테스트). cold
 * 구간(연도별 Parquet, getYearLookup 캐시 재사용)은 날짜별로 맵 조회만 하고, hot
 * 구간(Postgres)은 단일 range 쿼리로 가져와 합친다. */
export async function getDailyPriceSeries(
  stockCode: string,
  startDate: string,
  endDate: string
): Promise<StockDailyPriceRow[]> {
  if (startDate > endDate) return [];

  const hotStart = hotWindowStartDate();
  const rows: StockDailyPriceRow[] = [];

  if (startDate < hotStart) {
    const coldEndDate = endDate < hotStart ? endDate : addDays(hotStart, -1);
    const startYear = Number(startDate.slice(0, 4));
    const coldEndYear = Number(coldEndDate.slice(0, 4));

    for (let year = startYear; year <= coldEndYear; year++) {
      const lookup = await getYearLookup(year);
      const yearStart = year === startYear ? startDate : `${year}-01-01`;
      const yearEnd = year === coldEndYear ? coldEndDate : `${year}-12-31`;

      for (let d = yearStart; d <= yearEnd; d = addDays(d, 1)) {
        const row = lookup.get(toLookupKey(stockCode, d));
        if (row) rows.push(row);
      }
    }
  }

  if (endDate >= hotStart) {
    const hotQueryStart = startDate > hotStart ? startDate : hotStart;
    const { data, error } = await supabaseAdmin
      .from(HOT_TABLE)
      .select("stock_code, trade_date, close_price, market_cap_eok, listed_shares, open_price, volume")
      .eq("stock_code", stockCode)
      .gte("trade_date", hotQueryStart)
      .lte("trade_date", endDate);
    if (error) throw new Error(`${stockCode} 최근 구간 시세 조회 실패: ${error.message}`);
    for (const row of data ?? []) rows.push(fromHotRow(row as HotTableRow));
  }

  rows.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  return rows;
}

/** 여러 연도에 걸쳐 minMarketCapEok(억원) 이상이었던 적 있는 종목코드 집합을 반환한다
 * — 재무/배당 백필의 후보종목 발굴에 쓴다. 저장 자체는 더 낮은 하한
 * (STOCK_DATA_BACKFILL_MARKET_CAP_FLOOR_EOK)으로 돼 있으므로, 여기서 실제 후보
 * 기준(minMarketCapEok)으로 다시 걸러야 한다. hot 구간(Postgres)에는 원래 15년
 * Parquet 백필 이후 새로 쌓인 행이 있을 수 있어 별도로 한 번 더 확인한다. */
export async function discoverCandidateStockCodes(years: number[], minMarketCapEok: number): Promise<string[]> {
  const codes = new Set<string>();
  for (const year of years) {
    const lookup = await getYearLookup(year);
    for (const row of lookup.values()) {
      if (row.marketCapEok >= minMarketCapEok) codes.add(row.stockCode);
    }
  }

  const { data, error } = await supabaseAdmin
    .from(HOT_TABLE)
    .select("stock_code")
    .gte("market_cap_eok", minMarketCapEok)
    .gte("trade_date", hotWindowStartDate());
  if (error) throw new Error(`최근 후보종목 조회 실패: ${error.message}`);
  for (const row of data ?? []) codes.add(row.stock_code);

  return Array.from(codes);
}

/** stock_daily_prices_recent에 오늘치(또는 특정일) 시세를 저장한다(upsert) — 매일
 * 갱신 배치가 쓴다. */
// 한 번에 upsert할 최대 행 수. 2026-09-06 시가/거래량 컬럼 추가 + reversal_breakout
// 예외 종목 확장으로 연간 행 수가 늘면서, 한 해(14만 행 이상)를 통째로 upsert하다가
// "statement timeout"으로 실패하는 걸 실측으로 확인했다(seed-stock-daily-prices-recent.ts
// 재시딩 중 2025년 처리 단계). 일별 갱신 배치(update-stock-daily-prices-recent.ts, 하루
// ~2천 행)는 원래도 이 한도 밑이라 영향 없다.
const UPSERT_RECENT_PRICES_BATCH_SIZE = 5000;

export async function upsertRecentPrices(rows: StockDailyPriceRow[]): Promise<void> {
  if (rows.length === 0) return;
  const payload = rows.map((r) => ({
    stock_code: r.stockCode,
    trade_date: r.tradeDate,
    close_price: r.closePrice,
    market_cap_eok: r.marketCapEok,
    listed_shares: r.listedShares,
    open_price: r.openPrice,
    volume: r.volume,
  }));

  for (let i = 0; i < payload.length; i += UPSERT_RECENT_PRICES_BATCH_SIZE) {
    const batch = payload.slice(i, i + UPSERT_RECENT_PRICES_BATCH_SIZE);
    const { error } = await supabaseAdmin.from(HOT_TABLE).upsert(batch);
    if (error) throw new Error(`최근 시세 저장 실패: ${error.message}`);
  }
}

/** stock_daily_prices_recent에 이미 있는 가장 최근 날짜(YYYY-MM-DD). 매일 갱신
 * 배치가 "어디부터 이어받을지" 판단하는 데 쓴다. 표가 비어있으면 null. */
export async function getLatestRecentPriceDate(): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from(HOT_TABLE)
    .select("trade_date")
    .order("trade_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`최근 시세 최신 날짜 조회 실패: ${error.message}`);
  return data?.trade_date ?? null;
}

/** cutoffDate(YYYY-MM-DD) 이전(미포함하지 않음, cutoffDate 당일은 hot 구간에 남김)
 * 행을 전부 가져온다 — 연 1회 아카이빙 배치가 Parquet로 옮길 대상을 고를 때 쓴다. */
export async function getRecentPricesBefore(cutoffDate: string): Promise<StockDailyPriceRow[]> {
  const { data, error } = await supabaseAdmin
    .from(HOT_TABLE)
    .select("stock_code, trade_date, close_price, market_cap_eok, listed_shares, open_price, volume")
    .lt("trade_date", cutoffDate);
  if (error) throw new Error(`아카이빙 대상 조회 실패: ${error.message}`);
  return (data ?? []).map((row) => fromHotRow(row as HotTableRow));
}

/** cutoffDate 이전 행을 stock_daily_prices_recent에서 지운다 — 아카이빙 배치가
 * Parquet 업로드에 성공한 뒤에만 불러야 한다(그래야 실패 시 데이터가 두 군데 다
 * 없어지는 사고를 막는다). */
export async function deleteRecentPricesBefore(cutoffDate: string): Promise<void> {
  const { error } = await supabaseAdmin.from(HOT_TABLE).delete().lt("trade_date", cutoffDate);
  if (error) throw new Error(`아카이빙 완료 행 삭제 실패: ${error.message}`);
}

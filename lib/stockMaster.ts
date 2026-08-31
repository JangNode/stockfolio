import "server-only";
import AdmZip from "adm-zip";
import iconv from "iconv-lite";
import { THEME_CODES, type ThemeCode } from "@/lib/themeConfig";

const MASTER_URLS = {
  KOSPI: "https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip",
  KOSDAQ: "https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip",
} as const;

type Market = keyof typeof MASTER_URLS;

// 이름 필드 뒤에 붙는 상품구분 코드(그룹코드 2자 + 시장구분 숫자 1자)로 이름 필드의 끝을 찾는다.
// 그룹2(ST/MF/RT/SR/EF/SW/EN/FS)는 종목 유형이다 — RT=리츠, EF=ETF, EN=ETN.
const GROUP_CODE_PATTERN = /^(.*?)(ST|MF|RT|SR|EF|SW|EN|FS)\d/;

// KIS 종목마스터(.mst)는 각 줄이 "코드(9)+표준코드(12)+한글명(가변)" 뒤에 시장별로 길이가
// 다른 고정폭 필드 블록이 붙는 구조다(코스피 228바이트, 코스닥 222바이트 — 필드 순서도 다름).
// 상장일자 필드의 위치는 KIS 공식 예제(github.com/koreainvestment/open-trading-api의
// stocks_info/kis_kospi_code_mst.py, kis_kosdaq_code_mst.py)의 필드 스펙에서 계산한
// 값에서 실제 종목(삼성전자 19750611, SK하이닉스 19961226, 에스엠 20000427,
// 펄어비스 20170914 등)으로 검증해 1바이트 보정했다 — 스펙 그대로 계산한 값은 항상
// 마지막 한 글자가 잘리고 앞에 0이 붙어 나왔다(예: 19750611 대신 01975061).
// statusFlagsOffset부터 1바이트씩 순서대로 거래정지/정리매매/관리종목 여부('Y'/'N')가
// 온다. KIS 공식 스펙(github.com/koreainvestment/open-trading-api의
// kis_kospi_code_mst.py, kis_kosdaq_code_mst.py)의 필드 순서를 기준으로 위치를 계산했는데,
// 상장일자 필드와 마찬가지로 스펙 그대로 계산한 값이 실제로는 밀려 있어 실제 파일(2026-08-20
// 다운로드본, KOSPI 2563종목·KOSDAQ 1822종목)로 후보 구간의 문자 분포를 찍어 검증했다 —
// 관리종목 비율(KOSPI 1.5%, KOSDAQ 6.8%로 KOSDAQ이 훨씬 높음)과 정리매매 비율(둘 다 0%에
// 가까움)이 실제 시장 특성과 맞아떨어지는 지점을 찾아 확정했다
// (scripts/verify-kr-status-flags.ts로 검증, 확인 후 삭제).
const MARKET_LAYOUT: Record<
  Market,
  { tailLength: number; listedDateOffset: number; listedDateWidth: number; statusFlagsOffset: number }
> = {
  KOSPI: { tailLength: 228, listedDateOffset: 106, listedDateWidth: 8, statusFlagsOffset: 61 },
  KOSDAQ: { tailLength: 222, listedDateOffset: 101, listedDateWidth: 8, statusFlagsOffset: 56 },
};

// KRX 섹터 테마 플래그(lib/themeConfig.ts의 THEME_CODES) 오프셋. KIS 공식 스펙
// (github.com/koreainvestment/open-trading-api의 stocks_info/kis_kospi_code_mst.py,
// kis_kosdaq_code_mst.py의 part2_columns/field_specs)에서 필드 순서대로 계산한 위치는,
// 위 listedDateOffset/statusFlagsOffset과 마찬가지로 실제 파일에서는 정확히 1바이트씩
// 밀려 있다 — 이미 실파일로 검증된 두 앵커(코스피: 스펙상 상장일자 105→실제 106,
// 스펙상 상태플래그(거래정지) 60→실제 61 / 코스닥: 스펙상 상장일자 100→실제 101,
// 스펙상 상태플래그(거래정지) 55→실제 56) 모두 정확히 +1로 밀려 있다는 걸 근거로,
// 스펙에서 계산한 테마 플래그 위치에도 동일한 +1을 적용했다(같은 파일의 같은 블록
// 안에서 이미 앞뒤로 검증된 두 지점이 똑같이 밀려 있으므로 그 사이 필드들도 같은
// 폭으로 밀려 있을 개연성이 높다). 다만 이 필드들 자체의 실제 'Y'/'N' 값은 아직
// 실파일로 재확인하지 못했다 — scripts/verify-kr-theme-flags.ts를 workflow_dispatch로
// 실행해 알려진 종목(삼성전자=반도체, 현대차=자동차, KB금융=은행 등)으로 최종 확인
// 후 이 주석과 함께 필요하면 값을 보정할 것.
const THEME_FLAG_OFFSETS: Record<Market, Record<ThemeCode, number>> = {
  KOSPI: {
    krx_auto: 26,
    krx_semiconductor: 27,
    krx_bio: 28,
    krx_bank: 29,
    krx_energy_chemical: 31,
    krx_steel: 32,
    krx_media_telecom: 34,
    krx_construction: 35,
    krx_securities: 37,
    krx_shipbuilding: 38,
    krx_insurance: 39,
    krx_transport: 40,
  },
  KOSDAQ: {
    krx_auto: 21,
    krx_semiconductor: 22,
    krx_bio: 23,
    krx_bank: 24,
    krx_energy_chemical: 26,
    krx_steel: 27,
    krx_media_telecom: 29,
    krx_construction: 30,
    krx_securities: 32,
    krx_shipbuilding: 33,
    krx_insurance: 34,
    krx_transport: 35,
  },
};

export interface StockEntry {
  code: string;
  name: string;
  // 종목구분코드(ST/MF/RT/SR/EF/SW/EN/FS). 스크리닝 배치의 잡주(리츠/ETF/ETN) 필터링에 쓴다.
  productType: string;
  // 상장일자(YYYYMMDD). 필드를 못 찾거나 형식이 이상하면 null — 이 경우 신규상장 여부를
  // 판단할 수 없으므로 호출부에서 걸러내지 않고 통과시켜야 한다.
  listedDate: string | null;
  // 상장폐지 위험 관련 상태 플래그. 스크리닝 배치의 잡주 필터링에 쓴다.
  isTradingHalted: boolean; // 거래정지
  isLiquidationTrading: boolean; // 정리매매(상장폐지 확정, 정리매매 기간)
  isAdministrativeIssue: boolean; // 관리종목 지정
  // KRX 섹터 테마(자동차/반도체/바이오/은행/... lib/themeConfig.ts 참고) 소속 여부.
  // 테마/업종별 등락률 순위 화면·배치에 쓴다.
  themeFlags: Record<ThemeCode, boolean>;
}

interface MasterCache {
  entries: StockEntry[];
  codeToName: Map<string, string>;
  // 이름 대소문자를 구분하지 않고 찾을 수 있도록 소문자로 정규화한 이름을 키로 사용한다.
  nameToEntry: Map<string, StockEntry>;
  loadedAt: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let cache: MasterCache | null = null;
let loading: Promise<MasterCache> | null = null;

/** 상장일자 필드를 파싱한다. 8자리 숫자가 아니면(빈 값, 공백 등) null. */
function parseListedDate(line: string, market: Market): string | null {
  const { tailLength, listedDateOffset, listedDateWidth } = MARKET_LAYOUT[market];
  if (line.length < tailLength) return null;

  const tail = line.slice(-tailLength);
  const raw = tail.slice(listedDateOffset, listedDateOffset + listedDateWidth);
  return /^\d{8}$/.test(raw) ? raw : null;
}

interface StatusFlags {
  isTradingHalted: boolean;
  isLiquidationTrading: boolean;
  isAdministrativeIssue: boolean;
}

/** 거래정지/정리매매/관리종목 여부를 파싱한다. 필드를 못 찾으면(줄이 너무 짧음) 셋 다 false —
 * 상장폐지 위험 여부를 알 수 없는 경우 걸러내지 않고 통과시킨다(listedDate와 같은 원칙). */
function parseStatusFlags(line: string, market: Market): StatusFlags {
  const { tailLength, statusFlagsOffset } = MARKET_LAYOUT[market];
  if (line.length < tailLength) {
    return { isTradingHalted: false, isLiquidationTrading: false, isAdministrativeIssue: false };
  }

  const tail = line.slice(-tailLength);
  return {
    isTradingHalted: tail[statusFlagsOffset] === "Y",
    isLiquidationTrading: tail[statusFlagsOffset + 1] === "Y",
    isAdministrativeIssue: tail[statusFlagsOffset + 2] === "Y",
  };
}

/** 테마 플래그를 파싱한다. 필드를 못 찾으면(줄이 너무 짧음) 전부 false — 잘못
 * 분류하는 것보다 어느 테마에도 속하지 않는 것으로 안전하게 처리한다. */
function parseThemeFlags(line: string, market: Market): Record<ThemeCode, boolean> {
  const { tailLength } = MARKET_LAYOUT[market];
  const offsets = THEME_FLAG_OFFSETS[market];
  const result = {} as Record<ThemeCode, boolean>;

  if (line.length < tailLength) {
    for (const code of THEME_CODES) result[code] = false;
    return result;
  }

  const tail = line.slice(-tailLength);
  for (const code of THEME_CODES) {
    result[code] = tail[offsets[code]] === "Y";
  }
  return result;
}

function parseMasterFile(buffer: Buffer, market: Market): StockEntry[] {
  const text = iconv.decode(buffer, "euc-kr");
  const entries: StockEntry[] = [];

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;

    const code = line.slice(0, 9).trim();
    const rest = line.slice(21);
    const match = rest.match(GROUP_CODE_PATTERN);
    if (!code || !match) continue;

    const name = match[1].trim();
    if (!name) continue;

    entries.push({
      code,
      name,
      productType: match[2],
      listedDate: parseListedDate(line, market),
      ...parseStatusFlags(line, market),
      themeFlags: parseThemeFlags(line, market),
    });
  }

  return entries;
}

async function downloadAndParse(url: string, market: Market): Promise<StockEntry[]> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`종목마스터 파일 다운로드 실패 (${res.status}): ${url}`);
  }

  const zipBuffer = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(zipBuffer);
  const [entry] = zip.getEntries();
  if (!entry) {
    throw new Error(`종목마스터 zip 파일이 비어 있습니다: ${url}`);
  }

  return parseMasterFile(entry.getData(), market);
}

async function loadMaster(): Promise<MasterCache> {
  const [kospi, kosdaq] = await Promise.all([
    downloadAndParse(MASTER_URLS.KOSPI, "KOSPI"),
    downloadAndParse(MASTER_URLS.KOSDAQ, "KOSDAQ"),
  ]);

  const entries = [...kospi, ...kosdaq];
  const codeToName = new Map<string, string>();
  const nameToEntry = new Map<string, StockEntry>();

  for (const entry of entries) {
    codeToName.set(entry.code, entry.name);
    const key = entry.name.toLowerCase();
    // 동일한 이름이 여러 종목코드에 걸쳐 있으면 먼저 등록된 항목(코스피 우선)을 유지한다.
    if (!nameToEntry.has(key)) {
      nameToEntry.set(key, entry);
    }
  }

  return { entries, codeToName, nameToEntry, loadedAt: Date.now() };
}

async function getCache(): Promise<MasterCache> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache;
  }

  if (!loading) {
    loading = loadMaster()
      .then((result) => {
        cache = result;
        return result;
      })
      .finally(() => {
        loading = null;
      });
  }

  return loading;
}

/** KOSPI+KOSDAQ 전 종목 목록을 반환한다. */
export async function getAllStocks(): Promise<StockEntry[]> {
  const { entries } = await getCache();
  return entries;
}

export async function findNameByCode(code: string): Promise<string | null> {
  const { codeToName } = await getCache();
  return codeToName.get(code) ?? null;
}

export async function findByExactName(name: string): Promise<StockEntry | null> {
  const { nameToEntry } = await getCache();
  return nameToEntry.get(name.toLowerCase()) ?? null;
}

export async function searchStocks(
  query: string,
  limit = 10
): Promise<StockEntry[]> {
  const { entries } = await getCache();
  const q = query.trim().toLowerCase();
  if (!q) return [];

  return entries
    .filter((e) => e.name.toLowerCase().includes(q) || e.code.includes(q))
    .slice(0, limit);
}

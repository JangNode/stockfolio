import "server-only";
import AdmZip from "adm-zip";
import iconv from "iconv-lite";

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
const MARKET_LAYOUT: Record<
  Market,
  { tailLength: number; listedDateOffset: number; listedDateWidth: number }
> = {
  KOSPI: { tailLength: 228, listedDateOffset: 106, listedDateWidth: 8 },
  KOSDAQ: { tailLength: 222, listedDateOffset: 101, listedDateWidth: 8 },
};

export interface StockEntry {
  code: string;
  name: string;
  // 종목구분코드(ST/MF/RT/SR/EF/SW/EN/FS). 스크리닝 배치의 잡주(리츠/ETF/ETN) 필터링에 쓴다.
  productType: string;
  // 상장일자(YYYYMMDD). 필드를 못 찾거나 형식이 이상하면 null — 이 경우 신규상장 여부를
  // 판단할 수 없으므로 호출부에서 걸러내지 않고 통과시켜야 한다.
  listedDate: string | null;
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

import "server-only";
import AdmZip from "adm-zip";
import iconv from "iconv-lite";

const MASTER_URLS = {
  KOSPI: "https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip",
  KOSDAQ: "https://new.real.download.dws.co.kr/common/master/kosdaq_code.mst.zip",
} as const;

// 이름 필드 뒤에 붙는 상품구분 코드(그룹코드 2자 + 시장구분 숫자 1자)로 이름 필드의 끝을 찾는다.
const GROUP_CODE_PATTERN = /^(.*?)(ST|MF|RT|SR|EF|SW|EN|FS)\d/;

export interface StockEntry {
  code: string;
  name: string;
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

function parseMasterFile(buffer: Buffer): StockEntry[] {
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

    entries.push({ code, name });
  }

  return entries;
}

async function downloadAndParse(url: string): Promise<StockEntry[]> {
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

  return parseMasterFile(entry.getData());
}

async function loadMaster(): Promise<MasterCache> {
  const [kospi, kosdaq] = await Promise.all([
    downloadAndParse(MASTER_URLS.KOSPI),
    downloadAndParse(MASTER_URLS.KOSDAQ),
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

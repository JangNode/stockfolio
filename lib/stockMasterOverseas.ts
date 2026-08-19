import "server-only";
import AdmZip from "adm-zip";
import iconv from "iconv-lite";
import type { OverseasExchangeCode } from "@/lib/kis";

const MASTER_URLS: Record<OverseasExchangeCode, string> = {
  NAS: "https://new.real.download.dws.co.kr/common/master/nasmst.cod.zip",
  NYS: "https://new.real.download.dws.co.kr/common/master/nysmst.cod.zip",
  AMS: "https://new.real.download.dws.co.kr/common/master/amsmst.cod.zip",
};

// KIS 공식 예제(github.com/koreainvestment/open-trading-api의
// stocks_info/overseas_stock_code.py)가 쓰는 24개 컬럼 순서. 국내 마스터파일과 달리
// 탭 구분 텍스트라 고정폭 파싱이 필요 없다.
const COLUMNS = [
  "nationalCode",
  "exchangeId",
  "exchangeCode",
  "exchangeName",
  "symbol",
  "realtimeSymbol",
  "koreanName",
  "englishName",
  "securityType", // 1:Index, 2:Stock, 3:ETP(ETF), 4:Warrant
  "currency",
  "floatPosition",
  "dataType",
  "basePrice",
  "bidOrderSize",
  "askOrderSize",
  "marketStartTime",
  "marketEndTime",
  "isDr",
  "drCountryCode",
  "sectorCode",
  "hasIndexConstituent",
  "tickSizeType",
  "productType", // 001:ETF, 002:ETN, 003:ETC, 004:Others, 005:VIX ETF, 006:VIX ETN
  "tickSizeTypeDetail",
] as const;

const SECURITY_TYPE_STOCK = "2";

export interface OverseasStockEntry {
  code: string; // symbol
  name: string; // englishName
  exchange: OverseasExchangeCode;
}

interface MasterCache {
  entries: OverseasStockEntry[];
  loadedAt: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let cache: MasterCache | null = null;
let loading: Promise<MasterCache> | null = null;

function parseMasterFile(buffer: Buffer, exchange: OverseasExchangeCode): OverseasStockEntry[] {
  const text = iconv.decode(buffer, "cp949");
  const entries: OverseasStockEntry[] = [];
  const lines = text.split("\n");

  // 첫 줄은 KIS가 자체적으로 붙인 헤더라 건너뛴다(컬럼 수가 COLUMNS와 다를 수 있어
  // 헤더 내용 자체는 신뢰하지 않고, 고정된 COLUMNS 순서를 그대로 쓴다).
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;

    const fields = line.split("\t");
    if (fields.length < COLUMNS.length) continue;

    const record: Record<string, string> = {};
    COLUMNS.forEach((col, i) => {
      record[col] = fields[i]?.trim() ?? "";
    });

    // Index/ETP(ETF)/Warrant는 여기서 걸러낸다 — 국내 마스터파일의 정규식 그룹코드
    // 추측과 달리 이 필드는 명시적이라 오탐 우려가 없다.
    if (record.securityType !== SECURITY_TYPE_STOCK) continue;
    if (!record.symbol || !record.englishName) continue;

    entries.push({ code: record.symbol, name: record.englishName, exchange });
  }

  return entries;
}

async function downloadAndParse(exchange: OverseasExchangeCode): Promise<OverseasStockEntry[]> {
  const url = MASTER_URLS[exchange];
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`해외 종목마스터 파일 다운로드 실패 (${res.status}): ${url}`);
  }

  const zipBuffer = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(zipBuffer);
  const [entry] = zip.getEntries();
  if (!entry) {
    throw new Error(`해외 종목마스터 zip 파일이 비어 있습니다: ${url}`);
  }

  return parseMasterFile(entry.getData(), exchange);
}

async function loadMaster(): Promise<MasterCache> {
  const [nas, nys, ams] = await Promise.all([
    downloadAndParse("NAS"),
    downloadAndParse("NYS"),
    downloadAndParse("AMS"),
  ]);

  return { entries: [...nas, ...nys, ...ams], loadedAt: Date.now() };
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

/** 나스닥+뉴욕+아멕스 전 종목(Stock 타입만, ETF/지수/워런트 제외) 목록을 반환한다. */
export async function getAllOverseasStocks(): Promise<OverseasStockEntry[]> {
  const { entries } = await getCache();
  return entries;
}

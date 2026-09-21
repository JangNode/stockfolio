import "server-only";

/**
 * 상장폐지 종목 목록 — FinanceDataReader의 KRX 상장폐지 종목 목록 캐시
 * (github.com/FinanceData/fdr_krx_data_cache, data/listing/delisting/)에서
 * 가져온다. KRX 공식 사이트가 아니라 이를 미러링하는 서드파티 캐시다 —
 * 100% 정확성을 보장하지 않지만, 2026-09 생존편향 진단 때도 같은 소스를
 * 썼고 감수하고 쓰기로 한 상태를 유지한다.
 *
 * 종목 시세 백필의 저장 예외 목록에 쓴다(getThemeFlaggedStockCodes와 같은
 * 용도) — 시가총액 하한 미달이어도 상장폐지 종목이면 저장 대상에 포함시켜
 * 생존편향을 줄인다. 상장폐지 종목은 정의상 오늘 KIS 종목마스터에 없어
 * lib/stockMaster.ts로는 확보할 수 없다.
 */

const DELISTING_CSV_BASE_URL =
  "https://raw.githubusercontent.com/FinanceData/fdr_krx_data_cache/master/data/listing/delisting";
// 매일 파일이 올라오지 않을 수 있어(주말 등, 실측 확인) 최근 파일을 거슬러 찾는다.
const LOOKBACK_DAYS = 10;
// 매일 갱신되는 데이터가 아니라(상장폐지는 드문드문 발생) 24시간 캐시로 충분하다.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let cache: { codes: Set<string>; loadedAt: number } | null = null;
let loading: Promise<Set<string>> | null = null;

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** RFC4180 스타일 CSV 한 줄 파싱 — 이 소스의 Reason 필드가 쉼표를 포함한 채
 * 따옴표로 감싸져 있어(예: "최종부도 또는 당좌거래정지(1년) , 기타 등록취소")
 * 단순 split(",")로는 필드가 깨진다. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

async function fetchLatestDelistingCsv(): Promise<string> {
  const today = new Date();
  let lastError: unknown;
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const url = `${DELISTING_CSV_BASE_URL}/${toDateKey(d)}.csv`;
    try {
      const res = await fetch(url);
      if (res.ok) return await res.text();
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `최근 ${LOOKBACK_DAYS}일 내 상장폐지 종목 목록 CSV를 찾지 못했습니다: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

/** CSV를 파싱해 KOSPI/KOSDAQ 보통주(SecuGroup=주권)의 종목코드만 뽑는다.
 * 신주인수권증서/증권 등 파생 상품 코드는 KRX 일별매매정보(stk_bydd_trd/
 * ksq_bydd_trd)의 6자리 ISU_CD 형식과 안 맞아 제외한다. 합병 등으로 인한
 * 폐지(ToSymbol/ToName이 채워진 행)도 구분 없이 그대로 포함한다 — 파산형과
 * 달리 손실 편향이 아니라 놓친 기회 편향이라 지금 우선순위는 아니지만, 시세
 * 데이터 자체를 채우는 데는 지장이 없다(2026-09-21 판단). */
function parseDelistedCodes(csvText: string): Set<string> {
  const lines = csvText.split("\n").filter((line) => line.trim());
  if (lines.length === 0) return new Set();

  const header = parseCsvLine(lines[0]);
  const symbolIdx = header.indexOf("Symbol");
  const marketIdx = header.indexOf("Market");
  const secuGroupIdx = header.indexOf("SecuGroup");
  if (symbolIdx === -1 || marketIdx === -1 || secuGroupIdx === -1) {
    throw new Error("상장폐지 종목 목록 CSV 헤더 형식이 예상과 다릅니다(Symbol/Market/SecuGroup 컬럼 없음).");
  }

  const codes = new Set<string>();
  for (const line of lines.slice(1)) {
    const fields = parseCsvLine(line);
    const symbol = fields[symbolIdx]?.trim();
    const market = fields[marketIdx]?.trim();
    const secuGroup = fields[secuGroupIdx]?.trim();
    if (!symbol || secuGroup !== "주권") continue;
    if (market !== "KOSPI" && market !== "KOSDAQ") continue;
    codes.add(symbol);
  }
  return codes;
}

/** 상장폐지된 KOSPI/KOSDAQ 보통주 종목코드 집합(24시간 캐시). */
export async function getDelistedStockCodes(): Promise<Set<string>> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.codes;

  if (!loading) {
    loading = fetchLatestDelistingCsv()
      .then(parseDelistedCodes)
      .then((codes) => {
        cache = { codes, loadedAt: Date.now() };
        return codes;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/**
 * 관심종목 적정주가 기능(방법A: 업종 평균 PER)에 필요한 업종 분류 데이터를 DART
 * company.json(기업개황) API가 실제로 제공하는지 확인한다. 이 코드베이스 어디에도
 * 종목별 업종(섹터) 분류 데이터가 없고, DART 공식 문서 기억만으로 induty_code
 * 필드가 있다고 가정하는 건 SKILLS.md 원칙(추측으로 파서 작성 금지)에 어긋난다 —
 * 이 세션 샌드박스에서 opendart.fss.or.kr에 직접 접근할 수 없어 GitHub Actions로
 * 실행해 실응답을 본다.
 *
 * 삼성전자(005930)/SK하이닉스(000660)/현대차(005380) 3사로 호출해 raw JSON을 그대로
 * 찍어, induty_code 필드 존재 여부·형식·값을 확인한다. corp_code는 이미 동기화된
 * dart_corp_codes 테이블에서 조회한다(scripts/sync-dart-corp-codes.ts 참고).
 *
 * DB에는 아무것도 쓰지 않는 읽기 전용 진단 — 확인 끝나면 정리 PR에서 스크립트/
 * 워크플로와 함께 삭제한다.
 *
 * 필요 환경변수: DART_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   tsx --conditions=react-server scripts/diagnose-dart-company-overview.ts
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";

const DART_BASE_URL = "https://opendart.fss.or.kr/api";
const SAMPLE_STOCK_CODES = ["005930", "000660", "005380"];

function getDartApiKey(): string {
  const key = process.env.DART_API_KEY;
  if (!key) throw new Error("DART_API_KEY 환경 변수가 없습니다.");
  return key;
}

async function getCorpCodeMap(stockCodes: string[]): Promise<Map<string, string>> {
  const { data, error } = await supabaseAdmin
    .from("dart_corp_codes")
    .select("stock_code, corp_code")
    .in("stock_code", stockCodes);
  if (error) throw new Error(`corp_code 조회 실패: ${error.message}`);
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    if (row.stock_code) map.set(row.stock_code, row.corp_code);
  }
  return map;
}

async function diagnoseCompanyOverview(): Promise<void> {
  console.log("########## DART company.json(기업개황) 진단 ##########\n");

  const corpCodeMap = await getCorpCodeMap(SAMPLE_STOCK_CODES);
  console.log(`corp_code 매핑: ${JSON.stringify(Object.fromEntries(corpCodeMap))}\n`);

  const apiKey = getDartApiKey();

  for (const stockCode of SAMPLE_STOCK_CODES) {
    const corpCode = corpCodeMap.get(stockCode);
    console.log(`--- ${stockCode} (corp_code=${corpCode ?? "매핑 없음"}) ---`);
    if (!corpCode) {
      console.log("  corp_code 매핑이 없어 건너뜁니다.\n");
      continue;
    }

    try {
      const url = `${DART_BASE_URL}/company.json?crtfc_key=${encodeURIComponent(apiKey)}&corp_code=${corpCode}`;
      const res = await fetch(url);
      const text = await res.text();
      console.log(`  HTTP ${res.status}`);
      console.log(`  ${text}`);
    } catch (error) {
      console.log(`  호출 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log();
  }
}

diagnoseCompanyOverview()
  .then(() => console.log("=== 진단 종료 ==="))
  .catch((error) => {
    console.error("진단 스크립트 실행 중 오류:", error);
    process.exit(1);
  });

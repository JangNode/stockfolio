import "server-only";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const DART_BASE_URL = "https://opendart.fss.or.kr/api";

function getDartApiKey(): string {
  const key = process.env.DART_API_KEY;
  if (!key) throw new Error("DART_API_KEY 환경 변수가 설정되지 않았습니다.");
  return key;
}

// 재무제표/배당은 KIS 자체 API로 대체했다(lib/kis.ts의 getIncomeStatementYears 등 참고
// — 한투 앱 표시값과 실측 비교해 이 값이 더 정확함을 확인했다). DART는 corp_code
// 매핑만 남긴다 — 향후 종목별 공시 원문(사업보고서 등) 목록 조회 기능을 붙일 때
// stock_code ↔ corp_code 매핑이 필요하기 때문이다.
async function logDartCall(status: "success" | "error", dartStatusCode?: string): Promise<void> {
  try {
    await supabaseAdmin.from("dart_api_call_log").insert({
      endpoint: "corpCode",
      status,
      dart_status_code: dartStatusCode ?? null,
    });
  } catch {
    // 로그 적재 실패로 실제 기능(매핑 동기화)까지 실패시키지 않는다.
  }
}

export interface DartCorpCodeEntry {
  corpCode: string;
  corpName: string;
  stockCode: string | null;
  modifyDate: string;
}

interface CorpCodeListItem {
  corp_code: string;
  corp_name: string;
  stock_code?: string | null;
  modify_date: string;
}

/** corpCode.xml(zip) 전체를 내려받아 파싱한다. DB 저장은 호출부(동기화 배치)의 몫이다 —
 * 이 함수는 순수 다운로드+파싱만 한다. 인증키가 잘못됐거나 DART 쪽 오류면 zip이 아니라
 * 에러 상태를 담은 작은 XML이 내려오므로, unzip이 실패하면 그걸로 에러 메시지를 읽는다. */
export async function fetchCorpCodeMap(): Promise<DartCorpCodeEntry[]> {
  const url = `${DART_BASE_URL}/corpCode.xml?crtfc_key=${encodeURIComponent(getDartApiKey())}`;
  const res = await fetch(url);
  if (!res.ok) {
    await logDartCall("error");
    throw new Error(`DART corpCode.xml 다운로드 실패: HTTP ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  // parseTagValue: false — 기본값(true)이면 corp_code/stock_code처럼 숫자로만 보이는
  // 태그값을 숫자로 바꿔버려서 앞자리 0이 통째로 사라진다("005930" → 5930). 종목코드가
  // 전부 0으로 시작할 수 있는 6자리 문자열이라 반드시 꺼야 한다.
  const parser = new XMLParser({ isArray: (name) => name === "list", parseTagValue: false });

  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    // zip이 아니면 DART가 에러를 XML로 바로 내려준 경우다({status, message}).
    const errorXml = parser.parse(buffer.toString("utf-8"));
    const message = errorXml?.result?.message ?? "알 수 없는 오류";
    const statusCode = errorXml?.result?.status;
    await logDartCall("error", statusCode);
    throw new Error(`DART corpCode.xml 응답 오류: ${message}`);
  }

  const xmlEntry = zip.getEntries().find((e) => e.entryName.toUpperCase() === "CORPCODE.XML");
  if (!xmlEntry) {
    await logDartCall("error");
    throw new Error("CORPCODE.xml 항목을 zip에서 찾을 수 없습니다.");
  }

  const parsed = parser.parse(xmlEntry.getData().toString("utf-8"));
  const list: CorpCodeListItem[] = parsed?.result?.list ?? [];

  await logDartCall("success");

  return list.map((item) => ({
    corpCode: String(item.corp_code).trim(),
    corpName: String(item.corp_name).trim(),
    stockCode: item.stock_code && String(item.stock_code).trim() !== "" ? String(item.stock_code).trim() : null,
    modifyDate: String(item.modify_date).trim(),
  }));
}

export interface DartCompanyOverview {
  corpCode: string;
  // 표준산업분류코드. 종목마다 자릿수가 다르지만(3~5자리) 앞 2자리는 일관되게 KSIC
  // 대분류를 나타낸다(2026-09-04 실측 확인, lib/industryPerConfig.ts 참고). 필드가
  // 없거나 빈 값이면 null.
  indutyCode: string | null;
}

interface CompanyOverviewResponse {
  status: string;
  message: string;
  corp_code?: string;
  induty_code?: string;
}

/** company.json(기업개황)을 호출해 업종코드(induty_code)를 가져온다. 방법A(업종 평균
 * PER)의 업종 그룹핑에 쓴다(scripts/backfill-stock-industry-classification.ts). */
export async function fetchCompanyOverview(corpCode: string): Promise<DartCompanyOverview> {
  const url = `${DART_BASE_URL}/company.json?crtfc_key=${encodeURIComponent(getDartApiKey())}&corp_code=${corpCode}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`DART company.json 요청 실패(${corpCode}): HTTP ${res.status}`);
  }

  const body: CompanyOverviewResponse = await res.json();
  if (body.status !== "000") {
    throw new Error(`DART company.json 오류(${corpCode}, ${body.status}): ${body.message}`);
  }

  return {
    corpCode: body.corp_code ?? corpCode,
    indutyCode: body.induty_code && body.induty_code.trim() !== "" ? body.induty_code.trim() : null,
  };
}

import "server-only";

const ECOS_BASE_URL = "https://ecos.bok.or.kr/api/StatisticSearch";

export interface EcosObservation {
  date: string; // YYYY-MM-DD
  value: number;
}

interface EcosRow {
  TIME: string; // YYYYMMDD(주기 D 기준)
  DATA_VALUE: string;
}

interface EcosResponse {
  StatisticSearch?: { row?: EcosRow[] };
  // 데이터가 없거나 파라미터가 잘못됐을 때 ECOS는 RESULT로 감싼 오류를 내려준다
  // (예: INFO-200 "해당하는 데이터가 없습니다").
  RESULT?: { CODE: string; MESSAGE: string };
}

function toIsoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** 한국은행 ECOS(ecos.bok.or.kr) StatisticSearch에서 통계표코드/통계항목코드 하나의
 * 일별(주기 D) 시계열을 가져온다. startDate/endDate는 ECOS 형식(YYYYMMDD)이다. */
export async function getEcosSeries(
  statCode: string,
  itemCode: string,
  startDate: string,
  endDate: string
): Promise<EcosObservation[]> {
  const apiKey = process.env.ECOS_API_KEY;
  if (!apiKey) {
    throw new Error("ECOS_API_KEY 환경 변수가 설정되지 않았습니다.");
  }

  // 인증키/응답형식/언어/조회건수(1~10000)/통계표코드/주기/시작일/종료일/통계항목코드1 순서.
  const url = `${ECOS_BASE_URL}/${apiKey}/json/kr/1/10000/${statCode}/D/${startDate}/${endDate}/${itemCode}`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`ECOS 요청 실패 (${res.status}): ${await res.text()}`);
  }

  const data: EcosResponse = await res.json();

  // "해당하는 데이터가 없습니다"(INFO-200)는 오류가 아니라 빈 결과로 취급한다 —
  // 조회 구간에 데이터가 없을 수 있는 정상 상황이다. 그 외 오류 코드만 던진다.
  if (data.RESULT && data.RESULT.CODE !== "INFO-000" && data.RESULT.CODE !== "INFO-200") {
    throw new Error(`ECOS 오류(${data.RESULT.CODE}): ${data.RESULT.MESSAGE}`);
  }

  const rows = data.StatisticSearch?.row ?? [];
  return rows
    .map((r) => ({ date: toIsoDate(r.TIME), value: Number(r.DATA_VALUE) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

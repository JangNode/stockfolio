import "server-only";

const FRED_BASE_URL = "https://api.stlouisfed.org/fred/series/observations";

export interface FredObservation {
  date: string; // YYYY-MM-DD
  value: number | null; // FRED는 값이 없는 날을 "."로 내려준다 — null로 정규화한다.
}

/** FRED(fred.stlouisfed.org) v1 series/observations 엔드포인트에서 시리즈 하나의
 * 관측치를 가져온다. v2(릴리스 단위 벌크 조회)는 이 저장소가 다루는 소수 시리즈만
 * 필요한 상황엔 과해서 쓰지 않는다. */
export async function getFredSeries(seriesId: string, observationStart?: string): Promise<FredObservation[]> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    throw new Error("FRED_API_KEY 환경 변수가 설정되지 않았습니다.");
  }

  const url = new URL(FRED_BASE_URL);
  url.searchParams.set("series_id", seriesId);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("file_type", "json");
  url.searchParams.set("sort_order", "asc");
  if (observationStart) url.searchParams.set("observation_start", observationStart);

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`FRED 요청 실패 (${res.status}): ${await res.text()}`);
  }

  const data: { observations?: { date: string; value: string }[] } = await res.json();
  return (data.observations ?? []).map((o) => ({
    date: o.date,
    value: o.value === "." ? null : Number(o.value),
  }));
}

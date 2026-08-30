import "server-only";
import { getFredSeries } from "@/lib/fredClient";
import { getEcosSeries } from "@/lib/ecosClient";
import { computeChangePoints, hasLatestChanged, type RatePoint } from "@/lib/rateChangeDetection";
import {
  getLatestUsFedRate,
  upsertUsFedRates,
  getLatestKrBaseRate,
  upsertKrBaseRates,
} from "@/lib/rateStorage";
import {
  FRED_US_UPPER_SERIES_ID,
  FRED_US_LOWER_SERIES_ID,
  FRED_US_SERIES_START_DATE,
  ECOS_KR_BASE_RATE_STAT_CODE,
  ECOS_KR_BASE_RATE_ITEM_CODE,
  ECOS_KR_BASE_RATE_START_DATE,
} from "@/lib/rateConfig";

export interface RateSyncResult {
  changed: boolean; // 이번 동기화로 "가장 최근 변경점"이 바뀌었는지
  latest: RatePoint | null;
}

function todayEcosDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }).replace(/-/g, "");
}

/**
 * 미국 기준금리(FOMC)를 FRED에서 전체 이력 재동기화한다. 매번 전체 시리즈를 다시
 * 가져와 변경점만 재계산해 upsert하므로(데이터 자체가 작아 비용이 무시할 만함),
 * 중간에 값을 놓쳐도 다음 실행에서 자동으로 따라잡는다(별도 "증분 수집" 로직이
 * 필요 없다).
 */
export async function syncUsFedRate(): Promise<RateSyncResult> {
  const [upperObs, lowerObs] = await Promise.all([
    getFredSeries(FRED_US_UPPER_SERIES_ID, FRED_US_SERIES_START_DATE),
    getFredSeries(FRED_US_LOWER_SERIES_ID, FRED_US_SERIES_START_DATE),
  ]);

  const lowerByDate = new Map(lowerObs.map((o) => [o.date, o.value]));
  const merged: RatePoint[] = upperObs
    .filter((o) => o.value !== null && lowerByDate.get(o.date) != null)
    .map((o) => ({ effectiveDate: o.date, values: [o.value as number, lowerByDate.get(o.date) as number] }));

  const changePoints = computeChangePoints(merged);
  const before = await getLatestUsFedRate();
  await upsertUsFedRates(changePoints);
  const after = changePoints[changePoints.length - 1] ?? null;

  return { changed: hasLatestChanged(before, after), latest: after };
}

/** 한국 기준금리(금통위)를 ECOS에서 전체 이력 재동기화한다. syncUsFedRate와 같은 이유로
 * 매번 전체 재계산+upsert한다. */
export async function syncKrBaseRate(): Promise<RateSyncResult> {
  const obs = await getEcosSeries(
    ECOS_KR_BASE_RATE_STAT_CODE,
    ECOS_KR_BASE_RATE_ITEM_CODE,
    ECOS_KR_BASE_RATE_START_DATE,
    todayEcosDate()
  );

  const series: RatePoint[] = obs.map((o) => ({ effectiveDate: o.date, values: [o.value] }));
  const changePoints = computeChangePoints(series);
  const before = await getLatestKrBaseRate();
  await upsertKrBaseRates(changePoints);
  const after = changePoints[changePoints.length - 1] ?? null;

  return { changed: hasLatestChanged(before, after), latest: after };
}

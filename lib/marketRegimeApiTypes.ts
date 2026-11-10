import type { Regime } from "@/lib/marketRegime";

/** GET /api/market-regime 응답 형식(서버 라우트와 화면 카드가 공유). */
export interface MarketRegimeLatest {
  tradeDate: string;
  regime: Regime;
  rawRegime: Regime;
  kospiClose: number;
  ma50: number | null; ma200: number | null;
  b50: number | null; b200: number | null; nh: number | null;
  drawdown: number | null; vol20: number | null; volPctile: number | null;
  memberCount: number;
  source: "backfill" | "daily";
}
export interface MarketRegimeTimelineDay { date: string; regime: Regime }
/**
 * 화면 차트용 전체 이력(열 배열, 오래된 것 먼저). 세 배열의 길이가 같다.
 * regimes는 날짜마다 1글자 코드(B 강세·N 중립·R 약세·C 위기·U 미정, lib/marketRegimeChart.ts REGIME_SERIES_CODES).
 * 읽기 전용으로 추가된 필드이며 기존 필드(timeline 등)는 그대로다.
 */
export interface MarketRegimeSeries { dates: string[]; closes: number[]; regimes: string }
export interface MarketRegimeStatRow {
  regime: Regime; days: number; share: number; samples: number; avgForwardPct: number | null; winRatePct: number | null;
}
export interface MarketRegimeResponse {
  latest: MarketRegimeLatest | null;
  /** 최근 REGIME_TIMELINE_DAYS 거래일(오래된 것 먼저). */
  timeline: MarketRegimeTimelineDay[];
  /** 차트 기간 선택(1년/3년/전체)용 전체 이력. 응답 크기: 약 4천 거래일 기준 gzip 수십 KB 이내. */
  series: MarketRegimeSeries;
  /** 최근 구간 국면 전환 횟수(타임라인 구간 안). */
  timelineTransitions: number;
  stats: {
    from: string | null; to: string | null; definedDays: number; forwardDays: number;
    benchmark: "KOSPI 지수"; // 069500 일별 자료가 운영 DB에 없어 지수로 대체
    byRegime: MarketRegimeStatRow[];
    all: { samples: number; avgForwardPct: number | null; winRatePct: number | null };
    transitions: number; transitionsPerYear: number | null; medianRunDays: number | null;
  };
  /** 이력 구간 구분: 이 날짜까지는 월말 시장 구분(백필), 이후 일일 배치는 현재 코스피 구성 기준. */
  backfillThrough: string | null;
  dailyFrom: string | null;
  thresholds: {
    crisisDrawdownPct: number; crisisB50Below: number; bearB50Below: number; bullB50AtLeast: number; bullNhAbove: number; confirmDays: number;
  };
  status: { lastSuccessAt: string | null; lastError: string | null };
}

import type { Regime } from "@/lib/marketRegime";
import type { MarketRegimeLatest, MarketRegimeResponse, MarketRegimeTimelineDay } from "@/lib/marketRegimeApiTypes";
import { REGIME_STALE_WARN_TRADING_DAYS } from "@/lib/marketRegimeConfig";

/*
 * 시장 국면 카드의 화면용 계산(서버·DB 없이 API 응답 + 현재 시각만 쓴다).
 * 한계: 클라이언트는 KRX 휴장일 표(krx_trading_calendar, 서버 전용)를 읽지 못해 "거래일"을 평일로 센다.
 * 공휴일이 낀 연휴 직후에는 지연 일수가 실제보다 크게 나와 경고가 하루 이틀 잘못 뜰 수 있다(반대로 빠뜨리는 경우는 없다).
 */

const DAY_MS = 86_400_000;
const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"] as const;

const utcMs = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
const isWeekday = (ms: number): boolean => { const w = new Date(ms).getUTCDay(); return w !== 0 && w !== 6; };

/** 지금의 한국 날짜(YYYY-MM-DD). */
export function kstToday(now: Date): string {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD 뒤에 요일을 붙인다(예: 2026-10-15 (목)). */
export function withWeekday(iso: string): string {
  return `${iso} (${WEEKDAY_KO[new Date(utcMs(iso)).getUTCDay()]})`;
}

/** 오늘(한국 날짜)보다 앞선 가장 가까운 평일 = 일일 계산이 대상으로 삼는 "가장 최근 완료 거래일"(휴장일 미반영). */
export function latestCompletedWeekday(todayKst: string): string {
  let ms = utcMs(todayKst) - DAY_MS;
  while (!isWeekday(ms)) ms -= DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/** (after, through] 구간의 평일 수. through가 after 이하이면 0. */
export function weekdaysBetween(after: string, through: string): number {
  let n = 0;
  for (let ms = utcMs(after) + DAY_MS; ms <= utcMs(through); ms += DAY_MS) if (isWeekday(ms)) n++;
  return n;
}

export interface Staleness {
  /** 가장 최근 완료 거래일(평일 기준). */
  latestCompleted: string;
  /** 마지막 계산일이 그보다 몇 거래일 뒤처졌는지. */
  behind: number;
  stale: boolean;
}

export function staleness(lastTradeDate: string, now: Date, warnAt: number = REGIME_STALE_WARN_TRADING_DAYS): Staleness {
  const latestCompleted = latestCompletedWeekday(kstToday(now));
  const behind = weekdaysBetween(lastTradeDate, latestCompleted);
  return { latestCompleted, behind, stale: behind >= warnAt };
}

export interface Streak {
  days: number;
  /** 타임라인(최근 N거래일) 전체가 같은 국면이라 실제로는 더 오래됐을 수 있음. */
  atLeast: boolean;
}

/** 타임라인 끝에서부터 현재 국면이 연속된 거래일 수(타임라인이 비었거나 끝 국면이 다르면 0). */
export function currentStreak(timeline: MarketRegimeTimelineDay[], regime: Regime): Streak {
  let days = 0;
  for (let i = timeline.length - 1; i >= 0 && timeline[i].regime === regime; i--) days++;
  return { days, atLeast: days > 0 && days === timeline.length };
}

const num = (v: number): string => Number(v.toFixed(1)).toString();

/**
 * 그날 신호(rawRegime)가 왜 그렇게 나왔는지 한 줄로 설명한다. 판정 순서(위기 → 약세 → 강세 → 중립)와 같은 순서로 조건을 확인하고,
 * 중립이면 약세·강세 중 어느 조건이 모자랐는지를 말한다. 판정 규칙 자체는 lib/marketRegime.ts classifyRaw 그대로이고 여기서는 문장만 만든다.
 */
export function regimeReason(l: MarketRegimeLatest, t: MarketRegimeResponse["thresholds"]): string {
  const b50 = l.b50, ma200 = l.ma200;
  if (b50 === null || ma200 === null) return "200일선 또는 50일선 위 종목 비율을 계산할 이력이 아직 부족합니다.";
  const maPhrase = l.kospiClose === ma200 ? "KOSPI가 200일선과 같고" : `KOSPI가 200일선 ${l.kospiClose < ma200 ? "아래" : "위"}이고`;
  const breadth = `50일선 위 종목이 ${num(b50)}%`;
  switch (l.rawRegime) {
    case "crisis":
      return `252일 고점 대비 ${num(l.drawdown ?? 0)}%(기준 ${t.crisisDrawdownPct}% 이하)이고 ${breadth}(기준 ${t.crisisB50Below}% 미만)`;
    case "bear":
      return `${maPhrase} ${breadth}(기준 ${t.bearB50Below}% 미만)`;
    case "bull":
      return `${maPhrase} ${breadth}(기준 ${t.bullB50AtLeast}% 이상), 55일 신고가−신저가 ${l.nh !== null && l.nh > 0 ? "+" : ""}${l.nh}`;
    case "neutral": {
      if (l.kospiClose < ma200) return `${maPhrase} ${breadth}라 약세 기준(${t.bearB50Below}% 미만)에는 못 미침`;
      if (b50 < t.bullB50AtLeast) return `${maPhrase} ${breadth}라 강세 기준(${t.bullB50AtLeast}% 이상)에는 못 미침`;
      if (l.kospiClose > ma200) return `${maPhrase} ${breadth}이지만 55일 신고가−신저가가 ${l.nh}(기준 ${t.bullNhAbove} 초과)라 강세 기준에는 못 미침`;
      return `${maPhrase} ${breadth}라 약세·강세 기준 어디에도 해당하지 않음`;
    }
    default:
      return "200일선 또는 50일선 위 종목 비율을 계산할 이력이 아직 부족합니다.";
  }
}

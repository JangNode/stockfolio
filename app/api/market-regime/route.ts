import { NextResponse } from "next/server";
import { requireApproved } from "@/lib/requireApproved";
import { getAllRegimeRows, getRegimeStatus } from "@/lib/marketRegimeStorage";
import { countTransitions, regimeRuns, summarizeByRegime } from "@/lib/marketRegime";
import {
  REGIME_BEAR_B50_BELOW, REGIME_BULL_B50_AT_LEAST, REGIME_BULL_NH_ABOVE, REGIME_CONFIRM_DAYS, REGIME_CRISIS_B50_BELOW, REGIME_CRISIS_DRAWDOWN_PCT,
  REGIME_FORWARD_DAYS, REGIME_TIMELINE_DAYS,
} from "@/lib/marketRegimeConfig";
import type { MarketRegimeResponse } from "@/lib/marketRegimeApiTypes";

const MS_PER_YEAR = 365.25 * 86_400_000;
const median = (a: number[]): number | null => {
  if (!a.length) return null;
  const b = [...a].sort((x, y) => x - y);
  return b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2;
};

/**
 * 시장 국면(레짐) 카드용: 최신 국면과 지표, 최근 1년 타임라인, 국면별 과거 일수·이후 20거래일 KOSPI 지수 수익률 통계.
 * 데이터는 scripts/market-regime.ts(일일)와 scripts/backfill-market-regime.ts(이력)가 market_regime_daily에 저장한 것을 읽기만 한다.
 */
export async function GET(request: Request) {
  const denied = await requireApproved(request);
  if (denied) return denied;

  try {
    const [rows, status] = await Promise.all([getAllRegimeRows(), getRegimeStatus()]);
    const latest = rows.length ? rows[rows.length - 1] : null;
    const days = rows.map((r) => ({ date: r.tradeDate, regime: r.regime, kospiClose: r.kospiClose }));
    const defined = days.filter((d) => d.regime !== "undefined");
    const timeline = days.slice(-REGIME_TIMELINE_DAYS).map((d) => ({ date: d.date, regime: d.regime }));

    const baseRets: number[] = [];
    days.forEach((d, i) => { if (i + REGIME_FORWARD_DAYS < days.length) baseRets.push(days[i + REGIME_FORWARD_DAYS].kospiClose / d.kospiClose - 1); });
    const transitions = countTransitions(days.map((d) => d.regime));
    const years = defined.length > 1 ? (Date.parse(defined[defined.length - 1].date) - Date.parse(defined[0].date)) / MS_PER_YEAR : 0;
    const dailyFirst = rows.find((r) => r.source === "daily");
    const lastBackfill = [...rows].reverse().find((r) => r.source === "backfill");

    const body: MarketRegimeResponse = {
      latest,
      timeline,
      timelineTransitions: countTransitions(timeline.map((d) => d.regime)),
      stats: {
        from: defined[0]?.date ?? null,
        to: defined[defined.length - 1]?.date ?? null,
        definedDays: defined.length,
        forwardDays: REGIME_FORWARD_DAYS,
        benchmark: "KOSPI 지수",
        byRegime: summarizeByRegime(days, REGIME_FORWARD_DAYS),
        all: {
          samples: baseRets.length,
          avgForwardPct: baseRets.length ? (baseRets.reduce((a, b) => a + b, 0) / baseRets.length) * 100 : null,
          winRatePct: baseRets.length ? (baseRets.filter((x) => x > 0).length / baseRets.length) * 100 : null,
        },
        transitions,
        transitionsPerYear: years > 0 ? transitions / years : null,
        medianRunDays: median(regimeRuns(defined).map((r) => r.days)),
      },
      backfillThrough: lastBackfill?.tradeDate ?? null,
      dailyFrom: dailyFirst?.tradeDate ?? null,
      thresholds: {
        crisisDrawdownPct: REGIME_CRISIS_DRAWDOWN_PCT, crisisB50Below: REGIME_CRISIS_B50_BELOW, bearB50Below: REGIME_BEAR_B50_BELOW,
        bullB50AtLeast: REGIME_BULL_B50_AT_LEAST, bullNhAbove: REGIME_BULL_NH_ABOVE, confirmDays: REGIME_CONFIRM_DAYS,
      },
      status: { lastSuccessAt: status.lastSuccessAt, lastError: status.lastError },
    };
    return NextResponse.json(body);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "알 수 없는 오류" }, { status: 502 });
  }
}

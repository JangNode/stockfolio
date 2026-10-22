/**
 * KODEX 200 + 업종 모멘텀 위성 전략(연구 v3.2, 사전등록 d70b1fd) 월간 신호 배치.
 * pg_cron이 평일 16:30 KST에 .github/workflows/kodex-sector-signal.yml을 부르고, 이 스크립트는
 * krx_trading_calendar로 "오늘이 그 달 마지막 거래일"일 때만 계산한다(아니면 바로 끝).
 *
 * 마지막 거래일이면:
 * 1. KRX sto/stk_bydd_trd(오늘) 1회로 KOSPI 목록·오늘 종가·시총·거래대금을 받고, etp/etf_bydd_trd(오늘)로
 *    069500 종가를 받는다. 빈 응답·이상 응답이면 그 달 신호는 저장하지 않고 오류만 기록한다.
 * 2. 그 전 시세(stock_daily_prices_recent ∪ Parquet)로 신호를 계산해 kodex_sector_signals에 저장한다.
 * 3. 직전 신호의 체결일(다음 거래일) 종가로 시드별 모의 계좌를 리밸런싱해 kodex_sector_track에 저장한다
 *    (오늘 종가로 평가). 첫 운영 신호 이전 백필은 하지 않는다.
 * KIS는 호출하지 않는다.
 *
 *   tsx --conditions=react-server scripts/kodex-sector-signal.ts
 * 필요 환경변수: KRX_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * 선택: KSS_SIGNAL_DATE(YYYY-MM-DD) — 그날 실행이 실패했을 때 그 월말로 다시 계산(수동 복구용).
 */
import { isKrxTradingDay } from "@/lib/krxTradingCalendar";
import { applyKssShareAdjustments, computeKssSignal, monthEndMonthsBefore, rebalanceKssAccount, type KssAccount } from "@/lib/kodexSectorSatellite";
import {
  fetchKrxEtfClose,
  fetchKrxKospiDay,
  getLatestHotDate,
  getNextTradingDay,
  getPrevTradingDay,
  getRawClosesOnOrBefore,
  listKssSignals,
  listKssTrack,
  loadKssSignalInput,
  recordKssAttempt,
  toSignalRow,
  upsertKssSignal,
  upsertKssTrack,
  type KrxStockDayRow,
  type KssTrackRow,
} from "@/lib/kodexSectorStorage";
import { loadAppliedAdjustmentsForCodes } from "@/lib/stockPriceAdjustmentsStorage";
import { KSS_ETF_CODE, KSS_KRX_KOSPI_MIN_ROWS, KSS_MOMENTUM_LOOKBACK_MONTHS, KSS_SATELLITE_WEIGHT, KSS_SEEDS_WON } from "@/lib/kodexSectorSatelliteConfig";

const pct = (x: number): string => (x * 100).toFixed(2);

function todayKst(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/** 체결일이 오늘 이전인데 추적 행이 없는 신호를 순서대로 리밸런싱한다. 평가일 = 다음 신호일(오늘이면 오늘 KRX 종가). */
async function runTrack(today: string, kospiToday: KrxStockDayRow[], etfToday: number, apiKey: string): Promise<Omit<KssTrackRow, "computed_at">[]> {
  const signals = (await listKssSignals()).reverse();
  const track = await listKssTrack();
  const done = new Set(track.map((r) => r.trade_date));
  const pending = signals.filter((s) => s.trade_date < today && !done.has(s.trade_date));
  if (pending.length === 0) return [];

  const todayClose = new Map(kospiToday.map((r) => [r.code, r.close]));
  const allCodes = new Set<string>();
  for (const s of pending) for (const h of s.holdings) allCodes.add(h.code);
  for (const r of track) for (const h of r.holdings) allCodes.add(h.code);
  const adjustments = await loadAppliedAdjustmentsForCodes([...allCodes]);

  const rows: Omit<KssTrackRow, "computed_at">[] = [];
  const latestBySeed = new Map<number, Omit<KssTrackRow, "computed_at">>();
  for (const r of track) latestBySeed.set(r.seed_won, r);

  for (const s of pending) {
    const T = s.trade_date;
    const markDate = signals.find((x) => x.signal_date > s.signal_date)?.signal_date ?? today;
    const etfT = await fetchKrxEtfClose(T, apiKey);
    if (etfT === null) throw new Error(`069500 ${T} 종가가 KRX 응답에 없습니다.`);
    const etfMark = markDate === today ? etfToday : await fetchKrxEtfClose(markDate, apiKey);
    if (etfMark === null) throw new Error(`069500 ${markDate} 종가가 KRX 응답에 없습니다.`);

    const codes = new Set(s.holdings.map((h) => h.code));
    for (const prev of latestBySeed.values()) for (const h of prev.holdings) codes.add(h.code);
    const pxT = await getRawClosesOnOrBefore([...codes], T);
    const pxMark = await getRawClosesOnOrBefore([...codes], markDate);
    if (markDate === today) for (const c of codes) { const p = todayClose.get(c); if (p !== undefined) pxMark.set(c, p); }

    for (const seed of KSS_SEEDS_WON) {
      const prev = latestBySeed.get(seed);
      const account: KssAccount = prev
        ? { cash: prev.cash, etfShares: prev.etf_shares, holdings: applyKssShareAdjustments(new Map(prev.holdings.map((h) => [h.code, h.shares])), adjustments, prev.trade_date, T) }
        : { cash: seed, etfShares: 0, holdings: new Map() };
      const res = rebalanceKssAccount(account, s.fallback_to_etf ? [] : s.holdings.map((h) => ({ code: h.code, weight: h.weight })), { etf: etfT, stocks: pxT }, T);
      const markHold = applyKssShareAdjustments(res.account.holdings, adjustments, T, markDate);
      let markValue = res.account.cash + res.account.etfShares * etfMark;
      for (const [c, n] of markHold) {
        const p = pxMark.get(c);
        if (p === undefined) throw new Error(`${c}의 ${markDate} 평가 종가가 없습니다.`);
        markValue += n * p;
      }
      const row: Omit<KssTrackRow, "computed_at"> = {
        seed_won: seed,
        trade_date: T,
        signal_date: s.signal_date,
        value_before: res.valueBefore,
        value_after: res.valueAfter,
        cash: res.account.cash,
        etf_shares: res.account.etfShares,
        holdings: [...res.account.holdings].map(([code, shares]) => ({ code, shares, close: pxT.get(code)! })),
        cap_hit: res.capHit,
        zero_satellite: res.zeroSatellite,
        mark_date: markDate,
        mark_value: markValue,
      };
      rows.push(row);
      latestBySeed.set(seed, row);
    }
  }
  return rows;
}

async function main(): Promise<void> {
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");
  const signalDate = process.env.KSS_SIGNAL_DATE?.trim() || todayKst();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(signalDate)) throw new Error(`KSS_SIGNAL_DATE 형식 오류: ${signalDate}`);

  if (!(await isKrxTradingDay(signalDate))) {
    console.log(`${signalDate}: 휴장일 — 종료`);
    return;
  }
  const tradeDate = await getNextTradingDay(signalDate);
  if (tradeDate === null) {
    const msg = `${signalDate} 다음 거래일을 krx_trading_calendar에서 찾지 못했습니다 — 캘린더 동기화 확인 필요`;
    await recordKssAttempt(msg, null);
    throw new Error(msg);
  }
  if (tradeDate.slice(0, 7) === signalDate.slice(0, 7)) {
    console.log(`${signalDate}: 그 달 마지막 거래일 아님(다음 거래일 ${tradeDate}) — 종료`);
    return;
  }

  console.log(`${signalDate}: 그 달 마지막 거래일 — 신호 계산(체결 ${tradeDate})`);
  try {
    const prevDay = await getPrevTradingDay(signalDate);
    const latestHot = await getLatestHotDate();
    if (prevDay && (!latestHot || latestHot < prevDay)) throw new Error(`stock_daily_prices_recent가 ${prevDay}까지 갱신되지 않았습니다(최신 ${latestHot ?? "없음"}).`);

    const kospiDay = await fetchKrxKospiDay(signalDate, apiKey);
    if (kospiDay.length < KSS_KRX_KOSPI_MIN_ROWS) throw new Error(`KRX stk_bydd_trd(${signalDate}) 행 ${kospiDay.length}개 < ${KSS_KRX_KOSPI_MIN_ROWS} — 정산 전 또는 응답 이상`);
    const etfClose = await fetchKrxEtfClose(signalDate, apiKey);
    if (etfClose === null) throw new Error(`KRX etf_bydd_trd(${signalDate})에 ${KSS_ETF_CODE} 종가가 없습니다.`);
    console.log(`KRX: KOSPI ${kospiDay.length}종목, ${KSS_ETF_CODE} 종가 ${etfClose.toLocaleString("ko-KR")}`);

    const input = await loadKssSignalInput(signalDate, monthEndMonthsBefore(signalDate, KSS_MOMENTUM_LOOKBACK_MONTHS), kospiDay);
    const sig = computeKssSignal({ signalDate, series: input.series, kospiCodes: new Set(kospiDay.map((r) => r.code)), names: input.names, induty: input.induty });
    const displayNames = new Map(kospiDay.map((r) => [r.code, input.names.get(r.code) ?? r.name]));
    const prices: Record<string, number> = { [KSS_ETF_CODE]: etfClose };
    const closeOf = new Map(kospiDay.map((r) => [r.code, r.close]));
    for (const h of sig.preTrimHoldings) prices[h.code] = closeOf.get(h.code)!;
    await upsertKssSignal(toSignalRow(sig, tradeDate, displayNames, prices));

    console.log(`K200P ${sig.k200pCount}종목, 모멘텀 ${sig.momentumFrom}~${sig.momentumTo}${sig.neutral ? " (유효 업종 없음 → K200P 중립)" : ""}`);
    console.log("| 순위 | 업종 | 유효 종목 수 | 모멘텀 % |\n|---|---|---|---|");
    sig.sectorRanks.slice(0, 10).forEach((r, i) => console.log(`| ${i + 1} | ${r.sector} | ${r.validCount} | ${pct(r.momentum)} |`));
    console.log(`위성(정리 전 ${sig.preTrimHoldings.length}종목 → 정리 후 ${sig.holdings.length}종목${sig.fallbackToEtf ? ", 069500 대체" : ""})\n| 코드 | 이름 | 업종 | 위성 비중 % | 계좌 비중 % |\n|---|---|---|---|---|`);
    for (const h of sig.holdings) console.log(`| ${h.code} | ${displayNames.get(h.code)} | ${h.sector} | ${pct(h.weight)} | ${pct(h.weight * KSS_SATELLITE_WEIGHT)} |`);

    const trackRows = await runTrack(signalDate, kospiDay, etfClose, apiKey);
    await upsertKssTrack(trackRows);
    console.log(`모의 추적: ${trackRows.length}행`);
    for (const r of trackRows) console.log(`  시드 ${r.seed_won.toLocaleString("ko-KR")} 체결 ${r.trade_date} 평가 전 ${Math.round(r.value_before).toLocaleString("ko-KR")} → ${r.mark_date} ${Math.round(r.mark_value).toLocaleString("ko-KR")}`);

    await recordKssAttempt(null, sig.holdings.length);
  } catch (error) {
    await recordKssAttempt(error instanceof Error ? error.message : String(error), null);
    throw error;
  }
}

main().catch((error) => {
  console.error("KODEX 업종 모멘텀 신호 배치 오류:", error);
  process.exit(1);
});

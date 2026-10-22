/**
 * [임시 검증 — 정리 PR에서 삭제, 읽기 전용, 외부 요청 0건, DB 쓰기 0]
 * lib/kodexSectorSatellite.ts(운영 계산 모듈)에 연구 v3.2(사전등록 d70b1fd, 실행 0158359)와 같은 입력
 * (Parquet 전종목 + 적용된 조정 이벤트 + 월말 시장 구분 목록 + dart 이름 + 업종)을 넣어, 연구 로그 값과 대조한다.
 *  1. 2026-09-30 신호: 상위 3개 업종·유효 종목 수·모멘텀, 정리 전 8종목 비중, 정리 후 위성 비중
 *  2. 196개 신호의 정리 후 종목 수 분포·평균, 정리 전 평균, 069500 대체 횟수
 *  3. 2024-01~2026-09 33개 월말의 v3.1 최소 운용 금액·결정 종목(정리 전 위성 기준)
 *  4. B 시뮬레이션(rebalanceKssAccount를 월마다 이어 붙임): 시드 5개의 2026-10-01 리밸런싱 직후 보유
 *   tsx --conditions=react-server scripts/verify-kodex-sector-satellite.ts
 */
import { parquetReadObjects } from "hyparquet";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { applyAdjustmentsInPlace } from "@/lib/priceAdjustment";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { computeEffectiveSellPrice } from "@/lib/transactionCost";
import { PIT_LIQUIDITY_LOOKBACK_DAYS } from "@/lib/strategyBacktestSummaryConfig";
import { applyKssShareAdjustments, computeKssSignal, rebalanceKssAccount, type KssAccount, type KssSignal, type KssStockSeries } from "@/lib/kodexSectorSatellite";
import { KSS_ETF_CODE, KSS_SATELLITE_WEIGHT } from "@/lib/kodexSectorSatelliteConfig";

// 연구 브랜치 설정값(lib/marketMembershipConfig.ts, lib/investorFlowConfig.ts, lib/sectorMomTiltConfig.ts, lib/foreignFlowTiltConfig.ts) 그대로.
const MM_BUCKET = "stock-daily-prices";
const MM_PARQUET_PATH = "research/market_membership/month_end.parquet";
const FIRST_SIGNAL_MONTH = "2010-06";
const ENDED_GRACE_DAYS = 14;

// ---- 연구 로그 기대값 ----
const EXP_0930 = {
  ranks: [{ sector: "26", n: 16, mom: 75.3 }, { sector: "62", n: 2, mom: 53.05 }, { sector: "65", n: 8, mom: 38.58 }],
  pre: [["005930", 50.63], ["000660", 41.84], ["009150", 3.64], ["032830", 1.82], ["000810", 0.91], ["018260", 0.55], ["005830", 0.39], ["064400", 0.21]] as [string, number][],
  post: [["005930", 54.75], ["000660", 45.25]] as [string, number][],
};
const EXP_DIST = { full: { n: 196, b: [0, 2, 14, 35, 145] }, since2024: { n: 33, b: [0, 0, 7, 6, 20] }, avgPre: 8.99, avgPost: 4.81, fallback: 0 };
const EXP_MIN_ACCT: [string, number, string][] = [
  ["2024-01-31", 7619675, "079550"], ["2024-02-29", 35098137, "008730"], ["2024-03-29", 24788244, "014820"], ["2024-04-30", 10335635, "079550"],
  ["2024-05-31", 30602278, "079550"], ["2024-06-28", 12117744, "000810"], ["2024-07-31", 33015771, "003230"], ["2024-08-30", 37327484, "003230"],
  ["2024-09-30", 51515263, "003230"], ["2024-10-31", 9987357, "036570"], ["2024-11-29", 38584183, "079550"], ["2024-12-30", 9749145, "012450"],
  ["2025-01-31", 13820506, "012450"], ["2025-02-28", 17339950, "012450"], ["2025-03-31", 16226160, "012450"], ["2025-04-30", 79518149, "003230"],
  ["2025-05-30", 84385282, "003230"], ["2025-06-30", 29591980, "079550"], ["2025-07-31", 12363894, "079550"], ["2025-08-29", 15260579, "079550"],
  ["2025-09-30", 21772105, "079550"], ["2025-10-31", 220982005, "039490"], ["2025-11-28", 168261305, "267260"], ["2025-12-30", 186907165, "267260"],
  ["2026-01-30", 123503447, "009150"], ["2026-02-27", 443074271, "039490"], ["2026-03-31", 232910180, "375500"], ["2026-04-30", 450411002, "039490"],
  ["2026-05-29", 846878472, "079550"], ["2026-06-30", 546341489, "375500"], ["2026-07-31", 1580494048, "004170"], ["2026-08-31", 675423393, "079550"],
  ["2026-09-30", 347218163, "000810"],
];
// 시드별 2026-10-01 리밸런싱 직후: 069500 주수, {종목: 주수}, 현금, 평가액
const EXP_B: [number, number, Record<string, number>, number, number][] = [
  [1_000_000, 45, { "005930": 2 }, 626, 5_571_026],
  [3_000_000, 119, { "005930": 7, "000660": 1 }, 93_096, 17_128_976],
  [5_000_000, 222, { "005930": 13, "000660": 2 }, 41_686, 32_053_126],
  [7_000_000, 302, { "005930": 17, "000660": 2 }, 70_968, 42_108_008],
  [10_000_000, 436, { "005930": 24, "000660": 3 }, 101_154, 60_846_874],
];

const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const ox = (b: boolean): string => (b ? "일치" : "불일치");
const fmt = (x: number): string => Math.round(x).toLocaleString("ko-KR");
let allOk = true;
const check = (b: boolean): string => { if (!b) allOk = false; return ox(b); };

async function selectAll<T>(build: (f: number, t: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data?.length ?? 0) < 1000) break;
  }
  return out;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log(`KODEX 업종 모멘텀 운영 모듈 검증 시작(읽기 전용): ${new Date().toISOString()}`);
  const adjustments = await loadAppliedAdjustments();
  const raw = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear());
  const series = new Map<string, KssStockSeries>();
  const rawClose = new Map<string, { dates: string[]; idx: Map<string, number>; raw: number[]; last: string }>();
  const calSet = new Set<string>();
  for (const [code, rows] of raw) {
    raw.delete(code);
    if (!rows.length) continue;
    const adj = rows.map((r) => ({ ...r }));
    const al = adjustments.get(code);
    if (al) applyAdjustmentsInPlace(adj, al);
    for (const r of rows) if (r.tradeDate >= "2010-01-01") calSet.add(r.tradeDate);
    const dates = rows.map((r) => r.tradeDate);
    series.set(code, { dates, close: Float64Array.from(adj.map((r) => r.closePrice)), mcapEok: Float64Array.from(rows.map((r) => r.marketCapEok)), avgTv: computeTrailingAvgTradingValue(adj, PIT_LIQUIDITY_LOOKBACK_DAYS) });
    rawClose.set(code, { dates, idx: new Map(dates.map((d, i) => [d, i])), raw: rows.map((r) => r.closePrice), last: dates[dates.length - 1] });
  }
  const CAL = [...calSet].sort();
  const dataEnd = CAL[CAL.length - 1];
  const monthEnds = CAL.filter((d, k) => k + 1 < CAL.length && d.slice(0, 7) !== CAL[k + 1].slice(0, 7));
  const sigs = monthEnds.filter((d) => d.slice(0, 7) >= FIRST_SIGNAL_MONTH);
  console.log(`종목 ${series.size}개, 거래일 ${CAL.length}일 ${CAL[0]}~${dataEnd}, 신호 ${sigs.length}개(${sigs[0]}~${sigs[sigs.length - 1]})`);

  const names = new Map<string, string>(), induty = new Map<string, string>();
  for (const r of await selectAll<{ corp_name: string; stock_code: string | null }>((f, t) => supabaseAdmin.from("dart_corp_codes").select("corp_name, stock_code").not("stock_code", "is", null).order("corp_code").range(f, t))) if (r.stock_code && series.has(r.stock_code)) names.set(r.stock_code, r.corp_name);
  for (const r of await selectAll<{ stock_code: string; induty_code: string | null }>((f, t) => supabaseAdmin.from("stock_industry_classification").select("stock_code, induty_code").order("stock_code").range(f, t))) if (r.induty_code) induty.set(r.stock_code, r.induty_code);
  const dl = await supabaseAdmin.storage.from(MM_BUCKET).download(MM_PARQUET_PATH);
  if (dl.error || !dl.data) throw new Error(`${MM_PARQUET_PATH} 없음`);
  const mm = (await parquetReadObjects({ file: await dl.data.arrayBuffer() })) as { trade_date: string; stock_code: string; market: string }[];
  const kospiAt = new Map<string, Set<string>>();
  for (const r of mm) {
    let s = kospiAt.get(r.trade_date);
    if (!s) { s = new Set(); kospiAt.set(r.trade_date, s); }
    if (r.market === "KOSPI") s.add(r.stock_code); else s.delete(r.stock_code);
  }
  console.log(`이름 ${names.size}, 업종 ${induty.size}, 월말 시장 목록 ${mm.length}행`);

  const signals = new Map<string, KssSignal>();
  for (const d of sigs) signals.set(d, computeKssSignal({ signalDate: d, series, kospiCodes: kospiAt.get(d) ?? new Set(), names, induty }));

  // ---- 1. 2026-09-30 ----
  const s = signals.get("2026-09-30")!;
  console.log(`\n=== 1. 2026-09-30 신호 (K200P ${s.k200pCount}종목, 모멘텀 ${s.momentumFrom}~${s.momentumTo}) ===\n| 순위 | 업종 | 유효 종목 수 (운영 / 연구) | 모멘텀 % (운영 / 연구) | 판정 |\n|---|---|---|---|---|`);
  EXP_0930.ranks.forEach((e, i) => {
    const r = s.sectorRanks[i];
    console.log(`| ${i + 1} | ${r?.sector} / ${e.sector} | ${r?.validCount} / ${e.n} | ${f2(r?.momentum * 100)} / ${f2(e.mom)} | ${check(r?.sector === e.sector && r.validCount === e.n && f2(r.momentum * 100) === f2(e.mom))} |`);
  });
  console.log(`정리 전 위성 ${s.preTrimHoldings.length}종목 (연구 ${EXP_0930.pre.length})\n| 코드 | 위성 비중 % (운영 / 연구) | 판정 |\n|---|---|---|`);
  for (const [c, w] of EXP_0930.pre) { const h = s.preTrimHoldings.find((x) => x.code === c); console.log(`| ${c} | ${f2((h?.weight ?? NaN) * 100)} / ${f2(w)} | ${check(f2((h?.weight ?? NaN) * 100) === f2(w))} |`); }
  console.log(`정리 후 위성 ${s.holdings.length}종목 (연구 ${EXP_0930.post.length})\n| 코드 | 위성 비중 % (운영 / 연구) | 계좌 비중 % | 판정 |\n|---|---|---|---|`);
  for (const [c, w] of EXP_0930.post) { const h = s.holdings.find((x) => x.code === c); console.log(`| ${c} | ${f2((h?.weight ?? NaN) * 100)} / ${f2(w)} | ${f2((h?.weight ?? NaN) * KSS_SATELLITE_WEIGHT * 100)} | ${check(f2((h?.weight ?? NaN) * 100) === f2(w))} |`); }
  check(s.preTrimHoldings.length === EXP_0930.pre.length && s.holdings.length === EXP_0930.post.length);

  // ---- 2. 분포 ----
  const bucket = (n: number): number => Math.min(n, 4);
  const dist = (ds: string[]): number[] => { const b = [0, 0, 0, 0, 0]; for (const d of ds) b[bucket(signals.get(d)!.holdings.length)]++; return b; };
  const since = sigs.filter((d) => d >= "2024-01-01");
  const avg = (ds: string[], f: (x: KssSignal) => number): number => ds.reduce((a, d) => a + f(signals.get(d)!), 0) / ds.length;
  const bf = dist(sigs), bs = dist(since);
  console.log(`\n=== 2. 정리 후 위성 종목 수 분포 (0개 / 1개 / 2개 / 3개 / 4개 이상) ===\n| 범위 | 신호일 수 (운영 / 연구) | 분포 운영 | 분포 연구 | 판정 |\n|---|---|---|---|---|`);
  console.log(`| 전 기간 | ${sigs.length} / ${EXP_DIST.full.n} | ${bf.join(" / ")} | ${EXP_DIST.full.b.join(" / ")} | ${check(sigs.length === EXP_DIST.full.n && bf.join() === EXP_DIST.full.b.join())} |`);
  console.log(`| 2024-01 이후 | ${since.length} / ${EXP_DIST.since2024.n} | ${bs.join(" / ")} | ${EXP_DIST.since2024.b.join(" / ")} | ${check(since.length === EXP_DIST.since2024.n && bs.join() === EXP_DIST.since2024.b.join())} |`);
  const ap = avg(sigs, (x) => x.preTrimHoldings.length), aq = avg(sigs, (x) => x.holdings.length), fb = sigs.filter((d) => signals.get(d)!.fallbackToEtf).length;
  console.log(`정리 전 평균 ${f2(ap)} / ${f2(EXP_DIST.avgPre)} ${check(f2(ap) === f2(EXP_DIST.avgPre))} | 정리 후 평균 ${f2(aq)} / ${f2(EXP_DIST.avgPost)} ${check(f2(aq) === f2(EXP_DIST.avgPost))} | 069500 대체 ${fb} / ${EXP_DIST.fallback} ${check(fb === EXP_DIST.fallback)}`);

  // ---- 3. v3.1 최소 운용 금액 ----
  const etfRowsRaw = await selectAll<{ trade_date: string; raw_close: number | null }>((f, t) => supabaseAdmin.from("etf_daily_prices").select("trade_date, raw_close").eq("code", KSS_ETF_CODE).order("trade_date").range(f, t));
  const etfRows = etfRowsRaw.filter((r) => r.raw_close !== null && r.trade_date <= dataEnd).map((r) => ({ d: r.trade_date as string, px: Number(r.raw_close) }));
  const etfAt = new Map(etfRows.map((r) => [r.d, r.px]));
  const etfLe = (d: string): number => { let px = NaN; for (const r of etfRows) { if (r.d > d) break; px = r.px; } return px; };
  const rawLe = (c: string, d: string): number => { const r = rawClose.get(c); if (!r) return NaN; const i = r.idx.get(d); if (i !== undefined) return r.raw[i]; let px = NaN; for (let k = 0; k < r.dates.length && r.dates[k] <= d; k++) px = r.raw[k]; return px; };
  console.log(`\n=== 3. v3.1 최소 운용 금액(정리 전 위성, 신호일 원 종가) ===\n| 신호일 | 운영 금액 | 연구 금액 | 운영 결정 종목 | 연구 결정 종목 | 판정 |\n|---|---|---|---|---|---|`);
  let minOk = 0;
  for (const [d, v, who] of EXP_MIN_ACCT) {
    const sg = signals.get(d);
    let best = { v: (etfAt.get(d) ?? NaN) / (1 - KSS_SATELLITE_WEIGHT), who: KSS_ETF_CODE };
    for (const h of sg?.preTrimHoldings ?? []) { const x = (rawClose.get(h.code)?.raw[rawClose.get(h.code)!.idx.get(d)!] ?? NaN) / (h.weight * KSS_SATELLITE_WEIGHT); if (x > best.v) best = { v: x, who: h.code }; }
    const ok = Math.abs(Math.round(best.v) - v) <= 1 && best.who === who;
    if (ok) minOk++;
    console.log(`| ${d} | ${fmt(best.v)} | ${fmt(v)} | ${best.who} | ${who} | ${check(ok)} |`);
  }
  console.log(`33개 중 일치 ${minOk}`);

  // ---- 4. B 시뮬레이션 ----
  const calIdx = new Map(CAL.map((d, i) => [d, i]));
  const endedBefore = new Date(Date.parse(dataEnd) - ENDED_GRACE_DAYS * 86_400_000).toISOString().slice(0, 10);
  console.log(`\n=== 4. B 시뮬레이션: 2026-10-01 리밸런싱 직후 (운영 / 연구) ===\n| 시드 | 069500 주수 | 위성 주수 | 현금(원) | 평가액(원) | 판정 |\n|---|---|---|---|---|---|`);
  for (const [seed, eE, eH, eCash, eV] of EXP_B) {
    let acc: KssAccount = { cash: seed, etfShares: 0, holdings: new Map() };
    let prevT: string | null = null, lastV = NaN;
    for (const d of sigs) {
      const T = CAL[calIdx.get(d)! + 1];
      if (!T) break;
      // 연구 B: 폐지(마지막 행 < T, 데이터 끝 − 14일 이전) 종목은 마지막 행 다음 거래일에 직전 종가로 청산
      for (const [c, n] of [...acc.holdings]) {
        const r = rawClose.get(c)!;
        if (!r.idx.has(T) && r.last < T && r.last < endedBefore) {
          const dLiq = CAL[calIdx.get(r.last)! + 1];
          const m = applyKssShareAdjustments(new Map([[c, n]]), adjustments, prevT!, dLiq).get(c)!;
          acc.cash += m * r.raw[r.raw.length - 1] * computeEffectiveSellPrice(1, dLiq, "KR");
          acc.holdings.delete(c);
        }
      }
      if (prevT) acc = { ...acc, holdings: applyKssShareAdjustments(acc.holdings, adjustments, prevT, T) };
      const sg = signals.get(d)!;
      const sat = sg.fallbackToEtf ? [] : sg.holdings.map((h) => ({ code: h.code, weight: h.weight }));
      const px = new Map<string, number>();
      for (const c of new Set([...acc.holdings.keys(), ...sat.map((x) => x.code)])) px.set(c, rawLe(c, T));
      const res = rebalanceKssAccount(acc, sat, { etf: etfLe(T), stocks: px }, T);
      acc = res.account;
      lastV = res.valueAfter;
      prevT = T;
    }
    const hs = Object.fromEntries([...acc.holdings].map(([c, n]) => [c, n]));
    const ok = acc.etfShares === eE && JSON.stringify(Object.entries(hs).sort()) === JSON.stringify(Object.entries(eH).sort()) && Math.abs(acc.cash - eCash) < 1 && Math.abs(lastV - eV) < 1;
    console.log(`| ${fmt(seed)} | ${acc.etfShares} / ${eE} | ${Object.entries(hs).map(([c, n]) => `${c} ${f2(n)}`).join(", ")} / ${Object.entries(eH).map(([c, n]) => `${c} ${f2(n)}`).join(", ")} | ${fmt(acc.cash)} / ${fmt(eCash)} | ${fmt(lastV)} / ${fmt(eV)} | ${check(ok)} |`);
  }

  console.log(`\n전체 판정: ${allOk ? "모두 일치" : "불일치 있음"} | DB 쓰기 0, 외부 요청 0 | 소요 ${((Date.now() - t0) / 60000).toFixed(1)}분`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

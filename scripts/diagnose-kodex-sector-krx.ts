/**
 * [임시 진단 — 정리 커밋에서 삭제, 읽기 전용, DB 쓰기 0, 외부 요청 KRX 3건]
 * 1. KRX sto/stk_bydd_trd(basDd=20261021) 1회: 응답 행 수, KOSPI 행 수, 필드 목록(기준·갱신 시각 관련 필드 여부).
 * 2. 운영 배치 경로(lib/kodexSectorStorage.ts: hot 표 ∪ Parquet + 신호일 KRX stk_bydd_trd·etf_bydd_trd)로 2026-09-30 신호를
 *    계산해 연구 결과와 비교. 차이가 있으면 같은 스크립트 안에서 연구 경로(Parquet 전종목 + 월말 시장 목록)로도 계산해
 *    K200P 구성·종목별 입력 값 차이를 찾는다.
 *   tsx --conditions=react-server scripts/diagnose-kodex-sector-krx.ts
 */
import { parquetReadObjects } from "hyparquet";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { applyAdjustmentsInPlace } from "@/lib/priceAdjustment";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS } from "@/lib/strategyBacktestSummaryConfig";
import { buildK200P, computeKssSignal, monthEndMonthsBefore, type KssSignal, type KssStockSeries } from "@/lib/kodexSectorSatellite";
import { fetchKrxEtfClose, fetchKrxKospiDay, getLatestHotDate, loadKssSignalInput } from "@/lib/kodexSectorStorage";
import { KSS_KRX_BASE_URL, KSS_MOMENTUM_LOOKBACK_MONTHS } from "@/lib/kodexSectorSatelliteConfig";

const SIGNAL = "2026-09-30";
const PREV_DAY = "20261021";
const EXP = {
  ranks: [{ sector: "26", n: 16, mom: 75.3 }, { sector: "62", n: 2, mom: 53.05 }, { sector: "65", n: 8, mom: 38.58 }],
  pre: [["005930", 50.63], ["000660", 41.84], ["009150", 3.64], ["032830", 1.82], ["000810", 0.91], ["018260", 0.55], ["005830", 0.39], ["064400", 0.21]] as [string, number][],
  post: [["005930", 54.75], ["000660", 45.25]] as [string, number][],
};
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
let krxCalls = 0;

function lastIndexLe(dates: string[], d: string): number {
  let lo = 0, hi = dates.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (dates[m] <= d) { k = m; lo = m + 1; } else hi = m - 1; }
  return k;
}

function compare(label: string, s: KssSignal): boolean {
  let ok = true;
  const mark = (b: boolean): string => { if (!b) ok = false; return b ? "일치" : "불일치"; };
  console.log(`\n=== ${label}: ${SIGNAL} (K200P ${s.k200pCount}종목, 모멘텀 ${s.momentumFrom}~${s.momentumTo}) ===\n| 순위 | 업종 (계산 / 연구) | 유효 종목 수 | 모멘텀 % | 판정 |\n|---|---|---|---|---|`);
  EXP.ranks.forEach((e, i) => { const r = s.sectorRanks[i]; console.log(`| ${i + 1} | ${r?.sector} / ${e.sector} | ${r?.validCount} / ${e.n} | ${f2(r?.momentum * 100)} / ${f2(e.mom)} | ${mark(r?.sector === e.sector && r.validCount === e.n && f2(r.momentum * 100) === f2(e.mom))} |`); });
  console.log(`정리 전 ${s.preTrimHoldings.length}종목 (연구 ${EXP.pre.length}) ${mark(s.preTrimHoldings.length === EXP.pre.length)}\n| 코드 | 위성 비중 % (계산 / 연구) | 판정 |\n|---|---|---|`);
  for (const [c, w] of EXP.pre) { const h = s.preTrimHoldings.find((x) => x.code === c); console.log(`| ${c} | ${f2((h?.weight ?? NaN) * 100)} / ${f2(w)} | ${mark(f2((h?.weight ?? NaN) * 100) === f2(w))} |`); }
  console.log(`정리 후 ${s.holdings.length}종목 (연구 ${EXP.post.length}) ${mark(s.holdings.length === EXP.post.length)}\n| 코드 | 위성 비중 % (계산 / 연구) | 판정 |\n|---|---|---|`);
  for (const [c, w] of EXP.post) { const h = s.holdings.find((x) => x.code === c); console.log(`| ${c} | ${f2((h?.weight ?? NaN) * 100)} / ${f2(w)} | ${mark(f2((h?.weight ?? NaN) * 100) === f2(w))} |`); }
  console.log(`판정: ${ok ? "모두 일치" : "불일치 있음"}`);
  return ok;
}

async function main(): Promise<void> {
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");
  console.log(`진단 시작: ${new Date().toISOString()} (KST ${new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" })})`);

  // ---- 1. 전 거래일 아침 데이터 ----
  const res = await fetch(`${KSS_KRX_BASE_URL}/sto/stk_bydd_trd?basDd=${PREV_DAY}`, { headers: { AUTH_KEY: apiKey } });
  krxCalls++;
  const body = (await res.json()) as Record<string, unknown>;
  const rows = (body.OutBlock_1 as Record<string, string>[] | undefined) ?? [];
  const mkt = new Map<string, number>();
  for (const r of rows) mkt.set(r.MKT_NM ?? "(없음)", (mkt.get(r.MKT_NM ?? "(없음)") ?? 0) + 1);
  const valid = rows.filter((r) => r.TDD_CLSPRC && r.TDD_CLSPRC !== "-" && Number(r.ACC_TRDVOL) > 0).length;
  const dates = new Set(rows.map((r) => r.BAS_DD));
  console.log(`\n=== 1. KRX sto/stk_bydd_trd basDd=${PREV_DAY} ===`);
  console.log(`HTTP ${res.status} | 응답 헤더 date=${res.headers.get("date")} last-modified=${res.headers.get("last-modified") ?? "-"}`);
  console.log(`최상위 키: ${Object.keys(body).join(", ")}`);
  console.log(`OutBlock_1 행 ${rows.length} | 시장 구분(MKT_NM): ${[...mkt].map(([k, v]) => `${k} ${v}`).join(", ") || "-"} | 종가·거래량 있는 행 ${valid} | BAS_DD 값: ${[...dates].join(", ") || "-"}`);
  console.log(`행 필드: ${rows[0] ? Object.keys(rows[0]).join(", ") : "-"}`);
  console.log(`시각 관련 필드(이름에 TM·TIME·UPD·DT 포함): ${rows[0] ? Object.keys(rows[0]).filter((k) => /TM|TIME|UPD|_DT$/i.test(k)).join(", ") || "없음" : "-"}`);
  console.log(`hot 표 최신 날짜: ${await getLatestHotDate()}`);

  // ---- 2. 운영 경로 ----
  const kospiDay = await fetchKrxKospiDay(SIGNAL, apiKey);
  krxCalls++;
  const etfClose = await fetchKrxEtfClose(SIGNAL, apiKey);
  krxCalls++;
  console.log(`\n=== 2. 운영 경로 입력 ===\nKRX stk_bydd_trd(${SIGNAL}) 사용 행 ${kospiDay.length}, 069500 종가 ${etfClose}`);
  const input = await loadKssSignalInput(SIGNAL, monthEndMonthsBefore(SIGNAL, KSS_MOMENTUM_LOOKBACK_MONTHS), kospiDay);
  const prodIn = { signalDate: SIGNAL, series: input.series, kospiCodes: new Set(kospiDay.map((r) => r.code)), names: input.names, induty: input.induty };
  const prod = computeKssSignal(prodIn);
  const prodOk = compare("운영 경로", prod);

  // ---- 연구 경로(같은 스크립트 안, 차이 원인 확인용) ----
  const adjustments = await loadAppliedAdjustments();
  const raw = await loadAllStockSeriesFromParquet(2010, 2026);
  const rs = new Map<string, KssStockSeries>();
  for (const [code, list] of raw) {
    raw.delete(code);
    if (!list.length) continue;
    const adj = list.map((r) => ({ ...r }));
    const al = adjustments.get(code);
    if (al) applyAdjustmentsInPlace(adj, al);
    rs.set(code, { dates: list.map((r) => r.tradeDate), close: Float64Array.from(adj.map((r) => r.closePrice)), mcapEok: Float64Array.from(list.map((r) => r.marketCapEok)), avgTv: computeTrailingAvgTradingValue(adj, PIT_LIQUIDITY_LOOKBACK_DAYS) });
  }
  const dl = await supabaseAdmin.storage.from("stock-daily-prices").download("research/market_membership/month_end.parquet");
  if (dl.error || !dl.data) throw new Error("월말 시장 목록 없음");
  const mm = (await parquetReadObjects({ file: await dl.data.arrayBuffer() })) as { trade_date: string; stock_code: string; market: string }[];
  const kospiRes = new Set<string>();
  for (const r of mm) if (r.trade_date === SIGNAL) { if (r.market === "KOSPI") kospiRes.add(r.stock_code); else kospiRes.delete(r.stock_code); }
  const resIn = { signalDate: SIGNAL, series: rs, kospiCodes: kospiRes, names: input.names, induty: input.induty };
  const resSig = computeKssSignal(resIn);
  compare("연구 경로(같은 실행, 참고)", resSig);

  // ---- 차이 ----
  const kP = buildK200P(prodIn), kR = buildK200P(resIn);
  const setP = new Set(kP.map((x) => x.code)), setR = new Set(kR.map((x) => x.code));
  const onlyP = kP.filter((x) => !setR.has(x.code)), onlyR = kR.filter((x) => !setP.has(x.code));
  console.log(`\n=== 차이 점검 ===\nKOSPI 목록: 운영 ${prodIn.kospiCodes.size}종목(거래량 0 제외) / 월말 목록 ${kospiRes.size}종목, 운영에만 ${[...prodIn.kospiCodes].filter((c) => !kospiRes.has(c)).length}, 월말 목록에만 ${[...kospiRes].filter((c) => !prodIn.kospiCodes.has(c)).length}`);
  console.log(`K200P: 운영 ${kP.length} / 연구 ${kR.length}, 운영에만 ${onlyP.map((x) => x.code).join(", ") || "없음"}, 연구에만 ${onlyR.map((x) => x.code).join(", ") || "없음"}`);
  const S0 = prod.momentumFrom, E0 = prod.momentumTo;
  const inputsOf = (s: KssStockSeries | undefined): { mcap: number; tv: number; a: string; b: string; ret: number; m0: number } | null => {
    if (!s) return null;
    const i = lastIndexLe(s.dates, SIGNAL), a = lastIndexLe(s.dates, S0), b = lastIndexLe(s.dates, E0);
    return { mcap: s.mcapEok[i], tv: s.avgTv[i], a: s.dates[a] ?? "-", b: s.dates[b] ?? "-", ret: s.close[b] / s.close[a] - 1, m0: s.mcapEok[a] };
  };
  const diffs: string[] = [];
  for (const c of new Set([...setP, ...setR])) {
    const p = inputsOf(input.series.get(c)), r = inputsOf(rs.get(c));
    if (!p || !r) { diffs.push(`| ${c} | ${p ? "" : "운영 시세 없음"} | ${r ? "" : "연구 시세 없음"} | | | |`); continue; }
    const rel = (x: number, y: number): boolean => Math.abs(x - y) > 1e-9 * Math.max(1, Math.abs(y));
    if (rel(p.mcap, r.mcap) || rel(p.tv, r.tv) || p.a !== r.a || p.b !== r.b || rel(p.ret, r.ret) || rel(p.m0, r.m0))
      diffs.push(`| ${c} | 시총 ${f2(p.mcap)} / ${f2(r.mcap)} | 20일 평균 거래대금 ${f2(p.tv / 1e8)} / ${f2(r.tv / 1e8)}억 | 시작 행 ${p.a} / ${r.a}, 끝 행 ${p.b} / ${r.b} | 수익률 ${f2(p.ret * 100)} / ${f2(r.ret * 100)}% | 시작 시총 ${f2(p.m0)} / ${f2(r.m0)} |`);
  }
  console.log(`K200P 합집합 ${new Set([...setP, ...setR]).size}종목 중 입력 값이 다른 종목 ${diffs.length}개 (운영 / 연구)\n| 코드 | 신호일 시총(억) | 거래대금 | 모멘텀 행 | 모멘텀 수익률 | 시작 월말 시총(억) |\n|---|---|---|---|---|---|`);
  for (const d of diffs.slice(0, 30)) console.log(d);
  console.log(`\n운영 경로 판정: ${prodOk ? "연구와 모두 일치" : "불일치 있음"} | KRX 호출 ${krxCalls}건 | DB 쓰기 0`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

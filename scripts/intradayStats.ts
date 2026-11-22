/**
 * [임시 연구 — 병합 금지] 분봉 점검 2단계(docs/research/intraday-design.md 1·3·4절): 확정한 묶음 규칙(lib/intradayConfig.ts) 기준 봉 수·무거래 봉·거래대금·비용·봉/보유 구간 수익률 표준편차(신호와 무관한 무조건부 표집 통계)·검정력.
 * 신호·가설 조건·성과 계산 없음. 읽기 전용(분봉 월 파일은 Actions 캐시 research-files-v1), 연구 DB 쓰기 0, 외부 호출 0.
 */
import { parquetReadObjects } from "hyparquet";
import { cachedBytes } from "@/lib/researchFileCache";
import { download, io, mib } from "@/lib/forwardCollectKit";
import { FWD_MIN_PREFIX, FWD_MANIFEST_FILE } from "@/lib/forwardDataConfig";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { ID_OPEN_LABEL_MIN, ID_CONT_MINUTES, ID_AUCTION_HHMM, ID_UNITS, ID_ORDER_WON, ID_FEE_PER_SIDE, ID_IMPACT_BINS, ID_IMPACT_OVER, ID_PARTICIPATION_MAX, ID_SELL_TAX, ID_MU_PCT, ID_Z_ONE_SIDED_95, ID_GAP_TH, ID_TICK } from "@/lib/intradayConfig";
import { f2, avg, median, type Harness } from "./researchHarness";

type Row = { hhmm: number; o: number; h: number; l: number; c: number; v: number; a: number };
type Bar = { k: number; o: number; h: number; l: number; c: number; v: number; val: number; auction: boolean };
const iso = (d: number): string => { const s = String(d); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; };
const tmin = (hhmm: number): number => Math.floor(hhmm / 100) * 60 + (hhmm % 100) - ID_OPEN_LABEL_MIN;
const sdOf = (a: number[]): number => { const m = avg(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(a.length - 1, 1)); };
const qn = (a: number[], q: number): number => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(q * (b.length - 1)))] : Number.NaN; };

/** 묶음 규칙: 봉 시가 = 첫 행 시가, 고저 = 최고·최저, 종가 = 마지막 행 종가, 거래량 = 합, 거래대금 = 누적대금 행 간 차분의 합(첫 행은 그 행 누적대금). 60분은 마지막 봉(15:00~15:30)에 종가 단일가 행을 포함, 10분은 종가 단일가 행을 39번째 별도 봉으로 둔다. */
function barsOf(rows: Row[], unit: number): Bar[] {
  const m = new Map<number, Bar>();
  let prevA = 0;
  for (const r of rows) {
    const auction = r.hhmm === ID_AUCTION_HHMM, t = tmin(r.hhmm);
    let k: number;
    if (auction) k = unit === 60 ? Math.floor((ID_CONT_MINUTES - 1) / unit) : Math.floor(ID_CONT_MINUTES / unit);
    else k = Math.floor(t / unit);
    const val = r.a - prevA; prevA = r.a;
    const b = m.get(k);
    if (!b) m.set(k, { k, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v, val, auction: auction && unit === 10 });
    else { b.h = Math.max(b.h, r.h); b.l = Math.min(b.l, r.l); b.c = r.c; b.v += r.v; b.val += val; }
  }
  return [...m.values()].sort((x, y) => x.k - y.k);
}

export async function intradayStats(h: Harness, label: (c: string) => string): Promise<void> {
  const readB0 = io.readBytes;
  const mb = await cachedBytes(`${FWD_MIN_PREFIX}/${FWD_MANIFEST_FILE}`, () => download(`${FWD_MIN_PREFIX}/${FWD_MANIFEST_FILE}`));
  if (!mb) throw new Error("manifest 없음");
  const keys = Object.keys((JSON.parse(new TextDecoder().decode(mb)) as { files: Record<string, unknown> }).files).sort();
  const data = new Map<string, Map<number, Row[]>>();
  let next = 0;
  const work = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= keys.length) return;
      const k = keys[i], code = k.split("/")[0];
      const b = await cachedBytes(`${FWD_MIN_PREFIX}/${k}.parquet`, () => download(`${FWD_MIN_PREFIX}/${k}.parquet`));
      if (!b) throw new Error(`월 파일 없음 ${k}`);
      const byDay = data.get(code) ?? new Map<number, Row[]>();
      for (const r of (await parquetReadObjects({ file: b })) as Record<string, unknown>[]) { const d = Number(r.trade_date), a = byDay.get(d) ?? []; a.push({ hhmm: Number(r.hhmm), o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close), v: Number(r.volume), a: Number(r.amount) }); byDay.set(d, a); }
      data.set(code, byDay);
    }
  };
  await Promise.all(Array.from({ length: 8 }, () => work()));
  for (const m of data.values()) for (const rows of m.values()) rows.sort((x, y) => x.hhmm - y.hhmm);
  const codes = [...data.keys()].sort();
  console.log(`\n=== [S0] 읽기: 종목 ${codes.length}, 월 파일 ${keys.length}개, 이번 실행 Storage 다운로드 ${mib(io.readBytes - readB0)} MiB(캐시 적중이면 0) ===`);

  // ---- [S1] 공백: 종가 단일가 점프(15:19→15:30) 제외 ----
  const gapH = new Map<string, number>();
  let late = 0, noAuction = 0, stockDays = 0;
  for (const c of codes) for (const rows of (data.get(c) as Map<number, Row[]>).values()) {
    stockDays++;
    if (rows[rows.length - 1].hhmm !== ID_AUCTION_HHMM) noAuction++;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].hhmm === ID_AUCTION_HHMM) continue;
      const df = tmin(rows[i].hhmm) - tmin(rows[i - 1].hhmm);
      if (df >= 2) { const k = df === 2 ? "2분" : df <= 5 ? "3~5분" : df <= 10 ? "6~10분" : df <= 30 ? "11~30분" : "30분 초과"; gapH.set(k, (gapH.get(k) ?? 0) + 1); }
    }
    if (tmin(rows[0].hhmm) >= 60) late++;
  }
  console.log(`\n=== [S1] 연속 매매 구간 공백(종가 단일가 행 앞의 15:19→15:30 점프 제외) ===\n종목-날짜 ${stockDays}개 | 연속 매매 중 행 공백 ${["2분", "3~5분", "6~10분", "11~30분", "30분 초과"].map((k) => `${k} ${gapH.get(k) ?? 0}`).join(", ")} | 종가 단일가 행(15:30)이 없는 종목-날짜 ${noAuction}개 | 첫 행이 10:00 이후인 종목-날짜 ${late}개(지연 개장일)`);

  // ---- [S2] 묶음 규칙 적용 후 봉 수·무거래 봉·거래대금 ----
  const daily = await loadAllStockSeriesFromParquet(2011, 2026);
  const dMap = new Map<string, Map<string, { o: number; c: number; v: number; tv: number }>>();
  for (const c of codes) dMap.set(c, new Map((daily.get(c) ?? []).map((r) => [r.tradeDate, { o: r.openPrice, c: r.closePrice, v: r.volume, tv: r.tradingValue }])));
  const per: Record<string, { unit: number; stock: Map<string, { valSum: number; n: number; missing: number; expected: number }> }> = {};
  const barsCache = new Map<string, Bar[]>();
  console.log(`\n=== [S2] 봉 묶음 후(시가·종가·거래량·거래대금 규칙 고정) 단위별 봉 수·무거래 봉 비율 ===`);
  for (const unit of ID_UNITS) {
    const expected = unit === 10 ? Math.ceil(ID_CONT_MINUTES / unit) : Math.ceil(ID_CONT_MINUTES / unit);
    const barsPerDay: number[] = [], stock = new Map<string, { valSum: number; n: number; missing: number; expected: number }>();
    let exp = 0, miss = 0, auctionBars = 0;
    for (const c of codes) {
      const e = { valSum: 0, n: 0, missing: 0, expected: 0 };
      for (const [d, rows] of data.get(c) as Map<number, Row[]>) {
        const bs = barsOf(rows, unit);
        barsCache.set(`${unit}|${c}|${d}`, bs);
        const reg = bs.filter((b) => !b.auction);
        barsPerDay.push(bs.length); e.expected += expected; e.missing += expected - reg.length; exp += expected; miss += expected - reg.length;
        for (const b of reg) { e.valSum += b.val; e.n++; }
        if (bs.some((b) => b.auction)) auctionBars++;
      }
      stock.set(c, e);
    }
    per[unit] = { unit, stock };
    console.log(`${unit}분봉: 하루 정규 봉 ${expected}개${unit === 10 ? "(+ 종가 단일가 별도 봉 1개)" : "(마지막 봉 15:00~15:30은 20분 연속 + 종가 단일가 행 포함)"} | 종목-날짜당 봉 수(단일가 봉 포함) 최소 ${Math.min(...barsPerDay)} 중앙값 ${median(barsPerDay)} 최대 ${Math.max(...barsPerDay)} | 행 없는(무거래) 정규 봉 ${miss}/${exp}(${f2((miss / exp) * 100)}%) | 종가 단일가 별도 봉 ${auctionBars}개`);
  }

  // ---- [S3] 종목별 평균 봉 거래대금·참여율·비용 ----
  console.log(`\n=== [S3] 종목별 평균 봉 거래대금(억 원)·1억 원 주문 비중·편도 슬리피지·왕복 비용(%) ===\n충격 구간(주문 ÷ 평균 봉 거래대금): ${ID_IMPACT_BINS.map(([u, v], i) => `${i === 0 ? "≤" : `${f2(ID_IMPACT_BINS[i - 1][0] * 100)}% 초과~`}${f2(u * 100)}% → ${f2(v * 100)}%`).join(", ")}, 그 초과 → ${f2(ID_IMPACT_OVER * 100)}%(≥ ${f2(ID_PARTICIPATION_MAX * 100)}%이면 제외) | 편도 슬리피지 = 충격 + 반호가(0.5 × 호가 단위 ÷ 가격) | 왕복 = 수수료 ${f2(ID_FEE_PER_SIDE * 200)}% + 매도세 ${f2(ID_SELL_TAX * 100)}% + 2 × 편도 슬리피지`);
  console.log("| 종목 | 중앙 가격(원) | 반호가 % | 10분 평균 봉 대금(억) | 10분 주문 비중 % | 10분 편도 슬립 % | 10분 왕복 % | 60분 평균 봉 대금(억) | 60분 주문 비중 % | 60분 편도 슬립 % | 60분 왕복 % |\n|---|---|---|---|---|---|---|---|---|---|---|");
  const rt: Record<number, number[]> = { 10: [], 60: [] }, binCnt: Record<number, Map<string, number>> = { 10: new Map(), 60: new Map() };
  const impactOf = (p: number): number => { for (const [u, v] of ID_IMPACT_BINS) if (p <= u) return v; return ID_IMPACT_OVER; };
  const binName = (p: number): string => { for (const [u] of ID_IMPACT_BINS) if (p <= u) return `≤${f2(u * 100)}%`; return `>${f2(ID_IMPACT_BINS[ID_IMPACT_BINS.length - 1][0] * 100)}%`; };
  for (const c of codes) {
    const prices: number[] = [];
    for (const rows of (data.get(c) as Map<number, Row[]>).values()) prices.push(rows[Math.floor(rows.length / 2)].c);
    const pm = median(prices), half = (0.5 * ID_TICK(pm)) / pm;
    const cells: string[] = [];
    for (const unit of ID_UNITS) {
      const e = per[unit].stock.get(c) as { valSum: number; n: number }, avgVal = e.valSum / Math.max(e.n, 1), p = ID_ORDER_WON / avgVal;
      const slip = impactOf(p) + half, round = ID_FEE_PER_SIDE * 2 + ID_SELL_TAX + 2 * slip;
      if (p <= ID_PARTICIPATION_MAX) { rt[unit].push(round * 100); binCnt[unit].set(binName(p), (binCnt[unit].get(binName(p)) ?? 0) + 1); }
      cells.push(`${f2(avgVal / 1e8)} | ${f2(p * 100)} | ${f2(slip * 100)} | ${f2(round * 100)}${p > ID_PARTICIPATION_MAX ? "(제외)" : ""}`);
    }
    console.log(`| ${label(c)} | ${Math.round(pm)} | ${f2(half * 100)} | ${cells.join(" | ")} |`);
  }
  for (const unit of ID_UNITS) console.log(`${unit}분 왕복 비용(%) 종목 분포: 최소 ${f2(Math.min(...rt[unit]))} 25% ${f2(qn(rt[unit], 0.25))} 중앙값 ${f2(median(rt[unit]))} 75% ${f2(qn(rt[unit], 0.75))} 최대 ${f2(Math.max(...rt[unit]))} (대상 ${rt[unit].length}종목) | 충격 구간별 종목 수: ${[...binCnt[unit].entries()].map(([k, v]) => `${k} ${v}`).join(", ")}`);

  // ---- [S4] 일봉 대조(전체): 첫 봉 시가·마지막 종가·거래량 합 ----
  console.log(`\n=== [S4] 분봉 vs 같은 날 일봉(고정 스냅샷 ${h.dataEnd}까지, 전 종목-날짜) 대조 ===`);
  {
    let n = 0, openOk = 0, closeOk = 0, volOk = 0;
    const closeBad = new Map<string, number>(), volRatio: number[] = [];
    for (const c of codes) for (const [d, rows] of data.get(c) as Map<number, Row[]>) {
      const dr = (dMap.get(c) as Map<string, { o: number; c: number; v: number }>).get(iso(d));
      if (!dr || iso(d) > h.dataEnd) continue;
      n++;
      if (rows[0].o === dr.o) openOk++;
      if (rows[rows.length - 1].c === dr.c) closeOk++; else closeBad.set(label(c), (closeBad.get(label(c)) ?? 0) + 1);
      const sv = rows.reduce((a, r) => a + r.v, 0);
      volRatio.push(sv / dr.v); if (sv === dr.v) volOk++;
    }
    console.log(`겹친 종목-날짜 ${n}건 | 첫 행 시가 = 일봉 시가 ${openOk}(${f2((openOk / n) * 100)}%) | 마지막 행 종가 = 일봉 종가 ${closeOk}(${f2((closeOk / n) * 100)}%) | 분봉 거래량 합 = 일봉 거래량 ${volOk}(${f2((volOk / n) * 100)}%), 합 ÷ 일봉 거래량 중앙값 ${f2(median(volRatio))} 5% ${f2(qn(volRatio, 0.05))} 95% ${f2(qn(volRatio, 0.95))} | 종가 불일치 종목별: ${[...closeBad.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(", ") || "없음"}`);
  }

  // ---- [S5] 무조건부 표집 통계: 봉 수익률·보유 구간 수익률 표준편차(신호와 무관, 모든 종목-날짜) ----
  console.log(`\n=== [S5] 무조건부 표집 통계(모든 종목-날짜, 신호 조건 없음; 수익률 % 표준편차) ===`);
  const sig: Record<string, number> = {};
  const sd10: number[] = [], sd60: number[] = [], pool = (arr: number[]): { n: number; sd: number; stockMedSd: number } => ({ n: arr.length, sd: sdOf(arr), stockMedSd: 0 });
  void sd10; void sd60; void pool;
  const collect = (fn: (c: string, d: number, rows: Row[]) => number | null): { all: number[]; perStockSd: number } => {
    const all: number[] = [], per2: number[] = [];
    for (const c of codes) { const arr: number[] = []; for (const [d, rows] of data.get(c) as Map<number, Row[]>) { const r = fn(c, d, rows); if (r !== null && Number.isFinite(r)) arr.push(r * 100); } all.push(...arr); if (arr.length > 30) per2.push(sdOf(arr)); }
    return { all, perStockSd: median(per2) };
  };
  const row = (name: string, x: { all: number[]; perStockSd: number }, key: string): void => { sig[key] = sdOf(x.all); console.log(`| ${name} | ${x.all.length} | ${f2(avg(x.all))} | ${f2(sdOf(x.all))} | ${f2(x.perStockSd)} |`); };
  console.log("| 구간 수익률 정의 | 표본 수 | 평균 % | 표준편차 % | 종목별 표준편차 중앙값 % |\n|---|---|---|---|---|");
  // 봉 종가-종가 수익률(같은 날 연속 정규 봉)
  for (const unit of ID_UNITS) {
    const all: number[] = [], ps: number[] = [];
    for (const c of codes) { const arr: number[] = []; for (const d of (data.get(c) as Map<number, Row[]>).keys()) { const bs = (barsCache.get(`${unit}|${c}|${d}`) as Bar[]).filter((b) => !b.auction); for (let i = 1; i < bs.length; i++) arr.push((bs[i].c / bs[i - 1].c - 1) * 100); } all.push(...arr); ps.push(sdOf(arr)); }
    row(`${unit}분 봉 종가→다음 봉 종가(같은 날 연속 정규 봉)`, { all, perStockSd: median(ps) }, `bar${unit}`);
  }
  const barAt = (unit: number, c: string, d: number, k: number): Bar | undefined => (barsCache.get(`${unit}|${c}|${d}`) as Bar[]).find((b) => b.k === k);
  const lastC = (rows: Row[]): number => rows[rows.length - 1].c;
  row("[일 시가→종가] 60분 1번째 봉 시가 → 일 종가 단일가(마감 30분 흐름의 다음 날 구간)", collect((c, d, rows) => { const b = barAt(60, c, d, 0); return b ? lastC(rows) / b.o - 1 : null; }), "oc60");
  row("[09:30 진입→종가] 10분 4번째 봉(09:30~09:40) 시가 → 종가(갭·시초 30분 가설 구간)", collect((c, d, rows) => { const b = barAt(10, c, d, 3); return b ? lastC(rows) / b.o - 1 : null; }), "h0930");
  for (const [hh, k] of [[13, 24], [14, 30], [15, 36]] as const) row(`[${hh}:00 진입→종가] 10분 ${k + 1}번째 봉(${hh}:00~${hh}:10) 시가 → 종가(오후 돌파 가설 구간)`, collect((c, d, rows) => { const b = barAt(10, c, d, k); return b ? lastC(rows) / b.o - 1 : null; }), `h${hh}`);
  {
    const all: number[] = [], ps: number[] = [];
    for (const c of codes) { const arr: number[] = []; for (const d of (data.get(c) as Map<number, Row[]>).keys()) for (let k = 1; k <= 31; k++) { const a = barAt(10, c, d, k), b = barAt(10, c, d, k + 5); if (a && b) arr.push((b.c / a.o - 1) * 100); } all.push(...arr); ps.push(sdOf(arr)); }
    row("[60분 보유] 10분 봉 k 시가 → 봉 k+5 종가(k = 2번째~32번째 봉, 거래량 이상 가설 구간)", { all, perStockSd: median(ps) }, "h60");
  }

  // ---- [S6] 검정력: 필요한 거래 수 ----
  console.log(`\n=== [S6] 필요한 최소 거래 수 n = (z × σ ÷ μ)², z = ${ID_Z_ONE_SIDED_95}(단측 95% 신뢰하한이 0 위), σ = 위 무조건부 표준편차(독립 표본 가정 = 하한; 같은 날 종목 간 상관이 있으면 더 필요) ===\n| 구간 | σ % | ${ID_MU_PCT.map((m) => `μ = +${f2(m)}% 필요 거래 수`).join(" | ")} |\n|---|---|${ID_MU_PCT.map(() => "---").join("|")}|`);
  const need = (s: number, mu: number): number => Math.ceil(((ID_Z_ONE_SIDED_95 * s) / mu) ** 2);
  for (const [k, nm] of [["bar10", "10분 봉 수익률"], ["bar60", "60분 봉 수익률"], ["oc60", "일 시가→종가(60분봉 가설)"], ["h0930", "09:30→종가(10분봉)"], ["h13", "13:00→종가(10분봉)"], ["h14", "14:00→종가(10분봉)"], ["h15", "15:00→종가(10분봉)"], ["h60", "60분 보유(10분봉)"]] as const) console.log(`| ${nm} | ${f2(sig[k])} | ${ID_MU_PCT.map((m) => need(sig[k], m)).join(" | ")} |`);

  // ---- [S7] 갭 하락 ≤ -2% 빈도(분봉 표본 이전 일봉만: 2011-01-01 ~ 2025-11-14, 구조 파라미터) ----
  console.log(`\n=== [S7] 시가 갭 ≤ ${f2(ID_GAP_TH * 100)}% 종목-일 빈도(분봉 표본 이전 일봉 2011-01~2025-11-14, 대상 30종목, 가격 수익·신호 계산 아님; 원 시세 기반이라 분할·병합일은 노이즈) ===`);
  {
    let n = 0, hit = 0;
    const byYear = new Map<string, { n: number; hit: number }>();
    for (const c of codes) {
      const rows = (daily.get(c) ?? []).filter((r) => r.tradeDate <= "2025-11-14").sort((a, b) => (a.tradeDate < b.tradeDate ? -1 : 1));
      for (let i = 1; i < rows.length; i++) {
        const g = rows[i].openPrice / rows[i - 1].closePrice - 1;
        if (!Number.isFinite(g) || rows[i].openPrice <= 0 || Math.abs(g) > 0.4) continue;
        n++; const y = rows[i].tradeDate.slice(0, 4), e = byYear.get(y) ?? { n: 0, hit: 0 }; e.n++;
        if (g <= ID_GAP_TH) { hit++; e.hit++; }
        byYear.set(y, e);
      }
    }
    console.log(`전체 ${n}종목-일 중 갭 ≤ ${f2(ID_GAP_TH * 100)}%: ${hit}건(${f2((hit / n) * 100)}%) → 30종목 기준 하루 평균 ${f2((hit / n) * 30)}건, 연 ${f2((hit / n) * 30 * 245)}건 | 연도별 %: ${[...byYear.entries()].sort().map(([y, e]) => `${y} ${f2((e.hit / e.n) * 100)}`).join(" ")}`);
  }
  console.log(`\n분봉 점검 2단계 종료(신호·성과 계산 없음)`);
}

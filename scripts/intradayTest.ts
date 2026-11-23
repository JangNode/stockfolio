/**
 * [임시 연구 — 병합 금지] 분봉 장중 가설 H4(시험 318)·H5(시험 319) 사전 점검·시험. 정의·관문: docs/research/intraday-prereg.md(설계안 intraday-design.md 그대로).
 * 읽기 전용: 분봉 월 파일(Actions 캐시 research-files-v1), 일봉 대조(고정 스냅샷), 069500(보조 파일 + 연구 DS6 포워드 로그), 코스피 지수(DB 읽기). 연구 DB 쓰기 0, 외부 호출 0.
 */
import { promises as fs } from "node:fs";
import { parquetReadObjects } from "hyparquet";
import { cachedBytes } from "@/lib/researchFileCache";
import { download, io, mib } from "@/lib/forwardCollectKit";
import { FWD_MIN_PREFIX, FWD_MANIFEST_FILE } from "@/lib/forwardDataConfig";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { getSecuritiesTaxRate } from "@/lib/transactionCost";
import { ID_AUCTION_HHMM, ID_ORDER_WON, ID_FEE_PER_SIDE, ID_IMPACT_BINS, ID_IMPACT_OVER, ID_PARTICIPATION_MAX, ID_TICK, ID_OPEN_LABEL_MIN } from "@/lib/intradayConfig";
import { INTRADAY_PARAMS as P } from "@/lib/intradayTestConfig";
import { barsOf } from "./intradayStats";
import { mulberry32, f2, avg, median, type Harness } from "./researchHarness";

type Row = { hhmm: number; o: number; h: number; l: number; c: number; v: number; a: number };
type Bar = { k: number; o: number; h: number; l: number; c: number; v: number; val: number; auction: boolean };
interface Day { rows: Row[]; b: (Bar | undefined)[]; lastClose: number }
interface Trade { code: string; d: number; kSig: number; kE: number; kX: number; entryP: number; exitP: number; gross: number; net: number; noSlip: number; holdMin: number }
const iso = (d: number): string => { const s = String(d); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; };
const tmin = (hhmm: number): number => Math.floor(hhmm / 100) * 60 + (hhmm % 100) - ID_OPEN_LABEL_MIN;
const sdOf = (a: number[]): number => { const m = avg(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(a.length - 1, 1)); };
const sg = (x: number): string => `${x >= 0 ? "+" : ""}${f2(x)}`;

interface Mkt { codes: string[]; days: number[]; dayIso: string[]; data: Map<string, Map<number, Day>>; raw: Map<string, Map<number, Row[]>> }
async function loadMkt(): Promise<Mkt> {
  const mb = await cachedBytes(`${FWD_MIN_PREFIX}/${FWD_MANIFEST_FILE}`, () => download(`${FWD_MIN_PREFIX}/${FWD_MANIFEST_FILE}`));
  if (!mb) throw new Error("manifest 없음");
  const keys = Object.keys((JSON.parse(new TextDecoder().decode(mb)) as { files: Record<string, unknown> }).files).sort();
  const raw = new Map<string, Map<number, Row[]>>();
  let next = 0;
  const work = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= keys.length) return;
      const k = keys[i], code = k.split("/")[0];
      const b = await cachedBytes(`${FWD_MIN_PREFIX}/${k}.parquet`, () => download(`${FWD_MIN_PREFIX}/${k}.parquet`));
      if (!b) throw new Error(`월 파일 없음 ${k}`);
      const byDay = raw.get(code) ?? new Map<number, Row[]>();
      for (const r of (await parquetReadObjects({ file: b })) as Record<string, unknown>[]) { const d = Number(r.trade_date), a = byDay.get(d) ?? []; a.push({ hhmm: Number(r.hhmm), o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close), v: Number(r.volume), a: Number(r.amount) }); byDay.set(d, a); }
      raw.set(code, byDay);
    }
  };
  await Promise.all(Array.from({ length: 8 }, () => work()));
  const codes = [...raw.keys()].sort();
  const days = [...new Set(codes.flatMap((c) => [...(raw.get(c) as Map<number, Row[]>).keys()]))].sort((a, b) => a - b);
  const di = new Map(days.map((d, i) => [d, i]));
  const data = new Map<string, Map<number, Day>>(), rawIdx = new Map<string, Map<number, Row[]>>();
  for (const c of codes) {
    const m = new Map<number, Day>(), r2 = new Map<number, Row[]>();
    for (const [d, rows] of raw.get(c) as Map<number, Row[]>) {
      rows.sort((x, y) => x.hhmm - y.hhmm);
      const b: (Bar | undefined)[] = new Array(39).fill(undefined);
      for (const bar of barsOf(rows, 10)) b[bar.k] = bar as Bar;
      const idx = di.get(d) as number;
      m.set(idx, { rows, b, lastClose: rows[rows.length - 1].c }); r2.set(idx, rows);
    }
    data.set(c, m); rawIdx.set(c, r2);
  }
  return { codes, days, dayIso: days.map(iso), data, raw: rawIdx };
}

interface Univ { stocks: string[]; excluded: string[]; rates: { code: string; n: number; bad: number; rate: number }[]; bad: Set<string> }
/** 종목군 규칙(사전등록 §1): 분봉 마지막 행 종가 ≠ 일봉 종가 비율(일봉 대조 가능일 기준) ≥ 30%인 종목 전체 제외, 나머지는 불일치 종목-날짜만 제외. */
async function universeOf(m: Mkt, dataEnd: string): Promise<Univ> {
  const daily = await loadAllStockSeriesFromParquet(2025, 2026);
  const rates: Univ["rates"] = [], bad = new Set<string>(), excluded: string[] = [];
  for (const c of m.codes) {
    const dm = new Map((daily.get(c) ?? []).map((r) => [r.tradeDate, r.closePrice]));
    let n = 0, nb = 0;
    const badDays: number[] = [];
    for (const [d, D] of m.data.get(c) as Map<number, Day>) { const dc = dm.get(m.dayIso[d]); if (dc === undefined || m.dayIso[d] > dataEnd) continue; n++; if (D.lastClose !== dc) { nb++; badDays.push(d); } }
    const rate = n ? nb / n : 0;
    rates.push({ code: c, n, bad: nb, rate });
    if (rate >= P.mismatchRateExclude) excluded.push(c); else for (const d of badDays) bad.add(`${c}|${d}`);
  }
  return { stocks: m.codes.filter((c) => !excluded.includes(c)), excluded, rates, bad };
}

/** 종목별 편도 슬리피지(충격 + 반호가): 10분 정규 봉 평균 거래대금(표본 전체) 기준. */
function slipOf(m: Mkt, codes: string[]): Map<string, { slip: number; p: number; half: number }> {
  const out = new Map<string, { slip: number; p: number; half: number }>();
  for (const c of codes) {
    let sum = 0, n = 0;
    const prices: number[] = [];
    for (const D of (m.data.get(c) as Map<number, Day>).values()) { for (const b of D.b) if (b && !b.auction) { sum += b.val; n++; } prices.push(D.rows[Math.floor(D.rows.length / 2)].c); }
    const avgVal = sum / Math.max(n, 1), p = ID_ORDER_WON / avgVal, pm = median(prices), half = (0.5 * ID_TICK(pm)) / pm;
    let imp = ID_IMPACT_OVER;
    for (const [u, v] of ID_IMPACT_BINS) if (p <= u) { imp = v; break; }
    if (p > ID_PARTICIPATION_MAX) throw new Error(`${c} 주문 비중 ${p} > ${ID_PARTICIPATION_MAX} — 제외 규칙 대상`);
    out.set(c, { slip: imp + half, p, half });
  }
  return out;
}

const split = (n: number): { dTrainEnd: number; block: (d: number) => number } => ({ dTrainEnd: P.trainDays, block: (d) => Math.floor((d * P.blocks) / n) });

export async function intradayPre(h: Harness, label: (c: string) => string): Promise<void> {
  const r0 = io.readBytes;
  const m = await loadMkt();
  console.log(`\n=== [P0] 분봉 읽기: 종목 ${m.codes.length}, 거래일 ${m.days.length}일(${m.dayIso[0]}~${m.dayIso[m.dayIso.length - 1]}), 이번 실행 Storage 다운로드 ${mib(io.readBytes - r0)} MiB(캐시 적중이면 0) ===`);
  // 묶기 규칙 재현(설계안 수치)
  let reg10 = 0, miss10 = 0, reg60 = 0, miss60 = 0;
  const per10: number[] = [], per60: number[] = [];
  for (const c of m.codes) for (const D of (m.data.get(c) as Map<number, Day>).values()) {
    const b10 = barsOf(D.rows, 10), b60 = barsOf(D.rows, 60);
    reg10 += 38; miss10 += 38 - b10.filter((b) => !b.auction).length; reg60 += 7; miss60 += 7 - b60.length;
    per10.push(b10.length); per60.push(b60.length);
  }
  const ok10 = miss10 === P.designMiss10 && reg10 === P.designReg10, ok60 = miss60 === P.designMiss60 && reg60 === P.designReg60;
  console.log(`[P1] 묶기 규칙 재현(30종목): 10분 무거래 정규 봉 ${miss10}/${reg10}(설계안 ${P.designMiss10}/${P.designReg10}) ${ok10 ? "일치" : "불일치"}, 종목-날짜당 봉 수 중앙값 ${median(per10)}(설계안 39) | 60분 무거래 봉 ${miss60}/${reg60}(설계안 ${P.designMiss60}/${P.designReg60}) ${ok60 ? "일치" : "불일치"}, 중앙값 ${median(per60)}(설계안 7)`);
  if (!ok10 || !ok60 || median(per10) !== 39 || median(per60) !== 7) throw new Error("묶기 규칙 재현 불일치 — 중단하고 보고한다");
  const u = await universeOf(m, h.dataEnd);
  console.log(`[P2] 일봉 대조 불일치율(분봉 마지막 행 종가 ≠ 일봉 종가, ~${h.dataEnd}) 상위: ${[...u.rates].sort((a, b) => b.rate - a.rate).slice(0, 6).map((x) => `${label(x.code)} ${x.bad}/${x.n}(${f2(x.rate * 100)}%)`).join(", ")}`);
  console.log(`제외 규칙(불일치율 ≥ ${P.mismatchRateExclude * 100}%) 종목: ${u.excluded.map(label).join(", ")} → 남은 종목 ${u.stocks.length}개 | 나머지 종목 불일치 종목-날짜(제외) ${u.bad.size}건`);
  const want = [...P.excludeExpected].sort().join(",");
  if (u.excluded.slice().sort().join(",") !== want || u.stocks.length !== 27) throw new Error(`제외 종목 ${u.excluded.join(",")} ≠ 사전등록 ${want} — 중단하고 보고한다`);
  const sp = split(m.days.length);
  console.log(`[P3] 분할: 거래일 ${m.days.length}일 → 학습 ${sp.dTrainEnd}일(${m.dayIso[0]}~${m.dayIso[sp.dTrainEnd - 1]}), 검증 ${m.days.length - sp.dTrainEnd}일(${m.dayIso[sp.dTrainEnd]}~${m.dayIso[m.days.length - 1]}) | 월 블록(거래일 ${P.blocks}개 구간) 학습 블록 0~${sp.block(sp.dTrainEnd - 1)}, 검증 블록 ${sp.block(sp.dTrainEnd)}~${P.blocks - 1}`);
  if (m.days.length !== P.expectDays || sp.block(sp.dTrainEnd - 1) !== 7 || sp.block(sp.dTrainEnd) !== 8) throw new Error("거래일 수·블록 경계가 사전등록과 다르다 — 중단");
  const cs = slipOf(m, u.stocks);
  const rt = [...cs.values()].map((x) => (ID_FEE_PER_SIDE * 2 + 0.002 + 2 * x.slip) * 100);
  console.log(`[P4] 27종목 10분 왕복 비용(2026 매도세 0.20%) 최소 ${f2(Math.min(...rt))} 중앙값 ${f2(median(rt))} 최대 ${f2(Math.max(...rt))}% (설계안 30종목: 0.35~0.63, 중앙값 0.42)`);
  console.log(`\n사전 점검 통과(성과·신호 계산 없음) | 학습 마지막 거래일 ${m.dayIso[sp.dTrainEnd - 1]}, 검증 첫 거래일 ${m.dayIso[sp.dTrainEnd]}`);
}

// ---------------------------------------------------------------------------------------------------------------------------------
export async function intradayTest(h: Harness, label: (c: string) => string, bh: { dates: string[]; ret: number[] }, firstTrial: number): Promise<void> {
  const r0 = io.readBytes;
  const m = await loadMkt();
  const u = await universeOf(m, h.dataEnd);
  if (u.excluded.slice().sort().join(",") !== [...P.excludeExpected].sort().join(",") || u.stocks.length !== 27) throw new Error("종목군이 사전등록과 다르다 — 중단");
  const cs = slipOf(m, u.stocks), nD = m.days.length, sp = split(nD), D0 = 0, D1 = sp.dTrainEnd;
  console.log(`\n=== 분봉 시험 설정: 종목 ${u.stocks.length}개(제외 ${u.excluded.map(label).join(", ")}), 불일치 종목-날짜 제외 ${u.bad.size}건, 거래일 ${nD}일, 학습 ${D1}일(${m.dayIso[0]}~${m.dayIso[D1 - 1]}) / 검증 ${nD - D1}일(${m.dayIso[D1]}~${m.dayIso[nD - 1]}), 읽기 Storage ${mib(io.readBytes - r0)} MiB ===`);
  const dayOf = (c: string, d: number): Day | undefined => (u.bad.has(`${c}|${d}`) ? undefined : (m.data.get(c) as Map<number, Day>).get(d));
  // ---- 비용·체결 ----
  const evalPx = (c: string, d: number, entryP: number, exitP: number): { gross: number; net: number; noSlip: number } => {
    const s = (cs.get(c) as { slip: number }).slip, tax = getSecuritiesTaxRate(m.dayIso[d], "KR"), fee = ID_FEE_PER_SIDE;
    const buy = entryP * (1 + s) * (1 + fee), sell = exitP * (1 - s) * (1 - fee - tax);
    return { gross: exitP / entryP - 1, net: sell / buy - 1, noSlip: (exitP * (1 - fee - tax)) / (entryP * (1 + fee)) - 1 };
  };
  const mkTrade = (c: string, d: number, kSig: number, kE: number, kX: number, entryP: number, exitP: number): Trade => { const e = evalPx(c, d, entryP, exitP); return { code: c, d, kSig, kE, kX, entryP, exitP, gross: e.gross, net: e.net, noSlip: e.noSlip, holdMin: kX < 0 ? 390 - 10 * kE : 10 * (kX - kE) }; };
  const exitBarOpen = (D: Day, kX: number): { kUsed: number; p: number } => { for (let j = kX; j <= 38; j++) { const b = D.b[j]; if (b) return { kUsed: j, p: b.o }; } return { kUsed: -1, p: D.lastClose }; };

  // ---- H5 거래량 중앙값(직전 20거래일, 같은 봉 번호) ----
  const vol = new Map<string, Float64Array>();
  for (const c of u.stocks) {
    const a = new Float64Array(nD * 38).fill(Number.NaN);
    for (const [d, D] of m.data.get(c) as Map<number, Day>) { for (let k = 0; k < 38; k++) a[d * 38 + k] = 0; for (const b of D.b) if (b && !b.auction) a[d * 38 + b.k] = b.v; }
    vol.set(c, a);
  }
  const medCache = new Map<string, number>();
  const medOf = (c: string, d: number, k: number): number => {
    const key = `${c}|${d}|${k}`, hit = medCache.get(key);
    if (hit !== undefined) return hit;
    const a = vol.get(c) as Float64Array, v: number[] = [];
    for (let j = d - P.h5MedianDays; j < d; j++) if (j >= 0) { const x = a[j * 38 + k]; if (Number.isFinite(x)) v.push(x); }
    let r = Number.NaN;
    if (v.length >= P.h5MinValid) { v.sort((x, y) => x - y); r = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2; }
    medCache.set(key, r);
    return r;
  };

  // ---- 전략 ----
  interface H4p { frac: number; delay: number }
  interface H5p { mult: number; hold: number; delay: number }
  const runH4 = (d0: number, d1: number, o: H4p): Trade[] => {
    const out: Trade[] = [];
    for (let d = d0; d < d1; d++) {
      const cand: { code: string; sd: number }[] = [];
      for (const c of u.stocks) {
        const D = dayOf(c, d);
        if (!D) continue;
        let ok = true;
        for (let k = P.h4PoolFrom - 1; k < P.h4PoolTo; k++) if (!D.b[k]) { ok = false; break; }
        if (!ok) continue;
        const r: number[] = [];
        for (let k = P.h4PoolFrom; k < P.h4PoolTo; k++) r.push((D.b[k] as Bar).c / (D.b[k - 1] as Bar).c - 1);
        cand.push({ code: c, sd: sdOf(r) });
      }
      cand.sort((a, b) => a.sd - b.sd || (a.code < b.code ? -1 : 1));
      for (const { code } of cand.slice(0, Math.ceil(o.frac * cand.length))) {
        const D = dayOf(code, d) as Day;
        let mh = Number.NEGATIVE_INFINITY;
        for (let k = 0; k < P.h4SigFrom; k++) if (D.b[k]) mh = Math.max(mh, (D.b[k] as Bar).h);
        for (let k = P.h4SigFrom; k <= P.h4SigTo; k++) {
          const b = D.b[k];
          if (!b) continue;
          if (b.c > mh) {
            const kE = k + 1 + o.delay, eb = kE <= 37 ? D.b[kE] : undefined;
            if (eb) out.push(mkTrade(code, d, k, kE, -1, eb.o, D.lastClose));
            break;
          }
          mh = Math.max(mh, b.h);
        }
      }
    }
    return out;
  };
  const runH5 = (d0: number, d1: number, o: H5p): Trade[] => {
    const out: Trade[] = [];
    for (let d = d0; d < d1; d++) {
      const sigs: { code: string; k: number; ratio: number }[] = [];
      for (const c of u.stocks) {
        const D = dayOf(c, d);
        if (!D) continue;
        for (let k = 0; k <= P.h5EntryMax - o.hold - 1; k++) {
          const b = D.b[k];
          if (!b || !(b.c > b.o)) continue;
          const med = medOf(c, d, k);
          if (!(med > 0)) continue;
          if (b.v >= o.mult * med) sigs.push({ code: c, k, ratio: b.v / med });
        }
      }
      sigs.sort((a, b) => a.k - b.k || b.ratio - a.ratio || (a.code < b.code ? -1 : 1));
      const used = new Set<string>();
      let taken = 0;
      for (const s of sigs) {
        if (taken >= P.h5MaxPerDay) break;
        if (used.has(s.code)) continue;
        const D = dayOf(s.code, d) as Day, kE = s.k + 1 + o.delay, eb = kE <= 37 ? D.b[kE] : undefined;
        if (!eb) continue;
        const x = exitBarOpen(D, kE + o.hold);
        out.push(mkTrade(s.code, d, s.k, kE, x.kUsed, eb.o, x.p));
        used.add(s.code); taken++;
      }
    }
    return out;
  };
  // 무조건·무작위 대조용: 진입 봉 kE에서 같은 청산 구조로 들어갔을 때의 순수익(없으면 null)
  const netAtH4 = (c: string, d: number, kE: number): number | null => { const D = dayOf(c, d); const b = D && kE <= 37 ? D.b[kE] : undefined; return D && b ? evalPx(c, d, b.o, D.lastClose).net : null; };
  const netAtH5 = (c: string, d: number, kE: number, hold: number): number | null => { const D = dayOf(c, d); const b = D && kE <= 37 ? D.b[kE] : undefined; if (!D || !b) return null; return evalPx(c, d, b.o, exitBarOpen(D, kE + hold).p).net; };

  // ---- 통계 도구 ----
  const days = (t: Trade[], d0: number, d1: number): { cnt: number[]; sum: number[] } => { const cnt = new Array<number>(d1 - d0).fill(0), sum = new Array<number>(d1 - d0).fill(0); for (const x of t) { cnt[x.d - d0]++; sum[x.d - d0] += x.net * 100; } return { cnt, sum }; };
  const bootLB = (cnt: number[], sum: number[], seed: number): number => {
    const rng = mulberry32(seed), n = cnt.length, rs: number[] = [];
    for (let b = 0; b < P.bootN; b++) { let s = 0, c = 0; for (let i = 0; i < n; i++) { const j = Math.floor(rng() * n); s += sum[j]; c += cnt[j]; } rs.push(c > 0 ? s / c : 0); }
    rs.sort((a, b) => a - b);
    return rs[Math.floor(P.bootQ * P.bootN)];
  };
  const meanNet = (t: Trade[]): number => (t.length ? (t.reduce((a, x) => a + x.net, 0) / t.length) * 100 : Number.NaN);
  const acct = (t: Trade[], d0: number, d1: number): { ret: number[]; mdd: number; tot: number } => {
    const r = new Array<number>(d1 - d0).fill(0);
    for (const x of t) r[x.d - d0] += P.slotW * x.net;
    let v = 1, pk = 1, mdd = 0;
    for (const x of r) { v *= 1 + x; pk = Math.max(pk, v); mdd = Math.max(mdd, 1 - v / pk); }
    return { ret: r, mdd: mdd * 100, tot: (v - 1) * 100 };
  };
  // 069500 일수익(보조 파일 + 연구 DS6 포워드 로그)
  const b69 = new Map<string, number>();
  bh.dates.forEach((d, i) => b69.set(d, bh.ret[i]));
  const csv = await fs.readFile("docs/research/ds6-forward-log.csv", "utf8").catch(() => "");
  for (const line of csv.split("\n").slice(1)) { const p = line.split(","); if (p[0] && p[2] !== undefined && !b69.has(p[0])) b69.set(p[0], Number(p[2])); }
  const bench = (d0: number, d1: number): { mdd: number; tot: number } => { let v = 1, pk = 1, mdd = 0; for (let d = d0; d < d1; d++) { v *= 1 + (b69.get(m.dayIso[d]) ?? 0) / 100; pk = Math.max(pk, v); mdd = Math.max(mdd, 1 - v / pk); } return { mdd: mdd * 100, tot: (v - 1) * 100 }; };
  // 코스피 일 변동(극단 변동일)
  const kospi = await getIndexPriceSeries("KOSPI", "2025-10-01", m.dayIso[nD - 1]);
  const kChg = new Map<string, number>();
  for (let i = 1; i < kospi.length; i++) kChg.set(kospi[i].tradeDate, (kospi[i].closePrice / kospi[i - 1].closePrice - 1) * 100);
  const extreme = new Set(m.dayIso.filter((d) => Math.abs(kChg.get(d) ?? 0) >= P.extremeKospiPct));

  // ---- 독립 대조(거래 체결가를 원 1분 행 직접 스캔으로 재계산) ----
  const integrity = (t: Trade[]): number => {
    let bad = 0;
    for (const x of t) {
      const rows = (m.raw.get(x.code) as Map<number, Row[]>).get(x.d) as Row[];
      const first = (kk: number): Row | undefined => (kk >= 38 ? rows.find((r) => r.hhmm === ID_AUCTION_HHMM) : rows.find((r) => r.hhmm !== ID_AUCTION_HHMM && tmin(r.hhmm) >= 10 * kk && tmin(r.hhmm) < 10 * kk + 10));
      const e = first(x.kE);
      if (!e || e.o !== x.entryP) bad++;
      if (x.kX < 0) { if (rows[rows.length - 1].c !== x.exitP) bad++; } else { const xr = first(x.kX); if (!xr || xr.o !== x.exitP) bad++; }
      if (!(x.kE > x.kSig)) bad++;
    }
    return bad;
  };

  // ---- 관문 평가 ----
  interface Spec { id: string; trial: number; title: string; need: number; run: (d0: number, d1: number, delay: number, variant?: number) => Trade[]; neighbors: { label: string; variant: number }[]; netAt: (c: string, d: number, kE: number) => number | null; }
  const results: { id: string; trial: number; verdict: string }[] = [];
  const evaluate = (sp0: Spec): void => {
    const { id } = sp0;
    console.log(`\n##### ${id} (시험 ${sp0.trial}) — ${sp0.title} #####`);
    const tr = sp0.run(D0, D1, 0);
    const bad = integrity(tr);
    console.log(`[점검] 학습 거래 ${tr.length}건 체결가 독립 대조(원 1분 행 직접 스캔)·진입 시각 > 신호 봉 종료: 불일치 ${bad}건 ${bad === 0 ? "통과" : "실패"}`);
    if (bad) throw new Error(`${id} 거래 가격 독립 대조 실패 — 결과를 출력하지 않고 중단`);
    const mean = meanNet(tr), dd = days(tr, D0, D1), lbA = bootLB(dd.cnt, dd.sum, P.seed);
    const ac = acct(tr, D0, D1), bn = bench(D0, D1);
    const gates: { g: string; ok: boolean | null; note: string }[] = [];
    // A
    const aOk = mean >= P.aMeanMinPct && lbA > 0 && ac.mdd <= bn.mdd * P.aMddFrac;
    gates.push({ g: "A", ok: aOk, note: `순거래당 평균 ${sg(mean)}%(기준 ≥ +${P.aMeanMinPct}%, ${sg(mean - P.aMeanMinPct)}%p) | 부트스트랩 하한 ${sg(lbA)}%(기준 > 0) | 계좌 MDD ${f2(ac.mdd)}% vs 069500 같은 기간 MDD ${f2(bn.mdd)}%의 ${P.aMddFrac * 100}% = ${f2(bn.mdd * P.aMddFrac)}%` });
    // B
    const blk = new Array<number>(P.blocks).fill(1), blkN = new Array<number>(P.blocks).fill(0);
    for (let d = D0; d < D1; d++) { blk[sp.block(d)] *= 1 + ac.ret[d - D0]; blkN[sp.block(d)]++; }
    const posBlk = blk.slice(0, 8).filter((x) => x > 1).length;
    const half = (par: number): Trade[] => tr.filter((x) => u.stocks.indexOf(x.code) % 2 === par);
    const mEven = meanNet(half(0)), mOdd = meanNet(half(1));
    const bOk = posBlk >= P.bTrainBlocksMin && mEven > 0 && mOdd > 0;
    gates.push({ g: "B", ok: bOk, note: `학습 블록 수익률 > 0: ${posBlk}/8(기준 ≥ ${P.bTrainBlocksMin}) | 종목 교차 짝수 ${sg(mEven)}%(${half(0).length}건)·홀수 ${sg(mOdd)}%(${half(1).length}건)(둘 다 > 0)` });
    // C
    const trC = sp0.run(D0, D1, 1), mC = meanNet(trC);
    const cOk = mean - mC <= P.cDropMaxPp && mC > 0;
    gates.push({ g: "C", ok: cOk, note: `한 봉 지연 평균 ${sg(mC)}%(${trC.length}건), 하락 ${f2(mean - mC)}%p(기준 ≤ ${P.cDropMaxPp}%p, 평균 > 0)` });
    // D
    const dRes = sp0.neighbors.map((nb) => { const t = sp0.run(D0, D1, 0, nb.variant); return { l: nb.label, n: t.length, m: meanNet(t) }; });
    const dOk = dRes.every((x) => x.m > 0);
    gates.push({ g: "D", ok: dOk, note: dRes.map((x) => `${x.l} ${sg(x.m)}%(${x.n}건)`).join(" | ") + "(모두 > 0)" });
    // E
    const nTop = Math.max(P.eTopMin, Math.ceil(P.eTopFrac * tr.length)), sorted = [...tr].sort((a, b) => b.net - a.net), topSet = new Set(sorted.slice(0, nTop));
    const mE = tr.length ? (tr.reduce((a, x) => a + (topSet.has(x) ? 0 : x.net), 0) / tr.length) * 100 : Number.NaN;
    gates.push({ g: "E", ok: mE > 0, note: `상위 ${nTop}건(3%, 최소 ${P.eTopMin}) 0 대체 후 평균 ${sg(mE)}%(> 0)` });
    // F
    {
      const rng = mulberry32(P.seed), byDay = new Map<number, Trade[]>();
      for (const x of tr) { const a = byDay.get(x.d) ?? []; a.push(x); byDay.set(x.d, a); }
      const means: number[] = [];
      for (let r = 0; r < P.randN; r++) {
        let s = 0, n = 0;
        for (const [d, ts] of byDay) {
          const used = new Set<string>();
          for (const t of ts) {
            const pool = u.stocks.filter((c) => !used.has(c) && sp0.netAt(c, d, t.kE) !== null);
            if (!pool.length) continue;
            const c = pool[Math.floor(rng() * pool.length)];
            used.add(c); s += sp0.netAt(c, d, t.kE) as number; n++;
          }
        }
        means.push(n ? (s / n) * 100 : 0);
      }
      const pctl = (means.filter((x) => x < mean).length / means.length) * 100;
      means.sort((a, b) => a - b);
      gates.push({ g: "F", ok: pctl >= P.fMinPct, note: `무작위 ${P.randN}회: 중앙값 ${sg(means[Math.floor(means.length / 2)])}% 95분위 ${sg(means[Math.floor(means.length * 0.95)])}% 최대 ${sg(means[means.length - 1])}% | 가설 ${sg(mean)}% → 백분위 ${f2(pctl)}(기준 ≥ ${P.fMinPct}, ${sg(pctl - P.fMinPct)}p)` });
    }
    // G
    gates.push({ g: "G", ok: tr.length >= sp0.need ? true : null, note: `학습 진입 ${tr.length}건 vs 필요 ${sp0.need}건 → ${tr.length >= sp0.need ? "충족" : `검정력 부족(판정 보류, ${sp0.need - tr.length}건 부족)`}` });
    // H
    {
      const ctlCache = new Map<string, number>();
      const ctl = (c: string, kE: number): number => {
        const key = `${c}|${kE}`, hit = ctlCache.get(key);
        if (hit !== undefined) return hit;
        let s = 0, n = 0;
        for (let d = D0; d < D1; d++) { const x = sp0.netAt(c, d, kE); if (x !== null) { s += x; n++; } }
        const r = n ? (s / n) * 100 : Number.NaN;
        ctlCache.set(key, r);
        return r;
      };
      const cnt = new Array<number>(D1 - D0).fill(0), sm = new Array<number>(D1 - D0).fill(0);
      let tot = 0, n = 0;
      for (const x of tr) { const c = ctl(x.code, x.kE); if (!Number.isFinite(c)) continue; const df = x.net * 100 - c; cnt[x.d - D0]++; sm[x.d - D0] += df; tot += df; n++; }
      const mH = n ? tot / n : Number.NaN, lbH = bootLB(cnt, sm, P.seed);
      gates.push({ g: "H", ok: mH >= P.hMinPp && lbH > 0, note: `무조건 보유 대비 초과 평균 ${sg(mH)}%p(기준 ≥ +${P.hMinPp}%p, ${sg(mH - P.hMinPp)}%p) | 부트스트랩 하한 ${sg(lbH)}%p(> 0)` });
    }
    console.log(`| 관문 | 판정 | 내용 |\n|---|---|---|`);
    for (const g of gates) console.log(`| ${g.g} | ${g.ok === null ? "보류" : g.ok ? "O" : "X"} | ${g.note} |`);
    const failed = gates.filter((g) => g.ok === false).map((g) => g.g), power = gates.find((g) => g.g === "G")?.ok === null;
    // ---- R1~R8·정보용(학습) ----
    reportTrain(sp0, tr, D0, D1, ac, bn, blk, blkN, lbA);
    // ---- 검증 ----
    let verdict: string;
    if (failed.length) { verdict = `탈락(${failed.join(", ")})${power ? " · G 검정력 부족" : ""}`; console.log(`\n${id} 학습 관문 ${failed.join("·")} 미달 → **검증 구간은 열지 않았다.**`); }
    else {
      console.log(`\n${id} 학습 관문 A~F·H 통과${power ? "(G 검정력 부족: 판정 보류)" : ""} → **검증 구간을 한 번 연다.**`);
      const tv = sp0.run(D1, nD, 0), mv = meanNet(tv), acv = acct(tv, D1, nD), all = acct([...tr, ...tv], D0, nD);
      const blkAll = new Array<number>(P.blocks).fill(1);
      for (let d = D0; d < nD; d++) blkAll[sp.block(d)] *= 1 + all.ret[d - D0];
      const posAll = blkAll.filter((x) => x > 1).length, win = tv.filter((x) => x.net > 0).length;
      console.log(`검증: 거래 ${tv.length}건, 순거래당 평균 ${sg(mv)}%(학습 ${sg(mean)}%의 50% = ${sg(mean * P.valRatio)}%), 승률 ${f2((win / Math.max(tv.length, 1)) * 100)}%, 계좌 수익 ${sg(acv.tot)}%·MDD ${f2(acv.mdd)}% | 12블록 중 > 0: ${posAll}/12(기준 ≥ ${P.bAllBlocksMin}) | 블록별 %: ${blkAll.map((x, i) => `${i + 1}:${sg((x - 1) * 100)}`).join(" ")}`);
      const vOk = mv >= mean * P.valRatio && mv > 0 && posAll >= P.bAllBlocksMin;
      verdict = vOk ? (power ? "검정력 부족(판정 보류) — 학습·검증 기준은 통과" : "통과(표본 12개월, 극단 국면, 포워드 확인 필요)") : `탈락(검증: 평균 ${sg(mv)}% / 블록 ${posAll}/12)`;
      reportValidation(tv, D1, nD);
    }
    console.log(`\n**${id} 판정: ${verdict}**`);
    results.push({ id, trial: sp0.trial, verdict });
  };

  const reportTrain = (sp0: Spec, tr: Trade[], d0: number, d1: number, ac: { ret: number[]; mdd: number; tot: number }, bn: { mdd: number; tot: number }, blk: number[], blkN: number[], lbA: number): void => {
    const n = tr.length, wins = tr.filter((x) => x.net > 0), losses = tr.filter((x) => x.net <= 0);
    const pf = wins.reduce((a, x) => a + x.net, 0) / Math.max(-losses.reduce((a, x) => a + x.net, 0), 1e-12);
    console.log(`\n[R1~R3] 학습 거래 ${n}건(${d1 - d0}거래일), 순거래당 평균 ${sg(meanNet(tr))}%(부트스트랩 하한 ${sg(lbA)}%), 승률 ${f2((wins.length / Math.max(n, 1)) * 100)}%, 평균 이익 ${f2(avg(wins.map((x) => x.net * 100)))}% / 평균 손실 ${f2(avg(losses.map((x) => x.net * 100)))}%, 손익비 ${f2(pf)}, 계좌(종목당 1/30) 학습 수익 ${sg(ac.tot)}%·MDD ${f2(ac.mdd)}%`);
    console.log(`[R5] 월(거래일 블록) 순수익(계좌 %, 학습 8블록): ${blk.slice(0, 8).map((x, i) => `${i + 1}(${blkN[i]}일) ${sg((x - 1) * 100)}`).join(" | ")}`);
    const bySt = new Map<string, { n: number; c: number; s: number }>();
    for (const x of tr) { const e = bySt.get(x.code) ?? { n: 0, c: 0, s: 0 }; e.n++; e.c += P.slotW * x.net * 100; e.s += x.net * 100; bySt.set(x.code, e); }
    const arr = [...bySt.entries()].sort((a, b) => b[1].c - a[1].c);
    console.log(`[R6] 종목별 계좌 기여 합(%p, 상위 8 / 하위 5, 거래 수·평균 %): ${arr.slice(0, 8).map(([c, e]) => `${label(c)} ${sg(e.c)}(${e.n}건 ${sg(e.s / e.n)})`).join(", ")} | 하위: ${arr.slice(-5).map(([c, e]) => `${label(c)} ${sg(e.c)}(${e.n}건 ${sg(e.s / e.n)})`).join(", ")} | 거래한 종목 ${bySt.size}/27`);
    const perDay = new Map<number, number>();
    for (const x of tr) perDay.set(x.d, (perDay.get(x.d) ?? 0) + 1);
    console.log(`[R7] 하루 진입 수: 최대 ${Math.max(...perDay.values(), 0)}(상한 ${sp0.id === "H4" ? "풀 크기 6" : P.h5MaxPerDay}) 평균(거래일 전체 ${d1 - d0}일) ${f2(n / (d1 - d0))}, 진입한 날 ${perDay.size}일 | 평균 보유 시간 ${f2(avg(tr.map((x) => x.holdMin)))}분(중앙값 ${f2(median(tr.map((x) => x.holdMin)))})`);
    const top = [...tr].sort((a, b) => b.net - a.net), sumNet = tr.reduce((a, x) => a + x.net, 0), t10 = top.slice(0, 10).reduce((a, x) => a + x.net, 0), t3p = top.slice(0, Math.max(P.eTopMin, Math.ceil(P.eTopFrac * n))).reduce((a, x) => a + x.net, 0);
    console.log(`[R8] 상위 거래 편중: 상위 10건 순수익 합이 전체의 ${f2((t10 / sumNet) * 100)}%, 상위 3%(${Math.max(P.eTopMin, Math.ceil(P.eTopFrac * n))}건) ${f2((t3p / sumNet) * 100)}% | 상위 5: ${top.slice(0, 5).map((x) => `${label(x.code)} ${m.dayIso[x.d]} ${sg(x.net * 100)}%`).join(", ")} | 하위 3: ${top.slice(-3).map((x) => `${label(x.code)} ${m.dayIso[x.d]} ${sg(x.net * 100)}%`).join(", ")}`);
    // 정보용
    const unc = (() => { let s = 0, c = 0, g = 0; for (const x of tr) { const D = dayOf(x.code, x.d) as Day, o = D.b[0]?.o; if (!o) continue; const e = evalPx(x.code, x.d, o, D.lastClose); s += e.net; g += e.gross; c++; } return { net: (s / c) * 100, gross: (g / c) * 100 }; })();
    console.log(`[I1] 같은 종목-날짜를 종일 보유(시가 → 종가 단일가, 같은 비용)한 경우: 거래당 총수익 ${sg(unc.gross)}% / 순수익 ${sg(unc.net)}% vs 가설 거래 총수익 ${sg(avg(tr.map((x) => x.gross * 100)))}% / 순수익 ${sg(meanNet(tr))}%`);
    const gm = avg(tr.map((x) => x.gross * 100)), nm = meanNet(tr), nsm = avg(tr.map((x) => x.noSlip * 100));
    console.log(`[I2] 비용 전·후: 총수익 평균 ${sg(gm)}% → 순수익 평균 ${sg(nm)}% (총 비용 ${f2(gm - nm)}%p = 슬리피지 ${f2(nsm - nm)}%p + 수수료·매도세 ${f2(gm - nsm)}%p) | 슬리피지 제외(수수료·세금만) 순수익 평균 ${sg(nsm)}% | 총수익 기준 승률 ${f2((tr.filter((x) => x.gross > 0).length / Math.max(n, 1)) * 100)}%`);
    const byH = new Map<number, { n: number; s: number }>();
    for (const x of tr) { const hr = 9 + Math.floor((10 * x.kE) / 60), e = byH.get(hr) ?? { n: 0, s: 0 }; e.n++; e.s += x.net * 100; byH.set(hr, e); }
    console.log(`[I3] 진입 시각대별(시) 거래 수·순거래당 평균 %: ${[...byH.entries()].sort((a, b) => a[0] - b[0]).map(([hr, e]) => `${hr}시 ${e.n}건 ${sg(e.s / e.n)}`).join(" | ")}`);
    const exTr = tr.filter((x) => !extreme.has(m.dayIso[x.d]));
    console.log(`[I4] 극단 변동일(코스피 일 변동 ±${P.extremeKospiPct}% 이상) 학습 구간 ${m.dayIso.slice(d0, d1).filter((d) => extreme.has(d)).length}일 제외 시: 거래 ${exTr.length}건, 순거래당 평균 ${sg(meanNet(exTr))}%(제외 전 ${sg(meanNet(tr))}%) | 극단일 거래 ${n - exTr.length}건 평균 ${sg(meanNet(tr.filter((x) => extreme.has(m.dayIso[x.d]))))}%`);
    console.log(`[I5] 069500 같은 기간(학습 ${m.dayIso[d0]}~${m.dayIso[d1 - 1]}) 수익(참고) ${sg(bn.tot)}%·MDD ${f2(bn.mdd)}% | 가설 계좌(종목당 1/30, 노출 일부) ${sg(ac.tot)}%·MDD ${f2(ac.mdd)}%`);
  };
  const reportValidation = (tv: Trade[], d0: number, d1: number): void => {
    const ac = acct(tv, d0, d1), bn = bench(d0, d1), gm = avg(tv.map((x) => x.gross * 100)), exTr = tv.filter((x) => !extreme.has(m.dayIso[x.d]));
    console.log(`[검증 R1~R7] 거래 ${tv.length}건, 순거래당 평균 ${sg(meanNet(tv))}%, 총수익 평균 ${sg(gm)}%, 승률 ${f2((tv.filter((x) => x.net > 0).length / Math.max(tv.length, 1)) * 100)}%, 평균 보유 ${f2(avg(tv.map((x) => x.holdMin)))}분 | 극단일(±${P.extremeKospiPct}%) 제외 ${exTr.length}건 평균 ${sg(meanNet(exTr))}% | 계좌 ${sg(ac.tot)}%·MDD ${f2(ac.mdd)}% vs 069500 ${sg(bn.tot)}%·MDD ${f2(bn.mdd)}%(참고)`);
  };

  // ---- 시험 정의 ----
  evaluate({
    id: "H4", trial: firstTrial, title: "점심 저유동성 후 돌파(10분봉, 풀 = 11:30~13:00 변동성 하위 20%, 13:00~15:00 당일 고가 돌파 → 다음 봉 시가 진입, 종가 단일가 청산)", need: P.h4Need,
    run: (d0, d1, delay, variant) => runH4(d0, d1, { frac: variant !== undefined ? variant : P.h4Frac, delay }),
    neighbors: P.h4NbFrac.map((f) => ({ label: `풀 ${f * 100}%`, variant: f })), netAt: netAtH4,
  });
  evaluate({
    id: "H5", trial: firstTrial + 1, title: "시간대별 거래량 이상(10분봉, 거래량 ≥ 같은 봉 직전 20일 중앙값 × 3 ∧ 양봉 → 다음 봉 시가 진입, 진입 후 60분 시가 청산, 하루 최대 5건)", need: P.h5Need,
    run: (d0, d1, delay, variant) => {
      if (variant === undefined) return runH5(d0, d1, { mult: P.h5Mult, hold: P.h5Hold, delay });
      const nb = P.h5Nb[variant];
      return runH5(d0, d1, { mult: nb.mult ?? P.h5Mult, hold: nb.hold ?? P.h5Hold, delay });
    },
    neighbors: P.h5Nb.map((x, i) => ({ label: x.label, variant: i })), netAt: (c, d, kE) => netAtH5(c, d, kE, P.h5Hold),
  });
  console.log(`\n=== 요약 ===\n| 시험 | 판정 |\n|---|---|\n${results.map((r) => `| ${r.id} (${r.trial}) | ${r.verdict} |`).join("\n")}`);
  const cum = firstTrial + results.length - 1;
  console.log(`\n[I6] 누적 시험 ${cum}회(이번 ${results.length}건: ${results.map((r) => r.trial).join("·")}), 실력이 없어도 5% 기준 하나를 우연히 넘는 후보 기대 ${cum} × 0.05 = ${(cum * 0.05).toFixed(2)}건(근사). 정의는 시험 전에 고정했고 결과를 보고 바꾸지 않았다. 표본 12개월·극단 국면(코스피 4,089 → 8,476 → 5,100, 069500 +41.39%, 일 표준편차 3.97%)이라 결과의 일반화에 한계가 있다.`);
}
void iso;

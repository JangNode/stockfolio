/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 D·T: 거래대금·갭 신호 D1(242)·D3(243)·D5(244) + 추세 이탈 매매 T1(245)·T2(246)·T3(247). 후보당 1회 실행.
 * 사전 등록: docs/research/volume-gap-trend-prereg.md. 가격 Parquet은 고정 스냅샷(데이터 종료일 2026-10-26)에서만 읽고(시가·고가·저가는 종가와 같은 수정 계수), 069500 기준선은 보조 파일(BENCH_AUX_069500=1, SHA-256 대조),
 * D5의 외국인 순매수 금액은 Actions 캐시의 수급 부분집합(.research-flow, SHA-256 대조)만 읽는다. 월말 시장 목록은 Storage에서 읽는다(0.21 MiB). DB·Storage 쓰기 0.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { simSlots, type SimCand, type SimPos, type SimRun } from "@/lib/slotSim";
import { decodeTable } from "@/lib/nBookStore";
import { L_EVAL_AFTER } from "@/lib/megacapTrendConfig";
import { SAT_KSIC_DIVISION_NAMES, SAT_SECTOR_UNCLASSIFIED } from "@/lib/satelliteV1Config";
import { PEAD_DOWNTURNS, PEAD_H_CAGR_GAIN_PP, PEAD_H_MDD_GAIN_PP, PEAD_H_MDD_GAIN_STRONG_PP, PEAD_H_CAGR_FLOOR_PP } from "@/lib/peadConfig";
import { VGT_PRIOR_TESTS, VGT_MAX_POS, VGT_SLIPPAGE, VGT_D_COOLDOWN_DAYS, VGT_T_COOLDOWN_DAYS, VGT_VOL_WINDOW, VGT_STUDY, VGT_D_CANDS, VGT_T_COMMON, VGT_T_CANDS, VGT_F_DENOMINATOR, VGT_PE4_REF } from "@/lib/volumeGapTrendConfig";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, SNAP_END, f2, avg, median, type S } from "./researchHarness";
import { evaluate, seedReport, yearlyTable, summaryReport, makeWindows, type CandSpec, type Verdict } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
const SAMSUNG = "005930", HYNIX = "000660";
const HOLD_REASON = "보유 만료", EXIT_REASON = "이탈";
type DId = keyof typeof VGT_D_CANDS;
type TId = keyof typeof VGT_T_CANDS;
interface Episode { peakIdx: number; troughIdx: number; recIdx: number | null; depth: number }
interface DP { kind: "spike" | "gap"; volMult: number; retMin: number; clvMin: number; gapMin: number; maLen: number; hold: number; needFlow: boolean }
interface TP { ma: number; longMa: number; slope: number }
interface Pre { cumC: Float64Array; cumTv: Float64Array }
const EPS = 1e-12;
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

function episodes(ret: number[]): Episode[] {
  const out: Episode[] = [];
  let E = 1, peak = 1, peakIdx = -1, cur: Episode | null = null, trough = 1;
  for (let i = 0; i < ret.length; i++) {
    E *= 1 + ret[i] / 100;
    if (E >= peak) {
      if (cur) { cur.recIdx = i; out.push(cur); cur = null; }
      peak = E; peakIdx = i; trough = E;
    } else {
      if (!cur) { cur = { peakIdx, troughIdx: i, recIdx: null, depth: 0 }; trough = E; }
      if (E <= trough) { trough = E; cur.troughIdx = i; cur.depth = 1 - E / peak; }
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function main(): Promise<void> {
  console.log(`연구 D·T 시도 242~247 시험 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const only = new Set((process.env.CAND_ONLY || "D1,D3,D5,T1,T2,T3").split(",").map((x) => x.trim()).filter(Boolean));
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { kAt, indOf, nameOf } = await loadK200P(h);
  const cS = CAL.findIndex((d) => d >= L_EVAL_AFTER);
  if (cS < 0) throw new Error(`${L_EVAL_AFTER} 이후 거래일 없음`);
  const W = makeWindows(h, cS + 1);
  const FULL = W.FULL, ex26 = { from: FULL.from, to: "2025-12-31" };
  console.log(`평가 시작 판단일 ${CAL[cS]}(달력 순번 ${cS}), 수익률 집계 ${CAL[cS + 1]}~${h.dataEnd} | 구간 ${W.NW.map(([n, w]) => `${n} ${w.from}~${w.to}`).join(" / ")}`);

  // ---- 0. 069500 기준선 ----
  console.log(`\n=== 0. 069500 기준선 (수익 집계 ${FULL.from}~; 원주가, 가격 수익만; CAGR % / MDD %) ===\n기존 = etf_daily_prices만(${h.bhPDb.dates[h.bhPDb.dates.length - 1]}까지), 새 = 보조 파일(${h.bhP.dates[h.bhP.dates.length - 1]}까지) — 게이트 A~H는 새 기준선으로 판정\n| 구간 | 기존 | 새 |\n|---|---|---|`);
  for (const [wn, w] of [...W.ALL, ["2026년 제외 (~2025-12-31)", ex26] as [string, typeof ex26]]) {
    const a = h.st(h.bhPDb, w), b = h.st(h.bhP, w);
    console.log(`| ${wn} | ${f2(a.cagr)} / ${f2(a.mdd)} | ${f2(b.cagr)} / ${f2(b.mdd)} |`);
  }
  {
    const ii: number[] = [];
    for (let i = 0; i < h.bhP.dates.length; i++) if (h.bhP.dates[i] >= FULL.from) ii.push(i);
    const dts = ii.map((i) => h.bhP.dates[i]), eps = episodes(ii.map((i) => h.bhP.ret[i])).sort((x, y) => y.depth - x.depth).slice(0, 3);
    console.log(`새 기준선 낙폭 상위 3개: ${eps.map((e, k) => `${k + 1}) 고점 ${e.peakIdx < 0 ? FULL.from : dts[e.peakIdx]} → 저점 ${dts[e.troughIdx]} ${f2(e.depth * 100)}% → 회복 ${e.recIdx === null ? "미회복" : dts[e.recIdx]}`).join(" | ")}`);
  }
  const bhFrom = { dates: h.bhP.dates.filter((d) => d >= FULL.from), ret: h.bhP.ret.filter((_, k) => h.bhP.dates[k] >= FULL.from) };
  const bhAsRun = { dates: bhFrom.dates, ret: bhFrom.ret } as unknown as SimRun;

  // ---- 수급(외국인 순매수 금액) 부분집합: D5 전용 ----
  let flow: Map<string, number | null> | null = null;
  if (only.has("D5")) {
    const fb = await fs.readFile(path.join(VGT_STUDY.flowDir, VGT_STUDY.flowFile));
    const got = sha(fb);
    if (got !== VGT_STUDY.flowSha256) throw new Error(`수급 부분집합 SHA-256 불일치(${got.slice(0, 12)}… ≠ ${VGT_STUDY.flowSha256.slice(0, 12)}…)`);
    flow = new Map();
    for (const r of await decodeTable(fb.buffer.slice(fb.byteOffset, fb.byteOffset + fb.byteLength) as ArrayBuffer)) flow.set(`${r.stock_code}|${r.trade_date}`, r.frgn_ntby_amt === null || r.frgn_ntby_amt === undefined ? null : Number(r.frgn_ntby_amt));
    console.log(`수급 부분집합 SHA-256 대조 통과, ${flow.size}행 (Supabase 읽기 0)`);
  }

  // ---- 종목별 누적합(이동평균·평균 거래대금용) ----
  const preCache = new Map<string, Pre>();
  /** 거래대금 = 원 종가 × 거래량(모든 기간 통일; Parquet trading_value 열은 2015~2022 등에서 비어 있어 쓰지 않는다 — 정정 기록: prereg 13절). */
  const tvOf = (s: S, i: number): number => s.raw[i] * s.vol[i];
  const pre = (s: S): Pre => {
    let v = preCache.get(s.code);
    if (!v) {
      const n = s.close.length, cumC = new Float64Array(n + 1), cumTv = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) { cumC[i + 1] = cumC[i] + s.close[i]; cumTv[i + 1] = cumTv[i] + (tvOf(s, i) > 0 ? tvOf(s, i) : 0); }
      v = { cumC, cumTv };
      preCache.set(s.code, v);
    }
    return v;
  };
  /** i행 종가까지 L행(그 종목 행 기준) 단순이동평균, 행이 모자라면 NaN. */
  const maAt = (cum: Float64Array, i: number, L: number): number => (i + 1 >= L && i >= 0 ? (cum[i + 1] - cum[i + 1 - L]) / L : NaN);

  // ---- 신호 판정 ----
  /** 전일 행(i−1)이 달력상 바로 전 거래일이어야 한다(거래정지 등으로 행이 끊기면 신호 없음). */
  const prevOk = (s: S, i: number, c: number): boolean => i >= 1 && c >= 1 && s.dates[i - 1] === CAL[c - 1];
  /** D 계열 신호. 통과하면 거래대금 배수(우선순위 점수), 아니면 null. */
  const dSignal = (p: DP, s: S, i: number, c: number): number | null => {
    if (!prevOk(s, i, c) || !(s.vol[i] > 0) || i < VGT_VOL_WINDOW) return null;
    const pc = pre(s);
    const avgTv = (pc.cumTv[i] - pc.cumTv[i - VGT_VOL_WINDOW]) / VGT_VOL_WINDOW;
    if (!(avgTv > 0) || !(tvOf(s, i) > 0)) return null;
    const ratio = tvOf(s, i) / avgTv;
    if (!(ratio >= p.volMult - EPS)) return null;
    const m = maAt(pc.cumC, i, p.maLen);
    if (!(s.close[i] > m)) return null;
    const prev = s.close[i - 1];
    if (!(prev > 0)) return null;
    if (p.kind === "spike") {
      if (!(s.close[i] / prev - 1 >= p.retMin - EPS)) return null;
      const rng = s.high[i] - s.low[i];
      if (!(rng > 0) || !((s.close[i] - s.low[i]) / rng >= p.clvMin - EPS)) return null;
    } else {
      if (!(s.open[i] > 0) || !(s.open[i] / prev - 1 >= p.gapMin - EPS) || !(s.close[i] >= s.open[i])) return null;
    }
    return ratio;
  };
  const flowOf = (code: string, d: string): number | null | undefined => flow?.get(`${code}|${d}`);
  /** T 계열: 장기 우상향 조건(종가 > L일선 ∧ L일선 > slope행 전 L일선). */
  const tLong = (s: S, i: number, longMa: number, slope: number): boolean => {
    if (i < longMa + slope - 1) return false;
    const pc = pre(s), mL = maAt(pc.cumC, i, longMa), mL0 = maAt(pc.cumC, i - slope, longMa);
    return s.close[i] > mL && mL > mL0;
  };
  /** T 진입 신호(상향 돌파 ∧ 장기 우상향). 통과하면 직전 60행 수익률(우선순위 점수). crossOnly면 장기 조건을 보지 않는다(보고용). */
  const tSignal = (p: TP, s: S, i: number, c: number, crossOnly = false): number | null => {
    if (!prevOk(s, i, c) || !(s.vol[i] > 0) || i < VGT_T_COMMON.rankLookback || i < p.ma) return null;
    const pc = pre(s), mNow = maAt(pc.cumC, i, p.ma), mPrev = maAt(pc.cumC, i - 1, p.ma);
    if (!(s.close[i] > mNow) || !(s.close[i - 1] <= mPrev)) return null;
    if (!crossOnly && !tLong(s, i, p.longMa, p.slope)) return null;
    const base = s.close[i - VGT_T_COMMON.rankLookback];
    return base > 0 ? s.close[i] / base - 1 : null;
  };

  // ---- 후보 훅 ----
  const label = (code: string): string => `${code} ${nameOf.get(code) ?? "?"}`;
  const sectorOf = (c: string): string => indOf.get(c)?.slice(0, 2) ?? SAT_SECTOR_UNCLASSIFIED;
  const secLabel = (g: string): string => (g === SAT_SECTOR_UNCLASSIFIED ? g : `${g} ${SAT_KSIC_DIVISION_NAMES[g] ?? "?"}`);
  const poolCache = new Map<string, S[]>();
  const dHooks = (p: DP, exclude?: Set<string>) => ({
    candsOf: (c: number): SimCand[] => {
      const d = CAL[c], out: { s: S; sc: number }[] = [];
      for (const s of kAt(d)) {
        if (exclude?.has(s.code)) continue;
        const i = s.idx.get(d);
        if (i === undefined) continue;
        const sc = dSignal(p, s, i, c);
        if (sc === null) continue;
        if (p.needFlow) { const fv = flowOf(s.code, d); if (fv === undefined || fv === null || !(fv > 0)) continue; }
        out.push({ s, sc });
      }
      out.sort((a, b) => b.sc - a.sc || (a.s.code < b.s.code ? -1 : 1));
      return out.map((x) => ({ s: x.s, code: x.s.code }));
    },
    exitReason: (pos: SimPos, c: number): string | null => (c - pos.entryC >= p.hold ? HOLD_REASON : null),
  });
  const tHooks = (p: TP, exclude?: Set<string>) => ({
    candsOf: (c: number): SimCand[] => {
      const d = CAL[c], out: { s: S; sc: number }[] = [];
      for (const s of kAt(d)) {
        if (exclude?.has(s.code)) continue;
        const i = s.idx.get(d);
        if (i === undefined) continue;
        const sc = tSignal(p, s, i, c);
        if (sc === null) continue;
        out.push({ s, sc });
      }
      out.sort((a, b) => b.sc - a.sc || (a.s.code < b.s.code ? -1 : 1));
      return out.map((x) => ({ s: x.s, code: x.s.code }));
    },
    exitReason: (pos: SimPos, c: number, i: number | undefined): string | null => {
      if (i === undefined) return null;
      const m = maAt(pre(pos.s as unknown as S).cumC, i, p.ma);
      return pos.s.close[i] < m ? EXIT_REASON : null;
    },
  });
  const env = { CAL, nCal, cS, adjustments: h.adjustments, endedBefore: h.endedBefore, stockBuyMult: h.stockBuyMult, sellRate: h.sellRate, baseSlip: SLIPPAGE_PCT_PER_SIDE, bhRet: h.bhRet };
  const envGross = { ...env, baseSlip: 0, stockBuyMult: 1, sellRate: () => 0 };
  const cfgD = { slip: VGT_SLIPPAGE, maxPos: VGT_MAX_POS, capFrac: 1 / VGT_MAX_POS, cooldown: VGT_D_COOLDOWN_DAYS };
  const cfgT = { slip: VGT_SLIPPAGE, maxPos: VGT_MAX_POS, capFrac: 1 / VGT_MAX_POS, cooldown: VGT_T_COOLDOWN_DAYS };
  const cfgGross = (cfg: typeof cfgD): typeof cfgD => ({ ...cfg, slip: 0 });

  // ---- 공통 보고 보조 ----
  const hVs = (full: { cagr: number; mdd: number }, rb: { cagr: number; mdd: number }): { ok: boolean; text: string } => {
    const dc = full.cagr - rb.cagr, dm = rb.mdd - full.mdd;
    const c1 = dc >= PEAD_H_CAGR_GAIN_PP, c2 = dm >= PEAD_H_MDD_GAIN_PP && dc >= -PEAD_H_CAGR_FLOOR_PP;
    return { ok: c1 || c2, text: `CAGR ${dc >= 0 ? "+" : ""}${f2(dc)}%p, MDD ${dm >= 0 ? "−" : "+"}${f2(Math.abs(dm))}%p(개선 ${f2(dm)}%p; ${PEAD_H_MDD_GAIN_STRONG_PP}%p 이상 ${dm >= PEAD_H_MDD_GAIN_STRONG_PP ? "O" : "X"}) → 조건1(CAGR +${PEAD_H_CAGR_GAIN_PP}%p) ${c1 ? "O" : "X"}, 조건2(MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p) ${c2 ? "O" : "X"}` };
  };
  const inWin = (d: string, w: { from: string; to: string }): boolean => d >= w.from && d <= w.to;
  const pct = (a: number, b: number): string => f2((a / Math.max(b, 1)) * 100);
  const quant = (v: number[], ps: number[]): string => { const a = [...v].sort((x, y) => x - y); return ps.map((p) => `${Math.round(p * 100)}%=${a.length ? f2(a[Math.min(Math.floor(a.length * p), a.length - 1)]) : "-"}`).join(" / "); };
  // 시장(069500) 일수익률 분포 기준: 평가 구간 모든 거래일
  const mktAll: number[] = [];
  for (let c = cS + 1; c < nCal; c++) { const r = h.bhRet.get(CAL[c]); if (r !== undefined) mktAll.push(r * 100); }

  /** 후보 공통 보고(extra): 구간별 진입·보유·현금·회전율·비용, 낙폭, 하락 구간, 지연, 상위 거래 대체, 업종, 연도별 진입, 계좌 비중, 보유일수 분포, 신호일 시장 수익률 분포. */
  const commonExtra = (id: string, run: SimRun, rerun: (o: { lag: number; detail?: boolean; replace?: Set<string>; onDay?: (c: number, V: number, held: [string, number][]) => void }) => SimRun): void => {
    const E = (name: string, r: SimRun): void => { for (const [wn, w] of W.ALL) { const s = h.st(r, w), b = h.st(h.bhP, w); console.log(`  ${name} | ${wn}: CAGR ${f2(s.cagr)} / MDD ${f2(s.mdd)} (069500 ${f2(b.cagr)} / ${f2(b.mdd)})`); } };
    const yrs = (Date.parse(h.dataEnd) - Date.parse(FULL.from)) / 86_400_000 / 365.25;
    console.log(`${id} 구간별 진입·보유·현금·회전율·비용 (비용 합계 % = 구간 안 일별 비용 합)\n| 구간 | 진입 건수 | 평균 동시 보유(전체 날) | 보유 있는 날 평균 | 슬롯 10개 다 찬 날 % | 평균 투자 비중 % | 현금 비중 % | 현금 100% 일수 / 일수 | 연 회전율 % | 비용 합계 % |\n|---|---|---|---|---|---|---|---|---|---|`);
    for (const [wn, w] of W.ALL) {
      const idx: number[] = [];
      for (let i = 0; i < run.dates.length; i++) if (inWin(run.dates[i], w)) idx.push(i);
      const s = h.st(run, w), nPos = idx.map((i) => run.nPos[i]);
      console.log(`| ${wn} | ${run.entryCs.filter((c) => inWin(CAL[c], w)).length} | ${f2(avg(nPos))} | ${f2(avg(nPos.filter((x) => x > 0)))} | ${pct(nPos.filter((x) => x >= VGT_MAX_POS).length, nPos.length)} | ${f2(s.avgInv)} | ${f2(100 - s.avgInv)} | ${nPos.filter((x) => x === 0).length} / ${idx.length} | ${f2(s.turnover)} | ${f2(s.cost)} |`);
    }
    const fs0 = h.st(run, FULL);
    console.log(`${id} 합계 비용 ${f2(fs0.cost)}% (연평균 ${f2(fs0.cost / yrs)}%, ${f2(yrs)}년) | 연 회전율 ${f2(fs0.turnover)}%`);
    console.log(`${id} 낙폭 상위 3개 구간 (고점 → 저점 → 회복)`);
    const topEp = (ser: { dates: string[]; ret: number[] }, name: string): void => {
      const ii: number[] = [];
      for (let i = 0; i < ser.dates.length; i++) if (ser.dates[i] >= FULL.from) ii.push(i);
      const dts = ii.map((i) => ser.dates[i]), eps = episodes(ii.map((i) => ser.ret[i])).sort((a, b) => b.depth - a.depth).slice(0, 3);
      console.log(`  ${name}: ${eps.map((e, kk) => `${kk + 1}) 고점 ${e.peakIdx < 0 ? FULL.from : dts[e.peakIdx]} → 저점 ${dts[e.troughIdx]} ${f2(e.depth * 100)}% → 회복 ${e.recIdx === null ? "미회복" : dts[e.recIdx]}`).join(" | ")}`);
    };
    topEp(run, id); topEp(h.bhP, "069500(새)");
    console.log(`${id} 하락 구간 성과 (누적 % / MDD %): 후보 | 069500(새)`);
    for (const [name, f, t] of PEAD_DOWNTURNS) console.log(`  ${name}: ${id} ${h.periodStat(run, f, t)} | 069500 ${h.periodStat(h.bhP, f, t)}`);
    console.log(`${id} 하루 지연(lag 2) 구간별 성적`);
    E(`${id} lag 2`, rerun({ lag: 2, detail: true }));
    const top3 = [...run.trades].sort((a, b) => (b.proceeds - b.spend) / b.vAtEntry - (a.proceeds - a.spend) / a.vAtEntry).slice(0, 3);
    console.log(`${id} 상위 3개 거래(${top3.map((t) => `${label(t.code)} ${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")})를 069500 수익률로 바꾼 구간별 성적(= 제외)`);
    E(`${id} 상위 3개 거래 대체`, rerun({ lag: 1, detail: true, replace: new Set(top3.map((t) => `${t.code}|${t.entryC}`)) }));
    const secN = new Map<string, number>();
    for (const t of run.trades) secN.set(sectorOf(t.code), (secN.get(sectorOf(t.code)) ?? 0) + 1);
    console.log(`${id} 업종별(KSIC 2자리) 진입 분포(닫힌 거래 ${run.trades.length}건): ${[...secN].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([g, n]) => `${secLabel(g)} ${n}건(${pct(n, run.trades.length)}%)`).join(" | ")}`);
    const yearN = new Map<string, number>();
    for (const c of run.entryCs) yearN.set(CAL[c].slice(0, 4), (yearN.get(CAL[c].slice(0, 4)) ?? 0) + 1);
    console.log(`${id} 연도별 진입 건수: ${[...yearN].sort().map(([y, n]) => `${y} ${n}`).join(" | ")}`);
    const wsum = new Map<string, number>();
    let nDays = 0, invSum = 0;
    rerun({ lag: 1, onDay: (_c, V, held) => { nDays++; for (const [code, val] of held) { wsum.set(code, (wsum.get(code) ?? 0) + val / V); invSum += val / V; } } });
    const wavg = (code: string): number => ((wsum.get(code) ?? 0) / Math.max(nDays, 1)) * 100;
    console.log(`${id} 일별 평균 계좌 비중(현금 날 포함; ${nDays}일): 삼성전자 ${f2(wavg(SAMSUNG))}% · SK하이닉스 ${f2(wavg(HYNIX))}% · 합 ${f2(wavg(SAMSUNG) + wavg(HYNIX))}% | 투자분 중 두 종목 비중 ${f2(((wsum.get(SAMSUNG) ?? 0) + (wsum.get(HYNIX) ?? 0)) / Math.max(invSum, 1e-12) * 100)}% | 상위 8: ${[...wsum].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c2, v]) => `${label(c2)} ${f2((v / Math.max(nDays, 1)) * 100)}%`).join(", ")}`);
    // 상위 10개 거래 손익 비중
    const pnls = run.trades.map((t) => (t.proceeds - t.spend) / t.vAtEntry), totPnl = pnls.reduce((a, x) => a + x, 0), top10 = [...pnls].sort((a, b) => b - a).slice(0, 10).reduce((a, x) => a + x, 0);
    console.log(`${id} 상위 10개 거래 손익 비중: 전 거래 손익 합(진입 시 계좌 대비) ${f2(totPnl * 100)}%p 중 상위 10개 ${f2(top10 * 100)}%p = ${f2(totPnl !== 0 ? (top10 / totPnl) * 100 : NaN)}%`);
    // 보유일수 분포(체결일 기준 거래일 수)
    const hd = run.trades.map((t) => t.exitC - t.entryC), wins = run.trades.filter((t) => t.proceeds > t.spend).map((t) => t.exitC - t.entryC), loss = run.trades.filter((t) => t.proceeds <= t.spend).map((t) => t.exitC - t.entryC);
    console.log(`${id} 보유 거래일 수(체결 간격; 닫힌 거래 ${hd.length}건): 평균 ${f2(avg(hd))} / 중앙값 ${f2(median(hd))} / 이긴 거래 평균 ${f2(avg(wins))} / 진 거래 평균 ${f2(avg(loss))} | 분포 ${quant(hd, [0.05, 0.25, 0.5, 0.75, 0.95])} | 최대 ${hd.length ? Math.max(...hd) : "-"}`);
    // 신호일 시장 수익률 분포 (신호일 = 진입 체결일의 전 거래일 = 판단일)
    const sm: number[] = [];
    for (const c of run.entryCs) { const r = h.bhRet.get(CAL[c - 1]); if (r !== undefined) sm.push(r * 100); }
    console.log(`${id} 신호일 시장(069500) 일수익률 분포: 진입 ${sm.length}건 중 시장이 오른 날 ${sm.filter((x) => x > 0).length}건(${pct(sm.filter((x) => x > 0).length, sm.length)}%), +1% 이상 ${pct(sm.filter((x) => x >= 1).length, sm.length)}%, −1% 이하 ${pct(sm.filter((x) => x <= -1).length, sm.length)}% | 평균 ${f2(avg(sm))}% | 분위 ${quant(sm, [0.1, 0.25, 0.5, 0.75, 0.9])} | 비교 전체 거래일 ${mktAll.length}일: 오른 날 ${pct(mktAll.filter((x) => x > 0).length, mktAll.length)}%, +1% 이상 ${pct(mktAll.filter((x) => x >= 1).length, mktAll.length)}%, −1% 이하 ${pct(mktAll.filter((x) => x <= -1).length, mktAll.length)}%, 평균 ${f2(avg(mktAll))}%`);
  };

  // ---- 후보 명세 ----
  const specs: CandSpec[] = [];
  const runsOf = new Map<string, (o: { lag: number; detail?: boolean; replace?: Set<string>; onDay?: (c: number, V: number, held: [string, number][]) => void }) => SimRun>();
  const poolFor = (key: string, c: number, make: () => S[]): S[] => { const k = `${key}|${c}`; let v = poolCache.get(k); if (!v) { v = make(); poolCache.set(k, v); } return v; };

  const dBaseOf = (id: DId): DP => {
    const cd = VGT_D_CANDS[id];
    return { kind: cd.kind, volMult: cd.volMult, retMin: "retMin" in cd ? cd.retMin : 0, clvMin: "clvMin" in cd ? cd.clvMin : 0, gapMin: "gapMin" in cd ? cd.gapMin : 0, maLen: cd.maLen, hold: cd.hold, needFlow: cd.needFlow };
  };
  if (process.env.SIGNAL_COUNT_ONLY === "1") {
    // 정정 확인용(시험 아님): 연도별 신호 조건 통과 종목-일 수만 센다. 수익률·성과 계산 없음.
    const ids = (["D1", "D3", "D5"] as const).filter((x) => only.has(x));
    const cnt = new Map<string, Map<string, number>>();
    for (let c = cS; c < nCal - 1; c++) {
      const d = CAL[c], y = d.slice(0, 4);
      for (const s of kAt(d)) {
        const i = s.idx.get(d);
        if (i === undefined) continue;
        for (const id of ids) {
          const base = dBaseOf(id);
          if (dSignal(base, s, i, c) === null) continue;
          if (base.needFlow) { const fv = flowOf(s.code, d); if (fv === undefined || fv === null || !(fv > 0)) continue; }
          const m = cnt.get(y) ?? new Map<string, number>();
          m.set(id, (m.get(id) ?? 0) + 1);
          cnt.set(y, m);
        }
      }
    }
    console.log(`\n=== 정정 확인: 연도별 신호 조건 통과 종목-일 수 (슬롯·보유 규칙 적용 전, 성과 계산 없음) ===\n| 연도 | ${ids.join(" | ")} |\n|---|${ids.map(() => "---").join("|")}|`);
    for (const y of [...new Set(CAL.slice(cS).map((d) => d.slice(0, 4)))]) console.log(`| ${y} | ${ids.map((id) => cnt.get(y)?.get(id) ?? 0).join(" | ")} |`);
    console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 시도 번호 소진 없음`);
    return;
  }
  const mkD = (id: DId): CandSpec => {
    const cd = VGT_D_CANDS[id];
    const base = dBaseOf(id);
    const nb: { label: string; run: () => SimRun }[] = [];
    for (const v of cd.nbVolMult) nb.push({ label: `거래대금 배수 ≥ ${v}`, run: () => simSlots(env, cfgD, dHooks({ ...base, volMult: v }), { lag: 1 }) });
    if (cd.kind === "spike") for (const v of (cd as typeof VGT_D_CANDS.D1).nbRetMin) nb.push({ label: `당일 수익률 ≥ ${Math.round(v * 100)}%`, run: () => simSlots(env, cfgD, dHooks({ ...base, retMin: v }), { lag: 1 }) });
    else for (const v of (cd as typeof VGT_D_CANDS.D3).nbGapMin) nb.push({ label: `시가 갭 ≥ ${v * 100}%`, run: () => simSlots(env, cfgD, dHooks({ ...base, gapMin: v }), { lag: 1 }) });
    for (const v of cd.nbHold) nb.push({ label: `보유 N = ${v}`, run: () => simSlots(env, cfgD, dHooks({ ...base, hold: v }), { lag: 1 }) });
    const run1 = (o: { lag: number; int?: number; replace?: Set<string>; detail?: boolean; exclude?: Set<string>; onDay?: (c: number, V: number, held: [string, number][]) => void }): SimRun => simSlots(env, cfgD, dHooks(base, o.exclude), { lag: o.lag, int: o.int, replace: o.replace, detail: o.detail, onDay: o.onDay });
    runsOf.set(id, (o) => run1(o));
    const desc = cd.kind === "spike" ? `당일 거래대금 ≥ 직전 ${VGT_VOL_WINDOW}거래일 평균 × ${cd.volMult}, 당일 수익률 ≥ +${cd.retMin * 100}%, 종가 위치 ≥ ${cd.clvMin}, 종가 > ${cd.maLen}일선${cd.needFlow ? ", 당일 외국인 순매수 금액 > 0" : ""}` : `시가 갭 ≥ +${cd.gapMin * 100}%, 종가 ≥ 시가, 당일 거래대금 ≥ 직전 ${VGT_VOL_WINDOW}거래일 평균 × ${cd.volMult}, 종가 > ${cd.maLen}일선`;
    return {
      id, trial: cd.trial, title: `K200P, ${desc}, 신호 확정일 종가 → 다음 거래일 종가 체결, ${cd.hold}거래일 보유 후 다음 거래일 종가 매도, 슬롯 10 × 10%, 재진입 금지 ${VGT_D_COOLDOWN_DAYS}거래일, 슬리피지 ${VGT_SLIPPAGE * 100}%`,
      defense: false, capFrac: 1 / VGT_MAX_POS, fDenominator: VGT_F_DENOMINATOR, ref: { id: "069500", run: bhAsRun },
      hRule: (full, rb) => { const a = hVs(full, rb); return { ok: a.ok, note: `${a.text} | 참고(판정 아님): PE4 ${VGT_PE4_REF.full}` }; },
      run: (o) => run1(o),
      neighbors: nb,
      random: (rng, ordersByDay) => simSlots(env, cfgD, {
        candsOf: (c, held, blocked) => {
          const n = ordersByDay.get(c) ?? 0;
          if (!n) return [];
          const pool = poolFor(`D|${base.maLen}`, c, () => kAt(CAL[c]).filter((s) => { const i = s.idx.get(CAL[c]); return i !== undefined && s.vol[i] > 0 && s.close[i] > maAt(pre(s).cumC, i, base.maLen); })).filter((s) => !held(s.code) && !blocked(s.code));
          const left = [...pool], out: SimCand[] = [];
          while (out.length < n && left.length) { const s = left.splice(Math.floor(rng() * left.length), 1)[0]; out.push({ s, code: s.code }); }
          return out;
        },
        exitReason: dHooks(base).exitReason,
      }, { lag: 1 }),
      reasons: [HOLD_REASON, "폐지"],
      label,
      extra: (run) => {
        commonExtra(id, run, (o) => run1(o));
        // 신호 통계: 조건별 통과 수, D5는 수급 결측으로 신호 불가였던 건수
        let nCond = 0, nMiss = 0, nPos = 0, nNonPos = 0;
        for (let c = cS; c < nCal - 1; c++) {
          const d = CAL[c];
          for (const s of kAt(d)) {
            const i = s.idx.get(d);
            if (i === undefined || dSignal(base, s, i, c) === null) continue;
            nCond++;
            if (base.needFlow) { const fv = flowOf(s.code, d); if (fv === undefined || fv === null) nMiss++; else if (fv > 0) nPos++; else nNonPos++; }
          }
        }
        console.log(`${id} 신호 조건(수급 조건 제외) 통과 종목-일 ${nCond}건${base.needFlow ? ` | 외국인 순매수 금액 > 0 ${nPos}건, ≤ 0 ${nNonPos}건, 수급 데이터 없음(결측)으로 신호 불가 ${nMiss}건(${pct(nMiss, nCond)}%)` : ""}`);
      },
    };
  };

  const mkT = (id: TId): CandSpec => {
    const tc = VGT_T_CANDS[id], base: TP = { ma: tc.ma, longMa: VGT_T_COMMON.longMa, slope: VGT_T_COMMON.slope };
    const nb: { label: string; run: () => SimRun }[] = [];
    for (const v of tc.nbMa) nb.push({ label: `이동평균 M = ${v}`, run: () => simSlots(env, cfgT, tHooks({ ...base, ma: v }), { lag: 1 }) });
    for (const v of VGT_T_COMMON.nbLongMa) nb.push({ label: `장기 이동평균 ${v}일`, run: () => simSlots(env, cfgT, tHooks({ ...base, longMa: v }), { lag: 1 }) });
    for (const v of VGT_T_COMMON.nbSlope) nb.push({ label: `기울기 판정 ${v}거래일`, run: () => simSlots(env, cfgT, tHooks({ ...base, slope: v }), { lag: 1 }) });
    const run1 = (o: { lag: number; int?: number; replace?: Set<string>; detail?: boolean; exclude?: Set<string>; onDay?: (c: number, V: number, held: [string, number][]) => void }): SimRun => simSlots(env, cfgT, tHooks(base, o.exclude), { lag: o.lag, int: o.int, replace: o.replace, detail: o.detail, onDay: o.onDay });
    runsOf.set(id, (o) => run1(o));
    return {
      id, trial: tc.trial, title: `K200P, 장기 우상향(종가 > ${base.longMa}일선 ∧ ${base.longMa}일선이 ${base.slope}거래일 전보다 높음)에서 종가가 ${base.ma}일선을 상향 돌파(전일 ≤, 당일 >)한 날 신호 → 다음 거래일 종가 체결, 보유 중 종가 < ${base.ma}일선이면 다음 거래일 종가 매도, 슬롯 10 × 10%, 순위 = 직전 ${VGT_T_COMMON.rankLookback}거래일 수익률, 슬리피지 ${VGT_SLIPPAGE * 100}%`,
      defense: false, capFrac: 1 / VGT_MAX_POS, fDenominator: VGT_F_DENOMINATOR, ref: { id: "069500", run: bhAsRun },
      hRule: (full, rb) => { const a = hVs(full, rb); return { ok: a.ok, note: `${a.text} | 참고(판정 아님): PE4 ${VGT_PE4_REF.full}` }; },
      run: (o) => run1(o),
      neighbors: nb,
      random: (rng, ordersByDay) => simSlots(env, cfgT, {
        candsOf: (c, held, blocked) => {
          const n = ordersByDay.get(c) ?? 0;
          if (!n) return [];
          const pool = poolFor(`T|${base.longMa}|${base.slope}`, c, () => kAt(CAL[c]).filter((s) => { const i = s.idx.get(CAL[c]); return i !== undefined && s.vol[i] > 0 && tLong(s, i, base.longMa, base.slope); })).filter((s) => !held(s.code) && !blocked(s.code));
          const left = [...pool], out: SimCand[] = [];
          while (out.length < n && left.length) { const s = left.splice(Math.floor(rng() * left.length), 1)[0]; out.push({ s, code: s.code }); }
          return out;
        },
        exitReason: tHooks(base).exitReason,
      }, { lag: 1 }),
      reasons: [EXIT_REASON, "폐지"],
      label,
      extra: (run) => {
        commonExtra(id, run, (o) => run1(o));
        // 거래 통계
        const rets = run.trades.map((t) => (t.proceeds / t.spend - 1) * 100), w = rets.filter((x) => x > 0), l = rets.filter((x) => x <= 0);
        console.log(`${id} 거래당 통계(닫힌 거래 ${rets.length}건): 평균 수익 ${f2(avg(rets))}% / 중앙값 ${f2(median(rets))}% | 승률 ${pct(w.length, rets.length)}% | 평균 이익 ${f2(avg(w))}% / 평균 손실 ${f2(avg(l))}% → 손익비 ${f2(Math.abs(avg(w) / avg(l)))}`);
        // 비용 제외(gross) 대비 순수익(net)
        const gross = simSlots(envGross, cfgGross(cfgT), tHooks(base), { lag: 1, detail: true });
        console.log(`${id} 비용 제외 총수익(gross: 수수료·거래세·슬리피지 0) 대비 순수익(net) — CAGR % / MDD %\n| 구간 | gross | net | CAGR 차이 %p | net 구간 비용 합계 % |\n|---|---|---|---|---|`);
        for (const [wn, wd] of W.ALL) { const g = h.st(gross, wd), n = h.st(run, wd); console.log(`| ${wn} | ${f2(g.cagr)} / ${f2(g.mdd)} | ${f2(n.cagr)} / ${f2(n.mdd)} | ${f2(g.cagr - n.cagr)} | ${f2(n.cost)} |`); }
        // 청산 사유
        const rs = new Map<string, number>();
        for (const t of run.trades) rs.set(t.reason, (rs.get(t.reason) ?? 0) + 1);
        console.log(`${id} 청산 사유별 건수: ${[...rs].map(([k, v]) => `${k} ${v}건(${pct(v, run.trades.length)}%)`).join(" | ")} | 기간 끝 보유 중 ${run.entryCs.length - run.trades.length}건`);
        // 장기 조건 때문에 신호가 불가했던 날의 현금 비중
        const dayIdx = new Map(run.dates.map((d, i) => [d, i]));
        let nA = 0, nB = 0, nC = 0, cashA = 0, cashB = 0, cashC = 0;
        for (let c = cS + 1; c < nCal - 1; c++) {
          const d = CAL[c];
          let anyCross = 0, okCross = 0;
          for (const s of kAt(d)) {
            const i = s.idx.get(d);
            if (i === undefined) continue;
            if (tSignal(base, s, i, c, true) === null) continue;
            anyCross++;
            if (tLong(s, i, base.longMa, base.slope)) okCross++;
          }
          const k = dayIdx.get(d);
          if (k === undefined) continue;
          const cash = 1 - run.inv[k];
          if (okCross > 0) { nA++; cashA += cash; } else if (anyCross > 0) { nB++; cashB += cash; } else { nC++; cashC += cash; }
        }
        console.log(`${id} 신호일 구분(상향 돌파 종목 수 기준): 장기 조건 통과 돌파 있음 ${nA}일(평균 현금 ${f2((cashA / Math.max(nA, 1)) * 100)}%) | 돌파는 있었으나 모두 장기 조건 불충족 = 신호 불가 ${nB}일(${pct(nB, nA + nB + nC)}%; 평균 현금 ${f2((cashB / Math.max(nB, 1)) * 100)}%) | 돌파 자체가 없음 ${nC}일(평균 현금 ${f2((cashC / Math.max(nC, 1)) * 100)}%)`);
        // 시장 하락기 이탈·청산
        console.log(`${id} 시장 하락 구간의 진입·이탈(청산 체결일 기준) 건수\n| 구간 | 진입 | 이탈 청산 | 폐지 청산 | 평균 동시 보유 | 구간 말 보유 종목 수 |\n|---|---|---|---|---|---|`);
        for (const [name, f, t] of PEAD_DOWNTURNS) {
          const wd = { from: f, to: t };
          const idx: number[] = [];
          for (let i = 0; i < run.dates.length; i++) if (inWin(run.dates[i], wd)) idx.push(i);
          const exits = run.trades.filter((tr) => inWin(CAL[tr.exitC], wd));
          console.log(`| ${name} | ${run.entryCs.filter((c) => inWin(CAL[c], wd)).length} | ${exits.filter((tr) => tr.reason === EXIT_REASON).length} | ${exits.filter((tr) => tr.reason === "폐지").length} | ${f2(avg(idx.map((i) => run.nPos[i])))} | ${idx.length ? run.nPos[idx[idx.length - 1]] : "-"} |`);
        }
      },
    };
  };

  const order: (DId | TId)[] = (["D1", "D3", "D5", "T1", "T2", "T3"] as const).filter((id) => only.has(id));
  const verdicts: Verdict[] = [];
  for (const id of order) { const sp = id.startsWith("D") ? mkD(id as DId) : mkT(id as TId); specs.push(sp); verdicts.push(evaluate(h, W, sp)); }
  console.log(`\n=== 구간별 CAGR / MDD — 069500(새 기준선) · PE4(참고, 기록값) · 후보 ===\n| 구간 | 069500 | PE4(참고) | ${verdicts.map((v) => v.id).join(" | ")} |\n|---|---|---|${verdicts.map(() => "---").join("|")}|`);
  const pe4Cell: Record<string, string> = { "학습": VGT_PE4_REF.train, "확인": VGT_PE4_REF.confirm, "보류": VGT_PE4_REF.hold, "평가": VGT_PE4_REF.full };
  for (const [wn, w] of [...W.ALL, ["2026년 제외 (~2025-12-31)", ex26] as [string, typeof ex26]]) {
    const cell = (r: { dates: string[]; ret: number[] }): string => { const s = h.st(r, w); return `${f2(s.cagr)} / ${f2(s.mdd)}`; };
    const pe4 = pe4Cell[wn.slice(0, 2)] ?? "-";
    console.log(`| ${wn} | ${cell(h.bhP)} | ${wn.startsWith("학습") ? "(구간 불일치) " + pe4 : pe4} | ${verdicts.map((v) => cell(v.run)).join(" | ")} |`);
  }
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: VGT_PRIOR_TESTS });
  yearlyTable(h, W, verdicts.map((v) => ({ id: v.id, run: v.run })));
  seedReport(h, W, specs, new Map(verdicts.map((v) => [v.id, v.run])), (code, c) => { const s = byCode.get(code)!, i = s.idx.get(CAL[c]); return i === undefined ? NaN : s.avgTvRow[i]; });
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${verdicts.map((v) => v.trial).join(", ")}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

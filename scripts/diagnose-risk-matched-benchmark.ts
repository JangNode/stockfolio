/**
 * [임시 연구 진단 — 시험 아님, 번호 소진 없음, 병합 금지, 읽기 전용, 외부 요청 0건, Supabase 접속 없음] 위험 수준을 맞춘 069500 대비 성과 비교.
 * 문서: docs/research/risk-matched-benchmark-diagnostic.md. 입력은 기존 캐시뿐이다: 구성요소 일별 순수익(Actions 캐시 research-alloc-returns-40627267099, 해시 대조),
 * PE4 분해(research-capital-recycling-split-41359098160, 해시 대조), 069500 보조 파일(SHA-256 대조). 전략을 다시 시뮬레이션하지 않는다.
 * P1~P3·Q1~Q3의 일별 계열은 저장돼 있지 않아 연구 ALLOC·CAPREC와 같은 합성 규칙으로 구성요소 계열에서 다시 조립하고, 이전 보고의 CAGR / MDD와 같은지 확인한다(다르면 중단).
 * 게이트·통과 판정에 쓰지 않는다.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { computeCumulativeAndMdd, computeCagrPct } from "@/lib/strategyBacktestSummary";
import { ETF_TRADING_DAYS_PER_YEAR } from "@/lib/etfAllocationConfig";
import { BENCH_AUX_FILE, BENCH_AUX_SHA256, BENCH_AUX_END } from "@/lib/benchmarkAuxConfig";
import { ALLOC_SERIES_SHA, ALLOC_REBAL_COST, ALLOC_CANDS } from "@/lib/strategyAllocationConfig";
import { CAPREC_PE4_SPLIT_SHA, CAPREC_MOVE_COST, CAPREC_CANDS, CAPREC_COMP_CUT_REF } from "@/lib/capitalRecyclingConfig";
import { RMD_WINDOWS_2017, RMD_WINDOWS_2014, RMD_COMBO_REF, RMD_BENCH_REF, RMD_DOWN_DAY, RMD_UP_DAY, RMD_REGIME_SMA, RMD_K_ITER, type RmdWin } from "@/lib/riskMatchedDiagnosticConfig";

const sha = (b: Uint8Array | Buffer | string): string => createHash("sha256").update(b).digest("hex");
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : "-");
const D = ETF_TRADING_DAYS_PER_YEAR;
type Ser = { dates: string[]; ret: number[] }; // ret = 일수익률 %
const REF_DIR = process.env.RMD_REF_DIR?.trim() || ".alloc-returns";
const SPLIT_DIR = process.env.RMD_SPLIT_DIR?.trim() || ".capr-returns";
const COMPS = ["PE4", "W3", "LV1", "L3"] as const;
type CId = (typeof COMPS)[number];

// ---------------- 통계 ----------------
const sub = (s: Ser, w: RmdWin): Ser => { const d: string[] = [], r: number[] = []; for (let i = 0; i < s.dates.length; i++) if (s.dates[i] >= w.from && s.dates[i] <= w.to) { d.push(s.dates[i]); r.push(s.ret[i]); } return { dates: d, ret: r }; };
const capEnd = (w: RmdWin): string => (w.to > BENCH_AUX_END ? BENCH_AUX_END : w.to);
const cagrOf = (r: number[], w: RmdWin): number => computeCagrPct(computeCumulativeAndMdd(r).totalReturnPct, w.from, capEnd(w));
const mddOf = (r: number[]): number => computeCumulativeAndMdd(r).mddPct;
const sdOf = (r: number[]): number => { const m = r.reduce((a, x) => a + x, 0) / Math.max(r.length, 1); return Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(r.length - 1, 1)); };
const volAnn = (r: number[]): number => sdOf(r) * Math.sqrt(D);
const downAnn = (r: number[]): number => Math.sqrt(r.reduce((a, x) => a + Math.min(x, 0) ** 2, 0) / Math.max(r.length, 1)) * Math.sqrt(D);
const scale = (r: number[], k: number): number[] => r.map((x) => x * k);
/** 벤치마크 일수익률 × k (나머지는 현금, 수익 0). MDD가 목표와 같아지는 k(0<k≤1). 069500 자체 MDD가 목표보다 작거나 같으면 k = 1. */
function kForMdd(bench: number[], target: number): number {
  if (mddOf(bench) <= target) return 1;
  let lo = 0, hi = 1;
  for (let i = 0; i < RMD_K_ITER; i++) { const m = (lo + hi) / 2; if (mddOf(scale(bench, m)) > target) hi = m; else lo = m; }
  return (lo + hi) / 2;
}
const kForVol = (bench: number[], target: number): number => Math.min(1, target / volAnn(bench));
function worst12(s: Ser, w: RmdWin, monthEnds: string[]): number {
  const val = new Map<string, number>();
  let V = 1;
  for (let i = 0; i < s.dates.length; i++) { V *= 1 + s.ret[i] / 100; val.set(s.dates[i], V); }
  const wTo = capEnd(w);
  const before = s.dates.filter((d) => d < w.from);
  const anchors = [before.length ? before[before.length - 1] : s.dates[0], ...monthEnds.filter((d) => d >= w.from && d <= wTo && val.has(d))];
  let m = Infinity;
  for (let i = 0; i + 12 < anchors.length; i++) m = Math.min(m, (val.get(anchors[i + 12])! / val.get(anchors[i])! - 1) * 100);
  return m;
}
/** 최대 낙폭 구간: 고점 날짜, 저점 날짜, 회복 날짜(이전 고점 회복), 고점→회복·저점→회복 달력일. */
function mddEpisode(s: Ser): { depth: number; peak: string; trough: string; rec: string | null; peakToRec: number | null; troughToRec: number | null; sinceTrough: number } {
  let E = 1, peak = 1, peakIdx = -1, bestDepth = 0, bPeak = -1, bTrough = -1;
  for (let i = 0; i < s.ret.length; i++) {
    E *= 1 + s.ret[i] / 100;
    if (E >= peak) { peak = E; peakIdx = i; } else if (1 - E / peak > bestDepth) { bestDepth = 1 - E / peak; bPeak = peakIdx; bTrough = i; }
  }
  const startD = s.dates[0], day = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
  const peakD = bPeak < 0 ? startD : s.dates[bPeak];
  let Eq = 1, peakE = 1;
  const eq: number[] = [];
  for (let i = 0; i < s.ret.length; i++) { Eq *= 1 + s.ret[i] / 100; eq.push(Eq); }
  peakE = bPeak < 0 ? 1 : eq[bPeak];
  let rec: string | null = null;
  for (let i = bTrough + 1; i < s.ret.length; i++) if (eq[i] >= peakE) { rec = s.dates[i]; break; }
  const last = s.dates[s.dates.length - 1];
  return { depth: bestDepth * 100, peak: peakD, trough: s.dates[bTrough], rec, peakToRec: rec ? day(peakD, rec) : null, troughToRec: rec ? day(s.dates[bTrough], rec) : null, sinceTrough: day(s.dates[bTrough], last) };
}
function ols(x: number[], y: number[]): { beta: number; alphaAnn: number; r2: number; n: number } {
  const n = x.length;
  if (n < 3) return { beta: NaN, alphaAnn: NaN, r2: NaN, n };
  const mx = x.reduce((a, v) => a + v, 0) / n, my = y.reduce((a, v) => a + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  const beta = sxy / sxx, alpha = my - beta * mx;
  return { beta, alphaAnn: alpha * D, r2: syy > 0 ? (sxy * sxy) / (sxx * syy) : NaN, n };
}

// ---------------- 합성 규칙(연구 ALLOC·CAPREC와 같은 코드) ----------------
function combineP(parts: { ret: number[]; w: number }[], rate: number): number[] {
  const nDays = parts[0].ret.length, k = parts.length, s = parts.map((p) => p.w), pending = parts.map(() => 0), out: number[] = [];
  for (let i = 0; i < nDays; i++) {
    const Vprev = s.reduce((a, x) => a + x, 0);
    for (let j = 0; j < k; j++) s[j] *= 1 + parts[j].ret[i] / 100;
    let mv = 0;
    if (pending.some((x) => x !== 0)) {
      for (let j = 0; j < k; j++) { s[j] += pending[j]; if (pending[j] > 0) mv += pending[j]; }
      const cs = rate * mv;
      if (mv > 0) for (let j = 0; j < k; j++) if (pending[j] > 0) s[j] -= (cs * pending[j]) / mv;
    }
    const V = s.reduce((a, x) => a + x, 0);
    out.push((V / Vprev - 1) * 100);
    for (let j = 0; j < k; j++) pending[j] = parts[j].w * V - s[j];
  }
  return out;
}
interface Pe { f: number[]; rHold: number[]; costFrac: number[] }
function combineQ(pe: Pe, core: number[][], W: number, rate: number): number[] {
  const nDays = pe.f.length, m = core.length, out: number[] = [];
  let Sp = 0;
  const Sk = core.map(() => 1 / m);
  let pend = core.map(() => 0);
  for (let i = 0; i < nDays; i++) {
    const Vprev = Sp + Sk.reduce((a, x) => a + x, 0), N = W * Vprev;
    Sp = Sp * (1 + pe.rHold[i]) - N * pe.costFrac[i];
    for (let j = 0; j < m; j++) Sk[j] *= 1 + core[j][i] / 100;
    let mv1 = 0;
    if (pend.some((x) => x !== 0)) for (let j = 0; j < m; j++) { Sk[j] += pend[j]; if (pend[j] > 0) mv1 += pend[j]; }
    const Vpre = Sp + Sk.reduce((a, x) => a + x, 0);
    const target = W * pe.f[i] * Vpre, dp = target - Sp, Ct = Vpre - Sp;
    for (let j = 0; j < m; j++) Sk[j] -= (dp * Sk[j]) / Ct;
    Sp = target;
    const kappa = (rate * (mv1 + Math.abs(dp))) / Vpre;
    Sp *= 1 - kappa;
    for (let j = 0; j < m; j++) Sk[j] *= 1 - kappa;
    const V = Vpre * (1 - kappa);
    out.push((V / Vprev - 1) * 100);
    const Cn = Sk.reduce((a, x) => a + x, 0);
    pend = Sk.map((x) => Cn / m - x);
  }
  return out;
}

async function main(): Promise<void> {
  console.log(`연구 진단(위험 수준을 맞춘 069500 대비 성과, 시험 아님·번호 소진 없음) 시작: ${new Date().toISOString()}`);
  // ---- 입력: 069500 보조 파일 ----
  const auxBuf = await fs.readFile(BENCH_AUX_FILE);
  if (sha(auxBuf) !== BENCH_AUX_SHA256) throw new Error("069500 보조 파일 SHA-256 불일치");
  const aux = JSON.parse(auxBuf.toString("utf8")) as { rows: [string, number, number][] };
  const px = aux.rows.filter((r) => r[0] <= BENCH_AUX_END).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const bRet = new Map<string, number>(), bPx = new Map<string, number>();
  px.forEach((r, i) => { bPx.set(r[0], r[1]); if (i > 0) bRet.set(r[0], (r[1] / px[i - 1][1] - 1) * 100); });
  // 강세장 판정: 전일 종가가 전일까지 200거래일 단순이동평균 위
  const bull = new Map<string, boolean>();
  for (let i = RMD_REGIME_SMA; i < px.length; i++) { let t = 0; for (let j = i - RMD_REGIME_SMA; j < i; j++) t += px[j][1]; bull.set(px[i][0], px[i - 1][1] > t / RMD_REGIME_SMA); }
  console.log(`069500 보조 파일 SHA-256 일치(${BENCH_AUX_SHA256.slice(0, 12)}…), ${px.length}행 ${px[0][0]}~${px[px.length - 1][0]}`);

  // ---- 입력: 구성요소 일별 순수익(캐시) ----
  const loadJson = async (dir: string, name: string, want: string): Promise<Buffer> => {
    const b = await fs.readFile(path.join(dir, name));
    if (sha(b) !== want) throw new Error(`${dir}/${name} SHA-256 불일치`);
    return b;
  };
  if (!ALLOC_SERIES_SHA) throw new Error("ALLOC 일별 순수익 해시가 설정에 없다");
  const orig = new Map<CId, Ser>();
  for (const id of COMPS) { const j = JSON.parse((await loadJson(REF_DIR, `${id}.json`, ALLOC_SERIES_SHA[id])).toString("utf8")) as { dates: string[]; ret: number[] }; orig.set(id, { dates: j.dates, ret: j.ret }); }
  const split = JSON.parse((await loadJson(SPLIT_DIR, "PE4_split.json", CAPREC_PE4_SPLIT_SHA)).toString("utf8")) as { dates: string[]; f: number[]; rHold: number[]; costFrac: number[]; ret: number[] };
  console.log(`구성요소 일별 순수익 4개(${REF_DIR}) 해시 대조 통과 | PE4 분해(${SPLIT_DIR}) 해시 대조 통과 | Supabase·Storage 접속 0`);

  const FROM17 = RMD_WINDOWS_2017[0][1].from;
  const cut = (s: Ser): Ser => sub(s, { from: FROM17, to: "9999-12-31" });
  const comp17 = new Map<CId, Ser>(COMPS.map((id) => [id, cut(orig.get(id)!)]));
  const dates = split.dates;
  for (const [id, s] of comp17) if (s.dates.length !== dates.length || s.dates.some((d, i) => d !== dates[i])) throw new Error(`${id} 날짜가 PE4 분해와 다르다`);
  const monthEnds: string[] = [];
  for (let i = 0; i + 1 < dates.length; i++) if (dates[i].slice(0, 7) !== dates[i + 1].slice(0, 7)) monthEnds.push(dates[i]);
  const monthEnds14: string[] = [];
  { const d14 = orig.get("W3")!.dates; for (let i = 0; i + 1 < d14.length; i++) if (d14[i].slice(0, 7) !== d14[i + 1].slice(0, 7)) monthEnds14.push(d14[i]); }

  // ---- 합성 재조립 + 재현 확인 ----
  const ret17 = (id: CId): number[] => comp17.get(id)!.ret;
  const series = new Map<string, Ser>();
  for (const id of COMPS) series.set(id, comp17.get(id)!);
  const pe: Pe = { f: split.f, rHold: split.rHold, costFrac: split.costFrac };
  for (const [pid, cd] of Object.entries(ALLOC_CANDS)) series.set(pid, { dates, ret: combineP(Object.entries(cd.weights).map(([id, w]) => ({ ret: ret17(id as CId), w: w as number })), ALLOC_REBAL_COST) });
  for (const [qid, cd] of Object.entries(CAPREC_CANDS)) series.set(qid, { dates, ret: combineQ(pe, cd.core.map((id) => ret17(id as CId)), cd.w, CAPREC_MOVE_COST) });
  console.log(`\n=== 재현 확인 (평가 구간 전체 ${FROM17}~, CAGR % / MDD %; 이전 보고와 소수 둘째 자리까지 같아야 한다) ===\n| 대상 | 이번 | 이전 보고 | 일치 |\n|---|---|---|---|`);
  const bad: string[] = [];
  const full17 = RMD_WINDOWS_2017[0][1];
  for (const id of COMPS) {
    const s = series.get(id)!, c = cagrOf(s.ret, full17), m = mddOf(s.ret), r = CAPREC_COMP_CUT_REF[id], ok = f2(c) === f2(r.cagr) && f2(m) === f2(r.mdd);
    if (!ok) bad.push(id);
    console.log(`| ${id} | ${f2(c)} / ${f2(m)} | ${f2(r.cagr)} / ${f2(r.mdd)} | ${ok ? "일치" : "불일치"} |`);
  }
  for (const [id, r] of Object.entries(RMD_COMBO_REF)) {
    const s = series.get(id)!, c = cagrOf(s.ret, full17), m = mddOf(s.ret), ok = f2(c) === f2(r.cagr) && f2(m) === f2(r.mdd);
    if (!ok) bad.push(id);
    console.log(`| ${id} | ${f2(c)} / ${f2(m)} | ${f2(r.cagr)} / ${f2(r.mdd)} | ${ok ? "일치" : "불일치"} |`);
  }
  // 069500 정렬
  const alignB = (s: Ser): number[] => s.dates.map((d) => { const r = bRet.get(d); if (r === undefined) throw new Error(`069500 일수익률 없음 ${d}`); return r; });
  const b17: Ser = { dates, ret: alignB({ dates, ret: [] }) };
  { const c = cagrOf(b17.ret, full17), m = mddOf(b17.ret), ok = f2(c) === f2(RMD_BENCH_REF.cagr) && f2(m) === f2(RMD_BENCH_REF.mdd); if (!ok) bad.push("069500");
    console.log(`| 069500 | ${f2(c)} / ${f2(m)} | ${f2(RMD_BENCH_REF.cagr)} / ${f2(RMD_BENCH_REF.mdd)} | ${ok ? "일치" : "불일치"} |`); }
  if (bad.length) throw new Error(`재현 불일치(${bad.join(", ")}) — 중단하고 보고한다`);

  // ---- 보고 ----
  const NAMES = ["PE4", "W3", "LV1", "L3", "P1", "P2", "P3", "Q1", "Q2", "Q3"];
  const riskTable = (title: string, S: Map<string, Ser>, B: Ser, wins: [string, RmdWin][], names: string[]): void => {
    for (const [wn, w] of wins) {
      const b = sub(B, w);
      console.log(`\n${title} — ${wn} (${b.dates[0]}~${b.dates[b.dates.length - 1]}, ${b.dates.length}일) 069500: CAGR ${f2(cagrOf(b.ret, w))} / MDD ${f2(mddOf(b.ret))} / 변동성 ${f2(volAnn(b.ret))}\n| 전략 | CAGR / MDD / 변동성 | MDD 일치 k | 기준선 CAGR | 전략 − 기준선 (%p) | 변동성 일치 k | 기준선 CAGR | 전략 − 기준선 (%p) |\n|---|---|---|---|---|---|---|---|`);
      for (const id of names) {
        const s = sub(S.get(id)!, w), c = cagrOf(s.ret, w), m = mddOf(s.ret), v = volAnn(s.ret);
        const k1 = kForMdd(b.ret, m), c1 = cagrOf(scale(b.ret, k1), w), k2 = kForVol(b.ret, v), c2 = cagrOf(scale(b.ret, k2), w);
        console.log(`| ${id} | ${f2(c)} / ${f2(m)} / ${f2(v)} | ${f3(k1)}${k1 >= 1 ? " (상한)" : ""} | ${f2(c1)} | ${c - c1 >= 0 ? "+" : ""}${f2(c - c1)} | ${f3(k2)}${k2 >= 1 ? " (상한)" : ""} | ${f2(c2)} | ${c - c2 >= 0 ? "+" : ""}${f2(c - c2)} |`);
      }
    }
  };
  console.log(`\n##### 2. 위험 일치 069500 기준선 (공통 구간 ${FROM17}~). 기준선 = 069500 일수익률 × k + 현금(수익 0)인 가상 계좌, k는 각 구간 안에서 맞춘다. "상한" = 전략의 MDD(변동성)가 069500보다 커서 k = 1(위험 일치 불가, 069500 100%와 비교) #####`);
  riskTable("2", series, b17, RMD_WINDOWS_2017, NAMES);

  const metricRow = (id: string, s: Ser, w: RmdWin, me: string[]): string => {
    const x = sub(s, w), c = cagrOf(x.ret, w), m = mddOf(x.ret), v = volAnn(x.ret), dd = downAnn(x.ret), ep = mddEpisode(x), w12 = worst12(s, w, me);
    const rec = ep.rec ? `${ep.peak}→${ep.trough}→${ep.rec} (고점→회복 ${ep.peakToRec}일, 저점→회복 ${ep.troughToRec}일)` : `${ep.peak}→${ep.trough}→미회복 (저점 후 ${ep.sinceTrough}일 경과)`;
    return `| ${id} | ${f2(c)} | ${f2(m)} | ${f2(c / m)} | ${f2(v)} | ${f2(c / v)} | ${f2(dd)} | ${f2(c / dd)} | ${f2(w12)} | ${rec} |`;
  };
  const metricHdr = "| 대상 | CAGR | MDD | Calmar (CAGR/MDD) | 변동성 | CAGR/변동성 | 하방 변동성 | CAGR/하방 변동성 | 최악 12개월 % | 최대 낙폭 구간 고점→저점→회복 |\n|---|---|---|---|---|---|---|---|---|---|";
  console.log(`\n##### 3. 추가 지표 (참고) #####`);
  for (const [wn, w] of RMD_WINDOWS_2017) {
    console.log(`\n3 — ${wn}\n${metricHdr}\n${metricRow("069500", b17, w, monthEnds)}`);
    for (const id of NAMES) console.log(metricRow(id, series.get(id)!, w, monthEnds));
  }

  // ---- 4. 069500 회귀 ----
  const regHdr = "| 대상 | 전체 β | 전체 α(연환산 %p) | 전체 R² | 하락일 β | 하락일 α | 하락일 R² | 하락 포착률 | 상승일 β | 상승일 α | 상승일 R² | 상승 포착률 |\n|---|---|---|---|---|---|---|---|---|---|---|---|";
  const regRows = (S: Map<string, Ser>, B: Ser, names: string[], w: RmdWin): { rows: string[]; reg: string[]; n: string } => {
    const bb = sub(B, w);
    const dIdx: number[] = [], uIdx: number[] = [], bu: number[] = [], be: number[] = [];
    bb.ret.forEach((r, i) => { if (r / 100 <= RMD_DOWN_DAY) dIdx.push(i); if (r / 100 >= RMD_UP_DAY) uIdx.push(i); const g = bull.get(bb.dates[i]); if (g === true) bu.push(i); else if (g === false) be.push(i); });
    const pick = (a: number[], idx: number[]): number[] => idx.map((i) => a[i] / 100);
    const rows: string[] = [], reg: string[] = [];
    for (const id of names) {
      const y = sub(S.get(id)!, w).ret, x = bb.ret;
      const all = ols(pick(x, x.map((_, i) => i)), pick(y, y.map((_, i) => i))), dn = ols(pick(x, dIdx), pick(y, dIdx)), up = ols(pick(x, uIdx), pick(y, uIdx));
      const cap = (idx: number[]): number => idx.length ? y.filter((_, i) => idx.includes(i)).reduce((a, v) => a + v, 0) / idx.reduce((a, i) => a + x[i], 0) : NaN;
      rows.push(`| ${id} | ${f2(all.beta)} | ${f2(all.alphaAnn * 100)} | ${f2(all.r2)} | ${f2(dn.beta)} | ${f2(dn.alphaAnn * 100)} | ${f2(dn.r2)} | ${f2(cap(dIdx))} | ${f2(up.beta)} | ${f2(up.alphaAnn * 100)} | ${f2(up.r2)} | ${f2(cap(uIdx))} |`);
      const bl = ols(pick(x, bu), pick(y, bu)), br = ols(pick(x, be), pick(y, be));
      reg.push(`| ${id} | ${f2(bl.beta)} | ${f2(bl.alphaAnn * 100)} | ${f2(bl.r2)} | ${f2(br.beta)} | ${f2(br.alphaAnn * 100)} | ${f2(br.r2)} |`);
    }
    return { rows, reg, n: `전체 ${bb.ret.length}일 | 하락일(069500 ≤ ${RMD_DOWN_DAY * 100}%) ${dIdx.length}일 | 상승일(≥ +${RMD_UP_DAY * 100}%) ${uIdx.length}일 | 강세장(전일 종가 > 200일선) ${bu.length}일 | 약세장 ${be.length}일` };
  };
  console.log(`\n##### 4. 069500 대비 일별 회귀 (평가 구간 전체; 전략 일수익률 = α + β × 069500 일수익률, α는 일 α × ${D} 연환산, %p; 하락/상승 포착률 = 해당 일 전략 평균 수익 ÷ 069500 평균 수익) #####`);
  { const r = regRows(series, b17, NAMES, full17); console.log(`표본: ${r.n}\n${regHdr}\n${r.rows.join("\n")}\n\n강세장/약세장 구분 회귀 (강세장 = 전일 종가가 전일까지 ${RMD_REGIME_SMA}거래일 단순이동평균 위)\n| 대상 | 강세장 β | 강세장 α(연환산 %p) | 강세장 R² | 약세장 β | 약세장 α | 약세장 R² |\n|---|---|---|---|---|---|---|\n${r.reg.join("\n")}`); }

  // ---- W3 2014 기준 (별도) ----
  const w3: Ser = orig.get("W3")!, b14: Ser = { dates: w3.dates, ret: alignB(w3) };
  const S14 = new Map<string, Ser>([["W3(2014~)", w3]]);
  console.log(`\n##### W3 원래 평가 시작(2014-01-02~) 기준 (별도; ${w3.dates[0]}~${w3.dates[w3.dates.length - 1]} ${w3.dates.length}일). M3(WFR 규칙)는 일별 순수익이 캐시에 없어 포함하지 않았다 #####`);
  riskTable("W3 2014", S14, b14, RMD_WINDOWS_2014, ["W3(2014~)"]);
  console.log(`\n3 — W3 2014 기준 추가 지표\n${metricHdr}`);
  for (const [wn, w] of RMD_WINDOWS_2014) { console.log(`(${wn})`); console.log(metricRow("069500", b14, w, monthEnds14)); console.log(metricRow("W3(2014~)", w3, w, monthEnds14)); }
  { const r = regRows(S14, b14, ["W3(2014~)"], RMD_WINDOWS_2014[0][1]); console.log(`\n4 — W3 2014 기준 회귀 (표본: ${r.n})\n${regHdr}\n${r.rows.join("\n")}\n강세장/약세장\n| 대상 | 강세장 β | 강세장 α | 강세장 R² | 약세장 β | 약세장 α | 약세장 R² |\n|---|---|---|---|---|---|---|\n${r.reg.join("\n")}`); }
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행 0 | Storage 읽기 0 MiB | Supabase 쓴 행 0 | 외부 요청 0 | 시도 번호 소진 없음`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

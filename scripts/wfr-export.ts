/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 WFR(시도 248~250) 1단계: K200P 종목-일 특성·라벨을 이진 파일(.wfr/)로 내보낸다(성과 계산 없음).
 * 입력: 고정 스냅샷 + 069500 보조 파일 + 수급 부분집합 캐시(외국인 순매수 금액만). 월말 시장 목록(Storage 0.21 MiB)을 읽는다. DB·Storage 쓰기 0.
 * 사전 등록: docs/research/walkforward-ranker-prereg.md. 특성은 모두 종가 d까지의 자료로만 계산하고(라벨만 d+1 이후 가격), 횡단면 순위 정규화한다.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { decodeTable } from "@/lib/nBookStore";
import { VGT_STUDY } from "@/lib/volumeGapTrendConfig";
import { WFR_TRAIN_FROM, WFR_EVAL_FROM, WFR_FIRST_PRED_YEAR, WFR_PRICE_FEATURES, WFR_FLOW_FEATURES, WFR_FLOW_MIN_RATIO, WFR_FLOW_WINDOWS, WFR_H52_ROWS, WFR_H52_MIN_ROWS, WFR_TV_WINDOW, WFR_SECTOR_MIN_MEMBERS, WFR_CANDS, WFR_LGB_PARAMS, WFR_NB_SEEDS, WFR_SHUFFLE_SEED } from "@/lib/walkforwardRankerConfig";
import { loadHarness, loadK200P, verifySnapshotManifest, storageLine, SNAP_END, f2, type S } from "./researchHarness";

const OUT = process.env.WFR_DIR?.trim() || ".wfr";
const NP = WFR_PRICE_FEATURES.length, NF = WFR_FLOW_FEATURES.length, NFEAT = NP + NF;
const HORIZONS = [...new Set(Object.values(WFR_CANDS).map((c) => c.horizon))];
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const tvOf = (s: S, i: number): number => s.raw[i] * s.vol[i];

/** 값이 있는 것만 평균 순위(동률 평균)로 [0,1]에 매핑한다. 1개뿐이면 0.5, 결측은 NaN 그대로. */
function rankNorm(v: Float64Array | number[]): Float64Array {
  const n = v.length, out = new Float64Array(n).fill(NaN);
  const ix: number[] = [];
  for (let k = 0; k < n; k++) if (Number.isFinite(v[k])) ix.push(k);
  if (ix.length === 1) { out[ix[0]] = 0.5; return out; }
  ix.sort((a, b) => v[a] - v[b]);
  for (let a = 0; a < ix.length;) {
    let b = a;
    while (b + 1 < ix.length && v[ix[b + 1]] === v[ix[a]]) b++;
    const r = (a + b) / 2; // 0-based 평균 순위
    for (let k = a; k <= b; k++) out[ix[k]] = r / (ix.length - 1);
    a = b + 1;
  }
  return out;
}

async function main(): Promise<void> {
  console.log(`WFR 특성·라벨 내보내기 시작: ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const h = await loadHarness();
  const { CAL, nCal } = h;
  const { kAt, indOf } = await loadK200P(h);

  // ---- 수급(외국인 순매수 금액) ----
  const fb = await fs.readFile(path.join(VGT_STUDY.flowDir, VGT_STUDY.flowFile));
  if (sha(fb) !== VGT_STUDY.flowSha256) throw new Error("수급 부분집합 SHA-256 불일치");
  const flow = new Map<string, number | null>();
  for (const r of await decodeTable(fb.buffer.slice(fb.byteOffset, fb.byteOffset + fb.byteLength) as ArrayBuffer)) flow.set(`${r.stock_code}|${r.trade_date}`, r.frgn_ntby_amt === null || r.frgn_ntby_amt === undefined ? null : Number(r.frgn_ntby_amt));
  console.log(`수급 부분집합 SHA-256 대조 통과, ${flow.size}행 (Supabase 읽기 0)`);

  const c0 = CAL.findIndex((d) => d >= WFR_TRAIN_FROM), cEval = CAL.findIndex((d) => d >= WFR_EVAL_FROM);
  if (c0 < 0 || cEval < 0) throw new Error("학습·평가 시작 거래일 없음");
  console.log(`학습 시작 ${CAL[c0]}(달력 순번 ${c0}), 평가 첫 판단일 ${CAL[cEval]}(순번 ${cEval}), 데이터 끝 ${CAL[nCal - 1]}(순번 ${nCal - 1})`);

  // 069500 가격 지수(원주가, 가격 수익): 시장 대비 상대수익률 특성용
  const P = new Float64Array(nCal);
  P[0] = 1;
  for (let c = 1; c < nCal; c++) P[c] = P[c - 1] * (1 + (h.bhRet.get(CAL[c]) ?? 0));
  const mktRet = (c: number, k: number): number => (c >= k ? P[c] / P[c - k] - 1 : NaN);

  // 종목별 누적합: 종가(이동평균), 거래대금(종가×거래량)
  const cumCache = new Map<string, { cumC: Float64Array; cumTv: Float64Array }>();
  const cum = (s: S): { cumC: Float64Array; cumTv: Float64Array } => {
    let v = cumCache.get(s.code);
    if (!v) {
      const n = s.close.length, cumC = new Float64Array(n + 1), cumTv = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) { cumC[i + 1] = cumC[i] + s.close[i]; const t = tvOf(s, i); cumTv[i + 1] = cumTv[i] + (t > 0 ? t : 0); }
      v = { cumC, cumTv };
      cumCache.set(s.code, v);
    }
    return v;
  };
  const stockIndex = new Map(h.stocks.map((s, k) => [s.code, k]));

  // ---- 행 구성: c0 ~ 끝, 각 날 K200P 소속 종목 ----
  const dayMembers: S[][] = [];
  let nRows = 0;
  for (let c = 0; c < nCal; c++) {
    if (c < c0) { dayMembers.push([]); continue; }
    const m = kAt(CAL[c]);
    dayMembers.push(m);
    nRows += m.length;
  }
  const X = new Float32Array(nRows * NFEAT).fill(NaN);
  const Y: Record<number, Float32Array> = {}, RAW: Record<number, Float32Array> = {};
  for (const H of HORIZONS) { Y[H] = new Float32Array(nRows).fill(NaN); RAW[H] = new Float32Array(nRows).fill(NaN); }
  const dayIdx = new Int32Array(nRows), stockIdx = new Int32Array(nRows);

  /** 라벨 원수익: d 종가 신호 → d+1 종가 매수 → d+1+H 종가 매도(비용 제외). d+1+H 행이 없는데 종목이 상장폐지로 끝났으면 마지막 종가로 청산(엔진의 강제 청산과 같음), 그 밖의 결측(거래정지 등)은 결측. */
  const labelRet = (s: S, c: number, H: number): number => {
    if (c + 1 + H >= nCal) return NaN;
    const i1 = s.idx.get(CAL[c + 1]);
    if (i1 === undefined || !(s.close[i1] > 0)) return NaN;
    const d2 = CAL[c + 1 + H], i2 = s.idx.get(d2);
    let px: number;
    if (i2 !== undefined) px = s.close[i2];
    else if (s.last < d2 && s.last < h.endedBefore) px = s.close[s.close.length - 1];
    else return NaN;
    return px > 0 ? px / s.close[i1] - 1 : NaN;
  };

  let r0 = 0;
  const rowStartOfDay: number[] = new Array(nCal).fill(-1);
  for (let c = c0; c < nCal; c++) {
    const mem = dayMembers[c], d = CAL[c], n = mem.length;
    rowStartOfDay[c] = r0;
    if (!n) continue;
    // 원 특성값 (열별 배열)
    const col: Float64Array[] = Array.from({ length: NFEAT }, () => new Float64Array(n).fill(NaN));
    const sec = mem.map((s) => indOf.get(s.code)?.slice(0, 2) ?? "");
    for (let k = 0; k < n; k++) {
      const s = mem[k], i = s.idx.get(d) as number, cl = s.close, { cumC, cumTv } = cum(s);
      const ret = (kk: number): number => (i >= kk && cl[i - kk] > 0 ? cl[i] / cl[i - kk] - 1 : NaN);
      col[0][k] = ret(1); col[1][k] = ret(5); col[2][k] = ret(10); col[3][k] = ret(20); col[4][k] = ret(60); col[5][k] = ret(120); col[6][k] = ret(250);
      col[7][k] = i >= 250 && cl[i - 250] > 0 && cl[i - 20] > 0 ? cl[i - 20] / cl[i - 250] - 1 : NaN;
      for (const [ci, N] of [[8, 20], [9, 60]] as const) {
        if (i >= N) {
          let sm = 0, sq = 0, ok = true;
          for (let j = i - N + 1; j <= i; j++) { if (!(cl[j - 1] > 0)) { ok = false; break; } const r = cl[j] / cl[j - 1] - 1; sm += r; sq += r * r; }
          if (ok) col[ci][k] = Math.sqrt(Math.max(sq - (sm * sm) / N, 0) / (N - 1));
        }
      }
      if (i >= 59) {
        let pk = 0, dd = 0;
        for (let j = i - 59; j <= i; j++) { if (cl[j] > pk) pk = cl[j]; if (pk > 0) dd = Math.max(dd, 1 - cl[j] / pk); }
        col[10][k] = dd;
      }
      const tv = tvOf(s, i);
      if (i >= WFR_TV_WINDOW) {
        const av = (cumTv[i] - cumTv[i - WFR_TV_WINDOW]) / WFR_TV_WINDOW;
        if (av > 0) { col[12][k] = Math.log(av); if (tv > 0) col[11][k] = tv / av; }
      }
      if (s.mcapRow[i] > 0) col[13][k] = Math.log(s.mcapRow[i]);
      for (const [ci, N] of [[14, 20], [15, 60], [16, 200]] as const) if (i >= N - 1) col[ci][k] = cl[i] / ((cumC[i + 1] - cumC[i + 1 - N]) / N) - 1;
      {
        const nn = Math.min(WFR_H52_ROWS, i + 1);
        if (nn >= WFR_H52_MIN_ROWS) { let mx = 0; for (let j = i - nn + 1; j <= i; j++) if (cl[j] > mx) mx = cl[j]; if (mx > 0) col[17][k] = cl[i] / mx; }
      }
      if (i >= 4) {
        let sm = 0, ok = true;
        for (let j = i - 4; j <= i; j++) { const rg = s.high[j] - s.low[j]; if (!(rg > 0)) { ok = false; break; } sm += (cl[j] - s.low[j]) / rg; }
        if (ok) col[18][k] = sm / 5;
      }
      if (i >= 5) {
        let sm = 0, ok = true;
        for (let j = i - 4; j <= i; j++) { if (!(s.open[j] > 0) || !(cl[j - 1] > 0)) { ok = false; break; } sm += s.open[j] / cl[j - 1] - 1; }
        if (ok) col[19][k] = sm / 5;
      }
      const m20 = mktRet(c, 20), m60 = mktRet(c, 60);
      if (Number.isFinite(col[3][k]) && Number.isFinite(m20)) col[20][k] = col[3][k] - m20;
      if (Number.isFinite(col[4][k]) && Number.isFinite(m60)) col[21][k] = col[4][k] - m60;
      // 수급 비율 합
      for (let w = 0; w < WFR_FLOW_WINDOWS.length; w++) {
        const N = WFR_FLOW_WINDOWS[w], need = Math.ceil(N * WFR_FLOW_MIN_RATIO);
        if (c - N + 1 < 0) continue;
        let sm = 0, cnt = 0;
        for (let kk = c - N + 1; kk <= c; kk++) {
          const j = s.idx.get(CAL[kk]);
          if (j === undefined) continue;
          const t = tvOf(s, j), f = flow.get(`${s.code}|${CAL[kk]}`);
          if (f !== undefined && f !== null && t > 0) { sm += f / t; cnt++; }
        }
        if (cnt >= need) col[NP + w][k] = sm;
      }
    }
    // 업종 대비 20일 상대수익률
    const bySec = new Map<string, number[]>();
    for (let k = 0; k < n; k++) if (Number.isFinite(col[3][k]) && sec[k]) { const a = bySec.get(sec[k]) ?? []; a.push(col[3][k]); bySec.set(sec[k], a); }
    const med = new Map<string, number>();
    for (const [g, a] of bySec) if (a.length >= WFR_SECTOR_MIN_MEMBERS) { a.sort((x, y) => x - y); med.set(g, a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2); }
    for (let k = 0; k < n; k++) { const m = med.get(sec[k]); if (m !== undefined && Number.isFinite(col[3][k])) col[22][k] = col[3][k] - m; }
    // 횡단면 순위 정규화 후 기록
    for (let f = 0; f < NFEAT; f++) { const rk = rankNorm(col[f]); for (let k = 0; k < n; k++) X[(r0 + k) * NFEAT + f] = rk[k]; }
    for (const H of HORIZONS) {
      const raw = new Float64Array(n);
      for (let k = 0; k < n; k++) raw[k] = labelRet(mem[k], c, H);
      const rk = rankNorm(raw);
      for (let k = 0; k < n; k++) { RAW[H][r0 + k] = raw[k]; Y[H][r0 + k] = rk[k]; }
    }
    for (let k = 0; k < n; k++) { dayIdx[r0 + k] = c; stockIdx[r0 + k] = stockIndex.get(mem[k].code) as number; }
    r0 += n;
  }

  // ---- 저장 ----
  await fs.mkdir(OUT, { recursive: true });
  const wr = async (name: string, a: ArrayBufferView): Promise<void> => fs.writeFile(path.join(OUT, name), Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  await wr("X.f32", X); await wr("dayIdx.i32", dayIdx); await wr("stockIdx.i32", stockIdx);
  for (const H of HORIZONS) { await wr(`y${H}.f32`, Y[H]); await wr(`raw${H}.f32`, RAW[H]); }
  const years = [...new Set(CAL.slice(c0).map((d) => Number(d.slice(0, 4))))];
  const firstIdxOfYear: Record<string, number> = {};
  for (const y of years) firstIdxOfYear[y] = CAL.findIndex((d) => d >= `${y}-01-01`);
  const variants: { name: string; cand: string; horizon: number; flow: boolean; seed: number; shuffle: boolean }[] = [];
  for (const [id, cd] of Object.entries(WFR_CANDS)) {
    variants.push({ name: id, cand: id, horizon: cd.horizon, flow: cd.flow, seed: WFR_LGB_PARAMS.seed, shuffle: false });
    for (const sd of WFR_NB_SEEDS) variants.push({ name: `${id}_s${sd}`, cand: id, horizon: cd.horizon, flow: cd.flow, seed: sd, shuffle: false });
    variants.push({ name: `${id}_shuf`, cand: id, horizon: cd.horizon, flow: cd.flow, seed: WFR_LGB_PARAMS.seed, shuffle: true });
  }
  const meta = {
    nRows, nFeat: NFEAT, nPrice: NP, featureNames: [...WFR_PRICE_FEATURES, ...WFR_FLOW_FEATURES], horizons: HORIZONS, c0, cEval, nCal, dates: CAL, years, firstIdxOfYear, firstPredYear: WFR_FIRST_PRED_YEAR,
    params: WFR_LGB_PARAMS, shuffleSeed: WFR_SHUFFLE_SEED, variants, codes: h.stocks.map((s) => s.code),
  };
  await fs.writeFile(path.join(OUT, "meta.json"), JSON.stringify(meta));
  console.log(`저장 ${OUT}/ : 행 ${nRows}, 특성 ${NFEAT}(가격 ${NP} + 수급 ${NF}), 라벨 H=${HORIZONS.join("·")}, X ${(X.byteLength / 1048576).toFixed(1)} MiB`);

  // ---- 진단(성과 아님): 결측률, 행 수, 퍼지 경계 ----
  const nanRate = (f: number, lo: number, hi: number): string => { let n = 0, t = 0; for (let r = 0; r < nRows; r++) { const c = dayIdx[r]; if (c < lo || c > hi) continue; t++; if (Number.isNaN(X[r * NFEAT + f])) n++; } return t ? f2((n / t) * 100) : "-"; };
  console.log(`\n=== 특성 결측률 % (전체 행 ${nRows}) | 학습 구간 2011~2013 | 예측 구간 ${CAL[cEval]}~ ===\n| 특성 | 전체 | 2011~2013 | 2014~ |\n|---|---|---|---|`);
  const lo14 = cEval, hi13 = cEval - 1;
  for (let f = 0; f < NFEAT; f++) console.log(`| ${f < NP ? WFR_PRICE_FEATURES[f] : WFR_FLOW_FEATURES[f - NP]} | ${nanRate(f, 0, nCal)} | ${nanRate(f, c0, hi13)} | ${nanRate(f, lo14, nCal)} |`);
  console.log(`\n=== 연도별 행 수와 수급 특성(frgn5/frgn20) 결측률 %, 라벨(H=${HORIZONS.join("/")}) 유효 행 수 ===\n| 연도 | 행 | frgn5 결측 | frgn20 결측 | ${HORIZONS.map((H) => `라벨 H=${H}`).join(" | ")} |\n|---|---|---|---|${HORIZONS.map(() => "---").join("|")}|`);
  for (const y of years) {
    const lo = firstIdxOfYear[y], hi = (firstIdxOfYear[y + 1] ?? nCal + 1) - 1;
    let n = 0; const lab: Record<number, number> = {};
    for (const H of HORIZONS) lab[H] = 0;
    for (let r = 0; r < nRows; r++) { const c = dayIdx[r]; if (c < lo || c > hi) continue; n++; for (const H of HORIZONS) if (Number.isFinite(Y[H][r])) lab[H]++; }
    console.log(`| ${y} | ${n} | ${nanRate(NP, lo, hi)} | ${nanRate(NP + 1, lo, hi)} | ${HORIZONS.map((H) => lab[H]).join(" | ")} |`);
  }
  console.log(`\n=== 퍼지 경계(연 1회 재학습; 학습 라벨 마지막 날 = 예측 연도 첫 거래일 순번 − H − 2) ===\n| 예측 연도 | 첫 거래일 | ${HORIZONS.map((H) => `H=${H} 학습 마지막 판단일`).join(" | ")} |\n|---|---|${HORIZONS.map(() => "---").join("|")}|`);
  for (const y of years.filter((x) => x >= WFR_FIRST_PRED_YEAR)) { const f = firstIdxOfYear[y]; console.log(`| ${y} | ${CAL[f]} | ${HORIZONS.map((H) => `${CAL[f - H - 2]} (라벨 완성 ${CAL[f - 1]} 이전)`).join(" | ")} |`); }
  console.log(`\n${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 가격 성과 계산 없음 | 시도 번호 소진 없음`);
}
main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

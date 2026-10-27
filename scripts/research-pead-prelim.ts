/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 PEAD 잠정실적 이벤트 PE7(시도 241). 후보 1회 실행. PE4와 모두 같고(K200P, 증가율 ≥ 30%, 보유 20거래일) 이벤트 소스만 다르다:
 * 같은 기업·기간의 정기보고서와 잠정실적(영업(잠정)실적 공정공시) 중 접수일이 더 이른 원본 하나만 이벤트로 쓴다(둘 다 있으면 늦은 쪽은 신호로 쓰지 않음; 접수일이 같으면 정기보고서).
 * 사전 등록: docs/research/pead-preliminary-disclosure-prereg.md. 가격 Parquet은 고정 스냅샷(데이터 종료일 2026-10-26)에서만 읽고, 재무·공시·월말 목록은 부분집합(RESEARCH_SUBSET_DIR, Actions 캐시)과
 * 잠정실적 파싱 결과(.research-prelim, Actions 캐시)만 읽는다. Supabase Storage 읽기 0. 069500 기준선은 보조 파일(BENCH_AUX_069500=1, SHA-256 대조). DB·Storage 쓰기 0.
 */
import { simSlots, type SimCand, type SimPos, type SimRun } from "@/lib/slotSim";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { decodeTable } from "@/lib/nBookStore";
import { eventsByCorp, type FinRow, type FilingRow } from "@/lib/rFinMetrics";
import { R_SMALL_MCAP_MIN_EOK, R_SMALL_MCAP_MAX_EOK, R_SMALL_TV_MIN_WON, R_SMALL_PRICE_MIN_WON } from "@/lib/kodexSectorSatConfig";
import { SAT_KSIC_DIVISION_NAMES, SAT_SECTOR_UNCLASSIFIED } from "@/lib/satelliteV1Config";
import { PEAD_PRELIM_CAND, PEAD_PE4_REF, PEAD_PRELIM_STUDY, PEAD_SEMCO, PEAD_MAX_POS, PEAD_COOLDOWN_DAYS, PEAD_RUN_START, PEAD_WINDOWS, PEAD_SLIPPAGE, PEAD_H_CAGR_GAIN_PP, PEAD_H_MDD_GAIN_PP, PEAD_H_MDD_GAIN_STRONG_PP, PEAD_H_CAGR_FLOOR_PP, PEAD_DEADLINES, PEAD_SEASON_BEFORE_DAYS, PEAD_SEASON_AFTER_DAYS, PEAD_DOWNTURNS } from "@/lib/peadConfig";
import { selectPrelim, type PrelimRec } from "@/lib/peadPrelimSelect";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, SNAP_END, f2, avg, median, type S } from "./researchHarness";
import { evaluate, seedReport, yearlyTable, summaryReport, type CandSpec, type Verdict, type Windows } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
type PId = keyof typeof PEAD_PRELIM_CAND;
type UKind = "K200P" | "SMALL";
const SAMSUNG = "005930", HYNIX = "000660";
const HOLD_REASON = "보유 만료";
interface Episode { peakIdx: number; troughIdx: number; recIdx: number | null; depth: number }
type Src = "정기" | "잠정";
interface Ev { code: string; rceptDt: string; r0: number; sig: number; qOi: number; qOiPrev: number; growth: number; up: boolean; src: Src; regDt: string | null }
interface Cand { src: Src; code: string; corp: string; dt: string; no: string; qOi: number; qOiPrev: number; regDt: string | null }
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
  console.log(`연구 PEAD 잠정실적 이벤트 PE7(시도 241) 시험 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, kAt, indOf, nameOf } = await loadK200P(h);
  const cS = CAL.findIndex((d) => d >= PEAD_RUN_START);
  if (cS < 0 || CAL[cS] !== PEAD_RUN_START) throw new Error(`${PEAD_RUN_START}이 거래일 달력에 없음`);
  const NW: [string, { from: string; to: string }][] = PEAD_WINDOWS.map(([n, f, t]) => [n, { from: f, to: t }]);
  const FULL = { from: CAL[cS + 1], to: "9999-12-31" };
  const W: Windows = { NW, FULL, ALL: [...NW, ["평가 구간 전체", FULL]] };
  const ex26 = { from: FULL.from, to: "2025-12-31" };
  console.log(`평가 시작 판단일 ${CAL[cS]}(달력 순번 ${cS}), 수익률 집계 ${FULL.from}~${h.dataEnd} | 구간 ${NW.map(([n, w]) => `${n} ${w.from}~${w.to}`).join(" / ")}`);

  // ---- 새 기준선(2017-04-04~): 069500 원주가, 보조 파일(~2026-10-26) vs DB만(~2026-10-16) ----
  console.log(`\n=== 0. 069500 기준선 (2017-04-04 시작; 원주가, 가격 수익만; CAGR % / MDD %) ===\n기존 = etf_daily_prices만(${h.bhPDb.dates[h.bhPDb.dates.length - 1]}까지), 새 = 보조 파일(${h.bhP.dates[h.bhP.dates.length - 1]}까지) — 게이트 A~H는 새 기준선으로 판정\n| 구간 | 기존 | 새 |\n|---|---|---|`);
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

  // ---- 재무·공시 자료: Supabase Storage가 아니라 부분집합 캐시(.research-subset)와 잠정실적 파싱 결과(.research-prelim)만 읽는다 ----
  const subDir = process.env.RESEARCH_SUBSET_DIR?.trim() || PEAD_PRELIM_STUDY.subsetDir;
  for (const [f, want] of Object.entries(PEAD_PRELIM_STUDY.subsetSha256)) {
    const got = sha(await fs.readFile(path.join(subDir, f)));
    if (got !== want) throw new Error(`부분집합 ${f} SHA-256 불일치`);
  }
  const ab = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const finRows = (await decodeTable(ab(await fs.readFile(path.join(subDir, "fin_sub.parquet"))))) as unknown as FinRow[];
  const filRows = (await decodeTable(ab(await fs.readFile(path.join(subDir, "filings_sub.parquet"))))) as unknown as FilingRow[];
  const parsedBuf = await fs.readFile(path.join(PEAD_PRELIM_STUDY.parsedDir, PEAD_PRELIM_STUDY.parsedFile));
  console.log(`부분집합 SHA-256 대조 통과 | fin ${finRows.length}행, filings ${filRows.length}행 | 잠정실적 파싱 결과 ${parsedBuf.byteLength} B SHA-256 ${sha(parsedBuf)} (Storage 읽기 0)`);
  const prelimAll = (await decodeTable(ab(parsedBuf))).map((r) => ({ ...(r as unknown as PrelimRec), cons: r.cons === "Y", ok: r.ok === 1 })) as PrelimRec[];
  const stockOfCorp = new Map<string, string>();
  for (const r of finRows) if (r.stock_code) stockOfCorp.set(r.corp_code, r.stock_code);
  const evOrig = eventsByCorp(finRows, filRows); // 원본(비정정) 접수 이벤트만. 정정 점 시점 재계산 이벤트는 신호로 쓰지 않는다.
  const Q_OF_RC: Record<string, number> = { "11013": 1, "11012": 2, "11014": 3, "11011": 4 };
  const periodOfNo = new Map<string, string>();
  for (const r of finRows) if (!periodOfNo.has(r.rcept_no) && Q_OF_RC[r.reprt_code]) periodOfNo.set(r.rcept_no, `${r.corp_code}|${r.bsns_year}|${Q_OF_RC[r.reprt_code]}`);

  // ---- 유니버스 ----
  const smallCache = new Map<string, S[]>();
  const smallAt = (d: string): S[] => {
    let v = smallCache.get(d);
    if (!v) {
      const m = membAt(d), e: { s: S; mc: number }[] = [];
      if (m) for (const s of h.stocks) {
        const i = s.idx.get(d);
        if (i === undefined || excluded.has(s.code) || m.get(s.code) !== "KOSPI") continue;
        const mc = s.mcapRow[i];
        if (mc >= R_SMALL_MCAP_MIN_EOK && mc < R_SMALL_MCAP_MAX_EOK && s.avgTvRow[i] >= R_SMALL_TV_MIN_WON && s.raw[i] >= R_SMALL_PRICE_MIN_WON) e.push({ s, mc });
      }
      e.sort((a, b) => b.mc - a.mc || (a.s.code < b.s.code ? -1 : 1));
      v = e.map((x) => x.s);
      smallCache.set(d, v);
    }
    return v;
  };
  const uSetCache = new Map<string, Set<string>>();
  const inU = (k: UKind, c: number, code: string): boolean => {
    const key = `${k}|${c}`;
    let v = uSetCache.get(key);
    if (!v) { v = new Set((k === "K200P" ? kAt(CAL[c]) : smallAt(CAL[c])).map((s) => s.code)); uSetCache.set(key, v); }
    return v.has(code);
  };

  // ---- 이벤트: 원본 접수, 분기 영업이익·전년 동기 값이 있는 것. 접수일이 거래일이 아니면 그 뒤 첫 거래일을 접수일(r0)로 보고, 신호 확정일 = r0 다음 거래일 ----
  const lowerBound = (d: string): number => { let lo = 0, hi = nCal; while (lo < hi) { const m = (lo + hi) >> 1; if (CAL[m] < d) lo = m + 1; else hi = m; } return lo; };
  const closeAtOrBefore = (s: S, c: number): number => { for (let k = c; k >= Math.max(c - 5, 0); k--) { const i = s.idx.get(CAL[k]); if (i !== undefined) return s.close[i]; } return NaN; };
  // 정기보고서 후보(PE4와 같은 이벤트): 값이 있는 원본 접수. 기간 키 = 회사|사업연도|분기(사업보고서는 4).
  const regular = new Map<string, Cand>();
  for (const [corp, list] of evOrig) {
    const code = stockOfCorp.get(corp);
    if (!code) continue;
    for (const e of list) {
      if (e.qOi === null || e.qOiPrev === null) continue;
      const key = periodOfNo.get(e.rceptNo);
      if (!key) continue;
      regular.set(key, { src: "정기", code, corp, dt: e.rceptDt, no: e.rceptNo, qOi: e.qOi, qOiPrev: e.qOiPrev, regDt: e.rceptDt });
    }
  }
  // 잠정실적 후보: 선택 규칙(연결 우선, 파싱 성공 문서)
  const prelimSel = [...selectPrelim(prelimAll).entries()].filter(([, r]) => r.ok && r.cur_won !== null && r.prevy_won !== null);
  const prelim = new Map<string, Cand>();
  for (const [key, r] of prelimSel) {
    const code = stockOfCorp.get(r.corp_code) ?? r.stock_code;
    if (!code) continue;
    prelim.set(key, { src: "잠정", code, corp: r.corp_code, dt: r.rcept_dt, no: r.rcept_no, qOi: r.cur_won as number, qOiPrev: r.prevy_won as number, regDt: regular.get(key)?.dt ?? null });
  }
  // 병합: 같은 기간에 둘 다 있으면 접수일이 더 이른 쪽(같은 날이면 정기보고서) 하나만. 정기보고서만 쓰는 PE4 이벤트 집합도 함께 만든다.
  const merged: Cand[] = [], regOnly: Cand[] = [...regular.values()];
  for (const [key, c] of regular) { const pr = prelim.get(key); merged.push(pr && pr.dt < c.dt ? pr : c); }
  let prelimOnlyKey = 0;
  for (const [key, pr] of prelim) if (!regular.has(key)) { merged.push(pr); prelimOnlyKey++; }
  const buildEv = (cands: Cand[]): Ev[] => {
    const out: Ev[] = [];
    for (const c of cands) {
      const s = byCode.get(c.code);
      if (!s) continue;
      const r0 = lowerBound(c.dt), sig = r0 + 1;
      if (sig >= nCal - 1 || sig < cS) continue;
      out.push({ code: s.code, rceptDt: c.dt, r0, sig, qOi: c.qOi, qOiPrev: c.qOiPrev, growth: c.qOiPrev > 0 ? c.qOi / c.qOiPrev - 1 : NaN, up: closeAtOrBefore(s, sig) > closeAtOrBefore(s, r0), src: c.src, regDt: c.regDt });
    }
    return out;
  };
  const byUniv = (evs: Ev[]): Record<UKind, Map<number, Ev[]>> => {
    const o: Record<UKind, Map<number, Ev[]>> = { K200P: new Map(), SMALL: new Map() };
    for (const e of evs) for (const k of ["K200P", "SMALL"] as UKind[]) if (inU(k, e.sig, e.code)) { const l = o[k].get(e.sig) ?? []; l.push(e); o[k].set(e.sig, l); }
    return o;
  };
  const evs = buildEv(merged), evs4 = buildEv(regOnly);
  const evU = byUniv(evs), evU4 = byUniv(evs4);
  const cnt = (m: Map<number, Ev[]>): number => [...m.values()].reduce((a, l) => a + l.length, 0);
  console.log(`이벤트(신호 확정일 ${PEAD_RUN_START} 이후, 분기 영업이익·전년 동기 값 있는 원본 접수): PE7 병합 ${evs.length}건(정기 ${evs.filter((e) => e.src === "정기").length} / 잠정 ${evs.filter((e) => e.src === "잠정").length}; 잠정 중 같은 기간 정기보고서 이벤트 없음 ${prelimOnlyKey}건 전체 구간) | PE4(정기만) ${evs4.length}건 | K200P 안: PE7 ${cnt(evU.K200P)}건, PE4 ${cnt(evU4.K200P)}건`);

  const env = { CAL, nCal, cS, adjustments: h.adjustments, endedBefore: h.endedBefore, stockBuyMult: h.stockBuyMult, sellRate: h.sellRate, baseSlip: SLIPPAGE_PCT_PER_SIDE, bhRet: h.bhRet };
  const label = (code: string): string => `${code} ${nameOf.get(code) ?? "?"}`;
  const sectorOf = (c: string): string => indOf.get(c)?.slice(0, 2) ?? SAT_SECTOR_UNCLASSIFIED;
  const secLabel = (g: string): string => (g === SAT_SECTOR_UNCLASSIFIED ? g : `${g} ${SAT_KSIC_DIVISION_NAMES[g] ?? "?"}`);

  /** 후보 훅: 신호 확정일 c의 이벤트(영업이익 흑자 ∧ 전년 동기 흑자 ∧ 증가율 ≥ g ∧ 접수일 종가보다 신호 확정일 종가가 높음)를 증가율 큰 순(동률은 코드 오름차순)으로. 청산 = 체결(entryC) 후 N거래일이 지나면 다음 거래일 종가. */
  const hooksFor = (k: UKind, g: number, N: number, exclude?: Set<string>, ev: Record<UKind, Map<number, Ev[]>> = evU) => ({
    candsOf: (c: number): SimCand[] => {
      const l = ev[k].get(c);
      if (!l) return [];
      return l.filter((e) => e.qOi > 0 && e.qOiPrev > 0 && e.growth >= g - 1e-12 && e.up && !exclude?.has(e.code)).sort((a, b) => b.growth - a.growth || (a.code < b.code ? -1 : 1)).map((e) => ({ s: byCode.get(e.code)!, code: e.code }));
    },
    exitReason: (p: SimPos, c: number): string | null => (c - p.entryC >= N ? HOLD_REASON : null),
  });
  const cfgFor = (k: UKind) => ({ slip: PEAD_SLIPPAGE[k], maxPos: PEAD_MAX_POS, capFrac: 1 / PEAD_MAX_POS, cooldown: PEAD_COOLDOWN_DAYS });
  const bhAsRun = { dates: bhFrom.dates, ret: bhFrom.ret } as unknown as SimRun;
  const hVs = (full: { cagr: number; mdd: number }, rb: { cagr: number; mdd: number }): { ok: boolean; text: string } => {
    const dc = full.cagr - rb.cagr, dm = rb.mdd - full.mdd;
    const c1 = dc >= PEAD_H_CAGR_GAIN_PP, c2 = dm >= PEAD_H_MDD_GAIN_PP && dc >= -PEAD_H_CAGR_FLOOR_PP;
    return { ok: c1 || c2, text: `CAGR ${dc >= 0 ? "+" : ""}${f2(dc)}%p, MDD ${dm >= 0 ? "−" : "+"}${f2(Math.abs(dm))}%p(개선 ${f2(dm)}%p; ${PEAD_H_MDD_GAIN_STRONG_PP}%p 이상 ${dm >= PEAD_H_MDD_GAIN_STRONG_PP ? "O" : "X"}) → 조건1(CAGR +${PEAD_H_CAGR_GAIN_PP}%p) ${c1 ? "O" : "X"}, 조건2(MDD 개선 ${PEAD_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${PEAD_H_CAGR_FLOOR_PP}%p) ${c2 ? "O" : "X"}` };
  };
  const inWin = (d: string, w: { from: string; to: string }): boolean => d >= w.from && d <= w.to;
  const addDays = (d: string, n: number): string => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
  const isSeason = (d: string): boolean => PEAD_DEADLINES.some((md) => [d.slice(0, 4), String(Number(d.slice(0, 4)) - 1)].some((y) => { const dl = `${y}-${md}`; return d >= addDays(dl, -PEAD_SEASON_BEFORE_DAYS) && d <= addDays(dl, PEAD_SEASON_AFTER_DAYS); }));

  const pe4Run = simSlots(env, cfgFor("K200P"), hooksFor("K200P", PEAD_PE4_REF.growth, PEAD_PE4_REF.hold, undefined, evU4), { lag: 1, detail: true });
  { const s1 = h.st(pe4Run, FULL); console.log(`비교 열 PE4(정기보고서 이벤트만; K200P 증가율 ≥ 30% N = 20) 재계산: 전체 CAGR ${f2(s1.cagr)} / MDD ${f2(s1.mdd)} — 연구 PEAD 보유 단축 ${PEAD_PE4_REF.cagr.toFixed(2)} / ${PEAD_PE4_REF.mdd.toFixed(2)}와 ${Math.abs(s1.cagr - PEAD_PE4_REF.cagr) < 0.006 && Math.abs(s1.mdd - PEAD_PE4_REF.mdd) < 0.006 ? "일치" : "불일치(보고만, 중단 안 함)"}`); }

  const mkSpec = (id: PId): CandSpec => {
    const cd = PEAD_PRELIM_CAND[id], k = cd.universe as UKind, cfg = cfgFor(k);
    const nb: { label: string; run: () => SimRun }[] = [];
    for (const g2 of cd.growthNeighbors) nb.push({ label: `증가율 ≥ ${Math.round(g2 * 100)}%`, run: () => simSlots(env, cfg, hooksFor(k, g2, cd.hold), { lag: 1 }) });
    for (const n2 of cd.holdNeighbors) nb.push({ label: `보유 N = ${n2}`, run: () => simSlots(env, cfg, hooksFor(k, cd.growth, n2), { lag: 1 }) });
    return {
      id, trial: cd.trial, title: `이벤트 = 정기보고서와 잠정실적 중 접수일이 더 이른 원본 하나, K200P(코스피 보통주 시총 상위 200), 분기 영업이익 > 0 ∧ 전년 동기 > 0 ∧ 증가율 ≥ ${Math.round(cd.growth * 100)}%, 접수일 다음 거래일 신호·그다음 거래일 체결(접수일 종가 대비 신호일 종가 상승만), ${cd.hold}거래일 보유 후 다음 거래일 매도, 슬리피지 ${PEAD_SLIPPAGE[k] * 100}%`,
      defense: false, capFrac: 1 / PEAD_MAX_POS, fDenominator: 3, ref: { id: "069500", run: bhAsRun },
      hRule: (full, rb) => { const a = hVs(full, rb), p1 = h.st(pe4Run, FULL); return { ok: a.ok, note: `${a.text} | 참고(판정 아님): PE4 ${f2(p1.cagr)} / ${f2(p1.mdd)} 대비 CAGR ${full.cagr - p1.cagr >= 0 ? "+" : ""}${f2(full.cagr - p1.cagr)}%p, MDD ${full.mdd - p1.mdd >= 0 ? "+" : ""}${f2(full.mdd - p1.mdd)}%p` }; },
      run: (o) => simSlots(env, cfg, hooksFor(k, cd.growth, cd.hold, o.exclude), { lag: o.lag, int: o.int, replace: o.replace, detail: o.detail }),
      neighbors: nb,
      // 게이트 F: 같은 신호일·같은 주문 수로, 그날 유니버스 안 "비교 가능한 원본 접수 이벤트 중 접수일 종가보다 신호일 종가가 높은" 종목을 영업이익 조건 없이 무작위로 뽑는다. 청산 규칙(보유 N)은 같다.
      random: (rng, ordersByDay) => simSlots(env, cfg, {
        candsOf: (c, held, blocked) => {
          const n = ordersByDay.get(c) ?? 0;
          if (!n) return [];
          const pool = (evU[k].get(c) ?? []).filter((e) => e.up && !held(e.code) && !blocked(e.code)), out: SimCand[] = [];
          while (out.length < n && pool.length) { const e = pool.splice(Math.floor(rng() * pool.length), 1)[0]; out.push({ s: byCode.get(e.code)!, code: e.code }); }
          return out;
        },
        exitReason: hooksFor(k, cd.growth, cd.hold).exitReason,
      }, { lag: 1 }),
      reasons: [HOLD_REASON, "폐지"],
      label,
      extra: (run) => {
        const E = (name: string, r: SimRun): void => { for (const [wn, w] of W.ALL) { const s = h.st(r, w), b = h.st(h.bhP, w); console.log(`  ${name} | ${wn}: CAGR ${f2(s.cagr)} / MDD ${f2(s.mdd)} (069500 ${f2(b.cagr)} / ${f2(b.mdd)})`); } };
        const yrs = (Date.parse(h.dataEnd) - Date.parse(FULL.from)) / 86_400_000 / 365.25;
        console.log(`${id} 구간별 진입·보유·현금·회전율·비용 (비용 합계 % = 구간 안 일별 비용 합)\n| 구간 | 진입 건수 | 평균 동시 보유(전체 날) | 보유 있는 날 평균 | 슬롯 10개 다 찬 날 % | 평균 투자 비중 % | 현금 비중 % | 현금 100% 일수 / 일수 | 연 회전율 % | 비용 합계 % |\n|---|---|---|---|---|---|---|---|---|---|`);
        for (const [wn, w] of W.ALL) {
          const idx: number[] = [];
          for (let i = 0; i < run.dates.length; i++) if (inWin(run.dates[i], w)) idx.push(i);
          const s = h.st(run, w), nPos = idx.map((i) => run.nPos[i]);
          console.log(`| ${wn} | ${run.entryCs.filter((c) => inWin(CAL[c], w)).length} | ${f2(avg(nPos))} | ${f2(avg(nPos.filter((x) => x > 0)))} | ${f2((nPos.filter((x) => x >= PEAD_MAX_POS).length / Math.max(nPos.length, 1)) * 100)} | ${f2(s.avgInv)} | ${f2(100 - s.avgInv)} | ${nPos.filter((x) => x === 0).length} / ${idx.length} | ${f2(s.turnover)} | ${f2(s.cost)} |`);
        }
        const fs = h.st(run, FULL);
        console.log(`${id} 합계 비용 ${f2(fs.cost)}% (연평균 ${f2(fs.cost / yrs)}%, ${f2(yrs)}년) | 연 회전율 ${f2(fs.turnover)}%`);
        const seasonIdx: number[] = [], offIdx: number[] = [];
        for (let i = 0; i < run.dates.length; i++) (isSeason(run.dates[i]) ? seasonIdx : offIdx).push(i);
        const cashOf = (ii: number[]): number => (1 - avg(ii.map((i) => run.inv[i]))) * 100;
        console.log(`${id} 공시 시즌(제출 기한 ${PEAD_DEADLINES.join("·")} 20일 전~10일 후, 보고용 정의) 현금 비중 ${f2(cashOf(seasonIdx))}% (${seasonIdx.length}일) | 시즌 외 현금 비중 ${f2(cashOf(offIdx))}% (${offIdx.length}일) | 시즌 외 현금 100%인 날 ${offIdx.filter((i) => run.nPos[i] === 0).length}/${offIdx.length}일`);
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
        E(`${id} lag 2`, simSlots(env, cfg, hooksFor(k, cd.growth, cd.hold), { lag: 2, detail: true }));
        const top3 = [...run.trades].sort((a, b) => (b.proceeds - b.spend) / b.vAtEntry - (a.proceeds - a.spend) / a.vAtEntry).slice(0, 3);
        console.log(`${id} 상위 3개 거래(${top3.map((t) => `${label(t.code)} ${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")})를 069500 수익률로 바꾼 구간별 성적(= 제외)`);
        E(`${id} 상위 3개 거래 대체`, simSlots(env, cfg, hooksFor(k, cd.growth, cd.hold), { lag: 1, detail: true, replace: new Set(top3.map((t) => `${t.code}|${t.entryC}`)) }));
        const secN = new Map<string, number>();
        for (const t of run.trades) secN.set(sectorOf(t.code), (secN.get(sectorOf(t.code)) ?? 0) + 1);
        console.log(`${id} 업종별(KSIC 2자리) 진입 분포(닫힌 거래 ${run.trades.length}건): ${[...secN].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([g, n]) => `${secLabel(g)} ${n}건(${f2((n / run.trades.length) * 100)}%)`).join(" | ")}`);
        const yearN = new Map<string, number>();
        for (const c of run.entryCs) yearN.set(CAL[c].slice(0, 4), (yearN.get(CAL[c].slice(0, 4)) ?? 0) + 1);
        console.log(`${id} 연도별 진입 건수: ${[...yearN].sort().map(([y, n]) => `${y} ${n}`).join(" | ")}`);
        const wsum = new Map<string, number>();
        let nDays = 0, invSum = 0;
        simSlots(env, cfg, hooksFor(k, cd.growth, cd.hold), { lag: 1, onDay: (_c, V, held) => { nDays++; for (const [code, val] of held) { wsum.set(code, (wsum.get(code) ?? 0) + val / V); invSum += val / V; } } });
        const wavg = (code: string): number => ((wsum.get(code) ?? 0) / Math.max(nDays, 1)) * 100;
        console.log(`${id} 일별 평균 계좌 비중(현금 날 포함; ${nDays}일): 삼성전자 ${f2(wavg(SAMSUNG))}% · SK하이닉스 ${f2(wavg(HYNIX))}% · 합 ${f2(wavg(SAMSUNG) + wavg(HYNIX))}% | 투자분 중 두 종목 비중 ${f2(((wsum.get(SAMSUNG) ?? 0) + (wsum.get(HYNIX) ?? 0)) / Math.max(invSum, 1e-12) * 100)}% | 상위 8: ${[...wsum].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c2, v]) => `${label(c2)} ${f2((v / Math.max(nDays, 1)) * 100)}%`).join(", ")}`);
        // 삼성전기 2026-03 진입 거래를 069500으로 바꾼 성적(보고용)
        const semco = run.trades.filter((t) => t.code === PEAD_SEMCO.code && CAL[t.entryC].startsWith(PEAD_SEMCO.entryMonth));
        if (semco.length) {
          console.log(`${id} 삼성전기 ${PEAD_SEMCO.entryMonth} 진입 거래 ${semco.map((t) => `${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")}를 069500으로 바꾼(= 제외) 구간별 성적`);
          E(`${id} 삼성전기 제외`, simSlots(env, cfg, hooksFor(k, cd.growth, cd.hold), { lag: 1, detail: true, replace: new Set(semco.map((t) => `${t.code}|${t.entryC}`)) }));
        } else console.log(`${id} 삼성전기 ${PEAD_SEMCO.entryMonth} 진입 거래 없음`);
        // ---- 소스(정기/잠정)별 보고 ----
        const okEv = (e: Ev): boolean => e.qOi > 0 && e.qOiPrev > 0 && e.growth >= cd.growth - 1e-12 && e.up;
        const pct = (a: number, b: number): string => f2((a / Math.max(b, 1)) * 100);
        const allE = [...evU[k].values()].flat(), passE = allE.filter(okEv);
        console.log(`${id} 이벤트 소스 비중 — K200P 안 전체 이벤트 ${allE.length}건: 정기 ${allE.filter((e) => e.src === "정기").length} / 잠정 ${allE.filter((e) => e.src === "잠정").length}(${pct(allE.filter((e) => e.src === "잠정").length, allE.length)}%) | 조건(흑자·증가율·가격 상승) 통과 ${passE.length}건: 정기 ${passE.filter((e) => e.src === "정기").length} / 잠정 ${passE.filter((e) => e.src === "잠정").length}(${pct(passE.filter((e) => e.src === "잠정").length, passE.length)}%)`);
        const srcOf = (t: { code: string; entryC: number }): Src | "?" => (evU[k].get(t.entryC - 1) ?? []).filter((e) => e.code === t.code && okEv(e)).sort((a, b) => b.growth - a.growth)[0]?.src ?? "?";
        for (const sn of ["정기", "잠정", "?"] as const) {
          const ts = run.trades.filter((t) => srcOf(t) === sn);
          if (!ts.length) continue;
          const rets = ts.map((t) => (t.proceeds / t.spend - 1) * 100);
          console.log(`${id} 소스 ${sn === "?" ? "식별 불가" : sn}별 진입 ${ts.length}건(${pct(ts.length, run.trades.length)}%): 평균 거래 수익률 ${f2(avg(rets))}%, 중앙값 ${f2(median(rets))}%, 승률 ${pct(rets.filter((x) => x > 0).length, rets.length)}%`);
        }
        const ySrc = new Map<string, [number, number]>();
        for (const t of run.trades) { const y = CAL[t.entryC].slice(0, 4), v = ySrc.get(y) ?? [0, 0]; if (srcOf(t) === "잠정") v[1]++; else v[0]++; ySrc.set(y, v); }
        console.log(`${id} 연도별 진입 건수(정기 / 잠정): ${[...ySrc].sort().map(([y, v]) => `${y} ${v[0]} / ${v[1]}`).join(" | ")}`);
        // 잠정실적이 같은 기간 정기보고서보다 먼저 나온 일수(달력일): 선택·파싱 성공 잠정 문서 전체(정기 이벤트가 있는 것) / 채택된(더 이른) 이벤트
        const leadStat = (v: number[], name: string): void => { const a = [...v].sort((x, y) => x - y), qq = (p: number): string => (a.length ? String(a[Math.min(Math.floor(a.length * p), a.length - 1)]) : "-"); console.log(`${id} ${name} ${a.length}건: 최소 ${qq(0)} / 10분위 ${qq(0.1)} / 25분위 ${qq(0.25)} / 중앙값 ${qq(0.5)} / 75분위 ${qq(0.75)} / 90분위 ${qq(0.9)} / 최대 ${a.length ? a[a.length - 1] : "-"} | 7일 이상 ${a.filter((x) => x >= 7).length}건, 14일 이상 ${a.filter((x) => x >= 14).length}건, 30일 이상 ${a.filter((x) => x >= 30).length}건 | 정기보고서가 먼저/같은 날(≤ 0일) ${a.filter((x) => x <= 0).length}건`); };
        leadStat([...prelim.values()].filter((c) => c.regDt !== null).map((c) => (Date.parse(c.regDt as string) - Date.parse(c.dt)) / 86_400_000), "잠정 → 정기보고서 접수까지 달력일 — 파싱 성공·선택된 잠정 문서 중 같은 기간 정기보고서 이벤트가 있는 것");
        leadStat(evs.filter((e) => e.src === "잠정" && e.regDt !== null).map((e) => (Date.parse(e.regDt as string) - Date.parse(e.rceptDt)) / 86_400_000), "채택된 잠정 이벤트(신호 확정일 이후)의 선행 일수");
        // PE4(정기보고서만) 대비 구간별 진입 건수·투자/현금 비중
        console.log(`${id} vs PE4 구간별 비교 (진입 건수 / 평균 투자 비중 % / 현금 비중 % / 현금 100% 일수)\n| 구간 | PE4 진입 | PE7 진입 | PE4 투자 | PE7 투자 | PE4 현금 | PE7 현금 | PE4 현금 100% 일수 | PE7 현금 100% 일수 |\n|---|---|---|---|---|---|---|---|---|`);
        for (const [wn, w] of W.ALL) {
          const cash0 = (r: SimRun): number => { let c0 = 0; for (let i = 0; i < r.dates.length; i++) if (inWin(r.dates[i], w) && r.nPos[i] === 0) c0++; return c0; };
          const a4 = h.st(pe4Run, w), a7 = h.st(run, w);
          console.log(`| ${wn} | ${pe4Run.entryCs.filter((c) => inWin(CAL[c], w)).length} | ${run.entryCs.filter((c) => inWin(CAL[c], w)).length} | ${f2(a4.avgInv)} | ${f2(a7.avgInv)} | ${f2(100 - a4.avgInv)} | ${f2(100 - a7.avgInv)} | ${cash0(pe4Run)} | ${cash0(run)} |`);
        }
        void median;
      },
    };
  };

  const order: PId[] = ["PE7"];
  const verdicts: Verdict[] = [], specs: CandSpec[] = [];
  for (const id of order) { const sp = mkSpec(id); specs.push(sp); verdicts.push(evaluate(h, W, sp)); }
  console.log(`\n=== 구간별 CAGR / MDD — 069500(새 기준선) · PE4(정기만, 재계산) · 후보 ===\n| 구간 | 069500 | PE4 | ${verdicts.map((v) => v.id).join(" | ")} |\n|---|---|---|${verdicts.map(() => "---").join("|")}|`);
  for (const [wn, w] of [...W.ALL, ["2026년 제외 (~2025-12-31)", ex26] as [string, typeof ex26]]) {
    const cell = (r: { dates: string[]; ret: number[] }): string => { const s = h.st(r, w); return `${f2(s.cagr)} / ${f2(s.mdd)}`; };
    console.log(`| ${wn} | ${cell(h.bhP)} | ${cell(pe4Run)} | ${verdicts.map((v) => cell(v.run)).join(" | ")} |`);
  }
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: PEAD_PRELIM_STUDY.priorTests });
  yearlyTable(h, W, [{ id: "PE4(재계산)", run: pe4Run }, ...verdicts.map((v) => ({ id: v.id, run: v.run }))]);
  seedReport(h, W, specs, new Map(verdicts.map((v) => [v.id, v.run])), (code, c) => { const s = byCode.get(code)!, i = s.idx.get(CAL[c]); return i === undefined ? NaN : s.avgTvRow[i]; });
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${verdicts.map((v) => v.trial).join(", ")}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

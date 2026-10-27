/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 PEAD 보유 단축 + 하락장 진입 차단: PE4(238)·PE5(239)·PE6(240). 후보당 1회 실행. 비교 열 PE1(연구 PEAD)은 같은 스냅샷으로 다시 계산한다(시도 수에 넣지 않음).
 * 사전 등록: docs/research/pead-short-hold-prereg.md. 가격 Parquet은 고정 스냅샷(데이터 종료일 2026-10-26)에서만 읽고, 재무·공시 목록은 연구 R이 Storage(research/r_allcap)에 모은 fin.parquet·filings.parquet를 읽기만 한다
 * (실행당 약 15 MiB 내려받기). 069500 기준선은 보조 파일(BENCH_AUX_069500=1, SHA-256 대조). DB·Storage 쓰기 0. 환경 변수 CAND_ONLY는 크래시 복구 전용이며 NONE이면 후보 시험 없이 새 기준선 표만 낸다(재무 자료도 읽지 않는다).
 */
import { simSlots, type SimCand, type SimPos, type SimRun } from "@/lib/slotSim";
import { downloadBuf, decodeTable } from "@/lib/nBookStore";
import { eventsByCorp, type FinRow, type FilingRow } from "@/lib/rFinMetrics";
import { R_STORE_PREFIX } from "@/lib/kodexSectorSatConfig";
import { R_SMALL_MCAP_MIN_EOK, R_SMALL_MCAP_MAX_EOK, R_SMALL_TV_MIN_WON, R_SMALL_PRICE_MIN_WON } from "@/lib/kodexSectorSatConfig";
import { SAT_KSIC_DIVISION_NAMES, SAT_SECTOR_UNCLASSIFIED } from "@/lib/satelliteV1Config";
import { PEAD_SHORT_CANDS, PEAD_SHORT_PRIOR_TESTS, PEAD_PE1_REF, PEAD_SEMCO, PEAD_MAX_POS, PEAD_COOLDOWN_DAYS, PEAD_RUN_START, PEAD_WINDOWS, PEAD_SLIPPAGE, PEAD_H_CAGR_GAIN_PP, PEAD_H_MDD_GAIN_PP, PEAD_H_MDD_GAIN_STRONG_PP, PEAD_H_CAGR_FLOOR_PP, PEAD_DEADLINES, PEAD_SEASON_BEFORE_DAYS, PEAD_SEASON_AFTER_DAYS, PEAD_DOWNTURNS } from "@/lib/peadConfig";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, xfer, SNAP_END, f2, avg, median, type S } from "./researchHarness";
import { evaluate, seedReport, yearlyTable, summaryReport, type CandSpec, type Verdict, type Windows } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
type PId = keyof typeof PEAD_SHORT_CANDS;
type UKind = "K200P" | "SMALL";
const SAMSUNG = "005930", HYNIX = "000660";
const HOLD_REASON = "보유 만료";
interface Episode { peakIdx: number; troughIdx: number; recIdx: number | null; depth: number }
interface Ev { code: string; rceptDt: string; r0: number; sig: number; qOi: number; qOiPrev: number; growth: number; up: boolean }

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
  console.log(`연구 PEAD 보유 단축·진입 차단 시험 시작(읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const only = new Set((process.env.CAND_ONLY || "PE4,PE5,PE6").split(",").map((x) => x.trim()).filter(Boolean));
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
  if (!(only.has("PE4") || only.has("PE5") || only.has("PE6"))) { console.log(`\n후보를 하나도 시험하지 않았다(사전 점검 모드: 새 기준선 표만 계산, 재무 자료 읽지 않음) | ${storageLine()} | Supabase 쓴 행 0 | 외부 요청 0 | 시도 번호 소진 없음`); return; }

  // ---- 069500 진입 차단 신호: 신호 확정일 069500 종가가 ma거래일 단순이동평균(그날 종가 포함) 아래이면 차단. 069500은 신호로만 쓴다. 가격 수준은 보조 파일 일수익률을 이어 곱해 만든다(이동평균 비교는 배율에 무관). ----
  const bhPx: number[] = [1];
  for (let i = 0; i < h.bhP.ret.length; i++) bhPx.push(bhPx[i] * (1 + h.bhP.ret[i] / 100));
  const bhDates = ["", ...h.bhP.dates];
  const bhIdxAt = (c: number): number => { const d = CAL[c]; let lo = 1, hi = bhDates.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (bhDates[m] <= d) { k = m; lo = m + 1; } else hi = m - 1; } return k; };
  const blockCache = new Map<string, boolean>();
  const blockedAt = (c: number, ma: number): boolean => {
    if (ma <= 0) return false;
    const key = `${ma}|${c}`;
    let v = blockCache.get(key);
    if (v === undefined) {
      const i = bhIdxAt(c);
      if (i < 0 || i < ma) v = false;
      else { let sum = 0; for (let t = i - ma + 1; t <= i; t++) sum += bhPx[t]; v = bhPx[i] < sum / ma; }
      blockCache.set(key, v);
    }
    return v;
  };

  // ---- 재무·공시 자료(Storage 읽기만) ----
  const tab = async (name: string): Promise<Record<string, string | number | null>[]> => {
    const b = await downloadBuf(`${R_STORE_PREFIX}/${name}`);
    if (!b) throw new Error(`${R_STORE_PREFIX}/${name} 없음`);
    xfer.bytes += b.byteLength;
    return (await decodeTable(b)) as Record<string, string | number | null>[];
  };
  const finRows = (await tab("fin.parquet")) as unknown as FinRow[], filRows = (await tab("filings.parquet")) as unknown as FilingRow[];
  console.log(`재무 자료: fin ${finRows.length}행, filings ${filRows.length}행`);
  const stockOfCorp = new Map<string, string>();
  for (const r of finRows) if (r.stock_code) stockOfCorp.set(r.corp_code, r.stock_code);
  const evOrig = eventsByCorp(finRows, filRows); // 원본(비정정) 접수 이벤트만. 정정 점 시점 재계산 이벤트는 신호로 쓰지 않는다.

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
  const evs: Ev[] = [];
  for (const [corp, list] of evOrig) {
    const code = stockOfCorp.get(corp), s = code ? byCode.get(code) : undefined;
    if (!s) continue;
    for (const e of list) {
      if (e.qOi === null || e.qOiPrev === null) continue;
      const r0 = lowerBound(e.rceptDt), sig = r0 + 1;
      if (sig >= nCal - 1 || sig < cS) continue;
      evs.push({ code: s.code, rceptDt: e.rceptDt, r0, sig, qOi: e.qOi, qOiPrev: e.qOiPrev, growth: e.qOiPrev > 0 ? e.qOi / e.qOiPrev - 1 : NaN, up: closeAtOrBefore(s, sig) > closeAtOrBefore(s, r0) });
    }
  }
  const evU: Record<UKind, Map<number, Ev[]>> = { K200P: new Map(), SMALL: new Map() };
  for (const e of evs) for (const k of ["K200P", "SMALL"] as UKind[]) if (inU(k, e.sig, e.code)) { const l = evU[k].get(e.sig) ?? []; l.push(e); evU[k].set(e.sig, l); }
  console.log(`분기 영업이익·전년 동기 값이 있는 원본 접수 이벤트(신호 확정일 ${PEAD_RUN_START} 이후): 전체 ${evs.length}건 | K200P 안 ${[...evU.K200P.values()].reduce((a, l) => a + l.length, 0)}건 | SMALL 안 ${[...evU.SMALL.values()].reduce((a, l) => a + l.length, 0)}건`);

  const env = { CAL, nCal, cS, adjustments: h.adjustments, endedBefore: h.endedBefore, stockBuyMult: h.stockBuyMult, sellRate: h.sellRate, baseSlip: SLIPPAGE_PCT_PER_SIDE, bhRet: h.bhRet };
  const label = (code: string): string => `${code} ${nameOf.get(code) ?? "?"}`;
  const sectorOf = (c: string): string => indOf.get(c)?.slice(0, 2) ?? SAT_SECTOR_UNCLASSIFIED;
  const secLabel = (g: string): string => (g === SAT_SECTOR_UNCLASSIFIED ? g : `${g} ${SAT_KSIC_DIVISION_NAMES[g] ?? "?"}`);

  /** 후보 훅: 신호 확정일 c의 이벤트(영업이익 흑자 ∧ 전년 동기 흑자 ∧ 증가율 ≥ g ∧ 접수일 종가보다 신호 확정일 종가가 높음)를 증가율 큰 순(동률은 코드 오름차순)으로. 청산 = 체결(entryC) 후 N거래일이 지나면 다음 거래일 종가. */
  const hooksFor = (k: UKind, g: number, N: number, exclude?: Set<string>, ma = 0) => ({
    candsOf: (c: number): SimCand[] => {
      const l = evU[k].get(c);
      if (!l || blockedAt(c, ma)) return [];
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

  const pe1Run = simSlots(env, cfgFor("K200P"), hooksFor("K200P", PEAD_PE1_REF.growth, PEAD_PE1_REF.hold), { lag: 1, detail: true });
  { const s1 = h.st(pe1Run, FULL); console.log(`비교 열 PE1(K200P 증가율 ≥ 30% N = 40) 재계산: 전체 CAGR ${f2(s1.cagr)} / MDD ${f2(s1.mdd)} — 연구 PEAD ${PEAD_PE1_REF.cagr.toFixed(2)} / ${PEAD_PE1_REF.mdd.toFixed(2)}와 ${Math.abs(s1.cagr - PEAD_PE1_REF.cagr) < 0.006 && Math.abs(s1.mdd - PEAD_PE1_REF.mdd) < 0.006 ? "일치" : "불일치(보고만, 중단 안 함)"}`); }

  const mkSpec = (id: PId): CandSpec => {
    const cd = PEAD_SHORT_CANDS[id], k = cd.universe as UKind, cfg = cfgFor(k), ma = cd.ma;
    const nb: { label: string; run: () => SimRun }[] = [];
    for (const g2 of cd.growthNeighbors) nb.push({ label: `증가율 ≥ ${Math.round(g2 * 100)}%`, run: () => simSlots(env, cfg, hooksFor(k, g2, cd.hold, undefined, ma), { lag: 1 }) });
    for (const n2 of cd.holdNeighbors) nb.push({ label: `보유 N = ${n2}`, run: () => simSlots(env, cfg, hooksFor(k, cd.growth, n2, undefined, ma), { lag: 1 }) });
    for (const m2 of cd.maNeighbors) nb.push({ label: `069500 이동평균 ${m2}거래일`, run: () => simSlots(env, cfg, hooksFor(k, cd.growth, cd.hold, undefined, m2), { lag: 1 }) });
    return {
      id, trial: cd.trial, title: `K200P(코스피 보통주 시총 상위 200)${ma ? `, 신호 확정일 069500 종가가 ${ma}거래일 이동평균 아래이면 신규 진입 금지` : ""}, 분기 영업이익 > 0 ∧ 전년 동기 > 0 ∧ 증가율 ≥ ${Math.round(cd.growth * 100)}%, 접수일 다음 거래일 신호·그다음 거래일 체결(접수일 종가 대비 신호일 종가 상승만), ${cd.hold}거래일 보유 후 다음 거래일 매도, 슬리피지 ${PEAD_SLIPPAGE[k] * 100}%`,
      defense: false, capFrac: 1 / PEAD_MAX_POS, fDenominator: 3, ref: { id: "069500", run: bhAsRun },
      hRule: (full, rb) => { const a = hVs(full, rb), p1 = h.st(pe1Run, FULL); return { ok: a.ok, note: `${a.text} | 참고(판정 아님): PE1 ${f2(p1.cagr)} / ${f2(p1.mdd)} 대비 CAGR ${full.cagr - p1.cagr >= 0 ? "+" : ""}${f2(full.cagr - p1.cagr)}%p, MDD ${full.mdd - p1.mdd >= 0 ? "+" : ""}${f2(full.mdd - p1.mdd)}%p` }; },
      run: (o) => simSlots(env, cfg, hooksFor(k, cd.growth, cd.hold, o.exclude, ma), { lag: o.lag, int: o.int, replace: o.replace, detail: o.detail }),
      neighbors: nb,
      // 게이트 F: 같은 신호일·같은 주문 수로, 그날 유니버스 안 "비교 가능한 원본 접수 이벤트 중 접수일 종가보다 신호일 종가가 높은" 종목을 영업이익 조건 없이 무작위로 뽑는다. 청산 규칙(보유 N)은 같다.
      random: (rng, ordersByDay) => simSlots(env, cfg, {
        candsOf: (c, held, blocked) => {
          const n = ordersByDay.get(c) ?? 0;
          if (!n || blockedAt(c, ma)) return [];
          const pool = (evU[k].get(c) ?? []).filter((e) => e.up && !held(e.code) && !blocked(e.code)), out: SimCand[] = [];
          while (out.length < n && pool.length) { const e = pool.splice(Math.floor(rng() * pool.length), 1)[0]; out.push({ s: byCode.get(e.code)!, code: e.code }); }
          return out;
        },
        exitReason: hooksFor(k, cd.growth, cd.hold, undefined, ma).exitReason,
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
        E(`${id} lag 2`, simSlots(env, cfg, hooksFor(k, cd.growth, cd.hold, undefined, ma), { lag: 2, detail: true }));
        const top3 = [...run.trades].sort((a, b) => (b.proceeds - b.spend) / b.vAtEntry - (a.proceeds - a.spend) / a.vAtEntry).slice(0, 3);
        console.log(`${id} 상위 3개 거래(${top3.map((t) => `${label(t.code)} ${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")})를 069500 수익률로 바꾼 구간별 성적(= 제외)`);
        E(`${id} 상위 3개 거래 대체`, simSlots(env, cfg, hooksFor(k, cd.growth, cd.hold, undefined, ma), { lag: 1, detail: true, replace: new Set(top3.map((t) => `${t.code}|${t.entryC}`)) }));
        const secN = new Map<string, number>();
        for (const t of run.trades) secN.set(sectorOf(t.code), (secN.get(sectorOf(t.code)) ?? 0) + 1);
        console.log(`${id} 업종별(KSIC 2자리) 진입 분포(닫힌 거래 ${run.trades.length}건): ${[...secN].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([g, n]) => `${secLabel(g)} ${n}건(${f2((n / run.trades.length) * 100)}%)`).join(" | ")}`);
        const yearN = new Map<string, number>();
        for (const c of run.entryCs) yearN.set(CAL[c].slice(0, 4), (yearN.get(CAL[c].slice(0, 4)) ?? 0) + 1);
        console.log(`${id} 연도별 진입 건수: ${[...yearN].sort().map(([y, n]) => `${y} ${n}`).join(" | ")}`);
        const wsum = new Map<string, number>();
        let nDays = 0, invSum = 0;
        simSlots(env, cfg, hooksFor(k, cd.growth, cd.hold, undefined, ma), { lag: 1, onDay: (_c, V, held) => { nDays++; for (const [code, val] of held) { wsum.set(code, (wsum.get(code) ?? 0) + val / V); invSum += val / V; } } });
        const wavg = (code: string): number => ((wsum.get(code) ?? 0) / Math.max(nDays, 1)) * 100;
        console.log(`${id} 일별 평균 계좌 비중(현금 날 포함; ${nDays}일): 삼성전자 ${f2(wavg(SAMSUNG))}% · SK하이닉스 ${f2(wavg(HYNIX))}% · 합 ${f2(wavg(SAMSUNG) + wavg(HYNIX))}% | 투자분 중 두 종목 비중 ${f2(((wsum.get(SAMSUNG) ?? 0) + (wsum.get(HYNIX) ?? 0)) / Math.max(invSum, 1e-12) * 100)}% | 상위 8: ${[...wsum].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c2, v]) => `${label(c2)} ${f2((v / Math.max(nDays, 1)) * 100)}%`).join(", ")}`);
        // 삼성전기 2026-03 진입 거래를 069500으로 바꾼 성적(보고용)
        const semco = run.trades.filter((t) => t.code === PEAD_SEMCO.code && CAL[t.entryC].startsWith(PEAD_SEMCO.entryMonth));
        if (semco.length) {
          console.log(`${id} 삼성전기 ${PEAD_SEMCO.entryMonth} 진입 거래 ${semco.map((t) => `${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")}를 069500으로 바꾼(= 제외) 구간별 성적`);
          E(`${id} 삼성전기 제외`, simSlots(env, cfg, hooksFor(k, cd.growth, cd.hold, undefined, ma), { lag: 1, detail: true, replace: new Set(semco.map((t) => `${t.code}|${t.entryC}`)) }));
        } else console.log(`${id} 삼성전기 ${PEAD_SEMCO.entryMonth} 진입 거래 없음`);
        if (ma > 0) {
          // 차단 신호: 같은 이벤트 조건(흑자·증가율·가격 상승)을 통과했지만 069500 이동평균 차단으로 사지 않은 신호
          const sigs: Ev[] = [];
          let blockedDays = 0, allDays = 0;
          for (let c = cS; c < nCal - 1; c++) { allDays++; const b = blockedAt(c, ma); if (b) blockedDays++; const l = evU[k].get(c); if (b && l) for (const e of l) if (e.qOi > 0 && e.qOiPrev > 0 && e.growth >= cd.growth - 1e-12 && e.up) sigs.push(e); }
          console.log(`${id} 069500 ${ma}거래일 이동평균 차단: 차단일 ${blockedDays}/${allDays}일(${f2((blockedDays / allDays) * 100)}%) | 차단으로 건너뛴 신호(조건 통과 이벤트) ${sigs.length}건, 신호일 ${new Set(sigs.map((e) => e.sig)).size}일`);
          const yb = new Map<string, number>(), mb = new Map<string, number>();
          for (const e of sigs) { const d = CAL[e.sig]; yb.set(d.slice(0, 4), (yb.get(d.slice(0, 4)) ?? 0) + 1); mb.set(d.slice(0, 7), (mb.get(d.slice(0, 7)) ?? 0) + 1); }
          console.log(`${id} 차단 신호 연도별: ${[...yb].sort().map(([y, n]) => `${y} ${n}`).join(" | ")}`);
          console.log(`${id} 차단 신호 월별(건수 상위 12): ${[...mb].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([m, n]) => `${m} ${n}`).join(" | ")}`);
          const bd = [...new Set(sigs.map((e) => CAL[e.sig]))].sort();
          console.log(`${id} 차단 신호가 있던 날짜(${bd.length}일): ${bd.length > 60 ? `${bd.slice(0, 30).join(", ")} … ${bd.slice(-10).join(", ")}` : bd.join(", ")}`);
          // 참고용(시험 아님): ① 차단 없는 같은 정의 실행에서 신호일이 차단일인 거래의 성과 ② 차단 신호만 샀다면의 가정 포트폴리오
          const base = simSlots(env, cfgFor(k), hooksFor(k, cd.growth, cd.hold), { lag: 1, detail: true });
          const onBlocked = base.trades.filter((t) => blockedAt(t.entryC - 1, ma));
          const rets = onBlocked.map((t) => (t.proceeds / t.spend - 1) * 100), restRets = base.trades.filter((t) => !blockedAt(t.entryC - 1, ma)).map((t) => (t.proceeds / t.spend - 1) * 100);
          console.log(`${id} [참고, 시험 아님] 차단 없는 같은 정의(N=${cd.hold}, 증가율 ≥ ${Math.round(cd.growth * 100)}%) 실행의 거래 ${base.trades.length}건 중 신호일이 차단일인 거래 ${onBlocked.length}건: 평균 거래 수익률 ${f2(avg(rets))}%, 승률 ${f2((rets.filter((x) => x > 0).length / Math.max(rets.length, 1)) * 100)}% | 나머지 ${restRets.length}건: 평균 ${f2(avg(restRets))}%, 승률 ${f2((restRets.filter((x) => x > 0).length / Math.max(restRets.length, 1)) * 100)}%`);
          const only2 = simSlots(env, cfgFor(k), { candsOf: (c) => (blockedAt(c, ma) ? hooksFor(k, cd.growth, cd.hold).candsOf(c) : []), exitReason: hooksFor(k, cd.growth, cd.hold).exitReason }, { lag: 1, detail: true });
          console.log(`${id} [참고, 시험 아님] 차단 신호만 샀다면(같은 슬롯·보유 규칙) 구간별 성적, 진입 ${only2.entryCs.length}건, 평균 거래 수익률 ${f2(avg(only2.trades.map((t) => (t.proceeds / t.spend - 1) * 100)))}%`);
          E(`${id} 차단 신호만(가정)`, only2);
        }
        void median;
      },
    };
  };

  const order = (["PE4", "PE5", "PE6"] as PId[]).filter((id) => only.has(id));
  const verdicts: Verdict[] = [], specs: CandSpec[] = [];
  for (const id of order) { const sp = mkSpec(id); specs.push(sp); verdicts.push(evaluate(h, W, sp)); }
  console.log(`\n=== 구간별 CAGR / MDD — 069500(새 기준선) · PE1(재계산) · 후보 ===\n| 구간 | 069500 | PE1 | ${verdicts.map((v) => v.id).join(" | ")} |\n|---|---|---|${verdicts.map(() => "---").join("|")}|`);
  for (const [wn, w] of [...W.ALL, ["2026년 제외 (~2025-12-31)", ex26] as [string, typeof ex26]]) {
    const cell = (r: { dates: string[]; ret: number[] }): string => { const s = h.st(r, w); return `${f2(s.cagr)} / ${f2(s.mdd)}`; };
    console.log(`| ${wn} | ${cell(h.bhP)} | ${cell(pe1Run)} | ${verdicts.map((v) => cell(v.run)).join(" | ")} |`);
  }
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: PEAD_SHORT_PRIOR_TESTS });
  yearlyTable(h, W, [{ id: "PE1(재계산)", run: pe1Run }, ...verdicts.map((v) => ({ id: v.id, run: v.run }))]);
  seedReport(h, W, specs, new Map(verdicts.map((v) => [v.id, v.run])), (code, c) => { const s = byCode.get(code)!, i = s.idx.get(CAL[c]); return i === undefined ? NaN : s.avgTvRow[i]; });
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([kk, v]) => `${kk} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${verdicts.map((v) => v.trial).join(", ")}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 RG: 대형주 집중 전략(L3·LM2·LM3)에 운영 카드와 같은 시장 국면 필터를 더한 RG1(217)·RG2(218)·RG3(219). 후보당 1회 실행.
 * 사전 등록: docs/research/megacap-regime-gate-prereg.md. 가격 Parquet(Actions 캐시)·월말 시장 목록(Storage 약 0.2 MiB)·적용된 조정 이벤트·KOSPI 지수·069500 가격만 읽는다(market_regime_daily 표는 읽지 않음). DB·Storage 쓰기 0.
 * 국면 계산은 lib/marketRegime(Compute)(main 2b3791f 복사)를 그대로 쓰고 구성 종목은 연구 K200P(월말 구성 + 당일 시총, 제외 규칙, 20일 평균 거래대금 5억)다. 환경 변수 CAND_ONLY는 크래시 복구 전용.
 */
import { simSlots, type SimCand, type SimRun, type SimHooks } from "@/lib/slotSim";
import { L_SLIPPAGE, L_EVAL_AFTER } from "@/lib/megacapTrendConfig";
import { LS_COOLDOWN_DAYS } from "@/lib/megacapTrailingConfig";
import { LM_CANDS, LM_SKIP, LM_RANK_DEPTH } from "@/lib/megacapMomentumConfig";
import { RG_CANDS, RG_PRIOR_TESTS, RG_CONFIRM_NEIGHBORS, RG1_KEEP_NEIGHBORS, RG_H_CAGR_GAIN_PP, RG_H_MDD_GAIN_PP, RG_H_MDD_GAIN_STRONG_PP, RG_H_CAGR_FLOOR_PP } from "@/lib/megacapRegimeConfig";
import { computeRegimeRows, type BookStock, type PriceBook } from "@/lib/marketRegimeCompute";
import { confirmRegimes, regimeRuns, REGIME_LABELS, type Regime } from "@/lib/marketRegime";
import { REGIME_CONFIRM_DAYS, REGIME_INDEX_FROM } from "@/lib/marketRegimeConfig";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { loadHarness, loadK200P, dbRead, xfer, f2, avg, median, type S } from "./researchHarness";
import { evaluate, makeWindows, seedReport, yearlyTable, summaryReport, type CandSpec, type Verdict } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
type RId = keyof typeof RG_CANDS;
type Base = "L3" | "LM2" | "LM3";
const SAMSUNG = "005930", HYNIX = "000660";
const L3_DEF = { entryRank: 5, keepRank: 10, slots: 5 } as const;
interface Variant { slots: number; keepRank: number; keepMom: number; lookback: number }
interface Pool { items: { s: S; m: number }[]; rank: Map<string, number>; moms: number[] }
type Hooks = SimHooks<SimCand>;

async function main(): Promise<void> {
  console.log(`연구 RG 시험 시작(읽기 전용): ${new Date().toISOString()}`);
  const only = new Set((process.env.CAND_ONLY || "RG1,RG2,RG3").split(",").map((x) => x.trim()).filter(Boolean));
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, nameOf, kAt } = await loadK200P(h);
  const cS = CAL.findIndex((d) => d >= L_EVAL_AFTER);
  if (cS < 0) throw new Error(`${L_EVAL_AFTER} 이후 거래일 없음`);
  const W = makeWindows(h, cS + 1);
  console.log(`평가 시작 판단일 ${CAL[cS]}(달력 순번 ${cS}), 수익률 집계 ${CAL[cS + 1]}~${h.dataEnd} | 구간 ${W.NW.map(([n, w]) => `${n} ${w.from}~${w.to}`).join(" / ")}`);

  // ---- 시장 국면(운영 카드와 같은 계산): KOSPI 지수 + K200P 구성 종목(월말 구성, 당일 시총, 제외 규칙, 20일 평균 거래대금 5억)의 PIT 자료 ----
  const book: PriceBook = new Map();
  for (const s of h.stocks) {
    const prefix = new Float64Array(s.dates.length + 1);
    for (let i = 0; i < s.dates.length; i++) prefix[i + 1] = prefix[i] + s.close[i];
    const b: BookStock = { code: s.code, dates: s.dates, close: s.close, idx: s.idx, prefix, mcap: s.mcapRow, avgTv: s.avgTvRow };
    book.set(s.code, b);
  }
  const kospi = await getIndexPriceSeries("KOSPI", REGIME_INDEX_FROM, new Date().toISOString().slice(0, 10));
  dbRead["beta_price_history(KOSPI, 국면용)"] = kospi.length;
  const index = kospi.map((p) => ({ date: p.tradeDate, close: p.closePrice }));
  const idxDates = new Set(index.map((p) => p.date));
  const rdates = CAL.filter((d) => idxDates.has(d));
  console.log(`국면 계산: KOSPI 지수 ${index.length}행(${index[0]?.date}~${index[index.length - 1]?.date}), 거래일 ${rdates.length}/${nCal}일 (지수에 없는 거래일 ${nCal - rdates.length}일은 직전 국면 유지)`);
  const rows = computeRegimeRows({ index, book, dates: rdates, membersOn: (d) => kAt(d).map((s) => s.code), source: "backfill" });
  const raws = rows.map((r) => r.rawRegime);
  const confirmed = new Map<number, Regime[]>();
  confirmed.set(REGIME_CONFIRM_DAYS, rows.map((r) => r.regime));
  for (const k of RG_CONFIRM_NEIGHBORS) confirmed.set(k, confirmRegimes(raws, k));
  const same = confirmRegimes(raws, REGIME_CONFIRM_DAYS).every((r, i) => r === rows[i].regime);
  console.log(`국면 3일 확인 재현 점검: confirmRegimes(3) = computeRegimeRows 결과 ${same ? "일치" : "불일치"}`);
  const regimeByDate = (k: number): Map<string, Regime> => new Map(rdates.map((d, i) => [d, confirmed.get(k)![i]]));
  /** CAL 인덱스별 차단 여부(표시 국면이 약세·위기). 미정·중립·강세는 거래 허용. 지수가 없는 날은 직전 값 유지. */
  const blockedFor = (k: number): Uint8Array => {
    const m = regimeByDate(k), a = new Uint8Array(nCal);
    let prev = 0;
    for (let c = 0; c < nCal; c++) { const r = m.get(CAL[c]); if (r !== undefined) prev = r === "bear" || r === "crisis" ? 1 : 0; a[c] = prev; }
    return a;
  };
  const blockedBy = new Map<number, Uint8Array>([[REGIME_CONFIRM_DAYS, blockedFor(REGIME_CONFIRM_DAYS)], ...RG_CONFIRM_NEIGHBORS.map((k) => [k, blockedFor(k)] as [number, Uint8Array])]);
  const regime3 = regimeByDate(REGIME_CONFIRM_DAYS);
  const evalFrom = CAL[cS + 1];
  const evalRows = rows.filter((r) => r.tradeDate >= evalFrom);
  const cnt = (g: Regime): number => evalRows.filter((r) => r.regime === g).length;
  console.log(`국면(3일 확인) 일수 ${evalFrom}~: 강세 ${cnt("bull")} · 중립 ${cnt("neutral")} · 약세 ${cnt("bear")} · 위기 ${cnt("crisis")} · 미정 ${cnt("undefined")} (합 ${evalRows.length}) | 필터 차단일(약세+위기) ${cnt("bear") + cnt("crisis")}일`);
  const runs = regimeRuns(evalRows.map((r) => ({ date: r.tradeDate, regime: r.regime, kospiClose: r.kospiClose }))).filter((r) => r.regime === "bear" || r.regime === "crisis");
  console.log(`약세·위기 구간 ${runs.length}개: ${runs.map((r) => `${REGIME_LABELS[r.regime]} ${r.start}~${r.end}(${r.days}일)`).join(" | ")}`);

  // ---- 시총 순위·모멘텀(연구 L·LM과 같다) ----
  const megaCache = new Map<number, { list: S[]; rank: Map<string, number> }>();
  const megaAt = (c: number): { list: S[]; rank: Map<string, number> } => {
    let v = megaCache.get(c);
    if (!v) {
      const d = CAL[c], m = membAt(d), e: { s: S; mc: number }[] = [];
      if (m) for (const s of h.stocks) {
        const i = s.idx.get(d);
        if (i === undefined || excluded.has(s.code) || m.get(s.code) !== "KOSPI") continue;
        e.push({ s, mc: s.mcapRow[i] });
      }
      e.sort((a, b) => b.mc - a.mc || (a.s.code < b.s.code ? -1 : 1));
      const list = e.slice(0, LM_RANK_DEPTH).map((x) => x.s);
      v = { list, rank: new Map(list.map((s, k) => [s.code, k + 1])) };
      megaCache.set(c, v);
    }
    return v;
  };
  const momOf = (s: S, i: number, lb: number): number => { if (i < lb) return NaN; const a = s.close[i - LM_SKIP], b = s.close[i - lb]; return a > 0 && b > 0 ? a / b - 1 : NaN; };
  const poolCache = new Map<string, Pool>();
  const poolAt = (pool: number, lb: number, c: number): Pool => {
    const key = `${pool}|${lb}|${c}`;
    let v = poolCache.get(key);
    if (!v) {
      const d = CAL[c], items: { s: S; m: number }[] = [];
      for (const s of megaAt(c).list.slice(0, pool)) { const m = momOf(s, s.idx.get(d)!, lb); if (Number.isFinite(m)) items.push({ s, m }); }
      items.sort((a, b) => b.m - a.m || (a.s.code < b.s.code ? -1 : 1));
      v = { items, rank: new Map(items.map((x, k) => [x.s.code, k + 1])), moms: items.map((x) => x.m) };
      poolCache.set(key, v);
    }
    return v;
  };
  const outsiderRank = (pl: Pool, m: number): number => { let lo = 0, hi = pl.moms.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (pl.moms[mid] > m) lo = mid + 1; else hi = mid; } return 1 + lo; };

  const env = { CAL, nCal, cS, adjustments: h.adjustments, endedBefore: h.endedBefore, stockBuyMult: h.stockBuyMult, sellRate: h.sellRate, baseSlip: SLIPPAGE_PCT_PER_SIDE, bhRet: h.bhRet };
  const label = (code: string): string => `${code} ${nameOf.get(code) ?? "?"}`;
  const cfgFor = (slots: number, cooldown: number) => ({ slip: L_SLIPPAGE, maxPos: slots, capFrac: 1 / slots, cooldown });
  const baseCfg = (kind: Base, slots: number) => cfgFor(slots, kind === "L3" ? 0 : LS_COOLDOWN_DAYS);
  const baseVariant = (kind: Base): Variant => kind === "L3" ? { slots: L3_DEF.slots, keepRank: L3_DEF.keepRank, keepMom: 0, lookback: 0 } : { slots: LM_CANDS[kind].slots, keepRank: 0, keepMom: LM_CANDS[kind].keepMom, lookback: LM_CANDS[kind].lookback };

  /** 기저 전략의 후보·청산 훅(연구 L의 L3, 연구 LM의 LM2·LM3와 같다). */
  const baseHooks = (kind: Base, v: Variant, exclude?: Set<string>): Hooks => {
    if (kind === "L3") return {
      candsOf: (c) => megaAt(c).list.slice(0, L3_DEF.entryRank).filter((s) => !exclude?.has(s.code)).map((s) => ({ s, code: s.code })),
      exitReason: (p, c, i) => (i === undefined ? null : (megaAt(c).rank.get(p.code) ?? Number.POSITIVE_INFINITY) > v.keepRank ? "시총 순위 밖" : null),
    };
    const cd = LM_CANDS[kind];
    return {
      candsOf: (c) => {
        const pl = poolAt(cd.pool, v.lookback, c), out: SimCand[] = [];
        for (let k = 0; k < v.slots && k < pl.items.length; k++) { const it = pl.items[k]; if (it.m > 0 && !exclude?.has(it.s.code)) out.push({ s: it.s, code: it.s.code }); }
        return out;
      },
      exitReason: (p, c, i) => {
        if (i === undefined) return null;
        if ((megaAt(c).rank.get(p.code) ?? Number.POSITIVE_INFINITY) > cd.keepCap) return "시총 순위 밖";
        const m = momOf(byCode.get(p.code)!, i, v.lookback);
        if (!Number.isFinite(m)) return null;
        const pl = poolAt(cd.pool, v.lookback, c);
        return (pl.rank.get(p.code) ?? outsiderRank(pl, m)) > v.keepMom ? "모멘텀 순위 밖" : null;
      },
    };
  };
  /** 국면 필터: 표시 국면이 약세·위기인 판단일에는 보유 전량 청산 주문(행이 없어도), 신규 편입 후보 없음. */
  const withRegime = (base: Hooks, blocked: Uint8Array): Hooks => ({
    candsOf: (c, held, bl) => (blocked[c] ? [] : base.candsOf(c, held, bl)),
    exitReason: (p, c, i) => (blocked[c] ? "국면 필터" : base.exitReason(p, c, i)),
  });

  // ---- 기저 전략(필터 없음)을 같은 엔진으로 다시 계산해 기존 결과와 일치하는지 확인 ----
  const baseRuns = new Map<Base, SimRun>();
  for (const id of Object.keys(RG_CANDS) as RId[]) {
    const kind = RG_CANDS[id].base as Base, v = baseVariant(kind);
    const run = simSlots(env, baseCfg(kind, v.slots), baseHooks(kind, v), { lag: 1, detail: true });
    baseRuns.set(kind, run);
    const f = h.st(run, W.FULL), ref = RG_CANDS[id].ref;
    console.log(`기저 ${kind} 재계산(게이트 H 기준): 전체 CAGR ${f2(f.cagr)} / MDD ${f2(f.mdd)} — 기존 결과 ${ref.cagr.toFixed(2)} / ${ref.mdd.toFixed(2)}와 ${Math.abs(f.cagr - ref.cagr) < 0.006 && Math.abs(f.mdd - ref.mdd) < 0.006 ? "일치" : "불일치(보고만, 중단 안 함)"}`);
  }

  const bhFrom = { dates: h.bhP.dates.filter((d) => d >= W.FULL.from), ret: h.bhP.ret.filter((_, k) => h.bhP.dates[k] >= W.FULL.from) };
  const mkSpec = (id: RId): CandSpec => {
    const rc = RG_CANDS[id], kind = rc.base as Base, bv = baseVariant(kind), blocked3 = blockedBy.get(REGIME_CONFIRM_DAYS)!;
    const mk = (v: Variant, blocked: Uint8Array, exclude?: Set<string>): Hooks => withRegime(baseHooks(kind, v, exclude), blocked);
    const cfg = baseCfg(kind, bv.slots), baseRun = baseRuns.get(kind)!;
    const nb: { label: string; run: () => SimRun }[] = [];
    for (const k of RG_CONFIRM_NEIGHBORS) nb.push({ label: `국면 확인 ${k}일`, run: () => simSlots(env, cfg, mk(bv, blockedBy.get(k)!), { lag: 1 }) });
    if (kind === "L3") for (const k of RG1_KEEP_NEIGHBORS) nb.push({ label: `순위 매도 한도 ${k}`, run: () => simSlots(env, cfg, mk({ ...bv, keepRank: k }, blocked3), { lag: 1 }) });
    else if (kind === "LM2") for (const k of LM_CANDS.LM2.slotsNeighbors) nb.push({ label: `보유 수 ${k}`, run: () => simSlots(env, baseCfg(kind, k), mk({ ...bv, slots: k }, blocked3), { lag: 1 }) });
    else for (const k of LM_CANDS.LM3.lookbackNeighbors) nb.push({ label: `룩백 ${k}일`, run: () => simSlots(env, cfg, mk({ ...bv, lookback: k }, blocked3), { lag: 1 }) });
    return {
      id, trial: rc.trial, title: `${kind} + 시장 국면 필터(약세·위기이면 전량 매도·신규 편입 금지, 3일 확인)`, defense: false, capFrac: 1 / bv.slots, fDenominator: 3,
      ref: { id: kind, run: baseRun },
      hRule: (full, ref) => {
        const dc = full.cagr - ref.cagr, dm = ref.mdd - full.mdd;
        const c1 = dc >= RG_H_CAGR_GAIN_PP, c2 = dm >= RG_H_MDD_GAIN_PP && dc >= -RG_H_CAGR_FLOOR_PP;
        return { ok: c1 || c2, note: `CAGR ${dc >= 0 ? "+" : ""}${f2(dc)}%p, MDD ${dm >= 0 ? "−" : "+"}${f2(Math.abs(dm))}%p(개선 ${f2(dm)}%p; ${RG_H_MDD_GAIN_STRONG_PP}%p 이상 ${dm >= RG_H_MDD_GAIN_STRONG_PP ? "O" : "X"}) → 조건1(CAGR +${RG_H_CAGR_GAIN_PP}%p) ${c1 ? "O" : "X"}, 조건2(MDD 개선 ${RG_H_MDD_GAIN_PP}%p ∧ CAGR ≥ −${RG_H_CAGR_FLOOR_PP}%p) ${c2 ? "O" : "X"}` };
      },
      run: (o) => simSlots(env, cfg, mk(bv, blocked3, o.exclude), { lag: o.lag, int: o.int, replace: o.replace, detail: o.detail }),
      neighbors: nb,
      // 풀 = 필터가 허용하는 날의 편입 가능 후보(기저 전략의 후보 규칙) 중 보유·재진입 금지가 아닌 종목(LM은 풀 안 모멘텀 양(+) 종목 전체). 신호일마다 실제 매수 주문 수만큼 무작위로 고른다.
      random: (rng, ordersByDay) => simSlots(env, cfg, withRegime({
        candsOf: (c, held, bl) => {
          const n = ordersByDay.get(c) ?? 0;
          if (!n) return [];
          const src: SimCand[] = kind === "L3" ? baseHooks(kind, bv).candsOf(c, held, bl) : poolAt(LM_CANDS[kind].pool, bv.lookback, c).items.filter((it) => it.m > 0).map((it) => ({ s: it.s, code: it.s.code }));
          const pool = src.filter((x) => !held(x.code) && !bl(x.code)), out: SimCand[] = [];
          while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
          return out;
        },
        exitReason: baseHooks(kind, bv).exitReason,
      }, blocked3), { lag: 1 }),
      reasons: ["시총 순위 밖", "모멘텀 순위 밖", "국면 필터", "폐지"],
      label,
      extra: (run) => {
        const E = (name: string, r: SimRun): void => { for (const [wn, w] of W.ALL) { const s = h.st(r, w), b = h.st(h.bhP, w), l = h.st(baseRun, w); console.log(`  ${name} | ${wn}: CAGR ${f2(s.cagr)} / MDD ${f2(s.mdd)} (069500 ${f2(b.cagr)} / ${f2(b.mdd)}, ${kind} ${f2(l.cagr)} / ${f2(l.mdd)})`); } };
        console.log(`${id} 진입 ${run.entryCs.length}건 · 보유일 중앙값 ${f2(median(run.trades.map((t) => t.exitC - t.entryC)))}일 · 평균 보유 종목 수(전체 날) ${f2(avg(run.nPos))}`);
        // 국면별 보유 일수·투자 비중
        console.log(`${id} 국면별(3일 확인 표시 국면) 일수 · 평균 투자 비중 · 현금 100% 일수\n| 국면 | 일수 | 평균 투자 비중 % | 현금 100% 일수 | 평균 보유 종목 수 |\n|---|---|---|---|---|`);
        for (const g of ["bull", "neutral", "bear", "crisis", "undefined"] as Regime[]) {
          const ix: number[] = [];
          for (let k = 0; k < run.dates.length; k++) if ((regime3.get(run.dates[k]) ?? "undefined") === g) ix.push(k);
          console.log(`| ${REGIME_LABELS[g]} | ${ix.length} | ${f2(avg(ix.map((k) => run.inv[k])) * 100)} | ${ix.filter((k) => run.nPos[k] === 0).length} | ${f2(avg(ix.map((k) => run.nPos[k])))} |`);
        }
        const fsales = run.trades.filter((t) => t.reason === "국면 필터");
        let episodes = 0;
        for (let c = cS + 1; c < nCal; c++) if (blocked3[c] && !blocked3[c - 1]) episodes++;
        console.log(`${id} 필터 발동: 차단 구간(약세·위기 진입) ${episodes}회, 필터 매도 ${fsales.length}건 / 닫힌 거래 ${run.trades.length}건(${f2((fsales.length / Math.max(run.trades.length, 1)) * 100)}%)`);
        for (const [name, f, t] of [["2020-03 전후(2020-01~2020-06)", "2020-01-01", "2020-06-30"], ["2022", "2022-01-01", "2022-12-31"], ["2026-09~10", "2026-09-01", "2026-10-31"]] as const) {
          const hits = fsales.filter((x) => CAL[x.exitC] >= f && CAL[x.exitC] <= t);
          const byDay = new Map<string, number>();
          for (const x of hits) byDay.set(CAL[x.exitC], (byDay.get(CAL[x.exitC]) ?? 0) + 1);
          console.log(`  필터 현금화 체결일 ${name}: ${hits.length ? [...byDay].map(([d, n]) => `${d} (${n}종목)`).join(", ") : "없음"}`);
        }
        console.log(`${id} 학습 구간(2011~2016) 연도별 수익률 후보 − 069500 (%p): ${[2011, 2012, 2013, 2014, 2015, 2016].map((y) => { const a = h.yearRet(run, y), b = h.yearRet(bhFrom, y); return `${y} ${a - b >= 0 ? "+" : ""}${f2(a - b)}`; }).join(" | ")}`);
        console.log(`${id} 하루 지연(lag 2) 구간별 성적`);
        E(`${id} lag 2`, simSlots(env, cfg, mk(bv, blocked3), { lag: 2, detail: true }));
        const top3 = [...run.trades].sort((a, b) => (b.proceeds - b.spend) / b.vAtEntry - (a.proceeds - a.spend) / a.vAtEntry).slice(0, 3);
        console.log(`${id} 상위 3개 거래(${top3.map((t) => `${label(t.code)} ${CAL[t.entryC]}~${CAL[t.exitC]} ${f2((t.proceeds / t.spend - 1) * 100)}%`).join(", ")})를 069500 수익률로 바꾼 구간별 성적(= 제외)`);
        E(`${id} 상위 3개 거래 대체`, simSlots(env, cfg, mk(bv, blocked3), { lag: 1, detail: true, replace: new Set(top3.map((t) => `${t.code}|${t.entryC}`)) }));
        console.log(`${id} 하락 구간 성과 (누적 % / MDD %)`);
        for (const [name, f, t] of [["2020-03", "2020-03-01", "2020-03-31"], ["2022", "2022-01-01", "2022-12-31"], ["2026-10-01~10-15", "2026-10-01", "2026-10-15"]] as const) console.log(`  ${name}: ${id} ${h.periodStat(run, f, t)} | 069500 ${h.periodStat(h.bhP, f, t)} | ${kind} ${h.periodStat(baseRun, f, t)}`);
        for (const [wn, w] of W.ALL) { const s = h.st(run, w); console.log(`  ${id} | ${wn}: 평균 투자 비중 ${f2(s.avgInv)}% / 현금 비중 ${f2(100 - s.avgInv)}% / 평균 보유 종목 수 ${f2(s.avgN)}`); }
        const wsum = new Map<string, number>();
        let nDays = 0, invSum = 0;
        simSlots(env, cfg, mk(bv, blocked3), { lag: 1, onDay: (_c, V, held) => { nDays++; for (const [code, val] of held) { wsum.set(code, (wsum.get(code) ?? 0) + val / V); invSum += val / V; } } });
        const wavg = (code: string): number => ((wsum.get(code) ?? 0) / Math.max(nDays, 1)) * 100;
        console.log(`${id} 일별 평균 계좌 비중(현금 날 포함, 열린 포지션 포함; ${nDays}일): 삼성전자 ${f2(wavg(SAMSUNG))}% · SK하이닉스 ${f2(wavg(HYNIX))}% · 합 ${f2(wavg(SAMSUNG) + wavg(HYNIX))}% | 투자분 중 두 종목 비중 ${f2(((wsum.get(SAMSUNG) ?? 0) + (wsum.get(HYNIX) ?? 0)) / Math.max(invSum, 1e-12) * 100)}% | 상위 8: ${[...wsum].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${label(k)} ${f2((v / Math.max(nDays, 1)) * 100)}%`).join(", ")}`);
      },
    };
  };

  const order = (["RG1", "RG2", "RG3"] as RId[]).filter((id) => only.has(id));
  const verdicts: Verdict[] = [], specs: CandSpec[] = [];
  for (const id of order) { const sp = mkSpec(id); specs.push(sp); verdicts.push(evaluate(h, W, sp)); }
  console.log(`\n=== 구간별 CAGR / MDD — 069500 · 기저(필터 없음) · 후보 ===\n| 구간 | 069500 | ${verdicts.map((v) => `${RG_CANDS[v.id as RId].base} 기저 | ${v.id}`).join(" | ")} |\n|---|---|${verdicts.map(() => "---|---").join("")}`);
  for (const [wn, w] of W.ALL) { const b = h.st(h.bhP, w); console.log(`| ${wn} | ${f2(b.cagr)} / ${f2(b.mdd)} | ${verdicts.map((v) => { const l = h.st(baseRuns.get(RG_CANDS[v.id as RId].base as Base)!, w), s = h.st(v.run, w); return `${f2(l.cagr)} / ${f2(l.mdd)} | ${f2(s.cagr)} / ${f2(s.mdd)}`; }).join(" | ")} |`); }
  summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: RG_PRIOR_TESTS });
  yearlyTable(h, W, [...new Set(verdicts.map((v) => RG_CANDS[v.id as RId].base as Base))].map((b) => ({ id: `${b}(기저)`, run: baseRuns.get(b)! })).concat(verdicts.map((v) => ({ id: v.id, run: v.run }))));
  seedReport(h, W, specs, new Map(verdicts.map((v) => [v.id, v.run])), (code, c) => { const s = byCode.get(code)!, i = s.idx.get(CAL[c]); return i === undefined ? NaN : s.avgTvRow[i]; });
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${Object.values(dbRead).reduce((a, b) => a + b, 0)}`);
  console.log(`Storage 내려받기 합계 ${(xfer.bytes / 1048576).toFixed(2)} MiB(가격 Parquet은 Actions 캐시로 읽어 0) | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${verdicts.map((v) => v.trial).join(", ")}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

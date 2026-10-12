/** [임시 연구 — 병합 금지, 읽기 전용] ma_cross v2 강화 연구 1~2단계: R0 재현, MDD 구성 분석, 진입일 피처 진단. */
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { computeSMA } from "@/lib/sma";
import {
  buildCtx, computeADX, computeRSI, stockFeatures, genTrades, newAcc, addTrades, sliceMetrics, fmtMetrics, loadSeries,
  SLICES, PERIOD_START, LEARN_END, CONFIRM_START, TODAY, type Acc, type Trade, type Ctx,
} from "./research-ma-lab";

const FEATURES = ["adx14", "rsi14", "slope200_20d", "gap200", "slope50_20d", "tvChange20", "pos52wHigh", "vol60d", "marketCapEok", "breadth200", "kospiAbove200"];

function stat(ts: Trade[]): string {
  if (ts.length === 0) return "n=0";
  const w = ts.filter((t) => t.returnPct > 0), l = ts.filter((t) => t.returnPct <= 0);
  const aw = w.reduce((s, t) => s + t.returnPct, 0) / Math.max(w.length, 1);
  const al = l.reduce((s, t) => s + t.returnPct, 0) / Math.max(l.length, 1);
  return `n=${ts.length} 승률 ${((w.length / ts.length) * 100).toFixed(1)}% 평균 ${((ts.reduce((s, t) => s + t.returnPct, 0) / ts.length) * 100).toFixed(2)}% 손익비 ${al !== 0 ? (aw / Math.abs(al)).toFixed(2) : "-"}`;
}
const winPct = (ts: Trade[]): number => (ts.length ? (ts.filter((t) => t.returnPct > 0).length / ts.length) * 100 : NaN);
const avgPct = (ts: Trade[]): number => (ts.length ? (ts.reduce((s, t) => s + t.returnPct, 0) / ts.length) * 100 : NaN);
const quantile = (sorted: number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

async function main(): Promise<void> {
  console.log(`ma_cross v2 연구 진단 시작(in-sample): ${new Date().toISOString()}`);
  const series = await loadSeries();
  const kospi = await getIndexPriceSeries("KOSPI", PERIOD_START, TODAY);
  const kClose = kospi.map((p) => p.closePrice);
  const k200 = computeSMA(kClose, 200);
  const kospiAbove = new Map<string, number>();
  kospi.forEach((p, i) => { const m = k200[i]; if (m !== undefined) kospiAbove.set(p.tradeDate, p.closePrice > m ? 1 : 0); });
  const kospiClose = new Map(kospi.map((p) => [p.tradeDate, p.closePrice]));
  console.log(`KOSPI ${kospi.length}행 ${kospi[0]?.tradeDate}~${kospi[kospi.length - 1]?.tradeDate}, 200일선 계산 가능 시작 ${[...kospiAbove.keys()][0]}`);

  const acc0 = newAcc();
  const accD: Record<number, Acc> = { 5: newAcc(), 10: newAcc() };
  const breadthTot = new Map<string, number>();
  const breadthAbove = new Map<string, number>();
  const ewSum = new Map<string, number>();
  const ewCnt = new Map<string, number>();
  const ctxCache = new Map<string, Ctx>(); // R0 거래가 있는 종목만 보관(창 분석용)

  for (const [code, rows] of series) {
    const ctx = buildCtx(code, rows);
    const { n, entryOk, closes, sLong, prices } = ctx;
    for (let i = 1; i < n; i++) {
      const d = prices[i].date;
      if (d < PERIOD_START) continue;
      if (entryOk(i - 1)) {
        ewSum.set(d, (ewSum.get(d) ?? 0) + closes[i] / closes[i - 1] - 1);
        ewCnt.set(d, (ewCnt.get(d) ?? 0) + 1);
      }
      const l = sLong[i];
      if (l !== undefined && entryOk(i)) {
        breadthTot.set(d, (breadthTot.get(d) ?? 0) + 1);
        if (closes[i] > l) breadthAbove.set(d, (breadthAbove.get(d) ?? 0) + 1);
      }
    }
    const trades = genTrades(ctx, { name: "R0" });
    if (trades.length > 0) {
      const adx = computeADX(prices, 14);
      const rsi = computeRSI(closes, 14);
      for (const t of trades) t.feat = stockFeatures(ctx, adx, rsi, t.eIdx);
      addTrades(acc0, ctx, trades);
      ctxCache.set(code, ctx);
      for (const d of [5, 10]) addTrades(accD[d], ctx, genTrades(ctx, { name: `지연${d}`, delay: d }));
    }
  }
  for (const t of acc0.trades) {
    const tot = breadthTot.get(t.buyDate);
    t.feat!.breadth200 = tot ? (breadthAbove.get(t.buyDate) ?? 0) / tot : NaN;
    t.feat!.kospiAbove200 = kospiAbove.get(t.buyDate) ?? NaN;
  }

  console.log("\n=== [0] R0 재현 (사용자 지정 R0: 3.5% / MDD 55.8% / 승률 30.4% / 손익비 4.17 / 3,949건) ===");
  for (const [label, s, e] of SLICES) console.log(`R0 ${label}: ${fmtMetrics(sliceMetrics(acc0, s, e))}`);
  const byYear = new Map<string, number>();
  for (const t of acc0.trades) byYear.set(t.buyDate.slice(0, 4), (byYear.get(t.buyDate.slice(0, 4)) ?? 0) + 1);
  console.log(`R0 진입 연도별 거래 수: ${JSON.stringify(Object.fromEntries([...byYear].sort()))}`);

  // ---------- [1] MDD 구성 분석 ----------
  console.log("\n=== [1] R0 MDD 구성 분석 ===");
  const dates = [...acc0.dailyReturns.keys()].sort();
  const rbar = dates.map((d) => { const e = acc0.dailyReturns.get(d)!; return e.reduce((s, x) => s + x.returnPct, 0) / e.length; });
  const holdN = dates.map((d) => acc0.dailyReturns.get(d)!.length);
  console.log(`R0 일별 시계열: ${dates.length}일(보유 종목이 있는 날), 평균 동시 보유 ${(holdN.reduce((a, b) => a + b, 0) / holdN.length).toFixed(1)}종목, 중앙 ${[...holdN].sort((a, b) => a - b)[Math.floor(holdN.length / 2)]}, 최대 ${Math.max(...holdN)}`);
  interface Ep { peakIdx: number; troughIdx: number; depth: number; recoverIdx: number | null }
  const eps: Ep[] = [];
  {
    let eq = 100, peak = 100, peakIdx = -1, cur: Ep | null = null;
    for (let t = 0; t < rbar.length; t++) {
      eq *= 1 + rbar[t];
      if (eq >= peak) { if (cur) { cur.recoverIdx = t; eps.push(cur); cur = null; } peak = eq; peakIdx = t; }
      else {
        const dd = ((peak - eq) / peak) * 100;
        if (!cur) cur = { peakIdx, troughIdx: t, depth: dd, recoverIdx: null };
        else if (dd > cur.depth) { cur.depth = dd; cur.troughIdx = t; }
      }
    }
    if (cur) eps.push(cur);
  }
  eps.sort((a, b) => b.depth - a.depth);
  const closeOnOrBefore = (d: string): number | undefined => { let best: string | undefined; for (const k of kospiClose.keys()) if (k <= d && (best === undefined || k > best)) best = k; return best ? kospiClose.get(best) : undefined; };
  const dateIdxCache = new Map<string, Map<string, number>>();
  const idxOf = (code: string): Map<string, number> => {
    let m = dateIdxCache.get(code);
    if (!m) { m = new Map(ctxCache.get(code)!.prices.map((p, i) => [p.date, i])); dateIdxCache.set(code, m); }
    return m;
  };
  for (const [k, ep] of eps.slice(0, 3).entries()) {
    const peakDate = ep.peakIdx >= 0 ? dates[ep.peakIdx] : PERIOD_START;
    const troughDate = dates[ep.troughIdx];
    const win = dates.map((d, t) => ({ d, t })).filter(({ t }) => t > ep.peakIdx && t <= ep.troughIdx);
    const Ls = win.reduce((s, { t }) => s + Math.log(1 + rbar[t]), 0);
    const mWin = win.map(({ d }) => (ewCnt.get(d) ? ewSum.get(d)! / ewCnt.get(d)! : 0));
    const Lm = mWin.reduce((s, m) => s + Math.log(1 + m), 0);
    let eqm = 1, pk = 1, ddm = 0;
    for (const m of mWin) { eqm *= 1 + m; if (eqm > pk) pk = eqm; ddm = Math.max(ddm, (pk - eqm) / pk); }
    const kp = closeOnOrBefore(peakDate), kt = closeOnOrBefore(troughDate);
    const hold = win.map(({ t }) => holdN[t]);
    console.log(`\n[MDD 구간 #${k + 1}] 고점 ${peakDate} → 저점 ${troughDate} (${win.length}거래일), 낙폭 ${ep.depth.toFixed(1)}%, 회복 ${ep.recoverIdx !== null ? dates[ep.recoverIdx] : "미회복"}`);
    console.log(`  보유 종목 수: 평균 ${(hold.reduce((a, b) => a + b, 0) / hold.length).toFixed(1)} / 최소 ${Math.min(...hold)} / 최대 ${Math.max(...hold)} (구간 내 항상 ≥1종목 보유 = 노출도 100%, 기법상 현금 구간 없음)`);
    console.log(`  R0 구간 수익 ${((Math.exp(Ls) - 1) * 100).toFixed(1)}% | 같은 날들의 동일가중 유니버스(일별 리밸런싱, PIT 5천억·유동성 필터) ${((Math.exp(Lm) - 1) * 100).toFixed(1)}% (구간 내 최대낙폭 ${(ddm * 100).toFixed(1)}%) | KOSPI(고점일→저점일) ${kp && kt ? ((kt / kp - 1) * 100).toFixed(1) + "%" : "n/a"}`);
    console.log(`  로그 분해: 전체 ln=${Ls.toFixed(3)} = 시장(동일가중) ${Lm.toFixed(3)} + 초과/종목효과 ${(Ls - Lm).toFixed(3)}  → 시장 몫 ${Ls !== 0 ? ((Lm / Ls) * 100).toFixed(0) : "-"}%, 종목 초과 몫 ${Ls !== 0 ? (((Ls - Lm) / Ls) * 100).toFixed(0) : "-"}%`);
    // 종목 기여 분해
    const contrib = new Map<string, number>();
    for (const { d } of win) { const es = acc0.dailyReturns.get(d)!; for (const e of es) contrib.set(e.stockCode, (contrib.get(e.stockCode) ?? 0) + e.returnPct / es.length); }
    const arr = [...contrib.values()];
    const neg = arr.filter((v) => v < 0).reduce((a, b) => a + b, 0), pos = arr.filter((v) => v > 0).reduce((a, b) => a + b, 0);
    const sortedNeg = arr.filter((v) => v < 0).sort((a, b) => a - b);
    const top10 = sortedNeg.slice(0, 10).reduce((a, b) => a + b, 0);
    console.log(`  종목별 기여(산술합, 보유 종목 ${arr.length}개): 손실 종목 합 ${(neg * 100).toFixed(1)}%p (${sortedNeg.length}개), 이익 종목 합 ${(pos * 100).toFixed(1)}%p, 손실 상위 10종목 합 ${(top10 * 100).toFixed(1)}%p (손실 합의 ${neg !== 0 ? ((top10 / neg) * 100).toFixed(0) : "-"}%)`);
    // 손절선 교차 후 기여
    const totalArith = win.reduce((s, { t }) => s + rbar[t], 0);
    for (const x of [0.15, 0.25]) {
      let cnt = 0, post = 0, crossed = 0;
      for (const tr of acc0.trades) {
        if (tr.buyDate > troughDate || tr.sellDate <= peakDate) continue;
        cnt++;
        const ctx = ctxCache.get(tr.code)!;
        const entry = ctx.prices[tr.eIdx].close;
        let cross = -1;
        for (let i = tr.eIdx + 1; i <= tr.sIdx; i++) if (ctx.prices[i].close <= entry * (1 - x)) { cross = i; break; }
        if (cross === -1) continue;
        const di = idxOf(tr.code);
        let touched = false;
        for (let i = cross + 1; i <= tr.sIdx; i++) {
          const d = ctx.prices[i].date;
          if (d <= peakDate || d > troughDate) continue;
          const es = acc0.dailyReturns.get(d);
          if (!es) continue;
          touched = true;
          post += (ctx.closes[i] / ctx.closes[i - 1] - 1) / es.length;
        }
        void di;
        if (touched) crossed++;
      }
      console.log(`  진입가 -${x * 100}% 종가 도달 후 구간 내 기여(산술합): ${(post * 100).toFixed(1)}%p / 구간 전체 변화 ${(totalArith * 100).toFixed(1)}%p (구간 겹친 거래 ${cnt}건 중 도달 후 구간에 남은 거래 ${crossed}건) — 손절이 있었다면 그 기여분이 0이 됐을 근사치(보유 종목 수 변화에 따른 재분배는 반영 안 함)`);
    }
  }

  // ---------- [2] 피처 진단 ----------
  console.log("\n=== [2] 진입일 피처 진단 (R0 모든 거래, 진입일 종가까지의 정보) ===");
  const learn = acc0.trades.filter((t) => t.buyDate <= LEARN_END);
  const conf = acc0.trades.filter((t) => t.buyDate >= CONFIRM_START);
  console.log(`학습 거래 ${learn.length}, 확인 거래 ${conf.length}. 3분위 경계는 학습 구간 거래의 피처 분포에서만 계산해 두 구간에 같은 경계를 적용.`);
  console.log("규칙: 일관 = 두 구간 모두 (T3−T1) 승률 격차와 평균수익률 격차의 부호가 같고, 두 구간 모두 |승률 격차| ≥ 3%p");
  const summary: string[] = [];
  for (const f of FEATURES) {
    const lv = learn.map((t) => t.feat![f]).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (lv.length < 30) { console.log(`[${f}] 학습 구간 유효값 ${lv.length}개 — 생략`); continue; }
    const binary = f === "kospiAbove200";
    const c1 = binary ? 0.5 : quantile(lv, 1 / 3), c2 = binary ? 0.5 : quantile(lv, 2 / 3);
    const bucket = (t: Trade): number => { const v = t.feat![f]; if (!Number.isFinite(v)) return -1; return binary ? (v > 0.5 ? 2 : 0) : v <= c1 ? 0 : v <= c2 ? 1 : 2; };
    console.log(`\n[${f}] 경계 ${binary ? "0/1 (T1=코스피 200일선 아래, T3=위)" : `T1≤${c1.toPrecision(4)} < T2 ≤${c2.toPrecision(4)} < T3`}`);
    const res: Record<string, Record<number, Trade[]>> = { 학습: { 0: [], 1: [], 2: [] }, 확인: { 0: [], 1: [], 2: [] } };
    let miss = 0;
    for (const [lab, set] of [["학습", learn], ["확인", conf]] as const) for (const t of set) { const b = bucket(t); if (b < 0) { miss++; continue; } res[lab][b].push(t); }
    for (const lab of ["학습", "확인"]) for (const b of binary ? [0, 2] : [0, 1, 2]) console.log(`  ${lab} T${b + 1}: ${stat(res[lab][b])}`);
    console.log(`  (값 없음으로 제외 ${miss}건)`);
    const gw = (lab: string): number => winPct(res[lab][2]) - winPct(res[lab][0]);
    const ga = (lab: string): number => avgPct(res[lab][2]) - avgPct(res[lab][0]);
    const consistent = Math.sign(gw("학습")) === Math.sign(gw("확인")) && Math.sign(ga("학습")) === Math.sign(ga("확인")) && Math.abs(gw("학습")) >= 3 && Math.abs(gw("확인")) >= 3;
    const worst = [0, 1, 2].filter((b) => res.학습[b].length > 0).sort((a, b) => winPct(res.학습[a]) - winPct(res.학습[b]))[0];
    const line = `${f}: 승률격차(T3−T1) 학습 ${gw("학습").toFixed(1)}%p / 확인 ${gw("확인").toFixed(1)}%p, 평균격차 학습 ${ga("학습").toFixed(2)}%p / 확인 ${ga("확인").toFixed(2)}%p → ${consistent ? "일관" : "불일치/약함"}; 학습 최저승률 구간 T${worst + 1}`;
    console.log(`  ${line}`);
    summary.push(line);
  }
  console.log("\n--- 피처 일관성 요약 ---");
  for (const s of summary) console.log(s);

  // ---------- 골든크로스 후 N일 유지 (지연 진입) ----------
  console.log("\n=== [3] 골든크로스 후 N거래일 유지 여부 (미래 정보 — 진입 필터 불가, 지연 진입으로만 평가) ===");
  for (const d of [5, 10]) {
    const surv = acc0.trades.filter((t) => t.sIdx > t.gIdx + d);
    const non = acc0.trades.filter((t) => t.sIdx <= t.gIdx + d);
    console.log(`N=${d}: 유지(원 진입 기준) ${stat(surv)} | 미유지 ${stat(non)}`);
    for (const [lab, s, e] of SLICES) {
      const sv = surv.filter((t) => t.buyDate >= s && t.buyDate <= e), nv = non.filter((t) => t.buyDate >= s && t.buyDate <= e);
      const dl = accD[d].trades.filter((t) => t.buyDate >= s && t.buyDate <= e);
      console.log(`  ${lab}: 유지 원진입 ${stat(sv)} | 미유지 ${stat(nv)} | 지연 진입 ${stat(dl)}`);
    }
    for (const [label, s, e] of SLICES) console.log(`  지연 ${d}일 전략 ${label}: ${fmtMetrics(sliceMetrics(accD[d], s, e))}`);
  }
  console.log("\n완료");
}
main().catch((e) => { console.error(e); process.exit(1); });

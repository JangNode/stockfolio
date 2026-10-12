/**
 * [임시 연구 — 병합 금지, 읽기 전용] ma_cross v2 단계적 강화 연구 라운드 실행기.
 * 사전 등록: research/ma-rounds-prereg-R1.md(공통 규칙) + research/rounds/round{N}.json(후보 정의). 환경변수 ROUND(기본 1), MODE=eval|diag.
 */
import fs from "node:fs";
import {
  buildCtx, computeADX, computeRSI, stockFeatures, genTrades, newAcc, addTrades, sliceMetrics, calmar, loadSeries,
  PERIOD_START, LEARN_END, CONFIRM_START, TODAY, type Acc, type Ctx, type Rule, type Trade, type SliceMetrics,
} from "./research-ma-lab";
import { PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";

interface Clause { f: string; gt?: number; ge?: number; lt?: number; le?: number }
interface Cand { name: string; clauses: Clause[] }
interface RoundFile { round: number; baseline: Cand; candidates: Cand[] }

// 사전 등록 상수 (research/ma-rounds-prereg-R1.md 4항)
const ORIG_TRADES_MIN = 1975; // 원래 R0 3,949건의 50%
const ORIG_PAYOFF_MIN = 3.536; // 원래 R0 손익비 4.16의 85%
const SEG_MIN_EOK = 500;
const SEG_MAX_EOK = 5000;

const ROUND = Number(process.env.ROUND) || 1;
const PRIOR_ATTEMPTS = Number(process.env.PRIOR_ATTEMPTS) || 31; // 이 라운드 시작 전 누적 시도 횟수(수동 관리)
const MODE = process.env.MODE || "eval";
const round: RoundFile = JSON.parse(fs.readFileSync(`research/rounds/round${ROUND}.json`, "utf8"));

const indCache = new WeakMap<Ctx, { adx: Float64Array; rsi: Float64Array }>();
function ind(ctx: Ctx): { adx: Float64Array; rsi: Float64Array } {
  let v = indCache.get(ctx);
  if (!v) { v = { adx: computeADX(ctx.prices, 14), rsi: computeRSI(ctx.closes, 14) }; indCache.set(ctx, v); }
  return v;
}
const FEATURE_KEY: Record<string, string> = { pos52w: "pos52wHigh", rsi14: "rsi14", adx14: "adx14", gap200: "gap200", slope200_20d: "slope200_20d", slope50_20d: "slope50_20d", tvChange20: "tvChange20", vol60d: "vol60d", marketCapEok: "marketCapEok" };
function featureValue(ctx: Ctx, e: number, f: string): number {
  const { adx, rsi } = ind(ctx);
  return stockFeatures(ctx, adx, rsi, e)[FEATURE_KEY[f]];
}
function toRule(c: Cand): Rule {
  return {
    name: c.name,
    entryFilter: c.clauses.length === 0 ? undefined : (ctx, e) =>
      c.clauses.every((cl) => {
        const v = featureValue(ctx, e, cl.f);
        if (!Number.isFinite(v)) return false;
        return (cl.gt === undefined || v > cl.gt) && (cl.ge === undefined || v >= cl.ge) && (cl.lt === undefined || v < cl.lt) && (cl.le === undefined || v <= cl.le);
      }),
  };
}

interface Ext extends SliceMetrics { ev: number; hold: number; conc: number }
function ext(acc: Acc, start: string, end: string): Ext {
  const m = sliceMetrics(acc, start, end);
  const t = acc.trades.filter((x) => x.buyDate >= start && x.buyDate <= end);
  const hold = t.length ? t.reduce((s, x) => s + (Date.parse(x.sellDate) - Date.parse(x.buyDate)) / 86400000, 0) / t.length : 0;
  let sum = 0, cnt = 0;
  for (const [d, es] of acc.dailyReturns) if (d >= start && d <= end) { sum += es.length; cnt++; }
  return { ...m, ev: m.trades ? (m.winRate / 100) * (m.payoff + 1) - 1 : 0, hold, conc: cnt ? sum / cnt : 0 };
}
const fm = (m: Ext): string =>
  m.trades === 0 ? "거래 0건" : `CAGR ${m.cagr.toFixed(2)}% | MDD ${m.mdd.toFixed(2)}% | 승률 ${m.winRate.toFixed(1)}% | 손익비 ${m.payoff.toFixed(2)} | 기대값 ${(m.ev * 100).toFixed(2)}% | 거래 ${m.trades} | 평균보유 ${m.hold.toFixed(0)}일 | 평균동시보유 ${m.conc.toFixed(1)}`;

const quantile = (sorted: number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

async function main(): Promise<void> {
  console.log(`ma_cross 단계적 강화 라운드 ${ROUND} (${MODE}) 시작(in-sample): ${new Date().toISOString()}`);
  console.log(`기준선: ${JSON.stringify(round.baseline)}`);
  const series = await loadSeries();
  const cands = [round.baseline, ...round.candidates];
  const rules = cands.map(toRule);
  const main = new Map(cands.map((c) => [c.name, newAcc()]));
  const seg = new Map(cands.map((c) => [c.name, newAcc()]));
  const diagTrades: Trade[] = [];

  for (const [code, rows] of series) {
    const ctx = buildCtx(code, rows);
    if (ctx.goldens.length === 0) continue;
    const segCtx: Ctx = { ...ctx, entryOk: (i) => ctx.avgTv[i] >= PIT_MIN_AVG_TRADING_VALUE_WON && rows[i].marketCapEok >= SEG_MIN_EOK && rows[i].marketCapEok < SEG_MAX_EOK };
    series.delete(code);
    for (let k = 0; k < rules.length; k++) {
      const t = genTrades(ctx, rules[k]);
      addTrades(main.get(cands[k].name)!, ctx, t);
      if (MODE === "diag" && k === 0) {
        const { adx, rsi } = ind(ctx);
        for (const x of t) { x.feat = stockFeatures(ctx, adx, rsi, x.eIdx); diagTrades.push(x); }
      }
      if (MODE === "eval") addTrades(seg.get(cands[k].name)!, segCtx, genTrades(segCtx, rules[k]));
    }
  }

  if (MODE === "diag") {
    const learn = diagTrades.filter((t) => t.buyDate <= LEARN_END);
    console.log(`\n=== 진단(학습 구간만, 기준선 거래 ${learn.length}건; 경계는 학습 분포로 고정) ===`);
    const base = main.get(round.baseline.name)!;
    console.log(`기준선 학습: ${fm(ext(base, PERIOD_START, LEARN_END))}`);
    const out: string[] = [];
    for (const f of Object.keys(FEATURE_KEY)) {
      const key = FEATURE_KEY[f];
      const vals = learn.map((t) => t.feat![key]).filter(Number.isFinite).sort((a, b) => a - b);
      if (vals.length < 30) continue;
      const c1 = quantile(vals, 1 / 3), c2 = quantile(vals, 2 / 3);
      const b = [[] as Trade[], [] as Trade[], [] as Trade[]];
      for (const t of learn) { const v = t.feat![key]; if (!Number.isFinite(v)) continue; b[v <= c1 ? 0 : v <= c2 ? 1 : 2].push(t); }
      const st = (a: Trade[]): string => a.length ? `n=${a.length} 승률 ${((a.filter((t) => t.returnPct > 0).length / a.length) * 100).toFixed(1)}% 평균 ${((a.reduce((s, t) => s + t.returnPct, 0) / a.length) * 100).toFixed(2)}%` : "n=0";
      const win = (a: Trade[]): number => a.length ? a.filter((t) => t.returnPct > 0).length / a.length * 100 : NaN;
      const gap = win(b[2]) - win(b[0]);
      const worst = [0, 1, 2].sort((x, y) => win(b[x]) - win(b[y]))[0];
      console.log(`[${f}] 경계 ${c1.toPrecision(4)} / ${c2.toPrecision(4)} | T1 ${st(b[0])} | T2 ${st(b[1])} | T3 ${st(b[2])} | 승률격차(T3−T1) ${gap.toFixed(1)}%p | 학습 최저승률 T${worst + 1}`);
      out.push(`${f}\t${gap.toFixed(2)}\tT${worst + 1}\t${c1}\t${c2}`);
    }
    console.log("\nFEATURE_GAPS(feature, gap, worst, c1, c2)\n" + out.join("\n"));
    console.log("완료");
    return;
  }

  // ---- eval ----
  const bn = round.baseline.name;
  const B = { L: ext(main.get(bn)!, PERIOD_START, LEARN_END), C: ext(main.get(bn)!, CONFIRM_START, TODAY), F: ext(main.get(bn)!, PERIOD_START, TODAY), SL: ext(seg.get(bn)!, PERIOD_START, LEARN_END) };
  console.log(`\n=== 기준선 ${bn} ===\n학습: ${fm(B.L)}\n확인: ${fm(B.C)}\n전체: ${fm(B.F)}\n5천억 미만 복제 학습: ${fm(B.SL)}`);
  const adopted: { name: string; evL: number; calmarL: number }[] = [];
  for (const c of round.candidates) {
    const L = ext(main.get(c.name)!, PERIOD_START, LEARN_END);
    const SL = ext(seg.get(c.name)!, PERIOD_START, LEARN_END);
    const c1 = L.cagr > B.L.cagr && L.mdd <= B.L.mdd;
    const c6 = SL.cagr >= B.SL.cagr && SL.mdd <= B.SL.mdd;
    console.log(`\n[${c.name}] ${JSON.stringify(c.clauses)}\n  학습: ${fm(L)}\n  5천억 미만 복제 학습: ${fm(SL)}\n  학습 관문: 조건1 ${c1 ? "충족" : "미충족"} / 조건6 ${c6 ? "충족" : "미충족"} → ${c1 && c6 ? "통과" : "탈락(확인 구간 미평가)"}`);
    if (!(c1 && c6)) continue;
    const C = ext(main.get(c.name)!, CONFIRM_START, TODAY);
    const F = ext(main.get(c.name)!, PERIOD_START, TODAY);
    const c2 = C.cagr >= B.C.cagr && C.mdd <= B.C.mdd;
    const c3 = F.trades >= ORIG_TRADES_MIN;
    const c4 = F.payoff >= ORIG_PAYOFF_MIN;
    const c5 = F.ev >= B.F.ev;
    console.log(`  확인(1회): ${fm(C)}\n  전체: ${fm(F)}`);
    console.log(`  판정: 조건2 ${c2 ? "충족" : "미충족"}(확인 CAGR ${C.cagr.toFixed(2)} vs ${B.C.cagr.toFixed(2)}, MDD ${C.mdd.toFixed(2)} vs ${B.C.mdd.toFixed(2)}) / 조건3 ${c3 ? "충족" : "미충족"}(${F.trades} ≥ ${ORIG_TRADES_MIN}) / 조건4 ${c4 ? "충족" : "미충족"}(${F.payoff.toFixed(2)} ≥ ${ORIG_PAYOFF_MIN}) / 조건5 ${c5 ? "충족" : "미충족"}(${(F.ev * 100).toFixed(2)}% vs ${(B.F.ev * 100).toFixed(2)}%) → ${c2 && c3 && c4 && c5 ? "채택 가능" : "탈락"}`);
    if (c2 && c3 && c4 && c5) adopted.push({ name: c.name, evL: L.ev, calmarL: calmar(L) });
  }
  adopted.sort((a, b) => b.evL - a.evL);
  console.log(`\n라운드 ${ROUND} 채택 후보: ${adopted.length ? adopted.map((a) => `${a.name}(학습 기대값 ${(a.evL * 100).toFixed(2)}%)`).join(", ") : "없음"} → 새 기준선: ${adopted[0]?.name ?? "없음(연구 중단)"}`);
  console.log(`누적 시도 횟수: ${PRIOR_ATTEMPTS + round.candidates.length}회 (시작 전 ${PRIOR_ATTEMPTS} + 이번 ${round.candidates.length})`);
  console.log("완료");
}
main().catch((e) => { console.error(e); process.exit(1); });

/** [임시 연구 — 병합 금지, 읽기 전용] ma_cross v2 강화 연구 3~4단계: 사전 등록 B의 후보 실행·판정. */
import { SLIPPAGE_OVERRIDE } from "@/lib/transactionCostConfig";
import {
  buildCtx, computeADX, computeRSI, genTrades, newAcc, addTrades, sliceMetrics, fmtMetrics, calmar, loadSeries,
  PERIOD_START, LEARN_END, CONFIRM_START, TODAY, type Acc, type Ctx, type Rule, type Series, type SliceMetrics,
} from "./research-ma-lab";

// ---- 사전 등록 B 상수 ----
const R0_USER = { cagr: 3.5, mdd: 55.8, win: 30.4, payoff: 4.17, trades: 3949 };
const PASS = { cagrAdd: 1.0, mddSub: 3.0, win: 33, payoff: 3.9, trades: 1500 };
const F1_ADX_MIN_EXCL = 21.49; // ADX(14) > 21.49
const F2_RSI_MIN_EXCL = 54.53; // RSI(14) > 54.53
const F3_POS52W_MIN_EXCL = -0.1829; // 종가/52주 고가 - 1 > -0.1829
const ADX20 = 20; // 재평가 대상(시도 횟수에 세지 않음)
const STOP_1 = 0.15;
const STOP_2 = 0.25;
const SLIP_BASE = 0.001;
const SLIP_STRESS = 0.003;
const HIGH_LOOKBACK = 252;

const indCache = new WeakMap<Ctx, { adx: Float64Array; rsi: Float64Array }>();
function ind(ctx: Ctx): { adx: Float64Array; rsi: Float64Array } {
  let v = indCache.get(ctx);
  if (!v) { v = { adx: computeADX(ctx.prices, 14), rsi: computeRSI(ctx.closes, 14) }; indCache.set(ctx, v); }
  return v;
}
function pos52w(ctx: Ctx, e: number): number {
  let hi = -Infinity;
  for (let j = Math.max(0, e - (HIGH_LOOKBACK - 1)); j <= e; j++) if (ctx.prices[j].high > hi) hi = ctx.prices[j].high;
  return ctx.closes[e] / hi - 1;
}
const fADX20 = (ctx: Ctx, e: number): boolean => ind(ctx).adx[e] >= ADX20;
const f1 = (ctx: Ctx, e: number): boolean => ind(ctx).adx[e] > F1_ADX_MIN_EXCL;
const f2 = (ctx: Ctx, e: number): boolean => ind(ctx).rsi[e] > F2_RSI_MIN_EXCL;
const f3 = (ctx: Ctx, e: number): boolean => pos52w(ctx, e) > F3_POS52W_MIN_EXCL;

const FILTERS: Record<string, (ctx: Ctx, e: number) => boolean> = { F1_ADX: f1, F2_RSI: f2, F3_52W: f3 };
const BASE_RULES: Rule[] = [
  { name: "R0" },
  { name: "ADX>=20(재평가)", entryFilter: fADX20 },
  { name: "F1_ADX", entryFilter: f1 },
  { name: "F2_RSI", entryFilter: f2 },
  { name: "F3_52W", entryFilter: f3 },
  { name: "S1_-15%", stopPct: STOP_1 },
  { name: "S2_-25%", stopPct: STOP_2 },
];

function simulate(series: Series, rules: Rule[]): Map<string, Acc> {
  const accs = new Map(rules.map((r) => [r.name, newAcc()]));
  for (const [code, rows] of series) {
    const ctx = buildCtx(code, rows);
    if (ctx.goldens.length === 0) continue;
    for (const r of rules) addTrades(accs.get(r.name)!, ctx, genTrades(ctx, r));
  }
  return accs;
}

interface M { full: SliceMetrics; learn: SliceMetrics; confirm: SliceMetrics }
function metricsOf(acc: Acc): M {
  return {
    full: sliceMetrics(acc, PERIOD_START, TODAY),
    learn: sliceMetrics(acc, PERIOD_START, LEARN_END),
    confirm: sliceMetrics(acc, CONFIRM_START, TODAY),
  };
}
const pf = (b: boolean): string => (b ? "충족" : "미충족");

async function main(): Promise<void> {
  console.log(`ma_cross v2 연구 후보 실행(in-sample, 사전 등록 A=795ae79 / B=1cf3b8a): ${new Date().toISOString()}`);
  const series = await loadSeries();

  // ---- 슬리피지 0.1% (기본) ----
  SLIPPAGE_OVERRIDE.pct = SLIP_BASE;
  const base = simulate(series, BASE_RULES);
  const bm = new Map([...base].map(([k, a]) => [k, metricsOf(a)]));
  const r0 = bm.get("R0")!;
  const nonR0 = BASE_RULES.filter((r) => r.name !== "R0").map((r) => r.name);

  // 조합 규칙(B-3): 학습 Calmar가 R0_학습보다 높은 단독 필터/손절 중 최고 1개씩
  const r0LearnCalmar = calmar(r0.learn);
  const bestOf = (names: string[]): string | null => {
    const c = names.filter((n) => calmar(bm.get(n)!.learn) > r0LearnCalmar).sort((a, b) => calmar(bm.get(b)!.learn) - calmar(bm.get(a)!.learn));
    return c[0] ?? null;
  };
  const bestF = bestOf(Object.keys(FILTERS));
  const bestS = bestOf(["S1_-15%", "S2_-25%"]);
  let comboRule: Rule | null = null;
  if (bestF && bestS) {
    comboRule = { name: `COMBO(${bestF}+${bestS})`, entryFilter: FILTERS[bestF], stopPct: bestS.startsWith("S1") ? STOP_1 : STOP_2 };
    const ca = simulate(series, [comboRule]);
    base.set(comboRule.name, ca.get(comboRule.name)!);
    bm.set(comboRule.name, metricsOf(ca.get(comboRule.name)!));
  }
  console.log(`\n조합 규칙 적용: 필터 최고=${bestF ?? "없음"}, 손절 최고=${bestS ?? "없음"} (R0_학습 Calmar ${r0LearnCalmar.toFixed(3)}) → ${comboRule ? comboRule.name : "조합 미실행"}`);

  // ---- 슬리피지 0.3% ----
  SLIPPAGE_OVERRIDE.pct = SLIP_STRESS;
  const stressRules = [...BASE_RULES, ...(comboRule ? [comboRule] : [])];
  const stress = simulate(series, stressRules);
  const sm = new Map([...stress].map(([k, a]) => [k, metricsOf(a)]));
  SLIPPAGE_OVERRIDE.pct = SLIP_BASE;
  const r0s = sm.get("R0")!;

  console.log(`\nR0 (슬리피지 0.1%): 전체 ${fmtMetrics(r0.full)}\n  학습 ${fmtMetrics(r0.learn)}`);
  console.log(`R0 (슬리피지 0.3%): 전체 CAGR ${r0s.full.cagr.toFixed(2)}% MDD ${r0s.full.mdd.toFixed(2)}% | 학습 CAGR ${r0s.learn.cagr.toFixed(2)}% MDD ${r0s.learn.mdd.toFixed(2)}%`);

  // ---- 학습 구간 표 (전 후보) ----
  const names = ["R0", ...nonR0, ...(comboRule ? [comboRule.name] : [])];
  const scaledTrades = PASS.trades * (r0.learn.trades / r0.full.trades);
  console.log(`\n=== 학습 구간(2010~2018) 후보별 결과 — 학습 거래 수 기준 = 1,500 × ${r0.learn.trades}/${r0.full.trades} = ${scaledTrades.toFixed(0)} ===`);
  const eligible: string[] = [];
  for (const n of names) {
    const m = bm.get(n)!.learn;
    const sL = sm.get(n)!.learn;
    const c1 = m.cagr >= r0.learn.cagr + PASS.cagrAdd;
    const c2 = m.mdd <= r0.learn.mdd - PASS.mddSub;
    const c3 = m.trades >= scaledTrades;
    const c4 = sL.cagr >= r0s.learn.cagr;
    const counted = n !== "R0" && !n.startsWith("ADX>=20");
    const ok = counted && c1 && c2 && c3 && c4;
    if (ok) eligible.push(n);
    console.log(`[${n}] 학습 ${fmtMetrics(m)} | Calmar ${calmar(m).toFixed(3)} | 0.3% 학습 CAGR ${sL.cagr.toFixed(2)}% MDD ${sL.mdd.toFixed(2)}%` +
      (n === "R0" ? "" : ` | 선별: CAGR+1.0 ${pf(c1)}, MDD-3 ${pf(c2)}, 거래수 ${pf(c3)}, 0.3%≥R0 ${pf(c4)}${counted ? "" : " (선별 대상 아님, 표 전용)"} → ${ok ? "자격" : "탈락"}`));
  }
  console.log(`\n시도 횟수(이번 연구): 필터 3 + 손절 2 + 조합 ${comboRule ? 1 : 0} = ${5 + (comboRule ? 1 : 0)}회 (ADX>=20 재평가는 미산입). 누적(사용자 집계 10회 + 이번) = ${10 + 5 + (comboRule ? 1 : 0)}회.`);

  if (eligible.length === 0) {
    console.log("\n선별 통과 후보 없음 → 합격 없음. 확인 구간(2019~)은 평가하지 않음(사전 등록 B-4/B-5).");
    console.log("\n완료");
    return;
  }
  eligible.sort((a, b) => calmar(bm.get(b)!.learn) - calmar(bm.get(a)!.learn));
  const finalist = eligible[0];
  console.log(`\n선별 통과 후보: ${eligible.join(", ")} → 최종 후보(학습 Calmar 최고, 동률 시 단순한 규칙): ${finalist}`);

  // ---- 최종 후보 평가(1회) ----
  const fm = bm.get(finalist)!;
  const fs = sm.get(finalist)!;
  console.log(`\n=== 최종 후보 [${finalist}] 합격 판정 (사용자 지정 기준, 사전 등록 A 3항) ===`);
  console.log(`전체 ${fmtMetrics(fm.full)}`);
  console.log(`학습 ${fmtMetrics(fm.learn)}`);
  console.log(`확인(2019~, 1회 평가) ${fmtMetrics(fm.confirm)}  |  R0 확인 ${fmtMetrics(r0.confirm)}`);
  console.log(`슬리피지 0.3%: 전체 CAGR ${fs.full.cagr.toFixed(2)}% MDD ${fs.full.mdd.toFixed(2)}% (R0@0.3% CAGR ${r0s.full.cagr.toFixed(2)}%, R0@0.1% ${r0.full.cagr.toFixed(2)}%)`);
  const crit: [string, boolean, string][] = [
    ["1. CAGR ≥ R0+1.0%p (4.5%)", fm.full.cagr >= R0_USER.cagr + PASS.cagrAdd, `${fm.full.cagr.toFixed(2)}%`],
    ["2. MDD ≤ R0−3%p (52.8%)", fm.full.mdd <= R0_USER.mdd - PASS.mddSub, `${fm.full.mdd.toFixed(2)}%`],
    ["3. 승률 ≥ 33%", fm.full.winRate >= PASS.win, `${fm.full.winRate.toFixed(1)}%`],
    ["4. 손익비 ≥ 3.9", fm.full.payoff >= PASS.payoff, `${fm.full.payoff.toFixed(2)}`],
    ["5. 거래 ≥ 1,500", fm.full.trades >= PASS.trades, `${fm.full.trades}`],
    ["6. 슬리피지 0.3% CAGR ≥ R0@0.3%", fs.full.cagr >= r0s.full.cagr, `${fs.full.cagr.toFixed(2)}% vs ${r0s.full.cagr.toFixed(2)}%`],
    ["7a. 확인 CAGR ≥ R0_확인", fm.confirm.cagr >= r0.confirm.cagr, `${fm.confirm.cagr.toFixed(2)}% vs ${r0.confirm.cagr.toFixed(2)}%`],
    ["7b. 확인 MDD ≤ R0_확인", fm.confirm.mdd <= r0.confirm.mdd, `${fm.confirm.mdd.toFixed(2)}% vs ${r0.confirm.mdd.toFixed(2)}%`],
  ];
  for (const [n, ok, v] of crit) console.log(`  ${n}: ${pf(ok)} (${v})`);
  console.log(`\n최종 판정: ${crit.every(([, ok]) => ok) ? "합격" : "불합격"}`);
  console.log("\n완료");
}
main().catch((e) => { console.error(e); process.exit(1); });

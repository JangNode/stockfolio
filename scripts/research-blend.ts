/**
 * [임시 연구 — 병합 금지, 읽기 전용] 전략 조합 + 위험조정 점검(B1~B6). 새 신호 없음.
 * 사전 등록: research/blend-prereg.md. 구성요소 일별 수익률은 research-factor-strategies.ts(runStudy)가 같은 코드로 다시 계산한다.
 * 조합 리밸런싱 비용은 반영하지 않는다. 판정·추천 없이 숫자만 출력한다.
 */
import { computeCumulativeAndMdd, computeCagrPct } from "@/lib/strategyBacktestSummary";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { loadFundamentalsSeriesWithListedShares } from "@/lib/stockFundamentals";
import { PERIOD_START, TODAY } from "./research-ma-lab";
import { runStudy, type StudyInput, type StudyResult } from "./research-factor-strategies";

// ---- 사전 등록 상수 (research/blend-prereg.md) ----
const EVAL_START = "2017-04-01";
const LEARN_END = "2021-12-31";
const CONFIRM_START = "2022-01-01";
const LAST_COMPLETE_MONTH = (): string => { const d = new Date(TODAY + "T00:00:00Z"); d.setUTCDate(1); d.setUTCDate(0); return d.toISOString().slice(0, 7); }; // 직전 달(오늘이 속한 달은 미완결)
const TRADING_DAYS_PER_YEAR = 252;
const WORST_WINDOW_MONTHS = 12;
const PASS = { cagrGapPp: 1.5, maxMddPct: 35 };
const PRIOR_ATTEMPTS = 62;
const TOP_CONTRIB_N = 5;
const MS_DAY = 86_400_000;

const COMPONENTS = ["KOSPI", "D4", "D2", "v3", "peg_lynch", "F5", "F1", "F4"] as const;
type Comp = (typeof COMPONENTS)[number];
const BLENDS: { id: string; label: string; w: Partial<Record<Comp, number>> }[] = [
  { id: "B1", label: "D4 70 + peg 30", w: { D4: 0.7, peg_lynch: 0.3 } },
  { id: "B2", label: "D4 50 + peg 50", w: { D4: 0.5, peg_lynch: 0.5 } },
  { id: "B3", label: "D2 70 + peg 30", w: { D2: 0.7, peg_lynch: 0.3 } },
  { id: "B4", label: "D4 50 + v3 25 + peg 25", w: { D4: 0.5, v3: 0.25, peg_lynch: 0.25 } },
  { id: "B5", label: "v3 1/3 + peg 1/3 + F5 1/3", w: { v3: 1 / 3, peg_lynch: 1 / 3, F5: 1 / 3 } },
  { id: "B6", label: "D4 60 + F5 20 + peg 20", w: { D4: 0.6, F5: 0.2, peg_lynch: 0.2 } },
];

const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / MS_DAY;
const endCap = (e: string): string => (e > TODAY ? TODAY : e);
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const mean = (v: number[]): number => (v.length ? v.reduce((a, x) => a + x, 0) / v.length : NaN);
function std(v: number[]): number { if (v.length < 2) return NaN; const m = mean(v); return Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / (v.length - 1)); }
interface Series { dates: string[]; rets: number[] } // rets: 일별 수익률 %

function metrics(s: Series, start: string, end: string) {
  const r = s.rets.filter((_, i) => s.dates[i] >= start && s.dates[i] <= end);
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
  const cagr = computeCagrPct(totalReturnPct, start, endCap(end));
  const sd = std(r);
  return { cagr, mdd: mddPct, ratio: mddPct > 0 ? cagr / mddPct : NaN, vol: sd * Math.sqrt(TRADING_DAYS_PER_YEAR), sharpe: sd > 0 ? (mean(r) * TRADING_DAYS_PER_YEAR) / (sd * Math.sqrt(TRADING_DAYS_PER_YEAR)) : NaN };
}
const yearRet = (s: Series, y: number): number => computeCumulativeAndMdd(s.rets.filter((_, i) => s.dates[i].startsWith(`${y}-`))).totalReturnPct;
function monthly(s: Series, lastMonth: string): Map<string, number> {
  const m = new Map<string, number>();
  s.dates.forEach((d, i) => { const k = d.slice(0, 7); if (k > lastMonth) return; m.set(k, (m.get(k) ?? 1) * (1 + s.rets[i] / 100)); });
  for (const [k, v] of m) m.set(k, (v - 1) * 100);
  return m;
}
function worst12(mr: Map<string, number>, from: string, to: string): number {
  const ks = [...mr.keys()].filter((k) => k >= from && k <= to).sort();
  let worst = NaN;
  for (let i = 0; i + WORST_WINDOW_MONTHS <= ks.length; i++) {
    let v = 1;
    for (let j = i; j < i + WORST_WINDOW_MONTHS; j++) v *= 1 + mr.get(ks[j])! / 100;
    const r = (v - 1) * 100;
    if (!Number.isFinite(worst) || r < worst) worst = r;
  }
  return worst;
}
function corr(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
}

export async function runBlend(inp: StudyInput): Promise<void> {
  const origLog = console.log;
  let res: StudyResult;
  console.log = () => {}; // 요인 전략 실행 로그는 이번 보고에 쓰지 않는다(구성요소 시계열만 사용)
  try { res = await runStudy(inp); } finally { console.log = origLog; }
  const { calEval, cal } = res;

  // ---- 구성요소 일별 수익률 (calEval 날짜에 정렬, 값 없으면 0) ----
  const raw: Record<Comp, Series> = {
    KOSPI: { dates: res.kDates, rets: res.kRets },
    D4: { dates: res.baseSims.get("D4")!.dates, rets: res.baseSims.get("D4")!.ret },
    D2: { dates: res.baseSims.get("D2")!.dates, rets: res.baseSims.get("D2")!.ret },
    v3: { dates: cal, rets: res.v3Daily },
    peg_lynch: { dates: cal, rets: res.pegDaily },
    F5: { dates: res.sims.get("F5")!.dates, rets: res.sims.get("F5")!.ret },
    F1: { dates: res.sims.get("F1")!.dates, rets: res.sims.get("F1")!.ret },
    F4: { dates: res.sims.get("F4")!.dates, rets: res.sims.get("F4")!.ret },
  };
  const comp = {} as Record<Comp, Series>;
  for (const c of COMPONENTS) {
    const m = new Map(raw[c].dates.map((d, i) => [d, raw[c].rets[i]]));
    comp[c] = { dates: calEval, rets: calEval.map((d) => m.get(d) ?? 0) };
  }

  // ---- 조합 (월말 리밸런싱, 비용 없음) ----
  const monthEnd = new Set<string>();
  for (let k = 0; k + 1 < calEval.length; k++) if (calEval[k].slice(0, 7) !== calEval[k + 1].slice(0, 7)) monthEnd.add(calEval[k]);
  const blendSeries: Record<string, Series> = {};
  for (const b of BLENDS) {
    const keys = Object.keys(b.w) as Comp[];
    let val = keys.map((k) => b.w[k]!);
    const rets: number[] = [];
    let prev = 1;
    calEval.forEach((d, i) => {
      val = val.map((v, j) => v * (1 + comp[keys[j]].rets[i] / 100));
      const tot = val.reduce((a, x) => a + x, 0);
      rets.push((tot / prev - 1) * 100);
      prev = tot;
      if (monthEnd.has(d)) val = keys.map((k) => tot * b.w[k]!);
    });
    blendSeries[b.id] = { dates: calEval, rets };
  }

  const SLICES: [string, string, string][] = [["전체 2017-04~", EVAL_START, TODAY], ["학습 2017-04~2021-12", EVAL_START, LEARN_END], ["확인 2022-01~", CONFIRM_START, TODAY]];
  const lastMonth = LAST_COMPLETE_MONTH();
  const all: [string, Series][] = [...COMPONENTS.map((c): [string, Series] => [c, comp[c]]), ...BLENDS.map((b): [string, Series] => [`${b.id} ${b.label}`, blendSeries[b.id]])];
  const monthlyAll = new Map(all.map(([n, s]) => [n, monthly(s, lastMonth)]));
  const slMonths: Record<string, [string, string]> = { "전체 2017-04~": ["2017-04", lastMonth], "학습 2017-04~2021-12": ["2017-04", "2021-12"], "확인 2022-01~": ["2022-01", lastMonth] };

  console.log(`\n=== 전략 조합 + 위험조정 점검 (조합 리밸런싱 비용 미반영) ===`);
  console.log(`읽은 행 수: 재무 조회 종목 ${res.fundRows.stocks}개, stock_annual_fundamentals ${res.fundRows.annual}행, stock_dividend_history ${res.fundRows.dividend}행, beta_price_history(KOSPI) ${res.fundRows.kospi}행`);
  console.log(`누적 시도 횟수: ${PRIOR_ATTEMPTS} + ${BLENDS.length} = ${PRIOR_ATTEMPTS + BLENDS.length}회 | 월 단위 통계는 완결 달력월 2017-04~${lastMonth}만 사용`);
  for (const [lab, s, e] of SLICES) {
    console.log(`\n[${lab}]`);
    console.log("| 구성 | CAGR % | MDD % | CAGR÷MDD | 연변동성 % | 샤프 | 최악 12개월 % |");
    console.log("|---|---|---|---|---|---|---|");
    for (const [name, ser] of all) {
      const m = metrics(ser, s, e);
      const [a, b] = slMonths[lab];
      console.log(`| ${name} | ${f2(m.cagr)} | ${f2(m.mdd)} | ${f2(m.ratio)} | ${f2(m.vol)} | ${f2(m.sharpe)} | ${f2(worst12(monthlyAll.get(name)!, a, b))} |`);
    }
  }
  const years: number[] = [];
  for (let y = 2017; y <= Number(TODAY.slice(0, 4)); y++) years.push(y);
  console.log(`\n=== 연도별 수익률 % ===`);
  console.log("| 구성 | " + years.join(" | ") + " |");
  console.log("|---|" + years.map(() => "---").join("|") + "|");
  for (const [name, ser] of all) console.log(`| ${name} | ${years.map((y) => f2(yearRet(ser, y))).join(" | ")} |`);

  // ---- 상관 행렬 ----
  const months = [...monthlyAll.get("KOSPI")!.keys()].sort();
  console.log(`\n=== 구성요소 간 월 수익률 상관 행렬 (월 ${months.length}개) ===`);
  console.log("| | " + COMPONENTS.join(" | ") + " |");
  console.log("|---|" + COMPONENTS.map(() => "---").join("|") + "|");
  for (const a of COMPONENTS) {
    console.log(`| ${a} | ${COMPONENTS.map((b) => f2(corr(months.map((m) => monthlyAll.get(a)!.get(m) ?? 0), months.map((m) => monthlyAll.get(b)!.get(m) ?? 0)))).join(" | ")} |`);
  }

  // ---- peg_lynch 동시 보유 + 2021 기여 ----
  const cnt = (d: string): number => res.pegCnt.get(d) ?? 0;
  const avgCnt = (from: string, to: string): number => mean(calEval.filter((d) => d >= from && d <= to).map(cnt));
  console.log(`\n=== peg_lynch 구간별 평균 동시 보유 종목 수 (거래일 평균) ===`);
  console.log("| 구간 | 평균 동시 보유 |");
  console.log("|---|---|");
  const pegRows: [string, string, string][] = [["2021-03~2021-12", "2021-03-01", "2021-12-31"], ...years.filter((y) => y >= 2022).map((y): [string, string, string] => [`${y}`, `${y}-01-01`, `${y}-12-31`]), ["학습 2017-04~2021-12", EVAL_START, LEARN_END], ["확인 2022-01~", CONFIRM_START, TODAY], ["전체 2017-04~", EVAL_START, TODAY]];
  for (const [lab, a, b] of pegRows) console.log(`| ${lab} | ${f2(avgCnt(a, b))} |`);

  const contrib = new Map<string, { pp: number; days: number; growth: number }>();
  for (const t of res.pegTrades) {
    for (const { d, r } of t.days) {
      if (!d.startsWith("2021-")) continue;
      const c = contrib.get(t.code ?? "?") ?? { pp: 0, days: 0, growth: 1 };
      c.pp += (r / Math.max(cnt(d), 1)) * 100;
      c.days++;
      c.growth *= 1 + r;
      contrib.set(t.code ?? "?", c);
    }
  }
  console.log(`\n=== peg_lynch 2021년 수익 기여 상위 ${TOP_CONTRIB_N}개 종목 (기여 = 일별 수익률 ÷ 그날 보유 종목 수의 합, %p) ===`);
  console.log("| 종목 | 2021년 보유 거래일 | 2021년 보유 구간 복리 수익률 % | 기여 %p |");
  console.log("|---|---|---|---|");
  const top = [...contrib.entries()].sort((a, b) => b[1].pp - a[1].pp).slice(0, TOP_CONTRIB_N);
  if (!top.length) console.log("| (없음) | - | - | - |");
  for (const [code, c] of top) console.log(`| ${code} | ${c.days} | ${f2((c.growth - 1) * 100)} | ${f2(c.pp)} |`);
  console.log(`2021년 peg_lynch 전체 수익률(참고): ${f2(yearRet(comp.peg_lynch, 2021))}% | 기여 합계 ${f2([...contrib.values()].reduce((a, c) => a + c.pp, 0))}%p (단순 합, 복리 효과 제외)`);

  // ---- 사전 통과 기준 ----
  const d4Full = metrics(comp.D4, EVAL_START, TODAY);
  const kLearn = metrics(comp.KOSPI, EVAL_START, LEARN_END), kConf = metrics(comp.KOSPI, CONFIRM_START, TODAY);
  console.log(`\n=== 사전 통과 기준 (D4 전체 CAGR ${f2(d4Full.cagr)}; KOSPI CAGR÷MDD 학습 ${f2(kLearn.ratio)}, 확인 ${f2(kConf.ratio)}) ===`);
  console.log("| 조합 | 전체 CAGR | C1 | 전체 MDD | C2 | 학습 CAGR÷MDD | 확인 CAGR÷MDD | C3 | 통과 |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  const ox = (b: boolean): string => (b ? "O" : "X");
  const passers: { id: string; ratio: number }[] = [];
  for (const b of BLENDS) {
    const full = metrics(blendSeries[b.id], EVAL_START, TODAY), learn = metrics(blendSeries[b.id], EVAL_START, LEARN_END), conf = metrics(blendSeries[b.id], CONFIRM_START, TODAY);
    const c1 = full.cagr >= d4Full.cagr - PASS.cagrGapPp, c2 = full.mdd <= PASS.maxMddPct, c3 = learn.ratio >= kLearn.ratio && conf.ratio >= kConf.ratio;
    if (c1 && c2 && c3) passers.push({ id: b.id, ratio: full.ratio });
    console.log(`| ${b.id} ${b.label} | ${f2(full.cagr)} | ${ox(c1)} | ${f2(full.mdd)} | ${ox(c2)} | ${f2(learn.ratio)} | ${f2(conf.ratio)} | ${ox(c3)} | ${ox(c1 && c2 && c3)} |`);
  }
  passers.sort((a, b) => b.ratio - a.ratio);
  console.log(`통과 조합: ${passers.length ? passers.map((p) => p.id).join(", ") : "없음"}`);
  if (passers.length >= 2) console.log(`후보 규칙(전체 CAGR÷MDD 큰 쪽) 적용: ${passers[0].id}`);
  console.log("완료");
  void dayDiff;
}

async function main(): Promise<void> {
  console.log(`전략 조합 + 위험조정 점검 시작(읽기 전용): ${new Date().toISOString()}`);
  const adjustments = await loadAppliedAdjustments();
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear()); // 원본(조정 전)
  console.log(`종목 ${series.size}개 로드, 조정계수 ${adjustments.size}종목`);
  const kospi = await getIndexPriceSeries("KOSPI", PERIOD_START, TODAY);
  const loadFund: StudyInput["loadFund"] = async (code, lsFn) => {
    const r = await loadFundamentalsSeriesWithListedShares(code, lsFn);
    return { series: r.series, ls: r.listedSharesByFiscalYear };
  };
  await runBlend({ series, adjustments, kospi, loadFund });
}
if (process.argv[1] && process.argv[1].endsWith("research-blend.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

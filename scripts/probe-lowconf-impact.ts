/**
 * [임시 점검 — 병합 금지, 읽기 전용] low_confidence 가격조정 이벤트가 v3 백테스트에 미치는 영향 + 상장폐지 청산 스트레스.
 * DB는 stock_price_adjustment_events 조회만(쓰기 없음). 판정·추천 없이 숫자만 출력한다.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAllRows } from "@/lib/supabasePagination";
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { applyAdjustmentsInPlace, type AppliedAdjustment } from "@/lib/priceAdjustment";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { accumulateStockDailyReturns, computeCumulativeAndMdd, computeCagrPct, type DailyStockReturns } from "@/lib/strategyBacktestSummary";
import { buildCtx, genTrades, PERIOD_START, LEARN_END, CONFIRM_START, TODAY, type Ctx } from "./research-ma-lab";

const NEAR_HIGH_MIN_GAP = -0.1829;
const NEAR_HIGH_BARS = 252;
const ENDED_BEFORE_OFFSET_DAYS = 14;
const CAP_UNIVERSE_EOK = 5000;
const MIN_TV_WON = 500_000_000;
const BIG_DROP = 0.5;
const BIG_RISE = 2.0;
const CLEAN_TOLERANCE = 0.02;
const EXPECT = { cagr: "6.36", mdd: "53.31", trades: 2335 };
const STRESS = [-0.5, -0.9];
const STRESS_REASONS = ["감사의견", "자본전액잠식", "상장폐지유예기간종료"];
const DELISTING_CSV_BASE_URL = "https://raw.githubusercontent.com/FinanceData/fdr_krx_data_cache/master/data/listing/delisting";

interface Ev {
  stock_code: string; event_date: string; price_ratio: number | null; shares_ratio: number | null; volume_ratio: number | null;
  adjustment_factor: number; status: string; low_confidence_reason: string | null; post_adjust_close_ratio: number | null;
  halt_trading_days: number | null;
}
interface TR { code: string; buyDate: string; sellDate: string; ret: number; days: { d: string; r: number }[]; forced: boolean; affected: boolean }

function nearHighOk(ctx: Ctx, e: number): boolean {
  let hi = -Infinity;
  for (let j = Math.max(0, e - (NEAR_HIGH_BARS - 1)); j <= e; j++) if (ctx.prices[j].high > hi) hi = ctx.prices[j].high;
  return ctx.prices[e].close / hi - 1 > NEAR_HIGH_MIN_GAP;
}

interface Book { sum: Map<string, number>; cnt: Map<string, number>; trades: TR[] }
const newBook = (): Book => ({ sum: new Map(), cnt: new Map(), trades: [] });
function addTrade(b: Book, t: TR): void {
  b.trades.push(t);
  for (const { d, r } of t.days) { b.sum.set(d, (b.sum.get(d) ?? 0) + r); b.cnt.set(d, (b.cnt.get(d) ?? 0) + 1); }
}
const buildBook = (trades: TR[]): Book => { const b = newBook(); for (const t of trades) addTrade(b, t); return b; };

let CAL: string[] = [];
const inRange = (s: string, e: string): string[] => CAL.filter((d) => d >= s && d <= e);

interface M { cagr: number; mdd: number; win: number; payoff: number; trades: number }
function metrics(b: Book, start: string, end: string): M {
  const days = inRange(start, end);
  const daily = days.map((d) => { const c = b.cnt.get(d) ?? 0; return c === 0 ? 0 : ((b.sum.get(d) ?? 0) / c) * 100; });
  const { totalReturnPct, mddPct } = computeCumulativeAndMdd(daily);
  const t = b.trades.filter((x) => x.buyDate >= start && x.buyDate <= end);
  const wins = t.filter((x) => x.ret > 0), losses = t.filter((x) => x.ret <= 0);
  const aw = wins.reduce((s, x) => s + x.ret, 0) / Math.max(wins.length, 1);
  const al = losses.reduce((s, x) => s + x.ret, 0) / Math.max(losses.length, 1);
  return { cagr: computeCagrPct(totalReturnPct, start, end > TODAY ? TODAY : end), mdd: mddPct, win: t.length ? (wins.length / t.length) * 100 : 0, payoff: al !== 0 ? aw / Math.abs(al) : 0, trades: t.length };
}
const SLICES: [string, string, string][] = [["전체", PERIOD_START, TODAY], ["학습 2010~2018", PERIOD_START, LEARN_END], ["확인 2019~", CONFIRM_START, TODAY]];
const f2 = (x: number): string => x.toFixed(2);
const mean = (v: number[]): number => (v.length ? v.reduce((a, x) => a + x, 0) / v.length : NaN);
const median = (v: number[]): number => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

/** 인수 x(>=1 또는 그 역수)가 정수 배(>=2)에 가까운지. */
function isCleanFactor(f: number): boolean {
  if (!(f > 0)) return false;
  const x = f >= 1 ? f : 1 / f;
  const k = Math.round(x);
  return k >= 2 && Math.abs(x / k - 1) <= CLEAN_TOLERANCE;
}
function parseCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ""; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function makeTR(code: string, ctx: Ctx, t: ReturnType<typeof genTrades>[number], affected: boolean): TR {
  const tmp: DailyStockReturns = new Map();
  accumulateStockDailyReturns(tmp, new Map(), code, ctx.prices, [t], PERIOD_START, "KR", true);
  return { code, buyDate: t.buyDate, sellDate: t.sellDate, ret: t.returnPct, days: [...tmp.entries()].map(([d, es]) => ({ d, r: es[0].returnPct })), forced: !!t.isForcedLiquidation, affected };
}

async function main(): Promise<void> {
  console.log(`low_confidence 영향 점검 시작(읽기 전용): ${new Date().toISOString()}`);
  const events = await fetchAllRows<Ev>((from, to) =>
    supabaseAdmin.from("stock_price_adjustment_events")
      .select("stock_code, event_date, price_ratio, shares_ratio, volume_ratio, adjustment_factor, status, low_confidence_reason, post_adjust_close_ratio, halt_trading_days")
      .order("stock_code").order("event_date").range(from, to)
  );
  const evMap = new Map(events.map((e) => [`${e.stock_code}:${e.event_date}`, e]));
  const appliedAdj = new Map<string, AppliedAdjustment[]>();
  const allAdj = new Map<string, AppliedAdjustment[]>();
  for (const e of events) {
    const a = { eventDate: e.event_date, factor: Number(e.adjustment_factor) };
    (allAdj.get(e.stock_code) ?? allAdj.set(e.stock_code, []).get(e.stock_code)!).push(a);
    if (e.status === "applied") (appliedAdj.get(e.stock_code) ?? appliedAdj.set(e.stock_code, []).get(e.stock_code)!).push(a);
  }
  for (const m of [appliedAdj, allAdj]) for (const l of m.values()) l.sort((a, b) => a.eventDate.localeCompare(b.eventDate));

  const series = await loadAllStockSeriesFromParquet(2010, 2026); // 원본
  const codes = [...series.keys()];
  const calSet = new Set<string>();
  let globalLast = "";
  for (const rows of series.values()) for (const r of rows) { if (r.tradeDate >= PERIOD_START) calSet.add(r.tradeDate); if (r.tradeDate > globalLast) globalLast = r.tradeDate; }
  CAL = [...calSet].sort();
  const endedBefore = new Date(Date.parse(globalLast) - ENDED_BEFORE_OFFSET_DAYS * 86400000).toISOString().slice(0, 10);

  interface LowBig { code: string; date: string; ratio: number; ev: Ev; capPrev: number; capDay: number; universePrev: boolean }
  const lowBig: LowBig[] = [];
  const tradesA: TR[] = [];
  const tradesC: TR[] = [];

  for (const code of codes) {
    const raw = series.get(code) as StockDailyPriceRow[];
    // 1) 원본에서 low_confidence 큰 변동일
    const tvRaw = computeTrailingAvgTradingValue(raw, 20);
    const bigIdx: number[] = [];
    for (let i = 1; i < raw.length; i++) {
      if (!(raw[i - 1].closePrice > 0)) continue;
      const ratio = raw[i].closePrice / raw[i - 1].closePrice;
      if (ratio > BIG_DROP && ratio < BIG_RISE) continue;
      const ev = evMap.get(`${code}:${raw[i].tradeDate}`);
      if (ev && ev.status === "low_confidence") {
        bigIdx.push(i);
        lowBig.push({ code, date: raw[i].tradeDate, ratio, ev, capPrev: raw[i - 1].marketCapEok, capDay: raw[i].marketCapEok, universePrev: raw[i - 1].marketCapEok >= CAP_UNIVERSE_EOK && tvRaw[i - 1] >= MIN_TV_WON });
      }
    }
    // 2) (c) 모든 이벤트(applied + low_confidence) 조정 후 v3
    const rowsC = raw.map((r) => ({ ...r }));
    const aAll = allAdj.get(code);
    if (aAll) applyAdjustmentsInPlace(rowsC, aAll);
    const ctxC = buildCtx(code, rowsC);
    if (ctxC.goldens.length > 0) for (const t of genTrades(ctxC, { name: "v3", entryFilter: (c, e) => nearHighOk(c, e) })) tradesC.push(makeTR(code, ctxC, t, false));
    // 3) (a) 현재 v3: applied만 조정
    const aApp = appliedAdj.get(code);
    if (aApp) applyAdjustmentsInPlace(raw, aApp);
    const ctx = buildCtx(code, raw);
    if (ctx.goldens.length > 0) {
      for (const t of genTrades(ctx, { name: "v3", entryFilter: (c, e) => nearHighOk(c, e) })) {
        const lo = t.eIdx - (NEAR_HIGH_BARS - 1);
        const affected = bigIdx.some((d) => d >= lo && d <= t.sIdx);
        tradesA.push(makeTR(code, ctx, t, affected));
      }
    }
    series.delete(code);
  }

  // ---- 0) 재현 확인 ----
  const bookA = buildBook(tradesA);
  const a0 = metrics(bookA, PERIOD_START, TODAY);
  console.log(`\n=== 0) 상한 없는 v3 재현 확인 ===`);
  console.log(`하네스: CAGR ${f2(a0.cagr)}% | MDD ${f2(a0.mdd)}% | 거래 ${a0.trades}건 | 승률 ${a0.win.toFixed(1)}% | 손익비 ${f2(a0.payoff)}`);
  console.log(`사전 기준: CAGR ${EXPECT.cagr}% | MDD ${EXPECT.mdd}% | 거래 ${EXPECT.trades}건`);
  const match = f2(a0.cagr) === EXPECT.cagr && f2(a0.mdd) === EXPECT.mdd && a0.trades === EXPECT.trades;
  console.log(`재현 결과: ${match ? "일치" : "불일치"}`);
  if (!match) { console.log("재현이 어긋나 이후 분석을 하지 않고 중단합니다."); process.exit(2); }

  // ---- 1) low_confidence 큰 변동일 분석 ----
  console.log(`\n=== 1) low_confidence 이벤트 분석 ===`);
  const lowAll = events.filter((e) => e.status === "low_confidence");
  const reasonCount = (list: Ev[]): string => { const m = new Map<string, number>(); for (const e of list) m.set(e.low_confidence_reason ?? "(null)", (m.get(e.low_confidence_reason ?? "(null)") ?? 0) + 1); return [...m].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(" | "); };
  console.log(`low_confidence 이벤트 전체 ${lowAll.length}건 사유별: ${reasonCount(lowAll)}`);
  console.log(`그중 큰 변동일(-50%↓/+100%↑)에 해당하는 종목-일 ${lowBig.length}건 사유별: ${reasonCount(lowBig.map((x) => x.ev))}`);
  const kind = (e: Ev): string => { const s = Number(e.shares_ratio); return !Number.isFinite(s) ? "주식수비 없음" : s > 1.05 ? "주식수 증가(분할·무상·증자 등)" : s < 0.95 ? "주식수 감소(병합·감자 등)" : "주식수 변화 없음(0.95~1.05)"; };
  console.log("\n큰 변동일 low_confidence의 종류(주식수비 기준; 분할/증자/감자의 구분은 데이터에 없어 확인 불가) × 사유:");
  console.log("| 종류 | 사유 | 건수 | 조정계수가 정수배(±2%) 비율 | 조정계수 중앙값 | 보정 후 종가비(post_adjust_close_ratio) 중앙값 | 일 변동비(종가/직전 종가) 중앙값 |");
  console.log("|---|---|---|---|---|---|---|");
  const groups = new Map<string, LowBig[]>();
  for (const x of lowBig) { const k = `${kind(x.ev)}||${x.ev.low_confidence_reason ?? "(null)"}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(x); }
  for (const [k, l] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    const [kd, rs] = k.split("||");
    const clean = l.filter((x) => isCleanFactor(Number(x.ev.adjustment_factor))).length;
    const post = l.map((x) => Number(x.ev.post_adjust_close_ratio)).filter(Number.isFinite);
    console.log(`| ${kd} | ${rs} | ${l.length} | ${f2((clean / l.length) * 100)}% (${clean}) | ${f2(median(l.map((x) => Number(x.ev.adjustment_factor))))} | ${post.length ? f2(median(post)) : "-"} | ${f2(median(l.map((x) => x.ratio)))} |`);
  }
  const cleanAll = lowBig.filter((x) => isCleanFactor(Number(x.ev.adjustment_factor))).length;
  const factorOne = lowBig.filter((x) => Math.abs(Number(x.ev.adjustment_factor) - 1) < 0.005).length;
  console.log(`\n큰 변동일 ${lowBig.length}건 중 조정계수가 정수배(±${CLEAN_TOLERANCE * 100}%, 2 이상 또는 그 역수)인 건 ${cleanAll}건, 조정계수가 1(±0.005)인 건 ${factorOne}건`);
  const fc = new Map<string, number>();
  for (const x of lowBig) { const k = Number(x.ev.adjustment_factor).toFixed(2); fc.set(k, (fc.get(k) ?? 0) + 1); }
  console.log("조정계수 최빈값(소수 둘째 자리 반올림) 상위 12: " + [...fc].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => `${k}×${n}`).join(", "));
  const capPrev = lowBig.filter((x) => x.capPrev >= CAP_UNIVERSE_EOK).length;
  const capDay = lowBig.filter((x) => x.capDay >= CAP_UNIVERSE_EOK).length;
  const uni = lowBig.filter((x) => x.universePrev).length;
  console.log(`\n큰 변동일 ${lowBig.length}건 중 직전 거래일 시총 5천억 이상 ${capPrev}건, 당일 시총 5천억 이상 ${capDay}건, v3 유니버스 해당(직전 거래일 시총 5천억 이상 + 직전 20거래일 평균 거래대금 5억 이상) ${uni}건`);
  const byYear = new Map<string, number>();
  for (const x of lowBig.filter((y) => y.universePrev)) byYear.set(x.date.slice(0, 4), (byYear.get(x.date.slice(0, 4)) ?? 0) + 1);
  console.log("유니버스 해당분 연도별: " + [...byYear].sort().map(([y, n]) => `${y}: ${n}`).join(", "));

  // ---- 2) 영향받는 거래 ----
  console.log(`\n=== 2) v3 거래 중 low_confidence 큰 변동일의 영향을 받는 거래 ===`);
  console.log(`정의: 진입 신호봉의 252봉 구간(신호봉 포함)이나 보유 기간(청산일까지) 안에 low_confidence 큰 변동일(-50%↓/+100%↑)이 있는 거래`);
  const aff = tradesA.filter((t) => t.affected), non = tradesA.filter((t) => !t.affected);
  console.log("| 구분 | 거래 수 | 비율 | 평균 수익률 % | 중앙값 % | 이후 수익>0 비율 % |");
  console.log("|---|---|---|---|---|---|");
  const row = (lab: string, l: TR[]): void => console.log(`| ${lab} | ${l.length} | ${f2((l.length / tradesA.length) * 100)}% | ${f2(mean(l.map((t) => t.ret * 100)))} | ${f2(median(l.map((t) => t.ret * 100)))} | ${f2((l.filter((t) => t.ret > 0).length / Math.max(l.length, 1)) * 100)} |`);
  row("영향받는 거래", aff); row("영향 없는 거래", non); row("전체", tradesA);
  for (const [lab, s, e] of SLICES.slice(1)) {
    const inS = (l: TR[]): TR[] => l.filter((t) => t.buyDate >= s && t.buyDate <= e);
    console.log(`${lab}: 영향받는 ${inS(aff).length}건 / 전체 ${inS(tradesA).length}건 (평균 ${f2(mean(inS(aff).map((t) => t.ret * 100)))}% / 중앙값 ${f2(median(inS(aff).map((t) => t.ret * 100)))}%)`);
  }

  // ---- 3) 민감도 ----
  console.log(`\n=== 3) 민감도 (상한 없는 v3, 동일비중 집계) ===`);
  const bookB = buildBook(non);
  const bookC = buildBook(tradesC);
  console.log("| 구성 | 구간 | CAGR % | MDD % | 승률 % | 손익비 | 거래 수 |");
  console.log("|---|---|---|---|---|---|---|");
  for (const [lab, b] of [["(a) 현재 v3", bookA], ["(b) 영향받는 거래 제외", bookB], ["(c) low_confidence 포함 전부 조정 후 재실행", bookC]] as [string, Book][]) {
    for (const [sl, s, e] of SLICES) { const m = metrics(b, s, e); console.log(`| ${lab} | ${sl} | ${f2(m.cagr)} | ${f2(m.mdd)} | ${m.win.toFixed(1)} | ${f2(m.payoff)} | ${m.trades} |`); }
  }
  console.log(`(c) 가능 여부: 가능 — 이벤트 테이블에 low_confidence 행도 adjustment_factor가 저장돼 있어 applied와 같은 방식(lib/priceAdjustment.ts applyAdjustmentsInPlace)으로 원본에 적용해 재실행함. 적용 이벤트 수: ${events.length}건(applied ${events.length - lowAll.length} + low_confidence ${lowAll.length}).`);

  // ---- 4) 상장폐지 사유와 청산 스트레스 ----
  console.log(`\n=== 4) 보유 중 데이터가 끊긴 거래의 폐지 사유와 스트레스 ===`);
  const ended = tradesA.filter((t) => t.forced && t.sellDate < endedBefore);
  console.log(`데이터 단절 강제청산 ${ended.length}건 (마지막 거래일 < ${endedBefore})`);
  const reasonByCode = new Map<string, { date: string; reason: string; to: string }>();
  let listOk = false;
  try {
    let csv = "";
    for (let i = 0; i < 12 && !csv; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const res = await fetch(`${DELISTING_CSV_BASE_URL}/${d}.csv`);
      if (res.ok) csv = await res.text();
    }
    if (!csv) throw new Error("최근 12일 내 CSV 없음");
    const lines = csv.split("\n").filter((l) => l.trim());
    const h = parseCsvLine(lines[0]);
    const ix = (n: string): number => h.indexOf(n);
    for (const line of lines.slice(1)) {
      const f = parseCsvLine(line);
      if (f[ix("SecuGroup")]?.trim() !== "주권") continue;
      const sym = f[ix("Symbol")]?.trim();
      if (!sym) continue;
      const date = (f[ix("DelistingDate")] ?? "").trim();
      const prev = reasonByCode.get(sym);
      if (!prev || date > prev.date) reasonByCode.set(sym, { date, reason: (f[ix("Reason")] ?? "").trim(), to: (f[ix("ToSymbol")] ?? "").trim() });
    }
    listOk = true;
  } catch (e) {
    console.log(`폐지 사유 목록 확인 불가: ${e instanceof Error ? e.message : String(e)}`);
  }
  console.log("| 코드 | 진입일 | 마지막 날짜 | 수익률(비용 반영) | 폐지일(목록) | 폐지 사유(목록) | 합병 대상 코드 |");
  console.log("|---|---|---|---|---|---|---|");
  for (const t of [...ended].sort((a, b) => a.sellDate.localeCompare(b.sellDate))) {
    const r = reasonByCode.get(t.code);
    console.log(`| ${t.code} | ${t.buyDate} | ${t.sellDate} | ${f2(t.ret * 100)}% | ${r?.date || "목록에 없음"} | ${r ? r.reason || "(비어 있음)" : "-"} | ${r?.to || "-"} |`);
  }
  if (listOk) {
    const matchTR = (t: TR): boolean => { const r = reasonByCode.get(t.code)?.reason ?? ""; return STRESS_REASONS.some((k) => r.includes(k)); };
    const targets = ended.filter(matchTR);
    console.log(`\n스트레스 대상(사유에 ${STRESS_REASONS.join("/")} 포함) ${targets.length}건: ${targets.map((t) => `${t.code}(${f2(t.ret * 100)}%)`).join(", ") || "없음"}`);
    console.log("| 시나리오 | 바뀐 거래 수 | 구간 | CAGR % | MDD % |");
    console.log("|---|---|---|---|---|");
    for (const [sl, s, e] of SLICES) { const m = metrics(bookA, s, e); console.log(`| 현재 v3 | 0 | ${sl} | ${f2(m.cagr)} | ${f2(m.mdd)} |`); }
    for (const R of STRESS) {
      let changed = 0;
      const stressed = tradesA.map((t) => {
        if (!targets.includes(t) || !(t.ret > R) || t.days.length === 0) return t;
        changed++;
        const prev = t.days.slice(0, -1).reduce((p, x) => p * (1 + x.r), 1);
        const lastR = (1 + R) / prev - 1;
        const days = [...t.days.slice(0, -1), { d: t.days[t.days.length - 1].d, r: lastR }];
        return { ...t, ret: R, days };
      });
      const b = buildBook(stressed);
      for (const [sl, s, e] of SLICES) { const m = metrics(b, s, e); console.log(`| 대상 거래 청산 수익률 ${R * 100}% 가정 | ${changed} | ${sl} | ${f2(m.cagr)} | ${f2(m.mdd)} |`); }
    }
  }
  console.log("완료");
}
main().catch((e) => { console.error(e); process.exit(1); });

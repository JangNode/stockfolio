/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 A(우선주 괴리 회귀) 사전 점검. 수익률·MDD 계산 없음.
 * 사전 등록: docs/research/a-pref-spread-prereg.md. 가격 Parquet(Actions 캐시)과 적용된 조정 이벤트(DB 읽기)만 읽는다. DB·Storage 쓰기 0.
 * 보고: 연도별 (보통주·우선주 시세가 모두 있는 쌍 수, 진입 자격 쌍 수·일평균, 우선주 20일 평균 거래대금, z 조건 충족 건수와 진입 기회 상한).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { loadAllStockSeriesFromParquet } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { applyAdjustmentsInPlace } from "@/lib/priceAdjustment";
import { computeTrailingAvgTradingValue } from "@/lib/pitUniverse";
import { PIT_LIQUIDITY_LOOKBACK_DAYS } from "@/lib/strategyBacktestSummaryConfig";
import { A_Z_WINDOW, A_Z_WINDOW_NEIGHBORS, A_Z_MIN_OBS_RATIO, A_ENTRY_Z, A_ENTRY_Z_NEIGHBORS, A_EXIT_Z, A_MIN_AVG_TV_WON, A_NO_TRADE_WINDOW, A_MAX_NO_TRADE_RATIO, A_REENTRY_BAN_DAYS, A_MIN_ENTRIES, A_TRIAL_NO } from "@/lib/prefSpreadConfig";
import { B_MOM_LOOKBACK } from "@/lib/lowvolMomentumConfig";

void supabaseAdmin; // 환경 변수 검증용(DB 쓰기 없음)
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const fmtWon = (x: number): string => (Number.isFinite(x) ? Math.round(x).toLocaleString("ko-KR") : "-");

async function main(): Promise<void> {
  const T0 = Date.now();
  console.log(`연구 A 사전 점검 시작(읽기 전용, 수익률 계산 없음): ${new Date().toISOString()}`);
  const adjustments = await loadAppliedAdjustments();
  const series = await loadAllStockSeriesFromParquet(2010, new Date().getUTCFullYear());
  const calSet = new Set<string>();
  for (const rows of series.values()) for (const r of rows) if (r.tradeDate >= "2010-01-01") calSet.add(r.tradeDate);
  const CAL = [...calSet].sort();
  const nCal = CAL.length, calIdx = new Map(CAL.map((d, i) => [d, i]));
  const startIdx = B_MOM_LOOKBACK; // 두 연구 공통 평가 시작 판단일(달력 순번 252: 12-1개월 모멘텀 이력이 차는 첫 날)
  console.log(`거래일 ${nCal}일 ${CAL[0]}~${CAL[nCal - 1]} | 공통 평가 시작 판단일 ${CAL[startIdx]}(달력 순번 ${startIdx})`);

  // ---- 쌍: 우선주 = 6자리 코드의 마지막 자리가 '0'이 아님, 보통주 = 앞 5자리 + '0' ----
  interface Leg { adj: Float64Array; vol: Float64Array; avgTv: Float64Array; first: string; last: string }
  const legOf = (code: string): Leg | null => {
    const rows = series.get(code);
    if (!rows || !rows.length) return null;
    const adj = rows.map((r) => ({ ...r }));
    const al = adjustments.get(code);
    if (al) applyAdjustmentsInPlace(adj, al);
    const avg = computeTrailingAvgTradingValue(adj, PIT_LIQUIDITY_LOOKBACK_DAYS);
    const a = new Float64Array(nCal).fill(NaN), v = new Float64Array(nCal).fill(NaN), t = new Float64Array(nCal).fill(NaN);
    for (let i = 0; i < rows.length; i++) { const c = calIdx.get(rows[i].tradeDate); if (c === undefined) continue; a[c] = adj[i].closePrice; v[c] = rows[i].volume; t[c] = avg[i]; }
    return { adj: a, vol: v, avgTv: t, first: rows[0].tradeDate, last: rows[rows.length - 1].tradeDate };
  };
  const prefCodes = [...series.keys()].filter((c) => c.length === 6 && c[5] !== "0").sort();
  interface Pair { pref: string; common: string; s: Float64Array; avgTv: Float64Array; lastIdx: number; firstDate: string }
  const pairs: Pair[] = [];
  let noCommon = 0;
  const noCommonEx: string[] = [];
  for (const p of prefCodes) {
    const cc = `${p.slice(0, 5)}0`;
    if (!series.has(cc)) { noCommon++; if (noCommonEx.length < 5) noCommonEx.push(p); continue; }
    const lp = legOf(p), lc = legOf(cc);
    if (!lp || !lc) continue;
    const s = new Float64Array(nCal).fill(NaN);
    for (let c = 0; c < nCal; c++) {
      if (lp.vol[c] > 0 && lc.vol[c] > 0 && lp.adj[c] > 0 && lc.adj[c] > 0) s[c] = Math.log(lp.adj[c] / lc.adj[c]);
    }
    const lastIdx = Math.min(calIdx.get(lp.last) ?? -1, calIdx.get(lc.last) ?? -1);
    pairs.push({ pref: p, common: cc, s, avgTv: lp.avgTv, lastIdx, firstDate: lp.first > lc.first ? lp.first : lc.first });
  }
  series.clear();
  console.log(`우선주 후보 코드(마지막 자리 ≠ 0) ${prefCodes.length}개 → 보통주 시세가 있는 쌍 ${pairs.length}개 (보통주 없음 ${noCommon}개${noCommonEx.length ? `, 예: ${noCommonEx.join(", ")}` : ""})`);

  // ---- 접두 합 ----
  const years = [...new Set(CAL.slice(startIdx).map((d) => d.slice(0, 4)))];
  interface Y { pairsData: Set<string>; pairsElig: Set<string>; eligDays: number; tvSum: number; days: number }
  const yStat = new Map<string, Y>(years.map((y) => [y, { pairsData: new Set(), pairsElig: new Set(), eligDays: 0, tvSum: 0, days: 0 }]));
  for (let c = startIdx; c < nCal; c++) yStat.get(CAL[c].slice(0, 4))!.days++;
  const windows = [A_Z_WINDOW, ...A_Z_WINDOW_NEIGHBORS];
  const thrs = [...new Set<number>([A_ENTRY_Z.A1, A_ENTRY_Z.A2, ...A_ENTRY_Z_NEIGHBORS.A1, ...A_ENTRY_Z_NEIGHBORS.A2])].sort((a, b) => a - b);
  interface Cnt { raw: number; ep: number; sim: number }
  const cnt = new Map<string, Map<string, Cnt>>(); // `${W}|${thr}` -> 연도 -> 건수
  for (const W of windows) for (const th of thrs) cnt.set(`${W}|${th}`, new Map(years.map((y) => [y, { raw: 0, ep: 0, sim: 0 }])));
  let pairsBothFrom2010 = 0, pairsEverElig = 0;
  const tvPerPairAvg: number[] = [];

  for (const pr of pairs) {
    const s = pr.s;
    let m0 = 0, n0 = 0;
    for (let c = 0; c < nCal; c++) if (Number.isFinite(s[c])) { m0 += s[c]; n0++; }
    m0 = n0 ? m0 / n0 : 0;
    const cs = new Float64Array(nCal + 1), cs2 = new Float64Array(nCal + 1), cc = new Float64Array(nCal + 1);
    for (let c = 0; c < nCal; c++) {
      const v = Number.isFinite(s[c]) ? s[c] - m0 : 0, ok = Number.isFinite(s[c]) ? 1 : 0;
      cs[c + 1] = cs[c] + v; cs2[c + 1] = cs2[c] + v * v; cc[c + 1] = cc[c] + ok;
    }
    if (pr.firstDate <= "2010-01-31") pairsBothFrom2010++;
    // 연도별 시세 쌍(그 해에 두 종목이 모두 체결된 날이 하루라도 있음)
    for (let c = startIdx; c < nCal; c++) if (Number.isFinite(s[c])) yStat.get(CAL[c].slice(0, 4))!.pairsData.add(pr.pref);
    const zOf = (W: number, c: number): number => {
      if (c < W || !Number.isFinite(s[c])) return NaN;
      const n = cc[c] - cc[c - W];
      if (n < Math.ceil(A_Z_MIN_OBS_RATIO * W) || n < 3) return NaN;
      const sum = cs[c] - cs[c - W], sum2 = cs2[c] - cs2[c - W];
      const mean = sum / n, varr = (sum2 - (sum * sum) / n) / (n - 1);
      if (!(varr > 1e-12)) return NaN;
      return (s[c] - m0 - mean) / Math.sqrt(varr);
    };
    const eligibleBase = (c: number): boolean => {
      if (c < A_NO_TRADE_WINDOW) return false;
      const valid = cc[c] - cc[c - A_NO_TRADE_WINDOW];
      return 1 - valid / A_NO_TRADE_WINDOW <= A_MAX_NO_TRADE_RATIO && pr.avgTv[c] >= A_MIN_AVG_TV_WON;
    };
    let everElig = false, tvSum = 0, tvN = 0;
    for (const W of windows) {
      const z = new Float64Array(nCal);
      for (let c = 0; c < nCal; c++) z[c] = zOf(W, c);
      if (W === A_Z_WINDOW) {
        for (let c = startIdx; c < nCal; c++) if (eligibleBase(c) && Number.isFinite(z[c])) {
          const y = yStat.get(CAL[c].slice(0, 4))!;
          y.eligDays++; y.tvSum += pr.avgTv[c]; y.pairsElig.add(pr.pref); everElig = true; tvSum += pr.avgTv[c]; tvN++;
        }
      }
      for (const th of thrs) {
        const m = cnt.get(`${W}|${th}`)!;
        let prevCond = false, pos = false, lastExit = -1e9;
        for (let c = startIdx; c < nCal; c++) {
          const y = CAL[c].slice(0, 4);
          const elig = eligibleBase(c) && Number.isFinite(z[c]);
          const cond = elig && z[c] <= th;
          if (cond) { m.get(y)!.raw++; if (!prevCond) m.get(y)!.ep++; }
          prevCond = cond;
          if (pos) {
            if ((Number.isFinite(z[c]) && z[c] >= A_EXIT_Z) || c > pr.lastIdx) { pos = false; lastExit = c; }
          } else if (cond && c - lastExit >= A_REENTRY_BAN_DAYS && c <= pr.lastIdx) {
            pos = true; m.get(y)!.sim++;
          }
        }
      }
    }
    if (everElig) { pairsEverElig++; tvPerPairAvg.push(tvSum / tvN); }
  }
  tvPerPairAvg.sort((a, b) => a - b);

  console.log(`\n=== 쌍 요약 ===\n보통주·우선주 시세가 모두 있는 쌍 ${pairs.length}개 | 그중 2010년 1월부터 두 종목 모두 시세가 있는 쌍 ${pairsBothFrom2010}개 | 평가 구간(${CAL[startIdx]}~)에서 진입 자격(우선주 20일 평균 거래대금 ≥ ${fmtWon(A_MIN_AVG_TV_WON)}원, 직전 ${A_NO_TRADE_WINDOW}일 체결 없는 날 ≤ ${A_MAX_NO_TRADE_RATIO * 100}%, z 계산 가능)을 하루라도 얻은 쌍 ${pairsEverElig}개 | 그 쌍들의 자격일 평균 거래대금 중앙값 ${fmtWon(tvPerPairAvg[Math.floor(tvPerPairAvg.length / 2)])}원`);
  console.log(`\n=== 연도별 (평가 구간 ${CAL[startIdx]}~) ===\n| 연도 | 판단일 수 | 시세 쌍 수 | 진입 자격 쌍 수(연중 하루라도) | 자격 쌍 일평균 | 자격일 우선주 20일 평균 거래대금(원, 평균) |\n|---|---|---|---|---|---|`);
  for (const y of years) { const s = yStat.get(y)!; console.log(`| ${y} | ${s.days} | ${s.pairsData.size} | ${s.pairsElig.size} | ${f2(s.eligDays / Math.max(s.days, 1))} | ${fmtWon(s.tvSum / Math.max(s.eligDays, 1))} |`); }
  const tot = (key: string, k: keyof Cnt): number => [...cnt.get(key)!.values()].reduce((a, c) => a + c[k], 0);
  for (const [lab, th] of [["A1(204)", A_ENTRY_Z.A1], ["A2(205)", A_ENTRY_Z.A2]] as const) {
    console.log(`\n=== ${lab}: 진입 z ≤ ${th} (창 ${A_Z_WINDOW}), 연도별 z 조건 충족 건수 ===\n| 연도 | 충족 쌍-일 수 | 에피소드 수(연속일 묶음 = 진입 기회 상한) | 보유 상태 반영 진입 수(z≥0 청산, ${A_REENTRY_BAN_DAYS}일 재진입 금지, 슬롯 무제한) |\n|---|---|---|---|`);
    for (const y of years) { const c = cnt.get(`${A_Z_WINDOW}|${th}`)!.get(y)!; console.log(`| ${y} | ${c.raw} | ${c.ep} | ${c.sim} |`); }
    const ep = tot(`${A_Z_WINDOW}|${th}`, "ep"), sim = tot(`${A_Z_WINDOW}|${th}`, "sim");
    console.log(`합계: 에피소드 ${ep} | 보유 상태 반영 ${sim} | 게이트 G·실행 가능 기준 ${A_MIN_ENTRIES}건 → 이론상 상한(에피소드) ${ep >= A_MIN_ENTRIES ? "충족" : "미달 → 실행 불가(번호 " + (lab.startsWith("A1") ? A_TRIAL_NO.A1 : A_TRIAL_NO.A2) + " 미소진)"}`);
  }
  console.log(`\n=== 이웃값 점검(합계, 에피소드 수 / 보유 상태 반영 진입 수) ===\n| 창 \\ 진입 z | ${thrs.join(" | ")} |\n|---|${thrs.map(() => "---").join("|")}|`);
  for (const W of windows) console.log(`| ${W} | ${thrs.map((th) => `${tot(`${W}|${th}`, "ep")} / ${tot(`${W}|${th}`, "sim")}`).join(" | ")} |`);
  console.log(`\n주의: 손절(매수가 대비 −20%·z ≤ −4)은 가격 경로가 필요해 사전 점검에서 제외했다 — 손절이 슬롯·재진입 금지를 풀어 실제 진입 수가 "보유 상태 반영" 열보다 늘 수 있으나, 이론상 상한은 에피소드 수다(연속 충족일은 한 번의 기회).`);
  console.log(`\n=== 실행 지표 ===\nSupabase 쓴 행: 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

/**
 * [임시 검증 — 정리 대상, 읽기 전용, DB 쓰기 0] 시장 국면 검증: 연구 점검 날짜 값, 전체 이력 통계, 3일 확인 규칙 비교,
 * 일일 경로(현재 코스피 구성) vs 백필 경로(월말 시장 구분) 일관성. KIS 종목마스터 파일을 한 번 내려받는다(14:00~15:40 KST에는 돌리지 않는다).
 * 실행: tsx --conditions=react-server scripts/diagnose-market-regime.ts
 */
import { getAllStocks } from "@/lib/stockMaster";
import { computeRegimeRows, type RegimeRow } from "@/lib/marketRegimeCompute";
import { loadKospiSeries, loadNamesAndKsic, loadPriceBook } from "@/lib/marketRegimeData";
import { loadMonthEndKospi, makeExcluder, membersOnDate, monthEndLookup } from "@/lib/marketRegimeMembers";
import { REGIME_BACKFILL_FROM, REGIME_FORWARD_DAYS, REGIME_INDEX_FROM, REGIME_PRICE_FROM_YEAR, REGIME_TOP_N } from "@/lib/marketRegimeConfig";
import { REGIME_LABELS, confirmRegimes, countTransitions, regimeRuns, summarizeByRegime, type Regime } from "@/lib/marketRegime";

const f2 = (x: number | null | undefined): string => (x === null || x === undefined || !Number.isFinite(x) ? "-" : x.toFixed(2));
const median = (a: number[]): number => { const b = [...a].sort((x, y) => x - y); return b.length ? (b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2) : NaN; };

async function run(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const index = await loadKospiSeries(REGIME_INDEX_FROM, today);
  const book = await loadPriceBook(REGIME_PRICE_FROM_YEAR, Number(today.slice(0, 4)));
  const calendar = new Set<string>();
  for (const s of book.values()) for (const d of s.dates) calendar.add(d);
  const lastDate = [...calendar].sort().pop()!;
  const dates = index.map((p) => p.date).filter((d) => d >= REGIME_BACKFILL_FROM && d <= lastDate && calendar.has(d));
  console.log(`지수 ${index.length}일(${index[0].date}~${index[index.length - 1].date}), Parquet 종목 ${book.size}개(마지막 거래일 ${lastDate}), 계산 ${dates.length}일(${dates[0]}~${dates[dates.length - 1]})`);

  const kospiAt = monthEndLookup(await loadMonthEndKospi());
  const dbInfo = await loadNamesAndKsic([...book.keys()]);
  const excludedDb = makeExcluder(dbInfo.names, dbInfo.ksic);
  const rows = computeRegimeRows({ index, book, dates, source: "backfill", membersOn: (d) => { const k = kospiAt(d); return membersOnDate(book, d, (c) => k.has(c), excludedDb); } });
  const byDate = new Map(rows.map((r) => [r.tradeDate, r]));
  console.log(`백필 경로 계산 ${rows.length}행, 구성 종목 ${REGIME_TOP_N}개 미만인 날 ${rows.filter((r) => r.memberCount < REGIME_TOP_N).length}일`);

  // 1. 연구 점검 날짜
  const expected: [string, number, number, number][] = [["2012-12-28", 67.68, 63.45, 14], ["2020-03-23", 3.5, 4.57, -90], ["2026-10-15", 20.0, 24.62, -54]];
  console.log(`\n=== 1. 연구 점검 날짜 (B50·B200·NH 예상값과 비교) ===\n| 날짜 | 구성 | KOSPI | 200일선 | 낙폭 % | B50 (예상) | B200 (예상) | NH (예상) | 신호 | 국면 | B50·B200 차이 %p | NH 차이 |\n|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const [d, b50, b200, nh] of expected) {
    const r = byDate.get(d);
    if (!r) { console.log(`| ${d} | 계산 없음(지수·시세에 없음) |`); continue; }
    console.log(`| ${d} | ${r.memberCount} | ${f2(r.kospiClose)} | ${f2(r.ma200)} | ${f2(r.drawdown)} | ${f2(r.b50)} (${f2(b50)}) | ${f2(r.b200)} (${f2(b200)}) | ${r.nh} (${nh >= 0 ? "+" : ""}${nh}) | ${REGIME_LABELS[r.rawRegime]} | ${REGIME_LABELS[r.regime]} | ${f2((r.b50 ?? NaN) - b50)} / ${f2((r.b200 ?? NaN) - b200)} | ${(r.nh ?? NaN) - nh} |`);
  }

  // 2. 전체 이력 통계
  const days = rows.map((r) => ({ date: r.tradeDate, regime: r.regime, kospiClose: r.kospiClose }));
  const defined = rows.filter((r) => r.regime !== "undefined");
  const years = (Date.parse(defined[defined.length - 1].tradeDate) - Date.parse(defined[0].tradeDate)) / (365.25 * 86_400_000);
  const rawSeq = rows.map((r) => r.rawRegime);
  const confirmed = rows.map((r) => r.regime);
  const noConfirm = confirmRegimes(rawSeq, 1);
  console.log(`\n=== 2. 전체 이력(${defined[0].tradeDate}~${defined[defined.length - 1].tradeDate}, ${defined.length}거래일, ${f2(years)}년) 국면별 통계 (이후 ${REGIME_FORWARD_DAYS}거래일 KOSPI 지수 수익률) ===\n| 국면 | 일수 | 비율 % | 표본 수 | 평균 수익률 % | 승률 % |\n|---|---|---|---|---|---|`);
  for (const s of summarizeByRegime(days, REGIME_FORWARD_DAYS)) console.log(`| ${REGIME_LABELS[s.regime]} | ${s.days} | ${f2(s.share)} | ${s.samples} | ${f2(s.avgForwardPct)} | ${f2(s.winRatePct)} |`);
  const allDays = days.filter((d) => d.regime !== "undefined");
  const baseRets: number[] = [];
  days.forEach((d, i) => { if (i + REGIME_FORWARD_DAYS < days.length) baseRets.push(days[i + REGIME_FORWARD_DAYS].kospiClose / d.kospiClose - 1); });
  console.log(`(참고) 국면 구분 없는 전체: 표본 ${baseRets.length}, 평균 ${f2((baseRets.reduce((a, b) => a + b, 0) / baseRets.length) * 100)}%, 승률 ${f2((baseRets.filter((x) => x > 0).length / baseRets.length) * 100)}% | 정의된 날 ${allDays.length}일`);

  const tConf = countTransitions(confirmed), tRaw = countTransitions(noConfirm);
  const runs = regimeRuns(days.filter((d) => d.regime !== "undefined"));
  const runsRaw = regimeRuns(noConfirm.map((r, i) => ({ date: dates[i], regime: r, kospiClose: rows[i].kospiClose })).filter((d) => d.regime !== "undefined"));
  console.log(`\n=== 3. 전환 횟수와 지속일 ===\n| 규칙 | 전환 횟수 | 연평균 | 지속일 중앙값 | 지속일 평균 | 1~2일짜리 구간 수 |\n|---|---|---|---|---|---|`);
  console.log(`| 3일 확인 없음(신호 그대로) | ${tRaw} | ${f2(tRaw / years)} | ${f2(median(runsRaw.map((r) => r.days)))} | ${f2(runsRaw.reduce((a, r) => a + r.days, 0) / runsRaw.length)} | ${runsRaw.filter((r) => r.days <= 2).length} |`);
  console.log(`| 3일 확인 있음 | ${tConf} | ${f2(tConf / years)} | ${f2(median(runs.map((r) => r.days)))} | ${f2(runs.reduce((a, r) => a + r.days, 0) / runs.length)} | ${runs.filter((r) => r.days <= 2).length} |`);
  console.log(`국면별 지속일 중앙값(3일 확인 있음): ${(["bull", "neutral", "bear", "crisis"] as Regime[]).map((g) => `${REGIME_LABELS[g]} ${f2(median(runs.filter((r) => r.regime === g).map((r) => r.days)))}일(구간 ${runs.filter((r) => r.regime === g).length}개)`).join(" | ")}`);
  console.log(`연도별 전환 횟수(3일 확인 있음): ${[...new Set(rows.map((r) => r.tradeDate.slice(0, 4)))].map((y) => { const rs = rows.filter((r) => r.tradeDate.startsWith(y)).map((r) => r.regime); return `${y} ${countTransitions(rs)}`; }).join(", ")}`);

  // 4. 일관성: 일일 경로 vs 백필 경로
  const master = await getAllStocks();
  const kospiNow = new Set(master.filter((s) => s.market === "KOSPI").map((s) => s.code));
  const excludedMaster = makeExcluder(new Map(master.map((s) => [s.code, s.name])), dbInfo.ksic, new Map(master.map((s) => [s.code, s.productType])));
  const recent = rows.slice(-5).map((r) => r.tradeDate);
  const wanted = new Set([...recent, "2026-09-30", "2026-10-15"]);
  const startIdx = Math.max(1, rows.findIndex((r) => r.tradeDate === [...wanted].sort()[0]));
  const seedRow = rows[startIdx - 1];
  const dailyDates = rows.slice(startIdx).map((r) => r.tradeDate);
  const seedRaws = rows.slice(Math.max(0, startIdx - 2), startIdx).map((r) => r.rawRegime);
  const dailyRows = computeRegimeRows({
    index, book, dates: dailyDates, source: "daily", seed: { prevRegime: seedRow.regime, prevRaws: seedRaws },
    membersOn: (d) => membersOnDate(book, d, (c) => kospiNow.has(c), excludedMaster),
  });
  const dByDate = new Map<string, RegimeRow>(dailyRows.map((r) => [r.tradeDate, r]));
  let maxB50 = 0;
  console.log(`\n=== 4. 일관성: 같은 날짜를 두 경로로 계산 (백필 = 월말 시장 구분 PIT, 일일 = 현재 코스피 구성[KIS 마스터 코스피 ${kospiNow.size}종목]) ===\n| 날짜 | B50 백필 / 일일 / 차이 %p | NH 백필 / 일일 / 차이 | 구성 겹침 (백필 구성 수) | 신호 백필 / 일일 | 국면 백필 / 일일 |\n|---|---|---|---|---|---|`);
  for (const d of [...wanted].sort()) {
    const a = byDate.get(d), b = dByDate.get(d);
    if (!a || !b) { console.log(`| ${d} | 계산 없음 |`); continue; }
    const k = kospiAt(d);
    const ma = new Set(membersOnDate(book, d, (c) => k.has(c), excludedDb)), mb = membersOnDate(book, d, (c) => kospiNow.has(c), excludedMaster);
    const overlap = mb.filter((c) => ma.has(c)).length;
    const diff = (b.b50 ?? NaN) - (a.b50 ?? NaN);
    maxB50 = Math.max(maxB50, Math.abs(diff));
    console.log(`| ${d} | ${f2(a.b50)} / ${f2(b.b50)} / ${f2(diff)} | ${a.nh} / ${b.nh} / ${(b.nh ?? 0) - (a.nh ?? 0)} | ${overlap} (${ma.size}) | ${REGIME_LABELS[a.rawRegime]} / ${REGIME_LABELS[b.rawRegime]} | ${REGIME_LABELS[a.regime]} / ${REGIME_LABELS[b.regime]} |`);
  }
  console.log(`B50 차이 최대 ${f2(maxB50)}%p → 기준 2%p 이내 ${maxB50 <= 2 ? "충족(O)" : "초과(X)"}`);
}

run().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

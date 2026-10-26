// 진단(읽기 전용, 임시): 일일 배치가 저장한 날짜(source='daily')를 백필과 같은 정의(월말 시장 구분 구성)로 처음부터 다시 계산해 비교한다.
// Storage·DB 쓰기 없음(계산만). 비교 대상은 DB의 daily 행, 기준은 2010-07-01부터 같은 날짜까지 한 번에 계산한 결과.
import { computeRegimeRows } from "@/lib/marketRegimeCompute";
import { getAllRegimeRows } from "@/lib/marketRegimeStorage";
import { loadKospiSeries, loadNamesAndKsic, loadPriceBook } from "@/lib/marketRegimeData";
import { loadMonthEndKospi, makeExcluder, membersOnDate, monthEndLookup } from "@/lib/marketRegimeMembers";
import { REGIME_BACKFILL_FROM, REGIME_INDEX_FROM, REGIME_PRICE_FROM_YEAR } from "@/lib/marketRegimeConfig";

const FIELDS = ["kospiClose", "ma50", "ma200", "b50", "b200", "nh", "drawdown", "vol20", "volPctile", "memberCount"] as const;
const num = (v: number | null): string => (v === null ? "null" : String(Number(v.toFixed(4))));

async function main(): Promise<void> {
  const db = await getAllRegimeRows();
  const daily = db.filter((r) => r.source === "daily");
  const bySource = new Map<string, number>();
  for (const r of db) bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1);
  console.log(`DB 행 수=${db.length} 첫날=${db[0]?.tradeDate} 마지막=${db[db.length - 1]?.tradeDate} source별=${[...bySource].map(([k, v]) => `${k}:${v}`).join(", ")}`);
  if (!daily.length) { console.log("daily 행이 없어 비교할 대상이 없습니다."); return; }
  const last = daily[daily.length - 1].tradeDate;

  const today = new Date().toISOString().slice(0, 10);
  const index = await loadKospiSeries(REGIME_INDEX_FROM, today);
  const book = await loadPriceBook(REGIME_PRICE_FROM_YEAR, Number(today.slice(0, 4)));
  const calendar = new Set<string>();
  for (const s of book.values()) for (const d of s.dates) calendar.add(d);
  const dates = index.map((p) => p.date).filter((d) => d >= REGIME_BACKFILL_FROM && d <= last && calendar.has(d));
  const kospiAt = monthEndLookup(await loadMonthEndKospi());
  const { names, ksic } = await loadNamesAndKsic([...book.keys()]);
  const excluded = makeExcluder(names, ksic);
  const cache = new Map<string, string[]>();
  const rows = computeRegimeRows({
    index, book, dates, source: "backfill",
    membersOn: (d) => { let v = cache.get(d); if (!v) { const k = kospiAt(d); v = membersOnDate(book, d, (c) => k.has(c), excluded); cache.set(d, v); } return v; },
  });
  const ref = new Map(rows.map((r) => [r.tradeDate, r]));
  console.log(`백필 정의로 재계산 ${rows.length}행(${rows[0]?.tradeDate}~${rows[rows.length - 1]?.tradeDate})`);

  // 1) 재계산 경로가 기존 백필 저장값을 그대로 재현하는지(최근 30개 backfill 행)
  const bf = db.filter((r) => r.source === "backfill").slice(-30);
  let maxDiffBf = 0, regimeDiffBf = 0;
  for (const r of bf) {
    const x = ref.get(r.tradeDate);
    if (!x) { console.log(`  [백필 재현] ${r.tradeDate} 재계산 결과 없음`); continue; }
    if (x.regime !== r.regime || x.rawRegime !== r.rawRegime) regimeDiffBf++;
    for (const f of FIELDS) { const a = r[f], b = x[f]; if (a !== null && b !== null) maxDiffBf = Math.max(maxDiffBf, Math.abs(a - b)); }
  }
  console.log(`[백필 재현 점검] 최근 backfill 행 ${bf.length}개: 국면(표시·원신호) 불일치 ${regimeDiffBf}일, 지표 최대 절대차 ${maxDiffBf.toFixed(6)}`);

  // 2) daily 행 vs 같은 날짜의 백필 정의 재계산
  console.log(`\n=== daily 행 vs 백필 정의 재계산(${daily[0].tradeDate}~${last}) ===`);
  let regimeDiff = 0, rawDiff = 0, maxB50 = 0, maxOther = 0;
  for (const r of daily) {
    const x = ref.get(r.tradeDate);
    if (!x) { console.log(`${r.tradeDate} 재계산 결과 없음`); continue; }
    const same = x.regime === r.regime, sameRaw = x.rawRegime === r.rawRegime;
    if (!same) regimeDiff++;
    if (!sameRaw) rawDiff++;
    const b50d = r.b50 !== null && x.b50 !== null ? Math.abs(r.b50 - x.b50) : NaN;
    if (Number.isFinite(b50d)) maxB50 = Math.max(maxB50, b50d);
    const diffs = FIELDS.filter((f) => f !== "b50" && r[f] !== null && x[f] !== null && Math.abs((r[f] as number) - (x[f] as number)) > 1e-6).map((f) => `${f} ${num(r[f])}≠${num(x[f])}`);
    for (const f of FIELDS) if (f !== "b50" && r[f] !== null && x[f] !== null) maxOther = Math.max(maxOther, Math.abs((r[f] as number) - (x[f] as number)));
    console.log(`${r.tradeDate} | 일일 ${r.regime}(원 ${r.rawRegime}) B50=${num(r.b50)} NH=${r.nh} 구성 ${r.memberCount} | 백필정의 ${x.regime}(원 ${x.rawRegime}) B50=${num(x.b50)} NH=${x.nh} 구성 ${x.memberCount} | 국면 ${same ? "같음" : "다름"}, 원신호 ${sameRaw ? "같음" : "다름"}, B50 차 ${num(b50d)}%p${diffs.length ? ` | 다른 지표: ${diffs.join(", ")}` : ""}`);
  }
  console.log(`\n요약: 국면(표시) 불일치 ${regimeDiff}일, 원신호 불일치 ${rawDiff}일, B50 최대 차 ${maxB50.toFixed(4)}%p(기준 2%p), 그 밖의 지표 최대 절대차 ${maxOther.toFixed(6)}`);
}

main().catch((e) => { console.error("진단 실패:", e instanceof Error ? e.message : e); process.exit(1); });

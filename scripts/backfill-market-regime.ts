/**
 * 시장 국면 이력 백필 — 2010-07부터 지수가 있는 마지막 거래일까지 일별 국면을 계산한다.
 * 구성 종목은 월말 시장 구분(PIT) 목록의 KOSPI(연구용 수집 파일을 한 번 읽기 전용으로 읽음) ∩ 20일 평균 거래대금 ≥ 5억 ∩ 제외 규칙 ∩ 시총 상위 200.
 *
 * 기본은 DB에 쓰지 않는 드라이런이다: 요약을 출력하고, BACKFILL_SQL_PATH가 있으면 같은 행을 마이그레이션 SQL(upsert 문)로 파일에 쓴다.
 * BACKFILL_APPLY=1일 때만 market_regime_daily에 넣는다(표는 마이그레이션이 먼저 적용돼 있어야 함). 충돌 시 무시(on conflict do nothing) —
 * 이미 있는 행, 특히 일일 배치(source='daily') 행은 덮어쓰지 않고, 일일 행이 처음 생긴 날의 전날까지만 입력한다.
 * 종목 시세 Parquet은 읽기만 한다.
 *
 * 실행: tsx --conditions=react-server scripts/backfill-market-regime.ts
 * 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (외부 API 호출 없음)
 */
import { writeFileSync } from "node:fs";
import { backfillEndDate, computeRegimeRows, type RegimeRow } from "@/lib/marketRegimeCompute";
import { getFirstDailyDate, insertRegimeRowsIgnoreConflicts } from "@/lib/marketRegimeStorage";
import { loadKospiSeries, loadNamesAndKsic, loadPriceBook } from "@/lib/marketRegimeData";
import { loadMonthEndKospi, makeExcluder, membersOnDate, monthEndLookup } from "@/lib/marketRegimeMembers";
import { REGIME_BACKFILL_FROM, REGIME_INDEX_FROM, REGIME_PRICE_FROM_YEAR, REGIME_TOP_N } from "@/lib/marketRegimeConfig";
import { REGIME_LABELS } from "@/lib/marketRegime";

const sqlNum = (v: number | null): string => (v === null || !Number.isFinite(v) ? "null" : String(Number(v.toFixed(4))));

function toUpsertSql(rows: RegimeRow[], chunk = 500): string {
  const cols = "trade_date, regime, raw_regime, kospi_close, ma50, ma200, b50, b200, nh, drawdown, vol20, vol_pctile, member_count, source";
  const out: string[] = ["-- 시장 국면 이력 백필(월말 시장 구분 PIT 기준). 생성: scripts/backfill-market-regime.ts — market_regime_daily 마이그레이션 적용 후에만 실행.", ""];
  for (let i = 0; i < rows.length; i += chunk) {
    const vals = rows.slice(i, i + chunk).map((r) => `('${r.tradeDate}', '${r.regime}', '${r.rawRegime}', ${sqlNum(r.kospiClose)}, ${sqlNum(r.ma50)}, ${sqlNum(r.ma200)}, ${sqlNum(r.b50)}, ${sqlNum(r.b200)}, ${r.nh ?? "null"}, ${sqlNum(r.drawdown)}, ${sqlNum(r.vol20)}, ${sqlNum(r.volPctile)}, ${r.memberCount}, '${r.source}')`);
    out.push(`insert into public.market_regime_daily (${cols}) values\n${vals.join(",\n")}\non conflict (trade_date) do nothing;\n`);
  }
  return out.join("\n");
}

async function run(): Promise<void> {
  const apply = process.env.BACKFILL_APPLY === "1";
  const today = new Date().toISOString().slice(0, 10);
  const index = await loadKospiSeries(REGIME_INDEX_FROM, today);
  const book = await loadPriceBook(REGIME_PRICE_FROM_YEAR, Number(today.slice(0, 4)));
  const calendar = new Set<string>();
  for (const s of book.values()) for (const d of s.dates) calendar.add(d);
  let firstDaily: string | null = null;
  try { firstDaily = await getFirstDailyDate(); } catch (e) { if (apply) throw e; console.log(`일일 행 조회 실패(드라이런이라 계속): ${e instanceof Error ? e.message : String(e)}`); }
  const lastData = [...calendar].sort().pop()!;
  const last = process.env.BACKFILL_TO || backfillEndDate(lastData, firstDaily);
  console.log(`시세 마지막 거래일 ${lastData}, 일일 행 시작일 ${firstDaily ?? "없음"} → 백필 마지막 날 ${last}`);
  const dates = index.map((p) => p.date).filter((d) => d >= REGIME_BACKFILL_FROM && d <= last && calendar.has(d));
  console.log(`지수 ${index.length}일(${index[0].date}~${index[index.length - 1].date}), 종목 ${book.size}개, 계산 대상 ${dates.length}일(${dates[0]}~${dates[dates.length - 1]})`);

  const byMonthEnd = await loadMonthEndKospi();
  const kospiAt = monthEndLookup(byMonthEnd);
  console.log(`월말 시장 구분 목록 ${byMonthEnd.size}개 월말(KOSPI만)`);
  const { names, ksic } = await loadNamesAndKsic([...book.keys()]);
  const excluded = makeExcluder(names, ksic);
  const cache = new Map<string, string[]>();
  const rows = computeRegimeRows({
    index, book, dates, source: "backfill",
    membersOn: (d) => { let v = cache.get(d); if (!v) { const k = kospiAt(d); v = membersOnDate(book, d, (c) => k.has(c), excluded); cache.set(d, v); } return v; },
  });

  const short = rows.filter((r) => r.memberCount < REGIME_TOP_N);
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.regime, (counts.get(r.regime) ?? 0) + 1);
  console.log(`계산 ${rows.length}행 | 국면별 일수: ${[...counts].map(([k, v]) => `${REGIME_LABELS[k as keyof typeof REGIME_LABELS]} ${v}`).join(", ")} | 구성 종목 ${REGIME_TOP_N}개 미만인 날 ${short.length}일${short.length ? ` (예: ${short.slice(0, 5).map((r) => `${r.tradeDate} ${r.memberCount}`).join(", ")})` : ""}`);
  console.log(`첫 행 ${JSON.stringify(rows[0])}\n마지막 행 ${JSON.stringify(rows[rows.length - 1])}`);
  if (short.length > 0) throw new Error(`구성 종목이 ${REGIME_TOP_N}개 미만인 날이 ${short.length}일 있어 저장하지 않습니다.`);

  if (process.env.BACKFILL_SQL_PATH) { writeFileSync(process.env.BACKFILL_SQL_PATH, toUpsertSql(rows)); console.log(`마이그레이션 SQL 파일 작성: ${process.env.BACKFILL_SQL_PATH}`); }
  if (apply) { await insertRegimeRowsIgnoreConflicts(rows); console.log(`market_regime_daily에 ${rows.length}행 입력 완료(이미 있는 날짜는 건드리지 않음)`); }
  else console.log("드라이런 — DB에 쓰지 않았습니다(BACKFILL_APPLY=1로 적용).");
}

run().catch((e) => { console.error(`시장 국면 백필 실패: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });

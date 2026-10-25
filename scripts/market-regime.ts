/**
 * 시장 국면(레짐) 일일 배치 — 직전 거래일 한 행(시장 폭·낙폭·변동성·국면)을 market_regime_daily에 저장한다.
 * .github/workflows/market-regime.yml이 평일 16:40 KST에 pg_cron으로 실행한다(등록은 docs/market-regime/pg_cron_register.sql).
 *
 * 구성 종목: 현재 코스피 구성(KIS 종목마스터 파일 다운로드) ∩ 20일 평균 거래대금 ≥ 5억 ∩ 제외 규칙 ∩ 시총 상위 200.
 * 시세: 연도 Parquet(워크플로가 직전 단계에서 현재 연도 파일을 증분 갱신). 지수: KRX idx API로 beta_price_history를 증분 갱신.
 * 직전 거래일 자료가 없거나 구성 종목이 200개 미만이면 그날은 저장하지 않고 schedule_scrape_status('MARKET_REGIME')에 오류를 남긴다.
 *
 * 실행: tsx --conditions=react-server scripts/market-regime.ts
 * 환경변수: KRX_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   MARKET_REGIME_TARGET=YYYY-MM-DD  (선택) 기준일 지정, MARKET_REGIME_DRY_RUN=1  (선택) 저장·지수 갱신 없이 계산만.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getAllStocks } from "@/lib/stockMaster";
import { computeRegimeRows } from "@/lib/marketRegimeCompute";
import { getLatestRegimeRows, recordRegimeAttempt, upsertRegimeRows } from "@/lib/marketRegimeStorage";
import { loadKospiSeries, loadNamesAndKsic, loadPriceBook, refreshKospiIndexUpTo } from "@/lib/marketRegimeData";
import { makeExcluder, membersOnDate } from "@/lib/marketRegimeMembers";
import { REGIME_CONFIRM_DAYS, REGIME_LOOKBACK_YEARS, REGIME_MAX_CATCHUP_DAYS, REGIME_TOP_N } from "@/lib/marketRegimeConfig";

const kstToday = (): string => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
const addDays = (d: string, n: number): string => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** 오늘(KST) 이전 가장 최근 거래일. 거래일 캘린더(krx_trading_calendar)를 먼저 보고, 없으면 직전 평일. */
async function previousTradingDay(today: string): Promise<string> {
  const { data, error } = await supabaseAdmin.from("krx_trading_calendar").select("trade_date").lt("trade_date", today).eq("is_open", true).order("trade_date", { ascending: false }).limit(1);
  if (error) throw new Error(`거래일 캘린더 조회 실패: ${error.message}`);
  if (data && data.length > 0) return data[0].trade_date as string;
  let d = addDays(today, -1);
  while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, -1);
  return d;
}

async function run(): Promise<void> {
  const dry = process.env.MARKET_REGIME_DRY_RUN === "1";
  const today = kstToday();
  const target = process.env.MARKET_REGIME_TARGET || (await previousTradingDay(today));
  console.log(`시장 국면 일일 배치: 오늘(KST) ${today}, 기준일(직전 거래일) ${target}${dry ? " [DRY RUN]" : ""}`);

  const lastRows = await getLatestRegimeRows(REGIME_CONFIRM_DAYS);
  if (lastRows.length === 0) throw new Error("market_regime_daily가 비어 있습니다 — 이력 백필이 먼저 필요합니다.");
  const last = lastRows[lastRows.length - 1];
  if (last.tradeDate >= target) {
    console.log(`이미 ${last.tradeDate}까지 저장되어 있어 할 일이 없습니다.`);
    if (!dry) await recordRegimeAttempt(null, 0);
    return;
  }

  if (!dry) {
    const added = await refreshKospiIndexUpTo(target, REGIME_MAX_CATCHUP_DAYS * 3);
    console.log(`KOSPI 지수 증분 갱신: 새로 저장 ${added}일`);
  }
  const startDate = addDays(target, -365 * REGIME_LOOKBACK_YEARS);
  const index = await loadKospiSeries(startDate, target);
  const pending = index.filter((p) => p.date > last.tradeDate && p.date <= target).map((p) => p.date);
  if (pending.length === 0) throw new Error(`${target} KOSPI 지수 종가가 없습니다(저장된 마지막 ${index[index.length - 1]?.date ?? "없음"}) — 저장하지 않습니다.`);
  if (pending[pending.length - 1] !== target) throw new Error(`${target} KOSPI 지수 종가가 없어 ${pending[pending.length - 1]}까지만 계산할 수 있습니다 — 저장하지 않습니다.`);
  if (pending.length > REGIME_MAX_CATCHUP_DAYS) throw new Error(`밀린 거래일이 ${pending.length}일(상한 ${REGIME_MAX_CATCHUP_DAYS}일)이라 일일 배치로 따라잡지 않습니다 — 백필이 필요합니다.`);

  const targetYear = Number(target.slice(0, 4));
  const book = await loadPriceBook(targetYear - 1, targetYear);
  console.log(`Parquet 종목 ${book.size}개 로드(${targetYear - 1}~${targetYear}), 계산 대상 ${pending.join(", ")}`);

  const master = await getAllStocks();
  const kospi = new Set(master.filter((s) => s.market === "KOSPI").map((s) => s.code));
  const names = new Map(master.map((s) => [s.code, s.name])), types = new Map(master.map((s) => [s.code, s.productType]));
  const { ksic } = await loadNamesAndKsic([...kospi]);
  const excluded = makeExcluder(names, ksic, types);
  console.log(`KIS 종목마스터 코스피 ${kospi.size}개`);

  const rows = computeRegimeRows({
    index, book, dates: pending, source: "daily",
    membersOn: (d) => membersOnDate(book, d, (c) => kospi.has(c), excluded),
    seed: { prevRegime: last.regime, prevRaws: lastRows.map((r) => r.rawRegime) },
  });

  const ok: typeof rows = [];
  let failure: string | null = null;
  for (const r of rows) {
    if (r.memberCount < REGIME_TOP_N) { failure = `${r.tradeDate} 구성 종목 ${r.memberCount}개(< ${REGIME_TOP_N}) — 그날은 저장하지 않습니다(Parquet 갱신 상태 확인).`; break; }
    ok.push(r);
  }
  for (const r of ok) console.log(`${r.tradeDate} ${r.regime}(신호 ${r.rawRegime}) KOSPI ${r.kospiClose} B50 ${r.b50?.toFixed(2)} B200 ${r.b200?.toFixed(2) ?? "-"} NH ${r.nh} 낙폭 ${r.drawdown?.toFixed(2) ?? "-"}% 구성 ${r.memberCount}`);
  if (!dry && ok.length > 0) await upsertRegimeRows(ok);
  if (failure) throw new Error(failure);
  if (!dry) await recordRegimeAttempt(null, ok.length);
  console.log(`${dry ? "(DRY RUN) " : ""}저장 ${ok.length}행`);
}

run().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`시장 국면 배치 실패: ${msg}`);
  if (process.env.MARKET_REGIME_DRY_RUN !== "1") {
    try { await recordRegimeAttempt(msg.slice(0, 500), null); } catch (e2) { console.error(`상태 기록도 실패: ${e2 instanceof Error ? e2.message : String(e2)}`); }
  }
  process.exit(1);
});

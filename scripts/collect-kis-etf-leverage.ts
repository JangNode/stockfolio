/**
 * [연구용] KIS 기간별 시세로 122630(KODEX 레버리지) 상장 이후 전체 일봉(수정주가·원주가)을 받아 etf_daily_prices에 추가한다.
 * 기존 행은 건드리지 않는다(code=122630 행만 upsert). KIS 호출은 getDailyPricesRangeForResearch만 사용(상한 ETF_LEVERAGE_REQUEST_CAP). 1회 실행.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getDailyPricesRangeForResearch, getKisCallStats } from "@/lib/kis";
import {
  ETF_LEVERAGE_CODE, ETF_LEVERAGE_REQUEST_CAP, ETF_LEVERAGE_BIG_MOVE_REPORT_PCT, ETF_DAILY_DEFAULT_START, ETF_DAILY_END, ETF_DAILY_PAGE_ROWS,
  ETF_DAILY_UPSERT_BATCH, ETF_RATIO_CHANGE_REPORT_PCT,
} from "@/lib/etfDailyConfig";

const T0 = Date.now();
const iso = (d: string): string => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
interface Bar { date: string; close: number; open: number; high: number; low: number; volume: number; tv: number }

function prevDay(d: string): string {
  const x = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)));
  x.setUTCDate(x.getUTCDate() - 1);
  return x.toISOString().slice(0, 10).replace(/-/g, "");
}

async function fetchSeries(adj: "0" | "1"): Promise<{ bars: Bar[]; requests: number }> {
  const bars: Bar[] = [];
  let end = ETF_DAILY_END;
  let requests = 0;
  for (;;) {
    if (getKisCallStats().total >= ETF_LEVERAGE_REQUEST_CAP) throw new Error(`KIS 요청 상한(${ETF_LEVERAGE_REQUEST_CAP}) 도달 adj=${adj}`);
    const r = await getDailyPricesRangeForResearch(ETF_LEVERAGE_CODE, ETF_DAILY_DEFAULT_START, end, adj);
    requests++;
    const rows = r.output2.filter((x) => x.stck_bsop_date);
    for (const x of rows) bars.push({ date: iso(x.stck_bsop_date), close: Number(x.stck_clpr), open: Number(x.stck_oprc), high: Number(x.stck_hgpr), low: Number(x.stck_lwpr), volume: Number(x.acml_vol), tv: Number(x.acml_tr_pbmn) });
    if (rows.length < ETF_DAILY_PAGE_ROWS) break;
    const next = prevDay(rows[rows.length - 1].stck_bsop_date);
    if (next >= end) break;
    end = next;
  }
  return { bars, requests };
}

async function main(): Promise<void> {
  const a = await fetchSeries("0");
  const r = await fetchSeries("1");
  const m = new Map<string, { adj: number | null; raw: number | null; b: Bar }>();
  for (const b of a.bars) m.set(b.date, { adj: b.close, raw: null, b });
  for (const b of r.bars) { const e = m.get(b.date); if (e) e.raw = b.close; else m.set(b.date, { adj: null, raw: b.close, b }); }
  const rows = [...m.entries()].sort((x, y) => x[0].localeCompare(y[0]));
  const { count: existing, error: ce } = await supabaseAdmin.from("etf_daily_prices").select("code", { count: "exact", head: true }).eq("code", ETF_LEVERAGE_CODE);
  if (ce) throw new Error(`기존 행 확인 실패: ${ce.message}`);
  if ((existing ?? 0) > 0) throw new Error(`122630 행이 이미 ${existing}건 있어 중단(기존 행 변경 금지)`);
  const fetchedAt = new Date().toISOString();
  const payload = rows.map(([date, e]) => ({ code: ETF_LEVERAGE_CODE, trade_date: date, adj_close: e.adj, raw_close: e.raw, open: e.b.open, high: e.b.high, low: e.b.low, volume: e.b.volume, trading_value: e.b.tv, fetched_at: fetchedAt }));
  let written = 0;
  for (let i = 0; i < payload.length; i += ETF_DAILY_UPSERT_BATCH) {
    const { error } = await supabaseAdmin.from("etf_daily_prices").upsert(payload.slice(i, i + ETF_DAILY_UPSERT_BATCH), { onConflict: "code,trade_date" });
    if (error) throw new Error(`upsert 실패: ${error.message}`);
    written += Math.min(ETF_DAILY_UPSERT_BATCH, payload.length - i);
  }
  console.log(`저장 ${ETF_LEVERAGE_CODE}: ${rows.length}행 첫=${rows[0][0]} 마지막=${rows[rows.length - 1][0]} adj null=${rows.filter(([, e]) => e.adj === null).length} raw null=${rows.filter(([, e]) => e.raw === null).length} (요청 adj=${a.requests} raw=${r.requests})`);

  const both = rows.filter(([, e]) => e.adj !== null && e.raw !== null && e.raw > 0);
  let ratioChanges = 0;
  for (let i = 1; i < both.length; i++) {
    const p = both[i - 1][1].adj! / both[i - 1][1].raw!, c = both[i][1].adj! / both[i][1].raw!;
    if (Math.abs((c / p - 1) * 100) > ETF_RATIO_CHANGE_REPORT_PCT) ratioChanges++;
  }
  console.log(`비율 일간 변화 |>${ETF_RATIO_CHANGE_REPORT_PCT}%| 날짜 수: ${ratioChanges}`);

  const base: { date: string; px: number }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from("etf_daily_prices").select("trade_date, adj_close").eq("code", "069500").order("trade_date").range(from, from + 999);
    if (error) throw new Error(`069500 읽기 실패: ${error.message}`);
    for (const x of data ?? []) base.push({ date: x.trade_date as string, px: Number(x.adj_close) });
    if (!data || data.length < 1000) break;
  }
  const baseRet = new Map<string, number>();
  for (let i = 1; i < base.length; i++) baseRet.set(base[i].date, (base[i].px / base[i - 1].px - 1) * 100);
  console.log(`\n수정주가 |r|>${ETF_LEVERAGE_BIG_MOVE_REPORT_PCT}% 날짜 (069500 같은 날 수익률 병기)\n| 날짜 | 전일→종가 | 122630 % | 069500 % |\n|---|---|---|---|`);
  const adjRows = rows.filter(([, e]) => e.adj !== null);
  let n = 0;
  for (let i = 1; i < adjRows.length; i++) {
    const ret = (adjRows[i][1].adj! / adjRows[i - 1][1].adj! - 1) * 100;
    if (Math.abs(ret) > ETF_LEVERAGE_BIG_MOVE_REPORT_PCT) {
      n++;
      const b = baseRet.get(adjRows[i][0]);
      console.log(`| ${adjRows[i][0]} | ${adjRows[i - 1][1].adj}→${adjRows[i][1].adj} | ${ret.toFixed(2)} | ${b === undefined ? "-" : b.toFixed(2)} |`);
    }
  }
  console.log(`목록 ${n}건`);
  const st = getKisCallStats();
  console.log(`KIS 요청 시도=${st.total} (재시도 ${st.retried}) Supabase 쓴 행=${written} 읽은 행=${base.length}+기존확인 소요=${((Date.now() - T0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e, `KIS시도=${getKisCallStats().total}`); process.exit(1); });

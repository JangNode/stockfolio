/**
 * [연구용] KIS 기간별 시세로 ETF 6종 전체 일봉(수정주가·원주가)을 받아 etf_daily_prices(새 표)에 저장하고 검증 수치를 출력한다.
 * KIS 호출은 getDailyPricesRangeForResearch만 사용(요청 상한 ETF_DAILY_REQUEST_CAP). DB는 REST만. 1회 실행.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getDailyPricesRangeForResearch, getKisCallStats } from "@/lib/kis";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import {
  ETF_DAILY_CODES, ETF_DAILY_START_BY_CODE, ETF_DAILY_DEFAULT_START, ETF_DAILY_END, ETF_DAILY_PAGE_ROWS, ETF_DAILY_REQUEST_CAP,
  ETF_DAILY_UPSERT_BATCH, ETF_RATIO_CHANGE_REPORT_PCT, ETF_JUMP_REPORT_PCT, ETF_YEARLY_FROM, ETF_YEARLY_TO,
} from "@/lib/etfDailyConfig";

const TABLE = "etf_daily_prices";
const T0 = Date.now();
const iso = (d: string): string => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const nodash = (d: string): string => d.replace(/-/g, "");

interface Bar { date: string; close: number; open: number; high: number; low: number; volume: number; tv: number }
interface Merged { date: string; adj: number | null; raw: number | null; open: number; high: number; low: number; volume: number; tv: number }

function prevDay(d: string): string {
  const x = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)));
  x.setUTCDate(x.getUTCDate() - 1);
  return x.toISOString().slice(0, 10).replace(/-/g, "");
}

async function fetchSeries(code: string, adj: "0" | "1"): Promise<{ bars: Bar[]; requests: number }> {
  const start = ETF_DAILY_START_BY_CODE[code] ?? ETF_DAILY_DEFAULT_START;
  const bars: Bar[] = [];
  let end = ETF_DAILY_END;
  let requests = 0;
  for (;;) {
    if (getKisCallStats().total >= ETF_DAILY_REQUEST_CAP) throw new Error(`KIS 요청 상한(${ETF_DAILY_REQUEST_CAP}) 도달: ${code} adj=${adj}`);
    const r = await getDailyPricesRangeForResearch(code, start, end, adj);
    requests++;
    const rows = r.output2.filter((x) => x.stck_bsop_date);
    for (const x of rows) {
      bars.push({
        date: iso(x.stck_bsop_date), close: Number(x.stck_clpr), open: Number(x.stck_oprc), high: Number(x.stck_hgpr),
        low: Number(x.stck_lwpr), volume: Number(x.acml_vol), tv: Number(x.acml_tr_pbmn),
      });
    }
    if (rows.length < ETF_DAILY_PAGE_ROWS) break;
    const oldest = rows[rows.length - 1].stck_bsop_date;
    const next = prevDay(oldest);
    if (next >= end) break;
    end = next;
  }
  return { bars, requests };
}

function merge(adj: Bar[], raw: Bar[]): Merged[] {
  const m = new Map<string, Merged>();
  for (const b of adj) m.set(b.date, { date: b.date, adj: b.close, raw: null, open: b.open, high: b.high, low: b.low, volume: b.volume, tv: b.tv });
  for (const b of raw) {
    const e = m.get(b.date);
    if (e) e.raw = b.close;
    else m.set(b.date, { date: b.date, adj: null, raw: b.close, open: b.open, high: b.high, low: b.low, volume: b.volume, tv: b.tv });
  }
  return [...m.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function main() {
  const all: Record<string, Merged[]> = {};
  const reqByCode: Record<string, { adj: number; raw: number }> = {};
  let written = 0;
  for (const code of ETF_DAILY_CODES) {
    const a = await fetchSeries(code, "0");
    const r = await fetchSeries(code, "1");
    reqByCode[code] = { adj: a.requests, raw: r.requests };
    const rows = merge(a.bars, r.bars);
    all[code] = rows;
    const fetchedAt = new Date().toISOString();
    const payload = rows.map((x) => ({
      code, trade_date: x.date, adj_close: x.adj, raw_close: x.raw, open: x.open, high: x.high, low: x.low, volume: x.volume, trading_value: x.tv, fetched_at: fetchedAt,
    }));
    for (let i = 0; i < payload.length; i += ETF_DAILY_UPSERT_BATCH) {
      const { error } = await supabaseAdmin.from(TABLE).upsert(payload.slice(i, i + ETF_DAILY_UPSERT_BATCH), { onConflict: "code,trade_date" });
      if (error) throw new Error(`upsert 실패 ${code}: ${error.message}`);
      written += Math.min(ETF_DAILY_UPSERT_BATCH, payload.length - i);
    }
    console.log(`저장 ${code}: ${rows.length}행 (요청 adj=${a.requests} raw=${r.requests}) 누적 쓴 행=${written}`);
  }

  const kospi = await getIndexPriceSeries("KOSPI", "2007-12-01", iso(ETF_DAILY_END));
  const kDates = kospi.map((p) => p.tradeDate);

  console.log("\n=== 3-1. 종목별 행 수·첫/마지막 날짜·결측 ===");
  console.log("| 코드 | 행수 | 첫 거래일 | 마지막 | adj null | raw null | KOSPI 거래일 대비 결측 | ETF에만 있는 날 |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const code of ETF_DAILY_CODES) {
    const rows = all[code];
    const first = rows[0]?.date ?? "-";
    const last = rows[rows.length - 1]?.date ?? "-";
    const have = new Set(rows.map((x) => x.date));
    const span = kDates.filter((d) => d >= first && d <= last);
    const missing = span.filter((d) => !have.has(d));
    const kset = new Set(kDates);
    const extra = rows.filter((x) => !kset.has(x.date)).length;
    console.log(`| ${code} | ${rows.length} | ${first} | ${last} | ${rows.filter((x) => x.adj === null).length} | ${rows.filter((x) => x.raw === null).length} | ${missing.length} | ${extra} |`);
    if (missing.length > 0) console.log(`  결측일 ${code}: ${missing.slice(0, 60).join(",")}${missing.length > 60 ? ` ...(+${missing.length - 60})` : ""}`);
  }

  console.log(`\n=== 3-2. 수정/원주가 비율 일간 변화율 |>${ETF_RATIO_CHANGE_REPORT_PCT}%| 전체 목록 ===`);
  for (const code of ETF_DAILY_CODES) {
    const rows = all[code].filter((x) => x.adj !== null && x.raw !== null && x.raw > 0);
    const out: string[] = [];
    for (let i = 1; i < rows.length; i++) {
      const p = rows[i - 1].adj! / rows[i - 1].raw!;
      const c = rows[i].adj! / rows[i].raw!;
      const ch = (c / p - 1) * 100;
      if (Math.abs(ch) > ETF_RATIO_CHANGE_REPORT_PCT) out.push(`${rows[i].date} ${p.toFixed(6)}->${c.toFixed(6)} ${ch.toFixed(4)}%`);
    }
    console.log(`${code}: ${out.length}건`);
    for (const l of out) console.log(`  ${l}`);
  }

  console.log(`\n=== 3-3. 수정주가 일수익률 |>${ETF_JUMP_REPORT_PCT}%| 날짜 ===`);
  for (const code of ETF_DAILY_CODES) {
    const rows = all[code].filter((x) => x.adj !== null);
    const out: string[] = [];
    for (let i = 1; i < rows.length; i++) {
      const ret = (rows[i].adj! / rows[i - 1].adj! - 1) * 100;
      if (Math.abs(ret) > ETF_JUMP_REPORT_PCT) out.push(`${rows[i].date} ${rows[i - 1].adj}->${rows[i].adj} ${ret.toFixed(2)}%`);
    }
    console.log(`${code}: ${out.length}건`);
    for (const l of out) console.log(`  ${l}`);
  }

  console.log("\n=== 3-4. 069500 수정주가 vs KOSPI 연도별 수익률 % ===");
  const lastOfYear = (series: { d: string; c: number }[], y: number): number | null => {
    const s = series.filter((x) => x.d.startsWith(String(y)));
    return s.length ? s[s.length - 1].c : null;
  };
  const etf = all["069500"].filter((x) => x.adj !== null).map((x) => ({ d: x.date, c: x.adj! }));
  const kp = kospi.map((p) => ({ d: p.tradeDate, c: p.closePrice }));
  console.log("| 연도 | 069500 | KOSPI |");
  console.log("|---|---|---|");
  for (let y = ETF_YEARLY_FROM; y <= ETF_YEARLY_TO; y++) {
    const f = (s: { d: string; c: number }[]): string => {
      const a = lastOfYear(s, y - 1);
      const b = lastOfYear(s, y);
      return a && b ? ((b / a - 1) * 100).toFixed(2) : "-";
    };
    console.log(`| ${y} | ${f(etf)} | ${f(kp)} |`);
  }

  const st = getKisCallStats();
  console.log(`\nKIS 요청 시도=${st.total} (재시도 ${st.retried}) 종목별=${JSON.stringify(reqByCode)} Supabase 쓴 행=${written} KOSPI 읽은 행=${kospi.length} 소요=${((Date.now() - T0) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  const st = getKisCallStats();
  console.error("실패:", e instanceof Error ? e.message : e, `KIS시도=${st.total}`);
  process.exit(1);
});

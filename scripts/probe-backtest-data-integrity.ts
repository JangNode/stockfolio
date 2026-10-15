/**
 * [임시 점검 — 병합 금지, 읽기 전용] 백테스트 가격 데이터(Parquet) 무결성 점검: 상장폐지·거래정지로 사라진 종목, 보유 중 데이터 단절 거래,
 * 가격조정 이벤트, 미등록 분할/병합 의심 일수, 시총 데이터 시점. DB는 stock_price_adjustment_events 조회만(쓰기 없음).
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { fetchAllRows } from "@/lib/supabasePagination";
import { loadAllStockSeriesFromParquet, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";
import { loadAppliedAdjustments } from "@/lib/stockPriceAdjustmentsStorage";
import { applyAdjustmentsInPlace } from "@/lib/priceAdjustment";
import { buildCtx, genTrades, PERIOD_START, type Ctx } from "./research-ma-lab";

const NEAR_HIGH_MIN_GAP = -0.1829;
const NEAR_HIGH_BARS = 252;
const ENDED_BEFORE_OFFSET_DAYS = 14; // 데이터 마지막 날짜보다 이만큼 이전에 끝난 종목을 "사라진 종목"으로 본다
const CAP_UNIVERSE_EOK = 5000;
const BIG_DROP = 0.5; // 하루(연속 저장 행) 종가 비율 <= 0.5
const BIG_RISE = 2.0; // >= 2.0
const NORMAL_GAP_DAYS = 5;
const DELISTING_CSV_BASE_URL = "https://raw.githubusercontent.com/FinanceData/fdr_krx_data_cache/master/data/listing/delisting";

function nearHighOk(ctx: Ctx, e: number): boolean {
  let hi = -Infinity;
  for (let j = Math.max(0, e - (NEAR_HIGH_BARS - 1)); j <= e; j++) if (ctx.prices[j].high > hi) hi = ctx.prices[j].high;
  return ctx.prices[e].close / hi - 1 > NEAR_HIGH_MIN_GAP;
}
const daysBetween = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / 86400000;
const f2 = (x: number): string => x.toFixed(2);
const median = (v: number[]): number => { const s = [...v].sort((a, b) => a - b); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

interface StockInfo { first: string; last: string; rows: number; lastClose: number; lastCap: number; ever5000: boolean; years: Set<number>; lastDrawdown252: number }
interface Forced { code: string; buyDate: string; buyPrice: number; sellDate: string; sellPrice: number; ret: number; lastVol: number }

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

async function main(): Promise<void> {
  console.log(`백테스트 데이터 무결성 점검 시작(읽기 전용): ${new Date().toISOString()}`);

  // ---- DB: 가격조정 이벤트 ----
  const events = await fetchAllRows<{ stock_code: string; event_date: string; status: string; adjustment_factor: number }>((from, to) =>
    supabaseAdmin.from("stock_price_adjustment_events").select("stock_code, event_date, status, adjustment_factor").order("stock_code").order("event_date").range(from, to)
  );
  const eventStatus = new Map(events.map((e) => [`${e.stock_code}:${e.event_date}`, e.status]));

  const adjustments = await loadAppliedAdjustments();
  const series = await loadAllStockSeriesFromParquet(2010, 2026); // 원본(조정 전)

  const info = new Map<string, StockInfo>();
  const rowsPerYear = new Map<number, number>();
  const zeroTvPerYear = new Map<number, number>();
  const moves = new Map<number, { all: number; drop: number; rise: number; applied: number; low: number; none: number; noneNormal: number; noneGap: number }>();
  let globalLast = "";
  const forced: Forced[] = [];
  let totalTrades = 0;
  let forcedTotal = 0;

  const codes = [...series.keys()];
  for (const [code, rows] of series) for (const r of rows) if (r.tradeDate > globalLast) globalLast = r.tradeDate;
  const endedBefore = new Date(Date.parse(globalLast) - ENDED_BEFORE_OFFSET_DAYS * 86400000).toISOString().slice(0, 10);

  for (const code of codes) {
    const rows = series.get(code) as StockDailyPriceRow[];
    // 1) 원본 기준 통계
    const years = new Set<number>();
    let ever5000 = false;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const y = Number(r.tradeDate.slice(0, 4));
      years.add(y);
      rowsPerYear.set(y, (rowsPerYear.get(y) ?? 0) + 1);
      if (!(r.tradingValue > 0)) zeroTvPerYear.set(y, (zeroTvPerYear.get(y) ?? 0) + 1);
      if (r.marketCapEok >= CAP_UNIVERSE_EOK) ever5000 = true;
      if (i >= 1 && rows[i - 1].closePrice > 0) {
        const ratio = r.closePrice / rows[i - 1].closePrice;
        if (ratio <= BIG_DROP || ratio >= BIG_RISE) {
          const m = moves.get(y) ?? { all: 0, drop: 0, rise: 0, applied: 0, low: 0, none: 0, noneNormal: 0, noneGap: 0 };
          m.all++;
          if (ratio <= BIG_DROP) m.drop++; else m.rise++;
          const st = eventStatus.get(`${code}:${r.tradeDate}`);
          if (st === "applied") m.applied++;
          else if (st === "low_confidence") m.low++;
          else {
            m.none++;
            if (daysBetween(rows[i - 1].tradeDate, r.tradeDate) <= NORMAL_GAP_DAYS) m.noneNormal++; else m.noneGap++;
          }
          moves.set(y, m);
        }
      }
    }
    const last = rows[rows.length - 1];
    let hi = -Infinity;
    for (let j = Math.max(0, rows.length - 252); j < rows.length; j++) if (rows[j].highPrice > hi) hi = rows[j].highPrice;
    info.set(code, { first: rows[0].tradeDate, last: last.tradeDate, rows: rows.length, lastClose: last.closePrice, lastCap: last.marketCapEok, ever5000, years, lastDrawdown252: last.closePrice / hi - 1 });

    // 2) 조정 적용 후 v3 거래 생성 → 데이터가 끊긴 채 강제청산된 거래
    const adj = adjustments.get(code);
    if (adj) applyAdjustmentsInPlace(rows, adj);
    const ctx = buildCtx(code, rows);
    if (ctx.goldens.length > 0) {
      for (const t of genTrades(ctx, { name: "v3", entryFilter: (c, e) => nearHighOk(c, e) })) {
        totalTrades++;
        if (t.isForcedLiquidation) {
          forcedTotal++;
          if (t.sellDate < endedBefore) forced.push({ code, buyDate: t.buyDate, buyPrice: t.buyPrice, sellDate: t.sellDate, sellPrice: t.sellPrice, ret: t.returnPct, lastVol: rows[rows.length - 1].volume });
        }
      }
    }
    series.delete(code);
  }

  console.log(`\n데이터 마지막 거래일 ${globalLast} | "사라진 종목" 기준: 마지막 거래일 < ${endedBefore} | 종목 ${info.size}개 | v3 거래 ${totalTrades}건`);

  // ---- 1) 연도별 종목 수 / 사라진 종목 ----
  console.log(`\n=== 1) 연도별 종목 수와 사라진 종목 ===`);
  console.log("| 연도 | 해당 연도 시세가 있는 종목 수 | 행 수 | 그 해 마지막으로 나타난 종목 수(이후 연도 없음) | 거래대금=0 행 비율 % |");
  console.log("|---|---|---|---|---|");
  const lastYearCount = new Map<number, number>();
  for (const s of info.values()) { const ly = Number(s.last.slice(0, 4)); lastYearCount.set(ly, (lastYearCount.get(ly) ?? 0) + 1); }
  for (let y = 2010; y <= 2026; y++) {
    const n = [...info.values()].filter((s) => s.years.has(y)).length;
    const ended = y < 2026 ? (lastYearCount.get(y) ?? 0) : [...info.values()].filter((s) => s.last.startsWith("2026") && s.last < endedBefore).length;
    console.log(`| ${y} | ${n} | ${rowsPerYear.get(y) ?? 0} | ${ended}${y === 2026 ? " (2026 중 사라진 종목: 마지막 거래일 < " + endedBefore + ")" : ""} | ${f2(((zeroTvPerYear.get(y) ?? 0) / Math.max(rowsPerYear.get(y) ?? 1, 1)) * 100)} |`);
  }
  const endedAll = [...info.entries()].filter(([, s]) => s.last < endedBefore);
  const everBig = endedAll.filter(([, s]) => s.ever5000).length;
  console.log(`\n사라진 종목 합계 ${endedAll.length}개 (전체 ${info.size}개 중), 이 중 시총 5천억 이상이었던 적이 있는 종목 ${everBig}개`);
  console.log(`\n사라진 종목 상위 20개 (마지막 거래일 시총 큰 순):`);
  console.log("| 코드 | 첫 거래일 | 마지막 거래일 | 거래일 수 | 마지막 종가(원본) | 마지막 시총(억) | 마지막 종가 ÷ 252봉 최고가 − 1 |");
  console.log("|---|---|---|---|---|---|---|");
  for (const [code, s] of endedAll.sort((a, b) => b[1].lastCap - a[1].lastCap).slice(0, 20)) {
    console.log(`| ${code} | ${s.first} | ${s.last} | ${s.rows} | ${s.lastClose} | ${Math.round(s.lastCap)} | ${f2(s.lastDrawdown252 * 100)}% |`);
  }

  // ---- 2) 상장폐지 목록과 비교 (FinanceDataReader 캐시, 외부 소스) ----
  console.log(`\n=== 2) 상장폐지 목록(외부: FinanceDataReader의 KRX 상장폐지 캐시)과 Parquet 비교 ===`);
  console.log("코드/DB 근거: DB에 상장폐지 테이블 없음(마이그레이션 테이블 목록 확인). 과거 코드 lib/delistedStockList.ts(#348, #413에서 제거됨)가 같은 외부 소스를 썼음.");
  try {
    let csv = "";
    for (let i = 0; i < 12 && !csv; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const res = await fetch(`${DELISTING_CSV_BASE_URL}/${d}.csv`);
      if (res.ok) { csv = await res.text(); console.log(`목록 파일 날짜: ${d}`); }
    }
    if (!csv) throw new Error("최근 12일 내 CSV 없음");
    const lines = csv.split("\n").filter((l) => l.trim());
    const header = parseCsvLine(lines[0]);
    console.log(`CSV 헤더: ${header.join(" | ")} | 행 ${lines.length - 1}`);
    const ix = (n: string): number => header.indexOf(n);
    const dateIdx = header.findIndex((h) => /delist.*date|^DelistingDate$|^Date$/i.test(h));
    const reasonIdx = ix("Reason");
    const parquetCodes = new Set(info.keys());
    let total = 0, inP = 0, since2010 = 0, since2010In = 0;
    const absentReasons = new Map<string, number>();
    const byYear = new Map<string, { n: number; inP: number }>();
    for (const line of lines.slice(1)) {
      const f = parseCsvLine(line);
      if (f[ix("SecuGroup")]?.trim() !== "주권") continue;
      const mk = f[ix("Market")]?.trim();
      if (mk !== "KOSPI" && mk !== "KOSDAQ") continue;
      const sym = f[ix("Symbol")]?.trim();
      if (!sym) continue;
      total++;
      const present = parquetCodes.has(sym);
      if (present) inP++;
      const dd = dateIdx >= 0 ? (f[dateIdx] ?? "").trim() : "";
      const yr = dd.slice(0, 4);
      if (yr) { const b = byYear.get(yr) ?? { n: 0, inP: 0 }; b.n++; if (present) b.inP++; byYear.set(yr, b); }
      if (yr && Number(yr) >= 2010) { since2010++; if (present) since2010In++; }
      if (!present && reasonIdx >= 0) { const r = (f[reasonIdx] ?? "").trim().slice(0, 30) || "(비어 있음)"; absentReasons.set(r, (absentReasons.get(r) ?? 0) + 1); }
    }
    console.log(`목록의 KOSPI/KOSDAQ 보통주 상장폐지 종목 ${total}개 중 Parquet(2010~)에 있는 종목 ${inP}개, 없는 종목 ${total - inP}개`);
    if (dateIdx >= 0) {
      console.log(`폐지 연도 컬럼(${header[dateIdx]}) 기준 2010년 이후 폐지 ${since2010}개 중 Parquet에 있는 종목 ${since2010In}개 (${since2010 ? f2((since2010In / since2010) * 100) : "-"}%)`);
      console.log("폐지 연도별 (목록 종목 수 / Parquet에 있는 수): " + [...byYear].sort().map(([y, b]) => `${y}: ${b.n}/${b.inP}`).join(", "));
    } else console.log("폐지 날짜 컬럼을 찾지 못해 연도별 비교는 확인 불가");
    if (absentReasons.size) console.log("Parquet에 없는 종목의 폐지 사유 상위: " + [...absentReasons].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([r, n]) => `${r} ${n}`).join(" | "));
  } catch (e) {
    console.log(`상장폐지 목록 비교 확인 불가: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ---- 3) 보유 중 데이터 단절 ----
  console.log(`\n=== 3) 보유 중 데이터가 끊긴 거래(강제청산 = 그 종목의 마지막 가용 종가에 청산) ===`);
  console.log("코드: lib/backtest.ts runBacktest의 `if (openBuy)` 블록과 scripts/research-ma-lab.ts genTrades가 같은 방식. 마지막 봉 종가에 비용(수수료·슬리피지·거래세)을 반영해 청산하고 isForcedLiquidation=true로 표시.");
  console.log(`v3 전체 거래 ${totalTrades}건 중 강제청산 ${forcedTotal}건, 그중 데이터가 ${endedBefore} 이전에 끊긴 종목의 보유 중 강제청산 ${forced.length}건 (나머지 ${forcedTotal - forced.length}건은 현재 상장 중인 종목의 기간 끝 청산)`);
  if (forced.length) {
    const rets = forced.map((x) => x.ret * 100);
    console.log(`데이터 단절 강제청산 수익률(비용 반영): 평균 ${f2(rets.reduce((a, b) => a + b, 0) / rets.length)}% | 중앙값 ${f2(median(rets))}% | 최저 ${f2(Math.min(...rets))}% | 최고 ${f2(Math.max(...rets))}% | 손실 거래 ${forced.filter((x) => x.ret < 0).length}건`);
    const sorted = [...forced].sort((a, b) => a.ret - b.ret);
    const picks = [sorted[0], sorted[sorted.length >> 1], sorted[sorted.length - 1]];
    console.log("| 구분 | 코드 | 진입일 | 진입가(조정 기준) | 마지막 날짜 | 청산가(마지막 종가) | 수익률(비용 반영) | 마지막 봉 거래량 |");
    console.log("|---|---|---|---|---|---|---|---|");
    ["최저 수익률", "중앙값", "최고 수익률"].forEach((lab, i) => {
      const x = picks[i];
      console.log(`| ${lab} | ${x.code} | ${x.buyDate} | ${x.buyPrice.toFixed(1)} | ${x.sellDate} | ${x.sellPrice.toFixed(1)} | ${f2(x.ret * 100)}% | ${Math.round(x.lastVol)} |`);
    });
  }

  // ---- 4) 가격조정 이벤트 ----
  console.log(`\n=== 4) 가격조정 이벤트 (stock_price_adjustment_events) ===`);
  const byStatus = new Map<string, number>();
  const evYear = new Map<number, { applied: number; low: number }>();
  for (const e of events) {
    byStatus.set(e.status, (byStatus.get(e.status) ?? 0) + 1);
    const y = Number(e.event_date.slice(0, 4));
    const b = evYear.get(y) ?? { applied: 0, low: 0 };
    if (e.status === "applied") b.applied++; else b.low++;
    evYear.set(y, b);
  }
  console.log(`총 ${events.length}건: ${[...byStatus].map(([s, n]) => `${s} ${n}`).join(", ")}`);
  const in1018 = events.filter((e) => e.event_date >= "2010-01-01" && e.event_date <= "2018-12-31");
  console.log(`2010~2018 구간: ${in1018.length}건 (applied ${in1018.filter((e) => e.status === "applied").length}, low_confidence ${in1018.filter((e) => e.status !== "applied").length})`);
  console.log("| 연도 | 이벤트 수 | applied | low_confidence |");
  console.log("|---|---|---|---|");
  for (let y = 2010; y <= 2026; y++) { const b = evYear.get(y) ?? { applied: 0, low: 0 }; console.log(`| ${y} | ${b.applied + b.low} | ${b.applied} | ${b.low} |`); }

  console.log(`\n하루(연속 저장 행) 종가 변동이 -50% 이하 또는 +100% 이상인 일수 (원본 Parquet 기준, 이벤트 등록 여부별)`);
  console.log(`"정상 간격" = 직전 저장 행과 달력일 ${NORMAL_GAP_DAYS}일 이내, "간격 큼" = 그보다 멀리 떨어진 행(거래정지 등으로 사이 날짜가 저장 안 됨)`);
  console.log("| 연도 | 전체 | 하락(-50%↓) | 상승(+100%↑) | applied 이벤트 있음 | low_confidence 이벤트 있음 | 이벤트 없음 | 이벤트 없음 중 정상 간격 | 이벤트 없음 중 간격 큼 |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (let y = 2010; y <= 2026; y++) {
    const m = moves.get(y) ?? { all: 0, drop: 0, rise: 0, applied: 0, low: 0, none: 0, noneNormal: 0, noneGap: 0 };
    console.log(`| ${y} | ${m.all} | ${m.drop} | ${m.rise} | ${m.applied} | ${m.low} | ${m.none} | ${m.noneNormal} | ${m.noneGap} |`);
  }

  // ---- 5) 시총 데이터 시점 ----
  console.log(`\n=== 5) 유니버스 시총 데이터 시점 ===`);
  console.log("코드: Parquet market_cap_eok = KRX 일별매매정보 MKTCAP(그 거래일 값)을 그날 행에 저장(scripts/backfill-stock-daily-prices.ts). applyAdjustmentsInPlace는 시총·거래대금을 건드리지 않음(lib/priceAdjustment.ts). 유니버스 판정은 신호일 행의 marketCapEok >= 5000과 직전 20거래일 평균 거래대금 >= 5억(scripts/research-ma-lab.ts entryOk).");
  console.log("완료");
}
main().catch((e) => { console.error(e); process.exit(1); });

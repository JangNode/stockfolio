/**
 * [연구용] KRX etp/etf_bydd_trd를 KOSPI 지수 거래일마다 1건씩 받아, 업종 키워드에 한 번이라도 걸린 코드와 069500·114260의 전 기간 행만 etf_krx_daily에 저장한다.
 * 키: 기존 KRX_API_KEY(값 출력 금지). 오류·한도 응답(HTTP != 200 또는 빈 응답)이 나오면 즉시 중단하고, 그때까지 받은 날짜만 저장한 뒤 종료한다. 1회 실행.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getIndexPriceSeries } from "@/lib/betaPriceHistoryStorage";
import { KRX_SECTOR_KEYWORDS } from "@/lib/krxSectorEtfConfig";
import { ETF_KRX_REQUEST_CAP, ETF_KRX_GAP_MS, ETF_KRX_PROGRESS_EVERY, ETF_KRX_FROM, ETF_KRX_TO, ETF_KRX_ALWAYS_CODES, ETF_KRX_UPSERT_BATCH } from "@/lib/etfKrxDailyConfig";

const T0 = Date.now();
const BASE = "https://data-dbg.krx.co.kr/svc/apis";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const num = (s: string | undefined): number | null => { const n = Number(String(s ?? "").replace(/,/g, "")); return String(s ?? "").trim() !== "" && Number.isFinite(n) ? n : null; };
type Row = Record<string, string>;
interface Slim { d: string; code: string; nm: string; px: number | null; nav: number | null; tv: number | null; mc: number | null; idxNm: string; idx: number | null }
let requests = 0;
let dbRead = 0;
let written = 0;

async function krx(basDd: string, key: string): Promise<{ http: number | string; code: string; msg: string; rows: Row[] }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (requests >= ETF_KRX_REQUEST_CAP) return { http: "-", code: "-", msg: "요청 상한", rows: [] };
    requests++;
    await sleep(ETF_KRX_GAP_MS);
    try {
      const res = await fetch(`${BASE}/etp/etf_bydd_trd?basDd=${basDd}`, { headers: { AUTH_KEY: key } });
      const text = await res.text();
      let j: Record<string, unknown> | null = null;
      try { j = JSON.parse(text) as Record<string, unknown>; } catch { j = null; }
      const out = { http: res.status as number | string, code: String(j?.respCode ?? "-"), msg: String(j?.respMsg ?? "-"), rows: (j?.OutBlock_1 as Row[] | undefined) ?? [] };
      if (res.status >= 500 && attempt === 0) continue;
      return out;
    } catch (e) {
      if (attempt === 0) continue;
      return { http: "fetch 실패", code: "-", msg: e instanceof Error ? e.message : String(e), rows: [] };
    }
  }
  return { http: "-", code: "-", msg: "-", rows: [] };
}

async function main(): Promise<void> {
  const key = process.env.KRX_API_KEY;
  if (!key) throw new Error("KRX_API_KEY 환경변수가 필요합니다.");
  console.log(`KRX ETF 일별 수집 시작: ${new Date().toISOString()} | 요청 상한 ${ETF_KRX_REQUEST_CAP}`);
  const kospi = await getIndexPriceSeries("KOSPI", ETF_KRX_FROM, ETF_KRX_TO);
  dbRead += kospi.length;
  const days = kospi.map((p) => p.tradeDate).filter((d) => d <= ETF_KRX_TO);
  console.log(`KOSPI 거래일 ${days.length}일 ${days[0]}~${days[days.length - 1]}`);

  // 이미 저장된 날짜(069500 행 기준)는 건너뜀
  const saved = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin.from("etf_krx_daily").select("bas_dd").eq("isu_cd", "069500").order("bas_dd").range(from, from + 999);
    if (error) throw new Error(`저장 날짜 확인 실패: ${error.message}`);
    for (const r of data ?? []) saved.add(r.bas_dd as string);
    dbRead += data?.length ?? 0;
    if (!data || data.length < 1000) break;
  }
  console.log(`이미 저장된 날짜 ${saved.size}일 (건너뜀)`);

  const byDay = new Map<string, Slim[]>();
  const perDayCount = new Map<string, number>();
  let abort = "";
  for (const d of days) {
    if (saved.has(d)) continue;
    const r = await krx(d.replace(/-/g, ""), key);
    if (r.http !== 200 || r.rows.length === 0) { abort = `${d}: HTTP ${r.http} respCode ${r.code} respMsg ${r.msg} 행 ${r.rows.length}`; break; }
    perDayCount.set(d, r.rows.length);
    byDay.set(d, r.rows.map((x) => ({ d, code: x.ISU_CD ?? x.ISU_SRT_CD ?? "", nm: x.ISU_NM ?? "", px: num(x.TDD_CLSPRC), nav: num(x.NAV), tv: num(x.ACC_TRDVAL), mc: num(x.MKTCAP), idxNm: x.IDX_IND_NM ?? "", idx: num(x.OBJ_STKPRC_IDX) })));
    if (requests % ETF_KRX_PROGRESS_EVERY === 0) console.log(`진행: 요청 ${requests}, 마지막 ${d}, ETF ${r.rows.length}개, ${((Date.now() - T0) / 60000).toFixed(1)}분`);
  }
  if (abort) console.log(`\n중단: ${abort} (요청 ${requests}건 사용)`);

  // 업종 키워드에 한 번이라도 걸린 코드 + 항상 저장 코드
  const keep = new Set<string>(ETF_KRX_ALWAYS_CODES);
  let totalRows = 0;
  for (const rows of byDay.values()) for (const r of rows) { totalRows++; if (r.code && KRX_SECTOR_KEYWORDS.some((k) => k.re.test(`${r.nm} ${r.idxNm}`))) keep.add(r.code); }
  const payload: Record<string, unknown>[] = [];
  const dates = [...byDay.keys()].sort();
  for (const d of dates) for (const r of byDay.get(d)!) if (keep.has(r.code)) payload.push({ bas_dd: d, isu_cd: r.code, isu_nm: r.nm, tdd_clsprc: r.px, nav: r.nav, acc_trdval: r.tv, mktcap: r.mc, idx_ind_nm: r.idxNm, obj_stkprc_idx: r.idx });
  console.log(`\n받은 날짜 ${dates.length}일, 응답 ETF 행 합계 ${totalRows}, 저장 대상 코드 ${keep.size}개, 저장 대상 행 ${payload.length}`);
  // 069500 행이 하루의 마지막 배치에 오도록(이미 저장된 날짜 판정 기준) 날짜 순·069500 마지막으로 정렬
  payload.sort((a, b) => (a.bas_dd as string).localeCompare(b.bas_dd as string) || ((a.isu_cd === "069500" ? 1 : 0) - (b.isu_cd === "069500" ? 1 : 0)));
  for (let i = 0; i < payload.length; i += ETF_KRX_UPSERT_BATCH) {
    const { error } = await supabaseAdmin.from("etf_krx_daily").upsert(payload.slice(i, i + ETF_KRX_UPSERT_BATCH), { onConflict: "isu_cd,bas_dd" });
    if (error) throw new Error(`upsert 실패 (${i}행 부근): ${error.message}`);
    written += Math.min(ETF_KRX_UPSERT_BATCH, payload.length - i);
    if ((i / ETF_KRX_UPSERT_BATCH) % 50 === 0) console.log(`저장 진행 ${written}/${payload.length}`);
  }

  const counts = [...perDayCount.entries()];
  const min = counts.reduce((a, b) => (b[1] < a[1] ? b : a), counts[0]);
  const max = counts.reduce((a, b) => (b[1] > a[1] ? b : a), counts[0]);
  console.log(`\n=== 수집 결과 ===\n요청 ${requests}건 | 저장 행 ${written} | 실패(중단) ${abort ? 1 : 0}건 | 날짜별 ETF 수 최소 ${min?.[1]}(${min?.[0]}) 최대 ${max?.[1]}(${max?.[0]})`);
  console.log(`Supabase 읽은 행 ${dbRead} 쓴 행 ${written} | DART·KIS 0 | 소요 ${((Date.now() - T0) / 1000).toFixed(1)}s`);
  if (abort) process.exit(1);
}

main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e, `KRX시도=${requests}`); process.exit(1); });

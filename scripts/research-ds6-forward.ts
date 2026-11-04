/**
 * [임시 연구 — 병합 금지, 읽기 전용] 연구 DS6 포워드 관찰(시험 아님, 시험 번호 273 유지). 문서: docs/research/ds6-forward.md
 * DS6 = 시도 272 정의 그대로(코어 40% = 월말 K200P 안 당일 시총 상위 2종목 시총 비율·교체 5거래일 연속 밖, 위성 60% = LV1 단독, 이동 비용 0.25%, 일별 목표 비중 리밸).
 * 정의 커밋: DS6F_DEF_COMMITS(lib/ds6ForwardConfig.ts). 고정 날짜 2026-10-26, 관찰 구간은 그 다음 거래일부터. 관찰 결과로 정의를 바꾸지 않는다.
 * 두 단계(FWD_PHASE):
 *   verify  — 고정 스냅샷(PARQUET_CACHE_FROZEN=1, RESEARCH_DATA_END=2026-10-26)으로 고정 구간을 다시 계산해 기록값(4.10/24.51, 11.70/39.15)과 비교한다. 다르면 중단한다. 일별 수익을 .ds6fwd에 남긴다.
 *   forward — 기록값 재확인 뒤 고정 날짜 이후 DS6·069500(원주가) 일별 수익, 누적, 초과, 낙폭을 docs/research/ds6-forward-log.csv로 쓴다. 가격 Parquet은 캐시 그대로 읽고 다른 연도가 달라지면 DS6F_DOWNLOAD_YEARS(2025·2026)만 받는다.
 * DB 쓰기 0, Storage 쓰기 0, 공시·DART 사용 없음. 069500 종가는 보조 파일(~10-26) → 로그 CSV → etf_daily_prices → KRX 순으로 찾고, 없는 거래일만 KRX를 부른다(KST 14:00~15:40 금지, 키 값 출력 없음).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { SEASON_STOCK_CODE } from "@/lib/seasonalityConfig";
import { simSlots, type SimCand, type SimPos, type SimRun, type SimTrade, type SimVt } from "@/lib/slotSim";
import { L_SLIPPAGE, L_EVAL_AFTER } from "@/lib/megacapTrendConfig";
import { LS_COOLDOWN_DAYS } from "@/lib/megacapTrailingConfig";
import { LE_CANDS, LE_LEGS, LE_ENTRY_LEG, LE_RANK_DEPTH } from "@/lib/momentumEnsembleConfig";
import { LV_CANDS, LV_WINDOW, LV_ANNUAL_DAYS, LV_ROUND_DP, LV_BAND } from "@/lib/le2VolTargetConfig";
import { rankEnsemble, outsiderEnsembleRank, type EnsembleRanking } from "@/lib/momentumEnsemble";
import { alignCloses, equalWeightSigma, volMultiplier } from "@/lib/le2VolTarget";
import { P17_RUN_START, P17_END, P17_CAND } from "@/lib/ds6Pre2017Config";
import { CS_SWAP_CONFIRM_DAYS, CS_RANK_DEPTH, CS_MOVE_COST } from "@/lib/coreSatelliteConfig";
import { BENCH_AUX_BLOCK_FROM_KST_MIN, BENCH_AUX_BLOCK_TO_KST_MIN, BENCH_AUX_KRX_GAP_MS } from "@/lib/benchmarkAuxConfig";
import { DS6F_FIXED_DATE, DS6F_DEF_COMMITS, DS6F_REC_A, DS6F_REC_FULL, DS6F_KRX_CAP, DS6F_KRX_BASE, DS6F_DOWNLOAD_YEARS, DS6F_LOG_CSV, DS6F_WORK_DIR, DS6F_VERIFY_FILE, DS6F_SUMMARY_FILE, DS6F_CSV_HEADER, DS6F_PREFIX_INFO_TOL_PP, DS6F_PARTIAL_DAY_RATIO } from "@/lib/ds6ForwardConfig";
import { loadHarness, loadK200P, verifySnapshotManifest, storageLine, selectAll, dbRead, SNAP_END, f2, type S, type Win } from "./researchHarness";
import { parquetCacheStats } from "@/lib/parquetDiskCache";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
/** 공통 평가 시작 이후로 자른 일별 계열(구성요소 하나의 계좌 기준). */
interface Sl { dates: string[]; ret: number[]; costFrac: number[]; nPos: number[]; inv: number[]; turn: number[]; wMax: number[] }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const kstMin = (): number => { const k = new Date(Date.now() + 9 * 3_600_000); return k.getUTCHours() * 60 + k.getUTCMinutes(); };
const inBlock = (): boolean => { const m = kstMin(); return m >= BENCH_AUX_BLOCK_FROM_KST_MIN && m < BENCH_AUX_BLOCK_TO_KST_MIN; };
const num = (s: string | undefined): number | null => { const n = Number(String(s ?? "").replace(/,/g, "")); return String(s ?? "").trim() !== "" && Number.isFinite(n) ? n : null; };
interface CloseRec { px: number; src: string }

/** 이전 로그 CSV(있으면): 날짜 → 열 값. 069500 종가 기억과 달라진 행 비교에 쓴다. */
async function readPrevLog(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  let text: string;
  try { text = await fs.readFile(DS6F_LOG_CSV, "utf8"); } catch { return out; }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return out;
  if (lines[0] !== DS6F_CSV_HEADER) throw new Error(`${DS6F_LOG_CSV} 헤더가 기대와 다르다 — 덮어쓰지 않고 중단한다`);
  for (const l of lines.slice(1)) { const c = l.split(","); if (c.length !== DS6F_CSV_HEADER.split(",").length) throw new Error(`${DS6F_LOG_CSV} 열 수 이상: ${l.slice(0, 80)}`); out.set(c[0], c); }
  return out;
}

async function main(): Promise<void> {
  const PHASE = process.env.FWD_PHASE?.trim();
  if (PHASE !== "verify" && PHASE !== "forward") throw new Error("FWD_PHASE=verify|forward 필요");
  const FORWARD = PHASE === "forward";
  console.log(`연구 DS6 포워드 관찰(시험 아님, 시험 번호 273 유지) 단계=${PHASE} 시작(읽기 전용): ${new Date().toISOString()} (KST 분 ${kstMin()}) | 정의 커밋 ${DS6F_DEF_COMMITS.join(", ")} | 고정 날짜 ${DS6F_FIXED_DATE}`);
  if (process.env.BENCH_AUX_069500 !== "1") throw new Error("069500 보조 파일 모드(BENCH_AUX_069500=1)가 아니면 실행하지 않는다");
  const prevLog = FORWARD ? await readPrevLog() : new Map<string, string[]>();
  const closes = new Map<string, CloseRec & { fresh: boolean }>();
  let krxRequests = 0, krxNote = "";
  if (!FORWARD) {
    if (SNAP_END !== DS6F_FIXED_DATE || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("검증 단계는 고정 스냅샷 모드(RESEARCH_DATA_END=고정 날짜, PARQUET_CACHE_FROZEN=1)여야 한다");
    console.log(await verifySnapshotManifest());
  } else {
    if (SNAP_END || process.env.PARQUET_CACHE_FROZEN === "1") throw new Error("관찰 단계는 고정 스냅샷 모드가 아니어야 한다(RESEARCH_DATA_END 없음, PARQUET_CACHE_FROZEN 없음)");
    if (inBlock()) throw new Error(`KST 14:00~15:40에는 실행하지 않는다(현재 KST 분 ${kstMin()}) — 아무것도 읽지 않고 종료`);
    if (!process.env.PARQUET_CACHE_DIR) throw new Error("PARQUET_CACHE_DIR(복원한 고정 스냅샷 캐시) 없음 — 읽지 않고 중단한다");
    process.env.PARQUET_CACHE_DOWNLOAD_ONLY_YEARS = DS6F_DOWNLOAD_YEARS;
    await fs.access(DS6F_VERIFY_FILE).catch(() => { throw new Error(`${DS6F_VERIFY_FILE} 없음 — 검증 단계를 먼저 통과해야 한다`); });
    console.log(`관찰 단계: 가격 Parquet은 캐시 적중이 기본이고 캐시와 달라 받아야 하는 연도는 ${DS6F_DOWNLOAD_YEARS}만 허용(그 밖이면 받지 않고 중단), 새 Actions 캐시 저장 없음`);
  }

  // ---- 069500 보조 파일 뒤 날짜 종가: 로그 CSV(기억) → etf_daily_prices.raw_close → KRX etp/etf_bydd_trd(없는 거래일만) ----
  const extendBench = async (cal: string[], auxLast: string): Promise<[string, number, number][]> => {
    const need = cal.filter((d) => d > auxLast);
    if (!need.length) return [];
    const dbRows = await selectAll<{ trade_date: string; raw_close: number | null }>("etf_daily_prices(069500, 보조 파일 뒤)", (f, t) => supabaseAdmin.from("etf_daily_prices").select("trade_date, raw_close").eq("code", SEASON_STOCK_CODE).gt("trade_date", auxLast).order("trade_date").range(f, t));
    const dbMap = new Map(dbRows.filter((r) => r.raw_close !== null).map((r) => [r.trade_date, Number(r.raw_close)]));
    const csvClose = (d: string): CloseRec | undefined => { const c = prevLog.get(d); const px = c ? num(c[8]) : null; return c && px !== null ? { px, src: c[9] } : undefined; };
    const unresolved = need.filter((d) => !csvClose(d) && !dbMap.has(d));
    console.log(`069500 종가 필요 거래일 ${need.length}일(${need[0]}~${need[need.length - 1]}): 로그 CSV ${need.filter((d) => csvClose(d)).length}일, etf_daily_prices ${need.filter((d) => !csvClose(d) && dbMap.has(d)).length}일, KRX 필요 ${unresolved.length}일`);
    if (unresolved.length > DS6F_KRX_CAP) throw new Error(`KRX 필요 ${unresolved.length}일이 요청 상한 ${DS6F_KRX_CAP}을 넘는다 — 호출하지 않고 중단`);
    const out: [string, number, number][] = [];
    for (const d of need) {
      const c = csvClose(d), b = dbMap.get(d);
      if (c && b !== undefined && Math.abs(c.px - b) > 1e-9) throw new Error(`${d} 069500 종가가 로그 CSV(${c.px})와 etf_daily_prices(${b})에서 다르다 — 중단`);
      if (c) { closes.set(d, { ...c, fresh: false }); out.push([d, c.px, 2]); continue; }
      if (b !== undefined) { closes.set(d, { px: b, src: "db", fresh: true }); out.push([d, b, 2]); continue; }
      if (inBlock()) throw new Error(`KRX 호출 중 KST 14:00 금지 시간대에 들어섰다(${d}에서 중단)`);
      const key = process.env.KRX_API_KEY;
      if (!key) throw new Error("KRX_API_KEY 환경변수가 필요하다(키 값은 출력하지 않는다)");
      await sleep(BENCH_AUX_KRX_GAP_MS);
      krxRequests++;
      const res = await fetch(`${DS6F_KRX_BASE}/etp/etf_bydd_trd?basDd=${d.replace(/-/g, "")}`, { headers: { AUTH_KEY: key } });
      const text = await res.text();
      let j: { OutBlock_1?: Record<string, string>[] } | null = null;
      try { j = JSON.parse(text) as { OutBlock_1?: Record<string, string>[] }; } catch { j = null; }
      const block = j?.OutBlock_1 ?? [];
      console.log(`  KRX ${d}: HTTP ${res.status}, 응답 ${block.length}행`);
      if (res.status !== 200) throw new Error(`${d} KRX 응답 이상(HTTP ${res.status}) — 중단(로그를 쓰지 않음)`);
      if (block.length === 0) { krxNote = `${d}부터 KRX에 아직 자료 없음(응답 0행) — 관찰 구간은 ${out[out.length - 1]?.[0] ?? auxLast}까지`; console.log(`  ${krxNote}`); break; }
      const px = num(block.find((x) => x.ISU_CD === SEASON_STOCK_CODE)?.TDD_CLSPRC);
      if (px === null) throw new Error(`${d} KRX 응답에 069500 종가가 없다 — 중단`);
      closes.set(d, { px, src: "krx", fresh: true }); out.push([d, px, 2]);
    }
    return out;
  };

  const h = await loadHarness(FORWARD ? { extendBench } : undefined);
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, nameOf, mmDates } = await loadK200P(h);
  const mmLast = mmDates[mmDates.length - 1];
  const mmFor = (d: string): string => { let lo = 0, hi = mmDates.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (mmDates[m] <= d) { k = m; lo = m + 1; } else hi = m - 1; } return k >= 0 ? mmDates[k] : ""; };

  // ---- 평가 구간: 초기 배분 2011-01-03 종가(LV1 250거래일 워밍업 뒤 첫 거래일), 수익 집계 2011-01-04~ ----
  const cPE = CAL.findIndex((d) => d >= P17_RUN_START);
  if (cPE < 0 || CAL[cPE] !== P17_RUN_START) throw new Error(`${P17_RUN_START}이 거래일 달력에 없음`);
  const cutC = cPE + 1;
  const FULL: Win = { from: CAL[cutC], to: "9999-12-31" };
  const WA: Win = { from: FULL.from, to: P17_END }, WREC: Win = { from: FULL.from, to: DS6F_FIXED_DATE };
  console.log(`평가: 초기 배분 ${CAL[cPE]} 종가(비용 없음), 수익 집계 ${FULL.from}~${h.dataEnd}`);

  const env = (cS: number, over: Partial<{ baseSlip: number }> = {}) => ({ CAL, nCal, cS, adjustments: h.adjustments, endedBefore: h.endedBefore, stockBuyMult: h.stockBuyMult, sellRate: h.sellRate, baseSlip: SLIPPAGE_PCT_PER_SIDE, bhRet: h.bhRet, ...over });
  
  // ---- 시총 순위(W3 아님: L3·LV1용) ----
  const megaCache = new Map<number, { list: S[]; rank: Map<string, number> }>();
  const megaAt = (c: number, depth: number): { list: S[]; rank: Map<string, number> } => {
    let v = megaCache.get(c);
    if (!v) {
      const d = CAL[c], m = membAt(d), e: { s: S; mc: number }[] = [];
      if (m) for (const s of h.stocks) {
        const i = s.idx.get(d);
        if (i === undefined || excluded.has(s.code) || m.get(s.code) !== "KOSPI") continue;
        e.push({ s, mc: s.mcapRow[i] });
      }
      e.sort((a, b) => b.mc - a.mc || (a.s.code < b.s.code ? -1 : 1));
      const list = e.slice(0, LE_RANK_DEPTH).map((x) => x.s);
      v = { list, rank: new Map(list.map((s, k) => [s.code, k + 1])) };
      megaCache.set(c, v);
    }
    void depth;
    return v;
  };
  // 주의: L3는 순위 깊이 30, LV1은 60까지 담지만 L3는 상위 5위·10위 밖만, LV1은 풀 30·시총 40위 밖만 본다. 같은 정렬의 앞부분이므로 깊이 60 목록으로 둘 다 재현된다(재현 확인으로 검증).
  let runLV1!: (lag: number) => SimRun;
  // ================= LV1 (LE2 + 변동성 목표화) =================
  {
    const LE2 = LE_CANDS.LE2, cd = LV_CANDS.LV1;
    const cS = CAL.findIndex((d) => d >= L_EVAL_AFTER);
    if (cS < 0) throw new Error(`${L_EVAL_AFTER} 이후 거래일 없음`);
    const legRets = (s: S, i: number): number[] => LE_LEGS.map((lg) => {
      if (i < lg.lookback) return NaN;
      const a = s.close[i - lg.skip], b = s.close[i - lg.lookback];
      return a > 0 && b > 0 ? a / b - 1 : NaN;
    });
    const ensCache = new Map<number, EnsembleRanking & { sOf: Map<string, S> }>();
    const ensAt = (c: number): EnsembleRanking & { sOf: Map<string, S> } => {
      let v = ensCache.get(c);
      if (!v) {
        const d = CAL[c], items: { code: string; rets: number[] }[] = [], sOf = new Map<string, S>();
        for (const s of megaAt(c, LE_RANK_DEPTH).list.slice(0, LE2.pool)) {
          const rets = legRets(s, s.idx.get(d)!);
          if (rets.every(Number.isFinite)) { items.push({ code: s.code, rets }); sOf.set(s.code, s); }
        }
        v = { ...rankEnsemble(items), sOf };
        ensCache.set(c, v);
      }
      return v;
    };
    const alignedCache = new Map<string, Float64Array>();
    const alignedOf = (code: string): Float64Array => { let a = alignedCache.get(code); if (!a) { const s = byCode.get(code)!; a = alignCloses(CAL, s.idx, s.close); alignedCache.set(code, a); } return a; };
    const vt: SimVt = { sizeMult: (c, stocks) => volMultiplier(equalWeightSigma(stocks.map((s) => alignedOf(s.code)), c, LV_WINDOW, LV_ANNUAL_DAYS), cd.target, LV_ROUND_DP), band: LV_BAND };
    const cfg = { slip: L_SLIPPAGE, maxPos: LE2.slots, capFrac: 1 / LE2.slots, cooldown: LS_COOLDOWN_DAYS, vt };
    const entryList = (c: number): SimCand[] => {
      const en = ensAt(c), out: SimCand[] = [];
      for (let k = 0; k < LE2.slots && k < en.items.length; k++) { const it = en.items[k]; if (it.rets[LE_ENTRY_LEG] > 0) out.push({ s: en.sOf.get(it.code)!, code: it.code }); }
      return out;
    };
    const hooks = {
      candsOf: (c: number): SimCand[] => entryList(c),
      exitReason: (p: SimPos, c: number, i: number | undefined): string | null => {
        if (i === undefined) return null;
        if ((megaAt(c, LE_RANK_DEPTH).rank.get(p.code) ?? Number.POSITIVE_INFINITY) > LE2.keepCap) return "시총 순위 밖";
        const rets = legRets(byCode.get(p.code)!, i);
        if (!rets.every(Number.isFinite)) return null;
        const en = ensAt(c);
        const r = en.rank.get(p.code) ?? outsiderEnsembleRank(en, rets);
        return r > LE2.keepRank ? "앙상블 순위 밖" : null;
      },
    };
    runLV1 = (lag) => simSlots(env(cS), cfg, hooks, { lag, detail: true });
  }

  // ================= 코어: 월말 K200P 구성(PIT) 안 당일 시총 상위 N종목, 시총 비율 보유 (연구 CS) =================
  // 신호: 판단일 c 종가에서 megaAt(c)의 상위 N종목(그날 월말 K200P 구성원, 코스피, 제외 규칙 적용 — 연구 L3와 같은 목록). 체결: c + lag 종가.
  // 교체: 보유 종목이 상위 N위 밖에 CS_SWAP_CONFIRM_DAYS 거래일 연속 머물 때만, 그 종목을 팔고 상위 N위 안에 있으나 보유하지 않은 가장 시총 큰 종목으로 바꾼다.
  // 비중: 처음 편입과 구성이 바뀌는 체결일에만 신호일 시총 비율로 맞추고(팔고 사는 금액에만 비용), 그 사이엔 가격 변동 그대로 둔다. 비용: env의 매수 배수·매도 비용률(수수료 0.015% + 거래세 + 슬리피지 0.1%).
  interface CorePos { code: string; s: S; shares: number; lastPx: number; entryC: number; spend: number; vAtEntry: number; rep: boolean; repVal: number; realized: number; out: number }
  interface CoreEvent { c: number; sells: string[]; buys: string[]; set: string[]; w: number[] }
  type CoreRun = SimRun & { open: SimTrade[]; events: CoreEvent[]; forcedExit: number };
  const mcapNear = (s: S, c: number): number => { for (let k = c; k >= Math.max(c - 10, 0); k--) { const i = s.idx.get(CAL[k]); if (i !== undefined && s.mcapRow[i] > 0) return s.mcapRow[i]; } return Number.NaN; };
  const simCore = (N: number, o: { lag: number; replace?: Set<string>; onDay?: (c: number, V: number, held: [string, number][]) => void; exclude?: ReadonlySet<string>; dropTop?: number }): CoreRun => {
    const e = env(cPE), buyMult = e.stockBuyMult;
    const pos = new Map<string, CorePos>();
    let cash = 1, prevV = 1, forcedExit = 0;
    const out: CoreRun = { dates: [], ret: [], costFrac: [], nPos: [], inv: [], turn: [], trades: [], entryCs: [], wMax: [], haltSkip: 0, exitDefer: 0, open: [], events: [], forcedExit: 0 };
    let pend: { c: number; sells: string[]; buys: string[]; mc: Map<string, number> } | null = null;
    const val = (p: CorePos): number => (p.rep ? p.repVal : p.shares * p.lastPx);
    const pushTrade = (p: CorePos, c: number, net: number, reason: string, into: SimTrade[]): void => { into.push({ code: p.code, entryC: p.entryC, exitC: c, spend: p.spend, proceeds: net + p.realized, vAtEntry: p.vAtEntry, reason, entryAdj: 0, peakAdj: 0, exitAdj: 0, entryRaw: 0 }); };
    for (let c = cPE; c < nCal; c++) {
      const d = CAL[c], sr = e.sellRate(d);
      let costF = 0, buyN = 0, sellN = 0;
      for (const p of [...pos.values()]) {
        const i = p.s.idx.get(d);
        if (i !== undefined) { p.lastPx = p.s.close[i]; if (p.rep) p.repVal *= 1 + (e.bhRet.get(d) ?? 0); }
        else if (p.s.last < d && p.s.last < e.endedBefore) { const v = val(p); cash += v * (1 - sr); pushTrade(p, c, v * (1 - sr), "폐지", out.trades); pos.delete(p.code); costF += (v * sr) / prevV; sellN += v; forcedExit++; }
      }
      if (pend && pend.c === c) {
        const ev = pend;
        const final = [...[...pos.keys()].filter((k) => !ev.sells.includes(k)), ...ev.buys];
        const halted = [...new Set([...ev.sells, ...final])].some((code) => { const s = byCode.get(code); const i = s?.idx.get(d); return !s || i === undefined || s.vol[i] === 0; });
        if (halted) { out.haltSkip++; ev.c = c + 1; } else {
          pend = null;
          for (const code of ev.sells) {
            const p = pos.get(code);
            if (!p) continue;
            const v = val(p);
            cash += v * (1 - sr); pushTrade(p, c, v * (1 - sr), "시총 순위 밖", out.trades); pos.delete(code); costF += (v * sr) / prevV; sellN += v;
          }
          const sumMc = final.reduce((a, code) => a + (ev.mc.get(code) as number), 0);
          let V0 = cash;
          for (const p of pos.values()) V0 += val(p);
          const target = (code: string): number => (V0 * (ev.mc.get(code) as number)) / sumMc;
          for (const p of pos.values()) {
            const cur = val(p), t = target(p.code);
            if (!(cur > t)) continue;
            const sold = cur - t;
            p.shares -= sold / p.lastPx;
            if (p.rep) p.repVal -= sold;
            const net = sold * (1 - sr);
            cash += net; p.realized += net; sellN += sold; costF += (sold * sr) / prevV;
          }
          const needs: { code: string; need: number }[] = [];
          for (const code of final) { const p = pos.get(code); const cur = p ? val(p) : 0, t = target(code); if (t > cur) needs.push({ code, need: t - cur }); }
          const totalNeed = needs.reduce((a, x) => a + x.need, 0);
          const scale = totalNeed > 0 ? Math.min(1, cash / (buyMult * totalNeed)) : 0;
          for (const { code, need } of needs) {
            const x = need * scale, outlay = x * buyMult, p = pos.get(code);
            cash -= outlay; buyN += outlay; costF += (outlay - x) / prevV;
            if (p) { p.spend += outlay; p.shares += x / p.lastPx; if (p.rep) p.repVal += x; } else {
              const s = byCode.get(code) as S, i = s.idx.get(d) as number, adj = s.close[i];
              pos.set(code, { code, s, shares: x / adj, lastPx: adj, entryC: c, spend: outlay, vAtEntry: V0, rep: !!o.replace?.has(`${code}|${c}`), repVal: x, realized: 0, out: 0 });
              out.entryCs.push(c);
            }
          }
          const pv = final.map((code) => val(pos.get(code) as CorePos)), pvs = pv.reduce((a, x) => a + x, 0);
          out.events.push({ c, sells: ev.sells, buys: ev.buys, set: final, w: pv.map((x) => x / pvs) });
        }
      }
      let V = cash;
      for (const p of pos.values()) V += val(p);
      if (c > cPE) {
        out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.costFrac.push(costF); out.nPos.push(pos.size);
        out.inv.push(V > 0 ? (V - cash) / V : 0);
        o.onDay?.(c, V, [...pos.values()].map((p) => [p.code, val(p)] as [string, number]));
        if (buyN + sellN > 1e-12) out.turn.push({ d, v: prevV > 0 ? (buyN + sellN) / 2 / prevV : 0 });
        let mx = 0;
        for (const p of pos.values()) { const v = val(p); if (v > mx) mx = v; }
        out.wMax.push(pos.size && V > 0 ? mx / V : Number.NaN);
      }
      if (c + o.lag < nCal) {
        const top = megaAt(c, CS_RANK_DEPTH).list.filter((s) => !o.exclude?.has(s.code)).slice(o.dropTop ?? 0, (o.dropTop ?? 0) + N), topSet = new Set(top.map((s) => s.code));
        for (const p of pos.values()) p.out = topSet.has(p.code) ? 0 : p.out + 1;
        if (!pend) {
          const sells = [...pos.values()].filter((p) => p.out >= CS_SWAP_CONFIRM_DAYS).map((p) => p.code);
          const need = N - (pos.size - sells.length);
          if (sells.length > 0 || need > 0) {
            const buys = top.filter((s) => !pos.has(s.code)).slice(0, Math.max(need, 0)).map((s) => s.code);
            const mc = new Map<string, number>();
            for (const code of [...pos.keys()].filter((k) => !sells.includes(k)).concat(buys)) mc.set(code, mcapNear(byCode.get(code) as S, c));
            if ([...mc.values()].every((x) => Number.isFinite(x) && x > 0) && (sells.length > 0 || buys.length > 0)) pend = { c: c + o.lag, sells, buys, mc };
          }
        }
      }
      prevV = V;
    }
    const last = CAL[nCal - 1], srl = e.sellRate(last);
    for (const p of pos.values()) pushTrade(p, nCal - 1, val(p) * (1 - srl), "기간 끝 평가", out.open);
    out.forcedExit = forcedExit;
    return out;
  };

  // ---- 공통 평가 시작으로 자른 계열 ----
  const slice = (r: SimRun): Sl => {
    const k0 = r.dates.findIndex((d) => d >= FULL.from);
    if (k0 < 0) throw new Error("자를 지점 없음");
    const tm = new Map(r.turn.map((x) => [x.d, x.v]));
    const dates = r.dates.slice(k0);
    if (r.costFrac.length !== r.dates.length || r.nPos.length !== r.dates.length || r.inv.length !== r.dates.length) throw new Error("일별 계열 길이 불일치");
    return { dates, ret: r.ret.slice(k0), costFrac: r.costFrac.slice(k0), nPos: r.nPos.slice(k0), inv: r.inv.slice(k0), turn: dates.map((d) => tm.get(d) ?? 0), wMax: r.wMax.length === r.dates.length ? r.wMax.slice(k0) : dates.map(() => NaN) };
  };
  const satSl = slice(runLV1(1));
  const holdAt = new Map<string, string>();
  const coreRun = simCore(P17_CAND.coreN, { lag: 1, onDay: (c, V, held) => { const d = CAL[c]; if (d > DS6F_FIXED_DATE) holdAt.set(d, held.map(([code, v]) => `${code}:${((v / V) * 100).toFixed(1)}`).join("|")); } });
  const coreSl = slice(coreRun);
  const dates0 = satSl.dates, nDays = dates0.length;
  if (coreSl.dates.length !== nDays || coreSl.dates.some((d, k) => d !== dates0[k])) throw new Error("코어와 LV1의 날짜 축이 다르다");
  console.log(`코어: 이벤트 ${coreRun.events.length}회(교체 ${coreRun.events.filter((e) => e.sells.length).length}회), 폐지 강제 청산 ${coreRun.forcedExit}건, 거래정지 순연 ${coreRun.haltSkip}건 | 일별 계열 ${nDays}일 ${dates0[0]}~${dates0[nDays - 1]}`);

  // ---- 코어-위성 합성: 코어 비중 w, 위성 1 − w, 매일 종가에 목표 비율 계산 → 다음 거래일 종가에 고정 금액 이동(연구 ALLOC P형과 같은 방식), 이동 금액의 CS_MOVE_COST ----
  interface CombOut { run: SimRun; wCore: number[]; cost: number[]; moved: number[] }
  const combineCS = (core: Sl, sat: Sl, wC: number, rate: number, delay = 0): CombOut => {
    // delay: 목표 비중 이동을 더 늦추는 거래일 수(0 = 종가 t에 계산해 t+1 종가 체결, 1 = t+2 종가 체결). 이동 중인 금액은 새 목표 계산에서 이미 반영된 것으로 본다.
    const parts = [core, sat], s = [wC, 1 - wC], q: number[][] = [];
    const ret: number[] = [], costFrac: number[] = [], nPos: number[] = [], inv: number[] = [], turn: number[] = [], wMax: number[] = [], wCore: number[] = [], cost: number[] = [], moved: number[] = [];
    for (let i = 0; i < nDays; i++) {
      const Vprev = s[0] + s[1], wPrev = [s[0] / Vprev, s[1] / Vprev];
      for (let j = 0; j < 2; j++) s[j] *= 1 + parts[j].ret[i] / 100;
      let mv = 0, cs = 0;
      const pending = q.length > delay ? (q.shift() as number[]) : [0, 0];
      if (pending[0] !== 0 || pending[1] !== 0) {
        for (let j = 0; j < 2; j++) { s[j] += pending[j]; if (pending[j] > 0) mv += pending[j]; }
        cs = rate * mv;
        if (mv > 0) for (let j = 0; j < 2; j++) if (pending[j] > 0) s[j] -= (cs * pending[j]) / mv;
      }
      const V = s[0] + s[1], wc = s.map((x) => x / V);
      ret.push((V / Vprev - 1) * 100); wCore.push(wc[0]); cost.push(cs / Vprev); moved.push(mv / Vprev);
      costFrac.push(wPrev[0] * core.costFrac[i] + wPrev[1] * sat.costFrac[i] + cs / Vprev);
      nPos.push(core.nPos[i] + sat.nPos[i]);
      inv.push(wc[0] * core.inv[i] + wc[1] * sat.inv[i]);
      turn.push(wPrev[0] * core.turn[i] + wPrev[1] * sat.turn[i] + mv / Vprev);
      const wm = [wPrev[0] * core.wMax[i], wPrev[1] * sat.wMax[i]].filter(Number.isFinite);
      wMax.push(wm.length ? Math.max(...wm) : Number.NaN);
      const infl = [0, 0];
      for (const p of q) { infl[0] += p[0]; infl[1] += p[1]; }
      q.push([wC * V - s[0] - infl[0], (1 - wC) * V - s[1] - infl[1]]);
    }
    return { run: { dates: dates0, ret, costFrac, nPos, inv, turn: turn.map((v, i) => ({ d: dates0[i], v })), trades: [], entryCs: [], wMax, haltSkip: 0, exitDefer: 0 }, wCore, cost, moved };
  };

  // ---- DS6 = 코어 40% + LV1 60%, 일별 목표 비중(코어 40%) 이동 비용 0.25% (시도 272 정의) ----
  const base = combineCS(coreSl, satSl, P17_CAND.coreW, CS_MOVE_COST, 0);

  // ---- 고정 구간 재계산 검증(기록값과 2자리 반올림 문자열이 같아야 한다; 다르면 중단하고 보고) ----
  const sA = h.st(base.run, WA), sF = h.st(base.run, WREC);
  const okA = f2(sA.cagr) === DS6F_REC_A.cagr && f2(sA.mdd) === DS6F_REC_A.mdd;
  const okF = f2(sF.cagr) === DS6F_REC_FULL.cagr && f2(sF.mdd) === DS6F_REC_FULL.mdd;
  console.log(`\n=== 검증: 고정 구간 재계산 vs 기록값 (CAGR % / MDD %) ===\n| 구간 | 이번 계산 | 기록값 | 판정 |\n|---|---|---|---|\n| ${WA.from}~2016-12-29 | ${f2(sA.cagr)} / ${f2(sA.mdd)} | ${DS6F_REC_A.cagr} / ${DS6F_REC_A.mdd} | ${okA ? "일치" : "불일치"} |\n| ${WREC.from}~${DS6F_FIXED_DATE} | ${f2(sF.cagr)} / ${f2(sF.mdd)} | ${DS6F_REC_FULL.cagr} / ${DS6F_REC_FULL.mdd} | ${okF ? "일치" : "불일치"} |`);
  if (!okA || !okF) throw new Error("고정 구간 재계산이 기록값과 다르다 — 관찰 단계로 넘어가지 않고 멈춘다. 보고한다");

  const preIdx: number[] = [];
  for (let i = 0; i < nDays; i++) if (dates0[i] <= DS6F_FIXED_DATE) preIdx.push(i);
  if (!FORWARD) {
    await fs.mkdir(DS6F_WORK_DIR, { recursive: true });
    await fs.writeFile(DS6F_VERIFY_FILE, JSON.stringify({ fixedDate: DS6F_FIXED_DATE, dates: preIdx.map((i) => dates0[i]), ret: preIdx.map((i) => base.run.ret[i]) }));
    const line = `검증 단계 통과: 고정 구간 재계산이 기록값과 일치(${DS6F_REC_A.cagr}/${DS6F_REC_A.mdd}, ${DS6F_REC_FULL.cagr}/${DS6F_REC_FULL.mdd}), 고정 구간 일별 ${preIdx.length}일 저장`;
    console.log(`\n${line}\n${storageLine()} | Supabase 쓰기 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 1000).toFixed(0)}초`);
    return;
  }

  // ---- 관찰 단계: 라이브 데이터 계산의 고정 구간이 검증 단계(고정 스냅샷) 일별 수익과 같은지 정보로 대조 ----
  const ref = JSON.parse(await fs.readFile(DS6F_VERIFY_FILE, "utf8")) as { fixedDate: string; dates: string[]; ret: number[] };
  let maxD = 0, nDiff = 0, shapeOk = ref.fixedDate === DS6F_FIXED_DATE && ref.dates.length === preIdx.length;
  if (shapeOk) preIdx.forEach((i, k) => { if (dates0[i] !== ref.dates[k]) shapeOk = false; else { const df = Math.abs(base.run.ret[i] - ref.ret[k]); if (df > DS6F_PREFIX_INFO_TOL_PP) nDiff++; maxD = Math.max(maxD, df); } });
  console.log(`라이브 데이터 계산의 고정 구간 일별 수익 vs 검증 단계(고정 스냅샷): 날짜 ${shapeOk ? "일치" : "불일치"}, ${DS6F_PREFIX_INFO_TOL_PP}%p 넘게 다른 날 ${nDiff}일, 최대 차이 ${maxD.toExponential(2)}%p (정보용; 기록값 불일치만 중단 사유)`);

  const bMap = new Map(h.bhP.dates.map((d, i) => [d, h.bhP.ret[i]]));
  const obs: number[] = [];
  for (let i = 0; i < nDays; i++) { if (dates0[i] <= DS6F_FIXED_DATE) continue; if (!bMap.has(dates0[i])) break; obs.push(i); }
  const nAt = (d: string): number => h.stocks.filter((s) => s.idx.has(d)).length;
  const lastTwo = CAL.slice(-2);
  const cnt = lastTwo.map(nAt);
  console.log(`가격 데이터 마지막 거래일 ${h.dataEnd} | 최근 두 거래일 종목 수 ${lastTwo.map((d, k) => `${d} ${cnt[k]}`).join(", ")}${cnt[1] < cnt[0] * DS6F_PARTIAL_DAY_RATIO ? " — 경고: 마지막 날 종목 수가 크게 적다(부분 데이터 가능)" : ""}`);

  let V = 1, B = 1, peakV = 1, peakB = 1, minDdV = 0, minDdB = 0;
  const rows: string[][] = [];
  for (const i of obs) {
    const d = dates0[i], r = base.run.ret[i], rb = bMap.get(d) as number, cl = closes.get(d);
    if (!cl) throw new Error(`${d} 069500 원주가 종가 기록이 없다`);
    V *= 1 + r / 100; B *= 1 + rb / 100; peakV = Math.max(peakV, V); peakB = Math.max(peakB, B);
    const ddV = (V / peakV - 1) * 100, ddB = (B / peakB - 1) * 100;
    minDdV = Math.min(minDdV, ddV); minDdB = Math.min(minDdB, ddB);
    rows.push([d, r.toFixed(4), rb.toFixed(4), ((V - 1) * 100).toFixed(4), ((B - 1) * 100).toFixed(4), ((V - B) * 100).toFixed(4), ddV.toFixed(4), ddB.toFixed(4), String(cl.px), cl.src, holdAt.get(d) ?? "", mmFor(d)]);
  }
  let nChanged = 0;
  for (const r of rows) { const p = prevLog.get(r[0]); if (p && (p[1] !== r[1] || p[2] !== r[2])) nChanged++; }
  await fs.mkdir(path.dirname(DS6F_LOG_CSV), { recursive: true });
  await fs.writeFile(DS6F_LOG_CSV, [DS6F_CSV_HEADER, ...rows.map((r) => r.join(","))].join("\n") + "\n");

  console.log(`\n=== 관찰 구간 (고정 날짜 ${DS6F_FIXED_DATE} 종가 = 100, 다음 거래일부터) 마지막 10일 ===\n| 날짜 | DS6 일 % | 069500 일 % | DS6 누적 % | 069500 누적 % | 초과 %p | DS6 낙폭 % | 069500 낙폭 % | 코어 보유(코어 안 비중 %) |\n|---|---|---|---|---|---|---|---|---|`);
  for (const r of rows.slice(-10)) console.log(`| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4]} | ${r[5]} | ${r[6]} | ${r[7]} | ${r[10].split("|").map((x) => { const [c, w] = x.split(":"); return `${nameOf.get(c) ?? c} ${w}`; }).join(" / ")} |`);
  const last = rows[rows.length - 1];
  const mmWarn = last && mmLast < last[0] ? ` (관찰 마지막 날 ${last[0]}보다 ${Math.round((Date.parse(last[0]) - Date.parse(mmLast)) / 86_400_000)}일 앞선 스냅샷)` : "";
  const summary = last
    ? `DS6 포워드 ${rows[0][0]}~${last[0]}(${rows.length}거래일): DS6 누적 ${last[3]}% / 069500 누적 ${last[4]}% / 초과 ${last[5]}%p | 낙폭 현재 DS6 ${last[6]}% 069500 ${last[7]}%, 최저 DS6 ${minDdV.toFixed(2)}% 069500 ${minDdB.toFixed(2)}% | 마지막 월말 구분 날짜 ${mmLast}${mmWarn} | 검증 일치(${DS6F_REC_A.cagr}/${DS6F_REC_A.mdd}, ${DS6F_REC_FULL.cagr}/${DS6F_REC_FULL.mdd}) | 정의 커밋 ${DS6F_DEF_COMMITS.join(",")}`
    : `DS6 포워드: 관찰 구간 0거래일(고정 날짜 ${DS6F_FIXED_DATE} 이후 DS6·069500 모두 있는 거래일 없음) | 마지막 월말 구분 날짜 ${mmLast}`;
  const resLine = `${storageLine()} | 가격 Parquet 다운로드 ${parquetCacheStats.downloads}건 ${(parquetCacheStats.downloadBytes / 1048576).toFixed(2)} MiB, 캐시 적중 ${parquetCacheStats.hits}건 | KRX 요청 ${krxRequests}건 | Supabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" ; ")} | Supabase 쓰기 0 | Storage 쓰기 0 | 이전 로그와 일수익이 달라진 행 ${nChanged}개 | ${krxNote || "069500 종가 미확보 날짜 없음"} | DS6 기준 데이터 마지막 날 ${h.dataEnd}, 관찰 마지막 날 ${last?.[0] ?? "-"}`;
  console.log(`\n${summary}\n${resLine}\n로그 ${DS6F_LOG_CSV} ${rows.length}행 ${(Buffer.byteLength(rows.map((r) => r.join(",")).join("\n")) / 1024).toFixed(1)} KB | 소요 ${((Date.now() - T0) / 1000).toFixed(0)}초`);
  await fs.mkdir(DS6F_WORK_DIR, { recursive: true });
  await fs.writeFile(DS6F_SUMMARY_FILE, `${summary}\n${resLine}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `### DS6 포워드 관찰\n\n${summary}\n\n${resLine}\n`);
  void membAt; void excluded; void byCode; void nCal;
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

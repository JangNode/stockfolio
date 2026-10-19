/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 업종 ETF 모멘텀 S1~S3 → 학습 선택 → 확인 → (통과 시) 홀드아웃.
 * 정의는 research/sector-etf-momentum-prereg.md. etf_krx_daily 읽기만. DB 쓰기 없음.
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { computeCumulativeAndMdd, computeCagrPct } from "@/lib/strategyBacktestSummary";
import { KRX_SECTOR_KEYWORDS, KRX_SECTOR_EXCLUDE, KRX_SECTOR_FOREIGN_RE, KRX_SECTOR_DOMESTIC_RE } from "@/lib/krxSectorEtfConfig";
import {
  SECTOR_MOM_MIN_AVG_TV_WON, SECTOR_MOM_TV_SHORT_DAYS, SECTOR_MOM_TV_LONG_DAYS, SECTOR_MOM_HISTORY_DAYS, SECTOR_MOM_SKIP_DAYS, SECTOR_MOM_R6_DAYS,
  SECTOR_MOM_TOP_N, SECTOR_MOM_FEE_RATE, SECTOR_MOM_SLIPPAGE_RATE, SECTOR_MOM_BASE_CODE, SECTOR_MOM_SAFE_CODE, SECTOR_MOM_LEARN, SECTOR_MOM_CONFIRM,
  SECTOR_MOM_HOLDOUT_FROM, SECTOR_MOM_G3_MDD_MARGIN_PP, SECTOR_MOM_G5_MAX_DELAY_DROP_PP, SECTOR_MOM_TRADING_DAYS_PER_YEAR, SECTOR_MOM_READ_PAGE,
} from "@/lib/sectorEtfMomentumConfig";

const T0 = Date.now();
const COST = SECTOR_MOM_FEE_RATE + SECTOR_MOM_SLIPPAGE_RATE;
const MS_DAY = 86_400_000;
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "-");
const ox = (b: boolean): string => (b ? "O" : "X");
let dbRead = 0;

type VarId = "S1" | "S2" | "S3" | "SEW";
interface Rep { code: string; sector: string; r121: number; r6: number; tv60: number }
interface Decision { k: number; date: string; w: Map<string, number>; sectors: string[]; repCount: number }
interface Run { dates: string[]; ret: number[]; costFrac: number[]; turn: number[]; delist: number; decisions: Decision[] }
interface Stats { cagr: number; mdd: number; cm: number; vol: number; cost: number; turn: number }
interface Win { from: string; to: string; excl?: boolean }

async function main(): Promise<void> {
  console.log(`업종 ETF 모멘텀 시작(읽기 전용): ${new Date().toISOString()}`);
  // ---- 데이터 읽기 ----
  interface Row { d: string; code: string; nm: string; px: number; tv: number; idxNm: string }
  const rows: Row[] = [];
  for (let from = 0; ; from += SECTOR_MOM_READ_PAGE) {
    const { data, error } = await supabaseAdmin.from("etf_krx_daily").select("bas_dd, isu_cd, isu_nm, tdd_clsprc, acc_trdval, idx_ind_nm").order("isu_cd").order("bas_dd").range(from, from + SECTOR_MOM_READ_PAGE - 1);
    if (error) throw new Error(`etf_krx_daily 읽기 실패: ${error.message}`);
    for (const r of data ?? []) rows.push({ d: r.bas_dd as string, code: r.isu_cd as string, nm: (r.isu_nm as string) ?? "", px: Number(r.tdd_clsprc), tv: Number(r.acc_trdval), idxNm: (r.idx_ind_nm as string) ?? "" });
    dbRead += data?.length ?? 0;
    if (!data || data.length < SECTOR_MOM_READ_PAGE) break;
  }
  const cal = rows.filter((r) => r.code === SECTOR_MOM_BASE_CODE).map((r) => r.d).sort();
  const N = cal.length;
  const kOf = new Map(cal.map((d, i) => [d, i]));
  console.log(`읽은 행 ${rows.length}, 코드 ${new Set(rows.map((r) => r.code)).size}개, 달력 ${N}일 ${cal[0]}~${cal[N - 1]}`);

  // ---- 코드별 배열 ----
  interface Series { px: Float64Array; fpx: Float64Array; tv: Float64Array; sector: (string | null)[]; name: string[]; present: Int32Array; tvPre: Float64Array; last: number }
  const S = new Map<string, Series>();
  const sectorOf = (nm: string, idxNm: string): string | null => {
    const text = `${nm} ${idxNm}`;
    const hit = KRX_SECTOR_KEYWORDS.find((k) => k.re.test(text));
    if (!hit) return null;
    if (KRX_SECTOR_EXCLUDE.some((e) => e.re.test(text))) return null;
    if (KRX_SECTOR_FOREIGN_RE.test(text) && !KRX_SECTOR_DOMESTIC_RE.test(text)) return null;
    return hit.sector;
  };
  for (const r of rows) {
    const k = kOf.get(r.d);
    if (k === undefined) continue;
    let s = S.get(r.code);
    if (!s) { s = { px: new Float64Array(N).fill(NaN), fpx: new Float64Array(N).fill(NaN), tv: new Float64Array(N), sector: new Array<string | null>(N).fill(null), name: new Array<string>(N).fill(""), present: new Int32Array(N + 1), tvPre: new Float64Array(N + 1), last: -1 }; S.set(r.code, s); }
    if (r.px > 0) { s.px[k] = r.px; s.tv[k] = Number.isFinite(r.tv) ? r.tv : 0; s.name[k] = r.nm; s.sector[k] = sectorOf(r.nm, r.idxNm); if (k > s.last) s.last = k; }
  }
  for (const s of S.values()) {
    let prev = NaN;
    for (let k = 0; k < N; k++) { if (s.px[k] > 0) prev = s.px[k]; s.fpx[k] = prev; s.present[k + 1] = s.present[k] + (s.px[k] > 0 ? 1 : 0); s.tvPre[k + 1] = s.tvPre[k] + s.tv[k]; }
  }
  const base = S.get(SECTOR_MOM_BASE_CODE)!, safe = S.get(SECTOR_MOM_SAFE_CODE);
  if (!safe) throw new Error("114260 데이터 없음");

  // ---- 월말·대표 ----
  const meK: number[] = [];
  for (let k = 0; k + 1 < N; k++) if (cal[k].slice(0, 7) !== cal[k + 1].slice(0, 7)) meK.push(k);
  const H = SECTOR_MOM_HISTORY_DAYS;
  const repsAt = new Map<number, Rep[]>();
  for (const k of meK) {
    if (k < H) continue;
    const bySector = new Map<string, Rep>();
    for (const [code, s] of S) {
      const sec = s.sector[k];
      if (!sec || !(s.px[k] > 0)) continue;
      if (s.present[k + 1] - s.present[k - H] !== H + 1) continue;
      const tv20 = (s.tvPre[k + 1] - s.tvPre[k + 1 - SECTOR_MOM_TV_SHORT_DAYS]) / SECTOR_MOM_TV_SHORT_DAYS;
      if (!(tv20 >= SECTOR_MOM_MIN_AVG_TV_WON)) continue;
      const tv60 = (s.tvPre[k + 1] - s.tvPre[k + 1 - SECTOR_MOM_TV_LONG_DAYS]) / SECTOR_MOM_TV_LONG_DAYS;
      const cur = bySector.get(sec);
      if (!cur || tv60 > cur.tv60 || (tv60 === cur.tv60 && code < cur.code)) bySector.set(sec, { code, sector: sec, r121: s.px[k - SECTOR_MOM_SKIP_DAYS] / s.px[k - H] - 1, r6: s.px[k] / s.px[k - SECTOR_MOM_R6_DAYS] - 1, tv60 });
    }
    repsAt.set(k, [...bySector.values()]);
  }
  const decisionKs = meK.filter((k) => repsAt.has(k));
  if (!decisionKs.length) throw new Error("결정일 없음");
  const startK = decisionKs[0];
  console.log(`첫 결정일 ${cal[startK]}, 결정일 ${decisionKs.length}개, 마지막 달력일 ${cal[N - 1]}`);

  // ---- (b) 대표 통계 ----
  console.log("\n=== (b) 연도별 월평균 업종 대표 수 ===\n| 연도 | 결정 월수 | 월평균 대표 수 |\n|---|---|---|");
  const byYear = new Map<string, number[]>();
  for (const k of decisionKs) { const y = cal[k].slice(0, 4); if (!byYear.has(y)) byYear.set(y, []); byYear.get(y)!.push(repsAt.get(k)!.length); }
  for (const [y, a] of byYear) console.log(`| ${y} | ${a.length} | ${f2(a.reduce((x, z) => x + z, 0) / a.length)} |`);
  const repMonths = new Map<string, { n: number; name: string; sector: string }>();
  for (const k of decisionKs) for (const r of repsAt.get(k)!) { const e = repMonths.get(r.code) ?? { n: 0, name: "", sector: r.sector }; e.n++; e.name = S.get(r.code)!.name[k]; e.sector = r.sector; repMonths.set(r.code, e); }
  console.log(`\n대표로 쓰인 ETF ${repMonths.size}개 (사용 개월 수 큰 순)\n| 코드 | 종목명(마지막 대표일) | 업종 | 대표 개월 수 |\n|---|---|---|---|`);
  for (const [code, e] of [...repMonths.entries()].sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1))) console.log(`| ${code} | ${e.name} | ${e.sector} | ${e.n} |`);

  // ---- 목표 비중 ----
  function target(v: VarId, k: number): { w: Map<string, number>; sectors: string[] } {
    const reps = repsAt.get(k)!;
    const add = (m: Map<string, number>, c: string, x: number): void => { m.set(c, (m.get(c) ?? 0) + x); };
    const w = new Map<string, number>();
    if (v === "SEW") {
      if (!reps.length) { w.set(SECTOR_MOM_BASE_CODE, 1); return { w, sectors: [] }; }
      for (const r of reps) add(w, r.code, 1 / reps.length);
      return { w, sectors: reps.map((r) => r.sector) };
    }
    const key = (r: Rep): number => (v === "S2" ? r.r6 : r.r121);
    const top = [...reps].sort((a, b) => key(b) - key(a) || (a.code < b.code ? -1 : 1)).slice(0, SECTOR_MOM_TOP_N);
    const sectors: string[] = [];
    const rSafe = safe!.px[k - SECTOR_MOM_SKIP_DAYS] / safe!.px[k - H] - 1;
    for (let i = 0; i < SECTOR_MOM_TOP_N; i++) {
      const r = top[i];
      if (!r) { add(w, SECTOR_MOM_BASE_CODE, 1 / SECTOR_MOM_TOP_N); sectors.push("069500(채움)"); continue; }
      if (v === "S3" && r.r121 < rSafe) { add(w, SECTOR_MOM_SAFE_CODE, 1 / SECTOR_MOM_TOP_N); sectors.push("114260(자리)"); continue; }
      add(w, r.code, 1 / SECTOR_MOM_TOP_N); sectors.push(r.sector);
    }
    return { w, sectors };
  }

  // ---- 엔진 ----
  function simulate(v: VarId, delay: boolean): Run {
    const dates: string[] = [], ret: number[] = [], costFrac: number[] = [], turn: number[] = [];
    const decisions: Decision[] = [];
    const hold = new Map<string, number>();
    let cash = 1, prevV = 1, delist = 0;
    let pending: Map<string, number> | null = null;
    const decSet = new Set(decisionKs);
    for (let k = startK; k < N; k++) {
      let cf = 0, tu = 0;
      if (k > startK) for (const [c, val] of hold) { const s = S.get(c)!; const a = s.fpx[k - 1], b = s.fpx[k]; if (a > 0 && b > 0) hold.set(c, val * (b / a)); }
      // 상장폐지 전환
      for (const [c, val] of [...hold]) {
        const s = S.get(c)!;
        if (c !== SECTOR_MOM_BASE_CODE && s.last <= k && s.last < N - 1) {
          const V = cash + [...hold.values()].reduce((x, y) => x + y, 0);
          const C = val * COST * 2;
          hold.delete(c); hold.set(SECTOR_MOM_BASE_CODE, (hold.get(SECTOR_MOM_BASE_CODE) ?? 0) + val - C);
          cf += C / V; tu += val / V; delist++;
        }
      }
      const execute = (w: Map<string, number>): void => {
        const V = cash + [...hold.values()].reduce((x, y) => x + y, 0);
        const codes = new Set([...hold.keys(), ...w.keys()]);
        let buyN = 0, sellN = 0;
        for (const c of codes) { const diff = (w.get(c) ?? 0) * V - (hold.get(c) ?? 0); if (diff > 0) buyN += diff; else sellN += -diff; }
        const C = (buyN + sellN) * COST, scale = (V - C) / V;
        hold.clear();
        for (const [c, x] of w) hold.set(c, x * V * scale);
        cash = V - C - [...hold.values()].reduce((x, y) => x + y, 0);
        cf += C / V; tu += (buyN + sellN) / 2 / V;
      };
      if (delay && pending) { execute(pending); pending = null; }
      if (decSet.has(k)) {
        const t = target(v, k);
        decisions.push({ k, date: cal[k], w: t.w, sectors: t.sectors, repCount: repsAt.get(k)!.length });
        if (delay) pending = t.w; else execute(t.w);
      }
      const V = cash + [...hold.values()].reduce((x, y) => x + y, 0);
      dates.push(cal[k]); ret.push((V / prevV - 1) * 100); costFrac.push(cf); turn.push(tu);
      prevV = V;
    }
    return { dates, ret, costFrac, turn, delist, decisions };
  }

  // ---- 지표 ----
  const lastDate = cal[N - 1];
  const yearsOf = (w: Win): number => Math.max((Date.parse(w.to) - Date.parse(w.from)) / MS_DAY / 365.25, 1e-9);
  const inWin = (d: string, w: Win): boolean => (w.excl ? d > w.from : d >= w.from) && d <= w.to;
  function st(dates: string[], rets: number[], win: Win, costFrac?: number[], turn?: number[]): Stats {
    const idx: number[] = [];
    for (let i = 0; i < dates.length; i++) if (inWin(dates[i], win)) idx.push(i);
    const r = idx.map((i) => rets[i]);
    const { totalReturnPct, mddPct } = computeCumulativeAndMdd(r);
    const cagr = computeCagrPct(totalReturnPct, win.from, win.to);
    const m = r.reduce((a, x) => a + x, 0) / Math.max(r.length, 1);
    const sd = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(r.length - 1, 1));
    return { cagr, mdd: mddPct, cm: mddPct > 0 ? cagr / mddPct : NaN, vol: sd * Math.sqrt(SECTOR_MOM_TRADING_DAYS_PER_YEAR), cost: costFrac ? idx.reduce((a, i) => a + costFrac[i], 0) * 100 : NaN, turn: turn ? idx.reduce((a, i) => a + turn[i], 0) / yearsOf(win) : NaN };
  }
  const yearRet = (run: { dates: string[]; ret: number[] }, y: number, win: Win): number =>
    computeCumulativeAndMdd(run.ret.filter((_, i) => run.dates[i].startsWith(`${y}-`) && inWin(run.dates[i], win))).totalReturnPct;

  const bh: Run = { dates: cal.slice(startK), ret: cal.slice(startK).map((_, i) => (i === 0 ? 0 : (base.fpx[startK + i] / base.fpx[startK + i - 1] - 1) * 100)), costFrac: cal.slice(startK).map(() => 0), turn: cal.slice(startK).map(() => 0), delist: 0, decisions: [] };
  const sims = new Map<VarId, { base: Run; delayed?: Run }>();
  for (const v of ["S1", "S2", "S3"] as VarId[]) sims.set(v, { base: simulate(v, false), delayed: simulate(v, true) });
  sims.set("SEW", { base: simulate("SEW", false) });
  console.log(`\n상장폐지 전환 건수(무지연 실행): ${(["S1", "S2", "S3", "SEW"] as VarId[]).map((v) => `${v}=${sims.get(v)!.base.delist}`).join(" ")}`);

  const learn: Win = { from: cal[startK], to: SECTOR_MOM_LEARN.to, excl: true };
  const HEAD = "| 구분 | CAGR | MDD | CAGR÷MDD | 연변동성 | 연 회전율 | 누적 비용 % | 지연 CAGR | 하락 %p | G1 | G2 | G3 | G4 | G5 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const gatesOf = (x: Stats, b: Stats, sew: Stats, drop: number): boolean[] => [x.cagr > b.cagr, x.cagr > sew.cagr, x.mdd <= b.mdd + SECTOR_MOM_G3_MDD_MARGIN_PP, x.cm > b.cm, drop <= SECTOR_MOM_G5_MAX_DELAY_DROP_PP];
  const refLine = (name: string, s: Stats): string => `| ${name} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.cm)} | ${f2(s.vol)} | ${f2(s.turn)} | ${f2(s.cost)} | | | | | | | |`;
  const table = (win: Win, vars: VarId[]): { id: VarId; s: Stats; g: boolean[] }[] => {
    const b = st(bh.dates, bh.ret, win, bh.costFrac, bh.turn);
    const sewR = sims.get("SEW")!.base;
    const sew = st(sewR.dates, sewR.ret, win, sewR.costFrac, sewR.turn);
    console.log(HEAD);
    const out = vars.map((id) => {
      const { base: r0, delayed: r1 } = sims.get(id)!;
      const s = st(r0.dates, r0.ret, win, r0.costFrac, r0.turn), sd = st(r1!.dates, r1!.ret, win, r1!.costFrac, r1!.turn);
      const drop = s.cagr - sd.cagr, g = gatesOf(s, b, sew, drop);
      console.log(`| ${id} | ${f2(s.cagr)} | ${f2(s.mdd)} | ${f2(s.cm)} | ${f2(s.vol)} | ${f2(s.turn)} | ${f2(s.cost)} | ${f2(sd.cagr)} | ${f2(drop)} | ${g.map(ox).join(" | ")} |`);
      return { id, s, g };
    });
    console.log(refLine("B&H(069500)", b)); console.log(refLine("SEW", sew));
    return out;
  };

  console.log(`\n=== (c) 학습 ${cal[startK]}(첫 결정일, 다음 거래일부터)~${learn.to} ===`);
  const L = table(learn, ["S1", "S2", "S3"]);
  const passers = L.filter((x) => x.g.every(Boolean));
  console.log("\n=== (d) 선택 ===");
  if (!passers.length) { console.log("선택 없음"); return finish(); }
  passers.sort((a, b) => b.s.cm - a.s.cm || a.s.turn - b.s.turn);
  const sel = passers[0].id;
  console.log(`전부 O 변형: ${passers.map((p) => p.id).join(", ")} → 선택 ${sel}`);
  const run = sims.get(sel)!.base;
  const sewRun = sims.get("SEW")!.base;

  const stage = (label: string, win: Win): boolean => {
    console.log(`\n=== ${label} ${win.from}~${win.to} ===`);
    const R = table(win, [sel]);
    console.log(`연도별 수익률 %\n| 연도 | ${sel} | B&H | SEW |\n|---|---|---|---|`);
    for (let y = Number(win.from.slice(0, 4)); y <= Number(win.to.slice(0, 4)); y++) console.log(`| ${y} | ${f2(yearRet(run, y, win))} | ${f2(yearRet(bh, y, win))} | ${f2(yearRet(sewRun, y, win))} |`);
    return R[0].g.every(Boolean);
  };
  const confirmOk = stage("(e) 확인", { ...SECTOR_MOM_CONFIRM });
  let holdOk: boolean | null = null;
  if (!confirmOk) console.log("\n확인 결과: 통과 아님 (홀드아웃 계산하지 않음)");
  else { holdOk = stage("(f) 홀드아웃", { from: SECTOR_MOM_HOLDOUT_FROM, to: lastDate }); console.log(`\n최종: ${holdOk ? "통과" : "통과 아님"}`); }

  // (g)
  const cnt = new Map<string, number>();
  for (const d of run.decisions) for (const sct of new Set(d.sectors)) cnt.set(sct, (cnt.get(sct) ?? 0) + 1);
  console.log(`\n=== (g) ${sel}가 담은 업종 상위 5 (결정 ${run.decisions.length}개월 중 개월 수, 무지연 실행 전체 구간) ===\n| 업종 | 개월 |\n|---|---|`);
  for (const [sct, n] of [...cnt.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5)) console.log(`| ${sct} | ${n} |`);
  finish();
}

function finish(): void {
  console.log(`\n(h) KRX 요청 0 | Supabase 읽은 행 ${dbRead} 쓴 행 0 | DART·KIS 0 | 소요 ${((Date.now() - T0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error("실패:", e instanceof Error ? e.message : e); process.exit(1); });

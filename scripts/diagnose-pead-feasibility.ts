/**
 * [임시 연구 — 병합 금지] 연구 PEAD 1단계: 가능성 점검(시험 아님, 시도 번호 소진 없음, 읽기 전용, 가격 성과 계산 없음, 외부 요청 0건).
 * 연구 R이 Storage(research/r_allcap)에 모아 둔 fin.parquet·filings.parquet(DART 다중 계정·정기공시 목록)를 읽어 (a) 공시일·정정·시각 정보 (b) K200P·SMALL의 연도별 커버리지(70·60·50%)
 * (c) 2단계 정의로 나오는 이벤트·진입 가능 건수(G 100건 판단용)를 센다. 가격 Parquet은 고정 스냅샷(캐시)만 읽고 다운로드 0. DB·Storage 쓰기 0.
 */
import { downloadBuf, decodeTable } from "@/lib/nBookStore";
import { eventsByCorpPit, eventsByCorp, type FinRow, type FilingRow, type FinEvent } from "@/lib/rFinMetrics";
import { R_STORE_PREFIX, R_STALE_DAYS, R_SMALL_MCAP_MIN_EOK, R_SMALL_MCAP_MAX_EOK, R_SMALL_TV_MIN_WON, R_SMALL_PRICE_MIN_WON } from "@/lib/kodexSectorSatConfig";
import { PEAD_COVERAGE_LEVELS, PEAD_CANDS, PEAD_MAX_POS, PEAD_COOLDOWN_DAYS, PEAD_COUNT_GROWTHS, PEAD_EVAL_FROM } from "@/lib/peadConfig";
import { PIT_MIN_AVG_TRADING_VALUE_WON } from "@/lib/strategyBacktestSummaryConfig";
import { loadHarness, loadK200P, verifySnapshotManifest, dbRead, storageLine, xfer, SNAP_END, f2, type S } from "./researchHarness";

const T0 = Date.now();
type UKind = "K200P" | "SMALL";
const UK: UKind[] = ["K200P", "SMALL"];

async function main(): Promise<void> {
  console.log(`연구 PEAD 1단계 가능성 점검 시작(시험 아님, 읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, kAt } = await loadK200P(h);
  const cS = CAL.findIndex((d) => d >= PEAD_EVAL_FROM);
  const lowerBound = (d: string): number => { let lo = 0, hi = nCal; while (lo < hi) { const m = (lo + hi) >> 1; if (CAL[m] < d) lo = m + 1; else hi = m; } return lo; };

  // ---- (a) 자료 읽기 ----
  const tab = async (name: string): Promise<{ rows: Record<string, string | number | null>[]; bytes: number }> => {
    const b = await downloadBuf(`${R_STORE_PREFIX}/${name}`);
    if (!b) throw new Error(`${R_STORE_PREFIX}/${name} 없음`);
    xfer.bytes += b.byteLength;
    return { rows: (await decodeTable(b)) as Record<string, string | number | null>[], bytes: b.byteLength };
  };
  const fin = await tab("fin.parquet"), fil = await tab("filings.parquet");
  const finRows = fin.rows as unknown as FinRow[], filRows = fil.rows as unknown as FilingRow[];
  console.log(`\n=== (a) 자료 구조 ===\nStorage ${R_STORE_PREFIX}/fin.parquet ${fin.rows.length}행 ${(fin.bytes / 1048576).toFixed(2)} MiB | filings.parquet ${fil.rows.length}행 ${(fil.bytes / 1048576).toFixed(2)} MiB`);
  console.log(`fin 열: ${Object.keys(fin.rows[0]).join(", ")}`);
  console.log(`filings 열: ${Object.keys(fil.rows[0]).join(", ")}`);
  const cnt = <T,>(a: T[], f: (x: T) => string): Map<string, number> => { const m = new Map<string, number>(); for (const x of a) m.set(f(x), (m.get(f(x)) ?? 0) + 1); return m; };
  const fmtMap = (m: Map<string, number>, n = 12): string => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(" | ");
  console.log(`fin 상태(status): ${fmtMap(cnt(finRows, (r) => r.status))} | reprt_code: ${fmtMap(cnt(finRows, (r) => r.reprt_code))} | fs_div: ${fmtMap(cnt(finRows, (r) => r.fs_div))}`);
  console.log(`fin 사업연도 범위: ${[...cnt(finRows, (r) => r.bsns_year).keys()].sort().join(", ")}`);
  const rd = finRows.map((r) => r.rcept_dt).filter(Boolean).sort();
  console.log(`fin rcept_dt 범위 ${rd[0]}~${rd[rd.length - 1]}, 값 있는 행 ${rd.length}/${finRows.length} | rcept_dt 형식 예: ${rd[0]} (날짜만, 시각 열 없음)`);
  console.log(`filings 정정 여부(correction): ${fmtMap(cnt(filRows, (r) => r.correction))} | 접수일 범위 ${[...filRows.map((r) => r.rcept_dt)].sort()[0]}~${[...filRows.map((r) => r.rcept_dt)].sort().slice(-1)[0]}`);
  console.log(`filings 보고서명 유형(숫자·괄호 제거 상위): ${fmtMap(cnt(filRows, (r) => String(r.report_nm ?? "").replace(/\[[^\]]*\]/g, "").replace(/\(.*?\)/g, "").replace(/\s+/g, "")), 8)}`);
  console.log(`fin 값 열 결측률 %: ${["oi_c", "oi_p", "oi_a", "oi_pa"].map((c) => `${c} ${f2((finRows.filter((r) => (r as unknown as Record<string, unknown>)[c] === null).length / finRows.length) * 100)}`).join(", ")} (전체 행 기준, 상태 orig·corr 포함)`);
  const stockOfCorp = new Map<string, string>();
  for (const r of finRows) if (r.stock_code) stockOfCorp.set(r.corp_code, r.stock_code);

  // (a-2) 보고서(사업연도·종류)별 값 채움 — 영업이익 당기/전기 열이 언제부터 있는지
  console.log(`\n(a-2) 상태 orig 행의 사업연도 × 보고서 종류별 영업이익 값 채움 % (11013 1분기, 11012 반기, 11014 3분기, 11012·11014는 당분기 oi_c/oi_p 기준)`);
  console.log(`| 사업연도 | 종류 | orig 행 | 접수일 범위 | oi_c 있음 % | oi_p 있음 % | oi_a 있음 % | oi_pa 있음 % |\n|---|---|---|---|---|---|---|---|`);
  const grp = new Map<string, FinRow[]>();
  for (const r of finRows) if (r.status === "orig") { const k = `${r.bsns_year}|${r.reprt_code}`; const l = grp.get(k) ?? []; l.push(r); grp.set(k, l); }
  const pc = (l: FinRow[], c: keyof FinRow): string => f2((l.filter((r) => r[c] !== null && r[c] !== undefined).length / l.length) * 100);
  for (const k of [...grp.keys()].sort()) { const l = grp.get(k)!, [y, rc] = k.split("|"); if (Number(y) > 2017) continue; const ds = l.map((r) => r.rcept_dt).sort(); console.log(`| ${y} | ${rc} | ${l.length} | ${ds[0]}~${ds[ds.length - 1]} | ${pc(l, "oi_c")} | ${pc(l, "oi_p")} | ${pc(l, "oi_a")} | ${pc(l, "oi_pa")} |`); }

  // 정정 처리: 원본 이벤트(정정 전 접수일 기준) vs 정정 점 시점 이벤트
  const evOrig = eventsByCorp(finRows, filRows);
  const pit = eventsByCorpPit(finRows, filRows);
  const nOrigEv = [...evOrig.values()].reduce((a, l) => a + l.length, 0), nOrigQ = [...evOrig.values()].reduce((a, l) => a + l.filter((e) => e.qOi !== null && e.qOiPrev !== null).length, 0);
  console.log(`이벤트(원본 접수일 기준, 정정 제외): ${nOrigEv}건 중 분기 영업이익·전년 동기 값 모두 있는 것 ${nOrigQ}건 | 정정 점 시점 재계산 이벤트 ${pit.added}건 추가(상태 corr 행 ${pit.corrRows}개)`);
  const nonCorr = filRows.filter((r) => r.correction === "N");
  const withVal = new Set([...evOrig.values()].flat().filter((e) => e.qOi !== null || e.ttmOi !== null || e.eq !== null).map((e) => e.rceptNo));
  console.log(`정기공시 비정정 접수 ${nonCorr.length}건 중 값이 하나라도 있는 이벤트로 남은 것 ${nonCorr.filter((r) => withVal.has(String(r.rcept_no))).length}건 — 나머지는 "자료 없음"(정정으로 값이 대체되어 정정 전 원본 값이 보관돼 있지 않음 등)`);

  // ---- 유니버스 ----
  const smallCache = new Map<string, S[]>();
  const smallAt = (d: string): S[] => {
    let v = smallCache.get(d);
    if (!v) {
      const m = membAt(d), e: { s: S; mc: number }[] = [];
      if (m) for (const s of h.stocks) {
        const i = s.idx.get(d);
        if (i === undefined || excluded.has(s.code) || m.get(s.code) !== "KOSPI") continue;
        const mc = s.mcapRow[i];
        if (mc >= R_SMALL_MCAP_MIN_EOK && mc < R_SMALL_MCAP_MAX_EOK && s.avgTvRow[i] >= R_SMALL_TV_MIN_WON && s.raw[i] >= R_SMALL_PRICE_MIN_WON) e.push({ s, mc });
      }
      e.sort((a, b) => b.mc - a.mc || (a.s.code < b.s.code ? -1 : 1));
      v = e.map((x) => x.s);
      smallCache.set(d, v);
    }
    return v;
  };
  const uAt = (k: UKind, d: string): S[] => (k === "K200P" ? kAt(d) : smallAt(d));
  void PIT_MIN_AVG_TRADING_VALUE_WON;

  // ---- 판단일 c에서 쓸 수 있는 직전 보고서(연구 R의 finAt과 같다: 접수일 순번 < c, 200일 초과면 없음) ----
  const seOf = new Map<string, { eff: Int32Array; ev: FinEvent[] }>();
  for (const [corp, evs] of pit.events) { const code = stockOfCorp.get(corp); if (code) seOf.set(code, { eff: Int32Array.from(evs.map((e) => lowerBound(e.rceptDt))), ev: evs }); }
  const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / 86_400_000;
  const finAt = (code: string, c: number): FinEvent | null => {
    const se = seOf.get(code);
    if (!se) return null;
    let lo = 0, hi = se.eff.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (se.eff[m] < c) { k = m; lo = m + 1; } else hi = m - 1; }
    if (k < 0) return null;
    const ev = se.ev[k];
    return dayDiff(ev.baseDt ?? ev.rceptDt, CAL[c]) > R_STALE_DAYS ? null : ev;
  };
  const hasQ = (ev: FinEvent | null): boolean => ev !== null && ev.qOi !== null && ev.qOiPrev !== null;

  // ---- (b) 연도별 커버리지 ----
  interface Cov { days: number; n: number; cap: number; capQ: number; nQ: number; nAny: number }
  const cov = new Map<UKind, Map<string, Cov>>();
  for (const k of UK) {
    const m = new Map<string, Cov>();
    for (let c = cS; c < nCal - 1; c++) {
      const d = CAL[c], U = uAt(k, d), y = d.slice(0, 4);
      const z = m.get(y) ?? { days: 0, n: 0, cap: 0, capQ: 0, nQ: 0, nAny: 0 };
      let cap = 0, capQ = 0, nQ = 0, nAny = 0;
      for (const s of U) {
        const mc = s.mcapRow[s.idx.get(d)!];
        cap += mc;
        const ev = finAt(s.code, c);
        if (ev !== null) nAny++;
        if (hasQ(ev)) { capQ += mc; nQ++; }
      }
      z.days++; z.n += U.length; z.cap += cap; z.capQ += cap > 0 ? capQ / cap : 0; z.nQ += U.length ? nQ / U.length : 0; z.nAny += U.length ? nAny / U.length : 0;
      m.set(y, z);
    }
    cov.set(k, m);
  }
  const years = [...cov.get("K200P")!.keys()].sort();
  console.log(`\n=== (b-1) 연도별 커버리지: 판단일마다 유니버스 시총 중 "직전 보고서(접수 후 ${R_STALE_DAYS}일 이내, 정정 점 시점 규칙)에 분기 영업이익·전년 동기 값이 모두 있는" 비중의 연도 평균 % (연구 R 재무 커버리지와 같은 방식) ===`);
  console.log(`기준 ${PEAD_COVERAGE_LEVELS.join("·")}% 각각 충족 여부 O/X (결과를 본 뒤 기준을 바꾸지 않고 세 단계 모두 보고)\n| 연도 | 판단일 수 | K200P 평균 종목 수 | K200P 시총 커버리지 % | ${PEAD_COVERAGE_LEVELS.map((l) => `≥${l}`).join(" | ")} | K200P 종목 수 커버리지 % | 직전 보고서 있음 % (종목) | SMALL 평균 종목 수 | SMALL 시총 커버리지 % | ${PEAD_COVERAGE_LEVELS.map((l) => `≥${l}`).join(" | ")} | SMALL 종목 수 커버리지 % | 직전 보고서 있음 % (종목) |\n|---|---|---|---|${PEAD_COVERAGE_LEVELS.map(() => "---").join("|")}|---|---|---|---|${PEAD_COVERAGE_LEVELS.map(() => "---").join("|")}|---|---|`);
  const okYears = new Map<string, string[]>();
  for (const y of years) {
    const row: string[] = [y, String(cov.get("K200P")!.get(y)!.days)];
    for (const k of UK) {
      const z = cov.get(k)!.get(y)!, pct = (z.capQ / z.days) * 100;
      row.push(f2(z.n / z.days), f2(pct), ...PEAD_COVERAGE_LEVELS.map((l) => (pct >= l ? "O" : "X")), f2((z.nQ / z.days) * 100), f2((z.nAny / z.days) * 100));
      for (const l of PEAD_COVERAGE_LEVELS) if (pct >= l) { const key = `${k}|${l}`; okYears.set(key, [...(okYears.get(key) ?? []), y]); }
    }
    console.log(`| ${row.join(" | ")} |`);
  }
  console.log(`기준별 충족 연도 (전체 평가 구간 ${PEAD_EVAL_FROM}~, ${years.length}개 연도):`);
  for (const k of UK) for (const l of PEAD_COVERAGE_LEVELS) { const ys = okYears.get(`${k}|${l}`) ?? []; const miss = years.filter((y) => !ys.includes(y)); console.log(`  ${k} ≥${l}%: ${ys.length}/${years.length}개 연도 충족${miss.length ? ` | 미충족 연도 ${miss.join(", ")}` : ""}`); }

  // ---- (c) 이벤트 건수 (원본 접수 이벤트만; 정정 재계산 이벤트·정정 접수는 새 이벤트로 세지 않는다) ----
  interface Ev { code: string; rceptDt: string; sig: number; exec: number; qOi: number; qOiPrev: number; growth: number }
  const evs: Ev[] = [];
  let nNoSig = 0;
  for (const [corp, list] of evOrig) {
    const code = stockOfCorp.get(corp);
    const s = code ? byCode.get(code) : undefined;
    if (!s) continue;
    for (const e of list) {
      if (e.qOi === null || e.qOiPrev === null) continue;
      const sig = lowerBound(e.rceptDt) + (CAL[lowerBound(e.rceptDt)] === e.rceptDt ? 1 : 0); // 접수일 다음 거래일(접수일이 거래일이 아니면 그 뒤 첫 거래일)
      if (sig + 1 >= nCal) { nNoSig++; continue; }
      evs.push({ code: s.code, rceptDt: e.rceptDt, sig, exec: sig + 1, qOi: e.qOi, qOiPrev: e.qOiPrev, growth: e.qOiPrev > 0 ? e.qOi / e.qOiPrev - 1 : NaN });
    }
  }
  console.log(`\n=== (c) 이벤트 건수 (가격 성과 계산 없음) ===\n분기 영업이익·전년 동기 값이 있는 원본 접수 이벤트 ${evs.length}건 (신호일이 달력 끝을 넘어 제외 ${nNoSig}건). 신호 확정일 = 접수일 다음 거래일, 체결일 = 그다음 거래일.`);
  const yearOf = (c: number): string => CAL[c].slice(0, 4);
  const periodOf = (c: number): string => { const d = CAL[c]; return d <= "2016-12-31" ? "학습 2011~2016" : d <= "2021-12-31" ? "확인 2017~2021" : "보류 2022~"; };
  const inU = (k: UKind, e: Ev): boolean => uAt(k, CAL[e.sig]).some((s) => s.code === e.code);
  const evU = new Map<UKind, Ev[]>();
  for (const k of UK) evU.set(k, evs.filter((e) => e.sig >= cS && inU(k, e)));
  const evByYear = new Map<string, number>();
  for (const e of evs) { const k = e.rceptDt.slice(0, 4); evByYear.set(k, (evByYear.get(k) ?? 0) + 1); }
  console.log(`분기 영업이익·전년 동기 값이 있는 원본 접수 이벤트의 접수 연도별 건수(유니버스 무관): ${[...evByYear].sort().map(([y, n]) => `${y} ${n}`).join(" | ")}`);
  console.log(`(c-1) 유니버스 안 원본 접수 이벤트(분기 영업이익 전년 동기 비교 가능; 신호일 기준 ${PEAD_EVAL_FROM}~): ${UK.map((k) => `${k} ${evU.get(k)!.length}건`).join(" / ")}`);
  console.log(`| 연도 | ${UK.map((k) => `${k} 비교 가능 | ${k} 영업이익>0 ∧ 전년>0 | ${PEAD_COUNT_GROWTHS.map((g) => `${k} 증가율≥${g * 100}%`).join(" | ")}`).join(" | ")} |\n|---|${UK.map(() => ["---", "---", ...PEAD_COUNT_GROWTHS.map(() => "---")].join("|")).join("|")}|`);
  const pos = (e: Ev): boolean => e.qOi > 0 && e.qOiPrev > 0;
  for (const y of [...years, "합계"]) {
    const cells: string[] = [];
    for (const k of UK) {
      const l = evU.get(k)!.filter((e) => y === "합계" || yearOf(e.sig) === y);
      cells.push(String(l.length), String(l.filter(pos).length), ...PEAD_COUNT_GROWTHS.map((g) => String(l.filter((e) => pos(e) && e.growth >= g).length)));
    }
    console.log(`| ${y} | ${cells.join(" | ")} |`);
  }

  // ---- (c-2) 후보별 진입 가능 건수: 슬롯 점유만 시뮬레이션(가격 없이). 접수일 종가 대비 신호일 종가 수익률 > 0 필터는 두 가지로 센다(필터 전 = 상한, 필터 후 = 가격 방향만 사용, 진입 이후 가격·성과는 쓰지 않음). ----
  const closeAtOrBefore = (s: S, c: number): number => { for (let k = c; k >= Math.max(c - 5, 0); k--) { const i = s.idx.get(CAL[k]); if (i !== undefined) return s.close[i]; } return NaN; };
  const up = (e: Ev): boolean => { const s = byCode.get(e.code)!; const a = closeAtOrBefore(s, lowerBound(e.rceptDt)), b = closeAtOrBefore(s, e.sig); return b > a; };
  const hasPx = (e: Ev): boolean => byCode.get(e.code)!.idx.has(CAL[e.exec]);
  interface Variant { label: string; k: UKind; g: number; N: number }
  const variants: Variant[] = [];
  for (const [id, cd] of Object.entries(PEAD_CANDS)) {
    variants.push({ label: `${id}`, k: cd.universe, g: cd.growth, N: cd.hold });
    for (const dg of [-0.1, 0.1]) variants.push({ label: `${id} 이웃 증가율 ${Math.round((cd.growth + dg) * 100)}%`, k: cd.universe, g: cd.growth + dg, N: cd.hold });
    for (const dn of [-20, 20]) variants.push({ label: `${id} 이웃 N=${cd.hold + dn}`, k: cd.universe, g: cd.growth, N: cd.hold + dn });
  }
  const slotSim = (v: Variant, filter: boolean): { entries: Ev[]; occ: number[]; dropped: number; cands: number } => {
    const cand = evU.get(v.k)!.filter((e) => pos(e) && e.growth >= v.g - 1e-12 && hasPx(e) && (!filter || up(e)));
    const bySig = new Map<number, Ev[]>();
    for (const e of cand) { const l = bySig.get(e.sig) ?? []; l.push(e); bySig.set(e.sig, l); }
    const open: { code: string; exit: number }[] = [], lastExit = new Map<string, number>(), entries: Ev[] = [], occ: number[] = new Array(nCal).fill(0);
    let dropped = 0;
    for (let c = cS; c < nCal - 1; c++) {
      const l = bySig.get(c);
      if (l) {
        const exec = c + 1;
        for (let i = open.length - 1; i >= 0; i--) if (open[i].exit <= exec) { lastExit.set(open[i].code, open[i].exit); open.splice(i, 1); }
        const ok = l.filter((e) => !open.some((p) => p.code === e.code) && !(lastExit.has(e.code) && exec - (lastExit.get(e.code) as number) < PEAD_COOLDOWN_DAYS)).sort((a, b) => b.growth - a.growth || (a.code < b.code ? -1 : 1));
        const free = PEAD_MAX_POS - open.length;
        for (const e of ok.slice(0, Math.max(free, 0))) { open.push({ code: e.code, exit: Math.min(exec + v.N + 1, nCal - 1) }); entries.push(e); }
        dropped += Math.max(ok.length - Math.max(free, 0), 0);
      }
    }
    for (const e of entries) for (let t = e.exec; t <= Math.min(e.exec + v.N + 1, nCal - 1); t++) occ[t]++;
    return { entries, occ, dropped, cands: cand.length };
  };
  console.log(`\n(c-2) 후보별 진입 가능 건수 (증가율 기준·보유 N·동시 보유 최대 ${PEAD_MAX_POS}·재진입 금지 ${PEAD_COOLDOWN_DAYS}거래일·증가율 큰 순 선택을 반영한 슬롯 점유 모의; 가격 성과 없음. 체결일에 가격 행이 없는 이벤트는 제외. 필터 = "접수일 종가 대비 신호 확정일 종가 수익률 > 0")`);
  console.log(`| 후보 | 유니버스 | 증가율 | N | 필터 | 조건 충족 이벤트(후보 풀) | 슬롯 부족으로 못 산 이벤트 | 진입 건수 전체 | 학습 2011~2016 | 확인 2017~2021 | 보류 2022~ | G(≥100) | 평균 동시 보유(전체 날) | 보유 있는 날 비율 % | 슬롯 10개 다 찬 날 % |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const v of variants) for (const filter of [false, true]) {
    const r = slotSim(v, filter), by = (p: string): number => r.entries.filter((e) => periodOf(e.exec) === p).length;
    const days = nCal - 1 - cS, tot = r.occ.slice(cS, nCal - 1);
    console.log(`| ${v.label} | ${v.k} | ≥${f2(v.g * 100)}% | ${v.N} | ${filter ? "있음" : "없음(상한)"} | ${r.cands} | ${r.dropped} | ${r.entries.length} | ${by("학습 2011~2016")} | ${by("확인 2017~2021")} | ${by("보류 2022~")} | ${r.entries.length >= 100 ? "O" : "X"} | ${f2(tot.reduce((a, x) => a + x, 0) / days)} | ${f2((tot.filter((x) => x > 0).length / days) * 100)} | ${f2((tot.filter((x) => x >= PEAD_MAX_POS).length / days) * 100)} |`);
  }
  console.log(`\n(c-3) 후보 기준(필터 없음)의 연도별 진입 건수`);
  console.log(`| 후보 | ${years.join(" | ")} |\n|---|${years.map(() => "---").join("|")}|`);
  for (const id of Object.keys(PEAD_CANDS)) {
    const cd = PEAD_CANDS[id as keyof typeof PEAD_CANDS], r = slotSim({ label: id, k: cd.universe, g: cd.growth, N: cd.hold }, false);
    console.log(`| ${id} | ${years.map((y) => r.entries.filter((e) => yearOf(e.exec) === y).length).join(" | ")} |`);
  }
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")}`);
  console.log(`${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시도 번호 소진 없음`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

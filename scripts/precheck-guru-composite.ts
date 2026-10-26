/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 C(투자 대가 모델 종합 점수, 208~210) 사전 점검. 수익률·MDD·가격 수익은 계산하지 않는다(건수와 비율만).
 * 사전 등록: docs/research/guru-composite-prereg.md. 읽는 것: 가격 Parquet(Actions 캐시)·fin/filings Parquet(Storage)·월말 시장 목록·적용된 조정 이벤트·069500 가격(harness 적재용). DB·Storage 쓰기 0.
 */
import { downloadBuf, decodeTable, type Row } from "@/lib/nBookStore";
import type { FilingRow } from "@/lib/rFinMetrics";
import { guruEventsByCorp, GURU_ACCOUNT_LABELS, type GuruFinRow, type GuruEvent } from "@/lib/guruFinMetrics";
import { blockItems, rankComposite, type Block, type BlockItems } from "@/lib/guruScoring";
import { G_BLOCKS, G_SLOTS, G_KEEP_RANK, G_REENTRY_BAN_DAYS, G_TRIAL_NO } from "@/lib/guruCompositeConfig";
import { R_STORE_PREFIX, R_STALE_DAYS, R_SMALL_MCAP_MIN_EOK, R_SMALL_MCAP_MAX_EOK, R_SMALL_TV_MIN_WON, R_SMALL_PRICE_MIN_WON, R_COVERAGE_MIN_PCT, R_EVAL_START } from "@/lib/kodexSectorSatConfig";
import { loadHarness, loadK200P, dbRead, xfer, f2, avg, median, dayDiff, type S } from "./researchHarness";

const T0 = Date.now();
type CId = keyof typeof G_BLOCKS;
const CIDS = Object.keys(G_BLOCKS) as CId[];
const NEED: Record<Block, (keyof GuruEvent["has"])[]> = { V: ["ni", "eq"], Q: ["rev", "ni", "oi", "eq", "eqAvg", "liab", "ni8"], Gr: ["rev", "revPrev", "oi", "oiPrev"] };

async function main(): Promise<void> {
  console.log(`연구 C 사전 점검 시작(읽기 전용, 수익률 계산 없음): ${new Date().toISOString()}`);
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt } = await loadK200P(h);
  const cS = h.calIdx.get(R_EVAL_START);
  if (cS === undefined) throw new Error(`${R_EVAL_START}가 거래일 달력에 없음`);
  const tab = async (name: string): Promise<Row[]> => {
    const b = await downloadBuf(`${R_STORE_PREFIX}/${name}`);
    if (!b) throw new Error(`${R_STORE_PREFIX}/${name} 없음`);
    xfer.bytes += b.byteLength;
    console.log(`Storage 읽기 ${R_STORE_PREFIX}/${name}: ${(b.byteLength / 1048576).toFixed(2)} MiB`);
    return decodeTable(b);
  };
  const finRows = (await tab("fin.parquet")) as unknown as GuruFinRow[];
  const filRows = (await tab("filings.parquet")) as unknown as FilingRow[];
  console.log(`재무 자료: fin ${finRows.length}행, filings ${filRows.length}행`);
  const stockOfCorp = new Map<string, string>();
  for (const r of finRows) if (r.stock_code) stockOfCorp.set(r.corp_code, r.stock_code);
  const { events, added } = guruEventsByCorp(finRows, filRows);
  console.log(`회사 ${events.size}개, 정정 점 시점 재계산 이벤트 ${added}건 추가`);
  const lowerBound = (d: string): number => { let lo = 0, hi = nCal; while (lo < hi) { const m = (lo + hi) >> 1; if (CAL[m] < d) lo = m + 1; else hi = m; } return lo; };
  const seOf = new Map<string, { eff: Int32Array; ev: GuruEvent[] }>();
  for (const [corp, evs] of events) { const code = stockOfCorp.get(corp); if (code) seOf.set(code, { eff: Int32Array.from(evs.map((e) => lowerBound(e.rceptDt))), ev: evs }); }
  /** 판단일 c에서 쓸 수 있는 직전 보고서(접수일 순번 < c). 없거나 최초 접수일부터 200일을 넘으면 null(더 오래된 보고서로 대체하지 않음). */
  const finAt = (code: string, c: number): GuruEvent | null => {
    const se = seOf.get(code);
    if (!se) return null;
    let lo = 0, hi = se.eff.length - 1, k = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (se.eff[m] < c) { k = m; lo = m + 1; } else hi = m - 1; }
    if (k < 0) return null;
    const ev = se.ev[k];
    return dayDiff(ev.baseDt ?? ev.rceptDt, CAL[c]) > R_STALE_DAYS ? null : ev;
  };
  const smallAt = (d: string): S[] => {
    const m = membAt(d), e: S[] = [];
    if (!m) return e;
    for (const s of h.stocks) {
      const i = s.idx.get(d);
      if (i === undefined || excluded.has(s.code)) continue;
      const mk = m.get(s.code);
      if (mk !== "KOSPI" && mk !== "KOSDAQ") continue;
      const mc = s.mcapRow[i];
      if (mc >= R_SMALL_MCAP_MIN_EOK && mc < R_SMALL_MCAP_MAX_EOK && s.avgTvRow[i] >= R_SMALL_TV_MIN_WON && s.raw[i] >= R_SMALL_PRICE_MIN_WON) e.push(s);
    }
    return e;
  };

  // ---- 순위만으로 도는 슬롯 모의(가격·수익률 미사용): 진입 건수 추정 ----
  interface Pos { entryC: number; sched: boolean }
  const mkSim = () => ({ held: new Map<string, Pos>(), pendExit: new Map<number, Map<string, string>>(), pendEnt: new Map<number, { list: string[]; free: number }[]>(), reserved: 0, lastExit: new Map<string, number>(), entries: [] as number[], holds: [] as number[], exits: new Map<string, number>(), nHeld: [] as number[], few: 0, days: 0, candSum: 0 });
  const sims = new Map<CId, ReturnType<typeof mkSim>>(CIDS.map((id) => [id, mkSim()]));
  const step = (st: ReturnType<typeof mkSim>, c: number, order: string[], rankOf: Map<string, number>): void => {
    const d = CAL[c];
    const close = (code: string, reason: string): void => { const p = st.held.get(code)!; st.holds.push(c - p.entryC); st.held.delete(code); st.lastExit.set(code, c); st.exits.set(reason, (st.exits.get(reason) ?? 0) + 1); };
    for (const code of [...st.held.keys()]) { const s = byCode.get(code)!; if (s.last < d && s.last < h.endedBefore) close(code, "폐지"); }
    const ex = st.pendExit.get(c);
    if (ex) {
      st.pendExit.delete(c);
      for (const [code, reason] of ex) {
        if (!st.held.has(code)) continue;
        const s = byCode.get(code)!, i = s.idx.get(d);
        if (i === undefined || s.vol[i] === 0) { const nx = st.pendExit.get(c + 1) ?? new Map<string, string>(); nx.set(code, reason); st.pendExit.set(c + 1, nx); continue; }
        close(code, reason);
      }
    }
    const en = st.pendEnt.get(c);
    if (en) {
      st.pendEnt.delete(c);
      for (const { list, free } of en) {
        st.reserved -= free;
        let filled = 0;
        for (const code of list) {
          if (filled >= free) break;
          if (st.held.has(code)) continue;
          const s = byCode.get(code)!, i = s.idx.get(d);
          if (i === undefined || s.vol[i] === 0) continue;
          st.held.set(code, { entryC: c, sched: false });
          st.entries.push(c);
          filled++;
        }
      }
    }
    st.nHeld.push(st.held.size);
    st.days++; st.candSum += order.length; if (order.length < G_SLOTS) st.few++;
    if (c + 1 < nCal) {
      for (const [code, p] of st.held) {
        if (p.sched) continue;
        const r = rankOf.get(code);
        if (r === undefined || r > G_KEEP_RANK) { p.sched = true; const m = st.pendExit.get(c + 1) ?? new Map<string, string>(); m.set(code, r === undefined ? "후보 제외" : "순위 밖"); st.pendExit.set(c + 1, m); }
      }
      const free = G_SLOTS - st.held.size - st.reserved;
      if (free > 0) {
        const list: string[] = [];
        for (const code of order) {
          if (st.held.has(code)) continue;
          const le = st.lastExit.get(code);
          if (le !== undefined && c - le < G_REENTRY_BAN_DAYS) continue;
          list.push(code);
          if (list.length >= free + 30) break;
        }
        if (list.length) { const a = st.pendEnt.get(c + 1) ?? []; a.push({ list, free }); st.pendEnt.set(c + 1, a); st.reserved += free; }
      }
    }
  };

  // ---- 일별 루프: 커버리지·후보 수·순위 모의 ----
  interface Y { days: number; n: number; cap: Record<string, number>; any: number; cand: Record<CId, number>; blk: Record<Block, number> }
  const ykeys = ["any", ...GURU_ACCOUNT_LABELS.map(([k]) => k as string), "rawV", "rawQ", "rawG", "okV", "okQ", "okG"];
  const yr = new Map<string, Y>();
  for (let c = cS; c < nCal - 1; c++) {
    const d = CAL[c], U = smallAt(d), y = d.slice(0, 4);
    const z = yr.get(y) ?? { days: 0, n: 0, cap: Object.fromEntries(ykeys.map((k) => [k, 0])), any: 0, cand: { C1: 0, C2: 0, C3: 0 }, blk: { V: 0, Q: 0, Gr: 0 } };
    let capTot = 0;
    const acc: Record<string, number> = Object.fromEntries(ykeys.map((k) => [k, 0]));
    const entries: { code: string; items: BlockItems }[] = [];
    for (const s of U) {
      const mc = s.mcapRow[s.idx.get(d)!];
      capTot += mc;
      const ev = finAt(s.code, c);
      if (!ev) continue;
      acc.any += mc;
      for (const [k] of GURU_ACCOUNT_LABELS) if (ev.has[k]) acc[k] += mc;
      if (ev.v) acc.rawV += mc;
      if (ev.q) acc.rawQ += mc;
      if (ev.g) acc.rawG += mc;
      const items = blockItems(ev, mc * 1e8);
      if (items.V) { acc.okV += mc; z.blk.V++; }
      if (items.Q) { acc.okQ += mc; z.blk.Q++; }
      if (items.Gr) { acc.okG += mc; z.blk.Gr++; }
      entries.push({ code: s.code, items });
    }
    z.days++; z.n += U.length;
    if (capTot > 0) for (const k of ykeys) z.cap[k] += acc[k] / capTot;
    for (const id of CIDS) {
      const ranked = rankComposite(entries, G_BLOCKS[id]);
      z.cand[id] += ranked.length;
      step(sims.get(id)!, c, ranked.map((r) => r.code), new Map(ranked.map((r) => [r.code, r.rank])));
    }
    yr.set(y, z);
  }
  const years = [...yr.keys()].sort();
  const pct = (y: string, k: string): number => (yr.get(y)!.cap[k] / yr.get(y)!.days) * 100;

  console.log(`\n=== 1. 계정별 SMALL 재무 커버리지(시총 비율 %, 판단일 평균; ${R_EVAL_START}~, 신선도 ${R_STALE_DAYS}일, 정정 점 시점 규칙) ===\n| 계정(계산 가능 = 연결·별도 어느 쪽이든) | ${years.join(" | ")} | 최소 | ${R_COVERAGE_MIN_PCT}% 미달 해 |\n|---|${years.map(() => "---").join("|")}|---|---|`);
  console.log(`| 직전 보고서 있음(신선도 이내) | ${years.map((y) => f2(pct(y, "any"))).join(" | ")} | ${f2(Math.min(...years.map((y) => pct(y, "any"))))} | - |`);
  const bad = new Map<string, string[]>();
  for (const [k, label] of GURU_ACCOUNT_LABELS) {
    const v = years.map((y) => pct(y, k)), bl = years.filter((_, i) => v[i] < R_COVERAGE_MIN_PCT);
    bad.set(k, bl);
    console.log(`| ${label} | ${v.map(f2).join(" | ")} | ${f2(Math.min(...v))} | ${bl.length ? bl.join(", ") : "없음"} |`);
  }
  console.log(`\n=== 2. 점수 묶음별 SMALL 커버리지(시총 비율 %) — 원자료 완비(연결·별도 섞지 않음) / 점수 조건 충족(순이익>0·자본>0 등) ===\n| 묶음 | ${years.join(" | ")} |\n|---|${years.map(() => "---").join("|")}|`);
  for (const [lab, a, b] of [["V(순이익 TTM·자본)", "rawV", "okV"], ["Q(8개 항목 입력)", "rawQ", "okQ"], ["Gr(TTM 매출·영업이익과 1년 전)", "rawG", "okG"]] as const) console.log(`| ${lab} | ${years.map((y) => `${f2(pct(y, a))} / ${f2(pct(y, b))}`).join(" | ")} |`);

  const failBlocks = (Object.keys(NEED) as Block[]).filter((b) => NEED[b].some((k) => bad.get(k)!.length > 0));
  console.log(`\n=== 3. 실행 가능 판정(계정 커버리지가 평가 구간 모든 해 ≥ ${R_COVERAGE_MIN_PCT}%) ===`);
  for (const b of Object.keys(NEED) as Block[]) console.log(`점수 ${b}: ${failBlocks.includes(b) ? `실행 불가(${NEED[b].filter((k) => bad.get(k)!.length).map((k) => `${GURU_ACCOUNT_LABELS.find((x) => x[0] === k)![1]} 미달 해 ${bad.get(k)!.join(",")}`).join("; ")})` : "가능"}`);
  for (const id of CIDS) { const f = G_BLOCKS[id].filter((b) => failBlocks.includes(b)); console.log(`${id}(시험 ${G_TRIAL_NO[id]}) ${G_BLOCKS[id].join("·")}: ${f.length ? `실행 불가(${f.join(",")} 실행 불가) — 번호 미소진` : "실행 가능"}`);}

  console.log(`\n=== 4. 후보 종목 수(하루 평균, 점수 계산 가능한 SMALL 종목 수) ===\n| 연도 | 판단일 수 | SMALL 평균 종목 수 | V 가능 | Q 가능 | Gr 가능 | C1 후보 | C2 후보 | C3 후보 |\n|---|---|---|---|---|---|---|---|---|`);
  for (const y of years) { const z = yr.get(y)!; console.log(`| ${y} | ${z.days} | ${f2(z.n / z.days)} | ${f2(z.blk.V / z.days)} | ${f2(z.blk.Q / z.days)} | ${f2(z.blk.Gr / z.days)} | ${f2(z.cand.C1 / z.days)} | ${f2(z.cand.C2 / z.days)} | ${f2(z.cand.C3 / z.days)} |`); }
  const tot = [...yr.values()].reduce((a, z) => ({ days: a.days + z.days, n: a.n + z.n, c1: a.c1 + z.cand.C1, c2: a.c2 + z.cand.C2, c3: a.c3 + z.cand.C3 }), { days: 0, n: 0, c1: 0, c2: 0, c3: 0 });
  console.log(`| 전체 | ${tot.days} | ${f2(tot.n / tot.days)} | - | - | - | ${f2(tot.c1 / tot.days)} | ${f2(tot.c2 / tot.days)} | ${f2(tot.c3 / tot.days)} |`);

  console.log(`\n=== 5. 진입 기회 추정: 순위만으로 도는 슬롯 모의(보유 ${G_SLOTS}, 순위 ${G_KEEP_RANK}위 밖·후보 제외 시 매도, 재진입 ${G_REENTRY_BAN_DAYS}거래일 금지, 체결일 다음 거래일; 가격·수익률 미사용, 거래정지·가격 결측은 행 유무·거래량 0만 반영) ===\n| 후보 | 진입 건수(체결일 ${CAL[cS + 1]}~) | 게이트 G(≥100) 여유 | 청산 건수 | 청산 사유 | 보유일 중앙값 | 평균 보유 종목 수 | 후보 < ${G_SLOTS}개인 판단일 비율 % |\n|---|---|---|---|---|---|---|---|`);
  for (const id of CIDS) {
    const st = sims.get(id)!;
    console.log(`| ${id} | ${st.entries.length} | ${st.entries.length >= 100 ? "충족" : "미달"} | ${st.holds.length} | ${[...st.exits].map(([k, v]) => `${k} ${v}`).join(" / ")} | ${f2(median(st.holds))} | ${f2(avg(st.nHeld))} | ${f2((st.few / Math.max(st.days, 1)) * 100)} |`);
  }
  console.log(`연도별 진입 건수: ${CIDS.map((id) => `${id}: ${years.map((y) => `${y} ${sims.get(id)!.entries.filter((c) => CAL[c].startsWith(y)).length}`).join(" ")}`).join(" | ")}`);

  const dbTot = Object.values(dbRead).reduce((a, b) => a + b, 0);
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${dbTot}`);
  console.log(`Storage 내려받기 합계 ${(xfer.bytes / 1048576).toFixed(2)} MiB(가격 Parquet은 Actions 캐시로 읽어 0) | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

/**
 * [임시 연구 — 병합 금지, 읽기 전용, 외부 요청 0건] 연구 C(투자 대가 모델 숫자 규칙 종합 점수) 한 번의 실행: ①후보별 커버리지 ②진입 기회 상한(순위만) ③통과 후보만 시험.
 * 사전 등록: docs/research/guru-composite-prereg.md 14절(최종 정의). 시도 208(C2', 본 시험 70%) · 209 C1 · 210 C2 · 211 C3(탐색 60%). 불가 후보는 시험하지 않고 번호를 소진하지 않는다.
 * 가격 Parquet(Actions 캐시)·fin/filings Parquet(Storage, 한 번만 읽음)·월말 시장 목록·적용된 조정 이벤트·069500 가격만 읽는다. DB·Storage 쓰기 0. 환경 변수 CAND_ONLY는 크래시 복구 전용.
 */
import { downloadBuf, decodeTable, type Row } from "@/lib/nBookStore";
import type { FilingRow } from "@/lib/rFinMetrics";
import { guruEventsByCorp, type GuruFinRow, type GuruEvent, type GuruAnnualEvent } from "@/lib/guruFinMetrics";
import { blockItems, rankComposite, type Block, type BlockItems, type RankResult } from "@/lib/guruScoring";
import { G_CANDS, G_PRIOR_TESTS, G_SLOTS, G_SLOTS_NEIGHBORS, G_KEEP_RANK, G_KEEP_RANK_NEIGHBORS, G_REENTRY_BAN_DAYS, G_STALE_DAYS_ANNUAL, G_ALL_SLOTS } from "@/lib/guruCompositeConfig";
import { R_STORE_PREFIX, R_STALE_DAYS, R_SMALL_MCAP_MIN_EOK, R_SMALL_MCAP_MAX_EOK, R_SMALL_TV_MIN_WON, R_SMALL_PRICE_MIN_WON, R_SMALL_SLIPPAGE, R_EVAL_START, R_EVAL_FROM, R_SUBPERIODS } from "@/lib/kodexSectorSatConfig";
import { A_MIN_ENTRIES } from "@/lib/prefSpreadConfig";
import { simSlots, type SimCand, type SimPos, type SimRun } from "@/lib/slotSim";
import { loadHarness, loadK200P, dbRead, xfer, f2, median, dayDiff, type S, type Win } from "./researchHarness";
import { evaluate, seedReport, yearlyTable, summaryReport, type CandSpec, type Verdict, type Windows } from "./researchGates";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const T0 = Date.now();
type CId = keyof typeof G_CANDS;
const CIDS = Object.keys(G_CANDS) as CId[];
const TIER_NOTE: Record<"main" | "explore", string> = { main: "본 시험(70%)", explore: "탐색 등급: 후보 아님(60%, 통과해도 추가 독립 검증 대상)" };
interface Ctx extends RankResult { rank: Map<string, number>; cands: SimCand[]; candsByCode: SimCand[] }

async function main(): Promise<void> {
  console.log(`연구 C 실행 시작(읽기 전용): ${new Date().toISOString()}`);
  const only = new Set((process.env.CAND_ONLY || CIDS.join(",")).split(",").map((x) => x.trim()).filter(Boolean));
  const h = await loadHarness();
  const { CAL, nCal, byCode } = h;
  const { excluded, membAt, nameOf } = await loadK200P(h);
  const cS = h.calIdx.get(R_EVAL_START);
  if (cS === undefined) throw new Error(`${R_EVAL_START}가 거래일 달력에 없음`);
  if (CAL[cS + 1] !== R_EVAL_FROM) throw new Error(`수익률 집계 시작 ${CAL[cS + 1]} ≠ ${R_EVAL_FROM}`);

  // ---- 재무 자료(Storage에서 한 번만 읽음) ----
  const tab = async (name: string): Promise<Row[]> => {
    const b = await downloadBuf(`${R_STORE_PREFIX}/${name}`);
    if (!b) throw new Error(`${R_STORE_PREFIX}/${name} 없음`);
    xfer.bytes += b.byteLength;
    console.log(`Storage 읽기 ${R_STORE_PREFIX}/${name}: ${(b.byteLength / 1048576).toFixed(2)} MiB`);
    return decodeTable(b);
  };
  const finRows = (await tab("fin.parquet")) as unknown as GuruFinRow[];
  const filRows = (await tab("filings.parquet")) as unknown as FilingRow[];
  const stockOfCorp = new Map<string, string>();
  for (const r of finRows) if (r.stock_code) stockOfCorp.set(r.corp_code, r.stock_code);
  const { events, annual, added, addedAnnual } = guruEventsByCorp(finRows, filRows);
  console.log(`재무 자료: fin ${finRows.length}행, filings ${filRows.length}행 | 회사 ${events.size}개(분기 흐름)/${annual.size}개(사업보고서 흐름), 정정 점 시점 재계산 ${added}건/${addedAnnual}건`);
  const lowerBound = (d: string): number => { let lo = 0, hi = nCal; while (lo < hi) { const m = (lo + hi) >> 1; if (CAL[m] < d) lo = m + 1; else hi = m; } return lo; };
  type Ev = { rceptDt: string; baseDt?: string };
  const mkAt = <T extends Ev>(m: Map<string, T[]>, staleDays: number) => {
    const se = new Map<string, { eff: Int32Array; ev: T[] }>();
    for (const [corp, evs] of m) { const code = stockOfCorp.get(corp); if (code) se.set(code, { eff: Int32Array.from(evs.map((e) => lowerBound(e.rceptDt))), ev: evs }); }
    /** 판단일 c에서 쓸 수 있는 직전 보고서(접수일 순번 < c). 없거나 최초 접수일부터 staleDays를 넘으면 null(더 오래된 보고서로 대체하지 않음). */
    return (code: string, c: number): T | null => {
      const x = se.get(code);
      if (!x) return null;
      let lo = 0, hi = x.eff.length - 1, k = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (x.eff[mid] < c) { k = mid; lo = mid + 1; } else hi = mid - 1; }
      if (k < 0) return null;
      const ev = x.ev[k];
      return dayDiff(ev.baseDt ?? ev.rceptDt, CAL[c]) > staleDays ? null : ev;
    };
  };
  const finAtQ = mkAt<GuruEvent>(events, R_STALE_DAYS), finAtA = mkAt<GuruAnnualEvent>(annual, G_STALE_DAYS_ANNUAL);
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

  // ---- 일별 순위 문맥(후보별 캐시) ----
  const ctxCache = new Map<string, Ctx>();
  const blocksOf = (id: CId): readonly Block[] => G_CANDS[id].blocks;
  const entriesAt = (c: number): { code: string; items: BlockItems }[] => {
    const d = CAL[c];
    return smallAt(d).map((s) => ({ code: s.code, items: blockItems(finAtQ(s.code, c), finAtA(s.code, c), s.mcapRow[s.idx.get(d)!] * 1e8) }));
  };
  const buildCtx = (id: CId, c: number, entries: { code: string; items: BlockItems }[]): Ctx => {
    const rr = rankComposite(entries, blocksOf(id));
    const cands: SimCand[] = rr.ranked.map((r) => ({ s: byCode.get(r.code)!, code: r.code }));
    const ctx: Ctx = { ...rr, rank: new Map(rr.ranked.map((r) => [r.code, r.rank])), cands, candsByCode: [...cands].sort((a, b) => (a.code < b.code ? -1 : 1)) };
    ctxCache.set(`${id}|${c}`, ctx);
    return ctx;
  };
  const ctxOf = (id: CId, c: number): Ctx => ctxCache.get(`${id}|${c}`) ?? buildCtx(id, c, entriesAt(c));
  /** 보유 종목의 종합 순위: 후보 집합에 있으면 그 순위, 아니면(SMALL 이탈 등) 끼워 넣은 순위, 점수 계산 불가면 undefined. */
  const rankHeld = (id: CId, code: string, c: number): number | undefined => {
    const ctx = ctxOf(id, c), r = ctx.rank.get(code);
    if (r !== undefined) return r;
    const s = byCode.get(code)!, i = s.idx.get(CAL[c]);
    if (i === undefined) return undefined;
    return ctx.rankOutsider(blockItems(finAtQ(code, c), finAtA(code, c), s.mcapRow[i] * 1e8));
  };
  /** 재무 신선도 초과: 후보가 쓰는 재무 흐름 중 하나라도 한도 안의 보고서가 없다. */
  const staleOf = (id: CId, code: string, c: number): boolean => {
    const bl = blocksOf(id);
    return ((bl.includes("V") || bl.includes("Q") || bl.includes("Qp")) && finAtQ(code, c) === null) || (bl.includes("Gr") && finAtA(code, c) === null);
  };

  // ---- 1단계: 후보별 커버리지(필요한 모든 블록의 원자료가 동시에 있는 SMALL 시총 비율, 판단일 연평균) ----
  interface Y { days: number; n: number; cap: Record<CId, number>; ok: Record<CId, number>; cand: Record<CId, number> }
  const yr = new Map<string, Y>();
  const zero = (): Record<CId, number> => ({ "C2'": 0, C1: 0, C2: 0, C3: 0 });
  for (let c = cS; c < nCal - 1; c++) {
    const d = CAL[c], y = d.slice(0, 4), U = smallAt(d);
    const z = yr.get(y) ?? { days: 0, n: 0, cap: zero(), ok: zero(), cand: zero() };
    let capTot = 0;
    const raw = zero(), entries: { code: string; items: BlockItems }[] = [];
    for (const s of U) {
      const mc = s.mcapRow[s.idx.get(d)!];
      capTot += mc;
      const qev = finAtQ(s.code, c), aev = finAtA(s.code, c);
      const has = { V: !!qev?.v, Q: !!qev?.q, Qp: !!qev?.qp, Gr: !!aev?.g };
      for (const id of CIDS) if (blocksOf(id).every((b) => has[b])) raw[id] += mc;
      entries.push({ code: s.code, items: blockItems(qev, aev, mc * 1e8) });
    }
    z.days++; z.n += U.length;
    for (const id of CIDS) {
      if (capTot > 0) z.cap[id] += raw[id] / capTot;
      const ctx = buildCtx(id, c, entries);
      z.cand[id] += ctx.ranked.length;
    }
    yr.set(y, z);
  }
  const years = [...yr.keys()].sort();
  const covPct = (id: CId, y: string): number => (yr.get(y)!.cap[id] / yr.get(y)!.days) * 100;
  console.log(`\n=== 1. 후보별 SMALL 재무 커버리지(필요한 모든 블록의 원자료가 동시에 계산되는 종목의 시총 비율 %, 판단일 연평균; ${R_EVAL_START}~) ===\n| 등급 | 후보(시도) | 기준 | ${years.join(" | ")} | 기준 미달 해 | 판정 |\n|---|---|---|${years.map(() => "---").join("|")}|---|---|`);
  const covOk = {} as Record<CId, boolean>;
  for (const id of CIDS) {
    const cd = G_CANDS[id], v = years.map((y) => covPct(id, y)), bad = years.filter((_, i) => v[i] < cd.minCoveragePct);
    covOk[id] = bad.length === 0;
    console.log(`| ${cd.tier === "main" ? "본 시험" : "탐색"} | ${id}(${cd.trial}) ${cd.blocks.join("·")} | ${cd.minCoveragePct}% | ${v.map(f2).join(" | ")} | ${bad.length ? bad.join(", ") : "없음"} | ${bad.length ? "실행 불가" : "충족"} |`);
  }
  console.log(`\n후보 종목 수(하루 평균, 점수 계산 가능한 SMALL 종목 수; SMALL 평균 ${f2([...yr.values()].reduce((a, z) => a + z.n, 0) / [...yr.values()].reduce((a, z) => a + z.days, 0))})\n| 후보 | ${years.join(" | ")} | 전체 |\n|---|${years.map(() => "---").join("|")}|---|`);
  for (const id of CIDS) {
    const totDays = [...yr.values()].reduce((a, z) => a + z.days, 0);
    console.log(`| ${id}(${G_CANDS[id].trial}) | ${years.map((y) => f2(yr.get(y)!.cand[id] / yr.get(y)!.days)).join(" | ")} | ${f2([...yr.values()].reduce((a, z) => a + z.cand[id], 0) / totDays)} |`);
  }

  // ---- 2단계: 진입 기회 상한(순위만으로 도는 슬롯 모의, 가격·수익률 미사용) ----
  interface Pos { entryC: number; sched: boolean }
  const rankOnly = (id: CId): { entries: number[]; holds: number[]; exits: Map<string, number>; carry: number; heldDays: number; nHeld: number[] } => {
    const held = new Map<string, Pos>(), pendExit = new Map<number, Map<string, string>>(), pendEnt = new Map<number, { list: string[]; free: number }[]>(), lastExit = new Map<string, number>();
    let reserved = 0, carry = 0, heldDays = 0;
    const entries: number[] = [], holds: number[] = [], exits = new Map<string, number>(), nHeld: number[] = [];
    for (let c = cS; c < nCal - 1; c++) {
      const d = CAL[c];
      const close = (code: string, reason: string): void => { const p = held.get(code)!; holds.push(c - p.entryC); held.delete(code); lastExit.set(code, c); exits.set(reason, (exits.get(reason) ?? 0) + 1); };
      for (const code of [...held.keys()]) { const s = byCode.get(code)!; if (s.last < d && s.last < h.endedBefore) close(code, "폐지"); }
      const ex = pendExit.get(c);
      if (ex) {
        pendExit.delete(c);
        for (const [code, reason] of ex) {
          if (!held.has(code)) continue;
          const s = byCode.get(code)!, i = s.idx.get(d);
          if (i === undefined || s.vol[i] === 0) { const nx = pendExit.get(c + 1) ?? new Map<string, string>(); nx.set(code, reason); pendExit.set(c + 1, nx); continue; }
          close(code, reason);
        }
      }
      const en = pendEnt.get(c);
      if (en) {
        pendEnt.delete(c);
        for (const { list, free } of en) {
          reserved -= free;
          let filled = 0;
          for (const code of list) {
            if (filled >= free) break;
            if (held.has(code)) continue;
            const s = byCode.get(code)!, i = s.idx.get(d);
            if (i === undefined || s.vol[i] === 0) continue;
            held.set(code, { entryC: c, sched: false });
            entries.push(c);
            filled++;
          }
        }
      }
      nHeld.push(held.size);
      for (const [code, p] of held) {
        heldDays++;
        if (p.sched) continue;
        const s = byCode.get(code)!, i = s.idx.get(d), r = rankHeld(id, code, c);
        let reason: string | null = null;
        if (i === undefined || s.vol[i] === 0) reason = "거래정지";
        else if (r !== undefined) { if (r > G_KEEP_RANK) reason = "순위 밖"; }
        else if (staleOf(id, code, c)) reason = "후보 제외(재무 신선도 초과)";
        else carry++;
        if (reason) { p.sched = true; const m = pendExit.get(c + 1) ?? new Map<string, string>(); m.set(code, reason); pendExit.set(c + 1, m); }
      }
      const free = G_SLOTS - held.size - reserved;
      if (free > 0) {
        const list: string[] = [];
        for (const sc of ctxOf(id, c).cands) {
          if (held.has(sc.code)) continue;
          const le = lastExit.get(sc.code);
          if (le !== undefined && c - le < G_REENTRY_BAN_DAYS) continue;
          list.push(sc.code);
          if (list.length >= free + 30) break;
        }
        if (list.length) { const a = pendEnt.get(c + 1) ?? []; a.push({ list, free }); pendEnt.set(c + 1, a); reserved += free; }
      }
    }
    return { entries, holds, exits, carry, heldDays, nHeld };
  };
  const ro = new Map(CIDS.map((id) => [id, rankOnly(id)]));
  console.log(`\n=== 2. 진입 기회 상한 추정(순위만으로 도는 슬롯 모의; 가격·수익률 미사용; 게이트 G ${A_MIN_ENTRIES}건) ===\n| 후보 | 진입 건수(체결일 ${CAL[cS + 1]}~) | 게이트 G | 청산 건수 | 청산 사유(건수, %) | 보유일 중앙값 | 직전 순위 유지 보유-일 % |\n|---|---|---|---|---|---|---|`);
  const entOk = {} as Record<CId, boolean>;
  for (const id of CIDS) {
    const r = ro.get(id)!, nx = r.holds.length;
    entOk[id] = r.entries.length >= A_MIN_ENTRIES;
    console.log(`| ${id}(${G_CANDS[id].trial}) | ${r.entries.length} | ${entOk[id] ? "충족" : "미달 → 실행 불가"} | ${nx} | ${[...r.exits].map(([k, v]) => `${k} ${v}(${f2((v / Math.max(nx, 1)) * 100)}%)`).join(" / ")} | ${f2(median(r.holds))} | ${f2((r.carry / Math.max(r.heldDays, 1)) * 100)} |`);
  }
  const runnable = CIDS.filter((id) => covOk[id] && entOk[id] && only.has(id));
  console.log(`\n실행 판정: ${CIDS.map((id) => `${id}(${G_CANDS[id].trial}, ${G_CANDS[id].tier === "main" ? "본 시험" : "탐색"}) ${covOk[id] && entOk[id] ? "실행" : `실행 불가(${[covOk[id] ? "" : "커버리지", entOk[id] ? "" : "진입 100건 미달"].filter(Boolean).join("·")}) — 번호 미소진`}`).join(" | ")}`);
  for (const id of CIDS) if (!runnable.includes(id)) for (const [k] of ctxCache) if (k.startsWith(`${id}|`)) ctxCache.delete(k);

  // ---- 3단계: 통과 후보만 시험 ----
  const verdicts: Verdict[] = [];
  if (runnable.length) {
    const win: Windows = (() => {
      const NW: [string, Win][] = R_SUBPERIODS.map(([n, f, t]) => [n, { from: f, to: t }]);
      const FULL: Win = { from: R_EVAL_FROM, to: "9999-12-31" };
      return { NW, FULL, ALL: [...NW, ["평가 구간 전체", FULL]] };
    })();
    console.log(`\n구간: ${win.NW.map(([n, w]) => `${n} ${w.from}~${w.to}`).join(" / ")}, 평가 구간 전체 ${win.FULL.from}~${h.dataEnd} | 069500 원주가 기준선`);
    const env = { CAL, nCal, cS, adjustments: h.adjustments, endedBefore: h.endedBefore, stockBuyMult: h.stockBuyMult, sellRate: h.sellRate, baseSlip: SLIPPAGE_PCT_PER_SIDE, bhRet: h.bhRet };
    const cfgFor = (slots: number) => ({ slip: R_SMALL_SLIPPAGE, maxPos: slots, capFrac: 1 / slots, cooldown: G_REENTRY_BAN_DAYS });
    const label = (code: string): string => `${code} ${nameOf.get(code) ?? "?"}`;
    const hooksFor = (id: CId, keep: number, exclude?: Set<string>) => ({
      candsOf: (c: number): SimCand[] => (exclude ? ctxOf(id, c).cands.filter((x) => !exclude.has(x.code)) : ctxOf(id, c).cands),
      exitReason: (p: SimPos, c: number, i: number | undefined): string | null => {
        if (i === undefined || p.s.vol[i] === 0) return "거래정지";
        const r = rankHeld(id, p.code, c);
        if (r !== undefined) return r > keep ? "순위 밖" : null;
        return staleOf(id, p.code, c) ? "후보 제외(재무 신선도 초과)" : null; // 점수 계산 불가면 직전 순위 유지
      },
    });
    const mkSpec = (id: CId): CandSpec => {
      const cd = G_CANDS[id];
      const nb: { label: string; run: () => SimRun }[] = [];
      for (const k of G_SLOTS_NEIGHBORS) nb.push({ label: `보유 수 ${k}`, run: () => simSlots(env, cfgFor(k), hooksFor(id, G_KEEP_RANK), { lag: 1 }) });
      for (const k of G_KEEP_RANK_NEIGHBORS) nb.push({ label: `매도 순위 한도 ${k}`, run: () => simSlots(env, cfgFor(G_SLOTS), hooksFor(id, k), { lag: 1 }) });
      return {
        id, trial: cd.trial, title: `${cd.blocks.join("·")} 종합 점수 상위 ${G_SLOTS}개 균등, 순위 ${G_KEEP_RANK}위 밖이면 매도 [${TIER_NOTE[cd.tier]}]`, defense: false, capFrac: 1 / G_SLOTS, fDenominator: CIDS.length,
        run: (o) => simSlots(env, cfgFor(G_SLOTS), hooksFor(id, G_KEEP_RANK, o.exclude), { lag: o.lag, int: o.int, replace: o.replace, detail: o.detail }),
        neighbors: nb,
        random: (rng, ordersByDay) => simSlots(env, cfgFor(G_SLOTS), {
          candsOf: (c, held) => {
            const n = ordersByDay.get(c) ?? 0;
            if (!n) return [];
            const pool = ctxOf(id, c).cands.filter((x) => !held(x.code)), out: SimCand[] = [];
            while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
            return out;
          },
          exitReason: hooksFor(id, G_KEEP_RANK).exitReason,
        }, { lag: 1 }),
        reasons: ["순위 밖", "거래정지", "후보 제외(재무 신선도 초과)", "폐지"],
        label,
        extra: (base) => {
          console.log(`${id} 등급 표기: ${TIER_NOTE[cd.tier]}`);
          // 정보용: 후보 전체 균등 보유(같은 유니버스·같은 비용)
          const allRun = simSlots(env, cfgFor(G_ALL_SLOTS), {
            candsOf: (c) => ctxOf(id, c).candsByCode,
            exitReason: (p, c, i) => (i === undefined || p.s.vol[i] === 0 ? "거래정지" : ctxOf(id, c).rank.has(p.code) ? null : "후보 제외"),
          }, { lag: 1, detail: true });
          console.log(`${id} 정보용 "후보 전체 균등 보유"(보유 한도 ${G_ALL_SLOTS}, 종목당 1/${G_ALL_SLOTS}, 코드 순, 후보에서 빠지면 다음 거래일 매도; 판정 불사용) vs ${id} vs 069500\n| 구간 | 후보 전체 균등 CAGR / MDD | ${id} CAGR / MDD | 069500 CAGR / MDD | 후보 전체 평균 보유 종목 수 |\n|---|---|---|---|---|`);
          for (const [name, w] of win.ALL) { const a = h.st(allRun, w), s = h.st(base, w), b = h.st(h.bhP, w); console.log(`| ${name} | ${f2(a.cagr)} / ${f2(a.mdd)} | ${f2(s.cagr)} / ${f2(s.mdd)} | ${f2(b.cagr)} / ${f2(b.mdd)} | ${f2(a.avgN)} |`); }
          // 상위 3개 거래의 종목을 뺀 재계산
          const pnl = base.trades.map((t) => ({ code: t.code, v: (t.proceeds - t.spend) / t.vAtEntry, ret: t.proceeds / t.spend - 1, e: CAL[t.entryC], x: CAL[t.exitC] })).sort((a, b) => b.v - a.v).slice(0, 3);
          const ex = new Set(pnl.map((t) => t.code));
          const o2 = simSlots(env, cfgFor(G_SLOTS), hooksFor(id, G_KEEP_RANK, ex), { lag: 1, detail: true });
          console.log(`${id} 상위 3개 거래(${pnl.map((t) => `${label(t.code)} ${t.e}~${t.x} ${f2(t.ret * 100)}%`).join(", ")})의 종목을 후보에서 뺀 재계산`);
          for (const [name, w] of win.ALL) { const s = h.st(o2, w), b = h.st(h.bhP, w); console.log(`  상위 3개 종목 제외 ${id} | ${name}: CAGR ${f2(s.cagr)} / MDD ${f2(s.mdd)} (069500 ${f2(b.cagr)} / ${f2(b.mdd)})`); }
          // 시총 상한을 넘어 보유한 종목-일(닫힌 거래 기준)
          let over = 0, outSmall = 0, tot = 0;
          for (const t of base.trades) {
            const s = byCode.get(t.code)!;
            for (let c = t.entryC; c < t.exitC; c++) {
              const i = s.idx.get(CAL[c]);
              if (i === undefined) continue;
              tot++;
              if (s.mcapRow[i] >= R_SMALL_MCAP_MAX_EOK) over++;
              if (!ctxOf(id, Math.min(c, nCal - 2)).rank.has(t.code)) outSmall++;
            }
          }
          console.log(`${id} 시총 상한(${R_SMALL_MCAP_MAX_EOK}억) 이상으로 보유한 종목-일 ${over} / 닫힌 거래 보유 종목-일 ${tot} (${f2((over / Math.max(tot, 1)) * 100)}%) | 후보 집합 밖(SMALL 이탈·점수 계산 불가 포함)에서 보유한 종목-일 ${outSmall} (${f2((outSmall / Math.max(tot, 1)) * 100)}%)`);
          // 평균 투자 비중·현금 비중
          for (const [name, w] of win.ALL) { const s = h.st(base, w); console.log(`  ${id} | ${name}: 평균 투자 비중 ${f2(s.avgInv)}% / 현금 비중 ${f2(100 - s.avgInv)}% / 평균 보유 종목 수 ${f2(s.avgN)}`); }
        },
      };
    };
    const specs = runnable.map(mkSpec);
    for (const sp of specs) verdicts.push(evaluate(h, win, sp));
    summaryReport(verdicts, verdicts.map((v) => v.trial), { prior: G_PRIOR_TESTS, note: (vid) => (G_CANDS[vid as CId].tier === "main" ? "[본 시험]" : "[탐색 등급: 후보 아님]") });
    yearlyTable(h, win, verdicts.map((v) => ({ id: v.id, run: v.run })));
    seedReport(h, win, specs, new Map(verdicts.map((v) => [v.id, v.run])), (code, c) => { const s = byCode.get(code)!, i = s.idx.get(CAL[c]); return i === undefined ? NaN : s.avgTvRow[i]; });
  } else {
    console.log(`\n시험할 후보가 없다(모두 실행 불가). 누적 시험 ${G_PRIOR_TESTS}회 유지.`);
  }
  const dbTot = Object.values(dbRead).reduce((a, b) => a + b, 0);
  console.log(`\n=== 실행 지표 ===\nSupabase 읽은 행: ${Object.entries(dbRead).map(([k, v]) => `${k} ${v}`).join(" | ")} | 합계 ${dbTot}`);
  console.log(`Storage 내려받기 합계 ${(xfer.bytes / 1048576).toFixed(2)} MiB(가격 Parquet은 Actions 캐시로 읽어 0) | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 소요 ${((Date.now() - T0) / 60000).toFixed(1)}분 | 시험한 번호 ${verdicts.map((v) => v.trial).join(", ") || "없음"}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

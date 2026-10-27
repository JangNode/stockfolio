/**
 * [임시 연구 진단 — 시험 아님, 시도 번호 소진 없음, 병합 금지, 읽기 전용, 외부 요청 0건] 전략별 최대 낙폭(MDD)이 069500보다 크게 나오는 이유를 언제·어떤 상황인지로 나열하는 사실 진단.
 * 이미 사전등록·시험한 전략 LE2·L3·LW3·LV1·B1·LM2의 같은 정의 그대로 자산 곡선을 다시 계산한다(정의·파라미터 변경 없음). 먼저 재현한 CAGR·MDD가 기존 보고와 소수 둘째 자리까지 일치하는지 확인하고
 * 하나라도 불일치하면 분석을 출력하지 않고 중단한다. 가격 Parquet은 고정 스냅샷(데이터 종료일 2026-10-26)에서만 읽는다. DB·Storage 쓰기 0.
 */
import { simSlots, type SimCand, type SimPos, type SimRun, type SimVt } from "@/lib/slotSim";
import { L_CANDS, L_SLIPPAGE, L_EVAL_AFTER } from "@/lib/megacapTrendConfig";
import { LS_COOLDOWN_DAYS } from "@/lib/megacapTrailingConfig";
import { LM_CANDS, LM_SKIP } from "@/lib/megacapMomentumConfig";
import { LE_LEGS, LE_ENTRY_LEG } from "@/lib/momentumEnsembleConfig";
import { LW_CANDS, LW_BASES, LW_RANK_DEPTH } from "@/lib/momentumWideConfig";
import { LV_WINDOW, LV_ANNUAL_DAYS, LV_ROUND_DP, LV_BAND } from "@/lib/le2VolTargetConfig";
import { B_VOL_WINDOW, B_MOM_LOOKBACK, B_MOM_SKIP, B_CANDS, B_SLIPPAGE } from "@/lib/lowvolMomentumConfig";
import { rankEnsemble, outsiderEnsembleRank, type EnsembleRanking } from "@/lib/momentumEnsemble";
import { alignCloses, equalWeightSigma, volMultiplier } from "@/lib/le2VolTarget";
import { loadHarness, loadK200P, verifySnapshotManifest, storageLine, SNAP_END, f2, type S } from "./researchHarness";
import { SLIPPAGE_PCT_PER_SIDE } from "@/lib/transactionCostConfig";

const KSIC: Record<string, string> = {
  "01": "농업", "05": "석탄·원유·천연가스 광업", "10": "식료품", "11": "음료", "12": "담배", "13": "섬유제품", "14": "의복·모피", "16": "목재·나무제품", "17": "펄프·종이", "19": "코크스·석유정제품", "20": "화학물질·화학제품",
  "21": "의료용 물질·의약품", "22": "고무·플라스틱", "23": "비금속 광물제품", "24": "1차 금속", "25": "금속가공제품", "26": "전자부품·컴퓨터·통신장비", "27": "의료·정밀·광학기기", "28": "전기장비", "29": "기타 기계·장비",
  "30": "자동차·트레일러", "31": "기타 운송장비", "33": "기타 제품", "35": "전기·가스·증기 공급", "41": "종합 건설", "42": "전문직별 공사", "46": "도매·상품 중개", "47": "소매", "49": "육상 운송", "50": "수상 운송", "51": "항공 운송",
  "52": "창고·운송 관련 서비스", "55": "숙박", "58": "출판", "59": "영상·오디오 제작·배급", "60": "방송", "61": "우편·통신", "62": "컴퓨터 프로그래밍·시스템 통합", "63": "정보 서비스", "64": "금융", "65": "보험·연금", "66": "금융·보험 관련 서비스",
  "68": "부동산", "70": "연구개발", "71": "전문 서비스", "72": "건축기술·엔지니어링", "73": "기타 전문·과학·기술 서비스", "75": "사업 지원 서비스", "90": "창작·예술·여가", "91": "스포츠·오락",
};
const SAMSUNG = "005930", HYNIX = "000660";
const B_ORIG_END = "2026-10-23";

interface Series { name: string; dates: string[]; ret: number[]; from: string; held: Map<number, { V: number; held: [string, number][] }> }
interface Episode { peakIdx: number; troughIdx: number; recIdx: number | null; depth: number }

/** 일수익률(%) 열로 낙폭 구간을 나눈다: 직전 고점 → 저점 → 직전 고점 회복. idx −1 = 첫 수익률 이전(시작). */
function episodes(ret: number[]): Episode[] {
  const out: Episode[] = [];
  let E = 1, peak = 1, peakIdx = -1, cur: Episode | null = null, trough = 1;
  for (let i = 0; i < ret.length; i++) {
    E *= 1 + ret[i] / 100;
    if (E >= peak) {
      if (cur) { cur.recIdx = i; out.push(cur); cur = null; }
      peak = E; peakIdx = i; trough = E;
    } else {
      if (!cur) { cur = { peakIdx, troughIdx: i, recIdx: null, depth: 0 }; trough = E; }
      if (E <= trough) { trough = E; cur.troughIdx = i; cur.depth = 1 - E / peak; }
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function main(): Promise<void> {
  console.log(`연구 진단 MDD 해부 시작(시험 아님, 읽기 전용): ${new Date().toISOString()}`);
  if (!SNAP_END || process.env.PARQUET_CACHE_FROZEN !== "1") throw new Error("고정 스냅샷 모드(RESEARCH_DATA_END, PARQUET_CACHE_FROZEN=1)가 아니면 실행하지 않는다");
  console.log(await verifySnapshotManifest());
  const h = await loadHarness();
  const { CAL, nCal, byCode, calIdx } = h;
  const { excluded, membAt, nameOf, kAt, indOf } = await loadK200P(h);
  const cL = CAL.findIndex((d) => d >= L_EVAL_AFTER), cB = B_MOM_LOOKBACK;
  const env = (cS: number) => ({ CAL, nCal, cS, adjustments: h.adjustments, endedBefore: h.endedBefore, stockBuyMult: h.stockBuyMult, sellRate: h.sellRate, baseSlip: SLIPPAGE_PCT_PER_SIDE, bhRet: h.bhRet });
  const label = (code: string): string => `${code} ${nameOf.get(code) ?? "?"}`;

  // ---- 시총 순위·앙상블(연구 L·LM·LE·LW와 같다, 깊이만 LW_RANK_DEPTH) ----
  const megaCache = new Map<number, { list: S[]; rank: Map<string, number> }>();
  const megaAt = (c: number): { list: S[]; rank: Map<string, number> } => {
    let v = megaCache.get(c);
    if (!v) {
      const d = CAL[c], m = membAt(d), e: { s: S; mc: number }[] = [];
      if (m) for (const s of h.stocks) {
        const i = s.idx.get(d);
        if (i === undefined || excluded.has(s.code) || m.get(s.code) !== "KOSPI") continue;
        e.push({ s, mc: s.mcapRow[i] });
      }
      e.sort((a, b) => b.mc - a.mc || (a.s.code < b.s.code ? -1 : 1));
      const list = e.slice(0, LW_RANK_DEPTH).map((x) => x.s);
      v = { list, rank: new Map(list.map((s, k) => [s.code, k + 1])) };
      megaCache.set(c, v);
    }
    return v;
  };
  const legRets = (s: S, i: number): number[] => LE_LEGS.map((lg) => { if (i < lg.lookback) return NaN; const a = s.close[i - lg.skip], b = s.close[i - lg.lookback]; return a > 0 && b > 0 ? a / b - 1 : NaN; });
  const ensCache = new Map<string, EnsembleRanking & { sOf: Map<string, S> }>();
  const ensAt = (pool: number, c: number): EnsembleRanking & { sOf: Map<string, S> } => {
    const key = `${pool}|${c}`;
    let v = ensCache.get(key);
    if (!v) {
      const d = CAL[c], items: { code: string; rets: number[] }[] = [], sOf = new Map<string, S>();
      for (const s of megaAt(c).list.slice(0, pool)) { const rets = legRets(s, s.idx.get(d)!); if (rets.every(Number.isFinite)) { items.push({ code: s.code, rets }); sOf.set(s.code, s); } }
      v = { ...rankEnsemble(items), sOf };
      ensCache.set(key, v);
    }
    return v;
  };
  interface EP { pool: number; slots: number; keepRank: number; keepCap: number }
  const ensHooks = (P: EP) => ({
    candsOf: (c: number): SimCand[] => { const en = ensAt(P.pool, c), out: SimCand[] = []; for (let k = 0; k < P.slots && k < en.items.length; k++) { const it = en.items[k]; if (it.rets[LE_ENTRY_LEG] > 0) out.push({ s: en.sOf.get(it.code)!, code: it.code }); } return out; },
    exitReason: (p: SimPos, c: number, i: number | undefined): string | null => {
      if (i === undefined) return null;
      if ((megaAt(c).rank.get(p.code) ?? Number.POSITIVE_INFINITY) > P.keepCap) return "시총 순위 밖";
      const rets = legRets(byCode.get(p.code)!, i);
      if (!rets.every(Number.isFinite)) return null;
      const en = ensAt(P.pool, c);
      return (en.rank.get(p.code) ?? outsiderEnsembleRank(en, rets)) > P.keepRank ? "앙상블 순위 밖" : null;
    },
  });
  const alignedCache = new Map<string, Float64Array>();
  const alignedOf = (code: string): Float64Array => { let a = alignedCache.get(code); if (!a) { const s = byCode.get(code)!; a = alignCloses(CAL, s.idx, s.close); alignedCache.set(code, a); } return a; };
  const vt20: SimVt = { sizeMult: (c, stocks) => volMultiplier(equalWeightSigma(stocks.map((s) => alignedOf(s.code)), c, LV_WINDOW, LV_ANNUAL_DAYS), 0.2, LV_ROUND_DP), band: LV_BAND };
  const cfgOf = (slots: number, cooldown: number, vt?: SimVt) => ({ slip: L_SLIPPAGE, maxPos: slots, capFrac: 1 / slots, cooldown, vt });

  // ---- LM(연구 LM) 단일 룩백 풀 ----
  const momOf = (s: S, i: number, lb: number): number => { if (i < lb) return NaN; const a = s.close[i - LM_SKIP], b = s.close[i - lb]; return a > 0 && b > 0 ? a / b - 1 : NaN; };
  interface LmPool { items: { s: S; m: number }[]; rank: Map<string, number>; moms: number[] }
  const lmCache = new Map<string, LmPool>();
  const lmPoolAt = (pool: number, lb: number, c: number): LmPool => {
    const key = `${pool}|${lb}|${c}`;
    let v = lmCache.get(key);
    if (!v) {
      const d = CAL[c], items: { s: S; m: number }[] = [];
      for (const s of megaAt(c).list.slice(0, pool)) { const m = momOf(s, s.idx.get(d)!, lb); if (Number.isFinite(m)) items.push({ s, m }); }
      items.sort((a, b) => b.m - a.m || (a.s.code < b.s.code ? -1 : 1));
      v = { items, rank: new Map(items.map((x, k) => [x.s.code, k + 1])), moms: items.map((x) => x.m) };
      lmCache.set(key, v);
    }
    return v;
  };
  const lmOut = (pl: LmPool, m: number): number => { let lo = 0, hi = pl.moms.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (pl.moms[mid] > m) lo = mid + 1; else hi = mid; } return 1 + lo; };
  const lm2 = LM_CANDS.LM2;

  // ---- B1(연구 B): 저변동 + 모멘텀 합산 순위 ----
  interface BCand extends SimCand { rank: number }
  const bCache = new Map<number, { rank: Map<string, number>; cand: BCand[] }>();
  const bRank = (c: number): { rank: Map<string, number>; cand: BCand[] } => {
    let v = bCache.get(c);
    if (v) return v;
    const d = CAL[c], vw = B_VOL_WINDOW, items: { s: S; sig: number; mom: number; rs: number; rm: number }[] = [];
    for (const s of kAt(d)) {
      const i = s.idx.get(d);
      if (i === undefined || i < B_MOM_LOOKBACK || i < vw) continue;
      const a = s.close[i - B_MOM_SKIP], b = s.close[i - B_MOM_LOOKBACK];
      if (!(a > 0) || !(b > 0)) continue;
      let sum = 0, n = 0, bad = false;
      const r: number[] = [];
      for (let k = i - vw + 1; k <= i; k++) { const p0 = s.close[k - 1], p1 = s.close[k]; if (!(p0 > 0) || !(p1 > 0)) { bad = true; break; } const x = p1 / p0 - 1; r.push(x); sum += x; n++; }
      if (bad) continue;
      const mean = sum / n;
      let ss = 0;
      for (const x of r) ss += (x - mean) ** 2;
      items.push({ s, sig: Math.sqrt(ss / (n - 1)), mom: a / b - 1, rs: 0, rm: 0 });
    }
    const asc = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
    [...items].sort((x, y) => x.sig - y.sig || asc(x.s.code, y.s.code)).forEach((x, k) => { x.rs = k + 1; });
    [...items].sort((x, y) => y.mom - x.mom || asc(x.s.code, y.s.code)).forEach((x, k) => { x.rm = k + 1; });
    const ord = [...items].sort((x, y) => (x.rs + x.rm) / 2 - (y.rs + y.rm) / 2 || x.sig - y.sig || asc(x.s.code, y.s.code));
    const rank = new Map<string, number>(), cand: BCand[] = [];
    ord.forEach((x, k) => { rank.set(x.s.code, k + 1); if (x.mom > 0) cand.push({ s: x.s, code: x.s.code, rank: k + 1 }); });
    v = { rank, cand };
    bCache.set(c, v);
    return v;
  };

  // ---- 여섯 전략 재현 (일별 보유 스냅샷 포함) ----
  const mk = (name: string, cS: number, run: (held: Series["held"]) => SimRun): Series => {
    const held: Series["held"] = new Map();
    const r = run(held);
    return { name, dates: r.dates, ret: r.ret, from: CAL[cS + 1], held };
  };
  const onDayOf = (held: Series["held"]) => (c: number, V: number, hs: [string, number][]): void => { held.set(c, { V, held: hs }); };
  const l3 = L_CANDS.L3, lw3 = LW_CANDS.LW3, le2 = LW_BASES.LE2, b1 = B_CANDS.B1;
  const series: Series[] = [
    mk("LE2", cL, (held) => simSlots(env(cL), cfgOf(le2.slots, LS_COOLDOWN_DAYS), ensHooks(le2), { lag: 1, detail: true, onDay: onDayOf(held) })),
    mk("L3", cL, (held) => simSlots(env(cL), cfgOf(l3.slots, 0), {
      candsOf: (c: number): SimCand[] => megaAt(c).list.slice(0, l3.entryRank).map((s) => ({ s, code: s.code })),
      exitReason: (p: SimPos, c: number, i: number | undefined): string | null => (i === undefined ? null : (megaAt(c).rank.get(p.code) ?? Number.POSITIVE_INFINITY) > l3.keepRank ? "시총 순위 밖" : null),
    }, { lag: 1, detail: true, onDay: onDayOf(held) })),
    mk("LW3", cL, (held) => simSlots(env(cL), cfgOf(lw3.slots, LS_COOLDOWN_DAYS), ensHooks(lw3), { lag: 1, detail: true, onDay: onDayOf(held) })),
    mk("LV1", cL, (held) => simSlots(env(cL), cfgOf(le2.slots, LS_COOLDOWN_DAYS, vt20), ensHooks(le2), { lag: 1, detail: true, onDay: onDayOf(held) })),
    mk("B1", cB, (held) => simSlots(env(cB), { slip: B_SLIPPAGE, maxPos: b1.slots, capFrac: b1.frac, cooldown: 0 }, {
      candsOf: (c: number): BCand[] => bRank(c).cand,
      exitReason: (p: SimPos, c: number): string | null => { const r = bRank(c).rank.get(p.code); return r === undefined || r > b1.keepRank ? "순위 밖" : null; },
    }, { lag: 1, detail: true, onDay: onDayOf(held) })),
    mk("LM2", cL, (held) => simSlots(env(cL), cfgOf(lm2.slots, LS_COOLDOWN_DAYS), {
      candsOf: (c: number): SimCand[] => { const pl = lmPoolAt(lm2.pool, lm2.lookback, c), out: SimCand[] = []; for (let k = 0; k < lm2.slots && k < pl.items.length; k++) { const it = pl.items[k]; if (it.m > 0) out.push({ s: it.s, code: it.s.code }); } return out; },
      exitReason: (p: SimPos, c: number, i: number | undefined): string | null => {
        if (i === undefined) return null;
        if ((megaAt(c).rank.get(p.code) ?? Number.POSITIVE_INFINITY) > lm2.keepCap) return "시총 순위 밖";
        const m = momOf(byCode.get(p.code)!, i, lm2.lookback);
        if (!Number.isFinite(m)) return null;
        const pl = lmPoolAt(lm2.pool, lm2.lookback, c);
        return (pl.rank.get(p.code) ?? lmOut(pl, m)) > lm2.keepMom ? "모멘텀 순위 밖" : null;
      },
    }, { lag: 1, detail: true, onDay: onDayOf(held) })),
  ];
  const bh: Series = { name: "069500", dates: h.bhP.dates.filter((d) => d >= CAL[cL + 1]), ret: h.bhP.ret.filter((_, k) => h.bhP.dates[k] >= CAL[cL + 1]), from: CAL[cL + 1], held: new Map() };

  // ---- 0. 재현 확인 ----
  const stat = (s: Series, from: string, to: string): { cagr: number; mdd: number } => { const x = h.st({ dates: s.dates, ret: s.ret }, { from, to }); return { cagr: x.cagr, mdd: x.mdd }; };
  const REF: { name: string; ref: { cagr: number; mdd: number }; to: string; from?: string; src: string }[] = [
    { name: "LE2", ref: { cagr: 10.87, mdd: 55.36 }, to: "9999-12-31", src: "LE 시험(스냅샷 2026-10-26)" },
    { name: "L3", ref: { cagr: 11.05, mdd: 51.63 }, to: "9999-12-31", src: "LE·LV 시험의 L3 재계산(스냅샷)" },
    { name: "LW3", ref: { cagr: 6.58, mdd: 60.07 }, to: "9999-12-31", src: "LW 시험(스냅샷)" },
    { name: "LV1", ref: { cagr: 6.95, mdd: 46.46 }, to: "9999-12-31", src: "LV 시험(스냅샷)" },
    { name: "B1", ref: { cagr: 4.91, mdd: 62.21 }, to: B_ORIG_END, src: "연구 B 시험(수익 집계 2011-01-05~2026-10-23)" },
    { name: "LM2", ref: { cagr: 7.57, mdd: 55.45 }, to: "9999-12-31", src: "RG·LE 시험의 LM2 재계산(스냅샷)" },
  ];
  console.log("\n=== 0. 재현 확인 (같은 정의로 다시 계산한 값 vs 기존 보고, 소수 둘째 자리 일치) ===\n| 전략 | 비교 구간 | 재현 CAGR / MDD | 기존 보고 CAGR / MDD | 출처 | 일치 |\n|---|---|---|---|---|---|");
  let allOk = true;
  for (const r of REF) {
    const s = series.find((x) => x.name === r.name)!, st = stat(s, s.from, r.to);
    const ok = f2(st.cagr) === r.ref.cagr.toFixed(2) && f2(st.mdd) === r.ref.mdd.toFixed(2);
    if (!ok) allOk = false;
    console.log(`| ${r.name} | ${s.from}~${r.to === "9999-12-31" ? h.dataEnd : r.to} | ${f2(st.cagr)} / ${f2(st.mdd)} | ${r.ref.cagr.toFixed(2)} / ${r.ref.mdd.toFixed(2)} | ${r.src} | ${ok ? "O" : "X"} |`);
  }
  const bhL = stat(bh, bh.from, "9999-12-31"), bhB = stat(bh, CAL[cB + 1], B_ORIG_END);
  console.log(`참고: 069500 원주가 ${bh.from}~${bh.dates[bh.dates.length - 1]} ${f2(bhL.cagr)} / ${f2(bhL.mdd)} (069500 가격 행은 ${bh.dates[bh.dates.length - 1]}까지), B 구간 ${CAL[cB + 1]}~${B_ORIG_END} ${f2(bhB.cagr)} / ${f2(bhB.mdd)} (기존 B 시험 7.60 / 41.34)`);
  const b1s = series.find((x) => x.name === "B1")!, b1snap = stat(b1s, b1s.from, "9999-12-31");
  console.log(`참고: B1을 스냅샷 종료일(${h.dataEnd})까지 이어 계산한 값 ${f2(b1snap.cagr)} / ${f2(b1snap.mdd)} (기존 보고는 2026-10-23까지)`);
  if (!allOk || f2(bhB.cagr) !== "7.60" || f2(bhB.mdd) !== "41.34") {
    console.log("재현 불일치 — 지시에 따라 분석을 출력하지 않고 중단한다.");
    return;
  }
  console.log("재현 확인 통과 — 여섯 전략 모두 기존 보고와 일치.");

  // ---- 공통 도구 ----
  const dateAt = (s: Series, idx: number): string => (idx < 0 ? `시작(${s.from} 직전)` : s.dates[idx]);
  const equity = (ret: number[]): number[] => { let E = 1; return ret.map((r) => (E *= 1 + r / 100)); };
  const pctOf = (x: number): string => f2(x * 100);
  const all: Series[] = [bh, ...series];

  // ---- 1. 낙폭 상위 5개 구간 ----
  console.log("\n=== 1. 낙폭 상위 5개 구간 (고점 → 저점 → 회복; 회복 = 직전 고점 이상으로 돌아온 첫 날) ===");
  const topEp = new Map<string, Episode[]>();
  for (const s of all) {
    const eps = episodes(s.ret).sort((a, b) => b.depth - a.depth).slice(0, 5);
    topEp.set(s.name, eps);
    console.log(`\n${s.name} (${s.from}~${s.dates[s.dates.length - 1]})\n| 순위 | 고점 날짜 | 저점 날짜 | 회복 날짜 | 낙폭 % | 고점→저점 거래일 | 저점→회복 거래일 |\n|---|---|---|---|---|---|---|`);
    eps.forEach((e, k) => console.log(`| ${k + 1} | ${dateAt(s, e.peakIdx)} | ${s.dates[e.troughIdx]} | ${e.recIdx === null ? "미회복" : s.dates[e.recIdx]} | ${pctOf(e.depth)} | ${e.troughIdx - e.peakIdx} | ${e.recIdx === null ? "-" : e.recIdx - e.troughIdx} |`));
  }
  const maxEp = new Map(all.map((s) => [s.name, topEp.get(s.name)![0]]));

  // ---- 2. 각 전략 최대 낙폭 구간 ----
  console.log("\n=== 2. 각 전략의 최대 낙폭 구간 상세 (저점 날짜의 보유 종목, 종목 수익률 = 고점 날짜 → 저점 날짜 수정 종가 변화) ===");
  const retBetween = (s: Series, aIdx: number, bIdx: number): number => { const E = equity(s.ret); const ea = aIdx < 0 ? 1 : E[aIdx]; return E[bIdx] / ea - 1; };
  const retOnDates = (s: Series, d0: string, d1: string): number | null => { const E = equity(s.ret), i0 = d0 < s.dates[0] ? -1 : s.dates.indexOf(d0), i1 = s.dates.indexOf(d1); if (i1 < 0 || (i0 < 0 && d0 >= s.dates[0])) return null; return E[i1] / (i0 < 0 ? 1 : E[i0]) - 1; };
  for (const s of series) {
    const e = maxEp.get(s.name)!, pd = dateAt(s, e.peakIdx), td = s.dates[e.troughIdx];
    const cP = e.peakIdx < 0 ? calIdx.get(s.from)! - 1 : calIdx.get(s.dates[e.peakIdx])!, cT = calIdx.get(td)!;
    const bhRet = retOnDates(bh, e.peakIdx < 0 ? bh.dates[0] : s.dates[e.peakIdx], td);
    const snap = s.held.get(cT);
    console.log(`\n[${s.name}] 최대 낙폭 ${pctOf(e.depth)}% — 고점 ${pd} → 저점 ${td} (${e.troughIdx - e.peakIdx}거래일), 회복 ${e.recIdx === null ? "미회복" : s.dates[e.recIdx]} | 같은 기간 전략 수익률 ${pctOf(retBetween(s, e.peakIdx, e.troughIdx))}% | 같은 기간 069500 수익률 ${bhRet === null ? "자료 없음(069500 가격 행 종료 후)" : `${pctOf(bhRet)}%`}`);
    if (!snap) { console.log("  저점 날짜 보유 스냅샷 없음"); continue; }
    const rows = snap.held.map(([code, val]) => ({ code, w: val / snap.V, r: alignedOf(code)[cT] / alignedOf(code)[cP] - 1 })).sort((a, b) => b.w - a.w);
    const cash = 1 - rows.reduce((a, x) => a + x.w, 0);
    console.log(`  저점 날짜 보유 ${rows.length}종목, 현금 ${pctOf(cash)}%\n  | 종목 | 비중 % | 고점→저점 종목 수익률 % |\n  |---|---|---|`);
    for (const x of rows) console.log(`  | ${label(x.code)} | ${pctOf(x.w)} | ${pctOf(x.r)} |`);
    const sec = new Map<string, number>();
    for (const x of rows) { const k = (indOf.get(x.code) ?? "??").slice(0, 2); sec.set(k, (sec.get(k) ?? 0) + x.w); }
    console.log(`  업종(KSIC 2자리) 비중 %: ${[...sec].sort((a, b) => b[1] - a[1]).map(([k, w]) => `${k} ${KSIC[k] ?? "(분류 미상)"} ${pctOf(w)}`).join(" | ")}`);
    const wOf = (code: string): number => (rows.find((x) => x.code === code)?.w ?? 0);
    let sa = 0, sh = 0, n = 0;
    for (let c = cP + 1; c <= cT; c++) { const hd = s.held.get(c); if (!hd) continue; n++; for (const [code, val] of hd.held) { if (code === SAMSUNG) sa += val / hd.V; if (code === HYNIX) sh += val / hd.V; } }
    console.log(`  삼성전자 비중 저점 ${pctOf(wOf(SAMSUNG))}% · SK하이닉스 ${pctOf(wOf(HYNIX))}% · 합 ${pctOf(wOf(SAMSUNG) + wOf(HYNIX))}% | 고점→저점 구간 일평균 삼성전자 ${pctOf(sa / Math.max(n, 1))}% · SK하이닉스 ${pctOf(sh / Math.max(n, 1))}%`);
  }

  // ---- 3. 하락 베타 ----
  console.log("\n=== 3. 069500 대비 베타·상관 (일수익률, 두 계열이 모두 있는 날) ===\n정의: 베타 = 전략 일수익률을 069500 일수익률에 회귀(절편 포함)한 기울기. 하락일 = 069500 일수익률 < 0, 상승일 = > 0. 하위 5% 일 = 069500 일수익률이 표본 5백분위 이하인 날.\n| 전략 | 표본일 | 베타 전체 | 베타 하락일 | 베타 상승일 | 상관계수 | 하위 5% 일수 | 하위 5% 일 069500 평균 % | 하위 5% 일 전략 평균 % | 전략/069500 |\n|---|---|---|---|---|---|---|---|---|---|");
  const bhMap = new Map(bh.dates.map((d, i) => [d, bh.ret[i]]));
  const slope = (x: number[], y: number[]): number => { const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n; let c = 0, v = 0; for (let i = 0; i < n; i++) { c += (x[i] - mx) * (y[i] - my); v += (x[i] - mx) ** 2; } return v > 0 ? c / v : NaN; };
  const corr = (x: number[], y: number[]): number => { const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n; let c = 0, vx = 0, vy = 0; for (let i = 0; i < n; i++) { c += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2; } return c / Math.sqrt(vx * vy); };
  for (const s of series) {
    const x: number[] = [], y: number[] = [];
    s.dates.forEach((d, i) => { const b = bhMap.get(d); if (b !== undefined) { x.push(b); y.push(s.ret[i]); } });
    const sorted = [...x].sort((a, b) => a - b), q5 = sorted[Math.floor(sorted.length * 0.05)];
    const sel = (f: (b: number) => boolean): [number[], number[]] => { const xs: number[] = [], ys: number[] = []; x.forEach((b, i) => { if (f(b)) { xs.push(b); ys.push(y[i]); } }); return [xs, ys]; };
    const [dx, dy] = sel((b) => b < 0), [ux, uy] = sel((b) => b > 0), [lx, ly] = sel((b) => b <= q5);
    const mean = (a: number[]): number => a.reduce((p, c) => p + c, 0) / Math.max(a.length, 1);
    console.log(`| ${s.name} | ${x.length} | ${f2(slope(x, y))} | ${f2(slope(dx, dy))} | ${f2(slope(ux, uy))} | ${f2(corr(x, y))} | ${lx.length} | ${f2(mean(lx))} | ${f2(mean(ly))} | ${f2(mean(ly) / mean(lx))} |`);
  }
  console.log("(참고: 069500 일수익률 5백분위 값 = " + (() => { const xs = bh.ret.slice().sort((a, b) => a - b); return f2(xs[Math.floor(xs.length * 0.05)]); })() + "%, 069500 가격 행이 있는 날만 사용)");

  // ---- 4. 069500의 최대 낙폭 구간에서 각 전략 ----
  const eb = maxEp.get("069500")!, bpd = bh.dates[eb.peakIdx], btd = bh.dates[eb.troughIdx];
  console.log(`\n=== 4. 069500 최대 낙폭 구간: 고점 ${eb.peakIdx < 0 ? "시작" : bpd} → 저점 ${btd} (${pctOf(eb.depth)}%, ${eb.troughIdx - eb.peakIdx}거래일), 회복 ${eb.recIdx === null ? "미회복" : bh.dates[eb.recIdx]} ===\n| 전략 | 구간 수익률 % (고점일 → 저점일 종가) | 구간 안 최대 낙폭 % | 그 낙폭의 고점 → 저점 | 전략 자체 최대 낙폭 % |\n|---|---|---|---|---|`);
  const inRange = (s: Series): { lo: number; hi: number } => ({ lo: Math.max(s.dates.indexOf(bpd), -1), hi: s.dates.indexOf(btd) });
  for (const s of all) {
    const { lo, hi } = inRange(s);
    if (hi < 0 || (lo < 0 && bpd >= s.dates[0])) { console.log(`| ${s.name} | 구간 자료 없음 | - | - | - |`); continue; }
    const seg = s.ret.slice(lo + 1, hi + 1), eps = episodes(seg).sort((a, b) => b.depth - a.depth)[0];
    const dd = eps ? `${pctOf(eps.depth)}` : "0.00";
    const where = eps ? `${eps.peakIdx < 0 ? bpd : s.dates[lo + 1 + eps.peakIdx]} → ${s.dates[lo + 1 + eps.troughIdx]}` : "-";
    console.log(`| ${s.name} | ${pctOf(retBetween(s, lo, hi) / 1 )} | ${dd} | ${where} | ${pctOf(maxEp.get(s.name)!.depth)} |`);
  }

  // ---- 5. 구간별(학습·확인·보류) MDD 날짜 ----
  console.log("\n=== 5. 구간별 MDD 날짜 (구간 시작 자산 1.0에서 다시 계산한 구간 안 최대 낙폭; 회복은 구간 안에서 직전 고점을 되찾은 날) ===");
  const wins: [string, string, string][] = [["학습 2011~2016", "0000-00-00", "2016-12-31"], ["확인 2017~2021", "2017-01-01", "2021-12-31"], ["보류 2022~", "2022-01-01", "9999-12-31"]];
  for (const [wn, f, t] of wins) {
    console.log(`\n${wn}\n| 전략 | 구간 MDD % | 고점 날짜 | 저점 날짜 | 회복 날짜 | 고점→저점 거래일 |\n|---|---|---|---|---|---|`);
    for (const s of all) {
      const idx = s.dates.map((d, i) => (d >= f && d <= t ? i : -1)).filter((i) => i >= 0);
      if (!idx.length) continue;
      const seg = idx.map((i) => s.ret[i]), eps = episodes(seg).sort((a, b) => b.depth - a.depth)[0];
      if (!eps) { console.log(`| ${s.name} | 0.00 | - | - | - | - |`); continue; }
      const d = (k: number): string => (k < 0 ? `구간 시작(${s.dates[idx[0]]})` : s.dates[idx[k]]);
      console.log(`| ${s.name} | ${pctOf(eps.depth)} | ${d(eps.peakIdx)} | ${s.dates[idx[eps.troughIdx]]} | ${eps.recIdx === null ? "구간 안 미회복" : s.dates[idx[eps.recIdx]]} | ${eps.troughIdx - eps.peakIdx} |`);
    }
  }
  console.log(`\n${storageLine()} | Supabase 쓴 행 0 | Storage 쓰기 0 | 외부 요청 0 | 시도 번호 소진 없음`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

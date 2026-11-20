/**
 * [임시 연구 — 병합 금지] 연구 묶음 5 공용 월간(또는 분기) 목표 비중 재조정 시뮬레이터(순수 함수, I/O 없음).
 * lib/slotSim.ts와 같은 비용·체결 규칙(신호일 종가 판단 → lag 거래일 뒤 종가 체결, 수정 종가 기준 소수 주, 매수 배수·매도 비용률·슬리피지 공식, 거래정지 처리, 상장폐지 처리)을 쓰고 슬롯 대신 "신호일마다 목표 비중표"를 받아 보유 종목을 그 비중으로 맞춘다.
 * 신호일 c의 목표표는 체결일(c + lag) 종가의 계좌 평가액 V에 곱해 목표 금액을 만든다. 체결 순서: 목표 밖·초과 종목 매도(전량 청산은 거래정지면 다음 거래일로 순연, 부분 조정은 거래정지면 건너뜀) → 부족 종목 매수(거래량 0이면 건너뜀, 현금이 모자라면 남은 현금만큼). 비용은 슬롯 시뮬레이터와 같은 일별 비용 비율(costFrac) 방식.
 * 거래 = 한 종목의 "보유 구간"(첫 매수 체결일 ~ 전량 청산일). 구간 안의 추가 매수·부분 매도는 spend·proceeds에 합산한다(proceeds = 실제 받은 순액 합). 기간 끝까지 열려 있는 구간은 trades에 넣지 않고 open에 따로 낸다.
 * replace(게이트 E): 키 `${code}|${entryC}` 구간은 그 종목 대신 069500 원주가 일수익률로 평가하고, 같은 목표 금액·비용으로 조정한다.
 */
import type { SimEnv, SimRun, SimS, SimTrade } from "@/lib/slotSim";

export interface RebalCfg {
  /** 종목·체결일별 편도 슬리피지(소수). 기본 슬리피지(env.baseSlip)를 이 값으로 바꾼다(slotSim의 cfg.slip과 같은 방식). */
  slipOf: (code: string, c: number) => number;
  /** 데이터가 끝난(폐지) 종목: "last" = 마지막 수정 종가로 청산(수수료·세금 부과), "loss" = 전액 손실(받는 금액 0), "rule" = 종목별로 vanishLoss(code)가 true면 전액 손실 아니면 마지막 종가 청산(저평가 시험 VB1~VB1C). */
  vanish: "last" | "loss" | "rule";
  vanishLoss?: (code: string) => boolean;
}
export interface RebalHooks {
  /** 신호일인가. */
  isSignal: (c: number) => boolean;
  /** 신호일 c의 목표 비중표(계좌 대비, 종목코드 → 비중). 표에 없는 보유 종목은 비중 0(청산). held = 신호일 종가 시점 보유 종목. */
  targetsAt: (c: number, held: ReadonlySet<string>) => Map<string, number>;
  /** 코드 → 종목 시계열. */
  stockOf: (code: string) => SimS | undefined;
}
export interface RebalOpts { lag: number; replace?: Set<string>; detail?: boolean }
export interface RebalRun extends SimRun {
  open: SimTrade[];
  /** 날짜별로 거래정지 때문에 청산이 다음 거래일로 순연돼 아직 들고 있는 종목 수(보유 종목 수 상한 점검용). */
  nDefer: number[];
  /** 종목별 일 수익 기여(%p, 계좌 전일 평가액 대비, 가격 변동분만 — 비용·재조정 제외)의 합과 보유 일수. */
  contrib: Map<string, { pct: number; days: number }>;
  /** 마지막 날 보유 종목 수·현금 비중. */
  endCash: number;
}

interface Pos { code: string; s: SimS; shares: number; lastPx: number; entryC: number; entryAdj: number; entryRaw: number; peak: number; spend: number; vAtEntry: number; rep: boolean; repVal: number; realized: number; held: number }

export function rebalSim(env: SimEnv, cfg: RebalCfg, hooks: RebalHooks, o: RebalOpts): RebalRun {
  const { CAL, nCal, cS } = env;
  const pos = new Map<string, Pos>();
  const pend = new Map<number, Map<string, number>>();
  const deferExit = new Map<number, Set<string>>();
  let cash = 1, prevV = 1;
  const out: RebalRun = { dates: [], ret: [], costFrac: [], nPos: [], inv: [], turn: [], trades: [], entryCs: [], wMax: [], haltSkip: 0, exitDefer: 0, nDefer: [], open: [], contrib: new Map(), endCash: 0 };
  const buyMultOf = (slip: number): number => (env.stockBuyMult * (1 + slip)) / (1 + env.baseSlip);
  const sellRateOf = (d: string, slip: number): number => 1 - ((1 - env.sellRate(d)) * (1 - slip)) / (1 - env.baseSlip);
  const val = (p: Pos): number => (p.rep ? p.repVal : p.shares * p.lastPx);
  const finish = (p: Pos, c: number, reason: string, proceeds: number, adjNow: number): void => {
    out.trades.push({ code: p.code, entryC: p.entryC, exitC: c, spend: p.spend, proceeds, vAtEntry: p.vAtEntry, reason, entryAdj: p.entryAdj, peakAdj: p.peak, exitAdj: adjNow, entryRaw: p.entryRaw });
    pos.delete(p.code);
  };
  for (let c = cS; c < nCal; c++) {
    const d = CAL[c];
    let costF = 0, buyN = 0, sellN = 0;
    // 1. 평가: 종가가 있는 날 갱신, 폐지 종목 처리
    for (const p of [...pos.values()]) {
      const i = p.s.idx.get(d);
      if (i !== undefined) {
        const px = p.s.close[i];
        if (p.rep) p.repVal *= 1 + (env.bhRet.get(d) ?? 0);
        else if (c > cS) { const e = out.contrib.get(p.code) ?? { pct: 0, days: 0 }; e.pct += (p.shares * (px - p.lastPx) / prevV) * 100; e.days++; out.contrib.set(p.code, e); }
        p.lastPx = px; p.peak = Math.max(p.peak, px);
      } else if (p.s.last < d && p.s.last < env.endedBefore) {
        const v = val(p);
        if (cfg.vanish === "last" || (cfg.vanish === "rule" && !(cfg.vanishLoss?.(p.code) ?? false))) { const sr = sellRateOf(d, cfg.slipOf(p.code, c)); cash += v * (1 - sr); costF += (v * sr) / prevV; sellN += v; finish(p, c, "폐지", v * (1 - sr) + p.realized, p.lastPx); }
        else finish(p, c, "폐지(전액 손실)", p.realized, p.lastPx);
      } else if (c > cS) { const e = out.contrib.get(p.code) ?? { pct: 0, days: 0 }; e.days++; out.contrib.set(p.code, e); }
    }
    // 2. 체결
    const tgt = pend.get(c), dfr = deferExit.get(c);
    if (tgt || dfr) {
      pend.delete(c); deferExit.delete(c);
      let V = cash;
      for (const p of pos.values()) V += val(p);
      const live = (p: SimS): number | undefined => { const i = p.idx.get(d); return i !== undefined && p.vol[i] > 0 ? i : undefined; };
      const want = new Map<string, number>(tgt ?? []);
      for (const code of dfr ?? []) want.set(code, 0);
      // 매도(목표 밖·초과)
      for (const p of [...pos.values()]) {
        const w = want.get(p.code);
        if (w === undefined && tgt) { want.set(p.code, 0); }
        if (!want.has(p.code)) continue;
        const targetV = (want.get(p.code) as number) * V, cur = val(p);
        if (!(cur > targetV + 1e-12)) continue;
        const full = targetV <= 1e-12;
        if (live(p.s) === undefined) { if (full) { out.exitDefer++; const nx = deferExit.get(c + 1) ?? new Set<string>(); nx.add(p.code); deferExit.set(c + 1, nx); } continue; }
        const amt = full ? cur : cur - targetV, sr = sellRateOf(d, cfg.slipOf(p.code, c)), net = amt * (1 - sr);
        cash += net; p.realized += net; sellN += amt; costF += (amt * sr) / prevV;
        if (p.rep) p.repVal -= amt; else p.shares = full ? 0 : p.shares * (1 - amt / cur);
        if (full) finish(p, c, tgt && tgt.has(p.code) ? "목표 0" : "순위 밖", p.realized, p.lastPx);
      }
      // 매수(부족)
      for (const [code, w] of want) {
        if (!(w > 0)) continue;
        const s = hooks.stockOf(code);
        if (!s) continue;
        const targetV = w * V, p0 = pos.get(code), cur = p0 ? val(p0) : 0;
        if (!(targetV > cur + 1e-12)) continue;
        const i = live(s);
        if (i === undefined) { if (!p0) out.haltSkip++; continue; }
        const slip = cfg.slipOf(code, c), bm = buyMultOf(slip), x = Math.min(targetV - cur, cash / bm);
        if (!(x > 1e-12)) continue;
        const outlay = x * bm, px = s.close[i];
        cash -= outlay; buyN += outlay; costF += (outlay - x) / prevV;
        if (p0) { if (p0.rep) p0.repVal += x; else p0.shares += x / px; p0.spend += outlay; p0.lastPx = px; }
        else {
          const rep = !!o.replace?.has(`${code}|${c}`);
          pos.set(code, { code, s, shares: x / px, lastPx: px, entryC: c, entryAdj: px, entryRaw: s.raw[i], peak: px, spend: outlay, vAtEntry: V, rep, repVal: x, realized: 0, held: 0 });
          out.entryCs.push(c);
        }
      }
    }
    // 3. 기록
    let V = cash, mx = 0;
    for (const p of pos.values()) { const v = val(p); V += v; if (v > mx) mx = v; }
    if (c > cS) {
      out.dates.push(d); out.ret.push((V / prevV - 1) * 100); out.costFrac.push(costF); out.nPos.push(pos.size); out.nDefer.push(deferExit.get(c + 1)?.size ?? 0); out.inv.push(V > 0 ? (V - cash) / V : 0);
      if (buyN + sellN > 1e-12) out.turn.push({ d, v: prevV > 0 ? (buyN + sellN) / 2 / prevV : 0 });
      if (o.detail) out.wMax.push(pos.size && V > 0 ? mx / V : Number.NaN);
    }
    // 4. 신호
    if (c + o.lag < nCal && hooks.isSignal(c)) pend.set(c + o.lag, hooks.targetsAt(c, new Set(pos.keys())));
    prevV = V;
    if (c === nCal - 1) out.endCash = V > 0 ? cash / V : 1;
  }
  for (const p of pos.values()) out.open.push({ code: p.code, entryC: p.entryC, exitC: nCal - 1, spend: p.spend, proceeds: val(p) + p.realized, vAtEntry: p.vAtEntry, reason: "기간 끝 평가", entryAdj: p.entryAdj, peakAdj: p.peak, exitAdj: p.lastPx, entryRaw: p.entryRaw });
  return out;
}

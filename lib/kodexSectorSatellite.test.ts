import { test } from "node:test";
import assert from "node:assert/strict";
import { applyKssShareAdjustments, computeKssSignal, isKssExcluded, monthEndMonthsBefore, prevOpenDayFromCalendar, rebalanceKssAccount, resolveKssPrevTradingDay, type KssStockSeries } from "@/lib/kodexSectorSatellite";

// 합성 데이터: 2026-03-31(모멘텀 시작) · 2026-08-31(끝) · 2026-09-30(신호일) 세 날짜만 있는 종목들.
const D = ["2026-03-31", "2026-08-31", "2026-09-30"];
function stock(p0: number, p1: number, mcap: number, avgTv = 1e9): KssStockSeries {
  return { dates: D, close: [p0, p1, p1], mcapEok: [mcap, mcap, mcap], avgTv: [avgTv, avgTv, avgTv] };
}

test("monthEndMonthsBefore는 달력 말일을 준다", () => {
  assert.equal(monthEndMonthsBefore("2026-09-30", 6), "2026-03-31");
  assert.equal(monthEndMonthsBefore("2026-09-30", 1), "2026-08-31");
  assert.equal(monthEndMonthsBefore("2026-03-31", 1), "2026-02-28");
  assert.equal(monthEndMonthsBefore("2010-06-30", 6), "2009-12-31");
});

test("제외 규칙(4c1557a)", () => {
  assert.equal(isKssExcluded("005935", "삼성전자우", "264"), true); // 우선주
  assert.equal(isKssExcluded("293940", "신한알파리츠", undefined), true);
  assert.equal(isKssExcluded("138040", "메리츠금융지주", "64992"), false); // 부분 일치 아님
  assert.equal(isKssExcluded("210980", "SK디앤디", "68122"), true); // 업종 681
  assert.equal(isKssExcluded("088980", "맥쿼리인프라", "64201"), true); // 명시 목록
  assert.equal(isKssExcluded("123450", "엔에이치스팩29호", undefined), true);
  assert.equal(isKssExcluded("005930", "삼성전자", "264"), false);
});

test("신호: 상위 업종·업종별 상위 종목·1% 정리·재분배", () => {
  const series = new Map<string, KssStockSeries>([
    // 업종 26: +50%, 시총 큰 두 종목 + 아주 작은 종목(정리 대상)
    ["000100", stock(100, 150, 1000)],
    ["000200", stock(100, 150, 900)],
    ["000300", stock(100, 150, 10)],
    // 업종 65: +20%
    ["000400", stock(100, 120, 300)],
    ["000500", stock(100, 120, 200)],
    // 업종 30: +10%
    ["000600", stock(100, 110, 400)],
    ["000700", stock(100, 110, 100)],
    // 업종 20: -10% (4위)
    ["000800", stock(100, 90, 800)],
    ["000900", stock(100, 90, 700)],
    // 업종 99: 한 종목뿐 → 유효 업종 아님
    ["001000", stock(100, 300, 50)],
    // 유동성 미달 → K200P 아님
    ["001100", stock(100, 500, 5000, 1e8)],
    // KOSDAQ → K200P 아님
    ["001200", stock(100, 500, 5000)],
  ]);
  const induty = new Map([["000100", "26"], ["000200", "26"], ["000300", "26"], ["000400", "65"], ["000500", "65"], ["000600", "30"], ["000700", "30"], ["000800", "20"], ["000900", "20"], ["001000", "99"], ["001100", "26"], ["001200", "26"]]);
  const kospi = new Set([...series.keys()].filter((c) => c !== "001200"));
  const sig = computeKssSignal({ signalDate: "2026-09-30", series, kospiCodes: kospi, names: new Map(), induty });
  assert.equal(sig.k200pCount, 10);
  assert.deepEqual(sig.sectorRanks.map((r) => r.sector), ["26", "65", "30", "20"]);
  assert.deepEqual(sig.topSectors, ["26", "65", "30"]);
  assert.ok(Math.abs(sig.sectorRanks[0].momentum - 0.5) < 1e-12);
  // 정리 전: 26 업종 3종목 + 65 2종목 + 30 2종목 = 7종목, 시총가중
  assert.equal(sig.preTrimHoldings.length, 7);
  const preTot = 1000 + 900 + 10 + 300 + 200 + 400 + 100;
  assert.ok(Math.abs(sig.preTrimHoldings.find((h) => h.code === "000100")!.weight - 1000 / preTot) < 1e-12);
  // 정리: 0.2 × 비중 < 1% (= 위성 내 5% 미만) → 000300(0.3%)만 빠짐(000700은 100/2910 = 3.4% → 빠짐)
  assert.deepEqual(sig.holdings.map((h) => h.code).sort(), ["000100", "000200", "000400", "000500", "000600"]);
  const keepTot = 1000 + 900 + 300 + 200 + 400;
  assert.ok(Math.abs(sig.holdings.find((h) => h.code === "000100")!.weight - 1000 / keepTot) < 1e-12);
  assert.ok(Math.abs(sig.holdings.reduce((a, h) => a + h.weight, 0) - 1) < 1e-12);
  assert.equal(sig.fallbackToEtf, false);
  assert.equal(sig.neutral, false);
});

test("신호: 모멘텀 시작 데이터가 없으면 K200P 전체 중립", () => {
  const s = (p: number, m: number): KssStockSeries => ({ dates: ["2026-09-30"], close: [p], mcapEok: [m], avgTv: [1e9] });
  const series = new Map([["000100", s(100, 900)], ["000200", s(100, 100)]]);
  const sig = computeKssSignal({ signalDate: "2026-09-30", series, kospiCodes: new Set(series.keys()), names: new Map(), induty: new Map([["000100", "26"], ["000200", "26"]]) });
  assert.equal(sig.neutral, true);
  assert.equal(sig.preTrimHoldings.length, 2);
  assert.deepEqual(sig.holdings.map((h) => h.code), ["000100", "000200"]);
});

test("리밸런싱: 반올림·30% 상한·잔액 069500·현금 음수 없음", () => {
  // 시드 100만, 위성 두 종목(비싼 종목 1주 = 계좌 40%)
  const res = rebalanceKssAccount(
    { cash: 1_000_000, etfShares: 0, holdings: new Map() },
    [{ code: "000660", weight: 0.6 }, { code: "005930", weight: 0.4 }],
    { etf: 100_000, stocks: new Map([["000660", 400_000], ["005930", 50_000]]) },
    "2026-10-01"
  );
  // 목표: 000660 round(1e6·0.2·0.6/4e5)=round(0.3)=0, 005930 round(1e6·0.2·0.4/5e4)=round(1.6)=2
  assert.equal(res.account.holdings.get("000660"), undefined);
  assert.equal(res.account.holdings.get("005930"), 2);
  assert.equal(res.capHit, false);
  assert.ok(res.account.cash >= 0);
  // 069500: 남은 현금 ÷ (가격 × 매수 배수)의 정수
  assert.equal(res.account.etfShares, 8);
  assert.ok(res.satelliteValue / res.valueAfter <= 0.3);
});

test("리밸런싱: 상한 발동 시 비싼 종목부터 1주씩", () => {
  const res = rebalanceKssAccount(
    { cash: 1_000_000, etfShares: 0, holdings: new Map() },
    [{ code: "A00000", weight: 1 }],
    { etf: 100_000, stocks: new Map([["A00000", 350_000]]) },
    "2026-10-01"
  );
  // round(1e6·0.2/3.5e5) = round(0.571) = 1주 = 35% > 30% → 0주로 축소
  assert.equal(res.capHit, true);
  assert.equal(res.account.holdings.size, 0);
  assert.equal(res.zeroSatellite, true);
});

test("리밸런싱: 가격 없는 목표 종목은 건너뛰고, 조정 이벤트는 구간 안만 반영", () => {
  const res = rebalanceKssAccount(
    { cash: 1_000_000, etfShares: 0, holdings: new Map() },
    [{ code: "000660", weight: 0.5 }, { code: "005930", weight: 0.5 }],
    { etf: 100_000, stocks: new Map([["005930", 50_000]]) },
    "2026-10-01"
  );
  assert.equal(res.account.holdings.get("005930"), 2); // round(1e6·0.2·0.5/5e4) = 2
  assert.equal(res.account.holdings.has("000660"), false);
  const adj = new Map([["005930", [{ eventDate: "2026-10-15", factor: 0.5 }, { eventDate: "2026-12-01", factor: 0.1 }]]]);
  assert.equal(applyKssShareAdjustments(new Map([["005930", 2]]), adj, "2026-10-01", "2026-11-02").get("005930"), 4);
});

// ---- 직전 거래일(캘린더 신년 교체 직후 포함) ----
const SEARCH = 10;
// 2027-01-02(토) 새벽 동기화로 캘린더가 "오늘부터 15개월치"로 통째로 교체된 직후의 표: 2027-01-01 이전 행이 없다.
const calendarAfterNewYearReplace = [
  { trade_date: "2027-01-02", is_open: false }, { trade_date: "2027-01-03", is_open: false },
  { trade_date: "2027-01-04", is_open: true }, { trade_date: "2027-01-05", is_open: true },
];

test("prevOpenDayFromCalendar: 같은 달 안이면 직전 개장일, 신년 교체 직후 1월 첫 거래일엔 null", () => {
  assert.equal(prevOpenDayFromCalendar(calendarAfterNewYearReplace, "2027-01-05", SEARCH), "2027-01-04");
  assert.equal(prevOpenDayFromCalendar(calendarAfterNewYearReplace, "2027-01-04", SEARCH), null);
  const mid = [{ trade_date: "2026-10-29", is_open: true }, { trade_date: "2026-10-30", is_open: true }, { trade_date: "2026-10-31", is_open: false }, { trade_date: "2026-11-01", is_open: false }];
  assert.equal(prevOpenDayFromCalendar(mid, "2026-11-02", SEARCH), "2026-10-30");
  assert.equal(prevOpenDayFromCalendar(mid, "2026-11-20", SEARCH), null); // 10일 범위 밖
});

test("resolveKssPrevTradingDay: 캘린더에 있으면 그대로(KRX 확인 없음)", async () => {
  let probes = 0;
  const r = await resolveKssPrevTradingDay("2026-11-02", { calendarPrev: "2026-10-30", hotLatestBeforeToday: "2026-10-29", hasKrxData: async () => { probes++; return true; }, searchDays: SEARCH });
  assert.deepEqual([r.date, r.source, probes], ["2026-10-30", "calendar", 0]);
});

test("resolveKssPrevTradingDay: 신년 교체 직후(캘린더 null) — hot 표는 12-29까지라 하루 뒤처짐, KRX 확인으로 12-30을 고른다", async () => {
  const prev = prevOpenDayFromCalendar(calendarAfterNewYearReplace, "2027-01-04", SEARCH);
  const krxOpen = new Set(["2026-12-29", "2026-12-30"]); // 12-31(연말 휴장)·1-1(공휴일)은 자료 없음
  const probed: string[] = [];
  const r = await resolveKssPrevTradingDay("2027-01-04", { calendarPrev: prev, hotLatestBeforeToday: "2026-12-29", hasKrxData: async (d) => { probed.push(d); return krxOpen.has(d); }, searchDays: SEARCH });
  assert.equal(r.date, "2026-12-30");
  assert.equal(r.source, "hot-fallback");
  assert.deepEqual(probed, ["2027-01-01", "2026-12-31", "2026-12-30"]); // 최근 평일부터, 주말(1-2·1-3) 건너뜀
  assert.match(r.note, /폴백|캘린더에 직전 거래일 없음/);
});

test("resolveKssPrevTradingDay: hot 표가 이미 직전 거래일까지 채워졌으면 그 날짜, hot 표가 비면 null", async () => {
  const none = async () => false;
  const a = await resolveKssPrevTradingDay("2027-01-04", { calendarPrev: null, hotLatestBeforeToday: "2026-12-30", hasKrxData: none, searchDays: SEARCH });
  assert.deepEqual([a.date, a.source], ["2026-12-30", "hot-fallback"]);
  const b = await resolveKssPrevTradingDay("2027-01-04", { calendarPrev: null, hotLatestBeforeToday: null, hasKrxData: none, searchDays: SEARCH });
  assert.deepEqual([b.date, b.source], [null, "none"]);
});

test("resolveKssPrevTradingDay: 확인하는 평일은 searchDays 안으로 제한된다", async () => {
  let probes = 0;
  const r = await resolveKssPrevTradingDay("2027-01-20", { calendarPrev: null, hotLatestBeforeToday: "2026-12-01", hasKrxData: async () => { probes++; return false; }, searchDays: 5 });
  assert.equal(r.date, "2026-12-01");
  assert.ok(probes <= 5);
});

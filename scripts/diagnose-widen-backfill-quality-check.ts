/**
 * 디스포저블 진단: 전종목 확장 재백필(#413) 2015~2026 확장 각 단계 후 소형주
 * 데이터 품질을 확인한다. 대형주 표본 대조(diagnose-widen-backfill-safety-check.ts)는
 * 이미 마쳤으므로, 새로 늘어난 소형주 쪽 통계만 본다. 쓰기 없음(순수 조회).
 *
 * 확인 항목:
 * 1. 연도별 종목 수 / 행 수 / 거래일당 평균 종목 수
 * 2. 필드별 결측률(종가, 거래량, 거래대금, 상장주식수) — NaN/undefined만 결측으로 집계
 * 3. 거래정지일(거래량=0) 비율
 * 4. 중복 행(같은 종목·날짜) 개수
 * 5. 이 연도에서 사라진 종목(다음 연도 데이터가 없는 종목) 수 + 샘플 3개, 마지막 거래일
 * 6. 전일 종가 대비 ±30% 초과 변동 행 수(권리 이벤트 후보, 개수만 기록)
 *
 * 실행: YEARS="2024,2025,2026" npm run diagnose:widen-backfill-quality-check
 */

import { downloadYearPrices, type StockDailyPriceRow } from "@/lib/stockDailyPricesStorage";

function isMissing(value: number | undefined | null): boolean {
  return value === undefined || value === null || !Number.isFinite(value);
}

async function checkYear(year: number, nextYearCodes: Set<string> | null): Promise<Set<string>> {
  const rows = await downloadYearPrices(year);
  console.log(`\n=== ${year}년 ===`);

  if (rows.length === 0) {
    console.log("행 없음");
    return new Set();
  }

  const codes = new Set(rows.map((r) => r.stockCode));
  const tradeDates = new Set(rows.map((r) => r.tradeDate));
  console.log(`종목 수: ${codes.size}, 행 수: ${rows.length}, 거래일수: ${tradeDates.size}, 거래일당 평균 종목 수: ${(rows.length / tradeDates.size).toFixed(1)}`);

  let missingClose = 0;
  let missingVolume = 0;
  let missingTradingValue = 0;
  let missingListedShares = 0;
  let haltedVolumeZero = 0;
  for (const r of rows) {
    if (isMissing(r.closePrice)) missingClose++;
    if (isMissing(r.volume)) missingVolume++;
    else if (r.volume === 0) haltedVolumeZero++;
    if (isMissing(r.tradingValue)) missingTradingValue++;
    if (isMissing(r.listedShares)) missingListedShares++;
  }
  const pct = (n: number) => `${((n / rows.length) * 100).toFixed(3)}%`;
  console.log(
    `결측률 — 종가: ${pct(missingClose)}, 거래량: ${pct(missingVolume)}, 거래대금: ${pct(missingTradingValue)}, 상장주식수: ${pct(missingListedShares)}`
  );
  console.log(`거래량=0(거래정지 후보): ${haltedVolumeZero}건 (${pct(haltedVolumeZero)}) — 별도 처리 없이 그대로 저장됨`);

  const seen = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.stockCode}:${r.tradeDate}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicateKeys = Array.from(seen.values()).filter((n) => n > 1).length;
  console.log(`중복 행(같은 종목·날짜) 키 개수: ${duplicateKeys}`);

  if (nextYearCodes) {
    const disappeared: { code: string; lastDate: string }[] = [];
    const lastDateByCode = new Map<string, string>();
    for (const r of rows) {
      const cur = lastDateByCode.get(r.stockCode);
      if (!cur || r.tradeDate > cur) lastDateByCode.set(r.stockCode, r.tradeDate);
    }
    for (const [code, lastDate] of lastDateByCode) {
      if (!nextYearCodes.has(code)) disappeared.push({ code, lastDate });
    }
    console.log(`${year}년에만 있고 다음 해엔 없는 종목(상장폐지 후보): ${disappeared.length}개`);
    for (const sample of disappeared.slice(0, 3)) {
      console.log(`  샘플: ${sample.code}, 마지막 거래일 ${sample.lastDate}`);
    }
  } else {
    console.log("상장폐지 후보 확인 생략(다음 해 데이터 없음 — 범위의 마지막 연도)");
  }

  const byCode = new Map<string, StockDailyPriceRow[]>();
  for (const r of rows) {
    const arr = byCode.get(r.stockCode);
    if (arr) arr.push(r);
    else byCode.set(r.stockCode, [r]);
  }
  let bigSwingCount = 0;
  for (const codeRows of byCode.values()) {
    codeRows.sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
    for (let i = 1; i < codeRows.length; i++) {
      const prev = codeRows[i - 1].closePrice;
      const cur = codeRows[i].closePrice;
      if (!prev || isMissing(prev) || isMissing(cur)) continue;
      const changePct = Math.abs((cur - prev) / prev) * 100;
      if (changePct >= 30) bigSwingCount++;
    }
  }
  console.log(`전일 종가 대비 ±30% 초과 변동 행 수: ${bigSwingCount}건 (권리 이벤트 후보, 다음 단계용 기록만)`);

  return codes;
}

async function main(): Promise<void> {
  const yearsEnv = process.env.YEARS;
  if (!yearsEnv) throw new Error('YEARS="2024,2025,2026" 형태로 실행하세요.');
  const years = yearsEnv.split(",").map((s) => Number(s.trim())).sort((a, b) => a - b);

  let nextYearCodes: Set<string> | null = null;
  for (let i = years.length - 1; i >= 0; i--) {
    const year = years[i];
    const codes = await checkYear(year, nextYearCodes);
    nextYearCodes = codes;
  }
}

main().catch((error) => {
  console.error("진단 중 오류:", error);
  process.exit(1);
});

/**
 * (임시) DH전략 Parquet/Storage 이전 스모크 테스트 — 하루치(005930 등 일부 종목)만
 * 실제로 KRX에서 받아 Parquet로 만들어 Storage에 업로드하고, 다시 다운로드해서
 * 파싱까지 정상 동작하는지 확인한다. 전체 15년 백필 전에 파이프라인 자체가 실제
 * Supabase Storage에서 동작하는지 먼저 확인하는 용도. 확인 후 삭제 예정.
 *
 *   tsx --conditions=react-server scripts/verify-valuation-005930.ts
 */

import { uploadYearPrices, yearPricesExist, getDailyPrice, discoverCandidateStockCodes } from "@/lib/dhDailyPricesStorage";
import { DH_BACKFILL_MARKET_CAP_FLOOR_EOK } from "@/lib/dhStrategyConfig";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const TEST_YEAR = 9999; // 실제 연도와 안 겹치게 테스트 전용 연도 사용, 끝나면 정리

interface KrxTradeRow {
  ISU_CD: string;
  TDD_CLSPRC: string;
  MKTCAP: string;
  LIST_SHRS: string;
}

async function fetchKrxDaily(endpoint: "stk_bydd_trd" | "ksq_bydd_trd", basDd: string, apiKey: string): Promise<KrxTradeRow[]> {
  const res = await fetch(`https://data-dbg.krx.co.kr/svc/apis/sto/${endpoint}?basDd=${basDd}`, {
    headers: { AUTH_KEY: apiKey },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { OutBlock_1?: KrxTradeRow[] };
  return body.OutBlock_1 ?? [];
}

async function main(): Promise<void> {
  const apiKey = process.env.KRX_API_KEY;
  if (!apiKey) throw new Error("KRX_API_KEY 환경 변수가 없습니다.");

  console.log("1) 버킷에 아직 테스트 연도 파일 없는지 확인:", await yearPricesExist(TEST_YEAR));

  console.log("2) KRX에서 실제 하루치(2026-08-25) 받아오기...");
  const [kospi, kosdaq] = await Promise.all([
    fetchKrxDaily("stk_bydd_trd", "20260825", apiKey),
    fetchKrxDaily("ksq_bydd_trd", "20260825", apiKey),
  ]);
  console.log(`받은 행: 코스피 ${kospi.length}, 코스닥 ${kosdaq.length}`);

  const rows = [...kospi, ...kosdaq]
    .filter((r) => r.ISU_CD && r.TDD_CLSPRC && r.TDD_CLSPRC !== "-" && r.LIST_SHRS && r.LIST_SHRS !== "-")
    .map((r) => ({
      stockCode: r.ISU_CD,
      tradeDate: "9999-01-01", // 테스트 전용 날짜
      closePrice: Number(r.TDD_CLSPRC),
      marketCapEok: Number(r.MKTCAP) / 100_000_000,
      listedShares: Number(r.LIST_SHRS),
    }))
    .filter((r) => r.marketCapEok >= DH_BACKFILL_MARKET_CAP_FLOOR_EOK);

  console.log(`필터 후(시가총액 ${DH_BACKFILL_MARKET_CAP_FLOOR_EOK}억원 이상) 저장 대상: ${rows.length}행`);

  console.log("3) Parquet로 만들어 Storage에 업로드...");
  await uploadYearPrices(TEST_YEAR, rows);
  console.log("업로드 완료");

  console.log("4) 방금 올린 파일이 존재하는지 확인:", await yearPricesExist(TEST_YEAR));

  console.log("5) 005930을 다시 다운로드+파싱해서 조회...");
  const samsung = await getDailyPrice("005930", "9999-01-01");
  console.log("005930 조회 결과:", JSON.stringify(samsung));

  console.log("6) discoverCandidateStockCodes로 후보종목 발굴 테스트...");
  const candidates = await discoverCandidateStockCodes([TEST_YEAR], 10_000);
  console.log(`시가총액 1조원 이상 후보종목 수: ${candidates.length}, 005930 포함 여부: ${candidates.includes("005930")}`);

  console.log("7) 테스트 파일 정리...");
  const { error: removeError } = await supabaseAdmin.storage.from("dh-daily-prices").remove([`${TEST_YEAR}.parquet`]);
  if (removeError) console.error("테스트 파일 삭제 실패:", removeError.message);
  else console.log("테스트 파일 삭제 완료");
}

main().catch((error) => {
  console.error("확인 중 오류:", error);
  process.exit(1);
});

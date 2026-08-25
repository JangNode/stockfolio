import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import type { BacktestTrade } from "@/lib/backtest";

// custom_backtest_runs 표는 요약 통계만 담고, 무거운 원본 결과(매칭 종목별 거래 내역
// 전체)는 이 버킷에 JSON으로 저장한다. 비공개 버킷이라 service_role로만 접근한다.
const BUCKET = "custom-backtest-results";

export interface CustomBacktestMatchedStock {
  stockCode: string;
  stockName: string;
  trades: BacktestTrade[];
  totalReturnPct: number;
  tradeCount: number;
  winRate: number;
}

export interface CustomBacktestResultPayload {
  matchedStocks: CustomBacktestMatchedStock[];
}

function objectPath(runId: string): string {
  return `${runId}.json`;
}

/** 백테스트 결과 전체를 버킷에 업로드하고, custom_backtest_runs.result_storage_path에 저장할 경로를 반환한다. */
export async function uploadCustomBacktestResult(
  runId: string,
  payload: CustomBacktestResultPayload
): Promise<string> {
  const path = objectPath(runId);
  const { error } = await supabaseAdmin.storage.from(BUCKET).upload(path, JSON.stringify(payload), {
    contentType: "application/json",
    upsert: true,
  });
  if (error) throw new Error(`백테스트 결과 업로드 실패(${runId}): ${error.message}`);
  return path;
}

/** result_storage_path에 저장된 경로로 결과 전체를 내려받는다. */
export async function downloadCustomBacktestResult(path: string): Promise<CustomBacktestResultPayload> {
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(path);
  if (error) throw new Error(`백테스트 결과 다운로드 실패(${path}): ${error.message}`);
  const text = await data.text();
  return JSON.parse(text) as CustomBacktestResultPayload;
}

/** 보관 기간이 지난(미채택) 백테스트 결과를 정리할 때 쓴다. */
export async function deleteCustomBacktestResult(path: string): Promise<void> {
  const { error } = await supabaseAdmin.storage.from(BUCKET).remove([path]);
  if (error) throw new Error(`백테스트 결과 삭제 실패(${path}): ${error.message}`);
}

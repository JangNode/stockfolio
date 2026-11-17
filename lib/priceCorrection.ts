// 연구용 가격 보정 덮어쓰기(K200P 미조정 오류 17건). 기본 미적용 — 환경 변수 PRICE_CORRECTION=k200p17일 때만 적용한다.
// 규칙: docs/research/k200p-correction-prereg.md (사전등록 7974b48). 기존 스냅샷·Parquet은 고치지 않고, 읽어 온 메모리 안의 수정 시세에만 덮어쓴다.
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET } from "@/lib/investorFlowConfig";

export const PRICE_CORRECTION_ID = "k200p17";
/** 덮어쓰기 표를 저장하는 Supabase Storage 경로(research/ 아래, 저장소·artifact에는 올리지 않음). */
export const PRICE_CORRECTION_PATH = "research/corrections/k200p17-overrides.json";
export const PRICE_CORRECTION_ON = (process.env.PRICE_CORRECTION ?? "").trim() === PRICE_CORRECTION_ID;
if ((process.env.PRICE_CORRECTION ?? "").trim() !== "" && !PRICE_CORRECTION_ON) throw new Error(`PRICE_CORRECTION은 비우거나 ${PRICE_CORRECTION_ID}만 허용한다`);

export interface PriceOverride { code: string; date: string; ret: number; kind: "확인" | "미확인"; krxFluc: number | null; oldRet: number }
export interface PriceOverrideFile { version: number; createdAt: string; rows: PriceOverride[] }

export async function loadPriceOverrides(): Promise<PriceOverride[]> {
  const { data, error } = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).download(PRICE_CORRECTION_PATH);
  if (error || !data) throw new Error(`가격 보정 표를 읽지 못했다(${PRICE_CORRECTION_PATH}): ${error?.message ?? "없음"}`);
  const f = JSON.parse(await data.text()) as PriceOverrideFile;
  if (!Array.isArray(f.rows) || f.rows.length === 0) throw new Error("가격 보정 표가 비어 있다");
  return f.rows;
}

export interface AdjPriceRow { tradeDate: string; openPrice: number; highPrice: number; lowPrice: number; closePrice: number }
/**
 * 해당 날짜의 수정 종가 수익률이 ret이 되도록 그날 이전 모든 행의 수정 시가·고가·저가·종가에 같은 계수를 곱한다(분할 조정과 같은 방식).
 * 이벤트일 이후 가격·원 종가·거래량·시총은 그대로. 행이나 직전 행이 없으면 던진다. 반환: 곱한 계수.
 */
export function applyReturnOverride(rows: AdjPriceRow[], date: string, ret: number): number {
  const i = rows.findIndex((r) => r.tradeDate === date);
  if (i < 1) throw new Error(`보정 대상 행 없음: ${date}`);
  if (!(rows[i].closePrice > 0 && rows[i - 1].closePrice > 0)) throw new Error(`보정 대상 종가가 올바르지 않다: ${date}`);
  const f = rows[i].closePrice / (1 + ret) / rows[i - 1].closePrice;
  for (let k = 0; k < i; k++) { rows[k].openPrice *= f; rows[k].highPrice *= f; rows[k].lowPrice *= f; rows[k].closePrice *= f; }
  return f;
}

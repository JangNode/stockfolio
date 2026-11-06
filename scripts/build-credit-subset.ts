/**
 * [임시 연구 — 병합 금지] 신호 스캔 5회차 신용잔고 정리본 한 번 읽기(약 20.6 MiB, 2011~2019 연도 파일): Storage `research/credit_balance_clean/YYYY.parquet`을 바이트 그대로 받아
 * .scan5-credit-inputs에 저장하고 SHA-256 매니페스트를 만든다(워크플로가 Actions 캐시·아티팩트로 저장). 신호·통계 계산 없음, DB·Storage 쓰기 0, 외부 요청 0, DART 0.
 * 신용잔고는 사전등록 6절에 따라 후보가 나온 스캔 행의 중복 점검에만 쓴다(후보가 없으면 읽기만 하고 계산하지 않는다).
 */
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { INVESTOR_FLOW_STOCK_STORE_BUCKET } from "@/lib/investorFlowConfig";
import { S5_CREDIT_CLEAN_PREFIX, S5_CREDIT_YEAR_FROM, S5_CREDIT_YEAR_TO, S5_CACHE_DIR_CREDIT } from "@/lib/scan5Config";

async function main(): Promise<void> {
  console.log(`신용잔고 정리본 한 번 읽기 시작: ${new Date().toISOString()} (${S5_CREDIT_CLEAN_PREFIX} ${S5_CREDIT_YEAR_FROM}~${S5_CREDIT_YEAR_TO})`);
  await fsp.mkdir(S5_CACHE_DIR_CREDIT, { recursive: true });
  const files: { path: string; bytes: number; sha256: string }[] = [];
  let total = 0;
  for (let y = S5_CREDIT_YEAR_FROM; y <= S5_CREDIT_YEAR_TO; y++) {
    const { data, error } = await supabaseAdmin.storage.from(INVESTOR_FLOW_STOCK_STORE_BUCKET).download(`${S5_CREDIT_CLEAN_PREFIX}/${y}.parquet`);
    if (error || !data) throw new Error(`${y}.parquet 읽기 실패: ${error?.message ?? "없음"}`);
    const buf = Buffer.from(await data.arrayBuffer());
    await fsp.writeFile(path.join(S5_CACHE_DIR_CREDIT, `${y}.parquet`), buf);
    files.push({ path: `${y}.parquet`, bytes: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex") });
    total += buf.byteLength;
    console.log(`  ${y}.parquet ${(buf.byteLength / 1048576).toFixed(2)} MiB`);
  }
  await fsp.writeFile(path.join(S5_CACHE_DIR_CREDIT, "manifest.json"), JSON.stringify({ createdAt: new Date().toISOString(), files }, null, 1));
  console.log(`Storage 읽기 합계 ${(total / 1048576).toFixed(2)} MiB(${files.length}개 파일) | Storage 쓰기 0 | DB 쓰기 0 | 외부 요청 0 | DART 호출 0 | 신호·통계 계산 없음`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });

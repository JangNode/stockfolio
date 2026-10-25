// 진단(읽기 전용, 임시): 연도별 시세 Parquet의 최종 수정 시각·마지막 거래일·읽기 가능 여부를 확인한다.
// Storage 쓰기·DB 쓰기 없음. 파일은 서명 URL로 푸터(메타데이터)와 trade_date 열만 범위 요청으로 읽는다.
import { parquetMetadataAsync, parquetReadObjects, type AsyncBuffer } from "hyparquet";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getLatestRecentPriceDate } from "@/lib/stockDailyPricesStorage";
import { getLatestIndexPriceDate } from "@/lib/betaPriceHistoryStorage";

const BUCKET = "stock-daily-prices";
const YEARS = (process.env.YEARS ?? "2026").split(",").map((s) => s.trim()).filter(Boolean);

async function main(): Promise<void> {
  const { data: listed, error: listErr } = await supabaseAdmin.storage.from(BUCKET).list("", { limit: 100, sortBy: { column: "name", order: "asc" } });
  if (listErr) throw new Error(`Storage 목록 조회 실패: ${listErr.message}`);
  console.log("=== Storage 연도 파일(수정 시각·크기) ===");
  for (const f of listed ?? []) {
    if (!/^\d{4}\.parquet$/.test(f.name)) continue;
    const size = (f.metadata as { size?: number } | null)?.size;
    console.log(`${f.name} | updated_at=${f.updated_at} | created_at=${f.created_at} | size=${size ?? "?"}`);
  }

  for (const year of YEARS) {
    const path = `${year}.parquet`;
    console.log(`\n=== ${path} 헤더 조회 ===`);
    const { data: signed, error: signErr } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, 120);
    if (signErr || !signed) { console.log(`서명 URL 실패: ${signErr?.message ?? "없음"} — 읽기 불가`); continue; }
    const url = signed.signedUrl;
    let bytes = 0, requests = 0;
    const head = await fetch(url, { method: "HEAD" });
    const byteLength = Number(head.headers.get("content-length") ?? 0);
    console.log(`HEAD status=${head.status} content-length=${byteLength} last-modified=${head.headers.get("last-modified") ?? "?"}`);
    if (!head.ok || !byteLength) { console.log("HEAD 실패 — 읽기 불가"); continue; }
    const file: AsyncBuffer = {
      byteLength,
      slice: async (start: number, end?: number) => {
        const last = (end ?? byteLength) - 1;
        const res = await fetch(url, { headers: { Range: `bytes=${start}-${last}` } });
        if (!res.ok && res.status !== 206) throw new Error(`범위 요청 실패 status=${res.status}`);
        const buf = await res.arrayBuffer();
        bytes += buf.byteLength; requests++;
        return buf;
      },
    };
    const meta = await parquetMetadataAsync(file);
    console.log(`행 수=${meta.num_rows}, 행 그룹=${meta.row_groups.length}, 푸터 읽기 바이트=${bytes}(${requests}회)`);
    let statMax: string | null = null, statMin: string | null = null;
    for (const rg of meta.row_groups) {
      for (const col of rg.columns) {
        if (col.meta_data?.path_in_schema?.join(".") !== "trade_date") continue;
        const mx = col.meta_data.statistics?.max_value, mn = col.meta_data.statistics?.min_value;
        if (typeof mx === "string" && (statMax === null || mx > statMax)) statMax = mx;
        if (typeof mn === "string" && (statMin === null || mn < statMin)) statMin = mn;
      }
    }
    console.log(`통계 기준 trade_date 최소=${statMin ?? "없음"} 최대=${statMax ?? "없음"}`);
    const before = bytes;
    const rows = (await parquetReadObjects({ file, metadata: meta, columns: ["trade_date"] })) as { trade_date: string }[];
    const perDate = new Map<string, number>();
    for (const r of rows) perDate.set(r.trade_date, (perDate.get(r.trade_date) ?? 0) + 1);
    const dates = [...perDate.keys()].sort();
    console.log(`trade_date 열 읽기 바이트=${bytes - before}, 서로 다른 날짜 ${dates.length}개, 마지막 날짜=${dates[dates.length - 1]}`);
    console.log(`마지막 8개 날짜별 행 수: ${dates.slice(-8).map((d) => `${d}=${perDate.get(d)}`).join(", ")}`);
    console.log(`총 읽은 바이트=${bytes}(${requests}회 범위 요청)`);
  }

  console.log("\n=== 다른 저장소 최신 날짜 ===");
  console.log(`stock_daily_prices_recent 최신 거래일: ${await getLatestRecentPriceDate()}`);
  console.log(`beta_price_history KOSPI 최신 거래일: ${await getLatestIndexPriceDate("KOSPI")}`);
  console.log(`beta_price_history KOSDAQ 최신 거래일: ${await getLatestIndexPriceDate("KOSDAQ")}`);
}

main().catch((e) => { console.error("진단 실패:", e instanceof Error ? e.message : e); process.exit(1); });

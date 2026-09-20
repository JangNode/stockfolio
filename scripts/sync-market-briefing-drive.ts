/**
 * Cowork가 매일 아침 만드는 시장 브리핑 JSON을 Google Drive 폴더 폴링으로 수집하는
 * 배치. 원래는 웹훅(app/api/cowork-briefing/route.ts)으로 받았으나, Cowork를 실행하는
 * 샌드박스가 네트워크 정책상 임의 도메인으로 나갈 수 없어 웹훅 방식이 영구히
 * 불가능하다는 게 확인됐다. 대신 Cowork가 지정된 Drive 폴더에 브리핑 파일을
 * 저장해두면, 이 배치가 매일 그 폴더에서 가장 최근 파일을 가져와 저장한다.
 *
 * server-only로 막힌 lib/marketBriefingStorage.ts, lib/supabaseAdmin.ts를 순수
 * Node 스크립트에서도 그대로 재사용하기 위해 "react-server" 조건으로 실행해야 한다:
 *   tsx --conditions=react-server scripts/sync-market-briefing-drive.ts
 * (package.json의 sync:market-briefing-drive 스크립트가 이 플래그를 포함한다.)
 *
 * 폴더 ID로 "'<id>' in parents" 필터링을 시도했으나, 서비스 계정이 폴더 안의
 * 파일 자체는 볼 수 있어도(공유 전파 방식 때문으로 추정) 폴더 객체를 직접 ID로
 * 참조하거나 그 폴더를 부모로 지정한 조회는 계속 404("File not found")가
 * 나는 게 실제 Drive API 응답으로 확인됐다(2026-09-15 진단). 그래서 폴더
 * 필터링 없이, 이 서비스 계정에게 공유된 파일 전체 중 최근 수정된 파일을
 * 그대로 가져오는 방식으로 바꿨다 — 이 서비스 계정은 이 용도로만 새로 만든
 * 전용 계정이라 다른 파일이 섞일 위험이 없다.
 *
 * 필요 환경변수:
 *   GOOGLE_SERVICE_ACCOUNT_KEY  서비스 계정 JSON을 base64로 인코딩한 문자열
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { google } from "googleapis";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { upsertMarketBriefing, deleteOldMarketBriefings } from "@/lib/marketBriefingStorage";
import { todayKstDateString, toKstDateString } from "@/lib/formatKst";

const DATE_KST_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** report_date와 이 배치 실행 시점(KST 기준 오늘)의 날짜 차이(일). report_date는
 * "이 브리핑이 다루는 미국 거래일"을 가리켜, 미국 정규장 마감이 KST로는 다음날
 * 새벽~아침이라 정상적으로도 배치 실행일보다 하루(-1일) 이른 게 보통이다(실측
 * 확인, 2026-09-17). 그 이상 벌어지면 report_date가 잘못 찍혔을 가능성을 의심할
 * 신호라 경고만 남긴다 — DART 백필 이상 감지(scripts/backfill-stock-annual-fundamentals.ts)와
 * 같은 패턴으로 저장을 막지는 않고 로그로만 추적 가능하게 한다. */
function daysFromToday(dateKst: string): number {
  return Math.round((Date.parse(todayKstDateString()) - Date.parse(dateKst)) / ONE_DAY_MS);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

interface ShapeIssue {
  field: string;
  reason: string;
}

/**
 * report_date 검증을 통과한 뒤, 핵심 필드(summary/indices/macro_issues/stock_movers)가
 * 기대한 타입인지 확인한다. Cowork 쪽 출력 스키마가 날마다 흔들리는 게 실측 확인됐다
 * (영어 미번역·스키마 변경·손상 파일, 2026-09-18) — 화면 렌더러(MarketBriefingSection.tsx)엔
 * 이미 타입 가드가 있어 이 검증 없이도 대부분 조용히 그 항목만 빠지지만, 저장 전에
 * 명백히 깨진 데이터를 걸러 로그로 추적 가능하게 하는 게 이 함수의 목적이다.
 * Cowork 스키마가 아직 진화 중이라 모든 필드를 optional로 취급한다 — 필드 자체가
 * 없는 건 정상이고, "있는데 타입이 틀린" 경우만 문제로 본다.
 *
 * 실제 구조(2026-09-20 원본 파일로 확인): indices.{us,europe,asia}는 지수명을 키로
 * 갖는 객체(배열 아님), stock_movers.{us_daily,us_weekly,korea}는 배열이고 각 항목의
 * ticker/change_pct는 null이 정상 케이스라 여기서 타입을 강제하지 않는다.
 */
function validateBriefingShape(parsed: Record<string, unknown>): ShapeIssue[] {
  const issues: ShapeIssue[] = [];

  if (parsed.summary !== undefined && !Array.isArray(parsed.summary)) {
    issues.push({ field: "summary", reason: `배열이 아님(실제 타입: ${describeType(parsed.summary)})` });
  }

  const indices = parsed.indices;
  if (indices !== undefined) {
    if (!isPlainObject(indices)) {
      issues.push({ field: "indices", reason: `객체가 아님(실제 타입: ${describeType(indices)})` });
    } else {
      for (const region of ["us", "europe", "asia"] as const) {
        const group = indices[region];
        if (group === undefined) continue;
        if (!isPlainObject(group)) {
          issues.push({ field: `indices.${region}`, reason: `객체가 아님(실제 타입: ${describeType(group)})` });
          continue;
        }
        for (const [indexKey, indexValue] of Object.entries(group)) {
          if (!isPlainObject(indexValue)) {
            issues.push({
              field: `indices.${region}.${indexKey}`,
              reason: `객체가 아님(실제 타입: ${describeType(indexValue)})`,
            });
          }
        }
      }
    }
  }

  const macroIssues = parsed.macro_issues;
  if (macroIssues !== undefined) {
    if (!Array.isArray(macroIssues)) {
      issues.push({ field: "macro_issues", reason: `배열이 아님(실제 타입: ${describeType(macroIssues)})` });
    } else {
      macroIssues.forEach((item, i) => {
        if (!isPlainObject(item)) {
          issues.push({ field: `macro_issues[${i}]`, reason: `객체가 아님(실제 타입: ${describeType(item)})` });
        }
      });
    }
  }

  const stockMovers = parsed.stock_movers;
  if (stockMovers !== undefined) {
    if (!isPlainObject(stockMovers)) {
      issues.push({ field: "stock_movers", reason: `객체가 아님(실제 타입: ${describeType(stockMovers)})` });
    } else {
      for (const group of ["us_daily", "us_weekly", "korea"] as const) {
        const items = stockMovers[group];
        if (items === undefined) continue;
        if (!Array.isArray(items)) {
          issues.push({ field: `stock_movers.${group}`, reason: `배열이 아님(실제 타입: ${describeType(items)})` });
          continue;
        }
        items.forEach((item, i) => {
          if (!isPlainObject(item)) {
            issues.push({
              field: `stock_movers.${group}[${i}]`,
              reason: `객체가 아님(실제 타입: ${describeType(item)})`,
            });
          }
        });
      }
    }
  }

  return issues;
}

/**
 * market_briefings에 가장 최근 저장된 시각(created_at, 실제 저장 시각이라
 * report_date와 달리 Cowork 쪽에서 잘못 찍힐 위험이 없다)을 확인해, 정상적인
 * 하루 지연(어제자 데이터가 오늘 아침 배치에서 들어오는 정상 패턴 — 날짜/시각
 * 표기 정리 단계에서 실측 확인)보다 더 벌어져 있으면 경고한다. 새 테이블 없이
 * 기존 컬럼만으로 계산한다.
 */
async function warnIfBriefingStale(): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("market_briefings")
    .select("created_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("최근 브리핑 저장 시각 조회 실패:", error.message);
    return;
  }

  if (!data) {
    console.warn("market_briefings에 저장된 행이 아직 없습니다 — 최초 실행이거나 전체 데이터가 비어 있습니다.");
    return;
  }

  const lastSavedDate = toKstDateString(data.created_at);
  const today = todayKstDateString();
  const daysSinceLastSave = Math.round((Date.parse(today) - Date.parse(lastSavedDate)) / ONE_DAY_MS);

  // 정상 패턴: 어제자 브리핑이 오늘 아침 배치에서 저장돼, 오늘 이 배치가 시작되는
  // 시점엔 "최근 저장"이 항상 어제(1일 전)다 — 2일 이상 벌어지면 그 사이 최소
  // 한 번의 실행이 아무것도 저장하지 못했다는 뜻이다.
  if (daysSinceLastSave >= 2) {
    const missedRuns = daysSinceLastSave - 1;
    console.error(
      `시장 브리핑이 ${missedRuns}일째 연속 미수신입니다(마지막 저장: ${lastSavedDate}, 오늘: ${today}).`,
    );
  } else {
    console.log(`최근 저장: ${lastSavedDate} — 정상 범위입니다.`);
  }
}

function getServiceAccountCredentials(): Record<string, unknown> {
  const encoded = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!encoded) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY 환경변수가 설정되지 않았습니다.");
  }

  const decoded = Buffer.from(encoded, "base64").toString("utf-8");
  try {
    return JSON.parse(decoded);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY를 base64 디코드 후 JSON으로 파싱하는 데 실패했습니다.");
  }
}

async function main(): Promise<void> {
  await warnIfBriefingStale();

  const credentials = getServiceAccountCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    // 이 배치는 Drive에 쓰기 작업을 전혀 하지 않으므로 읽기 전용 스코프만 요청한다.
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  const drive = google.drive({ version: "v3", auth });

  // 폴더를 부모로 지정한 필터링은 쓰지 않는다(위 주석 참고) — 이 서비스 계정에게
  // 공유된 파일(폴더 제외) 전체 중 가장 최근 수정된 것 하나를 그대로 가져온다.
  const listRes = await drive.files.list({
    q: "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
    orderBy: "modifiedTime desc",
    pageSize: 1,
    fields: "files(id, name, mimeType, modifiedTime)",
    corpora: "allDrives",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const files = listRes.data.files ?? [];
  if (files.length === 0) {
    console.log("서비스 계정에게 공유된 파일이 없습니다 — 스킵");
    return;
  }

  const file = files[0];
  const fileId = file.id;
  const fileName = file.name ?? "(이름 없음)";
  if (!fileId) {
    throw new Error(`Drive 파일 목록 응답에 file id가 없습니다: ${fileName}`);
  }

  console.log(`최근 파일 발견: ${fileName} (id=${fileId}, mimeType=${file.mimeType}, modifiedTime=${file.modifiedTime})`);

  // Google Docs 네이티브 파일은 export로, 그 외 일반 업로드 파일(텍스트/JSON)은
  // get(alt=media)으로 원문을 가져온다. Cowork가 실제로 어떤 형식으로 저장할지
  // 확신할 수 없으므로 둘 다 방어적으로 처리한다.
  let rawContent: string;
  if (file.mimeType === GOOGLE_DOC_MIME_TYPE) {
    const exportRes = await drive.files.export(
      { fileId, mimeType: "text/plain" },
      { responseType: "text" },
    );
    rawContent = exportRes.data as string;
  } else {
    const getRes = await drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "text" },
    );
    rawContent = getRes.data as string;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    console.error(`파일 내용을 JSON으로 파싱하는 데 실패했습니다: ${fileName} (id=${fileId})`);
    process.exit(1);
    return;
  }

  const dateKst =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).report_date
      : undefined;

  if (typeof dateKst !== "string" || !DATE_KST_PATTERN.test(dateKst)) {
    console.error(
      `report_date가 올바른 형식(YYYY-MM-DD)이 아닙니다: ${fileName} (id=${fileId}), 값=${String(dateKst)}`,
    );
    process.exit(1);
    return;
  }

  const daysDiff = daysFromToday(dateKst);
  if (Math.abs(daysDiff) > 1) {
    console.warn(
      `report_date(${dateKst})가 배치 실행 시점(KST 기준 오늘=${todayKstDateString()})과 ${daysDiff}일 차이납니다 — 정상 범위(±1일)를 벗어났습니다. Cowork 쪽 날짜 생성 로직을 확인해보세요. 저장은 정상 진행합니다.`,
    );
  }

  const shapeIssues = validateBriefingShape(parsed as Record<string, unknown>);
  if (shapeIssues.length > 0) {
    console.error(
      `브리핑 데이터 스키마 검증 실패: ${fileName} (id=${fileId})\n` +
        shapeIssues.map((issue) => `  - ${issue.field}: ${issue.reason}`).join("\n"),
    );
    process.exit(1);
    return;
  }

  const { data: existing, error: selectError } = await supabaseAdmin
    .from("market_briefings")
    .select("id")
    .eq("date_kst", dateKst)
    .maybeSingle();

  if (selectError) {
    throw new Error(`기존 브리핑 조회 실패: ${selectError.message}`);
  }

  if (existing) {
    console.log(`이미 처리된 날짜(${dateKst}) — 스킵`);
    return;
  }

  await upsertMarketBriefing(parsed);
  console.log(`시장 브리핑 저장 완료: date_kst=${dateKst}`);

  // 오래된 브리핑 정리는 저장 성공 여부와 무관한 부가 작업이라, 실패해도 이번
  // 배치의 핵심 결과(저장 성공)에는 영향을 주지 않는다 — 로그만 남긴다.
  try {
    await deleteOldMarketBriefings();
    console.log("오래된 시장 브리핑 정리 완료");
  } catch (e) {
    console.error("오래된 시장 브리핑 정리 실패:", e instanceof Error ? e.message : e);
  }
}

main().catch((error) => {
  console.error("시장 브리핑 Drive 폴링 배치 중 오류가 발생했습니다:", error);
  process.exit(1);
});

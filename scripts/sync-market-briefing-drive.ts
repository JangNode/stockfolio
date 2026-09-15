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

const DATE_KST_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";

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

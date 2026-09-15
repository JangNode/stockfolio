/**
 * 디스포저블 진단 스크립트 — sync-market-briefing-drive.ts가 계속
 * "File not found: <folderId>" 404를 반환하는 원인을 실제 Google Drive API
 * 응답으로 직접 확인한다. 폴더 공유(뷰어)까지 확인됐는데도 실패가 반복돼서,
 * 추측으로 코드를 더 고치는 대신 실제 응답 구조를 먼저 본다(SKILLS.md 패턴).
 *
 * 필요 환경변수: GOOGLE_SERVICE_ACCOUNT_KEY, GOOGLE_DRIVE_FOLDER_ID
 *   npx tsx scripts/diagnose-drive-folder.ts
 */
import { google } from "googleapis";

function getServiceAccountCredentials(): Record<string, unknown> {
  const encoded = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!encoded) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY 환경변수가 없습니다.");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
}

async function main(): Promise<void> {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) throw new Error("GOOGLE_DRIVE_FOLDER_ID 환경변수가 없습니다.");
  console.log(`대상 폴더 ID 길이: ${folderId.length}자`);

  const credentials = getServiceAccountCredentials();
  console.log(`서비스 계정 client_email: ${credentials.client_email}`);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  const drive = google.drive({ version: "v3", auth });

  console.log("\n=== 1. drive.about.get (서비스 계정 본인 확인) ===");
  try {
    const about = await drive.about.get({ fields: "user" });
    console.log(JSON.stringify(about.data, null, 2));
  } catch (e) {
    console.error("about.get 실패:", e instanceof Error ? e.message : e);
  }

  console.log("\n=== 2. drive.files.get(folderId) — 폴더 객체 자체를 볼 수 있는지 ===");
  try {
    const file = await drive.files.get({
      fileId: folderId,
      supportsAllDrives: true,
      fields: "id, name, driveId, parents, trashed, mimeType, capabilities",
    });
    console.log(JSON.stringify(file.data, null, 2));
  } catch (e: unknown) {
    console.error("files.get(folderId) 실패:");
    console.error(JSON.stringify(e, Object.getOwnPropertyNames(e as object), 2));
  }

  console.log("\n=== 3. drive.files.list('folderId' in parents), supportsAllDrives ===");
  try {
    const listRes = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: "files(id, name, mimeType, modifiedTime)",
    });
    console.log(JSON.stringify(listRes.data, null, 2));
  } catch (e: unknown) {
    console.error("files.list('in parents') 실패:");
    console.error(JSON.stringify(e, Object.getOwnPropertyNames(e as object), 2));
  }

  console.log("\n=== 4. drive.files.list(corpora: allDrives, q 없이 전체) — 서비스 계정이 뭐라도 보이는지 ===");
  try {
    const listAllRes = await drive.files.list({
      corpora: "allDrives",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageSize: 20,
      fields: "files(id, name, mimeType, driveId)",
    });
    console.log(JSON.stringify(listAllRes.data, null, 2));
  } catch (e: unknown) {
    console.error("files.list(corpora=allDrives) 실패:");
    console.error(JSON.stringify(e, Object.getOwnPropertyNames(e as object), 2));
  }
}

main().catch((error) => {
  console.error("진단 스크립트 오류:", error);
  process.exit(1);
});

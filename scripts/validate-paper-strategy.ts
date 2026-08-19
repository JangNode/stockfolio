/**
 * data/paper-strategies/{style}.json 파일이 PaperStrategyConditionsSchema(lib/paperStrategy.ts)를
 * 만족하는지 검증한다. "AI 모의투자" 전략을 매일 재생성하는 Claude Code Routine이
 * 커밋 전에 스스로 확인하는 용도 — Anthropic API의 structured output 같은 강제
 * 검증이 없는 대신, 커밋 직전에 이 스크립트로 스키마를 확인한다.
 *
 *   tsx --conditions=react-server scripts/validate-paper-strategy.ts data/paper-strategies/aggressive.json
 *
 * 통과하면 종료 코드 0과 함께 정리된 요약을, 실패하면 0이 아닌 종료 코드와 구체적인
 * 오류 위치를 출력한다.
 */

import { readFileSync } from "fs";
import { PaperStrategyConditionsSchema } from "@/lib/paperStrategy";

const filePath = process.argv[2];
if (!filePath) {
  console.error("사용법: tsx --conditions=react-server scripts/validate-paper-strategy.ts <파일경로>");
  process.exit(1);
}

let raw: string;
try {
  raw = readFileSync(filePath, "utf-8");
} catch (error) {
  console.error(`파일을 읽을 수 없습니다(${filePath}): ${error}`);
  process.exit(1);
}

let json: unknown;
try {
  json = JSON.parse(raw);
} catch (error) {
  console.error(`JSON 파싱 실패: ${error}`);
  process.exit(1);
}

const result = PaperStrategyConditionsSchema.safeParse(json);
if (!result.success) {
  console.error(`스키마 검증 실패(${filePath}):`);
  for (const issue of result.error.issues) {
    console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const generatedAtKstDate = new Date(result.data.generated_at).toLocaleDateString("en-CA", {
  timeZone: "Asia/Seoul",
});
console.log(`검증 통과: ${filePath}`);
console.log(`  label: ${result.data.label}`);
console.log(`  generated_at(KST 날짜): ${generatedAtKstDate}`);

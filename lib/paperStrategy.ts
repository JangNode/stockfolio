import "server-only";
import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";

export type PaperStyle = "aggressive" | "conservative";
export const PAPER_STYLES: PaperStyle[] = ["aggressive", "conservative"];

// 원 스크리닝 전략(ma_cross/minervini_trend_template)이 만들어내는 rule_type과 동일한 값.
// 새 원 전략이 추가되면 여기도 같이 늘어난다.
const SOURCE_RULE_TYPES = ["ma_cross", "minervini_trend_template"] as const;

// 매일 정해진 시각(paper-strategy.yml, screening.yml보다 앞선 KST 14:10)에 별도
// Claude Code 세션(Routine)이 이 스키마에 맞춰 data/paper-strategies/{style}.json을
// 직접 작성해 커밋한다 — Anthropic API 과금 없이, 이미 쓰고 있는 Claude Code 접근을
// 그대로 재사용하기 위해서다(scripts/generate-paper-strategy-prompt.ts 참고).
// 전부 숫자/열거형/불리언으로만 구성해, 매매 판단과 "판단 근거" 텍스트를 배치가
// 전부 코드로 기계적으로 대입할 수 있게 한다(자연어 조건은 프로그램이 재현 가능하게
// 평가할 수 없다).
export const PaperStrategyConditionsSchema = z.object({
  label: z.string().min(1).max(60).describe("이 전략을 부르는 짧은 이름"),
  rationale: z
    .string()
    .min(1)
    .describe("왜 이 조건들을 골랐는지에 대한 한국어 설명(3~6문장)"),
  generated_at: z.string().datetime().describe("이 조건을 생성한 시각(ISO 8601)"),
  entry_conditions: z.object({
    source_rule_types: z
      .array(z.enum(SOURCE_RULE_TYPES))
      .min(1)
      .describe("이 원 스크리닝 전략에서 나온 신호만 매수 후보로 삼는다"),
    min_signal_return_pct: z
      .number()
      .min(-50)
      .max(100)
      .describe("스크리닝 신호 대비 현재 수익률(%)의 최소값 — 이보다 낮으면 매수 후보에서 제외"),
    max_signal_return_pct: z
      .number()
      .min(-50)
      .max(200)
      .describe("스크리닝 신호 대비 현재 수익률(%)의 최대값 — 이보다 높으면(너무 오름) 매수 후보에서 제외"),
    max_positions: z
      .number()
      .int()
      .min(1)
      .max(20)
      .describe("동시에 보유할 수 있는 최대 종목 수"),
    position_size_pct: z
      .number()
      .min(1)
      .max(100)
      .describe("신규 매수 1건에 투입할 현금 비율(%, 그 시점의 보유 현금 기준)"),
  }),
  exit_conditions: z.object({
    take_profit_pct: z
      .number()
      .min(1)
      .max(200)
      .describe("매입가 대비 이 비율(%) 이상 오르면 익절 매도"),
    stop_loss_pct: z
      .number()
      .min(1)
      .max(50)
      .describe("매입가 대비 이 비율(%) 이상 내리면 손절 매도"),
    max_holding_days: z
      .number()
      .int()
      .min(1)
      .max(90)
      .describe("이 기간(일)을 넘겨 보유 중이면 조건 충족 여부와 무관하게 매도"),
  }),
  stock_selection_criteria: z.object({
    prefer_higher_return_pct: z
      .boolean()
      .describe(
        "true면 매수 후보 중 신호 대비 수익률이 높은 종목(상승 모멘텀)부터, false면 낮은 종목(눌림목)부터 우선 선정"
      ),
    max_candidates_to_consider: z
      .number()
      .int()
      .min(1)
      .max(50)
      .describe("한 번에 검토할 매수 후보 최대 개수(그중 순위대로 max_positions까지 채운다)"),
  }),
});

export type PaperStrategyConditions = z.infer<typeof PaperStrategyConditionsSchema>;

function strategyFilePath(style: PaperStyle): string {
  return join(process.cwd(), "data", "paper-strategies", `${style}.json`);
}

export interface LoadedStrategyFile {
  conditions: PaperStrategyConditions;
  generatedAtKstDate: string;
}

/**
 * 라우틴 세션이 커밋한 data/paper-strategies/{style}.json을 읽어 검증한다. 파일이
 * 없거나(첫 실행 전) 형식이 스키마와 다르면(라우틴 출력 오류) null을 반환한다 —
 * 호출부가 이를 "오늘은 새 전략을 못 받았다"로 처리해 기존 활성 전략으로 계속
 * 매매하도록 degrade해야 하므로, 여기서 예외를 던지지 않는다.
 */
export function loadStrategyFile(style: PaperStyle): LoadedStrategyFile | null {
  let raw: string;
  try {
    raw = readFileSync(strategyFilePath(style), "utf-8");
  } catch {
    return null;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    console.error(`  [${style}] data/paper-strategies/${style}.json JSON 파싱 실패: ${error}`);
    return null;
  }

  const parsed = PaperStrategyConditionsSchema.safeParse(json);
  if (!parsed.success) {
    console.error(`  [${style}] data/paper-strategies/${style}.json 스키마 검증 실패: ${parsed.error.message}`);
    return null;
  }

  const generatedAtKstDate = new Date(parsed.data.generated_at).toLocaleDateString("en-CA", {
    timeZone: "Asia/Seoul",
  });

  return { conditions: parsed.data, generatedAtKstDate };
}

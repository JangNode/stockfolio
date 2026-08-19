import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY 환경 변수가 설정되지 않았습니다.");
  }
  return new Anthropic({ apiKey });
}

export type PaperStyle = "aggressive" | "conservative";

// 원 스크리닝 전략(ma_cross/minervini_trend_template)이 만들어내는 rule_type과 동일한 값.
// 새 원 전략이 추가되면 여기도 같이 늘어난다.
const SOURCE_RULE_TYPES = ["ma_cross", "minervini_trend_template"] as const;

// Claude가 채워야 하는 전략 조건. 전부 숫자/열거형/불리언으로만 구성해, 매매 판단과
// "판단 근거" 텍스트를 전부 코드로 기계적으로 대입할 수 있게 한다(자연어 조건은
// 프로그램이 재현 가능하게 평가할 수 없다). 값의 타당한 범위는 z.number().min/max로
// 강제하지만, 그 범위 안에서 공격형/안정형의 실제 수치를 고르는 건 Claude의 몫이다.
export const PaperStrategyConditionsSchema = z.object({
  label: z.string().min(1).max(60).describe("이 전략을 부르는 짧은 이름"),
  rationale: z
    .string()
    .min(1)
    .describe("왜 이 조건들을 골랐는지에 대한 한국어 설명(3~6문장)"),
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

export interface PreviousStrategySummary {
  label: string;
  conditions: Omit<PaperStrategyConditions, "label" | "rationale">;
  periodReturnPct: number;
  daysActive: number;
}

const STYLE_LABEL: Record<PaperStyle, string> = {
  aggressive: "공격형",
  conservative: "안정형",
};

const STYLE_BRIEF: Record<PaperStyle, string> = {
  aggressive:
    "공격형: 더 높은 변동성/집중 투자를 감수하고 상승 모멘텀을 적극적으로 추종해 높은 수익률을 노린다. " +
    "손절/익절 폭을 넓게, 종목 수를 적게(집중), 회당 투입 비중을 크게 가져가는 경향을 보여야 한다.",
  conservative:
    "안정형: 변동성을 낮추고 손실을 방어하는 데 우선순위를 둔다. " +
    "손절/익절 폭을 좁게, 종목 수를 많이(분산), 회당 투입 비중을 작게 가져가는 경향을 보여야 한다.",
};

function buildPrompt(style: PaperStyle, previous: PreviousStrategySummary | null): string {
  const lines = [
    `당신은 "AI 모의투자" 데모 기능의 ${STYLE_LABEL[style]} 전략을 담당하는 트레이더입니다.`,
    STYLE_BRIEF[style],
    "",
    "이 전략은 매일 재생성되며, 실제 주문은 절대 나가지 않는 가상 매매입니다(교육/데모 목적).",
    "전략은 매일 아래 스크리닝 결과를 후보로 매매를 판단하는 프로그램에 그대로 대입됩니다:",
    "- source_rule_types에 해당하는 원 스크리닝 전략이 오늘 활성 상태로 추적 중인 종목 목록",
    "- 각 종목의 '신호 발생 시점 대비 현재 수익률'(screening 테이블의 return_pct)",
    "이 두 값만으로 진입/청산/종목선정 조건을 정량적으로 설계해야 합니다(섹터, 뉴스, 재무제표 등 스크리닝 결과에 없는 정보는 알 수 없습니다).",
  ];

  if (previous) {
    lines.push(
      "",
      `직전 ${STYLE_LABEL[style]} 전략 "${previous.label}"은 ${previous.daysActive}일간 운용되어 기간 수익률 ${previous.periodReturnPct.toFixed(2)}%를 기록했습니다.`,
      `직전 조건: ${JSON.stringify(previous.conditions)}`,
      "이 성과를 참고해 오늘의 조건을 그대로 유지할지, 어느 방향으로 조정할지 rationale에 명시하세요."
    );
  } else {
    lines.push("", "아직 이전 전략 이력이 없습니다. 오늘 처음 세우는 전략입니다.");
  }

  lines.push(
    "",
    "출력 스키마의 모든 수치는 설명된 범위 안에서, 위 스타일 성격에 맞게 직접 정하세요.",
    "rationale은 3~6문장의 한국어로, 왜 이 수치들을 골랐는지 설명하세요."
  );

  return lines.join("\n");
}

export interface GeneratedStrategy {
  conditions: PaperStrategyConditions;
  model: string;
  rawResponse: unknown;
}

/** Claude를 호출해 스타일별 오늘의 전략 조건을 생성한다. */
export async function generateStrategy(
  style: PaperStyle,
  previous: PreviousStrategySummary | null
): Promise<GeneratedStrategy> {
  const client = getClient();

  const response = await client.messages.parse({
    model: ANTHROPIC_MODEL,
    max_tokens: 4096,
    messages: [{ role: "user", content: buildPrompt(style, previous) }],
    output_config: {
      format: zodOutputFormat(PaperStrategyConditionsSchema),
    },
  });

  if (!response.parsed_output) {
    throw new Error(
      `전략 생성 응답 파싱 실패(style=${style}): ${JSON.stringify(response.content)}`
    );
  }

  return {
    conditions: response.parsed_output,
    model: ANTHROPIC_MODEL,
    rawResponse: response,
  };
}

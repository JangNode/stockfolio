import { z } from "zod";

// "최근 1년"/"최근 3년" 중에서만 고르게 한다(실험실 UI 기간 선택과 1:1 대응).
export const CUSTOM_BACKTEST_PERIOD_MONTHS = [12, 36] as const;

export const FUNDAMENTAL_CONDITION_COMPARATORS = ["gte", "lte", "gt", "lt"] as const;

function fundamentalCondition(min: number, max: number) {
  return z.object({
    comparator: z.enum(FUNDAMENTAL_CONDITION_COMPARATORS),
    value: z.number().min(min).max(max),
  });
}

// 값 범위는 화면 오입력을 거르는 정도의 넉넉한 상한/하한이다(기준값 자체를 여기서
// 강제하지 않는다 — DH전략/PEG전략처럼 고정 상수가 아니라 사용자가 직접 입력하는
// 값이라서다).
export const CustomFundamentalConditionsSchema = z
  .object({
    market_cap_eok: fundamentalCondition(0, 10_000_000).optional(),
    per: fundamentalCondition(0, 1000).optional(),
    pbr: fundamentalCondition(0, 100).optional(),
    peg: fundamentalCondition(0, 100).optional(),
    consecutive_dividend_years: fundamentalCondition(0, 100).optional(),
    dividend_yield_pct: fundamentalCondition(0, 100).optional(),
  })
  .refine(
    (v) =>
      v.market_cap_eok !== undefined ||
      v.per !== undefined ||
      v.pbr !== undefined ||
      v.peg !== undefined ||
      v.consecutive_dividend_years !== undefined ||
      v.dividend_yield_pct !== undefined,
    { message: "펀더멘털 조건을 선택했다면 최소 1개 항목은 지정해야 합니다." }
  );

export const CustomCompositeParamsSchema = z
  .object({
    ma_cross: z
      .object({
        short_period: z.number().int().min(2).max(200),
        long_period: z.number().int().min(3).max(300),
      })
      .optional(),
    rsi: z
      .object({
        period: z.number().int().min(2).max(100),
        threshold: z.number().min(0).max(100),
        direction: z.enum(["above", "below"]),
      })
      .optional(),
    volume_surge: z
      .object({
        period: z.number().int().min(2).max(100),
        multiplier: z.number().min(1).max(20),
      })
      .optional(),
    fundamentals: CustomFundamentalConditionsSchema.optional(),
    stop_loss_pct: z.number().min(0.01).max(0.9).optional(),
    take_profit_pct: z.number().min(0.01).max(5).optional(),
  })
  .refine(
    (v) => v.ma_cross !== undefined || v.rsi !== undefined || v.volume_surge !== undefined || v.fundamentals !== undefined,
    {
      message: "조건을 최소 1개 이상 선택해야 합니다(이동평균 교차, RSI, 거래량 급증, 펀더멘털 중).",
    }
  );

// CUSTOM_BACKTEST_PERIOD_MONTHS와 같은 값을 하드코딩한다 — zod 유니언은 리터럴 개수가
// 고정이라 배열에서 동적으로 만들기보다 이렇게 나열하는 편이 더 간단하고 안전하다.
export const CustomBacktestRequestSchema = z
  .object({
    market: z.enum(["KR", "US"]),
    period_months: z.union([z.literal(12), z.literal(36)]),
    rule_params: CustomCompositeParamsSchema,
  })
  // 펀더멘털 조건(시가총액/PER/PBR/PEG/배당 연속 지급 연수/배당수익률)은 DART/KRX
  // 재무 데이터 기반이라 국내(KR) 상장사만 판정할 수 있다 — 미국 종목에 적용하면
  // 항상 undefined(판정 불가)로만 나와 아예 매칭이 안 되는 조용한 오사용이 되므로,
  // 요청 단계에서부터 명시적으로 막는다.
  .refine((v) => v.market === "KR" || v.rule_params.fundamentals === undefined, {
    message: "펀더멘털 조건은 국내(KR) 시장에서만 사용할 수 있습니다(DART 재무 데이터는 국내 상장사만 다룹니다).",
    path: ["rule_params", "fundamentals"],
  });

export type CustomBacktestRequest = z.infer<typeof CustomBacktestRequestSchema>;

import { z } from "zod";

// "최근 1년"/"최근 3년" 중에서만 고르게 한다(실험실 UI 기간 선택과 1:1 대응).
export const CUSTOM_BACKTEST_PERIOD_MONTHS = [12, 36] as const;

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
    stop_loss_pct: z.number().min(0.01).max(0.9).optional(),
    take_profit_pct: z.number().min(0.01).max(5).optional(),
  })
  .refine((v) => v.ma_cross !== undefined || v.rsi !== undefined || v.volume_surge !== undefined, {
    message: "조건을 최소 1개 이상 선택해야 합니다(이동평균 교차, RSI, 거래량 급증 중).",
  });

// CUSTOM_BACKTEST_PERIOD_MONTHS와 같은 값을 하드코딩한다 — zod 유니언은 리터럴 개수가
// 고정이라 배열에서 동적으로 만들기보다 이렇게 나열하는 편이 더 간단하고 안전하다.
export const CustomBacktestRequestSchema = z.object({
  market: z.enum(["KR", "US"]),
  period_months: z.union([z.literal(12), z.literal(36)]),
  rule_params: CustomCompositeParamsSchema,
});

export type CustomBacktestRequest = z.infer<typeof CustomBacktestRequestSchema>;

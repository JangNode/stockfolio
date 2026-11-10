import type { Regime } from "@/lib/marketRegime";

/** 국면별 배지 색: 한국 시장 관례(상승=빨강, 하락=파랑)를 따르는 디자인 토큰만 쓴다(색 하드코딩 금지). */
export const BADGE_CLASS: Record<Regime, string> = {
  bull: "bg-rise-soft text-rise",
  neutral: "bg-surface-sunken text-ink-muted",
  bear: "bg-fall-soft text-fall",
  crisis: "bg-est-soft text-est",
  undefined: "bg-surface-sunken text-ink-faint",
};

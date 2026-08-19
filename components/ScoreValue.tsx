// 한국 주식 시장 관례(상승=빨강, 하락=파랑)에 맞춰 점수가 높을수록 빨강, 낮을수록 파랑으로 표시한다.
function scoreColorClass(score: number): string {
  if (score >= 80) return "text-red-700 dark:text-red-300";
  if (score >= 60) return "text-red-500 dark:text-red-400";
  if (score >= 40) return "text-zinc-500 dark:text-zinc-400";
  if (score >= 20) return "text-blue-500 dark:text-blue-400";
  return "text-blue-700 dark:text-blue-300";
}

/** 스크리닝 신호 품질 점수(0~100). 점수가 없는(마이그레이션 이전) 행은 "-"만 표시한다. */
export function ScoreValue({ score }: { score: number | null }) {
  if (score === null) {
    return <span className="text-xs text-zinc-400 dark:text-zinc-500">-</span>;
  }

  return <span className={`text-sm font-semibold tabular-nums ${scoreColorClass(score)}`}>{score}</span>;
}

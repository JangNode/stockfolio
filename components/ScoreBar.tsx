function scoreBarColor(score: number): string {
  if (score >= 70) return "bg-red-500 dark:bg-red-400";
  if (score >= 40) return "bg-amber-500 dark:bg-amber-400";
  return "bg-zinc-400 dark:bg-zinc-500";
}

/** 스크리닝 신호 품질 점수(0~100) 막대바. 점수가 없는(마이그레이션 이전) 행은 "-"만 표시한다. */
export function ScoreBar({ score }: { score: number | null }) {
  if (score === null) {
    return <span className="text-xs text-zinc-400 dark:text-zinc-500">-</span>;
  }

  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-16 overflow-hidden rounded-full bg-black/[.06] dark:bg-white/[.1]">
        <div className={`h-full rounded-full ${scoreBarColor(score)}`} style={{ width: `${score}%` }} />
      </div>
      <span className="w-6 text-right text-xs tabular-nums text-black dark:text-zinc-50">{score}</span>
    </div>
  );
}

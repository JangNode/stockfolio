import "server-only";

const REPO_OWNER = "JangNode";
const REPO_NAME = "stockfolio";
const WORKFLOW_FILE = "custom-backtest.yml";

/**
 * GITHUB_ACTIONS_DISPATCH_TOKEN(레포 Actions 쓰기 권한의 Fine-grained PAT)으로
 * scripts/run-custom-backtest.ts를 실행하는 워크플로(.github/workflows/custom-backtest.yml)를
 * 원격 트리거한다. Vercel 서버리스 함수는 전종목 스캔을 실행 시간 제한 안에 끝낼 수
 * 없어, 실제 계산은 GitHub Actions에 맡기고 이 API 라우트는 트리거만 한다.
 */
export async function dispatchCustomBacktestWorkflow(runId: string): Promise<void> {
  const token = process.env.GITHUB_ACTIONS_DISPATCH_TOKEN;
  if (!token) {
    throw new Error("GITHUB_ACTIONS_DISPATCH_TOKEN 환경변수가 설정되지 않았습니다.");
  }

  const response = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs: { run_id: runId } }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`백테스트 워크플로 트리거 실패(${response.status}): ${body}`);
  }
}

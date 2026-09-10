#!/bin/bash
# Vercel Ignored Build Step. Vercel이 배포마다 이 스크립트를 실행해 종료 코드로
# 빌드 진행 여부를 정한다 — exit 0이면 스킵(이번 push는 프리뷰가 필요 없음),
# 0이 아니면 정상 빌드.
#
# scripts/·워크플로·마이그레이션만 바뀐 push는 실제 배포되는 앱(Next.js)에
# 영향이 없어(둘 다 GitHub Actions 전용이거나 Supabase에만 적용되는 파일) 프리뷰가
# 필요 없다. GitHub Actions 무료 한도 초과 조사 중 PR 280개+가 전부 프리뷰
# 배포를 만들고 있었던 게 Vercel Functions Storage 초과의 원인 중 하나로
# 확인돼(2026-09-10) 도입한다.
#
# 브랜치명(claude/** 등)이 아니라 "무엇이 바뀌었는지"로 판단한다 — 이 프로젝트
# 브랜치는 실제 기능 PR도 진단용 임시 PR도 전부 claude/로 시작해서, 브랜치명
# 기준으로 끄면 사실상 모든 PR의 유일한 CI(Vercel 프리뷰 빌드 성공 여부)가
# 사라진다. main은 항상 빌드한다(프로덕션 배포는 절대 스킵하지 않음).
#
# 저장소 루트에 둔 이유: .vercelignore가 scripts/를 제외하므로, 이 스크립트를
# scripts/ 밑에 두면 Ignored Build Step 실행 시점에 스크립트 자체를 못 찾을
# 위험이 있다 — 루트에 둬서 그 문제를 피한다.

if [ "$VERCEL_GIT_COMMIT_REF" = "main" ]; then
  echo "main 브랜치 — 항상 빌드합니다."
  exit 1
fi

git fetch origin main --depth=50 >/dev/null 2>&1
BASE=$(git merge-base HEAD origin/main 2>/dev/null || git rev-parse HEAD^ 2>/dev/null)

if [ -z "$BASE" ]; then
  echo "비교 기준 커밋을 찾지 못해 안전하게 빌드를 진행합니다."
  exit 1
fi

CHANGED_FILES=$(git diff --name-only "$BASE" HEAD)

if [ -z "$CHANGED_FILES" ]; then
  echo "변경된 파일이 없어 안전하게 빌드를 진행합니다."
  exit 1
fi

echo "변경된 파일:"
echo "$CHANGED_FILES"

if echo "$CHANGED_FILES" | grep -qvE '^(scripts/|\.github/workflows/|supabase/migrations/)'; then
  echo "앱 코드(scripts/·.github/workflows/·supabase/migrations/ 외 파일) 변경 포함 — 빌드를 진행합니다."
  exit 1
else
  echo "scripts/·워크플로·마이그레이션만 변경됨 — 프리뷰 배포를 건너뜁니다."
  exit 0
fi

#!/usr/bin/env bash
# [임시 연구 — 병합 금지] 연구 PEAD 전용 Actions 캐시·아티팩트 정리. 사용: pead-cleanup-actions.sh list|delete
# list: 저장소의 모든 Actions 캐시·아티팩트를 표로 보여 주고 삭제 후보(PEAD 전용 패턴)를 표시한다. delete: 후보만 지운 뒤 목록을 다시 보여 준다. GH_TOKEN 값은 출력하지 않는다.
set -euo pipefail
mode="${1:-list}"
repo="${GITHUB_REPOSITORY}"
# 삭제 후보 패턴(정확히 이 이름만): 부분집합 캐시, 잠정실적 파싱 결과 캐시·아티팩트
cache_re='^(research-subset-20261028|research-prelim-parsed-[0-9]+)$'
art_re='^(research-subset-20261028|research-prelim-parsed-[0-9]+)$'
show() {
  echo "== Actions 캐시 (id | key | bytes | ref | created | last_accessed | 후보) =="
  gh api --paginate "repos/$repo/actions/caches?per_page=100" --jq '.actions_caches[] | [.id,.key,.size_in_bytes,.ref,.created_at,.last_accessed_at] | @tsv' | while IFS=$'\t' read -r id key sz ref cr la; do
    c="-"; [[ "$key" =~ $cache_re ]] && c="삭제후보"
    echo "$id | $key | $sz | $ref | $cr | $la | $c"
  done
  echo "== Actions 아티팩트 (id | name | bytes | expired | run | created | 후보) =="
  gh api --paginate "repos/$repo/actions/artifacts?per_page=100" --jq '.artifacts[] | [.id,.name,.size_in_bytes,.expired,.workflow_run.id,.created_at] | @tsv' | while IFS=$'\t' read -r id name sz ex run cr; do
    c="-"; [[ "$name" =~ $art_re ]] && c="삭제후보"
    echo "$id | $name | $sz | $ex | $run | $cr | $c"
  done
}
show
if [ "$mode" = "delete" ]; then
  echo "== 삭제 실행 =="
  nc=0; nbc=0; na=0; nba=0
  while IFS=$'\t' read -r id key sz; do
    if [[ "$key" =~ $cache_re ]]; then gh api -X DELETE "repos/$repo/actions/caches/$id" >/dev/null && echo "캐시 삭제 $id $key ($sz B)" && nc=$((nc+1)) && nbc=$((nbc+sz)); fi
  done < <(gh api --paginate "repos/$repo/actions/caches?per_page=100" --jq '.actions_caches[] | [.id,.key,.size_in_bytes] | @tsv')
  while IFS=$'\t' read -r id name sz; do
    if [[ "$name" =~ $art_re ]]; then gh api -X DELETE "repos/$repo/actions/artifacts/$id" >/dev/null && echo "아티팩트 삭제 $id $name ($sz B)" && na=$((na+1)) && nba=$((nba+sz)); fi
  done < <(gh api --paginate "repos/$repo/actions/artifacts?per_page=100" --jq '.artifacts[] | select(.expired==false) | [.id,.name,.size_in_bytes] | @tsv')
  echo "삭제 합계: 캐시 $nc개 $nbc B, 아티팩트 $na개 $nba B"
  echo "== 삭제 후 목록 =="
  show
fi

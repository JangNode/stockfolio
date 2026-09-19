@AGENTS.md
@SKILLS.md
@RULES.md

# stockFolio

개인용 국내/미국 주식 투자 보조 웹앱. 관심종목 추적, 전략 기반 스크리닝,
백테스트, AI 모의투자, 시장 지표(FOMC/금통위 기준금리·회의 일정·관련 뉴스)를
제공한다.

## 기술 스택

- Next.js 16(App Router) + React 19 + TypeScript, Tailwind CSS
- Supabase: Postgres(RLS) + Storage + pg_cron/pg_net. `lib/supabaseAdmin.ts`(서비스
  롤, 서버 전용) vs 클라이언트 `supabase`(RLS 적용) 구분
- 배치: GitHub Actions(`.github/workflows/`) — 실행은 `scripts/*.ts`를
  `tsx --conditions=react-server`로 돌림
- 외부 데이터 소스: KIS(국내 시세), DART(국내 재무제표), FRED/ECOS(기준금리),
  federalreserve.gov/bok.or.kr RSS(통화정책 뉴스·회의 일정)
- 클라이언트 데이터 fetch: SWR, 차트: recharts
- 배포: Vercel(PR마다 프리뷰 배포가 CI 역할을 겸함)

## 팀장 역할 (이 세션)

사용자와 직접 대화하는 이 세션은 "팀장" 역할을 한다. 팀장은 작업 성격에 맞는
에이전트에게 위임하고, 결과를 검토해 사용자에게 보고한다.

**위임 없이 직접 처리한다**: 오타·문구 수정, 원인이 명확한 단순 버그 픽스,
사소한 리팩터·문서 수정, 기존 패턴을 그대로 복사하는 반복 작업처럼 간단한
설정 변경이나 한 줄짜리 수정. 이런 작업까지 매번 아래 파이프라인을 거치면
오히려 비효율적이다.

**복잡하거나 여러 단계가 필요한 작업**(새 기능/화면 추가, DB 스키마 변경,
외부 API·사이트 연동, 배치/cron 신설, 여러 파일에 걸친 아키텍처 변경)은
아래 순서로 위임한다:

1. `planner` — 계획·설계안 확보. 원래 요청보다 커지는 부분은 사용자에게
   확인받는다.
2. `developer` — 구현
3. `reviewer` — 검증. 재작업이 필요하면 developer로 되돌린다.
4. `tester` — 실데이터 검증(`SKILLS.md`의 verify 스크립트 패턴 참고)
5. `deployer` — PR 생성·CI 확인·병합, 마이그레이션 적용, 임시 스크립트 정리

각 단계 결과를 검토하고, 문제가 있으면 해당 단계로 되돌린다. 모두 통과하면
사용자에게 한국어로 간결하게 요약 보고한다.

규모가 애매하면 `planner`만 먼저 돌려 판단한다. 사용자가 이미 계획을 직접
승인한 경우(대화에서 계획을 보여주고 확인받은 경우)는 `planner` 단계를
생략할 수 있다.

마이그레이션 적용이나 프로덕션 데이터에 영향을 주는 작업, 그리고 원래
요청보다 설계가 커지는 부분은 어느 단계에서든 사용자 확인 없이 진행하지
않는다(`RULES.md` 참고).

-- GitHub Actions의 schedule 트리거는 부하가 높을 때 몇 시간씩 지연될 수 있다(공식 문서에
-- 명시된 동작이며, 실측으로도 평일 05:30 UTC 예약이 07:29~08:08 UTC 사이로 매번 2시간
-- 안팎 지연되는 걸 확인했다). 반면 workflow_dispatch(API로 직접 실행 요청)는 큐잉 지연이
-- 거의 없다. 그래서 이 배치의 예약 실행을 GitHub의 schedule 대신 pg_cron이 정시에
-- workflow_dispatch API를 호출하는 방식으로 옮긴다 — .github/workflows/screening.yml에서는
-- schedule 트리거를 제거했다(더 이상 이 워크플로를 예약 실행시키는 쪽은 GitHub이 아니라
-- 여기 pg_cron이다).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- GitHub PAT는 이 마이그레이션에 값을 넣지 않는다(코드/git 이력에 시크릿을 남기지 않기
-- 위해). 이 마이그레이션 적용 후 Supabase SQL Editor에서 아래를 한 번 실행해 채워야
-- pg_cron 잡이 실제로 동작한다:
--   select vault.create_secret('<Actions: Read and write 권한의 fine-grained PAT>', 'github_actions_pat', 'screening.yml workflow_dispatch 트리거용');
-- 시크릿이 비어 있으면 아래 함수는 조용히 건너뛴다(경고 로그만 남김) — pg_cron 잡
-- 실패로 죽지 않는다.
create or replace function public.trigger_kr_screening_dispatch()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  select decrypted_secret into v_token
  from vault.decrypted_secrets
  where name = 'github_actions_pat'
  limit 1;

  if v_token is null then
    raise warning 'github_actions_pat 시크릿이 없어 국내 스크리닝 워크플로 트리거를 건너뜁니다.';
    return;
  end if;

  perform net.http_post(
    url := 'https://api.github.com/repos/JangNode/stockfolio/actions/workflows/screening.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Accept', 'application/vnd.github+json',
      'Content-Type', 'application/json',
      'X-GitHub-Api-Version', '2022-11-28'
    ),
    body := jsonb_build_object('ref', 'main')
  );
end;
$$;

-- PostgREST가 public 스키마 함수를 기본적으로 RPC로 노출하므로, anon/authenticated
-- 클라이언트가 이 함수를 호출해 워크플로를 임의로 트리거하지 못하도록 실행 권한을
-- 명시적으로 걷어낸다. pg_cron 잡은 postgres 권한으로 돌기 때문에 이 revoke와
-- 무관하게 계속 실행된다.
revoke execute on function public.trigger_kr_screening_dispatch() from public, anon, authenticated;

-- 평일(월~금) 한국시간(KST) 오후 2시 30분 = UTC 05:30 — 기존 GH Actions schedule과
-- 동일한 목표 시각을 그대로 쓴다.
select cron.schedule(
  'trigger-kr-screening',
  '30 5 * * 1-5',
  $$select public.trigger_kr_screening_dispatch();$$
);

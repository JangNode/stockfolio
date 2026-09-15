-- 시장 브리핑 Drive 폴링 배치(sync-market-briefing.yml)를 GitHub Actions 네이티브
-- schedule 대신 Supabase pg_cron이 workflow_dispatch를 직접 호출하는 방식으로 옮긴다.
-- 네이티브 schedule은 부하가 높을 때 몇 시간씩 지연될 수 있다(공식 문서에 명시된 동작,
-- 이 저장소의 다른 배치에서도 실측으로 확인됨) — 표시용 데이터라 처음엔 지연을 감수하고
-- 네이티브 schedule을 썼지만(20260915_create_sync_market_briefing_workflow 당시 결정),
-- Cowork가 아침 브리핑을 만드는 시점과 최대한 가깝게 정시(KST 07:30)에 가져오길 원해
-- kr/us 스크리닝·중앙은행 뉴스와 동일한 pg_cron 패턴으로 바꾼다.
--
-- GITHUB_ACTIONS_PAT Vault 시크릿은 이미 존재한다(스크리닝/발표감지/중앙은행뉴스 배치가
-- 이미 사용 중) — 이 마이그레이션에서 새로 만들 시크릿은 없다.
create or replace function public.trigger_market_briefing_dispatch()
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
  where name = 'GITHUB_ACTIONS_PAT'
  limit 1;

  if v_token is null then
    raise warning 'GITHUB_ACTIONS_PAT 시크릿이 없어 시장 브리핑 워크플로 트리거를 건너뜁니다.';
    return;
  end if;

  perform net.http_post(
    url := 'https://api.github.com/repos/JangNode/stockfolio/actions/workflows/sync-market-briefing.yml/dispatches',
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

revoke execute on function public.trigger_market_briefing_dispatch() from public, anon, authenticated;

-- 매일 한국시간(KST) 오전 7시 30분 = UTC 22시 30분(기존 GH Actions schedule과 동일 시각,
-- 트리거 방식만 바뀐다).
select cron.schedule(
  'trigger-market-briefing-sync',
  '30 22 * * *',
  $$select public.trigger_market_briefing_dispatch();$$
);

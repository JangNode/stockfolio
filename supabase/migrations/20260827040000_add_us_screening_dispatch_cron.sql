-- 국내 스크리닝(20260827020000/030000)과 같은 이유로 미국 스크리닝도 GitHub Actions
-- schedule 대신 Supabase pg_cron이 workflow_dispatch API를 직접 호출하도록 전환한다.
-- .github/workflows/screening-us.yml에서는 schedule 트리거(서머타임/표준시 크론 2개)를
-- 제거했다 — 이제 이 워크플로를 예약 실행시키는 쪽은 GitHub이 아니라 여기 pg_cron이다.
--
-- 미국은 국내와 달리 목표 시각 자체가 서머타임 여부에 따라 흔들려서(뉴욕 15:00 = UTC
-- 19:00 또는 20:00) pg_cron 잡도 기존 GitHub schedule과 동일하게 두 시각 모두 등록해두고,
-- 이번 호출이 어느 쪽인지를 workflow_dispatch의 schedule_cron 입력으로 넘긴다 —
-- lib/usMarketCalendar.ts의 determineUsBatchSchedule이 오늘 서머타임 여부와 비교해
-- 맞지 않는 쪽을 걸러낸다(기존 github.event.schedule 판별 로직을 그대로 재사용).
create or replace function public.trigger_us_screening_dispatch(p_schedule_cron text)
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
    raise warning 'GITHUB_ACTIONS_PAT 시크릿이 없어 미국 스크리닝 워크플로 트리거를 건너뜁니다.';
    return;
  end if;

  perform net.http_post(
    url := 'https://api.github.com/repos/JangNode/stockfolio/actions/workflows/screening-us.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Accept', 'application/vnd.github+json',
      'Content-Type', 'application/json',
      'X-GitHub-Api-Version', '2022-11-28'
    ),
    body := jsonb_build_object(
      'ref', 'main',
      'inputs', jsonb_build_object('schedule_cron', p_schedule_cron)
    )
  );
end;
$$;

revoke execute on function public.trigger_us_screening_dispatch(text) from public, anon, authenticated;

-- 서머타임(EDT, UTC-4): 뉴욕 15:00 = UTC 19:00
select cron.schedule(
  'trigger-us-screening-edt',
  '0 19 * * 1-5',
  $$select public.trigger_us_screening_dispatch('0 19 * * 1-5');$$
);

-- 표준시(EST, UTC-5): 뉴욕 15:00 = UTC 20:00
select cron.schedule(
  'trigger-us-screening-est',
  '0 20 * * 1-5',
  $$select public.trigger_us_screening_dispatch('0 20 * * 1-5');$$
);

-- FOMC/금통위 기준금리 발표 감지도 기존 스크리닝과 같은 이유로 GitHub Actions
-- schedule 대신 Supabase pg_cron이 workflow_dispatch API를 직접 호출한다
-- (.github/workflows/check-rate-announcement.yml).
--
-- 두 종류의 잡을 등록한다:
-- 1) 매일 정기 배치(안전망, offsets_min='0' — 1회만 확인): 재시도 창(최대 T+120분)을
--    넘겨 발표가 늦어지거나 일정이 틀어져도, 다음날부터는 이 배치가 계속 최신값을
--    확인해 결국 따라잡는다.
-- 2) 발표 예정일 집중 확인(offsets_min='0,5,15,30,60,120' — 워크플로 안에서 그
--    간격만큼 sleep하며 최대 6번 확인, 하나라도 변경 감지되면 즉시 종료): FOMC/금통위
--    일정이 확정될 때마다(연 1~2회) lib/rateScheduleConfig.ts와 함께 이 마이그레이션도
--    새로 추가해야 한다.
--
-- FOMC는 미국 동부시간 14:00 발표라 서머타임 여부에 따라 UTC 환산이 날짜마다 다르다
-- (2026년 서머타임 EDT: 3/8~11/1, UTC-4 / 그 외 EST, UTC-5) — 각 날짜마다 정확한 시각을
-- 계산해서 등록했다. 금통위는 한국시간 09:00 발표(서머타임 없음)라 매번 UTC 00:00으로
-- 동일하다.
create or replace function public.trigger_rate_check_dispatch(p_market text, p_offsets_min text)
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
    raise warning 'GITHUB_ACTIONS_PAT 시크릿이 없어 금리 발표 확인 워크플로 트리거를 건너뜁니다.';
    return;
  end if;

  perform net.http_post(
    url := 'https://api.github.com/repos/JangNode/stockfolio/actions/workflows/check-rate-announcement.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Accept', 'application/vnd.github+json',
      'Content-Type', 'application/json',
      'X-GitHub-Api-Version', '2022-11-28'
    ),
    body := jsonb_build_object(
      'ref', 'main',
      'inputs', jsonb_build_object('market', p_market, 'offsets_min', p_offsets_min)
    )
  );
end;
$$;

revoke execute on function public.trigger_rate_check_dispatch(text, text) from public, anon, authenticated;

-- 1) 매일 정기 배치(안전망): 한국시간 06:00 = UTC 21:00(전날).
select cron.schedule(
  'trigger-us-rate-daily-check',
  '0 21 * * *',
  $$select public.trigger_rate_check_dispatch('US', '0');$$
);
select cron.schedule(
  'trigger-kr-rate-daily-check',
  '0 21 * * *',
  $$select public.trigger_rate_check_dispatch('KR', '0');$$
);

-- 2) FOMC 2026 발표일 집중 확인 (동부시간 14:00 발표 기준 UTC 환산).
select cron.schedule('trigger-fomc-2026-01-28', '0 19 28 1 *', $$select public.trigger_rate_check_dispatch('US', '0,5,15,30,60,120');$$); -- EST
select cron.schedule('trigger-fomc-2026-03-18', '0 18 18 3 *', $$select public.trigger_rate_check_dispatch('US', '0,5,15,30,60,120');$$); -- EDT
select cron.schedule('trigger-fomc-2026-04-29', '0 18 29 4 *', $$select public.trigger_rate_check_dispatch('US', '0,5,15,30,60,120');$$); -- EDT
select cron.schedule('trigger-fomc-2026-06-17', '0 18 17 6 *', $$select public.trigger_rate_check_dispatch('US', '0,5,15,30,60,120');$$); -- EDT
select cron.schedule('trigger-fomc-2026-07-29', '0 18 29 7 *', $$select public.trigger_rate_check_dispatch('US', '0,5,15,30,60,120');$$); -- EDT
select cron.schedule('trigger-fomc-2026-09-16', '0 18 16 9 *', $$select public.trigger_rate_check_dispatch('US', '0,5,15,30,60,120');$$); -- EDT
select cron.schedule('trigger-fomc-2026-10-28', '0 18 28 10 *', $$select public.trigger_rate_check_dispatch('US', '0,5,15,30,60,120');$$); -- EDT
select cron.schedule('trigger-fomc-2026-12-09', '0 19 9 12 *', $$select public.trigger_rate_check_dispatch('US', '0,5,15,30,60,120');$$); -- EST

-- 3) 금통위 2026 발표일 집중 확인 (한국시간 09:00 발표 = UTC 00:00, 서머타임 없음).
select cron.schedule('trigger-mpc-2026-01-15', '0 0 15 1 *', $$select public.trigger_rate_check_dispatch('KR', '0,5,15,30,60,120');$$);
select cron.schedule('trigger-mpc-2026-02-26', '0 0 26 2 *', $$select public.trigger_rate_check_dispatch('KR', '0,5,15,30,60,120');$$);
select cron.schedule('trigger-mpc-2026-04-10', '0 0 10 4 *', $$select public.trigger_rate_check_dispatch('KR', '0,5,15,30,60,120');$$);
select cron.schedule('trigger-mpc-2026-05-28', '0 0 28 5 *', $$select public.trigger_rate_check_dispatch('KR', '0,5,15,30,60,120');$$);
select cron.schedule('trigger-mpc-2026-07-16', '0 0 16 7 *', $$select public.trigger_rate_check_dispatch('KR', '0,5,15,30,60,120');$$);
select cron.schedule('trigger-mpc-2026-08-27', '0 0 27 8 *', $$select public.trigger_rate_check_dispatch('KR', '0,5,15,30,60,120');$$);
select cron.schedule('trigger-mpc-2026-10-22', '0 0 22 10 *', $$select public.trigger_rate_check_dispatch('KR', '0,5,15,30,60,120');$$);
select cron.schedule('trigger-mpc-2026-11-26', '0 0 26 11 *', $$select public.trigger_rate_check_dispatch('KR', '0,5,15,30,60,120');$$);

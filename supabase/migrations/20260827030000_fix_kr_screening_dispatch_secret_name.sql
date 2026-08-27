-- 20260827020000에서 Vault 시크릿 이름을 소문자(github_actions_pat)로 만들었는데,
-- 이 저장소가 쓰는 다른 배치 시크릿(KIS_APP_KEY, SUPABASE_SERVICE_ROLE_KEY 등)이
-- 전부 대문자 규칙이라 거기 맞춰 대문자(GITHUB_ACTIONS_PAT)로 통일한다. SQL 문자열은
-- 대소문자를 구분하므로 이름이 안 맞으면 함수가 시크릿을 못 찾고 조용히 건너뛴다.
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
  where name = 'GITHUB_ACTIONS_PAT'
  limit 1;

  if v_token is null then
    raise warning 'GITHUB_ACTIONS_PAT 시크릿이 없어 국내 스크리닝 워크플로 트리거를 건너뜁니다.';
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

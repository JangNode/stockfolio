-- [등록 보류 중 — 스케줄만 평일 10:00 KST로 바꿔 둔 문서. 평일 휴장일 처리(아래 참고)가 확정되면 승인 후 Supabase 관리 API(SQL 실행)로 이 파일과 같은 내용을 한 번 실행]
-- 시장 국면 일일 배치(.github/workflows/market-regime.yml)를 평일 10:00 KST(= 01:00 UTC)에 pg_cron이
-- workflow_dispatch로 직접 호출한다. 시각을 아침으로 잡은 이유: 관측상 KRX Open API의 전 거래일 자료는 다음 영업일 이른 아침엔 아직 없고
-- (2026-10-26 월요일 07:13 KST에는 금요일 자료가 없었고 09:36 KST에는 있었다. 공식 공표 시각은 확인하지 못함) 10시면 직전 거래일 지수·종목 시세를
-- 받을 수 있다고 보며, 평일 14:00~15:40 KST KIS 호출 금지 시간대와도 겹치지 않는다. 자료가 아직 없으면 배치는 저장 없이 오류를 남기고 끝난다. 정시성 때문에 GitHub Actions
-- 네이티브 schedule 대신 이 방식을 쓴다(SKILLS.md 배치 스케줄링 원칙, 시장 브리핑·스크리닝과 같은 패턴).
-- supabase/migrations 밖에 둔 이유: 마이그레이션 적용 워크플로가 이 파일까지 실행해 예약이 먼저 등록되는 일을 막기 위해서다.
-- GITHUB_ACTIONS_PAT Vault 시크릿은 이미 존재한다(다른 배치가 사용 중) — 새로 만들 시크릿은 없다.
-- 선행 조건: 1) 이 브랜치 병합(워크플로 파일이 main에 있어야 dispatch 가능) 2) market_regime_daily 마이그레이션 적용 3) 이력 백필 완료.
create or replace function public.trigger_market_regime_dispatch()
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
    raise warning 'GITHUB_ACTIONS_PAT 시크릿이 없어 시장 국면 워크플로 트리거를 건너뜁니다.';
    return;
  end if;

  perform net.http_post(
    url := 'https://api.github.com/repos/JangNode/stockfolio/actions/workflows/market-regime.yml/dispatches',
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

revoke execute on function public.trigger_market_regime_dispatch() from public, anon, authenticated;

-- 평일(월~금) 01:00 UTC = 10:00 KST.
-- 주의(미해결): 평일 휴장일 H에 이 배치가 돌면 기준일은 "H 이전 마지막 개장일"인데, 그 자료는 H 아침에 아직 공표되지 않았을 가능성이 크다
-- (KRX 자료는 영업일 아침에 올라오는 것으로 관측됨). 그러면 scripts/market-regime.ts가 "KOSPI 지수 종가가 없습니다"로 저장 없이 오류 종료한다
-- (다음 영업일 실행이 밀린 날을 따라잡아 자동 복구되지만, 그날 워크플로가 실패로 표시되고 카드에 "최근 일일 계산 오류"가 뜬다).
-- 해결안(승인 대기): trigger_market_regime_dispatch()가 krx_trading_calendar에서 오늘(KST)이 휴장일이면 dispatch를 건너뛴다(캘린더에 없으면 거래일로 간주).
select cron.schedule(
  'trigger-market-regime',
  '0 1 * * 1-5',
  $$select public.trigger_market_regime_dispatch();$$
);

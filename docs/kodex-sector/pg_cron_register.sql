-- KODEX 200 + 업종 모멘텀 월간 신호 배치(.github/workflows/kodex-sector-signal.yml)를 평일 10:00 KST(= 01:00 UTC)에 pg_cron이
-- workflow_dispatch로 직접 호출한다. 등록은 사용자 승인 후 Supabase 관리 API(SQL 실행)로 이 파일 내용을 그대로 한 번 실행한다.
-- 신호는 매월 첫 거래일 오전에 전월 마지막 거래일 종가 기준으로 계산하고, 매매는 그날(첫 거래일) 종가다 — 장 마감 전에 신호가 나와야 해서
-- 몇 시간 밀리면 안 되는 작업이라 GitHub schedule 대신 pg_cron을 쓴다(SKILLS.md "배치 스케줄링 방식 선택").
-- 시각을 10:00으로 잡은 이유: 관측상 KRX Open API의 전 거래일 자료는 다음 영업일 이른 아침엔 아직 없고
-- (2026-10-26 월요일 07:13 KST에는 금요일 자료가 없었고 09:36 KST에는 있었다. 공식 공표 시각은 확인하지 못함) 10시면 직전 거래일 시세를
-- 받을 수 있다고 보며, 시장 국면 일일 배치(평일 10:00 KST)와 같은 시각이다. 평일 14:00~15:40 KST KIS 호출 금지 시간대와도 겹치지 않는다.
-- 자료가 아직 없으면 배치는 저장 없이 오류를 남기고 끝난다(수동 복구: 워크플로 signal_date 입력).
-- supabase/migrations 밖에 둔 이유: 마이그레이션 적용 워크플로가 이 파일까지 실행해 예약이 테이블 적용과 함께 먼저 등록되는 일을 막기 위해서다(시장 국면과 같은 방식).
-- 선행 조건: 1) 워크플로 파일이 main에 있어야 dispatch 가능 2) kodex_sector_* 마이그레이션 적용 3) GITHUB_ACTIONS_PAT Vault 시크릿(이미 존재, 다른 배치가 사용 중).
--
-- 첫 거래일 판정: 평일마다 부르면 월 21번쯤은 빈 워크플로가 뜨므로 SQL에서 먼저 거른다. kodex_sector_should_dispatch(p_date)는
--  (1) 오늘(KST)이 krx_trading_calendar상 개장일이고(캘린더에 없으면 개장으로 간주 — lib/krxTradingCalendar.ts isKrxTradingDay와 같은 fail-open),
--  (2) 직전 개장일(10일 안)이 이번 달보다 이른 달일 때만 true다. 직전 개장일을 캘린더에서 못 찾으면(매년 1월 2일 캘린더가 오늘부터로 통째로 교체돼
--  전년도 말일이 없는 1월 첫 거래일) true로 보내고, 최종 판정은 scripts/kodex-sector-signal.ts가 한다(스크립트의 판정은 그대로 유지 — 수동 실행·SQL을 통과한 경우의 두 번째 방어선).
-- 판정만 따로 확인할 수 있다(예: select public.kodex_sector_should_dispatch('2026-11-02'); → true, '2026-11-03' → false, 휴장일 → false).
create or replace function public.kodex_sector_should_dispatch(p_date date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select is_open from public.krx_trading_calendar where trade_date = p_date), true)
    and coalesce(
      (select date_trunc('month', max(trade_date)::timestamp) < date_trunc('month', p_date::timestamp)
         from public.krx_trading_calendar
        where is_open and trade_date < p_date and trade_date >= p_date - 10),
      true);
$$;

revoke execute on function public.kodex_sector_should_dispatch(date) from public, anon, authenticated;

create or replace function public.trigger_kodex_sector_signal_dispatch()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  if not public.kodex_sector_should_dispatch((now() at time zone 'Asia/Seoul')::date) then
    raise notice '오늘(KST)은 휴장일이거나 그 달 첫 거래일이 아니라 KODEX 업종 모멘텀 신호 워크플로 트리거를 건너뜁니다.';
    return;
  end if;

  select decrypted_secret into v_token
  from vault.decrypted_secrets
  where name = 'GITHUB_ACTIONS_PAT'
  limit 1;

  if v_token is null then
    raise warning 'GITHUB_ACTIONS_PAT 시크릿이 없어 KODEX 업종 모멘텀 신호 워크플로 트리거를 건너뜁니다.';
    return;
  end if;

  perform net.http_post(
    url := 'https://api.github.com/repos/JangNode/stockfolio/actions/workflows/kodex-sector-signal.yml/dispatches',
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

revoke execute on function public.trigger_kodex_sector_signal_dispatch() from public, anon, authenticated;

-- 평일(월~금) 01:00 UTC = 10:00 KST.
select cron.schedule(
  'trigger-kodex-sector-signal',
  '0 1 * * 1-5',
  $$select public.trigger_kodex_sector_signal_dispatch();$$
);

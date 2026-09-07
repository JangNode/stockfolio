-- v1(reversal_breakout)과 나란히 비교하기 위한 실험 전략, 역배열비율만 0.9로 강화,
-- v1은 절대 수정하지 않음, 2026-09-06.
--
-- "급등주 찾기 v2"(역배열 반등 - 강화) 전략을 기존 모든 계정에 하나씩 추가한다.
-- 20260831020000_seed_reversal_breakout_strategy.sql과 동일 패턴이다. 기준값(이동평균
-- 기간, 매집봉/전환 신호 임계값)은 v1과 동일하게 lib/reversalBreakoutConfig.ts 상수에서
-- 관리되고, 역배열비율 임계값만 REVERSAL_BREAKOUT_V2_MIN_INVERSE_RATIO(0.9)로 다르다.
-- rule_params는 비워둔다(손절/익절만 필요하면 나중에 채울 수 있다 — 지정 안 하면
-- 기본값 7%/20% 적용).
insert into public.strategies (user_id, name, rule_type, rule_params, market)
select u.id, '급등주 찾기 v2 (역배열 반등 - 강화)', 'reversal_breakout_v2', '{}'::jsonb, 'KR'
from auth.users u
where not exists (
  select 1
  from public.strategies s
  where s.user_id = u.id
    and s.rule_type = 'reversal_breakout_v2'
    and s.market = 'KR'
);

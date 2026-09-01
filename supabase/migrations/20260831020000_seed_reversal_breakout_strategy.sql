-- "급등주 찾기(역배열 반등)" 전략을 기존 모든 계정에 하나씩 추가한다. DH전략/PEG전략과
-- 같은 방식(20260828030000_seed_dh_value_dividend_strategy.sql 참고)이다. 기준값
-- (이동평균 기간, 역배열/매집봉/전환 신호 임계값)은 lib/reversalBreakoutConfig.ts
-- 상수에서 관리되므로 rule_params는 비워둔다(손절/익절만 필요하면 나중에 채울 수
-- 있다 — 지정 안 하면 기본값 7%/20% 적용).
insert into public.strategies (user_id, name, rule_type, rule_params, market)
select u.id, '급등주 찾기(역배열 반등)', 'reversal_breakout', '{}'::jsonb, 'KR'
from auth.users u
where not exists (
  select 1
  from public.strategies s
  where s.user_id = u.id
    and s.rule_type = 'reversal_breakout'
    and s.market = 'KR'
);

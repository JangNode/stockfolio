-- DH전략과 같은 이유로(20260828030000_seed_dh_value_dividend_strategy.sql 참고)
-- 기존 모든 계정에 피터린치 PEG전략을 하나씩 추가한다. 기준값(PEG_MAX_RATIO)은
-- lib/pegConfig.ts 상수에서 관리되므로 rule_params는 비워둔다.
insert into public.strategies (user_id, name, rule_type, rule_params, market)
select u.id, '피터린치 PEG전략', 'peg_lynch', '{}'::jsonb, 'KR'
from auth.users u
where not exists (
  select 1
  from public.strategies s
  where s.user_id = u.id
    and s.rule_type = 'peg_lynch'
    and s.market = 'KR'
);

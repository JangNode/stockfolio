-- 기존 전략들(ma_cross 등)은 전용 생성 API 없이 이렇게 마이그레이션으로 계정에
-- 심어져 왔다(20260820020000_seed_us_strategies_from_kr.sql 참고). DH전략도 같은
-- 방식으로 기존 모든 계정에 하나씩 추가한다. 기준값(시가총액/PER/PBR/배당 연속연수)은
-- lib/dhStrategyConfig.ts 상수에서 관리되므로 rule_params는 비워둔다(손절/익절만
-- 필요하면 나중에 채울 수 있다 — 지정 안 하면 기본값 7%/20% 적용).
insert into public.strategies (user_id, name, rule_type, rule_params, market)
select u.id, 'DH전략(대형 배당·가치주)', 'dh_value_dividend', '{}'::jsonb, 'KR'
from auth.users u
where not exists (
  select 1
  from public.strategies s
  where s.user_id = u.id
    and s.rule_type = 'dh_value_dividend'
    and s.market = 'KR'
);

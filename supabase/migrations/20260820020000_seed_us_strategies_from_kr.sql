-- 미국주식 스크리닝 배치(scripts/screen-us-stocks.ts)가 market='US' 전략이 하나도
-- 없으면 스캔할 대상이 없어 매번 건너뛴다. 일단 국내 전략과 동일한 조건(rule_type/
-- rule_params)으로 사용자별 미국 전략을 추가해 배치가 바로 동작하도록 한다. rule_params는
-- 이동평균 기간(일수)·손절/익절 비율(%)만 담고 있어 통화 단위가 없으므로 그대로
-- 복제해도 조건 의미가 국내/미국 양쪽에서 동일하다.
insert into public.strategies (user_id, name, rule_type, rule_params, market)
select s.user_id, s.name, s.rule_type, s.rule_params, 'US'
from public.strategies s
where s.market = 'KR'
  and not exists (
    select 1
    from public.strategies us
    where us.user_id = s.user_id
      and us.market = 'US'
      and us.rule_type = s.rule_type
      and us.rule_params = s.rule_params
  );

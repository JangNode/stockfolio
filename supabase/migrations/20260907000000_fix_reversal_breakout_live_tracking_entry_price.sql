-- 버그 수정(2026-09-07 발견): lib/backtest.ts의 computeReversalBreakoutEntryPrice가
-- reversal_breakout/reversal_breakout_v2의 entry_price를 minervini_trend_template/
-- custom_composite와 같은 방식(최근 20거래일 고점)으로 계산해 왔다. 하지만 이 두
-- 전략은 "신호 조건 자체(MA20 돌파 시점 포함)가 곧 매수 시점"이라 신호일 종가에
-- 매수해야 한다 — entry_price(피봇가)가 signal_price(신호일 종가)보다 항상 크거나
-- 같아서, 손절선이 명목 7%보다 훨씬 타이트해지고 익절선은 20%보다 훨씬 멀어져
-- 왜곡된 라이브 실적(승률 0%, 평균 -14.75%)이 나왔다. 코드 수정(lib/backtest.ts의
-- computeReversalBreakoutEntryPrice → 신호일 종가 반환)과 함께, 이미 저장된 active
-- 행의 entry_price/stop_loss_price/take_profit_price/return_pct/status를 올바른
-- 기준으로 다시 계산한다. closed(stopped/profited) 행은 별도로
-- scripts/replay-reversal-breakout-closed-results.ts가 일별 시세를 재생해 바로잡는다
-- (SQL만으로는 그 기간의 일별 시세를 순회할 수 없어 이 마이그레이션 범위에서 뺐다).
--
-- 손절/익절 기본값(7%/20%)은 lib/backtest.ts의 DEFAULT_STOP_LOSS_PCT/
-- DEFAULT_TAKE_PROFIT_PCT와 정확히 같은 값을 하드코딩한다 — 그 상수가 바뀌면 이
-- 마이그레이션의 의도(당시 기본값 기준 보정)와는 별개이므로 다시 볼 필요는 없지만,
-- 값 자체가 다르면 이 마이그레이션이 계산한 손절/익절가가 실제 라이브 배치와
-- 어긋난다는 점은 기록해 둔다.
with target as (
  select
    sr.id,
    sr.signal_price,
    coalesce((s.rule_params->>'stop_loss_pct')::numeric, 0.07) as stop_pct,
    coalesce((s.rule_params->>'take_profit_pct')::numeric, 0.2) as take_pct,
    sr.current_price
  from public.screening_results sr
  join public.strategies s on s.id = sr.strategy_id
  where sr.status = 'active'
    and s.rule_type in ('reversal_breakout', 'reversal_breakout_v2')
),
computed as (
  select
    id,
    signal_price as new_entry_price,
    signal_price * (1 - stop_pct) as new_stop_loss_price,
    signal_price * (1 + take_pct) as new_take_profit_price,
    (current_price - signal_price) / signal_price * 100 as new_return_pct,
    case
      when current_price <= signal_price * (1 - stop_pct) then 'stopped'
      when current_price >= signal_price * (1 + take_pct) then 'profited'
      else 'active'
    end as new_status
  from target
)
update public.screening_results sr
set
  entry_price = c.new_entry_price,
  stop_loss_price = c.new_stop_loss_price,
  take_profit_price = c.new_take_profit_price,
  return_pct = c.new_return_pct,
  status = c.new_status,
  closed_at = case when c.new_status <> 'active' then now() else null end
from computed c
where sr.id = c.id;

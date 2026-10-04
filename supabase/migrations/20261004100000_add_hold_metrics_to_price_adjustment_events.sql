-- 보류된 조정계수 이벤트(low_confidence, 사유 'post_ratio_out_of_range')를 나중에 점검할 수 있도록
-- 점검용 지표 컬럼을 추가한다(모두 nullable, 보류 이벤트에만 채움). 기존 행·데이터는 건드리지 않는다.
alter table public.stock_price_adjustment_events
  add column post_adjust_close_ratio numeric,
  add column halt_trading_days integer,
  add column resume_day_change_pct numeric,
  add column follow_5d_change_pct numeric;

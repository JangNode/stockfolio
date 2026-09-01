-- AI 모의투자 4번째 독립 스타일 "급등주"(style: 'surge_stock')를 추가한다. 공격형/
-- 안정형(매일 라우틴이 재생성)과 custom(실험실 채택 플로우가 채움)과 달리, 이 스타일은
-- 고정 조건 전략이라 data/paper-strategies/surge_stock.json 파일 자체가 존재하지
-- 않는다 — scripts/paper-trade.ts의 determineStrategyForToday는 파일이 없으면 항상
-- 기존 활성 전략을 그대로 유지하므로, "채택" 플로우 없이 이 마이그레이션이 처음이자
-- 유일하게 활성 paper_strategies 행을 직접 채워 넣는다.
--
-- 20260825000000_add_custom_backtest_runs.sql(제약 넓히기)과
-- 20260825020000_seed_custom_paper_portfolio.sql(계좌 시딩) 두 마이그레이션을 합친
-- 패턴이다. STYLES 배열(scripts/paper-trade.ts, lib/paperStrategy.ts,
-- components/PaperTrading.tsx)에 'surge_stock'을 추가하는 코드 변경과 이 마이그레이션은
-- 반드시 같은 배포에 함께 들어가야 한다 — paper-trade.ts의 loadPortfolios()가
-- "스타일x시장 개수만큼 정확히 있어야 한다" 가드를 쓰기 때문이다.

-- 1) style CHECK 제약 넓히기.
alter table public.paper_strategies drop constraint if exists paper_strategies_style_check;
alter table public.paper_strategies add constraint paper_strategies_style_check
  check (style in ('aggressive', 'conservative', 'custom', 'surge_stock'));

alter table public.paper_portfolios drop constraint if exists paper_portfolios_style_check;
alter table public.paper_portfolios add constraint paper_portfolios_style_check
  check (style in ('aggressive', 'conservative', 'custom', 'surge_stock'));

-- 2) 4번째 계좌 슬롯('surge_stock'). 기존 aggressive/conservative/custom과 같은 초기
-- 자본 관례(국내 100만원, 미국 1,000달러)를 따른다.
insert into public.paper_portfolios (style, market, initial_capital, cash)
values
  ('surge_stock', 'KR', 1000000, 1000000),
  ('surge_stock', 'US', 1000, 1000)
on conflict (style, market) do nothing;

-- 3) 활성 paper_strategies 행 최초 시딩. reversal_breakout 스크리닝 신호만 매수 후보로
-- 삼는 고정 조건이다(lib/paperStrategy.ts의 PaperStrategyConditionsSchema와 같은 형태).
insert into public.paper_strategies (
  style, version, label, entry_conditions, exit_conditions, stock_selection_criteria,
  rationale, model, raw_response, is_active
)
select
  'surge_stock',
  1,
  '급등주 찾기(역배열 반등)',
  '{"source_rule_types": ["reversal_breakout"], "min_signal_return_pct": -5, "max_signal_return_pct": 15, "max_positions": 5, "position_size_pct": 20}'::jsonb,
  '{"take_profit_pct": 20, "stop_loss_pct": 8, "max_holding_days": 30}'::jsonb,
  '{"prefer_higher_return_pct": false, "max_candidates_to_consider": 10}'::jsonb,
  '역배열 상태에서 대량 거래를 동반한 매집 후 20일선을 돌파하는 전환 시점을 포착하는 고정 조건 전략입니다. 공격형/안정형과 달리 매일 재생성되지 않고, reversal_breakout 스크리닝 신호만 매수 후보로 삼습니다.',
  'fixed-config',
  null,
  true
where not exists (
  select 1 from public.paper_strategies where style = 'surge_stock' and is_active
);

-- AI 모의투자 5번째 독립 스타일 "실험조합형"(style: 'experimental_blend')을 추가한다.
-- 2016~2026년 백테스트(scripts/diagnose-portfolio-allocation-simulation.ts 실행분)로
-- 5개 스크리닝 전략(ma_cross/minervini_trend_template/custom_composite/peg_lynch/
-- reversal_breakout·v2)의 상관관계·MDD를 분석한 결과, minervini_trend_template(추세
-- 추종) + peg_lynch(펀더멘털) + reversal_breakout(소액 위성)을 54:36:10 비중으로 섞은
-- 조합이 CAGR 17.3%/MDD 29.6%로 가장 우수했다. 이를 실제 라이브 매매로 검증하기 위한
-- 스타일이다 — 다만 이 조합은 백테스트 기반이라 라이브 검증 이력이 없다("실험조합형"
-- 이름과 화면 안내 문구로 안정형/공격형과 명확히 구분한다).
--
-- surge_stock과 마찬가지로 고정 조건 전략이라 data/paper-strategies/experimental_blend.json
-- 파일 자체가 존재하지 않는다 — scripts/paper-trade.ts의 determineStrategyForToday는
-- 파일이 없으면 항상 기존 활성 전략을 그대로 유지하므로, "채택" 플로우 없이 이
-- 마이그레이션이 처음이자 유일하게 활성 paper_strategies 행을 직접 채워 넣는다
-- (20260831030000_seed_surge_stock_paper_style.sql과 완전히 같은 패턴).
--
-- minervini_trend_template/peg_lynch/reversal_breakout은 이미 strategies 테이블에
-- 활성 행이 있고 매일 스크리닝되고 있어(각각 20260828040000_seed_peg_lynch_strategy.sql
-- 등으로 시딩됨) 이 마이그레이션은 strategies 테이블을 건드리지 않는다 — 오직
-- paper_portfolios/paper_strategies(AI 모의투자 레이어)만 시딩한다.
--
-- rule_type별 목표비중(54:36:10)은 이 시딩 JSON이 아니라 lib/experimentalBlendConfig.ts
-- 상수로 매수 시점마다 코드가 게이팅한다("고정비중 게이팅" — 목표 미달인 rule_type의
-- 후보만 매수 대상으로 남기고, 초과분을 파는 강제 리밸런싱은 하지 않는다). 아래
-- entry_conditions는 그 게이팅을 통과한 후보 안에서 얼마나/몇 개씩 살지에 대한 일반
-- 값이다 — max_positions을 18로 넉넉히 잡아야 게이팅이 실제로 54:36:10에 근접하게
-- 채울 여유가 생긴다.
--
-- peg_lynch/reversal_breakout이 KR 전용 전략이라 이 스타일은 US 계좌를 만들 수 없다
-- (US 시장에 존재하지 않는 원 전략이라 신호 자체가 없음) — 이번 스타일만의 예외다.
-- lib/paperStyles.ts의 PAPER_STYLE_MARKETS와 scripts/paper-trade.ts의
-- loadPortfolios()가 이 예외("스타일별로 기대 시장이 다를 수 있다")를 함께 반영하는
-- 코드 변경과 이 마이그레이션은 반드시 같은 배포에 함께 들어가야 한다.

-- 1) style CHECK 제약 넓히기.
alter table public.paper_strategies drop constraint if exists paper_strategies_style_check;
alter table public.paper_strategies add constraint paper_strategies_style_check
  check (style in ('aggressive', 'conservative', 'custom', 'surge_stock', 'experimental_blend'));

alter table public.paper_portfolios drop constraint if exists paper_portfolios_style_check;
alter table public.paper_portfolios add constraint paper_portfolios_style_check
  check (style in ('aggressive', 'conservative', 'custom', 'surge_stock', 'experimental_blend'));

-- 2) 5번째 계좌 슬롯('experimental_blend'). KR 전용이라 US 행은 만들지 않는다.
insert into public.paper_portfolios (style, market, initial_capital, cash)
values
  ('experimental_blend', 'KR', 1000000, 1000000)
on conflict (style, market) do nothing;

-- 3) 활성 paper_strategies 행 최초 시딩. minervini_trend_template/peg_lynch/
-- reversal_breakout 세 원 스크리닝 전략의 신호만 매수 후보로 삼는 고정 조건이다
-- (lib/paperStrategy.ts의 PaperStrategyConditionsSchema와 같은 형태). rule_type별
-- 목표비중 게이팅은 코드(lib/experimentalBlendConfig.ts)가 담당하므로 이 JSON에는
-- 없다.
insert into public.paper_strategies (
  style, version, label, entry_conditions, exit_conditions, stock_selection_criteria,
  rationale, model, raw_response, is_active
)
select
  'experimental_blend',
  1,
  '실험조합형(minervini 54% : peg_lynch 36% : reversal_breakout 10%)',
  '{"source_rule_types": ["minervini_trend_template", "peg_lynch", "reversal_breakout"], "min_signal_return_pct": -5, "max_signal_return_pct": 15, "max_positions": 18, "position_size_pct": 8}'::jsonb,
  '{"take_profit_pct": 15, "stop_loss_pct": 10, "max_holding_days": 30}'::jsonb,
  '{"prefer_higher_return_pct": false, "max_candidates_to_consider": 30}'::jsonb,
  '2016~2026년 백테스트에서 5개 스크리닝 전략(ma_cross, minervini_trend_template, custom_composite, peg_lynch, reversal_breakout·v2)의 상관관계와 MDD를 분석한 결과, 추세추종(minervini_trend_template) 54% + 펀더멘털(peg_lynch) 36% + 소액 위성(reversal_breakout) 10% 조합이 CAGR 17.3%/MDD 29.6%로 가장 우수했습니다. 이 스타일은 그 조합을 실제 라이브 매매로 검증하기 위한 것으로, 매수 시점마다 rule_type별 목표비중 미달 여부만 확인하는 "고정비중 게이팅"을 적용하고 강제 리밸런싱은 하지 않습니다. 청산조건(익절 15%/손절 10%/최대보유 30일)은 급등주 스타일 백테스트에서 검증된 값을 그대로 재사용합니다. 다만 이 조합 자체는 백테스트 기반이라 아직 라이브 검증 이력이 없다는 점에 유의해야 합니다.',
  'fixed-config',
  null,
  true
where not exists (
  select 1 from public.paper_strategies where style = 'experimental_blend' and is_active
);

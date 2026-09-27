-- "실험조합형"(experimental_blend) 목표비중을 54:36:10 → 57:38:5로 조정한 데 맞춰
-- 20260924080000_seed_experimental_blend_paper_style.sql이 심어둔 활성
-- paper_strategies 행의 label/rationale(화면에 노출되는 설명 문구)을 업데이트한다.
-- 그 마이그레이션 자체는 이미 적용됐으므로 수정하지 않고(RULES.md 5번), 이 새
-- 마이그레이션으로 UPDATE만 한다.
--
-- 조정 근거(2026-09-27 재검증): 장기 백테스트(strategy_backtest_summary)에서
-- reversal_breakout은 상위 3개 종목만 제외해도 CAGR이 26.9%→3.1%(89% 증발)로
-- 무너지는 것으로 확인됐다(5개 제외 시 -3.1%로 부호까지 반전 — 기존에 알려졌던
-- 것보다 더 취약한 구조). scripts/diagnose-portfolio-allocation-simulation.ts
-- 재실행 결과, reversal_breakout 비중을 10%→5%로 낮춰도 MDD 방어 효과는 거의
-- 그대로 유지된다(29.6%→29.7%, 사실상 동일 — 분산 효과가 이미 5%에서 대부분
-- 실현됨). 반면 10%가 주던 추가 CAGR(17.3%→15.2%로 하락)은 상당 부분 그 소수
-- 잭팟 트레이드 의존분이었을 가능성이 커, 완전히 빼지 않고 5%로 최소화해
-- 상방 가능성만 남겨둔다. rule_type별 목표비중 게이팅 로직 자체(코드)는
-- lib/experimentalBlendConfig.ts의 EXPERIMENTAL_BLEND_TARGET_WEIGHTS 상수
-- 변경만으로 반영되고(같은 배포에 함께 들어감), 이 마이그레이션은 그 변경과
-- 화면에 보이는 설명 문구를 맞추는 목적만 가진다 — 게이팅 로직 자체는 건드리지
-- 않는다.
update public.paper_strategies
set
  label = '실험조합형(minervini 57% : peg_lynch 38% : reversal_breakout 5%)',
  rationale = '2016~2026년 백테스트에서 5개 스크리닝 전략(ma_cross, minervini_trend_template, custom_composite, peg_lynch, reversal_breakout·v2)의 상관관계와 MDD를 분석한 결과, 추세추종(minervini_trend_template) 57% + 펀더멘털(peg_lynch) 38% + 소액 위성(reversal_breakout) 5% 조합이 누적수익률 357.4%/CAGR 15.2%/MDD 29.7%로 확인됐습니다. 이전에는 reversal_breakout을 10% 비중으로 섞었을 때(CAGR 17.3%/MDD 29.6%)가 가장 우수했지만, 이후 재검증에서 reversal_breakout은 상위 3개 종목만 제외해도 CAGR이 89% 증발할 만큼 소수 종목 의존도가 큰 것으로 확인돼 비중을 낮췄습니다 — reversal_breakout이 주는 MDD 분산 효과는 5% 비중에서 이미 대부분 확보되고, 10%로 늘려도 MDD는 거의 개선되지 않는 반면(29.6%→29.7%) 그만큼의 추가 CAGR은 소수 잭팟 트레이드 의존분일 가능성이 커, 완전히 배제하지 않고 최소 비중(5%)만 남겼습니다. 이 스타일은 그 조합을 실제 라이브 매매로 검증하기 위한 것으로, 매수 시점마다 rule_type별 목표비중 미달 여부만 확인하는 "고정비중 게이팅"을 적용하고 강제 리밸런싱은 하지 않습니다. 청산조건(익절 15%/손절 10%/최대보유 30일)은 급등주 스타일 백테스트에서 검증된 값을 그대로 재사용합니다. 다만 이 조합 자체는 백테스트 기반이라 아직 라이브 검증 이력이 없다는 점에 유의해야 합니다.'
where style = 'experimental_blend' and is_active;

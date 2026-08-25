-- 실험실 탭에서 채택한 커스텀 전략이 굴릴 3번째 가상 계좌 슬롯('custom'). 기존
-- aggressive/conservative와 같은 초기 자본 관례(국내 100만원, 미국 1,000달러)를
-- 따른다. paper_strategies.style은 채택 시점(app/api/lab/backtest/[id]/adopt)에
-- 처음 채워지므로 여기서는 계좌만 미리 만들어 둔다 — scripts/paper-trade.ts의
-- loadPortfolios()가 "스타일x시장 개수만큼 있어야 한다" 가드를 쓰므로, STYLES 배열에
-- 'custom'을 추가하는 커밋과 이 시딩은 반드시 같은 배포에 함께 들어가야 한다.
insert into public.paper_portfolios (style, market, initial_capital, cash)
values
  ('custom', 'KR', 1000000, 1000000),
  ('custom', 'US', 1000, 1000)
on conflict (style, market) do nothing;

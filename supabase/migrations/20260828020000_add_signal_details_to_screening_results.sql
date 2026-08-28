-- DH전략처럼 단일 시점 재무 스냅샷으로 판정하는 전략은 "왜 매칭됐는지"가 가격/거래량
-- 지표만으로는 설명이 안 된다(이동평균 골든크로스 같은 조건과 달리, screening_results의
-- 기존 컬럼만으론 시가총액/PER/PBR/배당 지급 연도를 알 수 없다). 판단 근거를 남겨
-- 나중에 확인할 수 있게 jsonb 컬럼을 추가한다. rule_type마다 담는 내용이 다를 수 있어
-- 스키마를 고정하지 않는다 — dh_value_dividend는
-- {market_cap_eok, per, pbr, dividend_years_paid} 형태로 채운다
-- (scripts/screen-all-stocks.ts의 buildFundamentalSignalDetails 참고). 기존 가격 기반
-- 전략(ma_cross 등)은 이 컬럼을 채우지 않아 null로 남는다.
alter table public.screening_results
  add column if not exists signal_details jsonb;

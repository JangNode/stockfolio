-- dart_quarterly_fundamentals에 XBRL 백필(FY2011~2015)용 source 컬럼을 추가하고 status 허용값을 넓힌다.
-- source: 'singl' = fnlttSinglAcntAll(FY2016~), 'xbrl' = fnlttXbrl.xml(FY2011~2015). 기존 행은 'singl'로만 채운다(다른 값은 바꾸지 않는다).
-- status 허용값에 no_report(list.json에 해당 분기 보고서 없음)·xbrl_014(fnlttXbrl 파일 없음)를 추가한다(기존 값은 모두 그대로 허용).
alter table public.dart_quarterly_fundamentals
  add column if not exists source text check (source in ('singl', 'xbrl'));

update public.dart_quarterly_fundamentals set source = 'singl' where source is null;

alter table public.dart_quarterly_fundamentals drop constraint if exists dart_quarterly_fundamentals_status_check;
alter table public.dart_quarterly_fundamentals
  add constraint dart_quarterly_fundamentals_status_check
  check (status in ('ok', 'no_data_013', 'error', 'no_report', 'xbrl_014'));

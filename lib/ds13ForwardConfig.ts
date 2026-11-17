// 연구 DS13L·DS13M 포워드 관찰 기준값. 사용자 지정 2026-11-17. 정의 동결 문서: docs/research/ds13-forward-freeze.md (커밋 3e8a2c1).
// 관찰은 시험이 아니다(누적 시험 310 유지, DS13M 309·DS13L 310). 정의는 ds13-prereg.md(74838e1)와 같고, 관찰 결과로 바꾸지 않는다.
/** 정의 동결 커밋과 사전등록·결과 커밋. */
export const DS13F_FREEZE_COMMIT = "3e8a2c1";
export const DS13F_DEF_COMMITS = ["74838e1", "d098622", "3e8a2c1"] as const;
/** 포워드 시작: 이 날짜(동결 커밋일) 종가까지는 시험 구간 이후·관찰 이전이다. 기록은 다음 거래일부터, 시작점 누적 0%. */
export const DS13F_START_AFTER = "2026-11-17";
/** 검증 단계 기록값(ds13-summary.md, 보정 적용 데이터 2011-02-01~2026-10-26; CAGR %, MDD %). 2자리 반올림 문자열이 같아야 관찰 단계로 넘어간다. */
export const DS13F_REC_FULL = { DS13L: { cagr: "12.40", mdd: "37.91" }, DS13M: { cagr: "11.57", mdd: "40.29" }, DS6: { cagr: "11.40", mdd: "39.15" } } as const;
/** 구간 1(2011-02-01~2016-12-29) 기록값. */
export const DS13F_REC_W1 = { DS13L: { cagr: "6.79", mdd: "25.01" }, DS13M: { cagr: "7.07", mdd: "21.12" }, DS6: { cagr: "3.27", mdd: "24.51" } } as const;
export const DS13F_W1_END = "2016-12-29";
/** 고정 구간 검증 단계가 남기는 일별 수익 파일(관찰 단계가 정보로 대조한다; 커밋하지 않는다). */
export const DS13F_VERIFY_FILE = ".ds6fwd/verify-ds13.json";
/** 누적 로그(전략·벤치마크 일별 수익, 하위 계좌별 열). 연구 브랜치에만 커밋한다. */
export const DS13F_LOG_CSV = "docs/research/ds13-forward-log.csv";
/** 월 신호·체결 기록(추가만 하고 이미 기록된 신호 행은 소급 수정하지 않는다). */
export const DS13F_SIGNALS_CSV = "docs/research/ds13-forward-signals.csv";
/** 제한폭 초과·조정 이벤트 없음 경고 기록(추가만). */
export const DS13F_DQ_CSV = "docs/research/ds13-forward-dq.csv";
/** 현재 보유 종목표(실행할 때마다 다시 쓴다). */
export const DS13F_HOLDINGS_MD = "docs/research/ds13-forward-holdings.md";
export const DS13F_ARTIFACT_FILES = [DS13F_LOG_CSV, DS13F_SIGNALS_CSV, DS13F_DQ_CSV, DS13F_HOLDINGS_MD] as const;
const SLEEVES = ["core", "mom", "low"] as const;
export const DS13F_CSV_HEADER = [
  "date", "ds13l_ret_pct", "ds13m_ret_pct", "ds6_ret_pct", "b069500_ret_pct",
  "ds13l_cum_pct", "ds13m_cum_pct", "ds6_cum_pct", "b069500_cum_pct",
  "ds13l_dd_pct", "ds13m_dd_pct", "ds6_dd_pct", "b069500_dd_pct",
  ...(["l", "m"] as const).flatMap((k) => [...SLEEVES.map((s) => `${k}_${s}_ret_pct`), ...SLEEVES.map((s) => `${k}_${s}_w`)]),
  "b069500_close_raw", "close_src",
].join(",");
export const DS13F_SIGNALS_HEADER = "signal_date,exec_date,sleeve,code,name,weight_in_sleeve_pct,note";
export const DS13F_DQ_HEADER = "date,code,name,adj_ret_pct,raw_ret_pct,gap_days,limit_pct,held_by,first_seen_run_end";
/** 가격제한폭 초과 탐지: 이 날짜(제외) 뒤의 행만 본다(= 검증 단계 스냅샷 데이터 끝). 탐지 기준은 lib/dataQualityConfig.ts의 DQ_LIMIT_* 를 그대로 쓴다. */
export const DS13F_DQ_AFTER = "2026-10-26";

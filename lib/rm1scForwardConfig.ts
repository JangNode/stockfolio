// RM1SC 포워드 관찰 기준값. 정의 동결 문서: docs/research/rm1sc-forward-freeze.md (사용자 지정 2026-11-26). 관찰은 시험이 아니다(누적 330 유지).
/** 포워드 시작 기준일: 다음 포워드 실행일(2026-11-28 토) 기준 가장 가까운 월말 신호일. 이 날짜 종가까지는 동결 이전이고 기록은 다음 거래일(2026-12-01)부터, 시작점 누적 0%. */
export const RM1SCF_START_AFTER = "2026-11-30";
/** 검증 단계 기록값(포워드 데이터 표준 = K200P 17건 보정만, 0% 처리 없음; 2011-02-01~2026-10-26, CAGR %, MDD %). 출처: stop-summary.md [S6] 처리 없음 열(sinfo run 45756342569). 시험 공식 표준(보정 + 0% 처리)의 RM1SC는 13.48 / 34.87. */
export const RM1SCF_REC_FULL = { cagr: "13.38", mdd: "34.87" } as const;
/** 구간 1(2011-02-01~2016-12-29) 기록값(같은 표준). */
export const RM1SCF_REC_W1 = { cagr: "9.37", mdd: "25.70" } as const;
/** 파일(연구 브랜치에만 커밋, 가격 데이터 아님). 일별 가상 수익·상태 로그는 실행마다 시뮬레이션에서 다시 쓰고(달라진 행 수 보고), 월말 후보·손절 사후 점검 로그는 추가만 한다. */
export const RM1SCF_LOG_CSV = "docs/research/rm1sc-forward-log.csv";
export const RM1SCF_STATE_CSV = "docs/research/rm1sc-forward-state.csv";
export const RM1SCF_SIGNALS_CSV = "docs/research/rm1sc-forward-signals.csv";
export const RM1SCF_STOPS_CSV = "docs/research/rm1sc-forward-stops.csv";
export const RM1SCF_FILES = [RM1SCF_LOG_CSV, RM1SCF_STATE_CSV, RM1SCF_SIGNALS_CSV, RM1SCF_STOPS_CSV] as const;
export const RM1SCF_LOG_HEADER = [
  "date", "rm1sc_ret_pct", "ds13l_ret_pct", "ds13m_ret_pct", "ds6_ret_pct", "b069500_ret_pct",
  "rm1sc_cum_pct", "ds13l_cum_pct", "ds13m_cum_pct", "ds6_cum_pct", "b069500_cum_pct",
  "rm1sc_dd_pct", "ds13l_dd_pct", "ds13m_dd_pct", "ds6_dd_pct", "b069500_dd_pct",
  "core_ret_pct", "core_w", "rm1s_ret_pct", "rm1s_w", "rm1s_cash_pct", "rm1s_n_hold", "stops_today", "b069500_close_raw", "close_src",
].join(",");
export const RM1SCF_STATE_HEADER = "date,code,name,close_adj,close_raw,peak_close_adj,dd_from_peak_pct,stop_flag,stop_level_close_adj";
export const RM1SCF_SIGNALS_HEADER = "signal_date,exec_date,rank,code,name,score,selected,target_in_sleeve_pct,target_in_account_pct,note";
export const RM1SCF_STOPS_HEADER = "type,stop_date,exec_date,code,name,peak_close_adj,stop_close_adj,exec_close_adj,exec_close_raw,ret21_pct,asof_date";
/** 손절 사후 점검: 매도 체결일 종가에서 이후 몇 거래일 수익을 보는가(stopConfig.S_NEXT_MONTH_DAYS와 같다). */
export const RM1SCF_POST_DAYS = 21;
/** 월말 후보 기록 깊이(상위 N위까지, 유지 순위 40 = 2 × 종목 수 20). */
export const RM1SCF_CAND_DEPTH = 40;

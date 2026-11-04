// 연구 DS6 포워드 관찰 기준값. 사용자 지정 2026-11-04. 문서: docs/research/ds6-forward.md
// 관찰은 시험이 아니다(시험 번호 273 유지). 정의는 시도 272의 DS6 그대로이고, 관찰 결과로 바꾸지 않는다.
// DS6 정의 상수(코어 비중·종목 수·교체 확인일·이동 비용)는 연구 DS5·DS6/시도 272의 상수(lib/ds6Pre2017Config.ts, lib/coreSatelliteConfig.ts)를 그대로 쓴다.
/** 고정 날짜(= 고정 스냅샷 데이터 종료일). 관찰 구간은 그 다음 거래일부터다. */
export const DS6F_FIXED_DATE = "2026-10-26";
/** DS6 정의 커밋: 269a30c = 연구 DS5·DS6 사전등록(DS6 정의), f7a8bc8 = 시도 272 사전등록(정의 그대로), c5cf03e = 시도 272 설정·스크립트(lib/ds6Pre2017Config.ts). */
export const DS6F_DEF_COMMITS = ["269a30c", "f7a8bc8", "c5cf03e"] as const;
/** 검증 단계 기록값(CAGR %, MDD %). 2자리 반올림 문자열이 같아야 관찰 단계로 넘어간다. */
export const DS6F_REC_A = { cagr: "4.10", mdd: "24.51" } as const; // 2011-01-04~2016-12-29(시도 272 기록)
export const DS6F_REC_FULL = { cagr: "11.70", mdd: "39.15" } as const; // 2011-01-04~2026-10-26(DS6 후속 진단 기록)
/** 069500 보조 파일 이후 날짜의 종가를 KRX로 받는 요청 상한(이 관찰 실행에서만 적용; 다른 연구 실행의 BENCH_AUX_KRX_CAP=12는 그대로). */
export const DS6F_KRX_CAP = 25;
export const DS6F_KRX_BASE = "https://data-dbg.krx.co.kr/svc/apis";
/** 관찰 실행에서 Storage 다운로드를 허용하는 연도(캐시와 다르면 이 연도만 받는다). 그 밖의 연도가 캐시와 다르면 받지 않고 중단한다. */
export const DS6F_DOWNLOAD_YEARS = "2025,2026";
/** 누적 로그(069500 종가 기억을 겸한다). 연구 브랜치에만 커밋한다. */
export const DS6F_LOG_CSV = "docs/research/ds6-forward-log.csv";
/** 검증 단계가 남기는 고정 구간 일별 수익 파일(관찰 단계가 대조한다; 커밋하지 않는다). */
export const DS6F_WORK_DIR = ".ds6fwd";
export const DS6F_VERIFY_FILE = ".ds6fwd/verify-prefix.json";
export const DS6F_SUMMARY_FILE = ".ds6fwd/summary.txt";
export const DS6F_CSV_HEADER = "date,ds6_ret_pct,b069500_ret_pct,ds6_cum_pct,b069500_cum_pct,excess_cum_pp,ds6_dd_pct,b069500_dd_pct,b069500_close_raw,close_src,core_hold,month_end_class_date";
/** 검증 단계 일별 대조에서 허용하는 최대 일수익률 차이(%p). 넘으면 정보로 보고만 한다(정지는 기록값 불일치로만). */
export const DS6F_PREFIX_INFO_TOL_PP = 1e-6;
/** 마지막 거래일 종목 수가 직전 거래일의 이 비율보다 적으면 부분 데이터 경고를 낸다. */
export const DS6F_PARTIAL_DAY_RATIO = 0.9;

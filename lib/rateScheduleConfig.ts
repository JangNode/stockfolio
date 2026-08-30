/**
 * FOMC(미국 연방공개시장위원회)/금통위(한국은행 금융통화위원회 통화정책방향 결정회의)
 * 일정. 별도 공식 API가 없어(연준·한은이 보도자료로 미리 공개하는 연간 일정을 그대로
 * 옮겨) 코드에 상수로 고정한다 — 연 1~2회, 다음 해 일정이 발표되면 이 파일과
 * supabase/migrations의 대응하는 pg_cron 마이그레이션(발표 예정 시각에 맞춰
 * trigger_rate_check_dispatch를 호출)을 함께 추가해야 한다.
 *
 * date는 실제 "발표"가 나오는 날짜다 — FOMC는 이틀짜리 회의의 둘째 날(미국 동부시간
 * 14:00 발표, 한국시간으로는 보통 다음날 새벽 3~4시경), 금통위는 회의 당일(한국시간
 * 오전 9시경 발표)이다.
 */
export interface RateAnnouncementDate {
  date: string; // YYYY-MM-DD (발표일 기준. FOMC는 한국시간 기준 발표 당일이 아니라
  // 미국 동부시간 기준 발표일 — 화면에 "다가오는 일정"으로 보여줄 때는 이 날짜를
  // 그대로 쓰되, 한국시간으로는 보통 다음날 새벽이라는 점을 라벨에 명시한다.
}

export const FOMC_SCHEDULE_2026: RateAnnouncementDate[] = [
  { date: "2026-01-28" },
  { date: "2026-03-18" },
  { date: "2026-04-29" },
  { date: "2026-06-17" },
  { date: "2026-07-29" },
  { date: "2026-09-16" },
  { date: "2026-10-28" },
  { date: "2026-12-09" },
];

export const MPC_SCHEDULE_2026: RateAnnouncementDate[] = [
  { date: "2026-01-15" },
  { date: "2026-02-26" },
  { date: "2026-04-10" },
  { date: "2026-05-28" },
  { date: "2026-07-16" },
  { date: "2026-08-27" },
  { date: "2026-10-22" },
  { date: "2026-11-26" },
];

export const FOMC_SCHEDULE: RateAnnouncementDate[] = [...FOMC_SCHEDULE_2026];
export const MPC_SCHEDULE: RateAnnouncementDate[] = [...MPC_SCHEDULE_2026];

/** AI 모의투자 스타일(포트폴리오 슬롯) 공통 정의. 서버/클라이언트 양쪽에서 다 쓰므로
 * (lib/paperStrategy.ts는 server-only) 순수 상수만 여기 따로 둔다 — 화면에 전략이
 * 나열되는 곳(개요/전략 상세/매매 내역 등)은 전부 PAPER_STYLE_ORDER를 그대로 써서,
 * 새 스타일이 추가되면 이 배열 하나만 고치면 되게 한다. */
export type PaperStyle = "aggressive" | "conservative" | "custom" | "surge_stock";

// 표시 순서: 안정형 → 공격형 → 급등주 → 커스텀(사용자 지정).
export const PAPER_STYLE_ORDER: PaperStyle[] = ["conservative", "aggressive", "surge_stock", "custom"];

export const PAPER_STYLE_LABEL: Record<PaperStyle, string> = {
  aggressive: "공격형",
  conservative: "안정형",
  custom: "커스텀",
  surge_stock: "급등주",
};

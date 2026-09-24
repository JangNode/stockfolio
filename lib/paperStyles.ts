import type { Market } from "@/lib/market";

/** AI 모의투자 스타일(포트폴리오 슬롯) 공통 정의. 서버/클라이언트 양쪽에서 다 쓰므로
 * (lib/paperStrategy.ts는 server-only) 순수 상수만 여기 따로 둔다 — 화면에 전략이
 * 나열되는 곳(개요/전략 상세/매매 내역 등)은 전부 PAPER_STYLE_ORDER를 그대로 써서,
 * 새 스타일이 추가되면 이 배열 하나만 고치면 되게 한다. */
export type PaperStyle = "aggressive" | "conservative" | "custom" | "surge_stock" | "experimental_blend";

// 표시 순서: 안정형 → 공격형 → 급등주 → 실험조합형 → 커스텀(사용자 지정).
export const PAPER_STYLE_ORDER: PaperStyle[] = [
  "conservative",
  "aggressive",
  "surge_stock",
  "experimental_blend",
  "custom",
];

export const PAPER_STYLE_LABEL: Record<PaperStyle, string> = {
  aggressive: "공격형",
  conservative: "안정형",
  custom: "커스텀",
  surge_stock: "급등주",
  experimental_blend: "실험조합형",
};

/** 스타일별로 계좌가 존재하는 시장. 대부분 KR+US 페어지만, 'experimental_blend'는
 * peg_lynch/reversal_breakout처럼 KR 전용 원 전략만 참조해 US 계좌를 만들 수 없다
 * (2026-09-24). scripts/paper-trade.ts의 loadPortfolios()가 이 맵을 기준으로 실제
 * 시딩된 (style, market) 조합이 정확한지 검증하고, 화면(components/PaperTrading.tsx)도
 * 이 맵으로 "이 스타일은 국내 전용" 안내를 판단한다. */
export const PAPER_STYLE_MARKETS: Record<PaperStyle, readonly Market[]> = {
  conservative: ["KR", "US"],
  aggressive: ["KR", "US"],
  custom: ["KR", "US"],
  surge_stock: ["KR", "US"],
  experimental_blend: ["KR"],
};

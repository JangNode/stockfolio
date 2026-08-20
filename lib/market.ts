export type Market = "KR" | "US";

export const MARKET_LABELS: Record<Market, string> = {
  KR: "국내",
  US: "미국",
};

/** 원화는 정수 단위, 달러는 소수점 둘째 자리까지 표시한다. */
export function formatPrice(value: number, market: Market): string {
  return market === "KR"
    ? value.toLocaleString("ko-KR")
    : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 통화가 아닌 수량(거래량 등)에 시장별 자릿수 구분 관례만 맞춰 표시한다. */
export function formatNumber(value: number, market: Market): string {
  return value.toLocaleString(market === "KR" ? "ko-KR" : "en-US");
}

/**
 * 화면에 숫자(퍼센트/시가총액/주식수)를 표시할 때 쓰는 공용 포맷터. 전수 조사
 * 결과(2026-09-17) 가격/거래량은 이미 lib/market.ts의 formatPrice/formatNumber로
 * 어느 정도 공용화돼 있었지만, 퍼센트 소수점 자리수·시가총액 단위(조/억)·주식수
 * 표시는 화면마다 제각각 재구현돼 있었다 — 이 파일로 모아서 표준을 정한다.
 * 계산 로직은 건드리지 않고 표시 포맷만 다룬다.
 */

import { formatNumber, type Market } from "@/lib/market";

/** 퍼센트를 소수점 digits자리까지 표시한다. 이 앱의 등락률 표시 대부분이 이미
 * 소수 2자리를 쓰고 있어(전수 조사) 기본값을 2로 둔다. sign은 기본 true —
 * 등락률·괴리율처럼 방향이 의미 있는 값은 양수에 "+"를 붙인다(음수는 toFixed가
 * 이미 붙이는 "-" 그대로). ROE·배당수익률처럼 방향이 아니라 크기만 보여주면
 * 되는 비율은 호출부에서 sign: false로 끈다. */
export function formatPercent(value: number, options: { digits?: number; sign?: boolean } = {}): string {
  const { digits = 2, sign = true } = options;
  const prefix = sign && value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(digits)}%`;
}

// 조 단위로 전환하는 기준(억원). 10,000억원 = 1조원.
const MARKET_CAP_JO_THRESHOLD_EOK = 10_000;

/** 시가총액(억원 단위 입력)을 사람이 읽기 편한 단위로 자동 변환한다 — 1조원 미만은
 * 억원(정수), 1조원 이상은 조원(소수 1자리)으로 표시한다. */
export function formatMarketCap(eok: number): string {
  if (Math.abs(eok) < MARKET_CAP_JO_THRESHOLD_EOK) {
    return `${eok.toLocaleString("ko-KR", { maximumFractionDigits: 0 })}억원`;
  }
  const jo = eok / MARKET_CAP_JO_THRESHOLD_EOK;
  return `${jo.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}조원`;
}

/** 주식수를 시장별 로케일 구분 관례에 맞춰 "N주"로 표시한다 — 원화를 세는 게
 * 아니라 수량이라 lib/market.ts의 formatPrice가 아니라 formatNumber를 재사용한다. */
export function formatShares(value: number, market: Market): string {
  return `${formatNumber(value, market)}주`;
}

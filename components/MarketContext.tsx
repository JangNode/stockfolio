"use client";

import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { Market } from "@/lib/market";

const STORAGE_KEY = "stockfolio:market";

// localStorage처럼 React 바깥에 있는 값을 구독하려면 useState+useEffect로 흉내내는
// 대신(렌더 중 setState를 유발해 린트 규칙에 걸림) useSyncExternalStore를 쓰는 게
// 정석이다. localStorage.setItem은 그걸 호출한 탭 자신에게는 "storage" 이벤트를
// 주지 않으므로(다른 탭에만 전파됨), 같은 탭 안에서의 변경 알림은 이 모듈이 직접
// 구독자 목록을 관리해서 처리한다.
type Listener = () => void;
const listeners = new Set<Listener>();
let currentMarket: Market = "KR";
let hydrated = false;

function readStoredMarket(): Market {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "US" ? "US" : "KR";
}

function subscribe(callback: Listener): () => void {
  // 이 모듈이 클라이언트에서 처음 구독되는 시점(=마운트 시점)에 서버 스냅샷("KR")
  // 대신 실제 저장된 값으로 한 번 맞춘다.
  if (!hydrated) {
    hydrated = true;
    currentMarket = readStoredMarket();
  }
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getSnapshot(): Market {
  return currentMarket;
}

function getServerSnapshot(): Market {
  return "KR";
}

function setMarket(next: Market): void {
  if (next === currentMarket) return;
  currentMarket = next;
  window.localStorage.setItem(STORAGE_KEY, next);
  for (const listener of listeners) listener();
}

interface MarketContextValue {
  market: Market;
  setMarket: (market: Market) => void;
}

const MarketContext = createContext<MarketContextValue | null>(null);

/**
 * 사이트 전역 국내/미국 시장 전환 상태. 페이지 이동 없이 값만 바뀌므로, 어느 화면에서
 * 전환하든 그 화면에 그대로 머문 채 데이터만 새 시장 기준으로 다시 불러온다.
 * 새로고침/재방문에도 유지되도록 localStorage에 저장한다.
 */
export function MarketProvider({ children }: { children: ReactNode }) {
  const market = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return <MarketContext.Provider value={{ market, setMarket }}>{children}</MarketContext.Provider>;
}

export function useMarket(): MarketContextValue {
  const ctx = useContext(MarketContext);
  if (!ctx) throw new Error("useMarket은 MarketProvider 내부에서만 쓸 수 있습니다.");
  return ctx;
}

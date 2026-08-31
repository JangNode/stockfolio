"use client";

import { useState } from "react";
import useSWR from "swr";
import { authJsonFetcher } from "@/lib/authFetch";
import type { ThemeCode } from "@/lib/themeConfig";
import type { ThemePeriod } from "@/lib/themeReturns";

interface ThemeRankingItem {
  themeCode: ThemeCode;
  label: string;
  changeRatePct: number;
  constituentCount: number;
}

interface ThemesResponse {
  period: ThemePeriod;
  asOfDate: string;
  themes: ThemeRankingItem[];
}

interface ThemeConstituent {
  code: string;
  name: string;
  changeRatePct: number;
}

interface ThemeDetailResponse {
  themeCode: ThemeCode;
  label: string;
  period: ThemePeriod;
  asOfDate: string;
  constituents: ThemeConstituent[];
}

const PERIOD_OPTIONS: { value: ThemePeriod; label: string }[] = [
  { value: "daily", label: "일간" },
  { value: "monthly", label: "이번 달" },
  { value: "yearly", label: "올해" },
];

// 국내 시세 관례: 상승=빨강, 하락=파랑(components/Screening.tsx의 returnColor와 동일).
function changeRateColorClass(value: number): string {
  if (value > 0) return "text-red-600 dark:text-red-400";
  if (value < 0) return "text-blue-600 dark:text-blue-400";
  return "text-black dark:text-zinc-50";
}

function formatChangeRate(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export default function ThemeRankings() {
  const [period, setPeriod] = useState<ThemePeriod>("daily");
  const [selectedTheme, setSelectedTheme] = useState<ThemeCode | null>(null);

  const { data, error, isLoading } = useSWR<ThemesResponse>(
    `/api/themes?period=${period}`,
    authJsonFetcher
  );

  const {
    data: detail,
    error: detailError,
    isLoading: detailLoading,
  } = useSWR<ThemeDetailResponse>(
    selectedTheme ? `/api/themes/${selectedTheme}?period=${period}` : null,
    authJsonFetcher
  );

  return (
    <div className="w-full max-w-3xl">
      <div className="mb-6 flex items-center justify-between gap-3">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {data ? `${data.asOfDate} 기준` : "국내 KRX 섹터 테마별 등락률 순위입니다."}
        </p>
        <div className="flex gap-1 rounded-full border border-black/[.08] p-0.5 dark:border-white/[.145]">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                setPeriod(opt.value);
                setSelectedTheme(null);
              }}
              className={`h-8 rounded-full px-3 text-sm font-medium transition-colors ${
                period === opt.value
                  ? "bg-foreground text-background"
                  : "text-zinc-600 hover:bg-black/[.04] dark:text-zinc-400 dark:hover:bg-white/[.08]"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
        {isLoading ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">불러오는 중...</p>
        ) : error || !data ? (
          <p className="text-sm text-blue-600 dark:text-blue-400">테마 등락률을 불러오지 못했습니다.</p>
        ) : data.themes.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">표시할 테마 데이터가 없습니다.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-zinc-500 dark:text-zinc-400">
                <th className="pb-2 pr-4 font-normal">테마</th>
                <th className="pb-2 pr-4 font-normal">등락률</th>
                <th className="pb-2 font-normal">구성종목 수</th>
              </tr>
            </thead>
            <tbody>
              {data.themes.map((theme) => (
                <tr
                  key={theme.themeCode}
                  onClick={() => setSelectedTheme(theme.themeCode)}
                  className="cursor-pointer border-t border-black/[.08] hover:bg-black/[.02] dark:border-white/[.145] dark:hover:bg-white/[.04]"
                >
                  <td className="py-2 pr-4 text-black dark:text-zinc-50">{theme.label}</td>
                  <td className={`py-2 pr-4 font-medium ${changeRateColorClass(theme.changeRatePct)}`}>
                    {formatChangeRate(theme.changeRatePct)}
                  </td>
                  <td className="py-2 text-zinc-500 dark:text-zinc-400">{theme.constituentCount}개</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selectedTheme && (
        <div className="mt-6 rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-medium text-black dark:text-zinc-50">
              {detail?.label ?? ""} 구성종목
            </p>
            <button
              onClick={() => setSelectedTheme(null)}
              className="text-xs text-zinc-500 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
            >
              닫기
            </button>
          </div>

          {detailLoading ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">불러오는 중...</p>
          ) : detailError || !detail ? (
            <p className="text-sm text-blue-600 dark:text-blue-400">구성종목을 불러오지 못했습니다.</p>
          ) : detail.constituents.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">표시할 구성종목이 없습니다.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {detail.constituents.map((c) => (
                <li key={c.code} className="flex items-center justify-between gap-2">
                  <span className="text-black dark:text-zinc-50">
                    {c.name} <span className="text-xs text-zinc-400 dark:text-zinc-500">{c.code}</span>
                  </span>
                  <span className={`font-medium ${changeRateColorClass(c.changeRatePct)}`}>
                    {formatChangeRate(c.changeRatePct)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

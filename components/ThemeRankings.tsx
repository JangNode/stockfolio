"use client";

import { useState } from "react";
import useSWR from "swr";
import { authJsonFetcher } from "@/lib/authFetch";
import type { ThemeCode } from "@/lib/themeConfig";
import { THEME_CONSTITUENTS_RETENTION_YEARS } from "@/lib/themeConfig";
import type { ThemePeriod } from "@/lib/themeReturns";

interface ThemeRankingItem {
  themeCode: ThemeCode;
  label: string;
  changeRatePct: number | null;
  constituentCount: number;
  insufficientData: boolean;
}

interface ThemesResponse {
  period: ThemePeriod;
  asOfDate: string;
  dataAvailableFrom: string;
  insufficientData: boolean;
  message?: string;
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
  dataAvailableFrom: string;
  insufficientData: boolean;
  message?: string;
  constituents: ThemeConstituent[];
}

const PERIOD_OPTIONS: { value: ThemePeriod; label: string }[] = [
  { value: "daily", label: "일별" },
  { value: "monthly", label: "월별" },
  { value: "yearly", label: "년별" },
];

// 구성종목이 이 개수를 넘으면 상승/하락 각각 이만큼만 보여준다(겹치지 않게, RULES.md
// 매직넘버 분리 원칙에 따라 여기 상수로 둔다 — 이 화면에서만 쓰는 UI 축약 기준이라
// lib/*Config.ts가 아니라 여기 둔다).
const TOP_MOVERS_LIMIT = 10;

function todayKstIsoDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

// 국내 시세 관례: 상승=빨강, 하락=파랑(components/Screening.tsx의 returnColor와 동일).
function changeRateColorClass(value: number): string {
  if (value > 0) return "text-red-600 dark:text-red-400";
  if (value < 0) return "text-blue-600 dark:text-blue-400";
  return "text-black dark:text-zinc-50";
}

function formatChangeRate(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

interface TopMovers {
  gainers: ThemeConstituent[];
  losers: ThemeConstituent[];
}

/** 등락률 내림차순 상위 min(10, N)을 "상승 TOP", 나머지 중 하위 min(10, N-상승개수)를
 * "하락 TOP"으로 겹치지 않게 나눈다(하락 TOP은 낙폭이 큰 순서로 보여준다). */
function splitTopMovers(constituents: ThemeConstituent[]): TopMovers {
  const sorted = [...constituents].sort((a, b) => b.changeRatePct - a.changeRatePct);
  const gainersCount = Math.min(TOP_MOVERS_LIMIT, sorted.length);
  const gainers = sorted.slice(0, gainersCount);
  const losersCount = Math.min(TOP_MOVERS_LIMIT, sorted.length - gainersCount);
  const losers = losersCount > 0 ? sorted.slice(sorted.length - losersCount).reverse() : [];
  return { gainers, losers };
}

export default function ThemeRankings() {
  const today = todayKstIsoDate();
  const currentYear = today.slice(0, 4);
  const currentMonth = today.slice(5, 7);

  const [period, setPeriod] = useState<ThemePeriod>("daily");
  const [selectedTheme, setSelectedTheme] = useState<ThemeCode | null>(null);
  const [dateValue, setDateValue] = useState(today);
  const [monthValue, setMonthValue] = useState(`${currentYear}-${currentMonth}`);
  const [yearValue, setYearValue] = useState(currentYear);

  function handlePeriodChange(next: ThemePeriod) {
    setPeriod(next);
    setSelectedTheme(null);
  }

  const query = new URLSearchParams({ period });
  if (period === "daily") query.set("date", dateValue);
  if (period === "monthly") {
    const [y, m] = monthValue.split("-");
    query.set("year", y);
    query.set("month", m);
  }
  if (period === "yearly") query.set("year", yearValue);
  const queryString = query.toString();

  const { data, error, isLoading } = useSWR<ThemesResponse>(`/api/themes?${queryString}`, authJsonFetcher);

  const {
    data: detail,
    error: detailError,
    isLoading: detailLoading,
  } = useSWR<ThemeDetailResponse>(
    selectedTheme ? `/api/themes/${selectedTheme}?${queryString}` : null,
    authJsonFetcher
  );

  const minDate = data?.dataAvailableFrom;
  const minYear = Number(minDate?.slice(0, 4) ?? currentYear) - 1;
  const yearOptions = Array.from({ length: THEME_CONSTITUENTS_RETENTION_YEARS + 1 }, (_, i) =>
    String(Number(currentYear) - i)
  );

  const inputClassName =
    "h-8 rounded-full border border-black/[.08] bg-transparent px-3 text-sm text-black outline-none focus:border-black/30 dark:border-white/[.145] dark:text-zinc-50 dark:focus:border-white/30";

  const { gainers, losers } = detail ? splitTopMovers(detail.constituents) : { gainers: [], losers: [] };

  return (
    <div className="w-full max-w-3xl">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {data ? `${data.asOfDate} 기준` : "국내 KRX 섹터 테마별 등락률 순위입니다."}
        </p>
        <div className="flex gap-1 rounded-full border border-black/[.08] p-0.5 dark:border-white/[.145]">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handlePeriodChange(opt.value)}
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

      <div className="mb-6 flex justify-end">
        {period === "daily" && (
          <input
            type="date"
            value={dateValue}
            min={minDate}
            max={today}
            onChange={(e) => e.target.value && setDateValue(e.target.value)}
            className={inputClassName}
          />
        )}
        {period === "monthly" && (
          <input
            type="month"
            value={monthValue}
            min={minDate ? minDate.slice(0, 7) : `${minYear}-01`}
            max={`${currentYear}-${currentMonth}`}
            onChange={(e) => e.target.value && setMonthValue(e.target.value)}
            className={inputClassName}
          />
        )}
        {period === "yearly" && (
          <select value={yearValue} onChange={(e) => setYearValue(e.target.value)} className={inputClassName}>
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}년
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
        {isLoading ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">불러오는 중...</p>
        ) : error || !data ? (
          <p className="text-sm text-blue-600 dark:text-blue-400">테마 등락률을 불러오지 못했습니다.</p>
        ) : data.insufficientData ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            {data.message ?? "해당 기간 데이터가 없습니다."}
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-zinc-500 dark:text-zinc-400">
                <th className="pb-2 pr-2 font-normal">#</th>
                <th className="pb-2 pr-4 font-normal">테마</th>
                <th className="pb-2 pr-4 font-normal">등락률</th>
                <th className="pb-2 font-normal">구성종목 수</th>
              </tr>
            </thead>
            <tbody>
              {data.themes.map((theme, index) => (
                <tr
                  key={theme.themeCode}
                  onClick={() => setSelectedTheme(theme.themeCode)}
                  className="cursor-pointer border-t border-black/[.08] hover:bg-black/[.02] dark:border-white/[.145] dark:hover:bg-white/[.04]"
                >
                  <td className="py-2 pr-2 text-zinc-400 dark:text-zinc-500">{index + 1}</td>
                  <td className="py-2 pr-4 text-black dark:text-zinc-50">{theme.label}</td>
                  <td className="py-2 pr-4 font-medium">
                    {theme.insufficientData || theme.changeRatePct === null ? (
                      <span className="text-zinc-400 dark:text-zinc-500">데이터 없음</span>
                    ) : (
                      <span className={changeRateColorClass(theme.changeRatePct)}>
                        {formatChangeRate(theme.changeRatePct)}
                      </span>
                    )}
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
          ) : detail.insufficientData || detail.constituents.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {detail.message ?? "해당 기간 표시할 구성종목이 없습니다."}
            </p>
          ) : (
            <div className="flex flex-col gap-5">
              <div>
                <p className="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">상승 TOP</p>
                <ul className="flex flex-col gap-2 text-sm">
                  {gainers.map((c, index) => (
                    <li key={c.code} className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <span className="w-4 text-xs text-zinc-400 dark:text-zinc-500">{index + 1}</span>
                        <span className="text-black dark:text-zinc-50">
                          {c.name} <span className="text-xs text-zinc-400 dark:text-zinc-500">{c.code}</span>
                        </span>
                      </span>
                      <span className={`font-medium ${changeRateColorClass(c.changeRatePct)}`}>
                        {formatChangeRate(c.changeRatePct)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              {losers.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">하락 TOP</p>
                  <ul className="flex flex-col gap-2 text-sm">
                    {losers.map((c, index) => (
                      <li key={c.code} className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2">
                          <span className="w-4 text-xs text-zinc-400 dark:text-zinc-500">{index + 1}</span>
                          <span className="text-black dark:text-zinc-50">
                            {c.name} <span className="text-xs text-zinc-400 dark:text-zinc-500">{c.code}</span>
                          </span>
                        </span>
                        <span className={`font-medium ${changeRateColorClass(c.changeRatePct)}`}>
                          {formatChangeRate(c.changeRatePct)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

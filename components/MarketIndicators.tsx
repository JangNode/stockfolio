"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { authJsonFetcher } from "@/lib/authFetch";
import { pickValueAsOf, pickValueBefore, buildMeetingResultDates } from "@/lib/rateChangeDetection";

interface UsRatePoint {
  effectiveDate: string;
  targetUpperPct: number;
  targetLowerPct: number;
}

interface KrRatePoint {
  effectiveDate: string;
  ratePct: number;
}

interface UpcomingMeeting {
  market: "US" | "KR";
  date: string;
}

interface RatesResponse {
  us: UsRatePoint[];
  kr: KrRatePoint[];
  usSchedule: string[];
  krSchedule: string[];
  upcoming: UpcomingMeeting[];
}

interface CentralBankNewsItem {
  source: "FED" | "BOK";
  title: string;
  link: string;
  publishedAt: string;
}

interface NewsResponse {
  news: CentralBankNewsItem[];
}

const NEWS_SOURCE_LABELS: Record<"FED" | "BOK", string> = { FED: "연준", BOK: "한국은행" };

const PERIOD_OPTIONS = [
  { years: 1, label: "최근 1년" },
  { years: 3, label: "최근 3년" },
  { years: 5, label: "최근 5년" },
  { years: 0, label: "전체" },
] as const;

const MARKET_LABELS: Record<"US" | "KR", string> = { US: "미국(FOMC)", KR: "한국(금통위)" };

function cutoffDate(years: number): string {
  if (years === 0) return "0000-01-01";
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatShortDate(date: string): string {
  const [year, month, day] = date.split("-");
  return `${year.slice(2)}/${month}/${day}`;
}

function formatNewsDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 변경점(회의가 있었던 날)만 담긴 시계열을, 지정한 기간 창 안에서 계단식으로 그릴 수
 * 있게 다듬는다: 창 시작 이전의 마지막 값을 창 시작일에 하나 끼워 넣어(그래야 그래프가
 * 빈 값에서 시작하지 않는다), 오늘 날짜에도 마지막 값을 하나 더 찍어(그래야 최근에
 * 회의가 없었어도 선이 오늘까지 이어져 보인다) 채운다. */
function buildWindowedSeries<T extends { effectiveDate: string }>(points: T[], years: number): T[] {
  const cutoff = cutoffDate(years);
  const today = todayIsoDate();
  const inWindow = points.filter((p) => p.effectiveDate >= cutoff);
  const before = [...points].reverse().find((p) => p.effectiveDate < cutoff);

  const result: T[] = [];
  if (before) result.push({ ...before, effectiveDate: cutoff });
  result.push(...inWindow);

  const last = result[result.length - 1];
  if (last && last.effectiveDate < today) {
    result.push({ ...last, effectiveDate: today });
  }
  return result;
}

interface RateChangeRow {
  effectiveDate: string;
  label: string; // "인상"/"인하"/"동결"/"기록 시작"
  deltaText: string; // "+25bp" 등(기록 시작이면 빈 문자열)
  valueText: string; // 그 회의 결과로 적용된 실제 값(예: "3.75~4.00%", "3.00%")
}

function describeUsChange(prev: UsRatePoint | null, cur: UsRatePoint): RateChangeRow {
  const valueText = `${cur.targetLowerPct}~${cur.targetUpperPct}%`;
  if (!prev) return { effectiveDate: cur.effectiveDate, label: "기록 시작", deltaText: "", valueText };
  const deltaUpper = cur.targetUpperPct - prev.targetUpperPct;
  const label = deltaUpper > 0 ? "인상" : deltaUpper < 0 ? "인하" : "동결";
  const deltaText = deltaUpper === 0 ? "" : `${deltaUpper > 0 ? "+" : ""}${(deltaUpper * 100).toFixed(0)}bp`;
  return { effectiveDate: cur.effectiveDate, label, deltaText, valueText };
}

function describeKrChange(prev: KrRatePoint | null, cur: KrRatePoint): RateChangeRow {
  const valueText = `${cur.ratePct}%`;
  if (!prev) return { effectiveDate: cur.effectiveDate, label: "기록 시작", deltaText: "", valueText };
  const delta = cur.ratePct - prev.ratePct;
  const label = delta > 0 ? "인상" : delta < 0 ? "인하" : "동결";
  const deltaText = delta === 0 ? "" : `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(0)}bp`;
  return { effectiveDate: cur.effectiveDate, label, deltaText, valueText };
}

function changeLabelColorClass(label: string): string {
  if (label === "인상") return "text-red-600 dark:text-red-400";
  if (label === "인하") return "text-blue-600 dark:text-blue-400";
  return "text-zinc-600 dark:text-zinc-400";
}

const RECENT_CHANGES_LIMIT = 10;

export default function MarketIndicators() {
  const [years, setYears] = useState<(typeof PERIOD_OPTIONS)[number]["years"]>(5);
  const { data, error, isLoading } = useSWR<RatesResponse>("/api/market-indicators/rates", authJsonFetcher);
  const {
    data: newsData,
    error: newsError,
    isLoading: newsLoading,
  } = useSWR<NewsResponse>("/api/market-indicators/news", authJsonFetcher);

  const usWindowed = useMemo(() => (data ? buildWindowedSeries(data.us, years) : []), [data, years]);
  const krWindowed = useMemo(() => (data ? buildWindowedSeries(data.kr, years) : []), [data, years]);

  // "지난 회의 결과"는 저장된 변경점 날짜만으로 만들면 "동결"로 끝난 회의가 아예
  // 빠진다(값이 안 바뀐 날은 애초에 저장되지 않으므로) — 그래서 알려진 회의 일정
  // 날짜(과거분)를 함께 합쳐, 그 날짜에 실제로 적용 중이던 값을 직전 값과 비교한다.
  const usRecentChanges = useMemo(() => {
    if (!data) return [];
    const today = todayIsoDate();
    const dates = buildMeetingResultDates(data.us, data.usSchedule, today);
    return dates
      .map((d) => {
        const cur = pickValueAsOf(data.us, d);
        if (!cur) return null;
        return describeUsChange(pickValueBefore(data.us, d), cur);
      })
      .filter((row): row is RateChangeRow => row !== null)
      .reverse()
      .slice(0, RECENT_CHANGES_LIMIT);
  }, [data]);

  const krRecentChanges = useMemo(() => {
    if (!data) return [];
    const today = todayIsoDate();
    const dates = buildMeetingResultDates(data.kr, data.krSchedule, today);
    return dates
      .map((d) => {
        const cur = pickValueAsOf(data.kr, d);
        if (!cur) return null;
        return describeKrChange(pickValueBefore(data.kr, d), cur);
      })
      .filter((row): row is RateChangeRow => row !== null)
      .reverse()
      .slice(0, RECENT_CHANGES_LIMIT);
  }, [data]);

  const selectClassName =
    "h-10 rounded-lg border border-black/[.08] bg-transparent px-3 text-sm text-black outline-none focus:border-black/30 dark:border-white/[.145] dark:text-zinc-50 dark:focus:border-white/30";

  return (
    <div className="w-full max-w-4xl">
      <div className="mb-6 flex items-end justify-between gap-3 rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          미국(FOMC)·한국(금통위) 기준금리 추이와 다가오는 회의 일정입니다.
        </p>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-zinc-500 dark:text-zinc-400">기간</label>
          <select
            value={years}
            onChange={(e) => setYears(Number(e.target.value) as (typeof PERIOD_OPTIONS)[number]["years"])}
            className={selectClassName}
          >
            {PERIOD_OPTIONS.map((opt) => (
              <option key={opt.label} value={opt.years}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">불러오는 중...</p>
      ) : error || !data ? (
        <p className="text-sm text-blue-600 dark:text-blue-400">시장 지표를 불러오지 못했습니다.</p>
      ) : (
        <>
          <div className="mb-6 rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
            <p className="mb-3 text-sm font-medium text-black dark:text-zinc-50">미국 기준금리(FOMC 목표 범위)</p>
            {usWindowed.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">데이터가 없습니다.</p>
            ) : (
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={usWindowed} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.35)" />
                    <XAxis
                      dataKey="effectiveDate"
                      tickFormatter={formatShortDate}
                      tick={{ fontSize: 11, fill: "#71717a" }}
                      interval="preserveStartEnd"
                      minTickGap={40}
                    />
                    <YAxis
                      tickFormatter={(v: number) => `${v}%`}
                      tick={{ fontSize: 11, fill: "#71717a" }}
                      width={40}
                      domain={["auto", "auto"]}
                    />
                    <Tooltip
                      labelFormatter={(label) => label as string}
                      formatter={(value, name) => [`${value}%`, name]}
                      contentStyle={{ fontSize: 12 }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line
                      type="stepAfter"
                      dataKey="targetUpperPct"
                      name="상단"
                      stroke="#2563eb"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="stepAfter"
                      dataKey="targetLowerPct"
                      name="하단"
                      stroke="#93c5fd"
                      strokeWidth={2}
                      strokeDasharray="4 3"
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="mb-6 rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
            <p className="mb-3 text-sm font-medium text-black dark:text-zinc-50">한국 기준금리(금통위)</p>
            {krWindowed.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">데이터가 없습니다.</p>
            ) : (
              <div className="h-64 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={krWindowed} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.35)" />
                    <XAxis
                      dataKey="effectiveDate"
                      tickFormatter={formatShortDate}
                      tick={{ fontSize: 11, fill: "#71717a" }}
                      interval="preserveStartEnd"
                      minTickGap={40}
                    />
                    <YAxis
                      tickFormatter={(v: number) => `${v}%`}
                      tick={{ fontSize: 11, fill: "#71717a" }}
                      width={40}
                      domain={["auto", "auto"]}
                    />
                    <Tooltip formatter={(value) => [`${value}%`, "기준금리"]} contentStyle={{ fontSize: 12 }} />
                    <Line type="stepAfter" dataKey="ratePct" name="기준금리" stroke="#ea580c" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="mb-6 rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
            <p className="mb-3 text-sm font-medium text-black dark:text-zinc-50">다가오는 일정</p>
            {data.upcoming.length === 0 ? (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">예정된 일정이 없습니다.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.upcoming.map((m) => (
                  <li
                    key={`${m.market}-${m.date}`}
                    className="flex items-center justify-between rounded-lg border border-black/[.08] px-3 py-2 text-sm dark:border-white/[.145]"
                  >
                    <span className="text-black dark:text-zinc-50">{m.date}</span>
                    <span className="text-zinc-500 dark:text-zinc-400">{MARKET_LABELS[m.market]}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div className="rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
              <p className="mb-3 text-sm font-medium text-black dark:text-zinc-50">미국 — 지난 회의 결과</p>
              {usRecentChanges.length === 0 ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">기록이 없습니다.</p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm">
                  {usRecentChanges.map((row) => (
                    <li key={row.effectiveDate} className="flex items-center justify-between gap-2">
                      <span className="text-zinc-500 dark:text-zinc-400">{row.effectiveDate}</span>
                      <span className="flex items-baseline gap-1.5">
                        <span className={changeLabelColorClass(row.label)}>
                          {row.label}
                          {row.deltaText && ` (${row.deltaText})`}
                        </span>
                        <span className="font-medium text-black dark:text-zinc-50">{row.valueText}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
              <p className="mb-3 text-sm font-medium text-black dark:text-zinc-50">한국 — 지난 회의 결과</p>
              {krRecentChanges.length === 0 ? (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">기록이 없습니다.</p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm">
                  {krRecentChanges.map((row) => (
                    <li key={row.effectiveDate} className="flex items-center justify-between gap-2">
                      <span className="text-zinc-500 dark:text-zinc-400">{row.effectiveDate}</span>
                      <span className="flex items-baseline gap-1.5">
                        <span className={changeLabelColorClass(row.label)}>
                          {row.label}
                          {row.deltaText && ` (${row.deltaText})`}
                        </span>
                        <span className="font-medium text-black dark:text-zinc-50">{row.valueText}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}

      <div className="mt-6 rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
        <p className="mb-3 text-sm font-medium text-black dark:text-zinc-50">관련 뉴스</p>
        {newsLoading ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">불러오는 중...</p>
        ) : newsError || !newsData ? (
          <p className="text-sm text-blue-600 dark:text-blue-400">뉴스를 불러오지 못했습니다.</p>
        ) : newsData.news.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">표시할 뉴스가 없습니다.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {newsData.news.map((item) => (
              <li key={item.link} className="flex items-start justify-between gap-3 text-sm">
                <a
                  href={item.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-black hover:underline dark:text-zinc-50"
                >
                  <span className="mr-2 rounded bg-black/[.04] px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-white/[.08] dark:text-zinc-400">
                    {NEWS_SOURCE_LABELS[item.source]}
                  </span>
                  {item.title}
                </a>
                <span className="shrink-0 whitespace-nowrap text-xs text-zinc-500 dark:text-zinc-400">
                  {formatNewsDateTime(item.publishedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

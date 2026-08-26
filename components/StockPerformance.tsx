"use client";

import useSWR from "swr";
import { authJsonFetcher } from "@/lib/authFetch";

interface FinancialStatementYear {
  year: number;
  revenueGrowthPct: number | null;
  operatingIncomeGrowthPct: number | null;
  netIncomeGrowthPct: number | null;
  operatingMarginPct: number | null;
  netMarginPct: number | null;
}

type MetricKey = keyof Omit<FinancialStatementYear, "year">;

const METRIC_ROWS: { key: MetricKey; label: string }[] = [
  { key: "revenueGrowthPct", label: "매출액 증감률" },
  { key: "operatingIncomeGrowthPct", label: "영업이익 증감률" },
  { key: "netIncomeGrowthPct", label: "당기순이익 증감률" },
  { key: "operatingMarginPct", label: "영업이익률" },
  { key: "netMarginPct", label: "순이익률" },
];

const CHART_METRICS: { key: MetricKey; label: string }[] = [
  { key: "revenueGrowthPct", label: "매출액 증감률" },
  { key: "operatingIncomeGrowthPct", label: "영업이익 증감률" },
  { key: "netIncomeGrowthPct", label: "당기순이익 증감률" },
];

function formatPct(value: number | null): string {
  if (value === null) return "-";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function amountColorClass(value: number | null): string {
  if (value === null) return "text-zinc-400 dark:text-zinc-500";
  if (value > 0) return "text-red-600 dark:text-red-400";
  if (value < 0) return "text-blue-600 dark:text-blue-400";
  return "text-black dark:text-zinc-50";
}

/** 증감률은 음수가 흔해서(기준선이 0) 재무제표 섹션의 막대그래프와 달리 0을 중심으로
 * 위/아래로 그린다. */
function GrowthBarRow({
  label,
  years,
}: {
  label: string;
  years: { year: number; value: number | null }[];
}) {
  const max = Math.max(...years.map((y) => Math.abs(y.value ?? 0)), 1);
  const half = 32; // 0선 기준 위/아래 각각 최대 높이(px)

  return (
    <div>
      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</p>
      <div className="mt-1 flex items-stretch gap-3">
        {years.map(({ year, value }) => {
          const barPx = value === null ? 0 : (Math.abs(value) / max) * half;
          const isNegative = value !== null && value < 0;
          return (
            <div key={year} className="flex flex-1 flex-col items-center gap-1">
              <div className="flex h-16 w-full flex-col justify-center">
                <div style={{ height: `${half}px` }} className="flex w-full items-end justify-center">
                  {!isNegative && (
                    <div className="w-6 rounded-t bg-red-500" style={{ height: `${barPx}px` }} />
                  )}
                </div>
                <div className="h-px w-full bg-black/[.15] dark:bg-white/[.2]" />
                <div style={{ height: `${half}px` }} className="flex w-full justify-center">
                  {isNegative && <div className="w-6 rounded-b bg-blue-500" style={{ height: `${barPx}px` }} />}
                </div>
              </div>
              <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{year}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 종목 상세 화면의 실적 정보 섹션 — 재무제표 데이터로부터 파생된 증감률/이익률.
 * StockFinancials와 같은 API(/api/stock/[code]/financials)를 쓰므로(SWR이 같은 키를
 * 자동으로 합쳐줌) 별도 네트워크 요청이 추가되지 않는다. DART는 KR 종목만 다루므로
 * 호출부에서 market으로 걸러줘야 한다. */
export default function StockPerformance({ code }: { code: string }) {
  const { data, error, isLoading } = useSWR<{ years: FinancialStatementYear[] }>(
    `/api/stock/${code}/financials`,
    authJsonFetcher
  );

  return (
    <div className="mt-4 w-full rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
      <p className="mb-3 text-sm font-medium text-black dark:text-zinc-50">실적 정보</p>

      {isLoading ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">실적 정보를 불러오는 중...</p>
      ) : error ? (
        <p className="text-sm text-blue-600 dark:text-blue-400">실적 정보를 불러오지 못했습니다.</p>
      ) : !data || data.years.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">실적 정보가 없습니다.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-zinc-500 dark:text-zinc-400">
                  <th className="pb-2 pr-4 font-normal" />
                  {data.years.map((y) => (
                    <th key={y.year} className="pb-2 pr-4 text-right font-normal">
                      {y.year}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {METRIC_ROWS.map((row) => (
                  <tr key={row.key} className="border-t border-black/[.08] dark:border-white/[.145]">
                    <td className="py-2 pr-4 text-zinc-500 dark:text-zinc-400">{row.label}</td>
                    {data.years.map((y) => (
                      <td key={y.year} className={`py-2 pr-4 text-right ${amountColorClass(y[row.key])}`}>
                        {formatPct(y[row.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 border-t border-black/[.08] pt-4 sm:grid-cols-3 dark:border-white/[.145]">
            {CHART_METRICS.map((metric) => (
              <GrowthBarRow
                key={metric.key}
                label={metric.label}
                years={data.years.map((y) => ({ year: y.year, value: y[metric.key] }))}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

"use client";

import useSWR from "swr";
import { authJsonFetcher } from "@/lib/authFetch";
import { formatMarketCap } from "@/lib/formatNumber";

interface FinancialStatementYear {
  year: number;
  revenue: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  totalAssets: number | null;
  totalLiabilities: number | null;
  totalEquity: number | null;
}

type MetricKey = keyof Omit<FinancialStatementYear, "year">;

const METRIC_ROWS: { key: MetricKey; label: string }[] = [
  { key: "revenue", label: "매출액" },
  { key: "operatingIncome", label: "영업이익" },
  { key: "netIncome", label: "당기순이익" },
  { key: "totalAssets", label: "자산총계" },
  { key: "totalLiabilities", label: "부채총계" },
  { key: "totalEquity", label: "자본총계" },
];

const CHART_METRICS: { key: MetricKey; label: string }[] = [
  { key: "revenue", label: "매출액" },
  { key: "operatingIncome", label: "영업이익" },
  { key: "netIncome", label: "당기순이익" },
];

/** DART 금액은 원 단위 정수로 오는데 큰 기업은 자릿수가 매우 커서(수백조 원) 억원
 * 단위로 나눠 표시한다. 1조원 이상은 lib/formatNumber.ts의 formatMarketCap이
 * 조원 단위로 자동 전환해준다(매출·자산 총계는 대형주 기준 1조원을 쉽게 넘는다). */
function formatEokWon(value: number | null): string {
  if (value === null) return "-";
  return formatMarketCap(value / 100_000_000);
}

// 매출/자산처럼 절대값 지표는 양수가 정상 상태라 등락률처럼 빨강으로 강조하지
// 않는다(음수일 때만 fall 토큰으로 눈에 띄게 한다) — StockCard 등의 "양수=rise"
// 관례와 다른 의도적 선택.
function amountColorClass(value: number | null): string {
  if (value === null || value >= 0) return "text-ink";
  return "text-fall";
}

function MetricBarRow({
  label,
  years,
}: {
  label: string;
  years: { year: number; value: number | null }[];
}) {
  const max = Math.max(...years.map((y) => Math.abs(y.value ?? 0)), 1);

  return (
    <div>
      <p className="text-xs font-medium text-ink-muted">{label}</p>
      <div className="mt-1 flex items-end gap-3">
        {years.map(({ year, value }) => {
          const heightPct = value === null ? 0 : (Math.abs(value) / max) * 100;
          const isNegative = value !== null && value < 0;
          return (
            <div key={year} className="flex flex-1 flex-col items-center gap-1">
              <div className="flex h-16 w-full items-end justify-center">
                <div
                  className={`w-6 rounded-t ${isNegative ? "bg-fall" : "bg-zinc-400 dark:bg-zinc-600"}`}
                  style={{ height: `${heightPct}%` }}
                />
              </div>
              <span className="tabular-nums text-[10px] text-ink-faint">{year}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 종목 상세 화면의 재무제표 요약 섹션. DART는 국내(KRX) 상장사만 다루므로 KR 종목에서만
 * 렌더링해야 한다(호출부에서 market으로 걸러줌). */
export default function StockFinancials({ code }: { code: string }) {
  const { data, error, isLoading } = useSWR<{ years: FinancialStatementYear[] }>(
    `/api/stock/${code}/financials`,
    authJsonFetcher
  );

  return (
    <div className="mt-4 w-full rounded-card border border-border bg-surface p-4">
      <p className="mb-3 text-sm font-medium text-ink">
        재무제표 (연결 기준, 최근 3개년)
      </p>

      {isLoading ? (
        <p className="text-sm text-ink-muted">재무제표를 불러오는 중...</p>
      ) : error ? (
        <p className="text-sm text-blue-600 dark:text-blue-400">재무제표를 불러오지 못했습니다.</p>
      ) : !data || data.years.length === 0 ? (
        <p className="text-sm text-ink-muted">재무제표 데이터가 없습니다.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-ink-muted">
                  <th className="pb-2 pr-4 font-normal" />
                  {data.years.map((y) => (
                    <th key={y.year} className="pb-2 pr-4 text-right font-normal tabular-nums">
                      {y.year}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {METRIC_ROWS.map((row) => (
                  <tr key={row.key} className="border-t border-border">
                    <td className="py-2 pr-4 text-ink-muted">{row.label}</td>
                    {data.years.map((y) => (
                      <td key={y.year} className={`py-2 pr-4 text-right tabular-nums ${amountColorClass(y[row.key])}`}>
                        {formatEokWon(y[row.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 border-t border-border pt-4 sm:grid-cols-3">
            {CHART_METRICS.map((metric) => (
              <MetricBarRow
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

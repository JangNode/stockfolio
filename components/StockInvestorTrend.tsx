"use client";

import useSWR from "swr";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { authJsonFetcher } from "@/lib/authFetch";

interface InvestorTrendDay {
  date: string; // YYYY-MM-DD
  foreignNetBuy: number;
  institutionNetBuy: number;
  individualNetBuy: number;
}

interface InvestorTrendResponse {
  days: InvestorTrendDay[];
}

// 3주체 각각 고정된 색을 쓴다 — 매수/매도 부호에 따른 빨강/파랑은 겹쳐 그리면
// 알아보기 어려워서(3개 선이 서로 교차) 아래 기간 누적 순매수량 숫자 쪽에만
// 적용한다(기존 실적 정보 카드의 증감률 색상 관례와 동일).
const SERIES = [
  { key: "foreignNetBuy" as const, label: "외국인", color: "#3b82f6" },
  { key: "institutionNetBuy" as const, label: "기관", color: "#8b5cf6" },
  { key: "individualNetBuy" as const, label: "개인", color: "#10b981" },
];

function formatShortDate(date: string): string {
  const [, month, day] = date.split("-");
  return `${month}/${day}`;
}

function formatQty(value: number): string {
  return value.toLocaleString("ko-KR");
}

function amountColorClass(value: number): string {
  if (value > 0) return "text-red-600 dark:text-red-400";
  if (value < 0) return "text-blue-600 dark:text-blue-400";
  return "text-black dark:text-zinc-50";
}

function SummaryBlock({ label, total }: { label: string; total: number }) {
  return (
    <div className="rounded-lg border border-black/[.08] p-3 dark:border-white/[.145]">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label} 누적 순매수</p>
      <p className={`mt-1 text-lg font-semibold ${amountColorClass(total)}`}>
        {total > 0 ? "+" : ""}
        {formatQty(total)}주
      </p>
    </div>
  );
}

/** 종목 상세 화면의 투자자 동향 섹션 — 최근 약 1개월(영업일 기준) 외국인/기관/개인
 * 일별 순매수 추이. KIS는 KR 종목만 다루므로 호출부에서 market으로 걸러줘야 한다.
 * 당일 데이터는 KIS 쪽에서 장 종료 후에만 제공되므로, 장중에는 오늘 날짜가 아직
 * 안 보일 수 있다(정상 동작). */
export default function StockInvestorTrend({ code }: { code: string }) {
  const { data, error, isLoading } = useSWR<InvestorTrendResponse>(
    `/api/stock/${code}/investor-trend`,
    authJsonFetcher
  );

  return (
    <div className="mt-4 w-full rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
      <p className="mb-3 text-sm font-medium text-black dark:text-zinc-50">투자자 동향 (최근 1개월)</p>

      {isLoading ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">투자자 동향을 불러오는 중...</p>
      ) : error ? (
        <p className="text-sm text-blue-600 dark:text-blue-400">투자자 동향을 불러오지 못했습니다.</p>
      ) : !data || data.days.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">투자자 동향 데이터가 없습니다.</p>
      ) : (
        <>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.days} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.35)" />
                <XAxis dataKey="date" tickFormatter={formatShortDate} tick={{ fontSize: 11, fill: "#71717a" }} />
                <YAxis
                  tickFormatter={(v: number) => `${(v / 10_000).toLocaleString("ko-KR")}만`}
                  tick={{ fontSize: 11, fill: "#71717a" }}
                  width={48}
                />
                <Tooltip
                  formatter={(value, name) => [`${formatQty(Number(value))}주`, name]}
                  contentStyle={{ fontSize: 12 }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {SERIES.map((s) => (
                  <Line
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.label}
                    stroke={s.color}
                    strokeWidth={2}
                    dot={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 border-t border-black/[.08] pt-4 sm:grid-cols-3 dark:border-white/[.145]">
            {SERIES.map((s) => (
              <SummaryBlock
                key={s.key}
                label={s.label}
                total={data.days.reduce((sum, d) => sum + d[s.key], 0)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

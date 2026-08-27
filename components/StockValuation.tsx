"use client";

import useSWR from "swr";
import { authJsonFetcher } from "@/lib/authFetch";

interface DividendYearRow {
  year: number;
  cashDividendPerShareCommon: number | null;
  dividendYieldPct: number | null;
  payoutRatioPct: number | null;
}

interface ValuationResponse {
  dividends: DividendYearRow[];
  per: number | null;
  pbr: number | null;
  roePct: number | null;
  dividendYieldPct: number | null;
  payoutRatioPct: number | null;
  marketCapEok: number | null;
  sharesOutstanding: number | null;
  eps: number | null;
  week52High: number | null;
  week52Low: number | null;
  dividendCountLastYear: number | null;
}

function formatRatio(value: number | null, digits = 2): string {
  return value === null ? "-" : value.toFixed(digits);
}

function formatPct(value: number | null): string {
  return value === null ? "-" : `${value.toFixed(2)}%`;
}

/** 시가총액은 KIS가 억원 단위로 내려준다. 삼성전자 같은 대형주는 억원 그대로
 * 표시하면 자릿수가 너무 커서(1,556만억원 등) 조 단위로 환산해 보여준다. */
function formatMarketCapEok(eok: number | null): string {
  if (eok === null) return "-";
  const jo = eok / 10_000;
  return `${jo.toLocaleString("ko-KR", { maximumFractionDigits: 1 })}조원`;
}

function formatShares(value: number | null): string {
  return value === null ? "-" : `${value.toLocaleString("ko-KR")}주`;
}

function formatWon(value: number | null): string {
  return value === null ? "-" : `${value.toLocaleString("ko-KR")}원`;
}

function StatBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/[.08] p-3 dark:border-white/[.145]">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-1 text-lg font-semibold text-black dark:text-zinc-50">{value}</p>
    </div>
  );
}

/** 종목 상세 화면의 가치평가지표 섹션. PER/PBR/배당수익률은 오늘 주가 기준 스냅샷이라
 * 캐싱하지 않고(app/api/stock/[code]/valuation 참고) 매 요청마다 즉시 계산된 값을
 * 그대로 보여준다. DART는 KR 종목만 다루므로 호출부에서 market으로 걸러줘야 한다. */
export default function StockValuation({ code }: { code: string }) {
  const { data, error, isLoading } = useSWR<ValuationResponse>(`/api/stock/${code}/valuation`, authJsonFetcher);

  return (
    <div className="mt-4 w-full rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
      <p className="mb-3 text-sm font-medium text-black dark:text-zinc-50">가치평가지표</p>

      {isLoading ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">가치평가지표를 불러오는 중...</p>
      ) : error ? (
        <p className="text-sm text-blue-600 dark:text-blue-400">가치평가지표를 불러오지 못했습니다.</p>
      ) : !data ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">가치평가지표 데이터가 없습니다.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <StatBlock label="PER" value={formatRatio(data.per)} />
            <StatBlock label="PBR" value={formatRatio(data.pbr)} />
            <StatBlock label="ROE" value={formatPct(data.roePct)} />
            <StatBlock label="배당수익률" value={formatPct(data.dividendYieldPct)} />
            <StatBlock label="배당성향" value={formatPct(data.payoutRatioPct)} />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <StatBlock label="시가총액" value={formatMarketCapEok(data.marketCapEok)} />
            <StatBlock label="상장주식수" value={formatShares(data.sharesOutstanding)} />
            <StatBlock label="EPS" value={formatWon(data.eps)} />
            <StatBlock label="1년간 배당 횟수" value={data.dividendCountLastYear === null ? "-" : `${data.dividendCountLastYear}회`} />
            <StatBlock
              label="최근 1년 최고/최저"
              value={`${formatWon(data.week52High)} / ${formatWon(data.week52Low)}`}
            />
          </div>

          {data.dividends.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">배당 이력이 없습니다.</p>
          ) : (
            <div className="mt-4 overflow-x-auto border-t border-black/[.08] pt-4 dark:border-white/[.145]">
              <p className="mb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">최근 5개년 배당 이력</p>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-zinc-500 dark:text-zinc-400">
                    <th className="pb-2 pr-4 font-normal">연도</th>
                    <th className="pb-2 pr-4 font-normal">지급 여부</th>
                    <th className="pb-2 pr-4 text-right font-normal">배당수익률</th>
                  </tr>
                </thead>
                <tbody>
                  {data.dividends.map((d) => {
                    const paid = d.cashDividendPerShareCommon !== null && d.cashDividendPerShareCommon > 0;
                    return (
                      <tr key={d.year} className="border-t border-black/[.08] dark:border-white/[.145]">
                        <td className="py-2 pr-4 text-black dark:text-zinc-50">{d.year}</td>
                        <td className="py-2 pr-4">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                              paid
                                ? "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
                                : "bg-black/[.04] text-zinc-600 dark:bg-white/[.08] dark:text-zinc-400"
                            }`}
                          >
                            {paid ? "지급" : "미지급"}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-right text-black dark:text-zinc-50">
                          {formatPct(d.dividendYieldPct)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

"use client";

import useSWR from "swr";
import { authJsonFetcher } from "@/lib/authFetch";
import { formatPrice } from "@/lib/market";
import { formatPercent, formatMarketCap, formatShares as formatSharesShared } from "@/lib/formatNumber";

interface DividendYearRow {
  year: number;
  cashDividendPerShareCommon: number | null;
  dividendYieldPct: number | null;
  payoutRatioPct: number | null;
}

type FairValueVerdict = "UNDERVALUED" | "FAIR" | "OVERVALUED" | "UNKNOWN";

interface FairValueResult {
  method: "RIM" | "PEER_PER" | "DCF";
  fairPrice: number | null;
  gapPercent: number | null;
  verdict: FairValueVerdict;
  reason: string;
  assumptions?: { wacc: number; terminalGrowth: number; fcfGrowthRate: number };
}

interface ValuationResponse {
  dividends: DividendYearRow[];
  per: number | null;
  pbr: number | null;
  peg: number | null;
  epsGrowthPct: number | null;
  roePct: number | null;
  dividendYieldPct: number | null;
  marketCapEok: number | null;
  sharesOutstanding: number | null;
  eps: number | null;
  week52High: number | null;
  week52Low: number | null;
  dividendCountLastYear: number | null;
  rim: FairValueResult;
  peerPer: FairValueResult;
  dcf: FairValueResult;
}

function formatRatio(value: number | null, digits = 2): string {
  return value === null ? "-" : value.toFixed(digits);
}

// ROE/배당수익률/EPS성장률은 방향성을 강조할 값이 아니라 그냥 비율이라, 등락률과
// 달리 양수에도 "+"를 붙이지 않는다(lib/formatNumber.ts formatPercent의 sign:false).
function formatPct(value: number | null): string {
  return value === null ? "-" : formatPercent(value, { sign: false });
}

function formatMarketCapEok(eok: number | null): string {
  return eok === null ? "-" : formatMarketCap(eok);
}

function formatShares(value: number | null): string {
  return value === null ? "-" : formatSharesShared(value, "KR");
}

function formatWon(value: number | null): string {
  return value === null ? "-" : `${formatPrice(value, "KR")}원`;
}

function StatBlock({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="mt-1 tabular-nums text-lg font-semibold text-ink">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

const FAIR_VALUE_METHOD_LABEL: Record<FairValueResult["method"], string> = {
  RIM: "RIM(잔여이익모델)",
  PEER_PER: "상대가치(업종 PER)",
  DCF: "DCF(현금흐름할인법)",
};

// 국내 증시 관례상 상승/저평가를 붉은색, 하락/고평가를 파란색 계열로 표시하는 이
// 앱의 기존 톤(예: 배당 지급 배지, 등락률 표시)을 그대로 따른다 — rise/fall
// 디자인 토큰의 soft 배경 변형(rise-soft/fall-soft)을 쓴다.
const FAIR_VALUE_VERDICT_STYLE: Record<FairValueVerdict, string> = {
  UNDERVALUED: "bg-rise-soft text-rise",
  FAIR: "bg-black/[.04] text-ink-muted dark:bg-white/[.08]",
  OVERVALUED: "bg-fall-soft text-fall",
  UNKNOWN: "bg-black/[.04] text-ink-muted dark:bg-white/[.08]",
};

const FAIR_VALUE_VERDICT_LABEL: Record<FairValueVerdict, string> = {
  UNDERVALUED: "저평가",
  FAIR: "적정",
  OVERVALUED: "고평가",
  UNKNOWN: "산출 불가",
};

/** RIM/방법A/DCF 카드 하나. 산출 가능하면 적정주가·현재가 대비 괴리율·판정 배지를,
 * 산출 불가면 사유(reason)만 보여준다. highlighted면(다수 방법 판정이 일치할 때)
 * 카드 테두리를 강조한다. DCF는 assumptions(WACC·영구성장률·FCF성장률)를 하단에
 * 함께 보여줘 적정주가 산출 근거가 드러나게 한다. */
function FairValueCard({ result, highlighted }: { result: FairValueResult; highlighted: boolean }) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        highlighted ? "border-red-300 dark:border-red-800" : "border-border"
      }`}
    >
      <p className="text-xs text-ink-muted">{FAIR_VALUE_METHOD_LABEL[result.method]}</p>
      {result.fairPrice === null ? (
        <p className="mt-2 text-sm text-ink-muted">{result.reason}</p>
      ) : (
        <>
          <p className="mt-1 tabular-nums text-lg font-semibold text-ink">{formatWon(result.fairPrice)}</p>
          <p className="mt-0.5 tabular-nums text-xs text-ink-muted">
            현재가 대비 {result.gapPercent === null ? "-" : formatPercent(result.gapPercent)}
          </p>
          <span
            className={`mt-2 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${FAIR_VALUE_VERDICT_STYLE[result.verdict]}`}
          >
            {FAIR_VALUE_VERDICT_LABEL[result.verdict]}
          </span>
          {result.assumptions && (
            <p className="mt-2 tabular-nums text-xs text-ink-muted">
              WACC {result.assumptions.wacc.toFixed(1)}% · 영구성장률 {result.assumptions.terminalGrowth.toFixed(1)}%
              · FCF성장률 {result.assumptions.fcfGrowthRate.toFixed(1)}%
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** 종목 상세 화면의 가치평가지표 섹션. PER/PBR/배당수익률은 오늘 주가 기준 스냅샷이라
 * 캐싱하지 않고(app/api/stock/[code]/valuation 참고) 매 요청마다 즉시 계산된 값을
 * 그대로 보여준다. DART는 KR 종목만 다루므로 호출부에서 market으로 걸러줘야 한다. */
export default function StockValuation({ code }: { code: string }) {
  const { data, error, isLoading } = useSWR<ValuationResponse>(`/api/stock/${code}/valuation`, authJsonFetcher);

  return (
    <div className="mt-4 w-full rounded-card border border-border bg-surface p-4">
      <p className="mb-3 text-sm font-medium text-ink">가치평가지표</p>

      {isLoading ? (
        <p className="text-sm text-ink-muted">가치평가지표를 불러오는 중...</p>
      ) : error ? (
        <p className="text-sm text-blue-600 dark:text-blue-400">가치평가지표를 불러오지 못했습니다.</p>
      ) : !data ? (
        <p className="text-sm text-ink-muted">가치평가지표 데이터가 없습니다.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatBlock label="시가총액" value={formatMarketCapEok(data.marketCapEok)} />
            <StatBlock label="상장주식수" value={formatShares(data.sharesOutstanding)} />
            <StatBlock label="PER" value={formatRatio(data.per)} />
            <StatBlock label="PBR" value={formatRatio(data.pbr)} />
            <StatBlock
              label="PEG"
              value={formatRatio(data.peg)}
              hint={data.epsGrowthPct === null ? undefined : `최근 5년 EPS 성장률 ${formatPct(data.epsGrowthPct)}`}
            />
            <StatBlock label="ROE" value={formatPct(data.roePct)} />
            <StatBlock label="EPS" value={formatWon(data.eps)} />
            <StatBlock label="배당수익률" value={formatPct(data.dividendYieldPct)} />
            <StatBlock label="1년간 배당 횟수" value={data.dividendCountLastYear === null ? "-" : `${data.dividendCountLastYear}회`} />
            <StatBlock
              label="최근 1년 최고/최저"
              value={`${formatWon(data.week52High)} / ${formatWon(data.week52Low)}`}
            />
          </div>

          {data.dividends.length === 0 ? (
            <p className="mt-4 text-sm text-ink-muted">배당 이력이 없습니다.</p>
          ) : (
            <div className="mt-4 overflow-x-auto border-t border-border pt-4">
              <p className="mb-2 text-xs font-medium text-ink-muted">최근 5개년 배당 이력</p>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-ink-muted">
                    <th className="pb-2 pr-4 font-normal">연도</th>
                    <th className="pb-2 pr-4 font-normal">지급 여부</th>
                    <th className="pb-2 pr-4 text-right font-normal">배당수익률</th>
                  </tr>
                </thead>
                <tbody>
                  {data.dividends.map((d) => {
                    const paid = d.cashDividendPerShareCommon !== null && d.cashDividendPerShareCommon > 0;
                    return (
                      <tr key={d.year} className="border-t border-border">
                        <td className="py-2 pr-4 tabular-nums text-ink">{d.year}</td>
                        <td className="py-2 pr-4">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                              paid ? "bg-rise-soft text-rise" : "bg-black/[.04] text-ink-muted dark:bg-white/[.08]"
                            }`}
                          >
                            {paid ? "지급" : "미지급"}
                          </span>
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums text-ink">
                          {formatPct(d.dividendYieldPct)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {(() => {
            // 방법 간 판정 일치 개수 비교는 클라이언트에서 계산한다 — API는 파생값을
            // 따로 저장/반환하지 않는다.
            const results = [data.rim, data.peerPer, data.dcf];
            const knownVerdicts = results.map((r) => r.verdict).filter((v) => v !== "UNKNOWN");
            const verdictCounts = new Map<FairValueVerdict, number>();
            for (const v of knownVerdicts) verdictCounts.set(v, (verdictCounts.get(v) ?? 0) + 1);
            const maxAgreement = Math.max(0, ...verdictCounts.values());
            const majorityVerdict = [...verdictCounts.entries()].find(([, c]) => c === maxAgreement)?.[0];
            const showSummary = knownVerdicts.length >= 2 && maxAgreement >= 2 && majorityVerdict !== undefined;

            return (
              <div className="mt-4 border-t border-border pt-4">
                <p className="mb-2 text-xs font-medium text-ink-muted">
                  적정주가(RIM / 상대가치 / DCF)
                </p>
                {showSummary && (
                  <span className="mb-2 inline-flex items-center rounded-full bg-rise-soft px-2.5 py-1 text-xs font-medium text-rise">
                    {results.length}개 방법 중 {maxAgreement}개 일치: {FAIR_VALUE_VERDICT_LABEL[majorityVerdict]}
                  </span>
                )}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  {results.map((result) => (
                    <FairValueCard
                      key={result.method}
                      result={result}
                      highlighted={showSummary && result.verdict === majorityVerdict}
                    />
                  ))}
                </div>
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}

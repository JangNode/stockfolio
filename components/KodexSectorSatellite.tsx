"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { authJsonFetcher } from "@/lib/authFetch";
import { rebalanceKssAccount } from "@/lib/kodexSectorSatellite";
import type { KssSignalRow, KssTrackRow } from "@/lib/kodexSectorStorage";
import {
  KSS_ETF_CODE,
  KSS_ETF_NAME,
  KSS_RESEARCH_SCORECARD,
  KSS_SATELLITE_CAP,
  KSS_SEEDS_WON,
  KSS_SECTOR_NAMES,
} from "@/lib/kodexSectorSatelliteConfig";

interface KodexSectorResponse {
  signals: KssSignalRow[];
  track: KssTrackRow[];
  status: { last_attempt_at: string | null; last_success_at: string | null; last_error: string | null } | null;
}

const won = (x: number): string => `${Math.round(x).toLocaleString("ko-KR")}원`;
const pct = (x: number, digits = 2): string => `${(x * 100).toFixed(digits)}%`;
const sectorLabel = (code: string): string => `${code} ${KSS_SECTOR_NAMES[code] ?? ""}`.trim();
const seedLabel = (seed: number): string => `${(seed / 10_000).toLocaleString("ko-KR")}만`;

function SeedCalculator({ signal }: { signal: KssSignalRow }) {
  const [seed, setSeed] = useState<number>(KSS_SEEDS_WON[2]);
  const [custom, setCustom] = useState("");

  const result = useMemo(() => {
    if (!(seed > 0)) return null;
    const stocks = new Map(Object.entries(signal.signal_prices).filter(([c]) => c !== KSS_ETF_CODE));
    const satellite = signal.fallback_to_etf ? [] : signal.holdings.map((h) => ({ code: h.code, weight: h.weight }));
    return rebalanceKssAccount({ cash: seed, etfShares: 0, holdings: new Map() }, satellite, { etf: signal.signal_prices[KSS_ETF_CODE], stocks }, signal.trade_date);
  }, [seed, signal]);

  const nameOf = new Map(signal.holdings.map((h) => [h.code, h.name]));
  const etfPrice = signal.signal_prices[KSS_ETF_CODE];

  return (
    <div className="rounded-card bg-surface-sunken p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {KSS_SEEDS_WON.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => { setSeed(s); setCustom(""); }}
            className={`rounded-card border px-3 py-1 text-sm ${seed === s && custom === "" ? "border-ink bg-surface text-ink" : "border-border text-ink-muted"}`}
          >
            {seedLabel(s)}
          </button>
        ))}
        <input
          inputMode="numeric"
          placeholder="직접 입력(원)"
          value={custom}
          onChange={(e) => {
            const v = e.target.value.replace(/[^0-9]/g, "");
            setCustom(v);
            setSeed(Number(v));
          }}
          className="w-36 rounded-card border border-border bg-surface px-2 py-1 text-sm text-ink placeholder:text-ink-faint"
        />
      </div>

      {result && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-ink-muted">
                  <th className="pb-2 pr-4 font-normal">종목</th>
                  <th className="pb-2 pr-4 text-right font-normal">종가</th>
                  <th className="pb-2 pr-4 text-right font-normal">주수</th>
                  <th className="pb-2 text-right font-normal">금액</th>
                </tr>
              </thead>
              <tbody className="tabular-nums text-ink">
                <tr>
                  <td className="py-1 pr-4">{KSS_ETF_NAME} ({KSS_ETF_CODE})</td>
                  <td className="py-1 pr-4 text-right">{etfPrice.toLocaleString("ko-KR")}</td>
                  <td className="py-1 pr-4 text-right">{result.account.etfShares.toLocaleString("ko-KR")}</td>
                  <td className="py-1 text-right">{won(result.account.etfShares * etfPrice)}</td>
                </tr>
                {[...result.account.holdings].map(([code, n]) => (
                  <tr key={code}>
                    <td className="py-1 pr-4">{nameOf.get(code) ?? code} ({code})</td>
                    <td className="py-1 pr-4 text-right">{signal.signal_prices[code].toLocaleString("ko-KR")}</td>
                    <td className="py-1 pr-4 text-right">{n.toLocaleString("ko-KR")}</td>
                    <td className="py-1 text-right">{won(n * signal.signal_prices[code])}</td>
                  </tr>
                ))}
                <tr className="text-ink-muted">
                  <td className="py-1 pr-4">현금</td>
                  <td className="py-1 pr-4" />
                  <td className="py-1 pr-4" />
                  <td className="py-1 text-right">{won(result.account.cash)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-ink-muted">
            위성 실제 비중 {pct(result.valueAfter > 0 ? result.satelliteValue / result.valueAfter : 0)}
            {result.capHit && ` · 위성 합계가 ${pct(KSS_SATELLITE_CAP, 0)}를 넘어 비싼 종목부터 1주씩 줄였습니다`}
            {result.zeroSatellite && " · 이 시드로는 위성 종목을 1주도 사지 못해 069500만 삽니다"}
          </p>
          <p className="mt-1 text-xs text-ink-faint">
            {signal.signal_date} 종가 기준(실제 체결은 {signal.trade_date} 종가). 목표 주수 반올림, 위성 합계 {pct(KSS_SATELLITE_CAP, 0)} 상한, 남은 금액은 069500 정수 주, 매수 비용(수수료·슬리피지) 포함 — 연구 B 규칙.
          </p>
        </>
      )}
    </div>
  );
}

function TrackSummary({ track }: { track: KssTrackRow[] }) {
  if (track.length === 0) {
    return <p className="text-sm text-ink-muted">아직 모의 추적 기록이 없습니다. 첫 운영 신호의 체결 결과는 그다음 월말 신호 때 함께 기록됩니다.</p>;
  }
  const rows = KSS_SEEDS_WON.map((seed) => {
    const list = track.filter((r) => r.seed_won === seed);
    const last = list[list.length - 1];
    return { seed, count: list.length, last };
  }).filter((r) => r.last);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-ink-muted">
            <th className="pb-2 pr-4 font-normal">시드</th>
            <th className="pb-2 pr-4 text-right font-normal">리밸런싱</th>
            <th className="pb-2 pr-4 font-normal">평가일</th>
            <th className="pb-2 pr-4 text-right font-normal">평가액</th>
            <th className="pb-2 text-right font-normal">누적 수익률</th>
          </tr>
        </thead>
        <tbody className="tabular-nums text-ink">
          {rows.map(({ seed, count, last }) => {
            const ret = last.mark_value / seed - 1;
            return (
              <tr key={seed}>
                <td className="py-1 pr-4">{seedLabel(seed)}원</td>
                <td className="py-1 pr-4 text-right">{count}회</td>
                <td className="py-1 pr-4">{last.mark_date}</td>
                <td className="py-1 pr-4 text-right">{won(last.mark_value)}</td>
                <td className={`py-1 text-right ${ret > 0 ? "text-rise" : ret < 0 ? "text-fall" : "text-flat"}`}>{pct(ret)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** "전략 관리" 탭의 KODEX 200 + 업종 모멘텀 위성 전략 섹션(연구 v3.2 운영 적용). */
export default function KodexSectorSatellite() {
  const { data, error, isLoading } = useSWR<KodexSectorResponse>("/api/strategies/kodex-sector", authJsonFetcher);
  const latest = data?.signals[0];

  return (
    <div className="w-full max-w-4xl rounded-card border border-border bg-surface p-4">
      <p className="text-base font-semibold text-ink">KODEX 200 + 업종 모멘텀</p>
      <p className="mt-1 text-xs text-ink-muted">
        {KSS_ETF_NAME}({KSS_ETF_CODE}) 80% + 위성 20%. 위성 = 코스피 시총 상위 200(우선주·리츠 제외, 20일 평균 거래대금 5억 이상) 중 업종
        모멘텀(6개월 전~1개월 전 업종 시총가중 수익률) 상위 3개 업종의 시총 상위 3종목, 계좌 비중 1% 미만 정리. 매월 마지막 거래일 장 마감 후 신호,
        다음 거래일 체결.
      </p>

      {isLoading ? (
        <p className="mt-4 text-sm text-ink-muted">불러오는 중...</p>
      ) : error ? (
        <p className="mt-4 text-sm text-fall">불러오지 못했습니다.</p>
      ) : (
        <>
          {data?.status?.last_error && (
            <p className="mt-3 rounded-card bg-est-soft px-3 py-2 text-xs text-est">
              마지막 실행 오류({data.status.last_attempt_at?.slice(0, 10)}): {data.status.last_error}
            </p>
          )}

          <section className="mt-4">
            <p className="mb-2 text-sm font-medium text-ink">최근 신호</p>
            {!latest ? (
              <p className="text-sm text-ink-muted">아직 운영 신호가 없습니다. 첫 신호는 다음 월말 거래일 장 마감 후 계산됩니다.</p>
            ) : (
              <>
                <p className="mb-2 text-xs text-ink-muted">
                  신호일 {latest.signal_date} · 체결일 {latest.trade_date} · 모멘텀 구간 {latest.momentum_from}~{latest.momentum_to} · K200P {latest.k200p_count}종목
                </p>
                <div className="mb-3 grid gap-2 sm:grid-cols-3">
                  {latest.top_sectors.map((code, i) => {
                    const r = latest.sector_ranks.find((x) => x.sector === code);
                    return (
                      <div key={code} className="rounded-card bg-surface-sunken px-3 py-2">
                        <p className="text-xs text-ink-muted">{i + 1}위 업종</p>
                        <p className="text-sm text-ink">{sectorLabel(code)}</p>
                        {r && (
                          <p className={`text-sm tabular-nums ${r.momentum > 0 ? "text-rise" : r.momentum < 0 ? "text-fall" : "text-flat"}`}>
                            {pct(r.momentum)} <span className="text-xs text-ink-faint">(유효 {r.valid_count}종목)</span>
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
                {latest.fallback_to_etf ? (
                  <p className="text-sm text-ink-muted">계좌 비중 1% 이상인 위성 종목이 없어 위성 20%도 {KSS_ETF_NAME}로 채웁니다.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="text-ink-muted">
                          <th className="pb-2 pr-4 font-normal">종목</th>
                          <th className="pb-2 pr-4 font-normal">업종</th>
                          <th className="pb-2 pr-4 text-right font-normal">위성 안 비중</th>
                          <th className="pb-2 text-right font-normal">계좌 비중</th>
                        </tr>
                      </thead>
                      <tbody className="tabular-nums text-ink">
                        {latest.holdings.map((h) => (
                          <tr key={h.code}>
                            <td className="py-1 pr-4">{h.name} ({h.code})</td>
                            <td className="py-1 pr-4">{sectorLabel(h.sector)}</td>
                            <td className="py-1 pr-4 text-right">{pct(h.weight)}</td>
                            <td className="py-1 text-right">{pct(h.account_weight)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </section>

          {latest && (
            <section className="mt-5">
              <p className="mb-2 text-sm font-medium text-ink">시드 계산기</p>
              <SeedCalculator signal={latest} />
            </section>
          )}

          <section className="mt-5">
            <p className="mb-2 text-sm font-medium text-ink">모의 추적 (첫 운영 신호부터)</p>
            <TrackSummary track={data?.track ?? []} />
          </section>
        </>
      )}

      <section className="mt-5">
        <div className="mb-2 flex items-center gap-2">
          <p className="text-sm font-medium text-ink">연구 성적표</p>
          <span className="rounded-card bg-est-soft px-2 py-0.5 text-[11px] text-est">개발 데이터 내 성적</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-ink-muted">
                <th className="pb-2 pr-4 font-normal">구간</th>
                <th className="pb-2 pr-4 text-right font-normal">전략 CAGR</th>
                <th className="pb-2 pr-4 text-right font-normal">전략 MDD</th>
                <th className="pb-2 pr-4 text-right font-normal">전략 샤프</th>
                <th className="pb-2 pr-4 text-right font-normal">{KSS_ETF_NAME} CAGR</th>
                <th className="pb-2 pr-4 text-right font-normal">{KSS_ETF_NAME} MDD</th>
                <th className="pb-2 text-right font-normal">{KSS_ETF_NAME} 샤프</th>
              </tr>
            </thead>
            <tbody className="tabular-nums text-ink">
              {KSS_RESEARCH_SCORECARD.periods.map((p) => (
                <tr key={p.label}>
                  <td className="py-1 pr-4">{p.label}</td>
                  <td className="py-1 pr-4 text-right">{p.strategyCagr.toFixed(2)}%</td>
                  <td className="py-1 pr-4 text-right">{p.strategyMdd.toFixed(2)}%</td>
                  <td className="py-1 pr-4 text-right">{p.strategySharpe.toFixed(2)}</td>
                  <td className="py-1 pr-4 text-right">{p.etfCagr.toFixed(2)}%</td>
                  <td className="py-1 pr-4 text-right">{p.etfMdd.toFixed(2)}%</td>
                  <td className="py-1 text-right">{p.etfSharpe.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-xs text-ink-faint">
          {KSS_RESEARCH_SCORECARD.source}. 가격 기준(배당 제외), 거래 비용 포함, 80:20 비중 그대로(정수 주 아님). 규칙을 정한 데이터 안에서 잰 값이라 앞으로의 성과를 뜻하지 않습니다.
        </p>
      </section>

      <section className="mt-5 rounded-card bg-surface-sunken px-3 py-2 text-xs leading-relaxed text-ink-muted">
        <p className="mb-1 font-medium text-ink">위험</p>
        <ul className="list-disc space-y-0.5 pl-4">
          <li>위성이 사실상 한두 종목에 몰릴 수 있습니다(예: 2026-09 신호는 삼성전자·SK하이닉스 두 종목).</li>
          <li>모멘텀 기간(6개월 전~1개월 전)을 조금만 바꿔도 성적이 크게 달라졌습니다.</li>
          <li>주도 업종이 바뀌는 전환기에는 지난 강세 업종을 들고 있어 손실이 날 수 있습니다.</li>
          <li>연구용 모의 결과이며 투자 권유가 아닙니다.</li>
        </ul>
      </section>
    </div>
  );
}

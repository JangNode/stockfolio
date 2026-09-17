"use client";

import useSWR from "swr";
import { IBM_Plex_Sans_KR } from "next/font/google";
import { authJsonFetcher } from "@/lib/authFetch";
import { todayKstDateString } from "@/lib/formatKst";

// 이 컴포넌트에만 스코프된 폰트 — 전역 폰트(app/layout.tsx의 Geist)는 그대로 둔다.
const ibmPlexSansKr = IBM_Plex_Sans_KR({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
});

interface MarketBriefingResponse {
  dateKst: string | null;
  rawJson: unknown;
}

/** conclusion/summary/indices 외 나머지 섹션 — 아코디언으로 접어서 표시한다.
 * indices는 상단 핵심 지수 스트립에서 이미 다루므로 별도 아코디언을 만들지 않는다. */
const REMAINING_SECTION_KEYS = [
  "sentiment",
  "bonds_fx_commodities",
  "macro_issues",
  "stock_movers",
  "fed_fomc",
] as const;

const SECTION_LABELS: Record<string, string> = {
  sentiment: "시장 심리",
  bonds_fx_commodities: "채권/환율/원자재",
  macro_issues: "매크로 이슈",
  stock_movers: "종목 동향",
  fed_fomc: "연준/FOMC",
};

const STOCK_MOVER_GROUPS = [
  { key: "us_daily", label: "미국 (일간)" },
  { key: "us_weekly", label: "미국 (주간)" },
  { key: "korea", label: "국내" },
] as const;

// Cowork 출력이 실제로는 이 플래그를 붙이지 않는 경우가 많지만, 과거 설계 흔적이
// 남아있어도 해가 없으므로 그대로 둔다 — 값이 있으면 배지가 붙고 없으면 아무 일도
// 일어나지 않는다.
const ESTIMATE_FLAG_KEYS = ["is_estimate", "is_estimate_pt", "reason_confirmed"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** "bonds_fx_commodities" → "bonds fx commodities"처럼 최소한의 변환만 한다 —
 * 실제 섹션 내부 구조를 미리 알 수 없어 완전한 한글 라벨을 만들 수 없다. */
function humanizeKey(key: string): string {
  return key
    .replace(/^\d+_/, "")
    .split("_")
    .filter(Boolean)
    .join(" ");
}

/** 값 하나가 { value, is_estimate: true }처럼 신뢰도 플래그를 형제 키로 갖고
 * 있으면 값 옆에 "추정" 배지를 붙인다. */
function hasEstimateFlag(obj: Record<string, unknown>): boolean {
  return obj.is_estimate === true || obj.is_estimate_pt === true || obj.reason_confirmed === false;
}

function EstimateBadge() {
  return (
    <span className="ml-1.5 shrink-0 rounded-full bg-est-soft px-1.5 py-0.5 text-[10px] font-medium text-est">
      추정
    </span>
  );
}

/** 실제 브리핑 JSON의 세부 구조를 미리 알 수 없으므로, object/array를 재귀적으로
 * 순회하며 key를 사람이 읽을 라벨로 바꿔 보여주는 범용 렌더러. plain text로만
 * 렌더링하며 raw HTML은 절대 주입하지 않는다. */
function JsonEntry({ label, value }: { label?: string; value: unknown }) {
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return (
      <div className="flex flex-col gap-1">
        {label && (
          <p className="text-xs font-medium text-ink-muted">{humanizeKey(label)}</p>
        )}
        <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-ink">
          {value.map((item, i) => (
            <li key={i}>
              {isPrimitive(item) ? String(item) : <JsonEntry value={item} />}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const estimated = hasEstimateFlag(obj);
    const entries = Object.entries(obj).filter(
      ([k]) => !(ESTIMATE_FLAG_KEYS as readonly string[]).includes(k)
    );
    if (entries.length === 0) return null;

    if (entries.length === 1 && isPrimitive(entries[0][1])) {
      const [k, v] = entries[0];
      const innerLabel = k === "value" ? "" : `${humanizeKey(k)}: `;
      return (
        <p className="flex flex-wrap items-baseline gap-1 text-sm">
          {label && <span className="text-ink-muted">{humanizeKey(label)}:</span>}
          <span className="tabular-nums text-ink">
            {innerLabel}
            {String(v)}
          </span>
          {estimated && <EstimateBadge />}
        </p>
      );
    }

    return (
      <div className="flex flex-col gap-1.5">
        {(label || estimated) && (
          <p className="flex items-center text-xs font-medium text-ink-muted">
            {label && humanizeKey(label)}
            {estimated && <EstimateBadge />}
          </p>
        )}
        <div className="flex flex-col gap-1.5 pl-3">
          {entries.map(([k, v]) => (
            <JsonEntry key={k} label={k} value={v} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <p className="flex flex-wrap items-baseline gap-1 text-sm">
      {label && <span className="text-ink-muted">{humanizeKey(label)}:</span>}
      <span className="tabular-nums text-ink">{String(value)}</span>
    </p>
  );
}

// 국내 시세 관례: 상승=빨강, 하락=파랑(components/ThemeRankings.tsx의
// changeRateColorClass와 동일 — 해외 지수도 이 앱 전체 관례를 그대로 따른다).
function changeColorClass(value: number): string {
  if (value > 0) return "text-rise";
  if (value < 0) return "text-fall";
  return "text-flat";
}

function formatPct(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

/** usdkrw_change처럼 퍼센트인지 단순 증감인지 스키마상 보장이 없는 값을 부호만
 * 붙여 표시한다("%"를 임의로 붙이지 않는다). */
function formatSigned(value: number): string {
  const formatted = Math.abs(value).toLocaleString("ko-KR", { maximumFractionDigits: 2 });
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatted}`;
}

function formatNum(value: unknown): string | null {
  const n = asFiniteNumber(value);
  if (n === null) return null;
  return n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

function findByName(items: unknown[] | null, needle: string): Record<string, unknown> | null {
  if (!items) return null;
  for (const item of items) {
    const rec = asRecord(item);
    if (rec && typeof rec.name === "string" && rec.name.includes(needle)) return rec;
  }
  return null;
}

interface QuickStat {
  label: string;
  value: string;
  changeText: string | null;
  changeSign: number; // 색상 판단용 부호(양수/음수/0)
}

/** 상단 가로 스크롤 카드 스트립용 핵심 지수 5종을 골라낸다. 이름 표기가 항상
 * 같다는 보장이 없어 includes로 유연하게 찾고, 못 찾은 항목은 조용히 뺀다. */
function buildQuickStats(root: Record<string, unknown>): QuickStat[] {
  const stats: QuickStat[] = [];
  const indices = asRecord(root.indices);
  const asiaItems = indices ? asArray(indices.asia) : null;
  const usItems = indices ? asArray(indices.us) : null;

  const kospi = findByName(asiaItems, "코스피");
  const kospiValue = kospi ? formatNum(kospi.close) : null;
  if (kospi && kospiValue !== null) {
    const changePct = asFiniteNumber(kospi.change_pct);
    stats.push({
      label: "코스피",
      value: kospiValue,
      changeText: changePct !== null ? formatPct(changePct) : null,
      changeSign: changePct ?? 0,
    });
  }

  const sp500 = findByName(usItems, "S&P");
  const sp500Value = sp500 ? formatNum(sp500.close) : null;
  if (sp500 && sp500Value !== null) {
    const changePct = asFiniteNumber(sp500.change_pct);
    stats.push({
      label: "S&P 500",
      value: sp500Value,
      changeText: changePct !== null ? formatPct(changePct) : null,
      changeSign: changePct ?? 0,
    });
  }

  const nasdaq = findByName(usItems, "나스닥");
  const nasdaqValue = nasdaq ? formatNum(nasdaq.close) : null;
  if (nasdaq && nasdaqValue !== null) {
    const changePct = asFiniteNumber(nasdaq.change_pct);
    stats.push({
      label: "나스닥",
      value: nasdaqValue,
      changeText: changePct !== null ? formatPct(changePct) : null,
      changeSign: changePct ?? 0,
    });
  }

  const vix = asRecord(asRecord(root.sentiment)?.vix);
  const vixValue = vix ? formatNum(vix.close) : null;
  if (vix && vixValue !== null) {
    const changePct = asFiniteNumber(vix.change_pct);
    stats.push({
      label: "VIX",
      value: vixValue,
      changeText: changePct !== null ? formatPct(changePct) : null,
      changeSign: changePct ?? 0,
    });
  }

  const bonds = asRecord(root.bonds_fx_commodities);
  const usdkrwValue = bonds ? formatNum(bonds.usdkrw) : null;
  if (bonds && usdkrwValue !== null) {
    const change = asFiniteNumber(bonds.usdkrw_change);
    stats.push({
      label: "원/달러",
      value: usdkrwValue,
      changeText: change !== null ? formatSigned(change) : null,
      changeSign: change ?? 0,
    });
  }

  return stats;
}

function QuickStatStrip({ stats }: { stats: QuickStat[] }) {
  if (stats.length === 0) return null;

  return (
    <div className="mb-4 -mx-4 overflow-x-auto px-4 pb-1">
      <div className="flex gap-2">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="flex w-[104px] shrink-0 flex-col gap-1 rounded-card border border-border bg-surface-sunken px-3 py-2.5"
          >
            <span className="text-[11px] text-ink-muted">{stat.label}</span>
            <span className="tabular-nums text-sm font-semibold text-ink">{stat.value}</span>
            {stat.changeText && (
              <span className={`tabular-nums text-xs font-medium ${changeColorClass(stat.changeSign)}`}>
                {stat.changeText}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** stock_movers.us_daily/us_weekly/korea 배열 하나를 이름-등락률-사유로 나열한다. */
function StockMoversList({ items }: { items: unknown[] }) {
  const rows = items
    .map((item) => asRecord(item))
    .filter((rec): rec is Record<string, unknown> => rec !== null && typeof rec.name === "string");

  if (rows.length === 0) return null;

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((rec, i) => {
        const name = rec.name as string;
        const price = formatNum(rec.price);
        const changePct = asFiniteNumber(rec.change_pct);
        const reason = typeof rec.reason === "string" ? rec.reason : null;
        const estimated = hasEstimateFlag(rec);

        return (
          <li key={i} className="flex flex-col gap-0.5 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <span className="flex items-center font-medium text-ink">
                {name}
                {estimated && <EstimateBadge />}
              </span>
              <span className="flex items-baseline gap-2">
                {price !== null && <span className="tabular-nums text-ink-muted">{price}</span>}
                {changePct !== null && (
                  <span className={`tabular-nums font-medium ${changeColorClass(changePct)}`}>
                    {formatPct(changePct)}
                  </span>
                )}
              </span>
            </div>
            {reason && <p className="text-xs text-ink-muted">{reason}</p>}
          </li>
        );
      })}
    </ul>
  );
}

/** stock_movers 아코디언 전용 렌더러 — us_daily/us_weekly/korea 세 그룹으로 나눠
 * 보여준다. 예상과 다른 구조가 오면(그룹이 하나도 안 잡히면) 범용 JsonEntry로 대체한다. */
function StockMoversSection({ stockMovers }: { stockMovers: Record<string, unknown> }) {
  const groups = STOCK_MOVER_GROUPS.flatMap((g) => {
    const items = asArray(stockMovers[g.key]);
    return items && items.length > 0 ? [{ key: g.key as string, label: g.label as string, items }] : [];
  });

  if (groups.length === 0) return <JsonEntry value={stockMovers} />;

  return (
    <div className="flex flex-col gap-3">
      {groups.map((g) => (
        <div key={g.key} className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-ink-muted">{g.label}</p>
          <StockMoversList items={g.items} />
        </div>
      ))}
    </div>
  );
}

function computeDaysAgo(dateKst: string): number | null {
  const diffMs = Date.parse(todayKstDateString()) - Date.parse(dateKst);
  if (Number.isNaN(diffMs)) return null;
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

const CARD_CLASS =
  "w-full max-w-full overflow-x-hidden rounded-card border border-border bg-surface p-4";

export default function MarketBriefingSection() {
  const { data, error, isLoading } = useSWR<MarketBriefingResponse>(
    "/api/market-indicators/market-briefing",
    authJsonFetcher
  );

  if (isLoading) {
    return (
      <div className={`${ibmPlexSansKr.className} mb-6 ${CARD_CLASS}`}>
        <p className="text-sm text-ink-muted">불러오는 중...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className={`${ibmPlexSansKr.className} mb-6 ${CARD_CLASS}`}>
        <p className="text-sm text-blue-600 dark:text-blue-400">증시근황을 불러오지 못했습니다.</p>
      </div>
    );
  }

  if (data.dateKst === null || data.rawJson === null) {
    return (
      <div className={`${ibmPlexSansKr.className} mb-6 ${CARD_CLASS}`}>
        <p className="mb-3 text-sm font-medium text-ink">증시근황</p>
        <p className="text-sm text-ink-muted">오늘 브리핑 미등록</p>
      </div>
    );
  }

  const root = asRecord(data.rawJson);
  if (!root) {
    return (
      <div className={`${ibmPlexSansKr.className} mb-6 ${CARD_CLASS}`}>
        <p className="text-sm text-blue-600 dark:text-blue-400">증시근황 데이터 형식이 올바르지 않습니다.</p>
      </div>
    );
  }

  const daysAgo = computeDaysAgo(data.dateKst);

  const referenceSession = typeof root.reference_session === "string" ? root.reference_session : null;
  const timezoneBasis = typeof root.timezone_basis === "string" ? root.timezone_basis : null;

  const quickStats = buildQuickStats(root);
  const summary = asArray(root.summary);

  const conclusion = asRecord(root.conclusion);
  const stance = conclusion && typeof conclusion.stance === "string" ? conclusion.stance : null;
  const rationale = conclusion && typeof conclusion.rationale === "string" ? conclusion.rationale : null;
  const sectorGuidance = conclusion ? asRecord(conclusion.sector_guidance) : null;
  const domesticGuidance =
    sectorGuidance && typeof sectorGuidance.domestic === "string" ? sectorGuidance.domestic : null;
  const overseasGuidance =
    sectorGuidance && typeof sectorGuidance.overseas === "string" ? sectorGuidance.overseas : null;
  const disclaimer = conclusion && typeof conclusion.disclaimer === "string" ? conclusion.disclaimer : null;
  const hasStanceContent = Boolean(stance || rationale || domesticGuidance || overseasGuidance);

  const stockMovers = asRecord(root.stock_movers);

  const generatedAt = typeof root.generated_at === "string" ? root.generated_at : null;
  const generatedBy = typeof root.generated_by === "string" ? root.generated_by : null;
  const artifactUrl = typeof root.artifact_url === "string" ? root.artifact_url : null;
  const footerLine = [generatedBy, generatedAt].filter((v): v is string => Boolean(v)).join(" · ");

  return (
    <div className={`${ibmPlexSansKr.className} mb-6 ${CARD_CLASS}`}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-ink">증시근황</p>
        {(referenceSession || timezoneBasis) && (
          <p className="truncate text-[11px] text-ink-faint">
            {referenceSession}
            {referenceSession && timezoneBasis && " · "}
            {timezoneBasis}
          </p>
        )}
      </div>

      {daysAgo !== null && daysAgo > 0 && (
        <p className="mb-3 rounded-lg bg-est-soft px-3 py-2 text-xs font-medium text-est">
          {daysAgo}일 전 브리핑입니다.
        </p>
      )}

      <QuickStatStrip stats={quickStats} />

      {hasStanceContent && (
        <div className="mb-4 rounded-xl border border-violet-200 bg-violet-50 p-4 dark:border-violet-900/40 dark:bg-violet-950/20">
          {stance && (
            <span className="inline-block rounded-full bg-violet-600 px-3 py-1 text-xs font-semibold text-white dark:bg-violet-500">
              {stance}
            </span>
          )}
          {rationale && (
            <p className="mt-2 text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{rationale}</p>
          )}
          {(domesticGuidance || overseasGuidance) && (
            <div className="mt-3 grid grid-cols-1 gap-1.5 text-xs text-zinc-700 dark:text-zinc-300 sm:grid-cols-2">
              {domesticGuidance && (
                <p>
                  <span className="font-medium">국내</span> {domesticGuidance}
                </p>
              )}
              {overseasGuidance && (
                <p>
                  <span className="font-medium">해외</span> {overseasGuidance}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {summary && summary.length > 0 && (
        <ul className="mb-4 flex list-disc flex-col gap-1.5 pl-4 text-sm text-ink">
          {summary.map((item, i) => (
            <li key={i}>{isPrimitive(item) ? String(item) : <JsonEntry value={item} />}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2">
        {REMAINING_SECTION_KEYS.filter((key) => root[key] !== undefined).map((key) => (
          <details key={key} className="rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium text-ink">
              {SECTION_LABELS[key] ?? humanizeKey(key)}
            </summary>
            <div className="mt-2">
              {key === "stock_movers" && stockMovers ? (
                <StockMoversSection stockMovers={stockMovers} />
              ) : (
                <JsonEntry value={root[key]} />
              )}
            </div>
          </details>
        ))}
      </div>

      {(footerLine || artifactUrl) && (
        <p className="mt-4 text-[10px] text-ink-faint">
          {footerLine}
          {artifactUrl && (
            <>
              {footerLine && " · "}
              <a href={artifactUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
                원본
              </a>
            </>
          )}
        </p>
      )}

      {disclaimer && (
        <div className="mt-4 rounded-lg border border-border bg-surface-sunken px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
          {disclaimer}
        </div>
      )}
    </div>
  );
}

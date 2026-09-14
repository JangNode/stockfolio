"use client";

import useSWR from "swr";
import { authJsonFetcher } from "@/lib/authFetch";

interface MarketBriefingResponse {
  dateKst: string | null;
  rawJson: unknown;
}

const REMAINING_SECTION_KEYS = [
  "01_global_index_snapshot",
  "02_sentiment_technical",
  "03_global_markets",
  "04_rates_fx_commodities",
  "05_macro_issues",
  "06_stock_movers",
  "08_fed_fomc",
] as const;

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

/** "01_global_index_snapshot" → "global index snapshot"처럼 최소한의 변환만
 * 한다 — 실제 섹션 내부 구조를 미리 알 수 없어 완전한 한글 라벨을 만들 수 없다. */
function humanizeKey(key: string): string {
  return key
    .replace(/^\d+_/, "")
    .split("_")
    .filter(Boolean)
    .join(" ");
}

/** meta.quick_stats, sections[...] 등 값 하나가 { value, is_estimate: true }처럼
 * 신뢰도 플래그를 형제 키로 갖고 있으면 값 옆에 "추정" 배지를 붙인다. */
function hasEstimateFlag(obj: Record<string, unknown>): boolean {
  return obj.is_estimate === true || obj.is_estimate_pt === true || obj.reason_confirmed === false;
}

function EstimateBadge() {
  return (
    <span className="ml-1.5 shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">
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
          <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{humanizeKey(label)}</p>
        )}
        <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-black dark:text-zinc-50">
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
          {label && <span className="text-zinc-500 dark:text-zinc-400">{humanizeKey(label)}:</span>}
          <span className="text-black dark:text-zinc-50">
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
          <p className="flex items-center text-xs font-medium text-zinc-500 dark:text-zinc-400">
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
      {label && <span className="text-zinc-500 dark:text-zinc-400">{humanizeKey(label)}:</span>}
      <span className="text-black dark:text-zinc-50">{String(value)}</span>
    </p>
  );
}

/** 오늘(KST) 날짜 문자열(YYYY-MM-DD)을 만든다. */
function todayKstDateString(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}

function computeDaysAgo(dateKst: string): number | null {
  const diffMs = Date.parse(todayKstDateString()) - Date.parse(dateKst);
  if (Number.isNaN(diffMs)) return null;
  return Math.round(diffMs / (24 * 60 * 60 * 1000));
}

const CARD_CLASS =
  "rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950";

export default function MarketBriefingSection() {
  const { data, error, isLoading } = useSWR<MarketBriefingResponse>(
    "/api/market-indicators/market-briefing",
    authJsonFetcher
  );

  if (isLoading) {
    return (
      <div className={`mb-6 ${CARD_CLASS}`}>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">불러오는 중...</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className={`mb-6 ${CARD_CLASS}`}>
        <p className="text-sm text-blue-600 dark:text-blue-400">증시근황을 불러오지 못했습니다.</p>
      </div>
    );
  }

  if (data.dateKst === null || data.rawJson === null) {
    return (
      <div className={`mb-6 ${CARD_CLASS}`}>
        <p className="mb-3 text-sm font-medium text-black dark:text-zinc-50">증시근황</p>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">오늘 브리핑 미등록</p>
      </div>
    );
  }

  const root = asRecord(data.rawJson);
  if (!root) {
    return (
      <div className={`mb-6 ${CARD_CLASS}`}>
        <p className="text-sm text-blue-600 dark:text-blue-400">증시근황 데이터 형식이 올바르지 않습니다.</p>
      </div>
    );
  }

  const meta = asRecord(root.meta) ?? {};
  const coverageNote = typeof meta.coverage_note === "string" ? meta.coverage_note : null;
  const publishTime = typeof meta.publish_time_kst === "string" ? meta.publish_time_kst : null;
  const quickStats = meta.quick_stats;

  const summaryHighlights = asArray(root.summary_highlights);
  const sections = asRecord(root.sections) ?? {};
  const conclusion = asRecord(sections["07_conclusion"]);
  const stance = conclusion && typeof conclusion.stance === "string" ? conclusion.stance : null;
  const stanceSummary = conclusion ? conclusion.stance_summary : undefined;
  const disclaimer = conclusion && typeof conclusion.disclaimer === "string" ? conclusion.disclaimer : null;

  const daysAgo = computeDaysAgo(data.dateKst);
  const sources = asArray(root.sources);

  return (
    <div className={`mb-6 ${CARD_CLASS}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-black dark:text-zinc-50">증시근황</p>
        {publishTime && (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{publishTime} 발행</span>
        )}
      </div>

      {daysAgo !== null && daysAgo > 0 && (
        <p className="mb-3 rounded-lg bg-amber-100 px-3 py-2 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
          {daysAgo}일 전 브리핑입니다.
        </p>
      )}

      {coverageNote && (
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">{coverageNote}</p>
      )}

      {quickStats !== undefined && (
        <div className="mb-4 rounded-lg border border-black/[.08] p-3 dark:border-white/[.145]">
          <JsonEntry value={quickStats} />
        </div>
      )}

      {summaryHighlights && summaryHighlights.length > 0 && (
        <ul className="mb-4 flex list-disc flex-col gap-1 pl-4 text-sm text-black dark:text-zinc-50">
          {summaryHighlights.map((item, i) => (
            <li key={i}>{isPrimitive(item) ? String(item) : <JsonEntry value={item} />}</li>
          ))}
        </ul>
      )}

      {(stance || stanceSummary !== undefined) && (
        <div className="mb-4 rounded-lg border border-black/20 bg-black/[.03] p-3 dark:border-white/20 dark:bg-white/[.05]">
          {stance && (
            <p className="mb-1 text-sm font-semibold text-black dark:text-zinc-50">{stance}</p>
          )}
          {stanceSummary !== undefined && <JsonEntry value={stanceSummary} />}
        </div>
      )}

      {disclaimer && (
        <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">{disclaimer}</p>
      )}

      <div className="flex flex-col gap-2">
        {REMAINING_SECTION_KEYS.filter((key) => sections[key] !== undefined).map((key) => (
          <details
            key={key}
            className="rounded-lg border border-black/[.08] p-3 dark:border-white/[.145]"
          >
            <summary className="cursor-pointer text-sm font-medium text-black dark:text-zinc-50">
              {humanizeKey(key)}
            </summary>
            <div className="mt-2">
              <JsonEntry value={sections[key]} />
            </div>
          </details>
        ))}
      </div>

      {sources && sources.length > 0 && (
        <div className="mt-4 border-t border-black/[.08] pt-3 dark:border-white/[.145]">
          <p className="mb-1 text-xs text-zinc-500 dark:text-zinc-400">출처</p>
          <ul className="flex flex-col gap-0.5">
            {sources.map((s, i) => {
              if (typeof s === "string") {
                return (
                  <li key={i} className="text-xs text-zinc-500 dark:text-zinc-400">
                    {s}
                  </li>
                );
              }
              const rec = asRecord(s);
              const url =
                rec && typeof rec.url === "string"
                  ? rec.url
                  : rec && typeof rec.link === "string"
                    ? rec.link
                    : null;
              const label = rec && typeof rec.title === "string" ? rec.title : url;
              if (url && label) {
                return (
                  <li key={i} className="text-xs">
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-500 hover:underline dark:text-zinc-400"
                    >
                      {label}
                    </a>
                  </li>
                );
              }
              return (
                <li key={i} className="text-xs text-zinc-500 dark:text-zinc-400">
                  <JsonEntry value={s} />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

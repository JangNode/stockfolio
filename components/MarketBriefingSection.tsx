"use client";

import useSWR from "swr";
import { authJsonFetcher } from "@/lib/authFetch";

interface MarketBriefingResponse {
  dateKst: string | null;
  rawJson: unknown;
}

/** indices 아래 지역 키 → 표시 라벨. */
const INDEX_REGIONS = [
  { key: "us", label: "미국" },
  { key: "europe", label: "유럽" },
  { key: "asia", label: "아시아" },
] as const;

/** conclusion/summary/indices 외 나머지 섹션 — 아코디언으로 접어서 표시한다. */
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

// 국내 시세 관례: 상승=빨강, 하락=파랑(components/ThemeRankings.tsx의
// changeRateColorClass와 동일 — 해외 지수도 이 앱 전체 관례를 그대로 따른다).
function changeColorClass(value: number): string {
  if (value > 0) return "text-red-600 dark:text-red-400";
  if (value < 0) return "text-blue-600 dark:text-blue-400";
  return "text-black dark:text-zinc-50";
}

function formatPct(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatNum(value: unknown): string | null {
  const n = asFiniteNumber(value);
  if (n === null) return null;
  return n.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

/** indices.us/europe/asia 배열 하나를 이름/종가/등락률 중심으로 간결하게 보여준다.
 * change_pt/weekly_pct/note는 있으면 같이, 없으면 조용히 생략한다. */
function IndexRegionList({ items }: { items: unknown[] }) {
  const rows = items
    .map((item) => asRecord(item))
    .filter((rec): rec is Record<string, unknown> => rec !== null && typeof rec.name === "string");

  if (rows.length === 0) return null;

  return (
    <ul className="flex flex-col gap-1">
      {rows.map((rec, i) => {
        const name = rec.name as string;
        const close = formatNum(rec.close);
        const changePct = asFiniteNumber(rec.change_pct);
        const changePt = formatNum(rec.change_pt);
        const weeklyPct = asFiniteNumber(rec.weekly_pct);
        const note = typeof rec.note === "string" ? rec.note : null;

        return (
          <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
            <span className="text-black dark:text-zinc-50">{name}</span>
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              {close !== null && <span className="text-zinc-500 dark:text-zinc-400">{close}</span>}
              {changePct !== null && (
                <span className={`font-medium ${changeColorClass(changePct)}`}>{formatPct(changePct)}</span>
              )}
              {changePt !== null && (
                <span className="text-xs text-zinc-400 dark:text-zinc-500">({changePt}pt)</span>
              )}
              {weeklyPct !== null && (
                <span className="text-xs text-zinc-400 dark:text-zinc-500">주간 {formatPct(weeklyPct)}</span>
              )}
            </span>
            {note && <span className="w-full text-xs text-zinc-400 dark:text-zinc-500">{note}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** indices.us/europe/asia 중 실제로 존재하는 지역만 순서대로 렌더링한다. */
function IndicesSection({ indices }: { indices: Record<string, unknown> }) {
  const blocks: { label: string; items: unknown[] }[] = [];
  for (const { key, label } of INDEX_REGIONS) {
    const items = asArray(indices[key]);
    if (items && items.length > 0) blocks.push({ label, items });
  }

  if (blocks.length === 0) return null;

  return (
    <div className="mb-4 flex flex-col gap-3 rounded-lg border border-black/[.08] p-3 dark:border-white/[.145]">
      {blocks.map((b) => (
        <div key={b.label} className="flex flex-col gap-1">
          <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{b.label}</p>
          <IndexRegionList items={b.items} />
        </div>
      ))}
    </div>
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

  const daysAgo = computeDaysAgo(data.dateKst);

  const referenceSession = typeof root.reference_session === "string" ? root.reference_session : null;
  const timezoneBasis = typeof root.timezone_basis === "string" ? root.timezone_basis : null;

  const indices = asRecord(root.indices);
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
  const hasConclusionContent = Boolean(stance || rationale || domesticGuidance || overseasGuidance || disclaimer);

  const generatedAt = typeof root.generated_at === "string" ? root.generated_at : null;
  const generatedBy = typeof root.generated_by === "string" ? root.generated_by : null;
  const artifactUrl = typeof root.artifact_url === "string" ? root.artifact_url : null;
  const footerLine = [generatedBy, generatedAt].filter((v): v is string => Boolean(v)).join(" · ");

  return (
    <div className={`mb-6 ${CARD_CLASS}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-black dark:text-zinc-50">증시근황</p>
      </div>

      {daysAgo !== null && daysAgo > 0 && (
        <p className="mb-3 rounded-lg bg-amber-100 px-3 py-2 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
          {daysAgo}일 전 브리핑입니다.
        </p>
      )}

      {(referenceSession || timezoneBasis) && (
        <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1 rounded-lg bg-zinc-100 px-3 py-2 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
          {referenceSession && <span>기준 시점: {referenceSession}</span>}
          {timezoneBasis && <span>{timezoneBasis}</span>}
        </div>
      )}

      {indices && <IndicesSection indices={indices} />}

      {summary && summary.length > 0 && (
        <ul className="mb-4 flex list-disc flex-col gap-1 pl-4 text-sm text-black dark:text-zinc-50">
          {summary.map((item, i) => (
            <li key={i}>{isPrimitive(item) ? String(item) : <JsonEntry value={item} />}</li>
          ))}
        </ul>
      )}

      {hasConclusionContent && (
        <div className="mb-4 rounded-lg border border-black/20 bg-black/[.03] p-3 dark:border-white/20 dark:bg-white/[.05]">
          {stance && <p className="mb-1 text-sm font-semibold text-black dark:text-zinc-50">{stance}</p>}
          {rationale && <p className="text-sm text-zinc-700 dark:text-zinc-300">{rationale}</p>}
          {(domesticGuidance || overseasGuidance) && (
            <div className="mt-2 flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
              {domesticGuidance && <p>국내: {domesticGuidance}</p>}
              {overseasGuidance && <p>해외: {overseasGuidance}</p>}
            </div>
          )}
          {disclaimer && <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">{disclaimer}</p>}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {REMAINING_SECTION_KEYS.filter((key) => root[key] !== undefined).map((key) => (
          <details
            key={key}
            className="rounded-lg border border-black/[.08] p-3 dark:border-white/[.145]"
          >
            <summary className="cursor-pointer text-sm font-medium text-black dark:text-zinc-50">
              {SECTION_LABELS[key] ?? humanizeKey(key)}
            </summary>
            <div className="mt-2">
              <JsonEntry value={root[key]} />
            </div>
          </details>
        ))}
      </div>

      {(footerLine || artifactUrl) && (
        <p className="mt-4 text-[10px] text-zinc-400 dark:text-zinc-600">
          {footerLine}
          {artifactUrl && (
            <>
              {footerLine && " · "}
              <a
                href={artifactUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
              >
                원본
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}

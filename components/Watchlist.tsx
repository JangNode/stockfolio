"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import StockCard from "@/components/StockCard";

interface WatchlistItem {
  id: string;
  stock_code: string;
  stock_name: string;
  created_at: string;
}

interface StockSuggestion {
  code: string;
  name: string;
}

const SEARCH_DEBOUNCE_MS = 250;

export default function Watchlist({ user }: { user: User }) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<StockSuggestion[]>([]);
  const [selected, setSelected] = useState<StockSuggestion | null>(null);
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleQueryChange = (value: string) => {
    setQuery(value);
    setSelected(null);

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = value.trim();
    if (!trimmed) {
      setSuggestions([]);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/stock/search?q=${encodeURIComponent(trimmed)}`
        );
        const data = await res.json();
        setSuggestions(res.ok && Array.isArray(data) ? data : []);
      } catch {
        setSuggestions([]);
      }
    }, SEARCH_DEBOUNCE_MS);
  };

  const handleSelectSuggestion = (stock: StockSuggestion) => {
    setQuery(stock.name);
    setSelected(stock);
    setSuggestions([]);
  };

  const {
    data: items,
    error,
    isLoading,
    mutate,
  } = useSWR(["watchlist", user.id], async ([, userId]: [string, string]) => {
    const { data, error } = await supabase
      .from("watchlist")
      .select("id, stock_code, stock_name, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });

    if (error) throw error;
    return data as WatchlistItem[];
  });

  const handleAdd = async () => {
    setFormError("");

    const trimmed = query.trim();
    if (!trimmed) {
      setFormError("종목코드 또는 종목명을 입력해주세요.");
      return;
    }

    setSubmitting(true);

    let stock: StockSuggestion;

    if (selected && selected.name === trimmed) {
      stock = selected;
    } else {
      const resolveRes = await fetch(
        `/api/stock/resolve?q=${encodeURIComponent(trimmed)}`
      );
      const resolved = await resolveRes.json();

      if (!resolveRes.ok) {
        setFormError(resolved.error ?? "종목을 찾을 수 없습니다.");
        setSubmitting(false);
        return;
      }
      stock = resolved;
    }

    const { error: insertError } = await supabase.from("watchlist").insert({
      user_id: user.id,
      stock_code: stock.code,
      stock_name: stock.name,
    });
    setSubmitting(false);

    if (insertError) {
      setFormError(
        insertError.code === "23505"
          ? "이미 관심종목에 추가된 종목입니다."
          : insertError.message
      );
      return;
    }

    setQuery("");
    setSelected(null);
    setSuggestions([]);
    mutate();
  };

  const handleRemove = async (id: string) => {
    await supabase.from("watchlist").delete().eq("id", id);
    mutate();
  };

  return (
    <div className="w-full max-w-5xl">
      <div className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-black/[.08] bg-white p-4 dark:border-white/[.145] dark:bg-zinc-950">
        <div className="relative flex flex-1 flex-col gap-1">
          <label className="text-xs text-zinc-500 dark:text-zinc-400">
            종목코드 또는 종목명
          </label>
          <input
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !submitting) handleAdd();
              if (e.key === "Escape") setSuggestions([]);
            }}
            onBlur={() => {
              window.setTimeout(() => setSuggestions([]), 150);
            }}
            placeholder="005930 또는 삼성전자"
            autoComplete="off"
            className="h-10 w-full min-w-[12rem] rounded-lg border border-black/[.08] bg-transparent px-3 text-sm text-black outline-none focus:border-black/30 dark:border-white/[.145] dark:text-zinc-50 dark:focus:border-white/30"
          />

          {suggestions.length > 0 && (
            <ul className="absolute top-full left-0 z-10 mt-1 w-full overflow-hidden rounded-lg border border-black/[.08] bg-white shadow-lg dark:border-white/[.145] dark:bg-zinc-900">
              {suggestions.map((stock) => (
                <li key={stock.code}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleSelectSuggestion(stock);
                    }}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-black hover:bg-black/[.04] dark:text-zinc-50 dark:hover:bg-white/[.08]"
                  >
                    <span>{stock.name}</span>
                    <span className="text-xs text-zinc-400 dark:text-zinc-500">
                      {stock.code}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          onClick={handleAdd}
          disabled={submitting || !query.trim()}
          className="h-10 rounded-full bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
        >
          {submitting ? "확인 중..." : "추가"}
        </button>
        {formError && (
          <p className="w-full text-sm text-blue-600 dark:text-blue-400">
            {formError}
          </p>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          관심종목을 불러오는 중...
        </p>
      ) : error ? (
        <p className="text-sm text-blue-600 dark:text-blue-400">
          관심종목을 불러오지 못했습니다.
        </p>
      ) : items && items.length > 0 ? (
        <div className="flex flex-wrap gap-6">
          {items.map((item) => (
            <StockCard
              key={item.id}
              code={item.stock_code}
              name={item.stock_name}
              onRemove={() => handleRemove(item.id)}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          관심종목이 없습니다. 종목코드를 입력해 추가해보세요.
        </p>
      )}
    </div>
  );
}

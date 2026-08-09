import { useEffect, useMemo, useRef, useState } from "react";
import { searchPlaces, type LatLng, type PlaceResult } from "../api";
import {
  filterPlaceHistory,
  loadPlaceHistory,
  rememberPlace,
  type CachedPlace,
} from "../placeHistory";

type Props = {
  label: string;
  valueLabel: string;
  onSelect: (place: { label: string; location: LatLng }) => void;
};

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "AbortError" || name === "CanceledError";
}

function shortPlaceLabel(place: PlaceResult): string {
  if (place.street && place.housenumber) {
    return [place.street, place.housenumber, place.city].filter(Boolean).join(" ");
  }
  if (place.street && place.city) return `${place.street}, ${place.city}`;
  const parts = place.label.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.slice(0, 3).join(", ");
}

export function PlaceInput({ label, valueLabel, onSelect }: Props) {
  const [query, setQuery] = useState(valueLabel || "");
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [history, setHistory] = useState<CachedPlace[]>(() => loadPlaceHistory());
  const [historyFilter, setHistoryFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);
  const editingRef = useRef(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Sync filter from in-memory history — localStorage read only on open/save.
  const cachedMatches = useMemo(
    () => filterPlaceHistory(historyFilter, history),
    [historyFilter, history],
  );

  useEffect(() => {
    if (editingRef.current) return;
    if (valueLabel) setQuery(valueLabel);
    else setQuery("");
  }, [valueLabel]);

  useEffect(() => {
    function onDocPointerDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        editingRef.current = false;
      }
    }
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, []);

  /** Open recent list immediately from memory / localStorage — no network. */
  function openHistoryMenu(filter: string) {
    abortRef.current?.abort();
    requestIdRef.current += 1;
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setLoading(false);
    setResults([]);
    setError(null);
    setHistory(loadPlaceHistory());
    setHistoryFilter(filter);
    setOpen(true);
  }

  function runSearch(text: string) {
    const trimmed = text.trim();
    if (!trimmed) {
      openHistoryMenu("");
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestIdRef.current;

    // Keep Recent visible; only the Search section waits on the network.
    setLoading(true);
    setError(null);
    setHistoryFilter(trimmed);
    setOpen(true);

    searchPlaces(trimmed, 8, controller.signal)
      .then((data) => {
        if (requestId !== requestIdRef.current || controller.signal.aborted) return;
        setResults(data.results);
        setError(data.results.length ? null : "No places found in Israel");
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current || isAbortError(err)) return;
        console.error("[places]", err);
        setError(err instanceof Error ? err.message : "Search failed");
        setResults([]);
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
  }

  function onChange(value: string) {
    editingRef.current = true;
    setQuery(value);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);

    // Filter recent in memory immediately (no network, no debounce).
    setHistoryFilter(value);
    setOpen(true);

    if (value.trim().length < 3) {
      abortRef.current?.abort();
      requestIdRef.current += 1;
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    debounceRef.current = window.setTimeout(() => runSearch(value.trim()), 350);
  }

  function commitPlace(place: { label: string; location: LatLng; id?: string }) {
    editingRef.current = false;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = null;
    abortRef.current?.abort();
    requestIdRef.current += 1;
    setLoading(false);
    setHistory(rememberPlace(place));
    onSelect({ label: place.label, location: place.location });
    setQuery(place.label);
    setResults([]);
    setOpen(false);
    setError(null);
    setHistoryFilter("");
  }

  function pickResult(place: PlaceResult) {
    commitPlace({
      id: `${place.source}:${place.id}`,
      label: shortPlaceLabel(place),
      location: place.location,
    });
  }

  function pickCached(place: CachedPlace) {
    commitPlace(place);
  }

  function onInputFocus() {
    editingRef.current = true;
    // Immediate recent menu — do not wait on search state.
    openHistoryMenu(query === valueLabel ? "" : query);
  }

  return (
    <div className="place-input" ref={wrapRef}>
      <label>
        <span>
          {label}
          {loading ? <em className="place-loading">Searching…</em> : null}
        </span>
        <input
          value={query}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onInputFocus}
          onClick={onInputFocus}
          placeholder="Street, place, or city"
          autoComplete="off"
        />
      </label>
      {error ? <p className="field-error">{error}</p> : null}
      {open ? (
        <ul className="place-results" role="listbox" aria-label="Place suggestions">
          <li className="place-results-heading">Recent</li>
          {cachedMatches.length === 0 ? (
            <li className="place-results-empty">No recent places yet</li>
          ) : (
            cachedMatches.map((r) => (
              <li key={`cache:${r.id}`}>
                <button
                  type="button"
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    pickCached(r);
                  }}
                >
                  <strong>{r.label}</strong>
                  <span>Recent</span>
                </button>
              </li>
            ))
          )}
          {loading ? (
            <li className="place-results-empty">Searching…</li>
          ) : results.length > 0 ? (
            <>
              <li className="place-results-heading">Search</li>
              {results.map((r) => (
                <li key={`${r.source}:${r.id}`}>
                  <button
                    type="button"
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.preventDefault();
                      pickResult(r);
                    }}
                  >
                    <strong>{r.label}</strong>
                    <span>
                      {[r.city, r.street, r.housenumber].filter(Boolean).join(" · ") || r.source}
                    </span>
                  </button>
                </li>
              ))}
            </>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

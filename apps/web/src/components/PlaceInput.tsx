import { useEffect, useMemo, useRef, useState } from "react";
import { searchPlaces, type LatLng, type PlaceResult } from "../api";
import { resolveCurrentLocation } from "../currentLocation";
import { shortPlaceLabel } from "../formatPlace";
import {
  filterPlaceHistory,
  loadPlaceHistory,
  rememberPlace,
  type CachedPlace,
} from "../placeHistory";
import { Icon } from "./ui/Icon";

type Props = {
  label: string;
  valueLabel: string;
  endpoint?: "origin" | "destination";
  placeholder?: string;
  embedded?: boolean;
  onSelect: (place: { label: string; location: LatLng }) => void;
  onClear?: () => void;
};

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "AbortError" || name === "CanceledError";
}

export function PlaceInput({
  label,
  valueLabel,
  endpoint,
  placeholder = "Street, place, or city",
  embedded = false,
  onSelect,
  onClear,
}: Props) {
  const [query, setQuery] = useState(valueLabel || "");
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [history, setHistory] = useState<CachedPlace[]>(() => loadPlaceHistory());
  const [historyFilter, setHistoryFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);
  const editingRef = useRef(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Only show recent rows that match what the user typed (never an empty Recent block).
  const cachedMatches = useMemo(() => {
    const q = historyFilter.trim();
    if (!q) return [];
    return filterPlaceHistory(q, history);
  }, [historyFilter, history]);

  const showMenu = open;

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

  function runSearch(text: string) {
    const trimmed = text.trim();
    if (!trimmed) {
      abortRef.current?.abort();
      requestIdRef.current += 1;
      setLoading(false);
      setResults([]);
      setError(null);
      setHistoryFilter("");
      setOpen(true);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestIdRef.current;

    setLoading(true);
    setError(null);
    setHistory(loadPlaceHistory());
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

    setHistory(loadPlaceHistory());
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
    setLocating(false);
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

  async function pickCurrentLocation() {
    editingRef.current = true;
    setOpen(true);
    setLocating(true);
    setError(null);
    try {
      const place = await resolveCurrentLocation();
      commitPlace({ ...place, id: "current-location" });
    } catch (err) {
      console.error("[geolocation]", err);
      setLocating(false);
      setError(
        err instanceof Error ? err.message : "Could not get your location",
      );
    }
  }

  function onInputFocus() {
    editingRef.current = true;
    setHistory(loadPlaceHistory());
    const filter = query === valueLabel ? "" : query;
    setHistoryFilter(filter);
    setOpen(true);
    if (filter.trim().length >= 3) {
      runSearch(filter.trim());
      return;
    }
    setResults([]);
    if (!locating) setError(null);
    setLoading(false);
  }

  return (
    <div
      className={["place-input", endpoint, embedded ? "embedded" : "", showMenu ? "menu-open" : ""]
        .filter(Boolean)
        .join(" ")}
      ref={wrapRef}
    >
      <label>
        <span className="sr-only">
          {label}
          {loading ? " Searching…" : locating ? " Getting location…" : ""}
        </span>
        <div className="place-field">
          {!embedded ? <span className="place-marker" aria-hidden /> : null}
          <input
            value={query}
            onChange={(e) => onChange(e.target.value)}
            onFocus={onInputFocus}
            onClick={onInputFocus}
            placeholder={locating ? "Getting location…" : placeholder}
            autoComplete="off"
          />
          {valueLabel || query ? (
            <button
              type="button"
              className="place-clear"
              aria-label={`Clear ${label}`}
              onClick={() => {
                editingRef.current = false;
                setQuery("");
                setResults([]);
                setOpen(false);
                onClear?.();
              }}
            >
              ×
            </button>
          ) : null}
        </div>
      </label>
      {error && !showMenu ? <p className="field-error">{error}</p> : null}
      {showMenu ? (
        <ul className="place-results" role="listbox" aria-label="Place suggestions">
          <li className="place-current">
            <button
              type="button"
              disabled={locating}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                void pickCurrentLocation();
              }}
            >
              <span className="place-current-icon" aria-hidden>
                {locating ? (
                  <span className="spinner" />
                ) : (
                  <Icon name="locate" size={16} />
                )}
              </span>
              <span className="place-current-text">
                <strong>{locating ? "Getting location…" : "Current location"}</strong>
              </span>
            </button>
          </li>
          {cachedMatches.length > 0 ? (
            <>
              <li className="place-results-heading">Recent</li>
              {cachedMatches.map((r) => (
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
              ))}
            </>
          ) : null}
          {loading ? (
            <li className="place-results-empty">Searching…</li>
          ) : results.length > 0 ? (
            <>
              <li className="place-results-heading">Search</li>
              {results.map((r) => {
                const short = shortPlaceLabel(r);
                return (
                  <li key={`${r.source}:${r.id}`}>
                    <button
                      type="button"
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        pickResult(r);
                      }}
                    >
                      <strong>{short}</strong>
                      <span>
                        {r.city && !short.includes(r.city) ? r.city : r.source}
                      </span>
                    </button>
                  </li>
                );
              })}
            </>
          ) : error ? (
            <li className="place-results-empty">{error}</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

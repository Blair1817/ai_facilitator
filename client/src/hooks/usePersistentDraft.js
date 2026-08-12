import { useCallback, useState } from "react";

const PREFIX = "grail:draft:v1";

export function draftKey({ playerId, roundId = "global", form, field }) {
  return [PREFIX, playerId || "unknown-player", roundId || "global", form, field]
    .map((part) => encodeURIComponent(String(part)))
    .join(":");
}

function readDraft(key, fallback) {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (_error) {
    return fallback;
  }
}

function writeDraft(key, value) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (_error) {
    // Storage can be unavailable in private/restricted browser contexts.
    // The controlled input still works; it simply loses reload recovery.
  }
}

export function clearDraftKeys(keys) {
  if (typeof window === "undefined") return;
  for (const key of keys) {
    try {
      window.localStorage.removeItem(key);
    } catch (_error) {
      // Best effort only; submitted research data is already in Tajriba.
    }
  }
}

export function usePersistentDraft(key, fallback) {
  const [value, setValue] = useState(() => readDraft(key, fallback));
  const setPersistedValue = useCallback((nextValueOrUpdater) => {
    setValue((currentValue) => {
      const nextValue = typeof nextValueOrUpdater === "function"
        ? nextValueOrUpdater(currentValue)
        : nextValueOrUpdater;
      writeDraft(key, nextValue);
      return nextValue;
    });
  }, [key]);
  return [value, setPersistedValue];
}

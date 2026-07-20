"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  BOOKMARK_SYNC_STORAGE_KEY,
  BookmarkController,
  createBookmarkControllerLifecycle,
} from "./bookmark-state.mjs";

const REVALIDATE_DEBOUNCE_MS = 150;

interface BookmarkSnapshot {
  visibleIds: Set<string>;
  confirmedIds: Set<string>;
  pendingIds: Set<string>;
  failedIds: Set<string>;
  serverRevision: number;
  mutationRevision: number;
  ready: boolean;
  syncing: boolean;
  error: string;
}

export function useBookmarks(apiBase: string) {
  const controller = useMemo(
    () => new BookmarkController({ base: apiBase }),
    [apiBase],
  );
  const lifecycle = useMemo(() => createBookmarkControllerLifecycle(), []);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  ) as BookmarkSnapshot;

  useEffect(() => {
    lifecycle.activate(controller);
    void controller.hydrate(browserStorage());
    return () => lifecycle.deactivate(controller);
  }, [controller, lifecycle]);

  useEffect(() => {
    if (!apiBase) return;
    let timer = 0;
    let observedMutationRevision = controller.getSnapshot().mutationRevision;
    const sourceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const scheduleRefresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void controller.refresh(), REVALIDATE_DEBOUNCE_MS);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") scheduleRefresh();
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === BOOKMARK_SYNC_STORAGE_KEY) scheduleRefresh();
    };
    const unsubscribe = controller.subscribe(() => {
      const revision = controller.getSnapshot().mutationRevision;
      if (revision === observedMutationRevision) return;
      observedMutationRevision = revision;
      try {
        window.localStorage.setItem(
          BOOKMARK_SYNC_STORAGE_KEY,
          `${sourceId}:${revision}:${Date.now().toString(36)}`,
        );
      } catch {
        // Focus and visibility revalidation remain available without storage.
      }
    });

    window.addEventListener("focus", scheduleRefresh);
    window.addEventListener("storage", handleStorage);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", scheduleRefresh);
      window.removeEventListener("storage", handleStorage);
      document.removeEventListener("visibilitychange", handleVisibility);
      unsubscribe();
    };
  }, [apiBase, controller]);

  const toggle = useCallback((id: string) => controller.toggle(id), [controller]);
  const refresh = useCallback(() => controller.refresh(), [controller]);
  const retry = useCallback((id?: string) => controller.retry(id), [controller]);

  return { ...snapshot, toggle, refresh, retry };
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

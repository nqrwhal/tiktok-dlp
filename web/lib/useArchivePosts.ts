"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PostPage, ProfilePlatform, SavedPost } from "./types";

export type ArchivePostSource = "mock" | "loading" | "live" | "error";

export function useArchivePosts({
  platform = "",
  bookmarkedOnly = false,
  trashedOnly = false,
  limit = 24,
}: {
  platform?: ProfilePlatform | "";
  bookmarkedOnly?: boolean;
  trashedOnly?: boolean;
  limit?: number;
} = {}) {
  const configuredBase = process.env.NEXT_PUBLIC_ARCHIVE_API_BASE;
  const base = configuredBase?.replace(/\/+$/, "") || "";
  const pageLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 24));
  const [posts, setPosts] = useState<SavedPost[]>([]);
  const [source, setSource] = useState<ArchivePostSource>(configuredBase ? "loading" : "mock");
  const [error, setError] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pendingBookmarkIds, setPendingBookmarkIds] = useState<Set<string>>(() => new Set());
  const [pendingLifecycleIds, setPendingLifecycleIds] = useState<Set<string>>(() => new Set());
  const [revision, setRevision] = useState(0);
  const generationRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const bookmarkMutationsRef = useRef(new Set<string>());
  const lifecycleMutationsRef = useRef(new Set<string>());

  const fetchPage = useCallback(async (cursor = "", signal?: AbortSignal) => {
    const params = new URLSearchParams({ limit: String(pageLimit) });
    if (platform) params.set("platform", platform);
    if (bookmarkedOnly) params.set("bookmarked", "1");
    if (trashedOnly) params.set("trashed", "1");
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`${base}/api/posts?${params}`, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(payload.error || `Live media request failed (${response.status})`);
    }
    const payload = await response.json() as Partial<PostPage>;
    return {
      items: Array.isArray(payload.items) ? payload.items : [],
      nextCursor: typeof payload.nextCursor === "string" && payload.nextCursor
        ? payload.nextCursor
        : null,
    } satisfies PostPage;
  }, [base, bookmarkedOnly, pageLimit, platform, trashedOnly]);

  useEffect(() => {
    if (!configuredBase) return;
    const controller = new AbortController();
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    loadingMoreRef.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPosts([]);
    setNextCursor(null);
    setLoadingMore(false);
    setSource("loading");
    setError("");
    fetchPage("", controller.signal)
      .then((page) => {
        if (controller.signal.aborted || generation !== generationRef.current) return;
        setPosts(page.items);
        setNextCursor(page.nextCursor);
        setSource("live");
      })
      .catch((nextError: unknown) => {
        if (controller.signal.aborted || generation !== generationRef.current) return;
        setSource("error");
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      });
    return () => controller.abort();
  }, [configuredBase, fetchPage, revision]);

  const loadMore = useCallback(async () => {
    if (!configuredBase || !nextCursor || loadingMoreRef.current) return;
    const generation = generationRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setError("");
    try {
      const page = await fetchPage(nextCursor);
      if (generation !== generationRef.current) return;
      setPosts((current) => {
        const byId = new Map(current.map((post) => [post.id, post]));
        for (const post of page.items) byId.set(post.id, post);
        return [...byId.values()];
      });
      setNextCursor(page.nextCursor);
    } catch (nextError) {
      if (generation !== generationRef.current) return;
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [configuredBase, fetchPage, nextCursor]);

  const setBookmarked = useCallback(async (post: SavedPost, bookmarked: boolean) => {
    if (!configuredBase || bookmarkMutationsRef.current.has(post.id)) return;
    const previous = post.bookmarked;
    bookmarkMutationsRef.current.add(post.id);
    setPendingBookmarkIds((current) => new Set(current).add(post.id));
    setError("");
    setPosts((current) => current.map((candidate) => (
      candidate.id === post.id ? { ...candidate, bookmarked } : candidate
    )));
    try {
      const response = await fetch(`${base}/api/post-bookmarks/${encodeURIComponent(post.id)}`, {
        method: bookmarked ? "PUT" : "DELETE",
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; bookmarked?: unknown };
      if (!response.ok) {
        throw new Error(payload.error || `Media bookmark update failed (${response.status})`);
      }
      if (payload.bookmarked !== bookmarked) {
        throw new Error("Media bookmark update returned an invalid response");
      }
    } catch (nextError) {
      setPosts((current) => current.map((candidate) => (
        candidate.id === post.id ? { ...candidate, bookmarked: previous } : candidate
      )));
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      bookmarkMutationsRef.current.delete(post.id);
      setPendingBookmarkIds((current) => {
        const next = new Set(current);
        next.delete(post.id);
        return next;
      });
    }
  }, [base, configuredBase]);

  const mutateLifecycle = useCallback(async (post: SavedPost, action: "trash" | "restore") => {
    if (!configuredBase) return "The live backend connection is required to update this post.";
    if (lifecycleMutationsRef.current.has(post.id)) return "This post update is already in progress.";
    lifecycleMutationsRef.current.add(post.id);
    setPendingLifecycleIds((current) => new Set(current).add(post.id));
    try {
      const restoring = action === "restore";
      const response = await fetch(
        `${base}/api/media-posts/${encodeURIComponent(post.id)}${restoring ? "/restore" : ""}`,
        {
          method: restoring ? "POST" : "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmFileId: Number(post.id) }),
        },
      );
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        fileId?: unknown;
        restoredPost?: unknown;
        trashedPost?: unknown;
      };
      if (!response.ok) {
        throw new Error(payload.error || `Media ${action} failed (${response.status})`);
      }
      const confirmed = restoring ? payload.restoredPost === true : payload.trashedPost === true;
      if (!confirmed || Number(payload.fileId) !== Number(post.id)) {
        throw new Error(`Media ${action} returned an invalid response`);
      }
      setPosts((current) => current.filter((candidate) => candidate.id !== post.id));
      return "";
    } catch (nextError) {
      return nextError instanceof Error ? nextError.message : String(nextError);
    } finally {
      lifecycleMutationsRef.current.delete(post.id);
      setPendingLifecycleIds((current) => {
        const next = new Set(current);
        next.delete(post.id);
        return next;
      });
    }
  }, [base, configuredBase]);

  return {
    posts,
    source,
    error,
    hasMore: Boolean(nextCursor),
    loadingMore,
    pendingBookmarkIds,
    pendingLifecycleIds,
    loadMore,
    setBookmarked,
    moveToTrash: (post: SavedPost) => mutateLifecycle(post, "trash"),
    restore: (post: SavedPost) => mutateLifecycle(post, "restore"),
    refresh: () => setRevision((current) => current + 1),
  };
}

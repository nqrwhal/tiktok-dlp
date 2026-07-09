"use client";

import { useCallback, useEffect, useState } from "react";
import type { ArchiveStats, Creator, SavedVideo } from "./types";

export type ArchiveDataSource = "mock" | "loading" | "live" | "fallback";

export function useArchiveData({
  fallbackCreators,
  fallbackVideos,
  fallbackStats,
  videoCreatorId = "",
  videoUsername = "",
}: {
  fallbackCreators: Creator[];
  fallbackVideos: SavedVideo[];
  fallbackStats: ArchiveStats;
  videoCreatorId?: string;
  videoUsername?: string;
}) {
  const configuredBase = process.env.NEXT_PUBLIC_ARCHIVE_API_BASE;
  const [creators, setCreators] = useState(fallbackCreators);
  const [videos, setVideos] = useState(fallbackVideos);
  const [stats, setStats] = useState(fallbackStats);
  const [source, setSource] = useState<ArchiveDataSource>(configuredBase ? "loading" : "mock");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((current) => current + 1), []);

  useEffect(() => {
    if (!configuredBase) return;

    const controller = new AbortController();
    const base = configuredBase.replace(/\/+$/, "");
    const videoParams = new URLSearchParams({
      limit: videoCreatorId || videoUsername ? "2000" : "500",
    });
    if (videoCreatorId) videoParams.set("creatorId", videoCreatorId);
    if (videoUsername) videoParams.set("username", videoUsername);

    Promise.all([
      fetch(`${base}/api/creators`, {
        cache: "no-store",
        signal: controller.signal,
      }).then(assertJsonResponse<Creator[]>),
      fetch(`${base}/api/videos?${videoParams}`, {
        cache: "no-store",
        signal: controller.signal,
      }).then(assertJsonResponse<SavedVideo[]>),
      fetch(`${base}/api/stats`, {
        cache: "no-store",
        signal: controller.signal,
      }).then(assertJsonResponse<ArchiveStats>),
    ])
      .then(([nextCreators, nextVideos, nextStats]) => {
        setCreators(nextCreators);
        setVideos(nextVideos);
        setStats(nextStats);
        setSource("live");
      })
      .catch((nextError: unknown) => {
        if (controller.signal.aborted) return;
        setSource("fallback");
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      });

    return () => controller.abort();
  }, [configuredBase, revision, videoCreatorId, videoUsername]);

  return { creators, videos, stats, source, error, refresh };
}

async function assertJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Live archive request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

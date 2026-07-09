"use client";

import { useEffect, useState } from "react";
import type { ArchiveStats, Creator, SavedVideo } from "./types";

export type ArchiveDataSource = "mock" | "loading" | "live" | "fallback";

export function useArchiveData({
  fallbackCreators,
  fallbackVideos,
  fallbackStats,
}: {
  fallbackCreators: Creator[];
  fallbackVideos: SavedVideo[];
  fallbackStats: ArchiveStats;
}) {
  const [creators, setCreators] = useState(fallbackCreators);
  const [videos, setVideos] = useState(fallbackVideos);
  const [stats, setStats] = useState(fallbackStats);
  const [source, setSource] = useState<ArchiveDataSource>("mock");
  const [error, setError] = useState("");

  useEffect(() => {
    const configuredBase = process.env.NEXT_PUBLIC_ARCHIVE_API_BASE;
    if (!configuredBase) return;

    const controller = new AbortController();
    const base = configuredBase.replace(/\/+$/, "");
    setSource("loading");
    setError("");

    Promise.all([
      fetch(`${base}/api/creators`, {
        cache: "no-store",
        signal: controller.signal,
      }).then(assertJsonResponse<Creator[]>),
      fetch(`${base}/api/videos?limit=250`, {
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
  }, []);

  return { creators, videos, stats, source, error };
}

async function assertJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Live archive request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

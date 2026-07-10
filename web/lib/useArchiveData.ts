"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ArchiveStats, Creator, SavedVideo } from "./types";

export type ArchiveDataSource = "mock" | "loading" | "refreshing" | "live" | "error";

const emptyStats: ArchiveStats = {
  creatorCount: 0,
  videoCount: 0,
  storageUsed: "0 B",
  storagePercent: 0,
  newThisWeek: 0,
};

export function useArchiveData({
  fallbackCreators,
  fallbackVideos,
  fallbackStats,
  videoCreatorId = "",
  videoUsername = "",
  videoFileId = "",
  videoLimit,
  includeVideos = true,
  includeStats = true,
}: {
  fallbackCreators: Creator[];
  fallbackVideos: SavedVideo[];
  fallbackStats: ArchiveStats;
  videoCreatorId?: string;
  videoUsername?: string;
  videoFileId?: string;
  videoLimit?: number;
  includeVideos?: boolean;
  includeStats?: boolean;
}) {
  const configuredBase = process.env.NEXT_PUBLIC_ARCHIVE_API_BASE;
  const liveMode = Boolean(configuredBase);
  const [creators, setCreators] = useState(liveMode ? [] : fallbackCreators);
  const [videos, setVideos] = useState(liveMode ? [] : fallbackVideos);
  const [stats, setStats] = useState(liveMode ? emptyStats : fallbackStats);
  const [source, setSource] = useState<ArchiveDataSource>(configuredBase ? "loading" : "mock");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const hasLoadedLiveData = useRef(false);
  const refresh = useCallback(() => setRevision((current) => current + 1), []);

  useEffect(() => {
    if (!configuredBase) return;

    const controller = new AbortController();
    const base = configuredBase.replace(/\/+$/, "");
    setSource(hasLoadedLiveData.current ? "refreshing" : "loading");
    setError("");
    const videoParams = new URLSearchParams({
      limit: String(videoLimit || (videoCreatorId || videoUsername ? 2_000 : 500)),
    });
    if (videoCreatorId) videoParams.set("creatorId", videoCreatorId);
    if (videoUsername) videoParams.set("username", videoUsername);
    if (videoFileId) videoParams.set("fileId", videoFileId);

    Promise.allSettled([
      fetch(`${base}/api/creators`, {
        cache: "no-store",
        signal: controller.signal,
      }).then(assertJsonResponse<Creator[]>),
      includeVideos
        ? fetch(`${base}/api/videos?${videoParams}`, {
          cache: "no-store",
          signal: controller.signal,
        }).then(assertJsonResponse<SavedVideo[]>)
        : Promise.resolve([] as SavedVideo[]),
      includeStats
        ? fetch(`${base}/api/stats`, {
          cache: "no-store",
          signal: controller.signal,
        }).then(assertJsonResponse<ArchiveStats>)
        : Promise.resolve(emptyStats),
    ])
      .then(([creatorResult, videoResult, statsResult]) => {
        if (controller.signal.aborted) return;
        const failures: string[] = [];

        if (creatorResult.status === "fulfilled") setCreators(creatorResult.value);
        else failures.push(errorMessage("creators", creatorResult.reason));
        if (videoResult.status === "fulfilled") setVideos(videoResult.value);
        else failures.push(errorMessage("videos", videoResult.reason));
        if (statsResult.status === "fulfilled") setStats(statsResult.value);
        else failures.push(errorMessage("archive totals", statsResult.reason));

        const receivedLiveData = creatorResult.status === "fulfilled"
          || (includeVideos && videoResult.status === "fulfilled")
          || (includeStats && statsResult.status === "fulfilled");
        if (receivedLiveData) hasLoadedLiveData.current = true;
        setSource(hasLoadedLiveData.current ? "live" : "error");
        setError(failures.join(" "));
      })
      .catch((nextError: unknown) => {
        if (controller.signal.aborted) return;
        setSource(hasLoadedLiveData.current ? "live" : "error");
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      });

    return () => controller.abort();
  }, [configuredBase, includeStats, includeVideos, revision, videoCreatorId, videoFileId, videoLimit, videoUsername]);

  return { creators, videos, stats, source, error, refresh };
}

function errorMessage(resource: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return `Could not load ${resource}: ${detail}`;
}

async function assertJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Live archive request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

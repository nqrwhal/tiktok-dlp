"use client";

import {
  Bookmark,
  ExternalLink,
  LayoutDashboard,
  Library,
  LoaderCircle,
  MoreHorizontal,
  Pause,
  Play,
  Share2,
  Shuffle,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CreatorPicker } from "../CreatorPicker";
import { resolveCreatorId } from "../../lib/creator-id";
import { mockStats } from "../../lib/mock-data";
import {
  readAutoplayPreference,
  readDefaultFeed,
  readMutedPreference,
  writeMutedPreference,
} from "../../lib/playback-preferences";
import type { Creator, SavedVideo } from "../../lib/types";
import { reconcileVersionedIds } from "../../lib/archive-data-state.mjs";
import { useArchiveData } from "../../lib/useArchiveData";
import { useModalDialog } from "../../lib/useModalDialog";
import styles from "./mobile-feed.module.css";

interface MobileFeedProps {
  creators: Creator[];
  videos: SavedVideo[];
}

const BOOKMARK_STORAGE_KEY = "rewind-bookmarks";
const BOOKMARK_MIGRATION_STORAGE_KEY = "rewind-bookmarks-server-migrated-v1";
const FEED_HINT_STORAGE_KEY = "rewind-feed-hint-seen";
const VIDEO_PAGE_SIZE = 36;
const CARD_WINDOW_SIZE = 7;
const CARD_WINDOW_BEHIND = 3;
const PRELOAD_AHEAD = 2;
const PLAYABLE_READY_STATE = 2;
const KEYBOARD_SEEK_SECONDS = 5;

export function MobileFeed({ creators, videos }: MobileFeedProps) {
  const searchParams = useSearchParams();
  const apiBase = process.env.NEXT_PUBLIC_ARCHIVE_API_BASE?.replace(/\/+$/, "") || "";
  const requestedVideoId = searchParams.get("video") || "";
  const requestedCreatorId = searchParams.get("creator") || "all";
  const requestedJumpHandled = useRef(!requestedVideoId);
  const [creatorId, setCreatorId] = useState(requestedCreatorId);
  const archive = useArchiveData({
    fallbackCreators: creators,
    fallbackVideos: videos,
    fallbackStats: mockStats,
    videoCreatorId: creatorId === "all" ? "" : creatorId,
    videoFileId: requestedVideoId,
    videoLimit: VIDEO_PAGE_SIZE,
    paginateVideos: true,
    includeStats: false,
  });
  const liveCreators = archive.creators;
  const archiveVideos = archive.videos;
  const {
    hasMoreVideos,
    hasMoreBookmarkedVideos,
    loadingBookmarkedVideos,
    loadingMoreVideos,
    loadBookmarkedVideos,
    loadMoreBookmarkedVideos,
    loadMoreVideos,
  } = archive;
  const [activeId, setActiveId] = useState(requestedVideoId);
  const [shuffleSeed, setShuffleSeed] = useState(0);
  const [shuffleReady, setShuffleReady] = useState(false);
  const [muted, setMuted] = useState(true);
  const [mutePreferenceReady, setMutePreferenceReady] = useState(false);
  const [autoplayEnabled, setAutoplayEnabled] = useState(true);
  const [paused, setPaused] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [playbackError, setPlaybackError] = useState("");
  const [presentedVideoId, setPresentedVideoId] = useState("");
  const [preloadReadyVideoId, setPreloadReadyVideoId] = useState("");
  const [controlsVisible, setControlsVisible] = useState(false);
  const [menuVideoId, setMenuVideoId] = useState("");
  const [feedView, setFeedView] = useState<"all" | "bookmarks">("all");
  const [saved, setSaved] = useState<Set<string>>(() => new Set());
  const [bookmarksReady, setBookmarksReady] = useState(false);
  const [shareStatus, setShareStatus] = useState("");
  const [deleteVideo, setDeleteVideo] = useState<SavedVideo | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [feedStatus, setFeedStatus] = useState("");
  const [hintVisible, setHintVisible] = useState(false);
  const [removedVideoIds, setRemovedVideoIds] = useState<Set<string>>(() => new Set());
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());
  const activeIdRef = useRef(activeId);
  const failedVideoIdsRef = useRef(new Set<string>());
  const skipMutedPreferenceWrite = useRef(false);
  const feedScrollerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLSpanElement>(null);
  const seekRef = useRef<HTMLInputElement>(null);
  const wasPausedBeforeDeleteRef = useRef(false);
  const bookmarkMutationVersionsRef = useRef(new Map<string, number>());
  const { dialogRef, returnFocusRef } = useModalDialog(Boolean(deleteVideo), closeDeleteVideo);

  const liveVideos = useMemo(
    () => archiveVideos.filter((video) => !removedVideoIds.has(video.id)),
    [archiveVideos, removedVideoIds],
  );

  const resolvedCreatorId = useMemo(
    () => resolveCreatorId(creatorId, liveCreators),
    [creatorId, liveCreators],
  );
  const orderedVideos = useMemo(
    () => shuffleVideoPages(liveVideos, shuffleSeed, VIDEO_PAGE_SIZE),
    [liveVideos, shuffleSeed],
  );
  const creatorVideos = useMemo(
    () =>
      resolvedCreatorId === "all"
        ? orderedVideos
        : orderedVideos.filter((video) => video.creatorId === resolvedCreatorId),
    [orderedVideos, resolvedCreatorId],
  );
  const filteredVideos = useMemo(
    () => feedView === "bookmarks"
      ? creatorVideos.filter((video) => saved.has(video.id))
      : creatorVideos,
    [creatorVideos, feedView, saved],
  );
  const controlsAvailable = filteredVideos.length > 0;
  const hasActiveVideo = filteredVideos.some((video) => video.id === activeId);
  const requestedVideoPending = Boolean(requestedVideoId)
    && (archive.source === "loading" || archive.source === "refreshing")
    && !hasActiveVideo;
  const currentActiveId = hasActiveVideo
    ? activeId
    : requestedVideoPending
      ? ""
      : filteredVideos[0]?.id ?? "";
  const activeIndex = filteredVideos.findIndex((video) => video.id === currentActiveId);
  const windowAnchor = Math.max(activeIndex, 0);
  const unclampedWindowStart = Math.max(0, windowAnchor - CARD_WINDOW_BEHIND);
  const windowStart = Math.max(
    0,
    Math.min(unclampedWindowStart, filteredVideos.length - CARD_WINDOW_SIZE),
  );
  const windowEnd = Math.min(filteredVideos.length, windowStart + CARD_WINDOW_SIZE);
  const renderedVideos = useMemo(
    () => filteredVideos.slice(windowStart, windowEnd),
    [filteredVideos, windowEnd, windowStart],
  );

  const playIfReady = useCallback((id: string, video: HTMLVideoElement) => {
    if (!mutePreferenceReady || id !== currentActiveId || id !== activeIdRef.current || paused) return;

    video.muted = muted;
    if (video.readyState < PLAYABLE_READY_STATE) {
      // Keep the poster visible and audio stopped until a video frame and a
      // small forward buffer are decoded. Safari can otherwise start AAC
      // playback several seconds before a heavier H.264/HEVC frame appears.
      video.pause();
      setBuffering(true);
      if (video.networkState === HTMLMediaElement.NETWORK_EMPTY) video.load();
      return;
    }

    video.play().catch((error: unknown) => {
      if (isAbortError(error) || id !== activeIdRef.current) return;
      if (!video.muted && isAutoplayPolicyError(error)) {
        video.muted = true;
        skipMutedPreferenceWrite.current = true;
        setMuted(true);
        void video.play().catch((retryError: unknown) => {
          if (isAbortError(retryError) || id !== activeIdRef.current) return;
          setPaused(true);
          setPlaybackError("Playback was blocked. Tap play to retry.");
        });
        return;
      }
      setPaused(true);
      setPlaybackError("This video could not start. Tap play to retry.");
    });
  }, [currentActiveId, mutePreferenceReady, muted, paused]);

  useEffect(() => {
    // Live production data arrives after hydration, so choosing the seed here
    // avoids a server/client order mismatch while still varying every visit.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShuffleSeed(randomFeedSeed());
    setShuffleReady(true);
  }, []);

  useEffect(() => {
    if (!controlsAvailable) return;
    try {
      if (window.localStorage.getItem(FEED_HINT_STORAGE_KEY) === "1") return;
      window.localStorage.setItem(FEED_HINT_STORAGE_KEY, "1");
    } catch {
      // The hint can still appear when storage is unavailable.
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHintVisible(true);
    const timer = window.setTimeout(() => setHintVisible(false), 4_500);
    return () => window.clearTimeout(timer);
  }, [controlsAvailable]);

  useEffect(() => {
    // Start muted for autoplay, then restore this device's last explicit choice.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMuted(readMutedPreference(window.localStorage));
    const autoplay = readAutoplayPreference(window.localStorage);
    setAutoplayEnabled(autoplay);
    setPaused(!autoplay);
    // Exact links from the library and creator gallery must always reveal the
    // requested file, even if this device normally opens on Bookmarks.
    setFeedView(requestedVideoId ? "all" : readDefaultFeed(window.localStorage));
    setMutePreferenceReady(true);
  }, [requestedVideoId]);

  useEffect(() => {
    if (!mutePreferenceReady) return;
    if (skipMutedPreferenceWrite.current) {
      skipMutedPreferenceWrite.current = false;
      return;
    }
    writeMutedPreference(window.localStorage, muted);
  }, [mutePreferenceReady, muted]);

  useEffect(() => {
    const controller = new AbortController();
    let localBookmarks = new Set<string>();
    try {
      const stored = JSON.parse(window.localStorage.getItem(BOOKMARK_STORAGE_KEY) || "[]");
      if (Array.isArray(stored)) {
        localBookmarks = new Set(stored.filter((id): id is string => typeof id === "string"));
        // Keep the existing device state visible while the server responds.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSaved(localBookmarks);
      }
    } catch {
      window.localStorage.removeItem(BOOKMARK_STORAGE_KEY);
    }

    if (!apiBase) {
      setBookmarksReady(true);
      return () => controller.abort();
    }

    const shouldMigrate = localBookmarks.size > 0
      && window.localStorage.getItem(BOOKMARK_MIGRATION_STORAGE_KEY) !== "1";
    const bookmarkVersionsAtRequest = new Map(bookmarkMutationVersionsRef.current);
    fetch(`${apiBase}/api/bookmarks`, {
      method: shouldMigrate ? "POST" : "GET",
      headers: shouldMigrate ? { "content-type": "application/json" } : undefined,
      body: shouldMigrate ? JSON.stringify({ fileIds: [...localBookmarks] }) : undefined,
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({})) as { fileIds?: unknown; error?: string };
        if (!response.ok) throw new Error(payload.error || `Bookmark sync failed (${response.status})`);
        return Array.isArray(payload.fileIds)
          ? payload.fileIds.filter((id): id is number | string => typeof id === "number" || typeof id === "string")
          : [];
      })
      .then((fileIds) => {
        if (controller.signal.aborted) return;
        setSaved((current) => reconcileVersionedIds(
          fileIds.map(String),
          current,
          bookmarkVersionsAtRequest,
          bookmarkMutationVersionsRef.current,
        ));
        window.localStorage.setItem(BOOKMARK_MIGRATION_STORAGE_KEY, "1");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFeedStatus(error instanceof Error ? error.message : "Bookmarks could not sync.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setBookmarksReady(true);
      });
    return () => controller.abort();
  }, [apiBase]);

  useEffect(() => {
    if (!bookmarksReady) return;
    window.localStorage.setItem(BOOKMARK_STORAGE_KEY, JSON.stringify([...saved]));
  }, [bookmarksReady, saved]);

  useEffect(() => {
    if (feedView !== "bookmarks" || !bookmarksReady) return;
    void loadBookmarkedVideos();
  }, [bookmarksReady, feedView, loadBookmarkedVideos]);

  useEffect(() => {
    activeIdRef.current = currentActiveId;
  }, [currentActiveId]);

  useEffect(() => {
    if (!shuffleReady || requestedJumpHandled.current) return;
    const target = Array.from(feedScrollerRef.current?.querySelectorAll<HTMLElement>("[data-video-id]") || [])
      .find((node) => node.dataset.videoId === requestedVideoId);
    if (target) {
      requestedJumpHandled.current = true;
      target.scrollIntoView({ block: "start" });
      return;
    }
    if (archiveVideos.some((video) => video.id === requestedVideoId)) return;
    if (archive.source !== "loading" && archive.source !== "refreshing") requestedJumpHandled.current = true;
  }, [archive.source, archiveVideos, filteredVideos, requestedVideoId, shuffleReady]);

  useEffect(() => {
    if (!shuffleReady) return;
    const nodes = Array.from(
      feedScrollerRef.current?.querySelectorAll<HTMLElement>("[data-feed-card]") || [],
    );
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        const id = visible?.target.getAttribute("data-video-id");
        if (id && requestedJumpHandled.current && id !== activeIdRef.current) {
          activeIdRef.current = id;
          const nextVideo = videoRefs.current.get(id);
          const failed = failedVideoIdsRef.current.has(id);
          setActiveId(id);
          setPreloadReadyVideoId(
            !failed && nextVideo?.readyState >= PLAYABLE_READY_STATE ? id : "",
          );
          setPaused(failed || !autoplayEnabled);
          setBuffering(!failed);
          setPlaybackError(failed ? "This archived file could not be played." : "");
          setPresentedVideoId("");
          setControlsVisible(false);
          setMenuVideoId("");
          if (progressRef.current) progressRef.current.style.width = "0%";
          if (seekRef.current) seekRef.current.value = "0";
        }
      },
      { threshold: [0.65, 0.82] },
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [autoplayEnabled, renderedVideos, shuffleReady]);

  useEffect(() => {
    if (!shuffleReady) return;
    for (const [id, video] of videoRefs.current) {
      if (id === currentActiveId && !paused) {
        playIfReady(id, video);
      } else {
        video.pause();
      }
    }
  }, [currentActiveId, muted, paused, playIfReady, shuffleReady]);

  useEffect(() => {
    if (activeIndex < 0) return;

    const lastIndex = Math.min(filteredVideos.length - 1, activeIndex + PRELOAD_AHEAD);
    for (let index = activeIndex; index <= lastIndex; index += 1) {
      const video = videoRefs.current.get(filteredVideos[index].id);
      if (video?.networkState === HTMLMediaElement.NETWORK_EMPTY) video.load();
    }
  }, [activeIndex, filteredVideos]);

  useEffect(() => {
    if (
      feedView !== "all"
      || !hasMoreVideos
      || loadingMoreVideos
      || activeIndex < filteredVideos.length - 8
    ) return;
    void loadMoreVideos();
  }, [activeIndex, feedView, filteredVideos.length, hasMoreVideos, loadingMoreVideos, loadMoreVideos]);

  const setVideoRef = useCallback(
    (id: string, node: HTMLVideoElement | null) => {
      if (node) videoRefs.current.set(id, node);
      else videoRefs.current.delete(id);
    },
    [],
  );

  const resetFeedPosition = useCallback((nextActiveId: string) => {
    feedScrollerRef.current?.scrollTo({ top: 0, behavior: "auto" });
    activeIdRef.current = nextActiveId;
    setActiveId(nextActiveId);
    if (nextActiveId !== currentActiveId) {
      const failed = failedVideoIdsRef.current.has(nextActiveId);
      const nextElement = videoRefs.current.get(nextActiveId);
      setPaused(failed || !autoplayEnabled);
      setBuffering(Boolean(nextActiveId) && !failed);
      setPlaybackError(failed ? "This archived file could not be played." : "");
      setPresentedVideoId("");
      setPreloadReadyVideoId(
        !failed && nextElement?.readyState >= PLAYABLE_READY_STATE ? nextActiveId : "",
      );
      if (progressRef.current) progressRef.current.style.width = "0%";
      if (seekRef.current) seekRef.current.value = "0";
    }
    setControlsVisible(false);
    setMenuVideoId("");
  }, [autoplayEnabled, currentActiveId]);

  const toggleSaved = useCallback((id: string) => {
    const wasSaved = saved.has(id);
    const willSave = !wasSaved;
    if (feedView === "bookmarks" && wasSaved) {
      const nextVideos = creatorVideos.filter((video) => video.id !== id && saved.has(video.id));
      resetFeedPosition(nextVideos[0]?.id || "");
    }
    setSaved((current) => {
      const next = new Set(current);
      if (willSave) next.add(id);
      else next.delete(id);
      return next;
    });

    if (!apiBase) return;
    const version = (bookmarkMutationVersionsRef.current.get(id) || 0) + 1;
    bookmarkMutationVersionsRef.current.set(id, version);
    void fetch(`${apiBase}/api/bookmarks/${encodeURIComponent(id)}`, {
      method: willSave ? "PUT" : "DELETE",
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || `Bookmark update failed (${response.status})`);
    }).catch((error: unknown) => {
      if (bookmarkMutationVersionsRef.current.get(id) !== version) return;
      setSaved((current) => {
        const next = new Set(current);
        if (wasSaved) next.add(id);
        else next.delete(id);
        return next;
      });
      setFeedStatus(error instanceof Error ? error.message : "Bookmark update failed.");
    });
  }, [apiBase, creatorVideos, feedView, resetFeedPosition, saved]);

  async function shareVideo(video: SavedVideo) {
    if (navigator.share) {
      await navigator.share({ title: video.title, url: video.sourceUrl }).catch(() => undefined);
      return;
    }
    try {
      await navigator.clipboard.writeText(video.sourceUrl);
      setShareStatus("Original link copied");
      window.setTimeout(() => setShareStatus(""), 1800);
    } catch {
      setShareStatus("Could not copy the link");
    }
  }

  function openDeleteVideo(video: SavedVideo) {
    returnFocusRef.current = document.getElementById(`feed-more-${video.id}`);
    wasPausedBeforeDeleteRef.current = paused;
    setPaused(true);
    setMenuVideoId("");
    setDeleteVideo(video);
    setDeleteError("");
  }

  function closeDeleteVideo() {
    if (deleting) return;
    setDeleteVideo(null);
    setDeleteError("");
    setPaused(wasPausedBeforeDeleteRef.current);
  }

  async function confirmDeleteVideo() {
    if (!deleteVideo || deleting) return;
    if (!apiBase) {
      setDeleteError("The live backend connection is required to move videos to trash.");
      return;
    }

    setDeleting(true);
    setDeleteError("");
    try {
      const response = await fetch(`${apiBase}/api/videos/${encodeURIComponent(deleteVideo.id)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmFileId: deleteVideo.id }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || `Move to trash failed (${response.status})`);
      }

      const deletedIndex = filteredVideos.findIndex((video) => video.id === deleteVideo.id);
      const nextVideo = filteredVideos[deletedIndex + 1] || filteredVideos[deletedIndex - 1];
      const nextId = nextVideo?.id || "";
      const nextFailed = failedVideoIdsRef.current.has(nextId);
      const nextElement = videoRefs.current.get(nextId);
      activeIdRef.current = nextId;
      setActiveId(nextId);
      setPreloadReadyVideoId(
        !nextFailed && nextElement?.readyState >= PLAYABLE_READY_STATE ? nextId : "",
      );
      setPaused(!autoplayEnabled || !nextId || nextFailed);
      setBuffering(Boolean(nextId) && !nextFailed);
      setPlaybackError(nextFailed ? "This archived file could not be played." : "");
      setPresentedVideoId("");
      setControlsVisible(false);
      setSaved((current) => {
        const next = new Set(current);
        next.delete(deleteVideo.id);
        return next;
      });
      setRemovedVideoIds((current) => new Set(current).add(deleteVideo.id));
      returnFocusRef.current = document.getElementById("feed-stage");
      setDeleteVideo(null);
      setFeedStatus(`Moved “${deleteVideo.title}” to trash.`);
      window.setTimeout(() => setFeedStatus(""), 2600);
      archive.refresh();

      if (nextId) {
        window.requestAnimationFrame(() => {
          const target = Array.from(document.querySelectorAll<HTMLElement>("[data-video-id]"))
            .find((node) => node.dataset.videoId === nextId);
          target?.scrollIntoView({ block: "start" });
        });
      }
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  }

  function selectCreator(id: string) {
    if (id === resolvedCreatorId) return;
    const nextCreatorVideos = id === "all"
      ? orderedVideos
      : orderedVideos.filter((video) => video.creatorId === id);
    const nextVideos = feedView === "bookmarks"
      ? nextCreatorVideos.filter((video) => saved.has(video.id))
      : nextCreatorVideos;
    setCreatorId(id);
    resetFeedPosition(nextVideos[0]?.id || "");
  }

  function selectFeedView(view: "all" | "bookmarks") {
    if (view === feedView) return;
    if (view === "bookmarks") void loadBookmarkedVideos();
    const nextVideos = view === "bookmarks"
      ? creatorVideos.filter((video) => saved.has(video.id))
      : creatorVideos;
    setFeedView(view);
    resetFeedPosition(nextVideos[0]?.id || "");
  }

  function shuffleFeed() {
    const nextSeed = randomFeedSeed();
    const nextOrdered = shuffleVideos(liveVideos, nextSeed);
    const nextCreatorVideos = resolvedCreatorId === "all"
      ? nextOrdered
      : nextOrdered.filter((video) => video.creatorId === resolvedCreatorId);
    const nextVideos = feedView === "bookmarks"
      ? nextCreatorVideos.filter((video) => saved.has(video.id))
      : nextCreatorVideos;
    setShuffleSeed(nextSeed);
    resetFeedPosition(nextVideos[0]?.id || "");
  }

  const toggleMute = useCallback(() => {
    const nextMuted = !muted;
    const activeVideo = videoRefs.current.get(currentActiveId);
    if (activeVideo) activeVideo.muted = nextMuted;
    setMuted(nextMuted);
  }, [currentActiveId, muted]);

  const retryPlayback = useCallback(() => {
    const activeVideo = videoRefs.current.get(currentActiveId);
    const shouldReload = Boolean(
      playbackError || activeVideo?.error || failedVideoIdsRef.current.has(currentActiveId),
    );
    failedVideoIdsRef.current.delete(currentActiveId);
    setPlaybackError("");
    setBuffering(true);
    setPaused(false);
    if (activeVideo && shouldReload) {
      setPreloadReadyVideoId("");
      activeVideo.load();
    }
  }, [currentActiveId, playbackError]);

  useEffect(() => {
    function handleFeedShortcut(event: KeyboardEvent) {
      if (
        event.defaultPrevented
        || event.metaKey
        || event.ctrlKey
        || event.altKey
        || event.shiftKey
        || deleteVideo
        || shouldIgnoreFeedShortcut(event.target)
      ) return;

      const key = event.key.toLowerCase();
      if (event.repeat && (key === " " || key === "m" || key === "b")) return;
      if ([" ", "arrowup", "arrowdown", "arrowleft", "arrowright", "m", "b"].includes(key)) {
        setHintVisible(false);
      }

      if (key === " ") {
        if (!currentActiveId) return;
        event.preventDefault();
        if (paused) retryPlayback();
        else setPaused(true);
        return;
      }

      if (key === "arrowup" || key === "arrowdown") {
        const offset = key === "arrowup" ? -1 : 1;
        const nextVideo = filteredVideos[activeIndex + offset];
        event.preventDefault();
        if (!nextVideo) {
          if (key === "arrowdown" && feedView === "all" && hasMoreVideos) void loadMoreVideos();
          return;
        }
        const target = Array.from(feedScrollerRef.current?.querySelectorAll<HTMLElement>("[data-video-id]") || [])
          .find((node) => node.dataset.videoId === nextVideo.id);
        target?.scrollIntoView({ block: "start", behavior: "smooth" });
        return;
      }

      if (key === "arrowleft" || key === "arrowright") {
        const video = videoRefs.current.get(currentActiveId);
        if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
        event.preventDefault();
        const delta = key === "arrowleft" ? -KEYBOARD_SEEK_SECONDS : KEYBOARD_SEEK_SECONDS;
        video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + delta));
        const percentage = video.currentTime / video.duration * 100;
        if (progressRef.current) progressRef.current.style.width = `${percentage}%`;
        if (seekRef.current) seekRef.current.value = String(percentage);
        return;
      }

      if (key === "m") {
        if (!currentActiveId) return;
        event.preventDefault();
        toggleMute();
        return;
      }

      if (key === "b") {
        if (!currentActiveId) return;
        event.preventDefault();
        toggleSaved(currentActiveId);
      }
    }

    document.addEventListener("keydown", handleFeedShortcut);
    return () => document.removeEventListener("keydown", handleFeedShortcut);
  }, [activeIndex, currentActiveId, deleteVideo, feedView, filteredVideos, hasMoreVideos, loadMoreVideos, paused, retryPlayback, toggleMute, toggleSaved]);

  const showControlBar = controlsVisible || !controlsAvailable;

  return (
    <main className={styles.appShell}>
      <h1 className="sr-only">Saved video feed</h1>
      <section
        className={styles.stage}
        id="feed-stage"
        tabIndex={-1}
        aria-label="Saved video feed"
        aria-keyshortcuts="Space ArrowUp ArrowDown ArrowLeft ArrowRight M B"
      >
        <div
          className={`${styles.controlBar} ${showControlBar ? styles.controlBarVisible : ""}`}
          aria-hidden={!showControlBar}
          inert={!showControlBar ? true : undefined}
        >
          <div className={styles.feedTabs} aria-label="Feed view">
            <button
              className={feedView === "all" ? styles.feedTabActive : styles.feedTab}
              type="button"
              aria-pressed={feedView === "all"}
              onClick={() => selectFeedView("all")}
            >
              All
            </button>
            <button
              className={feedView === "bookmarks" ? styles.feedTabActive : styles.feedTab}
              type="button"
              aria-pressed={feedView === "bookmarks"}
              onClick={() => selectFeedView("bookmarks")}
            >
              Bookmarks
            </button>
          </div>
          <div className={styles.controlRow}>
            <CreatorPicker
              creators={liveCreators}
              value={resolvedCreatorId}
              onChange={selectCreator}
              compact
            />
            <div className={styles.controlActions}>
              <Link className={styles.iconButton} href="/dashboard/videos" aria-label="Open video library">
                <Library size={19} />
              </Link>
              <button
                className={styles.iconButton}
                onClick={shuffleFeed}
                type="button"
                aria-label="Shuffle feed"
                disabled={!controlsAvailable}
              >
                <Shuffle size={18} />
              </button>
              <button
                className={styles.iconButton}
                onClick={toggleMute}
                type="button"
                aria-label={muted ? "Turn sound on" : "Mute videos"}
                disabled={!currentActiveId}
              >
                {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
              </button>
              <button
                className={styles.iconButton}
                onClick={() => paused ? retryPlayback() : setPaused(true)}
                type="button"
                aria-label={paused ? "Play video" : "Pause video"}
                disabled={!currentActiveId}
              >
                {paused ? <Play size={18} fill="currentColor" /> : <Pause size={18} fill="currentColor" />}
              </button>
            </div>
          </div>
          {archive.error ? (
            <div className={styles.feedNotice} role="alert">
              <span>{archive.error}</span>
              <button type="button" onClick={archive.refresh}>Retry</button>
            </div>
          ) : null}
        </div>

        {hintVisible && controlsAvailable ? (
          <p className={styles.feedHint} role="status">Tap for controls · swipe to browse</p>
        ) : null}

        <div id="feed-video-list" className={styles.feedScroller} ref={feedScrollerRef}>
          {windowStart > 0 ? (
            <div
              className={styles.feedSpacer}
              style={{ height: `${windowStart * 100}%` }}
              aria-hidden="true"
            />
          ) : null}
          {renderedVideos.map((video, windowIndex) => {
            const index = windowStart + windowIndex;
            const isActive = video.id === currentActiveId;
            // Give the first visible video the connection to itself. Once its
            // first frame starts, preload the next two cards. Keeping older and
            // farther cards poster-only prevents competing media streams.
            const shouldPreload = isActive
              || (
                preloadReadyVideoId === currentActiveId
                && index > activeIndex
                && index <= activeIndex + PRELOAD_AHEAD
              );
            const isSaved = saved.has(video.id);
            const showControls = isActive && controlsVisible;
            return (
              <article
                className={styles.feedCard}
                data-feed-card
                data-video-id={video.id}
                key={video.id}
                style={{ "--wash": video.accent } as React.CSSProperties}
              >
                {shouldPreload ? (
                  <video
                    className={styles.video}
                    ref={(node) => setVideoRef(video.id, node)}
                    src={video.videoUrl}
                    muted={muted}
                    loop
                    playsInline
                    preload="auto"
                    aria-label={`${video.title} by ${video.displayName}`}
                    onTimeUpdate={(event) => {
                      if (activeIdRef.current !== video.id) return;
                      const element = event.currentTarget;
                      const value = element.duration ? element.currentTime / element.duration : 0;
                      if (progressRef.current) {
                        progressRef.current.style.width = `${Math.max(0, Math.min(1, value)) * 100}%`;
                      }
                      if (seekRef.current) seekRef.current.value = String(value * 100);
                    }}
                    onLoadedData={(event) => playIfReady(video.id, event.currentTarget)}
                    onCanPlay={(event) => {
                      if (activeIdRef.current === video.id) setPreloadReadyVideoId(video.id);
                      playIfReady(video.id, event.currentTarget);
                    }}
                    onPlaying={(event) => {
                      if (activeIdRef.current !== video.id) return;
                      const element = event.currentTarget;
                      failedVideoIdsRef.current.delete(video.id);
                      setBuffering(false);
                      setPlaybackError("");
                      setPaused(false);
                      setPreloadReadyVideoId(video.id);
                      if (typeof element.requestVideoFrameCallback === "function") {
                        element.requestVideoFrameCallback(() => {
                          if (activeIdRef.current === video.id) setPresentedVideoId(video.id);
                        });
                      } else {
                        setPresentedVideoId(video.id);
                      }
                    }}
                    onWaiting={() => {
                      if (activeIdRef.current === video.id) setBuffering(true);
                    }}
                    onError={() => {
                      failedVideoIdsRef.current.add(video.id);
                      if (activeIdRef.current !== video.id) return;
                      setPreloadReadyVideoId("");
                      setPaused(true);
                      setBuffering(false);
                      setPlaybackError("This archived file could not be played.");
                    }}
                  />
                ) : null}
                {video.thumbnailUrl ? (
                  // Thumbnails stay lazy while preventing black cards during fast scrolling.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className={`${styles.videoPoster} ${presentedVideoId === video.id ? styles.videoPosterHidden : ""}`}
                    src={video.thumbnailUrl}
                    alt=""
                    loading={isActive || index === activeIndex + 1 ? "eager" : "lazy"}
                    fetchPriority={isActive ? "high" : "low"}
                    decoding="async"
                  />
                ) : null}
                <div className={`${styles.videoTint} ${showControls ? styles.videoTintVisible : ""}`} />
                <button
                  className={styles.videoTapTarget}
                  type="button"
                  onClick={() => {
                    if (!isActive) return;
                    setHintVisible(false);
                    setControlsVisible((value) => !value);
                    setMenuVideoId("");
                  }}
                  tabIndex={isActive ? 0 : -1}
                  aria-hidden={!isActive}
                  aria-label={controlsVisible ? `Hide controls for ${video.title}` : `Show controls for ${video.title}`}
                />

                {isActive && (paused || playbackError) ? (
                  <button
                    className={styles.playOverlay}
                    type="button"
                    onClick={retryPlayback}
                    aria-label={playbackError ? "Retry video" : "Play video"}
                  >
                    <Play size={32} fill="currentColor" />
                  </button>
                ) : null}

                {showControls ? <div className={`${styles.videoMeta} ${styles.videoMetaVisible}`}>
                  <Link
                    className={styles.creatorName}
                    href={`/creator?creator=${encodeURIComponent(video.creatorId)}&video=${encodeURIComponent(video.id)}`}
                    aria-label={`View videos by @${video.username}`}
                  >
                    @{video.username}
                  </Link>
                  <h2>{video.title}</h2>
                  {video.description && video.description !== video.title ? (
                    <p>{video.description}</p>
                  ) : null}
                  {video.tags.length ? (
                    <div className={styles.tags}>
                      {video.tags.map((tag) => <span key={tag}>#{tag}</span>)}
                    </div>
                  ) : null}
                  {playbackError ? <p className={styles.playbackStatus} role="alert">{playbackError}</p> : null}
                  {buffering && !paused ? <p className={styles.playbackStatus}>Buffering…</p> : null}
                  {shareStatus ? <p className={styles.playbackStatus} role="status">{shareStatus}</p> : null}
                </div> : null}

                {showControls ? <div className={`${styles.minimalActions} ${styles.minimalActionsVisible}`}>
                  <button
                    className={isSaved ? styles.bookmarkActive : undefined}
                    type="button"
                    onClick={() => toggleSaved(video.id)}
                    aria-label={isSaved ? `Remove bookmark for ${video.title}` : `Bookmark ${video.title}`}
                    aria-pressed={isSaved}
                  >
                    <Bookmark size={21} fill={isSaved ? "currentColor" : "none"} />
                  </button>
                  <button type="button" onClick={() => shareVideo(video)} aria-label={`Share ${video.title}`}>
                    <Share2 size={21} />
                  </button>
                  <button
                    id={`feed-more-${video.id}`}
                    type="button"
                    onClick={() => setMenuVideoId((current) => current === video.id ? "" : video.id)}
                    aria-label={`More actions for ${video.title}`}
                    aria-expanded={menuVideoId === video.id}
                    aria-controls={`feed-menu-${video.id}`}
                  >
                    <MoreHorizontal size={22} />
                  </button>
                  {menuVideoId === video.id ? (
                    <div
                      className={styles.moreMenu}
                      id={`feed-menu-${video.id}`}
                      onKeyDown={(event) => {
                        if (event.key !== "Escape") return;
                        event.preventDefault();
                        setMenuVideoId("");
                        window.requestAnimationFrame(() => {
                          document.getElementById(`feed-more-${video.id}`)?.focus();
                        });
                      }}
                    >
                      <a href={video.sourceUrl} target="_blank" rel="noreferrer">
                        <ExternalLink size={17} /> Original post
                      </a>
                      <Link href="/dashboard">
                        <LayoutDashboard size={17} /> Dashboard
                      </Link>
                      <button
                        className={styles.deleteMenuAction}
                        type="button"
                        onClick={() => openDeleteVideo(video)}
                      >
                        <Trash2 size={17} /> Move to trash
                      </button>
                    </div>
                  ) : null}
                </div> : null}

                <div className={styles.progressTrack}>
                  <span ref={isActive ? progressRef : undefined} />
                  <input
                    ref={isActive ? seekRef : undefined}
                    type="range"
                    min="0"
                    max="100"
                    step="0.1"
                    defaultValue="0"
                    disabled={!isActive}
                    tabIndex={isActive ? 0 : -1}
                    aria-label={`Seek ${video.title}`}
                    onInput={(event) => {
                      const element = videoRefs.current.get(video.id);
                      const percentage = Number(event.currentTarget.value);
                      if (!element || !Number.isFinite(element.duration) || element.duration <= 0) return;
                      element.currentTime = element.duration * percentage / 100;
                      if (progressRef.current) progressRef.current.style.width = `${percentage}%`;
                    }}
                  />
                </div>
              </article>
            );
          })}
          {windowEnd < filteredVideos.length ? (
            <div
              className={styles.feedSpacer}
              style={{ height: `${(filteredVideos.length - windowEnd) * 100}%` }}
              aria-hidden="true"
            />
          ) : null}

          {filteredVideos.length === 0 ? (
            <div className={styles.emptyFeed}>
              <h2>
                {archive.source === "loading" || archive.source === "refreshing" || (feedView === "bookmarks" && !bookmarksReady)
                  ? "Loading videos…"
                  : archive.source === "error"
                    ? "Could not load the archive"
                    : feedView === "bookmarks" ? "No bookmarks" : "No saved videos"}
              </h2>
              <p>
                {archive.source === "error"
                  ? archive.error
                  : feedView === "bookmarks" && loadingBookmarkedVideos
                    ? "Loading your server bookmarks."
                  : feedView === "bookmarks"
                  ? "Bookmark a video and it will appear here."
                  : "There are no files for this creator."}
              </p>
              <div className={styles.emptyActions}>
                {archive.source === "error" ? (
                  <button type="button" onClick={archive.refresh}>Retry</button>
                ) : null}
                {resolvedCreatorId !== "all" ? (
                  <button type="button" onClick={() => selectCreator("all")}>All creators</button>
                ) : null}
                {feedView === "bookmarks" && bookmarksReady ? (
                  <button
                    type="button"
                    aria-controls="feed-video-list"
                    aria-busy={loadingBookmarkedVideos}
                    aria-disabled={loadingBookmarkedVideos || !hasMoreBookmarkedVideos}
                    onClick={() => void loadMoreBookmarkedVideos()}
                  >
                    {loadingBookmarkedVideos
                      ? "Loading more bookmarks…"
                      : hasMoreBookmarkedVideos ? "Load more bookmarks" : "All bookmarks loaded"}
                  </button>
                ) : null}
                <Link href="/dashboard/videos">Open library</Link>
              </div>
            </div>
          ) : null}
          {feedView === "bookmarks" && bookmarksReady && filteredVideos.length > 0 ? (
            <div className={styles.emptyActions}>
              <button
                type="button"
                aria-controls="feed-video-list"
                aria-busy={loadingBookmarkedVideos}
                aria-disabled={loadingBookmarkedVideos || !hasMoreBookmarkedVideos}
                onClick={() => void loadMoreBookmarkedVideos()}
              >
                {loadingBookmarkedVideos
                  ? "Loading more bookmarks…"
                  : hasMoreBookmarkedVideos ? "Load more bookmarks" : "All bookmarks loaded"}
              </button>
            </div>
          ) : null}
        </div>
        {loadingMoreVideos ? (
          <p className="sr-only" role="status">Loading more videos…</p>
        ) : null}
        {feedStatus ? <p className={styles.feedToast} role="status">{feedStatus}</p> : null}
      </section>

      {deleteVideo ? (
        <div
          className={styles.confirmScrim}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !deleting) closeDeleteVideo();
          }}
        >
          <section
            className={styles.confirmDialog}
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="feed-delete-title"
            aria-describedby="feed-delete-description"
          >
            <div className={styles.confirmIcon}><Trash2 size={20} /></div>
            <div>
              <h2 id="feed-delete-title">Move this video to trash?</h2>
              <p id="feed-delete-description">
                <strong>{deleteVideo.title}</strong>
                <span>@{deleteVideo.username} · saved {deleteVideo.savedAtLabel}</span>
                It will leave the active archive now and be permanently deleted after the configured retention period.
              </p>
            </div>
            {deleteError ? <p className={styles.deleteError} role="alert">{deleteError}</p> : null}
            <div className={styles.confirmActions}>
              <button data-dialog-initial type="button" onClick={closeDeleteVideo} disabled={deleting}>
                Cancel
              </button>
              <button
                className={styles.confirmDeleteButton}
                type="button"
                disabled={deleting}
                onClick={() => void confirmDeleteVideo()}
              >
                {deleting ? <LoaderCircle className={styles.spinning} size={16} /> : <Trash2 size={16} />}
                {deleting ? "Moving" : "Move to trash"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function randomFeedSeed(): number {
  try {
    const value = new Uint32Array(1);
    window.crypto.getRandomValues(value);
    return value[0] || Date.now();
  } catch {
    return Date.now();
  }
}

function shuffleVideos(videos: SavedVideo[], seed: number): SavedVideo[] {
  return [...videos].sort((left, right) => {
    const rankDifference = feedRank(left.id, seed) - feedRank(right.id, seed);
    return rankDifference || left.id.localeCompare(right.id);
  });
}

function shuffleVideoPages(videos: SavedVideo[], seed: number, pageSize: number): SavedVideo[] {
  const shuffled: SavedVideo[] = [];
  for (let start = 0; start < videos.length; start += pageSize) {
    shuffled.push(...shuffleVideos(videos.slice(start, start + pageSize), seed ^ start));
  }
  return shuffled;
}

function feedRank(id: string, seed: number): number {
  let hash = (2166136261 ^ seed) >>> 0;
  for (const character of id) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function isAutoplayPolicyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "NotAllowedError";
}

function shouldIgnoreFeedShortcut(target: EventTarget | null): boolean {
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return true;
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(
    'input, textarea, select, button, a[href], [role="textbox"], [contenteditable]:not([contenteditable="false"]), [role="dialog"]',
  ));
}

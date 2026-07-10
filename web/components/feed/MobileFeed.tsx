"use client";

import {
  Bookmark,
  ExternalLink,
  LayoutDashboard,
  Library,
  MoreHorizontal,
  Pause,
  Play,
  Share2,
  Shuffle,
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
import { useArchiveData } from "../../lib/useArchiveData";
import styles from "./mobile-feed.module.css";

interface MobileFeedProps {
  creators: Creator[];
  videos: SavedVideo[];
}

const BOOKMARK_STORAGE_KEY = "rewind-bookmarks";
const PRELOAD_BEHIND = 1;
const PRELOAD_AHEAD = 4;
const POSTER_PRELOAD_BEHIND = 2;
const POSTER_PRELOAD_AHEAD = 10;
const PLAYABLE_READY_STATE = 3;

export function MobileFeed({ creators, videos }: MobileFeedProps) {
  const searchParams = useSearchParams();
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
    videoLimit: 5_000,
    includeStats: false,
  });
  const liveCreators = archive.creators;
  const liveVideos = archive.videos;
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
  const [controlsVisible, setControlsVisible] = useState(false);
  const [menuVideoId, setMenuVideoId] = useState("");
  const [feedView, setFeedView] = useState<"all" | "bookmarks">("all");
  const [saved, setSaved] = useState<Set<string>>(() => new Set());
  const [bookmarksReady, setBookmarksReady] = useState(false);
  const [shareStatus, setShareStatus] = useState("");
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());
  const activeIdRef = useRef(activeId);
  const failedVideoIdsRef = useRef(new Set<string>());
  const skipMutedPreferenceWrite = useRef(false);
  const feedScrollerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLSpanElement>(null);

  const resolvedCreatorId = useMemo(
    () => resolveCreatorId(creatorId, liveCreators),
    [creatorId, liveCreators],
  );
  const orderedVideos = useMemo(
    () => shuffleVideos(liveVideos, shuffleSeed),
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
    try {
      const stored = JSON.parse(window.localStorage.getItem(BOOKMARK_STORAGE_KEY) || "[]");
      if (Array.isArray(stored)) {
        // Bookmarks are a device-local archive preference until the backend exposes them.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSaved(new Set(stored.filter((id): id is string => typeof id === "string")));
      }
    } catch {
      window.localStorage.removeItem(BOOKMARK_STORAGE_KEY);
    }
    setBookmarksReady(true);
  }, []);

  useEffect(() => {
    if (!bookmarksReady) return;
    window.localStorage.setItem(BOOKMARK_STORAGE_KEY, JSON.stringify([...saved]));
  }, [bookmarksReady, saved]);

  useEffect(() => {
    activeIdRef.current = currentActiveId;
  }, [currentActiveId]);

  useEffect(() => {
    if (!shuffleReady || requestedJumpHandled.current) return;
    const target = Array.from(document.querySelectorAll<HTMLElement>("[data-video-id]"))
      .find((node) => node.dataset.videoId === requestedVideoId);
    if (target) {
      requestedJumpHandled.current = true;
      target.scrollIntoView({ block: "start" });
      return;
    }
    if (archive.source !== "loading" && archive.source !== "refreshing") requestedJumpHandled.current = true;
  }, [archive.source, filteredVideos, requestedVideoId, shuffleReady]);

  useEffect(() => {
    if (!shuffleReady) return;
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>("[data-feed-card]"),
    );
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        const id = visible?.target.getAttribute("data-video-id");
        if (id && requestedJumpHandled.current && id !== activeIdRef.current) {
          activeIdRef.current = id;
          setActiveId(id);
          const failed = failedVideoIdsRef.current.has(id);
          setPaused(failed || !autoplayEnabled);
          setBuffering(!failed);
          setPlaybackError(failed ? "This archived file could not be played." : "");
          setPresentedVideoId("");
          setControlsVisible(false);
          setMenuVideoId("");
          if (progressRef.current) progressRef.current.style.width = "0%";
        }
      },
      { threshold: [0.65, 0.82] },
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [autoplayEnabled, filteredVideos, shuffleReady]);

  useEffect(() => {
    if (!shuffleReady) return;
    for (const [id, video] of videoRefs.current) {
      video.muted = muted;
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

  const setVideoRef = useCallback(
    (id: string, node: HTMLVideoElement | null) => {
      if (node) videoRefs.current.set(id, node);
      else videoRefs.current.delete(id);
    },
    [],
  );

  function toggleSaved(id: string) {
    if (feedView === "bookmarks" && saved.has(id)) {
      const nextVideos = creatorVideos.filter((video) => video.id !== id && saved.has(video.id));
      resetFeedPosition(nextVideos[0]?.id || "");
    }
    setSaved((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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

  function resetFeedPosition(nextActiveId: string) {
    feedScrollerRef.current?.scrollTo({ top: 0, behavior: "auto" });
    activeIdRef.current = nextActiveId;
    setActiveId(nextActiveId);
    if (nextActiveId !== currentActiveId) {
      const failed = failedVideoIdsRef.current.has(nextActiveId);
      setPaused(failed || !autoplayEnabled);
      setBuffering(!failed);
      setPlaybackError(failed ? "This archived file could not be played." : "");
      setPresentedVideoId("");
      if (progressRef.current) progressRef.current.style.width = "0%";
    }
    setControlsVisible(false);
    setMenuVideoId("");
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

  function toggleMute() {
    const nextMuted = !muted;
    const activeVideo = videoRefs.current.get(currentActiveId);
    if (activeVideo) activeVideo.muted = nextMuted;
    setMuted(nextMuted);
  }

  function retryPlayback() {
    const activeVideo = videoRefs.current.get(currentActiveId);
    const shouldReload = Boolean(
      playbackError || activeVideo?.error || failedVideoIdsRef.current.has(currentActiveId),
    );
    failedVideoIdsRef.current.delete(currentActiveId);
    setPlaybackError("");
    setBuffering(true);
    setPaused(false);
    if (activeVideo && shouldReload) activeVideo.load();
  }

  const controlsAvailable = filteredVideos.length > 0;
  const showControlBar = controlsVisible || !controlsAvailable;

  return (
    <main className={styles.appShell}>
      <h1 className="sr-only">Saved video feed</h1>
      <section className={styles.stage} aria-label="Saved video feed">
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

        <div className={styles.feedScroller} ref={feedScrollerRef}>
          {filteredVideos.map((video, index) => {
            const isActive = video.id === currentActiveId;
            const shouldPreload = activeIndex >= 0
              && index >= activeIndex - PRELOAD_BEHIND
              && index <= activeIndex + PRELOAD_AHEAD;
            const posterAnchor = Math.max(activeIndex, 0);
            const shouldPreloadPoster = index >= posterAnchor - POSTER_PRELOAD_BEHIND
              && index <= posterAnchor + POSTER_PRELOAD_AHEAD;
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
                    }}
                    onCanPlay={(event) => playIfReady(video.id, event.currentTarget)}
                    onPlaying={(event) => {
                      if (activeIdRef.current !== video.id) return;
                      const element = event.currentTarget;
                      failedVideoIdsRef.current.delete(video.id);
                      setBuffering(false);
                      setPlaybackError("");
                      setPaused(false);
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
                    loading={shouldPreloadPoster ? "eager" : "lazy"}
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
                    </div>
                  ) : null}
                </div> : null}

                <div className={styles.progressTrack} aria-hidden="true">
                  <span ref={isActive ? progressRef : undefined} />
                </div>
              </article>
            );
          })}

          {filteredVideos.length === 0 ? (
            <div className={styles.emptyFeed}>
              <h2>
                {archive.source === "loading" || archive.source === "refreshing"
                  ? "Loading videos…"
                  : archive.source === "error"
                    ? "Could not load the archive"
                    : feedView === "bookmarks" ? "No bookmarks" : "No saved videos"}
              </h2>
              <p>
                {archive.source === "error"
                  ? archive.error
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
                <Link href="/dashboard/videos">Open library</Link>
              </div>
            </div>
          ) : null}
        </div>
      </section>
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

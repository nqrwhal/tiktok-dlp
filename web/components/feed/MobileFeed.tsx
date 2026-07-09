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
  Volume2,
  VolumeX,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CreatorPicker } from "../CreatorPicker";
import { mockStats } from "../../lib/mock-data";
import type { Creator, SavedVideo } from "../../lib/types";
import { useArchiveData } from "../../lib/useArchiveData";
import styles from "./mobile-feed.module.css";

interface MobileFeedProps {
  creators: Creator[];
  videos: SavedVideo[];
}

export function MobileFeed({ creators, videos }: MobileFeedProps) {
  const archive = useArchiveData({
    fallbackCreators: creators,
    fallbackVideos: videos,
    fallbackStats: mockStats,
  });
  const liveCreators = archive.creators;
  const liveVideos = archive.videos;
  const [creatorId, setCreatorId] = useState("all");
  const [activeId, setActiveId] = useState(liveVideos[0]?.id ?? "");
  const [muted, setMuted] = useState(true);
  const [paused, setPaused] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);
  const [menuVideoId, setMenuVideoId] = useState("");
  const [saved, setSaved] = useState<Set<string>>(() => new Set());
  const [progress, setProgress] = useState(0);
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());

  const filteredVideos = useMemo(
    () =>
      creatorId === "all"
        ? liveVideos
        : liveVideos.filter((video) => video.creatorId === creatorId),
    [creatorId, liveVideos],
  );
  const currentActiveId = filteredVideos.some((video) => video.id === activeId)
    ? activeId
    : filteredVideos[0]?.id ?? "";
  const activeIndex = filteredVideos.findIndex((video) => video.id === currentActiveId);

  useEffect(() => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>("[data-feed-card]"),
    );
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        const id = visible?.target.getAttribute("data-video-id");
        if (id) {
          setActiveId(id);
          setPaused(false);
          setControlsVisible(false);
          setMenuVideoId("");
          setProgress(0);
        }
      },
      { threshold: [0.65, 0.82] },
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [filteredVideos]);

  useEffect(() => {
    for (const [id, video] of videoRefs.current) {
      video.muted = muted;
      if (id === currentActiveId && !paused) {
        video.play().catch(() => undefined);
      } else {
        video.pause();
      }
    }
  }, [currentActiveId, muted, paused]);

  const setVideoRef = useCallback(
    (id: string, node: HTMLVideoElement | null) => {
      if (node) videoRefs.current.set(id, node);
      else videoRefs.current.delete(id);
    },
    [],
  );

  function toggleSaved(id: string) {
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
    await navigator.clipboard?.writeText(video.sourceUrl).catch(() => undefined);
  }

  return (
    <main className={styles.appShell}>
      <section className={styles.stage} aria-label="Saved video feed">
        <div className={`${styles.controlBar} ${controlsVisible ? styles.controlBarVisible : ""}`}>
          <CreatorPicker
            creators={liveCreators}
            value={creatorId}
            onChange={setCreatorId}
            compact
          />
          <div className={styles.controlActions}>
            <Link className={styles.iconButton} href="/dashboard/videos" aria-label="Open video library">
              <Library size={19} />
            </Link>
            <button
              className={styles.iconButton}
              onClick={() => setMuted((value) => !value)}
              type="button"
              aria-label={muted ? "Turn sound on" : "Mute videos"}
            >
              {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
            </button>
            <button
              className={styles.iconButton}
              onClick={() => setPaused((value) => !value)}
              type="button"
              aria-label={paused ? "Play video" : "Pause video"}
            >
              {paused ? <Play size={18} fill="currentColor" /> : <Pause size={18} fill="currentColor" />}
            </button>
          </div>
        </div>

        <div className={styles.feedScroller}>
          {filteredVideos.map((video, index) => {
            const isActive = video.id === currentActiveId;
            const shouldLoad = activeIndex >= 0 && Math.abs(index - activeIndex) <= 1;
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
                <video
                  className={styles.video}
                  ref={(node) => setVideoRef(video.id, node)}
                  src={shouldLoad ? video.videoUrl : undefined}
                  muted={muted}
                  loop
                  playsInline
                  preload={isActive ? "auto" : shouldLoad ? "metadata" : "none"}
                  aria-label={`${video.title} by ${video.displayName}`}
                  onTimeUpdate={(event) => {
                    if (!isActive) return;
                    const element = event.currentTarget;
                    setProgress(element.duration ? element.currentTime / element.duration : 0);
                  }}
                  onLoadedMetadata={(event) => {
                    if (!isActive) return;
                    const element = event.currentTarget;
                    setProgress(element.duration ? element.currentTime / element.duration : 0);
                  }}
                />
                <div className={`${styles.videoTint} ${showControls ? styles.videoTintVisible : ""}`} />
                <button
                  className={styles.videoTapTarget}
                  type="button"
                  onClick={() => {
                    if (!isActive) return;
                    setControlsVisible((value) => !value);
                    setMenuVideoId("");
                  }}
                  aria-label={controlsVisible ? "Hide video controls" : "Show video controls"}
                />

                {isActive && paused ? (
                  <button
                    className={styles.playOverlay}
                    type="button"
                    onClick={() => setPaused(false)}
                    aria-label="Play video"
                  >
                    <Play size={32} fill="currentColor" />
                  </button>
                ) : null}

                <div className={`${styles.videoMeta} ${showControls ? styles.videoMetaVisible : ""}`}>
                  <span className={styles.creatorName}>@{video.username}</span>
                  <h1>{video.title}</h1>
                  {video.description && video.description !== video.title ? (
                    <p>{video.description}</p>
                  ) : null}
                  {video.tags.length ? (
                    <div className={styles.tags}>
                      {video.tags.map((tag) => <span key={tag}>#{tag}</span>)}
                    </div>
                  ) : null}
                </div>

                <div className={`${styles.minimalActions} ${showControls ? styles.minimalActionsVisible : ""}`}>
                  <button type="button" onClick={() => shareVideo(video)} aria-label="Share">
                    <Share2 size={21} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setMenuVideoId((current) => current === video.id ? "" : video.id)}
                    aria-label="More actions"
                    aria-expanded={menuVideoId === video.id}
                  >
                    <MoreHorizontal size={22} />
                  </button>
                  {menuVideoId === video.id ? (
                    <div className={styles.moreMenu}>
                      <button type="button" onClick={() => toggleSaved(video.id)}>
                        <Bookmark size={17} fill={isSaved ? "currentColor" : "none"} />
                        {isSaved ? "Remove bookmark" : "Bookmark"}
                      </button>
                      <a href={video.sourceUrl} target="_blank" rel="noreferrer">
                        <ExternalLink size={17} /> Original post
                      </a>
                      <Link href="/dashboard">
                        <LayoutDashboard size={17} /> Dashboard
                      </Link>
                    </div>
                  ) : null}
                </div>

                <div className={styles.progressTrack} aria-hidden="true">
                  <span style={{ width: isActive ? `${Math.max(0, Math.min(1, progress)) * 100}%` : "0%" }} />
                </div>
              </article>
            );
          })}

          {filteredVideos.length === 0 ? (
            <div className={styles.emptyFeed}>
              <h2>No saved videos</h2>
              <p>There are no files for this creator.</p>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}

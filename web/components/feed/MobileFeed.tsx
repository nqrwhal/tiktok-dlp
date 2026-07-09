"use client";

import {
  Bookmark,
  ChevronDown,
  Heart,
  Home,
  LayoutDashboard,
  Library,
  MessageCircle,
  MoreHorizontal,
  Music2,
  Pause,
  Play,
  Search,
  Share2,
  Volume2,
  VolumeX,
} from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { mockStats } from "../../lib/mock-data";
import type { Creator, SavedVideo } from "../../lib/types";
import { useArchiveData } from "../../lib/useArchiveData";
import styles from "./mobile-feed.module.css";

interface MobileFeedProps {
  creators: Creator[];
  videos: SavedVideo[];
}

function compactNumber(value: number) {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
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
  const [liked, setLiked] = useState<Set<string>>(() => new Set());
  const [saved, setSaved] = useState<Set<string>>(() => new Set());
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());

  const filteredVideos = useMemo(
    () =>
      creatorId === "all"
        ? liveVideos
        : liveVideos.filter((video) => video.creatorId === creatorId),
    [creatorId, liveVideos],
  );
  const activeIndex = filteredVideos.findIndex((video) => video.id === activeId);

  useEffect(() => {
    if (!filteredVideos.some((video) => video.id === activeId)) {
      setActiveId(filteredVideos[0]?.id ?? "");
    }
  }, [activeId, filteredVideos]);

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
      if (id === activeId && !paused) {
        video.play().catch(() => undefined);
      } else {
        video.pause();
      }
    }
  }, [activeId, muted, paused]);

  const setVideoRef = useCallback(
    (id: string, node: HTMLVideoElement | null) => {
      if (node) videoRefs.current.set(id, node);
      else videoRefs.current.delete(id);
    },
    [],
  );

  function toggleSet(
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    id: string,
  ) {
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <main className={styles.appShell}>
      <aside className={styles.desktopRail} aria-label="Primary navigation">
        <Link className={styles.wordmark} href="/" aria-label="Rewind feed">
          <span className={styles.mark}>R</span>
          <span>rewind</span>
        </Link>

        <nav className={styles.railNav}>
          <Link className={`${styles.railLink} ${styles.railLinkActive}`} href="/">
            <Home size={20} /> Feed
          </Link>
          <Link className={styles.railLink} href="/dashboard/videos">
            <Library size={20} /> Library
          </Link>
          <Link className={styles.railLink} href="/dashboard">
            <LayoutDashboard size={20} /> Dashboard
          </Link>
        </nav>

        <div className={styles.creatorSection}>
          <div className={styles.railLabel}>Creators</div>
          {liveCreators.slice(0, 5).map((creator) => (
            <button
              className={`${styles.creatorShortcut} ${
                creatorId === creator.id ? styles.creatorShortcutActive : ""
              }`}
              key={creator.id}
              onClick={() => setCreatorId(creator.id)}
              type="button"
            >
              <span
                className={styles.miniAvatar}
                style={{ "--avatar": creator.accent } as React.CSSProperties}
              >
                {creator.initials}
              </span>
              <span>@{creator.username}</span>
            </button>
          ))}
        </div>

        <div className={styles.railFooter}>
          <span className={styles.liveDot} /> {archive.source === "live" ? "Live archive connected" : "Preview archive"}
        </div>
      </aside>

      <section className={styles.stage} aria-label="Saved video feed">
        <header className={styles.feedHeader}>
          <button className={styles.iconButton} type="button" aria-label="Search archive">
            <Search size={21} />
          </button>
          <div className={styles.feedTabs}>
            <button className={styles.tabMuted} type="button">
              Latest
            </button>
            <button className={styles.tabActive} type="button">
              Saved feed
            </button>
          </div>
          <button
            className={styles.iconButton}
            onClick={() => setMuted((value) => !value)}
            type="button"
            aria-label={muted ? "Turn sound on" : "Mute videos"}
          >
            {muted ? <VolumeX size={21} /> : <Volume2 size={21} />}
          </button>
        </header>

        <div className={styles.creatorFilter}>
          <label>
            <span className="sr-only">Filter by creator</span>
            <select
              value={creatorId}
              onChange={(event) => setCreatorId(event.target.value)}
            >
              <option value="all">All creators</option>
              {liveCreators.map((creator) => (
                <option value={creator.id} key={creator.id}>
                  @{creator.username}
                </option>
              ))}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </label>
          <span>{filteredVideos.length} in preview</span>
        </div>

        <div className={styles.feedScroller}>
          {filteredVideos.map((video, index) => {
            const isActive = video.id === activeId;
            const shouldLoad = activeIndex >= 0 && Math.abs(index - activeIndex) <= 1;
            const isLiked = liked.has(video.id);
            const isSaved = saved.has(video.id);
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
                />
                <div className={styles.videoTint} />
                <button
                  className={styles.videoTapTarget}
                  type="button"
                  onClick={() => isActive && setPaused((value) => !value)}
                  aria-label={paused && isActive ? "Play video" : "Pause video"}
                />

                {isActive && paused ? (
                  <button
                    className={styles.playOverlay}
                    type="button"
                    onClick={() => setPaused(false)}
                    aria-label="Play video"
                  >
                    <Play size={34} fill="currentColor" />
                  </button>
                ) : null}

                <div className={styles.demoBadge}>
                  {archive.source === "live"
                    ? "Live · yufeihl"
                    : archive.source === "loading"
                      ? "Connecting…"
                      : archive.source === "fallback"
                        ? "Offline fallback"
                        : "Preview media"}
                </div>

                <div className={styles.videoMeta}>
                  <div className={styles.creatorLine}>
                    <span>@{video.username}</span>
                    <button type="button">View creator</button>
                  </div>
                  <h1>{video.title}</h1>
                  <p>{video.description}</p>
                  <div className={styles.tags}>
                    {video.tags.map((tag) => (
                      <span key={tag}>#{tag}</span>
                    ))}
                  </div>
                  <div className={styles.soundLine}>
                    <Music2 size={15} />
                    <span>Original audio · {video.displayName}</span>
                  </div>
                </div>

                <div className={styles.actionRail}>
                  <button className={styles.avatarAction} type="button" aria-label={`Open ${video.displayName}`}>
                    <span style={{ background: video.accent }}>
                      {video.displayName.slice(0, 1)}
                    </span>
                    <b>+</b>
                  </button>
                  <button
                    className={isLiked ? styles.actionActive : undefined}
                    onClick={() => toggleSet(setLiked, video.id)}
                    type="button"
                    aria-label={isLiked ? "Unlike" : "Like"}
                    aria-pressed={isLiked}
                  >
                    <span><Heart size={25} fill={isLiked ? "currentColor" : "none"} /></span>
                    <small>{compactNumber(video.likes + (isLiked ? 1 : 0))}</small>
                  </button>
                  <button type="button" aria-label="Open notes">
                    <span><MessageCircle size={25} /></span>
                    <small>Notes</small>
                  </button>
                  <button
                    className={isSaved ? styles.savedActive : undefined}
                    onClick={() => toggleSet(setSaved, video.id)}
                    type="button"
                    aria-label={isSaved ? "Remove bookmark" : "Bookmark"}
                    aria-pressed={isSaved}
                  >
                    <span><Bookmark size={24} fill={isSaved ? "currentColor" : "none"} /></span>
                    <small>{compactNumber(video.bookmarks + (isSaved ? 1 : 0))}</small>
                  </button>
                  <button type="button" aria-label="Share">
                    <span><Share2 size={24} /></span>
                    <small>Share</small>
                  </button>
                  <button type="button" aria-label="More actions">
                    <span><MoreHorizontal size={25} /></span>
                  </button>
                </div>

                <div className={styles.progressTrack}>
                  <span className={isActive && !paused ? styles.progressActive : ""} />
                </div>
              </article>
            );
          })}

          {filteredVideos.length === 0 ? (
            <div className={styles.emptyFeed}>
              <Pause size={28} />
              <h2>No saved videos yet</h2>
              <p>This creator’s next download will appear here automatically.</p>
            </div>
          ) : null}
        </div>

        <nav className={styles.mobileNav} aria-label="Mobile navigation">
          <Link className={styles.mobileNavActive} href="/">
            <Home size={22} fill="currentColor" />
            <span>Feed</span>
          </Link>
          <Link href="/dashboard/videos">
            <Library size={22} />
            <span>Library</span>
          </Link>
          <Link href="/dashboard">
            <LayoutDashboard size={22} />
            <span>Manage</span>
          </Link>
        </nav>
      </section>

      <aside className={styles.desktopContext}>
        <span className={styles.eyebrow}>Now viewing</span>
        <h2>Saved feed</h2>
        <p>Use ↑ and ↓ or your trackpad to move through the archive.</p>
        <div className={styles.keyboardHint}>
          <kbd>↑</kbd><kbd>↓</kbd><span>Navigate</span>
        </div>
        <div className={styles.contextDivider} />
        <span className={styles.eyebrow}>Queue</span>
        <strong>{filteredVideos.length} videos</strong>
        <Link href="/dashboard/videos">Manage library <span>↗</span></Link>
      </aside>
    </main>
  );
}

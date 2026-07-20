"use client";

import { ArrowLeft, Grid3X3, Library, LoaderCircle, Play } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { resolveCreatorId } from "../../lib/creator-id";
import { mockStats } from "../../lib/mock-data";
import type { Creator, SavedVideo } from "../../lib/types";
import { useArchiveData } from "../../lib/useArchiveData";
import styles from "./creator-gallery.module.css";

interface CreatorGalleryProps {
  creators: Creator[];
  videos: SavedVideo[];
}

export function CreatorGallery({ creators, videos }: CreatorGalleryProps) {
  const searchParams = useSearchParams();
  const creatorId = searchParams.get("creator") || "";
  const returnVideoId = searchParams.get("video") || "";
  const archive = useArchiveData({
    fallbackCreators: creators,
    fallbackVideos: videos,
    fallbackStats: mockStats,
    videoCreatorId: creatorId,
    videoLimit: 60,
    paginateVideos: true,
    includeVideos: Boolean(creatorId),
    includeStats: false,
  });
  const resolvedCreatorId = useMemo(
    () => resolveCreatorId(creatorId, archive.creators),
    [archive.creators, creatorId],
  );
  const creator = archive.creators.find((item) => item.id === resolvedCreatorId);
  const [failedThumbnails, setFailedThumbnails] = useState<Set<string>>(() => new Set());
  const creatorVideos = useMemo(
    () => archive.videos.filter((video) => video.creatorId === resolvedCreatorId),
    [archive.videos, resolvedCreatorId],
  );
  const username = creator?.username || "creator";
  const displayName = creator?.displayName || username;
  const initials = creator?.initials || username.slice(0, 2).toUpperCase();
  const accent = creator?.accent || "#75e6d8";
  const videoCount = creator?.videoCount ?? creatorVideos.length;
  const loadedCount = creatorVideos.length;
  const videoCountLabel = videoCount > loadedCount
    ? `${loadedCount.toLocaleString()} of ${videoCount.toLocaleString()} saved videos loaded`
    : `${videoCount.toLocaleString()} saved ${videoCount === 1 ? "video" : "videos"}`;
  const terminalVideoLabel = videoCount > loadedCount
    ? `No more videos are available to load. Showing ${loadedCount.toLocaleString()} of ${videoCount.toLocaleString()} saved videos.`
    : loadedCount === 1
      ? "The saved video is loaded"
      : `All ${loadedCount.toLocaleString()} saved videos are loaded`;
  const feedHref = `/?creator=${encodeURIComponent(resolvedCreatorId)}${returnVideoId ? `&video=${encodeURIComponent(returnVideoId)}` : ""}`;
  const loading = archive.source === "loading" || archive.source === "refreshing";

  return (
    <main className={styles.page}>
      <header className={styles.topBar}>
        <Link className={styles.iconButton} href={creator ? feedHref : "/"} aria-label="Back to feed">
          <ArrowLeft aria-hidden="true" size={20} />
        </Link>
        <strong>{creator ? `@${username}` : "Creator videos"}</strong>
        <Link className={styles.iconButton} href="/dashboard/videos" aria-label="Open video library">
          <Library aria-hidden="true" size={19} />
        </Link>
      </header>

      {!creator ? (
        <section className={styles.galleryState}>
          <h1>
            {!creatorId
              ? "Choose a creator from the feed"
              : loading ? "Loading creator…" : archive.error ? "Could not load this creator" : "Creator not found"}
          </h1>
          <p>{archive.error || "Return to the feed and choose a creator username."}</p>
          <div>
            {archive.error ? <button type="button" onClick={archive.refresh}>Retry</button> : null}
            <Link href="/">All creators</Link>
          </div>
        </section>
      ) : <>
      <section className={styles.profile} aria-labelledby="creator-name">
        <div className={styles.avatar} style={{ background: accent }} aria-hidden="true">
          {initials}
        </div>
        <div className={styles.profileIdentity}>
          <h1 id="creator-name">{displayName}</h1>
          <p>@{username}</p>
          <span>{videoCountLabel}</span>
        </div>
        {videoCount > 0 ? (
          <Link className={styles.feedButton} href={feedHref}>
            <Play aria-hidden="true" size={16} fill="currentColor" /> Open feed
          </Link>
        ) : null}
      </section>

      <h2 className={styles.gridLabel} id="creator-videos-title">
        <Grid3X3 aria-hidden="true" size={16} /> Videos
      </h2>

      {archive.error ? (
        <div className={styles.galleryError} role="alert">
          <span>{archive.error}</span>
          <button type="button" onClick={archive.refresh}>Retry</button>
        </div>
      ) : null}

      {creatorVideos.length ? (
        <section
          id="creator-video-grid"
          className={styles.videoGrid}
          aria-labelledby="creator-videos-title"
          aria-busy={archive.loadingMoreVideos}
        >
          {creatorVideos.map((video, index) => (
            <Link
              className={styles.videoTile}
              href={`/?creator=${encodeURIComponent(resolvedCreatorId)}&video=${encodeURIComponent(video.id)}`}
              aria-label={`Play ${video.title} by @${video.username}`}
              prefetch={false}
              key={video.id}
            >
              {video.thumbnailUrl && !failedThumbnails.has(video.id) ? (
                // Archive thumbnails are generated dynamically by the private media bridge.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={video.thumbnailUrl}
                  alt=""
                  loading={index < 6 ? "eager" : "lazy"}
                  decoding="async"
                  onError={() => setFailedThumbnails((current) => new Set(current).add(video.id))}
                />
              ) : (
                <span className={styles.videoPlaceholder} style={{ background: video.accent }}>
                  <Play aria-hidden="true" size={25} fill="currentColor" />
                </span>
              )}
              {video.duration !== "--:--" ? (
                <span className={styles.duration} aria-hidden="true">{video.duration}</span>
              ) : null}
            </Link>
          ))}
        </section>
      ) : (
        <div
          id="creator-video-grid"
          className={styles.emptyState}
          role={loading || !archive.error ? "status" : undefined}
        >
          {loading
            ? "Loading videos…"
            : archive.error ? "Could not load this creator’s videos." : "No saved videos for this creator."}
        </div>
      )}
      <div className={styles.pagination}>
        {archive.error ? (
          <p>Loading stopped. Retry above to refresh this creator.</p>
        ) : archive.hasMoreVideos ? (
          <button
            className={styles.loadMoreButton}
            type="button"
            aria-controls="creator-video-grid"
            aria-busy={archive.loadingMoreVideos}
            disabled={archive.loadingMoreVideos}
            onClick={() => void archive.loadMoreVideos()}
          >
            {archive.loadingMoreVideos ? (
              <LoaderCircle className={styles.spinning} size={16} aria-hidden="true" />
            ) : null}
            {archive.loadingMoreVideos ? "Loading more videos…" : "Load more videos"}
          </button>
        ) : creatorVideos.length ? (
          <p role="status">{terminalVideoLabel}</p>
        ) : null}
      </div>
      </>}
    </main>
  );
}

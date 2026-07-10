"use client";

import { ArrowLeft, Grid3X3, Library, Play } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
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
  const creatorId = searchParams.get("creator") || creators[0]?.id || "";
  const archive = useArchiveData({
    fallbackCreators: creators,
    fallbackVideos: videos,
    fallbackStats: mockStats,
    videoCreatorId: creatorId,
  });
  const creator = archive.creators.find((item) => item.id === creatorId);
  const creatorVideos = useMemo(
    () => archive.videos.filter((video) => video.creatorId === creatorId),
    [archive.videos, creatorId],
  );
  const username = creator?.username || creatorId || "creator";
  const displayName = creator?.displayName || username;
  const initials = creator?.initials || username.slice(0, 2).toUpperCase();
  const accent = creator?.accent || "#75e6d8";
  const videoCount = creator?.videoCount ?? creatorVideos.length;
  const feedHref = `/?creator=${encodeURIComponent(creatorId)}`;

  return (
    <main className={styles.page}>
      <header className={styles.topBar}>
        <Link className={styles.iconButton} href={feedHref} aria-label="Back to creator feed">
          <ArrowLeft size={20} />
        </Link>
        <strong>@{username}</strong>
        <Link className={styles.iconButton} href="/dashboard/videos" aria-label="Open video library">
          <Library size={19} />
        </Link>
      </header>

      <section className={styles.profile} aria-labelledby="creator-name">
        <div className={styles.avatar} style={{ background: accent }} aria-hidden="true">
          {initials}
        </div>
        <div className={styles.profileIdentity}>
          <h1 id="creator-name">{displayName}</h1>
          <p>@{username}</p>
          <span>{videoCount.toLocaleString()} saved {videoCount === 1 ? "video" : "videos"}</span>
        </div>
        <Link className={styles.feedButton} href={feedHref}>
          <Play size={16} fill="currentColor" /> Open feed
        </Link>
      </section>

      <div className={styles.gridLabel}>
        <Grid3X3 size={16} /> Videos
      </div>

      {creatorVideos.length ? (
        <section className={styles.videoGrid} aria-label={`Saved videos by @${username}`}>
          {creatorVideos.map((video, index) => (
            <Link
              className={styles.videoTile}
              href={`/?creator=${encodeURIComponent(creatorId)}&video=${encodeURIComponent(video.id)}`}
              aria-label={`Play ${video.title} by @${video.username}`}
              prefetch={false}
              key={video.id}
            >
              {video.thumbnailUrl ? (
                // Archive thumbnails are generated dynamically by the private media bridge.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={video.thumbnailUrl}
                  alt=""
                  loading={index < 12 ? "eager" : "lazy"}
                />
              ) : (
                <span className={styles.videoPlaceholder} style={{ background: video.accent }}>
                  <Play size={25} fill="currentColor" />
                </span>
              )}
              <span className="sr-only">{video.title}</span>
              {video.duration !== "--:--" ? (
                <span className={styles.duration}>{video.duration}</span>
              ) : null}
            </Link>
          ))}
        </section>
      ) : (
        <div className={styles.emptyState}>
          {archive.source === "loading" ? "Loading videos…" : "No saved videos for this creator."}
        </div>
      )}
    </main>
  );
}

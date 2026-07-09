"use client";

import { ArrowUpRight, CircleAlert, Play } from "lucide-react";
import Link from "next/link";
import type { ArchiveStats, Creator, SavedVideo } from "../../lib/types";
import { useArchiveData } from "../../lib/useArchiveData";
import styles from "./dashboard.module.css";

export function DashboardOverview({
  fallbackCreators,
  fallbackVideos,
  fallbackStats,
}: {
  fallbackCreators: Creator[];
  fallbackVideos: SavedVideo[];
  fallbackStats: ArchiveStats;
}) {
  const archive = useArchiveData({ fallbackCreators, fallbackVideos, fallbackStats });
  const { creators, videos, stats } = archive;
  const activeCreators = creators.filter((creator) => creator.enabled).length;
  const needsAttention = creators.filter((creator) => creator.status === "attention").length;
  const today = new Date().toDateString();
  const downloadsToday = videos.filter((video) => new Date(video.savedAt).toDateString() === today).length;

  return (
    <div className={styles.pageWrap}>
      <div className={styles.pageHeader}>
        <div><h1>Dashboard</h1></div>
        <Link className={styles.primaryButton} href="/">
          Open feed <ArrowUpRight size={16} />
        </Link>
      </div>

      <section className={styles.metricGrid} aria-label="Archive metrics">
        <Metric label="Videos" value={String(stats.videoCount)} />
        <Metric label="Creators" value={String(stats.creatorCount)} />
        <Metric label="Storage" value={stats.storageUsed} />
        <Metric label="Added today" value={String(downloadsToday)} />
      </section>

      <section className={styles.overviewGrid}>
        <div className={styles.contentCard}>
          <div className={styles.cardHeading}>
            <h2>Recent files</h2>
            <Link href="/dashboard/videos">All videos <ArrowUpRight size={14} /></Link>
          </div>
          <div className={styles.recentList}>
            {videos.slice(0, 5).map((video) => (
              <div className={styles.recentRow} key={video.id}>
                <div className={styles.videoThumb} style={{ "--thumb": video.accent } as React.CSSProperties}>
                  {video.thumbnailUrl ? (
                    // Live preview thumbnails come from a configurable local bridge URL.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={video.thumbnailUrl} alt="" loading="lazy" />
                  ) : null}
                  <Play size={15} fill="currentColor" />
                </div>
                <div className={styles.recentTitle}>
                  <strong>{video.title}</strong>
                  <span>@{video.username}</span>
                </div>
                <span className={styles.recentTime}>{video.savedAtLabel}</span>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.sideStack}>
          <div className={styles.contentCard}>
            <div className={styles.cardHeading}><h2>Storage</h2></div>
            <div className={styles.storageValue}>
              <strong>{stats.storageUsed}</strong>
              <span>of 10 GB</span>
            </div>
            <div className={styles.storageBar}>
              <span style={{ width: `${stats.storagePercent}%` }} />
            </div>
          </div>

          <div className={styles.contentCard}>
            <div className={styles.cardHeading}><h2>Monitor</h2></div>
            <dl className={styles.utilityList}>
              <div><dt>Enabled</dt><dd>{activeCreators}</dd></div>
              <div><dt>Needs attention</dt><dd>{needsAttention}</dd></div>
            </dl>
          </div>
        </div>
      </section>

      <section className={styles.contentCard}>
        <div className={styles.cardHeading}>
          <h2>Creators</h2>
          <Link href="/dashboard/creators">Manage <ArrowUpRight size={14} /></Link>
        </div>
        <div className={styles.creatorHealthGrid}>
          {creators.slice(0, 4).map((creator) => (
            <div className={styles.healthCard} key={creator.id}>
              <span className={styles.creatorAvatar} style={{ "--avatar": creator.accent } as React.CSSProperties}>
                {creator.initials}
              </span>
              <div>
                <strong>@{creator.username}</strong>
                <small>{creator.videoCount} videos · {creator.lastSynced}</small>
              </div>
              {creator.status === "attention" ? (
                <CircleAlert className={styles.warningIcon} size={16} />
              ) : null}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <article className={styles.metricCard}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

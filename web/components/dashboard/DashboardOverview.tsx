"use client";

import {
  ArrowUpRight,
  Check,
  CircleAlert,
  Clock3,
  Database,
  Download,
  HardDrive,
  Play,
  RefreshCw,
  Users,
} from "lucide-react";
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
  const cards = [
    {
      label: "Saved videos",
      value: String(stats.videoCount),
      note: `+${stats.newThisWeek} this week`,
      icon: Play,
      tone: "acid",
    },
    {
      label: "Creators",
      value: String(stats.creatorCount),
      note: `${activeCreators} actively monitored`,
      icon: Users,
      tone: "cyan",
    },
    {
      label: "Storage used",
      value: stats.storageUsed,
      note: `${stats.storagePercent}% of 10 GB`,
      icon: HardDrive,
      tone: "coral",
    },
    {
      label: "Downloads today",
      value: String(downloadsToday),
      note: archive.source === "live" ? "From the live archive" : "Preview data",
      icon: Download,
      tone: "violet",
    },
  ];

  return (
    <div className={styles.pageWrap}>
      <div className={styles.pageHeader}>
        <div>
          <span className={styles.pageEyebrow}>
            {archive.source === "live" ? "Live · yufeihl" : "Archive preview"}
          </span>
          <h1>Archive overview</h1>
          <p>Everything saved, monitored, and ready to watch.</p>
        </div>
        <Link className={styles.primaryButton} href="/">
          Open feed <ArrowUpRight size={17} />
        </Link>
      </div>

      <section className={styles.metricGrid} aria-label="Archive metrics">
        {cards.map(({ label, value, note, icon: Icon, tone }) => (
          <article className={styles.metricCard} key={label}>
            <div className={`${styles.metricIcon} ${styles[tone]}`}>
              <Icon size={19} />
            </div>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{note}</small>
          </article>
        ))}
      </section>

      <section className={styles.overviewGrid}>
        <div className={styles.contentCard}>
          <div className={styles.cardHeading}>
            <div>
              <span className={styles.sectionEyebrow}>Fresh from the queue</span>
              <h2>Recently saved</h2>
            </div>
            <Link href="/dashboard/videos">View all <ArrowUpRight size={14} /></Link>
          </div>

          <div className={styles.recentList}>
            {videos.slice(0, 4).map((video) => (
              <div className={styles.recentRow} key={video.id}>
                <div
                  className={styles.videoThumb}
                  style={{ "--thumb": video.accent } as React.CSSProperties}
                >
                  <Play size={17} fill="currentColor" />
                </div>
                <div className={styles.recentTitle}>
                  <strong>{video.title}</strong>
                  <span>@{video.username} · {video.duration}</span>
                </div>
                <span className={styles.recentTime}>{video.savedAtLabel}</span>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.sideStack}>
          <div className={styles.contentCard}>
            <div className={styles.cardHeading}>
              <div>
                <span className={styles.sectionEyebrow}>Capacity</span>
                <h2>Storage</h2>
              </div>
              <Database size={19} />
            </div>
            <div className={styles.storageValue}>
              <strong>{stats.storageUsed}</strong>
              <span>of 10 GB</span>
            </div>
            <div className={styles.storageBar}>
              <span style={{ width: `${stats.storagePercent}%` }} />
            </div>
            <div className={styles.storageLegend}>
              <span><i className={styles.videoKey} /> Saved MP4 media</span>
              <span><i className={styles.otherKey} /> Sidecars managed on server</span>
            </div>
          </div>

          <div className={`${styles.contentCard} ${styles.systemCard}`}>
            <div className={styles.systemTop}>
              <span className={styles.systemIcon}>
                {needsAttention ? <CircleAlert size={16} /> : <Check size={16} />}
              </span>
              <div>
                <strong>{needsAttention ? `${needsAttention} creator${needsAttention === 1 ? "" : "s"} need attention` : "All creators healthy"}</strong>
                <small>{archive.source === "live" ? "Connected to the live monitor database." : "Using safe frontend preview data."}</small>
              </div>
            </div>
            <div className={styles.systemStats}>
              <span><RefreshCw size={14} /> {activeCreators} monitors enabled</span>
              <span><Clock3 size={14} /> Refreshed on page load</span>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.contentCard}>
        <div className={styles.cardHeading}>
          <div>
            <span className={styles.sectionEyebrow}>Monitoring</span>
            <h2>Creator health</h2>
          </div>
          <Link href="/dashboard/creators">Manage creators <ArrowUpRight size={14} /></Link>
        </div>
        <div className={styles.creatorHealthGrid}>
          {creators.slice(0, 4).map((creator) => (
            <div className={styles.healthCard} key={creator.id}>
              <span
                className={styles.creatorAvatar}
                style={{ "--avatar": creator.accent } as React.CSSProperties}
              >
                {creator.initials}
              </span>
              <div>
                <strong>@{creator.username}</strong>
                <small>{creator.videoCount} videos · {creator.lastSynced}</small>
              </div>
              {creator.status === "attention" ? (
                <CircleAlert className={styles.warningIcon} size={17} />
              ) : (
                <span className={styles.healthyDot} />
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

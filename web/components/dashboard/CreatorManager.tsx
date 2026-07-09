"use client";

import {
  CircleAlert,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { mockStats, mockVideos } from "../../lib/mock-data";
import type { Creator } from "../../lib/types";
import { useArchiveData } from "../../lib/useArchiveData";
import styles from "./dashboard.module.css";

export function CreatorManager({ creators }: { creators: Creator[] }) {
  const archive = useArchiveData({
    fallbackCreators: creators,
    fallbackVideos: mockVideos,
    fallbackStats: mockStats,
  });
  const liveCreators = archive.creators;
  const [query, setQuery] = useState("");
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(creators.map((creator) => [creator.id, creator.enabled])),
  );

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return liveCreators.filter(
      (creator) =>
        !normalized ||
        creator.username.toLowerCase().includes(normalized) ||
        creator.displayName.toLowerCase().includes(normalized),
    );
  }, [liveCreators, query]);

  useEffect(() => {
    setEnabled((current) => ({
      ...Object.fromEntries(liveCreators.map((creator) => [creator.id, creator.enabled])),
      ...current,
    }));
  }, [liveCreators]);

  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <span className={styles.pageEyebrow}>
            {archive.source === "live" ? "Live monitoring" : "Monitoring"}
          </span>
          <h1>Creators</h1>
          <p>Choose who to monitor and review each creator’s archive health.</p>
        </div>
        <button className={styles.primaryButton} type="button">
          <Plus size={17} /> Add creator
        </button>
      </div>

      <div className={styles.filterBar}>
        <label className={styles.searchField}>
          <Search size={17} />
          <span className="sr-only">Search creators</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search creators"
          />
        </label>
        <span className={styles.resultCount}>{filtered.length} creators</span>
      </div>

      <section className={styles.creatorGrid}>
        {filtered.map((creator) => (
          <article className={styles.creatorCard} key={creator.id}>
            <div className={styles.creatorCardTop}>
              <span
                className={styles.creatorLargeAvatar}
                style={{ "--avatar": creator.accent } as React.CSSProperties}
              >
                {creator.initials}
              </span>
              <button type="button" aria-label={`More actions for ${creator.username}`}>
                <MoreHorizontal size={20} />
              </button>
            </div>
            <h2>{creator.displayName}</h2>
            <p>@{creator.username}</p>
            <div className={styles.creatorStats}>
              <div><strong>{creator.videoCount}</strong><span>Videos</span></div>
              <div><strong>{creator.storageLabel}</strong><span>Storage</span></div>
            </div>
            <div className={styles.creatorSync}>
              {creator.status === "attention" ? (
                <CircleAlert size={15} className={styles.warningIcon} />
              ) : (
                <RefreshCw size={14} />
              )}
              <span>
                {creator.status === "attention" ? "Needs attention" : `Synced ${creator.lastSynced}`}
              </span>
            </div>
            <div className={styles.creatorCardFooter}>
              <span>Monitoring</span>
              <button
                className={`${styles.switch} ${enabled[creator.id] ? styles.switchOn : ""}`}
                onClick={() =>
                  setEnabled((current) => ({
                    ...current,
                    [creator.id]: !current[creator.id],
                  }))
                }
                type="button"
                role="switch"
                aria-checked={enabled[creator.id]}
                aria-label={`${enabled[creator.id] ? "Disable" : "Enable"} monitoring for ${creator.username}`}
              >
                <span />
              </button>
            </div>
          </article>
        ))}
      </section>
    </>
  );
}

"use client";

import {
  CheckCircle2,
  Download,
  ExternalLink,
  MoreHorizontal,
  Play,
  Search,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { CreatorPicker } from "../CreatorPicker";
import { mockStats } from "../../lib/mock-data";
import type { Creator, SavedVideo } from "../../lib/types";
import { useArchiveData } from "../../lib/useArchiveData";
import styles from "./dashboard.module.css";

export function VideoLibrary({
  creators,
  videos,
}: {
  creators: Creator[];
  videos: SavedVideo[];
}) {
  const archive = useArchiveData({
    fallbackCreators: creators,
    fallbackVideos: videos,
    fallbackStats: mockStats,
  });
  const liveCreators = archive.creators;
  const liveVideos = archive.videos;
  const [query, setQuery] = useState("");
  const [creatorId, setCreatorId] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return liveVideos.filter((video) => {
      const matchesCreator = creatorId === "all" || video.creatorId === creatorId;
      const matchesQuery =
        !normalized ||
        video.title.toLowerCase().includes(normalized) ||
        video.username.toLowerCase().includes(normalized);
      return matchesCreator && matchesQuery;
    });
  }, [creatorId, liveVideos, query]);

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <h1>Videos</h1>
        </div>
        <button className={styles.primaryButton} type="button">
          <Download size={17} /> Export selected
        </button>
      </div>

      <div className={styles.filterBar}>
        <label className={styles.searchField}>
          <Search size={17} />
          <span className="sr-only">Search videos</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search title or creator"
          />
        </label>
        <CreatorPicker creators={liveCreators} value={creatorId} onChange={setCreatorId} />
        <span className={styles.resultCount}>{filtered.length} results</span>
      </div>

      {selected.size > 0 ? (
        <div className={styles.selectionBar}>
          <span><CheckCircle2 size={16} /> {selected.size} selected</span>
          <div>
            <button type="button"><Download size={15} /> Download</button>
            <button className={styles.dangerText} type="button"><Trash2 size={15} /> Delete</button>
          </div>
        </div>
      ) : null}

      <section className={styles.libraryCard}>
        <div className={styles.tableHeader}>
          <span />
          <span>Video</span>
          <span>Creator</span>
          <span>Saved</span>
          <span>Size</span>
          <span />
        </div>
        {filtered.map((video) => (
          <article className={styles.videoRow} key={video.id}>
            <Link
              className={styles.videoRowLink}
              href={`/?video=${encodeURIComponent(video.id)}`}
              aria-label={`Play ${video.title}`}
            />
            <label className={styles.checkboxWrap}>
              <input
                type="checkbox"
                checked={selected.has(video.id)}
                onChange={() => toggleSelected(video.id)}
              />
              <span />
              <b className="sr-only">Select {video.title}</b>
            </label>
            <div className={styles.videoIdentity}>
              <div
                className={styles.libraryThumb}
                style={{ "--thumb": video.accent } as React.CSSProperties}
              >
                {video.thumbnailUrl ? (
                  // Live preview thumbnails come from a configurable local bridge URL.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={video.thumbnailUrl} alt="" loading="lazy" />
                ) : null}
                <span className={styles.thumbPlay}><Play size={14} fill="currentColor" /></span>
                <small>{video.duration}</small>
              </div>
              <div>
                <strong>{video.title}</strong>
                <small>{video.mediaType} · {video.id}</small>
              </div>
            </div>
            <span className={styles.tableCreator}>@{video.username}</span>
            <span className={styles.tableMuted}>{video.savedAtLabel}</span>
            <span className={styles.tableMuted}>{video.sizeLabel}</span>
            <div className={styles.rowActions}>
              <a href={video.sourceUrl} target="_blank" rel="noreferrer" aria-label="Open original">
                <ExternalLink size={16} />
              </a>
              <button type="button" aria-label="More video actions"><MoreHorizontal size={18} /></button>
            </div>
          </article>
        ))}
        {filtered.length === 0 ? (
          <div className={styles.tableEmpty}>
            <Search size={25} />
            <strong>No matching videos</strong>
            <span>Try a different creator or search term.</span>
          </div>
        ) : null}
      </section>
    </>
  );
}

"use client";

import {
  Download,
  ExternalLink,
  LoaderCircle,
  MoreHorizontal,
  Play,
  Search,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CreatorPicker } from "../CreatorPicker";
import { resolveCreatorId } from "../../lib/creator-id";
import { mockStats } from "../../lib/mock-data";
import type { Creator, SavedVideo } from "../../lib/types";
import { useArchiveData } from "../../lib/useArchiveData";
import { useModalDialog } from "../../lib/useModalDialog";
import styles from "./dashboard.module.css";

export function VideoLibrary({
  creators,
  videos,
}: {
  creators: Creator[];
  videos: SavedVideo[];
}) {
  const searchParams = useSearchParams();
  const requestedCreatorId = searchParams.get("creator") || "all";
  const requestedUsername = searchParams.get("username") || "";
  const [creatorFilter, setCreatorFilter] = useState({
    id: requestedCreatorId,
    username: requestedCreatorId === "all" ? "" : requestedUsername,
  });
  const archive = useArchiveData({
    fallbackCreators: creators,
    fallbackVideos: videos,
    fallbackStats: mockStats,
    videoCreatorId: creatorFilter.id === "all" ? "" : creatorFilter.id,
    videoUsername: creatorFilter.username,
    videoLimit: 5_000,
    includeStats: false,
  });
  const liveCreators = archive.creators;
  const resolvedCreatorFilter = useMemo(
    () => resolveCreatorId(creatorFilter.id, liveCreators),
    [creatorFilter.id, liveCreators],
  );
  const [query, setQuery] = useState("");
  const [actionVideoId, setActionVideoId] = useState("");
  const [deleteVideo, setDeleteVideo] = useState<SavedVideo | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const [removedVideoIds, setRemovedVideoIds] = useState<Set<string>>(() => new Set());
  const liveVideos = useMemo(
    () => archive.videos.filter((video) => !removedVideoIds.has(video.id)),
    [archive.videos, removedVideoIds],
  );
  const { dialogRef, returnFocusRef } = useModalDialog(Boolean(deleteVideo), closeDeleteVideo);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Element && !target.closest("[data-video-actions]")) {
        setActionVideoId("");
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const trigger = actionVideoId
        ? document.getElementById(`video-actions-${actionVideoId}`)
        : null;
      setActionVideoId("");
      if (trigger) window.requestAnimationFrame(() => trigger.focus());
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [actionVideoId]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return liveVideos.filter((video) => {
      const matchesCreator = resolvedCreatorFilter === "all" || video.creatorId === resolvedCreatorFilter;
      const matchesQuery =
        !normalized ||
        video.title.toLowerCase().includes(normalized) ||
        video.username.toLowerCase().includes(normalized) ||
        video.description.toLowerCase().includes(normalized) ||
        video.tags.some((tag) => tag.toLowerCase().includes(normalized));
      return matchesCreator && matchesQuery;
    });
  }, [liveVideos, query, resolvedCreatorFilter]);

  function selectCreator(id: string) {
    setCreatorFilter({
      id,
      username: id === "all" ? "" : liveCreators.find((creator) => creator.id === id)?.username || "",
    });
  }

  function openDeleteVideo(video: SavedVideo) {
    returnFocusRef.current = document.getElementById(`video-actions-${video.id}`);
    setActionVideoId("");
    setDeleteVideo(video);
    setDeleteError("");
  }

  function closeDeleteVideo() {
    if (deleting) return;
    setDeleteVideo(null);
    setDeleteError("");
  }

  async function confirmDeleteVideo() {
    if (!deleteVideo || deleting) return;
    const apiBase = process.env.NEXT_PUBLIC_ARCHIVE_API_BASE?.replace(/\/+$/, "") || "";
    if (!apiBase) {
      setDeleteError("The live backend connection is required to delete videos.");
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
      const payload = await response.json() as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || `Deletion failed (${response.status})`);
      }

      setRemovedVideoIds((current) => new Set(current).add(deleteVideo.id));
      setActionMessage(`Deleted “${deleteVideo.title}” from @${deleteVideo.username}.`);
      const deletedIndex = filtered.findIndex((video) => video.id === deleteVideo.id);
      const nextVideo = filtered[deletedIndex + 1] || filtered[deletedIndex - 1];
      returnFocusRef.current = nextVideo
        ? document.getElementById(`video-actions-${nextVideo.id}`)
        : document.getElementById("video-library-feed-link");
      closeDeleteVideo();
      archive.refresh();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <h1>Videos</h1>
        </div>
        <Link className={styles.primaryButton} href="/" id="video-library-feed-link">
          <Play size={16} fill="currentColor" /> Open feed
        </Link>
      </div>

      <div className={styles.filterBar}>
        <label className={styles.searchField}>
          <Search size={17} />
          <span className="sr-only">Search videos</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search videos"
          />
        </label>
        <CreatorPicker creators={liveCreators} value={resolvedCreatorFilter} onChange={selectCreator} />
        <span className={styles.resultCount}>{filtered.length} results</span>
      </div>

      {actionMessage ? <p className={styles.actionMessage} role="status">{actionMessage}</p> : null}
      {archive.error ? (
        <div className={styles.errorNotice} role="alert">
          <span>{archive.error}</span>
          <button type="button" onClick={archive.refresh}>Retry</button>
        </div>
      ) : null}

      <section className={styles.libraryCard}>
        <div className={styles.tableHeader}>
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
              href={`/?creator=${encodeURIComponent(video.creatorId)}&video=${encodeURIComponent(video.id)}`}
              aria-label={`Play ${video.title}`}
            />
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
                <small>@{video.username} · saved {video.savedAtLabel} · {video.sizeLabel}</small>
              </div>
            </div>
            <span className={styles.tableCreator}>@{video.username}</span>
            <span className={styles.tableMuted}>{video.savedAtLabel}</span>
            <span className={styles.tableMuted}>{video.sizeLabel}</span>
            <div className={styles.rowActions}>
              <a href={video.sourceUrl} target="_blank" rel="noreferrer" aria-label="Open original">
                <ExternalLink size={16} />
              </a>
              <div className={styles.videoActions} data-video-actions>
                <button
                  id={`video-actions-${video.id}`}
                  type="button"
                  aria-label={`More actions for ${video.title} by @${video.username}, video ${video.id}`}
                  aria-controls={`video-menu-${video.id}`}
                  aria-expanded={actionVideoId === video.id}
                  onClick={() => setActionVideoId((current) => current === video.id ? "" : video.id)}
                >
                  <MoreHorizontal size={18} />
                </button>
                {actionVideoId === video.id ? (
                  <div className={styles.videoActionMenu} id={`video-menu-${video.id}`}>
                    <a
                      href={`${video.videoUrl}${video.videoUrl.includes("?") ? "&" : "?"}download=1`}
                      download
                    >
                      <Download size={15} />
                      Download video
                    </a>
                    <button type="button" onClick={() => openDeleteVideo(video)}>
                      <Trash2 size={15} />
                      Delete video
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </article>
        ))}
        {filtered.length === 0 ? (
          <div className={styles.tableEmpty}>
            <Search size={25} />
            <strong>
              {archive.source === "loading" || archive.source === "refreshing"
                ? "Loading videos…"
                : archive.source === "error" ? "Could not load videos" : "No matching videos"}
            </strong>
            <span>
              {archive.source === "error" ? "Retry the live archive connection." : "Try a different creator or search term."}
            </span>
          </div>
        ) : null}
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
            aria-labelledby="delete-video-title"
          >
            <div className={styles.confirmIcon}><Trash2 size={19} /></div>
            <div>
              <h2 id="delete-video-title">Delete this video?</h2>
              <p>
                <strong className={styles.confirmVideoTitle}>{deleteVideo.title}</strong>
                <span className={styles.confirmVideoMeta}>@{deleteVideo.username} · saved {deleteVideo.savedAtLabel}</span>
                This permanently removes the archived video and its saved metadata.
              </p>
            </div>
            {deleteError ? <p className={styles.importError} role="alert">{deleteError}</p> : null}
            <div className={styles.confirmActions}>
              <button data-dialog-initial type="button" onClick={closeDeleteVideo} disabled={deleting}>Cancel</button>
              <button
                className={styles.confirmDeleteButton}
                type="button"
                disabled={deleting}
                onClick={() => void confirmDeleteVideo()}
              >
                {deleting ? <LoaderCircle className={styles.spinning} size={15} /> : <Trash2 size={15} />}
                {deleting ? "Deleting" : "Delete video"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

"use client";

import { ExternalLink, LoaderCircle, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { TrashedVideo } from "../../lib/types";
import { useModalDialog } from "../../lib/useModalDialog";
import styles from "./dashboard.module.css";

export function TrashLibrary({
  apiBase,
  onRestored,
}: {
  apiBase: string;
  onRestored: (video: TrashedVideo) => void;
}) {
  const [videos, setVideos] = useState<TrashedVideo[]>([]);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [restoreVideo, setRestoreVideo] = useState<TrashedVideo | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState("");
  const { dialogRef, returnFocusRef } = useModalDialog(Boolean(restoreVideo), closeRestore);

  const loadTrash = useCallback(async () => {
    if (!apiBase) {
      setVideos([]);
      setRetentionDays(null);
      setLoading(false);
      setError("The live backend connection is required to view trash.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${apiBase}/api/trash?limit=1000`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as {
        videos?: TrashedVideo[];
        retentionDays?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || `Trash request failed (${response.status})`);
      setVideos(Array.isArray(payload.videos) ? payload.videos : []);
      setRetentionDays(
        typeof payload.retentionDays === "number" && Number.isFinite(payload.retentionDays)
          ? payload.retentionDays
          : null,
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    // Fetching begins when the panel is mounted; event-triggered refreshes reuse the same boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadTrash();
  }, [loadTrash]);

  function openRestore(video: TrashedVideo) {
    returnFocusRef.current = document.getElementById(`restore-video-${video.fileId}`);
    setRestoreVideo(video);
    setRestoreError("");
  }

  function closeRestore() {
    if (restoring) return;
    setRestoreVideo(null);
    setRestoreError("");
  }

  async function confirmRestore() {
    if (!restoreVideo || restoring || !apiBase) return;
    setRestoring(true);
    setRestoreError("");
    try {
      const response = await fetch(`${apiBase}/api/videos/${restoreVideo.fileId}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmFileId: restoreVideo.fileId }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || `Restore failed (${response.status})`);
      const restored = restoreVideo;
      setVideos((current) => current.filter((video) => video.fileId !== restored.fileId));
      returnFocusRef.current = document.getElementById("video-library-active-tab");
      setRestoreVideo(null);
      onRestored(restored);
    } catch (nextError) {
      setRestoreError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setRestoring(false);
    }
  }

  return (
    <>
      <section className={styles.trashCard} id="video-library-trash-panel" role="tabpanel" aria-labelledby="video-library-trash-tab">
        <header className={styles.trashToolbar}>
          <div>
            <strong>{loading ? "Loading trash…" : `${videos.length} ${videos.length === 1 ? "file" : "files"}`}</strong>
            <span>{retentionLabel(retentionDays)}</span>
          </div>
          <button type="button" onClick={() => void loadTrash()} disabled={loading}>
            <RefreshCw className={loading ? styles.spinning : undefined} size={15} /> Refresh
          </button>
        </header>

        {error ? (
          <div className={styles.errorNotice} role="alert">
            <span>{error}</span>
            {apiBase ? <button type="button" onClick={() => void loadTrash()}>Retry</button> : null}
          </div>
        ) : null}

        {!error && videos.length ? (
          <div className={styles.trashList}>
            <div className={styles.trashHeader} aria-hidden="true">
              <span>File</span><span>Creator</span><span>Moved</span><span>Purges</span><span />
            </div>
            {videos.map((video) => (
              <article className={styles.trashRow} key={video.fileId}>
                <div className={styles.trashFile}>
                  <Trash2 size={16} />
                  <div>
                    <strong>{video.filename || `Video ${video.videoId || video.fileId}`}</strong>
                    <small>{formatBytes(video.sizeBytes)} · saved {formatDate(video.createdAt)} · file {video.fileId}</small>
                  </div>
                </div>
                <span className={styles.trashCreator} data-label="Creator">@{video.username || "unknown"}</span>
                <time data-label="Moved" dateTime={toDateTime(video.trashedAt)}>{formatDate(video.trashedAt)}</time>
                <span className={styles.trashPurge} data-label="Purges" title={video.purgeAt ? formatExactDate(video.purgeAt) : undefined}>
                  {formatPurgeTime(video.purgeAt)}
                </span>
                <div className={styles.trashActions}>
                  {video.sourceUrl ? (
                    <a href={video.sourceUrl} target="_blank" rel="noreferrer" aria-label={`Open original post by @${video.username}`}>
                      <ExternalLink size={15} />
                    </a>
                  ) : null}
                  <button
                    id={`restore-video-${video.fileId}`}
                    type="button"
                    onClick={() => openRestore(video)}
                  >
                    <RotateCcw size={15} /> Restore
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : null}

        {!error && !loading && videos.length === 0 ? (
          <div className={styles.tableEmpty}>
            <Trash2 size={24} />
            <strong>Trash is empty</strong>
            <span>Videos moved to trash will appear here until their purge date.</span>
          </div>
        ) : null}
      </section>

      {restoreVideo ? (
        <div
          className={styles.confirmScrim}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !restoring) closeRestore();
          }}
        >
          <section
            className={styles.confirmDialog}
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="restore-video-title"
          >
            <div className={styles.restoreIcon}><RotateCcw size={19} /></div>
            <div>
              <h2 id="restore-video-title">Restore this video?</h2>
              <p>
                <strong className={styles.confirmVideoTitle}>{restoreVideo.filename}</strong>
                <span className={styles.confirmVideoMeta}>@{restoreVideo.username} · moved {formatDate(restoreVideo.trashedAt)}</span>
                The file will return to the active archive and become playable again.
              </p>
            </div>
            {restoreError ? <p className={styles.importError} role="alert">{restoreError}</p> : null}
            <div className={styles.confirmActions}>
              <button data-dialog-initial type="button" onClick={closeRestore} disabled={restoring}>Cancel</button>
              <button type="button" disabled={restoring} onClick={() => void confirmRestore()}>
                {restoring ? <LoaderCircle className={styles.spinning} size={15} /> : <RotateCcw size={15} />}
                {restoring ? "Restoring" : "Restore video"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function retentionLabel(days: number | null) {
  if (days === null) return "Purge policy unavailable";
  if (days <= 0) return "Files stay here until manually purged";
  return `Files are permanently deleted after ${days} ${days === 1 ? "day" : "days"}`;
}

function formatPurgeTime(timestamp: number | null) {
  if (!timestamp) return "Manual";
  const remaining = timestamp - Date.now();
  if (remaining <= 0) return "Pending purge";
  const hours = Math.ceil(remaining / 3_600_000);
  if (hours < 24) return `In ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.ceil(hours / 24);
  return `In ${days} ${days === 1 ? "day" : "days"}`;
}

function formatDate(timestamp: number) {
  if (!timestamp) return "Unknown";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(timestamp);
}

function formatExactDate(timestamp: number) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

function toDateTime(timestamp: number) {
  return timestamp ? new Date(timestamp).toISOString() : undefined;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

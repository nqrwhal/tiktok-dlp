"use client";

import { ExternalLink, LoaderCircle, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { TrashedVideo } from "../../lib/types";
import { useModalDialog } from "../../lib/useModalDialog";
import styles from "./dashboard.module.css";

export function TrashLibrary({
  apiBase,
  onRestored,
  onDeleted,
  onDeletedAll,
}: {
  apiBase: string;
  onRestored: (video: TrashedVideo) => void;
  onDeleted: (video: TrashedVideo) => void;
  onDeletedAll: (count: number, failed: number) => void;
}) {
  const [videos, setVideos] = useState<TrashedVideo[]>([]);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [restoreVideo, setRestoreVideo] = useState<TrashedVideo | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState("");
  const [deleteVideo, setDeleteVideo] = useState<TrashedVideo | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);
  const [deleteAllError, setDeleteAllError] = useState("");
  const { dialogRef, returnFocusRef } = useModalDialog(Boolean(restoreVideo), closeRestore);
  const {
    dialogRef: deleteDialogRef,
    returnFocusRef: deleteReturnFocusRef,
  } = useModalDialog(Boolean(deleteVideo), closeDelete);
  const {
    dialogRef: deleteAllDialogRef,
    returnFocusRef: deleteAllReturnFocusRef,
  } = useModalDialog(deleteAllOpen, closeDeleteAll);

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
      const restoredIndex = videos.findIndex((video) => video.fileId === restored.fileId);
      const nextVideo = videos[restoredIndex + 1] || videos[restoredIndex - 1];
      returnFocusRef.current = nextVideo
        ? document.getElementById(`restore-video-${nextVideo.fileId}`)
        : document.getElementById("video-library-trash-tab");
      setVideos((current) => current.filter((video) => video.fileId !== restored.fileId));
      setRestoreVideo(null);
      onRestored(restored);
    } catch (nextError) {
      setRestoreError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setRestoring(false);
    }
  }

  function openDelete(video: TrashedVideo) {
    deleteReturnFocusRef.current = document.getElementById(`delete-trash-video-${video.fileId}`);
    setDeleteVideo(video);
    setDeleteError("");
  }

  function closeDelete() {
    if (deleting) return;
    setDeleteVideo(null);
    setDeleteError("");
  }

  async function confirmDelete() {
    if (!deleteVideo || deleting || !apiBase) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const response = await fetch(`${apiBase}/api/trash/${deleteVideo.fileId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmFileId: deleteVideo.fileId }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error || `Permanent deletion failed (${response.status})`);
      const deleted = deleteVideo;
      const deletedIndex = videos.findIndex((video) => video.fileId === deleted.fileId);
      const nextVideo = videos[deletedIndex + 1] || videos[deletedIndex - 1];
      deleteReturnFocusRef.current = nextVideo
        ? document.getElementById(`delete-trash-video-${nextVideo.fileId}`)
        : document.getElementById("video-library-trash-tab");
      setVideos((current) => current.filter((video) => video.fileId !== deleted.fileId));
      setDeleteVideo(null);
      onDeleted(deleted);
    } catch (nextError) {
      setDeleteError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setDeleting(false);
    }
  }

  function openDeleteAll() {
    deleteAllReturnFocusRef.current = document.getElementById("delete-all-trash");
    setDeleteAllOpen(true);
    setDeleteAllError("");
  }

  function closeDeleteAll() {
    if (deletingAll) return;
    setDeleteAllOpen(false);
    setDeleteAllError("");
  }

  async function confirmDeleteAll() {
    if (deletingAll || !apiBase) return;
    setDeletingAll(true);
    setDeleteAllError("");
    try {
      const response = await fetch(`${apiBase}/api/trash`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmDeleteAll: true }),
      });
      const payload = await response.json().catch(() => ({})) as {
        permanentlyDeletedVideos?: number;
        failedVideos?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || `Delete all failed (${response.status})`);
      const deleted = Number(payload.permanentlyDeletedVideos ?? 0);
      const failed = Number(payload.failedVideos ?? 0);
      setDeleteAllOpen(false);
      if (failed) await loadTrash();
      else setVideos([]);
      onDeletedAll(deleted, failed);
    } catch (nextError) {
      setDeleteAllError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setDeletingAll(false);
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
          <div className={styles.trashToolbarActions}>
            {videos.length ? (
              <button
                className={styles.permanentDeleteButton}
                id="delete-all-trash"
                type="button"
                onClick={openDeleteAll}
                disabled={loading}
              >
                <Trash2 size={15} /> Delete all
              </button>
            ) : null}
            <button type="button" onClick={() => void loadTrash()} disabled={loading}>
              <RefreshCw className={loading ? styles.spinning : undefined} size={15} /> Refresh
            </button>
          </div>
        </header>

        {error ? (
          <div className={styles.errorNotice} role="alert">
            <span>{error}</span>
            {apiBase ? <button type="button" onClick={() => void loadTrash()}>Retry</button> : null}
          </div>
        ) : null}

        {!error && videos.length ? (
          <div>
            <div className={styles.trashHeader} aria-hidden="true">
              <span>File</span>
              <span className={styles.trashMetadataHeader}>
                <span>Creator</span><span>Moved</span><span>Purges</span>
              </span>
              <span />
            </div>
            <div className={styles.trashList} role="list" aria-label="Trashed videos">
              {videos.map((video) => (
                <article className={styles.trashRow} role="listitem" key={video.fileId}>
                  <div className={styles.trashFile}>
                    <Trash2 size={16} aria-hidden="true" />
                    <div>
                      <strong>{video.filename || `Video ${video.videoId || video.fileId}`}</strong>
                      <small>{formatBytes(video.sizeBytes)} · saved {formatDate(video.createdAt)} · file {video.fileId}</small>
                    </div>
                  </div>
                  <dl className={styles.trashMetadata}>
                    <div>
                      <dt>Creator</dt>
                      <dd>@{video.username || "unknown"}</dd>
                    </div>
                    <div>
                      <dt>Moved</dt>
                      <dd><time dateTime={toDateTime(video.trashedAt)}>{formatDate(video.trashedAt)}</time></dd>
                    </div>
                    <div>
                      <dt>Purges</dt>
                      <dd className={styles.trashPurge} title={video.purgeAt ? formatExactDate(video.purgeAt) : undefined}>
                        {formatPurgeTime(video.purgeAt)}
                      </dd>
                    </div>
                  </dl>
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
                    <button
                      className={styles.permanentDeleteButton}
                      id={`delete-trash-video-${video.fileId}`}
                      type="button"
                      onClick={() => openDelete(video)}
                    >
                      <Trash2 size={15} /> Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
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

      {deleteVideo ? (
        <div
          className={styles.confirmScrim}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !deleting) closeDelete();
          }}
        >
          <section
            className={styles.confirmDialog}
            ref={deleteDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="permanent-delete-video-title"
          >
            <div className={styles.confirmIcon}><Trash2 size={19} /></div>
            <div>
              <h2 id="permanent-delete-video-title">Permanently delete this video?</h2>
              <p>
                <strong className={styles.confirmVideoTitle}>{deleteVideo.filename}</strong>
                <span className={styles.confirmVideoMeta}>@{deleteVideo.username} · {formatBytes(deleteVideo.sizeBytes)}</span>
                This removes the stored file and its archive record immediately. This action can’t be undone.
              </p>
            </div>
            {deleteError ? <p className={styles.importError} role="alert">{deleteError}</p> : null}
            <div className={styles.confirmActions}>
              <button data-dialog-initial type="button" onClick={closeDelete} disabled={deleting}>Cancel</button>
              <button
                className={styles.confirmDeleteButton}
                type="button"
                disabled={deleting}
                onClick={() => void confirmDelete()}
              >
                {deleting ? <LoaderCircle className={styles.spinning} size={15} /> : <Trash2 size={15} />}
                {deleting ? "Deleting" : "Delete permanently"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {deleteAllOpen ? (
        <div
          className={styles.confirmScrim}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !deletingAll) closeDeleteAll();
          }}
        >
          <section
            className={styles.confirmDialog}
            ref={deleteAllDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-all-trash-title"
          >
            <div className={styles.confirmIcon}><Trash2 size={19} /></div>
            <div>
              <h2 id="delete-all-trash-title">Permanently delete all trash?</h2>
              <p>
                This removes all {videos.length} trashed {videos.length === 1 ? "video" : "videos"} and their stored files immediately.
                {" "}This action can’t be undone.
              </p>
            </div>
            {deleteAllError ? <p className={styles.importError} role="alert">{deleteAllError}</p> : null}
            <div className={styles.confirmActions}>
              <button data-dialog-initial type="button" onClick={closeDeleteAll} disabled={deletingAll}>Cancel</button>
              <button
                className={styles.confirmDeleteButton}
                type="button"
                disabled={deletingAll}
                onClick={() => void confirmDeleteAll()}
              >
                {deletingAll ? <LoaderCircle className={styles.spinning} size={15} /> : <Trash2 size={15} />}
                {deletingAll ? "Deleting all" : `Delete all ${videos.length}`}
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

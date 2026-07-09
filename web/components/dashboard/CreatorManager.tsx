"use client";

import {
  CircleAlert,
  DownloadCloud,
  Library,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { mockStats, mockVideos } from "../../lib/mock-data";
import type { Creator, CreatorImport } from "../../lib/types";
import { useArchiveData } from "../../lib/useArchiveData";
import styles from "./dashboard.module.css";

export function CreatorManager({ creators }: { creators: Creator[] }) {
  const archive = useArchiveData({
    fallbackCreators: creators,
    fallbackVideos: mockVideos,
    fallbackStats: mockStats,
  });
  const apiBase = process.env.NEXT_PUBLIC_ARCHIVE_API_BASE?.replace(/\/+$/, "") || "";
  const [query, setQuery] = useState("");
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [importOpen, setImportOpen] = useState(false);
  const [importUsername, setImportUsername] = useState("");
  const [maxMinutes, setMaxMinutes] = useState("2");
  const [imports, setImports] = useState<CreatorImport[]>([]);
  const [importError, setImportError] = useState("");
  const [submittingImport, setSubmittingImport] = useState(false);
  const [actionCreatorId, setActionCreatorId] = useState("");
  const [deleteCreator, setDeleteCreator] = useState<Creator | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const liveCreators = archive.creators;

  const loadImports = useCallback(async () => {
    if (!apiBase) return;
    const response = await fetch(`${apiBase}/api/imports?limit=8`, { cache: "no-store" });
    const payload = await response.json() as { imports?: CreatorImport[]; error?: string };
    if (!response.ok) throw new Error(payload.error || `Import status failed (${response.status})`);
    setImports(payload.imports || []);
  }, [apiBase]);

  const hasActiveImport = imports.some((entry) => entry.status === "queued" || entry.status === "running");
  useEffect(() => {
    if (!importOpen || !hasActiveImport) return;
    const timer = window.setInterval(() => {
      void loadImports().catch(() => undefined);
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [hasActiveImport, importOpen, loadImports]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Element && !target.closest("[data-creator-actions]")) {
        setActionCreatorId("");
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setActionCreatorId("");
      if (!deleting) closeDeleteConfirmation();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [deleting]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return liveCreators.filter(
      (creator) =>
        !normalized ||
        creator.username.toLowerCase().includes(normalized) ||
        creator.displayName.toLowerCase().includes(normalized),
    );
  }, [liveCreators, query]);

  function toggleImportPanel() {
    const nextOpen = !importOpen;
    setImportOpen(nextOpen);
    if (nextOpen && apiBase) {
      void loadImports().catch((error: unknown) => {
        setImportError(error instanceof Error ? error.message : String(error));
      });
    }
  }

  async function submitImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setImportError("");
    const minutes = Number(maxMinutes);
    if (!Number.isFinite(minutes) || minutes < 0.25 || minutes > 60) {
      setImportError("Maximum length must be between 15 seconds and 60 minutes.");
      return;
    }
    if (!apiBase) {
      setImportError("The live backend connection is required to start an import.");
      return;
    }

    setSubmittingImport(true);
    try {
      const response = await fetch(`${apiBase}/api/imports`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: importUsername,
          maxDurationSeconds: Math.round(minutes * 60),
        }),
      });
      const payload = await response.json() as { import?: CreatorImport; error?: string };
      if (!response.ok || !payload.import) {
        throw new Error(payload.error || `Import failed (${response.status})`);
      }
      setImports((current) => [
        payload.import as CreatorImport,
        ...current.filter((entry) => entry.id !== payload.import?.id),
      ].slice(0, 8));
      setImportUsername("");
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmittingImport(false);
    }
  }

  function openDeleteConfirmation(creator: Creator) {
    setActionCreatorId("");
    setDeleteCreator(creator);
    setDeleteConfirmation("");
    setDeleteError("");
  }

  function closeDeleteConfirmation() {
    setDeleteCreator(null);
    setDeleteConfirmation("");
    setDeleteError("");
  }

  async function deleteCreatorVideos() {
    if (!deleteCreator || deleting) return;
    const expectedConfirmation = `@${deleteCreator.username}`.toLowerCase();
    if (deleteConfirmation.trim().toLowerCase() !== expectedConfirmation) return;
    if (!apiBase) {
      setDeleteError("The live backend connection is required to delete videos.");
      return;
    }

    setDeleting(true);
    setDeleteError("");
    try {
      const response = await fetch(
        `${apiBase}/api/creators/${encodeURIComponent(deleteCreator.username)}/videos`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmUsername: deleteConfirmation.trim() }),
        },
      );
      const payload = await response.json() as {
        deletedVideos?: number;
        failedVideos?: number;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || `Deletion failed (${response.status})`);
      }

      const deletedVideos = Number(payload.deletedVideos || 0);
      const failedVideos = Number(payload.failedVideos || 0);
      setActionMessage(
        failedVideos
          ? `Deleted ${deletedVideos} videos for @${deleteCreator.username}; ${failedVideos} could not be removed.`
          : `Deleted ${deletedVideos} videos for @${deleteCreator.username}.`,
      );
      closeDeleteConfirmation();
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
          <h1>Creators</h1>
        </div>
        <button
          className={styles.primaryButton}
          type="button"
          onClick={toggleImportPanel}
          aria-expanded={importOpen}
        >
          {importOpen ? <X size={17} /> : <DownloadCloud size={17} />}
          {importOpen ? "Close" : "Import creator"}
        </button>
      </div>

      {importOpen ? (
        <section className={styles.importPanel} aria-label="Import creator profile">
          <form className={styles.importForm} onSubmit={submitImport}>
            <label className={styles.formField}>
              <span>Creator</span>
              <input
                value={importUsername}
                onChange={(event) => setImportUsername(event.target.value)}
                placeholder="@username or TikTok profile URL"
                required
              />
            </label>
            <label className={styles.formField}>
              <span>Maximum video length</span>
              <div className={styles.inputSuffix}>
                <input
                  value={maxMinutes}
                  onChange={(event) => setMaxMinutes(event.target.value)}
                  type="number"
                  min="0.25"
                  max="60"
                  step="0.25"
                  required
                />
                <span>minutes</span>
              </div>
            </label>
            <button className={styles.primaryButton} type="submit" disabled={submittingImport}>
              {submittingImport ? <LoaderCircle className={styles.spinning} size={16} /> : <DownloadCloud size={16} />}
              {submittingImport ? "Starting" : "Import profile"}
            </button>
          </form>
          <p className={styles.importNote}>
            Existing files and videos longer than the selected limit are skipped. The default is 2 minutes.
          </p>
          {importError ? <p className={styles.importError} role="alert">{importError}</p> : null}
          {imports.length ? (
            <div className={styles.importList} aria-live="polite">
              {imports.map((entry) => (
                <article className={styles.importRow} key={entry.id}>
                  <div>
                    <strong>@{entry.username}</strong>
                    <span>{formatImportStatus(entry)}</span>
                  </div>
                  <span className={styles.importStatus} data-status={entry.status}>
                    {entry.status === "running" ? <LoaderCircle className={styles.spinning} size={13} /> : null}
                    {entry.status}
                  </span>
                  <dl>
                    <div><dt>Saved</dt><dd>{entry.downloadedCount}</dd></div>
                    <div><dt>Existing</dt><dd>{entry.skippedExistingCount}</dd></div>
                    <div><dt>Too long</dt><dd>{entry.skippedDurationCount}</dd></div>
                    <div><dt>Failed</dt><dd>{entry.failedCount}</dd></div>
                  </dl>
                  {entry.lastError && entry.status === "failed" ? <p>{entry.lastError}</p> : null}
                </article>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

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

      {actionMessage ? <p className={styles.actionMessage} role="status">{actionMessage}</p> : null}

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
              <div className={styles.creatorActions} data-creator-actions>
                <button
                  className={styles.creatorMenuTrigger}
                  type="button"
                  aria-label={`More actions for ${creator.username}`}
                  aria-haspopup="menu"
                  aria-expanded={actionCreatorId === creator.id}
                  onClick={() => setActionCreatorId((current) => current === creator.id ? "" : creator.id)}
                >
                  <MoreHorizontal size={20} />
                </button>
                {actionCreatorId === creator.id ? (
                  <div className={styles.creatorActionMenu} role="menu">
                    <Link
                      href={`/dashboard/videos?creator=${encodeURIComponent(creator.id)}&username=${encodeURIComponent(creator.username)}`}
                      role="menuitem"
                    >
                      <Library size={15} />
                      View videos
                    </Link>
                    <button
                      className={styles.creatorActionDanger}
                      type="button"
                      role="menuitem"
                      disabled={creator.videoCount === 0}
                      onClick={() => openDeleteConfirmation(creator)}
                    >
                      <Trash2 size={15} />
                      Delete all videos
                    </button>
                  </div>
                ) : null}
              </div>
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
                className={`${styles.switch} ${(enabled[creator.id] ?? creator.enabled) ? styles.switchOn : ""}`}
                onClick={() =>
                  setEnabled((current) => ({
                    ...current,
                    [creator.id]: !(current[creator.id] ?? creator.enabled),
                  }))
                }
                type="button"
                role="switch"
                aria-checked={enabled[creator.id] ?? creator.enabled}
                aria-label={`${(enabled[creator.id] ?? creator.enabled) ? "Disable" : "Enable"} monitoring for ${creator.username}`}
              >
                <span />
              </button>
            </div>
          </article>
        ))}
      </section>

      {deleteCreator ? (
        <div
          className={styles.confirmScrim}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deleting) closeDeleteConfirmation();
          }}
        >
          <section
            className={styles.confirmDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-creator-title"
          >
            <div className={styles.confirmIcon}><Trash2 size={19} /></div>
            <div>
              <h2 id="delete-creator-title">Delete all videos?</h2>
              <p>
                This permanently removes {deleteCreator.videoCount} archived {deleteCreator.videoCount === 1 ? "video" : "videos"}
                {" "}and saved metadata for @{deleteCreator.username}. The creator stays in your monitoring list.
              </p>
            </div>
            <label className={styles.confirmField}>
              <span>Type <strong>@{deleteCreator.username}</strong> to confirm</span>
              <input
                autoFocus
                value={deleteConfirmation}
                onChange={(event) => setDeleteConfirmation(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            {deleteError ? <p className={styles.importError} role="alert">{deleteError}</p> : null}
            <div className={styles.confirmActions}>
              <button type="button" onClick={closeDeleteConfirmation} disabled={deleting}>Cancel</button>
              <button
                className={styles.confirmDeleteButton}
                type="button"
                disabled={
                  deleting
                  || deleteConfirmation.trim().toLowerCase() !== `@${deleteCreator.username}`.toLowerCase()
                }
                onClick={() => void deleteCreatorVideos()}
              >
                {deleting ? <LoaderCircle className={styles.spinning} size={15} /> : <Trash2 size={15} />}
                {deleting ? "Deleting" : "Delete all videos"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function formatImportStatus(entry: CreatorImport) {
  if (entry.status === "queued") return `Waiting · ${entry.maxDurationSeconds}s limit`;
  if (entry.status === "running") {
    return entry.discoveredCount
      ? `${entry.processedCount} of ${entry.discoveredCount} processed`
      : "Scanning profile";
  }
  if (entry.status === "failed") return "Import stopped";
  return `${entry.processedCount} processed`;
}

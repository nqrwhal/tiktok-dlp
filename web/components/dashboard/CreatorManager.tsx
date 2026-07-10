"use client";

import {
  CircleAlert,
  DownloadCloud,
  Grid3X3,
  Library,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mockStats, mockVideos } from "../../lib/mock-data";
import type { Creator, CreatorImport, CreatorImportItem } from "../../lib/types";
import { useArchiveData } from "../../lib/useArchiveData";
import { useModalDialog } from "../../lib/useModalDialog";
import styles from "./dashboard.module.css";

const IMPORT_FAILURE_DETAIL_LIMIT = 5;

export function CreatorManager({ creators }: { creators: Creator[] }) {
  const archive = useArchiveData({
    fallbackCreators: creators,
    fallbackVideos: mockVideos,
    fallbackStats: mockStats,
    includeVideos: false,
    includeStats: false,
  });
  const apiBase = process.env.NEXT_PUBLIC_ARCHIVE_API_BASE?.replace(/\/+$/, "") || "";
  const [query, setQuery] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importUsername, setImportUsername] = useState("");
  const [maxMinutes, setMaxMinutes] = useState("2");
  const [imports, setImports] = useState<CreatorImport[]>([]);
  const [importError, setImportError] = useState("");
  const [importLoadError, setImportLoadError] = useState("");
  const [importActionErrors, setImportActionErrors] = useState<Record<number, string>>({});
  const [importActions, setImportActions] = useState<Record<number, "cancel" | "retry" | "details">>({});
  const [failureDetails, setFailureDetails] = useState<Record<number, CreatorImportItem[]>>({});
  const [expandedFailures, setExpandedFailures] = useState<Set<number>>(() => new Set());
  const [submittingImport, setSubmittingImport] = useState(false);
  const [actionCreatorId, setActionCreatorId] = useState("");
  const [deleteCreator, setDeleteCreator] = useState<Creator | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const importStatuses = useRef(new Map<number, CreatorImport["status"]>());
  const liveCreators = archive.creators;
  const refreshArchive = archive.refresh;
  const { dialogRef, returnFocusRef } = useModalDialog(Boolean(deleteCreator), closeDeleteConfirmation);

  const loadImports = useCallback(async () => {
    if (!apiBase) return;
    const response = await fetch(`${apiBase}/api/imports?limit=8`, { cache: "no-store" });
    const payload = await response.json() as { imports?: CreatorImport[]; error?: string };
    if (!response.ok) throw new Error(payload.error || `Import status failed (${response.status})`);
    const nextImports = payload.imports || [];
    const completedTransition = nextImports.some((entry) => {
      const previous = importStatuses.current.get(entry.id);
      return previous != null && isActiveImportStatus(previous) && isTerminalImportStatus(entry.status);
    });
    for (const entry of nextImports) importStatuses.current.set(entry.id, entry.status);
    setImports(nextImports);
    setImportLoadError("");
    if (completedTransition) refreshArchive();
  }, [apiBase, refreshArchive]);

  const activeImports = imports.filter((entry) => isActiveImportStatus(entry.status));
  const hasActiveImport = activeImports.length > 0;
  const primaryActiveImport = activeImports.find((entry) => entry.status === "running") || activeImports[0];

  useEffect(() => {
    if (!apiBase) return;
    // Load durable job state independently of whether the details panel is open.
    void loadImports().catch((error: unknown) => {
      setImportLoadError(error instanceof Error ? error.message : String(error));
    });
  }, [apiBase, loadImports]);

  useEffect(() => {
    if (!hasActiveImport) return;
    const timer = window.setInterval(() => {
      void loadImports().catch((error: unknown) => {
        setImportLoadError(error instanceof Error ? error.message : String(error));
      });
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [hasActiveImport, loadImports]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Element && !target.closest("[data-creator-actions]")) {
        setActionCreatorId("");
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const trigger = actionCreatorId
        ? document.getElementById(`creator-actions-${actionCreatorId}`)
        : null;
      setActionCreatorId("");
      if (trigger) window.requestAnimationFrame(() => trigger.focus());
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [actionCreatorId]);

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
        setImportLoadError(error instanceof Error ? error.message : String(error));
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
      importStatuses.current.set(payload.import.id, payload.import.status);
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

  function updateImport(nextImport: CreatorImport) {
    const previousStatus = importStatuses.current.get(nextImport.id);
    importStatuses.current.set(nextImport.id, nextImport.status);
    setImports((current) => [
      nextImport,
      ...current.filter((entry) => entry.id !== nextImport.id),
    ].slice(0, 8));
    if (previousStatus && isActiveImportStatus(previousStatus) && isTerminalImportStatus(nextImport.status)) {
      refreshArchive();
    }
  }

  async function runImportAction(entry: CreatorImport, action: "cancel" | "retry") {
    if (!apiBase || importActions[entry.id]) return;
    setImportActions((current) => ({ ...current, [entry.id]: action }));
    setImportActionErrors((current) => ({ ...current, [entry.id]: "" }));
    try {
      const response = await fetch(`${apiBase}/api/imports/${entry.id}/${action}`, { method: "POST" });
      const payload = await response.json().catch(() => ({})) as { import?: CreatorImport; error?: string };
      if (!response.ok || !payload.import) {
        throw new Error(payload.error || `${action === "cancel" ? "Cancel" : "Retry"} failed (${response.status})`);
      }
      if (action === "retry") {
        setFailureDetails((current) => {
          const next = { ...current };
          delete next[entry.id];
          return next;
        });
        setExpandedFailures((current) => {
          const next = new Set(current);
          next.delete(entry.id);
          return next;
        });
      }
      updateImport(payload.import);
    } catch (error) {
      setImportActionErrors((current) => ({
        ...current,
        [entry.id]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setImportActions((current) => {
        const next = { ...current };
        delete next[entry.id];
        return next;
      });
    }
  }

  async function toggleFailureDetails(entry: CreatorImport) {
    if (expandedFailures.has(entry.id)) {
      setExpandedFailures((current) => {
        const next = new Set(current);
        next.delete(entry.id);
        return next;
      });
      return;
    }
    if (Object.hasOwn(failureDetails, entry.id)) {
      setExpandedFailures((current) => new Set(current).add(entry.id));
      return;
    }
    if (!apiBase || importActions[entry.id]) return;
    setImportActions((current) => ({ ...current, [entry.id]: "details" }));
    setImportActionErrors((current) => ({ ...current, [entry.id]: "" }));
    try {
      const response = await fetch(`${apiBase}/api/imports/${entry.id}`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as { import?: CreatorImport; error?: string };
      if (!response.ok || !payload.import) {
        throw new Error(payload.error || `Import details failed (${response.status})`);
      }
      const failures = (payload.import.items || [])
        .filter((item) => item.status === "failed")
        .slice(0, IMPORT_FAILURE_DETAIL_LIMIT);
      setFailureDetails((current) => ({ ...current, [entry.id]: failures }));
      setExpandedFailures((current) => new Set(current).add(entry.id));
    } catch (error) {
      setImportActionErrors((current) => ({
        ...current,
        [entry.id]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setImportActions((current) => {
        const next = { ...current };
        delete next[entry.id];
        return next;
      });
    }
  }

  function openDeleteConfirmation(creator: Creator) {
    returnFocusRef.current = document.getElementById(`creator-actions-${creator.id}`);
    setActionCreatorId("");
    setDeleteCreator(creator);
    setDeleteConfirmation("");
    setDeleteError("");
  }

  function closeDeleteConfirmation() {
    if (deleting) return;
    setDeleteCreator(null);
    setDeleteConfirmation("");
    setDeleteError("");
  }

  async function deleteCreatorVideos() {
    if (!deleteCreator || deleting) return;
    const expectedConfirmation = `@${deleteCreator.username}`.toLowerCase();
    if (deleteConfirmation.trim().toLowerCase() !== expectedConfirmation) return;
    if (!apiBase) {
      setDeleteError("The live backend connection is required to move videos to trash.");
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
        trashedVideos?: number;
        failedVideos?: number;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || `Move to trash failed (${response.status})`);
      }

      const movedVideos = Number(payload.trashedVideos ?? payload.deletedVideos ?? 0);
      const failedVideos = Number(payload.failedVideos || 0);
      setActionMessage(
        failedVideos
          ? `Moved ${movedVideos} videos for @${deleteCreator.username} to trash; ${failedVideos} could not be moved.`
          : `Moved ${movedVideos} videos for @${deleteCreator.username} to trash.`,
      );
      returnFocusRef.current = document.getElementById("creator-import-button");
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
        <div className={styles.pageHeaderActions} aria-live="polite">
          {primaryActiveImport ? (
            <button
              className={styles.activeImportCompact}
              type="button"
              onClick={() => setImportOpen(true)}
              aria-label={`View import progress for @${primaryActiveImport.username}`}
            >
              {primaryActiveImport.status === "running"
                ? <LoaderCircle className={styles.spinning} size={15} />
                : <DownloadCloud size={15} />}
              <span>
                <strong>@{primaryActiveImport.username}</strong>
                <small>{formatCompactImportStatus(primaryActiveImport)}</small>
              </span>
              {importLoadError ? (
                <CircleAlert className={styles.importCompactWarning} size={14} aria-label="Import status refresh failed" />
              ) : activeImports.length > 1 ? <em>+{activeImports.length - 1}</em> : null}
            </button>
          ) : !importOpen && importLoadError ? (
            <button className={styles.importStatusError} type="button" onClick={() => setImportOpen(true)}>
              <CircleAlert size={14} /> Import status unavailable
            </button>
          ) : null}
          <button
            className={styles.primaryButton}
            id="creator-import-button"
            type="button"
            onClick={toggleImportPanel}
            aria-expanded={importOpen}
          >
            {importOpen ? <X size={17} /> : <DownloadCloud size={17} />}
            {importOpen ? "Close" : "Import creator"}
          </button>
        </div>
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
            Existing files, videos longer than the selected limit, and videos without a known duration are skipped. The default is 2 minutes.
          </p>
          {importError ? <p className={styles.importError} role="alert">{importError}</p> : null}
          {importLoadError ? <p className={styles.importError} role="alert">Could not refresh imports: {importLoadError}</p> : null}
          {imports.length ? (
            <div className={styles.importList} aria-live="polite">
              {imports.map((entry) => (
                <article className={styles.importRow} key={entry.id}>
                  <div>
                    <strong>@{entry.username}</strong>
                    <span>{formatImportStatus(entry)}</span>
                    {formatImportHistory(entry) ? <small>{formatImportHistory(entry)}</small> : null}
                  </div>
                  <span className={styles.importStatus} data-status={entry.status}>
                    {entry.status === "running" ? <LoaderCircle className={styles.spinning} size={13} /> : null}
                    {displayImportStatus(entry)}
                  </span>
                  <dl>
                    <div><dt>Saved</dt><dd>{entry.downloadedCount}</dd></div>
                    <div><dt>Existing</dt><dd>{entry.skippedExistingCount}</dd></div>
                    <div><dt>Too long</dt><dd>{entry.skippedDurationCount}</dd></div>
                    <div><dt>No duration</dt><dd>{entry.skippedUnknownDurationCount || 0}</dd></div>
                    <div><dt>Failed</dt><dd>{entry.failedCount}</dd></div>
                  </dl>
                  <div className={styles.importRowActions}>
                    {isActiveImportStatus(entry.status) ? (
                      <button
                        type="button"
                        disabled={Boolean(importActions[entry.id]) || Boolean(entry.cancelRequestedAt)}
                        onClick={() => void runImportAction(entry, "cancel")}
                      >
                        {importActions[entry.id] === "cancel" ? <LoaderCircle className={styles.spinning} size={13} /> : <X size={13} />}
                        {entry.cancelRequestedAt ? "Canceling" : importActions[entry.id] === "cancel" ? "Canceling" : "Cancel"}
                      </button>
                    ) : null}
                    {entry.status === "failed" || entry.status === "canceled" ? (
                      <button
                        type="button"
                        disabled={Boolean(importActions[entry.id])}
                        onClick={() => void runImportAction(entry, "retry")}
                      >
                        {importActions[entry.id] === "retry" ? <LoaderCircle className={styles.spinning} size={13} /> : <RefreshCw size={13} />}
                        {importActions[entry.id] === "retry" ? "Retrying" : "Retry"}
                      </button>
                    ) : null}
                    {entry.failedCount > 0 ? (
                      <button
                        type="button"
                        aria-expanded={expandedFailures.has(entry.id)}
                        disabled={Boolean(importActions[entry.id])}
                        onClick={() => void toggleFailureDetails(entry)}
                      >
                        {importActions[entry.id] === "details" ? <LoaderCircle className={styles.spinning} size={13} /> : <CircleAlert size={13} />}
                        {expandedFailures.has(entry.id) ? "Hide failures" : "Show failures"}
                      </button>
                    ) : null}
                  </div>
                  {importActionErrors[entry.id] ? (
                    <p className={styles.importRowError} role="alert">{importActionErrors[entry.id]}</p>
                  ) : null}
                  {entry.lastError && isTerminalImportStatus(entry.status) ? <p>{entry.lastError}</p> : null}
                  {expandedFailures.has(entry.id) ? (
                    <ImportFailureDetails
                      failures={failureDetails[entry.id] || []}
                      total={entry.failedCount}
                    />
                  ) : null}
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
      {archive.error ? (
        <div className={styles.errorNotice} role="alert">
          <span>{archive.error}</span>
          <button type="button" onClick={archive.refresh}>Retry</button>
        </div>
      ) : null}

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
                  id={`creator-actions-${creator.id}`}
                  type="button"
                  aria-label={`More actions for ${creator.username}`}
                  aria-controls={`creator-menu-${creator.id}`}
                  aria-expanded={actionCreatorId === creator.id}
                  onClick={() => setActionCreatorId((current) => current === creator.id ? "" : creator.id)}
                >
                  <MoreHorizontal size={20} />
                </button>
                {actionCreatorId === creator.id ? (
                  <div className={styles.creatorActionMenu} id={`creator-menu-${creator.id}`}>
                    <Link
                      href={`/creator?creator=${encodeURIComponent(creator.id)}`}
                    >
                      <Grid3X3 size={15} />
                      Open profile
                    </Link>
                    <Link
                      href={`/dashboard/videos?creator=${encodeURIComponent(creator.id)}&username=${encodeURIComponent(creator.username)}`}
                    >
                      <Library size={15} />
                      View videos
                    </Link>
                    <button
                      className={styles.creatorActionDanger}
                      type="button"
                      disabled={creator.videoCount === 0}
                      onClick={() => openDeleteConfirmation(creator)}
                    >
                      <Trash2 size={15} />
                      Move all to trash
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
            <h2><Link href={`/creator?creator=${encodeURIComponent(creator.id)}`}>{creator.displayName}</Link></h2>
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
              <span>{creator.enabled ? "Monitoring enabled" : "Saved archive only"}</span>
              <span className={creator.enabled ? styles.monitoringOn : styles.monitoringOff}>
                {creator.enabled ? "Monitored" : "Not monitored"}
              </span>
            </div>
          </article>
        ))}
      </section>
      {filtered.length === 0 ? (
        <div className={styles.tableEmpty}>
          <Search size={25} />
          <strong>
            {archive.source === "loading" || archive.source === "refreshing"
              ? "Loading creators…"
              : archive.source === "error" ? "Could not load creators" : "No matching creators"}
          </strong>
          <span>{archive.source === "error" ? "Retry the live archive connection." : "Try a different search term."}</span>
        </div>
      ) : null}

      {deleteCreator ? (
        <div
          className={styles.confirmScrim}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !deleting) closeDeleteConfirmation();
          }}
        >
          <section
            className={styles.confirmDialog}
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-creator-title"
          >
            <div className={styles.confirmIcon}><Trash2 size={19} /></div>
            <div>
              <h2 id="delete-creator-title">Move all videos to trash?</h2>
              <p>
                This removes {deleteCreator.videoCount} archived {deleteCreator.videoCount === 1 ? "video" : "videos"}
                {" "}for @{deleteCreator.username} from the active archive. They can be restored from Videos → Trash until their scheduled purge. {deleteCreator.enabled
                  ? "The creator stays in your monitoring list."
                  : "This saved-only creator will be removed from the creator list."}
              </p>
            </div>
            <label className={styles.confirmField}>
              <span>Type <strong>@{deleteCreator.username}</strong> to confirm</span>
              <input
                data-dialog-initial
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
                {deleting ? "Moving" : "Move all to trash"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function formatImportStatus(entry: CreatorImport) {
  if (entry.cancelRequestedAt && isActiveImportStatus(entry.status)) return "Cancellation requested";
  if (entry.status === "queued") return `Waiting · ${entry.maxDurationSeconds}s limit`;
  if (entry.status === "running") {
    return entry.discoveredCount
      ? `${entry.processedCount} of ${entry.discoveredCount} processed`
      : "Scanning profile";
  }
  if (entry.status === "failed") return "Import stopped";
  if (entry.status === "canceled") return `${entry.processedCount} processed before cancellation`;
  return `${entry.processedCount} processed`;
}

function formatCompactImportStatus(entry: CreatorImport) {
  if (entry.cancelRequestedAt) return "Canceling";
  if (entry.status === "queued") return "Queued";
  if (!entry.discoveredCount) return "Scanning profile";
  return `${entry.processedCount}/${entry.discoveredCount} processed`;
}

function formatImportHistory(entry: CreatorImport) {
  const parts: string[] = [];
  if (entry.retryCount > 0) parts.push(`${entry.retryCount} ${entry.retryCount === 1 ? "retry" : "retries"}`);
  if (entry.resumeCount > 0) parts.push(`${entry.resumeCount} ${entry.resumeCount === 1 ? "resume" : "resumes"}`);
  return parts.join(" · ");
}

function displayImportStatus(entry: CreatorImport) {
  return entry.cancelRequestedAt && isActiveImportStatus(entry.status) ? "canceling" : entry.status;
}

function isActiveImportStatus(status: CreatorImport["status"]) {
  return status === "queued" || status === "running";
}

function isTerminalImportStatus(status: CreatorImport["status"]) {
  return status === "completed" || status === "failed" || status === "canceled";
}

function ImportFailureDetails({ failures, total }: { failures: CreatorImportItem[]; total: number }) {
  return (
    <div className={styles.importFailures} role="region" aria-label="Individual import failures">
      {failures.length ? (
        <ul>
          {failures.map((failure) => (
            <li key={failure.id}>
              <strong>{failure.title || (failure.videoId ? `Video ${failure.videoId}` : `Post ${failure.position}`)}</strong>
              <span>{failure.error || "This item could not be archived."}</span>
              {failure.attemptCount > 1 ? <small>{failure.attemptCount} attempts</small> : null}
            </li>
          ))}
        </ul>
      ) : <p>No individual failure details are available.</p>}
      {failures.length > 0 && total > IMPORT_FAILURE_DETAIL_LIMIT ? (
        <small>Showing {Math.min(failures.length, IMPORT_FAILURE_DETAIL_LIMIT)} of {total} failures.</small>
      ) : null}
    </div>
  );
}

"use client";

import {
  CircleAlert,
  DownloadCloud,
  LoaderCircle,
  MoreHorizontal,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
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
  const liveCreators = archive.creators;
  const apiBase = process.env.NEXT_PUBLIC_ARCHIVE_API_BASE?.replace(/\/+$/, "") || "";
  const [query, setQuery] = useState("");
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [importOpen, setImportOpen] = useState(false);
  const [importUsername, setImportUsername] = useState("");
  const [maxMinutes, setMaxMinutes] = useState("2");
  const [imports, setImports] = useState<CreatorImport[]>([]);
  const [importError, setImportError] = useState("");
  const [submittingImport, setSubmittingImport] = useState(false);

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

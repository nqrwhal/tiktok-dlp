"use client";

import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileArchive,
  Images,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ProfilePlatform, SavedMediaAsset, SavedPost } from "../../lib/types";
import { useArchivePosts } from "../../lib/useArchivePosts";
import { useModalDialog } from "../../lib/useModalDialog";
import styles from "./dashboard.module.css";

const platformOptions: Array<{ value: ProfilePlatform | ""; label: string }> = [
  { value: "", label: "All platforms" },
  { value: "tiktok", label: "TikTok" },
  { value: "instagram", label: "Instagram" },
  { value: "x", label: "X / Twitter" },
];

export function MediaLibrary() {
  const [view, setView] = useState<"active" | "trash">("active");
  const [platform, setPlatform] = useState<ProfilePlatform | "">("");
  const [bookmarkedOnly, setBookmarkedOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [assetIndexes, setAssetIndexes] = useState<Record<string, number>>({});
  const [lifecycleAction, setLifecycleAction] = useState<{
    kind: "trash" | "restore";
    post: SavedPost;
  } | null>(null);
  const [lifecyclePending, setLifecyclePending] = useState(false);
  const [lifecycleError, setLifecycleError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const archive = useArchivePosts({
    platform,
    bookmarkedOnly,
    trashedOnly: view === "trash",
    limit: 24,
  });
  const { dialogRef, returnFocusRef } = useModalDialog(Boolean(lifecycleAction), closeLifecycleDialog);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return archive.posts.filter((post) => (
      (!bookmarkedOnly || post.bookmarked)
      && (!needle || [
        post.title,
        post.description,
        post.username,
        post.displayName,
        post.platform,
        ...post.tags,
      ].some((value) => String(value).toLowerCase().includes(needle)))
    ));
  }, [archive.posts, bookmarkedOnly, query]);
  const hasMediaFilters = Boolean(platform || bookmarkedOnly || query.trim());

  function moveAsset(post: SavedPost, direction: -1 | 1) {
    setAssetIndexes((current) => {
      const count = Math.max(1, post.assets.length);
      const active = Math.min(count - 1, Math.max(0, current[post.id] || 0));
      return {
        ...current,
        [post.id]: (active + direction + count) % count,
      };
    });
  }

  function openLifecycleDialog(post: SavedPost, kind: "trash" | "restore") {
    returnFocusRef.current = document.getElementById(`media-${kind}-${post.id}`);
    setLifecycleAction({ post, kind });
    setLifecycleError("");
  }

  function closeLifecycleDialog() {
    if (lifecyclePending) return;
    setLifecycleAction(null);
    setLifecycleError("");
  }

  async function confirmLifecycleAction() {
    if (!lifecycleAction || lifecyclePending) return;
    setLifecyclePending(true);
    setLifecycleError("");
    const error = lifecycleAction.kind === "trash"
      ? await archive.moveToTrash(lifecycleAction.post)
      : await archive.restore(lifecycleAction.post);
    if (error) {
      setLifecycleError(error);
      setLifecyclePending(false);
      return;
    }
    const completed = lifecycleAction;
    returnFocusRef.current = document.getElementById(
      completed.kind === "trash" ? "media-active-view" : "media-trash-view",
    );
    setActionMessage(
      completed.kind === "trash"
        ? `Moved ${completed.post.title} to trash.`
        : `Restored ${completed.post.title}.`,
    );
    setLifecycleAction(null);
    setLifecyclePending(false);
  }

  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <h1>Media</h1>
          <p>Browse ordered images, videos, GIFs, and mixed posts saved from every supported platform.</p>
        </div>
      </div>

      <div className={styles.mediaFilterBar}>
        <div className={styles.mediaViewFilter} role="group" aria-label="Media archive view">
          <button
            id="media-active-view"
            type="button"
            aria-pressed={view === "active"}
            data-active={view === "active"}
            onClick={() => {
              setView("active");
              setActionMessage("");
            }}
          >
            Active
          </button>
          <button
            id="media-trash-view"
            type="button"
            aria-pressed={view === "trash"}
            data-active={view === "trash"}
            onClick={() => {
              setView("trash");
              setActionMessage("");
            }}
          >
            Trash
          </button>
        </div>
        <label className={styles.searchField}>
          <Search size={17} />
          <span className="sr-only">Search saved media</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search saved media"
          />
        </label>
        <label className={styles.mediaPlatformFilter}>
          <span>Platform</span>
          <select
            value={platform}
            onChange={(event) => setPlatform(event.target.value as ProfilePlatform | "")}
          >
            {platformOptions.map((option) => (
              <option value={option.value} key={option.value || "all"}>{option.label}</option>
            ))}
          </select>
        </label>
        <button
          className={styles.mediaBookmarkFilter}
          type="button"
          aria-pressed={bookmarkedOnly}
          data-active={bookmarkedOnly}
          onClick={() => setBookmarkedOnly((current) => !current)}
        >
          <Bookmark size={16} fill={bookmarkedOnly ? "currentColor" : "none"} />
          Bookmarked
        </button>
        <span className={styles.resultCount} role="status">
          {filtered.length} loaded {filtered.length === 1 ? "post" : "posts"}
        </span>
      </div>

      {archive.error ? (
        <div className={styles.errorNotice} role="alert">
          <span>{archive.error}</span>
          <button type="button" onClick={archive.refresh}><RefreshCw size={15} /> Retry</button>
        </div>
      ) : null}

      {actionMessage ? <p className={styles.actionMessage} role="status">{actionMessage}</p> : null}

      <section className={styles.mediaGrid} aria-label={view === "trash" ? "Trashed media posts" : "Saved media posts"}>
        {filtered.map((post) => {
          const activeIndex = Math.min(
            Math.max(0, post.assets.length - 1),
            Math.max(0, assetIndexes[post.id] || 0),
          );
          const activeAsset = post.assets[activeIndex] || null;
          return (
            <article className={styles.mediaCard} key={post.id}>
              <div className={styles.mediaPreview} style={{ "--media-accent": post.accent } as React.CSSProperties}>
                <MediaAsset asset={view === "trash" ? null : activeAsset} post={post} />
                <span className={styles.mediaPlatformBadge}>{platformLabel(post.platform)}</span>
                {post.assets.length > 1 ? (
                  <>
                    <button
                      className={styles.mediaPrevious}
                      type="button"
                      onClick={() => moveAsset(post, -1)}
                      aria-label={`Previous asset in ${post.title}`}
                    >
                      <ChevronLeft size={20} />
                    </button>
                    <button
                      className={styles.mediaNext}
                      type="button"
                      onClick={() => moveAsset(post, 1)}
                      aria-label={`Next asset in ${post.title}`}
                    >
                      <ChevronRight size={20} />
                    </button>
                    <span className={styles.mediaPosition} aria-live="polite">
                      {activeIndex + 1} / {post.assets.length}
                    </span>
                  </>
                ) : null}
              </div>

              <div className={styles.mediaCardBody}>
                <div className={styles.mediaCardHeading}>
                  <div>
                    <strong>{post.title}</strong>
                    <span>@{post.username} · {post.savedAtLabel}</span>
                  </div>
                  {post.assetCount > 1 ? <span><Images size={14} /> {post.assetCount}</span> : null}
                </div>
                {post.description ? <p>{post.description}</p> : null}
                <div className={styles.mediaCardMeta}>
                  <span>{mediaTypeLabel(post)}</span>
                  <span>{post.sizeLabel}</span>
                  {post.creatorGroupName ? <span>{post.creatorGroupName}</span> : null}
                  {view === "trash" && post.trashedAt ? <span>Moved {shortDate(post.trashedAt)}</span> : null}
                </div>
                <div className={styles.mediaCardActions}>
                  {view === "active" ? (
                    <>
                      <button
                        className={styles.mediaBookmarkAction}
                        type="button"
                        aria-label={post.bookmarked ? `Remove bookmark for ${post.title}` : `Bookmark ${post.title}`}
                        aria-pressed={post.bookmarked}
                        data-active={post.bookmarked}
                        disabled={archive.pendingBookmarkIds.has(post.id) || archive.pendingLifecycleIds.has(post.id)}
                        onClick={() => void archive.setBookmarked(post, !post.bookmarked)}
                      >
                        <Bookmark size={15} fill={post.bookmarked ? "currentColor" : "none"} />
                        {post.bookmarked ? "Bookmarked" : "Bookmark"}
                      </button>
                      <button
                        className={styles.mediaLifecycleAction}
                        id={`media-trash-${post.id}`}
                        type="button"
                        disabled={archive.pendingLifecycleIds.has(post.id) || archive.pendingBookmarkIds.has(post.id)}
                        onClick={() => openLifecycleDialog(post, "trash")}
                      >
                        <Trash2 size={15} /> Move to trash
                      </button>
                    </>
                  ) : (
                    <button
                      className={styles.mediaLifecycleAction}
                      id={`media-restore-${post.id}`}
                      type="button"
                      disabled={post.retentionStatus === "trash_claimed" || archive.pendingLifecycleIds.has(post.id)}
                      onClick={() => openLifecycleDialog(post, "restore")}
                    >
                      <RotateCcw size={15} />
                      {post.retentionStatus === "trash_claimed" ? "Purge in progress" : "Restore"}
                    </button>
                  )}
                  {post.sourceUrl ? (
                    <a href={post.sourceUrl} target="_blank" rel="noreferrer">
                      <ExternalLink size={15} /> Original
                    </a>
                  ) : null}
                  {view === "active" ? (
                    <a href={post.downloadUrl} download>
                      <Download size={15} /> Download
                    </a>
                  ) : null}
                </div>
              </div>
            </article>
          );
        })}
      </section>

      {filtered.length === 0 ? (
        <div className={styles.mediaEmpty} role="status">
          {archive.source === "loading" ? <LoaderCircle className={styles.spinning} size={25} /> : <Images size={25} />}
          <strong>
            {archive.source === "loading"
              ? "Loading media…"
              : view === "trash"
                ? hasMediaFilters ? "No matching trash" : "Trash is empty"
                : "No matching media"}
          </strong>
          <span>
            {archive.source === "mock"
              ? "Connect the live archive to browse saved multi-platform posts."
              : view === "trash"
                ? hasMediaFilters
                  ? "Try another platform, bookmark filter, or search term."
                  : "Posts moved to trash stay restorable until the configured automatic purge."
                : "Try another platform or search term."}
          </span>
        </div>
      ) : null}

      {archive.hasMore ? (
        <div className={styles.mediaLoadMore}>
          <button type="button" onClick={() => void archive.loadMore()} disabled={archive.loadingMore}>
            {archive.loadingMore ? <LoaderCircle className={styles.spinning} size={16} /> : null}
            {archive.loadingMore ? "Loading…" : "Load more media"}
          </button>
        </div>
      ) : null}

      {lifecycleAction ? (
        <div
          className={styles.confirmScrim}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !lifecyclePending) closeLifecycleDialog();
          }}
        >
          <section
            className={styles.confirmDialog}
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="media-lifecycle-title"
          >
            <div className={lifecycleAction.kind === "trash" ? styles.confirmIcon : styles.restoreIcon}>
              {lifecycleAction.kind === "trash" ? <Trash2 size={19} /> : <RotateCcw size={19} />}
            </div>
            <div>
              <h2 id="media-lifecycle-title">
                {lifecycleAction.kind === "trash" ? "Move this post to trash?" : "Restore this post?"}
              </h2>
              <p>
                <strong className={styles.confirmVideoTitle}>{lifecycleAction.post.title}</strong>
                <span className={styles.confirmVideoMeta}>
                  {platformLabel(lifecycleAction.post.platform)} · @{lifecycleAction.post.username}
                </span>
                {lifecycleAction.kind === "trash"
                  ? "Its saved package and ordered assets will leave the active archive, while its bookmark is preserved for restoration."
                  : "Its saved package and ordered assets will return to the active Media library."}
              </p>
            </div>
            {lifecycleError ? <p className={styles.importError} role="alert">{lifecycleError}</p> : null}
            <div className={styles.confirmActions}>
              <button data-dialog-initial type="button" onClick={closeLifecycleDialog} disabled={lifecyclePending}>
                Cancel
              </button>
              <button
                className={lifecycleAction.kind === "trash" ? styles.confirmDeleteButton : undefined}
                type="button"
                disabled={lifecyclePending}
                onClick={() => void confirmLifecycleAction()}
              >
                {lifecyclePending
                  ? <LoaderCircle className={styles.spinning} size={15} />
                  : lifecycleAction.kind === "trash" ? <Trash2 size={15} /> : <RotateCcw size={15} />}
                {lifecyclePending
                  ? lifecycleAction.kind === "trash" ? "Moving" : "Restoring"
                  : lifecycleAction.kind === "trash" ? "Move to trash" : "Restore post"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function MediaAsset({ asset, post }: { asset: SavedMediaAsset | null; post: SavedPost }) {
  if (!asset) {
    return <div className={styles.mediaArchivePreview}><FileArchive size={34} /><span>No preview available</span></div>;
  }
  if (asset.kind === "video") {
    return (
      <video
        key={asset.mediaUrl}
        src={asset.mediaUrl}
        controls
        playsInline
        preload="metadata"
        aria-label={`${post.title}, asset ${asset.position}`}
      />
    );
  }
  if (asset.kind === "image" || asset.kind === "animated") {
    // Assets are served from the private same-origin archive bridge.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={asset.mediaUrl} alt={post.title} loading="lazy" />;
  }
  return (
    <div className={styles.mediaArchivePreview}>
      <FileArchive size={34} />
      <span>{asset.filename || "Download archive"}</span>
    </div>
  );
}

function platformLabel(platform: ProfilePlatform) {
  if (platform === "x") return "X";
  return platform.slice(0, 1).toUpperCase() + platform.slice(1);
}

function mediaTypeLabel(post: SavedPost) {
  if (post.mediaType === "mixed") return "Mixed media";
  if (post.mediaType === "gallery") return "Gallery";
  if (post.mediaType === "animated") return "Animated image";
  return post.mediaType.slice(0, 1).toUpperCase() + post.mediaType.slice(1);
}

function shortDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "recently" : date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

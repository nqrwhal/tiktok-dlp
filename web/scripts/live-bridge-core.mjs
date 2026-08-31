import path from "node:path";

export const MAX_LEGACY_VIDEO_LIMIT = 5_000;
export const MAX_PAGINATED_VIDEO_LIMIT = 100;
export const MAX_PAGINATED_POST_LIMIT = 100;

export function buildRewindVideoReadPath({
  username = "",
  fileId = 0,
  limit = 500,
  cursor = null,
  bookmarkedOnly = false,
} = {}) {
  const params = new URLSearchParams({
    limit: String(Math.min(MAX_LEGACY_VIDEO_LIMIT + 1, positiveInteger(limit, 500))),
  });
  const normalizedUsername = String(username || "").trim();
  if (normalizedUsername) params.set("username", normalizedUsername);
  if (fileId) params.set("fileId", String(positiveSafeInteger(fileId, "fileId")));
  if (cursor) {
    params.set("beforeCreatedAt", String(nonNegativeSafeInteger(cursor.createdAt, "createdAt")));
    params.set("beforeFileId", String(positiveSafeInteger(cursor.fileId, "fileId")));
  }
  if (bookmarkedOnly) params.set("bookmarked", "1");
  return `/api/rewind/videos?${params}`;
}

export function buildRewindPostReadPath({
  platform = "",
  username = "",
  profileId = 0,
  groupId = 0,
  fileId = 0,
  limit = MAX_PAGINATED_POST_LIMIT,
  cursor = null,
  bookmarkedOnly = false,
  trashedOnly = false,
} = {}) {
  const params = new URLSearchParams({
    limit: String(Math.min(MAX_PAGINATED_POST_LIMIT + 1, positiveInteger(limit, MAX_PAGINATED_POST_LIMIT))),
  });
  const normalizedPlatform = String(platform || "").trim().toLowerCase();
  const normalizedUsername = String(username || "").trim();
  if (normalizedPlatform) params.set("platform", normalizedPlatform);
  if (normalizedUsername) params.set("username", normalizedUsername);
  if (profileId) params.set("profileId", String(positiveSafeInteger(profileId, "profileId")));
  if (groupId) params.set("groupId", String(positiveSafeInteger(groupId, "groupId")));
  if (fileId) params.set("fileId", String(positiveSafeInteger(fileId, "fileId")));
  if (cursor) {
    params.set("beforeCreatedAt", String(nonNegativeSafeInteger(cursor.createdAt, "createdAt")));
    params.set("beforeFileId", String(positiveSafeInteger(cursor.fileId, "fileId")));
  }
  if (bookmarkedOnly) params.set("bookmarked", "1");
  if (trashedOnly) params.set("trashed", "1");
  return `/api/rewind/posts?${params}`;
}

export function encodeVideoCursor(row) {
  const createdAt = nonNegativeSafeInteger(row?.created_at ?? row?.createdAt, "createdAt");
  const fileId = positiveSafeInteger(row?.id ?? row?.fileId, "fileId");
  return Buffer.from(JSON.stringify([createdAt, fileId]), "utf8").toString("base64url");
}

export function decodeVideoCursor(value) {
  const encoded = String(value || "").trim();
  if (!encoded || encoded.length > 256 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error("Invalid video cursor");
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error("Invalid shape");
    return {
      createdAt: nonNegativeSafeInteger(parsed[0], "createdAt"),
      fileId: positiveSafeInteger(parsed[1], "fileId"),
    };
  } catch {
    throw new Error("Invalid video cursor");
  }
}

export function resolveArchivePath(storedPath, { archiveDownloads, remoteDownloads }) {
  const archiveRoot = normalizedAbsolutePath(archiveDownloads, "archive download root");
  const remoteRoot = normalizedAbsolutePath(remoteDownloads, "remote download root");
  const normalized = path.posix.normalize(String(storedPath || ""));
  let relative;
  if (isWithinRoot(normalized, "/app/data/downloads")) {
    relative = path.posix.relative("/app/data/downloads", normalized);
  } else if (isWithinRoot(normalized, archiveRoot)) {
    relative = path.posix.relative(archiveRoot, normalized);
  } else if (isWithinRoot(normalized, remoteRoot)) {
    relative = path.posix.relative(remoteRoot, normalized);
  } else {
    throw new Error("Refusing to read a media path outside the download archive");
  }
  if (!relative || relative === "." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    throw new Error("Invalid media path");
  }
  const resolved = path.posix.join(archiveRoot, relative);
  if (!isWithinRoot(resolved, archiveRoot)) throw new Error("Invalid media path");
  return resolved;
}

export function thumbnailSidecarCandidates(storedPath, roots) {
  const mediaPath = resolveArchivePath(storedPath, roots);
  const extension = path.posix.extname(mediaPath);
  if (!extension) throw new Error("Media path has no extension");
  const stem = mediaPath.slice(0, -extension.length);
  return [".image", ".jpg", ".jpeg"].map((suffix) => `${stem}${suffix}`);
}

export function isTrashSchemaMigrationError(error) {
  return /no such column:\s*(?:files\.)?(?:trashed_at|platform)/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

export function matchImportProxyRoute(pathname, method) {
  const normalizedPath = String(pathname || "");
  const normalizedMethod = String(method || "").toUpperCase();
  if (normalizedPath === "/api/imports") {
    return {
      allowed: normalizedMethod === "GET" || normalizedMethod === "POST",
      readsBody: normalizedMethod === "POST",
    };
  }
  if (/^\/api\/imports\/\d+$/.test(normalizedPath)) {
    return { allowed: normalizedMethod === "GET", readsBody: false };
  }
  if (/^\/api\/imports\/\d+\/(?:cancel|retry)$/.test(normalizedPath)) {
    return { allowed: normalizedMethod === "POST", readsBody: normalizedMethod === "POST" };
  }
  return null;
}

export function matchCreatorMonitoringProxyRoute(pathname, method) {
  if (!/^\/api\/creators\/[^/]+\/monitoring$/.test(String(pathname || ""))) return null;
  return { allowed: String(method || "").toUpperCase() === "DELETE" };
}

export function matchProfileGroupsProxyRoute(pathname, method) {
  const normalizedPath = String(pathname || "");
  const normalizedMethod = String(method || "").toUpperCase();
  if (normalizedPath === "/api/profile-groups") {
    return {
      allowed: normalizedMethod === "GET" || normalizedMethod === "POST",
      readsBody: normalizedMethod === "POST",
    };
  }
  if (/^\/api\/profile-groups\/\d+$/.test(normalizedPath)) {
    return {
      allowed: normalizedMethod === "PATCH",
      readsBody: normalizedMethod === "PATCH",
    };
  }
  if (/^\/api\/profile-groups\/\d+\/profiles\/\d+$/.test(normalizedPath)) {
    return { allowed: normalizedMethod === "DELETE", readsBody: false };
  }
  return null;
}

export function matchPostBookmarkProxyRoute(pathname, method) {
  const match = String(pathname || "").match(/^\/api\/post-bookmarks\/(\d+)$/);
  if (!match) return null;
  const normalizedMethod = String(method || "").toUpperCase();
  return {
    allowed: normalizedMethod === "PUT" || normalizedMethod === "DELETE",
    fileId: Number(match[1]),
  };
}

export function matchMediaPostMutationProxyRoute(pathname, method) {
  const normalizedPath = String(pathname || "");
  const normalizedMethod = String(method || "").toUpperCase();
  const restore = normalizedPath.match(/^\/api\/media-posts\/(\d+)\/restore$/);
  if (restore) {
    return {
      allowed: normalizedMethod === "POST",
      fileId: Number(restore[1]),
      readsBody: normalizedMethod === "POST",
    };
  }
  const trash = normalizedPath.match(/^\/api\/media-posts\/(\d+)$/);
  if (trash) {
    return {
      allowed: normalizedMethod === "DELETE",
      fileId: Number(trash[1]),
      readsBody: normalizedMethod === "DELETE",
    };
  }
  return null;
}

export function isAllowedCorsOrigin(origin, { publicBaseUrl = "", allowLoopback = true } = {}) {
  const value = String(origin || "").trim();
  if (!value) return true;
  let requestedOrigin;
  try {
    requestedOrigin = new URL(value).origin;
  } catch {
    return false;
  }
  if (requestedOrigin !== value.replace(/\/$/, "")) return false;

  if (publicBaseUrl) {
    try {
      if (requestedOrigin === new URL(publicBaseUrl).origin) return true;
    } catch {
      // An invalid configured public URL does not broaden CORS access.
    }
  }
  if (!allowLoopback) return false;
  const parsed = new URL(requestedOrigin);
  return (parsed.protocol === "http:" || parsed.protocol === "https:")
    && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
}

export function createActiveFileTracker() {
  const refCounts = new Map();
  return {
    acquire(name) {
      const key = String(name);
      refCounts.set(key, (refCounts.get(key) || 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const remaining = (refCounts.get(key) || 1) - 1;
        if (remaining > 0) refCounts.set(key, remaining);
        else refCounts.delete(key);
      };
    },
    protectedNames() {
      return new Set(refCounts.keys());
    },
  };
}

export function createBoundedRowCache(maxEntries = 10_000, { ttlMs = Infinity, now = Date.now } = {}) {
  const limit = positiveInteger(maxEntries, 10_000);
  const parsedTtl = Number(ttlMs);
  const maxAgeMs = Number.isFinite(parsedTtl) ? Math.max(0, parsedTtl) : Infinity;
  const currentTime = typeof now === "function" ? now : Date.now;
  const rowsById = new Map();
  function isExpired(entry, timestamp = currentTime()) {
    return timestamp - entry.cachedAt >= maxAgeMs;
  }
  function pruneExpired() {
    if (maxAgeMs === Infinity) return;
    const timestamp = currentTime();
    for (const [key, entry] of rowsById) {
      if (isExpired(entry, timestamp)) rowsById.delete(key);
    }
  }
  return {
    get(fileId) {
      const key = String(fileId);
      const entry = rowsById.get(key);
      if (!entry) return undefined;
      if (isExpired(entry)) {
        rowsById.delete(key);
        return undefined;
      }
      rowsById.delete(key);
      rowsById.set(key, entry);
      return entry.row;
    },
    add(rows) {
      pruneExpired();
      const cachedAt = currentTime();
      for (const row of rows || []) {
        if (row?.id === undefined || row?.id === null) continue;
        const key = String(row.id);
        rowsById.delete(key);
        rowsById.set(key, { row, cachedAt });
        while (rowsById.size > limit) rowsById.delete(rowsById.keys().next().value);
      }
    },
    delete(fileId) {
      rowsById.delete(String(fileId));
    },
    clear() {
      rowsById.clear();
    },
    get size() {
      pruneExpired();
      return rowsById.size;
    },
  };
}

export function createExpiringSingleFlight(load, { ttlMs, now = Date.now } = {}) {
  let cached = { loadedAt: 0, value: undefined };
  let inflight = null;
  async function refresh({ force = false } = {}) {
    const currentTime = now();
    if (!force && cached.value !== undefined && currentTime - cached.loadedAt < ttlMs) {
      return cached.value;
    }
    if (inflight) return inflight;
    inflight = Promise.resolve()
      .then(load)
      .then((value) => {
        cached = { loadedAt: now(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }
  refresh.invalidate = () => {
    cached = { loadedAt: 0, value: undefined };
  };
  return refresh;
}

export function selectCacheEntriesForEviction(
  entries,
  { maxAgeMs, maxBytes, now = Date.now(), protectedNames = new Set() },
) {
  const candidates = [];
  let retainedBytes = 0;
  for (const entry of entries) {
    const name = String(entry.name || "");
    const size = Math.max(0, Number(entry.size) || 0);
    if (entry.isFile === false || name.includes(".part-")) continue;
    if (protectedNames.has(name)) {
      retainedBytes += size;
      continue;
    }
    if (now - Number(entry.mtimeMs || 0) > maxAgeMs) {
      candidates.push({ ...entry, name, size, expired: true });
    } else {
      retainedBytes += size;
      candidates.push({ ...entry, name, size, expired: false });
    }
  }
  const evicted = candidates.filter((entry) => entry.expired);
  const oldestFirst = candidates
    .filter((entry) => !entry.expired)
    .sort((left, right) => Number(left.mtimeMs || 0) - Number(right.mtimeMs || 0));
  for (const entry of oldestFirst) {
    if (retainedBytes <= maxBytes) break;
    retainedBytes -= entry.size;
    evicted.push(entry);
  }
  return evicted.map((entry) => entry.name);
}

export function matchesIfNoneMatch(value, etag) {
  const requested = String(value || "").trim();
  if (!requested) return false;
  const target = weakEtagValue(etag);
  return requested.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    return trimmed === "*" || weakEtagValue(trimmed) === target;
  });
}

function weakEtagValue(value) {
  return String(value || "").trim().replace(/^W\//, "");
}

function normalizedAbsolutePath(value, label) {
  const normalized = path.posix.normalize(String(value || ""));
  if (!path.posix.isAbsolute(normalized) || normalized === "/") {
    throw new Error(`Invalid ${label}`);
  }
  return normalized.replace(/\/+$/, "");
}

function isWithinRoot(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeSafeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid ${label}`);
  return parsed;
}

function positiveSafeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${label}`);
  return parsed;
}

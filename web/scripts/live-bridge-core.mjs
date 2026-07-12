import path from "node:path";

export const MAX_LEGACY_VIDEO_LIMIT = 5_000;
export const MAX_PAGINATED_VIDEO_LIMIT = 100;

export function buildVideoSql({
  username = "",
  fileId = 0,
  limit = 500,
  cursor = null,
  bookmarkedOnly = false,
} = {}) {
  const boundedLimit = Math.min(MAX_LEGACY_VIDEO_LIMIT, positiveInteger(limit, 500));
  const creatorClause = username
    ? `AND files.username = ${sqliteString(username)} COLLATE NOCASE`
    : "";
  const fileClause = fileId ? `AND files.id = ${positiveInteger(fileId, 0)}` : "";
  const cursorClause = cursor
    ? `AND (files.created_at < ${cursor.createdAt}
        OR (files.created_at = ${cursor.createdAt} AND files.id < ${cursor.fileId}))`
    : "";
  const bookmarkClause = bookmarkedOnly
    ? "AND EXISTS (SELECT 1 FROM bookmarks WHERE bookmarks.file_id = files.id)"
    : "";
  return `
    SELECT
      files.id,
      files.video_id,
      files.username,
      files.source_url,
      files.path,
      files.filename,
      files.size_bytes,
      files.created_at,
      COALESCE(
        (
          SELECT jobs.title
          FROM jobs
          WHERE jobs.file_id = files.id
            AND jobs.title IS NOT NULL
            AND jobs.title <> ''
          ORDER BY jobs.created_at DESC, jobs.id DESC
          LIMIT 1
        ),
        files.filename
      ) AS title
    FROM files
    WHERE lower(files.filename) LIKE '%.mp4'
      AND files.trashed_at IS NULL
      ${creatorClause}
      ${fileClause}
      ${cursorClause}
      ${bookmarkClause}
    ORDER BY files.created_at DESC, files.id DESC
    LIMIT ${boundedLimit};
  `;
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
  return /no such column:\s*(?:files\.)?trashed_at/i.test(
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

export function createBoundedRowCache(maxEntries = 10_000) {
  const limit = positiveInteger(maxEntries, 10_000);
  const rowsById = new Map();
  return {
    get(fileId) {
      const key = String(fileId);
      const row = rowsById.get(key);
      if (!row) return undefined;
      rowsById.delete(key);
      rowsById.set(key, row);
      return row;
    },
    add(rows) {
      for (const row of rows || []) {
        if (row?.id === undefined || row?.id === null) continue;
        const key = String(row.id);
        rowsById.delete(key);
        rowsById.set(key, row);
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

function sqliteString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
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

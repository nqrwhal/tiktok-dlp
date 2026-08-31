import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import {
  MAX_PAGINATED_VIDEO_LIMIT,
  MAX_PAGINATED_POST_LIMIT,
  buildRewindPostReadPath,
  buildRewindVideoReadPath,
  createActiveFileTracker,
  createBoundedRowCache,
  createExpiringSingleFlight,
  decodeVideoCursor,
  encodeVideoCursor,
  isTrashSchemaMigrationError,
  isAllowedCorsOrigin,
  matchCreatorMonitoringProxyRoute,
  matchImportProxyRoute,
  matchMediaPostMutationProxyRoute,
  matchPostBookmarkProxyRoute,
  matchProfileGroupsProxyRoute,
  matchesIfNoneMatch,
  resolveArchivePath as resolveSafeArchivePath,
  selectCacheEntriesForEviction,
  thumbnailSidecarCandidates,
} from "./live-bridge-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..");
const cacheDir = process.env.LIVE_CACHE_PATH || path.join(projectDir, ".live-cache");
const host = process.env.LIVE_SSH_HOST || "yufeihl";
const port = positiveInteger(process.env.LIVE_BRIDGE_PORT, 8787);
const localMode = /^(1|true|yes)$/i.test(process.env.LIVE_LOCAL_MODE || "");
const listenHost = process.env.LIVE_BRIDGE_HOST || (localMode ? "0.0.0.0" : "127.0.0.1");
const remoteProject = process.env.LIVE_REMOTE_PROJECT || "/home/yufei/tiktok-discord-downloader";
const remoteDownloads = `${remoteProject}/data/downloads`;
const archiveDownloads = process.env.LIVE_DOWNLOADS_PATH || (localMode ? "/app/data/downloads" : remoteDownloads);
const backendUrl = (process.env.LIVE_BACKEND_URL || "http://tiktok-discord-downloader:8080").replace(/\/+$/, "");
const importApiToken = process.env.LIVE_IMPORT_API_TOKEN || "";
const publicBaseUrl = (process.env.LIVE_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const cacheMaxBytes = positiveInteger(process.env.LIVE_CACHE_MAX_MB, 5 * 1024) * 1024 ** 2;
const cacheMaxAgeMs = positiveInteger(process.env.LIVE_CACHE_MAX_AGE_DAYS, 7) * 86_400_000;
const archiveRowCacheTtlMs = 30_000;
const inflightCopies = new Map();
const inflightThumbnails = new Map();
const activeCacheFiles = createActiveFileTracker();
const limitVideoCopies = createTaskLimiter(2);
const limitThumbnailGeneration = createTaskLimiter(2);
let videoCache = { loadedAt: 0, rows: [] };
let videoCacheLoadPromise = null;
const videoRowsById = createBoundedRowCache(10_000, { ttlMs: archiveRowCacheTtlMs });
const postRowsById = createBoundedRowCache(10_000, { ttlMs: archiveRowCacheTtlMs });
const loadMetadataIndex = createExpiringSingleFlight(scanMetadataIndex, { ttlMs: 60_000 });
let cacheEvictionPromise = null;

await mkdir(cacheDir, { recursive: true });
await pruneLiveCache();

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin || "";
  if (!applyCors(response, origin)) {
    sendJson(response, 403, { error: "Origin not allowed" });
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `127.0.0.1:${port}`}`);

    if (request.method === "GET" && url.pathname === "/api/health") {
      try {
        const upstream = await remoteAdminRequest("GET", "/ready");
        if (upstream.status < 200 || upstream.status >= 300) {
          throw new Error(`Backend readiness failed (${upstream.status})`);
        }
        if (localMode) {
          const archive = await stat(archiveDownloads);
          if (!archive.isDirectory()) throw new Error("Archive media mount is unavailable");
        }
        sendJson(response, 200, {
          status: "ok",
          backend: "ready",
          archive: localMode ? "readable" : "remote",
        });
      } catch {
        sendJson(response, 503, { status: "not_ready" });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/creators") {
      const rows = await loadArchiveCreatorRows();
      sendJson(response, 200, rows.map(toCreator));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/videos") {
      const creatorId = String(url.searchParams.get("creatorId") || "").toLowerCase();
      const username = String(url.searchParams.get("username") || "").trim();
      const fileId = positiveInteger(url.searchParams.get("fileId"), 0);
      const bookmarkedOnly = url.searchParams.get("bookmarked") === "1";
      const paginated = url.searchParams.get("page") === "1" || url.searchParams.has("cursor");
      const limit = Math.min(
        paginated ? MAX_PAGINATED_VIDEO_LIMIT : 5_000,
        positiveInteger(url.searchParams.get("limit"), paginated ? 36 : 100),
      );
      let cursor = null;
      if (paginated && url.searchParams.has("cursor")) {
        try {
          cursor = decodeVideoCursor(url.searchParams.get("cursor"));
        } catch {
          sendJson(response, 400, { error: "Invalid video cursor" });
          return;
        }
      }
      let resolvedUsername = username || creatorId;
      let baseRows = resolvedUsername
        ? await loadArchiveVideoRows({
          username: resolvedUsername,
          limit: paginated ? limit + 1 : limit,
          cursor,
          bookmarkedOnly,
        })
        : bookmarkedOnly
          ? await loadArchiveVideoRows({
            limit: paginated ? limit + 1 : limit,
            cursor,
            bookmarkedOnly: true,
          })
        : paginated
          ? await loadArchiveVideoRows({ limit: limit + 1, cursor })
        : limit <= 500
          ? await loadVideoRows()
          : await loadArchiveVideoRows({ limit });
      if (!paginated && !bookmarkedOnly && !resolvedUsername && limit > 500) {
        videoCache = { loadedAt: Date.now(), rows: baseRows };
      }
      if (creatorId && !username && baseRows.length === 0) {
        const legacyUsername = await resolveCreatorUsername(creatorId);
        if (legacyUsername && legacyUsername.toLowerCase() !== resolvedUsername.toLowerCase()) {
          resolvedUsername = legacyUsername;
          baseRows = await loadArchiveVideoRows({
            username: resolvedUsername,
            limit: paginated ? limit + 1 : limit,
            cursor,
            bookmarkedOnly,
          });
        }
      }
      videoRowsById.add(baseRows);
      const rows = [...baseRows];
      if (fileId && !cursor) {
        const exactIndex = rows.findIndex((row) => Number(row.id) === fileId);
        if (exactIndex < 0) {
          const exactRows = await loadArchiveVideoRows({ fileId, limit: 1, bookmarkedOnly });
          videoRowsById.add(exactRows);
          rows.unshift(...exactRows);
        } else if (exactIndex >= limit) {
          rows.unshift(...rows.splice(exactIndex, 1));
        }
      }
      const metadataById = await loadMetadataIndex();
      const filtered = creatorId
        ? rows.filter((row) => creatorMatches(row.username, creatorId))
        : rows;
      const uniqueRows = [...new Map(filtered.map((row) => [String(row.id), row])).values()];
      const pageRows = uniqueRows.slice(0, limit);
      const items = pageRows.map((row) => (
        toVideo(row, request, metadataById[String(row.video_id || "")] || {})
      ));
      if (paginated) {
        sendJson(response, 200, {
          items,
          nextCursor: uniqueRows.length > limit && pageRows.length
            ? encodeVideoCursor(pageRows.at(-1))
            : null,
        });
      } else {
        sendJson(response, 200, items);
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/posts") {
      const platform = String(url.searchParams.get("platform") || "").trim().toLowerCase();
      const username = String(url.searchParams.get("username") || "").trim();
      const profileId = positiveInteger(url.searchParams.get("profileId"), 0);
      const groupId = positiveInteger(url.searchParams.get("groupId"), 0);
      const fileId = positiveInteger(url.searchParams.get("fileId"), 0);
      const bookmarkedOnly = url.searchParams.get("bookmarked") === "1";
      const trashedOnly = url.searchParams.get("trashed") === "1";
      const limit = Math.min(
        MAX_PAGINATED_POST_LIMIT,
        positiveInteger(url.searchParams.get("limit"), 36),
      );
      let cursor = null;
      if (url.searchParams.has("cursor")) {
        try {
          cursor = decodeVideoCursor(url.searchParams.get("cursor"));
        } catch {
          sendJson(response, 400, { error: "Invalid post cursor" });
          return;
        }
      }
      const rows = await loadArchivePostRows({
        platform,
        username,
        profileId,
        groupId,
        fileId: cursor ? 0 : fileId,
        limit: limit + 1,
        cursor,
        bookmarkedOnly,
        trashedOnly,
      });
      postRowsById.add(rows);
      const pageRows = rows.slice(0, limit);
      sendJson(response, 200, {
        items: pageRows.map((row) => toPost(row, request)),
        nextCursor: rows.length > limit && pageRows.length
          ? encodeVideoCursor(pageRows.at(-1))
          : null,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/stats") {
      const row = await loadArchiveStats();
      const sizeBytes = Number(row.size_bytes || 0);
      sendJson(response, 200, {
        creatorCount: Number(row.creator_count || 0),
        videoCount: Number(row.video_count || 0),
        storageUsed: formatBytes(sizeBytes),
        storagePercent: Math.min(100, Math.round((sizeBytes / (10 * 1024 ** 3)) * 100)),
        newThisWeek: Number(row.new_this_week || 0),
        addedToday: Number(row.added_today || 0),
      });
      return;
    }

    const bookmarksRoute = url.pathname === "/api/bookmarks";
    const bookmarkRoute = /^\/api\/bookmarks\/\d+$/.test(url.pathname);
    if (bookmarksRoute || bookmarkRoute) {
      const allowed = bookmarksRoute
        ? request.method === "GET" || request.method === "POST"
        : request.method === "PUT" || request.method === "DELETE";
      if (!allowed) {
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }
      const body = request.method === "POST" ? await readBodyText(request) : "";
      const upstream = await remoteAdminRequest(request.method, `${url.pathname}${url.search}`, body);
      sendUpstream(response, upstream);
      return;
    }

    const postBookmarkRoute = matchPostBookmarkProxyRoute(url.pathname, request.method);
    if (postBookmarkRoute) {
      if (!postBookmarkRoute.allowed) {
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }
      const upstream = await remoteAdminRequest(request.method, `${url.pathname}${url.search}`);
      if (upstream.status >= 200 && upstream.status < 300) {
        postRowsById.delete(postBookmarkRoute.fileId);
      }
      sendUpstream(response, upstream);
      return;
    }

    const mediaPostMutationRoute = matchMediaPostMutationProxyRoute(url.pathname, request.method);
    if (mediaPostMutationRoute) {
      if (!mediaPostMutationRoute.allowed) {
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }
      const body = mediaPostMutationRoute.readsBody ? await readBodyText(request) : "";
      const upstream = await remoteAdminRequest(request.method, `${url.pathname}${url.search}`, body);
      if (upstream.status >= 200 && upstream.status < 300) {
        videoCache = { loadedAt: 0, rows: [] };
        videoRowsById.clear();
        postRowsById.clear();
        loadMetadataIndex.invalidate();
      }
      sendUpstream(response, upstream);
      return;
    }

    const importApiRoute = matchImportProxyRoute(url.pathname, request.method);
    if (importApiRoute) {
      if (!importApiRoute.allowed) {
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }
      const body = importApiRoute.readsBody ? await readBodyText(request) : "";
      const upstream = await remoteAdminRequest(request.method, `${url.pathname}${url.search}`, body);
      response.writeHead(upstream.status, {
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(upstream.body),
        "Content-Type": upstream.contentType || "application/json; charset=utf-8",
      });
      response.end(upstream.body);
      return;
    }

    const profileGroupsRoute = matchProfileGroupsProxyRoute(url.pathname, request.method);
    if (profileGroupsRoute) {
      if (!profileGroupsRoute.allowed) {
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }
      const body = profileGroupsRoute.readsBody ? await readBodyText(request) : "";
      const upstream = await remoteAdminRequest(request.method, `${url.pathname}${url.search}`, body);
      sendUpstream(response, upstream);
      return;
    }

    if ((request.method === "GET" || request.method === "DELETE") && url.pathname === "/api/trash") {
      const body = request.method === "DELETE" ? await readBodyText(request) : "";
      const upstream = await remoteAdminRequest(request.method, `${url.pathname}${url.search}`, body);
      if (request.method === "DELETE" && upstream.status >= 200 && upstream.status < 300) {
        videoCache = { loadedAt: 0, rows: [] };
        videoRowsById.clear();
        postRowsById.clear();
        loadMetadataIndex.invalidate();
      }
      sendUpstream(response, upstream);
      return;
    }

    const trashVideoRoute = /^\/api\/trash\/\d+$/.test(url.pathname);
    if (trashVideoRoute && request.method === "DELETE") {
      const body = await readBodyText(request);
      const upstream = await remoteAdminRequest("DELETE", `${url.pathname}${url.search}`, body);
      if (upstream.status >= 200 && upstream.status < 300) {
        videoCache = { loadedAt: 0, rows: [] };
        videoRowsById.clear();
        postRowsById.clear();
        loadMetadataIndex.invalidate();
      }
      sendUpstream(response, upstream);
      return;
    }

    const creatorMonitoringRoute = matchCreatorMonitoringProxyRoute(url.pathname, request.method);
    if (creatorMonitoringRoute) {
      if (!creatorMonitoringRoute.allowed) {
        sendJson(response, 405, { error: "Method not allowed" });
        return;
      }
      const upstream = await remoteAdminRequest(request.method, `${url.pathname}${url.search}`);
      sendUpstream(response, upstream);
      return;
    }

    const restoreVideoRoute = /^\/api\/videos\/\d+\/restore$/.test(url.pathname);
    if (restoreVideoRoute && request.method === "POST") {
      const body = await readBodyText(request);
      const upstream = await remoteAdminRequest("POST", `${url.pathname}${url.search}`, body);
      if (upstream.status >= 200 && upstream.status < 300) {
        videoCache = { loadedAt: 0, rows: [] };
        videoRowsById.clear();
        postRowsById.clear();
        loadMetadataIndex.invalidate();
      }
      sendUpstream(response, upstream);
      return;
    }

    const creatorVideosRoute = /^\/api\/creators\/[^/]+\/videos$/.test(url.pathname);
    if (creatorVideosRoute && request.method === "DELETE") {
      const body = await readBodyText(request);
      const upstream = await remoteAdminRequest(request.method, `${url.pathname}${url.search}`, body);
      if (upstream.status >= 200 && upstream.status < 300) {
        videoCache = { loadedAt: 0, rows: [] };
        videoRowsById.clear();
        postRowsById.clear();
        loadMetadataIndex.invalidate();
      }
      response.writeHead(upstream.status, {
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(upstream.body),
        "Content-Type": upstream.contentType || "application/json; charset=utf-8",
      });
      response.end(upstream.body);
      return;
    }

    const videoRoute = /^\/api\/videos\/\d+$/.test(url.pathname);
    if (videoRoute && request.method === "DELETE") {
      const body = await readBodyText(request);
      const upstream = await remoteAdminRequest(request.method, `${url.pathname}${url.search}`, body);
      if (upstream.status >= 200 && upstream.status < 300) {
        videoCache = { loadedAt: 0, rows: [] };
        videoRowsById.clear();
        postRowsById.clear();
        loadMetadataIndex.invalidate();
      }
      response.writeHead(upstream.status, {
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(upstream.body),
        "Content-Type": upstream.contentType || "application/json; charset=utf-8",
      });
      response.end(upstream.body);
      return;
    }

    const mediaMatch = url.pathname.match(/^\/media\/(\d+)$/);
    if ((request.method === "GET" || request.method === "HEAD") && mediaMatch) {
      await serveMedia(request, response, Number(mediaMatch[1]));
      return;
    }

    const postMediaMatch = url.pathname.match(/^\/post-media\/(\d+)\/(\d+)$/);
    if ((request.method === "GET" || request.method === "HEAD") && postMediaMatch) {
      await servePostMedia(
        request,
        response,
        Number(postMediaMatch[1]),
        Number(postMediaMatch[2]),
      );
      return;
    }

    const postDownloadMatch = url.pathname.match(/^\/post-download\/(\d+)$/);
    if ((request.method === "GET" || request.method === "HEAD") && postDownloadMatch) {
      await servePostDownload(request, response, Number(postDownloadMatch[1]));
      return;
    }

    const thumbnailMatch = url.pathname.match(/^\/thumbnail\/(\d+)\.jpg$/);
    if ((request.method === "GET" || request.method === "HEAD") && thumbnailMatch) {
      await serveThumbnail(request, response, Number(thumbnailMatch[1]));
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    if (isClientDisconnect(error, request, response)) return;
    console.error("[live-bridge]", error);
    if (!response.headersSent) {
      if (isTrashSchemaMigrationError(error)) {
        sendJson(response, 503, {
          error: "The archive database is being upgraded. Retry in a moment.",
        });
      } else {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    } else {
      response.destroy(error instanceof Error ? error : undefined);
    }
  }
});

server.listen(port, listenHost, () => {
  const source = localMode ? backendUrl : host;
  console.log(`[live-bridge] Live archive (${source}) available at http://${listenHost}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

async function loadVideoRows({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - videoCache.loadedAt < 15_000) return videoCache.rows;
  if (videoCacheLoadPromise) return videoCacheLoadPromise;
  videoCacheLoadPromise = loadArchiveVideoRows()
    .then((rows) => {
      videoCache = { loadedAt: Date.now(), rows };
      videoRowsById.add(rows);
      return rows;
    })
    .finally(() => {
      videoCacheLoadPromise = null;
    });
  return videoCacheLoadPromise;
}

async function resolveCreatorUsername(creatorId) {
  if (!creatorId) return "";
  const rows = await loadArchiveCreatorRows();
  return String(rows.find((row) => creatorMatches(row.username, creatorId))?.username || "");
}

function creatorMatches(username, creatorId) {
  const normalizedUsername = String(username || "").trim().toLowerCase();
  const normalizedId = String(creatorId || "").trim().toLowerCase();
  return normalizedUsername === normalizedId || legacyCreatorKey(username) === normalizedId;
}

async function scanMetadataIndex() {
  const encodedRoot = Buffer.from(archiveDownloads, "utf8").toString("base64");
  const script = [
    "import base64, json, os",
    `archive_root = base64.b64decode(${JSON.stringify(encodedRoot)}).decode('utf-8')`,
    "result = {}",
    "for current_root, _, filenames in os.walk(archive_root):",
    "    for filename in filenames:",
    "        if not filename.endswith('.info.json'):",
    "            continue",
    "        file_path = os.path.join(current_root, filename)",
    "        try:",
    "            with open(file_path, 'r', encoding='utf-8') as source:",
    "                data = json.load(source)",
    "        except Exception:",
    "            continue",
    "        video_id = str(data.get('id') or filename[:-10])",
    "        raw_tags = data.get('tags')",
    "        result[video_id] = {",
    "            'title': str(data.get('title') or ''),",
    "            'description': str(data.get('description') or ''),",
    "            'tags': raw_tags if isinstance(raw_tags, list) else [],",
    "            'duration': data.get('duration'),",
    "            'timestamp': data.get('timestamp'),",
    "        }",
    "print(json.dumps(result, ensure_ascii=False))",
  ].join("\n");
  return archivePythonJson(script);
}

async function serveMedia(request, response, fileId) {
  const record = await findVideoRow(fileId);
  if (!record) {
    sendJson(response, 404, { error: "Video not found" });
    return;
  }

  await serveStoredMedia(request, response, record, { contentType: "video/mp4" });
}

async function servePostMedia(request, response, fileId, assetIndex) {
  const post = await findPostRow(fileId);
  if (!post || post.trashed_at != null) {
    sendJson(response, 404, { error: "Post media not found" });
    return;
  }
  const asset = postContentAssets(post)[assetIndex];
  if (!asset) {
    sendJson(response, 404, { error: "Post media not found" });
    return;
  }
  await serveStoredMedia(request, response, {
    id: `post-${fileId}-asset-${asset.id ?? assetIndex}`,
    path: asset.path,
    filename: asset.filename,
    size_bytes: asset.size_bytes,
  }, {
    contentType: safeMediaContentType(asset.mime_type, asset.filename),
  });
}

async function servePostDownload(request, response, fileId) {
  const post = await findPostRow(fileId);
  if (!post || post.trashed_at != null) {
    sendJson(response, 404, { error: "Post download not found" });
    return;
  }
  await serveStoredMedia(request, response, {
    id: `post-${fileId}-download`,
    path: post.path,
    filename: post.filename,
    size_bytes: post.size_bytes,
  }, {
    contentType: safeMediaContentType("", post.filename),
    forceDownload: true,
  });
}

async function serveStoredMedia(request, response, record, {
  contentType = "application/octet-stream",
  forceDownload = false,
} = {}) {

  const expectedPath = localMode ? resolveArchivePath(record.path) : videoCachePath(record);
  const releaseCacheFile = markActiveCacheFile(expectedPath);
  try {
    const localPath = await ensureCached(record);
    const fileStats = await stat(localPath);
    const range = parseRange(request.headers.range, fileStats.size);
    const modifiedAt = fileStats.mtime.toUTCString();
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const wantsDownload = requestUrl.searchParams.get("download") === "1";
    const headers = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=604800, immutable, no-transform",
      "Content-Type": contentType,
      ETag: `"${cacheRecordKey(record)}-${fileStats.size}-${Math.trunc(fileStats.mtimeMs)}"`,
      "Last-Modified": modifiedAt,
    };
    if (forceDownload || wantsDownload) {
      const filename = String(record.filename || `${record.id}.mp4`).replace(/["\\\r\n]/g, "_");
      headers["Content-Disposition"] = `attachment; filename="${filename}"`;
    }

    if (range === null && request.headers.range) {
      response.writeHead(416, {
        ...headers,
        "Content-Range": `bytes */${fileStats.size}`,
      });
      response.end();
      return;
    }

    if (range) {
      response.writeHead(206, {
        ...headers,
        "Content-Length": String(range.end - range.start + 1),
        "Content-Range": `bytes ${range.start}-${range.end}/${fileStats.size}`,
      });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      await pipeline(createReadStream(localPath, range), response);
      return;
    }

    response.writeHead(200, {
      ...headers,
      "Content-Length": String(fileStats.size),
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    await pipeline(createReadStream(localPath), response);
  } finally {
    releaseCacheFile();
  }
}

async function serveThumbnail(request, response, fileId) {
  const record = await findVideoRow(fileId);
  if (!record) {
    sendJson(response, 404, { error: "Video not found" });
    return;
  }

  const expectedPath = path.join(cacheDir, `thumb-${record.id}.jpg`);
  const releaseCacheFile = markActiveCacheFile(expectedPath);
  try {
    const thumbnailPath = await ensureThumbnail(record);
    const thumbnailStats = await stat(thumbnailPath);
    const etag = `"${fileId}-${thumbnailStats.size}-${Math.trunc(thumbnailStats.mtimeMs)}"`;
    const headers = {
      "Cache-Control": "private, max-age=31536000, immutable, no-transform",
      "Content-Type": "image/jpeg",
      ETag: etag,
      "Last-Modified": thumbnailStats.mtime.toUTCString(),
    };
    if (matchesIfNoneMatch(request.headers["if-none-match"], etag)
      || isNotModifiedSince(request, thumbnailStats.mtimeMs)) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    response.writeHead(200, {
      ...headers,
      "Content-Length": String(thumbnailStats.size),
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    await pipeline(createReadStream(thumbnailPath), response);
  } finally {
    releaseCacheFile();
  }
}

async function findVideoRow(fileId) {
  const indexed = videoRowsById.get(fileId);
  if (indexed) return indexed;
  const rows = await loadVideoRows();
  const cached = rows.find((row) => Number(row.id) === Number(fileId));
  if (cached) return cached;
  const [exact] = await loadArchiveVideoRows({ fileId, limit: 1 });
  if (exact) videoRowsById.add([exact]);
  return exact || null;
}

async function findPostRow(fileId) {
  const indexed = postRowsById.get(fileId);
  if (indexed) return indexed;
  const [exact] = await loadArchivePostRows({ fileId, limit: 1 });
  if (exact) postRowsById.add([exact]);
  return exact || null;
}

function videoCachePath(record) {
  const safeName = String(record.filename || `${record.id}.mp4`).replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(cacheDir, `${cacheRecordKey(record)}-${safeName}`);
}

function cacheRecordKey(record) {
  return String(record?.id ?? "media").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "media";
}

async function ensureCached(record) {
  if (localMode) return resolveArchivePath(record.path);

  const localPath = videoCachePath(record);
  const expectedSize = Number(record.size_bytes || 0);
  const cacheKey = cacheRecordKey(record);

  try {
    const existing = await stat(localPath);
    if (!expectedSize || existing.size === expectedSize) return localPath;
  } catch {
    // Cache miss.
  }

  if (inflightCopies.has(cacheKey)) return inflightCopies.get(cacheKey);
  const copyPromise = limitVideoCopies(() => copyFromRemote(record, localPath))
    .finally(() => inflightCopies.delete(cacheKey));
  inflightCopies.set(cacheKey, copyPromise);
  return copyPromise;
}

async function copyFromRemote(record, localPath) {
  const sourcePath = resolveArchivePath(record.path);
  const tempPath = `${localPath}.part-${process.pid}`;
  const encodedPath = Buffer.from(sourcePath, "utf8").toString("base64");
  const script = [
    "import base64, sys",
    `source_path = base64.b64decode(${JSON.stringify(encodedPath)}).decode('utf-8')`,
    "with open(source_path, 'rb') as source:",
    "    while True:",
    "        chunk = source.read(1024 * 1024)",
    "        if not chunk:",
    "            break",
    "        sys.stdout.buffer.write(chunk)",
  ].join("\n");

  await rm(tempPath, { force: true });
  const child = spawn("ssh", sshArgs("python3 -"), { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(script);

  try {
    await Promise.all([
      pipeline(child.stdout, createWriteStream(tempPath)),
      waitForChild(child),
    ]);
    const copied = await stat(tempPath);
    const expectedSize = Number(record.size_bytes || 0);
    if (expectedSize && copied.size !== expectedSize) {
      throw new Error(`Media copy was incomplete (${copied.size}/${expectedSize} bytes)`);
    }
    await rename(tempPath, localPath);
    await pruneLiveCache();
    return localPath;
  } catch (error) {
    await rm(tempPath, { force: true });
    const detail = stderr.trim();
    throw new Error(detail || (error instanceof Error ? error.message : String(error)));
  }
}

async function ensureThumbnail(record) {
  const localPath = path.join(cacheDir, `thumb-${record.id}.jpg`);
  try {
    const existing = await stat(localPath);
    if (existing.size > 0) return localPath;
  } catch {
    // Cache miss.
  }

  if (inflightThumbnails.has(record.id)) return inflightThumbnails.get(record.id);
  const thumbnailPromise = limitThumbnailGeneration(() => prepareThumbnail(record, localPath))
    .finally(() => inflightThumbnails.delete(record.id));
  inflightThumbnails.set(record.id, thumbnailPromise);
  return thumbnailPromise;
}

async function prepareThumbnail(record, localPath) {
  const copiedSidecar = localMode
    ? await copyLocalThumbnailSidecar(record, localPath)
    : await copyRemoteThumbnailSidecar(record, localPath);
  if (copiedSidecar) return localPath;
  return localMode
    ? generateLocalThumbnail(record, localPath)
    : generateRemoteThumbnail(record, localPath);
}

async function copyLocalThumbnailSidecar(record, localPath) {
  const candidates = thumbnailSidecarCandidates(record.path, { archiveDownloads, remoteDownloads });
  const tempPath = `${localPath}.part-${process.pid}`;
  const resolvedArchiveRoot = await realpath(archiveDownloads);
  for (const candidate of candidates) {
    try {
      const resolvedCandidate = await realpath(candidate);
      const relativeCandidate = path.relative(resolvedArchiveRoot, resolvedCandidate);
      if (
        !relativeCandidate
        || relativeCandidate.startsWith(`..${path.sep}`)
        || relativeCandidate === ".."
        || path.isAbsolute(relativeCandidate)
      ) {
        throw new Error("Refusing to read a thumbnail outside the download archive");
      }
      if (!await isJpegFile(resolvedCandidate)) continue;
      await rm(tempPath, { force: true });
      await copyFile(resolvedCandidate, tempPath);
      const copied = await stat(tempPath);
      if (!copied.size) continue;
      await rename(tempPath, localPath);
      await pruneLiveCache();
      return true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
      await rm(tempPath, { force: true });
      throw error;
    }
  }
  await rm(tempPath, { force: true });
  return false;
}

async function copyRemoteThumbnailSidecar(record, localPath) {
  const candidates = thumbnailSidecarCandidates(record.path, { archiveDownloads, remoteDownloads });
  const tempPath = `${localPath}.part-${process.pid}`;
  const encodedRoot = Buffer.from(archiveDownloads, "utf8").toString("base64");
  const encodedCandidates = Buffer.from(JSON.stringify(candidates), "utf8").toString("base64");
  const script = [
    "import base64, json, os, shutil, sys",
    `archive_root = os.path.realpath(base64.b64decode(${JSON.stringify(encodedRoot)}).decode('utf-8'))`,
    `candidates = json.loads(base64.b64decode(${JSON.stringify(encodedCandidates)}).decode('utf-8'))`,
    "for candidate in candidates:",
    "    resolved = os.path.realpath(candidate)",
    "    try:",
    "        if os.path.commonpath([archive_root, resolved]) != archive_root:",
    "            continue",
    "        with open(resolved, 'rb') as source:",
    "            signature = source.read(3)",
    "            if len(signature) != 3 or signature[0:2] != b'\\xff\\xd8' or signature[2] != 0xff:",
    "                continue",
    "            sys.stdout.buffer.write(signature)",
    "            shutil.copyfileobj(source, sys.stdout.buffer, 1024 * 1024)",
    "            break",
    "    except (FileNotFoundError, IsADirectoryError, PermissionError):",
    "        continue",
  ].join("\n");

  await rm(tempPath, { force: true });
  const child = spawn("ssh", sshArgs("python3 -"), { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(script);
  try {
    await Promise.all([
      pipeline(child.stdout, createWriteStream(tempPath)),
      waitForChild(child),
    ]);
    const copied = await stat(tempPath);
    if (!copied.size) {
      await rm(tempPath, { force: true });
      return false;
    }
    await rename(tempPath, localPath);
    await pruneLiveCache();
    return true;
  } catch (error) {
    await rm(tempPath, { force: true });
    throw new Error(stderr.trim() || (error instanceof Error ? error.message : String(error)));
  }
}

async function generateRemoteThumbnail(record, localPath) {

  const sourcePath = resolveArchivePath(record.path);
  const relativePath = path.posix.relative(archiveDownloads, sourcePath);
  const containerPath = path.posix.join("/app/data/downloads", relativePath);
  const tempPath = `${localPath}.part-${process.pid}`;
  const encodedPath = Buffer.from(containerPath, "utf8").toString("base64");
  const encodedComposeFile = Buffer.from(`${remoteProject}/docker-compose.yml`, "utf8").toString("base64");
  const script = [
    "import base64, os",
    `source_path = base64.b64decode(${JSON.stringify(encodedPath)}).decode('utf-8')`,
    `compose_file = base64.b64decode(${JSON.stringify(encodedComposeFile)}).decode('utf-8')`,
    "os.execvp('docker', ['docker', 'compose', '-f', compose_file, 'exec', '-T', 'tiktok-discord-downloader', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-ss', '0.25', '-i', source_path, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'])",
  ].join("\n");

  await rm(tempPath, { force: true });
  const child = spawn("ssh", sshArgs("python3 -"), { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(script);

  try {
    await Promise.all([
      pipeline(child.stdout, createWriteStream(tempPath)),
      waitForChild(child),
    ]);
    const generated = await stat(tempPath);
    if (!generated.size) throw new Error("Thumbnail generation returned an empty image");
    await rename(tempPath, localPath);
    await pruneLiveCache();
    return localPath;
  } catch (error) {
    await rm(tempPath, { force: true });
    const detail = stderr.trim();
    throw new Error(detail || (error instanceof Error ? error.message : String(error)));
  }
}

async function isJpegFile(filePath) {
  const handle = await open(filePath, "r");
  try {
    const signature = Buffer.alloc(3);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    return bytesRead === signature.length
      && signature[0] === 0xff
      && signature[1] === 0xd8
      && signature[2] === 0xff;
  } finally {
    await handle.close();
  }
}

async function generateLocalThumbnail(record, localPath) {
  const sourcePath = resolveArchivePath(record.path);
  const tempPath = `${localPath}.part-${process.pid}`;
  await rm(tempPath, { force: true });
  const child = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-ss", "0.25", "-i", sourcePath,
    "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", "-f", "image2pipe",
    "-vcodec", "mjpeg", "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await Promise.all([
      pipeline(child.stdout, createWriteStream(tempPath)),
      waitForChild(child),
    ]);
    const generated = await stat(tempPath);
    if (!generated.size) throw new Error("Thumbnail generation returned an empty image");
    await rename(tempPath, localPath);
    await pruneLiveCache();
    return localPath;
  } catch (error) {
    await rm(tempPath, { force: true });
    throw new Error(stderr.trim() || (error instanceof Error ? error.message : String(error)));
  }
}

function markActiveCacheFile(filePath) {
  if (path.dirname(path.resolve(filePath)) !== path.resolve(cacheDir)) return () => {};
  return activeCacheFiles.acquire(path.basename(filePath));
}

function pruneLiveCache() {
  if (cacheEvictionPromise) return cacheEvictionPromise;
  cacheEvictionPromise = (async () => {
    const directoryEntries = await readdir(cacheDir, { withFileTypes: true });
    const entries = await Promise.all(directoryEntries.map(async (entry) => {
      if (!entry.isFile()) return { name: entry.name, isFile: false, size: 0, mtimeMs: 0 };
      try {
        const fileStats = await stat(path.join(cacheDir, entry.name));
        return { name: entry.name, isFile: true, size: fileStats.size, mtimeMs: fileStats.mtimeMs };
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
    }));
    const protectedNames = activeCacheFiles.protectedNames();
    for (const entry of entries) {
      if (!entry) continue;
      for (const id of inflightCopies.keys()) {
        if (entry.name.startsWith(`${id}-`)) protectedNames.add(entry.name);
      }
      for (const id of inflightThumbnails.keys()) {
        if (entry.name === `thumb-${id}.jpg`) protectedNames.add(entry.name);
      }
    }
    const evictions = selectCacheEntriesForEviction(entries.filter(Boolean), {
      maxAgeMs: cacheMaxAgeMs,
      maxBytes: cacheMaxBytes,
      protectedNames,
    });
    await Promise.all(evictions.map((name) => rm(path.join(cacheDir, name), { force: true })));
  })().finally(() => {
    cacheEvictionPromise = null;
  });
  return cacheEvictionPromise;
}

function isNotModifiedSince(request, modifiedAtMs) {
  if (request.headers["if-none-match"]) return false;
  const value = Date.parse(String(request.headers["if-modified-since"] || ""));
  return Number.isFinite(value) && Math.trunc(modifiedAtMs / 1000) * 1000 <= value;
}

function resolveArchivePath(storedPath) {
  return resolveSafeArchivePath(storedPath, { archiveDownloads, remoteDownloads });
}

function isClientDisconnect(error, request, response) {
  const code = error && typeof error === "object" && "code" in error ? error.code : "";
  return request.destroyed
    || response.destroyed
    || code === "ERR_STREAM_PREMATURE_CLOSE"
    || code === "ECONNRESET";
}

async function loadArchiveCreatorRows() {
  const payload = await backendArchivePayload("/api/rewind/creators");
  if (!Array.isArray(payload.creators)) throw new Error("Backend returned invalid Rewind creator rows");
  return payload.creators;
}

async function loadArchiveVideoRows(options = {}) {
  const payload = await backendArchivePayload(buildRewindVideoReadPath(options));
  if (!Array.isArray(payload.videos)) throw new Error("Backend returned invalid Rewind video rows");
  return payload.videos;
}

async function loadArchivePostRows(options = {}) {
  const payload = await backendArchivePayload(buildRewindPostReadPath(options));
  if (!Array.isArray(payload.posts)) throw new Error("Backend returned invalid Rewind post rows");
  return payload.posts;
}

async function loadArchiveStats() {
  const payload = await backendArchivePayload("/api/rewind/stats");
  if (!payload.stats || typeof payload.stats !== "object") {
    throw new Error("Backend returned invalid Rewind archive statistics");
  }
  return payload.stats;
}

async function backendArchivePayload(requestPath) {
  const upstream = await remoteAdminRequest("GET", requestPath);
  let payload;
  try {
    payload = JSON.parse(upstream.body);
  } catch {
    throw new Error("Backend returned an invalid Rewind archive response");
  }
  if (upstream.status < 200 || upstream.status >= 300) {
    throw new Error(String(payload?.error || `Backend Rewind read failed (${upstream.status})`));
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Backend returned an invalid Rewind archive response");
  }
  return payload;
}

async function archivePythonJson(script) {
  const child = localMode
    ? spawn("python3", ["-"], { stdio: ["pipe", "pipe", "pipe"] })
    : spawn("ssh", sshArgs("python3 -"), {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(script);
  try {
    await waitForChild(child);
  } catch (error) {
    throw new Error(stderr.trim() || (error instanceof Error ? error.message : String(error)));
  }
  if (stderr.trim()) throw new Error(stderr.trim());
  return stdout.trim() ? JSON.parse(stdout) : {};
}

async function remoteAdminRequest(method, requestPath, body = "") {
  if (localMode) {
    const headers = {};
    if (body) headers["content-type"] = "application/json";
    if (importApiToken) headers.authorization = `Bearer ${importApiToken}`;
    const response = await fetch(`${backendUrl}${requestPath}`, {
      method,
      headers,
      body: body || undefined,
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type") || "",
      body: await response.text(),
    };
  }

  const script = [
    `const method = ${JSON.stringify(method)};`,
    `const requestPath = ${JSON.stringify(requestPath)};`,
    `const body = ${JSON.stringify(body)};`,
    "const port = process.env.HTTP_PORT || '8080';",
    "const response = await fetch(`http://127.0.0.1:${port}${requestPath}`, {",
    "  method,",
    "  headers: body ? { 'content-type': 'application/json' } : undefined,",
    "  body: body || undefined,",
    "});",
    "const responseBody = await response.text();",
    "process.stdout.write(JSON.stringify({",
    "  status: response.status,",
    "  contentType: response.headers.get('content-type') || '',",
    "  body: responseBody,",
    "}));",
  ].join("\n");
  const command = `docker compose -f ${shellQuote(`${remoteProject}/docker-compose.yml`)} exec -T tiktok-discord-downloader node --input-type=module -`;
  const child = spawn("ssh", sshArgs(command), { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(script);
  await waitForChild(child);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(stderr.trim() || "Remote admin API returned an invalid response");
  }
}

async function readBodyText(request, maxBytes = 16 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function sendUpstream(response, upstream) {
  response.writeHead(upstream.status, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(upstream.body),
    "Content-Type": upstream.contentType || "application/json; charset=utf-8",
  });
  response.end(upstream.body);
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Archive command exited with status ${code}`));
    });
  });
}

function sshArgs(command) {
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, command];
}

function parseRange(value, size) {
  if (!value) return undefined;
  const match = String(value).match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

function toCreator(row) {
  const username = String(row.username || "unknown");
  return {
    id: creatorKey(username),
    username,
    displayName: displayName(username),
    initials: initials(username),
    accent: creatorAccent(username),
    videoCount: Number(row.video_count || 0),
    storageLabel: formatBytes(Number(row.size_bytes || 0)),
    lastSynced: relativeTime(Number(row.latest_at || 0)),
    status: Number(row.failure_count || 0) > 0 ? "attention" : "healthy",
    enabled: Boolean(Number(row.enabled || 0)),
  };
}

function toVideo(row, request, metadata = {}) {
  const username = String(row.username || "unknown");
  const origin = requestOrigin(request);
  const createdAt = Number(row.created_at || Date.now());
  const postedAt = Number(metadata.timestamp || 0) > 0
    ? Number(metadata.timestamp) * 1000
    : createdAt;
  const originalDescription = String(metadata.description || "").trim();
  const caption = originalDescription || String(metadata.title || row.title || "").trim();
  const title = cleanTitle(caption, row.video_id, postedAt);
  return {
    id: String(row.id),
    creatorId: creatorKey(username),
    username,
    displayName: displayName(username),
    title,
    description: originalDescription,
    tags: normalizeTags(metadata.tags, originalDescription),
    mediaType: "video",
    videoUrl: `${origin}/media/${row.id}`,
    thumbnailUrl: `${origin}/thumbnail/${row.id}.jpg`,
    accent: creatorAccent(username),
    savedAt: new Date(createdAt).toISOString(),
    savedAtLabel: relativeTime(createdAt),
    duration: formatDuration(metadata.duration),
    sizeBytes: Number(row.size_bytes || 0),
    sizeLabel: formatBytes(Number(row.size_bytes || 0)),
    sourceUrl: String(row.source_url || "https://www.tiktok.com/"),
  };
}

function toPost(row, request) {
  const origin = requestOrigin(request);
  const platform = String(row.platform || "tiktok").toLowerCase();
  const username = String(row.creator_handle || row.username || "unknown");
  const createdAt = Number(row.created_at || Date.now());
  const publishedAt = Number(row.published_at || 0) || createdAt;
  const sourceAssets = postContentAssets(row);
  const assets = sourceAssets.map((asset, index) => ({
    id: asset.id == null ? `${row.id}:${index}` : String(asset.id),
    position: Number(asset.position ?? index),
    kind: normalizedMediaKind(asset.kind, asset.mime_type, asset.filename),
    mimeType: safeMediaContentType(asset.mime_type, asset.filename),
    mediaUrl: `${origin}/post-media/${row.id}/${index}`,
    filename: String(asset.filename || `asset-${index + 1}`),
    sizeBytes: Number(asset.size_bytes || 0),
    width: asset.width == null ? null : Number(asset.width),
    height: asset.height == null ? null : Number(asset.height),
    durationSeconds: asset.duration_seconds == null ? null : Number(asset.duration_seconds),
  }));
  const firstVisual = assets.find((asset) => asset.kind === "image" || asset.kind === "animated") || null;
  const description = String(row.description || "").trim();
  const groupId = Number(row.creator_group_id || 0);
  const profileId = Number(row.profile_id || 0);
  const creatorId = groupId
    ? `group:${groupId}`
    : profileId
      ? `profile:${profileId}`
      : `${platform}:${username.toLowerCase()}`;
  const durationSeconds = Number(row.duration_seconds || 0)
    || Math.max(0, ...assets.map((asset) => Number(asset.durationSeconds || 0)));
  return {
    id: String(row.id),
    platform,
    remoteId: String(row.remote_id || ""),
    creatorId,
    profileId: profileId || null,
    creatorGroupId: groupId || null,
    creatorGroupName: String(row.creator_group_name || ""),
    username,
    displayName: String(row.creator_display_name || "") || displayName(username),
    creatorProfileUrl: String(row.creator_profile_url || ""),
    title: cleanTitle(row.title, row.remote_id, publishedAt),
    description,
    tags: normalizeTags([], description),
    mediaType: normalizedPostMediaType(row.media_type, assets),
    assets,
    assetCount: assets.length,
    thumbnailUrl: firstVisual?.mediaUrl || "",
    downloadUrl: `${origin}/post-download/${row.id}`,
    accent: creatorAccent(`${platform}:${username}`),
    savedAt: new Date(createdAt).toISOString(),
    savedAtLabel: relativeTime(createdAt),
    publishedAt: new Date(publishedAt).toISOString(),
    trashedAt: Number(row.trashed_at || 0) > 0 ? new Date(Number(row.trashed_at)).toISOString() : "",
    retentionStatus: String(row.retention_status || "active"),
    duration: formatDuration(durationSeconds),
    durationSeconds,
    sizeBytes: Number(row.size_bytes || 0),
    sizeLabel: formatBytes(Number(row.size_bytes || 0)),
    sourceUrl: String(row.canonical_url || row.source_url || ""),
    bookmarked: Boolean(Number(row.bookmarked || 0)),
  };
}

function requestOrigin(request) {
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProtocol || (request.socket.encrypted ? "https" : "http");
  return publicBaseUrl || `${protocol}://${request.headers.host || `127.0.0.1:${port}`}`;
}

function postContentAssets(row) {
  const assets = Array.isArray(row?.assets) ? row.assets : [];
  const content = assets.filter((asset) => asset?.role === "content" || asset?.role === "primary");
  return content.length ? content : assets.filter((asset) => asset && typeof asset === "object");
}

function normalizedPostMediaType(value, assets) {
  const explicit = String(value || "").trim().toLowerCase();
  if (["video", "image", "animated", "gallery", "carousel", "mixed", "archive", "slideshow", "story"].includes(explicit)) {
    return explicit === "carousel" ? "gallery" : explicit;
  }
  const kinds = new Set(assets.map((asset) => asset.kind).filter(Boolean));
  if (assets.length > 1 && kinds.size > 1) return "mixed";
  if (assets.length > 1) return "gallery";
  return assets[0]?.kind || "archive";
}

function normalizedMediaKind(value, mimeType, filename) {
  const explicit = String(value || "").trim().toLowerCase();
  if (["video", "image", "animated", "archive"].includes(explicit)) return explicit;
  const contentType = safeMediaContentType(mimeType, filename);
  if (contentType.startsWith("video/")) return "video";
  if (contentType === "image/gif") return "animated";
  if (contentType.startsWith("image/")) return "image";
  return "archive";
}

function safeMediaContentType(value, filename = "") {
  const allowed = new Set([
    "application/octet-stream",
    "application/zip",
    "image/avif",
    "image/gif",
    "image/heic",
    "image/jpeg",
    "image/png",
    "image/webp",
    "video/mp4",
    "video/quicktime",
    "video/webm",
    "video/x-m4v",
    "video/x-matroska",
  ]);
  const supplied = String(value || "").trim().toLowerCase();
  if (allowed.has(supplied) && supplied !== "application/octet-stream") return supplied;
  const extension = path.extname(String(filename || "")).toLowerCase();
  return {
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".m4v": "video/x-m4v",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".mp4": "video/mp4",
    ".png": "image/png",
    ".webm": "video/webm",
    ".webp": "image/webp",
    ".zip": "application/zip",
  }[extension] || "application/octet-stream";
}

function normalizeTags(rawTags, description) {
  const explicit = Array.isArray(rawTags) ? rawTags : [];
  const extracted = String(description || "").match(/#[\p{L}\p{N}_]+/gu) || [];
  return [...new Set([...explicit, ...extracted]
    .map((tag) => String(tag).replace(/^#/, "").trim())
    .filter(Boolean))]
    .slice(0, 16);
}

function formatDuration(value) {
  const seconds = Math.max(0, Math.round(Number(value || 0)));
  if (!seconds) return "--:--";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function cleanTitle(value, videoId, createdAt) {
  const title = String(value || "").replace(/\.mp4$/i, "").trim();
  const isPlaceholder = !title
    || title === String(videoId || "")
    || /^TikTok (?:video|story)(?: #?\d+)?$/i.test(title)
    || /^Story #?\d+$/i.test(title)
    || /^\d{10,}$/.test(title);
  if (isPlaceholder) {
    return new Intl.DateTimeFormat("en", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(createdAt));
  }
  return title;
}

function creatorKey(username) {
  return String(username || "unknown").trim().toLowerCase() || "unknown";
}

function legacyCreatorKey(username) {
  return String(username || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function displayName(username) {
  return String(username || "unknown")
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function initials(username) {
  const parts = String(username || "?").split(/[._-]+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || "?").toUpperCase();
}

function creatorAccent(username) {
  const palette = ["#ff866e", "#75e6d8", "#c9ff4a", "#a99cff", "#ffcf66", "#79a9ff", "#ef8fc5"];
  let hash = 0;
  for (const char of String(username)) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

function relativeTime(timestamp) {
  if (!timestamp) return "Never";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} hr ago`;
  const days = Math.floor(seconds / 86_400);
  return days === 1 ? "Yesterday" : `${days} days ago`;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function createTaskLimiter(maxConcurrent) {
  const limit = Math.max(1, positiveInteger(maxConcurrent, 1));
  const queue = [];
  let active = 0;

  function runNext() {
    while (active < limit && queue.length) {
      const entry = queue.shift();
      active += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          runNext();
        });
    }
  }

  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    runNext();
  });
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function applyCors(response, origin) {
  const allowed = isAllowedCorsOrigin(origin, { publicBaseUrl });
  if (origin && allowed) response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Range");
  response.setHeader("Vary", "Origin");
  return allowed;
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..");
const cacheDir = path.join(projectDir, ".live-cache");
const host = process.env.LIVE_SSH_HOST || "yufeihl";
const port = positiveInteger(process.env.LIVE_BRIDGE_PORT, 8787);
const remoteProject = process.env.LIVE_REMOTE_PROJECT || "/home/yufei/tiktok-discord-downloader";
const remoteDb = `${remoteProject}/data/state.db`;
const remoteDownloads = `${remoteProject}/data/downloads`;
const inflightCopies = new Map();
const inflightThumbnails = new Map();
let videoCache = { loadedAt: 0, rows: [] };
let metadataCache = { loadedAt: 0, byId: {} };

const VIDEO_SQL = `
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
  ORDER BY files.created_at DESC, files.id DESC
  LIMIT 500;
`;

const CREATOR_SQL = `
  WITH saved AS (
    SELECT
      lower(username) AS username_key,
      username,
      COUNT(*) AS video_count,
      SUM(size_bytes) AS size_bytes,
      MAX(created_at) AS latest_created_at
    FROM files
    WHERE username IS NOT NULL
      AND username <> ''
      AND lower(filename) LIKE '%.mp4'
    GROUP BY lower(username)
  )
  SELECT
    watched_users.username,
    COALESCE(saved.video_count, 0) AS video_count,
    COALESCE(saved.size_bytes, 0) AS size_bytes,
    COALESCE(saved.latest_created_at, watched_users.last_success_at, watched_users.created_at) AS latest_at,
    watched_users.failure_count,
    1 AS enabled
  FROM watched_users
  LEFT JOIN saved ON saved.username_key = lower(watched_users.username)
  UNION ALL
  SELECT
    saved.username,
    saved.video_count,
    saved.size_bytes,
    saved.latest_created_at AS latest_at,
    0 AS failure_count,
    0 AS enabled
  FROM saved
  WHERE NOT EXISTS (
    SELECT 1 FROM watched_users WHERE lower(watched_users.username) = saved.username_key
  )
  ORDER BY video_count DESC, username ASC;
`;

const STATS_SQL = `
  SELECT
    (
      SELECT COUNT(*)
      FROM (
        SELECT lower(username) AS username_key FROM watched_users
        UNION
        SELECT lower(username) AS username_key
        FROM files
        WHERE username <> '' AND lower(filename) LIKE '%.mp4'
      )
    ) AS creator_count,
    (SELECT COUNT(*) FROM files WHERE lower(filename) LIKE '%.mp4') AS video_count,
    (SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE lower(filename) LIKE '%.mp4') AS size_bytes,
    (
      SELECT COUNT(*)
      FROM files
      WHERE lower(filename) LIKE '%.mp4'
        AND created_at >= (unixepoch('now', '-7 days') * 1000)
    ) AS new_this_week;
`;

await mkdir(cacheDir, { recursive: true });

const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin || "";
  applyCors(response, origin);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `127.0.0.1:${port}`}`);

    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { status: "ok", host });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/creators") {
      const rows = await remoteSql(CREATOR_SQL);
      sendJson(response, 200, rows.map(toCreator));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/videos") {
      const limit = Math.min(500, positiveInteger(url.searchParams.get("limit"), 100));
      const creatorId = String(url.searchParams.get("creatorId") || "").toLowerCase();
      const rows = await loadVideoRows();
      const metadataById = await loadMetadataIndex();
      const filtered = creatorId
        ? rows.filter((row) => creatorKey(row.username) === creatorId || String(row.username).toLowerCase() === creatorId)
        : rows;
      sendJson(response, 200, filtered.slice(0, limit).map((row) => (
        toVideo(row, request, metadataById[String(row.video_id || "")] || {})
      )));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/stats") {
      const [row = {}] = await remoteSql(STATS_SQL);
      const sizeBytes = Number(row.size_bytes || 0);
      sendJson(response, 200, {
        creatorCount: Number(row.creator_count || 0),
        videoCount: Number(row.video_count || 0),
        storageUsed: formatBytes(sizeBytes),
        storagePercent: Math.min(100, Math.round((sizeBytes / (10 * 1024 ** 3)) * 100)),
        newThisWeek: Number(row.new_this_week || 0),
      });
      return;
    }

    const mediaMatch = url.pathname.match(/^\/media\/(\d+)$/);
    if ((request.method === "GET" || request.method === "HEAD") && mediaMatch) {
      await serveMedia(request, response, Number(mediaMatch[1]));
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
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    } else {
      response.destroy(error instanceof Error ? error : undefined);
    }
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[live-bridge] Live archive available at http://127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

async function loadVideoRows({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - videoCache.loadedAt < 15_000) return videoCache.rows;
  const rows = await remoteSql(VIDEO_SQL);
  videoCache = { loadedAt: now, rows };
  return rows;
}

async function loadMetadataIndex({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - metadataCache.loadedAt < 60_000) return metadataCache.byId;
  const encodedRoot = Buffer.from(remoteDownloads, "utf8").toString("base64");
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
  const byId = await remotePythonJson(script);
  metadataCache = { loadedAt: now, byId };
  return byId;
}

async function serveMedia(request, response, fileId) {
  const rows = await loadVideoRows();
  const record = rows.find((row) => Number(row.id) === fileId);
  if (!record) {
    sendJson(response, 404, { error: "Video not found" });
    return;
  }

  const localPath = await ensureCached(record);
  const fileStats = await stat(localPath);
  const range = parseRange(request.headers.range, fileStats.size);
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-cache",
    "Content-Type": "video/mp4",
  };

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
}

async function serveThumbnail(request, response, fileId) {
  const rows = await loadVideoRows();
  const record = rows.find((row) => Number(row.id) === fileId);
  if (!record) {
    sendJson(response, 404, { error: "Video not found" });
    return;
  }

  const thumbnailPath = await ensureThumbnail(record);
  const thumbnailStats = await stat(thumbnailPath);
  response.writeHead(200, {
    "Cache-Control": "private, max-age=3600",
    "Content-Length": String(thumbnailStats.size),
    "Content-Type": "image/jpeg",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  await pipeline(createReadStream(thumbnailPath), response);
}

async function ensureCached(record) {
  const safeName = String(record.filename || `${record.id}.mp4`).replace(/[^A-Za-z0-9._-]/g, "_");
  const localPath = path.join(cacheDir, `${record.id}-${safeName}`);
  const expectedSize = Number(record.size_bytes || 0);

  try {
    const existing = await stat(localPath);
    if (!expectedSize || existing.size === expectedSize) return localPath;
  } catch {
    // Cache miss.
  }

  if (inflightCopies.has(record.id)) return inflightCopies.get(record.id);
  const copyPromise = copyFromRemote(record, localPath).finally(() => inflightCopies.delete(record.id));
  inflightCopies.set(record.id, copyPromise);
  return copyPromise;
}

async function copyFromRemote(record, localPath) {
  const sourcePath = resolveRemotePath(record.path);
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
      throw new Error(`Video copy was incomplete (${copied.size}/${expectedSize} bytes)`);
    }
    await rename(tempPath, localPath);
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
  const thumbnailPromise = copyThumbnailFromRemote(record, localPath)
    .finally(() => inflightThumbnails.delete(record.id));
  inflightThumbnails.set(record.id, thumbnailPromise);
  return thumbnailPromise;
}

async function copyThumbnailFromRemote(record, localPath) {
  const sourcePath = resolveRemotePath(record.path);
  const relativePath = path.posix.relative(remoteDownloads, sourcePath);
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
    return localPath;
  } catch (error) {
    await rm(tempPath, { force: true });
    const detail = stderr.trim();
    throw new Error(detail || (error instanceof Error ? error.message : String(error)));
  }
}

function resolveRemotePath(storedPath) {
  const normalized = path.posix.normalize(String(storedPath || ""));
  let relative;
  if (normalized.startsWith("/app/data/downloads/")) {
    relative = normalized.slice("/app/data/downloads/".length);
  } else if (normalized.startsWith(`${remoteDownloads}/`)) {
    relative = normalized.slice(remoteDownloads.length + 1);
  } else {
    throw new Error("Refusing to read a media path outside the download archive");
  }
  if (!relative || relative.startsWith("../") || relative.includes("/../")) {
    throw new Error("Invalid media path");
  }
  return path.posix.join(remoteDownloads, relative);
}

function isClientDisconnect(error, request, response) {
  const code = error && typeof error === "object" && "code" in error ? error.code : "";
  return request.destroyed
    || response.destroyed
    || code === "ERR_STREAM_PREMATURE_CLOSE"
    || code === "ECONNRESET";
}

async function remoteSql(sql) {
  const child = spawn("ssh", sshArgs(`sqlite3 -readonly -json ${remoteDb}`), {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(sql);
  await waitForChild(child);
  if (stderr.trim()) throw new Error(stderr.trim());
  return stdout.trim() ? JSON.parse(stdout) : [];
}

async function remotePythonJson(script) {
  const child = spawn("ssh", sshArgs("python3 -"), {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(script);
  await waitForChild(child);
  if (stderr.trim()) throw new Error(stderr.trim());
  return stdout.trim() ? JSON.parse(stdout) : {};
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`SSH command exited with status ${code}`));
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
  const origin = `http://${request.headers.host || `127.0.0.1:${port}`}`;
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
    sizeLabel: formatBytes(Number(row.size_bytes || 0)),
    sourceUrl: String(row.source_url || "https://www.tiktok.com/"),
  };
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

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function applyCors(response, origin) {
  const allowed = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  response.setHeader("Access-Control-Allow-Origin", allowed ? origin : "http://localhost:3000");
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  response.setHeader("Vary", "Origin");
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

import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_LEGACY_VIDEO_LIMIT,
  buildVideoSql,
  createActiveFileTracker,
  createBoundedRowCache,
  createExpiringSingleFlight,
  decodeVideoCursor,
  encodeVideoCursor,
  isTrashSchemaMigrationError,
  matchImportProxyRoute,
  matchesIfNoneMatch,
  resolveArchivePath,
  selectCacheEntriesForEviction,
  thumbnailSidecarCandidates,
} from "../scripts/live-bridge-core.mjs";

const roots = {
  archiveDownloads: "/app/data/downloads",
  remoteDownloads: "/home/rewind/data/downloads",
};

test("video cursors round-trip stable keyset positions", () => {
  const encoded = encodeVideoCursor({ created_at: 1_752_000_000_123, id: 847 });
  assert.deepEqual(decodeVideoCursor(encoded), {
    createdAt: 1_752_000_000_123,
    fileId: 847,
  });
  assert.throws(() => decodeVideoCursor("not+a+cursor"), /Invalid video cursor/);
  assert.throws(() => decodeVideoCursor(Buffer.from("[1,0]").toString("base64url")), /Invalid video cursor/);
});

test("video SQL is bounded, keyset-paginated, creator-safe, index-compatible, and excludes trash", () => {
  const sql = buildVideoSql({
    username: "d'angelo",
    limit: MAX_LEGACY_VIDEO_LIMIT + 500,
    cursor: { createdAt: 4000, fileId: 25 },
  });
  assert.match(sql, /files\.trashed_at IS NULL/);
  assert.match(sql, /files\.username = 'd''angelo' COLLATE NOCASE/);
  assert.doesNotMatch(sql, /lower\(files\.username\)/);
  assert.match(sql, /files\.created_at < 4000/);
  assert.match(sql, /files\.created_at = 4000 AND files\.id < 25/);
  assert.match(sql, /LIMIT 5000/);
});

test("concurrent expiring refreshes share one archive scan", async () => {
  let scans = 0;
  let finishScan;
  const scan = createExpiringSingleFlight(
    () => {
      scans += 1;
      return new Promise((resolve) => { finishScan = resolve; });
    },
    { ttlMs: 60_000 },
  );
  const first = scan();
  const second = scan();
  await Promise.resolve();
  assert.equal(scans, 1);
  finishScan({ "video-1": { title: "One" } });
  assert.deepEqual(await Promise.all([first, second]), [
    { "video-1": { title: "One" } },
    { "video-1": { title: "One" } },
  ]);
  assert.equal(scans, 1);
  assert.deepEqual(await scan(), { "video-1": { title: "One" } });
});

test("returned video rows satisfy every ID lookup without exact SQL and stay bounded", async () => {
  const cache = createBoundedRowCache(3);
  const returned = [{ id: 1 }, { id: 2 }, { id: 3 }];
  cache.add(returned);
  let exactLookups = 0;
  const find = async (id) => cache.get(id) || (++exactLookups && null);
  assert.deepEqual(await Promise.all(returned.map(({ id }) => find(id))), returned);
  assert.equal(exactLookups, 0);
  cache.add([{ id: 4 }]);
  assert.equal(cache.size, 3);
  assert.equal(cache.get(1), undefined);
});

test("cache eviction enforces age and size bounds without touching in-flight or partial files", () => {
  const now = 1_000_000;
  const entries = [
    { name: "expired.mp4", size: 2, mtimeMs: 1, isFile: true },
    { name: "oldest.mp4", size: 6, mtimeMs: 800_000, isFile: true },
    { name: "newest.mp4", size: 6, mtimeMs: 900_000, isFile: true },
    { name: "inflight.mp4", size: 50, mtimeMs: 1, isFile: true },
    { name: "copy.mp4.part-123", size: 50, mtimeMs: 1, isFile: true },
  ];
  assert.deepEqual(selectCacheEntriesForEviction(entries, {
    maxAgeMs: 500_000,
    maxBytes: 56,
    now,
    protectedNames: new Set(["inflight.mp4"]),
  }), ["expired.mp4", "oldest.mp4"]);
});

test("active cache files remain protected until every serving stream releases them", () => {
  const tracker = createActiveFileTracker();
  const releaseFirst = tracker.acquire("video.mp4");
  const releaseSecond = tracker.acquire("video.mp4");
  assert.deepEqual([...tracker.protectedNames()], ["video.mp4"]);
  releaseFirst();
  assert.deepEqual([...tracker.protectedNames()], ["video.mp4"]);
  releaseFirst();
  assert.deepEqual([...tracker.protectedNames()], ["video.mp4"]);
  releaseSecond();
  assert.deepEqual([...tracker.protectedNames()], []);
});

test("thumbnail validators use HTTP weak comparison, lists, and wildcards", () => {
  const etag = '"42-100-9000"';
  assert.equal(matchesIfNoneMatch(etag, etag), true);
  assert.equal(matchesIfNoneMatch(`"other", W/${etag}`, etag), true);
  assert.equal(matchesIfNoneMatch("*", etag), true);
  assert.equal(matchesIfNoneMatch('W/"different"', etag), false);
  assert.equal(matchesIfNoneMatch("", etag), false);
});

test("archive paths accept known mount roots and reject traversal or prefix lookalikes", () => {
  assert.equal(
    resolveArchivePath("/home/rewind/data/downloads/alice/123.mp4", roots),
    "/app/data/downloads/alice/123.mp4",
  );
  assert.equal(
    resolveArchivePath("/app/data/downloads/alice/123.mp4", roots),
    "/app/data/downloads/alice/123.mp4",
  );
  assert.throws(
    () => resolveArchivePath("/app/data/downloads-evil/alice/123.mp4", roots),
    /outside the download archive/,
  );
  assert.throws(
    () => resolveArchivePath("/app/data/downloads/../../etc/passwd", roots),
    /outside the download archive/,
  );
});

test("thumbnail candidates stay beside the media file and prefer the .image convention", () => {
  assert.deepEqual(
    thumbnailSidecarCandidates("/app/data/downloads/alice/123.mp4", roots),
    [
      "/app/data/downloads/alice/123.image",
      "/app/data/downloads/alice/123.jpg",
      "/app/data/downloads/alice/123.jpeg",
    ],
  );
});

test("trash-schema startup races have a dedicated error classification", () => {
  assert.equal(isTrashSchemaMigrationError(new Error("no such column: files.trashed_at")), true);
  assert.equal(isTrashSchemaMigrationError(new Error("database is locked")), false);
});

test("import proxy routes allow only the backend contract methods", () => {
  assert.deepEqual(matchImportProxyRoute("/api/imports", "GET"), { allowed: true, readsBody: false });
  assert.deepEqual(matchImportProxyRoute("/api/imports", "POST"), { allowed: true, readsBody: true });
  assert.deepEqual(matchImportProxyRoute("/api/imports/42", "GET"), { allowed: true, readsBody: false });
  assert.deepEqual(matchImportProxyRoute("/api/imports/42", "POST"), { allowed: false, readsBody: false });
  assert.deepEqual(matchImportProxyRoute("/api/imports/42/cancel", "POST"), { allowed: true, readsBody: true });
  assert.deepEqual(matchImportProxyRoute("/api/imports/42/retry", "POST"), { allowed: true, readsBody: true });
  assert.deepEqual(matchImportProxyRoute("/api/imports/42/retry", "GET"), { allowed: false, readsBody: false });
  assert.equal(matchImportProxyRoute("/api/imports/not-an-id/cancel", "POST"), null);
});

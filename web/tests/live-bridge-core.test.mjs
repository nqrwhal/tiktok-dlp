import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_LEGACY_VIDEO_LIMIT,
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

test("backend video reads are bounded and encode keyset, creator, and bookmark filters", () => {
  const requestPath = buildRewindVideoReadPath({
    username: "d'angelo",
    limit: MAX_LEGACY_VIDEO_LIMIT + 500,
    cursor: { createdAt: 4000, fileId: 25 },
    bookmarkedOnly: true,
  });
  const url = new URL(requestPath, "http://backend.test");
  assert.equal(url.pathname, "/api/rewind/videos");
  assert.equal(url.searchParams.get("username"), "d'angelo");
  assert.equal(url.searchParams.get("limit"), "5001");
  assert.equal(url.searchParams.get("beforeCreatedAt"), "4000");
  assert.equal(url.searchParams.get("beforeFileId"), "25");
  assert.equal(url.searchParams.get("bookmarked"), "1");
});

test("backend post reads preserve platform, profile, group, cursor, and bookmark filters", () => {
  const requestPath = buildRewindPostReadPath({
    platform: "Instagram",
    username: "creator.one",
    profileId: 7,
    groupId: 9,
    fileId: 11,
    limit: MAX_PAGINATED_POST_LIMIT + 500,
    cursor: { createdAt: 5000, fileId: 25 },
    bookmarkedOnly: true,
    trashedOnly: true,
  });
  const url = new URL(requestPath, "http://backend.test");
  assert.equal(url.pathname, "/api/rewind/posts");
  assert.equal(url.searchParams.get("platform"), "instagram");
  assert.equal(url.searchParams.get("username"), "creator.one");
  assert.equal(url.searchParams.get("profileId"), "7");
  assert.equal(url.searchParams.get("groupId"), "9");
  assert.equal(url.searchParams.get("fileId"), "11");
  assert.equal(url.searchParams.get("limit"), "101");
  assert.equal(url.searchParams.get("beforeCreatedAt"), "5000");
  assert.equal(url.searchParams.get("beforeFileId"), "25");
  assert.equal(url.searchParams.get("bookmarked"), "1");
  assert.equal(url.searchParams.get("trashed"), "1");
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

test("row cache entries expire so out-of-band lifecycle changes require an authoritative read", () => {
  let now = 1_000;
  const cache = createBoundedRowCache(3, { ttlMs: 50, now: () => now });
  const row = { id: 1, retention_status: "active" };
  cache.add([row]);
  now = 1_049;
  assert.equal(cache.get(1), row);
  now = 1_050;
  assert.equal(cache.get(1), undefined);
  assert.equal(cache.size, 0);
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
  assert.equal(isTrashSchemaMigrationError(new Error("no such column: files.platform")), true);
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

test("creator monitoring proxy route allows only DELETE", () => {
  assert.deepEqual(
    matchCreatorMonitoringProxyRoute("/api/creators/alice.archive/monitoring", "DELETE"),
    { allowed: true },
  );
  assert.deepEqual(
    matchCreatorMonitoringProxyRoute("/api/creators/alice.archive/monitoring", "POST"),
    { allowed: false },
  );
  assert.equal(matchCreatorMonitoringProxyRoute("/api/creators/alice.archive/videos", "DELETE"), null);
  assert.equal(matchCreatorMonitoringProxyRoute("/api/creators/alice/archive/monitoring", "DELETE"), null);
});

test("profile group proxy routes expose only explicit management methods", () => {
  assert.deepEqual(matchProfileGroupsProxyRoute("/api/profile-groups", "GET"), {
    allowed: true,
    readsBody: false,
  });
  assert.deepEqual(matchProfileGroupsProxyRoute("/api/profile-groups", "POST"), {
    allowed: true,
    readsBody: true,
  });
  assert.deepEqual(matchProfileGroupsProxyRoute("/api/profile-groups", "DELETE"), {
    allowed: false,
    readsBody: false,
  });
  assert.deepEqual(matchProfileGroupsProxyRoute("/api/profile-groups/12", "PATCH"), {
    allowed: true,
    readsBody: true,
  });
  assert.deepEqual(matchProfileGroupsProxyRoute("/api/profile-groups/12", "GET"), {
    allowed: false,
    readsBody: false,
  });
  assert.deepEqual(matchProfileGroupsProxyRoute("/api/profile-groups/12/profiles/8", "DELETE"), {
    allowed: true,
    readsBody: false,
  });
  assert.deepEqual(matchProfileGroupsProxyRoute("/api/profile-groups/12/profiles/8", "PATCH"), {
    allowed: false,
    readsBody: false,
  });
  assert.equal(matchProfileGroupsProxyRoute("/api/profile-groups/not-an-id", "PATCH"), null);
});

test("post bookmark proxy routes allow only an exact numeric mutation", () => {
  assert.deepEqual(matchPostBookmarkProxyRoute("/api/post-bookmarks/42", "PUT"), {
    allowed: true,
    fileId: 42,
  });
  assert.deepEqual(matchPostBookmarkProxyRoute("/api/post-bookmarks/42", "DELETE"), {
    allowed: true,
    fileId: 42,
  });
  assert.deepEqual(matchPostBookmarkProxyRoute("/api/post-bookmarks/42", "GET"), {
    allowed: false,
    fileId: 42,
  });
  assert.equal(matchPostBookmarkProxyRoute("/api/post-bookmarks/not-an-id", "PUT"), null);
  assert.equal(matchPostBookmarkProxyRoute("/api/post-bookmarks/42/extra", "PUT"), null);
});

test("media post lifecycle proxy routes expose only confirmed trash and restore methods", () => {
  assert.deepEqual(matchMediaPostMutationProxyRoute("/api/media-posts/42", "DELETE"), {
    allowed: true,
    fileId: 42,
    readsBody: true,
  });
  assert.deepEqual(matchMediaPostMutationProxyRoute("/api/media-posts/42", "PUT"), {
    allowed: false,
    fileId: 42,
    readsBody: false,
  });
  assert.deepEqual(matchMediaPostMutationProxyRoute("/api/media-posts/42/restore", "POST"), {
    allowed: true,
    fileId: 42,
    readsBody: true,
  });
  assert.deepEqual(matchMediaPostMutationProxyRoute("/api/media-posts/42/restore", "DELETE"), {
    allowed: false,
    fileId: 42,
    readsBody: false,
  });
  assert.equal(matchMediaPostMutationProxyRoute("/api/media-posts/not-an-id", "DELETE"), null);
});

test("CORS accepts the configured app and exact loopback origins without hostname lookalikes", () => {
  const options = { publicBaseUrl: "https://rewind.example.com/app" };
  assert.equal(isAllowedCorsOrigin("", options), true);
  assert.equal(isAllowedCorsOrigin("https://rewind.example.com", options), true);
  assert.equal(isAllowedCorsOrigin("http://localhost:3000", options), true);
  assert.equal(isAllowedCorsOrigin("http://127.0.0.1:8787", options), true);
  assert.equal(isAllowedCorsOrigin("http://[::1]:8787", options), true);
  assert.equal(isAllowedCorsOrigin("https://rewind.example.com.evil.test", options), false);
  assert.equal(isAllowedCorsOrigin("http://localhost.evil.test", options), false);
  assert.equal(isAllowedCorsOrigin("null", options), false);
  assert.equal(isAllowedCorsOrigin("https://other.example.com", options), false);
  assert.equal(isAllowedCorsOrigin("https://rewind.example.com", {
    ...options,
    allowLoopback: false,
  }), true);
  assert.equal(isAllowedCorsOrigin("http://localhost:3000", {
    ...options,
    allowLoopback: false,
  }), false);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_LEGACY_VIDEO_LIMIT,
  buildVideoSql,
  decodeVideoCursor,
  encodeVideoCursor,
  isTrashSchemaMigrationError,
  matchImportProxyRoute,
  resolveArchivePath,
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

test("video SQL is bounded, keyset-paginated, creator-safe, and excludes trash", () => {
  const sql = buildVideoSql({
    username: "d'angelo",
    limit: MAX_LEGACY_VIDEO_LIMIT + 500,
    cursor: { createdAt: 4000, fileId: 25 },
  });
  assert.match(sql, /files\.trashed_at IS NULL/);
  assert.match(sql, /lower\('d''angelo'\)/);
  assert.match(sql, /files\.created_at < 4000/);
  assert.match(sql, /files\.created_at = 4000 AND files\.id < 25/);
  assert.match(sql, /LIMIT 5000/);
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

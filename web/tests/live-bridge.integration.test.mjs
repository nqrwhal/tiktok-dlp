import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

test("live bridge paginates active videos and serves an existing .image sidecar", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "rewind-bridge-"));
  const downloads = path.join(fixture, "downloads");
  const creatorDir = path.join(downloads, "alice");
  const database = path.join(fixture, "state.db");
  const port = await availablePort();
  await mkdir(creatorDir, { recursive: true });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  for (let id = 1; id <= 5; id += 1) {
    await writeFile(path.join(creatorDir, `${id}.mp4`), `not-a-real-video-${id}`);
  }
  await writeFile(path.join(creatorDir, "1.image"), jpeg);

  const sqlite = spawnSync("sqlite3", [database], {
    encoding: "utf8",
    input: `
      CREATE TABLE files (
        id INTEGER PRIMARY KEY,
        video_id TEXT,
        username TEXT,
        source_url TEXT,
        path TEXT,
        filename TEXT,
        size_bytes INTEGER,
        created_at INTEGER,
        trashed_at INTEGER
      );
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY,
        file_id INTEGER,
        title TEXT,
        created_at INTEGER
      );
      CREATE TABLE bookmarks (
        file_id INTEGER PRIMARY KEY,
        created_at INTEGER
      );
      INSERT INTO files VALUES
        (1, 'video-1', 'alice', 'https://example.com/1', '/app/data/downloads/alice/1.mp4', '1.mp4', 16, 100, NULL),
        (2, 'video-2', 'alice', 'https://example.com/2', '/app/data/downloads/alice/2.mp4', '2.mp4', 16, 200, NULL),
        (3, 'video-3', 'alice', 'https://example.com/3', '/app/data/downloads/alice/3.mp4', '3.mp4', 16, 300, NULL),
        (4, 'video-4', 'alice', 'https://example.com/4', '/app/data/downloads/alice/4.mp4', '4.mp4', 16, 400, NULL),
        (5, 'video-5', 'alice', 'https://example.com/5', '/app/data/downloads/alice/5.mp4', '5.mp4', 16, 500, 600);
      INSERT INTO bookmarks VALUES (2, 1000);
    `,
  });
  assert.equal(sqlite.status, 0, sqlite.stderr);

  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/live-bridge.mjs", import.meta.url))], {
    env: {
      ...process.env,
      LIVE_LOCAL_MODE: "1",
      LIVE_BRIDGE_HOST: "127.0.0.1",
      LIVE_BRIDGE_PORT: String(port),
      LIVE_DB_PATH: database,
      LIVE_DOWNLOADS_PATH: downloads,
      LIVE_CACHE_PATH: path.join(fixture, "cache"),
      LIVE_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { childOutput += chunk; });
  child.stderr.on("data", (chunk) => { childOutput += chunk; });
  context.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "close");
    }
    await rm(fixture, { recursive: true, force: true });
  });

  await waitForBridge(port, child, () => childOutput);
  const firstResponse = await fetch(`http://127.0.0.1:${port}/api/videos?page=1&limit=2`);
  assert.equal(firstResponse.status, 200);
  const firstPage = await firstResponse.json();
  assert.deepEqual(firstPage.items.map((video) => video.id), ["4", "3"]);
  assert.equal(typeof firstPage.nextCursor, "string");

  const secondResponse = await fetch(
    `http://127.0.0.1:${port}/api/videos?page=1&limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
  );
  const secondPage = await secondResponse.json();
  assert.equal(secondResponse.status, 200, `${JSON.stringify(secondPage)}\n${childOutput}`);
  assert.deepEqual(secondPage.items.map((video) => video.id), ["2", "1"]);
  assert.equal(secondPage.nextCursor, null);

  const offlineDatabase = `${database}.offline`;
  await rename(database, offlineDatabase);
  for (const id of [...firstPage.items, ...secondPage.items].map((video) => video.id)) {
    const cachedMedia = await fetch(`http://127.0.0.1:${port}/media/${id}`, { method: "HEAD" });
    assert.equal(cachedMedia.status, 200, `returned ID ${id} triggered an exact SQL lookup\n${childOutput}`);
  }
  await rename(offlineDatabase, database);

  const exactResponse = await fetch(`http://127.0.0.1:${port}/api/videos?page=1&limit=2&fileId=1`);
  const exactPage = await exactResponse.json();
  assert.equal(exactPage.items[0].id, "1");

  const legacyResponse = await fetch(`http://127.0.0.1:${port}/api/videos?limit=2`);
  assert.equal(Array.isArray(await legacyResponse.json()), true);

  const bookmarkedResponse = await fetch(`http://127.0.0.1:${port}/api/videos?bookmarked=1&limit=10`);
  assert.equal(bookmarkedResponse.status, 200);
  assert.deepEqual((await bookmarkedResponse.json()).map((video) => video.id), ["2"]);

  const mediaResponse = await fetch(`http://127.0.0.1:${port}/media/2`, {
    headers: { range: "bytes=0-3" },
  });
  assert.equal(mediaResponse.status, 206);
  assert.match(mediaResponse.headers.get("cache-control") || "", /max-age=604800/);
  assert.match(mediaResponse.headers.get("cache-control") || "", /no-transform/);

  const thumbnailResponse = await fetch(`http://127.0.0.1:${port}/thumbnail/1.jpg`);
  const thumbnailBody = Buffer.from(await thumbnailResponse.arrayBuffer());
  assert.equal(thumbnailResponse.status, 200, `${thumbnailBody.toString()}\n${childOutput}`);
  assert.equal(thumbnailResponse.headers.get("content-type"), "image/jpeg");
  assert.match(thumbnailResponse.headers.get("cache-control") || "", /max-age=31536000/);
  assert.match(thumbnailResponse.headers.get("cache-control") || "", /immutable/);
  const thumbnailEtag = thumbnailResponse.headers.get("etag");
  assert(thumbnailEtag);
  assert.deepEqual(thumbnailBody, jpeg);
  const validatedThumbnail = await fetch(`http://127.0.0.1:${port}/thumbnail/1.jpg`, {
    headers: { "if-none-match": `"unrelated", W/${thumbnailEtag}` },
  });
  assert.equal(validatedThumbnail.status, 304);
  assert.equal((await validatedThumbnail.arrayBuffer()).byteLength, 0);

});

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function waitForBridge(port, child, output) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Bridge exited early:\n${output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // The child has not bound the port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Bridge did not start:\n${output()}`);
}

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

test("live bridge paginates active videos and serves an existing .image sidecar", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "rewind-bridge-"));
  const downloads = path.join(fixture, "downloads");
  const creatorDir = path.join(downloads, "alice");
  const port = await availablePort();
  const adminRequests = [];
  const adminBodies = [];
  const videoRows = [1, 2, 3, 4].map((id) => ({
    id,
    video_id: `video-${id}`,
    username: "alice",
    source_url: `https://example.com/${id}`,
    path: `/app/data/downloads/alice/${id}.mp4`,
    filename: `${id}.mp4`,
    size_bytes: 16,
    created_at: id * 100,
    title: `${id}.mp4`,
  })).sort((left, right) => right.created_at - left.created_at);
  const postRows = [{
    id: 6,
    platform: "instagram",
    remote_id: "Carousel6",
    username: "alice.ig",
    creator_handle: "alice.ig",
    creator_display_name: "Alice IG",
    creator_profile_url: "https://www.instagram.com/alice.ig/",
    profile_id: 12,
    creator_group_id: 3,
    creator_group_name: "Alice everywhere",
    canonical_url: "https://www.instagram.com/p/Carousel6/",
    source_url: "https://www.instagram.com/p/Carousel6/",
    path: "/app/data/downloads/instagram/6.zip",
    filename: "6.zip",
    size_bytes: 9,
    created_at: 600,
    title: "Mixed carousel",
    description: "Image and video #archive",
    media_type: "mixed",
    bookmarked: 1,
    trashed_at: null,
    retention_status: "active",
    assets: [
      {
        id: 61,
        file_id: 6,
        position: 1,
        role: "content",
        kind: "image",
        mime_type: "image/jpeg",
        path: "/app/data/downloads/instagram/6-1.jpg",
        filename: "6-1.jpg",
        size_bytes: 10,
      },
      {
        id: 62,
        file_id: 6,
        position: 2,
        role: "content",
        kind: "video",
        mime_type: "video/mp4",
        path: "/app/data/downloads/instagram/6-2.mp4",
        filename: "6-2.mp4",
        size_bytes: 16,
      },
      {
        id: 63,
        file_id: 6,
        position: 2,
        role: "package",
        kind: "archive",
        mime_type: "application/zip",
        path: "/app/data/downloads/instagram/6.zip",
        filename: "6.zip",
        size_bytes: 9,
      },
    ],
  }];
  const backend = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/ready") {
      sendBackendJson(response, 200, {
        status: "ready",
        database: "ready",
        schemaVersion: 4,
      });
      return;
    }
    adminRequests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization || "",
    });
    if (request.method === "DELETE" && request.url === "/api/creators/alice.archive/monitoring") {
      const body = JSON.stringify({
        username: "alice.archive",
        monitoring: false,
        removed: true,
        removedSubscriptions: 2,
      });
      response.writeHead(200, {
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json; charset=utf-8",
      });
      response.end(body);
      return;
    }
    if (request.method === "GET" && request.url === "/api/profile-groups") {
      const body = JSON.stringify({
        groups: [{
          id: 3,
          name: "Alice everywhere",
          memberCount: 2,
          members: [],
        }],
        unlinkedProfiles: [],
      });
      response.writeHead(200, {
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json; charset=utf-8",
      });
      response.end(body);
      return;
    }
    if (request.method === "POST" && request.url === "/api/profile-groups") {
      const requestBody = await readRequestBody(request);
      adminBodies.push(requestBody);
      const body = JSON.stringify({
        group: {
          id: 3,
          name: JSON.parse(requestBody).name,
          memberCount: 2,
          members: [],
        },
      });
      response.writeHead(200, {
        "content-length": Buffer.byteLength(body),
        "content-type": "application/json; charset=utf-8",
      });
      response.end(body);
      return;
    }
    const requestUrl = new URL(request.url || "/", "http://backend.test");
    const postBookmarkMatch = requestUrl.pathname.match(/^\/api\/post-bookmarks\/(\d+)$/);
    if (postBookmarkMatch && (request.method === "PUT" || request.method === "DELETE")) {
      const row = postRows.find((candidate) => candidate.id === Number(postBookmarkMatch[1]));
      if (!row) {
        sendBackendJson(response, 404, { error: "Post not found" });
        return;
      }
      row.bookmarked = request.method === "PUT" ? 1 : 0;
      sendBackendJson(response, 200, {
        fileId: row.id,
        bookmarked: Boolean(row.bookmarked),
      });
      return;
    }
    const mediaPostRestoreMatch = requestUrl.pathname.match(/^\/api\/media-posts\/(\d+)\/restore$/);
    if (mediaPostRestoreMatch && request.method === "POST") {
      const row = postRows.find((candidate) => candidate.id === Number(mediaPostRestoreMatch[1]));
      const requestBody = JSON.parse(await readRequestBody(request) || "{}");
      if (!row || Number(requestBody.confirmFileId) !== row.id || row.trashed_at == null) {
        sendBackendJson(response, 404, { error: "Trashed post not found" });
        return;
      }
      row.trashed_at = null;
      row.retention_status = "active";
      sendBackendJson(response, 200, { fileId: row.id, restoredPost: true });
      return;
    }
    const mediaPostMatch = requestUrl.pathname.match(/^\/api\/media-posts\/(\d+)$/);
    if (mediaPostMatch && request.method === "DELETE") {
      const row = postRows.find((candidate) => candidate.id === Number(mediaPostMatch[1]));
      const requestBody = JSON.parse(await readRequestBody(request) || "{}");
      if (!row || Number(requestBody.confirmFileId) !== row.id || row.trashed_at != null) {
        sendBackendJson(response, 404, { error: "Post not found" });
        return;
      }
      row.trashed_at = 700;
      row.retention_status = "trashed";
      sendBackendJson(response, 200, { fileId: row.id, trashedPost: true, trashedAt: row.trashed_at });
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/rewind/videos") {
      let rows = [...videoRows];
      const username = requestUrl.searchParams.get("username");
      const fileId = Number(requestUrl.searchParams.get("fileId") || 0);
      const beforeCreatedAt = Number(requestUrl.searchParams.get("beforeCreatedAt") || -1);
      const beforeFileId = Number(requestUrl.searchParams.get("beforeFileId") || 0);
      const limit = Number(requestUrl.searchParams.get("limit") || 500);
      if (username) rows = rows.filter((row) => row.username.toLowerCase() === username.toLowerCase());
      if (fileId) rows = rows.filter((row) => row.id === fileId);
      if (beforeCreatedAt >= 0 && beforeFileId > 0) {
        rows = rows.filter((row) => (
          row.created_at < beforeCreatedAt
          || (row.created_at === beforeCreatedAt && row.id < beforeFileId)
        ));
      }
      if (requestUrl.searchParams.get("bookmarked") === "1") {
        rows = rows.filter((row) => row.id === 2);
      }
      sendBackendJson(response, 200, { videos: rows.slice(0, limit) });
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/rewind/posts") {
      let rows = [...postRows];
      const platform = requestUrl.searchParams.get("platform");
      const fileId = Number(requestUrl.searchParams.get("fileId") || 0);
      const beforeCreatedAt = Number(requestUrl.searchParams.get("beforeCreatedAt") || -1);
      const beforeFileId = Number(requestUrl.searchParams.get("beforeFileId") || 0);
      const limit = Number(requestUrl.searchParams.get("limit") || 101);
      const trashedOnly = requestUrl.searchParams.get("trashed") === "1";
      rows = rows.filter((row) => trashedOnly ? row.trashed_at != null : row.trashed_at == null);
      if (platform) rows = rows.filter((row) => row.platform === platform);
      if (fileId) rows = rows.filter((row) => row.id === fileId);
      if (beforeCreatedAt >= 0 && beforeFileId > 0) {
        rows = rows.filter((row) => (
          row.created_at < beforeCreatedAt
          || (row.created_at === beforeCreatedAt && row.id < beforeFileId)
        ));
      }
      if (requestUrl.searchParams.get("bookmarked") === "1") {
        rows = rows.filter((row) => Boolean(row.bookmarked));
      }
      sendBackendJson(response, 200, { posts: rows.slice(0, limit) });
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/rewind/creators") {
      sendBackendJson(response, 200, {
        creators: [{
          username: "alice",
          video_count: 4,
          size_bytes: 64,
          latest_at: 400,
          failure_count: 0,
          enabled: 1,
        }],
      });
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/rewind/stats") {
      sendBackendJson(response, 200, {
        stats: {
          creator_count: 1,
          video_count: 4,
          size_bytes: 64,
          new_this_week: 4,
          added_today: 4,
        },
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Not found" }));
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const backendAddress = backend.address();
  assert(backendAddress && typeof backendAddress === "object");
  context.after(async () => {
    if (backend.listening) {
      backend.close();
      await once(backend, "close");
    }
  });
  await mkdir(creatorDir, { recursive: true });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  for (let id = 1; id <= 5; id += 1) {
    await writeFile(path.join(creatorDir, `${id}.mp4`), `not-a-real-video-${id}`);
  }
  await writeFile(path.join(creatorDir, "1.image"), jpeg);
  const instagramDir = path.join(downloads, "instagram");
  await mkdir(instagramDir, { recursive: true });
  await writeFile(path.join(instagramDir, "6-1.jpg"), jpeg);
  await writeFile(path.join(instagramDir, "6-2.mp4"), "not-a-real-video");
  await writeFile(path.join(instagramDir, "6.zip"), "package-6");

  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/live-bridge.mjs", import.meta.url))], {
    env: {
      ...process.env,
      LIVE_LOCAL_MODE: "1",
      LIVE_BRIDGE_HOST: "127.0.0.1",
      LIVE_BRIDGE_PORT: String(port),
      LIVE_DOWNLOADS_PATH: downloads,
      LIVE_CACHE_PATH: path.join(fixture, "cache"),
      LIVE_BACKEND_URL: `http://127.0.0.1:${backendAddress.port}`,
      LIVE_IMPORT_API_TOKEN: "bridge-secret",
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
  const deniedOrigin = await fetch(`http://127.0.0.1:${port}/api/creators`, {
    headers: { origin: "https://rewind.example.com.evil.test" },
  });
  assert.equal(deniedOrigin.status, 403);
  assert.equal(deniedOrigin.headers.get("access-control-allow-origin"), null);
  assert.equal(adminRequests.length, 0);

  const allowedOrigin = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(allowedOrigin.status, 200);
  assert.equal(allowedOrigin.headers.get("access-control-allow-origin"), `http://127.0.0.1:${port}`);

  const wrongMonitoringMethod = await fetch(
    `http://127.0.0.1:${port}/api/creators/alice.archive/monitoring`,
    { method: "POST" },
  );
  assert.equal(wrongMonitoringMethod.status, 405);
  assert.equal(adminRequests.length, 0);

  const stopMonitoringResponse = await fetch(
    `http://127.0.0.1:${port}/api/creators/alice.archive/monitoring`,
    { method: "DELETE" },
  );
  assert.equal(stopMonitoringResponse.status, 200);
  assert.deepEqual(await stopMonitoringResponse.json(), {
    username: "alice.archive",
    monitoring: false,
    removed: true,
    removedSubscriptions: 2,
  });
  assert.deepEqual(adminRequests, [{
    method: "DELETE",
    url: "/api/creators/alice.archive/monitoring",
    authorization: "Bearer bridge-secret",
  }]);

  const wrongProfileMethod = await fetch(
    `http://127.0.0.1:${port}/api/profile-groups`,
    { method: "DELETE" },
  );
  assert.equal(wrongProfileMethod.status, 405);
  assert.equal(adminRequests.length, 1);

  const groupsResponse = await fetch(`http://127.0.0.1:${port}/api/profile-groups`);
  assert.equal(groupsResponse.status, 200);
  assert.equal((await groupsResponse.json()).groups[0].name, "Alice everywhere");

  const linkBody = {
    profiles: ["https://www.tiktok.com/@alice", "https://www.instagram.com/alice/"],
    name: "Alice linked",
  };
  const linkResponse = await fetch(`http://127.0.0.1:${port}/api/profile-groups`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(linkBody),
  });
  assert.equal(linkResponse.status, 200);
  assert.equal((await linkResponse.json()).group.name, "Alice linked");
  assert.deepEqual(adminBodies.map((body) => JSON.parse(body)), [linkBody]);
  assert.deepEqual(adminRequests.slice(1), [
    {
      method: "GET",
      url: "/api/profile-groups",
      authorization: "Bearer bridge-secret",
    },
    {
      method: "POST",
      url: "/api/profile-groups",
      authorization: "Bearer bridge-secret",
    },
  ]);

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

  const archiveReadsBeforeMedia = adminRequests.filter((entry) => (
    entry.method === "GET" && entry.url.startsWith("/api/rewind/videos?")
  )).length;
  for (const id of [...firstPage.items, ...secondPage.items].map((video) => video.id)) {
    const cachedMedia = await fetch(`http://127.0.0.1:${port}/media/${id}`, { method: "HEAD" });
    assert.equal(cachedMedia.status, 200, `returned ID ${id} triggered an exact backend lookup\n${childOutput}`);
  }
  assert.equal(adminRequests.filter((entry) => (
    entry.method === "GET" && entry.url.startsWith("/api/rewind/videos?")
  )).length, archiveReadsBeforeMedia);

  const exactResponse = await fetch(`http://127.0.0.1:${port}/api/videos?page=1&limit=2&fileId=1`);
  const exactPage = await exactResponse.json();
  assert.equal(exactPage.items[0].id, "1");

  const legacyResponse = await fetch(`http://127.0.0.1:${port}/api/videos?limit=2`);
  assert.equal(Array.isArray(await legacyResponse.json()), true);

  const bookmarkedResponse = await fetch(`http://127.0.0.1:${port}/api/videos?bookmarked=1&limit=10`);
  assert.equal(bookmarkedResponse.status, 200);
  assert.deepEqual((await bookmarkedResponse.json()).map((video) => video.id), ["2"]);

  const excludedPlatformResponse = await fetch(
    `http://127.0.0.1:${port}/api/videos?page=1&limit=2&fileId=6`,
  );
  assert.equal((await excludedPlatformResponse.json()).items.some((video) => video.id === "6"), false);
  assert.equal((await fetch(`http://127.0.0.1:${port}/media/6`)).status, 404);

  const postsResponse = await fetch(`http://127.0.0.1:${port}/api/posts?limit=1&platform=instagram`);
  assert.equal(postsResponse.status, 200);
  const postsPage = await postsResponse.json();
  assert.equal(postsPage.nextCursor, null);
  assert.equal(postsPage.items.length, 1);
  assert.equal(postsPage.items[0].id, "6");
  assert.equal(postsPage.items[0].platform, "instagram");
  assert.equal(postsPage.items[0].creatorId, "group:3");
  assert.equal(postsPage.items[0].mediaType, "mixed");
  assert.equal(postsPage.items[0].assetCount, 2);
  assert.deepEqual(postsPage.items[0].assets.map((asset) => asset.kind), ["image", "video"]);
  assert.deepEqual(postsPage.items[0].tags, ["archive"]);

  const postReadsBeforeMedia = adminRequests.filter((entry) => (
    entry.method === "GET" && entry.url.startsWith("/api/rewind/posts?")
  )).length;
  const imageResponse = await fetch(postsPage.items[0].assets[0].mediaUrl);
  assert.equal(imageResponse.status, 200, childOutput);
  assert.equal(imageResponse.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), jpeg);
  const postVideoResponse = await fetch(postsPage.items[0].assets[1].mediaUrl, {
    headers: { range: "bytes=0-3" },
  });
  assert.equal(postVideoResponse.status, 206);
  assert.equal(Buffer.from(await postVideoResponse.arrayBuffer()).toString(), "not-");
  assert.equal(adminRequests.filter((entry) => (
    entry.method === "GET" && entry.url.startsWith("/api/rewind/posts?")
  )).length, postReadsBeforeMedia);

  const packageResponse = await fetch(postsPage.items[0].downloadUrl);
  assert.equal(packageResponse.status, 200);
  assert.equal(packageResponse.headers.get("content-type"), "application/zip");
  assert.match(packageResponse.headers.get("content-disposition") || "", /attachment; filename="6\.zip"/);
  assert.equal(await packageResponse.text(), "package-6");
  assert.equal((await fetch(`http://127.0.0.1:${port}/post-media/6/9`)).status, 404);

  const wrongPostBookmarkMethod = await fetch(`http://127.0.0.1:${port}/api/post-bookmarks/6`);
  assert.equal(wrongPostBookmarkMethod.status, 405);
  const removedPostBookmark = await fetch(`http://127.0.0.1:${port}/api/post-bookmarks/6`, {
    method: "DELETE",
  });
  assert.equal(removedPostBookmark.status, 200);
  assert.deepEqual(await removedPostBookmark.json(), { fileId: 6, bookmarked: false });
  const noBookmarkedPosts = await fetch(`http://127.0.0.1:${port}/api/posts?bookmarked=1`);
  assert.deepEqual((await noBookmarkedPosts.json()).items, []);
  const restoredPostBookmark = await fetch(`http://127.0.0.1:${port}/api/post-bookmarks/6`, {
    method: "PUT",
  });
  assert.equal(restoredPostBookmark.status, 200);
  assert.deepEqual(await restoredPostBookmark.json(), { fileId: 6, bookmarked: true });
  assert.deepEqual(
    adminRequests
      .filter((entry) => entry.url === "/api/post-bookmarks/6")
      .map((entry) => entry.method),
    ["DELETE", "PUT"],
  );

  const wrongMediaPostMethod = await fetch(`http://127.0.0.1:${port}/api/media-posts/6`, {
    method: "PUT",
  });
  assert.equal(wrongMediaPostMethod.status, 405);
  const trashedPost = await fetch(`http://127.0.0.1:${port}/api/media-posts/6`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmFileId: 6 }),
  });
  assert.equal(trashedPost.status, 200);
  assert.equal((await trashedPost.json()).trashedPost, true);
  assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/api/posts?platform=instagram`)).json()).items, []);
  const trashedPosts = await (await fetch(
    `http://127.0.0.1:${port}/api/posts?platform=instagram&trashed=1`,
  )).json();
  assert.deepEqual(trashedPosts.items.map((post) => post.id), ["6"]);
  assert.equal(trashedPosts.items[0].retentionStatus, "trashed");
  assert.equal(trashedPosts.items[0].trashedAt, new Date(700).toISOString());
  assert.equal((await fetch(trashedPosts.items[0].assets[0].mediaUrl)).status, 404);
  assert.equal((await fetch(trashedPosts.items[0].downloadUrl)).status, 404);
  const restoredPost = await fetch(`http://127.0.0.1:${port}/api/media-posts/6/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmFileId: 6 }),
  });
  assert.equal(restoredPost.status, 200);
  assert.equal((await restoredPost.json()).restoredPost, true);
  assert.deepEqual(
    adminRequests
      .filter((entry) => entry.url === "/api/media-posts/6" || entry.url === "/api/media-posts/6/restore")
      .map((entry) => entry.method),
    ["DELETE", "POST"],
  );

  const creatorsResponse = await fetch(`http://127.0.0.1:${port}/api/creators`);
  assert.equal(creatorsResponse.status, 200);
  const creators = await creatorsResponse.json();
  assert.equal(creators.length, 1);
  assert.equal(creators[0].username, "alice");
  assert.equal(creators[0].videoCount, 4);

  const statsResponse = await fetch(`http://127.0.0.1:${port}/api/stats`);
  assert.equal(statsResponse.status, 200);
  const stats = await statsResponse.json();
  assert.equal(stats.creatorCount, 1);
  assert.equal(stats.videoCount, 4);
  assert.equal(stats.storageUsed, "64 B");

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

  backend.close();
  await once(backend, "close");
  const unavailableHealth = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(unavailableHealth.status, 503);
  assert.deepEqual(await unavailableHealth.json(), { status: "not_ready" });
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

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function sendBackendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

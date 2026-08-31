import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.js';
import { startHttpServer } from '../src/http/server.js';
import { Store } from '../src/state/store.js';

test('authenticated Rewind read endpoints expose bounded Store rows and cursor validation', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'rewind-read-http-'));
  const downloadDir = path.join(rootDir, 'downloads');
  await mkdir(downloadDir, { recursive: true });
  const config = loadConfig({
    DATA_DIR: rootDir,
    DOWNLOAD_DIR: downloadDir,
    STATE_DB: path.join(rootDir, 'state.db'),
    HTTP_PORT: '0',
  }, rootDir);
  const store = new Store(config.stateDbPath);
  store.addWatch('creator', { channelId: 'channel', guildId: 'guild' }, 100);
  const firstId = store.createFileRecord({
    videoId: 'first',
    username: 'creator',
    sourceUrl: 'https://www.tiktok.com/@creator/video/first',
    filePath: path.join(downloadDir, 'first.mp4'),
    filename: 'first.mp4',
    sizeBytes: 10,
  }, 300);
  const secondId = store.createFileRecord({
    videoId: 'second',
    username: 'creator',
    sourceUrl: 'https://www.tiktok.com/@creator/video/second',
    filePath: path.join(downloadDir, 'second.mp4'),
    filename: 'second.mp4',
    sizeBytes: 20,
  }, 200);
  store.setFileBookmark(secondId, true, 400);
  const xProfile = store.upsertPlatformProfile({
    platform: 'x',
    remoteId: 'x-creator',
    handle: 'creator_x',
  }, 100);
  const xPath = path.join(downloadDir, 'x-post.jpg');
  await writeFile(xPath, 'x-post');
  const { fileId: xFileId } = store.createFileWithMedia({
    file: {
      platform: 'x',
      videoId: '12345',
      username: 'creator_x',
      sourceUrl: 'https://x.com/creator_x/status/12345',
      filePath: xPath,
      filename: 'x-post.jpg',
      sizeBytes: 30,
    },
    media: {
      platform: 'x',
      remoteId: '12345',
      profileId: xProfile.id,
      creatorHandle: 'creator_x',
      title: 'X image',
      mediaType: 'image',
      filePath: xPath,
      filename: 'x-post.jpg',
      sizeBytes: 30,
      assets: [{
        path: xPath,
        filename: 'x-post.jpg',
        kind: 'image',
        mimeType: 'image/jpeg',
        sizeBytes: 30,
      }],
    },
  }, 350);

  const { server, address } = await startHttpServer({
    config,
    store,
    host: '127.0.0.1',
    port: 0,
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(rootDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const creators = await fetchJson(`${baseUrl}/api/rewind/creators`);
  assert.equal(creators.response.status, 200);
  assert.deepEqual(creators.payload.creators.map((creator) => creator.username), ['creator']);
  assert.equal(creators.payload.creators[0].video_count, 2);

  const firstPage = await fetchJson(`${baseUrl}/api/rewind/videos?limit=1`);
  assert.equal(firstPage.response.status, 200);
  assert.deepEqual(firstPage.payload.videos.map((video) => video.id), [firstId]);

  const secondPage = await fetchJson(
    `${baseUrl}/api/rewind/videos?limit=2&beforeCreatedAt=300&beforeFileId=${firstId}`,
  );
  assert.deepEqual(secondPage.payload.videos.map((video) => video.id), [secondId]);

  const bookmarked = await fetchJson(`${baseUrl}/api/rewind/videos?bookmarked=1`);
  assert.deepEqual(bookmarked.payload.videos.map((video) => video.id), [secondId]);

  const stats = await fetchJson(`${baseUrl}/api/rewind/stats`);
  assert.equal(stats.payload.stats.creator_count, 1);
  assert.equal(stats.payload.stats.video_count, 2);
  assert.equal(stats.payload.stats.size_bytes, 30);

  const posts = await fetchJson(`${baseUrl}/api/rewind/posts?limit=2`);
  assert.equal(posts.response.status, 200);
  assert.deepEqual(posts.payload.posts.map((post) => post.id), [xFileId, firstId]);
  assert.equal(posts.payload.posts[0].platform, 'x');
  assert.equal(posts.payload.posts[0].assets[0].kind, 'image');
  assert.equal(posts.payload.posts[0].assets[0].mime_type, 'image/jpeg');

  const xPosts = await fetchJson(`${baseUrl}/api/rewind/posts?platform=x&profileId=${xProfile.id}`);
  assert.deepEqual(xPosts.payload.posts.map((post) => post.id), [xFileId]);

  const bookmarkedPost = await fetchJson(`${baseUrl}/api/post-bookmarks/${xFileId}`, { method: 'PUT' });
  assert.equal(bookmarkedPost.response.status, 200);
  assert.deepEqual(bookmarkedPost.payload, { fileId: xFileId, bookmarked: true });
  const bookmarkedPosts = await fetchJson(`${baseUrl}/api/rewind/posts?bookmarked=1`);
  assert.deepEqual(bookmarkedPosts.payload.posts.map((post) => post.id), [xFileId, secondId]);
  assert.deepEqual(store.listBookmarkedFileIds(), [secondId]);

  const unconfirmedTrash = await fetchJson(`${baseUrl}/api/media-posts/${xFileId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmFileId: secondId }),
  });
  assert.equal(unconfirmedTrash.response.status, 400);
  const trashedPost = await fetchJson(`${baseUrl}/api/media-posts/${xFileId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmFileId: xFileId }),
  });
  assert.equal(trashedPost.response.status, 200);
  assert.equal(trashedPost.payload.trashedPost, true);
  assert.equal(trashedPost.payload.platform, 'x');
  const activeAfterTrash = await fetchJson(`${baseUrl}/api/rewind/posts?platform=x`);
  assert.deepEqual(activeAfterTrash.payload.posts, []);
  const postTrash = await fetchJson(`${baseUrl}/api/rewind/posts?platform=x&trashed=1`);
  assert.deepEqual(postTrash.payload.posts.map((post) => post.id), [xFileId]);
  assert.equal(Number(postTrash.payload.posts[0].bookmarked), 1);

  const unconfirmedRestore = await fetchJson(`${baseUrl}/api/media-posts/${xFileId}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmFileId: secondId }),
  });
  assert.equal(unconfirmedRestore.response.status, 400);
  const restoredPost = await fetchJson(`${baseUrl}/api/media-posts/${xFileId}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmFileId: xFileId }),
  });
  assert.equal(restoredPost.response.status, 200);
  assert.equal(restoredPost.payload.restoredPost, true);
  assert.deepEqual(
    (await fetchJson(`${baseUrl}/api/rewind/posts?platform=x`)).payload.posts.map((post) => post.id),
    [xFileId],
  );

  const unbookmarkedPost = await fetchJson(`${baseUrl}/api/post-bookmarks/${xFileId}`, { method: 'DELETE' });
  assert.equal(unbookmarkedPost.response.status, 200);
  assert.deepEqual(unbookmarkedPost.payload, { fileId: xFileId, bookmarked: false });
  const missingPost = await fetchJson(`${baseUrl}/api/post-bookmarks/999999`, { method: 'PUT' });
  assert.equal(missingPost.response.status, 404);
  const wrongPostBookmarkMethod = await fetchJson(`${baseUrl}/api/post-bookmarks/${xFileId}`, { method: 'POST' });
  assert.equal(wrongPostBookmarkMethod.response.status, 405);
  const wrongMediaPostMethod = await fetchJson(`${baseUrl}/api/media-posts/${xFileId}`, { method: 'PUT' });
  assert.equal(wrongMediaPostMethod.response.status, 405);

  const postsCursor = await fetchJson(
    `${baseUrl}/api/rewind/posts?beforeCreatedAt=350&beforeFileId=${xFileId}`,
  );
  assert.deepEqual(postsCursor.payload.posts.map((post) => post.id), [firstId, secondId]);

  const invalidMediaCursor = await fetchJson(`${baseUrl}/api/rewind/posts?beforeCreatedAt=350`);
  assert.equal(invalidMediaCursor.response.status, 400);
  assert.match(invalidMediaCursor.payload.error, /both Rewind media cursor fields/i);

  const invalidPlatform = await fetchJson(`${baseUrl}/api/rewind/posts?platform=youtube`);
  assert.equal(invalidPlatform.response.status, 400);
  assert.match(invalidPlatform.payload.error, /unsupported platform/i);

  const invalidCursor = await fetchJson(`${baseUrl}/api/rewind/videos?beforeCreatedAt=300`);
  assert.equal(invalidCursor.response.status, 400);
  assert.match(invalidCursor.payload.error, /both Rewind cursor fields/i);

  const oversizedLimit = await fetchJson(`${baseUrl}/api/rewind/videos?limit=5002`);
  assert.equal(oversizedLimit.response.status, 400);
  assert.match(oversizedLimit.payload.error, /limit must be an integer/i);

  const wrongMethod = await fetchJson(`${baseUrl}/api/rewind/stats`, { method: 'POST' });
  assert.equal(wrongMethod.response.status, 405);

  const instagramDir = path.join(downloadDir, 'instagram');
  const instagramPackage = path.join(instagramDir, 'gallery.zip');
  const instagramFirst = path.join(instagramDir, 'gallery__001.jpg');
  const instagramSecond = path.join(instagramDir, 'gallery__002.jpg');
  await mkdir(instagramDir, { recursive: true });
  await Promise.all([
    writeFile(instagramPackage, 'gallery package'),
    writeFile(instagramFirst, 'first image'),
    writeFile(instagramSecond, 'second image'),
  ]);
  const { fileId: instagramFileId } = store.createFileWithMedia({
    file: {
      platform: 'instagram',
      videoId: 'GalleryCode',
      username: 'creator_ig',
      sourceUrl: 'https://www.instagram.com/p/GalleryCode/',
      filePath: instagramPackage,
      filename: 'gallery.zip',
      sizeBytes: 15,
    },
    media: {
      platform: 'instagram',
      remoteId: 'GalleryCode',
      creatorHandle: 'creator_ig',
      title: 'Instagram gallery',
      mediaType: 'gallery',
      filePath: instagramPackage,
      filename: 'gallery.zip',
      sizeBytes: 15,
      assets: [
        { position: 1, path: instagramFirst, filename: 'gallery__001.jpg', kind: 'image', sizeBytes: 11 },
        { position: 2, path: instagramSecond, filename: 'gallery__002.jpg', kind: 'image', sizeBytes: 12 },
      ],
    },
  }, 500);
  const trashedGallery = await fetchJson(`${baseUrl}/api/media-posts/${instagramFileId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmFileId: instagramFileId }),
  });
  assert.equal(trashedGallery.response.status, 200);
  await rm(instagramSecond);
  const incompleteRestore = await fetchJson(`${baseUrl}/api/media-posts/${instagramFileId}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmFileId: instagramFileId }),
  });
  assert.equal(incompleteRestore.response.status, 409);
  assert.match(incompleteRestore.payload.error, /no longer available on disk/i);
  assert.equal(store.getTrashedMediaFile(instagramFileId)?.retention_status, 'trashed');
  assert.deepEqual(
    (await fetchJson(`${baseUrl}/api/rewind/posts?platform=instagram&trashed=1`)).payload.posts
      .map((post) => post.id),
    [instagramFileId],
  );

  const retrashX = await fetchJson(`${baseUrl}/api/media-posts/${xFileId}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmFileId: xFileId }),
  });
  assert.equal(retrashX.response.status, 200);
  const restoreTrashedMediaFile = store.restoreTrashedMediaFile.bind(store);
  store.restoreTrashedMediaFile = (fileId) => {
    store.db.prepare(`
      UPDATE files
      SET retention_status = 'trash_claimed', delete_requested_at = 900
      WHERE id = ? AND retention_status = 'trashed'
    `).run(fileId);
    return restoreTrashedMediaFile(fileId);
  };
  const claimedDuringRestore = await fetchJson(`${baseUrl}/api/media-posts/${xFileId}/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmFileId: xFileId }),
  });
  delete store.restoreTrashedMediaFile;
  assert.equal(claimedDuringRestore.response.status, 409);
  assert.match(claimedDuringRestore.payload.error, /currently being purged/i);
  assert.equal(store.getTrashedMediaFile(xFileId)?.retention_status, 'trash_claimed');
});

async function fetchJson(url, options = undefined) {
  const response = await fetch(url, options);
  return { response, payload: await response.json() };
}

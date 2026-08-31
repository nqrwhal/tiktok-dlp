import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createStore } from '../src/state/store.js';

test('platform-neutral Rewind media reads preserve ordered assets, creator groups, filters, and cursors', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rewind-media-store-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const instagram = store.upsertPlatformProfile({
      platform: 'instagram',
      remoteId: 'ig-owner-1',
      handle: 'creator.one',
      displayName: 'Creator One',
      profileUrl: 'https://www.instagram.com/creator.one/',
    }, 100);
    const x = store.upsertPlatformProfile({
      platform: 'x',
      remoteId: 'x-owner-1',
      handle: 'creator_one',
      displayName: 'Creator One on X',
      profileUrl: 'https://x.com/creator_one',
    }, 110);
    const group = store.linkCreatorProfiles([instagram.id, x.id], { name: 'Creator One' }, 120);

    const instagramPaths = [
      path.join(dir, 'downloads', 'instagram', 'asset-1.jpg'),
      path.join(dir, 'downloads', 'instagram', 'asset-2.mp4'),
    ];
    const instagramPackage = path.join(dir, 'downloads', 'instagram', 'post.zip');
    const { fileId: instagramFileId } = store.createFileWithMedia({
      file: {
        platform: 'instagram',
        videoId: 'ShortCode',
        username: 'creator.one',
        sourceUrl: 'https://www.instagram.com/p/ShortCode/',
        filePath: instagramPackage,
        filename: 'post.zip',
        sizeBytes: 30,
      },
      media: {
        platform: 'instagram',
        remoteId: 'ShortCode',
        profileId: instagram.id,
        creatorHandle: 'creator.one',
        creatorRemoteId: 'ig-owner-1',
        canonicalUrl: 'https://www.instagram.com/p/ShortCode/',
        title: 'Ordered carousel',
        description: 'An image followed by a video',
        mediaType: 'mixed',
        publishedAt: '2026-08-30T11:00:00Z',
        filePath: instagramPackage,
        filename: 'post.zip',
        sizeBytes: 30,
        assets: [
          {
            position: 1,
            path: instagramPaths[0],
            filename: 'asset-1.jpg',
            kind: 'image',
            mimeType: 'image/jpeg',
            sizeBytes: 10,
          },
          {
            position: 2,
            path: instagramPaths[1],
            filename: 'asset-2.mp4',
            kind: 'video',
            mimeType: 'video/mp4',
            sizeBytes: 20,
          },
        ],
      },
    }, 300);

    const xPath = path.join(dir, 'downloads', 'x', 'status.mp4');
    const { fileId: xFileId } = store.createFileWithMedia({
      file: {
        platform: 'x',
        videoId: '123456',
        username: 'creator_one',
        sourceUrl: 'https://x.com/creator_one/status/123456',
        filePath: xPath,
        filename: 'status.mp4',
        sizeBytes: 40,
      },
      media: {
        platform: 'x',
        remoteId: '123456',
        profileId: x.id,
        creatorHandle: 'creator_one',
        title: 'X video',
        mediaType: 'video',
        filePath: xPath,
        filename: 'status.mp4',
        sizeBytes: 40,
        assets: [{
          position: 1,
          path: xPath,
          filename: 'status.mp4',
          kind: 'video',
          mimeType: 'video/mp4',
          sizeBytes: 40,
        }],
      },
    }, 200);

    const legacyPath = path.join(dir, 'downloads', 'legacy.mp4');
    const legacyFileId = store.createFileRecord({
      platform: 'tiktok',
      videoId: '999',
      username: 'legacy',
      sourceUrl: 'https://www.tiktok.com/@legacy/video/999',
      filePath: legacyPath,
      filename: 'legacy.mp4',
      sizeBytes: 50,
    }, 100);
    assert.equal(store.setMediaFileBookmark(instagramFileId, true, 400), true);
    assert.deepEqual(store.listBookmarkedFileIds(), []);

    const rows = store.listRewindMediaPosts({ limit: 10 });
    assert.deepEqual(rows.map((row) => Number(row.id)), [instagramFileId, xFileId, legacyFileId]);
    assert.equal(rows[0].platform, 'instagram');
    assert.equal(rows[0].creator_group_id, group.id);
    assert.equal(rows[0].creator_group_name, 'Creator One');
    assert.equal(rows[0].creator_display_name, 'Creator One');
    assert.equal(rows[0].media_type, 'mixed');
    assert.equal(Number(rows[0].bookmarked), 1);
    assert.equal(Number(rows[0].asset_count), 2);
    assert.deepEqual(rows[0].assets.map((asset) => ({
      position: Number(asset.position),
      role: asset.role,
      kind: asset.kind,
      filename: asset.filename,
    })), [
      { position: 1, role: 'content', kind: 'image', filename: 'asset-1.jpg' },
      { position: 2, role: 'content', kind: 'video', filename: 'asset-2.mp4' },
      { position: 2, role: 'package', kind: 'archive', filename: 'post.zip' },
    ]);
    assert.equal(rows[2].assets.length, 1);
    assert.equal(rows[2].assets[0].role, 'primary');
    assert.equal(rows[2].assets[0].mime_type, 'video/mp4');

    assert.deepEqual(
      store.listRewindMediaPosts({ platform: 'instagram' }).map((row) => Number(row.id)),
      [instagramFileId],
    );
    assert.deepEqual(
      store.listRewindMediaPosts({ groupId: group.id }).map((row) => Number(row.id)),
      [instagramFileId, xFileId],
    );
    assert.deepEqual(
      store.listRewindMediaPosts({ profileId: x.id }).map((row) => Number(row.id)),
      [xFileId],
    );
    assert.deepEqual(
      store.listRewindMediaPosts({ username: '@CREATOR.ONE' }).map((row) => Number(row.id)),
      [instagramFileId],
    );
    assert.deepEqual(
      store.listRewindMediaPosts({ bookmarkedOnly: true }).map((row) => Number(row.id)),
      [instagramFileId],
    );
    assert.deepEqual(
      store.listRewindMediaPosts({
        cursor: { createdAt: rows[0].created_at, fileId: instagramFileId },
      }).map((row) => Number(row.id)),
      [xFileId, legacyFileId],
    );
    assert.deepEqual(
      store.listRewindMediaPosts({ fileId: xFileId }).map((row) => Number(row.id)),
      [xFileId],
    );
    assert.equal(store.setMediaFileBookmark(xFileId, true, 410), true);
    assert.deepEqual(
      store.listRewindMediaPosts({ bookmarkedOnly: true }).map((row) => Number(row.id)),
      [instagramFileId, xFileId],
    );
    assert.deepEqual(store.listBookmarkedFileIds(), []);
    assert.equal(store.setMediaFileBookmark(xFileId, false, 420), true);
    assert.deepEqual(
      store.listRewindMediaPosts({ bookmarkedOnly: true }).map((row) => Number(row.id)),
      [instagramFileId],
    );
    assert.equal(store.setMediaFileBookmark(999_999, true), false);
    const trashed = store.trashMediaFile(instagramFileId, 500);
    assert.equal(trashed.platform, 'instagram');
    assert.equal(Number(trashed.trashed_at), 500);
    assert.equal(store.getTrashedFile(instagramFileId), null);
    assert.deepEqual(
      store.listRewindMediaPosts({ platform: 'instagram' }).map((row) => Number(row.id)),
      [],
    );
    const trashedPosts = store.listRewindMediaPosts({ trashedOnly: true });
    assert.deepEqual(trashedPosts.map((row) => Number(row.id)), [instagramFileId]);
    assert.equal(Number(trashedPosts[0].trashed_at), 500);
    assert.equal(trashedPosts[0].retention_status, 'trashed');
    assert.deepEqual(
      store.listRewindMediaPosts({ trashedOnly: true, bookmarkedOnly: true })
        .map((row) => Number(row.id)),
      [instagramFileId],
    );
    assert.equal(store.restoreTrashedMediaFile(instagramFileId)?.platform, 'instagram');
    assert.deepEqual(
      store.listRewindMediaPosts({ platform: 'instagram' }).map((row) => Number(row.id)),
      [instagramFileId],
    );
    assert.deepEqual(store.listRewindMediaPosts({ trashedOnly: true }), []);
    assert.throws(() => store.listRewindMediaPosts({ platform: 'youtube' }), /unsupported platform/i);
    assert.throws(
      () => store.listRewindMediaPosts({ cursor: { createdAt: -1, fileId: xFileId } }),
      /media cursor timestamp/i,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

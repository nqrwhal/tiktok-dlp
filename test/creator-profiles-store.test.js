import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/state/store.js';

test('platform profiles stay separate until linked and survive identity upgrades and restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-archive-profiles-'));
  const dbPath = path.join(dir, 'state.db');
  let store = createStore(dbPath);
  try {
    const tiktok = store.upsertPlatformProfile({
      platform: 'tiktok',
      handle: 'Same.Creator',
      displayName: 'TikTok creator',
    }, 1000);
    const instagram = store.upsertPlatformProfile({
      platform: 'instagram',
      handle: 'Same.Creator',
      displayName: 'Instagram creator',
    }, 1100);
    const x = store.upsertPlatformProfile({
      platform: 'twitter',
      remoteId: '300',
      handle: 'same_creator',
    }, 1200);

    assert.notEqual(tiktok.id, instagram.id);
    assert.notEqual(tiktok.id, x.id);
    assert.equal(tiktok.remote_id, null);
    assert.equal(tiktok.group_id, null);
    assert.equal(instagram.group_id, null);
    assert.equal(store.listPlatformProfiles().length, 3);

    const group = store.linkCreatorProfiles([tiktok.id, instagram.id], {
      groupName: 'Same person',
    }, 2000);
    assert.equal(group.name, 'Same person');
    assert.deepEqual(group.members.map((profile) => profile.platform), ['instagram', 'tiktok']);
    assert.equal(store.getCreatorGroupForProfile(x.id), null);

    const identified = store.upsertPlatformProfile({
      platform: 'tiktok',
      remoteId: '100',
      handle: 'same.creator',
    }, 3000);
    assert.equal(identified.id, tiktok.id);
    assert.equal(identified.group_id, group.id);
    assert.equal(identified.display_name, 'TikTok creator');

    const renamed = store.upsertPlatformProfile({
      platform: 'tiktok',
      remoteId: '100',
      handle: 'renamed.creator',
      displayName: 'Renamed creator',
    }, 4000);
    assert.equal(renamed.id, tiktok.id);
    assert.equal(renamed.group_id, group.id);
    assert.equal(renamed.profile_url, 'https://www.tiktok.com/@renamed.creator');
    assert.equal(store.getPlatformProfile({ platform: 'tiktok', handle: 'same.creator' }), null);

    store.close();
    store = createStore(dbPath);

    const restarted = store.getPlatformProfile('tiktok', '100');
    assert.equal(restarted.id, tiktok.id);
    assert.equal(restarted.handle, 'renamed.creator');
    assert.equal(store.listCreatorGroupMembers(group.id).length, 2);
    assert.equal(store.unlinkProfile(instagram.id, 5000), true);
    assert.equal(store.unlinkProfile(instagram.id, 5100), false);
    assert.equal(store.getPlatformProfile(instagram.id).group_id, null);
    assert.deepEqual(store.listCreatorGroupMembers(group.id).map((profile) => profile.id), [tiktok.id]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('linking profiles requires explicit group merges and preserves every member', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-archive-profile-merge-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const profiles = [
      store.upsertPlatformProfile({ platform: 'tiktok', remoteId: '1', handle: 'one' }, 100),
      store.upsertPlatformProfile({ platform: 'instagram', remoteId: '2', handle: 'two' }, 200),
      store.upsertPlatformProfile({ platform: 'x', remoteId: '3', handle: 'three' }, 300),
      store.upsertPlatformProfile({ platform: 'instagram', remoteId: '4', handle: 'four' }, 400),
    ];
    const first = store.linkCreatorProfiles([profiles[0].id, profiles[1].id], { groupName: 'First' }, 500);
    const emptySecond = store.createCreatorGroup({ name: 'Second' }, 550);
    assert.equal(emptySecond.member_count, 0);
    const second = store.linkCreatorProfiles(
      [profiles[2].id, profiles[3].id],
      { groupId: emptySecond.id },
      600,
    );

    assert.throws(
      () => store.linkCreatorProfiles([profiles[0].id, profiles[2].id], { groupId: second.id }, 700),
      /mergeGroups/,
    );
    assert.equal(store.getCreatorGroup(first.id).member_count, 2);
    assert.equal(store.getCreatorGroup(second.id).member_count, 2);

    const merged = store.linkCreatorProfiles(
      [profiles[0].id, profiles[2].id],
      { groupId: second.id, mergeGroups: true, groupName: 'Unified' },
      800,
    );
    assert.equal(merged.id, second.id);
    assert.equal(merged.name, 'Unified');
    assert.equal(store.getCreatorGroup(first.id), null);
    assert.deepEqual(
      store.listCreatorGroupMembers(second.id).map((profile) => profile.id).sort((a, b) => a - b),
      profiles.map((profile) => profile.id).sort((a, b) => a - b),
    );
    assert.equal(store.getCreatorGroupMember(second.id, profiles[1].id)?.id, profiles[1].id);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('stable identity reconciliation keeps group membership when a placeholder gains an ID', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-archive-profile-reconcile-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const stable = store.upsertPlatformProfile({
      platform: 'tiktok', remoteId: '900', handle: 'old.handle',
    }, 100);
    const placeholder = store.upsertPlatformProfile({
      platform: 'tiktok', handle: 'new.handle',
    }, 200);
    const instagram = store.upsertPlatformProfile({
      platform: 'instagram', remoteId: '901', handle: 'friend.one',
    }, 300);
    const x = store.upsertPlatformProfile({
      platform: 'x', remoteId: '902', handle: 'friend_two',
    }, 400);
    const stableGroup = store.linkCreatorProfiles([stable.id, instagram.id], {}, 500);
    const placeholderGroup = store.linkCreatorProfiles([placeholder.id, x.id], {}, 600);
    const fileId = store.createFileRecord({
      platform: 'tiktok',
      videoId: 'post-1',
      sourceUrl: 'https://www.tiktok.com/@new.handle/video/post-1',
      filePath: path.join(dir, 'post-1.mp4'),
      filename: 'post-1.mp4',
      sizeBytes: 1,
    }, 650);
    store.recordMediaDownload({
      platform: 'tiktok',
      remoteId: 'post-1',
      profileId: placeholder.id,
      fileId,
      filePath: path.join(dir, 'post-1.mp4'),
      filename: 'post-1.mp4',
      sizeBytes: 1,
    }, 650);

    const reconciled = store.upsertPlatformProfile({
      platform: 'tiktok', remoteId: '900', handle: 'new.handle',
    }, 700);
    assert.equal(reconciled.id, stable.id);
    assert.equal(reconciled.group_id, stableGroup.id);
    assert.equal(store.getPlatformProfile(placeholder.id), null);
    assert.equal(store.getCreatorGroup(placeholderGroup.id), null);
    assert.equal(store.getMediaPost('tiktok', 'post-1').profile_id, stable.id);
    assert.deepEqual(
      store.listCreatorGroupMembers(stableGroup.id).map((profile) => profile.id).sort((a, b) => a - b),
      [stable.id, instagram.id, x.id].sort((a, b) => a - b),
    );

    assert.throws(
      () => store.upsertPlatformProfile({
        platform: 'tiktok', remoteId: 'different-id', handle: 'new.handle',
      }, 800),
      /different stable platform profile/,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('media persistence rejects cross-platform file and profile identities', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-identity-guard-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const tiktokProfile = store.upsertPlatformProfile({
      platform: 'tiktok',
      remoteId: 'creator-1',
      handle: 'creator',
    }, 100);
    const filePath = path.join(dir, '123.mp4');
    const fileId = store.createFileRecord({
      platform: 'x',
      videoId: '123',
      sourceUrl: 'https://x.com/creator/status/123',
      filePath,
      filename: '123.mp4',
      sizeBytes: 5,
    }, 200);

    assert.throws(() => store.recordMediaDownload({
      platform: 'instagram',
      remoteId: '123',
      fileId,
      filePath,
      filename: '123.mp4',
      sizeBytes: 5,
    }, 300), /identity must match/i);
    assert.throws(() => store.recordMediaDownload({
      platform: 'x',
      remoteId: '123',
      profileId: tiktokProfile.id,
      fileId,
      filePath,
      filename: '123.mp4',
      sizeBytes: 5,
    }, 400), /profile must belong to the same platform/i);

    assert.equal(store.getMediaPost('x', '123'), null);
    assert.equal(store.getMediaPost('instagram', '123'), null);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('existing databases gain profile, media, and platform file schema without changing legacy identity', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-archive-profile-migration-'));
  const dbPath = path.join(dir, 'state.db');
  const legacy = new DatabaseSync(dbPath);
  try {
    legacy.exec(`
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        username TEXT,
        source_url TEXT NOT NULL,
        video_id TEXT,
        title TEXT,
        file_id INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT,
        username TEXT,
        source_url TEXT NOT NULL,
        path TEXT NOT NULL,
        filename TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO jobs (type, status, source_url, created_at, updated_at)
        VALUES ('manual', 'complete', 'https://www.tiktok.com/@legacy/video/1', 1, 1);
      INSERT INTO files (video_id, username, source_url, path, filename, size_bytes, created_at)
        VALUES ('1', 'legacy', 'https://www.tiktok.com/@legacy/video/1', '/tmp/legacy.mp4', 'legacy.mp4', 1, 1);
    `);
  } finally {
    legacy.close();
  }

  const store = createStore(dbPath);
  try {
    assert.equal(store.listJobs(1)[0].platform, 'tiktok');
    assert.equal(store.getLatestFileByVideoId('1').platform, 'tiktok');
    for (const table of [
      'platform_profiles',
      'creator_groups',
      'creator_group_memberships',
      'media_posts',
      'media_assets',
    ]) {
      assert.equal(
        store.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.['1'],
        1,
      );
    }
    assert.ok(store.db.prepare("PRAGMA index_list('platform_profiles')").all()
      .some((index) => index.name === 'uq_platform_profiles_platform_handle' && index.unique === 1));
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('same remote post ID resolves to the correct platform file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-archive-platform-files-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const tiktokId = store.createFileRecord({
      platform: 'tiktok',
      videoId: 'same-id',
      sourceUrl: 'https://www.tiktok.com/@creator/video/same-id',
      filePath: path.join(dir, 'tiktok.mp4'),
      filename: 'tiktok.mp4',
      sizeBytes: 1,
    }, 1000);
    const xId = store.createFileRecord({
      platform: 'x',
      videoId: 'same-id',
      sourceUrl: 'https://x.com/creator/status/same-id',
      filePath: path.join(dir, 'x.mp4'),
      filename: 'x.mp4',
      sizeBytes: 1,
    }, 2000);

    assert.equal(store.getLatestFileByPost('tiktok', 'same-id').id, tiktokId);
    assert.equal(store.getLatestFileByPost('x', 'same-id').id, xId);
    assert.equal(store.getLatestFileByVideoId('same-id').id, tiktokId);
    store.updateJob(store.createJob({
      platform: 'tiktok', type: 'manual', sourceUrl: 'https://example.test/source',
    }, 3000), { platform: 'instagram' }, 4000);
    assert.equal(store.listJobs(1)[0].platform, 'instagram');
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

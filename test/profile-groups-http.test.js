import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.js';
import { startHttpServer } from '../src/http/server.js';
import { Store } from '../src/state/store.js';

test('profile group API lists, links, merges, renames, and unlinks platform profiles', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'profile-groups-http-'));
  const downloadDir = path.join(rootDir, 'downloads');
  await mkdir(downloadDir, { recursive: true });
  const config = loadConfig({
    DATA_DIR: rootDir,
    DOWNLOAD_DIR: downloadDir,
    STATE_DB: path.join(rootDir, 'state.db'),
    HTTP_PORT: '0',
  }, rootDir);
  const store = new Store(config.stateDbPath);
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

  const empty = await getJson(`${baseUrl}/api/profile-groups`);
  assert.equal(empty.response.status, 200);
  assert.deepEqual(empty.payload, { groups: [], unlinkedProfiles: [] });

  const first = await sendJson(`${baseUrl}/api/profile-groups`, 'POST', {
    profiles: [
      'https://www.tiktok.com/@Creator.One',
      'https://www.instagram.com/creator.one/',
    ],
    name: 'Creator One',
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.payload.group.name, 'Creator One');
  assert.deepEqual(
    first.payload.group.members.map((profile) => `${profile.platform}:${profile.handle}`),
    ['instagram:creator.one', 'tiktok:creator.one'],
  );

  const second = await sendJson(`${baseUrl}/api/profile-groups`, 'POST', {
    profiles: [
      'https://x.com/CreatorOne',
      'https://www.tiktok.com/@creator_alt',
    ],
    name: 'Alternate group',
  });
  assert.equal(second.response.status, 200);

  const conflict = await sendJson(`${baseUrl}/api/profile-groups`, 'POST', {
    profiles: [first.payload.group.members[0].id, second.payload.group.members[0].id],
  });
  assert.equal(conflict.response.status, 409);
  assert.match(conflict.payload.error, /different creator groups/i);

  const merged = await sendJson(`${baseUrl}/api/profile-groups`, 'POST', {
    profiles: [first.payload.group.members[0].id, second.payload.group.members[0].id],
    mergeGroups: true,
    name: 'One creator everywhere',
  });
  assert.equal(merged.response.status, 200);
  assert.equal(merged.payload.group.name, 'One creator everywhere');
  assert.equal(merged.payload.group.memberCount, 4);

  const renamed = await sendJson(
    `${baseUrl}/api/profile-groups/${merged.payload.group.id}`,
    'PATCH',
    { name: 'Unified Creator' },
  );
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.payload.group.name, 'Unified Creator');

  const removedProfile = renamed.payload.group.members.find((profile) => profile.platform === 'x');
  const unlinked = await sendJson(
    `${baseUrl}/api/profile-groups/${renamed.payload.group.id}/profiles/${removedProfile.id}`,
    'DELETE',
  );
  assert.equal(unlinked.response.status, 200);
  assert.equal(unlinked.payload.unlinkedProfile.groupId, null);
  assert.equal(unlinked.payload.group.memberCount, 3);

  const listed = await getJson(`${baseUrl}/api/profile-groups`);
  assert.equal(listed.payload.groups.length, 1);
  assert.equal(listed.payload.groups[0].name, 'Unified Creator');
  assert.deepEqual(listed.payload.unlinkedProfiles.map((profile) => profile.id), [removedProfile.id]);

  const invalid = await sendJson(`${baseUrl}/api/profile-groups`, 'POST', {
    profiles: ['https://example.test/not-a-profile', 'https://www.tiktok.com/@valid'],
  });
  assert.equal(invalid.response.status, 400);
  assert.match(invalid.payload.error, /profile URL/i);

  const duplicate = await sendJson(`${baseUrl}/api/profile-groups`, 'POST', {
    profiles: [
      'https://www.instagram.com/same_profile/',
      'https://instagram.com/same_profile',
    ],
  });
  assert.equal(duplicate.response.status, 400);
  assert.match(duplicate.payload.error, /two different profiles/i);
});

async function getJson(url) {
  const response = await fetch(url);
  return { response, payload: await response.json() };
}

async function sendJson(url, method, body = undefined) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

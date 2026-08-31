import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handleInteraction, parseSupportedProfileUrl } from '../src/discord/client.js';
import { createStore } from '../src/state/store.js';

const OWNER_CONFIG = { discordOwnerId: 'owner-1' };

function makeProfilesInteraction(subcommand, values = {}, { canManage = true, userId = 'owner-1' } = {}) {
  const replies = [];
  return {
    interaction: {
      commandName: 'profiles',
      guildId: 'guild-1',
      channelId: 'channel-1',
      user: { id: userId },
      inGuild: () => true,
      memberPermissions: { has: () => canManage },
      options: {
        getSubcommand: () => subcommand,
        getString: (name) => values[name] ?? null,
        getBoolean: (name) => values[name] ?? null,
      },
      async reply(payload) {
        replies.push(payload);
      },
    },
    replies,
  };
}

function profileInput(url) {
  const reference = parseSupportedProfileUrl(url);
  return {
    platform: reference.platform,
    remoteId: reference.remoteId,
    handle: reference.handle,
    profileUrl: reference.canonicalUrl,
  };
}

test('profile URLs are strict, canonical, and limited to supported profile routes', () => {
  assert.deepEqual(parseSupportedProfileUrl('https://twitter.com/OpenAI/?utm_source=chat'), {
    kind: 'profile',
    platform: 'x',
    remoteId: null,
    handle: 'openai',
    canonicalUrl: 'https://x.com/openai',
  });
  assert.deepEqual(parseSupportedProfileUrl('https://m.instagram.com/Creator.Name/'), {
    kind: 'profile',
    platform: 'instagram',
    remoteId: null,
    handle: 'creator.name',
    canonicalUrl: 'https://www.instagram.com/creator.name/',
  });

  for (const value of [
    'http://www.instagram.com/creator/',
    'https://user:password@x.com/creator',
    'https://www.tiktok.com.evil.test/@creator',
    'https://www.instagram.com/p/PostId/',
    'https://x.com/creator/status/123456789',
    'https://www.tiktok.com/explore',
  ]) {
    assert.throws(() => parseSupportedProfileUrl(value), /credential-free HTTPS TikTok, Instagram, or X profile URL/);
  }
});

test('profiles link, show, and unlink only after an explicit command', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-archive-discord-profiles-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    store.upsertPlatformProfile(profileInput('https://www.tiktok.com/@same.handle'));
    store.upsertPlatformProfile(profileInput('https://www.instagram.com/same.handle/'));
    assert.equal(store.getCreatorGroupForProfile({ platform: 'tiktok', handle: 'same.handle' }), null);
    assert.equal(store.getCreatorGroupForProfile({ platform: 'instagram', handle: 'same.handle' }), null);

    const before = makeProfilesInteraction('show', {
      profile: 'https://www.instagram.com/same.handle/',
    }, { canManage: false });
    await handleInteraction({ interaction: before.interaction, config: OWNER_CONFIG, store });
    assert.equal(before.replies[0].embeds[0].data.title, 'Profile Not Linked');
    assert.match(before.replies[0].embeds[0].data.description, /never linked automatically/);

    const link = makeProfilesInteraction('link', {
      primary: 'https://www.tiktok.com/@same.handle',
      secondary: 'https://www.instagram.com/same.handle/',
      name: 'Same Creator',
    });
    await handleInteraction({ interaction: link.interaction, config: OWNER_CONFIG, store });
    assert.equal(link.replies[0].embeds[0].data.title, 'Profiles Linked');
    assert.match(link.replies[0].embeds[0].data.description, /Same Creator/);
    assert.match(link.replies[0].embeds[0].data.description, /TikTok/);
    assert.match(link.replies[0].embeds[0].data.description, /Instagram/);

    const group = store.getCreatorGroupForProfile({ platform: 'tiktok', handle: 'same.handle' });
    assert.equal(group.name, 'Same Creator');
    assert.equal(store.listCreatorGroupMembers(group.id).length, 2);

    const show = makeProfilesInteraction('show', {
      profile: 'https://www.tiktok.com/@same.handle',
    }, { canManage: false });
    await handleInteraction({ interaction: show.interaction, config: OWNER_CONFIG, store });
    assert.equal(show.replies[0].embeds[0].data.title, 'Linked Profiles');
    assert.match(show.replies[0].embeds[0].data.description, /@same\.handle/);

    const unlink = makeProfilesInteraction('unlink', {
      profile: 'https://www.instagram.com/same.handle/',
    });
    await handleInteraction({ interaction: unlink.interaction, config: OWNER_CONFIG, store });
    assert.equal(unlink.replies[0].embeds[0].data.title, 'Profile Unlinked');
    assert.equal(store.getCreatorGroupForProfile({ platform: 'instagram', handle: 'same.handle' }), null);
    assert.equal(store.listCreatorGroupMembers(group.id).length, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('profiles link explicitly merges existing creator groups and applies the supplied name', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'media-archive-discord-profile-merge-'));
  const store = createStore(path.join(dir, 'state.db'));
  try {
    const tiktok = store.upsertPlatformProfile(profileInput('https://www.tiktok.com/@alpha'));
    const instagram = store.upsertPlatformProfile(profileInput('https://www.instagram.com/alpha/'));
    const x = store.upsertPlatformProfile(profileInput('https://x.com/beta'));
    const otherInstagram = store.upsertPlatformProfile(profileInput('https://www.instagram.com/beta/'));
    store.linkCreatorProfiles([tiktok.id, instagram.id], { groupName: 'Alpha' });
    store.linkCreatorProfiles([x.id, otherInstagram.id], { groupName: 'Beta' });

    const refused = makeProfilesInteraction('link', {
      primary: 'https://www.tiktok.com/@alpha',
      secondary: 'https://x.com/beta',
    });
    await assert.rejects(
      handleInteraction({ interaction: refused.interaction, config: OWNER_CONFIG, store }),
      /mergeGroups/i,
    );
    assert.equal(store.listCreatorGroups({ includeEmpty: false }).length, 2);

    const link = makeProfilesInteraction('link', {
      primary: 'https://www.tiktok.com/@alpha',
      secondary: 'https://x.com/beta',
      name: 'Unified Creator',
      merge: true,
    });
    await handleInteraction({ interaction: link.interaction, config: OWNER_CONFIG, store });

    const groups = store.listCreatorGroups({ includeEmpty: false });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].name, 'Unified Creator');
    assert.equal(store.listCreatorGroupMembers(groups[0].id).length, 4);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('profile link and unlink mutations require the global bot owner', async () => {
  const calls = [];
  const store = {
    upsertPlatformProfile() {
      calls.push('upsert');
    },
    unlinkProfile() {
      calls.push('unlink');
      return true;
    },
    getCreatorGroupForProfile() {
      calls.push('show');
      return null;
    },
  };

  for (const [subcommand, values] of [
    ['link', {
      primary: 'https://www.tiktok.com/@creator',
      secondary: 'https://www.instagram.com/creator/',
    }],
    ['unlink', { profile: 'https://www.instagram.com/creator/' }],
  ]) {
    const denied = makeProfilesInteraction(subcommand, values, {
      canManage: true,
      userId: 'guild-manager',
    });
    await handleInteraction({ interaction: denied.interaction, config: OWNER_CONFIG, store });
    assert.equal(denied.replies[0].embeds[0].data.title, 'Permission Required');
  }
  assert.deepEqual(calls, []);

  const show = makeProfilesInteraction('show', {
    profile: 'https://www.instagram.com/creator/',
  }, { canManage: false });
  await handleInteraction({ interaction: show.interaction, config: OWNER_CONFIG, store });
  assert.deepEqual(calls, ['show']);
  assert.equal(show.replies[0].embeds[0].data.title, 'Profile Not Linked');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyCreatorId, resolveCreatorId } from '../web/lib/creator-id.ts';

const creators = [
  { id: 'ellie_kim_', username: 'ellie_kim_' },
  { id: 'plainname', username: 'plainname' },
  { id: 'a-b', username: 'a-b' },
  { id: 'a.b', username: 'a.b' },
];

test('creator ids preserve exact usernames and resolve only unambiguous legacy slugs', () => {
  assert.equal(legacyCreatorId('ellie_kim_'), 'ellie-kim');
  assert.equal(resolveCreatorId('ellie_kim_', creators), 'ellie_kim_');
  assert.equal(resolveCreatorId('ellie-kim', creators), 'ellie_kim_');
  assert.equal(resolveCreatorId('plainname', creators), 'plainname');
  assert.equal(resolveCreatorId('a-b', creators), 'a-b');
  assert.equal(resolveCreatorId('all', creators), 'all');
});
